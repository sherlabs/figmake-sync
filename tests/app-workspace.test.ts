import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { parseFigmaLink, resolveProjectFolder, slugify, validateWorkspace } from "../src/app/workspace.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ws-")));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

async function fakeProject(dir: string, key: string): Promise<void> {
  await fs.outputJson(path.join(dir, ".figmake-sync", "config.json"), { figmaMakeUrl: `https://www.figma.com/make/${key}/x` });
}

describe("slugify and links", () => {
  it("makes folder-safe names", () => {
    expect(slugify("Checkout Flow")).toBe("checkout-flow");
    expect(slugify("  Café / Menü!! ")).toBe("cafe-menu");
    expect(slugify("../../etc")).toBe("etc");
    expect(slugify("???")).toBe("project");
    expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(48);
  });

  it("reads Figma Make links only", () => {
    expect(parseFigmaLink("https://www.figma.com/make/AbC123/Checkout-Flow?fullscreen=1")).toEqual({ key: "AbC123", name: "Checkout Flow", slug: "checkout-flow" });
    expect(parseFigmaLink("https://figma.com/make/AbC123")?.name).toBe("Figma Make AbC1");
    expect(parseFigmaLink("https://www.figma.com/design/AbC123/x")).toBeNull();
    expect(parseFigmaLink("https://evil.com/make/AbC123/x")).toBeNull();
    expect(parseFigmaLink("http://www.figma.com/make/AbC123/x")).toBeNull();
    expect(parseFigmaLink("nonsense")).toBeNull();
  });
});

describe("resolveProjectFolder", () => {
  const link = { key: "k1", name: "Shop", slug: "shop" };

  it("uses a free slot, never a folder that is not a figmake project", async () => {
    const ws = await tmp();
    expect(await resolveProjectFolder(ws, link)).toBe(path.join(ws, "shop"));
    await fs.outputFile(path.join(ws, "shop", "mine.txt"), "keep");
    expect(await resolveProjectFolder(ws, link)).toBe(path.join(ws, "shop-2"));
    expect(await fs.readFile(path.join(ws, "shop", "mine.txt"), "utf8")).toBe("keep");
  });

  it("skips another project's folder and reuses its own", async () => {
    const ws = await tmp();
    await fakeProject(path.join(ws, "shop"), "other");
    expect(await resolveProjectFolder(ws, link)).toBe(path.join(ws, "shop-2"));
    await fakeProject(path.join(ws, "shop-2"), "k1");
    expect(await resolveProjectFolder(ws, link)).toBe(path.join(ws, "shop-2"));
  });

  it("existing projects keep their remembered path", async () => {
    const ws = await tmp();
    const elsewhere = path.join(await tmp(), "old-place");
    await fakeProject(elsewhere, "k1");
    expect(await resolveProjectFolder(ws, link, { k1: elsewhere })).toBe(elsewhere);
    expect(await resolveProjectFolder(ws, link, { k1: path.join(ws, "gone") })).toBe(path.join(ws, "shop"));
  });
});

describe("validateWorkspace", () => {
  it("accepts a writable folder and creates a missing one", async () => {
    const base = await tmp();
    const guard = { home: await tmp(), forbidden: [] };
    expect(await validateWorkspace(path.join(base, "new", "figmake"), guard)).toBe(true);
    expect(await fs.pathExists(path.join(base, "new", "figmake"))).toBe(true);
  });

  it("rejects /, the home folder, relative paths, files, the app bundle and project folders", async () => {
    const base = await tmp();
    const home = await tmp();
    const bundle = await tmp();
    const guard = { home, forbidden: [bundle] };
    expect(await validateWorkspace("/", guard)).toBe(false);
    expect(await validateWorkspace(home, guard)).toBe(false);
    expect(await validateWorkspace("relative/dir", guard)).toBe(false);
    expect(await validateWorkspace(path.join(bundle, "inside"), guard)).toBe(false);
    await fs.outputFile(path.join(base, "file.txt"), "x");
    expect(await validateWorkspace(path.join(base, "file.txt"), guard)).toBe(false);
    await fakeProject(path.join(base, "proj"), "k");
    expect(await validateWorkspace(path.join(base, "proj"), guard)).toBe(false);
    expect(await validateWorkspace(path.join(base, "proj", "sub"), guard)).toBe(false);
  });

  it("rejects a folder that is not writable", async () => {
    if (process.getuid?.() === 0) return;
    const base = await tmp();
    const locked = path.join(base, "locked");
    await fs.ensureDir(locked);
    await fs.chmod(locked, 0o500);
    expect(await validateWorkspace(locked, { home: await tmp(), forbidden: [] })).toBe(false);
    await fs.chmod(locked, 0o700);
  });
});
