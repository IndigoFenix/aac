/**
 * Pure-logic tests for the consent-authority resolver and age-of-majority map.
 * These decide WHO may consent for a student (guardian vs. self) — distinct
 * from the minor-PROTECTION thresholds in minor-protection.ts.
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolveConsentAuthority,
  getAgeOfMajority,
  DEFAULT_AGE_OF_MAJORITY,
} from "../../shared/legal/index.js";

describe("getAgeOfMajority", () => {
  it("returns 18 for IL and US", () => {
    expect(getAgeOfMajority("IL")).toBe(18);
    expect(getAgeOfMajority("us")).toBe(18); // case-insensitive
  });

  it("falls back to the default for unknown countries", () => {
    expect(getAgeOfMajority("ZZ")).toBe(DEFAULT_AGE_OF_MAJORITY);
  });
});

describe("resolveConsentAuthority", () => {
  it("auto: a minor needs a guardian", () => {
    const r = resolveConsentAuthority({ country: "IL", ageYears: 12, authorityMode: "auto" });
    expect(r.signerType).toBe("guardian");
    expect(r.basis).toBe("minor");
    expect(r.source).toBe("age");
  });

  it("auto: an adult self-consents", () => {
    const r = resolveConsentAuthority({ country: "IL", ageYears: 18, authorityMode: "auto" });
    expect(r.signerType).toBe("self");
    expect(r.basis).toBe("self_age");
    expect(r.source).toBe("age");
  });

  it("guardian_required overrides the age default for an adult", () => {
    const r = resolveConsentAuthority({
      country: "IL",
      ageYears: 25,
      authorityMode: "guardian_required",
      guardianshipBasis: "court_appointed_guardian",
    });
    expect(r.signerType).toBe("guardian");
    expect(r.basis).toBe("court_appointed_guardian");
    expect(r.source).toBe("override");
  });

  it("guardian_required without a basis reports 'unspecified'", () => {
    const r = resolveConsentAuthority({ country: "IL", ageYears: 25, authorityMode: "guardian_required" });
    expect(r.signerType).toBe("guardian");
    expect(r.basis).toBe("unspecified");
  });

  it("self override lets a minor self-consent", () => {
    const r = resolveConsentAuthority({ country: "IL", ageYears: 16, authorityMode: "self" });
    expect(r.signerType).toBe("self");
    expect(r.basis).toBe("self_capable_override");
    expect(r.source).toBe("override");
  });

  it("uses the country's age of majority, not the protection threshold (US 18, not 13)", () => {
    // A 15-year-old US student is past the COPPA protection threshold (13) but
    // still below the age of majority (18) — they still need a guardian.
    const r = resolveConsentAuthority({ country: "US", ageYears: 15, authorityMode: "auto" });
    expect(r.signerType).toBe("guardian");
  });
});
