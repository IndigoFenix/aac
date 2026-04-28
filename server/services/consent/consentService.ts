// server/services/consent/consentService.ts
// Service layer for student informed-consent transactions.
// See planning-docs/student-consent-onboarding-plan.md.

import { createHash } from "node:crypto";

import { studentConsentRecordRepository } from "../../repositories/studentConsentRecordRepository.js";
import { studentRepository } from "../../repositories/studentRepository.js";
import { db } from "../../db.js";
import { eq } from "drizzle-orm";
import { studentContacts, type StudentConsentRecord } from "@shared/schema";

import {
  resolveMinorProtection,
  computeAgeYears,
  resolveIdvRegimeContext,
  checkIdvAcceptability,
  isKnownIdvMethod,
  lookupConsentNotice,
  renderNoticeForHashing,
  type ConsentRecipientCategory,
  type OptInType,
  type IdvAcceptabilityResult,
} from "@shared/legal";

import { activityLogService } from "../activityLogService.js";
import { studentShareInviteService } from "../sharing/studentShareInviteService.js";
// dual-agent-service is loaded lazily — its transitive imports (LLM provider
// modules using import.meta.url) don't load cleanly under Jest's CJS runtime.

export type ConsentErrorCode =
  | "student_not_found"
  | "student_missing_birth_date"
  | "contact_not_found"
  | "contact_not_for_student"
  | "contact_not_legal_guardian"
  | "disclosures_required"
  | "notice_not_found"
  | "notice_version_mismatch"
  | "notice_hash_mismatch"
  | "idv_unknown_method"
  | "idv_not_acceptable"
  | "consent_not_found"
  | "consent_already_revoked";

export class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ConsentErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}

export interface SignConsentInput {
  studentId: string;
  signedByContactId: string;

  /** UI locale; used to pick the localized notice variant. */
  locale: string;
  /** Version the UI rendered. Must match the active version for the country. */
  consentTextVersion: string;
  /**
   * Hash of the notice the UI rendered. Must match the server-computed hash
   * over the same content. Defends against UI/server drift — if the user
   * saw a different notice than the server thinks, we refuse the sign.
   */
  consentTextHash: string;

  /** Recipients disclosed to the parent at signing, captured by the UI. */
  thirdPartyRecipients: ReadonlyArray<ConsentRecipientCategory>;

  /** All three required disclosures must be true. */
  purposeAcknowledged: boolean;
  voluntarinessAcknowledged: boolean;
  thirdPartyTransfersAcknowledged: boolean;

  /** Opt-ins — forced off where regime requires; UI submission is advisory. */
  optInModelTraining?: boolean;
  optInAdvertising?: boolean;
  optInThirdPartyResearch?: boolean;
  optInMarketingComms?: boolean;

  /** Identity verification + non-repudiation pair (PPA Feb-2026). */
  identityVerificationMethod: string;
  identityVerificationEvidence: Record<string, unknown>;
  nonRepudiationMethod: string;
  nonRepudiationEvidence: Record<string, unknown>;

  /** Whether the data being collected is sensitive (default true for SLP/AAC). */
  isSensitive?: boolean;

  /** Audit-trail context. */
  signedFromIp?: string | null;
  signedFromUserAgent?: string | null;
  /**
   * When the signing flow runs as the parent's authenticated session,
   * this is their userId. Used for activity log attribution; stored on
   * the user evidence jsonb when the IDV method is authenticated_session.
   */
  actingUserId?: string | null;
}

const OPT_IN_TO_FIELD: Record<OptInType, keyof Pick<
  SignConsentInput,
  "optInModelTraining" | "optInAdvertising" | "optInThirdPartyResearch" | "optInMarketingComms"
>> = {
  model_training: "optInModelTraining",
  advertising: "optInAdvertising",
  third_party_research: "optInThirdPartyResearch",
  marketing_comms: "optInMarketingComms",
};

class ConsentService {
  async signConsent(input: SignConsentInput): Promise<StudentConsentRecord> {
    // 1. Required disclosures
    if (!input.purposeAcknowledged || !input.voluntarinessAcknowledged || !input.thirdPartyTransfersAcknowledged) {
      throw new ConsentError("disclosures_required", "All three required disclosures must be acknowledged");
    }

    // 2. Student lookup → country + age
    const student = await studentRepository.getStudentById(input.studentId);
    if (!student) throw new ConsentError("student_not_found");
    if (!student.birthDate) {
      throw new ConsentError("student_missing_birth_date", "Student has no birth date — cannot compute minor-protection regime");
    }
    const country = (student.country ?? "IL").toUpperCase();
    const ageAtSigningYears = computeAgeYears(new Date(student.birthDate));

    // 3. Contact validation
    const [contact] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, input.signedByContactId));
    if (!contact) throw new ConsentError("contact_not_found");
    if (contact.studentId !== input.studentId) {
      throw new ConsentError("contact_not_for_student");
    }
    if (!contact.isLegalGuardian) {
      throw new ConsentError("contact_not_legal_guardian");
    }

    // 4. Notice lookup + hash check
    const notice = lookupConsentNotice({
      country,
      locale: input.locale,
      version: input.consentTextVersion,
    });
    if (!notice) {
      throw new ConsentError("notice_not_found", undefined, {
        country, locale: input.locale, version: input.consentTextVersion,
      });
    }
    if (notice.version !== input.consentTextVersion) {
      throw new ConsentError("notice_version_mismatch", undefined, {
        requested: input.consentTextVersion, resolved: notice.version,
      });
    }
    const renderedHash = createHash("sha256")
      .update(renderNoticeForHashing(notice.content))
      .digest("hex");
    if (renderedHash !== input.consentTextHash) {
      throw new ConsentError("notice_hash_mismatch", undefined, {
        client: input.consentTextHash, server: renderedHash,
      });
    }

    // 5. Minor-protection regime
    const minor = resolveMinorProtection(country, ageAtSigningYears);

    // 6. IDV acceptability
    if (!isKnownIdvMethod(input.identityVerificationMethod)) {
      throw new ConsentError("idv_unknown_method", undefined, {
        method: input.identityVerificationMethod, leg: "identity",
      });
    }
    if (!isKnownIdvMethod(input.nonRepudiationMethod)) {
      throw new ConsentError("idv_unknown_method", undefined, {
        method: input.nonRepudiationMethod, leg: "non_repudiation",
      });
    }
    const idvRegime = resolveIdvRegimeContext({
      country,
      minorRegime: minor.regime,
      isSensitive: input.isSensitive ?? true,
    });
    const idvCheck: IdvAcceptabilityResult = checkIdvAcceptability({
      identityMethod: input.identityVerificationMethod,
      nonRepudiationMethod: input.nonRepudiationMethod,
      regime: idvRegime,
    });
    if (!idvCheck.acceptable) {
      throw new ConsentError("idv_not_acceptable", undefined, {
        regime: idvRegime,
        reason: idvCheck.reason,
        identityMethod: input.identityVerificationMethod,
        nonRepudiationMethod: input.nonRepudiationMethod,
      });
    }

    // 7. Apply opt-in forcing
    const submitted = {
      model_training: !!input.optInModelTraining,
      advertising: !!input.optInAdvertising,
      third_party_research: !!input.optInThirdPartyResearch,
      marketing_comms: !!input.optInMarketingComms,
    } satisfies Record<OptInType, boolean>;

    let optInsForcedOff = false;
    const finalOptIns: Record<OptInType, boolean> = { ...submitted };
    for (const opt of minor.forcedOffOptIns) {
      if (finalOptIns[opt]) optInsForcedOff = true;
      finalOptIns[opt] = false;
    }

    // 8. Insert
    const inserted = await studentConsentRecordRepository.create({
      studentId: input.studentId,
      signedByContactId: input.signedByContactId,
      country,
      ageAtSigningYears,
      isMinorEnhancedProtection: minor.isApplicable,
      enhancedProtectionRegime: minor.regime,
      consentTextVersion: notice.version,
      consentTextHash: renderedHash,
      thirdPartyRecipients: input.thirdPartyRecipients as unknown as Record<string, unknown>[],
      purposeAcknowledged: input.purposeAcknowledged,
      voluntarinessAcknowledged: input.voluntarinessAcknowledged,
      thirdPartyTransfersAcknowledged: input.thirdPartyTransfersAcknowledged,
      optInModelTraining: finalOptIns.model_training,
      optInAdvertising: finalOptIns.advertising,
      optInThirdPartyResearch: finalOptIns.third_party_research,
      optInMarketingComms: finalOptIns.marketing_comms,
      optInsForcedOff,
      identityVerificationMethod: input.identityVerificationMethod,
      identityVerificationEvidence: input.identityVerificationEvidence,
      nonRepudiationMethod: input.nonRepudiationMethod,
      nonRepudiationEvidence: input.nonRepudiationEvidence,
      signedFromIp: input.signedFromIp ?? null,
      signedFromUserAgent: input.signedFromUserAgent ?? null,
    });

    // 9. Audit
    activityLogService.log({
      userId: input.actingUserId ?? null,
      eventType: "consent_signed",
      subjectType1: "consent_record",
      subjectId1: inserted.id,
      subjectType2: "student",
      subjectId2: input.studentId,
      details: {
        country,
        regime: minor.regime,
        consentTextVersion: notice.version,
        identityVerificationMethod: input.identityVerificationMethod,
        nonRepudiationMethod: input.nonRepudiationMethod,
        optIns: finalOptIns,
        optInsForcedOff,
        signedByContactId: input.signedByContactId,
      },
    });

    return inserted;
  }

  async revokeConsent(args: {
    consentId: string;
    revokedByUserId: string;
    reason?: string;
  }): Promise<StudentConsentRecord> {
    const existing = await studentConsentRecordRepository.getById(args.consentId);
    if (!existing) throw new ConsentError("consent_not_found");
    if (existing.revokedAt) throw new ConsentError("consent_already_revoked");

    const revoked = await studentConsentRecordRepository.revoke(args.consentId, {
      revokedByUserId: args.revokedByUserId,
      reason: args.reason,
    });
    if (!revoked) {
      // Race: someone else revoked between our read and write.
      throw new ConsentError("consent_already_revoked");
    }

    activityLogService.log({
      userId: args.revokedByUserId,
      eventType: "consent_revoked",
      subjectType1: "consent_record",
      subjectId1: args.consentId,
      subjectType2: "student",
      subjectId2: existing.studentId,
      details: {
        reason: args.reason ?? null,
        priorVersion: existing.consentTextVersion,
        priorRegime: existing.enhancedProtectionRegime,
      },
    });

    // Cascade: revoking baseline consent invalidates every share the
    // student previously authorized. Each per-grant revoke logs its own
    // activity entry with details.cascade_reason='consent_revoked'.
    // Failures here are non-fatal — the consent record is already revoked.
    try {
      await studentShareInviteService.cascadeRevokeAllForStudent(
        existing.studentId,
        args.revokedByUserId,
        "consent_revoked",
      );
    } catch (err) {
      console.error("[consentService] Cascade share revocation failed:", err);
    }

    // Force-close any in-flight AAC sessions for this student. Each
    // termination logs its own activity entry. Lazily imported to keep
    // consent-service-only callers (and tests) from loading the dual-agent
    // module chain. Non-fatal on error.
    try {
      const { dualAgentService } = await import("../dual-agent/dual-agent-service.js");
      const terminated = dualAgentService.terminateSessionsForStudent(
        existing.studentId,
        args.revokedByUserId,
        "consent_revoked",
      );
      if (terminated > 0) {
        console.log(`[consentService] Terminated ${terminated} active AAC session(s) for student ${existing.studentId}`);
      }
    } catch (err) {
      console.error("[consentService] AAC session termination failed:", err);
    }

    return revoked;
  }

  async getActiveConsent(studentId: string): Promise<StudentConsentRecord | null> {
    return (await studentConsentRecordRepository.getActiveForStudent(studentId)) ?? null;
  }

  async hasActiveConsent(studentId: string): Promise<boolean> {
    return !!(await studentConsentRecordRepository.getActiveForStudent(studentId));
  }

  async getActiveConsents(studentIds: string[]): Promise<Map<string, StudentConsentRecord>> {
    return studentConsentRecordRepository.getActiveForStudents(studentIds);
  }

  async listHistory(studentId: string): Promise<StudentConsentRecord[]> {
    return studentConsentRecordRepository.listHistoryForStudent(studentId);
  }
}

export const consentService = new ConsentService();
