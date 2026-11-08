import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { describe, expect, it } from "vitest";

import { DesktopAppStateStore } from "../src/electron/appState.js";

describe("DesktopAppStateStore", () => {
  it("recovers from corrupt JSON and writes atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstate-"));
    const file = path.join(dir, "app-state.json");
    await fs.writeFile(file, '{"lastProjectRo');
    const store = new DesktopAppStateStore(file);
    expect(await store.load()).toEqual({ lastProjectRoot: null });
    await Promise.all([
      store.update({ lastProjectRoot: "/a" }),
      store.update({ lastProjectRoot: "/b" }),
    ]);
    expect((await store.load()).lastProjectRoot).toBe("/b");
    const names = await fs.readdir(dir);
    expect(names.some((n) => n.includes(".corrupt-"))).toBe(true);
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    await fs.remove(dir);
  });
});
