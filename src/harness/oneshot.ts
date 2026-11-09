import os from "node:os";
import path from "node:path";

import fs from "fs-extra";

import { createClaudeAdapter } from "./agents/claude.js";
import { createCodexAdapter } from "./agents/codex.js";
import type { AgentId } from "./agents/types.js";
import {
  agentEnv,
  buildEnv,
  childOptions,
  defaultKillTree,
  defaultSpawn,
  resolveBinary,
  stripAnsi,
  type KillTreeFn,
  type SpawnFn,
} from "./process.js";

/**
 * One-shot, tool-less, read-only, JSON-in/JSON-out run of the user's connected agent CLI, used for silent
 * self-healing. Nothing here can edit files or run commands: the agent gets a prompt on stdin and returns text.
 *
 * Claude: `claude -p --tools "" --output-format json --no-session-persistence --strict-mcp-config
 *          --disable-slash-commands --setting-sources ""` (every flag verified against `claude --help` and one real run).
 * Codex:  `codex exec --json --sandbox read-only --skip-git-repo-check --cd <empty tmp dir> -`
 *          UNTESTED: the codex binary is not installed on the dev machine; flags follow the documented interface.
 */

export const ONESHOT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export type OneShotResult =
  | { ok: true; text: string }
  | { ok: false; code: "not_installed" | "timeout" | "cancelled" | "failed"; message: string };

export type RunOneShot = (agentId: AgentId, prompt: string, signal?: AbortSignal) => Promise<OneShotResult>;

export interface OneShotDeps {
  spawn?: SpawnFn | undefined;
  killTree?: KillTreeFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Override binary lookup (tests). */
  resolveBin?: ((name: string) => Promise<string | null>) | undefined;
  timeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  /** Scratch parent dir (default os.tmpdir()). */
  tmpRoot?: string | undefined;
}

export function buildOneShotArgs(agentId: AgentId, cwd: string): string[] {
  if (agentId === "claude") {
    // `--tools ""` disables ALL built-in tools; no MCP; no user hooks/settings; nothing persisted.
    return [
      "-p",
      "--tools",
      "",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--setting-sources",
      "",
    ];
  }
  return ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd, "-"];
}

/** Pull the model's text out of the CLI's stdout. */
export function parseOneShotOutput(agentId: AgentId, stdout: string): { ok: true; text: string } | { ok: false; message: string } {
  if (agentId === "claude") {
    try {
      const parsed = JSON.parse(stdout.trim()) as { result?: unknown; is_error?: unknown };
      if (parsed.is_error === true) return { ok: false, message: "The agent reported an error." };
      if (typeof parsed.result === "string") return { ok: true, text: parsed.result };
    } catch {
      // fall through
    }
    return { ok: false, message: "Unreadable agent output." };
  }
  const parse = createCodexAdapter().createLineParser();
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    for (const ev of parse(line)) {
      if (ev.type === "text") last = ev.text;
      if (ev.type === "result" && ev.text) last = ev.text;
    }
  }
  return last ? { ok: true, text: last } : { ok: false, message: "Unreadable agent output." };
}

export function createOneShotRunner(deps: OneShotDeps = {}): RunOneShot {
  const spawn = deps.spawn ?? defaultSpawn;
  const killTree = deps.killTree ?? defaultKillTree;
  const binaries: Record<AgentId, string> = { claude: createClaudeAdapter().binary, codex: createCodexAdapter().binary };

  return async (agentId, prompt, signal) => {
    if (signal?.aborted) return { ok: false, code: "cancelled", message: "Cancelled." };
    const env = buildEnv(deps.env);
    const bin = deps.resolveBin ? await deps.resolveBin(binaries[agentId]) : await resolveBinary(binaries[agentId], env);
    if (!bin) return { ok: false, code: "not_installed", message: "The AI assistant isn't installed." };

    // Empty scratch dir as cwd so no project files / CLAUDE.md are in reach.
    const cwd = await fs.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "figmake-heal-"));
    try {
      return await new Promise<OneShotResult>((resolve) => {
        let child: ReturnType<SpawnFn>;
        try {
          child = spawn(bin, buildOneShotArgs(agentId, cwd), { ...childOptions(cwd, agentEnv(env)), stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
          resolve({ ok: false, code: "failed", message: e instanceof Error ? e.message : String(e) });
          return;
        }
        let out = "";
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const stop = (): void => {
          killTree(child, "SIGTERM");
          killTimer = setTimeout(() => killTree(child, "SIGKILL"), deps.killGraceMs ?? 3000);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, deps.timeoutMs ?? ONESHOT_TIMEOUT_MS);
        const onAbort = (): void => {
          cancelled = true;
          stop();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (r: OneShotResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        };
        child.stdout?.on("data", (c: Buffer | string) => {
          if (out.length < MAX_OUTPUT_BYTES) out += typeof c === "string" ? c : c.toString("utf8");
        });
        child.stderr?.on("data", () => undefined);
        child.on("error", (e: Error) => finish({ ok: false, code: "failed", message: e.message }));
        child.on("close", (code: number | null) => {
          if (cancelled) return finish({ ok: false, code: "cancelled", message: "Cancelled." });
          if (timedOut) return finish({ ok: false, code: "timeout", message: "The AI assistant took too long." });
          if (code !== 0) return finish({ ok: false, code: "failed", message: `The AI assistant exited with code ${code}.` });
          const parsed = parseOneShotOutput(agentId, stripAnsi(out));
          finish(parsed.ok ? parsed : { ok: false, code: "failed", message: parsed.message });
        });
        child.stdin?.on?.("error", () => undefined);
        child.stdin?.write(prompt);
        child.stdin?.end();
        if (signal?.aborted) onAbort();
      });
    } finally {
      await fs.remove(cwd).catch(() => undefined);
    }
  };
}
