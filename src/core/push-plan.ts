/**
 * Preflight for "send to Figma": every operation is decided before the first write, from two oracles that must agree —
 * the freshly downloaded zip (what exists, with what content) and the explorer index (what can be clicked).
 * Pure: no browser, no filesystem. See docs/PUSH-DESIGN.md sections 3 and 6.
 */
import type { ManifestDiff, ManifestEntry } from "../diff/manifest.js";
import { looksHidden, type ExplorerSnapshot } from "../figma/adapter.js";

export type PushOpKind = "replace" | "create" | "delete" | "mkdir";
/** What the progress card calls the operation (a rename's two halves are both "rename"). */
export type ShownOp = "replace" | "create" | "delete" | "rename";

export interface PlannedOp {
  op: PushOpKind;
  path: string;
  shown: ShownOp;
  /** The local file for replace/create (absent for delete/mkdir). */
  entry?: ManifestEntry;
  /** Normalised hash the editor must show before a replace is written (the zip's). Absent = no precondition. */
  expectedNormalizedHash?: string;
  /** For a rename: the delete of `path` only runs once the create of `counterpart` verified. */
  counterpart?: string;
  /** Root-level binary files go through the upload input instead of the editor. */
  binary?: boolean;
}

export interface PlannedNoop {
  op: "replace" | "create" | "delete";
  path: string;
  entry?: ManifestEntry;
}

export type PushBlockCode =
  | "UNSUPPORTED_BINARY_MODIFY"
  | "UNSUPPORTED_BINARY_NESTED"
  | "TOO_LARGE_FOR_EDITOR"
  | "INVALID_NAME"
  | "AMBIGUOUS_LOCAL_PATH"
  | "HIDDEN_FILE_UNSUPPORTED"
  | "EXPLORER_MISMATCH"
  | "AMBIGUOUS_REMOTE_PATH"
  | "NAME_COLLISION";

export interface PushBlock {
  path: string;
  code: PushBlockCode;
  message: string;
}

export interface PushPlan {
  /** In execution order: mkdir (shallow first), create, replace, delete. */
  ops: PlannedOp[];
  /** Already in the desired state in Figma: the baseline advances without a write. */
  noops: PlannedNoop[];
  /** Touched paths whose remote content is neither the baseline nor the local content (ask once). */
  diverged: string[];
  /** Any entry here stops the push before the first write. */
  blocked: PushBlock[];
}

export interface PlanInput {
  diff: ManifestDiff;
  baseline: ReadonlyMap<string, ManifestEntry>;
  local: ReadonlyMap<string, ManifestEntry>;
  remote: ReadonlyMap<string, ManifestEntry>;
  /** Absent when the session cannot index the explorer (older UI, fakes): row existence is then unknown. */
  explorer?: ExplorerSnapshot;
  /** Text files above this many bytes are refused up front. */
  maxEditorBytes?: number;
}

export const DEFAULT_MAX_EDITOR_BYTES = 5 * 1024 * 1024;

const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 4096;

export function invalidNameReason(relativePath: string): string | null {
  if (relativePath === "" || relativePath.startsWith("/") || relativePath.endsWith("/")) return "empty path";
  if (Buffer.byteLength(relativePath) > MAX_PATH_BYTES) return "path is too long";

  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "empty or dot-only segment";
    if (/[\0\\]/u.test(segment)) return "contains a backslash or NUL";
    if (/[ .]$/u.test(segment)) return "ends with a space or a dot";
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return "a name is longer than 255 bytes";
  }

  return null;
}

/** One plain sentence or two per code, naming the file, saying what changed in Figma (nothing, for a block). */
export function pushMessage(code: string, relativePath?: string, extra?: { folder?: string; leftover?: string; count?: number }): string {
  const file = relativePath ?? "a file";
  const name = file.split("/").at(-1) ?? file;

  switch (code) {
    case "UNSUPPORTED_BINARY_MODIFY":
      return `Images and other binary files can't be updated from here yet. Replace ${name} in Figma, or ignore it. Nothing was changed in Figma.`;
    case "UNSUPPORTED_BINARY_NESTED":
      return `New images can only be added at the top level for now. Move ${file} to the top level or add it in Figma. Nothing was changed in Figma.`;
    case "TOO_LARGE_FOR_EDITOR":
      return `${file} is too large to send through Figma's editor. Add it in Figma, or ignore it. Nothing was changed in Figma.`;
    case "INVALID_NAME":
      return `Figma can't use the name '${file}'. Rename it locally. Nothing was changed in Figma.`;
    case "AMBIGUOUS_LOCAL_PATH":
      return `Two files differ only by letter case or accents: ${file}. Rename one locally. Nothing was changed in Figma.`;
    case "HIDDEN_FILE_UNSUPPORTED":
      return `Figma hides files like ${name}. Add it to Ignore, or change it in Figma. Nothing was changed in Figma.`;
    case "EXPLORER_MISMATCH":
    case "TREE_INDEX_INCOMPLETE":
      return `Figma's file list looks different from what we expected (${file}). Nothing was changed. Try again; if it keeps happening, send a report.`;
    case "AMBIGUOUS_REMOTE_PATH":
    case "NAME_COLLISION":
      return `Figma has two entries called ${name} in ${folderOf(file)}. Fix that in Figma first. Nothing was changed in Figma.`;
    case "WRONG_FILE_OR_CHANGED":
      return `${file} changed in Figma while sending. Stopped before changing it.`;
    case "LEFTOVER_FILE":
      return `Figma created '${extra?.leftover ?? "new-file.tsx"}' in ${extra?.folder || "the top level"} but wouldn't rename it. Delete that file in Figma, then send again.`;
    case "WRITE_NOT_VERIFIED":
      return `${file} didn't take in Figma's editor. Nothing after it was sent.`;
    case "DELETE_NOT_VERIFIED":
      return `${file} is still in Figma after deleting it. Nothing after it was sent.`;
    case "NOT_SAVED":
      return `${file} wasn't saved by Figma. Send again.`;
    case "CHANGED_AFTER_SEND":
      return `${file} changed in Figma right after it was sent. Pull or merge, then send again.`;
    case "UNEXPECTED_REMOTE_CHANGE":
      return `${file} changed in Figma while sending (it was not part of this send). Pull or merge before the next send.`;
    case "REMOTE_CHECK_FAILED":
      return "Couldn't check Figma for newer changes, so nothing was sent. Try again.";
    case "AUTH_REQUIRED":
      return "You're signed out of Figma. Sign in and try again.";
    case "UI_CHANGED":
    case "SELECTOR_NOT_FOUND":
      return `Figma's page looks different from what this app expects (${file}). Nothing more was changed. Please send a report.`;
    case "ABORTED":
      return `Stopped. ${extra?.count ?? 0} files were sent; the rest are still waiting.`;
    case "TIMEOUT":
      return `Figma took too long while sending ${file}. Nothing after it was sent. Try again.`;
    case "STOPPED":
      return `Not sent: an earlier file stopped the send (${file}).`;
    default:
      return `Couldn't send ${file} to Figma. Nothing after it was sent. Try again.`;
  }
}

function folderOf(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");

  return i < 0 ? "the top level" : relativePath.slice(0, i);
}

/** Every path a push would touch, sorted. */
export function touchedPaths(diff: ManifestDiff): string[] {
  return [
    ...new Set([
      ...diff.added.map((e) => e.path),
      ...diff.modified.map((e) => e.current.path),
      ...diff.deleted.map((e) => e.path),
      ...diff.renamed.flatMap((e) => [e.from, e.to]),
    ]),
  ].sort();
}

/** Refusals that need no browser: binary edits, nested binaries, oversize text, bad names, case-only twins. */
export function validateLocalPlan(diff: ManifestDiff, local: ReadonlyMap<string, ManifestEntry>, maxBytes = DEFAULT_MAX_EDITOR_BYTES): PushBlock[] {
  const blocked: PushBlock[] = [];
  const block = (path: string, code: PushBlockCode): void => {
    if (!blocked.some((b) => b.path === path && b.code === code)) blocked.push({ path, code, message: pushMessage(code, path) });
  };
  const foldedLocal = new Map<string, string[]>();

  for (const path of local.keys()) {
    const key = path.normalize("NFC").toLowerCase();

    (foldedLocal.get(key) ?? foldedLocal.set(key, []).get(key)!).push(path);
  }

  const sendable = [...diff.modified.map((e) => e.current), ...diff.added, ...diff.renamed.flatMap((r) => (local.has(r.to) ? [local.get(r.to)!] : []))];

  for (const entry of sendable) {
    const path = entry.path;

    if (invalidNameReason(path)) block(path, "INVALID_NAME");

    const twins = foldedLocal.get(path.normalize("NFC").toLowerCase()) ?? [];

    if (twins.length > 1) block(twins.sort().join(" / "), "AMBIGUOUS_LOCAL_PATH");

    if (!entry.isBinary && entry.size > maxBytes) block(path, "TOO_LARGE_FOR_EDITOR");
  }

  for (const { current } of diff.modified) {
    if (current.isBinary) block(current.path, "UNSUPPORTED_BINARY_MODIFY");
  }

  for (const entry of [...diff.added, ...diff.renamed.flatMap((r) => (local.has(r.to) ? [local.get(r.to)!] : []))]) {
    if (entry.isBinary && entry.path.includes("/")) block(entry.path, "UNSUPPORTED_BINARY_NESTED");
  }

  return blocked;
}

/**
 * Classifies every touched path per the table in docs/PUSH-DESIGN.md 3.4. `explorer` undefined means row existence is
 * unknown (no EXPLORER_MISMATCH can be raised and no folders are created).
 */
export function buildPushPlan(input: PlanInput): PushPlan {
  const { diff, baseline, local, remote, explorer } = input;
  const maxBytes = input.maxEditorBytes ?? DEFAULT_MAX_EDITOR_BYTES;
  const blocked: PushBlock[] = [];
  const diverged = new Set<string>();
  const noops: PlannedNoop[] = [];
  const replaces: PlannedOp[] = [];
  const creates: PlannedOp[] = [];
  const deletes: PlannedOp[] = [];
  const mkdirs = new Set<string>();
  const block = (path: string, code: PushBlockCode): void => {
    if (!blocked.some((b) => b.path === path && b.code === code)) blocked.push({ path, code, message: pushMessage(code, path) });
  };
  const rowOf = (path: string): "file" | "folder" | undefined => explorer?.entries[path];
  const rowKnown = explorer?.supported === true;
  /** Absent from the explorer although the zip has it: hidden-and-untoggleable, else a mismatch. */
  const missingRow = (path: string): void => {
    block(path, looksHidden(path) && explorer?.hiddenFiles !== "on" ? "HIDDEN_FILE_UNSUPPORTED" : "EXPLORER_MISMATCH");
  };

  // --- local validation (no oracle needed) ---
  for (const b of validateLocalPlan(diff, local, maxBytes)) block(b.path, b.code);

  const locallyBlocked = new Set(blocked.map((b) => b.path));

  if (rowKnown) {
    for (const path of touchedPaths(diff)) {
      if (explorer?.duplicates.includes(path)) block(path, "AMBIGUOUS_REMOTE_PATH");
    }
  }

  // --- replace ---
  for (const { current } of diff.modified) {
    const path = current.path;

    if (locallyBlocked.has(path)) continue;

    const base = baseline.get(path)?.contentHash;
    const rem = remote.get(path);

    if (rem?.contentHash === current.contentHash) {
      noops.push({ op: "replace", path, entry: current });
    } else if (rem === undefined || rem.contentHash !== base) {
      diverged.add(path);
    } else if (rowKnown && rowOf(path) === undefined) {
      missingRow(path);
    } else if (rowKnown && rowOf(path) === "folder") {
      block(path, "EXPLORER_MISMATCH");
    } else {
      replaces.push({ op: "replace", path, shown: "replace", entry: current, expectedNormalizedHash: rem.normalizedHash });
    }
  }

  // --- create (added + rename targets) ---
  const createOf = (entry: ManifestEntry, shown: ShownOp, counterpart?: string): void => {
    const path = entry.path;
    const nested = path.includes("/");

    if (locallyBlocked.has(path)) return;

    const rem = remote.get(path);

    if (rem?.contentHash === entry.contentHash) {
      noops.push({ op: "create", path, entry });
      return;
    }

    if (rem !== undefined) {
      diverged.add(path);
      return;
    }

    if (rowKnown && rowOf(path) !== undefined) {
      block(path, "EXPLORER_MISMATCH");
      return;
    }

    if (rowKnown && nested) {
      // Missing parent folders become mkdir ops; a file where a folder is needed is a collision.
      const segments = path.split("/");

      for (let depth = 1; depth < segments.length; depth += 1) {
        const dir = segments.slice(0, depth).join("/");
        const row = rowOf(dir);

        if (row === "file") {
          block(dir, "NAME_COLLISION");
          return;
        }

        if (row === undefined) {
          if (looksHidden(dir) && explorer?.hiddenFiles !== "on") {
            block(dir, "HIDDEN_FILE_UNSUPPORTED");
            return;
          }

          mkdirs.add(dir);
        }
      }
    }

    creates.push({ op: "create", path, shown, entry, ...(counterpart ? { counterpart } : {}), ...(entry.isBinary ? { binary: true } : {}) });
  };

  for (const entry of diff.added) createOf(entry, "create");

  for (const rename of diff.renamed) {
    const entry = local.get(rename.to);

    if (entry) createOf(entry, "rename", rename.from);
  }

  // --- delete (deleted + rename sources) ---
  const deleteOf = (path: string, shown: ShownOp, counterpart?: string): void => {
    const base = baseline.get(path)?.contentHash;
    const rem = remote.get(path);

    if (rem === undefined) {
      if (rowKnown && rowOf(path) !== undefined) block(path, "EXPLORER_MISMATCH");
      else noops.push({ op: "delete", path });
      return;
    }

    if (rem.contentHash !== base) {
      diverged.add(path);
      return;
    }

    if (rowKnown && rowOf(path) === undefined) {
      missingRow(path);
      return;
    }

    deletes.push({ op: "delete", path, shown, ...(counterpart ? { counterpart } : {}) });
  };

  for (const entry of diff.deleted) deleteOf(entry.path, "delete");
  for (const rename of diff.renamed) deleteOf(rename.from, "rename", rename.to);

  const byPath = (a: PlannedOp, b: PlannedOp): number => a.path.localeCompare(b.path);
  const mkdirOps: PlannedOp[] = [...mkdirs]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map((path) => ({ op: "mkdir", path, shown: "create" }));

  return {
    ops: [...mkdirOps, ...creates.sort(byPath), ...replaces.sort(byPath), ...deletes.sort(byPath)],
    noops,
    diverged: [...diverged].sort(),
    blocked,
  };
}

/**
 * Applies the user's answer to the diverged question. Approved: diverged replaces/creates become replaces whose
 * precondition is the *current* remote content (an intentional overwrite), a remotely deleted file becomes a create,
 * and diverged deletes proceed. Declined: every diverged path (and its rename counterpart) is dropped.
 */
export function resolveDiverged(plan: PushPlan, input: PlanInput, approved: boolean): { plan: PushPlan; skipped: string[] } {
  if (plan.diverged.length === 0) return { plan, skipped: [] };

  const divergedSet = new Set(plan.diverged);

  for (const rename of input.diff.renamed) {
    if (divergedSet.has(rename.from) || divergedSet.has(rename.to)) {
      divergedSet.add(rename.from);
      divergedSet.add(rename.to);
    }
  }

  if (!approved) {
    const keep = (op: { path: string; counterpart?: string }): boolean => !divergedSet.has(op.path) && !(op.counterpart && divergedSet.has(op.counterpart));

    return {
      plan: { ...plan, ops: plan.ops.filter(keep), noops: plan.noops.filter(keep), diverged: [] },
      skipped: [...divergedSet].sort(),
    };
  }

  const extra: PlannedOp[] = [];

  for (const path of plan.diverged) {
    const entry = input.local.get(path);
    const rem = input.remote.get(path);
    const renamedTo = input.diff.renamed.find((r) => r.from === path)?.to;
    const renamedFrom = input.diff.renamed.find((r) => r.to === path)?.from;

    if (entry && rem) {
      if (entry.isBinary) continue; // binary overwrite is not possible through the editor; left unresolved by the caller
      extra.push({ op: "replace", path, shown: renamedFrom ? "rename" : "replace", entry, expectedNormalizedHash: rem.normalizedHash, ...(renamedFrom ? { counterpart: renamedFrom } : {}) });
    } else if (entry && !rem) {
      extra.push({ op: "create", path, shown: renamedFrom ? "rename" : "create", entry, ...(renamedFrom ? { counterpart: renamedFrom } : {}), ...(entry.isBinary ? { binary: true } : {}) });
    } else if (!entry && rem) {
      extra.push({ op: "delete", path, shown: renamedTo ? "rename" : "delete", ...(renamedTo ? { counterpart: renamedTo } : {}) });
    }
  }

  const order: Record<PushOpKind, number> = { mkdir: 0, create: 1, replace: 2, delete: 3 };
  const ops = [...plan.ops, ...extra].sort((a, b) => order[a.op] - order[b.op] || a.path.localeCompare(b.path));

  return { plan: { ...plan, ops, diverged: [] }, skipped: [] };
}
