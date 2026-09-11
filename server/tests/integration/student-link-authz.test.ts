/**
 * User-student LINK AUTHORIZATION regression pins (2026-09-10 authorization audit).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE PIN, AND WHY THEY EXIST
 *
 * `POST /api/students/:id/link` and `DELETE /api/students/:id/link/:userId`
 * took the institute id OFF THE REQUEST (body / query string), proved the
 * caller administered THAT institute — and never asked whether the STUDENT was
 * enrolled in it. `role` was then written through as `role || "caregiver"`,
 * unvalidated. Together those two defects meant any admin of any school or
 * clinic could POST their own instituteId, their own user id and any student
 * uuid in the system, with `role: "owner"`, and receive full PHI access plus
 * the owner-only student delete. The unlink half of the same shape let them
 * strip a student's caregivers instead.
 *
 * Verified non-vacuous: run against the pre-fix controller, the escalation
 * cases below SUCCEED (HTTP 200, resulting `user_students.role === "owner"`).
 *
 * The fix inverts the derivation — candidate institutes come from the
 * student's active enrolments (`studentService.getStudentLinkAuthority`) and
 * the request's institute id is ignored entirely — and validates `role`
 * against the system's own vocabulary, with `owner` grantable only by an
 * existing owner. See docs/SECURITY_ARCHITECTURE.md §2.4.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import { truncateAll } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import {
  makeUser,
  makeStudent,
  makeInstitute,
  addUserToInstitute,
  enrollStudent,
  studentService,
} from '../helpers/factories.js';
import { studentController } from '../../controllers/studentController.js';
import { USER_STUDENT_ROLES } from '../../services/studentService.js';
import { INSTITUTE_STUDENTS_FIELD } from '../../services/memory-schema/institute-memory-schema.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { db } from '../../db.js';
import { activityLogs } from '@shared/schema';
import { eq } from 'drizzle-orm';

/**
 * The world every case below runs in:
 *
 *   owner        — family account, holds the `owner` link on `student`
 *   student      — enrolled in `school` ONLY
 *   school       — owner is admin; `schoolAdmin` is a second admin,
 *                  `staff` a non-admin member
 *   attacker     — admin of `otherClinic`, which the student is NOT enrolled in
 *   otherClinic  — a clinic whose only member is `attacker`
 *   stranger     — no institute, no link
 */
async function setupWorld() {
  const owner = await makeUser({ firstName: 'Owner', lastName: 'Parent' });
  const { student } = await makeStudent(owner.id);

  const { institute: school } = await makeInstitute(owner.id, { type: 'school' });
  await enrollStudent(school.id, student.id, owner.id);

  const schoolAdmin = await makeUser({ firstName: 'School', lastName: 'Admin' });
  await addUserToInstitute(school.id, schoolAdmin.id, { isAdmin: true });

  const staff = await makeUser({ firstName: 'School', lastName: 'Staff' });
  await addUserToInstitute(school.id, staff.id);

  const attacker = await makeUser({ firstName: 'Other', lastName: 'Admin' });
  const { institute: otherClinic } = await makeInstitute(attacker.id, { type: 'clinic' });

  const stranger = await makeUser({ firstName: 'No', lastName: 'One' });

  return { owner, student, school, schoolAdmin, staff, attacker, otherClinic, stranger };
}

async function callLink(args: {
  callerId: string;
  studentId: string;
  body: Record<string, unknown>;
}) {
  const req = makeReq({
    user: { id: args.callerId },
    params: { id: args.studentId },
    body: args.body,
  });
  const { res, capture } = makeRes();
  await studentController.linkUser(req, res);
  return capture;
}

async function callUnlink(args: {
  callerId: string;
  studentId: string;
  targetUserId: string;
  query?: Record<string, string>;
}) {
  const req = makeReq({
    user: { id: args.callerId },
    params: { id: args.studentId, userId: args.targetUserId },
    query: args.query ?? {},
  });
  const { res, capture } = makeRes();
  await studentController.unlinkUser(req, res);
  return capture;
}

/** The stored role for a (user, student) pair, or null when there is no row. */
async function storedRole(userId: string, studentId: string): Promise<string | null> {
  const link = await studentRepository.getUserStudentLink(userId, studentId);
  return link ? String(link.role) : null;
}

/** activityLogService.log is fire-and-forget — poll rather than read straight back. */
async function waitForLinkLog(studentId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.subjectId1, studentId));
    const linkRow = rows.find((row) => row.eventType === 'link');
    if (linkRow) return linkRow;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No link activity log for ${studentId} within 2s`);
}

describe('User-student link authorization', () => {
  afterEach(truncateAll);

  // ==========================================================================
  // THE CORE DEFECT: :studentId was never tied to the institute id.
  // ==========================================================================
  describe('an institute admin has no authority over a student not enrolled with them', () => {
    it('refuses the self-owner escalation (the reported vulnerability)', async () => {
      const { student, attacker, otherClinic } = await setupWorld();

      const capture = await callLink({
        callerId: attacker.id,
        studentId: student.id,
        // Everything here is caller-supplied and all of it checks out on its
        // own terms: the attacker really does administer `otherClinic`, and
        // really is a member of it. The only thing that was never checked is
        // the one that matters — the student is not enrolled there.
        body: { targetUserId: attacker.id, role: 'owner', instituteId: otherClinic.id },
      });

      expect(capture.statusCode).toBe(403);
    });

    it('writes no row at all on that attempt', async () => {
      const { student, attacker, otherClinic } = await setupWorld();

      await callLink({
        callerId: attacker.id,
        studentId: student.id,
        body: { targetUserId: attacker.id, role: 'owner', instituteId: otherClinic.id },
      });

      // Pre-fix this read back "owner".
      expect(await storedRole(attacker.id, student.id)).toBeNull();

      const access = await studentService.verifyStudentAccess(student.id, attacker.id);
      expect(access.hasAccess).toBe(false);
    });

    it('refuses even the modest roles for an unenrolled student', async () => {
      const { student, attacker, otherClinic } = await setupWorld();

      const capture = await callLink({
        callerId: attacker.id,
        studentId: student.id,
        body: { targetUserId: attacker.id, role: 'caregiver', instituteId: otherClinic.id },
      });

      expect(capture.statusCode).toBe(403);
      expect(await storedRole(attacker.id, student.id)).toBeNull();
    });

    it('refuses an UNLINK of a caregiver from a student not enrolled with them', async () => {
      const { owner, student, attacker, otherClinic } = await setupWorld();
      const caregiver = await makeUser();
      await studentService.linkUserToStudent(caregiver.id, student.id, 'caregiver');

      const capture = await callUnlink({
        callerId: attacker.id,
        studentId: student.id,
        targetUserId: caregiver.id,
        query: { instituteId: otherClinic.id },
      });

      expect(capture.statusCode).toBe(403);

      // The caregiver's access survived.
      const stillLinked = await studentService.verifyStudentAccess(student.id, caregiver.id);
      expect(stillLinked.hasAccess).toBe(true);
      // And so did the owner's.
      expect(await storedRole(owner.id, student.id)).toBe('owner');
    });

    it('refuses a caller with no relationship to the student at all', async () => {
      const { student, stranger } = await setupWorld();
      const target = await makeUser();

      const capture = await callLink({
        callerId: stranger.id,
        studentId: student.id,
        body: { targetUserId: target.id, role: 'caregiver' },
      });

      expect(capture.statusCode).toBe(403);
      expect(await storedRole(target.id, student.id)).toBeNull();
    });
  });

  // ==========================================================================
  // OWNERSHIP IS THE FAMILY'S. An admin may grant every role but that one.
  // ==========================================================================
  describe('the owner role', () => {
    it('cannot be granted by an institute admin, even for their own student', async () => {
      const { student, schoolAdmin, staff } = await setupWorld();

      const capture = await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: staff.id, role: 'owner' },
      });

      expect(capture.statusCode).toBe(403);
      expect(await storedRole(staff.id, student.id)).toBeNull();
    });

    it('cannot be granted by an institute admin to THEMSELVES', async () => {
      const { student, schoolAdmin } = await setupWorld();

      const capture = await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: schoolAdmin.id, role: 'owner' },
      });

      expect(capture.statusCode).toBe(403);
      expect(await storedRole(schoolAdmin.id, student.id)).toBeNull();
    });

    it('CAN be granted by an existing owner (a second parent)', async () => {
      const { owner, student } = await setupWorld();
      const coParent = await makeUser();

      const capture = await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: coParent.id, role: 'owner' },
      });

      expect(capture.statusCode).toBe(200);
      expect(await storedRole(coParent.id, student.id)).toBe('owner');
    });

    it("cannot be demoted by an institute admin re-linking the owner", async () => {
      const { owner, student, schoolAdmin } = await setupWorld();
      // The owner is a member of the school (they created it), so the
      // "target is a member of this institute" check passes — the only thing
      // standing between the admin and a demoted owner is the owner guard.
      const capture = await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: owner.id, role: 'caregiver' },
      });

      expect(capture.statusCode).toBe(403);
      expect(await storedRole(owner.id, student.id)).toBe('owner');
    });

    it('is still refused by the unlink guard', async () => {
      const { owner, student, schoolAdmin } = await setupWorld();

      const capture = await callUnlink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        targetUserId: owner.id,
      });

      expect(capture.statusCode).toBe(400);
      expect(await storedRole(owner.id, student.id)).toBe('owner');
    });
  });

  // ==========================================================================
  // ROLE VOCABULARY
  // ==========================================================================
  describe('role validation', () => {
    it('rejects an unknown role instead of writing it', async () => {
      const { owner, student } = await setupWorld();
      const target = await makeUser();

      const capture = await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: target.id, role: 'superuser' },
      });

      expect(capture.statusCode).toBe(400);
      expect(await storedRole(target.id, student.id)).toBeNull();
    });

    it('rejects a non-string role rather than defaulting it', async () => {
      const { owner, student } = await setupWorld();
      const target = await makeUser();

      const capture = await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: target.id, role: { toString: () => 'owner' } },
      });

      expect(capture.statusCode).toBe(400);
      expect(await storedRole(target.id, student.id)).toBeNull();
    });

    it('defaults an omitted role to caregiver', async () => {
      const { owner, student } = await setupWorld();
      const target = await makeUser();

      const capture = await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: target.id },
      });

      expect(capture.statusCode).toBe(200);
      expect(await storedRole(target.id, student.id)).toBe('caregiver');
    });

    it('accepts every role the system defines (owner from an owner)', async () => {
      const { owner, student } = await setupWorld();

      for (const role of USER_STUDENT_ROLES) {
        const target = await makeUser();
        const capture = await callLink({
          callerId: owner.id,
          studentId: student.id,
          body: { targetUserId: target.id, role },
        });
        expect(capture.statusCode).toBe(200);
        expect(await storedRole(target.id, student.id)).toBe(role);
      }
      // One `makeUser` + link + read-back per role, so this is the longest test
      // in the file. It passes comfortably in isolation and timed out at the
      // 30 s default only inside the ~100-minute serial integration sweep,
      // where the box is loaded — a duration problem, never an assertion one.
    }, 60_000);

    // The HTTP layer's list and the list the AI is handed must be the same
    // list. Two vocabularies would mean a role the assistant can write and the
    // API rejects, or worse, the reverse.
    it('matches the vocabulary published to the AI memory schema', async () => {
      const studentSchema = INSTITUTE_STUDENTS_FIELD.values as any;
      const roleField = studentSchema?.properties?.users?.values?.properties?.role;
      // Guard against a vacuous pass if the schema is ever reshaped.
      expect(Array.isArray(roleField?.enum)).toBe(true);
      expect([...roleField.enum].sort()).toEqual([...USER_STUDENT_ROLES].sort());
    });
  });

  // ==========================================================================
  // THE LEGITIMATE PATHS STILL WORK
  // ==========================================================================
  describe('legitimate callers', () => {
    it('lets a student owner link a caregiver', async () => {
      const { owner, student } = await setupWorld();
      const caregiver = await makeUser();

      const capture = await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: caregiver.id, role: 'caregiver' },
      });

      expect(capture.statusCode).toBe(200);
      expect((capture.jsonBody as any).success).toBe(true);
      expect(await storedRole(caregiver.id, student.id)).toBe('caregiver');

      const access = await studentService.verifyStudentAccess(student.id, caregiver.id);
      expect(access.hasAccess).toBe(true);
    });

    it('lets an institute admin link a member of the institute the student is enrolled in', async () => {
      const { student, schoolAdmin, staff } = await setupWorld();

      const capture = await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: staff.id, role: 'therapist' },
      });

      expect(capture.statusCode).toBe(200);
      expect(await storedRole(staff.id, student.id)).toBe('therapist');
    });

    it('still refuses a target who is not a member of that institute', async () => {
      const { student, schoolAdmin, stranger } = await setupWorld();

      const capture = await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: stranger.id, role: 'caregiver' },
      });

      expect(capture.statusCode).toBe(400);
      expect(await storedRole(stranger.id, student.id)).toBeNull();
    });

    it('lets an institute admin unlink a caregiver from their own student', async () => {
      const { student, schoolAdmin, staff } = await setupWorld();
      await studentService.linkUserToStudent(staff.id, student.id, 'caregiver');

      const capture = await callUnlink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        targetUserId: staff.id,
      });

      expect(capture.statusCode).toBe(200);
      const access = await studentService.verifyStudentAccess(student.id, staff.id);
      expect(access.hasAccess).toBe(false);
    });

    it('lets an owner unlink a caregiver', async () => {
      const { owner, student } = await setupWorld();
      const caregiver = await makeUser();
      await studentService.linkUserToStudent(caregiver.id, student.id, 'caregiver');

      const capture = await callUnlink({
        callerId: owner.id,
        studentId: student.id,
        targetUserId: caregiver.id,
      });

      expect(capture.statusCode).toBe(200);
    });
  });

  // ==========================================================================
  // THE REQUEST'S instituteId IS INERT
  // ==========================================================================
  describe('the request-supplied instituteId', () => {
    it('neither grants authority nor withholds it', async () => {
      const { student, schoolAdmin, staff, otherClinic } = await setupWorld();

      // A legitimate admin naming a completely unrelated institute still
      // succeeds — authority came from the student's enrolments, not the body.
      const capture = await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: staff.id, role: 'caregiver', instituteId: otherClinic.id },
      });

      expect(capture.statusCode).toBe(200);
      expect(await storedRole(staff.id, student.id)).toBe('caregiver');
    });

    it('does not reach the audit log — the derived institute does', async () => {
      const { student, schoolAdmin, staff, school, otherClinic } = await setupWorld();

      await callLink({
        callerId: schoolAdmin.id,
        studentId: student.id,
        body: { targetUserId: staff.id, role: 'caregiver', instituteId: otherClinic.id },
      });

      const linkLog = await waitForLinkLog(student.id);
      expect(linkLog.instituteId).toBe(school.id);
      expect(linkLog.instituteId).not.toBe(otherClinic.id);
    });
  });

  // ==========================================================================
  // RE-LINKING IS AN UPDATE, NOT A SECOND ROW
  // ==========================================================================
  describe('re-linking', () => {
    it('updates the existing row instead of creating a duplicate', async () => {
      const { owner, student } = await setupWorld();
      const caregiver = await makeUser();

      await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: caregiver.id, role: 'caregiver' },
      });
      await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: caregiver.id, role: 'therapist' },
      });

      const links = await studentService.getUsersLinkedToStudent(student.id);
      const forCaregiver = links.filter((link) => link.userId === caregiver.id);
      expect(forCaregiver).toHaveLength(1);
      expect(forCaregiver[0].role).toBe('therapist');
    });

    it('reactivates an unlinked user rather than stacking a second row', async () => {
      const { owner, student } = await setupWorld();
      const caregiver = await makeUser();

      await studentService.linkUserToStudent(caregiver.id, student.id, 'caregiver');
      await studentService.unlinkUserFromStudent(caregiver.id, student.id);

      const capture = await callLink({
        callerId: owner.id,
        studentId: student.id,
        body: { targetUserId: caregiver.id, role: 'caregiver' },
      });

      expect(capture.statusCode).toBe(200);
      const links = await studentService.getUsersLinkedToStudent(student.id);
      expect(links.filter((link) => link.userId === caregiver.id)).toHaveLength(1);
    });
  });
});
