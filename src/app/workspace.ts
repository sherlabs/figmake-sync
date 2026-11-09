import path from "node:path";

import fs from "fs-extra";

import { ProjectStateStore, STATE_DIRECTORY_NAME } from "../core/state.js";

export const DEFAULT_WORKSPACE_NAME = "figmake-sync";

export interface FigmaLink {
  /** Stable id of the Make file (the path segment after /make/). */
  key: string;
  /** Human name for the title bar, e.g. "Checkout Flow". */
  name: string;
  /** Folder-safe name, e.g. "checkout-flow". */
  slug: string;
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug || "project";
}

/** Accepts only https://[www.]figma.com/make/<key>[/<name>] links. */
export function parseFigmaLink(link: string): FigmaLink | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^(www\.)?figma\.com$/u.test(url.hostname)) return null;
  const [kind, key, rawName] = url.pathname.split("/").filter(Boolean);
  if (kind !== "make" || !key || !/^[A-Za-z0-9_-]+$/u.test(key)) return null;
  let decoded = "";
  try {
    decoded = rawName ? decodeURIComponent(rawName) : "";
  } catch {
    decoded = "";
  }
  const name = decoded.replace(/[-_+\s]+/gu, " ").trim() || `Figma Make ${key.slice(0, 4)}`;
  return { key, name, slug: slugify(name) };
}

export function defaultWorkspaceDir(documentsDir: string): string {
  return path.join(documentsDir, DEFAULT_WORKSPACE_NAME);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function real(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export interface WorkspaceGuard {
  home: string;
  /** Folders the workspace may never be inside (the app bundle). */
  forbidden: string[];
}

/** A workspace is a writable directory that is not "/", the home folder, the app, or inside a project. */
export async function validateWorkspace(dir: string, guard: WorkspaceGuard): Promise<boolean> {
  if (!path.isAbsolute(dir)) return false;
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return false;
  const home = await real(guard.home);
  if (resolved === home) return false;
  for (const bundle of guard.forbidden) {
    if (isInside(await real(bundle), await real(resolved))) return false;
  }
  try {
    await fs.ensureDir(resolved);
    const target = await real(resolved);
    if (target === home || target === path.parse(target).root) return false;
    for (let at = target; ; at = path.dirname(at)) {
      if (await fs.pathExists(path.join(at, STATE_DIRECTORY_NAME))) return false;
      if (path.dirname(at) === at) break;
    }
    if (!(await fs.stat(target)).isDirectory()) return false;
    await fs.access(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function projectKeyAt(dir: string): Promise<string | null> {
  const configPath = new ProjectStateStore(dir).paths.configPath;
  if (!(await fs.pathExists(configPath))) return null;
  try {
    const config = (await fs.readJson(configPath)) as { figmaMakeUrl?: unknown };
    return typeof config.figmaMakeUrl === "string" ? (parseFigmaLink(config.figmaMakeUrl)?.key ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Picks the folder for a project inside the workspace. A remembered path wins; otherwise
 * <slug>, <slug>-2, ... Only an empty slot or this same project's folder is ever used, so
 * nothing the user already has there is touched.
 */
export async function resolveProjectFolder(
  workspace: string,
  link: FigmaLink,
  known: Record<string, string> = {},
): Promise<string> {
  const remembered = known[link.key];
  if (remembered && (await projectKeyAt(remembered)) === link.key) return remembered;
  for (let n = 1; n < 1000; n += 1) {
    const dir = path.join(workspace, n === 1 ? link.slug : `${link.slug}-${n}`);
    if (!(await fs.pathExists(dir))) return dir;
    if ((await projectKeyAt(dir)) === link.key) return dir;
  }
  throw new Error("No free folder name.");
}
