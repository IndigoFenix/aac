import { db } from "../../db";
import { and, eq, gte, lte, isNull, inArray } from "drizzle-orm";
import {
  chatSessions,
  students,
  institutes,
  instituteStudents,
  activityLogs,
  type ChatSession,
} from "@shared/schema";
import {
  isSessionBillable,
  BILLABLE_SESSION_RULE_DESCRIPTION,
} from "./sessionBillability";

/**
 * Per-student RTM rollup for a single billing period. Threshold-free:
 * the API surfaces totals only — the regime layer (client) maps daysActive
 * onto a billing code (98977 vs 98985 for us_cpt; other regimes will differ).
 */
export interface RtmStudentRollup {
  studentId: string;
  studentName: string | null;
  /** Distinct local-timezone dates within the period where any billable session was active. */
  daysActive: number;
  /** Total billable session wall-time minus summed sleep windows, in seconds, clipped to the period. */
  serviceSeconds: number;
  /** Number of billable sessions overlapping the period. */
  sessionCount: number;
  /** Earliest billable session start touching the period (UTC ISO), null if none. */
  firstSession: string | null;
  /** Latest billable session lastUpdate touching the period (UTC ISO), null if none. */
  lastSession: string | null;
}

export interface RtmRollup {
  instituteId: string;
  period: string;
  /** IANA timezone used to bucket sessions into local days. Falls back to UTC when unset on the institute. */
  timezone: string;
  /** Human-readable form of the billable-session rule applied. Surfaced in admin UI. */
  rule: string;
  students: RtmStudentRollup[];
}

interface SleepEventRow {
  studentId: string | null;
  createdAt: Date;
  details: unknown;
}

interface SleepWindow {
  start: Date;
  end: Date;
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const SLEEP_TARGET_STATES = new Set(["asleep", "hibernation"]);

/**
 * Get all UTC instants the period [start, end] covers, with a buffer for any
 * institute timezone (max ±14h). Caller filters JS-side using local-date
 * strings — these bounds only limit the DB scan.
 */
function periodScanBoundsUtc(period: string): { startUtc: Date; endUtc: Date } {
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-indexed
  const startUtc = new Date(Date.UTC(year, month - 1, 1));
  startUtc.setUTCDate(startUtc.getUTCDate() - 2);
  const endUtc = new Date(Date.UTC(year, month, 1));
  endUtc.setUTCDate(endUtc.getUTCDate() + 2);
  return { startUtc, endUtc };
}

/**
 * Format a UTC Date as YYYY-MM-DD in the given IANA timezone. en-CA locale
 * produces ISO-shape dates natively, avoiding manual part assembly.
 */
function localDateString(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

/**
 * Walk the [start, end] interval and collect every local date it touches,
 * restricted to the requested period. Hour-step is safe across DST and any
 * timezone offset.
 */
function localDatesInPeriod(
  start: Date,
  end: Date,
  timezone: string,
  period: string,
): string[] {
  if (end <= start) {
    const d = localDateString(start, timezone);
    return d.startsWith(`${period}-`) ? [d] : [];
  }
  const dates = new Set<string>();
  const stepMs = 3600_000;
  let cursorMs = start.getTime();
  const endMs = end.getTime();
  while (cursorMs < endMs) {
    dates.add(localDateString(new Date(cursorMs), timezone));
    cursorMs += stepMs;
  }
  dates.add(localDateString(end, timezone));
  return Array.from(dates).filter((d) => d.startsWith(`${period}-`));
}

/**
 * Build sleep windows from a sorted-by-time stream of state-change events
 * for one student. A "sleep window" opens when the toState enters
 * {asleep, hibernation} and closes at the next transition out.
 *
 * Open windows at the end of the stream (student still asleep when the
 * session terminates uncleanly) are closed at `unclosedClosesAt` so the
 * window has a finite duration. Caller passes the period end or session end.
 */
function buildSleepWindows(
  events: SleepEventRow[],
  unclosedClosesAt: Date,
): SleepWindow[] {
  const windows: SleepWindow[] = [];
  let openStart: Date | null = null;
  for (const ev of events) {
    const details = ev.details as { toState?: string } | null;
    const isSleep = !!details?.toState && SLEEP_TARGET_STATES.has(details.toState);
    if (isSleep) {
      if (openStart === null) openStart = ev.createdAt;
    } else if (openStart !== null) {
      windows.push({ start: openStart, end: ev.createdAt });
      openStart = null;
    }
  }
  if (openStart !== null) {
    windows.push({ start: openStart, end: unclosedClosesAt });
  }
  return windows;
}

/**
 * Total seconds the [a, b] interval overlaps with any window in `windows`.
 * Windows are assumed non-overlapping (state machine guarantees this).
 */
function overlapSeconds(a: Date, b: Date, windows: SleepWindow[]): number {
  if (b <= a) return 0;
  const aMs = a.getTime();
  const bMs = b.getTime();
  let totalMs = 0;
  for (const w of windows) {
    const startMs = Math.max(aMs, w.start.getTime());
    const endMs = Math.min(bMs, w.end.getTime());
    if (endMs > startMs) totalMs += endMs - startMs;
  }
  return Math.floor(totalMs / 1000);
}

type SessionRow = Pick<
  ChatSession,
  "id" | "studentId" | "started" | "lastUpdate" | "creditsUsed" | "log"
>;

/**
 * Compute a per-student RTM rollup for a given period. Stateless / read-only.
 * @throws Error when `period` is not in YYYY-MM form.
 */
export async function getRtmRollup(opts: {
  instituteId: string;
  period: string;
}): Promise<RtmRollup> {
  if (!PERIOD_PATTERN.test(opts.period)) {
    throw new Error(`Invalid period "${opts.period}", expected YYYY-MM`);
  }

  const [inst] = await db
    .select({ timezone: institutes.timezone })
    .from(institutes)
    .where(eq(institutes.id, opts.instituteId))
    .limit(1);
  const timezone = inst?.timezone || "UTC";

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
      timezone,
      rule: BILLABLE_SESSION_RULE_DESCRIPTION,
      students: [],
    };
  }

  const nameByStudentId = new Map<string, string | null>();
  for (const e of enrollments) nameByStudentId.set(e.studentId, e.studentName);
  const studentIds = enrollments.map((e) => e.studentId);

  const { startUtc, endUtc } = periodScanBoundsUtc(opts.period);

  const sessions: SessionRow[] = await db
    .select({
      id: chatSessions.id,
      studentId: chatSessions.studentId,
      started: chatSessions.started,
      lastUpdate: chatSessions.lastUpdate,
      creditsUsed: chatSessions.creditsUsed,
      log: chatSessions.log,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.chatMode, "aac"),
        isNull(chatSessions.deletedAt),
        inArray(chatSessions.studentId, studentIds),
        lte(chatSessions.started, endUtc),
        gte(chatSessions.lastUpdate, startUtc),
      ),
    );

  const sleepEvents: SleepEventRow[] = await db
    .select({
      studentId: activityLogs.subjectId1,
      createdAt: activityLogs.createdAt,
      details: activityLogs.details,
    })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.eventType, "aac_sleep_state_change"),
        eq(activityLogs.subjectType1, "student"),
        inArray(activityLogs.subjectId1, studentIds),
        gte(activityLogs.createdAt, startUtc),
        lte(activityLogs.createdAt, endUtc),
      ),
    );

  const sleepEventsByStudent = new Map<string, SleepEventRow[]>();
  for (const ev of sleepEvents) {
    if (!ev.studentId) continue;
    const arr = sleepEventsByStudent.get(ev.studentId) ?? [];
    arr.push(ev);
    sleepEventsByStudent.set(ev.studentId, arr);
  }
  for (const arr of sleepEventsByStudent.values()) {
    arr.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  const sleepWindowsByStudent = new Map<string, SleepWindow[]>();
  for (const [sid, evs] of sleepEventsByStudent.entries()) {
    sleepWindowsByStudent.set(sid, buildSleepWindows(evs, endUtc));
  }

  const rollupsByStudent = new Map<string, RtmStudentRollup>();
  for (const sid of studentIds) {
    rollupsByStudent.set(sid, {
      studentId: sid,
      studentName: nameByStudentId.get(sid) ?? null,
      daysActive: 0,
      serviceSeconds: 0,
      sessionCount: 0,
      firstSession: null,
      lastSession: null,
    });
  }

  const activeDaysByStudent = new Map<string, Set<string>>();

  for (const session of sessions) {
    if (!session.studentId) continue;
    if (!isSessionBillable(session)) continue;
    const rollup = rollupsByStudent.get(session.studentId);
    if (!rollup) continue;

    const started = session.started instanceof Date ? session.started : new Date(session.started as unknown as string);
    const lastUpdate = session.lastUpdate instanceof Date ? session.lastUpdate : new Date(session.lastUpdate as unknown as string);

    // Clip to scan bounds; days bucketing further filters by period below.
    const clipStart = started < startUtc ? startUtc : started;
    const clipEnd = lastUpdate > endUtc ? endUtc : lastUpdate;
    if (clipEnd <= clipStart) continue;

    const wallSeconds = Math.floor((clipEnd.getTime() - clipStart.getTime()) / 1000);
    const sleepSeconds = overlapSeconds(
      clipStart,
      clipEnd,
      sleepWindowsByStudent.get(session.studentId) ?? [],
    );
    const billableSeconds = Math.max(0, wallSeconds - sleepSeconds);

    rollup.serviceSeconds += billableSeconds;
    rollup.sessionCount += 1;

    if (!rollup.firstSession || started.toISOString() < rollup.firstSession) {
      rollup.firstSession = started.toISOString();
    }
    if (!rollup.lastSession || lastUpdate.toISOString() > rollup.lastSession) {
      rollup.lastSession = lastUpdate.toISOString();
    }

    const dates = localDatesInPeriod(clipStart, clipEnd, timezone, opts.period);
    if (dates.length > 0) {
      const set = activeDaysByStudent.get(session.studentId) ?? new Set<string>();
      for (const d of dates) set.add(d);
      activeDaysByStudent.set(session.studentId, set);
    }
  }

  for (const [sid, set] of activeDaysByStudent.entries()) {
    const rollup = rollupsByStudent.get(sid);
    if (rollup) rollup.daysActive = set.size;
  }

  return {
    instituteId: opts.instituteId,
    period: opts.period,
    timezone,
    rule: BILLABLE_SESSION_RULE_DESCRIPTION,
    students: Array.from(rollupsByStudent.values()).sort((a, b) =>
      (a.studentName ?? "").localeCompare(b.studentName ?? ""),
    ),
  };
}

// Internal exports for unit tests.
export const __test = {
  buildSleepWindows,
  overlapSeconds,
  localDateString,
  localDatesInPeriod,
  periodScanBoundsUtc,
};
