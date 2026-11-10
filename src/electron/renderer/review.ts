import type { FigmakeApi, ReviewItem } from "../contracts.js";
import { h, icon, plural, splitPath } from "./dom.js";
import { createDiff, type DiffHandle } from "./monaco.js";

/* The pieces of the "Review before sending" sheet and the "Files not sent" list.
   Draws what main sends; every path goes back to main, which re-checks it. All class names start with rv-. */

export interface ReviewView {
  body: HTMLElement;
  /** Called with the number of files that will be sent, whenever it changes. */
  onCount(listener: (count: number) => void): void;
  /** Releases the open diff editors. */
  dispose(): void;
}

const WORD: Record<ReviewItem["status"], string> = { added: "Added", modified: "Changed", deleted: "Removed", renamed: "Renamed" };
const NOTE: Record<string, string> = {
  binary: "This file isn't text, so there's nothing to compare.",
  large: "This file is too large to compare here.",
  missing: "The changes for this file couldn't be shown.",
};

export function createReview(api: FigmakeApi): ReviewView {
  const body = h("div", { class: "rv-wrap" }, h("p", { class: "rv-note" }, "Loading…"));
  const handles = new Set<DiffHandle>();
  let count = (): number => 0;
  let listener: (n: number) => void = () => undefined;
  let disposed = false;

  function build(items: ReviewItem[]): void {
    const checked = new Map(items.map((i) => [i.path, !i.ignored]));
    const total = (): number => [...checked.values()].filter(Boolean).length;
    count = total;
    if (items.length === 0) {
      body.replaceChildren(h("p", { class: "rv-note" }, "There's nothing to send."));
      return listener(0);
    }
    const rows = items.map((item) => {
      const { dir, name } = splitPath(item.path);
      let handle: DiffHandle | null = null;
      let inline = true;
      const box = h("input", { type: "checkbox", class: "rv-check", "aria-label": `Send ${item.path}` });
      box.checked = checked.get(item.path) === true;
      const host = h("div", { class: "rv-editor" });
      const toggle = h("button", { type: "button", class: "plain quiet rv-mode", onclick: () => { inline = !inline; toggle.textContent = inline ? "Side by side" : "Inline"; handle?.setInline(inline); } }, "Side by side");
      const panel = h("div", { class: "rv-diff", hidden: true }, h("div", { class: "rv-bar" }, toggle), host);
      const more = h("button", { type: "button", class: "btn icon quiet-icon rv-more", "aria-expanded": "false", "aria-label": `Show changes in ${item.path}` }, icon("chev-r", true));
      const open = async (): Promise<void> => {
        const shown = panel.hidden;
        panel.hidden = !shown;
        more.setAttribute("aria-expanded", String(shown));
        more.replaceChildren(icon(shown ? "chev-d" : "chev-r", true));
        if (!shown) {
          if (handle) {
            handles.delete(handle);
            handle.dispose();
            handle = null;
          }
          return;
        }
        host.replaceChildren(h("p", { class: "rv-note" }, "Loading…"));
        const diff = await api.reviewDiff(item.path).catch(() => ({ kind: "missing" }) as const);
        if (disposed || panel.hidden) return;
        if (diff.kind !== "text") return host.replaceChildren(h("p", { class: "rv-note" }, NOTE[diff.kind] ?? ""));
        host.replaceChildren();
        handle = createDiff(host, { path: item.path, before: diff.before, after: diff.after });
        handle.setInline(inline);
        handles.add(handle);
      };
      more.addEventListener("click", () => void open());
      box.addEventListener("change", () => {
        checked.set(item.path, box.checked);
        row.classList.toggle("rv-off", !box.checked);
        listener(total());
        void api.setFileIgnored(item.path, !box.checked);
      });
      const text = item.status === "renamed" && item.from ? `${splitPath(item.from).name} → ${name}` : name;
      const row = h(
        "div",
        { class: `rv-row${box.checked ? "" : " rv-off"}` },
        box,
        h("span", { class: `rv-badge rv-${item.status}` }, WORD[item.status]),
        h("span", { class: "rv-path", title: item.path }, h("span", { class: "rv-name" }, text), dir ? h("span", { class: "rv-dir" }, dir) : null),
        h("span", { class: "rv-counts" }, item.added > 0 ? h("b", { class: "rv-plus" }, `+${item.added}`) : null, item.removed > 0 ? h("b", { class: "rv-minus" }, `−${item.removed}`) : null),
        more,
      );
      return h("div", { class: "rv-item" }, row, panel);
    });
    body.replaceChildren(h("div", { class: "rv-list" }, ...rows));
    listener(total());
  }

  void api.reviewChanges().catch(() => [] as ReviewItem[]).then((items) => {
    if (!disposed) build(items);
  });

  return {
    body,
    onCount(fn): void {
      listener = fn;
      fn(count());
    },
    dispose(): void {
      disposed = true;
      for (const handle of handles) handle.dispose();
      handles.clear();
    },
  };
}

/** The list behind Settings > Files not sent: each file with a "Send again" button. */
export function createIgnoredList(api: FigmakeApi): HTMLElement {
  const wrap = h("div", { class: "rv-wrap" }, h("p", { class: "rv-note" }, "Loading…"));
  const draw = (paths: string[]): void => {
    if (paths.length === 0) return wrap.replaceChildren(h("p", { class: "rv-note" }, "Every file is being sent."));
    wrap.replaceChildren(
      h(
        "div",
        { class: "rv-list" },
        ...paths.map((p) => {
          const { dir, name } = splitPath(p);
          const row = h(
            "div",
            { class: "rv-row" },
            h("span", { class: "rv-path", title: p }, h("span", { class: "rv-name" }, name), dir ? h("span", { class: "rv-dir" }, dir) : null),
            h("button", { type: "button", class: "btn sm", "aria-label": `Send ${p} again`, onclick: () => { row.remove(); void api.setFileIgnored(p, false).then(draw); } }, "Send again"),
          );
          return h("div", { class: "rv-item" }, row);
        }),
      ),
    );
  };
  void api.ignoredFiles().catch(() => [] as string[]).then(draw);
  return wrap;
}

export const filesNotSentText = (n: number): string => (n === 0 ? "None" : plural(n, "file"));
