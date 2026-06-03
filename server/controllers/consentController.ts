// server/controllers/consentController.ts
//
// HTTP surface for the student informed-consent flow. Wizard talks to these
// endpoints to fetch the notice, prefill from existing data, and submit the
// signed consent. Permission checks live here; legal validation in the
// service layer.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "../db";
import {
  studentContacts,
  studentConsentRecords,
  userStudents,
  type StudentContact,
} from "@shared/schema";
import {
  consentService,
  ConsentError,
  type ConsentErrorCode,
} from "../services/consent/consentService";
import {
  consentInvitationService,
  ConsentInvitationError,
  type ConsentInvitationErrorCode,
} from "../services/consent/consentInvitationService";
import {
  consentAuthorityService,
  ConsentAuthorityError,
  type ConsentAuthorityErrorCode,
} from "../services/consent/consentAuthorityService";
import { PhoneOtpError, type PhoneOtpErrorCode } from "../services/phoneOtpService";
import { sendConsentReceipt } from "../services/consent/consentReceipt";
import { studentRepository } from "../repositories/studentRepository";
import { studentConsentRecordRepository } from "../repositories/studentConsentRecordRepository";
import { userRepository } from "../repositories/userRepository";
import { instituteRepository } from "../repositories/instituteRepository";
import {
  lookupConsentNotice,
  renderNoticeForHashing,
  getDefaultRecipients,
} from "@shared/legal";

// ============================================================================
// Zod
// ============================================================================

// Supplemental signature evidence (type-to-sign / draw-to-sign). Stored inside
// nonRepudiationEvidence, NOT used as a distinct IDV method. The image is a PNG
// data URL — capped so a pathological payload can't bloat the jsonb column.
const signatureSchema = z
  .object({
    mode: z.enum(["typed", "drawn"]),
    typedName: z.string().max(200).optional(),
    image: z.string().max(2_000_000).optional(),
    signedAt: z.string().max(40).optional(),
  })
  .optional();

const signConsentSchema = z.object({
  // Required for guardian consent; omitted for self-consent (the logged-in
  // student signs for themselves).
  signedByContactId: z.string().min(1).optional(),
  locale: z.string().min(2).max(10),
  consentTextVersion: z.string().min(1),
  consentTextHash: z.string().length(64),
  signature: signatureSchema,

  // Guardian contact updates committed in the same transaction as the sign.
  guardianFields: z
    .object({
      governmentIdNumber: z.string().min(1).max(40).optional(),
      governmentIdType: z.enum(["national_id", "passport", "driver_license", "other"]).optional(),
      governmentIdCountry: z.string().length(2).optional(),
      coGuardianAcknowledged: z.boolean().optional(),
    })
    .optional(),

  purposeAcknowledged: z.boolean(),
  voluntarinessAcknowledged: z.boolean(),
  thirdPartyTransfersAcknowledged: z.boolean(),

  optInModelTraining: z.boolean().optional(),
  optInAdvertising: z.boolean().optional(),
  optInThirdPartyResearch: z.boolean().optional(),
  optInMarketingComms: z.boolean().optional(),

  // Optional override; default flow uses authenticated_session for the family
  // parent path. Other origins (clinic in-person, video, gov SSO) will pass
  // a stronger method explicitly.
  identityVerificationMethod: z.string().optional(),
  identityVerificationEvidence: z.record(z.unknown()).optional(),
  nonRepudiationMethod: z.string().optional(),
  nonRepudiationEvidence: z.record(z.unknown()).optional(),

  // For the wizard's "treat as standard" v1 family path. Defaults to true.
  isSensitive: z.boolean().optional(),
});

const revokeConsentSchema = z.object({
  reason: z.string().max(2000).optional(),
});

// ============================================================================
// Error → HTTP
// ============================================================================

const errorStatus: Record<ConsentErrorCode, number> = {
  student_not_found: 404,
  student_missing_birth_date: 400,
  contact_not_found: 404,
  contact_not_for_student: 403,
  contact_not_legal_guardian: 422,
  guardianship_basis_required: 422,
  signer_not_permitted: 422,
  disclosures_required: 400,
  notice_not_found: 404,
  notice_version_mismatch: 409,
  notice_hash_mismatch: 409,
  idv_unknown_method: 400,
  idv_not_acceptable: 422,
  consent_not_found: 404,
  consent_already_revoked: 409,
};

function handleError(res: Response, err: unknown): void {
  if (err instanceof ConsentError) {
    res.status(errorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  console.error("[ConsentController]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

// ============================================================================
// Permission helpers
// ============================================================================

async function loadGuardianContactForCurrentUser(
  studentId: string,
  userId: string,
): Promise<StudentContact | null> {
  const [row] = await db
    .select()
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.linkedUserId, userId),
      ),
    );
  return row ?? null;
}

// ============================================================================
// Controller
// ============================================================================

class ConsentController {
  /**
   * GET /api/consent/notice?country=IL&locale=en[&version=...]
   * Returns the notice content (renderable text), its computed hash, the
   * resolved version, and the default recipient list to disclose.
   */
  async getNotice(req: Request, res: Response): Promise<void> {
    try {
      const country = String(req.query.country ?? "").trim();
      const locale = String(req.query.locale ?? "en").trim();
      const version = req.query.version ? String(req.query.version).trim() : undefined;

      if (!country) {
        res.status(400).json({ success: false, message: "country is required" });
        return;
      }

      const variant = lookupConsentNotice({ country, locale, version });
      if (!variant) {
        res.status(404).json({
          success: false,
          message: "No consent notice for that country/locale/version",
        });
        return;
      }
      const hash = createHash("sha256")
        .update(renderNoticeForHashing(variant.content))
        .digest("hex");

      res.json({
        success: true,
        country: variant.country,
        locale: variant.locale,
        version: variant.version,
        hash,
        content: variant.content,
        thirdPartyRecipients: getDefaultRecipients(),
      });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/active
   */
  async getActiveForStudent(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.studentId;
      const record = await consentService.getActiveConsent(studentId);
      res.json({ success: true, consent: record });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/history
   * Full audit-grade history of consent records for the student. Returns
   * active + revoked records, ordered most-recent first. Permission: any
   * institute member of an institute attached to the student. (System
   * admins always pass.)
   */
  async listHistory(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }
      const studentId = req.params.studentId;
      const isSystemAdmin = !!(req.user as any)?.isSystemAdmin;
      if (!isSystemAdmin) {
        const memberships = await instituteRepository.getInstitutesByStudentId(studentId);
        const userInstitutes = await instituteRepository.getInstitutesByUserId(userId);
        const userInstituteIds = new Set(userInstitutes.map((i: any) => i.id));
        if (!memberships.some((m: any) => userInstituteIds.has(m.id))) {
          res.status(403).json({ success: false, code: "permission_denied", message: "No access to that student" });
          return;
        }
      }
      const records = await consentService.listHistory(studentId);
      res.json({ success: true, history: records });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/wizard-context
   * Bundles everything the wizard needs to render: student basics, the
   * current user's profile, their existing guardian contact for this
   * student (if auto-create ran), and the active consent record (if any).
   */
  async getWizardContext(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }

      const studentId = req.params.studentId;
      const student = await studentRepository.getStudentById(studentId);
      if (!student) {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }
      const user = await userRepository.getUser(userId);
      const contact = await loadGuardianContactForCurrentUser(studentId, userId);
      const activeConsent = await consentService.getActiveConsent(studentId);
      const resolvedAuthority = await consentAuthorityService.resolveForStudent(studentId);

      res.json({
        success: true,
        // Who must sign (guardian vs. self) so the wizard renders the right
        // flow. Null when birth date is missing.
        signerType: resolvedAuthority?.signerType ?? null,
        consentAuthority: student.consentAuthority ?? "auto",
        student: {
          id: student.id,
          name: student.name,
          firstName: student.firstName,
          lastName: student.lastName,
          birthDate: student.birthDate,
          country: student.country,
          primaryLanguage: student.primaryLanguage,
        },
        user: user
          ? {
              id: user.id,
              firstName: user.firstName,
              lastName: user.lastName,
              fullName: user.fullName,
              email: user.email,
              country: (user as any).country ?? null,
              phone: (user as any).phone ?? null,
            }
          : null,
        guardianContact: contact,
        activeConsent,
      });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/authority
   * Returns the stored consent-authority determination plus the currently
   * resolved signer (guardian vs. self). Permission: institute member.
   */
  async getAuthority(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }
      const studentId = req.params.studentId;
      if (!(await this.userSharesInstituteWithStudent(req, studentId))) {
        res.status(403).json({ success: false, code: "permission_denied", message: "No access to that student" });
        return;
      }
      const student = await studentRepository.getStudentById(studentId);
      if (!student) { res.status(404).json({ success: false, message: "Student not found" }); return; }
      const resolved = await consentAuthorityService.resolveForStudent(studentId);
      res.json({
        success: true,
        consentAuthority: student.consentAuthority ?? "auto",
        guardianshipBasis: student.guardianshipBasis ?? null,
        guardianshipEvidence: student.guardianshipEvidence ?? null,
        guardianshipReviewDate: student.guardianshipReviewDate ?? null,
        resolved, // { signerType, basis, source } | null
      });
    } catch (err) {
      handleAuthorityError(res, err);
    }
  }

  /**
   * PUT /api/consent/students/:studentId/authority
   * Sets the consent-authority determination (auto / guardian_required / self)
   * plus guardianship basis/evidence/review-date. Permission: institute admin.
   */
  async setAuthority(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }
      const studentId = req.params.studentId;
      if (!(await this.userIsAdminForStudent(req, studentId))) {
        res.status(403).json({ success: false, code: "permission_denied", message: "Only institute admins can set consent authority" });
        return;
      }
      const parsed = setAuthoritySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const updated = await consentAuthorityService.setConsentAuthority(
        studentId,
        {
          mode: parsed.data.mode,
          basis: parsed.data.basis ?? null,
          evidence: parsed.data.evidence ?? null,
          reviewDate: parsed.data.reviewDate ?? null,
        },
        userId,
      );
      const resolved = await consentAuthorityService.resolveForStudent(studentId);
      res.json({
        success: true,
        consentAuthority: updated?.consentAuthority ?? parsed.data.mode,
        guardianshipBasis: updated?.guardianshipBasis ?? null,
        guardianshipEvidence: updated?.guardianshipEvidence ?? null,
        guardianshipReviewDate: updated?.guardianshipReviewDate ?? null,
        resolved,
      });
    } catch (err) {
      handleAuthorityError(res, err);
    }
  }

  /** Institute-membership check shared by authority reads. */
  private async userSharesInstituteWithStudent(req: Request, studentId: string): Promise<boolean> {
    if (!!(req.user as any)?.isSystemAdmin) return true;
    const userId = (req.user as any)?.id;
    const memberships = await instituteRepository.getInstitutesByStudentId(studentId);
    const userInstitutes = await instituteRepository.getInstitutesByUserId(userId);
    const ids = new Set(userInstitutes.map((i: any) => i.id));
    return memberships.some((m: any) => ids.has(m.id));
  }

  /** Institute-admin check shared by authority writes. */
  private async userIsAdminForStudent(req: Request, studentId: string): Promise<boolean> {
    if (!!(req.user as any)?.isSystemAdmin) return true;
    const userId = (req.user as any)?.id;
    const memberships = await instituteRepository.getInstitutesByStudentId(studentId);
    for (const m of memberships as any[]) {
      if (await instituteRepository.isUserAdminOfInstitute(m.id, userId)) return true;
    }
    return false;
  }

  /**
   * POST /api/consent/students/:studentId/sign
   * Updates the guardian contact (legal-guardian declaration + gov-ID) and
   * signs the consent record in the same transaction.
   */
  async signConsent(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }
      const parsed = signConsentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const studentId = req.params.studentId;
      const input = parsed.data;

      // Resolve who may sign for this student (guardian vs. self). signConsent
      // re-validates this server-side; here we branch the permission + contact
      // handling. A null resolution (missing birth date) falls through to the
      // guardian path so signConsent surfaces the clearer student_missing_birth_date.
      const resolved = await consentAuthorityService.resolveForStudent(studentId);
      const signerType = resolved?.signerType ?? "guardian";

      let signedByContactId: string | null = null;
      let signedByUserId: string | null = null;
      let receiptTo: string | null = null;

      if (signerType === "guardian") {
        if (!input.signedByContactId) {
          res.status(422).json({ success: false, code: "signer_not_permitted", message: "This student requires guardian consent — a signing contact is required" });
          return;
        }
        // Permission: the contact being signed-as must be linked to the
        // current user (parent/guardian flow). Stronger flows (clinic
        // in-person attest, etc.) will land at different endpoints.
        const [contact] = await db
          .select()
          .from(studentContacts)
          .where(eq(studentContacts.id, input.signedByContactId));
        if (!contact) {
          res.status(404).json({ success: false, code: "contact_not_found", message: "Contact not found" });
          return;
        }
        if (contact.studentId !== studentId) {
          res.status(403).json({ success: false, code: "contact_not_for_student", message: "Contact does not belong to that student" });
          return;
        }
        if (contact.linkedUserId !== userId) {
          res.status(403).json({ success: false, code: "contact_not_owned_by_caller", message: "Only the linked user can sign as this contact" });
          return;
        }

        // Update the guardian contact in the same transaction:
        //   - flip isLegalGuardian = true (the wizard step asserted it)
        //   - apply coGuardianAcknowledged
        //   - persist gov-ID fields if the wizard collected/updated them
        //   - stamp legalGuardianDeclaredAt
        const updates: Partial<typeof studentContacts.$inferInsert> = {
          isLegalGuardian: true,
          legalGuardianDeclaredAt: new Date(),
        };
        if (input.guardianFields) {
          const g = input.guardianFields;
          if (g.coGuardianAcknowledged !== undefined) updates.coGuardianAcknowledged = g.coGuardianAcknowledged;
          if (g.governmentIdNumber !== undefined) {
            updates.governmentIdNumber = g.governmentIdNumber;
            updates.governmentIdVerifiedVia = "manual_entry";
            updates.governmentIdVerificationProvider = "self_declared";
            updates.governmentIdVerifiedAt = new Date();
          }
          if (g.governmentIdType !== undefined) updates.governmentIdType = g.governmentIdType;
          if (g.governmentIdCountry !== undefined) updates.governmentIdCountry = g.governmentIdCountry.toUpperCase();
        }
        await db
          .update(studentContacts)
          .set(updates)
          .where(eq(studentContacts.id, input.signedByContactId));

        signedByContactId = input.signedByContactId;
        receiptTo = contact.contactEmail ?? null;
      } else {
        // Self-consent: the acting user must be the student's own account (an
        // active user-student link). No guardian contact is involved.
        const [link] = await db
          .select()
          .from(userStudents)
          .where(
            and(
              eq(userStudents.userId, userId),
              eq(userStudents.studentId, studentId),
              eq(userStudents.isActive, true),
            ),
          );
        if (!link) {
          res.status(403).json({ success: false, code: "contact_not_owned_by_caller", message: "Only the student can self-consent for themselves" });
          return;
        }
        if (input.signedByContactId) {
          res.status(422).json({ success: false, code: "signer_not_permitted", message: "This student self-consents — a guardian contact cannot sign on their behalf" });
          return;
        }
        signedByUserId = userId;
      }

      // V1 family flow defaults: authenticated_session both legs, standard regime.
      const idvMethod = input.identityVerificationMethod ?? "authenticated_session";
      const nrMethod = input.nonRepudiationMethod ?? "authenticated_session";
      const idvEvidence = input.identityVerificationEvidence ?? {
        userId,
        signedAt: new Date().toISOString(),
        provenance: "v1_family_flow",
      };
      const nrEvidence = {
        ...(input.nonRepudiationEvidence ?? {
          userId,
          ip: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
        }),
        ...(input.signature ? { signature: input.signature } : {}),
      };

      const record = await consentService.signConsent({
        studentId,
        signedByContactId,
        signedByUserId,
        locale: input.locale,
        consentTextVersion: input.consentTextVersion,
        consentTextHash: input.consentTextHash,
        thirdPartyRecipients: getDefaultRecipients(), // server-trusted, not from client
        purposeAcknowledged: input.purposeAcknowledged,
        voluntarinessAcknowledged: input.voluntarinessAcknowledged,
        thirdPartyTransfersAcknowledged: input.thirdPartyTransfersAcknowledged,
        optInModelTraining: input.optInModelTraining,
        optInAdvertising: input.optInAdvertising,
        optInThirdPartyResearch: input.optInThirdPartyResearch,
        optInMarketingComms: input.optInMarketingComms,
        identityVerificationMethod: idvMethod,
        identityVerificationEvidence: idvEvidence,
        nonRepudiationMethod: nrMethod,
        nonRepudiationEvidence: nrEvidence,
        isSensitive: input.isSensitive ?? false, // v1 family flow: standard
        signedFromIp: req.ip ?? null,
        signedFromUserAgent: (req.headers["user-agent"] as string) ?? null,
        actingUserId: userId,
      });

      // Email the parent their copy of the signed consent (Right to
      // Information). Awaited before responding so Lambda doesn't freeze it;
      // the helper never throws, so a delivery failure won't fail the sign.
      const student = await studentRepository.getStudentById(studentId);
      const finalReceiptTo =
        receiptTo ?? (await userRepository.getUser(userId))?.email ?? null;
      await sendConsentReceipt({
        to: finalReceiptTo,
        studentName: student?.name ?? "your child",
        consent: record,
      });

      res.json({ success: true, consent: record });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * POST /api/consent/:consentId/revoke
   * Only the contact's linked user can revoke (the parent who signed).
   */
  async revokeConsent(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }
      const parsed = revokeConsentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const consentId = req.params.consentId;

      // Permission: revoker must be the linked user of the signing contact,
      // or a system admin. Anything else: 403.
      const existing = await studentConsentRecordRepository.getById(consentId);
      if (!existing) {
        res.status(404).json({ success: false, code: "consent_not_found", message: "Consent not found" });
        return;
      }
      const isSystemAdmin = !!(req.user as any)?.isSystemAdmin;
      if (!isSystemAdmin) {
        // Self-signed consent: only the student who signed may revoke.
        // Guardian-signed: only the signing contact's linked user may revoke.
        let allowed = false;
        if (existing.signerType === "self" || !existing.signedByContactId) {
          allowed = existing.signedByUserId === userId;
        } else {
          const [contact] = await db
            .select()
            .from(studentContacts)
            .where(eq(studentContacts.id, existing.signedByContactId));
          allowed = contact?.linkedUserId === userId;
        }
        if (!allowed) {
          res.status(403).json({ success: false, code: "permission_denied", message: "Only the original signer can revoke this consent" });
          return;
        }
      }

      const revoked = await consentService.revokeConsent({
        consentId,
        revokedByUserId: userId,
        reason: parsed.data.reason,
      });
      res.json({ success: true, consent: revoked });
    } catch (err) {
      handleError(res, err);
    }
  }

  // ============================================================================
  // Magic-link consent invitations (clinician → parent without account)
  // ============================================================================

  /**
   * POST /api/consent/invitations
   * Clinician creates an invitation for a contact (parent without an account)
   * and dispatches it via email or SMS. Returns the redemption URL — the
   * plaintext code is shown only once. Permission: must be admin of the
   * source institute.
   */
  async createInvitation(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }

      const parsed = createInvitationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const input = parsed.data;

      // Permission: caller must be admin of the source institute (or system admin).
      const isSystemAdmin = !!(req.user as any)?.isSystemAdmin;
      if (!isSystemAdmin) {
        const isAdmin = await instituteRepository.isUserAdminOfInstitute(input.sourceInstituteId, userId);
        if (!isAdmin) {
          res.status(403).json({
            success: false,
            code: "permission_denied",
            message: "Only institute admins can send consent invitations",
          });
          return;
        }
      }

      const result = await consentInvitationService.createInvitation({
        studentId: input.studentId,
        contactId: input.contactId,
        recipientType: input.recipientType,
        selfDestination: input.selfDestination,
        sourceInstituteId: input.sourceInstituteId,
        createdByUserId: userId,
        channel: input.channel,
        ttlDays: input.ttlDays,
        appBaseUrl: getBaseUrl(req),
      });

      res.json({
        success: true,
        invitation: result.invitation,
        code: result.code,           // shown once
        redemptionUrl: result.redemptionUrl,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * GET /api/consent/invitations/redeem?code=
   * Public endpoint (no session required) — the magic-link page calls it
   * when the parent arrives. Validates the token and returns the wizard
   * context. Does NOT consume the token.
   */
  async redeemInvitation(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.query.code ?? "").trim();
      if (!code) { res.status(400).json({ success: false, message: "code is required" }); return; }
      const ctx = await consentInvitationService.redeemContext(code);
      res.json({ success: true, ...ctx });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/sign
   * Public endpoint (no session required) — the magic-link page submits the
   * signed wizard payload here. Token IS the auth.
   */
  async signInvitation(req: Request, res: Response): Promise<void> {
    try {
      const parsed = signWithTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const { code, ...rest } = parsed.data;
      const result = await consentInvitationService.signWithToken({
        code,
        payload: {
          locale: rest.locale,
          consentTextVersion: rest.consentTextVersion,
          consentTextHash: rest.consentTextHash,
          thirdPartyRecipients: [], // server overrides at sign-time anyway
          purposeAcknowledged: rest.purposeAcknowledged,
          voluntarinessAcknowledged: rest.voluntarinessAcknowledged,
          thirdPartyTransfersAcknowledged: rest.thirdPartyTransfersAcknowledged,
          optInModelTraining: rest.optInModelTraining,
          optInAdvertising: rest.optInAdvertising,
          optInThirdPartyResearch: rest.optInThirdPartyResearch,
          optInMarketingComms: rest.optInMarketingComms,
          identityVerificationMethod: rest.identityVerificationMethod ?? "verified_phone_otp",
          identityVerificationEvidence: rest.identityVerificationEvidence ?? {},
          nonRepudiationMethod: rest.nonRepudiationMethod ?? "verified_phone_otp",
          nonRepudiationEvidence: {
            ...(rest.nonRepudiationEvidence ?? {}),
            ...(rest.signature ? { signature: rest.signature } : {}),
          },
          isSensitive: rest.isSensitive ?? false,
        } as any,
        guardianFields: rest.guardianFields,
        signedFromIp: req.ip ?? null,
        signedFromUserAgent: (req.headers["user-agent"] as string) ?? null,
      });
      res.json({ success: true, consent: result.consent });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/invitations
   * Returns the active (non-revoked, non-redeemed, unexpired) invitations
   * for a student. Permission-gated: institute admin (or system admin).
   * The clinician needs this to see if a magic link they sent is still
   * outstanding before sending another.
   */
  async listPendingInvitations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }

      const studentId = req.params.studentId;
      const isSystemAdmin = !!(req.user as any)?.isSystemAdmin;

      // Permission: caller must share an institute with the student. We
      // accept any membership — pending invitations are operational state,
      // not PHI. (The actual signing flow has stricter checks.)
      if (!isSystemAdmin) {
        const memberships = await instituteRepository.getInstitutesByStudentId(studentId);
        const userInstitutes = await instituteRepository.getInstitutesByUserId(userId);
        const userInstituteIds = new Set(userInstitutes.map((i: any) => i.id));
        const overlap = memberships.some((m: any) => userInstituteIds.has(m.id));
        if (!overlap) {
          res.status(403).json({ success: false, code: "permission_denied", message: "No access to that student" });
          return;
        }
      }

      const { consentInvitationRepository } = await import("../repositories/consentInvitationRepository");
      const invitations = await consentInvitationRepository.listPendingForStudent(studentId);
      res.json({ success: true, invitations });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/request-otp
   * Public — token IS the auth. Sends/re-sends an SMS OTP to the contact's
   * phone for this invitation. Rate-limited per (invitation, phone).
   */
  async requestPhoneOtp(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      if (!code) {
        res.status(400).json({ success: false, message: "code is required" });
        return;
      }
      const out = await consentInvitationService.requestPhoneOtp(code);
      res.json({
        success: true,
        sentTo: out.sentTo,
        expiresAt: out.expiresAt.toISOString(),
        bypass: out.bypass,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/verify-otp
   * Public — token IS the auth. Verifies the user-submitted OTP and marks
   * it consumed. Sign endpoint then confirms the verification within the
   * freshness window before writing the consent record.
   */
  async verifyPhoneOtp(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      const otpCode = String(req.body?.otpCode ?? "").trim();
      if (!code || !otpCode) {
        res.status(400).json({
          success: false,
          message: "code and otpCode are required",
        });
        return;
      }
      const out = await consentInvitationService.verifyPhoneOtp({
        code,
        otpCode,
      });
      res.json({
        success: true,
        verifiedAt: out.verifiedAt.toISOString(),
        sentTo: out.sentTo,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/verify-id
   * Public — token IS the auth. Verifies the parent-supplied last-4 of the
   * child's institute ID for an email-channel invitation. Attempt-capped in
   * the service. Never echoes the ID back.
   */
  async verifyChildId(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      const last4 = String(req.body?.last4 ?? "").trim();
      if (!code || !last4) {
        res.status(400).json({ success: false, message: "code and last4 are required" });
        return;
      }
      const out = await consentInvitationService.verifyChildId({ code, last4 });
      res.json({
        success: true,
        verifiedAt: out.verifiedAt.toISOString(),
        attemptsRemaining: out.attemptsRemaining,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/:id/revoke
   * Clinician revokes a pending invitation.
   */
  async revokeInvitation(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }
      const result = await consentInvitationService.revokeInvitation({
        invitationId: req.params.id,
        revokedByUserId: userId,
      });
      res.json({ success: true, invitation: result });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }
}

// Consent-authority determination
const setAuthoritySchema = z.object({
  mode: z.enum(["auto", "guardian_required", "self"]),
  basis: z
    .enum([
      "minor",
      "court_appointed_guardian",
      "limited_guardian",
      "supported_decision_making",
      "power_of_attorney",
    ])
    .nullish(),
  evidence: z.record(z.unknown()).nullish(),
  reviewDate: z.string().max(40).nullish(),
});

// Local helpers for the invitation endpoints
const createInvitationSchema = z.object({
  studentId: z.string().min(1),
  // Required for guardian invitations; omitted for self-consent.
  contactId: z.string().min(1).optional(),
  recipientType: z.enum(["guardian", "self"]).optional(),
  // Destination (student's own email/phone) for a self-consent invitation.
  selfDestination: z.string().min(1).max(320).optional(),
  sourceInstituteId: z.string().min(1),
  channel: z.enum(["email", "sms", "manual"]),
  ttlDays: z.number().int().positive().max(30).optional(),
});

const signWithTokenSchema = z.object({
  code: z.string().min(8).max(64),
  locale: z.string().min(2).max(10),
  consentTextVersion: z.string().min(1),
  consentTextHash: z.string().length(64),
  guardianFields: z
    .object({
      governmentIdNumber: z.string().min(1).max(40).optional(),
      governmentIdType: z.enum(["national_id", "passport", "driver_license", "other"]).optional(),
      governmentIdCountry: z.string().length(2).optional(),
      coGuardianAcknowledged: z.boolean().optional(),
    })
    .optional(),
  purposeAcknowledged: z.boolean(),
  voluntarinessAcknowledged: z.boolean(),
  thirdPartyTransfersAcknowledged: z.boolean(),
  optInModelTraining: z.boolean().optional(),
  optInAdvertising: z.boolean().optional(),
  optInThirdPartyResearch: z.boolean().optional(),
  optInMarketingComms: z.boolean().optional(),
  signature: signatureSchema,
  identityVerificationMethod: z.string().optional(),
  identityVerificationEvidence: z.record(z.unknown()).optional(),
  nonRepudiationMethod: z.string().optional(),
  nonRepudiationEvidence: z.record(z.unknown()).optional(),
  isSensitive: z.boolean().optional(),
});

const invitationErrorStatus: Record<ConsentInvitationErrorCode, number> = {
  contact_not_found: 404,
  contact_missing_channel: 400,
  recipient_type_mismatch: 409,
  self_destination_required: 400,
  student_not_found: 404,
  code_not_found: 404,
  code_expired: 410,
  code_already_used: 410,
  code_revoked: 410,
  permission_denied: 403,
  channel_unsupported: 400,
  phone_otp_required: 412,
  child_id_not_on_file: 400,
  child_id_verify_locked: 429,
  child_id_mismatch: 422,
  child_id_verification_required: 412,
};

const phoneOtpErrorStatus: Record<PhoneOtpErrorCode, number> = {
  phone_invalid: 400,
  rate_limited: 429,
  send_failed: 502,
  code_not_found: 404,
  code_expired: 410,
  code_already_used: 410,
  code_attempts_exceeded: 429,
  code_mismatch: 422,
};

function handleInvitationError(res: Response, err: unknown): void {
  if (err instanceof ConsentInvitationError) {
    res.status(invitationErrorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  if (err instanceof PhoneOtpError) {
    res.status(phoneOtpErrorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  if (err instanceof ConsentError) {
    res.status((errorStatus as any)[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  console.error("[ConsentController][invitation]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

const authorityErrorStatus: Record<ConsentAuthorityErrorCode, number> = {
  student_not_found: 404,
  invalid_mode: 400,
  invalid_basis: 400,
  guardianship_basis_required: 422,
};

function handleAuthorityError(res: Response, err: unknown): void {
  if (err instanceof ConsentAuthorityError) {
    res.status(authorityErrorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
    });
    return;
  }
  console.error("[ConsentController][authority]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

function getBaseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

export const consentController = new ConsentController();
