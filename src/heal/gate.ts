import type { Locator, Page } from "playwright";

import type { SelectorKind } from "../figma/selectors.js";
import { containsAnyTerm } from "./healable.js";
import { validateSelectorGrammar } from "./selectorGrammar.js";

export const MAX_MATCHES_INSPECTED = 20;

export type GateResult = { ok: true; locator: Locator } | { ok: false; reason: string };

// Runs in the page; kept free of helpers so it serialises cleanly.
const readFacts = (el: Element): string[] => {
  const out: string[] = [];
  const add = (v: string | null | undefined): void => {
    if (typeof v === "string" && v.trim()) out.push(v.trim().slice(0, 120));
  };
  add(el.getAttribute("aria-label"));
  add(el.getAttribute("title"));
  add(el.getAttribute("data-tooltip"));
  add(el.getAttribute("value"));
  add(el.getAttribute("placeholder"));
  add(el.getAttribute("name"));
  if (el.tagName.toLowerCase() !== "input") add((el as HTMLElement).innerText || el.textContent);
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    for (const id of lb.split(/\s+/)) add(document.getElementById(id)?.textContent);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels) {
    for (const l of Array.from(labels)) add(l.textContent);
  }
  add(el.closest("label")?.textContent);
  return out;
};

const isInsideMenu = (el: Element): boolean => el.closest('[role="menu"], [role="menubar"], [data-radix-menu-content], [data-fpl-floating-overlay]') !== null;

const isEditable = (el: Element): boolean => {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") return !["button", "checkbox", "radio", "file", "submit", "reset", "image", "range", "color"].includes((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable || el.getAttribute("role") === "textbox" || el.getAttribute("role") === "combobox";
};

/**
 * Safety gate for ONE proposed selector against the LIVE page: strict grammar, resolves to exactly one visible
 * element, that element is enabled, and its own accessible name/label/tooltip/value contains the expected term.
 * Does not click anything.
 */
export async function gateSelector(
  page: Page,
  selector: string,
  expectTerm: string | readonly string[],
  kind?: SelectorKind,
): Promise<GateResult> {
  const g = validateSelectorGrammar(selector);
  if (!g.ok) return { ok: false, reason: `grammar: ${g.reason}` };
  let locator: Locator;
  try {
    locator = page.locator(g.selector);
    const total = await locator.count();
    if (total === 0) return { ok: false, reason: "matches nothing" };
    if (total > MAX_MATCHES_INSPECTED) return { ok: false, reason: "matches too many elements" };
    const visible: Locator[] = [];
    for (let i = 0; i < total; i += 1) {
      const nth = locator.nth(i);
      if (await nth.isVisible().catch(() => false)) visible.push(nth);
    }
    if (visible.length !== 1) return { ok: false, reason: `matches ${visible.length} visible elements (need exactly 1)` };
    const target = visible[0] as Locator;
    if (!(await target.isEnabled().catch(() => false))) return { ok: false, reason: "element is disabled" };
    const facts = (await target.evaluate(readFacts).catch(() => [])) as string[];
    if (!facts.some((f) => containsAnyTerm(f, expectTerm))) {
      const shown = typeof expectTerm === "string" ? expectTerm : expectTerm.join('" / "');
      return { ok: false, reason: `element is not labelled "${shown}"` };
    }
    if (kind === "menuitem" && !(await target.evaluate(isInsideMenu).catch(() => false))) {
      return { ok: false, reason: "menu item is not inside an open menu" };
    }
    if (kind === "input" && !(await target.evaluate(isEditable).catch(() => false))) {
      return { ok: false, reason: "element is not an editable text control" };
    }
    return { ok: true, locator: target };
  } catch (e) {
    return { ok: false, reason: `lookup failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}` };
  }
}
