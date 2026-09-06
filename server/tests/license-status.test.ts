/**
 * computeLicenseStatus — the expiry rules, DB-free.
 *
 * The table below is the whole contract between the server's permission
 * resolution and the client's paywall. The two rows that matter most are the
 * NULL ones: every license granted before billing existed has a null expiry,
 * and reading either of them as "expired" would lock out every existing
 * customer on the deploy that shipped enforcement.
 */

import { describe, it, expect } from "@jest/globals";
import {
  computeLicenseStatus,
  licenseExpiryDate,
  licenseStatusRank,
  licenseStatusGrantsAccess,
  PAID_GRACE_DAYS,
  type LicenseStatus,
  type LicenseStatusInput,
} from "@shared/license-status";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY);

const cases: [string, LicenseStatusInput, LicenseStatus][] = [
  [
    "perpetual paid (no expiry) — every admin-granted license looks like this",
    { isActive: true, isTrial: false, subscriptionExpiresAt: null },
    "active",
  ],
  [
    "trial with no end date keeps working",
    { isActive: true, isTrial: true, trialExpiresAt: null },
    "trial",
  ],
  [
    "trial still running",
    { isActive: true, isTrial: true, trialExpiresAt: daysFromNow(5) },
    "trial",
  ],
  [
    "trial ended yesterday — no grace for a trial",
    { isActive: true, isTrial: true, trialExpiresAt: daysFromNow(-1) },
    "expired",
  ],
  [
    "paid, period still running",
    { isActive: true, isTrial: false, subscriptionExpiresAt: daysFromNow(20) },
    "active",
  ],
  [
    "paid, just inside the grace window",
    {
      isActive: true,
      isTrial: false,
      subscriptionExpiresAt: daysFromNow(-PAID_GRACE_DAYS + 0.5),
    },
    "active",
  ],
  [
    "paid, past the grace window",
    {
      isActive: true,
      isTrial: false,
      subscriptionExpiresAt: daysFromNow(-PAID_GRACE_DAYS - 0.5),
    },
    "expired",
  ],
  [
    "switched off by an operator is 'none', not 'expired' — not buyable back",
    { isActive: false, isTrial: false, subscriptionExpiresAt: daysFromNow(20) },
    "none",
  ],
  [
    "switched off mid-trial is also 'none'",
    { isActive: false, isTrial: true, trialExpiresAt: daysFromNow(5) },
    "none",
  ],
];

describe("computeLicenseStatus", () => {
  for (const [name, license, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(computeLicenseStatus(license, NOW)).toBe(expected);
    });
  }

  it("treats a missing license as 'none'", () => {
    expect(computeLicenseStatus(null, NOW)).toBe("none");
    expect(computeLicenseStatus(undefined, NOW)).toBe("none");
  });

  it("accepts ISO strings as well as Dates (the clients send JSON)", () => {
    expect(
      computeLicenseStatus(
        { isActive: true, isTrial: true, trialExpiresAt: daysFromNow(3).toISOString() },
        NOW,
      ),
    ).toBe("trial");
  });

  it("ignores an unparseable date rather than expiring on it", () => {
    expect(
      computeLicenseStatus(
        { isActive: true, isTrial: false, subscriptionExpiresAt: "not a date" },
        NOW,
      ),
    ).toBe("active");
  });
});

describe("licenseExpiryDate", () => {
  it("reads the trial date for a trial and the subscription date otherwise", () => {
    const trialEnd = daysFromNow(2);
    const subEnd = daysFromNow(40);
    expect(
      licenseExpiryDate({ isTrial: true, trialExpiresAt: trialEnd, subscriptionExpiresAt: subEnd }),
    ).toEqual(trialEnd);
    expect(
      licenseExpiryDate({ isTrial: false, trialExpiresAt: trialEnd, subscriptionExpiresAt: subEnd }),
    ).toEqual(subEnd);
  });
});

describe("status ordering", () => {
  it("prefers a live license over an expired one, and an expired one over nothing", () => {
    expect(licenseStatusRank("active")).toBeGreaterThan(licenseStatusRank("trial"));
    expect(licenseStatusRank("trial")).toBeGreaterThan(licenseStatusRank("expired"));
    expect(licenseStatusRank("expired")).toBeGreaterThan(licenseStatusRank("none"));
  });

  it("only active and trial grant access", () => {
    expect(licenseStatusGrantsAccess("active")).toBe(true);
    expect(licenseStatusGrantsAccess("trial")).toBe(true);
    expect(licenseStatusGrantsAccess("expired")).toBe(false);
    expect(licenseStatusGrantsAccess("none")).toBe(false);
  });
});
