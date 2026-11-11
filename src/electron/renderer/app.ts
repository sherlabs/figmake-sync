import type { AgentChoice, ChatState, Phase, ProjectStatus, SessionState } from "../contracts.js";
import type { UpdateState } from "../../updater/contracts.js";
import { aiRowActions, type AiAction } from "./aiRow.js";
import { MODEL_OPTIONS } from "../../app/modelIds.js";
import { buildModelMenu, isCustomModel, modelForm, modelLocked } from "./modelMenu.js";
import { createBrowserBar } from "./browserBar.js";
import { createChatPanel } from "./chat.js";
import { createFilesPanel } from "./files.js";
import { createOutputPanel } from "./outputTab.js";
import { createIgnoredList, createReview, filesNotSentText } from "./review.js";
import { createMergeView } from "./sync.js";
import { ago, h, icon, nodes, plural, type Child } from "./dom.js";
import { copyButton, formatElapsed, logView, slowHints, tailView, type LogView, type TailView } from "./output.js";

/* Renderer: draws SessionState and forwards clicks. No business logic lives here. */

const api = window.figmake;
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
document.documentElement.classList.add(IS_MAC ? "is-mac" : "is-win");

const AGENTS: { id: AgentChoice; name: string; blurb: string; mark: string; glyph: string }[] = [
  { id: "claude", name: "Claude", blurb: "Sign in with your Claude account.", mark: "claude", glyph: "claude" },
  { id: "codex", name: "ChatGPT", blurb: "Sign in with your ChatGPT account.", mark: "gpt", glyph: "gpt" },
];
const agentName = (id: AgentChoice | null): string => AGENTS.find((a) => a.id === id)?.name ?? "Your AI helper";
const STATUS_TEXT: Record<ProjectStatus, string> = { synced: "Up to date", changes: "Changes waiting", attention: "Needs attention" };
const DOT: Record<ProjectStatus, string> = { synced: "ok", changes: "chg", attention: "bad" };
const BUSY: readonly Phase[] = ["connecting", "preparing", "working", "sending", "syncing"];
const STEPS = ["Getting your project", "Setting up", "Starting preview", "Ready"];

type UserSheet = { kind: "review" } | { kind: "ignored" } | { kind: "add" } | { kind: "settings" } | { kind: "remove"; key: string } | { kind: "rename"; key: string } | { kind: "undo"; index: number } | { kind: "confirm"; action: "start-over" | "reset-app" } | { kind: "sync-replace"; count: number };

let state: SessionState | null = null;
let updateReady = false;
let upd: UpdateState = { phase: "idle", currentVersion: "", supported: true, upToDate: false };
let liveUpdateRow: HTMLElement | null = null;
let userSheet: UserSheet | null = null;
let paletteOpen = false;
let menuOpen = false;
let chatState: ChatState = { projectKey: null, messages: [], active: false, fresh: false };
let prepSince = 0;
let prepTimer = 0;
let prepTick = 0;
let bannerDetails = false;

const busyNow = (s: SessionState): boolean => BUSY.includes(s.phase);
/** Anything in flight, including a question waiting to be answered: Clean up waits for it. */
const cleanupBusy = (s: SessionState): boolean => busyNow(s) || s.phase === "conflict" || s.phase === "resolving";
const report = (s: SessionState): void => void api.reportIssue({ errorCode: s.code ?? "unknown", message: s.message ?? "", phase: s.failedIn ?? s.phase });
const openSupport = (): void => void api.openSupport();
const reportProblem = (): void => void api.reportIssue({ errorCode: "unknown", message: "Reported from the app", phase: state?.phase ?? "start" });

// ================= skeleton (built once) =================

const plist = h("ul", { class: "plist", role: "listbox", "aria-labelledby": "projects-h" });
const sideEmpty = h("p", { class: "side-empty" }, "No projects yet. Paste a Figma Make link to start.");
const addBtn = h("button", { type: "button", class: "sbtn", onclick: () => openSheet({ kind: "add" }) }, icon("plus"), "Add project");
const supportBtn = h("button", { type: "button", class: "support", title: "Opens sherlabs.com in your browser", onclick: () => openSupport() }, icon("heart"), h("span", { class: "t" }, h("b", {}, "Support Sherlabs"), h("span", {}, "Free app. Chip in if it helps.")));
const side = h("aside", { class: "side", id: "fm-side", "aria-label": "Projects" }, h("div", { class: "side-top", "aria-hidden": "true" }), h("h2", { id: "projects-h", class: "side-h" }, "Projects"), plist, sideEmpty, addBtn, h("div", { class: "spacer" }), supportBtn);

const title = h("h1", {}, "figmake-sync");
const chip = h("span", { class: "chip status", role: "status" });
const updateBtn = h("button", { type: "button", class: "plain update", hidden: true, onclick: () => void api.installUpdate() }, icon("refresh", true), "Restart to update");
const sendBtn = h("button", { type: "button", class: "btn primary send", "aria-keyshortcuts": "", onclick: () => openSheet({ kind: "review" }) });
const gearBtn = h("button", { type: "button", class: "btn icon gear", "aria-label": "Settings", title: `Settings (${MOD},)`, onclick: () => openSheet({ kind: "settings" }) }, icon("gear"));
const syncBtn = h("button", { type: "button", class: "btn sy-btn", "aria-haspopup": "menu", onclick: () => showSyncMenu() }, icon("refresh", true), h("span", { class: "bl" }, "Sync with Figma"));
const chatBtn = h("button", { type: "button", class: "btn icon chat-toggle", "aria-label": "Side panel", "aria-pressed": "true", "aria-keyshortcuts": "Meta+J Control+J", title: `Side panel (${MOD}J)`, onclick: () => setChatOpen(!chatOpen) }, icon("panel"), h("span", { class: "pip", hidden: true }));
const sideToggle = h("button", { type: "button", class: "btn icon fm-sidetoggle", "aria-controls": "fm-side", "aria-expanded": "true", "aria-label": "Hide sidebar", "aria-keyshortcuts": "Meta+B Control+B", title: `Hide sidebar (${MOD}B)`, onclick: () => setSideOpen(!sideOpen) }, icon("sidebar"));
const toolbar = h("header", { class: "toolbar" }, h("div", { class: "ttl row-ttl" }, sideToggle, title, chip), h("div", { class: "tright" }, updateBtn, chatBtn, syncBtn, sendBtn, gearBtn));

const banner = h("div", { class: "errbanner", role: "alert", hidden: true });
const pgCard = h("div", { class: "pg-card", role: "group", "aria-label": "Sending to Figma", hidden: true });

const welcomeInput = h("input", { class: "field", type: "text", placeholder: "https://www.figma.com/make/…", "aria-label": "Figma Make link", spellcheck: "false", autocomplete: "off" });
const welcomeOpen = h("button", { type: "submit", class: "btn primary", disabled: true }, "Open");
const welcome = h(
  "div",
  { class: "card welcome" },
  h("div", { class: "art" }, h("span", { class: "ghost g1" }, icon("doc")), h("img", { src: "./assets/icon-256.png", alt: "" }), h("span", { class: "ghost g2" }, icon("figma"))),
  h(
    "div",
    { class: "wbody" },
    h("h2", {}, "Paste your Figma Make link"),
    h("p", { class: "lead" }, "Your project opens here so you can describe changes and send them back to Figma."),
    h("form", { onsubmit: (e: Event) => { e.preventDefault(); submitLink(welcomeInput, welcomeOpen); } }, welcomeInput, welcomeOpen),
    h("p", { class: "help" }, icon("info"), "Copy it from the address bar while your Figma Make file is open."),
  ),
);
welcomeInput.addEventListener("input", () => (welcomeOpen.disabled = !welcomeInput.value.trim()));
const prep = h("div", { class: "card prep", role: "status" });
const calm = h("div", { class: "calm" });
const slot = h("div", { class: "slot" });
const browserBar = createBrowserBar(api, slot);
const stage = h("main", { class: "stage", id: "pane" }, browserBar.shell, welcome, prep, calm);

const statusText = h("span", { role: "status" });
const statusBar = h("footer", { class: "status" }, statusText, h("span", { class: "sp" }), h("span", {}, h("span", { class: "kbd" }, `${MOD}J`), " Panel"), h("span", {}, h("span", { class: "kbd" }, `${MOD}K`), " Commands"));

const chatPanel = createChatPanel({
  api,
  mod: MOD,
  confirmUndo: (index) => openSheet({ kind: "undo", index }),
  openSettings: () => openSheet({ kind: "settings" }),
  openModelMenu: (anchor) => showModelMenu(anchor),
  report: () => state && report(state),
  collapse: () => setChatOpen(false),
  toast: (text) => toast(text),
});
const outputPanel = createOutputPanel({ api, mod: MOD, collapse: () => setChatOpen(false) });
const filesPanel = createFilesPanel({ api, mod: MOD, collapse: () => setChatOpen(false) });
type RailTab = "chat" | "files" | "output";
const tabChat = h("button", { type: "button", role: "tab", id: "tab-chat", "aria-controls": "rail-body", onclick: () => setTab("chat") }, "Chat");
const tabOutput = h("button", { type: "button", role: "tab", id: "tab-output", "aria-controls": "rail-body", onclick: () => setTab("output") }, "Output");
const tabFiles = h("button", { type: "button", role: "tab", id: "tab-files", "aria-controls": "rail-body", onclick: () => setTab("files") }, "Files");
const tabs = h("div", { class: "rail-tabs" }, h("div", { class: "seg", role: "tablist", "aria-label": "Side panel" }, tabChat, tabFiles, tabOutput));
const rail = h("section", { class: "rail", id: "rail-body", "aria-label": "Side panel" }, tabs, chatPanel.el, filesPanel.el, outputPanel.el);
const resizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize side panel", tabindex: "0" });
const work = h("div", { class: "work" }, stage, resizer, rail);
const main = h("div", { class: "main" }, toolbar, banner, pgCard, work, statusBar);
const appEl = h("div", { class: "app" }, side, main);

const sheetHost = h("div", { class: "sheet-host" });
const menuHost = h("div", { class: "menu-host" });
const toasts = h("div", { class: "toasts", "aria-live": "polite" });
document.getElementById("app")?.append(appEl, sheetHost, menuHost, toasts);

// ================= actions =================

function submitLink(input: HTMLInputElement, button: HTMLButtonElement, nameInput?: HTMLInputElement): void {
  const value = input.value.trim();
  if (!value) return;
  const name = nameInput?.value.trim().slice(0, 80);
  input.value = "";
  button.disabled = true;
  closeSheet();
  void (name ? api.openProject(value, name) : api.openProject(value));
}

function toast(text: string, ms = 3200): void {
  const t = h("div", { class: "toast", role: "status" }, icon("check"), text);
  toasts.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Opens another project. A click is never silently dead: when the app can't switch right now it says why. */
function switchTo(key: string): void {
  closeSheet();
  void api.switchProject(key).then((r) => { if (!r.ok) toast(r.message); }).catch(() => undefined);
}

function runAiAction(a: AiAction): void {
  if (a.kind === "connect" || a.kind === "switch") void api.setAgent(a.agent);
  else if (a.kind === "signin") void (state?.agent && !state.agentConnected ? api.setAgent(state.agent) : api.signInAgent());
  else {
    const name = agentName(state?.agent ?? null);
    void api.signOutAgent().then((r) => toast(r.ok ? `Signed out of ${name}` : `Sign out in your terminal: ${r.command}`, r.ok ? 3200 : 9000)).catch(() => undefined);
  }
}

/** Settings: the model of the chosen AI, as a plain picker (a menu can't open over a dialog). "Other…" shows the name field. */
let modelOtherOpen = false;
function modelRows(s: SessionState): HTMLElement[] {
  const agent = s.agent;
  if (!agent) return [];
  const model = s.model ?? null;
  const locked = modelLocked(s.phase, chatState.active);
  const custom = isCustomModel(agent, model);
  const OTHER = "\u0000other";
  const select = h("select", { class: "field msel", "aria-label": `${agentName(agent)} model`, disabled: locked, onchange: (e: Event) => {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === OTHER) { modelOtherOpen = true; renderSheets(s, true); return; }
    modelOtherOpen = false;
    void api.setModel(v === "" ? null : v);
  } },
  ...MODEL_OPTIONS[agent].map((o) => h("option", { value: o.id ?? "" }, o.label)),
  custom && model ? h("option", { value: model }, model) : null,
  h("option", { value: OTHER }, "Other…"));
  select.value = modelOtherOpen ? OTHER : model ?? "";
  const rows = [h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "AI model"), h("span", {}, locked ? "Changes apply from your next message" : `Used by ${agentName(agent)}. Default follows your own setup.`)), h("div", { class: "r" }, select))];
  if (modelOtherOpen && !locked) {
    const form = modelForm({ ...(custom && model ? { initial: model } : {}), onApply: (m) => { modelOtherOpen = false; void api.setModel(m); }, onCancel: () => { modelOtherOpen = false; renderSheets(s, true); } });
    rows.push(h("div", { class: "row mrow" }, form.el));
  }
  return rows;
}

// ================= sidebar =================

function projectRow(p: SessionState["projects"][number], s: SessionState): HTMLElement {
  const selected = p.key === s.activeKey;
  const working = selected && busyNow(s);
  const status: ProjectStatus = p.status;
  const tail = working ? h("span", { class: "spin s", "aria-hidden": "true" }) : h("span", { class: `dot ${DOT[status]}`, title: STATUS_TEXT[status], "aria-hidden": "true" });
  const row = h(
    "button",
    { type: "button", class: "prow", role: "option", "aria-selected": selected ? "true" : "false", "aria-label": `${p.name}, ${working ? "working" : STATUS_TEXT[status].toLowerCase()}`, onclick: () => !selected && switchTo(p.key), ondblclick: () => openSheet({ kind: "rename", key: p.key }) },
    icon("folder"),
    h("span", { class: "nm" }, p.name),
    h("span", { class: "ptail" }, tail),
  );
  const more = h("button", { type: "button", class: `more${selected ? " on-sel" : ""}`, "aria-label": `More options for ${p.name}`, "aria-haspopup": "menu", onclick: (e: MouseEvent) => { e.stopPropagation(); showMenu(p.key, p.name, (e.currentTarget as HTMLElement).getBoundingClientRect().left, (e.currentTarget as HTMLElement).getBoundingClientRect().bottom + 4); } }, icon("more", true));
  return h("li", { class: "prow-wrap", oncontextmenu: (e: MouseEvent) => { e.preventDefault(); showMenu(p.key, p.name, e.clientX, e.clientY); } }, row, more);
}

function renderSidebar(s: SessionState): void {
  plist.replaceChildren(...s.projects.map((p) => projectRow(p, s)));
  sideEmpty.hidden = s.projects.length > 0;
  plist.hidden = s.projects.length === 0;
}

function showMenu(key: string, name: string, x: number, y: number): void {
  closeMenu();
  menuOpen = true;
  const rename = h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); openSheet({ kind: "rename", key }); } }, icon("pencil"), "Rename…");
  const item = h("button", { type: "button", class: "danger", role: "menuitem", onclick: () => { closeMenu(); openSheet({ kind: "remove", key }); } }, icon("trash"), "Remove from list…");
  const menu = h("div", { class: "menu", role: "menu", "aria-label": name }, rename, item);
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 90)}px`;
  menuHost.replaceChildren(menu);
  rename.focus();
  syncPreview();
}
/** The small menu under "Sync with Figma". */
function showSyncMenu(): void {
  if (menuOpen) return closeMenu();
  menuOpen = true;
  const merge = h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); void api.syncWithFigma("merge"); } }, icon("refresh"), "Merge Figma's changes into mine");
  const replace = h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); askReplace(); } }, icon("undo"), "Discard my changes and use Figma's");
  const menu = h("div", { class: "menu sy-menu", role: "menu", "aria-label": "Sync with Figma" }, merge, replace);
  const r = syncBtn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menuHost.replaceChildren(menu);
  merge.focus();
  syncPreview();
}
/** Asks how many files would be discarded, then opens the confirm sheet. */
function askReplace(): void {
  void api.localChangeCount().catch(() => 0).then((count) => openSheet({ kind: "sync-replace", count }));
}
/** The model menu: opens above the chat's AI chip (or the "Choose model" button) and gives the focus back when it closes. */
let menuReturn: HTMLElement | null = null;
function showModelMenu(anchor: HTMLElement): void {
  if (menuOpen) return closeMenu();
  const s = state;
  if (!s?.agent) return;
  menuOpen = true;
  menuReturn = anchor;
  const built = buildModelMenu({
    agent: s.agent,
    agentName: agentName(s.agent),
    model: s.model ?? null,
    locked: modelLocked(s.phase, chatState.active),
    onPick: (model) => { closeMenu(); void api.setModel(model); },
    onSwitchAI: () => { closeMenu(); openSheet({ kind: "settings" }); },
    onClose: closeMenu,
  });
  const r = anchor.getBoundingClientRect();
  built.el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 252))}px`;
  built.el.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  menuHost.replaceChildren(built.el);
  built.focus();
  syncPreview();
}
function closeMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  const back = menuReturn;
  menuReturn = null;
  const hadFocus = menuHost.contains(document.activeElement);
  menuHost.replaceChildren();
  if (hadFocus && back?.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
  syncPreview();
}
document.addEventListener("pointerdown", (e) => {
  const t = e.target as Element;
  if (menuOpen && !t.closest(".menu") && !(menuReturn && menuReturn.contains(t))) closeMenu();
});

// ================= toolbar / banner / status =================

/** The toolbar chip while sending: plain words and a real count. */
function sendChipText(p: SessionState["sendProgress"]): string {
  if (!p) return "Sending…";
  if (p.phase === "checking") return "Checking Figma";
  if (p.phase === "saving") return p.percent >= 100 ? "Sent" : "Saving in Figma";
  return p.total > 0 ? `Sending ${Math.min(p.index, p.total)} of ${p.total}` : "Sending…";
}

function statusChip(s: SessionState): { text: string; tone: string; spin: boolean } {
  if (s.phase === "error" || s.phase === "needs-figma-signin" || s.phase === "needs-ai-signin" || s.phase === "conflict" || s.phase === "resolving" || s.phase === "needs-ai-choice") return { text: s.phase === "error" ? "Needs attention" : "Waiting for you", tone: s.phase === "error" ? "bad" : "chg", spin: false };
  if (s.phase === "sending") return { text: sendChipText(s.sendProgress), tone: "busy", spin: true };
  if (busyNow(s)) return { text: "Working", tone: "busy", spin: true };
  return s.canSend ? { text: "Changes waiting", tone: "chg", spin: false } : { text: "Up to date", tone: "ok", spin: false };
}

function renderToolbar(s: SessionState): void {
  const hasProject = s.phase !== "start" && s.projectName;
  title.textContent = hasProject ? s.projectName : "figmake-sync";
  chip.hidden = !hasProject;
  if (hasProject) {
    const c = statusChip(s);
    chip.className = `chip status ${c.tone}`;
    chip.replaceChildren(c.spin ? h("span", { class: "spin", "aria-hidden": "true" }) : h("span", { class: `dot ${c.tone === "busy" ? "" : c.tone}` }), c.text);
  }
  sendBtn.hidden = !hasProject;
  syncBtn.hidden = !hasProject;
  syncBtn.disabled = s.phase !== "ready";
  const enabled = s.phase === "ready" && s.canSend;
  sendBtn.disabled = !enabled;
  const count = s.changes.length;
  sendBtn.replaceChildren(...nodes(icon("up"), h("span", { class: "bl" }, "Send to Figma"), enabled && count > 0 ? h("span", { class: "badge", "aria-label": plural(count, "change") }, String(count)) : null));
  updateBtn.hidden = !updateReady;
}

function renderBanner(s: SessionState): void {
  // A failed turn is answered inside the chat; the banner is for everything else.
  const inline = s.phase === "error" && Boolean(s.previewUrl) && chatState.messages.at(-1)?.status === "error";
  banner.hidden = s.phase !== "error" || inline;
  if (banner.hidden) {
    bannerDetails = false;
    return banner.replaceChildren();
  }
  const lines = (s.activity?.lines ?? []).slice(-20);
  const toggle = lines.length
    ? h("button", { type: "button", class: "btn sm", "aria-expanded": String(bannerDetails), onclick: () => { bannerDetails = !bannerDetails; if (state) renderBanner(state); } }, bannerDetails ? "Hide details" : "Show details")
    : null;
  banner.replaceChildren(
    ...nodes(
    icon("warn"),
    h("div", { class: "t" }, s.message ?? "Something went wrong."),
    h("button", { type: "button", class: "btn primary sm", onclick: () => void api.retry() }, s.code === "agent_signin_required" ? "Sign in" : "Try again"),
    toggle,
    h("button", { type: "button", class: "btn sm", onclick: () => report(s) }, "Report"),
    bannerDetails && lines.length ? h("pre", { class: "errlog", tabindex: "0", "aria-label": "Recent output" }, lines.join("\n")) : null,
    ),
  );
}

// ================= sending loader =================

interface SendUi {
  title: HTMLElement;
  pct: HTMLElement;
  clock: HTMLElement;
  track: HTMLElement;
  fill: HTMLElement;
  count: HTMLElement;
  toggle: HTMLButtonElement;
  recent: HTMLElement;
  all: HTMLElement;
}
let pgUi: SendUi | null = null;
let pgAll = false;
let pgStart = 0;
let pgTick = 0;

function buildSendCard(): SendUi {
  const title = h("span", { class: "pg-title" });
  const pct = h("span", { class: "pg-pct" }, "0%");
  const clock = h("span", { class: "pg-clock" }, "0:00");
  const fill = document.createElement("i");
  fill.className = "pg-fill";
  const track = h("div", { class: "pg-track", role: "progressbar", "aria-label": "Sending to Figma", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const count = h("span", { class: "pg-count" });
  const toggle = h("button", { type: "button", class: "plain quiet pg-toggle", "aria-expanded": "false", onclick: () => { pgAll = !pgAll; if (state) renderSendCard(state); } }, "Show details");
  const recent = h("ul", { class: "pg-list pg-recent", "aria-label": "Recently sent" });
  const all = h("ul", { class: "pg-list pg-all", "aria-label": "All files", hidden: true });
  const stop = h("button", { type: "button", class: "plain quiet pg-stop", onclick: () => void api.cancel() }, "Stop");
  pgCard.replaceChildren(
    h("div", { class: "pg-head" }, h("span", { class: "spin", "aria-hidden": "true" }), title, pct, clock, stop),
    track,
    h("div", { class: "pg-meta" }, count, toggle),
    recent,
    all,
  );
  return { title, pct, clock, track, fill, count, toggle, recent, all };
}

function sendTitle(p: NonNullable<SessionState["sendProgress"]>): string {
  if (p.phase === "checking") return "Checking Figma for newer changes";
  if (p.phase === "saving") return p.percent >= 100 ? "Sent" : "Saving your changes in Figma";
  const verb = p.op === "delete" ? "Removing" : "Sending";
  if (p.name) return `${verb} ${p.name}`;
  if (p.op && p.total > 0) return `${verb} new files`;
  return "Getting ready";
}

function sendRow(f: { file: string; name: string; ok: boolean }): HTMLElement {
  return h("li", { class: f.ok ? "pg-done" : "pg-skip", title: f.file }, f.ok ? icon("check-b", true) : icon("warn", true), h("span", { class: "pg-name" }, f.name), f.ok ? null : h("span", { class: "pg-note" }, "Not sent"));
}

function tickSend(): void {
  if (pgUi && state?.sendProgress) pgUi.clock.textContent = formatElapsed(Date.now() - state.sendProgress.startedAt);
}

function renderSendCard(s: SessionState): void {
  const p = s.phase === "sending" ? s.sendProgress ?? null : null;
  pgCard.hidden = s.phase !== "sending";
  if (s.phase !== "sending") {
    pgAll = false;
    pgStart = 0;
    window.clearInterval(pgTick);
    pgTick = 0;
    return;
  }
  const ui = (pgUi ??= buildSendCard());
  if (!pgStart) pgStart = Date.now();
  if (!pgTick) pgTick = window.setInterval(tickSend, 1000);
  const pct = p ? p.percent : 0;
  ui.title.textContent = p ? sendTitle(p) : "Getting ready";
  ui.title.title = p?.file ?? "";
  ui.pct.textContent = `${pct}%`;
  ui.fill.style.width = `${pct}%`;
  ui.track.setAttribute("aria-valuenow", String(pct));
  ui.count.textContent = p && p.total > 0 ? `${p.completed} of ${p.total} ${p.total === 1 ? "file" : "files"} done` : "";
  ui.clock.textContent = formatElapsed(Date.now() - (p?.startedAt ?? pgStart));
  const done = p?.done ?? [];
  ui.recent.replaceChildren(...done.slice(-3).map(sendRow));
  ui.recent.hidden = pgAll || done.length === 0;
  ui.all.replaceChildren(...done.map(sendRow));
  ui.all.hidden = !pgAll;
  ui.toggle.hidden = done.length === 0;
  ui.toggle.textContent = pgAll ? "Hide details" : "Show details";
  ui.toggle.setAttribute("aria-expanded", String(pgAll));
  if (pgAll) ui.all.scrollTop = ui.all.scrollHeight;
}

const WORKING_TEXT: Partial<Record<Phase, (s: SessionState) => string>> = {
  connecting: () => "Getting your project…",
  preparing: (s) => (s.previewUrl || !s.projectName ? `Getting ${agentName(s.agent)} ready…` : "Setting things up…"),
  working: (s) => `${agentName(s.agent)} is making your change…`,
  sending: (s) => (s.sendProgress && s.sendProgress.total > 0 ? `Sending to Figma… ${s.sendProgress.percent}%` : "Sending to Figma…"),
  syncing: () => "Syncing with Figma…",
};

function renderStatus(s: SessionState): void {
  const parts: string[] = [];
  const working = WORKING_TEXT[s.phase];
  if (working) parts.push(working(s));
  else if (s.phase === "error") parts.push("Something went wrong");
  else if (s.phase === "start") parts.push("Ready");
  else if (s.phase === "needs-ai-choice" && !s.projectName) parts.push("Pick your AI helper");
  else if (s.phase === "needs-ai-signin" && !s.projectName) parts.push(`Sign in to ${agentName(s.agent)}`);
  else {
    const when = ago(s.syncedAt);
    parts.push(when ? `Synced ${when}` : "Not synced yet", "Backup saved");
  }
  statusText.textContent = parts.join(" · ");
}

// ================= stage =================

function prepStep(s: SessionState): number {
  if (s.phase === "connecting") return 0;
  const lines = s.activity?.lines ?? [];
  if (lines.includes("Starting the preview")) return 2;
  if (lines.includes("Installing project files")) return 1;
  return Date.now() - prepSince > 3500 ? 2 : 1;
}

interface PrepUi {
  prog: HTMLElement;
  steps: HTMLElement;
  elapsed: HTMLElement;
  clock: HTMLElement;
  hints: HTMLElement;
  tail: TailView;
  toggle: HTMLButtonElement;
  full: HTMLElement;
  log: LogView;
}
let prepUi: PrepUi | null = null;
let prepAll = false;
let prepLines: readonly string[] = [];
let prepStepStart = 0;

function buildPrep(): PrepUi {
  const prog = h("div", { class: "prog", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" });
  const steps = h("ul", { class: "steps" });
  const clock = h("span", { class: "mono" }, "0:00");
  const elapsed = h("div", { class: "elapsed" }, "On this step for ", clock);
  const hints = h("div", { class: "slowhint", role: "status" });
  const tail = tailView(3, "Latest output");
  const log = logView("All output");
  const toggle = h("button", { type: "button", class: "plain quiet showall", "aria-expanded": "false", onclick: () => setPrepAll(!prepAll) }, "Show all output");
  const copy = copyButton(() => prepLines.join("\n"), (t) => api.copyText(t));
  const open = h("button", { type: "button", class: "plain quiet", onclick: () => { chatOpen = true; store.set("chat.open", "1"); setTab("output"); layoutChat(); } }, "Open in Output tab");
  const full = h("div", { class: "fulllog", hidden: true }, log.el, h("div", { class: "logbar" }, open, copy));
  const ui: PrepUi = { prog, steps, elapsed, clock, hints, tail, toggle, full, log };
  prep.replaceChildren(
    h("h2", {}, "Getting your project ready"),
    h("p", {}, "This can take a few minutes the first time. You can keep this window open."),
    prog,
    steps,
    elapsed,
    h("div", { class: "outbox" }, tail.el, toggle),
    full,
    hints,
    h("div", { class: "foot" }, h("button", { type: "button", class: "plain quiet", onclick: () => void api.cancel() }, "Stop")),
  );
  return ui;
}

function setPrepAll(on: boolean): void {
  prepAll = on;
  if (!prepUi) return;
  prepUi.full.hidden = !on;
  prepUi.toggle.textContent = on ? "Hide output" : "Show all output";
  prepUi.toggle.setAttribute("aria-expanded", String(on));
  prepUi.tail.el.hidden = on;
  if (on) {
    prepUi.log.set(prepLines);
    prepUi.log.follow();
  }
}

/** The clock and the gentle "taking longer" lines; cheap enough to run every second. */
function tickPrep(): void {
  if (!prepUi || prep.hidden) return;
  const ms = Date.now() - prepStepStart;
  prepUi.clock.textContent = formatElapsed(ms);
  const hints = slowHints(ms);
  if (prepUi.hints.childElementCount !== hints.length) prepUi.hints.replaceChildren(...hints.map((t) => h("p", {}, t)));
}

function renderPrep(s: SessionState): void {
  const ui = (prepUi ??= buildPrep());
  const cur = prepStep(s);
  const pct = ((cur + 0.5) / STEPS.length) * 100;
  ui.prog.setAttribute("aria-valuenow", String(Math.round(pct)));
  ui.prog.replaceChildren(progressFill(pct));
  ui.steps.replaceChildren(...STEPS.map((label, i) => h("li", { class: i < cur ? "done" : i === cur ? "cur" : "" }, h("span", { class: "mk" }, i < cur ? icon("check-b", true) : i === cur ? h("span", { class: "spin" }) : String(i + 1)), h("span", {}, label))));
  prepLines = s.activity?.lines ?? [];
  // The step clock follows the session's own timestamp; a step change restarts it.
  prepStepStart = s.activity?.stepStartedAt ?? prepSince;
  ui.tail.set(prepLines);
  if (prepAll) ui.log.set(prepLines);
  tickPrep();
}
function progressFill(pct: number): HTMLElement {
  const i = document.createElement("i");
  i.style.width = `${pct}%`;
  return i;
}

function renderStage(s: SessionState): void {
  // Before any project exists the AI helper is connected on top of the start screen.
  const upFront = !s.projectName && !s.previewUrl && (s.phase === "needs-ai-choice" || s.phase === "needs-ai-signin" || s.phase === "preparing");
  const start = s.phase === "start" || upFront;
  const preparing = !upFront && !s.previewUrl && (s.phase === "connecting" || s.phase === "preparing");
  const calmIdle = !start && !preparing && !s.previewUrl;
  welcome.hidden = !start;
  prep.hidden = !preparing;
  calm.hidden = !calmIdle;
  browserBar.shell.hidden = !s.previewUrl;
  if (preparing) {
    if (!prepSince) prepSince = Date.now();
    renderPrep(s);
    window.clearTimeout(prepTimer);
    prepTimer = window.setTimeout(() => state && renderStage(state), 3600);
    if (!prepTick) prepTick = window.setInterval(tickPrep, 1000);
  } else {
    prepSince = 0;
    window.clearInterval(prepTick);
    prepTick = 0;
  }
  if (calmIdle) calm.replaceChildren(h("span", { class: "ico" }, icon("laptop")), h("h3", {}, "Your preview shows up here"), h("p", {}, "Once this is sorted out, your project appears in this space."));
}

// ================= sheets =================

function sheetFrame(o: { tone?: string; glyph: Node; title: string; sub?: string; body?: Child[]; hint?: string; acts?: Child[]; label: string }): HTMLDialogElement {
  const dlg = h(
    "dialog",
    { class: "sheet", "aria-label": o.label },
    h("div", { class: "hd" }, h("div", { class: `logo ${o.tone ?? ""}`, "aria-hidden": "true" }, o.glyph), h("div", { class: "t" }, h("h2", {}, o.title), o.sub ? h("p", {}, o.sub) : null)),
    o.body?.length ? h("div", { class: "bd" }, ...o.body) : null,
    o.acts || o.hint ? h("div", { class: "ft" }, h("small", {}, o.hint ?? ""), h("span", { class: "acts" }, ...(o.acts ?? []))) : h("div", { class: "pad" }),
  );
  return dlg;
}

const btn = (label: string, onclick: () => void, kind = "", extra: Record<string, unknown> = {}): HTMLButtonElement => h("button", { type: "button", class: `btn lg ${kind}`.trim(), onclick, ...extra }, label);
const waitRow = (text: string): HTMLElement => h("div", { class: "waitrow", role: "status" }, h("span", { class: "spin" }), text);

function filesList(files: string[]): HTMLElement {
  return h("ul", { class: "files" }, ...files.slice(0, 6).map((f) => h("li", {}, icon("doc", true), f)), files.length > 6 ? h("li", {}, `and ${files.length - 6} more`) : null);
}

/** What the Updates row says for the current update state. Exported shape kept plain for the layout test. */
function updateText(u: UpdateState, auto: boolean): { status: string; note: string } {
  const v = u.currentVersion ? `v${u.currentVersion}` : "";
  const off = "Automatic updates are off";
  if (!u.supported) return { status: "Updates aren't available in this version.", note: v ? `Version ${v}` : "" };
  let status: string;
  if (u.phase === "ready") status = "A new version is ready";
  else if (u.phase === "downloading") status = "Downloading update…";
  else if (u.phase === "checking") status = "Checking…";
  else if (u.error) status = u.error;
  else if (u.upToDate) status = `You're up to date (${v})`;
  else status = auto ? `Version ${v}` : off;
  return { status, note: !auto && status !== off ? off : "" };
}

function fillUpdateRow(row: HTMLElement, auto: boolean): void {
  const { status, note } = updateText(upd, auto);
  const busy = upd.phase === "checking" || upd.phase === "downloading";
  const action = upd.phase === "ready"
    ? btn("Restart to update", () => void api.installUpdate(), "primary")
    : btn("Check for updates", () => runUpdateCheck(), "", { disabled: busy || !upd.supported });
  row.replaceChildren(
    h("div", { class: "l" }, h("b", {}, "Updates"), h("span", { class: upd.error && upd.phase === "idle" ? "bad" : "", role: "status" }, status), note ? h("span", {}, note) : null),
    h("div", { class: "r" }, upd.supported ? action : null),
  );
}

function paintUpdateRow(): void {
  if (liveUpdateRow?.isConnected && state) fillUpdateRow(liveUpdateRow, state.updatesEnabled);
}

function runUpdateCheck(): void {
  if (upd.phase === "idle") {
    const { error: _e, ...rest } = upd; // eslint-disable-line @typescript-eslint/no-unused-vars
    upd = { ...rest, phase: "checking" };
    paintUpdateRow();
  }
  void api.checkForUpdates().then((next) => {
    upd = next;
    updateReady = next.phase === "ready";
    paintUpdateRow();
    if (state) renderToolbar(state);
  });
}

function buildSheet(kind: string, s: SessionState): HTMLDialogElement {
  switch (kind) {
    case "ai-choice":
      return sheetFrame({ label: "Connect your AI helper", glyph: icon("sparkle"), tone: "accent", title: "Connect your AI helper", sub: "Choose the one you already use. It makes the changes you describe, and you can switch any time in Settings.", body: [h("div", { class: "choices", role: "group" }, ...AGENTS.map((a) => h("button", { type: "button", class: "choice", onclick: () => void api.setAgent(a.id) }, h("span", { class: `mark ${a.mark}` }, icon(a.glyph)), h("b", {}, a.name), h("span", {}, a.blurb))))], hint: "You'll sign in once, in your browser." });
    case "ai-setup":
      return sheetFrame({ label: "Getting your AI helper ready", glyph: icon("sparkle"), tone: "accent", title: `Getting ${agentName(s.agent)} ready`, sub: "Setting it up on this Mac. This only takes a moment.", body: [waitRow(`Setting up ${agentName(s.agent)}`)], acts: [btn("Stop", () => void api.cancel())] });
    case "ai-signin":
      return sheetFrame({ label: "Signing in", glyph: icon("person"), tone: "accent", title: `Sign in to ${agentName(s.agent)}`, sub: "A browser window opened for you.", body: [waitRow("Waiting for sign-in in your browser"), h("p", { class: "lead" }, "Finish signing in there and this window carries on by itself.")], acts: [btn("Stop", () => void api.cancel())] });
    case "figma-signin": {
      const waiting = Boolean(s.message);
      return sheetFrame({
        label: "Sign in to Figma",
        glyph: icon("figma"),
        tone: "accent",
        title: "Sign in to Figma",
        sub: "So we can bring in your project.",
        body: waiting ? [waitRow("Waiting for sign-in in your browser"), h("p", { class: "lead" }, "Sign in to Figma in the window that opened. This closes by itself when you're done.")] : [h("p", { class: "lead" }, "Figma opens in a window. Sign in there and you'll come straight back.")],
        acts: waiting ? [btn("Cancel", () => void api.cancel())] : [btn("Open Figma", () => void api.retry(), "primary")],
      });
    }
    case "conflict":
      return sheetFrame({
        label: "Figma has newer changes",
        glyph: icon("warn"),
        tone: "warn",
        title: "Figma has newer changes",
        sub: "Someone edited this project since you last synced.",
        body: [h("p", { class: "lead" }, "Which version do you want to keep?"), s.conflictFiles?.length ? filesList(s.conflictFiles) : null],
        hint: "Either way, a backup is saved first.",
        acts: [btn("Use Figma's", () => void api.send("figma")), btn("Merge", () => void api.syncWithFigma("merge")), btn("Keep mine", () => void api.send("mine"), "primary")],
      });
    case "merge": {
      const view = createMergeView(api, s.mergeConflicts ?? []);
      sheetCleanup = () => view.dispose();
      sheetClass = "sy-sheet";
      return sheetFrame({
        label: "Choose the version to keep",
        glyph: icon("warn"),
        tone: "warn",
        title: "Some files need your choice",
        sub: "You and Figma both changed these.",
        body: [view.body],
        hint: "A backup was saved first.",
        acts: [btn("Keep all mine", () => void api.cancel()), btn("Done", () => void api.resolveMerge(view.choices()), "primary")],
      });
    }
    case "sync-replace": {
      const count = (userSheet as { count: number }).count;
      return sheetFrame({
        label: "Discard my changes",
        glyph: icon("undo"),
        tone: "warn",
        title: "Discard your changes and use Figma's?",
        sub: count > 0 ? `${plural(count, "file")} you changed will go back to Figma's version.` : "Your files will be replaced with Figma's latest.",
        body: [h("p", { class: "lead" }, "A backup of your current files is kept.")],
        acts: [btn("Cancel", closeSheet), btn("Discard my changes", () => { closeSheet(); void api.syncWithFigma("replace"); }, "primary")],
      });
    }
    case "add": {
      const input = h("input", { class: "field", type: "text", placeholder: "https://www.figma.com/make/…", "aria-label": "Figma Make link", spellcheck: "false", autocomplete: "off" });
      const nameField = h("input", { class: "field fm-namefield", type: "text", placeholder: "Name (from link)", "aria-label": "Project name", maxlength: "80", spellcheck: "false", autocomplete: "off" });
      const open = btn("Open", () => submitLink(input, open, nameField), "primary", { disabled: true });
      input.addEventListener("input", () => (open.disabled = !input.value.trim()));
      for (const f of [input, nameField]) f.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && submitLink(input, open, nameField));
      queueMicrotask(() => input.focus());
      return sheetFrame({ label: "Add a project", glyph: icon("plus"), tone: "accent", title: "Add a project", sub: "Paste the link to your Figma Make file.", body: [input, nameField, h("p", { class: "help" }, "Copy it from the address bar while the file is open.")], acts: [btn("Cancel", closeSheet), open] });
    }
    case "settings": {
      const aiStatus = s.agent ? `${agentName(s.agent)} · ${s.agentConnected ? "Connected" : "Not connected"}` : "Not connected";
      const aiButtons: Child[] = aiRowActions(s, AGENTS).map((a) => btn(a.label, () => runAiAction(a), a.primary ? "primary" : "", { disabled: a.disabled }));
      const updates = h("button", { type: "button", class: "sw", role: "switch", "aria-checked": String(s.updatesEnabled), "aria-label": "Keep the app up to date", onclick: () => void api.setUpdates(!s.updatesEnabled) });
      const canClean = !cleanupBusy(s) && Boolean(s.activeKey) && (s.phase === "ready" || s.phase === "error");
      const updateRow = h("div", { class: "row upd" });
      fillUpdateRow(updateRow, s.updatesEnabled);
      liveUpdateRow = updateRow;
      return sheetFrame({
        label: "Settings",
        glyph: icon("gear"),
        title: "Settings",
        body: [
          h(
            "div",
            { class: "setrows" },
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "AI helper"), h("span", { class: s.agent && !s.agentConnected ? "bad" : "" }, aiStatus)), h("div", { class: "r" }, ...aiButtons)),
            ...modelRows(s),
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Projects folder"), h("span", { class: s.workspaceError ? "bad" : "" }, s.workspaceError ?? (s.workspaceSynced ? `${s.workspacePath ?? s.workspace} – synced by cloud storage, which can make projects slow. Pick a folder outside Documents/Desktop/iCloud/OneDrive.` : s.workspacePath ?? s.workspace))), h("div", { class: "r" }, btn("Move…", () => void api.chooseWorkspace()))),
            filesNotSentRow(),
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Figma account"), h("span", {}, "Sign out on this Mac")), h("div", { class: "r" }, btn("Sign out of Figma", () => { void api.signOutFigma(); toast("Signed out of Figma"); }))),
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Automatic updates"), h("span", {}, "Install new versions quietly")), h("div", { class: "r" }, updates)),
            updateRow,
          ),
          h("h3", { class: "setttl" }, "Clean up"),
          h(
            "div",
            { class: "setrows clean" },
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Preview not showing?"), h("span", {}, "Sets up the preview again if it won't show")), h("div", { class: "r" }, btn("Fix the preview", () => { closeSheet(); void api.cleanup("fix-preview"); }, "", { disabled: !canClean }))),
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Start this project over"), h("span", {}, "Latest from Figma, with a backup first")), h("div", { class: "r" }, btn("Start over…", () => openSheet({ kind: "confirm", action: "start-over" }), "", { disabled: !canClean }))),
            h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Reset the app"), h("span", {}, "Signs you out and removes your projects")), h("div", { class: "r" }, btn("Reset…", () => openSheet({ kind: "confirm", action: "reset-app" }), "danger", { disabled: cleanupBusy(s) }))),
          ),
        ],
        acts: [h("button", { type: "button", class: "plain", onclick: () => { closeSheet(); reportProblem(); } }, "Report a problem"), h("button", { type: "button", class: "plain", onclick: openSupport }, "Support Sherlabs"), btn("Done", closeSheet, "primary")],
      });
    }
    case "review": {
      const view = createReview(api);
      const go = btn("Send", () => { closeSheet(); void api.send(); }, "primary", { disabled: true });
      view.onCount((n) => { go.textContent = `Send ${plural(n, "file")}`; go.disabled = n === 0; });
      sheetCleanup = () => view.dispose();
      sheetClass = "rv-sheet";
      return sheetFrame({ label: "Review before sending", glyph: icon("up"), tone: "accent", title: "Send to Figma", sub: "Choose the files to send.", body: [view.body], acts: [btn("Cancel", closeSheet), go] });
    }
    case "ignored":
      sheetClass = "rv-sheet";
      return sheetFrame({ label: "Files not sent", glyph: icon("doc"), title: "Files not sent", body: [createIgnoredList(api)], acts: [btn("Done", closeSheet, "primary")] });
    case "rename": {
      const p = s.projects.find((x) => x.key === (userSheet as { key: string }).key);
      const key = p?.key ?? "";
      const field = h("input", { class: "field", type: "text", value: p?.name ?? "", maxlength: "80", "aria-label": "Project name", spellcheck: "false", autocomplete: "off" });
      const save = btn("Save", () => commit(), "primary", { disabled: !(p?.name ?? "").trim() });
      const commit = (): void => {
        const name = field.value.replace(/\s+/gu, " ").trim();
        if (!name || name.length > 80) return;
        closeSheet();
        if (name !== p?.name) void api.renameProject(key, name);
      };
      field.addEventListener("input", () => { const v = field.value.trim(); save.disabled = !v || v.length > 80; field.setAttribute("aria-invalid", String(v.length > 80)); });
      field.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); commit(); } });
      queueMicrotask(() => { field.focus(); field.select(); });
      return sheetFrame({ label: "Rename project", glyph: icon("pencil"), tone: "accent", title: "Rename project", body: [field], acts: [btn("Cancel", closeSheet), save] });
    }
    case "remove": {
      const p = s.projects.find((x) => x.key === (userSheet as { key: string }).key);
      const key = p?.key ?? "";
      const del = h("input", { type: "checkbox", "aria-label": "Also delete its files" });
      const go = btn("Remove from list", () => { closeSheet(); void api.removeProject(key, del.checked); }, "primary");
      del.addEventListener("change", () => { go.textContent = del.checked ? "Remove and delete files" : "Remove from list"; go.classList.toggle("danger-solid", del.checked); go.classList.toggle("primary", !del.checked); });
      return sheetFrame({ label: "Remove from list", glyph: icon("trash"), tone: "bad", title: `Remove “${p?.name ?? "this project"}”?`, sub: "It leaves your list, and your files stay where they are.", body: [h("label", { class: "sheet-confirm" }, del, "Also delete its files from this Mac")], acts: [btn("Cancel", closeSheet), go] });
    }
    case "confirm": {
      const reset = (userSheet as { action: string }).action === "reset-app";
      const go = btn(reset ? "Reset the app" : "Start over", () => { closeSheet(); void api.cleanup(reset ? "reset-app" : "start-over"); }, reset ? "danger-solid" : "primary");
      return sheetFrame({
        label: reset ? "Reset the app" : "Start this project over",
        glyph: icon(reset ? "trash" : "undo"),
        tone: reset ? "bad" : "warn",
        title: reset ? "Reset the app?" : "Start this project over?",
        sub: reset ? "Signs you out, forgets your projects and chats, and moves the project folders to the Trash." : "This replaces your local copy with the latest from Figma. Your current files are backed up first.",
        acts: [btn("Cancel", closeSheet), go],
      });
    }
    default: {
      const index = (userSheet as { index: number }).index;
      const later = s.changes.length - 1 - index;
      return sheetFrame({ label: "Undo", glyph: icon("undo"), tone: "warn", title: "Undo this change?", sub: `“${s.changes[index] ?? ""}”`, body: [h("p", { class: "lead" }, later > 0 ? `This also undoes the ${plural(later, "change")} you made after it.` : "Your files go back to how they were.")], acts: [btn("Cancel", closeSheet), btn("Undo", () => { closeSheet(); void api.undo(index); }, "primary")] });
    }
  }
}

let sheetCleanup: (() => void) | null = null;
let sheetClass = "";

/** Settings row: how many files are held back, and a way to see them. */
function filesNotSentRow(): HTMLElement {
  const count = h("span", {}, "None");
  void api.ignoredFiles().then((list) => { count.textContent = filesNotSentText(list.length); }).catch(() => undefined);
  return h("div", { class: "row" }, h("div", { class: "l" }, h("b", {}, "Files not sent"), count), h("div", { class: "r" }, btn("View…", () => openSheet({ kind: "ignored" }))));
}

let shownSheet = "";
let dialog: HTMLDialogElement | null = null;

function openSheet(next: UserSheet): void {
  userSheet = next;
  if (state) renderSheets(state);
}
function closeSheet(): void {
  userSheet = null;
  if (state) renderSheets(state);
}

function phaseSheet(s: SessionState): string | null {
  if (s.phase === "needs-ai-choice") return "ai-choice";
  if (s.phase === "needs-ai-signin") return "ai-signin";
  if (s.phase === "preparing" && !s.projectName && !s.previewUrl && s.agent) return "ai-setup";
  if (s.phase === "needs-figma-signin") return "figma-signin";
  if (s.phase === "conflict") return "conflict";
  if (s.phase === "resolving") return "merge";
  return null;
}

function renderSheets(s: SessionState, force = false): void {
  if (force) shownSheet = "\u0000";
  const kind = phaseSheet(s) ?? userSheet?.kind ?? null;
  const sig = kind === null ? "" : [kind, kind === "settings" ? [s.agent, s.model, s.agentConnected, s.workspace, s.workspaceError, s.updatesEnabled, s.phase, s.activeKey].join("|") : "", kind === "figma-signin" ? Boolean(s.message) : "", kind === "conflict" ? (s.conflictFiles ?? []).join(",") : "", kind === "merge" ? (s.mergeConflicts ?? []).join(",") : "", kind === "sync-replace" ? (userSheet as { count: number }).count : "", kind === "ai-signin" || kind === "ai-setup" ? s.agent : "", kind === "remove" || kind === "rename" ? (userSheet as { key: string }).key : "", kind === "undo" ? (userSheet as { index: number }).index : "", kind === "confirm" ? (userSheet as { action: string }).action : ""].join("#");
  if (sig === shownSheet) return syncPreview();
  shownSheet = sig;
  const previous = dialog;
  dialog = null;
  if (previous) {
    previous.close();
    previous.remove();
  }
  sheetCleanup?.();
  sheetCleanup = null;
  if (kind) {
    sheetClass = "";
    const dlg = buildSheet(kind, s);
    if (sheetClass) dlg.classList.add(sheetClass);
    const isPhase = phaseSheet(s) !== null;
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      if (!isPhase) closeSheet();
      else if (kind === "conflict" || kind === "merge" || kind === "ai-signin" || kind === "ai-setup" || (kind === "figma-signin" && s.message)) void api.cancel();
    });
    if (kind === "add") {
      // The sheet is modal, so the sidebar behind it can't be clicked. A click outside it closes it and, over a project row, opens that project.
      dlg.addEventListener("click", (e) => {
        const r = dlg.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
        closeSheet();
        document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".prow")?.click();
      });
    }
    sheetHost.append(dlg);
    dlg.showModal();
    dialog = dlg;
    (dlg.querySelector("input") ?? dlg.querySelector("button.primary, button.choice, button.btn"))?.focus();
  }
  syncPreview();
}

// ================= palette =================

interface Cmd { label: string; glyph: string; keys?: string[]; off?: boolean; group: string; run: () => void }

function commands(s: SessionState): Cmd[] {
  const list: Cmd[] = [
    { group: "Do", label: "Open project…", glyph: "plus", keys: [`${MOD}N`], run: () => openSheet({ kind: "add" }) },
    { group: "Do", label: "Send to Figma", glyph: "up", off: !(s.phase === "ready" && s.canSend), run: () => openSheet({ kind: "review" }) },
    { group: "Do", label: "Merge Figma's changes into mine", glyph: "refresh", off: s.phase !== "ready", run: () => void api.syncWithFigma("merge") },
    { group: "Do", label: "Discard my changes and use Figma's", glyph: "undo", off: s.phase !== "ready", run: () => askReplace() },
    { group: "Do", label: "New chat", glyph: "compose", off: !(s.phase === "ready" && chatState.messages.length > 0), run: () => void api.newChat() },
    { group: "Do", label: "Toggle sidebar", glyph: "sidebar", keys: [`${MOD}B`], run: () => setSideOpen(!sideOpen) },
    { group: "Do", label: "Toggle side panel", glyph: "panel", keys: [`${MOD}J`], off: !hasChat(s), run: () => setChatOpen(!chatOpen) },
    { group: "Do", label: "Show project files", glyph: "folder", off: !hasChat(s), run: () => { chatOpen = true; store.set("chat.open", "1"); setTab("files", true); layoutChat(); } },
    { group: "Do", label: "Undo last change", glyph: "undo", off: !(s.phase === "ready" && s.canUndo), run: () => void api.undo() },
    { group: "Do", label: "Settings", glyph: "gear", keys: [`${MOD},`], run: () => openSheet({ kind: "settings" }) },
    { group: "Do", label: "Support Sherlabs", glyph: "heart", run: openSupport },
    { group: "Do", label: "Report a problem", glyph: "info", run: reportProblem },
  ];
  for (const p of s.projects) if (p.key !== s.activeKey) list.push({ group: "Projects", label: p.name, glyph: "folder", run: () => switchTo(p.key) });
  return list;
}

function openPalette(): void {
  if (paletteOpen || !state || phaseSheet(state)) return;
  paletteOpen = true;
  let q = "";
  let sel = 0;
  const input = h("input", { type: "text", placeholder: "Type a command…", "aria-label": "Command", autocomplete: "off", spellcheck: "false", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-list" });
  const list = h("div", { class: "list", role: "listbox", id: "pal-list" });
  const dlg = h("dialog", { class: "pal", "aria-label": "Commands" }, h("div", { class: "in" }, icon("search"), input, h("span", { class: "kbd", "aria-hidden": "true" }, "esc")), list, h("div", { class: "ft" }, h("span", {}, h("span", { class: "kbd" }, "↑↓"), " move"), h("span", {}, h("span", { class: "kbd" }, "↵"), " run")));
  const shown = (): Cmd[] => commands(state as SessionState).filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()));
  const draw = (): void => {
    const items = shown();
    sel = Math.min(sel, Math.max(items.length - 1, 0));
    const out: Child[] = [];
    let group = "";
    items.forEach((c, i) => {
      if (c.group !== group) { group = c.group; out.push(h("div", { class: "gh" }, group === "Do" ? "Commands" : group)); }
      out.push(h("button", { type: "button", class: "it", role: "option", "aria-selected": String(i === sel), "aria-disabled": String(Boolean(c.off)), onclick: () => run(c), onmousemove: () => { if (sel !== i) { sel = i; draw(); } } }, icon(c.glyph), h("span", { class: "lbl" }, c.label), c.keys ? h("span", { class: "keys" }, ...c.keys.map((k) => h("span", { class: "kbd" }, k))) : null));
    });
    list.replaceChildren(...nodes(...(out.length ? out : [h("div", { class: "none" }, "Nothing matches that.")])));
  };
  const run = (c: Cmd | undefined): void => {
    if (!c || c.off) return;
    closePalette();
    c.run();
  };
  input.addEventListener("input", () => { q = input.value; sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    const n = shown().length;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(n, 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + n) % Math.max(n, 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown()[sel]); }
  });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closePalette(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closePalette(); });
  sheetHost.append(dlg);
  dlg.showModal();
  draw();
  input.focus();
  syncPreview();
}
function closePalette(): void {
  if (!paletteOpen) return;
  paletteOpen = false;
  for (const d of Array.from(sheetHost.querySelectorAll("dialog.pal"))) { (d as HTMLDialogElement).close(); d.remove(); }
  syncPreview();
}

// ================= chat layout =================

const store = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(`figmake.${key}`); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { window.localStorage.setItem(`figmake.${key}`, value); } catch { /* private mode: layout just isn't remembered */ }
  },
};
let sideOpen = store.get("side.open") !== "0";
function setSideOpen(open: boolean): void {
  sideOpen = open;
  store.set("side.open", open ? "1" : "0");
  paintSide();
}
function paintSide(): void {
  appEl.classList.toggle("fm-side-off", !sideOpen);
  side.toggleAttribute("inert", !sideOpen);
  sideToggle.setAttribute("aria-expanded", String(sideOpen));
  sideToggle.setAttribute("aria-label", sideOpen ? "Hide sidebar" : "Show sidebar");
  sideToggle.title = `${sideOpen ? "Hide" : "Show"} sidebar (${MOD}B)`;
  sideToggle.classList.toggle("on", !sideOpen);
  layoutChat();
}
const MIN_CHAT = 300;
const MAX_CHAT = 640;
const MIN_STAGE = 340;
const compactQuery = window.matchMedia("(max-width: 900px)");
let chatOpen = store.get("chat.open") !== "0";
let chatW = Math.round(Number(store.get("chat.w")) || 400);
let chatH = Math.round(Number(store.get("chat.h")) || 320);

const hasChat = (s: SessionState | null): boolean => Boolean(s && s.phase !== "start" && s.projectName);

function clampChat(): void {
  const box = work.getBoundingClientRect();
  if (compactQuery.matches) chatH = Math.max(200, Math.min(chatH, Math.max(200, box.height - 160)));
  else chatW = Math.max(MIN_CHAT, Math.min(chatW, MAX_CHAT, Math.max(MIN_CHAT, box.width - MIN_STAGE)));
}

function layoutChat(): void {
  const show = hasChat(state) && chatOpen;
  work.classList.toggle("compact", compactQuery.matches);
  work.classList.toggle("chat-off", !show);
  rail.hidden = !show;
  resizer.hidden = !show;
  chatBtn.hidden = !hasChat(state);
  chatBtn.setAttribute("aria-pressed", String(show));
  chatBtn.classList.toggle("on", show);
  clampChat();
  work.style.setProperty("--chat-w", `${chatW}px`);
  work.style.setProperty("--chat-h", `${chatH}px`);
  resizer.setAttribute("aria-orientation", compactQuery.matches ? "horizontal" : "vertical");
  resizer.setAttribute("aria-valuenow", String(compactQuery.matches ? chatH : chatW));
  syncPreview();
}

const savedTab = store.get("rail.tab");
let tab: RailTab = savedTab === "files" || savedTab === "output" ? savedTab : "chat";
const TAB_ORDER: RailTab[] = ["chat", "files", "output"];
const TAB_BTN = (): Record<RailTab, HTMLButtonElement> => ({ chat: tabChat, files: tabFiles, output: tabOutput });

function drawTabs(): void {
  for (const [name, btn] of [["chat", tabChat], ["files", tabFiles], ["output", tabOutput]] as const) {
    btn.setAttribute("aria-selected", String(tab === name));
    btn.tabIndex = tab === name ? 0 : -1;
  }
  tabs.setAttribute("aria-label", "Side panel");
  rail.setAttribute("aria-labelledby", `tab-${tab}`);
  chatPanel.el.hidden = tab !== "chat";
  filesPanel.el.hidden = tab !== "files";
  outputPanel.el.hidden = tab !== "output";
  if (tab === "output" && !rail.hidden) outputPanel.show();
  else outputPanel.hide();
  if (tab === "files" && !rail.hidden) filesPanel.show();
}

function setTab(next: RailTab, focus = false): void {
  tab = next;
  store.set("rail.tab", next);
  drawTabs();
  if (focus) TAB_BTN()[next].focus();
  else if (next === "chat" && chatOpen) chatPanel.focusComposer();
}
tabs.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    {
    const at = TAB_ORDER.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
    setTab(TAB_ORDER[(at + TAB_ORDER.length) % TAB_ORDER.length] ?? "chat", true);
  }
  }
});

function setChatOpen(open: boolean): void {
  if (!hasChat(state)) return;
  chatOpen = open;
  store.set("chat.open", open ? "1" : "0");
  layoutChat();
  if (open && tab === "chat") chatPanel.focusComposer();
}

resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("drag");
  const move = (ev: PointerEvent): void => {
    const box = work.getBoundingClientRect();
    if (compactQuery.matches) chatH = Math.round(box.bottom - ev.clientY);
    else chatW = Math.round(box.right - ev.clientX);
    layoutChat();
  };
  const up = (): void => {
    resizer.classList.remove("drag");
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", up);
    resizer.removeEventListener("pointercancel", up);
    store.set("chat.w", String(chatW));
    store.set("chat.h", String(chatH));
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up);
  resizer.addEventListener("pointercancel", up);
});
resizer.addEventListener("dblclick", () => {
  chatW = 400;
  chatH = 320;
  store.set("chat.w", "400");
  store.set("chat.h", "320");
  layoutChat();
});
resizer.addEventListener("keydown", (e) => {
  const grow = compactQuery.matches ? (e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0) : e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
  if (!grow) return;
  e.preventDefault();
  if (compactQuery.matches) chatH += grow * 24;
  else chatW += grow * 24;
  layoutChat();
  store.set("chat.w", String(chatW));
  store.set("chat.h", String(chatH));
});
compactQuery.addEventListener("change", layoutChat);
window.addEventListener("resize", layoutChat);

// ================= preview slot =================

let previewShown = false;
function syncPreview(): void {
  const s = state;
  const overlay = Boolean(dialog) || paletteOpen || menuOpen;
  previewShown = Boolean(s?.previewUrl) && s?.phase !== "start";
  slot.classList.toggle("paused", overlay && previewShown);
  const r = slot.getBoundingClientRect();
  api.previewRect(previewShown && !overlay && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
}
new ResizeObserver(syncPreview).observe(slot);

// ================= render =================

let lastMessage: string | undefined;
function render(s: SessionState): void {
  const wasBusy = state ? busyNow(state) : false;
  state = s;
  renderSidebar(s);
  renderToolbar(s);
  renderBanner(s);
  renderSendCard(s);
  renderStage(s);
  chatPanel.setSession(s);
  filesPanel.setSession(s);
  outputPanel.setSession(s);
  layoutChat();
  drawTabs();
  renderStatus(s);
  renderSheets(s);
  if (s.message === "Sent to Figma" && lastMessage !== "Sent to Figma") toast("Sent to Figma");
  lastMessage = s.message;
  if (s.phase === "start" && !dialog && !paletteOpen) welcomeInput.focus();
  else if (s.phase === "ready" && wasBusy && !dialog && !paletteOpen && document.activeElement === document.body) chatPanel.focusComposer();
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); closePalette(); setSideOpen(!sideOpen); }
  else if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); closePalette(); setChatOpen(!chatOpen); }
  else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); if (paletteOpen) closePalette(); else openPalette(); }
  else if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); closePalette(); openSheet({ kind: "add" }); }
  else if (mod && e.key === ",") { e.preventDefault(); closePalette(); openSheet({ kind: "settings" }); }
  else if (e.key === "Escape") {
    if (menuOpen) closeMenu();
    else if (!dialog && !paletteOpen && state && ["working", "sending", "preparing"].includes(state.phase)) void api.cancel();
  }
});
api.onCommand((command) => {
  openSheet({ kind: command === "add-project" ? "add" : "settings" });
  if (command === "check-updates") runUpdateCheck();
});
api.onChat((chat) => {
  chatState = chat;
  chatPanel.setChat(chat);
  if (state) { renderBanner(state); updatePip(); }
});
void api.chat().then((chat) => { chatState = chat; chatPanel.setChat(chat); });
function updatePip(): void {
  const pip = chatBtn.querySelector(".pip");
  if (pip) (pip as HTMLElement).hidden = !(chatState.active && !chatOpen);
}
api.onUpdateState((u) => {
  upd = u;
  updateReady = u.phase === "ready";
  paintUpdateRow();
  if (state) renderToolbar(state);
});
void api.updateState().then((u) => {
  upd = u;
  updateReady = u.phase === "ready";
  paintUpdateRow();
  if (state) renderToolbar(state);
});
window.setInterval(() => state && renderStatus(state), 30_000);
paintSide();
api.onState(render);
void api.state().then(render);
