/**
 * Who may REVOKE a consent record — the attest-parity rule.
 *
 * The hole: `attestInPerson` signs as a guardian contact with NO
 * `linkedUserId` (that absence is the reason the endpoint exists), while
 * `revokeConsent` admitted only "the signing contact's linked user, or a system
 * admin". A clinic-attested consent therefore had exactly one revoker in the
 * whole system, and every regime we implement grants a right of withdrawal.
 *
 * The rule now: whoever could have ATTESTED a consent may also revoke it —
 * `attestPermissionFor`, the same predicate and the same
 * `ATTEST_REQUIRES_INSTITUTE_ADMIN` constant the attest write gates on.
 *
 * ⚠️ THE POINT OF THIS SUITE IS THE NARROWNESS. The widening applies ONLY to
 * records whose `identityVerificationMethod` is `in_person_clinician_attested`.
 * "Any institute member may revoke any of that student's consents" was
 * explicitly REJECTED — it would let a clinic member tear up a consent a parent
 * signed themselves, taking a right from the person who holds it. The
 * `does NOT let the same member revoke a magic-link/parent-signed record` test
 * is the pin that fails if someone widens this later, and it is deliberately
 * set on a student the member DOES have access to, so it cannot pass for the
 * wrong reason (an access failure instead of a permission failure).
 *
 * ⚠️ Contacts here deliberately have NO `contactEmail`. `sendConsentReceipt`
 * no-ops on a null address, and the test environment carries live SES
 * credentials — a contact with an address would make this suite SEND.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

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
import { studentConsentRecordRepository } from '../../repositories/studentConsentRecordRepository.js';
import {
  activityLogs,
  studentContacts,
  studentShareInvites,
  objectShares,
  standingShares,
  programs,
} from '@shared/schema';
import { consentController } from '../../controllers/consentController.js';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import { lookupConsentNotice, renderNoticeForHashing } from '@shared/legal';

const ATTESTED = 'in_person_clinician_attested';
/** What the magic-link parent flow writes — see consentController.signInvitation. */
const MAGIC_LINK = 'verified_phone_otp';

function ilNotice() {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  return {
    version: notice.version,
    hash: createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex'),
  };
}

/**
 * One clinic, two members, two students.
 *
 * `attester` records the in-person consent for `attestedStudent`; `member` is a
 * DIFFERENT plain (non-admin) member of the same institute and is the caller
 * under test everywhere — the point being that the parity rule is a permission,
 * not "the person who happened to attest".
 *
 * `parentStudent` is enrolled in the SAME institute and its consent is signed
 * by a linked parent through a magic-link-shaped record. `member` therefore has
 * full institute access to it, which is what makes the refusal meaningful.
 */
async function setupClinic() {
  const admin = await makeUser({ firstName: 'Admin', lastName: 'User' });
  const { institute } = await makeInstitute(admin.id, { type: 'clinic' });

  const attester = await makeUser({ firstName: 'Dana', lastName: 'Levi' });
  const member = await makeUser({ firstName: 'Noa', lastName: 'Barak' });
  await addUserToInstitute(institute.id, attester.id, { isAdmin: false });
  await addUserToInstitute(institute.id, member.id, { isAdmin: false });

  // ---- Student A: consent recorded at the clinic desk, guardian has no account
  const { student: attestedStudent } = await makeStudent(admin.id, { country: 'IL' });
  await studentRepository.updateStudent(attestedStudent.id, { birthDate: '2018-01-01' } as any);
  await enrollStudent(institute.id, attestedStudent.id, admin.id);
  const [clinicContact] = await db
    .insert(studentContacts)
    .values({
      studentId: attestedStudent.id,
      name: 'Ruth Mizrahi',
      relationship: 'parent_guardian',
      role: 'parent_guardian',
      linkedUserId: null, // ← the whole point
      isLegalGuardian: false,
    })
    .returning();

  // ---- Student B: consent signed by the parent themselves, same institute
  const parent = await makeUser({ firstName: 'Yael', lastName: 'Shani' });
  const { student: parentStudent } = await makeStudent(admin.id, { country: 'IL' });
  await studentRepository.updateStudent(parentStudent.id, { birthDate: '2018-01-01' } as any);
  await enrollStudent(institute.id, parentStudent.id, admin.id);
  const [parentContact] = await db
    .insert(studentContacts)
    .values({
      studentId: parentStudent.id,
      name: 'Yael Shani',
      relationship: 'parent_guardian',
      role: 'parent_guardian',
      linkedUserId: parent.id,
      isLegalGuardian: true,
    })
    .returning();

  return {
    admin,
    institute,
    attester,
    member,
    attestedStudent,
    clinicContact,
    parent,
    parentStudent,
    parentContact,
  };
}

/** Drive the real attest endpoint — the record under test must be a REAL one. */
async function attestConsent(args: {
  attesterId: string;
  studentId: string;
  contactId: string;
}) {
  const notice = ilNotice();
  const req = makeReq({
    user: { id: args.attesterId },
    params: { studentId: args.studentId },
    body: {
      signedByContactId: args.contactId,
      locale: 'en',
      consentTextVersion: notice.version,
      consentTextHash: notice.hash,
      signature: {
        mode: 'typed' as const,
        typedName: 'Ruth Mizrahi',
        signedAt: new Date().toISOString(),
      },
      attestation: {
        guardianPresent: true as const,
        identificationType: 'national_id' as const,
        identificationCountry: 'IL',
      },
      purposeAcknowledged: true,
      voluntarinessAcknowledged: true,
      thirdPartyTransfersAcknowledged: true,
    },
  });
  const { res, capture } = makeRes();
  await consentController.attestInPerson(req, res);
  expect(capture.statusCode).toBe(200);
  return (capture.jsonBody as any).consent;
}

/** A record shaped like the magic-link parent flow's output (§5, signInvitation). */
async function signAsParent(args: { studentId: string; contactId: string }) {
  const notice = ilNotice();
  const input: SignConsentInput = {
    studentId: args.studentId,
    signedByContactId: args.contactId,
    locale: 'en',
    consentTextVersion: notice.version,
    consentTextHash: notice.hash,
    thirdPartyRecipients: [],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    identityVerificationMethod: MAGIC_LINK,
    identityVerificationEvidence: {},
    nonRepudiationMethod: MAGIC_LINK,
    nonRepudiationEvidence: {},
  } as SignConsentInput;
  return consentService.signConsent(input);
}

async function revokeAs(userOverride: Record<string, unknown>, consentId: string) {
  const req = makeReq({
    user: userOverride,
    params: { consentId },
    body: { reason: 'Guardian asked us to withdraw' },
  });
  const { res, capture } = makeRes();
  await consentController.revokeConsent(req, res);
  return capture;
}

/** activityLogService.log is fire-and-forget, so the row lands a tick late. */
async function waitForActivityRow(
  where: { eventType: string; subjectId1: string },
  attempts = 20,
): Promise<Record<string, any> | null> {
  for (let i = 0; i < attempts; i++) {
    const [row] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.eventType, where.eventType as any),
          eq(activityLogs.subjectId1, where.subjectId1),
        ),
      );
    if (row) return row as any;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('POST /api/consent/:consentId/revoke — attest parity', () => {
  afterEach(truncateAll);

  // ==========================================================================
  // THE WIDENING
  // ==========================================================================

  it('lets an institute member who did NOT attest revoke a clinician-attested record', async () => {
    const { attester, member, attestedStudent, clinicContact } = await setupClinic();
    const consent = await attestConsent({
      attesterId: attester.id,
      studentId: attestedStudent.id,
      contactId: clinicContact.id,
    });
    expect(consent.identityVerificationMethod).toBe(ATTESTED);

    // The revoker is a different plain member — a permission, not a pointer at
    // the individual who attested.
    const capture = await revokeAs({ id: member.id }, consent.id);
    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).consent.revokedAt).not.toBeNull();

    const after = await studentConsentRecordRepository.getById(consent.id);
    expect(after!.revokedAt).not.toBeNull();
    expect(after!.revokedByUserId).toBe(member.id);
  });

  it('audits the parity revocation distinguishably from a signer withdrawal', async () => {
    const { attester, member, attestedStudent, clinicContact } = await setupClinic();
    const consent = await attestConsent({
      attesterId: attester.id,
      studentId: attestedStudent.id,
      contactId: clinicContact.id,
    });
    await revokeAs({ id: member.id }, consent.id);

    const row = await waitForActivityRow({
      eventType: 'consent_revoked',
      subjectId1: consent.id,
    });
    expect(row).not.toBeNull();
    // WHO revoked.
    expect(row!.userId).toBe(member.id);
    expect(row!.subjectId2).toBe(attestedStudent.id);
    // WHICH RULE admitted them — the whole point of the field.
    expect(row!.details.revocation_path).toBe('attest_parity');
    // And who had vouched for the guardian in the first place, so one row
    // answers "who attested, who tore it up".
    expect(row!.details.attested_by_user_id).toBe(attester.id);
    expect(row!.details.identity_verification_method).toBe(ATTESTED);
    // The pre-existing details are untouched.
    expect(row!.details.reason).toBe('Guardian asked us to withdraw');
    expect(row!.details.priorVersion).toBe(ilNotice().version);
  });

  it('still cascades to active shares when revoked through the parity path', async () => {
    const { admin, institute, attester, member, attestedStudent, clinicContact } =
      await setupClinic();
    const consent = await attestConsent({
      attesterId: attester.id,
      studentId: attestedStudent.id,
      contactId: clinicContact.id,
    });

    // A second institute to share INTO, and one materialised grant of each kind.
    const { institute: family } = await makeInstitute(admin.id, { type: 'family' });
    const [program] = await db
      .insert(programs)
      .values({
        studentId: attestedStudent.id,
        instituteId: institute.id,
        name: 'Test program',
        framework: 'tala',
        status: 'draft',
        createdBy: admin.id,
      } as any)
      .returning();
    const [invite] = await db
      .insert(studentShareInvites)
      .values({
        studentId: attestedStudent.id,
        sourceInstituteId: institute.id,
        targetInstituteId: family.id,
        codeHash: 'fixture-hash-parity',
        createdByUserId: admin.id,
        guardianUserId: admin.id,
        status: 'accepted',
        codeExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        guardianApprovedAt: new Date(),
        acceptedAt: new Date(),
        acceptedByUserId: admin.id,
        pendingBundle: {
          objects: [],
          standingTypes: [],
          permission: 'read',
          shareExpiresAt: null,
          standingExpiresAt: null,
          sensitiveAcknowledged: false,
        },
      } as any)
      .returning();
    await db.insert(objectShares).values({
      objectType: 'program',
      objectId: program.id,
      studentId: attestedStudent.id,
      sourceInstituteId: institute.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
    } as any);
    await db.insert(standingShares).values({
      objectTypes: ['monitor_note'],
      studentId: attestedStudent.id,
      sourceInstituteId: institute.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
      shareExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    } as any);

    const capture = await revokeAs({ id: member.id }, consent.id);
    expect(capture.statusCode).toBe(200);

    const liveObjects = await db
      .select()
      .from(objectShares)
      .where(and(eq(objectShares.studentId, attestedStudent.id), isNull(objectShares.revokedAt)));
    expect(liveObjects).toHaveLength(0);
    const liveStanding = await db
      .select()
      .from(standingShares)
      .where(and(eq(standingShares.studentId, attestedStudent.id), isNull(standingShares.revokedAt)));
    expect(liveStanding).toHaveLength(0);

    // §7.5's tag is untouched by the new details key.
    const logs = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.subjectId1, attestedStudent.id));
    const cascadeLogs = logs.filter(
      (l) => (l.details as any)?.cascade_reason === 'consent_revoked',
    );
    expect(cascadeLogs.length).toBe(2);
  });

  // ==========================================================================
  // THE NARROW-SCOPE PIN — this is the test that fails if someone widens it
  // ==========================================================================

  it('does NOT let the same member revoke a record the parent signed themselves', async () => {
    const { member, parentStudent, parentContact } = await setupClinic();
    const consent = await signAsParent({
      studentId: parentStudent.id,
      contactId: parentContact.id,
    });
    expect(consent.identityVerificationMethod).toBe(MAGIC_LINK);

    const capture = await revokeAs({ id: member.id }, consent.id);
    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).code).toBe('permission_denied');

    const after = await studentConsentRecordRepository.getById(consent.id);
    expect(after!.revokedAt).toBeNull();
  });

  it('the narrow pin is not vacuous: that same member DOES have access to that student', async () => {
    // If the refusal above were an ACCESS failure rather than a PERMISSION
    // failure it would prove nothing about scope. This member reads the
    // student's consent history at 200, so the 403 above is about the RECORD.
    const { member, parentStudent, parentContact } = await setupClinic();
    await signAsParent({ studentId: parentStudent.id, contactId: parentContact.id });

    const req = makeReq({
      user: { id: member.id },
      params: { studentId: parentStudent.id },
    });
    const { res, capture } = makeRes();
    await consentController.listHistory(req, res);
    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).history).toHaveLength(1);
  });

  // ==========================================================================
  // OUTSIDERS
  // ==========================================================================

  it('refuses a user with no institute overlap — attested record', async () => {
    const { attester, attestedStudent, clinicContact } = await setupClinic();
    const consent = await attestConsent({
      attesterId: attester.id,
      studentId: attestedStudent.id,
      contactId: clinicContact.id,
    });

    const stranger = await makeUser();
    const capture = await revokeAs({ id: stranger.id }, consent.id);
    expect(capture.statusCode).toBe(403);
    const after = await studentConsentRecordRepository.getById(consent.id);
    expect(after!.revokedAt).toBeNull();
  });

  it('refuses a user with no institute overlap — parent-signed record', async () => {
    const { parentStudent, parentContact } = await setupClinic();
    const consent = await signAsParent({
      studentId: parentStudent.id,
      contactId: parentContact.id,
    });

    const stranger = await makeUser();
    const capture = await revokeAs({ id: stranger.id }, consent.id);
    expect(capture.statusCode).toBe(403);
    const after = await studentConsentRecordRepository.getById(consent.id);
    expect(after!.revokedAt).toBeNull();
  });

  // ==========================================================================
  // THE PATHS THAT EXISTED BEFORE — unchanged
  // ==========================================================================

  it('the signing parent still revokes their own record, logged as `signer`', async () => {
    const { parent, parentStudent, parentContact } = await setupClinic();
    const consent = await signAsParent({
      studentId: parentStudent.id,
      contactId: parentContact.id,
    });

    const capture = await revokeAs({ id: parent.id }, consent.id);
    expect(capture.statusCode).toBe(200);

    const row = await waitForActivityRow({
      eventType: 'consent_revoked',
      subjectId1: consent.id,
    });
    expect(row!.details.revocation_path).toBe('signer');
    // Parity keys appear ONLY on the parity path.
    expect(row!.details.attested_by_user_id).toBeUndefined();
  });

  it('a system admin still revokes anything, logged as `system_admin`', async () => {
    const { admin, parentStudent, parentContact } = await setupClinic();
    const consent = await signAsParent({
      studentId: parentStudent.id,
      contactId: parentContact.id,
    });

    const capture = await revokeAs({ id: admin.id, isSystemAdmin: true }, consent.id);
    expect(capture.statusCode).toBe(200);

    const row = await waitForActivityRow({
      eventType: 'consent_revoked',
      subjectId1: consent.id,
    });
    expect(row!.details.revocation_path).toBe('system_admin');
  });

  // ==========================================================================
  // THE UI AFFORDANCE — the server's answer, not the client's guess
  // ==========================================================================

  describe('GET /api/consent/students/:studentId/history — canRevoke', () => {
    it('advertises the button to a member who may revoke, and hides it where they may not', async () => {
      const {
        attester,
        member,
        attestedStudent,
        clinicContact,
        parentStudent,
        parentContact,
      } = await setupClinic();
      await attestConsent({
        attesterId: attester.id,
        studentId: attestedStudent.id,
        contactId: clinicContact.id,
      });
      await signAsParent({ studentId: parentStudent.id, contactId: parentContact.id });

      const readHistoryAs = async (userId: string, studentId: string) => {
        const req = makeReq({ user: { id: userId }, params: { studentId } });
        const { res, capture } = makeRes();
        await consentController.listHistory(req, res);
        expect(capture.statusCode).toBe(200);
        return (capture.jsonBody as any).history as any[];
      };

      // Attested record → the member may revoke, so the flag is true.
      const attestedHistory = await readHistoryAs(member.id, attestedStudent.id);
      expect(attestedHistory[0].canRevoke).toBe(true);

      // Parent-signed record for a student in the same institute → false.
      const parentHistory = await readHistoryAs(member.id, parentStudent.id);
      expect(parentHistory[0].canRevoke).toBe(false);
    });

    it('reports canRevoke false on an already-revoked record', async () => {
      const { attester, member, attestedStudent, clinicContact } = await setupClinic();
      const consent = await attestConsent({
        attesterId: attester.id,
        studentId: attestedStudent.id,
        contactId: clinicContact.id,
      });
      await revokeAs({ id: member.id }, consent.id);

      const req = makeReq({
        user: { id: member.id },
        params: { studentId: attestedStudent.id },
      });
      const { res, capture } = makeRes();
      await consentController.listHistory(req, res);
      const history = (capture.jsonBody as any).history as any[];
      expect(history).toHaveLength(1);
      expect(history[0].revokedAt).not.toBeNull();
      expect(history[0].canRevoke).toBe(false);
    });
  });
});
