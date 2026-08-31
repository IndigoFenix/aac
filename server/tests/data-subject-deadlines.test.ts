/**
 * Forward-deadline policy for data-subject requests (AKIM §18.3).
 *
 * DB-free by construction: this is the module that decides when we are late,
 * and the property worth pinning is that the answer depends on nothing but the
 * row and the clock.
 */

import { describe, it, expect } from "@jest/globals";
import {
  FORWARD_DEADLINE_HOURS,
  DEFAULT_WARNING_HORIZON_HOURS,
  addHours,
  computeForwardDeadline,
  classifyForward,
  forwardTimeRemainingMs,
  requestReference,
} from "../services/data-subject-deadlines.js";

const RECEIVED = new Date("2026-03-01T09:00:00.000Z");

function row(overrides: Partial<{ status: string; forwardDeadlineAt: Date | null; forwardedAt: Date | null }> = {}) {
  return {
    status: "open",
    forwardDeadlineAt: computeForwardDeadline(RECEIVED),
    forwardedAt: null,
    ...overrides,
  };
}

describe("computeForwardDeadline", () => {
  it("is 72 hours after receipt", () => {
    expect(FORWARD_DEADLINE_HOURS).toBe(72);
    expect(computeForwardDeadline(RECEIVED).toISOString()).toBe("2026-03-04T09:00:00.000Z");
  });

  it("does not mutate the date it was given", () => {
    const received = new Date(RECEIVED);
    computeForwardDeadline(received);
    expect(received.getTime()).toBe(RECEIVED.getTime());
  });

  it("accepts an override so a per-contract window can differ later", () => {
    expect(computeForwardDeadline(RECEIVED, 24).toISOString()).toBe("2026-03-02T09:00:00.000Z");
  });
});

describe("classifyForward", () => {
  it("is met while the deadline is comfortably ahead", () => {
    expect(classifyForward(row(), addHours(RECEIVED, 1))).toBe("met");
  });

  it("warns inside the horizon", () => {
    // 72h window, 24h horizon → warning opens at T+48h.
    expect(classifyForward(row(), addHours(RECEIVED, 47))).toBe("met");
    expect(classifyForward(row(), addHours(RECEIVED, 49))).toBe("approaching");
    expect(DEFAULT_WARNING_HORIZON_HOURS).toBe(24);
  });

  it("is overdue once the deadline passes with nothing forwarded", () => {
    expect(classifyForward(row(), addHours(RECEIVED, 73))).toBe("overdue");
  });

  it("treats the deadline instant itself as overdue, not as met", () => {
    // Off-by-one here is the difference between an alert that fires and one
    // that never does; the boundary is deliberately inclusive.
    expect(classifyForward(row(), addHours(RECEIVED, 72))).toBe("overdue");
  });

  it("stops caring once the request was forwarded", () => {
    const forwarded = row({ forwardedAt: addHours(RECEIVED, 100), status: "forwarded" });
    expect(classifyForward(forwarded, addHours(RECEIVED, 500))).toBe("na");
  });

  it("stops caring on a terminal status even if nothing was forwarded", () => {
    // Re-alerting forever on a withdrawn request trains people to ignore the
    // alert, which costs more than the reminder is worth.
    for (const status of ["fulfilled", "denied", "withdrawn"]) {
      expect(classifyForward(row({ status }), addHours(RECEIVED, 500))).toBe("na");
    }
  });

  it("is na when no deadline was ever frozen", () => {
    expect(classifyForward(row({ forwardDeadlineAt: null }), addHours(RECEIVED, 500))).toBe("na");
  });

  it("honours a caller-supplied horizon", () => {
    expect(classifyForward(row(), addHours(RECEIVED, 25), 48)).toBe("approaching");
    expect(classifyForward(row(), addHours(RECEIVED, 23), 48)).toBe("met");
  });
});

describe("forwardTimeRemainingMs", () => {
  it("goes negative once the deadline has passed", () => {
    expect(forwardTimeRemainingMs(row(), addHours(RECEIVED, 71))).toBe(60 * 60 * 1000);
    expect(forwardTimeRemainingMs(row(), addHours(RECEIVED, 73))).toBe(-60 * 60 * 1000);
  });
});

describe("requestReference", () => {
  it("derives a stable handle from the id", () => {
    const id = "3f2a1b4c-5d6e-7f80-9012-3456789abcde";
    expect(requestReference(id)).toBe("DSR-3F2A1B4C");
    expect(requestReference(id)).toBe(requestReference(id));
  });

  it("survives an id with no dashes", () => {
    expect(requestReference("abcdef0123456789")).toBe("DSR-ABCDEF01");
  });
});
