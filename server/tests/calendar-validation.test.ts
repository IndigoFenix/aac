/**
 * Calendar event date validation — guards against impossible date
 * combinations the AI (or a user) can produce. The motivating incident
 * (session c2061a41): a recurring weekly series created with startTime
 * Sept 1 2026 but repeatEndDate June 30 2026 — the series expands to zero
 * occurrences, so the event exists in the DB but never renders anywhere
 * while the AI reports success.
 */

import { describe, it, expect } from "@jest/globals";
import { validateEventDates, CalendarValidationError } from "../services/calendar-validation";

describe("validateEventDates", () => {
  it("accepts a simple event with endTime after startTime", () => {
    expect(() =>
      validateEventDates({
        startTime: new Date("2026-06-10T08:00:00Z"),
        endTime: new Date("2026-06-10T14:30:00Z"),
        repeatType: "none",
      }),
    ).not.toThrow();
  });

  it("rejects endTime before startTime", () => {
    expect(() =>
      validateEventDates({
        startTime: new Date("2026-06-10T14:30:00Z"),
        endTime: new Date("2026-06-10T08:00:00Z"),
      }),
    ).toThrow(CalendarValidationError);
  });

  it("rejects a recurring series whose repeatEndDate precedes startTime (session c2061a41 shape)", () => {
    expect(() =>
      validateEventDates({
        startTime: new Date("2026-09-01T05:00:00Z"),
        endTime: new Date("2026-09-01T11:30:00Z"),
        repeatType: "weekly",
        repeatEndDate: new Date("2026-06-30T20:59:59Z"),
      }),
    ).toThrow(/repeatEndDate .* is before startTime/);
  });

  it("accepts a recurring series whose repeatEndDate follows startTime", () => {
    expect(() =>
      validateEventDates({
        startTime: new Date("2026-06-10T05:00:00Z"),
        endTime: new Date("2026-06-10T11:30:00Z"),
        repeatType: "weekly",
        repeatEndDate: new Date("2026-06-30T20:59:59Z"),
      }),
    ).not.toThrow();
  });

  it("ignores a stale repeatEndDate when repeatType is none", () => {
    // A one-time event keeps whatever repeatEndDate is lying around — it is
    // never read, so it must not block the save.
    expect(() =>
      validateEventDates({
        startTime: new Date("2026-09-01T05:00:00Z"),
        endTime: new Date("2026-09-01T11:30:00Z"),
        repeatType: "none",
        repeatEndDate: new Date("2026-06-30T20:59:59Z"),
      }),
    ).not.toThrow();
  });

  it("tolerates missing/null fields (partial updates validate the merged event upstream)", () => {
    expect(() => validateEventDates({})).not.toThrow();
    expect(() =>
      validateEventDates({ startTime: new Date("2026-06-10T08:00:00Z"), endTime: null, repeatType: "weekly", repeatEndDate: null }),
    ).not.toThrow();
  });
});
