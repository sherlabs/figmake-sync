# Push design: error-free "send local changes to Figma Make"

Status: design only (no code changed). Written 2026-11-10 against the working tree that became commit `0f041f2` (push progress card + tree-lookup resume; it shifted `src/core/service.ts` by +1 line from ~813 on, citations below are post-commit), Playwright 1.59.1, and a read-only probe of the live project `kslVUJsxpDt5FAE0nJFZkz` (Ensure-Visual-Consistency).

Everything marked **[verified]** was read in source or observed live; **[inferred]** was not observed directly.

---

## 0. Summary

Goal: a push either fully succeeds or stops cleanly with a plain reason, nothing half-applied, and can be retried from where it stopped.

What the evidence says:

1. **The OutlookScreen.tsx miss is a depth-metric bug, not a scan bug.** The explorer is a flat virtualised `role="tree"` whose rows carry `aria-level`, `aria-posinset`, `aria-setsize`, a plain `aria-label` and an absolute `style.top`. The current extractor derives depth from pixel positions; in a scroll window where every rendered row sits at the same level, every pixel metric collapses to one value and the extractor silently switches to a *different* metric with a different scale, so the resume cursor no longer matches anything. `src/OutlookScreen.tsx` was rendered in that exact window. (Section 1.4.)
2. **Replace the pixel metric with the aria tree and index the whole explorer once, up front**, with a completeness proof (`posinset 1..setsize` for root and every expanded folder). All later ops click rows by `(level, label, top)` from that index. (Section 3.)
3. **Hidden files are a second P0**: the explorer hides dot-files and `pnpm-lock.yaml` unless "Show hidden files" is on; `.gitattributes` and `.mise.toml` are in this project's baseline and not ignored, so editing either fails today. (Section 1.5.)
4. **Preflight decides everything before the first write**, using the freshly downloaded zip as the oracle for *existence and content* and the explorer index as the oracle for *clickability*. Any disagreement between the two aborts with nothing written. (Section 3.)
5. **Per-op: precondition, write, read back, settle, advance baseline, journal** — in that order, per file, not at the end of the push. Final authoritative check: download the zip again and compare hashes. (Sections 4, 5.)
6. The ten 0-byte `new-file*.tsx` files that now exist at root and in `src/` in Figma are consistent with the create flow typing a name into the wrong, read-only name input and leaving the default-named file behind **[inferred]**. The create flow must be hardened and must never leave a default-named file silently. (Sections 1.5, 4.3.)

---

## 1. Evidence

### 1.1 Current push flow (`src/core/service.ts`) [verified]

| Step | Lines | Behaviour today |
|---|---|---|
| Baseline required | 485-493 | Throws without a baseline. |
| Local diff | 509-520 | `diffManifests(excludePaths(baseline, userIgnore), excludePaths(local, userIgnore))`. |
| Open project | 538-540 | `adapter.openProject(url)`; `assertProjectLoaded` (adapter.ts:2885-2891) classifies login/error pages. |
| Remote-divergence check | 557-617 | Downloads the zip, builds a manifest, flags any touched path whose remote hash is neither the baseline nor the local hash. **Best-effort**: on failure it logs and continues unless `requireRemoteCheck` (the app passes `true`, `src/app/session.ts:470`; the CLI does not). |
| Diverged | 619-644 | One confirm; if declined, diverged paths are skipped and listed as unresolved. |
| Modified files | 704-743 | One `session.replaceFileContents(path, content)` per file, in diff order. Binary modifications are refused (707-715). |
| Added + rename targets | 745-837 | `uploadFiles` for everything (root-level only succeed; nested are returned unresolved, adapter.ts:991-1003), then `upsertFile` per remaining text file, then one `commitPendingChanges`, then optional AI prompt. |
| Save | 839-844 | One `commitPendingChanges()` for all replaces (so edits sit unsaved in the page until the batch ends). |
| Deletes | 846-919 | Last; one confirm; rename sources only if the target was pushed. |
| Baseline | 921-940 | `advanceBaseline` once at the end, only for ok paths (`src/core/state.ts:321-366`). If the process dies mid-push the baseline does not move at all. |
| Result | 942-960 | `unresolved[]` reasons are raw error messages; the app turns any non-empty list into "Some changes couldn't be sent. Try again." (`src/app/session.ts:476-478`). |

### 1.2 Adapter mechanics (`src/figma/adapter.ts`) [verified]

- `replaceFileContents` (910-921): `ensureCodeSurfaceReady` → `openFile` → `writeEditorContent` → `settleWrites(0)`.
- `openFile` (1885-1927): `locateTreeItem(segments, {expand, scan})`, click, `confirmActiveFile` (1930-1985) which accepts "content changed" or "row active for 1.5 s".
- `writeEditorContent` (2439-2462): CodeMirror `cmView.view.dispatch` replace (733-779) else select-all + `insertText`; then `verifyWrite` (2465-2494) polls the editor doc for 3 s; **non-strict by default** (`verifyEditorWrites` default false, `src/types/config.ts:49`) so an unreadable editor passes.
- `saveEditor` (2504-2553): no Save button in the new UI; waits `settleWrites(2000)` and `waitPersistenceIdle`. `isPersistenceDirty` (1810-1812) matches saving/pending/dirty/...; the live value at rest is `"unknown"` (1.3), which counts as idle.
- `locateTreeItem` (2282-2365): up to 400 iterations of `queryTree` (page script = `extractTreeRows` + `resolveTreeChain`), click-to-expand, then scroll steps via `TREE_SCROLL_SCRIPT` (648-667; step = `max(160, 0.8*clientHeight)`), carrying `resume {at, parentDepth, childDepth}` (2306-2308).
- `extractTreeRows` (485-620): depth = first metric that varies across the rendered rows: wrapper nesting → button box left → icon left → text left (605-617). Values are `Math.round(px/2)`.
- `createFile` (2030-2079): right-click parent → `createFileAction` → `newFileInput` → `replaceInlineFileName` (2231-2265, includes a descriptor-setter fallback that writes into whatever input matched) → Enter → `ensureExactCreatedFile` (2150-2186) which, if the typed name did not apply, renames a single new `new-file*` entry. No folder-creation step exists.
- `deletePath` (1095-1165): if the item is **not visible in the explorer it returns `status: "deleted"`** (1106-1112) and the caller drops it from the baseline (service.ts:895-897, 931).
- `uploadFiles` (971-1093): hidden `uploadInput` or Files-actions-menu "Upload file" + file chooser; nested paths are refused up front.
- `step()` (1377-1403) saves `<stamp>-<step>.dom.html` + `.error.json`; `runStep` in `src/browser/session.ts:417-449` adds a full-page screenshot; no retry.
- Typed errors (89-165): `AuthRequiredError`, `ProjectUnavailableError(reason)`, `SelectorNotFoundError`, `UiChangedError`, `FileNotFoundInTreeError`, `WrongFileError`, `AutomationTimeoutError`, `AutomationAbortedError`.

### 1.3 Live explorer facts (read-only probe, 2026-11-10 17:02 local) [verified]

Probe: copied profile → `chromium.launchPersistentContext(headless, 1440x960)` → Files tab → expanded `src` → scrolled in the adapter's own step size → read DOM. Nothing typed, nothing saved; profile copy deleted afterwards.

**Tree DOM shape**

```html
<div role="tree" data-testid="virtualized-file-tree-container">            <!-- overflow: visible; the scroller is an ancestor div -->
  <div role="treeitem" aria-level="2" aria-posinset="31" aria-setsize="48"
       aria-label="OutlookScreen.tsx" aria-selected="false"
       style="position:absolute; left:0; top:1120px; height:32px; width:100%">
    <button aria-label='File "OutlookScreen.tsx"' data-testid="code-file-item" draggable="true">
      <div style="--x-paddingLeft: 24px;"><span><svg .../></span> ... </div>
      <input type="text" data-testid="code-file-name-input" readonly value="OutlookScreen.tsx">   <!-- one per rendered row, at rest -->
    </button>
  </div>
  <div role="treeitem" aria-level="1" aria-posinset="5" aria-setsize="54" aria-label="src" aria-expanded="true" ...>
    <div data-folder-item="true"><div><div><button aria-expanded="true" aria-label='Folder "src"'>…</button></div></div></div>
  </div>
</div>
```

- Scroller: ancestor `div.xjb0lab`, `clientHeight 826`, `scrollHeight 1728` collapsed / `3264` with `src` expanded; row height 32 px; 31-33 rows rendered per window (≈26 visible + overscan).
- Depth is exposed three ways: `aria-level` (1-based), `--x-paddingLeft` (8 px + 16 px/level), icon x (385 at level 1, 401 at level 2). Button box left is 377 for every row, computed `paddingLeft` is 0.
- **Which row is the open file is NOT established.** Every treeitem, including root `App.tsx`, read `aria-selected="false"`, yet `extractTreeRows` reported `App.tsx` `active: true` (one of `data-state`/`data-selected`/`data-active`/class-name probes at adapter.ts:562-593 fired; which one was not recorded), and the editor held a 1080-char document of unknown identity. Treat the "active file" DOM signal as **unverified**; the smoke script must identify it (7.4).
- Full index with `src` expanded: 102 rows = 54 root children (5 folders + 49 files) + 48 `src` children (2 folders + 46 files). Sorting is folders first, then case-insensitive by name.
- **Hidden files**: the zip root has 53 files; the explorer shows 49. Not shown: `.gitattributes`, `.gitignore`, `.mise.toml`, `pnpm-lock.yaml`; `src/.DS_Store` is also hidden. The `.figma/` folder *is* shown. The Files actions menu has a "Show hidden files" item.
- Files actions menu items: `Create file` (`create-file-header-button`), `Create folder` (`create-folder-menu-item`), `Upload file` (`upload-file-header-button`), `Download code`, `Hard refresh`, `Restart language server`, `Show hidden files` (no testid; `aria-disabled` absent, so probably a checkbox item **[inferred]**).
- Folder context menu: `Create file` (`create-file-menu-item`), `Create folder` (`create-folder-menu-item`), `Copy path`, `Download`, `Rename` (`rename-folder-menu-item`), `Delete` (`delete-folder-menu-item`).
- File context menu: `Copy path`, `Download`, `Rename` (no testid), `Delete` (`delete-file-menu-item`), `Add to chat`.
- Delete confirmation: a form with `button[data-testid="confirmation-modal-confirm-action-button"]` whose text is "Delete" exists in the saved DOM (`artifacts/…replace-src-OutlookScreen.tsx.dom.html`).
- File inputs on the page: `input[type=file][data-testid="image-attachment-input"][multiple]` (chat attachments) and `input[type=file][data-testid="upload-file-input"][multiple]`. **No `webkitdirectory`**: uploads are flat.
- Editor: `[data-testid="code-editor"]` present, `.cm-content` with `cmView.view` available (CodeMirror 6), `readOnly: false`.
- Persistence: `[data-testid="code-layer-persistence-status"][data-code-layer-persistence-status="unknown"]` at rest. In-flight values were not observable read-only.
- `fileTreeRoot`'s first selector `div:has(button[data-testid="code-file-item"])` resolved to an outer `div` with no testid and an empty class — i.e. a large ancestor, not the tree container. Scripts still work because they `querySelectorAll` inside it, but `openRootFileTreeContextMenu` (adapter.ts:2407-2425) right-clicks at the centre-bottom of *that* box **[inferred: could land outside the explorer]**.

**Remote vs baseline** (`.figmake-sync/downloads/Ensure-Visual-Consistency.zip`, `last-pull-manifest.json`): both contain `OutlookScreen.tsx` *and* `src/OutlookScreen.tsx` (identical size 100270, identical hash `d027d3aa…`), plus `new-file.tsx`, `new-file-1..4.tsx` at root and in `src/`, all 0 bytes in the snapshot. The duplication is real in Figma; it is not a manifest bug.

### 1.4 Root cause of "src/OutlookScreen.tsx not found" [verified]

Probe output, `src` expanded, searching `["src","OutlookScreen.tsx"]` with the adapter's own `resolveTreeChain` and resume logic:

```
STEP 0 scrollTop=0    rows: 193:f:.figma … 193:f:src | 201:f:assets | 201:f:imports | 201:f:App.tsx … 201:f:new-file.tsx
       chain: missing at=1 parentDepth=193 childDepth=201        -> resume {at:1, parentDepth:193, childDepth:201}
STEP 1 scrollTop=660  rows: 189:f:matterData.ts … 189:f:OrganisationSettings.tsx | 189:f:OutlookScreen.tsx | 189:f:RCDiary.css … 189:f:WorkflowEmail.css
       (every row aria-level=2, iconLeft=401)                     chain: missing
STEP 2 scrollTop=1320 rows: 201:f:RCQuotes.tsx … 201:f:WorkflowEmail.tsx | 193:f:AGENTS.md … 193:f:matterReminders.ts   chain: missing
STEP 3 scrollTop=1980 rows: 189:f:GlobalAdmin.css … 189:f:OutlookScreen.tsx … (all aria-level=1)                      chain: missing
STEP 4 scrollTop=2438 rows: 189:f:new-file-1.tsx … 189:f:vite.config.ts                                                chain: missing
```

- In STEP 1 the target row **is rendered**, but its depth is `189`, not `201`. All 33 rows are level-2 children of `src`, so `useIco` is false (one distinct icon x), and the extractor falls back to `txt` (adapter.ts:605-617). The label lives only in `aria-label`, so `textLeft = rect.left + paddingLeft = 377` → `Math.round(377/2) = 189`.
- `189 <= parentDepth 193` makes `resolveTreeChain` treat every row as "above/outside the folder" and `continue` (adapter.ts:386-389); nothing is ever `inSub`, so the chain reports missing.
- STEP 3 shows the dual failure: root-level rows also read `189`, so in a single-level window the numbers cannot distinguish level 1 from level 2 at all.
- Scroll coverage itself was complete (union of windows = 102 rows), and `mailData.ts` (first window, mixed levels) and `WorkflowEmail.tsx` (STEP 2, mixed levels) were found for exactly this reason.

Conclusion: the pixel-based depth is only consistent while a window contains at least two levels. It must be replaced, not patched.

### 1.5 Other findings that shape the design

1. **Hidden files** (1.3) → `.gitattributes`, `.mise.toml` are in this baseline, not in `DEFAULT_IGNORE_PATTERNS` (`src/types/config.ts:6-22`), and absent from the explorer: any local change to them fails with `FILE_NOT_FOUND` today. [verified]
2. **Name-input ambiguity** [verified DOM, inferred consequence]: 24 `input[data-testid="code-file-name-input"][readonly]` exist at rest. `newFileInput` selectors (selectors.default.json:158-170) include `input[data-testid="code-file-name-input"][value="new-file.tsx"]` and the bare `input[data-testid="code-file-name-input"]`; with the junk `new-file.tsx` rows present, both match read-only inputs of existing rows. `replaceInlineFileName`'s descriptor-setter fallback (adapter.ts:2243-2255) then "succeeds" on a read-only input, Enter does nothing useful, and the default-named file remains. Ten 0-byte `new-file*.tsx` in Figma fit this. Cleanup is manual, by the user, once.
3. **`deletePath` reports success for anything it cannot see** (adapter.ts:1106-1112). With hidden files or an index bug this drops a path from the baseline while it still exists in Figma.
4. **No folder creation**: `createFile` requires the parent folder to exist (adapter.ts:2048-2057). "Create folder" exists in both menus.
5. **Upload is flat and root-only** (`multiple`, no `webkitdirectory`; folder context menu has no Upload). Nested binaries cannot be created; binary modifications are refused (service.ts:707-715). Whether an upload of an existing name overwrites or duplicates was **not tested** (it would write).
6. **Baseline advances once at the end** (service.ts:922). A crash mid-push re-sends everything next time (idempotent for replaces, but slow and it repeats confirms).
7. **Single save at the end of the replace batch** (service.ts:839-844, adapter.ts:959-969): a reload between two replaces loses the unsaved ones while the push continues as if fine (the per-op `settleWrites(0)` at adapter.ts:919 only waits for *already in-flight* requests).
8. **Case-only renames are invisible** to `diffManifests` on macOS (`pathKey` lowercases, `src/diff/manifest.ts:64-66, 78-80`).
9. `confirmActiveFile` accepts "content changed" as proof (adapter.ts:1955-1957); opening the *wrong* file also changes content. `aria-selected` on the treeitem is a stronger signal and is available.
10. The `.figmake-sync` directory lives inside the project (`src/core/state.ts:153-169`); every journal/artifact write triggers Vite in the local preview (known issue 5).

---

## 2. Design principles

1. **Two oracles, both mandatory.** The *zip* says what exists and with what content; the *explorer index* says what can be clicked. Any disagreement is a stop, not a guess.
2. **Decide before touching.** Preflight produces a complete, validated plan. The first write happens only after every op has an expected remote state and a resolved row.
3. **Every op is a small transaction**: precondition → act → read back → settle → journal → baseline. Never two files in flight.
4. **Idempotent by construction**: a replace whose precondition shows the desired content already present is a no-op success; a create whose target exists with the desired hash is a no-op success; a delete whose target is absent from *both* oracles is a no-op success.
5. **Stop at a boundary, never in the middle.** Cancel, time budget, network loss, and unexpected UI all stop between ops, with the baseline exactly describing what was verified.
6. **Plain language, one next action.** Every stop maps to one of: Try again / Sign in / Pull or merge first / Wait / Fix in Figma / Report.
7. **Never silently destroy remote work**: no delete or overwrite of a path whose remote content is not the baseline or the local content; no automatic deletion of default-named leftovers; no "deleted" status without seeing it go.

---

## 3. A. Preflight (no writes to Figma)

Order of checks; the first failure stops the push with the listed message (Section 6 has the full taxonomy).

### 3.1 Local plan

1. Baseline present (else `NO_BASELINE`).
2. Local manifest + diff as today (service.ts:509-520), after `userIgnore` exclusion. Compute `Plan` ops: `replace`, `create`, `delete`, `rename` (same-folder with identical `contentHash`), `rename+replace` (same-folder, `normalizedHash` match), `move` (cross-folder → `create` + `delete`).
3. Local validation, no browser yet:
   - Binary `replace` → `UNSUPPORTED_BINARY_MODIFY` (stop; today it is reported after other files were sent).
   - Binary `create` with a nested path → `UNSUPPORTED_BINARY_NESTED`.
   - Path segment that the explorer cannot show: leading-dot basenames or names in the known-hidden list (`pnpm-lock.yaml`) → requires hidden-files mode (3.3); if that mode is unavailable → `HIDDEN_FILE_UNSUPPORTED`.
   - Invalid name for Figma (empty segment, `/`, `\0`, trailing space/dot, > 255 bytes per segment, > 4096 total) → `INVALID_NAME`. Exact Figma limits are **unknown**; validate conservatively and let Figma's own rejection (name input does not take the value) be the final arbiter.
   - Files > 1 MiB text: allowed but flagged as `slow`; > 5 MiB → `TOO_LARGE_FOR_EDITOR` (CodeMirror dispatch of a multi-MB string was not measured **[inferred risk]**; make the limit a config value).
   - CRLF / trailing newline: we send bytes as-is through `cmView.dispatch`; the read-back compares `normalizeEol` (adapter.ts:694-696). Declare the contract: **line endings are normalised to LF by the editor** (the zip from Figma will come back LF); the manifest's `normalizedHash` already treats this as "same" (`manifest.ts:405-424`). Trailing newline is preserved by the dispatch path; the `insertText` fallback may trim — if the fallback is used, the read-back must be strict (exact string) or the op fails.
   - Empty file: supported (dispatch with `""`); read-back must accept empty doc; `confirmActiveFile`'s content-change heuristic is useless here → needs the open-file DOM signal that task 1's smoke run must identify (1.3).
   - Duplicate paths differing only by case or Unicode normalisation (NFC/NFD) in the local tree → `AMBIGUOUS_LOCAL_PATH` (stop; cannot be represented in Figma reliably). Compare labels NFC-normalised when matching the explorer.

### 3.2 Session checks

4. Open project; `assertProjectLoaded` → `AUTH_REQUIRED` / `PROJECT_UNAVAILABLE(reason)`. The guest view counts as signed-out (adapter.ts:187-217) [verified].
5. Code surface ready (Files tab, editor root).
6. **AI not generating**: `promptStopButton` not visible and prompt box enabled (reuse `isPromptIdle`, adapter.ts:2703-2709). If busy, wait up to 60 s, then `FIGMA_BUSY`.
7. No open `[role="dialog"]`/`[role="alertdialog"]` other than Figma's own transient overlays (`dismissFloatingOverlays`, adapter.ts:1822-1861). Unknown dialog → screenshot, `UNEXPECTED_DIALOG`.

### 3.3 Remote index (the explorer oracle)

Build once per push, after all needed folders are expanded:

```
indexExplorer(requiredFolders):                         // folders = every ancestor dir of every op path
  rows := readTreeitems()                               // [role=treeitem] → {label, level, top, kind, expanded, selected, posinset, setsize}
  for dir in requiredFolders sorted by depth asc:       // parents first; expanding changes tops below
      row := findRow(dir)                               // partial scan until the (level, label) chain is found
      if row.kind != folder → PATH_IS_FILE
      if row.expanded == false: scrollTo(row.top); click(button); wait aria-expanded=="true" && scrollHeight grew
  // one full pass
  scrollTop := 0; seen := Map<top, row>
  loop:
      merge readTreeitems() into seen (key = top)
      if maxTopSeen + rowHeight >= scrollHeight: break
      scrollTop := min(scrollTop + clientHeight*0.8, max); wait 2 rAF; if scrollTop unchanged twice: break
  rows := values(seen) sorted by top
  // reconstruct paths with a level stack
  path per row := join(stack labels at levels < row.level) + "/" + label
  // completeness proof
  assert tops are 0, 32, 64, … contiguous and count == scrollHeight / rowHeight
  assert count(level==1) == setsize of any level-1 row
  for each expanded folder F: assert count(children) == setsize read from any child, and posinset covers 1..setsize
  on any assert failure: retry whole pass once, then throw TREE_INDEX_INCOMPLETE
  return { byPath: Map<path, row>, hiddenMode: bool }
```

- Depth comes from `aria-level` only. Keep `extractTreeRows` solely as a fallback when no `[role="treeitem"]` ancestor exists (older UI), and in that fallback never trust depth across scroll windows (no resume; abort with `UI_CHANGED` if a scan is needed).
- Row identity for later clicks: `(level, label, top)`; before clicking, re-read the row at that `top` and assert `label` and `level` still match (tops shift if anything was created/deleted in between; after any create/delete/rename, re-index the affected folder: cheap, one scroll pass over that folder's range).
- Match labels NFC-normalised and exact-case.
- **Hidden files**: if any required path is absent from the index and its basename starts with `.` (or is in the known-hidden list), open the Files actions menu, activate "Show hidden files" (match by text; read `aria-checked` if present), re-index, and remember to restore the original state in `finally` **[toggle semantics inferred: it may be a per-user persisted preference]**. If still absent → stop (3.4).
- Cost: with ~3,300 px scroll height this is 5 windows; each window read is one `page.evaluate`. Budget ≤ 2 s for this project; bound the loop at `ceil(scrollHeight/step)+3` iterations.

### 3.4 Cross-check and classification (zip = existence oracle)

Download the zip **always** (make `requireRemoteCheck` the only behaviour; the "skipped" branch at service.ts:605-617 goes away). Build `remote` = manifest of the zip. For each op, with `base` = baseline hash, `local` = local hash, `remote` = zip hash, `row` = index entry:

| Op | Expected | Decision |
|---|---|---|
| replace | `remote == base`, row exists (file) | proceed. Precondition at execution: editor doc hash == `remote` (normalised). |
| replace | `remote == local` | already there: no-op success, advance baseline. |
| replace | `remote` ≠ base, ≠ local | `DIVERGED` (collect all, ask once: Keep mine / Use Figma's / Merge — existing UI). |
| replace | `remote` undefined (deleted in Figma) | `DELETED_REMOTELY`: part of the diverged set; "Keep mine" turns it into a `create`. |
| replace | `remote == base` but **no row** | hidden-files pass, re-index; still none → `EXPLORER_MISMATCH`: stop everything, nothing written. This is a tool/UI bug, never a reason to create a duplicate. |
| create | `remote` undefined, no row | proceed; parent folders that are missing become `mkdir` ops (parents first). |
| create | `remote == local` | no-op success. |
| create | `remote` defined ≠ local | `DIVERGED` (someone made that file in Figma). |
| create | no `remote` but a row exists | `EXPLORER_MISMATCH` (zip stale or index wrong) → stop. |
| delete | `remote == base`, row exists | proceed (after the single delete confirmation). |
| delete | `remote` undefined and no row | no-op success. |
| delete | `remote` ≠ base | `DIVERGED` (edited in Figma, then deleted locally): never delete; user must choose. |
| delete | `remote == base`, no row | hidden pass; still none → `EXPLORER_MISMATCH`, stop. |
| rename (same folder) | source as delete, target as create | use Figma's Rename; if `normalizedHash` match, follow with a replace. |
| move (cross folder) | create + delete | the delete is scheduled only after the create verified. |
| mkdir | parent row exists, folder absent in index and zip | proceed. If a *file* with that name exists → `NAME_COLLISION`. |

Additional classification rules:

- **Duplicate labels in one folder** (index shows two rows with the same `(level, parentPath, label)`): `AMBIGUOUS_REMOTE_PATH` → stop; ask the user to fix in Figma. Not expected (Figma should prevent it) but cheap to check.
- **Root-level vs `src/` duplicates** are different paths and are handled independently; the index key is the full path, never the label.
- **Ignored files** (`sync.ignore`, `userIgnore`) never enter the plan (service.ts:509-519) and are never deleted (tests/review-ignore.test.ts:196). Keep.
- **Files hidden by Figma but present in the zip** and *not* in the plan are irrelevant; only planned paths need a row.
- **Case-only rename**: not detectable on macOS today (1.5.8). Document; P2 adds an exact-path pass over the manifests to emit a `rename` op.
- **Very long paths / unicode / spaces**: labels are compared as strings; the name input is filled and read back (`replaceInlineFileName`), which already fails if the value does not stick. Add: assert the created row's label equals the requested leaf exactly (NFC) before proceeding.

Preflight output: `PushPlan { ops: PlannedOp[], noops: string[], diverged: string[], blocked: {path, code}[] }`. If `blocked` is non-empty the push stops before any write with the first blocking message and the full list in the report. If `diverged` is non-empty, ask once (existing conflict UI). Then execute.

---

## 4. B. Execution

### 4.1 Ordering and batching

1. `mkdir` ops, shallowest first.
2. `create` ops (new files), then `move` creates. New files first so that updated importers never point at a missing module.
3. `replace` ops.
4. `rename` ops (same-folder).
5. `delete` ops last (after the single confirmation), including `move` sources, each only if its counterpart verified.
6. Final verification (Section 5.3).

Sequential, one op at a time. The only batched UI action is the root-level binary upload (`uploadFiles`), kept as today but verified per file through the index *and* the final zip.

### 4.2 Per-op transaction (replace)

```
precondition:
  row := index.get(path); scrollTo(row.top); assert row label/level at that top
  click(button); wait ≤ 6 s for the editor to show the file (see note)       // replaces confirmActiveFile's content heuristic
  doc := readActiveEditorContent()
  if normHash(doc) == local.normalizedHash: mark done (no-op), skip to settle  // idempotent re-run after a crash
  if normHash(doc) != remoteZip.normalizedHash: fail op WRONG_FILE_OR_CHANGED  // wrong file or edited since the zip
  // normHash(s) = sha256(utf8(BOM-stripped, CR/CRLF→LF s)) — the same transform manifest.ts:111-119 uses for normalizedHash.
  // Caveat: if Figma reformats on display, this produces false stops; the smoke script compares one open file's doc
  // to its zip bytes once to confirm the editor shows raw bytes.
  // Note on "the file is open": no verified DOM signal exists (1.3). Until the smoke script identifies one, the
  // precondition is content-only, which is BLIND to byte-identical duplicates (root OutlookScreen.tsx == src/OutlookScreen.tsx
  // here): a mis-click on the sibling passes. The whole-manifest final check (5.3) is what catches that case.
act:
  tryReplaceCodeMirrorDocument(desired)  (cmView dispatch; adapter.ts:733-779)
  fallback insertText only if dispatch unavailable, and then strict read-back
verify:
  poll ≤ 3 s: norm(readActiveEditorContent()) == norm(desired)   (strict always; drop the non-strict branch of verifyWrite)
settle:
  wait for a mutating request to start (≤ 2 s window) and finish, then 500 ms quiet (settleWrites(2000)); then persistence status not dirty
  [heuristic: autosave was not observed live; the final zip compare is the authoritative check]
commit:
  journal.op = done; advanceBaseline for this path only (state.ts:321) — immediately, not at push end
```

Retry policy per op: attempts 1 + 2 retries, backoff 1 s, 3 s (reuse `withRetry`, `src/utils/retry.ts`). Retry only on transient classes (`TimeoutError`, detached node, `UiChangedError` once after `dismissFloatingOverlays` + Escape). Never retry `WRONG_FILE_OR_CHANGED`, `AUTH_REQUIRED`, `PROJECT_UNAVAILABLE`, `ABORTED`. Each retry starts from the precondition, so a half-applied write is re-read, not re-sent blindly.

### 4.3 Create (and mkdir)

```
mkdir(parent, name):   right-click parent row (or Files menu at root) → "Create folder" → name input (see rules) → Enter
                       verify: a folder row (level+1, label==name) exists under parent and parent's setsize grew by 1
create(path):          right-click parent → "Create file" → name input → Enter
                       verify: file row with exact label under parent, setsize+1; then run the replace transaction with
                       precondition "doc is empty" instead of the zip hash
```

Name-input rules (fixes 1.5.2):

- Selector must be `input[data-testid="code-file-name-input"]:not([readonly])` and visible; exactly one match, else `UI_CHANGED`.
- Its initial value must be a default name (`new-file.*`, `new-folder`, or empty); if it equals an existing label, we matched a rename input of the wrong row → Escape and fail the op (no Enter pressed).
- After Enter: if no row with the exact label appears within 5 s, look for exactly one new row in that folder whose label starts with the default prefix; rename it (existing `ensureExactCreatedFile`); if that also fails, **stop the push** with `LEFTOVER_FILE` naming the folder and the default-named file so the user can delete it. Never continue past a leftover.

### 4.4 Delete and rename

- Delete: row from index → right-click → `delete-file-menu-item` / `delete-folder-menu-item` (add these testids first in `deleteAction`) → confirm `confirmation-modal-confirm-action-button` (add to `deleteConfirmButton`) → verify the row at that top is gone and parent setsize shrank by 1. **No row = not deleted**: return `failed` with `EXPLORER_MISMATCH`, never `deleted`.
- Rename: right-click → "Rename" → `:not([readonly])` input whose value equals the *current* label (that is the correct precondition here) → set → Enter → verify new label at the same level and old label gone.
- Folders left empty by deletes are left alone (Figma may remove them itself; not verified). P2 may offer cleanup.

### 4.5 Interruptions

| Event | Detection | Behaviour |
|---|---|---|
| Autosave / "Save and reload" / Hard refresh by Figma | `page.on('framenavigated')`, `load` event, editor root detached | Current op → `unknown`; wait for code surface (≤ 30 s), re-index, re-run from the op's precondition (idempotent). Max 2 reloads per push, then `UNSTABLE_PAGE`. |
| Focus loss / overlay / toast | click fails with interception; `[data-fpl-floating-overlay]` | `dismissFloatingOverlays`, Escape, retry once (4.2). |
| Modal dialog we did not open | `[role=dialog]` visible before an op | Screenshot; `UNEXPECTED_DIALOG`; stop at boundary. Never click through unknown dialogs. |
| Rate limit / 429 / "something went wrong" | `classifyPage` | `PROJECT_UNAVAILABLE(rate-limited)`: stop, suggest waiting 5 minutes; no retry storm. |
| Network drop | Playwright `net::ERR_*`, navigation timeout | Pause up to 60 s polling `page.evaluate(() => navigator.onLine)` and a cheap reload; then `OFFLINE`. Baseline already reflects done ops. |
| Page crash / browser closed | `page.on('crash')`, `close` | Stop, `BROWSER_CLOSED`; journal has the remaining ops. |
| User closes the app window | main process still owns the session | Treat as cancel (below). The push loop lives in the main process; the window closing must not kill it mid-op. |
| Cancel | `AbortSignal` | Honour **between ops** and inside long waits (`raceAbort`), but let the current op finish its verify/settle (≤ 10 s) so it is either done or not. Message: "Stopped. 12 of 40 files were sent; the rest are still waiting." |
| Concurrent edits in Figma | per-op precondition (doc hash == zip hash) and final zip compare | Precondition mismatch → stop with `CHANGED_IN_FIGMA` for that file; final compare mismatch → report which files changed after we sent them. |
| AI panel generating mid-push | `promptStopButton` visible before an op | Wait ≤ 60 s between ops; then `FIGMA_BUSY`. The AI can rewrite files we just wrote; the final compare catches it. |
| Large push | plan size | Time budget (default 30 min, config) checked at boundaries; on exhaustion stop with `TIME_BUDGET` and "Resume" available. Rough cost: 3-6 s per text op, so ~300 ops ≈ 15-30 min. |

### 4.6 Bulk alternative (upload / zip)

Observed: "Upload file" (header menu) with a flat `multiple` input; no "Upload folder", no zip import, no Upload in folder context menus [verified]. Unknown: whether uploading an existing name overwrites, duplicates or prompts (not tested, it would write).

Recommendation: **do not prefer bulk**. Use upload only for new root-level binary files, as today, verified by index + final zip. Do not use it for text files (editor path gives per-file verification and no overwrite ambiguity). Revisit only if Figma ships a folder/zip import; a single live, user-approved experiment on a throwaway project would settle the overwrite question (P2).

---

## 5. C. State and recovery

### 5.1 Journal

`.figmake-sync/push-journal.json` (atomic write, `writeJsonAtomic`):

```json
{ "pushId": "…", "startedAt": "…", "baselineCreatedAt": "…",
  "ops": [ { "id": 1, "op": "replace", "path": "src/OutlookScreen.tsx",
             "expect": { "remote": "d027…", "local": "9f1e…" },
             "status": "done|pending|failed|unknown", "attempts": 1, "error": null } ] }
```

- Written after preflight (all `pending`) and after every op. Deleted after a fully verified push.
- On the next push: if a journal exists, ops marked `unknown` are re-verified first (precondition only); everything else is recomputed from the diff, which is already correct because the baseline advanced per op. The journal therefore only (a) names what was in flight when something died and (b) powers the "Resume sending (28 left)" wording. No bespoke resume state machine is needed.

### 5.2 Baseline

- Advance per op immediately after verify + settle (move the `advanceBaseline` call from service.ts:922 into the op loop; `state.ts:321-366` already supports single-path upserts/removals and refuses stale local edits).
- Removals only after the row was *seen to disappear* (4.4). A delete that cannot be seen leaves the baseline entry in place so it stays "pending delete".
- Never rewrite entries for `blocked`, `diverged`, or `failed` paths.

### 5.3 Final verification and what the user sees

1. After the last op: `settleWrites(2000)` + persistence not dirty.
2. Download the zip again (one `downloadLatestCodeZip`, ~2 MB here), build its manifest, and compare the **entire** remote manifest against the expected post-push manifest (= baseline after the per-op advances). Touched paths: `remote == local` ⇒ **verified**; path missing ⇒ `NOT_SAVED`; different ⇒ `CHANGED_AFTER_SEND`. **Untouched paths** that differ from the baseline and are not in the diverged/blocked lists ⇒ `UNEXPECTED_REMOTE_CHANGE` — this is the only check that catches a write landing in a byte-identical sibling (4.2 note) or the AI rewriting files during the push. For every mismatch, roll that path's baseline entry back to the pre-push entry so it shows as dirty/conflicting again; nothing is auto-corrected. The zip is already downloaded, so the whole-manifest compare is free.
3. Record `metadata.unresolved` with codes, not raw messages.
4. UI states:
   - All verified: "Sent to Figma — 40 files, checked against Figma."
   - Stopped at a boundary: "Stopped after 12 of 40 files. Nothing is half-done. [Resume]".
   - Blocked in preflight: the one-line reason + "Nothing was changed in Figma." + [the action].
   - Verified with exceptions: "38 of 40 files are in Figma. 2 changed in Figma while sending: a.tsx, b.tsx. [Pull] [Send again]".

---

## 6. D. Error taxonomy and progress events

### 6.1 Codes → message → action

| Code | Trigger | Message (plain) | Action |
|---|---|---|---|
| `AUTH_REQUIRED` | login/guest page | "You're signed out of Figma. Sign in and try again." | Sign in |
| `PROJECT_UNAVAILABLE:not-found` | 404 | "This Figma Make project can't be found. Check the link in Settings." | Open settings |
| `PROJECT_UNAVAILABLE:forbidden` | no access | "You don't have access to this project in Figma." | — |
| `PROJECT_UNAVAILABLE:rate-limited` | 429 | "Figma is asking us to slow down. Wait a few minutes and try again." | Retry later |
| `OFFLINE` | network | "You're offline, or Figma can't be reached. Nothing was changed. Try again when you're back online." | Retry |
| `FIGMA_BUSY` | AI generating | "Figma is still working on something. Wait for it to finish, then send again." | Retry |
| `UNEXPECTED_DIALOG` | unknown modal | "Figma is showing a message that needs your attention. Open the project, close it, and try again." | Open Figma |
| `REMOTE_CHECK_FAILED` | zip download failed | "Couldn't check Figma for newer changes, so nothing was sent." | Retry |
| `DIVERGED` / `DELETED_REMOTELY` | hashes | existing conflict sheet ("Figma has newer changes") | Keep mine / Use Figma's / Merge |
| `EXPLORER_MISMATCH` | zip has it, explorer doesn't (after hidden pass) | "Figma's file list looks different from what we expected (src/OutlookScreen.tsx). Nothing was changed. Try again; if it keeps happening, send a report." | Retry / Report |
| `TREE_INDEX_INCOMPLETE` | completeness proof failed | same wording as above | Retry / Report |
| `HIDDEN_FILE_UNSUPPORTED` | dot-file, no toggle | "Figma hides files like .gitattributes. Add it to Ignore, or change it in Figma." | Ignore file |
| `UNSUPPORTED_BINARY_MODIFY` | changed image | "Images and other binary files can't be updated from here yet. Replace logo.png in Figma, or ignore it." | Ignore / Open Figma |
| `UNSUPPORTED_BINARY_NESTED` | new nested binary | "New images can only be added at the top level for now. Move assets/x.png to the top level or add it in Figma." | — |
| `TOO_LARGE_FOR_EDITOR` | > limit | "data/big.json is too large to send through Figma's editor. Add it in Figma." | — |
| `INVALID_NAME` / `AMBIGUOUS_LOCAL_PATH` | names | "Figma can't use the name 'a/b ' …" / "Two files differ only by letter case: …" | Rename locally |
| `AMBIGUOUS_REMOTE_PATH` / `NAME_COLLISION` | index | "Figma has two files called X in src/. Fix that in Figma first." | Open Figma |
| `WRONG_FILE_OR_CHANGED` | precondition | "src/a.tsx changed in Figma while sending. Stopped before changing it." | Pull / Merge |
| `LEFTOVER_FILE` | create fallback failed | "Figma created 'new-file.tsx' in src/ but wouldn't rename it. Delete that file in Figma, then send again." | Open Figma |
| `WRITE_NOT_VERIFIED` | read-back mismatch after retries | "src/a.tsx didn't take in Figma's editor. Nothing after it was sent." | Retry |
| `NOT_SAVED` / `CHANGED_AFTER_SEND` | final zip | "2 files weren't saved by Figma / changed after sending: …" | Send again / Pull |
| `UNSTABLE_PAGE` | > 2 reloads | "Figma kept reloading. Stopped after N files; the rest are waiting." | Resume |
| `TIME_BUDGET` | budget | "Sending paused after 30 minutes (120 of 300 done). Resume to continue." | Resume |
| `ABORTED` | cancel | "Stopped. 12 of 40 sent; the rest are still waiting." | Resume |
| `BROWSER_CLOSED` | crash/close | "The Figma window closed. 12 of 40 sent; the rest are waiting." | Resume |
| `UI_CHANGED` / `SELECTOR_NOT_FOUND` | selectors | "Figma's page looks different from what this app expects. Nothing more was changed. Please send a report." | Report |

Every message is ≤ 2 sentences, names the file when one is involved, and states whether anything changed in Figma.

### 6.2 Progress event stream

Keep `PushProgress` (`src/types/config.ts:93-109`) and `SendProgress` (`src/electron/contracts.ts:104-121`) shapes; extend additively so the concurrent `onProgress` work stays compatible:

```ts
interface PushProgress {
  phase: "preflight" | "indexing" | "checking" | "sending" | "saving" | "verifying" | "done";  // old: checking|sending|saving
  op?: "replace" | "create" | "delete" | "rename" | "mkdir";
  file?: string; index: number; total: number; completed: number; percent: number; startedAt: number;
  finished?: { file: string; op: …; ok: boolean; code?: string };
  detail?: string;          // "Expanding src", "Reading the file list (3 of 5)", "Checking against Figma"
  stopped?: { code: string; message: string; remaining: number };   // only on the last event of a stopped push
}
```

Rules: one event at phase change, one per op start, one per op finish; coalescing stays in `sendProgress` (`src/app/session.ts:496-534`). `percent` counts preflight/verify as fixed 5 % each so the bar moves during indexing. Unknown phases must render as generic "Working…" in the UI.

---

## 7. E. Testing strategy

### 7.1 Fake virtualised explorer in real Chromium (no Figma)

Extend `tests/figma-newui.test.ts`'s approach (real `PlaywrightFigmaMakeProjectSession` against `page.setContent`, `codeModeWaitMs` shortened — `tests/figma-newui.test.ts:85-86`) with a generated fixture `tests/support/fake-make-explorer.ts` that reproduces 1.3 exactly:

- `div[role=tree][data-testid=virtualized-file-tree-container]` inside a fixed-height (826 px) `overflow:auto` ancestor; rows are `div[role=treeitem]` absolutely positioned at `top = index*32`, with `aria-level/posinset/setsize/label/expanded/selected`; **only rows within viewport ± 3 rows are mounted**, re-rendered on `scroll`; buttons with the `aria-label='File "x"'` / `'Folder "x"'` form, icon span at `8 + 16*(level-1)` px, no text node; a hidden `input[data-testid=code-file-name-input][readonly]` per row.
- Behaviour: click folder toggles `aria-expanded`; click file sets `aria-selected` and swaps a CodeMirror-like editor (`.cm-content` with a `cmView.view` shim: `state.doc.toString/length`, `dispatch`, `focus`); context menus with the exact item texts/testids; "Create file/folder" inserts a `new-file.tsx`/`new-folder` row with an editable (non-readonly, focused) input; Rename; Delete with the confirmation modal (`confirmation-modal-confirm-action-button`); Files actions menu with "Show hidden files" (checkbox) hiding dot-files; `code-layer-persistence-status` cycling `unknown → saving → unknown` after edits; both file inputs (`image-attachment-input`, `upload-file-input`).
- Dataset generator: `makeProject({ rootFiles: 49, folders: { src: 46, public: 172 }, duplicatesAcrossLevels: true, hidden: ['.gitattributes','pnpm-lock.yaml'] })` so single-level windows (the bug) occur naturally.

### 7.2 Unit tests (pure)

- `reconstructTree(rows)` from `(top, level, label)`; completeness checks (gap, missing posinset, wrong setsize) each raise.
- Plan classification table (3.4) as a table-driven test over `(base, local, remote, rowExists)`.
- Message mapping: every code has a message, ≤ 2 sentences, contains the path when given.

### 7.3 Failure-injection matrix (fixture flags via `window.__fault`)

| Fault | Expected |
|---|---|
| single-level windows only (big folder) | index complete; `src/OutlookScreen.tsx` found; no `resume` needed |
| row dropped from one window (virtualiser bug) | `TREE_INDEX_INCOMPLETE` after one retry; no writes |
| same label at level 1 and 2 | each path resolves to its own row |
| two rows with same label in one folder | `AMBIGUOUS_REMOTE_PATH`, no writes |
| hidden dot-file target | toggle → found → push → toggle restored |
| name input readonly only (create UI broken) | op fails, no Enter pressed, no leftover, push stops |
| create yields `new-file.tsx` and rename fails | `LEFTOVER_FILE`, push stops, message names folder |
| editor read-back never matches | `WRITE_NOT_VERIFIED` after 3 attempts; baseline unchanged for that path |
| editor doc ≠ zip hash before write | `WRONG_FILE_OR_CHANGED`, nothing written |
| page reload after op 3 | ops 1-3 baseline advanced; op 4 re-run from precondition; push completes |
| reload loop | `UNSTABLE_PAGE` after 2; journal lists remaining |
| context menu never opens | retry once, then `UI_CHANGED`; nothing after it sent |
| delete: row never disappears | `failed`, baseline keeps the path |
| delete: row absent but zip has it | `EXPLORER_MISMATCH`, no "deleted" |
| abort signal between ops / during settle | stops at boundary; done count matches baseline |
| overlay intercepts click | dismissed, op succeeds |
| 300 ops with 0 ms fixture latency | finishes; progress events monotonic; `percent` reaches 100 once |

### 7.4 Live read-only smoke (opt-in)

`scripts/smoke-figma-readonly.mjs` (gated by `FIGMAKE_SMOKE_URL` and an explicit `--profile <dir>`; refuses to run against the app's live profile, copies it to a temp dir and deletes it after). Steps = the probe used for this document: sign-in check (not guest), Files tab, assert `[role=treeitem][aria-level]` rows exist, expand `src`, build the index with the completeness proof, open and read the Files-actions and both context menus (then Escape), read the two file inputs' attributes, read persistence status, download the zip (read-only) and assert `zip files − hidden names == index files`. Two extra checks this document could not settle: (a) **identify the DOM signal for the open file** — the script may click one file row (opening a file is a view action; it must then compare the root/`src` `OutlookScreen.tsx` pair and report which attribute/class distinguishes the open row); (b) compare that open file's `cmView` document to its zip bytes (normalised) to confirm the editor shows raw content. Prints a one-screen report and exits non-zero on any shape change. Never types, never saves, never creates/renames/deletes.

---

## 8. F. Implementation plan (dependency order)

P0 = needed for the current real project to push; P1 = hardening that completes the "all or nothing" promise; P2 = nice to have.

| # | Pri | Task | Files | Acceptance |
|---|---|---|---|---|
| 1 | P0 | **Aria-based rows + full explorer index.** New `readTreeitems`, `indexExplorer`, `reconstructTree`, completeness checks; `locateTreeItem` becomes "look up in index, scroll to `top`, re-assert, click"; pixel extractor kept only as fallback without scrolling. Put `[data-testid="virtualized-file-tree-container"]` first in `fileTreeRoot`. | `src/figma/adapter.ts`, `src/figma/selectors.default.json`, `tests/support/fake-make-explorer.ts`, `tests/adapter-tree.test.ts` | Fixture with 49 root + 46 `src` files: `src/OutlookScreen.tsx`, root `OutlookScreen.tsx`, `src/WorkflowEmail.tsx` all resolve with no resume; dropped-row fault → `TREE_INDEX_INCOMPLETE`. Live smoke index count == zip visible files, and the smoke script has named the open-file DOM signal (confirmed on the root/`src` `OutlookScreen.tsx` pair) before task 5 relies on it. |
| 2 | P0 | **Hidden files.** Detect dot/known-hidden targets; toggle "Show hidden files" via the Files menu; restore in `finally`; else `HIDDEN_FILE_UNSUPPORTED`. | `adapter.ts`, `selectors.default.json` (new key `showHiddenFilesToggle`), fixture | Fixture: editing `.gitattributes` succeeds and toggle is restored; no toggle → clean stop before writes. |
| 3 | P0 | **Preflight + plan + mandatory zip.** Move the divergence check before any write for all callers; build `PushPlan` with the 3.4 table; stop on `blocked`; `EXPLORER_MISMATCH` instead of per-file FILE_NOT_FOUND; binary/nested/oversize rejected up front. | `src/core/service.ts` (push), new `src/core/push-plan.ts`, `src/app/session.ts` (messages) | Table-driven unit test for every row of 3.4; integration: a plan with one unresolvable path writes nothing (RecordingSession records zero calls). |
| 4 | P0 | **Create-flow hardening.** `newFileInput` → `:not([readonly])`, single match, default-value assertion; verify by `setsize`+exact label; `LEFTOVER_FILE` stop; `mkdir` via "Create folder" for missing parents. | `adapter.ts`, `selectors.default.json`, fixture | Faults "readonly only" and "rename fails" behave as in 7.3; nested create into a new folder works. |
| 5 | P0 | **Per-op transaction + immediate baseline.** Precondition (open-file signal from task 1 + `normHash(doc) == zip normalizedHash`), strict read-back, per-op settle, `advanceBaseline` per op, bounded retries. Side effect: one write into `.figmake-sync/snapshots` per file ⇒ one Vite reload of the local preview per file while the state dir sits in the project root — hence task 16 is P1, not P2. | `service.ts`, `adapter.ts`, `src/core/state.ts` (no change expected) | Reload-after-op-3 fault: baseline has 3 paths, push completes; precondition mismatch writes nothing. `tests/push-batching.test.ts` updated for per-op commits. |
| 6 | P0 | **Delete truthfulness.** New testids; confirmation testid; "not visible" → `failed`/`EXPLORER_MISMATCH`; verify by disappearance + setsize. | `adapter.ts`, `selectors.default.json` | Faults "row never disappears" and "absent but in zip" keep the baseline entry. |
| 7 | P1 | **Final zip verification + report.** Second download, compare touched paths, roll back baseline for mismatches, `metadata.unresolved` with codes. | `service.ts`, `src/app/report.ts` | Fixture whose "server" mutates a file after send → `CHANGED_AFTER_SEND` listed; that path dirty again. |
| 8 | P1 | **Error taxonomy + messages.** Codes on every thrown error; `plainError` map; one action per code. | `adapter.ts`, `src/app/session.ts`, `src/app/report.ts`, tests | Every code in 6.1 has a test asserting message and action. |
| 9 | P1 | **Progress phases + stop semantics.** Additive `PushProgress` fields; cancel at boundaries with "n of m" wording; time budget. | `src/types/config.ts`, `service.ts`, `src/electron/contracts.ts`, `src/app/session.ts`, renderer | Abort during settle: last event has `stopped.remaining` and baseline matches `completed`. |
| 10 | P1 | **Journal + resume wording.** | `src/core/state.ts`, `service.ts`, `src/app/session.ts` | Kill process mid-push (fixture): next push says "Resume sending (k left)" and re-verifies the `unknown` op first. |
| 11 | P1 | **Interruptions.** Reload detection and re-index, `FIGMA_BUSY` wait, unknown dialog stop, offline pause. | `adapter.ts` | Faults: reload, reload loop, dialog, offline → codes as in 6.1. |
| 12 | P1 | **Same-folder rename via Figma Rename**, followed by replace when `normalizedHash` matched. | `service.ts`, `adapter.ts` | Fixture rename preserves row identity; cross-folder still create+delete. |
| 13 | P1 | **Live read-only smoke script.** | `scripts/smoke-figma-readonly.mjs`, `package.json` | Runs against a copied profile; exits non-zero on DOM shape change; deletes the copy. |
| 14 | P2 | Root-level binary replace as delete+upload with explicit confirmation; one approved live experiment to learn upload-overwrite semantics. | `service.ts`, `adapter.ts` | Documented behaviour; fixture covers both outcomes. |
| 15 | P2 | Case-only rename detection (exact-path pass) → Rename op. | `src/diff/manifest.ts`, `service.ts` | `A.tsx → a.tsx` yields one rename, not add+delete. |
| 16 | P1 | Vite noise: at minimum pass `server.watch.ignored: ['**/.figmake-sync/**']` to the managed dev server; longer term keep journal/artifacts/tmp/backups/snapshots out of the project (per-project dir under the app's user-data). | `src/core/state.ts`, dev-server runner | Writing a journal or advancing the baseline no longer reloads the preview. |
| 17 | P2 | Empty-folder cleanup after deletes (opt-in). | `adapter.ts` | — |

### Out of scope / explicitly not done

- No automatic deletion of the existing `new-file*.tsx` leftovers in Figma; tell the user once (they are 0 bytes at root and in `src/`).
- No bulk/zip import path (none exists in the UI as of the probe).

---

## Appendix A. Probe numbers kept for regression

| Fact | Value |
|---|---|
| Row height | 32 px |
| Scroller clientHeight (1440x960 viewport) | 826 px |
| Rendered rows per window | 31-33 |
| Adapter scroll step | `floor(826*0.8)` = 660 px (≈ 20.6 rows) |
| Root children (`aria-setsize` level 1) | 54 (5 folders + 49 files; 4 hidden) |
| `src` children (level 2) | 48 (2 folders + 46 files; `.DS_Store` hidden) |
| Icon x by level | 385 (L1), 401 (L2); `--x-paddingLeft` 8 px / 24 px |
| Button box left (all rows) | 377; computed paddingLeft 0 |
| Pixel-depth values produced today | 193 (L1) / 201 (L2) in mixed windows; **189 for every row** in single-level windows |

## Appendix B. Selector additions implied by this design

| Key | Add |
|---|---|
| `fileTreeRoot` | `[data-testid="virtualized-file-tree-container"]` **first** |
| `treeRow` (new) | `[role="treeitem"][aria-level]` |
| `newFileInput` | `input[data-testid="code-file-name-input"]:not([readonly])` first; drop the `[value="new-file.tsx"]` entry |
| `createFolderAction` (new) | `[data-testid="create-folder-menu-item"]`, `[role="menuitem"]:has-text("Create folder")` |
| `createFileAction` | add `[data-testid="create-file-menu-item"]` |
| `deleteAction` | add `[data-testid="delete-file-menu-item"]`, `[data-testid="delete-folder-menu-item"]` |
| `deleteConfirmButton` | add `[data-testid="confirmation-modal-confirm-action-button"]` |
| `renameAction` | add `[data-testid="rename-folder-menu-item"]` |
| `showHiddenFilesToggle` (new) | `[role="menu"] [role^="menuitem"]:has-text("Show hidden files")` |
| `uploadInput` | keep `upload-file-input` first; add a test that `image-attachment-input` is never chosen |

---

## IMPLEMENTATION NOTES (2026-11-10, same day as the design)

Status: P0 tasks #1-#6 implemented; P1 #7 (final whole-manifest verification) and #8 (error codes -> plain messages) implemented minimally; #13 (read-only live smoke script) added. Everything below was verified against a faithful fake of the virtualised explorer in real Chromium and against scripted sessions; nothing was written to a real Figma project.

### What was done

| Design task | Where | Notes |
|---|---|---|
| #1 aria index + completeness proof | `src/figma/adapter.ts`: `AriaRow`, `reconstructTree` (pure, exported), `TREE_READ_SCRIPT`, `TREE_TAG_SCRIPT`, `readExplorerPass`, `buildIndex`, `ensureIndex`, `focusIndexedRow`, `openFileIndexed`; `fileTreeRoot` now lists `[data-testid="virtualized-file-tree-container"]` first; new container key `treeRow` | Depth comes from `aria-level` only. Proof = contiguous tops (row height), every row has a parent at `level-1`, and for the root and every expanded folder `posinset` covers exactly `1..setsize`. One retry of the pass, then `TreeIndexIncompleteError` (`TREE_INDEX_INCOMPLETE`). Rows are clicked by `(level, label, top)` after re-reading the row at that offset (`focusIndexedRow`); the index is dropped after anything that changes rows. `locateTreeItem` delegates to the index when `[role=treeitem][aria-level]` rows exist and keeps the old pixel path (with its `resume`) only for the older UI, so `tests/adapter-tree.test.ts` and `uploadFiles` are unchanged. |
| #2 hidden files | `indexExplorer` + `setHiddenFilesShown`; new healable key `showHiddenFilesToggle`; `looksHidden`, `KNOWN_HIDDEN_NAMES` | A requested path that is absent and looks hidden switches "Show hidden files" on (reads `aria-checked` when present) and re-indexes; `close()` switches it back off when this session switched it on. Snapshot reports `hiddenFiles: "on" | "off" | "unavailable"`; the plan turns "unavailable" + absent dot-file into `HIDDEN_FILE_UNSUPPORTED`. |
| #3 preflight / plan | `src/core/push-plan.ts` (`validateLocalPlan`, `buildPushPlan`, `resolveDiverged`, `pushMessage`, `touchedPaths`), `FigmakeSyncService.push` rewritten | Order: local refusals (binary edit, nested binary, > 5 MiB text, invalid name, case-only twins) before the browser opens; open; zip download (**mandatory for every caller**; failure throws the existing "newer changes" error so the app's wording still matches); `session.indexExplorer(touched)` when the session has it; table 3.4 classification; `blocked` non-empty => `PushResult.stopped = { phase: "preflight", code, message }` with nothing written; diverged => the existing confirm prompt (same text, the app's `REMOTE_DIVERGED_PROMPT` / `conflictFiles` parsing still works) resolved by `resolveDiverged`. Sessions without `indexExplorer` (older UI, test fakes) leave row existence unknown: the zip alone decides and no `EXPLORER_MISMATCH` can arise. |
| #4 create hardening + mkdir | `createEntry`, `takeNameInput`, `verifyCreated`, `renameIndexedRow`, public `createFile` / `createFolder`; `newFileInput` selectors lead with `:not([readonly])` and the `[value="new-file.tsx"]` entry is gone; new healable key `createFolderAction`; `createFileAction` adds `create-file-menu-item` | Exactly one visible editable name input, whose value must be a default (`new-file*`, `new-folder*`, `untitled*`, empty) for a create or the current label for a rename, else Escape and `UI_CHANGED` with no Enter pressed. After Enter: exact label under the parent (re-indexed) or exactly one new default-named entry renamed through Figma's Rename; anything else is `LEFTOVER_FILE` naming folder and file. Missing parent folders become `mkdir` ops (shallowest first) from "Create folder"; the coordinate right-click on the tree is never used with the virtualised container. |
| #5 per-op transaction + immediate baseline | `replaceFileContents(path, content, { expectedNormalizedHash })` returns `{ status: "written" \| "unchanged" }`; `writeOpenFile`, `settleOperation`, `normalizedTextHash`; `service.push` advances the baseline per verified op on a running manifest copy (the original `advanceBaseline` rewrites the whole file, so the previous result is carried, not re-read) | Precondition: `normalizedTextHash(editor doc)` equals the zip's `normalizedHash` (same BOM/CRLF transform as `manifest.ts`), unless the doc already equals the desired content (no-op). Read-back is strict on this path regardless of `verifyEditorWrites`, and always strict after the keyboard fallback. Settle = `settleWrites(2 s window)` + persistence indicator idle. Retries: 3 attempts (1 s, 2 s) for `TIMEOUT`, `UI_CHANGED`, `SELECTOR_NOT_FOUND`, `WRITE_NOT_VERIFIED` and uncoded errors; never for `WRONG_FILE_OR_CHANGED`, `EXPLORER_MISMATCH`, `LEFTOVER_FILE`, `AMBIGUOUS_*`, auth/unavailable/abort or delete outcomes. Any op failure stops at that boundary: `stopped = { phase: "sending", code, message, remaining }`, later ops listed as `STOPPED`. |
| #6 delete truthfulness | `deletePath`; `deleteAction` adds `delete-file-menu-item` / `delete-folder-menu-item`; `deleteConfirmButton` adds `confirmation-modal-confirm-action-button`; `renameAction` adds `rename-folder-menu-item`; `DeleteResult.code` | A row that is not in the index returns `failed` / `EXPLORER_MISMATCH` (never `deleted`). Success requires the path to vanish from a fresh index and the parent's child count to shrink by one; otherwise `failed` / `DELETE_NOT_VERIFIED`. The baseline keeps the path in both failure cases. |
| #7 final verification (P1, minimal) | end of `service.push`, `ProjectStateStore.readBaselineSnapshot` / `restoreBaselineEntries` | Second zip after the last op. Sent paths: content equal => `verified`; missing => `NOT_SAVED`; different => `CHANGED_AFTER_SEND`; deletes still present => `NOT_SAVED`. For each mismatch the pre-push baseline entry and bytes (captured before the op) are restored, so the file shows as dirty and the next push sees it as diverged instead of overwriting. Untouched paths that differ from the baseline are reported in `PushResult.remoteChanged` and logged, never altered. |
| #8 error taxonomy (P1, minimal) | `pushMessage` in `push-plan.ts`; typed errors `ExplorerMismatchError`, `TreeIndexIncompleteError`, `AmbiguousRemotePathError`, `FileChangedInFigmaError`, `WriteNotVerifiedError`, `LeftoverFileError`; `PushResult.unresolved[].code`, metadata `unresolved[].code`; app `pushStopCode` | Every code has one short message that names the file and says what changed in Figma. The app shows `result.stopped.message` (or the first coded unresolved reason) instead of the generic sentence. |
| #13 live smoke | `scripts/smoke-figma-readonly.ts` | Opt-in, read-only, refuses the live profile, copies the given profile to a temp dir and deletes it. Runs the real `indexExplorer` (expands `src`), re-asserts the root / `src` `OutlookScreen.tsx` pair at their offsets, opens the Files menu and both context menus to read them (Escape), reads inputs / persistence / editor shape. Never clicks a file row (narrower than the design's 7.4). |

Progress: the three phases (`checking` / `sending` / `saving`) are kept so the app and renderer are unchanged; `PushProgress` gained optional `detail`, `finished.code` and `stopped`. `total` is the plan's op count (no-ops included), creates run before replaces, deletes last. `percent` reaches 100 only on a push that did not stop.

### Deviations from the design, with reasons

1. **Blocked local items stop the whole push** (binary edit, nested binary, oversize, bad name), as the design says; this changes two `tests/engine-core.test.ts` expectations (previously the binary was skipped and the rest sent). The message tells the user to ignore the file; ignoring it unblocks the next send.
2. **No separate `preflight` / `indexing` / `verifying` phases and no `mkdir` op in `PushProgress`.** The renderer and `SendProgress` know three phases and four ops; indexing is reported under `checking` with `detail`, `mkdir` is shown as `create`. Additive fields only.
3. **Same-folder renames still run as create + delete** (design task #12 is P1 and not done); the delete only runs after the create verified (`counterpart`).
4. **The open-file DOM signal is best-effort.** After clicking a row the adapter waits for `aria-selected="true"` on that treeitem *or* a change of the editor document; if neither appears and no row in the index ever exposed a selection signal, it proceeds with a warning and the content precondition decides (as the design's 4.2 note allows). If a selection signal exists but the clicked row never gets it, `WRONG_FILE`.
5. **Completeness proof does not use `scrollHeight / rowHeight`.** It uses the tree container's own height to stop the pass and the aria proofs (setsize/posinset per expanded folder, contiguity of tops) to prove completeness, so a scroller with padding or a header cannot cause false `TREE_INDEX_INCOMPLETE`.
6. **Messages may be three sentences** (the design said two) because each block message also states "Nothing was changed in Figma."
7. **`commitPendingChanges` is called after every create/replace** so test fakes see per-file commits; in the Playwright adapter it is a no-op because the transaction settled already. `tests/push-batching.test.ts` now expects two commits and creates before replaces.
8. **Journal (P1 #10), interruptions (#11), time budget / cancel wording (#9)** are not done. Cancel still throws `AutomationAbortedError` between ops; because the baseline advanced per op, the next push resumes with exactly the remaining files (covered by a test).

### Tests added

- `tests/support/fake-make-explorer.ts`: generated page mimicking 1.3 (flat `role=tree`, aria rows, absolute tops, 826 px scroller, viewport +-3 rows mounted, synchronous re-render on scroll, read-only name inputs, context menus / Files menu with the live testids, delete modal, "Show hidden files" checkbox, CodeMirror shim, persistence cycling) with `window.__fault` injection and `window.__model()` for assertions. `makeProject()` reproduces the live shape (54 root rows incl. 5 folders, 48 in `src`, same names at both levels, 4 hidden root files, `src/.DS_Store`).
- `tests/adapter-explorer.test.ts` (21): fixture self-check; `reconstructTree` proofs; index with duplicates across levels; `src/OutlookScreen.tsx` replaced from a single-level window while the root twin stays; idempotent no-op; `WRONG_FILE_OR_CHANGED` writes nothing; `WRITE_NOT_VERIFIED` strict with `verifyEditorWrites=false`; dropped row -> `TREE_INDEX_INCOMPLETE`, nothing written; duplicate label -> `AMBIGUOUS_REMOTE_PATH`; missing path -> `EXPLORER_MISMATCH`; no selection signal -> content fallback; hidden dot-file toggle on / edit / restored off on close; no toggle -> "unavailable"; nested create, mkdir, create inside the new folder, root create via the Files menu, no stray `new-file*`; read-only-only input -> no Enter, no leftover; name never applies -> `LEFTOVER_FILE` naming `src` and `new-file-5.tsx`; context menu never opens -> `UI_CHANGED`, nothing created; delete seen-to-disappear / row stays / row absent.
- `tests/push-plan.test.ts` (10): every row of table 3.4 for replace / create / delete incl. hidden handling and unknown rows; mkdir ordering and `NAME_COLLISION`; duplicate labels; op ordering and rename counterparts; `validateLocalPlan`; `invalidNameReason`; `resolveDiverged` declined / approved; every message names the file, <= 3 sentences, no jargon.
- `tests/push-transaction.test.ts` (12, scripted session with the adapter's contract): explorer mismatch stops before any write; hidden file sent / refused; mkdir -> create -> replace -> delete with per-op baseline; stop at the first failed file with the exact remaining set and a clean retry; precondition mismatch never written and never retried; no-op advances the baseline; final zip check reports `CHANGED_AFTER_SEND` / `NOT_SAVED` and rolls the baseline back so the next push sees them as diverged; untouched remote changes reported; cancel between files keeps done files; unverifiable delete keeps the path; diverged declined / approved; 300 files with monotonic progress and a single 100 %.
- Updated: `tests/engine-core.test.ts`, `tests/push-batching.test.ts`, `tests/figma-selectors.test.ts` (new keys).

Two more fixes came out of that probe's facts: (a) `usesAriaTree()` no longer caches "older UI" when nothing is mounted yet (it re-probes next time, and the pixel-depth path refuses to scroll while the virtualised container exists, failing with `UI_CHANGED` so the op is retried through the index); (b) because no editor surface exists before the first file is opened, "editor became readable" now counts as the open confirmation (the fake renders `.cm-content` only after the first open, and mounts rows late on request).

### Residual blind spot in this project (state it plainly)

Root `OutlookScreen.tsx` and `src/OutlookScreen.tsx` are byte-identical in Figma, and live rows expose no selection signal. If a click ever landed on the sibling row, the content precondition would pass and the sibling would be overwritten. The index + `(level, label, top)` re-assertion makes that very unlikely, and the final zip compare would then report the intended path as `CHANGED_AFTER_SEND` (baseline rolled back) and the sibling under `remoteChanged`, but the sibling's content would already be changed. Only a real send can rule this out.

### Not verified (depends on real Figma behaviour)

Run `FIGMAKE_SMOKE_URL=<make url> npx tsx scripts/smoke-figma-readonly.ts --profile <copy of the browser profile>` (add `--hidden` to also exercise the toggle) to check the read-only parts; the items marked "write" can only be confirmed by a real send.

- (read) `aria-selected` / any selection signal on the open file's row - the design's probe saw none at rest. Handled by the fallback described in deviation 4.
- (write) Whether the editor's document equals the zip bytes after normalisation (the precondition). If Figma reformats on display, every replace stops with `WRONG_FILE_OR_CHANGED`; the message makes that visible immediately and nothing is written.
- (write) "Show hidden files" toggle semantics (checkbox vs. persisted preference) and whether hidden rows then carry the same aria attributes.
- (write) Default names Figma gives new entries (`new-file.tsx`, `new-folder` assumed), that Enter applies the typed name, and the Rename flow's input value (assumed to equal the current label).
- (write) Delete confirmation `confirmation-modal-confirm-action-button` (seen in a saved DOM, not exercised) and that the row disappears without a reload.
- (write) Autosave timing: `settleWrites(2 s)` + persistence idle is a heuristic; the final zip compare is the authoritative check.
- (write) Upload of an existing root-level name (overwrite vs. duplicate) is still unknown and still not used for replaces.

### Live read-only probe (what it taught, and changed)

The first run of `scripts/smoke-figma-readonly.ts` against the live project failed with `TREE_INDEX_INCOMPLETE ("the top level" shows 31 of 54 entries)`: the live `role="tree"` box is **shorter than its rows** (absolutely positioned children overflow it; only the scroller's `scrollHeight` reflects the list), so a pass that stopped at the container's height read one window only. The pass now runs until the scroller's bottom, the read script waits (bounded) until a row of the new window is mounted, and the fake was changed to the same shape (`tree` box 0 px, a spacer gives the scroller its height). This is exactly the class of mistake the completeness proof exists for: it was caught before any write, with a plain reason. A second cause hid behind it: Playwright treats the zero-height container as *not visible*, so `fileTreeRoot` resolved to a large ancestor and a scroller search that walked up from the root never met the scroller; the finder now starts from a row and walks up.

Third run (2026-11-10, after both fixes, read-only, profile copy deleted afterwards) **[verified live]**: 102 rows = 54 top-level (aria-setsize 54) + 48 in `src` (setsize 48), row height 32 px, no duplicate labels; `src/OutlookScreen.tsx` -> level 2 / top 1120, `OutlookScreen.tsx` -> level 1 / top 2688, `src/WorkflowEmail.tsx` -> level 2 / top 1664, each re-asserted at its offset; **no row exposes a selection signal at rest** (so the open-file check will rely on the editor-content change plus the content precondition); Files menu = Create file | Create folder | Upload file | Download code | Hard refresh | Restart language server | Show hidden files; folder menu testids `create-file-menu-item`, `create-folder-menu-item`, `rename-folder-menu-item`, `delete-folder-menu-item`; file menu has `delete-file-menu-item` and a Rename without testid; 36 read-only `code-file-name-input`s and **0 editable ones at rest** (the `:not([readonly])` gate is sound); `upload-file-input` present, no `webkitdirectory`; persistence status `unknown`; the editor shows no `.cm-content` until a file is opened (expected, nothing was clicked).

### Final verification

`npx tsc --noEmit -p .` and `npx eslint src tests scripts` clean. Full `npx vitest run`: 587 passed, 1 skipped (one earlier full run under the same load showed 2 failures in the Chromium-backed suites that did not reproduce on the immediate re-run; the names were cut off by the output filter, so treat the browser suites as timing-sensitive under full parallel load).

### Loose ends seen while working (not mine)

- `src/app/session.ts` (a `reapStaleDevServer` call at start-up) and `src/harness/agents/claude.ts` were modified outside this session while it ran; both compile and lint as of the end of the session.
