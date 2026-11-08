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
import { withRetry } from "../utils/retry.js";

export interface AdapterContext {
  config: ProjectConfig;
  logger: Logger;
  paths: ProjectStatePaths;
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
}

export interface OpenProjectOptions {
  /** Aborting closes the browser and rejects in-flight waits with AutomationAbortedError. */
  signal?: AbortSignal;
}

export interface FigmaMakeProjectSession {
  downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult>;
  replaceFileContents(relativePath: string, content: string): Promise<void>;
  upsertFile(relativePath: string, content: string): Promise<void>;
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

function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof AuthRequiredError ||
    error instanceof ProjectUnavailableError ||
    error instanceof AutomationAbortedError ||
    error instanceof WrongFileError
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
    /\b(log ?in|sign ?in) to (your )?figma\b|\blog in or sign up\b|\bcontinue with (google|sso)\b/i.test(
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
  | { status: "missing"; at: number };

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

  for (let k = 0; k < segs.length; k += 1) {
    const isLast = k === segs.length - 1;
    const wantKind = isLast ? args.kind : "folder";
    let found = -1;
    let count = 0;
    let childDepth: number | null = null;

    for (let i = parentIdx + 1; i < rows.length; i += 1) {
      const row = rows[i]!;

      if (k === 0) {
        if (row.depth !== minDepth) {
          continue;
        }
      } else {
        if (row.depth <= parentDepth) {
          break;
        }

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
      return { status: "missing", at: k };
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
  const rows = partial.map((row, i) => ({
    ...row,
    depth: useNest
      ? nest[i]!
      : usePx
        ? Math.round(box[i]! / 2)
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
// Selectors
// ---------------------------------------------------------------------------

type SelectorKey =
  | "workspaceRoot"
  | "codeModeButton"
  | "codeEditorRoot"
  | "fileTreeRoot"
  | "downloadButton"
  | "downloadZipAction"
  | "uploadInput"
  | "uploadButton"
  | "newFileButton"
  | "createFileAction"
  | "newFileInput"
  | "saveButton"
  | "promptTextarea"
  | "promptSendButton"
  | "promptStopButton"
  | "deleteAction"
  | "renameAction"
  | "deleteConfirmButton"
  | "quickOpenInput";

type SelectorMap = Record<SelectorKey, string[]>;

// These selectors are intentionally isolated because the Figma Make UI is not a stable public API
// and will likely need adjustment over time.
export const DEFAULT_FIGMA_MAKE_SELECTORS: SelectorMap = {
  workspaceRoot: [
    '[data-radio-options-root="true"]',
    '[data-testid="code-display-toggle"]',
    '[data-testid="header-nav-toolbar"]',
    '[data-testid="figmake-full-view"]',
  ],
  codeModeButton: [
    '[data-radio-options-root="true"] input[value="code"]',
    'input[type="radio"][value="code"][data-tooltip="Code"]',
    'input[type="radio"][value="code"]',
    '[data-testid="code-display-toggle"] input[value="code"]',
    '[data-testid="code-display-toggle"] label:has-text("Code")',
    '[data-testid="code-display-toggle"]',
    '[aria-label="Code"]',
    'button[aria-label="Code"]',
    '[role="radio"][value="code"]',
    '[role="tab"]:has-text("Code")',
    'label:has-text("Code")',
  ],
  codeEditorRoot: [
    '[data-testid="code-editor"]',
    '.cm-content[role="textbox"]',
    ".cm-editor",
    ".monaco-editor",
  ],
  fileTreeRoot: [
    'div:has(button[data-testid="code-file-item"])',
    'div:has([data-folder-item="true"])',
    'div:has(h2:has-text("Files"))',
  ],
  downloadButton: [
    'button[aria-label="Download code"]',
    'button[data-tooltip="Download code"]',
    '[data-testid="download-code"]',
  ],
  downloadZipAction: [
    '[role="menuitem"]:has-text("ZIP")',
    '[role="menuitem"]:has-text("Download code")',
    "text=/download.*zip/i",
  ],
  uploadInput: [
    '[data-testid="code-upload-input"]',
    'input[type="file"][webkitdirectory]',
    '[data-testid="upload-input"]',
  ],
  uploadButton: [
    'button[aria-label="Upload files"]',
    'button:has-text("Upload files")',
    '[data-testid="code-upload-button"]',
  ],
  newFileButton: ['button:has-text("New file")', '[data-testid="new-file"]'],
  createFileAction: [
    '[role="menuitem"]:has-text("Create file")',
    'button:has-text("Create file")',
  ],
  newFileInput: [
    'input[data-testid="code-file-name-input"]:focus',
    'input[data-testid="code-file-name-input"][value="new-file.tsx"]',
    'input[placeholder*="file"]',
    '[role="dialog"] input[type="text"]',
    '[data-testid="new-file-input"]',
    'input[data-testid="code-file-name-input"]',
  ],
  saveButton: [
    'button[aria-label="Save"]',
    'button:text-is("Save")',
    '[data-testid="save-file"]',
  ],
  promptTextarea: [
    'textarea[data-testid="code-chat-chat-box"]',
    'textarea[placeholder*="Ask for changes"]',
    '[data-testid="composer-input"]',
  ],
  promptSendButton: [
    '[data-testid="composer-submit"]',
    'button[aria-label^="Send" i]',
    'button:text-is("Send")',
  ],
  promptStopButton: [
    '[data-testid="composer-stop"]',
    'button[aria-label^="Stop" i]',
  ],
  deleteAction: [
    '[role="menuitem"]:has-text("Delete")',
    'button:has-text("Delete")',
  ],
  renameAction: [
    '[role="menuitem"]:has-text("Rename")',
    'button:has-text("Rename")',
  ],
  deleteConfirmButton: [
    '[role="dialog"] button:has-text("Delete")',
    '[role="alertdialog"] button:has-text("Delete")',
    '[role="dialog"] button:has-text("Confirm")',
    '[role="alertdialog"] button:has-text("Confirm")',
    '[data-testid="confirm-delete"]',
  ],
  quickOpenInput: [
    'input[placeholder*="Open"]',
    'input[placeholder*="Go to"]',
    'input[placeholder*="Search"]',
    'input[placeholder*="file"]',
    '[role="dialog"] input[type="search"]',
    '[role="combobox"][aria-label*="file" i]',
    '[role="dialog"] input[type="text"]',
  ],
};

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

class PlaywrightFigmaMakeProjectSession implements FigmaMakeProjectSession {
  private readonly selectors: SelectorMap;
  private hasPendingEditorChanges = false;
  private activePath: string | null = null;
  private closePromise: Promise<void> | null = null;

  private readonly inflightMutations = new Set<Request>();
  private mutationSeq = 0;
  private settledSeq = 0;
  private lastMutationAt = 0;

  constructor(
    private readonly handle: PersistentBrowserHandle,
    private readonly context: AdapterContext,
    private readonly signal?: AbortSignal,
  ) {
    this.selectors = {
      ...DEFAULT_FIGMA_MAKE_SELECTORS,
      ...(context.config.adapter.selectorOverrides as Partial<SelectorMap>),
    };

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

      const downloadButton = await this.findVisible("downloadButton");
      const downloadPromise = this.handle.page.waitForEvent("download", {
        timeout: this.context.config.adapter.downloadTimeoutMs,
      });
      // The click may fail before the download starts; do not leak the rejection.
      downloadPromise.catch(() => undefined);

      await downloadButton.click();

      const zipAction = await this.tryFindVisible("downloadZipAction", 2_000);

      if (zipAction) {
        await zipAction.click();
      }

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

  async replaceFileContents(
    relativePath: string,
    content: string,
  ): Promise<void> {
    await this.step(`replace-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();
      await this.openFile(relativePath);
      await this.writeEditorContent(content);
      this.hasPendingEditorChanges = true;
      await this.settleWrites(0);
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
        await this.createFile(relativePath);
      }

      await this.writeEditorContent(content);
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
      let failure = "";

      const uploadInput = await this.tryFind("uploadInput", 2_000, "attached");

      if (uploadInput) {
        await uploadInput.setInputFiles(flatPaths);
        attempted = true;
      } else {
        const uploadButton = await this.tryFindVisible("uploadButton", 2_000);

        if (uploadButton) {
          try {
            const [chooser] = await Promise.all([
              this.handle.page.waitForEvent("filechooser", { timeout: 5_000 }),
              uploadButton.click(),
            ]);
            await chooser.setFiles(flatPaths);
            attempted = true;
          } catch (error) {
            if (error instanceof AutomationAbortedError) {
              throw error;
            }

            failure = `File chooser upload failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        } else {
          failure =
            "No upload control matched the configured Figma Make selectors.";
        }
      }

      if (!attempted) {
        for (const entry of flat) {
          unresolved.push({ path: entry.relativePath, reason: failure });
        }

        return { uploaded: [], unresolved };
      }

      const uploaded: string[] = [];

      for (const entry of flat) {
        const appeared = await this.pollUntil(
          async () =>
            Boolean(
              await this.locateTreeItem(splitPath(entry.relativePath), {
                kind: "file",
                expand: false,
                scan: false,
              }),
            ),
          8_000,
        );

        if (appeared) {
          uploaded.push(entry.relativePath);
        } else {
          unresolved.push({
            path: entry.relativePath,
            reason: "Uploaded file did not appear in the file explorer.",
          });
        }
      }

      return { uploaded, unresolved };
    });
  }

  async deletePath(relativePath: string): Promise<DeleteResult> {
    return this.step(`delete-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      const segments = splitPath(relativePath);
      const target = await this.locateTreeItem(segments, {
        kind: "any",
        expand: true,
        scan: true,
      });

      if (!target) {
        return {
          path: relativePath,
          status: "deleted",
          reason: "Item is not present in the file explorer.",
        } satisfies DeleteResult;
      }

      await target.locator.scrollIntoViewIfNeeded();
      await target.locator.click({ button: "right" });
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
      const confirmDeleteButton = await this.tryFindVisible(
        "deleteConfirmButton",
        2_000,
      );

      if (confirmDeleteButton) {
        await confirmDeleteButton.click();
      }

      const gone = await this.pollUntil(
        async () =>
          !(await this.locateTreeItem(segments, {
            kind: "any",
            expand: false,
            scan: false,
          })),
        6_000,
      );

      if (!gone) {
        return {
          path: relativePath,
          status: "failed",
          reason: "Item was still present in the file explorer after delete.",
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

      const promptTextarea = await this.findVisible("promptTextarea", 4_000);

      const idleBefore = await this.pollUntil(
        () => this.isPromptIdle(promptTextarea),
        PROMPT_IDLE_TIMEOUT_MS,
        250,
      );

      if (!idleBefore) {
        throw new AutomationTimeoutError(
          "The prompt composer stayed busy; the previous generation did not finish.",
        );
      }

      await promptTextarea.fill(message);

      if ((await promptTextarea.inputValue().catch(() => message)) !== message) {
        throw new FigmaAutomationError(
          "The prompt text was not retained by the composer.",
        );
      }

      const sendButton = await this.tryFindVisible("promptSendButton", 2_000);

      if (sendButton) {
        await this.pollUntil(
          async () => sendButton.isEnabled().catch(() => true),
          3_000,
        );
        await sendButton.click();
      } else {
        await promptTextarea.press(SUBMIT_SHORTCUT);
      }

      const accepted = async (): Promise<boolean> =>
        (await promptTextarea.inputValue().catch(() => "")) === "" ||
        (await promptTextarea.isDisabled().catch(() => false)) ||
        (await this.isAnyVisibleNow("promptStopButton"));

      let wasAccepted = await this.pollUntil(accepted, 5_000);

      if (!wasAccepted) {
        await promptTextarea.press(SUBMIT_SHORTCUT);
        wasAccepted = await this.pollUntil(accepted, 3_000);
      }

      if (!wasAccepted) {
        await promptTextarea.press("Enter");
        wasAccepted = await this.pollUntil(accepted, 3_000);
      }

      if (!wasAccepted) {
        throw new FigmaAutomationError(
          "The composer did not accept the prompt (textarea was never cleared).",
        );
      }

      // Busy phase may be too short to observe; idle is what matters.
      await this.pollUntil(async () => !(await this.isPromptIdle(promptTextarea)), 5_000);

      const finished = await this.pollUntil(
        () => this.isPromptIdle(promptTextarea),
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

    const { text, hasPasswordInput } = await page.evaluate(() => ({
      text: (document.body?.innerText ?? "").slice(0, 4_000),
      hasPasswordInput: Boolean(
        document.querySelector(
          'input[type="password"], input[name="password"], form[action*="login"]',
        ),
      ),
    }));

    return classifyPageState({ url: page.url(), text, hasPasswordInput });
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
        const codeModeButton = await this.tryFindVisible("codeModeButton", 20_000);

        if (!codeModeButton) {
          const lateState = await this.classifyPage();

          if (lateState) {
            throw errorFromPageState(lateState);
          }

          if (await this.isAnyVisibleNow("workspaceRoot")) {
            throw new UiChangedError(
              `Figma Make workspace loaded but no code-mode control matched: ${this.selectors.codeModeButton.join(", ")}`,
            );
          }

          throw new SelectorNotFoundError(
            "workspaceRoot",
            this.selectors.workspaceRoot,
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
      const quickOpenInput = await this.tryFindVisible("quickOpenInput", 2_000);

      if (quickOpenInput) {
        await quickOpenInput.fill(relativePath);
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

  private async createFile(relativePath: string): Promise<void> {
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
      await (await this.findVisible("createFileAction", 4_000)).click();
    } else {
      const directNewFileButton = await this.tryFindVisible("newFileButton", 1_500);

      if (directNewFileButton) {
        await directNewFileButton.click();
      } else {
        await this.openRootFileTreeContextMenu(treeRoot);
        await (await this.findVisible("createFileAction", 4_000)).click();
      }
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
    await (await this.findVisible("renameAction", 4_000)).click();

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
  // Tree resolution
  // -------------------------------------------------------------------------

  private async queryTree(
    treeRoot: Locator,
    args: TreeQueryArgs,
  ): Promise<TreeQueryResult> {
    return (await treeRoot.evaluate(
      TREE_QUERY_SCRIPT,
      args,
    ));
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
    const assumeExpandedAt: number[] = [];
    let scrollStep = -1;
    let originalScroll: number | null = null;

    for (let iteration = 0; iteration < 400; iteration += 1) {
      this.throwIfAborted();

      const args: TreeQueryArgs = {
        segments,
        kind: options.kind,
        expandLast: options.expandLast ?? false,
        list: false,
        assumeExpandedAt,
      };
      const result = await this.queryTree(treeRoot, args);

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

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const scroll = (await treeRoot.evaluate(TREE_SCROLL_SCRIPT, {
        step: scrollStep + 1,
      })) as { original: number; atEnd?: boolean; [k: string]: unknown };

      if (scrollStep < 0) {
        originalScroll = scroll.original;
      }

      scrollStep += 1;

      if (scroll.done) {
        if (originalScroll !== null) {
          await treeRoot
            .evaluate(TREE_SCROLL_SCRIPT, { restore: originalScroll })
            .catch(() => undefined);
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

    await treeRoot.evaluate(TREE_SCROLL_SCRIPT, { bottom: true }).catch(
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

  private async writeEditorContent(content: string): Promise<void> {
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

    await this.verifyWrite(content);
  }

  /** State-based replacement for fixed sleeps: waits until the editor shows the content. */
  private async verifyWrite(expected: string): Promise<void> {
    const strict = this.context.config.adapter.verifyEditorWrites;
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

    throw new FigmaAutomationError(
      readable
        ? "Editor content did not match the expected file contents after writing."
        : "Unable to read back the editor contents to verify the write.",
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
      this.selectors[key].map((selector) =>
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
      throw new SelectorNotFoundError(key, this.selectors[key]);
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

    const locators = this.selectors[key].map((selector) =>
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

    for (let index = 0; index < winner; index += 1) {
      const candidate = locators[index];

      if (
        candidate &&
        (state === "attached"
          ? (await candidate.count().catch(() => 0)) > 0
          : await candidate.isVisible().catch(() => false))
      ) {
        return candidate;
      }
    }

    return locators[winner] ?? null;
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
