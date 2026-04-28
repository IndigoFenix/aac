// Per-country adapter resolving the minor-protection regime for a
// (country, age) pair. See planning-docs/student-consent-onboarding-plan.md.
//
// Adding support for a new country: add a row to COUNTRY_RULES below.
// Unknown countries fall through to gdpr_superset_default (age < 16, all
// non-essential opt-ins forced off).

import type {
  MinorProtectionRegime,
  MinorProtectionResult,
  OptInType,
} from "./types.js";

interface CountryRule {
  thresholdYears: number;
  regime: MinorProtectionRegime;
  forcedOffOptIns: ReadonlyArray<OptInType>;
}

const ALL_OPT_INS: ReadonlyArray<OptInType> = [
  "model_training",
  "advertising",
  "third_party_research",
  "marketing_comms",
];

// Countries with explicit rules. Defaults apply for everything else.
// EU member states default to 16 under GDPR Article 8(1) unless a member
// state set a lower limit (some did — DE/UK/etc. — but treating 16 as the
// safe upper bound matches the regime label.)
const COUNTRY_RULES: Record<string, CountryRule> = {
  US: {
    thresholdYears: 13,
    regime: "us_coppa",
    forcedOffOptIns: ALL_OPT_INS,
  },
  GB: {
    thresholdYears: 13,
    regime: "uk_ico_under13",
    forcedOffOptIns: ALL_OPT_INS,
  },
  IL: {
    thresholdYears: 18,
    regime: "il_general",
    // Israel doesn't force opt-ins off below 18 — guardianship law gives
    // the parent legal authority to consent on behalf of the minor. UI
    // surfaces an extra warning but the toggles are available.
    forcedOffOptIns: [],
  },
};

const EU_MEMBER_STATES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
]);

const DEFAULT_RULE: CountryRule = {
  thresholdYears: 16,
  regime: "gdpr_superset_default",
  forcedOffOptIns: ALL_OPT_INS,
};

const EU_RULE: CountryRule = {
  thresholdYears: 16, // GDPR Article 8(1) upper bound
  regime: "eu_gdpr_minor",
  forcedOffOptIns: ALL_OPT_INS,
};

function resolveRule(country: string): CountryRule {
  const code = country.toUpperCase();
  if (code in COUNTRY_RULES) return COUNTRY_RULES[code];
  if (EU_MEMBER_STATES.has(code)) return EU_RULE;
  return DEFAULT_RULE;
}

export function resolveMinorProtection(
  country: string,
  ageYears: number,
): MinorProtectionResult {
  const rule = resolveRule(country);
  const isApplicable = ageYears < rule.thresholdYears;
  return {
    isApplicable,
    regime: isApplicable ? rule.regime : null,
    forcedOffOptIns: new Set(isApplicable ? rule.forcedOffOptIns : []),
  };
}

/**
 * Static threshold per regime — used by the daily cron that flags students
 * who have aged out of their protection regime so re-consent can be prompted.
 */
export const REGIME_THRESHOLDS: Record<MinorProtectionRegime, number> = {
  us_coppa: 13,
  uk_ico_under13: 13,
  il_general: 18,
  eu_gdpr_minor: 16,
  gdpr_superset_default: 16,
};

export function getRegimeThreshold(regime: MinorProtectionRegime): number {
  return REGIME_THRESHOLDS[regime];
}

// Year-of-life calculation: avoids time-of-day edge cases and is what every
// regime actually means by "under 13" / "under 18".
export function computeAgeYears(birthDate: Date, asOf: Date = new Date()): number {
  let age = asOf.getFullYear() - birthDate.getFullYear();
  const monthDiff = asOf.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}
