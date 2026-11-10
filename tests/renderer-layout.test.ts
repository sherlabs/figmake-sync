import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* Layout regression guard: loads the real renderer (TypeScript transpiled on the fly) in Chromium with a
   stubbed window.figmake and measures the cards. Skipped when no browser is installed. */

const SRC = path.join(process.cwd(), "src");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".json": "application/json" };

let server: http.Server | null = null;
let browser: Browser | null = null;
let base = "";

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  const vendor = "/electron/renderer/vendor/monaco/";
  const file = url.startsWith(vendor) ? path.resolve(process.cwd(), "node_modules", "monaco-editor", "min", url.slice(vendor.length)) : path.resolve(SRC, `.${url}`);
  if (!file.startsWith(SRC + path.sep) && !(url.startsWith(vendor) && file.startsWith(path.join(process.cwd(), "node_modules", "monaco-editor") + path.sep))) return void res.writeHead(403).end();
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

const START = { phase: "start", projectName: null, previewUrl: null, changes: [], changeFiles: [], changeIds: [], projects: [], activeKey: null, syncedAt: null, updatesEnabled: true, canSend: false, canUndo: false, agent: null, agentConnected: false, workspace: "figmake-sync", processes: [], activity: { lines: [], stepStartedAt: null, startedAt: null } };
const READY = { ...START, phase: "ready", projectName: "Checkout Flow", previewUrl: "http://localhost:5173/", agent: "claude", agentConnected: true, activeKey: "a", projects: [{ key: "a", name: "Checkout Flow", status: "synced", syncedAt: null }], processes: PROCESSES.slice(0, 1) };

const UPDATE_IDLE = { phase: "idle", currentVersion: "0.1.18", supported: true, upToDate: false };

async function open(state: object, size: { width: number; height: number }, scheme: "light" | "dark", tab: "chat" | "files" = "chat", update: object = UPDATE_IDLE): Promise<Page> {
  const ctx = await (browser as Browser).newContext({ viewport: size, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript((a: { s: object; tree: typeof TREE; cart: string; tab: string; upd: object }) => {
    const s = a.s;
    if (a.tab === "files") window.localStorage.setItem("figmake.rail.tab", "files");
    const noop = () => Promise.resolve();
    const w = window as unknown as { figmake: unknown };
    w.figmake = {
      state: () => Promise.resolve(s),
      onState: (cb: (st: object) => void) => { (window as unknown as { __push: unknown }).__push = cb; return () => undefined; },
      chat: () => Promise.resolve({ projectKey: null, messages: [], active: false, fresh: false }),
      onChat: (cb: (c: object) => void) => { (window as unknown as { __pushChat: unknown }).__pushChat = cb; return () => undefined; },
      onCommand: () => () => undefined,
      onUpdateState: () => () => undefined,
      updateState: () => Promise.resolve(a.upd),
      checkForUpdates: () => { (window as unknown as { __checks: number }).__checks = ((window as unknown as { __checks?: number }).__checks ?? 0) + 1; return Promise.resolve({ ...a.upd, phase: "idle", upToDate: true }); },
      previewRect: () => undefined,
      browser: () => Promise.resolve((window as unknown as { __browser?: object }).__browser ?? { tabs: [], activeId: 1 }),
      onBrowser: (cb: (st: object) => void) => { (window as unknown as { __pushBrowser: unknown }).__pushBrowser = cb; return () => undefined; },
      browserGo: (addr: string) => { (window as unknown as { __went: string[] }).__went = [...((window as unknown as { __went?: string[] }).__went ?? []), addr]; return Promise.resolve(/^(localhost|\d)/u.test(addr)); },
      browserDo: (a: string) => { (window as unknown as { __did: string[] }).__did = [...((window as unknown as { __did?: string[] }).__did ?? []), a]; return Promise.resolve(); },
      browserNewTab: noop, browserSwitch: noop, browserClose: noop,
      describeChange: () => Promise.resolve([]),
      listFolder: (p: string) => Promise.resolve({ path: p, entries: a.tree[p] ?? [], truncated: false }),
      readFile: (p: string) => Promise.resolve({ kind: "text", path: p, text: a.cart, lines: a.cart.split("\n").length - 1 }),
      changedFiles: () => Promise.resolve(["src/pages/Cart.tsx"]),
      reviewChanges: () => Promise.resolve([
        { path: "src/components/Banner.tsx", status: "added", added: 12, removed: 0, ignored: false },
        { path: "src/pages/Cart.tsx", status: "modified", added: 3, removed: 1, ignored: false },
        { path: "public/old-logo.svg", status: "deleted", added: 0, removed: 4, ignored: true },
      ]),
      reviewDiff: (p: string) => Promise.resolve(p.endsWith(".svg") ? { kind: "binary" } : { kind: "text", before: "const a = 1;\nconst b = 2;\n", after: "const a = 1;\nconst b = 3;\nconst c = 4;\n" }),
      setFileIgnored: (p: string, on: boolean) => { const w = window as unknown as { __ign?: [string, boolean][] }; w.__ign = [...(w.__ign ?? []), [p, on]]; return Promise.resolve(on ? [p] : []); },
      ignoredFiles: () => Promise.resolve(["public/old-logo.svg"]),
      syncWithFigma: (m: string) => { const w = window as unknown as { __sync?: string[] }; w.__sync = [...(w.__sync ?? []), m]; return Promise.resolve(); },
      localChangeCount: () => Promise.resolve(2),
      mergeDiff: (p: string) => Promise.resolve(p.endsWith(".svg") ? { kind: "binary" } : { kind: "text", before: "const a = 1;\nconst b = 'figma';\n", after: "const a = 1;\nconst b = 'mine';\n" }),
      resolveMerge: (c: unknown) => { (window as unknown as { __resolved: unknown }).__resolved = c; return Promise.resolve(); },
      stopProcess: noop, restartProcess: noop,
      cleanup: (a: string) => { (window as unknown as { __cleanup: string[] }).__cleanup = [...((window as unknown as { __cleanup?: string[] }).__cleanup ?? []), a]; return Promise.resolve(); },
      newChat: noop, copyText: noop, openProject: noop, ask: noop, undo: noop, send: noop, cancel: noop, retry: noop, setAgent: noop,
      chooseWorkspace: noop, signOutFigma: noop, setUpdates: noop, switchProject: noop, removeProject: noop, reportIssue: noop, installUpdate: noop,
    };
  }, { s: state, tree: TREE, cart: CART, tab, upd: update });
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

  it("add-project sheet has an optional name field that stays compact", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open(READY, { width: 1180, height: 760 }, "light");
    await page.keyboard.press("Control+n");
    await page.waitForSelector("dialog.sheet[open]");
    const link = await rect(page, "dialog.sheet input");
    const name = await rect(page, "dialog.sheet .fm-namefield");
    expect(name && name.w).toBeGreaterThanOrEqual(240);
    expect(name && link && name.y).toBeGreaterThan((link as { y: number }).y);
    expect(await page.locator("dialog.sheet .fm-namefield").getAttribute("placeholder")).toBe("Name (from link)");
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  it("rename sheet: double-click opens it, Esc cancels, empty is not saved", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open(READY, { width: 1180, height: 760 }, "light");
    await page.locator(".prow").dblclick();
    await page.waitForSelector("dialog.sheet[open]");
    expect(await page.locator("dialog.sheet input").inputValue()).toBe("Checkout Flow");
    await page.locator("dialog.sheet input").fill("");
    expect(await page.getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.sheet[open]", { state: "detached" });
    await page.locator(".prow-wrap").click({ button: "right" });
    expect(await page.locator(".menu button").allInnerTexts()).toEqual(["Rename…", "Remove from list…"]);
    await page.context().close();
  });

  it("sidebar collapses with the toggle and Ctrl+B, widens the content and tells the preview", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const width of [1180, 640]) {
      const page = await open(READY, { width, height: 760 }, "light");
      const before = await rect(page, ".main");
      expect(await page.locator(".side").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Hide sidebar" }).click();
      await page.waitForFunction(() => document.querySelector(".main")!.getBoundingClientRect().x === 0);
      const after = await rect(page, ".main");
      expect(await page.locator(".side").isVisible()).toBe(false);
      expect(after && after.x).toBe(0);
      expect(after && before && after.w).toBeGreaterThan((before as { w: number }).w);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => window.localStorage.getItem("figmake.side.open"))).toBe("0");
      expect(await page.getByRole("button", { name: "Show sidebar" }).getAttribute("aria-expanded")).toBe("false");
      await page.keyboard.press("Control+b");
      await page.waitForFunction(() => document.querySelector(".main")!.getBoundingClientRect().x > 100);
      expect(await page.locator(".side").isVisible()).toBe(true);
      await page.reload();
      await page.waitForSelector(".app");
      expect(await page.locator(".side").isVisible()).toBe(true);
      await page.context().close();
    }
  });

  it("the preview rect follows the sidebar collapsing", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open(READY, { width: 1180, height: 760 }, "light");
    await page.evaluate(() => {
      const w = window as unknown as { figmake: { previewRect: (r: unknown) => void }; __rects: ({ x: number; width: number } | null)[] };
      w.__rects = [];
      w.figmake.previewRect = (r) => w.__rects.push(r as { x: number; width: number } | null);
    });
    await page.keyboard.press("Control+b");
    await page.waitForFunction(() => (window as unknown as { __rects: unknown[] }).__rects.length > 0);
    const rects = await page.evaluate(() => (window as unknown as { __rects: ({ x: number; width: number } | null)[] }).__rects);
    const last = rects.at(-1);
    expect(last && last.x).toBeLessThan(10);
    expect(last && last.width).toBeGreaterThan(700);
    await page.context().close();
  });

  const SHOT_DIR = process.env["FIGMAKE_SHOTS"];
  const shot = async (page: Page, name: string): Promise<void> => {
    if (!SHOT_DIR) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.waitForTimeout(500); // let the sheet finish sliding in
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
  };

  for (const scheme of ["light", "dark"] as const) {
    it(`first run: Claude or ChatGPT comes first, over the start screen (${scheme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await open({ ...START, phase: "needs-ai-choice" }, { width: 1180, height: 760 }, scheme);
      await page.waitForSelector("dialog.sheet[open]");
      expect(await page.locator("dialog.sheet h2").innerText()).toBe("Connect your AI helper");
      expect(await page.locator("dialog.sheet button.choice").allInnerTexts()).toEqual([expect.stringContaining("Claude"), expect.stringContaining("ChatGPT")]);
      expect(await page.locator(".welcome").isVisible()).toBe(true);
      expect(await page.locator(".prep").isVisible()).toBe(false);
      expect(await page.locator("footer.status").innerText()).toContain("Pick your AI helper");
      const sheet = await rect(page, "dialog.sheet");
      expect(sheet && sheet.w).toBeLessThanOrEqual(520);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await shot(page, `start-choice-${scheme}`);
      await page.context().close();
    });

    it(`first run: setting the AI up shows a calm wait, not the project steps (${scheme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await open({ ...START, phase: "preparing", agent: "codex" }, { width: 1180, height: 760 }, scheme);
      await page.waitForSelector("dialog.sheet[open]");
      expect(await page.locator("dialog.sheet h2").innerText()).toBe("Getting ChatGPT ready");
      expect(await page.locator(".prep").isVisible()).toBe(false);
      await page.context().close();
    });

    it(`settings: AI helper status and the Updates row (${scheme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await open(READY, { width: 1180, height: 760 }, scheme);
      await page.keyboard.press("Control+,");
      await page.waitForSelector("dialog.sheet[open]");
      const ai = page.locator("dialog.sheet .row", { hasText: "AI helper" });
      expect(await ai.innerText()).toMatch(/Claude · Connected[\s\S]*Switch to ChatGPT/u);
      const row = page.locator("dialog.sheet .row.upd");
      expect(await row.innerText()).toMatch(/Updates[\s\S]*Version v0\.1\.18[\s\S]*Check for updates/u);
      await shot(page, `settings-${scheme}`);
      const clean = page.locator("dialog.sheet .setrows.clean");
      expect(await clean.innerText()).toMatch(/Preview not showing\?[\s\S]*Start this project over[\s\S]*Reset the app/u);
      expect(await page.locator("dialog.sheet .bd").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await clean.getByRole("button", { name: "Reset…" }).click();
      await page.waitForSelector("dialog.sheet h2:has-text('Reset the app?')");
      expect(await page.locator("dialog.sheet .hd p").innerText()).toBe("Signs you out, forgets your projects and chats, and moves the project folders to the Trash.");
      await shot(page, `reset-confirm-${scheme}`);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.keyboard.press("Control+,");
      await page.waitForSelector("dialog.sheet .setrows.clean");
      await page.locator("dialog.sheet .setrows.clean").getByRole("button", { name: "Start over…" }).click();
      expect(await page.locator("dialog.sheet .hd p").innerText()).toBe("This replaces your local copy with the latest from Figma. Your current files are backed up first.");
      await page.getByRole("button", { name: "Start over", exact: true }).click();
      expect(await page.evaluate(() => (window as unknown as { __cleanup: string[] }).__cleanup)).toEqual(["start-over"]);
      await page.keyboard.press("Control+,");
      await row.getByRole("button", { name: "Check for updates" }).click();
      await page.waitForFunction(() => document.querySelector("dialog.sheet .row.upd")?.textContent?.includes("You're up to date (v0.1.18)"));
      expect(await page.evaluate(() => (window as unknown as { __checks: number }).__checks)).toBe(1);
      const sheet = await rect(page, "dialog.sheet");
      expect(sheet && sheet.w).toBeLessThanOrEqual(520);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.context().close();
    });
  }

  it("settings: Clean up buttons wait while busy and without a project", async (ctx) => {
    if (!browser) return ctx.skip();
    const cases: [object, boolean, boolean][] = [
      [{ ...READY, phase: "working" }, false, false],
      [{ ...START, phase: "start" }, false, true],
      [READY, true, true],
    ];
    for (const [st, project, reset] of cases) {
      const page = await open(st as typeof READY, { width: 900, height: 560 }, "light");
      await page.keyboard.press("Control+,");
      await page.waitForSelector("dialog.sheet .setrows.clean");
      const clean = page.locator("dialog.sheet .setrows.clean");
      expect(await clean.getByRole("button", { name: "Fix the preview" }).isEnabled()).toBe(project);
      expect(await clean.getByRole("button", { name: "Start over…" }).isEnabled()).toBe(project);
      expect(await clean.getByRole("button", { name: "Reset…" }).isEnabled()).toBe(reset);
      const box = await rect(page, "dialog.sheet");
      expect(box && box.y + box.h).toBeLessThanOrEqual(560);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.context().close();
    }
  }, 30_000);

  it("settings: an AI that was never connected says so and offers Connect", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open({ ...READY, agentConnected: false }, { width: 1180, height: 760 }, "light");
    await page.keyboard.press("Control+,");
    await page.waitForSelector("dialog.sheet[open]");
    const ai = page.locator("dialog.sheet .row", { hasText: "AI helper" });
    expect(await ai.innerText()).toMatch(/Claude · Not connected[\s\S]*Connect[\s\S]*Switch to ChatGPT/u);
    await page.context().close();
  });

  it("settings: Updates row wording for each state", async (ctx) => {
    if (!browser) return ctx.skip();
    const cases: [object, RegExp, string | null][] = [
      [{ ...UPDATE_IDLE, phase: "checking" }, /Checking…/u, null],
      [{ ...UPDATE_IDLE, phase: "downloading", version: "0.1.19" }, /Downloading update…/u, null],
      [{ ...UPDATE_IDLE, phase: "ready", version: "0.1.19" }, /A new version is ready/u, "Restart to update"],
      [{ ...UPDATE_IDLE, error: "Couldn't check. Try again." }, /Couldn't check\. Try again\./u, "Check for updates"],
      [{ ...UPDATE_IDLE, upToDate: true }, /You're up to date \(v0\.1\.18\)/u, "Check for updates"],
      [{ ...UPDATE_IDLE, supported: false }, /aren't available in this version/u, null],
    ];
    for (const [update, text, button] of cases) {
      const page = await open(READY, { width: 900, height: 640 }, "light", "chat", update);
      await page.keyboard.press("Control+,");
      await page.waitForSelector("dialog.sheet[open]");
      const row = page.locator("dialog.sheet .row.upd");
      expect(await row.innerText()).toMatch(text);
      if (button) expect(await row.getByRole("button", { name: button }).count()).toBe(1);
      else {
        const check = row.getByRole("button", { name: "Check for updates" });
        if ((await check.count()) > 0) expect(await check.isEnabled()).toBe(false);
      }
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.context().close();
    }
    const off = await open({ ...READY, updatesEnabled: false }, { width: 900, height: 640 }, "light");
    await off.keyboard.press("Control+,");
    await off.waitForSelector("dialog.sheet[open]");
    expect(await off.locator("dialog.sheet .row.upd").innerText()).toMatch(/Automatic updates are off/u);
    expect(await off.locator("dialog.sheet .row.upd").getByRole("button", { name: "Check for updates" }).isEnabled()).toBe(true);
    await off.context().close();
  }, 30_000);

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
    // Sidebar project row stays a single slim line: its status dot sits inside the row, not in a box beside it.
    const prow = await rect(wide, ".prow");
    const pdot = await rect(wide, ".prow .dot, .prow .spin");
    expect(prow && prow.h).toBeLessThanOrEqual(32);
    expect(prow && pdot && pdot.x + pdot.w).toBeLessThanOrEqual((prow as { x: number; w: number }).x + (prow as { w: number }).w);
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
        expect(tabs).toEqual(["Chat", "Files", "Output"]);
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
        await page.waitForSelector(".fview .mv-host .monaco-editor", { timeout: 15_000 });
        expect(await page.locator(".fview .mv-host .monaco-editor .line-numbers").first().innerText()).toBe("1");
        expect(await page.locator(".fview textarea:not([readonly]), .fview [contenteditable=true]").count()).toBe(0);
        expect(await page.locator(".fview .ro").innerText()).toBe("Read-only");
        const rail = await rect(page, ".rail");
        const code = await rect(page, ".fview .mv-host");
        expect(code && rail && code.x + code.w).toBeLessThanOrEqual((rail as { x: number; w: number }).x + (rail as { w: number }).w + 1);
        expect(code && code.h).toBeGreaterThan(60);

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

  for (const scheme of ["light", "dark"] as const) {
    it(`preview browser bar: tabs, address and controls fit, loading and failure states (${scheme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await open(READY, { width: 900, height: 640 }, scheme);
      const tab = (id: number, over: object = {}) => ({ id, title: "", url: "http://localhost:5173/", loading: false, canGoBack: false, canGoForward: false, failed: false, ...over });
      await page.evaluate((st) => (window as unknown as { __pushBrowser: (s: object) => void }).__pushBrowser(st), { tabs: [tab(1, { title: "Checkout Flow", canGoBack: true }), tab(2, { url: "http://localhost:3000/a/very/long/path", loading: true })], activeId: 2 });
      await page.waitForSelector(".pv-tab");
      expect(await page.locator(".pv-tab").count()).toBe(2);
      expect(await page.locator(".pv-tab .pv-close").count()).toBe(1);
      expect(await page.locator(".pv-address").inputValue()).toBe("http://localhost:3000/a/very/long/path");
      expect(await page.locator(".pv-btn[aria-label='Stop']").count()).toBe(1);
      expect(await page.locator(".pv-progress.on").count()).toBe(1);
      const bar = await rect(page, ".pv-bar");
      const field = await rect(page, ".pv-field");
      const slot = await rect(page, ".slot");
      expect(bar && field && field.w).toBeGreaterThan(200);
      expect(bar && slot && slot.y).toBeGreaterThanOrEqual((bar as { y: number; h: number }).y + (bar as { h: number }).h);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);

      await page.locator(".pv-address").fill("example.com");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".pv-note:not([hidden])");
      expect(await page.locator(".pv-note").innerText()).toMatch(/this computer/u);
      await page.locator(".pv-address").fill("localhost:4000");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as { __went: string[] }).__went)).toEqual(["example.com", "localhost:4000"]);
      await page.locator(".pv-btn[aria-label='Stop']").click();
      expect(await page.evaluate(() => (window as unknown as { __did: string[] }).__did)).toEqual(["stop"]);

      await page.evaluate((st) => (window as unknown as { __pushBrowser: (s: object) => void }).__pushBrowser(st), { tabs: [tab(1, { failed: true })], activeId: 1 });
      await page.waitForSelector(".pv-fail:not([hidden])");
      const fail = await rect(page, ".pv-fail");
      expect(fail && slot && Math.abs(fail.h - (slot as { h: number }).h)).toBeLessThan(2);
      expect(await page.locator(".pv-fail").innerText()).toMatch(/can't be reached[\s\S]*localhost:5173[\s\S]*Retry/u);
      await page.getByRole("button", { name: "Retry" }).click();
      expect(await page.evaluate(() => (window as unknown as { __did: string[] }).__did)).toEqual(["stop", "retry"]);
      await page.context().close();
    });
  }

  it("failed and stopped previews offer Restart or Start, and the buttons call the right process", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open({ ...READY, processes: [{ id: "preview", name: "Preview", state: "failed", note: "The preview stopped unexpectedly.", canStop: false, canRestart: true }] }, { width: 1180, height: 760 }, "dark", "files");
    await page.waitForSelector(".running .rrow");
    expect(await page.locator(".running .rrow").innerText()).toMatch(/Failed[\s\S]*stopped unexpectedly[\s\S]*Restart/u);
    expect(await page.locator(".running .rrow button").allInnerTexts()).toEqual(["Restart", "Output"]);
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  describe("progress card: live output", () => {
    const LOG = [
      "Getting your project from Figma",
      "downloading latest code",
      "applying downloaded snapshot",
      "Installing project files",
      "npm warn deprecated inflight@1.0.6: This module is not supported",
      `npm http fetch GET 200 https://registry.npmjs.org/${"a-very-long-package-name-".repeat(8)} 412ms`,
      "added 312 packages in 41s",
    ];
    const prepState = (over: { lines?: string[]; stepAgo?: number } = {}): object => ({
      ...START,
      phase: "preparing",
      projectName: "Checkout Flow",
      agent: "claude",
      agentConnected: true,
      activeKey: "a",
      activity: { lines: over.lines ?? LOG, stepStartedAt: Date.now() - (over.stepAgo ?? 42_000), startedAt: Date.now() - 60_000 },
    });
    const SIZE = { width: 1180, height: 760 };

    for (const scheme of ["light", "dark"] as const) {
      it(`collapsed: clock, three-line tail, no hints, nothing overflows (${scheme})`, async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await open(prepState({ stepAgo: 12_000 }), SIZE, scheme);
        await page.waitForSelector(".prep .tail .tl");
        expect(await page.locator(".prep .elapsed").innerText()).toBe("On this step for 0:12");
        expect(await page.locator(".prep .tail .tl").allInnerTexts()).toEqual(LOG.slice(-3));
        expect(await page.locator(".prep .slowhint p").count()).toBe(0);
        expect(await page.locator(".prep .fulllog").isVisible()).toBe(false);
        const card = await rect(page, ".prep");
        const tail = await rect(page, ".prep .tail");
        expect(tail && card && tail.x + tail.w).toBeLessThanOrEqual((card as { x: number; w: number }).x + (card as { w: number }).w);
        expect(await page.locator(".prep").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.locator(".prep .tail").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);
        await shot(page, `card-collapsed-${scheme}`);
        await page.context().close();
      });

      it(`expanded: all output in a scrollable log that follows the newest line, with Copy (${scheme})`, async (ctx) => {
        if (!browser) return ctx.skip();
        const many = Array.from({ length: 60 }, (_, i) => `step output line ${i + 1}`);
        const page = await open(prepState({ lines: many }), SIZE, scheme);
        await page.click("text=Show all output");
        expect(await page.locator(".prep .fulllog").isVisible()).toBe(true);
        expect(await page.locator(".prep .showall").innerText()).toBe("Hide output");
        const log = page.locator(".prep .logfull");
        expect((await log.innerText()).split("\n")).toHaveLength(60);
        const info = (): Promise<{ top: number; max: number }> => log.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
        const start = await info();
        expect(start.max).toBeGreaterThan(0);
        expect(Math.abs(start.top - start.max)).toBeLessThanOrEqual(2);
        const box = await rect(page, ".prep .logfull");
        const card = await rect(page, ".prep");
        expect(box && card && box.x + box.w).toBeLessThanOrEqual((card as { x: number; w: number }).x + (card as { w: number }).w);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);

        // New lines keep it pinned to the bottom...
        const push = (lines: string[]): Promise<void> => page.evaluate((a) => { (window as unknown as { __push: (s: object) => void }).__push(a); }, { ...(prepState({ lines })) });
        await push([...many, "later line 1", "later line 2"]);
        await page.waitForFunction(() => document.querySelector(".prep .logfull")?.textContent?.includes("later line 2"));
        let now = await info();
        expect(Math.abs(now.top - now.max)).toBeLessThanOrEqual(2);
        // ...until the person scrolls up: then it stays where they are.
        await log.evaluate((el) => { el.scrollTop = 40; el.dispatchEvent(new Event("scroll")); });
        await push([...many, "later line 1", "later line 2", "later line 3"]);
        await page.waitForFunction(() => document.querySelector(".prep .logfull")?.textContent?.includes("later line 3"));
        now = await info();
        expect(Math.abs(now.top - 40)).toBeLessThanOrEqual(2);

        await page.evaluate(() => { (window as unknown as { __copied: string[] }).__copied = []; (window.figmake as unknown as { copyText: (t: string) => Promise<void> }).copyText = (t: string) => { (window as unknown as { __copied: string[] }).__copied.push(t); return Promise.resolve(); }; });
        await page.click(".prep .fulllog button:has-text('Copy')");
        const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
        expect(copied).toHaveLength(1);
        expect(copied[0]?.split("\n")).toHaveLength(63);
        await shot(page, `card-expanded-${scheme}`);
        await page.click("text=Hide output");
        expect(await page.locator(".prep .tail").isVisible()).toBe(true);
        await page.context().close();
      });
    }

    for (const scheme of ["light", "dark"] as const) {
      it(`Output tab: status header, live log that follows, Copy and Clear (${scheme})`, async (ctx) => {
        if (!browser) return ctx.skip();
        const many = Array.from({ length: 80 }, (_, i) => `build output line ${i + 1}`);
        const st = { ...READY, processes: [{ id: "preview", name: "Preview", state: "running", canStop: true, canRestart: true, output: [] }], activity: { lines: many, stepStartedAt: null, startedAt: null } };
        const page = await open(st, SIZE, scheme);
        await page.click("#tab-output");
        expect(await page.locator("#tab-output").getAttribute("aria-selected")).toBe("true");
        expect(await page.locator(".chat").isVisible()).toBe(false);
        expect(await page.locator(".outpanel .ostatus").innerText()).toMatch(/Preview:\s*Running[\s\S]*Stop[\s\S]*Restart/u);
        const log = page.locator(".outpanel .logfull");
        expect((await log.innerText()).split("\n")).toHaveLength(80);
        const info = (): Promise<{ top: number; max: number }> => log.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
        const a = await info();
        expect(a.max).toBeGreaterThan(0);
        expect(Math.abs(a.top - a.max)).toBeLessThanOrEqual(2);
        const push = (lines: string[]): Promise<void> => page.evaluate((x) => { (window as unknown as { __push: (v: object) => void }).__push(x); }, { ...st, activity: { lines, stepStartedAt: null, startedAt: null } });
        await push([...many, "new line A"]);
        await page.waitForFunction(() => document.querySelector(".outpanel .logfull")?.textContent?.includes("new line A"));
        const b = await info();
        expect(Math.abs(b.top - b.max)).toBeLessThanOrEqual(2);
        await log.evaluate((el) => { el.scrollTop = 30; el.dispatchEvent(new Event("scroll")); });
        await push([...many, "new line A", "new line B"]);
        await page.waitForFunction(() => document.querySelector(".outpanel .logfull")?.textContent?.includes("new line B"));
        expect(Math.abs((await info()).top - 30)).toBeLessThanOrEqual(2);
        const box = await rect(page, ".outpanel .logfull");
        const railBox = await rect(page, ".rail");
        expect(box && railBox && box.x + box.w).toBeLessThanOrEqual((railBox as { x: number; w: number }).x + (railBox as { w: number }).w);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);
        await shot(page, `output-tab-${scheme}`);
        await page.evaluate(() => { (window as unknown as { __copied: string[] }).__copied = []; (window.figmake as unknown as { copyText: (t: string) => Promise<void> }).copyText = (t: string) => { (window as unknown as { __copied: string[] }).__copied.push(t); return Promise.resolve(); }; });
        await page.click(".outpanel button:has-text('Copy')");
        expect((await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))[0]?.split("\n")).toHaveLength(82);
        await page.click(".outpanel button:has-text('Clear')");
        expect(await log.innerText()).toMatch(/Nothing has run yet/u);
        await push([...many, "new line A", "new line B", "after clear"]);
        await page.waitForFunction(() => document.querySelector(".outpanel .logfull")?.textContent === "after clear");
        await page.context().close();
      });
    }

    it("slow steps get a gentle note at 30 s and a disk hint at 120 s", async (ctx) => {
      if (!browser) return ctx.skip();
      const NOTE = "This is taking longer than usual on this computer. It's still working. You can keep this window open.";
      const quick = await open(prepState({ stepAgo: 29_000 }), SIZE, "light");
      await quick.waitForSelector(".prep .tail");
      expect(await quick.locator(".prep .slowhint p").count()).toBe(0);
      await quick.context().close();

      const slow = await open(prepState({ stepAgo: 31_000 }), SIZE, "light");
      await slow.waitForSelector(".prep .slowhint p");
      expect(await slow.locator(".prep .slowhint p").allInnerTexts()).toEqual([NOTE]);
      await slow.context().close();

      for (const scheme of ["light", "dark"] as const) {
        const very = await open(prepState({ stepAgo: 125_000 }), SIZE, scheme);
        await very.waitForSelector(".prep .slowhint p");
        expect(await very.locator(".prep .slowhint p").allInnerTexts()).toEqual([NOTE, "Slow disk? Freeing space can help."]);
        expect(await very.locator(".prep .elapsed").innerText()).toBe("On this step for 2:05");
        expect(await overflowX(very)).toBeLessThanOrEqual(0);
        const card = await rect(very, ".prep");
        expect(card && card.y + card.h).toBeLessThanOrEqual(SIZE.height);
        await shot(very, `card-slow-hint-${scheme}`);
        await very.context().close();
      }
    });

    it("error banner keeps Try again and Report, and Show details reveals the last 20 lines", async (ctx) => {
      if (!browser) return ctx.skip();
      const lines = Array.from({ length: 30 }, (_, i) => `output ${i + 1}`);
      const failed = { ...START, phase: "error", message: "Couldn't start the project. Try again.", code: "preview_failed", failedIn: "preparing", projectName: "Checkout Flow", activity: { lines, stepStartedAt: null, startedAt: null } };
      for (const scheme of ["light", "dark"] as const) {
        const page = await open(failed, SIZE, scheme);
        const names = await page.locator(".errbanner button").allInnerTexts();
        expect(names).toEqual(["Try again", "Show details", "Report"]);
        expect(await page.locator(".errbanner .errlog").count()).toBe(0);
        await page.click(".errbanner >> text=Show details");
        const shown = (await page.locator(".errbanner .errlog").innerText()).split("\n");
        expect(shown).toHaveLength(20);
        expect(shown[0]).toBe("output 11");
        expect(shown.at(-1)).toBe("output 30");
        expect(await overflowX(page)).toBeLessThanOrEqual(0);
        await shot(page, `error-details-${scheme}`);
        await page.context().close();
      }
      const bare = await open({ ...failed, activity: { lines: [], stepStartedAt: null, startedAt: null } }, SIZE, "light");
      expect(await bare.locator(".errbanner button").allInnerTexts()).toEqual(["Try again", "Report"]);
      await bare.context().close();
    });

    it("Files tab: each running row has an Output disclosure with its recent lines", async (ctx) => {
      if (!browser) return ctx.skip();
      const procs = [
        { id: "preview", name: "Preview", state: "running", canStop: true, canRestart: true, output: ["VITE v5 ready in 900 ms", "Local: http://localhost:5173/"] },
        { id: "install", name: "Setting up project files", state: "running", canStop: true, canRestart: false, output: ["added 312 packages in 41s"] },
        { id: "agent", name: "Claude (AI helper)", state: "running", canStop: true, canRestart: false, output: [] },
      ];
      for (const scheme of ["light", "dark"] as const) {
        const page = await open({ ...READY, processes: procs }, SIZE, scheme, "files");
        await page.waitForSelector(".running .rrow");
        expect(await page.locator(".running .outtoggle").count()).toBe(3);
        await page.click('.rrow[data-process="preview"] .outtoggle');
        expect(await page.locator('.rrow[data-process="preview"] .logfull').innerText()).toBe("VITE v5 ready in 900 ms\nLocal: http://localhost:5173/");
        await page.click('.rrow[data-process="install"] .outtoggle');
        await page.click('.rrow[data-process="agent"] .outtoggle');
        expect(await page.locator('.rrow[data-process="agent"] .logfull').innerText()).toBe("Nothing to show yet.");
        expect(await page.locator(".files").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);
        await shot(page, `files-output-${scheme}`);
        await page.click('.rrow[data-process="preview"] .outtoggle');
        expect(await page.locator('.rrow[data-process="preview"] .logfull').count()).toBe(0);
        await page.context().close();
      }
    });
  });
  describe("live progress while the AI works", () => {
    for (const size of [{ width: 1180, height: 760 }, { width: 900, height: 640 }]) {
      for (const scheme of ["light", "dark"] as const) {
        it(`working row shows the live line, clock and plan inside the panel (no second Stop) (${size.width}px, ${scheme})`, async (ctx) => {
          if (!browser) return ctx.skip();
          const page = await open(READY, size, scheme);
          const long = "Editing a-really-long-component-file-name-that-keeps-going-and-going-and-going-Header.tsx";
          const chatState = {
            projectKey: "a", active: true, fresh: false,
            messages: [
              { id: "u1", role: "user", at: "2026-01-01T00:00:00Z", text: "Make the header sticky", parts: [], status: "done" },
              { id: "a1", role: "assistant", at: "2026-01-01T00:00:01Z", text: "", status: "streaming", now: long, startedAt: Date.now() - 75_000,
                parts: [{ type: "activity", items: [{ kind: "look", label: "Looked at Button.tsx", file: "Button.tsx" }, { kind: "helper", label: "Helper: check the cart page" }, { kind: "edit", label: "Edited Header.tsx", file: "Header.tsx" }] }],
                plan: [{ text: "Read the header", state: "done" }, { text: "Make it stick to the top of the page", state: "active" }, { text: "Check the app builds", state: "pending" }] },
            ],
          };
          await page.evaluate((c) => (window as unknown as { __pushChat: (v: object) => void }).__pushChat(c), chatState);
          await page.waitForSelector(".lv-now");
          const panel = await rect(page, ".chat");
          const now = await rect(page, ".lv-now");
          const time = await rect(page, ".lv-time");
          const plan = await rect(page, ".lv-plan");
          expect(await page.locator(".lv-time").innerText()).toMatch(/^1m \d\ds$/u);
          expect(await page.locator(".lv-step").count()).toBe(3);
          expect(await page.locator(".lv-acts-list li").count()).toBe(3);
          for (const r of [now, time, plan]) {
            expect(r).not.toBeNull();
            expect((r?.x ?? 0) + (r?.w ?? 0)).toBeLessThanOrEqual((panel?.x ?? 0) + (panel?.w ?? 0) + 0.5);
          }
          // The composer's stop button is the only Stop while working: the status row has none.
          expect(await page.locator(".lv-main button").count()).toBe(0);
          expect(await overflowX(page)).toBeLessThanOrEqual(0);
          // Generic names are not used, and reduced motion stops the shimmer.
          expect(await page.locator(".lv-now").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
          // Done: collapses to the one-line summary with no live pieces.
          await page.evaluate((c) => (window as unknown as { __pushChat: (v: object) => void }).__pushChat(c), { ...chatState, active: false, messages: chatState.messages.map((m) => (m.id === "a1" ? { ...m, status: "done", now: undefined, startedAt: undefined, plan: undefined } : m)) });
          await page.waitForSelector(".acts-t");
          expect(await page.locator(".lv-now, .lv-plan, .lv-time, .lv-acts").count()).toBe(0);
          await page.context().close();
        });
      }
    }
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`review sheet: files, checkboxes, Monaco diff (${scheme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await open({ ...READY, canSend: true, changes: ["x"], changeFiles: [1], changeIds: ["1"] }, { width: 1180, height: 760 }, scheme);
      const violations: string[] = [];
      page.on("console", (m) => { if (/Content Security Policy|Refused to/u.test(m.text())) violations.push(m.text()); });
      page.on("pageerror", (e) => violations.push(String(e)));
      await page.click("button.send");
      await page.waitForSelector("dialog.rv-sheet[open] .rv-row");
      expect(await page.locator(".rv-row").count()).toBe(3);
      expect(await page.locator(".rv-row .rv-badge").allInnerTexts()).toEqual(["Added", "Changed", "Removed"]);
      expect(await page.locator(".rv-check:checked").count()).toBe(2);
      expect(await page.locator("dialog.rv-sheet .acts .btn.primary").innerText()).toBe("Send 2 files");
      const sheet = await rect(page, "dialog.rv-sheet");
      expect(sheet && sheet.w).toBeGreaterThan(520);
      expect(sheet && sheet.x + sheet.w).toBeLessThanOrEqual(1180);

      await page.locator(".rv-check").nth(0).uncheck();
      expect(await page.locator("dialog.rv-sheet .acts .btn.primary").innerText()).toBe("Send 1 file");
      expect(await page.evaluate(() => (window as unknown as { __ign: unknown }).__ign)).toEqual([["src/components/Banner.tsx", true]]);

      // Expanding a file draws a real Monaco diff editor, and the theme follows the system.
      await page.locator(".rv-more").nth(1).click();
      await page.waitForSelector(".rv-diff .monaco-diff-editor", { timeout: 15_000 });
      expect(await page.locator(".rv-diff .monaco-editor").count()).toBeGreaterThan(0);
      expect(await page.locator(".rv-diff .vs-dark").count() > 0).toBe(scheme === "dark");
      const ed = await rect(page, ".rv-diff:not([hidden]) .rv-editor");
      expect(ed && ed.h).toBeGreaterThan(200);
      expect(ed && sheet && ed.x + ed.w <= sheet.x + sheet.w + 1).toBe(true);
      await page.locator(".rv-mode").nth(1).click();
      await page.waitForSelector(".rv-diff .monaco-diff-editor.side-by-side");

      // A file that isn't text says so instead of showing an editor.
      await page.locator(".rv-more").nth(2).click();
      await page.waitForSelector('.rv-note:has-text("isn\'t text")');
      expect(violations).toEqual([]);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.context().close();
    });
  }

  it("settings: Files not sent opens a list with Send again", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await open(READY, { width: 1180, height: 760 }, "light");
    await page.click("button.gear");
    await page.waitForSelector('dialog.sheet[open] .row:has-text("Files not sent")');
    await page.waitForSelector('.row:has-text("Files not sent") span:has-text("1 file")');
    await page.click('.row:has-text("Files not sent") button');
    await page.waitForSelector('dialog.rv-sheet[open] .rv-row:has-text("old-logo.svg")');
    await page.click('button[aria-label="Send public/old-logo.svg again"]');
    expect(await page.evaluate(() => (window as unknown as { __ign: unknown }).__ign)).toEqual([["public/old-logo.svg", false]]);
    await page.context().close();
  });
});

describe("sync with Figma", () => {
  for (const size of [{ width: 1180, height: 760 }, { width: 900, height: 640 }]) {
    for (const scheme of ["light", "dark"] as const) {
      it(`toolbar menu and discard confirm (${size.width}px, ${scheme})`, async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await open(READY, size, scheme);
        const sync = await rect(page, ".sy-btn");
        const send = await rect(page, "button.send");
        expect(sync && send && sync.x + sync.w <= send.x).toBe(true);
        expect(await overflowX(page)).toBeLessThanOrEqual(0);
        await page.click(".sy-btn");
        await page.waitForSelector(".sy-menu button");
        expect(await page.locator(".sy-menu button").allInnerTexts()).toEqual(["Merge Figma's changes into mine", "Discard my changes and use Figma's"]);
        const menu = await rect(page, ".sy-menu");
        expect(menu && menu.x >= 0 && menu.x + menu.w <= size.width).toBe(true);
        await page.click('.sy-menu button:has-text("Discard")');
        await page.waitForSelector("dialog.sheet[open]");
        expect(await page.locator("dialog.sheet[open]").innerText()).toContain("2 files you changed will go back to Figma's version");
        expect(await page.locator("dialog.sheet[open]").innerText()).toContain("backup");
        await page.click('dialog.sheet[open] button:has-text("Cancel")');
        expect(await page.evaluate(() => (window as unknown as { __sync?: string[] }).__sync)).toBeUndefined();
        await page.click(".sy-btn");
        await page.click('.sy-menu button:has-text("Discard")');
        await page.click('dialog.sheet[open] button:has-text("Discard my changes")');
        expect(await page.evaluate(() => (window as unknown as { __sync?: string[] }).__sync)).toEqual(["replace"]);
        await page.click(".sy-btn");
        await page.click('.sy-menu button:has-text("Merge")');
        expect(await page.evaluate(() => (window as unknown as { __sync?: string[] }).__sync)).toEqual(["replace", "merge"]);
        await page.context().close();
      });
    }
  }

  it("is off while the project is busy and the conflict sheet offers Merge", async (ctx) => {
    if (!browser) return ctx.skip();
    const busy = await open({ ...READY, phase: "syncing" }, { width: 1180, height: 760 }, "light");
    expect(await busy.locator(".sy-btn").isDisabled()).toBe(true);
    await busy.context().close();
    const page = await open({ ...READY, phase: "conflict", conflictFiles: ["src/app.ts"] }, { width: 1180, height: 760 }, "light");
    await page.waitForSelector('dialog.sheet[open] button:has-text("Merge")');
    expect(await page.locator("dialog.sheet[open] .acts .btn").allInnerTexts()).toEqual(["Use Figma's", "Merge", "Keep mine"]);
    await page.click('dialog.sheet[open] button:has-text("Merge")');
    expect(await page.evaluate(() => (window as unknown as { __sync?: string[] }).__sync)).toEqual(["merge"]);
    await page.context().close();
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`merge choices: per-file pick, Monaco diff, Done (${scheme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await open({ ...READY, phase: "resolving", mergeConflicts: ["src/pages/Cart.tsx", "public/old-logo.svg"] }, { width: 1180, height: 760 }, scheme);
      const violations: string[] = [];
      page.on("console", (m) => { if (/Content Security Policy|Refused to/u.test(m.text())) violations.push(m.text()); });
      page.on("pageerror", (e) => violations.push(String(e)));
      await page.waitForSelector("dialog.sy-sheet[open] .sy-row");
      expect(await page.locator(".sy-row").count()).toBe(2);
      expect(await page.locator('.sy-opt[aria-pressed="true"]').allInnerTexts()).toEqual(["Keep mine", "Keep mine"]);
      const sheet = await rect(page, "dialog.sy-sheet");
      expect(sheet && sheet.x + sheet.w).toBeLessThanOrEqual(1180);
      await page.locator(".sy-row").nth(0).locator('.sy-opt:has-text("Use Figma")').click();
      await page.locator(".sy-more").nth(0).click();
      await page.waitForSelector(".sy-diff .monaco-diff-editor", { timeout: 15_000 });
      expect(await page.locator(".sy-diff .vs-dark").count() > 0).toBe(scheme === "dark");
      const ed = await rect(page, ".sy-diff:not([hidden]) .sy-editor");
      expect(ed && sheet && ed.x + ed.w <= sheet.x + sheet.w + 1).toBe(true);
      await page.locator(".sy-more").nth(1).click();
      await page.waitForSelector('.sy-note:has-text("isn\'t text")');
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.click('dialog.sy-sheet button:has-text("Done")');
      expect(await page.evaluate(() => (window as unknown as { __resolved: unknown }).__resolved)).toEqual([{ path: "src/pages/Cart.tsx", choice: "figma" }, { path: "public/old-logo.svg", choice: "mine" }]);
      expect(violations).toEqual([]);
      await page.context().close();
    });
  }
});
