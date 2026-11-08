import fs from "fs-extra";
import { createPatch } from "diff";

const MAX_PREVIEW_BYTES = 1024 * 1024;

export async function createTextPatchPreview(
  remotePath: string,
  localPath: string,
  relativePath: string,
): Promise<string | undefined> {
  const [remoteExists, localExists] = await Promise.all([
    fs.pathExists(remotePath),
    fs.pathExists(localPath),
  ]);

  if (!remoteExists || !localExists) {
    return undefined;
  }

  const [remoteStat, localStat] = await Promise.all([
    fs.stat(remotePath),
    fs.stat(localPath),
  ]);

  if (
    remoteStat.size > MAX_PREVIEW_BYTES ||
    localStat.size > MAX_PREVIEW_BYTES
  ) {
    return undefined;
  }

  const [remoteBuffer, localBuffer] = await Promise.all([
    fs.readFile(remotePath),
    fs.readFile(localPath),
  ]);

  if (remoteBuffer.includes(0) || localBuffer.includes(0)) {
    return undefined;
  }

  const remoteContent = remoteBuffer.toString("utf8");
  const localContent = localBuffer.toString("utf8");

  const patch = createPatch(
    relativePath,
    remoteContent,
    localContent,
    "remote",
    "local",
  );
  const lines = patch.split("\n").slice(0, 80);

  return lines.join("\n");
}
