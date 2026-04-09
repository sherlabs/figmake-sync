import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHashIndex,
  createManifest,
  diffManifests,
  hasManifestChanges,
  summarizeManifestDiff,
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

describe("createManifest – additional cases", () => {
  it("returns an empty files array for an empty directory", async () => {
    const rootDir = await createTempDir("figmake-manifest-empty");

    const manifest = await createManifest(rootDir);

    expect(manifest.files).toHaveLength(0);
    expect(manifest.schemaVersion).toBe(1);
  });

  it("records isBinary=true and lineEnding='binary' for binary files", async () => {
    const rootDir = await createTempDir("figmake-manifest-binary");

    const binaryBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await fs.outputFile(path.join(rootDir, "image.png"), binaryBuffer);

    const manifest = await createManifest(rootDir);
    const entry = manifest.files.find((f) => f.path === "image.png");

    expect(entry?.isBinary).toBe(true);
    expect(entry?.lineEnding).toBe("binary");
    expect(entry?.contentHash).toBe(entry?.normalizedHash);
  });

  it("records isBinary=false and lineEnding='lf' for Unix text files", async () => {
    const rootDir = await createTempDir("figmake-manifest-lf");

    await fs.outputFile(path.join(rootDir, "file.ts"), "const a = 1;\n");

    const manifest = await createManifest(rootDir);
    const entry = manifest.files[0];

    expect(entry?.isBinary).toBe(false);
    expect(entry?.lineEnding).toBe("lf");
  });

  it("records lineEnding='mixed' for CRLF files (CRLF also contains LF)", async () => {
    const rootDir = await createTempDir("figmake-manifest-crlf");

    await fs.outputFile(path.join(rootDir, "file.ts"), "const a = 1;\r\n");

    const manifest = await createManifest(rootDir);
    const entry = manifest.files[0];

    // CRLF contains \n so both hasLf and hasCrLf are true → "mixed"
    expect(entry?.lineEnding).toBe("mixed");
  });

  it("records lineEnding='none' for files with no newlines", async () => {
    const rootDir = await createTempDir("figmake-manifest-no-newline");

    await fs.outputFile(path.join(rootDir, "file.txt"), "no newline here");

    const manifest = await createManifest(rootDir);
    const entry = manifest.files[0];

    expect(entry?.lineEnding).toBe("none");
  });

  it("excludes files that match ignore patterns", async () => {
    const rootDir = await createTempDir("figmake-manifest-ignore");

    await fs.outputFile(path.join(rootDir, "keep.ts"), "keep");
    await fs.outputFile(
      path.join(rootDir, "node_modules", "dep.ts"),
      "dep",
    );

    const manifest = await createManifest(rootDir, {
      ignore: ["node_modules/**"],
    });

    const paths = manifest.files.map((f) => f.path);

    expect(paths).toContain("keep.ts");
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
  });

  it("files list is sorted alphabetically by path", async () => {
    const rootDir = await createTempDir("figmake-manifest-sorted");

    await fs.outputFile(path.join(rootDir, "z.ts"), "z");
    await fs.outputFile(path.join(rootDir, "a.ts"), "a");
    await fs.outputFile(path.join(rootDir, "m.ts"), "m");

    const manifest = await createManifest(rootDir);
    const paths = manifest.files.map((f) => f.path);

    expect(paths).toEqual([...paths].sort());
  });
});

describe("diffManifests – additional cases", () => {
  it("reports deleted files", async () => {
    const baseDir = await createTempDir("figmake-diff-deleted-base");
    const currentDir = await createTempDir("figmake-diff-deleted-current");

    await fs.outputFile(path.join(baseDir, "gone.ts"), "deleted");

    const baseMf = await createManifest(baseDir);
    const currentMf = await createManifest(currentDir);
    const diff = diffManifests(baseMf, currentMf);

    expect(diff.deleted.map((e) => e.path)).toContain("gone.ts");
  });

  it("reports unchanged files", async () => {
    const dir = await createTempDir("figmake-diff-unchanged");

    await fs.outputFile(path.join(dir, "same.ts"), "same");

    const mf = await createManifest(dir);
    const diff = diffManifests(mf, mf);

    expect(diff.unchanged.map((e) => e.path)).toContain("same.ts");
    expect(diff.modified).toHaveLength(0);
  });

  it("reports modified files", async () => {
    const baseDir = await createTempDir("figmake-diff-mod-base");
    const currentDir = await createTempDir("figmake-diff-mod-current");

    await fs.outputFile(path.join(baseDir, "file.ts"), "v1");
    await fs.outputFile(path.join(currentDir, "file.ts"), "v2");

    const baseMf = await createManifest(baseDir);
    const currentMf = await createManifest(currentDir);
    const diff = diffManifests(baseMf, currentMf);

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]?.current.path).toBe("file.ts");
  });

  it("detects renames via normalizedHash (line ending change)", async () => {
    const baseDir = await createTempDir("figmake-diff-rename-norm-base");
    const currentDir = await createTempDir("figmake-diff-rename-norm-current");

    await fs.outputFile(
      path.join(baseDir, "old.ts"),
      "export const x = 1;\n",
    );
    await fs.outputFile(
      path.join(currentDir, "new.ts"),
      "export const x = 1;\r\n",
    );

    const baseMf = await createManifest(baseDir);
    const currentMf = await createManifest(currentDir);
    const diff = diffManifests(baseMf, currentMf);

    const renamed = diff.renamed.find((r) => r.from === "old.ts");

    expect(renamed).toBeDefined();
    expect(renamed?.to).toBe("new.ts");
    expect(renamed?.match).toBe("normalizedHash");
  });
});

describe("summarizeManifestDiff", () => {
  it("returns zeroes when there are no changes", async () => {
    const dir = await createTempDir("figmake-summarize-noop");

    await fs.outputFile(path.join(dir, "file.ts"), "v1");

    const mf = await createManifest(dir);
    const diff = diffManifests(mf, mf);
    const summary = summarizeManifestDiff(diff);

    expect(summary).toEqual({
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      total: 0,
    });
  });

  it("totals all change categories correctly", async () => {
    const baseDir = await createTempDir("figmake-summarize-base");
    const currentDir = await createTempDir("figmake-summarize-current");

    await fs.outputFile(path.join(baseDir, "deleted.ts"), "del");
    await fs.outputFile(path.join(baseDir, "modified.ts"), "v1");
    await fs.copy(baseDir, currentDir);
    await fs.remove(path.join(currentDir, "deleted.ts"));
    await fs.outputFile(path.join(currentDir, "modified.ts"), "v2");
    await fs.outputFile(path.join(currentDir, "added.ts"), "new");

    const baseMf = await createManifest(baseDir);
    const currentMf = await createManifest(currentDir);
    const diff = diffManifests(baseMf, currentMf);
    const summary = summarizeManifestDiff(diff);

    expect(summary.added).toBe(1);
    expect(summary.modified).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(summary.total).toBe(3);
  });
});

describe("hasManifestChanges", () => {
  it("returns false when there are no changes", async () => {
    const dir = await createTempDir("figmake-has-changes-false");

    await fs.outputFile(path.join(dir, "file.ts"), "v1");

    const mf = await createManifest(dir);
    const diff = diffManifests(mf, mf);

    expect(hasManifestChanges(diff)).toBe(false);
  });

  it("returns true when there are changes", async () => {
    const baseDir = await createTempDir("figmake-has-changes-true-base");
    const currentDir = await createTempDir("figmake-has-changes-true-current");

    await fs.outputFile(path.join(baseDir, "file.ts"), "v1");
    await fs.outputFile(path.join(currentDir, "file.ts"), "v2");

    const baseMf = await createManifest(baseDir);
    const currentMf = await createManifest(currentDir);
    const diff = diffManifests(baseMf, currentMf);

    expect(hasManifestChanges(diff)).toBe(true);
  });
});

describe("createHashIndex", () => {
  it("returns a map of relative paths to hash pairs", async () => {
    const dir = await createTempDir("figmake-hash-index");

    await fs.outputFile(path.join(dir, "a.ts"), "aaa");
    await fs.outputFile(path.join(dir, "b.ts"), "bbb");

    const mf = await createManifest(dir);
    const index = createHashIndex(mf);

    expect(Object.keys(index)).toContain("a.ts");
    expect(Object.keys(index)).toContain("b.ts");
    expect(index["a.ts"]).toHaveProperty("contentHash");
    expect(index["a.ts"]).toHaveProperty("normalizedHash");
    expect(index["a.ts"]?.contentHash).not.toBe(index["b.ts"]?.contentHash);
  });

  it("returns an empty object for an empty manifest", async () => {
    const dir = await createTempDir("figmake-hash-index-empty");
    const mf = await createManifest(dir);
    const index = createHashIndex(mf);

    expect(index).toEqual({});
  });
});
