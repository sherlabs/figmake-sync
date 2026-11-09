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
  undo: call("figmake:undo"),
  send: call("figmake:send"),
  cancel: call("figmake:cancel"),
  retry: call("figmake:retry"),
  setAgent: call("figmake:set-agent"),
  chooseWorkspace: call("figmake:choose-workspace"),
  signOutFigma: call("figmake:sign-out"),
  reportIssue: call("figmake:report-issue"),
  onUpdateState: listen("figmake:update-state"),
  installUpdate: call("figmake:update-install"),
  previewRect: (rect) => ipcRenderer.send("figmake:preview-rect", rect),
});
