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
  | { kind: "run-done"; rootDir: string; runId: string; outcome: RunOutcome };

export class HarnessError extends Error {
  constructor(
    readonly code:
      | "agent_unavailable"
      | "run_in_progress"
      | "backup_failed"
      | "invalid_input"
      | "no_dev_script",
    message: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
