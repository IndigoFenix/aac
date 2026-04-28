/**
 * Student informed-consent integration tests.
 *
 * Exercises the consent service end-to-end against a real Postgres test DB.
 * Covers happy-path signing, disclosure validation, contact validation,
 * IDV regime gating, hash verification, and revocation.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { studentContacts, type Student } from '@shared/schema';
import {
  consentService,
  ConsentError,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import {
  lookupConsentNotice,
  renderNoticeForHashing,
} from '@shared/legal';

// ---------- helpers ----------

async function makeStudentWithBirthDate(opts: {
  ownerUserId: string;
  birthDate: string;
  country?: string;
  primaryLanguage?: string;
}): Promise<Student> {
  const { student } = await makeStudent(opts.ownerUserId, {
    country: opts.country ?? 'IL',
    primaryLanguage: opts.primaryLanguage ?? 'en',
  });
  // makeStudent doesn't expose birthDate; set it directly via repo.
  const updated = await studentRepository.updateStudent(student.id, {
    birthDate: opts.birthDate,
  } as any);
  return updated as Student;
}

async function makeGuardianContact(args: {
  studentId: string;
  linkedUserId?: string;
  isLegalGuardian?: boolean;
}) {
  const [row] = await db.insert(studentContacts).values({
    studentId: args.studentId,
    name: 'Test Guardian',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: args.linkedUserId ?? null,
    isLegalGuardian: args.isLegalGuardian ?? true,
  }).returning();
  return row;
}

function buildValidIlInput(args: {
  studentId: string;
  signedByContactId: string;
  actingUserId?: string;
}): SignConsentInput {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  const hash = createHash('sha256')
    .update(renderNoticeForHashing(notice.content))
    .digest('hex');
  return {
    studentId: args.studentId,
    signedByContactId: args.signedByContactId,
    locale: 'en',
    consentTextVersion: notice.version,
    consentTextHash: hash,
    thirdPartyRecipients: [
      { category: 'cloud_hosting', name: 'AWS (eu-west-1)', purpose: 'Data hosting' },
      { category: 'llm_provider', name: 'Google Gemini Live', purpose: 'AAC interaction' },
    ],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    optInModelTraining: false,
    optInAdvertising: false,
    optInThirdPartyResearch: false,
    optInMarketingComms: false,
    identityVerificationMethod: 'in_person_clinician_attested',
    identityVerificationEvidence: { attestingClinicianUserId: 'fixture-clinician' },
    nonRepudiationMethod: 'in_person_clinician_attested',
    nonRepudiationEvidence: { attestingClinicianUserId: 'fixture-clinician' },
    actingUserId: args.actingUserId ?? null,
  };
}

// ---------- tests ----------

describe('Consent service integration', () => {
  afterEach(truncateAll);

  describe('signConsent — happy path', () => {
    it('signs a valid IL consent for a 5-year-old', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2021-01-15',
        country: 'IL',
      });
      const contact = await makeGuardianContact({
        studentId: student.id,
        linkedUserId: owner.id,
      });

      const input = buildValidIlInput({
        studentId: student.id,
        signedByContactId: contact.id,
        actingUserId: owner.id,
      });
      const record = await consentService.signConsent(input);

      expect(record.id).toBeDefined();
      expect(record.country).toBe('IL');
      expect(record.consentTextVersion).toBe('IL.2026.04');
      expect(record.isMinorEnhancedProtection).toBe(true);
      expect(record.enhancedProtectionRegime).toBe('il_general');
      expect(record.optInsForcedOff).toBe(false); // IL doesn't force opt-ins
      expect(record.identityVerificationMethod).toBe('in_person_clinician_attested');
      expect(record.revokedAt).toBeNull();
    });

    it('persists frozen birth-date-derived age', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2010-06-01', // ~15 years old as of 2026-04
        country: 'IL',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      const record = await consentService.signConsent(
        buildValidIlInput({ studentId: student.id, signedByContactId: contact.id }),
      );
      expect(record.ageAtSigningYears).toBeGreaterThanOrEqual(15);
      expect(record.ageAtSigningYears).toBeLessThanOrEqual(16);
    });
  });

  describe('signConsent — validation', () => {
    it('rejects missing disclosures', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      const input = buildValidIlInput({ studentId: student.id, signedByContactId: contact.id });
      input.purposeAcknowledged = false;

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'disclosures_required',
      });
    });

    it('rejects a contact that is not the legal guardian', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const contact = await makeGuardianContact({
        studentId: student.id,
        isLegalGuardian: false,
      });
      const input = buildValidIlInput({ studentId: student.id, signedByContactId: contact.id });

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'contact_not_legal_guardian',
      });
    });

    it('rejects a contact attached to a different student', async () => {
      const owner = await makeUser();
      const studentA = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const studentB = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const contactForB = await makeGuardianContact({ studentId: studentB.id });

      const input = buildValidIlInput({
        studentId: studentA.id,
        signedByContactId: contactForB.id,
      });
      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'contact_not_for_student',
      });
    });

    it('rejects an IDV method not accepted for the regime', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
        country: 'IL',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      const input = buildValidIlInput({ studentId: student.id, signedByContactId: contact.id });
      // credit_card_match is COPPA-only — not accepted in il_sensitive
      input.identityVerificationMethod = 'credit_card_match';
      input.nonRepudiationMethod = 'credit_card_match';

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'idv_not_acceptable',
      });
    });

    it('rejects a hash mismatch (UI/server drift)', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      const input = buildValidIlInput({ studentId: student.id, signedByContactId: contact.id });
      input.consentTextHash = 'definitely-not-the-real-hash';

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'notice_hash_mismatch',
      });
    });

    it('rejects a country with no notice version yet (US)', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
        country: 'US',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      // We can't even build a valid input without a notice — passing an IL
      // version against a US student exercises the version mismatch path.
      const input = buildValidIlInput({ studentId: student.id, signedByContactId: contact.id });
      // Force the IDV method to a COPPA-acceptable one so we get past that gate.
      input.identityVerificationMethod = 'gov_sso';
      input.nonRepudiationMethod = 'gov_sso';

      await expect(consentService.signConsent(input)).rejects.toThrow(ConsentError);
    });

    it('rejects when the student has no birth date', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id, { country: 'IL' });
      const contact = await makeGuardianContact({ studentId: student.id });
      const input = buildValidIlInput({ studentId: student.id, signedByContactId: contact.id });

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'student_missing_birth_date',
      });
    });
  });

  describe('revokeConsent', () => {
    it('revokes an active consent and refuses double-revoke', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      const signed = await consentService.signConsent(
        buildValidIlInput({ studentId: student.id, signedByContactId: contact.id }),
      );

      const revoked = await consentService.revokeConsent({
        consentId: signed.id,
        revokedByUserId: owner.id,
        reason: 'parent withdrew',
      });
      expect(revoked.revokedAt).not.toBeNull();
      expect(revoked.revokedByUserId).toBe(owner.id);
      expect(revoked.revocationReason).toBe('parent withdrew');

      await expect(
        consentService.revokeConsent({ consentId: signed.id, revokedByUserId: owner.id }),
      ).rejects.toMatchObject({ code: 'consent_already_revoked' });
    });
  });

  describe('getActiveConsent', () => {
    it('returns active consent and excludes revoked rows', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({
        ownerUserId: owner.id,
        birthDate: '2018-01-01',
      });
      const contact = await makeGuardianContact({ studentId: student.id });
      const first = await consentService.signConsent(
        buildValidIlInput({ studentId: student.id, signedByContactId: contact.id }),
      );

      const active1 = await consentService.getActiveConsent(student.id);
      expect(active1?.id).toBe(first.id);

      await consentService.revokeConsent({
        consentId: first.id,
        revokedByUserId: owner.id,
      });
      const active2 = await consentService.getActiveConsent(student.id);
      expect(active2).toBeNull();
    });
  });
});
