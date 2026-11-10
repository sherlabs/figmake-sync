import { describe, expect, it } from "vitest";

import type { ManifestDiff, ManifestEntry } from "../src/diff/manifest.js";
import type { ExplorerSnapshot } from "../src/figma/adapter.js";
import { buildPushPlan, invalidNameReason, pushMessage, resolveDiverged, validateLocalPlan, type PlanInput } from "../src/core/push-plan.js";

function entry(path: string, hash: string, extra: Partial<ManifestEntry> = {}): ManifestEntry {
  return { path, contentHash: hash, normalizedHash: `n-${hash}`, size: 10, modifiedTimeMs: 0, isBinary: false, lineEnding: "lf", ...extra };
}

const emptyDiff = (): ManifestDiff => ({ added: [], modified: [], deleted: [], renamed: [], unchanged: [] });

function explorer(entries: Record<string, "file" | "folder">, hiddenFiles: ExplorerSnapshot["hiddenFiles"] = "off", duplicates: string[] = []): ExplorerSnapshot {
  return { supported: true, entries, duplicates, hiddenFiles };
}

/** One row of the 3.4 table: (base, local, remote, row) for a modified, added or deleted path `p`. */
function plan(kind: "replace" | "create" | "delete", base: string | undefined, local: string | undefined, remote: string | undefined, row: "file" | "folder" | "none" | "unknown", hiddenFiles: ExplorerSnapshot["hiddenFiles"] = "off", path = "src/p.ts") {
  const diff = emptyDiff();
  const baseMap = new Map<string, ManifestEntry>();
  const localMap = new Map<string, ManifestEntry>();
  const remoteMap = new Map<string, ManifestEntry>();

  if (base) baseMap.set(path, entry(path, base));
  if (local) localMap.set(path, entry(path, local));
  if (remote) remoteMap.set(path, entry(path, remote));
  if (kind === "replace") diff.modified.push({ previous: entry(path, base!), current: entry(path, local!) });
  if (kind === "create") diff.added.push(entry(path, local!));
  if (kind === "delete") diff.deleted.push(entry(path, base!));

  const entries: Record<string, "file" | "folder"> = { src: "folder" };

  if (row === "file" || row === "folder") entries[path] = row;

  const input: PlanInput = { diff, baseline: baseMap, local: localMap, remote: remoteMap, ...(row === "unknown" ? {} : { explorer: explorer(entries, hiddenFiles) }) };

  return { out: buildPushPlan(input), input };
}

describe("buildPushPlan: the 3.4 classification table", () => {
  it("replace", () => {
    expect(plan("replace", "b", "l", "b", "file").out.ops).toEqual([expect.objectContaining({ op: "replace", path: "src/p.ts", expectedNormalizedHash: "n-b" })]);
    expect(plan("replace", "b", "l", "l", "file").out.noops).toEqual([expect.objectContaining({ op: "replace", path: "src/p.ts" })]);
    expect(plan("replace", "b", "l", "x", "file").out.diverged).toEqual(["src/p.ts"]);
    expect(plan("replace", "b", "l", undefined, "file").out.diverged).toEqual(["src/p.ts"]);
    expect(plan("replace", "b", "l", "b", "none").out.blocked).toEqual([expect.objectContaining({ code: "EXPLORER_MISMATCH", path: "src/p.ts" })]);
    expect(plan("replace", "b", "l", "b", "folder").out.blocked).toEqual([expect.objectContaining({ code: "EXPLORER_MISMATCH" })]);
    // Row existence unknown (older UI / fakes): proceed on the zip alone.
    expect(plan("replace", "b", "l", "b", "unknown").out.ops).toHaveLength(1);
    // Hidden file: untoggleable -> HIDDEN_FILE_UNSUPPORTED; shown -> plain mismatch.
    expect(plan("replace", "b", "l", "b", "none", "unavailable", ".gitattributes").out.blocked[0]?.code).toBe("HIDDEN_FILE_UNSUPPORTED");
    expect(plan("replace", "b", "l", "b", "none", "on", ".gitattributes").out.blocked[0]?.code).toBe("EXPLORER_MISMATCH");
  });

  it("create", () => {
    expect(plan("create", undefined, "l", undefined, "none").out.ops).toEqual([expect.objectContaining({ op: "create", path: "src/p.ts" })]);
    expect(plan("create", undefined, "l", "l", "none").out.noops).toEqual([expect.objectContaining({ op: "create" })]);
    expect(plan("create", undefined, "l", "x", "none").out.diverged).toEqual(["src/p.ts"]);
    expect(plan("create", undefined, "l", undefined, "file").out.blocked[0]?.code).toBe("EXPLORER_MISMATCH");
    expect(plan("create", undefined, "l", undefined, "unknown").out.ops).toHaveLength(1);
  });

  it("create adds mkdir ops for missing parents, shallow first, and refuses a file where a folder is needed", () => {
    const diff = emptyDiff();
    diff.added.push(entry("a/b/c.ts", "l"));
    const out = buildPushPlan({ diff, baseline: new Map(), local: new Map([["a/b/c.ts", entry("a/b/c.ts", "l")]]), remote: new Map(), explorer: explorer({}) });
    expect(out.ops.map((o) => [o.op, o.path])).toEqual([["mkdir", "a"], ["mkdir", "a/b"], ["create", "a/b/c.ts"]]);

    const collision = buildPushPlan({ diff, baseline: new Map(), local: new Map([["a/b/c.ts", entry("a/b/c.ts", "l")]]), remote: new Map(), explorer: explorer({ a: "file" }) });
    expect(collision.blocked).toEqual([expect.objectContaining({ code: "NAME_COLLISION", path: "a" })]);
    expect(collision.ops).toEqual([]);
  });

  it("delete", () => {
    expect(plan("delete", "b", undefined, "b", "file").out.ops).toEqual([expect.objectContaining({ op: "delete", path: "src/p.ts" })]);
    expect(plan("delete", "b", undefined, undefined, "none").out.noops).toEqual([expect.objectContaining({ op: "delete" })]);
    expect(plan("delete", "b", undefined, "x", "file").out.diverged).toEqual(["src/p.ts"]);
    expect(plan("delete", "b", undefined, "b", "none").out.blocked[0]?.code).toBe("EXPLORER_MISMATCH");
    expect(plan("delete", "b", undefined, undefined, "file").out.blocked[0]?.code).toBe("EXPLORER_MISMATCH");
  });

  it("duplicate labels in one folder block the push", () => {
    const diff = emptyDiff();
    diff.modified.push({ previous: entry("src/p.ts", "b"), current: entry("src/p.ts", "l") });
    const out = buildPushPlan({ diff, baseline: new Map([["src/p.ts", entry("src/p.ts", "b")]]), local: new Map([["src/p.ts", entry("src/p.ts", "l")]]), remote: new Map([["src/p.ts", entry("src/p.ts", "b")]]), explorer: explorer({ src: "folder", "src/p.ts": "file" }, "off", ["src/p.ts"]) });
    expect(out.blocked).toEqual([expect.objectContaining({ code: "AMBIGUOUS_REMOTE_PATH" })]);
  });

  it("orders ops mkdir -> create -> replace -> delete and a rename is create(to)+delete(from) with counterparts", () => {
    const diff = emptyDiff();
    diff.renamed.push({ from: "old.ts", to: "new.ts", match: "contentHash" });
    diff.modified.push({ previous: entry("m.ts", "b"), current: entry("m.ts", "l") });
    const out = buildPushPlan({
      diff,
      baseline: new Map([["old.ts", entry("old.ts", "s")], ["m.ts", entry("m.ts", "b")]]),
      local: new Map([["new.ts", entry("new.ts", "s")], ["m.ts", entry("m.ts", "l")]]),
      remote: new Map([["old.ts", entry("old.ts", "s")], ["m.ts", entry("m.ts", "b")]]),
      explorer: explorer({ "old.ts": "file", "m.ts": "file" }),
    });
    expect(out.ops.map((o) => [o.op, o.path, o.shown, o.counterpart])).toEqual([
      ["create", "new.ts", "rename", "old.ts"],
      ["replace", "m.ts", "replace", undefined],
      ["delete", "old.ts", "rename", "new.ts"],
    ]);
  });
});

describe("validateLocalPlan (no browser)", () => {
  it("refuses binary edits, nested binaries, oversize text, bad names and case-only twins", () => {
    const diff = emptyDiff();
    diff.modified.push({ previous: entry("logo.png", "b", { isBinary: true }), current: entry("logo.png", "l", { isBinary: true }) });
    diff.added.push(entry("assets/x.png", "l", { isBinary: true }), entry("big.json", "l", { size: 6 * 1024 * 1024 }), entry("bad /name.ts", "l"), entry("src/App.tsx", "l"));
    const local = new Map([["src/App.tsx", entry("src/App.tsx", "l")], ["src/app.tsx", entry("src/app.tsx", "z")]]);
    const codes = validateLocalPlan(diff, local).map((b) => b.code).sort();
    expect(codes).toEqual(["AMBIGUOUS_LOCAL_PATH", "INVALID_NAME", "TOO_LARGE_FOR_EDITOR", "UNSUPPORTED_BINARY_MODIFY", "UNSUPPORTED_BINARY_NESTED"]);
    // A root-level new binary is fine (it goes through the upload input).
    const ok = emptyDiff();
    ok.added.push(entry("x.png", "l", { isBinary: true }));
    expect(validateLocalPlan(ok, new Map())).toEqual([]);
    expect(buildPushPlan({ diff: ok, baseline: new Map(), local: new Map([["x.png", entry("x.png", "l", { isBinary: true })]]), remote: new Map() }).ops[0]).toMatchObject({ op: "create", binary: true });
  });

  it("invalidNameReason", () => {
    expect(invalidNameReason("src/a.ts")).toBeNull();
    expect(invalidNameReason("a/../b")).not.toBeNull();
    expect(invalidNameReason("a\\b")).not.toBeNull();
    expect(invalidNameReason("a.")).not.toBeNull();
    expect(invalidNameReason(`${"x".repeat(256)}.ts`)).not.toBeNull();
  });
});

describe("resolveDiverged", () => {
  it("declined drops every diverged path and its rename counterpart; approved overwrites with the current remote as precondition", () => {
    const diff = emptyDiff();
    diff.modified.push({ previous: entry("a.ts", "b"), current: entry("a.ts", "l") });
    diff.renamed.push({ from: "o.ts", to: "n.ts", match: "contentHash" });
    diff.deleted.push(entry("gone.ts", "b"));
    const input: PlanInput = {
      diff,
      baseline: new Map([["a.ts", entry("a.ts", "b")], ["o.ts", entry("o.ts", "s")], ["gone.ts", entry("gone.ts", "b")]]),
      local: new Map([["a.ts", entry("a.ts", "l")], ["n.ts", entry("n.ts", "s")]]),
      remote: new Map([["a.ts", entry("a.ts", "x")], ["o.ts", entry("o.ts", "s")], ["n.ts", entry("n.ts", "y")], ["gone.ts", entry("gone.ts", "z")]]),
    };
    const first = buildPushPlan(input);
    expect(first.diverged).toEqual(["a.ts", "gone.ts", "n.ts"]);

    const declined = resolveDiverged(first, input, false);
    expect(declined.skipped).toEqual(["a.ts", "gone.ts", "n.ts", "o.ts"]);
    expect(declined.plan.ops).toEqual([]);

    const approved = resolveDiverged(first, input, true);
    expect(approved.plan.ops.map((o) => [o.op, o.path, o.expectedNormalizedHash])).toEqual([
      ["replace", "a.ts", "n-x"],
      ["replace", "n.ts", "n-y"],
      ["delete", "gone.ts", undefined],
      ["delete", "o.ts", undefined],
    ]);
  });
});

describe("pushMessage", () => {
  it("every code has a short plain message that names the file", () => {
    const codes = ["UNSUPPORTED_BINARY_MODIFY", "UNSUPPORTED_BINARY_NESTED", "TOO_LARGE_FOR_EDITOR", "INVALID_NAME", "AMBIGUOUS_LOCAL_PATH", "HIDDEN_FILE_UNSUPPORTED", "EXPLORER_MISMATCH", "TREE_INDEX_INCOMPLETE", "AMBIGUOUS_REMOTE_PATH", "NAME_COLLISION", "WRONG_FILE_OR_CHANGED", "WRITE_NOT_VERIFIED", "DELETE_NOT_VERIFIED", "NOT_SAVED", "CHANGED_AFTER_SEND", "UNEXPECTED_REMOTE_CHANGE", "UI_CHANGED", "TIMEOUT", "STOPPED", "SOMETHING_ELSE"];
    for (const code of codes) {
      const m = pushMessage(code, "src/Thing.tsx");
      expect(m, code).toMatch(/Thing\.tsx/);
      expect(m.split(/(?<=[.!?])\s+/).length, code).toBeLessThanOrEqual(3);
      expect(m, code).not.toMatch(/\b(selector|locator|DOM|aria|treeitem|exception|undefined)\b/i);
    }
    expect(pushMessage("LEFTOVER_FILE", "src/x.ts", { folder: "src", leftover: "new-file.tsx" })).toContain("'new-file.tsx' in src");
    expect(pushMessage("ABORTED", undefined, { count: 12 })).toContain("12 files were sent");
  });
});
