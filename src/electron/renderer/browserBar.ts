import { computeViewport, DEFAULT_VIEWPORT, parseViewport, tabLabel, VIEWPORT_MODES, VIEWPORT_WIDTH, type BrowserState, type BrowserTab, type ViewportMode } from "../../app/browser.js";
import type { FigmakeApi } from "../contracts.js";
import { h, icon } from "./dom.js";

/* The browser bar above the preview: tabs, back/forward/reload, address, and the "can't reach this page" pane. */

const VIEWPORT_KEY = "figmake.pv.viewport";
const readViewport = (): ViewportMode => {
  try { return parseViewport(window.localStorage.getItem(VIEWPORT_KEY)); } catch { return DEFAULT_VIEWPORT; }
};

const REJECTED = "Only pages on this computer can be opened here.";

export interface BrowserBar {
  /** Holds the bar and the page area; `slot` is where the native preview view sits. */
  shell: HTMLElement;
}

export function createBrowserBar(api: FigmakeApi, slot: HTMLElement): BrowserBar {
  let state: BrowserState = { tabs: [], activeId: 1 };
  let noteTimer = 0;

  const tabsEl = h("div", { class: "pv-tabs", role: "tablist", "aria-label": "Tabs" });
  const plus = h("button", { type: "button", class: "pv-plus", "aria-label": "New tab", title: "New tab", onclick: () => void api.browserNewTab() }, icon("plus", true));
  const strip = h("div", { class: "pv-strip" }, tabsEl, plus);

  const back = h("button", { type: "button", class: "pv-btn", "aria-label": "Back", title: "Back", onclick: () => void api.browserDo("back") }, icon("back"));
  const fwd = h("button", { type: "button", class: "pv-btn", "aria-label": "Forward", title: "Forward", onclick: () => void api.browserDo("forward") }, icon("fwd"));
  const reload = h("button", { type: "button", class: "pv-btn", "aria-label": "Reload", title: "Reload", onclick: () => void api.browserDo(active()?.loading ? "stop" : "reload") }, icon("refresh"));
  const external = h("button", { type: "button", class: "pv-btn", "aria-label": "Open in browser", title: "Open in browser", onclick: () => void api.browserDo("external") }, icon("ext"));
  /* "Select element": click a part of the page to tell the AI about it. Off by default; Esc turns it off. */
  let picking = false;
  const pick = h("button", { type: "button", class: "pv-btn pv-pick", "aria-label": "Select element", "aria-pressed": "false", title: "Select element: click a part of the page to tell the AI about it (Esc to stop)", onclick: () => void api.pickElement(!picking).then(setPicking, () => setPicking(false)) }, icon("target"));
  const address = h("input", { class: "pv-address", type: "text", "aria-label": "Address", spellcheck: "false", autocomplete: "off", autocapitalize: "off" });
  const note = h("div", { class: "pv-note", role: "status", hidden: true });
  const field = h("form", { class: "pv-field", onsubmit: (e: Event) => { e.preventDefault(); void submit(); } }, address);
  /* How wide pages are laid out (a native <select>, so its list opens above the native preview view). */
  let viewport = readViewport();
  const vpSelect = h("select", { class: "pv-vp", "aria-label": "Preview width", title: "Preview width: pages are laid out at this width and scaled to fit" }, ...VIEWPORT_MODES.map((m) => h("option", { value: m }, VIEWPORT_WIDTH[m].label)));
  vpSelect.value = viewport;
  const vpWrap = h("span", { class: "pv-vpw" }, icon("laptop", true), vpSelect, icon("chev-d", true));
  const frame = h("div", { class: "pv-frame", "aria-hidden": "true", hidden: true });
  slot.prepend(frame);
  const bar = h("div", { class: "pv-bar" }, back, fwd, reload, field, pick, vpWrap, external, note);
  const progress = h("div", { class: "pv-progress", "aria-hidden": "true" }, h("i", {}));

  const failTitle = h("h3", {}, "This page can't be reached");
  const failText = h("p", {});
  const retry = h("button", { type: "button", class: "btn primary", onclick: () => void api.browserDo("retry") }, "Retry");
  const fail = h("div", { class: "pv-fail", role: "status", hidden: true }, h("span", { class: "ico" }, icon("warn")), failTitle, failText, retry);
  slot.append(fail);

  const shell = h("div", { class: "pv-shell", hidden: true }, strip, bar, progress, slot);

  const active = (): BrowserTab | undefined => state.tabs.find((t) => t.id === state.activeId);

  function say(text: string): void {
    note.textContent = text;
    note.hidden = !text;
    address.classList.toggle("pv-bad", Boolean(text));
    window.clearTimeout(noteTimer);
    if (text) noteTimer = window.setTimeout(() => say(""), 4000);
  }

  async function submit(): Promise<void> {
    const ok = await api.browserGo(address.value);
    if (ok) {
      say("");
      address.blur();
    } else {
      say(REJECTED);
    }
  }

  function setPicking(on: boolean): void {
    picking = on;
    pick.setAttribute("aria-pressed", String(on));
    pick.classList.toggle("on", on);
  }
  api.onPickState((st) => {
    setPicking(st.active);
    if (st.message) say(st.message);
  });
  // While picking, Esc only ends picking (it must not also stop the AI). Capture phase, so it runs first.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !picking) return;
    e.stopPropagation();
    e.preventDefault();
    void api.pickElement(false);
    setPicking(false);
  }, true);

  address.addEventListener("input", () => note.hidden || say(""));
  address.addEventListener("focus", () => address.select());
  address.addEventListener("blur", () => {
    say("");
    address.value = active()?.url ?? "";
  });
  address.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      address.value = active()?.url ?? "";
      address.blur();
    }
  });

  function renderTabs(): void {
    tabsEl.replaceChildren(
      ...state.tabs.map((t) => {
        const on = t.id === state.activeId;
        const label = t.id === 1 && !t.title.trim() ? "Preview" : tabLabel(t);
        const close =
          t.id === 1
            ? null
            : h("button", { type: "button", class: "pv-close", "aria-label": `Close ${label}`, title: "Close tab", tabindex: "-1", onclick: (e: Event) => { e.stopPropagation(); void api.browserClose(t.id); } }, icon("x", true));
        return h(
          "div",
          { class: `pv-tab${on ? " on" : ""}${t.loading ? " busy" : ""}`, role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", title: label, onclick: () => void api.browserSwitch(t.id), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void api.browserSwitch(t.id); } } },
          h("span", { class: "pv-tab-dot", "aria-hidden": "true" }),
          h("span", { class: "pv-tab-name" }, label),
          close,
        );
      }),
    );
  }

  function render(next: BrowserState): void {
    state = next;
    const tab = active();
    renderTabs();
    back.disabled = !tab?.canGoBack;
    fwd.disabled = !tab?.canGoForward;
    external.disabled = !tab;
    pick.disabled = !tab || Boolean(tab.failed);
    const loading = Boolean(tab?.loading);
    reload.replaceChildren(icon(loading ? "x" : "refresh"));
    reload.setAttribute("aria-label", loading ? "Stop" : "Reload");
    reload.title = loading ? "Stop" : "Reload";
    progress.classList.toggle("on", loading);
    if (document.activeElement !== address) address.value = tab?.url ?? "";
    const failed = Boolean(tab?.failed);
    fail.hidden = !failed;
    if (tab && failed) {
      let host = tab.url;
      try {
        host = new URL(tab.url).host;
      } catch {
        /* keep the raw address */
      }
      failText.textContent = `Nothing is answering at ${host}. It may still be starting.`;
    }
  }

  /** The subtle frame behind a phone/tablet-sized page that is narrower than the pane (the native view itself sits on top of it). */
  function drawFrame(): void {
    const lay = computeViewport(viewport, slot.clientWidth, slot.clientHeight);
    const device = !VIEWPORT_WIDTH[viewport].fill;
    slot.classList.toggle("pv-device", device);
    frame.hidden = !(device && lay && lay.offsetX > 0);
    if (lay && !frame.hidden) {
      frame.style.left = `${lay.offsetX}px`;
      frame.style.width = `${lay.width}px`;
    }
  }
  function setViewport(next: ViewportMode, remember: boolean): void {
    viewport = next;
    vpSelect.value = next;
    if (remember) {
      try { window.localStorage.setItem(VIEWPORT_KEY, next); } catch { /* not remembered */ }
    }
    drawFrame();
    void api.browserViewport(next);
  }
  vpSelect.addEventListener("change", () => setViewport(parseViewport(vpSelect.value), true));
  new ResizeObserver(drawFrame).observe(slot);
  setViewport(viewport, false);

  render(state);
  void api.browser().then(render);
  api.onBrowser(render);
  return { shell };
}
