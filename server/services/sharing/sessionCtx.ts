// server/services/sharing/sessionCtx.ts
//
// Boundary helper for the chat session — the AI's parallel to buildClinicianCtx.
// The AI reads/writes PHI via memory-schema DB ops, not via PHI controllers, so
// the visibility helper needs to be wired in at this second boundary too.
//
// See planning-docs/cross-institute-sharing-plan.md ("AI access" section).

import { instituteService } from "../instituteService";
import type { AccessCtx } from "./visibility";

export interface SessionCtxInput {
  userId?: string;
  studentId?: string;
  instituteId?: string;
  isAACFeature?: boolean;
  isSystemAdmin?: boolean;
}

/**
 * Build the AccessCtx for a chat session. Mirrors buildClinicianCtx but takes
 * the inputs that sessionService already has on hand (no Express Request).
 *
 * Order matters:
 *   1. AAC client → student principal (the AAC student IS the subject; cross-
 *      institute filtering does not apply).
 *   2. System admin → admin (audit/support).
 *   3. Family-institute escalation → student principal (FERPA / Israeli PPL
 *      parental rights), only when `studentId` is in scope.
 *   4. Otherwise → institute principal.
 *
 * Returns `undefined` when there's nothing usable (no userId AND not AAC).
 * Callers should treat that the same way the controllers do — preserve legacy
 * behavior by skipping the visibility filter.
 */
export async function buildSessionAccessCtx(
  input: SessionCtxInput,
): Promise<AccessCtx | undefined> {
  const { userId, studentId, instituteId, isAACFeature, isSystemAdmin } = input;

  if (isAACFeature) {
    if (!studentId) return undefined;
    return { kind: "student", studentId };
  }

  if (isSystemAdmin) {
    return { kind: "admin" };
  }

  if (!userId || !instituteId) return undefined;

  if (studentId) {
    const institute = await instituteService.getInstituteById(instituteId);
    if (institute?.type === "family") {
      const [{ isMember }, studentInInstitute] = await Promise.all([
        instituteService.verifyMembership(instituteId, userId),
        instituteService.isStudentInInstitute(instituteId, studentId),
      ]);
      if (isMember && studentInInstitute) {
        return { kind: "student", studentId };
      }
    }
  }

  return { kind: "institute", instituteId, userId };
}
