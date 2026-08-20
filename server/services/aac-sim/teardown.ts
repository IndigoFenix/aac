/**
 * teardown.ts — CLOSING A SIM SESSION PROPERLY.
 *
 * A harness run was leaving its sessions ABANDONED rather than closed, and the
 * abandoned-session sweeper was reaping them ~35 minutes later. That is exactly
 * the loss class the sweeper exists to clean up after (`session-sweeper.ts`),
 * so the harness was manufacturing the very problem the product had to build a
 * cron job to survive.
 *
 * WHY IT HAPPENED — two deliberate product behaviours, both wrong for a sim:
 *
 *  ⓵ SOCKET LOSS DETACHES. A ready session whose socket drops is kept WARM for
 *    a grace window in case the client reconnects (`handleSocketLoss` →
 *    adoption). A sim run never reconnects, so the warm window is pure waste and
 *    the session never tears down.
 *
 *  ⓶ FINALIZATION IS DEFERRED. Even on a real teardown, `cleanup()` schedules
 *    the Monitor drain + summary `FINALIZATION_GRACE_MS` later (120s), so a
 *    quick reconnect does not pay for a full close per drop. A script that
 *    exits immediately kills that timer before it fires.
 *
 * Both are env-switchable in the product, and a sim genuinely wants the other
 * setting for both — so this flips them rather than working around them.
 *
 * ⚠️ MUST BE CALLED BEFORE the coordinator module is imported. Both values are
 * read once into `static readonly` fields at class-definition time, so setting
 * them afterwards does nothing at all — silently. Scripts call this at the top,
 * before their dynamic imports.
 */

export interface SimTeardownOptions {
  /** Leave adoption on (a scenario deliberately testing reconnect). */
  keepSocketAdoption?: boolean;
  /** Finalization delay in ms. 0 = finalize the moment the session closes. */
  finalizationGraceMs?: number;
}

export function configureSimTeardown(opts: SimTeardownOptions = {}): void {
  const { keepSocketAdoption = false, finalizationGraceMs = 0 } = opts;
  if (!keepSocketAdoption) process.env.AAC_SOCKET_ADOPTION = "false";
  process.env.AAC_FINALIZATION_GRACE_MS = String(finalizationGraceMs);
}

/**
 * How long to let a closing session finish before killing the process.
 *
 * Finalization is real work — a final Monitor pass and a summary, both LLM
 * calls — and `cleanup()` fires it FIRE-AND-FORGET, returning immediately. So
 * exiting when cleanup returns cuts it off mid-flight and leaves the session
 * abandoned anyway, just for a different reason. Measured at 25 s: not enough.
 */
export const DEFAULT_DRAIN_MS = 90_000;

/**
 * Close a session and wait for its finalization to land.
 *
 * ⚠️ WHAT "CLOSED" MEANS HERE IS NOT `status`. The close path does not set
 * `chat_sessions.status` at all — the abandoned-session sweeper does, in its
 * bulk-close bookkeeping pass ("sessions that are already fully finalized …
 * but still labeled status=open — heals the historical backlog where the close
 * path never set status", `session-sweeper.ts`). So a perfectly closed session
 * still reads `open` until the sweeper next runs, and polling `status` would
 * time out on every single run, healthy or not.
 *
 * What the close path DOES produce is the final Monitor pass's output: a
 * SUMMARY. That is what this waits for.
 *
 * A session with no conversation in it has nothing to summarize and will never
 * grow one — so an empty run returns `summarized: false` without that being a
 * fault. The distinction the caller cares about is whether finalization was cut
 * off mid-flight, and `turns` tells them whether there was anything to cut off.
 */
export async function endSimSession(
  session: { sessionId: string; dispose(): void },
  opts: { drainMs?: number; onLine?: (s: string) => void; expectSummary?: boolean } = {},
): Promise<{ summarized: boolean; status: string | null; waitedMs: number }> {
  const { drainMs = DEFAULT_DRAIN_MS, onLine = () => {}, expectSummary = true } = opts;
  const startedAt = Date.now();

  // Fires the final Monitor pass. It is FIRE-AND-FORGET inside the coordinator,
  // so this returns long before the pass finishes.
  session.dispose();
  if (!session.sessionId) return { summarized: false, status: null, waitedMs: 0 };

  const { db } = await import("../../db.js");
  const { chatSessions } = await import("@shared/schema-private");
  const { eq } = await import("drizzle-orm");

  let status: string | null = null;
  while (Date.now() - startedAt < drainMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const [row] = await db
      .select({ status: chatSessions.status, summary: chatSessions.summary })
      .from(chatSessions)
      .where(eq(chatSessions.id, session.sessionId));
    status = row?.status ?? null;
    if (row?.summary) {
      return { summarized: true, status, waitedMs: Date.now() - startedAt };
    }
    if (!expectSummary) break;
  }

  if (expectSummary) {
    onLine(
      `note: session ${session.sessionId.slice(0, 8)} produced no summary in ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s. Expected for a session with no ` +
        `conversation in it; otherwise the final Monitor pass was cut short.`,
    );
  }
  return { summarized: false, status, waitedMs: Date.now() - startedAt };
}
