const { app, BrowserWindow, ipcMain, dialog, shell, crashReporter } = require("electron");
const path = require("path");
const fs = require("fs");
const { startTobiiBridge } = require("./tobii-bridge");

let mainWindow = null;
let bridgeResult = null;
let logFilePath = null;

/**
 * The folder to drop the debug + crash logs in. For a portable build this is
 * the folder containing the .exe (electron-builder sets PORTABLE_EXECUTABLE_DIR),
 * so logs sit right next to the app where they're easy to find.
 */
function logBaseDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
}

// ── Persisted settings (remembers the hand-picked DLL across launches) ──
function settingsFile() {
  return path.join(app.getPath("userData"), "tobii-settings.json");
}
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")); }
  catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
  catch (e) { console.error("[Main] Failed to save settings:", e.message); }
}

// Log uncaught errors to a file so a startup failure is diagnosable even
// though the window/devtools may not be open.
function crashLog(kind, err) {
  try {
    const line = `[${new Date().toISOString()}] [Main] ${kind}: ${err && err.stack ? err.stack : err}\n`;
    if (logFilePath) fs.appendFileSync(logFilePath, line);
    console.error(line);
  } catch { /* ignore */ }
}
process.on("uncaughtException", (e) => crashLog("uncaughtException", e));
process.on("unhandledRejection", (e) => crashLog("unhandledRejection", e));
process.on("exit", (code) => crashLog("process exit", `code=${code}`));

app.whenReady().then(async () => {
  const baseDir = logBaseDir();
  logFilePath = path.join(baseDir, "tobii-debug.log");

  // Native crashes (e.g. an FFI segfault) kill the main process instantly —
  // no JS handler runs. crashReporter writes a minidump from a separate process,
  // which is the only artifact that survives such a crash. Dump next to the exe.
  try {
    app.setPath("crashDumps", path.join(baseDir, "tobii-crash-dumps"));
    crashReporter.start({ uploadToServer: false, compress: false });
  } catch (e) { crashLog("crashReporter init", e); }

  app.on("render-process-gone", (_e, _wc, details) =>
    crashLog("render-process-gone", JSON.stringify(details)));
  app.on("child-process-gone", (_e, details) =>
    crashLog("child-process-gone", JSON.stringify(details)));

  crashLog("startup", `app ready; logs in ${baseDir}`);

  // Create the window FIRST so the UI (and the "Open Log" button) is always
  // reachable, even if the hardware bridge fails to connect.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    fullscreen: false, // Change to true for real testing
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      // Allow ws://localhost connections from the renderer
      allowRunningInsecureContent: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Uncomment to open DevTools:
  // mainWindow.webContents.openDevTools();

  // Then start the Tobii hardware bridge + WebSocket server. Reuse a previously
  // hand-picked DLL path if the user chose one before.
  const saved = loadSettings();
  console.log(`[Main] Starting Tobii bridge... (saved DLL: ${saved.dllPath || "none"}, log: ${logFilePath})`);
  try {
    bridgeResult = await startTobiiBridge(saved.dllPath || null, { logFile: logFilePath });
  } catch (e) {
    crashLog("Bridge startup error", e);
  }
});

// IPC: renderer can ask for bridge status
ipcMain.handle("bridge:status", () => {
  return {
    connected: bridgeResult?.bridge?.connected ?? false,
  };
});

// IPC: current DLL info for the renderer (saved path + what's actually in use)
ipcMain.handle("tobii:getInfo", () => {
  const s = loadSettings();
  return {
    savedDllPath: s.dllPath || null,
    currentDllPath: bridgeResult?.bridge?.dllPath ?? null,
    connected: bridgeResult?.bridge?.connected ?? false,
    logFilePath,
  };
});

// IPC: open the debug log in the default editor
ipcMain.handle("tobii:openLog", async () => {
  if (logFilePath) {
    const err = await shell.openPath(logFilePath);
    if (err) console.error("[Main] Failed to open log:", err);
    return !err;
  }
  return false;
});

// IPC: open a native file dialog to pick the DLL (returns the path or null)
ipcMain.handle("tobii:selectDll", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select tobii_stream_engine.dll",
    properties: ["openFile"],
    filters: [
      { name: "Tobii Stream Engine", extensions: ["dll"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// IPC: use a chosen DLL — persist it and reconnect the bridge live
ipcMain.handle("tobii:setDll", async (_e, dllPath) => {
  const s = loadSettings();
  s.dllPath = dllPath;
  saveSettings(s);
  if (bridgeResult?.reconnectWithDll) {
    return await bridgeResult.reconnectWithDll(dllPath);
  }
  return { connected: false, dllPath: null, status: null };
});

// IPC: clear the saved DLL and fall back to auto-detection
ipcMain.handle("tobii:clearDll", async () => {
  const s = loadSettings();
  delete s.dllPath;
  saveSettings(s);
  if (bridgeResult?.reconnectWithDll) {
    return await bridgeResult.reconnectWithDll(null);
  }
  return { connected: false, dllPath: null, status: null };
});

app.on("window-all-closed", () => {
  bridgeResult?.bridge?.stop();
  bridgeResult?.wss?.close();
  bridgeResult?.statusServer?.close();
  app.quit();
});
