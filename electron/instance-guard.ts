// electron/instance-guard.ts
//
// One machine, one running copy of the AAC app.
//
// Two problems, two mechanisms:
//
//  1. PREVENTION — `app.requestSingleInstanceLock()`. The app had no lock at
//     all, so every shortcut double-click, every stale relaunch and every
//     `--force-run` from the updater's installer started ANOTHER full instance.
//     Two instances means two gaze-sidecar supervisors both trying to open the
//     same vendor eye-tracker DLL (which admits a single consumer), two
//     supervisors appending to the same gaze-sidecar.log, and two auto-updaters
//     racing on the same download cache. The lock ends that: a second launch
//     hands its argv to the first instance, which raises its window, and then
//     exits.
//
//  2. DETECTION — a process-table scan. The lock only binds builds that HAVE
//     it, so a machine that already has an older instance running (or a second
//     INSTALL in another directory) still ends up with two copies, and this
//     build cannot prevent that retroactively. So we also scan and report, so
//     the condition is visible in the log and in the client instead of showing
//     up as an unexplained "eye tracking stopped working".
//
// The scan's classification rule is pure and lives in shared/app-instances.ts;
// only the OS query and the Electron wiring are here.

import { app, ipcMain, type BrowserWindow } from "electron";
import { execFile } from "child_process";
import path from "path";
import log from "electron-log";
import {
  classifyInstances,
  parseCimJson,
  type AppInstanceReport,
  type RawProcessRow,
} from "../shared/app-instances";

export type { AppInstanceReport };

/**
 * A relaunch can overlap the outgoing process by a few hundred milliseconds —
 * most notably the updater's installer starting the new build with --force-run
 * while the old one is still tearing down. Retrying briefly keeps that from
 * looking like "the app won't open"; a genuinely-running peer still loses.
 */
const LOCK_ATTEMPTS = 4;
const LOCK_RETRY_MS = 400;

/** WMI can be slow on a loaded machine; never let the scan hold up startup. */
const SCAN_TIMEOUT_MS = 8000;

/** Re-scan no more than this often — the report is polled from the renderer. */
const SCAN_CACHE_MS = 15_000;

/** Keep the launch scan off the critical path to first paint. */
const FIRST_SCAN_DELAY_MS = 5000;

let hasLock = false;
let mainWindowRef: BrowserWindow | null = null;
let cached: { at: number; report: AppInstanceReport } | null = null;

/** Block this thread without spinning. Only ever used on the failed-lock path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the single-instance lock, retrying briefly to ride out a relaunch that
 * overlaps the previous process.
 *
 * Returns false when another instance genuinely holds it — the caller must then
 * exit WITHOUT creating a window (the holder gets `second-instance` and raises
 * its own).
 */
export function acquireSingleInstanceLock(): boolean {
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
    if (app.requestSingleInstanceLock()) {
      hasLock = true;
      return true;
    }
    if (attempt < LOCK_ATTEMPTS) {
      log.info(
        `[instance] single-instance lock held by another process ` +
        `(attempt ${attempt}/${LOCK_ATTEMPTS}) — retrying in ${LOCK_RETRY_MS}ms`,
      );
      sleepSync(LOCK_RETRY_MS);
    }
  }
  return false;
}

/**
 * Wire the second-launch handler + the `app:getInstances` IPC, and run the
 * first scan.
 *
 * Call once after the main window exists. `mainWindow` is used to raise the
 * existing window when a second launch is refused, and to push the report to
 * the renderer so the client can warn the caretaker.
 */
export function setupInstanceGuard(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;

  // A second launch was refused: bring the real window to the front so the
  // double-click still *does* something visible, instead of silently nothing.
  app.on("second-instance", () => {
    log.info("[instance] a second launch was refused — raising the existing window");
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  ipcMain.handle("app:getInstances", async (_e, opts?: { refresh?: boolean }) => {
    return await scanInstances({ refresh: opts?.refresh === true });
  });

  // First scan on launch. Catches the case the lock cannot: an OLDER build (no
  // lock) already running, or a second install in another directory. Deferred a
  // few seconds so spawning PowerShell never competes with first paint on a slow
  // machine — a duplicate that has been running for a while can wait.
  setTimeout(() => void reportScan(), FIRST_SCAN_DELAY_MS);
}

/** Scan, write the verdict to main.log, and push it to the renderer. */
async function reportScan(): Promise<void> {
  const report = await scanInstances({ refresh: true });

  if (report.peers.length > 0) {
    log.warn(
      `[instance] ${report.peers.length} other copy/copies of the app are running: ` +
      report.peers
        .map((p) => `pid=${p.pid}${p.differentInstall ? ` (different install: ${p.exePath})` : ""}`)
        .join(", ") +
      (report.multipleInstalls
        ? " — MULTIPLE INSTALLS present; the eye-tracker DLL and the updater will fight over them"
        : ""),
    );
  } else if (report.error) {
    log.info(`[instance] instance scan unavailable: ${report.error}`);
  } else {
    log.info("[instance] single instance confirmed");
  }

  try {
    mainWindowRef?.webContents?.send("app:instances", report);
  } catch {
    /* window already gone — the renderer can still pull it over IPC */
  }
}

/**
 * Count the top-level copies of this app that are running right now.
 *
 * Windows only: reads Win32_Process for our executable NAME (deliberately not
 * our full path — a second install in another directory is exactly what we want
 * to catch) and hands the rows to the shared classifier, which drops Chromium's
 * `--type=` children and our own gaze sidecar.
 */
export async function scanInstances(
  { refresh = false }: { refresh?: boolean } = {},
): Promise<AppInstanceReport> {
  if (!refresh && cached && Date.now() - cached.at < SCAN_CACHE_MS) {
    return cached.report;
  }

  const selfPid = process.pid;
  const selfExePath = process.execPath;
  const base = (report: Partial<AppInstanceReport>): AppInstanceReport => ({
    selfPid,
    selfExePath,
    peers: [],
    multipleInstalls: false,
    unclassified: 0,
    error: null,
    hasLock,
    ...report,
  });

  if (process.platform !== "win32") {
    // The desktop build is Windows-only today; there is no second host to scan.
    return base({ error: `unsupported platform: ${process.platform}` });
  }

  let rows: RawProcessRow[];
  try {
    rows = await queryWindowsProcesses(path.basename(selfExePath));
  } catch (err) {
    const report = base({ error: (err as Error).message });
    cached = { at: Date.now(), report };
    return report;
  }

  const { peers, unclassified } = classifyInstances(rows, selfPid, selfExePath);
  const report = base({
    peers,
    unclassified,
    multipleInstalls: peers.some((p) => p.differentInstall),
  });
  cached = { at: Date.now(), report };
  return report;
}

/**
 * Query the Windows process table via PowerShell/CIM. `wmic` is deprecated and
 * absent from current Windows builds, so CIM is the portable choice.
 *
 * The script contains NO quotes and NO interpolated value. Two reasons, and the
 * first bites: `powershell.exe -Command <script>` is re-tokenized by the Windows
 * command-line parser before PowerShell sees it, which eats the double quotes
 * around a `-Filter "Name='x.exe'"` and leaves an invalid WQL query. Passing the
 * name through the environment sidesteps the quoting entirely — and with the
 * value never entering the script text, there is no injection surface either.
 * `Where-Object` costs a full process enumeration instead of a server-side
 * filter, which at a 5s-delayed launch scan behind a 15s cache is free.
 */
function queryWindowsProcesses(exeName: string): Promise<RawProcessRow[]> {
  const script =
    "Get-CimInstance Win32_Process " +
    "| Where-Object { $_.Name -eq $env:AIVOTA_SCAN_EXE_NAME } " +
    "| Select-Object ProcessId,ExecutablePath,CommandLine " +
    "| ConvertTo-Json -Compress -Depth 2";

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        timeout: SCAN_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, AIVOTA_SCAN_EXE_NAME: exeName },
      },
      (err, stdout) => {
        if (err) {
          reject(new Error(`process scan failed: ${err.message}`));
          return;
        }
        resolve(parseCimJson(stdout));
      },
    );
  });
}
