import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectOutline, OUTLINE_MAX_BYTES, OUTLINE_MAX_ELEMENTS, redact, sanitizeOutline } from "../src/heal/outline.js";

describe("sanitizeOutline", () => {
  it("redacts emails, tokens, urls", () => {
    expect(redact("mail me bob@example.com")).toBe("mail me [email]");
    expect(redact("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def")).toBe("[token]");
    expect(redact("sk-ant-api03-abcdefghijklmnopqrstuvwx")).toBe("[token]");
    expect(redact("abcdef0123456789abcdef0123456789abcdef")).toBe("[token]");
    expect(redact("see https://x.com/a?token=abc")).toBe("see [url]");
    expect(redact("code-display-toggle-primary-view")).toBe("code-display-toggle-primary-view");
  });

  it("keeps only allowed fields, truncates text, drops secret-ish attrs and long values", () => {
    const o = sanitizeOutline([
      {
        tag: "BUTTON",
        text: "word ".repeat(30),
        ariaLabel: "Code view",
        attrs: { "data-testid": "toggle", "data-auth-token": "abc", "data-long": "y".repeat(61), href: "/x", onclick: "evil()" },
        path: ["div[toolbar]", "div onclick=evil()", "section"],
        visible: true,
        evil: "ignored",
      },
      { tag: "input", type: "text", value: "my typed secret", text: "typed" },
      { tag: "input", type: "radio", value: "code" },
      { tag: "nav", text: "arbitrary page text" },
      null,
      { nope: 1 },
    ]);
    const [btn, textInput, radio, nav] = o.elements;
    expect(btn?.tag).toBe("button");
    expect(btn?.text?.length).toBe(40);
    expect(btn?.attrs).toEqual({ "data-testid": "toggle" });
    expect(btn?.path).toEqual(["div[toolbar]", "section"]);
    expect(JSON.stringify(btn)).not.toContain("evil");
    expect(textInput?.value).toBeUndefined();
    expect(textInput?.text).toBeUndefined();
    expect(radio?.value).toBe("code");
    expect(nav?.text).toBeUndefined();
    expect(o.elements).toHaveLength(4);
  });

  it("caps element count and bytes", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ tag: "button", text: `b${i}`, visible: i % 2 === 0 }));
    const o = sanitizeOutline(many);
    expect(o.elements.length).toBeLessThanOrEqual(OUTLINE_MAX_ELEMENTS);
    expect(o.truncated).toBe(true);
    expect(o.elements.every((e) => e.visible)).toBe(true);
    const fat = Array.from({ length: 250 }, (_, i) => ({
      tag: "button",
      text: "t".repeat(40),
      ariaLabel: "a".repeat(60),
      attrs: Object.fromEntries(Array.from({ length: 8 }, (_v, j) => [`data-a${j}`, `v${i}`.padEnd(60, "z")])),
      path: ["div[aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]", "div[bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]"],
    }));
    const f = sanitizeOutline(fat);
    expect(JSON.stringify(f.elements).length).toBeLessThanOrEqual(OUTLINE_MAX_BYTES);
    expect(f.truncated).toBe(true);
  });

  it("fingerprint is stable and structure-sensitive", () => {
    const a = sanitizeOutline([{ tag: "button", attrs: { "data-testid": "a" } }]);
    const b = sanitizeOutline([{ tag: "button", attrs: { "data-testid": "a" } }]);
    const c = sanitizeOutline([{ tag: "button", attrs: { "data-testid": "b" } }]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
});

describe("collectOutline (real page)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("never includes editor contents, typed values, passwords, urls or free page text", async () => {
    await page.setContent(`
      <header data-testid="top">SECRET HEADER TEXT FREE</header>
      <p>Free paragraph text with alice@example.com</p>
      <div data-radio-options-root="true">
        <label><input type="radio" value="preview" data-tooltip="Preview"> Preview</label>
        <label><input type="radio" value="code" data-tooltip="Code"> Code</label>
      </div>
      <button aria-label="Code view" data-testid="toggle">Open</button>
      <a href="https://figma.com/x?token=abcdef">Docs link</a>
      <input type="password" value="hunter2"><input type="text" value="my typed note">
      <textarea>TEXTAREA SECRET</textarea>
      <div class="monaco-editor"><button>monaco inner button SECRET_CODE</button><pre>const apiKey = "sk-live-1234567890abcdef1234567890";</pre></div>
      <div contenteditable="true"><button>editable SECRET</button></div>
    `);
    const outline = await collectOutline(page);
    const json = JSON.stringify(outline);
    for (const leak of ["hunter2", "my typed note", "TEXTAREA SECRET", "SECRET_CODE", "sk-live", "editable SECRET", "alice@example.com", "token=abcdef", "SECRET HEADER", "Free paragraph", "figma.com/x"]) {
      expect(json, leak).not.toContain(leak);
    }
    expect(json).toContain("Code view");
    expect(outline.elements.some((e) => e.tag === "input" && e.value === "code")).toBe(true);
    expect(outline.elements.some((e) => e.tag === "a" && e.text === "Docs link")).toBe(true);
  });
});
