import { diff3Merge } from "node-diff3";

/** Files bigger than this are never merged line by line: they count as a conflict. */
export const MAX_MERGE_BYTES = 1_000_000;

export type TextMergeResult = { ok: true; text: string } | { ok: false };

function isText(buffer: Buffer): boolean {
  return buffer.length <= MAX_MERGE_BYTES && !buffer.subarray(0, 8000).includes(0);
}

/** Lines with their line endings kept, so joining them gives back the exact text. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

/**
 * Three-way, line-level merge. `ok` when every edit either touches different lines or both sides made
 * the same edit; otherwise `ok: false` and the caller keeps the local file untouched.
 */
export function mergeText(base: Buffer, local: Buffer, remote: Buffer): TextMergeResult {
  if (!isText(base) || !isText(local) || !isText(remote)) return { ok: false };
  const regions = diff3Merge<string>(lines(local.toString("utf8")), lines(base.toString("utf8")), lines(remote.toString("utf8")));
  let text = "";
  for (const region of regions) {
    if (region.conflict) return { ok: false };
    text += (region.ok ?? []).join("");
  }
  return { ok: true, text };
}
