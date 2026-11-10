import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { FigmakeSyncService } from "../src/core/service.js";
import { mergeText } from "../src/diff/mergeText.js";
import { LocalFixtureAdapter } from "./support/localFixtureAdapter.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;
const FIVE = lines("one", "two", "three", "four", "five");

async function setup(files: Record<string, string | Buffer>): Promise<{ project: string; remote: string; service: FigmakeSyncService }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "merge-")));
  dirs.push(base);
  const project = path.join(base, "project");
  const remote = path.join(base, "remote");
  for (const [name, content] of Object.entries(files)) await fs.outputFile(path.join(remote, name), content);
  const service = new FigmakeSyncService({ adapterFactory: ({ logger }) => new LocalFixtureAdapter(remote, logger) });
  await service.init("https://www.figma.com/make/x", project, { cwd: project, yes: true });
  await service.pull({ cwd: project, yes: true });
  return { project, remote, service };
}

const read = (p: string): Promise<string> => fs.readFile(p, "utf8");

describe("mergeText", () => {
  it("combines edits to different lines and keeps the trailing newline", () => {
    const r = mergeText(Buffer.from(FIVE), Buffer.from(FIVE.replace("one", "ONE")), Buffer.from(FIVE.replace("five", "FIVE")));
    expect(r).toEqual({ ok: true, text: lines("ONE", "two", "three", "four", "FIVE") });
  });
  it("accepts the same edit on both sides, refuses different edits to the same line", () => {
    const same = Buffer.from(FIVE.replace("three", "3"));
    expect(mergeText(Buffer.from(FIVE), same, same)).toEqual({ ok: true, text: same.toString() });
    expect(mergeText(Buffer.from(FIVE), Buffer.from(FIVE.replace("three", "a")), Buffer.from(FIVE.replace("three", "b")))).toEqual({ ok: false });
  });
  it("refuses binary files", () => {
    const bin = Buffer.from([0, 1, 2]);
    expect(mergeText(bin, Buffer.from([0, 1, 3]), Buffer.from([0, 1, 4]))).toEqual({ ok: false });
  });
});

describe("pull with the merge strategy", () => {
  it("merges both-side edits, keeps local work, takes Figma-only work, and never loses a conflict", async () => {
    const { project, remote, service } = await setup({
      "both.ts": FIVE,
      "clash.ts": FIVE,
      "figma-edit.ts": "f1\n",
      "figma-gone.ts": "bye\n",
      "mine-edit.ts": "m1\n",
    });
    // Local side
    await fs.outputFile(path.join(project, "both.ts"), FIVE.replace("one", "ONE"));
    await fs.outputFile(path.join(project, "clash.ts"), FIVE.replace("three", "mine"));
    await fs.outputFile(path.join(project, "mine-edit.ts"), "m2\n");
    await fs.outputFile(path.join(project, "mine-new.ts"), "new\n");
    // Figma side
    await fs.outputFile(path.join(remote, "both.ts"), FIVE.replace("five", "FIVE"));
    await fs.outputFile(path.join(remote, "clash.ts"), FIVE.replace("three", "figma"));
    await fs.outputFile(path.join(remote, "figma-edit.ts"), "f2\n");
    await fs.outputFile(path.join(remote, "figma-new.ts"), "fn\n");
    await fs.remove(path.join(remote, "figma-gone.ts"));

    const result = await service.pull({ cwd: project, strategy: "merge", yes: true });

    expect(result.merged).toEqual(["both.ts"]);
    expect(result.conflicts).toEqual(["clash.ts"]);
    expect(result.backupDir).toBeTruthy();
    expect(await read(path.join(result.backupDir as string, "workspace", "mine-edit.ts"))).toBe("m2\n");
    expect(await read(path.join(project, "both.ts"))).toBe(lines("ONE", "two", "three", "four", "FIVE"));
    expect(await read(path.join(project, "clash.ts"))).toBe(FIVE.replace("three", "mine"));
    expect(await read(path.join(project, "figma-edit.ts"))).toBe("f2\n");
    expect(await read(path.join(project, "figma-new.ts"))).toBe("fn\n");
    expect(await fs.pathExists(path.join(project, "figma-gone.ts"))).toBe(false);
    expect(await read(path.join(project, "mine-edit.ts"))).toBe("m2\n");
    expect(await read(path.join(project, "mine-new.ts"))).toBe("new\n");

    // The baseline is now Figma's version: only the local side counts as something to send.
    const status = await service.status({ cwd: project });
    const diff = status.diff;
    expect(diff?.modified.map((m) => m.current.path).sort()).toEqual(["both.ts", "clash.ts", "mine-edit.ts"]);
    expect(diff?.added.map((e) => e.path)).toEqual(["mine-new.ts"]);
    expect(diff?.deleted).toEqual([]);
    expect(status.summary.total).toBe(4);
    const baseline = await read(path.join(project, ".figmake-sync", "snapshots", "last-pull", "clash.ts"));
    expect(baseline).toBe(FIVE.replace("three", "figma"));
  });

  it("a delete on one side and an edit on the other is a conflict that keeps the local file", async () => {
    const { project, remote, service } = await setup({ "x.ts": "x1\n", "y.ts": "y1\n" });
    await fs.outputFile(path.join(project, "x.ts"), "x2\n");
    await fs.remove(path.join(remote, "x.ts"));
    await fs.remove(path.join(project, "y.ts"));
    await fs.outputFile(path.join(remote, "y.ts"), "y2\n");
    const result = await service.pull({ cwd: project, strategy: "merge", yes: true });
    expect(result.conflicts.sort()).toEqual(["x.ts", "y.ts"]);
    expect(await read(path.join(project, "x.ts"))).toBe("x2\n");
    expect(await fs.pathExists(path.join(project, "y.ts"))).toBe(false);
  });

  it("with no local changes it just takes Figma's", async () => {
    const { project, remote, service } = await setup({ "a.ts": "a1\n" });
    await fs.outputFile(path.join(remote, "a.ts"), "a2\n");
    const result = await service.pull({ cwd: project, strategy: "merge", yes: true });
    expect(result).toMatchObject({ conflicts: [], merged: [] });
    expect(await read(path.join(project, "a.ts"))).toBe("a2\n");
    expect((await service.status({ cwd: project })).summary.total).toBe(0);
  });

  it("the backup strategy discards local work but keeps a backup", async () => {
    const { project, remote, service } = await setup({ "a.ts": "a1\n", "b.ts": "b1\n" });
    await fs.outputFile(path.join(project, "a.ts"), "mine\n");
    await fs.outputFile(path.join(project, "extra.ts"), "mine\n");
    await fs.outputFile(path.join(remote, "b.ts"), "b2\n");
    const result = await service.pull({ cwd: project, strategy: "backup", yes: true });
    expect(await read(path.join(project, "a.ts"))).toBe("a1\n");
    expect(await read(path.join(project, "b.ts"))).toBe("b2\n");
    expect(await read(path.join(result.backupDir as string, "workspace", "a.ts"))).toBe("mine\n");
  });
});
