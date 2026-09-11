/**
 * THE NAMED STUDENT-ACCESS POLICIES — admit/deny pins.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * The 2026-09-10 authorization audit counted 21 distinct implementations of
 * "may this user touch this student", three named `requireStudentAccess` and two
 * named `assertStudentAccess`. `server/services/access/` collapses the STUDENT
 * half onto a small set of NAMED policies — and the structural plan's own risk
 * control is that the module lands with its tests BEFORE any call site moves.
 *
 * The single most dangerous mistake available here is merging two policies that
 * look alike. They are not alike, and this file's job is to make the difference
 * a failing test rather than a comment:
 *
 *                                studentAccess   sharesInstitute   administers
 *   owner (link, no institute)        ✅               ❌              ❌
 *   school STAFF (member only)        ❌               ✅              ❌
 *   school ADMIN                      ✅               ✅              ✅
 *   family institute MEMBER           ✅               ✅              ❌
 *   admin of an UNENROLLED institute  ❌               ❌              ❌
 *   SYSTEM ADMIN                      ❌               ✅              ✅
 *   stranger                          ❌               ❌              ❌
 *
 * Two of those rows are the entire reason the original plan step ("collapse the
 * wrappers onto the consent predicate") was rejected: doing so would have
 * ADMITTED every school staff member to the board / caretaker-PIN / incident /
 * voice surfaces, and REFUSED every linked caregiver whose student is enrolled
 * nowhere.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import {
  makeUser,
  makeStudent,
  makeInstitute,
  addUserToInstitute,
  instituteRepository,
} from '../helpers/factories.js';
import { studentContacts, type StudentContact } from '@shared/schema';
import {
  studentAccess,
  hasStudentAccess,
  requireStudentAccess,
  sharesInstituteWithStudent,
  administersStudentInstitute,
  wizardContextGrantFor,
  assertSharesInstituteWithStudent,
  assertWizardContextAccess,
  principalFromRequest,
} from '../../services/access/index.js';

/**
 * The world every case runs in.
 *
 *   student      — owned by `owner`; enrolled in `school` AND `family`
 *   owner        — active `user_students` owner link; member of NO institute
 *   schoolAdmin  — created `school` (type school), therefore its admin
 *   staff        — member of `school`, NOT an admin
 *   familyAdmin  — created `family` (type family), therefore its admin
 *   familyMember — member of `family`, NOT an admin
 *   clinicAdmin  — admin of `clinic`, which the student is NOT enrolled in
 *   stranger     — nothing at all
 *   sysadmin     — `isSystemAdmin`, no institute, no link
 */
async function buildWorld() {
  const owner = await makeUser({ firstName: 'Own', lastName: 'Parent' });
  const { student } = await makeStudent(owner.id);

  const schoolAdmin = await makeUser({ firstName: 'School', lastName: 'Admin' });
  const { institute: school } = await makeInstitute(schoolAdmin.id, { type: 'school' });
  const staff = await makeUser({ firstName: 'School', lastName: 'Staff' });
  await addUserToInstitute(school.id, staff.id);

  const familyAdmin = await makeUser({ firstName: 'Family', lastName: 'Admin' });
  const { institute: family } = await makeInstitute(familyAdmin.id, { type: 'family' });
  const familyMember = await makeUser({ firstName: 'Family', lastName: 'Member' });
  await addUserToInstitute(family.id, familyMember.id);

  // Enrolment is FIXTURE here, not the thing under test, and the service form
  // (`instituteService.assignStudentToInstitute`) additionally demands that the
  // enroller be an institute member AND hold a `user_students` link to the
  // student — which would hand two of the matrix rows below the very grants
  // they exist to deny. Write the enrolment row directly instead.
  await instituteRepository.assignStudentToInstitute(school.id, student.id, {});
  await instituteRepository.assignStudentToInstitute(family.id, student.id, {});

  const clinicAdmin = await makeUser({ firstName: 'Clinic', lastName: 'Admin' });
  const { institute: clinic } = await makeInstitute(clinicAdmin.id, { type: 'clinic' });

  const stranger = await makeUser({ firstName: 'No', lastName: 'One' });
  const sysadmin = await makeUser({ firstName: 'Sys', lastName: 'Admin', isSystemAdmin: true });

  return {
    owner, student,
    school, schoolAdmin, staff,
    family, familyAdmin, familyMember,
    clinic, clinicAdmin,
    stranger, sysadmin,
  };
}

/**
 * Every case below is a READ of a predicate, so the world is built once and
 * shared. (Rebuilding it per test costs ~9 s of bcrypt registrations — nine
 * users — for no isolation the assertions actually use.)
 */
let world: Awaited<ReturnType<typeof buildWorld>> | null = null;
async function setupWorld() {
  if (!world) world = await buildWorld();
  return world;
}

function principal(user: { id: string; isSystemAdmin?: boolean | null }) {
  return { id: user.id, isSystemAdmin: Boolean(user.isSystemAdmin) };
}

describe('services/access — the named student policies', () => {
  // 120 s, not the 30 s default: `buildWorld` registers NINE users and each one
  // is a bcrypt hash at cost 12 (~9 s total on an idle box, per the note above).
  // bcrypt is pure CPU, so any other test tier running on this machine — the
  // world-engine suite runs four workers — pushes it past the default and every
  // test in the file then fails on the hook, which reads as a logic failure and
  // is not one.
  beforeAll(async () => { await setupWorld(); }, 120_000);
  afterAll(async () => { world = null; await truncateAll(); });

  // ==========================================================================
  // POLICY 1 — studentAccess: link ∨ family member ∨ school/clinic admin
  // ==========================================================================
  describe('studentAccess (the broad policy)', () => {
    it('admits the holder of an active user_students link', async () => {
      const { owner, student } = await setupWorld();
      expect((await studentAccess(student.id, owner.id)).hasAccess).toBe(true);
    });

    it('admits ANY member of a family institute the student is enrolled in', async () => {
      const { familyMember, student } = await setupWorld();
      expect((await studentAccess(student.id, familyMember.id)).hasAccess).toBe(true);
    });

    it('admits the ADMIN of a school the student is enrolled in', async () => {
      const { schoolAdmin, student } = await setupWorld();
      expect((await studentAccess(student.id, schoolAdmin.id)).hasAccess).toBe(true);
    });

    // The load-bearing asymmetry: membership is enough for a FAMILY institute
    // and is NOT enough for a school. Collapsing this onto institute overlap
    // would hand every staff member the whole student surface.
    it('REFUSES a plain member of a school the student is enrolled in', async () => {
      const { staff, student } = await setupWorld();
      expect((await studentAccess(student.id, staff.id)).hasAccess).toBe(false);
    });

    it('refuses the admin of an institute the student is NOT enrolled in', async () => {
      const { clinicAdmin, student } = await setupWorld();
      expect((await studentAccess(student.id, clinicAdmin.id)).hasAccess).toBe(false);
    });

    it('refuses a stranger', async () => {
      const { stranger, student } = await setupWorld();
      expect((await studentAccess(student.id, stranger.id)).hasAccess).toBe(false);
    });

    // A system admin is NOT a principal of this policy. `sharesInstituteWith‐
    // Student` special-cases them; this one never has, and giving it that rule
    // would be a widening, not a cleanup.
    it('does NOT special-case a system admin', async () => {
      const { sysadmin, student } = await setupWorld();
      expect((await studentAccess(student.id, sysadmin.id)).hasAccess).toBe(false);
    });

    it('narrows to one institute when instituteId is supplied', async () => {
      const { schoolAdmin, student, school, clinic } = await setupWorld();
      expect(
        (await studentAccess(student.id, schoolAdmin.id, { instituteId: school.id })).hasAccess,
      ).toBe(true);
      // Same caller, an institute that does not justify them → refused.
      expect(
        (await studentAccess(student.id, schoolAdmin.id, { instituteId: clinic.id })).hasAccess,
      ).toBe(false);
    });

    it('refuses a student id that does not exist', async () => {
      const { owner } = await setupWorld();
      const missing = '00000000-0000-0000-0000-000000000000';
      expect((await studentAccess(missing, owner.id)).hasAccess).toBe(false);
    });

    // Pattern 6 in the clinical audit: `verifyStudentAccess` returns the student
    // ROW alongside `hasAccess: false`. The new surface refuses to.
    it('returns the student row on grant and withholds it on denial', async () => {
      const { owner, stranger, student } = await setupWorld();

      const granted = await studentAccess(student.id, owner.id);
      expect(granted.hasAccess).toBe(true);
      expect(granted.student?.id).toBe(student.id);

      const denied = await studentAccess(student.id, stranger.id);
      expect(denied.hasAccess).toBe(false);
      expect(denied.student).toBeUndefined();
      expect(denied.hasMedicalRights).toBe(false);
      expect(denied.hasEducationalRights).toBe(false);
    });

    it('hasStudentAccess is the null-safe boolean form and denies a missing id', async () => {
      const { owner, student } = await setupWorld();
      expect(await hasStudentAccess(student.id, owner.id)).toBe(true);
      expect(await hasStudentAccess(null, owner.id)).toBe(false);
      expect(await hasStudentAccess(undefined, owner.id)).toBe(false);
      expect(await hasStudentAccess(student.id, undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // POLICY 2 — sharesInstituteWithStudent: institute overlap only
  // ==========================================================================
  describe('sharesInstituteWithStudent (institute overlap only)', () => {
    it('admits a plain member of a school the student is enrolled in', async () => {
      const { staff, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(staff), student.id)).toBe(true);
    });

    it('admits an institute admin', async () => {
      const { schoolAdmin, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(schoolAdmin), student.id)).toBe(true);
    });

    it('admits a family-institute member', async () => {
      const { familyMember, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(familyMember), student.id)).toBe(true);
    });

    // The other load-bearing asymmetry: a linked caregiver whose student is
    // enrolled nowhere they are is NOT a member of anything.
    it('REFUSES the holder of a user_students link who shares no institute', async () => {
      const { owner, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(owner), student.id)).toBe(false);
    });

    it('admits a system admin unconditionally', async () => {
      const { sysadmin, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(sysadmin), student.id)).toBe(true);
    });

    it('refuses the admin of an institute the student is not enrolled in', async () => {
      const { clinicAdmin, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(clinicAdmin), student.id)).toBe(false);
    });

    it('refuses a stranger and an absent principal', async () => {
      const { stranger, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(stranger), student.id)).toBe(false);
      expect(await sharesInstituteWithStudent(undefined, student.id)).toBe(false);
      expect(await sharesInstituteWithStudent({}, student.id)).toBe(false);
    });

    // §2.4: `getInstitutesByStudentId` returns `{institute, enrollment}` rows.
    // Four copies read `m.id` (undefined) and therefore denied EVERYONE while
    // looking correct. If that regresses, this is the test that catches it.
    it('does not deny everyone (the m.id regression guard)', async () => {
      const { staff, schoolAdmin, familyMember, student } = await setupWorld();
      const admitted = await Promise.all([
        sharesInstituteWithStudent(principal(staff), student.id),
        sharesInstituteWithStudent(principal(schoolAdmin), student.id),
        sharesInstituteWithStudent(principal(familyMember), student.id),
      ]);
      expect(admitted).toEqual([true, true, true]);
    });
  });

  // ==========================================================================
  // administersStudentInstitute — derived from the STUDENT's enrolments
  // ==========================================================================
  describe('administersStudentInstitute', () => {
    it('admits an admin of an institute the student IS enrolled in', async () => {
      const { schoolAdmin, student } = await setupWorld();
      expect(await administersStudentInstitute(principal(schoolAdmin), student.id)).toBe(true);
    });

    it('refuses a plain member of that institute', async () => {
      const { staff, student } = await setupWorld();
      expect(await administersStudentInstitute(principal(staff), student.id)).toBe(false);
    });

    // §5.5.1: administering SOME institute proves nothing about this student.
    it('refuses an admin of an institute the student is NOT enrolled in', async () => {
      const { clinicAdmin, student } = await setupWorld();
      expect(await administersStudentInstitute(principal(clinicAdmin), student.id)).toBe(false);
    });

    it('admits a system admin, and refuses an absent principal', async () => {
      const { sysadmin, student } = await setupWorld();
      expect(await administersStudentInstitute(principal(sysadmin), student.id)).toBe(true);
      expect(await administersStudentInstitute(undefined, student.id)).toBe(false);
    });

    // The support-mode sentinel: `isUserAdminOfInstitute` opens with
    // `getActiveSupportInstituteId() === instituteId`, and that helper returns
    // `undefined` outside a support session. If an enrolment row's institute
    // were ever read as `undefined` (the `m.id` shape trap), EVERY caller would
    // pass. A stranger must not.
    it('never admits a stranger through the undefined-institute sentinel', async () => {
      const { stranger, student } = await setupWorld();
      expect(await administersStudentInstitute(principal(stranger), student.id)).toBe(false);
    });
  });

  // ==========================================================================
  // POLICY 3 — the wizard-context union
  // ==========================================================================
  describe('wizardContextGrantFor (the three-predicate union)', () => {
    async function guardianContactFor(studentId: string, userId: string): Promise<StudentContact> {
      const [contact] = await db.insert(studentContacts).values({
        studentId,
        name: 'Linked Guardian',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        linkedUserId: userId,
      }).returning();
      return contact;
    }

    it('grants "guardian_contact" when the handler loaded the caller\'s own contact row', async () => {
      const { stranger, student } = await setupWorld();
      const contact = await guardianContactFor(student.id, stranger.id);
      // A stranger by every other measure — the contact row is the whole grant.
      expect(await wizardContextGrantFor(principal(stranger), student.id, contact))
        .toBe('guardian_contact');
    });

    it('grants "institute" to a plain institute member', async () => {
      const { staff, student } = await setupWorld();
      expect(await wizardContextGrantFor(principal(staff), student.id, null)).toBe('institute');
    });

    it('grants "user_student" to a linked caller who shares no institute', async () => {
      const { owner, student } = await setupWorld();
      expect(await wizardContextGrantFor(principal(owner), student.id, null)).toBe('user_student');
    });

    it('grants nothing to a stranger, or to an unauthenticated principal', async () => {
      const { stranger, student } = await setupWorld();
      expect(await wizardContextGrantFor(principal(stranger), student.id, null)).toBeNull();
      expect(await wizardContextGrantFor(undefined, student.id, null)).toBeNull();
    });

    it('is strictly WIDER than institute overlap, and that is the point', async () => {
      const { owner, student } = await setupWorld();
      expect(await sharesInstituteWithStudent(principal(owner), student.id)).toBe(false);
      expect(await wizardContextGrantFor(principal(owner), student.id, null)).not.toBeNull();
    });
  });

  // ==========================================================================
  // HTTP adapters — the policy is shared, the response bytes are the caller's
  // ==========================================================================
  describe('requireStudentAccess (the response-writing form)', () => {
    const SHAPE = {
      unauthenticated: { success: false, error: 'NO_SESSION' },
      forbidden: { success: false, error: 'DENIED' },
    };

    it('returns the userId and writes nothing when the caller passes', async () => {
      const { owner, student } = await setupWorld();
      const req = makeReq({ user: { id: owner.id } });
      const { res, capture } = makeRes();
      expect(await requireStudentAccess(req, res, student.id, { shape: SHAPE })).toBe(owner.id);
      expect(capture.ended).toBe(false);
    });

    it('401s with the caller-supplied body when there is no session', async () => {
      const { student } = await setupWorld();
      const req = makeReq({ user: null });
      const { res, capture } = makeRes();
      expect(await requireStudentAccess(req, res, student.id, { shape: SHAPE })).toBeUndefined();
      expect(capture.statusCode).toBe(401);
      expect(capture.jsonBody).toEqual(SHAPE.unauthenticated);
    });

    it('403s with the caller-supplied body when the policy refuses', async () => {
      const { stranger, student } = await setupWorld();
      const req = makeReq({ user: { id: stranger.id } });
      const { res, capture } = makeRes();
      expect(await requireStudentAccess(req, res, student.id, { shape: SHAPE })).toBeUndefined();
      expect(capture.statusCode).toBe(403);
      expect(capture.jsonBody).toEqual(SHAPE.forbidden);
    });

    // 403-before-404: a nonexistent id answers exactly like a forbidden one, so
    // the endpoint is not a student-uuid oracle.
    it('answers a nonexistent student id identically to a forbidden one', async () => {
      const { stranger, student } = await setupWorld();
      const missing = '00000000-0000-0000-0000-000000000000';

      const forbidden = makeRes();
      await requireStudentAccess(
        makeReq({ user: { id: stranger.id } }), forbidden.res, student.id, { shape: SHAPE });
      const absent = makeRes();
      await requireStudentAccess(
        makeReq({ user: { id: stranger.id } }), absent.res, missing, { shape: SHAPE });

      expect(absent.capture.statusCode).toBe(forbidden.capture.statusCode);
      expect(absent.capture.jsonBody).toEqual(forbidden.capture.jsonBody);
    });

    it('refuses a missing student id by default', async () => {
      const { owner } = await setupWorld();
      const req = makeReq({ user: { id: owner.id } });
      const { res, capture } = makeRes();
      expect(await requireStudentAccess(req, res, undefined, { shape: SHAPE })).toBeUndefined();
      expect(capture.statusCode).toBe(403);
    });

    // Only voiceController wants this: generic TTS carries no student.
    it('passes a missing student id on a session alone when allowNoStudent is set', async () => {
      const { owner } = await setupWorld();
      const req = makeReq({ user: { id: owner.id } });
      const { res, capture } = makeRes();
      expect(
        await requireStudentAccess(req, res, undefined, { shape: SHAPE, allowNoStudent: true }),
      ).toBe(owner.id);
      expect(capture.ended).toBe(false);

      // …but still not without a session.
      const anon = makeRes();
      expect(
        await requireStudentAccess(
          makeReq({ user: null }), anon.res, undefined, { shape: SHAPE, allowNoStudent: true }),
      ).toBeUndefined();
      expect(anon.capture.statusCode).toBe(401);
    });
  });

  describe('assertSharesInstituteWithStudent / assertWizardContextAccess', () => {
    const UNAUTH = { success: false, message: 'Unauthenticated' };
    const FORBIDDEN = {
      success: false,
      code: 'permission_denied',
      message: 'No access to that student',
    };

    it('admits an institute member and writes nothing', async () => {
      const { staff, student } = await setupWorld();
      const { res, capture } = makeRes();
      expect(
        await assertSharesInstituteWithStudent(makeReq({ user: { id: staff.id } }), res, student.id),
      ).toBe(true);
      expect(capture.ended).toBe(false);
    });

    it('answers 401 / 403 with the consent surface\'s exact bodies', async () => {
      const { stranger, student } = await setupWorld();

      const anon = makeRes();
      expect(await assertSharesInstituteWithStudent(makeReq({ user: null }), anon.res, student.id))
        .toBe(false);
      expect(anon.capture.statusCode).toBe(401);
      expect(anon.capture.jsonBody).toEqual(UNAUTH);

      const denied = makeRes();
      expect(
        await assertSharesInstituteWithStudent(
          makeReq({ user: { id: stranger.id } }), denied.res, student.id),
      ).toBe(false);
      expect(denied.capture.statusCode).toBe(403);
      expect(denied.capture.jsonBody).toEqual(FORBIDDEN);
    });

    // Indistinguishability is the design: a refused caller must not learn WHICH
    // gate refused them, nor whether the student exists.
    it('refuses identically from either gate', async () => {
      const { stranger, student } = await setupWorld();

      const viaInstitute = makeRes();
      await assertSharesInstituteWithStudent(
        makeReq({ user: { id: stranger.id } }), viaInstitute.res, student.id);
      const viaWizard = makeRes();
      await assertWizardContextAccess(
        makeReq({ user: { id: stranger.id } }), viaWizard.res, student.id, null);

      expect(viaWizard.capture.statusCode).toBe(viaInstitute.capture.statusCode);
      expect(viaWizard.capture.jsonBody).toEqual(viaInstitute.capture.jsonBody);
    });

    it('admits a linked caller through the wizard gate that institute overlap refuses', async () => {
      const { owner, student } = await setupWorld();

      const strict = makeRes();
      expect(
        await assertSharesInstituteWithStudent(
          makeReq({ user: { id: owner.id } }), strict.res, student.id),
      ).toBe(false);

      const wizard = makeRes();
      expect(
        await assertWizardContextAccess(
          makeReq({ user: { id: owner.id } }), wizard.res, student.id, null),
      ).toBe(true);
      expect(wizard.capture.ended).toBe(false);
    });
  });

  describe('principalFromRequest', () => {
    it('reads id and isSystemAdmin off req.user, and tolerates no session', async () => {
      const req = makeReq({ user: { id: 'u1', isSystemAdmin: true } });
      expect(principalFromRequest(req)).toMatchObject({ id: 'u1', isSystemAdmin: true });
      expect(principalFromRequest(makeReq({ user: null }))).toBeNull();
    });
  });
});
