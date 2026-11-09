const { contextBridge, ipcRenderer } = require("electron");

const progressChannel = "figmake:progress";
const harnessEventChannel = "figmake:harness:event";

const api = {
  loadAppState: () => ipcRenderer.invoke("figmake:load-app-state"),
  selectProjectDirectory: () =>
    ipcRenderer.invoke("figmake:select-project-directory"),
  inspectProject: (rootDir) =>
    ipcRenderer.invoke("figmake:inspect-project", rootDir),
  deleteProject: (rootDir) =>
    ipcRenderer.invoke("figmake:delete-project", rootDir),
  clearAppData: () => ipcRenderer.invoke("figmake:clear-app-data"),
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
  rebaselineProject: (options) => ipcRenderer.invoke("figmake:rebaseline-project", options),
  checkRuntimeDeps: () => ipcRenderer.invoke("figmake:check-runtime-deps"),
  checkAuthStatus: () => ipcRenderer.invoke("figmake:check-auth-status"),
  harnessDetectAgents: () => ipcRenderer.invoke("figmake:harness:detect-agents"),
  harnessGetSettings: (rootDir) => ipcRenderer.invoke("figmake:harness:get-settings", { rootDir }),
  harnessUpdateSettings: (rootDir, patch) =>
    ipcRenderer.invoke("figmake:harness:update-settings", { rootDir, patch }),
  harnessSetup: (rootDir) => ipcRenderer.invoke("figmake:harness:setup", { rootDir }),
  harnessStartDev: (rootDir) => ipcRenderer.invoke("figmake:harness:dev-start", { rootDir }),
  harnessStopDev: (rootDir) => ipcRenderer.invoke("figmake:harness:dev-stop", { rootDir }),
  harnessDevStatus: (rootDir) => ipcRenderer.invoke("figmake:harness:dev-status", { rootDir }),
  harnessOpenDev: (rootDir) => ipcRenderer.invoke("figmake:harness:dev-open", { rootDir }),
  harnessRunAgent: (input) => ipcRenderer.invoke("figmake:harness:run-agent", input),
  harnessCancelRun: (rootDir) => ipcRenderer.invoke("figmake:harness:cancel-run", { rootDir }),
  harnessChanges: (rootDir) => ipcRenderer.invoke("figmake:harness:changes", { rootDir }),
  onHarnessEvent: (listener) => {
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    ipcRenderer.on(harnessEventChannel, wrapped);
    return () => {
      ipcRenderer.removeListener(harnessEventChannel, wrapped);
    };
  },
  onProgress: (listener) => {
    const wrappedListener = (_event, payload) => {
      listener(payload);
    };

    ipcRenderer.on(progressChannel, wrappedListener);

    return () => {
      ipcRenderer.removeListener(progressChannel, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld("figmakeSyncDesktop", api);
