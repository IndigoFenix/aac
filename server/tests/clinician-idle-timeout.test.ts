/**
 * Automatic logoff for non-AAC sessions (§164.312(a)(2)(iii)).
 *
 * Pins the pure decision in session-lifetime.ts: a clinician/admin session
 * that has been silent longer than the idle timeout is reported expired; an
 * AAC device session is never touched by it (the appliance stays signed in —
 * device-slot revocation is what ends it); and the activity stamp is
 * rewritten at most once per minute so the check does not cost a session
 * write per request.
 *
 * DB-free — pure logic, lives in the unit config.
 */

import { describe, it, expect } from "@jest/globals";
import {
  touchClinicianActivity,
  CLINICIAN_IDLE_TIMEOUT_MS,
  CLINICIAN_ACTIVITY_STAMP_INTERVAL_MS,
  type AacSessionLike,
} from "../session-lifetime.js";

const MIN = 60_000;
const session = (over: Partial<AacSessionLike> = {}): AacSessionLike => ({
  cookie: { maxAge: 24 * 60 * MIN },
  ...over,
});

describe("touchClinicianActivity", () => {
  it("defaults to a 30-minute idle timeout", () => {
    expect(CLINICIAN_IDLE_TIMEOUT_MS).toBe(30 * MIN);
  });

  it("stamps a fresh session and reports it active", () => {
    const s = session();
    expect(touchClinicianActivity(s, 1_000_000)).toBe("active");
    expect(s.lastActivityAt).toBe(1_000_000);
  });

  it("stays active inside the window and expires after it", () => {
    const s = session({ lastActivityAt: 0 });
    expect(touchClinicianActivity(s, CLINICIAN_IDLE_TIMEOUT_MS)).toBe("active");
    const s2 = session({ lastActivityAt: 0 });
    expect(touchClinicianActivity(s2, CLINICIAN_IDLE_TIMEOUT_MS + 1)).toBe("expired");
  });

  it("does not rewrite the stamp on every request", () => {
    const s = session({ lastActivityAt: 0 });
    expect(touchClinicianActivity(s, CLINICIAN_ACTIVITY_STAMP_INTERVAL_MS - 1)).toBe("active");
    expect(s.lastActivityAt).toBe(0); // unchanged: inside the stamp interval
    expect(touchClinicianActivity(s, CLINICIAN_ACTIVITY_STAMP_INTERVAL_MS)).toBe("active");
    expect(s.lastActivityAt).toBe(CLINICIAN_ACTIVITY_STAMP_INTERVAL_MS); // rewritten
  });

  it("never applies to an AAC device session", () => {
    const s = session({ aacClient: true, lastActivityAt: 0 });
    expect(touchClinicianActivity(s, 365 * 24 * 60 * MIN)).toBe("not-applicable");
    expect(s.lastActivityAt).toBe(0);
  });

  it("does not expire a session that predates the check (no stamp yet)", () => {
    // Sessions from before this shipped have no lastActivityAt; they get
    // stamped on first contact rather than thrown out.
    const s = session();
    expect(touchClinicianActivity(s, 10 * 24 * 60 * MIN)).toBe("active");
  });

  it("honours an explicit timeout", () => {
    const s = session({ lastActivityAt: 0 });
    expect(touchClinicianActivity(s, 5 * MIN + 1, 5 * MIN)).toBe("expired");
  });

  it("tolerates a missing session", () => {
    expect(touchClinicianActivity(undefined)).toBe("not-applicable");
    expect(touchClinicianActivity(null)).toBe("not-applicable");
  });
});
