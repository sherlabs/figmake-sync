import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthenticateBrowserSessionOptions } from "../src/browser/session.js";
import { FigmakeSyncService } from "../src/core/service.js";
import type {
  DeleteResult,
  DownloadResult,
  FigmaMakeAdapter,
  FigmaMakeProjectSession,
  UploadResult,
} from "../src/figma/adapter.js";
import { DEFAULT_IGNORE_PATTERNS } from "../src/types/config.js";
import { createZipFromDirectory } from "../src/utils/archive.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

interface Tracker {
  replaceCalls: string[];
  upsertCalls: string[];
  commitCalls: number;
}

class RecordingSession implements FigmaMakeProjectSession {
  constructor(
    private readonly remoteRoot: string,
    private readonly tracker: Tracker,
  ) {}

  async downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult> {
    const zipPath = path.join(destinationDir, "recording-remote.zip");

    await createZipFromDirectory(this.remoteRoot, zipPath);

    return {
      zipPath,
      suggestedFileName: "recording-remote.zip",
    };
  }

  async replaceFileContents(
    relativePath: string,
    content: string,
  ): Promise<void> {
    this.tracker.replaceCalls.push(relativePath);
    await fs.outputFile(path.join(this.remoteRoot, relativePath), content);
  }

  async upsertFile(relativePath: string, content: string): Promise<void> {
    this.tracker.upsertCalls.push(relativePath);
    await fs.outputFile(path.join(this.remoteRoot, relativePath), content);
  }

  commitPendingChanges(): Promise<void> {
    this.tracker.commitCalls += 1;
    return Promise.resolve();
  }

  uploadFiles(
    absolutePaths: string[],
    rootDir: string,
  ): Promise<UploadResult> {
    return Promise.resolve({
      uploaded: [],
      unresolved: absolutePaths.map((absolutePath) => ({
        path: path.relative(rootDir, absolutePath).split(path.sep).join("/"),
        reason: "force text-file upsert path for batching test",
      })),
    });
  }

  async deletePath(relativePath: string): Promise<DeleteResult> {
    await fs.remove(path.join(this.remoteRoot, relativePath));
    return {
      path: relativePath,
      status: "deleted",
    };
  }

  submitPrompt(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class RecordingAdapter implements FigmaMakeAdapter {
  readonly kind = "recording-fixture";

  constructor(
    private readonly remoteRoot: string,
    private readonly tracker: Tracker,
    private readonly logger: Logger,
  ) {}

  authenticate(
    _url: string,
    _options?: AuthenticateBrowserSessionOptions,
  ): Promise<void> {
    void this.logger;
    void _url;
    void _options;
    return Promise.resolve();
  }

  openProject(): Promise<FigmaMakeProjectSession> {
    return Promise.resolve(
      new RecordingSession(this.remoteRoot, this.tracker),
    );
  }
}


async function setup(): Promise<{ service: FigmakeSyncService; projectDir: string; remoteDir: string; tracker: Tracker }> {
  const rootDir = await createTempDir("figmake-sync-review");
  const projectDir = path.join(rootDir, "project");
  const remoteDir = path.join(rootDir, "remote");
  const tracker: Tracker = { replaceCalls: [], upsertCalls: [], commitCalls: 0 };

  await fs.ensureDir(projectDir);
  await fs.outputFile(path.join(remoteDir, "src", "app.ts"), "export const value = 1;\n");
  await fs.outputFile(path.join(remoteDir, "src", "keep.ts"), "export const keep = 1;\nline two\n");
  await fs.outputFile(path.join(remoteDir, "src", "gone.ts"), "export const gone = 1;\n");
  await fs.outputFile(path.join(remoteDir, "package-lock.json"), "{}\n");

  const service = new FigmakeSyncService({
    adapterFactory: ({ logger }) => new RecordingAdapter(remoteDir, tracker, logger),
  });

  await service.init("https://www.figma.com/make/test-project", projectDir, { cwd: projectDir, yes: true });
  await service.pull({ cwd: projectDir, yes: true });

  return { service, projectDir, remoteDir, tracker };
}

describe("review and ignore", () => {
  it("lists changes with plain status and line counts, and returns before/after text", async () => {
    const { service, projectDir } = await setup();
    await fs.outputFile(path.join(projectDir, "src", "keep.ts"), "export const keep = 2;\nline two\nline three\n");
    await fs.outputFile(path.join(projectDir, "src", "new.ts"), "a\nb\n");
    await fs.remove(path.join(projectDir, "src", "gone.ts"));
    await fs.outputFile(path.join(projectDir, "package-lock.json"), "{\"changed\":true}\n");

    const { files } = await service.reviewChanges({ cwd: projectDir });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(Object.keys(byPath).sort()).toEqual(["src/gone.ts", "src/keep.ts", "src/new.ts"]);
    expect(byPath["src/keep.ts"]).toMatchObject({ status: "modified", added: 2, removed: 1, ignored: false });
    expect(byPath["src/new.ts"]).toMatchObject({ status: "added", added: 2, removed: 0 });
    expect(byPath["src/gone.ts"]).toMatchObject({ status: "deleted", removed: 1 });

    expect(await service.fileDiff({ cwd: projectDir, path: "src/keep.ts" })).toEqual({
      kind: "text",
      before: "export const keep = 1;\nline two\n",
      after: "export const keep = 2;\nline two\nline three\n",
    });
  });

  it("does not send an ignored modified file, and sends it again once unignored", async () => {
    const { service, projectDir, tracker } = await setup();
    await fs.outputFile(path.join(projectDir, "src", "app.ts"), "export const value = 2;\n");
    await fs.outputFile(path.join(projectDir, "src", "keep.ts"), "export const keep = 9;\n");

    await service.setIgnored({ cwd: projectDir, path: "src/app.ts", ignored: true });
    expect(await service.listIgnored({ cwd: projectDir })).toEqual(["src/app.ts"]);
    expect((await service.reviewChanges({ cwd: projectDir })).files.find((f) => f.path === "src/app.ts")?.ignored).toBe(true);

    await service.push({ cwd: projectDir, yes: true });
    expect(tracker.replaceCalls).toEqual(["src/keep.ts"]);

    await service.setIgnored({ cwd: projectDir, path: "src/app.ts", ignored: false });
    expect(await service.listIgnored({ cwd: projectDir })).toEqual([]);
    const status = await service.status({ cwd: projectDir });
    expect(status.diff?.modified.map((m) => m.current.path)).toEqual(["src/app.ts"]);

    await service.push({ cwd: projectDir, yes: true });
    expect(tracker.replaceCalls).toEqual(["src/keep.ts", "src/app.ts"]);
  });

  it("never deletes an ignored file in Figma, even when it is gone locally or was ignored before it changed", async () => {
    const { service, projectDir, remoteDir } = await setup();

    // Ignored, then removed locally: must not look deleted.
    await service.setIgnored({ cwd: projectDir, path: "src/gone.ts", ignored: true });
    await fs.remove(path.join(projectDir, "src", "gone.ts"));
    await fs.outputFile(path.join(projectDir, "src", "app.ts"), "export const value = 3;\n");

    const status = await service.status({ cwd: projectDir });
    expect(status.diff?.deleted).toEqual([]);

    await service.push({ cwd: projectDir, yes: true });
    expect(await fs.pathExists(path.join(remoteDir, "src", "gone.ts"))).toBe(true);

    // The baseline keeps the entry, so a later push still does not delete it.
    await service.push({ cwd: projectDir, yes: true });
    expect(await fs.pathExists(path.join(remoteDir, "src", "gone.ts"))).toBe(true);

    // Sent again: now the deletion shows up as a real change.
    await service.setIgnored({ cwd: projectDir, path: "src/gone.ts", ignored: false });
    expect((await service.status({ cwd: projectDir })).diff?.deleted.map((e) => e.path)).toEqual(["src/gone.ts"]);
  });

  it("keeps default ignores untouched", async () => {
    const { service, projectDir } = await setup();
    await service.setIgnored({ cwd: projectDir, path: "src/app.ts", ignored: true });
    const config = JSON.parse(await fs.readFile(path.join(projectDir, ".figmake-sync", "config.json"), "utf8")) as { sync: { ignore: string[]; userIgnore: string[] } };

    expect(config.sync.ignore).toEqual([...DEFAULT_IGNORE_PATTERNS]);
    expect(config.sync.ignore).not.toContain("src/app.ts");
    expect(config.sync.userIgnore).toEqual(["src/app.ts"]);
  });
});
