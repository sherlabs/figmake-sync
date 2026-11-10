/**
 * Self-update (electron-updater, GitHub releases of sherlabs/figmake-sync).
 *
 * Automatic checks run ~10s after start() and every 4h, never while isBusy() (retried every minute
 * until idle). A manual checkNow() works whether or not automatic checks are on, is never run twice
 * at once, and is rate-limited to one real check every few seconds. Failures are logged and surface
 * as a plain `error` sentence in the state. A downloaded update installs on quit; installNow() is the
 * explicit restart and refuses unless phase is "ready" and the app is idle.
 *
 * Settings: `updates.enabled` (boolean, default true) turns the automatic checks off. Env
 * FIGMAKE_DISABLE_UPDATES=1 disables everything. Dev (!app.isPackaged) never checks.
 */
import type { UpdateState } from "./contracts.js";

export type { UpdateState, UpdatePhase } from "./contracts.js";

export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const MANUAL_COOLDOWN_MS = 5_000;
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
  now?: () => number;
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
  /** Manual "Check for updates". Resolves with the state once the check (not the download) is done. */
  checkNow(): Promise<UpdateState>;
}

export const CHECK_FAILED = "Couldn't check. Try again.";

export function createUpdater(deps: UpdaterDeps): Updater {
  const au = deps.autoUpdater;
  const log = deps.logger ?? NOOP_LOGGER;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const now = deps.now ?? Date.now;
  let state: UpdateState = { phase: "idle", currentVersion: deps.currentVersion, supported: true, upToDate: false };
  let timer: unknown;
  let started = false;
  let inFlight: Promise<UpdateState> | null = null;
  let lastRunAt = -Infinity;

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
  const stamp = (): string => new Date(now()).toISOString();
  const withVersion = (next: UpdateState, v: string | undefined): UpdateState => (v ? { ...next, version: v } : next);
  const clean = (): UpdateState => {
    const { error: _e, version: _v, ...rest } = state; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  };

  on("checking-for-update", () => {
    if (state.phase === "idle") setState({ ...clean(), phase: "checking" });
  });
  on("update-available", (info?: { version?: string }) => {
    if (state.phase === "ready") return;
    setState(withVersion({ ...clean(), phase: "downloading", upToDate: false, lastCheckedAt: stamp() }, info?.version));
  });
  on("update-not-available", () => {
    if (state.phase === "ready" || state.phase === "downloading") return;
    setState({ ...clean(), phase: "idle", upToDate: true, lastCheckedAt: stamp() });
  });
  on("update-downloaded", (info?: { version?: string }) => {
    setState(withVersion({ ...clean(), phase: "ready", upToDate: false }, info?.version ?? state.version));
  });
  on("error", (err: unknown) => {
    log.error(`updater error: ${err instanceof Error ? err.message : String(err)}`);
    if (state.phase === "checking" || state.phase === "downloading") {
      setState({ ...clean(), phase: "idle", upToDate: false, error: CHECK_FAILED, lastCheckedAt: stamp() });
    }
  });

  const schedule = (ms: number): void => {
    if (!started) return;
    timer = clock.setTimeout(() => void tick(), ms);
  };

  /** One real check, shared by everyone who asks while it runs. */
  function runCheck(): Promise<UpdateState> {
    if (inFlight) return inFlight;
    lastRunAt = now();
    if (state.phase === "idle") setState({ ...clean(), phase: "checking" });
    inFlight = (async () => {
      try {
        await au.checkForUpdates();
        // electron-updater reports the outcome through events; this only covers a silent finish.
        if (state.phase === "checking") setState({ ...clean(), phase: "idle", upToDate: true, lastCheckedAt: stamp() });
      } catch (err) {
        log.error(`updater check failed: ${err instanceof Error ? err.message : String(err)}`);
        if (state.phase === "checking" || state.phase === "idle") {
          setState({ ...clean(), phase: "idle", upToDate: false, error: CHECK_FAILED, lastCheckedAt: stamp() });
        }
      } finally {
        inFlight = null;
      }
      return { ...state };
    })();
    return inFlight;
  }

  async function tick(): Promise<void> {
    if (!started) return;
    if (state.phase === "ready" || state.phase === "downloading") return schedule(CHECK_INTERVAL_MS); // already have one; installs on quit
    if (inFlight) return schedule(CHECK_INTERVAL_MS);
    if (safe(() => deps.isBusy()) !== false) {
      log.info("updater: busy, deferring check");
      return schedule(BUSY_RETRY_MS);
    }
    await runCheck();
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
    checkNow() {
      if (state.phase === "ready" || state.phase === "downloading") return Promise.resolve({ ...state });
      if (inFlight) return inFlight;
      if (now() - lastRunAt < MANUAL_COOLDOWN_MS) return Promise.resolve({ ...state });
      return runCheck();
    },
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
