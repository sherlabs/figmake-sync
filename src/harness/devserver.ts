import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildEnv,
  childOptions,
  defaultKillTree,
  defaultSpawn,
  LineBuffer,
  stripAnsi,
  type ChildLike,
  type KillTreeFn,
  type SpawnFn,
} from "./process.js";
import type { DevStatus } from "./types.js";

export const DEV_SCRIPT_PRIORITY = ["dev", "start", "serve"] as const;

export async function detectDevScript(rootDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of DEV_SCRIPT_PRIORITY) {
      if (typeof pkg.scripts?.[name] === "string") return name;
    }
  } catch {
    // no/invalid package.json
  }
  return null;
}

/**
 * Extract a local dev URL from one output line (ANSI colors tolerated).
 * Only localhost / 127.0.0.1 / 0.0.0.0 (mapped to localhost) are accepted, so
 * the result is always safe for shell.openExternal.
 */
export function parseDevUrl(line: string): string | null {
  const match = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(\/[^\s\u001B]*)?/.exec(stripAnsi(line));
  if (!match) return null;
  const host = match[1] === "0.0.0.0" ? "localhost" : (match[1] as string);
  const proto = match[0].startsWith("https") ? "https" : "http";
  return `${proto}://${host}:${match[2]}${match[3] ?? "/"}`;
}

/** Allowed targets for shell.openExternal. */
export function isSafeLocalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

const LOG_TAIL_LINES = 200;
const STOP_GRACE_MS = 3000;

export interface DevServerDeps {
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  env?: NodeJS.ProcessEnv;
  onChange?: (status: DevStatus) => void;
  onLog?: (line: string) => void;
  stopGraceMs?: number;
}

export class DevServer {
  private child: ChildLike | null = null;
  private state: DevStatus["state"] = "stopped";
  private url: string | null = null;
  private script: string | null = null;
  private tail: string[] = [];
  private exitCode: number | null = null;
  private stopping = false;
  private closed: Promise<void> = Promise.resolve();
  /** In-flight start (script detection is async); makes start idempotent and stoppable. */
  private starting: Promise<DevStatus> | null = null;
  private stopRequested = false;

  constructor(
    readonly rootDir: string,
    private readonly deps: DevServerDeps = {},
  ) {}

  status(): DevStatus {
    return {
      rootDir: this.rootDir,
      state: this.state,
      url: this.url,
      script: this.script,
      exitCode: this.exitCode,
      logTail: [...this.tail],
    };
  }

  start(): Promise<DevStatus> {
    if (this.state === "starting" || this.state === "running") return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    this.stopRequested = false;
    const run = this.doStart().finally(() => {
      if (this.starting === run) this.starting = null;
    });
    this.starting = run;
    return run;
  }

  private async doStart(): Promise<DevStatus> {
    const script = await detectDevScript(this.rootDir);
    if (this.stopRequested) return this.status(); // stop() arrived while detecting: do not spawn
    if (!script) {
      throw new Error("No dev script found in package.json (looked for dev, start, serve).");
    }
    const spawn = this.deps.spawn ?? defaultSpawn;
    this.script = script;
    this.url = null;
    this.exitCode = null;
    this.tail = [];
    this.stopping = false;
    this.state = "starting";

    // BROWSER=none stops CRA/vite from opening a tab themselves; the app opens it on request.
    const env = buildEnv(this.deps.env, { BROWSER: "none", FORCE_COLOR: "0" });
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    let child: ChildLike;
    try {
      child = spawn(command, ["run", script], {
        ...childOptions(this.rootDir, env),
        stdio: ["ignore", "pipe", "pipe"],
        ...(process.platform === "win32" ? { shell: true } : {}),
      });
    } catch (error) {
      this.state = "crashed";
      this.push(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.emit();
      return this.status();
    }
    this.child = child;
    this.closed = new Promise<void>((resolve) => {
      const out = new LineBuffer();
      const err = new LineBuffer();
      const onLine = (line: string): void => this.onLine(line);
      child.stdout?.on("data", (c) => out.push(c).forEach(onLine));
      child.stderr?.on("data", (c) => err.push(c).forEach(onLine));
      child.on("error", (e: Error) => {
        this.push(`process error: ${e.message}`);
        this.finish(null, resolve);
      });
      child.on("close", (code: number | null) => {
        out.flush().forEach(onLine);
        err.flush().forEach(onLine);
        this.finish(code, resolve);
      });
    });
    this.emit();
    return this.status();
  }

  async stop(force = false): Promise<DevStatus> {
    if (this.starting) {
      this.stopRequested = true;
      await this.starting.catch(() => undefined);
    }
    const child = this.child;
    if (!child || this.state === "stopped" || this.state === "crashed") {
      if (this.state === "crashed") {
        this.state = "stopped";
        this.url = null;
        this.emit();
      }
      return this.status();
    }
    this.stopping = true;
    const killTree = this.deps.killTree ?? defaultKillTree;
    killTree(child, "SIGTERM");
    // On app quit there is no time for a grace period: the process would exit before the timer fires.
    if (force) killTree(child, "SIGKILL");
    const timer = setTimeout(() => killTree(child, "SIGKILL"), this.deps.stopGraceMs ?? STOP_GRACE_MS);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
    return this.status();
  }

  private finish(code: number | null, resolve: () => void): void {
    this.child = null;
    this.exitCode = code;
    this.state = this.stopping ? "stopped" : "crashed";
    this.url = null; // a dead server's URL must not be offered to the user
    this.emit();
    resolve();
  }

  private onLine(line: string): void {
    const clean = stripAnsi(line).trimEnd();
    if (!clean) return;
    this.push(clean);
    this.deps.onLog?.(clean);
    if (!this.url) {
      const url = parseDevUrl(clean);
      if (url) {
        this.url = url;
        this.state = "running";
        this.emit();
      }
    }
  }

  private push(line: string): void {
    this.tail.push(line);
    if (this.tail.length > LOG_TAIL_LINES) this.tail.splice(0, this.tail.length - LOG_TAIL_LINES);
  }

  private emit(): void {
    this.deps.onChange?.(this.status());
  }
}
