import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OVERRIDE_TTL_MS, SelectorOverrideStore } from "../src/heal/overrideStore.js";

let dir: string;
let file: string;
let clock: number;
const mk = (extra: Partial<ConstructorParameters<typeof SelectorOverrideStore>[0]> = {}): SelectorOverrideStore =>
  new SelectorOverrideStore({ filePath: file, now: () => clock, ...extra });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "heal-store-"));
  file = path.join(dir, "selector-overrides.json");
  clock = Date.parse("2026-01-01T00:00:00Z");
});
afterEach(() => fs.remove(dir));

describe("SelectorOverrideStore", () => {
  it("persists atomically and reloads", async () => {
    const a = mk();
    await a.set("codeModeButton", ['button[aria-label="Show code"]'], "fp1");
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const raw = (await fs.readJson(file)) as { overrides: Record<string, { selectors: string[]; figmaUiFingerprint: string; hits: number }> };
    expect(raw.overrides["codeModeButton"]).toMatchObject({ selectors: ['button[aria-label="Show code"]'], figmaUiFingerprint: "fp1", hits: 0 });
    const b = mk();
    await b.load();
    expect(b.get("codeModeButton")).toEqual(['button[aria-label="Show code"]']);
    expect(b.get("other")).toEqual([]);
  });

  it("expires after 30 days", async () => {
    const a = mk();
    await a.set("codeModeButton", ["text=Code"], "fp");
    clock += OVERRIDE_TTL_MS - 1000;
    expect(a.get("codeModeButton")).toEqual(["text=Code"]);
    clock += 2000;
    expect(a.get("codeModeButton")).toEqual([]);
    const b = mk();
    await b.load();
    expect(b.get("codeModeButton")).toEqual([]);
  });

  it("counts consecutive misses, resets on hit, drops after N", async () => {
    const a = mk({ maxMisses: 3 });
    await a.set("codeModeButton", ["text=Code"], "fp");
    await a.recordMiss("codeModeButton");
    await a.recordMiss("codeModeButton");
    expect(a.entry("codeModeButton")?.misses).toBe(2);
    a.recordHit("codeModeButton");
    expect(a.entry("codeModeButton")).toMatchObject({ misses: 0, hits: 1 });
    await a.recordMiss("codeModeButton");
    await a.recordMiss("codeModeButton");
    await a.recordMiss("codeModeButton");
    expect(a.get("codeModeButton")).toEqual([]);
    await a.flush();
    const b = mk();
    await b.load();
    expect(b.get("codeModeButton")).toEqual([]);
  });

  it("ignores corrupt files, wrong schema and tampered (grammar-violating) selectors", async () => {
    await fs.writeFile(file, "{not json");
    const a = mk();
    await a.load();
    expect(a.get("codeModeButton")).toEqual([]);
    await fs.writeJson(file, { version: 2, overrides: {} });
    await a.load();
    expect(a.get("codeModeButton")).toEqual([]);
    await fs.writeJson(file, {
      version: 1,
      overrides: {
        codeModeButton: { selectors: ["javascript:alert(1)"], learnedAt: new Date(clock).toISOString(), figmaUiFingerprint: "x", hits: 0, misses: 0 },
        okKey: { selectors: ["text=Code"], learnedAt: new Date(clock).toISOString(), figmaUiFingerprint: "x", hits: 0, misses: 0 },
      },
    });
    await a.load();
    expect(a.get("codeModeButton")).toEqual([]);
    expect(a.get("okKey")).toEqual(["text=Code"]);
  });

  it("refuses to store invalid selectors and tracks heal-failure cooldown", async () => {
    const a = mk();
    await a.set("k", ["javascript:1"], "fp");
    expect(a.get("k")).toEqual([]);
    expect(a.inCooldown("k")).toBe(false);
    a.recordHealFailure("k");
    expect(a.inCooldown("k")).toBe(true);
    clock += 2 * 60 * 60 * 1000;
    expect(a.inCooldown("k")).toBe(false);
  });
});
