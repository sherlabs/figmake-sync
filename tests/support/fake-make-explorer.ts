/**
 * A faithful stand-in for the Figma Make "Files" view (shape verified live on 2026-11-10, see docs/PUSH-DESIGN.md 1.3):
 * a flat virtualised `role="tree"` whose `role="treeitem"` rows carry aria-level/posinset/setsize/label/expanded/selected and an
 * absolute `top`; only the rows inside the scroller's viewport (± 3 rows of overscan) are mounted, re-rendered synchronously on
 * scroll; the label lives only in aria-label and a read-only `code-file-name-input`; folders wrap their button in
 * `[data-folder-item]`; context menus / Files actions menu / delete confirmation / "Show hidden files" use the live testids;
 * the editor exposes a CodeMirror-like `cmView.view` shim and the persistence status cycles `unknown -> saving -> unknown`.
 *
 * Faults are read lazily from `window.__fault` so a test can switch them on after `page.setContent`.
 */

export interface FakeNode {
  name: string;
  kind: "file" | "folder";
  content?: string;
  children?: FakeNode[];
  /** Hidden by the explorer unless "Show hidden files" is on (dot-files, lock files). */
  hidden?: boolean;
}

export interface FakeFaults {
  /** That row is never mounted (virtualiser bug). */
  dropPath?: string;
  /** The create/rename name input stays read-only (create UI broken). */
  readonlyNameInput?: boolean;
  /** Enter keeps the default name and Rename never applies. */
  renameFails?: boolean;
  /** `cmView.view.dispatch` does nothing. */
  editorIgnoresWrites?: boolean;
  /** The editor shows this text instead of the file's content (doc != zip). */
  docOverride?: Record<string, string>;
  /** The delete confirmation closes but removes nothing. */
  deleteNoop?: boolean;
  /** The Files actions menu has no "Show hidden files" item. */
  noHiddenToggle?: boolean;
  /** Right-click never opens a context menu. */
  contextMenuNever?: boolean;
  /** Clicking a file swaps the editor but never sets aria-selected (the live signal is unverified). */
  clickNoSelect?: boolean;
  /** After a write, the "server" rewrites the file to this text (AI / concurrent edit after send). */
  mutateAfterWrite?: Record<string, string>;
}

export interface FakeModel {
  files: Record<string, string>;
  folders: string[];
  hiddenShown: boolean;
  pending: string | null;
  selected: string | null;
  open: string | null;
  events: string[];
  writes: number;
}

export interface FakeExplorerOptions {
  faults?: FakeFaults;
  /** Height of the scrolling pane (826 px live at 1440x960). */
  scrollerHeight?: number;
  /** Rows mount only this long after the Files tab opens (slow live load). */
  mountDelayMs?: number;
}

const ROOT_FILES = [
  "AGENTS.md", "App.tsx", "Attributions.md", "ClientDetails.tsx", "ClientMatters.tsx", "Dashboard.tsx", "DiaryEntry.tsx",
  "GlobalAdmin.css", "GlobalAdmin.tsx", "index.html", "InvoiceList.tsx", "Login.tsx", "mailData.ts", "MatterDetails.tsx",
  "matterData.ts", "matterReminders.ts", "MatterSummary.tsx", "NavBar.tsx", "OrganisationSettings.tsx", "OutlookScreen.tsx",
  "package.json", "postcss.config.js", "RCDiary.css", "RCDiary.tsx", "RCQuotes.tsx", "README.md", "Reports.tsx", "Settings.tsx",
  "Sidebar.tsx", "tailwind.config.js", "TaskList.tsx", "TimeEntry.tsx", "tsconfig.json", "UserAdmin.tsx", "vite.config.ts",
  "WorkflowEmail.css", "WorkflowEmail.tsx", "new-file.tsx", "new-file-1.tsx", "new-file-2.tsx", "new-file-3.tsx", "new-file-4.tsx",
  "Billing.tsx", "Calendar.tsx", "Contacts.tsx", "Documents.tsx", "Help.tsx", "Notes.tsx", "Profile.tsx",
];

const SRC_FILES = [
  "App.tsx", "ClientDetails.tsx", "ClientMatters.tsx", "Dashboard.tsx", "DiaryEntry.tsx", "GlobalAdmin.css", "GlobalAdmin.tsx",
  "index.css", "InvoiceList.tsx", "Login.tsx", "mailData.ts", "main.tsx", "MatterDetails.tsx", "matterData.ts", "matterReminders.ts",
  "MatterSummary.tsx", "NavBar.tsx", "OrganisationSettings.tsx", "OutlookScreen.tsx", "RCDiary.css", "RCDiary.tsx", "RCQuotes.tsx",
  "Reports.tsx", "Settings.tsx", "Sidebar.tsx", "TaskList.tsx", "TimeEntry.tsx", "UserAdmin.tsx", "WorkflowEmail.css",
  "WorkflowEmail.tsx", "new-file.tsx", "new-file-1.tsx", "new-file-2.tsx", "new-file-3.tsx", "new-file-4.tsx", "Billing.tsx",
  "Calendar.tsx", "Contacts.tsx", "Documents.tsx", "Help.tsx", "Notes.tsx", "Profile.tsx", "Search.tsx", "Tags.tsx", "Users.tsx",
  "vite-env.d.ts",
];

export function fileNode(name: string, content?: string, hidden = false): FakeNode {
  return { name, kind: "file", content: content ?? `// ${name}\nexport const x = 1;\n`, ...(hidden ? { hidden } : {}) };
}

export function folderNode(name: string, children: FakeNode[], hidden = false): FakeNode {
  return { name, kind: "folder", children, ...(hidden ? { hidden } : {}) };
}

/**
 * A project shaped like the live one: 49 visible root files + 4 hidden, 5 root folders, `src` with 46 files + 2 folders + 1 hidden,
 * same names at root and in `src` (OutlookScreen.tsx, WorkflowEmail.tsx, ...). `extra` nodes are added at root.
 */
export function makeProject(options: { extra?: FakeNode[]; srcExtra?: FakeNode[] } = {}): FakeNode[] {
  const withPath = (dir: string, names: string[]): FakeNode[] => names.map((n) => fileNode(n, `// ${dir}${n}\nexport const v = "${dir}${n}";\n`));
  const src = folderNode("src", [
    folderNode("assets", [fileNode("logo.svg", "<svg/>")]),
    folderNode("imports", [fileNode("figma.ts")]),
    ...withPath("src/", SRC_FILES),
    fileNode(".DS_Store", "", true),
    ...(options.srcExtra ?? []),
  ]);

  return [
    folderNode(".figma", [fileNode("make.json", "{}")]),
    folderNode("assets", [fileNode("a.css")]),
    folderNode("imports", [fileNode("i.ts")]),
    folderNode("public", [fileNode("favicon.ico", "ico")]),
    src,
    ...withPath("", ROOT_FILES),
    fileNode(".gitattributes", "* text=auto\n", true),
    fileNode(".gitignore", "node_modules\n", true),
    fileNode(".mise.toml", "[tools]\n", true),
    fileNode("pnpm-lock.yaml", "lockfileVersion: 9\n", true),
    ...(options.extra ?? []),
  ];
}

/** Flat `path -> content` of every file (hidden ones included), i.e. what the "zip" contains. */
export function flattenFiles(tree: FakeNode[], prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};

  for (const node of tree) {
    const p = prefix ? `${prefix}/${node.name}` : node.name;

    if (node.kind === "file") out[p] = node.content ?? "";
    else Object.assign(out, flattenFiles(node.children ?? [], p));
  }

  return out;
}

export function fakeExplorerHtml(tree: FakeNode[], options: FakeExplorerOptions = {}): string {
  const height = options.scrollerHeight ?? 826;
  const mountDelay = options.mountDelayMs ?? 0;
  const faults = JSON.stringify(options.faults ?? {});
  const data = JSON.stringify(tree);

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  [hidden]{display:none!important}
  body{margin:0;font:13px sans-serif}
  #scroller{height:${height}px;overflow:auto;width:420px;position:relative;border:1px solid #ddd}
  #tree{position:relative;width:100%;overflow:visible}
  [role=treeitem]{position:absolute;left:0;width:100%;height:32px}
  [role=treeitem] button{display:flex;align-items:center;width:100%;height:32px;border:0;background:none;text-align:left;padding:0;cursor:pointer}
  [role=treeitem][aria-selected=true] button{background:#dde}
  .ind{display:flex;align-items:center;height:32px}
  .ind span{display:inline-flex;width:16px;height:16px;margin-right:4px}
  input[data-testid=code-file-name-input][readonly]{border:0;background:transparent;pointer-events:none;width:200px;height:20px;font:inherit}
  input[data-testid=code-file-name-input]:not([readonly]){border:1px solid #36f;width:200px;height:20px;font:inherit}
  [role=menu]{position:absolute;background:#fff;border:1px solid #888;padding:4px;z-index:5}
  [role=menuitem],[role=menuitemcheckbox]{padding:4px 8px;cursor:pointer}
  [role=dialog]{position:fixed;top:40px;left:40px;background:#fff;border:1px solid #000;padding:12px;z-index:6}
  #editor{min-height:200px;width:420px;border:1px dashed #ccc}
  .cm-content{min-height:60px;width:400px;border:1px solid #aaa;white-space:pre;font-family:monospace}
</style></head><body>
<nav>
  <button data-workspace-tab="true" aria-pressed="true" id="tb" type="button"><span><svg aria-hidden="true" width="8" height="8"></svg></span><span>Browser</span></button>
  <button data-workspace-tab="true" aria-pressed="false" id="tf" type="button"><span><svg aria-hidden="true" width="8" height="8"></svg></span><span>Files</span></button>
</nav>
<div id="browser" data-testid="figmake-full-view">preview of the app</div>
<div id="files" hidden>
  <button data-testid="files-header-actions-menu-button" aria-label="File actions" id="am" type="button">...</button>
  <div role="menu" id="menu" hidden></div>
  <input type="file" multiple hidden data-testid="image-attachment-input">
  <input type="file" multiple hidden data-testid="upload-file-input">
  <div style="display:flex;gap:12px">
    <div id="scroller"><div role="tree" data-testid="virtualized-file-tree-container" id="tree"></div><div id="spacer"></div></div>
    <div>
      <div data-testid="code-layer-persistence-status" data-code-layer-persistence-status="unknown">
        <div data-testid="code-editor" id="editor"></div>
      </div>
      <div data-testid="code-chat-chat-box" role="textbox" aria-label="Prompt for AI agent" contenteditable="true" style="width:200px;height:30px"></div>
      <button data-testid="code-chat-send-button" aria-label="Send" type="button">^</button>
    </div>
  </div>
</div>
<script>
(() => {
  const DATA = ${data};
  const ROW = 32;
  const MOUNT_DELAY = ${mountDelay};
  let mountedAt = null;
  window.__fault = ${faults};
  const fault = () => window.__fault || {};
  const state = { expanded: new Set(), hiddenShown: false, selected: null, open: null, pending: null, menu: null, dialog: null, writes: 0, events: [] };
  const $ = (id) => document.getElementById(id);
  const log = (e) => state.events.push(e);

  // ---- model ----
  const join = (a, b) => (a ? a + '/' + b : b);
  function nodeAt(path) {
    if (!path) return { kind: 'folder', children: DATA, name: '' };
    let list = DATA, node = null;
    for (const seg of path.split('/')) {
      node = (list || []).find((n) => n.name === seg) || null;
      if (!node) return null;
      list = node.children;
    }
    return node;
  }
  const parentPath = (path) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const sortChildren = (list) => [...list].sort((a, b) => a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  function rows() {
    const out = [];
    const walk = (children, level, parent) => {
      const vis = sortChildren(children).filter((n) => state.hiddenShown || !n.hidden);
      vis.forEach((n, i) => {
        const path = join(parent, n.name);
        const expanded = n.kind === 'folder' ? state.expanded.has(path) : null;
        out.push({ node: n, path, level, posinset: i + 1, setsize: vis.length, expanded });
        if (expanded) walk(n.children || [], level + 1, path);
      });
    };
    walk(DATA, 1, '');
    return out;
  }
  function content(path) {
    const o = fault().docOverride;
    if (o && Object.prototype.hasOwnProperty.call(o, path)) return o[path];
    const n = nodeAt(path);
    return n && n.kind === 'file' ? (n.content || '') : '';
  }

  // ---- rendering (virtualised) ----
  const scroller = $('scroller'), tree = $('tree'), spacer = $('spacer');
  function render() {
    if (MOUNT_DELAY > 0) {
      if (mountedAt === null) { mountedAt = Date.now(); setTimeout(render, MOUNT_DELAY + 10); }
      if (Date.now() - mountedAt < MOUNT_DELAY) { tree.replaceChildren(); return; }
    }
    const list = rows();
    // Live: the role=tree box is NOT the list's height; its absolutely positioned rows overflow it (overflow: visible)
    // and only the scroller's scrollHeight reflects the whole list. A spacer keeps the scroller that tall.
    tree.style.height = '0px';
    spacer.style.height = (list.length * ROW) + 'px';
    const st = scroller.scrollTop, ch = scroller.clientHeight;
    const lo = Math.max(0, Math.floor(st / ROW) - 3);
    const hi = Math.min(list.length - 1, Math.ceil((st + ch) / ROW) + 3);
    const frag = document.createDocumentFragment();
    for (let i = lo; i <= hi; i += 1) {
      const r = list[i];
      if (fault().dropPath === r.path) continue;
      frag.appendChild(rowEl(r, i));
    }
    tree.replaceChildren(frag);
    if (state.pending) {
      const inp = tree.querySelector('[data-path="' + CSS.escape(state.pending.path) + '"] input');
      if (inp && !inp.readOnly && document.activeElement !== inp) inp.focus();
    }
    renderEditor();
  }
  function rowEl(r, i) {
    const d = document.createElement('div');
    d.setAttribute('role', 'treeitem');
    d.setAttribute('aria-level', String(r.level));
    d.setAttribute('aria-posinset', String(r.posinset));
    d.setAttribute('aria-setsize', String(r.setsize));
    d.setAttribute('aria-label', r.node.name);
    d.setAttribute('aria-selected', String(state.selected === r.path));
    if (r.node.kind === 'folder') d.setAttribute('aria-expanded', String(r.expanded));
    d.dataset.path = r.path;
    d.style.top = (i * ROW) + 'px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', (r.node.kind === 'folder' ? 'Folder "' : 'File "') + r.node.name + '"');
    const ind = document.createElement('div');
    ind.className = 'ind';
    ind.style.setProperty('--x-paddingLeft', (8 + 16 * (r.level - 1)) + 'px');
    ind.style.paddingLeft = (8 + 16 * (r.level - 1)) + 'px';
    const icon = document.createElement('span');
    icon.innerHTML = '<svg width="16" height="16" aria-hidden="true"></svg>';
    ind.appendChild(icon);
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-testid', 'code-file-name-input');
    input.value = r.node.name;
    const editing = state.pending && state.pending.path === r.path;
    if (editing && !fault().readonlyNameInput) {
      input.addEventListener('keydown', onEditKey);
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('mousedown', (e) => e.stopPropagation());
    } else {
      input.readOnly = true;
      input.tabIndex = -1;
    }
    ind.appendChild(input);
    btn.appendChild(ind);
    if (r.node.kind === 'folder') {
      btn.setAttribute('aria-expanded', String(r.expanded));
      const w = document.createElement('div'); w.setAttribute('data-folder-item', 'true');
      const a = document.createElement('div'); const b = document.createElement('div');
      b.appendChild(btn); a.appendChild(b); w.appendChild(a); d.appendChild(w);
    } else {
      btn.setAttribute('data-testid', 'code-file-item');
      btn.draggable = true;
      d.appendChild(btn);
    }
    btn.addEventListener('click', () => onRowClick(r));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); onContext(r, e); });
    return d;
  }
  scroller.addEventListener('scroll', render);

  // ---- editor (live: no CodeMirror surface exists until the first file is opened) ----
  const cm = document.createElement('div');
  cm.className = 'cm-content';
  cm.setAttribute('role', 'textbox');
  cm.setAttribute('contenteditable', 'true');
  cm.id = 'cm';
  const status = document.querySelector('[data-code-layer-persistence-status]');
  const doc = {
    toString: () => state.open === null ? '' : content(state.open),
    get length() { return state.open === null ? 0 : content(state.open).length; },
  };
  cm.cmView = { view: {
    state: { doc },
    dispatch: (tr) => {
      if (state.open === null || fault().editorIgnoresWrites) return;
      const c = tr && tr.changes;
      if (!c) return;
      const node = nodeAt(state.open);
      if (!node) return;
      const cur = content(state.open);
      const next = cur.slice(0, c.from) + (c.insert || '') + cur.slice(c.to);
      if (fault().docOverride) delete fault().docOverride[state.open];
      node.content = next;
      state.writes += 1;
      log('write:' + state.open);
      status.setAttribute('data-code-layer-persistence-status', 'saving');
      const path = state.open;
      setTimeout(() => {
        status.setAttribute('data-code-layer-persistence-status', 'unknown');
        const m = fault().mutateAfterWrite;
        if (m && Object.prototype.hasOwnProperty.call(m, path)) { node.content = m[path]; delete m[path]; }
      }, 60);
      renderEditor();
    },
    focus: () => cm.focus(),
  } };
  function renderEditor() {
    if (state.open !== null && !cm.isConnected) $('editor').appendChild(cm);
    cm.textContent = state.open === null ? '' : content(state.open);
  }

  // ---- interactions ----
  function onRowClick(r) {
    if (state.pending && state.pending.path === r.path) return;
    closeMenu();
    if (r.node.kind === 'folder') {
      if (state.expanded.has(r.path)) state.expanded.delete(r.path); else state.expanded.add(r.path);
      log((state.expanded.has(r.path) ? 'expand:' : 'collapse:') + r.path);
    } else {
      if (!fault().clickNoSelect) state.selected = r.path;
      state.open = r.path;
      log('open:' + r.path);
    }
    render();
  }
  function onContext(r, e) {
    if (fault().contextMenuNever) return;
    closeMenu();
    const items = r.node.kind === 'folder'
      ? [['Create file', 'create-file-menu-item', () => startCreate(r.path, 'file')], ['Create folder', 'create-folder-menu-item', () => startCreate(r.path, 'folder')], ['Copy path', null, null], ['Download', null, null], ['Rename', 'rename-folder-menu-item', () => startRename(r.path)], ['Delete', 'delete-folder-menu-item', () => openDelete(r.path)]]
      : [['Copy path', null, null], ['Download', null, null], ['Rename', null, () => startRename(r.path)], ['Delete', 'delete-file-menu-item', () => openDelete(r.path)], ['Add to chat', null, null]];
    const m = document.createElement('div');
    m.setAttribute('role', 'menu');
    m.id = 'ctx';
    m.style.left = e.clientX + 'px';
    m.style.top = e.clientY + 'px';
    for (const [text, testid, act] of items) {
      const it = document.createElement('div');
      it.setAttribute('role', 'menuitem');
      if (testid) it.setAttribute('data-testid', testid);
      it.textContent = text;
      it.addEventListener('click', () => { closeMenu(); if (act) act(); });
      m.appendChild(it);
    }
    document.body.appendChild(m);
    state.menu = m;
  }
  function closeMenu() {
    if (state.menu) { state.menu.remove(); state.menu = null; }
    $('menu').hidden = true;
  }
  function uniqueDefault(parent, base, ext) {
    const names = new Set((parent.children || []).map((n) => n.name));
    let name = base + ext, i = 1;
    while (names.has(name)) { name = base + '-' + i + ext; i += 1; }
    return name;
  }
  function startCreate(parent, kind) {
    const p = nodeAt(parent);
    if (!p || p.kind !== 'folder') return;
    if (parent && !state.expanded.has(parent)) state.expanded.add(parent);
    const name = kind === 'file' ? uniqueDefault(p, 'new-file', '.tsx') : uniqueDefault(p, 'new-folder', '');
    const node = kind === 'file' ? { name, kind: 'file', content: '' } : { name, kind: 'folder', children: [] };
    p.children = p.children || [];
    p.children.push(node);
    state.pending = { path: join(parent, name), mode: 'create', parent, kind };
    log('create-start:' + state.pending.path);
    render();
    const idx = rows().findIndex((r) => r.path === state.pending.path);
    if (idx >= 0) { scroller.scrollTop = Math.max(0, idx * ROW - 100); render(); }
  }
  function startRename(path) {
    state.pending = { path, mode: 'rename', parent: parentPath(path), kind: nodeAt(path).kind };
    log('rename-start:' + path);
    render();
  }
  function onEditKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      log('enter');
      const node = nodeAt(state.pending.path);
      const value = e.target.value.trim();
      const parent = nodeAt(state.pending.parent);
      const taken = (parent.children || []).some((n) => n !== node && n.name === value);
      if (!fault().renameFails && value && !value.includes('/') && !taken) {
        log((state.pending.mode === 'create' ? 'created:' : 'renamed:') + join(state.pending.parent, value));
        node.name = value;
      } else {
        log('name-kept:' + node.name);
      }
      state.pending = null;
      render();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelPending();
    }
  }
  function cancelPending() {
    if (!state.pending) return;
    log('escape');
    if (state.pending.mode === 'create') {
      const parent = nodeAt(state.pending.parent);
      const node = nodeAt(state.pending.path);
      parent.children = parent.children.filter((n) => n !== node);
    }
    state.pending = null;
    render();
  }
  function openDelete(path) {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.innerHTML = '<p>Delete "' + path + '"?</p>';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.type = 'button';
    cancel.addEventListener('click', () => { d.remove(); state.dialog = null; });
    const ok = document.createElement('button'); ok.textContent = 'Delete'; ok.type = 'button';
    ok.setAttribute('data-testid', 'confirmation-modal-confirm-action-button');
    ok.addEventListener('click', () => {
      d.remove(); state.dialog = null;
      log('delete-confirm:' + path);
      if (fault().deleteNoop) return;
      const parent = nodeAt(parentPath(path));
      const node = nodeAt(path);
      parent.children = parent.children.filter((n) => n !== node);
      if (state.open === path) { state.open = null; state.selected = null; }
      log('deleted:' + path);
      render();
    });
    d.appendChild(cancel); d.appendChild(ok);
    document.body.appendChild(d);
    state.dialog = d;
  }

  // ---- header menu / tabs ----
  function renderHeaderMenu() {
    const menu = $('menu');
    menu.replaceChildren();
    const items = [['Create file', 'create-file-header-button', () => startCreate('', 'file')], ['Create folder', 'create-folder-menu-item', () => startCreate('', 'folder')], ['Upload file', 'upload-file-header-button', null], ['Download code', null, download], ['Hard refresh', null, null], ['Restart language server', null, null]];
    for (const [text, testid, act] of items) {
      const it = document.createElement('div');
      it.setAttribute('role', 'menuitem');
      if (testid) it.setAttribute('data-testid', testid);
      it.textContent = text;
      it.addEventListener('click', () => { closeMenu(); if (act) act(); });
      menu.appendChild(it);
    }
    if (!fault().noHiddenToggle) {
      const it = document.createElement('div');
      it.setAttribute('role', 'menuitemcheckbox');
      it.setAttribute('aria-checked', String(state.hiddenShown));
      it.textContent = 'Show hidden files';
      it.addEventListener('click', () => { state.hiddenShown = !state.hiddenShown; log('hidden:' + state.hiddenShown); closeMenu(); render(); });
      menu.appendChild(it);
    }
  }
  function download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['zipdata'])); a.download = 'Project.zip'; document.body.appendChild(a); a.click();
  }
  $('am').addEventListener('click', (e) => { e.stopPropagation(); const menu = $('menu'); if (menu.hidden) { renderHeaderMenu(); menu.hidden = false; } else menu.hidden = true; });
  $('tf').addEventListener('click', () => { $('browser').hidden = true; $('files').hidden = false; $('tf').setAttribute('aria-pressed', 'true'); $('tb').setAttribute('aria-pressed', 'false'); render(); });
  $('tb').addEventListener('click', () => { $('browser').hidden = false; $('files').hidden = true; $('tb').setAttribute('aria-pressed', 'true'); $('tf').setAttribute('aria-pressed', 'false'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); if (state.dialog) { state.dialog.remove(); state.dialog = null; } cancelPending(); } });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('[role=menu]') && !e.target.closest('#am')) closeMenu(); });

  // ---- test hooks ----
  window.__model = () => {
    const files = {}, folders = [];
    const walk = (children, prefix) => { for (const n of children) { const p = join(prefix, n.name); if (n.kind === 'file') files[p] = n.content || ''; else { folders.push(p); walk(n.children || [], p); } } };
    walk(DATA, '');
    return { files, folders, hiddenShown: state.hiddenShown, pending: state.pending ? state.pending.path : null, selected: state.selected, open: state.open, events: [...state.events], writes: state.writes };
  };
  window.__setFile = (path, text) => { const n = nodeAt(path); if (n) n.content = text; renderEditor(); };
  window.__expand = (path) => { state.expanded.add(path); render(); };
  window.__render = render;
})();
</script></body></html>`;
}
