import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { DesktopAppStateStore } from "../src/electron/appState.js";

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.remove(tempDir)));
});

describe("DesktopAppStateStore", () => {
  it("persists the last chosen project root", async () => {
    const rootDir = await createTempDir("figmake-desktop-state");
    const store = new DesktopAppStateStore(
      path.join(rootDir, "app-state.json"),
    );

    expect(await store.load()).toEqual({ lastProjectRoot: null });

    await store.update({
      lastProjectRoot: "/tmp/example-project",
    });

    expect(await store.load()).toEqual({
      lastProjectRoot: "/tmp/example-project",
    });
  });
});
