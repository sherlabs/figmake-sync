/**
 * Figma Make selector table as DATA. The built-in table lives in selectors.default.json (bundled into dist by tsc
 * because it is imported here). Layering at runtime, highest priority first:
 *   1. learned overrides written by the self-heal pipeline (heal/overrideStore.ts)
 *   2. optional <userData>/selectors.local.json hotfix (same schema, grammar-validated, prepended)
 *   3. the JSON defaults (config.adapter.selectorOverrides still replaces a key's defaults, as before)
 * The per-key metadata (goal, kind, healable, expectTerms) drives the auto-heal: a key is healable iff its metadata
 * says so; destructive keys can never be marked healable (schema refinement).
 */
import fs from "fs-extra";
import { z } from "zod";

import { validateSelectorGrammar } from "../heal/selectorGrammar.js";
import defaultsJson from "./selectors.default.json" with { type: "json" };

export const SELECTOR_KEYS = [
  "workspaceRoot",
  "codeModeButton",
  "codeEditorRoot",
  "fileTreeRoot",
  "treeRow",
  "persistenceStatus",
  "filesActionsMenuButton",
  "downloadButton",
  "downloadZipAction",
  "uploadInput",
  "uploadButton",
  "newFileButton",
  "createFileAction",
  "createFolderAction",
  "showHiddenFilesToggle",
  "newFileInput",
  "saveButton",
  "promptTextarea",
  "promptSendButton",
  "promptStopButton",
  "deleteAction",
  "renameAction",
  "deleteConfirmButton",
  "quickOpenInput",
] as const;

export type SelectorKey = (typeof SELECTOR_KEYS)[number];
export type SelectorMap = Record<SelectorKey, string[]>;

/**
 * click: press a button; menutrigger: press a button that opens a role=menu; menuitem: an item inside an opened menu;
 * input: an editable text control; indicator: only observed, never clicked; container/fileinput: anchors (never healed);
 * destructive: delete-like (never healed).
 */
export const SELECTOR_KINDS = ["container", "click", "menutrigger", "menuitem", "input", "fileinput", "indicator", "destructive"] as const;
export type SelectorKind = (typeof SELECTOR_KINDS)[number];
const HEALABLE_KINDS: ReadonlySet<SelectorKind> = new Set(["click", "menutrigger", "menuitem", "input", "indicator"]);

const selectorList = z.array(z.string().min(1).max(300)).min(1).max(60);

export const keySpecSchema = z
  .object({
    selectors: selectorList,
    goal: z.string().min(1).max(400),
    kind: z.enum(SELECTOR_KINDS),
    healable: z.boolean(),
    expectTerm: z.string().min(1).max(40).optional(),
    expectTerms: z.array(z.string().min(1).max(40)).min(1).max(8).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.healable) {
      if (!HEALABLE_KINDS.has(v.kind)) ctx.addIssue({ code: "custom", message: `kind "${v.kind}" can never be healable` });
      if (v.expectTerm === undefined && v.expectTerms === undefined) ctx.addIssue({ code: "custom", message: "healable key needs expectTerm(s)" });
    }
  });

export interface KeySpec {
  selectors: string[];
  goal: string;
  kind: SelectorKind;
  healable: boolean;
  /** Normalised: expectTerm and expectTerms merged (always at least one when healable). */
  expectTerms: string[];
}

export const selectorTableSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    keys: z.record(keySpecSchema),
  })
  .strict();

export type SelectorTable = Record<SelectorKey, KeySpec>;

/** Validates a raw table; throws on a missing/unknown key or any schema problem. */
export function parseSelectorTable(raw: unknown): SelectorTable {
  const parsed = selectorTableSchema.parse(raw);
  const out: Partial<SelectorTable> = {};
  for (const key of SELECTOR_KEYS) {
    const spec = parsed.keys[key];
    if (!spec) throw new Error(`selector table is missing key "${key}"`);
    const terms = [...(spec.expectTerm ? [spec.expectTerm] : []), ...(spec.expectTerms ?? [])];
    out[key] = { selectors: spec.selectors, goal: spec.goal, kind: spec.kind, healable: spec.healable, expectTerms: [...new Set(terms)] };
  }
  for (const key of Object.keys(parsed.keys)) {
    if (!(SELECTOR_KEYS as readonly string[]).includes(key)) throw new Error(`selector table has unknown key "${key}"`);
  }
  return out as SelectorTable;
}

export const DEFAULT_SELECTOR_TABLE: SelectorTable = parseSelectorTable(defaultsJson);

export function selectorMapOf(table: SelectorTable): SelectorMap {
  const out = {} as SelectorMap;
  for (const key of SELECTOR_KEYS) out[key] = [...table[key].selectors];
  return out;
}

export const MAX_LOCAL_SELECTORS_PER_KEY = 10;
export type LocalSelectors = Partial<Record<SelectorKey, string[]>>;

const localSchema = z.object({
  version: z.literal(1),
  /** Same shape as the default table; only `selectors` is honoured (metadata, healability and kinds are NOT overridable). */
  keys: z.record(z.object({ selectors: z.array(z.string()).max(100) }).passthrough()),
});

/**
 * Parses a selectors.local.json payload. Every selector must pass the same grammar as AI proposals; invalid
 * selectors, unknown keys and malformed files are dropped silently (never throws).
 */
export function parseLocalSelectors(raw: unknown): LocalSelectors {
  const parsed = localSchema.safeParse(raw);
  if (!parsed.success) return {};
  const out: LocalSelectors = {};
  for (const [key, entry] of Object.entries(parsed.data.keys)) {
    if (!(SELECTOR_KEYS as readonly string[]).includes(key)) continue;
    const ok: string[] = [];
    for (const s of entry.selectors) {
      const g = validateSelectorGrammar(s);
      if (g.ok && !ok.includes(g.selector)) ok.push(g.selector);
      if (ok.length >= MAX_LOCAL_SELECTORS_PER_KEY) break;
    }
    if (ok.length > 0) out[key as SelectorKey] = ok;
  }
  return out;
}

export async function loadLocalSelectors(filePath: string | undefined): Promise<LocalSelectors> {
  if (!filePath) return {};
  try {
    return parseLocalSelectors(await fs.readJson(filePath));
  } catch {
    return {};
  }
}

/** Local hotfix selectors go first, then the base list (deduplicated). */
export function layerSelectors(base: readonly string[], local: readonly string[] | undefined): string[] {
  if (!local || local.length === 0) return [...base];
  return [...local, ...base.filter((s) => !local.includes(s))];
}
