import { MODEL_OPTIONS, modelLabel, modelProblem } from "../../app/modelIds.js";
import type { AgentChoice, Phase } from "../contracts.js";
import { h, icon } from "./dom.js";

/* The model choice for the current AI: the menu under the chat box, and the typed-name form that Settings shares.
   Only plain text nodes; a typed name is checked here for a friendly message, and again in main before it is ever used. */

const WORKING: readonly Phase[] = ["connecting", "preparing", "working", "sending", "conflict", "syncing", "resolving"];

/** The model can't change while the AI (or anything else) is running; the change would apply from the next message. */
export const modelLocked = (phase: Phase, chatActive: boolean): boolean => chatActive || WORKING.includes(phase);

/** "Claude · Sonnet" when a model is chosen, otherwise just the name. */
export const chipText = (name: string, agent: AgentChoice, model: string | null): string => (model === null ? name : `${name} · ${modelLabel(agent, model)}`);

/** True when the model is a typed name rather than one of the listed choices. */
export const isCustomModel = (agent: AgentChoice, model: string | null): boolean => model !== null && !MODEL_OPTIONS[agent].some((o) => o.id === model);

export interface ModelFormOptions {
  initial?: string;
  /** Called with the trimmed, valid name. */
  onApply(model: string): void;
  onCancel(): void;
}

/** A tiny "type a model name" form with its own validation message. */
export function modelForm(o: ModelFormOptions): { el: HTMLElement; focus(): void } {
  const err = h("p", { class: "merr", id: "model-err", role: "alert", hidden: true });
  const input = h("input", { class: "field", type: "text", maxlength: "64", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "Model name", "aria-describedby": "model-err", placeholder: "Model name", value: o.initial ?? "" });
  const apply = (): void => {
    const problem = modelProblem(input.value);
    err.hidden = problem === null;
    err.textContent = problem ?? "";
    input.setAttribute("aria-invalid", problem === null ? "false" : "true");
    if (problem === null) o.onApply(input.value.trim());
    else input.focus();
  };
  input.addEventListener("input", () => {
    err.hidden = true;
    input.setAttribute("aria-invalid", "false");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      apply();
    }
  });
  const el = h(
    "div",
    { class: "mform" },
    h("label", { class: "mh", for: "model-input" }, "Model name"),
    input,
    h("p", { class: "mhint" }, "Exactly as your AI lists it."),
    err,
    h("div", { class: "mbtns" }, h("button", { type: "button", class: "btn sm", onclick: () => o.onCancel() }, "Cancel"), h("button", { type: "button", class: "btn primary sm", onclick: apply }, "Use model")),
  );
  input.id = "model-input";
  return { el, focus: () => input.focus() };
}

export interface ModelMenuOptions {
  agent: AgentChoice;
  agentName: string;
  model: string | null;
  locked: boolean;
  /** null = the AI's own default. */
  onPick(model: string | null): void;
  onSwitchAI(): void;
  onClose(): void;
}

/** The menu: model choices (current one checked), "Other…", and "Switch AI…". The caller places it and handles Esc and outside clicks. */
export function buildModelMenu(o: ModelMenuOptions): { el: HTMLElement; focus(): void } {
  const menu = h("div", { class: "menu model-menu", role: "menu", "aria-label": `${o.agentName} model` });
  const custom = isCustomModel(o.agent, o.model);
  const mark = (on: boolean): Node => (on ? icon("check", true) : h("span", { class: "nomark", "aria-hidden": "true" }));
  const item = (label: string, checked: boolean, run: () => void, extra?: string): HTMLButtonElement =>
    h("button", { type: "button", role: "menuitemradio", "aria-checked": String(checked), disabled: o.locked, onclick: run }, mark(checked), h("span", { class: "ml" }, label), extra ? h("span", { class: "mx" }, extra) : null);

  const list = (): void => {
    const rows = MODEL_OPTIONS[o.agent].map((opt) => item(opt.label, opt.id === o.model, () => o.onPick(opt.id)));
    const other = item("Other…", custom, showForm, custom ? (o.model ?? "") : undefined);
    const swap = h("button", { type: "button", role: "menuitem", disabled: o.locked, onclick: () => o.onSwitchAI() }, h("span", { class: "nomark", "aria-hidden": "true" }), "Switch AI…");
    menu.replaceChildren(h("div", { class: "mh", role: "presentation" }, `${o.agentName} model`), ...rows, other, h("div", { class: "sep", role: "separator" }), swap);
  };
  const focusList = (): void => (menu.querySelector<HTMLElement>('button[aria-checked="true"]:not(:disabled)') ?? menu.querySelector<HTMLElement>("button:not(:disabled)") ?? menu).focus();
  function showForm(): void {
    const form = modelForm({ ...(custom && o.model ? { initial: o.model } : {}), onApply: (m) => o.onPick(m), onCancel: () => {
      list();
      focusList();
    } });
    menu.replaceChildren(form.el);
    form.focus();
  }
  menu.addEventListener("keydown", (e) => {
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (e.target instanceof HTMLInputElement || buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" ? (at + 1) % buttons.length : e.key === "ArrowUp" ? (at <= 0 ? buttons.length - 1 : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    buttons[to]?.focus();
  });
  list();
  return { el: menu, focus: focusList };
}
