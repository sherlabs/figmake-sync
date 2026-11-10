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
  type SnapshotManifest,
} from "../diff/manifest.js";
import {
  createPlaywrightAdapter,
  type AdapterContext,
  type AdapterFactory,
  type FigmaMakeAdapter,
  type FigmaMakeProjectSession,
} from "../figma/adapter.js";
import { buildEnv } from "../harness/process.js";
import { getManagedPnpm } from "../runtime/managed.js";
import { createProjectLogger, flushLogger } from "../logging/logger.js";
import type {
  CommandRuntimeOptions,
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
  }>;
  /** Paths changed remotely since last pull that push would overwrite (or skipped if not confirmed). */
  remoteDiverged?: string[];
  /** "skipped" = remote could not be read, push proceeded without the divergence check. */
  remoteCheck?: "ok" | "skipped";
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
    let hasPendingEditorChanges = false;
    let remoteTempDir: string | undefined;
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

      if (summary.total === 0) {
        return {
          dryRun: Boolean(options.dryRun),
          summary,
          unresolved: [],
        };
      }

      if (options.dryRun) {
        return {
          dryRun: true,
          summary,
          unresolved: [],
        };
      }

      notify(options, "opening Figma Make file");
      session = await adapter.openProject(context.config.figmaMakeUrl, signal ? { signal } : {});
      throwIfAborted(signal);

      const unresolved: Array<{
        path: string;
        reason: string;
      }> = [];
      const currentEntryByPath = new Map(
        localManifest.files.map((entry) => [entry.path, entry]),
      );

      // Remote-divergence safety: compare remote content to the baseline for
      // every path this push would touch. Best-effort (needs a zip download).
      const skipped = new Set<string>();
      const remoteDiverged: string[] = [];
      let remoteCheck: "ok" | "skipped" = "skipped";

      try {
        notify(options, "checking remote for changes");
        const download = await session.downloadLatestCodeZip(
          context.store.paths.downloadsDir,
        );

        remoteTempDir = await context.store.createTempDir("push-remote");
        await extractZipSafely(download.zipPath, remoteTempDir);

        const remoteManifest = await createManifest(remoteTempDir, {
          ignore: context.config.sync.ignore,
        });
        const remoteHash = new Map(
          remoteManifest.files.map((entry) => [entry.path, entry.contentHash]),
        );
        const baseHash = new Map(
          baselineManifest.files.map((entry) => [
            entry.path,
            entry.contentHash,
          ]),
        );
        const touched = new Set<string>([
          ...diff.added.map((entry) => entry.path),
          ...diff.modified.map((entry) => entry.current.path),
          ...diff.deleted.map((entry) => entry.path),
          ...diff.renamed.flatMap((entry) => [entry.from, entry.to]),
        ]);

        remoteCheck = "ok";

        for (const touchedPath of [...touched].sort()) {
          const remote = remoteHash.get(touchedPath);

          if (
            remote !== baseHash.get(touchedPath) &&
            remote !== currentEntryByPath.get(touchedPath)?.contentHash
          ) {
            remoteDiverged.push(touchedPath);
          }
        }
      } catch (error) {
        throwIfAborted(signal);
        if (options.requireRemoteCheck) {
          // Unattended callers fail closed: nothing has been written yet.
          throw new Error(
            "Could not check Figma Make for newer changes, so nothing was pushed. Try again, or push manually.",
          );
        }
        context.logger.warn(
          { err: error },
          "remote divergence check could not run; pushing without it",
        );
      }

      if (remoteDiverged.length > 0) {
        const approved = await getConfirm(options)(
          `${remoteDiverged.length} file(s) changed in Figma Make since the last pull (${remoteDiverged.slice(0, 5).join(", ")}${remoteDiverged.length > 5 ? ", ..." : ""}). Overwrite them with local content?`,
          false,
        );

        if (!approved) {
          const divergedSet = new Set(remoteDiverged);

          for (const entry of diff.renamed) {
            if (divergedSet.has(entry.from) || divergedSet.has(entry.to)) {
              divergedSet.add(entry.from);
              divergedSet.add(entry.to);
            }
          }

          for (const divergedPath of divergedSet) {
            skipped.add(divergedPath);
            unresolved.push({
              path: divergedPath,
              reason:
                "Remote changed since last pull; skipped to avoid overwriting. Pull first.",
            });
          }
        }
      }

      throwIfAborted(signal);

      const modifiedList = diff.modified.filter(
        (entry) => !skipped.has(entry.current.path),
      );
      const renamedList = diff.renamed.filter(
        (entry) => !skipped.has(entry.from) && !skipped.has(entry.to),
      );
      const addedPaths = [
        ...diff.added
          .map((entry) => entry.path)
          .filter((entryPath) => !skipped.has(entryPath)),
        ...renamedList.map((entry) => entry.to),
      ].sort((left, right) => left.localeCompare(right));
      const deletedPaths = [
        ...diff.deleted
          .map((entry) => entry.path)
          .filter((entryPath) => !skipped.has(entryPath)),
        ...renamedList.map((entry) => entry.from),
      ].sort((left, right) => left.localeCompare(right));
      // Paths successfully pushed (create/update) -> baseline advances for these only.
      const pushedOk = new Set<string>();
      const deletedOk: string[] = [];

      if (modifiedList.length > 0) {
        notify(options, "pushing changes");
      }

      for (const entry of modifiedList) {
        throwIfAborted(signal);

        if (entry.current.isBinary) {
          unresolved.push({
            path: entry.current.path,
            reason:
              "Binary file updates are not safely editable through the in-browser code editor. Re-upload or update this file manually.",
          });
          continue;
        }

        const absolutePath = resolveRelativePath(
          context.rootDir,
          entry.current.path,
        );

        notify(options, `updating ${entry.current.path}`);

        try {
          const content = await fs.readFile(absolutePath, "utf8");

          await session.replaceFileContents(entry.current.path, content);
          hasPendingEditorChanges = true;
          pushedOk.add(entry.current.path);
        } catch (error) {
          throwIfAborted(signal);
          unresolved.push({
            path: entry.current.path,
            reason:
              error instanceof Error
                ? error.message
                : "Failed to update the file remotely.",
          });
        }
      }

      if (addedPaths.length > 0) {
        throwIfAborted(signal);

        const absolutePaths = addedPaths.map((relativePath) =>
          resolveRelativePath(context.rootDir, relativePath),
        );
        const uploadResult = await session.uploadFiles(
          absolutePaths,
          context.rootDir,
        );
        const uploadedSet = new Set(uploadResult.uploaded);
        const deferredUploadReasons = new Map(
          uploadResult.unresolved.map(
            (entry) => [entry.path, entry.reason] as const,
          ),
        );

        for (const addedPath of addedPaths) {
          if (uploadedSet.has(addedPath)) {
            pushedOk.add(addedPath);
            continue;
          }

          const currentEntry = currentEntryByPath.get(addedPath);

          if (currentEntry?.isBinary) {
            unresolved.push({
              path: addedPath,
              reason:
                deferredUploadReasons.get(addedPath) ??
                "Binary file upload could not be completed through the current UI automation path.",
            });
            continue;
          }

          notify(options, `creating ${addedPath}`);

          try {
            const absolutePath = resolveRelativePath(
              context.rootDir,
              addedPath,
            );
            const content = await fs.readFile(absolutePath, "utf8");

            await session.upsertFile(addedPath, content);
            hasPendingEditorChanges = true;
            pushedOk.add(addedPath);
          } catch (error) {
            throwIfAborted(signal);
            unresolved.push({
              path: addedPath,
              reason:
                error instanceof Error
                  ? error.message
                  : "Failed to create the new file remotely.",
            });
          }
        }

        if (hasPendingEditorChanges) {
          notify(options, "saving editor changes");
          await session.commitPendingChanges();
          hasPendingEditorChanges = false;
        }

        const shouldPromptAfterUpload =
          options.prompt ?? context.config.adapter.promptAfterUpload;
        const newlyAdded = addedPaths.filter((addedPath) =>
          pushedOk.has(addedPath),
        );

        // Only newly created files go in the prompt; failed ones retry later.
        if (shouldPromptAfterUpload && newlyAdded.length > 0) {
          const prompt = renderPostUploadPrompt(
            context.config.adapter.postUploadPromptTemplate,
            newlyAdded,
          );

          notify(options, "sending contextual prompt");
          await session.submitPrompt(prompt);
        }
      }

      if (hasPendingEditorChanges) {
        notify(options, "saving editor changes");
        await session.commitPendingChanges();
        hasPendingEditorChanges = false;
      }

      // Deletes last, and a rename's old path only if its new path succeeded.
      const renameTarget = new Map(
        renamedList.map((entry) => [entry.from, entry.to] as const),
      );
      const deletable: string[] = [];

      for (const relativePath of deletedPaths) {
        const target = renameTarget.get(relativePath);

        if (target !== undefined && !pushedOk.has(target)) {
          unresolved.push({
            path: relativePath,
            reason: `Not deleted: rename destination ${target} was not pushed.`,
          });
          continue;
        }

        deletable.push(relativePath);
      }

      if (deletable.length > 0) {
        throwIfAborted(signal);

        const confirmDeletion = getConfirm(options);
        const approved = await confirmDeletion(
          `Delete ${deletable.length} file(s) from the linked Figma Make project? Unsupported deletes will be left unresolved.`,
          false,
        );

        if (!approved) {
          unresolved.push(
            ...deletable.map((relativePath) => ({
              path: relativePath,
              reason: "Deletion skipped by user confirmation policy.",
            })),
          );
        } else {
          for (const relativePath of deletable) {
            throwIfAborted(signal);
            notify(options, `deleting ${relativePath}`);

            try {
              const result = await session.deletePath(relativePath);

              if (result.status === "deleted") {
                deletedOk.push(relativePath);
              } else {
                unresolved.push({
                  path: result.path,
                  reason:
                    result.reason ?? `Delete action returned ${result.status}.`,
                });
              }
            } catch (error) {
              throwIfAborted(signal);
              unresolved.push({
                path: relativePath,
                reason:
                  error instanceof Error
                    ? error.message
                    : "Failed to delete the file remotely.",
              });
            }
          }
        }
      }

      // Per-path baseline: succeeded paths advance, failed paths stay dirty.
      const { stale } = await context.store.advanceBaseline(
        context.rootDir,
        baselineManifest,
        {
          upserts: [...pushedOk].flatMap((pushedPath) => {
            const entry = currentEntryByPath.get(pushedPath);

            return entry ? [entry] : [];
          }),
          removals: deletedOk,
        },
      );

      if (stale.length > 0) {
        context.logger.warn(
          { paths: stale },
          "files changed during push; left dirty for the next push",
        );
      }

      await context.store.updateMetadata({
        lastPushAt: new Date().toISOString(),
        lastCommand: "push",
        unresolved: unresolved.map((entry) => ({
          operation: "push" as const,
          path: entry.path,
          reason: entry.reason,
          recordedAt: new Date().toISOString(),
        })),
      });

      return {
        dryRun: false,
        summary,
        unresolved,
        remoteDiverged,
        remoteCheck,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);

      if (session && hasPendingEditorChanges && !signal?.aborted) {
        await session.commitPendingChanges().catch((error) => {
          context.logger.warn(
            { error },
            "failed to flush pending editor changes before closing the browser session",
          );
        });
      }

      await session?.close().catch(() => undefined);
      await this.cleanupTransient(context, remoteTempDir);
      await flushLogger(context.logger);
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
