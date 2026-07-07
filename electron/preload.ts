import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getPlatform: () => process.platform,
  // In-app browser (BrowserApp <webview>) navigation allowlist. Pushed when the
  // browser opens so the main process can hard-block off-allowlist navigation.
  browser: {
    setAllowlist: (list: unknown) => ipcRenderer.invoke("browser:setAllowlist", list),
    clearAllowlist: () => ipcRenderer.invoke("browser:clearAllowlist"),
  },
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
  // Auto-update channel. The renderer subscribes via `update.onStatus(cb)`
  // to react to download progress / "restart to apply" prompts, calls
  // `update.check()` for a manual refresh, and `update.installNow()` when
  // the user clicks "Restart now". `update.getStatus()` returns the most
  // recent state for the initial render.
  update: {
    getStatus: () => ipcRenderer.invoke("aac-update:getStatus"),
    check: () => ipcRenderer.invoke("aac-update:check"),
    installNow: () => ipcRenderer.invoke("aac-update:installNow"),
    onStatus: (cb: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown) => cb(status);
      ipcRenderer.on("aac-update:status", listener);
      return () => ipcRenderer.removeListener("aac-update:status", listener);
    },
  },
});
