const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (listener) => {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("figmake", {
  state: call("figmake:state"),
  onState: listen("figmake:state"),
  onCommand: listen("figmake:command"),
  openProject: call("figmake:open"),
  ask: call("figmake:ask"),
  chat: call("figmake:chat"),
  onChat: listen("figmake:chat"),
  newChat: call("figmake:new-chat"),
  copyText: call("figmake:clipboard-write"),
  undo: call("figmake:undo"),
  switchProject: call("figmake:switch"),
  removeProject: call("figmake:remove-project"),
  describeChange: call("figmake:describe-change"),
  setUpdates: call("figmake:set-updates"),
  send: call("figmake:send"),
  cancel: call("figmake:cancel"),
  retry: call("figmake:retry"),
  setAgent: call("figmake:set-agent"),
  chooseWorkspace: call("figmake:choose-workspace"),
  signOutFigma: call("figmake:sign-out"),
  reportIssue: call("figmake:report-issue"),
  onUpdateState: listen("figmake:update-state"),
  updateState: call("figmake:update-get"),
  checkForUpdates: call("figmake:update-check"),
  installUpdate: call("figmake:update-install"),
  listFolder: call("figmake:list-folder"),
  readFile: call("figmake:read-file"),
  changedFiles: call("figmake:changed-files"),
  stopProcess: call("figmake:stop-process"),
  restartProcess: call("figmake:restart-process"),
  cleanup: call("figmake:cleanup"),
  previewRect: (rect) => ipcRenderer.send("figmake:preview-rect", rect),
});
