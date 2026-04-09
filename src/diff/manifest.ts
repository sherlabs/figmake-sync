import { createHash } from "node:crypto";
import path from "node:path";

import fs from "fs-extra";
import { Minimatch } from "minimatch";

import { normalizeRelativePath } from "../utils/path.js";

export type LineEndingStyle = "lf" | "crlf" | "mixed" | "none" | "binary";

export interface ManifestEntry {
  path: string;
  contentHash: string;
  normalizedHash: string;
  size: number;
  modifiedTimeMs: number;
  isBinary: boolean;
  lineEnding: LineEndingStyle;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  createdAt: string;
  root: string;
  ignore: string[];
  files: ManifestEntry[];
}

export interface ManifestRename {
  from: string;
  to: string;
  match: "contentHash" | "normalizedHash";
}

export interface ManifestDiff {
  added: ManifestEntry[];
  modified: Array<{
    previous: ManifestEntry;
    current: ManifestEntry;
  }>;
  deleted: ManifestEntry[];
  renamed: ManifestRename[];
  unchanged: ManifestEntry[];
}

export interface ManifestDiffSummary {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  total: number;
}

export interface ThreeWayMergeDecision {
  path: string;
  base: ManifestEntry | undefined;
  local: ManifestEntry | undefined;
  remote: ManifestEntry | undefined;
  resolution: "take-local" | "take-remote" | "delete" | "conflict" | "noop";
  reason: string;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function detectBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));

  return sample.includes(0);
}

function detectLineEnding(content: string): LineEndingStyle {
  if (!content) {
    return "none";
  }

  const hasLf = /\n/.test(content);
  const hasCrLf = /\r\n/.test(content);

  if (hasLf && hasCrLf) {
    return "mixed";
  }

  if (hasCrLf) {
    return "crlf";
  }

  if (hasLf) {
    return "lf";
  }

  return "none";
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function createMatchers(ignorePatterns: readonly string[]): Minimatch[] {
  return ignorePatterns.map(
    (pattern) =>
      new Minimatch(pattern, {
        dot: true,
        nocase: process.platform === "darwin",
      }),
  );
}

function shouldIgnore(
  relativePath: string,
  matchers: readonly Minimatch[],
  isDirectory: boolean,
): boolean {
  if (!relativePath) {
    return false;
  }

  return matchers.some((matcher) => {
    if (matcher.match(relativePath)) {
      return true;
    }

    if (isDirectory && matcher.match(`${relativePath}/`)) {
      return true;
    }

    return matcher.match(`${relativePath}/**`);
  });
}

async function createManifestEntry(
  absolutePath: string,
  relativePath: string,
): Promise<ManifestEntry> {
  const [stats, buffer] = await Promise.all([
    fs.stat(absolutePath),
    fs.readFile(absolutePath),
  ]);
  const isBinary = detectBinary(buffer);

  if (isBinary) {
    const contentHash = sha256(buffer);

    return {
      path: relativePath,
      contentHash,
      normalizedHash: contentHash,
      size: stats.size,
      modifiedTimeMs: stats.mtimeMs,
      isBinary: true,
      lineEnding: "binary",
    };
  }

  const text = buffer.toString("utf8");

  return {
    path: relativePath,
    contentHash: sha256(text),
    normalizedHash: sha256(normalizeLineEndings(text)),
    size: stats.size,
    modifiedTimeMs: stats.mtimeMs,
    isBinary: false,
    lineEnding: detectLineEnding(text),
  };
}

async function walkDirectory(
  currentDir: string,
  rootDir: string,
  matchers: readonly Minimatch[],
  files: ManifestEntry[],
): Promise<void> {
  const directoryEntries = await fs.readdir(currentDir, {
    withFileTypes: true,
  });
  const sortedEntries = directoryEntries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of sortedEntries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(rootDir, absolutePath);

    if (shouldIgnore(relativePath, matchers, entry.isDirectory())) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, rootDir, matchers, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(await createManifestEntry(absolutePath, relativePath));
  }
}

export async function createManifest(
  rootDir: string,
  options: {
    ignore?: readonly string[];
  } = {},
): Promise<SnapshotManifest> {
  const ignore = [...(options.ignore ?? [])];
  const files: ManifestEntry[] = [];
  const matchers = createMatchers(ignore);

  await walkDirectory(rootDir, rootDir, matchers, files);

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    root: path.resolve(rootDir),
    ignore,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function sameEntry(left?: ManifestEntry, right?: ManifestEntry): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.contentHash === right.contentHash;
}

function toPathMap(manifest: SnapshotManifest): Map<string, ManifestEntry> {
  return new Map(manifest.files.map((entry) => [entry.path, entry]));
}

function extractRenamePairs(
  added: ManifestEntry[],
  deleted: ManifestEntry[],
): {
  added: ManifestEntry[];
  deleted: ManifestEntry[];
  renamed: ManifestRename[];
} {
  const deletedByHash = new Map<string, ManifestEntry[]>();
  const deletedByNormalizedHash = new Map<string, ManifestEntry[]>();

  for (const entry of deleted) {
    const hashMatches = deletedByHash.get(entry.contentHash) ?? [];
    hashMatches.push(entry);
    deletedByHash.set(entry.contentHash, hashMatches);

    const normalizedMatches =
      deletedByNormalizedHash.get(entry.normalizedHash) ?? [];
    normalizedMatches.push(entry);
    deletedByNormalizedHash.set(entry.normalizedHash, normalizedMatches);
  }

  const pairedAdded = new Set<string>();
  const pairedDeleted = new Set<string>();
  const renamed: ManifestRename[] = [];

  for (const entry of added) {
    const exactMatches = (deletedByHash.get(entry.contentHash) ?? []).filter(
      (candidate) => !pairedDeleted.has(candidate.path),
    );

    if (exactMatches.length === 1) {
      const deletedEntry = exactMatches[0];

      if (!deletedEntry) {
        continue;
      }

      pairedAdded.add(entry.path);
      pairedDeleted.add(deletedEntry.path);
      renamed.push({
        from: deletedEntry.path,
        to: entry.path,
        match: "contentHash",
      });
      continue;
    }

    const normalizedMatches = (
      deletedByNormalizedHash.get(entry.normalizedHash) ?? []
    ).filter((candidate) => !pairedDeleted.has(candidate.path));

    if (!entry.isBinary && normalizedMatches.length === 1) {
      const deletedEntry = normalizedMatches[0];

      if (!deletedEntry) {
        continue;
      }

      pairedAdded.add(entry.path);
      pairedDeleted.add(deletedEntry.path);
      renamed.push({
        from: deletedEntry.path,
        to: entry.path,
        match: "normalizedHash",
      });
    }
  }

  return {
    added: added.filter((entry) => !pairedAdded.has(entry.path)),
    deleted: deleted.filter((entry) => !pairedDeleted.has(entry.path)),
    renamed: renamed.sort((left, right) => left.from.localeCompare(right.from)),
  };
}

export function diffManifests(
  base: SnapshotManifest,
  current: SnapshotManifest,
): ManifestDiff {
  const baseMap = toPathMap(base);
  const currentMap = toPathMap(current);

  const unchanged: ManifestEntry[] = [];
  const modified: Array<{
    previous: ManifestEntry;
    current: ManifestEntry;
  }> = [];
  const added: ManifestEntry[] = [];
  const deleted: ManifestEntry[] = [];

  for (const entry of current.files) {
    const previous = baseMap.get(entry.path);

    if (!previous) {
      added.push(entry);
      continue;
    }

    if (sameEntry(previous, entry)) {
      unchanged.push(entry);
      continue;
    }

    modified.push({
      previous,
      current: entry,
    });
  }

  for (const entry of base.files) {
    if (!currentMap.has(entry.path)) {
      deleted.push(entry);
    }
  }

  const renameResult = extractRenamePairs(added, deleted);

  return {
    added: renameResult.added,
    modified: modified.sort((left, right) =>
      left.current.path.localeCompare(right.current.path),
    ),
    deleted: renameResult.deleted,
    renamed: renameResult.renamed,
    unchanged: unchanged.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export function summarizeManifestDiff(diff: ManifestDiff): ManifestDiffSummary {
  return {
    added: diff.added.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length,
    renamed: diff.renamed.length,
    total:
      diff.added.length +
      diff.modified.length +
      diff.deleted.length +
      diff.renamed.length,
  };
}

export function hasManifestChanges(diff: ManifestDiff): boolean {
  const summary = summarizeManifestDiff(diff);

  return summary.total > 0;
}

export function createHashIndex(
  manifest: SnapshotManifest,
): Record<string, Pick<ManifestEntry, "contentHash" | "normalizedHash">> {
  return Object.fromEntries(
    manifest.files.map((entry) => [
      entry.path,
      {
        contentHash: entry.contentHash,
        normalizedHash: entry.normalizedHash,
      },
    ]),
  );
}

export function buildThreeWayMergeFoundation(
  base: SnapshotManifest,
  local: SnapshotManifest,
  remote: SnapshotManifest,
): ThreeWayMergeDecision[] {
  const baseMap = toPathMap(base);
  const localMap = toPathMap(local);
  const remoteMap = toPathMap(remote);
  const allPaths = new Set<string>([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ]);
  const decisions: ThreeWayMergeDecision[] = [];

  for (const relativePath of [...allPaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const baseEntry = baseMap.get(relativePath);
    const localEntry = localMap.get(relativePath);
    const remoteEntry = remoteMap.get(relativePath);

    if (sameEntry(localEntry, remoteEntry)) {
      decisions.push({
        path: relativePath,
        base: baseEntry,
        local: localEntry,
        remote: remoteEntry,
        resolution: "noop",
        reason: "local and remote already match",
      });
      continue;
    }

    if (!baseEntry) {
      if (!localEntry && remoteEntry) {
        decisions.push({
          path: relativePath,
          base: undefined,
          local: localEntry,
          remote: remoteEntry,
          resolution: "take-remote",
          reason: "new file only exists remotely",
        });
      } else if (localEntry && !remoteEntry) {
        decisions.push({
          path: relativePath,
          base: undefined,
          local: localEntry,
          remote: remoteEntry,
          resolution: "take-local",
          reason: "new file only exists locally",
        });
      } else {
        decisions.push({
          path: relativePath,
          base: undefined,
          local: localEntry,
          remote: remoteEntry,
          resolution: "conflict",
          reason: "both sides added different new content",
        });
      }

      continue;
    }

    const localChanged = !sameEntry(baseEntry, localEntry);
    const remoteChanged = !sameEntry(baseEntry, remoteEntry);

    if (!localChanged && remoteChanged) {
      decisions.push({
        path: relativePath,
        base: baseEntry,
        local: localEntry,
        remote: remoteEntry,
        resolution: remoteEntry ? "take-remote" : "delete",
        reason: "only remote changed relative to the base snapshot",
      });
      continue;
    }

    if (localChanged && !remoteChanged) {
      decisions.push({
        path: relativePath,
        base: baseEntry,
        local: localEntry,
        remote: remoteEntry,
        resolution: "take-local",
        reason: "only local changed relative to the base snapshot",
      });
      continue;
    }

    decisions.push({
      path: relativePath,
      base: baseEntry,
      local: localEntry,
      remote: remoteEntry,
      resolution: "conflict",
      reason: "local and remote diverged from the same base snapshot",
    });
  }

  return decisions;
}
