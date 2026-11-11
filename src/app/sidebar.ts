/* Pure sizing rules for the projects sidebar: an expanded column the person can drag, or a narrow rail. */

export const SIDE_MIN = 200;
export const SIDE_MAX = 360;
export const SIDE_DEFAULT = 228;
export const SIDE_RAIL = 52;
/** Dragging the edge narrower than this collapses to the rail; dragging a rail wider than this expands it. */
export const SIDE_COLLAPSE_AT = 140;
export const SIDE_STEP = 16;

export type SideSize = { rail: true } | { rail: false; width: number };

export const clampSide = (width: number, max = SIDE_MAX): number => Math.round(Math.max(SIDE_MIN, Math.min(Math.max(SIDE_MIN, max), width)));

/** Where the pointer is (px from the window's left edge) -> the sidebar's size. */
export function sizeForPointer(x: number, max = SIDE_MAX): SideSize {
  return x < SIDE_COLLAPSE_AT ? { rail: true } : { rail: false, width: clampSide(x, max) };
}

/** Arrow keys (+1 wider, -1 narrower), Home (rail) and End (widest). */
export function sizeForKey(key: string, current: SideSize, expandedWidth: number, max = SIDE_MAX): SideSize | null {
  const now = current.rail ? SIDE_RAIL : current.width;
  if (key === "Home") return { rail: true };
  if (key === "End") return { rail: false, width: clampSide(max, max) };
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  if (key === "ArrowRight") return current.rail ? { rail: false, width: clampSide(expandedWidth, max) } : { rail: false, width: clampSide(now + SIDE_STEP, max) };
  if (current.rail) return current;
  return now - SIDE_STEP < SIDE_MIN ? { rail: true } : { rail: false, width: now - SIDE_STEP };
}

/** Stored values -> a size. The old "side.open = 0" (fully hidden) becomes the rail. */
export function readSide(widthRaw: string | null, railRaw: string | null, legacyOpen: string | null, max = SIDE_MAX): { width: number; rail: boolean } {
  const n = Number(widthRaw);
  const width = Number.isFinite(n) && n > 0 ? clampSide(n, max) : SIDE_DEFAULT;
  const rail = railRaw === null ? legacyOpen === "0" : railRaw === "1";
  return { width, rail };
}

/** Two-letter avatar for a project name: "Checkout Flow" -> "CF", "dashboard" -> "DA". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_\-./]+/u).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}
