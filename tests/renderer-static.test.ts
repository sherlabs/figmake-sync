import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APP_CSP } from "../src/electron/csp.js";

const dir = path.join(process.cwd(), "src", "electron", "renderer");
const read = (name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

describe("renderer: static guarantees", () => {
  const html = read("index.html");
  const FILES = ["monaco.ts", "review.ts", "sync.ts", "app.ts", "dom.ts", "chat.ts", "attach.ts", "diff.ts", "files.ts", "output.ts", "outputTab.ts", "browserBar.ts"];
  const code = FILES.map(read).join("\n");

  it("keeps the strict CSP: only what Monaco needs is loosened, nothing remote, same text in the page and in main", () => {
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1];
    expect(meta).toBe(APP_CSP);
    expect(APP_CSP).toContain("script-src 'self';");
    expect(APP_CSP).toContain("style-src 'self' 'unsafe-inline';");
    expect(APP_CSP).toContain("worker-src blob:;");
    expect(APP_CSP).toContain("connect-src 'none'");
    expect(APP_CSP.match(/unsafe-inline/gu)).toHaveLength(1);
    expect(APP_CSP).not.toMatch(/unsafe-eval|https?:|\*|data:(?!\s*;)(?<!img-src 'self' data:)/u);
    expect(html).not.toMatch(/<style|\sstyle=|\sonclick=/u);
    expect(fs.readFileSync(path.join(process.cwd(), "src", "electron", "main.ts"), "utf8")).toContain("APP_CSP");
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
    const drawing = ["app.ts", "chat.ts", "attach.ts", "diff.ts", "files.ts", "output.ts", "outputTab.ts"].map(read).join("\n");
    expect(drawing).not.toMatch(/setAttribute\(\s*"(href|src|style|on\w+)"/u);
    expect(drawing).not.toMatch(/\b(href|src|srcdoc)\s*:\s*(?!\s*"\.\/assets\/)/u);
    // monaco.ts alone sets a script src: its own bundled loader, from the app's own folder (checked below).
    const others = FILES.filter((f) => f !== "monaco.ts").map(read).join("\n");
    expect(others).not.toMatch(/\.href\s*=|\.src\s*=|eval\(|new Function\(/u);
    const monaco = read("monaco.ts");
    expect(monaco).not.toMatch(/eval\(|new Function\(|https?:\/\//u);
    expect(monaco).toContain("./vendor/monaco");
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
