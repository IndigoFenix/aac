// Per-country age of majority — the age at which a person is presumed legally
// capable of consenting for themselves. See planning-docs/student-consent-onboarding-plan.md.
//
// IMPORTANT: this is NOT the same as REGIME_THRESHOLDS in minor-protection.ts.
// Those thresholds (US 13 / EU 16 / IL 18) decide whether *enhanced minor
// protections* apply (forced-off opt-ins, stricter IDV). The age of majority
// decides *who may consent* — below it a guardian must sign, at/above it the
// person can self-consent (absent a guardianship override). The two coincide
// for IL (18) but diverge elsewhere (US: protection 13, majority 18).
//
// Adding/refining a country: add a row to AGE_OF_MAJORITY. Unknown countries
// fall through to DEFAULT_AGE_OF_MAJORITY.

export const DEFAULT_AGE_OF_MAJORITY = 18;

export const AGE_OF_MAJORITY: Record<string, number> = {
  IL: 18,
  US: 18,
};

export function getAgeOfMajority(country: string): number {
  return AGE_OF_MAJORITY[country.toUpperCase()] ?? DEFAULT_AGE_OF_MAJORITY;
}
