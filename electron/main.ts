import { app, BrowserWindow, protocol, ipcMain, session, dialog, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { GazeSidecarSupervisor, GazeSupervisorPaths } from "./hardware/gaze-sidecar-supervisor";
import { setupAutoUpdater, stopAutoUpdater } from "./auto-update";

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
let gazeSupervisor: GazeSidecarSupervisor | null = null;

/**
 * Resolve where the gaze sidecar + its runtime/node_modules live, for dev
 * (running from the repo) vs packaged (shipped under resources/gaze-sidecar).
 */
function gazeSupervisorPaths(): GazeSupervisorPaths {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, "gaze-sidecar");
    return {
      userDataDir: app.getPath("userData"),
      sidecarScript: path.join(base, "gaze-sidecar.cjs"),
      // "sidecar_modules" (not "node_modules") because electron-builder strips a
      // folder named node_modules from extraResources. NODE_PATH treats this dir
      // as a module search root regardless of its name.
      sidecarNodeModules: path.join(base, "sidecar_modules"),
      ia32Runtime: path.join(base, "runtime", "win32-ia32", "node.exe"),
    };
  }
  const appRoot = path.join(__dirname, "..");
  return {
    userDataDir: app.getPath("userData"),
    sidecarScript: path.join(appRoot, "electron", "sidecar", "gaze-sidecar.cjs"),
    sidecarNodeModules: path.join(appRoot, "node_modules"),
    ia32Runtime: path.join(appRoot, "electron", "sidecar", "runtime", "win32-ia32", "node.exe"),
  };
}

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

  // Allow opening DevTools in the PACKAGED app for field debugging (eye tracker,
  // network, console). F12 or Ctrl+Shift+I toggles it.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const isF12 = input.key === "F12";
    const isInspect = input.control && input.shift && input.key.toLowerCase() === "i";
    if (isF12 || isInspect) {
      mainWindow?.webContents.toggleDevTools();
    }
  });

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

  // Fix cross-origin cookies: the renderer's origin is `app://aac`, but it talks
  // to the remote API over https. For the session cookie to be STORED and SENT
  // cross-site it must be `SameSite=None; Secure`. Chromium silently drops a
  // `SameSite=None` cookie that lacks `Secure`, and treats a cookie with no
  // SameSite attribute as Lax (also not sent cross-site). The server only emits
  // the right attributes when NODE_ENV=production; we normalize here so the
  // desktop app works regardless of the backend's env. Without this, login
  // appears to succeed (user is in the response body) but the session cookie is
  // never persisted, so every later authenticated request comes back 401.
  const forceCrossSiteCookie = (cookie: string): string => {
    let c = cookie;
    if (/;\s*SameSite=/i.test(c)) {
      c = c.replace(/SameSite=(Lax|Strict)/i, "SameSite=None");
    } else {
      c = `${c}; SameSite=None`;
    }
    if (!/;\s*Secure/i.test(c)) {
      c = `${c}; Secure`;
    }
    return c;
  };
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    if (headers) {
      const cookieKeys = Object.keys(headers).filter(
        (k) => k.toLowerCase() === "set-cookie",
      );
      for (const key of cookieKeys) {
        headers[key] = headers[key].map(forceCrossSiteCookie);
      }
    }
    callback({ responseHeaders: headers });
  });

  // Create the gaze sidecar supervisor. It stays idle until the renderer calls
  // gaze:ensure (when a student's settings select an eye tracker).
  gazeSupervisor = new GazeSidecarSupervisor(gazeSupervisorPaths());

  createWindow();

  // Background auto-update — fetches `latest.yml` from the publish URL,
  // downloads new installers in the background, raises lifecycle events
  // the renderer can show to the user. No-ops in dev (app.isPackaged is
  // false there). Started after the window so the renderer is wired up
  // before any status events fire.
  if (mainWindow) {
    setupAutoUpdater(mainWindow);
  }
});

// IPC handlers
ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("app:getPlatform", () => process.platform);

// ── Gaze sidecar IPC ──
// The renderer drives these when a student's eye-tracking settings are active.
ipcMain.handle("gaze:ensure", (_e, device: string) => {
  return gazeSupervisor?.ensure(device) ?? null;
});
ipcMain.handle("gaze:status", () => {
  return gazeSupervisor?.getStatus() ?? null;
});
// Open the gaze sidecar log file (written by the supervisor) for field debugging.
ipcMain.handle("gaze:openLog", async () => {
  const logPath = path.join(app.getPath("userData"), "gaze-sidecar.log");
  const err = await shell.openPath(logPath);
  return { logPath, opened: !err, error: err || null };
});
ipcMain.handle("gaze:stop", () => {
  gazeSupervisor?.stop();
  return gazeSupervisor?.getStatus() ?? null;
});
ipcMain.handle("gaze:setDll", (_e, device: string, dllPath: string) => {
  return gazeSupervisor?.setDll(device, dllPath) ?? null;
});
ipcMain.handle("gaze:clearDll", (_e, device: string) => {
  return gazeSupervisor?.clearDll(device) ?? null;
});
// Open a native file dialog to pick the DLL, then start the sidecar with it.
ipcMain.handle("gaze:locateDll", async (_e, device: string) => {
  const dialogOptions = {
    title: "Locate the eye-tracker driver (.dll)",
    properties: ["openFile" as const],
    filters: [
      { name: "Eye tracker DLL", extensions: ["dll"] },
      { name: "All Files", extensions: ["*"] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths.length) {
    return gazeSupervisor?.getStatus() ?? null;
  }
  return gazeSupervisor?.setDll(device, result.filePaths[0]) ?? null;
});

app.on("window-all-closed", () => {
  gazeSupervisor?.stop();
  stopAutoUpdater();
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
