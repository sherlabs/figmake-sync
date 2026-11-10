import { createHash } from "node:crypto";
import path from "node:path";

import fs from "fs-extra";
import type { Locator, Request } from "playwright";
import type { Logger } from "pino";

import {
  BrowserSessionManager,
  type AuthenticateBrowserSessionOptions,
  type PersistentBrowserHandle,
} from "../browser/session.js";
import type { ProjectStatePaths } from "../core/state.js";
import type { ProjectConfig } from "../types/config.js";
import { HealSession } from "../heal/heal.js";
import type { HealContext } from "../heal/types.js";
import { withRetry } from "../utils/retry.js";
import {
  DEFAULT_SELECTOR_TABLE,
  layerSelectors,
  loadLocalSelectors,
  selectorMapOf,
  type LocalSelectors,
  type SelectorKey,
  type SelectorMap,
} from "./selectors.js";

export interface AdapterContext {
  config: ProjectConfig;
  logger: Logger;
  paths: ProjectStatePaths;
  /** Optional silent self-healing (learned selector overrides + AI-assisted repair). Absent => legacy behaviour. */
  heal?: HealContext;
}

export interface DownloadResult {
  zipPath: string;
  suggestedFileName: string;
}

export interface UploadResult {
  uploaded: string[];
  unresolved: Array<{
    path: string;
    reason: string;
  }>;
}

export interface DeleteResult {
  path: string;
  status: "deleted" | "unsupported" | "failed";
  reason?: string;
  /** Stable code for a failure (e.g. EXPLORER_MISMATCH when the row was never seen). */
  code?: string;
}

export interface ReplaceOptions {
  /** The normalised hash the editor must show before anything is written (the zip's `normalizedHash`). */
  expectedNormalizedHash?: string;
}

/** "unchanged": the editor already held the desired content, nothing was written (idempotent re-run). */
export interface WriteOutcome {
  status: "written" | "unchanged";
}

export interface OpenProjectOptions {
  /** Aborting closes the browser and rejects in-flight waits with AutomationAbortedError. */
  signal?: AbortSignal;
}

export interface FigmaMakeProjectSession {
  downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult>;
  /** Per-file transaction: open, precondition, write, strict read-back, settle. Resolves void for older fakes. */
  replaceFileContents(relativePath: string, content: string, options?: ReplaceOptions): Promise<WriteOutcome | void>;
  upsertFile(relativePath: string, content: string): Promise<void>;
  /** Reads the explorer once (expanding the folders `paths` need) so a push can be planned before any write. */
  indexExplorer?(paths: string[]): Promise<ExplorerSnapshot>;
  /** Creates a file that the explorer does not show yet (its parent folder must exist) and writes `content` into it. */
  createFile?(relativePath: string, content: string): Promise<WriteOutcome>;
  /** Creates a folder whose parent exists. */
  createFolder?(relativePath: string): Promise<void>;
  commitPendingChanges(): Promise<void>;
  uploadFiles(absolutePaths: string[], rootDir: string): Promise<UploadResult>;
  deletePath(relativePath: string): Promise<DeleteResult>;
  /** Resolves true once the prompt was accepted and generation finished; throws otherwise. */
  submitPrompt(message: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface FigmaMakeAdapter {
  readonly kind: string;
  authenticate(
    url: string,
    options?: AuthenticateBrowserSessionOptions,
  ): Promise<void>;
  openProject(
    url: string,
    options?: OpenProjectOptions,
  ): Promise<FigmaMakeProjectSession>;
}

export type AdapterFactory = (context: AdapterContext) => FigmaMakeAdapter;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class FigmaAutomationError extends Error {
  readonly code: string = "AUTOMATION_ERROR";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Session expired / login page shown. Not retryable; the user must re-authenticate. */
export class AuthRequiredError extends FigmaAutomationError {
  override readonly code = "AUTH_REQUIRED";
}

/** Project is 404 / forbidden / rate limited / unavailable. */
export class ProjectUnavailableError extends FigmaAutomationError {
  override readonly code = "PROJECT_UNAVAILABLE";

  constructor(
    readonly reason: "not-found" | "forbidden" | "rate-limited" | "unavailable",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class SelectorNotFoundError extends FigmaAutomationError {
  override readonly code = "SELECTOR_NOT_FOUND";

  constructor(
    readonly key: string,
    readonly selectors: readonly string[],
  ) {
    super(
      `Unable to resolve Figma Make selector "${key}" using: ${selectors.join(", ")}`,
    );
  }
}

/** The workspace loaded but expected controls are missing: the Figma UI probably changed. */
export class UiChangedError extends FigmaAutomationError {
  override readonly code = "UI_CHANGED";
}

export class FileNotFoundInTreeError extends FigmaAutomationError {
  override readonly code = "FILE_NOT_FOUND";

  constructor(readonly relativePath: string) {
    super(`File ${relativePath} was not found in the Figma Make file explorer.`);
  }
}

export class WrongFileError extends FigmaAutomationError {
  override readonly code = "WRONG_FILE";
}

export class AutomationTimeoutError extends FigmaAutomationError {
  override readonly code = "TIMEOUT";
}

export class AutomationAbortedError extends FigmaAutomationError {
  override readonly code = "ABORTED";

  constructor(message = "Operation cancelled.") {
    super(message);
  }
}

/** The zip (or caller) says a path exists but the explorer index has no row for it, or the other way round. Never a reason to guess. */
export class ExplorerMismatchError extends FigmaAutomationError {
  override readonly code = "EXPLORER_MISMATCH";

  constructor(
    readonly relativePath: string,
    detail = "is not in Figma's file list",
  ) {
    super(`Figma's file list looks different from what we expected: ${relativePath} ${detail}.`);
  }
}

/** The virtualised tree could not be read completely (gap, posinset/setsize disagreement). */
export class TreeIndexIncompleteError extends FigmaAutomationError {
  override readonly code = "TREE_INDEX_INCOMPLETE";
}

/** Two rows with the same name in one folder: the path cannot be addressed safely. */
export class AmbiguousRemotePathError extends FigmaAutomationError {
  override readonly code = "AMBIGUOUS_REMOTE_PATH";

  constructor(readonly relativePath: string) {
    super(`Figma has two entries called ${relativePath}. Fix that in Figma first.`);
  }
}

/** The editor showed different content than the freshly downloaded zip: wrong file, or edited in Figma meanwhile. */
export class FileChangedInFigmaError extends FigmaAutomationError {
  override readonly code = "WRONG_FILE_OR_CHANGED";

  constructor(readonly relativePath: string) {
    super(`${relativePath} changed in Figma while sending. Stopped before changing it.`);
  }
}

/** The editor never showed the written content. */
export class WriteNotVerifiedError extends FigmaAutomationError {
  override readonly code = "WRITE_NOT_VERIFIED";

  constructor(readonly relativePath: string, detail: string) {
    super(`${relativePath} didn't take in Figma's editor (${detail}).`);
  }
}

/** Figma created a default-named entry and would not rename it. The user must delete it by hand. */
export class LeftoverFileError extends FigmaAutomationError {
  override readonly code = "LEFTOVER_FILE";

  constructor(
    readonly folder: string,
    readonly leftover: string,
  ) {
    super(`Figma created '${leftover}' in ${folder || "the top level"} but wouldn't rename it. Delete that file in Figma, then send again.`);
  }
}

function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof AuthRequiredError ||
    error instanceof ProjectUnavailableError ||
    error instanceof AutomationAbortedError ||
    error instanceof WrongFileError ||
    error instanceof FileChangedInFigmaError ||
    error instanceof ExplorerMismatchError ||
    error instanceof AmbiguousRemotePathError ||
    error instanceof LeftoverFileError
  );
}

// ---------------------------------------------------------------------------
// Page-state classification (login / error pages)
// ---------------------------------------------------------------------------

export type PageStateKind =
  | "auth"
  | "not-found"
  | "forbidden"
  | "rate-limited"
  | "unavailable";

export interface PageState {
  kind: PageStateKind;
  detail: string;
}

export function classifyPageState(input: {
  url: string;
  text: string;
  hasPasswordInput: boolean;
  /** Figma's guest sign-up prompt is on the page (a signed-out visitor can view a shared file but has no Code tab). */
  hasGuestPrompt?: boolean;
}): PageState | null {
  let host = "";
  let pathname = "";

  try {
    const parsed = new URL(input.url);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    // Unparseable URL: rely on page text only.
  }

  if (
    /^\/(login|signup|sso|oauth|saml|auth)(\/|$)/i.test(pathname) ||
    /^accounts\./i.test(host)
  ) {
    return { kind: "auth", detail: `redirected to ${host}${pathname}` };
  }

  const text = input.text;

  if (
    input.hasPasswordInput ||
    input.hasGuestPrompt === true ||
    /\b(log ?in|sign ?in) to (your )?figma\b|\blog in or sign up\b|\bcontinue with (google|sso)\b|\bsign up to use\b/i.test(
      text,
    )
  ) {
    return { kind: "auth", detail: "login form detected" };
  }

  if (
    /request access|you (don'?t|do not) have (access|permission)|no access to this/i.test(
      text,
    )
  ) {
    return { kind: "forbidden", detail: "access denied page detected" };
  }

  if (
    /\b404\b|page not found|file not found|we couldn'?t find|doesn'?t exist/i.test(
      text,
    )
  ) {
    return { kind: "not-found", detail: "not-found page detected" };
  }

  if (/too many requests|rate limit|\b429\b/i.test(text)) {
    return { kind: "rate-limited", detail: "rate-limit page detected" };
  }

  if (
    /temporarily unavailable|under maintenance|scheduled maintenance|service unavailable|something went wrong/i.test(
      text,
    )
  ) {
    return { kind: "unavailable", detail: "error/maintenance page detected" };
  }

  return null;
}

function errorFromPageState(state: PageState, cause?: unknown): Error {
  if (state.kind === "auth") {
    return new AuthRequiredError(
      `Figma session is not authenticated (${state.detail}). Re-authenticate and retry.`,
      { cause },
    );
  }

  return new ProjectUnavailableError(
    state.kind,
    `Figma Make project is unavailable: ${state.kind} (${state.detail}).`,
    { cause },
  );
}

// ---------------------------------------------------------------------------
// File-tree resolution (pure logic + in-page extraction)
// ---------------------------------------------------------------------------

export interface TreeRow {
  label: string;
  kind: "file" | "folder";
  depth: number;
  expanded: boolean | null;
  active: boolean;
  activeSupported: boolean;
}

export interface TreeQueryArgs {
  segments: string[];
  kind: "file" | "folder" | "any";
  /** Require the last segment (when a folder) to be expanded. */
  expandLast: boolean;
  /** Also return the direct children of the resolved folder. */
  list: boolean;
  /** Segment positions that were clicked already and must not be expanded again. */
  assumeExpandedAt: number[];
  /**
   * The tree is a virtualised list: after scrolling, the ancestor rows may be gone from the page.
   * Continue the chain at segment `at`, searching the subtree of an ancestor seen earlier at `parentDepth`.
   */
  resume?: { at: number; parentDepth: number; childDepth: number } | undefined;
}

export type TreeQueryResult =
  | {
      status: "found";
      index: number;
      active: boolean;
      activeSupported: boolean;
      matchCount: number;
      children: string[];
    }
  | { status: "expand"; index: number; at: number }
  | { status: "missing"; at: number; parentDepth?: number; childDepth?: number };

/**
 * Resolves a path segment by segment over a flat, document-ordered row list.
 * Each segment is looked up only among the direct children of the previously
 * resolved folder, so same-named files in other folders never match.
 *
 * Serialised with toString() and run in the page: no closures, no nested functions.
 */
export function resolveTreeChain(
  rows: TreeRow[],
  args: TreeQueryArgs,
): TreeQueryResult {
  const segs = args.segments;
  let minDepth = Infinity;

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.depth < minDepth) {
      minDepth = rows[i]!.depth;
    }
  }

  if (segs.length === 0) {
    const rootChildren: string[] = [];

    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i]!.depth === minDepth) {
        rootChildren.push(rows[i]!.label);
      }
    }

    return {
      status: "found",
      index: -1,
      active: false,
      activeSupported: false,
      matchCount: 1,
      children: rootChildren,
    };
  }

  let parentIdx = -1;
  let parentDepth = -1;
  let startK = 0;

  if (args.resume) {
    startK = args.resume.at;
    parentDepth = args.resume.parentDepth;
  }

  let step = Infinity;

  for (let i = 1; i < rows.length; i += 1) {
    const gap = Math.abs(rows[i]!.depth - rows[i - 1]!.depth);

    if (gap > 0 && gap < step) {
      step = gap;
    }
  }

  if (step === Infinity) {
    step = 1;
  }

  for (let k = startK; k < segs.length; k += 1) {
    const isLast = k === segs.length - 1;
    const wantKind = isLast ? args.kind : "folder";
    const resuming = k === startK && args.resume !== undefined;
    let found = -1;
    let count = 0;
    let inSub = false;
    let childDepth: number | null = resuming ? args.resume!.childDepth : null;

    for (let i = parentIdx + 1; i < rows.length; i += 1) {
      const row = rows[i]!;

      if (k === 0) {
        if (row.depth !== minDepth) {
          continue;
        }
      } else {
        if (row.depth <= parentDepth) {
          if (resuming && !inSub) {
            continue;
          }

          break;
        }

        inSub = true;

        if (childDepth === null) {
          childDepth = row.depth;
        }

        if (row.depth !== childDepth) {
          continue;
        }
      }

      if (row.label !== segs[k]) {
        continue;
      }

      if (wantKind !== "any" && row.kind !== wantKind) {
        continue;
      }

      count += 1;

      if (found < 0) {
        found = i;
      }
    }

    if (found < 0) {
      return k > 0
        ? { status: "missing", at: k, parentDepth, childDepth: childDepth ?? parentDepth + step }
        : { status: "missing", at: k };
    }

    const row = rows[found]!;
    const mustExpand =
      row.kind === "folder" && (!isLast || args.expandLast || args.list);

    if (mustExpand && !args.assumeExpandedAt.includes(k)) {
      const next = rows[found + 1];
      const expanded =
        row.expanded !== null
          ? row.expanded
          : next !== undefined && next.depth > row.depth;

      if (!expanded) {
        return { status: "expand", index: found, at: k };
      }
    }

    if (isLast) {
      const children: string[] = [];

      if (args.list) {
        let directDepth: number | null = null;

        for (
          let i = found + 1;
          i < rows.length && rows[i]!.depth > row.depth;
          i += 1
        ) {
          if (directDepth === null) {
            directDepth = rows[i]!.depth;
          }

          if (rows[i]!.depth === directDepth) {
            children.push(rows[i]!.label);
          }
        }
      }

      return {
        status: "found",
        index: found,
        active: row.active,
        activeSupported: row.activeSupported,
        matchCount: count,
        children,
      };
    }

    parentIdx = found;
    parentDepth = row.depth;
  }

  return { status: "missing", at: segs.length };
}

/**
 * Extracts tree rows in document order. Runs in the page. Indentation is derived
 * from the first metric that actually varies across rows: wrapper nesting, then
 * button box offset, then label text offset.
 */
export function extractTreeRows(root: Element): {
  rows: TreeRow[];
  els: Element[];
} {
  const fileSel = 'button[data-testid="code-file-item"]';
  const folderSel = '[data-folder-item="true"]';
  const set = new Set<Element>(Array.from(root.querySelectorAll(fileSel)));

  root.querySelectorAll(folderSel).forEach((wrapper) => {
    const header = wrapper.querySelector("button");

    if (header) {
      set.add(header);
    }
  });

  const els = Array.from(set).sort((a, b) =>
    a.compareDocumentPosition(b) & 4 ? -1 : 1,
  );
  const nest: number[] = [];
  const box: number[] = [];
  const txt: number[] = [];
  const ico: number[] = [];

  const partial = els.map((el) => {
    let nesting = 0;
    let wrapper = el.parentElement;

    while (wrapper && wrapper !== root) {
      if (wrapper.matches(folderSel)) {
        nesting += 1;
      }

      wrapper = wrapper.parentElement;
    }

    const own = el.closest(folderSel);

    if (own && own.querySelector("button") === el) {
      nesting -= 1;
    }

    const rect = el.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let textLeft = rect.left + pad;

    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.textContent ?? "").trim()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        textLeft = range.getBoundingClientRect().left;
        break;
      }
    }

    // Current Figma markup: rows are a flat virtualised list, the label is only in aria-label (no text node),
    // and the indent is the position of the first icon (chevron or file icon), 16px per level.
    const icon = el.querySelector("span, svg");
    ico.push(icon ? icon.getBoundingClientRect().left : textLeft);

    nest.push(nesting);
    box.push(rect.left + pad);
    txt.push(textLeft);

    const aria = el.getAttribute("aria-label") ?? "";
    const match = aria.match(/^(?:File|Folder) "([\s\S]*)"$/);
    const isFile = el.matches(fileSel);
    const expandedAttr =
      el.getAttribute("aria-expanded") ??
      el.closest("[aria-expanded]")?.getAttribute("aria-expanded") ??
      null;

    let active = false;
    let activeSupported = false;
    let probe: Element | null = el;

    for (let up = 0; probe && up < 3; up += 1) {
      const attrs = [
        probe.getAttribute("aria-selected"),
        probe.getAttribute("aria-current"),
        probe.getAttribute("data-selected"),
        probe.getAttribute("data-active"),
      ];

      for (const value of attrs) {
        if (value !== null) {
          activeSupported = true;

          if (value !== "false" && value !== "") {
            active = true;
          }
        }
      }

      const state = probe.getAttribute("data-state");

      if (state !== null) {
        if (/^(active|selected|on)$/.test(state)) {
          active = true;
        }
      }

      if (/(^|[-_\s])(selected|active)([-_\s]|$)/i.test(String(probe.className))) {
        active = true;
      }

      probe = probe.parentElement;
    }

    return {
      label: match ? (match[1] ?? "") : (el.textContent ?? "").trim(),
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      kind: (isFile ? "file" : "folder") as "file" | "folder",
      expanded: isFile || expandedAttr === null ? null : expandedAttr === "true",
      active,
      activeSupported,
    };
  });

  const useNest = new Set(nest).size > 1;
  const usePx = new Set(box.map((v) => Math.round(v / 2))).size > 1;
  const useIco = new Set(ico.map((v) => Math.round(v / 2))).size > 1;
  const rows = partial.map((row, i) => ({
    ...row,
    depth: useNest
      ? nest[i]!
      : usePx
        ? Math.round(box[i]! / 2)
        : useIco
          ? Math.round(ico[i]! / 2)
          : Math.round(txt[i]! / 2),
  }));

  return { rows, els };
}

const TREE_QUERY_SCRIPT = `(root, args) => {
  const out = (${extractTreeRows.toString()})(root);
  const result = (${resolveTreeChain.toString()})(out.rows, args);
  document.querySelectorAll('[data-fm-target]').forEach((e) => e.removeAttribute('data-fm-target'));
  if ((result.status === 'found' || result.status === 'expand') && result.index >= 0) {
    out.els[result.index].setAttribute('data-fm-target', '1');
  }
  return result;
}`;

/**
 * Runs a function-source string in the page against `root` and returns its (awaited) result.
 * Playwright no longer invokes a function written as a string (it returns undefined), so the
 * element is tagged, the source is called explicitly, and the tag is removed again.
 */
export async function runPageScript<T>(root: Locator, script: string, arg: unknown): Promise<T> {
  await root.evaluate((el) => el.setAttribute("data-fm-root", "1"));
  try {
    return (await root
      .page()
      .evaluate(`(${script})(document.querySelector('[data-fm-root]'), ${JSON.stringify(arg ?? null)})`)) as T;
  } finally {
    await root.evaluate((el) => el.removeAttribute("data-fm-root")).catch(() => undefined);
  }
}

const TREE_SCROLL_SCRIPT = `async (root, args) => {
  const first = root.querySelector('button[data-testid="code-file-item"], [data-folder-item="true"] button');
  let sc = first ? first.parentElement : null;
  while (sc && sc !== document.body) {
    const o = getComputedStyle(sc).overflowY;
    if ((o === 'auto' || o === 'scroll' || o === 'overlay') && sc.scrollHeight > sc.clientHeight + 1) break;
    sc = sc.parentElement;
  }
  if (!sc || sc === document.body) return { done: true, original: 0 };
  if (args.bottom) { sc.scrollTop = sc.scrollHeight; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { done: true, original: 0 }; }
  if (args.restore !== undefined) { sc.scrollTop = args.restore; return { done: true, original: 0 }; }
  const original = sc.scrollTop;
  const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
  const stepSize = Math.max(160, Math.floor(sc.clientHeight * 0.8));
  const top = args.step * stepSize;
  if (args.step > 0 && top - stepSize >= max) return { done: true, original };
  sc.scrollTop = Math.min(top, max);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { done: false, original };
}`;

const TARGET_SELECTOR = '[data-fm-target="1"]';

// ---------------------------------------------------------------------------
// Aria-based explorer index (current Figma Make UI: a flat virtualised role="tree")
// ---------------------------------------------------------------------------

/** One rendered `role="treeitem"` row, as read from the page. Depth comes from aria-level only. */
export interface AriaRow {
  label: string;
  level: number;
  /** -1 when the attribute is absent. */
  posinset: number;
  setsize: number;
  /** Pixel offset of the row inside the tree container (row identity across scroll windows). */
  top: number;
  kind: "file" | "folder";
  expanded: boolean | null;
  selected: boolean;
}

export interface IndexedRow extends AriaRow {
  path: string;
  parentPath: string;
}

export interface ExplorerIndex {
  rows: IndexedRow[];
  byPath: Map<string, IndexedRow>;
  rowHeight: number;
  /** Paths that appear more than once in one folder (never safe to click). */
  duplicates: string[];
  /** Whether any row exposes a selection signal (aria-selected / data-state). */
  selectionSupported: boolean;
}

/** What `indexExplorer` hands back to callers outside the adapter (serialisable; the service classifies with it). */
export interface ExplorerSnapshot {
  /** False for an older, non-virtualised explorer without `role="treeitem"` rows (row existence is then unknown). */
  supported: boolean;
  /** Every indexed path -> kind. Folders that were not required may be collapsed, so their children are absent. */
  entries: Record<string, "file" | "folder">;
  duplicates: string[];
  /** "on" = hidden files are shown, "off" = not shown, "unavailable" = the explorer has no such toggle. */
  hiddenFiles: "on" | "off" | "unavailable";
}

/** Names the explorer hides unless "Show hidden files" is on (besides dot-files). */
export const KNOWN_HIDDEN_NAMES: ReadonlySet<string> = new Set(["pnpm-lock.yaml"]);

export function looksHidden(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith(".") || KNOWN_HIDDEN_NAMES.has(segment));
}

/**
 * Rebuilds paths from a complete, top-sorted list of aria rows and proves completeness: contiguous tops, every level
 * reachable through a parent, and for the root and every expanded folder `posinset` covering exactly `1..setsize`.
 * Throws TreeIndexIncompleteError when any proof fails (callers retry the pass once).
 */
export function reconstructTree(input: AriaRow[], rowHeight: number): ExplorerIndex {
  const rows = [...input].sort((a, b) => a.top - b.top);
  const fail = (why: string): never => {
    throw new TreeIndexIncompleteError(`The file list could not be read completely (${why}).`);
  };

  if (rowHeight <= 0) fail("row height unknown");

  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i]!.top - rows[i - 1]!.top;

    if (Math.abs(gap - rowHeight) > 1.5) fail(`gap of ${gap}px after "${rows[i - 1]!.label}"`);
  }

  const stack: IndexedRow[] = [];
  const indexed: IndexedRow[] = [];
  const children = new Map<string, IndexedRow[]>();

  for (const row of rows) {
    if (!Number.isInteger(row.level) || row.level < 1) fail(`row "${row.label}" has no aria-level`);

    while (stack.length >= row.level) stack.pop();

    if (stack.length !== row.level - 1) fail(`row "${row.label}" at level ${row.level} has no parent`);

    const parent = stack[stack.length - 1];

    if (parent && parent.kind !== "folder") fail(`row "${row.label}" sits under the file "${parent.label}"`);

    const parentPath = parent ? parent.path : "";
    const entry: IndexedRow = { ...row, parentPath, path: parentPath ? `${parentPath}/${row.label}` : row.label };

    indexed.push(entry);
    (children.get(parentPath) ?? children.set(parentPath, []).get(parentPath)!).push(entry);

    if (row.kind === "folder") stack.push(entry);
  }

  for (const [parentPath, list] of children) {
    const sizes = new Set(list.map((row) => row.setsize));

    if (sizes.has(-1)) continue; // older markup without posinset/setsize: contiguity is all we can prove

    if (sizes.size !== 1) fail(`children of "${parentPath || "the top level"}" disagree on aria-setsize`);

    const setsize = list[0]!.setsize;
    const positions = new Set(list.map((row) => row.posinset));

    if (list.length !== setsize || positions.size !== setsize || [...positions].some((p) => p < 1 || p > setsize)) {
      fail(`"${parentPath || "the top level"}" shows ${list.length} of ${setsize} entries`);
    }
  }

  const byPath = new Map<string, IndexedRow>();
  const duplicates = new Set<string>();

  for (const entry of indexed) {
    if (byPath.has(entry.path)) duplicates.add(entry.path);
    else byPath.set(entry.path, entry);
  }

  return {
    rows: indexed,
    byPath,
    rowHeight,
    duplicates: [...duplicates].sort(),
    selectionSupported: indexed.some((row) => row.selected),
  };
}

/**
 * Finds the scrolling ancestor of the rows. Starts from a row (not from `root`): the resolved tree root may be a large
 * ancestor above the scroller (the zero-height live container is skipped by visibility checks), and the live
 * `role="tree"` box itself is overflow: visible.
 */
const SCROLLER_FINDER = `(root) => {
  const anchor = root.querySelector('[role="treeitem"], button[data-testid="code-file-item"], [data-folder-item="true"]');
  let sc = anchor ? anchor.parentElement : root;
  while (sc && sc !== document.body) {
    const o = getComputedStyle(sc).overflowY;
    if ((o === 'auto' || o === 'scroll' || o === 'overlay') && sc.scrollHeight > sc.clientHeight + 1) return sc;
    sc = sc.parentElement;
  }
  return null;
}`;

/**
 * Reads every mounted treeitem (optionally after scrolling the scroller to `args.scrollTo`), with the scroller's metrics.
 * Depth, order and identity come from aria-level / aria-posinset / aria-setsize / aria-label / the row's offset.
 */
const TREE_READ_SCRIPT = `async (root, args) => {
  const findScroller = ${SCROLLER_FINDER};
  const sc = findScroller(root);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const mountedTops = () => Array.from(root.querySelectorAll('[role="treeitem"][aria-level]')).map((el) => parseFloat(el.style.top)).filter((t) => Number.isFinite(t));
  if (sc && typeof args.scrollTo === 'number') {
    sc.scrollTop = args.scrollTo;
    await frame();
    await frame();
    // The virtualiser renders on its own schedule: wait (bounded) until a row of the new window is mounted.
    const want = sc.scrollTop;
    for (let i = 0; i < 30; i += 1) {
      const tops = mountedTops();
      if (tops.length === 0 || tops.some((t) => t >= want - 1 && t <= want + sc.clientHeight)) break;
      await frame();
    }
  }
  const rootRect = root.getBoundingClientRect();
  const items = Array.from(root.querySelectorAll('[role="treeitem"][aria-level]'));
  const num = (v) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : -1; };
  const rows = items.map((el) => {
    const rect = el.getBoundingClientRect();
    const styleTop = parseFloat(el.style.top);
    const button = el.querySelector('button');
    const aria = (button && button.getAttribute('aria-label')) || '';
    const isFolder = el.hasAttribute('aria-expanded') || Boolean(el.querySelector('[data-folder-item="true"]')) || /^Folder\\b/.test(aria);
    const expandedAttr = el.getAttribute('aria-expanded') ?? (button ? button.getAttribute('aria-expanded') : null);
    let selected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true';
    for (const probe of [el, button]) {
      if (!probe) continue;
      for (const attr of ['data-selected', 'data-active']) {
        const v = probe.getAttribute(attr);
        if (v !== null && v !== 'false' && v !== '') selected = true;
      }
      const st = probe.getAttribute('data-state');
      if (st !== null && /^(active|selected|on)$/.test(st)) selected = true;
    }
    const m = aria.match(/^(?:File|Folder) "([\\s\\S]*)"$/);
    return {
      label: el.getAttribute('aria-label') ?? (m ? m[1] : ''),
      level: num(el.getAttribute('aria-level')),
      posinset: num(el.getAttribute('aria-posinset')),
      setsize: num(el.getAttribute('aria-setsize')),
      top: Number.isFinite(styleTop) ? styleTop : Math.round(rect.top - rootRect.top),
      height: rect.height,
      kind: isFolder ? 'folder' : 'file',
      expanded: isFolder ? expandedAttr === 'true' : null,
      selected,
    };
  });
  const legacyButtons = root.querySelectorAll('button[data-testid="code-file-item"], [data-folder-item="true"] button').length;
  return {
    rows,
    legacyButtons,
    treeHeight: root.getBoundingClientRect().height,
    scroller: sc ? { scrollTop: sc.scrollTop, clientHeight: sc.clientHeight, scrollHeight: sc.scrollHeight } : null,
  };
}`;

/**
 * Scrolls so the row at `args.top` is inside the viewport, re-reads it and tags the matching treeitem (same level, label
 * and top) with data-fm-target. Returns what it saw so the caller can assert identity before clicking.
 */
const TREE_TAG_SCRIPT = `async (root, args) => {
  const findScroller = ${SCROLLER_FINDER};
  const sc = findScroller(root);
  document.querySelectorAll('[data-fm-target]').forEach((e) => e.removeAttribute('data-fm-target'));
  if (sc) {
    const want = Math.max(0, Math.min(args.top - Math.floor(sc.clientHeight / 2), sc.scrollHeight - sc.clientHeight));
    if (Math.abs(sc.scrollTop - want) > 1) {
      sc.scrollTop = want;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }
  const rootRect = root.getBoundingClientRect();
  for (const el of root.querySelectorAll('[role="treeitem"][aria-level]')) {
    const styleTop = parseFloat(el.style.top);
    const top = Number.isFinite(styleTop) ? styleTop : Math.round(el.getBoundingClientRect().top - rootRect.top);
    if (Math.abs(top - args.top) > 1.5) continue;
    if (el.getAttribute('aria-label') !== args.label || parseInt(el.getAttribute('aria-level') ?? '', 10) !== args.level) {
      return { ok: false, label: el.getAttribute('aria-label'), level: el.getAttribute('aria-level') };
    }
    el.setAttribute('data-fm-target', '1');
    const button = el.querySelector('button');
    return {
      ok: true,
      selected: el.getAttribute('aria-selected') === 'true',
      expanded: (el.getAttribute('aria-expanded') ?? (button ? button.getAttribute('aria-expanded') : null)) === 'true',
    };
  }
  return { ok: false, label: null, level: null };
}`;

interface TreeReadResult {
  rows: Array<AriaRow & { height: number }>;
  legacyButtons: number;
  treeHeight: number;
  scroller: { scrollTop: number; clientHeight: number; scrollHeight: number } | null;
}

interface TreeTagResult {
  ok: boolean;
  selected?: boolean;
  expanded?: boolean;
  label?: string | null;
  level?: string | null;
}

/** Same transform as a manifest entry's `normalizedHash`: BOM stripped, CR/CRLF -> LF, sha256 of the UTF-8 bytes. */
export function normalizedTextHash(text: string): string {
  const stripped = text.startsWith("﻿") ? text.slice(1) : text;

  return createHash("sha256").update(Buffer.from(stripped.replaceAll(/\r\n?/g, "\n"), "utf8")).digest("hex");
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export type { SelectorKey, SelectorMap } from "./selectors.js";

// The Figma Make UI is not a stable public API. The selector table is DATA (selectors.default.json, validated and
// layered in selectors.ts); this export is derived from it for callers/tests that want the plain key -> selectors map.
export const DEFAULT_FIGMA_MAKE_SELECTORS: SelectorMap = selectorMapOf(DEFAULT_SELECTOR_TABLE);

const SELECT_ALL = "ControlOrMeta+A";
const SUBMIT_SHORTCUT = "ControlOrMeta+Enter";
const PROMPT_IDLE_TIMEOUT_MS = 120_000;
const PROMPT_COMPLETION_TIMEOUT_MS = 300_000;

function sanitizeFileName(fileName: string): string {
  return fileName.replaceAll(/[^\w.-]+/g, "-");
}

function splitPath(relativePath: string): string[] {
  return relativePath.split("/").filter(Boolean);
}

function normalizeEol(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

/** Every ancestor folder of the given paths, parents before children, each once. */
export function requiredFolders(paths: readonly string[]): string[] {
  const out = new Set<string>();

  for (const relativePath of paths) {
    const segments = splitPath(relativePath);

    for (let depth = 1; depth < segments.length; depth += 1) {
      out.add(segments.slice(0, depth).join("/"));
    }
  }

  return [...out].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function deriveDefaultNewFileName(expectedLeaf: string): string {
  const extension = path.posix.extname(expectedLeaf);

  return extension ? `new-file${extension}` : "new-file";
}

async function isEditableCodeEditorRoot(locator: Locator): Promise<boolean> {
  const [contentEditable, role] = await Promise.all([
    locator.getAttribute("contenteditable").catch(() => null),
    locator.getAttribute("role").catch(() => null),
  ]);

  return contentEditable === "true" || role === "textbox";
}

async function tryReadCodeMirrorDocument(
  locator: Locator,
): Promise<string | null> {
  return locator.evaluate((node) => {
    const element = node as HTMLElement & {
      cmView?: {
        view?: {
          state?: {
            doc?: {
              toString?: () => string;
            };
          };
        };
      };
    };

    return element.cmView?.view?.state?.doc?.toString?.() ?? null;
  });
}

async function tryReplaceCodeMirrorDocument(
  locator: Locator,
  content: string,
): Promise<boolean> {
  return locator.evaluate((node, nextContent) => {
    const element = node as HTMLElement & {
      cmView?: {
        view?: {
          state?: {
            doc?: {
              length?: number;
            };
          };
          dispatch?: (transaction: {
            changes: {
              from: number;
              to: number;
              insert: string;
            };
          }) => void;
          focus?: () => void;
        };
      };
    };

    const view = element.cmView?.view;
    const docLength = view?.state?.doc?.length;

    if (
      typeof docLength !== "number" ||
      typeof view?.dispatch !== "function"
    ) {
      return false;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: docLength,
        insert: nextContent,
      },
    });
    view.focus?.();

    return true;
  }, content);
}

async function isVisible(
  locator: Locator,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    if ((await locator.count()) === 0) {
      return false;
    }

    return await locator.first().isVisible({ timeout: timeoutMs });
  } catch {
    return false;
  }
}

interface TreeHit {
  locator: Locator;
  active: boolean;
  activeSupported: boolean;
  matchCount: number;
}

interface LocateOptions {
  kind: "file" | "folder" | "any";
  /** Expand collapsed folders along the way (and the last one when it is a folder). */
  expand: boolean;
  /** Scroll through a virtualised tree when the item is not rendered. */
  scan: boolean;
  expandLast?: boolean;
}

/** @internal exported for tests */
export class PlaywrightFigmaMakeProjectSession implements FigmaMakeProjectSession {
  private readonly selectors: SelectorMap;
  private hasPendingEditorChanges = false;
  private activePath: string | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly healSession: HealSession | null;
  /** How long to wait for the Code toggle before treating the UI as changed (tests shorten it). */
  private codeModeWaitMs = 20_000;
  /** How long to wait for an autosave request to start after a write (tests shorten it). */
  private settleStartWindowMs = 2_000;
  /** Whether the explorer is the current flat virtualised role="tree" (null = not probed yet). */
  private ariaTree: boolean | null = null;
  /** The last complete explorer index; dropped after anything that changes rows. */
  private explorerIndex: ExplorerIndex | null = null;
  /** Hidden files are shown because this session switched them on (restored on close). */
  private hiddenFilesShown = false;
  private hiddenFilesToggledByUs = false;
  /** Folders clicked to expand already (an empty folder never reports children; clicking again would collapse it). */
  private readonly expandAttempted = new Set<string>();

  private readonly inflightMutations = new Set<Request>();
  private mutationSeq = 0;
  private settledSeq = 0;
  private lastMutationAt = 0;

  constructor(
    private readonly handle: PersistentBrowserHandle,
    private readonly context: AdapterContext,
    private readonly signal?: AbortSignal,
    localSelectors: LocalSelectors = {},
  ) {
    const base: SelectorMap = {
      ...DEFAULT_FIGMA_MAKE_SELECTORS,
      ...(context.config.adapter.selectorOverrides as Partial<SelectorMap>),
    };

    // Layer 2: the optional selectors.local.json hotfix goes in front of the JSON defaults.
    this.selectors = Object.fromEntries(
      Object.entries(base).map(([key, list]) => [key, layerSelectors(list, localSelectors[key as SelectorKey])]),
    ) as SelectorMap;

    this.healSession = context.heal ? new HealSession(context.heal) : null;

    const page = handle.page as Partial<typeof handle.page>;

    if (typeof page.on === "function") {
      const isMutation = (request: Request): boolean =>
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method());

      page.on("request", (request) => {
        if (isMutation(request)) {
          this.inflightMutations.add(request);
          this.mutationSeq += 1;
          this.lastMutationAt = Date.now();
        }
      });
      const done = (request: Request): void => {
        if (this.inflightMutations.delete(request)) {
          this.lastMutationAt = Date.now();
        }
      };
      page.on("requestfinished", done);
      page.on("requestfailed", done);
    }

    if (signal) {
      if (signal.aborted) {
        void this.closeOnce();
      } else {
        signal.addEventListener("abort", () => void this.closeOnce(), {
          once: true,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult> {
    return this.step("download-latest-code", async () => {
      await this.ensureCodeSurfaceReady();

      const downloadPromise = this.handle.page.waitForEvent("download", {
        timeout: this.context.config.adapter.downloadTimeoutMs,
      });
      // The click may fail before the download starts; do not leak the rejection.
      downloadPromise.catch(() => undefined);

      await this.triggerDownload(downloadPromise);

      const download = await this.raceAbort(downloadPromise);
      const suggestedFileName = sanitizeFileName(
        download.suggestedFilename() || "figmake-code.zip",
      );
      const zipPath = path.join(destinationDir, suggestedFileName);

      await fs.ensureDir(destinationDir);
      await download.saveAs(zipPath);

      return {
        zipPath,
        suggestedFileName,
      };
    });
  }

  /**
   * One file as a transaction: open it (by the aria index when the explorer exposes one), read the editor,
   * stop if it is not what the zip said (unless already the desired text), write, read back strictly, then wait for
   * Figma's autosave to settle. Nothing else is in flight while this runs.
   */
  async replaceFileContents(
    relativePath: string,
    content: string,
    options: ReplaceOptions = {},
  ): Promise<WriteOutcome> {
    return this.step(`replace-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();
      await this.openFile(relativePath);

      return this.writeOpenFile(relativePath, content, options);
    });
  }

  /** Precondition + write + strict read-back + settle for the file the editor shows now. */
  private async writeOpenFile(relativePath: string, content: string, options: ReplaceOptions): Promise<WriteOutcome> {
    const doc = await this.readActiveEditorContent();
    const docHash = normalizedTextHash(doc);

    if (docHash === normalizedTextHash(content)) {
      return { status: "unchanged" };
    }

    if (options.expectedNormalizedHash !== undefined && docHash !== options.expectedNormalizedHash) {
      throw new FileChangedInFigmaError(relativePath);
    }

    await this.writeEditorContent(content, { strict: true, relativePath });
    this.hasPendingEditorChanges = true;
    await this.settleOperation();

    return { status: "written" };
  }

  /** Waits for the autosave request of the last write to start and finish, then for the status indicator to rest. */
  private async settleOperation(): Promise<void> {
    await this.settleWrites(this.settleStartWindowMs);

    if ((await this.readPersistenceStatus()) !== null) {
      await this.waitPersistenceIdle(10_000);
    }

    this.hasPendingEditorChanges = false;
  }

  async indexExplorer(paths: string[]): Promise<ExplorerSnapshot> {
    return this.step("index-explorer", async () => {
      await this.ensureCodeSurfaceReady();

      if (!(await this.usesAriaTree())) {
        return { supported: false, entries: {}, duplicates: [], hiddenFiles: "unavailable" };
      }

      let index = await this.ensureIndex(paths);
      const missingHidden = paths.filter((p) => !index.byPath.has(p) && looksHidden(p));
      let hiddenFiles: ExplorerSnapshot["hiddenFiles"] = this.hiddenFilesShown ? "on" : "off";

      if (missingHidden.length > 0 && !this.hiddenFilesShown) {
        const toggled = await this.setHiddenFilesShown(true);

        if (toggled) {
          this.explorerIndex = null;
          index = await this.ensureIndex(paths);
          hiddenFiles = "on";
        } else {
          hiddenFiles = "unavailable";
        }
      }

      return {
        supported: true,
        entries: Object.fromEntries(index.rows.map((row) => [row.path, row.kind])),
        duplicates: index.duplicates,
        hiddenFiles,
      };
    });
  }

  async createFile(relativePath: string, content: string): Promise<WriteOutcome> {
    return this.step(`create-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      if (!(await this.usesAriaTree())) {
        await this.createFileLegacy(relativePath);
        await this.writeEditorContent(content, { strict: true, relativePath });
        this.hasPendingEditorChanges = true;
        await this.settleOperation();

        return { status: "written" };
      }

      await this.createEntry(relativePath, "file");
      await this.openFile(relativePath);

      const doc = await this.readActiveEditorContent();

      if (doc.length > 0) {
        this.context.logger.warn({ relativePath, length: doc.length }, "new file is not empty in the editor; overwriting");
      }

      return this.writeOpenFile(relativePath, content, {});
    });
  }

  async createFolder(relativePath: string): Promise<void> {
    await this.step(`mkdir-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      if (!(await this.usesAriaTree())) {
        throw new UiChangedError("Creating folders needs the current Figma Make explorer.");
      }

      await this.createEntry(relativePath, "folder");
    });
  }

  async upsertFile(relativePath: string, content: string): Promise<void> {
    await this.step(`upsert-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      // Only a definitive "not in the explorer" answer may lead to creation.
      // Anything else (timeouts, overlays, detached nodes) is retried and then rethrown.
      const exists = await withRetry(
        async () => {
          try {
            await this.openFile(relativePath);
            return true;
          } catch (error) {
            if (error instanceof FileNotFoundInTreeError) {
              return false;
            }

            throw error;
          }
        },
        {
          attempts: 2,
          baseDelayMs: 300,
          shouldRetry: (error) => !isNonRetryable(error),
        },
      );

      if (!exists) {
        if (await this.usesAriaTree()) {
          await this.createEntry(relativePath, "file");
          await this.openFile(relativePath);
        } else {
          await this.createFileLegacy(relativePath);
        }
      }

      await this.writeEditorContent(content, { relativePath });
      this.hasPendingEditorChanges = true;
      await this.settleWrites(0);
    });
  }

  async commitPendingChanges(): Promise<void> {
    if (!this.hasPendingEditorChanges) {
      return;
    }

    await this.step("commit-pending-editor-changes", async () => {
      await this.ensureCodeSurfaceReady();
      await this.saveEditor();
      this.hasPendingEditorChanges = false;
    });
  }

  async uploadFiles(
    absolutePaths: string[],
    rootDir: string,
  ): Promise<UploadResult> {
    if (absolutePaths.length === 0) {
      return { uploaded: [], unresolved: [] };
    }

    return this.step("upload-files", async () => {
      await this.ensureCodeSurfaceReady();

      const entries = absolutePaths.map((absolutePath) => ({
        absolutePath,
        relativePath: path.posix.join(
          ...path.relative(rootDir, absolutePath).split(path.sep),
        ),
      }));
      const unresolved: UploadResult["unresolved"] = [];
      const flat: typeof entries = [];

      for (const entry of entries) {
        if (entry.relativePath.includes("/")) {
          // A flat file input cannot carry folder structure and would collide on
          // same-named files. Let the caller use the editor create+write path.
          unresolved.push({
            path: entry.relativePath,
            reason:
              "Nested files cannot be uploaded without losing their folder; use the editor path.",
          });
        } else {
          flat.push(entry);
        }
      }

      if (flat.length === 0) {
        return { uploaded: [], unresolved };
      }

      const flatPaths = flat.map((entry) => entry.absolutePath);
      let attempted = false;
      let usedInput = false;
      let failure = "";

      // 1. Hidden file input (newer UI exposes input[data-testid=upload-file-input]); 2. Files actions menu or toolbar
      // button + file chooser. A healed "uploadButton" is only used inside (2).
      const uploadInput = await this.tryFind("uploadInput", 2_000, "attached");

      if (uploadInput) {
        try {
          await uploadInput.setInputFiles(flatPaths);
          attempted = true;
          usedInput = true;
        } catch (error) {
          if (error instanceof AutomationAbortedError) {
            throw error;
          }

          failure = `Upload input failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (!attempted) {
        const viaChooser = await this.uploadViaChooser(flatPaths);

        attempted = viaChooser.ok;
        failure = viaChooser.failure || failure;
      }

      if (!attempted) {
        for (const entry of flat) {
          unresolved.push({ path: entry.relativePath, reason: failure });
        }

        return { uploaded: [], unresolved };
      }

      const appeared = async (): Promise<string[]> => {
        const found: string[] = [];

        for (const entry of flat) {
          const ok = await this.pollUntil(
            async () =>
              Boolean(
                await this.locateTreeItem(splitPath(entry.relativePath), {
                  kind: "file",
                  expand: false,
                  scan: false,
                }),
              ),
            found.length === 0 && usedInput ? 6_000 : 8_000,
          );

          if (ok) {
            found.push(entry.relativePath);
          }
        }

        return found;
      };

      let uploaded = await appeared();

      if (uploaded.length === 0 && usedInput) {
        // The hidden input did not trigger an upload: fall back to the real menu + file chooser.
        const viaChooser = await this.uploadViaChooser(flatPaths);

        if (viaChooser.ok) {
          uploaded = await appeared();
        }
      }

      for (const entry of flat) {
        if (!uploaded.includes(entry.relativePath)) {
          unresolved.push({
            path: entry.relativePath,
            reason: "Uploaded file did not appear in the file explorer.",
          });
        }
      }

      return { uploaded, unresolved };
    });
  }

  /**
   * Deletes a file or folder and reports "deleted" only after its row was seen to disappear. A row that was never
   * visible is a failure (EXPLORER_MISMATCH): the baseline keeps the path and the user is told, never a silent drop.
   */
  async deletePath(relativePath: string): Promise<DeleteResult> {
    return this.step(`delete-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      const aria = await this.usesAriaTree();
      const segments = splitPath(relativePath);
      let target: Locator;
      let siblingsBefore = -1;

      if (aria) {
        const index = await this.ensureIndex([relativePath]);
        const row = index.byPath.get(relativePath);

        if (!row) {
          return {
            path: relativePath,
            status: "failed",
            code: "EXPLORER_MISMATCH",
            reason: `${relativePath} is not in Figma's file list, so it was not deleted.`,
          } satisfies DeleteResult;
        }

        siblingsBefore = index.rows.filter((r) => r.parentPath === row.parentPath).length;
        target = (await this.focusIndexedRow(relativePath)).locator;
      } else {
        const hit = await this.locateTreeItem(segments, { kind: "any", expand: true, scan: true });

        if (!hit) {
          return {
            path: relativePath,
            status: "failed",
            code: "EXPLORER_MISMATCH",
            reason: `${relativePath} is not in Figma's file list, so it was not deleted.`,
          } satisfies DeleteResult;
        }

        await hit.locator.scrollIntoViewIfNeeded();
        target = hit.locator;
      }

      await target.click({ button: "right" });
      const deleteAction = await this.tryFindVisible("deleteAction", 2_000);

      if (!deleteAction) {
        await this.handle.page.keyboard.press("Escape").catch(() => undefined);

        return {
          path: relativePath,
          status: "unsupported",
          reason: "Delete action was not exposed by the current UI.",
        } satisfies DeleteResult;
      }

      await deleteAction.click();

      // Confirmation is scoped to dialogs so it can never re-match the menu item.
      const confirmDeleteButton = await this.tryFindVisible("deleteConfirmButton", 2_000);

      if (confirmDeleteButton) {
        await confirmDeleteButton.click();
      }

      this.explorerIndex = null;

      const gone = await this.pollUntil(async () => {
        if (!aria) {
          return !(await this.locateTreeItem(segments, { kind: "any", expand: false, scan: false }));
        }

        this.explorerIndex = null;
        const index = await this.ensureIndex([relativePath]);
        const parentPath = segments.slice(0, -1).join("/");
        const siblingsNow = index.rows.filter((r) => r.parentPath === parentPath).length;

        return !index.byPath.has(relativePath) && siblingsNow === siblingsBefore - 1;
      }, 6_000, 250);

      if (!gone) {
        return {
          path: relativePath,
          status: "failed",
          code: "DELETE_NOT_VERIFIED",
          reason: `${relativePath} is still in Figma's file list after deleting it.`,
        } satisfies DeleteResult;
      }

      await this.settleWrites(0);

      return {
        path: relativePath,
        status: "deleted",
      } satisfies DeleteResult;
    });
  }

  async submitPrompt(message: string): Promise<boolean> {
    return this.step("submit-prompt", async () => {
      await this.ensureCodeSurfaceReady();

      let promptTextarea = await this.tryFindVisible("promptTextarea", 4_000);
      let filled = false;

      if (!promptTextarea) {
        // Healed prompt box: the post-condition is that the message is retained by it (the flow types it anyway).
        promptTextarea = await this.healKey("promptTextarea", async (candidate) => {
          await this.fillPrompt(candidate, message);
        });
        filled = promptTextarea !== null;
      }

      if (!promptTextarea) {
        throw new SelectorNotFoundError("promptTextarea", this.sel("promptTextarea"));
      }

      const promptBox = promptTextarea;

      const idleBefore = await this.pollUntil(
        () => this.isPromptIdle(promptBox),
        PROMPT_IDLE_TIMEOUT_MS,
        250,
      );

      if (!idleBefore) {
        throw new AutomationTimeoutError(
          "The prompt composer stayed busy; the previous generation did not finish.",
        );
      }

      if (!filled) {
        await this.fillPrompt(promptBox, message);
      }

      const sendButton = await this.tryFindVisible("promptSendButton", 2_000);

      if (sendButton) {
        await this.pollUntil(
          async () => sendButton.isEnabled().catch(() => true),
          3_000,
        );
        await sendButton.click();
      } else {
        await promptBox.press(SUBMIT_SHORTCUT);
      }

      const accepted = async (): Promise<boolean> =>
        (await this.readPromptValue(promptBox).catch(() => "x")).trim() === "" ||
        (await promptBox.isDisabled().catch(() => false)) ||
        (await this.isAnyVisibleNow("promptStopButton"));

      let wasAccepted = await this.pollUntil(accepted, 5_000);

      if (!wasAccepted) {
        await promptBox.press(SUBMIT_SHORTCUT);
        wasAccepted = await this.pollUntil(accepted, 3_000);
      }

      if (!wasAccepted && !sendButton) {
        // No Send control matched and the keyboard did not submit: heal it (post-condition: the composer accepts).
        const healedSend = await this.healKey("promptSendButton", async (candidate) => {
          await candidate.click();

          if (!(await this.pollUntil(accepted, 5_000))) {
            throw new UiChangedError("The composer did not accept the prompt.");
          }
        });

        wasAccepted = healedSend !== null;
      }

      if (!wasAccepted) {
        await promptBox.press("Enter");
        wasAccepted = await this.pollUntil(accepted, 3_000);
      }

      if (!wasAccepted) {
        throw new FigmaAutomationError(
          "The composer did not accept the prompt (textarea was never cleared).",
        );
      }

      // The composer is locked (generating) but no Stop control matched: heal the indicator (observed, never clicked).
      if (
        (await promptBox.isDisabled().catch(() => false)) &&
        !(await this.isAnyVisibleNow("promptStopButton"))
      ) {
        await this.healKey("promptStopButton", () => Promise.resolve());
      }

      // Busy phase may be too short to observe; idle is what matters.
      await this.pollUntil(async () => !(await this.isPromptIdle(promptBox)), 5_000);

      const finished = await this.pollUntil(
        () => this.isPromptIdle(promptBox),
        PROMPT_COMPLETION_TIMEOUT_MS,
        500,
      );

      if (!finished) {
        throw new AutomationTimeoutError(
          "Timed out waiting for the Figma Make generation to finish.",
        );
      }

      await this.settleWrites(0);

      return true;
    });
  }

  async close(): Promise<void> {
    if (this.hiddenFilesToggledByUs && !this.signal?.aborted && !this.handle.page.isClosed()) {
      // Leave the explorer as we found it (the toggle may be a persisted preference).
      await this.setHiddenFilesShown(false).catch((error: unknown) => {
        this.context.logger.warn({ error }, "could not switch 'Show hidden files' back off");
      });
    }

    await this.closeOnce();
  }

  /** Throws a typed error when the freshly opened page is a login or error page. */
  async assertProjectLoaded(): Promise<void> {
    const state = await this.classifyPage();

    if (state) {
      throw errorFromPageState(state);
    }
  }

  // -------------------------------------------------------------------------
  // Infrastructure: steps, abort, polling, diagnostics
  // -------------------------------------------------------------------------

  private closeOnce(): Promise<void> {
    void this.context.heal?.store.flush().catch(() => undefined);
    this.closePromise ??= this.handle.close().catch((error: unknown) => {
      this.context.logger.warn({ error }, "failed to close browser handle");
    });

    return this.closePromise;
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new AutomationAbortedError();
    }
  }

  private async raceAbort<T>(promise: Promise<T>): Promise<T> {
    const signal = this.signal;

    if (!signal) {
      return promise;
    }

    if (signal.aborted) {
      throw new AutomationAbortedError();
    }

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AutomationAbortedError());
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      return await Promise.race([promise, aborted]);
    } finally {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await this.raceAbort(
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    );
  }

  /** Polls a state predicate until true or the deadline; abort-aware. */
  private async pollUntil(
    check: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = 100,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      this.throwIfAborted();

      try {
        if (await this.raceAbort(check())) {
          return true;
        }
      } catch (error) {
        if (error instanceof AutomationAbortedError) {
          throw error;
        }
        // Transient (detached node, navigation): treat as "not yet".
      }

      if (Date.now() >= deadline) {
        return false;
      }

      await this.sleep(intervalMs);
    }
  }

  private async step<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.throwIfAborted();

    return this.handle.runStep(name, async () => {
      try {
        return await operation();
      } catch (error) {
        if (this.signal?.aborted) {
          throw new AutomationAbortedError();
        }

        let finalError: unknown = error;

        if (this.isLocatorFailure(error)) {
          const state = await this.classifyPage().catch(() => null);

          if (state) {
            finalError = errorFromPageState(state, error);
          }
        }

        await this.saveDiagnostics(name, finalError).catch(() => undefined);

        throw finalError;
      }
    });
  }

  private isLocatorFailure(error: unknown): boolean {
    return (
      error instanceof SelectorNotFoundError ||
      error instanceof UiChangedError ||
      error instanceof AutomationTimeoutError ||
      (error instanceof Error && error.name === "TimeoutError")
    );
  }

  private async saveDiagnostics(step: string, error: unknown): Promise<void> {
    const dir = this.context.paths.artifactsDir;
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const base = path.join(dir, `${stamp}-${sanitizeFileName(step)}`);
    const page = this.handle.page;

    await fs.ensureDir(dir);

    const html = await page.content().catch(() => "");

    await Promise.all([
      fs.writeFile(`${base}.dom.html`, html.slice(0, 3_000_000)),
      fs.writeJson(
        `${base}.error.json`,
        {
          step,
          url: page.isClosed() ? null : page.url(),
          name: error instanceof Error ? error.name : typeof error,
          code: error instanceof FigmaAutomationError ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        },
        { spaces: 2 },
      ),
    ]);

    this.context.logger.error({ diagnostics: base, step }, "saved DOM diagnostics");
  }

  private async classifyPage(): Promise<PageState | null> {
    const page = this.handle.page;

    if (page.isClosed()) {
      return null;
    }

    // Never classify a healthy workspace: code content could match error phrases.
    if (await this.isAnyVisibleNow("codeEditorRoot")) {
      return null;
    }

    const read = async (): Promise<PageState | null> => {
      const { text, hasPasswordInput, hasGuestPrompt } = await page.evaluate(() => ({
        text: (document.body?.innerText ?? "").slice(0, 4_000),
        hasPasswordInput: Boolean(
          document.querySelector(
            'input[type="password"], input[name="password"], form[action*="login"]',
          ),
        ),
        hasGuestPrompt: Boolean(document.querySelector('[data-testid="google-btn"]')),
      }));

      return classifyPageState({ url: page.url(), text, hasPasswordInput, hasGuestPrompt });
    };

    let state = await read();

    // A signed-in page shows the guest prompt for a moment while Figma loads. Only a prompt that stays is real.
    for (let again = 0; again < 4 && state?.kind === "auth" && state.detail === "login form detected"; again++) {
      await page.waitForTimeout(2_500);
      if (page.isClosed()) return null;
      if (await this.isAnyVisibleNow("codeEditorRoot")) return null;
      state = await read();
    }

    return state;
  }

  // -------------------------------------------------------------------------
  // Surface readiness
  // -------------------------------------------------------------------------

  private async ensureCodeSurfaceReady(): Promise<void> {
    this.throwIfAborted();
    await this.dismissFloatingOverlays();

    await withRetry(
      async () => {
        if (await this.tryFindVisible("codeEditorRoot", 1_500)) {
          return;
        }

        const pageState = await this.classifyPage();

        if (pageState) {
          throw errorFromPageState(pageState);
        }

        // All candidates race; the workspace has up to 20s to appear.
        const codeModeButton = await this.tryFindVisible("codeModeButton", this.codeModeWaitMs);

        if (!codeModeButton) {
          const lateState = await this.classifyPage();

          if (lateState) {
            throw errorFromPageState(lateState);
          }

          if (await this.isAnyVisibleNow("workspaceRoot")) {
            if (await this.healCodeModeButton()) {
              return;
            }

            throw new UiChangedError(
              `Figma Make workspace loaded but no code-mode control matched: ${this.sel("codeModeButton").join(", ")}`,
            );
          }

          throw new SelectorNotFoundError(
            "workspaceRoot",
            this.sel("workspaceRoot"),
          );
        }

        await this.switchToCodeMode(codeModeButton);
        await this.findVisible("codeEditorRoot", 15_000);
      },
      {
        attempts: 2,
        shouldRetry: (error) => !isNonRetryable(error),
      },
    );
  }

  /**
   * Self-healing for the Code/Files toggle: the injected healer proposes selectors, heal/gate.ts validates them
   * against the live page, and the adapter's own action (switchToCodeMode + editor visible) is the post-condition.
   * Returns true when the workspace is now in code mode.
   */
  private async healCodeModeButton(): Promise<boolean> {
    const healed = await this.healKey("codeModeButton", async (locator) => {
      await this.switchToCodeMode(locator);
      await this.findVisible("codeEditorRoot", 15_000);
    });

    return healed !== null;
  }

  /**
   * Generic auto-heal hook for ANY healable key (healable: true in selectors.default.json). Call it only where the
   * flow would otherwise fail with SelectorNotFound/UiChanged. HealSession enforces the safety gate (grammar, exactly
   * one visible enabled element, expected term, kind shape), the per-key/session limits and the cooldown; `act` runs
   * the flow's own action on the gated element and throws when its post-condition does not hold. Resolves the healed
   * locator (the action has ALREADY been performed on it) or null.
   */
  private async healKey(
    key: SelectorKey,
    act: (locator: Locator) => Promise<void>,
  ): Promise<Locator | null> {
    if (!this.healSession?.enabled) {
      return null;
    }

    return this.healSession.tryHeal({
      page: this.handle.page,
      key,
      failedSelectors: this.sel(key),
      signal: this.signal,
      log: (msg, extra) => this.context.logger.info({ ...extra }, msg),
      act: async (locator) => {
        try {
          await act(locator);
          return true;
        } catch (error) {
          if (error instanceof AutomationAbortedError) {
            throw error;
          }

          return false;
        }
      },
    });
  }

  /** Clicks a control; when no selector matches, heals the key once (post-condition after the click) and retries. */
  private async clickKey(
    key: SelectorKey,
    timeoutMs: number,
    post?: () => Promise<void>,
  ): Promise<void> {
    const locator = await this.tryFindVisible(key, timeoutMs);

    if (locator) {
      await locator.click();
      return;
    }

    const healed = await this.healKey(key, async (candidate) => {
      await candidate.click();
      await post?.();
    });

    if (!healed) {
      throw new SelectorNotFoundError(key, this.sel(key));
    }
  }

  private async isMenuOpen(): Promise<boolean> {
    // Any visible menu counts: a closed header menu may stay in the DOM ahead of an open context menu.
    return this.handle.page
      .locator('[role="menu"]:visible')
      .count()
      .then((count) => count > 0)
      .catch(() => false);
  }

  /** Clicks a menu trigger and waits for a role=menu to appear. Throws when it never opens. */
  private async openMenuWith(trigger: Locator): Promise<void> {
    await trigger.click();

    if (!(await this.pollUntil(() => this.isMenuOpen(), 3_000))) {
      throw new UiChangedError("The file actions menu did not open.");
    }
  }

  /** Opens the Files header actions menu (newer UI). Returns false when there is no menu or it did not open. */
  private async openFilesActionsMenu(timeoutMs = 2_000): Promise<boolean> {
    if (await this.isMenuOpen()) {
      return true;
    }

    const trigger = await this.tryFindVisible("filesActionsMenuButton", timeoutMs);

    if (trigger) {
      try {
        await this.openMenuWith(trigger);
        return true;
      } catch (error) {
        if (error instanceof AutomationAbortedError) {
          throw error;
        }

        return false;
      }
    }

    // Heal the trigger only when nothing else could start the flow (the legacy direct buttons are absent).
    if (
      (await this.isAnyVisibleNow("downloadButton")) ||
      (await this.isAnyVisibleNow("newFileButton")) ||
      (await this.isAnyVisibleNow("uploadButton"))
    ) {
      return false;
    }

    const healed = await this.healKey("filesActionsMenuButton", async (candidate) => {
      await this.openMenuWith(candidate);

      // Post-condition: it must be the FILES actions menu (offers Download/Upload/Create), not just any menu.
      const items = await this.handle.page.locator('[role="menu"] [role="menuitem"]').allInnerTexts();

      if (!items.some((text) => /\b(download|upload|create)\b/i.test(text))) {
        await this.closeMenu();
        throw new UiChangedError("The opened menu is not the file actions menu.");
      }
    });

    return healed !== null;
  }

  private async closeMenu(): Promise<void> {
    if (await this.isMenuOpen()) {
      await this.handle.page.keyboard.press("Escape").catch(() => undefined);
      await this.pollUntil(async () => !(await this.isMenuOpen()), 800);
    }
  }

  /**
   * Starts the ZIP download. Newer UI: Files actions menu -> "Download code". Fallback: the legacy direct Download
   * button (+ optional ZIP menu item). Each step is healable; the post-condition of a healed click is the download event.
   */
  private async triggerDownload(downloadPromise: Promise<unknown>): Promise<void> {
    let downloaded = false;
    void downloadPromise.then(
      () => {
        downloaded = true;
      },
      () => undefined,
    );
    const waitStarted = async (): Promise<void> => {
      if (!(await this.pollUntil(() => Promise.resolve(downloaded), 15_000))) {
        throw new UiChangedError("The download did not start.");
      }
    };

    if (await this.openFilesActionsMenu()) {
      const item = await this.tryFindVisible("downloadZipAction", 3_000);

      if (item) {
        await item.click();
        return;
      }

      const healedItem = await this.healKey("downloadZipAction", async (candidate) => {
        await candidate.click();
        await waitStarted();
      });

      if (healedItem) {
        return;
      }

      await this.closeMenu();
    }

    const direct = await this.tryFindVisible("downloadButton", 2_000);

    if (direct) {
      await direct.click();

      const zipAction = await this.tryFindVisible("downloadZipAction", 2_000);

      if (zipAction) {
        await zipAction.click();
      }

      return;
    }

    const healedDirect = await this.healKey("downloadButton", async (candidate) => {
      await candidate.click();
      await waitStarted();
    });

    if (!healedDirect) {
      throw new SelectorNotFoundError("downloadButton", this.sel("downloadButton"));
    }
  }

  /** Upload through a real file chooser: Files actions menu item, else the legacy toolbar button. */
  private async uploadViaChooser(
    paths: string[],
  ): Promise<{ ok: boolean; failure: string }> {
    const chooseWith = async (click: () => Promise<void>): Promise<void> => {
      const [chooser] = await Promise.all([
        this.handle.page.waitForEvent("filechooser", { timeout: 5_000 }),
        click(),
      ]);
      await chooser.setFiles(paths);
    };
    const fail = (error: unknown): { ok: false; failure: string } => {
      if (error instanceof AutomationAbortedError) {
        throw error;
      }

      return {
        ok: false,
        failure: `File chooser upload failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    };

    await this.openFilesActionsMenu(1_500);

    const button = await this.tryFindVisible("uploadButton", 2_000);

    if (button) {
      try {
        await chooseWith(() => button.click());
        return { ok: true, failure: "" };
      } catch (error) {
        return fail(error);
      }
    }

    const healed = await this.healKey("uploadButton", async (candidate) => {
      await chooseWith(() => candidate.click());
    });

    if (healed) {
      return { ok: true, failure: "" };
    }

    await this.closeMenu();

    return {
      ok: false,
      failure: "No upload control matched the configured Figma Make selectors.",
    };
  }

  /** Autosave state of the code layer; null when the UI exposes none. */
  private async readPersistenceStatus(): Promise<string | null> {
    for (const selector of this.sel("persistenceStatus")) {
      const status = await this.handle.page
        .locator(selector)
        .first()
        .getAttribute("data-code-layer-persistence-status", { timeout: 500 })
        .catch(() => null);

      if (status !== null) {
        return status;
      }
    }

    return null;
  }

  /** True while the autosave indicator reports an unsaved / in-flight state. */
  private static isPersistenceDirty(status: string | null): boolean {
    return status !== null && /(^|[\s_-])(saving|pending|dirty|unsaved|syncing|modified|queued|uploading)/i.test(status);
  }

  private async waitPersistenceIdle(timeoutMs: number): Promise<boolean> {
    return this.pollUntil(
      async () => !PlaywrightFigmaMakeProjectSession.isPersistenceDirty(await this.readPersistenceStatus()),
      timeoutMs,
      250,
    );
  }

  private async dismissFloatingOverlays(): Promise<void> {
    const overlays = this.handle.page.locator(
      '[data-fpl-floating-overlay="true"]',
    );
    const blocking = async (): Promise<number> => {
      let visible = 0;
      const count = await overlays.count();

      for (let i = 0; i < count; i += 1) {
        if (await overlays.nth(i).isVisible().catch(() => false)) {
          visible += 1;
        }
      }

      return visible;
    };

    if ((await blocking()) === 0) {
      return;
    }

    // Close politely first. Overlays are owned by Figma's React tree, so never remove them.
    await this.handle.page.keyboard.press("Escape").catch(() => undefined);
    await this.pollUntil(async () => (await blocking()) === 0, 800);

    if ((await blocking()) === 0) {
      return;
    }

    const count = await overlays.count();

    for (let i = 0; i < count; i += 1) {
      await overlays
        .nth(i)
        .evaluate((el) => {
          (el as HTMLElement).style.pointerEvents = "none";
        })
        .catch(() => undefined);
    }
  }

  private async switchToCodeMode(codeModeButton: Locator): Promise<void> {
    const inputType = await codeModeButton.getAttribute("type").catch(() => null);

    if (inputType === "radio") {
      await codeModeButton.check({ force: true });
      return;
    }

    const nestedRadio = codeModeButton.locator('input[value="code"]').first();

    if (await isVisible(nestedRadio, 500)) {
      await nestedRadio.check({ force: true });
      return;
    }

    await codeModeButton.click({ force: true });
  }

  // -------------------------------------------------------------------------
  // File open / create
  // -------------------------------------------------------------------------

  private async openFile(relativePath: string): Promise<{ matchCount: number }> {
    const segments = splitPath(relativePath);

    if (segments.length === 0) {
      throw new FigmaAutomationError("Cannot open an empty file path.");
    }

    if (!(await this.tryFindVisible("fileTreeRoot", 6_000))) {
      // Explorer unavailable: quick-open is the last resort.
      await this.openFileWithQuickOpen(relativePath);
      this.activePath = relativePath;
      return { matchCount: 1 };
    }

    if (await this.usesAriaTree()) {
      await this.openFileIndexed(relativePath);
      return { matchCount: 1 };
    }

    const before = await this.readEditorContentOrNull();
    const hit = await this.locateTreeItem(segments, {
      kind: "file",
      expand: true,
      scan: true,
    });

    if (!hit) {
      throw new FileNotFoundInTreeError(relativePath);
    }

    if (hit.matchCount > 1) {
      this.context.logger.warn(
        { relativePath, matches: hit.matchCount },
        "multiple explorer entries matched one path",
      );
    }

    if (!(hit.active && this.activePath === relativePath)) {
      await hit.locator.scrollIntoViewIfNeeded();
      await hit.locator.click();
      await this.confirmActiveFile(segments, relativePath, before);
    }

    this.activePath = relativePath;
    await this.findVisible("codeEditorRoot", 6_000);

    return { matchCount: hit.matchCount };
  }

  /** Waits until the explorer and editor agree the target file is active; throws on mismatch. */
  private async confirmActiveFile(
    segments: string[],
    relativePath: string,
    before: string | null,
  ): Promise<void> {
    const deadline = Date.now() + 6_000;
    let activeSince = 0;
    let lastSupported = false;
    let lastContentChanged = false;

    while (Date.now() < deadline) {
      this.throwIfAborted();

      const hit = await this.locateTreeItem(segments, {
        kind: "file",
        expand: false,
        scan: false,
      }).catch(() => null);
      const current = await this.readEditorContentOrNull();
      const contentChanged =
        before !== null && current !== null && current !== before;

      lastSupported = hit?.activeSupported ?? false;
      lastContentChanged = contentChanged;

      if (contentChanged && (!hit || hit.active || !hit.activeSupported)) {
        return;
      }

      if (hit?.active) {
        activeSince ||= Date.now();

        // Active row but identical content: legitimately equal files, or the
        // editor has not swapped yet. Give the editor a short grace period.
        if (Date.now() - activeSince > 1_500) {
          return;
        }
      }

      await this.sleep(100);
    }

    if (!lastSupported && !lastContentChanged) {
      // The tree exposes no selection state and the editor content is identical
      // (e.g. two empty files). Nothing observable contradicts the click.
      this.context.logger.warn(
        { relativePath },
        "could not independently confirm the active file; proceeding",
      );
      return;
    }

    throw new WrongFileError(
      `Could not confirm ${relativePath} became the active file after opening it.`,
    );
  }

  private async openFileWithQuickOpen(relativePath: string): Promise<void> {
    const shortcuts = ["ControlOrMeta+P", "ControlOrMeta+Shift+O"];
    const before = await this.readEditorContentOrNull();

    for (const shortcut of shortcuts) {
      await this.handle.page.keyboard.press(shortcut);
      let quickOpenInput = await this.tryFindVisible("quickOpenInput", 2_000);
      let filled = false;

      if (!quickOpenInput && shortcut === shortcuts.at(-1)) {
        // Last chance: ask the healer; the post-condition is that the path can be typed into the control.
        quickOpenInput = await this.healKey("quickOpenInput", async (candidate) => {
          await candidate.fill(relativePath);

          if ((await candidate.inputValue()) !== relativePath) {
            throw new UiChangedError("The quick-open input did not retain the typed path.");
          }
        });
        filled = quickOpenInput !== null;
      }

      if (quickOpenInput) {
        if (!filled) {
          await quickOpenInput.fill(relativePath);
        }

        await quickOpenInput.press("Enter");
        await this.findVisible("codeEditorRoot", 10_000);
        await this.pollUntil(
          async () => (await this.readEditorContentOrNull()) !== before,
          3_000,
        );
        return;
      }

      await this.handle.page.keyboard.press("Escape");
    }

    throw new FigmaAutomationError(
      `Unable to open ${relativePath}: the file explorer was unavailable and the Figma Make UI did not expose a quick-open input.`,
    );
  }

  /** Older explorer (no aria rows): create through the context menu / toolbar and the pixel-based tree lookup. */
  private async createFileLegacy(relativePath: string): Promise<void> {
    const segments = splitPath(relativePath);
    const leaf = segments.at(-1);

    if (!leaf) {
      throw new FigmaAutomationError(
        `Unable to derive a file name from ${relativePath}.`,
      );
    }

    const parentSegments = segments.slice(0, -1);
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);
    const childrenBefore = new Set(
      (await this.listTreeChildren(parentSegments)) ?? [],
    );

    if (parentSegments.length > 0) {
      // Always target the parent folder explicitly; the global button would create at the root.
      const parentFolder = await this.locateTreeItem(parentSegments, {
        kind: "folder",
        expand: true,
        expandLast: true,
        scan: true,
      });

      if (!parentFolder) {
        throw new FileNotFoundInTreeError(parentSegments.join("/"));
      }

      await parentFolder.locator.scrollIntoViewIfNeeded();
      await parentFolder.locator.click({ button: "right" });
      await this.clickKey("createFileAction", 4_000, () => this.expectNameInput());
    } else {
      await this.startRootFileCreation(treeRoot);
    }

    const newFileInput = await this.findVisible("newFileInput", 4_000);
    await this.replaceInlineFileName(newFileInput, leaf);
    await newFileInput.press("Enter");

    await this.ensureExactCreatedFile(segments, parentSegments, leaf, childrenBefore);

    const opened = await this.openFile(relativePath);

    if (opened.matchCount !== 1) {
      throw new FigmaAutomationError(
        `Expected exactly one ${relativePath} after creation but found ${opened.matchCount}.`,
      );
    }
  }

  private async expectNameInput(): Promise<void> {
    await this.findVisible("newFileInput", 4_000);
  }

  /**
   * Root-level "new file": Files actions menu -> Create file (newer UI), else the legacy direct button, else the
   * explorer context menu. Every step is healable (createFileAction / newFileButton).
   */
  private async startRootFileCreation(treeRoot: Locator): Promise<void> {
    if (
      (await this.isAnyVisibleNow("filesActionsMenuButton")) &&
      (await this.openFilesActionsMenu())
    ) {
      const item = await this.tryFindVisible("createFileAction", 3_000);

      if (item) {
        await item.click();
        return;
      }

      const healedItem = await this.healKey("createFileAction", async (candidate) => {
        await candidate.click();
        await this.expectNameInput();
      });

      if (healedItem) {
        return;
      }

      await this.closeMenu();
    }

    const directNewFileButton = await this.tryFindVisible("newFileButton", 1_500);

    if (directNewFileButton) {
      await directNewFileButton.click();
      return;
    }

    if (await this.usesAriaTree()) {
      // The virtualised container is as tall as the whole list: a coordinate right-click would land off-screen.
      throw new SelectorNotFoundError("createFileAction", this.sel("createFileAction"));
    }

    await this.openRootFileTreeContextMenu(treeRoot);

    const menuItem = await this.tryFindVisible("createFileAction", 2_500);

    if (menuItem) {
      await menuItem.click();
      return;
    }

    const healedMenuItem = await this.healKey("createFileAction", async (candidate) => {
      await candidate.click();
      await this.expectNameInput();
    });

    if (healedMenuItem) {
      return;
    }

    await this.closeMenu();

    const healedButton = await this.healKey("newFileButton", async (candidate) => {
      await candidate.click();
      await this.expectNameInput();
    });

    if (!healedButton) {
      throw new SelectorNotFoundError("createFileAction", this.sel("createFileAction"));
    }
  }

  private async ensureExactCreatedFile(
    segments: string[],
    parentSegments: string[],
    expectedLeaf: string,
    childrenBefore: ReadonlySet<string>,
  ): Promise<void> {
    const appeared = await this.pollUntil(
      async () =>
        Boolean(
          await this.locateTreeItem(segments, {
            kind: "file",
            expand: false,
            scan: true,
          }),
        ),
      5_000,
      200,
    );

    if (appeared) {
      return;
    }

    // The typed name did not apply. Rename only an entry that is new since before creation.
    const childrenAfter = (await this.listTreeChildren(parentSegments)) ?? [];
    const added = childrenAfter.filter((name) => !childrenBefore.has(name));
    const defaultPrefix = deriveDefaultNewFileName(expectedLeaf).split(".")[0] ?? "new-file";
    const candidates = added.filter((name) => name.startsWith(defaultPrefix));

    if (added.length !== 1 || candidates.length !== 1 || !candidates[0]) {
      throw new FigmaAutomationError(
        `Created file did not appear in the explorer as ${expectedLeaf}, and no single new default-named entry could be identified (new entries: ${added.join(", ") || "none"}).`,
      );
    }

    await this.renameTreeItem(parentSegments, candidates[0], expectedLeaf);
  }

  private async renameTreeItem(
    parentSegments: string[],
    currentLabel: string,
    nextLabel: string,
  ): Promise<void> {
    const target = await this.locateTreeItem([...parentSegments, currentLabel], {
      kind: "file",
      expand: true,
      scan: true,
    });

    if (!target) {
      throw new FileNotFoundInTreeError([...parentSegments, currentLabel].join("/"));
    }

    await target.locator.scrollIntoViewIfNeeded();
    await target.locator.click({ button: "right" });
    await this.clickKey("renameAction", 4_000, () => this.expectNameInput());

    const renameInput = await this.findVisible("newFileInput", 4_000);
    await this.replaceInlineFileName(renameInput, nextLabel);
    await renameInput.press("Enter");

    const renamed = await this.pollUntil(
      async () =>
        Boolean(
          await this.locateTreeItem([...parentSegments, nextLabel], {
            kind: "file",
            expand: false,
            scan: true,
          }),
        ),
      5_000,
      200,
    );

    if (!renamed) {
      throw new FigmaAutomationError(
        `Renaming ${currentLabel} to ${nextLabel} did not take effect.`,
      );
    }
  }

  private async replaceInlineFileName(
    input: Locator,
    nextValue: string,
  ): Promise<void> {
    await input.click({ force: true });
    await input.press(SELECT_ALL).catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.fill(nextValue).catch(() => undefined);

    let currentValue = await input.inputValue().catch(() => "");

    if (currentValue !== nextValue) {
      await input.evaluate((node, value) => {
        const element = node as HTMLInputElement;
        const valueDescriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        );

        valueDescriptor?.set?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.focus();
        element.setSelectionRange?.(value.length, value.length);
      }, nextValue);
    }

    currentValue = await input.inputValue().catch(() => "");

    if (currentValue !== nextValue) {
      throw new FigmaAutomationError(
        `Unable to set the inline file name input to ${nextValue}.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Aria explorer index (current UI): read everything once, click by (level, label, top)
  // -------------------------------------------------------------------------

  /** True when the explorer renders `role="treeitem"` rows with aria-level (probed once, after rows had time to mount). */
  private async usesAriaTree(): Promise<boolean> {
    if (this.ariaTree !== null) {
      return this.ariaTree;
    }

    const treeRoot = await this.tryFindVisible("fileTreeRoot", 6_000);

    if (!treeRoot) {
      return false;
    }

    const probe = (): Promise<TreeReadResult> => runPageScript<TreeReadResult>(treeRoot, TREE_READ_SCRIPT, {});
    const deadline = Date.now() + 5_000;
    let result = await probe();

    while (result.rows.length === 0 && result.legacyButtons === 0 && Date.now() < deadline) {
      await this.sleep(150);
      result = await probe();
    }

    if (result.rows.length > 0) {
      this.ariaTree = true;
    } else if (result.legacyButtons > 0) {
      this.ariaTree = false; // genuinely the older markup
    } else {
      // Nothing mounted yet (slow load, or an empty project): decide again next time rather than locking in "legacy".
      return false;
    }

    return this.ariaTree;
  }

  /** The complete index with every ancestor folder of `paths` expanded (cached until rows change). */
  private async ensureIndex(paths: string[]): Promise<ExplorerIndex> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);
    const required = requiredFolders(paths);
    let index = this.explorerIndex ?? (await this.buildIndex(treeRoot));

    for (let round = 0; round <= required.length; round += 1) {
      const next = required.find((dir) => {
        const row = index.byPath.get(dir);

        return row !== undefined && row.kind === "folder" && row.expanded !== true && !this.expandAttempted.has(dir);
      });

      if (!next) {
        break;
      }

      this.expandAttempted.add(next);
      await this.expandIndexedRow(treeRoot, index.byPath.get(next)!);
      index = await this.buildIndex(treeRoot);
    }

    this.explorerIndex = index;

    return index;
  }

  /** One full scroll pass + completeness proof; the pass is retried once before giving up. */
  private async buildIndex(treeRoot: Locator): Promise<ExplorerIndex> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pass = await this.readExplorerPass(treeRoot);

      try {
        const index = reconstructTree(pass.rows, pass.rowHeight);

        this.context.logger.debug({ rows: index.rows.length, attempt }, "explorer indexed");

        return index;
      } catch (error) {
        if (!(error instanceof TreeIndexIncompleteError)) {
          throw error;
        }

        lastError = error;
        await this.sleep(300);
      }
    }

    throw lastError;
  }

  /** Scrolls the explorer window by window and merges the mounted rows by their offset. */
  private async readExplorerPass(treeRoot: Locator): Promise<{ rows: AriaRow[]; rowHeight: number }> {
    const seen = new Map<number, AriaRow>();
    let rowHeight = 0;
    const merge = (result: TreeReadResult): void => {
      for (const { height, ...row } of result.rows) {
        if (rowHeight === 0 && height > 0) {
          rowHeight = Math.round(height);
        }

        seen.set(Math.round(row.top), row);
      }
    };
    const first = await runPageScript<TreeReadResult>(treeRoot, TREE_READ_SCRIPT, { scrollTo: 0 });

    merge(first);

    if (first.scroller) {
      const { clientHeight, scrollHeight } = first.scroller;
      const step = Math.max(160, Math.floor(clientHeight * 0.8));
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      const maxIterations = Math.ceil(scrollHeight / step) + 3;
      let scrollTop = 0;

      // The tree container's own box can be shorter than its absolutely positioned rows (overflow: visible), so the
      // only reliable end of the list is the scroller's bottom.
      for (let i = 0; i < maxIterations && scrollTop < maxScroll; i += 1) {
        this.throwIfAborted();
        scrollTop = Math.min(scrollTop + step, maxScroll);
        merge(await runPageScript<TreeReadResult>(treeRoot, TREE_READ_SCRIPT, { scrollTo: scrollTop }));
      }
    }

    if (rowHeight === 0) {
      const tops = [...seen.keys()].sort((a, b) => a - b);
      const gaps = tops.slice(1).map((top, i) => top - tops[i]!).filter((gap) => gap > 0);

      rowHeight = gaps.length > 0 ? Math.min(...gaps) : 32;
    }

    return { rows: [...seen.values()], rowHeight };
  }

  private async tagRow(treeRoot: Locator, row: IndexedRow): Promise<TreeTagResult> {
    return runPageScript<TreeTagResult>(treeRoot, TREE_TAG_SCRIPT, { top: row.top, label: row.label, level: row.level });
  }

  private async expandIndexedRow(treeRoot: Locator, row: IndexedRow): Promise<void> {
    const tag = await this.tagRow(treeRoot, row);

    if (!tag.ok) {
      throw new ExplorerMismatchError(row.path, "moved in the list while reading it");
    }

    if (tag.expanded) {
      return;
    }

    await this.handle.page.locator(TARGET_SELECTOR).locator("button").first().click();

    const opened = await this.pollUntil(async () => {
      const again = await this.tagRow(treeRoot, row);

      return again.ok && again.expanded === true;
    }, 2_500);

    if (!opened) {
      this.context.logger.warn({ path: row.path }, "folder did not report aria-expanded after clicking; treating it as empty");
    }
  }

  /** Scrolls to the row, re-asserts (level, label) at that offset and returns a locator for the mounted treeitem. */
  private async focusIndexedRow(relativePath: string): Promise<{ locator: Locator; row: IndexedRow; selected: boolean }> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const index = await this.ensureIndex([relativePath]);

      if (index.duplicates.includes(relativePath)) {
        throw new AmbiguousRemotePathError(relativePath);
      }

      const row = index.byPath.get(relativePath);

      if (!row) {
        throw new ExplorerMismatchError(relativePath);
      }

      const tag = await this.tagRow(treeRoot, row);

      if (tag.ok) {
        return { locator: this.handle.page.locator(TARGET_SELECTOR).first(), row, selected: tag.selected === true };
      }

      // Rows shifted since the index was read (something was created or deleted): read once more.
      this.explorerIndex = null;
    }

    throw new ExplorerMismatchError(relativePath, "moved in the list while reading it");
  }

  /** Clicks the file's row and waits until the explorer marks it selected or the editor swapped its content. */
  private async openFileIndexed(relativePath: string): Promise<void> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);
    const { locator, row, selected } = await this.focusIndexedRow(relativePath);

    if (row.kind !== "file") {
      throw new ExplorerMismatchError(relativePath, "is a folder in Figma");
    }

    if (selected && this.activePath === relativePath) {
      await this.findVisible("codeEditorRoot", 6_000);
      return;
    }

    const selectionSupported = this.explorerIndex?.selectionSupported ?? false;
    const before = await this.readEditorContentOrNull();

    await locator.locator("button").first().click();

    const confirmed = await this.pollUntil(async () => {
      const again = await this.tagRow(treeRoot, row);

      if (again.ok && again.selected === true) {
        return true;
      }

      const current = await this.readEditorContentOrNull();

      // Live: no editor surface exists until the first file is opened, so "became readable" counts as a swap too.
      return current !== null && (before === null || current !== before);
    }, 6_000);

    if (!confirmed) {
      if (selectionSupported) {
        throw new WrongFileError(`Could not confirm ${relativePath} became the active file after opening it.`);
      }

      // No selection signal anywhere and identical content: the content precondition of the write decides.
      this.context.logger.warn({ relativePath }, "could not independently confirm the active file; the content check decides");
    }

    this.activePath = relativePath;
    await this.findVisible("codeEditorRoot", 6_000);
  }

  private async openContextMenuOn(target: Locator): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await target.click({ button: "right" });

      if (await this.pollUntil(() => this.isMenuOpen(), 2_000)) {
        return;
      }

      await this.dismissFloatingOverlays();
      await this.handle.page.keyboard.press("Escape").catch(() => undefined);
    }

    throw new UiChangedError("The context menu of the file list did not open.");
  }

  /** Create file/folder under an existing parent, verified by the explorer index; never leaves a default-named entry silently. */
  private async createEntry(relativePath: string, kind: "file" | "folder"): Promise<void> {
    const segments = splitPath(relativePath);
    const leaf = segments.at(-1);

    if (!leaf) {
      throw new FigmaAutomationError(`Unable to derive a name from ${relativePath}.`);
    }

    const parentPath = segments.slice(0, -1).join("/");
    const index = await this.ensureIndex([relativePath]);

    if (index.byPath.has(relativePath)) {
      throw new ExplorerMismatchError(relativePath, "already exists in Figma's file list");
    }

    if (parentPath) {
      const parent = index.byPath.get(parentPath);

      if (!parent) {
        throw new ExplorerMismatchError(parentPath, "is not in Figma's file list (the folder must exist first)");
      }

      if (parent.kind !== "folder") {
        throw new ExplorerMismatchError(parentPath, "is a file in Figma, not a folder");
      }
    }

    const siblingsBefore = new Set(index.rows.filter((r) => r.parentPath === parentPath).map((r) => r.label));
    const action: SelectorKey = kind === "file" ? "createFileAction" : "createFolderAction";

    if (parentPath) {
      const { locator } = await this.focusIndexedRow(parentPath);

      await this.openContextMenuOn(locator.locator("button").first());
      await this.clickKey(action, 4_000, () => this.expectNameInput());
    } else {
      await this.startRootCreation(action);
    }

    const input = await this.takeNameInput(kind);

    await this.replaceInlineFileName(input, leaf);
    await input.press("Enter");
    this.explorerIndex = null;
    await this.verifyCreated(parentPath, leaf, kind, siblingsBefore);
  }

  private async startRootCreation(action: SelectorKey): Promise<void> {
    if ((await this.isAnyVisibleNow("filesActionsMenuButton")) && (await this.openFilesActionsMenu())) {
      const item = await this.tryFindVisible(action, 3_000);

      if (item) {
        await item.click();
        return;
      }

      const healed = await this.healKey(action, async (candidate) => {
        await candidate.click();
        await this.expectNameInput();
      });

      if (healed) {
        return;
      }

      await this.closeMenu();
    }

    if (action === "createFileAction") {
      await this.startRootFileCreation(await this.findVisible("fileTreeRoot", 6_000));
      return;
    }

    throw new SelectorNotFoundError(action, this.sel(action));
  }

  /**
   * The one editable name input Figma shows while creating or renaming. A read-only row input of an existing entry is
   * never used, and Enter is never pressed on an input that does not hold a fresh default name (or, for a rename, the
   * current name): that is how stray `new-file*.tsx` entries were left behind before.
   */
  private async takeNameInput(kind: "file" | "folder", options: { rename?: string } = {}): Promise<Locator> {
    const editable = this.handle.page.locator('input[data-testid="code-file-name-input"]:not([readonly])');
    const appeared = await this.pollUntil(async () => (await editable.count()) > 0 && (await editable.first().isVisible()), 4_000);
    let input: Locator | null = null;

    if (appeared) {
      const count = await editable.count();

      if (count !== 1) {
        await this.cancelInlineEdit();
        throw new UiChangedError(`Expected one editable name input in the file list, found ${count}.`);
      }

      input = editable.first();
    } else {
      // Older UI: the generic selectors, but never a read-only control.
      const candidate = await this.tryFindVisible("newFileInput", 1_000);

      if (candidate && (await candidate.evaluate((el) => !(el as HTMLInputElement).readOnly).catch(() => false))) {
        input = candidate;
      }
    }

    if (!input) {
      await this.cancelInlineEdit();
      throw new UiChangedError("Figma did not show an editable name input, so nothing was created.");
    }

    const value = await input.inputValue().catch(() => "");
    const acceptable =
      options.rename !== undefined ? value === options.rename : value === "" || /^(new-file|new-folder|untitled)/i.test(value);

    if (!acceptable) {
      await this.cancelInlineEdit();
      throw new UiChangedError(`The name input showed "${value}" instead of a new ${kind}'s default name; Enter was not pressed.`);
    }

    return input;
  }

  private async cancelInlineEdit(): Promise<void> {
    await this.handle.page.keyboard.press("Escape").catch(() => undefined);
    this.explorerIndex = null;
  }

  private async verifyCreated(parentPath: string, leaf: string, kind: "file" | "folder", siblingsBefore: ReadonlySet<string>): Promise<void> {
    const want = parentPath ? `${parentPath}/${leaf}` : leaf;
    const present = async (): Promise<boolean> => {
      this.explorerIndex = null;
      const row = (await this.ensureIndex([want])).byPath.get(want);

      return row !== undefined && row.kind === kind;
    };

    if (await this.pollUntil(present, 5_000, 250)) {
      return;
    }

    // The typed name did not apply. Only a single new default-named entry may be renamed; anything else stops the push.
    const index = await this.ensureIndex([want]);
    const added = index.rows.filter((r) => r.parentPath === parentPath && !siblingsBefore.has(r.label));
    const defaults = added.filter((r) => /^(new-file|new-folder|untitled)/i.test(r.label));

    if (added.length === 0) {
      throw new UiChangedError(`Figma did not create ${want}.`);
    }

    if (added.length !== 1 || defaults.length !== 1) {
      throw new LeftoverFileError(parentPath, added.map((r) => r.label).join(", "));
    }

    const leftover = defaults[0]!;

    try {
      await this.renameIndexedRow(leftover, leaf);
    } catch (error) {
      if (error instanceof AutomationAbortedError) {
        throw error;
      }

      throw new LeftoverFileError(parentPath, leftover.label);
    }

    if (!(await this.pollUntil(present, 5_000, 250))) {
      throw new LeftoverFileError(parentPath, leftover.label);
    }
  }

  private async renameIndexedRow(row: IndexedRow, nextLabel: string): Promise<void> {
    const { locator } = await this.focusIndexedRow(row.path);

    await this.openContextMenuOn(locator.locator("button").first());
    await this.clickKey("renameAction", 4_000, () => this.expectNameInput());

    const input = await this.takeNameInput(row.kind, { rename: row.label });

    await this.replaceInlineFileName(input, nextLabel);
    await input.press("Enter");
    this.explorerIndex = null;
  }

  /** Switches "Show hidden files" in the Files actions menu. False when the menu has no such item. */
  private async setHiddenFilesShown(on: boolean): Promise<boolean> {
    if (!(await this.openFilesActionsMenu())) {
      return false;
    }

    const item = await this.tryFindVisible("showHiddenFilesToggle", 2_000);

    if (!item) {
      await this.closeMenu();
      return false;
    }

    const checked = await item.getAttribute("aria-checked").catch(() => null);

    if (checked !== null && (checked === "true") === on) {
      await this.closeMenu();
      this.hiddenFilesShown = on;
      return true;
    }

    await item.click();
    await this.pollUntil(async () => !(await this.isMenuOpen()), 1_000);
    await this.closeMenu();
    this.hiddenFilesShown = on;
    this.hiddenFilesToggledByUs = on;
    this.explorerIndex = null;

    return true;
  }

  // -------------------------------------------------------------------------
  // Tree resolution
  // -------------------------------------------------------------------------

  private async queryTree(
    treeRoot: Locator,
    args: TreeQueryArgs,
  ): Promise<TreeQueryResult> {
    return runPageScript<TreeQueryResult>(treeRoot, TREE_QUERY_SCRIPT, args);
  }

  /**
   * Resolves a full path. Returns null only after the whole (scrolled) tree was
   * inspected and the path is absent; operational failures throw.
   */
  private async locateTreeItem(
    segments: string[],
    options: LocateOptions,
  ): Promise<TreeHit | null> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);

    if (await this.usesAriaTree()) {
      // Current UI: the index is the only source of truth (fresh read: callers poll this after creating/uploading).
      const relativePath = segments.join("/");

      this.explorerIndex = null;

      const index = await this.ensureIndex([relativePath]);
      const row = index.byPath.get(relativePath);

      if (!row || (options.kind !== "any" && row.kind !== options.kind)) {
        return null;
      }

      const tag = await this.tagRow(treeRoot, row);

      if (!tag.ok) {
        return null;
      }

      return {
        locator: this.handle.page.locator(TARGET_SELECTOR).first(),
        active: tag.selected === true,
        activeSupported: index.selectionSupported,
        matchCount: index.duplicates.includes(relativePath) ? 2 : 1,
      };
    }

    const assumeExpandedAt: number[] = [];
    let scrollStep = -1;
    let originalScroll: number | null = null;
    let resume: TreeQueryArgs["resume"];

    for (let iteration = 0; iteration < 400; iteration += 1) {
      this.throwIfAborted();

      const args: TreeQueryArgs = {
        segments,
        kind: options.kind,
        expandLast: options.expandLast ?? false,
        list: false,
        assumeExpandedAt,
        resume,
      };
      const result = await this.queryTree(treeRoot, args);

      // Remember where the folder chain got to: once we scroll, its ancestor rows leave the (virtualised) page.
      if (result.status === "missing" && result.parentDepth !== undefined && result.childDepth !== undefined) {
        resume = { at: result.at, parentDepth: result.parentDepth, childDepth: result.childDepth };
      }

      if (result.status === "found") {
        return {
          locator: this.handle.page.locator(TARGET_SELECTOR).first(),
          active: result.active,
          activeSupported: result.activeSupported,
          matchCount: result.matchCount,
        };
      }

      if (result.status === "expand" && options.expand) {
        const folder = this.handle.page.locator(TARGET_SELECTOR).first();
        await folder.scrollIntoViewIfNeeded();
        await folder.click();

        const opened = await this.pollUntil(async () => {
          const next = await this.queryTree(treeRoot, args);
          return !(next.status === "expand" && next.at === result.at);
        }, 2_500);

        if (!opened) {
          // Empty folder (or no expansion signal): do not click it again.
          assumeExpandedAt.push(result.at);
        }

        continue;
      }

      if (!options.scan) {
        return null;
      }

      if ((await this.handle.page.locator('[data-testid="virtualized-file-tree-container"]').count()) > 0) {
        // The pixel-depth scan is unsafe across scroll windows of the virtualised explorer (that was the original
        // bug); its rows were simply not mounted yet. Fail loudly so the caller retries through the aria index.
        throw new UiChangedError(
          `The file list had not finished loading while looking for ${segments.join("/")}.`,
        );
      }

      const scroll = await runPageScript<{ original: number; atEnd?: boolean; [k: string]: unknown }>(treeRoot, TREE_SCROLL_SCRIPT, {
        step: scrollStep + 1,
      });

      if (scrollStep < 0) {
        originalScroll = scroll.original;
      }

      scrollStep += 1;

      if (scroll.done) {
        if (originalScroll !== null) {
          await runPageScript(treeRoot, TREE_SCROLL_SCRIPT, { restore: originalScroll }).catch(
            () => undefined,
          );
        }

        return null;
      }
    }

    throw new UiChangedError(
      `File tree resolution for ${segments.join("/")} did not converge.`,
    );
  }

  /** Direct children of a folder (root when empty), as currently rendered; null if the folder is missing. */
  private async listTreeChildren(
    folderSegments: string[],
  ): Promise<string[] | null> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);

    if (folderSegments.length === 0) {
      const result = await this.queryTree(treeRoot, {
        segments: [],
        kind: "folder",
        expandLast: false,
        list: true,
        assumeExpandedAt: [],
      });

      return result.status === "found" ? result.children : null;
    }

    const folder = await this.locateTreeItem(folderSegments, {
      kind: "folder",
      expand: true,
      expandLast: true,
      scan: true,
    });

    if (!folder) {
      return null;
    }

    const result = await this.queryTree(treeRoot, {
      segments: folderSegments,
      kind: "folder",
      expandLast: true,
      list: true,
      assumeExpandedAt: [],
    });

    return result.status === "found" ? result.children : null;
  }

  private async openRootFileTreeContextMenu(treeRoot: Locator): Promise<void> {
    const box = await treeRoot.boundingBox();

    if (!box) {
      throw new UiChangedError(
        "Unable to determine the file explorer bounds for root-level file creation.",
      );
    }

    await runPageScript(treeRoot, TREE_SCROLL_SCRIPT, { bottom: true }).catch(
      () => undefined,
    );

    await this.handle.page.mouse.click(
      box.x + Math.max(24, box.width / 2),
      box.y + Math.max(24, box.height - 20),
      { button: "right" },
    );
  }

  // -------------------------------------------------------------------------
  // Editor read / write / save
  // -------------------------------------------------------------------------

  private async resolveCodeMirrorTargets(editorRoot: Locator): Promise<Locator[]> {
    const nested = editorRoot.locator(".cm-content").first();

    return (await nested.count().catch(() => 0)) > 0
      ? [editorRoot, nested]
      : [editorRoot];
  }

  private async writeEditorContent(content: string, options: { strict?: boolean; relativePath?: string } = {}): Promise<void> {
    const editorRoot = await this.findVisible("codeEditorRoot", 6_000);
    let replaced = false;

    for (const target of await this.resolveCodeMirrorTargets(editorRoot)) {
      replaced = await tryReplaceCodeMirrorDocument(target, content).catch(
        () => false,
      );

      if (replaced) {
        break;
      }
    }

    if (!replaced) {
      const target = await this.findEditorInput();

      await target.click();
      await target.press(SELECT_ALL);
      await this.handle.page.keyboard.insertText(content);
    }

    // The keyboard fallback may trim or re-indent: its read-back is always strict.
    await this.verifyWrite(content, { strict: options.strict || !replaced, relativePath: options.relativePath ?? "" });
  }

  /** State-based replacement for fixed sleeps: waits until the editor shows the content. */
  private async verifyWrite(expected: string, options: { strict: boolean; relativePath: string }): Promise<void> {
    const strict = options.strict || this.context.config.adapter.verifyEditorWrites;
    const normalizedExpected = normalizeEol(expected);
    let readable = false;
    let lastActual = "";

    const matched = await this.pollUntil(async () => {
      try {
        lastActual = normalizeEol(await this.readActiveEditorContent());
        readable = true;
        return lastActual === normalizedExpected;
      } catch {
        return false;
      }
    }, 3_000);

    if (matched) {
      return;
    }

    if (!readable && !strict) {
      return;
    }

    throw new WriteNotVerifiedError(
      options.relativePath || "the file",
      readable ? "the editor shows different content after writing" : "the editor contents could not be read back",
    );
  }

  private async readEditorContentOrNull(): Promise<string | null> {
    try {
      return await this.readActiveEditorContent();
    } catch {
      return null;
    }
  }

  private async saveEditor(): Promise<void> {
    const saveButton = await this.tryFindVisible("saveButton", 2_000);

    if (!saveButton && (await this.readPersistenceStatus()) !== null) {
      // Autosave UI (no Save button): success = the persistence indicator settles. Only if it stays unsaved is the
      // Save control healed (post-condition: the indicator settles after the click).
      await this.settleWrites(2_000);

      if (await this.waitPersistenceIdle(10_000)) {
        return;
      }

      const healed = await this.healKey("saveButton", async (candidate) => {
        await candidate.click({ timeout: 5_000 });

        if (!(await this.waitPersistenceIdle(10_000))) {
          throw new UiChangedError("The editor still reports unsaved changes.");
        }
      });

      if (!healed) {
        this.context.logger.warn(
          "the editor still reports unsaved changes and no Save control was found",
        );
      }

      return;
    }

    if (saveButton) {
      await this.dismissFloatingOverlays();

      try {
        await saveButton.click({ timeout: 5_000 });
      } catch {
        // An overlay may intercept; close it and retry without bypassing actionability.
        await this.handle.page.keyboard.press("Escape").catch(() => undefined);
        await this.dismissFloatingOverlays();
        await saveButton.click({ timeout: 5_000 });
      }
    }

    // Autosave and explicit save both end in a mutating request; wait for it to
    // start (debounce window) and for the network to go quiet before the caller closes the browser.
    await this.settleWrites(2_000);

    if ((await this.readPersistenceStatus()) !== null) {
      await this.waitPersistenceIdle(10_000);
    }
  }

  /**
   * Waits until in-flight mutating requests finish and a short quiet period passes.
   * With startWindowMs > 0 also waits that long for an autosave request to start.
   */
  private async settleWrites(startWindowMs: number): Promise<void> {
    const started = Date.now();
    const deadline = started + 10_000;

    // eslint-disable-next-line @typescript-eslint/require-await
    await this.pollUntil(async () => {
      const now = Date.now();
      const sawMutation = this.mutationSeq > this.settledSeq;

      if (this.inflightMutations.size > 0) {
        return now >= deadline;
      }

      if (sawMutation) {
        return now - this.lastMutationAt >= 500 || now >= deadline;
      }

      return now - started >= startWindowMs;
    }, 11_000);

    this.settledSeq = this.mutationSeq;
  }

  private async readActiveEditorContent(): Promise<string> {
    const editorRoot = await this.findVisible("codeEditorRoot", 6_000);

    for (const target of await this.resolveCodeMirrorTargets(editorRoot)) {
      const codeMirrorValue = await tryReadCodeMirrorDocument(target).catch(
        () => null,
      );

      if (typeof codeMirrorValue === "string") {
        return codeMirrorValue;
      }
    }

    if (await isEditableCodeEditorRoot(editorRoot)) {
      return await editorRoot.evaluate(
        (node) => (node as HTMLElement).innerText ?? "",
      );
    }

    const textarea = editorRoot.locator("textarea").first();

    if (await isVisible(textarea, 500)) {
      return (await textarea.inputValue()) ?? "";
    }

    const contentEditable = editorRoot
      .locator('[contenteditable="true"]')
      .first();

    if (await isVisible(contentEditable, 500)) {
      return await contentEditable.evaluate(
        (node) => (node as HTMLElement).innerText ?? "",
      );
    }

    const monacoValue = await this.handle.page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & {
        monaco?: {
          editor?: {
            getModels?: () => Array<{
              getValue?: () => string;
              isDisposed?: () => boolean;
            }>;
          };
        };
      };

      const models = browserGlobal.monaco?.editor?.getModels?.() ?? [];
      const activeModel =
        models.find(
          (candidate: { isDisposed?: () => boolean }) =>
            !candidate.isDisposed?.(),
        ) ?? models[0];

      return activeModel?.getValue?.() ?? null;
    });

    if (typeof monacoValue === "string") {
      return monacoValue;
    }

    throw new UiChangedError(
      "Unable to read the active editor contents with the current selector strategy.",
    );
  }

  private async findEditorInput(): Promise<Locator> {
    const editorRoot = await this.findVisible("codeEditorRoot", 6_000);

    if (await isEditableCodeEditorRoot(editorRoot)) {
      return editorRoot;
    }

    const textarea = editorRoot.locator("textarea").first();

    if (await isVisible(textarea, 500)) {
      return textarea;
    }

    const contentEditable = editorRoot
      .locator('[contenteditable="true"]')
      .first();

    if (await isVisible(contentEditable, 500)) {
      return contentEditable;
    }

    return editorRoot;
  }

  /** Current text of the prompt box (textarea/input value, or the text of a contenteditable textbox). */
  private async readPromptValue(box: Locator): Promise<string> {
    return box.evaluate((node) => {
      const el = node as HTMLElement & { value?: unknown };

      return typeof el.value === "string" ? el.value : (el.innerText ?? el.textContent ?? "");
    });
  }

  /** Types the prompt into a textarea OR a contenteditable textbox and verifies the composer retained it. */
  private async fillPrompt(box: Locator, message: string): Promise<void> {
    const norm = (value: string): string => value.replaceAll(/\s+/g, " ").trim();
    const retained = async (): Promise<boolean> =>
      norm(await this.readPromptValue(box).catch(() => "")) === norm(message);

    await box.fill(message).catch(() => undefined);

    if (!(await retained())) {
      // Rich editors may ignore a programmatic fill; real insertText input events work.
      await box.click().catch(() => undefined);
      await box.press(SELECT_ALL).catch(() => undefined);
      await this.handle.page.keyboard.insertText(message);
    }

    if (!(await this.pollUntil(retained, 2_000))) {
      throw new FigmaAutomationError(
        "The prompt text was not retained by the composer.",
      );
    }
  }

  private async isPromptIdle(textarea: Locator): Promise<boolean> {
    if (await textarea.isDisabled().catch(() => true)) {
      return false;
    }

    return !(await this.isAnyVisibleNow("promptStopButton"));
  }

  // -------------------------------------------------------------------------
  // Selector resolution
  // -------------------------------------------------------------------------

  private async isAnyVisibleNow(key: SelectorKey): Promise<boolean> {
    const results = await Promise.all(
      this.sel(key).map((selector) =>
        this.handle.page
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false),
      ),
    );

    return results.some(Boolean);
  }

  private async findVisible(
    key: SelectorKey,
    timeoutMs = 6_000,
  ): Promise<Locator> {
    const locator = await this.tryFindVisible(key, timeoutMs);

    if (!locator) {
      throw new SelectorNotFoundError(key, this.sel(key));
    }

    return locator;
  }

  private async tryFindVisible(
    key: SelectorKey,
    timeoutMs = 2_000,
  ): Promise<Locator | null> {
    return this.tryFind(key, timeoutMs, "visible");
  }

  /**
   * Races all candidate selectors in parallel under one deadline. When several
   * match at once the earliest-listed visible one wins.
   */
  private async tryFind(
    key: SelectorKey,
    timeoutMs: number,
    state: "visible" | "attached",
  ): Promise<Locator | null> {
    this.throwIfAborted();

    const overrides = this.learnedCount(key);
    const locators = this.sel(key).map((selector) =>
      this.handle.page.locator(selector).first(),
    );

    if (locators.length === 0) {
      return null;
    }

    const attempts = locators.map(async (locator, index) => {
      await locator.waitFor({ state, timeout: timeoutMs });
      return index;
    });

    let winner: number;

    try {
      winner = await this.raceAbort(Promise.any(attempts));
    } catch (error) {
      if (error instanceof AutomationAbortedError) {
        throw error;
      }

      return null;
    }

    let chosen = winner;

    for (let index = 0; index < winner; index += 1) {
      const candidate = locators[index];

      if (
        candidate &&
        (state === "attached"
          ? (await candidate.count().catch(() => 0)) > 0
          : await candidate.isVisible().catch(() => false))
      ) {
        chosen = index;
        break;
      }
    }

    if (overrides > 0) {
      if (chosen < overrides) {
        this.context.heal?.store.recordHit(key);
      } else {
        await this.context.heal?.store.recordMiss(key);
      }
    }

    return locators[chosen] ?? null;
  }

  /** Learned overrides first, then the built-in / configured selectors (deduplicated). */
  private sel(key: SelectorKey): string[] {
    const learned = this.context.heal?.store.get(key) ?? [];

    if (learned.length === 0) {
      return this.selectors[key];
    }

    return [...learned, ...this.selectors[key].filter((s) => !learned.includes(s))];
  }

  private learnedCount(key: SelectorKey): number {
    return this.context.heal?.store.get(key).length ?? 0;
  }
}

export class PlaywrightFigmaMakeAdapter implements FigmaMakeAdapter {
  readonly kind = "playwright";

  private readonly sessionManager: BrowserSessionManager;

  constructor(private readonly context: AdapterContext) {
    this.sessionManager = new BrowserSessionManager({
      userDataDir: context.paths.browserProfileDir,
      artifactsDir: context.paths.artifactsDir,
      headless:
        context.config.adapter.headlessAutomation ??
        context.config.adapter.headless ??
        true,
      slowMoMs: context.config.adapter.slowMoMs,
      actionTimeoutMs: context.config.adapter.actionTimeoutMs,
      navigationTimeoutMs: context.config.adapter.navigationTimeoutMs,
      browserChannel: context.config.adapter.browserChannel,
      logger: context.logger,
    });
  }

  async authenticate(
    url: string,
    options?: AuthenticateBrowserSessionOptions,
  ): Promise<void> {
    await this.sessionManager.authenticate(url, {
      ...options,
      headless:
        options?.headless ?? this.context.config.adapter.headlessAuth ?? false,
    });
  }

  async openProject(
    url: string,
    options: OpenProjectOptions = {},
  ): Promise<FigmaMakeProjectSession> {
    if (options.signal?.aborted) {
      throw new AutomationAbortedError();
    }

    await this.context.heal?.store.load();
    const localSelectors = await loadLocalSelectors(this.context.heal?.localSelectorsPath);

    const handle = await this.sessionManager.openHandle("figma-make", url, {
      headless:
        this.context.config.adapter.headlessAutomation ??
        this.context.config.adapter.headless ??
        true,
    });
    const session = new PlaywrightFigmaMakeProjectSession(
      handle,
      this.context,
      options.signal,
      localSelectors,
    );

    try {
      await session.assertProjectLoaded();
    } catch (error) {
      await session.close();
      throw error;
    }

    return session;
  }
}

export function createPlaywrightAdapter(
  context: AdapterContext,
): FigmaMakeAdapter {
  return new PlaywrightFigmaMakeAdapter(context);
}
