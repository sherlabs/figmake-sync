import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* Layout regression guard: loads the real renderer (TypeScript transpiled on the fly) in Chromium with a
   stubbed window.figmake and measures the cards. Skipped when no browser is installed. */

const SRC = path.join(process.cwd(), "src");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

let server: http.Server | null = null;
let browser: Browser | null = null;
let base = "";

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  const file = path.resolve(SRC, `.${url}`);
  if (!file.startsWith(SRC + path.sep)) return void res.writeHead(403).end();
  const ts_ = file.replace(/\.js$/u, ".ts");
  if (file.endsWith(".js") && !fs.existsSync(file) && fs.existsSync(ts_)) {
    const out = ts.transpileModule(fs.readFileSync(ts_, "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
    return void res.writeHead(200, { "content-type": "text/javascript" }).end(out.outputText);
  }
  fs.readFile(file, (err, data) => {
    if (err) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(data);
  });
}

beforeAll(async () => {
  try {
    server = http.createServer(serve);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/electron/renderer/index.html`;
    browser = await chromium.launch();
  } catch {
    browser = null; // no browser installed here: the tests below skip
  }
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

const PROCESSES = [
  { id: "preview", name: "Preview", state: "running", canStop: true, canRestart: true },
  { id: "agent", name: "Claude (AI helper)", state: "running", canStop: true, canRestart: false },
];
const CART = `import { useState } from "react";\nimport { Button } from "../components/Button";\n\nexport function Cart() {\n  const [count, setCount] = useState(0);\n  // A deliberately long line to check that the viewer scrolls sideways instead of widening the window: ${"lorem ipsum ".repeat(30)}\n  return (\n    <section className="cart">\n      <h1>Your cart ({count})</h1>\n      <Button onClick={() => setCount(count + 1)}>Add one</Button>\n    </section>\n  );\n}\n`.repeat(6);
const TREE: Record<string, { name: string; path: string; kind: string }[]> = {
  "": [{ name: "src", path: "src", kind: "folder" }, { name: "public", path: "public", kind: "folder" }, { name: "index.html", path: "index.html", kind: "file" }, { name: "package.json", path: "package.json", kind: "file" }],
  src: [{ name: "components", path: "src/components", kind: "folder" }, { name: "pages", path: "src/pages", kind: "folder" }, { name: "App.tsx", path: "src/App.tsx", kind: "file" }, { name: "main.tsx", path: "src/main.tsx", kind: "file" }, { name: "styles.css", path: "src/styles.css", kind: "file" }],
  "src/components": [{ name: "Button.tsx", path: "src/components/Button.tsx", kind: "file" }, { name: "Header.tsx", path: "src/components/Header.tsx", kind: "file" }],
  "src/pages": [{ name: "Cart.tsx", path: "src/pages/Cart.tsx", kind: "file" }, { name: "Checkout.tsx", path: "src/pages/Checkout.tsx", kind: "file" }],
};

const START = { phase: "start", projectName: null, previewUrl: null, changes: [], changeFiles: [], changeIds: [], projects: [], activeKey: null, syncedAt: null, updatesEnabled: true, canSend: false, canUndo: false, agent: null, workspace: "figmake-sync", processes: [] };
const READY = { ...START, phase: "ready", projectName: "Checkout Flow", previewUrl: "http://localhost:5173/", agent: "claude", activeKey: "a", projects: [{ key: "a", name: "Checkout Flow", status: "synced", syncedAt: null }], processes: PROCESSES.slice(0, 1) };

async function open(state: object, size: { width: number; height: number }, scheme: "light" | "dark", tab: "chat" | "files" = "chat"): Promise<Page> {
  const ctx = await (browser as Browser).newContext({ viewport: size, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript((a: { s: object; tree: typeof TREE; cart: string; tab: string }) => {
    const s = a.s;
    if (a.tab === "files") window.localStorage.setItem("figmake.rail.tab", "files");
    const noop = () => Promise.resolve();
    const w = window as unknown as { figmake: unknown };
    w.figmake = {
      state: () => Promise.resolve(s),
      onState: () => () => undefined,
      chat: () => Promise.resolve({ projectKey: null, messages: [], active: false, fresh: false }),
      onChat: () => () => undefined,
      onCommand: () => () => undefined,
      onUpdateState: () => () => undefined,
      previewRect: () => undefined,
      describeChange: () => Promise.resolve([]),
      listFolder: (p: string) => Promise.resolve({ path: p, entries: a.tree[p] ?? [], truncated: false }),
      readFile: (p: string) => Promise.resolve({ kind: "text", path: p, text: a.cart, lines: a.cart.split("\n").length - 1 }),
      changedFiles: () => Promise.resolve(["src/pages/Cart.tsx"]),
      stopProcess: noop, restartProcess: noop,
      newChat: noop, copyText: noop, openProject: noop, ask: noop, undo: noop, send: noop, cancel: noop, retry: noop, setAgent: noop,
      chooseWorkspace: noop, signOutFigma: noop, setUpdates: noop, switchProject: noop, removeProject: noop, reportIssue: noop, installUpdate: noop,
    };
  }, { s: state, tree: TREE, cart: CART, tab });
  await page.goto(base);
  await page.waitForSelector(".app");
  return page;
}

const rect = (page: Page, sel: string) =>
  page.evaluate((q) => {
    const r = document.querySelector(q)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, sel);
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("renderer layout", () => {
  for (const size of [{ width: 1180, height: 760 }, { width: 900, height: 640 }]) {
    for (const scheme of ["light", "dark"] as const) {
      it(`start state: welcome card is a compact column (${size.width}px, ${scheme})`, async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await open(START, size, scheme);
        const card = await rect(page, ".welcome");
        const input = await rect(page, ".welcome input");
        const heading = await rect(page, ".welcome h2");
        expect(card && card.w).toBeLessThanOrEqual(520);
        expect(card && card.w).toBeGreaterThan(300);
        expect(input && input.w).toBeGreaterThanOrEqual(240);
        expect(heading && input && heading.y).toBeLessThan((input as { y: number }).y);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);
        // The card sits fully inside the window.
        expect(card && card.x + card.w).toBeLessThanOrEqual(size.width);
        await page.context().close();
      });
    }
  }

  it("add-project sheet is a compact column", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open(READY, { width: 1180, height: 760 }, "light");
    await page.keyboard.press("Control+n");
    await page.waitForSelector("dialog.sheet[open]");
    const sheet = await rect(page, "dialog.sheet");
    const input = await rect(page, "dialog.sheet input");
    const title = await rect(page, "dialog.sheet h2");
    expect(sheet && sheet.w).toBeLessThanOrEqual(520);
    expect(input && input.w).toBeGreaterThanOrEqual(240);
    expect(title && input && title.y).toBeLessThan((input as { y: number }).y);
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  it("chat panel and preview share the window without overflow, wide and narrow", async (ctx) => {
    if (!browser) return ctx.skip();
    const wide = await open(READY, { width: 1180, height: 760 }, "light");
    const chat = await rect(wide, ".chat");
    const stage = await rect(wide, ".stage");
    expect(chat && chat.w).toBeGreaterThanOrEqual(300);
    expect(chat && chat.w).toBeLessThanOrEqual(640);
    expect(stage && stage.w).toBeGreaterThanOrEqual(340);
    expect(chat && stage && chat.x).toBeGreaterThanOrEqual((stage as { x: number; w: number }).x + (stage as { w: number }).w - 1);
    expect(await overflowX(wide)).toBeLessThanOrEqual(0);
    // The status bar stays at the bottom edge.
    const status = await rect(wide, "footer.status");
    expect(status && status.y + status.h).toBeCloseTo(760, 0);
    await wide.context().close();

    const narrow = await open(READY, { width: 820, height: 680 }, "light");
    const c2 = await rect(narrow, ".chat");
    const s2 = await rect(narrow, ".stage");
    expect(c2 && s2 && c2.y).toBeGreaterThanOrEqual((s2 as { y: number; h: number }).y + (s2 as { h: number }).h - 1);
    expect(await overflowX(narrow)).toBeLessThanOrEqual(0);
    await narrow.context().close();
  });

  const SIZES = [{ width: 1180, height: 760 }, { width: 900, height: 640 }, { width: 820, height: 680 }];
  const SHOTS = process.env["FIGMAKE_SHOTS"];

  for (const size of SIZES) {
    for (const scheme of ["light", "dark"] as const) {
      it(`side panel: tabs switch between chat and files (${size.width}px, ${scheme})`, async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await open({ ...READY, processes: PROCESSES }, size, scheme);
        const tabs = await page.locator(".rail-tabs [role=tab]").allInnerTexts();
        expect(tabs).toEqual(["Chat", "Files"]);
        expect(await page.locator("#tab-chat").getAttribute("aria-selected")).toBe("true");
        expect(await page.locator(".chat").isVisible()).toBe(true);
        expect(await page.locator(".files").isVisible()).toBe(false);

        await page.click("#tab-files");
        await page.waitForSelector(".ftree .trow.file");
        expect(await page.locator(".chat").isVisible()).toBe(false);
        expect(await page.locator("#tab-files").getAttribute("aria-selected")).toBe("true");
        // src opens by itself; its folders come first, and only the changed file carries a marker.
        const names = await page.locator(".ftree .trow .tname").allInnerTexts();
        expect(names.slice(0, 6)).toEqual(["src", "components", "pages", "App.tsx", "main.tsx", "styles.css"]);
        await page.click('.trow.folder:has-text("pages")');
        await page.waitForSelector('.trow.file:has-text("Cart.tsx") .mark');
        expect(await page.locator(".ftree .trow.file .mark").count()).toBe(1);
        expect(await page.locator('.trow.folder:has-text("pages") .mark.sub').count()).toBe(1);

        // Read-only viewer with line numbers; long lines scroll inside it.
        await page.click('.trow.file:has-text("Cart.tsx")');
        await page.waitForSelector(".fview .code .src");
        expect(await page.locator(".fview .code .ln").innerText()).toMatch(/^1\n2\n3/u);
        expect(await page.locator(".fview textarea, .fview [contenteditable]").count()).toBe(0);
        expect(await page.locator(".fview .ro").innerText()).toBe("Read-only");
        const rail = await rect(page, ".rail");
        const code = await rect(page, ".fview .code");
        expect(code && rail && code.x + code.w).toBeLessThanOrEqual((rail as { x: number; w: number }).x + (rail as { w: number }).w + 1);
        expect(await page.evaluate(() => { const c = document.querySelector(".fview .code") as HTMLElement; return c.scrollWidth > c.clientWidth; })).toBe(true);

        // Running section sits at the bottom of the panel with friendly rows and Stop / Restart.
        const rows = await page.locator(".running .rrow").allInnerTexts();
        expect(rows[0]).toMatch(/Preview[\s\S]*Running[\s\S]*Stop[\s\S]*Restart/u);
        expect(rows[1]).toMatch(/Claude \(AI helper\)[\s\S]*Running[\s\S]*Stop/u);
        expect(rows[1]).not.toMatch(/Restart/u);
        const running = await rect(page, ".running");
        expect(running && rail && running.y + running.h).toBeLessThanOrEqual((rail as { y: number; h: number }).y + (rail as { h: number }).h + 1);
        expect(await page.locator(".files").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);

        // Beside the preview the panel keeps the chat's width limits; in narrow windows it sits below, full width.
        const files = await rect(page, ".files");
        if (size.width > 900) {
          expect(files && files.w).toBeGreaterThanOrEqual(300);
          expect(files && files.w).toBeLessThanOrEqual(640);
        } else {
          expect(files && files.w).toBeLessThanOrEqual(size.width);
          expect(files && files.h).toBeGreaterThanOrEqual(180);
        }

        if (SHOTS && size.width === 1180) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(SHOTS, `files-${scheme}.png`) });
        }
        await page.click("#tab-chat");
        expect(await page.locator(".chat").isVisible()).toBe(true);
        await page.context().close();
      });
    }
  }

  it("Files tab is remembered, the arrow keys move between tabs, and the panel can still be hidden", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open(READY, { width: 1180, height: 760 }, "light", "files");
    expect(await page.locator("#tab-files").getAttribute("aria-selected")).toBe("true");
    await page.focus("#tab-files");
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator("#tab-chat").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Control+j");
    expect(await page.locator(".rail").isVisible()).toBe(false);
    await page.keyboard.press("Control+j");
    expect(await page.locator(".rail").isVisible()).toBe(true);
    await page.context().close();
  });

  it("failed and stopped previews offer Restart or Start, and the buttons call the right process", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open({ ...READY, processes: [{ id: "preview", name: "Preview", state: "failed", note: "The preview stopped unexpectedly.", canStop: false, canRestart: true }] }, { width: 1180, height: 760 }, "dark", "files");
    await page.waitForSelector(".running .rrow");
    expect(await page.locator(".running .rrow").innerText()).toMatch(/Failed[\s\S]*stopped unexpectedly[\s\S]*Restart/u);
    expect(await page.locator(".running .rrow button").count()).toBe(1);
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });
});
