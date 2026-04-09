import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  DesktopAppState,
  DesktopProgressEvent,
  FigmakeDesktopApi,
} from "./contracts.js";

const progressChannel = "figmake:progress";

const api: FigmakeDesktopApi = {
  loadAppState: () => ipcRenderer.invoke("figmake:load-app-state"),
  selectProjectDirectory: () =>
    ipcRenderer.invoke("figmake:select-project-directory"),
  inspectProject: (rootDir) =>
    ipcRenderer.invoke("figmake:inspect-project", rootDir),
  installBrowser: () => ipcRenderer.invoke("figmake:install-browser"),
  initProject: (rootDir, figmaMakeUrl) =>
    ipcRenderer.invoke("figmake:init-project", { rootDir, figmaMakeUrl }),
  authProject: (options) => ipcRenderer.invoke("figmake:auth-project", options),
  authStandalone: () => ipcRenderer.invoke("figmake:auth-standalone"),
  pullProject: (options) => ipcRenderer.invoke("figmake:pull-project", options),
  syncFromFigma: (options) =>
    ipcRenderer.invoke("figmake:sync-from-figma", options),
  statusProject: (options) =>
    ipcRenderer.invoke("figmake:status-project", options),
  pushProject: (options) => ipcRenderer.invoke("figmake:push-project", options),
  verifyProject: (options) =>
    ipcRenderer.invoke("figmake:verify-project", options),
  openInEditor: (editor, path) =>
    ipcRenderer.invoke("figmake:open-in-editor", { editor, path }),
  readFile: (filePath) => ipcRenderer.invoke("figmake:read-file", filePath),
  addIgnorePattern: (rootDir, pattern) =>
    ipcRenderer.invoke("figmake:add-ignore-pattern", rootDir, pattern),
  removeIgnorePattern: (rootDir, pattern) =>
    ipcRenderer.invoke("figmake:remove-ignore-pattern", rootDir, pattern),
  getCustomIgnorePatterns: (rootDir) =>
    ipcRenderer.invoke("figmake:get-custom-ignore-patterns", rootDir),
  checkAuthStatus: () => ipcRenderer.invoke("figmake:check-auth-status"),
  onProgress: (listener) => {
    const wrappedListener = (
      _event: IpcRendererEvent,
      payload: DesktopProgressEvent,
    ) => {
      listener(payload);
    };

    ipcRenderer.on(progressChannel, wrappedListener);

    return () => {
      ipcRenderer.removeListener(progressChannel, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld("figmakeSyncDesktop", api);

declare global {
  interface Window {
    figmakeSyncDesktop: FigmakeDesktopApi;
    initialDesktopAppState?: DesktopAppState;
  }
}
