import fs from "node:fs/promises";
import path from "node:path";

import type { FileView, FolderListing, TreeEntry } from "../electron/contracts.js";

/* Read-only view of the open project's folder. Every path a caller names is resolved under the project root
   here, so nothing outside it (or inside the app's own folders) can ever be listed or read. */

export const TREE_CAP = 2000;
export const TEXT_CAP = 512 * 1024;
export const IMAGE_CAP = 2 * 1024 * 1024;
const HIDDEN_NAMES = new Set(["node_modules", ".git", ".figmake-sync", "dist", "backups", "build", "coverage"]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Names the explorer never shows: tooling folders, build output and anything starting with a dot. */
export const isHiddenName = (name: string): boolean => HIDDEN_NAMES.has(name) || name.startsWith(".");

/** "src/a/b.ts" from any input, or null when it is not a plain relative path inside the project. */
export function cleanRelative(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 1024 || input.includes("\0")) return null;
  const slashed = input.replace(/\\/gu, "/");
  if (slashed.startsWith("/")) return null;
  const parts = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || /^[a-zA-Z]:$/u.test(p) || isHiddenName(p))) return null;
  return parts.join("/");
}

/** Absolute path of `rel` inside `root`, or null when it escapes (".." or a symlink leading outside). */
export async function resolveInside(root: string, rel: unknown): Promise<string | null> {
  const clean = cleanRelative(rel);
  if (clean === null) return null;
  try {
    const realRoot = await fs.realpath(root);
    const target = path.resolve(realRoot, ...clean.split("/"));
    const real = await fs.realpath(target);
    const within = path.relative(realRoot, real);
    if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) return null;
    return real;
  } catch {
    return null;
  }
}

const byName = (a: TreeEntry, b: TreeEntry): number => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** The direct children of one folder: folders first (`src` leads at the top), then files. Symlinks are skipped. */
export async function listFolder(root: string, rel: unknown, cap = TREE_CAP): Promise<FolderListing> {
  const empty = (p: string): FolderListing => ({ path: p, entries: [], truncated: false });
  const clean = cleanRelative(rel);
  if (clean === null) return empty("");
  const dir = await resolveInside(root, clean);
  if (!dir) return empty(clean);
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const entries: TreeEntry[] = [];
    for (const item of items) {
      if (isHiddenName(item.name) || item.isSymbolicLink()) continue;
      const kind = item.isDirectory() ? "folder" : item.isFile() ? "file" : null;
      if (kind) entries.push({ name: item.name, path: clean ? `${clean}/${item.name}` : item.name, kind });
    }
    const rank = (e: TreeEntry): number => (e.kind === "folder" ? (clean === "" && e.name === "src" ? 0 : 1) : 2);
    entries.sort((a, b) => rank(a) - rank(b) || byName(a, b));
    return { path: clean, entries: entries.slice(0, cap), truncated: entries.length > cap };
  } catch {
    return empty(clean);
  }
}

/** What the viewer shows for one file: text, an image, or a plain reason there is nothing to show. */
export async function readFileView(root: string, rel: unknown): Promise<FileView> {
  const clean = cleanRelative(rel);
  const shown = clean ?? "";
  const file = clean ? await resolveInside(root, clean) : null;
  if (!clean || !file) return { kind: "missing", path: shown };
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) return { kind: "missing", path: clean };
    const type = IMAGE_TYPES[path.extname(clean).toLowerCase()];
    if (type) {
      if (info.size > IMAGE_CAP) return { kind: "large", path: clean, size: info.size };
      const data = await fs.readFile(file);
      return { kind: "image", path: clean, dataUrl: `data:${type};base64,${data.toString("base64")}` };
    }
    if (info.size > TEXT_CAP) return { kind: "large", path: clean, size: info.size };
    const data = await fs.readFile(file);
    if (data.subarray(0, 8000).includes(0)) return { kind: "binary", path: clean, size: info.size };
    const text = data.toString("utf8").replace(/\r\n/gu, "\n");
    return { kind: "text", path: clean, text, lines: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  } catch {
    return { kind: "missing", path: clean };
  }
}
