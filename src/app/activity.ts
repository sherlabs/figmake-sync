import { sanitizeText } from "./report.js";

/* The "what is happening" feed behind the progress card: raw tool output turned into short, safe, readable lines. */

export const MAX_ACTIVITY_LINES = 300;
export const MAX_PROCESS_LINES = 60;
export const MAX_ACTIVITY_LINE = 200;

/** Braille / ascii spinner frames and bare progress glyphs that tools redraw in place. */
const SPINNER_ONLY = /^[\s⠁-⣿|/\\\-.·•*]*$/u;

/**
 * One raw output line -> one clean line, or null when there is nothing worth showing.
 * Strips terminal codes, keeps only the last redraw of a carriage-return line, drops spinners,
 * hides the home folder, URL queries and token-shaped strings, and truncates.
 */
export function cleanActivityLine(raw: string, home?: string): string | null {
  // A progress bar redraws with \r: only the final state matters.
  const redraw = raw.split("\r").filter((part) => part.trim().length > 0).at(-1) ?? "";
  const noOsc = redraw.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu, "");
  const text = sanitizeText(noOsc, { home }).replace(/[⠁-⣿]/gu, "").replace(/\s+/gu, " ").trim();
  if (!text || SPINNER_ONLY.test(text)) return null;
  return text.length > MAX_ACTIVITY_LINE ? `${text.slice(0, MAX_ACTIVITY_LINE - 1)}…` : text;
}

/** Appends cleaned lines, skipping an immediate repeat, keeping the newest `cap`. Returns the same array when nothing changed. */
export function pushLines(lines: readonly string[], raw: string, cap: number, home?: string): readonly string[] {
  let next = lines;
  for (const piece of raw.split(/\n/u)) {
    const line = cleanActivityLine(piece, home);
    if (!line || next.at(-1) === line) continue;
    next = [...next, line];
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}
