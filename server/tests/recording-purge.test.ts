// On-device recording purge — the server half.
//
// DB-free: both seams (the live-session registry and the activity log) are
// injected, so this asserts what the server SENDS and what it WRITES without a
// socket or a Postgres. The disk half is `planStudentPurge`, tested in
// aac-session-recording.test.ts.

import type { ActivityLogEntry } from "../services/activityLogService.js";
import type { LiveSessionHandle } from "../services/dual-agent/live-session-registry.js";
import {
  recordRecordingsPurged,
  requestRecordingPurge,
} from "../services/recordingPurge.js";

/** A live session that records what it was asked to do. */
function fakeSession(overrides: Partial<LiveSessionHandle> = {}) {
  const purges: string[] = [];
  const handle: LiveSessionHandle = {
    requestReload: () => {},
    supersede: () => {},
    requestRecordingPurge: (reason) => { purges.push(reason); },
    isClassroom: false,
    ...overrides,
  };
  return { handle, purges };
}

describe("requestRecordingPurge", () => {
  it("reaches the student's live session and reports one socket notified", () => {
    const { handle, purges } = fakeSession();
    const notified = requestRecordingPurge("s1", "erasure", {
      getSession: (id) => (id === "s1" ? handle : null),
    });
    expect(notified).toBe(1);
    expect(purges).toEqual(["erasure"]);
  });

  it("carries the reason through so the audit says which it was", () => {
    const { handle, purges } = fakeSession();
    requestRecordingPurge("s1", "device_revoked", { getSession: () => handle });
    expect(purges).toEqual(["device_revoked"]);
  });

  it("reports zero when nobody is connected — the common case, not an error", () => {
    // The device most in need of a purge is usually the one that is switched
    // off. This must be an ordinary answer, not a throw inside an erasure.
    expect(requestRecordingPurge("s1", "erasure", { getSession: () => null })).toBe(0);
  });

  it("treats a session without the method as nobody listening", () => {
    // The legacy relay never registers, and an older coordinator build has no
    // such method. Neither may crash the erasure that called us.
    const { handle } = fakeSession({ requestRecordingPurge: undefined });
    expect(requestRecordingPurge("s1", "erasure", { getSession: () => handle })).toBe(0);
  });

  it("swallows a throwing socket", () => {
    // A WebSocket mid-close is not a reason for an erasure to fail.
    const { handle } = fakeSession({
      requestRecordingPurge: () => { throw new Error("socket closed"); },
    });
    expect(() => requestRecordingPurge("s1", "erasure", { getSession: () => handle })).not.toThrow();
    expect(requestRecordingPurge("s1", "erasure", { getSession: () => handle })).toBe(0);
  });

  it("refuses a blank student id without touching the registry", () => {
    let looked = 0;
    for (const id of ["", "   "]) {
      expect(requestRecordingPurge(id, "erasure", {
        getSession: () => { looked++; return null; },
      })).toBe(0);
    }
    expect(looked).toBe(0);
  });
});

describe("recordRecordingsPurged", () => {
  const capture = () => {
    const rows: ActivityLogEntry[] = [];
    return { rows, log: (entry: ActivityLogEntry) => { rows.push(entry); } };
  };

  it("writes a delete row against the student", () => {
    const { rows, log } = capture();
    recordRecordingsPurged({ studentId: "s1", clipIds: ["a", "b"], userId: "u1" }, { log });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("delete");
    expect(rows[0].subjectType1).toBe("student");
    expect(rows[0].subjectId1).toBe("s1");
    expect(rows[0].userId).toBe("u1");
    expect(rows[0].details).toMatchObject({ route: "device.recordings_purged", clipCount: 2 });
  });

  it("logs an EMPTY purge too", () => {
    // "The device was asked and had nothing" is the fact the erasure record
    // needs. Suppressing it would leave a silence that reads like no answer.
    const { rows, log } = capture();
    recordRecordingsPurged({ studentId: "s1", clipIds: [] }, { log });
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ clipCount: 0 });
  });

  it("marks every row best-effort", () => {
    // A reader must never take one of these as proof the device holds nothing:
    // unattributable clips are skipped, and an offline device is never asked.
    const { rows, log } = capture();
    recordRecordingsPurged({ studentId: "s1", clipIds: ["a"] }, { log });
    expect(rows[0].details).toMatchObject({ bestEffort: true });
  });

  it("includes the device only when the caller knows it", () => {
    const { rows, log } = capture();
    recordRecordingsPurged({ studentId: "s1", clipIds: [], deviceId: "dev-9" }, { log });
    expect(rows[0].details).toMatchObject({ deviceId: "dev-9" });

    const second = capture();
    recordRecordingsPurged({ studentId: "s1", clipIds: [] }, { log: second.log });
    expect(second.rows[0].details).not.toHaveProperty("deviceId");
  });

  it("counts only string clip ids from a wire payload", () => {
    // `clipIds` arrives from a client message; a hand-crafted socket must not
    // be able to inflate the count with junk.
    const { rows, log } = capture();
    recordRecordingsPurged(
      { studentId: "s1", clipIds: ["a", 7, null, "b"] as unknown as string[] },
      { log },
    );
    expect(rows[0].details).toMatchObject({ clipCount: 2 });
  });
});
