/**
 * Pure-logic tests for the regime registry. The registry is the single
 * source of truth for compliance regimes; helpers normalize/resolve
 * across an institute's declared regimes.
 */

import { describe, it, expect } from "@jest/globals";
import {
  KNOWN_REGIMES,
  getRegimeBundle,
  normalizeRegimes,
  hasRegime,
  hasCountry,
  resolveAccessibilityStandard,
  resolveAuditRetentionDays,
  resolveBreachNotificationHours,
} from "../../shared/regime/regimes.js";
import {
  resolvePermissions,
  DEFAULT_LICENSE_PERMISSIONS,
} from "../../shared/license-permissions.js";

describe("regime registry", () => {
  it("includes the il_moe regime", () => {
    const b = getRegimeBundle("il_moe");
    expect(b).not.toBeNull();
    expect(b!.country).toBe("IL");
    expect(b!.identityProviderHint).toBe("il_moe");
    expect(b!.requiresInCountryResidency).toBe(true);
  });

  it("returns null for unknown slugs", () => {
    expect(getRegimeBundle("zz_made_up")).toBeNull();
  });

  it("KNOWN_REGIMES enumerates all bundles", () => {
    for (const slug of KNOWN_REGIMES) {
      expect(getRegimeBundle(slug)).not.toBeNull();
    }
    expect(KNOWN_REGIMES.length).toBeGreaterThanOrEqual(8);
  });

  describe("normalizeRegimes", () => {
    it("filters out unknown slugs", () => {
      const out = normalizeRegimes(["il_moe", "zz_bogus", "us_hipaa"]);
      expect(out).toEqual(["il_moe", "us_hipaa"]);
    });

    it("dedupes", () => {
      const out = normalizeRegimes(["il_moe", "il_moe", "us_hipaa"]);
      expect(out).toEqual(["il_moe", "us_hipaa"]);
    });

    it("returns empty array for null/undefined/empty", () => {
      expect(normalizeRegimes(null)).toEqual([]);
      expect(normalizeRegimes(undefined)).toEqual([]);
      expect(normalizeRegimes([])).toEqual([]);
    });
  });

  describe("hasRegime / hasCountry", () => {
    it("hasRegime is exact match", () => {
      expect(hasRegime(["il_moe"], "il_moe")).toBe(true);
      expect(hasRegime(["il_moe"], "us_ferpa")).toBe(false);
      expect(hasRegime(null, "il_moe")).toBe(false);
    });

    it("hasCountry matches any regime in that country", () => {
      expect(hasCountry(["il_moe"], "IL")).toBe(true);
      expect(hasCountry(["us_ferpa", "us_hipaa"], "US")).toBe(true);
      expect(hasCountry(["us_ferpa"], "IL")).toBe(false);
    });
  });

  describe("resolvers across multiple regimes", () => {
    it("resolveAuditRetentionDays takes the strictest (longest)", () => {
      // il_moe = 7y, us_coppa = 1y → expect 7y
      expect(resolveAuditRetentionDays(["il_moe", "us_coppa"])).toBe(7 * 365);
    });

    it("resolveBreachNotificationHours takes the strictest (shortest)", () => {
      // il_moe = 30d, eu_gdpr = 72h → expect 72h
      expect(resolveBreachNotificationHours(["il_moe", "eu_gdpr"])).toBe(72);
    });

    it("resolveAccessibilityStandard prefers WCAG 2.1+ over Section 508", () => {
      // il_5568 (3) > us_section_508 (1) → expect il_5568
      const out = resolveAccessibilityStandard(["us_section_508", "il_moe"]);
      expect(out).toBe("il_5568");
    });

    it("returns sensible defaults on empty input", () => {
      expect(resolveAuditRetentionDays([])).toBe(0);
      expect(resolveBreachNotificationHours([])).toBeNull();
      expect(resolveAccessibilityStandard([])).toBe("wcag_2_1_aa");
    });
  });
});

describe("license permissions x regimes", () => {
  it("DEFAULT permissions include an empty regimes array", () => {
    expect(DEFAULT_LICENSE_PERMISSIONS.complianceRegimes).toEqual([]);
  });

  it("resolvePermissions(null) returns empty regimes", () => {
    expect(resolvePermissions(null).complianceRegimes).toEqual([]);
  });

  it("resolvePermissions preserves regimes when permissions are partial", () => {
    const out = resolvePermissions({
      maxStudents: 5,
      aacEnabled: true,
      boardMakerEnabled: true,
      customAppsEnabled: false,
      unrestrictedAI: false,
      calendar: false,
      dashboardLevel: 1,
      expertAgentsCount: 0,
      deepAnalysisEnabled: false,
      complianceRegimes: ["il_moe"],
    });
    expect(out.complianceRegimes).toEqual(["il_moe"]);
  });

  it("resolvePermissions(all: true) preserves declared regimes", () => {
    // Regimes are constraints, not capabilities — `all: true` shouldn't drop them.
    const out = resolvePermissions({
      all: true,
      complianceRegimes: ["il_moe", "us_hipaa"],
    } as any);
    expect(out.complianceRegimes).toEqual(["il_moe", "us_hipaa"]);
    // ...and still grants max capabilities.
    expect(out.maxStudents).toBe(-1);
  });
});
