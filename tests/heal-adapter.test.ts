/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FIGMA_MAKE_SELECTORS, PlaywrightFigmaMakeProjectSession, UiChangedError, type AdapterContext } from "../src/figma/adapter.js";
import { gateSelector } from "../src/heal/gate.js";
import { HealSession } from "../src/heal/heal.js";
import { SelectorOverrideStore } from "../src/heal/overrideStore.js";
import type { HealContext, Healer } from "../src/heal/types.js";

const RENAMED_PAGE = `
<div data-testid="header-nav-toolbar"><div data-testid="new-shell">
  <button data-testid="switcher-b" aria-label="Show code editor">Source</button>
  <button data-testid="switcher-a" aria-label="Show preview">Preview</button>
</div></div>
<div id="stage">preview area</div>
<script>
  document.querySelector('[data-testid="switcher-b"]').addEventListener('click', () => {
    document.getElementById('stage').innerHTML = '<div class="monaco-editor" style="width:100px;height:50px">editor</div>';
  });
</script>`;

// Same layout, but the "Show code editor" button does nothing (post-condition can never pass).
const DEAD_BUTTON_PAGE = RENAMED_PAGE.replace("addEventListener('click'", "addEventListener('nothing'");

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
  page = await browser.newPage();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "heal-adapter-"));
});
afterEach(async () => {
  await page.close();
  await fs.remove(dir);
});

function makeSession(heal: HealContext | undefined): PlaywrightFigmaMakeProjectSession {
  const context = {
    config: { adapter: { selectorOverrides: {} } },
    logger,
    paths: { artifactsDir: path.join(dir, "artifacts") },
    ...(heal ? { heal } : {}),
  } as unknown as AdapterContext;
  const handle = { page, context: {}, tracePath: "", runStep: (_n: string, f: () => Promise<unknown>) => f(), close: async () => undefined };
  const s = new PlaywrightFigmaMakeProjectSession(handle as never, context);
  (s as unknown as { codeModeWaitMs: number }).codeModeWaitMs = 600;
  return s;
}
const ensure = (s: PlaywrightFigmaMakeProjectSession): Promise<void> => (s as unknown as { ensureCodeSurfaceReady(): Promise<void> }).ensureCodeSurfaceReady();

function ctx(healer: Healer | undefined, over: Partial<HealContext> = {}): HealContext {
  return {
    store: new SelectorOverrideStore({ filePath: path.join(dir, "selector-overrides.json") }),
    healer,
    artifactsDir: path.join(dir, "artifacts"),
    ...over,
  };
}

describe("selector gate (live page)", () => {
  beforeEach(() => page.setContent(RENAMED_PAGE));

  it("accepts exactly one visible enabled element whose label contains the term", async () => {
    const r = await gateSelector(page, 'button[aria-label="Show code editor"]', "code");
    expect(r.ok).toBe(true);
  });
  it("rejects zero / many matches", async () => {
    expect(await gateSelector(page, 'button[aria-label="nope"]', "code")).toMatchObject({ ok: false });
    expect(await gateSelector(page, "button", "code")).toMatchObject({ ok: false, reason: expect.stringContaining("exactly 1") });
  });
  it("rejects an element without the expected term (wrong control)", async () => {
    expect(await gateSelector(page, 'button[aria-label="Show preview"]', "code")).toMatchObject({ ok: false, reason: expect.stringContaining("not labelled") });
  });
  it("rejects lookalike labels (Encode / Cyrillic)", async () => {
    await page.setContent('<button aria-label="Encode">e</button>');
    expect(await gateSelector(page, 'button[aria-label="Encode"]', "code")).toMatchObject({ ok: false });
    await page.setContent('<button aria-label="Cоde">e</button>');
    expect(await gateSelector(page, "button", "code")).toMatchObject({ ok: false });
  });
  it("rejects hidden and disabled elements and grammar violations", async () => {
    await page.setContent('<button aria-label="Code" style="display:none">h</button>');
    expect(await gateSelector(page, 'button[aria-label="Code"]', "code")).toMatchObject({ ok: false });
    await page.setContent('<button aria-label="Code" disabled>h</button>');
    expect(await gateSelector(page, 'button[aria-label="Code"]', "code")).toMatchObject({ ok: false, reason: expect.stringContaining("disabled") });
    expect(await gateSelector(page, "javascript:alert(1)", "code")).toMatchObject({ ok: false, reason: expect.stringContaining("grammar") });
    expect(await gateSelector(page, "button >> nth=0", "code")).toMatchObject({ ok: false });
  });
});

describe("non-AI built-in fallbacks", () => {
  it("find a renamed Code toggle without any healer", async () => {
    const variants = [
      '<button aria-label="Code view">x</button>',
      '<div role="tab" aria-label="Code">x</div>',
      '<div role="radio" tabindex="0">Code</div>',
      '<span data-tooltip="Code view"><i>x</i></span>',
      '<button title="Code">x</button>',
      '<button>Code</button>',
    ];
    for (const html of variants) {
      await page.setContent(html);
      const hit = await Promise.any(
        DEFAULT_FIGMA_MAKE_SELECTORS.codeModeButton.map(async (sel) => {
          await page.locator(sel).first().waitFor({ state: "visible", timeout: 800 });
          return sel;
        }),
      ).catch(() => null);
      expect(hit, html).not.toBeNull();
    }
  });
  it("do not match unrelated controls", async () => {
    await page.setContent('<button aria-label="Encode">Encode</button><button>Decode</button>');
    for (const sel of DEFAULT_FIGMA_MAKE_SELECTORS.codeModeButton) {
      expect(await page.locator(sel).count(), sel).toBe(0);
    }
  });
});

describe("heal pipeline", { timeout: 40_000 }, () => {
  it("happy path: broken UI -> fake AI -> gated -> action post-condition -> override persisted and reused", async () => {
    await page.setContent(RENAMED_PAGE);
    const healer = vi.fn<Healer>(async () => ({ selectors: ['button[aria-label="Show code editor"]'], reason: "renamed" }));
    const c = ctx(healer);
    const session = makeSession(c);
    await ensure(session);
    expect(healer).toHaveBeenCalledTimes(1);
    const req = healer.mock.calls[0]![0];
    expect(req.key).toBe("codeModeButton");
    expect(JSON.stringify(req.outline)).toContain("Show code editor");
    expect(c.store.get("codeModeButton")).toEqual(['button[aria-label="Show code editor"]']);
    expect(await page.locator(".monaco-editor").isVisible()).toBe(true);
    // persisted on disk
    const stored = (await fs.readJson(path.join(dir, "selector-overrides.json"))) as { overrides: Record<string, { selectors: string[] }> };
    expect(stored.overrides["codeModeButton"]?.selectors).toEqual(['button[aria-label="Show code editor"]']);

    // Next session: no healer needed, the override is tried first and counted as a hit.
    await page.setContent(RENAMED_PAGE);
    const c2 = ctx(undefined);
    await c2.store.load();
    const s2 = makeSession(c2);
    await ensure(s2);
    expect(await page.locator(".monaco-editor").isVisible()).toBe(true);
    expect(c2.store.entry("codeModeButton")?.hits).toBe(1);
  });

  it("without a healer the legacy UiChangedError is thrown", async () => {
    await page.setContent(RENAMED_PAGE);
    await expect(ensure(makeSession(ctx(undefined)))).rejects.toBeInstanceOf(UiChangedError);
  });

  it("malicious or wrong proposals are rejected, nothing is persisted, outline diagnostic is saved", async () => {
    await page.setContent(RENAMED_PAGE);
    const healer = vi.fn<Healer>(async () => ({
      selectors: ["javascript:alert(1)", "button >> nth=0", 'button[aria-label="Show preview"]', "button", "text=/^$/", 'div:has(script)'],
    }));
    const c = ctx(healer);
    await expect(ensure(makeSession(c))).rejects.toBeInstanceOf(UiChangedError);
    expect(c.store.get("codeModeButton")).toEqual([]);
    expect(await page.locator(".monaco-editor").count()).toBe(0);
    const files = await fs.readdir(path.join(dir, "artifacts"));
    const diag = files.find((f) => f.includes("heal-codeModeButton"));
    expect(diag).toBeDefined();
    const saved = (await fs.readJson(path.join(dir, "artifacts", diag!))) as { outline: unknown; notes: unknown[] };
    expect(saved.notes.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved.outline)).toContain("Show code editor");
  });

  it("post-condition failure discards the proposal (nothing persisted)", async () => {
    await page.setContent(DEAD_BUTTON_PAGE);
    const healer = vi.fn<Healer>(async () => ({ selectors: ['button[aria-label="Show code editor"]'] }));
    const c = ctx(healer);
    const s = makeSession(c);
    const act = vi.fn(async () => false);
    const r = await new HealSession(c).tryHeal({ page, key: "codeModeButton", failedSelectors: [], act });
    expect(r).toBeNull();
    expect(act).toHaveBeenCalledTimes(1);
    expect(c.store.get("codeModeButton")).toEqual([]);
    // and through the adapter's real action: clicking does nothing so the editor never appears
    (s as unknown as { findVisible: unknown }).findVisible = vi.fn(async () => {
      throw new Error("editor never appeared");
    });
    await expect(ensure(s)).rejects.toBeInstanceOf(UiChangedError);
    expect(c.store.get("codeModeButton")).toEqual([]);
  });

  it("rate limits: max 2 healer calls per key per session, and cooldown across sessions", async () => {
    await page.setContent(RENAMED_PAGE);
    const healer = vi.fn<Healer>(async () => ({ selectors: ["text=nothing"] }));
    const c = ctx(healer);
    const hs = new HealSession(c);
    const args = { page, key: "codeModeButton", failedSelectors: [], act: async () => true };
    for (let i = 0; i < 5; i += 1) expect(await hs.tryHeal(args)).toBeNull();
    expect(healer).toHaveBeenCalledTimes(2);
    expect(healer.mock.calls[1]![0].rejectedProposals).toContain("text=nothing");
    // new session, same store: failed heal cooldown applies
    expect(await new HealSession(c).tryHeal(args)).toBeNull();
    expect(healer).toHaveBeenCalledTimes(2);
  });

  it("non-healable keys never call the healer", async () => {
    await page.setContent(RENAMED_PAGE);
    const healer = vi.fn<Healer>(async () => ({ selectors: ["text=x"] }));
    expect(await new HealSession(ctx(healer)).tryHeal({ page, key: "deleteAction", failedSelectors: [], act: async () => true })).toBeNull();
    expect(healer).not.toHaveBeenCalled();
  });

  it("healer throwing is swallowed", async () => {
    await page.setContent(RENAMED_PAGE);
    const healer: Healer = async () => {
      throw new Error("boom");
    };
    expect(await new HealSession(ctx(healer)).tryHeal({ page, key: "codeModeButton", failedSelectors: [], act: async () => true })).toBeNull();
  });
});
