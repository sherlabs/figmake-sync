/**
 * Self-update (electron-updater, GitHub releases of sherlabs/figmake-sync).
 *
 * Wiring (to be done by the app shell; nothing here touches src/electron):
 *
 * main.ts, after the main window is shown:
 *   import { app, BrowserWindow, ipcMain } from "electron";
 *   import { createUpdater, loadAutoUpdater, updatesSupported } from "../updater/index.js";
 *   import { UPDATE_INSTALL_CHANNEL, UPDATE_STATE_CHANNEL } from "../updater/contracts.js";
 *
 *   const enabled = updatesSupported({ isPackaged: app.isPackaged, platform: process.platform,
 *     env: process.env, settingEnabled: settings.updates?.enabled ?? true,
 *     appImage: Boolean(process.env.APPIMAGE) });
 *   if (enabled) {
 *     const updater = createUpdater({
 *       autoUpdater: await loadAutoUpdater(),
 *       currentVersion: app.getVersion(),
 *       isBusy: () => facade.isBusy(),            // sync/agent/pull/push running
 *       logger: { info: log.info, warn: log.warn, error: log.error },
 *       onState: (s) => mainWindow.webContents.send(UPDATE_STATE_CHANNEL, s),
 *     });
 *     ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => updater.installNow());
 *     ipcMain.handle("figmake:update-get", () => updater.getState()); // optional initial read
 *     mainWindow.once("ready-to-show", () => updater.start());       // delays first check ~10s
 *     app.on("before-quit", () => updater.stop());
 *   }
 *
 * preload.cjs (contextBridge.exposeInMainWorld("figmake", { ... })):
 *   onUpdateState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on("figmake:update-state", h);
 *                            return () => ipcRenderer.removeListener("figmake:update-state", h); },
 *   installUpdate: () => ipcRenderer.invoke("figmake:update-install"),
 *
 * renderer: one quiet button, top-right beside the existing controls, rendered only when
 * state.phase === "ready", label exactly "Restart to update", onclick -> installUpdate().
 * No other text, no changelog.
 *
 * Settings: `updates.enabled` (boolean, default true) in app settings. Env FIGMAKE_DISABLE_UPDATES=1
 * also disables. Dev (!app.isPackaged) and unsupported platforms never check.
 *
 * Behavior: autoDownload=true, autoInstallOnAppQuit=true, no prerelease, no downgrade. Checks run
 * ~10s after start() and every 6h, never while isBusy() (retried every minute until idle). All
 * failures are logged, never thrown, never shown. A downloaded update installs on quit; installNow()
 * is the explicit restart and refuses unless phase is "ready" and the app is idle.
 */
import type { UpdateState } from "./contracts.js";

export type { UpdateState, UpdatePhase } from "./contracts.js";

export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BUSY_RETRY_MS = 60_000;

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  currentVersion: string;
  isBusy: () => boolean;
  logger?: UpdaterLogger;
  clock?: Clock;
  onState?: (state: UpdateState) => void;
}

export interface SupportInput {
  isPackaged: boolean;
  platform: string;
  env: Record<string, string | undefined>;
  settingEnabled?: boolean;
  appImage?: boolean;
}

export function updatesSupported(input: SupportInput): boolean {
  if (!input.isPackaged) return false;
  if (input.env["FIGMAKE_DISABLE_UPDATES"] === "1") return false;
  if (input.settingEnabled === false) return false;
  if (input.platform === "darwin" || input.platform === "win32") return true;
  if (input.platform === "linux") return Boolean(input.appImage);
  return false;
}

export async function loadAutoUpdater(): Promise<AutoUpdaterLike> {
  const mod = (await import("electron-updater")) as unknown as {
    autoUpdater?: AutoUpdaterLike;
    default?: { autoUpdater?: AutoUpdaterLike };
  };
  const au = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!au) throw new Error("electron-updater unavailable");
  return au;
}

const NOOP_LOGGER: UpdaterLogger = { info() {}, warn() {}, error() {} };
const SYSTEM_CLOCK: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface Updater {
  start(): void;
  stop(): void;
  getState(): UpdateState;
  installNow(): boolean;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const au = deps.autoUpdater;
  const log = deps.logger ?? NOOP_LOGGER;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  let state: UpdateState = { phase: "idle" };
  let timer: unknown;
  let started = false;
  let checking = false;

  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      log.error(`updater: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const setState = (next: UpdateState): void => {
    state = next;
    safe(() => deps.onState?.({ ...next }));
  };

  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.allowPrerelease = false;
  au.allowDowngrade = false;

  const on = (event: string, fn: (...args: any[]) => void): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    safe(() => au.on(event, fn));
  };
  on("update-available", (info?: { version?: string }) => {
    if (state.phase === "ready") return;
    const v = info?.version;
    setState(v ? { phase: "downloading", version: v } : { phase: "downloading" });
  });
  on("update-not-available", () => {
    if (state.phase === "downloading") setState({ phase: "idle" });
  });
  on("update-downloaded", (info?: { version?: string }) => {
    const v = info?.version;
    setState(v ? { phase: "ready", version: v } : { phase: "ready" });
  });
  on("error", (err: unknown) => {
    log.error(`updater error: ${err instanceof Error ? err.message : String(err)}`);
    if (state.phase === "downloading") setState({ phase: "idle" });
  });

  const schedule = (ms: number): void => {
    if (!started) return;
    timer = clock.setTimeout(() => void tick(), ms);
  };

  async function tick(): Promise<void> {
    if (!started) return;
    if (state.phase === "ready") return; // already have one; installs on quit
    if (checking) return schedule(CHECK_INTERVAL_MS);
    if (safe(() => deps.isBusy()) !== false) {
      log.info("updater: busy, deferring check");
      return schedule(BUSY_RETRY_MS);
    }
    checking = true;
    try {
      await au.checkForUpdates();
    } catch (err) {
      log.error(`updater check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      checking = false;
    }
    schedule(CHECK_INTERVAL_MS);
  }

  return {
    start() {
      if (started) return;
      started = true;
      log.info(`updater: started at ${deps.currentVersion}`);
      schedule(FIRST_CHECK_DELAY_MS);
    },
    stop() {
      started = false;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
    getState: () => ({ ...state }),
    installNow() {
      if (state.phase !== "ready") return false;
      if (safe(() => deps.isBusy()) !== false) return false;
      const ok = safe(() => {
        au.quitAndInstall(false, true);
        return true;
      });
      return ok === true;
    },
  };
}
