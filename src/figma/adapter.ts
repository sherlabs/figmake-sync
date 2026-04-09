import path from "node:path";

import fs from "fs-extra";
import type { Locator } from "playwright";
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

export interface FigmaMakeProjectSession {
  downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult>;
  replaceFileContents(relativePath: string, content: string): Promise<void>;
  upsertFile(relativePath: string, content: string): Promise<void>;
  commitPendingChanges(): Promise<void>;
  uploadFiles(absolutePaths: string[], rootDir: string): Promise<UploadResult>;
  deletePath(relativePath: string): Promise<DeleteResult>;
  submitPrompt(message: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface FigmaMakeAdapter {
  readonly kind: string;
  authenticate(
    url: string,
    options?: AuthenticateBrowserSessionOptions,
  ): Promise<void>;
  openProject(url: string): Promise<FigmaMakeProjectSession>;
}

export type AdapterFactory = (context: AdapterContext) => FigmaMakeAdapter;

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
  | "deleteAction"
  | "renameAction"
  | "deleteConfirmButton"
  | "quickOpenInput";

type SelectorMap = Record<SelectorKey, string[]>;

// These selectors are intentionally isolated because the Figma Make UI is not a stable public API
// and will likely need adjustment over time.
export const DEFAULT_FIGMA_MAKE_SELECTORS: SelectorMap = {
  workspaceRoot: [
    '[data-testid="code-display-toggle"]',
    '[data-testid="header-nav-toolbar"]',
    '[data-testid="figmake-full-view"]',
  ],
  codeModeButton: [
    '[data-testid="code-display-toggle"] input[value="code"]',
    '[data-testid="code-display-toggle"] label:has-text("Code")',
    '[data-testid="code-display-toggle"]',
    '[aria-label="Code"]',
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
    'button:has-text("Save")',
    '[aria-label*="Save"]',
    '[data-testid="save-file"]',
  ],
  promptTextarea: [
    'textarea[data-testid="code-chat-chat-box"]',
    'textarea[placeholder*="Ask for changes"]',
    '[data-testid="composer-input"]',
  ],
  promptSendButton: [
    'button:has-text("Send")',
    '[aria-label*="Send"]',
    '[data-testid="composer-submit"]',
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
    'button:has-text("Delete")',
    'button:has-text("Confirm")',
    '[data-testid="confirm-delete"]',
  ],
  quickOpenInput: [
    'input[placeholder*="Open"]',
    'input[placeholder*="Go to"]',
    '[role="dialog"] input[type="search"]',
  ],
};

function sanitizeFileName(fileName: string): string {
  return fileName.replaceAll(/[^\w.-]+/g, "-");
}

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

class PlaywrightFigmaMakeProjectSession implements FigmaMakeProjectSession {
  private readonly selectors: SelectorMap;
  private hasPendingEditorChanges = false;

  constructor(
    private readonly handle: PersistentBrowserHandle,
    private readonly context: AdapterContext,
  ) {
    this.selectors = {
      ...DEFAULT_FIGMA_MAKE_SELECTORS,
      ...(context.config.adapter.selectorOverrides as Partial<SelectorMap>),
    };
  }

  async downloadLatestCodeZip(destinationDir: string): Promise<DownloadResult> {
    return this.handle.runStep("download-latest-code", async () => {
      await this.ensureCodeSurfaceReady();

      const downloadButton = await this.findVisible("downloadButton");
      const downloadPromise = this.handle.page.waitForEvent("download", {
        timeout: this.context.config.adapter.downloadTimeoutMs,
      });

      await downloadButton.click();

      const zipAction = await this.tryFindVisible("downloadZipAction", 2_000);

      if (zipAction) {
        await zipAction.click();
      }

      const download = await downloadPromise;
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
    await this.handle.runStep(`replace-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();
      await this.openFile(relativePath);
      await this.writeEditorContent(content);

      if (this.context.config.adapter.verifyEditorWrites) {
        await this.confirmActiveEditorContent(content);
      }

      this.hasPendingEditorChanges = true;
    });
  }

  async upsertFile(relativePath: string, content: string): Promise<void> {
    await this.handle.runStep(`upsert-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      const openedExisting = await this.tryOpenFile(relativePath);

      if (!openedExisting) {
        await this.createFile(relativePath);
      }

      await this.writeEditorContent(content);

      if (this.context.config.adapter.verifyEditorWrites) {
        await this.confirmActiveEditorContent(content);
      }

      this.hasPendingEditorChanges = true;
    });
  }

  async commitPendingChanges(): Promise<void> {
    if (!this.hasPendingEditorChanges) {
      return;
    }

    await this.handle.runStep("commit-pending-editor-changes", async () => {
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

    return this.handle.runStep("upload-files", async () => {
      await this.ensureCodeSurfaceReady();

      const uploadInput = await this.tryFindVisible("uploadInput", 2_000);

      if (uploadInput) {
        await uploadInput.setInputFiles(absolutePaths);

        return {
          uploaded: absolutePaths.map((absolutePath) =>
            path.posix.join(
              ...path.relative(rootDir, absolutePath).split(path.sep),
            ),
          ),
          unresolved: [],
        };
      }

      const uploadButton = await this.tryFindVisible("uploadButton", 2_000);

      if (uploadButton) {
        const fileChooserPromise = this.handle.page.waitForEvent(
          "filechooser",
          { timeout: 5_000 },
        );
        await uploadButton.click();
        const chooser = await fileChooserPromise;
        await chooser.setFiles(absolutePaths);

        return {
          uploaded: absolutePaths.map((absolutePath) =>
            path.posix.join(
              ...path.relative(rootDir, absolutePath).split(path.sep),
            ),
          ),
          unresolved: [],
        };
      }

      return {
        uploaded: [],
        unresolved: absolutePaths.map((absolutePath) => ({
          path: path.posix.join(
            ...path.relative(rootDir, absolutePath).split(path.sep),
          ),
          reason:
            "No upload control matched the configured Figma Make selectors.",
        })),
      };
    });
  }

  async deletePath(relativePath: string): Promise<DeleteResult> {
    return this.handle.runStep(`delete-${relativePath}`, async () => {
      await this.ensureCodeSurfaceReady();

      const target = await this.findTreeItem(relativePath).catch(() => null);

      if (!target) {
        return {
          path: relativePath,
          status: "unsupported",
          reason: "Could not locate the target item in the file explorer.",
        };
      }

      await target.click({ button: "right" });
      const deleteAction = await this.tryFindVisible("deleteAction", 2_000);

      if (!deleteAction) {
        return {
          path: relativePath,
          status: "unsupported",
          reason: "Delete action was not exposed by the current UI.",
        };
      }

      await deleteAction.click();

      const confirmDeleteButton = await this.tryFindVisible(
        "deleteConfirmButton",
        2_000,
      );

      if (confirmDeleteButton) {
        await confirmDeleteButton.click();
      }

      return {
        path: relativePath,
        status: "deleted",
      };
    });
  }

  async submitPrompt(message: string): Promise<boolean> {
    return this.handle.runStep("submit-prompt", async () => {
      await this.ensureCodeSurfaceReady();

      const promptTextarea = await this.tryFindVisible("promptTextarea", 2_000);

      if (!promptTextarea) {
        return false;
      }

      if (await promptTextarea.isDisabled().catch(() => false)) {
        return false;
      }

      await promptTextarea.fill(message);

      const sendButton = await this.tryFindVisible("promptSendButton", 2_000);

      if (sendButton) {
        await sendButton.click();
      } else {
        await promptTextarea.press("Meta+Enter").catch(async () => {
          await promptTextarea.press("Enter");
        });
      }

      return true;
    });
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async ensureCodeSurfaceReady(): Promise<void> {
    await this.dismissFloatingOverlays();
    await withRetry(
      async () => {
        const codeEditor = await this.tryFindVisible("codeEditorRoot", 2_000);

        if (codeEditor) {
          return;
        }

        const eagerCodeModeButton = await this.tryFindVisible(
          "codeModeButton",
          4_000,
        );

        if (eagerCodeModeButton) {
          await this.switchToCodeMode(eagerCodeModeButton);

          const editor = await this.findVisible("codeEditorRoot", 10_000);
          await editor.waitFor({ state: "visible" });
          return;
        }

        await this.findVisible("workspaceRoot", 12_000);

        const codeModeButton = await this.findVisible("codeModeButton", 8_000);
        await this.switchToCodeMode(codeModeButton);

        const editor = await this.findVisible("codeEditorRoot", 15_000);
        await editor.waitFor({ state: "visible" });
      },
      {
        attempts: 3,
        shouldRetry: () => true,
      },
    );
  }

  private async tryOpenFile(relativePath: string): Promise<boolean> {
    try {
      await this.openFile(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  private async openFile(relativePath: string): Promise<void> {
    const openedByTree = await this.openFileFromTree(relativePath).catch(
      () => false,
    );

    if (openedByTree) {
      return;
    }

    await this.openFileWithQuickOpen(relativePath);
  }

  private async openFileFromTree(relativePath: string): Promise<boolean> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);
    const segments = relativePath.split("/").filter(Boolean);

    if (segments.length === 0) {
      return false;
    }

    if (segments.length === 1) {
      const [leaf] = segments;

      if (!leaf) {
        return false;
      }

      const target = await this.findTreeItem(leaf, treeRoot, "file");
      await target.scrollIntoViewIfNeeded();
      await target.click();

      const editor = await this.tryFindVisible("codeEditorRoot", 4_000);

      return Boolean(editor);
    }

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      const nextSegment = segments[index + 1];

      if (!segment || !nextSegment) {
        continue;
      }

      const nextItem = await this.tryFindTreeItem(nextSegment, treeRoot);

      if (!nextItem) {
        const folder = await this.findTreeItem(segment, treeRoot, "folder");
        await folder.scrollIntoViewIfNeeded();
        await folder.click();
      }
    }

    const leaf = segments.at(-1);

    if (!leaf) {
      return false;
    }

    const target = await this.findTreeItem(leaf, treeRoot, "file");
    await target.scrollIntoViewIfNeeded();
    await target.click();

    const editor = await this.tryFindVisible("codeEditorRoot", 4_000);

    return Boolean(editor);
  }

  private async openFileWithQuickOpen(relativePath: string): Promise<void> {
    await this.handle.page.keyboard.press("Meta+P");

    const quickOpenInput = await this.tryFindVisible("quickOpenInput", 3_000);

    if (!quickOpenInput) {
      throw new Error(
        `Unable to open ${relativePath} from the file explorer, and the current Figma Make UI did not expose a quick-open input.`,
      );
    }

    await quickOpenInput.fill(relativePath);
    await quickOpenInput.press("Enter");
    await this.findVisible("codeEditorRoot", 10_000);
  }

  private async createFile(relativePath: string): Promise<void> {
    const treeRoot = await this.findVisible("fileTreeRoot", 6_000);
    const segments = relativePath.split("/").filter(Boolean);
    const leaf = segments.at(-1);

    if (!leaf) {
      throw new Error(`Unable to derive a file name from ${relativePath}.`);
    }

    const parentSegments = segments.slice(0, -1);
    const directNewFileButton = await this.tryFindVisible("newFileButton", 1_500);

    if (directNewFileButton) {
      await directNewFileButton.click();
    } else if (parentSegments.length > 0) {
      await this.expandFolderPath(parentSegments, treeRoot);

      const parentFolder = await this.findTreeItem(
        parentSegments.at(-1) ?? "",
        treeRoot,
        "folder",
      );
      await parentFolder.scrollIntoViewIfNeeded();
      await parentFolder.click({ button: "right" });

      const createFileAction = await this.findVisible("createFileAction", 4_000);
      await createFileAction.click();
    } else {
      await this.openRootFileTreeContextMenu(treeRoot);

      const createFileAction = await this.findVisible("createFileAction", 4_000);
      await createFileAction.click();
    }

    const newFileInput = await this.findVisible("newFileInput", 4_000);
    await this.replaceInlineFileName(newFileInput, leaf);
    await newFileInput.press("Enter");
    await this.ensureExactCreatedFile(relativePath, leaf, treeRoot);
  }

  private async writeEditorContent(content: string): Promise<void> {
    const editorRoot = await this.findVisible("codeEditorRoot", 6_000);
    const replacedWithCodeMirror = await tryReplaceCodeMirrorDocument(
      editorRoot,
      content,
    );

    if (replacedWithCodeMirror) {
      await this.handle.page.waitForTimeout(250);
      return;
    }

    const target = await this.findEditorInput();

    await target.click();
    await target.press("Meta+A");
    await this.handle.page.keyboard.insertText(content);
  }

  private async saveEditor(): Promise<void> {
    const saveButton = await this.tryFindVisible("saveButton", 2_000);

    if (saveButton) {
      // Dismiss any floating overlays that may intercept pointer events
      await this.dismissFloatingOverlays();

      try {
        await saveButton.click({ timeout: 5_000 });
      } catch {
        // Overlay may still intercept — force click as fallback
        await saveButton.click({ force: true });
      }
      return;
    }

    // The current Figma Make editor autosaves changes and may bind Meta+S to
    // formatting or browser-level actions instead of an explicit save.
    await this.handle.page.waitForTimeout(500);
  }

  private async dismissFloatingOverlays(): Promise<void> {
    const overlays = this.handle.page.locator(
      '[data-fpl-floating-overlay="true"]',
    );
    const count = await overlays.count();
    for (let i = 0; i < count; i++) {
      try {
        await overlays.nth(i).evaluate((el) => el.remove());
      } catch {
        // Overlay already gone
      }
    }
  }

  private async confirmActiveEditorContent(
    expectedContent: string,
  ): Promise<void> {
    const actualContent = await this.readActiveEditorContent();
    const normalizedActual = actualContent.replaceAll("\r\n", "\n");
    const normalizedExpected = expectedContent.replaceAll("\r\n", "\n");

    if (normalizedActual !== normalizedExpected) {
      throw new Error(
        "Editor content did not match the expected file contents after save.",
      );
    }
  }

  private async readActiveEditorContent(): Promise<string> {
    const editorRoot = await this.findVisible("codeEditorRoot", 6_000);
    const codeMirrorValue = await tryReadCodeMirrorDocument(editorRoot);

    if (typeof codeMirrorValue === "string") {
      return codeMirrorValue;
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

    throw new Error(
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

  private async findTreeItem(
    label: string,
    scope?: Locator,
    kind: "file" | "folder" | "any" = "any",
  ): Promise<Locator> {
    const locator = await this.tryFindTreeItem(label, scope, kind);

    if (locator) {
      return locator;
    }

    throw new Error(`Unable to locate file tree item for ${label}.`);
  }

  private async tryFindTreeItem(
    label: string,
    scope?: Locator,
    kind: "file" | "folder" | "any" = "any",
  ): Promise<Locator | null> {
    const primaryScope = scope ?? this.handle.page.locator("body");
    const visibleMatch = await this.findTreeItemInVisibleViewport(
      label,
      primaryScope,
      kind,
    );

    if (visibleMatch) {
      return visibleMatch;
    }

    const scrollContainer = await this.tryFindFileTreeScrollContainer(scope);

    if (!scrollContainer) {
      return null;
    }

    const originalScrollTop = await scrollContainer.evaluate(
      (element) => element.scrollTop,
    );
    const maxScrollTop = await scrollContainer.evaluate(
      (element) => Math.max(0, element.scrollHeight - element.clientHeight),
    );
    const stepSize = await scrollContainer.evaluate((element) =>
      Math.max(160, Math.floor(element.clientHeight * 0.8)),
    );

    for (let scrollTop = 0; scrollTop <= maxScrollTop; scrollTop += stepSize) {
      await scrollContainer.evaluate((element, value) => {
        element.scrollTop = value;
      }, scrollTop);
      await this.handle.page.waitForTimeout(120);

      const scrolledMatch = await this.findTreeItemInVisibleViewport(
        label,
        primaryScope,
        kind,
      );

      if (scrolledMatch) {
        return scrolledMatch;
      }
    }

    await scrollContainer.evaluate((element, value) => {
      element.scrollTop = value;
    }, originalScrollTop);

    return null;
  }

  private async expandFolderPath(
    folderSegments: readonly string[],
    treeRoot: Locator,
  ): Promise<void> {
    for (let index = 0; index < folderSegments.length - 1; index += 1) {
      const segment = folderSegments[index];
      const nextSegment = folderSegments[index + 1];

      if (!segment || !nextSegment) {
        continue;
      }

      const nextItem = await this.tryFindTreeItem(nextSegment, treeRoot, "any");

      if (!nextItem) {
        const folder = await this.findTreeItem(segment, treeRoot, "folder");
        await folder.scrollIntoViewIfNeeded();
        await folder.click();
      }
    }
  }

  private async replaceInlineFileName(
    input: Locator,
    nextValue: string,
  ): Promise<void> {
    await input.click({ force: true });
    await input.press("Meta+A").catch(() => undefined);
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
      throw new Error(
        `Unable to set the inline file name input to ${nextValue}.`,
      );
    }
  }

  private async ensureExactCreatedFile(
    relativePath: string,
    expectedLeaf: string,
    treeRoot: Locator,
  ): Promise<void> {
    await this.handle.page.waitForTimeout(300);

    const exactFile = await this.tryFindTreeItem(expectedLeaf, treeRoot, "file");

    if (exactFile) {
      await exactFile.scrollIntoViewIfNeeded();
      await exactFile.click();
      await this.findVisible("codeEditorRoot", 10_000);
      return;
    }

    const fallbackLeaf = this.deriveDefaultNewFileName(expectedLeaf);
    const fallbackFile = await this.tryFindTreeItem(fallbackLeaf, treeRoot, "file");

    if (!fallbackFile) {
      throw new Error(
        `Created file did not appear in the explorer as ${expectedLeaf} or ${fallbackLeaf}.`,
      );
    }

    await this.renameTreeItem(fallbackLeaf, expectedLeaf, treeRoot);
    const renamedFile = await this.findTreeItem(expectedLeaf, treeRoot, "file");
    await renamedFile.scrollIntoViewIfNeeded();
    await renamedFile.click();
    await this.findVisible("codeEditorRoot", 10_000);
  }

  private deriveDefaultNewFileName(expectedLeaf: string): string {
    const extension = path.posix.extname(expectedLeaf);

    if (!extension) {
      return "new-file";
    }

    return `new-file${extension}`;
  }

  private async renameTreeItem(
    currentLabel: string,
    nextLabel: string,
    treeRoot: Locator,
  ): Promise<void> {
    const target = await this.findTreeItem(currentLabel, treeRoot, "file");
    await target.scrollIntoViewIfNeeded();
    await target.click({ button: "right" });

    const renameAction = await this.findVisible("renameAction", 4_000);
    await renameAction.click();

    const renameInput = await this.findVisible("newFileInput", 4_000);
    await this.replaceInlineFileName(renameInput, nextLabel);
    await renameInput.press("Enter");
    await this.findTreeItem(nextLabel, treeRoot, "file");
  }

  private async findTreeItemInVisibleViewport(
    label: string,
    scope: Locator,
    kind: "file" | "folder" | "any",
  ): Promise<Locator | null> {
    const exactLabel = new RegExp(`^${escapeForRegExp(label)}$`);
    const candidates: Locator[] = [];

    if (kind !== "folder") {
      candidates.push(
        scope
          .getByRole("button", { name: `File "${label}"`, exact: true })
          .first(),
      );
      candidates.push(
        scope
          .locator('button[data-testid="code-file-item"]')
          .filter({ hasText: exactLabel })
          .first(),
      );
    }

    if (kind !== "file") {
      candidates.push(
        scope
          .getByRole("button", { name: `Folder "${label}"`, exact: true })
          .first(),
      );
      candidates.push(
        scope
          .locator('[data-folder-item="true"] button')
          .filter({ hasText: exactLabel })
          .first(),
      );
    }

    for (const candidate of candidates) {
      if (await isVisible(candidate, 500)) {
        return candidate;
      }
    }

    return null;
  }

  private async openRootFileTreeContextMenu(treeRoot: Locator): Promise<void> {
    const scrollContainer = await this.tryFindFileTreeScrollContainer(treeRoot);

    if (!scrollContainer) {
      throw new Error(
        "Unable to locate the file explorer scroll container for root-level file creation.",
      );
    }

    const box = await scrollContainer.boundingBox();

    if (!box) {
      throw new Error(
        "Unable to determine the file explorer bounds for root-level file creation.",
      );
    }

    await scrollContainer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await this.handle.page.waitForTimeout(150);

    await this.handle.page.mouse.click(
      box.x + Math.max(24, box.width / 2),
      box.y + Math.max(24, box.height - 20),
      { button: "right" },
    );
  }

  private async tryFindFileTreeScrollContainer(
    scope?: Locator,
  ): Promise<Locator | null> {
    const searchRoot = scope ?? this.handle.page.locator("body");
    const treeItem = searchRoot
      .locator(
        'button[data-testid="code-file-item"], [data-folder-item="true"] button',
      )
      .first();

    if (await isVisible(treeItem, 1_500)) {
      const scopedContainer = treeItem
        .locator('xpath=ancestor::div[contains(@style, "overflow: auto")][1]')
        .first();

      if (await isVisible(scopedContainer, 500)) {
        return scopedContainer;
      }
    }

    const fallbackItem = this.handle.page
      .locator(
        'button[data-testid="code-file-item"], [data-folder-item="true"] button',
      )
      .first();

    if (!(await isVisible(fallbackItem, 1_500))) {
      return null;
    }

    const fallbackContainer = fallbackItem
      .locator('xpath=ancestor::div[contains(@style, "overflow: auto")][1]')
      .first();

    if (await isVisible(fallbackContainer, 500)) {
      return fallbackContainer;
    }

    return null;
  }

  private async findVisible(
    key: SelectorKey,
    timeoutMs = 6_000,
  ): Promise<Locator> {
    const locator = await this.tryFindVisible(key, timeoutMs);

    if (!locator) {
      const selectors = this.selectors[key].join(", ");
      throw new Error(
        `Unable to resolve Figma Make selector "${key}" using: ${selectors}`,
      );
    }

    return locator;
  }

  private async tryFindVisible(
    key: SelectorKey,
    timeoutMs = 2_000,
  ): Promise<Locator | null> {
    for (const selector of this.selectors[key]) {
      const locator = this.handle.page.locator(selector).first();

      try {
        await locator.waitFor({ state: "visible", timeout: timeoutMs });
        return locator;
      } catch {
        // Try the next fallback selector.
      }
    }

    return null;
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

  async openProject(url: string): Promise<FigmaMakeProjectSession> {
    const handle = await this.sessionManager.openHandle("figma-make", url, {
      headless:
        this.context.config.adapter.headlessAutomation ??
        this.context.config.adapter.headless ??
        true,
    });

    return new PlaywrightFigmaMakeProjectSession(handle, this.context);
  }
}

export function createPlaywrightAdapter(
  context: AdapterContext,
): FigmaMakeAdapter {
  return new PlaywrightFigmaMakeAdapter(context);
}
