/**
 * Consent gate — student chat-memory, relationship notes and AAC settings.
 *
 * Closes the hole recorded in planning-docs/open-items-closeout-plan.md item A:
 * `requireConsentForMemoryWrite` guarded reports / program / incidents only, so
 * the AI's running record OF THE CHILD was ungated. Observed live (Ray Cairo,
 * 2026-09-08): sitting on a consent-BLOCKED step the assistant interviewed the
 * user about the child's communication and wrote `Student_CommunicationProfile`
 * and `Student_CommunicationStyle`. Nothing at the data layer refused it — the
 * only thing standing in the way was prompt text.
 *
 * Two halves, and BOTH are load-bearing:
 *  1. the schema-layer refusal (what the AI reads — an AI-legible
 *     `ConsentGateError`, same helper and same message as the other three);
 *  2. the persist-layer refusal in `sessionService.onUpdateMemoryValues` (what
 *     stops the bytes). The Student_ and Relationship_ `db` ops do not write to
 *     the database at all — they return the value and the end-of-turn batch
 *     write persists it — and `memory-db-bridge` does NOT roll an in-memory
 *     value back when its DB op threw. A gate only in (1) would report a
 *     refusal to the model and then write the row anyway.
 *
 * The second half of the file pins the four DELIBERATE exemptions of
 * docs/student-consent-implementation.md §7.4. Those are regression pins: they
 * exist to stop a future tightening from dead-ending clinic onboarding.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent, makeInstitute } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { aacSettingsRepository } from '../../repositories/aacSettingsRepository.js';
import { studentContacts, students, userStudents } from '@shared/schema';
import { eq } from 'drizzle-orm';
import {
  consentService,
  type SignConsentInput,
} from '../../services/consent/consentService.js';
import { ConsentGateError } from '../../services/consent/consentGate.js';
import { createDBContext } from '../../services/chat/memory-db-bridge.js';
import type { DBOperationContext } from '../../services/chat/memory-types.js';
import {
  STUDENT_PEOPLE_FIELD,
  STUDENT_INTERESTS_FIELD,
  STUDENT_PREFERENCES_FIELD,
  STUDENT_NOTES_FIELD,
  STUDENT_COMMUNICATION_STYLE_FIELD,
  STUDENT_COMMUNICATION_PROFILE_FIELD,
} from '../../services/memory-schema/student-memory-schema.js';
import { RELATIONSHIP_NOTES_FIELD } from '../../services/memory-schema/relationship-memory-schema.js';
import {
  AAC_PROMPT_FIELD,
  AAC_AUTO_PROMPT_FIELD,
  AAC_SETTINGS_FIELD,
} from '../../services/memory-schema/aac-settings-memory-schema.js';
import { STUDENT_CONTACTS_FIELD } from '../../services/memory-schema/contacts-memory-schema.js';
import { reportService } from '../../services/reportService.js';
import { lookupConsentNotice, renderNoticeForHashing } from '@shared/legal';

const ENV_FLAG = 'CONSENT_GATE_ENABLED';

interface Fixture {
  ownerId: string;
  instituteId: string;
  studentId: string;
  contactId: string;
  ctx: DBOperationContext;
}

async function setup(
  opts: { withConsent?: boolean; legacyGrace?: 'future' | 'past' | null } = {},
): Promise<Fixture> {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
  const { student } = await makeStudent(owner.id, { country: 'IL' });
  await studentRepository.updateStudent(student.id, { birthDate: '2018-01-01' } as any);
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);

  if (opts.legacyGrace === 'future') {
    await db.update(students)
      .set({ legacyConsentDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
      .where(eq(students.id, student.id));
  } else if (opts.legacyGrace === 'past') {
    await db.update(students)
      .set({ legacyConsentDeadline: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(students.id, student.id));
  } else {
    await db.update(students)
      .set({ legacyConsentDeadline: null })
      .where(eq(students.id, student.id));
  }

  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Test Guardian',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: owner.id,
    isLegalGuardian: true,
  }).returning();

  if (opts.withConsent) {
    const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
    const hash = createHash('sha256').update(renderNoticeForHashing(notice.content)).digest('hex');
    const input: SignConsentInput = {
      studentId: student.id,
      signedByContactId: contact.id,
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
    await consentService.signConsent(input);
  }

  // The context the memory bridge hands a `db` op: `ctx.all.studentId` is the
  // convention `requireConsentForMemoryWrite` reads.
  const ctx = createDBContext({
    studentId: student.id,
    userId: owner.id,
    instituteId: institute.id,
    accessCtx: { kind: 'admin', userId: owner.id },
  });

  return {
    ownerId: owner.id,
    instituteId: institute.id,
    studentId: student.id,
    contactId: contact.id,
    ctx,
  };
}

/** Every newly gated write, as `[label, run]`. Each entry is ONE op the AI can
 *  reach; running the whole table under three gate states is what proves the
 *  coverage is a set and not three lucky call sites. */
function gatedWrites(ctx: DBOperationContext): Array<[string, () => Promise<unknown>]> {
  return [
    ['Student_CommunicationProfile write',
      () => STUDENT_COMMUNICATION_PROFILE_FIELD.db!.write!(ctx, 'Uses single words and vocalizations')],
    ['Student_CommunicationStyle write',
      () => STUDENT_COMMUNICATION_STYLE_FIELD.db!.write!(ctx, { PrimaryMethod: 'AAC' })],
    ['Student_Notes write',
      () => STUDENT_NOTES_FIELD.db!.write!(ctx, ['a note'])],
    ['Student_Notes add',
      () => STUDENT_NOTES_FIELD.db!.add!(ctx, 'had a good session', {})],
    ['Student_Notes delete',
      () => STUDENT_NOTES_FIELD.db!.delete!(ctx, 0)],
    ['Student_Notes clear',
      () => STUDENT_NOTES_FIELD.db!.clear!(ctx)],
    ['Student_People add',
      () => STUDENT_PEOPLE_FIELD.db!.add!(ctx, { Name: 'Aunt May', Relationship: 'aunt' }, {})],
    ['Student_Interests write',
      () => STUDENT_INTERESTS_FIELD.db!.write!(ctx, ['trains'])],
    ['Student_Preferences write',
      () => STUDENT_PREFERENCES_FIELD.db!.write!(ctx, { FavoriteActivities: ['swings'] })],
    ['Relationship_Notes write',
      () => RELATIONSHIP_NOTES_FIELD.db!.write!(ctx, [{ Date: '2026-09-10', Content: 'session note' }])],
    ['Context_AACPrompt add',
      () => AAC_PROMPT_FIELD.db!.add!(ctx, 'greet her by name', {})],
    ['Context_AACAutoPrompt add',
      () => AAC_AUTO_PROMPT_FIELD.db!.add!(ctx, 'likes counting games', {})],
    ['Context_AACSettings write',
      () => AAC_SETTINGS_FIELD.db!.write!(ctx, { aiName: 'Robot' })],
  ];
}

describe('Consent gate — student chat-memory / relationship / AAC settings', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env[ENV_FLAG]; });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Refused when the gate is on and the student is consent-pending
  // ────────────────────────────────────────────────────────────────────────

  describe('gate ON, consent pending → refused', () => {
    it('refuses EVERY newly gated write', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      // One fixture, every op: the whole gated set has to refuse, not three
      // lucky call sites. (One `it` rather than one per op deliberately — this
      // suite is DB-backed and each fixture is a full student + institute +
      // consent-contact build.)
      for (const [label, run] of gatedWrites(fx.ctx)) {
        let thrown: unknown;
        try {
          await run();
        } catch (e) {
          thrown = e;
        }
        if (!(thrown instanceof ConsentGateError)) {
          throw new Error(
            `${label} was NOT refused by the consent gate (got: ${
              thrown === undefined ? 'no throw' : String(thrown)
            })`,
          );
        }
      }
    });

    it('the refusal reaches the AI as the readable ConsentGateError message', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      // The Ray Cairo write, verbatim in shape: profile first, style second.
      for (const op of [
        () => STUDENT_COMMUNICATION_PROFILE_FIELD.db!.write!(fx.ctx, 'nonverbal'),
        () => STUDENT_COMMUNICATION_STYLE_FIELD.db!.write!(fx.ctx, { PrimaryMethod: 'nonverbal' }),
      ]) {
        try {
          await op();
          throw new Error('expected the gate to refuse');
        } catch (e: any) {
          expect(e).toBeInstanceOf(ConsentGateError);
          expect(e.code).toBe('consent_required');
          expect(e.name).toBe('ConsentGateError');
          // Self-explanatory and actionable — the AI has to be able to say WHY
          // and point at the wizard rather than emitting a confused tool error.
          expect(e.message).toMatch(/no active informed-consent record/i);
          expect(e.message).toMatch(/consent wizard/i);
          expect(e.studentId).toBe(fx.studentId);
        }
      }
    });

    it('leaves the column-backed communication profile untouched', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      await expect(
        STUDENT_COMMUNICATION_PROFILE_FIELD.db!.write!(fx.ctx, 'interviewed answer'),
      ).rejects.toBeInstanceOf(ConsentGateError);
      const [row] = await db
        .select({ communicationProfile: students.communicationProfile })
        .from(students)
        .where(eq(students.id, fx.studentId));
      expect(row.communicationProfile ?? null).toBeNull();
    });

    it('leaves aac_settings untouched', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      await expect(
        AAC_AUTO_PROMPT_FIELD.db!.add!(fx.ctx, 'she is in the ER today', {}),
      ).rejects.toBeInstanceOf(ConsentGateError);
      const settings = await aacSettingsRepository.getByStudentId(fx.studentId);
      const notes = (settings?.autoAacPrompt as unknown as string[] | null) ?? [];
      expect(notes).toHaveLength(0);
    });

    it('leaves the userStudent relationship chatMemory untouched', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      await expect(
        RELATIONSHIP_NOTES_FIELD.db!.write!(fx.ctx, [{ Date: '2026-09-10', Content: 'x' }]),
      ).rejects.toBeInstanceOf(ConsentGateError);
      const [link] = await db
        .select({ chatMemory: userStudents.chatMemory })
        .from(userStudents)
        .where(eq(userStudents.studentId, fx.studentId));
      expect((link?.chatMemory as Record<string, unknown> | null) ?? {}).toEqual({});
    });

    it('still allows READS — the gate is write-only (§7.4 identity carve-out)', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      await expect(STUDENT_NOTES_FIELD.db!.read!(fx.ctx)).resolves.toBeUndefined();
      await expect(STUDENT_COMMUNICATION_PROFILE_FIELD.db!.read!(fx.ctx)).resolves.toBeUndefined();
      await expect(AAC_SETTINGS_FIELD.db!.read!(fx.ctx)).resolves.toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Permitted with the flag off, with consent, and under legacy grace
  // ────────────────────────────────────────────────────────────────────────

  /** Run the whole gated set and fail naming the first op that was refused. */
  async function expectAllPermitted(ctx: DBOperationContext): Promise<void> {
    for (const [label, run] of gatedWrites(ctx)) {
      try {
        await run();
      } catch (e) {
        throw new Error(`${label} should have been PERMITTED but threw: ${String(e)}`);
      }
    }
  }

  it('gate OFF → permits every gated write', async () => {
    delete process.env[ENV_FLAG];
    const fx = await setup();
    await expectAllPermitted(fx.ctx);
  });

  it('legacy grace window → permits every gated write', async () => {
    process.env[ENV_FLAG] = 'true';
    const fx = await setup({ legacyGrace: 'future' });
    await expectAllPermitted(fx.ctx);
  });

  it('refuses once the legacy grace window has elapsed', async () => {
    process.env[ENV_FLAG] = 'true';
    const fx = await setup({ legacyGrace: 'past' });
    await expect(
      STUDENT_COMMUNICATION_PROFILE_FIELD.db!.write!(fx.ctx, 'x'),
    ).rejects.toBeInstanceOf(ConsentGateError);
  });

  describe('active consent → permitted', () => {
    it('permits every gated write once consent is signed', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup({ withConsent: true });
      await expectAllPermitted(fx.ctx);
    });

    it('actually persists the AAC scratchpad note once consent exists', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup({ withConsent: true });
      await AAC_AUTO_PROMPT_FIELD.db!.add!(fx.ctx, 'likes counting games', {});
      const settings = await aacSettingsRepository.getByStudentId(fx.studentId);
      const notes = (settings?.autoAacPrompt as unknown as string[] | null) ?? [];
      expect(notes.join(' ')).toMatch(/likes counting games/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. The four DELIBERATE exemptions (§7.4). Regression pins.
  // ────────────────────────────────────────────────────────────────────────

  describe('§7.4 exemptions still pass for a consent-pending student', () => {
    it('EXEMPT: reading basic identity — the wizard itself needs it', async () => {
      // Gating this would be a chicken-and-egg: the consent wizard reads the
      // student's name, birth date and country to render the notice it asks
      // the guardian to sign.
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      const student = await studentRepository.getStudentById(fx.studentId);
      expect(student?.name).toBeTruthy();
      expect(student?.birthDate).toBeTruthy();
    });

    it('EXEMPT: student_contacts writes — this is how consent is OBTAINED', async () => {
      // 🚨 The most load-bearing pin in this file. Since 2026-09-09 the guided
      // setup flow asks for and saves the GUARDIAN CONTACT *during* the consent
      // wait — it is the single, named carve-out in the flow's own blanket
      // prohibition ("No Student_* memory writes… The ONE exception is that
      // guardian contact", `student-setup-flow.ts` awaitingConsentBlock, the
      // `needsGuardian` branch). There is nothing to send a consent link TO
      // until that row exists, so gating contacts would dead-end the entire
      // clinic onboarding path — a consent-pending student could never stop
      // being consent-pending.
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      const created: any = await STUDENT_CONTACTS_FIELD.db!.add!(
        fx.ctx,
        {
          name: 'Guardian Two',
          relationship: 'mother',
          role: 'parent_guardian',
          contactEmail: 'guardian2@test.local',
        },
        {},
      );
      expect(created).toBeTruthy();
      const rows = await db
        .select({ id: studentContacts.id, name: studentContacts.name })
        .from(studentContacts)
        .where(eq(studentContacts.studentId, fx.studentId));
      expect(rows.map(r => r.name)).toContain('Guardian Two');
    });

    it('EXEMPT: creating a consent record — by definition', async () => {
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      const notice = lookupConsentNotice({ country: 'IL', locale: 'en' })!;
      const hash = createHash('sha256')
        .update(renderNoticeForHashing(notice.content))
        .digest('hex');
      const record = await consentService.signConsent({
        studentId: fx.studentId,
        signedByContactId: fx.contactId,
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
      } as SignConsentInput);
      expect(record).toBeTruthy();
      expect(await consentService.hasActiveConsent(fx.studentId)).toBe(true);
    });

    it('EXEMPT: DRAFTING a report — only the final-state transition gates', async () => {
      // Clinicians must not lose work. `reportService.createMedicalRecord` is
      // the draft path and carries no gate; the gate lives on
      // `reportController.finalizeMedicalRecord` (via requireConsentForResponse).
      process.env[ENV_FLAG] = 'true';
      const fx = await setup();
      const draft = await reportService.createMedicalRecord({
        studentId: fx.studentId,
        userId: fx.ownerId,
        instituteId: fx.instituteId,
        primaryDiagnosis: 'draft in progress',
      } as any);
      expect(draft.id).toBeTruthy();
      expect(draft.status).toBe('draft');
    });
  });
});
