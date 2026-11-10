export type AgentChoice = "claude" | "codex";

export const PHASES = [
  "start",
  "connecting",
  "preparing",
  "ready",
  "working",
  "sending",
  "needs-figma-signin",
  "needs-ai-choice",
  "needs-ai-signin",
  "conflict",
  "error",
] as const;
export type Phase = (typeof PHASES)[number];

/** Stable, plain identifiers for failures. Shown nowhere except in a bug report title. */
export const ERROR_CODES = [
  "figma_signin_required",
  "figma_ui_changed",
  "figma_unreachable",
  "agent_failed",
  "runtime_install_failed",
  "preview_failed",
  "push_failed",
  "backup_failed",
  "undo_failed",
  "invalid_link",
  "unknown",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** What the renderer may tell main about a failure; main adds everything else. */
export interface ReportRequest {
  errorCode: ErrorCode;
  message: string;
  phase: Phase;
}

export type ProjectStatus = "synced" | "changes" | "attention";

/** One row of the sidebar. `syncedAt` is an ISO time or null when never synced. */
export interface ProjectSummary {
  key: string;
  name: string;
  status: ProjectStatus;
  syncedAt: string | null;
}

/** One cell of the side-by-side before/after view. */
export interface DiffCell {
  n: number;
  text: string;
  mark: "same" | "del" | "add";
}

/** A row of the before/after view: left is "before", right is "after"; a hunk row carries only a label. */
export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
  hunk?: string;
}

export interface ChangedFile {
  path: string;
  status: "edited" | "added" | "removed";
  binary: boolean;
  truncated: boolean;
  rows: DiffRow[];
}

export type ProcessId = "preview" | "agent" | "install";

/** One thing figmake-sync keeps running for the open project, described in plain words. */
export interface ProcessInfo {
  id: ProcessId;
  /** Friendly name: "Preview", "Claude (AI helper)". */
  name: string;
  state: "starting" | "running" | "stopped" | "failed";
  /** One plain sentence, only when there is something to explain. */
  note?: string;
  canStop: boolean;
  canRestart: boolean;
}

/** One row of the file explorer. `path` uses "/" and is relative to the project folder. */
export interface TreeEntry {
  name: string;
  path: string;
  kind: "folder" | "file";
}

/** The direct children of one folder, capped; `truncated` is true when more existed. */
export interface FolderListing {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

/** What the read-only viewer shows for one file. */
export type FileView =
  | { kind: "text"; path: string; text: string; lines: number }
  | { kind: "image"; path: string; dataUrl: string }
  | { kind: "binary" | "large"; path: string; size: number }
  | { kind: "missing"; path: string };

/** The one thing the renderer ever sees. Every sentence in it is already plain language. */
export interface SessionState {
  phase: Phase;
  projectName: string | null;
  previewUrl: string | null;
  /** Plain sentences the AI wrote about what it changed, oldest first. */
  changes: string[];
  /** How many files each entry of `changes` touched (same order). */
  changeFiles: number[];
  /** Stable id of each entry of `changes` (same order); chat cards point at these, never at positions. */
  changeIds: string[];
  /** Every project in the list, in the order they were added. */
  projects: ProjectSummary[];
  activeKey: string | null;
  /** ISO time the open project was last synced with Figma, or null. */
  syncedAt: string | null;
  /** Whether quiet self-updates are on (Settings). */
  updatesEnabled: boolean;
  canSend: boolean;
  canUndo: boolean;
  message?: string;
  /** Present only in the "conflict" phase: files changed in Figma since the last pull (may be a partial list). */
  conflictFiles?: string[];
  /** Present only in the "error" phase: stable code of the failure, and the phase it happened in. */
  code?: ErrorCode;
  failedIn?: Phase;
  agent: AgentChoice | null;
  /** Folder name (not path) of the workspace new projects are created in. */
  workspace: string;
  workspaceError?: string;
  /** What is running for the open project (preview, AI helper, setup), for the Files panel. */
  processes: ProcessInfo[];
}

export type ActivityKind = "look" | "edit" | "add" | "check" | "other";

/** One friendly line of what the AI did: "Looked at Button.tsx". Never a command or a full path. */
export interface ChatActivity {
  kind: ActivityKind;
  label: string;
  /** File name only (no folders), when the line is about one file. */
  file?: string;
}

/** An assistant message is an ordered run of text and activity groups, like Claude's own chat. */
export type ChatPart = { type: "text"; text: string } | { type: "activity"; items: ChatActivity[] };

export interface ChatFile {
  name: string;
  status: "edited" | "added" | "removed";
}

/** The card shown at the end of a turn that changed files. */
export interface ChatChange {
  /** Matches an entry of `SessionState.changeIds` while the change can still be viewed or undone. */
  turnId: string;
  summary: string;
  files: ChatFile[];
  previewUpdated: boolean;
  fate: "active" | "undone" | "sent";
}

export type ChatStatus = "done" | "streaming" | "stopped" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** ISO time. */
  at: string;
  /** What the person typed (user messages only). */
  text: string;
  /** What the AI said and did, in order (assistant messages only). */
  parts: ChatPart[];
  status: ChatStatus;
  change?: ChatChange;
  /** Present on a failed turn: one plain sentence and a stable code. */
  error?: { message: string; code: ErrorCode };
}

/** The conversation of the open project. */
export interface ChatState {
  projectKey: string | null;
  messages: ChatMessage[];
  /** True while the AI is answering the latest message. */
  active: boolean;
  /** True when the next message starts a brand new AI conversation. */
  fresh: boolean;
}

export interface DesktopAppState {
  lastLink: string | null;
  agent: AgentChoice | null;
  workspace: string | null;
  projects: Record<string, string>;
  /** Figma Make file key -> the link it was added with (names and the project list come from here). */
  links: Record<string, string>;
  updates: { enabled: boolean };
}

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MenuCommand = "settings" | "add-project";

/** window.figmake, exposed by preload.cjs. */
export interface FigmakeApi {
  state(): Promise<SessionState>;
  onState(listener: (state: SessionState) => void): () => void;
  onCommand(listener: (command: MenuCommand) => void): () => void;
  openProject(link: string): Promise<void>;
  ask(prompt: string): Promise<void>;
  chat(): Promise<ChatState>;
  onChat(listener: (chat: ChatState) => void): () => void;
  /** Starts a fresh AI conversation; the old one is archived. */
  newChat(): Promise<void>;
  /** Copies plain text to the system clipboard. */
  copyText(text: string): Promise<void>;
  /** Undoes the newest change, or (with an index) that change and every later one. */
  undo(index?: number): Promise<void>;
  switchProject(key: string): Promise<void>;
  /** Takes the project off the list; files are deleted only when `deleteFiles` is true. */
  removeProject(key: string, deleteFiles: boolean): Promise<void>;
  /** Before/after of the files one change touched. */
  describeChange(index: number): Promise<ChangedFile[]>;
  send(resolution?: "mine" | "figma"): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  setAgent(agent: AgentChoice): Promise<void>;
  chooseWorkspace(): Promise<void>;
  signOutFigma(): Promise<void>;
  setUpdates(enabled: boolean): Promise<void>;
  reportIssue(request: ReportRequest): Promise<void>;
  onUpdateState(listener: (state: { phase: "idle" | "downloading" | "ready"; version?: string }) => void): () => void;
  installUpdate(): Promise<void>;
  /** Direct children of a project folder ("" = the project itself). Read-only. */
  listFolder(path: string): Promise<FolderListing>;
  /** Contents of one project file for the read-only viewer. */
  readFile(path: string): Promise<FileView>;
  /** Project files (not folders) the AI changed since the last pull. */
  changedFiles(): Promise<string[]>;
  stopProcess(id: ProcessId): Promise<void>;
  restartProcess(id: ProcessId): Promise<void>;
  /** Where the preview sits in the window (null hides it). */
  previewRect(rect: PreviewRect | null): void;
}

declare global {
  interface Window {
    figmake: FigmakeApi;
  }
}
