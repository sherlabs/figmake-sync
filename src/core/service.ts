import path from "node:path";

import { diffLines } from "diff";
import fs from "fs-extra";
import { spawn } from "node:child_process";

import type { Logger } from "pino";

import { createTextPatchPreview } from "../diff/changes.js";
import { mergeText } from "../diff/mergeText.js";
import {
  buildThreeWayMergeFoundation,
  createManifest,
  diffManifests,
  excludePaths,
  hasManifestChanges,
  summarizeManifestDiff,
  type ManifestDiff,
  type ManifestEntry,
  type SnapshotManifest,
} from "../diff/manifest.js";
import {
  createPlaywrightAdapter,
  type AdapterContext,
  type AdapterFactory,
  type ExplorerSnapshot,
  type FigmaMakeAdapter,
  type FigmaMakeProjectSession,
} from "../figma/adapter.js";
import {
  buildPushPlan,
  pushMessage,
  resolveDiverged,
  touchedPaths,
  validateLocalPlan,
  type PlanInput,
  type PlannedOp,
  type PushBlock,
  type ShownOp,
} from "./push-plan.js";
import { withRetry } from "../utils/retry.js";
import { buildEnv } from "../harness/process.js";
import { getManagedPnpm } from "../runtime/managed.js";
import { createProjectLogger, flushLogger } from "../logging/logger.js";
import type {
  CommandRuntimeOptions,
  PushProgress,
  PullStrategy,
  ProjectConfig,
} from "../types/config.js";
import { renderPostUploadPrompt } from "../types/config.js";
import { extractZipSafely } from "../utils/archive.js";
import { confirmPrompt } from "../utils/prompt.js";
import { resolveRelativePath } from "../utils/path.js";
import {
  findProjectRoot,
  ProjectStateStore,
  type SyncMetadata,
  type ProjectStatePaths,
} from "./state.js";

export interface InitResult {
  rootDir: string;
  configPath: string;
  stateDir: string;
}

const MAX_DIFF_BYTES = 512 * 1024;

export interface ReviewFile {
  path: string;
  /** Old name, for a rename. */
  from?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
  /** The user chose not to send this file. */
  ignored: boolean;
}

export interface ReviewResult {
  files: ReviewFile[];
}

export type FileDiffResult =
  | { kind: "text"; before: string; after: string }
  | { kind: "binary" }
  | { kind: "large" }
  | { kind: "missing" };

export interface StatusResult {
  hasBaseline: boolean;
  diff?: ManifestDiff;
  summary: ReturnType<typeof summarizeManifestDiff>;
}

export interface PullResult {
  strategy: PullStrategy;
  extractedFiles: number;
  backupDir: string | undefined;
  dryRun: boolean;
  conflicts: string[];
  /** Files both sides edited that were combined line by line (merge strategy). */
  merged: string[];
  remoteSummary: ReturnType<typeof summarizeManifestDiff>;
}

export interface PushResult {
  dryRun: boolean;
  summary: ReturnType<typeof summarizeManifestDiff>;
  unresolved: Array<{
    path: string;
    reason: string;
    /** Stable code (EXPLORER_MISMATCH, WRITE_NOT_VERIFIED, STOPPED, ...). */
    code?: string;
  }>;
  /** Paths changed remotely since last pull that push would overwrite (or skipped if not confirmed). */
  remoteDiverged?: string[];
  /** "skipped" = the push stopped before the remote zip was needed (local refusal); otherwise the zip was checked. */
  remoteCheck?: "ok" | "skipped";
  /**
   * The push stopped cleanly. "preflight": nothing was written to Figma. "sending": every file before this one is
   * verified and in the baseline; `remaining` files are still waiting and the next push resumes with them.
   */
  stopped?: { phase: "preflight" | "sending"; code: string; message: string; remaining: number };
  /** Files whose content the final zip download confirmed. */
  verified?: number;
  /** "ok" = the final zip compare ran; "skipped" = nothing was sent or the download failed (logged). */
  verifyCheck?: "ok" | "skipped";
  /** Files not part of this push that changed in Figma while it ran (reported, never touched). */
  remoteChanged?: string[];
}

/** An operation that did not verifiably happen, with a stable code for the message map. */
class PushOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PushOpError";
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code === "string") return code;

  return error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : undefined;
}

/** Retried from the precondition (never blindly): timeouts, overlays, a UI that briefly looks different, an unverified write. */
function isTransientPushError(error: unknown): boolean {
  const code = codeOf(error);

  if (code === undefined) return !(error instanceof PushOpError);

  return ["TIMEOUT", "UI_CHANGED", "SELECTOR_NOT_FOUND", "WRITE_NOT_VERIFIED", "AUTOMATION_ERROR"].includes(code);
}

function messageForError(error: unknown, relativePath: string): string {
  const code = codeOf(error);

  if (code === "LEFTOVER_FILE") {
    const e = error as { folder?: string; leftover?: string };

    return pushMessage(code, relativePath, { folder: e.folder ?? "", leftover: e.leftover ?? "new-file.tsx" });
  }

  if (code === "EXPLORER_MISMATCH" || code === "AMBIGUOUS_REMOTE_PATH") {
    return pushMessage(code, (error as { relativePath?: string }).relativePath ?? relativePath);
  }

  if (code !== undefined) return pushMessage(code, relativePath);

  return `${error instanceof Error ? error.message : String(error)} (${relativePath}). Nothing after it was sent.`;
}

export interface VerifyResult {
  /**
   * Remote-vs-local comparison, NOT baseline-relative: diff.added = local-only,
   * diff.deleted = remote-only, diff.modified = differs.
   */
  drift: StatusResult;
  direction: "remote-to-local";
  preview: string | undefined;
}

export type SignalOptions = CommandRuntimeOptions & { signal?: AbortSignal };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
}

const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Cross-platform `npm install` with timeout, abort support and bounded stderr capture. */
export async function runNpmInstall(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = NPM_INSTALL_TIMEOUT_MS,
  onLog?: (line: string) => void,
): Promise<void> {
  const pnpm = getManagedPnpm();
  if (!pnpm) return spawnInstall("npm", ["install", "--no-audit", "--no-fund"], buildEnv(), cwd, signal, timeoutMs, onLog);
  // The app's own pnpm: content-addressed store inside the app space (hard links, no per-project copies of every file).
  // hoisted layout = same node_modules shape npm makes, so projects that import transitive packages keep working.
  const env = buildEnv(undefined, { XDG_CACHE_HOME: path.join(pnpm.storeDir, "..", "pnpm-cache"), XDG_STATE_HOME: path.join(pnpm.storeDir, "..", "pnpm-state"), XDG_DATA_HOME: path.join(pnpm.storeDir, "..", "pnpm-data") });
  env["PATH"] = [...pnpm.binDirs, env["PATH"] ?? ""].join(path.delimiter);
  try {
    await spawnInstall("pnpm", ["install", "--no-frozen-lockfile", "--store-dir", pnpm.storeDir, "--node-linker=hoisted", "--reporter=append-only"], env, cwd, signal, timeoutMs, onLog);
  } catch (error) {
    if (signal?.aborted) throw error;
    onLog?.("pnpm could not finish; trying npm");
    await spawnInstall("npm", ["install", "--no-audit", "--no-fund"], buildEnv(), cwd, signal, timeoutMs, onLog);
  }
}

function spawnInstall(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    onLog?.(`$ ${command} ${args.join(" ")}`);
    const isWin = process.platform === "win32";
    // Fixed args only; shell is needed on Windows to resolve npm.cmd safely (no EINVAL).
    const child = spawn(command, args, {
      cwd,
      env,
      shell: isWin,
      stdio: ["ignore", onLog ? "pipe" : "ignore", "pipe"],
      windowsHide: true,
    });
    let stderrTail = "";
    let settled = false;
    const kill = (): void => {
      if (isWin && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGKILL");
      }
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`${command} install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      kill();
      finish(new Error(`${command} install cancelled`));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    let logPending = "";
    const emitLines = (chunk: Buffer): void => {
      if (!onLog) return;
      const parts = (logPending + chunk.toString()).split(/\r?\n/);
      logPending = parts.pop() ?? "";
      parts.filter((l) => l.trim()).forEach((l) => onLog(l));
    };
    child.stdout?.on("data", (chunk: Buffer) => emitLines(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      emitLines(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      finish(
        code === 0
          ? undefined
          : new Error(`${command} install exited with code ${code}: ${stderrTail}`),
      );
    });
  });
}

export interface ProjectInspection {
  rootDir: string;
  linked: boolean;
  config: ProjectConfig | null;
  metadata: SyncMetadata | null;
  hasBaseline: boolean;
  statusSummary: ReturnType<typeof summarizeManifestDiff>;
}

interface LoadedProjectContext {
  rootDir: string;
  config: ProjectConfig;
  store: ProjectStateStore;
  logger: Logger;
}

function notify(
  options: CommandRuntimeOptions | undefined,
  message: string,
): void {
  options?.progress?.(message);
}

/** Progress is cosmetic: a listener that throws never changes what the push does. */
function reportPush(
  options: CommandRuntimeOptions | undefined,
  progress: PushProgress,
): void {
  try {
    options?.onProgress?.(progress);
  } catch {
    // ignored on purpose
  }
}

function getConfirm(
  options: CommandRuntimeOptions | undefined,
): (message: string, defaultValue?: boolean) => Promise<boolean> {
  if (options?.yes) {
    return () => Promise.resolve(true);
  }

  return options?.confirm ?? confirmPrompt;
}

async function copyFileIfPresent(
  sourceDir: string,
  targetDir: string,
  relativePath: string,
): Promise<void> {
  const sourcePath = path.join(sourceDir, relativePath);

  if (!(await fs.pathExists(sourcePath))) {
    return;
  }

  const targetPath = path.join(targetDir, relativePath);

  await fs.ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
}

async function removeIfPresent(targetPath: string): Promise<void> {
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
  }
}

export class FigmakeSyncService {
  constructor(
    private readonly dependencies: {
      adapterFactory?: AdapterFactory;
      sharedBrowserProfileDir?: string;
    } = {},
  ) {}

  async init(
    figmaMakeUrl: string,
    localFolder?: string,
    options: CommandRuntimeOptions = {},
  ): Promise<InitResult> {
    const rootDir = path.resolve(
      localFolder ?? options.projectRoot ?? options.cwd ?? process.cwd(),
    );

    await fs.ensureDir(rootDir);

    const store = new ProjectStateStore(rootDir);
    await store.initializeProject(figmaMakeUrl);

    return {
      rootDir,
      configPath: store.paths.configPath,
      stateDir: store.paths.stateDir,
    };
  }

  async auth(options: CommandRuntimeOptions = {}): Promise<void> {
    const context = await this.loadProjectContext("auth", options);

    try {
      notify(options, "authenticating browser session");
      const adapter = this.createAdapter(context);

      await adapter.authenticate(
        context.config.figmaMakeUrl,
        options.waitForManualAction || options.autoDetectLogin
          ? {
              ...(options.waitForManualAction
                ? { waitForCompletion: options.waitForManualAction }
                : {}),
              ...(options.autoDetectLogin ? { autoDetect: true } : {}),
            }
          : undefined,
      );
      await context.store.updateMetadata({
        lastCommand: "auth",
      });
    } finally {
      await flushLogger(context.logger);
    }
  }

  async inspectProject(rootDir: string): Promise<ProjectInspection> {
    const resolvedRootDir = path.resolve(rootDir);
    const store = new ProjectStateStore(resolvedRootDir);

    if (!(await fs.pathExists(store.paths.configPath))) {
      return {
        rootDir: resolvedRootDir,
        linked: false,
        config: null,
        metadata: null,
        hasBaseline: false,
        statusSummary: {
          added: 0,
          modified: 0,
          deleted: 0,
          renamed: 0,
          total: 0,
        },
      };
    }

    const [config, metadata, baselineManifest] = await Promise.all([
      store.loadProjectConfig(),
      store.readMetadata(),
      store.readLastPullManifest(),
    ]);

    if (!baselineManifest) {
      return {
        rootDir: resolvedRootDir,
        linked: true,
        config,
        metadata,
        hasBaseline: false,
        statusSummary: {
          added: 0,
          modified: 0,
          deleted: 0,
          renamed: 0,
          total: 0,
        },
      };
    }

    const localManifest = await createManifest(resolvedRootDir, {
      ignore: config.sync.ignore,
    });
    const diff = diffManifests(
      excludePaths(baselineManifest, config.sync.userIgnore),
      excludePaths(localManifest, config.sync.userIgnore),
    );

    return {
      rootDir: resolvedRootDir,
      linked: true,
      config,
      metadata,
      hasBaseline: true,
      statusSummary: summarizeManifestDiff(diff),
    };
  }

  async status(options: CommandRuntimeOptions = {}): Promise<StatusResult> {
    const context = await this.loadProjectContext("status", options);

    try {
      const baselineManifest = await context.store.readLastPullManifest();

      if (!baselineManifest) {
        return {
          hasBaseline: false,
          summary: {
            added: 0,
            modified: 0,
            deleted: 0,
            renamed: 0,
            total: 0,
          },
        };
      }

      const localManifest = await createManifest(context.rootDir, {
        ignore: context.config.sync.ignore,
      });
      const diff = diffManifests(
        excludePaths(baselineManifest, context.config.sync.userIgnore),
        excludePaths(localManifest, context.config.sync.userIgnore),
      );

      return {
        hasBaseline: true,
        diff,
        summary: summarizeManifestDiff(diff),
      };
    } finally {
      await flushLogger(context.logger);
    }
  }

  async rebaseline(options: CommandRuntimeOptions = {}): Promise<{ filesSnapshotted: number }> {
    const context = await this.loadProjectContext("rebaseline", options);
    try {
      notify(options, "scanning local files for rebaseline…");
      const localManifest = await createManifest(context.rootDir, {
        ignore: context.config.sync.ignore,
      });
      notify(options, "writing new baseline snapshot…");
      await context.store.writeLastPullState(context.rootDir, localManifest);
      return { filesSnapshotted: localManifest.files.length };
    } finally {
      await flushLogger(context.logger);
    }
  }

  async pull(options: SignalOptions = {}): Promise<PullResult> {
    return this.performPull(options, {
      safeMode: false,
    });
  }

  async syncFromFigma(
    options: SignalOptions = {},
  ): Promise<PullResult> {
    return this.performPull(options, {
      safeMode: true,
    });
  }

  /**
   * Send local changes to Figma Make. Either everything verified lands, or the push stops BEFORE any write (preflight:
   * `stopped.phase === "preflight"`) or at an operation boundary (`stopped.phase === "sending"`) with the baseline
   * advanced only for verified operations, so the next push resumes exactly where this one stopped.
   */
  async push(
    options: SignalOptions & { requireRemoteCheck?: boolean } = {},
  ): Promise<PushResult> {
    const context = await this.loadProjectContext("push", options);
    const adapter = this.createAdapter(context);
    const baselineManifest = await context.store.readLastPullManifest();
    const signal = options.signal;

    if (!baselineManifest) {
      await flushLogger(context.logger);
      throw new Error(
        "Push requires an existing baseline. Run figmake-sync pull first.",
      );
    }

    let session: FigmaMakeProjectSession | undefined;
    const tempDirs: string[] = [];
    const onAbort = (): void => {
      void session?.close().catch(() => undefined);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      throwIfAborted(signal);

      // User-ignored files leave BOTH sides, so they are never sent and never look deleted.
      // `baselineManifest` stays whole: advanceBaseline keeps their baseline entries.
      const userIgnore = context.config.sync.userIgnore;
      const localManifest = excludePaths(
        await createManifest(context.rootDir, {
          ignore: context.config.sync.ignore,
        }),
        userIgnore,
      );
      const diff = diffManifests(
        excludePaths(baselineManifest, userIgnore),
        localManifest,
      );
      const summary = summarizeManifestDiff(diff);

      if (summary.total === 0 || options.dryRun) {
        return { dryRun: Boolean(options.dryRun), summary, unresolved: [] };
      }

      const local = new Map(localManifest.files.map((entry) => [entry.path, entry]));
      const base = new Map(baselineManifest.files.map((entry) => [entry.path, entry]));
      const touched = touchedPaths(diff);
      const unresolved: PushResult["unresolved"] = [];
      const startedAt = Date.now();
      const recordUnresolved = (): Promise<SyncMetadata> =>
        context.store.updateMetadata({
          lastPushAt: new Date().toISOString(),
          lastCommand: "push",
          unresolved: unresolved.map((entry) => ({
            operation: "push" as const,
            path: entry.path,
            reason: entry.reason,
            ...(entry.code ? { code: entry.code } : {}),
            recordedAt: new Date().toISOString(),
          })),
        });
      /** Preflight refusal: nothing was written, every blocked path is listed, the first one is the headline. */
      const stopBeforeWrites = async (blocked: PushBlock[], remoteCheck: "ok" | "skipped"): Promise<PushResult> => {
        for (const b of blocked) unresolved.push({ path: b.path, reason: b.message, code: b.code });
        await recordUnresolved();
        reportPush(options, {
          phase: "checking",
          index: 1,
          total: touched.length,
          completed: 0,
          percent: 0,
          startedAt,
          stopped: { code: blocked[0]!.code, message: blocked[0]!.message, remaining: touched.length },
        });

        return {
          dryRun: false,
          summary,
          unresolved,
          remoteCheck,
          stopped: { phase: "preflight", code: blocked[0]!.code, message: blocked[0]!.message, remaining: touched.length },
        };
      };

      // 0. What can never be sent is refused before the browser opens.
      const earlyBlocked = validateLocalPlan(diff, local);

      if (earlyBlocked.length > 0) {
        return await stopBeforeWrites(earlyBlocked, "skipped");
      }

      notify(options, "opening Figma Make file");
      session = await adapter.openProject(context.config.figmaMakeUrl, signal ? { signal } : {});
      throwIfAborted(signal);

      // 1. The zip is the existence/content oracle. Mandatory for every caller: without it nothing is sent.
      notify(options, "checking remote for changes");
      reportPush(options, { phase: "checking", index: 1, total: touched.length, completed: 0, percent: 0, startedAt, detail: "Checking Figma for newer changes" });

      let remoteManifest: SnapshotManifest;

      try {
        remoteManifest = await this.downloadRemoteManifest(context, session, tempDirs);
      } catch (error) {
        throwIfAborted(signal);
        context.logger.warn({ err: error }, "remote check failed; nothing was pushed");
        throw new Error(
          "Could not check Figma Make for newer changes, so nothing was pushed. Try again, or push manually.",
          { cause: error },
        );
      }

      const remote = new Map(remoteManifest.files.map((entry) => [entry.path, entry]));

      // 2. The explorer index is the clickability oracle (sessions without one leave row existence unknown).
      let explorer: ExplorerSnapshot | undefined;

      if (session.indexExplorer) {
        notify(options, "reading the file list");
        reportPush(options, { phase: "checking", index: 1, total: touched.length, completed: 0, percent: 0, startedAt, detail: "Reading Figma's file list" });

        try {
          explorer = await session.indexExplorer(touched);
        } catch (error) {
          throwIfAborted(signal);

          const code = codeOf(error);

          if (code === "TREE_INDEX_INCOMPLETE" || code === "EXPLORER_MISMATCH" || code === "UI_CHANGED" || code === "SELECTOR_NOT_FOUND") {
            const path = (error as { relativePath?: string }).relativePath ?? touched[0] ?? "";

            return await stopBeforeWrites([{ path, code: "EXPLORER_MISMATCH", message: pushMessage(code, path) }], "ok");
          }

          throw error;
        }
      }

      // 3. The plan: every op decided, nothing written yet.
      const planInput: PlanInput = { diff, baseline: base, local, remote, ...(explorer ? { explorer } : {}) };
      let plan = buildPushPlan(planInput);
      const remoteDiverged = plan.diverged;

      if (plan.blocked.length > 0) {
        return await stopBeforeWrites(plan.blocked, "ok");
      }

      if (remoteDiverged.length > 0) {
        const approved = await getConfirm(options)(
          `${remoteDiverged.length} file(s) changed in Figma Make since the last pull (${remoteDiverged.slice(0, 5).join(", ")}${remoteDiverged.length > 5 ? ", ..." : ""}). Overwrite them with local content?`,
          false,
        );
        const resolved = resolveDiverged(plan, planInput, approved);

        plan = resolved.plan;

        for (const divergedPath of resolved.skipped) {
          unresolved.push({
            path: divergedPath,
            reason: "Remote changed since last pull; skipped to avoid overwriting. Pull first.",
            code: "DIVERGED",
          });
        }

        if (approved) {
          // A diverged binary cannot be overwritten through the editor.
          for (const divergedPath of remoteDiverged) {
            if (!plan.ops.some((op) => op.path === divergedPath) && !plan.noops.some((op) => op.path === divergedPath)) {
              unresolved.push({ path: divergedPath, reason: pushMessage("UNSUPPORTED_BINARY_MODIFY", divergedPath), code: "UNSUPPORTED_BINARY_MODIFY" });
            }
          }
        }
      }

      throwIfAborted(signal);

      // 4. Execute: one operation at a time, baseline advanced right after each verified one.
      const total = plan.ops.length + plan.noops.length;
      let completed = 0;
      let running = baselineManifest;
      const emit = (
        phase: "sending" | "saving",
        extra: { op?: ShownOp; file?: string; finished?: PushProgress["finished"]; detail?: string; last?: boolean; stopped?: PushProgress["stopped"] } = {},
      ): void => {
        const ratio = total === 0 ? 1 : completed / total;
        const progress: PushProgress = {
          phase,
          index: Math.min(completed + 1, Math.max(total, 1)),
          total,
          completed,
          percent: extra.last ? 100 : Math.min(99, Math.floor(ratio * 100)),
          startedAt,
        };

        if (extra.op) progress.op = extra.op;
        if (extra.file) progress.file = extra.file;
        if (extra.finished) progress.finished = extra.finished;
        if (extra.detail) progress.detail = extra.detail;
        if (extra.stopped) progress.stopped = extra.stopped;

        reportPush(options, progress);
      };
      const finish = (file: string, op: ShownOp, ok: boolean, code?: string): void => {
        completed += 1;
        emit("sending", { finished: { file, op, ok, ...(code ? { code } : {}) } });
      };
      /** Bytes the baseline held for a path before this push touched it (for a rollback after the final check). */
      const preImages = new Map<string, { entry: ManifestEntry; content: Buffer }>();
      const rememberPreImage = async (relativePath: string): Promise<void> => {
        const entry = base.get(relativePath);

        if (!entry || preImages.has(relativePath)) return;

        const content = await context.store.readBaselineSnapshot(relativePath);

        if (content) preImages.set(relativePath, { entry, content });
      };
      const advance = async (upsert?: ManifestEntry, removal?: string): Promise<void> => {
        const { stale } = await context.store.advanceBaseline(context.rootDir, running, {
          upserts: upsert ? [upsert] : [],
          removals: removal ? [removal] : [],
        });

        if (stale.length > 0) {
          context.logger.warn({ paths: stale }, "file changed during push; left dirty for the next push");
        }

        const files = new Map(running.files.map((entry) => [entry.path, entry]));

        if (upsert && !stale.includes(upsert.path)) files.set(upsert.path, upsert);
        if (removal) files.delete(removal);

        running = { ...running, files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)) };
      };
      const done: PlannedOp[] = [];
      const doneSet = new Set<string>();
      let stopped: PushResult["stopped"];

      if (plan.ops.length > 0) {
        notify(options, "pushing changes");
      }

      for (const noop of plan.noops) {
        throwIfAborted(signal);

        if (noop.op === "delete") await advance(undefined, noop.path);
        else await advance(noop.entry);

        finish(noop.path, noop.op, true);
      }

      const stopAt = (index: number, op: PlannedOp, code: string, message: string, ops: PlannedOp[]): void => {
        unresolved.push({ path: op.path, reason: message, code });
        finish(op.path, op.shown, false, code);

        const rest = ops.slice(index + 1);

        for (const later of rest) {
          unresolved.push({ path: later.path, reason: pushMessage("STOPPED", op.path), code: "STOPPED" });
        }

        stopped = { phase: "sending", code, message, remaining: rest.length };
      };

      // Root-level binaries: one batched upload, verified per file by the explorer (and the final zip).
      const binaryOps = plan.ops.filter((op) => op.binary);
      const editorOps = plan.ops.filter((op) => !op.binary);

      if (binaryOps.length > 0) {
        throwIfAborted(signal);
        emit("sending", { op: "create", ...(binaryOps.length === 1 ? { file: binaryOps[0]!.path } : {}) });

        const upload = await session.uploadFiles(
          binaryOps.map((op) => resolveRelativePath(context.rootDir, op.path)),
          context.rootDir,
        );
        const uploadedSet = new Set(upload.uploaded);
        const reasons = new Map(upload.unresolved.map((entry) => [entry.path, entry.reason] as const));

        for (const [index, op] of binaryOps.entries()) {
          if (uploadedSet.has(op.path)) {
            await advance(op.entry);
            done.push(op);
            doneSet.add(op.path);
            finish(op.path, op.shown, true);
            continue;
          }

          stopAt(index, op, "UPLOAD_FAILED", reasons.get(op.path) ?? `${op.path} could not be uploaded. Nothing after it was sent.`, [...binaryOps, ...editorOps]);
          break;
        }
      }

      let deletesApproved: boolean | null = null;

      for (const [index, op] of editorOps.entries()) {
        if (stopped) break;

        throwIfAborted(signal);

        if (op.op === "delete") {
          if (op.counterpart && !doneSet.has(op.counterpart)) {
            unresolved.push({ path: op.path, reason: `Not deleted: rename destination ${op.counterpart} was not sent.`, code: "RENAME_TARGET_FAILED" });
            finish(op.path, op.shown, false, "RENAME_TARGET_FAILED");
            continue;
          }

          deletesApproved ??= await getConfirm(options)(
            `Delete ${editorOps.filter((o) => o.op === "delete").length} file(s) from the linked Figma Make project? Unsupported deletes will be left unresolved.`,
            false,
          );

          if (!deletesApproved) {
            unresolved.push({ path: op.path, reason: "Deletion skipped by user confirmation policy.", code: "DELETE_DECLINED" });
            finish(op.path, op.shown, false, "DELETE_DECLINED");
            continue;
          }
        }

        notify(options, `${op.op === "delete" ? "deleting" : op.op === "mkdir" ? "creating folder" : op.op === "create" ? "creating" : "updating"} ${op.path}`);
        emit("sending", { op: op.shown, file: op.path });

        try {
          if (op.op === "replace" || op.op === "delete") await rememberPreImage(op.path);

          await withRetry(() => this.executePushOp(session!, context, op), {
            attempts: 3,
            baseDelayMs: 1_000,
            maxDelayMs: 3_000,
            shouldRetry: (error) => !signal?.aborted && isTransientPushError(error),
          });

          if (op.op === "delete") await advance(undefined, op.path);
          else if (op.op !== "mkdir") await advance(op.entry);

          done.push(op);
          doneSet.add(op.path);
          finish(op.path, op.shown, true);
        } catch (error) {
          throwIfAborted(signal);

          const code = codeOf(error) ?? "PUSH_OP_FAILED";

          context.logger.error({ err: error, path: op.path, op: op.op, code }, "push stopped at an operation boundary");
          stopAt(index, op, code, messageForError(error, op.path), editorOps);
        }
      }

      const newlyCreated = done.filter((op) => op.op === "create").map((op) => op.path);
      const shouldPromptAfterUpload = options.prompt ?? context.config.adapter.promptAfterUpload;

      if (!stopped && shouldPromptAfterUpload && newlyCreated.length > 0) {
        notify(options, "sending contextual prompt");
        await session.submitPrompt(renderPostUploadPrompt(context.config.adapter.postUploadPromptTemplate, newlyCreated));
      }

      // 5. Final check: download the zip again and compare what was sent (and what was not touched) against it.
      let verified = 0;
      const remoteChanged: string[] = [];
      let verifyCheck: PushResult["verifyCheck"] = "skipped";

      if (done.length > 0) {
        notify(options, "checking against Figma");
        emit("saving", { detail: "Checking against Figma" });

        try {
          const after = await this.downloadRemoteManifest(context, session, tempDirs);
          const afterMap = new Map(after.files.map((entry) => [entry.path, entry]));
          const restores: Array<{ entry: ManifestEntry; content: Buffer }> = [];
          const removals: string[] = [];
          const touchedSet = new Set(touched);

          verifyCheck = "ok";

          for (const op of done) {
            const now = afterMap.get(op.path);

            if (op.op === "delete") {
              if (now === undefined) {
                verified += 1;
                continue;
              }

              const pre = preImages.get(op.path);

              if (pre) restores.push(pre);

              unresolved.push({ path: op.path, reason: pushMessage("NOT_SAVED", op.path), code: "NOT_SAVED" });
              continue;
            }

            const entry = op.entry!;
            const same = now !== undefined && (entry.isBinary ? now.contentHash === entry.contentHash : now.normalizedHash === entry.normalizedHash);

            if (same) {
              verified += 1;
              continue;
            }

            const code = now === undefined ? "NOT_SAVED" : "CHANGED_AFTER_SEND";
            const pre = preImages.get(op.path);

            if (pre) restores.push(pre);
            else removals.push(op.path);

            unresolved.push({ path: op.path, reason: pushMessage(code, op.path), code });
          }

          for (const [relativePath, entry] of afterMap) {
            if (!touchedSet.has(relativePath) && base.has(relativePath) && base.get(relativePath)!.contentHash !== entry.contentHash) remoteChanged.push(relativePath);
          }

          for (const relativePath of base.keys()) {
            if (!touchedSet.has(relativePath) && !afterMap.has(relativePath) && !userIgnore.includes(relativePath)) remoteChanged.push(relativePath);
          }

          if (restores.length > 0 || removals.length > 0) {
            await context.store.restoreBaselineEntries(running, { restores, removals });
            context.logger.warn({ restores: restores.map((r) => r.entry.path), removals }, "final check found sent files missing or changed in Figma; baseline rolled back for them");
          }

          if (remoteChanged.length > 0) {
            context.logger.warn({ paths: remoteChanged }, "files not part of this push changed in Figma meanwhile");
          }
        } catch (error) {
          throwIfAborted(signal);
          context.logger.warn({ err: error }, "final check against Figma could not run");
        }
      }

      await recordUnresolved();

      if (stopped) {
        emit("saving", { stopped: { code: stopped.code, message: stopped.message, remaining: stopped.remaining } });
      } else {
        completed = total;
        emit("saving", { last: true });
      }

      return {
        dryRun: false,
        summary,
        unresolved,
        remoteDiverged,
        remoteCheck: "ok",
        ...(stopped ? { stopped } : {}),
        verified,
        verifyCheck,
        ...(remoteChanged.length > 0 ? { remoteChanged: remoteChanged.sort() } : {}),
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await session?.close().catch(() => undefined);

      for (const tempDir of tempDirs) {
        await this.cleanupTransient(context, tempDir);
      }

      if (tempDirs.length === 0) await this.cleanupTransient(context, undefined);

      await flushLogger(context.logger);
    }
  }

  /** Downloads the project zip and builds its manifest in a temp dir (recorded for cleanup). */
  private async downloadRemoteManifest(
    context: LoadedProjectContext,
    session: FigmaMakeProjectSession,
    tempDirs: string[],
  ): Promise<SnapshotManifest> {
    const download = await session.downloadLatestCodeZip(context.store.paths.downloadsDir);
    const tempDir = await context.store.createTempDir("push-remote");

    tempDirs.push(tempDir);
    await extractZipSafely(download.zipPath, tempDir);

    return createManifest(tempDir, { ignore: context.config.sync.ignore });
  }

  /** Runs one planned operation through the session; throws (with a `code`) when it did not verifiably happen. */
  private async executePushOp(session: FigmaMakeProjectSession, context: LoadedProjectContext, op: PlannedOp): Promise<void> {
    switch (op.op) {
      case "mkdir": {
        if (!session.createFolder) {
          throw new PushOpError("UI_CHANGED", `Figma's file list has no folder ${op.path} and this session cannot create one.`);
        }

        await session.createFolder(op.path);
        return;
      }
      case "create": {
        const content = await fs.readFile(resolveRelativePath(context.rootDir, op.path), "utf8");

        if (session.createFile) await session.createFile(op.path, content);
        else await session.upsertFile(op.path, content);

        await session.commitPendingChanges();
        return;
      }
      case "replace": {
        const content = await fs.readFile(resolveRelativePath(context.rootDir, op.path), "utf8");

        await session.replaceFileContents(op.path, content, op.expectedNormalizedHash ? { expectedNormalizedHash: op.expectedNormalizedHash } : {});
        await session.commitPendingChanges();
        return;
      }
      case "delete": {
        const result = await session.deletePath(op.path);

        if (result.status !== "deleted") {
          throw new PushOpError(
            result.code ?? (result.status === "unsupported" ? "DELETE_UNSUPPORTED" : "DELETE_NOT_VERIFIED"),
            result.reason ?? `${op.path} could not be deleted in Figma.`,
          );
        }

        return;
      }
    }
  }

  /** Everything a push would look at: what would be sent, plus changed files the user chose not to send. */
  async reviewChanges(options: CommandRuntimeOptions = {}): Promise<ReviewResult> {
    const context = await this.loadProjectContext("review", options);

    try {
      const { files } = await this.reviewDiff(context);

      return { files: files.map((file) => file.item) };
    } finally {
      await flushLogger(context.logger);
    }
  }

  /** Before (last pull) and after (now) text of one changed file. Text only, size-capped. */
  async fileDiff(options: CommandRuntimeOptions & { path: string }): Promise<FileDiffResult> {
    const context = await this.loadProjectContext("file-diff", options);

    try {
      const found = (await this.reviewDiff(context)).files.find((file) => file.item.path === options.path);

      if (!found) {
        return { kind: "missing" };
      }

      if (found.binary) {
        return { kind: "binary" };
      }

      const read = async (base: string, relativePath: string | undefined): Promise<{ text: string } | "large"> => {
        if (relativePath === undefined) return { text: "" };
        const absolute = resolveRelativePath(base, relativePath);
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat) return { text: "" };
        if (stat.size > MAX_DIFF_BYTES) return "large";
        return { text: await fs.readFile(absolute, "utf8") };
      };
      const before = await read(context.store.paths.lastPullSnapshotDir, found.item.status === "added" ? undefined : (found.item.from ?? found.item.path));
      const after = await read(context.rootDir, found.item.status === "deleted" ? undefined : found.item.path);

      if (before === "large" || after === "large") {
        return { kind: "large" };
      }

      return { kind: "text", before: before.text, after: after.text };
    } finally {
      await flushLogger(context.logger);
    }
  }

  /** Saves the choice in the project's own config. Renames move together (old and new name). */
  async setIgnored(options: CommandRuntimeOptions & { path: string; ignored: boolean }): Promise<string[]> {
    const context = await this.loadProjectContext("set-ignored", options);

    try {
      const { renames } = await this.reviewDiff(context);
      const group = new Set<string>([options.path]);

      for (const rename of renames) {
        if (rename.from === options.path || rename.to === options.path) {
          group.add(rename.from);
          group.add(rename.to);
        }
      }

      const current = new Set(context.config.sync.userIgnore);

      for (const entry of group) {
        if (options.ignored) current.add(entry);
        else current.delete(entry);
      }

      const next = [...current].sort();

      await context.store.saveProjectConfig({
        ...context.config,
        sync: { ...context.config.sync, userIgnore: next },
      });

      return next;
    } finally {
      await flushLogger(context.logger);
    }
  }

  async listIgnored(options: CommandRuntimeOptions = {}): Promise<string[]> {
    const context = await this.loadProjectContext("list-ignored", options);

    try {
      return [...context.config.sync.userIgnore].sort();
    } finally {
      await flushLogger(context.logger);
    }
  }

  private async reviewDiff(context: LoadedProjectContext): Promise<{
    files: Array<{ item: ReviewFile; binary: boolean }>;
    renames: ManifestDiff["renamed"];
  }> {
    const baseline = await context.store.readLastPullManifest();

    if (!baseline) {
      return { files: [], renames: [] };
    }

    const local = await createManifest(context.rootDir, {
      ignore: context.config.sync.ignore,
    });
    const diff = diffManifests(baseline, local);
    const userIgnore = new Set(context.config.sync.userIgnore);
    const snapshot = context.store.paths.lastPullSnapshotDir;
    const countLines = async (
      beforePath: string | undefined,
      afterPath: string | undefined,
      binary: boolean,
    ): Promise<{ added: number; removed: number }> => {
      if (binary) return { added: 0, removed: 0 };
      const load = async (base: string, rel: string | undefined): Promise<string> => {
        if (rel === undefined) return "";
        const absolute = resolveRelativePath(base, rel);
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat || stat.size > MAX_DIFF_BYTES) return "";
        return fs.readFile(absolute, "utf8");
      };
      const parts = diffLines(await load(snapshot, beforePath), await load(context.rootDir, afterPath));
      let added = 0;
      let removed = 0;
      for (const part of parts) {
        if (part.added) added += part.count ?? 0;
        else if (part.removed) removed += part.count ?? 0;
      }
      return { added, removed };
    };
    const files: Array<{ item: ReviewFile; binary: boolean }> = [];

    for (const entry of diff.added) {
      files.push({ binary: entry.isBinary, item: { path: entry.path, status: "added", ignored: userIgnore.has(entry.path), ...(await countLines(undefined, entry.path, entry.isBinary)) } });
    }
    for (const entry of diff.modified) {
      const binary = entry.current.isBinary || entry.previous.isBinary;
      files.push({ binary, item: { path: entry.current.path, status: "modified", ignored: userIgnore.has(entry.current.path), ...(await countLines(entry.current.path, entry.current.path, binary)) } });
    }
    for (const entry of diff.deleted) {
      files.push({ binary: entry.isBinary, item: { path: entry.path, status: "deleted", ignored: userIgnore.has(entry.path), ...(await countLines(entry.path, undefined, entry.isBinary)) } });
    }
    const localByPath = new Map(local.files.map((entry) => [entry.path, entry]));
    for (const entry of diff.renamed) {
      const binary = localByPath.get(entry.to)?.isBinary ?? false;
      files.push({ binary, item: { path: entry.to, from: entry.from, status: "renamed", ignored: userIgnore.has(entry.to) || userIgnore.has(entry.from), ...(await countLines(entry.from, entry.to, binary)) } });
    }

    files.sort((left, right) => left.item.path.localeCompare(right.item.path));

    return { files, renames: diff.renamed };
  }

  private async cleanupTransient(
    context: LoadedProjectContext,
    tempDir: string | undefined,
  ): Promise<void> {
    if (tempDir) {
      await fs.remove(tempDir).catch(() => undefined);
    }

    await context.store.pruneDownloads(3).catch(() => undefined);
  }

  async verify(options: SignalOptions = {}): Promise<VerifyResult> {
    const context = await this.loadProjectContext("verify", options);
    const adapter = this.createAdapter(context);
    let session: FigmaMakeProjectSession | undefined;
    let tempDir: string | undefined;
    const signal = options.signal;
    const onAbort = (): void => {
      void session?.close().catch(() => undefined);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      throwIfAborted(signal);

      const localManifest = await createManifest(context.rootDir, {
        ignore: context.config.sync.ignore,
      });

      notify(options, "opening Figma Make file");
      session = await adapter.openProject(context.config.figmaMakeUrl, signal ? { signal } : {});
      throwIfAborted(signal);

      notify(options, "downloading latest code");
      const download = await session.downloadLatestCodeZip(
        context.store.paths.downloadsDir,
      );
      throwIfAborted(signal);
      tempDir = await context.store.createTempDir("verify-remote");

      await extractZipSafely(download.zipPath, tempDir);

      const remoteManifest = await createManifest(tempDir, {
        ignore: context.config.sync.ignore,
      });
      const diff = diffManifests(remoteManifest, localManifest);
      const summary = summarizeManifestDiff(diff);
      let preview: string | undefined;

      if (diff.modified.length > 0) {
        const firstModified = diff.modified[0];

        if (firstModified) {
          preview = await createTextPatchPreview(
            resolveRelativePath(tempDir, firstModified.current.path),
            resolveRelativePath(context.rootDir, firstModified.current.path),
            firstModified.current.path,
          );
        }
      }

      await context.store.updateMetadata({
        lastVerifyAt: new Date().toISOString(),
        lastCommand: "verify",
      });

      return {
        drift: {
          hasBaseline: (await context.store.readLastPullManifest()) !== null,
          diff,
          summary,
        },
        direction: "remote-to-local",
        preview,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await session?.close().catch(() => undefined);
      await this.cleanupTransient(context, tempDir);
      await flushLogger(context.logger);
    }
  }

  private async performPull(
    options: SignalOptions,
    behavior: {
      safeMode: boolean;
    },
  ): Promise<PullResult> {
    const context = await this.loadProjectContext(
      behavior.safeMode ? "sync-from-figma" : "pull",
      options,
    );
    const adapter = this.createAdapter(context);
    let session: FigmaMakeProjectSession | undefined;
    let remoteTempDir: string | undefined;
    const signal = options.signal;
    const onAbort = (): void => {
      void session?.close().catch(() => undefined);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      throwIfAborted(signal);

      const baselineManifest = await context.store.readLastPullManifest();
      const localManifest = await createManifest(context.rootDir, {
        ignore: context.config.sync.ignore,
      });
      const localDiff = baselineManifest
        ? diffManifests(baselineManifest, localManifest)
        : undefined;
      const hasLocalChanges = baselineManifest
        ? Boolean(localDiff && hasManifestChanges(localDiff))
        : localManifest.files.length > 0;
      const strategy =
        options.strategy ??
        (behavior.safeMode
          ? context.config.sync.safePullStrategy
          : ("backup" as PullStrategy));

      if (hasLocalChanges && strategy === "abort") {
        throw new Error(
          "Local changes detected. Re-run with --strategy backup or --strategy merge, or use sync-from-figma with an explicit strategy.",
        );
      }

      if (behavior.safeMode && hasLocalChanges) {
        notify(options, "local changes detected before safe pull");
      }

      notify(options, "opening Figma Make file");
      session = await adapter.openProject(context.config.figmaMakeUrl, signal ? { signal } : {});
      throwIfAborted(signal);

      notify(options, "downloading latest code");
      const download = await session.downloadLatestCodeZip(
        context.store.paths.downloadsDir,
      );
      throwIfAborted(signal);
      remoteTempDir = await context.store.createTempDir("remote-pull");
      const extractedFiles = await extractZipSafely(
        download.zipPath,
        remoteTempDir,
      );
      const remoteManifest = await createManifest(remoteTempDir, {
        ignore: context.config.sync.ignore,
      });
      const remoteSummary = baselineManifest
        ? summarizeManifestDiff(diffManifests(baselineManifest, remoteManifest))
        : summarizeManifestDiff(
            diffManifests(
              {
                schemaVersion: 1,
                createdAt: new Date().toISOString(),
                root: remoteTempDir,
                ignore: [],
                files: [],
              },
              remoteManifest,
            ),
          );

      if (options.dryRun) {
        return {
          strategy,
          extractedFiles: extractedFiles.length,
          backupDir: undefined,
          dryRun: true,
          conflicts: [],
          merged: [],
          remoteSummary,
        };
      }

      throwIfAborted(signal);

      let backupDir: string | undefined;
      const conflicts: string[] = [];
      const merged: string[] = [];

      if (hasLocalChanges) {
        const confirmAction = getConfirm(options);
        const approved = await confirmAction(
          strategy === "merge"
            ? "Merge remote changes into the local workspace using the last synced snapshot as the base?"
            : "Overwrite the local workspace with the downloaded Figma Make snapshot after taking a backup?",
          true,
        );

        if (!approved) {
          throw new Error(
            "Pull cancelled before modifying the local workspace.",
          );
        }
      }

      if (hasLocalChanges && (strategy === "backup" || (strategy === "merge" && baselineManifest))) {
        backupDir = await context.store.createBackup(
          "pre-pull",
          context.config.sync.ignore,
        );
      }

      if (strategy === "merge" && baselineManifest) {
        notify(options, "merging remote snapshot into local workspace");
        const mergeResult = await this.applyMergePlan(
          context.store.paths,
          baselineManifest,
          localManifest,
          remoteManifest,
          remoteTempDir,
          context.logger,
        );

        conflicts.push(...mergeResult.conflicts);
        merged.push(...mergeResult.merged);
      } else {
        if (hasLocalChanges && !backupDir) {
          backupDir = await context.store.createBackup(
          "pre-pull",
          context.config.sync.ignore,
        );
        }

        notify(options, "applying downloaded snapshot");
        await context.store.replaceWorkspaceFrom(remoteTempDir, {
          localManifest,
          remoteManifest,
        });
      }

      await context.store.writeLastPullState(remoteTempDir, remoteManifest);
      await context.store.updateMetadata({
        lastPullAt: new Date().toISOString(),
        lastDownloadedZip: download.zipPath,
        lastCommand: behavior.safeMode ? "sync-from-figma" : "pull",
        unresolved: conflicts.map((relativePath) => ({
          operation: "pull" as const,
          path: relativePath,
          reason: "Merge conflict preserved locally for manual review.",
          recordedAt: new Date().toISOString(),
        })),
      });
      await context.store.cleanupBackups(context.config.sync.backupRetention);

      // Warm the scan cache while the fresh files are cheap to read, so later status checks do not re-read them.
      await createManifest(context.rootDir, { ignore: context.config.sync.ignore }).catch(() => undefined);

      // Release the browser before the (slow) npm install.
      await session.close().catch(() => undefined);
      session = undefined;

      if (await fs.pathExists(path.join(context.rootDir, "package.json"))) {
        notify(options, "running npm install");

        try {
          await runNpmInstall(context.rootDir, signal);
        } catch (npmError) {
          context.logger.warn({ err: npmError }, "npm install failed after pull");
        }
      }

      return {
        strategy,
        extractedFiles: extractedFiles.length,
        backupDir,
        dryRun: false,
        conflicts,
        merged,
        remoteSummary,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await session?.close().catch(() => undefined);
      await this.cleanupTransient(context, remoteTempDir);
      await flushLogger(context.logger);
    }
  }

  private async applyMergePlan(
    paths: ProjectStatePaths,
    baseManifest: SnapshotManifest,
    localManifest: SnapshotManifest,
    remoteManifest: SnapshotManifest,
    remoteTempDir: string,
    logger: Logger,
  ): Promise<{
    conflicts: string[];
    merged: string[];
  }> {
    const decisions = buildThreeWayMergeFoundation(
      baseManifest,
      localManifest,
      remoteManifest,
    );
    const conflictDir = path.join(
      paths.stateDir,
      "conflicts",
      new Date().toISOString().replaceAll(":", "-"),
    );
    const conflicts: string[] = [];
    const merged: string[] = [];

    for (const decision of decisions) {
      const localPath = path.join(paths.rootDir, decision.path);

      switch (decision.resolution) {
        case "noop":
        case "take-local":
          break;
        case "take-remote": {
          await copyFileIfPresent(remoteTempDir, paths.rootDir, decision.path);
          break;
        }
        case "delete": {
          await removeIfPresent(localPath);
          break;
        }
        case "conflict": {
          if (decision.base && decision.local && decision.remote) {
            const text = mergeText(
              await fs.readFile(path.join(paths.lastPullSnapshotDir, decision.path)).catch(() => Buffer.alloc(0)),
              await fs.readFile(localPath),
              await fs.readFile(path.join(remoteTempDir, decision.path)),
            );
            if (text.ok) {
              await fs.outputFile(localPath, text.text);
              merged.push(decision.path);
              break;
            }
          }
          conflicts.push(decision.path);
          logger.warn(
            { path: decision.path, reason: decision.reason },
            "merge conflict preserved",
          );
          await copyFileIfPresent(
            remoteTempDir,
            path.join(conflictDir, "remote"),
            decision.path,
          );
          await copyFileIfPresent(
            paths.lastPullSnapshotDir,
            path.join(conflictDir, "base"),
            decision.path,
          );
          break;
        }
        default: {
          throw new Error("Unhandled merge resolution.");
        }
      }
    }

    return { conflicts, merged };
  }

  private async loadProjectContext(
    commandName: string,
    options: CommandRuntimeOptions,
  ): Promise<LoadedProjectContext> {
    const rootDir = await this.resolveProjectRoot(options);
    const store = new ProjectStateStore(rootDir);
    await store.ensureStateDirectories();
    const config = await store.loadProjectConfig();

    // Apply runtime headless override if provided
    if (options.headless != null) {
      config.adapter.headlessAutomation = options.headless;
    }

    const logger = await createProjectLogger({
      logFilePath: store.nextLogFilePath(commandName),
      level: config.logging.level,
      verbose: options.verbose ?? false,
      ...(options.verbose && options.progress ? { onLog: options.progress } : {}),
    });

    return {
      rootDir,
      config,
      store,
      logger,
    };
  }

  private createAdapter(context: LoadedProjectContext): FigmaMakeAdapter {
    const adapterFactory =
      this.dependencies.adapterFactory ?? createPlaywrightAdapter;

    const paths = this.dependencies.sharedBrowserProfileDir
      ? { ...context.store.paths, browserProfileDir: this.dependencies.sharedBrowserProfileDir }
      : context.store.paths;

    return adapterFactory({
      config: context.config,
      logger: context.logger,
      paths,
    } satisfies AdapterContext);
  }

  private async resolveProjectRoot(
    options: CommandRuntimeOptions,
  ): Promise<string> {
    const explicitRoot = options.projectRoot
      ? path.resolve(options.projectRoot)
      : undefined;

    if (explicitRoot) {
      return explicitRoot;
    }

    const cwd = path.resolve(options.cwd ?? process.cwd());
    const discoveredRoot = await findProjectRoot(cwd);

    if (!discoveredRoot) {
      throw new Error(`Could not find a .figmake-sync project from ${cwd}.`);
    }

    return discoveredRoot;
  }
}
