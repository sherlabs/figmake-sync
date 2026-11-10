import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown, type Block, type Inline } from "../src/app/markdown.js";

const flat = (b: Block[]): string => JSON.stringify(b);
const tags = (list: Inline[]): string[] => list.map((i) => i.t);

describe("markdown-lite", () => {
  it("reads paragraphs, bold, italic and inline code", () => {
    const b = parseMarkdown("Hello **there** and `code` and *soft*.\n\nSecond paragraph.");
    expect(b.map((x) => x.t)).toEqual(["p", "p"]);
    expect(tags((b[0] as Extract<Block, { t: "p" }>).v)).toEqual(["text", "strong", "text", "code", "text", "em", "text"]);
  });

  it("reads bullet and numbered lists", () => {
    const b = parseMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(b.map((x) => x.t)).toEqual(["ul", "ol"]);
    expect((b[0] as Extract<Block, { t: "ul" }>).v).toHaveLength(2);
    expect((b[1] as Extract<Block, { t: "ol" }>).start).toBe(1);
  });

  it("reads fenced code, even when the fence is still open", () => {
    expect(parseMarkdown("```css\n.a { color: red }\n```")).toEqual([{ t: "pre", v: ".a { color: red }" }]);
    expect(parseMarkdown("```\nstill typing")).toEqual([{ t: "pre", v: "still typing" }]);
  });

  it("shows unfinished bold as bold while text streams in", () => {
    expect(parseInline("go **fast")).toEqual([{ t: "text", v: "go " }, { t: "strong", v: [{ t: "text", v: "fast" }] }]);
    expect(parseInline("a ** b")).toEqual([{ t: "text", v: "a ** b" }]);
    expect(parseInline("snake_case_name stays")).toEqual([{ t: "text", v: "snake_case_name stays" }]);
  });

  it("keeps raw HTML as plain text (no tags exist in the tree)", () => {
    for (const evil of ['<img src=x onerror=alert(1)>', "<script>alert(1)</script>", '<a href="javascript:alert(1)">x</a>', "<iframe src=//evil></iframe>", "<svg onload=alert(1)>"]) {
      const b = parseMarkdown(evil);
      expect(b).toEqual([{ t: "p", v: [{ t: "text", v: evil }] }]);
    }
  });

  it("never makes links or images: markdown links and javascript: urls stay literal text", () => {
    const src = "[click](javascript:alert(1)) ![x](https://evil/x.png) https://example.com";
    const b = parseMarkdown(src);
    expect(flat(b)).not.toMatch(/"t":"(a|img|link|image)"/u);
    const first = b[0] as Extract<Block, { t: "p" }>;
    expect(first.v.every((i) => i.t === "text")).toBe(true);
    expect(first.v.map((i) => (i as { v: string }).v).join("")).toBe(src);
  });

  it("only ever produces the fixed set of node types", () => {
    const b = parseMarkdown("# Title\n\n- **a** `b` *c*\n\n```\nx\n```\n\n1) one");
    const seen = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        const t = (x as { t?: string }).t;
        if (t) seen.add(t);
        Object.values(x).forEach(walk);
      }
    };
    walk(b);
    expect([...seen].every((t) => ["p", "ul", "ol", "pre", "text", "strong", "em", "code"].includes(t))).toBe(true);
  });
});
