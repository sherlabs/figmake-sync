import fs from "fs-extra";
import { createPatch } from "diff";

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

  const [remoteContent, localContent] = await Promise.all([
    fs.readFile(remotePath, "utf8"),
    fs.readFile(localPath, "utf8"),
  ]);

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
