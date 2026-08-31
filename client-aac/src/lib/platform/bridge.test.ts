// The erasure accessor on the platform bridge.
//
// The contract under test is not "does it delete" — that is the Electron main
// process, tested via `planStudentPurge` in the server suite. It is that this
// function ALWAYS RESOLVES: every caller's next act is to tell the server what
// happened, and a throw would leave an erasure waiting for an acknowledgement
// that a web client was never able to send.

import { purgeStudentRecordings } from "./bridge";

type Purge = (opts: { studentId: string }) => Promise<unknown>;

/** Install a fake `window.electronAPI.recording.purgeStudent`, or none. */
function withBridge(purgeStudent: Purge | null | undefined, hasRecording = true) {
  const g = globalThis as unknown as { window?: unknown };
  const recording = hasRecording ? (purgeStudent ? { purgeStudent } : {}) : undefined;
  g.window = { electronAPI: { isElectron: true, ...(recording ? { recording } : {}) } };
}

function withoutWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

describe("purgeStudentRecordings", () => {
  afterEach(withoutWindow);

  it("returns what the shell deleted", async () => {
    withBridge(async () => ({ clipIds: ["a", "b"], bytes: 2048 }));
    await expect(purgeStudentRecordings("s1")).resolves.toEqual({
      clipIds: ["a", "b"], bytes: 2048,
    });
  });

  it("passes the student through", async () => {
    const seen: string[] = [];
    withBridge(async ({ studentId }) => { seen.push(studentId); return { clipIds: [], bytes: 0 }; });
    await purgeStudentRecordings("s7");
    expect(seen).toEqual(["s7"]);
  });

  it("answers empty on a host that cannot record", async () => {
    // iPad and the browser build have no recording bridge at all. The server
    // still needs an ack, so this is an ANSWER, not a failure.
    withBridge(null, false);
    await expect(purgeStudentRecordings("s1")).resolves.toEqual({ clipIds: [], bytes: 0 });
  });

  it("answers empty on an older shell with no purge handler", async () => {
    withBridge(undefined);
    await expect(purgeStudentRecordings("s1")).resolves.toEqual({ clipIds: [], bytes: 0 });
  });

  it("answers empty with no native shell at all", async () => {
    withoutWindow();
    await expect(purgeStudentRecordings("s1")).resolves.toEqual({ clipIds: [], bytes: 0 });
  });

  it("swallows a rejecting bridge rather than stranding the ack", async () => {
    withBridge(async () => { throw new Error("ipc gone"); });
    await expect(purgeStudentRecordings("s1")).resolves.toEqual({ clipIds: [], bytes: 0 });
  });

  it("normalizes a malformed reply", async () => {
    withBridge(async () => ({ clipIds: "not-an-array", bytes: "lots" }));
    await expect(purgeStudentRecordings("s1")).resolves.toEqual({ clipIds: [], bytes: 0 });
  });

  it("refuses a blank student id without calling the shell", async () => {
    let called = 0;
    withBridge(async () => { called++; return { clipIds: ["a"], bytes: 1 }; });
    await expect(purgeStudentRecordings("")).resolves.toEqual({ clipIds: [], bytes: 0 });
    expect(called).toBe(0);
  });
});
