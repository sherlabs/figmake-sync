import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import {
  findProjectRoot,
  ProjectStateStore,
  resolveProjectStatePaths,
  STATE_DIRECTORY_NAME,
} from "../src/core/state.js";
import { createManifest } from "../src/diff/manifest.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

describe("resolveProjectStatePaths", () => {
  it("returns expected sub-paths relative to the root directory", () => {
    const rootDir = "/tmp/my-project";
    const paths = resolveProjectStatePaths(rootDir);

    expect(paths.rootDir).toBe(path.resolve(rootDir));
    expect(paths.stateDir).toBe(
      path.join(path.resolve(rootDir), STATE_DIRECTORY_NAME),
    );
    expect(paths.configPath).toContain("config.json");
    expect(paths.metadataPath).toContain("metadata.json");
    expect(paths.lastPullManifestPath).toContain("last-pull-manifest.json");
    expect(paths.backupsDir).toContain("backups");
    expect(paths.downloadsDir).toContain("downloads");
    expect(paths.logsDir).toContain("logs");
    expect(paths.tmpDir).toContain("tmp");
  });
});

describe("findProjectRoot", () => {
  it("returns the project root when the config exists in the start directory", async () => {
    const rootDir = await createTempDir("figmake-find-root");
    const store = new ProjectStateStore(rootDir);

    await store.initializeProject("https://www.figma.com/make/test");

    const found = await findProjectRoot(rootDir);

    expect(found).toBe(path.resolve(rootDir));
  });

  it("returns the project root when searching from a subdirectory", async () => {
    const rootDir = await createTempDir("figmake-find-sub");
    const subDir = path.join(rootDir, "src", "components");
    const store = new ProjectStateStore(rootDir);

    await store.initializeProject("https://www.figma.com/make/test");
    await fs.ensureDir(subDir);

    const found = await findProjectRoot(subDir);

    expect(found).toBe(path.resolve(rootDir));
  });

  it("returns null when no project root is found", async () => {
    const isolatedDir = await createTempDir("figmake-no-root");

    const found = await findProjectRoot(isolatedDir);

    expect(found).toBeNull();
  });
});

describe("ProjectStateStore", () => {
  describe("initializeProject", () => {
    it("creates the config and metadata files", async () => {
      const rootDir = await createTempDir("figmake-state-init");
      const store = new ProjectStateStore(rootDir);

      await store.initializeProject("https://www.figma.com/make/test");

      expect(await fs.pathExists(store.paths.configPath)).toBe(true);
      expect(await fs.pathExists(store.paths.metadataPath)).toBe(true);
    });

    it("throws if the project is already initialized", async () => {
      const rootDir = await createTempDir("figmake-state-reinit");
      const store = new ProjectStateStore(rootDir);

      await store.initializeProject("https://www.figma.com/make/test");

      await expect(
        store.initializeProject("https://www.figma.com/make/test"),
      ).rejects.toThrow("already initialized");
    });
  });

  describe("loadProjectConfig", () => {
    it("loads the config after initialization", async () => {
      const rootDir = await createTempDir("figmake-state-load-config");
      const store = new ProjectStateStore(rootDir);
      const url = "https://www.figma.com/make/test";

      await store.initializeProject(url);
      const config = await store.loadProjectConfig();

      expect(config.figmaMakeUrl).toBe(url);
      expect(config.version).toBe(1);
    });

    it("throws if the config does not exist", async () => {
      const rootDir = await createTempDir("figmake-state-no-config");
      const store = new ProjectStateStore(rootDir);

      await expect(store.loadProjectConfig()).rejects.toThrow(
        "No figmake-sync project found",
      );
    });
  });

  describe("readMetadata / writeMetadata / updateMetadata", () => {
    it("returns a default metadata object before any write", async () => {
      const rootDir = await createTempDir("figmake-state-meta-default");
      const store = new ProjectStateStore(rootDir);

      const metadata = await store.readMetadata();

      expect(metadata.version).toBe(1);
      expect(metadata.unresolved).toEqual([]);
    });

    it("persists and reloads metadata", async () => {
      const rootDir = await createTempDir("figmake-state-meta-write");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();
      await store.writeMetadata({
        version: 1,
        lastCommand: "pull",
        unresolved: [],
      });

      const metadata = await store.readMetadata();

      expect(metadata.lastCommand).toBe("pull");
    });

    it("merges partial updates via updateMetadata", async () => {
      const rootDir = await createTempDir("figmake-state-meta-update");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();
      await store.writeMetadata({ version: 1, unresolved: [] });
      await store.updateMetadata({ lastCommand: "push" });

      const metadata = await store.readMetadata();

      expect(metadata.lastCommand).toBe("push");
    });
  });

  describe("readLastPullManifest", () => {
    it("returns null when no manifest has been saved", async () => {
      const rootDir = await createTempDir("figmake-state-no-manifest");
      const store = new ProjectStateStore(rootDir);

      const manifest = await store.readLastPullManifest();

      expect(manifest).toBeNull();
    });

    it("returns the manifest after writeLastPullState", async () => {
      const rootDir = await createTempDir("figmake-state-manifest");
      const sourceDir = await createTempDir("figmake-state-manifest-src");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();
      await fs.outputFile(path.join(sourceDir, "app.ts"), "export {};");
      const manifest = await createManifest(sourceDir);

      await store.writeLastPullState(sourceDir, manifest);

      const loaded = await store.readLastPullManifest();

      expect(loaded).not.toBeNull();
      expect(loaded?.files).toHaveLength(1);
      expect(loaded?.files[0]?.path).toBe("app.ts");
    });
  });

  describe("createBackup", () => {
    it("creates a backup directory with workspace contents", async () => {
      const rootDir = await createTempDir("figmake-state-backup");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();
      await fs.outputFile(path.join(rootDir, "src", "app.ts"), "export {};");

      const backupDir = await store.createBackup("pre-pull");

      expect(await fs.pathExists(backupDir)).toBe(true);
      expect(
        await fs.pathExists(
          path.join(backupDir, "workspace", "src", "app.ts"),
        ),
      ).toBe(true);
    });

    it("does not include the state directory in the backup", async () => {
      const rootDir = await createTempDir("figmake-state-backup-no-state");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();
      await fs.outputFile(path.join(rootDir, "app.ts"), "export {};");

      const backupDir = await store.createBackup("test");

      const backupStateDir = path.join(
        backupDir,
        "workspace",
        STATE_DIRECTORY_NAME,
      );

      expect(await fs.pathExists(backupStateDir)).toBe(false);
    });
  });

  describe("cleanupBackups", () => {
    it("removes old backups beyond the retention limit", async () => {
      const rootDir = await createTempDir("figmake-state-cleanup");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();

      for (let index = 0; index < 3; index += 1) {
        await fs.ensureDir(
          path.join(store.paths.backupsDir, `2024-01-0${index + 1}-backup`),
        );
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      await store.cleanupBackups(2);

      const remaining = await fs.readdir(store.paths.backupsDir);

      expect(remaining).toHaveLength(2);
    });

    it("does nothing when fewer backups exist than the retention limit", async () => {
      const rootDir = await createTempDir("figmake-state-cleanup-noop");
      const store = new ProjectStateStore(rootDir);

      await store.ensureStateDirectories();
      await fs.ensureDir(path.join(store.paths.backupsDir, "2024-01-01-backup"));

      await store.cleanupBackups(5);

      const remaining = await fs.readdir(store.paths.backupsDir);

      expect(remaining).toHaveLength(1);
    });
  });

  describe("nextLogFilePath", () => {
    it("returns a path inside the logs directory with the command name", () => {
      const store = new ProjectStateStore("/tmp/proj");
      const logPath = store.nextLogFilePath("pull");

      expect(logPath).toContain("logs");
      expect(logPath).toContain("pull");
      expect(logPath).toMatch(/\.log$/u);
    });
  });
});
