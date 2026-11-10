import { describe, expect, it } from "vitest";

import {
  classifyPageState,
  extractTreeRows,
  resolveTreeChain,
  type TreeQueryArgs,
  type TreeRow,
} from "../src/figma/adapter.js";

function row(
  label: string,
  kind: "file" | "folder",
  depth: number,
  expanded: boolean | null = null,
): TreeRow {
  return { label, kind, depth, expanded, active: false, activeSupported: false };
}

const args = (over: Partial<TreeQueryArgs>): TreeQueryArgs => ({
  segments: [],
  kind: "file",
  expandLast: false,
  list: false,
  assumeExpandedAt: [],
  ...over,
});

const rows: TreeRow[] = [
  row("components", "folder", 0, true),
  row("Button.tsx", "file", 1),
  row("src", "folder", 0, true),
  row("ui", "folder", 1, true),
  row("Button.tsx", "file", 2),
  row("index.ts", "file", 1),
  row("lib", "folder", 0, false),
  row("App.tsx", "file", 0),
];

describe("resolveTreeChain", () => {
  it("resolves nested path to the right same-named file", () => {
    const r = resolveTreeChain(rows, args({ segments: ["src", "ui", "Button.tsx"] }));
    expect(r).toMatchObject({ status: "found", index: 4, matchCount: 1 });
  });

  it("does not match a leaf in a different folder", () => {
    const r = resolveTreeChain(rows, args({ segments: ["src", "Button.tsx"] }));
    expect(r.status).toBe("missing");
  });

  it("resolves root-level file only at root depth", () => {
    expect(
      resolveTreeChain(rows, args({ segments: ["Button.tsx"] })).status,
    ).toBe("missing");
    expect(
      resolveTreeChain(rows, args({ segments: ["App.tsx"] })),
    ).toMatchObject({ status: "found", index: 7 });
  });

  it("asks to expand collapsed folders", () => {
    expect(
      resolveTreeChain(rows, args({ segments: ["lib", "x.ts"] })),
    ).toMatchObject({ status: "expand", index: 6, at: 0 });
    expect(
      resolveTreeChain(rows, args({ segments: ["lib", "x.ts"], assumeExpandedAt: [0] })),
    ).toMatchObject({ status: "missing", at: 1 });
  });

  it("infers expansion from next row depth when attribute is absent", () => {
    const r = resolveTreeChain(
      [row("src", "folder", 0), row("a.ts", "file", 1)],
      args({ segments: ["src", "a.ts"] }),
    );
    expect(r.status).toBe("found");
  });

  it("lists direct children only", () => {
    const r = resolveTreeChain(
      rows,
      args({ segments: ["src"], kind: "folder", list: true }),
    );
    expect(r).toMatchObject({ status: "found", children: ["ui", "index.ts"] });
    expect(resolveTreeChain(rows, args({ segments: [], list: true }))).toMatchObject({
      children: ["components", "src", "lib", "App.tsx"],
    });
  });

  it("is self-contained when serialised for the page", () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    const fn = new Function(`return (${resolveTreeChain.toString()})`)() as typeof resolveTreeChain;
    expect(fn(rows, args({ segments: ["src", "ui", "Button.tsx"] })).status).toBe("found");
    expect(typeof extractTreeRows.toString()).toBe("string");
    expect(extractTreeRows.toString()).not.toContain("__name");
    expect(resolveTreeChain.toString()).not.toContain("__name");
  });
});

describe("classifyPageState guest view", () => {
  it("a signed-out visitor on a shared Make file counts as needing sign-in", () => {
    const url = "https://www.figma.com/make/abc/Name";
    expect(classifyPageState({ url, text: "What do you want to build? Sign up to use", hasPasswordInput: false })?.kind).toBe("auth");
    expect(classifyPageState({ url, text: "", hasPasswordInput: false, hasGuestPrompt: true })?.kind).toBe("auth");
    expect(classifyPageState({ url, text: "Preview Share Reload", hasPasswordInput: false })).toBeNull();
  });
});

describe("classifyPageState", () => {
  it("detects login redirects", () => {
    expect(
      classifyPageState({ url: "https://www.figma.com/login?x=1", text: "", hasPasswordInput: false })?.kind,
    ).toBe("auth");
    expect(
      classifyPageState({ url: "https://www.figma.com/make/abc", text: "Log in to Figma", hasPasswordInput: false })?.kind,
    ).toBe("auth");
  });

  it("detects error pages", () => {
    const base = { url: "https://www.figma.com/make/abc", hasPasswordInput: false };
    expect(classifyPageState({ ...base, text: "Request access to this file" })?.kind).toBe("forbidden");
    expect(classifyPageState({ ...base, text: "404 Page not found" })?.kind).toBe("not-found");
    expect(classifyPageState({ ...base, text: "Too many requests" })?.kind).toBe("rate-limited");
    expect(classifyPageState({ ...base, text: "Figma Make workspace" })).toBeNull();
  });
});

describe("runPageScript", () => {
  it("calls a function-source string and returns its awaited result (Playwright returns undefined for bare strings)", async (ctx) => {
    const { chromium } = await import("playwright");
    const { runPageScript } = await import("../src/figma/adapter.js");
    let browser;
    try {
      browser = await chromium.launch();
    } catch {
      return ctx.skip();
    }
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="r"><b>x</b></div>');
      const root = page.locator("#r");
      expect(await runPageScript(root, "(el, a) => ({ tag: el.tagName, n: a.n })", { n: 3 })).toEqual({ tag: "DIV", n: 3 });
      expect(await runPageScript(root, "async (el, a) => { await Promise.resolve(); return a.v; }", { v: "ok" })).toBe("ok");
      expect(await page.locator("[data-fm-root]").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });
});

describe("extractTreeRows on the flat virtualised Figma tree", () => {
  it("reads nesting from the first icon's position when rows have no text nodes or padding", async (ctx) => {
    const { chromium } = await import("playwright");
    const { extractTreeRows, resolveTreeChain, runPageScript } = await import("../src/figma/adapter.js");
    let browser;
    try {
      browser = await chromium.launch();
    } catch {
      return ctx.skip();
    }
    try {
      const page = await browser.newPage();
      const row = (kind: "file" | "folder", name: string, indent: number): string =>
        kind === "file"
          ? `<div><button data-testid="code-file-item" aria-label='File "${name}"' style="display:flex;border:0;padding:0"><span style="margin-left:${indent}px;width:16px;display:inline-block"><svg width="16" height="16"></svg></span></button></div>`
          : `<div data-folder-item="true"><button aria-expanded="true" aria-label='Folder "${name}"' style="display:flex;border:0;padding:0"><span style="margin-left:${indent}px;width:16px;display:inline-block"><svg width="16" height="16"></svg></span></button></div>`;
      await page.setContent(`<div id="tree">${row("folder", "src", 0)}${row("file", "App.tsx", 16)}${row("file", "mailData.ts", 16)}${row("file", "AGENTS.md", 0)}</div>`);
      const script = `(root, args) => { const out = (${extractTreeRows.toString()})(root); return (${resolveTreeChain.toString()})(out.rows, args); }`;
      const found = await runPageScript<{ status: string }>(page.locator("#tree"), script, { segments: ["src", "mailData.ts"], kind: "file", expandLast: false, list: false, assumeExpandedAt: [] });
      expect(found.status).toBe("found");
      const rootLevel = await runPageScript<{ status: string }>(page.locator("#tree"), script, { segments: ["mailData.ts"], kind: "file", expandLast: false, list: false, assumeExpandedAt: [] });
      expect(rootLevel.status).toBe("missing");
    } finally {
      await browser.close();
    }
  });
});

describe("resolveTreeChain over a scrolled, virtualised window", () => {
  const row = (label: string, depth: number, kind: "file" | "folder" = "file") => ({ label, depth, kind, expanded: kind === "folder" ? true : null, active: false, activeSupported: true });
  const base = { kind: "file" as const, expandLast: false, list: false, assumeExpandedAt: [] as number[] };

  it("reports where the chain stopped when the file is below the window", async () => {
    const { resolveTreeChain } = await import("../src/figma/adapter.js");
    const top = [row("src", 193, "folder"), row("assets", 201, "folder"), row("App.tsx", 201)];
    expect(resolveTreeChain(top, { ...base, segments: ["src", "Outlook.tsx"] })).toEqual({ status: "missing", at: 1, parentDepth: 193, childDepth: 201 });
  });

  it("finds it after the src row scrolled out of the page, and ignores same-named rows outside src", async () => {
    const { resolveTreeChain } = await import("../src/figma/adapter.js");
    // window: tail of src's children, then root-level files with the same names
    const scrolled = [row("MyAccount.tsx", 201), row("Outlook.tsx", 201), row("zeta.ts", 201), row("AGENTS.md", 193), row("Outlook.tsx", 193)];
    const resume = { at: 1, parentDepth: 193, childDepth: 201 };
    const hit = resolveTreeChain(scrolled, { ...base, segments: ["src", "Outlook.tsx"], resume });
    expect(hit).toMatchObject({ status: "found", index: 1, matchCount: 1 });
    // a root-only name must not match inside src
    expect(resolveTreeChain(scrolled, { ...base, segments: ["src", "AGENTS.md"], resume })).toMatchObject({ status: "missing" });
  });

  it("skips rows above the folder when the window still shows them", async () => {
    const { resolveTreeChain } = await import("../src/figma/adapter.js");
    const mixed = [row("public", 193, "folder"), row("Outlook.tsx", 193), row("src", 193, "folder"), row("a.ts", 201)];
    const resume = { at: 1, parentDepth: 193, childDepth: 201 };
    expect(resolveTreeChain(mixed, { ...base, segments: ["src", "Outlook.tsx"], resume })).toMatchObject({ status: "missing" });
    expect(resolveTreeChain(mixed, { ...base, segments: ["src", "a.ts"], resume })).toMatchObject({ status: "found", index: 3 });
  });
});
