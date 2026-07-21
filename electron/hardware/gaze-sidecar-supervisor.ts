/**
 * gaze-sidecar-supervisor.ts — Main-process manager for the gaze sidecar.
 *
 * Detects the vendor DLL, launches a bitness-matched sidecar process that serves
 * gaze over ws://localhost:<port>, and keeps it alive (restart on crash). The
 * renderer connects to that WebSocket via its existing provider; the mouse
 * provider is the renderer's fallback until a gaze provider connects.
 *
 * Bitness strategy (full isolation — the main process never loads the DLL):
 *   - x64 DLL  -> spawn the app's own Electron binary with ELECTRON_RUN_AS_NODE=1
 *                (koffi is N-API, so it loads fine under Electron).
 *   - ia32 DLL -> spawn a bundled 32-bit Node runtime.
 * Either way the sidecar is a separate child process, so a native crash there
 * never takes down the app.
 */

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { locateDeviceDll, readDllArch, DllArch } from "./dll-locator";

export interface GazeSupervisorPaths {
  /** Directory for persisted config + logs (app.getPath("userData")). */
  userDataDir: string;
  /** Absolute path to gaze-sidecar.cjs. */
  sidecarScript: string;
  /** node_modules dir containing koffi + ws (used as NODE_PATH). */
  sidecarNodeModules: string;
  /** Absolute path to the bundled 32-bit node.exe (for ia32 DLLs). */
  ia32Runtime: string;
  /**
   * Port to request the sidecar bind. Defaults to 0 = let the OS assign a free
   * port. A fixed port (esp. 49152) collides with other eye-gaze software and
   * Windows reserved ranges; the actual bound port is discovered over IPC and
   * surfaced as GazeStatus.port. Set a value only for tests/special cases.
   */
  port?: number;
}

export interface GazeStatus {
  device: string | null;
  dllPath: string | null;
  dllArch: DllArch | null;
  dllFound: boolean;
  /** True when the sidecar process is running. */
  running: boolean;
  /**
   * The localhost port the sidecar is actually serving gaze on, reported by the
   * child over IPC after it binds (the OS assigns it). Null until it reports, or
   * while stopped. The renderer connects to ws://127.0.0.1:<port>.
   */
  port: number | null;
  /** Last status code reported by the sidecar (e.g. "connected"). */
  sidecarCode: string | null;
  sidecarMessage: string | null;
  /** True when we have no DLL and need the user to locate one. */
  needsDll: boolean;
  lastError: string | null;
}

const RESTART_BASE_MS = 2000;
const RESTART_MAX_MS = 30000;

export class GazeSidecarSupervisor {
  private paths: Required<GazeSupervisorPaths>;
  private child: ChildProcess | null = null;
  private device: string | null = null;
  private dllPath: string | null = null;
  private dllArch: DllArch | null = null;
  private sidecarCode: string | null = null;
  private sidecarMessage: string | null = null;
  private lastError: string | null = null;
  /** Live port the current sidecar bound to, reported over IPC. Null when unknown. */
  private port: number | null = null;
  /**
   * Children we killed on purpose. The "exit" event arrives asynchronously, long
   * after the kill call returns, so intent has to be recorded per-child rather
   * than in a flag that has already been reset by then.
   */
  private intentionalKills = new WeakSet<ChildProcess>();
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = RESTART_BASE_MS;

  constructor(paths: GazeSupervisorPaths) {
    // Default to 0: the sidecar binds an OS-assigned free port and reports it
    // back over IPC. An explicit paths.port overrides (tests / special cases).
    this.paths = { port: 0, ...paths };
  }

  // ── Public API ──

  /**
   * Ensure a sidecar is running for `device`. Auto-locates the DLL if one isn't
   * already configured. If no DLL is found, leaves the sidecar stopped and marks
   * needsDll so the client can prompt the user to locate it.
   */
  ensure(device: string): GazeStatus {
    if (this.device === device && this.child && !this.child.killed) {
      return this.getStatus();
    }
    this.device = device;
    this.lastError = null;

    // Configured (manually-set) path wins; otherwise auto-detect.
    const configured = this.loadConfig()[device]?.dllPath;
    if (configured && fs.existsSync(configured)) {
      this.dllPath = configured;
      this.dllArch = readDllArch(configured);
    } else {
      const found = locateDeviceDll(device);
      this.dllPath = found?.path ?? null;
      this.dllArch = found?.arch ?? null;
    }

    if (!this.dllPath) {
      this.killChild();
      this.log(`[supervisor] no DLL found for "${device}" — awaiting manual locate`);
      return this.getStatus();
    }

    this.spawnSidecar();
    return this.getStatus();
  }

  /** Use a hand-picked DLL: persist it for this device and (re)start the sidecar. */
  setDll(device: string, dllPath: string): GazeStatus {
    const config = this.loadConfig();
    config[device] = { dllPath };
    this.saveConfig(config);

    this.device = device;
    this.dllPath = dllPath;
    this.dllArch = readDllArch(dllPath);
    this.lastError = null;
    this.spawnSidecar();
    return this.getStatus();
  }

  /** Forget the configured DLL for a device and re-run auto-detection. */
  clearDll(device: string): GazeStatus {
    const config = this.loadConfig();
    delete config[device];
    this.saveConfig(config);
    this.device = null; // force ensure() to re-evaluate
    return this.ensure(device);
  }

  /**
   * Shut the sidecar down and forget the device. Called when the active student's
   * settings no longer select an eye tracker (e.g. after an account switch), so
   * the supervisor must go fully inert: no restart, and no leftover status for the
   * client to render as a problem.
   */
  stop(): void {
    this.killChild();
    this.device = null;
    this.dllPath = null;
    this.dllArch = null;
    this.sidecarCode = null;
    this.sidecarMessage = null;
    this.lastError = null;
    this.port = null;
  }

  /** Kill the current child (if any) without reporting it as a crash. */
  private killChild(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.child) {
      this.intentionalKills.add(this.child);
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
  }

  getStatus(): GazeStatus {
    return {
      device: this.device,
      dllPath: this.dllPath,
      dllArch: this.dllArch,
      dllFound: !!this.dllPath,
      running: !!(this.child && !this.child.killed),
      port: this.port,
      sidecarCode: this.sidecarCode,
      sidecarMessage: this.sidecarMessage,
      needsDll: !!this.device && !this.dllPath,
      lastError: this.lastError,
    };
  }

  // ── Internals ──

  private spawnSidecar(): void {
    // Tear down any existing child first.
    this.killChild();
    // New process → old port is stale until this one reports which port it bound.
    this.port = null;

    if (!this.dllPath || !this.device) return;

    const { command, extraEnv } = this.resolveRuntime(this.dllArch);
    if (!command) {
      this.lastError = `No runtime available for DLL arch "${this.dllArch}"`;
      this.log(`[supervisor] ${this.lastError}`);
      return;
    }

    const argsArr = [
      this.paths.sidecarScript,
      "--device", this.device,
      "--dll", this.dllPath,
      "--port", String(this.paths.port),
    ];

    this.log(`[supervisor] spawning sidecar: ${command} ${argsArr.join(" ")} (arch=${this.dllArch})`);

    let child: ChildProcess;
    try {
      child = spawn(command, argsArr, {
        env: { ...process.env, NODE_PATH: this.paths.sidecarNodeModules, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch (e) {
      this.lastError = `Failed to spawn sidecar: ${(e as Error).message}`;
      this.log(`[supervisor] ${this.lastError}`);
      this.scheduleRestart();
      return;
    }

    this.child = child;
    this.sidecarCode = "starting";
    this.sidecarMessage = "Sidecar starting";

    child.stdout?.on("data", (buf) => this.handleSidecarOutput(buf.toString()));
    child.stderr?.on("data", (buf) => this.log(`[sidecar:stderr] ${buf.toString().trimEnd()}`));

    // The sidecar reports the OS-assigned port it bound (see gaze-sidecar.cjs).
    child.on("message", (msg: unknown) => {
      if (this.child !== child) return; // stale child
      const m = msg as { type?: string; port?: number } | null;
      if (m && m.type === "gaze-sidecar-listening" && typeof m.port === "number") {
        this.port = m.port;
        this.log(`[supervisor] sidecar listening on port ${m.port}`);
      }
    });

    child.on("exit", (code, signal) => {
      const intentional = this.intentionalKills.has(child);
      this.log(
        `[supervisor] sidecar exited code=${code} signal=${signal}` +
        (intentional ? " (stopped on request)" : ""),
      );
      if (this.child === child) { this.child = null; this.port = null; }
      if (intentional) return;

      this.sidecarCode = "exited";
      this.sidecarMessage = signal
        ? `Eye tracker stopped unexpectedly (signal ${signal})`
        : `Eye tracker stopped unexpectedly (code ${code})`;
      this.scheduleRestart();
    });

    child.on("error", (err) => {
      this.lastError = `Sidecar process error: ${err.message}`;
      this.log(`[supervisor] ${this.lastError}`);
    });

    // Successful (re)start — reset the backoff once we see "connected".
  }

  /**
   * Parse sidecar stdout: it logs human lines, and we also watch for the status
   * markers it prints so getStatus() reflects the live connection state.
   */
  private handleSidecarOutput(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      this.log(`[sidecar] ${line.trimEnd()}`);
      const m = line.match(/STATUS\s+(\w+):\s*(.*)$/);
      if (m) {
        this.sidecarCode = m[1];
        this.sidecarMessage = m[2];
        if (m[1] === "connected") this.restartDelay = RESTART_BASE_MS;
      }
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.dllPath || !this.device) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.log(`[supervisor] restarting sidecar in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnSidecar();
    }, delay);
  }

  /**
   * Choose the runtime executable for the DLL's architecture.
   *   x64   -> the app's Electron binary, run as Node (ELECTRON_RUN_AS_NODE).
   *   ia32  -> the bundled 32-bit Node runtime.
   */
  private resolveRuntime(arch: DllArch | null): { command: string | null; extraEnv: Record<string, string> } {
    if (arch === "x64") {
      return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    if (arch === "ia32") {
      if (fs.existsSync(this.paths.ia32Runtime)) {
        return { command: this.paths.ia32Runtime, extraEnv: {} };
      }
      return { command: null, extraEnv: {} };
    }
    // arm64 / unknown: try Electron-as-node if it matches the host arch.
    if (arch === "arm64" && process.arch === "arm64") {
      return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    return { command: null, extraEnv: {} };
  }

  // ── Config persistence (per-machine DLL choice) ──

  private configFile(): string {
    return path.join(this.paths.userDataDir, "gaze-config.json");
  }
  private loadConfig(): Record<string, { dllPath: string }> {
    try { return JSON.parse(fs.readFileSync(this.configFile(), "utf8")); }
    catch { return {}; }
  }
  private saveConfig(config: Record<string, { dllPath: string }>): void {
    try { fs.writeFileSync(this.configFile(), JSON.stringify(config, null, 2)); }
    catch (e) { this.log(`[supervisor] failed to save config: ${(e as Error).message}`); }
  }

  private logFile(): string {
    return path.join(this.paths.userDataDir, "gaze-sidecar.log");
  }
  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`;
    // eslint-disable-next-line no-console
    console.log(line);
    try { fs.appendFileSync(this.logFile(), line + "\n"); } catch { /* ignore */ }
  }
}
