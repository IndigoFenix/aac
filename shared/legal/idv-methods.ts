// Identity-verification + non-repudiation method registry.
// See planning-docs/student-consent-onboarding-plan.md.
//
// Each method declares which legal regime contexts accept it as supplying
// the IDV leg of consent. Some methods supply BOTH legs alone (e.g. gov_sso);
// others must be paired (e.g. third_party_idv supplies identity but needs an
// authenticated session for non-repudiation).
//
// Adding a method: append a spec below + use the new id at the call site.
// No schema migration required — consent records store method as text.

import type {
  IdvMethod,
  IdvMethodSpec,
  IdvRegimeContext,
  MinorProtectionRegime,
} from "./types.js";

const METHOD_SPECS: ReadonlyArray<IdvMethodSpec> = [
  {
    id: "authenticated_session",
    // Acceptable on its own only when identity was previously verified
    // (e.g. the user signed an earlier consent record with stronger IDV).
    // Treated as "standard"-tier on its own; for sensitive contexts the
    // caller should pair it with another method.
    acceptedFor: new Set(["standard"]),
    providesBothLegs: true,
  },
  {
    id: "gov_sso",
    acceptedFor: new Set(["il_sensitive", "us_coppa", "eu_gdpr_art9", "standard"]),
    providesBothLegs: true,
  },
  {
    id: "third_party_idv",
    // Identity verified by an external IDV vendor (IDnow, Stripe Identity,
    // Onfido). Pair with authenticated_session for non-repudiation.
    acceptedFor: new Set(["il_sensitive", "us_coppa", "eu_gdpr_art9", "standard"]),
    providesBothLegs: false,
  },
  {
    id: "in_person_clinician_attested",
    acceptedFor: new Set(["il_sensitive", "eu_gdpr_art9", "standard"]),
    providesBothLegs: true,
  },
  {
    id: "video_session_recorded",
    acceptedFor: new Set(["il_sensitive", "us_coppa", "eu_gdpr_art9", "standard"]),
    providesBothLegs: true,
  },
  {
    id: "verified_phone_otp",
    // Two-channel binding (link click + OTP on out-of-band-verified phone).
    // NOT acceptable for COPPA — VPC enumerated methods don't include OTP.
    acceptedFor: new Set(["il_sensitive", "standard"]),
    providesBothLegs: true,
  },
  {
    id: "signed_form_upload",
    acceptedFor: new Set(["il_sensitive", "us_coppa", "eu_gdpr_art9", "standard"]),
    providesBothLegs: true,
  },
  {
    id: "credit_card_match",
    // COPPA-specific verifiable parental consent path (16 CFR §312.5(b)(2)).
    // Not used for general consent.
    acceptedFor: new Set(["us_coppa"]),
    providesBothLegs: true,
  },
];

const SPECS_BY_ID: ReadonlyMap<IdvMethod, IdvMethodSpec> = new Map(
  METHOD_SPECS.map((s) => [s.id, s]),
);

export function getIdvMethodSpec(method: string): IdvMethodSpec | undefined {
  return SPECS_BY_ID.get(method as IdvMethod);
}

export function isKnownIdvMethod(method: string): method is IdvMethod {
  return SPECS_BY_ID.has(method as IdvMethod);
}

/**
 * Resolve which regime context applies to a consent transaction. Sensitivity
 * matters because IL/EU sensitive data has stricter IDV requirements than
 * standard processing.
 */
export function resolveIdvRegimeContext(args: {
  country: string;
  minorRegime: MinorProtectionRegime | null;
  isSensitive: boolean;
}): IdvRegimeContext {
  if (args.minorRegime === "us_coppa") return "us_coppa";
  if (args.isSensitive) {
    if (args.country.toUpperCase() === "IL") return "il_sensitive";
    return "eu_gdpr_art9";
  }
  return "standard";
}

export interface IdvAcceptabilityResult {
  acceptable: boolean;
  reason?:
    | "unknown_identity_method"
    | "unknown_non_repudiation_method"
    | "identity_method_not_accepted_for_regime"
    | "non_repudiation_method_not_accepted_for_regime"
    | "identity_method_lacks_non_repudiation_pairing";
}

/**
 * Validate that an (identity, non-repudiation) method pair is legally
 * acceptable in the given regime context. The consent-write service calls
 * this before persisting a record.
 */
export function checkIdvAcceptability(args: {
  identityMethod: string;
  nonRepudiationMethod: string;
  regime: IdvRegimeContext;
}): IdvAcceptabilityResult {
  const id = SPECS_BY_ID.get(args.identityMethod as IdvMethod);
  if (!id) return { acceptable: false, reason: "unknown_identity_method" };

  const nr = SPECS_BY_ID.get(args.nonRepudiationMethod as IdvMethod);
  if (!nr) return { acceptable: false, reason: "unknown_non_repudiation_method" };

  if (!id.acceptedFor.has(args.regime)) {
    return { acceptable: false, reason: "identity_method_not_accepted_for_regime" };
  }

  // Non-repudiation method must either be the same as identity (when that
  // method already provides both legs) or be a valid second leg.
  if (args.identityMethod !== args.nonRepudiationMethod) {
    if (!id.providesBothLegs) {
      // Caller is pairing — fine, just verify NR method is accepted too.
      if (!nr.acceptedFor.has(args.regime) && nr.id !== "authenticated_session") {
        return {
          acceptable: false,
          reason: "non_repudiation_method_not_accepted_for_regime",
        };
      }
    }
  } else {
    // Same method on both legs — must be one that provides both alone.
    if (!id.providesBothLegs) {
      return {
        acceptable: false,
        reason: "identity_method_lacks_non_repudiation_pairing",
      };
    }
  }

  return { acceptable: true };
}

export function listAcceptableMethodsForRegime(
  regime: IdvRegimeContext,
): ReadonlyArray<IdvMethod> {
  return METHOD_SPECS
    .filter((s) => s.acceptedFor.has(regime))
    .map((s) => s.id);
}
