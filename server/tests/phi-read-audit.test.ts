/**
 * Pins the per-request PHI read audit (server/middleware/phi-read-audit.ts):
 * which routes count as a student read, where the student id comes from, and
 * that identical reads are coalesced per window rather than logged per poll.
 *
 * DB-free: the matcher and the coalescer are pure.
 */

import { describe, it, expect } from "@jest/globals";
import { matchPhiRead, ReadCoalescer, PHI_READ_RULES } from "../middleware/phi-read-audit.js";

const S = "0904028e-63b8-48cf-bbd3-34d0b798a7c3";

describe("matchPhiRead", () => {
  it.each([
    [`/api/students/${S}`, {}, "student"],
    [`/api/students/${S}/reports`, {}, "student.reports"],
    [`/api/students/${S}/reports/medical`, {}, "student.reports"],
    [`/api/students/${S}/incidents`, {}, "student.incidents"],
    [`/api/students/${S}/programs`, {}, "student.programs"],
    [`/api/biometric/students/${S}/contacts`, {}, "student.contacts"],
    [`/api/photos/student/${S}`, {}, "student.photos"],
    [`/api/boards/student/${S}`, {}, "student.boards"],
    [`/api/aac/students/${S}/known-people`, {}, "aac.known-people"],
    [`/api/aac/students/${S}/people-directory`, {}, "aac.people-directory"],
    [`/api/aac/students/${S}/people/abc/photo`, {}, "aac.person-photo"],
    [`/api/aac/photos`, { studentId: S }, "aac.photos"],
    [`/api/aac/dual/session/sess-1`, { studentId: S }, "aac.dual-session"],
    [`/api/deep-analysis`, { studentId: S }, "deep-analysis.list"],
  ])("%s → %s", (path, query, route) => {
    const hit = matchPhiRead(path, query as Record<string, unknown>);
    expect(hit).not.toBeNull();
    expect(hit!.route).toBe(route);
    expect(hit!.studentId).toBe(S);
  });

  it("does not match non-student routes", () => {
    for (const p of ["/api/auth/user", "/api/institutes/x/members", "/api/venue-menus/1", "/health", "/api/students"]) {
      expect(matchPhiRead(p, {})).toBeNull();
    }
  });

  it("returns a null student when the query id is missing (nothing to attribute)", () => {
    expect(matchPhiRead("/api/aac/photos", {})?.studentId).toBeNull();
    expect(matchPhiRead("/api/aac/photos", { studentId: 42 })?.studentId).toBeNull();
  });

  it("every rule yields a student id by exactly one mechanism", () => {
    for (const r of PHI_READ_RULES) {
      const mechanisms = [r.studentGroup !== undefined, !!r.studentQuery].filter(Boolean).length;
      expect({ route: r.route, mechanisms }).toEqual({ route: r.route, mechanisms: 1 });
    }
  });
});

describe("ReadCoalescer", () => {
  it("logs the first read and suppresses repeats inside the window", () => {
    const c = new ReadCoalescer(1000);
    expect(c.shouldLog("u|r|s", 0)).toBe(true);
    expect(c.shouldLog("u|r|s", 500)).toBe(false);
    expect(c.shouldLog("u|r|s", 999)).toBe(false);
  });

  it("logs again once the window has passed", () => {
    const c = new ReadCoalescer(1000);
    expect(c.shouldLog("u|r|s", 0)).toBe(true);
    expect(c.shouldLog("u|r|s", 1000)).toBe(true);
  });

  it("keys are independent — a different user, route or student is its own read", () => {
    const c = new ReadCoalescer(1000);
    expect(c.shouldLog("u1|r|s", 0)).toBe(true);
    expect(c.shouldLog("u2|r|s", 0)).toBe(true);
    expect(c.shouldLog("u1|r2|s", 0)).toBe(true);
    expect(c.shouldLog("u1|r|s2", 0)).toBe(true);
  });
});
