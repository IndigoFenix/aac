// Resolves WHO is the legitimate consenting party for a student — the student
// themselves or a guardian. See planning-docs/student-consent-onboarding-plan.md.
//
// The default rule is age-based (getAgeOfMajority): below majority a guardian
// must sign, at/above it the student self-consents. A per-student override
// covers the two exceptions:
//   - guardian_required: an adult who remains under legal guardianship (the
//     norm for much of the Rett's population). Under IL Legal Capacity &
//     Guardianship Law (1962, as amended 2016) adult capacity is *presumed*,
//     so this must be a deliberate, documented determination — never assumed.
//   - self: a minor who may self-consent (e.g. emancipated). Rare.

import { getAgeOfMajority } from "./age-of-majority.js";
import type {
  ConsentAuthorityMode,
  ConsentSignerType,
  GuardianshipBasis,
} from "./types.js";

export interface ConsentAuthorityResult {
  signerType: ConsentSignerType;
  // Why this signer is legitimate. Frozen onto the consent record at signing.
  // For guardians: the guardianshipBasis (or "unspecified"). For self:
  // "self_age" (reached majority) or "self_capable_override".
  basis: string;
  // Whether the result came from the explicit override or the age default.
  source: "override" | "age";
}

export function resolveConsentAuthority(args: {
  country: string;
  ageYears: number;
  authorityMode: ConsentAuthorityMode;
  guardianshipBasis?: GuardianshipBasis | null;
}): ConsentAuthorityResult {
  switch (args.authorityMode) {
    case "guardian_required":
      return {
        signerType: "guardian",
        basis: args.guardianshipBasis ?? "unspecified",
        source: "override",
      };
    case "self":
      return { signerType: "self", basis: "self_capable_override", source: "override" };
    case "auto":
    default: {
      const isAdult = args.ageYears >= getAgeOfMajority(args.country);
      return isAdult
        ? { signerType: "self", basis: "self_age", source: "age" }
        : { signerType: "guardian", basis: "minor", source: "age" };
    }
  }
}
