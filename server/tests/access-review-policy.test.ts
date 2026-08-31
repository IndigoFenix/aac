/**
 * The dormancy rules, tested without a database.
 *
 * The boundaries are the whole point: 89 days is not dormant and 90 is, an
 * account that was never used is a different finding from one that went quiet,
 * and — the case that matters most — auto-deactivation must do NOTHING unless
 * a deployment has explicitly opted in. A default that silently disables
 * clinicians would be a far worse bug than the gap it closes.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import {
  AUTO_DEACTIVATE_ENV_VAR,
  DORMANT_AFTER_DAYS,
  autoDeactivateAfterDays,
  classifyAccount,
  daysSince,
  idleDays,
  idleSince,
  shouldAutoDeactivate,
} from "../services/access-review-policy";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

const originalEnv = process.env[AUTO_DEACTIVATE_ENV_VAR];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[AUTO_DEACTIVATE_ENV_VAR];
  else process.env[AUTO_DEACTIVATE_ENV_VAR] = originalEnv;
});

describe("classifyAccount", () => {
  it("calls a recently seen account active", () => {
    expect(
      classifyAccount({ lastActiveAt: daysAgo(1), createdAt: daysAgo(400), isActive: true }, NOW),
    ).toBe("active");
  });

  it("is still active one day inside the threshold", () => {
    expect(
      classifyAccount({ lastActiveAt: daysAgo(DORMANT_AFTER_DAYS - 1), isActive: true }, NOW),
    ).toBe("active");
  });

  it("is dormant exactly ON the threshold", () => {
    expect(
      classifyAccount({ lastActiveAt: daysAgo(DORMANT_AFTER_DAYS), isActive: true }, NOW),
    ).toBe("dormant");
  });

  it("is dormant well past the threshold", () => {
    expect(classifyAccount({ lastActiveAt: daysAgo(400), isActive: true }, NOW)).toBe("dormant");
  });

  it("separates never-used from dormant", () => {
    // An invitation nobody took up is a different conversation from a
    // clinician who stopped coming in: one is provisioning waste, the other
    // may be a role change nobody told us about.
    expect(classifyAccount({ lastActiveAt: null, createdAt: daysAgo(400), isActive: true }, NOW)).toBe(
      "never_used",
    );
  });

  it("reports an already-disabled account as deactivated, whatever its timestamps say", () => {
    expect(classifyAccount({ lastActiveAt: daysAgo(1), isActive: false }, NOW)).toBe("deactivated");
    expect(classifyAccount({ lastActiveAt: null, isActive: false }, NOW)).toBe("deactivated");
  });

  it("treats an absent isActive flag as active, matching canAuthenticate", () => {
    // The column is NOT NULL default true. If this disagreed with
    // canAuthenticate(), the review list and the auth gate would describe
    // different systems.
    expect(classifyAccount({ lastActiveAt: daysAgo(1) }, NOW)).toBe("active");
    expect(classifyAccount({ lastActiveAt: daysAgo(1), isActive: null }, NOW)).toBe("active");
  });

  it("accepts ISO strings as well as Dates", () => {
    expect(
      classifyAccount({ lastActiveAt: daysAgo(400).toISOString(), isActive: true }, NOW),
    ).toBe("dormant");
  });

  it("does not treat a future timestamp as idle", () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(classifyAccount({ lastActiveAt: future, isActive: true }, NOW)).toBe("active");
    expect(daysSince(future, NOW)).toBe(0);
  });
});

describe("idleSince / idleDays", () => {
  it("measures from lastActiveAt when there is one", () => {
    const last = daysAgo(10);
    expect(idleSince({ lastActiveAt: last, createdAt: daysAgo(400) })).toEqual(last);
    expect(idleDays({ lastActiveAt: last, createdAt: daysAgo(400) }, NOW)).toBe(10);
  });

  it("falls back to createdAt for an account that was never used", () => {
    // Otherwise a never-used account is unmeasurable and therefore
    // permanently unreviewable — the exact state §2.8 is about.
    expect(idleDays({ lastActiveAt: null, createdAt: daysAgo(365) }, NOW)).toBe(365);
  });

  it("returns null when there is nothing to measure from", () => {
    expect(idleSince({})).toBeNull();
    expect(idleDays({}, NOW)).toBeNull();
  });
});

describe("autoDeactivateAfterDays", () => {
  it("is OFF when the env var is unset", () => {
    delete process.env[AUTO_DEACTIVATE_ENV_VAR];
    expect(autoDeactivateAfterDays()).toBeNull();
  });

  it("is OFF for an empty or blank value", () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "";
    expect(autoDeactivateAfterDays()).toBeNull();
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "   ";
    expect(autoDeactivateAfterDays()).toBeNull();
  });

  it("is OFF for a value that is not a positive number", () => {
    // A typo must not disable every account in the system.
    for (const bad of ["yes", "0", "-30", "NaN"]) {
      process.env[AUTO_DEACTIVATE_ENV_VAR] = bad;
      expect(autoDeactivateAfterDays()).toBeNull();
    }
  });

  it("reads a threshold in days when set", () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "180";
    expect(autoDeactivateAfterDays()).toBe(180);
  });

  it("is read at call time, not cached at import", () => {
    delete process.env[AUTO_DEACTIVATE_ENV_VAR];
    expect(autoDeactivateAfterDays()).toBeNull();
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "365";
    expect(autoDeactivateAfterDays()).toBe(365);
  });
});

describe("shouldAutoDeactivate", () => {
  const ancient = { lastActiveAt: daysAgo(999), createdAt: daysAgo(1200), isActive: true };

  it("never fires with the switch unset — however dormant the account is", () => {
    delete process.env[AUTO_DEACTIVATE_ENV_VAR];
    expect(shouldAutoDeactivate(ancient, NOW)).toBe(false);
    expect(shouldAutoDeactivate({ lastActiveAt: null, createdAt: daysAgo(999) }, NOW)).toBe(false);
  });

  it("fires past the configured threshold once the switch is on", () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "180";
    expect(shouldAutoDeactivate(ancient, NOW)).toBe(true);
  });

  it("respects the threshold boundary", () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "180";
    expect(shouldAutoDeactivate({ lastActiveAt: daysAgo(179), isActive: true }, NOW)).toBe(false);
    expect(shouldAutoDeactivate({ lastActiveAt: daysAgo(180), isActive: true }, NOW)).toBe(true);
  });

  it("uses its OWN threshold, independent of the review threshold", () => {
    // A deployment may want to LIST at 90 days and disable only at a year.
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "365";
    const dormantButNotYetDisabled = { lastActiveAt: daysAgo(120), isActive: true };
    expect(classifyAccount(dormantButNotYetDisabled, NOW)).toBe("dormant");
    expect(shouldAutoDeactivate(dormantButNotYetDisabled, NOW)).toBe(false);
  });

  it("catches a never-used account via createdAt", () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "180";
    expect(
      shouldAutoDeactivate({ lastActiveAt: null, createdAt: daysAgo(400), isActive: true }, NOW),
    ).toBe(true);
  });

  it("does not re-disable an account that is already off", () => {
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "180";
    expect(shouldAutoDeactivate({ ...ancient, isActive: false }, NOW)).toBe(false);
  });

  it("does not revoke on missing evidence", () => {
    // No lastActiveAt AND no createdAt: we cannot say the account is idle, so
    // we do not act on it.
    process.env[AUTO_DEACTIVATE_ENV_VAR] = "1";
    expect(shouldAutoDeactivate({ isActive: true }, NOW)).toBe(false);
  });
});
