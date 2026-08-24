const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexlink", {
  snapshot: () => ipcRenderer.invoke("codexlink:snapshot"),
  addProject: () => ipcRenderer.invoke("codexlink:project:add"),
  removeProject: (id) => ipcRenderer.invoke("codexlink:project:remove", id),
  upsertProvider: (profile) => ipcRenderer.invoke("codexlink:provider:upsert", profile),
  deleteProvider: (id) => ipcRenderer.invoke("codexlink:provider:delete", id),
  testProvider: (id) => ipcRenderer.invoke("codexlink:provider:test", id),
  resetPairing: () => ipcRenderer.invoke("codexlink:pairing:reset"),
  updateSecurity: (settings) => ipcRenderer.invoke("codexlink:security:update", settings),
  refreshNetwork: () => ipcRenderer.invoke("codexlink:network:refresh"),
  onState: (listener) => {
    const wrapped = (_, state) => listener(state);
    ipcRenderer.on("codexlink:state", wrapped);
    return () => ipcRenderer.removeListener("codexlink:state", wrapped);
  },
});
