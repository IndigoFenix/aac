// server/services/consent/consentAuthorityService.ts
// Sets a student's consent-authority determination — who may consent on their
// behalf (a guardian or the student themselves). This is the override layer on
// top of the age-of-majority default resolved by shared/legal/consent-authority.
// See planning-docs/student-consent-onboarding-plan.md.

import { studentRepository } from "../../repositories/studentRepository.js";
import { activityLogService } from "../activityLogService.js";
import {
  computeAgeYears,
  getAgeOfMajority,
  resolveConsentAuthority,
  type ConsentAuthorityMode,
  type GuardianshipBasis,
} from "@shared/legal";

export type ConsentAuthorityErrorCode =
  | "student_not_found"
  | "invalid_mode"
  | "invalid_basis"
  | "guardianship_basis_required";

export class ConsentAuthorityError extends Error {
  readonly code: ConsentAuthorityErrorCode;
  constructor(code: ConsentAuthorityErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ConsentAuthorityError";
  }
}

const VALID_MODES: ReadonlySet<ConsentAuthorityMode> = new Set([
  "auto",
  "guardian_required",
  "self",
]);

const VALID_BASES: ReadonlySet<GuardianshipBasis> = new Set([
  "minor",
  "court_appointed_guardian",
  "limited_guardian",
  "supported_decision_making",
  "power_of_attorney",
]);

export interface SetConsentAuthorityInput {
  mode: ConsentAuthorityMode;
  /** Required when mode is "guardian_required" and the student is an adult. */
  basis?: GuardianshipBasis | null;
  /** Supporting evidence (court-order ref, issuing authority, notes). */
  evidence?: Record<string, unknown> | null;
  /** When the guardianship order should be re-reviewed / expires (YYYY-MM-DD). */
  reviewDate?: string | null;
}

class ConsentAuthorityService {
  async setConsentAuthority(
    studentId: string,
    input: SetConsentAuthorityInput,
    actingUserId: string | null,
  ) {
    if (!VALID_MODES.has(input.mode)) {
      throw new ConsentAuthorityError("invalid_mode", `Unknown consent-authority mode "${input.mode}"`);
    }
    if (input.basis != null && !VALID_BASES.has(input.basis)) {
      throw new ConsentAuthorityError("invalid_basis", `Unknown guardianship basis "${input.basis}"`);
    }

    const student = await studentRepository.getStudentById(studentId);
    if (!student) throw new ConsentAuthorityError("student_not_found");

    const isGuardianRequired = input.mode === "guardian_required";

    // An adult under guardianship must have a documented legal basis — adult
    // capacity is presumed, so guardianship must be a deliberate determination.
    if (isGuardianRequired && student.birthDate) {
      const country = (student.country ?? "IL").toUpperCase();
      const ageYears = computeAgeYears(new Date(student.birthDate));
      if (ageYears >= getAgeOfMajority(country) && !input.basis) {
        throw new ConsentAuthorityError(
          "guardianship_basis_required",
          "An adult under guardianship requires a recorded guardianship basis",
        );
      }
    }

    // Guardianship fields are only meaningful under "guardian_required"; clear
    // them otherwise so stale evidence doesn't linger on a self/auto student.
    const updated = await studentRepository.updateStudent(studentId, {
      consentAuthority: input.mode,
      guardianshipBasis: isGuardianRequired ? (input.basis ?? null) : null,
      guardianshipEvidence: isGuardianRequired ? (input.evidence ?? null) : null,
      guardianshipReviewDate: isGuardianRequired ? (input.reviewDate ?? null) : null,
      consentAuthoritySetByUserId: actingUserId,
      consentAuthoritySetAt: new Date(),
    } as Parameters<typeof studentRepository.updateStudent>[1]);

    activityLogService.log({
      userId: actingUserId ?? null,
      eventType: "consent_authority_set",
      subjectType1: "student",
      subjectId1: studentId,
      details: {
        mode: input.mode,
        basis: isGuardianRequired ? (input.basis ?? null) : null,
        hasEvidence: isGuardianRequired ? !!input.evidence : false,
        reviewDate: isGuardianRequired ? (input.reviewDate ?? null) : null,
      },
    });

    return updated;
  }

  /**
   * Resolve the current signer (guardian vs. self) for a student from its
   * stored authority + birth date. Returns null when birth date is missing
   * (the consent flow itself rejects that case with a clearer error).
   */
  async resolveForStudent(studentId: string) {
    const student = await studentRepository.getStudentById(studentId);
    if (!student || !student.birthDate) return null;
    const country = (student.country ?? "IL").toUpperCase();
    return resolveConsentAuthority({
      country,
      ageYears: computeAgeYears(new Date(student.birthDate)),
      authorityMode: (student.consentAuthority ?? "auto") as ConsentAuthorityMode,
      guardianshipBasis: (student.guardianshipBasis ?? null) as GuardianshipBasis | null,
    });
  }
}

export const consentAuthorityService = new ConsentAuthorityService();
