/**
 * GUIDED SETUP host actions (Phase C) against real rows.
 *
 * These three actions are the only places the flow writes OUTSIDE its own
 * record, and each one is silent when it goes wrong:
 *
 *  - `activateProgram` has to lift the program AND its draft goals/objectives.
 *    A program activated with draft goals is invisible to the AAC — the
 *    assistant would inherit a program with nothing in it and nobody would see
 *    an error, only a child whose board never mentions their goals.
 *  - `setAacUser` writes `aac_settings.enabled`, which is a MARKER the AI is
 *    deliberately not allowed to set through manageMemory (plan decision 6). It
 *    must go through the repository (external-storage extraction) and it must
 *    leave an audit row, or an AI-set value is indistinguishable from a
 *    clinician-set one after the fact.
 *  - `requestConsent` SENDS something to a parent. It must refuse anything but
 *    a contact that belongs to this student and carries the address for the
 *    channel asked for.
 *
 * Nothing in this file may send a real email or SMS: the test environment
 * carries live SES credentials (memory: feedback_test_env_has_live_ses), so the
 * two senders are mocked at module scope before anything imports them.
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll, jest } from "@jest/globals";
import { createHash } from "node:crypto";

const sendEmail = jest.fn(async () => ({ success: true, messageId: "test" }));
const sendSms = jest.fn(async () => ({ success: true }));

jest.unstable_mockModule("../../services/emailService", () => ({
  emailService: { sendEmail, isReady: () => true, verifyConnection: async () => true },
  EmailService: class {},
}));
jest.unstable_mockModule("../../services/smsService", () => ({
  smsService: { send: sendSms, sendOtp: sendSms, isConfigured: () => true },
}));

import { truncateAll, db } from "../helpers/db.js";
import { makeUser, makeStudent, makeInstitute, makeLicense } from "../helpers/factories.js";
import {
  aacSettings,
  activityLogs,
  chatSessions,
  consentInvitations,
  goals,
  objectives,
  programs,
  studentContacts,
} from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";

import { instituteRepository } from "../../repositories/instituteRepository.js";
import { studentRepository } from "../../repositories/studentRepository.js";

type ServiceModule = typeof import("../../services/guided-setup/student-setup-service.js");
type ActionsModule = typeof import("../../services/guided-setup/student-setup-actions.js");
type StateModule = typeof import("../../services/guided-setup/student-setup-state.js");
type InstituteSchemaModule = typeof import("../../services/memory-schema/institute-memory-schema.js");
type SessionModule = typeof import("../../services/sessionService.js");

let service: ServiceModule;
let actions: ActionsModule;
let state: StateModule;
let instituteSchema: InstituteSchemaModule;
let sessionService: SessionModule;

beforeAll(async () => {
  // Dynamic, so the mocked senders are already registered: `jest.mock` is inert
  // under ESM (memory: feedback_jest_mock_inert_under_esm) and a statically
  // imported consentInvitationService would hold the real SES client.
  service = await import("../../services/guided-setup/student-setup-service.js");
  actions = await import("../../services/guided-setup/student-setup-actions.js");
  state = await import("../../services/guided-setup/student-setup-state.js");
  instituteSchema = await import("../../services/memory-schema/institute-memory-schema.js");
  // Same reason as the three above, and it matters more here: a statically
  // imported sessionService drags the real SES client in with it.
  sessionService = await import("../../services/sessionService.js");
});

const ENV_FLAG = "CONSENT_GATE_ENABLED";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setupAccount(
  type: "family" | "school" | "clinic",
  permissions: Record<string, unknown> = { maxStudents: 5, aacEnabled: true, dashboardLevel: 1 },
) {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id, { type });
  await makeLicense({ instituteId: institute.id, permissions: permissions as never });
  const { student } = await makeStudent(owner.id, { country: "IL", gender: "male" });
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);
  await studentRepository.updateStudent(student.id, { birthDate: "2018-01-01" } as never);
  return { owner, institute, student };
}

/** A program with one draft goal and one draft objective under it. */
async function seedDraftProgram(studentId: string, instituteId: string | null) {
  const [program] = await db
    .insert(programs)
    .values({ studentId, instituteId, framework: "personal", status: "draft" })
    .returning();
  const [goal] = await db
    .insert(goals)
    .values({ programId: program.id, goalStatement: "Greet a peer", status: "draft" })
    .returning();
  const [objective] = await db
    .insert(objectives)
    .values({ goalId: goal.id, objectiveStatement: "Wave hello", status: "draft" })
    .returning();
  return { program, goal, objective };
}

async function addGuardian(
  studentId: string,
  over: Partial<{
    contactEmail: string | null;
    contactPhone: string | null;
    isLegalGuardian: boolean;
  }> = {},
) {
  const [contact] = await db
    .insert(studentContacts)
    .values({
      studentId,
      name: "Test Guardian",
      relationship: "parent_guardian",
      role: "parent_guardian",
      contactEmail: over.contactEmail === undefined ? "guardian@test.local" : over.contactEmail,
      contactPhone: over.contactPhone ?? null,
      isLegalGuardian: over.isLegalGuardian ?? false,
    })
    .returning();
  return contact;
}

/** Sign consent for real, so `alreadyActive` is tested against the real status. */
async function signConsent(studentId: string, contactId: string) {
  const { consentService } = await import("../../services/consent/consentService.js");
  const { lookupConsentNotice, renderNoticeForHashing } = await import("@shared/legal");
  const notice = lookupConsentNotice({ country: "IL", locale: "en" })!;
  const hash = createHash("sha256").update(renderNoticeForHashing(notice.content)).digest("hex");
  return consentService.signConsent({
    studentId,
    signedByContactId: contactId,
    locale: "en",
    consentTextVersion: notice.version,
    consentTextHash: hash,
    thirdPartyRecipients: [],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    identityVerificationMethod: "in_person_clinician_attested",
    identityVerificationEvidence: { attestingClinicianUserId: "fixture" },
    nonRepudiationMethod: "in_person_clinician_attested",
    nonRepudiationEvidence: { attestingClinicianUserId: "fixture" },
  } as never);
}

/** Shared env bookkeeping — the flag is read at call time, so it must be restored. */
function withEnvRestore() {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
    sendEmail.mockClear();
    sendSms.mockClear();
  });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });
}

// ---------------------------------------------------------------------------

describe("Guided Setup — activateProgram", () => {
  withEnvRestore();

  it("activates the newest program and lifts its draft goals and objectives", async () => {
    const { owner, institute, student } = await setupAccount("family");
    const seeded = await seedDraftProgram(student.id, institute.id);

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "activateProgram",
    });

    expect(view.refused).toBeNull();

    const [program] = await db
      .select({ status: programs.status })
      .from(programs)
      .where(eq(programs.id, seeded.program.id));
    expect(program.status).toBe("active");

    const [goal] = await db
      .select({ status: goals.status })
      .from(goals)
      .where(eq(goals.id, seeded.goal.id));
    expect(goal.status).toBe("active");

    const [objective] = await db
      .select({ status: objectives.status })
      .from(objectives)
      .where(eq(objectives.id, seeded.objective.id));
    expect(objective.status).toBe("active");

    // The whole point: the step must now DERIVE complete, not be marked so.
    expect(view.steps.find((s) => s.id === "program")?.status).toBe("done");
  });

  it("refuses with programMissing when the student has no program", async () => {
    const { owner, institute, student } = await setupAccount("family");

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "activateProgram",
    });

    expect(view.refused).toEqual({ action: "activateProgram", reason: "programMissing" });
  });

  it("refuses with consentRequired while the gate is on and consent is not signed", async () => {
    const { owner, institute, student } = await setupAccount("school");
    await seedDraftProgram(student.id, institute.id);
    await addGuardian(student.id);
    process.env[ENV_FLAG] = "true";

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "activateProgram",
    });

    // Mapped from ConsentGateError, never thrown at the model.
    expect(view.refused).toEqual({ action: "activateProgram", reason: "consentRequired" });
    const [program] = await db
      .select({ status: programs.status })
      .from(programs)
      .where(eq(programs.studentId, student.id));
    expect(program.status).toBe("draft");
  });
});

describe("Guided Setup — setAacUser", () => {
  withEnvRestore();

  it("true writes aac_settings.enabled and logs the field change", async () => {
    const { owner, institute, student } = await setupAccount("family");

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "setAacUser",
      value: true,
    });
    expect(view.refused).toBeNull();

    const [settings] = await db
      .select({ enabled: aacSettings.enabled })
      .from(aacSettings)
      .where(eq(aacSettings.studentId, student.id));
    expect(settings.enabled).toBe(true);

    const [log] = await db
      .select({ details: activityLogs.details, isAiInitiated: activityLogs.isAiInitiated })
      .from(activityLogs)
      .where(
        and(eq(activityLogs.subjectId1, student.id), eq(activityLogs.eventType, "update")),
      )
      .orderBy(desc(activityLogs.createdAt));
    // `enabled` is a boolean column, so activityChanges records the literal.
    expect((log.details as any)?.changes?.enabled).toEqual({ from: false, to: true });
    expect(log.isAiInitiated).toBe(true);

    expect(view.steps.find((s) => s.id === "aac")?.checklist.find((c) => c.key === "aacUser")?.done)
      .toBe(true);
  });

  it("false records notAacUser on the flow record and completes the step", async () => {
    const { owner, institute, student } = await setupAccount("family");
    await service.adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "setAacUser",
      value: false,
    });
    expect(view.refused).toBeNull();

    const record = await state.readRecord(student.id, institute.id);
    expect(record?.notAacUser).toBe(true);

    const [settings] = await db
      .select({ enabled: aacSettings.enabled })
      .from(aacSettings)
      .where(eq(aacSettings.studentId, student.id));
    expect(settings.enabled).toBe(false);

    expect(view.steps.find((s) => s.id === "aac")?.status).toBe("done");
  });

  it("true after a false clears notAacUser, so the step is not complete on the stale answer", async () => {
    const { owner, institute, student } = await setupAccount("family");
    await service.adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });

    const base = { userId: owner.id, instituteId: institute.id, studentId: student.id };
    await service.runToolAction({ ...base, action: "setAacUser", value: false });
    await service.runToolAction({ ...base, action: "setAacUser", value: true });

    const record = await state.readRecord(student.id, institute.id);
    expect(record?.notAacUser).toBeUndefined();
    const { view } = await service.resolveView(base);
    expect(view.steps.find((s) => s.id === "aac")?.status).not.toBe("done");
  });

  it("refuses with aacNotLicensed when the license has no aacEnabled", async () => {
    const { owner, institute, student } = await setupAccount("school", { maxStudents: 5 });

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "setAacUser",
      value: true,
    });

    expect(view.refused).toEqual({ action: "setAacUser", reason: "aacNotLicensed" });
  });
});

describe("Guided Setup — advance stamps the AAC review", () => {
  withEnvRestore();

  it("advance off step 4 records aacReviewedAt when the AI, not the rail, finished it", async () => {
    const { owner, institute, student } = await setupAccount("family");
    const base = { userId: owner.id, instituteId: institute.id, studentId: student.id };
    await service.adopt(base);
    await service.skipStep({ ...base, step: "medical" });
    await service.skipStep({ ...base, step: "program" });
    await service.runToolAction({ ...base, action: "setAacUser", value: true });

    const before = await state.readRecord(student.id, institute.id);
    expect(before?.aacReviewedAt).toBeUndefined();

    const view = await service.runToolAction({ ...base, action: "advance" });

    const after = await state.readRecord(student.id, institute.id);
    expect(typeof after?.aacReviewedAt).toBe("string");
    // The stamp still lands, but the flow no longer finishes here: CONTACTS is
    // the fifth step and nobody has been added, so the SAME advance call that
    // closed step 4 is refused on step 5. Both halves matter — the stamp is
    // what makes step 4 done, the refusal is what keeps step 5 open.
    expect(view.step).toBe("contacts");
    expect(view.refused).toEqual({ action: "advance", reason: "stepIncomplete" });

    // Skipping the fifth step is what finishes the flow when there is nobody
    // else to list.
    const skipped = await service.runToolAction({ ...base, action: "skip", step: "contacts" });
    expect(skipped.step).toBe("done");
    expect(skipped.refused).toBeNull();
    expect((await state.readRecord(student.id, institute.id))?.skipped).toContain("contacts");
  });
});

/**
 * STEP 5 — CONTACTS, against real `student_contacts` rows.
 *
 * The rule is not "a contact exists". Both create paths — REST
 * `POST /api/students` and the AI's `Context_Students.add` — leave behind a
 * guardian row linked to the creating user, and that row is NOT `autoAdded`
 * (it is a system row, not an AI guess). Counting rows, or even counting
 * non-auto-added rows, would let a family flow declare step 5 finished before
 * it had asked a single question. The pure rule is pinned in
 * server/tests/guided-flow/prompt-section.test.ts; what needs real rows is
 * `loadContactFacts` reading the right ones.
 */
describe("Guided Setup — step 5 completion reads real contact rows", () => {
  withEnvRestore();

  const peopleItem = (view: { steps: Array<{ id: string; checklist: Array<{ key: string; done: boolean }> }> }) =>
    view.steps.find((s) => s.id === "contacts")?.checklist.find((c) => c.key === "people");

  it("is not completed by the guardian row the system created for this user", async () => {
    const { owner, institute, student } = await setupAccount("family");
    await db.insert(studentContacts).values({
      studentId: student.id,
      name: "Dana Cohen",
      relationship: "parent_guardian",
      role: "parent_guardian",
      linkedUserId: owner.id,
      contactEmail: "dana@example.com",
    });

    const { view } = await service.resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(peopleItem(view)?.done).toBe(false);
  });

  it("is not completed by an auto-added row the AAC monitor guessed", async () => {
    const { owner, institute, student } = await setupAccount("family");
    await db.insert(studentContacts).values({
      studentId: student.id,
      name: "Somebody Seen In A Session",
      relationship: "friend",
      autoAdded: true,
    });

    const { view } = await service.resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(peopleItem(view)?.done).toBe(false);
  });

  it("is completed by one person the user actually added, and ignores deleted rows", async () => {
    const { owner, institute, student } = await setupAccount("family");
    const [grandma] = await db
      .insert(studentContacts)
      .values({
        studentId: student.id,
        name: "Savta Rivka",
        relationship: "grandmother",
      })
      .returning();

    const base = { userId: owner.id, instituteId: institute.id, studentId: student.id };
    const first = await service.resolveView(base);
    expect(peopleItem(first.view)?.done).toBe(true);

    // isActive=false is this table's soft delete; the step must reopen.
    await db
      .update(studentContacts)
      .set({ isActive: false })
      .where(eq(studentContacts.id, grandma.id));
    const after = await service.resolveView(base);
    expect(peopleItem(after.view)?.done).toBe(false);
  });

  it("lets the flow finish once a real contact exists", async () => {
    const { owner, institute, student } = await setupAccount("family");
    const base = { userId: owner.id, instituteId: institute.id, studentId: student.id };
    await service.adopt(base);
    await service.skipStep({ ...base, step: "medical" });
    await service.skipStep({ ...base, step: "program" });
    await service.runToolAction({ ...base, action: "setAacUser", value: true });
    await service.runToolAction({ ...base, action: "advance" });

    await db.insert(studentContacts).values({
      studentId: student.id,
      name: "Miri the SLP",
      relationship: "speech therapist",
      role: "speech_language_pathologist",
    });

    const view = await service.runToolAction({ ...base, action: "advance" });
    expect(view.step).toBe("done");
    expect(view.refused).toBeNull();

    // AND IT SAYS SO IN BOTH SIGNALS, ON THIS CALL.
    //
    // The tool action is what finishes the flow, and it publishes the view the
    // client renders for that turn — the chat resolution ran before the model
    // spoke. Both `applyFlowAction` and `resolveView` used to hand
    // `toGuidedSetupView` no `active` (defaulting to TRUE) on a record only
    // `resolveForChat` ever stamped, so the completing call reported
    // `{ step: "done", active: true, completedAt: undefined }` and the setup
    // header stayed up until the user pressed "finish later" (user report).
    // The client retires the rail on `step === "done" || record.completedAt`,
    // so neither signal may be left behind.
    expect(`completing advance active: ${JSON.stringify(view.active)}`).toBe(
      "completing advance active: false",
    );
    expect(typeof view.record?.completedAt).toBe("string");
    // The stamp is on the RECORD, not merely in the payload — otherwise the
    // parked list keeps offering a student whose setup is over.
    expect(typeof (await state.readRecord(student.id, institute.id))?.completedAt).toBe("string");

    // Every later reader agrees, including the plain read path: `resolveView`
    // is where the REST view, the rail probe and every host action publish
    // from, and it was telling all of them the flow was still active.
    const reread = await service.resolveView(base);
    expect(`reread active: ${JSON.stringify(reread.view.active)}`).toBe("reread active: false");
    expect(typeof reread.view.record?.completedAt).toBe("string");
  });
});

/**
 * RESUME — the check behind the rail's "Continue setup".
 *
 * The button used to send the kickoff as `{ start: true }`, and `start` always
 * begins UNBOUND, so pressing it on a parked patient opened a fresh step-1
 * roster flow (observed live, clinic, 2026-09-08). The resume is its own
 * request shape now, and `resumeForChat` is what decides it: the RECORD rule is
 * pinned pure in server/tests/guided-flow/student-binding.test.ts, so what is
 * exercised here is the half that needs real rows — membership and per-student
 * access, and the promise that a refusal is a null rather than a throw into the
 * middle of a chat turn.
 */
describe("Guided Setup — resumeForChat", () => {
  withEnvRestore();

  it("returns the parked record for a member with access", async () => {
    const { owner, institute, student } = await setupAccount("clinic");
    await service.adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });

    const record = await service.resumeForChat({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(record).not.toBeNull();
    expect(record?.source).toBe("chat");
    // The flow keeps the date it originally started, so nothing created since
    // can bind to the resumed flow by accident.
    expect(record?.startedAt).toBe((await state.readRecord(student.id, institute.id))?.startedAt);
  });

  it("refuses a completed or dismissed record", async () => {
    const { owner, institute, student } = await setupAccount("clinic");
    const base = { userId: owner.id, instituteId: institute.id, studentId: student.id };
    await service.adopt(base);

    await service.dismiss(base);
    expect(await service.resumeForChat(base)).toBeNull();

    const dismissed = (await state.readRecord(student.id, institute.id))!;
    await state.writeRecord(student.id, institute.id, {
      ...dismissed,
      dismissedAt: undefined,
      completedAt: new Date().toISOString(),
    });
    expect(await service.resumeForChat(base)).toBeNull();
  });

  it("refuses a student who was never in the flow", async () => {
    const { owner, institute, student } = await setupAccount("clinic");
    expect(
      await service.resumeForChat({
        userId: owner.id,
        instituteId: institute.id,
        studentId: student.id,
      }),
    ).toBeNull();
  });

  /**
   * The id arrives on a chat request body, so it is whatever the caller says it
   * is. A stranger's resume must come back null — NOT throw: the guided-setup
   * block would swallow a throw, but the turn it swallowed would take the whole
   * flow down with it rather than degrading to an ordinary message.
   */
  it("refuses a non-member and a student in another institute, without throwing", async () => {
    const { owner, institute, student } = await setupAccount("clinic");
    await service.adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });

    const stranger = await makeUser();
    expect(
      await service.resumeForChat({
        userId: stranger.id,
        instituteId: institute.id,
        studentId: student.id,
      }),
    ).toBeNull();

    const other = await setupAccount("clinic");
    expect(
      await service.resumeForChat({
        userId: other.owner.id,
        instituteId: other.institute.id,
        studentId: student.id,
      }),
    ).toBeNull();
  });
});

describe("Guided Setup — requestConsent", () => {
  withEnvRestore();

  it("creates an invitation and the gate derives request_sent", async () => {
    const { owner, institute, student } = await setupAccount("school");
    const contact = await addGuardian(student.id);
    process.env[ENV_FLAG] = "true";

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "requestConsent",
      contactId: contact.id,
      channel: "email",
    });

    expect(view.refused).toBeNull();

    const rows = await db
      .select({ contactId: consentInvitations.contactId, channel: consentInvitations.channel })
      .from(consentInvitations)
      .where(eq(consentInvitations.studentId, student.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe(contact.id);
    expect(rows[0].channel).toBe("email");

    expect(view.gate).toBe("request_sent");
    // The mocked sender was used; the real SES client was never constructed.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("refuses with consentGateOff when CONSENT_GATE_ENABLED is not on", async () => {
    const { owner, institute, student } = await setupAccount("school");
    const contact = await addGuardian(student.id);

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "requestConsent",
      contactId: contact.id,
      channel: "email",
    });

    expect(view.refused).toEqual({ action: "requestConsent", reason: "consentGateOff" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses guardianMissing for another student's contact, and for a missing address", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute, student } = await setupAccount("school");
    const { student: other } = await makeStudent(owner.id);
    const foreign = await addGuardian(other.id);
    const noPhone = await addGuardian(student.id, { contactPhone: null });

    const base = { userId: owner.id, instituteId: institute.id, studentId: student.id };

    const stolen = await service.runToolAction({
      ...base,
      action: "requestConsent",
      contactId: foreign.id,
      channel: "email",
    });
    expect(stolen.refused).toEqual({ action: "requestConsent", reason: "guardianMissing" });

    const wrongChannel = await service.runToolAction({
      ...base,
      action: "requestConsent",
      contactId: noPhone.id,
      channel: "sms",
    });
    expect(wrongChannel.refused).toEqual({ action: "requestConsent", reason: "guardianMissing" });

    expect(await db.select().from(consentInvitations)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("refuses alreadyActive rather than mailing a parent who already signed", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute, student } = await setupAccount("school");
    const contact = await addGuardian(student.id, { isLegalGuardian: true });
    await signConsent(student.id, contact.id);

    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "requestConsent",
      contactId: contact.id,
      channel: "email",
    });

    expect(view.refused).toEqual({ action: "requestConsent", reason: "alreadyActive" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses an unknown action instead of throwing at the model", async () => {
    const { owner, institute, student } = await setupAccount("family");
    const view = await service.runToolAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: "detonate",
    });
    expect(view.refused).toEqual({ action: "detonate", reason: "unknownAction" });
  });
});

describe("Guided Setup — the AI create path auto-creates the guardian contact", () => {
  withEnvRestore();

  it("Context_Students.add links a family admin as guardian, like the REST route does", async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: "family" });
    await makeLicense({
      instituteId: institute.id,
      permissions: { maxStudents: 5, aacEnabled: true } as never,
    });

    const all = { userId: owner.id, instituteId: institute.id };
    const ctx: any = {
      base: all,
      inherited: {},
      all,
      path: "/Context_Students",
      pathTokens: ["Context_Students"],
    };
    const created: any = await (instituteSchema.INSTITUTE_STUDENTS_FIELD.db as any).add(ctx, {
      firstName: "Noa",
      lastName: "Levi",
      birthDate: "2019-03-03",
      gender: "female",
      primaryLanguage: "he",
      instituteIds: [institute.id],
    });

    const contacts = await db
      .select({ linkedUserId: studentContacts.linkedUserId, role: studentContacts.role })
      .from(studentContacts)
      .where(eq(studentContacts.studentId, created.id));

    expect(contacts).toHaveLength(1);
    expect(contacts[0].linkedUserId).toBe(owner.id);
    expect(contacts[0].role).toBe("parent_guardian");

    // Which is exactly what the flow's step-1 checklist reads.
    const { view } = await service.resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: created.id,
    });
    expect(view.steps[0].checklist.find((c) => c.key === "guardian")?.done).toBe(true);

    // …and exactly what step 5 must NOT read as "contacts done". The row is a
    // system row: `autoAdded` is false on it, so the completion rule discounts
    // it by its link back to the creating user instead.
    expect(
      view.steps.find((s) => s.id === "contacts")?.checklist.find((c) => c.key === "people")?.done,
    ).toBe(false);
  });
});

/**
 * BINDING ATTACHES THE CONVERSATION, and it does it through the ONE fill-in.
 *
 * The GUIDED SETUP flow deliberately starts UNBOUND — pressing "New patient"
 * with somebody already on screen must not resume that person — and the client
 * sends no `studentId` for the kickoff turn. So the session row is inserted
 * with `studentId: null`, and when the flow later binds (explicit selection, or
 * the server discovering the student it just created) it used to write
 * `chat_state.guidedSetup.studentId` and nothing else. The setup conversation
 * therefore never appeared under the student's chat history — the user's report.
 *
 * The fix reuses the rule from
 * `planning-docs/student-access-permission/subject-scoped-chat-sessions-plan.md`
 * rather than writing a second update path: null → value is a FILL-IN that
 * patches the row and keeps the history; value → a DIFFERENT value is a SWITCH,
 * which opens a fresh session and is never a patch. Both directions are pinned
 * here, against a real row, because the second one is the dangerous one: a flow
 * that re-pointed an existing session would move one student's conversation
 * onto another student's history.
 *
 * The wiring — that binding actually calls this on the CREATING turn — is
 * pinned in guided-setup-e2e.test.ts, which drives the real turn loop.
 */
describe("Guided Setup — binding attaches the chat session", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterEach(async () => {
    await truncateAll();
  });

  async function makeSession(over: Partial<{ userId: string; studentId: string | null }>) {
    const [row] = await db
      .insert(chatSessions)
      .values({
        userId: over.userId ?? null,
        studentId: over.studentId ?? null,
        chatMode: "students",
        state: {},
        log: [],
        last: [],
        started: new Date(),
        lastUpdate: new Date(),
        creditsUsed: 0,
      } as never)
      .returning();
    return row;
  }

  async function readStudentId(sessionId: string) {
    const [row] = await db
      .select({ studentId: chatSessions.studentId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    return row?.studentId ?? null;
  }

  it("patches an unbound session onto the student the flow bound to", async () => {
    const { owner, student } = await setupAccount("clinic");
    const session = await makeSession({ userId: owner.id, studentId: null });

    const wrote = await sessionService.fillInSessionSubject(session, { studentId: student.id });

    expect(wrote).toBe(true);
    // The ROW, not just the in-memory copy: the whole bug was a state write
    // that never reached the table.
    expect(await readStudentId(session.id)).toBe(student.id);
    // …and the caller's copy is kept true to it, so nothing downstream in the
    // same turn reads a stale null.
    expect(session.studentId).toBe(student.id);
  });

  it("refuses to re-point a session that already belongs to another student", async () => {
    const { owner, student } = await setupAccount("clinic");
    const { student: other } = await makeStudent(owner.id);
    const session = await makeSession({ userId: owner.id, studentId: other.id });

    const wrote = await sessionService.fillInSessionSubject(session, { studentId: student.id });

    expect(wrote).toBe(false);
    expect(await readStudentId(session.id)).toBe(other.id);
    expect(session.studentId).toBe(other.id);
  });

  it("is a no-op when the session already carries that same student", async () => {
    const { owner, student } = await setupAccount("clinic");
    const session = await makeSession({ userId: owner.id, studentId: student.id });

    expect(await sessionService.fillInSessionSubject(session, { studentId: student.id })).toBe(false);
    expect(await readStudentId(session.id)).toBe(student.id);
  });

  it("ignores a null, so an unbound flow never blanks a bound session", async () => {
    const { owner, student } = await setupAccount("clinic");
    const session = await makeSession({ userId: owner.id, studentId: student.id });

    expect(await sessionService.fillInSessionSubject(session, { studentId: null })).toBe(false);
    expect(await readStudentId(session.id)).toBe(student.id);
  });
});
