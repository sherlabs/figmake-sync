/* eslint-disable @typescript-eslint/require-await */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { FigmakeSyncService } from "../src/core/service.js";
import {
  ExplorerMismatchError,
  FileChangedInFigmaError,
  WriteNotVerifiedError,
  normalizedTextHash,
  type DeleteResult,
  type DownloadResult,
  type ExplorerSnapshot,
  type FigmaMakeAdapter,
  type FigmaMakeProjectSession,
  type ReplaceOptions,
  type UploadResult,
  type WriteOutcome,
} from "../src/figma/adapter.js";
import type { PushProgress } from "../src/types/config.js";
import { createZipFromDirectory } from "../src/utils/archive.js";

const tempDirs: string[] = [];

async function tmp(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

interface Faults {
  /** replace never takes for these paths (WRITE_NOT_VERIFIED, retried by the service). */
  writeFails?: Set<string>;
  /** The editor shows this instead of the stored content (precondition mismatch). */
  docOverride?: Map<string, string>;
  /** After a successful write, "Figma" rewrites the file. */
  mutateAfterWrite?: Map<string, string>;
  /** After a successful write, "Figma" loses the file. */
  dropAfterWrite?: Set<string>;
  /** Delete confirms but the row stays. */
  deleteNoop?: Set<string>;
  /** Paths the explorer never shows (hidden files are in `hidden`, these are plain mismatches). */
  invisible?: Set<string>;
  /** Called after each successful write (to abort mid-push, or mutate an untouched file). */
  afterWrite?: (path: string, session: ScriptedSession) => void;
  noHiddenToggle?: boolean;
}

/**
 * A session with the same contract as the Playwright adapter: explorer index, per-file transaction with precondition,
 * truthful delete. "Remote" state is a map of files + folders; the zip is built from it on each download.
 */
class ScriptedSession implements FigmaMakeProjectSession {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly hidden = new Set<string>();
  readonly calls: string[] = [];
  hiddenShown = false;
  attempts = new Map<string, number>();

  constructor(
    files: Record<string, string>,
    readonly faults: Faults = {},
  ) {
    for (const [p, c] of Object.entries(files)) this.setFile(p, c);
    for (const p of Object.keys(files)) if (p.split("/").some((s) => s.startsWith("."))) this.hidden.add(p);
  }

  setFile(p: string, content: string): void {
    this.files.set(p, content);
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i += 1) this.folders.add(segs.slice(0, i).join("/"));
  }

  private visible(p: string): boolean {
    if (this.faults.invisible?.has(p)) return false;
    if (this.hidden.has(p) && !this.hiddenShown) return false;
    return this.files.has(p) || this.folders.has(p);
  }

  async downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult> {
    this.calls.push("download");
    const dir = await tmp("scripted-remote");
    for (const [p, c] of this.files) await fs.outputFile(path.join(dir, p), c);
    for (const f of this.folders) await fs.ensureDir(path.join(dir, f));
    const zipPath = path.join(destinationDir, `remote-${Date.now()}-${Math.random()}.zip`);
    await createZipFromDirectory(dir, zipPath);
    return { zipPath, suggestedFileName: "r.zip" };
  }

  async indexExplorer(paths: string[]): Promise<ExplorerSnapshot> {
    this.calls.push(`index:${paths.join(",")}`);
    if (paths.some((p) => this.hidden.has(p)) && !this.hiddenShown && !this.faults.noHiddenToggle) this.hiddenShown = true;
    const entries: Record<string, "file" | "folder"> = {};
    for (const f of this.folders) if (this.visible(f)) entries[f] = "folder";
    for (const f of this.files.keys()) if (this.visible(f)) entries[f] = "file";
    const hiddenFiles = this.faults.noHiddenToggle ? "unavailable" : this.hiddenShown ? "on" : "off";
    return { supported: true, entries, duplicates: [], hiddenFiles };
  }

  async replaceFileContents(p: string, content: string, options: ReplaceOptions = {}): Promise<WriteOutcome> {
    this.calls.push(`replace:${p}`);
    this.attempts.set(p, (this.attempts.get(p) ?? 0) + 1);
    if (!this.visible(p)) throw new ExplorerMismatchError(p);
    const doc = this.faults.docOverride?.get(p) ?? this.files.get(p) ?? "";
    if (normalizedTextHash(doc) === normalizedTextHash(content)) return { status: "unchanged" };
    if (options.expectedNormalizedHash !== undefined && normalizedTextHash(doc) !== options.expectedNormalizedHash) throw new FileChangedInFigmaError(p);
    if (this.faults.writeFails?.has(p)) throw new WriteNotVerifiedError(p, "fixture");
    this.write(p, content);
    return { status: "written" };
  }

  private write(p: string, content: string): void {
    this.setFile(p, content);
    const after = this.faults.mutateAfterWrite?.get(p);
    if (after !== undefined) this.files.set(p, after);
    if (this.faults.dropAfterWrite?.has(p)) this.files.delete(p);
    this.faults.afterWrite?.(p, this);
  }

  async createFile(p: string, content: string): Promise<WriteOutcome> {
    this.calls.push(`create:${p}`);
    if (this.visible(p)) throw new ExplorerMismatchError(p, "already exists");
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (parent && !this.folders.has(parent)) throw new ExplorerMismatchError(parent, "is not in Figma's file list");
    if (this.faults.writeFails?.has(p)) throw new WriteNotVerifiedError(p, "fixture");
    this.write(p, content);
    return { status: "written" };
  }

  async createFolder(p: string): Promise<void> {
    this.calls.push(`mkdir:${p}`);
    this.folders.add(p);
  }

  async upsertFile(): Promise<void> {
    throw new Error("upsertFile must not be used when createFile exists");
  }

  async commitPendingChanges(): Promise<void> {
    this.calls.push("commit");
  }

  async uploadFiles(absolutePaths: string[], rootDir: string): Promise<UploadResult> {
    const uploaded: string[] = [];
    for (const abs of absolutePaths) {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      this.calls.push(`upload:${rel}`);
      this.files.set(rel, (await fs.readFile(abs)).toString("latin1"));
      uploaded.push(rel);
    }
    return { uploaded, unresolved: [] };
  }

  async deletePath(p: string): Promise<DeleteResult> {
    this.calls.push(`delete:${p}`);
    if (!this.visible(p)) return { path: p, status: "failed", code: "EXPLORER_MISMATCH", reason: "not in list" };
    if (this.faults.deleteNoop?.has(p)) return { path: p, status: "failed", code: "DELETE_NOT_VERIFIED", reason: "still there" };
    this.files.delete(p);
    return { path: p, status: "deleted" };
  }

  async submitPrompt(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.calls.push("close");
  }
}

async function setup(remote: Record<string, string>, faults: Faults = {}): Promise<{ project: string; session: ScriptedSession; service: FigmakeSyncService }> {
  const project = path.join(await tmp("scripted-project"), "p");
  await fs.ensureDir(project);
  const session = new ScriptedSession(remote, faults);
  const adapter: FigmaMakeAdapter = { kind: "scripted", authenticate: () => Promise.resolve(), openProject: () => Promise.resolve(session) };
  const service = new FigmakeSyncService({ adapterFactory: () => adapter });
  await service.init("https://www.figma.com/make/x", project, { cwd: project });
  await service.pull({ cwd: project, yes: true });
  return { project, session, service };
}

const writeLocal = (project: string, p: string, c: string): Promise<void> => fs.outputFile(path.join(project, p), c);
const dirty = async (service: FigmakeSyncService, project: string): Promise<string[]> => {
  const s = await service.status({ cwd: project });
  return [...(s.diff?.modified.map((m) => m.current.path) ?? []), ...(s.diff?.added.map((a) => a.path) ?? []), ...(s.diff?.deleted.map((d) => d.path) ?? [])].sort();
};

describe("push as a transaction (scripted session with an explorer index)", () => {
  it("a file the zip has but the explorer does not stops everything before any write", async () => {
    const { project, session, service } = await setup({ "src/a.ts": "a\n", "src/b.ts": "b\n" }, { invisible: new Set(["src/b.ts"]) });
    await writeLocal(project, "src/a.ts", "a2\n");
    await writeLocal(project, "src/b.ts", "b2\n");
    const result = await service.push({ cwd: project, yes: true });
    expect(result.stopped).toMatchObject({ phase: "preflight", code: "EXPLORER_MISMATCH" });
    expect(result.stopped?.message).toContain("src/b.ts");
    expect(result.stopped?.message).toContain("Nothing was changed");
    expect(session.calls.filter((c) => /^(replace|create|delete|mkdir):/.test(c))).toEqual([]);
    expect(await dirty(service, project)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("a hidden dot-file is sent when the explorer can show it, refused cleanly when it cannot", async () => {
    const ok = await setup({ ".gitattributes": "x\n", "a.ts": "a\n" });
    await writeLocal(ok.project, ".gitattributes", "y\n");
    const sent = await ok.service.push({ cwd: ok.project, yes: true });
    expect(sent.stopped).toBeUndefined();
    expect(ok.session.files.get(".gitattributes")).toBe("y\n");
    expect(sent.verified).toBe(1);

    const no = await setup({ ".mise.toml": "x\n", "a.ts": "a\n" }, { noHiddenToggle: true });
    await writeLocal(no.project, ".mise.toml", "y\n");
    const refused = await no.service.push({ cwd: no.project, yes: true });
    expect(refused.stopped).toMatchObject({ phase: "preflight", code: "HIDDEN_FILE_UNSUPPORTED" });
    expect(no.session.files.get(".mise.toml")).toBe("x\n");
  });

  it("creates missing folders first, then the file; deletes last; baseline advances after each verified op", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n", "old.ts": "o\n" });
    await writeLocal(project, "lib/deep/new.ts", "n\n");
    await writeLocal(project, "a.ts", "a2\n");
    await fs.remove(path.join(project, "old.ts"));
    const events: PushProgress[] = [];
    const result = await service.push({ cwd: project, yes: true, onProgress: (p) => events.push(p) });
    expect(result.stopped).toBeUndefined();
    expect(session.calls.filter((c) => /^(replace|create|delete|mkdir):/.test(c))).toEqual(["mkdir:lib", "mkdir:lib/deep", "create:lib/deep/new.ts", "replace:a.ts", "delete:old.ts"]);
    expect(result.verified).toBe(3);
    expect(await dirty(service, project)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ phase: "saving", percent: 100, total: 5, completed: 5 });
    expect(events.filter((e) => e.finished).map((e) => e.finished?.op)).toEqual(["create", "create", "create", "replace", "delete"]);
  });

  it("stops at the first file that does not take: earlier files are in the baseline, later ones listed as waiting, nothing after it touched", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" }, { writeFails: new Set(["b.ts"]) });
    for (const p of ["a.ts", "b.ts", "c.ts"]) await writeLocal(project, p, `${p}2\n`);
    const result = await service.push({ cwd: project, yes: true });
    expect(result.stopped).toMatchObject({ phase: "sending", code: "WRITE_NOT_VERIFIED", remaining: 1 });
    expect(result.stopped?.message).toBe("b.ts didn't take in Figma's editor. Nothing after it was sent.");
    expect(result.unresolved.map((u) => [u.path, u.code])).toEqual([["b.ts", "WRITE_NOT_VERIFIED"], ["c.ts", "STOPPED"]]);
    expect(session.attempts.get("b.ts")).toBe(3);
    expect(session.calls).not.toContain("replace:c.ts");
    expect(await dirty(service, project)).toEqual(["b.ts", "c.ts"]);
    // Retrying is exactly the remaining set.
    session.faults.writeFails?.clear();
    const again = await service.push({ cwd: project, yes: true });
    expect(again.stopped).toBeUndefined();
    expect(session.calls.filter((c) => c === "replace:a.ts")).toHaveLength(1);
    expect(await dirty(service, project)).toEqual([]);
  }, 20_000);

  it("a file whose editor content is not what the zip said is never written and never retried", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n", "b.ts": "b\n" }, { docOverride: new Map([["a.ts", "someone typed here\n"]]) });
    await writeLocal(project, "a.ts", "a2\n");
    await writeLocal(project, "b.ts", "b2\n");
    const result = await service.push({ cwd: project, yes: true });
    expect(result.stopped).toMatchObject({ phase: "sending", code: "WRONG_FILE_OR_CHANGED", remaining: 1 });
    expect(result.stopped?.message).toBe("a.ts changed in Figma while sending. Stopped before changing it.");
    expect(session.attempts.get("a.ts")).toBe(1);
    expect(session.files.get("a.ts")).toBe("a\n");
    expect(session.files.get("b.ts")).toBe("b\n");
  });

  it("already-there content is a no-op that still advances the baseline", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n" });
    await writeLocal(project, "a.ts", "same\n");
    session.setFile("a.ts", "same\n");
    const result = await service.push({ cwd: project, yes: true });
    expect(result.stopped).toBeUndefined();
    expect(session.calls.filter((c) => c.startsWith("replace:"))).toEqual([]);
    expect(await dirty(service, project)).toEqual([]);
  });

  it("final zip check: a file Figma changed right after sending or lost is reported and its baseline rolled back", async () => {
    const { project, service } = await setup({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" }, { mutateAfterWrite: new Map([["a.ts", "ai rewrote it\n"]]), dropAfterWrite: new Set(["b.ts"]) });
    for (const p of ["a.ts", "b.ts", "c.ts"]) await writeLocal(project, p, `${p}2\n`);
    const result = await service.push({ cwd: project, yes: true });
    expect(result.stopped).toBeUndefined();
    expect(result.verifyCheck).toBe("ok");
    expect(result.verified).toBe(1);
    expect(result.unresolved.map((u) => [u.path, u.code])).toEqual([["a.ts", "CHANGED_AFTER_SEND"], ["b.ts", "NOT_SAVED"]]);
    // a.ts and b.ts are dirty again; the next push sees a.ts as diverged (base != remote != local) rather than overwriting silently.
    expect(await dirty(service, project)).toEqual(["a.ts", "b.ts"]);
    const next = await service.push({ cwd: project, confirm: () => Promise.resolve(false) });
    expect(next.remoteDiverged).toEqual(["a.ts", "b.ts"]);
  });

  it("reports files that changed in Figma during the push without touching them", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n", "other.ts": "o\n" }, { afterWrite: (_p, s) => s.files.set("other.ts", "changed meanwhile\n") });
    await writeLocal(project, "a.ts", "a2\n");
    const result = await service.push({ cwd: project, yes: true });
    expect(result.remoteChanged).toEqual(["other.ts"]);
    expect(session.files.get("other.ts")).toBe("changed meanwhile\n");
    expect(await dirty(service, project)).toEqual([]);
  });

  it("cancel between files: done files stay in the baseline, the rest are still waiting", async () => {
    const controller = new AbortController();
    const { project, service } = await setup({ "a.ts": "a\n", "b.ts": "b\n" }, { afterWrite: () => controller.abort() });
    await writeLocal(project, "a.ts", "a2\n");
    await writeLocal(project, "b.ts", "b2\n");
    await expect(service.push({ cwd: project, yes: true, signal: controller.signal })).rejects.toThrow();
    expect(await dirty(service, project)).toEqual(["b.ts"]);
  });

  it("delete that cannot be seen to happen keeps the path in the baseline", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n", "gone.ts": "g\n" }, { deleteNoop: new Set(["gone.ts"]) });
    await fs.remove(path.join(project, "gone.ts"));
    const result = await service.push({ cwd: project, yes: true });
    expect(result.stopped).toMatchObject({ phase: "sending", code: "DELETE_NOT_VERIFIED" });
    expect(session.files.has("gone.ts")).toBe(true);
    expect(await dirty(service, project)).toEqual(["gone.ts"]);
  });

  it("diverged: declined skips, approved overwrites with the current remote as the precondition", async () => {
    const { project, session, service } = await setup({ "a.ts": "a\n", "b.ts": "b\n" });
    await writeLocal(project, "a.ts", "mine\n");
    await writeLocal(project, "b.ts", "b2\n");
    session.setFile("a.ts", "theirs\n");
    const declined = await service.push({ cwd: project, confirm: () => Promise.resolve(false) });
    expect(declined.remoteDiverged).toEqual(["a.ts"]);
    expect(declined.unresolved).toEqual([expect.objectContaining({ path: "a.ts", code: "DIVERGED" })]);
    expect(session.files.get("a.ts")).toBe("theirs\n");
    expect(session.files.get("b.ts")).toBe("b2\n");
    const approved = await service.push({ cwd: project, yes: true });
    expect(approved.stopped).toBeUndefined();
    expect(session.files.get("a.ts")).toBe("mine\n");
    expect(await dirty(service, project)).toEqual([]);
  });

  it("300 files: progress is monotonic, counts are real, 100% exactly once", async () => {
    const remote: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) remote[`src/f${i}.ts`] = `${i}\n`;
    const { project, service } = await setup(remote);
    for (let i = 0; i < 300; i += 1) await writeLocal(project, `src/f${i}.ts`, `${i} changed\n`);
    const events: PushProgress[] = [];
    const result = await service.push({ cwd: project, yes: true, onProgress: (p) => events.push(p) });
    expect(result.stopped).toBeUndefined();
    expect(result.verified).toBe(300);
    const percents = events.map((e) => e.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(percents.filter((p) => p === 100)).toHaveLength(1);
    expect(new Set(events.filter((e) => e.phase === "sending").map((e) => e.total))).toEqual(new Set([300]));
    expect(events.filter((e) => e.finished).length).toBe(300);
  }, 60_000);
});
