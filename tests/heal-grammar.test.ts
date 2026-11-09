import { describe, expect, it } from "vitest";

import { containsTerm } from "../src/heal/healable.js";
import { filterSelectors, validateSelectorGrammar } from "../src/heal/selectorGrammar.js";

const ok = (s: string): void => expect(validateSelectorGrammar(s), s).toMatchObject({ ok: true });
const bad = (s: unknown): void => expect(validateSelectorGrammar(s), String(s)).toMatchObject({ ok: false });

describe("selector grammar", () => {
  it("accepts plain CSS, text= and role= forms", () => {
    ok('button[aria-label="Code view"]');
    ok('[data-testid="view-toggle"] input[value="code"]');
    ok('[role="tab"]:has-text("Code")');
    ok('label:text-is("Code")');
    ok('div:has(button[data-testid="x"]) > button');
    ok("text=Code");
    ok('text="Code view"');
    ok("text=/^code$/i");
    ok('role=button[name="Code"i]');
    ok("role=radio");
    ok('[data-tooltip="Code" i]');
    ok('[data-testid="description"]'); // contains "script" as a substring of a value: fine
  });

  it("rejects injection and engine abuse", () => {
    bad("javascript:alert(1)");
    bad('a[href="javascript:alert(1)"]');
    bad("div:has(script)");
    bad("div:has( script )");
    bad("script");
    bad("button >> nth=0");
    bad("xpath=//button");
    bad("//button[text()='Code']");
    bad("(//button)[1]");
    bad("../button");
    bad("css=button");
    bad("internal:role=button[name=/code/i]");
    bad('data-testid=toggle');
    bad("button; drop");
    bad("button{color:red}");
    bad("button:eval(1)");
    bad("button:nth-foo(1)");
    bad("button::before");
    bad('role=button[name="Code"][checked]');
    bad("role=heading");
    bad("text=<img onerror=alert(1)>");
    bad("button[onclick=alert(1)]");
    bad("`x`");
    bad("");
    bad("   ");
    bad(42);
    bad(null);
    bad("*");
    bad("[");
    bad('button[aria-label="Code]');
    bad("x".repeat(201));
  });

  it("rejects lookalike (non-ASCII) names", () => {
    bad('button[aria-label="Cоde"]'); // Cyrillic o
    bad("text=Cоde");
    bad('button[aria-label="Code​"]');
  });

  it("filterSelectors dedupes, caps and reports rejections", () => {
    const r = filterSelectors(['button[aria-label="A"]', 'button[aria-label="A"]', "javascript:1", "b", "i", "u", "em"], 3);
    expect(r.accepted).toEqual(['button[aria-label="A"]', "b", "i"]);
    expect(r.rejected).toHaveLength(1);
    expect(filterSelectors("nope").accepted).toEqual([]);
  });
});

describe("containsTerm", () => {
  it("matches whole words case-insensitively", () => {
    expect(containsTerm("Code", "code")).toBe(true);
    expect(containsTerm("Code view", "code")).toBe(true);
    expect(containsTerm("Show CODE editor", "code")).toBe(true);
  });
  it("rejects lookalikes and substrings", () => {
    expect(containsTerm("Encode", "code")).toBe(false);
    expect(containsTerm("Decoder", "code")).toBe(false);
    expect(containsTerm("Codebase", "code")).toBe(false);
    expect(containsTerm("Cоde", "code")).toBe(false);
    expect(containsTerm("Preview", "code")).toBe(false);
  });
});
