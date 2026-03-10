const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { startTobiiBridge } = require("./tobii-bridge");

let mainWindow = null;
let bridgeResult = null;

app.whenReady().then(async () => {
  // Start the Tobii hardware bridge + WebSocket server
  console.log("[Main] Starting Tobii bridge...");
  try {
    bridgeResult = await startTobiiBridge();
  } catch (e) {
    console.error("[Main] Bridge startup error:", e);
  }

  // Create the window
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
});

// IPC: renderer can ask for bridge status
ipcMain.handle("bridge:status", () => {
  return {
    connected: bridgeResult?.bridge?.connected ?? false,
  };
});

app.on("window-all-closed", () => {
  bridgeResult?.bridge?.stop();
  bridgeResult?.wss?.close();
  bridgeResult?.statusServer?.close();
  app.quit();
});
