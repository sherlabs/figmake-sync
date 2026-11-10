import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { describe, expect, it } from "vitest";

import { describeFolders, fileRows, listChangedFiles } from "../src/app/changes.js";

describe("fileRows", () => {
  it("pairs removed and added lines and collapses far context into a hunk", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 15", "LINE 15");
    const { rows, binary, truncated } = fileRows(before, after, { context: 2 });
    expect(binary).toBe(false);
    expect(truncated).toBe(false);
    expect(rows[0]?.hunk).toBe("Lines 1 to 12");
    const changed = rows.find((r) => r.left?.mark === "del");
    expect(changed?.left).toEqual({ n: 15, text: "line 15", mark: "del" });
    expect(changed?.right).toEqual({ n: 15, text: "LINE 15", mark: "add" });
    expect(rows.at(-1)?.hunk).toBe("Lines 18 to 30");
  });

  it("shows added and removed files, one-sided", () => {
    expect(fileRows(null, "a\nb\n").rows.map((r) => [r.left, r.right?.mark])).toEqual([[null, "add"], [null, "add"]]);
    expect(fileRows("a\n", null).rows.map((r) => [r.left?.mark, r.right])).toEqual([["del", null]]);
  });

  it("flags binary and oversized content with no rows", () => {
    expect(fileRows(Buffer.from([1, 0, 2]), "x")).toEqual({ rows: [], binary: true, truncated: false });
    expect(fileRows("x".repeat(600 * 1024), "y").binary).toBe(true);
  });

  it("truncates at maxRows", () => {
    const after = Array.from({ length: 50 }, (_, i) => `n${i}`).join("\n");
    const res = fileRows("", after, { maxRows: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });
});

describe("listChangedFiles / describeFolders", () => {
  it("lists edited, added and removed files; a rename is removed plus added", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "changes-"));
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    await fs.outputFile(path.join(a, "src", "edit.ts"), "1\n");
    await fs.outputFile(path.join(a, "src", "gone.ts"), "bye\n");
    await fs.outputFile(path.join(a, "src", "old-name.ts"), "same content here\n");
    await fs.outputFile(path.join(b, "src", "edit.ts"), "2\n");
    await fs.outputFile(path.join(b, "src", "new.ts"), "hi\n");
    await fs.outputFile(path.join(b, "src", "new-name.ts"), "same content here\n");
    const list = await listChangedFiles(a, b);
    expect(list).toEqual([
      { path: "src/edit.ts", status: "edited" },
      { path: "src/gone.ts", status: "removed" },
      { path: "src/new-name.ts", status: "added" },
      { path: "src/new.ts", status: "added" },
      { path: "src/old-name.ts", status: "removed" },
    ]);
    const files = await describeFolders(a, b);
    expect(files.find((f) => f.path === "src/edit.ts")?.rows).toHaveLength(1);
    expect(await describeFolders(path.join(base, "nope"), path.join(base, "nope2"))).toEqual([]);
    await fs.remove(base);
  });
});
