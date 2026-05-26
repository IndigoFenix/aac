import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getPlatform: () => process.platform,
  // Eye-tracker gaze sidecar control
  gaze: {
    /** Ensure the sidecar is running for a device (auto-locates the DLL). */
    ensure: (device: string) => ipcRenderer.invoke("gaze:ensure", device),
    status: () => ipcRenderer.invoke("gaze:status"),
    stop: () => ipcRenderer.invoke("gaze:stop"),
    /** Open a file dialog to pick the DLL, then (re)start the sidecar. */
    locateDll: (device: string) => ipcRenderer.invoke("gaze:locateDll", device),
    setDll: (device: string, dllPath: string) => ipcRenderer.invoke("gaze:setDll", device, dllPath),
    clearDll: (device: string) => ipcRenderer.invoke("gaze:clearDll", device),
    openLog: () => ipcRenderer.invoke("gaze:openLog"),
  },
});
