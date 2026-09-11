// server/services/sharing/clinicianCtx.ts
//
// Boundary helper for PHI controllers: builds the AccessCtx that the
// visibility helper consumes. Lives here (not on each controller) so the
// family-institute escalation rule is in exactly one place — see the
// `feedback_family_access_scoping.md` memory for why duplicating this is a
// recurring source of bugs.
//
// See planning-docs/cross-institute-sharing-plan.md.

import type { Request, Response } from "express";
import { instituteService } from "../instituteService";
import type { AccessCtx } from "./visibility";

/**
 * The outcome of resolving a clinician request's access context.
 *
 * 🚨 **Why this is a discriminated union and not `AccessCtx | undefined`.**
 * Until 2026-09-10 this helper returned `undefined` for BOTH "no institute is
 * selected" and "the caller named an institute they are not a member of", and
 * consumers read that one value in opposite directions:
 *
 *   - `packageController` read it as **deny** (400 `INSTITUTE_NOT_SELECTED`);
 *   - `customAppRepository.getAssignedAppIds` read it as **no filter** — the
 *     `ctx ? withInstituteVisibility(...) : eq(studentId)` shape, so a caller
 *     who named an institute they had never joined got the student's
 *     assignments with the cross-institute visibility rules switched OFF;
 *   - `reportController.requireOwningInstitute` read it as **allow**
 *     (`if (!ctx || ctx.kind !== "institute") return true`), i.e. the
 *     cross-institute WRITE gate opened.
 *
 * The AAC audit called this the "real recurring bug": one sentinel value, three
 * meanings, and the fail-open readings were invisible because they looked like
 * the deliberate legacy fallback. The two states are now separate variants, so
 * a consumer must SAY which one it is handling and `tsc` checks that it did.
 *
 * `no_institute_selected` is the legitimate legacy state — plenty of routes do
 * not carry `?instituteId=` and are governed by their own direct student gate.
 * `not_a_member` is never legitimate: it is a caller asserting an institute
 * context they do not hold, and every consumer refuses it.
 */
export type ClinicianCtxResult =
  /** A usable principal. */
  | { kind: "ctx"; ctx: AccessCtx }
  /** No `?instituteId=` on the request (or no authenticated user). Not an error. */
  | { kind: "no_institute_selected" }
  /** The caller named an institute they are not an active member of. Always a refusal. */
  | { kind: "not_a_member"; instituteId: string; userId: string };

/**
 * Resolve the cross-institute visibility context from a clinician request.
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
 * Membership is `instituteService.verifyMembership`, which since 2026-09-10 is
 * the row-bearing form of the one institute predicate pair — `isActive` is
 * checked and a customer-support session over the institute passes.
 */
export async function resolveClinicianCtx(
  req: Request,
  studentId?: string,
): Promise<ClinicianCtxResult> {
  const userId = (req.user as any)?.id;
  const instituteId =
    typeof req.query.instituteId === "string" && req.query.instituteId
      ? req.query.instituteId
      : undefined;
  if (!userId || !instituteId) return { kind: "no_institute_selected" };

  const { isMember } = await instituteService.verifyMembership(instituteId, userId);
  if (!isMember) return { kind: "not_a_member", instituteId, userId };

  if (studentId) {
    const institute = await instituteService.getInstituteById(instituteId);
    if (institute?.type === "family") {
      const studentInInstitute = await instituteService.isStudentInInstitute(instituteId, studentId);
      if (studentInInstitute) {
        return { kind: "ctx", ctx: { kind: "student", studentId } };
      }
    }
  }

  return { kind: "ctx", ctx: { kind: "institute", instituteId, userId } };
}

/** The body every refusal on this path answers with. Kept identical across
 *  consumers so a refusal does not say which gate refused. */
const NOT_A_MEMBER_BODY = { error: "error:NOT_INSTITUTE_MEMBER" } as const;

/**
 * Controller helper for routes whose own gate already ran and that use the ctx
 * only as a cross-institute VISIBILITY REFINEMENT (programs, reports,
 * incidents, deep analysis).
 *
 * Returns `{ ok: true, ctx }` where `ctx` is `undefined` when no institute is
 * selected — the legacy behaviour, correct because the caller's direct student
 * gate governs that request. Returns `{ ok: false }` after sending 403 when the
 * caller named an institute they are not a member of; that request has asserted
 * a context it does not hold and is refused rather than silently unfiltered.
 */
export async function visibilityCtx(
  req: Request,
  res: Response,
  studentId?: string,
): Promise<{ ok: true; ctx: AccessCtx | undefined } | { ok: false }> {
  const result = await resolveClinicianCtx(req, studentId);
  switch (result.kind) {
    case "ctx":
      return { ok: true, ctx: result.ctx };
    case "no_institute_selected":
      return { ok: true, ctx: undefined };
    case "not_a_member":
      res.status(403).json(NOT_A_MEMBER_BODY);
      return { ok: false };
  }
}

/**
 * Controller helper for routes that CANNOT work without an institute principal
 * (packages, custom-app assignment visibility).
 *
 * Returns the ctx, or `null` after sending the refusal: 403 when the caller
 * named an institute they are not a member of, 400
 * `error:INSTITUTE_NOT_SELECTED` when none was named at all. Those two were the
 * same 400 before 2026-09-10, which is what let "not a member" read as a
 * client-side omission.
 */
export async function requireInstituteCtx(
  req: Request,
  res: Response,
  studentId?: string,
): Promise<AccessCtx | null> {
  const result = await resolveClinicianCtx(req, studentId);
  switch (result.kind) {
    case "ctx":
      return result.ctx;
    case "no_institute_selected":
      res.status(400).json({ error: "error:INSTITUTE_NOT_SELECTED" });
      return null;
    case "not_a_member":
      res.status(403).json(NOT_A_MEMBER_BODY);
      return null;
  }
}

/**
 * @deprecated Ambiguous by construction — collapses "no institute selected" and
 * "not a member" into one `undefined`, which is the bug documented on
 * {@link ClinicianCtxResult}. Use {@link visibilityCtx} or
 * {@link requireInstituteCtx}; reach for {@link resolveClinicianCtx} when
 * neither response shape fits.
 *
 * Retained only for `boardController` and `incidentController`, whose refusal
 * shapes are being reworked in the student half of this pass. Neither is a live
 * hole: both run their own student gate first, so the worst case there is a
 * dropped cross-institute refinement on a caller who already has direct access.
 */
export async function buildClinicianCtx(
  req: Request,
  studentId?: string,
): Promise<AccessCtx | undefined> {
  const result = await resolveClinicianCtx(req, studentId);
  return result.kind === "ctx" ? result.ctx : undefined;
}
