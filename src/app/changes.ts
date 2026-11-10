import fs from "fs-extra";
import path from "node:path";
import { diffLines } from "diff";

import type { ChangedFile, DiffRow } from "../electron/contracts.js";
import { createManifest, diffManifests } from "../diff/manifest.js";

const MAX_TEXT_BYTES = 512 * 1024;

export interface ChangedPath {
  path: string;
  status: ChangedFile["status"];
}

/** Files that differ between two folders. A rename counts as one removed plus one added file. */
export async function listChangedFiles(beforeDir: string, afterDir: string, ignore: readonly string[] = []): Promise<ChangedPath[]> {
  const [before, after] = await Promise.all([
    fs.pathExists(beforeDir).then((ok) => (ok ? createManifest(beforeDir, { ignore }) : null)),
    fs.pathExists(afterDir).then((ok) => (ok ? createManifest(afterDir, { ignore }) : null)),
  ]);
  const empty = (root: string) => ({ schemaVersion: 1 as const, createdAt: "", root, ignore: [], files: [] });
  const diff = diffManifests(before ?? empty(beforeDir), after ?? empty(afterDir));
  const out: ChangedPath[] = [
    ...diff.modified.map((m) => ({ path: m.current.path, status: "edited" as const })),
    ...diff.added.map((e) => ({ path: e.path, status: "added" as const })),
    ...diff.deleted.map((e) => ({ path: e.path, status: "removed" as const })),
    ...diff.renamed.flatMap((r) => [
      { path: r.to, status: "added" as const },
      { path: r.from, status: "removed" as const },
    ]),
  ];
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function isBinary(text: string | Buffer): boolean {
  const buf = typeof text === "string" ? Buffer.from(text) : text;
  return buf.length > MAX_TEXT_BYTES || buf.includes(0);
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((l) => l.replace(/\r$/u, ""));
}

/** Side-by-side rows for one file's before/after text (null = the file does not exist on that side). */
export function fileRows(
  before: string | Buffer | null,
  after: string | Buffer | null,
  options: { context?: number; maxRows?: number } = {},
): { rows: DiffRow[]; binary: boolean; truncated: boolean } {
  const context = options.context ?? 3;
  const maxRows = options.maxRows ?? 400;
  if ((before !== null && isBinary(before)) || (after !== null && isBinary(after))) return { rows: [], binary: true, truncated: false };
  const a = before === null ? "" : before.toString();
  const b = after === null ? "" : after.toString();

  const flat: DiffRow[] = [];
  let l = 0;
  let r = 0;
  const parts = diffLines(a, b);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as (typeof parts)[number];
    if (!part.added && !part.removed) {
      for (const text of splitLines(part.value)) {
        l++;
        r++;
        flat.push({ left: { n: l, text, mark: "same" }, right: { n: r, text, mark: "same" } });
      }
      continue;
    }
    // Pair a removed block with the added block that follows it, line by line.
    let removed: string[] = [];
    let added: string[] = [];
    if (part.removed) {
      removed = splitLines(part.value);
      const next = parts[i + 1];
      if (next?.added) {
        added = splitLines(next.value);
        i++;
      }
    } else {
      added = splitLines(part.value);
    }
    const height = Math.max(removed.length, added.length);
    for (let k = 0; k < height; k++) {
      const del = removed[k];
      const add = added[k];
      flat.push({
        left: del === undefined ? null : { n: ++l, text: del, mark: "del" },
        right: add === undefined ? null : { n: ++r, text: add, mark: "add" },
      });
    }
  }

  // Keep changed rows plus `context` same rows around them; collapse the rest into hunk rows.
  const keep = flat.map((row) => row.left?.mark !== "same");
  const show = keep.map((k, i) => {
    if (k) return true;
    for (let d = 1; d <= context; d++) if (keep[i - d] || keep[i + d]) return true;
    return false;
  });
  const rows: DiffRow[] = [];
  let truncated = false;
  for (let i = 0; i < flat.length; i++) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (show[i]) {
      rows.push(flat[i] as DiffRow);
      continue;
    }
    let j = i;
    while (j < flat.length && !show[j]) j++;
    const first = flat[i]?.right?.n ?? 0;
    const last = flat[j - 1]?.right?.n ?? first;
    // Only fully unchanged files (no changed rows at all) collapse here; they never reach the UI.
    rows.push({ left: null, right: null, hunk: first === last ? `Line ${first}` : `Lines ${first} to ${last}` });
    i = j - 1;
  }
  return { rows, binary: false, truncated };
}

async function readIfFile(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_TEXT_BYTES) return Buffer.alloc(MAX_TEXT_BYTES + 1, 0);
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** Full before/after description of every changed file between two folders. Never throws. */
export async function describeFolders(beforeDir: string, afterDir: string, ignore: readonly string[] = []): Promise<ChangedFile[]> {
  try {
    const list = await listChangedFiles(beforeDir, afterDir, ignore);
    const out: ChangedFile[] = [];
    for (const item of list) {
      const before = item.status === "added" ? null : await readIfFile(path.join(beforeDir, item.path));
      const after = item.status === "removed" ? null : await readIfFile(path.join(afterDir, item.path));
      out.push({ path: item.path, status: item.status, ...fileRows(before, after) });
    }
    return out;
  } catch {
    return [];
  }
}
