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
import type { PushProgress } from "../src/types/config.js";
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
  failCommit?: boolean;
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
    return this.tracker.failCommit ? Promise.reject(new Error("save failed")) : Promise.resolve();
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

describe("push batching", () => {
  it("commits after each replaced or created file (one transaction per file)", async () => {
    const rootDir = await createTempDir("figmake-sync-batch");
    const projectDir = path.join(rootDir, "project");
    const remoteDir = path.join(rootDir, "remote");
    const tracker: Tracker = {
      replaceCalls: [],
      upsertCalls: [],
      commitCalls: 0,
    };

    await fs.ensureDir(projectDir);
    await fs.ensureDir(remoteDir);
    await fs.outputFile(
      path.join(remoteDir, "src", "app.ts"),
      "export const value = 1;\n",
    );

    const service = new FigmakeSyncService({
      adapterFactory: ({ logger }) =>
        new RecordingAdapter(remoteDir, tracker, logger),
    });

    await service.init("https://www.figma.com/make/test-project", projectDir, {
      cwd: projectDir,
      yes: true,
    });

    await service.pull({
      cwd: projectDir,
      yes: true,
    });

    await fs.outputFile(
      path.join(projectDir, "src", "app.ts"),
      "export const value = 2;\n",
    );
    await fs.outputFile(
      path.join(projectDir, "src", "new.ts"),
      "export const added = true;\n",
    );

    const pushResult = await service.push({
      cwd: projectDir,
      yes: true,
    });

    expect(pushResult.unresolved).toHaveLength(0);
    expect(tracker.replaceCalls).toEqual(["src/app.ts"]);
    expect(tracker.upsertCalls).toEqual(["src/new.ts"]);
    // Every file is its own transaction: settled (committed) before the next one starts.
    expect(tracker.commitCalls).toBe(2);
    expect(pushResult.verified).toBe(2);
  });

  async function setup(tracker: Tracker): Promise<{ service: FigmakeSyncService; projectDir: string }> {
    const rootDir = await createTempDir("figmake-sync-progress");
    const projectDir = path.join(rootDir, "project");
    const remoteDir = path.join(rootDir, "remote");

    await fs.ensureDir(projectDir);
    await fs.outputFile(path.join(remoteDir, "src", "app.ts"), "export const value = 1;\n");
    await fs.outputFile(path.join(remoteDir, "src", "old.ts"), "export const old = 1;\n");

    const service = new FigmakeSyncService({
      adapterFactory: ({ logger }) => new RecordingAdapter(remoteDir, tracker, logger),
    });

    await service.init("https://www.figma.com/make/test-project", projectDir, { cwd: projectDir, yes: true });
    await service.pull({ cwd: projectDir, yes: true });
    await fs.outputFile(path.join(projectDir, "src", "app.ts"), "export const value = 2;\n");
    await fs.outputFile(path.join(projectDir, "src", "new.ts"), "export const added = true;\n");
    await fs.remove(path.join(projectDir, "src", "old.ts"));

    return { service, projectDir };
  }

  it("reports structured progress: real counts, monotonic percent, 100% only at the end", async () => {
    const tracker: Tracker = { replaceCalls: [], upsertCalls: [], commitCalls: 0 };
    const { service, projectDir } = await setup(tracker);
    const events: PushProgress[] = [];

    const result = await service.push({ cwd: projectDir, yes: true, onProgress: (p) => events.push(p) });

    expect(result.unresolved).toHaveLength(0);
    expect(events[0]).toMatchObject({ phase: "checking", percent: 0 });
    const sending = events.filter((e) => e.phase === "sending");
    expect(new Set(sending.map((e) => e.total))).toEqual(new Set([3]));
    // New files go first (importers never point at a missing module), then replaces, deletes last.
    expect(sending.filter((e) => e.file && !e.finished).map((e) => [e.op, e.file, e.index])).toEqual([
      ["create", "src/new.ts", 1],
      ["replace", "src/app.ts", 2],
      ["delete", "src/old.ts", 3],
    ]);
    expect(sending.filter((e) => e.finished).map((e) => [e.finished?.file, e.finished?.ok, e.completed])).toEqual([
      ["src/new.ts", true, 1],
      ["src/app.ts", true, 2],
      ["src/old.ts", true, 3],
    ]);
    const percents = events.map((e) => e.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(percents.slice(0, -1).every((v) => v < 100)).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "saving", percent: 100, completed: 3, total: 3 });
    // A running file is in progress, never already counted as done.
    expect(sending.find((e) => e.file === "src/new.ts" && !e.finished)?.completed).toBe(0);
  });

  it("stops at the first failed file (never 100%), lists what is still waiting, and a throwing listener changes nothing", async () => {
    const tracker: Tracker = { replaceCalls: [], upsertCalls: [], commitCalls: 0, failCommit: true };
    const { service, projectDir } = await setup(tracker);
    const events: PushProgress[] = [];

    const result = await service.push({ cwd: projectDir, yes: true, onProgress: (p) => { events.push(p); throw new Error("listener bug"); } });
    expect(result.stopped).toMatchObject({ phase: "sending", remaining: 2 });
    expect(result.unresolved.map((u) => [u.path, u.code])).toEqual([
      ["src/new.ts", "PUSH_OP_FAILED"],
      ["src/app.ts", "STOPPED"],
      ["src/old.ts", "STOPPED"],
    ]);
    // Only the first file was attempted (retried, then stopped): nothing after it was touched.
    expect(tracker.replaceCalls).toEqual([]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.percent === 100)).toBe(false);
    expect(events.at(-1)?.stopped).toMatchObject({ remaining: 2 });
  }, 20_000);
});
