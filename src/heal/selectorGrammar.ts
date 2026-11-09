/**
 * Strict grammar for AI-proposed selectors. The AI output is UNTRUSTED data: a selector is only ever handed to
 * Playwright's locator() after passing this check, and even then it is just a query (never code).
 *
 * Accepted forms:
 *   1. plain CSS (ASCII only) using a whitelist of pseudo-classes (incl. Playwright's :has-text/:text-is);
 *   2. text=...   (text=Code, text="Code", text=/^code$/i)
 *   3. role=<role>[name="..."] / [name="..."i] / [name=/regex/i]
 * Rejected: >> chains, xpath, internal: / data-testid= / css= engines, javascript:, script-ish tags, non-ASCII
 * (lookalike glyphs), backslashes, braces, anything > 200 chars, unbalanced brackets/quotes.
 */

export const MAX_SELECTOR_LENGTH = 200;

const ALLOWED_ENGINES = new Set(["text", "role"]);
const ALLOWED_ROLES = new Set(["radio", "tab", "button", "switch", "menuitem", "link", "checkbox", "menuitemradio"]);
const ALLOWED_PSEUDOS = new Set([
  "has-text",
  "text-is",
  "text",
  "has",
  "not",
  "is",
  "where",
  "nth-child",
  "nth-of-type",
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "checked",
  "enabled",
  "disabled",
  "visible",
]);

export type GrammarResult = { ok: true; selector: string } | { ok: false; reason: string };

const BAD_SUBSTRINGS = [
  ">>",
  "javascript:",
  "vbscript:",
  "data:",
  "expression(",
  "url(",
  "=>",
  "xpath",
  "internal:",
  "<",
  ">=",
  ";",
  "{",
  "}",
  "\\",
  "`",
  "$(",
  "eval(",
];
const BAD_TAG = /(^|[\s>+~,(])(script|style|iframe|object|embed|link|meta|svg|html|body|head)\b/i;
// Characters allowed anywhere in a CSS selector (quoted strings are checked separately and more strictly).
const CSS_CHARS = /^[A-Za-z0-9_\-\s.#[\]()=:"'*^$|~>+,@%/!?&]*$/;

function balanced(sel: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  for (const ch of sel) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") stack.push(ch);
    else if (ch === ")") {
      if (stack.pop() !== "(") return false;
    } else if (ch === "]") {
      if (stack.pop() !== "[") return false;
    }
  }
  return quote === null && stack.length === 0;
}

function stripQuoted(sel: string): { bare: string; strings: string[] } {
  const strings: string[] = [];
  const bare = sel.replace(/"([^"]*)"|'([^']*)'/g, (_m, a: string | undefined, b: string | undefined) => {
    strings.push(a ?? b ?? "");
    return '""';
  });
  return { bare, strings };
}

const STRING_BODY = /^[A-Za-z0-9 _\-.,:/()!?&+@#%^$*|~]{0,80}$/;

function checkCss(sel: string): GrammarResult {
  if (!CSS_CHARS.test(sel)) return { ok: false, reason: "disallowed character" };
  if (!balanced(sel)) return { ok: false, reason: "unbalanced brackets or quotes" };
  const { bare, strings } = stripQuoted(sel);
  for (const s of strings) if (!STRING_BODY.test(s)) return { ok: false, reason: "disallowed character in string" };
  if (BAD_TAG.test(bare)) return { ok: false, reason: "disallowed element type" };
  if (/:has\(\s*(script|style|iframe)/i.test(sel)) return { ok: false, reason: "disallowed :has() target" };
  if (/^\s*(\/|\.\.|\()/.test(sel)) return { ok: false, reason: "looks like xpath" };
  if (/^\s*["']/.test(sel)) return { ok: false, reason: "starts with a quote" };
  // pseudo-classes / pseudo-elements: names must be whitelisted (attribute values are already blanked out)
  for (const m of bare.matchAll(/::?([A-Za-z-]+)/g)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!ALLOWED_PSEUDOS.has(name)) return { ok: false, reason: `pseudo-class :${name} not allowed` };
  }
  // anything that looks like a function call outside a whitelisted pseudo
  for (const m of bare.matchAll(/([A-Za-z_-]+)\(/g)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!ALLOWED_PSEUDOS.has(name)) return { ok: false, reason: `function ${name}( not allowed` };
  }
  // Must contain something selective.
  if (!/[A-Za-z]/.test(bare)) return { ok: false, reason: "too generic" };
  if (/^\s*[*]\s*$/.test(bare)) return { ok: false, reason: "too generic" };
  return { ok: true, selector: sel };
}

function checkText(body: string, sel: string): GrammarResult {
  const quoted = /^"([^"]{1,60})"i?$|^'([^']{1,60})'i?$/.exec(body);
  const inner = quoted ? (quoted[1] ?? quoted[2] ?? "") : undefined;
  if (inner !== undefined) {
    return STRING_BODY.test(inner) ? { ok: true, selector: sel } : { ok: false, reason: "disallowed character in text" };
  }
  const regex = /^\/([A-Za-z0-9 _\-.,:^$|()?*+]{1,60})\/i?$/.exec(body);
  if (regex) return { ok: true, selector: sel };
  if (/^[A-Za-z0-9 _\-.,:!?&()]{1,60}$/.test(body)) return { ok: true, selector: sel };
  return { ok: false, reason: "malformed text= selector" };
}

function checkRole(body: string, sel: string): GrammarResult {
  const m = /^([a-z]+)(?:\[name=(?:"([^"]{1,60})"|\/([A-Za-z0-9 _\-.,:^$|()?*+]{1,60})\/)i?\])?$/.exec(body);
  if (!m || !ALLOWED_ROLES.has(m[1] ?? "")) return { ok: false, reason: "malformed role= selector" };
  const name = m[2];
  if (name !== undefined && !STRING_BODY.test(name)) return { ok: false, reason: "disallowed character in role name" };
  return { ok: true, selector: sel };
}

export function validateSelectorGrammar(input: unknown): GrammarResult {
  if (typeof input !== "string") return { ok: false, reason: "not a string" };
  const sel = input.trim();
  if (sel.length === 0) return { ok: false, reason: "empty" };
  if (sel.length > MAX_SELECTOR_LENGTH) return { ok: false, reason: "too long" };
  if (!/^[\x20-\x7E]+$/.test(sel)) return { ok: false, reason: "non-ASCII or control character" };
  const lower = sel.toLowerCase();
  for (const bad of BAD_SUBSTRINGS) if (lower.includes(bad)) return { ok: false, reason: `contains "${bad}"` };
  if (/\bon[a-z]+\s*=/.test(lower)) return { ok: false, reason: "event handler" };

  // Playwright engine prefix, matched the way Playwright itself does (it includes ':' and '+' in engine names).
  const engine = /^([a-zA-Z_0-9\-+:*]+)=(.*)$/s.exec(sel);
  if (engine) {
    const name = (engine[1] ?? "").toLowerCase();
    if (!ALLOWED_ENGINES.has(name)) return { ok: false, reason: `engine ${name}= not allowed` };
    return name === "text" ? checkText(engine[2] ?? "", sel) : checkRole(engine[2] ?? "", sel);
  }
  return checkCss(sel);
}

export function filterSelectors(candidates: unknown, max = 3): { accepted: string[]; rejected: Array<{ selector: string; reason: string }> } {
  const accepted: string[] = [];
  const rejected: Array<{ selector: string; reason: string }> = [];
  if (!Array.isArray(candidates)) return { accepted, rejected };
  for (const c of candidates.slice(0, 10)) {
    const r = validateSelectorGrammar(c);
    if (r.ok) {
      if (!accepted.includes(r.selector) && accepted.length < max) accepted.push(r.selector);
    } else rejected.push({ selector: String(c).slice(0, 200), reason: r.reason });
  }
  return { accepted, rejected };
}
