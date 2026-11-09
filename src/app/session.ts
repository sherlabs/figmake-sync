import path from "node:path";

import fs from "fs-extra";

import type { FigmakeSyncService } from "../core/service.js";
import { ProjectStateStore } from "../core/state.js";
import { REMOTE_DIVERGED_PROMPT, isAllowedLoginUrl } from "../harness/index.js";
import type { HarnessEvent, HarnessService } from "../harness/index.js";
import type { AgentChoice, DesktopAppState, ErrorCode, Phase, SessionState } from "../electron/contracts.js";
import { isAuthRequiredError } from "../electron/authState.js";
import { defaultWorkspaceDir, parseFigmaLink, resolveProjectFolder, validateWorkspace, type FigmaLink, type WorkspaceGuard } from "./workspace.js";

/** Short fixed context for every prompt: nothing is ever written into the project to carry it. */
export const PROMPT_PREFACE =
  "This is a Figma Make project: a React app. Edit only files under src and styles. Do not touch config files, lockfiles or node_modules. Keep the dev server running. When done, reply with one plain sentence describing what changed.";

export const AGENT_NAMES: Record<AgentChoice, string> = { claude: "Claude", codex: "ChatGPT" };

export interface SessionDeps {
  sync: Pick<FigmakeSyncService, "init" | "pull" | "push" | "status" | "auth">;
  harness: Pick<HarnessService, "ensureProjectRunning" | "ensureAgentReady" | "startRun" | "pendingLoginUrl" | "stopDevExcept" | "updateSettings">;
  appState: { load(): Promise<DesktopAppState>; update(patch: Partial<DesktopAppState>): Promise<DesktopAppState> };
  documentsDir: string;
  guard: WorkspaceGuard;
  chooseFolder(): Promise<string | null>;
  openExternal(url: string): void;
  reloadPreview(): void;
  signOutFigma(): Promise<void>;
  /** Runs a Figma browser action, installing the browser first when needed. */
  withBrowser<T>(run: () => Promise<T>): Promise<T>;
  /** Resolves once the person says they are done signing in to Figma. */
  waitForFigmaSignin(): Promise<void>;
  log(message: string, error?: unknown): void;
}

type Patch = { [K in keyof SessionState]?: SessionState[K] | undefined };
type Resolution = "mine" | "figma";
interface Entry {
  sentence: string;
  backupDir: string | null;
}

/** Thrown from the push confirm hook: nothing has been written yet, the person decides. */
class Diverged extends Error {}

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
  canSend: false,
  canUndo: false,
  agent: null,
  workspace: "",
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
  private resume: (() => Promise<void>) | null = null;
  private known: Record<string, string> = {};

  constructor(private readonly deps: SessionDeps) {
    this.workspaceDir = defaultWorkspaceDir(deps.documentsDir);
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

  /** Loads preferences, prepares the workspace, and reopens the last project straight into "preparing". */
  async start(): Promise<void> {
    const saved = await this.deps.appState.load();
    this.known = saved.projects;
    this.set({ agent: saved.agent });
    await this.useWorkspace(saved.workspace);
    const info = saved.lastLink ? parseFigmaLink(saved.lastLink) : null;
    const root = info ? this.known[info.key] : undefined;
    if (saved.lastLink && info && root && (await fs.pathExists(root))) {
      await this.open(saved.lastLink, info, true);
    }
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
        this.set({ ...START, agent: this.s.agent, workspace: this.s.workspace });
        return Promise.resolve();
      };
      return;
    }
    await this.open(link.trim(), info, false);
  }

  async ask(prompt: string): Promise<void> {
    const text = prompt.trim();
    const agent = this.s.agent;
    if (!text || this.busy || !this.root || !this.s.previewUrl || !agent || this.s.phase !== "ready") return;
    const root = this.root;
    await this.exclusive(async (signal) => {
      try {
        this.set({ phase: "preparing", message: undefined });
        if (this.agentReady !== agent && !(await this.ensureAgent(agent, signal))) return;
        this.set({ phase: "working", message: undefined });
        const { done } = await this.deps.harness.startRun({ rootDir: root, prompt: `${PROMPT_PREFACE}\n\n${text}`, agent }, signal);
        const outcome = await done;
        if (outcome.cancelled || !outcome.success) {
          // The app made the backup itself; put the files back so a stopped or failed run leaves nothing half-done.
          if (outcome.backupDir) await this.restore(outcome.backupDir).catch((e: unknown) => this.deps.log("restore failed", e));
          this.deps.reloadPreview();
          if (outcome.cancelled) return this.ready();
          return this.fail(plainError(new Error(outcome.error ?? ""), "agent", agent), () => this.ask(text), errorCode(new Error(outcome.error ?? ""), "agent"));
        }
        const sentence = parseChange(outcome.resultText) ?? "Made a change";
        this.stack.push({ sentence, backupDir: outcome.backupDir });
        this.deps.reloadPreview();
        await this.ready();
      } catch (error) {
        if (signal.aborted) return this.ready();
        this.deps.log("ask failed", error);
        this.fail(plainError(error, "agent", agent), () => this.ask(text), errorCode(error, "agent"));
      }
    });
  }

  async undo(): Promise<void> {
    const top = this.stack.at(-1);
    if (this.busy || this.s.phase !== "ready" || !top?.backupDir) return;
    await this.exclusive(async () => {
      try {
        await this.restore(top.backupDir as string);
        this.stack.pop();
        this.deps.reloadPreview();
        await this.ready();
      } catch (error) {
        this.deps.log("undo failed", error);
        this.fail("Couldn't undo that. Try again.", () => this.undo(), "undo_failed");
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
        this.stack = [];
        await this.ready(resolution === "figma" ? undefined : "Sent to Figma");
      } catch (error) {
        if (signal.aborted) return this.ready();
        if (error instanceof Diverged) return this.set({ phase: "conflict", message: "Figma has newer changes." });
        if (isAuthRequiredError(error)) return this.needSignin(() => this.send(resolution));
        this.deps.log("send failed", error);
        this.fail(plainError(error, "figma"), () => this.send(resolution), errorCode(error, "figma"));
      }
    });
  }

  cancel(): Promise<void> {
    if (this.s.phase === "conflict") return this.ready();
    if (this.busy) this.ctl?.abort();
    else if (!this.s.previewUrl && this.s.phase !== "start") this.set({ ...START, agent: this.s.agent, workspace: this.s.workspace, workspaceError: this.s.workspaceError });
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
      const ok = await this.exclusive(async () => {
        this.set({ phase: "connecting", message: undefined });
        try {
          await this.deps.withBrowser(() => this.deps.sync.auth({ projectRoot: root, waitForManualAction: () => this.deps.waitForFigmaSignin() }));
          if (this.s.previewUrl) this.set({ phase: "ready" });
          return true;
        } catch (error) {
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
    await this.deps.appState.update({ agent });
    if (this.agentReady !== agent) this.agentReady = null;
    this.set({ agent });
    if (this.s.phase === "needs-ai-choice" && !this.busy) await this.prepareAgent();
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
    } else if (event.kind === "agent-login-url") {
      const url = this.deps.harness.pendingLoginUrl(event.agent);
      if (url && isAllowedLoginUrl(url)) this.deps.openExternal(url);
    }
  }

  // ---- flow ----

  /** The app never sends on its own: auto-push set earlier (CLI or old app) is switched off. */
  private async open(url: string, info: FigmaLink, restore: boolean): Promise<void> {
    await this.exclusive(async (signal) => {
      this.stack = [];
      this.agentReady = null;
      this.set({ phase: restore ? "preparing" : "connecting", projectName: info.name, previewUrl: null, changes: [], canSend: false, canUndo: false, message: undefined });
      try {
        const root = await resolveProjectFolder(this.workspaceDir, info, this.known);
        this.root = root;
        const store = new ProjectStateStore(root);
        if (!(await fs.pathExists(store.paths.configPath))) await this.deps.sync.init(url, root, { projectRoot: root });
        this.known = { ...this.known, [info.key]: root };
        await new ProjectStateStore(root).loadProjectConfig().then(async (c) => {
          if (c.harness.autoPush) await this.deps.harness.updateSettings(root, { autoPush: false });
        });
        await this.deps.appState.update({ lastLink: url, projects: this.known });
        void this.deps.harness.stopDevExcept(root);

        const status = await this.deps.sync.status({ projectRoot: root });
        // A reopened project is not re-pulled; unsent work is never replaced. Figma is compared at send time.
        if (!status.hasBaseline || (!restore && status.summary.total === 0)) {
          this.set({ phase: "connecting" });
          await this.deps.withBrowser(() =>
            this.deps.sync.pull({ projectRoot: root, strategy: "backup", confirm: () => Promise.resolve(true), signal }),
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

  private prepareAgent(): Promise<void> {
    return this.exclusive((signal) => this.prepareAgentLocked(signal));
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
    if (!canSend) this.stack = [];
    this.set({
      phase: this.s.previewUrl ? "ready" : "start",
      changes: this.stack.map((e) => e.sentence),
      canSend,
      canUndo: Boolean(this.stack.at(-1)?.backupDir),
      message,
    });
  }

  private cancelled(): Promise<void> {
    if (this.s.previewUrl) return this.ready();
    this.set({ ...START, agent: this.s.agent, workspace: this.s.workspace, workspaceError: this.s.workspaceError });
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
    if (next["phase"] !== "error") {
      delete next["code"];
      delete next["failedIn"];
    }
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    this.s = next as unknown as SessionState;
    for (const listener of this.listeners) listener(this.s);
  }
}
