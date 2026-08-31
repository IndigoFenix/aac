/**
 * Data-subject ACCESS ("produce") and AMENDMENT ("correct") requests.
 * AKIM appendix §18.3 / §18.4.
 *
 * The properties worth pinning are the ones that make the pipeline a control
 * rather than a table:
 *   * the 72-hour forward deadline is FROZEN at open — a later policy change
 *     cannot rewrite the window a request was actually held to;
 *   * the export walks far enough to be a real answer (a medical record and a
 *     chat transcript are both in it) but stops short of handing over a
 *     biometric TEMPLATE, and says so out loud instead of dropping it silently;
 *   * PHI leaving as a file writes an `export` audit row;
 *   * the sweep escalates once and only once per phase.
 *
 * The sweep is ALWAYS driven with an injected `alert`. The test environment
 * carries live SES credentials; the default sender would mail the on-call
 * mailbox from a test run.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { and, eq } from "drizzle-orm";
import { db, truncateAll } from "../helpers/db.js";
import { makeUser, makeStudent } from "../helpers/factories.js";
import {
  activityLogs,
  biometricData,
  chatSessions,
  dataSubjectRequests,
  medicalRecords,
  students,
} from "@shared/schema";
import {
  dataSubjectRequestService,
  DataSubjectRequestConflict,
} from "../../services/dataSubjectRequestService.js";
import { buildDataSubjectExport } from "../../services/dataSubjectExportService.js";
import { runDataSubjectRequestSweep } from "../../services/dataSubjectRequestSweepCron.js";
import { computeForwardDeadline, requestReference } from "../../services/data-subject-deadlines.js";

const HOUR = 60 * 60 * 1000;

/** activityLogService.log is fire-and-forget; give the insert a moment to land. */
async function settle() {
  await new Promise((r) => setTimeout(r, 250));
}

/**
 * Poll for a fire-and-forget activity row instead of trusting one fixed
 * settle: under a loaded full-suite run the 250ms window is not enough and
 * the assertion reads before the insert lands (seen 2026-08-30, full run).
 */
async function waitForRows<T>(query: () => Promise<T[]>, timeoutMs = 5000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await query();
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** An alert sender that records instead of sending. NEVER use the default here. */
function captureAlerts() {
  const sent: Array<{ subject: string; lines: string[] }> = [];
  return {
    sent,
    alert: async (subject: string, lines: string[]) => {
      sent.push({ subject, lines });
      return { sent: true } as any;
    },
  };
}

async function seedStudent() {
  const user = await makeUser();
  const { student } = await makeStudent(user.id);
  return { user, student };
}

describe("dataSubjectRequestService lifecycle", () => {
  afterEach(truncateAll);

  it("freezes the 72-hour forward deadline at open", async () => {
    const { user, student } = await seedStudent();
    const receivedAt = new Date("2026-03-01T09:00:00.000Z");

    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce", receivedAt, requesterDescription: "mother, ID checked by phone" },
      user.id,
    );

    expect(request.status).toBe("open");
    expect(request.forwardDeadlineAt.toISOString()).toBe(
      computeForwardDeadline(receivedAt).toISOString(),
    );
    expect(request.forwardDeadlineAt.getTime() - receivedAt.getTime()).toBe(72 * HOUR);

    // The stored value is what a later read returns — nothing re-derives it.
    const reread = await dataSubjectRequestService.getOrThrow(request.id);
    expect(reread.forwardDeadlineAt.toISOString()).toBe(request.forwardDeadlineAt.toISOString());
  });

  it("records the request as an audit event on the student", async () => {
    const { user, student } = await seedStudent();
    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "correct", targetTable: "medical_records", targetField: "primaryDiagnosis" },
      user.id,
    );
    await settle();

    const [row] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.eventType, "create"),
          eq(activityLogs.subjectType1, "data_subject_request"),
          eq(activityLogs.subjectId1, request.id),
        ),
      );
    expect(row).toBeDefined();
    expect(row.subjectId2).toBe(student.id);
    expect((row.details as any).reference).toBe(requestReference(request.id));
  });

  it("walks produce → forwarded → fulfilled", async () => {
    const { user, student } = await seedStudent();
    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce" },
      user.id,
    );

    const forwarded = await dataSubjectRequestService.markForwarded(request.id, user.id);
    expect(forwarded.status).toBe("forwarded");
    expect(forwarded.forwardedAt).toBeInstanceOf(Date);

    const fulfilled = await dataSubjectRequestService.markFulfilled(request.id, user.id);
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.fulfilledAt).toBeInstanceOf(Date);
  });

  it("keeps the refusal, the reason and the subject's own statement together", async () => {
    const { user, student } = await seedStudent();
    const request = await dataSubjectRequestService.open(
      {
        studentId: student.id,
        kind: "correct",
        targetTable: "medical_records",
        targetRecordId: "some-record",
        targetField: "primaryDiagnosis",
        proposedValue: "Rett syndrome, classic",
        currentValueSnapshot: "Rett syndrome, atypical",
      },
      user.id,
    );

    const decided = await dataSubjectRequestService.decide(
      request.id,
      {
        accepted: false,
        decision: "rejected",
        decisionReason: "The diagnosis is the treating physician's clinical finding, not ours to amend.",
        statementOfDisagreement: "The 2025 genetic panel says classic. I want this on file.",
      },
      user.id,
    );

    expect(decided.status).toBe("denied");
    expect(decided.decidedByUserId).toBe(user.id);
    expect(decided.decidedAt).toBeInstanceOf(Date);
    // The subject's words survive the refusal — that is the whole point of the
    // field. A denial with nowhere to record the objection is not lawful.
    expect(decided.statementOfDisagreement).toContain("genetic panel");
    expect(decided.currentValueSnapshot).toBe("Rett syndrome, atypical");
  });

  it("refuses to decide a produce request, or to touch a closed one", async () => {
    const { user, student } = await seedStudent();
    const produce = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce" },
      user.id,
    );
    await expect(
      dataSubjectRequestService.decide(produce.id, { accepted: true, decision: "ok" }, user.id),
    ).rejects.toBeInstanceOf(DataSubjectRequestConflict);

    await dataSubjectRequestService.withdraw(produce.id, user.id, "requester changed their mind");
    await expect(
      dataSubjectRequestService.markForwarded(produce.id, user.id),
    ).rejects.toBeInstanceOf(DataSubjectRequestConflict);
  });

  it("lists by status and finds the overdue ones", async () => {
    const { user, student } = await seedStudent();
    const stale = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce", receivedAt: new Date(Date.now() - 100 * HOUR) },
      user.id,
    );
    const fresh = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce" },
      user.id,
    );

    const open = await dataSubjectRequestService.list({ status: "open" });
    expect(open.map((r) => r.id).sort()).toEqual([stale.id, fresh.id].sort());

    const overdue = await dataSubjectRequestService.listOverdueForward();
    expect(overdue.map((r) => r.id)).toEqual([stale.id]);
  });
});

describe("buildDataSubjectExport", () => {
  afterEach(truncateAll);

  const VOICE_MARKER = 0.1234567891234;

  async function seedRichStudent() {
    const { user, student } = await seedStudent();

    await db.insert(medicalRecords).values({
      studentId: student.id,
      userId: user.id,
      primaryDiagnosis: "Rett syndrome",
      primaryDiagnosisCode: "F84.2",
    } as any);

    await db.insert(chatSessions).values({
      studentId: student.id,
      userId: user.id,
      chatMode: "aac",
      state: { phase: "test" },
      log: [{ role: "student", text: "I want the blue one" }],
    } as any);

    // A biometric row with a template AND an image pointer: the template must
    // be withheld, the image must come back as a presignable file reference.
    const [bio] = await db
      .insert(biometricData)
      .values({
        voiceEmbedding: [VOICE_MARKER, 0.5, 0.25],
        faceEmbedding: [0.9, 0.8],
        faceImageUrl: "biometric/test-face.jpg",
        hairColor: "brown",
      } as any)
      .returning();
    await db.update(students).set({ biometricDataId: bio.id }).where(eq(students.id, student.id));

    return { user, student, bioId: bio.id };
  }

  it("returns the substantive record: a medical record and a chat transcript", async () => {
    const { student } = await seedRichStudent();
    const bundle = await buildDataSubjectExport(student.id);

    expect(bundle.studentId).toBe(student.id);
    expect(bundle.tables.students).toHaveLength(1);
    expect(bundle.tables.medical_records).toHaveLength(1);
    expect((bundle.tables.medical_records[0] as any).primaryDiagnosis).toBe("Rett syndrome");
    expect(bundle.tables.chat_sessions).toHaveLength(1);
    // The child's own words are the most substantive thing we hold.
    expect(JSON.stringify(bundle.tables.chat_sessions)).toContain("I want the blue one");
  });

  it("lists every walked table even when empty, as evidence of completeness", async () => {
    const { student } = await seedRichStudent();
    const bundle = await buildDataSubjectExport(student.id);

    // A table absent from the bundle is indistinguishable from a table we
    // forgot to walk; an empty array says "we looked, there was nothing".
    for (const table of [
      "programs",
      "goals",
      "incidents",
      "boards",
      "person_chats",
      "custom_symbols",
      "student_devices",
      "photo_assignments",
    ]) {
      expect(bundle.tables[table]).toEqual([]);
    }
  });

  it("withholds the biometric template and NAMES it in omitted", async () => {
    const { student } = await seedRichStudent();
    const bundle = await buildDataSubjectExport(student.id);

    expect(bundle.tables.biometric_data).toHaveLength(1);
    // A template is a credential: handing over the vector lets its holder
    // impersonate the child to a matcher, and tells the subject nothing.
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(String(VOICE_MARKER));
    expect((bundle.tables.biometric_data[0] as any).voiceEmbedding).toBeUndefined();
    expect((bundle.tables.biometric_data[0] as any).faceEmbedding).toBeUndefined();
    // Non-template fields on the same row are still disclosed.
    expect((bundle.tables.biometric_data[0] as any).hairColor).toBe("brown");

    const omittedFields = bundle.omitted
      .filter((o) => o.table === "biometric_data")
      .map((o) => o.field);
    expect(omittedFields).toContain("voiceEmbedding");
    expect(omittedFields).toContain("faceEmbedding");
    const voice = bundle.omitted.find(
      (o) => o.table === "biometric_data" && o.field === "voiceEmbedding",
    )!;
    expect(voice.reason).toMatch(/template/i);
  });

  it("names the tables it refuses to walk at all", async () => {
    const { student } = await seedRichStudent();
    const bundle = await buildDataSubjectExport(student.id);

    const wholeTables = bundle.omitted.filter((o) => o.field === "*").map((o) => o.table);
    expect(wholeTables).toEqual(
      expect.arrayContaining(["sessions", "activity_logs", "session_debug_logs", "student_caretaker_pins"]),
    );
  });

  it("surfaces the face image as a file reference rather than a raw column", async () => {
    const { student } = await seedRichStudent();
    const bundle = await buildDataSubjectExport(student.id);

    const face = bundle.files.find((f) => f.field === "faceImageUrl");
    expect(face).toBeDefined();
    expect(face!.key).toBe("biometric/test-face.jpg");
    expect(face!.table).toBe("biometric_data");
    // A photograph of the subject is plainly theirs; the URL may be absent when
    // no bucket is configured, but the KEY is always reported.
    if (face!.url === null) expect(face!.error).toBeTruthy();
    else expect(face!.expiresAt).toBeTruthy();
  });

  it("is empty-but-shaped for a student that does not exist", async () => {
    const bundle = await buildDataSubjectExport("00000000-0000-0000-0000-000000000000");
    expect(bundle.tables.students).toEqual([]);
    expect(bundle.files).toEqual([]);
    expect(bundle.omitted.length).toBeGreaterThan(0);
  });
});

describe("data-subject export audit", () => {
  afterEach(truncateAll);

  it("writes an `export` row when the copy is produced", async () => {
    const { user, student } = await seedStudent();
    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce" },
      user.id,
    );

    dataSubjectRequestService.logExport(student.id, user.id, {
      requestId: request.id,
      reference: requestReference(request.id),
    });
    const [row] = await waitForRows(() =>
      db
        .select()
        .from(activityLogs)
        .where(and(eq(activityLogs.eventType, "export"), eq(activityLogs.subjectId1, student.id))),
    );

    expect(row).toBeDefined();
    expect(row.subjectType1).toBe("student");
    // `format` is what tells a later reader WHAT left the system.
    expect((row.details as any).format).toBe("dsr-json");
    expect((row.details as any).requestId).toBe(request.id);
  });
});

describe("runDataSubjectRequestSweep", () => {
  afterEach(truncateAll);

  it("does nothing, and mails nothing, when every deadline is comfortable", async () => {
    const { user, student } = await seedStudent();
    await dataSubjectRequestService.open({ studentId: student.id, kind: "produce" }, user.id);

    const { alert, sent } = captureAlerts();
    const result = await runDataSubjectRequestSweep(new Date(), { alert });

    expect(result.scanned).toBe(1);
    expect(result.raised).toEqual([]);
    expect(result.alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("warns before the deadline and escalates after it, once per phase", async () => {
    const { user, student } = await seedStudent();
    const receivedAt = new Date("2026-03-01T09:00:00.000Z");
    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "correct", receivedAt },
      user.id,
    );

    const { alert, sent } = captureAlerts();

    // T+49h: inside the 24h horizon, not yet late.
    const warn = await runDataSubjectRequestSweep(new Date(receivedAt.getTime() + 49 * HOUR), { alert });
    expect(warn.raised.map((f) => f.phase)).toEqual(["approaching"]);
    expect(sent[0].subject).toMatch(/approaching/i);

    // T+50h: the same phase must not mail again — an hourly cron that mails
    // hourly is an alert people learn to ignore.
    const repeat = await runDataSubjectRequestSweep(new Date(receivedAt.getTime() + 50 * HOUR), { alert });
    expect(repeat.raised).toEqual([]);
    expect(repeat.suppressed).toBe(1);
    expect(sent).toHaveLength(1);

    // T+80h: the phase CHANGED, so it escalates even though we already warned.
    const late = await runDataSubjectRequestSweep(new Date(receivedAt.getTime() + 80 * HOUR), { alert });
    expect(late.raised.map((f) => f.phase)).toEqual(["overdue"]);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toMatch(/MISSED/);
    expect(sent[1].lines.join("\n")).toContain(requestReference(request.id));

    // De-duplication is a column, so it survives a restart.
    const [row] = await db
      .select()
      .from(dataSubjectRequests)
      .where(eq(dataSubjectRequests.id, request.id));
    expect(row.lastAlertKind).toBe("overdue");
    expect(row.lastAlertAt).toBeInstanceOf(Date);
  });

  it("stops alerting once the request has been forwarded", async () => {
    const { user, student } = await seedStudent();
    const receivedAt = new Date(Date.now() - 100 * HOUR);
    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce", receivedAt },
      user.id,
    );
    await dataSubjectRequestService.markForwarded(request.id, user.id);

    const { alert, sent } = captureAlerts();
    const result = await runDataSubjectRequestSweep(new Date(), { alert });

    // A forwarded request is out of the sweep's query entirely: the obligation
    // it guards has been discharged.
    expect(result.scanned).toBe(0);
    expect(result.raised).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("ignores a withdrawn request whose deadline blew past", async () => {
    const { user, student } = await seedStudent();
    const request = await dataSubjectRequestService.open(
      { studentId: student.id, kind: "produce", receivedAt: new Date(Date.now() - 200 * HOUR) },
      user.id,
    );
    await dataSubjectRequestService.withdraw(request.id, user.id);

    const { alert, sent } = captureAlerts();
    const result = await runDataSubjectRequestSweep(new Date(), { alert });
    expect(result.raised).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});
