/**
 * The Postgres replay set behind WebSocket-upgrade tickets.
 *
 * The in-process set (ws-ticket.test.ts) proves the ticket format; THIS proves
 * the property that matters under the multi-task hipaa profile — a nonce is
 * accepted exactly once across every process sharing the table, because the
 * insert is atomic. Two callers racing on the same nonce must see one true
 * and one false, never two trues.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { randomBytes } from "node:crypto";
import { lt, eq } from "drizzle-orm";

import { db } from "../helpers/db.js";
import { wsTicketNonces } from "@shared/schema";
import { pgNonceStore } from "../../services/realtime/ws-ticket-store-pg.js";
import { mintWsTicket, redeemWsTicket, TICKET_TTL_MS } from "../../services/realtime/ws-ticket.js";

const nonce = () => randomBytes(16).toString("base64url");

describe("pgNonceStore", () => {
  afterEach(async () => {
    await db.delete(wsTicketNonces);
  });

  it("accepts a nonce once and refuses it thereafter", async () => {
    const now = Date.now();
    const n = nonce();
    expect(await pgNonceStore.consume(n, now + TICKET_TTL_MS, now)).toBe(true);
    expect(await pgNonceStore.consume(n, now + TICKET_TTL_MS, now)).toBe(false);
    expect(await pgNonceStore.consume(n, now + TICKET_TTL_MS, now)).toBe(false);
  });

  it("two concurrent redemptions of the same nonce yield exactly one success", async () => {
    // Simulates two ECS tasks receiving the same replayed ticket at once.
    const now = Date.now();
    const n = nonce();
    const results = await Promise.all([
      pgNonceStore.consume(n, now + TICKET_TTL_MS, now),
      pgNonceStore.consume(n, now + TICKET_TTL_MS, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("distinct nonces are independent", async () => {
    const now = Date.now();
    expect(await pgNonceStore.consume(nonce(), now + TICKET_TTL_MS, now)).toBe(true);
    expect(await pgNonceStore.consume(nonce(), now + TICKET_TTL_MS, now)).toBe(true);
  });

  it("prunes rows that have already expired", async () => {
    const now = Date.now();
    const stale = nonce();
    await db.insert(wsTicketNonces).values({ nonce: stale, expiresAt: new Date(now - 60_000) });

    await pgNonceStore.consume(nonce(), now + TICKET_TTL_MS, now);
    // The prune is fire-and-forget; give it a beat.
    await new Promise((r) => setTimeout(r, 200));

    const [remaining] = await db.select().from(wsTicketNonces).where(eq(wsTicketNonces.nonce, stale));
    expect(remaining).toBeUndefined();
    const olderThanNow = await db.select().from(wsTicketNonces).where(lt(wsTicketNonces.expiresAt, new Date(now)));
    expect(olderThanNow).toHaveLength(0);
  });

  it("makes a real ticket single-use end to end", async () => {
    const ticket = mintWsTicket("user-pg");
    expect(await redeemWsTicket(ticket, Date.now(), pgNonceStore)).toBe("user-pg");
    expect(await redeemWsTicket(ticket, Date.now(), pgNonceStore)).toBeNull();
  });
});
