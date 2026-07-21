// electron/auto-update.ts
//
// Background auto-update for the Aivota AAC standalone client. Wraps
// `electron-updater` with the small amount of glue needed to:
//   1. Bind diagnostic logging into electron-log (so update failures
//      survive crash → restart and land in the same log file as the rest
//      of the app — see app.getPath("logs")).
//   2. Bridge update lifecycle events to the renderer via IPC so the UI
//      can show a "downloading update… X%" indicator and a "restart to
//      apply" toast without baking the rule into the display layer.
//   3. Trigger periodic re-checks (default: every 4 hours) so a long-
//      running session picks up a freshly published build without
//      forcing the user to relaunch.
//
// The update channel and URL are configured in electron-builder.yml's
// `publish:` block; this module only reads from `autoUpdater`'s own
// resolved config.
//
// Skipped entirely in dev (when !app.isPackaged) — the packaged
// installer is the only thing the updater knows how to replace.

import { app, ipcMain, type BrowserWindow } from "electron";
import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import log from "electron-log";
import type { UpdateStatus } from "../shared/native-update";

/** Re-check cadence while the app is running. 4h is enough to catch
 *  pushes without thrashing the CDN; first check still fires on launch. */
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Renderer-facing status payload. Defined once in shared/native-update.ts and
 *  re-exported here for existing importers — the AAC client consumes the same
 *  union through preload-bridged `aacUpdate.on(...)`, so a change to it is now
 *  a compile error on both sides rather than a silent IPC mismatch. */
export type { UpdateStatus };

let lastStatus: UpdateStatus = { kind: "idle" };
let recheckTimer: NodeJS.Timeout | null = null;
let mainWindowRef: BrowserWindow | null = null;
let initialized = false;

function emit(status: UpdateStatus): void {
  lastStatus = status;
  try {
    mainWindowRef?.webContents?.send("aac-update:status", status);
  } catch (err) {
    log.warn("[auto-update] failed to forward status to renderer:", (err as Error).message);
  }
}

/**
 * Wire auto-updater + start the first check. Call once after the main
 * window is created. Safe to call multiple times — subsequent calls are
 * no-ops.
 *
 * @param mainWindow Reference used to forward status events to the
 *                   renderer (for the in-app update indicator).
 */
export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  // electron-updater is hard-coded to skip work when running unpacked
  // (`app.isPackaged === false`), but the explicit guard also keeps dev
  // sessions from hitting the update URL on launch.
  if (!app.isPackaged) {
    log.info("[auto-update] dev session — auto-update disabled");
    mainWindowRef = mainWindow;
    return;
  }

  // A packaged DEV build (release:aac.mjs dev → pkgName "aivota-aac-dev") talks
  // to a localhost server and has no published update feed, so skip the updater
  // entirely — otherwise it polls the non-existent aac-dev/win/ feed and logs a
  // 403 on every launch. Staging/prod (no "-dev" suffix) update normally.
  if (app.getName().endsWith("-dev")) {
    log.info(`[auto-update] dev build (${app.getName()}) — auto-update disabled`);
    mainWindowRef = mainWindow;
    return;
  }

  mainWindowRef = mainWindow;

  if (initialized) {
    // Idempotent — already wired; just refresh the main-window reference.
    return;
  }
  initialized = true;

  // Diagnostics → electron-log. Log file location:
  //   Win:  %USERPROFILE%\AppData\Roaming\Aivota AAC\logs\main.log
  // Useful when a user reports "the app won't update" — we have a local
  // trail without them needing to open DevTools.
  autoUpdater.logger = log;
  (autoUpdater.logger as any).transports.file.level = "info";
  log.info(`[auto-update] starting (currentVersion=${app.getVersion()})`);

  // Manual control: we drive `quitAndInstall` ourselves from the
  // renderer's "Restart now" prompt rather than letting the updater
  // pick the moment. Auto-download stays on so the .exe is on disk by
  // the time the user is ready.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => emit({ kind: "checking" }));
  autoUpdater.on("update-available", (info: UpdateInfo) =>
    emit({ kind: "available", version: info.version })
  );
  autoUpdater.on("update-not-available", (info: UpdateInfo) =>
    emit({ kind: "not-available", version: info.version })
  );
  autoUpdater.on("download-progress", (p: ProgressInfo) =>
    emit({ kind: "downloading", percent: p.percent, bytesPerSecond: p.bytesPerSecond })
  );
  autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
    emit({ kind: "downloaded", version: info.version })
  );
  autoUpdater.on("error", (err: Error) => {
    log.warn("[auto-update] error:", err.message);
    emit({ kind: "error", message: err.message });
  });

  // IPC: renderer can query the current status (initial render), trigger
  // a manual recheck, or apply the downloaded update on demand.
  ipcMain.handle("aac-update:getStatus", () => lastStatus);
  ipcMain.handle("aac-update:check", async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      log.warn("[auto-update] manual check failed:", (err as Error).message);
      emit({ kind: "error", message: (err as Error).message });
    }
  });
  ipcMain.handle("aac-update:installNow", () => {
    if (lastStatus.kind !== "downloaded") {
      log.info("[auto-update] installNow requested but no download is ready");
      return false;
    }
    log.info("[auto-update] installing now (quitAndInstall, silent)");
    // Fully automated update: quitAndInstall closes the app (firing our
    // window/sidecar cleanup hooks), runs the installer, and relaunches.
    //   isSilent=true       → NSIS runs with /S: no installer window.
    //   isForceRunAfter=true → adds --force-run: the new build reopens itself.
    // Elevation is handled by electron-updater, not us: our builds are
    // perMachine:false, so a per-user install updates silently with zero
    // prompts. If a user chose all-users at first install, the installer
    // (or electron-updater's EACCES→elevate.exe fallback) raises the one
    // mandatory Windows UAC consent prompt — a security boundary we can't
    // and shouldn't suppress. Neither path shows the old wizard window.
    autoUpdater.quitAndInstall(true, true);
    return true;
  });

  // First check on launch + recurring checks while the app is open. The
  // built-in scheduler in electron-updater would also work but is
  // implicit — explicit interval is easier to reason about + tune.
  autoUpdater.checkForUpdates().catch((err) =>
    log.warn("[auto-update] initial check failed:", (err as Error).message)
  );
  recheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) =>
      log.warn("[auto-update] recheck failed:", (err as Error).message)
    );
  }, RECHECK_INTERVAL_MS);
}

/** Stop the recurring re-check timer. Called on app `before-quit` so the
 *  process can exit cleanly even if we're mid-poll. */
export function stopAutoUpdater(): void {
  if (recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
}
