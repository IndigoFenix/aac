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
  // How many copies of the app are running (see electron/instance-guard.ts).
  // A second copy takes the eye-tracker DLL away from this one, so the client
  // surfaces it rather than letting it look like a tracker fault.
  instances: {
    get: (refresh?: boolean) => ipcRenderer.invoke("app:getInstances", { refresh }),
    onReport: (cb: (report: unknown) => void) => {
      const listener = (_e: unknown, report: unknown) => cb(report);
      ipcRenderer.on("app:instances", listener);
      return () => ipcRenderer.removeListener("app:instances", listener);
    },
  },
  // Durable device id, kept in a userData file so a browser-profile reset does
  // not burn a fresh device-registration slot (see electron/main.ts).
  deviceId: {
    get: () => ipcRenderer.invoke("device-id:get"),
    set: (id: string) => ipcRenderer.invoke("device-id:set", id),
  },
  // Start-with-the-device. The renderer mirrors the student's `launchOnBoot`
  // AAC setting here on every profile load; the main process owns the OS login
  // item. `get` reports what the OS actually says, including whether this shell
  // can register at all (see electron/main.ts).
  autoLaunch: {
    get: () => ipcRenderer.invoke("auto-launch:get"),
    set: (enabled: boolean) => ipcRenderer.invoke("auto-launch:set", enabled),
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
  // Session recording. The renderer runs the encoders and streams their chunks
  // through `append`; the main process owns every disk operation, including the
  // storage-budget sweep that runs on each `finish`. See
  // electron/hardware/recording-store.ts and shared/aac/session-recording.ts.
  // Nothing here uploads: the files never leave the device by this path.
  recording: {
    /** Create/validate the folder, recover interrupted clips, sweep the budget. */
    prepare: (opts: { folder: string | null; maxStorageMb: number; maxAgeDays?: number }) =>
      ipcRenderer.invoke("recording:prepare", opts),
    begin: (opts: { clipId: string }) => ipcRenderer.invoke("recording:begin", opts),
    append: (opts: { clipId: string; track: "camera" | "screen"; data: Uint8Array }) =>
      ipcRenderer.invoke("recording:append", opts),
    finish: (opts: { clipId: string; manifest: unknown; maxStorageMb: number; maxAgeDays?: number }) =>
      ipcRenderer.invoke("recording:finish", opts),
    abort: (opts: { clipId: string }) => ipcRenderer.invoke("recording:abort", opts),
    list: () => ipcRenderer.invoke("recording:list"),
    /**
     * Erasure: delete this device's footage of one student. Called when the
     * server pushes `purge_recordings`, and when the client sees the student's
     * profile come back definitively gone — the offline-at-erasure case.
     */
    purgeStudent: (opts: { studentId: string }) =>
      ipcRenderer.invoke("recording:purgeStudent", opts),
    /** Open the recordings folder in the OS file manager. */
    reveal: () => ipcRenderer.invoke("recording:reveal"),
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
