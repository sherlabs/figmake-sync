import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const dir = path.join(process.cwd(), "src", "electron", "renderer");
const read = (name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

describe("renderer: static guarantees", () => {
  const html = read("index.html");
  const FILES = ["app.ts", "dom.ts", "chat.ts", "diff.ts"];
  const code = FILES.map(read).join("\n");

  it("keeps the strict CSP (no inline styles or scripts, no network)", () => {
    expect(html).toContain("default-src 'self'; script-src 'self'; style-src 'self';");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toMatch(/<style|\sstyle=|\sonclick=/u);
  });

  it("never writes HTML from strings", () => {
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  });

  it("only uses icons that exist in the sprite", () => {
    const sprite = new Set([...html.matchAll(/<symbol id="i-([^"]+)"/gu)].map((m) => m[1]));
    const used = [...code.matchAll(/\bicon\("([^"]+)"/gu)].map((m) => m[1] ?? "");
    const glyphs = [...code.matchAll(/glyph: "([^"]+)"/gu)].map((m) => m[1] ?? "");
    for (const name of [...used, ...glyphs]) expect(sprite.has(name), name).toBe(true);
  });

  it("covers every renderer source file", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(all.sort()).toEqual([...FILES].sort());
  });

  it("builds message content only from text nodes and a fixed set of tags", () => {
    expect(code).not.toMatch(/h\(\s*"(a|script|iframe|svg|object|embed|link|style)"/u);
    // (dom.ts itself sets the sprite's href; nothing that draws messages may.)
    const drawing = ["app.ts", "chat.ts", "diff.ts"].map(read).join("\n");
    expect(drawing).not.toMatch(/setAttribute\(\s*"(href|src|style|on\w+)"/u);
    expect(drawing).not.toMatch(/\b(href|src|srcdoc)\s*:\s*(?!\s*"\.\/assets\/)/u);
    expect(code).not.toMatch(/\.href\s*=|\.src\s*=|eval\(|new Function\(/u);
    const md = read("chat.ts");
    expect(md).not.toMatch(/h\(\s*"img"/u);
    // The tag names created from markdown are literals, never taken from the message.
    expect(md).toMatch(/h\("pre", \{\}, h\("code"/u);
    expect(md).not.toMatch(/createElement\(\s*(?!"|`)/u);
  });

  it("keeps the chat panel accessible: log region, labelled controls, reduced motion", () => {
    const chat = read("chat.ts");
    expect(chat).toMatch(/role: "log"/u);
    expect(chat).toMatch(/"aria-live": "polite"/u);
    expect(chat).toMatch(/"aria-label": "Message"/u);
    expect(chat).toMatch(/"aria-label": "Stop"/u);
    expect(fs.readFileSync(path.join(dir, "styles.css"), "utf8")).toMatch(/prefers-reduced-motion: reduce/u);
  });

  it("only talks to the main process through window.figmake", () => {
    expect(code).not.toMatch(/ipcRenderer|require\(/u);
    // Renderer modules may import only browser-safe app modules (no node: builtins).
    expect(code).not.toMatch(/from "node:/u);
    expect(read("../../app/chat.ts")).not.toMatch(/from "node:/u);
    expect(read("../../app/markdown.ts")).not.toMatch(/from "node:|from "\.\.?\//u);
  });
});
