// Public surface of the legal-adapter layer. See planning-docs/student-consent-onboarding-plan.md.

export * from "./types.js";
export {
  resolveMinorProtection,
  computeAgeYears,
  getRegimeThreshold,
  REGIME_THRESHOLDS,
} from "./minor-protection.js";
export {
  DEFAULT_AGE_OF_MAJORITY,
  AGE_OF_MAJORITY,
  getAgeOfMajority,
} from "./age-of-majority.js";
export { resolveConsentAuthority } from "./consent-authority.js";
export type { ConsentAuthorityResult } from "./consent-authority.js";
export {
  getIdvMethodSpec,
  isKnownIdvMethod,
  resolveIdvRegimeContext,
  checkIdvAcceptability,
  listAcceptableMethodsForRegime,
} from "./idv-methods.js";
export type { IdvAcceptabilityResult } from "./idv-methods.js";
export {
  lookupConsentNotice,
  listLocalesForCountryVersion,
  renderNoticeForHashing,
} from "./consent-notices/index.js";
export {
  DEFAULT_RECIPIENTS,
  getDefaultRecipients,
} from "./recipients.js";
