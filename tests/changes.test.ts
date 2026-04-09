import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { createTextPatchPreview } from "../src/diff/changes.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

describe("createTextPatchPreview", () => {
  it("returns a unified diff patch for two differing files", async () => {
    const dir = await createTempDir("figmake-changes");
    const remotePath = path.join(dir, "remote.ts");
    const localPath = path.join(dir, "local.ts");

    await fs.outputFile(remotePath, "export const value = 1;\n");
    await fs.outputFile(localPath, "export const value = 2;\n");

    const patch = await createTextPatchPreview(
      remotePath,
      localPath,
      "src/app.ts",
    );

    expect(patch).toBeTruthy();
    expect(patch).toContain("src/app.ts");
    expect(patch).toContain("-export const value = 1;");
    expect(patch).toContain("+export const value = 2;");
  });

  it("returns undefined when the remote file does not exist", async () => {
    const dir = await createTempDir("figmake-changes-noremote");
    const localPath = path.join(dir, "local.ts");

    await fs.outputFile(localPath, "export const value = 1;\n");

    const patch = await createTextPatchPreview(
      path.join(dir, "nonexistent.ts"),
      localPath,
      "src/app.ts",
    );

    expect(patch).toBeUndefined();
  });

  it("returns undefined when the local file does not exist", async () => {
    const dir = await createTempDir("figmake-changes-nolocal");
    const remotePath = path.join(dir, "remote.ts");

    await fs.outputFile(remotePath, "export const value = 1;\n");

    const patch = await createTextPatchPreview(
      remotePath,
      path.join(dir, "nonexistent.ts"),
      "src/app.ts",
    );

    expect(patch).toBeUndefined();
  });

  it("returns a patch for identical files (empty diff body)", async () => {
    const dir = await createTempDir("figmake-changes-same");
    const content = "export const value = 1;\n";
    const remotePath = path.join(dir, "remote.ts");
    const localPath = path.join(dir, "local.ts");

    await fs.outputFile(remotePath, content);
    await fs.outputFile(localPath, content);

    const patch = await createTextPatchPreview(
      remotePath,
      localPath,
      "src/same.ts",
    );

    expect(patch).toBeTruthy();
    expect(patch).toContain("src/same.ts");
    expect(patch).not.toContain("@@");
  });

  it("truncates very long diffs to 80 lines", async () => {
    const dir = await createTempDir("figmake-changes-long");
    const remoteContent = Array.from(
      { length: 100 },
      (_, index) => `const r${index} = ${index};`,
    ).join("\n");
    const localContent = Array.from(
      { length: 100 },
      (_, index) => `const l${index} = ${index};`,
    ).join("\n");

    const remotePath = path.join(dir, "remote.ts");
    const localPath = path.join(dir, "local.ts");

    await fs.outputFile(remotePath, remoteContent);
    await fs.outputFile(localPath, localContent);

    const patch = await createTextPatchPreview(
      remotePath,
      localPath,
      "src/long.ts",
    );

    expect(patch?.split("\n").length).toBeLessThanOrEqual(80);
  });
});
