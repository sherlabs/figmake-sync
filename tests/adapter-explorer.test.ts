/* eslint-disable @typescript-eslint/require-await */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AmbiguousRemotePathError,
  ExplorerMismatchError,
  FileChangedInFigmaError,
  LeftoverFileError,
  PlaywrightFigmaMakeProjectSession,
  TreeIndexIncompleteError,
  UiChangedError,
  WriteNotVerifiedError,
  normalizedTextHash,
  reconstructTree,
  requiredFolders,
  type AdapterContext,
  type AriaRow,
} from "../src/figma/adapter.js";
import { fakeExplorerHtml, fileNode, flattenFiles, makeProject, type FakeFaults, type FakeModel, type FakeNode } from "./support/fake-make-explorer.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeSession(): PlaywrightFigmaMakeProjectSession {
  const context = {
    // verifyEditorWrites stays false on purpose: the transaction path must be strict regardless.
    config: { adapter: { selectorOverrides: {}, downloadTimeoutMs: 8_000, verifyEditorWrites: false } },
    logger,
    paths: { artifactsDir: path.join(dir, "artifacts") },
  } as unknown as AdapterContext;
  const handle = { page, context: {}, tracePath: "", runStep: (_n: string, f: () => Promise<unknown>) => f(), close: async () => undefined };
  const s = new PlaywrightFigmaMakeProjectSession(handle as never, context, undefined, {});
  (s as unknown as { codeModeWaitMs: number; settleStartWindowMs: number }).codeModeWaitMs = 600;
  (s as unknown as { codeModeWaitMs: number; settleStartWindowMs: number }).settleStartWindowMs = 50;
  return s;
}

const hashOf = (text: string): string => normalizedTextHash(text);
let browser: Browser;
let page: Page;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "figma-explorer-"));
});
afterEach(async () => {
  await page.context().close();
  await fs.remove(dir);
});

async function load(tree: FakeNode[] = makeProject(), faults: FakeFaults = {}): Promise<void> {
  await page.setContent(fakeExplorerHtml(tree, { faults }));
}
const model = (): Promise<FakeModel> => page.evaluate(() => (window as unknown as { __model: () => FakeModel }).__model());
const openFilesTab = (): Promise<void> => page.evaluate(() => (document.getElementById("tf") as HTMLElement).click());

describe("fake explorer fixture", { timeout: 30_000 }, () => {
  it("virtualises: ~31 mounted rows, aria attributes, contiguous tops, re-render on scroll", async () => {
    await load();
    await openFilesTab();
    const read = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="treeitem"]')).map((e) => ({
          level: e.getAttribute("aria-level"),
          pos: e.getAttribute("aria-posinset"),
          size: e.getAttribute("aria-setsize"),
          label: e.getAttribute("aria-label"),
          top: parseFloat((e as HTMLElement).style.top),
        })),
      );
    const first = await read();
    expect(first.length).toBeGreaterThanOrEqual(28);
    expect(first.length).toBeLessThanOrEqual(34);
    expect(first[0]).toMatchObject({ level: "1", pos: "1", size: "54", label: ".figma", top: 0 });
    // Like the live page: the tree box is short, the scroller's scrollHeight carries the whole list.
    expect(await page.evaluate(() => (document.getElementById("scroller") as HTMLElement).scrollHeight)).toBe(54 * 32);
    expect(await page.evaluate(() => (document.getElementById("tree") as HTMLElement).getBoundingClientRect().height)).toBe(0);
    // Expand src by clicking its button; the list grows by 48 rows.
    await page.locator('[role="treeitem"][aria-label="src"] button').click();
    expect(await page.evaluate(() => (document.getElementById("scroller") as HTMLElement).scrollHeight)).toBe(102 * 32);
    await page.evaluate(async () => {
      (document.getElementById("scroller") as HTMLElement).scrollTop = 660;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const second = await read();
    expect(second.every((r) => r.level === "2")).toBe(true);
    expect(second.some((r) => r.label === "OutlookScreen.tsx")).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("create inserts a default-named row with an editable focused input; Enter applies the name", async () => {
    await load();
    await openFilesTab();
    await page.locator('[role="treeitem"][aria-label="src"] button').click({ button: "right" });
    await page.locator('[data-testid="create-file-menu-item"]').click();
    const input = page.locator('input[data-testid="code-file-name-input"]:not([readonly])');
    expect(await input.count()).toBe(1);
    expect(await input.inputValue()).toBe("new-file-5.tsx");
    // One synchronous step: a late re-render of the virtualised list can swap the input between a separate fill and Enter.
    await input.evaluate((el: HTMLInputElement) => {
      el.value = "Fresh.tsx";
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await model()).files["src/Fresh.tsx"], { timeout: 10_000 }).toBe("");
    expect((await model()).pending).toBeNull();
  });
});

describe("reconstructTree (pure)", () => {
  const row = (label: string, level: number, pos: number, size: number, top: number, kind: "file" | "folder" = "file", expanded: boolean | null = null): AriaRow =>
    ({ label, level, posinset: pos, setsize: size, top, kind, expanded, selected: false });

  it("rebuilds paths from (top, level, label) and keys by full path", () => {
    const index = reconstructTree([row("src", 1, 1, 2, 0, "folder", true), row("a.ts", 2, 1, 1, 32), row("a.ts", 1, 2, 2, 64)], 32);
    expect([...index.byPath.keys()]).toEqual(["src", "src/a.ts", "a.ts"]);
    expect(index.byPath.get("src/a.ts")).toMatchObject({ parentPath: "src", level: 2 });
    expect(index.duplicates).toEqual([]);
  });

  it("raises on a gap, a missing posinset and a wrong setsize", () => {
    expect(() => reconstructTree([row("a", 1, 1, 2, 0), row("b", 1, 2, 2, 96)], 32)).toThrow(TreeIndexIncompleteError);
    expect(() => reconstructTree([row("a", 1, 1, 3, 0), row("b", 1, 2, 3, 32)], 32)).toThrow(/2 of 3/);
    expect(() => reconstructTree([row("a", 1, 1, 2, 0), row("b", 1, 1, 2, 32)], 32)).toThrow(TreeIndexIncompleteError);
    expect(() => reconstructTree([row("a", 1, 1, 1, 0), row("b", 3, 1, 1, 32)], 32)).toThrow(/no parent/);
  });

  it("reports duplicate labels in one folder instead of guessing", () => {
    const index = reconstructTree([row("x.ts", 1, 1, 2, 0), row("x.ts", 1, 2, 2, 32)], 32);
    expect(index.duplicates).toEqual(["x.ts"]);
  });

  it("requiredFolders lists ancestors parents-first", () => {
    expect(requiredFolders(["src/lib/a.ts", "src/b.ts", "c.ts"])).toEqual(["src", "src/lib"]);
  });
});

describe("explorer index + per-file transaction against the fake virtualised tree", { timeout: 40_000 }, () => {
  it("indexes the whole explorer with aria rows: root and src OutlookScreen.tsx are distinct paths, hidden files absent", async () => {
    await load();
    const s = makeSession();
    const snap = await s.indexExplorer(["src/OutlookScreen.tsx", "src/WorkflowEmail.tsx", "OutlookScreen.tsx"]);
    expect(snap.supported).toBe(true);
    expect(snap.hiddenFiles).toBe("off");
    expect(snap.entries["src/OutlookScreen.tsx"]).toBe("file");
    expect(snap.entries["OutlookScreen.tsx"]).toBe("file");
    expect(snap.entries["src/WorkflowEmail.tsx"]).toBe("file");
    expect(snap.entries["src"]).toBe("folder");
    expect(snap.entries[".gitattributes"]).toBeUndefined();
    expect(Object.keys(snap.entries)).toHaveLength(54 + 48);
    expect(snap.duplicates).toEqual([]);
  });

  it("replaces src/OutlookScreen.tsx (the row only ever rendered in a single-level window) and leaves the root twin alone", async () => {
    const tree = makeProject();
    const files = flattenFiles(tree);
    await load(tree);
    const s = makeSession();
    const r = await s.replaceFileContents("src/OutlookScreen.tsx", "new src\n", { expectedNormalizedHash: hashOf(files["src/OutlookScreen.tsx"]!) });
    expect(r).toEqual({ status: "written" });
    const m = await model();
    expect(m.files["src/OutlookScreen.tsx"]).toBe("new src\n");
    expect(m.files["OutlookScreen.tsx"]).toBe(files["OutlookScreen.tsx"]);
    expect(m.events).toContain("open:src/OutlookScreen.tsx");
    expect(m.writes).toBe(1);
    // Second call with the same content: idempotent no-op, nothing written.
    expect(await s.replaceFileContents("src/OutlookScreen.tsx", "new src\n")).toEqual({ status: "unchanged" });
    expect((await model()).writes).toBe(1);
  });

  it("stops before writing when the editor does not show what the zip said", async () => {
    const tree = makeProject();
    await load(tree, { docOverride: { "src/mailData.ts": "edited in figma\n" } });
    const s = makeSession();
    await expect(s.replaceFileContents("src/mailData.ts", "mine\n", { expectedNormalizedHash: hashOf(flattenFiles(tree)["src/mailData.ts"]!) })).rejects.toThrow(FileChangedInFigmaError);
    expect((await model()).writes).toBe(0);
  });

  it("fails WRITE_NOT_VERIFIED when the editor never shows the written text (strict even with verifyEditorWrites=false)", async () => {
    await load(makeProject(), { editorIgnoresWrites: true });
    const s = makeSession();
    await expect(s.replaceFileContents("App.tsx", "nope\n")).rejects.toThrow(WriteNotVerifiedError);
  });

  it("a row the virtualiser never mounts makes the index incomplete (after one retry) and nothing is written", async () => {
    await load(makeProject(), { dropPath: "src/RCDiary.tsx" });
    const s = makeSession();
    await expect(s.indexExplorer(["src/OutlookScreen.tsx"])).rejects.toThrow(TreeIndexIncompleteError);
    await expect(s.replaceFileContents("src/OutlookScreen.tsx", "x")).rejects.toThrow(TreeIndexIncompleteError);
    expect((await model()).writes).toBe(0);
  });

  it("two rows with one name in a folder are ambiguous, never clicked", async () => {
    await load(makeProject({ srcExtra: [fileNode("OutlookScreen.tsx", "twin")] }));
    const s = makeSession();
    expect((await s.indexExplorer(["src/OutlookScreen.tsx"])).duplicates).toEqual(["src/OutlookScreen.tsx"]);
    await expect(s.replaceFileContents("src/OutlookScreen.tsx", "x")).rejects.toThrow(AmbiguousRemotePathError);
    expect((await model()).writes).toBe(0);
  });

  it("a path the zip has but the explorer does not is EXPLORER_MISMATCH", async () => {
    await load();
    const s = makeSession();
    await expect(s.replaceFileContents("src/Missing.tsx", "x")).rejects.toThrow(ExplorerMismatchError);
    expect((await s.indexExplorer(["src/Missing.tsx"])).entries["src/Missing.tsx"]).toBeUndefined();
  });

  it("opens the right file even when the explorer never marks rows selected (content fallback)", async () => {
    await load(makeProject(), { clickNoSelect: true });
    const s = makeSession();
    expect(await s.replaceFileContents("src/WorkflowEmail.tsx", "w\n")).toEqual({ status: "written" });
    expect((await model()).files["src/WorkflowEmail.tsx"]).toBe("w\n");
  });

  it("hidden dot-file: switches 'Show hidden files' on, edits it, and switches it back off on close", async () => {
    await load();
    const s = makeSession();
    const snap = await s.indexExplorer([".gitattributes"]);
    expect(snap.hiddenFiles).toBe("on");
    expect(snap.entries[".gitattributes"]).toBe("file");
    expect(await s.replaceFileContents(".gitattributes", "* text=auto eol=lf\n", { expectedNormalizedHash: hashOf("* text=auto\n") })).toEqual({ status: "written" });
    await s.close();
    const m = await model();
    expect(m.files[".gitattributes"]).toBe("* text=auto eol=lf\n");
    expect(m.hiddenShown).toBe(false);
    expect(m.events.filter((e) => e.startsWith("hidden:"))).toEqual(["hidden:true", "hidden:false"]);
  });

  it("hidden dot-file without a toggle: reported as unavailable, nothing written", async () => {
    await load(makeProject(), { noHiddenToggle: true });
    const s = makeSession();
    expect((await s.indexExplorer([".mise.toml"])).hiddenFiles).toBe("unavailable");
    expect((await model()).writes).toBe(0);
  });

  it("creates a nested file, a folder and a file inside the new folder, and a root file via the Files menu", async () => {
    await load();
    const s = makeSession();
    expect(await s.createFile("src/Fresh.tsx", "fresh\n")).toEqual({ status: "written" });
    await s.createFolder("src/lib");
    expect(await s.createFile("src/lib/util.ts", "util\n")).toEqual({ status: "written" });
    expect(await s.createFile("Top.ts", "top\n")).toEqual({ status: "written" });
    const m = await model();
    expect(m.files["src/Fresh.tsx"]).toBe("fresh\n");
    expect(m.files["src/lib/util.ts"]).toBe("util\n");
    expect(m.files["Top.ts"]).toBe("top\n");
    expect(m.folders).toContain("src/lib");
    expect(m.events).toContain("created:src/Fresh.tsx");
    expect(Object.keys(m.files).some((p) => /new-file/.test(p) && !/^(src\/)?new-file(-[1-4])?\.tsx$/.test(p))).toBe(false);
    // Creating what exists already is a mismatch (zip stale or index wrong), never a duplicate.
    await expect(s.createFile("src/Fresh.tsx", "again")).rejects.toThrow(ExplorerMismatchError);
  });

  it("create with only read-only name inputs: no Enter, no leftover, the op fails", async () => {
    await load(makeProject(), { readonlyNameInput: true });
    const s = makeSession();
    await expect(s.createFile("src/Broken.tsx", "x")).rejects.toThrow(UiChangedError);
    const m = await model();
    expect(m.events).not.toContain("enter");
    expect(m.pending).toBeNull();
    expect(Object.keys(m.files).filter((p) => p.startsWith("src/new-file"))).toHaveLength(5);
  });

  it("create whose name never applies: LEFTOVER_FILE names the folder and the default-named file", async () => {
    await load(makeProject(), { renameFails: true });
    const s = makeSession();
    const err = await s.createFile("src/Stuck.tsx", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeftoverFileError);
    expect((err as Error).message).toContain("new-file-5.tsx");
    expect((err as Error).message).toContain("src");
    expect((await model()).files["src/new-file-5.tsx"]).toBe("");
  });

  it("context menu that never opens: retried once, then UI_CHANGED and nothing created", async () => {
    await load(makeProject(), { contextMenuNever: true });
    const s = makeSession();
    await expect(s.createFile("src/Never.tsx", "x")).rejects.toThrow(UiChangedError);
    expect((await model()).files["src/Never.tsx"]).toBeUndefined();
  });

  it("delete is truthful: seen-to-disappear = deleted; row stays = failed; row absent = EXPLORER_MISMATCH", async () => {
    await load();
    const s = makeSession();
    expect(await s.deletePath("src/WorkflowEmail.tsx")).toMatchObject({ status: "deleted" });
    expect((await model()).files["src/WorkflowEmail.tsx"]).toBeUndefined();
    expect((await model()).files["WorkflowEmail.tsx"]).toBeDefined();
    expect(await s.deletePath(".mise.toml")).toMatchObject({ status: "failed", code: "EXPLORER_MISMATCH" });
    await page.evaluate(() => {
      (window as unknown as { __fault: FakeFaults }).__fault = { deleteNoop: true };
    });
    expect(await s.deletePath("src/RCDiary.css")).toMatchObject({ status: "failed", code: "DELETE_NOT_VERIFIED" });
    expect((await model()).files["src/RCDiary.css"]).toBeDefined();
  });
});

describe("slow loads and the first open", { timeout: 40_000 }, () => {
  it("rows that mount late are still indexed by the aria path, never by the pixel scan", async () => {
    await page.setContent(fakeExplorerHtml(makeProject(), { mountDelayMs: 2_500 }));
    const s = makeSession();
    const snap = await s.indexExplorer(["src/OutlookScreen.tsx"]);
    expect(snap.supported).toBe(true);
    expect(snap.entries["src/OutlookScreen.tsx"]).toBe("file");
    expect(await s.replaceFileContents("src/OutlookScreen.tsx", "late\n")).toEqual({ status: "written" });
    expect((await model()).files["src/OutlookScreen.tsx"]).toBe("late\n");
  });

  it("an empty tree does not lock the session into the legacy path", async () => {
    await page.setContent(fakeExplorerHtml([]));
    const s = makeSession();
    expect((await s.indexExplorer(["a.ts"])).supported).toBe(false);
    expect((s as unknown as { ariaTree: boolean | null }).ariaTree).toBeNull();
  });

  it("the first file of a session opens although no editor surface existed before the click", async () => {
    await load();
    expect(await page.locator(".cm-content").count()).toBe(0);
    const s = makeSession();
    const t0 = Date.now();
    expect(await s.replaceFileContents("App.tsx", "first\n")).toEqual({ status: "written" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("could not independently confirm"));
  });
});
