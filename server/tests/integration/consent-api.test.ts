/**
 * Consent controller (HTTP layer) integration tests.
 *
 * Exercises the controller methods directly with fake req/res objects —
 * end-to-end through the service layer to a real Postgres test DB.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { studentContacts } from '@shared/schema';
import { consentController } from '../../controllers/consentController.js';
import { lookupConsentNotice, renderNoticeForHashing } from '@shared/legal';

async function setupStudentWithContact(opts?: { country?: string; isLegalGuardian?: boolean }) {
  const owner = await makeUser({ firstName: 'Sarah', lastName: 'Cohen' });
  const { student } = await makeStudent(owner.id, { country: opts?.country ?? 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Sarah Cohen',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: owner.id,
    isLegalGuardian: opts?.isLegalGuardian ?? false,
  }).returning();
  return { owner, student, contact };
}

function buildSignBody(args: { signedByContactId: string }) {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
  return {
    signedByContactId: args.signedByContactId,
    locale: 'en',
    consentTextVersion: notice.version,
    consentTextHash: hash,
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    guardianFields: {
      coGuardianAcknowledged: true,
      governmentIdNumber: '123456789',
      governmentIdType: 'national_id' as const,
      governmentIdCountry: 'IL',
    },
    isSensitive: false, // v1 family flow is standard regime
  };
}

describe('Consent API', () => {
  afterEach(truncateAll);

  describe('GET /api/consent/notice', () => {
    it('returns the active IL en notice with computed hash', async () => {
      const req = makeReq({ user: { id: 'irrelevant' }, query: { country: 'IL', locale: 'en' } });
      const { res, capture } = makeRes();
      await consentController.getNotice(req, res);

      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.country).toBe('IL');
      expect(body.locale).toBe('en');
      expect(body.version).toBe('IL.2026.04');
      expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.content.purposeStatement).toContain('SLP');
      expect(Array.isArray(body.thirdPartyRecipients)).toBe(true);
      expect(body.thirdPartyRecipients.length).toBeGreaterThan(0);
    });

    it('returns 400 when country is missing', async () => {
      const req = makeReq({ user: { id: 'x' }, query: {} });
      const { res, capture } = makeRes();
      await consentController.getNotice(req, res);
      expect(capture.statusCode).toBe(400);
    });

    it('returns 404 when country has no notice yet', async () => {
      const req = makeReq({ user: { id: 'x' }, query: { country: 'BR', locale: 'en' } });
      const { res, capture } = makeRes();
      await consentController.getNotice(req, res);
      expect(capture.statusCode).toBe(404);
    });

    it('falls back to en when locale is missing', async () => {
      const req = makeReq({ user: { id: 'x' }, query: { country: 'IL', locale: 'es' } });
      const { res, capture } = makeRes();
      await consentController.getNotice(req, res);
      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.locale).toBe('en'); // fell back
    });
  });

  describe('GET /api/consent/students/:studentId/wizard-context', () => {
    it('bundles student, user, guardian contact, and (null) active consent', async () => {
      const { owner, student, contact } = await setupStudentWithContact();
      const req = makeReq({
        user: { id: owner.id },
        params: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await consentController.getWizardContext(req, res);

      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.student.id).toBe(student.id);
      expect(body.student.country).toBe('IL');
      expect(body.user.id).toBe(owner.id);
      expect(body.guardianContact.id).toBe(contact.id);
      expect(body.activeConsent).toBeNull();
    });

    it('returns 404 for a missing student', async () => {
      const owner = await makeUser();
      const req = makeReq({ user: { id: owner.id }, params: { studentId: 'no-such-student' } });
      const { res, capture } = makeRes();
      await consentController.getWizardContext(req, res);
      expect(capture.statusCode).toBe(404);
    });
  });

  describe('POST /api/consent/students/:studentId/sign', () => {
    it('signs consent + updates the guardian contact in one transaction', async () => {
      const { owner, student, contact } = await setupStudentWithContact();
      const req = makeReq({
        user: { id: owner.id },
        params: { studentId: student.id },
        body: buildSignBody({ signedByContactId: contact.id }),
      });
      const { res, capture } = makeRes();
      await consentController.signConsent(req, res);

      expect(capture.statusCode).toBe(200);
      const body = capture.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.consent.id).toBeDefined();

      // Contact should have been flipped to isLegalGuardian + co-guardian + gov-ID.
      const [updated] = await db.select().from(studentContacts).where(eq(studentContacts.id, contact.id));
      expect(updated.isLegalGuardian).toBe(true);
      expect(updated.coGuardianAcknowledged).toBe(true);
      expect(updated.governmentIdNumber).toBe('123456789');
      expect(updated.governmentIdType).toBe('national_id');
      expect(updated.governmentIdCountry).toBe('IL');
      expect(updated.legalGuardianDeclaredAt).not.toBeNull();
      expect(updated.governmentIdVerifiedVia).toBe('manual_entry');
    });

    it('rejects when the contact is not linked to the caller', async () => {
      const { student, contact } = await setupStudentWithContact();
      const otherUser = await makeUser();
      const req = makeReq({
        user: { id: otherUser.id },
        params: { studentId: student.id },
        body: buildSignBody({ signedByContactId: contact.id }),
      });
      const { res, capture } = makeRes();
      await consentController.signConsent(req, res);
      expect(capture.statusCode).toBe(403);
      expect((capture.jsonBody as any).code).toBe('contact_not_owned_by_caller');
    });

    it('rejects when 401 (no user)', async () => {
      const { student, contact } = await setupStudentWithContact();
      const req = makeReq({
        user: null,
        params: { studentId: student.id },
        body: buildSignBody({ signedByContactId: contact.id }),
      });
      const { res, capture } = makeRes();
      await consentController.signConsent(req, res);
      expect(capture.statusCode).toBe(401);
    });
  });

  describe('POST /api/consent/:consentId/revoke', () => {
    it('lets the linked user revoke their consent', async () => {
      const { owner, student, contact } = await setupStudentWithContact();
      const signReq = makeReq({
        user: { id: owner.id },
        params: { studentId: student.id },
        body: buildSignBody({ signedByContactId: contact.id }),
      });
      const { res: r1, capture: c1 } = makeRes();
      await consentController.signConsent(signReq, r1);
      const consentId = (c1.jsonBody as any).consent.id;

      const revokeReq = makeReq({
        user: { id: owner.id },
        params: { consentId },
        body: { reason: 'Withdrew' },
      });
      const { res: r2, capture: c2 } = makeRes();
      await consentController.revokeConsent(revokeReq, r2);
      expect(c2.statusCode).toBe(200);
      const body = c2.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.consent.revokedAt).not.toBeNull();
    });

    it('rejects revoke from someone other than the signer', async () => {
      const { owner, student, contact } = await setupStudentWithContact();
      const signReq = makeReq({
        user: { id: owner.id },
        params: { studentId: student.id },
        body: buildSignBody({ signedByContactId: contact.id }),
      });
      const { res: r1, capture: c1 } = makeRes();
      await consentController.signConsent(signReq, r1);
      const consentId = (c1.jsonBody as any).consent.id;

      const stranger = await makeUser();
      const revokeReq = makeReq({
        user: { id: stranger.id },
        params: { consentId },
        body: {},
      });
      const { res: r2, capture: c2 } = makeRes();
      await consentController.revokeConsent(revokeReq, r2);
      expect(c2.statusCode).toBe(403);
    });
  });
});
