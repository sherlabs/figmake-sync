import { h } from "./dom.js";

/* Small pieces for showing command output calmly: a short live tail, a scrollable log that follows the
   newest line unless the person scrolled up, and the m:ss clock. Text nodes only, never markup. */

export const SLOW_AFTER_MS = 30_000;
export const VERY_SLOW_AFTER_MS = 120_000;
export const SLOW_HINT = "This is taking longer than usual on this computer. It's still working. You can keep this window open.";
export const DISK_HINT = "Slow disk? Freeing space can help.";

/** 65_000 -> "1:05". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The gentle lines for a step that has run this long (empty before 30 s). */
export function slowHints(ms: number): string[] {
  if (ms < SLOW_AFTER_MS) return [];
  return ms >= VERY_SLOW_AFTER_MS ? [SLOW_HINT, DISK_HINT] : [SLOW_HINT];
}

export interface TailView {
  el: HTMLElement;
  set(lines: readonly string[]): void;
}

/** The last few lines, one per row, cut off with an ellipsis instead of wrapping. */
export function tailView(count: number, label: string): TailView {
  const el = h("div", { class: "tail", role: "log", "aria-live": "off", "aria-label": label });
  let last = "";
  return {
    el,
    set(lines): void {
      const shown = lines.slice(-count);
      const key = shown.join("\n");
      if (key === last) return;
      last = key;
      el.replaceChildren(...(shown.length > 0 ? shown.map((line) => h("div", { class: "tl" }, line)) : [h("div", { class: "tl dim" }, "Waiting for the first lines…")]));
    },
  };
}

export interface LogView {
  el: HTMLElement;
  set(lines: readonly string[]): void;
  /** Jump to the newest line (used right after the log is shown). */
  follow(): void;
}

/** A scrollable log that sticks to the bottom until the person scrolls up, and sticks again when they return. */
export function logView(label: string, maxLines = 400): LogView {
  const el = h("pre", { class: "logfull", tabindex: "0", role: "log", "aria-live": "off", "aria-label": label });
  let stick = true;
  let last = "";
  el.addEventListener("scroll", () => {
    stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 6;
  });
  const follow = (): void => {
    stick = true;
    el.scrollTop = el.scrollHeight;
  };
  return {
    el,
    follow,
    set(lines): void {
      const text = lines.slice(-maxLines).join("\n");
      if (text === last) return;
      last = text;
      const top = el.scrollTop;
      el.textContent = text;
      el.scrollTop = stick ? el.scrollHeight : top;
    },
  };
}

/** "Copy" that says "Copied" for a moment. */
export function copyButton(getText: () => string, copy: (text: string) => Promise<void> | void, label = "Copy"): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn sm", "aria-label": `${label} output` }, label);
  let timer = 0;
  btn.addEventListener("click", () => {
    void Promise.resolve(copy(getText())).then(() => {
      btn.textContent = "Copied";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (btn.textContent = label), 1500);
    });
  });
  return btn;
}
