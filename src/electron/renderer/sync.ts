import type { FigmakeApi } from "../contracts.js";
import { h, icon, splitPath } from "./dom.js";
import { createDiff, type DiffHandle } from "./monaco.js";

/* The "Pick the version to keep" sheet for files Figma and this Mac both changed. All class names start with sy-. */

export interface MergeView {
  body: HTMLElement;
  /** One choice per file, in list order. */
  choices(): Array<{ path: string; choice: "mine" | "figma" }>;
  dispose(): void;
}

const NOTE: Record<string, string> = {
  binary: "This file isn't text, so there's nothing to compare.",
  large: "This file is too large to compare here.",
  missing: "The two versions couldn't be shown.",
};

export function createMergeView(api: FigmakeApi, paths: string[]): MergeView {
  const picked = new Map<string, "mine" | "figma">(paths.map((p) => [p, "mine"]));
  const handles = new Set<DiffHandle>();
  let disposed = false;

  const rows = paths.map((path) => {
    const { dir, name } = splitPath(path);
    let handle: DiffHandle | null = null;
    const mine = h("button", { type: "button", class: "sy-opt", "aria-pressed": "true" }, "Keep mine");
    const figma = h("button", { type: "button", class: "sy-opt", "aria-pressed": "false" }, "Use Figma's");
    const choose = (value: "mine" | "figma"): void => {
      picked.set(path, value);
      mine.setAttribute("aria-pressed", String(value === "mine"));
      figma.setAttribute("aria-pressed", String(value === "figma"));
    };
    mine.addEventListener("click", () => choose("mine"));
    figma.addEventListener("click", () => choose("figma"));
    const host = h("div", { class: "sy-editor" });
    const heads = h("div", { class: "sy-heads" }, h("span", {}, "Figma's"), h("span", {}, "Yours"));
    const panel = h("div", { class: "sy-diff", hidden: true }, heads, host);
    const more = h("button", { type: "button", class: "btn icon quiet-icon sy-more", "aria-expanded": "false", "aria-label": `Compare ${path}` }, icon("chev-r", true));
    more.addEventListener("click", () => {
      const show = panel.hidden;
      panel.hidden = !show;
      more.setAttribute("aria-expanded", String(show));
      more.replaceChildren(icon(show ? "chev-d" : "chev-r", true));
      if (!show) {
        if (handle) {
          handles.delete(handle);
          handle.dispose();
          handle = null;
        }
        return;
      }
      host.replaceChildren(h("p", { class: "sy-note" }, "Loading…"));
      void api.mergeDiff(path).catch(() => ({ kind: "missing" }) as const).then((diff) => {
        if (disposed || panel.hidden) return;
        heads.hidden = diff.kind !== "text";
        if (diff.kind !== "text") return host.replaceChildren(h("p", { class: "sy-note" }, NOTE[diff.kind] ?? ""));
        host.replaceChildren();
        handle = createDiff(host, { path, before: diff.before, after: diff.after });
        handle.setInline(false);
        handles.add(handle);
      });
    });
    const row = h(
      "div",
      { class: "sy-row" },
      h("span", { class: "sy-path", title: path }, h("span", { class: "sy-name" }, name), dir ? h("span", { class: "sy-dir" }, dir) : null),
      h("span", { class: "sy-seg", role: "group", "aria-label": `Version to keep for ${path}` }, mine, figma),
      more,
    );
    return h("div", { class: "sy-item" }, row, panel);
  });

  return {
    body: h("div", { class: "sy-wrap" }, h("div", { class: "sy-list" }, ...rows)),
    choices: () => paths.map((path) => ({ path, choice: picked.get(path) ?? "mine" })),
    dispose(): void {
      disposed = true;
      for (const handle of handles) handle.dispose();
      handles.clear();
    },
  };
}
