/**
 * Auto-create-guardian-contact integration tests.
 *
 * Covers the helper that auto-creates a studentContacts row when a
 * family-institute admin creates a student in their family institute.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
} from '../helpers/factories.js';
import { studentContacts } from '@shared/schema';
import { autoCreateGuardianContactForFamilyAdmin } from '../../services/consent/guardianContactAutoCreate.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { licenseRepository } from '../../repositories/licenseRepository.js';

describe('autoCreateGuardianContactForFamilyAdmin', () => {
  afterEach(truncateAll);

  it('creates a guardian contact for a family-institute admin', async () => {
    const owner = await makeUser({ firstName: 'Sarah', lastName: 'Cohen' });
    const { institute } = await makeInstitute(owner.id, { type: 'family' });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    const created = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: owner.id,
      instituteIds: [institute.id],
    });

    expect(created).not.toBeNull();
    expect(created!.studentId).toBe(student.id);
    expect(created!.linkedUserId).toBe(owner.id);
    expect(created!.role).toBe('parent_guardian');
    expect(created!.relationship).toBe('parent_guardian');
    expect(created!.isLegalGuardian).toBe(false); // wizard sets to true on consent
    expect(created!.contactEmail).toBe(owner.email);
  });

  it('returns null when no family institute is in scope', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'school' });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    const created = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: owner.id,
      instituteIds: [institute.id],
    });
    expect(created).toBeNull();
  });

  it('returns null when the user is not admin of the family institute', async () => {
    const owner = await makeUser();
    const otherUser = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'family' });
    const { student } = await makeStudent(otherUser.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    const created = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: otherUser.id,
      instituteIds: [institute.id],
    });
    expect(created).toBeNull();
  });

  it('is idempotent — second call returns the existing row', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'family' });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    const first = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: owner.id,
      instituteIds: [institute.id],
    });
    const second = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: owner.id,
      instituteIds: [institute.id],
    });

    expect(first!.id).toBe(second!.id);
    const all = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.studentId, student.id));
    expect(all).toHaveLength(1);
  });

  it('prefills government-ID fields when license inviteDefaults carries them', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'family' });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    // Attach a license with inviteDefaults carrying gov-ID fields.
    await licenseRepository.createLicense({
      name: 'Family License',
      licenseType: 'standard',
      subscriptionType: 'monthly',
      inviteEmail: owner.email,
      instituteId: institute.id,
      isActive: true,
      inviteDefaults: {
        firstName: 'Sarah',
        lastName: 'Cohen',
        governmentIdNumber: '123456789',
        governmentIdType: 'national_id',
        governmentIdCountry: 'IL',
      },
    } as any);

    const created = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: owner.id,
      instituteIds: [institute.id],
    });

    expect(created).not.toBeNull();
    expect(created!.governmentIdNumber).toBe('123456789');
    expect(created!.governmentIdType).toBe('national_id');
    expect(created!.governmentIdCountry).toBe('IL');
    expect(created!.governmentIdVerifiedVia).toBe('manual_entry');
    expect(created!.governmentIdVerificationProvider).toBe('admin_attested');
    expect(created!.governmentIdVerifiedAt).not.toBeNull();
  });

  it('skips gov-ID fields when license has no inviteDefaults gov-ID', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'family' });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    await licenseRepository.createLicense({
      name: 'License',
      licenseType: 'standard',
      subscriptionType: 'monthly',
      inviteEmail: owner.email,
      instituteId: institute.id,
      isActive: true,
      inviteDefaults: { firstName: 'Sarah', lastName: 'Cohen' },
    } as any);

    const created = await autoCreateGuardianContactForFamilyAdmin({
      studentId: student.id,
      creatingUserId: owner.id,
      instituteIds: [institute.id],
    });

    expect(created!.governmentIdNumber).toBeNull();
    expect(created!.governmentIdVerifiedVia).toBeNull();
  });
});
