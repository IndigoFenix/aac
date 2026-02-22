import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getPlatform: () => process.platform,
  hardware: {
    getStatus: () => ipcRenderer.invoke("hardware:status"),
  },
});
