import type { FigmakeApi, ProcessInfo, SessionState } from "../contracts.js";
import { h, icon, nodes } from "./dom.js";
import { copyButton, logView } from "./output.js";

/* The Output tab: the open project's full live log (pull, npm install, the preview server, the AI helper's
   runs), always available. Lines arrive already cleaned by main; everything here is a text node. */

export interface OutputHost {
  api: FigmakeApi;
  mod: string;
  collapse(): void;
}

const STATE_TEXT: Record<ProcessInfo["state"], string> = { starting: "Starting", running: "Running", stopped: "Stopped", failed: "Failed" };
const EMPTY = ["Nothing has run yet. When this project is opened, set up or previewed, what happens shows up here."];

export function createOutputPanel(host: OutputHost): { el: HTMLElement; setSession(s: SessionState): void; show(): void; hide(): void } {
  const { api } = host;
  let lines: readonly string[] = [];
  let all: readonly string[] = [];
  let marker: { len: number; last: string } | null = null;
  let key: string | null = null;
  let shown = false;

  const hideBtn = h("button", { type: "button", class: "btn icon quiet-icon", "aria-label": "Hide panel", title: `Hide panel (${host.mod}J)`, onclick: () => host.collapse() }, icon("panel"));
  const head = h("header", { class: "files-h" }, hideBtn);
  const status = h("div", { class: "ostatus", "aria-label": "What is running" });
  const log = logView("Project output", 600);
  const count = h("span", { class: "ocount" });
  const copy = copyButton(() => lines.join("\n"), (t) => api.copyText(t));
  const clear = h("button", { type: "button", class: "btn sm", "aria-label": "Clear output", onclick: () => { marker = all.length > 0 ? { len: all.length, last: all[all.length - 1] ?? "" } : null; apply(); } }, "Clear");
  const bar = h("div", { class: "obar" }, count, h("span", { class: "grow" }), copy, clear);
  const el = h("aside", { class: "outpanel", "aria-label": "Output", hidden: true }, head, status, log.el, bar);

  function apply(): void {
    lines = marker && all.length >= marker.len && all[marker.len - 1] === marker.last ? all.slice(marker.len) : all;
    if (marker && lines === all) marker = null;
    log.set(lines.length > 0 ? lines : EMPTY);
    log.el.classList.toggle("empty", lines.length === 0);
    count.textContent = lines.length > 0 ? `${lines.length} ${lines.length === 1 ? "line" : "lines"}` : "";
    copy.disabled = clear.disabled = lines.length === 0;
  }

  function drawStatus(list: ProcessInfo[]): void {
    status.hidden = list.length === 0;
    status.replaceChildren(
      ...list.map((p) =>
        h(
          "div",
          { class: "orow", "data-process": p.id },
          h("span", { class: "oname" }, h("strong", {}, `${p.name}: `), STATE_TEXT[p.state]),
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
    /** Called on every redraw while the tab is selected: jumps to the newest line only when the tab first opens. */
    show(): void {
      if (shown) return;
      shown = true;
      log.follow();
    },
    hide(): void {
      shown = false;
    },
    setSession(s: SessionState): void {
      if (s.activeKey !== key) {
        key = s.activeKey;
        marker = null;
      }
      all = s.activity?.lines ?? [];
      apply();
      drawStatus(s.processes ?? []);
    },
  };
}
