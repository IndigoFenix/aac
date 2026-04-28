// server/services/consent/consentInvitationService.ts
// Magic-link consent flow: clinician sends an invitation, parent clicks the
// link, signs the wizard against the embedded token. The token IS the auth —
// the parent doesn't need to log in.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { db } from "../../db.js";
import { eq } from "drizzle-orm";
import { studentContacts, type ConsentInvitation, type StudentConsentRecord } from "@shared/schema";
import { consentInvitationRepository } from "../../repositories/consentInvitationRepository.js";
import { studentRepository } from "../../repositories/studentRepository.js";
import { userRepository } from "../../repositories/userRepository.js";
import {
  consentService,
  ConsentError,
  type SignConsentInput,
} from "./consentService.js";
import { activityLogService } from "../activityLogService.js";
import { emailService } from "../emailService.js";
import { smsService } from "../smsService.js";
import { phoneOtpService, PhoneOtpError } from "../phoneOtpService.js";
import { toE164 } from "@shared/phone";

export type ConsentInvitationErrorCode =
  | "contact_not_found"
  | "contact_missing_channel"
  | "student_not_found"
  | "code_not_found"
  | "code_expired"
  | "code_already_used"
  | "code_revoked"
  | "permission_denied"
  | "channel_unsupported"
  | "phone_otp_required";

const OTP_PURPOSE = "consent_invitation";

export class ConsentInvitationError extends Error {
  readonly code: ConsentInvitationErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ConsentInvitationErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.details = details;
    this.name = "ConsentInvitationError";
  }
}

const DEFAULT_TTL_DAYS = 7;

class ConsentInvitationService {
  /**
   * Clinician creates an invitation for a parent (identified by an existing
   * contact row that has email or phone but no linked user account).
   * Returns the plaintext code — only chance to display it. The DB stores
   * only the hash.
   */
  async createInvitation(args: {
    studentId: string;
    contactId: string;
    sourceInstituteId: string | null;
    createdByUserId: string;
    channel: "email" | "sms" | "manual";
    ttlDays?: number;
    appBaseUrl?: string;
  }): Promise<{ invitation: ConsentInvitation; code: string; redemptionUrl: string }> {
    const student = await studentRepository.getStudentById(args.studentId);
    if (!student) throw new ConsentInvitationError("student_not_found");

    const [contact] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, args.contactId));
    if (!contact) throw new ConsentInvitationError("contact_not_found");
    if (contact.studentId !== args.studentId) {
      throw new ConsentInvitationError("contact_not_found", "Contact does not belong to that student");
    }

    let sentTo: string;
    if (args.channel === "email") {
      if (!contact.contactEmail) throw new ConsentInvitationError("contact_missing_channel", "Contact has no email");
      sentTo = contact.contactEmail;
    } else if (args.channel === "sms") {
      if (!contact.contactPhone) throw new ConsentInvitationError("contact_missing_channel", "Contact has no phone");
      const normalized = toE164(contact.contactPhone, student.country);
      if (!normalized) {
        throw new ConsentInvitationError(
          "contact_missing_channel",
          `Contact phone "${contact.contactPhone}" cannot be normalized to E.164 (country=${student.country ?? "unknown"})`,
        );
      }
      sentTo = normalized;
    } else {
      sentTo = "manual"; // copy-link path; clinician hands code to parent themselves
    }

    const ttlDays = args.ttlDays ?? DEFAULT_TTL_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const { invitation, code } = await consentInvitationRepository.create({
      studentId: args.studentId,
      contactId: args.contactId,
      sourceInstituteId: args.sourceInstituteId,
      createdByUserId: args.createdByUserId,
      channel: args.channel,
      sentTo,
      expiresAt,
    });

    const baseUrl = args.appBaseUrl ?? process.env.APP_URL ?? "https://aivota.ai";
    const redemptionUrl = `${baseUrl}/consent/sign?code=${encodeURIComponent(code)}`;

    // Dispatch — non-fatal on send failure; clinician can re-issue or share manually.
    if (args.channel === "email") {
      try {
        await emailService.sendEmail({
          to: sentTo,
          subject: "Informed-consent request for your child's clinical record",
          text: `A consent request has been created for ${student.name}.\n\nClick to review and sign:\n${redemptionUrl}\n\nThis link expires on ${expiresAt.toISOString().split("T")[0]}.`,
          html: `<p>A consent request has been created for <strong>${escapeHtml(student.name)}</strong>.</p>` +
                `<p><a href="${redemptionUrl}">Click here to review and sign</a></p>` +
                `<p>This link expires on ${expiresAt.toISOString().split("T")[0]}.</p>`,
        });
      } catch (err) {
        console.error("[consentInvitationService] Email dispatch failed:", err);
      }
    } else if (args.channel === "sms") {
      try {
        const result = await smsService.send({
          to: sentTo,
          body: `Consent request for ${student.name}: ${redemptionUrl} — expires ${expiresAt.toISOString().split("T")[0]}`,
          category: "verification",
        });
        if (!result.success) {
          // Provider returned a soft failure (bad number, sandbox limit, etc.).
          // Log it explicitly so the clinician can diagnose — the invitation
          // row stays in place and can be re-sent.
          console.error(
            `[consentInvitationService] SMS send returned failure to=${sentTo} error=${result.error ?? "unknown"}`,
          );
        }
      } catch (err) {
        console.error("[consentInvitationService] SMS dispatch failed:", err);
      }
    }

    activityLogService.log({
      instituteId: args.sourceInstituteId ?? null,
      userId: args.createdByUserId,
      eventType: "create",
      subjectType1: "consent_record",
      // No consent record yet — subjectId1 ties to the student so it sorts together.
      subjectId1: args.studentId,
      subjectType2: "student",
      subjectId2: args.studentId,
      details: {
        action: "consent_invitation_sent",
        invitationId: invitation.id,
        channel: args.channel,
        contactId: args.contactId,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return { invitation, code, redemptionUrl };
  }

  /**
   * Token redemption — what the magic-link page calls when the parent arrives.
   * Validates the token and returns the (sanitized) wizard context the page
   * needs to render. Does NOT consume the token (signing does).
   */
  async redeemContext(code: string): Promise<{
    invitationId: string;
    channel: string;
    requiresPhoneOtp: boolean;
    contactPhoneMasked: string | null;
    student: { id: string; name: string; firstName: string | null; lastName: string | null; birthDate: string | null; country: string | null; primaryLanguage: string | null };
    contact: { id: string; name: string; relationship: string | null; contactEmail: string | null; contactPhone: string | null; governmentIdNumber: string | null; governmentIdType: string | null; governmentIdCountry: string | null; isLegalGuardian: boolean; coGuardianAcknowledged: boolean };
    expiresAt: string;
  }> {
    const inv = await this.loadActiveByCode(code);
    const student = await studentRepository.getStudentById(inv.studentId);
    if (!student) throw new ConsentInvitationError("student_not_found");
    const [contact] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, inv.contactId));
    if (!contact) throw new ConsentInvitationError("contact_not_found");

    return {
      invitationId: inv.id,
      channel: inv.channel,
      // SMS-channel invitations require an OTP non-repudiation leg before sign.
      requiresPhoneOtp: inv.channel === "sms",
      contactPhoneMasked: contact.contactPhone
        ? maskPhone(toE164(contact.contactPhone, student.country) ?? contact.contactPhone)
        : null,
      student: {
        id: student.id,
        name: student.name,
        firstName: student.firstName,
        lastName: student.lastName,
        birthDate: student.birthDate,
        country: student.country,
        primaryLanguage: student.primaryLanguage,
      },
      contact: {
        id: contact.id,
        name: contact.name,
        relationship: contact.relationship,
        contactEmail: contact.contactEmail,
        contactPhone: contact.contactPhone,
        governmentIdNumber: contact.governmentIdNumber,
        governmentIdType: contact.governmentIdType,
        governmentIdCountry: contact.governmentIdCountry,
        isLegalGuardian: contact.isLegalGuardian,
        coGuardianAcknowledged: contact.coGuardianAcknowledged,
      },
      expiresAt: inv.expiresAt.toISOString(),
    };
  }

  /**
   * Sign consent via the magic-link token. Updates the contact in the same
   * transaction as the consent record — same as the session-authed path.
   * Marks the invitation redeemed once successful.
   *
   * The IDV evidence frozen here is the magic-link click + (optionally) the
   * contact's pre-captured government ID. Channel-specific OTP can be layered
   * on later — for v1 the link click + clinician's prior attestation
   * (in license inviteDefaults / contact gov-ID) is the evidentiary chain.
   */
  async signWithToken(args: {
    code: string;
    /** All other consent fields the wizard collected. */
    payload: Omit<SignConsentInput, "studentId" | "signedByContactId" | "actingUserId">;
    /** Guardian-contact updates committed in the same flow. */
    guardianFields?: {
      governmentIdNumber?: string;
      governmentIdType?: "national_id" | "passport" | "driver_license" | "other";
      governmentIdCountry?: string;
      coGuardianAcknowledged?: boolean;
    };
    signedFromIp?: string | null;
    signedFromUserAgent?: string | null;
  }): Promise<{ consent: StudentConsentRecord; invitation: ConsentInvitation }> {
    const inv = await this.loadActiveByCode(args.code);
    const [contactRow] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, inv.contactId));

    // Phone-OTP gate: SMS-channel invitations MUST have a recently verified
    // OTP for this invitation. This is the non-repudiation leg required by
    // the PPA Feb-2026 evidence rules. Email/manual channels keep the v1
    // behavior (link click is the only leg) — those flows still need a
    // stronger upgrade path before being acceptable for sensitive medical
    // data, tracked in planning-docs/student-consent-implementation.md §11.
    let otpEvidence: Record<string, unknown> = {};
    if (inv.channel === "sms") {
      const phone = await this.resolveContactPhoneE164(inv);
      const verified = await phoneOtpService.getRecentlyVerified({
        phone,
        purpose: OTP_PURPOSE,
        scopeId: inv.id,
      });
      if (!verified) {
        throw new ConsentInvitationError(
          "phone_otp_required",
          "Phone OTP must be verified before signing this consent",
        );
      }
      otpEvidence = {
        otpVerifiedAt: verified.consumedAt?.toISOString() ?? null,
        otpRecordId: verified.id,
        otpProvider: verified.lastProvider ?? null,
        otpProviderMessageId: verified.lastProviderMessageId ?? null,
      };
    }

    // Update the contact: flip isLegalGuardian, capture co-guardian + gov-ID.
    // Same shape as the session-authed sign path — kept consistent so audit
    // trails for token vs session signs look identical.
    const updates: Partial<typeof studentContacts.$inferInsert> = {
      isLegalGuardian: true,
      legalGuardianDeclaredAt: new Date(),
    };
    if (args.guardianFields) {
      const g = args.guardianFields;
      if (g.coGuardianAcknowledged !== undefined) updates.coGuardianAcknowledged = g.coGuardianAcknowledged;
      if (g.governmentIdNumber !== undefined) {
        updates.governmentIdNumber = g.governmentIdNumber;
        updates.governmentIdVerifiedVia = "manual_entry";
        updates.governmentIdVerificationProvider = "self_declared_via_magic_link";
        updates.governmentIdVerifiedAt = new Date();
      }
      if (g.governmentIdType !== undefined) updates.governmentIdType = g.governmentIdType;
      if (g.governmentIdCountry !== undefined) updates.governmentIdCountry = g.governmentIdCountry.toUpperCase();
    }
    await db
      .update(studentContacts)
      .set(updates)
      .where(eq(studentContacts.id, inv.contactId));

    // Sign — IDV evidence ties back to the invitation token + ip/ua.
    const consent = await consentService.signConsent({
      ...args.payload,
      studentId: inv.studentId,
      signedByContactId: inv.contactId,
      identityVerificationMethod: args.payload.identityVerificationMethod ?? "verified_phone_otp",
      identityVerificationEvidence: {
        ...(args.payload.identityVerificationEvidence ?? {}),
        invitationId: inv.id,
        invitationChannel: inv.channel,
        invitationSentTo: inv.sentTo,
        ...otpEvidence,
      },
      nonRepudiationMethod: args.payload.nonRepudiationMethod ?? "verified_phone_otp",
      nonRepudiationEvidence: {
        ...(args.payload.nonRepudiationEvidence ?? {}),
        invitationId: inv.id,
        signedFromIp: args.signedFromIp ?? null,
        signedFromUserAgent: args.signedFromUserAgent ?? null,
        signedViaMagicLink: true,
        ...otpEvidence,
      },
      signedFromIp: args.signedFromIp ?? null,
      signedFromUserAgent: args.signedFromUserAgent ?? null,
      // Token-flow has no acting userId (parent isn't a user).
      actingUserId: null,
    });

    const redeemed = await consentInvitationRepository.markRedeemed(inv.id, consent.id);
    if (!redeemed) {
      // Race: another request consumed the token between our load and update.
      // The consent record is already written; surface this as a soft success
      // by returning the consent + the most recent invitation state.
      const refetched = await consentInvitationRepository.getById(inv.id);
      return { consent, invitation: refetched ?? inv };
    }

    activityLogService.log({
      instituteId: inv.sourceInstituteId,
      userId: null,
      eventType: "update",
      subjectType1: "consent_record",
      subjectId1: consent.id,
      subjectType2: "student",
      subjectId2: inv.studentId,
      details: {
        action: "consent_invitation_redeemed",
        invitationId: inv.id,
        channel: inv.channel,
      },
      isAiInitiated: false,
    });

    return { consent, invitation: redeemed };
  }

  /**
   * Send (or re-send) a phone OTP for the invitation. The OTP is dispatched
   * to the contact's `contactPhone`. Public — the token IS the auth.
   * Rate-limit + attempt-cap live in phoneOtpService.
   */
  async requestPhoneOtp(code: string): Promise<{
    expiresAt: Date;
    sentTo: string; // masked
    bypass: boolean;
  }> {
    const inv = await this.loadActiveByCode(code);
    const phone = await this.resolveContactPhoneE164(inv);
    const result = await phoneOtpService.request({
      phone,
      purpose: OTP_PURPOSE,
      scopeId: inv.id,
    });
    activityLogService.log({
      instituteId: inv.sourceInstituteId,
      userId: null,
      eventType: "create",
      subjectType1: "consent_record",
      subjectId1: inv.studentId,
      subjectType2: "student",
      subjectId2: inv.studentId,
      details: {
        action: "consent_invitation_otp_sent",
        invitationId: inv.id,
        bypass: result.bypass,
      },
      isAiInitiated: false,
    });
    return {
      expiresAt: result.expiresAt,
      sentTo: maskPhone(phone),
      bypass: result.bypass,
    };
  }

  /**
   * Verify the user-supplied OTP for the invitation. Returns the masked
   * phone on success so the wizard can show "verified ending in 1234".
   * The OTP record is marked consumed; signWithToken later checks for a
   * recent consumed record before signing.
   */
  async verifyPhoneOtp(args: { code: string; otpCode: string }): Promise<{
    verifiedAt: Date;
    sentTo: string; // masked
  }> {
    const inv = await this.loadActiveByCode(args.code);
    const phone = await this.resolveContactPhoneE164(inv);
    const otp = await phoneOtpService.verify({
      phone,
      purpose: OTP_PURPOSE,
      scopeId: inv.id,
      code: args.otpCode,
    });
    return {
      verifiedAt: otp.consumedAt ?? new Date(),
      sentTo: maskPhone(phone),
    };
  }

  async revokeInvitation(args: {
    invitationId: string;
    revokedByUserId: string;
  }): Promise<ConsentInvitation> {
    const inv = await consentInvitationRepository.getById(args.invitationId);
    if (!inv) throw new ConsentInvitationError("code_not_found");
    const out = await consentInvitationRepository.revoke(args.invitationId, args.revokedByUserId);
    if (!out) throw new ConsentInvitationError("code_already_used");
    activityLogService.log({
      instituteId: inv.sourceInstituteId,
      userId: args.revokedByUserId,
      eventType: "delete",
      subjectType1: "student",
      subjectId1: inv.studentId,
      details: {
        action: "consent_invitation_revoked",
        invitationId: inv.id,
      },
    });
    return out;
  }

  // ---- internal ----

  /**
   * Resolve the contact's phone for an invitation to E.164 using the
   * student's country as the disambiguation hint. Throws when the contact
   * has no phone or the value can't be normalized.
   */
  private async resolveContactPhoneE164(inv: ConsentInvitation): Promise<string> {
    const [contact] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, inv.contactId));
    if (!contact) throw new ConsentInvitationError("contact_not_found");
    if (!contact.contactPhone) {
      throw new ConsentInvitationError("contact_missing_channel", "Contact has no phone on file");
    }
    const student = await studentRepository.getStudentById(inv.studentId);
    const normalized = toE164(contact.contactPhone, student?.country ?? "IL");
    if (!normalized) {
      throw new ConsentInvitationError(
        "contact_missing_channel",
        `Contact phone "${contact.contactPhone}" cannot be normalized to E.164 (country=${student?.country ?? "unknown"})`,
      );
    }
    return normalized;
  }

  private async loadActiveByCode(code: string): Promise<ConsentInvitation> {
    const inv = await consentInvitationRepository.getByCode(code);
    if (!inv) throw new ConsentInvitationError("code_not_found");
    if (inv.revokedAt) throw new ConsentInvitationError("code_revoked");
    if (inv.redeemedAt) throw new ConsentInvitationError("code_already_used");
    if (inv.expiresAt.getTime() <= Date.now()) {
      throw new ConsentInvitationError("code_expired");
    }
    return inv;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Mask all but the last 4 digits of an E.164 phone for display. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  const last4 = phone.slice(-4);
  const prefix = phone.slice(0, Math.min(3, phone.length - 4));
  return `${prefix}${"*".repeat(Math.max(0, phone.length - 4 - prefix.length))}${last4}`;
}

export { PhoneOtpError };
export const consentInvitationService = new ConsentInvitationService();
