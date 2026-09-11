// server/services/consent/consentWithdrawalService.ts
//
// SELF-SERVE WITHDRAWAL OF CONSENT, for a signer who has no user account.
//
// ─── The gap this closes ────────────────────────────────────────────────────
// `POST /api/consent/:consentId/revoke` requires a session and resolves the
// caller through `studentContacts.linkedUserId`. A guardian who signed by magic
// link — the NORMAL clinic path — has an email, a phone, and no `users` row, so
// that rule can never admit them. The sign token is single-use and was consumed
// at sign time, so their link does not come back. Their consent receipt told
// them to withdraw "by contacting the clinic", and until now that was literally
// the only path: the record was revocable by a system admin and nobody else.
//
// GDPR Art. 7(3) — "it shall be as easy to withdraw as to give consent". Giving
// was a link in an email; withdrawing was a phone call.
//
// ─── The shape, and why it is this one ──────────────────────────────────────
// A withdrawal token addressed to the SIGNER rather than to a session, minted
// on request, delivered to a channel ALREADY ON FILE for that signer, landing
// on a public page, verified by the SAME second factor the sign flow used for
// that channel, and calling the SAME `consentService.revokeConsent` so the
// §7.5 cascade is untouched.
//
// It reuses `consent_invitations` (a `purpose` discriminator) rather than
// adding a table, because that row already solves every hard part — 60-bit code
// generation, sha256-at-rest under a unique index, finite expiry, single-use
// redemption, clinician cancellation, the SMS-OTP scope id, and the
// `idVerifiedAt` / `idVerifyAttempts` brute-force cap. See the ⚠️ block on
// `consentInvitations` in shared/schema-private.ts.
//
// ─── The security bar: EQUAL, in both directions ────────────────────────────
// Not harder than signing, or Art. 7(3) is violated. Not easier, or a forwarded
// receipt email revokes a child's consent — and a withdrawal is not harmless:
// it terminates the live AAC session of a child who depends on the device.
// Parity is achieved by asking the SAME functions the sign flow asks
// (`getChildInstituteIdNumber`, `phoneOtpService`), never by re-stating the
// rule here.
//
// ─── What is deliberately NOT here ──────────────────────────────────────────
// A long-lived token in the receipt email. `consentInvitationService` caps
// sign links at 72 hours on the PPA Feb-2026 rule that a stale link in an inbox
// must not stay redeemable; a withdrawal link with a multi-year life would be a
// standing capability to stop a child's AAC, sitting in whatever inbox that
// receipt was ever forwarded to. The receipt instead carries a REFERENCE URL
// that mints a fresh 72h token and mails it to the address on file — the same
// shape as a password reset, where holding the reference buys you an email to
// an address you must already control, and nothing else.
//
// See docs/student-consent-implementation.md §5.3.

import { and, eq } from "drizzle-orm";

import { db } from "../../db.js";
import {
  studentContacts,
  type ConsentInvitation,
  type StudentConsentRecord,
} from "@shared/schema";
import { consentInvitationRepository } from "../../repositories/consentInvitationRepository.js";
import { studentConsentRecordRepository } from "../../repositories/studentConsentRecordRepository.js";
import { studentRepository } from "../../repositories/studentRepository.js";
import { instituteRepository } from "../../repositories/instituteRepository.js";
import { consentService } from "./consentService.js";
import {
  ConsentInvitationError,
  loadActiveInvitationByCode,
  getChildInstituteIdNumber,
  normalizeIdLast4,
  escapeHtml,
  maskPhone,
  CHILD_ID_MAX_VERIFY_ATTEMPTS,
  CONSENT_LINK_MAX_TTL_HOURS,
} from "./consentInvitationService.js";
import { activityLogService } from "../activityLogService.js";
import { emailService } from "../emailService.js";
import { smsService } from "../smsService.js";
import { phoneOtpService } from "../phoneOtpService.js";
import { toE164 } from "@shared/phone";

/**
 * OTP scope for this flow. DISTINCT from the sign flow's
 * `consent_invitation` on purpose: `phoneOtpService` keys `(purpose, scopeId,
 * phone)`, and sharing a purpose would let an OTP verified for one act satisfy
 * the other. The scopeId is the withdrawal token's own id, so a code is good
 * for exactly one withdrawal of exactly one record.
 */
const OTP_PURPOSE = "consent_withdrawal";

/**
 * The revocation path label written to the audit row (§8). The fourth value
 * alongside `signer`, `system_admin` and `attest_parity`.
 *
 * It is NOT `signer`: that label means "an authenticated user who is the
 * signing contact's linked account", and the whole point here is that no such
 * account exists. A reader of the log must be able to tell "the parent clicked
 * withdraw in their own browser, proving possession of the phone we already had
 * on file" from "the parent logged in and clicked withdraw" — the evidentiary
 * chains are different.
 */
export const SIGNER_TOKEN_REVOCATION_PATH = "signer_token";

/**
 * How long a freshly-minted withdrawal link lives. Same ceiling as a sign link
 * (`CONSENT_LINK_MAX_TTL_HOURS`), and that equality is deliberate: a shorter
 * window would make withdrawing harder than giving, which is the one thing
 * Art. 7(3) forbids. A shorter TTL was considered — the guardian requests the
 * link seconds before they need it, so hours would do — and rejected for that
 * reason alone.
 */
const WITHDRAWAL_TTL_HOURS = CONSENT_LINK_MAX_TTL_HOURS;

/**
 * Re-issue throttle for the PUBLIC request-link path. Holding a consent
 * reference lets you cause one email to an address you do not control; without
 * a throttle it would let you cause an unbounded number of them. Ten minutes
 * also matches the OTP lifetime, so a guardian who lost the mail and retries is
 * never told to wait for something they could not have used anyway.
 *
 * The CLINICIAN re-issue path bypasses it: that caller is authenticated,
 * institute-gated, and acting on a human who is on the phone asking.
 */
const PUBLIC_REISSUE_THROTTLE_MS = 10 * 60 * 1000;

// ============================================================================
// Delivery — injected, never NODE_ENV-guarded
// ============================================================================

export interface WithdrawalMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Everything this service sends, behind one injectable object.
 *
 * 🚨 THIS EXISTS BECAUSE THE TEST ENVIRONMENT CARRIES LIVE SES CREDENTIALS.
 * `server/tests/setup.ts` strips LLM keys and redirects the database, and
 * touches no `AWS_*` variable — so `emailService.isReady()` is true under jest
 * and an unmocked send is a real SES call. The repo's answer to this is
 * dependency injection at the function boundary
 * (`securityIncidentDispatcher.ts`, `accessReviewCron.ts`), NOT a `NODE_ENV`
 * branch inside a shared helper: a branch inside `emailService` would silently
 * disable mail for every caller and could not be reasoned about from a test
 * file. Tests call `setWithdrawalDispatcher` and assert on what was captured.
 */
export interface WithdrawalDispatcher {
  sendEmail(msg: WithdrawalMessage): Promise<{ success: boolean; error?: string }>;
  sendSms(msg: { to: string; body: string }): Promise<{ success: boolean; error?: string }>;
}

const defaultDispatcher: WithdrawalDispatcher = {
  sendEmail: (msg) => emailService.sendEmail(msg),
  sendSms: (msg) =>
    smsService.send({ to: msg.to, body: msg.body, category: "verification" }),
};

let dispatcher: WithdrawalDispatcher = defaultDispatcher;

/** Test seam — see the note on `WithdrawalDispatcher`. */
export function setWithdrawalDispatcher(next: WithdrawalDispatcher): void {
  dispatcher = next;
}

/** Test seam — restore the real SES/SNS transports. */
export function resetWithdrawalDispatcher(): void {
  dispatcher = defaultDispatcher;
}

// ============================================================================
// Destination resolution — where a withdrawal link may be sent, and what it
// must prove on arrival
// ============================================================================

export type WithdrawalChannel = "email" | "sms";

interface WithdrawalDestination {
  /** The guardian contact, or null on a self-consent record. */
  contactId: string | null;
  contactName: string | null;
  channel: WithdrawalChannel;
  /** Email address or E.164 phone. ALWAYS read from storage, never a request. */
  sentTo: string;
  /** The institute whose child-ID is the email channel's knowledge factor. */
  sourceInstituteId: string | null;
  requiresPhoneOtp: boolean;
  requiresIdVerification: boolean;
}

/**
 * Who may withdraw this record over a token, and where the link may go.
 *
 * The rule is "the person who signed, or was attested for". It is expressed as
 * a REFUSAL on everyone else:
 *
 *  - A signing contact WITH a `linkedUserId` → `withdrawal_not_available`. They
 *    already have the session path (`revokePathFor` → `signer`), and minting
 *    them a token would add a second, weaker credential to an account that has
 *    a password and MFA. Art. 7(3) asks for parity, not for a bypass.
 *  - A self-signed record signed IN a session (`signedByUserId` set) → same.
 *  - A self-signed record signed by magic link (no contact, no user) → allowed,
 *    with the destination read off the invitation that produced it. That row's
 *    `sentTo` is the student's own email/phone, normalised at creation time,
 *    and it is the only place the destination exists.
 *
 * 🚨 `sentTo` is NEVER taken from a request. The whole security model is that
 * the link goes to a channel the clinic recorded before any of this started; an
 * attacker who can name the destination has simply been handed the account.
 */
async function resolveDestination(
  record: StudentConsentRecord,
  preferredChannel?: WithdrawalChannel,
): Promise<WithdrawalDestination> {
  const student = await studentRepository.getStudentById(record.studentId);
  const country = student?.country ?? record.country ?? "IL";

  // The institute whose child-ID number backs the email channel. Prefer the one
  // the original invitation named; an ATTESTED record never had an invitation,
  // so fall back to the student's current enrolment.
  const origin = await consentInvitationRepository.getBySignedConsentId(record.id);
  let sourceInstituteId = origin?.sourceInstituteId ?? null;
  if (!sourceInstituteId) {
    const enrollments = await instituteRepository.getInstitutesByStudentId(
      record.studentId,
    );
    sourceInstituteId = enrollments[0]?.institute.id ?? null;
  }

  let contactId: string | null = null;
  let contactName: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;
  let isGuardianContact = false;

  if (record.signedByContactId) {
    const [contact] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, record.signedByContactId));
    if (!contact) throw new ConsentInvitationError("contact_not_found");
    if (contact.linkedUserId) {
      // They have an account; the session revoke path is theirs.
      throw new ConsentInvitationError(
        "withdrawal_not_available",
        "This consent's signer has a user account and can withdraw from their session",
      );
    }
    contactId = contact.id;
    contactName = contact.name;
    email = contact.contactEmail?.trim() || null;
    phone = contact.contactPhone ? toE164(contact.contactPhone, country) : null;
    isGuardianContact = true;
  } else {
    if (record.signedByUserId) {
      throw new ConsentInvitationError(
        "withdrawal_not_available",
        "This consent was signed from a user session and can be withdrawn from it",
      );
    }
    // Self-consent signed over a magic link: the destination lives on the
    // invitation that produced the record, and nowhere else.
    if (!origin || origin.channel === "manual" || !origin.sentTo) {
      throw new ConsentInvitationError(
        "contact_missing_channel",
        "No delivery channel is on file for the signer of this consent",
      );
    }
    if (origin.channel === "email") email = origin.sentTo;
    else phone = origin.sentTo;
  }

  // Channel choice. SMS is preferred when available because it is the channel
  // that carries a real second factor (an OTP to a number on file); email's
  // factor is a knowledge check that only exists when an institute ID happens
  // to be recorded. Preferring the stronger available channel is what keeps the
  // withdrawal bar from drifting BELOW the signing bar for the same person.
  const childId = isGuardianContact
    ? await getChildInstituteIdNumber(sourceInstituteId, record.studentId)
    : null;

  let channel: WithdrawalChannel;
  if (preferredChannel) {
    const available = preferredChannel === "sms" ? phone : email;
    if (!available) {
      throw new ConsentInvitationError(
        "contact_missing_channel",
        `No ${preferredChannel} on file for this consent's signer`,
      );
    }
    channel = preferredChannel;
  } else if (phone) {
    channel = "sms";
  } else if (email) {
    channel = "email";
  } else {
    throw new ConsentInvitationError(
      "contact_missing_channel",
      "No email or phone on file for this consent's signer",
    );
  }

  return {
    contactId,
    contactName,
    channel,
    sentTo: channel === "sms" ? phone! : email!,
    sourceInstituteId,
    // Parity with the sign flow, term for term (consentInvitationService
    // .redeemContext): SMS gates on an OTP; email gates on the child-ID last-4
    // when — and only when — an ID is actually on file to check against.
    requiresPhoneOtp: channel === "sms",
    requiresIdVerification: channel === "email" && !!childId,
  };
}

// ============================================================================
// Service
// ============================================================================

class ConsentWithdrawalService {
  /**
   * PUBLIC. The receipt's "withdraw" link lands here with the consent record's
   * reference (its id — the value the receipt already prints as `Reference:`).
   *
   * 🚨 THIS ALWAYS SUCCEEDS. It resolves nothing to the caller: not whether the
   * reference names a real record, not whether the student exists, not whether
   * the signer has an account, not whether a channel is on file, not whether
   * the consent is already withdrawn. A reference is a 122-bit UUID, so it is
   * unguessable; but "unguessable" is a reason not to worry about brute force,
   * not a reason to answer questions about the one you were handed.
   *
   * What holding a reference buys you is one email or SMS to an address the
   * clinic recorded before you ever saw it — the password-reset shape.
   */
  async requestLinkByReference(args: {
    reference: string;
    appBaseUrl?: string;
  }): Promise<void> {
    try {
      const record = await studentConsentRecordRepository.getById(
        args.reference.trim(),
      );
      if (!record || record.revokedAt) return;
      await this.issueLink({
        record,
        createdByUserId: null,
        appBaseUrl: args.appBaseUrl,
        throttle: true,
        origin: "guardian_request",
      });
    } catch (err) {
      // Refusals here are ordinary states (no channel on file, signer has an
      // account, already withdrawn). None of them may reach the caller, because
      // each one is an answer about a record they merely referenced.
      if (!(err instanceof ConsentInvitationError)) {
        console.error("[consentWithdrawal] request-link failed:", err);
      }
    }
  }

  /**
   * The clinic re-issues a withdrawal link — the guardian phoned, or lost the
   * email. Authenticated and institute-gated at the controller; this half is
   * the same minting the public path uses, so there is exactly one place where
   * a withdrawal token comes into being.
   *
   * Unlike the public path this one REPORTS failures (the clinician needs to
   * know that the contact has no phone on file) and bypasses the throttle.
   */
  async reissueLinkForClinician(args: {
    consentId: string;
    channel?: WithdrawalChannel;
    createdByUserId: string;
    appBaseUrl?: string;
  }): Promise<{ channel: WithdrawalChannel; sentToMasked: string; expiresAt: Date }> {
    const record = await studentConsentRecordRepository.getById(args.consentId);
    if (!record) throw new ConsentInvitationError("consent_not_found");
    if (record.revokedAt) throw new ConsentInvitationError("consent_already_revoked");

    const issued = await this.issueLink({
      record,
      channel: args.channel,
      createdByUserId: args.createdByUserId,
      appBaseUrl: args.appBaseUrl,
      throttle: false,
      origin: "clinician_reissue",
    });
    if (!issued) {
      // Unreachable with throttle:false, but the type says it can be null.
      throw new ConsentInvitationError("contact_missing_channel");
    }
    return {
      channel: issued.destination.channel,
      sentToMasked: maskDestination(issued.destination),
      expiresAt: issued.invitation.expiresAt,
    };
  }

  /**
   * PUBLIC — the token IS the auth. What the withdrawal page renders before the
   * guardian confirms anything.
   *
   * Disclosure is capped at exactly what the SIGN flow's `redeemContext`
   * already discloses pre-verification (student name, contact name and
   * relationship), because the two links travel by the same channels and can be
   * forwarded the same way. It adds only facts about the record the holder is
   * being asked to withdraw — when it was signed and under which notice
   * version — without which "confirm withdrawal" is a blind click.
   */
  async withdrawContext(code: string): Promise<{
    invitationId: string;
    channel: string;
    requiresPhoneOtp: boolean;
    requiresIdVerification: boolean;
    idVerified: boolean;
    contactPhoneMasked: string | null;
    student: { id: string; name: string; firstName: string | null; lastName: string | null };
    contact: { id: string; name: string; relationship: string | null } | null;
    consent: { id: string; signedAt: string; consentTextVersion: string };
    expiresAt: string;
  }> {
    const inv = await loadActiveInvitationByCode(code, "withdraw");
    const record = await this.loadTargetRecord(inv);
    const student = await studentRepository.getStudentById(record.studentId);
    if (!student) throw new ConsentInvitationError("student_not_found");

    let contact: { id: string; name: string; relationship: string | null } | null = null;
    if (inv.contactId) {
      const [row] = await db
        .select()
        .from(studentContacts)
        .where(eq(studentContacts.id, inv.contactId));
      if (row) contact = { id: row.id, name: row.name, relationship: row.relationship };
    }

    return {
      invitationId: inv.id,
      channel: inv.channel,
      requiresPhoneOtp: inv.channel === "sms",
      requiresIdVerification: await this.emailFactorApplies(inv),
      idVerified: !!inv.idVerifiedAt,
      contactPhoneMasked: inv.channel === "sms" ? maskPhone(inv.sentTo) : null,
      student: {
        id: student.id,
        name: student.name,
        firstName: student.firstName,
        lastName: student.lastName,
      },
      contact,
      consent: {
        id: record.id,
        signedAt: new Date(record.signedAt).toISOString(),
        consentTextVersion: record.consentTextVersion,
      },
      expiresAt: inv.expiresAt.toISOString(),
    };
  }

  /** PUBLIC — send/re-send the SMS OTP for this withdrawal token. */
  async requestPhoneOtp(code: string): Promise<{
    expiresAt: Date;
    sentTo: string; // masked
    bypass: boolean;
  }> {
    const inv = await loadActiveInvitationByCode(code, "withdraw");
    const phone = this.requirePhone(inv);
    const result = await phoneOtpService.request({
      phone,
      purpose: OTP_PURPOSE,
      scopeId: inv.id,
    });
    this.logInvitationEvent(inv, "consent_withdrawal_otp_sent", {
      bypass: result.bypass,
    });
    return {
      expiresAt: result.expiresAt,
      sentTo: maskPhone(phone),
      bypass: result.bypass,
    };
  }

  /** PUBLIC — verify the OTP. `confirm` later checks it was consumed recently. */
  async verifyPhoneOtp(args: { code: string; otpCode: string }): Promise<{
    verifiedAt: Date;
    sentTo: string; // masked
  }> {
    const inv = await loadActiveInvitationByCode(args.code, "withdraw");
    const phone = this.requirePhone(inv);
    const otp = await phoneOtpService.verify({
      phone,
      purpose: OTP_PURPOSE,
      scopeId: inv.id,
      code: args.otpCode,
    });
    return { verifiedAt: otp.consumedAt ?? new Date(), sentTo: maskPhone(phone) };
  }

  /**
   * PUBLIC — verify the last-4 of the child's institute ID for an email-channel
   * withdrawal token. Attempt-capped by the same constant and the same columns
   * the sign flow uses, so a locked gate means the same thing on both.
   */
  async verifyChildId(args: { code: string; last4: string }): Promise<{
    verifiedAt: Date;
    attemptsRemaining: number;
  }> {
    const inv = await loadActiveInvitationByCode(args.code, "withdraw");

    if (inv.idVerifiedAt) {
      return {
        verifiedAt: inv.idVerifiedAt,
        attemptsRemaining: CHILD_ID_MAX_VERIFY_ATTEMPTS - inv.idVerifyAttempts,
      };
    }
    if (inv.idVerifyAttempts >= CHILD_ID_MAX_VERIFY_ATTEMPTS) {
      throw new ConsentInvitationError(
        "child_id_verify_locked",
        "Too many incorrect attempts — ask the clinic to resend the link",
        { attemptsRemaining: 0 },
      );
    }

    const childIdNumber = await getChildInstituteIdNumber(
      inv.sourceInstituteId,
      inv.studentId,
    );
    if (!childIdNumber) {
      throw new ConsentInvitationError(
        "child_id_not_on_file",
        "No child ID is on file to verify against",
      );
    }

    const expected = normalizeIdLast4(childIdNumber);
    const supplied = normalizeIdLast4(args.last4);
    if (expected.length < 4 || supplied.length < 4 || expected !== supplied) {
      const attempts = await consentInvitationRepository.incrementIdVerifyAttempts(inv.id);
      const remaining = Math.max(0, CHILD_ID_MAX_VERIFY_ATTEMPTS - attempts);
      this.logInvitationEvent(inv, "consent_withdrawal_child_id_failed", {
        attemptsRemaining: remaining,
      });
      throw new ConsentInvitationError(
        "child_id_mismatch",
        "That doesn't match the child's ID on file",
        { attemptsRemaining: remaining },
      );
    }

    const updated = await consentInvitationRepository.markIdVerified(inv.id);
    this.logInvitationEvent(inv, "consent_withdrawal_child_id_verified", {});
    return {
      verifiedAt: updated?.idVerifiedAt ?? new Date(),
      attemptsRemaining: CHILD_ID_MAX_VERIFY_ATTEMPTS - inv.idVerifyAttempts,
    };
  }

  /**
   * PUBLIC — the withdrawal itself.
   *
   * 🚨 `confirm` must be `true` in the BODY of a POST. This is never a GET and
   * never fires on page load: email scanners, corporate link-rewriters and
   * browser prefetchers follow URLs, and a one-click withdrawal link would let
   * any of them terminate a child's AAC session without a human ever seeing the
   * page. The client's checkbox is the human; this flag is the server refusing
   * to believe anything else.
   *
   * The second factor is checked HERE, immediately before the commit, not
   * merely at the /verify-* step: those endpoints only record that a factor was
   * satisfied, and a client that skipped them would otherwise reach the commit
   * with nothing proved.
   */
  async confirmWithdrawal(args: {
    code: string;
    confirm: boolean;
    reason?: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ consent: StudentConsentRecord; studentId: string }> {
    if (args.confirm !== true) {
      throw new ConsentInvitationError(
        "confirmation_required",
        "The withdrawal must be explicitly confirmed",
      );
    }

    const inv = await loadActiveInvitationByCode(args.code, "withdraw");
    const record = await this.loadTargetRecord(inv);

    // ── Second factor, checked before anything commits ────────────────────
    let secondFactor: "phone_otp" | "child_id_last4" | "token_only" = "token_only";
    let factorEvidence: Record<string, unknown> = {};

    if (inv.channel === "sms") {
      const phone = this.requirePhone(inv);
      const verified = await phoneOtpService.getRecentlyVerified({
        phone,
        purpose: OTP_PURPOSE,
        scopeId: inv.id,
      });
      if (!verified) {
        throw new ConsentInvitationError(
          "phone_otp_required",
          "Phone OTP must be verified before withdrawing this consent",
        );
      }
      secondFactor = "phone_otp";
      factorEvidence = {
        otpVerifiedAt: verified.consumedAt?.toISOString() ?? null,
        otpRecordId: verified.id,
      };
    } else if (await this.emailFactorApplies(inv)) {
      if (!inv.idVerifiedAt) {
        throw new ConsentInvitationError(
          "child_id_verification_required",
          "The child's ID must be verified before withdrawing this consent",
        );
      }
      secondFactor = "child_id_last4";
      factorEvidence = {
        childIdVerifiedAt: inv.idVerifiedAt.toISOString(),
        childIdVerifyMethod: "last4_institute_id_match",
      };
    }
    // `token_only` is reached exactly when the SIGN flow would also have been
    // token-only for this channel: an email invitation for a student with no
    // institute ID on file. Parity, not a shortcut — and it is derived from
    // `getChildInstituteIdNumber`, the sign path's own predicate, rather than
    // asserted here.

    // ── Spend the token, THEN revoke ──────────────────────────────────────
    // This order is deliberate. `markWithdrawalRedeemed` is a conditional
    // update on "not yet redeemed", so it is the concurrency guard: two tabs
    // racing produce one winner and one `code_already_used`, and the loser
    // never reaches the cascade. Revoking first and stamping after would let
    // both run the cascade.
    const spent = await consentInvitationRepository.markWithdrawalRedeemed(inv.id);
    if (!spent) throw new ConsentInvitationError("code_already_used");

    const revoked = await consentService.revokeConsent({
      consentId: record.id,
      // No account exists for this person — that is the premise of the flow.
      // The audit row below carries who they are.
      revokedByUserId: null,
      reason: args.reason,
      extraDetails: {
        revocation_path: SIGNER_TOKEN_REVOCATION_PATH,
        withdrawal_invitation_id: inv.id,
        withdrawal_channel: inv.channel,
        withdrawal_second_factor: secondFactor,
        revoked_by_contact_id: inv.contactId ?? null,
        identity_verification_method: record.identityVerificationMethod,
        withdrawn_from_ip: args.ip ?? null,
        withdrawn_from_user_agent: args.userAgent ?? null,
        ...factorEvidence,
      },
    });

    // The clinic has to learn that processing stopped. Non-fatal: the
    // withdrawal is the legally binding act and must stand even if nobody can
    // be told about it.
    await this.notifyClinicOfWithdrawal(inv, record).catch((err) => {
      console.error("[consentWithdrawal] clinic notification failed:", err);
    });

    return { consent: revoked, studentId: record.studentId };
  }

  /**
   * Could a withdrawal link be issued for this record at all?
   *
   * Feeds `canSendWithdrawalLink` on the `/history` response, for the same
   * reason `canRevoke` is server-computed (§5.2): the client cannot see whether
   * the signing contact has a `linkedUserId` or an email/phone on file, and a
   * button offered on a guess is a confident click and an error toast.
   *
   * It answers by asking the real resolver and catching its refusals, so the
   * affordance and the endpoint cannot disagree — there is no second copy of
   * "who may be sent a withdrawal link".
   */
  async canIssueWithdrawalLink(record: StudentConsentRecord): Promise<boolean> {
    if (record.revokedAt) return false;
    try {
      await resolveDestination(record);
      return true;
    } catch (err) {
      if (err instanceof ConsentInvitationError) return false;
      throw err;
    }
  }

  // ---- internal ----

  /**
   * Mint + dispatch one withdrawal token. The ONE place a withdrawal token is
   * created; both the guardian's request and the clinic's re-issue land here.
   * Returns null when the throttle suppressed the mint.
   */
  private async issueLink(args: {
    record: StudentConsentRecord;
    channel?: WithdrawalChannel;
    createdByUserId: string | null;
    appBaseUrl?: string;
    throttle: boolean;
    origin: "guardian_request" | "clinician_reissue";
  }): Promise<{ invitation: ConsentInvitation; destination: WithdrawalDestination } | null> {
    const destination = await resolveDestination(args.record, args.channel);

    if (args.throttle) {
      const pending = await consentInvitationRepository.listPendingWithdrawalsForConsent(
        args.record.id,
      );
      const recent = pending.some(
        (p) => Date.now() - new Date(p.createdAt).getTime() < PUBLIC_REISSUE_THROTTLE_MS,
      );
      if (recent) return null;
    }

    const expiresAt = new Date(Date.now() + WITHDRAWAL_TTL_HOURS * 60 * 60 * 1000);
    const { invitation, code } = await consentInvitationRepository.create({
      studentId: args.record.studentId,
      contactId: destination.contactId,
      recipientType: args.record.signerType === "self" ? "self" : "guardian",
      purpose: "withdraw",
      targetConsentId: args.record.id,
      sourceInstituteId: destination.sourceInstituteId,
      createdByUserId: args.createdByUserId,
      channel: destination.channel,
      sentTo: destination.sentTo,
      expiresAt,
    });

    const baseUrl = args.appBaseUrl ?? process.env.APP_URL ?? "https://aivota.ai";
    // Fragment, not query string — a fragment is never sent to the server, so
    // the code stays out of CloudFront/ALB access logs and Referer headers.
    // Same rule as the sign link (consentInvitationService).
    const url = `${baseUrl}/consent/withdraw#code=${encodeURIComponent(code)}`;

    const student = await studentRepository.getStudentById(args.record.studentId);
    const studentName = student?.name ?? "your child";
    const expiryDay = expiresAt.toISOString().split("T")[0];

    if (destination.channel === "email") {
      const result = await dispatcher.sendEmail({
        to: destination.sentTo,
        subject: `Withdraw your consent for ${studentName}'s clinical record`,
        text: [
          `You asked for a link to withdraw the informed consent you signed for ${studentName}.`,
          ``,
          `Open this link to review what withdrawing does and confirm it:`,
          url,
          ``,
          `This link can be used once and expires on ${expiryDay}.`,
          `If you did not ask for this, you can ignore this message — nothing changes unless you confirm on that page.`,
        ].join("\n"),
        html:
          `<p>You asked for a link to withdraw the informed consent you signed for <strong>${escapeHtml(studentName)}</strong>.</p>` +
          `<p><a href="${url}">Review and confirm the withdrawal</a></p>` +
          `<p>This link can be used once and expires on ${expiryDay}.</p>` +
          `<p>If you did not ask for this, you can ignore this message — nothing changes unless you confirm on that page.</p>`,
      });
      if (!result.success) {
        console.error(
          `[consentWithdrawal] email dispatch failed invitation=${invitation.id} error=${result.error ?? "unknown"}`,
        );
      }
    } else {
      const result = await dispatcher.sendSms({
        to: destination.sentTo,
        body: `Withdraw consent for ${studentName}: ${url} — usable once, expires ${expiryDay}`,
      });
      if (!result.success) {
        console.error(
          `[consentWithdrawal] SMS dispatch failed invitation=${invitation.id} to=${maskPhone(destination.sentTo)} error=${result.error ?? "unknown"}`,
        );
      }
    }

    activityLogService.log({
      instituteId: destination.sourceInstituteId,
      userId: args.createdByUserId,
      eventType: "create",
      subjectType1: "consent_record",
      subjectId1: args.record.id,
      subjectType2: "student",
      subjectId2: args.record.studentId,
      details: {
        action: "consent_withdrawal_link_sent",
        invitationId: invitation.id,
        origin: args.origin,
        channel: destination.channel,
        contactId: destination.contactId,
        expiresAt: expiresAt.toISOString(),
      },
      isAiInitiated: false,
    });

    return { invitation, destination };
  }

  /** The record a withdrawal token points at, with its two live-state checks. */
  private async loadTargetRecord(inv: ConsentInvitation): Promise<StudentConsentRecord> {
    if (!inv.targetConsentId) throw new ConsentInvitationError("consent_not_found");
    const record = await studentConsentRecordRepository.getById(inv.targetConsentId);
    if (!record) throw new ConsentInvitationError("consent_not_found");
    // A token is bound to a RECORD. The student check below is belt-and-braces
    // against a token whose row was tampered with; the binding itself is the
    // `targetConsentId` FK.
    if (record.studentId !== inv.studentId) {
      throw new ConsentInvitationError("consent_not_found");
    }
    if (record.revokedAt) {
      throw new ConsentInvitationError(
        "consent_already_revoked",
        "This consent has already been withdrawn",
      );
    }
    return record;
  }

  /**
   * Whether the email channel's knowledge factor applies to this token — i.e.
   * whether an institute ID is on file to check against. Asks the SIGN flow's
   * own predicate; see `getChildInstituteIdNumber`.
   */
  private async emailFactorApplies(inv: ConsentInvitation): Promise<boolean> {
    if (inv.channel !== "email") return false;
    if (!inv.contactId) return false; // self-consent uses SMS+OTP, as at signing
    return !!(await getChildInstituteIdNumber(inv.sourceInstituteId, inv.studentId));
  }

  private requirePhone(inv: ConsentInvitation): string {
    if (inv.channel !== "sms" || !inv.sentTo) {
      throw new ConsentInvitationError(
        "contact_missing_channel",
        "This withdrawal link was not sent over SMS",
      );
    }
    return inv.sentTo;
  }

  private logInvitationEvent(
    inv: ConsentInvitation,
    action: string,
    details: Record<string, unknown>,
  ): void {
    activityLogService.log({
      instituteId: inv.sourceInstituteId,
      userId: null,
      eventType: "update",
      subjectType1: "consent_record",
      subjectId1: inv.targetConsentId ?? inv.studentId,
      subjectType2: "student",
      subjectId2: inv.studentId,
      details: { action, invitationId: inv.id, ...details },
      isAiInitiated: false,
    });
  }

  /**
   * Tell the clinic that processing stopped.
   *
   * ⚠️ THERE IS NO IN-APP NOTIFICATION SYSTEM IN THIS CODEBASE. There is no
   * notifications table, no notification service, and no clinician-visible
   * activity feed — `/api/admin/activity-logs` is gated on `isAdminIdentity`,
   * i.e. Aivota staff, not `instituteUsers.isAdmin`. Before this, a withdrawal
   * was discoverable only by a clinician later hitting a `consentGate` refusal
   * or noticing `ConsentMissingIndicator`. So this is not a reuse of an
   * existing notifier; it is email, addressed to the institute's ADMIN members
   * (`instituteRepository.getInstituteMembers` → `membership.isAdmin`), through
   * the same injected dispatcher as everything else here.
   *
   * Scoped to THIS path on purpose. The `signer` / `system_admin` /
   * `attest_parity` revocations are untouched: each of those is performed by a
   * logged-in person who is already in the room, and adding a send to them
   * would also make four existing consent test suites mail live clinician
   * addresses over the test environment's real SES credentials.
   */
  private async notifyClinicOfWithdrawal(
    inv: ConsentInvitation,
    record: StudentConsentRecord,
  ): Promise<void> {
    const student = await studentRepository.getStudentById(record.studentId);
    const studentName = student?.name ?? "a student";
    const enrollments = await instituteRepository.getInstitutesByStudentId(
      record.studentId,
    );

    const seen = new Set<string>();
    for (const { institute } of enrollments) {
      const members = await instituteRepository.getInstituteMembers(institute.id);
      for (const m of members) {
        if (!m.membership.isAdmin) continue;
        const to = m.user.email?.trim();
        if (!to || seen.has(to.toLowerCase())) continue;
        seen.add(to.toLowerCase());
        await dispatcher.sendEmail({
          to,
          subject: `Consent withdrawn for ${studentName}`,
          text: [
            `The guardian who signed the informed consent for ${studentName} has withdrawn it.`,
            ``,
            `Processing has stopped: active data shares for this student were revoked and any`,
            `in-flight AAC session was terminated. Reports, programs and incident records can`,
            `no longer be finalized until a new consent is signed.`,
            ``,
            `Consent reference: ${record.id}`,
          ].join("\n"),
          html:
            `<p>The guardian who signed the informed consent for <strong>${escapeHtml(studentName)}</strong> has withdrawn it.</p>` +
            `<p>Processing has stopped: active data shares for this student were revoked and any in-flight AAC session was terminated. Reports, programs and incident records can no longer be finalized until a new consent is signed.</p>` +
            `<p style="color:#888;font-size:12px">Consent reference: ${escapeHtml(record.id)}</p>`,
        });
      }

      // `update`, NOT `consent_revoked`: the withdrawal itself already wrote
      // exactly one `consent_revoked` row (consentService), and a second one per
      // institute would make "how many consents were withdrawn" a wrong count
      // in every audit query that trusts the event type. This row exists to
      // carry the `instituteId` the withdrawal row does not have, so a clinic's
      // filtered view of the log can see that it was told.
      activityLogService.log({
        instituteId: institute.id,
        userId: null,
        eventType: "update",
        subjectType1: "consent_record",
        subjectId1: record.id,
        subjectType2: "student",
        subjectId2: record.studentId,
        details: {
          action: "consent_withdrawal_clinic_notified",
          invitationId: inv.id,
          recipients: seen.size,
        },
        isAiInitiated: false,
      });
    }
  }
}

function maskDestination(d: WithdrawalDestination): string {
  if (d.channel === "sms") return maskPhone(d.sentTo);
  const at = d.sentTo.lastIndexOf("@");
  if (at <= 1) return "***";
  return `${d.sentTo[0]}***@${d.sentTo.slice(at + 1)}`;
}

export const consentWithdrawalService = new ConsentWithdrawalService();
