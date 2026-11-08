import type {
  DesktopProjectCommandOptions,
  DesktopProgressEvent,
  FigmakeDesktopApi,
} from "../contracts.js";
import type { ProjectInspection, StatusResult } from "../../core/service.js";
import type { PullStrategy } from "../../types/config.js";
import type { ManifestDiff } from "../../diff/manifest.js";

declare global {
  interface Window {
    figmakeSyncDesktop: FigmakeDesktopApi;
  }
}

/* ── Types ──────────────────────────────────────────────────────────────────── */

type FileStatus = "added" | "modified" | "deleted" | "renamed";
type TabName = "sync" | "changes" | "logs" | "setup";

/** A file named by a result. Only says what the result said. */
interface RunFile { path: string; local?: string; remote?: string; code?: string }
interface RunSummary {
  tone: "ok" | "warn";
  headline: string;
  body: string;
  files: RunFile[];
  filesLabel: string;
  retryLabel?: string;
  backupDir?: string;
  note?: string;
}
interface TimelineEntry { message: string; at: number; kind?: "bad" }
interface RunState {
  status: "idle" | "running" | "ok" | "warn" | "error" | "cancelled";
  label: string;
  startedAt: number;
  finishedAt: number | null;
  timeline: TimelineEntry[];
  percent: number | null;
  message: string;
  summary: RunSummary | null;
  error: string | null;
  authError: boolean;
  cancelRequested: boolean;
  retry: (() => void) | null;
}

/** A long task shown in the progress sheet: a project run, or a standalone sign-in / browser install. */
interface LiveTask {
  title: string;
  sub: string;
  hint: string;
  startedAt: number;
  timeline: TimelineEntry[];
  percent: number | null;
  cancelRequested: boolean;
  onStop: (() => void) | null;
}

/** Facts learned from results in this session; metadata only stores timestamps. */
interface SessionFacts {
  pull?: { files: number; backedUp: boolean; dryRun: boolean };
  push?: { files: number; check: "ok" | "skipped" | "unknown"; dryRun: boolean };
  verify?: { differences: number };
}

interface DiffLine { type: "ctx" | "add" | "del"; text: string; oldNum?: number; newNum?: number }
interface SplitRow { left: DiffLine | null; right: DiffLine | null; change: "add" | "del" | "mod" | null }
interface LoadedDiff { rows: SplitRow[]; plus: number; minus: number; content: string; error?: string; note?: string }

interface DiffFile { path: string; status: FileStatus; where: string; lastPull: string; from?: string }

interface ProjectRefs {
  syncPanel: HTMLElement;
  changesPanel: HTMLElement;
  logsPanel: HTMLElement;
  setupPanel: HTMLElement;
  activity: HTMLElement;
  raw: HTMLDetailsElement;
  rawPre: HTMLElement;
  shot: HTMLElement;
  shotImg: HTMLImageElement;
  shotCaption: HTMLElement;
}

interface ProjectState {
  id: string;
  rootDir: string;
  figmaMakeUrl: string;
  linkedProject: ProjectInspection | null;
  options: Omit<DesktopProjectCommandOptions, "rootDir">;
  rowElement: HTMLElement | null;
  viewElement: HTMLElement | null;
  refs: ProjectRefs | null;
  lastDiff: ManifestDiff | null;
  selectedFile: string | null;
  compareOpen: boolean;
  diffCache: Map<string, LoadedDiff>;
  facts: SessionFacts;
  log: TimelineEntry[];
  run: RunState;
}

interface AppState {
  projects: Map<string, ProjectState>;
  activeProjectId: string | null;
  runningProjectId: string | null;
  tab: TabName;
  busy: boolean;
  busyLabel: string;
  auth: boolean | null;
  authReason: string;
  browserReady: boolean;
  task: LiveTask | null;
}

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const ge = {
  app: $("[data-app]"),
  projectList: $("[data-project-list]"),
  sideEmpty: $("[data-side-empty]"),
  addProject: $<HTMLButtonElement>("[data-action='add-project']"),
  authChip: $<HTMLButtonElement>("[data-auth-chip]"),
  authLabel: $("[data-auth-label]"),
  title: $("[data-title]"),
  subtitle: $("[data-subtitle]"),
  tabs: $("[data-detail-tabs]"),
  tabCount: $("[data-tab-count]"),
  tright: $("[data-tright]"),
  pull: $<HTMLButtonElement>("[data-command='pull']"),
  push: $<HTMLButtonElement>("[data-command='push']"),
  pushLabel: $("[data-push-label]"),
  pushMenu: $<HTMLButtonElement>("[data-action='push-menu']"),
  kbdMod: $("[data-kbd-mod]"),
  onboardingBanner: $("[data-onboarding-banner]"),
  onboardingStatus: $("[data-onboarding-status]"),
  depsBanner: $("[data-deps-banner]"),
  depsStatus: $("[data-deps-status]"),
  offlineBanner: $("[data-offline-banner]"),
  authBanner: $("[data-auth-banner]"),
  authBannerText: $("[data-auth-banner-text]"),
  content: $("[data-content]"),
  pane: $("[data-pane]"),
  inspector: $("[data-inspector]"),
  statusA: $("[data-status-a]"),
  statusB: $("[data-status-b]"),
  statusC: $("[data-status-c]"),
  sheetHost: $("[data-sheet-host]"),
  menuHost: $("[data-menu-host]"),
  toasts: $("[data-toasts]"),
  live: $("[data-live]"),
  palette: $<HTMLDialogElement>("[data-palette]"),
  paletteInput: $<HTMLInputElement>("[data-palette-input]"),
  paletteList: $("[data-palette-list]"),
  paletteCount: $("[data-palette-count]"),
};

const state: AppState = {
  projects: new Map(),
  activeProjectId: null,
  runningProjectId: null,
  tab: "sync",
  busy: false,
  busyLabel: "",
  auth: null,
  authReason: "",
  browserReady: false,
  task: null,
};

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
let projectIdCounter = 0;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

/* ── Small utilities ────────────────────────────────────────────────────────── */

type Prop = string | number | boolean | undefined | ((e: Event) => void);
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, Prop> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An icon from the inline sprite in index.html. */
function icon(name: string, small = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", small ? "i s" : "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Shortens a home-relative path the way Finder does. */
function prettyPath(p: string): string {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/);
  return m ? `~${m[2] ?? ""}` : p;
}

function timeOf(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Today at 2:14 PM", "Yesterday at 6:40 PM", "8 Nov at 2:14 PM", or "Never". */
function when(value: string | number | null | undefined, never = "Never"): string {
  if (value === undefined || value === null || value === "") return never;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return never;
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Today at ${timeOf(d)}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${timeOf(d)}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${timeOf(d)}`;
}

/** Same as `when`, lower-cased for mid-sentence use. */
function whenLower(value: string | number | null | undefined, never = "never"): string {
  const s = when(value, never);
  return s === never ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function clockS(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function announce(text: string): void {
  ge.live.textContent = "";
  window.setTimeout(() => { ge.live.textContent = text; }, 30);
}

function toast(message: string, tone: "info" | "ok" | "bad" | "warn" = "info", action?: { label: string; run: () => void }, ms = 6000): void {
  const node = h("div", { class: "toast", "data-tone": tone, role: tone === "bad" ? "alert" : "status" },
    icon(tone === "ok" ? "check" : tone === "bad" || tone === "warn" ? "warn" : "info"),
    h("span", { class: "msg" }, message),
    action && h("button", { type: "button", onclick: () => { node.remove(); action.run(); } }, action.label),
    h("button", { type: "button", class: "x", "aria-label": "Dismiss notification", onclick: () => node.remove() }, icon("x", true)),
  );
  ge.toasts.appendChild(node);
  window.setTimeout(() => node.remove(), tone === "bad" ? Math.max(ms, 10000) : ms);
}

function getDesktopApi(): FigmakeDesktopApi {
  if (!window.figmakeSyncDesktop) throw new Error("Desktop bridge unavailable");
  return window.figmakeSyncDesktop;
}

const STATUS_CODE: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const STATUS_WORD: Record<FileStatus, string> = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" };
const STRATEGY_LABEL: Record<PullStrategy, string> = { backup: "Back up (safest)", merge: "Merge", abort: "Stop on conflict" };

function figmaName(project: ProjectState): string {
  const url = project.linkedProject?.config?.figmaMakeUrl || project.figmaMakeUrl;
  if (!url) return "Figma Make file";
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    const last = seg[seg.length - 1];
    if (last && seg.length > 2) return decodeURIComponent(last);
    return "Figma Make file";
  } catch { return "Figma Make file"; }
}

/** The Figma file as a noun phrase for mid-sentence use. */
function figmaRef(project: ProjectState): string {
  const name = figmaName(project);
  return name === "Figma Make file" ? "the Figma Make file" : name;
}

function pathCell(path: string, withIcon = false): HTMLElement {
  const dir = dirname(path);
  return h("span", { class: "path", title: path }, withIcon && icon("doc"), h("span", {}, dir && h("span", { class: "dir" }, dir), basename(path)));
}

function linesCell(plus: number, minus: number): HTMLElement {
  return h("span", { class: "lines" }, plus > 0 && h("b", { class: "p" }, `+${plus}`), plus > 0 && minus > 0 && " ", minus > 0 && h("b", { class: "m" }, `−${minus}`));
}

/* ── Confirm sheet ──────────────────────────────────────────────────────────── */

const dlg = {
  el: $<HTMLDialogElement>("[data-dialog]"),
  icon: $("[data-dialog-icon]"),
  title: $("[data-dialog-title]"),
  body: $("[data-dialog-body]"),
  detail: $("[data-dialog-detail]"),
  hint: $("[data-dialog-hint]"),
  ok: $<HTMLButtonElement>("[data-dialog-ok]"),
  cancel: $<HTMLButtonElement>("[data-dialog-cancel]"),
  checkRow: $("[data-dialog-confirm-row]"),
  check: $<HTMLInputElement>("[data-dialog-check]"),
  checkLabel: $("[data-dialog-check-label]"),
};

function confirmSheet(opts: {
  title: string;
  body: string;
  detail?: Child[];
  hint?: string;
  confirmLabel: string;
  icon: string;
  tone?: "accent" | "warn" | "bad";
  danger?: boolean;
  checkLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const returnTo = document.activeElement as HTMLElement | null;
    dlg.icon.className = `logo ${opts.tone ?? "accent"}`;
    dlg.icon.replaceChildren(icon(opts.icon));
    dlg.title.textContent = opts.title;
    dlg.body.textContent = opts.body;
    dlg.detail.replaceChildren(...(opts.detail ?? []).filter((c): c is Node | string => Boolean(c)));
    dlg.detail.hidden = !opts.detail || opts.detail.length === 0;
    dlg.hint.textContent = opts.hint ?? "";
    dlg.ok.textContent = opts.confirmLabel;
    dlg.ok.className = `btn ${opts.danger ? "danger-solid" : "primary"}`;
    dlg.check.checked = false;
    dlg.checkRow.toggleAttribute("hidden", !opts.checkLabel);
    dlg.checkLabel.textContent = opts.checkLabel ?? "";
    dlg.ok.disabled = Boolean(opts.checkLabel);
    dlg.check.onchange = () => { dlg.ok.disabled = !dlg.check.checked; };
    dlg.cancel.onclick = () => dlg.el.close("cancel");
    dlg.el.onclose = () => {
      resolve(dlg.el.returnValue === "ok");
      dlg.el.returnValue = "";
      returnTo?.focus?.();
    };
    dlg.el.showModal();
    (opts.danger || opts.checkLabel ? dlg.cancel : dlg.ok).focus();
  });
}

/* ── Busy lock ──────────────────────────────────────────────────────────────── */

function lockAll(root: ParentNode = document): void {
  const reason = state.busy ? `Unavailable while ${state.busyLabel || "another task"} is running` : "";
  root.querySelectorAll<HTMLButtonElement>("[data-lock]").forEach((btn) => {
    btn.disabled = state.busy;
    if (state.busy) btn.title = reason;
    else if (btn.dataset.title) btn.title = btn.dataset.title;
    else btn.removeAttribute("title");
  });
}

function setBusy(busy: boolean, label = ""): void {
  state.busy = busy;
  state.busyLabel = busy ? label : "";
  document.body.dataset.busy = String(busy);
  lockAll();
  renderToolbar();
  renderStatusBar();
}

/* ── Derived state ──────────────────────────────────────────────────────────── */

function generateProjectId(): string {
  return `project-${++projectIdCounter}`;
}

function getProjectName(project: ProjectState): string {
  if (project.rootDir) return basename(project.rootDir) || "Untitled";
  return "New project";
}

function newRun(): RunState {
  return {
    status: "idle", label: "", startedAt: 0, finishedAt: null, timeline: [], percent: null, message: "",
    summary: null, error: null, authError: false, cancelRequested: false, retry: null,
  };
}

function changeCount(project: ProjectState): number {
  const s = project.linkedProject?.statusSummary;
  return (s?.added || 0) + (s?.modified || 0) + (s?.deleted || 0) + (s?.renamed || 0);
}

function diffTotal(diff: ManifestDiff): number {
  return diff.added.length + diff.modified.length + diff.deleted.length + diff.renamed.length;
}

function activeProject(): ProjectState | null {
  return state.activeProjectId ? state.projects.get(state.activeProjectId) ?? null : null;
}

function isLinked(project: ProjectState | null): project is ProjectState {
  return Boolean(project?.linkedProject?.linked);
}

/** Whether Figma can be reached for a pull or push right now, as far as the app knows. */
function canReachFigma(): boolean {
  return navigator.onLine && state.auth !== false;
}

const TITLES: Record<string, string> = {
  Pull: "Pulling from Figma", Push: "Pushing to Figma", Status: "Comparing with the last pull", Verify: "Checking Figma",
  Sync: "Syncing from Figma", "Sign in": "Signing in to Figma", Link: "Linking the project", "Reset baseline": "Resetting the baseline",
};
const GERUND: Record<string, string> = {
  Pull: "Pulling", Push: "Pushing", Status: "Comparing", Verify: "Checking", Sync: "Syncing",
  "Sign in": "Signing in", Link: "Linking", "Reset baseline": "Resetting",
};

function taskSub(project: ProjectState, label: string): string {
  const folder = prettyPath(project.rootDir);
  const name = figmaName(project);
  if (label === "Pull" || label === "Sync") return `${name} → ${folder}`;
  if (label === "Push") return `${folder} → ${name}`;
  if (label === "Verify") return `${folder} ↔ ${name}`;
  if (label === "Status" || label === "Reset baseline") return `${folder} · compared with the last pull`;
  return folder;
}

function taskHint(label: string, dryRun: boolean): string {
  if (dryRun && label !== "Status" && label !== "Sign in" && label !== "Link") return "Dry run: nothing is written on either side.";
  if (label === "Pull" || label === "Sync") return "Figma is never written to during a pull.";
  if (label === "Push") return "Your local files are not changed by a push.";
  if (label === "Status" || label === "Reset baseline") return "Figma Make is not contacted for this.";
  if (label === "Verify") return "Nothing is written on either side.";
  if (label === "Sign in") return "Complete the sign-in using the Figma window that opened.";
  return "";
}

/* ── Sidebar ────────────────────────────────────────────────────────────────── */

function createProjectRow(projectId: string): HTMLElement {
  const btn = h("button", {
    type: "button", class: "prow", role: "option", "aria-selected": "false", tabindex: "-1",
    onclick: () => openProject(projectId),
    oncontextmenu: (e) => { e.preventDefault(); const me = e as MouseEvent; openProjectMenu(projectId, btn, { x: me.clientX, y: me.clientY }); },
  }, icon("folder"), h("span", { class: "nm" }), h("span", { class: "tail" }));
  return h("li", { role: "presentation", "data-project-id": projectId }, btn);
}

function renderProjectRow(project: ProjectState): void {
  const el = project.rowElement;
  if (!el) return;
  const btn = el.querySelector<HTMLButtonElement>(".prow")!;
  const name = btn.querySelector<HTMLElement>(".nm")!;
  const tail = btn.querySelector<HTMLElement>(".tail")!;
  const info = project.linkedProject;
  const m = info?.metadata;
  const changes = changeCount(project);
  const title = getProjectName(project);
  name.textContent = title;

  let stateText: string;
  let indicator: HTMLElement;
  if (project.run.status === "running") {
    stateText = `${GERUND[project.run.label] ?? project.run.label}…`;
    indicator = h("span", { class: "spin s", title: stateText });
  } else if (info?.linked && changes > 0) {
    stateText = `${plural(changes, "change")} since the last pull`;
    indicator = h("span", { class: "cnt", title: stateText }, String(changes));
  } else if (info?.linked && (m?.lastPullAt || m?.lastPushAt)) {
    stateText = "Matches the last pull";
    indicator = h("span", { class: "dot ok", title: stateText });
  } else if (info?.linked) {
    stateText = "Linked, not yet pulled";
    indicator = h("span", { class: "dot", title: stateText });
  } else {
    stateText = "Set-up needed";
    indicator = h("span", { class: "dot", title: stateText });
  }
  tail.replaceChildren(indicator);
  btn.setAttribute("aria-label", `${title}, ${stateText}`);
  const active = state.activeProjectId === project.id;
  btn.setAttribute("aria-selected", String(active));
  btn.tabIndex = active ? 0 : -1;
}

function renderSidebar(): void {
  const empty = state.projects.size === 0;
  ge.sideEmpty.hidden = !empty;
  state.projects.forEach((p) => renderProjectRow(p));
  if (!empty && !ge.projectList.querySelector("[tabindex='0']")) {
    const first = ge.projectList.querySelector<HTMLElement>(".prow");
    if (first) first.tabIndex = 0;
  }
}

function wireSidebarKeys(): void {
  ge.projectList.addEventListener("keydown", (e) => {
    const rows = Array.from(ge.projectList.querySelectorAll<HTMLButtonElement>(".prow"));
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (rows.length === 0) return;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    if (next >= 0) {
      e.preventDefault();
      rows.forEach((r, i) => { r.tabIndex = i === next ? 0 : -1; });
      rows[next]!.focus();
      rows[next]!.click();
    }
  });
}

/* ── Toolbar, status bar ────────────────────────────────────────────────────── */

function renderToolbar(): void {
  const project = activeProject();
  const linked = Boolean(project?.linkedProject?.linked);
  ge.tabs.hidden = !project;
  ge.tright.hidden = !project;
  if (!project) {
    ge.title.textContent = "figmake-sync";
    ge.subtitle.textContent = state.projects.size === 0 ? "No projects yet" : "";
    return;
  }
  ge.title.textContent = getProjectName(project);
  const n = changeCount(project);
  if (!linked) ge.subtitle.textContent = project.rootDir ? "Not linked to a Figma Make file yet" : "Choose a folder to begin";
  else if (!project.linkedProject?.metadata?.lastPullAt && !project.linkedProject?.metadata?.lastPushAt) ge.subtitle.textContent = `${figmaName(project)} · linked, not yet pulled`;
  else ge.subtitle.textContent = `${figmaName(project)} · ${n > 0 ? `${plural(n, "change")} since the last pull` : "matches the last pull"}`;

  ge.tabCount.textContent = String(n);
  ge.tabCount.toggleAttribute("hidden", n === 0);
  ge.pushLabel.textContent = n > 0 ? `Push ${n}` : "Push";
  const canSync = linked && canReachFigma() && !state.busy;
  ge.pull.disabled = !canSync;
  ge.push.disabled = !canSync;
  ge.pushMenu.disabled = !linked || state.busy;
  const why = !linked ? "Link a Figma Make file first" : !navigator.onLine ? "You're offline" : state.auth === false ? "Sign in to Figma first" : "";
  if (why) { ge.pull.title = why; ge.push.title = why; } else { ge.pull.title = "Download the Figma Make file into this folder"; ge.push.removeAttribute("title"); }
  ge.push.setAttribute("aria-label", n > 0 ? `Push ${plural(n, "change")} to Figma` : "Push to Figma");
}

function renderStatusBar(): void {
  const project = activeProject();
  const a = ge.statusA; const b = ge.statusB; const c = ge.statusC;
  b.replaceChildren(); c.textContent = "";
  if (!project) {
    a.textContent = state.task ? `${state.task.title}…` : "Ready";
    c.textContent = state.browserReady ? "Sync browser installed" : "";
    return;
  }
  const run = project.run;
  const info = project.linkedProject;
  const s = info?.statusSummary;
  if (!info?.linked) {
    a.textContent = project.rootDir ? "Choose a Figma Make link to finish set-up" : "Choose a folder to begin";
    return;
  }
  if (run.status === "running") {
    a.textContent = `${TITLES[run.label] ?? run.label}…${run.percent !== null ? ` ${Math.round(run.percent)}%` : ""}`;
  } else if (run.status === "error") {
    a.textContent = `${run.label} failed · local files unchanged`;
  } else if (run.status === "cancelled") {
    a.textContent = `${run.label} stopped`;
  } else if (!navigator.onLine) {
    a.textContent = "Offline · pull and push unavailable";
  } else if (state.auth === false) {
    a.textContent = "Not signed in · pull and push unavailable";
  } else if (s && changeCount(project) > 0) {
    const parts = [["modified", s.modified], ["added", s.added], ["deleted", s.deleted], ["renamed", s.renamed]] as const;
    a.textContent = `${plural(changeCount(project), "file")} changed · ${parts.filter(([, n]) => n > 0).map(([w, n]) => `${n} ${w}`).join(", ")}`;
  } else if (info?.metadata?.lastPullAt) {
    a.textContent = "Matches the last pull";
  } else {
    a.textContent = "Linked · not yet pulled";
  }
  const lp = info?.metadata?.lastPullAt;
  b.replaceChildren(icon("clock"), lp ? `Last pull ${whenLower(lp)}` : "Not pulled yet");
  c.textContent = project.options.dryRun ? "Dry run on" : "Backups: .figmake-sync/backups/";
}

/* ── Inspector ──────────────────────────────────────────────────────────────── */

function kv(pairs: Array<[string, Child, boolean?]>): HTMLElement {
  const dl = h("dl", { class: "kv" });
  for (const [k, v, wrap] of pairs) dl.append(h("dt", {}, k), h("dd", { class: wrap ? "wrap" : undefined, title: typeof v === "string" ? v : undefined }, v));
  return dl;
}

function inspectorProjectSections(project: ProjectState): HTMLElement[] {
  const m = project.linkedProject?.metadata;
  return [
    h("section", {},
      h("h3", {}, "Project"),
      kv([
        ["Folder", prettyPath(project.rootDir)],
        ["Figma file", figmaName(project)],
        ["Last pull", when(m?.lastPullAt)],
        ["Last push", when(m?.lastPushAt)],
        ["Last verify", when(m?.lastVerifyAt)],
        ["Strategy", STRATEGY_LABEL[project.options.strategy]],
      ])),
    h("section", {},
      h("h3", {}, "Safety"),
      h("p", { class: "hint" }, icon("shield"), h("span", {}, "Backups are written to ", h("span", { class: "mono" }, ".figmake-sync/backups/"), " before anything on disk is overwritten. Figma is never written to during a pull."))),
  ];
}

function inspectorFileSection(project: ProjectState, file: DiffFile): HTMLElement {
  const loaded = project.diffCache.get(file.path);
  const lines = loaded && !loaded.error ? linesCell(loaded.plus, loaded.minus) : h("span", { class: "muted" }, loaded?.error ? "Couldn't read" : "Loading…");
  const chipTone = file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : "chg";
  return h("section", {},
    h("h3", {}, "File"),
    h("div", { class: "big" }, file.path),
    kv([
      ["Status", h("span", { class: `chip ${chipTone}` }, STATUS_WORD[file.status])],
      ["On disk", file.status === "deleted" ? "Missing" : file.status === "added" ? "New" : "Edited"],
      ["Last pull", file.lastPull],
      ["Lines", lines],
      ...(file.from ? [["From", file.from, true] as [string, Child, boolean]] : []),
    ]),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", "data-action": "compare", onclick: () => { project.compareOpen = true; renderChanges(project); } }, icon("list"), "Compare line by line"),
      h("button", { type: "button", class: "btn", "data-action": "open-in", "aria-haspopup": "menu", onclick: (e) => openEditorMenu(e.currentTarget as HTMLElement, project) }, icon("ext"), "Open folder in…"),
      h("button", { type: "button", class: "btn", disabled: !loaded || Boolean(loaded.error) || file.status === "deleted", onclick: () => copyText(loaded?.content ?? "") }, icon("copy"), "Copy local file"),
      h("button", { type: "button", class: "btn", "data-lock": true, onclick: () => { void ignoreFile(project, file.path); } }, icon("eye-off"), "Ignore this path"),
    ));
}

function renderInspector(project: ProjectState | null): void {
  const show = Boolean(project) && isLinked(project) && state.tab === "changes" && !project.compareOpen && Boolean(project.lastDiff);
  ge.inspector.hidden = !show;
  ge.content.classList.toggle("with-insp", show);
  if (!show || !project) { ge.inspector.replaceChildren(); return; }
  const files = diffFiles(project.lastDiff!);
  const sel = files.find((f) => f.path === project.selectedFile);
  ge.inspector.replaceChildren(...(sel ? [inspectorFileSection(project, sel)] : []), ...inspectorProjectSections(project));
  lockAll(ge.inspector);
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast("File contents copied", "ok", undefined, 2500),
    () => toast("Couldn't copy to the clipboard", "bad"),
  );
}

/* ── Project view (built once per project) ──────────────────────────────────── */

function panel(name: TabName, cls = ""): HTMLElement {
  return h("div", {
    class: `tab-panel ${cls}`.trim(), id: `panel-${name}`, role: "tabpanel", "aria-labelledby": `tab-${name}`,
    "data-panel": name, tabindex: "-1", hidden: name !== "sync",
  });
}

function buildProjectView(project: ProjectState): { view: HTMLElement; refs: ProjectRefs } {
  const syncPanel = panel("sync");
  const changesPanel = panel("changes", "fill");
  const activity = h("div", { class: "log", "aria-label": "Activity log", role: "log" });
  const rawPre = h("pre", {});
  const raw = h("details", { hidden: true }, h("summary", {}, icon("chev-r", true), "Raw output"), rawPre);
  const shotImg = h("img", { alt: "Screenshot captured when the browser step failed" });
  const shotCaption = h("span", { class: "muted" });
  const shot = h("div", { class: "shot", hidden: true }, h("div", { class: "group", style: "padding-left:0" }, "Browser failure screenshot"), shotCaption, shotImg);
  const logsPanel = panel("logs");
  logsPanel.append(activity, shot);
  const setupPanel = panel("setup");
  const view = h("div", { class: "project-view", "data-project-id": project.id }, syncPanel, changesPanel, logsPanel, setupPanel);
  activity.append(raw);
  return { view, refs: { syncPanel, changesPanel, logsPanel, setupPanel, activity, raw, rawPre, shot, shotImg, shotCaption } };
}

/* ── Options ────────────────────────────────────────────────────────────────── */

function persistOptions(project: ProjectState): void {
  const o = project.options;
  store.set("figmake-settings", JSON.stringify({
    dryRun: o.dryRun, verbose: o.verbose, showBrowser: o.headless === false, prompt: o.prompt, strategy: o.strategy,
  }));
}

function loadSavedOptions(): Omit<DesktopProjectCommandOptions, "rootDir"> {
  const base: Omit<DesktopProjectCommandOptions, "rootDir"> = {
    dryRun: false, verbose: false, prompt: false, strategy: "backup", headless: true,
  };
  try {
    const saved = JSON.parse(store.get("figmake-settings") || "{}") as Record<string, unknown>;
    base.dryRun = Boolean(saved.dryRun);
    base.verbose = Boolean(saved.verbose);
    base.prompt = Boolean(saved.prompt);
    base.headless = !saved.showBrowser;
    if (saved.strategy === "backup" || saved.strategy === "merge" || saved.strategy === "abort") {
      base.strategy = saved.strategy;
    }
  } catch { /* ignore corrupt settings */ }
  return base;
}

type OptionKey = "dry-run" | "verbose" | "prompt" | "show-browser";

function optionValue(project: ProjectState, key: OptionKey): boolean {
  const o = project.options;
  return key === "dry-run" ? o.dryRun : key === "verbose" ? o.verbose : key === "prompt" ? o.prompt : o.headless === false;
}

function setOption(project: ProjectState, key: OptionKey, checked: boolean): void {
  if (key === "dry-run") project.options.dryRun = checked;
  if (key === "verbose") project.options.verbose = checked;
  if (key === "prompt") project.options.prompt = checked;
  if (key === "show-browser") project.options.headless = !checked;
  persistOptions(project);
  renderProject(project);
}

function switchRow(project: ProjectState, key: OptionKey, title: string, desc: string): HTMLElement {
  const on = optionValue(project, key);
  return h("div", { class: "row" },
    h("div", { class: "l" }, h("b", { id: `opt-${key}-${project.id}` }, title), h("span", {}, desc)),
    h("button", {
      type: "button", class: "sw", role: "switch", "aria-checked": String(on), "aria-labelledby": `opt-${key}-${project.id}`, "data-option": key,
      onclick: () => setOption(project, key, !on),
    }));
}

function strategyRow(project: ProjectState): HTMLElement {
  const select = h("select", {
    class: "select", "data-option": "strategy", "aria-label": "Pull strategy",
    onchange: (e) => {
      project.options.strategy = (e.target as HTMLSelectElement).value as PullStrategy;
      persistOptions(project);
      renderProject(project);
    },
  },
    h("option", { value: "backup" }, "Back up (safest)"),
    h("option", { value: "merge" }, "Merge"),
    h("option", { value: "abort" }, "Stop on conflict"),
  );
  select.value = project.options.strategy;
  return h("div", { class: "row" },
    h("div", { class: "l" }, h("b", {}, "Pull strategy"), h("span", {}, "What happens to local edits during a safe pull.")),
    h("span", { class: "select-wrap" }, select, icon("chev-ud", true)));
}

/* ── Sync tab ───────────────────────────────────────────────────────────────── */

function isValidFigmaUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && /(^|\.)figma\.com$/i.test(u.hostname);
  } catch { return false; }
}

function linkForm(project: ProjectState): HTMLFormElement {
  const input = h("input", {
    type: "url", class: "field", placeholder: "https://www.figma.com/make/…", "aria-label": "Figma Make URL",
    autocomplete: "off", spellcheck: "false", "data-figma-url": true,
  });
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "btn primary", "data-lock": true }, "Link project");
  const form = h("form", { novalidate: true }, h("div", { class: "frow-f" }, input, submit), error);
  input.addEventListener("input", () => { error.hidden = true; input.removeAttribute("aria-invalid"); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url || !isValidFigmaUrl(url)) {
      error.textContent = "Enter a figma.com link, for example https://www.figma.com/make/abc123.";
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    if (!project.rootDir) return;
    project.figmaMakeUrl = url;
    void runCommand(project, "Link", () => getDesktopApi().initProject(project.rootDir, url));
  });
  return form;
}

function artwork(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ill");
  svg.setAttribute("width", "200"); svg.setAttribute("height", "88"); svg.setAttribute("viewBox", "0 0 200 88");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
  const el = (tag: string, attrs: Record<string, string>) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  svg.append(
    el("path", { d: "M24 30.5A2.5 2.5 0 0 1 26.5 28h10.3c.9 0 1.7.4 2.3 1l3 3.2h17.4a2.5 2.5 0 0 1 2.5 2.5V56a2.5 2.5 0 0 1-2.5 2.5h-33A2.5 2.5 0 0 1 24 56z" }),
    el("path", { d: "M24 38.5h38", opacity: ".5" }),
    el("rect", { x: "138", y: "26", width: "38", height: "34", rx: "4" }),
    el("path", { d: "M147 36h20M147 43h20M147 50h12" }),
    el("path", { class: "acc2", d: "M74 44h52", "stroke-dasharray": "3 5" }),
    el("path", { class: "acc2", d: "M92 38l6 6-6 6" }),
    el("path", { class: "acc2", d: "M108 50l-6-6 6-6" }),
    el("circle", { class: "acc2 pulse", cx: "100", cy: "44", r: "2.5", fill: "currentColor", stroke: "none" }),
  );
  return svg;
}

function stepItem(stateCls: "done" | "cur" | "", n: number, title: string, desc: Child, ...controls: Child[]): HTMLElement {
  return h("li", { class: stateCls },
    h("span", { class: "mk", "aria-hidden": "true" }, stateCls === "done" ? icon("check-b") : String(n)),
    h("span", { class: "t" }, h("b", {}, title), h("span", {}, desc)),
    ...controls);
}

/** Project set-up card: choose a folder, then link the Figma Make file. */
function wizardCard(project: ProjectState): HTMLElement {
  const chosen = Boolean(project.rootDir);
  const chooseBtn = h("button", { type: "button", class: `btn${chosen ? "" : " primary"}`, "data-lock": true, onclick: () => { void chooseFolder(project); } }, chosen ? "Change folder" : "Choose folder");
  const steps = h("ol", { class: "steps", "aria-label": "Set-up steps" },
    stepItem(chosen ? "done" : "cur", 1, "Choose a folder", chosen ? h("span", { class: "mono" }, prettyPath(project.rootDir)) : "Where the Figma Make files will live on this computer. An empty folder works best.", chooseBtn),
    stepItem(chosen ? "cur" : "", 2, "Link the Figma Make file", chosen ? "Paste the link to the file. Nothing is downloaded until you pull." : "Paste its link once a folder is chosen."),
    stepItem("", 3, "Pull for the first time", "Writes the files here; anything already in the folder is backed up first."),
  );
  return h("div", { class: "onb" },
    h("div", { class: "card" },
      h("div", { class: "art" }, artwork()),
      h("div", { class: "body" },
        h("h2", {}, chosen ? `Set up ${getProjectName(project)}` : "Set up a new project"),
        h("p", { class: "lead" }, "Pick a folder, paste a Figma Make link, and keep the two in step. Nothing on disk is overwritten without a backup."),
        steps,
        chosen && linkForm(project),
        h("div", { class: "foot" },
          h("small", {}, "The project keeps its state in ", h("span", { class: "mono" }, ".figmake-sync/"), " next to your files."),
          h("button", { type: "button", class: "plain quiet", "data-lock": true, onclick: () => { void deleteProject(project.id); } }, "Remove")))));
}

function resultCard(project: ProjectState): HTMLElement | null {
  const run = project.run;
  const n = changeCount(project);
  const reviewBtn = () => h("button", { type: "button", class: "btn", "data-command": "status", "data-lock": true, onclick: () => { void handleCommand(project, "status"); } }, "Review changes");
  const activityBtn = () => h("button", { type: "button", class: "plain", onclick: () => switchTab("logs") }, "Open activity");

  if (run.status === "error") {
    const auth = run.authError;
    return h("div", { class: "card" },
      h("div", { class: "result" },
        h("div", { class: "ico bad" }, icon("x")),
        h("div", {},
          h("h2", {}, `${run.label} failed`),
          h("p", {}, auth
            ? "Figma rejected the saved session. Sign in again, then retry. Your local files were not changed."
            : `${firstSentence(run.error ?? "Something went wrong.")} Your local files were not changed.`),
          h("div", { class: "acts" },
            auth
              ? h("button", { type: "button", class: "btn primary", "data-lock": true, onclick: () => { void runFigmaAuth(); } }, icon("person"), "Sign in to Figma")
              : h("button", { type: "button", class: "btn primary", "data-lock": true, onclick: () => run.retry?.() }, icon("refresh"), "Try again"),
            auth && h("button", { type: "button", class: "btn", "data-lock": true, onclick: () => run.retry?.() }, icon("refresh"), "Try again"),
            activityBtn()))),
      run.error && (auth || run.error.trim() !== firstSentence(run.error)) && h("div", { class: "errbox" }, run.error));
  }
  if (run.status === "cancelled") {
    return h("div", { class: "card" },
      h("div", { class: "result" },
        h("div", { class: "ico neutral" }, icon("stop")),
        h("div", {},
          h("h2", {}, `${run.label} stopped`),
          h("p", {}, "You stopped it. Some files may already have changed, so review changes before syncing again."),
          h("div", { class: "acts" }, reviewBtn(), activityBtn()))));
  }
  if ((run.status === "ok" || run.status === "warn") && run.summary) {
    const s = run.summary;
    const retry = s.retryLabel && run.retry ? h("button", { type: "button", class: "btn primary", "data-lock": true, onclick: () => run.retry?.() }, icon("refresh"), s.retryLabel) : null;
    const acts: Child[] = [retry];
    if (run.label !== "Status" && (s.files.length > 0 || n > 0)) acts.push(h("button", { type: "button", class: retry ? "btn" : "btn primary", "data-command": "status", "data-lock": true, onclick: () => { void handleCommand(project, "status"); } }, "Review changes"));
    else if (run.label === "Status" && n > 0) acts.push(h("button", { type: "button", class: "btn primary", onclick: () => switchTab("changes") }, "Open changes"));
    acts.push(activityBtn());
    return h("div", { class: "card" },
      h("div", { class: "result" },
        h("div", { class: `ico ${s.tone === "warn" ? "warn" : "ok"}` }, icon(s.tone === "warn" ? "warn" : "check")),
        h("div", {}, h("h2", {}, s.headline), h("p", {}, s.body), h("div", { class: "acts" }, ...acts))),
      s.files.length > 0 && h("div", { class: "group", style: "padding-top:4px" }, s.filesLabel),
      s.files.length > 0 && h("ul", { class: "clist", "aria-label": s.filesLabel }, ...s.files.slice(0, 12).map((f) => h("li", {},
        h("span", { class: "path" }, f.code && h("span", { class: `chip ${f.code}`, style: "margin-right:8px" }, f.code), pathCell(f.path)),
        h("span", { class: "where" }, f.local && h("span", {}, icon("laptop"), f.local), f.remote && h("span", {}, icon("figma"), f.remote)))),
        s.files.length > 12 && h("li", {}, h("span", { class: "muted" }, `and ${s.files.length - 12} more under Changes`))),
      (s.backupDir || s.note) && h("div", { class: "row", style: "border-top:1px solid var(--sep)" },
        h("p", { class: "hint" }, icon(s.backupDir ? "shield" : "info"), h("span", {},
          ...(s.backupDir ? ["Backed up to ", h("span", { class: "mono" }, prettyPath(s.backupDir))] : [s.note])))));
  }
  return null;
}

function firstSentence(text: string): string {
  const line = text.split("\n")[0] ?? text;
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function statsCard(project: ProjectState): HTMLElement {
  const m = project.linkedProject?.metadata;
  const f = project.facts;
  const name = figmaName(project);
  const stat = (ic: string, label: string, at: string | undefined, sub: string) => h("div", { class: "stat" },
    h("div", { class: "lbl" }, icon(ic), label),
    h("div", { class: `val${at ? "" : " quiet"}` }, when(at)),
    h("div", { class: "sub", title: sub }, sub));
  const pullSub = f.pull
    ? f.pull.dryRun ? `Dry run · ${plural(f.pull.files, "file")} would be written` : `${plural(f.pull.files, "file")} from ${name}${f.pull.backedUp ? " · backed up first" : ""}`
    : m?.lastPullAt ? `From ${name}` : "Nothing read from Figma yet";
  const pushSub = f.push
    ? f.push.dryRun ? `Dry run · ${plural(f.push.files, "file")} would be uploaded` : `${plural(f.push.files, "file")} · remote check ${f.push.check === "ok" ? "ok" : f.push.check === "skipped" ? "skipped" : "not reported"}`
    : m?.lastPushAt ? `To ${name}` : "Nothing sent to Figma yet";
  const verifySub = f.verify
    ? f.verify.differences === 0 ? "Local files match Figma" : `${plural(f.verify.differences, "file")} differ from Figma`
    : m?.lastVerifyAt ? "Compared with Figma" : "Not checked against Figma";
  return h("div", { class: "card" }, h("div", { class: "stats" },
    stat("down", "Last pull", m?.lastPullAt, pullSub),
    stat("up", "Last push", m?.lastPushAt, pushSub),
    stat("check", "Last verify", m?.lastVerifyAt, verifySub)));
}

function optionsCard(project: ProjectState): HTMLElement {
  return h("div", { class: "card" },
    switchRow(project, "dry-run", "Dry run", "Nothing is written on either side."),
    strategyRow(project),
    switchRow(project, "prompt", "Confirm after uploads", "Pause in the Figma window before finishing a push."));
}

function recentCard(project: ProjectState): HTMLElement {
  const recent = project.log.slice(-4).reverse();
  return h("div", { class: "card" },
    h("div", { class: "hd" }, h("h2", {}, "Recent activity"), h("button", { type: "button", class: "plain", onclick: () => switchTab("logs") }, "Open activity", icon("chev-r", true))),
    ...(recent.length === 0
      ? [h("div", { class: "act empty" }, "No activity yet this session.")]
      : recent.map((e) => h("div", { class: "act", "data-kind": e.kind }, h("span", { class: "mono" }, clockS(e.at)), h("span", { class: "wrap" }, e.message)))));
}

function firstPullCard(project: ProjectState): HTMLElement {
  const canSync = canReachFigma();
  return h("div", { class: "card" },
    h("div", { class: "result" },
      h("div", { class: "ico accent" }, icon("down")),
      h("div", {},
        h("h2", {}, "Nothing on disk yet"),
        h("p", {}, `Pull ${figmaRef(project)} into ${prettyPath(project.rootDir)}. Anything already in the folder is backed up first.`),
        h("div", { class: "acts" },
          h("button", { type: "button", class: "btn primary", "data-command": "pull", "data-lock": true, disabled: !canSync, onclick: () => { void handleCommand(project, "pull"); } }, icon("down"), "Pull from Figma"),
          h("button", { type: "button", class: "btn", "data-command": "verify", "data-lock": true, disabled: !canSync, onclick: () => { void handleCommand(project, "verify"); } }, "Check Figma first")))));
}

function renderSync(project: ProjectState): void {
  const refs = project.refs!;
  if (!isLinked(project)) {
    refs.syncPanel.replaceChildren(wizardCard(project));
    lockAll(refs.syncPanel);
    return;
  }
  const m = project.linkedProject?.metadata;
  const result = resultCard(project);
  const firstPull = !result && !m?.lastPullAt && !m?.lastPushAt ? firstPullCard(project) : null;
  const quick = h("div", { class: "card" },
    h("div", { class: "row" },
      h("div", { class: "l" }, h("b", {}, "Compare with Figma"), h("span", {}, "Review changes compares the disk with the last pull. Check Figma now reads the live file; nothing is written.")),
      h("div", { class: "r" },
        h("button", { type: "button", class: "btn sm", "data-command": "status", "data-lock": true, onclick: () => { void handleCommand(project, "status"); } }, "Review changes"),
        h("button", { type: "button", class: "btn sm", "data-command": "verify", "data-lock": true, disabled: !canReachFigma(), onclick: () => { void handleCommand(project, "verify"); } }, "Check Figma now"))));
  refs.syncPanel.replaceChildren(h("div", { class: "sync" }, result, firstPull, statsCard(project), quick, optionsCard(project), recentCard(project)));
  lockAll(refs.syncPanel);
}

/* ── Changes tab ────────────────────────────────────────────────────────────── */

/** Rows for a baseline-relative diff: the right column only ever talks about the last pull. */
function diffFiles(diff: ManifestDiff): DiffFile[] {
  return [
    ...diff.modified.map(({ current }) => ({ path: current.path, status: "modified" as const, where: "Changed here", lastPull: "in last pull" })),
    ...diff.renamed.map((r) => ({ path: r.to, status: "renamed" as const, where: "Renamed here", lastPull: `${basename(r.from)} in last pull`, from: r.from })),
    ...diff.added.map((e) => ({ path: e.path, status: "added" as const, where: "Only on disk", lastPull: "not in last pull" })),
    ...diff.deleted.map((e) => ({ path: e.path, status: "deleted" as const, where: "Only in last pull", lastPull: "as pulled" })),
  ];
}

function fileRow(project: ProjectState, f: DiffFile, compact: boolean): HTMLElement {
  const selected = project.selectedFile === f.path;
  const loaded = project.diffCache.get(f.path);
  const lines = loaded && !loaded.error ? linesCell(loaded.plus, loaded.minus) : h("span", { class: "lines" });
  const btn = h("button", {
    type: "button", class: "frow", role: "option", "aria-selected": String(selected), tabindex: selected ? "0" : "-1", "data-path": f.path,
    onclick: () => { void selectFile(project, f); },
    ondblclick: () => { project.compareOpen = true; renderChanges(project); },
    oncontextmenu: (e) => { e.preventDefault(); const me = e as MouseEvent; project.selectedFile = f.path; renderChanges(project); void loadDiff(project, f); openFileMenu(project, f, { x: me.clientX, y: me.clientY }); },
  },
    h("span", { class: `chip ${STATUS_CODE[f.status]}`, title: STATUS_WORD[f.status] }, STATUS_CODE[f.status]),
    pathCell(f.path, !compact),
    !compact && h("span", { class: "whr" }, f.where),
    compact ? lines : h("span", { class: "rem" }, h("span", {}, f.lastPull), lines),
  );
  return btn;
}

function wireListKeys(list: HTMLElement, onEnter?: () => void): void {
  list.addEventListener("keydown", (e) => {
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>(".frow"));
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (rows.length === 0) return;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "Enter" && idx >= 0 && onEnter) { e.preventDefault(); onEnter(); return; }
    if (next >= 0) {
      e.preventDefault();
      rows.forEach((r, i) => { r.tabIndex = i === next ? 0 : -1; });
      rows[next]!.focus();
      rows[next]!.click();
    }
  });
}

function emptyState(ic: string, title: string, body: string, tone: "" | "ok" = "", ...acts: Child[]): HTMLElement {
  return h("div", { class: "empty" }, h("div", {},
    h("span", { class: `ico ${tone}`.trim() }, icon(ic)),
    h("h3", {}, title), h("p", {}, body),
    acts.length > 0 && h("div", { class: "acts" }, ...acts)));
}

function renderChanges(project: ProjectState): void {
  const refs = project.refs!;
  const diff = project.lastDiff;
  const focusPath = (document.activeElement as HTMLElement | null)?.dataset?.path;

  if (!isLinked(project)) {
    refs.changesPanel.replaceChildren(emptyState("list", "Link a Figma Make file first", "Changes are measured against the last pull, so there's nothing to compare yet."));
    renderInspector(project); return;
  }
  const reviewBtn = h("button", { type: "button", class: "btn primary", "data-command": "status", "data-lock": true, onclick: () => { void handleCommand(project, "status"); } }, "Review changes");
  if (!diff) {
    const lp = project.linkedProject?.metadata?.lastPullAt;
    refs.changesPanel.replaceChildren(emptyState("list", "Nothing compared yet",
      lp ? `Review changes to compare your local files with the last pull, ${whenLower(lp)}.` : "Pull from Figma first; the last pull is the baseline every change is measured against.",
      "", lp ? reviewBtn : h("button", { type: "button", class: "btn primary", "data-command": "pull", "data-lock": true, disabled: !canReachFigma(), onclick: () => { void handleCommand(project, "pull"); } }, "Pull from Figma")));
    lockAll(refs.changesPanel); renderInspector(project); return;
  }
  const files = diffFiles(diff);
  if (files.length === 0) {
    project.compareOpen = false;
    refs.changesPanel.replaceChildren(
      emptyState("check", "Up to date with the last pull", diff.unchanged.length > 0
        ? `${plural(diff.unchanged.length, "file")} on disk match the last pull, ${whenLower(project.linkedProject?.metadata?.lastPullAt)}.`
        : `Your local files match the last pull, ${whenLower(project.linkedProject?.metadata?.lastPullAt)}.`, "ok",
        h("button", { type: "button", class: "btn", "data-command": "status", "data-lock": true, onclick: () => { void handleCommand(project, "status"); } }, icon("refresh"), "Check again")),
      ignoreSection(project));
    lockAll(refs.changesPanel); renderInspector(project); return;
  }
  if (project.selectedFile && !files.some((f) => f.path === project.selectedFile)) project.selectedFile = null;

  if (project.compareOpen) {
    const sel = files.find((f) => f.path === project.selectedFile) ?? files[0]!;
    if (project.selectedFile !== sel.path) { project.selectedFile = sel.path; void loadDiff(project, sel); }
    const list = h("div", { class: "files", role: "listbox", "aria-label": "Changed files" }, ...files.map((f) => fileRow(project, f, true)));
    wireListKeys(list);
    refs.changesPanel.replaceChildren(h("div", { class: "diffwrap" }, list, diffPane(project, sel)));
  } else {
    const list = h("div", { class: "flist", role: "listbox", "aria-label": "Changed files" },
      h("div", { class: "fhead", "aria-hidden": "true" }, h("span", {}), h("span", {}, "File"), h("span", {}, "Where"), h("span", {}, "Last pull")),
      ...files.map((f) => fileRow(project, f, false)),
      unchangedDisclosure(diff));
    wireListKeys(list, () => { project.compareOpen = true; renderChanges(project); });
    refs.changesPanel.replaceChildren(
      h("div", { class: "changes-bar" },
        h("span", { class: "muted" }, `${plural(files.length, "file")} changed since the last pull`),
        h("span", { class: "sp" }),
        project.selectedFile && h("button", { type: "button", class: "plain", "data-action": "compare", onclick: () => { project.compareOpen = true; renderChanges(project); } }, icon("list", true), "Compare line by line"),
        h("button", { type: "button", class: "plain quiet", "data-command": "status", "data-lock": true, onclick: () => { void handleCommand(project, "status"); } }, icon("refresh", true), "Refresh"),
        h("button", { type: "button", class: "plain quiet", "data-lock": true, onclick: () => { void handleCommand(project, "rebaseline"); } }, "Reset baseline…")),
      list, ignoreSection(project));
    if (!list.querySelector("[tabindex='0']")) list.querySelector<HTMLElement>(".frow")?.setAttribute("tabindex", "0");
    void preloadDiffs(project, files);
  }
  lockAll(refs.changesPanel);
  if (focusPath) refs.changesPanel.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(focusPath)}"]`)?.focus();
  renderInspector(project);
}

function unchangedDisclosure(diff: ManifestDiff): HTMLElement {
  const n = diff.unchanged.length;
  const list = h("ul", { class: "ulist", hidden: true }, ...diff.unchanged.slice(0, 200).map((e) => h("li", { title: e.path }, e.path)), n > 200 && h("li", {}, `and ${n - 200} more`));
  const btn = h("button", {
    type: "button", class: "disc", "aria-expanded": "false",
    onclick: () => { const open = list.hidden; list.hidden = !open; btn.setAttribute("aria-expanded", String(open)); },
  }, icon("chev-r", true), h("span", {}, plural(n, "unchanged file")), h("span", { class: "mut" }, n === 1 ? "matches the last pull" : "match the last pull"));
  return h("div", {}, btn, list);
}

function ignoreSection(project: ProjectState): HTMLElement {
  const wrap = h("div", { class: "ignore" });
  void renderIgnored(project, wrap);
  return wrap;
}

async function renderIgnored(project: ProjectState, container: HTMLElement): Promise<void> {
  if (!project.rootDir || !project.linkedProject?.linked) return;
  const api = getDesktopApi();
  try {
    const patterns = await api.getCustomIgnorePatterns(project.rootDir);
    const input = h("input", { type: "text", class: "field", placeholder: "Add a pattern, e.g. dist/ or *.log", "aria-label": "Ignore pattern", spellcheck: "false" });
    const doAdd = async () => {
      const val = input.value.trim();
      if (!val || !project.rootDir) return;
      try {
        await api.addIgnorePattern(project.rootDir, val);
        input.value = "";
        await refreshAfterIgnoreChange(project);
      } catch (err) {
        toast(`Couldn't add that pattern: ${errMsg(err)}`, "bad");
      }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void doAdd(); } });
    container.replaceChildren(
      h("div", { class: "group", style: "padding-left:10px" }, patterns.length > 0 ? `Ignored · ${plural(patterns.length, "pattern")}` : "Ignored paths"),
      ...patterns.map((pattern) => h("div", { class: "irow" },
        h("span", { class: "mono", title: pattern }, pattern),
        h("button", { type: "button", class: "plain quiet", "data-lock": true, "aria-label": `Stop ignoring ${pattern}`, onclick: () => { void unignoreFile(project, pattern); } }, "Stop ignoring"))),
      ...(patterns.length === 0 ? [h("p", { class: "muted", style: "padding:0 10px 4px;font-size:12px" }, "Ignored paths are never compared or pushed.")] : []),
      h("div", { class: "add" }, input, h("button", { type: "button", class: "btn", "data-lock": true, onclick: () => { void doAdd(); } }, "Add")),
    );
    lockAll(container);
  } catch {
    // Config not available yet
  }
}

/* Line diff via LCS, with a size guard so very large files can't freeze the UI. */
function computeDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 4_000_000) {
    const out: DiffLine[] = [];
    oldLines.forEach((t, i) => out.push({ type: "del", text: t, oldNum: i + 1 }));
    newLines.forEach((t, i) => out.push({ type: "add", text: t, newNum: i + 1 }));
    return out;
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j]
        ? (dp[i + 1]?.[j + 1] ?? 0) + 1
        : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0, oldNum = 1, newNum = 1;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ type: "ctx", text: oldLines[i]!, oldNum: oldNum++, newNum: newNum++ });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i]?.[j + 1] ?? 0) >= (dp[i + 1]?.[j] ?? 0))) {
      result.push({ type: "add", text: newLines[j]!, newNum: newNum++ });
      j++;
    } else {
      result.push({ type: "del", text: oldLines[i]!, oldNum: oldNum++ });
      i++;
    }
  }
  return result;
}

/** Split rows: local (current) on the left, last pull on the right. Deletions and additions in one hunk pair up. */
function splitRows(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "ctx") { out.push({ left: line, right: line, change: null }); i++; continue; }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type !== "ctx") {
      (lines[i]!.type === "del" ? dels : adds).push(lines[i]!);
      i++;
    }
    const len = Math.max(dels.length, adds.length);
    for (let k = 0; k < len; k++) {
      const d = dels[k] ?? null;
      const a = adds[k] ?? null;
      out.push({ left: a, right: d, change: a && d ? "mod" : a ? "add" : "del" });
    }
  }
  return out;
}

const MAX_DIFF_LINES = 4000;
const CONTEXT_LINES = 3;

async function loadDiff(project: ProjectState, file: DiffFile, render = true): Promise<LoadedDiff> {
  const cached = project.diffCache.get(file.path);
  if (cached) return cached;
  const api = getDesktopApi();
  const sep = project.rootDir.includes("\\") ? "\\" : "/";
  const currentPath = `${project.rootDir}${sep}${file.path}`;
  const baselinePath = [project.rootDir, ".figmake-sync", "snapshots", "last-pull", file.from ?? file.path].join(sep);
  let loaded: LoadedDiff;
  try {
    if (typeof api.readFile !== "function") throw new Error("File preview isn't available in this build.");
    if (file.status === "added" || file.status === "deleted") {
      const content = await api.readFile(file.status === "added" ? currentPath : baselinePath);
      const lines = content.split("\n");
      const rows: SplitRow[] = lines.map((text, i) => file.status === "added"
        ? { left: { type: "add", text, newNum: i + 1 }, right: null, change: "add" as const }
        : { left: null, right: { type: "del", text, oldNum: i + 1 }, change: "del" as const });
      loaded = { rows, plus: file.status === "added" ? lines.length : 0, minus: file.status === "deleted" ? lines.length : 0, content: file.status === "added" ? content : "", note: `${plural(lines.length, "line")} ${file.status === "added" ? "only on disk" : "only in the last pull"}` };
    } else {
      let oldContent = "";
      let newContent = "";
      try { oldContent = await api.readFile(baselinePath); } catch { /* no baseline */ }
      try { newContent = await api.readFile(currentPath); } catch { /* file missing */ }
      const diffLines = computeDiff(oldContent.split("\n"), newContent.split("\n"));
      const plus = diffLines.filter((d) => d.type === "add").length;
      const minus = diffLines.filter((d) => d.type === "del").length;
      loaded = { rows: splitRows(diffLines), plus, minus, content: newContent };
    }
  } catch (error) {
    loaded = { rows: [], plus: 0, minus: 0, content: "", error: errMsg(error) };
  }
  project.diffCache.set(file.path, loaded);
  if (render && state.activeProjectId === project.id && state.tab === "changes") renderChanges(project);
  return loaded;
}

const PRELOAD_LIMIT = 40;
let preloading: ProjectState | null = null;

/** Loads line counts for small change sets so the list and inspector can show them without a click. */
async function preloadDiffs(project: ProjectState, files: DiffFile[]): Promise<void> {
  if (preloading === project || files.length > PRELOAD_LIMIT) return;
  const pending = files.filter((f) => !project.diffCache.has(f.path));
  if (pending.length === 0) return;
  preloading = project;
  try {
    for (const f of pending) await loadDiff(project, f, false);
  } finally {
    preloading = null;
  }
  if (state.activeProjectId === project.id && state.tab === "changes") renderChanges(project);
}

async function selectFile(project: ProjectState, file: DiffFile): Promise<void> {
  project.selectedFile = file.path;
  renderChanges(project);
  await loadDiff(project, file);
}

function diffPane(project: ProjectState, file: DiffFile): HTMLElement {
  const loaded = project.diffCache.get(file.path);
  const close = () => { project.compareOpen = false; renderChanges(project); };
  const head = h("div", { class: "diffhd" },
    h("span", { class: `chip ${STATUS_CODE[file.status]}`, title: STATUS_WORD[file.status] }, STATUS_CODE[file.status]),
    pathCell(file.path),
    loaded && !loaded.error && linesCell(loaded.plus, loaded.minus),
    loaded?.note && h("span", { class: "muted", style: "font-size:11.5px;white-space:nowrap" }, loaded.note),
    h("button", { type: "button", class: "btn sm", disabled: !loaded || Boolean(loaded.error) || file.status === "deleted", onclick: () => copyText(loaded?.content ?? "") }, icon("copy"), "Copy local file"),
    h("button", { type: "button", class: "btn sm", "data-action": "open-in", "aria-haspopup": "menu", onclick: (e) => openEditorMenu(e.currentTarget as HTMLElement, project) }, icon("ext"), "Open"),
    h("button", { type: "button", class: "btn sm icon", "aria-label": "Close comparison", title: "Close comparison", onclick: close }, icon("x")),
  );
  let body: HTMLElement;
  if (!loaded) body = h("p", { class: "diffnote", role: "status" }, "Loading file…");
  else if (loaded.error) body = h("p", { class: "diffnote", "data-bad": "true" }, `Couldn't load this file: ${loaded.error}`);
  else body = diffBody(project, loaded);
  return h("div", { class: "diffpane" }, head, body);
}

function diffBody(project: ProjectState, loaded: LoadedDiff): HTMLElement {
  const cols = h("div", { class: "diffcols", "aria-hidden": "true" },
    h("div", {}, icon("laptop", true), `Local · ${prettyPath(project.rootDir)}`),
    h("div", {}, icon("figma", true), `Last pull · ${whenLower(project.linkedProject?.metadata?.lastPullAt)}`));
  const rows = loaded.rows.slice(0, MAX_DIFF_LINES);
  const left = h("div", {});
  const right = h("div", {});
  const cell = (side: DiffLine | null, num: number | undefined, change: "add" | "del" | null) => {
    if (!side) { return [h("div", { class: "n emp" }), h("div", { class: "c emp" })]; }
    const cls = change ?? "";
    return [h("div", { class: `n ${cls}`.trim() }, num !== undefined ? String(num) : ""), h("div", { class: `c ${cls}`.trim() }, side.text)];
  };
  const chunks: HTMLElement[] = [];
  let dl: HTMLElement | null = null;
  let l: HTMLElement = left; let r: HTMLElement = right;
  const flush = () => { if (dl) { chunks.push(dl); dl = null; } };
  const changedIdx = rows.map((row, i) => (row.change ? i : -1)).filter((i) => i >= 0);
  const keep = new Set<number>();
  for (const i of changedIdx) for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(rows.length - 1, i + CONTEXT_LINES); k++) keep.add(k);
  let i = 0;
  while (i < rows.length) {
    if (!keep.has(i)) {
      let j = i;
      while (j < rows.length && !keep.has(j)) j++;
      flush();
      const a = rows[i]!.left?.newNum ?? rows[i]!.right?.oldNum ?? i + 1;
      const b = rows[j - 1]!.left?.newNum ?? rows[j - 1]!.right?.oldNum ?? j;
      chunks.push(h("div", { class: "hunk" }, j - i === 1 ? `Line ${a} unchanged` : `Lines ${a}–${b} unchanged`));
      i = j;
      continue;
    }
    if (!dl) { l = h("div", {}); r = h("div", {}); dl = h("div", { class: "dl" }, l, r); }
    const row = rows[i]!;
    l.append(...cell(row.left, row.left?.newNum, row.change === "add" || row.change === "mod" ? "add" : null));
    r.append(...cell(row.right, row.right?.oldNum, row.change === "del" || row.change === "mod" ? "del" : null));
    i++;
  }
  flush();
  return h("div", { class: "diffbody", "aria-label": "Line diff, local on the left, last pull on the right" }, cols,
    ...chunks,
    loaded.rows.length === 0 && h("p", { class: "diffnote" }, "Empty file."),
    loaded.rows.length > MAX_DIFF_LINES && h("p", { class: "diffnote" }, `Showing the first ${MAX_DIFF_LINES} of ${loaded.rows.length} lines.`));
}

async function refreshAfterIgnoreChange(project: ProjectState): Promise<void> {
  const opts: DesktopProjectCommandOptions = { rootDir: project.rootDir, ...project.options };
  const statusResult = await getDesktopApi().statusProject(opts);
  project.lastDiff = statusResult.diff ?? null;
  project.diffCache.clear();
  await refreshProject(project);
}

async function ignoreFile(project: ProjectState, filePath: string): Promise<void> {
  if (!project.rootDir) return;
  try {
    await getDesktopApi().addIgnorePattern(project.rootDir, filePath);
    if (project.selectedFile === filePath) project.selectedFile = null;
    await refreshAfterIgnoreChange(project);
    toast(`Ignoring ${basename(filePath)}`, "ok", undefined, 3000);
  } catch (error) {
    toast(`Couldn't ignore that file: ${errMsg(error)}`, "bad");
  }
}

async function unignoreFile(project: ProjectState, pattern: string): Promise<void> {
  if (!project.rootDir) return;
  try {
    await getDesktopApi().removeIgnorePattern(project.rootDir, pattern);
    await refreshAfterIgnoreChange(project);
  } catch (error) {
    toast(`Couldn't stop ignoring that pattern: ${errMsg(error)}`, "bad");
  }
}

async function rebaseline(project: ProjectState): Promise<void> {
  const ok = await confirmSheet({
    title: "Reset the change baseline?",
    body: "Future status checks will compare against the files on disk right now. Existing differences stop showing as changes.",
    hint: "Your files are not modified.",
    confirmLabel: "Reset baseline",
    icon: "refresh",
    tone: "warn",
  });
  if (!ok) return;
  await runCommand(project, "Reset baseline", async () => {
    const result = await getDesktopApi().rebaselineProject({ rootDir: project.rootDir, ...project.options });
    project.lastDiff = null;
    project.selectedFile = null;
    project.diffCache.clear();
    return result;
  });
}

/* ── Activity tab ───────────────────────────────────────────────────────────── */

function appendActivity(project: ProjectState, text: string, kind?: "bad"): void {
  project.log.push({ message: text, at: Date.now(), ...(kind ? { kind } : {}) });
  if (project.log.length > 500) project.log.shift();
  const refs = project.refs;
  if (!refs) return;
  refs.activity.querySelector("[data-empty]")?.remove();
  refs.activity.insertBefore(h("div", { class: "act", "data-kind": kind }, h("span", { class: "mono" }, clockS(Date.now())), h("span", { class: "wrap" }, text)), refs.raw);
  if (state.activeProjectId === project.id && state.tab === "sync") renderSync(project);
}

function renderActivityShell(project: ProjectState): void {
  const refs = project.refs!;
  if (!refs.activity.querySelector(".act") && !refs.activity.querySelector("[data-empty]")) {
    refs.activity.insertBefore(h("div", { class: "act empty", "data-empty": true }, "No activity yet. Run a sync to see its steps here."), refs.raw);
  }
  if (!refs.activity.querySelector(".group")) refs.activity.prepend(h("div", { class: "group" }, "This session"));
}

function showOutput(project: ProjectState, text: string): void {
  const refs = project.refs;
  if (!refs) return;
  refs.rawPre.textContent = text;
  refs.raw.hidden = false;
}

function checkForScreenshot(project: ProjectState, error: unknown): void {
  const refs = project.refs;
  if (!refs) return;
  const msg = errMsg(error);
  const match = msg.match(/screenshot[^\s]*\s+([^\s]+\.png)/i) || msg.match(/([^\s]+\.png)/i);
  if (match?.[1]) {
    refs.shot.hidden = false;
    refs.shotImg.src = `file://${match[1]}`;
    refs.shotCaption.textContent = new Date().toLocaleString();
  }
}

/* ── Settings tab ───────────────────────────────────────────────────────────── */

function renderSettings(project: ProjectState): void {
  const refs = project.refs!;
  const info = project.linkedProject;
  const m = info?.metadata;
  const card = (title: string, desc: string, ...children: Child[]) => h("div", { class: "card" },
    h("div", { class: "hd" }, h("div", {}, h("h2", {}, title), h("p", { class: "muted", style: "font-size:11.5px;margin-top:2px" }, desc))), ...children);
  refs.setupPanel.replaceChildren(h("div", { class: "settings" },
    card("Workspace", "The folder on disk and the Figma Make file it is linked to.",
      kv([
        ["Folder", h("span", { class: "mono" }, project.rootDir || "No folder chosen"), true],
        ["Figma file", h("span", { class: "mono" }, info?.config?.figmaMakeUrl || "Not linked yet"), true],
        ["Last pull", when(m?.lastPullAt)],
        ["Last push", when(m?.lastPushAt)],
        ["Last verify", when(m?.lastVerifyAt)],
      ]),
      h("div", { class: "row", style: "border-top:1px solid var(--sep)" },
        h("div", { class: "l" }, h("b", {}, "Open in an editor"), h("span", {}, "Opens the project folder in an installed editor.")),
        h("div", { class: "r" },
          h("button", { type: "button", class: "btn sm", "data-action": "open-in", "aria-haspopup": "menu", disabled: !project.rootDir, onclick: (e) => openEditorMenu(e.currentTarget as HTMLElement, project) }, icon("ext"), "Open in…"),
          h("button", { type: "button", class: "btn sm", "data-lock": true, onclick: () => { void chooseFolder(project); } }, "Change folder…")))),
    card("Figma account", "Sign in once and figmake-sync reuses the session for every project on this computer.",
      h("div", { class: "row" },
        h("div", { class: "l" }, h("b", {}, state.auth === true ? "Signed in to Figma" : state.auth === false ? "Not signed in" : "Session not checked yet"),
          h("span", {}, state.auth === false && state.authReason ? state.authReason : "Verify connection compares this folder with Figma Make without changing either.")),
        h("div", { class: "r" },
          h("button", { type: "button", class: "btn sm", "data-command": "auth", "data-lock": true, onclick: () => { void handleCommand(project, "auth"); } }, icon("person"), state.auth === true ? "Sign in again" : "Sign in to Figma"),
          h("button", { type: "button", class: "btn sm", "data-command": "verify", "data-lock": true, disabled: !isLinked(project) || !canReachFigma(), onclick: () => { void handleCommand(project, "verify"); } }, "Verify connection")))),
    card("Sync behaviour", "How pulls and pushes run. Saved for all projects on this computer.",
      switchRow(project, "dry-run", "Dry run", "Preview what would change without writing anything."),
      strategyRow(project),
      switchRow(project, "prompt", "Confirm after uploads", "Pause in the Figma window before a push is finalised."),
      switchRow(project, "verbose", "Verbose logs", "Record more detail in Activity."),
      switchRow(project, "show-browser", "Show the browser window", "Watch the automated browser. Useful when debugging.")),
    card("Remove", "Nothing in your project folder is deleted by either action.",
      h("div", { class: "row" },
        h("div", { class: "l" }, h("b", {}, "Delete project"), h("span", {}, "Removes it from figmake-sync and deletes its .figmake-sync state folder.")),
        h("button", { type: "button", class: "btn sm danger", "data-lock": true, onclick: () => { void deleteProject(project.id); } }, icon("trash"), "Delete project…")),
      h("div", { class: "row" },
        h("div", { class: "l" }, h("b", {}, "Clear app data"), h("span", {}, "Forgets every project and the saved Figma session on this computer.")),
        h("button", { type: "button", class: "btn sm", "data-action": "clear-app-data", "data-lock": true, onclick: () => { void clearAppData(); } }, "Clear app data…"))),
  ));
  lockAll(refs.setupPanel);
}

/* ── Rendering a project ────────────────────────────────────────────────────── */

async function chooseFolder(project: ProjectState): Promise<void> {
  try {
    const inspection = await getDesktopApi().selectProjectDirectory();
    if (inspection) {
      project.rootDir = inspection.rootDir;
      project.linkedProject = inspection;
      project.lastDiff = null;
      project.diffCache.clear();
      renderProject(project);
    }
  } catch (error) {
    toast(`Couldn't open the folder: ${errMsg(error)}`, "bad");
  }
}

function renderProject(project: ProjectState): void {
  if (!project.refs) return;
  renderProjectRow(project);
  if (state.activeProjectId !== project.id) return;
  renderSync(project);
  renderChanges(project);
  renderActivityShell(project);
  renderSettings(project);
  renderToolbar();
  renderStatusBar();
  renderBanners();
}

/* ── Progress sheet ─────────────────────────────────────────────────────────── */

let sheetReturnFocus: HTMLElement | null = null;

function renderSheet(): void {
  const task = state.task;
  if (!task) {
    if (ge.sheetHost.childElementCount > 0) {
      ge.sheetHost.replaceChildren();
      ge.app.inert = false;
      if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
      else ge.pane.focus({ preventScroll: true });
      sheetReturnFocus = null;
    }
    return;
  }
  const opening = ge.sheetHost.childElementCount === 0;
  if (opening) { sheetReturnFocus = document.activeElement as HTMLElement | null; ge.app.inert = true; }
  const focusedStop = Boolean(ge.sheetHost.querySelector("[data-stop]:focus"));

  const entries = task.timeline.slice(-6);
  const items = entries.map((e, i) => {
    const current = i === entries.length - 1;
    return h("li", { class: current ? "" : "done", "data-kind": e.kind },
      h("span", { class: "st" }, current ? h("span", { class: "spin" }) : h("span", { class: "ok" }, icon("check-b"))),
      h("span", {}, e.message),
      h("span", { class: "tm" }, current ? formatElapsed(Date.now() - task.startedAt) : clockS(e.at)));
  });
  if (entries.length === 0) items.push(h("li", {}, h("span", { class: "st" }, h("span", { class: "spin" })), h("span", {}, "Starting up…"), h("span", { class: "tm" }, formatElapsed(Date.now() - task.startedAt))));
  const pct = task.percent;
  const prog = h("div", {
    class: `prog${pct === null ? " indet" : ""}`, role: "progressbar", "aria-label": `${task.title} progress`,
    "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct === null ? undefined : String(Math.round(pct)), "aria-valuetext": pct === null ? "In progress" : `${Math.round(pct)} percent`,
  }, h("i", { style: pct === null ? undefined : `width:${Math.max(0, Math.min(100, pct))}%` }));
  const stop = task.onStop
    ? h("button", { type: "button", class: "btn", "data-stop": true, disabled: task.cancelRequested, onclick: () => task.onStop?.() }, icon("stop"), task.cancelRequested ? "Stopping…" : "Stop")
    : null;
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "run-h", "aria-describedby": "run-p" },
    h("div", { class: "hd" },
      h("div", { class: "logo" }, markIcon()),
      h("div", { class: "t" }, h("h2", { id: "run-h" }, task.title), h("p", { id: "run-p" }, task.sub)),
      pct !== null && h("span", { class: "pct" }, `${Math.round(pct)}%`)),
    prog,
    h("ol", { class: "tl", "aria-label": "Steps" }, ...items),
    h("div", { class: "ft" }, h("small", {}, task.hint), stop));
  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); stop?.focus(); }
    if (e.key === "Escape") e.preventDefault();
  });
  ge.sheetHost.replaceChildren(h("div", { class: "scrim" }), sheet);
  if (opening || focusedStop) (stop ?? sheet).focus();
  else if (!sheet.contains(document.activeElement)) (stop ?? sheet).focus();
}

function markIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("viewBox", "0 0 640 640"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#i-mark");
  svg.append(use);
  return svg;
}

function startElapsedTimer(): void {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    const tm = ge.sheetHost.querySelector<HTMLElement>(".tl li:last-child .tm");
    if (tm && state.task) tm.textContent = formatElapsed(Date.now() - state.task.startedAt);
  }, 1000);
}

function stopElapsedTimer(): void {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

/* ── Run lifecycle ──────────────────────────────────────────────────────────── */

function showProgress(project: ProjectState, event: DesktopProgressEvent): void {
  const run = project.run;
  if (run.status !== "running") return;
  if (event.percent != null) run.percent = event.percent;
  if (event.message) {
    run.message = event.message;
    const last = run.timeline[run.timeline.length - 1];
    if (!last || last.message !== event.message) {
      run.timeline.push({ message: event.message, at: Date.now() });
      if (run.timeline.length > 80) run.timeline.shift();
      appendActivity(project, event.message);
    }
  }
  if (state.task) state.task.percent = run.percent;
  renderSheet();
  renderStatusBar();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarize(project: ProjectState, label: string, result: unknown, dryRun: boolean): RunSummary {
  const r = asRecord(result);
  const summary = (v: unknown) => asRecord(v);
  const name = figmaName(project);
  const folder = prettyPath(project.rootDir);
  const base = { files: [] as RunFile[], filesLabel: "Files" };

  if ("extractedFiles" in r) {
    const conflicts = Array.isArray(r.conflicts) ? (r.conflicts as string[]) : [];
    const pulled = num(r.extractedFiles);
    const remote = num(summary(r.remoteSummary).total);
    const backupDir = typeof r.backupDir === "string" && r.backupDir.length > 0 ? r.backupDir : undefined;
    project.facts.pull = { files: pulled, backedUp: Boolean(backupDir), dryRun };
    if (conflicts.length > 0) {
      return {
        ...base, tone: "warn",
        headline: `${plural(conflicts.length, "file")} need your review`,
        body: `${dryRun ? "Would pull" : "Pulled"} ${plural(pulled, "file")} from ${name}. ${conflicts.length === 1 ? "This one was" : "These were"} edited here and in Figma since the last pull. Your versions stay on disk${backupDir ? " and were backed up first" : ""}; nothing is lost.`,
        files: conflicts.map((path) => ({ path, local: "edited here", remote: "edited in Figma" })),
        filesLabel: "Files changed in both places",
        ...(backupDir ? { backupDir } : {}),
      };
    }
    return {
      ...base, tone: "ok",
      headline: pulled === 0 ? "Already up to date" : dryRun ? `Would pull ${plural(pulled, "file")}` : `Pulled ${plural(pulled, "file")}`,
      body: pulled === 0
        ? `Nothing new to write. ${folder} already matches the last pull.`
        : `${dryRun ? "Would be written" : "Written"} to ${folder}.${backupDir ? " Your local edits were backed up first." : ""} ${remote === 0 ? `${name} had not changed since the previous pull.` : `${plural(remote, "file")} changed in ${name} since the previous pull.`}`,
      ...(backupDir ? { backupDir } : {}),
    };
  }

  if ("unresolved" in r && "summary" in r) {
    const s = summary(r.summary);
    const unresolved = Array.isArray(r.unresolved) ? (r.unresolved as Array<{ path: string; reason: string }>) : [];
    const diverged = Array.isArray(r.remoteDiverged) ? (r.remoteDiverged as string[]) : [];
    const total = num(s.total);
    const pushed = Math.max(0, total - unresolved.length);
    const check = r.remoteCheck === "ok" ? "ok" : r.remoteCheck === "skipped" ? "skipped" : "unknown";
    project.facts.push = { files: pushed, check, dryRun };
    const files: RunFile[] = [
      ...unresolved.map((u) => ({ path: u.path, code: "X", local: u.reason, remote: "not pushed" })),
      ...diverged.map((path) => ({ path, local: "pushed from here", remote: "also changed in Figma" })),
    ];
    const note = check === "skipped"
      ? "Figma couldn't be read before pushing, so changes made there since the last pull were not checked."
      : diverged.length > 0 ? `${plural(diverged.length, "file")} had also changed in Figma since the last pull; your version is now the one in Figma.` : undefined;
    if (unresolved.length > 0) {
      return {
        ...base, tone: "warn",
        headline: `${plural(unresolved.length, "file")} couldn't be pushed`,
        body: `${pushed > 0 ? `${plural(pushed, "file")} went through to ${name}. ` : ""}Fix the files below, then retry.`,
        files, filesLabel: "Files needing attention", retryLabel: "Retry push",
        ...(note ? { note } : {}),
      };
    }
    return {
      ...base, tone: "ok",
      headline: total === 0 ? "Nothing to push" : dryRun ? `Would push ${plural(total, "file")}` : `Pushed ${plural(total, "file")}`,
      body: total === 0 ? "No local changes since the last pull, so nothing was sent." : `${dryRun ? "Would be uploaded" : "Uploaded"} to ${name} in Figma Make.${check === "ok" && diverged.length === 0 ? " None of them had changed in Figma since the last pull." : ""}`,
      files, filesLabel: "Files also changed in Figma",
      ...(note ? { note } : {}),
    };
  }

  if ("drift" in r) {
    const drift = asRecord(r.drift);
    const s = summary(drift.summary);
    const total = num(s.total);
    const diff = drift.diff as ManifestDiff | undefined;
    project.facts.verify = { differences: total };
    // Verify is remote-vs-local: added = only on disk, deleted = only in Figma, modified = differs.
    const files: RunFile[] = diff ? [
      ...diff.added.map((e) => ({ path: e.path, code: "A", local: "only on disk", remote: "not in Figma" })),
      ...diff.deleted.map((e) => ({ path: e.path, code: "D", local: "not on disk", remote: "only in Figma" })),
      ...diff.modified.map((e) => ({ path: e.current.path, code: "M", local: "differs", remote: "differs" })),
      ...diff.renamed.map((e) => ({ path: e.to, code: "R", local: `renamed from ${basename(e.from)}`, remote: `${basename(e.from)} in Figma` })),
    ] : [];
    return {
      ...base,
      tone: total > 0 ? "warn" : "ok",
      headline: total > 0 ? `${plural(total, "file")} differ from Figma` : "Local files match Figma",
      body: total > 0 ? `Between ${folder} and ${name} right now. Nothing was changed on either side.` : `${folder} and ${name} are the same right now. Nothing was changed on either side.`,
      files, filesLabel: "Files that differ from Figma",
    };
  }

  if ("hasBaseline" in r) {
    const s = summary(r.summary);
    const total = num(s.total);
    return {
      ...base, tone: "ok",
      headline: total === 0 ? "No local changes" : `${plural(total, "local change")}`,
      body: r.hasBaseline === false
        ? "There's no baseline yet. Pull from Figma first to start tracking changes."
        : total === 0 ? "Nothing edited here since the last pull." : "Edited here since the last pull. Listed under Changes.",
    };
  }

  if ("filesSnapshotted" in r) {
    const n = num(r.filesSnapshotted);
    return {
      ...base, tone: "ok", headline: `Baseline reset · ${plural(n, "file")} tracked`,
      body: "Future status checks compare against the files on disk right now.",
    };
  }

  if ("configPath" in r) {
    return { ...base, tone: "ok", headline: "Project linked", body: `${name} is linked to ${folder}. Pull from Figma to bring the files onto disk.` };
  }

  return { ...base, tone: "ok", headline: `${label} complete`, body: "" };
}

async function stopRun(project: ProjectState): Promise<void> {
  if (project.run.status !== "running" || project.run.cancelRequested) return;
  project.run.cancelRequested = true;
  if (state.task) state.task.cancelRequested = true;
  renderSheet();
  announce("Stopping");
  try {
    const res = await getDesktopApi().cancelOperation();
    if (!res.cancelled) {
      project.run.cancelRequested = false;
      if (state.task) state.task.cancelRequested = false;
      renderSheet();
      toast("Nothing was running to stop.", "info");
    }
  } catch (error) {
    project.run.cancelRequested = false;
    if (state.task) state.task.cancelRequested = false;
    renderSheet();
    toast(`Couldn't stop the run: ${errMsg(error)}`, "bad");
  }
}

const AUTH_ERROR = /sign.?in|log.?in|logged out|unauthori[sz]ed|not authenticated|session (expired|invalid)|\b401\b|\b403\b/i;

async function runCommand<T>(project: ProjectState, label: string, operation: () => Promise<T>): Promise<T | undefined> {
  const run = project.run;
  Object.assign(run, newRun(), { status: "running", label, startedAt: Date.now(), message: "Starting up…" });
  run.retry = () => { void runCommand(project, label, operation); };
  state.runningProjectId = project.id;
  const dryRun = Boolean(project.options.dryRun);
  state.task = {
    title: TITLES[label] ?? `${label}…`, sub: taskSub(project, label), hint: taskHint(label, dryRun),
    startedAt: run.startedAt, timeline: run.timeline, percent: null, cancelRequested: false,
    onStop: () => { void stopRun(project); },
  };
  appendActivity(project, `Started: ${label}`);
  setBusy(true, label);
  startElapsedTimer();
  renderSheet();
  renderProject(project);
  announce(`${label} started`);

  try {
    const result = await operation();
    run.finishedAt = Date.now();
    run.summary = summarize(project, label, result, dryRun);
    run.status = run.summary.tone === "warn" ? "warn" : "ok";
    appendActivity(project, `${label} finished: ${run.summary.headline}`);
    announce(`${label} finished. ${run.summary.headline}`);
    if (result != null && JSON.stringify(result) !== "null") showOutput(project, JSON.stringify(result, null, 2));

    if (label === "Status" && result && typeof result === "object" && "diff" in result) {
      project.lastDiff = (result as unknown as StatusResult).diff ?? null;
      project.diffCache.clear();
      if (project.selectedFile && !diffFiles(project.lastDiff ?? { added: [], modified: [], deleted: [], renamed: [], unchanged: [] }).some((f) => f.path === project.selectedFile)) {
        project.selectedFile = null;
      }
    }
    if (label === "Pull" || label === "Sync" || label === "Push" || label === "Reset baseline") {
      // The baseline moved; a stale comparison would lie.
      if (label !== "Push") { project.lastDiff = null; project.selectedFile = null; project.compareOpen = false; }
      project.diffCache.clear();
    }
    state.runningProjectId = null;
    try { await refreshProject(project); } catch { /* inspection is best-effort */ }
    if (label === "Status") {
      if (changeCount(project) + (project.lastDiff ? diffTotal(project.lastDiff) : 0) > 0) switchTab("changes");
    } else if (label !== "Link") {
      toast(run.summary.headline, run.summary.tone === "warn" ? "warn" : "ok", state.tab === "sync" ? undefined : { label: "Show", run: () => switchTab("sync") });
    }
    return result;
  } catch (error) {
    const msg = errMsg(error);
    run.finishedAt = Date.now();
    if (run.cancelRequested) {
      run.status = "cancelled";
      appendActivity(project, `${label} stopped`);
      announce(`${label} stopped`);
      toast(`${label} stopped.`, "info");
    } else {
      run.status = "error";
      run.error = msg;
      run.authError = AUTH_ERROR.test(msg);
      appendActivity(project, `${label} failed: ${msg}`, "bad");
      showOutput(project, msg);
      checkForScreenshot(project, error);
      announce(`${label} failed`);
      toast(`${label} failed — ${firstSentence(msg)}`, "bad", run.authError ? { label: "Sign in", run: () => { void runFigmaAuth(); } } : { label: "Show", run: () => switchTab("sync") });
      if (run.authError) void updateAuthStatus();
    }
    state.runningProjectId = null;
    return undefined;
  } finally {
    state.runningProjectId = null;
    state.task = null;
    run.cancelRequested = false;
    stopElapsedTimer();
    renderSheet();
    setBusy(false);
    renderProject(project);
    if (project.run.status !== "idle" && state.activeProjectId === project.id && label !== "Status" && label !== "Sign in" && state.tab !== "sync" && state.tab !== "logs") switchTab("sync");
  }
}

async function handleCommand(project: ProjectState, command: string): Promise<void> {
  const api = getDesktopApi();
  const opts: DesktopProjectCommandOptions = { rootDir: project.rootDir, ...project.options };

  switch (command) {
    case "auth":            await runCommand(project, "Sign in", () => api.authProject(opts)).then(() => updateAuthStatus()); break;
    case "pull":            await runCommand(project, "Pull",    () => api.pullProject(opts)); break;
    case "sync-from-figma": await runCommand(project, "Sync",    () => api.syncFromFigma(opts)); break;
    case "status":          await runCommand(project, "Status",  () => api.statusProject(opts)); break;
    case "verify":          await runCommand(project, "Verify",  () => api.verifyProject(opts)); break;
    case "rebaseline":      await rebaseline(project); break;
    case "push": {
      if (!opts.dryRun) {
        const n = changeCount(project);
        const files = project.lastDiff ? diffFiles(project.lastDiff) : [];
        const ok = await confirmSheet({
          title: n > 0 ? `Push ${plural(n, "change")} to Figma?` : "Push to Figma?",
          body: n > 0
            ? `${plural(n, "local change")} since the last pull will be uploaded to ${figmaName(project)} in Figma Make.`
            : `Local files will be uploaded to ${figmaName(project)} in Figma Make.`,
          detail: [
            h("p", {}, "This updates the file in Figma for everyone who can open it. Your local files are not changed."),
            files.length > 0 && h("ul", { "aria-label": "Files to push" }, ...files.slice(0, 8).map((f) => h("li", {}, h("span", { class: `chip ${STATUS_CODE[f.status]}` }, STATUS_CODE[f.status]), pathCell(f.path))), files.length > 8 && h("li", { class: "muted" }, `and ${files.length - 8} more`)),
          ],
          hint: project.options.prompt ? "Confirm after uploads is on: you'll be asked again in the Figma window." : "Turn on Dry run to preview first.",
          confirmLabel: "Push to Figma",
          icon: "up",
        });
        if (!ok) return;
      }
      await runCommand(project, "Push", () => api.pushProject(opts));
      break;
    }
    case "install-browser": await installBrowser(); break;
  }
}

async function refreshProject(project: ProjectState): Promise<void> {
  if (!project.rootDir) return;
  const inspection = await getDesktopApi().inspectProject(project.rootDir);
  project.linkedProject = inspection;
  renderProject(project);
}

/* ── Navigation ─────────────────────────────────────────────────────────────── */

function addProject(): void {
  const id = generateProjectId();
  const project: ProjectState = {
    id, rootDir: "", figmaMakeUrl: "", linkedProject: null,
    options: loadSavedOptions(),
    rowElement: createProjectRow(id), viewElement: null, refs: null,
    lastDiff: null, selectedFile: null, compareOpen: false, diffCache: new Map(), facts: {}, log: [], run: newRun(),
  };
  const { view, refs } = buildProjectView(project);
  project.viewElement = view;
  project.refs = refs;
  state.projects.set(id, project);
  ge.projectList.appendChild(project.rowElement!);
  openProject(id);
}

async function deleteProject(id: string): Promise<void> {
  const project = state.projects.get(id);
  if (!project) return;
  try {
    // The main process asks for confirmation in a native dialog before removing anything.
    if (project.rootDir) await getDesktopApi().deleteProject(project.rootDir);
    project.rowElement?.remove();
    state.projects.delete(id);
    if (state.activeProjectId === id) {
      const next = Array.from(state.projects.keys())[0];
      if (next) openProject(next); else showOnboarding();
    }
    renderSidebar();
    await updateAuthStatus();
    toast("Project removed. Your project files were not touched.", "ok");
  } catch (error) {
    const msg = errMsg(error);
    if (!/cancelled/i.test(msg)) toast(`Couldn't delete the project: ${msg}`, "bad");
  }
}

function openProject(id: string): void {
  const project = state.projects.get(id);
  if (!project) return;
  const changed = state.activeProjectId !== id;
  state.activeProjectId = id;
  ge.pane.replaceChildren(project.viewElement!);
  renderSidebar();
  renderProject(project);
  switchTab(changed ? "sync" : state.tab);
  ge.pane.scrollTop = 0;
}

function showOnboarding(): void {
  state.activeProjectId = null;
  renderSidebar();
  renderOnboarding();
  renderToolbar();
  renderStatusBar();
  renderBanners();
  renderInspector(null);
}

function switchTab(tabName: TabName): void {
  state.tab = tabName;
  ge.tabs.querySelectorAll<HTMLElement>("[role=tab]").forEach((tab) => {
    const on = tab.dataset.tab === tabName;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  const project = activeProject();
  project?.viewElement?.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.panel !== tabName;
  });
  if (project) renderInspector(project);
}

function resetProjectsUi(): void {
  state.projects.clear();
  state.activeProjectId = null;
  ge.projectList.replaceChildren();
  showOnboarding();
}

/* ── Onboarding (no projects) ───────────────────────────────────────────────── */

function renderOnboarding(): void {
  if (state.activeProjectId) return;
  const browser = state.browserReady;
  const auth = state.auth === true;
  const cur: "browser" | "auth" | "project" = !browser ? "browser" : !auth ? "auth" : "project";
  const steps = h("ol", { class: "steps", "aria-label": "Setup steps" },
    stepItem(browser ? "done" : "cur", 1, "Install the sync browser", browser ? "Installed · a private browser that reads and writes Figma Make" : "A one-time download. figmake-sync drives a private browser to read and write Figma Make.",
      !browser && h("button", { type: "button", class: "btn primary", "data-action": "install-browser", "data-lock": true, onclick: () => { void installBrowser(); } }, "Install")),
    stepItem(auth ? "done" : cur === "auth" ? "cur" : "", 2, "Sign in to Figma", auth ? "Signed in · the session stays on this computer" : state.auth === false && state.authReason ? state.authReason : "Opens a Figma window; the session stays on this computer.",
      !auth && h("button", { type: "button", class: `btn${cur === "auth" ? " primary" : ""}`, "data-action": "figma-auth", "data-lock": true, onclick: () => { void runFigmaAuth(); } }, "Sign in")),
    stepItem(cur === "project" ? "cur" : "", 3, "Create your first project", "Choose a folder, then link a Figma Make file.",
      h("button", { type: "button", class: `btn${cur === "project" ? " primary" : ""}`, "data-action": "add-first-project", "data-lock": true, onclick: addProject }, "Create")),
  );
  ge.pane.replaceChildren(h("div", { class: "onb" },
    h("div", { class: "card" },
      h("div", { class: "art" }, artwork()),
      h("div", { class: "body" },
        h("h2", {}, "Welcome to figmake-sync"),
        h("p", { class: "lead" }, "Pick a folder, paste a Figma Make link, and keep the two in step. Nothing on disk is overwritten without a backup."),
        steps,
        h("div", { class: "foot" },
          h("small", {}, "Each project keeps its state in ", h("span", { class: "mono" }, ".figmake-sync/"), " next to your files."),
          h("button", { type: "button", class: "plain quiet", "data-action": "clear-app-data", "data-lock": true, onclick: () => { void clearAppData(); } }, "Clear app data…"))))));
  lockAll(ge.pane);
}

/* ── Banners ────────────────────────────────────────────────────────────────── */

function renderBanners(): void {
  const project = activeProject();
  ge.offlineBanner.hidden = navigator.onLine;
  const showAuth = state.auth === false && isLinked(project) && project.run.status !== "error";
  ge.authBanner.hidden = !showAuth;
  if (showAuth) ge.authBannerText.textContent = `${state.authReason ? `${state.authReason}. ` : ""}Pull and push need a Figma session. Sign in opens a Figma window; nothing else is downloaded.`;
  ge.onboardingBanner.toggleAttribute("hidden", state.browserReady || !project || onboardingDismissed);
  lockAll(ge.onboardingBanner);
}

let onboardingDismissed = false;

/* ── Menus ──────────────────────────────────────────────────────────────────── */

interface MenuItem { label?: string; icon?: string; run?: () => void; danger?: boolean; disabled?: boolean; heading?: string; sep?: boolean }
type Editor = "code" | "cursor" | "windsurf" | "claude" | "zed";
const EDITORS: Array<[Editor, string]> = [["code", "VS Code"], ["cursor", "Cursor"], ["windsurf", "Windsurf"], ["zed", "Zed"], ["claude", "Claude Desktop"]];

function closeMenu(): void {
  ge.menuHost.replaceChildren();
  document.querySelectorAll<HTMLElement>("[aria-haspopup='menu'][aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function openMenu(anchor: HTMLElement, items: MenuItem[], at?: { x: number; y: number }, align: "left" | "right" = "left"): void {
  closeMenu();
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.sep) { menu.append(h("div", { class: "sep", role: "separator" })); continue; }
    if (item.heading) { menu.append(h("div", { class: "mh" }, item.heading)); continue; }
    menu.append(h("button", {
      type: "button", role: "menuitem", class: item.danger ? "danger" : undefined, disabled: item.disabled,
      onclick: () => { closeMenu(); anchor.focus(); item.run?.(); },
    }, item.icon && icon(item.icon), item.label ?? ""));
  }
  ge.menuHost.replaceChildren(menu);
  if (anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-expanded", "true");
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth; const mh = menu.offsetHeight;
  let x = at ? at.x : align === "right" ? r.right - mw : r.left;
  let y = at ? at.y : r.bottom + 4;
  x = Math.max(8, Math.min(window.innerWidth - mw - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - mh - 8, y));
  menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  buttons[0]?.focus();
  menu.addEventListener("keydown", (e) => {
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); buttons[(idx + 1) % buttons.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(idx - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeMenu(); anchor.focus(); }
  });
}

function editorItems(project: ProjectState | null): MenuItem[] {
  return EDITORS.map(([id, label]) => ({ label, icon: "ext", disabled: !project?.rootDir, run: () => { void openInEditor(id, project) } }));
}

function openEditorMenu(anchor: HTMLElement, project: ProjectState | null): void {
  openMenu(anchor, [{ heading: "Open folder in" }, ...editorItems(project)]);
}

function openPushMenu(anchor: HTMLElement): void {
  const project = activeProject();
  if (!isLinked(project)) return;
  const reach = canReachFigma();
  openMenu(anchor, [
    { label: "Review changes", icon: "list", run: () => { void handleCommand(project, "status"); } },
    { label: "Check Figma now", icon: "check", disabled: !reach, run: () => { void handleCommand(project, "verify"); } },
    { label: "Sync from Figma", icon: "sync", disabled: !reach, run: () => { void handleCommand(project, "sync-from-figma"); } },
    { sep: true },
    { label: project.options.dryRun ? "Turn off dry run" : "Turn on dry run", icon: "shield", run: () => setOption(project, "dry-run", !project.options.dryRun) },
    { label: "Reset baseline…", icon: "refresh", run: () => { void handleCommand(project, "rebaseline"); } },
  ], undefined, "right");
}

function openProjectMenu(projectId: string, anchor: HTMLElement, at: { x: number; y: number }): void {
  const project = state.projects.get(projectId);
  if (!project) return;
  const linked = isLinked(project);
  const reach = canReachFigma() && !state.busy;
  openMenu(anchor, [
    { label: "Pull from Figma", icon: "down", disabled: !linked || !reach, run: () => { openProject(projectId); void handleCommand(project, "pull"); } },
    { label: "Push to Figma", icon: "up", disabled: !linked || !reach, run: () => { openProject(projectId); void handleCommand(project, "push"); } },
    { label: "Review changes", icon: "list", disabled: !linked || state.busy, run: () => { openProject(projectId); void handleCommand(project, "status"); } },
    { sep: true },
    { heading: "Open folder in" },
    ...editorItems(project),
    { sep: true },
    { label: "Settings", icon: "gear", run: () => { openProject(projectId); switchTab("setup"); } },
    { label: "Delete project…", icon: "trash", danger: true, disabled: state.busy, run: () => { void deleteProject(projectId); } },
  ], at);
}

function openFileMenu(project: ProjectState, file: DiffFile, at: { x: number; y: number }): void {
  const loaded = project.diffCache.get(file.path);
  const anchor = project.refs?.changesPanel.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(file.path)}"]`) ?? ge.pane;
  openMenu(anchor, [
    { label: "Compare line by line", icon: "list", run: () => { project.compareOpen = true; renderChanges(project); } },
    { label: "Copy local file", icon: "copy", disabled: !loaded || Boolean(loaded.error) || file.status === "deleted", run: () => copyText(loaded?.content ?? "") },
    { label: "Copy path", icon: "copy", run: () => { void navigator.clipboard.writeText(file.path).then(() => toast("Path copied", "ok", undefined, 2000), () => toast("Couldn't copy to the clipboard", "bad")); } },
    { sep: true },
    { label: "Ignore this path", icon: "eye-off", disabled: state.busy, run: () => { void ignoreFile(project, file.path); } },
  ], at);
}

async function openInEditor(editor: Editor, project: ProjectState | null): Promise<void> {
  if (!project?.rootDir) {
    toast("Choose a folder for this project first.", "bad");
    return;
  }
  const names = Object.fromEntries(EDITORS) as Record<Editor, string>;
  try {
    const result = await getDesktopApi().openInEditor(editor, project.rootDir);
    if (!result.success) {
      toast(`Couldn't open ${names[editor]}. Make sure it's installed and its '${editor}' command is on your PATH. ${result.error ?? ""}`.trim(), "bad");
    }
  } catch (error) {
    toast(`Couldn't open ${names[editor]}: ${errMsg(error)}`, "bad");
  }
}

/* ── Command palette ────────────────────────────────────────────────────────── */

interface PaletteItem { group: string; label: string; hint?: string; icon: string; keys?: string[]; run: () => void; disabled?: boolean }

let paletteItems: PaletteItem[] = [];
let paletteIndex = 0;
let paletteReturnFocus: HTMLElement | null = null;

function paletteCommands(query: string): PaletteItem[] {
  const project = activeProject();
  const linked = isLinked(project);
  const reach = canReachFigma() && !state.busy;
  const mod = IS_MAC ? "⌘" : "Ctrl";
  const items: PaletteItem[] = [];
  if (linked) {
    const n = changeCount(project);
    items.push(
      { group: "Sync", label: "Pull from Figma", hint: getProjectName(project), icon: "down", keys: [mod, "⇧", "L"], disabled: !reach, run: () => { void handleCommand(project, "pull"); } },
      { group: "Sync", label: n > 0 ? `Push ${plural(n, "change")} to Figma` : "Push to Figma", icon: "up", keys: [mod, "⇧", "P"], disabled: !reach, run: () => { void handleCommand(project, "push"); } },
      { group: "Sync", label: "Sync from Figma", hint: "safe pull with backups", icon: "sync", disabled: !reach, run: () => { void handleCommand(project, "sync-from-figma"); } },
      { group: "Sync", label: "Check Figma now", hint: "compare without changing either side", icon: "check", disabled: !reach, run: () => { void handleCommand(project, "verify"); } },
      { group: "Sync", label: "Review changes", hint: "compare the disk with the last pull", icon: "list", disabled: state.busy, run: () => { void handleCommand(project, "status"); } },
    );
    for (const [id, label] of EDITORS) items.push({ group: "Open folder in", label, icon: "ext", run: () => { void openInEditor(id, project); } });
    items.push(
      { group: "Project", label: "Sync", hint: "tab", icon: "chev-r", run: () => switchTab("sync") },
      { group: "Project", label: "Changes", hint: "tab", icon: "chev-r", run: () => switchTab("changes") },
      { group: "Project", label: "Activity", hint: "tab", icon: "chev-r", run: () => switchTab("logs") },
      { group: "Project", label: "Settings", hint: "tab", icon: "gear", run: () => switchTab("setup") },
      { group: "Project", label: "Reset baseline…", icon: "refresh", disabled: state.busy, run: () => { void handleCommand(project, "rebaseline"); } },
      { group: "Project", label: "Delete project…", icon: "trash", disabled: state.busy, run: () => { void deleteProject(project.id); } },
    );
  }
  for (const p of state.projects.values()) {
    if (p.id !== state.activeProjectId) items.push({ group: "Projects", label: `Switch to ${getProjectName(p)}`, icon: "folder", run: () => openProject(p.id) });
  }
  items.push({ group: "Projects", label: "New project", icon: "plus", disabled: state.busy, run: addProject });
  items.push({ group: "Figma", label: state.auth === true ? "Sign in to Figma again" : "Sign in to Figma", icon: "person", disabled: state.busy, run: () => { void runFigmaAuth(); } });

  if (linked && project.lastDiff) {
    const files = diffFiles(project.lastDiff);
    const q = query.toLowerCase();
    const matched = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files.slice(0, 5);
    for (const f of matched.slice(0, 12)) {
      items.push({ group: "Changed files", label: f.path, hint: STATUS_WORD[f.status], icon: "doc", run: () => { switchTab("changes"); project.compareOpen = true; void selectFile(project, f); } });
    }
  }
  return items;
}

function filterPalette(query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const all = paletteCommands(q);
  if (!q) return all;
  const words = q.split(/\s+/);
  return all.filter((it) => { const hay = `${it.group} ${it.label} ${it.hint ?? ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

function renderPalette(): void {
  const items = paletteItems;
  paletteIndex = Math.max(0, Math.min(items.length - 1, paletteIndex));
  const nodes: HTMLElement[] = [];
  let lastGroup = "";
  items.forEach((it, i) => {
    if (it.group !== lastGroup) { nodes.push(h("div", { class: "gh", role: "presentation" }, it.group)); lastGroup = it.group; }
    const node = h("div", {
      class: "it", role: "option", id: `pal-${i}`, "aria-selected": String(i === paletteIndex), "aria-disabled": it.disabled ? "true" : undefined,
      onmousemove: () => { if (paletteIndex !== i) { paletteIndex = i; renderPalette(); } },
      onclick: () => runPalette(i),
    },
      icon(it.icon),
      h("span", { class: "lbl" }, it.label, it.hint && h("span", {}, ` · ${it.hint}`)),
      it.keys && h("span", { class: "keys", "aria-hidden": "true" }, ...it.keys.map((k) => h("span", { class: "kbd" }, k))));
    nodes.push(node);
  });
  if (items.length === 0) nodes.push(h("div", { class: "none" }, "No matching commands or files."));
  ge.paletteList.replaceChildren(...nodes);
  ge.paletteInput.setAttribute("aria-activedescendant", items.length ? `pal-${paletteIndex}` : "");
  ge.paletteCount.textContent = `${plural(items.length, "result")}`;
  ge.paletteList.querySelector<HTMLElement>(`#pal-${paletteIndex}`)?.scrollIntoView({ block: "nearest" });
}

function runPalette(i: number): void {
  const it = paletteItems[i];
  if (!it || it.disabled) return;
  ge.palette.close();
  it.run();
}

function openPalette(): void {
  if (ge.palette.open || state.task || dlg.el.open) return;
  paletteReturnFocus = document.activeElement as HTMLElement | null;
  ge.paletteInput.value = "";
  paletteIndex = 0;
  paletteItems = filterPalette("");
  renderPalette();
  ge.palette.showModal();
  ge.paletteInput.focus();
}

function wirePalette(): void {
  ge.paletteInput.addEventListener("input", () => { paletteIndex = 0; paletteItems = filterPalette(ge.paletteInput.value); renderPalette(); });
  ge.palette.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteIndex = (paletteIndex + 1) % Math.max(1, paletteItems.length); renderPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteIndex = (paletteIndex - 1 + paletteItems.length) % Math.max(1, paletteItems.length); renderPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteIndex); }
  });
  ge.palette.addEventListener("click", (e) => { if (e.target === ge.palette) ge.palette.close(); });
  ge.palette.addEventListener("close", () => { paletteReturnFocus?.focus?.(); paletteReturnFocus = null; });
}

/* ── Onboarding tasks ───────────────────────────────────────────────────────── */

function checkBrowserInstalled(): void {
  state.browserReady = store.get("browserInstalled") === "1";
}

async function checkRuntimeDeps(): Promise<void> {
  try {
    const deps = await getDesktopApi().checkRuntimeDeps();
    const missing: string[] = [];
    if (!deps.node) missing.push("Node.js: install from nodejs.org, or with nvm (nvm install --lts).");
    if (!deps.npm) missing.push("npm: it ships with Node.js. Reinstall Node to get it.");
    if (!deps.pnpm) missing.push("pnpm: run npm install -g pnpm.");
    if (missing.length === 0) { ge.depsBanner.hidden = true; return; }
    ge.depsStatus.replaceChildren(...missing.map((m) => h("span", { class: "deps-line" }, m)));
    ge.depsBanner.hidden = false;
  } catch { /* best-effort */ }
}

/** Runs a standalone task (no project) in the progress sheet. */
async function runStandalone<T>(task: Omit<LiveTask, "startedAt" | "timeline" | "percent" | "cancelRequested">, label: string, op: () => Promise<T>): Promise<T> {
  state.task = { ...task, startedAt: Date.now(), timeline: [], percent: null, cancelRequested: false };
  setBusy(true, label);
  startElapsedTimer();
  renderSheet();
  try {
    return await op();
  } finally {
    state.task = null;
    stopElapsedTimer();
    renderSheet();
    setBusy(false);
  }
}

async function installBrowser(): Promise<void> {
  try {
    ge.onboardingStatus.textContent = "Downloading the browser. This can take a minute.";
    const result = await runStandalone({ title: "Installing the sync browser", sub: "A private browser that reads and writes Figma Make", hint: "One-time download. Nothing else on this computer is changed.", onStop: null }, "Installing browser", () => getDesktopApi().installBrowser());
    store.set("browserInstalled", "1");
    state.browserReady = true;
    toast(result.status === "already-installed" ? "The sync browser is already installed." : "Sync browser installed.", "ok");
  } catch (error) {
    ge.onboardingStatus.textContent = `Install failed: ${errMsg(error)}. Check your connection and try again.`;
    toast(`Browser install failed — ${firstSentence(errMsg(error))}`, "bad");
  } finally {
    renderBanners();
    renderOnboarding();
    renderStatusBar();
  }
}

async function clearAppData(): Promise<void> {
  try {
    setBusy(true, "Clearing data");
    await getDesktopApi().clearAppData();
    store.remove("figmake-settings");
    resetProjectsUi();
    await updateAuthStatus();
    toast("App data cleared. Your project folders were not touched.", "ok");
  } catch (error) {
    const msg = errMsg(error);
    if (!/cancelled/i.test(msg)) toast(`Couldn't clear app data: ${msg}`, "bad");
  } finally {
    setBusy(false);
  }
}

/* ── Figma auth ─────────────────────────────────────────────────────────────── */

async function updateAuthStatus(): Promise<void> {
  const api = getDesktopApi();
  const set = (indicator: string, label: string, title = "") => {
    ge.authChip.dataset.authIndicator = indicator;
    ge.authLabel.textContent = label;
    ge.authChip.title = title || (indicator === "authenticated" ? "Sign in to Figma again" : "Sign in to Figma");
  };
  try {
    if (typeof api.checkAuthStatus !== "function") {
      state.auth = null;
      set("unknown", "Session not checked");
    } else {
      const res = await api.checkAuthStatus() as { authenticated: boolean | null; reason?: string };
      state.authReason = res.reason ?? "";
      if (res.authenticated === true) { state.auth = true; set("authenticated", "Signed in"); }
      else if (res.authenticated === false) { state.auth = false; set("unauthenticated", "Not signed in", state.authReason); }
      else { state.auth = null; set("unknown", "Session not checked", state.authReason); }
    }
  } catch {
    state.auth = null;
    set("unknown", "Session not checked");
  }
  const project = activeProject();
  if (project) renderProject(project); else { renderOnboarding(); renderToolbar(); renderStatusBar(); renderBanners(); }
}

async function runFigmaAuth(): Promise<void> {
  const api = getDesktopApi();
  let target: ProjectState | undefined;
  for (const p of state.projects.values()) {
    if (p.linkedProject?.linked && p.rootDir) { target = p; break; }
  }
  try {
    await runStandalone({
      title: "Signing in to Figma", sub: "Complete the sign-in using the Figma window that opened", hint: "The session is kept by the sync browser on this computer.",
      onStop: () => { if (state.task) { state.task.cancelRequested = true; renderSheet(); } void api.cancelOperation().catch(() => undefined); },
    }, "Signing in", () => target ? api.authProject({ rootDir: target.rootDir, ...target.options }) : api.authStandalone());
    toast("Signed in to Figma.", "ok", undefined, 3500);
  } catch (error) {
    const msg = errMsg(error);
    if (/cancel/i.test(msg)) toast("Sign-in stopped.", "info");
    else toast(`Sign-in didn't complete — ${firstSentence(msg)}`, "bad");
  } finally {
    await updateAuthStatus();
  }
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */

function wireTabs(): void {
  const tabs = Array.from(ge.tabs.querySelectorAll<HTMLElement>("[role=tab]"));
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab as TabName));
    tab.addEventListener("keydown", (e) => {
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        const t = tabs[next]!;
        switchTab(t.dataset.tab as TabName);
        t.focus();
      }
    });
  });
}

function wireGlobalKeys(): void {
  document.addEventListener("keydown", (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (state.task || dlg.el.open) return;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); if (ge.palette.open) ge.palette.close(); else openPalette(); return; }
    if (ge.palette.open) return;
    const project = activeProject();
    if (mod && e.shiftKey && e.key.toLowerCase() === "l" && isLinked(project) && canReachFigma()) { e.preventDefault(); void handleCommand(project, "pull"); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "p" && isLinked(project) && canReachFigma()) { e.preventDefault(); void handleCommand(project, "push"); }
    else if (mod && /^[1-4]$/.test(e.key) && project) { e.preventDefault(); switchTab((["sync", "changes", "logs", "setup"] as TabName[])[Number(e.key) - 1]!); }
    else if (e.key === "Escape" && ge.menuHost.childElementCount > 0) closeMenu();
  });
  document.addEventListener("pointerdown", (e) => {
    if (ge.menuHost.childElementCount > 0 && !(e.target as HTMLElement).closest(".menu")) closeMenu();
  });
}

async function boot(): Promise<void> {
  if (IS_MAC) document.documentElement.classList.add("is-mac");
  ge.kbdMod.textContent = IS_MAC ? "⌘K" : "Ctrl K";
  const api = getDesktopApi();

  ge.addProject.addEventListener("click", addProject);
  ge.authChip.addEventListener("click", () => { void runFigmaAuth(); });
  ge.authBanner.querySelector("[data-action='figma-auth']")?.addEventListener("click", () => { void runFigmaAuth(); });
  document.querySelector("[data-action='install-browser']")?.addEventListener("click", () => { void installBrowser(); });
  document.querySelector("[data-action='dismiss-onboarding']")?.addEventListener("click", () => { onboardingDismissed = true; ge.onboardingBanner.hidden = true; });
  document.querySelector("[data-action='dismiss-deps']")?.addEventListener("click", () => { ge.depsBanner.hidden = true; });
  document.querySelector("[data-action='open-palette']")?.addEventListener("click", openPalette);
  ge.pull.addEventListener("click", () => { const p = activeProject(); if (isLinked(p)) void handleCommand(p, "pull"); });
  ge.push.addEventListener("click", () => { const p = activeProject(); if (isLinked(p)) void handleCommand(p, "push"); });
  ge.pushMenu.addEventListener("click", () => { if (ge.menuHost.childElementCount > 0) closeMenu(); else openPushMenu(ge.pushMenu); });
  wireTabs();
  wireSidebarKeys();
  wirePalette();
  wireGlobalKeys();

  const rerender = () => { const p = activeProject(); if (p) renderProject(p); else { renderToolbar(); renderStatusBar(); renderBanners(); } };
  window.addEventListener("online", rerender);
  window.addEventListener("offline", rerender);

  api.onProgress?.((event: DesktopProgressEvent) => {
    const running = state.runningProjectId ? state.projects.get(state.runningProjectId) : undefined;
    if (event.scope !== "browser-install" && running) {
      showProgress(running, event);
    } else if (state.task && event.message) {
      const last = state.task.timeline[state.task.timeline.length - 1];
      if (!last || last.message !== event.message) state.task.timeline.push({ message: event.message, at: Date.now() });
      if (event.percent != null) state.task.percent = event.percent;
      if (event.scope === "browser-install") ge.onboardingStatus.textContent = event.message;
      renderSheet();
    } else if (event.message && event.scope === "browser-install") {
      ge.onboardingStatus.textContent = event.message;
    }
  });

  checkBrowserInstalled();
  try {
    const appState = await api.loadAppState();
    if (appState?.lastProjectRoot) {
      addProject();
      const first = Array.from(state.projects.values())[0];
      if (first) {
        first.rootDir = appState.lastProjectRoot;
        try { await refreshProject(first); } catch { /* folder may be gone */ }
      }
    }
  } catch { /* no saved state */ }

  if (!state.activeProjectId) showOnboarding();
  await checkRuntimeDeps();
  await updateAuthStatus();
}

void boot();
