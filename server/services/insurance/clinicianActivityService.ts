import { db } from "../../db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { clinicianActivityIntervals } from "@shared/schema";
import { activityLogService } from "../activityLogService";

/**
 * Maximum gap between heartbeats before the interval is considered stale and
 * a new one must be opened. Mirrors the client-side idle threshold and is the
 * cap applied to `last_heartbeat_at` when computing totals.
 */
export const ACTIVITY_IDLE_CAP_SECONDS = 60;

interface HeartbeatOpts {
  userId: string;
  studentId: string | null;
  instituteId: string | null;
}

/**
 * Record an activity heartbeat. Extends the user's currently-open interval if
 * the gap is within tolerance and the student/institute context hasn't
 * changed; otherwise closes the stale interval and opens a new one.
 *
 * Returns the id of the now-current open interval.
 */
export async function recordHeartbeat(opts: HeartbeatOpts): Promise<string> {
  const now = new Date();

  const [open] = await db
    .select({
      id: clinicianActivityIntervals.id,
      studentId: clinicianActivityIntervals.studentId,
      instituteId: clinicianActivityIntervals.instituteId,
      lastHeartbeatAt: clinicianActivityIntervals.lastHeartbeatAt,
    })
    .from(clinicianActivityIntervals)
    .where(
      and(
        eq(clinicianActivityIntervals.userId, opts.userId),
        isNull(clinicianActivityIntervals.endedAt),
      ),
    )
    .orderBy(desc(clinicianActivityIntervals.lastHeartbeatAt))
    .limit(1);

  if (open) {
    const gapMs = now.getTime() - open.lastHeartbeatAt.getTime();
    const sameStudent = (open.studentId ?? null) === (opts.studentId ?? null);
    const sameInstitute = (open.instituteId ?? null) === (opts.instituteId ?? null);

    if (gapMs <= ACTIVITY_IDLE_CAP_SECONDS * 1000 && sameStudent && sameInstitute) {
      await db
        .update(clinicianActivityIntervals)
        .set({ lastHeartbeatAt: now })
        .where(eq(clinicianActivityIntervals.id, open.id));
      return open.id;
    }

    // Context changed or gap too long — close at the idle cap.
    const cappedEnd = new Date(
      open.lastHeartbeatAt.getTime() + ACTIVITY_IDLE_CAP_SECONDS * 1000,
    );
    const endedAt = cappedEnd < now ? cappedEnd : now;
    await db
      .update(clinicianActivityIntervals)
      .set({ endedAt })
      .where(eq(clinicianActivityIntervals.id, open.id));
  }

  const [inserted] = await db
    .insert(clinicianActivityIntervals)
    .values({
      userId: opts.userId,
      studentId: opts.studentId,
      instituteId: opts.instituteId,
      startedAt: now,
      lastHeartbeatAt: now,
    } as any)
    .returning({ id: clinicianActivityIntervals.id });

  // Audit: a new review interval opened. Heartbeat extensions are NOT logged
  // — they're high-frequency telemetry, not audit events. Only emit when
  // there's a student in scope (institute-level intervals aren't billable).
  if (opts.studentId) {
    activityLogService.log({
      userId: opts.userId,
      instituteId: opts.instituteId,
      eventType: "rtm_review_recorded",
      subjectType1: "student",
      subjectId1: opts.studentId,
      details: { intervalId: inserted.id },
    });
  }

  return inserted.id;
}

/**
 * Close the user's currently-open interval, if any. Used by the tab-close
 * beacon — `tabClosed = true` lets us distinguish "user closed the tab" from
 * server-side timeouts in audit data.
 */
export async function closeOpenInterval(
  userId: string,
  tabClosed: boolean,
): Promise<void> {
  await db
    .update(clinicianActivityIntervals)
    .set({ endedAt: sql`now()`, tabClosed })
    .where(
      and(
        eq(clinicianActivityIntervals.userId, userId),
        isNull(clinicianActivityIntervals.endedAt),
      ),
    );
}
