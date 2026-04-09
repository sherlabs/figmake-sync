import path from "node:path";

import fs from "fs-extra";
import type { Logger } from "pino";

import type { AuthenticateBrowserSessionOptions } from "../../src/browser/session.js";
import type {
  DeleteResult,
  DownloadResult,
  FigmaMakeAdapter,
  FigmaMakeProjectSession,
  UploadResult,
} from "../../src/figma/adapter.js";
import { createZipFromDirectory } from "../../src/utils/archive.js";

class LocalFixtureSession implements FigmaMakeProjectSession {
  constructor(
    private readonly remoteRoot: string,
    private readonly logger: Logger,
  ) {}

  async downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult> {
    const zipPath = path.join(destinationDir, "fixture-remote.zip");

    await createZipFromDirectory(this.remoteRoot, zipPath);
    return {
      zipPath,
      suggestedFileName: "fixture-remote.zip",
    };
  }

  async replaceFileContents(
    relativePath: string,
    content: string,
  ): Promise<void> {
    await fs.outputFile(path.join(this.remoteRoot, relativePath), content);
  }

  async upsertFile(relativePath: string, content: string): Promise<void> {
    await fs.outputFile(path.join(this.remoteRoot, relativePath), content);
  }

  async commitPendingChanges(): Promise<void> {
    return Promise.resolve();
  }

  async uploadFiles(
    absolutePaths: string[],
    rootDir: string,
  ): Promise<UploadResult> {
    const uploaded: string[] = [];

    for (const absolutePath of absolutePaths) {
      const relativePath = path.relative(rootDir, absolutePath);
      await fs.copyFile(absolutePath, path.join(this.remoteRoot, relativePath));
      uploaded.push(relativePath.split(path.sep).join(path.posix.sep));
    }

    return {
      uploaded,
      unresolved: [],
    };
  }

  async deletePath(relativePath: string): Promise<DeleteResult> {
    await fs.remove(path.join(this.remoteRoot, relativePath));
    return {
      path: relativePath,
      status: "deleted",
    };
  }

  submitPrompt(message: string): Promise<boolean> {
    this.logger.info({ message }, "fixture adapter recorded prompt");
    return Promise.resolve(true);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

export class LocalFixtureAdapter implements FigmaMakeAdapter {
  readonly kind = "fixture";

  constructor(
    private readonly remoteRoot: string,
    private readonly logger: Logger,
  ) {}

  async authenticate(
    _url: string,
    _options?: AuthenticateBrowserSessionOptions,
  ): Promise<void> {
    void _url;
    void _options;
    return Promise.resolve();
  }

  openProject(): Promise<FigmaMakeProjectSession> {
    return Promise.resolve(
      new LocalFixtureSession(this.remoteRoot, this.logger),
    );
  }
}
