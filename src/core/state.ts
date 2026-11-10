import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import fs from "fs-extra";
import { Minimatch } from "minimatch";
import { z } from "zod";

import {
  createHashIndex,
  createManifest,
  type ManifestEntry,
  type SnapshotManifest,
} from "../diff/manifest.js";
import {
  createProjectConfig,
  parseProjectConfig,
  type ProjectConfig,
} from "../types/config.js";

export const STATE_DIRECTORY_NAME = ".figmake-sync";

const syncMetadataSchema = z.object({
  version: z.literal(1).default(1),
  lastPullAt: z.string().datetime().optional(),
  lastPushAt: z.string().datetime().optional(),
  lastVerifyAt: z.string().datetime().optional(),
  lastDownloadedZip: z.string().optional(),
  lastCommand: z.string().optional(),
  unresolved: z
    .array(
      z.object({
        operation: z.enum(["pull", "push", "verify"]),
        path: z.string(),
        reason: z.string(),
        recordedAt: z.string().datetime(),
      }),
    )
    .default([]),
});

export type SyncMetadata = z.output<typeof syncMetadataSchema>;

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  root: z.string(),
  ignore: z.array(z.string()),
  files: z.array(
    z.object({
      path: z.string(),
      contentHash: z.string(),
      normalizedHash: z.string(),
      size: z.number(),
      modifiedTimeMs: z.number(),
      isBinary: z.boolean(),
      lineEnding: z.enum(["lf", "crlf", "mixed", "none", "binary"]),
    }),
  ),
});

// Never copied into backups/snapshots, even if no ignore globs are supplied.
const ALWAYS_SKIP_COPY = ["node_modules", ".git", "dist"];

/** Write JSON via tmp file + rename so a crash never leaves truncated JSON. */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.remove(tmpPath).catch(() => undefined);
    throw error;
  }
}

function hashLikeManifest(buffer: Buffer): string {
  // Must match manifest.ts contentHash (sha256 of raw bytes).
  return createHash("sha256").update(buffer).digest("hex");
}

function throwIfCopyAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
}

function createCopyFilter(
  sourceDir: string,
  ignore: readonly string[] | undefined,
): (src: string) => boolean {
  const matchers = [...ALWAYS_SKIP_COPY, ...(ignore ?? [])].map(
    (pattern) =>
      new Minimatch(pattern, {
        dot: true,
        nocase: process.platform === "darwin",
      }),
  );

  return (src) => {
    const relative = path
      .relative(sourceDir, src)
      .split(path.sep)
      .join(path.posix.sep);

    if (!relative) {
      return true;
    }

    if (relative === STATE_DIRECTORY_NAME) {
      return false;
    }

    return !matchers.some(
      (matcher) =>
        matcher.match(relative) ||
        matcher.match(`${relative}/`) ||
        matcher.match(`${relative}/**`),
    );
  };
}

export interface ProjectStatePaths {
  rootDir: string;
  stateDir: string;
  configPath: string;
  metadataPath: string;
  lastPullManifestPath: string;
  lastPullHashesPath: string;
  lastPullSnapshotDir: string;
  backupsDir: string;
  downloadsDir: string;
  logsDir: string;
  tmpDir: string;
  artifactsDir: string;
  browserProfileDir: string;
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function resolveProjectStatePaths(rootDir: string): ProjectStatePaths {
  const stateDir = path.join(rootDir, STATE_DIRECTORY_NAME);

  return {
    rootDir: path.resolve(rootDir),
    stateDir,
    configPath: path.join(stateDir, "config.json"),
    metadataPath: path.join(stateDir, "metadata.json"),
    lastPullManifestPath: path.join(stateDir, "last-pull-manifest.json"),
    lastPullHashesPath: path.join(stateDir, "file-hashes.json"),
    lastPullSnapshotDir: path.join(stateDir, "snapshots", "last-pull"),
    backupsDir: path.join(stateDir, "backups"),
    downloadsDir: path.join(stateDir, "downloads"),
    logsDir: path.join(stateDir, "logs"),
    tmpDir: path.join(stateDir, "tmp"),
    artifactsDir: path.join(stateDir, "artifacts"),
    browserProfileDir: path.join(stateDir, "browser-profile"),
  };
}

export async function findProjectRoot(
  startDir: string,
): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidateConfigPath = resolveProjectStatePaths(currentDir).configPath;

    if (await fs.pathExists(candidateConfigPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export class ProjectStateStore {
  readonly paths: ProjectStatePaths;

  constructor(rootDir: string) {
    this.paths = resolveProjectStatePaths(path.resolve(rootDir));
  }

  async ensureStateDirectories(): Promise<void> {
    await Promise.all([
      fs.ensureDir(this.paths.stateDir),
      fs.ensureDir(this.paths.backupsDir),
      fs.ensureDir(this.paths.downloadsDir),
      fs.ensureDir(this.paths.logsDir),
      fs.ensureDir(this.paths.tmpDir),
      fs.ensureDir(this.paths.artifactsDir),
      fs.ensureDir(this.paths.browserProfileDir),
      fs.ensureDir(path.dirname(this.paths.lastPullManifestPath)),
    ]);
  }

  async initializeProject(figmaMakeUrl: string): Promise<ProjectConfig> {
    await this.ensureStateDirectories();

    if (await fs.pathExists(this.paths.configPath)) {
      throw new Error(
        `Project already initialized at ${this.paths.rootDir}. Remove ${this.paths.configPath} to re-link it.`,
      );
    }

    const config = createProjectConfig(figmaMakeUrl, this.paths.rootDir);

    await this.saveProjectConfig(config);
    await this.writeMetadata(syncMetadataSchema.parse({ version: 1 }));

    // Create .gitignore if it doesn't exist
    const gitignorePath = path.join(this.paths.rootDir, ".gitignore");
    if (!(await fs.pathExists(gitignorePath))) {
      await fs.writeFile(
        gitignorePath,
        ["node_modules/", ".figmake-sync/", ""].join("\n"),
      );
    }

    return config;
  }

  async saveProjectConfig(config: ProjectConfig): Promise<void> {
    await writeJsonAtomic(this.paths.configPath, config);
  }

  async loadProjectConfig(): Promise<ProjectConfig> {
    if (!(await fs.pathExists(this.paths.configPath))) {
      throw new Error(
        `No figmake-sync project found from ${this.paths.rootDir}. Run figmake-sync init <figma-make-url> first.`,
      );
    }

    let rawConfig: unknown;

    try {
      rawConfig = await fs.readJson(this.paths.configPath);
    } catch (error) {
      throw new Error(
        `Project config at ${this.paths.configPath} is unreadable or corrupt (${error instanceof Error ? error.message : String(error)}). Fix or delete it and re-run init.`,
      );
    }

    return parseProjectConfig(rawConfig);
  }

  async readLastPullManifest(): Promise<SnapshotManifest | null> {
    if (!(await fs.pathExists(this.paths.lastPullManifestPath))) {
      return null;
    }

    try {
      const raw: unknown = await fs.readJson(this.paths.lastPullManifestPath);

      return manifestSchema.parse(raw) as SnapshotManifest;
    } catch {
      // Corrupt baseline is treated as "no baseline"; a pull or rebaseline recovers.
      return null;
    }
  }

  /**
   * Replace the whole baseline (manifest + snapshot). Snapshot is built in a
   * sibling dir and swapped in; manifest/hashes are written atomically after.
   */
  async writeLastPullState(
    sourceDir: string,
    manifest: SnapshotManifest,
  ): Promise<void> {
    const finalDir = this.paths.lastPullSnapshotDir;
    const newDir = `${finalDir}.new`;
    const oldDir = `${finalDir}.old`;

    await fs.remove(newDir);
    await this.copyWorkspaceLikeTree(sourceDir, newDir, manifest.ignore);
    await fs.remove(oldDir);

    if (await fs.pathExists(finalDir)) {
      await fs.rename(finalDir, oldDir);
    }

    await fs.rename(newDir, finalDir);
    await fs.remove(oldDir);
    await this.writeBaselineManifest(manifest);
  }

  private async writeBaselineManifest(
    manifest: SnapshotManifest,
  ): Promise<void> {
    await writeJsonAtomic(this.paths.lastPullManifestPath, manifest);
    await writeJsonAtomic(
      this.paths.lastPullHashesPath,
      createHashIndex(manifest),
    );
  }

  /**
   * Per-path baseline advance after a (possibly partial) push. Only the given
   * upserts/removals move; every other path keeps its old baseline entry so
   * failed paths stay dirty. An upsert is skipped (returned in `stale`) when the
   * file on disk no longer matches the pushed hash (edited/deleted mid-push),
   * so manifest and snapshot never disagree.
   */
  async advanceBaseline(
    sourceDir: string,
    baseline: SnapshotManifest,
    changes: { upserts: ManifestEntry[]; removals: string[] },
  ): Promise<{ stale: string[] }> {
    const entries = new Map(baseline.files.map((entry) => [entry.path, entry]));
    const stale: string[] = [];

    for (const entry of changes.upserts) {
      const sourcePath = path.join(sourceDir, entry.path);
      let buffer: Buffer;

      try {
        buffer = await fs.readFile(sourcePath);
      } catch {
        stale.push(entry.path);
        continue;
      }

      if (hashLikeManifest(buffer) !== entry.contentHash) {
        stale.push(entry.path);
        continue;
      }

      await writeFileAtomic(
        path.join(this.paths.lastPullSnapshotDir, entry.path),
        buffer,
      );
      entries.set(entry.path, entry);
    }

    for (const removal of changes.removals) {
      await fs.remove(path.join(this.paths.lastPullSnapshotDir, removal));
      entries.delete(removal);
    }

    await this.writeBaselineManifest({
      ...baseline,
      createdAt: new Date().toISOString(),
      files: [...entries.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    });

    return { stale };
  }

  async readMetadata(): Promise<SyncMetadata> {
    if (!(await fs.pathExists(this.paths.metadataPath))) {
      return syncMetadataSchema.parse({ version: 1 });
    }

    try {
      const rawMetadata: unknown = await fs.readJson(this.paths.metadataPath);

      return syncMetadataSchema.parse(rawMetadata);
    } catch {
      return syncMetadataSchema.parse({ version: 1 });
    }
  }

  async writeMetadata(metadata: SyncMetadata): Promise<void> {
    await writeJsonAtomic(
      this.paths.metadataPath,
      syncMetadataSchema.parse(metadata),
    );
  }

  async updateMetadata(patch: Partial<SyncMetadata>): Promise<SyncMetadata> {
    const current = await this.readMetadata();
    const next = syncMetadataSchema.parse({
      ...current,
      ...patch,
    });

    await this.writeMetadata(next);

    return next;
  }

  async createBackup(
    label: string,
    ignore?: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const backupDir = path.join(
      this.paths.backupsDir,
      `${timestampForPath()}-${label}`,
    );

    await fs.ensureDir(backupDir);
    try {
      await this.copyWorkspaceLikeTree(
        this.paths.rootDir,
        path.join(backupDir, "workspace"),
        ignore,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) await fs.remove(backupDir).catch(() => undefined);
      throw error;
    }

    return backupDir;
  }

  /**
   * Puts the workspace back exactly as a backup snapshot saw it: snapshot files are
   * copied back and tracked files created since are removed. Ignored paths are untouched.
   */
  async restoreBackup(
    backupDir: string,
    ignore?: readonly string[],
  ): Promise<void> {
    const snapshot = path.join(backupDir, "workspace");
    if (!(await fs.pathExists(snapshot))) {
      throw new Error("Backup snapshot is missing.");
    }

    const keep = new Set(await this.listFilesRecursive(snapshot));
    const current = await createManifest(this.paths.rootDir, {
      ...(ignore ? { ignore } : {}),
    });

    for (const entry of current.files) {
      if (!keep.has(entry.path)) {
        await fs.remove(path.join(this.paths.rootDir, entry.path));
      }
    }

    for (const relativePath of keep) {
      await writeFileAtomic(
        path.join(this.paths.rootDir, relativePath),
        await fs.readFile(path.join(snapshot, relativePath)),
      );
    }
  }

  async createTempDir(prefix: string): Promise<string> {
    await fs.ensureDir(this.paths.tmpDir);
    return fs.mkdtemp(path.join(this.paths.tmpDir, `${prefix}-`));
  }

  /**
   * Non-destructive, per-file replace. Writes every file from `sourceDir`
   * (tmp + rename each) and, when `localManifest`/`remoteManifest` are given,
   * deletes only tracked local files that no longer exist remotely. Untracked
   * or ignored files (.env, .git, node_modules, ...) are never touched.
   */
  async replaceWorkspaceFrom(
    sourceDir: string,
    options: {
      localManifest?: SnapshotManifest;
      remoteManifest?: SnapshotManifest;
    } = {},
  ): Promise<void> {
    const remotePaths = options.remoteManifest
      ? options.remoteManifest.files.map((entry) => entry.path)
      : await this.listFilesRecursive(sourceDir);

    for (const relativePath of remotePaths) {
      const data = await fs.readFile(path.join(sourceDir, relativePath));

      await writeFileAtomic(path.join(this.paths.rootDir, relativePath), data);
    }

    if (options.localManifest && options.remoteManifest) {
      const remoteSet = new Set(remotePaths);

      for (const entry of options.localManifest.files) {
        if (!remoteSet.has(entry.path)) {
          await fs.remove(path.join(this.paths.rootDir, entry.path));
        }
      }
    }
  }

  private async listFilesRecursive(
    rootDir: string,
    currentDir = rootDir,
  ): Promise<string[]> {
    const result: string[] = [];

    for (const entry of await fs.readdir(currentDir, { withFileTypes: true })) {
      const absolute = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        result.push(...(await this.listFilesRecursive(rootDir, absolute)));
      } else if (entry.isFile()) {
        result.push(
          path.relative(rootDir, absolute).split(path.sep).join(path.posix.sep),
        );
      }
    }

    return result;
  }

  /** Keep only the newest `keep` downloaded zips (plus `protect`). */
  async pruneDownloads(keep: number, protect: string[] = []): Promise<void> {
    const names = await fs.readdir(this.paths.downloadsDir).catch(() => []);
    const withTimes = await Promise.all(
      names.map(async (name) => {
        const full = path.join(this.paths.downloadsDir, name);
        const stat = await fs.stat(full).catch(() => null);

        return { full, mtime: stat?.mtimeMs ?? 0 };
      }),
    );
    const protectedSet = new Set(protect.map((entry) => path.resolve(entry)));

    withTimes.sort((left, right) => right.mtime - left.mtime);

    for (const item of withTimes.slice(keep)) {
      if (!protectedSet.has(path.resolve(item.full))) {
        await fs.remove(item.full).catch(() => undefined);
      }
    }
  }

  async cleanupBackups(retention: number): Promise<void> {
    const entries = await fs.readdir(this.paths.backupsDir).catch(() => []);
    const sortedEntries = entries.sort((left, right) =>
      right.localeCompare(left),
    );

    for (const entry of sortedEntries.slice(retention)) {
      await fs.remove(path.join(this.paths.backupsDir, entry));
    }
  }

  nextLogFilePath(commandName: string): string {
    return path.join(
      this.paths.logsDir,
      `${timestampForPath()}-${commandName}.log`,
    );
  }

  /**
   * Copies the workspace-like tree with a few files in flight, using copy-on-write clones where the disk
   * supports them (instant, no file content read). Stops early when `signal` aborts.
   */
  private async copyWorkspaceLikeTree(
    sourceDir: string,
    destinationDir: string,
    ignore?: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await fs.ensureDir(destinationDir);

    const filter = createCopyFilter(sourceDir, ignore);
    const files: { from: string; to: string }[] = [];
    const links: { from: string; to: string }[] = [];

    async function walk(from: string, to: string): Promise<void> {
      await fs.ensureDir(to);
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        const entryFrom = path.join(from, entry.name);
        // Per entry: the destination may live inside sourceDir (.figmake-sync).
        if (!filter(entryFrom)) continue;
        const entryTo = path.join(to, entry.name);
        if (entry.isSymbolicLink()) links.push({ from: entryFrom, to: entryTo });
        else if (entry.isDirectory()) await walk(entryFrom, entryTo);
        else if (entry.isFile()) files.push({ from: entryFrom, to: entryTo });
      }
    }

    await walk(sourceDir, destinationDir);

    for (const link of links) {
      throwIfCopyAborted(signal);
      await fs.symlink(await fs.readlink(link.from), link.to).catch(() => undefined);
    }

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        throwIfCopyAborted(signal);
        const file = files[next++] as { from: string; to: string };
        await fs.copyFile(file.from, file.to, fs.constants.COPYFILE_FICLONE);
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, () => worker()));
  }
}
