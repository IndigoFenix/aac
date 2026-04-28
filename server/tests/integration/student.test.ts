/**
 * Student integration tests.
 *
 * Covers create + link, access verification, additional links, updates,
 * and the StudentWithAacSettings shape returned by the service.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import {
  makeUser,
  makeStudent,
  studentService,
} from '../helpers/factories.js';

describe('Student integration', () => {
  afterEach(truncateAll);

  describe('create', () => {
    it('creates a student plus a userStudents link with owner role', async () => {
      const owner = await makeUser();
      const { student, link } = await makeStudent(owner.id);

      expect(student.id).toBeDefined();
      expect(student.name).toBeTruthy();
      expect(student.aacSettings).toBeDefined();
      expect(student.aacSettings).not.toBeNull();
      expect(link.userId).toBe(owner.id);
      expect(link.studentId).toBe(student.id);
      expect(link.role).toBe('owner');
      expect(link.isActive).toBe(true);
    });

    it('derives name from firstName/lastName when not provided', async () => {
      const owner = await makeUser();
      const { student } = await studentService.createStudentWithLink(
        {
          firstName: 'Alice',
          lastName: 'Doe',
          framework: 'us_iep',
          primaryLanguage: 'en',
          country: 'US',
        } as any,
        owner.id,
      );
      expect(student.name).toBe('Alice Doe');
      expect(student.firstName).toBe('Alice');
      expect(student.lastName).toBe('Doe');
    });
  });

  describe('verifyStudentAccess', () => {
    it('returns hasAccess=true for the owner with full rights', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const result = await studentService.verifyStudentAccess(student.id, owner.id);
      expect(result.hasAccess).toBe(true);
      expect(result.hasMedicalRights).toBe(true);
      expect(result.hasEducationalRights).toBe(true);
      expect(result.link?.userId).toBe(owner.id);
    });

    it('returns hasAccess=false for an unrelated user', async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(owner.id);

      const result = await studentService.verifyStudentAccess(student.id, stranger.id);
      expect(result.hasAccess).toBe(false);
      expect(result.hasMedicalRights).toBe(false);
      expect(result.hasEducationalRights).toBe(false);
    });

    it('returns hasAccess=false for a non-existent student', async () => {
      const user = await makeUser();
      const result = await studentService.verifyStudentAccess(
        '00000000-0000-4000-8000-000000000000',
        user.id,
      );
      expect(result.hasAccess).toBe(false);
    });
  });

  describe('linkUserToStudent', () => {
    it('adds a second user-student link without disturbing the first', async () => {
      const owner = await makeUser();
      const caregiver = await makeUser();
      const { student } = await makeStudent(owner.id);

      const link = await studentService.linkUserToStudent(
        caregiver.id,
        student.id,
        'caregiver',
      );

      expect(link.userId).toBe(caregiver.id);
      expect(link.role).toBe('caregiver');
      expect(link.isActive).toBe(true);

      // Owner link still works.
      const ownerCheck = await studentService.verifyStudentAccess(student.id, owner.id);
      expect(ownerCheck.hasAccess).toBe(true);

      // Caregiver now has access too.
      const caregiverCheck = await studentService.verifyStudentAccess(
        student.id,
        caregiver.id,
      );
      expect(caregiverCheck.hasAccess).toBe(true);
    });

    it('lists all linked users for a student', async () => {
      const owner = await makeUser();
      const userB = await makeUser();
      const userC = await makeUser();
      const { student } = await makeStudent(owner.id);

      await studentService.linkUserToStudent(userB.id, student.id, 'caregiver');
      await studentService.linkUserToStudent(userC.id, student.id, 'therapist');

      const links = await studentService.getUsersLinkedToStudent(student.id);
      const userIds = links.map((l) => l.userId).sort();
      expect(userIds).toEqual([owner.id, userB.id, userC.id].sort());
    });
  });

  describe('updateStudent', () => {
    it('updates basic student fields', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const updated = await studentService.updateStudent(student.id, {
        firstName: 'Updated',
        lastName: 'Last',
      });

      expect(updated!.firstName).toBe('Updated');
      expect(updated!.lastName).toBe('Last');
      expect(updated!.name).toBe('Updated Last');
    });

    it('routes AAC settings fields to aac_settings table', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const updated = await studentService.updateStudent(student.id, {
        firstName: 'Stays',
        enabled: true,
        voiceType: 'gemini',
      });

      expect(updated!.firstName).toBe('Stays');
      expect(updated!.aacSettings?.enabled).toBe(true);
      expect(updated!.aacSettings?.voiceType).toBe('gemini');
    });
  });

  describe('getStudentById', () => {
    it('returns student with aacSettings shape', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const fetched = await studentService.getStudentById(student.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(student.id);
      expect(fetched!.aacSettings).toBeDefined();
    });

    it('returns undefined for non-existent student', async () => {
      const fetched = await studentService.getStudentById(
        '00000000-0000-4000-8000-000000000000',
      );
      expect(fetched).toBeUndefined();
    });
  });

  describe('unlinkUserFromStudent', () => {
    it('soft-deactivates the link, removing access', async () => {
      const owner = await makeUser();
      const caregiver = await makeUser();
      const { student } = await makeStudent(owner.id);
      await studentService.linkUserToStudent(caregiver.id, student.id, 'caregiver');

      const before = await studentService.verifyStudentAccess(student.id, caregiver.id);
      expect(before.hasAccess).toBe(true);

      await studentService.unlinkUserFromStudent(caregiver.id, student.id);

      const after = await studentService.verifyStudentAccess(student.id, caregiver.id);
      expect(after.hasAccess).toBe(false);
    });
  });
});
