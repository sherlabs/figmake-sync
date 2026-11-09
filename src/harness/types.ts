import type { AgentEvent, AgentId } from "./agents/types.js";

export type { AgentEvent, AgentId };

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  installed: boolean;
  version: string | null;
  /** true = signed in, false = not signed in, null = could not be determined. */
  signedIn: boolean | null;
  /** installed && signedIn !== false */
  usable: boolean;
  /** Human-readable next step when not usable (never includes credentials). */
  hint: string | null;
  /** true when the connector has not been verified against a real install. */
  experimental?: boolean;
}

export interface HarnessSettings {
  preferredAgent: AgentId;
  /** Opt-in. Default false. */
  autoPush: boolean;
  lastSession: { agent: AgentId; id: string } | null;
}

export interface DevStatus {
  rootDir: string;
  state: "stopped" | "starting" | "running" | "crashed";
  url: string | null;
  script: string | null;
  exitCode: number | null;
  logTail: string[];
}

export interface ChangeSet {
  hasBaseline: boolean;
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  total: number;
}

export interface SetupResult {
  /** true when npm install actually ran */
  installed: boolean;
  skipped: boolean;
  reason: string;
}

export type PushOutcome =
  | { status: "skipped"; reason: string }
  | { status: "pushed"; summary: { added: number; modified: number; deleted: number; renamed: number; total: number }; unresolved: string[] }
  | { status: "aborted"; reason: string; remoteDiverged?: string[] }
  | { status: "failed"; reason: string };

export interface RunOutcome {
  runId: string;
  agent: AgentId;
  success: boolean;
  cancelled: boolean;
  sessionId: string | null;
  resultText: string;
  error: string | null;
  backupDir: string | null;
  changes: ChangeSet | null;
  push: PushOutcome;
}

export type HarnessPhase = "backup" | "agent" | "diff" | "push";

/** Single envelope for everything streamed on the harness event channel. */
export type HarnessEvent =
  | { kind: "setup-log"; rootDir: string; line: string }
  | { kind: "dev-status"; rootDir: string; status: DevStatus }
  | { kind: "dev-log"; rootDir: string; line: string }
  | { kind: "run-phase"; rootDir: string; runId: string; phase: HarnessPhase; message: string }
  | { kind: "run-agent"; rootDir: string; runId: string; event: AgentEvent }
  | { kind: "run-done"; rootDir: string; runId: string; outcome: RunOutcome }
  | { kind: "agent-install-log"; agent: AgentId; line: string }
  | { kind: "agent-login-log"; agent: AgentId; line: string }
  /** A sign-in page was printed by the CLI. `url` is origin+path only; open it via harnessOpenAgentLogin. */
  | { kind: "agent-login-url"; agent: AgentId; url: string }
  | { kind: "agent-ensure"; agent: AgentId; stage: AgentEnsureStage; message: string }
  | { kind: "project-ensure"; rootDir: string; stage: ProjectEnsureStage; message: string; url?: string };

export type AgentEnsureStage =
  | "checking"
  | "installing-node"
  | "installing"
  | "needs-browser-signin"
  | "ready"
  | "failed";

export type ProjectEnsureStage = "checking" | "installing-node" | "installing-deps" | "starting" | "running" | "failed";

export type AgentInstallResult =
  | { ok: true; version: string | null; binPath: string | null }
  | { ok: false; code: "no_npm" | "unsupported" | "failed" | "cancelled" | "timeout"; message: string };

export type AgentLoginResult =
  | { ok: true }
  | { ok: false; code: "not_installed" | "unsupported" | "failed" | "cancelled" | "timeout"; message: string };

export type EnsureAgentResult =
  | { ok: true; agent: AgentInfo }
  | { ok: false; code: "cancelled" | "node_failed" | "install_failed" | "signin_failed" | "unusable"; message: string; agent: AgentInfo | null };

export type EnsureProjectResult =
  | { ok: true; url: string }
  | { ok: false; code: "cancelled" | "node_failed" | "deps_failed" | "no_dev_script" | "dev_failed"; message: string };

export class HarnessError extends Error {
  constructor(
    readonly code:
      | "agent_unavailable"
      | "run_in_progress"
      | "backup_failed"
      | "invalid_input"
      | "no_dev_script"
      | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
