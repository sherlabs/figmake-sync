import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { describe, expect, it } from "vitest";

import { createManifest, diffManifests } from "../src/diff/manifest.js";
import { projectConfigSchema, renderPostUploadPrompt } from "../src/types/config.js";
import { assertPathInsideRoot } from "../src/utils/path.js";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "figmake-diff-"));
}

describe("diff hardening", () => {
  it("always applies default ignores at any depth, merged with user ignores", async () => {
    const dir = await tmp();
    await fs.outputFile(path.join(dir, "a.ts"), "x");
    await fs.outputFile(path.join(dir, "pkg/node_modules/m/i.js"), "x");
    await fs.outputFile(path.join(dir, "pkg/dist/o.js"), "x");
    await fs.outputFile(path.join(dir, "pkg/.DS_Store"), "x");
    await fs.outputFile(path.join(dir, ".git/HEAD"), "x");
    await fs.outputFile(path.join(dir, ".figmake-sync/browser-profile/c"), "x");
    await fs.outputFile(path.join(dir, "x.log"), "x");
    const m = await createManifest(dir, { ignore: ["*.log"] });
    expect(m.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("schema keeps defaults when user supplies ignore", () => {
    const cfg = projectConfigSchema.parse({
      version: 1, projectId: "12345678", figmaMakeUrl: "https://x.com/a",
      localRoot: "/x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sync: { ignore: ["*.log"] },
    });
    expect(cfg.sync.ignore).toContain(".git/**");
    expect(cfg.sync.ignore).toContain("*.log");
  });

  it("CRLF-only change is not a modification; raw bytes hashed", async () => {
    const a = await tmp();
    const b = await tmp();
    await fs.writeFile(path.join(a, "f.txt"), "a\r\nb\r\n");
    await fs.writeFile(path.join(b, "f.txt"), "a\nb\n");
    await fs.writeFile(path.join(a, "g.txt"), Buffer.from([0xe9]));
    await fs.writeFile(path.join(b, "g.txt"), Buffer.from([0xea]));
    const d = diffManifests(await createManifest(a), await createManifest(b));
    expect(d.modified.map((x) => x.current.path)).toEqual(["g.txt"]);
    expect(d.unchanged.map((x) => x.path)).toEqual(["f.txt"]);
  });

  it("path guard allows ..names, rejects escapes and symlink escapes", async () => {
    const root = await tmp();
    const outside = await tmp();
    expect(() => assertPathInsideRoot(root, path.join(root, "..hidden", "a"))).not.toThrow();
    expect(() => assertPathInsideRoot(root, path.join(root, "..", "x"))).toThrow();
    await fs.symlink(outside, path.join(root, "link"));
    expect(() => assertPathInsideRoot(root, path.join(root, "link", "f"))).toThrow();
  });

  it("renderPostUploadPrompt keeps $ sequences", () => {
    expect(renderPostUploadPrompt("{{files}}", ["routes/$$layout.tsx"])).toBe("- routes/$$layout.tsx");
  });
});
