/**
 * Permissions integration tests.
 *
 * Four dimensions:
 *  - Role-based: userStudents.role/rights persistence and access through links
 *  - Institute scoping: cross-institute access denied without explicit grant
 *  - Cross-institute sharing: end-to-end studentShareInvite state machine
 *  - License feature gates: requireLicensePermission middleware
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  makeLicense,
  enrollStudent,
  addUserToInstitute,
  studentService,
  instituteService,
} from '../helpers/factories.js';
import { studentShareInviteService } from '../../services/sharing/studentShareInviteService.js';
import { incidentRepository } from '../../repositories/index.js';
import { requireLicensePermission } from '../../middleware/auth.js';
import { objectShares, userStudents } from '@shared/schema';
import { eq } from 'drizzle-orm';

describe('Permissions', () => {
  afterEach(truncateAll);

  // ============================================================
  // Role-based
  // ============================================================
  describe('role-based access', () => {
    it('persists role on the userStudents link', async () => {
      const owner = await makeUser();
      const therapist = await makeUser();
      const { student } = await makeStudent(owner.id);

      await studentService.linkUserToStudent(therapist.id, student.id, 'therapist');
      const [link] = await db
        .select()
        .from(userStudents)
        .where(eq(userStudents.userId, therapist.id));
      expect(link.role).toBe('therapist');
      expect(link.isActive).toBe(true);
    });

    it('grants access to any active linked user regardless of role', async () => {
      const owner = await makeUser();
      const parent = await makeUser();
      const therapist = await makeUser();
      const { student } = await makeStudent(owner.id);

      await studentService.linkUserToStudent(parent.id, student.id, 'parent');
      await studentService.linkUserToStudent(therapist.id, student.id, 'therapist');

      const parentCheck = await studentService.verifyStudentAccess(student.id, parent.id);
      const therapistCheck = await studentService.verifyStudentAccess(
        student.id,
        therapist.id,
      );
      expect(parentCheck.hasAccess).toBe(true);
      expect(therapistCheck.hasAccess).toBe(true);
    });

    it('removes access when the link is deactivated', async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(owner.id);

      await studentService.linkUserToStudent(stranger.id, student.id, 'caregiver');
      let check = await studentService.verifyStudentAccess(student.id, stranger.id);
      expect(check.hasAccess).toBe(true);

      await studentService.unlinkUserFromStudent(stranger.id, student.id);
      check = await studentService.verifyStudentAccess(student.id, stranger.id);
      expect(check.hasAccess).toBe(false);
    });
  });

  // ============================================================
  // Institute scoping
  // ============================================================
  describe('institute scoping', () => {
    it('denies access to a student in another institute', async () => {
      const adminA = await makeUser();
      const userB = await makeUser();
      const { institute: instituteA } = await makeInstitute(adminA.id);
      const { institute: instituteB } = await makeInstitute(userB.id);

      const { student: studentA } = await makeStudent(adminA.id);
      await enrollStudent(instituteA.id, studentA.id, adminA.id);

      // userB is in instituteB but has no link to studentA.
      const check = await studentService.verifyStudentAccess(studentA.id, userB.id);
      expect(check.hasAccess).toBe(false);
    });

    it('grants institute admins access to enrolled students with no direct link', async () => {
      // Owner creates the institute and the student, then enrolls (owner has both
      // institute membership and student access, satisfying assignStudentToInstitute).
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id, { type: 'school' });
      const { student } = await makeStudent(owner.id);
      await enrollStudent(institute.id, student.id, owner.id);

      // A second user joins as institute admin with no userStudents link.
      const otherAdmin = await makeUser();
      await addUserToInstitute(institute.id, otherAdmin.id, { isAdmin: true });

      const check = await studentService.verifyStudentAccess(student.id, otherAdmin.id);
      expect(check.hasAccess).toBe(true);
    });

    it('blocks non-admin members of a school from non-linked students', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id, { type: 'school' });
      const { student } = await makeStudent(owner.id);
      await enrollStudent(institute.id, student.id, owner.id);

      // staffMember joins as non-admin staff, no userStudents link.
      const staffMember = await makeUser();
      await addUserToInstitute(institute.id, staffMember.id, {
        role: 'staff',
        isAdmin: false,
      });

      const check = await studentService.verifyStudentAccess(student.id, staffMember.id);
      expect(check.hasAccess).toBe(false);
    });

    it('grants any family-institute member full access to enrolled students', async () => {
      const familyOwner = await makeUser();
      const familyMember = await makeUser();
      const { institute: family } = await makeInstitute(familyOwner.id, {
        type: 'family',
      });

      const { student } = await makeStudent(familyOwner.id);
      await enrollStudent(family.id, student.id, familyOwner.id);

      // Add familyMember to the family institute as a non-admin.
      await addUserToInstitute(family.id, familyMember.id, {
        role: 'staff',
        isAdmin: false,
      });

      const check = await studentService.verifyStudentAccess(student.id, familyMember.id);
      expect(check.hasAccess).toBe(true);
    });
  });

  // ============================================================
  // Cross-institute sharing
  // ============================================================
  describe('cross-institute sharing', () => {
    it('end-to-end: invite → guardian approve → redeem → accept materializes objectShares', async () => {
      // Source side: a user is BOTH the source institute admin AND the student's guardian
      // (role-collapse path — auto-approves on creation).
      const sourceAdmin = await makeUser();
      const targetAdmin = await makeUser();

      const { institute: sourceInst } = await makeInstitute(sourceAdmin.id, {
        type: 'school',
        name: 'Source School',
      });
      const { institute: targetInst } = await makeInstitute(targetAdmin.id, {
        type: 'school',
        name: 'Target School',
      });

      const { student } = await makeStudent(sourceAdmin.id);
      await enrollStudent(sourceInst.id, student.id, sourceAdmin.id);

      // Create a shareable incident owned by the source institute.
      const incident = await incidentRepository.create({
        studentId: student.id,
        instituteId: sourceInst.id,
        type: 'medical',
        severity: 'moderate',
        recordedAt: new Date(),
        isSensitive: false,
        sensitivityCategory: 'medical',
      } as any);

      // 1. createInvite (auto-approves: createdByUserId === guardianUserId)
      const { invite, code } = await studentShareInviteService.createInvite({
        studentId: student.id,
        sourceInstituteId: sourceInst.id,
        createdByUserId: sourceAdmin.id,
        guardianUserId: sourceAdmin.id,
        bundle: {
          objects: [{ type: 'incident', id: incident.id, isSensitive: false }],
          standingTypes: [],
          permission: 'read',
          shareExpiresAt: null,
          standingExpiresAt: null,
          sensitiveAcknowledged: true,
        },
      });
      expect(invite.status).toBe('pending_target');
      expect(invite.guardianApprovedAt).toBeInstanceOf(Date);
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(8);

      // 2. redeem at the target institute
      const redeemed = await studentShareInviteService.redeem(
        code,
        targetAdmin.id,
        targetInst.id,
      );
      expect(redeemed.status).toBe('pending_target_confirm');
      expect(redeemed.targetInstituteId).toBe(targetInst.id);

      // 3. accept at the target institute
      const result = await studentShareInviteService.accept(invite.id, targetAdmin.id);
      expect(result.invite.status).toBe('accepted');
      expect(result.objectShares).toHaveLength(1);
      expect(result.objectShares[0].objectId).toBe(incident.id);
      expect(result.objectShares[0].targetInstituteId).toBe(targetInst.id);

      // Persisted in DB
      const persisted = await db
        .select()
        .from(objectShares)
        .where(eq(objectShares.shareInviteId, invite.id));
      expect(persisted).toHaveLength(1);
      expect(persisted[0].objectId).toBe(incident.id);
    });

    it('rejects a non-admin redeemer at the target institute', async () => {
      const sourceAdmin = await makeUser();
      const targetAdmin = await makeUser();
      const targetStaff = await makeUser();

      const { institute: sourceInst } = await makeInstitute(sourceAdmin.id, {
        type: 'school',
      });
      const { institute: targetInst } = await makeInstitute(targetAdmin.id, {
        type: 'school',
      });
      await addUserToInstitute(targetInst.id, targetStaff.id, { isAdmin: false });

      const { student } = await makeStudent(sourceAdmin.id);
      await enrollStudent(sourceInst.id, student.id, sourceAdmin.id);

      const incident = await incidentRepository.create({
        studentId: student.id,
        instituteId: sourceInst.id,
        type: 'medical',
        severity: 'low',
        recordedAt: new Date(),
        isSensitive: false,
        sensitivityCategory: 'medical',
      } as any);

      const { code } = await studentShareInviteService.createInvite({
        studentId: student.id,
        sourceInstituteId: sourceInst.id,
        createdByUserId: sourceAdmin.id,
        guardianUserId: sourceAdmin.id,
        bundle: {
          objects: [{ type: 'incident', id: incident.id, isSensitive: false }],
          standingTypes: [],
          permission: 'read',
          shareExpiresAt: null,
          standingExpiresAt: null,
          sensitiveAcknowledged: true,
        },
      });

      await expect(
        studentShareInviteService.redeem(code, targetStaff.id, targetInst.id),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    });
  });

  // ============================================================
  // License feature gates (requireLicensePermission middleware)
  // ============================================================
  describe('license feature gates', () => {
    function buildReq(opts: { user: any; isAuth?: boolean }) {
      return {
        isAuthenticated: () => opts.isAuth ?? true,
        user: opts.user,
      } as any;
    }
    function buildRes() {
      const res: any = {};
      res.status = jest.fn(() => res);
      res.json = jest.fn(() => res);
      return res;
    }

    it('blocks users whose institute license has the feature disabled', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);

      // Active license exists, but aacEnabled is false.
      await makeLicense({
        instituteId: institute.id,
        permissions: {
          all: false,
          maxStudents: 5,
          aacEnabled: false,
          boardMakerEnabled: false,
          customAppsEnabled: false,
          unrestrictedAI: false,
          calendar: false,
          dashboardLevel: 0,
          expertAgentsCount: 0,
          deepAnalysisEnabled: false,
        } as any,
      });

      const middleware = requireLicensePermission('aacEnabled');
      const req = buildReq({ user: { id: user.id, isSystemAdmin: false } });
      const res = buildRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'LICENSE_REQUIRED' }),
      );
    });

    it('allows users whose institute license has the feature enabled', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);

      await makeLicense({
        instituteId: institute.id,
        permissions: {
          all: false,
          maxStudents: 5,
          aacEnabled: true,
          boardMakerEnabled: false,
          customAppsEnabled: false,
          unrestrictedAI: false,
          calendar: false,
          dashboardLevel: 0,
          expertAgentsCount: 0,
          deepAnalysisEnabled: false,
        } as any,
      });

      const middleware = requireLicensePermission('aacEnabled');
      const req = buildReq({ user: { id: user.id, isSystemAdmin: false } });
      const res = buildRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('system admins bypass license feature checks', async () => {
      const user = await makeUser({ isSystemAdmin: true });
      // No license at all.
      const middleware = requireLicensePermission('deepAnalysisEnabled');
      const req = buildReq({ user: { id: user.id, isSystemAdmin: true } });
      const res = buildRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const middleware = requireLicensePermission('aacEnabled');
      const req = { isAuthenticated: () => false, user: null } as any;
      const res = buildRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
