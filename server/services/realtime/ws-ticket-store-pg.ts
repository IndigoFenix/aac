// Postgres-backed replay set for WebSocket-upgrade tickets.
//
// `INSERT … ON CONFLICT DO NOTHING RETURNING` is atomic in Postgres, so exactly
// one task — whichever lands first — gets the row back and accepts the ticket.
// Every other task sees no row and refuses. That is what makes "single use"
// hold across the 2–10 tasks of the hipaa profile; the in-process Map in
// ws-ticket.ts only ever held it per task.
//
// Rows live ~TICKET_TTL_MS. They are pruned opportunistically on each redeem
// (one small DELETE per WebSocket connection), so the table never needs a cron.

import { lt } from "drizzle-orm";
import { db } from "../../db";
import { wsTicketNonces } from "@shared/schema";
import type { NonceStore } from "./ws-ticket";

export const pgNonceStore: NonceStore = {
  async consume(nonce, expiresAt, now) {
    const inserted = await db
      .insert(wsTicketNonces)
      .values({ nonce, expiresAt: new Date(expiresAt) })
      .onConflictDoNothing()
      .returning({ nonce: wsTicketNonces.nonce });

    // Fire-and-forget prune; a failure here must never block a handshake.
    db.delete(wsTicketNonces)
      .where(lt(wsTicketNonces.expiresAt, new Date(now)))
      .catch((err) => console.error("[ws-ticket] prune failed:", err));

    return inserted.length === 1;
  },
};
