import { describe, expect, it, vi } from "vitest";

import { createHealingAdapterFactory } from "../src/app/healing.js";
import { DiagnosticsLog } from "../src/app/report.js";
import type { AdapterContext } from "../src/figma/adapter.js";
import { createHealContext } from "../src/heal/index.js";
import { createUpdater, updatesSupported, type AutoUpdaterLike } from "../src/updater/index.js";

const ctx = (info = vi.fn()): AdapterContext =>
  ({ config: {}, logger: { info, warn: vi.fn() }, paths: { artifactsDir: "/art" } }) as unknown as AdapterContext;

describe("self-heal wiring", () => {
  const make = (agent: "claude" | "codex" | null) => {
    const runOneShot = vi.fn(() => Promise.resolve({ ok: false as const, code: "failed" as const, message: "x" }));
    const heal = createHealContext({ userDataDir: "/ud", runOneShot, getAgentId: () => agent });
    const base = vi.fn(() => ({}) as never);
    const diagnostics = new DiagnosticsLog(() => ({}));
    const factory = createHealingAdapterFactory({ heal, hasAgent: () => agent !== null, diagnostics, base });
    return { factory, base, runOneShot, diagnostics, heal };
  };

  it("hands the shared heal context (with the project's artifacts dir) to every adapter when an agent is chosen", () => {
    const { factory, base, heal } = make("claude");
    factory(ctx());
    factory(ctx());
    const given = base.mock.calls.map((c) => (c as unknown as [AdapterContext])[0].heal);
    expect(given).toHaveLength(2);
    expect(given[0]?.store).toBe(heal.store);
    expect(given[0]?.healer).toBeTypeOf("function");
    expect(given[0]?.artifactsDir).toBe("/art");
    expect(heal.localSelectorsPath).toBe("/ud/selectors.local.json");
  });

  it("without an agent, nothing is attempted (learned fixes still apply)", () => {
    const { factory, base, runOneShot } = make(null);
    factory(ctx());
    const heal = (base.mock.calls[0] as unknown as [AdapterContext])[0].heal;
    expect(heal?.healer).toBeUndefined();
    expect(heal?.store).toBeDefined();
    expect(runOneShot).not.toHaveBeenCalled();
  });

  it("a healer whose agent was cleared mid-run answers null without running anything", async () => {
    const { heal, runOneShot } = make(null);
    expect(await heal.healer?.({} as never)).toBeNull();
    expect(runOneShot).not.toHaveBeenCalled();
  });

  it("heal results are logged and recorded by key only", () => {
    const { factory, base, diagnostics } = make("codex");
    const info = vi.fn();
    factory(ctx(info));
    const logger = (base.mock.calls[0] as unknown as [AdapterContext])[0].logger;
    logger.info({ key: "promptSendButton", selector: "button[aria-label='Secret Project']" }, "healed selector");
    logger.info({ key: "codeModeButton", notes: [{ selector: "x" }] }, "heal failed");
    logger.info({ key: "other" }, "unrelated message");
    expect(info).toHaveBeenCalledTimes(3);
    expect(diagnostics.healSummary()).toEqual(["promptSendButton: healed", "codeModeButton: failed"]);
    expect(diagnostics.tail().join("\n")).not.toContain("Secret");
  });
});

describe("updater wiring", () => {
  it("never checks while the facade is busy and honours the setting", async () => {
    vi.useFakeTimers();
    let busy = true;
    const au = { autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true, allowDowngrade: true, on: vi.fn(), checkForUpdates: vi.fn(() => Promise.resolve(undefined)), quitAndInstall: vi.fn() };
    const u = createUpdater({ autoUpdater: au as unknown as AutoUpdaterLike, currentVersion: "1.0.0", isBusy: () => busy });
    u.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(au.checkForUpdates).toHaveBeenCalled();
    u.stop();
    vi.useRealTimers();
    const base = { isPackaged: true, platform: "darwin", env: {} };
    expect(updatesSupported({ ...base, settingEnabled: true })).toBe(true);
    expect(updatesSupported({ ...base, settingEnabled: false })).toBe(false);
    expect(updatesSupported({ ...base, isPackaged: false })).toBe(false);
  });
});
