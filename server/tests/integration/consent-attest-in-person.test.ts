/**
 * In-person clinician-attested consent — controller integration tests.
 *
 * The path under test: a clinic guardian is a NAME AND AN EMAIL with no user
 * account, so `POST .../sign` can never admit them (it requires
 * `contact.linkedUserId === caller`). `POST .../attest-in-person` admits them
 * because the caller is not claiming to BE the guardian — they are attesting,
 * from their own identified session, that they saw one.
 *
 * ⚠️ Contacts here deliberately have NO `contactEmail`. `sendConsentReceipt`
 * no-ops on a null address, and the test environment carries live SES
 * credentials — a contact with an address would make this suite SEND.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

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
import { activityLogs, studentContacts } from '@shared/schema';
import { consentController } from '../../controllers/consentController.js';
import {
  checkIdvAcceptability,
  getIdvMethodSpec,
  listAcceptableMethodsForRegime,
  lookupConsentNotice,
  renderNoticeForHashing,
} from '@shared/legal';

const METHOD = 'in_person_clinician_attested';

/**
 * A clinic: an institute, a student enrolled in it, a guardian contact with NO
 * linked user account (the case the parent flow structurally cannot serve), and
 * a plain non-admin member who will do the attesting.
 */
async function setupClinic(opts: { country: string; birthDate: string }) {
  const admin = await makeUser({ firstName: 'Admin', lastName: 'User' });
  const { institute } = await makeInstitute(admin.id);
  const clinician = await makeUser({ firstName: 'Dana', lastName: 'Levi' });
  // Non-admin on purpose: the chosen permission level is ANY ACTIVE MEMBER,
  // and this is the row that proves it.
  await addUserToInstitute(institute.id, clinician.id, { isAdmin: false });

  const { student } = await makeStudent(admin.id, { country: opts.country });
  await studentRepository.updateStudent(student.id, { birthDate: opts.birthDate } as any);
  await enrollStudent(institute.id, student.id, admin.id);

  const [contact] = await db
    .insert(studentContacts)
    .values({
      studentId: student.id,
      name: 'Ruth Mizrahi',
      relationship: 'parent_guardian',
      role: 'parent_guardian',
      linkedUserId: null, // ← the whole point
      isLegalGuardian: false,
    })
    .returning();

  return { admin, institute, clinician, student, contact };
}

function ilNotice() {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  return {
    version: notice.version,
    hash: createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex'),
  };
}

function buildAttestBody(args: { contactId: string; extra?: Record<string, unknown> }) {
  const notice = ilNotice();
  return {
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
      notes: 'TZ inspected, photo matches',
    },
    guardianFields: {
      governmentIdNumber: '123456789',
      governmentIdCountry: 'IL',
      coGuardianAcknowledged: true,
    },
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    ...(args.extra ?? {}),
  };
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

describe('POST /api/consent/students/:studentId/attest-in-person', () => {
  afterEach(truncateAll);

  it('records consent for a guardian contact with no user account, attested by a plain institute member', async () => {
    const { clinician, student, contact } = await setupClinic({
      country: 'IL',
      birthDate: '2018-01-01',
    });

    const req = makeReq({
      user: { id: clinician.id },
      params: { studentId: student.id },
      body: buildAttestBody({ contactId: contact.id }),
    });
    const { res, capture } = makeRes();
    await consentController.attestInPerson(req, res);

    expect(capture.statusCode).toBe(200);
    const body = capture.jsonBody as any;
    expect(body.success).toBe(true);

    // The method is the server's, on BOTH legs (it provides both alone).
    expect(body.consent.identityVerificationMethod).toBe(METHOD);
    expect(body.consent.nonRepudiationMethod).toBe(METHOD);

    // The attesting clinician is on the record and is QUERYABLE — the
    // repository call is the auditor's entry point, not a hand-written
    // jsonb path.
    expect(body.consent.identityVerificationEvidence.attestingClinicianUserId).toBe(clinician.id);
    expect(body.consent.identityVerificationEvidence.guardianPresent).toBe(true);
    expect(body.consent.identityVerificationEvidence.identificationInspected.type).toBe('national_id');
    const attested = await studentConsentRecordRepository.listAttestedByUser(clinician.id);
    expect(attested.map((r) => r.id)).toContain(body.consent.id);

    // Data minimisation: the ID NUMBER lives on the contact row only. A second
    // plaintext copy in an un-redacted jsonb column is what this asserts against.
    const evidenceJson = JSON.stringify(body.consent.identityVerificationEvidence);
    expect(evidenceJson).not.toContain('123456789');

    // The guardian's own signature is the non-repudiation artefact that is theirs.
    expect(body.consent.nonRepudiationEvidence.signature.mode).toBe('typed');
    expect(body.consent.nonRepudiationEvidence.signature.typedName).toBe('Ruth Mizrahi');

    // `isLegalGuardian` was established BY THE ATTESTATION, and the contact row
    // says which — `clinician_attested`, never the parent flow's `self_declared`.
    const [after] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, contact.id));
    expect(after.isLegalGuardian).toBe(true);
    expect(after.governmentIdVerificationProvider).toBe('clinician_attested');
    expect(after.governmentIdVerifiedVia).toBe('manual_entry');
    expect(after.governmentIdType).toBe('national_id');
    expect(after.governmentIdNumber).toBe('123456789');
    expect(after.legalGuardianDeclaredAt).toBeTruthy();

    // Audit: the attestation act gets its own row, distinguishable from a
    // self-signed consent by event type as well as by IDV method.
    const idRow = await waitForActivityRow({
      eventType: 'guardian_id_verified',
      subjectId1: contact.id,
    });
    expect(idRow).not.toBeNull();
    expect(idRow!.userId).toBe(clinician.id);
    expect(idRow!.subjectId2).toBe(student.id);
    expect(idRow!.details.attestingClinicianUserId).toBe(clinician.id);
    expect(idRow!.details.identityVerificationMethod).toBe(METHOD);

    const signedRow = await waitForActivityRow({
      eventType: 'consent_signed',
      subjectId1: body.consent.id,
    });
    expect(signedRow).not.toBeNull();
    expect(signedRow!.details.identityVerificationMethod).toBe(METHOD);
  });

  // ==========================================================================
  // THE LEGAL PIN
  // ==========================================================================

  describe('COPPA refusal', () => {
    /**
     * The rule itself, pinned at the DATA layer. If someone later adds
     * `us_coppa` to this method's `acceptedFor` set — the accident the ticket
     * names — this fails immediately, independently of any HTTP behaviour.
     */
    it('the registry does not accept in-person attestation for us_coppa', () => {
      expect(getIdvMethodSpec(METHOD)!.acceptedFor.has('us_coppa')).toBe(false);
      expect(listAcceptableMethodsForRegime('us_coppa')).not.toContain(METHOD);
      const check = checkIdvAcceptability({
        identityMethod: METHOD,
        nonRepudiationMethod: METHOD,
        regime: 'us_coppa',
      });
      expect(check.acceptable).toBe(false);
      expect(check.reason).toBe('identity_method_not_accepted_for_regime');
    });

    it('REFUSES a US student under 13, for the COPPA reason specifically', async () => {
      const { clinician, student, contact } = await setupClinic({
        country: 'US',
        birthDate: '2018-01-01', // age 7 at the time of writing → us_coppa
      });

      const req = makeReq({
        user: { id: clinician.id },
        params: { studentId: student.id },
        body: buildAttestBody({ contactId: contact.id }),
      });
      const { res, capture } = makeRes();
      await consentController.attestInPerson(req, res);

      expect(capture.statusCode).toBe(422);
      const body = capture.jsonBody as any;
      expect(body.code).toBe('idv_not_acceptable');
      // Not "it failed" — it failed for THIS reason, in THIS regime, about
      // THIS method.
      expect(body.details.regime).toBe('us_coppa');
      expect(body.details.enhancedProtectionRegime).toBe('us_coppa');
      expect(body.details.reason).toBe('identity_method_not_accepted_for_regime');
      expect(body.details.identityMethod).toBe(METHOD);

      // And nothing was written on the way to the refusal: a rejected
      // attestation must not leave `isLegalGuardian` flipped behind it.
      const [after] = await db
        .select()
        .from(studentContacts)
        .where(eq(studentContacts.id, contact.id));
      expect(after.isLegalGuardian).toBe(false);
      expect(await studentConsentRecordRepository.getActiveForStudent(student.id)).toBeUndefined();
    });

    /**
     * NON-VACUITY. Same country, same clinic, same payload — only the age
     * differs. A US 14-year-old is past the COPPA threshold, so the regime is
     * no longer `us_coppa` and the method IS acceptable; the request gets past
     * the IDV gate and dies later, at `notice_not_found` (there is no US notice
     * text by design).
     *
     * Without this the COPPA test would pass just as well against a handler
     * that refused every US student, or against one that refused everything.
     */
    it('does NOT refuse a US student over 13 for the COPPA reason', async () => {
      const { clinician, student, contact } = await setupClinic({
        country: 'US',
        birthDate: '2011-06-01', // age 14/15 → past the COPPA threshold
      });

      const req = makeReq({
        user: { id: clinician.id },
        params: { studentId: student.id },
        body: buildAttestBody({ contactId: contact.id }),
      });
      const { res, capture } = makeRes();
      await consentController.attestInPerson(req, res);

      expect(capture.statusCode).not.toBe(422);
      const body = capture.jsonBody as any;
      expect(body.code).not.toBe('idv_not_acceptable');
      // It got all the way to the notice lookup inside signConsent.
      expect(capture.statusCode).toBe(404);
      expect(body.code).toBe('notice_not_found');
    });
  });

  // ==========================================================================
  // PERMISSION
  // ==========================================================================

  it('403s a caller with no institute overlap with the student', async () => {
    const { student, contact } = await setupClinic({ country: 'IL', birthDate: '2018-01-01' });

    // A fully legitimate clinician — of somebody else's clinic.
    const outsider = await makeUser({ firstName: 'Outside', lastName: 'Clinician' });
    const { institute: otherInstitute } = await makeInstitute(outsider.id);
    expect(otherInstitute.id).toBeTruthy();

    const req = makeReq({
      user: { id: outsider.id },
      params: { studentId: student.id },
      body: buildAttestBody({ contactId: contact.id }),
    });
    const { res, capture } = makeRes();
    await consentController.attestInPerson(req, res);

    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).code).toBe('permission_denied');
    expect(await studentConsentRecordRepository.getActiveForStudent(student.id)).toBeUndefined();
  });

  it('401s an unauthenticated caller', async () => {
    const { student, contact } = await setupClinic({ country: 'IL', birthDate: '2018-01-01' });
    const req = makeReq({
      user: null,
      params: { studentId: student.id },
      body: buildAttestBody({ contactId: contact.id }),
    });
    const { res, capture } = makeRes();
    await consentController.attestInPerson(req, res);
    expect(capture.statusCode).toBe(401);
  });

  it('403s a contact belonging to a different student', async () => {
    const clinic = await setupClinic({ country: 'IL', birthDate: '2018-01-01' });
    const other = await setupClinic({ country: 'IL', birthDate: '2018-01-01' });
    // The caller is a member of clinic A; the contact is student B's.
    const req = makeReq({
      user: { id: clinic.clinician.id },
      params: { studentId: clinic.student.id },
      body: buildAttestBody({ contactId: other.contact.id }),
    });
    const { res, capture } = makeRes();
    await consentController.attestInPerson(req, res);
    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).code).toBe('contact_not_for_student');
  });

  // ==========================================================================
  // THE SERVER OWNS THE METHOD
  // ==========================================================================

  it('ignores a client-supplied identityVerificationMethod — the server value wins', async () => {
    const { clinician, student, contact } = await setupClinic({
      country: 'IL',
      birthDate: '2018-01-01',
    });

    const req = makeReq({
      user: { id: clinician.id },
      params: { studentId: student.id },
      body: buildAttestBody({
        contactId: contact.id,
        extra: {
          // `gov_sso` is the interesting attack: it IS accepted for us_coppa,
          // so a client that could name it would buy a stronger regime than
          // the clinic desk earns.
          identityVerificationMethod: 'gov_sso',
          nonRepudiationMethod: 'gov_sso',
          identityVerificationEvidence: { attestingClinicianUserId: 'somebody-else' },
          isSensitive: false,
        },
      }),
    });
    const { res, capture } = makeRes();
    await consentController.attestInPerson(req, res);

    expect(capture.statusCode).toBe(200);
    const consent = (capture.jsonBody as any).consent;
    expect(consent.identityVerificationMethod).toBe(METHOD);
    expect(consent.nonRepudiationMethod).toBe(METHOD);
    // The evidence is the server's too — the smuggled attester id is gone.
    expect(consent.identityVerificationEvidence.attestingClinicianUserId).toBe(clinician.id);
  });

  // ==========================================================================
  // THE PARENT FLOW IS UNCHANGED
  // ==========================================================================

  it('leaves POST .../sign refusing an unlinked contact, even for an institute member', async () => {
    const { clinician, student, contact } = await setupClinic({
      country: 'IL',
      birthDate: '2018-01-01',
    });
    const notice = ilNotice();

    const req = makeReq({
      user: { id: clinician.id },
      params: { studentId: student.id },
      body: {
        signedByContactId: contact.id,
        locale: 'en',
        consentTextVersion: notice.version,
        consentTextHash: notice.hash,
        purposeAcknowledged: true,
        voluntarinessAcknowledged: true,
        thirdPartyTransfersAcknowledged: true,
        isSensitive: false,
      },
    });
    const { res, capture } = makeRes();
    await consentController.signConsent(req, res);

    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).code).toBe('contact_not_owned_by_caller');
    expect(await studentConsentRecordRepository.getActiveForStudent(student.id)).toBeUndefined();
  });

  // ==========================================================================
  // THE WIZARD'S CONTEXT
  // ==========================================================================

  it('wizard-context?contactId returns the named contact to an institute member', async () => {
    const { clinician, student, contact } = await setupClinic({
      country: 'IL',
      birthDate: '2018-01-01',
    });
    const req = makeReq({
      user: { id: clinician.id },
      params: { studentId: student.id },
      query: { contactId: contact.id },
    });
    const { res, capture } = makeRes();
    await consentController.getWizardContext(req, res);

    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).guardianContact.id).toBe(contact.id);
  });

  it('wizard-context?contactId is 403 for a caller with no institute overlap', async () => {
    const { student, contact } = await setupClinic({ country: 'IL', birthDate: '2018-01-01' });
    const outsider = await makeUser();
    const req = makeReq({
      user: { id: outsider.id },
      params: { studentId: student.id },
      query: { contactId: contact.id },
    });
    const { res, capture } = makeRes();
    await consentController.getWizardContext(req, res);

    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).code).toBe('permission_denied');
  });
});
