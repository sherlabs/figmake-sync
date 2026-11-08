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
