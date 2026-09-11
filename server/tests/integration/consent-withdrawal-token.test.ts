/**
 * SELF-SERVE WITHDRAWAL OF CONSENT — the signer with no user account (§5.3).
 *
 * The gap: `POST /api/consent/:consentId/revoke` requires a session and resolves
 * the caller through `studentContacts.linkedUserId`. A guardian who signed by
 * magic link — the NORMAL clinic path — has an email, a phone, and no `users`
 * row, so that rule can never admit them, and the sign token was consumed at
 * sign time. Their consent receipt told them to withdraw "by contacting the
 * clinic", and that was literally the only path. GDPR Art. 7(3) requires
 * withdrawal to be as easy as giving; giving was a link in an email.
 *
 * ⚠️ WHAT THIS SUITE IS FOR, in order of importance:
 *   1. The end-to-end withdrawal actually works for BOTH unlinked-signer record
 *      kinds — magic-link-signed and in-person-attested.
 *   2. The second factor is checked at the COMMIT, not merely offered. A client
 *      that skips /verify-otp must not be able to reach the revoke.
 *   3. The token is bound to ONE consent record, is single-use, expires, and is
 *      refused on the SIGN flow (purpose confusion is a confused-deputy bug).
 *   4. Enumeration safety: a bogus reference and a real one are indistinguishable.
 *   5. The §7.5 cascade still fires and the audit row says `signer_token`.
 *
 * ⚠️ EMAIL. The test environment carries LIVE SES credentials (server/tests
 * /setup.ts strips LLM keys and touches no AWS_* variable), so an unmocked send
 * from here is a real SES call. This suite must therefore give contacts real
 * addresses — the whole feature IS delivery — and so it injects the dispatcher
 * (`setWithdrawalDispatcher`) rather than relying on the "no email on file"
 * trick the other consent suites use. The injection point exists for exactly
 * this reason; never `NODE_ENV`-guard the shared sender instead.
 *
 * ⚠️ BUT THE INJECTION ONLY COVERS THE WITHDRAWAL SERVICE. `sendConsentReceipt`
 * is a SEPARATE path that reaches `emailService` directly, and any test here
 * that drives a real SIGN controller (`attestInPerson`, `signConsent`) with a
 * contact that has a `contactEmail` WILL make a live SES call. Every consent
 * record in this suite is therefore created either through
 * `consentService.signConsent` (the service, which sends no receipt) or with a
 * contact that has no email. Adding an email to an attested contact here is how
 * this suite starts mailing strangers.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
import { consentInvitationRepository } from '../../repositories/consentInvitationRepository.js';
import {
  activityLogs,
  consentInvitations,
  instituteStudents,
  objectShares,
  programs,
  standingShares,
  studentContacts,
  studentShareInvites,
} from '@shared/schema';
import { consentController } from '../../controllers/consentController.js';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import {
  setWithdrawalDispatcher,
  resetWithdrawalDispatcher,
  type WithdrawalMessage,
} from '../../services/consent/consentWithdrawalService.js';
import { lookupConsentNotice, renderNoticeForHashing } from '@shared/legal';

const ATTESTED = 'in_person_clinician_attested';
const MAGIC_LINK = 'verified_phone_otp';

// ============================================================================
// Captured delivery
// ============================================================================

interface Sent {
  kind: 'email' | 'sms';
  to: string;
  body: string;
}

let sent: Sent[] = [];

function installDispatcher(): void {
  sent = [];
  setWithdrawalDispatcher({
    async sendEmail(msg: WithdrawalMessage) {
      sent.push({ kind: 'email', to: msg.to, body: `${msg.text}\n${msg.html}` });
      return { success: true };
    },
    async sendSms(msg: { to: string; body: string }) {
      sent.push({ kind: 'sms', to: msg.to, body: msg.body });
      return { success: true };
    },
  });
}

/** Pull the one-time code out of whatever we actually delivered. */
function codeFromLastMessage(): string {
  const last = sent[sent.length - 1];
  expect(last).toBeDefined();
  const m = /consent\/withdraw#code=([A-Z0-9]+)/.exec(last.body);
  expect(m).not.toBeNull();
  return m![1];
}

// ============================================================================
// Fixtures
// ============================================================================

function ilNotice() {
  const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
  return {
    version: notice.version,
    hash: createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex'),
  };
}

/**
 * One clinic, one admin, one plain non-admin member, and a `newStudent()` that
 * enrolls a fresh IL student into it.
 *
 * Each test then attaches the contact shape it needs via `addContact`, because
 * the contact's shape IS the variable under test: a phone selects the SMS
 * channel and its OTP factor, an email-only contact selects the email channel
 * (whose factor exists only when an institute ID is on file, exactly as at
 * signing), and a contact with a `linkedUserId` must be refused a token
 * altogether — they already have the session path.
 */
async function setupClinic() {
  const admin = await makeUser({ firstName: 'Admin', lastName: 'User' });
  const { institute } = await makeInstitute(admin.id, { type: 'clinic' });
  const member = await makeUser({ firstName: 'Noa', lastName: 'Barak' });
  await addUserToInstitute(institute.id, member.id, { isAdmin: false });

  async function newStudent() {
    const { student } = await makeStudent(admin.id, { country: 'IL' });
    await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
    await enrollStudent(institute.id, student.id, admin.id);
    return student;
  }

  return { admin, member, institute, newStudent };
}

async function addContact(
  studentId: string,
  opts: {
    email?: string | null;
    phone?: string | null;
    linkedUserId?: string | null;
    isLegalGuardian?: boolean;
  } = {},
) {
  const [row] = await db
    .insert(studentContacts)
    .values({
      studentId,
      name: 'Ruth Mizrahi',
      relationship: 'parent_guardian',
      role: 'parent_guardian',
      contactEmail: opts.email ?? null,
      contactPhone: opts.phone ?? null,
      linkedUserId: opts.linkedUserId ?? null,
      isLegalGuardian: opts.isLegalGuardian ?? true,
    })
    .returning();
  return row;
}

/** A record shaped like the magic-link parent flow's output (§5, signInvitation). */
async function signAsMagicLinkParent(studentId: string, contactId: string) {
  const notice = ilNotice();
  return consentService.signConsent({
    studentId,
    signedByContactId: contactId,
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
  } as SignConsentInput);
}

/** Drive the REAL attest endpoint so the record under test is a real one. */
async function attestConsent(attesterId: string, studentId: string, contactId: string) {
  const notice = ilNotice();
  const req = makeReq({
    user: { id: attesterId },
    params: { studentId },
    body: {
      signedByContactId: contactId,
      locale: 'en',
      consentTextVersion: notice.version,
      consentTextHash: notice.hash,
      signature: { mode: 'typed' as const, typedName: 'Ruth Mizrahi' },
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

// ---- endpoint drivers -------------------------------------------------------

async function call(
  handler: (req: any, res: any) => Promise<void>,
  body: unknown,
  opts: { user?: Record<string, unknown> | null; params?: Record<string, string> } = {},
) {
  const req = makeReq({ body, user: opts.user ?? null, params: opts.params ?? {} });
  const { res, capture } = makeRes();
  await handler(req as any, res as any);
  return capture;
}

const requestLink = (reference: string) =>
  call((r, s) => consentController.requestWithdrawalLink(r, s), { reference });
const context = (code: string) =>
  call((r, s) => consentController.getWithdrawalContext(r, s), { code });
const requestOtp = (code: string) =>
  call((r, s) => consentController.requestWithdrawalOtp(r, s), { code });
const verifyOtp = (code: string, otpCode: string) =>
  call((r, s) => consentController.verifyWithdrawalOtp(r, s), { code, otpCode });
const verifyId = (code: string, last4: string) =>
  call((r, s) => consentController.verifyWithdrawalChildId(r, s), { code, last4 });
const confirm = (body: unknown) =>
  call((r, s) => consentController.confirmWithdrawal(r, s), body);

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

// ============================================================================

describe('consent withdrawal by the signer — no user account (§5.3)', () => {
  const prevBypass = process.env.SMS_VERIFICATION_BYPASS;

  beforeEach(() => {
    installDispatcher();
    // Lets the SMS leg accept the literal 000000 — the plaintext OTP is never
    // stored, so a test cannot otherwise complete the phone factor. Same knob
    // consent-invitation.test.ts uses for the sign flow.
    process.env.SMS_VERIFICATION_BYPASS = 'true';
  });

  afterEach(async () => {
    resetWithdrawalDispatcher();
    if (prevBypass === undefined) delete process.env.SMS_VERIFICATION_BYPASS;
    else process.env.SMS_VERIFICATION_BYPASS = prevBypass;
    await truncateAll();
  });

  // ==========================================================================
  // 1. THE END-TO-END WITHDRAWAL — both unlinked-signer record kinds
  // ==========================================================================

  it('a guardian with no linkedUserId withdraws a MAGIC-LINK-signed consent end to end', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, {
      email: 'ruth@example.test',
      phone: '+972501234567',
    });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    expect(consent.identityVerificationMethod).toBe(MAGIC_LINK);

    // ── The receipt's reference link ──────────────────────────────────────
    const asked = await requestLink(consent.id);
    expect(asked.statusCode).toBe(200);
    // It reached the phone ALREADY ON FILE — not an address in the request.
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('sms');
    expect(sent[0].to).toBe('+972501234567');
    const code = codeFromLastMessage();

    // ── The page resolves the token ───────────────────────────────────────
    const ctx = await context(code);
    expect(ctx.statusCode).toBe(200);
    const ctxBody = ctx.jsonBody as any;
    expect(ctxBody.requiresPhoneOtp).toBe(true);
    expect(ctxBody.consent.id).toBe(consent.id);
    expect(ctxBody.student.id).toBe(student.id);
    expect(ctxBody.contact.name).toBe('Ruth Mizrahi');

    // ── Second factor: the same phone OTP the SIGN flow uses ──────────────
    expect((await requestOtp(code)).statusCode).toBe(200);
    expect((await verifyOtp(code, '000000')).statusCode).toBe(200);

    // ── Confirm ───────────────────────────────────────────────────────────
    const done = await confirm({ code, confirm: true, reason: 'No longer needed' });
    expect(done.statusCode).toBe(200);

    const after = await studentConsentRecordRepository.getById(consent.id);
    expect(after!.revokedAt).not.toBeNull();
    expect(after!.revocationReason).toBe('No longer needed');
    // No account exists for this person, so the FK column is null BY DESIGN.
    // Who withdrew is carried by the audit row, not by this column.
    expect(after!.revokedByUserId).toBeNull();
  });

  it('the same flow works for an IN-PERSON-ATTESTED record', async () => {
    const { member, newStudent } = await setupClinic();
    const student = await newStudent();
    // NO contactEmail, deliberately. This is the one test that drives the REAL
    // `attestInPerson` controller, and that controller calls
    // `sendConsentReceipt` — which goes through `emailService` directly, NOT
    // through this suite's injected dispatcher, and so would make a live SES
    // call. `sendConsentReceipt` no-ops on a null address, the same trick
    // `consent-attest-in-person.test.ts` documents in its header. The
    // withdrawal itself needs only the phone.
    const contact = await addContact(student.id, {
      phone: '+972502222222',
      isLegalGuardian: false,
    });
    const consent = await attestConsent(member.id, student.id, contact.id);
    expect(consent.identityVerificationMethod).toBe(ATTESTED);

    expect((await requestLink(consent.id)).statusCode).toBe(200);
    const code = codeFromLastMessage();
    expect((await requestOtp(code)).statusCode).toBe(200);
    expect((await verifyOtp(code, '000000')).statusCode).toBe(200);
    expect((await confirm({ code, confirm: true })).statusCode).toBe(200);

    const after = await studentConsentRecordRepository.getById(consent.id);
    expect(after!.revokedAt).not.toBeNull();
  });

  it('an EMAIL-channel withdrawal gates on the same child-ID last-4 the sign flow gates on', async () => {
    const { institute, newStudent } = await setupClinic();
    const student = await newStudent();
    // An institute ID on file is what makes the email knowledge factor exist —
    // at signing and, identically, here.
    await db
      .update(instituteStudents)
      .set({ idNumber: '123456789' })
      .where(
        and(
          eq(instituteStudents.instituteId, institute.id),
          eq(instituteStudents.studentId, student.id),
        ),
      );
    // Email only: no phone means no SMS channel to prefer.
    const contact = await addContact(student.id, { email: 'ruth@example.test' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    await requestLink(consent.id);
    expect(sent[0].kind).toBe('email');
    expect(sent[0].to).toBe('ruth@example.test');
    const code = codeFromLastMessage();

    const ctx = await context(code);
    expect((ctx.jsonBody as any).requiresIdVerification).toBe(true);
    expect((ctx.jsonBody as any).requiresPhoneOtp).toBe(false);

    // A wrong last-4 burns an attempt and refuses.
    const wrong = await verifyId(code, '0000');
    expect(wrong.statusCode).toBe(422);
    expect((wrong.jsonBody as any).code).toBe('child_id_mismatch');

    // The right one passes, and the withdrawal then commits.
    expect((await verifyId(code, '6789')).statusCode).toBe(200);
    expect((await confirm({ code, confirm: true })).statusCode).toBe(200);
    expect((await studentConsentRecordRepository.getById(consent.id))!.revokedAt).not.toBeNull();
  });

  // ==========================================================================
  // 2. THE SECOND FACTOR IS CHECKED AT THE COMMIT
  // ==========================================================================

  it('refuses the commit when the phone OTP was never verified', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972503333333' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    await requestLink(consent.id);
    const code = codeFromLastMessage();

    // Straight to confirm — exactly what a client that skipped the OTP screen
    // (or a script that never rendered one) would do.
    const capture = await confirm({ code, confirm: true });
    expect(capture.statusCode).toBe(412);
    expect((capture.jsonBody as any).code).toBe('phone_otp_required');

    // AND NOTHING COMMITTED. A refusal that still revoked would be worse than
    // no check at all.
    expect((await studentConsentRecordRepository.getById(consent.id))!.revokedAt).toBeNull();
    // The token is also still live, so the guardian can complete the factor.
    const [inv] = await db
      .select()
      .from(consentInvitations)
      .where(eq(consentInvitations.targetConsentId, consent.id));
    expect(inv.redeemedAt).toBeNull();
  });

  it('refuses the commit when the child-ID factor applies and was never verified', async () => {
    const { institute, newStudent } = await setupClinic();
    const student = await newStudent();
    await db
      .update(instituteStudents)
      .set({ idNumber: '123456789' })
      .where(
        and(
          eq(instituteStudents.instituteId, institute.id),
          eq(instituteStudents.studentId, student.id),
        ),
      );
    const contact = await addContact(student.id, { email: 'ruth@example.test' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    await requestLink(consent.id);
    const capture = await confirm({ code: codeFromLastMessage(), confirm: true });
    expect(capture.statusCode).toBe(412);
    expect((capture.jsonBody as any).code).toBe('child_id_verification_required');
    expect((await studentConsentRecordRepository.getById(consent.id))!.revokedAt).toBeNull();
  });

  it('refuses a confirm that does not carry the explicit human confirmation', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972504444444' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);
    const code = codeFromLastMessage();
    await requestOtp(code);
    await verifyOtp(code, '000000');

    // A link-prefetcher / scanner never gets this far (it would have to POST),
    // but the server refuses anyway rather than trusting the client's checkbox.
    expect((await confirm({ code })).statusCode).toBe(400);
    expect((await confirm({ code, confirm: false })).statusCode).toBe(400);
    expect((await studentConsentRecordRepository.getById(consent.id))!.revokedAt).toBeNull();

    // ...and the same call WITH the flag succeeds, so the refusals above are
    // about the flag and not about some other unmet precondition.
    expect((await confirm({ code, confirm: true })).statusCode).toBe(200);
  });

  // ==========================================================================
  // 3. TOKEN LIFECYCLE AND BINDING
  // ==========================================================================

  it('is single-use: a second withdrawal with the same token is refused', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972505555555' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);
    const code = codeFromLastMessage();
    await requestOtp(code);
    await verifyOtp(code, '000000');
    expect((await confirm({ code, confirm: true })).statusCode).toBe(200);

    const again = await confirm({ code, confirm: true });
    expect(again.statusCode).toBe(410);
    expect((again.jsonBody as any).code).toBe('code_already_used');
  });

  it('refuses an expired token, and says only that it expired', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972506666666' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);
    const code = codeFromLastMessage();

    await db
      .update(consentInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(consentInvitations.targetConsentId, consent.id));

    const ctx = await context(code);
    expect(ctx.statusCode).toBe(410);
    expect((ctx.jsonBody as any).code).toBe('code_expired');
    // Nothing about the student, the contact or the record leaks out with it.
    const body = JSON.stringify(ctx.jsonBody);
    expect(body).not.toContain(student.id);
    expect(body).not.toContain(consent.id);
    expect(body).not.toContain('Ruth');
  });

  it('a token minted for one consent record cannot touch another', async () => {
    const { newStudent } = await setupClinic();
    const studentA = await newStudent();
    const studentB = await newStudent();
    const contactA = await addContact(studentA.id, { phone: '+972507777777' });
    const contactB = await addContact(studentB.id, { phone: '+972508888888' });
    const consentA = await signAsMagicLinkParent(studentA.id, contactA.id);
    const consentB = await signAsMagicLinkParent(studentB.id, contactB.id);

    await requestLink(consentA.id);
    const codeA = codeFromLastMessage();
    await requestOtp(codeA);
    await verifyOtp(codeA, '000000');
    expect((await confirm({ code: codeA, confirm: true })).statusCode).toBe(200);

    // A's token withdrew A and only A. There is no request field by which a
    // caller could have aimed it at B — the binding is the token's own
    // `target_consent_id` FK, not anything the client sends.
    expect((await studentConsentRecordRepository.getById(consentA.id))!.revokedAt).not.toBeNull();
    expect((await studentConsentRecordRepository.getById(consentB.id))!.revokedAt).toBeNull();
  });

  it('a WITHDRAWAL token is not a credential for the SIGN flow', async () => {
    // Confused-deputy pin. Both purposes live in `consent_invitations`; if the
    // purpose check ever came out, a withdrawal token POSTed to the sign
    // endpoint would be a valid credential for CREATING a consent record.
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972509999999' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);
    const code = codeFromLastMessage();

    const notice = ilNotice();
    const capture = await call((r, s) => consentController.signInvitation(r, s), {
      code,
      locale: 'en',
      consentTextVersion: notice.version,
      consentTextHash: notice.hash,
      purposeAcknowledged: true,
      voluntarinessAcknowledged: true,
      thirdPartyTransfersAcknowledged: true,
    });
    // And the refusal is `code_not_found`, not "wrong purpose": the caller must
    // not learn that the code exists and is live for something else.
    expect(capture.statusCode).toBe(404);
    expect((capture.jsonBody as any).code).toBe('code_not_found');
  });

  it('a SIGN token is not a credential for the withdrawal flow', async () => {
    const { admin, institute, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501111111' });
    const { code } = await consentInvitationRepository.create({
      studentId: student.id,
      contactId: contact.id,
      recipientType: 'guardian',
      purpose: 'sign',
      sourceInstituteId: institute.id,
      createdByUserId: admin.id,
      channel: 'sms',
      sentTo: '+972501111111',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);

    const capture = await context(code);
    expect(capture.statusCode).toBe(404);
    expect((capture.jsonBody as any).code).toBe('code_not_found');
  });

  // ==========================================================================
  // 4. ENUMERATION SAFETY
  // ==========================================================================

  it('request-link answers identically for a real and a bogus reference, and sends nothing for the bogus one', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501212121' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    const real = await requestLink(consent.id);
    const realSends = sent.length;
    sent = [];
    const bogus = await requestLink('4f1a6a2e-0000-4000-8000-000000000000');
    const garbage = await requestLink('not-even-a-uuid');

    expect(real.statusCode).toBe(200);
    expect(bogus.statusCode).toBe(200);
    expect(garbage.statusCode).toBe(200);
    expect(real.jsonBody).toEqual({ success: true });
    expect(bogus.jsonBody).toEqual({ success: true });
    expect(garbage.jsonBody).toEqual({ success: true });

    // The bodies being equal is the point; the SIDE EFFECT is what differs, and
    // the caller cannot observe it.
    expect(realSends).toBe(1);
    expect(sent).toHaveLength(0);
    const rows = await db.select().from(consentInvitations);
    expect(rows.filter((r) => r.purpose === 'withdraw')).toHaveLength(1);
  });

  it('request-link mints nothing for a signer who HAS a user account, and still answers 200', async () => {
    // Their withdrawal path is the session one (`revokePathFor` → `signer`).
    // Handing them a second, weaker credential would be a bypass, not parity.
    const { newStudent } = await setupClinic();
    const parent = await makeUser({ firstName: 'Yael', lastName: 'Shani' });
    const student = await newStudent();
    const contact = await addContact(student.id, {
      email: 'yael@example.test',
      phone: '+972501313131',
      linkedUserId: parent.id,
    });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    const capture = await requestLink(consent.id);
    expect(capture.statusCode).toBe(200);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(consentInvitations)).toHaveLength(0);
  });

  it('request-link mints nothing once the consent is already withdrawn', async () => {
    const { admin, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501414141' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await consentService.revokeConsent({ consentId: consent.id, revokedByUserId: admin.id });

    expect((await requestLink(consent.id)).statusCode).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('throttles a replayed reference so the receipt cannot be used to mailbomb the guardian', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501515151' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    for (let i = 0; i < 5; i++) expect((await requestLink(consent.id)).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  // ==========================================================================
  // 5. CASCADE + AUDIT
  // ==========================================================================

  it('cascades to active shares, exactly as every other revocation path does', async () => {
    const { admin, institute, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501616161' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    const { institute: family } = await makeInstitute(admin.id, { type: 'family' });
    const [program] = await db
      .insert(programs)
      .values({
        studentId: student.id,
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
        studentId: student.id,
        sourceInstituteId: institute.id,
        targetInstituteId: family.id,
        codeHash: 'fixture-hash-withdrawal',
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
      studentId: student.id,
      sourceInstituteId: institute.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
    } as any);
    await db.insert(standingShares).values({
      objectTypes: ['monitor_note'],
      studentId: student.id,
      sourceInstituteId: institute.id,
      targetInstituteId: family.id,
      permission: 'read',
      shareInviteId: invite.id,
      shareExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    } as any);

    await requestLink(consent.id);
    const code = codeFromLastMessage();
    await requestOtp(code);
    await verifyOtp(code, '000000');
    expect((await confirm({ code, confirm: true })).statusCode).toBe(200);

    const liveObjects = await db
      .select()
      .from(objectShares)
      .where(and(eq(objectShares.studentId, student.id), isNull(objectShares.revokedAt)));
    expect(liveObjects).toHaveLength(0);
    const liveStanding = await db
      .select()
      .from(standingShares)
      .where(and(eq(standingShares.studentId, student.id), isNull(standingShares.revokedAt)));
    expect(liveStanding).toHaveLength(0);

    // §7.5's per-grant tag is untouched by the new path.
    const logs = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.subjectId1, student.id));
    const cascadeLogs = logs.filter(
      (l) => (l.details as any)?.cascade_reason === 'consent_revoked',
    );
    expect(cascadeLogs.length).toBe(2);
    // And the cascade recorded a NULL actor rather than failing on the FK.
    const [revokedObject] = await db
      .select()
      .from(objectShares)
      .where(eq(objectShares.studentId, student.id));
    expect(revokedObject.revokedByUserId).toBeNull();
  });

  it('audits the withdrawal under the FOURTH revocation_path, `signer_token`', async () => {
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501717171' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);
    const code = codeFromLastMessage();
    await requestOtp(code);
    await verifyOtp(code, '000000');
    await confirm({ code, confirm: true, reason: 'We are moving abroad' });

    const row = await waitForActivityRow({
      eventType: 'consent_revoked',
      subjectId1: consent.id,
    });
    expect(row).not.toBeNull();
    // No account, so no userId — and the row still says WHO.
    expect(row!.userId).toBeNull();
    expect(row!.subjectId2).toBe(student.id);
    expect(row!.details.revocation_path).toBe('signer_token');
    expect(row!.details.revoked_by_contact_id).toBe(contact.id);
    expect(row!.details.withdrawal_channel).toBe('sms');
    expect(row!.details.withdrawal_second_factor).toBe('phone_otp');
    expect(row!.details.identity_verification_method).toBe(MAGIC_LINK);
    // Pre-existing details untouched.
    expect(row!.details.reason).toBe('We are moving abroad');
    expect(row!.details.priorVersion).toBe(ilNotice().version);
  });

  it('tells the clinic that processing stopped', async () => {
    const { admin, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501818181' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);
    const code = codeFromLastMessage();
    await requestOtp(code);
    await verifyOtp(code, '000000');
    await confirm({ code, confirm: true });

    const notices = sent.filter((s) => s.kind === 'email' && /withdrawn/i.test(s.body));
    expect(notices.length).toBeGreaterThan(0);
    // Addressed to the institute ADMIN — the clinic has no contact address of
    // its own in the schema, so recipients are resolved from membership.
    expect(notices.some((n) => n.to === admin.email)).toBe(true);
  });

  // ==========================================================================
  // 6. NON-VACUITY — the pre-change control
  // ==========================================================================

  it('NON-VACUITY: this exact record was NOT withdrawable before this change', async () => {
    // The pre-change world had exactly one endpoint for this,
    // `POST /api/consent/:consentId/revoke`, and it requires a session and
    // resolves the caller through `studentContacts.linkedUserId`. The guardian
    // in every test above has neither. Driving that endpoint the only two ways
    // this guardian could — with no session, and with the record's own contact
    // id in place of a user id — proves the success tests above are not passing
    // through a door that was already open.
    const { newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972501919191' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    const noSession = await call(
      (r, s) => consentController.revokeConsent(r, s),
      {},
      { user: null, params: { consentId: consent.id } },
    );
    expect(noSession.statusCode).toBe(401);

    const asContact = await call(
      (r, s) => consentController.revokeConsent(r, s),
      {},
      { user: { id: contact.id }, params: { consentId: consent.id } },
    );
    expect(asContact.statusCode).toBe(403);
    expect((asContact.jsonBody as any).code).toBe('permission_denied');

    expect((await studentConsentRecordRepository.getById(consent.id))!.revokedAt).toBeNull();
  });

  // ==========================================================================
  // 7. THE CLINIC'S RE-ISSUE AFFORDANCE
  // ==========================================================================

  it('an institute admin can re-issue a withdrawal link, and never sees the code', async () => {
    const { admin, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { email: 'ruth@example.test' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    const capture = await call(
      (r, s) => consentController.reissueWithdrawalLink(r, s),
      {},
      { user: { id: admin.id }, params: { consentId: consent.id } },
    );
    expect(capture.statusCode).toBe(200);
    const body = capture.jsonBody as any;
    expect(body.channel).toBe('email');
    // Masked destination only — and no code anywhere in the response.
    expect(body.sentTo).toBe('r***@example.test');
    expect(JSON.stringify(body)).not.toContain(codeFromLastMessage());
    // It did reach the guardian.
    expect(sent[0].to).toBe('ruth@example.test');
  });

  it('a plain institute member cannot re-issue a withdrawal link', async () => {
    const { member, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { email: 'ruth@example.test' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);

    const capture = await call(
      (r, s) => consentController.reissueWithdrawalLink(r, s),
      {},
      { user: { id: member.id }, params: { consentId: consent.id } },
    );
    expect(capture.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('/history advertises the re-issue affordance only where a link could actually reach someone', async () => {
    const { admin, member, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { email: 'ruth@example.test' });
    await signAsMagicLinkParent(student.id, contact.id);

    async function historyFor(userId: string) {
      const req = makeReq({ user: { id: userId }, params: { studentId: student.id } });
      const { res, capture } = makeRes();
      await consentController.listHistory(req, res);
      expect(capture.statusCode).toBe(200);
      return (capture.jsonBody as any).history as any[];
    }

    expect((await historyFor(admin.id))[0].canSendWithdrawalLink).toBe(true);
    // Same record, non-admin caller: the flag and the endpoint agree.
    expect((await historyFor(member.id))[0].canSendWithdrawalLink).toBe(false);
  });

  it('/history does NOT advertise the affordance when the signer has an account', async () => {
    const { admin, newStudent } = await setupClinic();
    const parent = await makeUser({ firstName: 'Yael', lastName: 'Shani' });
    const student = await newStudent();
    const contact = await addContact(student.id, {
      email: 'yael@example.test',
      linkedUserId: parent.id,
    });
    await signAsMagicLinkParent(student.id, contact.id);

    const req = makeReq({ user: { id: admin.id }, params: { studentId: student.id } });
    const { res, capture } = makeRes();
    await consentController.listHistory(req, res);
    expect((capture.jsonBody as any).history[0].canSendWithdrawalLink).toBe(false);
  });

  // ==========================================================================
  // 8. THE SIGN FLOW'S PENDING LIST MUST NOT SEE WITHDRAWAL TOKENS
  // ==========================================================================

  it('a live withdrawal token does not appear as a pending consent request', async () => {
    // If it did, a clinician tidying "Pending consent requests" would cancel
    // the data subject's route to withdrawing — silently, while believing they
    // were retiring a stale sign link.
    const { admin, newStudent } = await setupClinic();
    const student = await newStudent();
    const contact = await addContact(student.id, { phone: '+972502020202' });
    const consent = await signAsMagicLinkParent(student.id, contact.id);
    await requestLink(consent.id);

    const req = makeReq({ user: { id: admin.id }, params: { studentId: student.id } });
    const { res, capture } = makeRes();
    await consentController.listPendingInvitations(req, res);
    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).invitations).toHaveLength(0);

    // ...but the token really is live, so the emptiness above is a filter and
    // not an absence.
    const live = await consentInvitationRepository.listPendingWithdrawalsForConsent(consent.id);
    expect(live).toHaveLength(1);
  });
});
