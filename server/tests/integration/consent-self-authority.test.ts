/**
 * Integration tests for per-student consent authority (guardian vs. self),
 * the self-consent signing path, and the consent-authority review cron.
 *
 * Covers:
 *   - Self-consent: an adult signs for themselves (no guardian contact).
 *   - IDV gating for self: authenticated_session works for non-sensitive but
 *     not sensitive; verified_phone_otp works for sensitive (IL).
 *   - signer_not_permitted when a guardian contact is passed for a self student.
 *   - guardianship_basis_required for an adult under guardian_required.
 *   - consentAuthorityService.setConsentAuthority validation + event.
 *   - runConsentAuthorityReviewCheck flags adult auto students with a
 *     guardian-signed consent; idempotent; skips overridden students.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { studentContacts, studentConsentRecords, activityLogs, type Student } from '@shared/schema';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import {
  consentAuthorityService,
  ConsentAuthorityError,
} from '../../services/consent/consentAuthorityService.js';
import { runConsentAuthorityReviewCheck } from '../../services/consent/consentThresholdCron.js';
import { lookupConsentNotice, renderNoticeForHashing } from '@shared/legal';

// ---------- helpers ----------

const ADULT_BIRTHDATE = '2000-01-01'; // ~26 as of 2026
const MINOR_BIRTHDATE = '2018-01-01';

async function makeStudentWithBirthDate(opts: {
  ownerUserId: string;
  birthDate: string;
  country?: string;
}): Promise<Student> {
  const { student } = await makeStudent(opts.ownerUserId, {
    country: opts.country ?? 'IL',
    primaryLanguage: 'en',
  });
  const updated = await studentRepository.updateStudent(student.id, {
    birthDate: opts.birthDate,
  } as any);
  return updated as Student;
}

// activityLogService.log() is fire-and-forget (detached insert), so the row
// appears slightly after the call returns. Poll until it's visible.
async function waitForLogCount(
  where: ReturnType<typeof and>,
  expected: number,
  tries = 40,
): Promise<number> {
  let count = 0;
  for (let i = 0; i < tries; i++) {
    const rows = await db.select().from(activityLogs).where(where);
    count = rows.length;
    if (count >= expected) return count;
    await new Promise((r) => setTimeout(r, 50));
  }
  return count;
}

function ilHash(): { version: string; hash: string } {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
  return { version: notice.version, hash };
}

function buildSelfInput(args: {
  studentId: string;
  signedByUserId?: string | null;
  idvMethod?: string;
  isSensitive?: boolean;
}): SignConsentInput {
  const { version, hash } = ilHash();
  const method = args.idvMethod ?? 'in_person_clinician_attested';
  return {
    studentId: args.studentId,
    signedByUserId: args.signedByUserId ?? null,
    locale: 'en',
    consentTextVersion: version,
    consentTextHash: hash,
    thirdPartyRecipients: [
      { category: 'cloud_hosting', name: 'AWS (eu-west-1)', purpose: 'Data hosting' },
    ],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    identityVerificationMethod: method,
    identityVerificationEvidence: {},
    nonRepudiationMethod: method,
    nonRepudiationEvidence: {},
    isSensitive: args.isSensitive,
    actingUserId: args.signedByUserId ?? null,
  };
}

// ---------- tests ----------

describe('consent self-authority integration', () => {
  afterEach(truncateAll);

  describe('self-consent signing', () => {
    it('an adult signs for themselves — no guardian contact', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });

      const record = await consentService.signConsent(
        buildSelfInput({ studentId: student.id, signedByUserId: owner.id }),
      );

      expect(record.signerType).toBe('self');
      expect(record.signedByContactId).toBeNull();
      expect(record.signedByUserId).toBe(owner.id);
      expect(record.consentAuthorityBasis).toBe('self_age');
      // An adult is past the IL protection threshold → no enhanced protection.
      expect(record.isMinorEnhancedProtection).toBe(false);
    });

    it('rejects a guardian contact passed for a self-consenting student', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      const [contact] = await db.insert(studentContacts).values({
        studentId: student.id,
        name: 'Parent',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        isLegalGuardian: true,
      }).returning();

      const input = buildSelfInput({ studentId: student.id, signedByUserId: owner.id });
      input.signedByContactId = contact.id;

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'signer_not_permitted',
      });
    });

    it('accepts authenticated_session for non-sensitive self-consent', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      const record = await consentService.signConsent(
        buildSelfInput({
          studentId: student.id,
          signedByUserId: owner.id,
          idvMethod: 'authenticated_session',
          isSensitive: false,
        }),
      );
      expect(record.signerType).toBe('self');
    });

    it('rejects authenticated_session for sensitive self-consent', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      await expect(
        consentService.signConsent(
          buildSelfInput({
            studentId: student.id,
            signedByUserId: owner.id,
            idvMethod: 'authenticated_session',
            isSensitive: true,
          }),
        ),
      ).rejects.toMatchObject({ code: 'idv_not_acceptable' });
    });

    it('accepts verified_phone_otp for sensitive self-consent (magic-link path)', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      const record = await consentService.signConsent(
        buildSelfInput({
          studentId: student.id,
          signedByUserId: null,
          idvMethod: 'verified_phone_otp',
          isSensitive: true,
        }),
      );
      expect(record.signerType).toBe('self');
      expect(record.identityVerificationMethod).toBe('verified_phone_otp');
    });
  });

  describe('guardian_required override', () => {
    it('rejects guardian sign for an adult without a guardianship basis', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      await studentRepository.updateStudent(student.id, { consentAuthority: 'guardian_required' } as any);
      const [contact] = await db.insert(studentContacts).values({
        studentId: student.id,
        name: 'Guardian',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        isLegalGuardian: true,
      }).returning();

      const input = buildSelfInput({ studentId: student.id });
      input.signedByContactId = contact.id;

      await expect(consentService.signConsent(input)).rejects.toMatchObject({
        code: 'guardianship_basis_required',
      });
    });

    it('accepts guardian sign for an adult once a basis is recorded', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      await studentRepository.updateStudent(student.id, {
        consentAuthority: 'guardian_required',
        guardianshipBasis: 'court_appointed_guardian',
      } as any);
      const [contact] = await db.insert(studentContacts).values({
        studentId: student.id,
        name: 'Guardian',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        isLegalGuardian: true,
      }).returning();

      const input = buildSelfInput({ studentId: student.id });
      input.signedByContactId = contact.id;
      const record = await consentService.signConsent(input);
      expect(record.signerType).toBe('guardian');
      expect(record.signedByContactId).toBe(contact.id);
      expect(record.consentAuthorityBasis).toBe('court_appointed_guardian');
    });
  });

  describe('consentAuthorityService.setConsentAuthority', () => {
    it('requires a basis for an adult set to guardian_required', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      await expect(
        consentAuthorityService.setConsentAuthority(student.id, { mode: 'guardian_required' }, owner.id),
      ).rejects.toBeInstanceOf(ConsentAuthorityError);
    });

    it('persists the determination and logs an event', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      const updated = await consentAuthorityService.setConsentAuthority(
        student.id,
        { mode: 'guardian_required', basis: 'supported_decision_making', evidence: { ref: 'court-123' }, reviewDate: '2027-01-01' },
        owner.id,
      );
      expect(updated?.consentAuthority).toBe('guardian_required');
      expect(updated?.guardianshipBasis).toBe('supported_decision_making');

      const where = and(
        eq(activityLogs.eventType, 'consent_authority_set'),
        eq(activityLogs.subjectId1, student.id),
      );
      const count = await waitForLogCount(where, 1);
      expect(count).toBe(1);
      const logs = await db.select().from(activityLogs).where(where);
      expect((logs[0].details as any).mode).toBe('guardian_required');
    });

    it('clears guardianship fields when switching away from guardian_required', async () => {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      await consentAuthorityService.setConsentAuthority(
        student.id,
        { mode: 'guardian_required', basis: 'court_appointed_guardian' },
        owner.id,
      );
      const updated = await consentAuthorityService.setConsentAuthority(student.id, { mode: 'auto' }, owner.id);
      expect(updated?.consentAuthority).toBe('auto');
      expect(updated?.guardianshipBasis).toBeNull();
    });
  });

  describe('runConsentAuthorityReviewCheck cron', () => {
    async function setupAdultWithGuardianConsent(consentAuthority: string) {
      const owner = await makeUser();
      const student = await makeStudentWithBirthDate({ ownerUserId: owner.id, birthDate: ADULT_BIRTHDATE });
      await studentRepository.updateStudent(student.id, { consentAuthority } as any);
      const [contact] = await db.insert(studentContacts).values({
        studentId: student.id,
        name: 'Guardian',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        isLegalGuardian: true,
      }).returning();
      const [consent] = await db.insert(studentConsentRecords).values({
        studentId: student.id,
        signedByContactId: contact.id,
        signerType: 'guardian',
        country: 'IL',
        ageAtSigningYears: 10,
        isMinorEnhancedProtection: true,
        enhancedProtectionRegime: 'il_general',
        consentTextVersion: 'IL.2026.04',
        consentTextHash: 'a'.repeat(64),
        thirdPartyRecipients: [],
        purposeAcknowledged: true,
        voluntarinessAcknowledged: true,
        thirdPartyTransfersAcknowledged: true,
        optInModelTraining: false,
        optInAdvertising: false,
        optInThirdPartyResearch: false,
        optInMarketingComms: false,
        optInsForcedOff: false,
        identityVerificationMethod: 'in_person_clinician_attested',
        identityVerificationEvidence: {},
        nonRepudiationMethod: 'in_person_clinician_attested',
        nonRepudiationEvidence: {},
      } as any).returning();
      return { owner, student, consent };
    }

    it('flags an auto adult with a guardian-signed consent, once', async () => {
      const { student } = await setupAdultWithGuardianConsent('auto');
      const r1 = await runConsentAuthorityReviewCheck();
      expect(r1.flagged).toBe(1);

      // Wait for the detached log write to commit before asserting/re-running,
      // so the dedupe query in the second run sees it.
      const where = and(
        eq(activityLogs.eventType, 'consent_authority_review_required'),
        eq(activityLogs.subjectId1, student.id),
      );
      const count = await waitForLogCount(where, 1);
      expect(count).toBe(1);

      const r2 = await runConsentAuthorityReviewCheck();
      expect(r2.flagged).toBe(0); // idempotent

    });

    it('does not flag a student already overridden to guardian_required', async () => {
      await setupAdultWithGuardianConsent('guardian_required');
      const r = await runConsentAuthorityReviewCheck();
      expect(r.flagged).toBe(0);
    });
  });
});
