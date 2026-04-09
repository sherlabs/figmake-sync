import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { FigmakeSyncService } from "../src/core/service.js";
import { LocalFixtureAdapter } from "./support/localFixtureAdapter.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

describe("figmake sync smoke flow", () => {
  it("runs init, pull, status, push, and verify against a fixture adapter", async () => {
    const rootDir = await createTempDir("figmake-sync-smoke");
    const projectDir = path.join(rootDir, "project");
    const remoteDir = path.join(rootDir, "remote");

    await fs.ensureDir(projectDir);
    await fs.ensureDir(remoteDir);
    await fs.outputFile(
      path.join(remoteDir, "src", "app.ts"),
      "export const value = 1;\n",
    );
    await fs.outputJson(
      path.join(remoteDir, "package.json"),
      { name: "fixture-remote" },
      { spaces: 2 },
    );

    const service = new FigmakeSyncService({
      adapterFactory: ({ logger }) =>
        new LocalFixtureAdapter(remoteDir, logger),
    });

    await service.init("https://www.figma.com/make/test-project", projectDir, {
      cwd: projectDir,
      yes: true,
    });

    const pullResult = await service.pull({
      cwd: projectDir,
      yes: true,
    });

    expect(pullResult.extractedFiles).toBe(2);
    expect(await fs.pathExists(path.join(projectDir, "src", "app.ts"))).toBe(
      true,
    );

    await fs.outputFile(
      path.join(projectDir, "src", "app.ts"),
      "export const value = 2;\n",
    );
    await fs.outputFile(
      path.join(projectDir, "src", "new.ts"),
      "export const added = true;\n",
    );

    const statusResult = await service.status({
      cwd: projectDir,
    });

    expect(statusResult.summary.modified).toBe(1);
    expect(statusResult.summary.added).toBe(1);

    const pushResult = await service.push({
      cwd: projectDir,
      yes: true,
      prompt: true,
    });

    expect(pushResult.unresolved).toHaveLength(0);

    const postPushStatus = await service.status({
      cwd: projectDir,
    });

    expect(postPushStatus.summary.total).toBe(0);

    const verifyResult = await service.verify({
      cwd: projectDir,
    });

    expect(verifyResult.drift.summary.total).toBe(0);
  });
});
