import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { FigmakeSyncService } from "../src/core/service.js";
import { ProjectStateStore } from "../src/core/state.js";
import { createManifest } from "../src/diff/manifest.js";
import type {
  DeleteResult,
  DownloadResult,
  FigmaMakeAdapter,
  FigmaMakeProjectSession,
  UploadResult,
} from "../src/figma/adapter.js";
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

class Session implements FigmaMakeProjectSession {
  replaced: string[] = [];
  deleted: string[] = [];
  constructor(private readonly remote: string) {}
  async downloadLatestCodeZip(dest: string): Promise<DownloadResult> {
    const zipPath = path.join(dest, `r-${Date.now()}-${Math.random()}.zip`);
    await createZipFromDirectory(this.remote, zipPath);
    return { zipPath, suggestedFileName: "r.zip" };
  }
  async replaceFileContents(p: string, c: string): Promise<void> {
    this.replaced.push(p);
    await fs.outputFile(path.join(this.remote, p), c);
  }
  async upsertFile(p: string, c: string): Promise<void> {
    await fs.outputFile(path.join(this.remote, p), c);
  }
  commitPendingChanges(): Promise<void> {
    return Promise.resolve();
  }
  uploadFiles(abs: string[], root: string): Promise<UploadResult> {
    return Promise.resolve({
      uploaded: [],
      unresolved: abs.map((a) => ({
        path: path.relative(root, a).split(path.sep).join("/"),
        reason: "no upload",
      })),
    });
  }
  async deletePath(p: string): Promise<DeleteResult> {
    this.deleted.push(p);
    await fs.remove(path.join(this.remote, p));
    return { path: p, status: "deleted" };
  }
  submitPrompt(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function setup(): Promise<{
  project: string;
  remote: string;
  session: Session;
  service: FigmakeSyncService;
}> {
  const base = await tmp("engine");
  const project = path.join(base, "project");
  const remote = path.join(base, "remote");
  await fs.ensureDir(project);
  await fs.outputFile(path.join(remote, "a.ts"), "a1\n");
  await fs.outputFile(path.join(remote, "b.ts"), "b1\n");
  await fs.outputFile(path.join(remote, "img.bin"), Buffer.from([0, 1, 2, 3]));
  const session = new Session(remote);
  const adapter: FigmaMakeAdapter = {
    kind: "t",
    authenticate: () => Promise.resolve(),
    openProject: () => Promise.resolve(session),
  };
  const service = new FigmakeSyncService({ adapterFactory: () => adapter });
  await service.init("https://www.figma.com/make/x", project, { cwd: project });
  await service.pull({ cwd: project, yes: true });
  return { project, remote, session, service };
}

describe("engine core", () => {
  it("a changed binary refuses the whole push before any write; ignoring it unblocks the rest, which advances only sent paths", async () => {
    const { project, session, service } = await setup();
    await fs.outputFile(path.join(project, "a.ts"), "a2\n");
    await fs.writeFile(path.join(project, "img.bin"), Buffer.from([0, 9, 9]));

    const first = await service.push({ cwd: project, yes: true });
    expect(first.stopped).toMatchObject({ phase: "preflight", code: "UNSUPPORTED_BINARY_MODIFY" });
    expect(first.stopped?.message).toContain("img.bin");
    expect(first.unresolved.map((u) => u.path)).toEqual(["img.bin"]);
    expect(session.replaced).toEqual([]);

    await service.setIgnored({ cwd: project, path: "img.bin", ignored: true });
    const second = await service.push({ cwd: project, yes: true });
    expect(second.stopped).toBeUndefined();
    expect(second.unresolved).toEqual([]);
    expect(second.verified).toBe(1);
    expect(session.replaced).toEqual(["a.ts"]);

    const third = await service.push({ cwd: project, yes: true });
    expect(session.replaced).toEqual(["a.ts"]);
    expect(third.summary.total).toBe(0);
  });

  it("skips files changed remotely when overwrite not confirmed", async () => {
    const { project, remote, session, service } = await setup();
    await fs.outputFile(path.join(project, "a.ts"), "local\n");
    await fs.outputFile(path.join(remote, "a.ts"), "remote edit\n");

    const result = await service.push({
      cwd: project,
      confirm: () => Promise.resolve(false),
    });
    expect(result.remoteDiverged).toEqual(["a.ts"]);
    expect(result.unresolved.map((u) => u.path)).toEqual(["a.ts"]);
    expect(session.replaced).toEqual([]);
  });

  it("a binary moved into a folder is refused up front: nothing is deleted, nothing is sent", async () => {
    const { project, session, service } = await setup();
    await fs.move(path.join(project, "img.bin"), path.join(project, "x", "img.bin"));
    const result = await service.push({ cwd: project, yes: true });
    expect(session.deleted).toEqual([]);
    expect(result.stopped).toMatchObject({ phase: "preflight", code: "UNSUPPORTED_BINARY_NESTED" });
    expect(result.unresolved).toEqual([expect.objectContaining({ path: "x/img.bin", code: "UNSUPPORTED_BINARY_NESTED" })]);
    // The baseline did not move: the rename is still pending next time.
    expect((await service.status({ cwd: project })).summary.total).toBe(1);
  });

  it("push cleans temp dirs", async () => {
    const { project, service } = await setup();
    await fs.outputFile(path.join(project, "a.ts"), "a3\n");
    await service.push({ cwd: project, yes: true });
    const store = new ProjectStateStore(project);
    expect(await fs.readdir(store.paths.tmpDir)).toEqual([]);
  });

  it("replaceWorkspaceFrom keeps untracked files and removes tracked-missing", async () => {
    const base = await tmp("replace");
    const project = path.join(base, "p");
    const src = path.join(base, "s");
    await fs.outputFile(path.join(project, ".env"), "SECRET");
    await fs.outputFile(path.join(project, "gone.ts"), "x");
    await fs.outputFile(path.join(src, "new.ts"), "n");
    const store = new ProjectStateStore(project);
    await store.ensureStateDirectories();
    const local = await createManifest(project, { ignore: [".env"] });
    const remote = await createManifest(src);
    await store.replaceWorkspaceFrom(src, {
      localManifest: local,
      remoteManifest: remote,
    });
    expect(await fs.pathExists(path.join(project, ".env"))).toBe(true);
    expect(await fs.pathExists(path.join(project, "gone.ts"))).toBe(false);
    expect(await fs.readFile(path.join(project, "new.ts"), "utf8")).toBe("n");
  });

  it("backups skip node_modules and corrupt manifest reads as null", async () => {
    const base = await tmp("backup");
    const project = path.join(base, "p");
    await fs.outputFile(path.join(project, "node_modules", "x", "i.js"), "1");
    await fs.outputFile(path.join(project, "src", "a.ts"), "1");
    const store = new ProjectStateStore(project);
    await store.ensureStateDirectories();
    const dir = await store.createBackup("t");
    expect(await fs.pathExists(path.join(dir, "workspace", "src", "a.ts"))).toBe(true);
    expect(await fs.pathExists(path.join(dir, "workspace", "node_modules"))).toBe(false);
    await fs.writeFile(store.paths.lastPullManifestPath, "{trunc");
    expect(await store.readLastPullManifest()).toBeNull();
  });
});
