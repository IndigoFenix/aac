// shared/app-instances.ts
//
// "Is more than one copy of the app running?" — the wire types plus the pure
// classification rule, shared by BOTH sides of the bridge:
//   - electron/instance-guard.ts scans the OS process table and EMITS a report
//   - client-aac/src/hooks/useAppInstances.ts CONSUMES it for the warning banner
//
// Counting processes by executable name is NOT enough on Electron: the GPU
// process, every renderer, the utility processes and the crashpad handler are
// all spawned from the SAME exe as the app itself, and so is our gaze sidecar
// (it runs `Aivota AAC.exe` with ELECTRON_RUN_AS_NODE=1 — see
// hardware/gaze-sidecar-supervisor.ts). A naive count reports "6 copies
// running" on a perfectly healthy machine.
//
// The distinguishing mark is the command line: Chromium passes `--type=<role>`
// to every child it spawns, and only a real top-level app instance has no
// `--type=` at all. That rule is pure, so it lives here and is unit-tested
// (server/tests/app-instances.test.ts) rather than being trapped inside a
// main-process module that can't be imported without Electron.

/** One raw row from the OS process table (Win32_Process on Windows). */
export interface RawProcessRow {
  pid: number;
  exePath: string | null;
  commandLine: string | null;
}

/** A peer top-level instance of the app — a genuine second copy. */
export interface AppInstance {
  pid: number;
  exePath: string | null;
  /**
   * True when this peer runs from a different directory than we do, i.e. there
   * are two INSTALLS on the machine (the classic cause: an all-users install in
   * Program Files alongside a per-user one in AppData\Local\Programs, each with
   * its own shortcut and its own update feed).
   */
  differentInstall: boolean;
}

export interface AppInstanceReport {
  selfPid: number;
  selfExePath: string;
  /** Top-level instances OTHER than this process. Empty is the healthy case. */
  peers: AppInstance[];
  /** True when at least one peer runs from a different install directory. */
  multipleInstalls: boolean;
  /**
   * Processes we could see but not classify (no readable command line — another
   * Windows user's session, or an elevated process). Reported for diagnostics
   * but deliberately NOT counted as peers: guessing here would put a scary
   * banner in front of a student over a permissions quirk.
   */
  unclassified: number;
  /** Non-null when the scan could not run at all (wrong OS, tool missing, timeout). */
  error: string | null;
  /** Whether this process holds the single-instance lock. */
  hasLock: boolean;
}

/** Command-line marks that identify a CHILD process rather than an app instance. */
const CHILD_MARKERS = [
  // Chromium's own helpers: renderer, gpu-process, utility, crashpad-handler…
  "--type=",
  // Our gaze sidecar, which runs the app's own exe as a plain Node process. The
  // script-argument rule below also catches it; naming it keeps the known case
  // obvious to whoever reads this next.
  "gaze-sidecar",
];

/**
 * Strip the leading executable token from a Windows command line and return the
 * rest.
 *
 * Handles both forms Win32_Process reports: quoted (`"C:\dir with space\app.exe"
 * --flag`) and bare (`C:\dir\app.exe --flag`). The bare form cannot be split on
 * the first space — this app's own exe name *contains* one ("Aivota AAC.exe") —
 * so the `.exe` suffix is the token boundary instead.
 */
function argsAfterExe(commandLine: string): string[] {
  const line = commandLine.trim();
  let rest: string;
  if (line.startsWith('"')) {
    const close = line.indexOf('"', 1);
    rest = close === -1 ? "" : line.slice(close + 1);
  } else {
    const exe = line.toLowerCase().indexOf(".exe");
    if (exe !== -1) {
      rest = line.slice(exe + ".exe".length);
    } else {
      const space = line.indexOf(" ");
      rest = space === -1 ? "" : line.slice(space + 1);
    }
  }
  return rest.trim().split(/\s+/).filter(Boolean);
}

/**
 * True when the command line carries a POSITIONAL argument — anything that is not
 * a `-`/`--`/`/` switch.
 *
 * This is the general form of "it is an Electron-as-node child": every such child
 * is handed a script path as its first argument (our gaze sidecar's
 * `gaze-sidecar.cjs`, and — observed while building this — VS Code's language
 * servers, one of which has no file extension at all, so matching on `.js` is not
 * enough). A real top-level launch of this app gets switches or nothing: the
 * shortcut passes no arguments, and the updater's relaunch passes `--updated` /
 * `--force-run`. If the app ever registers a file association or a protocol
 * handler, a genuine launch WOULD arrive with a positional argument and this rule
 * would have to learn about it.
 */
function hasPositionalArg(commandLine: string): boolean {
  return argsAfterExe(commandLine).some((arg) => !/^[-/]/.test(arg));
}

/** Case-insensitive path compare — Windows paths differ only in case routinely. */
function sameDir(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const dir = (p: string) => p.replace(/\\/g, "/").replace(/\/[^/]*$/, "").toLowerCase();
  return dir(a) === dir(b);
}

/**
 * Reduce a raw process listing to the peer instances of this app.
 *
 * `rows` must already be filtered to processes running the app's executable
 * name (any install directory — that is the point). This function drops our own
 * pid and every child process, so what remains is one row per running copy.
 */
export function classifyInstances(
  rows: RawProcessRow[],
  selfPid: number,
  selfExePath: string,
): { peers: AppInstance[]; unclassified: number } {
  const peers: AppInstance[] = [];
  let unclassified = 0;

  for (const row of rows) {
    if (row.pid === selfPid) continue;
    if (row.commandLine == null || row.commandLine === "") {
      unclassified++;
      continue;
    }
    const cmd = row.commandLine.toLowerCase();
    if (CHILD_MARKERS.some((marker) => cmd.includes(marker))) continue;
    if (hasPositionalArg(row.commandLine)) continue;
    peers.push({
      pid: row.pid,
      exePath: row.exePath,
      differentInstall: !!row.exePath && !sameDir(row.exePath, selfExePath),
    });
  }

  return { peers, unclassified };
}

/** Convenience: the healthy state is "no peers". */
export function isSingleInstance(report: AppInstanceReport | null): boolean {
  return !report || report.peers.length === 0;
}

/**
 * Normalize the process listing PowerShell's `ConvertTo-Json` produces.
 *
 * Two shapes have to be handled: a bare object for a single match, an array for
 * several. Anything unparseable degrades to an empty list — a scan hiccup must
 * read as "no duplicates found", never as an error a student sees. Lives here
 * with the classifier so both halves of the rule are testable without Electron.
 */
export function parseCimJson(stdout: string): RawProcessRow[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: RawProcessRow[] = [];
  for (const item of list) {
    const row = item as { ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown };
    if (typeof row?.ProcessId !== "number") continue;
    rows.push({
      pid: row.ProcessId,
      exePath: typeof row.ExecutablePath === "string" ? row.ExecutablePath : null,
      commandLine: typeof row.CommandLine === "string" ? row.CommandLine : null,
    });
  }
  return rows;
}
