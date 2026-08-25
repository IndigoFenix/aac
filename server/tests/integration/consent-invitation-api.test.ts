/**
 * Consent invitation HTTP-controller tests.
 * Verifies permission gating on create/revoke + token-based redeem/sign.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';

import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeStudent, makeInstitute } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { studentContacts } from '@shared/schema';
import { consentController } from '../../controllers/consentController.js';
import { lookupConsentNotice, renderNoticeForHashing } from '@shared/legal';

async function setup() {
  const clinician = await makeUser();
  const stranger = await makeUser();
  const { institute } = await makeInstitute(clinician.id, { type: 'clinic' });
  const { student } = await makeStudent(clinician.id, { country: 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);
  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Parent',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    contactEmail: 'parent@test.local',
    isLegalGuardian: false,
  }).returning();
  return { clinician, stranger, institute, student, contact };
}

describe('Consent invitation API', () => {
  afterEach(truncateAll);

  describe('POST /api/consent/invitations', () => {
    it('clinician (institute admin) can create an invitation and receives the code', async () => {
      const { clinician, institute, student, contact } = await setup();
      const req = makeReq({
        user: { id: clinician.id, isSystemAdmin: false },
        body: {
          studentId: student.id,
          contactId: contact.id,
          sourceInstituteId: institute.id,
          channel: 'email',
        },
      });
      const { res, capture } = makeRes();
      await consentController.createInvitation(req, res);

      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.code).toMatch(/^[A-Z0-9]{12}$/);
      expect(body.redemptionUrl).toContain(body.code);
      expect(body.invitation.id).toBeDefined();
    });

    it('rejects 403 when caller is not an admin of the source institute', async () => {
      const { stranger, institute, student, contact } = await setup();
      const req = makeReq({
        user: { id: stranger.id, isSystemAdmin: false },
        body: {
          studentId: student.id,
          contactId: contact.id,
          sourceInstituteId: institute.id,
          channel: 'email',
        },
      });
      const { res, capture } = makeRes();
      await consentController.createInvitation(req, res);
      expect(capture.statusCode).toBe(403);
      expect((capture.jsonBody as any).code).toBe('permission_denied');
    });

    it('rejects 401 when unauthenticated', async () => {
      const { institute, student, contact } = await setup();
      const req = makeReq({
        user: null,
        body: { studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id, channel: 'email' },
      });
      const { res, capture } = makeRes();
      await consentController.createInvitation(req, res);
      expect(capture.statusCode).toBe(401);
    });
  });

  describe('POST /api/consent/invitations/redeem', () => {
    it('returns wizard context for a valid code (no auth)', async () => {
      const { clinician, institute, student, contact } = await setup();
      // Create the invitation
      const createReq = makeReq({
        user: { id: clinician.id, isSystemAdmin: false },
        body: { studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id, channel: 'email' },
      });
      const { res: r1, capture: c1 } = makeRes();
      await consentController.createInvitation(createReq, r1);
      const code = (c1.jsonBody as any).code;

      // Redeem with no user
      const req = makeReq({ user: null, body: { code } });
      const { res, capture } = makeRes();
      await consentController.redeemInvitation(req, res);
      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.student.id).toBe(student.id);
      expect(body.contact.id).toBe(contact.id);
      expect(body.invitationId).toBeDefined();
    });

    it('rejects 404 for an unknown code', async () => {
      const req = makeReq({ user: null, body: { code: 'NOTAREALCODE' } });
      const { res, capture } = makeRes();
      await consentController.redeemInvitation(req, res);
      expect(capture.statusCode).toBe(404);
    });
  });

  describe('POST /api/consent/invitations/sign', () => {
    it('signs consent with the token (no auth)', async () => {
      const { clinician, institute, student, contact } = await setup();
      const createReq = makeReq({
        user: { id: clinician.id, isSystemAdmin: false },
        body: { studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id, channel: 'email' },
      });
      const { res: r1, capture: c1 } = makeRes();
      await consentController.createInvitation(createReq, r1);
      const code = (c1.jsonBody as any).code;

      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');

      const req = makeReq({
        user: null,
        body: {
          code,
          locale: 'en',
          consentTextVersion: notice.version,
          consentTextHash: hash,
          guardianFields: {
            coGuardianAcknowledged: true,
            governmentIdNumber: '111222333',
            governmentIdType: 'national_id',
            governmentIdCountry: 'IL',
          },
          purposeAcknowledged: true,
          voluntarinessAcknowledged: true,
          thirdPartyTransfersAcknowledged: true,
          identityVerificationMethod: 'verified_phone_otp',
          identityVerificationEvidence: {},
          nonRepudiationMethod: 'verified_phone_otp',
          nonRepudiationEvidence: {},
          isSensitive: false,
        },
      });
      const { res, capture } = makeRes();
      await consentController.signInvitation(req, res);
      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.consent.id).toBeDefined();
      expect(body.consent.country).toBe('IL');
    });

    it('rejects 410 on double-use', async () => {
      const { clinician, institute, student, contact } = await setup();
      const createReq = makeReq({
        user: { id: clinician.id, isSystemAdmin: false },
        body: { studentId: student.id, contactId: contact.id, sourceInstituteId: institute.id, channel: 'email' },
      });
      const { res: r1, capture: c1 } = makeRes();
      await consentController.createInvitation(createReq, r1);
      const code = (c1.jsonBody as any).code;

      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
      const buildBody = () => ({
        code,
        locale: 'en',
        consentTextVersion: notice.version,
        consentTextHash: hash,
        guardianFields: { coGuardianAcknowledged: true },
        purposeAcknowledged: true,
        voluntarinessAcknowledged: true,
        thirdPartyTransfersAcknowledged: true,
        identityVerificationMethod: 'verified_phone_otp',
        identityVerificationEvidence: {},
        nonRepudiationMethod: 'verified_phone_otp',
        nonRepudiationEvidence: {},
        isSensitive: false,
      });

      const req1 = makeReq({ user: null, body: buildBody() });
      const { res: rs1, capture: cap1 } = makeRes();
      await consentController.signInvitation(req1, rs1);
      expect(cap1.statusCode).toBe(200);

      const req2 = makeReq({ user: null, body: buildBody() });
      const { res: rs2, capture: cap2 } = makeRes();
      await consentController.signInvitation(req2, rs2);
      expect(cap2.statusCode).toBe(410);
      expect((cap2.jsonBody as any).code).toBe('code_already_used');
    });
  });
});
