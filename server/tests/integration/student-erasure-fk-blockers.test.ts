/**
 * The erasure cascade against every row shape that used to make it THROW.
 *
 * `_hardDeleteStudent` runs as one transaction, so a single FK violation
 * rolls the whole thing back and the student stays tombstoned forever. Five
 * shapes did exactly that in production and none of them was seeded by
 * student-erasure.test.ts, so the suite was green while no erasure request
 * ever completed:
 *
 *   1. invite_codes.student_id        NOT NULL, never deleted   → blocks students
 *   2. consent_forms.program_id       NOT NULL, never deleted   → blocks programs
 *   3. accommodations.service_id      deleted AFTER services    → blocks services
 *   4. data_points.goal_progress_entry_id / objective_id
 *                                     deleted AFTER their parents (or not at all)
 *   5. student_contacts.linked_student_id on ANOTHER student's contact,
 *      sharing this student's biometric_data row → blocks students + biometric_data
 *
 * The assertion that matters is `failed` being empty: it is the sweep
 * reporting the transaction committed.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { truncateAll, db } from "../helpers/db.js";
import { makeUser, makeStudent } from "../helpers/factories.js";
import { studentErasureService } from "../../services/studentErasureService.js";
import { runStudentErasureSweep } from "../../services/studentErasureCron.js";
import {
  students,
  studentContacts,
  biometricData,
  programs,
  goals,
  objectives,
  services,
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  consentForms,
  inviteCodes,
  inviteCodeRedemptions,
} from "@shared/schema";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("student erasure — FK blockers", () => {
  afterEach(truncateAll);

  it("hard-deletes a student carrying every previously-blocking row shape", async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    const { student: otherStudent } = await makeStudent(owner.id);

    // ── IEP tree with the problematic leaves ──────────────────────────────
    const [program] = await db.insert(programs)
      .values({ studentId: student.id, framework: "us_iep", status: "active" } as any)
      .returning();
    const [goal] = await db.insert(goals)
      .values({ programId: program.id, goalStatement: "Greet 3 peers per day" } as any)
      .returning();
    const [objective] = await db.insert(objectives)
      .values({ goalId: goal.id, objectiveStatement: "Greet 1 peer" } as any)
      .returning();
    const [report] = await db.insert(progressReports)
      .values({ programId: program.id, reportDate: "2026-01-15" } as any)
      .returning();
    const [entry] = await db.insert(goalProgressEntries)
      .values({ progressReportId: report.id, goalId: goal.id, progressStatus: "making_progress" } as any)
      .returning();
    // (4) three data points, each reaching a parent by a different path
    await db.insert(dataPoints).values([
      { goalId: goal.id, recordedAt: new Date(), value: "1" },
      { objectiveId: objective.id, recordedAt: new Date(), value: "2" },
      { goalProgressEntryId: entry.id, recordedAt: new Date(), value: "3" },
    ] as any);
    // (3) an accommodation hanging off a service
    const [service] = await db.insert(services)
      .values({ programId: program.id, serviceType: "speech_language_therapy" } as any)
      .returning();
    await db.insert(accommodations)
      .values({ serviceId: service.id, programId: program.id, accommodationType: "visual_support", description: "Visual schedule" } as any);
    // (2) a consent form on the program
    await db.insert(consentForms)
      .values({ programId: program.id, consentType: "initial_evaluation" } as any);

    // ── (1) an invite code for the student, with a redemption ────────────
    const [code] = await db.insert(inviteCodes)
      .values({ code: randomBytes(6).toString("hex"), createdByUserId: owner.id, studentId: student.id } as any)
      .returning();
    await db.insert(inviteCodeRedemptions)
      .values({ inviteCodeId: code.id, redeemedByUserId: owner.id, studentId: student.id } as any);

    // ── (5) another student's contact linked to THIS student, sharing the face record
    const [bio] = await db.insert(biometricData).values({ faceImageUrl: null } as any).returning();
    await db.update(students).set({ biometricDataId: bio.id }).where(eq(students.id, student.id));
    const [linkedContact] = await db.insert(studentContacts)
      .values({
        studentId: otherStudent.id,
        name: "Sibling",
        relationship: "sibling",
        role: "parent_guardian",
        linkedStudentId: student.id,
        biometricDataId: bio.id,
      } as any)
      .returning();

    // ── Tombstone, backdate, sweep ────────────────────────────────────────
    await studentErasureService.softDeleteStudent(student.id, owner.id, null);
    await db.update(students)
      .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
      .where(eq(students.id, student.id));

    const result = await runStudentErasureSweep();

    // The transaction committed — this is the assertion that was silently
    // false in production.
    expect(result.failed).toEqual([]);
    expect(result.hardDeleted).toBe(1);

    expect(await db.select().from(students).where(eq(students.id, student.id))).toHaveLength(0);
    expect(await db.select().from(programs).where(eq(programs.id, program.id))).toHaveLength(0);
    expect(await db.select().from(consentForms).where(eq(consentForms.programId, program.id))).toHaveLength(0);
    expect(await db.select().from(inviteCodes).where(eq(inviteCodes.id, code.id))).toHaveLength(0);
    expect(await db.select().from(services).where(eq(services.id, service.id))).toHaveLength(0);
    expect(await db.select().from(accommodations).where(eq(accommodations.programId, program.id))).toHaveLength(0);
    expect(await db.select().from(dataPoints).where(eq(dataPoints.goalId, goal.id))).toHaveLength(0);
    expect(await db.select().from(dataPoints).where(eq(dataPoints.objectiveId, objective.id))).toHaveLength(0);
    expect(await db.select().from(biometricData).where(eq(biometricData.id, bio.id))).toHaveLength(0);

    // The OTHER student keeps their contact — but it no longer claims to be
    // the erased student, and no longer points at the deleted face record.
    const [survivor] = await db.select().from(studentContacts).where(eq(studentContacts.id, linkedContact.id));
    expect(survivor).toBeDefined();
    expect(survivor.linkedStudentId).toBeNull();
    expect(survivor.biometricDataId).toBeNull();
    expect(await db.select().from(students).where(eq(students.id, otherStudent.id))).toHaveLength(1);
  });
});
