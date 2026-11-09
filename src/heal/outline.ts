import { createHash } from "node:crypto";

import type { Page } from "playwright";

/**
 * SANITISED page outline: the only page evidence that ever leaves the page (to the user's own AI CLI).
 * Built in two passes: collectOutline() runs in the page and only reads interactive/landmark elements; then
 * sanitizeOutline() (Node side, pure, unit-tested) re-validates, redacts and caps everything, so even a
 * compromised in-page pass cannot leak more than the allowed fields.
 */

export const OUTLINE_MAX_ELEMENTS = 250;
export const OUTLINE_MAX_BYTES = 30_000;
const MAX_TEXT = 40;
const MAX_ATTR_VALUE = 60;
const MAX_ATTRS = 8;
const MAX_PATH = 4;
const LANDMARKS = new Set(["nav", "aside", "header"]);

export interface OutlineElement {
  tag: string;
  role?: string;
  type?: string;
  value?: string;
  ariaLabel?: string;
  text?: string;
  attrs?: Record<string, string>;
  /** Ancestor hops, nearest first: "tag" or "tag[testid]" / "tag[role]" only. */
  path?: string[];
  visible?: boolean;
  disabled?: boolean;
}

export interface PageOutline {
  elements: OutlineElement[];
  truncated: boolean;
  fingerprint: string;
}

// The in-page pass is plain JS in a string: no transpiler helpers can leak into the serialised function.
const COLLECT_SCRIPT = `(() => {
  const INTERACTIVE = 'button, [role="radio"], [role="tab"], [role="button"], [role="switch"], [role="menuitem"], input[type="radio"], input[type="checkbox"], a, nav, aside, header, textarea, [role="textbox"], [role="combobox"], input[type="text"], input[type="search"], input[type="file"]';
  const SKIP_INSIDE = '.cm-editor, .monaco-editor, [data-testid="code-editor"], pre, code';
  const EDITABLE_HOST = '[contenteditable="true"], textarea';
  const SECRET_ATTR = /token|secret|key|auth|session|cookie|email|password|user|href|src|url/i;
  const clip = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, n);
  const hop = (el) => {
    const tid = el.getAttribute('data-testid');
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    return tag + (tid ? '[' + clip(tid, 60) + ']' : role ? '[' + clip(role, 30) + ']' : '');
  };
  const found = Array.from(document.querySelectorAll(INTERACTIVE));
  const out = [];
  for (let i = 0; i < found.length; i++) {
    const el = found[i];
    if (el.closest(SKIP_INSIDE)) continue;
    if (el.parentElement && el.parentElement.closest(EDITABLE_HOST)) continue;
    const tag = el.tagName.toLowerCase();
    const typed = tag === 'textarea' || el.getAttribute('role') === 'textbox' || el.getAttribute('contenteditable') === 'true';
    const type = el.getAttribute('type');
    const isInput = tag === 'input';
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visible = cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width > 0 || r.height > 0);
    const attrs = {};
    let n = 0;
    for (const a of Array.from(el.attributes)) {
      if (n >= 8) break;
      if (!/^(data-|aria-(label|checked|pressed|selected|expanded)|title$|name$)/i.test(a.name)) continue;
      if (a.name === 'aria-label' || SECRET_ATTR.test(a.name)) continue;
      if (a.value.length > 60) continue;
      attrs[a.name] = a.value;
      n++;
    }
    const path = [];
    let p = el.parentElement;
    for (let h = 0; h < 4 && p && p !== document.body; h++, p = p.parentElement) path.push(hop(p));
    const text = isInput || typed || /^(nav|aside|header)$/.test(tag) ? '' : clip(el.innerText || el.textContent, 40);
    out.push({
      tag,
      role: el.getAttribute('role') || undefined,
      type: isInput ? type || undefined : undefined,
      value: isInput && (type === 'radio' || type === 'checkbox') ? clip(el.getAttribute('value'), 60) : undefined,
      ariaLabel: clip(el.getAttribute('aria-label'), 60) || undefined,
      text: text || undefined,
      attrs,
      path,
      visible,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
    });
  }
  return out;
})()`;

// ---- redaction --------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
const KEY_PREFIX = /\b(?:sk|pk|ghp|gho|xox[a-z]|AKIA|figd|fig)[-_][A-Za-z0-9_-]{12,}/g;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;
const URL_RE = /https?:\/\/\S+/g;

export function redact(input: string): string {
  return input
    .replace(URL_RE, "[url]")
    .replace(EMAIL, "[email]")
    .replace(JWT_LIKE, "[token]")
    .replace(KEY_PREFIX, "[token]")
    .replace(LONG_TOKEN, (m) => {
      // A long run of words joined by hyphens (e.g. a test id) is fine; mixed letters+digits or very long runs are token-like.
      if (/\d/.test(m)) return "[token]";
      if (m.length >= 32 && !/[-_]/.test(m)) return "[token]";
      return m;
    });
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = redact(value.replace(/\s+/g, " ").trim()).slice(0, max);
  return v.length > 0 ? v : undefined;
}

const ATTR_NAME_OK = /^(data-[a-z0-9-]{1,40}|aria-(checked|pressed|selected|expanded)|title|name)$/i;
const ATTR_NAME_BAD = /token|secret|key|auth|session|cookie|email|password|user|href|src|url/i;

export function sanitizeElement(raw: unknown): OutlineElement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tag = typeof r["tag"] === "string" ? r["tag"].toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) : "";
  if (!tag) return null;
  const el: OutlineElement = { tag };
  const role = clean(r["role"], 30);
  if (role) el.role = role;
  const type = clean(r["type"], 20);
  const isInput = tag === "input";
  // Never expose any input value except for radio/checkbox (their value is a fixed option name, not user text).
  if (isInput && type) el.type = type;
  if (isInput && (type === "radio" || type === "checkbox")) {
    const value = clean(r["value"], MAX_ATTR_VALUE);
    if (value) el.value = value;
  }
  const aria = clean(r["ariaLabel"], MAX_ATTR_VALUE);
  if (aria) el.ariaLabel = aria;
  const typed = tag === "textarea" || role === "textbox";
  if (!isInput && !typed && !LANDMARKS.has(tag)) {
    const text = clean(r["text"], MAX_TEXT);
    if (text) el.text = text;
  }
  if (r["attrs"] && typeof r["attrs"] === "object") {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r["attrs"] as Record<string, unknown>)) {
      if (Object.keys(attrs).length >= MAX_ATTRS) break;
      if (!ATTR_NAME_OK.test(k) || ATTR_NAME_BAD.test(k)) continue;
      if (typeof v !== "string" || v.length > MAX_ATTR_VALUE) continue;
      const value = clean(v, MAX_ATTR_VALUE);
      if (value !== undefined) attrs[k.toLowerCase()] = value;
    }
    if (Object.keys(attrs).length > 0) el.attrs = attrs;
  }
  if (Array.isArray(r["path"])) {
    const path = r["path"]
      .slice(0, MAX_PATH)
      .map((p) => (typeof p === "string" && /^[a-z0-9-]{1,20}(\[[^\]]{1,60}\])?$/i.test(p) ? clean(p, 80) : undefined))
      .filter((p): p is string => p !== undefined);
    if (path.length > 0) el.path = path;
  }
  if (typeof r["visible"] === "boolean") el.visible = r["visible"];
  if (r["disabled"] === true) el.disabled = true;
  return el;
}

export function fingerprintOutline(elements: OutlineElement[]): string {
  const basis = elements
    .map((e) => [e.tag, e.role ?? "", e.type ?? "", e.attrs?.["data-testid"] ?? ""].join("|"))
    .sort()
    .join("\n");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

export function sanitizeOutline(raw: unknown, limits = { maxElements: OUTLINE_MAX_ELEMENTS, maxBytes: OUTLINE_MAX_BYTES }): PageOutline {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = list.map((r) => sanitizeElement(r)).filter((e): e is OutlineElement => e !== null);
  let truncated = false;
  // Keep visible elements first when over the cap, but preserve document order.
  let kept = cleaned;
  if (cleaned.length > limits.maxElements) {
    truncated = true;
    const indexed = cleaned.map((e, i) => ({ e, i }));
    const picked = [...indexed.filter((x) => x.e.visible !== false), ...indexed.filter((x) => x.e.visible === false)].slice(
      0,
      limits.maxElements,
    );
    kept = picked.sort((a, b) => a.i - b.i).map((x) => x.e);
  }
  while (kept.length > 0 && JSON.stringify(kept).length > limits.maxBytes) {
    truncated = true;
    kept = kept.slice(0, Math.max(0, Math.floor(kept.length * 0.9) - 1));
  }
  return { elements: kept, truncated, fingerprint: fingerprintOutline(kept) };
}

/** Build the outline from the live page. Never throws (returns an empty outline on failure). */
export async function collectOutline(page: Page): Promise<PageOutline> {
  try {
    const raw: unknown = await page.evaluate(COLLECT_SCRIPT);
    return sanitizeOutline(raw);
  } catch {
    return { elements: [], truncated: false, fingerprint: fingerprintOutline([]) };
  }
}
