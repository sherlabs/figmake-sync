import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";

import fs from "fs-extra";

import { extractZipSafely } from "../utils/archive.js";

/**
 * App-managed Node runtime. Everything lives under <runtimeRoot>/node-v<version>/ (runtimeRoot is
 * <userData>/runtime). No sudo, no PATH/profile edits, no global npm prefix. This is an isolated,
 * checksum-verified private install, NOT an OS sandbox.
 */

/** Used only when nodejs.org/dist/index.json cannot be fetched. */
export const FALLBACK_NODE_VERSION = "v24.21.0";
export const NODE_DIST_BASE = "https://nodejs.org/dist";
export const COMPLETE_MARKER = ".complete";

export type RuntimeErrorCode = "offline" | "http" | "checksum" | "unsupported" | "extract" | "install" | "cancelled";

export class RuntimeInstallError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeInstallError";
  }
}

export type RuntimePhase = "resolving" | "downloading" | "verifying" | "extracting" | "installing-pnpm" | "done";

export interface RuntimeProgress {
  phase: RuntimePhase;
  message: string;
  percent?: number;
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type RunFn = (
  command: string,
  args: string[],
  opts: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
) => Promise<RunResult>;

export interface InstallOptions {
  /** <userData>/runtime */
  runtimeRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchFn?: FetchFn;
  run?: RunFn;
  signal?: AbortSignal;
  onProgress?: (p: RuntimeProgress) => void;
}

// ---- asset selection ------------------------------------------------------

export interface NodeAsset {
  /** e.g. node-v22.1.0-darwin-arm64 */
  dirName: string;
  fileName: string;
  kind: "tar" | "zip";
}

export function nodeAssetFor(version: string, platform: NodeJS.Platform, arch: string): NodeAsset | null {
  const plat = platform === "darwin" ? "darwin" : platform === "win32" ? "win" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!plat || !cpu) return null;
  if (plat === "win" && cpu !== "x64" && cpu !== "arm64") return null;
  if (plat === "linux" && cpu !== "x64") return null;
  const dirName = `node-${version}-${plat}-${cpu}`;
  if (plat === "win") return { dirName, fileName: `${dirName}.zip`, kind: "zip" };
  if (plat === "darwin") return { dirName, fileName: `${dirName}.tar.gz`, kind: "tar" };
  return { dirName, fileName: `${dirName}.tar.xz`, kind: "tar" };
}

interface IndexEntry {
  version: string;
  lts: string | false;
}

/** Latest entry with a truthy `lts` (index.json is newest-first, but sort defensively). */
export function pickLtsVersion(index: unknown): string | null {
  if (!Array.isArray(index)) return null;
  const entries = (index as IndexEntry[]).filter(
    (e) => e && typeof e.version === "string" && /^v\d+\.\d+\.\d+$/.test(e.version) && e.lts,
  );
  const parse = (v: string): number[] => v.slice(1).split(".").map(Number);
  entries.sort((a, b) => {
    const pa = parse(a.version);
    const pb = parse(b.version);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  });
  return entries[0]?.version ?? null;
}

export async function resolveNodeVersion(
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<{ version: string; fallback: boolean }> {
  try {
    const res = await fetchFn(`${NODE_DIST_BASE}/index.json`, signal ? { signal } : {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const version = pickLtsVersion(await res.json());
    if (version) return { version, fallback: false };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    void error;
  }
  return { version: FALLBACK_NODE_VERSION, fallback: true };
}

export function parseShasums(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === fileName) return m[1]!.toLowerCase();
  }
  return null;
}

// ---- safe extraction ------------------------------------------------------

/** Reject absolute paths, drive letters, backslash tricks and `..` segments in archive entry names. */
export function validateArchiveEntries(names: string[]): void {
  for (const raw of names) {
    const name = raw.replace(/\r$/, "");
    if (!name) continue;
    const segments = name.split(/[\\/]/);
    if (
      name.startsWith("/") ||
      name.startsWith("\\") ||
      /^[a-zA-Z]:/.test(name) ||
      name.includes("\0") ||
      segments.includes("..")
    ) {
      throw new RuntimeInstallError("extract", `Unsafe path in archive: ${JSON.stringify(name)}`);
    }
  }
}

/** After extraction: every symlink must resolve inside root; only files, dirs and symlinks allowed. */
export async function assertTreeContained(root: string): Promise<void> {
  const rootReal = await fs.realpath(root);
  const inside = (p: string): boolean => {
    const rel = path.relative(rootReal, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const walk = async (dir: string): Promise<void> => {
    for (const name of await fs.readdir(dir)) {
      const full = path.join(dir, name);
      const st = await fs.lstat(full);
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(full);
        const resolved = path.resolve(path.dirname(full), target);
        // Resolve through any intermediate symlinks that already exist.
        let real = resolved;
        try {
          real = await fs.realpath(resolved);
        } catch {
          // dangling inside the tree is fine as long as the lexical target is inside
        }
        if (path.isAbsolute(target) || !inside(resolved) || !inside(real)) {
          throw new RuntimeInstallError("extract", `Archive symlink escapes install dir: ${name} -> ${target}`);
        }
      } else if (st.isDirectory()) {
        await walk(full);
      } else if (!st.isFile()) {
        throw new RuntimeInstallError("extract", `Unexpected special file in archive: ${name}`);
      }
    }
  };
  await walk(rootReal);
}

// ---- process helper -------------------------------------------------------

export const defaultRun: RunFn = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    let child;
    try {
      child = isWinCmd
        ? spawn([command, ...args].map((a) => `"${a}"`).join(" "), [], {
            cwd: opts.cwd,
            env: opts.env,
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const killIt = (): void => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      killIt();
      finish(() => reject(new Error(`${path.basename(command)} timed out`)));
    }, opts.timeoutMs ?? 10 * 60_000);
    const onAbort = (): void => {
      killIt();
      finish(() => reject(cancelled()));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => (stdout = (stdout + c.toString()).slice(-16384)));
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-16384)));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });

function cancelled(): RuntimeInstallError {
  return new RuntimeInstallError("cancelled", "Install cancelled.");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

// ---- layout ---------------------------------------------------------------

export function nodeInstallDir(runtimeRoot: string, version: string): string {
  return path.join(runtimeRoot, `node-${version}`);
}

function versionParts(dirName: string): number[] {
  return dirName
    .replace(/^node-v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
}

/** Highest fully-installed node-v* dir (has .complete marker), or null. Sync: used when building child envs. */
export function findManagedInstall(runtimeRoot: string): { dir: string; version: string } | null {
  let names: string[];
  try {
    names = fsSync.readdirSync(runtimeRoot).filter((n) => /^node-v\d+\.\d+\.\d+$/.test(n));
  } catch {
    return null;
  }
  const complete = names.filter((n) => fsSync.existsSync(path.join(runtimeRoot, n, COMPLETE_MARKER)));
  complete.sort((a, b) => {
    const pa = versionParts(a);
    const pb = versionParts(b);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  });
  const best = complete[0];
  return best ? { dir: path.join(runtimeRoot, best), version: best.slice(5) } : null;
}

export function binDirsFor(installDir: string, platform: NodeJS.Platform = process.platform): string[] {
  const toolsBin = path.join(installDir, "tools", "node_modules", ".bin");
  return platform === "win32" ? [installDir, toolsBin] : [path.join(installDir, "bin"), toolsBin];
}

// Registry of the managed root; set once by the Electron main process. Never mutates process.env.
let managedRoot: string | null = null;
export function setManagedRuntimeRoot(root: string | null): void {
  managedRoot = root;
}
export function getManagedRuntimeRoot(): string | null {
  return managedRoot;
}

/** Bin dirs to append (AFTER system PATH) for spawned children; [] when nothing is installed. */
export function getManagedBinDirs(runtimeRoot: string | null = managedRoot): string[] {
  if (!runtimeRoot) return [];
  const found = findManagedInstall(runtimeRoot);
  return found ? binDirsFor(found.dir) : [];
}

/** The app's private pnpm (installed beside the managed Node): bin dirs to put FIRST on PATH, plus its content store. */
export function getManagedPnpm(runtimeRoot: string | null = managedRoot): { binDirs: string[]; storeDir: string } | null {
  if (!runtimeRoot) return null;
  const found = findManagedInstall(runtimeRoot);
  if (!found) return null;
  const dirs = binDirsFor(found.dir);
  const win = process.platform === "win32";
  if (!fsSync.existsSync(path.join(dirs[1]!, win ? "pnpm.cmd" : "pnpm"))) return null;
  return { binDirs: dirs, storeDir: path.join(runtimeRoot, "pnpm-store") };
}

/** Private npm prefix holding agent CLIs (Claude Code / Codex); lives inside <userData>/runtime so "remove runtime" deletes it. */
export function agentToolsDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "tools-agents");
}

export function agentBinDirFor(runtimeRoot: string): string {
  return path.join(agentToolsDir(runtimeRoot), "node_modules", ".bin");
}

/** Private agent CLI bin dir (only when it exists). Appended AFTER system and managed-Node dirs. */
export function getAgentBinDirs(runtimeRoot: string | null = managedRoot): string[] {
  if (!runtimeRoot) return [];
  const dir = agentBinDirFor(runtimeRoot);
  return fsSync.existsSync(dir) ? [dir] : [];
}

/** Copy of env with managed dirs appended after the existing PATH (system tools win). Never mutates `base`. */
export function withManagedPath(base: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  if (dirs.length === 0) return { ...base };
  const existing = (base["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...existing, ...dirs.filter((d) => !existing.includes(d))];
  return { ...base, PATH: merged.join(path.delimiter) };
}

// ---- install --------------------------------------------------------------

export interface ManagedInstallResult {
  version: string;
  dir: string;
  nodeVersion: string | null;
  npmVersion: string | null;
  pnpmVersion: string | null;
  usedFallbackVersion: boolean;
  /** true when Node was already installed and only missing pieces were done */
  alreadyInstalled: boolean;
}

function networkMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? msg;
  return `Could not reach nodejs.org (${detail}). Check your internet connection, VPN or proxy and try again. If your network blocks the download, install Node.js manually from nodejs.org.`;
}

async function getText(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new RuntimeInstallError("offline", networkMessage(error));
  }
  if (!res.ok) throw new RuntimeInstallError("http", `nodejs.org answered ${res.status} for ${url}.`);
  return res.text();
}

async function downloadToFile(
  fetchFn: FetchFn,
  url: string,
  dest: string,
  signal: AbortSignal | undefined,
  onPercent: (percent: number | undefined, received: number) => void,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new RuntimeInstallError("offline", networkMessage(error));
  }
  if (!res.ok || !res.body) throw new RuntimeInstallError("http", `nodejs.org answered ${res.status} for the download.`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  await fs.ensureDir(path.dirname(dest));
  const out = fsSync.createWriteStream(dest);
  let received = 0;
  try {
    const reader = res.body.getReader();
    signal?.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      onPercent(total ? Math.min(99, Math.floor((received / total) * 100)) : undefined, received);
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  } catch (error) {
    out.destroy();
    if (signal?.aborted) throw cancelled();
    if (error instanceof RuntimeInstallError) throw error;
    throw new RuntimeInstallError("offline", networkMessage(error));
  }
  return hash.digest("hex");
}

async function extractArchive(
  asset: NodeAsset,
  archive: string,
  stagingDir: string,
  run: RunFn,
  signal?: AbortSignal,
): Promise<void> {
  if (asset.kind === "zip") {
    await extractZipSafely(archive, stagingDir); // zip-slip guarded (assertPathInsideRoot)
  } else {
    const list = await run("tar", ["-tf", archive], { signal });
    if (list.code !== 0) throw new RuntimeInstallError("extract", `tar could not read the archive: ${list.stderr.trim()}`);
    validateArchiveEntries(list.stdout.split("\n"));
    await fs.ensureDir(stagingDir);
    const x = await run("tar", ["-xf", archive, "-C", stagingDir], { signal });
    if (x.code !== 0) throw new RuntimeInstallError("extract", `tar failed: ${x.stderr.trim()}`);
  }
  await assertTreeContained(stagingDir);
}

function parseVersionOutput(out: string): string | null {
  const m = /v?(\d+\.\d+\.\d+)/.exec(out);
  return m ? m[1]! : null;
}

export async function installManagedRuntime(opts: InstallOptions): Promise<ManagedInstallResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const run = opts.run ?? defaultRun;
  const { signal, runtimeRoot } = opts;
  const emit = (p: RuntimeProgress): void => opts.onProgress?.(p);

  emit({ phase: "resolving", message: "Looking up the current Node.js LTS release" });
  throwIfAborted(signal);

  // Reuse a complete install when present (idempotent: only finish what's missing).
  const existing = findManagedInstall(runtimeRoot);
  let version: string;
  let fallback = false;
  if (existing) {
    version = existing.version.startsWith("v") ? existing.version : `v${existing.version}`;
  } else {
    ({ version, fallback } = await resolveNodeVersion(fetchFn, signal));
  }
  const asset = nodeAssetFor(version, platform, arch);
  if (!asset) {
    throw new RuntimeInstallError("unsupported", `No Node.js build is available for ${platform}/${arch}. Install Node.js manually from nodejs.org.`);
  }
  const installDir = nodeInstallDir(runtimeRoot, version);
  const alreadyInstalled = Boolean(existing);

  if (!existing) {
    const tmpId = randomBytes(6).toString("hex");
    const partFile = path.join(runtimeRoot, ".downloads", `${asset.fileName}.${tmpId}.part`);
    const stagingDir = path.join(runtimeRoot, `.staging-${tmpId}`);
    try {
      const shasums = await getText(fetchFn, `${NODE_DIST_BASE}/${version}/SHASUMS256.txt`, signal);
      const expected = parseShasums(shasums, asset.fileName);
      if (!expected) throw new RuntimeInstallError("checksum", `nodejs.org published no checksum for ${asset.fileName}; refusing to install.`);

      emit({ phase: "downloading", message: `Downloading Node.js ${version}`, percent: 0 });
      const actual = await downloadToFile(
        fetchFn,
        `${NODE_DIST_BASE}/${version}/${asset.fileName}`,
        partFile,
        signal,
        (percent) => emit({ phase: "downloading", message: `Downloading Node.js ${version}`, ...(percent !== undefined ? { percent } : {}) }),
      );

      emit({ phase: "verifying", message: "Verifying the SHA-256 checksum" });
      if (actual !== expected) {
        throw new RuntimeInstallError("checksum", "The downloaded file did not match nodejs.org's published SHA-256 checksum, so it was discarded. Nothing was installed.");
      }
      throwIfAborted(signal);

      emit({ phase: "extracting", message: "Unpacking" });
      await extractArchive(asset, partFile, stagingDir, run, signal);
      const top = path.join(stagingDir, asset.dirName);
      if (!(await fs.pathExists(top))) throw new RuntimeInstallError("extract", "The archive had an unexpected layout.");
      await fs.remove(installDir); // a dir without .complete is never trusted
      await fs.ensureDir(runtimeRoot);
      await fs.rename(top, installDir);
    } catch (error) {
      await fs.remove(installDir).catch(() => undefined);
      throw error;
    } finally {
      await fs.remove(partFile).catch(() => undefined);
      await fs.remove(stagingDir).catch(() => undefined);
    }
    // Smoke test before declaring Node usable.
    const nodeBin = path.join(binDirsFor(installDir, platform)[0]!, platform === "win32" ? "node.exe" : "node");
    const smoke = await run(nodeBin, ["--version"], { signal, timeoutMs: 20_000 }).catch((e: unknown) => {
      if (signal?.aborted) throw cancelled();
      throw new RuntimeInstallError("extract", `The downloaded Node.js would not start: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (smoke.code !== 0 || parseVersionOutput(smoke.stdout) !== version.slice(1)) {
      await fs.remove(installDir).catch(() => undefined);
      throw new RuntimeInstallError("extract", "The downloaded Node.js did not report the expected version.");
    }
    await fs.writeFile(path.join(installDir, COMPLETE_MARKER), `${version}\n`);
  }

  // pnpm into <install>/tools with the managed npm; its cache is inside too (nothing in ~/.npm).
  const bins = binDirsFor(installDir, platform);
  const env = withManagedPath({ ...process.env }, []);
  env["PATH"] = [bins[0]!, env["PATH"] ?? ""].filter(Boolean).join(path.delimiter);
  const pnpmBin = path.join(bins[1]!, platform === "win32" ? "pnpm.cmd" : "pnpm");
  if (!(await fs.pathExists(pnpmBin))) {
    emit({ phase: "installing-pnpm", message: "Installing pnpm with the private npm" });
    const npmBin = path.join(bins[0]!, platform === "win32" ? "npm.cmd" : "npm");
    const toolsDir = path.join(installDir, "tools");
    await fs.ensureDir(toolsDir);
    try {
      const r = await run(
        npmBin,
        ["install", "--prefix", toolsDir, "--cache", path.join(installDir, ".npm-cache"), "--no-audit", "--no-fund", "pnpm"],
        { cwd: toolsDir, env, signal },
      );
      if (r.code !== 0) {
        throw new RuntimeInstallError("install", `Node.js is installed, but pnpm could not be installed (${r.stderr.trim().split("\n").pop() ?? "npm failed"}). Check your connection and try again.`);
      }
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    }
  }

  await fs.remove(path.join(installDir, ".npm-cache")).catch(() => undefined); // only needed during the install
  const versions = await probeVersions(bins, env, run, platform);
  emit({ phase: "done", message: "Private runtime ready", percent: 100 });
  return { version, dir: installDir, ...versions, usedFallbackVersion: fallback, alreadyInstalled };
}

async function probeVersions(
  bins: string[],
  env: NodeJS.ProcessEnv,
  run: RunFn,
  platform: NodeJS.Platform,
): Promise<{ nodeVersion: string | null; npmVersion: string | null; pnpmVersion: string | null }> {
  const exe = (dir: string, name: string, win: string): string => path.join(dir, platform === "win32" ? win : name);
  const get = async (cmd: string): Promise<string | null> => {
    try {
      const r = await run(cmd, ["--version"], { env, timeoutMs: 20_000 });
      return r.code === 0 ? parseVersionOutput(r.stdout) : null;
    } catch {
      return null;
    }
  };
  const [nodeVersion, npmVersion, pnpmVersion] = await Promise.all([
    get(exe(bins[0]!, "node", "node.exe")),
    get(exe(bins[0]!, "npm", "npm.cmd")),
    get(exe(bins[1]!, "pnpm", "pnpm.cmd")),
  ]);
  return { nodeVersion, npmVersion, pnpmVersion };
}

// ---- detection (system first, then managed) -------------------------------

export type ToolSource = "system" | "managed" | "missing";
export interface ToolStatus {
  source: ToolSource;
  version: string | null;
}
export interface RuntimeStatus {
  node: ToolStatus;
  npm: ToolStatus;
  pnpm: ToolStatus;
  managed: { installed: boolean; version: string | null; dir: string | null };
}

export async function detectRuntime(opts: {
  runtimeRoot: string;
  /** PATH-augmented env WITHOUT managed dirs, so a working system tool wins. */
  systemEnv: NodeJS.ProcessEnv;
  run?: RunFn;
  platform?: NodeJS.Platform;
}): Promise<RuntimeStatus> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const found = findManagedInstall(opts.runtimeRoot);
  const bins = found ? binDirsFor(found.dir, platform) : [];
  const managedEnv = withManagedPath({ ...opts.systemEnv, PATH: [...bins, opts.systemEnv["PATH"] ?? ""].filter(Boolean).join(path.delimiter) }, []);

  const probeOne = async (name: "node" | "npm" | "pnpm"): Promise<ToolStatus> => {
    const winName = name === "node" ? "node.exe" : `${name}.cmd`;
    const sysCmds = platform === "win32" ? (name === "node" ? ["node.exe", "node"] : [`${name}.cmd`, `${name}.exe`]) : [name];
    for (const cmd of sysCmds) {
      try {
        const r = await run(cmd, ["--version"], { env: opts.systemEnv, timeoutMs: 6000 });
        const v = r.code === 0 ? parseVersionOutput(r.stdout) : null;
        if (v) return { source: "system", version: v };
      } catch {
        // not found / not working: try next
      }
    }
    if (bins.length) {
      const dir = name === "pnpm" ? bins[1]! : bins[0]!;
      const cmd = path.join(dir, platform === "win32" ? winName : name);
      try {
        const r = await run(cmd, ["--version"], { env: managedEnv, timeoutMs: 10_000 });
        const v = r.code === 0 ? parseVersionOutput(r.stdout) : null;
        if (v) return { source: "managed", version: v };
      } catch {
        // fall through
      }
    }
    return { source: "missing", version: null };
  };

  const [node, npm, pnpm] = await Promise.all([probeOne("node"), probeOne("npm"), probeOne("pnpm")]);
  return {
    node,
    npm,
    pnpm,
    managed: { installed: Boolean(found), version: found?.version ?? null, dir: found?.dir ?? null },
  };
}

/** Delete the whole private runtime (the only thing this module ever writes). */
export async function removeManagedRuntime(runtimeRoot: string): Promise<boolean> {
  if (path.basename(runtimeRoot) !== "runtime") {
    throw new Error("Refusing to remove a directory that is not named 'runtime'.");
  }
  const existed = await fs.pathExists(runtimeRoot);
  await fs.remove(runtimeRoot);
  return existed;
}
