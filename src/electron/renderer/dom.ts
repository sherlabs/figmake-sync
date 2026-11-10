export type Child = Node | string | false | null | undefined;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Tiny hyperscript helper. Builds nodes only: text is always a text node, never parsed as markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
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

/** Drops the empty children, leaving only what can be appended. */
export const nodes = (...kids: Child[]): (Node | string)[] => kids.filter((kid): kid is Node | string => Boolean(kid));

/** An icon from the sprite in index.html. `s` draws it at 14px. */
export function icon(name: string, small = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", small ? "i s" : "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/** "just now", "2 min ago", "3 hours ago", "yesterday", or a short date. */
export function ago(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Splits "src/pages/Cart.tsx" into its folder (with trailing slash) and file name. */
export function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}
