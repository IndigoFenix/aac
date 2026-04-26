// server/services/sharing/audit.ts
//
// Read-access logging for the cross-institute share model. Fires `view` activity
// log entries when an institute principal sees rows that aren't their own —
// i.e. rows visible only because of a per-object or standing share. Same idea
// as the HIPAA "access log" requirement: every cross-institute read of PHI is
// recorded for audit.
//
// We log only **share-derived** rows (rows whose `instituteId` differs from
// `ctx.instituteId`). Owned-row reads aren't audit-relevant under the share
// model — the owning institute always has access by ownership, not by grant.
//
// Student and admin principals don't fire log entries: the student principal is
// the subject, and admin reads are tracked separately in the system-admin
// audit (out of scope here).
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
 * Fire `view` activity-log entries for any share-derived rows in `rows`.
 *
 * Caller passes the rows actually returned to the user/AI after the visibility
 * filter has run. We partition them by `instituteId === ctx.instituteId` and
 * log only the cross-institute reads.
 *
 * @param ctx - the access principal making the read
 * @param subjectType - the activity-log subject type (must be one of the
 *   enum values in `activity_subject_type`). Note: `incident`, `monitor_note`,
 *   and `custom_app_assignment` are NOT yet in that enum — callers for those
 *   types should be deferred until a follow-up migration extends the enum.
 * @param rows - the rows that were returned. Empty array is a no-op.
 */
export function recordShareDerivedView(
  ctx: AccessCtx,
  subjectType: ActivitySubjectType,
  rows: AuditableRow[],
): void {
  if (ctx.kind !== "institute" || rows.length === 0) return;

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
