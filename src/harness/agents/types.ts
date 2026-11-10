/** Shared agent-adapter contract. Each CLI connector implements AgentAdapter. */

export type AgentId = "claude" | "codex";

export interface PlanStep {
  text: string;
  state: "pending" | "active" | "done";
}

/** Normalized event streamed from an agent run (CLI-specific formats are parsed by adapters). */
export type AgentEvent =
  | { type: "session"; sessionId: string }
  /** `delta: true` continues the previous text; otherwise it is a whole new block of text. */
  | { type: "text"; text: string; delta?: boolean }
  | { type: "tool"; name: string; summary: string }
  /** The AI is reasoning. Carries no text on purpose: only the fact that it is thinking is shown. */
  | { type: "thinking" }
  /** The AI started a helper (sub-agent); `description` is the short task it was given. */
  | { type: "helper"; description: string }
  /** The AI's checklist; every update replaces the previous one. */
  | { type: "plan"; steps: PlanStep[] }
  | { type: "file_edit"; path: string; tool: string }
  | {
      type: "result";
      success: boolean;
      text: string;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
    }
  | { type: "error"; message: string };

export interface AgentInvocationInput {
  prompt: string;
  /** Project directory; also used as the child's cwd. */
  cwd: string;
  /** When set, continue that session instead of starting a new one. */
  sessionId?: string | undefined;
}

export interface AgentInvocation {
  /** Binary name (resolved to an absolute path by the caller). */
  command: string;
  /** argv elements only. The prompt is NEVER interpolated into a shell string. */
  args: string[];
  /** Prompt text, written to the child's stdin. */
  stdin: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly binary: string;
  /** Connector not verified against a real install. */
  readonly experimental?: boolean;
  /** Shown when the binary is missing. */
  readonly installHint: string;
  /** Shown when the binary exists but the user is not signed in. */
  readonly loginHint: string;
  /** npm package that provides the binary (installed into the app's private prefix, never globally). */
  readonly npmPackage?: string;
  /** Command for the manual fallback shown when in-app sign-in cannot run. */
  readonly manualLogin?: string;
  /** argv for the CLI's own browser sign-in (opens the user's browser itself). */
  loginArgs?(): string[];
  versionArgs(): string[];
  parseVersion(stdout: string): string | null;
  /** Args for a sign-in status probe, or null when the CLI has none. */
  authArgs(): string[] | null;
  /** true = signed in, false = not signed in, null = unknown. */
  parseAuth(stdout: string, exitCode: number | null): boolean | null;
  buildInvocation(input: AgentInvocationInput): AgentInvocation;
  /** Stateful per-run parser: one stdout line in, zero or more events out. */
  createLineParser(): (line: string) => AgentEvent[];
}

/** Session ids are passed to CLIs as argv; accept only a conservative charset. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function validSessionId(id: string | undefined | null): string | undefined {
  return id && SESSION_ID_PATTERN.test(id) ? id : undefined;
}
