import path from "node:path";
import process from "node:process";

import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import fs from "fs-extra";

import {
  installPlaywrightBrowser,
  isPlaywrightBrowserMissingError,
} from "../browser/install.js";
import { FigmakeSyncService } from "../core/service.js";
import type {
  DesktopAppState,
  DesktopProjectCommandOptions,
  DesktopProgressEvent,
} from "./contracts.js";
import { DesktopAppStateStore } from "./appState.js";

const APP_ID = "com.figmake.sync";

let service!: FigmakeSyncService;

let mainWindow: BrowserWindow | null = null;
let appStateStore: DesktopAppStateStore | null = null;
let activeOperation = false;

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

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 720,
    show: false,
    center: true,
    backgroundColor: "#ebe5d6",
    icon: getAppIconPath(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
    },
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
  if (!mainWindow) {
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
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
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
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
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

async function withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  if (activeOperation) {
    throw new Error("Another figmake-sync action is already running.");
  }

  activeOperation = true;

  try {
    return await operation();
  } finally {
    activeOperation = false;
  }
}

async function ensureBrowserRuntimeInstalledInteractively(): Promise<void> {
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
}

async function withBrowserInstallRecovery<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isPlaywrightBrowserMissingError(error)) {
      throw error;
    }

    sendProgress("Playwright browser runtime is missing");
    await ensureBrowserRuntimeInstalledInteractively();
    sendProgress("Retrying after browser install");

    return operation();
  }
}

function toRuntimeOptions(options: DesktopProjectCommandOptions) {
  return {
    projectRoot: options.rootDir,
    dryRun: options.dryRun,
    verbose: options.verbose,
    prompt: options.prompt,
    strategy: options.strategy,
    progress: (message: string) => {
      sendProgress(message);
    },
    confirm: confirmFromUi,
    waitForManualAction,
  };
}

async function persistLastProjectRoot(
  rootDir: string,
): Promise<DesktopAppState> {
  return getAppStateStore().update({
    lastProjectRoot: rootDir,
  });
}

function getSharedBrowserProfileDir(): string {
  return path.join(app.getPath("userData"), "browser-profile");
}

function registerIpcHandlers(): void {
  ipcMain.handle("figmake:load-app-state", () => getAppStateStore().load());

  ipcMain.handle("figmake:check-auth-status", async () => {
    const profileDir = getSharedBrowserProfileDir();
    try {
      // Chromium stores cookies/session in these files
      const indicators = ["Cookies", "Default/Cookies", "Local State"];
      for (const indicator of indicators) {
        if (await fs.pathExists(path.join(profileDir, indicator))) {
          const stat = await fs.stat(path.join(profileDir, indicator));
          // File exists and has content — session likely saved
          if (stat.size > 0) {
            return { authenticated: true, profileDir };
          }
        }
      }
      // Check if profile dir has any meaningful content at all
      if (await fs.pathExists(profileDir)) {
        const entries = await fs.readdir(profileDir);
        if (entries.length > 2) {
          return { authenticated: true, profileDir };
        }
      }
      return { authenticated: false, profileDir };
    } catch {
      return { authenticated: false, profileDir };
    }
  });

  ipcMain.handle("figmake:select-project-directory", async () => {
    const focusedWindow =
      BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
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
    return service.inspectProject(rootDir);
  });

  ipcMain.handle("figmake:install-browser", async () =>
    withOperationLock(async () =>
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
      withOperationLock(async () => {
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
      withOperationLock(async () => {
        await persistLastProjectRoot(options.rootDir);
        return withBrowserInstallRecovery(() =>
          service.auth(toRuntimeOptions(options)),
        );
      }),
  );

  ipcMain.handle(
    "figmake:pull-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock(async () => {
        await persistLastProjectRoot(options.rootDir);
        return withBrowserInstallRecovery(() =>
          service.pull(toRuntimeOptions(options)),
        );
      }),
  );

  ipcMain.handle(
    "figmake:sync-from-figma",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock(async () => {
        await persistLastProjectRoot(options.rootDir);
        return withBrowserInstallRecovery(() =>
          service.syncFromFigma(toRuntimeOptions(options)),
        );
      }),
  );

  ipcMain.handle(
    "figmake:status-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock(async () => {
        await persistLastProjectRoot(options.rootDir);
        return service.status(toRuntimeOptions(options));
      }),
  );

  ipcMain.handle(
    "figmake:push-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock(async () => {
        await persistLastProjectRoot(options.rootDir);
        return withBrowserInstallRecovery(() =>
          service.push(toRuntimeOptions(options)),
        );
      }),
  );

  ipcMain.handle(
    "figmake:verify-project",
    async (_event, options: DesktopProjectCommandOptions) =>
      withOperationLock(async () => {
        await persistLastProjectRoot(options.rootDir);
        return withBrowserInstallRecovery(() =>
          service.verify(toRuntimeOptions(options)),
        );
      }),
  );

  ipcMain.handle(
    "figmake:open-in-editor",
    async (_event, payload: { editor: string; path: string }) => {
      const { editor, path: projectPath } = payload;
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      // macOS app names for `open -a`
      const macApps: Record<string, string[]> = {
        code: ["Visual Studio Code", "Visual Studio Code - Insiders", "code"],
        cursor: ["Cursor", "cursor"],
        windsurf: ["Windsurf", "windsurf"],
        claude: ["Claude", "claude"],
        zed: ["Zed", "zed"],
      };

      const candidates = macApps[editor] ?? [editor];

      for (const candidate of candidates) {
        try {
          if (candidate.includes(" ") || candidate[0] === candidate[0]!.toUpperCase()) {
            // App name — use `open -a`
            await execAsync(`open -a "${candidate}" "${projectPath}"`, { timeout: 5000 });
          } else {
            // CLI command
            await execAsync(`${candidate} "${projectPath}"`, { timeout: 5000 });
          }
          return { success: true };
        } catch {
          // Try next candidate
        }
      }

      return { success: false, error: `Could not find ${editor}. Tried: ${candidates.join(", ")}` };
    },
  );

  ipcMain.handle("figmake:read-file", async (_event, filePath: string) => {
    const { readFile } = await import("node:fs/promises");
    try {
      const content = await readFile(filePath, "utf-8");
      return content;
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error);
      throw error;
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
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
  await app.whenReady();

  await writeStartupLog("Electron app bootstrap started.");

  // Initialize service with shared browser profile so auth is global
  const sharedProfileDir = path.join(app.getPath("userData"), "browser-profile");
  await fs.ensureDir(sharedProfileDir);
  service = new FigmakeSyncService({ sharedBrowserProfileDir: sharedProfileDir });

  if (process.platform === "darwin") {
    app.dock.setIcon(getAppIconPath());
    await app.dock.show();
  }

  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  mainWindow = await createMainWindow();
  await writeStartupLog("Main window created successfully.");
}

void bootstrap().catch((error: unknown) => {
  void reportStartupError(
    "Bootstrap failed before the main window could open.",
    error,
  );
});
