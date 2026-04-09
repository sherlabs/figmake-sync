import path from "node:path";

import fs from "fs-extra";

const projectRoot = process.cwd();
const sourceElectronDir = path.join(projectRoot, "src", "electron");
const sourceRendererDir = path.join(projectRoot, "src", "electron", "renderer");
const destinationElectronDir = path.join(
  projectRoot,
  "dist",
  "src",
  "electron",
);
const destinationRendererDir = path.join(
  projectRoot,
  "dist",
  "src",
  "electron",
  "renderer",
);

await fs.ensureDir(destinationElectronDir);
await fs.ensureDir(destinationRendererDir);

const preloadSourcePath = path.join(sourceElectronDir, "preload.cjs");
const preloadDestinationPath = path.join(destinationElectronDir, "preload.cjs");

if (await fs.pathExists(preloadSourcePath)) {
  await fs.copy(preloadSourcePath, preloadDestinationPath, { overwrite: true });
}

const entries = await fs.readdir(sourceRendererDir);

for (const entry of entries) {
  if (entry.endsWith(".ts")) {
    continue;
  }

  await fs.copy(
    path.join(sourceRendererDir, entry),
    path.join(destinationRendererDir, entry),
    { overwrite: true },
  );
}
