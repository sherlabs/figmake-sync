import path from "node:path";

import AdmZip from "adm-zip";
import fs from "fs-extra";

import { assertPathInsideRoot, toPosixPath } from "./path.js";

export async function extractZipSafely(
  zipPath: string,
  targetDir: string,
): Promise<string[]> {
  const zip = new AdmZip(zipPath);
  const extractedFiles: string[] = [];

  await fs.emptyDir(targetDir);

  for (const entry of zip.getEntries()) {
    const normalizedEntryPath = toPosixPath(entry.entryName).replace(
      /^\/+/,
      "",
    );

    if (!normalizedEntryPath) {
      continue;
    }

    const destinationPath = assertPathInsideRoot(
      targetDir,
      path.join(targetDir, normalizedEntryPath),
    );

    if (entry.isDirectory) {
      await fs.ensureDir(destinationPath);
      continue;
    }

    await fs.ensureDir(path.dirname(destinationPath));
    await fs.writeFile(destinationPath, entry.getData());
    extractedFiles.push(normalizedEntryPath);
  }

  return extractedFiles.sort((left, right) => left.localeCompare(right));
}

export async function createZipFromDirectory(
  sourceDir: string,
  destinationZipPath: string,
): Promise<string> {
  const zip = new AdmZip();

  zip.addLocalFolder(sourceDir);
  await fs.ensureDir(path.dirname(destinationZipPath));
  zip.writeZip(destinationZipPath);

  return destinationZipPath;
}
