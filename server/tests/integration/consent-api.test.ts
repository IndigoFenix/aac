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
import {
  makeUser,
  makeStudent,
  makeInstitute,
  addUserToInstitute,
  enrollStudent,
} from '../helpers/factories.js';
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

    // ========================================================================
    // The membership gate on the DEFAULT path (2026-09-10).
    //
    // Until this date the default path checked ONLY that a session existed, so
    // any authenticated account on the platform could read any student's name,
    // birth date, country and active consent record. It was excluded from the
    // 2026-09-09 sweep because `assertStudentAccess` alone would have refused a
    // legitimate SESSION-authed signer: `POST /sign` admits a linked
    // `student_contacts` row or an active `user_students` link, and neither
    // implies institute membership. The rule is therefore the union of those
    // three, and each leaf below pins one of them ALONE so nobody can later
    // "simplify" the gate down to institute overlap.
    //
    // (The magic-link guardian is NOT among these callers — they have no
    // session and reach the wizard through the public /invitations/redeem +
    // /invitations/sign pair. See the helper's block comment.)
    //
    // NON-VACUITY of the 403 case: the pre-change handler's entire default-path
    // permission logic was `if (!userId) 401`, with no branch that could produce
    // a 403 at all — the `stranger` below therefore received 200 and a full
    // payload. That is not an inference about the gate; it is the whole of the
    // code the gate replaced. (This suite is DB-backed and was not executed by
    // the agent that wrote it — two other agents shared the test DB — so the
    // empirical half of the check happens on the coordinator's serial sweep:
    // revert `assertWizardContextAccess` and this one test flips to 200.)
    // ========================================================================
    describe('the membership gate on the default path', () => {
      /** A clinician member of the student's institute: no contact, no link. */
      async function setupInstituteMember() {
        const admin = await makeUser({ firstName: 'Institute', lastName: 'Admin' });
        const { institute } = await makeInstitute(admin.id, { type: 'clinic' });
        const { student } = await makeStudent(admin.id, { country: 'IL' });
        await enrollStudent(institute.id, student.id, admin.id);
        const member = await makeUser({ firstName: 'Member', lastName: 'Clinician' });
        await addUserToInstitute(institute.id, member.id);
        return { admin, institute, student, member };
      }

      async function call(userId: string | null, studentId: string, contactId?: string) {
        const req = makeReq({
          user: userId ? { id: userId } : null,
          params: { studentId },
          query: contactId ? { contactId } : {},
        });
        const { res, capture } = makeRes();
        await consentController.getWizardContext(req, res);
        return capture;
      }

      it("a member of the student's institute gets 200", async () => {
        const { student, member } = await setupInstituteMember();
        const capture = await call(member.id, student.id);
        expect(capture.statusCode).toBe(200);
        // No contact of their own, and the endpoint still answers.
        expect((capture.jsonBody as any).guardianContact).toBeNull();
        expect((capture.jsonBody as any).student.id).toBe(student.id);
      });

      // 🚨 THE PIN THAT STOPS THE PARENT PATH BEING "SIMPLIFIED" AWAY.
      // This guardian holds NO institute membership and NO user_students link —
      // only a student_contacts row with linkedUserId = them. Gate this endpoint
      // on institute overlap alone and this test goes red, which is exactly the
      // production breakage that kept the endpoint ungated for a year.
      it('a linked guardian contact with NO institute membership gets 200', async () => {
        const { student } = await setupInstituteMember();
        const guardian = await makeUser({ firstName: 'Dana', lastName: 'Guardian' });
        const [contact] = await db.insert(studentContacts).values({
          studentId: student.id,
          name: 'Dana Guardian',
          relationship: 'parent_guardian',
          role: 'parent_guardian',
          linkedUserId: guardian.id,
          isLegalGuardian: false,
        }).returning();

        const capture = await call(guardian.id, student.id);
        expect(capture.statusCode).toBe(200);
        expect((capture.jsonBody as any).guardianContact.id).toBe(contact.id);
      });

      // The self-consent / family-account leg: an active user_students link and
      // nothing else. `makeStudent` creates the link; this student is enrolled
      // in no institute and the owner has no contact row.
      it('a user_students-linked owner with no institute gets 200', async () => {
        const owner = await makeUser({ firstName: 'Family', lastName: 'Owner' });
        const { student } = await makeStudent(owner.id, { country: 'IL' });
        const capture = await call(owner.id, student.id);
        expect(capture.statusCode).toBe(200);
        expect((capture.jsonBody as any).guardianContact).toBeNull();
      });

      it('an unrelated authenticated user gets 403 (was 200 before this gate)', async () => {
        const { student } = await setupInstituteMember();
        const stranger = await makeUser({ firstName: 'Unrelated', lastName: 'Account' });
        const capture = await call(stranger.id, student.id);
        expect(capture.statusCode).toBe(403);
        expect((capture.jsonBody as any).code).toBe('permission_denied');
        // Nothing about the student leaks in the refusal.
        expect(JSON.stringify(capture.jsonBody)).not.toContain(student.id);
      });

      it('an unauthenticated caller gets 401', async () => {
        const { student } = await setupInstituteMember();
        const capture = await call(null, student.id);
        expect(capture.statusCode).toBe(401);
      });

      // Enumeration safety: a caller who is not permitted must not be able to
      // tell a real student id from an invented one, so the permission check
      // runs BEFORE the student row is read and both answer 403.
      it('a missing student is 403 to a stranger and 404 to a system admin', async () => {
        const stranger = await makeUser();
        expect((await call(stranger.id, 'no-such-student')).statusCode).toBe(403);

        const sysAdmin = await makeUser({ isSystemAdmin: true });
        const req = makeReq({
          user: { id: sysAdmin.id, isSystemAdmin: true },
          params: { studentId: 'no-such-student' },
        });
        const { res, capture } = makeRes();
        await consentController.getWizardContext(req, res);
        expect(capture.statusCode).toBe(404);
      });

      // The ?contactId= variant stays on assertStudentAccess. The new default
      // rule must NOT widen it: a linked guardian may read their OWN context but
      // may not name someone else's contact row.
      it('?contactId= still requires institute access, even for a linked guardian', async () => {
        const { student, member } = await setupInstituteMember();
        const guardian = await makeUser({ firstName: 'Dana', lastName: 'Guardian' });
        await db.insert(studentContacts).values({
          studentId: student.id,
          name: 'Dana Guardian',
          relationship: 'parent_guardian',
          role: 'parent_guardian',
          linkedUserId: guardian.id,
          isLegalGuardian: false,
        });
        const [other] = await db.insert(studentContacts).values({
          studentId: student.id,
          name: 'Other Parent',
          relationship: 'parent_guardian',
          role: 'parent_guardian',
          isLegalGuardian: false,
        }).returning();

        // The guardian passes the DEFAULT path...
        expect((await call(guardian.id, student.id)).statusCode).toBe(200);
        // ...and is still refused when they name another person's contact row.
        expect((await call(guardian.id, student.id, other.id)).statusCode).toBe(403);
        // The institute member is the one the param exists for.
        const asMember = await call(member.id, student.id, other.id);
        expect(asMember.statusCode).toBe(200);
        expect((asMember.jsonBody as any).guardianContact.id).toBe(other.id);
      });
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
  // ==========================================================================
  // Student-scoped reads: the institute-membership gate
  //
  // These four endpoints share ONE check (assertStudentAccess in
  // consentController). It was written four times and every copy read the
  // rows of `getInstitutesByStudentId` as bare institutes — that repository
  // returns `{ institute, enrollment }`, so `m.id` was `undefined`,
  // `Set.has(undefined)` was always false, and every caller who was not a
  // system admin got 403 on their own patient. `/active` had the opposite
  // bug: no check at all, so any authenticated user could read any student's
  // consent record.
  //
  // The pair below pins both directions. The 200 half is what keeps the 403
  // half from passing vacuously: before the fix the deny case passed for
  // entirely the wrong reason (everyone was denied), and /active allowed
  // everyone.
  // ==========================================================================
  describe('student-scoped consent reads: institute membership', () => {
    async function setupMemberAndOutsider() {
      const admin = await makeUser({ firstName: 'Institute', lastName: 'Admin' });
      const { institute } = await makeInstitute(admin.id, { type: 'clinic' });
      const { student } = await makeStudent(admin.id, { country: 'IL' });
      await enrollStudent(institute.id, student.id, admin.id);

      // A clinician who is a plain (non-admin) member of the student's institute.
      const member = await makeUser({ firstName: 'Member', lastName: 'Clinician' });
      await addUserToInstitute(institute.id, member.id);

      // Someone with an institute of their own that the student is NOT in.
      const outsider = await makeUser({ firstName: 'Other', lastName: 'Clinician' });
      const { institute: otherInstitute } = await makeInstitute(outsider.id, { type: 'clinic' });

      return { admin, institute, student, member, outsider, otherInstitute };
    }

    async function callAll(userId: string, studentId: string) {
      const out: Record<string, number> = {};
      for (const [name, handler] of [
        ['active', consentController.getActiveForStudent],
        ['history', consentController.listHistory],
        ['authority', consentController.getAuthority],
        ['invitations', consentController.listPendingInvitations],
      ] as const) {
        const req = makeReq({ user: { id: userId }, params: { studentId } });
        const { res, capture } = makeRes();
        await handler.call(consentController, req, res);
        out[name] = capture.statusCode;
      }
      return out;
    }

    it("a member of the student's institute gets 200 from all four reads", async () => {
      const { student, member } = await setupMemberAndOutsider();
      expect(await callAll(member.id, student.id)).toEqual({
        active: 200,
        history: 200,
        authority: 200,
        invitations: 200,
      });
    });

    it('a user with no overlapping institute gets 403 from all four reads', async () => {
      const { student, outsider } = await setupMemberAndOutsider();
      expect(await callAll(outsider.id, student.id)).toEqual({
        active: 403,
        history: 403,
        authority: 403,
        invitations: 403,
      });
    });

    it('a system admin passes without any institute overlap', async () => {
      const { student } = await setupMemberAndOutsider();
      const sysAdmin = await makeUser({ isSystemAdmin: true });
      const req = makeReq({
        user: { id: sysAdmin.id, isSystemAdmin: true },
        params: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await consentController.getActiveForStudent(req, res);
      expect(capture.statusCode).toBe(200);
    });

    it('an unauthenticated caller gets 401 from /active, not 200', async () => {
      const { student } = await setupMemberAndOutsider();
      const req = makeReq({ user: null, params: { studentId: student.id } });
      const { res, capture } = makeRes();
      await consentController.getActiveForStudent(req, res);
      expect(capture.statusCode).toBe(401);
    });

    // The client disables report Finalize off `gate.writesAllowed`. It is
    // shipped here — rather than recomputed from `consent === null` — because
    // the refusal also folds in CONSENT_GATE_ENABLED and the legacy grace
    // window, neither of which the browser can see. If this field stops being
    // returned, the button silently stops disabling and the clinician is back
    // to discovering the refusal only after clicking.
    describe('the gate decision it ships alongside the record', () => {
      const previousFlag = process.env.CONSENT_GATE_ENABLED;
      afterEach(() => {
        if (previousFlag === undefined) delete process.env.CONSENT_GATE_ENABLED;
        else process.env.CONSENT_GATE_ENABLED = previousFlag;
      });

      async function readGate(userId: string, studentId: string) {
        const req = makeReq({ user: { id: userId }, params: { studentId } });
        const { res, capture } = makeRes();
        await consentController.getActiveForStudent(req, res);
        expect(capture.statusCode).toBe(200);
        return (capture.jsonBody as { consent: unknown; gate: Record<string, unknown> });
      }

      it('refuses writes when the gate is ON and no consent record exists', async () => {
        process.env.CONSENT_GATE_ENABLED = 'true';
        const { student, member } = await setupMemberAndOutsider();
        const body = await readGate(member.id, student.id);
        expect(body.consent).toBeNull();
        expect(body.gate).toMatchObject({
          writesAllowed: false,
          hasActiveConsent: false,
          gateEnabled: true,
        });
      });

      it('allows writes with no consent record when the gate is OFF', async () => {
        process.env.CONSENT_GATE_ENABLED = 'false';
        const { student, member } = await setupMemberAndOutsider();
        const body = await readGate(member.id, student.id);
        // Same absent record as above — the DECISION is what differs, which is
        // exactly why the client must not infer it from `consent === null`.
        expect(body.consent).toBeNull();
        expect(body.gate).toMatchObject({ writesAllowed: true, gateEnabled: false });
      });
    });
  });

  describe('PUT /api/consent/students/:studentId/authority', () => {
    it("lets an admin of the student's institute set the authority", async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id, { type: 'clinic' });
      const { student } = await makeStudent(admin.id, { country: 'IL' });
      await enrollStudent(institute.id, student.id, admin.id);

      const req = makeReq({
        user: { id: admin.id },
        params: { studentId: student.id },
        body: { mode: 'self' },
      });
      const { res, capture } = makeRes();
      await consentController.setAuthority(req, res);
      expect(capture.statusCode).toBe(200);
      expect((capture.jsonBody as any).consentAuthority).toBe('self');
    });

    it('refuses a plain member of the institute', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id, { type: 'clinic' });
      const { student } = await makeStudent(admin.id, { country: 'IL' });
      await enrollStudent(institute.id, student.id, admin.id);
      const member = await makeUser();
      await addUserToInstitute(institute.id, member.id);

      const req = makeReq({
        user: { id: member.id },
        params: { studentId: student.id },
        body: { mode: 'self' },
      });
      const { res, capture } = makeRes();
      await consentController.setAuthority(req, res);
      expect(capture.statusCode).toBe(403);
    });
  });
});
