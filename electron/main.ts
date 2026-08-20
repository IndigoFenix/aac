import { app, BrowserWindow, desktopCapturer, protocol, ipcMain, session, dialog, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import log from "electron-log";
import { GazeSidecarSupervisor, GazeSupervisorPaths } from "./hardware/gaze-sidecar-supervisor";
import { setupAutoUpdater, stopAutoUpdater } from "./auto-update";
import { acquireSingleInstanceLock, setupInstanceGuard } from "./instance-guard";
import { setupRecordingStore, stopRecordingStore } from "./hardware/recording-store";
import { isUrlPermitted } from "../shared/permitted-websites";
import type { PermittedWebsite } from "../shared/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── One running copy, before anything else ──
// Must come before any window/protocol/updater work: a duplicate launch has to
// bow out without spawning a second gaze sidecar (two instances fight over the
// single-consumer eye-tracker DLL) or a second auto-updater. The holder gets
// `second-instance` and raises its own window — see electron/instance-guard.ts.
if (!acquireSingleInstanceLock()) {
  log.info("[instance] another copy of Aivota AAC is already running — this launch is exiting");
  app.quit();
  // Hard stop: nothing below this line may run in a duplicate launch.
  process.exit(0);
}

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

// Session partition for the in-app browser (BrowserApp's <webview>). Isolated
// from the app's own session so third-party cookies/storage/permissions never
// mix with the authenticated AAC session.
const BROWSER_PARTITION = "persist:aac-browser";

// Permitted-website allowlist for the in-app browser, pushed from the renderer
// when BrowserApp mounts (browser:setAllowlist) and cleared on unmount. The
// main process is the HARD navigation gate: unlike the old cross-origin iframe,
// a <webview>'s webContents `will-navigate`/`will-redirect` is cancelable here,
// so an in-page link to an off-allowlist site is blocked outright.
let browserAllowlist: PermittedWebsite[] = [];

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
      // Enable the <webview> tag — the in-app browser (BrowserApp) renders
      // permitted third-party sites in a <webview> so the eyegaze overlay can
      // drive scroll/click/type via executeJavaScript/sendInputEvent (a
      // cross-origin iframe can't be reached in). Guests are hardened below in
      // `will-attach-webview` + `web-contents-created`.
      webviewTag: true,
    },
  });

  // Harden every <webview> guest before it attaches: force the safe defaults
  // regardless of what attributes the renderer set. No node integration, no
  // preload, context isolation on.
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // Pin the isolated partition even if the attribute is missing/tampered.
    params.partition = BROWSER_PARTITION;
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

  // Lock the top-level window to the app's own origin: block navigation away
  // from app://aac (prod) / the dev server and deny popups / new windows.
  // Defense-in-depth against a renderer XSS pivoting the BrowserWindow.
  mainWindow.webContents.on("will-navigate", (event, navUrl) => {
    if (!isAppOrigin(navUrl)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** True for the app's own renderer origin (app:// in prod, the Vite dev server
 *  in dev). Used to gate navigation and device-permission grants so embedded
 *  third-party sites (the in-app browser) can't navigate the shell or grab the
 *  camera/mic/HID. */
function isAppOrigin(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.startsWith("app://aac") || url.startsWith("http://localhost:5174");
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

  // Auto-grant camera, mic, HID — but ONLY to the app's own origin. Embedded
  // third-party sites (the in-app browser) must not auto-acquire these.
  // "display-capture" is the gate in FRONT of the display-media handler below:
  // without it the getDisplayMedia() call is denied before that handler is ever
  // consulted, and session recording / call screen-share silently produce
  // nothing. It stays scoped to the app's own origin like everything else here.
  const allowedPermissions = ["media", "display-capture", "fullscreen", "hid", "clipboard-read", "clipboard-sanitized-write"];
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(allowedPermissions.includes(permission) && isAppOrigin(details?.requestingUrl));
    },
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => {
      return allowedPermissions.includes(permission) && isAppOrigin(requestingOrigin);
    },
  );

  // ── Screen capture source ──
  // Since Electron 20 a `getDisplayMedia()` call is REFUSED outright unless the
  // session has a display-media handler, so this is what makes screen capture
  // possible at all here — both for session recording and for the clinician's
  // call screen-share, which had no handler and could therefore never succeed.
  //
  // The answer is always the app's OWN window, with no picker. A picker in
  // front of a student is unusable, and every other answer is worse for
  // privacy: whole-screen capture would sweep up notifications, a caretaker's
  // email, or another student's board. The window source (rather than
  // `mainFrame`) is deliberate — it captures the composited window, so a
  // <webview> playing a video appears in the recording as it does on screen.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!isAppOrigin(request.frame?.url)) {
        // Only the app's own page may capture. A <webview> guest asking to
        // record the screen gets nothing.
        callback({});
        return;
      }
      const win = mainWindow;
      if (!win || win.isDestroyed()) { callback({}); return; }
      const wantedId = win.getMediaSourceId();
      desktopCapturer
        .getSources({ types: ["window", "screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const own = sources.find((s) => s.id === wantedId);
          // Fall back to the primary display only if the window source has
          // gone missing (it can, briefly, mid-restore) — never silently to a
          // different window.
          const screen = sources.find((s) => s.id.startsWith("screen:"));
          const chosen = own ?? screen;
          if (!chosen) { callback({}); return; }
          if (!own) log.warn("[recording] own window source not found — using primary display");
          callback({ video: chosen });
        })
        .catch((err) => {
          log.error(`[recording] desktopCapturer failed: ${String(err)}`);
          callback({});
        });
    },
    // macOS-only option, and false is already the default — stated explicitly
    // because "which window gets captured" must be this handler's decision and
    // never a dialog put in front of a student.
    { useSystemPicker: false },
  );

  // In-app browser partition: deny ALL permission requests (camera, mic, geo,
  // notifications, HID…). Third-party sites viewed in the <webview> get zero
  // device access — the isolated session never even sees the app's grants.
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);

  // Hard navigation gate for the in-app browser. `will-attach-webview` already
  // pins the partition + strips node access; here we cancel any navigation to a
  // URL that isn't on the renderer-supplied allowlist and deny all popups /
  // new windows. `will-redirect` catches server-side 30x hops to off-list hosts.
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "webview") return;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event: Electron.Event, navUrl: string) => {
      if (!/^https?:/i.test(navUrl)) {
        // about:blank / the initial empty document is fine; anything non-http
        // (file:, data:, custom schemes) is not.
        if (navUrl !== "about:blank") event.preventDefault();
        return;
      }
      if (!isUrlPermitted(navUrl, browserAllowlist)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
  });

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

  // NOTE: YouTube playback is now served via the https backend relay page
  // (server/services/youtube/youtube-embed-page.ts), framed by the AAC client.
  // We deliberately do NOT rewrite Referer/Origin on YouTube-bound requests.
  //
  // A previous attempt forced `Referer: https://www.youtube.com/` +
  // `Origin: https://www.youtube.com` here to work around the app:// origin.
  // That was both ineffective (the IFrame player reads window.location.origin /
  // document.referrer, which a header rewrite can't change) AND actively
  // harmful to the relay: the relay iframe legitimately carries a valid
  // `Referer: https://<backend>/` (helmet's strict-origin-when-cross-origin),
  // and clobbering it to youtube.com is itself an invalid embedding referer
  // that triggers error 152/153 — plus forcing Origin can break googlevideo
  // media-segment CORS. Leaving the natural headers intact is the fix.

  // Create the gaze sidecar supervisor. It stays idle until the renderer calls
  // gaze:ensure (when a student's settings select an eye tracker).
  gazeSupervisor = new GazeSidecarSupervisor(gazeSupervisorPaths());

  // Session-recording file store. Idle until a student whose settings enable
  // recording starts a session; see shared/aac/session-recording.ts.
  setupRecordingStore();

  createWindow();

  // Background auto-update — fetches `latest.yml` from the publish URL,
  // downloads new installers in the background, raises lifecycle events
  // the renderer can show to the user. No-ops in dev (app.isPackaged is
  // false there). Started after the window so the renderer is wired up
  // before any status events fire.
  if (mainWindow) {
    setupAutoUpdater(mainWindow, {
      // The gaze sidecar runs the app's OWN executable (Electron-as-node), so
      // to the NSIS installer's running-app check it is indistinguishable from
      // the app still being open — and a live handle on files inside the
      // install directory. It has to be gone before the installer starts, not
      // merely on the way out.
      beforeInstall: () => {
        log.info("[main] update install requested — stopping gaze sidecar first");
        gazeSupervisor?.stop();
      },
    });
    // Second-launch handling + the multiple-copies scan/report.
    setupInstanceGuard(mainWindow);
  }
});

// IPC handlers
ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("app:getPlatform", () => process.platform);

// ── Durable device identity ──
// The AAC device id lives in localStorage, which is not durable enough to BE
// the identity: a browser-profile reset on a shared Windows machine wipes it,
// and every loss re-registers this same physical machine as a NEW device
// against the student's device-slot limit. A plain-text file in userData
// survives that, so the renderer can recover the id it already had. The
// renderer treats this copy as authoritative and backfills localStorage.
function deviceIdFilePath(): string {
  return path.join(app.getPath("userData"), "aac-device-id");
}
// Shape guard, applied on BOTH read and write: only ever hand back (or store)
// something that looks like an id we generate — a truncated or garbled file
// must read as "no id at all", never as a corrupt identity we then register.
const DEVICE_ID_PATTERN = /^[\w-]{8,64}$/;

ipcMain.handle("device-id:get", async () => {
  try {
    const id = (await fs.promises.readFile(deviceIdFilePath(), "utf8")).trim();
    return DEVICE_ID_PATTERN.test(id) ? id : null;
  } catch {
    // Absent on first run, or unreadable. Null means "ask localStorage" — the
    // renderer writes the resolved id back through device-id:set.
    return null;
  }
});
ipcMain.handle("device-id:set", async (_e, id: unknown) => {
  if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id)) return false;
  try {
    await fs.promises.writeFile(deviceIdFilePath(), id, "utf8");
    return true;
  } catch {
    // A failed write is not fatal — localStorage stays the only copy until the
    // next attempt. Never throw at the renderer over this.
    return false;
  }
});

// ── In-app browser allowlist ──
// The renderer pushes the current permitted-website list when BrowserApp opens
// and clears it on close. This is the source of truth for the main-process
// navigation gate registered in `web-contents-created`.
ipcMain.handle("browser:setAllowlist", (_e, list: unknown) => {
  browserAllowlist = Array.isArray(list) ? (list as PermittedWebsite[]) : [];
  return browserAllowlist.length;
});
ipcMain.handle("browser:clearAllowlist", () => {
  browserAllowlist = [];
  return 0;
});

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

// Teardown runs on `before-quit`, not only on `window-all-closed`: a quit can be
// initiated with the window already gone (or by the updater's quitAndInstall),
// and the sidecar MUST die on every one of those paths — it holds the vendor DLL
// and runs the app's own exe, so a survivor blocks the next install and grabs
// the tracker away from the relaunched app.
app.on("before-quit", () => {
  gazeSupervisor?.stop();
  stopAutoUpdater();
  // Flush any clip still being written so the file on disk stays playable.
  void stopRecordingStore();
});

app.on("window-all-closed", () => {
  gazeSupervisor?.stop();
  stopAutoUpdater();
  void stopRecordingStore();
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
    // ES module scripts hard-fail on non-JS MIME types: the ONNX runtime
    // dynamically import()s its .mjs loader glue from app://aac/ort/, so
    // serving it as octet-stream breaks Silero VAD in the packaged app
    // (works in dev only because Vite serves .mjs correctly).
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
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
