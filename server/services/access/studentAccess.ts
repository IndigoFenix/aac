// server/services/access/studentAccess.ts
//
// ═════════════════════════════════════════════════════════════════════════════
// STUDENT AUTHORIZATION — the named policies, in one place
// ═════════════════════════════════════════════════════════════════════════════
//
// The 2026-09-10 authorization audit counted **21 distinct implementations** of
// "may this user touch this institute / student", three of them literally named
// `requireStudentAccess` and two named `assertStudentAccess`. The defect class
// was never "a check was written wrong"; it was "there is no single place a
// check lives, so each one is written again, and some are written wrong."
//
// This module is that place for the STUDENT half. It changes WHERE the checks
// live, never WHO is allowed.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO POLICIES. THEY ARE NOT THE SAME POLICY, AND MERGING THEM IS A BUG.
// ─────────────────────────────────────────────────────────────────────────────
//
//   studentAccess(studentId, userId)          — THE BROAD POLICY
//       active `user_students` link
//     ∨ ANY MEMBER of a `family` institute the student is enrolled in
//     ∨ ADMIN of a `school`/`clinic` institute the student is enrolled in
//
//   sharesInstituteWithStudent(principal, studentId)  — INSTITUTE OVERLAP ONLY
//       system admin
//     ∨ the caller is in ANY institute the student is actively enrolled in
//
// They are not nested in either direction:
//   • A family-institute MEMBER passes `studentAccess`… and also passes
//     `sharesInstituteWithStudent` (they share the family institute).
//   • A plain STAFF member of a school passes `sharesInstituteWithStudent` but
//     FAILS `studentAccess` (school/clinic needs admin, not membership).
//   • A caller with only a `user_students` link and NO shared institute passes
//     `studentAccess` and FAILS `sharesInstituteWithStudent`.
//   • A SYSTEM ADMIN passes `sharesInstituteWithStudent` unconditionally and is
//     NOT special-cased by `studentAccess` at all.
// The original structural plan proposed collapsing the ad-hoc `verifyStudentAccess`
// wrappers onto the consent predicate. That would have changed who is allowed —
// in BOTH directions — on the board, caretaker-PIN, incident and voice surfaces.
// So: two policies, two names, one implementation each.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🚨 THE CAST-FREE RULE (docs/SECURITY_ARCHITECTURE.md §2.4, §5.5.1)
// ─────────────────────────────────────────────────────────────────────────────
//
//   instituteRepository.getInstitutesByUserId   → Institute[]
//   instituteRepository.getInstitutesByStudentId → { institute, enrollment }[]
//
// Four separate copies of the overlap check read the STUDENT rows as if they
// were bare institutes (`m.id`), which is `undefined`. `Set.has(undefined)` is
// false for every caller, so the gate denied everyone — including the patient's
// own clinician — for 4.5 months while reading as correct. An `(m: any)` cast is
// what hid the mismatch from `tsc`.
//
// Every body in this file that walks enrolments therefore destructures
// `{ institute }` and contains NO cast whatsoever. Do not add one. If the
// compiler complains about a shape here, the compiler is right.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT DELIBERATELY LIVES ELSEWHERE (do not fold these in)
// ─────────────────────────────────────────────────────────────────────────────
//  • `callContacts.userMayActAsStudent`      — a CALLING right (link ∨ active
//                                              *callable* contact row).
//  • `services/packages/packageAccess.ts`    — separate per §1.2.1.
//  • `studentService.getStudentLinkAuthority`— link/unlink AUTHORITY (§5.5.1).
//  • `studentRepository.getStudentsForUserInInstitute` — a THIRD, wider rule
//    that also grants via a SHARED CLASSROOM. Nothing else in the codebase
//    does. It is a list query, not a predicate; left where it is.
//  • `recognition-service.getPersonFaceImageUrlForStudent` — a SQL-level
//    restatement of "is this person one of this student's people".
//  • `instituteService.checkStudentAccess`   — the institute half's file.

import type { Request, Response } from "express";
import type { StudentContact, UserStudent } from "@shared/schema";
import type { StudentWithAacSettings } from "@shared/schema";

import { studentService } from "../studentService";
import { studentRepository } from "../../repositories/studentRepository";
import { instituteRepository } from "../../repositories/instituteRepository";

// ═════════════════════════════════════════════════════════════════════════════
// The principal
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The only two facts any policy here reads off the caller. Kept structural
 * (rather than `Express.User`) so the policies are callable — and testable —
 * without an HTTP request.
 */
export interface AccessPrincipal {
  id?: string;
  isSystemAdmin?: boolean;
}

/** Lift `req.user` into a principal. The only place these fields are read. */
export function principalFromRequest(req: Request): AccessPrincipal | undefined {
  return req.user as AccessPrincipal | undefined;
}

// ═════════════════════════════════════════════════════════════════════════════
// POLICY 1 — `studentAccess`: the broad "may this caller act for this student"
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What `studentAccess` answers.
 *
 * 🚨 `student` is present ONLY when `hasAccess` is true. That is a deliberate
 * difference from `studentService.verifyStudentAccess`, which returns the row
 * even when it denies (clinical audit, pattern 6). No caller was misusing it,
 * but a result object that hands you PHI alongside `hasAccess: false` invites
 * exactly one kind of mistake, and the type is the cheapest place to make that
 * mistake impossible. `verifyStudentAccess` itself is UNCHANGED — this is a
 * property of the new surface, so nothing that has not moved can be affected.
 */
export type StudentAccessResult =
  | {
      hasAccess: true;
      student: StudentWithAacSettings;
      link?: UserStudent;
      hasMedicalRights: boolean;
      hasEducationalRights: boolean;
    }
  | {
      hasAccess: false;
      student?: undefined;
      link?: undefined;
      hasMedicalRights: false;
      hasEducationalRights: false;
    };

/**
 * THE BROAD POLICY. Active `user_students` link ∨ any member of a `family`
 * institute the student is enrolled in ∨ admin of a `school`/`clinic` institute
 * they are enrolled in.
 *
 * This WRAPS `studentService.verifyStudentAccess` rather than replacing it.
 * Wrapping is the conservative choice: the rule keeps exactly one
 * implementation (so it cannot drift), callers can move one at a time, and the
 * ~60 call sites that have NOT moved keep byte-identical behaviour. The only
 * thing the wrapper adds is the denial-side narrowing described above.
 *
 * Support mode needs no special case anywhere: `verifyStudentAccess` reaches
 * `instituteRepository.isUserAdminOfInstitute`, which already short-circuits on
 * the AsyncLocalStorage support institute.
 *
 * @param instituteId  Optional narrowing — when given, only that institute's
 *                     enrolment may justify access. The direct `user_students`
 *                     link is checked first and is NOT narrowed by it.
 */
export async function studentAccess(
  studentId: string,
  userId: string,
  opts: { instituteId?: string } = {},
): Promise<StudentAccessResult> {
  const result = await studentService.verifyStudentAccess(studentId, userId, opts.instituteId);
  if (!result.hasAccess || !result.student) {
    return { hasAccess: false, hasMedicalRights: false, hasEducationalRights: false };
  }
  return {
    hasAccess: true,
    student: result.student,
    link: result.link,
    hasMedicalRights: result.hasMedicalRights,
    hasEducationalRights: result.hasEducationalRights,
  };
}

/**
 * Null-safe boolean form of `studentAccess`, for call sites that only branch.
 *
 * ⚠️ A missing student id is DENIED here. That is `boardController`'s existing
 * rule (a board with no `studentId` is not a student-scoped board, so student
 * access cannot justify it) and it is the opposite of `voiceController`'s rule
 * for a *request* with no student id — see `allowNoStudent` below. The two are
 * different questions, so they get different entry points rather than one
 * function whose answer depends on how you squint at `undefined`.
 */
export async function hasStudentAccess(
  studentId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!studentId || !userId) return false;
  const { hasAccess } = await studentAccess(studentId, userId);
  return hasAccess;
}

// ═════════════════════════════════════════════════════════════════════════════
// POLICY 2 — `sharesInstituteWithStudent`: institute overlap only
// ═════════════════════════════════════════════════════════════════════════════

/**
 * True when the caller may read this student's consent surface: a system admin
 * always passes, anyone else must share an ACTIVE institute with the student.
 *
 * Promoted verbatim out of `consentController.userSharesInstituteWithStudent`
 * (2026-09-09). It is NOT `studentAccess` and must never be made to be: this
 * policy admits a plain school STAFF member (no admin, no link) and refuses a
 * linked caregiver who shares no institute. Both differences are load-bearing —
 * see the header.
 *
 * 🚨 Cast-free by design. `getInstitutesByStudentId` returns
 * `{ institute, enrollment }` rows; destructure `{ institute }` and let `tsc`
 * catch a recurrence of the `m.id` bug (§2.4).
 */
export async function sharesInstituteWithStudent(
  principal: AccessPrincipal | undefined,
  studentId: string,
): Promise<boolean> {
  if (principal?.isSystemAdmin) return true;
  const userId = principal?.id;
  if (!userId) return false;

  const [enrollments, userInstitutes] = await Promise.all([
    instituteRepository.getInstitutesByStudentId(studentId),
    instituteRepository.getInstitutesByUserId(userId),
  ]);
  const userInstituteIds = new Set(userInstitutes.map((institute) => institute.id));
  return enrollments.some(({ institute }) => userInstituteIds.has(institute.id));
}

/**
 * True when the caller administers one of the STUDENT's institutes (or is a
 * system admin). Promoted out of `consentController.userIsAdminForStudent`.
 *
 * The direction of the derivation is the whole rule (§5.5.1): candidate
 * institutes come from the student's active enrolments, never from an institute
 * id the caller supplied. Proving the caller administers an institute they
 * named, without proving the STUDENT belongs to it, proves nothing — every
 * admin administers *some* institute.
 *
 * 🚨 The same shape trap: `isUserAdminOfInstitute` was being handed `undefined`
 * as the institute id, whose first line is
 * `if (getActiveSupportInstituteId() === instituteId) return true` — and that
 * helper returns `undefined` outside a support session, so
 * `undefined === undefined` granted institute-admin to the caller. Passing
 * `institute.id` off a destructured row is what makes that impossible; do not
 * reintroduce an `any`.
 */
export async function administersStudentInstitute(
  principal: AccessPrincipal | undefined,
  studentId: string,
): Promise<boolean> {
  if (principal?.isSystemAdmin) return true;
  const userId = principal?.id;
  if (!userId) return false;

  const enrollments = await instituteRepository.getInstitutesByStudentId(studentId);
  for (const { institute } of enrollments) {
    if (await instituteRepository.isUserAdminOfInstitute(institute.id, userId)) return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// POLICY 3 — the wizard-context union (a THIRD named policy, not a variant)
// ═════════════════════════════════════════════════════════════════════════════

/** Which of the three predicates admitted a wizard-context caller. */
export type WizardContextGrant = "institute" | "guardian_contact" | "user_student";

/**
 * WIZARD-CONTEXT ACCESS (2026-09-10) — the gate for `/wizard-context`'s DEFAULT
 * path, which until that date checked only that the caller was authenticated
 * and so returned any student's name, birth date, country and active consent
 * record to every account on the platform.
 *
 * It is NOT `sharesInstituteWithStudent`, and that is the whole point. Institute
 * overlap alone would refuse a legitimate signer, because the people this
 * endpoint exists to serve are the people `POST /sign` admits — and `/sign`
 * admits exactly two kinds of caller, NEITHER of which is "institute member":
 *   - guardian sign → a `student_contacts` row whose `linked_user_id` is the
 *     caller (`contact_not_owned_by_caller` otherwise), and
 *   - self sign     → an ACTIVE `user_students` link (a family account whose
 *     student may be enrolled in no institute at all).
 * A read gate narrower than the write it prepares would refuse a signer the
 * context of the consent they are entitled to sign, so the union is the rule:
 * institute overlap **or** linked contact **or** user-student link. It is a
 * union of predicates that already exist, not a fourth predicate.
 *
 * ⚠️ This does NOT serve the magic-link guardian. That parent has no session at
 * all and never reaches this endpoint: `ConsentSignPage` renders the wizard in
 * token mode, which resolves its context through the PUBLIC
 * `POST /api/consent/invitations/redeem` and signs through `/invitations/sign`.
 *
 * The `?contactId=` variant is deliberately NOT routed through this — naming
 * another person's contact row stays on `assertSharesInstituteWithStudent`, so
 * the param can never widen what a bare session sees.
 *
 * @param guardianContact The caller's OWN linked guardian contact, already
 *   loaded by the handler for the response body. A row can only come back when
 *   `linked_user_id` IS the caller, so its mere presence is the grant.
 */
export async function wizardContextGrantFor(
  principal: AccessPrincipal | undefined,
  studentId: string,
  guardianContact: StudentContact | null,
): Promise<WizardContextGrant | null> {
  const userId = principal?.id;
  if (!userId) return null;
  // Free: the handler needs this row either way.
  if (guardianContact) return "guardian_contact";
  if (await sharesInstituteWithStudent(principal, studentId)) return "institute";
  const { hasAccess } = await studentRepository.userHasAccessToStudent(userId, studentId);
  return hasAccess ? "user_student" : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP adapters — one policy, several response shapes
// ═════════════════════════════════════════════════════════════════════════════
//
// The four ad-hoc wrappers this module absorbed differed ONLY in the bytes they
// wrote on refusal (`error:AUTH_REQUIRED` vs `"Authentication required"` vs
// `"Unauthenticated"`, and three different 403 bodies). Response shape is a
// property of the API surface, not of the policy, so the shape stays with the
// caller and the rule stops being re-typed. Every adapter below resolves
// permission BEFORE any resource lookup, so a refused caller cannot tell a real
// student id from an invented one.

/** The two bodies a caller wants written when it refuses. */
export interface StudentAccessDenialShape {
  /** Body for the 401 (no session). */
  unauthenticated: unknown;
  /** Body for the 403 (session, but not this student). */
  forbidden: unknown;
}

export interface RequireStudentAccessOptions {
  shape: StudentAccessDenialShape;
  /**
   * When true, a request carrying NO student id passes on a valid session
   * alone. ONLY `voiceController` wants this: generic text-to-speech has no
   * student, and refusing it would break the feature. Default false — an
   * absent student id is a 403 everywhere else.
   */
  allowNoStudent?: boolean;
  /** Narrow the institute-derived half of the policy. See `studentAccess`. */
  instituteId?: string;
}

/**
 * Response-writing form of `studentAccess` (THE BROAD POLICY).
 *
 * Returns the caller's userId when they may act on the student; otherwise
 * writes the 401/403 and returns `undefined`. Replaces four separately-written
 * copies: `boardController.hasStudentAccess`,
 * `caretakerPinController.requireStudentAccess`,
 * `incidentController.requireStudentAccess` (byte-equivalent to the caretaker
 * one) and `voiceController.assertStudentAccess`.
 */
export async function requireStudentAccess(
  req: Request,
  res: Response,
  studentId: string | null | undefined,
  opts: RequireStudentAccessOptions,
): Promise<string | undefined> {
  const userId = principalFromRequest(req)?.id;
  if (!userId) {
    res.status(401).json(opts.shape.unauthenticated);
    return undefined;
  }
  if (!studentId) {
    if (opts.allowNoStudent) return userId;
    res.status(403).json(opts.shape.forbidden);
    return undefined;
  }
  const { hasAccess } = await studentAccess(studentId, userId, { instituteId: opts.instituteId });
  if (!hasAccess) {
    res.status(403).json(opts.shape.forbidden);
    return undefined;
  }
  return userId;
}

/** The 401/403 bodies every student-scoped CONSENT endpoint answers with. */
const CONSENT_DENIAL: StudentAccessDenialShape = {
  unauthenticated: { success: false, message: "Unauthenticated" },
  forbidden: {
    success: false,
    code: "permission_denied",
    message: "No access to that student",
  },
};

/**
 * The ONE gate for every student-scoped consent read (`/active`, `/history`,
 * `/authority`, `/invitations`). Answers 401/403 itself; returns false when the
 * handler must stop.
 *
 * Formerly `consentController.assertStudentAccess`. Renamed on promotion: the
 * audit's central complaint is that two functions were named
 * `assertStudentAccess` and three `requireStudentAccess` while implementing
 * different rules. The name now says which policy it enforces.
 */
export async function assertSharesInstituteWithStudent(
  req: Request,
  res: Response,
  studentId: string,
): Promise<boolean> {
  const principal = principalFromRequest(req);
  if (!principal?.id) {
    res.status(401).json(CONSENT_DENIAL.unauthenticated);
    return false;
  }
  if (!(await sharesInstituteWithStudent(principal, studentId))) {
    res.status(403).json(CONSENT_DENIAL.forbidden);
    return false;
  }
  return true;
}

/**
 * Response-writing form of `wizardContextGrantFor`. Answers with the SAME
 * 401/403 bodies as `assertSharesInstituteWithStudent` so a refused caller
 * cannot tell which of the two gates refused them, and — because the handler
 * consults this BEFORE it reads the student row — cannot tell an existing
 * student from an invented id either.
 */
export async function assertWizardContextAccess(
  req: Request,
  res: Response,
  studentId: string,
  guardianContact: StudentContact | null,
): Promise<boolean> {
  const principal = principalFromRequest(req);
  if (!principal?.id) {
    res.status(401).json(CONSENT_DENIAL.unauthenticated);
    return false;
  }
  if (!(await wizardContextGrantFor(principal, studentId, guardianContact))) {
    res.status(403).json(CONSENT_DENIAL.forbidden);
    return false;
  }
  return true;
}
