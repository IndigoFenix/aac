/**
 * session-sweeper.ts
 *
 * Finalizes ABANDONED sessions — the class of loss found in the 2026-08-06
 * cluster: the app was paused/killed (or the monitor got stuck) instead of
 * closing cleanly, so the close path (final Monitor pass → pending→log drain
 * → summary) never ran. The turns sat in pending_messages forever, invisible
 * to clinicians and deep analysis, with no title/summary and monitorBusy
 * sometimes stuck true. Nothing on the server ever revisited them — until
 * this sweeper.
 *
 * Each tick:
 * 1. BULK-CLOSE bookkeeping: sessions that are already fully finalized
 *    (summary present, nothing pending, monitor idle) but still labeled
 *    status="open" — one UPDATE, no LLM. Heals the historical backlog where
 *    the close path never set status.
 * 2. FINALIZE a small batch of genuinely abandoned sessions: run the missed
 *    final Monitor pass (drains pending→log; clears stale monitorBusy),
 *    generate the summary, and mark the session closed.
 *
 * Guards: never touches a session with a live coordinator (registry +
 * session-cache checks), recent activity (idle threshold > cache TTL +
 * adoption grace), deleted sessions, or CRM landing chats. LLM cost per tick
 * is bounded by the batch size.
 */

import { db } from "../db";
import { chatSessions } from "@shared/schema";
import { and, eq, isNull, isNotNull, lt, gt, ne, or, desc, sql } from "drizzle-orm";
import { dualAgentService } from "./dual-agent/dual-agent-service";
import { getLiveSession } from "./dual-agent/live-session-registry";
import { generateSessionSummary } from "./sessionSummary";

const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const SWEEP_INTERVAL_MS = envNum("AAC_SESSION_SWEEP_INTERVAL_MS", 5 * 60_000);
/** A session is "abandoned" after this much silence. Must exceed the session
 *  cache TTL (30 min) so a resumable session is never finalized under a
 *  client that might still come back. */
const SWEEP_IDLE_MS = envNum("AAC_SESSION_SWEEP_IDLE_MS", 35 * 60_000);
/** Max LLM-involving finalizations per tick. */
const SWEEP_BATCH = envNum("AAC_SESSION_SWEEP_BATCH", 5);
/** Don't resurrect sessions older than this for the LLM path (the bulk
 *  status-close has no age limit — it's free). */
const SWEEP_MAX_AGE_DAYS = envNum("AAC_SESSION_SWEEP_MAX_AGE_DAYS", 30);

const pendingLen = sql<number>`jsonb_array_length(coalesce(${chatSessions.pendingMessages}, '[]'::jsonb))`;

export interface SweepResult {
  bulkClosed: number;
  ancientClosed: number;
  examined: number;
  finalized: number;
}

export async function sweepAbandonedSessionsOnce(now = Date.now()): Promise<SweepResult> {
  const idleCutoff = new Date(now - SWEEP_IDLE_MS);
  const ageFloor = new Date(now - SWEEP_MAX_AGE_DAYS * 86_400_000);

  // 1. Bookkeeping bulk-close: finalized in substance, mislabeled in status.
  const bulk = await db
    .update(chatSessions)
    .set({ status: "closed" })
    .where(and(
      eq(chatSessions.status, "open"),
      isNull(chatSessions.deletedAt),
      isNull(chatSessions.crmPotentialCustomerId),
      lt(chatSessions.lastUpdate, idleCutoff),
      isNotNull(chatSessions.summary),
      ne(chatSessions.summary, ""),
      sql`${pendingLen} = 0`,
      or(isNull(chatSessions.monitorBusy), eq(chatSessions.monitorBusy, false)),
    ))
    .returning({ id: chatSessions.id });

  // 2. Ancient bookkeeping: abandoned sessions past the age floor aren't
  //    worth an LLM resurrection — close them as-is (summary stays null) so
  //    they stop matching. Pure SQL, unbounded, runs once per backlog.
  const ancient = await db
    .update(chatSessions)
    .set({ status: "closed", monitorBusy: false, monitorBusySince: null })
    .where(and(
      eq(chatSessions.status, "open"),
      isNull(chatSessions.deletedAt),
      isNull(chatSessions.crmPotentialCustomerId),
      lt(chatSessions.lastUpdate, ageFloor),
    ))
    .returning({ id: chatSessions.id });

  // 3. Genuinely abandoned and recent enough to matter: pending turns, no
  //    summary, or a stuck monitor. Data-loss sessions (pending > 0) first.
  const rows = await db
    .select({
      id: chatSessions.id,
      studentId: chatSessions.studentId,
      pending: pendingLen,
    })
    .from(chatSessions)
    .where(and(
      eq(chatSessions.status, "open"),
      isNull(chatSessions.deletedAt),
      isNull(chatSessions.crmPotentialCustomerId),
      lt(chatSessions.lastUpdate, idleCutoff),
      gt(chatSessions.lastUpdate, ageFloor),
      or(
        sql`${pendingLen} > 0`,
        isNull(chatSessions.summary),
        eq(chatSessions.summary, ""),
        eq(chatSessions.monitorBusy, true),
      ),
    ))
    .orderBy(desc(sql`${pendingLen} > 0`), desc(chatSessions.lastUpdate))
    .limit(SWEEP_BATCH);

  let finalized = 0;
  for (const row of rows) {
    // Live guards: an active coordinator for the student, or a still-warm
    // session cache entry, means someone may yet resume this session.
    if (row.studentId && getLiveSession(row.studentId)) continue;
    if (dualAgentService.getSessionCache(row.id)) continue;
    try {
      const outcome = row.pending > 0
        ? await dualAgentService.finalizeAbandonedSession(row.id)
        : "no-pending";
      if (outcome !== "notes-disallowed") {
        // Idempotent; also recovers pending→log itself as defense-in-depth
        // if the Monitor drain failed above.
        await generateSessionSummary(row.id);
      }
      await db
        .update(chatSessions)
        .set({ status: "closed", monitorBusy: false, monitorBusySince: null })
        .where(eq(chatSessions.id, row.id));
      finalized++;
      console.log(`[SessionSweeper] finalized abandoned session ${row.id} (${outcome}, pending=${row.pending})`);
    } catch (err) {
      console.error(`[SessionSweeper] failed to finalize ${row.id}:`, err);
    }
  }

  if (bulk.length > 0 || ancient.length > 0 || rows.length > 0) {
    console.log(`[SessionSweeper] tick: bulkClosed=${bulk.length} ancientClosed=${ancient.length} examined=${rows.length} finalized=${finalized}`);
  }
  return { bulkClosed: bulk.length, ancientClosed: ancient.length, examined: rows.length, finalized };
}

let sweeperTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sweep. Called once from server bootstrap; safe to call
 *  again (restarts the timer). Disable with AAC_SESSION_SWEEP_INTERVAL_MS=0
 *  (any non-positive value falls back to the default, so use
 *  AAC_SESSION_SWEEP_DISABLED=true to turn it off). */
export function startSessionSweeper(): void {
  if (process.env.AAC_SESSION_SWEEP_DISABLED === "true") {
    console.log("[SessionSweeper] disabled via AAC_SESSION_SWEEP_DISABLED");
    return;
  }
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = setInterval(() => {
    sweepAbandonedSessionsOnce().catch(err => console.error("[SessionSweeper] tick failed:", err));
  }, SWEEP_INTERVAL_MS);
  // Timers must not keep a short-lived process (scripts, tests) alive.
  sweeperTimer.unref?.();
  console.log(`[SessionSweeper] started (interval=${Math.round(SWEEP_INTERVAL_MS / 1000)}s, idle=${Math.round(SWEEP_IDLE_MS / 60000)}min, batch=${SWEEP_BATCH})`);
}
