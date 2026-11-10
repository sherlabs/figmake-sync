import path from "node:path";

import fs from "fs-extra";

import type { FigmakeSyncService } from "../core/service.js";
import { ProjectStateStore, STATE_DIRECTORY_NAME } from "../core/state.js";
import { REMOTE_DIVERGED_PROMPT, isAllowedLoginUrl } from "../harness/index.js";
import type { HarnessEvent, HarnessService } from "../harness/index.js";
import type { DevStatus } from "../harness/types.js";
import type { AgentChoice, ChangedFile, ChatFile, ChatMessage, ChatState, DesktopAppState, ErrorCode, FileView, FolderListing, Phase, ProcessId, ProjectSummary, SessionState } from "../electron/contracts.js";
import { isAuthRequiredError } from "../electron/authState.js";
import { applyAgentEvent, baseName, capMessages, dropSummaryRepeat, emptyAssistant, newId, userMessage } from "./chat.js";
import type { ChatStore } from "./chatStore.js";
import { describeFolders, listChangedFiles } from "./changes.js";
import { listFolder, readFileView } from "./fileTree.js";
import { MAX_ACTIVITY_LINES, MAX_PROCESS_LINES, pushLines } from "./activity.js";
import { buildProcesses } from "./processes.js";
import { FIGMA_MAKE_GUIDE } from "./figmaMakeGuide.js";
import { defaultWorkspaceDir, parseFigmaLink, resolveProjectFolder, validateWorkspace, type FigmaLink, type WorkspaceGuard } from "./workspace.js";

/** Short fixed context for every prompt: nothing is ever written into the project to carry it. */
export const PROMPT_PREFACE =
  `This is a Figma Make project: a React app. Follow the project rules below. You are talking with a designer, not a developer: write in plain, friendly language and avoid commands, file paths and technical terms unless they ask. If they ask a question instead of for a change, just answer it briefly. After making a change, reply with one plain sentence describing what changed.\n\n${FIGMA_MAKE_GUIDE}`;

export const AGENT_NAMES: Record<AgentChoice, string> = { claude: "Claude", codex: "ChatGPT" };

export interface SessionDeps {
  sync: Pick<FigmakeSyncService, "init" | "pull" | "push" | "status" | "auth">;
  harness: Pick<HarnessService, "ensureProjectRunning" | "ensureAgentReady" | "startRun" | "pendingLoginUrl" | "stopDevExcept" | "stopDev" | "updateSettings">;
  appState: { load(): Promise<DesktopAppState>; update(patch: Partial<DesktopAppState>): Promise<DesktopAppState> };
  /** Per-project transcripts (userData/chats). */
  chatStore: Pick<ChatStore, "load" | "save" | "archive" | "remove">;
  documentsDir: string;
  guard: WorkspaceGuard;
  chooseFolder(): Promise<string | null>;
  openExternal(url: string): void;
  reloadPreview(): void;
  signOutFigma(): Promise<void>;
  /** Moves a folder to the system Trash (recoverable). */
  trashFolder(dir: string): Promise<void>;
  /** Runs a Figma browser action, installing the browser first when needed. */
  withBrowser<T>(run: () => Promise<T>): Promise<T>;
  /** Resolves once the person says they are done signing in to Figma. */
  waitForFigmaSignin(signal: AbortSignal): Promise<void>;
  log(message: string, error?: unknown): void;
}

type Patch = { [K in keyof SessionState]?: SessionState[K] | undefined };
type Resolution = "mine" | "figma";
interface Entry {
  /** Stable id of this change; the chat card for it carries the same id. */
  id: string;
  sentence: string;
  backupDir: string | null;
  /** How many files this change touched, counted once when it finished. */
  files?: number;
}

/** Thrown from the push confirm hook: nothing has been written yet, the person decides. */
class Diverged extends Error {}

/** The file paths inside the parentheses of the diverged prompt, without the trailing "...". */
export function conflictFiles(message: string): string[] {
  const inner = /last pull \((.*)\)\. Overwrite/su.exec(message)?.[1];
  if (!inner) return [];
  return inner.split(", ").map((f) => f.trim()).filter((f) => f && f !== "...");
}

/** The first plain sentence of the agent's final reply, without markdown. */
export function parseChange(text: string): string | null {
  const lines = text
    .split(/\n+/u)
    .map((l) => l.replace(/[`*_#>]/gu, "").replace(/^[\s\-•\d.)]+/u, "").trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  const sentence = (/^(.+?[.!?])(\s|$)/u.exec(last)?.[1] ?? last).replace(/[.!?]+$/u, "").trim();
  if (!sentence) return null;
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
}

type Failing = "figma" | "project" | "agent";

/** Raw errors never reach the UI: one plain sentence per situation. */
export function plainError(error: unknown, kind: Failing, agent?: AgentChoice | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/newer changes/iu.test(raw)) return "Couldn't check Figma for newer changes. Try again.";
  if (/backup failed/iu.test(raw)) return "Couldn't make a backup, so nothing was changed.";
  if (kind === "figma") return "Couldn't reach Figma. Try again.";
  if (kind === "project") return "Couldn't start the project. Try again.";
  return `Couldn't reach ${AGENT_NAMES[agent ?? "claude"]}. Try again.`;
}

/** The stable code for a failure, next to the plain sentence the person sees. */
export function errorCode(error: unknown, kind: Failing): ErrorCode {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (/backup failed/iu.test(raw)) return "backup_failed";
  if (code === "UI_CHANGED" || code === "SELECTOR_NOT_FOUND") return "figma_ui_changed";
  if (code === "AUTH_REQUIRED") return "figma_signin_required";
  if (kind === "project") return "preview_failed";
  if (kind === "agent") return "agent_failed";
  const known = typeof code === "string" || /newer changes|timeout|timed out|net::|ECONN|ENOTFOUND|EAI_AGAIN|reach/iu.test(raw);
  return known ? "figma_unreachable" : "unknown";
}

const BUSY_PHASES: readonly Phase[] = ["connecting", "preparing", "working", "sending", "conflict"];

const START: SessionState = {
  phase: "start",
  projectName: null,
  previewUrl: null,
  changes: [],
  changeFiles: [],
  changeIds: [],
  projects: [],
  activeKey: null,
  syncedAt: null,
  updatesEnabled: true,
  canSend: false,
  canUndo: false,
  agent: null,
  agentConnected: false,
  workspace: "",
  processes: [],
  activity: { lines: [], stepStartedAt: null, startedAt: null },
};

export class Session {
  private s: SessionState = { ...START };
  private readonly listeners = new Set<(state: SessionState) => void>();
  private ctl: AbortController | null = null;
  private busy = false;
  private root: string | null = null;
  private workspaceDir: string;
  private stack: Entry[] = [];
  private agentReady: AgentChoice | null = null;
  /** The project to reopen once the AI helper is connected (first run, or an AI that was never confirmed). */
  private pendingReopen: { link: string; info: NonNullable<ReturnType<typeof parseFigmaLink>> } | null = null;
  private resume: (() => Promise<void>) | null = null;
  private known: Record<string, string> = {};
  private links: Record<string, string> = {};
  private stacks = new Map<string, Entry[]>();
  private activeKey: string | null = null;
  private syncedAtByKey: Record<string, string | null> = {};
  private messages: ChatMessage[] = [];
  /** The next turn starts a new AI conversation instead of resuming the last one. */
  private fresh = false;
  private turnId: string | null = null;
  private readonly chatListeners = new Set<(chat: ChatState) => void>();
  private chatTimer: NodeJS.Timeout | null = null;
  /** Latest report of the open project's preview server, and whether its files are being installed. */
  private dev: Pick<DevStatus, "state"> | null = null;
  private installing = false;
  /** Cleaned output for the progress card (all sources), and per source for the Files tab. */
  private activity: readonly string[] = [];
  private devLines: readonly string[] = [];
  private setupLines: readonly string[] = [];
  private startedAt: number | null = null;
  private stepStartedAt: number | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private activityDirty = false;
  /** The person stopped the preview on purpose: the project stays open, just without a picture. */
  private previewStopped = false;

  constructor(private readonly deps: SessionDeps) {
    this.workspaceDir = defaultWorkspaceDir(deps.documentsDir);
  }

  private startState(): SessionState {
    return { ...START, phase: this.s.agentConnected ? "start" : "needs-ai-choice", agent: this.s.agent, agentConnected: this.s.agentConnected, workspace: this.s.workspace, projects: this.s.projects, ...(this.s.workspaceError ? { workspaceError: this.s.workspaceError } : {}) };
  }

  get state(): SessionState {
    return this.s;
  }

  /** True while anything is connecting, preparing, working, sending, or waiting on a conflict answer. */
  isBusy(): boolean {
    return this.busy || BUSY_PHASES.includes(this.s.phase);
  }

  onState(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- chat ----

  get chat(): ChatState {
    return { projectKey: this.activeKey, messages: this.messages, active: this.turnId !== null, fresh: this.fresh };
  }

  onChat(listener: (chat: ChatState) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  private emitChat(): void {
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.chatTimer = null;
    const chat = this.chat;
    for (const listener of this.chatListeners) listener(chat);
  }

  /** Streaming text arrives in bursts: tell the window at most every 50 ms. */
  private scheduleChat(): void {
    if (this.chatTimer) return;
    this.chatTimer = setTimeout(() => this.emitChat(), 50);
    this.chatTimer.unref();
  }

  private patchMessage(id: string, change: (m: ChatMessage) => ChatMessage): void {
    this.messages = this.messages.map((m) => (m.id === id ? change(m) : m));
  }

  private saving: Promise<void> = Promise.resolve();

  private saveChat(): Promise<void> {
    const key = this.activeKey;
    if (!key) return Promise.resolve();
    this.saving = this.deps.chatStore.save(key, { messages: this.messages, fresh: this.fresh }).catch((e: unknown) => this.deps.log("chat save failed", e));
    return this.saving;
  }

  /** Resolves once the latest transcript write has finished (used when quitting). */
  flush(): Promise<void> {
    return this.saving;
  }

  /** Marks the cards of these changes (or every live card) as undone or sent. */
  private settle(fate: "undone" | "sent", ids?: readonly string[]): void {
    let touched = false;
    this.messages = this.messages.map((m) => {
      if (!m.change || m.change.fate !== "active" || (ids && !ids.includes(m.change.turnId))) return m;
      touched = true;
      return { ...m, change: { ...m.change, fate } };
    });
    if (touched) {
      this.emitChat();
      void this.saveChat();
    }
  }

  /** Starts a fresh AI conversation. The old one is archived (only the newest archive is kept). */
  async newChat(): Promise<void> {
    const key = this.activeKey;
    if (!key || this.busy || this.turnId) return;
    if (this.messages.length > 0) await this.deps.chatStore.archive(key).catch((e: unknown) => this.deps.log("chat archive failed", e));
    this.messages = [];
    this.fresh = true;
    this.emitChat();
    await this.saveChat();
  }

  /** Loads preferences, prepares the workspace, and reopens the last project straight into "preparing". */
  async start(): Promise<void> {
    const saved = await this.deps.appState.load();
    this.known = saved.projects;
    this.links = { ...saved.links };
    const seed = saved.lastLink ? parseFigmaLink(saved.lastLink) : null;
    if (saved.lastLink && seed && Object.keys(this.links).length === 0) this.links[seed.key] = saved.lastLink;
    const connected = saved.agent !== null && saved.agentConnected;
    this.set({ agent: saved.agent, agentConnected: connected, updatesEnabled: saved.updates.enabled });
    await this.useWorkspace(saved.workspace);
    await this.refreshProjects();
    const info = seed;
    const root = info ? this.known[info.key] : undefined;
    const reopen = saved.lastLink && info && root && (await fs.pathExists(root)) ? { link: saved.lastLink, info } : null;
    if (!connected) {
      // The AI helper comes first: pick one and sign in, then the last project reopens.
      this.pendingReopen = reopen;
      this.set({ phase: "needs-ai-choice", message: undefined });
      return;
    }
    if (reopen) await this.open(reopen.link, reopen.info, true);
  }

  private async useWorkspace(candidate: string | null): Promise<void> {
    const fallback = defaultWorkspaceDir(this.deps.documentsDir);
    let dir = candidate ?? fallback;
    let error: string | undefined;
    if (!(await validateWorkspace(dir, this.deps.guard))) {
      dir = fallback;
      if (candidate) error = "That folder can't be used, so the default one is in use.";
      if (!(await validateWorkspace(dir, this.deps.guard))) error = "Couldn't create the figmake-sync folder.";
    }
    this.workspaceDir = dir;
    this.set({ workspace: path.basename(dir), ...(error ? { workspaceError: error } : {}) });
    if (!error) this.set({ workspaceError: undefined });
  }

  // ---- calls ----

  async openProject(link: string): Promise<void> {
    if (this.busy) return;
    const info = parseFigmaLink(link);
    if (!info) {
      this.set({ phase: "error", message: "That doesn't look like a Figma Make link. Try again.", code: "invalid_link", failedIn: this.s.phase });
      this.resume = () => {
        this.set(this.startState());
        return Promise.resolve();
      };
      return;
    }
    this.pendingReopen = null;
    await this.open(link.trim(), info, false);
  }

  async ask(prompt: string, retryOf?: string): Promise<void> {
    const text = prompt.trim();
    const agent = this.s.agent;
    // A failed turn leaves a calm error in the chat; typing again simply carries on.
    const turnError = this.s.phase === "error" && this.messages.at(-1)?.status === "error";
    if (!text || this.busy || !this.root || !this.s.previewUrl || !agent || (this.s.phase !== "ready" && !turnError)) return;
    if (turnError) {
      this.resume = null;
      this.set({ phase: "ready", message: undefined });
    }
    const root = this.root;
    await this.exclusive(async (signal) => {
      const mine = this.beginTurn(text, retryOf);
      const end = (status: "done" | "stopped" | "error", extra: Partial<ChatMessage> & { resultText?: string } = {}): void => this.endTurn(mine.assistant, status, extra);
      try {
        this.set({ phase: "preparing", message: undefined });
        if (this.agentReady !== agent && !(await this.ensureAgent(agent, signal))) {
          if (this.s.phase === "error") this.resume = () => this.ask(text, mine.user);
          if (this.s.phase === "error") return end("error", { error: { message: this.s.message ?? "Something went wrong.", code: this.s.code ?? "unknown" } });
          return end("stopped");
        }
        this.set({ phase: "working", message: undefined });
        const { done } = await this.deps.harness.startRun({ rootDir: root, prompt: `${PROMPT_PREFACE}\n\n${text}`, agent, ...(this.fresh ? { newSession: true } : {}) }, signal);
        const outcome = await done;
        if (outcome.sessionId) this.fresh = false;
        if (outcome.cancelled || !outcome.success) {
          // The app made the backup itself; put the files back so a stopped or failed run leaves nothing half-done.
          if (outcome.backupDir) await this.restore(outcome.backupDir).catch((e: unknown) => this.deps.log("restore failed", e));
          this.deps.reloadPreview();
          if (outcome.cancelled) {
            end("stopped");
            return this.ready();
          }
          const sentence = plainError(new Error(outcome.error ?? ""), "agent", agent);
          const code = errorCode(new Error(outcome.error ?? ""), "agent");
          end("error", { error: { message: sentence, code } });
          return this.fail(sentence, () => this.ask(text, mine.user), code);
        }
        const sentence = parseChange(outcome.resultText) ?? "Made a change";
        const files = await this.changedFiles(root, outcome.backupDir);
        let change: ChatMessage["change"];
        if (files === null || files.length > 0) {
          const entry: Entry = { id: newId(), sentence, backupDir: outcome.backupDir, files: files?.length ?? 0 };
          this.stack.push(entry);
          this.deps.reloadPreview();
          change = { turnId: entry.id, summary: sentence, files: files ?? [], previewUpdated: true, fate: "active" };
        }
        end("done", { resultText: outcome.resultText, ...(change ? { change } : {}) });
        await this.ready();
      } catch (error) {
        if (signal.aborted) {
          end("stopped");
          return this.ready();
        }
        this.deps.log("ask failed", error);
        const sentence = plainError(error, "agent", agent);
        const code = errorCode(error, "agent");
        end("error", { error: { message: sentence, code } });
        this.fail(sentence, () => this.ask(text, mine.user), code);
      }
    });
  }

  /** Adds the person's message and an empty assistant message that the agent's events fill in. */
  private beginTurn(text: string, retryOf?: string): { user: string; assistant: string } {
    let user = retryOf ? this.messages.find((m) => m.id === retryOf && m.role === "user") : undefined;
    if (user) {
      const at = this.messages.indexOf(user);
      this.messages = this.messages.slice(0, at + 1);
    } else {
      user = userMessage(text);
      this.messages = capMessages([...this.messages, user]);
    }
    const assistant = emptyAssistant();
    this.messages = capMessages([...this.messages, assistant]);
    this.turnId = assistant.id;
    this.emitChat();
    void this.saveChat();
    return { user: user.id, assistant: assistant.id };
  }

  private endTurn(id: string, status: "done" | "stopped" | "error", extra: Partial<ChatMessage> & { resultText?: string } = {}): void {
    const { resultText, ...rest } = extra;
    this.patchMessage(id, (m) => {
      let parts = m.parts;
      // Nothing streamed (a quiet CLI): show the closing reply once.
      if (status === "done" && !parts.some((p) => p.type === "text") && resultText?.trim()) parts = [...parts, { type: "text" as const, text: resultText.trim() }];
      if (rest.change) parts = dropSummaryRepeat(parts, rest.change.summary);
      return { ...m, ...rest, parts, status };
    });
    this.turnId = null;
    this.emitChat();
    void this.saveChat();
  }

  async undo(index?: number): Promise<void> {
    const at = index ?? this.stack.length - 1;
    const target = Number.isInteger(at) ? this.stack[at] : undefined;
    if (this.busy || this.s.phase !== "ready" || !target?.backupDir) return;
    await this.exclusive(async () => {
      try {
        await this.restore(target.backupDir as string);
        const removed = this.stack.slice(at).map((e) => e.id);
        this.stack.splice(at);
        this.settle("undone", removed);
        this.deps.reloadPreview();
        await this.ready();
      } catch (error) {
        this.deps.log("undo failed", error);
        this.fail("Couldn't undo that. Try again.", () => this.undo(index), "undo_failed");
      }
    });
  }

  async send(resolution?: Resolution): Promise<void> {
    const root = this.root;
    const phase = this.s.phase;
    if (this.busy || !root) return;
    if (resolution ? phase !== "conflict" : phase !== "ready" || !this.s.canSend) return;
    await this.exclusive(async (signal) => {
      this.set({ phase: "sending", message: undefined });
      try {
        if (resolution) {
          const store = new ProjectStateStore(root);
          const config = await store.loadProjectConfig();
          await store.createBackup("pre-resolve", config.sync.ignore);
        }
        if (resolution === "figma") {
          await this.deps.withBrowser(() => this.deps.sync.pull({ projectRoot: root, strategy: "backup", confirm: () => Promise.resolve(true), signal }));
          this.deps.reloadPreview();
        } else {
          const result = await this.deps.withBrowser(() =>
            this.deps.sync.push({
              projectRoot: root,
              signal,
              requireRemoteCheck: true,
              confirm: (message) =>
                REMOTE_DIVERGED_PROMPT.test(message) && !resolution ? Promise.reject(new Diverged(message)) : Promise.resolve(true),
            }),
          );
          if (result.unresolved.length > 0) {
            return this.fail("Some changes couldn't be sent. Try again.", () => this.send(), "push_failed");
          }
        }
        this.settle(resolution === "figma" ? "undone" : "sent");
        this.stack = [];
        await this.ready(resolution === "figma" ? undefined : "Sent to Figma");
      } catch (error) {
        if (signal.aborted) return this.ready();
        if (error instanceof Diverged) return this.set({ phase: "conflict", message: "Figma has newer changes.", conflictFiles: conflictFiles(error.message) });
        if (isAuthRequiredError(error)) return this.needSignin(() => this.send(resolution));
        this.deps.log("send failed", error);
        this.fail(plainError(error, "figma"), () => this.send(resolution), errorCode(error, "figma"));
      }
    });
  }

  cancel(): Promise<void> {
    if (this.s.phase === "conflict") return this.ready();
    if (this.busy) this.ctl?.abort();
    else if (!this.s.previewUrl && this.s.phase !== "start") this.set(this.startState());
    return Promise.resolve();
  }

  /** The one action on a sign-in or error screen. */
  async retry(): Promise<void> {
    const resume = this.resume;
    if (this.busy || !resume) return;
    this.resume = null;
    if (this.s.phase === "error" && this.s.previewUrl) this.set({ phase: "ready", message: undefined });
    if (this.s.phase === "needs-figma-signin" && this.root) {
      const root = this.root;
      const ok = await this.exclusive(async (signal) => {
        this.set({ phase: "needs-figma-signin", message: "Waiting for sign-in in your browser" });
        try {
          await this.deps.withBrowser(() =>
            this.deps.sync.auth({ projectRoot: root, autoDetectLogin: true, waitForManualAction: () => this.deps.waitForFigmaSignin(signal) }),
          );
          if (this.s.previewUrl) this.set({ phase: "ready", message: undefined });
          return true;
        } catch (error) {
          if (signal.aborted) {
            this.resume = resume;
            this.set({ phase: "needs-figma-signin", message: undefined });
            return false;
          }
          this.deps.log("sign-in failed", error);
          this.fail("Couldn't sign in to Figma. Try again.", resume, "figma_signin_required");
          return false;
        }
      });
      if (!ok) return;
    }
    await resume();
  }

  async setAgent(agent: AgentChoice): Promise<void> {
    if (agent !== "claude" && agent !== "codex") return;
    const connected = agent === this.s.agent && this.s.agentConnected;
    await this.deps.appState.update({ agent, agentConnected: connected });
    if (this.agentReady !== agent) this.agentReady = null;
    this.set({ agent, agentConnected: connected });
    if (this.busy) return;
    // Choosing (or switching to) an AI connects it right away: install, then sign in.
    if (this.s.phase === "needs-ai-choice" || (!connected && (this.s.phase === "ready" || this.s.phase === "start"))) await this.prepareAgent();
  }

  async setUpdates(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") return;
    await this.deps.appState.update({ updates: { enabled } });
    this.set({ updatesEnabled: enabled });
  }

  async chooseWorkspace(): Promise<void> {
    const dir = await this.deps.chooseFolder();
    if (!dir) return;
    if (!(await validateWorkspace(dir, this.deps.guard))) {
      this.set({ workspaceError: "That folder can't be used." });
      return;
    }
    await this.deps.appState.update({ workspace: dir });
    this.workspaceDir = dir;
    this.set({ workspace: path.basename(dir), workspaceError: undefined });
  }

  async signOutFigma(): Promise<void> {
    if (this.busy) return;
    await this.deps.signOutFigma();
  }

  /** Forwarded from the harness: opens the sign-in page the AI tool printed (host allowlisted). */
  handleHarnessEvent(event: HarnessEvent): void {
    if (event.kind === "agent-ensure" && event.stage === "needs-browser-signin") {
      this.set({ phase: "needs-ai-signin", message: `Sign in to ${AGENT_NAMES[event.agent]} in your browser` });
    } else if (event.kind === "run-agent") {
      const id = this.turnId;
      if (!id || !this.root || path.resolve(event.rootDir) !== path.resolve(this.root)) return;
      const edit = event.event.type === "file_edit" ? event.event : null;
      const existed = edit ? fs.existsSync(path.resolve(this.root, edit.path)) : true;
      this.patchMessage(id, (m) => applyAgentEvent(m, event.event, { existed }));
      this.scheduleChat();
    } else if (event.kind === "run-phase" || event.kind === "run-done") {
      if (!this.root || path.resolve(event.rootDir) !== path.resolve(this.root)) return;
      if (event.kind === "run-phase") this.feed(`AI helper: ${event.message}`);
      else this.feed(`AI helper: ${event.outcome.cancelled ? "stopped" : event.outcome.success ? "finished" : "couldn't finish"}`);
    } else if (event.kind === "setup-log" || event.kind === "dev-log") {
      if (!this.root || path.resolve(event.rootDir) !== path.resolve(this.root)) return;
      if (event.kind === "setup-log") this.setupLines = pushLines(this.setupLines, event.line, MAX_PROCESS_LINES, this.home());
      else this.devLines = pushLines(this.devLines, event.line, MAX_PROCESS_LINES, this.home());
      this.feed(event.line);
    } else if (event.kind === "dev-status" || event.kind === "project-ensure") {
      if (!this.root || path.resolve(event.rootDir) !== path.resolve(this.root)) return;
      if (event.kind === "dev-status") this.dev = { state: event.status.state };
      else {
        this.installing = event.stage === "installing-node" || event.stage === "installing-deps";
        if (event.stage !== "running") this.stepStartedAt = Date.now();
        if (event.stage === "installing-deps") this.feed("Installing project files (npm install)");
        else if (event.stage === "starting") this.feed("Starting the preview (npm run dev)");
        else this.feed(event.message);
      }
      this.set({});
    } else if (event.kind === "agent-login-url") {
      const url = this.deps.harness.pendingLoginUrl(event.agent);
      if (url && isAllowedLoginUrl(url)) this.deps.openExternal(url);
    }
  }

  // ---- activity feed ----

  private home(): string | undefined {
    return this.deps.guard.home;
  }

  /** Adds cleaned lines to the progress feed. Bursts are coalesced: the window hears at most every 100 ms. */
  private feed(raw: string): void {
    const next = pushLines(this.activity, raw, MAX_ACTIVITY_LINES, this.home());
    if (next === this.activity) return;
    this.activity = next;
    if (this.activityTimer) {
      this.activityDirty = true;
      return;
    }
    this.set({});
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (this.activityDirty) {
        this.activityDirty = false;
        this.set({});
      }
    }, 100);
    this.activityTimer.unref();
  }

  /** A new open (or restart): forget the last feed and begin timing. */
  private beginActivity(lead?: string): void {
    this.activity = [];
    this.devLines = [];
    this.setupLines = [];
    this.startedAt = Date.now();
    this.stepStartedAt = this.startedAt;
    if (lead) this.activity = [lead];
  }

  // ---- files + running things ----

  async listFolder(rel: string): Promise<FolderListing> {
    return this.root ? listFolder(this.root, rel) : { path: "", entries: [], truncated: false };
  }

  async readFile(rel: string): Promise<FileView> {
    return this.root ? readFileView(this.root, rel) : { kind: "missing", path: "" };
  }

  /** Files added or edited since the last pull (the same comparison that decides "Send to Figma"). Never throws. */
  async changedPaths(): Promise<string[]> {
    if (!this.root) return [];
    try {
      const { diff } = await this.deps.sync.status({ projectRoot: this.root });
      if (!diff) return [];
      return [...diff.modified.map((m) => m.current.path), ...diff.added.map((e) => e.path), ...diff.renamed.map((r) => r.to)].sort();
    } catch {
      return [];
    }
  }

  /** Stops one running thing. The AI helper and project setup stop like the Stop button; the preview just shuts down. */
  async stopProcess(id: ProcessId): Promise<void> {
    const root = this.root;
    if (id === "agent" || id === "install") {
      const running = id === "agent" ? this.turnId !== null : this.installing;
      if (running && this.busy) this.ctl?.abort();
      return;
    }
    if (!root || this.busy || this.s.phase !== "ready") return;
    await this.exclusive(async () => {
      try {
        await this.deps.harness.stopDev(root);
      } catch (error) {
        this.deps.log("stop preview failed", error);
      }
      this.dev = { state: "stopped" };
      this.previewStopped = true;
      this.set({ previewUrl: null });
    });
  }

  /** Restarts the preview (the only restartable thing). Never overlaps another action. */
  async restartProcess(id: ProcessId): Promise<void> {
    if (id !== "preview") return;
    await this.relaunchPreview(false);
  }

  /** "Fix the preview": the project's installed files are thrown away and set up again. Nothing else is touched. */
  async fixPreview(): Promise<void> {
    await this.relaunchPreview(true);
  }

  private async relaunchPreview(clean: boolean): Promise<void> {
    const root = this.root;
    if (!root || this.isBusy() || (this.s.phase !== "ready" && this.s.phase !== "error")) return;
    const again = (): Promise<void> => (clean ? this.fixPreview() : this.restartProcess("preview"));
    await this.exclusive(async (signal) => {
      this.resume = null;
      this.previewStopped = false;
      this.dev = null;
      this.beginActivity();
      this.set({ phase: "preparing", previewUrl: null, message: undefined });
      try {
        await this.deps.harness.stopDev(root).catch(() => undefined);
        if (clean) await this.removeInstalledFiles(root);
        const project = await this.deps.harness.ensureProjectRunning(root, signal);
        if (project.ok) {
          this.set({ previewUrl: project.url });
          this.deps.reloadPreview();
          return await this.ready();
        }
        if (signal.aborted) return this.stoppedPreview();
        this.fail("Couldn't start the preview. Try again.", again, "preview_failed");
      } catch (error) {
        this.deps.log(clean ? "fix preview failed" : "restart preview failed", error);
        if (signal.aborted) return this.stoppedPreview();
        this.fail("Couldn't start the preview. Try again.", again, "preview_failed");
      }
    });
  }

  /** Deletes the open project's own node_modules folder (and the setup stamp inside it). Refuses anything outside the project. */
  private async removeInstalledFiles(root: string): Promise<void> {
    const dir = path.resolve(root);
    if (!(await fs.pathExists(path.join(dir, STATE_DIRECTORY_NAME)))) throw new Error("not a project folder");
    const modules = path.join(dir, "node_modules");
    const stat = await fs.lstat(modules).catch(() => null);
    if (!stat) return;
    // A link is removed as a link; its target is never followed.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return void (await fs.unlink(modules));
    if (path.dirname(await fs.realpath(modules)) !== (await fs.realpath(dir))) throw new Error("unsafe path");
    await fs.remove(modules);
  }

  /** "Start this project over": back up, bring the latest from Figma, set everything up again. */
  async startOver(): Promise<void> {
    const root = this.root;
    if (!root || this.isBusy() || (this.s.phase !== "ready" && this.s.phase !== "error")) return;
    await this.exclusive(async (signal) => {
      this.resume = null;
      this.previewStopped = false;
      this.dev = null;
      this.beginActivity("Getting your project from Figma");
      this.set({ phase: "connecting", previewUrl: null, message: undefined });
      try {
        await this.deps.harness.stopDev(root).catch(() => undefined);
        const store = new ProjectStateStore(root);
        const config = await store.loadProjectConfig();
        await store.createBackup("pre-start-over", config.sync.ignore);
        await this.deps.withBrowser(() => this.deps.sync.pull({ projectRoot: root, strategy: "backup", confirm: () => Promise.resolve(true), signal, progress: (m) => this.feed(m) }));
        if (signal.aborted) return this.cancelled();
        this.stack = [];
        this.settle("undone");
        this.set({ phase: "preparing" });
        const project = await this.deps.harness.ensureProjectRunning(root, signal);
        if (signal.aborted) return this.cancelled();
        if (!project.ok) return this.fail("Couldn't start the project. Try again.", () => this.startOver(), "preview_failed");
        this.set({ previewUrl: project.url });
        this.deps.reloadPreview();
        await this.ready();
      } catch (error) {
        if (signal.aborted) return this.cancelled();
        if (isAuthRequiredError(error)) return this.needSignin(() => this.startOver());
        this.deps.log("start over failed", error);
        this.fail(plainError(error, "figma"), () => this.startOver(), errorCode(error, "figma"));
      }
    });
  }

  /** "Reset the app": a clean slate. Signs out, forgets projects, removes saved chats and moves the project folders to the Trash. */
  async resetApp(): Promise<void> {
    if (this.isBusy()) return;
    await this.exclusive(async () => {
      try {
        await this.deps.harness.stopDevExcept(null, true).catch(() => undefined);
        await this.deps.signOutFigma();
        for (const key of Object.keys(this.links)) await this.deps.chatStore.remove(key).catch(() => undefined);
        for (const root of Object.values(this.known)) {
          if (await this.safeToDelete(root)) await this.deps.trashFolder(root);
        }
        await this.deps.appState.update({ agent: null, agentConnected: false, projects: {}, links: {}, lastLink: null });
      } catch (error) {
        this.deps.log("reset failed", error);
        return this.fail("Couldn't reset the app. Try again.", () => this.resetApp(), "unknown");
      }
      this.known = {};
      this.links = {};
      this.stacks.clear();
      this.stack = [];
      this.messages = [];
      this.fresh = false;
      this.turnId = null;
      this.emitChat();
      this.root = null;
      this.activeKey = null;
      this.agentReady = null;
      this.pendingReopen = null;
      this.resume = null;
      this.dev = null;
      this.installing = false;
      this.previewStopped = false;
      this.syncedAtByKey = {};
      this.set({ agent: null, agentConnected: false, projects: [], activeKey: null, syncedAt: null });
      this.set(this.startState());
    });
  }

  private stoppedPreview(): void {
    this.previewStopped = true;
    this.set({ phase: "ready" });
  }

  // ---- flow ----

  /** The app never sends on its own: auto-push set earlier (CLI or old app) is switched off. */
  private async open(url: string, info: FigmaLink, restore: boolean): Promise<void> {
    await this.openLocked(url, info, restore);
    await this.refreshProjects();
  }

  private async openLocked(url: string, info: FigmaLink, restore: boolean): Promise<void> {
    await this.exclusive(async (signal) => {
      if (this.activeKey) {
        this.stacks.set(this.activeKey, this.stack);
        if (this.activeKey !== info.key) await this.saveChat();
      }
      const switching = this.activeKey !== info.key;
      this.activeKey = info.key;
      this.stack = this.stacks.get(info.key) ?? [];
      if (switching || this.messages.length === 0) {
        const stored = await this.deps.chatStore.load(info.key).catch(() => ({ messages: [] as ChatMessage[], fresh: false }));
        this.messages = stored.messages;
        this.fresh = stored.fresh;
        this.turnId = null;
        this.emitChat();
      }
      this.agentReady = null;
      this.dev = null;
      this.installing = false;
      this.previewStopped = false;
      this.beginActivity(restore ? undefined : "Getting your project from Figma");
      this.set({ phase: restore ? "preparing" : "connecting", projectName: info.name, activeKey: info.key, previewUrl: null, changes: [], changeFiles: [], changeIds: [], canSend: false, canUndo: false, message: undefined });
      try {
        const root = await resolveProjectFolder(this.workspaceDir, info, this.known);
        this.root = root;
        const store = new ProjectStateStore(root);
        if (!(await fs.pathExists(store.paths.configPath))) await this.deps.sync.init(url, root, { projectRoot: root });
        this.known = { ...this.known, [info.key]: root };
        await new ProjectStateStore(root).loadProjectConfig().then(async (c) => {
          if (c.harness.autoPush) await this.deps.harness.updateSettings(root, { autoPush: false });
        });
        this.links = { ...this.links, [info.key]: url };
        await this.deps.appState.update({ lastLink: url, projects: this.known, links: this.links });
        void this.deps.harness.stopDevExcept(root);

        const status = await this.deps.sync.status({ projectRoot: root });
        // A reopened project is not re-pulled; unsent work is never replaced. Figma is compared at send time.
        if (!status.hasBaseline || (!restore && status.summary.total === 0)) {
          this.feed("Getting your project from Figma");
          this.set({ phase: "connecting" });
          await this.deps.withBrowser(() =>
            this.deps.sync.pull({ projectRoot: root, strategy: "backup", confirm: () => Promise.resolve(true), signal, progress: (m) => this.feed(m) }),
          );
        }
        if (signal.aborted) return this.cancelled();

        this.set({ phase: "preparing" });
        const project = await this.deps.harness.ensureProjectRunning(root, signal);
        if (signal.aborted) return this.cancelled();
        if (!project.ok) return this.fail("Couldn't start the project. Try again.", () => this.open(url, info, restore), "preview_failed");
        this.set({ previewUrl: project.url });
        await this.prepareAgentLocked(signal);
      } catch (error) {
        if (signal.aborted) return this.cancelled();
        if (isAuthRequiredError(error)) return this.needSignin(() => this.open(url, info, restore));
        this.deps.log("open failed", error);
        this.fail(plainError(error, "figma"), () => this.open(url, info, restore), errorCode(error, "figma"));
      }
    });
  }

  /** Opens another project from the list without pulling again. */
  async switchProject(key: string): Promise<void> {
    const link = this.links[key];
    const info = link ? parseFigmaLink(link) : null;
    if (this.isBusy() || !link || !info || key === this.activeKey) return;
    await this.open(link, info, true);
  }

  /** Takes a project off the list. Files stay unless `deleteFiles` is true and the folder is one this app made in the workspace. */
  async removeProject(key: string, deleteFiles = false): Promise<void> {
    if (this.isBusy() || !(key in this.links)) return;
    const root = this.known[key];
    const wasActive = key === this.activeKey;
    await this.exclusive(async () => {
      try {
        if (wasActive) await this.deps.harness.stopDevExcept(null, true).catch(() => undefined);
        const links = Object.fromEntries(Object.entries(this.links).filter(([k]) => k !== key));
        const known = Object.fromEntries(Object.entries(this.known).filter(([k]) => k !== key));
        this.links = links;
        this.known = known;
        this.stacks.delete(key);
        await this.deps.chatStore.remove(key).catch(() => undefined);
        if (wasActive) {
          this.messages = [];
          this.fresh = false;
          this.emitChat();
          this.stack = [];
          this.root = null;
          this.activeKey = null;
          this.agentReady = null;
          this.resume = null;
          this.dev = null;
          this.installing = false;
          this.previewStopped = false;
        }
        await this.deps.appState.update({ projects: known, links, ...(wasActive ? { lastLink: null } : {}) });
        if (wasActive) this.set(this.startState());
        if (deleteFiles && root && (await this.safeToDelete(root))) await fs.remove(root);
      } catch (error) {
        this.deps.log("remove failed", error);
      }
    });
    await this.refreshProjects();
  }

  private async safeToDelete(root: string): Promise<boolean> {
    const dir = path.resolve(root);
    const base = path.resolve(this.workspaceDir);
    const inside = dir.startsWith(base + path.sep);
    return inside && (await fs.pathExists(path.join(dir, STATE_DIRECTORY_NAME)));
  }

  /** Before/after of the files one change touched. Never throws. */
  async describeChange(index: number): Promise<ChangedFile[]> {
    try {
      const root = this.root;
      const entry = Number.isInteger(index) ? this.stack[index] : undefined;
      if (!root || !entry?.backupDir) return [];
      const next = this.stack[index + 1];
      if (next && !next.backupDir) return [];
      const after = next?.backupDir ? path.join(next.backupDir, "workspace") : root;
      const config = await new ProjectStateStore(root).loadProjectConfig();
      return await describeFolders(path.join(entry.backupDir, "workspace"), after, config.sync.ignore);
    } catch {
      return [];
    }
  }

  /** The files this turn touched (names only), or null when that couldn't be worked out. */
  private async changedFiles(root: string, backupDir: string | null): Promise<ChatFile[] | null> {
    if (!backupDir) return null;
    try {
      const config = await new ProjectStateStore(root).loadProjectConfig();
      const list = await listChangedFiles(path.join(backupDir, "workspace"), root, config.sync.ignore);
      return list.map((f) => ({ name: baseName(f.path), status: f.status }));
    } catch {
      return null;
    }
  }

  /** Recomputes the sidebar rows; one broken project never affects the others. */
  private async refreshProjects(): Promise<void> {
    const active = this.s.activeKey;
    const projects: ProjectSummary[] = [];
    for (const [key, link] of Object.entries(this.links)) {
      const name = parseFigmaLink(link)?.name ?? key;
      let status: ProjectSummary["status"] = "attention";
      let syncedAt: string | null = null;
      try {
        const root = this.known[key];
        if (root && (await fs.pathExists(path.join(root, STATE_DIRECTORY_NAME)))) {
          const meta = await new ProjectStateStore(root).readMetadata();
          syncedAt = [meta.lastPullAt, meta.lastPushAt].filter((t): t is string => Boolean(t)).sort().at(-1) ?? null;
          const failing = key === active && (this.s.phase === "error" || this.s.phase === "needs-figma-signin");
          if (!failing) {
            if (key === active) status = this.s.canSend ? "changes" : "synced";
            else status = (await this.deps.sync.status({ projectRoot: root })).summary.total > 0 ? "changes" : "synced";
          }
        }
      } catch (error) {
        this.deps.log("project status failed", error);
      }
      this.syncedAtByKey[key] = syncedAt;
      projects.push({ key, name, status, syncedAt });
    }
    this.set({ projects, syncedAt: (active && this.syncedAtByKey[active]) || null });
  }

  private async prepareAgent(): Promise<void> {
    await this.exclusive((signal) => this.prepareAgentLocked(signal));
    const next = this.pendingReopen;
    if (next && this.s.agentConnected && this.s.phase === "start" && !this.busy) {
      this.pendingReopen = null;
      await this.open(next.link, next.info, true);
    }
  }

  private async prepareAgentLocked(signal: AbortSignal): Promise<void> {
    const agent = this.s.agent;
    if (!agent) {
      this.set({ phase: "needs-ai-choice", message: undefined });
      return;
    }
    this.set({ phase: "preparing" });
    if (await this.ensureAgent(agent, signal)) await this.ready();
  }

  /** true when the AI tool is installed and signed in; otherwise the state already shows why. */
  private async ensureAgent(agent: AgentChoice, signal: AbortSignal): Promise<boolean> {
    const result = await this.deps.harness.ensureAgentReady(agent, signal);
    if (signal.aborted || (!result.ok && result.code === "cancelled")) {
      await this.cancelled();
      return false;
    }
    if (!result.ok) {
      const name = AGENT_NAMES[agent];
      const sentence = result.code === "signin_failed" ? `Couldn't sign in to ${name}. Try again.` : `Couldn't set up ${name}. Try again.`;
      const code = result.code === "node_failed" || result.code === "install_failed" ? "runtime_install_failed" : "agent_failed";
      this.fail(sentence, () => this.prepareAgent(), code);
      return false;
    }
    this.agentReady = agent;
    if (!this.s.agentConnected) {
      this.set({ agentConnected: true });
      await this.deps.appState.update({ agent, agentConnected: true });
    }
    return true;
  }

  private async exclusive<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.busy = true;
    const ctl = new AbortController();
    this.ctl = ctl;
    try {
      return await run(ctl.signal);
    } finally {
      this.busy = false;
      this.ctl = null;
    }
  }

  private async restore(backupDir: string): Promise<void> {
    if (!this.root) return;
    const store = new ProjectStateStore(this.root);
    const config = await store.loadProjectConfig();
    await store.restoreBackup(backupDir, config.sync.ignore);
  }

  /** Back to the calm state, with what can be sent and undone recomputed from disk. */
  private async ready(message?: string): Promise<void> {
    let canSend = false;
    if (this.root) {
      try {
        const status = await this.deps.sync.status({ projectRoot: this.root });
        canSend = status.hasBaseline && status.summary.total > 0;
      } catch {
        canSend = this.stack.length > 0;
      }
    }
    if (!canSend) {
      this.stack = [];
      this.settle("undone");
    }
    this.set({
      phase: this.s.previewUrl || this.previewStopped ? "ready" : "start",
      changes: this.stack.map((e) => e.sentence),
      changeFiles: this.stack.map((e) => e.files ?? 0),
      changeIds: this.stack.map((e) => e.id),
      canSend,
      canUndo: Boolean(this.stack.at(-1)?.backupDir),
      message,
    });
    await this.refreshProjects();
  }

  private cancelled(): Promise<void> {
    if (this.s.previewUrl) return this.ready();
    this.set(this.startState());
    return Promise.resolve();
  }

  private fail(message: string, retry: () => Promise<void>, code: ErrorCode = "unknown"): void {
    this.resume = retry;
    this.set({ phase: "error", message, code, failedIn: this.s.phase === "error" ? this.s.failedIn : this.s.phase });
  }

  private needSignin(retry: () => Promise<void>): void {
    this.resume = retry;
    this.set({ phase: "needs-figma-signin", message: undefined });
  }

  private set(patch: Patch): void {
    const next = { ...this.s, ...patch } as Record<string, unknown>;
    if (next["phase"] !== "conflict") delete next["conflictFiles"];
    if (next["phase"] !== "error") {
      delete next["code"];
      delete next["failedIn"];
    }
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    const timing = next["phase"] === "connecting" || next["phase"] === "preparing";
    if (timing && next["phase"] !== this.s.phase) this.stepStartedAt = Date.now();
    if (!timing) {
      this.startedAt = null;
      this.stepStartedAt = null;
    }
    next["activity"] = { lines: [...this.activity], stepStartedAt: this.stepStartedAt, startedAt: this.startedAt };
    next["processes"] = buildProcesses({
      hasProject: Boolean(this.root) && next["phase"] !== "start",
      phase: next["phase"] as Phase,
      previewUrl: (next["previewUrl"] as string | undefined) ?? null,
      dev: this.dev,
      installing: this.installing,
      agentWorking: this.turnId !== null,
      agentName: AGENT_NAMES[(next["agent"] as AgentChoice | null) ?? "claude"],
      devLines: this.devLines,
      setupLines: this.setupLines,
    });
    this.s = next as unknown as SessionState;
    for (const listener of this.listeners) listener(this.s);
  }
}
