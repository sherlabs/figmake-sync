import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildThreeWayMergeFoundation,
  createManifest,
  diffManifests,
} from "../src/diff/manifest.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

describe("manifest", () => {
  it("normalizes line endings for text hashes", async () => {
    const rootDir = await createTempDir("figmake-manifest");

    await fs.outputFile(path.join(rootDir, "src", "app.ts"), "line1\nline2\n");
    const lfManifest = await createManifest(rootDir, {
      ignore: [".figmake-sync/**"],
    });

    await fs.outputFile(
      path.join(rootDir, "src", "app.ts"),
      "line1\r\nline2\r\n",
    );
    const crlfManifest = await createManifest(rootDir, {
      ignore: [".figmake-sync/**"],
    });

    expect(lfManifest.files[0]?.normalizedHash).toBe(
      crlfManifest.files[0]?.normalizedHash,
    );
    expect(lfManifest.files[0]?.contentHash).not.toBe(
      crlfManifest.files[0]?.contentHash,
    );
  });

  it("detects renames by content hash", async () => {
    const baseDir = await createTempDir("figmake-base");
    const currentDir = await createTempDir("figmake-current");

    await fs.outputFile(
      path.join(baseDir, "src", "old-name.ts"),
      "export const value = 1;\n",
    );
    await fs.outputFile(
      path.join(currentDir, "src", "new-name.ts"),
      "export const value = 1;\n",
    );

    const baseManifest = await createManifest(baseDir);
    const currentManifest = await createManifest(currentDir);
    const diff = diffManifests(baseManifest, currentManifest);

    expect(diff.renamed).toEqual([
      {
        from: "src/old-name.ts",
        to: "src/new-name.ts",
        match: "contentHash",
      },
    ]);
  });

  it("builds conservative three-way merge decisions", async () => {
    const baseDir = await createTempDir("figmake-merge-base");
    const localDir = await createTempDir("figmake-merge-local");
    const remoteDir = await createTempDir("figmake-merge-remote");

    await fs.outputFile(
      path.join(baseDir, "src", "app.ts"),
      "export const value = 1;\n",
    );
    await fs.copy(baseDir, localDir);
    await fs.copy(baseDir, remoteDir);

    await fs.outputFile(
      path.join(localDir, "src", "app.ts"),
      "export const value = 2;\n",
    );
    await fs.outputFile(
      path.join(remoteDir, "src", "app.ts"),
      "export const value = 3;\n",
    );
    await fs.outputFile(
      path.join(remoteDir, "src", "remote-only.ts"),
      "export const remote = true;\n",
    );

    const decisions = buildThreeWayMergeFoundation(
      await createManifest(baseDir),
      await createManifest(localDir),
      await createManifest(remoteDir),
    );

    expect(
      decisions.find((entry) => entry.path === "src/app.ts")?.resolution,
    ).toBe("conflict");
    expect(
      decisions.find((entry) => entry.path === "src/remote-only.ts")
        ?.resolution,
    ).toBe("take-remote");
  });
});
