import { app, BrowserWindow, protocol, ipcMain, session } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { HardwareBridgeManager } from "./hardware/bridge-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register app:// as a privileged scheme BEFORE app.ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let hardwareManager: HardwareBridgeManager | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      // Allow ws://localhost connections from the secure app:// origin.
      // Required for local eye tracker companion software (Tobii, EyeTech, etc.)
      // that serve WebSocket on localhost without TLS.
      allowRunningInsecureContent: true,
    },
  });

  mainWindow.maximize();

  if (!app.isPackaged) {
    // Dev mode — load from Vite dev server
    mainWindow.loadURL("http://localhost:5174");
    mainWindow.webContents.openDevTools();
  } else {
    // Production — load from app:// protocol
    mainWindow.loadURL("app://aac/index.html");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  // Handle app:// protocol — serve files from the built AAC client
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    // Strip the host ("aac") and leading slash to get the file path
    let filePath = decodeURIComponent(url.pathname);
    if (filePath === "/" || filePath === "") {
      filePath = "/index.html";
    }

    const distPath = path.join(__dirname, "..", "dist", "public-aac");
    const fullPath = path.join(distPath, filePath);

    // Security: ensure we don't escape the dist directory
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(distPath))) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!fs.existsSync(resolved)) {
      // SPA fallback — serve index.html for unmatched routes
      const indexPath = path.join(distPath, "index.html");
      if (fs.existsSync(indexPath)) {
        return new Response(fs.readFileSync(indexPath), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    return new Response(fs.readFileSync(resolved), {
      headers: { "content-type": getMimeType(resolved) },
    });
  });

  // Auto-grant permissions for camera, mic, HID
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "fullscreen", "hid", "clipboard-read", "clipboard-sanitized-write"];
      callback(allowed.includes(permission));
    },
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      const allowed = ["media", "fullscreen", "hid", "clipboard-read", "clipboard-sanitized-write"];
      return allowed.includes(permission);
    },
  );

  // Fix cross-origin cookie issue: the renderer (app:// or localhost) makes
  // requests to the remote API server. The server sets SameSite=Lax cookies,
  // which Chromium blocks for cross-site requests. Rewrite Set-Cookie headers
  // to SameSite=None so they're stored and sent properly.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    if (headers) {
      const cookieKeys = Object.keys(headers).filter(
        (k) => k.toLowerCase() === "set-cookie",
      );
      for (const key of cookieKeys) {
        headers[key] = headers[key].map((cookie: string) =>
          cookie
            .replace(/SameSite=Lax/i, "SameSite=None")
            .replace(/SameSite=Strict/i, "SameSite=None"),
        );
      }
    }
    callback({ responseHeaders: headers });
  });

  // Start hardware bridge manager
  hardwareManager = new HardwareBridgeManager();
  await hardwareManager.start();

  createWindow();
});

// IPC handlers
ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("app:getPlatform", () => process.platform);
ipcMain.handle("hardware:status", () => {
  return hardwareManager?.getStatus() ?? {};
});

app.on("window-all-closed", () => {
  hardwareManager?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ── Helpers ──

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  return types[ext] ?? "application/octet-stream";
}
