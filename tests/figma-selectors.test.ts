import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FIGMA_MAKE_SELECTORS } from "../src/figma/adapter.js";
import {
  DEFAULT_SELECTOR_TABLE,
  SELECTOR_KEYS,
  layerSelectors,
  loadLocalSelectors,
  parseLocalSelectors,
  parseSelectorTable,
  selectorMapOf,
} from "../src/figma/selectors.js";
import { HEALABLE, isHealable } from "../src/heal/healable.js";
import { validateSelectorGrammar } from "../src/heal/selectorGrammar.js";

const rawDefaults = (): { version: 1; keys: Record<string, Record<string, unknown>> } =>
  JSON.parse(fs.readFileSync(new URL("../src/figma/selectors.default.json", import.meta.url), "utf8")) as never;

describe("selectors.default.json", () => {
  it("is valid against the schema and covers exactly the known keys", () => {
    const table = parseSelectorTable(rawDefaults());
    expect(Object.keys(table).sort()).toEqual([...SELECTOR_KEYS].sort());
    for (const key of SELECTOR_KEYS) expect(table[key].selectors.length, key).toBeGreaterThan(0);
  });

  it("DEFAULT_FIGMA_MAKE_SELECTORS is derived from the JSON", () => {
    expect(DEFAULT_FIGMA_MAKE_SELECTORS).toEqual(selectorMapOf(DEFAULT_SELECTOR_TABLE));
    expect(DEFAULT_FIGMA_MAKE_SELECTORS.codeModeButton[0]).toContain("Files");
  });

  it("puts live-verified selectors first and keeps older ones as fallbacks", () => {
    expect(DEFAULT_FIGMA_MAKE_SELECTORS.promptSendButton[0]).toBe('[data-testid="code-chat-send-button"]');
    expect(DEFAULT_FIGMA_MAKE_SELECTORS.promptSendButton).toContain('[data-testid="composer-submit"]');
    expect(DEFAULT_FIGMA_MAKE_SELECTORS.downloadZipAction[0]).toContain("Download code");
    expect(DEFAULT_FIGMA_MAKE_SELECTORS.codeModeButton).toContain('[data-testid="code-display-toggle"]');
    expect(DEFAULT_FIGMA_MAKE_SELECTORS.filesActionsMenuButton[0]).toBe('[data-testid="files-header-actions-menu-button"]');
  });

  it("rejects malformed tables", () => {
    const base = rawDefaults();
    const clone = (): typeof base => structuredClone(base);

    const missing = clone();
    delete missing.keys["quickOpenInput"];
    expect(() => parseSelectorTable(missing)).toThrow(/missing key/);

    const unknown = clone();
    unknown.keys["brandNewKey"] = { ...(base.keys["saveButton"] as object) };
    expect(() => parseSelectorTable(unknown)).toThrow(/unknown key/);

    const noTerms = clone();
    delete noTerms.keys["saveButton"]?.["expectTerms"];
    expect(() => parseSelectorTable(noTerms)).toThrow();

    const destructive = clone();
    (destructive.keys["deleteAction"] as Record<string, unknown>)["healable"] = true;
    (destructive.keys["deleteAction"] as Record<string, unknown>)["expectTerms"] = ["delete"];
    expect(() => parseSelectorTable(destructive)).toThrow(/never be healable/);

    const container = clone();
    (container.keys["fileTreeRoot"] as Record<string, unknown>)["healable"] = true;
    (container.keys["fileTreeRoot"] as Record<string, unknown>)["expectTerms"] = ["files"];
    expect(() => parseSelectorTable(container)).toThrow();

    const extra = clone();
    (extra.keys["saveButton"] as Record<string, unknown>)["onclick"] = "x";
    expect(() => parseSelectorTable(extra)).toThrow();
  });
});

describe("healable table derived from JSON", () => {
  const healable = ["codeModeButton", "filesActionsMenuButton", "downloadButton", "downloadZipAction", "uploadButton", "newFileButton", "createFileAction", "createFolderAction", "showHiddenFilesToggle", "promptTextarea", "promptSendButton", "promptStopButton", "saveButton", "quickOpenInput", "renameAction"];

  it("every find-a-control key is healable with at least one expected term", () => {
    for (const key of healable) {
      expect(isHealable(key), key).toBe(true);
      expect(HEALABLE[key]?.expectTerms.length, key).toBeGreaterThan(0);
      expect(HEALABLE[key]?.goal.length, key).toBeGreaterThan(10);
    }
    expect(Object.keys(HEALABLE).sort()).toEqual([...healable].sort());
  });

  it("destructive keys, containers and hidden inputs are never healable", () => {
    for (const key of ["deleteAction", "deleteConfirmButton", "workspaceRoot", "codeEditorRoot", "fileTreeRoot", "treeRow", "persistenceStatus", "uploadInput", "newFileInput"]) {
      expect(isHealable(key), key).toBe(false);
    }
    for (const key of SELECTOR_KEYS) {
      if (DEFAULT_SELECTOR_TABLE[key].kind === "destructive") expect(DEFAULT_SELECTOR_TABLE[key].healable).toBe(false);
    }
  });

  it("codeModeButton accepts the new Files tab label as well as Code", () => {
    expect(HEALABLE["codeModeButton"]?.expectTerms).toEqual(expect.arrayContaining(["files", "code"]));
  });
});

describe("selectors.local.json hotfix", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sel-local-"));
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  it("keeps grammar-valid selectors, drops malicious ones and unknown keys", () => {
    const local = parseLocalSelectors({
      version: 1,
      keys: {
        codeModeButton: { selectors: ['button[aria-label="Open files"]', "javascript:alert(1)", "button >> nth=0", "text=Files"] },
        deleteAction: { selectors: ['button[aria-label="Remove"]'], healable: true, expectTerms: ["remove"] },
        notAKey: { selectors: ["button"] },
      },
    });
    expect(local.codeModeButton).toEqual(['button[aria-label="Open files"]', "text=Files"]);
    expect(local.deleteAction).toEqual(['button[aria-label="Remove"]']);
    expect(Object.keys(local)).not.toContain("notAKey");
    // metadata in the local file can never change healability
    expect(isHealable("deleteAction")).toBe(false);
    for (const list of Object.values(local)) for (const s of list ?? []) expect(validateSelectorGrammar(s).ok).toBe(true);
  });

  it("is prepended to the defaults without duplicates", () => {
    expect(layerSelectors(["a", "b"], ["x", "a"])).toEqual(["x", "a", "b"]);
    expect(layerSelectors(["a"], undefined)).toEqual(["a"]);
  });

  it("loads from disk and ignores missing, corrupt or wrong-version files", async () => {
    const file = path.join(dir, "selectors.local.json");
    expect(await loadLocalSelectors(file)).toEqual({});
    expect(await loadLocalSelectors(undefined)).toEqual({});
    await fs.writeFile(file, "{not json");
    expect(await loadLocalSelectors(file)).toEqual({});
    await fs.writeJson(file, { version: 2, keys: {} });
    expect(await loadLocalSelectors(file)).toEqual({});
    await fs.writeJson(file, { version: 1, keys: { saveButton: { selectors: ['button[aria-label="Store"]'] } } });
    expect(await loadLocalSelectors(file)).toEqual({ saveButton: ['button[aria-label="Store"]'] });
  });
});
