/**
 * Cascade-revocation integration tests.
 *
 * When a student's baseline informed-consent record is revoked, every
 * active object_share and standing_share for that student must also be
 * revoked. Each cascade revoke logs its own activity entry tagged with
 * cascade_reason='consent_revoked'.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import {
  makeUser,
  makeStudent,
  makeInstitute,
  makeInstituteUser,
} from '../helpers/factories.js';
import {
  studentContacts,
  studentShareInvites,
  objectShares,
  standingShares,
  programs,
  activityLogs,
} from '@shared/schema';
import { studentRepository } from '../../repositories/studentRepository.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import { studentShareInviteService } from '../../services/sharing/studentShareInviteService.js';
import {
  lookupConsentNotice,
  renderNoticeForHashing,
} from '@shared/legal';

async function setupSharedScenario() {
  // A clinic provisions a student. The parent (guardian) is an admin of a
  // family institute attached to the same student. The clinic shares a
  // program with the family institute via a guardian-approved share invite.
  const clinicAdmin = await makeUser();
  const parent = await makeUser();
  const { institute: clinic } = await makeInstitute(clinicAdmin.id, { type: 'clinic' });
  const { institute: family } = await makeInstitute(parent.id, { type: 'family' });

  const { student } = await makeStudent(parent.id, { country: 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  await instituteRepository.assignStudentToInstitute(clinic.id, student.id);
  await instituteRepository.assignStudentToInstitute(family.id, student.id);

  // Guardian contact for the parent — needed for consent.
  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Parent',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: parent.id,
    isLegalGuardian: true,
  }).returning();

  // Sign baseline consent for the student.
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
  const input: SignConsentInput = {
    studentId: student.id,
    signedByContactId: contact.id,
    locale: 'en',
    consentTextVersion: notice.version,
    consentTextHash: hash,
    thirdPartyRecipients: [],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    identityVerificationMethod: 'in_person_clinician_attested',
    identityVerificationEvidence: { attestingClinicianUserId: clinicAdmin.id },
    nonRepudiationMethod: 'in_person_clinician_attested',
    nonRepudiationEvidence: { attestingClinicianUserId: clinicAdmin.id },
  };
  const consent = await consentService.signConsent(input);

  // Create a draft program owned by the clinic.
  const [program] = await db.insert(programs).values({
    studentId: student.id,
    instituteId: clinic.id,
    name: 'Test program',
    framework: 'tala',
    status: 'draft',
    createdBy: clinicAdmin.id,
  } as any).returning();

  // Create a share invite (clinic → family), guardian-approved + accepted,
  // materializing one object_share and one standing_share.
  const { invite } = await studentShareInviteService.createInvite({
    studentId: student.id,
    sourceInstituteId: clinic.id,
    createdByUserId: clinicAdmin.id,
    guardianUserId: parent.id,
    bundle: {
      objects: [{ type: 'program', id: program.id, isSensitive: false }],
      standingTypes: ['monitor_note'],
      permission: 'read',
      shareExpiresAt: null,
      standingExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      sensitiveAcknowledged: false,
    },
  });

  // Walk it through to accepted state so shares materialize.
  await studentShareInviteService.approveByGuardian(invite.id, parent.id);
  // Need a target-side user with admin in the family institute (parent already).
  // Redeem requires a code — we have the plaintext from create(). Need to
  // simulate target-side acceptance.
  // Simpler: directly set status to accepted and materialize via repository.
  // For test scope, we'll check the precondition that one object share + one
  // standing share land in the DB after acceptance.
  return { clinicAdmin, parent, clinic, family, student, contact, consent, program, invite };
}

describe('Consent cascade revocation', () => {
  afterEach(truncateAll);

  it('cascadeRevokeAllForStudent revokes every active share', async () => {
    // Smaller-scope test: build active shares directly via DB, exercise
    // the cascade method, assert all are revoked + audit entries written.
    const { student, parent, contact, clinic, family, program, consent } =
      await setupSharedScenario();

    // Build the materialized rows directly — bypasses the share-invite
    // state machine for test setup speed.
    const [invite] = await db.insert(studentShareInvites).values({
      studentId: student.id,
      sourceInstituteId: clinic.id,
      targetInstituteId: family.id,
      codeHash: 'fixture-hash-1',
      createdByUserId: parent.id,
      guardianUserId: parent.id,
      status: 'accepted',
      codeExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      guardianApprovedAt: new Date(),
      acceptedAt: new Date(),
      acceptedByUserId: parent.id,
      pendingBundle: {
        objects: [],
        standingTypes: [],
        permission: 'read',
        shareExpiresAt: null,
        standingExpiresAt: null,
        sensitiveAcknowledged: false,
      },
    } as any).returning();

    const [obj1] = await db.insert(objectShares).values({
      objectType: 'program',
      objectId: program.id,
      studentId: student.id,
      sourceInstituteId: clinic.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
    } as any).returning();
    const [std1] = await db.insert(standingShares).values({
      objectTypes: ['monitor_note'],
      studentId: student.id,
      sourceInstituteId: clinic.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
      shareExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    } as any).returning();

    // Sanity: both active.
    expect(obj1.revokedAt).toBeNull();
    expect(std1.revokedAt).toBeNull();

    const result = await studentShareInviteService.cascadeRevokeAllForStudent(
      student.id,
      parent.id,
      'consent_revoked',
    );
    expect(result.objectSharesRevoked).toBe(1);
    expect(result.standingSharesRevoked).toBe(1);

    // Verify both rows now have revokedAt set.
    const remaining = await db
      .select()
      .from(objectShares)
      .where(and(eq(objectShares.studentId, student.id), isNull(objectShares.revokedAt)));
    expect(remaining).toHaveLength(0);
    const standingRemaining = await db
      .select()
      .from(standingShares)
      .where(and(eq(standingShares.studentId, student.id), isNull(standingShares.revokedAt)));
    expect(standingRemaining).toHaveLength(0);

    // Audit entries should carry cascade_reason.
    const logs = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.subjectId1, student.id));
    const cascadeLogs = logs.filter(
      (l) => (l.details as any)?.cascade_reason === 'consent_revoked',
    );
    expect(cascadeLogs.length).toBe(2); // one for object, one for standing
  });

  it('revokeConsent triggers cascade automatically', async () => {
    const { student, parent, clinic, family, program, consent } =
      await setupSharedScenario();

    // Materialize shares as before.
    const [invite] = await db.insert(studentShareInvites).values({
      studentId: student.id,
      sourceInstituteId: clinic.id,
      targetInstituteId: family.id,
      codeHash: 'fixture-hash-2',
      createdByUserId: parent.id,
      guardianUserId: parent.id,
      status: 'accepted',
      codeExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      guardianApprovedAt: new Date(),
      acceptedAt: new Date(),
      acceptedByUserId: parent.id,
      pendingBundle: {
        objects: [], standingTypes: [], permission: 'read',
        shareExpiresAt: null, standingExpiresAt: null, sensitiveAcknowledged: false,
      },
    } as any).returning();
    await db.insert(objectShares).values({
      objectType: 'program',
      objectId: program.id,
      studentId: student.id,
      sourceInstituteId: clinic.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
    } as any);

    // Revoke the baseline consent — should trigger cascade.
    await consentService.revokeConsent({
      consentId: consent.id,
      revokedByUserId: parent.id,
      reason: 'Withdrawn',
    });

    // Cascade is fire-and-forget but awaited inline in the service. Check.
    const remaining = await db
      .select()
      .from(objectShares)
      .where(and(eq(objectShares.studentId, student.id), isNull(objectShares.revokedAt)));
    expect(remaining).toHaveLength(0);
  });
});
