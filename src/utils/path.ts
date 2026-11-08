import fs from "node:fs";
import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function resolveRelativePath(
  rootDir: string,
  relativePath: string,
): string {
  return path.resolve(rootDir, relativePath);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

// Resolves symlinks on the deepest existing ancestor, then re-appends the rest.
function realpathOfExisting(target: string): string {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);

      if (parent === current) {
        return target;
      }

      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function assertPathInsideRoot(
  rootDir: string,
  candidatePath: string,
): string {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);

  if (
    !isInside(root, candidate) ||
    !isInside(realpathOfExisting(root), realpathOfExisting(candidate))
  ) {
    throw new Error(`Refusing to operate outside project root: ${candidate}`);
  }

  return candidate;
}

export function normalizeRelativePath(
  rootDir: string,
  absolutePath: string,
): string {
  return toPosixPath(path.relative(rootDir, absolutePath));
}
