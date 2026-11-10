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

const START = { phase: "start", projectName: null, previewUrl: null, changes: [], changeFiles: [], changeIds: [], projects: [], activeKey: null, syncedAt: null, updatesEnabled: true, canSend: false, canUndo: false, agent: null, workspace: "figmake-sync" };
const READY = { ...START, phase: "ready", projectName: "Checkout Flow", previewUrl: "http://localhost:5173/", agent: "claude", activeKey: "a", projects: [{ key: "a", name: "Checkout Flow", status: "synced", syncedAt: null }] };

async function open(state: object, size: { width: number; height: number }, scheme: "light" | "dark"): Promise<Page> {
  const ctx = await (browser as Browser).newContext({ viewport: size, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript((s: object) => {
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
      newChat: noop, copyText: noop, openProject: noop, ask: noop, undo: noop, send: noop, cancel: noop, retry: noop, setAgent: noop,
      chooseWorkspace: noop, signOutFigma: noop, setUpdates: noop, switchProject: noop, removeProject: noop, reportIssue: noop, installUpdate: noop,
    };
  }, state);
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
});
