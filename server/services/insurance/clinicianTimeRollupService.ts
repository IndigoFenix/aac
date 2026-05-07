import { db } from "../../db";
import { and, eq, gte, lte, isNull, inArray, or } from "drizzle-orm";
import {
  clinicianActivityIntervals,
  chatSessions,
  instituteStudents,
  students,
} from "@shared/schema";
import { isSessionBillable } from "./sessionBillability";
import { ACTIVITY_IDLE_CAP_SECONDS } from "./clinicianActivityService";

/**
 * Per-student clinician review-time totals for one billing period. Threshold-
 * free; the regime layer maps `totalMinutes` to a CPT code (98979 / 98980 in
 * us_cpt). `hadInteractive` is the gate used to require ≥1 billable AAC
 * session in the same period — surfaced here so the UI can explain a blocked
 * code without re-querying.
 */
export interface ClinicianTimeStudentRollup {
  studentId: string;
  studentName: string | null;
  /** Sum of effective interval seconds, capped at last_heartbeat + 60s per row. */
  totalSeconds: number;
  /** Number of distinct intervals overlapping the period. */
  intervalCount: number;
  /** Whether at least one billable AAC session occurred for this student in the period. */
  hadInteractive: boolean;
}

export interface ClinicianTimeRollup {
  instituteId: string;
  period: string;
  idleCapSeconds: number;
  students: ClinicianTimeStudentRollup[];
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function periodScanBoundsUtc(period: string): { startUtc: Date; endUtc: Date } {
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const startUtc = new Date(Date.UTC(year, month - 1, 1));
  startUtc.setUTCDate(startUtc.getUTCDate() - 2);
  const endUtc = new Date(Date.UTC(year, month, 1));
  endUtc.setUTCDate(endUtc.getUTCDate() + 2);
  return { startUtc, endUtc };
}

function periodBoundsUtc(period: string): { startUtc: Date; endUtc: Date } {
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const startUtc = new Date(Date.UTC(year, month - 1, 1));
  const endUtc = new Date(Date.UTC(year, month, 1));
  return { startUtc, endUtc };
}

/**
 * Effective end of an interval for time-totalling purposes. Open intervals
 * (no `endedAt`) cap at `last_heartbeat_at + idleCapSeconds`.
 */
export function intervalEffectiveEnd(
  interval: { endedAt: Date | null; lastHeartbeatAt: Date },
  idleCapSeconds = ACTIVITY_IDLE_CAP_SECONDS,
): Date {
  if (interval.endedAt) return interval.endedAt;
  return new Date(interval.lastHeartbeatAt.getTime() + idleCapSeconds * 1000);
}

/**
 * Seconds the interval contributes within [periodStart, periodEnd], using the
 * idle-cap rule for open intervals.
 */
export function clippedIntervalSeconds(
  interval: { startedAt: Date; endedAt: Date | null; lastHeartbeatAt: Date },
  periodStart: Date,
  periodEnd: Date,
  idleCapSeconds = ACTIVITY_IDLE_CAP_SECONDS,
): number {
  const effectiveEnd = intervalEffectiveEnd(interval, idleCapSeconds);
  const clipStart = interval.startedAt < periodStart ? periodStart : interval.startedAt;
  const clipEnd = effectiveEnd > periodEnd ? periodEnd : effectiveEnd;
  if (clipEnd <= clipStart) return 0;
  return Math.floor((clipEnd.getTime() - clipStart.getTime()) / 1000);
}

/**
 * Per-student clinician review-time rollup. Read-only and stateless.
 * @throws Error when `period` is not in YYYY-MM form.
 */
export async function getClinicianTimeRollup(opts: {
  instituteId: string;
  period: string;
}): Promise<ClinicianTimeRollup> {
  if (!PERIOD_PATTERN.test(opts.period)) {
    throw new Error(`Invalid period "${opts.period}", expected YYYY-MM`);
  }

  const { startUtc: scanStart, endUtc: scanEnd } = periodScanBoundsUtc(opts.period);
  const { startUtc: periodStart, endUtc: periodEnd } = periodBoundsUtc(opts.period);

  const enrollments = await db
    .select({
      studentId: instituteStudents.studentId,
      studentName: students.name,
    })
    .from(instituteStudents)
    .innerJoin(students, eq(instituteStudents.studentId, students.id))
    .where(
      and(
        eq(instituteStudents.instituteId, opts.instituteId),
        eq(instituteStudents.isActive, true),
      ),
    );

  if (enrollments.length === 0) {
    return {
      instituteId: opts.instituteId,
      period: opts.period,
      idleCapSeconds: ACTIVITY_IDLE_CAP_SECONDS,
      students: [],
    };
  }

  const studentIds = enrollments.map((e) => e.studentId);
  const nameByStudent = new Map<string, string | null>();
  for (const e of enrollments) nameByStudent.set(e.studentId, e.studentName);

  // Intervals overlapping the period for these students. An interval overlaps
  // when started_at < periodEnd AND (ended_at IS NULL OR ended_at >= periodStart).
  const intervals = await db
    .select({
      studentId: clinicianActivityIntervals.studentId,
      startedAt: clinicianActivityIntervals.startedAt,
      lastHeartbeatAt: clinicianActivityIntervals.lastHeartbeatAt,
      endedAt: clinicianActivityIntervals.endedAt,
    })
    .from(clinicianActivityIntervals)
    .where(
      and(
        inArray(clinicianActivityIntervals.studentId, studentIds),
        eq(clinicianActivityIntervals.instituteId, opts.instituteId),
        lte(clinicianActivityIntervals.startedAt, scanEnd),
        or(
          isNull(clinicianActivityIntervals.endedAt),
          gte(clinicianActivityIntervals.endedAt, scanStart),
        ),
      ),
    );

  // Billable AAC sessions in same period for the hadInteractive flag.
  const aacSessions = await db
    .select({
      studentId: chatSessions.studentId,
      creditsUsed: chatSessions.creditsUsed,
      log: chatSessions.log,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.chatMode, "aac"),
        isNull(chatSessions.deletedAt),
        inArray(chatSessions.studentId, studentIds),
        lte(chatSessions.started, scanEnd),
        gte(chatSessions.lastUpdate, scanStart),
      ),
    );

  const hadInteractive = new Map<string, boolean>();
  for (const s of aacSessions) {
    if (!s.studentId) continue;
    if (!isSessionBillable(s)) continue;
    hadInteractive.set(s.studentId, true);
  }

  const rollups = new Map<string, ClinicianTimeStudentRollup>();
  for (const sid of studentIds) {
    rollups.set(sid, {
      studentId: sid,
      studentName: nameByStudent.get(sid) ?? null,
      totalSeconds: 0,
      intervalCount: 0,
      hadInteractive: hadInteractive.get(sid) === true,
    });
  }

  for (const iv of intervals) {
    if (!iv.studentId) continue;
    const rollup = rollups.get(iv.studentId);
    if (!rollup) continue;
    const seconds = clippedIntervalSeconds(iv, periodStart, periodEnd);
    if (seconds <= 0) continue;
    rollup.totalSeconds += seconds;
    rollup.intervalCount += 1;
  }

  return {
    instituteId: opts.instituteId,
    period: opts.period,
    idleCapSeconds: ACTIVITY_IDLE_CAP_SECONDS,
    students: Array.from(rollups.values()).sort((a, b) =>
      (a.studentName ?? "").localeCompare(b.studentName ?? ""),
    ),
  };
}

// Internal exports for unit tests.
export const __test = {
  intervalEffectiveEnd,
  clippedIntervalSeconds,
  periodBoundsUtc,
};
