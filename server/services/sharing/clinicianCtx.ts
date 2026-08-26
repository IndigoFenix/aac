// server/services/sharing/clinicianCtx.ts
//
// Boundary helper for PHI controllers: builds the AccessCtx that the
// visibility helper consumes. Lives here (not on each controller) so the
// family-institute escalation rule is in exactly one place — see the
// `feedback_family_access_scoping.md` memory for why duplicating this is a
// recurring source of bugs.
//
// See planning-docs/cross-institute-sharing-plan.md.

import type { Request } from "express";
import { instituteService } from "../instituteService";
import type { AccessCtx } from "./visibility";

/**
 * Build the cross-institute visibility context from a clinician request.
 *
 * `instituteId` comes from `req.query.instituteId` (the "currently selected
 * institute" pattern) — and is VERIFIED: the caller must be a member of that
 * institute, or no institute principal is produced. Before 2026-08-26 the
 * value was trusted as given, so `?instituteId=<owner>` on any request made
 * the caller an "institute principal" of an institute they had never joined,
 * and every visibility predicate keyed on `ctx.instituteId` believed it.
 *
 * Family-institute escalation: when a parent/guardian selects their family
 * institute and views a student in that institute, the principal is escalated
 * to `student` (full visibility for that ward) — required by FERPA / Israeli
 * PPL parental access rights. Pass `studentId` to enable this lookup.
 *
 * Returns `undefined` when no institute is selected OR the caller is not a
 * member of it — callers then fall back to their direct access gate
 * (`verifyStudentAccess`) rather than applying a visibility filter for an
 * institute the caller cannot speak for.
 */
export async function buildClinicianCtx(
  req: Request,
  studentId?: string,
): Promise<AccessCtx | undefined> {
  const userId = (req.user as any)?.id;
  const instituteId =
    typeof req.query.instituteId === "string" ? req.query.instituteId : undefined;
  if (!userId || !instituteId) return undefined;

  const { isMember } = await instituteService.verifyMembership(instituteId, userId);
  if (!isMember) return undefined;

  if (studentId) {
    const institute = await instituteService.getInstituteById(instituteId);
    if (institute?.type === "family") {
      const studentInInstitute = await instituteService.isStudentInInstitute(instituteId, studentId);
      if (studentInInstitute) {
        return { kind: "student", studentId };
      }
    }
  }

  return { kind: "institute", instituteId, userId };
}
