/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlaywrightFigmaMakeProjectSession, type AdapterContext } from "../src/figma/adapter.js";
import { parseLocalSelectors } from "../src/figma/selectors.js";
import { gateSelector } from "../src/heal/gate.js";
import { HealSession } from "../src/heal/heal.js";
import { SelectorOverrideStore } from "../src/heal/overrideStore.js";
import type { HealContext, Healer } from "../src/heal/types.js";

// Replicates the LIVE Figma Make structure (verified against a real project): top tabs Browser/Files as plain buttons
// in a nav (text inside spans next to an aria-hidden svg), Files header actions button -> role=menu with menuitems,
// hidden multi-file input, contenteditable prompt box + Send, autosave status wrapper around the editor.
const NEW_UI = `
<style>[hidden]{display:none!important}</style>
<nav>
  <button data-workspace-tab="true" aria-pressed="true" id="tb" type="button"><span><svg aria-hidden="true" width="8" height="8"></svg></span><span>Browser</span></button>
  <button data-workspace-tab="true" aria-pressed="false" id="tf" type="button"><span><svg aria-hidden="true" width="8" height="8"></svg></span><span>Files</span></button>
  <button aria-label="Close Files tab" type="button"></button>
</nav>
<div id="browser" data-testid="figmake-full-view">preview of the app</div>
<div id="files" hidden>
  <button data-testid="files-header-actions-menu-button" aria-label="File actions" data-tooltip="File actions" id="am" type="button">...</button>
  <div role="menu" id="menu" hidden>
    <div role="menuitem" data-testid="create-file-header-button">Create file</div>
    <div role="menuitem" data-testid="create-folder-menu-item">Create folder</div>
    <div role="menuitem" data-testid="upload-file-header-button">Upload file</div>
    <div role="menuitem" id="dl">Download code</div>
    <div role="menuitem">Hard refresh</div>
  </div>
  <input type="file" multiple hidden data-testid="upload-file-input">
  <div data-testid="virtualized-file-tree-container"><button data-testid="code-file-item" type="button">App.tsx</button></div>
  <div data-testid="code-layer-persistence-status" data-code-layer-persistence-status="unknown">
    <div data-testid="code-editor" role="textbox" contenteditable="true" style="width:200px;height:40px">code</div>
  </div>
  <div data-testid="code-chat-chat-box" role="textbox" aria-label="Prompt for AI agent" contenteditable="true" style="width:200px;height:30px"></div>
  <button data-testid="code-chat-send-button" aria-label="Send" id="send" type="button">^</button>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  $('tf').addEventListener('click', () => { $('browser').hidden = true; $('files').hidden = false; $('tf').setAttribute('aria-pressed','true'); $('tb').setAttribute('aria-pressed','false'); });
  $('tb').addEventListener('click', () => { $('browser').hidden = false; $('files').hidden = true; $('tb').setAttribute('aria-pressed','true'); $('tf').setAttribute('aria-pressed','false'); });
  $('am').addEventListener('click', () => { $('menu').hidden = !$('menu').hidden; });
  $('dl').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['zipdata'])); a.download = 'Project.zip'; document.body.appendChild(a); a.click(); $('menu').hidden = true;
  });
  $('send').addEventListener('click', () => { const b = document.querySelector('[data-testid=code-chat-chat-box]'); if (b.innerText.trim()) b.innerText = ''; });
</script>`;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
  const context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "figma-newui-"));
});
afterEach(async () => {
  await page.context().close();
  await fs.remove(dir);
});

function makeSession(heal?: HealContext, overrides: Record<string, string[]> = {}, local = {}): PlaywrightFigmaMakeProjectSession {
  const context = {
    config: { adapter: { selectorOverrides: overrides, downloadTimeoutMs: 8_000, verifyEditorWrites: true } },
    logger,
    paths: { artifactsDir: path.join(dir, "artifacts") },
    ...(heal ? { heal } : {}),
  } as unknown as AdapterContext;
  const handle = { page, context: {}, tracePath: "", runStep: (_n: string, f: () => Promise<unknown>) => f(), close: async () => undefined };
  const s = new PlaywrightFigmaMakeProjectSession(handle as never, context, undefined, local);
  (s as unknown as { codeModeWaitMs: number }).codeModeWaitMs = 600;
  return s;
}
type Priv = {
  ensureCodeSurfaceReady(): Promise<void>;
  saveEditor(): Promise<void>;
};
const priv = (s: PlaywrightFigmaMakeProjectSession): Priv => s as unknown as Priv;

function ctx(healer: Healer | undefined): HealContext {
  return { store: new SelectorOverrideStore({ filePath: path.join(dir, "ov.json") }), healer, artifactsDir: path.join(dir, "artifacts") };
}

describe("new Figma Make UI (Browser / Files tabs)", { timeout: 40_000 }, () => {
  beforeEach(() => page.setContent(NEW_UI));

  it("switches Browser -> Files with the built-in selectors only (no healer)", async () => {
    await priv(makeSession()).ensureCodeSurfaceReady();
    expect(await page.locator('[data-testid="code-editor"]').isVisible()).toBe(true);
    expect(await page.locator("#browser").isVisible()).toBe(false);
  });

  it("selectors.local.json hotfix wins over the defaults for a renamed tab", async () => {
    await page.evaluate(() => {
      const t = document.getElementById("tf") as HTMLElement;
      t.removeAttribute("data-workspace-tab");
      t.setAttribute("data-custom", "files-tab");
      t.innerHTML = "<span>Sources</span>";
    });
    const local = parseLocalSelectors({ version: 1, keys: { codeModeButton: { selectors: ['button[data-custom="files-tab"]'] } } });
    await priv(makeSession(undefined, {}, local)).ensureCodeSurfaceReady();
    expect(await page.locator('[data-testid="code-editor"]').isVisible()).toBe(true);
  });

  it("download goes through the Files actions menu -> Download code", async () => {
    const s = makeSession();
    await priv(s).ensureCodeSurfaceReady();
    const res = await s.downloadLatestCodeZip(path.join(dir, "dl"));
    expect(res.suggestedFileName).toBe("Project.zip");
    expect(await fs.readFile(res.zipPath, "utf8")).toBe("zipdata");
  });

  it("autosave UI: save waits for the persistence indicator instead of a Save button", async () => {
    const s = makeSession();
    await priv(s).ensureCodeSurfaceReady();
    await page.evaluate(() => {
      const el = document.querySelector("[data-code-layer-persistence-status]") as HTMLElement;
      el.setAttribute("data-code-layer-persistence-status", "pending");
      setTimeout(() => el.setAttribute("data-code-layer-persistence-status", "saved"), 1_200);
    });
    const t0 = Date.now();
    await priv(s).saveEditor();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
    expect(await page.locator("[data-code-layer-persistence-status]").getAttribute("data-code-layer-persistence-status")).toBe("saved");
  });

  it("types into the contenteditable prompt box and sends with the Send testid", async () => {
    const s = makeSession();
    await page.evaluate(() => {
      (document.getElementById("tf") as HTMLElement).click();
    });
    await s.submitPrompt("make the header blue");
    expect(await page.locator('[data-testid="code-chat-chat-box"]').innerText()).toBe("");
  });
});

describe("gate shapes", () => {
  beforeEach(() => page.setContent(NEW_UI));

  it("menu items must live inside an open role=menu", async () => {
    await page.evaluate(() => {
      (document.getElementById("tf") as HTMLElement).click();
      (document.getElementById("am") as HTMLElement).click();
    });
    expect(await gateSelector(page, '[role="menuitem"]:has-text("Download code")', ["download"], "menuitem")).toMatchObject({ ok: true });
    await page.evaluate(() => {
      const d = document.createElement("button");
      d.setAttribute("aria-label", "Download all");
      d.textContent = "Download all";
      document.body.appendChild(d);
    });
    expect(await gateSelector(page, 'button[aria-label="Download all"]', ["download"], "menuitem")).toMatchObject({ ok: false, reason: expect.stringContaining("inside an open menu") });
    expect(await gateSelector(page, '[role="menuitem"]:has-text("Hard refresh")', ["download"], "menuitem")).toMatchObject({ ok: false });
  });

  it("inputs must be editable text controls", async () => {
    await page.evaluate(() => (document.getElementById("tf") as HTMLElement).click());
    expect(await gateSelector(page, '[role="textbox"][aria-label="Prompt for AI agent"]', ["prompt"], "input")).toMatchObject({ ok: true });
    expect(await gateSelector(page, 'button[aria-label="Send"]', ["send"], "input")).toMatchObject({ ok: false, reason: expect.stringContaining("editable") });
  });
});

describe("heal for a second key (downloadButton / downloadZipAction)", { timeout: 40_000 }, () => {
  it("downloadButton: legacy toolbar button renamed -> fake AI -> gate -> download started -> persisted", async () => {
    await page.setContent(`
      <button id="x" data-x="dl" aria-label="Download project" type="button">v</button>
      <button aria-label="Share" type="button">s</button>
      <script>document.getElementById('x').addEventListener('click', () => { const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['legacy'])); a.download='L.zip'; document.body.appendChild(a); a.click(); });</script>
      <div data-testid="code-editor" role="textbox" contenteditable="true" style="width:50px;height:20px">c</div>`);
    const healer = vi.fn<Healer>(async (req) =>
      req.key === "downloadButton"
        ? { selectors: ["javascript:alert(1)", "button >> nth=0", 'button[aria-label="Share"]', "button", 'button[data-x="dl"]'], reason: "renamed" }
        : null,
    );
    const c = ctx(healer);
    const s = makeSession(c);
    const res = await s.downloadLatestCodeZip(path.join(dir, "dl"));
    expect(await fs.readFile(res.zipPath, "utf8")).toBe("legacy");
    // the (absent) Files actions menu trigger is tried first and gets no usable answer; then the direct button is healed
    expect(healer.mock.calls.map((c) => c[0].key)).toEqual(["filesActionsMenuButton", "downloadButton"]);
    expect(healer.mock.calls[1]![0]).toMatchObject({ kind: "click", expectTerms: ["download"] });
    expect(c.store.get("downloadButton")).toEqual(['button[data-x="dl"]']);
  });

  it("downloadZipAction: renamed menu item inside the open menu is healed; a wrong menu item is rejected", async () => {
    await page.setContent(NEW_UI);
    await page.evaluate(() => {
      const dl = document.getElementById("dl") as HTMLElement;
      dl.textContent = "Get bundle";
      dl.setAttribute("aria-label", "Download bundle");
      dl.setAttribute("data-x", "bundle");
    });
    const healer = vi.fn<Healer>(async () => ({ selectors: ['[role="menuitem"]:has-text("Hard refresh")', '[data-x="bundle"]'] }));
    const c = ctx(healer);
    const s = makeSession(c);
    await priv(s).ensureCodeSurfaceReady();
    const res = await s.downloadLatestCodeZip(path.join(dir, "dl"));
    expect(await fs.readFile(res.zipPath, "utf8")).toBe("zipdata");
    expect(c.store.get("downloadZipAction")).toEqual(['[data-x="bundle"]']);
  });

  it("malicious proposals for a healable key persist nothing", async () => {
    await page.setContent(NEW_UI);
    await page.evaluate(() => (document.getElementById("tf") as HTMLElement).click());
    const healer = vi.fn<Healer>(async () => ({ selectors: ["javascript:alert(1)", "button >> nth=0", "div:has(script)", "text=/^$/"] }));
    const c = ctx(healer);
    const r = await new HealSession(c).tryHeal({ page, key: "uploadButton", failedSelectors: [], act: async () => true });
    expect(r).toBeNull();
    expect(c.store.get("uploadButton")).toEqual([]);
  });

  it("indicator key (promptStopButton) is gated and persisted without ever being clicked", async () => {
    await page.setContent('<button id="st" aria-label="Stop generating" type="button">[]</button><script>window.clicked=0;document.getElementById("st").addEventListener("click",()=>{window.clicked++})</script>');
    const c = ctx(async () => ({ selectors: ['button[aria-label="Stop generating"]'] }));
    const r = await new HealSession(c).tryHeal({ page, key: "promptStopButton", failedSelectors: [], act: async () => true });
    expect(r).not.toBeNull();
    expect(c.store.get("promptStopButton")).toEqual(['button[aria-label="Stop generating"]']);
    expect(await page.evaluate(() => (window as unknown as { clicked: number }).clicked)).toBe(0);
  });

  it("destructive keys never call the healer", async () => {
    await page.setContent("<button>Delete</button>");
    const healer = vi.fn<Healer>(async () => ({ selectors: ["text=Delete"] }));
    for (const key of ["deleteAction", "deleteConfirmButton"]) {
      expect(await new HealSession(ctx(healer)).tryHeal({ page, key, failedSelectors: [], act: async () => true })).toBeNull();
    }
    expect(healer).not.toHaveBeenCalled();
  });
});
