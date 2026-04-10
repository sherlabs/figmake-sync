import path from "node:path";

import fs from "fs-extra";
import { z } from "zod";

import { createHashIndex, type SnapshotManifest } from "../diff/manifest.js";
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
    await fs.writeJson(this.paths.configPath, config, { spaces: 2 });
  }

  async loadProjectConfig(): Promise<ProjectConfig> {
    if (!(await fs.pathExists(this.paths.configPath))) {
      throw new Error(
        `No figmake-sync project found from ${this.paths.rootDir}. Run figmake-sync init <figma-make-url> first.`,
      );
    }

    const rawConfig: unknown = await fs.readJson(this.paths.configPath);

    return parseProjectConfig(rawConfig);
  }

  async readLastPullManifest(): Promise<SnapshotManifest | null> {
    if (!(await fs.pathExists(this.paths.lastPullManifestPath))) {
      return null;
    }

    return (await fs.readJson(
      this.paths.lastPullManifestPath,
    )) as SnapshotManifest;
  }

  async writeLastPullState(
    sourceDir: string,
    manifest: SnapshotManifest,
  ): Promise<void> {
    await fs.writeJson(this.paths.lastPullManifestPath, manifest, {
      spaces: 2,
    });
    await fs.writeJson(
      this.paths.lastPullHashesPath,
      createHashIndex(manifest),
      { spaces: 2 },
    );
    await fs.emptyDir(this.paths.lastPullSnapshotDir);
    await this.copyWorkspaceLikeTree(sourceDir, this.paths.lastPullSnapshotDir);
  }

  async readMetadata(): Promise<SyncMetadata> {
    if (!(await fs.pathExists(this.paths.metadataPath))) {
      return syncMetadataSchema.parse({ version: 1 });
    }

    const rawMetadata: unknown = await fs.readJson(this.paths.metadataPath);

    return syncMetadataSchema.parse(rawMetadata);
  }

  async writeMetadata(metadata: SyncMetadata): Promise<void> {
    await fs.writeJson(
      this.paths.metadataPath,
      syncMetadataSchema.parse(metadata),
      { spaces: 2 },
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

  async createBackup(label: string): Promise<string> {
    const backupDir = path.join(
      this.paths.backupsDir,
      `${timestampForPath()}-${label}`,
    );

    await fs.ensureDir(backupDir);
    await this.copyWorkspaceLikeTree(
      this.paths.rootDir,
      path.join(backupDir, "workspace"),
    );

    return backupDir;
  }

  async createTempDir(prefix: string): Promise<string> {
    await fs.ensureDir(this.paths.tmpDir);
    return fs.mkdtemp(path.join(this.paths.tmpDir, `${prefix}-`));
  }

  private static readonly PRESERVE_ON_REPLACE = new Set([
    STATE_DIRECTORY_NAME,
    "node_modules",
    "dist",
    ".gitignore",
    ".git",
  ]);

  async replaceWorkspaceFrom(sourceDir: string): Promise<void> {
    const workspaceEntries = await fs.readdir(this.paths.rootDir);

    for (const entry of workspaceEntries) {
      if (ProjectStateStore.PRESERVE_ON_REPLACE.has(entry)) {
        continue;
      }

      await fs.remove(path.join(this.paths.rootDir, entry));
    }

    const sourceEntries = await fs.readdir(sourceDir);

    for (const entry of sourceEntries) {
      await fs.copy(
        path.join(sourceDir, entry),
        path.join(this.paths.rootDir, entry),
        {
          overwrite: true,
          errorOnExist: false,
        },
      );
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

  private async copyWorkspaceLikeTree(
    sourceDir: string,
    destinationDir: string,
  ): Promise<void> {
    await fs.ensureDir(destinationDir);

    const entries = await fs.readdir(sourceDir);

    for (const entry of entries) {
      if (entry === STATE_DIRECTORY_NAME) {
        continue;
      }

      await fs.copy(
        path.join(sourceDir, entry),
        path.join(destinationDir, entry),
        {
          overwrite: true,
          errorOnExist: false,
        },
      );
    }
  }
}
