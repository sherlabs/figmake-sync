import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import {
  createZipFromDirectory,
  extractZipSafely,
} from "../src/utils/archive.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

describe("createZipFromDirectory", () => {
  it("creates a zip file at the destination path", async () => {
    const sourceDir = await createTempDir("figmake-zip-src");
    const outputDir = await createTempDir("figmake-zip-out");

    await fs.outputFile(path.join(sourceDir, "hello.txt"), "hello");
    const zipPath = path.join(outputDir, "archive.zip");

    const result = await createZipFromDirectory(sourceDir, zipPath);

    expect(result).toBe(zipPath);
    expect(await fs.pathExists(zipPath)).toBe(true);
  });

  it("creates the destination directory if it does not exist", async () => {
    const sourceDir = await createTempDir("figmake-zip-src2");
    const outputDir = await createTempDir("figmake-zip-out2");

    await fs.outputFile(path.join(sourceDir, "file.ts"), "export {};");
    const zipPath = path.join(outputDir, "nested", "out.zip");

    await createZipFromDirectory(sourceDir, zipPath);

    expect(await fs.pathExists(zipPath)).toBe(true);
  });
});

describe("extractZipSafely", () => {
  it("extracts files from a zip into the target directory", async () => {
    const sourceDir = await createTempDir("figmake-extract-src");
    const zipDir = await createTempDir("figmake-extract-zip");
    const targetDir = await createTempDir("figmake-extract-target");

    await fs.outputFile(path.join(sourceDir, "src", "app.ts"), "export {};");
    await fs.outputFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    const zipPath = path.join(zipDir, "test.zip");
    await createZipFromDirectory(sourceDir, zipPath);

    const extractedFiles = await extractZipSafely(zipPath, targetDir);

    expect(extractedFiles).toContain("src/app.ts");
    expect(extractedFiles).toContain("package.json");
    expect(
      await fs.readFile(path.join(targetDir, "src", "app.ts"), "utf8"),
    ).toBe("export {};");
  });

  it("empties the target directory before extracting", async () => {
    const sourceDir = await createTempDir("figmake-extract-empty-src");
    const zipDir = await createTempDir("figmake-extract-empty-zip");
    const targetDir = await createTempDir("figmake-extract-empty-target");

    await fs.outputFile(path.join(sourceDir, "new.ts"), "export const n = 1;");
    await fs.outputFile(path.join(targetDir, "old.ts"), "export const o = 0;");

    const zipPath = path.join(zipDir, "new.zip");
    await createZipFromDirectory(sourceDir, zipPath);

    await extractZipSafely(zipPath, targetDir);

    expect(await fs.pathExists(path.join(targetDir, "old.ts"))).toBe(false);
    expect(await fs.pathExists(path.join(targetDir, "new.ts"))).toBe(true);
  });

  it("returns a sorted list of extracted file paths", async () => {
    const sourceDir = await createTempDir("figmake-extract-sort-src");
    const zipDir = await createTempDir("figmake-extract-sort-zip");
    const targetDir = await createTempDir("figmake-extract-sort-target");

    await fs.outputFile(path.join(sourceDir, "z.ts"), "z");
    await fs.outputFile(path.join(sourceDir, "a.ts"), "a");

    const zipPath = path.join(zipDir, "sorted.zip");
    await createZipFromDirectory(sourceDir, zipPath);

    const extractedFiles = await extractZipSafely(zipPath, targetDir);

    expect(extractedFiles).toEqual([...extractedFiles].sort());
  });

  it("round-trips directory contents through a zip", async () => {
    const sourceDir = await createTempDir("figmake-roundtrip-src");
    const zipDir = await createTempDir("figmake-roundtrip-zip");
    const targetDir = await createTempDir("figmake-roundtrip-target");
    const content = "export const value = 42;\n";

    await fs.outputFile(path.join(sourceDir, "src", "index.ts"), content);

    const zipPath = path.join(zipDir, "roundtrip.zip");
    await createZipFromDirectory(sourceDir, zipPath);

    await extractZipSafely(zipPath, targetDir);

    const extracted = await fs.readFile(
      path.join(targetDir, "src", "index.ts"),
      "utf8",
    );

    expect(extracted).toBe(content);
  });
});
