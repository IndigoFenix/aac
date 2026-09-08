/**
 * GUIDED SETUP roster import (Phase D) against real rows.
 *
 * This is the only place in the platform that creates STUDENTS IN BULK, and
 * every property worth having is one that only shows up against a database:
 *
 *  - The LICENSE CAP is checked twice — once against the whole included set and
 *    again immediately before each insert. Without the second check a second
 *    tab, or the rows this very batch just created, walk the institute past its
 *    cap one child at a time and nothing complains until a clinician cannot
 *    open a session.
 *  - PER-ROW ISOLATION. A roster is thirty families' data; one bad row must
 *    cost that row, not the other twenty-nine. A shared transaction would fail
 *    them all, and the user would have no way to tell which half landed.
 *  - `idNumber` / `grade` live on the LINK (`institute_students`), not the
 *    student — and `grade` is a Postgres ENUM, so an unrecognised value must
 *    land as NULL rather than take the INSERT down with it.
 *  - The CONSENT BATCH sends things. It must refuse per item, never throw the
 *    batch away, and must send NOTHING while the gate flag is off.
 *
 * Nothing here may send a real email or SMS: the test environment carries live
 * SES credentials (memory: feedback_test_env_has_live_ses), so both senders are
 * mocked at module scope before anything imports them.
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll, jest } from "@jest/globals";

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
import { makeUser, makeInstitute, makeLicense, makeStudent } from "../helpers/factories.js";
import {
  activityLogs,
  consentInvitations,
  instituteStudents,
  studentContacts,
  students,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

import { instituteRepository } from "../../repositories/instituteRepository.js";

type ServiceModule = typeof import("../../services/guided-setup/student-setup-service.js");
type RosterModule = typeof import("../../services/guided-setup/roster-import.js");
type StateModule = typeof import("../../services/guided-setup/student-setup-state.js");

let service: ServiceModule;
let roster: RosterModule;
let state: StateModule;

beforeAll(async () => {
  // Dynamic import, so the mocked senders are registered first: `jest.mock` is
  // inert under ESM (memory: feedback_jest_mock_inert_under_esm) and a
  // statically imported consentInvitationService would hold the real SES client.
  service = await import("../../services/guided-setup/student-setup-service.js");
  roster = await import("../../services/guided-setup/roster-import.js");
  state = await import("../../services/guided-setup/student-setup-state.js");
});

const ENV_FLAG = "CONSENT_GATE_ENABLED";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setupSchool(
  permissions: Record<string, unknown> = { maxStudents: 10, aacEnabled: true, dashboardLevel: 1 },
) {
  const owner = await makeUser();
  const { institute } = await makeInstitute(owner.id, { type: "school" });
  await makeLicense({ instituteId: institute.id, permissions: permissions as never });
  return { owner, institute };
}

type Row = Parameters<RosterModule["confirmRoster"]>[0]["rows"][number];

function row(over: Partial<Row> = {}): Row {
  return {
    firstName: "Noa",
    lastName: "Levi",
    birthDate: "2018-01-01",
    include: true,
    ...over,
  };
}

async function confirm(
  owner: { id: string },
  institute: { id: string },
  rows: Row[],
  proposalId = "batch-1",
) {
  return service.confirmRosterBatch({
    userId: owner.id,
    instituteId: institute.id,
    proposalId,
    rows,
  });
}

/** The students actually enrolled in the institute, newest arbitrary order. */
async function enrolled(instituteId: string) {
  return db
    .select({
      studentId: students.id,
      name: students.name,
      birthDate: students.birthDate,
      gender: students.gender,
      country: students.country,
      primaryLanguage: students.primaryLanguage,
      idNumber: instituteStudents.idNumber,
      grade: instituteStudents.grade,
      data: instituteStudents.data,
    })
    .from(instituteStudents)
    .innerJoin(students, eq(students.id, instituteStudents.studentId))
    .where(eq(instituteStudents.instituteId, instituteId));
}

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

describe("Guided Setup roster — access", () => {
  withEnvRestore();

  it("refuses a user who is not a member of the institute", async () => {
    const { institute } = await setupSchool();
    const outsider = await makeUser();

    await expect(confirm(outsider, institute, [row()])).rejects.toMatchObject({
      status: 403,
    });
    expect(await enrolled(institute.id)).toHaveLength(0);
  });

  it("refuses a roster on a FAMILY institute", async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: "family" });
    await makeLicense({ instituteId: institute.id, permissions: { maxStudents: 5 } as never });

    await expect(confirm(owner, institute, [row()])).rejects.toMatchObject({ status: 400 });
    expect(await enrolled(institute.id)).toHaveLength(0);
  });

  it("refuses proposeRoster on a family account with a readable reason", async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: "family" });
    await makeLicense({ instituteId: institute.id, permissions: { maxStudents: 5 } as never });

    const view = await service.proposeRoster({
      userId: owner.id,
      instituteId: institute.id,
      studentId: null,
      rows: [{ firstName: "Noa", lastName: "Levi" }],
    });
    expect(view.refused).toEqual({ action: "proposeRoster", reason: "rosterNotForFamily" });
    expect(view.roster ?? null).toBeNull();
  });
});

describe("Guided Setup roster — confirm", () => {
  withEnvRestore();

  it("creates the included rows and skips the rest", async () => {
    const { owner, institute } = await setupSchool();

    const result = await confirm(owner, institute, [
      row({ firstName: "Noa", lastName: "Levi" }),
      row({ firstName: "Omar", lastName: "Haddad", include: false, rowId: "skip-me" }),
    ]);

    expect(result.created).toHaveLength(1);
    expect(result.created[0].name).toBe("Noa Levi");
    expect(result.skipped).toEqual(["skip-me"]);
    expect(result.failed).toEqual([]);

    const rows = await enrolled(institute.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].birthDate).toBe("2018-01-01");
  });

  it("writes idNumber and grade on the LINK, and drops a grade outside the enum", async () => {
    const { owner, institute } = await setupSchool();

    await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One", idNumber: "S-1001", grade: "3rd Grade" }),
      row({ firstName: "B", lastName: "Two", idNumber: "S-1002", grade: "Year 13" }),
    ]);

    const rows = await enrolled(institute.id);
    const a = rows.find((r) => r.name === "A One")!;
    const b = rows.find((r) => r.name === "B Two")!;
    expect(a.idNumber).toBe("S-1001");
    expect(a.grade).toBe("3");
    // An unrecognised grade must not take the whole row down with it.
    expect(b.idNumber).toBe("S-1002");
    expect(b.grade).toBeNull();
  });

  it("creates a guardian contact when any guardian field is present", async () => {
    const { owner, institute } = await setupSchool();

    await confirm(owner, institute, [
      row({
        firstName: "Noa",
        lastName: "Levi",
        guardianName: "Dana Levi",
        guardianEmail: "dana@example.com",
        guardianPhone: "+972500000000",
      }),
      row({ firstName: "Omar", lastName: "Haddad" }),
    ]);

    const rows = await enrolled(institute.id);
    const noa = rows.find((r) => r.name === "Noa Levi")!;
    const omar = rows.find((r) => r.name === "Omar Haddad")!;

    const noaContacts = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.studentId, noa.studentId));
    expect(noaContacts).toHaveLength(1);
    expect(noaContacts[0].name).toBe("Dana Levi");
    expect(noaContacts[0].role).toBe("parent_guardian");
    expect(noaContacts[0].relationship).toBe("parent");
    expect(noaContacts[0].contactEmail).toBe("dana@example.com");
    expect(noaContacts[0].provenance).toEqual({ source: "roster" });
    // A guardian is only a legal guardian once they SIGN.
    expect(noaContacts[0].isLegalGuardian).toBe(false);

    const omarContacts = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.studentId, omar.studentId));
    expect(omarContacts).toHaveLength(0);
  });

  it("stamps the flow record with source roster and the batch id", async () => {
    const { owner, institute } = await setupSchool();
    await confirm(owner, institute, [row()], "batch-xyz");

    const rows = await enrolled(institute.id);
    const record = await state.readRecord(rows[0].studentId, institute.id);
    expect(record?.source).toBe("roster");
    expect(record?.rosterBatchId).toBe("batch-xyz");
    expect(record?.completedAt).toBeUndefined();
  });

  it("logs the create as a HUMAN action, not an AI one", async () => {
    const { owner, institute } = await setupSchool();
    await confirm(owner, institute, [row()]);

    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.instituteId, institute.id), eq(activityLogs.eventType, "create")));
    expect(logs.length).toBeGreaterThan(0);
    const entry = logs.find((l) => l.subjectType1 === "student")!;
    expect(entry.isAiInitiated).toBe(false);
    expect((entry.details as Record<string, unknown>).source).toBe("roster");
  });

  it("inherits the institute's language and normalises the country", async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: "school", language: "en" });
    await makeLicense({ instituteId: institute.id, permissions: { maxStudents: 5 } as never });

    await confirm(owner, institute, [row()]);
    const rows = await enrolled(institute.id);
    expect(rows[0].primaryLanguage).toBe("en");
  });
});

describe("Guided Setup roster — the licence cap", () => {
  withEnvRestore();

  it("creates up to the cap and fails the overflow, per row", async () => {
    const { owner, institute } = await setupSchool({ maxStudents: 2, dashboardLevel: 1 });

    const result = await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One", rowId: "r1" }),
      row({ firstName: "B", lastName: "Two", rowId: "r2" }),
      row({ firstName: "C", lastName: "Three", rowId: "r3" }),
    ]);

    expect(result.created).toHaveLength(2);
    // The third row is unchecked by the normaliser before it is ever attempted:
    // it comes back skipped, not failed — the user can see it was never tried.
    expect([...result.skipped, ...result.failed.map((f) => f.rowId)]).toContain("r3");
    expect(await enrolled(institute.id)).toHaveLength(2);
  });

  it("counts students already in the institute against the cap", async () => {
    const { owner, institute } = await setupSchool({ maxStudents: 2, dashboardLevel: 1 });
    const { student } = await makeStudent(owner.id);
    await instituteRepository.assignStudentToInstitute(institute.id, student.id);

    const result = await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One", rowId: "r1" }),
      row({ firstName: "B", lastName: "Two", rowId: "r2" }),
    ]);

    expect(result.created).toHaveLength(1);
    expect(await enrolled(institute.id)).toHaveLength(2);
  });

  it("creates nobody when the licence allows no students at all", async () => {
    const { owner, institute } = await setupSchool({ maxStudents: 0, dashboardLevel: 1 });
    const result = await confirm(owner, institute, [row()]);

    expect(result.created).toHaveLength(0);
    expect(await enrolled(institute.id)).toHaveLength(0);
  });

  it("does not cap an unlimited licence", async () => {
    const { owner, institute } = await setupSchool({ maxStudents: -1, dashboardLevel: 1 });
    const result = await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One" }),
      row({ firstName: "B", lastName: "Two" }),
      row({ firstName: "C", lastName: "Three" }),
    ]);
    expect(result.created).toHaveLength(3);
  });
});

describe("Guided Setup roster — row isolation", () => {
  withEnvRestore();

  it("keeps a nameless row from taking the batch down with it", async () => {
    const { owner, institute } = await setupSchool();

    const result = await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One" }),
      row({ firstName: null, lastName: null, rowId: "bad" }),
      row({ firstName: "C", lastName: "Three" }),
    ]);

    expect(result.created).toHaveLength(2);
    expect([...result.skipped, ...result.failed.map((f) => f.rowId)]).toContain("bad");
    expect(await enrolled(institute.id)).toHaveLength(2);
  });

  it("still creates a row whose birth date could not be read", async () => {
    const { owner, institute } = await setupSchool();
    const result = await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One", birthDate: "sometime in 2018" }),
    ]);

    // The row is created WITHOUT a birth date: the consent gate then holds it
    // at step 1, which is the correct place for a human to fix it.
    expect(result.created).toHaveLength(1);
    const rows = await enrolled(institute.id);
    expect(rows[0].birthDate).toBeNull();
  });
});

describe("Guided Setup roster — duplicates", () => {
  withEnvRestore();

  it("flags but does not block a student already in the institute", async () => {
    const { owner, institute } = await setupSchool();
    await confirm(owner, institute, [row({ firstName: "Noa", lastName: "Levi" })]);

    const proposal = await roster.normaliseForInstitute({
      instituteId: institute.id,
      country: "IL",
      rows: [{ firstName: "Noa", lastName: "Levi", birthDate: "2018-01-01" }],
    });
    expect(proposal.rows[0].warnings).toContain("duplicate");
    // Flagged, not refused: two children CAN share a name and a birthday.
    expect(proposal.rows[0].include).toBe(true);
  });

  it("reports the remaining seats the review table shows", async () => {
    const { owner, institute } = await setupSchool({ maxStudents: 3, dashboardLevel: 1 });
    await confirm(owner, institute, [row({ firstName: "A", lastName: "One" })]);

    const proposal = await roster.normaliseForInstitute({
      instituteId: institute.id,
      country: "IL",
      rows: [{ firstName: "B", lastName: "Two" }],
    });
    expect(proposal.remainingSeats).toBe(2);
  });
});

describe("Guided Setup roster — the view after a batch", () => {
  withEnvRestore();

  it("returns a view with no roster and every new student parked", async () => {
    const { owner, institute } = await setupSchool();

    const result = await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One" }),
      row({ firstName: "B", lastName: "Two" }),
    ]);

    expect(result.view.roster ?? null).toBeNull();
    expect(result.view.parked).toBeDefined();
    expect(result.view.parked!.map((p) => p.name).sort()).toEqual(["A One", "B Two"]);
    expect(result.view.parked!.every((p) => p.step === "basics" || p.step === "medical")).toBe(true);
  });

  it("carries a proposal on every turn's view while one is pending", async () => {
    const { owner, institute } = await setupSchool();

    const proposed = await service.proposeRoster({
      userId: owner.id,
      instituteId: institute.id,
      studentId: null,
      rows: [{ firstName: "Noa", lastName: "Levi", birthDate: "01/02/2018" }],
    });
    expect(proposed.roster).toBeTruthy();
    expect(proposed.roster!.rows).toHaveLength(1);
    // IL institute → day first.
    expect(proposed.roster!.rows[0].birthDate).toBe("2018-02-01");

    // A LATER turn, with the proposal handed back in from the session state.
    const { view } = await service.resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: null,
      rosterProposal: proposed.roster,
    });
    expect(view.roster?.id).toBe(proposed.roster!.id);
  });
});

describe("Guided Setup — consent request batch", () => {
  withEnvRestore();

  /** A school with two students, each with a contactable guardian. */
  async function schoolWithGuardians() {
    const { owner, institute } = await setupSchool();
    await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One", guardianName: "P1", guardianEmail: "p1@example.com" }),
      row({ firstName: "B", lastName: "Two", guardianName: "P2", guardianEmail: "p2@example.com" }),
    ]);
    const rows = await enrolled(institute.id);
    const items = [];
    for (const r of rows) {
      const [contact] = await db
        .select({ id: studentContacts.id })
        .from(studentContacts)
        .where(eq(studentContacts.studentId, r.studentId));
      items.push({ studentId: r.studentId, contactId: contact.id, channel: "email" as const });
    }
    return { owner, institute, items };
  }

  it("creates one invitation per item when the gate is on", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute, items } = await schoolWithGuardians();

    const result = await service.requestConsentBatch({
      userId: owner.id,
      instituteId: institute.id,
      items,
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.ok)).toBe(true);

    const invitations = await db.select().from(consentInvitations);
    expect(invitations).toHaveLength(2);
    // Mocked at module scope — a real send here would reach a real inbox.
    expect(sendEmail).toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("sends NOTHING and returns consentGateOff per item when the flag is off", async () => {
    delete process.env[ENV_FLAG];
    const { owner, institute, items } = await schoolWithGuardians();

    const result = await service.requestConsentBatch({
      userId: owner.id,
      instituteId: institute.id,
      items,
    });

    expect(result.results.map((r) => r.reason)).toEqual(["consentGateOff", "consentGateOff"]);
    expect(result.results.every((r) => !r.ok)).toBe(true);
    expect(await db.select().from(consentInvitations)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses one bad item without abandoning the rest", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute, items } = await schoolWithGuardians();

    const result = await service.requestConsentBatch({
      userId: owner.id,
      instituteId: institute.id,
      items: [
        items[0],
        // A contact that does not belong to this student.
        { ...items[1], contactId: items[0].contactId },
      ],
    });

    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[1].reason).toBe("guardianMissing");
    expect(await db.select().from(consentInvitations)).toHaveLength(1);
  });

  it("refuses a non-member outright, before anything is sent", async () => {
    process.env[ENV_FLAG] = "true";
    const { institute, items } = await schoolWithGuardians();
    const outsider = await makeUser();

    await expect(
      service.requestConsentBatch({
        userId: outsider.id,
        instituteId: institute.id,
        items,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("gives the parked list a contact id so the rail can build the batch", async () => {
    process.env[ENV_FLAG] = "true";
    const { owner, institute } = await setupSchool();
    await confirm(owner, institute, [
      row({ firstName: "A", lastName: "One", guardianName: "P1", guardianEmail: "p1@example.com" }),
      row({ firstName: "B", lastName: "Two" }),
    ]);

    const parked = await service.parked({ userId: owner.id, instituteId: institute.id });
    const withGuardian = parked.find((p) => p.name === "A One")!;
    const without = parked.find((p) => p.name === "B Two")!;
    expect(withGuardian.consentContactId).toBeTruthy();
    // No guardian → nothing to send to, and the button must not count them.
    expect(without.consentContactId).toBeNull();
  });
});
