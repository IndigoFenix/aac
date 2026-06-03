// Shared types for the consent / minor-protection / IDV adapter layer.
// See planning-docs/student-consent-onboarding-plan.md.

export type MinorProtectionRegime =
  | "us_coppa"
  | "eu_gdpr_minor"
  | "uk_ico_under13"
  | "il_general"
  | "gdpr_superset_default";

export type OptInType =
  | "model_training"
  | "advertising"
  | "third_party_research"
  | "marketing_comms";

export interface MinorProtectionResult {
  isApplicable: boolean;
  regime: MinorProtectionRegime | null;
  forcedOffOptIns: ReadonlySet<OptInType>;
}

// Per-student consent-authority override (stored as text on students). Decides
// whether a guardian or the student signs, overriding the age-of-majority
// default. See consent-authority.ts.
export type ConsentAuthorityMode = "auto" | "guardian_required" | "self";

// Resolved party that must sign consent (stored as text on consent records).
export type ConsentSignerType = "guardian" | "self";

// Legal instrument under which a guardian acts for someone at/above the age of
// majority. Required when authorityMode === "guardian_required" for an adult.
export type GuardianshipBasis =
  | "minor"
  | "court_appointed_guardian"
  | "limited_guardian"
  | "supported_decision_making"
  | "power_of_attorney";

// Identity-verification + non-repudiation method identifiers. Stored as
// text on consent records — adding a method = data, not migration.
export type IdvMethod =
  | "authenticated_session"
  | "gov_sso"
  | "third_party_idv"
  | "in_person_clinician_attested"
  | "video_session_recorded"
  | "verified_phone_otp"
  | "signed_form_upload"
  | "credit_card_match";

// Regime-context categories used to gate which IDV methods are acceptable.
export type IdvRegimeContext =
  // IL Privacy Protection Authority (Feb-2026 position paper) — sensitive
  // medical data requires identity verification + non-repudiation.
  | "il_sensitive"
  // US COPPA verifiable parental consent (16 CFR §312.5).
  | "us_coppa"
  // EU GDPR Article 9 (special-category personal data).
  | "eu_gdpr_art9"
  // Non-sensitive consent in any jurisdiction.
  | "standard";

export interface IdvMethodSpec {
  id: IdvMethod;
  acceptedFor: ReadonlySet<IdvRegimeContext>;
  // Whether this method, on its own, provides BOTH legs (identity +
  // non-repudiation). When false, callers must pair it with another method.
  providesBothLegs: boolean;
}

// Consent-notice content. The wording is per-country; the structural slots
// are universal (purpose, voluntariness, recipients, retention, rights).
export interface ConsentNoticeContent {
  title: string;
  purposeStatement: string;
  voluntarinessStatement: string;
  thirdPartyTransfersStatement: string;
  retentionStatement: string;
  rightsStatement: string;
}

export interface ConsentNoticeVariant {
  country: string;       // ISO 3166-1 alpha-2 (uppercase)
  locale: string;        // e.g. "en", "he"
  version: string;       // e.g. "IL.2026.04"
  content: ConsentNoticeContent;
}

// Recipients are computed at sign time (depends on which providers are
// actually configured) and stamped onto the consent record. The notice
// template references "the recipients listed below".
export interface ConsentRecipientCategory {
  category:
    | "cloud_hosting"
    | "llm_provider"
    | "tts_provider"
    | "auth_provider"
    | "billing_provider"
    | "sub_processor";
  name: string;     // e.g. "AWS (us-east-1)", "Google Gemini Live"
  purpose: string;  // human-readable
}
