import path from "node:path";
import process from "node:process";

import os from "node:os";

import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import fs from "fs-extra";

import { createHealingAdapterFactory } from "../app/healing.js";
import { DiagnosticsLog, handleReportRequest, type SanitizeContext } from "../app/report.js";
import { ChatStore } from "../app/chatStore.js";
import { Session } from "../app/session.js";
import { slugify } from "../app/workspace.js";
import { installPlaywrightBrowser, isBrowserInstalled, isPlaywrightBrowserMissingError } from "../browser/install.js";
import { FigmakeSyncService } from "../core/service.js";
import { createHealContext } from "../heal/index.js";
import { HarnessService } from "../harness/index.js";
import { createOneShotRunner } from "../harness/oneshot.js";
import { systemEnv } from "../harness/process.js";
import { detectRuntime, installManagedRuntime, setManagedRuntimeRoot } from "../runtime/managed.js";
import { createUpdater, loadAutoUpdater, updatesSupported, type Updater } from "../updater/index.js";
import { UPDATE_CHECK_CHANNEL, UPDATE_GET_CHANNEL, UPDATE_INSTALL_CHANNEL, UPDATE_STATE_CHANNEL, type UpdateState } from "../updater/contracts.js";
import { trackEvent } from "./analytics.js";
import { DesktopAppStateStore } from "./appState.js";
import type { MenuCommand, PreviewRect } from "./contracts.js";
import { cleanupActionArg, processIdArg, projectPathArg } from "./ipc.js";
import { PreviewView } from "./preview.js";

const APP_ID = "com.figmake.sync";
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

let mainWindow: BrowserWindow | null = null;
let preview: PreviewView | null = null;
let appSession: Session | null = null;
let harness: HarnessService | null = null;
let updater: Updater | null = null;
let quitting = false;
const typed: string[] = [];

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
app.setName("figmake-sync");
app.setAppUserModelId(APP_ID);

const userData = (...parts: string[]): string => path.join(app.getPath("userData"), ...parts);

/** Last 200 log lines, sanitised when written: the only log text a bug report can ever contain. */
function sanitizeContext(): SanitizeContext {
  const name = appSession?.state.projectName ?? null;
  const user = os.userInfo().username;
  return {
    home: app.getPath("home"),
    usernames: [user, os.hostname().split(".")[0] ?? ""],
    projectNames: name ? [name, slugify(name)] : [],
    userTexts: typed,
  };
}
const diagnostics = new DiagnosticsLog(sanitizeContext);

async function log(message: string, error?: unknown): Promise<void> {
  const detail = error instanceof Error ? `\n${error.stack ?? error.message}` : error ? `\n${typeof error === "string" ? error : "unknown error"}` : "";
  diagnostics.push(`${message}${detail}`);
  await fs
    .ensureDir(userData())
    .then(() => fs.appendFile(userData("startup.log"), `[${new Date().toISOString()}] ${message}${detail}\n\n`))
    .catch(() => undefined);
}

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---- browser + Node provisioning (silent: the person is never asked) ----

let browserReady = false;
async function withBrowser<T>(run: () => Promise<T>): Promise<T> {
  if (!browserReady) {
    if (!(await isBrowserInstalled())) await installPlaywrightBrowser({ browser: "chromium" });
    browserReady = true;
  }
  try {
    return await run();
  } catch (error) {
    if (!isPlaywrightBrowserMissingError(error)) throw error;
    browserReady = false;
    await installPlaywrightBrowser({ browser: "chromium" });
    browserReady = true;
    return run();
  }
}

async function ensureNode(signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
  try {
    const root = userData("runtime");
    const status = await detectRuntime({ runtimeRoot: root, systemEnv: systemEnv() });
    if (status.node.source !== "missing" && status.npm.source !== "missing") return { ok: true };
    await installManagedRuntime({ runtimeRoot: root, ...(signal ? { signal } : {}) });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Never resolves on its own: the browser auto-detects the sign-in. Rejects when the person cancels. */
function waitForFigmaSignin(signal: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    const abort = (): void => reject(Object.assign(new Error("Sign-in cancelled"), { name: "AbortError" }));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

// ---- window ----

function overlayColors(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? "#1e1e20" : "#ffffff", symbolColor: dark ? "#e5e5e7" : "#1d1d1f", height: 52 };
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    center: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
    icon: path.join(import.meta.dirname, "renderer", "assets", "icon-512.png"),
    // macOS: traffic lights inset into the sidebar. Windows: the toolbar is the title bar, with the system buttons overlaid on its right.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : process.platform === "win32" ? "hidden" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    ...(process.platform === "win32" ? { titleBarOverlay: overlayColors() } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
    },
  });

  window.on("close", (event) => {
    if (quitting || !appSession?.isBusy()) return;
    event.preventDefault();
    void dialog
      .showMessageBox(window, { type: "warning", message: "Stop the current action and close?", buttons: ["Keep Going", "Stop and Close"], defaultId: 0, cancelId: 0 })
      .then(async ({ response }) => {
        if (response !== 1) return;
        await appSession?.cancel();
        quitting = true;
        window.close();
      });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) void log(`Renderer: ${message}`);
  });
  window.once("ready-to-show", () => window.show());
  if (process.platform === "win32") nativeTheme.on("updated", () => !window.isDestroyed() && window.setTitleBarOverlay(overlayColors()));
  await window.loadFile(path.join(import.meta.dirname, "renderer", "index.html"));
  return window;
}

function buildMenu(): void {
  const command = (label: string, accelerator: string, id: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send("figmake:command", id),
  });
  const checkUpdates: MenuItemConstructorOptions = { label: "Check for Updates…", click: () => send("figmake:command", "check-updates" satisfies MenuCommand) };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "figmake-sync",
        submenu: [checkUpdates, command("Settings…", "CommandOrControl+,", "settings"), { type: "separator" }, { role: "hide" }, { role: "quit" }],
      },
      { label: "File", submenu: [command("Add Project…", "CommandOrControl+N", "add-project"), { role: "close" }] },
      { role: "editMenu" },
      { role: "windowMenu" },
      // macOS keeps this item in the app menu; elsewhere it lives under Help.
      ...(process.platform === "darwin" ? [] : [{ label: "Help", submenu: [checkUpdates] }]),
    ]),
  );
}

function registerIpc(s: Session): void {
  ipcMain.handle("figmake:state", () => s.state);
  ipcMain.handle("figmake:open", (_e, link: unknown) => (typeof link === "string" ? s.openProject(link.slice(0, 2048)) : undefined));
  ipcMain.handle("figmake:ask", (_e, prompt: unknown) => {
    if (typeof prompt !== "string") return undefined;
    typed.push(prompt.trim().slice(0, 2000));
    if (typed.length > 10) typed.shift();
    return s.ask(prompt.slice(0, 20_000));
  });
  ipcMain.handle("figmake:chat", () => s.chat);
  ipcMain.handle("figmake:new-chat", () => s.newChat());
  ipcMain.handle("figmake:clipboard-write", (_e, text: unknown) => {
    if (typeof text === "string") clipboard.writeText(text.slice(0, 100_000));
  });
  ipcMain.handle("figmake:report-issue", (_e, request: unknown) => {
    handleReportRequest(request, {
      version: app.getVersion(),
      os: `${process.platform} ${os.release()}`,
      arch: process.arch,
      electron: process.versions.electron,
      diagnostics,
      sanitize: sanitizeContext,
      openExternal: (url) => void shell.openExternal(url),
      writeClipboard: (text) => clipboard.writeText(text),
    });
  });
  ipcMain.handle("figmake:undo", (_e, index: unknown) => s.undo(typeof index === "number" && Number.isInteger(index) ? index : undefined));
  ipcMain.handle("figmake:switch", (_e, key: unknown) => (typeof key === "string" ? s.switchProject(key.slice(0, 256)) : undefined));
  ipcMain.handle("figmake:remove-project", (_e, key: unknown, deleteFiles: unknown) =>
    typeof key === "string" ? s.removeProject(key.slice(0, 256), deleteFiles === true) : undefined,
  );
  ipcMain.handle("figmake:describe-change", (_e, index: unknown) => (typeof index === "number" && Number.isInteger(index) ? s.describeChange(index) : []));
  ipcMain.handle("figmake:set-updates", async (_e, enabled: unknown) => {
    if (typeof enabled !== "boolean") return;
    await s.setUpdates(enabled);
    if (!enabled) updater?.stop();
    else updater?.start();
  });
  ipcMain.handle("figmake:send", (_e, resolution: unknown) =>
    s.send(resolution === "mine" || resolution === "figma" ? resolution : undefined),
  );
  ipcMain.handle("figmake:list-folder", (_e, rel: unknown) => {
    const parsed = projectPathArg.safeParse(rel);
    return parsed.success ? s.listFolder(parsed.data) : { path: "", entries: [], truncated: false };
  });
  ipcMain.handle("figmake:read-file", (_e, rel: unknown) => {
    const parsed = projectPathArg.safeParse(rel);
    return parsed.success ? s.readFile(parsed.data) : { kind: "missing", path: "" };
  });
  ipcMain.handle("figmake:changed-files", () => s.changedPaths());
  ipcMain.handle("figmake:stop-process", (_e, id: unknown) => {
    const parsed = processIdArg.safeParse(id);
    return parsed.success ? s.stopProcess(parsed.data) : undefined;
  });
  ipcMain.handle("figmake:restart-process", (_e, id: unknown) => {
    const parsed = processIdArg.safeParse(id);
    return parsed.success ? s.restartProcess(parsed.data) : undefined;
  });
  ipcMain.handle("figmake:cleanup", (_e, action: unknown) => {
    const parsed = cleanupActionArg.safeParse(action);
    if (!parsed.success) return undefined;
    return parsed.data === "fix-preview" ? s.fixPreview() : parsed.data === "start-over" ? s.startOver() : s.resetApp();
  });
  ipcMain.handle("figmake:cancel", () => s.cancel());
  ipcMain.handle("figmake:retry", () => s.retry());
  ipcMain.handle("figmake:set-agent", (_e, agent: unknown) => (agent === "claude" || agent === "codex" ? s.setAgent(agent) : undefined));
  ipcMain.handle("figmake:choose-workspace", () => s.chooseWorkspace());
  ipcMain.handle("figmake:sign-out", () => s.signOutFigma());
  ipcMain.on("figmake:preview-rect", (_e, rect: unknown) => {
    const r = rect as Partial<PreviewRect> | null;
    const ok = r && [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n));
    preview?.setRect(ok ? (r as PreviewRect) : null);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [APP_CSP] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  void trackEvent("app_launch", { platform: process.platform, version: app.getVersion() });

  const profileDir = userData("browser-profile");
  await fs.ensureDir(profileDir);
  setManagedRuntimeRoot(userData("runtime"));
  const ref: { session?: Session } = {};
  // Silent self-healing for every Figma session. It only runs when an AI assistant was chosen; results are only logged.
  const heal = createHealContext({
    userDataDir: userData(),
    runOneShot: createOneShotRunner(),
    getAgentId: () => ref.session?.state.agent ?? null,
  });
  const sync = new FigmakeSyncService({
    sharedBrowserProfileDir: profileDir,
    adapterFactory: createHealingAdapterFactory({ heal, hasAgent: () => Boolean(ref.session?.state.agent), diagnostics }),
  });
  // Not ~/Documents: iCloud Drive / OneDrive often sync it, and syncing node_modules makes every file read minutes slow.
  const documentsDir = process.env["FIGMAKE_DOCUMENTS_DIR"] ?? app.getPath("home");
  const store = new DesktopAppStateStore(userData("app-state.json"));

  harness = new HarnessService({ sync, emit: (event) => ref.session?.handleHarnessEvent(event), ensureNode });
  const live = new Session({
    sync,
    harness,
    appState: store,
    chatStore: new ChatStore(userData("chats")),
    documentsDir,
    guard: { home: app.getPath("home"), forbidden: [app.getAppPath(), path.dirname(process.execPath)] },
    chooseFolder: async () => {
      const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    openExternal: (url) => void shell.openExternal(url),
    reloadPreview: () => preview?.reload(),
    trashFolder: (dir) => shell.trashItem(dir),
    signOutFigma: async () => {
      await fs.remove(profileDir);
      await fs.ensureDir(profileDir);
    },
    withBrowser,
    waitForFigmaSignin,
    log: (message, error) => void log(message, error),
  });
  ref.session = live;
  appSession = live;

  if (process.platform === "darwin") await app.dock?.show();
  buildMenu();
  registerIpc(live);
  registerUpdateIpc();
  mainWindow = await createWindow();
  preview = new PreviewView(mainWindow);
  let lastUrl: string | null = null;
  live.onState((state) => {
    if (state.previewUrl !== lastUrl) {
      lastUrl = state.previewUrl;
      preview?.setUrl(state.previewUrl);
    }
    send("figmake:state", state);
  });
  live.onChat((chat) => send("figmake:chat", chat));
  void live.start().catch((error: unknown) => log("Start failed", error));
  await startUpdater(live, (await store.load()).updates.enabled);
}

/** Registered before the window exists, so the first render never calls a missing handler. */
function registerUpdateIpc(): void {
  const unsupported: UpdateState = { phase: "idle", currentVersion: app.getVersion(), supported: false, upToDate: false };
  ipcMain.handle(UPDATE_GET_CHANNEL, () => updater?.getState() ?? unsupported);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, () => updater?.checkNow() ?? unsupported);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => void updater?.installNow());
}

/** Self-update. Automatic checks follow the Settings switch; "Check for updates" always works in a packaged app. */
async function startUpdater(live: Session, automatic: boolean): Promise<void> {
  const supported = updatesSupported({ isPackaged: app.isPackaged, platform: process.platform, env: process.env, appImage: Boolean(process.env["APPIMAGE"]) });
  if (!supported) return;
  try {
    const note = (level: "info" | "warn" | "error") => (message: string) => void log(`updater ${level}: ${message}`);
    updater = createUpdater({
      autoUpdater: await loadAutoUpdater(),
      currentVersion: app.getVersion(),
      isBusy: () => live.isBusy(),
      logger: { info: note("info"), warn: note("warn"), error: note("error") },
      onState: (state) => send(UPDATE_STATE_CHANNEL, state),
    });
    if (!automatic || !mainWindow) return;
    const begin = (): void => updater?.start();
    if (mainWindow.isVisible()) begin();
    else mainWindow.once("show", begin);
  } catch (error) {
    void log("Updater unavailable", error);
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().then((window) => {
      mainWindow = window;
      preview = new PreviewView(window);
      if (appSession) preview.setUrl(appSession.state.previewUrl);
    });
  }
});

let shutdownDone = false;
app.on("will-quit", (event) => {
  // Dev servers run in their own process groups; none may outlive the app.
  if (shutdownDone || !harness) return;
  event.preventDefault();
  void Promise.all([harness.shutdown().catch(() => undefined), appSession?.flush().catch(() => undefined)]).then(() => {
    shutdownDone = true;
    app.quit();
  });
});
app.on("before-quit", (event) => {
  updater?.stop();
  if (quitting || !appSession?.isBusy()) {
    quitting = true;
    return;
  }
  event.preventDefault();
  void dialog
    .showMessageBox({ type: "warning", message: "Stop the current action and quit?", buttons: ["Keep Going", "Stop and Quit"], defaultId: 0, cancelId: 0 })
    .then(async ({ response }) => {
      if (response !== 1) return;
      quitting = true;
      await appSession?.cancel();
      app.quit();
    });
});

process.on("uncaughtException", (error) => void log("Uncaught exception", error));
process.on("unhandledRejection", (reason) => void log("Unhandled rejection", reason));

void bootstrap().catch((error: unknown) => {
  void log("Bootstrap failed", error);
  dialog.showErrorBox("figmake-sync couldn't open", "Please restart the app.");
});
