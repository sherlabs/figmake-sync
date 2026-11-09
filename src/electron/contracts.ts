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

/** The one thing the renderer ever sees. Every sentence in it is already plain language. */
export interface SessionState {
  phase: Phase;
  projectName: string | null;
  previewUrl: string | null;
  /** Plain sentences the AI wrote about what it changed, oldest first. */
  changes: string[];
  canSend: boolean;
  canUndo: boolean;
  message?: string;
  /** Present only in the "error" phase: stable code of the failure, and the phase it happened in. */
  code?: ErrorCode;
  failedIn?: Phase;
  agent: AgentChoice | null;
  /** Folder name (not path) of the workspace new projects are created in. */
  workspace: string;
  workspaceError?: string;
}

export interface DesktopAppState {
  lastLink: string | null;
  agent: AgentChoice | null;
  workspace: string | null;
  projects: Record<string, string>;
  updates: { enabled: boolean };
}

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MenuCommand = "settings" | "start";

/** window.figmake, exposed by preload.cjs. */
export interface FigmakeApi {
  state(): Promise<SessionState>;
  onState(listener: (state: SessionState) => void): () => void;
  onCommand(listener: (command: MenuCommand) => void): () => void;
  openProject(link: string): Promise<void>;
  ask(prompt: string): Promise<void>;
  undo(): Promise<void>;
  send(resolution?: "mine" | "figma"): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  setAgent(agent: AgentChoice): Promise<void>;
  chooseWorkspace(): Promise<void>;
  signOutFigma(): Promise<void>;
  reportIssue(request: ReportRequest): Promise<void>;
  onUpdateState(listener: (state: { phase: "idle" | "downloading" | "ready"; version?: string }) => void): () => void;
  installUpdate(): Promise<void>;
  /** Where the preview sits in the window (null hides it). */
  previewRect(rect: PreviewRect | null): void;
}

declare global {
  interface Window {
    figmake: FigmakeApi;
  }
}
