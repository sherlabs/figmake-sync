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

describe("push batching", () => {
  it("flushes text editor changes once after replacing and creating files", async () => {
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
    expect(tracker.commitCalls).toBe(1);
  });
});
