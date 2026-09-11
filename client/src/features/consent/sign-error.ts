// client/src/features/consent/sign-error.ts
//
// Turn a failed consent request into ONE translated sentence.
//
// Seen live (school account, 2026-09-11): a clinician attested consent for a
// student who, by age, consents for themselves. The wizard had no guardian
// step to show, sent an empty government-ID number anyway, and the server's
// schema refused it. The toast then showed the server's raw English
// "Invalid input" — and the person reading it was told only that
// `["guardianFields","governmentIdNumber"]` was wrong, in a window that had
// no such field.
//
// Every consent endpoint answers a failure with `{ code, message, issues? }`.
// The `code` is the stable, translatable part (consentController's three
// error maps); `message` is English prose for logs; `issues` are zod paths.
// This module reads the first two structured things and never the prose.
//
// Pure and dependency-free: `t` is injected, so `npm run test:client-app`
// can pin the mapping without a DOM.

/** The shape the consent hooks attach to a thrown Error (see useConsentApi). */
export interface ConsentErrorLike {
  message?: string;
  /** Server error code, e.g. "signer_not_permitted". */
  code?: string;
  /** Zod issues from a 400 "Invalid input" response. */
  issues?: Array<{ path?: Array<string | number>; message?: string }>;
}

/** @deprecated name kept for the first call site; same shape. */
export type SignErrorLike = ConsentErrorLike;

/** Fields the wizard can name in its own words. Anything else falls back to the raw path segment. */
export const SIGN_FIELD_KEYS = [
  "governmentIdNumber",
  "governmentIdType",
  "governmentIdCountry",
  "coGuardianAcknowledged",
  "typedName",
  "signature",
  "locale",
  "consentTextVersion",
  "consentTextHash",
] as const;

/**
 * Every code the consent controller can return, across its invitation, phone
 * OTP and consent-record error maps. Each has a `consent.errors.<code>` string
 * in all locales; a code missing from this list is shown as the generic
 * sentence rather than as its raw English message.
 */
export const CONSENT_ERROR_CODES = [
  // invitation / withdrawal token lifecycle
  "contact_not_found",
  "contact_missing_channel",
  "recipient_type_mismatch",
  "self_destination_required",
  "student_not_found",
  "code_not_found",
  "code_expired",
  "code_already_used",
  "code_revoked",
  "permission_denied",
  "channel_unsupported",
  "phone_otp_required",
  "child_id_not_on_file",
  "child_id_verify_locked",
  "child_id_mismatch",
  "child_id_verification_required",
  "consent_not_found",
  "consent_already_revoked",
  "withdrawal_not_available",
  "confirmation_required",
  // phone OTP
  "phone_invalid",
  "rate_limited",
  "send_failed",
  "code_attempts_exceeded",
  "code_mismatch",
  // consent record
  "student_missing_birth_date",
  "contact_not_for_student",
  "contact_not_legal_guardian",
  "contact_not_owned_by_caller",
  "guardianship_basis_required",
  "signer_not_permitted",
  "disclosures_required",
  "notice_not_found",
  "notice_version_mismatch",
  "notice_hash_mismatch",
  "idv_unknown_method",
  "idv_not_acceptable",
] as const;

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** Any consent request: a field problem, a known code, or the generic sentence. */
export function describeConsentError(err: ConsentErrorLike | null | undefined, t: TranslateFn): string {
  const issue = err?.issues?.find((i) => Array.isArray(i.path) && i.path.length > 0);
  if (issue) {
    const last = String(issue.path![issue.path!.length - 1]);
    const known = (SIGN_FIELD_KEYS as readonly string[]).includes(last);
    const field = known ? t(`consent.wizard.fieldNames.${last}`) : last;
    return t("consent.wizard.invalidField", { field });
  }
  if (err?.code && (CONSENT_ERROR_CODES as readonly string[]).includes(err.code)) {
    return t(`consent.errors.${err.code}`);
  }
  return t("consent.wizard.unexpectedError");
}

/**
 * The SIGN step specifically. Same as above, except a refused attestation for
 * a self-consenting student gets the wizard's fuller explanation (what to do
 * instead), because that is the one case a clinician can act on right there.
 */
export function describeSignError(err: ConsentErrorLike | null | undefined, t: TranslateFn): string {
  if (err?.code === "signer_not_permitted" && !err.issues?.length) {
    return t("consent.wizard.selfConsentNoAttestBody");
  }
  return describeConsentError(err, t);
}
