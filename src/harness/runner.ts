import {
  agentEnv,
  buildEnv,
  childOptions,
  defaultKillTree,
  defaultSpawn,
  LineBuffer,
  type ChildLike,
  type KillTreeFn,
  type SpawnFn,
} from "./process.js";
import type { AgentAdapter, AgentEvent } from "./agents/types.js";

export interface AgentRunOptions {
  adapter: AgentAdapter;
  /** Absolute path of the resolved binary. */
  command: string;
  cwd: string;
  prompt: string;
  sessionId?: string | undefined;
  /** Absolute paths of attached pictures (see AgentInvocationInput). */
  images?: readonly string[] | undefined;
  /** Chosen model; absent = the CLI's own default. */
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent: (event: AgentEvent) => void;
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface AgentRunResult {
  success: boolean;
  cancelled: boolean;
  sessionId: string | null;
  resultText: string;
  error: string | null;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Spawn the agent CLI non-interactively and stream parsed events. Prompt goes via stdin, never a shell. */
export function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const killTree = opts.killTree ?? defaultKillTree;
  const invocation = opts.adapter.buildInvocation({
    prompt: opts.prompt,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    ...(opts.images?.length ? { images: opts.images } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });
  const parse = opts.adapter.createLineParser();

  return new Promise((resolve) => {
    let sessionId: string | null = opts.sessionId ?? null;
    let resultText = "";
    let sawResult: { success: boolean } | null = null;
    let errorMsg: string | null = null;
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let stderrTail = "";
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const success = !cancelled && !timedOut && sawResult?.success === true;
      // Non-fatal error events on an otherwise successful run are not surfaced.
      let error = success ? null : errorMsg;
      if (!success && !error) {
        error = cancelled
          ? "Cancelled."
          : timedOut
            ? "Agent run timed out."
            : stderrTail.trim() || `Agent exited with code ${exitCode ?? "unknown"} without a result.`;
      }
      resolve({ success, cancelled, sessionId, resultText, error, exitCode });
    };

    let child: ChildLike;
    try {
      child = spawn(opts.command, invocation.args, {
        ...childOptions(opts.cwd, agentEnv(buildEnv(opts.env))),
      });
    } catch (error) {
      errorMsg = error instanceof Error ? error.message : String(error);
      finish(null);
      return;
    }

    const kill = (): void => {
      killTree(child, "SIGTERM");
      if (!killTimer) killTimer = setTimeout(() => killTree(child, "SIGKILL"), opts.killGraceMs ?? 2000);
    };
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      for (const event of parse(line)) {
        if (event.type === "session") sessionId = event.sessionId;
        if (event.type === "result") {
          sawResult = { success: event.success };
          resultText = event.text;
          if (event.sessionId) sessionId = event.sessionId;
          if (!event.success) errorMsg = event.text || errorMsg || "Agent reported failure.";
        }
        if (event.type === "error" && !errorMsg) errorMsg = event.message;
        opts.onEvent(event);
      }
    };

    const out = new LineBuffer();
    child.stdout?.on("data", (c) => out.push(c).forEach(handleLine));
    child.stderr?.on("data", (c) => {
      stderrTail = (stderrTail + c.toString()).slice(-4096);
    });
    child.on("error", (e: Error) => {
      errorMsg = e.message;
      finish(null);
    });
    child.on("close", (code: number | null) => {
      out.flush().forEach(handleLine);
      finish(code);
    });

    child.stdin?.on?.("error", () => undefined);
    child.stdin?.write(invocation.stdin);
    child.stdin?.end();
  });
}
