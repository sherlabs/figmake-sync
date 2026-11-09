import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import fs from "fs-extra";

/** Minimal child surface the harness needs; node's ChildProcess satisfies it, fakes are easy. */
export interface ChildLike {
  pid?: number | undefined;
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stdin: { write(data: string): unknown; end(): unknown; on?(event: "error", cb: () => void): unknown } | null;
  on(event: "close", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildLike;

export type KillTreeFn = (child: ChildLike, signal: NodeJS.Signals) => void;

/** Quote one argument for cmd.exe; refuses characters that cannot be quoted safely. */
export function quoteCmdArg(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`Unsafe argument for cmd.exe: ${JSON.stringify(arg)}`);
  return `"${arg}"`;
}

export const defaultSpawn: SpawnFn = (command, args, options) => {
  // Node (CVE-2024-27980) refuses to spawn .cmd/.bat without a shell (EINVAL), and npm-installed CLIs are .cmd shims.
  // The prompt stays on stdin, so only fixed flags, validated ids and the project path pass through the shell.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command) && options.shell !== true) {
    const line = [command, ...args].map(quoteCmdArg).join(" ");
    return nodeSpawn(line, [], { ...options, shell: true }) as unknown as ChildLike;
  }
  return nodeSpawn(command, [...args], options) as unknown as ChildLike;
};

/**
 * Kill the child's whole process tree. On POSIX children are spawned detached
 * (own process group), so signalling -pid reaches grandchildren (vite, etc.).
 * On Windows, taskkill /T.
 */
export const defaultKillTree: KillTreeFn = (child, signal) => {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
};

/** Spawn options shared by agent + dev server: own process group, no shell, no inherited stdin. */
export function childOptions(cwd: string, env: NodeJS.ProcessEnv): SpawnOptions {
  return {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

/** Dirs where user-installed CLIs usually live; GUI-launched Electron has a minimal PATH. */
export function extraBinDirs(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

const SECRET_ENV = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i;
/** Auth variables the agent CLIs legitimately use for subscription sign-in. */
const KEEP_ENV = /^CLAUDE_CODE_OAUTH_TOKEN$/;

/**
 * Environment for agent processes: drops API keys and other secrets so the CLI
 * uses its own subscription sign-in (not a billed key) and a prompt-injected
 * agent cannot read them from its environment.
 */
export function agentEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(([k]) => KEEP_ENV.test(k) || !SECRET_ENV.test(k)),
  );
}

export function buildEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const sep = path.delimiter;
  const existing = (base["PATH"] ?? "").split(sep).filter(Boolean);
  const merged = [...existing, ...extraBinDirs().filter((d) => !existing.includes(d))];
  return { ...base, PATH: merged.join(sep), ...extra };
}

/** Find an executable by name on PATH (plus common extra dirs). Returns absolute path or null. */
export async function resolveBinary(
  name: string,
  env: NodeJS.ProcessEnv = buildEnv(),
  isExecutable: (p: string) => Promise<boolean> = defaultIsExecutable,
): Promise<string | null> {
  const dirs = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function defaultIsExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001B\][^\u0007]*\u0007/g, "");
}

/** Splits streamed chunks into complete lines. */
export class LineBuffer {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const parts = this.pending.split(/\r?\n/);
    this.pending = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] {
    const rest = this.pending + this.decoder.end();
    this.pending = "";
    return rest ? [rest] : [];
  }
}

/** Run a short probe (version / auth status) with a timeout; never throws. */
export function probe(
  spawn: SpawnFn,
  killTree: KillTreeFn,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
): Promise<{ stdout: string; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const decoder = new StringDecoder("utf8");
    let done = false;
    const finish = (value: { stdout: string; code: number | null; error?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildLike;
    try {
      child = spawn(command, args, { ...childOptions(os.tmpdir(), env), stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ stdout: "", code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      finish({ stdout, code: null, error: "timed out" });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer | string) => (stdout += typeof c === "string" ? c : decoder.write(c)));
    child.stderr?.on("data", () => undefined);
    child.on("error", (e: Error) => finish({ stdout, code: null, error: e.message }));
    child.on("close", (code: number | null) => finish({ stdout, code }));
  });
}
