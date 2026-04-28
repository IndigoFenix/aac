/**
 * Consent gate integration tests.
 *
 * Verifies the requireActiveConsent / getConsentSnapshot helpers and the
 * CONSENT_GATE_ENABLED feature flag that controls whether the gate blocks.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { studentContacts, students } from '@shared/schema';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import {
  requireActiveConsent,
  getConsentSnapshot,
  ConsentGateError,
} from '../../services/consent/consentGate.js';
import {
  lookupConsentNotice,
  renderNoticeForHashing,
} from '@shared/legal';

const ENV_FLAG = 'CONSENT_GATE_ENABLED';

async function setupStudentWithGuardian() {
  const owner = await makeUser();
  const { student } = await makeStudent(owner.id, { country: 'IL' });
  const updated = await studentRepository.updateStudent(student.id, {
    birthDate: '2018-01-01',
  } as any);
  const [contact] = await db.insert(studentContacts).values({
    studentId: updated!.id,
    name: 'Test Guardian',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: owner.id,
    isLegalGuardian: true,
  }).returning();
  return { owner, student: updated!, contact };
}

function buildSignInput(args: { studentId: string; signedByContactId: string }): SignConsentInput {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
  return {
    studentId: args.studentId,
    signedByContactId: args.signedByContactId,
    locale: 'en',
    consentTextVersion: notice.version,
    consentTextHash: hash,
    thirdPartyRecipients: [],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    identityVerificationMethod: 'in_person_clinician_attested',
    identityVerificationEvidence: { attestingClinicianUserId: 'fixture' },
    nonRepudiationMethod: 'in_person_clinician_attested',
    nonRepudiationEvidence: { attestingClinicianUserId: 'fixture' },
  };
}

describe('Consent gate', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env[ENV_FLAG];
  });

  afterEach(async () => {
    if (originalFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = originalFlag;
    await truncateAll();
  });

  describe('requireActiveConsent — flag disabled', () => {
    it('is a no-op when CONSENT_GATE_ENABLED is unset', async () => {
      delete process.env[ENV_FLAG];
      const { student } = await setupStudentWithGuardian();
      // No consent exists for this student. Gate disabled → no throw.
      await expect(requireActiveConsent(student.id)).resolves.toBeUndefined();
    });

    it('is a no-op when CONSENT_GATE_ENABLED is "false"', async () => {
      process.env[ENV_FLAG] = 'false';
      const { student } = await setupStudentWithGuardian();
      await expect(requireActiveConsent(student.id)).resolves.toBeUndefined();
    });
  });

  describe('requireActiveConsent — flag enabled', () => {
    beforeEach(() => {
      process.env[ENV_FLAG] = 'true';
    });

    it('throws ConsentGateError when no consent record exists', async () => {
      const { student } = await setupStudentWithGuardian();
      await expect(requireActiveConsent(student.id)).rejects.toBeInstanceOf(ConsentGateError);
    });

    it('passes when an active consent record exists', async () => {
      const { student, contact } = await setupStudentWithGuardian();
      await consentService.signConsent(buildSignInput({
        studentId: student.id,
        signedByContactId: contact.id,
      }));
      await expect(requireActiveConsent(student.id)).resolves.toBeUndefined();
    });

    it('throws again after the consent is revoked', async () => {
      const { owner, student, contact } = await setupStudentWithGuardian();
      const signed = await consentService.signConsent(buildSignInput({
        studentId: student.id,
        signedByContactId: contact.id,
      }));
      await requireActiveConsent(student.id); // ok while active

      await consentService.revokeConsent({
        consentId: signed.id,
        revokedByUserId: owner.id,
      });
      await expect(requireActiveConsent(student.id)).rejects.toBeInstanceOf(ConsentGateError);
    });
  });

  describe('requireActiveConsent — legacy grace window', () => {
    beforeEach(() => {
      process.env[ENV_FLAG] = 'true';
    });

    it('passes when the student has a future legacy_consent_deadline', async () => {
      const { student } = await setupStudentWithGuardian();
      // setupStudentWithGuardian creates a fresh student (deadline starts null).
      // Set a deadline ~30 days in the future to simulate legacy backfill.
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await db.update(students)
        .set({ legacyConsentDeadline: future })
        .where(eq(students.id, student.id));

      await expect(requireActiveConsent(student.id)).resolves.toBeUndefined();
    });

    it('throws when the legacy deadline has elapsed', async () => {
      const { student } = await setupStudentWithGuardian();
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await db.update(students)
        .set({ legacyConsentDeadline: past })
        .where(eq(students.id, student.id));

      await expect(requireActiveConsent(student.id)).rejects.toBeInstanceOf(ConsentGateError);
    });

    it('throws when the deadline is null (new student, no consent)', async () => {
      const { student } = await setupStudentWithGuardian();
      // Default for new students is null.
      await expect(requireActiveConsent(student.id)).rejects.toBeInstanceOf(ConsentGateError);
    });
  });

  describe('getConsentSnapshot', () => {
    it('returns null when no active consent exists (regardless of flag)', async () => {
      const { student } = await setupStudentWithGuardian();
      delete process.env[ENV_FLAG];
      expect(await getConsentSnapshot(student.id)).toBeNull();
      process.env[ENV_FLAG] = 'true';
      expect(await getConsentSnapshot(student.id)).toBeNull();
    });

    it('returns frozen disclosures and opt-ins from the active record', async () => {
      const { student, contact } = await setupStudentWithGuardian();
      const input = buildSignInput({ studentId: student.id, signedByContactId: contact.id });
      input.optInModelTraining = true; // IL doesn't force off
      await consentService.signConsent(input);

      const snap = await getConsentSnapshot(student.id);
      expect(snap).not.toBeNull();
      expect(snap!.country).toBe('IL');
      expect(snap!.regime).toBe('il_general');
      expect(snap!.optIns.model_training).toBe(true);
      expect(snap!.optIns.advertising).toBe(false);
      expect(snap!.optInsForcedOff).toBe(false);
    });
  });
});
