import path from "node:path";

import fs from "fs-extra";
import type { Logger } from "pino";

import { createTextPatchPreview } from "../diff/changes.js";
import {
  buildThreeWayMergeFoundation,
  createManifest,
  diffManifests,
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
} from "../figma/adapter.js";
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
  remoteSummary: ReturnType<typeof summarizeManifestDiff>;
}

export interface PushResult {
  dryRun: boolean;
  summary: ReturnType<typeof summarizeManifestDiff>;
  unresolved: Array<{
    path: string;
    reason: string;
  }>;
}

export interface VerifyResult {
  drift: StatusResult;
  preview: string | undefined;
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
        options.waitForManualAction
          ? {
              waitForCompletion: options.waitForManualAction,
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
    const diff = diffManifests(baselineManifest, localManifest);

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
      const diff = diffManifests(baselineManifest, localManifest);

      return {
        hasBaseline: true,
        diff,
        summary: summarizeManifestDiff(diff),
      };
    } finally {
      await flushLogger(context.logger);
    }
  }

  async pull(options: CommandRuntimeOptions = {}): Promise<PullResult> {
    return this.performPull(options, {
      safeMode: false,
    });
  }

  async syncFromFigma(
    options: CommandRuntimeOptions = {},
  ): Promise<PullResult> {
    return this.performPull(options, {
      safeMode: true,
    });
  }

  async push(options: CommandRuntimeOptions = {}): Promise<PushResult> {
    const context = await this.loadProjectContext("push", options);
    const adapter = this.createAdapter(context);
    const baselineManifest = await context.store.readLastPullManifest();

    if (!baselineManifest) {
      await flushLogger(context.logger);
      throw new Error(
        "Push requires an existing baseline. Run figmake-sync pull first.",
      );
    }

    let session;
    let hasPendingEditorChanges = false;

    try {
      const localManifest = await createManifest(context.rootDir, {
        ignore: context.config.sync.ignore,
      });
      const diff = diffManifests(baselineManifest, localManifest);
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
      session = await adapter.openProject(context.config.figmaMakeUrl);

      const unresolved: Array<{
        path: string;
        reason: string;
      }> = [];
      const currentEntryByPath = new Map(
        localManifest.files.map((entry) => [entry.path, entry]),
      );
      const addedPaths = [
        ...diff.added.map((entry) => entry.path),
        ...diff.renamed.map((entry) => entry.to),
      ].sort((left, right) => left.localeCompare(right));
      const deletedPaths = [
        ...diff.deleted.map((entry) => entry.path),
        ...diff.renamed.map((entry) => entry.from),
      ].sort((left, right) => left.localeCompare(right));

      if (diff.modified.length > 0) {
        notify(options, "pushing changes");
      }

      for (const entry of diff.modified) {
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
        const content = await fs.readFile(absolutePath, "utf8");

        notify(options, `updating ${entry.current.path}`);
        await session.replaceFileContents(entry.current.path, content);
        hasPendingEditorChanges = true;
      }

      if (addedPaths.length > 0) {
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

          const absolutePath = resolveRelativePath(context.rootDir, addedPath);
          const content = await fs.readFile(absolutePath, "utf8");

          notify(options, `creating ${addedPath}`);

          try {
            await session.upsertFile(addedPath, content);
            hasPendingEditorChanges = true;
          } catch (error) {
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

        if (shouldPromptAfterUpload && addedPaths.length > 0) {
          const prompt = renderPostUploadPrompt(
            context.config.adapter.postUploadPromptTemplate,
            addedPaths,
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

      if (deletedPaths.length > 0) {
        const confirmDeletion = getConfirm(options);
        const approved = await confirmDeletion(
          `Delete ${deletedPaths.length} file(s) from the linked Figma Make project? Unsupported deletes will be left unresolved.`,
          false,
        );

        if (!approved) {
          unresolved.push(
            ...deletedPaths.map((relativePath) => ({
              path: relativePath,
              reason: "Deletion skipped by user confirmation policy.",
            })),
          );
        } else {
          for (const relativePath of deletedPaths) {
            notify(options, `deleting ${relativePath}`);
            const result = await session.deletePath(relativePath);

            if (result.status !== "deleted") {
              unresolved.push({
                path: result.path,
                reason:
                  result.reason ?? `Delete action returned ${result.status}.`,
              });
            }
          }
        }
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

      if (unresolved.length === 0) {
        await context.store.writeLastPullState(context.rootDir, localManifest);
      }

      return {
        dryRun: false,
        summary,
        unresolved,
      };
    } finally {
      if (session && hasPendingEditorChanges) {
        await session.commitPendingChanges().catch((error) => {
          context.logger.warn(
            { error },
            "failed to flush pending editor changes before closing the browser session",
          );
        });
      }

      await session?.close();
      await flushLogger(context.logger);
    }
  }

  async verify(options: CommandRuntimeOptions = {}): Promise<VerifyResult> {
    const context = await this.loadProjectContext("verify", options);
    const adapter = this.createAdapter(context);
    let session;

    try {
      const localManifest = await createManifest(context.rootDir, {
        ignore: context.config.sync.ignore,
      });

      notify(options, "opening Figma Make file");
      session = await adapter.openProject(context.config.figmaMakeUrl);

      notify(options, "downloading latest code");
      const download = await session.downloadLatestCodeZip(
        context.store.paths.downloadsDir,
      );
      const tempDir = await context.store.createTempDir("verify-remote");

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
          hasBaseline: true,
          diff,
          summary,
        },
        preview,
      };
    } finally {
      await session?.close();
      await flushLogger(context.logger);
    }
  }

  private async performPull(
    options: CommandRuntimeOptions,
    behavior: {
      safeMode: boolean;
    },
  ): Promise<PullResult> {
    const context = await this.loadProjectContext(
      behavior.safeMode ? "sync-from-figma" : "pull",
      options,
    );
    const adapter = this.createAdapter(context);
    let session;

    try {
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
      session = await adapter.openProject(context.config.figmaMakeUrl);

      notify(options, "downloading latest code");
      const download = await session.downloadLatestCodeZip(
        context.store.paths.downloadsDir,
      );
      const remoteTempDir = await context.store.createTempDir("remote-pull");
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
          remoteSummary,
        };
      }

      let backupDir: string | undefined;
      const conflicts: string[] = [];

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

      if (hasLocalChanges && strategy === "backup") {
        backupDir = await context.store.createBackup("pre-pull");
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
      } else {
        if (hasLocalChanges && !backupDir) {
          backupDir = await context.store.createBackup("pre-pull");
        }

        notify(options, "applying downloaded snapshot");
        await context.store.replaceWorkspaceFrom(remoteTempDir);
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

      return {
        strategy,
        extractedFiles: extractedFiles.length,
        backupDir,
        dryRun: false,
        conflicts,
        remoteSummary,
      };
    } finally {
      await session?.close();
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

    return { conflicts };
  }

  private async loadProjectContext(
    commandName: string,
    options: CommandRuntimeOptions,
  ): Promise<LoadedProjectContext> {
    const rootDir = await this.resolveProjectRoot(options);
    const store = new ProjectStateStore(rootDir);
    await store.ensureStateDirectories();
    const config = await store.loadProjectConfig();
    const logger = await createProjectLogger({
      logFilePath: store.nextLogFilePath(commandName),
      level: config.logging.level,
      verbose: options.verbose ?? false,
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
