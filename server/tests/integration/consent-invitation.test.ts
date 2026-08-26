/**
 * Token-based consent-invitation flow tests.
 *
 * Covers: create → returns plaintext code only once; redeem context lookup;
 * sign-with-token populates contact + consent record + marks invitation
 * redeemed; expiry rejection; double-use rejection; revoke.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq, and } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent, makeInstitute } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { studentContacts, consentInvitations, instituteStudents } from '@shared/schema';
import {
  consentInvitationService,
  ConsentInvitationError,
} from '../../services/consent/consentInvitationService.js';
import { consentInvitationRepository } from '../../repositories/consentInvitationRepository.js';

async function setup() {
  const clinician = await makeUser();
  const { institute } = await makeInstitute(clinician.id, { type: 'clinic' });
  const { student } = await makeStudent(clinician.id, { country: 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);

  // Parent contact has no linkedUserId — that's the magic-link use case.
  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Parent (no account)',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    contactEmail: 'parent@test.local',
    contactPhone: '+972541234567',
    isLegalGuardian: false,
  }).returning();

  return { clinician, institute, student, contact };
}

describe('Consent invitation service', () => {
  afterEach(truncateAll);

  describe('createInvitation', () => {
    it('returns a plaintext code on creation and persists only the hash', async () => {
      const { clinician, institute, student, contact } = await setup();
      const result = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });
      expect(result.code).toMatch(/^[A-Z0-9]{12}$/);
      expect(result.invitation.codeHash).not.toBe(result.code);
      expect(result.invitation.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.redemptionUrl).toContain(result.code);
    });

    it('defaults the link expiry to 72 hours', async () => {
      const { clinician, institute, student, contact } = await setup();
      const before = Date.now();
      const { invitation } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });
      const ttlMs = new Date(invitation.expiresAt).getTime() - before;
      // ~72h, with slack for test-execution time on either side.
      expect(ttlMs).toBeGreaterThan(71 * 3600_000);
      expect(ttlMs).toBeLessThanOrEqual(72 * 3600_000 + 60_000);
    });

    it('clamps an over-long ttlDays request down to the 72h ceiling', async () => {
      const { clinician, institute, student, contact } = await setup();
      const before = Date.now();
      const { invitation } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
        ttlDays: 30, // would be 720h if honored
      });
      const ttlMs = new Date(invitation.expiresAt).getTime() - before;
      expect(ttlMs).toBeLessThanOrEqual(72 * 3600_000 + 60_000);
    });

    it('rejects when the contact has no email and channel is email', async () => {
      const { clinician, institute, student } = await setup();
      const [contactNoEmail] = await db.insert(studentContacts).values({
        studentId: student.id,
        name: 'Phone-only Parent',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        contactPhone: '+972541234567',
        isLegalGuardian: false,
      }).returning();

      await expect(
        consentInvitationService.createInvitation({
          studentId: student.id,
          contactId: contactNoEmail.id,
          sourceInstituteId: institute.id,
          createdByUserId: clinician.id,
          channel: 'email',
        }),
      ).rejects.toMatchObject({ code: 'contact_missing_channel' });
    });

    it('accepts manual channel without email or phone', async () => {
      const { clinician, institute, student } = await setup();
      const [contactNoChannel] = await db.insert(studentContacts).values({
        studentId: student.id,
        name: 'Walked-in parent',
        relationship: 'parent_guardian',
        role: 'parent_guardian',
        isLegalGuardian: false,
      }).returning();

      const result = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contactNoChannel.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'manual',
      });
      expect(result.invitation.channel).toBe('manual');
      expect(result.invitation.sentTo).toBe('manual');
    });
  });

  describe('redeemContext', () => {
    it('returns wizard context for a valid code', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });

      const ctx = await consentInvitationService.redeemContext(code);
      expect(ctx.student.id).toBe(student.id);
      expect(ctx.contact.id).toBe(contact.id);
      // The redeem context is served to whoever holds the code, BEFORE the
      // guardian has proven who they are — so it must not echo the guardian's
      // contact channels back (2026-08 audit). The wizard uses the signing
      // user's own email, not this field.
      expect(ctx.contact).not.toHaveProperty('contactEmail');
      expect(ctx.contact).not.toHaveProperty('contactPhone');
      expect(ctx.invitationId).toBeDefined();
    });

    it('rejects an unknown code', async () => {
      await expect(
        consentInvitationService.redeemContext('NOTAREALCODE'),
      ).rejects.toMatchObject({ code: 'code_not_found' });
    });

    it('rejects an expired code', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code, invitation } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });
      // Force the expiry into the past.
      await db
        .update(consentInvitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(consentInvitations.id, invitation.id));

      await expect(
        consentInvitationService.redeemContext(code),
      ).rejects.toMatchObject({ code: 'code_expired' });
    });
  });

  describe('signWithToken', () => {
    it('signs consent + flips guardian declaration + marks invitation redeemed', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code, invitation } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });

      const { lookupConsentNotice, renderNoticeForHashing } = await import('@shared/legal');
      const { createHash } = await import('node:crypto');
      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');

      const result = await consentInvitationService.signWithToken({
        code,
        payload: {
          locale: 'en',
          consentTextVersion: notice.version,
          consentTextHash: hash,
          thirdPartyRecipients: [],
          purposeAcknowledged: true,
          voluntarinessAcknowledged: true,
          thirdPartyTransfersAcknowledged: true,
          identityVerificationMethod: 'verified_phone_otp',
          identityVerificationEvidence: {},
          nonRepudiationMethod: 'verified_phone_otp',
          nonRepudiationEvidence: {},
          isSensitive: false, // v1 magic-link path runs as standard regime
        } as any,
        guardianFields: {
          governmentIdNumber: '123456789',
          governmentIdType: 'national_id',
          governmentIdCountry: 'IL',
          coGuardianAcknowledged: true,
        },
        signedFromIp: '203.0.113.7',
        signedFromUserAgent: 'TestAgent/1.0',
      });

      expect(result.consent.id).toBeDefined();
      expect(result.consent.country).toBe('IL');
      expect(result.invitation.redeemedAt).not.toBeNull();
      expect(result.invitation.signedConsentId).toBe(result.consent.id);

      // Contact should now carry isLegalGuardian + gov-ID.
      const [updatedContact] = await db
        .select()
        .from(studentContacts)
        .where(eq(studentContacts.id, contact.id));
      expect(updatedContact.isLegalGuardian).toBe(true);
      expect(updatedContact.coGuardianAcknowledged).toBe(true);
      expect(updatedContact.governmentIdNumber).toBe('123456789');
      expect(updatedContact.governmentIdVerificationProvider).toBe('self_declared_via_magic_link');
    });

    it('threads signature evidence into the consent non-repudiation record', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });

      const { lookupConsentNotice, renderNoticeForHashing } = await import('@shared/legal');
      const { createHash } = await import('node:crypto');
      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');

      const result = await consentInvitationService.signWithToken({
        code,
        payload: {
          locale: 'en',
          consentTextVersion: notice.version,
          consentTextHash: hash,
          thirdPartyRecipients: [],
          purposeAcknowledged: true,
          voluntarinessAcknowledged: true,
          thirdPartyTransfersAcknowledged: true,
          identityVerificationMethod: 'verified_phone_otp',
          identityVerificationEvidence: {},
          nonRepudiationMethod: 'verified_phone_otp',
          // The controller maps the top-level `signature` field into here; the
          // service is responsible for preserving it on the consent record.
          nonRepudiationEvidence: {
            signature: { mode: 'typed', typedName: 'Jane Parent', signedAt: '2026-05-26T00:00:00Z' },
          },
          isSensitive: false,
        } as any,
        guardianFields: { coGuardianAcknowledged: true },
        signedFromIp: '203.0.113.7',
        signedFromUserAgent: 'TestAgent/1.0',
      });

      const evidence = result.consent.nonRepudiationEvidence as any;
      expect(evidence.signature).toMatchObject({ mode: 'typed', typedName: 'Jane Parent' });
      // Existing magic-link evidence must still be present alongside it.
      expect(evidence.signedViaMagicLink).toBe(true);
      expect(evidence.signedFromIp).toBe('203.0.113.7');
    });

    it('rejects double-use of the same token', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });

      const { lookupConsentNotice, renderNoticeForHashing } = await import('@shared/legal');
      const { createHash } = await import('node:crypto');
      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
      const payload: any = {
        locale: 'en',
        consentTextVersion: notice.version,
        consentTextHash: hash,
        thirdPartyRecipients: [],
        purposeAcknowledged: true,
        voluntarinessAcknowledged: true,
        thirdPartyTransfersAcknowledged: true,
        identityVerificationMethod: 'verified_phone_otp',
        identityVerificationEvidence: {},
        nonRepudiationMethod: 'verified_phone_otp',
        nonRepudiationEvidence: {},
        isSensitive: false,
      };

      await consentInvitationService.signWithToken({ code, payload, guardianFields: { coGuardianAcknowledged: true } });
      await expect(
        consentInvitationService.signWithToken({ code, payload, guardianFields: { coGuardianAcknowledged: true } }),
      ).rejects.toMatchObject({ code: 'code_already_used' });
    });
  });

  describe('signWithToken — SMS-channel OTP gate', () => {
    it('rejects sign for SMS invitations without a verified phone OTP', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'sms',
      });

      const { lookupConsentNotice, renderNoticeForHashing } = await import('@shared/legal');
      const { createHash } = await import('node:crypto');
      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');

      await expect(
        consentInvitationService.signWithToken({
          code,
          payload: {
            locale: 'en',
            consentTextVersion: notice.version,
            consentTextHash: hash,
            thirdPartyRecipients: [],
            purposeAcknowledged: true,
            voluntarinessAcknowledged: true,
            thirdPartyTransfersAcknowledged: true,
            isSensitive: false,
          } as any,
          guardianFields: { coGuardianAcknowledged: true },
        }),
      ).rejects.toMatchObject({ code: 'phone_otp_required' });
    });

    it('signs successfully after a phone OTP is requested + verified', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'sms',
      });

      // Drive the OTP path with the bypass flag so we don't need a real SMS.
      const prevBypass = process.env.SMS_VERIFICATION_BYPASS;
      const prevEnv = process.env.NODE_ENV;
      process.env.SMS_VERIFICATION_BYPASS = 'true';
      process.env.NODE_ENV = 'test';
      try {
        await consentInvitationService.requestPhoneOtp(code);
        await consentInvitationService.verifyPhoneOtp({ code, otpCode: '000000' });

        const { lookupConsentNotice, renderNoticeForHashing } = await import('@shared/legal');
        const { createHash } = await import('node:crypto');
        const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
        const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');

        const result = await consentInvitationService.signWithToken({
          code,
          payload: {
            locale: 'en',
            consentTextVersion: notice.version,
            consentTextHash: hash,
            thirdPartyRecipients: [],
            purposeAcknowledged: true,
            voluntarinessAcknowledged: true,
            thirdPartyTransfersAcknowledged: true,
            isSensitive: false,
          } as any,
          guardianFields: { coGuardianAcknowledged: true },
        });

        expect(result.consent.id).toBeDefined();
        // OTP evidence should be threaded into both legs of the consent record.
        const idv = result.consent.identityVerificationEvidence as any;
        expect(idv.otpVerifiedAt).toBeDefined();
        expect(idv.otpRecordId).toBeDefined();
      } finally {
        if (prevBypass === undefined) delete process.env.SMS_VERIFICATION_BYPASS;
        else process.env.SMS_VERIFICATION_BYPASS = prevBypass;
        if (prevEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevEnv;
      }
    });
  });

  describe('signWithToken — email-channel child-ID gate', () => {
    // Stamp an institute ID on the child's enrollment so the email gate has
    // something to verify against. Full ID '123456789' → last 4 = '6789'.
    async function setChildId(instituteId: string, studentId: string, idNumber: string) {
      await db
        .update(instituteStudents)
        .set({ idNumber })
        .where(and(eq(instituteStudents.instituteId, instituteId), eq(instituteStudents.studentId, studentId)));
    }

    async function noticeHash() {
      const { lookupConsentNotice, renderNoticeForHashing } = await import('@shared/legal');
      const { createHash } = await import('node:crypto');
      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
      return { version: notice.version, hash };
    }

    function payload(version: string, hash: string): any {
      return {
        locale: 'en',
        consentTextVersion: version,
        consentTextHash: hash,
        thirdPartyRecipients: [],
        purposeAcknowledged: true,
        voluntarinessAcknowledged: true,
        thirdPartyTransfersAcknowledged: true,
        identityVerificationMethod: 'verified_phone_otp',
        identityVerificationEvidence: {},
        nonRepudiationMethod: 'verified_phone_otp',
        nonRepudiationEvidence: {},
        isSensitive: false,
      };
    }

    it('exposes requiresIdVerification only when a child ID is on file', async () => {
      const { clinician, institute, student, contact } = await setup();

      const { code: noIdCode } = await consentInvitationService.createInvitation({
        studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id,
        createdByUserId: clinician.id, channel: 'email',
      });
      const ctxNoId = await consentInvitationService.redeemContext(noIdCode);
      expect(ctxNoId.requiresIdVerification).toBe(false);

      await setChildId(institute.id, student.id, '123456789');
      const { code: withIdCode } = await consentInvitationService.createInvitation({
        studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id,
        createdByUserId: clinician.id, channel: 'email',
      });
      const ctxWithId = await consentInvitationService.redeemContext(withIdCode);
      expect(ctxWithId.requiresIdVerification).toBe(true);
      expect(ctxWithId.idVerified).toBe(false);
    });

    it('blocks signing an email invitation until the child ID is verified', async () => {
      const { clinician, institute, student, contact } = await setup();
      await setChildId(institute.id, student.id, '123456789');
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id,
        createdByUserId: clinician.id, channel: 'email',
      });
      const { version, hash } = await noticeHash();

      await expect(
        consentInvitationService.signWithToken({
          code, payload: payload(version, hash),
          guardianFields: { coGuardianAcknowledged: true },
        }),
      ).rejects.toMatchObject({ code: 'child_id_verification_required' });
    });

    it('rejects a wrong last-4 and decrements the remaining attempts', async () => {
      const { clinician, institute, student, contact } = await setup();
      await setChildId(institute.id, student.id, '123456789');
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id,
        createdByUserId: clinician.id, channel: 'email',
      });

      await expect(
        consentInvitationService.verifyChildId({ code, last4: '0000' }),
      ).rejects.toMatchObject({ code: 'child_id_mismatch', details: { attemptsRemaining: 4 } });
    });

    it('locks the gate after too many wrong attempts', async () => {
      const { clinician, institute, student, contact } = await setup();
      await setChildId(institute.id, student.id, '123456789');
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id,
        createdByUserId: clinician.id, channel: 'email',
      });

      for (let i = 0; i < 5; i++) {
        await expect(
          consentInvitationService.verifyChildId({ code, last4: '0000' }),
        ).rejects.toMatchObject({ code: 'child_id_mismatch' });
      }
      // 6th attempt — even with the CORRECT code — is refused: the gate locked.
      await expect(
        consentInvitationService.verifyChildId({ code, last4: '6789' }),
      ).rejects.toMatchObject({ code: 'child_id_verify_locked' });
    });

    it('verifies the correct last-4 and then allows signing', async () => {
      const { clinician, institute, student, contact } = await setup();
      await setChildId(institute.id, student.id, '123456789');
      const { code } = await consentInvitationService.createInvitation({
        studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id,
        createdByUserId: clinician.id, channel: 'email',
      });
      const { version, hash } = await noticeHash();

      const verify = await consentInvitationService.verifyChildId({ code, last4: '6789' });
      expect(verify.verifiedAt).toBeInstanceOf(Date);

      const result = await consentInvitationService.signWithToken({
        code, payload: payload(version, hash),
        guardianFields: { coGuardianAcknowledged: true },
      });
      expect(result.consent.id).toBeDefined();
      const evidence = result.consent.identityVerificationEvidence as any;
      expect(evidence.childIdVerifyMethod).toBe('last4_institute_id_match');
      expect(evidence.childIdVerifiedAt).toBeDefined();
    });
  });

  describe('revokeInvitation', () => {
    it('revokes a pending invitation; subsequent signs fail', async () => {
      const { clinician, institute, student, contact } = await setup();
      const { code, invitation } = await consentInvitationService.createInvitation({
        studentId: student.id,
        contactId: contact.id,
        sourceInstituteId: institute.id,
        createdByUserId: clinician.id,
        channel: 'email',
      });
      await consentInvitationService.revokeInvitation({
        invitationId: invitation.id,
        revokedByUserId: clinician.id,
      });
      await expect(
        consentInvitationService.redeemContext(code),
      ).rejects.toMatchObject({ code: 'code_revoked' });
    });
  });
});
