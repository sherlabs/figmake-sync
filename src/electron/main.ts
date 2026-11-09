import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import fs from "fs-extra";

import {
  isBrowserInstalled,
  installPlaywrightBrowser,
  isPlaywrightBrowserMissingError,
} from "../browser/install.js";
import * as sessionModule from "../browser/session.js";
import { BrowserSessionManager } from "../browser/session.js";
import { FigmakeSyncService } from "../core/service.js";
import {
  HarnessService,
  isSafeLocalUrl,
  rootDirInputSchema,
  runAgentInputSchema,
  toChangeSet,
  updateSettingsInputSchema,
  type HarnessEvent,
} from "../harness/index.js";
import { trackEvent } from "./analytics.js";
import type {
  DesktopAppState,
  DesktopProjectCommandOptions,
  DesktopProgressEvent,
} from "./contracts.js";
import { DesktopAppStateStore } from "./appState.js";

const APP_ID = "com.figmake.sync";

let service!: FigmakeSyncService;
let harness!: HarnessService;

let mainWindow: BrowserWindow | null = null;
let appStateStore: DesktopAppStateStore | null = null;
let activeOperation = false;
let activeOperationName: string | null = null;
let activeController: AbortController | null = null;
let activeDone: Promise<unknown> | null = null;
let quitting = false;
let lastAuthState: boolean | null = null;
const knownProjectRoots = new Set<string>();
const execFileAsync = promisify(execFile);

const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; object-src 'none'; base-uri 'none'; form-action 'none'";

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on("second-instance", () => {
  const window = getLiveWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});

app.setName("figmake-sync");
app.setAppUserModelId(APP_ID);

function getStartupLogPath(): string {
  return path.join(app.getPath("userData"), "startup.log");
}

async function writeStartupLog(
  message: string,
  error?: unknown,
): Promise<void> {
  const details =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
      : "";
  const line = `[${new Date().toISOString()}] ${message}${details ? `\n${details}` : ""}\n\n`;

  await fs.ensureDir(path.dirname(getStartupLogPath()));
  await fs.appendFile(getStartupLogPath(), line, "utf8");
}

async function reportStartupError(
  message: string,
  error?: unknown,
): Promise<void> {
  await writeStartupLog(message, error).catch(() => undefined);
  console.error(message, error);

  if (app.isReady()) {
    const detail =
      error instanceof Error
        ? `${error.message}\n\nSee startup log:\n${getStartupLogPath()}`
        : `See startup log:\n${getStartupLogPath()}`;

    dialog.showErrorBox(
      "figmake-sync failed to launch",
      `${message}\n\n${detail}`,
    );
  }
}

function getAppStateStore(): DesktopAppStateStore {
  if (!appStateStore) {
    appStateStore = new DesktopAppStateStore(
      path.join(app.getPath("userData"), "app-state.json"),
    );
  }

  return appStateStore;
}

function getRendererAssetPath(...segments: string[]): string {
  return path.join(import.meta.dirname, "renderer", ...segments);
}

function getPreloadPath(): string {
  return path.join(import.meta.dirname, "preload.cjs");
}

function getAppIconPath(): string {
  return getRendererAssetPath("assets", "icon-512.png");
}

function getLiveWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return undefined;
}

async function abortActiveAndWait(timeoutMs = 8_000): Promise<void> {
  activeController?.abort();
  const done = activeDone;
  if (!done) return;
  await Promise.race([
    done.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function confirmBusyExit(what: string): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: "warning",
    message: `A sync action (${activeOperationName ?? "operation"}) is still running.`,
    detail: `${what} will cancel it and close the browser session. A partially applied push may need to be re-run.`,
    buttons: ["Keep Running", "Cancel Action and Exit"],
    defaultId: 0,
    cancelId: 0,
  };
  const window = getLiveWindow();
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 720,
    show: false,
    center: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e20" : "#ffffff",
    icon: getAppIconPath(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
    },
  });

  window.on("close", (event) => {
    if (quitting || !activeOperation) return;
    event.preventDefault();
    void confirmBusyExit("Closing the window").then(async (ok) => {
      if (!ok) return;
      await abortActiveAndWait();
      if (activeOperation) quitting = process.platform !== "darwin";
      if (!window.isDestroyed()) window.destroy();
    });
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      void reportStartupError(
        `Renderer failed to load (${errorCode}: ${errorDescription}) for ${validatedUrl}.`,
      );
    },
  );

  window.webContents.on("render-process-gone", (_event, details) => {
    void reportStartupError(
      `Renderer process exited unexpectedly (${details.reason}).`,
    );
  });

  window.webContents.on("console-message", (_event, _level, message) => {
    void writeStartupLog(`Renderer console: ${message}`);
  });

  await window.loadFile(getRendererAssetPath("index.html"));

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

function sendProgress(
  message: string,
  details: Partial<Omit<DesktopProgressEvent, "message" | "timestamp">> = {},
): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  const payload: DesktopProgressEvent = {
    message,
    timestamp: new Date().toISOString(),
    ...details,
  };

  mainWindow.webContents.send("figmake:progress", payload);
}

async function confirmFromUi(
  message: string,
  defaultValue = false,
): Promise<boolean> {
  const buttons = defaultValue
    ? ["Continue", "Cancel"]
    : ["Cancel", "Continue"];
  const defaultId = defaultValue ? 0 : 1;
  const cancelId = defaultValue ? 1 : 0;
  const window = getLiveWindow();
  const options: MessageBoxOptions = {
    type: "question",
    message,
    buttons,
    defaultId,
    cancelId,
    normalizeAccessKeys: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);

  return result.response === defaultId;
}

async function waitForManualAction(message: string): Promise<void> {
  const window = getLiveWindow();
  const options: MessageBoxOptions = {
    type: "info",
    message: "Complete authentication in the opened browser window.",
    detail: message,
    buttons: ["I Finished Logging In"],
    defaultId: 0,
    cancelId: 0,
  };

  if (window) {
    await dialog.showMessageBox(window, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

async function withOperationLock<T>(
  name: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (activeOperation) {
    throw new Error(
      `figmake-sync is busy running "${activeOperationName ?? "another action"}". Wait for it to finish or cancel it, then try again.`,
    );
  }

  const controller = new AbortController();
  activeOperation = true;
  activeOperationName = name;
  activeController = controller;
  const run = operation(controller.signal);
  activeDone = run;

  try {
    return await run;
  } finally {
    activeOperation = false;
    activeOperationName = null;
    activeController = null;
    activeDone = null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation cancelled.");
}

let browserInstalledThisSession = false;

async function ensureBrowserRuntimeInstalled(): Promise<void> {
  if (browserInstalledThisSession) return;

  const installed = await isBrowserInstalled();
  if (installed) {
    browserInstalledThisSession = true;
    return;
  }

  const approved = await confirmFromUi(
    "Playwright Chromium is not installed yet. Install the local browser runtime now?",
    true,
  );

  if (!approved) {
    throw new Error(
      "Playwright Chromium is required before browser-backed actions can run. Use Install Browser and then retry.",
    );
  }

  await installPlaywrightBrowser({
    browser: "chromium",
    progress: (event) => {
      sendProgress(event.message, {
        scope: "browser-install",
        ...(event.percent !== undefined ? { percent: event.percent } : {}),
      });
    },
  });

  browserInstalledThisSession = true;
}

async function withBrowserInstallRecovery<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  // Proactive check — install once before first attempt
  await ensureBrowserRuntimeInstalled();

  try {
    return await operation();
  } catch (error) {
    if (!isPlaywrightBrowserMissingError(error)) {
      throw error;
    }

    // Edge case: binary disappeared after check (e.g. antivirus quarantine)
    browserInstalledThisSession = false;
    sendProgress("Playwright browser runtime is missing — reinstalling");
    await ensureBrowserRuntimeInstalled();
    sendProgress("Retrying after browser install");
    throwIfAborted(signal);

    return operation();
  }
}

function toRuntimeOptions(
  options: DesktopProjectCommandOptions,
  signal?: AbortSignal,
) {
  return {
    projectRoot: options.rootDir,
    dryRun: options.dryRun,
    verbose: options.verbose,
    prompt: options.prompt,
    strategy: options.strategy,
    ...(options.headless != null ? { headless: options.headless } : {}),
    progress: (message: string) => {
      sendProgress(message);
    },
    confirm: confirmFromUi,
    waitForManualAction,
    ...(signal ? { signal } : {}),
  };
}

async function persistLastProjectRoot(
  rootDir: string,
): Promise<DesktopAppState> {
  knownProjectRoots.add(path.resolve(rootDir));
  return getAppStateStore().update({
    lastProjectRoot: rootDir,
  });
}

async function clearPersistedProjectRootIfMatches(
  rootDir: string,
): Promise<boolean> {
  const appState = await getAppStateStore().load();

  if (appState.lastProjectRoot !== rootDir) {
    return false;
  }

  await getAppStateStore().update({
    lastProjectRoot: null,
  });

  return true;
}

function sendHarnessEvent(event: HarnessEvent): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("figmake:harness:event", event);
}

async function harnessRoot(input: unknown): Promise<string> {
  const { rootDir } = rootDirInputSchema.parse(input);
  const allowed = await resolveAllowedPath(rootDir, true);
  if (!allowed) throw new Error("Not a known figmake-sync project folder.");
  return allowed;
}

function registerHarnessHandlers(): void {
  ipcMain.handle("figmake:harness:detect-agents", () => harness.detectAgents());
  ipcMain.handle("figmake:harness:get-settings", async (_e, input: unknown) =>
    harness.getSettings(await harnessRoot(input)),
  );
  ipcMain.handle("figmake:harness:update-settings", async (_e, input: unknown) => {
    const parsed = updateSettingsInputSchema.parse(input);
    const root = await harnessRoot({ rootDir: parsed.rootDir });
    return harness.updateSettings(root, parsed.patch);
  });
  ipcMain.handle("figmake:harness:setup", async (_e, input: unknown) => {
    const root = await harnessRoot(input);
    return withOperationLock("harness-setup", (signal) => harness.setup(root, signal));
  });
  ipcMain.handle("figmake:harness:dev-start", async (_e, input: unknown) =>
    harness.startDev(await harnessRoot(input)),
  );
  ipcMain.handle("figmake:harness:dev-stop", async (_e, input: unknown) =>
    harness.stopDev(await harnessRoot(input)),
  );
  ipcMain.handle("figmake:harness:dev-status", async (_e, input: unknown) =>
    harness.devStatus(await harnessRoot(input)),
  );
  ipcMain.handle("figmake:harness:dev-open", async (_e, input: unknown) => {
    const { url, state: devState } = harness.devStatus(await harnessRoot(input));
    if (devState !== "running" || !isSafeLocalUrl(url)) return { opened: false, error: "Dev server is not running on a local URL." };
    await shell.openExternal(url);
    return { opened: true, url };
  });
  ipcMain.handle("figmake:harness:cancel-run", async (_e, input: unknown) => ({
    cancelled: harness.cancelRun(await harnessRoot(input)),
  }));
  ipcMain.handle("figmake:harness:changes", async (_e, input: unknown) =>
    toChangeSet(await service.status({ projectRoot: await harnessRoot(input) })),
  );
  ipcMain.handle("figmake:harness:run-agent", async (_e, input: unknown) => {
    const parsed = runAgentInputSchema.parse(input);
    const root = await harnessRoot({ rootDir: parsed.rootDir });
    // The run holds the global operation lock for its whole duration (cancel + quit confirm cover it);
    // the invoke resolves as soon as the run has started.
    return new Promise<{ runId: string }>((resolve, reject) => {
      void withOperationLock("agent-run", async (signal) => {
        try {
          const { runId, done } = await harness.startRun(
            {
              rootDir: root,
              prompt: parsed.prompt,
              agent: parsed.agent,
              newSession: parsed.newSession,
            },
            signal,
          );
          resolve({ runId });
          await done;
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }).catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

function getSharedBrowserProfileDir(): string {
  return path.join(app.getPath("userData"), "browser-profile");
}

function registerIpcHandlers(): void {
  ipcMain.handle("figmake:load-app-state", () => getAppStateStore().load());

  ipcMain.handle("figmake:check-auth-status", async () => {
    const profileDir = getSharedBrowserProfileDir();
    // Probing launches the profile; never do it while an operation holds it.
    if (activeOperation) {
      return {
        authenticated: lastAuthState ?? false,
        profileDir,
        unknown: true,
        reason: "An action is running; session state not re-checked.",
      };
    }
    const probe = (
      sessionModule as {
        probeLoginState?: (dir: string) => Promise<{
          authenticated: boolean | null;
          reason?: string;
        }>;
      }
    ).probeLoginState;
    if (typeof probe !== "function") {
      return {
        authenticated: false,
        profileDir,
        unknown: true,
        reason: "Login probe unavailable.",
      };
    }
    try {
      const result = await probe(profileDir);
      if (result.authenticated !== null) lastAuthState = result.authenticated;
      return {
        authenticated: result.authenticated === true,
        profileDir,
        ...(result.authenticated === null ? { unknown: true } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      return {
        authenticated: false,
        profileDir,
        unknown: true,
        reason: error instanceof Error ? error.message : "Login probe failed.",
      };
    }
  });

  ipcMain.handle("figmake:cancel-operation", () => {
    if (!activeController || activeController.signal.aborted) {
      return { cancelled: false };
    }
    activeController.abort();
    sendProgress("Cancelling current action");
    return { cancelled: true };
  });

  ipcMain.handle("figmake:select-project-directory", async () => {
    const focusedWindow =
      getLiveWindow();
    const options: OpenDialogOptions = {
      title: "Choose a local figmake-sync project folder",
      buttonLabel: "Use Folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const [rootDir] = result.filePaths;

    if (!rootDir) {
      return null;
    }

    await persistLastProjectRoot(rootDir);
    return service.inspectProject(rootDir);
  });

  ipcMain.handle("figmake:inspect-project", async (_event, rootDir: string) => {
    await persistLastProjectRoot(rootDir);
    // Project switch: dev servers of other projects must not keep running.
    void harness.stopDevExcept(rootDir);
    return service.inspectProject(rootDir);
  });

  ipcMain.handle(
    "figmake:delete-project",
    async (_event, rootDir: string) =>
      withOperationLock("delete-project", async () => {
        const focusedWindow =
          getLiveWindow();
        const approved = await confirmFromUi(
          "Delete this project from figmake-sync? This removes the local .figmake-sync state for the selected folder but keeps your actual project files.",
        );

        if (!approved) {
          throw new Error("Project deletion cancelled.");
        }

        const { resolveProjectStatePaths } = await import("../core/state.js");
        const paths = resolveProjectStatePaths(rootDir);
        const removedStateDir = await fs.pathExists(paths.stateDir);

        if (removedStateDir) {
          await fs.remove(paths.stateDir);
        }

        const removedFromAppState =
          await clearPersistedProjectRootIfMatches(rootDir);

        if (focusedWindow) {
          await dialog.showMessageBox(focusedWindow, {
            type: "info",
            buttons: ["OK"],
            message: "Project deleted from figmake-sync.",
            detail:
              "The local .figmake-sync state was removed. Your actual project files were left untouched.",
          });
        }

        return {
          removedStateDir,
          removedFromAppState,
        };
      }),
  );

  ipcMain.handle(
    "figmake:clear-app-data",
    async () =>
      withOperationLock("clear-app-data", async () => {
        const approved = await confirmFromUi(
          "Clear figmake-sync app data? This signs you out of the shared Figma browser session and forgets saved app preferences. Local project folders and their .figmake-sync state will not be removed.",
        );

        if (!approved) {
          throw new Error("Clear app data cancelled.");
        }

        const userDataDir = app.getPath("userData");
        const targets = [
          path.join(userDataDir, "browser-profile"),
          path.join(userDataDir, "artifacts"),
          path.join(userDataDir, "app-state.json"),
          path.join(userDataDir, "startup.log"),
        ];
        const clearedPaths: string[] = [];

        for (const target of targets) {
          if (await fs.pathExists(target)) {
            await fs.remove(target);
            clearedPaths.push(target);
          }
        }

        await getAppStateStore().clear();
        browserInstalledThisSession = false;

        return {
          clearedPaths,
        };
      }),
  );

  ipcMain.handle(
    "figmake:add-ignore-pattern",
    async (_event, rootDir: string, pattern: string) =>
      withOperationLock("add-ignore-pattern", async () => {
      const { ProjectStateStore } = await import("../core/state.js");
      const { updateProjectConfig } = await import("../types/config.js");
      const store = new ProjectStateStore(rootDir);
      const config = await store.loadProjectConfig();
      const ignore = [...config.sync.ignore];
      if (!ignore.includes(pattern)) {
        ignore.push(pattern);
        const updated = updateProjectConfig(config, {
          sync: { ...config.sync, ignore },
        } as Partial<typeof config>);
        await store.saveProjectConfig(updated);
      }
      return { success: true };
      }),
  );

  ipcMain.handle(
    "figmake:remove-ignore-pattern",
    async (_event, rootDir: string, pattern: string) =>
      withOperationLock("remove-ignore-pattern", async () => {
      const { ProjectStateStore } = await import("../core/state.js");
      const { updateProjectConfig, DEFAULT_IGNORE_PATTERNS } = await import(
        "../types/config.js"
      );
      // Prevent removing default patterns
      if ((DEFAULT_IGNORE_PATTERNS as readonly string[]).includes(pattern)) {
        return { success: false, reason: "Cannot remove a default ignore pattern" };
      }
      const store = new ProjectStateStore(rootDir);
      const config = await store.loadProjectConfig();
      const ignore = config.sync.ignore.filter((p: string) => p !== pattern);
      const updated = updateProjectConfig(config, {
        sync: { ...config.sync, ignore },
      } as Partial<typeof config>);
      await store.saveProjectConfig(updated);
      return { success: true };
      }),
  );

  ipcMain.handle(
    "figmake:get-custom-ignore-patterns",
    async (_event, rootDir: string) => {
      const { ProjectStateStore } = await import("../core/state.js");
      const { DEFAULT_IGNORE_PATTERNS } = await import("../types/config.js");
      const store = new ProjectStateStore(rootDir);
      const config = await store.loadProjectConfig();
      const defaults = new Set<string>(DEFAULT_IGNORE_PATTERNS);
      return config.sync.ignore.filter((p: string) => !defaults.has(p));
    },
  );

  ipcMain.handle("figmake:check-runtime-deps", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    async function getVersion(cmd: string): Promise<string | null> {
      const candidates =
        process.platform === "win32"
          ? [`${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`, cmd]
          : [cmd];

      for (const candidate of candidates) {
        try {
          const { stdout } = await execFileAsync(candidate, ["--version"], {
            timeout: 5_000,
            env: { ...process.env, PATH: process.env.PATH },
          });
          return stdout.trim();
        } catch {
          continue;
        }
      }
      return null;
    }

    const [nodeVersion, npmVersion, pnpmVersion] = await Promise.all([
      getVersion("node"),
      getVersion("npm"),
      getVersion("pnpm"),
    ]);

    return {
      node: nodeVersion,
      npm: npmVersion,
      pnpm: pnpmVersion,
    };
  });

  ipcMain.handle("figmake:install-browser", async () =>
    withOperationLock("install-browser", async () =>
      installPlaywrightBrowser({
        browser: "chromium",
        progress: (event) => {
          sendProgress(event.message, {
            scope: "browser-install",
            ...(event.percent !== undefined ? { percent: event.percent } : {}),
          });
        },
      }),
    ),
  );

  ipcMain.handle(
    "figmake:init-project",
    async (_event, payload: { rootDir: string; figmaMakeUrl: string }) =>
      withOperationLock("init-project", async () => {
        void trackEvent("init_project");
        sendProgress("initializing local project");
        const result = await service.init(
          payload.figmaMakeUrl,
          payload.rootDir,
          {
            projectRoot: payload.rootDir,
            progress: sendProgress,
          },
        );

        await persistLastProjectRoot(payload.rootDir);
        sendProgress("project linked successfully");
        return result;
      }),
  );

  ipcMain.handle(
    "figmake:auth-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock("auth-project", async (signal) => {
        void trackEvent("auth_project");
        await persistLastProjectRoot(options.rootDir);
        return withBrowserInstallRecovery(
          () => service.auth(toRuntimeOptions(options, signal)),
          signal,
        );
      }),
  );

  ipcMain.handle(
    "figmake:auth-standalone",
    async () =>
      withOperationLock("auth-standalone", async () => {
        const profileDir = getSharedBrowserProfileDir();
        const artifactsDir = path.join(app.getPath("userData"), "artifacts");
        await fs.ensureDir(profileDir);
        await fs.ensureDir(artifactsDir);

        const pino = (await import("pino")).default;
        const logger = pino({ level: "silent" });

        const session = new BrowserSessionManager({
          userDataDir: profileDir,
          artifactsDir,
          headless: false,
          slowMoMs: 0,
          actionTimeoutMs: 30_000,
          navigationTimeoutMs: 60_000,
          browserChannel: undefined,
          logger,
        });

        await withBrowserInstallRecovery(() =>
          session.authenticate("https://www.figma.com", {
            waitForCompletion: async (message: string) => {
              const focusedWindow =
                getLiveWindow();
              const dialogOpts: MessageBoxOptions = {
                type: "info",
                buttons: ["Done"],
                title: "Figma Authentication",
                message: "Sign in to Figma in the browser window that opened.",
                detail: message,
              };
              if (focusedWindow) {
                await dialog.showMessageBox(focusedWindow, dialogOpts);
              } else {
                await dialog.showMessageBox(dialogOpts);
              }
            },
          }),
        );
      }),
  );

  ipcMain.handle(
    "figmake:pull-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock("pull-project", async (signal) => {
        await persistLastProjectRoot(options.rootDir);
        const result = await withBrowserInstallRecovery(
          () => service.pull(toRuntimeOptions(options, signal)),
          signal,
        );
        void trackEvent("pull", {
          files_added: result.remoteSummary.added,
          files_modified: result.remoteSummary.modified,
          files_deleted: result.remoteSummary.deleted,
          files_total: result.remoteSummary.total,
          extracted_files: result.extractedFiles,
        });
        return result;
      }),
  );

  ipcMain.handle(
    "figmake:sync-from-figma",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock("sync-from-figma", async (signal) => {
        await persistLastProjectRoot(options.rootDir);
        const result = await withBrowserInstallRecovery(
          () => service.syncFromFigma(toRuntimeOptions(options, signal)),
          signal,
        );
        void trackEvent("sync", {
          files_added: result.remoteSummary.added,
          files_modified: result.remoteSummary.modified,
          files_deleted: result.remoteSummary.deleted,
          files_total: result.remoteSummary.total,
          extracted_files: result.extractedFiles,
        });
        return result;
      }),
  );

  ipcMain.handle(
    "figmake:rebaseline-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock("rebaseline-project", async () => {
        await persistLastProjectRoot(options.rootDir);
        const result = await service.rebaseline(toRuntimeOptions(options));
        void trackEvent("rebaseline", { files_snapshotted: result.filesSnapshotted });
        return result;
      }),
  );

  ipcMain.handle(
    "figmake:status-project",
    async (_event, options: DesktopProjectCommandOptions) => {
      // Read-only: intentionally not taking the operation lock.
      await persistLastProjectRoot(options.rootDir);
      const result = await service.status(toRuntimeOptions(options));
      void trackEvent("status", {
        files_added: result.summary.added,
        files_modified: result.summary.modified,
        files_deleted: result.summary.deleted,
        files_total: result.summary.total,
        has_baseline: result.hasBaseline ? 1 : 0,
      });
      return result;
    },
  );

  ipcMain.handle(
    "figmake:push-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock("push-project", async (signal) => {
        await persistLastProjectRoot(options.rootDir);
        const result = await withBrowserInstallRecovery(
          () => service.push(toRuntimeOptions(options, signal)),
          signal,
        );
        void trackEvent("push", {
          files_added: result.summary.added,
          files_modified: result.summary.modified,
          files_deleted: result.summary.deleted,
          files_total: result.summary.total,
          unresolved: result.unresolved.length,
        });
        return result;
      }),
  );

  ipcMain.handle(
    "figmake:verify-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock("verify-project", async (signal) => {
        await persistLastProjectRoot(options.rootDir);
        const result = await withBrowserInstallRecovery(
          () => service.verify(toRuntimeOptions(options, signal)),
          signal,
        );
        void trackEvent("verify", {
          drift_files_total: result.drift.summary.total,
          drift_files_added: result.drift.summary.added,
          drift_files_modified: result.drift.summary.modified,
          drift_files_deleted: result.drift.summary.deleted,
        });
        return result;
      }),
  );

  ipcMain.handle(
    "figmake:open-in-editor",
    async (_event, payload: { editor: string; path: string }) => {
      const editor = typeof payload?.editor === "string" ? payload.editor : "";
      const candidates = EDITORS[editor];
      if (!candidates) {
        return { success: false, error: "Unsupported editor." };
      }
      const projectPath = await resolveAllowedPath(payload?.path, true);
      if (!projectPath) {
        return { success: false, error: "Path is not a known project folder." };
      }

      if (process.platform === "darwin") {
        for (const appName of candidates.mac) {
          try {
            await execFileAsync("open", ["-a", appName, projectPath], { timeout: 5000 });
            return { success: true };
          } catch {
            // try next
          }
        }
      }
      if (process.platform !== "win32") {
        for (const cli of candidates.cli) {
          try {
            await execFileAsync(cli, [projectPath], { timeout: 5000 });
            return { success: true };
          } catch {
            // try next
          }
        }
      }
      // Windows .cmd shims cannot be spawned safely without a shell; open the folder instead.
      if (process.platform === "win32") {
        const err = await shell.openPath(projectPath);
        return err
          ? { success: false, error: "Could not open the folder." }
          : { success: true };
      }
      return { success: false, error: `Could not find ${editor}.` };
    },
  );

  ipcMain.handle("figmake:read-file", async (_event, filePath: string) => {
    const resolved = await resolveAllowedPath(filePath, false);
    if (!resolved) {
      throw new Error("File is outside the known project folders.");
    }
    const { readFile, stat } = await import("node:fs/promises");
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new Error("File not found.");
    }
    if (!info.isFile()) throw new Error("Not a file.");
    if (info.size > MAX_READ_FILE_BYTES) throw new Error("File is too large to preview.");
    return readFile(resolved, "utf-8");
  });
}

const EDITORS: Record<string, { mac: string[]; cli: string[] }> = {
  code: { mac: ["Visual Studio Code", "Visual Studio Code - Insiders"], cli: ["code"] },
  cursor: { mac: ["Cursor"], cli: ["cursor"] },
  windsurf: { mac: ["Windsurf"], cli: ["windsurf"] },
  claude: { mac: ["Claude"], cli: ["claude"] },
  zed: { mac: ["Zed"], cli: ["zed"] },
};

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    // Missing leaf: realpath the nearest existing parent and re-append.
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realpathOrResolve(parent), path.basename(target));
  }
}

/** Returns a resolved path only if inside a known, initialised project root. */
async function resolveAllowedPath(
  input: unknown,
  mustBeDirectory: boolean,
): Promise<string | null> {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) return null;
  if (!path.isAbsolute(input)) return null;

  const last = (await getAppStateStore().load().catch(() => null))?.lastProjectRoot;
  const roots = new Set(knownProjectRoots);
  if (last) roots.add(path.resolve(last));

  const target = await realpathOrResolve(path.resolve(input));
  const userData = await realpathOrResolve(app.getPath("userData"));
  if (isInside(userData, target)) return null;

  for (const root of roots) {
    const realRoot = await realpathOrResolve(root);
    if (!(await fs.pathExists(path.join(realRoot, ".figmake-sync")))) continue;
    if (!isInside(realRoot, target)) continue;
    if (isInside(path.join(realRoot, ".figmake-sync", "browser-profile"), target)) continue;
    if (mustBeDirectory) {
      if (target !== realRoot) continue;
      try {
        if (!(await fs.stat(target)).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    return target;
  }
  return null;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitting || !activeOperation) return;
  event.preventDefault();
  void confirmBusyExit("Quitting").then(async (ok) => {
    if (!ok) return;
    quitting = true;
    await abortActiveAndWait();
    await harness?.shutdown().catch(() => undefined);
    app.exit(0);
  });
});

let harnessShutdownDone = false;
app.on("will-quit", (event) => {
  // Dev servers run in their own process groups; make sure none outlive the app.
  if (harnessShutdownDone || !harness) return;
  event.preventDefault();
  void harness
    .shutdown()
    .catch(() => undefined)
    .then(() => {
      harnessShutdownDone = true;
      app.quit();
    });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow().then((window) => {
      mainWindow = window;
    });
  } else {
    mainWindow?.show();
    mainWindow?.focus();
  }
});

process.on("uncaughtException", (error) => {
  void reportStartupError(
    "Uncaught exception in Electron main process.",
    error,
  );
});

process.on("unhandledRejection", (reason) => {
  void reportStartupError(
    "Unhandled rejection in Electron main process.",
    reason,
  );
});

async function bootstrap(): Promise<void> {
  if (!gotSingleInstanceLock) return;
  await app.whenReady();

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [APP_CSP],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  await writeStartupLog("Electron app bootstrap started.");
  void trackEvent("app_launch", { platform: process.platform, version: app.getVersion() });

  // Initialize service with shared browser profile so auth is global
  const sharedProfileDir = path.join(app.getPath("userData"), "browser-profile");
  await fs.ensureDir(sharedProfileDir);
  service = new FigmakeSyncService({ sharedBrowserProfileDir: sharedProfileDir });
  harness = new HarnessService({ sync: service, emit: sendHarnessEvent });

  if (process.platform === "darwin") {
    app.dock?.setIcon(getAppIconPath());
    await app.dock?.show();
  }

  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  registerHarnessHandlers();
  mainWindow = await createMainWindow();
  await writeStartupLog("Main window created successfully.");
}

void bootstrap().catch((error: unknown) => {
  void reportStartupError(
    "Bootstrap failed before the main window could open.",
    error,
  );
});
