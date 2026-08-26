// server/services/sharing/audit.ts
//
// Read-access logging for PHI reads that are NOT covered by ownership.
//
// Two principals fire `view` rows here:
//
//   - An INSTITUTE principal seeing rows that aren't its own — rows visible
//     only because of a per-object or standing share. Owned-row reads are
//     covered separately by the per-request read audit
//     (server/middleware/phi-read-audit.ts), which is what makes "who looked
//     at this student" answerable at all.
//
//   - An ADMIN principal (system admin / backoffice). Admins own nothing, so
//     EVERY row they read is a cross-boundary read and is logged with
//     `details.viaAdmin`. Until 2026-08-26 this function returned early for
//     admin principals under a comment promising a "separate system-admin
//     audit" — which did not exist. The most privileged reader left no trail.
//
// A student principal is the subject and does not fire entries.
//
// Fire-and-forget: never await, never throw — matches activityLogService.log.

import { activityLogService } from "../activityLogService";
import type { ActivitySubjectType } from "@shared/schema";
import type { AccessCtx } from "./visibility";

export interface AuditableRow {
  id: string;
  studentId: string;
  instituteId: string | null;
}

/**
 * Fire `view` activity-log entries for the rows in `rows` that the principal
 * does not own: share-derived rows for an institute principal, all rows for an
 * admin principal.
 *
 * Caller passes the rows actually returned to the user/AI after the visibility
 * filter has run.
 *
 * @param ctx - the access principal making the read
 * @param subjectType - the activity-log subject type (one of the
 *   `activity_subject_type` enum values; `incident`, `monitor_note` and
 *   `custom_app_assignment` are all in the enum).
 * @param rows - the rows that were returned. Empty array is a no-op.
 */
export function recordShareDerivedView(
  ctx: AccessCtx,
  subjectType: ActivitySubjectType,
  rows: AuditableRow[],
): void {
  if (rows.length === 0) return;

  if (ctx.kind === "admin") {
    for (const row of rows) {
      activityLogService.log({
        userId: ctx.userId ?? null,
        instituteId: row.instituteId,
        eventType: "view",
        subjectType1: subjectType,
        subjectId1: row.id,
        subjectType2: "student",
        subjectId2: row.studentId,
        details: { viaAdmin: true },
      });
    }
    return;
  }

  if (ctx.kind !== "institute") return;

  for (const row of rows) {
    if (row.instituteId === ctx.instituteId) continue;
    activityLogService.log({
      userId: ctx.userId,
      instituteId: ctx.instituteId, // viewing institute — not the owner
      eventType: "view",
      subjectType1: subjectType,
      subjectId1: row.id,
      subjectType2: "student",
      subjectId2: row.studentId,
      details: {
        ownerInstituteId: row.instituteId,
        viaShare: true,
      },
    });
  }
}

/**
 * Convenience for single-row reads. Equivalent to passing `[row]` (or nothing
 * when row is undefined/null).
 */
export function recordShareDerivedViewSingle(
  ctx: AccessCtx,
  subjectType: ActivitySubjectType,
  row: AuditableRow | undefined | null,
): void {
  if (!row) return;
  recordShareDerivedView(ctx, subjectType, [row]);
}
