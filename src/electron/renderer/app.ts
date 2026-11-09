import type { AgentChoice, Phase, SessionState } from "../contracts.js";

type Child = Node | string | false | null | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className = String(value as string);
    else el.setAttribute(key, value === true ? "" : String(value as string));
  }
  el.append(...kids.filter((kid): kid is Node | string => Boolean(kid)));
  return el;
}

const api = window.figmake;
const WORKING: Partial<Record<Phase, string>> = { connecting: "Connecting", preparing: "Preparing", working: "Working", sending: "Sending" };
const AGENTS: [AgentChoice, string][] = [["claude", "Claude"], ["codex", "ChatGPT"]];

let state: SessionState | null = null;
let view: "main" | "settings" | "start" = "main";
let expanded = false;

function gearIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM6.8 1.5h2.4l.4 1.7 1.2.5 1.5-.9 1.7 1.7-.9 1.5.5 1.2 1.7.4v2.4l-1.7.4-.5 1.2.9 1.5-1.7 1.7-1.5-.9-1.2.5-.4 1.7H6.8l-.4-1.7-1.2-.5-1.5.9-1.7-1.7.9-1.5-.5-1.2-1.7-.4V6.8l1.7-.4.5-1.2-.9-1.5 1.7-1.7 1.5.9 1.2-.5z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

const show = (v: "main" | "settings" | "start"): void => {
  view = v;
  if (state) render(state);
};

// ---- Start ----
const link = h("input", { type: "text", placeholder: "Figma Make link", "aria-label": "Figma Make link", spellcheck: "false", autocomplete: "off" });
const open = h("button", { class: "primary", disabled: true, onclick: () => submitLink() }, "Open");
const startScreen = h("main", { class: "screen start" }, h("div", { class: "drag" }), h("div", { class: "row" }, h("div", { class: "field" }, link), open));
link.addEventListener("input", () => (open.disabled = !link.value.trim()));
link.addEventListener("keydown", (e) => e.key === "Enter" && submitLink());
function submitLink(): void {
  const value = link.value.trim();
  if (!value) return;
  link.value = "";
  open.disabled = true;
  view = "main";
  void api.openProject(value);
}

// ---- Project ----
const name = h("span", { class: "name" });
const undo = h("button", { class: "link", onclick: () => api.undo() }, "Undo");
const send = h("button", { class: "primary", onclick: () => api.send() }, "Send to Figma");
const update = h("button", { class: "link", hidden: true, onclick: () => api.installUpdate() }, "Restart to update");
const gear = h("button", { class: "icon", "aria-label": "Settings", onclick: () => show("settings") }, gearIcon());
const slot = h("div", { class: "slot" });
const center = h("div", { class: "center" });
const stage = h("div", { class: "stage" }, slot, center);

const changesBtn = h("button", { "aria-expanded": "false", onclick: () => ((expanded = !expanded), render(state as SessionState)) });
const changesList = h("ul");
const changes = h("div", { class: "changes" }, changesBtn, changesList);
const prompt = h("input", { type: "text", placeholder: "Describe a change", "aria-label": "Describe a change", spellcheck: "true", autocomplete: "off" });
prompt.addEventListener("keydown", (e) => {
  const text = prompt.value.trim();
  if (e.key !== "Enter" || e.isComposing || !text) return;
  prompt.value = "";
  void api.ask(text);
});
const stateText = h("span", { class: "state", role: "status" });
const stop = h("button", { class: "link", onclick: () => api.cancel() }, "Stop");
const choice = h("div", { class: "choice" }, ...AGENTS.map(([id, label]) => h("button", { onclick: () => api.setAgent(id) }, label)));
const retry = h("button", { class: "link", onclick: () => api.retry() }, "Try again");
const report = (): HTMLButtonElement => h("button", { class: "link", onclick: () => state && void api.reportIssue({ errorCode: state.code ?? "unknown", message: state.message ?? "", phase: state.failedIn ?? "error" }) }, "Report");
const reportBar = report();
const bar = h("div", { class: "field" }, prompt, stateText, choice, stop, retry, reportBar);

const dock = h("footer", { class: "dock" }, changes, bar);

const sheet = h(
  "div",
  { class: "scrim", role: "dialog", "aria-modal": "true", "aria-label": "Figma has newer changes." },
  h(
    "div",
    { class: "sheet" },
    h("p", {}, "Figma has newer changes."),
    h("div", { class: "buttons" }, h("button", { class: "plain", onclick: () => api.send("mine") }, "Keep mine"), h("button", { class: "plain", onclick: () => api.send("figma") }, "Use Figma's")),
  ),
);
const projectScreen = h("main", { class: "screen project" }, h("header", { class: "bar" }, name, undo, h("span", { class: "grow" }), update, send, gear), stage, dock);

// ---- Settings ----
const agentButtons = AGENTS.map(([id, label]) => h("button", { "aria-pressed": "false", onclick: () => api.setAgent(id) }, label));
const workspaceName = h("span");
const workspaceError = h("span", { class: "bad", role: "alert" });
const settingsScreen = h(
  "main",
  { class: "screen settings" },
  h("header", { class: "bar" }, h("span", { class: "title" }, "Settings"), h("button", { class: "link", onclick: () => show("main") }, "Done")),
  h(
    "div",
    { class: "rows" },
    h("div", { class: "row" }, h("span", {}, "AI"), h("div", { class: "seg" }, ...agentButtons)),
    h("div", { class: "row" }, h("span", {}, "Workspace"), h("div", { class: "value" }, workspaceError, workspaceName, h("button", { class: "plain", onclick: () => api.chooseWorkspace() }, "Change"))),
    h("div", { class: "row" }, h("button", { class: "link", onclick: () => api.signOutFigma() }, "Sign out of Figma")),
  ),
);

document.getElementById("app")?.append(startScreen, projectScreen, settingsScreen, sheet);
let updateReady = false;
api.onUpdateState((u) => {
  updateReady = u.phase === "ready";
  if (state) render(state);
});

function reportPreview(visible: boolean): void {
  const r = slot.getBoundingClientRect();
  api.previewRect(visible && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
}
let previewVisible = false;
new ResizeObserver(() => reportPreview(previewVisible)).observe(slot);

function centerContent(s: SessionState): Child[] {
  if (s.phase === "needs-figma-signin") return [h("button", { class: "primary", onclick: () => api.retry() }, "Sign in to Figma")];
  if (s.phase === "error") return [h("span", { class: "msg", role: "alert" }, s.message), h("span", { class: "actions" }, h("button", { class: "link", onclick: () => api.retry() }, "Try again"), report())];
  return [h("span", { role: "status" }, s.message ?? WORKING[s.phase] ?? ""), h("button", { class: "link", onclick: () => api.cancel() }, "Stop")];
}

function render(s: SessionState): void {
  state = s;
  const onStart = view === "start" || s.phase === "start";
  const onSettings = !onStart && view === "settings";
  startScreen.hidden = !onStart;
  settingsScreen.hidden = !onSettings;
  projectScreen.hidden = onStart || onSettings;

  const ready = s.phase === "ready";
  const hasPreview = Boolean(s.previewUrl);
  name.textContent = s.projectName ?? "";
  undo.hidden = !(ready && s.canUndo);
  send.disabled = !(ready && s.canSend);
  center.hidden = hasPreview;
  if (!hasPreview) center.replaceChildren(...(centerContent(s).filter(Boolean) as Node[]));
  dock.hidden = !hasPreview;

  const last = s.changes.at(-1);
  changes.hidden = !(ready && (last || s.message));
  changesBtn.textContent = last ?? s.message ?? "";
  changesBtn.disabled = !last;
  changesBtn.setAttribute("aria-expanded", String(expanded && Boolean(last)));
  changesList.hidden = !(expanded && s.changes.length > 1);
  changesList.replaceChildren(...s.changes.slice(0, -1).reverse().map((c) => h("li", {}, c)));

  const asking = ready || s.phase === "conflict";
  prompt.hidden = !asking;
  choice.hidden = s.phase !== "needs-ai-choice";
  retry.hidden = s.phase !== "error";
  reportBar.hidden = s.phase !== "error";
  update.hidden = !updateReady;
  stop.hidden = !["preparing", "working", "sending", "needs-ai-signin"].includes(s.phase);
  stateText.hidden = asking || s.phase === "needs-ai-choice";
  stateText.className = s.phase === "error" ? "state bad" : "state";
  stateText.textContent = s.phase === "error" ? (s.message ?? "") : (s.message ?? WORKING[s.phase] ?? "");

  agentButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(AGENTS[i]?.[0] === s.agent)));
  workspaceName.textContent = s.workspace;
  workspaceError.textContent = s.workspaceError ?? "";
  workspaceError.hidden = !s.workspaceError;

  sheet.hidden = s.phase !== "conflict";
  previewVisible = hasPreview && !onStart && !onSettings && s.phase !== "conflict";
  reportPreview(previewVisible);
  if (s.phase === "conflict") sheet.querySelector("button")?.focus();
  else if (!projectScreen.hidden && !prompt.hidden && document.activeElement === document.body) prompt.focus();
  if (onStart) link.focus();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (view !== "main" && state && state.phase !== "start") show("main");
  else void api.cancel();
});
api.onCommand((command) => show(command === "settings" ? (view === "settings" ? "main" : "settings") : "start"));
api.onState(render);
void api.state().then(render);
