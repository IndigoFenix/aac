const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getBridgeStatus: () => ipcRenderer.invoke("bridge:status"),
});
