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
 *
 * ⚠️ **Open, reported 2026-09-10 (authorization structural pass, phase 1).**
 * Unlike `buildClinicianCtx`, the institute principal returned at the bottom of
 * this function is built from the caller-supplied `instituteId` WITHOUT
 * verifying membership — the exact shape that was closed on the HTTP path on
 * 2026-08-26. It is not currently reachable: both entry points
 * (`chatController` and `chatStreamController`) run
 * `instituteService.verifyMembership` on the body's `instituteId` before the
 * session is initialised, and the AAC/system-admin branches short-circuit
 * above. It was left alone deliberately rather than fixed blind, because the
 * obvious fix — returning `undefined` on a failed check — lands on a caller
 * whose documented contract for `undefined` is "skip the visibility filter",
 * i.e. it would trade a hypothetical forgery for a real fail-open. The right
 * shape is the discriminated result `clinicianCtx.ts` now uses; doing it needs
 * `sessionService`'s consumer changed in the same commit.
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
    // Carry the admin's id: their reads are audited (sharing/audit.ts) and an
    // anonymous "admin" row would defeat the point.
    return { kind: "admin", userId: userId ?? undefined };
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
