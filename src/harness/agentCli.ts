import os from "node:os";
import path from "node:path";

import fs from "fs-extra";

import { agentBinDirFor, agentToolsDir } from "../runtime/managed.js";
import type { AgentAdapter, AgentId } from "./agents/types.js";
import {
  buildEnv,
  agentEnv,
  childOptions,
  defaultKillTree,
  defaultSpawn,
  LineBuffer,
  resolveBinary,
  stripAnsi,
  type KillTreeFn,
  type SpawnFn,
} from "./process.js";
import type { AgentInstallResult, AgentLoginResult, HarnessEvent } from "./types.js";

export const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_LINE = 400;

/** argv for a PRIVATE install: --prefix into the app's own dir, never -g. Installs the latest published version. */
export function buildInstallArgs(prefix: string, pkg: string): string[] {
  return ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--no-progress", pkg];
}

// ---- sign-in URL handling ---------------------------------------------------

const ALLOWED_SUFFIXES = ["claude.ai", "claude.com", "anthropic.com", "openai.com", "chatgpt.com"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Only well-known sign-in hosts may be opened: https on claude.ai / claude.com / anthropic.com / openai.com /
 * chatgpt.com (and subdomains), or http(s) on localhost / 127.0.0.1 (CLI loopback callbacks). No userinfo.
 */
export function isAllowedLoginUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return u.protocol === "https:" || u.protocol === "http:";
  if (u.protocol !== "https:") return false;
  if (u.port && u.port !== "443") return false;
  return ALLOWED_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`));
}

const URL_RE = /https?:\/\/[^\s"'<>\])}]+/gi;

export function extractUrls(line: string): string[] {
  return line.match(URL_RE) ?? [];
}

/** origin + path only: query strings and fragments can carry OAuth state/codes. */
export function stripUrlQuery(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

/** Replace every URL in a line with its query-less form (applied to everything that is emitted or persisted). */
export function redactUrls(line: string): string {
  return line.replace(URL_RE, (m) => {
    const stripped = stripUrlQuery(m);
    return stripped === m ? m : `${stripped}?…`;
  });
}

// ---- streaming process runner ----------------------------------------------

interface RunOpts {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  onLine: (line: string) => void;
  killGraceMs: number;
}
interface RunResult {
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
  spawnError?: string;
}

function runStreaming(spawn: SpawnFn, killTree: KillTreeFn, o: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn(o.command, o.args, { ...childOptions(o.cwd, o.env), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, cancelled: false, timedOut: false, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    const bufs = [new LineBuffer(), new LineBuffer()];
    const feed = (i: number) => (chunk: Buffer | string) => {
      for (const l of bufs[i]!.push(chunk)) emitLine(l);
    };
    const emitLine = (raw: string): void => {
      const line = stripAnsi(raw).replace(/\r/g, "").trimEnd();
      if (line) o.onLine(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    };
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), o.killGraceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    child.stdout?.on("data", feed(0));
    child.stderr?.on("data", feed(1));
    child.on("error", (e: Error) => finish({ code: null, cancelled, timedOut, spawnError: e.message }));
    child.on("close", (code: number | null) => {
      for (const b of bufs) for (const l of b.flush()) emitLine(l);
      finish({ code, cancelled, timedOut });
    });
  });
}

// ---- manager ---------------------------------------------------------------

export interface AgentCliDeps {
  emit: (event: HarnessEvent) => void;
  /** <userData>/runtime, or null when unavailable (then installs are refused). */
  runtimeRoot: () => string | null;
  adapters: () => Map<AgentId, AgentAdapter>;
  spawn?: SpawnFn | undefined;
  killTree?: KillTreeFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Override npm lookup (tests). */
  resolveNpm?: (() => Promise<string | null>) | undefined;
  resolveBin?: ((name: string) => Promise<string | null>) | undefined;
  installTimeoutMs?: number | undefined;
  loginTimeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
}

/** Installs agent CLIs into a private prefix and runs their own browser sign-in. Never reads credentials. */
export class AgentCliManager {
  /** Full (unstripped) sign-in URL per agent; kept in memory only, never emitted or persisted. */
  private readonly pendingLogin = new Map<AgentId, string>();

  constructor(private readonly deps: AgentCliDeps) {}

  private get spawn(): SpawnFn {
    return this.deps.spawn ?? defaultSpawn;
  }
  private get killTree(): KillTreeFn {
    return this.deps.killTree ?? defaultKillTree;
  }

  hasNpm(): Promise<boolean> {
    return this.findNpm().then(Boolean);
  }

  private findNpm(): Promise<string | null> {
    return this.deps.resolveNpm ? this.deps.resolveNpm() : resolveBinary("npm", buildEnv(this.deps.env));
  }

  async install(agent: AgentId, signal?: AbortSignal): Promise<AgentInstallResult> {
    const adapter = this.deps.adapters().get(agent);
    const pkg = adapter?.npmPackage;
    const root = this.deps.runtimeRoot();
    if (!adapter || !pkg || !root) {
      return { ok: false, code: "unsupported", message: "This agent can't be installed from inside the app." };
    }
    const npm = await this.findNpm();
    if (!npm) return { ok: false, code: "no_npm", message: "Node.js isn't available yet." };
    const prefix = agentToolsDir(root);
    await fs.ensureDir(prefix);
    const log = (line: string): void => this.deps.emit({ kind: "agent-install-log", agent, line: redactUrls(line) });
    log(`Installing ${pkg} into the app's private folder`);
    const res = await runStreaming(this.spawn, this.killTree, {
      command: npm,
      args: buildInstallArgs(prefix, pkg),
      env: buildEnv(this.deps.env),
      cwd: os.tmpdir(),
      timeoutMs: this.deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      signal,
      onLine: log,
      killGraceMs: this.deps.killGraceMs ?? 3000,
    });
    if (res.cancelled) return { ok: false, code: "cancelled", message: "Install stopped." };
    if (res.timedOut) return { ok: false, code: "timeout", message: "The install took too long and was stopped." };
    if (res.spawnError || res.code !== 0) {
      return { ok: false, code: "failed", message: res.spawnError ?? `npm exited with code ${res.code}. Check your connection and try again.` };
    }
    const version = await readInstalledVersion(prefix, pkg);
    const binPath = await resolveBinary(adapter.binary, { PATH: agentBinDirFor(root) });
    log(version ? `Installed ${pkg} ${version}` : `Installed ${pkg}`);
    return { ok: true, version, binPath };
  }

  /** Spawn the CLI's own sign-in (it opens the user's browser). No shell, no stdin, 5-minute cap, cancellable. */
  async login(agent: AgentId, signal?: AbortSignal): Promise<AgentLoginResult> {
    const adapter = this.deps.adapters().get(agent);
    const args = adapter?.loginArgs?.();
    if (!adapter || !args) return { ok: false, code: "unsupported", message: "This agent has no in-app sign-in." };
    const bin = this.deps.resolveBin ? await this.deps.resolveBin(adapter.binary) : await resolveBinary(adapter.binary, buildEnv(this.deps.env));
    if (!bin) return { ok: false, code: "not_installed", message: `${adapter.displayName} isn't installed.` };
    this.pendingLogin.delete(agent);
    const log = (line: string): void => {
      for (const url of extractUrls(line)) {
        if (!isAllowedLoginUrl(url)) continue;
        this.pendingLogin.set(agent, url);
        this.deps.emit({ kind: "agent-login-url", agent, url: stripUrlQuery(url) });
      }
      this.deps.emit({ kind: "agent-login-log", agent, line: redactUrls(line) });
    };
    const manual = adapter.manualLogin ? ` Run \`${adapter.manualLogin}\` in a terminal instead.` : "";
    try {
      const res = await runStreaming(this.spawn, this.killTree, {
        command: bin,
        args,
        env: agentEnv(buildEnv(this.deps.env)),
        cwd: os.tmpdir(),
        timeoutMs: this.deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
        signal,
        onLine: log,
        killGraceMs: this.deps.killGraceMs ?? 3000,
      });
      if (res.cancelled) return { ok: false, code: "cancelled", message: "Sign-in stopped." };
      if (res.timedOut) return { ok: false, code: "timeout", message: `Sign-in timed out after 5 minutes.${manual}` };
      if (res.spawnError || res.code !== 0) {
        return { ok: false, code: "failed", message: `Sign-in couldn't complete here (it may need an interactive terminal).${manual}` };
      }
      return { ok: true };
    } finally {
      this.pendingLogin.delete(agent);
    }
  }

  /** Runs the CLI's own sign-out. Never throws; `command` is the terminal fallback when the app could not do it. */
  async logout(agent: AgentId): Promise<{ ok: true } | { ok: false; command: string }> {
    const adapter = this.deps.adapters().get(agent);
    const args = adapter?.logoutArgs?.();
    const command = adapter?.manualLogout ?? `${adapter?.binary ?? agent} logout`;
    if (!adapter || !args) return { ok: false, command };
    try {
      const bin = this.deps.resolveBin ? await this.deps.resolveBin(adapter.binary) : await resolveBinary(adapter.binary, buildEnv(this.deps.env));
      if (!bin) return { ok: true };
      const res = await runStreaming(this.spawn, this.killTree, {
        command: bin,
        args,
        env: agentEnv(buildEnv(this.deps.env)),
        cwd: os.tmpdir(),
        timeoutMs: 30_000,
        signal: undefined,
        onLine: () => undefined,
        killGraceMs: this.deps.killGraceMs ?? 3000,
      });
      return res.spawnError || res.cancelled || res.timedOut || res.code !== 0 ? { ok: false, command } : { ok: true };
    } catch {
      return { ok: false, command };
    }
  }

  /** The full URL for the main process to open (after re-validating); null if none is pending. */
  pendingLoginUrl(agent: AgentId): string | null {
    const url = this.pendingLogin.get(agent);
    return url && isAllowedLoginUrl(url) ? url : null;
  }
}

async function readInstalledVersion(prefix: string, pkg: string): Promise<string | null> {
  try {
    const json = (await fs.readJson(path.join(prefix, "node_modules", ...pkg.split("/"), "package.json"))) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}
