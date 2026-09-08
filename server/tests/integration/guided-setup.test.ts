/**
 * GUIDED SETUP against real rows.
 *
 * The engine's own rules are pinned in server/tests/guided-flow/engine.test.ts.
 * What THIS suite exists for is the half that only a database can be wrong
 * about, and where being wrong is silent:
 *
 *  - the CONSENT gate. It follows CONSENT_GATE_ENABLED and nothing else. A flow
 *    that quietly walked into step 2 for an unconsented student would collect
 *    health data the platform has no legal basis for.
 *  - completion DERIVED from rows, not a counter — a student whose birthDate is
 *    missing must not read as "step 1 done", because the consent wizard cannot
 *    run without one.
 *  - the record on `institute_students.data.onboarding`. It shares that jsonb
 *    with whatever else lives there; a write that replaces the object instead
 *    of merging destroys another feature's data with no error.
 *  - the institute-less fallback: `DEFAULT_LICENSE_PERMISSIONS.maxStudents` is
 *    0, so a family institute provisioned with the defaults would block step 1
 *    on the very next call.
 */

import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import { createHash } from "node:crypto";

import { truncateAll, db } from "../helpers/db.js";
import { makeUser, makeStudent, makeInstitute, makeLicense } from "../helpers/factories.js";
import {
  goals,
  instituteStudents,
  programs,
  medicalRecords,
  studentContacts,
  students,
} from "@shared/schema";
import { GUIDED_SETUP_RECORD_KEY } from "@shared/guided-setup";
import { and, eq } from "drizzle-orm";

import { studentRepository } from "../../repositories/studentRepository.js";
import { instituteRepository } from "../../repositories/instituteRepository.js";
import { consentService, type SignConsentInput } from "../../services/consent/consentService.js";
import { lookupConsentNotice, renderNoticeForHashing } from "@shared/legal";
import {
  ackAac,
  adopt,
  applyFlowAction,
  discoverFlowStudentId,
  dismiss,
  parked,
  resolveFlowStudentId,
  resolveView,
  skipStep,
  start,
} from "../../services/guided-setup/student-setup-service.js";
import { readRecord } from "../../services/guided-setup/student-setup-state.js";

const ENV_FLAG = "CONSENT_GATE_ENABLED";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setupFamily(opts: { birthDate?: string | null } = {}) {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id, { type: "family" });
  await makeLicense({
    instituteId: institute.id,
    permissions: { maxStudents: 5, aacEnabled: true, dashboardLevel: 1 },
  });
  const { student } = await makeStudent(owner.id, { country: "IL", gender: "male" });
  await instituteRepository.assignStudentToInstitute(institute.id, student.id);
  if (opts.birthDate !== null) {
    await studentRepository.updateStudent(student.id, {
      birthDate: opts.birthDate ?? "2018-01-01",
    } as never);
  }
  return { owner, institute, student };
}

async function addGuardian(studentId: string, userId: string) {
  const [contact] = await db
    .insert(studentContacts)
    .values({
      studentId,
      name: "Test Guardian",
      relationship: "parent_guardian",
      role: "parent_guardian",
      linkedUserId: userId,
      contactEmail: "guardian@test.local",
      isLegalGuardian: true,
    })
    .returning();
  return contact;
}

async function signConsent(studentId: string, contactId: string) {
  const notice = lookupConsentNotice({ country: "IL", locale: "en" })!;
  const hash = createHash("sha256").update(renderNoticeForHashing(notice.content)).digest("hex");
  const input: SignConsentInput = {
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
  };
  return consentService.signConsent(input);
}

async function readLinkData(studentId: string, instituteId: string) {
  const [row] = await db
    .select({ data: instituteStudents.data })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.studentId, studentId),
      ),
    );
  return (row?.data ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("Guided Setup — start", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
  });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  it("provisions a family institute with a USABLE license for an institute-less user", async () => {
    const user = await makeUser();
    const result = await start({ userId: user.id });

    expect(result.instituteCreated).toBe(true);
    expect(result.view.account).toBe("family");
    expect(result.view.term).toBe("CHILD");
    expect(result.view.step).toBe("basics");

    const institutes = await instituteRepository.getInstitutesByUserId(user.id);
    expect(institutes).toHaveLength(1);
    expect(institutes[0].type).toBe("family");

    // The whole point of the fallback: DEFAULT_LICENSE_PERMISSIONS ships
    // maxStudents: 0, which would refuse the very first student.
    const { licenseService } = await import("../../services/licenseService.js");
    const perms = await licenseService.getInstitutePermissions(institutes[0].id, false);
    expect(perms.maxStudents).toBeGreaterThan(0);
    const check = await licenseService.checkMaxStudents(institutes[0].id, false);
    expect(check.allowed).toBe(true);
  });

  it("reuses the user's existing institute rather than creating another", async () => {
    const { owner, institute } = await setupFamily();
    const result = await start({ userId: owner.id, instituteId: institute.id });
    expect(result.instituteCreated).toBe(false);
    expect(result.view.instituteId).toBe(institute.id);
  });

  it("refuses an institute the user does not belong to", async () => {
    const { institute } = await setupFamily();
    const outsider = await makeUser();
    await expect(start({ userId: outsider.id, instituteId: institute.id })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("Guided Setup — derived completion", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
  });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  it("holds step 1 open until birthDate exists, then reports it done", async () => {
    const { owner, institute, student } = await setupFamily({ birthDate: null });

    const before = await resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(before.view.step).toBe("basics");
    const bd = before.view.steps[0].checklist.find((c) => c.key === "birthDate");
    expect(bd?.done).toBe(false);

    await studentRepository.updateStudent(student.id, { birthDate: "2018-05-05" } as never);

    const after = await resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(after.view.steps[0].status).toBe("done");
    expect(after.view.step).toBe("medical");
  });

  it("hides step 4 when the license has no aacEnabled", async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: "school" });
    await makeLicense({ instituteId: institute.id, permissions: { maxStudents: 5 } });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    const { view } = await resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(view.term).toBe("STUDENT");
    expect(view.steps.find((s) => s.id === "aac")?.status).toBe("hidden");
  });

  it("refuses advance out of step 3 with programMissing, then programDraft", async () => {
    const { owner, institute, student } = await setupFamily();
    // Step 1 done, step 2 skipped → the pointer sits on program.
    await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    await skipStep({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      step: "medical",
    });

    const missing = await applyFlowAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: { action: "advance" },
    });
    expect(missing.view.step).toBe("program");
    expect(missing.view.refused).toEqual({ action: "advance", reason: "programMissing" });

    const [program] = await db
      .insert(programs)
      .values({
        studentId: student.id,
        instituteId: institute.id,
        framework: "personal",
        status: "draft",
      })
      .returning();

    const draft = await applyFlowAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: { action: "advance" },
    });
    expect(draft.view.refused?.reason).toBe("programDraft");

    // Active program but every goal still draft — the AAC would inherit nothing.
    await db.update(programs).set({ status: "active" }).where(eq(programs.id, program.id));
    await db
      .insert(goals)
      .values({ programId: program.id, goalStatement: "Say hello", status: "draft" });

    const draftGoals = await applyFlowAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: { action: "advance" },
    });
    expect(draftGoals.view.refused?.reason).toBe("programDraft");

    await db.update(goals).set({ status: "active" }).where(eq(goals.programId, program.id));
    const done = await resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(done.view.steps.find((s) => s.id === "program")?.status).toBe("done");
  });
});

describe("Guided Setup — the consent gate follows CONSENT_GATE_ENABLED", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_FLAG];
  });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  it("gate ON: refuses the way into step 2 with consentRequired", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute, student } = await setupFamily();
    await addGuardian(student.id, owner.id);

    const result = await applyFlowAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: { action: "advance" },
    });
    expect(result.view.gate).toBe("sign_required");
    expect(result.view.step).toBe("medical");
    expect(result.view.steps.find((s) => s.id === "medical")?.status).toBe("locked");
    expect(result.view.refused).toEqual({ action: "advance", reason: "consentRequired" });
  });

  it("gate ON + active consent: the gate opens and step 2 becomes current", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute, student } = await setupFamily();
    const contact = await addGuardian(student.id, owner.id);
    await signConsent(student.id, contact.id);

    const result = await applyFlowAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: { action: "advance" },
    });
    expect(result.view.gate).toBe("active");
    expect(result.view.steps.find((s) => s.id === "medical")?.status).toBe("current");
    // No longer blocked by consent; step 2 is simply not filled in yet.
    expect(result.view.refused?.reason).toBe("stepIncomplete");
  });

  it("gate OFF: the gate reports off and never refuses for consent", async () => {
    delete process.env[ENV_FLAG];
    const { owner, institute, student } = await setupFamily();

    const result = await applyFlowAction({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      action: { action: "advance" },
    });
    expect(result.view.gate).toBe("off");
    expect(result.view.steps.find((s) => s.id === "medical")?.status).toBe("current");
    expect(result.view.refused?.reason).toBe("stepIncomplete");

    // With a report on file the flow really does walk past step 2.
    await db.insert(medicalRecords).values({
      studentId: student.id,
      userId: owner.id,
      instituteId: institute.id,
      primaryDiagnosis: "Rett syndrome",
      status: "draft",
    });
    const after = await resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(after.view.steps.find((s) => s.id === "medical")?.status).toBe("done");
    expect(after.view.step).toBe("program");
  });
});

describe("Guided Setup — the record on institute_students.data", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
  });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  it("adopt creates the record once and is idempotent", async () => {
    const { owner, institute, student } = await setupFamily();
    const first = await adopt({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      source: "form",
    });
    expect(first.record?.source).toBe("form");
    const stored = await readRecord(student.id, institute.id);
    expect(stored?.startedByUserId).toBe(owner.id);

    await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    const again = await readRecord(student.id, institute.id);
    expect(again?.startedAt).toBe(stored?.startedAt);
    expect(again?.source).toBe("form");
  });

  it("skip / dismiss / ackAac persist WITHOUT clobbering other data keys", async () => {
    const { owner, institute, student } = await setupFamily();

    // Another feature already owns a key on the same jsonb.
    const existing = await readLinkData(student.id, institute.id);
    await db
      .update(instituteStudents)
      .set({ data: { ...existing, someOtherFeature: { keep: "me" } } })
      .where(
        and(
          eq(instituteStudents.instituteId, institute.id),
          eq(instituteStudents.studentId, student.id),
        ),
      );

    await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    await skipStep({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
      step: "medical",
    });
    await ackAac({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    const dismissed = await dismiss({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });

    const data = await readLinkData(student.id, institute.id);
    expect(data.someOtherFeature).toEqual({ keep: "me" });

    const record = data[GUIDED_SETUP_RECORD_KEY] as Record<string, unknown>;
    expect(record.skipped).toEqual(["medical"]);
    expect(typeof record.aacReviewedAt).toBe("string");
    expect(typeof record.dismissedAt).toBe("string");
    expect(dismissed.record?.dismissedAt).toBeTruthy();
  });

  it("adopt LIFTS a previous dismissal, so 'Continue setup' can re-enter a parked flow", async () => {
    // The patient viewer's button is the deliberate choice a "not now" was not:
    // without this, `isResumableRecord` refuses the resume the button sends and
    // the click does nothing at all.
    const { owner, institute, student } = await setupFamily();
    await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    await dismiss({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    expect((await readRecord(student.id, institute.id))?.dismissedAt).toBeTruthy();

    const view = await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    expect(view.record?.dismissedAt).toBeFalsy();
    const stored = await readRecord(student.id, institute.id);
    expect(stored?.dismissedAt).toBeUndefined();
    // Only the dismissal is lifted — the flow is the same one, not a new start.
    expect(stored?.startedAt).toBeTruthy();
  });

  it("refuses to skip the basics step", async () => {
    const { owner, institute, student } = await setupFamily({ birthDate: null });
    await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });
    const view = await skipStep({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(view.refused).toEqual({ action: "skip", reason: "notSkippable" });
    const record = await readRecord(student.id, institute.id);
    expect(record?.skipped).toEqual([]);
  });

  it("parked lists only unfinished students in THIS institute", async () => {
    const { owner, institute, student } = await setupFamily();
    await adopt({ userId: owner.id, instituteId: institute.id, studentId: student.id });

    const list = await parked({ userId: owner.id, instituteId: institute.id });
    expect(list).toHaveLength(1);
    expect(list[0].studentId).toBe(student.id);
    expect(list[0].step).toBe("medical");
    expect(list[0].gate).toBe("off");

    // A second institute the same user belongs to must not leak into the list.
    const { institute: other } = await makeInstitute(owner.id, { type: "clinic" });
    expect(await parked({ userId: owner.id, instituteId: other.id })).toEqual([]);
  });

  it("refuses every entry point for a user outside the institute", async () => {
    const { institute, student } = await setupFamily();
    const outsider = await makeUser();
    await expect(
      resolveView({ userId: outsider.id, instituteId: institute.id, studentId: student.id }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      adopt({ userId: outsider.id, instituteId: institute.id, studentId: student.id }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      parked({ userId: outsider.id, instituteId: institute.id }),
    ).rejects.toMatchObject({ status: 403 });
  });
});


/**
 * The flow finds the patient it just created, WITHOUT the model calling
 * selectStudent.
 *
 * Observed live (clinic account, 2026-09-08): "Her name is Mira Vance, born 12
 * March 2017" — the patient count went 4 → 5 and the assistant moved straight
 * to an AAC question. It had never called `selectStudent(<new id>)`, which is
 * the only thing that would have put her id on the next request, so the flow
 * stayed unbound: header "No Patient Selected", `basics.inInstitute` false, no
 * STILL MISSING block, nothing naming gender or the HOME LANGUAGE.
 *
 * Correctness may not rest on a model choosing to make a UI call — but the
 * fallback must not become a way into an existing patient's record either, so
 * both halves are pinned here against real rows.
 */
describe("Guided Setup — binding to the student the flow just created", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
  });
  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
  });

  /** A clinic with one pre-existing patient, created well before any flow. */
  async function setupClinic() {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: "clinic" });
    await makeLicense({
      instituteId: institute.id,
      permissions: { maxStudents: 20, aacEnabled: true, dashboardLevel: 1 },
    });
    const { student: existing } = await makeStudent(owner.id, { name: "Sam Older" });
    await instituteRepository.assignStudentToInstitute(institute.id, existing.id);
    await backdate(existing.id, 3 * 86_400_000);
    return { owner, institute, existing };
  }

  /** Move a row's `createdAt` into the past; the factories all stamp "now". */
  async function backdate(studentId: string, msAgo: number) {
    await db
      .update(students)
      .set({ createdAt: new Date(Date.now() - msAgo) })
      .where(eq(students.id, studentId));
  }

  async function addPatient(ownerId: string, instituteId: string, name: string) {
    const { student } = await makeStudent(ownerId, { name });
    await instituteRepository.assignStudentToInstitute(instituteId, student.id);
    return student;
  }

  it("binds to a patient created after the flow started", async () => {
    const { owner, institute, existing } = await setupClinic();
    const startedAt = new Date().toISOString();
    const created = await addPatient(owner.id, institute.id, "Mira Vance");

    const found = await discoverFlowStudentId({
      userId: owner.id,
      instituteId: institute.id,
      startedAt,
      ignoreStudentId: null,
    });
    expect(found).toBe(created.id);
    expect(found).not.toBe(existing.id);

    // And the binding is worth having: the ctx now reads the real row, so the
    // step-1 block can name what is still outstanding.
    const { view } = await resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: found,
    });
    expect(view.step).toBe("basics");
  });

  it("does NOT bind to a patient created before the flow started", async () => {
    const { owner, institute } = await setupClinic();
    // Nothing new since; the only candidate is the three-day-old patient.
    const startedAt = new Date().toISOString();

    expect(
      await discoverFlowStudentId({
        userId: owner.id,
        instituteId: institute.id,
        startedAt,
        ignoreStudentId: null,
      }),
    ).toBeNull();
  });

  it("never adopts the patient that was selected when the flow started", async () => {
    const { owner, institute } = await setupClinic();
    const startedAt = new Date().toISOString();
    // The user pressed New Patient while this one was on screen; it is the
    // newest row in the institute, so only `ignoreStudentId` stands in the way.
    const onScreen = await addPatient(owner.id, institute.id, "Sam Selected");

    expect(
      await discoverFlowStudentId({
        userId: owner.id,
        instituteId: institute.id,
        startedAt,
        ignoreStudentId: onScreen.id,
      }),
    ).toBeNull();
  });

  it("ignores a patient belonging to another institute, and a soft-deleted one", async () => {
    const { owner, institute } = await setupClinic();
    const startedAt = new Date().toISOString();

    const { institute: other } = await makeInstitute(owner.id, { type: "clinic" });
    await addPatient(owner.id, other.id, "Elsewhere");
    expect(
      await discoverFlowStudentId({ userId: owner.id, instituteId: institute.id, startedAt }),
    ).toBeNull();

    const deleted = await addPatient(owner.id, institute.id, "Removed");
    await db
      .update(students)
      .set({ deletedAt: new Date() })
      .where(eq(students.id, deleted.id));
    expect(
      await discoverFlowStudentId({ userId: owner.id, instituteId: institute.id, startedAt }),
    ).toBeNull();
  });

  it("refuses a user who is not a member of the institute", async () => {
    const { owner, institute } = await setupClinic();
    const startedAt = new Date().toISOString();
    await addPatient(owner.id, institute.id, "Mira Vance");
    const outsider = await makeUser();

    await expect(
      discoverFlowStudentId({ userId: outsider.id, instituteId: institute.id, startedAt }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("needs no startedAt to refuse — an undatable flow discovers nothing", async () => {
    const { owner, institute } = await setupClinic();
    await addPatient(owner.id, institute.id, "Mira Vance");
    expect(
      await discoverFlowStudentId({ userId: owner.id, instituteId: institute.id, startedAt: null }),
    ).toBeNull();
  });

  /**
   * The explicitly selected id still wins when it passes the guard: discovery
   * is the FALLBACK, not a replacement. Both sources agree here; what matters
   * is that the selected path is still able to answer on its own.
   */
  it("leaves the explicit fill-in in charge when the request does carry the id", async () => {
    const { owner, institute } = await setupClinic();
    const startedAt = new Date().toISOString();
    const created = await addPatient(owner.id, institute.id, "Mira Vance");

    expect(
      await resolveFlowStudentId({
        boundStudentId: null,
        inputStudentId: created.id,
        ignoreStudentId: null,
        startedAt,
      }),
    ).toBe(created.id);
  });
});
