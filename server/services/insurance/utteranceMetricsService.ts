import { db } from "../../db";
import { and, eq, gte, lte, isNull } from "drizzle-orm";
import { aacUtteranceEvents, chatSessions, activityLogs } from "@shared/schema";
import { isSessionBillable } from "./sessionBillability";
import type { LmnUtteranceMetricsSnapshot } from "@shared/insurance-lmn-types";

/**
 * Communication metrics computed over an utterance window. Snapshotted into
 * an LMN at draft creation so reprints quote the same numbers regardless of
 * later activity. Same shape as the LMN snapshot type — kept identical so
 * the snapshot column is a verbatim copy.
 */
export type UtteranceMetrics = LmnUtteranceMetricsSnapshot;

const SLEEP_TARGET_STATES = new Set(["asleep", "hibernation"]);

interface SleepWindow {
  start: Date;
  end: Date;
}

function buildSleepWindows(
  events: { createdAt: Date; details: unknown }[],
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

/**
 * Tokenize utterance text into lowercase words. Picks up Latin, Hebrew, Arabic,
 * and CJK characters — same character class the utterance logger uses, kept
 * symmetric so wordCount stored at insert time matches what we recompute here.
 */
export function tokenizeUtterance(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /[a-zà-ÿא-תء-ي一-鿿]/i.test(w))
    .map((w) => w.replace(/[^\p{Letter}\p{Number}'-]/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * Compute communication metrics for a student over the trailing `windowDays`.
 * Returns zero-valued metrics when no utterances exist (caller can detect
 * this and surface a "no AAC activity yet" hint in the LMN draft).
 */
export async function getUtteranceMetrics(opts: {
  studentId: string;
  windowDays?: number;
  endAt?: Date;
}): Promise<UtteranceMetrics> {
  const windowDays = opts.windowDays ?? 30;
  const endAt = opts.endAt ?? new Date();
  const startAt = new Date(endAt.getTime() - windowDays * 24 * 3600 * 1000);

  const utterances = await db
    .select({
      text: aacUtteranceEvents.text,
      wordCount: aacUtteranceEvents.wordCount,
    })
    .from(aacUtteranceEvents)
    .where(
      and(
        eq(aacUtteranceEvents.studentId, opts.studentId),
        gte(aacUtteranceEvents.recordedAt, startAt),
        lte(aacUtteranceEvents.recordedAt, endAt),
      ),
    );

  const utteranceCount = utterances.length;
  const totalWords = utterances.reduce((acc, u) => acc + (u.wordCount ?? 0), 0);
  const mlu = utteranceCount > 0 ? totalWords / utteranceCount : 0;

  const uniqueTokens = new Set<string>();
  for (const u of utterances) {
    for (const tok of tokenizeUtterance(u.text)) uniqueTokens.add(tok);
  }
  const ndw = uniqueTokens.size;

  const sessions = await db
    .select({
      started: chatSessions.started,
      lastUpdate: chatSessions.lastUpdate,
      creditsUsed: chatSessions.creditsUsed,
      log: chatSessions.log,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.studentId, opts.studentId),
        eq(chatSessions.chatMode, "aac"),
        isNull(chatSessions.deletedAt),
        lte(chatSessions.started, endAt),
        gte(chatSessions.lastUpdate, startAt),
      ),
    );

  const sleepEvents = await db
    .select({
      createdAt: activityLogs.createdAt,
      details: activityLogs.details,
    })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.eventType, "aac_sleep_state_change"),
        eq(activityLogs.subjectType1, "student"),
        eq(activityLogs.subjectId1, opts.studentId),
        gte(activityLogs.createdAt, startAt),
        lte(activityLogs.createdAt, endAt),
      ),
    );
  const sleepWindows = buildSleepWindows(
    [...sleepEvents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    endAt,
  );

  let totalActiveSeconds = 0;
  for (const s of sessions) {
    if (!isSessionBillable(s)) continue;
    const started = s.started instanceof Date ? s.started : new Date(s.started as unknown as string);
    const lastUpdate = s.lastUpdate instanceof Date ? s.lastUpdate : new Date(s.lastUpdate as unknown as string);
    const clipStart = started < startAt ? startAt : started;
    const clipEnd = lastUpdate > endAt ? endAt : lastUpdate;
    if (clipEnd <= clipStart) continue;
    const wall = Math.floor((clipEnd.getTime() - clipStart.getTime()) / 1000);
    const sleep = overlapSeconds(clipStart, clipEnd, sleepWindows);
    totalActiveSeconds += Math.max(0, wall - sleep);
  }

  const communicationRatePerMin =
    totalActiveSeconds > 0 ? utteranceCount / (totalActiveSeconds / 60) : 0;

  return {
    windowStart: startAt.toISOString(),
    windowEnd: endAt.toISOString(),
    utteranceCount,
    totalWords,
    mlu: Math.round(mlu * 100) / 100,
    ndw,
    totalActiveSeconds,
    communicationRatePerMin: Math.round(communicationRatePerMin * 100) / 100,
  };
}
