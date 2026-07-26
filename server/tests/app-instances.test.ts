// Duplicate-instance detection: the classification rule that separates a real
// second copy of the app from the swarm of child processes Electron spawns from
// the SAME executable.
//
// This is the whole risk in the feature: get it wrong and a healthy machine puts
// a red "another copy is running" banner in front of a student (or, worse, stays
// silent while a duplicate quietly holds the eye-tracker DLL).

import {
  classifyInstances,
  isSingleInstance,
  parseCimJson,
  type AppInstanceReport,
  type RawProcessRow,
} from "@shared/app-instances";

const SELF_PID = 1000;
const SELF_EXE = "C:\\Users\\Kid\\AppData\\Local\\Programs\\aivota-aac\\Aivota AAC.exe";

function row(pid: number, commandLine: string | null, exePath: string | null = SELF_EXE): RawProcessRow {
  return { pid, exePath, commandLine };
}

describe("classifyInstances", () => {
  it("reports no peers for a healthy single instance and all its children", () => {
    const rows = [
      row(SELF_PID, `"${SELF_EXE}"`),
      row(1001, `"${SELF_EXE}" --type=gpu-process --field-trial-handle=1234`),
      row(1002, `"${SELF_EXE}" --type=renderer --app-path=... --enable-sandbox`),
      row(1003, `"${SELF_EXE}" --type=utility --utility-sub-type=network.mojom.NetworkService`),
      row(1004, `"${SELF_EXE}" --type=crashpad-handler --database=...`),
    ];

    const { peers, unclassified } = classifyInstances(rows, SELF_PID, SELF_EXE);

    expect(peers).toEqual([]);
    expect(unclassified).toBe(0);
  });

  it("does not mistake the gaze sidecar for a second copy of the app", () => {
    // The sidecar IS the app's exe, run as plain Node — no --type= to filter on.
    const rows = [
      row(SELF_PID, `"${SELF_EXE}"`),
      row(
        1005,
        `"${SELF_EXE}" "C:\\...\\resources\\gaze-sidecar\\gaze-sidecar.cjs" --device tobii --dll C:\\x.dll --port 0`,
      ),
    ];

    expect(classifyInstances(rows, SELF_PID, SELF_EXE).peers).toEqual([]);
  });

  it("does not mistake any OTHER Electron-as-node child for an instance", () => {
    // The generalized rule: a node-mode child is always handed a script path as a
    // positional argument. Observed on a real machine while building this — one of
    // VS Code's language-server children has no file extension at all, so matching
    // on ".js" would have counted it as a second copy of the editor.
    const rows = [
      row(SELF_PID, `"${SELF_EXE}"`),
      row(6000, `"${SELF_EXE}" "C:\\app\\resources\\someServerMain" --node-ipc --clientProcessId=1`),
      row(6001, `"${SELF_EXE}" C:\\app\\helper.js --node-ipc`),
    ];

    expect(classifyInstances(rows, SELF_PID, SELF_EXE).peers).toEqual([]);
  });

  it("still counts an instance launched with switches (the updater's relaunch)", () => {
    // --updated / --force-run reach a genuine top-level launch; they must not be
    // read as "this is a child process".
    const rows = [
      row(SELF_PID, `"${SELF_EXE}"`),
      row(7000, `"${SELF_EXE}" --updated --force-run`),
      // Unquoted exe path, no arguments — the other command-line shape.
      row(7001, `${SELF_EXE}`),
    ];

    expect(classifyInstances(rows, SELF_PID, SELF_EXE).peers.map((p) => p.pid)).toEqual([7000, 7001]);
  });

  it("reports a genuine second instance from the same install", () => {
    const rows = [
      row(SELF_PID, `"${SELF_EXE}"`),
      row(2000, `"${SELF_EXE}"`),
      row(2001, `"${SELF_EXE}" --type=renderer`),
    ];

    const { peers } = classifyInstances(rows, SELF_PID, SELF_EXE);

    expect(peers).toEqual([{ pid: 2000, exePath: SELF_EXE, differentInstall: false }]);
  });

  it("flags a peer running from a DIFFERENT install directory", () => {
    // The classic all-users + per-user double install: two shortcuts, two update
    // feeds, two sidecars fighting over one tracker.
    const otherExe = "C:\\Program Files\\Aivota AAC\\Aivota AAC.exe";
    const rows = [row(SELF_PID, `"${SELF_EXE}"`), row(3000, `"${otherExe}"`, otherExe)];

    const { peers } = classifyInstances(rows, SELF_PID, SELF_EXE);

    expect(peers).toEqual([{ pid: 3000, exePath: otherExe, differentInstall: true }]);
  });

  it("treats a path that differs only in case as the same install", () => {
    const sameExeOtherCase = SELF_EXE.toUpperCase();
    const rows = [row(SELF_PID, `"${SELF_EXE}"`), row(3001, `"${sameExeOtherCase}"`, sameExeOtherCase)];

    expect(classifyInstances(rows, SELF_PID, SELF_EXE).peers[0].differentInstall).toBe(false);
  });

  it("counts an unreadable command line as unclassified, never as a peer", () => {
    // Another Windows user's session / an elevated process: Win32_Process hands
    // back a null CommandLine. Guessing would show a scary banner over a
    // permissions quirk, so these are reported but not counted.
    const rows = [row(SELF_PID, `"${SELF_EXE}"`), row(4000, null), row(4001, "")];

    const { peers, unclassified } = classifyInstances(rows, SELF_PID, SELF_EXE);

    expect(peers).toEqual([]);
    expect(unclassified).toBe(2);
  });

  it("ignores our own pid even when it appears with no arguments", () => {
    expect(classifyInstances([row(SELF_PID, SELF_EXE)], SELF_PID, SELF_EXE).peers).toEqual([]);
  });
});

describe("isSingleInstance", () => {
  const report = (peers: AppInstanceReport["peers"]): AppInstanceReport => ({
    selfPid: SELF_PID,
    selfExePath: SELF_EXE,
    peers,
    multipleInstalls: false,
    unclassified: 0,
    error: null,
    hasLock: true,
  });

  it("is true with no report at all (non-Electron hosts must not warn)", () => {
    expect(isSingleInstance(null)).toBe(true);
  });

  it("is true with an empty peer list and false with any peer", () => {
    expect(isSingleInstance(report([]))).toBe(true);
    expect(isSingleInstance(report([{ pid: 9, exePath: null, differentInstall: false }]))).toBe(false);
  });
});

describe("parseCimJson", () => {
  it("normalizes the single-match case, which PowerShell emits as a bare object", () => {
    const json = JSON.stringify({ ProcessId: 42, ExecutablePath: SELF_EXE, CommandLine: "x" });

    expect(parseCimJson(json)).toEqual([{ pid: 42, exePath: SELF_EXE, commandLine: "x" }]);
  });

  it("reads the multi-match array form and preserves nulls", () => {
    const json = JSON.stringify([
      { ProcessId: 1, ExecutablePath: SELF_EXE, CommandLine: "a" },
      { ProcessId: 2, ExecutablePath: null, CommandLine: null },
    ]);

    expect(parseCimJson(json)).toEqual([
      { pid: 1, exePath: SELF_EXE, commandLine: "a" },
      { pid: 2, exePath: null, commandLine: null },
    ]);
  });

  it("returns nothing for empty or unparseable output rather than throwing", () => {
    // No matches at all → PowerShell prints nothing. A scan hiccup must degrade
    // to "no duplicates found", not to an error surfaced at the student.
    expect(parseCimJson("")).toEqual([]);
    expect(parseCimJson("   \r\n")).toEqual([]);
    expect(parseCimJson("Get-CimInstance : Access denied")).toEqual([]);
  });

  it("skips rows without a numeric pid", () => {
    const json = JSON.stringify([{ ExecutablePath: SELF_EXE }, { ProcessId: "7" }, { ProcessId: 8 }]);

    expect(parseCimJson(json)).toEqual([{ pid: 8, exePath: null, commandLine: null }]);
  });
});
