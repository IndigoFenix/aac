/**
 * Pure-logic tests for venue-menu settings — the normalizer chokepoint and the
 * age-derived `'auto'` resolution.
 *
 * See planning-docs/aac-restaurant-menus.md §4.7-4.8 and §7. The cases below
 * are the ones that doc names as required; the guard case in particular is the
 * whole reason `resolveAutoDefaults` consults languageLevel at all, and if it
 * ever regresses the age table has silently taken over.
 *
 * DB-free: belongs in `test:unit`, not `integration/`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  normalizeVenueMenuSettings,
  resolveAutoDefaults,
  resolveVenueMenuSettings,
  ageInYears,
  isSourceEnabled,
  needsReview,
  DEFAULT_VENUE_MENU_SETTINGS,
  MIN_SEARCH_RADIUS_M,
  MAX_SEARCH_RADIUS_M,
  PRICE_MIN_AGE,
  REVIEW_RELAX_AGE,
} from "../../shared/venue-menus.js";

// Fixed clock — injected everywhere, so these tests do not drift.
const NOW = new Date("2026-08-18T12:00:00Z");

/** Birth date for someone exactly `age` years old on NOW. */
function dobForAge(age: number): string {
  return `${NOW.getFullYear() - age}-08-18`;
}

describe("normalizeVenueMenuSettings", () => {
  it("yields the documented defaults for absent input", () => {
    for (const empty of [undefined, null, {}, "", 0, []]) {
      expect(normalizeVenueMenuSettings(empty)).toEqual(DEFAULT_VENUE_MENU_SETTINGS);
    }
  });

  it("is OFF by default — the feature is opt-in", () => {
    expect(normalizeVenueMenuSettings(undefined).enabled).toBe(false);
  });

  it("defaults location to PRECISE, not coarse", () => {
    // Coarsening to a ~100m grid destroys venue disambiguation (§5); privacy
    // rests on the request carrying no identifier, not on blurring. If someone
    // "hardens" this back to coarse, the binding check loses its anchor.
    expect(normalizeVenueMenuSettings(undefined).locationSearch).toBe("precise");
  });

  it("defaults the paid provider and the web source to OFF", () => {
    const s = normalizeVenueMenuSettings(undefined);
    expect(s.providers.brightData).toBe(false);
    expect(s.sources.web).toBe(false);
    expect(s.sources.camera).toBe(true);
  });

  it("does not mutate or alias the shared default object", () => {
    const a = normalizeVenueMenuSettings(undefined);
    a.providers.osm = false;
    a.sources.camera = false;
    expect(DEFAULT_VENUE_MENU_SETTINGS.providers.osm).toBe(true);
    expect(DEFAULT_VENUE_MENU_SETTINGS.sources.camera).toBe(true);
    expect(normalizeVenueMenuSettings(undefined).providers.osm).toBe(true);
  });

  it("drops unknown keys rather than carrying them through", () => {
    const out = normalizeVenueMenuSettings({ enabled: true, legacyMode: "yes", nested: { a: 1 } });
    expect(out.enabled).toBe(true);
    expect(out).not.toHaveProperty("legacyMode");
    expect(out).not.toHaveProperty("nested");
  });

  it("rejects invalid enum values back to the default", () => {
    expect(normalizeVenueMenuSettings({ locationSearch: "gps" }).locationSearch).toBe("precise");
    expect(normalizeVenueMenuSettings({ requireReview: "sometimes" }).requireReview).toBe("auto");
  });

  it("keeps every legal requireReview value, 'auto' included", () => {
    for (const v of ["never", "web_only", "always", "auto"] as const) {
      expect(normalizeVenueMenuSettings({ requireReview: v }).requireReview).toBe(v);
    }
  });

  it("keeps showPrices as boolean or 'auto'", () => {
    expect(normalizeVenueMenuSettings({ showPrices: true }).showPrices).toBe(true);
    expect(normalizeVenueMenuSettings({ showPrices: false }).showPrices).toBe(false);
    expect(normalizeVenueMenuSettings({ showPrices: "auto" }).showPrices).toBe("auto");
    expect(normalizeVenueMenuSettings({ showPrices: "yes" }).showPrices).toBe("auto");
  });

  it("clamps searchRadiusM into range", () => {
    expect(normalizeVenueMenuSettings({ searchRadiusM: 5 }).searchRadiusM).toBe(MIN_SEARCH_RADIUS_M);
    expect(normalizeVenueMenuSettings({ searchRadiusM: 99999 }).searchRadiusM).toBe(MAX_SEARCH_RADIUS_M);
    expect(normalizeVenueMenuSettings({ searchRadiusM: 200 }).searchRadiusM).toBe(200);
    expect(normalizeVenueMenuSettings({ searchRadiusM: "200" }).searchRadiusM).toBe(150);
  });

  it("preserves maxMenuAgeDays: 0 — it means 'never stale', not 'unset'", () => {
    expect(normalizeVenueMenuSettings({ maxMenuAgeDays: 0 }).maxMenuAgeDays).toBe(0);
    expect(normalizeVenueMenuSettings({}).maxMenuAgeDays).toBe(30);
  });

  it("survives a partially-shaped providers/sources object", () => {
    const out = normalizeVenueMenuSettings({ providers: { brightData: true }, sources: { web: true } });
    expect(out.providers).toEqual({ osm: true, brightData: true });
    expect(out.sources).toEqual({ camera: true, web: true, manual: true });
  });
});

describe("normalizeVenueMenuSettings — requireReviewWithAllergies", () => {
  it("defaults ON", () => {
    expect(normalizeVenueMenuSettings({}).requireReviewWithAllergies).toBe(true);
  });

  it("can be switched off explicitly", () => {
    expect(
      normalizeVenueMenuSettings({ requireReviewWithAllergies: false }).requireReviewWithAllergies,
    ).toBe(false);
  });

  it("ignores a non-boolean rather than treating it as off", () => {
    expect(
      normalizeVenueMenuSettings({ requireReviewWithAllergies: "no" }).requireReviewWithAllergies,
    ).toBe(true);
  });
});

describe("ageInYears", () => {
  it("returns null for a missing or unparseable birth date", () => {
    expect(ageInYears(null, NOW)).toBeNull();
    expect(ageInYears(undefined, NOW)).toBeNull();
    expect(ageInYears("", NOW)).toBeNull();
    expect(ageInYears("not-a-date", NOW)).toBeNull();
  });

  it("counts whole calendar years", () => {
    expect(ageInYears("2016-08-18", NOW)).toBe(10);
    expect(ageInYears(new Date("2016-08-18"), NOW)).toBe(10);
  });

  it("does not credit a birthday that has not landed yet", () => {
    expect(ageInYears("2016-08-19", NOW)).toBe(9); // tomorrow
    expect(ageInYears("2016-08-18", NOW)).toBe(10); // today
    expect(ageInYears("2016-12-31", NOW)).toBe(9); // later this year
  });
});

describe("resolveAutoDefaults", () => {
  // Level 4 (full_sentences) is the DB default and clears the repair guard,
  // so it isolates the age axis.
  const CAN_REPAIR = 4;

  describe("showPrices — the age axis", () => {
    it(`is false the day before turning ${PRICE_MIN_AGE}`, () => {
      const dayBefore = `${NOW.getFullYear() - PRICE_MIN_AGE}-08-19`;
      expect(resolveAutoDefaults(dayBefore, CAN_REPAIR, NOW).showPrices).toBe(false);
    });

    it(`is true on the ${PRICE_MIN_AGE}th birthday`, () => {
      expect(resolveAutoDefaults(dobForAge(PRICE_MIN_AGE), CAN_REPAIR, NOW).showPrices).toBe(true);
    });

    it("is true for an older student", () => {
      expect(resolveAutoDefaults(dobForAge(15), CAN_REPAIR, NOW).showPrices).toBe(true);
    });
  });

  describe("requireReview — the age axis", () => {
    it(`is 'always' the day before turning ${REVIEW_RELAX_AGE}`, () => {
      const dayBefore = `${NOW.getFullYear() - REVIEW_RELAX_AGE}-08-19`;
      expect(resolveAutoDefaults(dayBefore, CAN_REPAIR, NOW).requireReview).toBe("always");
    });

    it(`relaxes to 'web_only' on the ${REVIEW_RELAX_AGE}th birthday`, () => {
      expect(resolveAutoDefaults(dobForAge(REVIEW_RELAX_AGE), CAN_REPAIR, NOW).requireReview).toBe("web_only");
    });

    it("never auto-resolves to 'never', at any age", () => {
      for (const age of [0, 8, 12, 18, 40]) {
        expect(resolveAutoDefaults(dobForAge(age), CAN_REPAIR, NOW).requireReview).not.toBe("never");
      }
    });
  });

  describe("missing data fails cautious", () => {
    it("treats a null birth date as 'always' with no prices", () => {
      // students.birthDate is nullable — this is a real case, not an error.
      // Unknown age must never be treated as adult.
      const out = resolveAutoDefaults(null, CAN_REPAIR, NOW);
      expect(out.requireReview).toBe("always");
      expect(out.showPrices).toBe(false);
    });
  });

  describe("the languageLevel guard", () => {
    // THE case the guard exists for. Age alone would hand this student
    // 'web_only'; they cannot say "that's not on the menu", so they get
    // 'always'. If this ever goes green->red, the age table has taken over.
    it("keeps 'always' for a 17-year-old at single_words", () => {
      expect(resolveAutoDefaults(dobForAge(17), 1, NOW).requireReview).toBe("always");
    });

    it("keeps 'always' for a 17-year-old at short_phrases", () => {
      expect(resolveAutoDefaults(dobForAge(17), 2, NOW).requireReview).toBe("always");
    });

    it("lets the age table stand from simple_sentences up", () => {
      for (const level of [3, 4, 5]) {
        expect(resolveAutoDefaults(dobForAge(17), level, NOW).requireReview).toBe("web_only");
      }
    });

    it("accepts a LanguageLevel string as readily as its integer", () => {
      expect(resolveAutoDefaults(dobForAge(17), "single_words", NOW).requireReview).toBe("always");
      expect(resolveAutoDefaults(dobForAge(17), "full_sentences", NOW).requireReview).toBe("web_only");
    });

    it("falls back to the default tier for a null languageLevel", () => {
      // languageLevelFromInt(null) is full_sentences, so the guard does not
      // fire and age decides — matching every other consumer of the column.
      expect(resolveAutoDefaults(dobForAge(17), null, NOW).requireReview).toBe("web_only");
    });

    it("does not let the guard touch prices", () => {
      // Prices are display-only, not a safety control — age alone decides.
      expect(resolveAutoDefaults(dobForAge(15), 1, NOW).showPrices).toBe(true);
    });
  });
});

describe("resolveVenueMenuSettings", () => {
  it("resolves 'auto' against the student", () => {
    const out = resolveVenueMenuSettings({ enabled: true }, { birthDate: dobForAge(15), languageLevel: 4 }, NOW);
    expect(out.requireReview).toBe("web_only");
    expect(out.showPrices).toBe(true);
  });

  it("lets an explicit clinician choice override the age default", () => {
    const out = resolveVenueMenuSettings(
      { enabled: true, requireReview: "never", showPrices: false },
      { birthDate: dobForAge(15), languageLevel: 4 },
      NOW,
    );
    expect(out.requireReview).toBe("never");
    expect(out.showPrices).toBe(false);
  });

  it("fails cautious when there is no student record at all", () => {
    const out = resolveVenueMenuSettings({ enabled: true }, null, NOW);
    expect(out.requireReview).toBe("always");
    expect(out.showPrices).toBe(false);
  });
});

describe("isSourceEnabled", () => {
  it("lets the master switch outrank the per-source toggle", () => {
    const s = normalizeVenueMenuSettings({ enabled: false, sources: { camera: true } });
    expect(isSourceEnabled(s, "camera")).toBe(false);
  });

  it("honours the per-source toggle once enabled", () => {
    const s = normalizeVenueMenuSettings({ enabled: true, sources: { camera: true, web: false } });
    expect(isSourceEnabled(s, "camera")).toBe(true);
    expect(isSourceEnabled(s, "web")).toBe(false);
  });
});

describe("needsReview — allergies outrank the policy", () => {
  // Per-student decisions live in AAC settings, so this is a SETTING
  // (`requireReviewWithAllergies`, default true) rather than hardcoded logic.
  const withAllergies = { hasAllergies: true, requireReviewWithAllergies: true };

  it("forces review for an allergic student even under 'never'", () => {
    // The allergen filter reads whatever text the source carried, and on a menu
    // of bare names its silence means very little. A human looks.
    expect(needsReview("never", "camera", withAllergies)).toBe(true);
    expect(needsReview("web_only", "camera", withAllergies)).toBe(true);
  });

  it("does nothing when the student has no recorded allergies", () => {
    expect(needsReview("never", "camera", { ...withAllergies, hasAllergies: false })).toBe(false);
  });

  it("respects a clinician who switched the setting off", () => {
    expect(
      needsReview("never", "camera", { hasAllergies: true, requireReviewWithAllergies: false }),
    ).toBe(false);
  });

  it("defaults to the plain policy when no context is passed at all", () => {
    expect(needsReview("never", "camera")).toBe(false);
  });
});

describe("needsReview", () => {
  it("gates everything under 'always'", () => {
    for (const p of ["camera", "web", "manual"] as const) {
      expect(needsReview("always", p)).toBe(true);
    }
  });

  it("gates nothing under 'never'", () => {
    for (const p of ["camera", "web", "manual"] as const) {
      expect(needsReview("never", p)).toBe(false);
    }
  });

  it("gates only web under 'web_only'", () => {
    // Camera is exempt because it cannot suffer the wrong-restaurant defect —
    // the menu was physically in front of the student.
    expect(needsReview("web_only", "web")).toBe(true);
    expect(needsReview("web_only", "camera")).toBe(false);
    expect(needsReview("web_only", "manual")).toBe(false);
  });
});
