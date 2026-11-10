import type { FileView, FigmakeApi, FolderListing, ProcessInfo, SessionState } from "../contracts.js";
import { dataImage, h, icon, nodes, splitPath } from "./dom.js";

/* The Files tab: a read-only explorer of the open project, a viewer, and what is running.
   Draws what main sends; every path it asks for is re-checked by main. Text only ever becomes text nodes. */

export interface FilesHost {
  api: FigmakeApi;
  mod: string;
  collapse(): void;
}

export interface FilesPanel {
  el: HTMLElement;
  setSession(session: SessionState): void;
  /** Called when the tab becomes visible: loads the tree the first time. */
  show(): void;
}

const MAX_LEVEL = 12;
const STATE_TEXT: Record<ProcessInfo["state"], string> = { starting: "Starting", running: "Running", stopped: "Stopped", failed: "Failed" };
const DOT: Record<ProcessInfo["state"], string> = { starting: "chg", running: "ok", stopped: "", failed: "bad" };

const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function createFilesPanel(host: FilesHost): FilesPanel {
  const { api } = host;
  let sess: SessionState | null = null;
  let key: string | null = null;
  let gen = 0;
  let visible = false;
  let lastPhase = "";
  let autoOpened = false;
  const listings = new Map<string, FolderListing | "loading">();
  const open = new Set<string>([""]);
  let changed = new Set<string>();
  let changedDirs = new Set<string>();
  let current: string | null = null;
  let view: FileView | "loading" | null = null;

  const hideBtn = h("button", { type: "button", class: "btn icon quiet-icon", "aria-label": "Hide panel", title: `Hide panel (${host.mod}J)`, onclick: () => host.collapse() }, icon("panel"));
  const head = h("header", { class: "files-h" }, hideBtn);
  const tree = h("div", { class: "ftree", role: "tree", "aria-label": "Project files", tabindex: "-1" });
  const viewer = h("section", { class: "fview", "aria-label": "File viewer", hidden: true });
  const running = h("section", { class: "running", "aria-label": "Running" });
  const el = h("aside", { class: "files", "aria-label": "Project files", hidden: true }, head, tree, viewer, running);

  // ---- loading ----
  async function load(dir: string): Promise<void> {
    const mine = gen;
    if (!listings.has(dir)) listings.set(dir, "loading");
    const listing = await api.listFolder(dir).catch(() => ({ path: dir, entries: [], truncated: false }) as FolderListing);
    if (mine !== gen) return;
    listings.set(dir, listing);
    // First look at a project: src is where the designer's screens live, so it starts open.
    if (dir === "" && !autoOpened) {
      autoOpened = true;
      if (listing.entries.some((e) => e.kind === "folder" && e.path === "src") && !open.has("src")) {
        open.add("src");
        void load("src");
      }
    }
    drawTree();
  }

  async function loadChanged(): Promise<void> {
    const mine = gen;
    const paths = await api.changedFiles().catch(() => [] as string[]);
    if (mine !== gen) return;
    changed = new Set(paths);
    changedDirs = new Set(paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
    drawTree();
  }

  function reset(): void {
    gen++;
    listings.clear();
    open.clear();
    open.add("");
    autoOpened = false;
    changed = new Set();
    changedDirs = new Set();
    current = null;
    view = null;
    drawTree();
    drawViewer();
  }

  function refreshAll(): void {
    for (const dir of open) void load(dir);
    void loadChanged();
    if (current) void openFile(current, true);
  }

  async function openFile(path: string, quiet = false): Promise<void> {
    const mine = gen;
    current = path;
    if (!quiet) view = "loading";
    drawViewer();
    drawTree();
    const result = await api.readFile(path).catch(() => ({ kind: "missing", path }) as FileView);
    if (mine !== gen || current !== path) return;
    view = result;
    drawViewer();
  }

  function toggle(dir: string): void {
    if (open.has(dir)) open.delete(dir);
    else {
      open.add(dir);
      if (!listings.has(dir)) void load(dir);
    }
    drawTree();
  }

  // ---- tree ----
  function rows(dir: string, level: number, out: HTMLElement[]): void {
    const listing = listings.get(dir);
    if (listing === "loading" || !listing) {
      if (level > 0 || dir !== "") out.push(h("div", { class: `trow note lv${Math.min(level, MAX_LEVEL)}`, role: "none" }, "Loading…"));
      return;
    }
    for (const entry of listing.entries) {
      const lv = `lv${Math.min(level, MAX_LEVEL)}`;
      if (entry.kind === "folder") {
        const isOpen = open.has(entry.path);
        out.push(
          h(
            "button",
            { type: "button", class: `trow folder ${lv}`, role: "treeitem", "aria-expanded": String(isOpen), onclick: () => toggle(entry.path) },
            icon(isOpen ? "chev-d" : "chev-r", true),
            icon("folder", true),
            h("span", { class: "tname" }, entry.name),
            changedDirs.has(entry.path) ? h("span", { class: "mark sub", title: "Contains changes", "aria-label": "Contains changes" }) : null,
          ),
        );
        if (isOpen) rows(entry.path, level + 1, out);
      } else {
        out.push(
          h(
            "button",
            { type: "button", class: `trow file ${lv}${current === entry.path ? " on" : ""}`, role: "treeitem", "aria-selected": String(current === entry.path), onclick: () => void openFile(entry.path) },
            h("span", { class: "gap" }),
            icon("doc", true),
            h("span", { class: "tname" }, entry.name),
            changed.has(entry.path) ? h("span", { class: "mark", title: "Changed by the AI helper", "aria-label": "Changed" }) : null,
          ),
        );
      }
    }
    if (listing.truncated) out.push(h("div", { class: `trow note lv${Math.min(level, MAX_LEVEL)}` }, "Some files are not shown."));
  }

  function drawTree(): void {
    const out: HTMLElement[] = [];
    const rootListing = listings.get("");
    rows("", 0, out);
    if (rootListing && rootListing !== "loading" && rootListing.entries.length === 0) out.push(h("p", { class: "fempty" }, "No files to show yet."));
    if (!rootListing || rootListing === "loading") out.push(h("p", { class: "fempty" }, "Loading…"));
    tree.replaceChildren(...out);
    tree.classList.toggle("short", current !== null);
  }

  // ---- viewer ----
  function drawViewer(): void {
    viewer.hidden = current === null;
    if (current === null) return viewer.replaceChildren();
    const { dir, name } = splitPath(current);
    const close = h("button", { type: "button", class: "btn icon quiet-icon", "aria-label": "Close file", title: "Close file", onclick: () => { current = null; view = null; drawViewer(); drawTree(); } }, icon("x"));
    const header = h("header", { class: "fv-h" }, h("div", { class: "fv-t" }, h("strong", {}, name), dir ? h("span", {}, dir) : null), h("span", { class: "sp" }), changed.has(current) ? h("span", { class: "chip chg" }, "Changed") : null, h("span", { class: "ro" }, "Read-only"), close);
    let body: HTMLElement;
    if (view === "loading" || view === null) body = h("p", { class: "fempty" }, "Loading…");
    else if (view.kind === "text") {
      const numbers = Array.from({ length: Math.max(1, view.lines) }, (_, i) => String(i + 1)).join("\n");
      body = h("div", { class: "code", tabindex: "0", role: "region", "aria-label": `Contents of ${name}` }, h("pre", { class: "ln", "aria-hidden": "true" }, numbers), h("pre", { class: "src" }, h("code", {}, view.text)));
    } else if (view.kind === "image") body = h("div", { class: "imgview" }, dataImage(view.dataUrl, `Preview of ${name}`));
    else if (view.kind === "large") body = h("p", { class: "fempty" }, `This file is too large to show here (${sizeText(view.size)}).`);
    else if (view.kind === "binary") body = h("p", { class: "fempty" }, "This kind of file can't be shown here.");
    else body = h("p", { class: "fempty" }, "This file isn't available any more.");
    viewer.replaceChildren(header, body);
  }

  // ---- running ----
  function drawRunning(list: ProcessInfo[]): void {
    running.hidden = list.length === 0;
    if (list.length === 0) return running.replaceChildren();
    running.replaceChildren(
      h("h3", {}, "Running"),
      ...list.map((p) =>
        h(
          "div",
          { class: "rrow", "data-process": p.id },
          p.state === "starting" ? h("span", { class: "spin", "aria-hidden": "true" }) : h("span", { class: `dot ${DOT[p.state]}`, "aria-hidden": "true" }),
          h("div", { class: "rname" }, h("strong", {}, p.name), h("span", {}, STATE_TEXT[p.state]), p.note ? h("small", {}, p.note) : null),
          ...nodes(
            p.canStop ? h("button", { type: "button", class: "btn sm", "aria-label": `Stop ${p.name}`, onclick: () => void api.stopProcess(p.id) }, "Stop") : null,
            p.canRestart ? h("button", { type: "button", class: "btn sm", "aria-label": `${p.state === "stopped" ? "Start" : "Restart"} ${p.name}`, onclick: () => void api.restartProcess(p.id) }, p.state === "stopped" ? "Start" : "Restart") : null,
          ),
        ),
      ),
    );
  }

  return {
    el,
    show(): void {
      visible = true;
      if (!key) return;
      if (listings.has("")) refreshAll();
      else {
        void load("");
        void loadChanged();
      }
    },
    setSession(s: SessionState): void {
      sess = s;
      if (s.activeKey !== key) {
        key = s.activeKey;
        reset();
        if (visible && key) {
          void load("");
          void loadChanged();
        }
      } else if (visible && s.phase === "ready" && lastPhase !== "ready") refreshAll();
      lastPhase = s.phase;
      drawRunning(sess.processes ?? []);
    },
  };
}
