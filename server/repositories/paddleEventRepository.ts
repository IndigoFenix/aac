// server/repositories/paddleEventRepository.ts
//
// Data access for `paddle_events` — the idempotency ledger behind
// POST /api/paddle/webhook. See the table comment in shared/schema.ts.
//
// Two jobs, and both of them are correctness rather than bookkeeping:
//   1. claimEvent() is the replay guard. The INSERT is what claims an event
//      id; a conflict means we have seen it before and the caller must decide
//      from the EXISTING row's status whether to re-run fulfillment.
//   2. lastProcessedOccurredAtForSubscription() is the out-of-order guard.
//      Paddle does not promise delivery order, so a stale `subscription.updated`
//      can land after the `subscription.canceled` that superseded it.

import {
  paddleEvents,
  type PaddleEvent,
  type PaddleEventStatus,
} from "@shared/schema";
import { db } from "../db";
import { and, desc, eq, sql } from "drizzle-orm";

export interface ClaimEventInput {
  id: string;
  eventType: string;
  occurredAt: Date;
  payload?: unknown;
}

export interface ClaimEventResult {
  /** True when THIS call inserted the row, i.e. the event is new to us. */
  claimed: boolean;
  /** The row as it now stands — freshly inserted, or the pre-existing one. */
  row: PaddleEvent;
}

export class PaddleEventRepository {
  /**
   * Insert the event as `received`, or report the row that already exists.
   *
   * `onConflictDoNothing` + a second read is deliberate: an ON CONFLICT DO
   * UPDATE would overwrite the status of an event we already processed, which
   * is precisely the state the caller needs to see in order NOT to grant the
   * credits twice.
   */
  async claimEvent(input: ClaimEventInput): Promise<ClaimEventResult> {
    const [inserted] = await db
      .insert(paddleEvents)
      .values({
        id: input.id,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        status: "received" satisfies PaddleEventStatus,
        payload: (input.payload ?? null) as PaddleEvent["payload"],
      })
      .onConflictDoNothing({ target: paddleEvents.id })
      .returning();

    if (inserted) return { claimed: true, row: inserted };

    const existing = await this.getEvent(input.id);
    // Cannot happen without a concurrent DELETE; treat as claimed so the
    // caller processes rather than silently dropping a paid transaction.
    if (!existing) return { claimed: true, row: { ...input, status: "received" } as PaddleEvent };
    return { claimed: false, row: existing };
  }

  async getEvent(id: string): Promise<PaddleEvent | undefined> {
    const [row] = await db.select().from(paddleEvents).where(eq(paddleEvents.id, id));
    return row || undefined;
  }

  /** Move a row to a terminal status. `error` doubles as the ignore reason. */
  async setStatus(
    id: string,
    status: PaddleEventStatus,
    error?: string | null,
  ): Promise<PaddleEvent | undefined> {
    const [row] = await db
      .update(paddleEvents)
      .set({
        status,
        error: error ?? null,
        processedAt: status === "received" ? null : new Date(),
      })
      .where(eq(paddleEvents.id, id))
      .returning();
    return row || undefined;
  }

  /** Re-open a previously FAILED row so a Paddle retry can be processed again. */
  async reopenFailed(id: string): Promise<void> {
    await db
      .update(paddleEvents)
      .set({ status: "received", error: null, processedAt: null })
      .where(and(eq(paddleEvents.id, id), eq(paddleEvents.status, "failed")));
  }

  /**
   * The `occurred_at` of the newest subscription event we have already APPLIED
   * for this subscription, or null if there is none.
   *
   * The subscription id is read out of the stored payload (`data.id`) rather
   * than a column of its own: only subscription events have one, and a nullable
   * column that is meaningful for a third of the rows buys nothing over a jsonb
   * read at this table's volume (a handful of rows per customer per month).
   * Only `processed` rows count — an ignored or failed event applied nothing,
   * so it must not block the event that follows it.
   */
  async lastProcessedOccurredAtForSubscription(
    subscriptionId: string,
  ): Promise<Date | null> {
    // ORDER BY … LIMIT 1 rather than max(occurred_at), and that is not a
    // stylistic choice. `occurred_at` is `timestamp` WITHOUT time zone; drizzle
    // applies the column's own decoder to a selected COLUMN, but a raw
    // aggregate expression comes back as an unparsed string ("2026-09-05
    // 00:00:00") which `new Date(...)` then reads as LOCAL time. On a UTC+3
    // machine that silently moved every comparison three hours, so a
    // legitimately newer event could be discarded as stale. Selecting the
    // column keeps the decoder in the path.
    const [row] = await db
      .select({ occurredAt: paddleEvents.occurredAt })
      .from(paddleEvents)
      .where(
        and(
          eq(paddleEvents.status, "processed"),
          sql`${paddleEvents.eventType} LIKE 'subscription.%'`,
          sql`${paddleEvents.payload} -> 'data' ->> 'id' = ${subscriptionId}`,
        ),
      )
      .orderBy(desc(paddleEvents.occurredAt))
      .limit(1);
    return row?.occurredAt ?? null;
  }
}

export const paddleEventRepository = new PaddleEventRepository();
