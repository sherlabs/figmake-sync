import { describe, expect, it, vi } from "vitest";

import {
  BUSY_RETRY_MS,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  createUpdater,
  updatesSupported,
  type AutoUpdaterLike,
} from "../src/updater/index.js";

function fake() {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const au = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: true,
    on: vi.fn((e: string, fn: (...a: unknown[]) => void) => {
      handlers[e] = fn;
    }),
    checkForUpdates: vi.fn(() => Promise.resolve(undefined)),
    quitAndInstall: vi.fn(),
  };
  return { au: au as unknown as AutoUpdaterLike & typeof au, handlers };
}

const setup = (busy = () => false) => {
  vi.useFakeTimers();
  const { au, handlers } = fake();
  const states: unknown[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const u = createUpdater({
    autoUpdater: au,
    currentVersion: "0.1.11",
    isBusy: busy,
    logger,
    onState: (s) => states.push(s),
  });
  return { au, handlers, states, logger, u };
};

describe("updater", () => {
  it("sets safe config", () => {
    const { au } = setup();
    expect([au.autoDownload, au.autoInstallOnAppQuit, au.allowPrerelease, au.allowDowngrade]).toEqual([
      true, true, false, false,
    ]);
  });

  it("first check after delay, then every 6h", async () => {
    const { au, u } = setup();
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(2);
    u.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("defers while busy and retries until idle", async () => {
    let busy = true;
    const { au, u } = setup(() => busy);
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + BUSY_RETRY_MS * 3);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing isBusy as busy", async () => {
    const { au, u } = setup(() => {
      throw new Error("x");
    });
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
  });

  it("maps events to state", () => {
    const { handlers, states, u } = setup();
    handlers["update-available"]!({ version: "0.1.12" });
    expect(u.getState()).toEqual({ phase: "downloading", version: "0.1.12" });
    handlers["update-downloaded"]!({ version: "0.1.12" });
    expect(u.getState()).toEqual({ phase: "ready", version: "0.1.12" });
    expect(states).toEqual([
      { phase: "downloading", version: "0.1.12" },
      { phase: "ready", version: "0.1.12" },
    ]);
  });

  it("not-available and errors while downloading go back to idle; errors are logged only", () => {
    const { handlers, u, logger } = setup();
    handlers["update-available"]!({ version: "1" });
    handlers["error"]!(new Error("net"));
    expect(u.getState().phase).toBe("idle");
    expect(logger.error).toHaveBeenCalled();
    handlers["update-available"]!({ version: "1" });
    handlers["update-not-available"]!();
    expect(u.getState().phase).toBe("idle");
  });

  it("a ready update is not overwritten and stops further checks", async () => {
    const { au, handlers, u } = setup();
    handlers["update-downloaded"]!({ version: "2" });
    handlers["update-available"]!({ version: "3" });
    expect(u.getState()).toEqual({ phase: "ready", version: "2" });
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
  });

  it("swallows check rejections and keeps scheduling", async () => {
    const { au, u, logger } = setup();
    au.checkForUpdates.mockRejectedValue(new Error("offline"));
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it("installNow only when ready and idle", () => {
    let busy = false;
    const { au, handlers, u } = setup(() => busy);
    expect(u.installNow()).toBe(false);
    handlers["update-downloaded"]!({ version: "2" });
    busy = true;
    expect(u.installNow()).toBe(false);
    expect(au.quitAndInstall).not.toHaveBeenCalled();
    busy = false;
    expect(u.installNow()).toBe(true);
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a throwing onState does not break the updater", () => {
    vi.useFakeTimers();
    const { au, handlers } = fake();
    const u = createUpdater({ autoUpdater: au, currentVersion: "1", isBusy: () => false, onState: () => { throw new Error("ui"); } });
    expect(() => handlers["update-downloaded"]!({ version: "2" })).not.toThrow();
    expect(u.getState().phase).toBe("ready");
  });
});

describe("updatesSupported", () => {
  const base = { isPackaged: true, platform: "darwin", env: {} };
  it("enabled when packaged on mac/win", () => {
    expect(updatesSupported(base)).toBe(true);
    expect(updatesSupported({ ...base, platform: "win32" })).toBe(true);
  });
  it("off in dev, env, setting, linux non-AppImage", () => {
    expect(updatesSupported({ ...base, isPackaged: false })).toBe(false);
    expect(updatesSupported({ ...base, env: { FIGMAKE_DISABLE_UPDATES: "1" } })).toBe(false);
    expect(updatesSupported({ ...base, settingEnabled: false })).toBe(false);
    expect(updatesSupported({ ...base, platform: "linux" })).toBe(false);
    expect(updatesSupported({ ...base, platform: "linux", appImage: true })).toBe(true);
  });
});
