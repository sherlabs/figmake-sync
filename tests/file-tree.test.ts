import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanRelative, listFolder, readFileView, resolveInside, TEXT_CAP } from "../src/app/fileTree.js";
import { buildProcesses } from "../src/app/processes.js";

let base = "";
let root = "";
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "filetree-")));
  root = path.join(base, "project");
  await fs.outputFile(path.join(root, "src", "App.tsx"), "export const a = 1;\r\nexport const b = 2;\n");
  await fs.outputFile(path.join(root, "src", "components", "Button.tsx"), "x");
  await fs.outputFile(path.join(root, "src", "zeta.css"), "body {}");
  await fs.outputFile(path.join(root, "package.json"), "{}");
  await fs.outputFile(path.join(root, "README.md"), "hi");
  await fs.outputFile(path.join(root, "public", "logo.png"), Buffer.from([137, 80, 78, 71, 0, 1]));
  await fs.outputFile(path.join(root, "node_modules", "dep", "index.js"), "x");
  await fs.outputFile(path.join(root, ".git", "config"), "x");
  await fs.outputFile(path.join(root, ".figmake-sync", "config.json"), "secret");
  await fs.outputFile(path.join(root, "dist", "out.js"), "x");
  await fs.outputFile(path.join(root, "backups", "old.txt"), "x");
  await fs.outputFile(path.join(base, "outside.txt"), "outside secret");
});
afterEach(() => fs.remove(base));

describe("file explorer: path safety", () => {
  it("accepts plain relative paths and rejects everything else", () => {
    expect(cleanRelative("src/App.tsx")).toBe("src/App.tsx");
    expect(cleanRelative("./src//components/")).toBe("src/components");
    expect(cleanRelative("")).toBe("");
    for (const bad of ["../x", "src/../../x", "..\\x", "/etc/passwd", "C:/Windows", ".git/config", "node_modules/a", "src/.figmake-sync/x", "a\0b", 42, null, "x".repeat(2000)]) {
      expect(cleanRelative(bad), String(bad)).toBeNull();
    }
  });

  it("resolves inside the project only", async () => {
    expect(await resolveInside(root, "src/App.tsx")).toBe(await fs.realpath.native(path.join(root, "src", "App.tsx")));
    expect(await resolveInside(root, "../outside.txt")).toBeNull();
    expect(await resolveInside(root, "/etc/passwd")).toBeNull();
    expect(await resolveInside(root, "src/nope.ts")).toBeNull();
  });

  it("refuses symlinks that lead outside, but not ones that stay inside", async () => {
    await fs.symlink(path.join(base, "outside.txt"), path.join(root, "src", "leak.txt"));
    await fs.symlink(base, path.join(root, "src", "up"));
    await fs.symlink(path.join(root, "package.json"), path.join(root, "src", "pkg-link.json"));
    expect(await resolveInside(root, "src/leak.txt")).toBeNull();
    expect(await resolveInside(root, "src/up")).toBeNull();
    expect(await resolveInside(root, "src/up/outside.txt")).toBeNull();
    expect((await readFileView(root, "src/leak.txt")).kind).toBe("missing");
    expect((await readFileView(root, "src/up/outside.txt")).kind).toBe("missing");
    expect((await listFolder(root, "src/up")).entries).toEqual([]);
    expect((await readFileView(root, "src/pkg-link.json")).kind).toBe("text");
    // Links are never listed at all.
    expect((await listFolder(root, "src")).entries.map((e) => e.name)).not.toContain("leak.txt");
  });

  it("never reads the app's own folders", async () => {
    for (const p of [".figmake-sync/config.json", ".git/config", "node_modules/dep/index.js", "dist/out.js", "backups/old.txt"]) {
      expect((await readFileView(root, p)).kind, p).toBe("missing");
    }
  });
});

describe("file explorer: tree listing", () => {
  it("puts src first, then folders, then files, and hides tooling folders and dotfiles", async () => {
    const top = await listFolder(root, "");
    expect(top.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(["folder:src", "folder:public", "file:package.json", "file:README.md"]);
    expect(top.truncated).toBe(false);
  });

  it("lists one folder at a time with project-relative paths", async () => {
    const src = await listFolder(root, "src");
    expect(src.entries.map((e) => e.path)).toEqual(["src/components", "src/App.tsx", "src/zeta.css"]);
    expect((await listFolder(root, "src/components")).entries.map((e) => e.path)).toEqual(["src/components/Button.tsx"]);
  });

  it("caps a huge folder and says so", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => fs.outputFile(path.join(root, "src", "many", `f${String(i).padStart(2, "0")}.txt`), "x")));
    const many = await listFolder(root, "src/many", 10);
    expect(many.entries).toHaveLength(10);
    expect(many.truncated).toBe(true);
  });

  it("returns an empty listing for bad or missing folders", async () => {
    expect(await listFolder(root, "../")).toEqual({ path: "", entries: [], truncated: false });
    expect((await listFolder(root, "nope")).entries).toEqual([]);
    expect((await listFolder(root, "package.json")).entries).toEqual([]);
  });
});

describe("file explorer: viewer", () => {
  it("returns text with normalised line endings and a line count", async () => {
    expect(await readFileView(root, "src/App.tsx")).toEqual({ kind: "text", path: "src/App.tsx", text: "export const a = 1;\nexport const b = 2;\n", lines: 2 });
  });

  it("previews images as data URLs", async () => {
    const view = await readFileView(root, "public/logo.png");
    expect(view.kind).toBe("image");
    expect(view.kind === "image" && view.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not show binary or oversized files", async () => {
    await fs.outputFile(path.join(root, "src", "blob.dat"), Buffer.from([1, 2, 0, 3]));
    await fs.outputFile(path.join(root, "src", "big.txt"), "a".repeat(TEXT_CAP + 1));
    expect(await readFileView(root, "src/blob.dat")).toMatchObject({ kind: "binary", size: 4 });
    expect(await readFileView(root, "src/big.txt")).toMatchObject({ kind: "large" });
    expect((await readFileView(root, "src/components")).kind).toBe("missing");
    expect((await readFileView(root, "src/gone.ts")).kind).toBe("missing");
  });
});

describe("running things table", () => {
  const base_ = { hasProject: true, phase: "ready" as const, previewUrl: "http://localhost:5173/", dev: null, installing: false, agentWorking: false, agentName: "Claude" };

  it("is empty without a project", () => {
    expect(buildProcesses({ ...base_, hasProject: false })).toEqual([]);
  });

  it("maps preview server states to plain ones", () => {
    const state = (dev: "running" | "starting" | "stopped" | "crashed" | null, extra = {}) => buildProcesses({ ...base_, dev: dev ? { state: dev } : null, ...extra })[0];
    expect(state("running")).toMatchObject({ state: "running", canStop: true, canRestart: true });
    expect(state("starting")).toMatchObject({ state: "starting", canStop: true, canRestart: false });
    expect(state("stopped", { previewUrl: null })).toMatchObject({ state: "stopped", canStop: false, canRestart: true });
    expect(state("crashed")).toMatchObject({ state: "failed", canStop: false, canRestart: true, note: "The preview stopped unexpectedly." });
    expect(state(null)).toMatchObject({ state: "running" });
    expect(state(null, { previewUrl: null, phase: "preparing" })).toMatchObject({ state: "starting" });
    expect(state(null, { previewUrl: null })).toMatchObject({ state: "stopped" });
  });

  it("locks the preview buttons while something else is going on", () => {
    expect(buildProcesses({ ...base_, phase: "sending" })[0]).toMatchObject({ canStop: false, canRestart: false });
  });

  it("adds setup and the AI helper only while they are active, with Stop but no Restart", () => {
    const list = buildProcesses({ ...base_, phase: "working", installing: true, agentWorking: true, agentName: "ChatGPT" });
    expect(list.map((p) => p.id)).toEqual(["preview", "install", "agent"]);
    expect(list[2]).toMatchObject({ name: "ChatGPT (AI helper)", state: "running", canStop: true, canRestart: false });
    expect(list[1]).toMatchObject({ canStop: true, canRestart: false });
  });

  it("never exposes commands or process ids", () => {
    expect(JSON.stringify(buildProcesses({ ...base_, installing: true, agentWorking: true }))).not.toMatch(/npm|pid|vite/iu);
  });
});
