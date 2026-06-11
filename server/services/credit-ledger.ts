// server/services/credit-ledger.ts
//
// Shared low-level writer for the usage-cost ledger. One charge fans out to
// every entity that exists for the call: the chat session row, the student,
// the user, and the user↔student relationship. This is the single place all
// LLM/TTS usage cost lands — `DualAgentService.persistCreditCharge` and the
// standalone services (session summary, symbol refinement, interpretation,
// photo analysis, deep analysis) all funnel through here.
//
// Charges are best-effort: a ledger failure is logged but never breaks the
// calling flow.

import { db } from "../db";
import { chatSessions, students, users, userStudents } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { creditsForModelUsage } from "./chat/cost-helpers";
import type { LLMProviderKey } from "@shared/llm-options";

export interface LedgerCharge {
  sessionId?: string | null;
  studentId?: string | null;
  userId?: string | null;
  credits: number;
  /**
   * Function type for the session's cost_breakdown JSONB — e.g. "chat",
   * "observer", "tts", "session-summary". Ignored when sessionId is absent.
   * For a charge spanning several function types, pass `breakdown` instead
   * (per-type amounts that sum to `credits`).
   */
  category?: string;
  breakdown?: Record<string, number>;
  /** Human-readable attribution for the cost log line (e.g. "session-summary"). */
  label: string;
}

export async function chargeCreditsToLedger(charge: LedgerCharge): Promise<void> {
  const { sessionId, studentId, userId, credits, label } = charge;
  if (!(credits > 0)) return;
  try {
    if (sessionId) {
      await db
        .update(chatSessions)
        .set({ creditsUsed: sql`${chatSessions.creditsUsed} + ${credits}`, lastUpdate: new Date() })
        .where(eq(chatSessions.id, sessionId));

      // Per-function-type breakdown. Each key increments atomically so
      // concurrent charges to the same session can't lose updates. An empty
      // or all-zero breakdown falls back to the single-category shape so
      // creditsUsed and the breakdown keys can't drift apart.
      const hasBreakdown = charge.breakdown && Object.values(charge.breakdown).some(v => v > 0);
      const breakdown = hasBreakdown ? charge.breakdown! : { [charge.category ?? "other"]: credits };
      for (const [category, amount] of Object.entries(breakdown)) {
        if (!(amount > 0)) continue;
        await db
          .update(chatSessions)
          .set({
            costBreakdown: sql`jsonb_set(
              COALESCE(${chatSessions.costBreakdown}, '{}'::jsonb),
              ARRAY[${category}],
              to_jsonb(COALESCE((${chatSessions.costBreakdown}->>${category})::double precision, 0) + ${amount}),
              true
            )`,
          })
          .where(eq(chatSessions.id, sessionId));
      }
    }

    if (studentId) {
      await db
        .update(students)
        .set({ chatCreditsUsed: sql`${students.chatCreditsUsed} + ${credits}`, chatCreditsUpdated: new Date() })
        .where(eq(students.id, studentId));
    }

    if (userId) {
      await db
        .update(users)
        .set({ chatCreditsUsed: sql`${users.chatCreditsUsed} + ${credits}`, chatCreditsUpdated: new Date() })
        .where(eq(users.id, userId));
    }

    if (studentId && userId) {
      await db
        .update(userStudents)
        .set({
          chatCreditsUsed: sql`${userStudents.chatCreditsUsed} + ${credits}`,
          chatCreditsUpdated: new Date(),
        })
        .where(and(
          eq(userStudents.userId, userId),
          eq(userStudents.studentId, studentId),
          eq(userStudents.isActive, true)
        ));
    }

    console.log(`[CreditLedger] Tracked ${credits.toFixed(6)} credits (${label})`);
  } catch (error) {
    console.error(`[CreditLedger] Error tracking credits (${label}):`, error);
  }
}

/**
 * Convenience: compute credits for one HTTP completion from the model
 * catalog and charge them. Token semantics match `creditsForModelUsage`.
 */
export async function chargeModelUsage(opts: {
  provider: LLMProviderKey;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  sessionId?: string | null;
  studentId?: string | null;
  userId?: string | null;
  category?: string;
  label: string;
}): Promise<void> {
  const credits = creditsForModelUsage(
    opts.provider,
    opts.model,
    opts.promptTokens,
    opts.completionTokens,
    opts.cachedTokens ?? 0,
    opts.cacheCreationTokens ?? 0,
  );
  await chargeCreditsToLedger({
    sessionId: opts.sessionId,
    studentId: opts.studentId,
    userId: opts.userId,
    credits,
    category: opts.category,
    label: `${opts.label} model=${opts.model} prompt=${opts.promptTokens} completion=${opts.completionTokens}`
      + (opts.cachedTokens ? ` cacheRead=${opts.cachedTokens}` : "")
      + (opts.cacheCreationTokens ? ` cacheWrite=${opts.cacheCreationTokens}` : ""),
  });
}
