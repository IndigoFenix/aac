/**
 * Integration tests verifying the consent gate is wired into the right
 * choke points beyond the share-invite path: report finalize, program
 * activate. AAC session start is also gated but the dual-agent service
 * needs heavier setup; that wiring is verified by typecheck + manual
 * review (gate is the first statement of initializeSession).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';

import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeStudent, makeInstitute } from '../helpers/factories.js';
import {
  studentContacts,
  medicalRecords,
  programs,
  type MedicalRecord,
  type Program,
} from '@shared/schema';
import { studentRepository } from '../../repositories/studentRepository.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { reportController } from '../../controllers/reportController.js';
import { programController } from '../../controllers/programController.js';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import { requireConsentForResponse } from '../../services/consent/consentGate.js';
import {
  lookupConsentNotice,
  renderNoticeForHashing,
} from '@shared/legal';

const ENV_FLAG = 'CONSENT_GATE_ENABLED';

async function setupClinicWithStudentAndContact() {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
  const { student } = await makeStudent(owner.id, { country: 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);

  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Test Guardian',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: owner.id,
    isLegalGuardian: true,
  }).returning();

  return { owner, institute, student, contact };
}

async function signTestConsent(args: { studentId: string; contactId: string }) {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
  const input: SignConsentInput = {
    studentId: args.studentId,
    signedByContactId: args.contactId,
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
  return consentService.signConsent(input);
}

describe('Consent gate — Express helper', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env[ENV_FLAG]; });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  it('passes through when gate is disabled', async () => {
    delete process.env[ENV_FLAG];
    const { student } = await setupClinicWithStudentAndContact();
    const req = makeReq({ user: { id: 'x' } });
    const { res, capture } = makeRes();
    const ok = await requireConsentForResponse(req, res, student.id);
    expect(ok).toBe(true);
    expect(capture.ended).toBe(false);
  });

  it('writes 412 when gate is enabled and no consent exists', async () => {
    process.env[ENV_FLAG] = 'true';
    const { student } = await setupClinicWithStudentAndContact();
    const req = makeReq({ user: { id: 'x' } });
    const { res, capture } = makeRes();
    const ok = await requireConsentForResponse(req, res, student.id);
    expect(ok).toBe(false);
    expect(capture.statusCode).toBe(412);
    expect((capture.jsonBody as any).code).toBe('consent_required');
  });

  it('passes when gate is on and active consent exists', async () => {
    process.env[ENV_FLAG] = 'true';
    const { student, contact } = await setupClinicWithStudentAndContact();
    await signTestConsent({ studentId: student.id, contactId: contact.id });
    const req = makeReq({ user: { id: 'x' } });
    const { res, capture } = makeRes();
    const ok = await requireConsentForResponse(req, res, student.id);
    expect(ok).toBe(true);
    expect(capture.ended).toBe(false);
  });
});

describe('Consent gate — finalize wiring', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env[ENV_FLAG]; });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  it('finalizeMedicalRecord returns 412 when gate is on without consent', async () => {
    process.env[ENV_FLAG] = 'true';
    const { owner, institute, student } = await setupClinicWithStudentAndContact();
    const [record] = await db.insert(medicalRecords).values({
      studentId: student.id,
      instituteId: institute.id,
      status: 'draft',
      createdBy: owner.id,
    } as any).returning();

    const req = makeReq({
      user: { id: owner.id, isSystemAdmin: false },
      params: { id: (record as MedicalRecord).id },
    });
    const { res, capture } = makeRes();
    await reportController.finalizeMedicalRecord(req, res);

    expect(capture.statusCode).toBe(412);
    expect((capture.jsonBody as any).code).toBe('consent_required');
  });

  it('activateProgram returns 412 when gate is on without consent', async () => {
    process.env[ENV_FLAG] = 'true';
    const { owner, institute, student } = await setupClinicWithStudentAndContact();
    const [program] = await db.insert(programs).values({
      studentId: student.id,
      instituteId: institute.id,
      name: 'Test program',
      framework: 'tala',
      status: 'draft',
      createdBy: owner.id,
    } as any).returning();

    const req = makeReq({
      user: { id: owner.id, isSystemAdmin: false },
      query: { instituteId: institute.id },
      params: { id: (program as Program).id },
    });
    const { res, capture } = makeRes();
    await programController.activateProgram(req, res);

    expect(capture.statusCode).toBe(412);
    expect((capture.jsonBody as any).code).toBe('consent_required');
  });
});
