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

describe("DesktopAppStateStore – extended", () => {
  it("save writes the state to disk and returns the parsed state", async () => {
    const rootDir = await createTempDir("figmake-appstate-save");
    const store = new DesktopAppStateStore(
      path.join(rootDir, "app-state.json"),
    );

    const saved = await store.save({ lastProjectRoot: "/tmp/saved-project" });

    expect(saved.lastProjectRoot).toBe("/tmp/saved-project");
    expect(
      await fs.pathExists(path.join(rootDir, "app-state.json")),
    ).toBe(true);
  });

  it("save creates parent directories if they do not exist", async () => {
    const rootDir = await createTempDir("figmake-appstate-mkdir");
    const store = new DesktopAppStateStore(
      path.join(rootDir, "nested", "dir", "app-state.json"),
    );

    await store.save({ lastProjectRoot: null });

    expect(
      await fs.pathExists(
        path.join(rootDir, "nested", "dir", "app-state.json"),
      ),
    ).toBe(true);
  });

  it("load returns default state when the file contains an empty JSON object", async () => {
    const rootDir = await createTempDir("figmake-appstate-empty");
    const statePath = path.join(rootDir, "app-state.json");

    await fs.writeJson(statePath, {});
    const store = new DesktopAppStateStore(statePath);

    expect(await store.load()).toEqual({ lastProjectRoot: null });
  });

  it("update merges a partial patch into the persisted state", async () => {
    const rootDir = await createTempDir("figmake-appstate-merge");
    const store = new DesktopAppStateStore(
      path.join(rootDir, "app-state.json"),
    );

    await store.save({ lastProjectRoot: "/original" });
    await store.update({ lastProjectRoot: "/updated" });

    expect(await store.load()).toEqual({ lastProjectRoot: "/updated" });
  });

  it("update with null clears the lastProjectRoot", async () => {
    const rootDir = await createTempDir("figmake-appstate-null");
    const store = new DesktopAppStateStore(
      path.join(rootDir, "app-state.json"),
    );

    await store.save({ lastProjectRoot: "/something" });
    await store.update({ lastProjectRoot: null });

    expect(await store.load()).toEqual({ lastProjectRoot: null });
  });
});
