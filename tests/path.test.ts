import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPathInsideRoot,
  normalizeRelativePath,
  resolveRelativePath,
  toPosixPath,
} from "../src/utils/path.js";

describe("toPosixPath", () => {
  it("returns the path unchanged on posix systems", () => {
    expect(toPosixPath("src/app.ts")).toBe("src/app.ts");
  });

  it("handles an already-posix path with multiple segments", () => {
    expect(toPosixPath("a/b/c/d.ts")).toBe("a/b/c/d.ts");
  });

  it("returns an empty string unchanged", () => {
    expect(toPosixPath("")).toBe("");
  });
});

describe("resolveRelativePath", () => {
  it("resolves a relative path against a root directory", () => {
    const rootDir = "/tmp/project";
    const result = resolveRelativePath(rootDir, "src/app.ts");

    expect(result).toBe(path.resolve(rootDir, "src/app.ts"));
  });

  it("resolves a path already expressed as absolute", () => {
    const rootDir = "/tmp/project";
    const absolutePath = "/tmp/project/src/app.ts";
    const result = resolveRelativePath(rootDir, absolutePath);

    expect(result).toBe(absolutePath);
  });
});

describe("assertPathInsideRoot", () => {
  it("returns the resolved candidate path when it is inside the root", () => {
    const rootDir = "/tmp/project";
    const candidatePath = "/tmp/project/src/app.ts";

    expect(assertPathInsideRoot(rootDir, candidatePath)).toBe(
      path.resolve(candidatePath),
    );
  });

  it("throws when the candidate path escapes the root via ..", () => {
    const rootDir = "/tmp/project";
    const escapingPath = "/tmp/project/../../etc/passwd";

    expect(() => assertPathInsideRoot(rootDir, escapingPath)).toThrow(
      "Refusing to operate outside project root",
    );
  });

  it("throws when the candidate path is completely outside the root", () => {
    const rootDir = "/tmp/project";
    const outsidePath = "/tmp/other/file.ts";

    expect(() => assertPathInsideRoot(rootDir, outsidePath)).toThrow(
      "Refusing to operate outside project root",
    );
  });

  it("accepts a path that is the root itself", () => {
    const rootDir = "/tmp/project";

    expect(assertPathInsideRoot(rootDir, rootDir)).toBe(
      path.resolve(rootDir),
    );
  });
});

describe("normalizeRelativePath", () => {
  it("returns a posix-style relative path from root to absolute path", () => {
    const rootDir = "/tmp/project";
    const absolutePath = "/tmp/project/src/app.ts";

    expect(normalizeRelativePath(rootDir, absolutePath)).toBe("src/app.ts");
  });

  it("handles nested subdirectories", () => {
    const rootDir = "/tmp/project";
    const absolutePath = "/tmp/project/src/utils/path.ts";

    expect(normalizeRelativePath(rootDir, absolutePath)).toBe(
      "src/utils/path.ts",
    );
  });
});
