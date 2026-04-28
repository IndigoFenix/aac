/**
 * Student switching integration tests.
 *
 * Three switching dimensions:
 *  - Active student per chat session (chatSessions.studentId)
 *  - User → student listing (which students a user can see at all)
 *  - Cross-institute switching (institute scoping reveals different students)
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  enrollStudent,
  addUserToInstitute,
  studentService,
} from '../helpers/factories.js';
import {
  createChatSession,
  switchActiveStudent,
  getSessionStudentId,
} from '../helpers/sessions.js';

describe('Student switching', () => {
  afterEach(truncateAll);

  describe('chat session active student', () => {
    it('updates the active studentId on a chat session', async () => {
      const user = await makeUser();
      const { student: studentA } = await makeStudent(user.id);
      const { student: studentB } = await makeStudent(user.id);

      const session = await createChatSession(user.id, studentA.id);
      expect(session.studentId).toBe(studentA.id);

      await switchActiveStudent(session.id, studentB.id);

      const after = await getSessionStudentId(session.id);
      expect(after).toBe(studentB.id);
    });

    it('keeps multiple sessions independent', async () => {
      const user = await makeUser();
      const { student: studentA } = await makeStudent(user.id);
      const { student: studentB } = await makeStudent(user.id);

      const sessionA = await createChatSession(user.id, studentA.id);
      const sessionB = await createChatSession(user.id, studentB.id);

      await switchActiveStudent(sessionA.id, studentB.id);

      expect(await getSessionStudentId(sessionA.id)).toBe(studentB.id);
      // sessionB unaffected
      expect(await getSessionStudentId(sessionB.id)).toBe(studentB.id);
    });
  });

  describe('user → student listing', () => {
    it('returns only students directly linked to the user', async () => {
      const user = await makeUser();
      const stranger = await makeUser();
      const { student: mine } = await makeStudent(user.id);
      await makeStudent(stranger.id); // not linked to `user`

      const list = await studentService.getStudentsByUserId(user.id);
      expect(list.map((s) => s.id)).toEqual([mine.id]);
    });

    it('includes students added via secondary user-student links', async () => {
      const owner = await makeUser();
      const caregiver = await makeUser();
      const { student } = await makeStudent(owner.id);

      // caregiver has no students yet
      let caregiverList = await studentService.getStudentsByUserId(caregiver.id);
      expect(caregiverList).toHaveLength(0);

      await studentService.linkUserToStudent(caregiver.id, student.id, 'caregiver');

      caregiverList = await studentService.getStudentsByUserId(caregiver.id);
      expect(caregiverList.map((s) => s.id)).toEqual([student.id]);
    });
  });

  describe('cross-institute switching', () => {
    it('scopes students by institute when user belongs to multiple', async () => {
      // Setup: a clinician user belongs to two institutes, each with its own student.
      // We do NOT create a direct userStudents link — institute admin role grants access.
      const clinician = await makeUser();
      const adminA = await makeUser();
      const adminB = await makeUser();

      const { institute: instituteA } = await makeInstitute(adminA.id, {
        type: 'school',
        name: 'School A',
      });
      const { institute: instituteB } = await makeInstitute(adminB.id, {
        type: 'school',
        name: 'School B',
      });

      const { student: studentA } = await makeStudent(adminA.id);
      const { student: studentB } = await makeStudent(adminB.id);

      await enrollStudent(instituteA.id, studentA.id, adminA.id);
      await enrollStudent(instituteB.id, studentB.id, adminB.id);

      // Clinician joins both institutes (as admin so access verification succeeds).
      await addUserToInstitute(instituteA.id, clinician.id, { isAdmin: true });
      await addUserToInstitute(instituteB.id, clinician.id, { isAdmin: true });

      // Switching to instituteA: only studentA visible.
      const visibleA = await studentService.getStudentsForUserInInstitute(
        clinician.id,
        instituteA.id,
      );
      expect(visibleA.map((s) => s.student.id)).toEqual([studentA.id]);

      // Switching to instituteB: only studentB visible.
      const visibleB = await studentService.getStudentsForUserInInstitute(
        clinician.id,
        instituteB.id,
      );
      expect(visibleB.map((s) => s.student.id)).toEqual([studentB.id]);
    });

    it('access verification respects the active institute filter', async () => {
      const clinician = await makeUser();
      const adminA = await makeUser();
      const adminB = await makeUser();

      const { institute: instituteA } = await makeInstitute(adminA.id, { type: 'school' });
      const { institute: instituteB } = await makeInstitute(adminB.id, { type: 'school' });

      const { student: studentA } = await makeStudent(adminA.id);
      await enrollStudent(instituteA.id, studentA.id, adminA.id);

      await addUserToInstitute(instituteA.id, clinician.id, { isAdmin: true });
      await addUserToInstitute(instituteB.id, clinician.id, { isAdmin: true });

      // From instituteA, clinician can access studentA.
      const fromA = await studentService.verifyStudentAccess(
        studentA.id,
        clinician.id,
        instituteA.id,
      );
      expect(fromA.hasAccess).toBe(true);

      // From instituteB (where studentA is not enrolled), no access.
      const fromB = await studentService.verifyStudentAccess(
        studentA.id,
        clinician.id,
        instituteB.id,
      );
      expect(fromB.hasAccess).toBe(false);
    });
  });
});
