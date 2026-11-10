/**
 * Opt-in, READ-ONLY smoke against a live Figma Make project with the real adapter code.
 *
 *   FIGMAKE_SMOKE_URL="https://www.figma.com/make/<id>/<name>" npx tsx scripts/smoke-figma-readonly.ts --profile <dir>
 *
 * - `--profile` must be a COPY of a signed-in browser profile; the app's own live profile is refused. The copy is
 *   itself copied to a temp dir for the run and that temp dir is deleted afterwards.
 * - It only switches to the Files tab, expands folders, scrolls, opens menus to read them (then Escape) and reads
 *   attributes. It never types, saves, creates, renames, uploads or deletes, and never clicks a file row.
 * - `--hidden` additionally switches "Show hidden files" on, re-indexes, and switches it back off (a view preference;
 *   off by default because it may be persisted per user).
 * Exits non-zero when the page shape differs from what docs/PUSH-DESIGN.md 1.3 recorded.
 */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import pino from "pino";
import type { Locator, Page } from "playwright";

import { PlaywrightFigmaMakeAdapter, requiredFolders, type AdapterContext, type ExplorerIndex, type PlaywrightFigmaMakeProjectSession } from "../src/figma/adapter.js";
import { createProjectConfig } from "../src/types/config.js";

const url = process.env["FIGMAKE_SMOKE_URL"];
const args = process.argv.slice(2);
const profileArg = args[args.indexOf("--profile") + 1];
const withHidden = args.includes("--hidden");
const probePaths = ["src/OutlookScreen.tsx", "OutlookScreen.tsx", "src/WorkflowEmail.tsx"];

if (!url || args.indexOf("--profile") < 0 || !profileArg) {
  console.error("usage: FIGMAKE_SMOKE_URL=<make url> npx tsx scripts/smoke-figma-readonly.ts --profile <copied profile dir> [--hidden]");
  process.exit(2);
}

const liveProfile = path.join(os.homedir(), "Library", "Application Support", "figmake-sync", "browser-profile");

if (path.resolve(profileArg) === liveProfile || path.resolve(profileArg).startsWith(`${liveProfile}${path.sep}`)) {
  console.error("refusing to run against the app's live browser profile; copy it first");
  process.exit(2);
}

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);

  if (!ok) failures.push(what);
};

async function main(): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "figmake-smoke-"));
  const profileDir = path.join(workDir, "profile");

  await fs.copy(profileArg!, profileDir);

  const logger = pino({ level: "warn" });
  const context: AdapterContext = {
    config: createProjectConfig(url!, workDir),
    logger,
    paths: {
      rootDir: workDir,
      stateDir: workDir,
      artifactsDir: path.join(workDir, "artifacts"),
      browserProfileDir: profileDir,
    } as AdapterContext["paths"],
  };
  const adapter = new PlaywrightFigmaMakeAdapter(context);
  let session: PlaywrightFigmaMakeProjectSession | undefined;

  try {
    session = (await adapter.openProject(url!)) as PlaywrightFigmaMakeProjectSession;

    const priv = session as unknown as {
      handle: { page: Page };
      ensureCodeSurfaceReady(): Promise<void>;
      ensureIndex(paths: string[]): Promise<ExplorerIndex>;
      focusIndexedRow(p: string): Promise<{ locator: Locator }>;
      openFilesActionsMenu(): Promise<boolean>;
      closeMenu(): Promise<void>;
      readPersistenceStatus(): Promise<string | null>;
    };
    const page = priv.handle.page;

    check(!(await page.locator('[data-testid="google-btn"]').first().isVisible().catch(() => false)), "signed in (no guest prompt)");
    await priv.ensureCodeSurfaceReady();
    check((await page.locator('[role="treeitem"][aria-level]').count()) > 0, "explorer rows are role=treeitem with aria-level");

    // The real index path: expands `src`, scrolls every window, proves completeness.
    const snapshot = await session.indexExplorer(probePaths);
    const index = await priv.ensureIndex(probePaths);

    check(snapshot.supported, "indexExplorer reports the aria tree as supported");
    check(snapshot.duplicates.length === 0, `no duplicate labels in one folder (${snapshot.duplicates.join(", ") || "none"})`);
    check(index.rowHeight === 32, `row height ${index.rowHeight}px`);

    const root = index.rows.filter((r) => r.level === 1);
    const src = index.rows.filter((r) => r.parentPath === "src");

    console.log(`     ${index.rows.length} rows: ${root.length} at the top level (setsize ${root[0]?.setsize}), ${src.length} in src (setsize ${src[0]?.setsize}); required folders ${requiredFolders(probePaths).join(", ")}`);
    check(root.length === root[0]?.setsize, "top-level count equals aria-setsize");
    check(src.length > 0 && src.length === src[0]?.setsize, "src child count equals aria-setsize");

    for (const p of probePaths) {
      const row = index.byPath.get(p);

      check(row !== undefined && row.kind === "file", `${p} resolves to one file row (level ${row?.level}, top ${row?.top})`);
    }

    const selected = index.rows.filter((r) => r.selected).map((r) => r.path);

    console.log(`     rows exposing a selection signal: ${selected.join(", ") || "none"} (open-file signal is ${index.selectionSupported ? "" : "NOT "}observable at rest)`);

    // Scroll to the two same-named rows and re-assert them at their offsets (no click).
    for (const p of ["src/OutlookScreen.tsx", "OutlookScreen.tsx"]) {
      const { locator } = await priv.focusIndexedRow(p);
      const label = await locator.getAttribute("aria-label");
      const level = await locator.getAttribute("aria-level");

      check(label === "OutlookScreen.tsx" && level === (p.startsWith("src/") ? "2" : "1"), `${p}: tagged row reads aria-label=${label} aria-level=${level}`);
    }

    // Menus: open, read, Escape. Nothing inside is clicked.
    check(await priv.openFilesActionsMenu(), "Files actions menu opens");
    const headerItems = await page.locator('[role="menu"]:visible [role^="menuitem"]').allInnerTexts();

    console.log(`     Files menu: ${headerItems.map((t) => t.trim()).join(" | ")}`);
    check(headerItems.some((t) => /create file/i.test(t)), "Files menu has Create file");
    check(headerItems.some((t) => /create folder/i.test(t)), "Files menu has Create folder");
    check(headerItems.some((t) => /show hidden files/i.test(t)), "Files menu has Show hidden files");
    await priv.closeMenu();

    const folder = await priv.focusIndexedRow("src");

    await folder.locator.locator("button").first().click({ button: "right" });
    await page.waitForTimeout(500);
    const folderItems = await page.locator('[role="menu"]:visible [role^="menuitem"]').allInnerTexts();
    const folderTestIds = await page.locator('[role="menu"]:visible [data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

    console.log(`     folder menu: ${folderItems.map((t) => t.trim()).join(" | ")} (${folderTestIds.join(", ")})`);
    check(folderTestIds.includes("create-file-menu-item") && folderTestIds.includes("create-folder-menu-item"), "folder menu: create-file-menu-item + create-folder-menu-item");
    check(folderTestIds.includes("delete-folder-menu-item"), "folder menu: delete-folder-menu-item");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const file = await priv.focusIndexedRow("src/OutlookScreen.tsx");

    await file.locator.locator("button").first().click({ button: "right" });
    await page.waitForTimeout(500);
    const fileItems = await page.locator('[role="menu"]:visible [role^="menuitem"]').allInnerTexts();
    const fileTestIds = await page.locator('[role="menu"]:visible [data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

    console.log(`     file menu: ${fileItems.map((t) => t.trim()).join(" | ")} (${fileTestIds.join(", ")})`);
    check(fileTestIds.includes("delete-file-menu-item"), "file menu: delete-file-menu-item");
    check(fileItems.some((t) => /rename/i.test(t)), "file menu: Rename");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const readonlyInputs = await page.locator('input[data-testid="code-file-name-input"][readonly]').count();
    const editableInputs = await page.locator('input[data-testid="code-file-name-input"]:not([readonly])').count();

    check(editableInputs === 0, `name inputs at rest: ${readonlyInputs} read-only, ${editableInputs} editable`);
    check((await page.locator('input[type="file"][data-testid="upload-file-input"]').count()) === 1, "upload-file-input present");
    check(!(await page.locator('input[type="file"][webkitdirectory]').count()), "no folder upload input (uploads stay flat)");
    console.log(`     persistence status at rest: ${await priv.readPersistenceStatus()}`);
    // Informational: without an open file (this probe never clicks a file row) the editor shows no CodeMirror surface.
    console.log(`     editor: code-editor ${await page.locator('[data-testid="code-editor"]').count()} / .cm-content ${await page.locator('[data-testid="code-editor"] .cm-content').count()} (no file opened by this probe)`);

    if (withHidden) {
      const hiddenSnapshot = await session.indexExplorer([".gitattributes"]);

      check(hiddenSnapshot.hiddenFiles === "on" && hiddenSnapshot.entries[".gitattributes"] === "file", "Show hidden files reveals .gitattributes");
      console.log(`     hidden mode: ${Object.keys(hiddenSnapshot.entries).length} rows`);
    }
  } finally {
    await session?.close().catch(() => undefined);
    await fs.remove(workDir).catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }

  console.log("\nall checks passed (read-only; nothing was typed, created, renamed, saved or deleted)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
