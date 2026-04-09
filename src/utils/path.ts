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

export function assertPathInsideRoot(
  rootDir: string,
  candidatePath: string,
): string {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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
