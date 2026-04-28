/**
 * Tests for the consent gate at the AI memory-schema layer + the prompt
 * status surface that lets the AI know when it's blocked.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent, makeInstitute } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { studentContacts, students } from '@shared/schema';
import { eq } from 'drizzle-orm';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import {
  requireConsentForMemoryWrite,
  getConsentStatus,
  ConsentGateError,
} from '../../services/consent/consentGate.js';
import {
  lookupConsentNotice,
  renderNoticeForHashing,
} from '@shared/legal';

const ENV_FLAG = 'CONSENT_GATE_ENABLED';

async function setup(opts: { withConsent?: boolean; legacyGrace?: 'future' | 'past' | null } = {}) {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
  const { student } = await makeStudent(owner.id, { country: 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);

  // Default: clear legacy grace so a brand-new student starts gated when flag on.
  if (opts.legacyGrace === 'future') {
    await db.update(students)
      .set({ legacyConsentDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
      .where(eq(students.id, student.id));
  } else if (opts.legacyGrace === 'past') {
    await db.update(students)
      .set({ legacyConsentDeadline: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(students.id, student.id));
  } else {
    await db.update(students)
      .set({ legacyConsentDeadline: null })
      .where(eq(students.id, student.id));
  }

  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Test Guardian',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: owner.id,
    isLegalGuardian: true,
  }).returning();

  if (opts.withConsent) {
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
      identityVerificationEvidence: { attestingClinicianUserId: 'fixture' },
      nonRepudiationMethod: 'in_person_clinician_attested',
      nonRepudiationEvidence: { attestingClinicianUserId: 'fixture' },
    };
    await consentService.signConsent(input);
  }
  return { owner, institute, student, contact };
}

describe('Consent gate — memory-schema layer', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env[ENV_FLAG]; });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  describe('requireConsentForMemoryWrite helper', () => {
    it('throws ConsentGateError with AI-readable message when blocked', async () => {
      process.env[ENV_FLAG] = 'true';
      const { student } = await setup();
      const ctx = { all: { studentId: student.id } };
      try {
        await requireConsentForMemoryWrite(ctx);
        throw new Error('expected throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ConsentGateError);
        expect(e.code).toBe('consent_required');
        // Message must be self-explanatory and actionable for the AI.
        expect(e.message).toMatch(/no active informed-consent record/i);
        expect(e.message).toMatch(/consent wizard/i);
        expect(e.studentId).toBe(student.id);
      }
    });

    it('passes when an active consent record exists', async () => {
      process.env[ENV_FLAG] = 'true';
      const { student } = await setup({ withConsent: true });
      const ctx = { all: { studentId: student.id } };
      await expect(requireConsentForMemoryWrite(ctx)).resolves.toBeUndefined();
    });

    it('passes when gate is disabled regardless of consent', async () => {
      delete process.env[ENV_FLAG];
      const { student } = await setup();
      const ctx = { all: { studentId: student.id } };
      await expect(requireConsentForMemoryWrite(ctx)).resolves.toBeUndefined();
    });

    it('is a no-op when ctx has no studentId', async () => {
      process.env[ENV_FLAG] = 'true';
      const ctx = { all: {} };
      await expect(requireConsentForMemoryWrite(ctx)).resolves.toBeUndefined();
    });
  });

  describe('getConsentStatus snapshot', () => {
    it('reports gateEnabled=false when env flag is off', async () => {
      delete process.env[ENV_FLAG];
      const { student } = await setup();
      const status = await getConsentStatus(student.id);
      expect(status.gateEnabled).toBe(false);
      expect(status.writesAllowed).toBe(true);
      expect(status.hasActiveConsent).toBe(false);
    });

    it('reports writesAllowed=false when gate on, no consent, no grace', async () => {
      process.env[ENV_FLAG] = 'true';
      const { student } = await setup();
      const status = await getConsentStatus(student.id);
      expect(status.gateEnabled).toBe(true);
      expect(status.hasActiveConsent).toBe(false);
      expect(status.inLegacyGrace).toBe(false);
      expect(status.writesAllowed).toBe(false);
    });

    it('reports writesAllowed=true when in legacy grace', async () => {
      process.env[ENV_FLAG] = 'true';
      const { student } = await setup({ legacyGrace: 'future' });
      const status = await getConsentStatus(student.id);
      expect(status.inLegacyGrace).toBe(true);
      expect(status.writesAllowed).toBe(true);
      expect(status.legacyConsentDeadline).not.toBeNull();
    });

    it('reports writesAllowed=true when active consent exists', async () => {
      process.env[ENV_FLAG] = 'true';
      const { student } = await setup({ withConsent: true });
      const status = await getConsentStatus(student.id);
      expect(status.hasActiveConsent).toBe(true);
      expect(status.writesAllowed).toBe(true);
    });

    it('reports writesAllowed=false when grace has elapsed', async () => {
      process.env[ENV_FLAG] = 'true';
      const { student } = await setup({ legacyGrace: 'past' });
      const status = await getConsentStatus(student.id);
      expect(status.inLegacyGrace).toBe(false);
      expect(status.writesAllowed).toBe(false);
    });
  });
});
