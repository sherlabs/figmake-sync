import { createHash } from "node:crypto";
import path from "node:path";

import fs from "fs-extra";
import { Minimatch } from "minimatch";

import { DEFAULT_IGNORE_PATTERNS } from "../types/config.js";
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

const CASE_INSENSITIVE_FS =
  process.platform === "darwin" || process.platform === "win32";
const MAX_IN_MEMORY_BYTES = 16 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 64 * 1024;
const SKIPPABLE_FS_ERRORS = new Set(["ENOENT", "EBUSY", "EPERM", "EACCES"]);

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathKey(value: string): string {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

function detectBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
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

// Operates on a latin1 view of the bytes so it is lossless for any
// ASCII-compatible encoding. Strips a UTF-8 BOM, normalizes CRLF and lone CR.
function normalizedTextBytes(buffer: Buffer): Buffer {
  let text = buffer.toString("latin1");

  if (text.startsWith("\u00ef\u00bb\u00bf")) {
    text = text.slice(3);
  }

  return Buffer.from(text.replace(/\r\n?/g, "\n"), "latin1");
}

function expandAnyDepth(pattern: string): string[] {
  const trimmed = pattern.replace(/^\.?\//, "");

  if (trimmed.startsWith("**/")) {
    return [trimmed];
  }

  return [trimmed, `**/${trimmed}`];
}

function createMatchers(ignorePatterns: readonly string[]): Minimatch[] {
  const defaults = new Set<string>(DEFAULT_IGNORE_PATTERNS);
  const patterns = new Set<string>();

  // Defaults always apply, at any depth, regardless of user config.
  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    for (const expanded of expandAnyDepth(pattern)) {
      patterns.add(expanded);
    }
  }

  for (const pattern of ignorePatterns) {
    if (defaults.has(pattern)) {
      continue;
    }

    patterns.add(pattern);
  }

  return [...patterns].map(
    (pattern) =>
      new Minimatch(pattern, {
        dot: true,
        nocase: CASE_INSENSITIVE_FS,
        matchBase: !pattern.includes("/"),
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

async function hashFileStream(absolutePath: string): Promise<{
  hash: string;
  size: number;
  sample: Buffer;
}> {
  const hash = createHash("sha256");
  const sampleChunks: Buffer[] = [];
  let sampled = 0;
  let size = 0;

  for await (const chunk of fs.createReadStream(absolutePath)) {
    const buf = chunk as Buffer;

    hash.update(buf);
    size += buf.length;

    if (sampled < BINARY_SAMPLE_BYTES) {
      sampleChunks.push(buf);
      sampled += buf.length;
    }
  }

  return { hash: hash.digest("hex"), size, sample: Buffer.concat(sampleChunks) };
}

async function createManifestEntry(
  absolutePath: string,
  relativePath: string,
): Promise<ManifestEntry | undefined> {
  try {
    const stats = await fs.stat(absolutePath);

    if (stats.size > MAX_IN_MEMORY_BYTES) {
      const streamed = await hashFileStream(absolutePath);
      const isBinary = detectBinary(
        streamed.sample.subarray(0, BINARY_SAMPLE_BYTES),
      );

      return {
        path: relativePath,
        contentHash: streamed.hash,
        normalizedHash: streamed.hash,
        size: streamed.size,
        modifiedTimeMs: stats.mtimeMs,
        isBinary,
        lineEnding: isBinary ? "binary" : "none",
      };
    }

    const buffer = await fs.readFile(absolutePath);
    const contentHash = sha256(buffer);

    if (detectBinary(buffer)) {
      return {
        path: relativePath,
        contentHash,
        normalizedHash: contentHash,
        size: buffer.length,
        modifiedTimeMs: stats.mtimeMs,
        isBinary: true,
        lineEnding: "binary",
      };
    }

    return {
      path: relativePath,
      contentHash,
      normalizedHash: sha256(normalizedTextBytes(buffer)),
      size: buffer.length,
      modifiedTimeMs: stats.mtimeMs,
      isBinary: false,
      lineEnding: detectLineEnding(buffer.toString("latin1")),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code && SKIPPABLE_FS_ERRORS.has(code)) {
      return undefined;
    }

    throw error;
  }
}

async function walkDirectory(
  currentDir: string,
  rootDir: string,
  matchers: readonly Minimatch[],
  files: ManifestEntry[],
): Promise<void> {
  let directoryEntries;

  try {
    directoryEntries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code && SKIPPABLE_FS_ERRORS.has(code) && currentDir !== rootDir) {
      return;
    }

    throw error;
  }

  const sortedEntries = directoryEntries.sort((left, right) =>
    compareCodePoint(left.name, right.name),
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

    const manifestEntry = await createManifestEntry(absolutePath, relativePath);

    if (manifestEntry) {
      files.push(manifestEntry);
    }
  }
}

export async function createManifest(
  rootDir: string,
  options: {
    ignore?: readonly string[];
  } = {},
): Promise<SnapshotManifest> {
  const ignore = [
    ...new Set([...DEFAULT_IGNORE_PATTERNS, ...(options.ignore ?? [])]),
  ];
  const files: ManifestEntry[] = [];
  const matchers = createMatchers(ignore);

  await walkDirectory(rootDir, rootDir, matchers, files);

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    root: path.resolve(rootDir),
    ignore,
    files: files.sort((left, right) => compareCodePoint(left.path, right.path)),
  };
}

function sameEntry(left?: ManifestEntry, right?: ManifestEntry): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (left.contentHash === right.contentHash) {
    return true;
  }

  // Line-ending-only differences in text files are not a real change.
  return (
    !left.isBinary &&
    !right.isBinary &&
    left.normalizedHash === right.normalizedHash
  );
}

function toPathMap(manifest: SnapshotManifest): Map<string, ManifestEntry> {
  return new Map(manifest.files.map((entry) => [pathKey(entry.path), entry]));
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
    renamed: renamed.sort((left, right) => compareCodePoint(left.from, right.from)),
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
    const previous = baseMap.get(pathKey(entry.path));

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
    if (!currentMap.has(pathKey(entry.path))) {
      deleted.push(entry);
    }
  }

  const renameResult = extractRenamePairs(added, deleted);

  return {
    added: renameResult.added,
    modified: modified.sort((left, right) =>
      compareCodePoint(left.current.path, right.current.path),
    ),
    deleted: renameResult.deleted,
    renamed: renameResult.renamed,
    unchanged: unchanged.sort((left, right) =>
      compareCodePoint(left.path, right.path),
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

  for (const key of [...allPaths].sort((left, right) =>
    compareCodePoint(left, right),
  )) {
    const baseEntry = baseMap.get(key);
    const localEntry = localMap.get(key);
    const remoteEntry = remoteMap.get(key);
    const relativePath =
      localEntry?.path ?? remoteEntry?.path ?? baseEntry?.path ?? key;

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
