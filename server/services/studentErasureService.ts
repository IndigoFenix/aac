// Right-to-erasure (GDPR Art. 17 / IL Privacy Protection Law) service.
//
// Two-phase deletion:
//   1. softDeleteStudent — flips the tombstone columns (`deletedAt`,
//      `scheduledHardDeleteAt`), revokes access (deactivates user-student
//      and institute-student links + share rows), and emits an audit
//      event. The student is now invisible to non-admin queries; admins
//      can still see the row to cancel the erasure.
//   2. studentErasureCron (separate file) walks rows where
//      `scheduledHardDeleteAt <= now` and calls `_hardDeleteStudent`,
//      which physically deletes the PHI cascade in a single transaction.
//
// The 30-day default window matches the IL Privacy Protection Law
// rectification window. EU/GDPR has no fixed window but commonly follows
// the same pattern. Adjust per-deployment via STUDENT_ERASURE_WINDOW_DAYS.
//
// Audit-log entries for `student_erasure_*` events are exempt from the
// activity-log retention cron — they are compliance evidence that must
// outlive the rows they reference (see activityLogRetentionCron.ts).

import { db } from "../db";
import {
  students,
  userStudents,
  instituteStudents,
  studentClassrooms,
  studentContacts,
  aacSettings,
  aacSessionPlans,
  biometricData,
  medicalRecords,
  functionalReports,
  educationalReports,
  programs,
  profileDomains,
  baselineMeasurements,
  assessmentSources,
  goals,
  objectives,
  userGoals,
  userObjectives,
  services,
  serviceGoals,
  serviceUsers,
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  incidents,
  transitionPlans,
  transitionGoals,
  programContacts,
  meetings,
  studentConsentRecords,
  consentInvitations,
  chatSessions,
  deepAnalyses,
  boards,
  customAppAssignments,
  dropboxBackups,
  studentShareInvites,
  objectShares,
  standingShares,
  studentSymbolAssociations,
  inviteCodeRedemptions,
  aacUtteranceEvents,
  lettersOfMedicalNecessity,
  clinicianActivityIntervals,
  persons,
  personChatRooms,
  personChats,
  personChatRoomParticipants,
  callSessions,
  callParticipants,
} from "@shared/schema";
import { eq, and, lte, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { activityLogService } from "./activityLogService";
import { s3Service } from "./storage/s3-service";
import { deleteStudentPackageLinks } from "./packages/packageLinks";

const DEFAULT_WINDOW_DAYS = 30;

function resolveWindowDays(): number {
  const raw = process.env.STUDENT_ERASURE_WINDOW_DAYS;
  if (!raw) return DEFAULT_WINDOW_DAYS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 365) return parsed;
  return DEFAULT_WINDOW_DAYS;
}

export interface ErasureStatus {
  studentId: string;
  state: "active" | "tombstoned" | "missing";
  deletedAt: Date | null;
  scheduledHardDeleteAt: Date | null;
  /** Whether the cancellation window is still open. */
  cancellable: boolean;
  /** ISO date when the row will be physically removed (null if not scheduled). */
  hardDeleteEta: string | null;
}

export class StudentErasureService {
  /**
   * Phase 1: tombstone the student.
   *
   * - Sets `deletedAt = now` and `scheduledHardDeleteAt = now + window`.
   * - Deactivates every `user_students` link (revokes user access).
   * - Sets `institute_students.isActive = false`.
   * - Revokes any active object/standing shares emanating from this student.
   * - Emits a `student_erasure_requested` audit event.
   *
   * Idempotent: re-calling on an already-tombstoned student is a no-op
   * (returns the existing schedule). The window is NOT re-extended.
   */
  async softDeleteStudent(
    studentId: string,
    requestedByUserId: string,
    instituteId: string | null,
    reason?: string,
  ): Promise<ErasureStatus> {
    const now = new Date();
    const eta = new Date(now.getTime() + resolveWindowDays() * 86_400_000);

    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(students).where(eq(students.id, studentId));
      if (!existing) {
        return {
          studentId,
          state: "missing",
          deletedAt: null,
          scheduledHardDeleteAt: null,
          cancellable: false,
          hardDeleteEta: null,
        };
      }
      if (existing.deletedAt && existing.scheduledHardDeleteAt) {
        return {
          studentId,
          state: "tombstoned",
          deletedAt: existing.deletedAt,
          scheduledHardDeleteAt: existing.scheduledHardDeleteAt,
          cancellable: existing.scheduledHardDeleteAt > now,
          hardDeleteEta: existing.scheduledHardDeleteAt.toISOString(),
        };
      }

      await tx
        .update(students)
        .set({ deletedAt: now, scheduledHardDeleteAt: eta, isActive: false, updatedAt: now })
        .where(eq(students.id, studentId));

      // Revoke direct user access.
      await tx
        .update(userStudents)
        .set({ isActive: false, updatedAt: now })
        .where(eq(userStudents.studentId, studentId));

      // Revoke institute enrollment.
      await tx
        .update(instituteStudents)
        .set({ isActive: false })
        .where(eq(instituteStudents.studentId, studentId));

      // Revoke active cross-institute shares emanating from this student.
      await tx
        .update(objectShares)
        .set({ revokedAt: now })
        .where(and(eq(objectShares.studentId, studentId), isNull(objectShares.revokedAt)));

      await tx
        .update(standingShares)
        .set({ revokedAt: now })
        .where(and(eq(standingShares.studentId, studentId), isNull(standingShares.revokedAt)));

      activityLogService.log({
        instituteId: instituteId ?? undefined,
        userId: requestedByUserId,
        eventType: "student_erasure_requested",
        subjectType1: "student",
        subjectId1: studentId,
        details: {
          reason: reason ?? null,
          windowDays: resolveWindowDays(),
          scheduledHardDeleteAt: eta.toISOString(),
        },
      });

      return {
        studentId,
        state: "tombstoned",
        deletedAt: now,
        scheduledHardDeleteAt: eta,
        cancellable: true,
        hardDeleteEta: eta.toISOString(),
      };
    });
  }

  /**
   * Cancel a pending erasure within the window. Restores `isActive` on
   * the student row and on any user/institute links that were deactivated
   * during the soft-delete (best-effort: we only know they were
   * deactivated together, so we re-activate every link). If the row
   * already passed `scheduledHardDeleteAt`, throws — the cron may have
   * already started a hard delete in another transaction.
   */
  async cancelErasure(
    studentId: string,
    requestedByUserId: string,
    instituteId: string | null,
  ): Promise<ErasureStatus> {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(students).where(eq(students.id, studentId));
      if (!existing) {
        return {
          studentId,
          state: "missing",
          deletedAt: null,
          scheduledHardDeleteAt: null,
          cancellable: false,
          hardDeleteEta: null,
        };
      }
      if (!existing.deletedAt) {
        return {
          studentId,
          state: "active",
          deletedAt: null,
          scheduledHardDeleteAt: null,
          cancellable: false,
          hardDeleteEta: null,
        };
      }
      if (existing.scheduledHardDeleteAt && existing.scheduledHardDeleteAt <= now) {
        throw new Error("Erasure window has elapsed; cancellation no longer permitted");
      }

      await tx
        .update(students)
        .set({ deletedAt: null, scheduledHardDeleteAt: null, isActive: true, updatedAt: now })
        .where(eq(students.id, studentId));

      await tx
        .update(userStudents)
        .set({ isActive: true, updatedAt: now })
        .where(eq(userStudents.studentId, studentId));

      await tx
        .update(instituteStudents)
        .set({ isActive: true })
        .where(eq(instituteStudents.studentId, studentId));

      activityLogService.log({
        instituteId: instituteId ?? undefined,
        userId: requestedByUserId,
        eventType: "student_erasure_cancelled",
        subjectType1: "student",
        subjectId1: studentId,
      });

      return {
        studentId,
        state: "active",
        deletedAt: null,
        scheduledHardDeleteAt: null,
        cancellable: false,
        hardDeleteEta: null,
      };
    });
  }

  /** Read-only status for admin UIs. */
  async getErasureStatus(studentId: string): Promise<ErasureStatus> {
    const [row] = await db.select().from(students).where(eq(students.id, studentId));
    if (!row) {
      return {
        studentId,
        state: "missing",
        deletedAt: null,
        scheduledHardDeleteAt: null,
        cancellable: false,
        hardDeleteEta: null,
      };
    }
    const now = new Date();
    const tombstoned = row.deletedAt !== null;
    const cancellable = tombstoned && row.scheduledHardDeleteAt !== null && row.scheduledHardDeleteAt > now;
    return {
      studentId,
      state: tombstoned ? "tombstoned" : "active",
      deletedAt: row.deletedAt,
      scheduledHardDeleteAt: row.scheduledHardDeleteAt,
      cancellable,
      hardDeleteEta: row.scheduledHardDeleteAt ? row.scheduledHardDeleteAt.toISOString() : null,
    };
  }

  /**
   * Phase 2: physical cascade delete. Called by the cron; can also be
   * called by admin tooling for an immediate purge (skipping the window).
   *
   * Walks the PHI table dependency tree from leaves to roots in a single
   * transaction. If any step fails, the whole erasure rolls back — better
   * to leave a tombstoned row than a half-deleted student.
   *
   * S3 / external-storage cleanup runs *after* the DB transaction commits.
   * If the DB commit fails, the S3 keys are untouched — better to leak
   * orphaned blobs than delete a customer's data on a half-rolled-back
   * erasure. Conversely, if S3 deletion fails after a successful commit,
   * the DB rows are gone (so the orphans are unreachable) and the cron
   * logs a warning. A nightly orphan-GC sweep is a future improvement.
   */
  async _hardDeleteStudent(
    studentId: string,
    requestedByUserId: string | null,
    instituteId: string | null,
  ): Promise<{ s3KeysFailed: string[] }> {
    // Keys collected during the transaction; deleted after it commits.
    const s3KeysToDelete: string[] = [];

    await db.transaction(async (tx) => {
      // -------- Resolve transitive parent IDs first --------
      const programRows = await tx.select({ id: programs.id }).from(programs).where(eq(programs.studentId, studentId));
      const programIds = programRows.map((r) => r.id);

      const profileDomainRows = programIds.length
        ? await tx.select({ id: profileDomains.id }).from(profileDomains).where(inArray(profileDomains.programId, programIds))
        : [];
      const profileDomainIds = profileDomainRows.map((r) => r.id);

      // goals.programId points back to the program (not profile_domain).
      const goalRows = programIds.length
        ? await tx.select({ id: goals.id }).from(goals).where(inArray(goals.programId, programIds))
        : [];
      const goalIds = goalRows.map((r) => r.id);

      const objectiveRows = goalIds.length
        ? await tx.select({ id: objectives.id }).from(objectives).where(inArray(objectives.goalId, goalIds))
        : [];
      const objectiveIds = objectiveRows.map((r) => r.id);

      const serviceRows = programIds.length
        ? await tx.select({ id: services.id }).from(services).where(inArray(services.programId, programIds))
        : [];
      const serviceIds = serviceRows.map((r) => r.id);

      // transition_plans.programId references programs (not students).
      const transitionPlanRows = programIds.length
        ? await tx
            .select({ id: transitionPlans.id })
            .from(transitionPlans)
            .where(inArray(transitionPlans.programId, programIds))
        : [];
      const transitionPlanIds = transitionPlanRows.map((r) => r.id);

      // boards belong to students; dropbox_backups attaches to boards (not
      // students directly), so we resolve the board ids first.
      const boardRows = await tx.select({ id: boards.id }).from(boards).where(eq(boards.studentId, studentId));
      const boardIds = boardRows.map((r) => r.id);

      // -------- Leaves first --------
      if (objectiveIds.length) {
        await tx.delete(userObjectives).where(inArray(userObjectives.objectiveId, objectiveIds));
      }
      if (goalIds.length) {
        await tx.delete(userGoals).where(inArray(userGoals.goalId, goalIds));
        await tx.delete(goalProgressEntries).where(inArray(goalProgressEntries.goalId, goalIds));
        await tx.delete(dataPoints).where(inArray(dataPoints.goalId, goalIds));
      }
      if (objectiveIds.length) {
        await tx.delete(objectives).where(inArray(objectives.id, objectiveIds));
      }
      if (serviceIds.length) {
        await tx.delete(serviceGoals).where(inArray(serviceGoals.serviceId, serviceIds));
        await tx.delete(serviceUsers).where(inArray(serviceUsers.serviceId, serviceIds));
        await tx.delete(services).where(inArray(services.id, serviceIds));
      }
      if (programIds.length) {
        await tx.delete(accommodations).where(inArray(accommodations.programId, programIds));
        await tx.delete(progressReports).where(inArray(progressReports.programId, programIds));
        await tx.delete(programContacts).where(inArray(programContacts.programId, programIds));
        await tx.delete(meetings).where(inArray(meetings.programId, programIds));
      }
      if (profileDomainIds.length) {
        // assessment_sources.profileDomainId / baseline_measurements.profileDomainId.
        await tx.delete(assessmentSources).where(inArray(assessmentSources.profileDomainId, profileDomainIds));
        await tx.delete(baselineMeasurements).where(inArray(baselineMeasurements.profileDomainId, profileDomainIds));
      }
      if (goalIds.length) {
        await tx.delete(goals).where(inArray(goals.id, goalIds));
      }
      if (profileDomainIds.length) {
        await tx.delete(profileDomains).where(inArray(profileDomains.id, profileDomainIds));
      }
      if (transitionPlanIds.length) {
        await tx.delete(transitionGoals).where(inArray(transitionGoals.transitionPlanId, transitionPlanIds));
        await tx.delete(transitionPlans).where(inArray(transitionPlans.id, transitionPlanIds));
      }
      if (boardIds.length) {
        await tx.delete(dropboxBackups).where(inArray(dropboxBackups.boardId, boardIds));
      }

      // -------- Direct student-keyed tables --------
      // deep_analyses references students directly (not via chat_sessions).
      await tx.delete(deepAnalyses).where(eq(deepAnalyses.studentId, studentId));
      await tx.delete(programs).where(eq(programs.studentId, studentId));
      await tx.delete(medicalRecords).where(eq(medicalRecords.studentId, studentId));
      await tx.delete(functionalReports).where(eq(functionalReports.studentId, studentId));
      await tx.delete(educationalReports).where(eq(educationalReports.studentId, studentId));
      await tx.delete(incidents).where(eq(incidents.studentId, studentId));
      await tx.delete(studentConsentRecords).where(eq(studentConsentRecords.studentId, studentId));
      await tx.delete(consentInvitations).where(eq(consentInvitations.studentId, studentId));
      await tx.delete(chatSessions).where(eq(chatSessions.studentId, studentId));
      // Insurance-bridge + utterance-log PHI (added after the original cascade;
      // these student_id columns have no FK cascade, so they must be deleted
      // explicitly or they survive erasure as orphaned PHI — GDPR Art.17).
      await tx.delete(aacUtteranceEvents).where(eq(aacUtteranceEvents.studentId, studentId));
      await tx.delete(lettersOfMedicalNecessity).where(eq(lettersOfMedicalNecessity.studentId, studentId));
      await tx.delete(clinicianActivityIntervals).where(eq(clinicianActivityIntervals.studentId, studentId));
      await tx.delete(boards).where(eq(boards.studentId, studentId));
      await tx.delete(customAppAssignments).where(eq(customAppAssignments.studentId, studentId));
      // Package assignments go through packageLinks, NOT a raw delete: each one
      // holds a refcount on its package, and an orphaned package waiting on this
      // student's last link would otherwise leak forever. Passing `tx` keeps it
      // inside the erasure transaction. See aac-packages-plan.md §1.5.
      await deleteStudentPackageLinks(studentId, tx);
      await tx.delete(studentShareInvites).where(eq(studentShareInvites.studentId, studentId));
      await tx.delete(objectShares).where(eq(objectShares.studentId, studentId));
      await tx.delete(standingShares).where(eq(standingShares.studentId, studentId));
      await tx.delete(studentSymbolAssociations).where(eq(studentSymbolAssociations.studentId, studentId));
      await tx.delete(inviteCodeRedemptions).where(eq(inviteCodeRedemptions.studentId, studentId));
      await tx.delete(studentClassrooms).where(eq(studentClassrooms.studentId, studentId));
      await tx.delete(studentContacts).where(eq(studentContacts.studentId, studentId));
      await tx.delete(instituteStudents).where(eq(instituteStudents.studentId, studentId));
      await tx.delete(userStudents).where(eq(userStudents.studentId, studentId));
      await tx.delete(aacSettings).where(eq(aacSettings.studentId, studentId));
      await tx.delete(aacSessionPlans).where(eq(aacSessionPlans.studentId, studentId));

      // -------- Person facet (person-chat + calls) --------
      // createStudent auto-provisions a persons row for every student (the
      // person-chat identity). Without this block the students delete below
      // fails on persons_student_id_students_id_fk, which silently broke
      // hard-delete for every student. The student's conversational trail is
      // their personal data under Art. 17:
      //   - DIRECT rooms they created go entirely (roomId cascades wipe those
      //     rooms' messages, participants, and call sessions — a 1:1 chat the
      //     student initiated is anchored on them);
      //   - GROUP rooms they created survive for the other members with the
      //     creator nulled (createdByPersonId is write-only provenance —
      //     nothing reads it);
      //   - messages they SENT into surviving rooms are deleted;
      //   - their call-participation rows and calls they initiated are deleted
      //     (callId cascade removes the other participants' rows of those calls);
      //   - finally the persons row itself. Push tokens are user-keyed, not
      //     person-keyed, so none exist for a student facet.
      const [personRow] = await tx.select({ id: persons.id }).from(persons).where(eq(persons.studentId, studentId));
      if (personRow) {
        const personId = personRow.id;
        await tx.delete(personChatRooms).where(
          and(eq(personChatRooms.createdByPersonId, personId), eq(personChatRooms.isDirect, true)),
        );
        await tx.update(personChatRooms)
          .set({ createdByPersonId: null })
          .where(eq(personChatRooms.createdByPersonId, personId));
        await tx.delete(personChats).where(eq(personChats.senderPersonId, personId));
        await tx.delete(callParticipants).where(eq(callParticipants.personId, personId));
        await tx.delete(callSessions).where(eq(callSessions.initiatedByPersonId, personId));
        await tx.delete(personChatRoomParticipants).where(eq(personChatRoomParticipants.personId, personId));
        await tx.delete(persons).where(eq(persons.id, personId));
      }

      // -------- Biometric data — one-to-one via students.biometricDataId --------
      // Pull the row we're about to drop so we can also delete the linked
      // biometric record (FK is on the students side, not a back-ref) and
      // collect the S3 face image key for post-commit cleanup.
      const [studentRow] = await tx.select({ biometricDataId: students.biometricDataId }).from(students).where(eq(students.id, studentId));
      const biometricDataId = studentRow?.biometricDataId ?? null;

      if (biometricDataId) {
        const [bio] = await tx
          .select({ faceImageUrl: biometricData.faceImageUrl })
          .from(biometricData)
          .where(eq(biometricData.id, biometricDataId));
        if (bio?.faceImageUrl) s3KeysToDelete.push(bio.faceImageUrl);
      }

      // -------- The student row itself --------
      await tx.delete(students).where(eq(students.id, studentId));

      if (biometricDataId) {
        await tx.delete(biometricData).where(eq(biometricData.id, biometricDataId));
      }

      activityLogService.log({
        instituteId: instituteId ?? undefined,
        userId: requestedByUserId ?? undefined,
        eventType: "student_erasure_completed",
        subjectType1: "student",
        subjectId1: studentId,
        details: { s3KeysQueued: s3KeysToDelete.length },
      });
    });

    // -------- Post-commit S3 cleanup --------
    // Failures here don't roll back the DB delete: orphaned blobs are
    // unreachable (the row pointing at them is gone) and a future
    // bucket-GC sweep can pick them up. We still log them so ops sees the
    // delta.
    const s3KeysFailed: string[] = [];
    for (const key of s3KeysToDelete) {
      try {
        await s3Service.delete(key);
      } catch (err: any) {
        s3KeysFailed.push(key);
        console.warn(`[studentErasure] S3 delete failed for ${key}:`, err?.message ?? err);
      }
    }
    return { s3KeysFailed };
  }

  /** List students whose hard-delete window has elapsed. The cron uses
   *  this to drive its main loop. */
  async listExpiredErasures(now: Date = new Date(), limit = 100): Promise<{ id: string; instituteIdHint: string | null }[]> {
    const rows = await db
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          isNotNull(students.scheduledHardDeleteAt),
          lte(students.scheduledHardDeleteAt, now),
        ),
      )
      .limit(limit);
    // We don't store instituteId on students directly — the cron will
    // resolve via institute_students at delete time.
    return rows.map((r) => ({ id: r.id, instituteIdHint: null }));
  }
}

export const studentErasureService = new StudentErasureService();

// Internal: event types that are exempt from the activity-log retention cron.
// Exported as a list of strings so the retention cron can `notInArray` against it.
export const ERASURE_AUDIT_EVENT_TYPES = [
  "student_erasure_requested",
  "student_erasure_cancelled",
  "student_erasure_completed",
] as const;
