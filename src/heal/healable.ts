import { DEFAULT_SELECTOR_TABLE, SELECTOR_KEYS, type SelectorKind } from "../figma/selectors.js";

/**
 * Keys the app may try to heal, DERIVED from the per-key metadata in figma/selectors.default.json (healable: true).
 * Only "find this control" keys with an expected term and a post-condition the adapter can verify. Destructive
 * keys (delete, confirm-delete) and anchors (containers, hidden file inputs) are never healable by schema.
 */
export interface HealableSpec {
  goal: string;
  /** First expected term (kept for older callers). */
  expectTerm: string;
  /** The matched element's accessible name / label / tooltip / value must contain one of these as a whole word. */
  expectTerms: readonly string[];
  kind: SelectorKind;
}

export const HEALABLE: Readonly<Record<string, HealableSpec>> = Object.fromEntries(
  SELECTOR_KEYS.flatMap((key) => {
    const spec = DEFAULT_SELECTOR_TABLE[key];
    if (!spec.healable || spec.expectTerms.length === 0) return [];
    return [[key, { goal: spec.goal, expectTerm: spec.expectTerms[0] as string, expectTerms: spec.expectTerms, kind: spec.kind }]];
  }),
);

export function isHealable(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(HEALABLE, key);
}

/** Case-insensitive whole-word match ("Code view" yes; "Encode", "Decoder", "Codebase" no). */
export function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(haystack);
}

export function containsAnyTerm(haystack: string, terms: string | readonly string[]): boolean {
  return (typeof terms === "string" ? [terms] : terms).some((t) => containsTerm(haystack, t));
}
