// Guards the WebSocket upgrade ticket — the iPad path where the session cookie
// cannot reach a WKWebView-issued handshake. This is an authentication
// boundary, so the negative cases matter more than the happy one.
//
// DB-free: ws-ticket.ts is pure crypto over env + the in-process NonceStore.
// The Postgres store that makes single-use hold ACROSS tasks is covered by
// server/tests/integration/ws-ticket-store-pg.test.ts.

import {
  mintWsTicket,
  redeemWsTicket,
  memoryNonceStore,
  TICKET_TTL_MS,
  __resetWsTicketsForTests,
  type NonceStore,
} from "../services/realtime/ws-ticket";

describe("ws-ticket", () => {
  beforeEach(() => {
    __resetWsTicketsForTests();
  });

  it("round-trips the user id it was minted for", async () => {
    const ticket = mintWsTicket("user-123");
    expect(await redeemWsTicket(ticket)).toBe("user-123");
  });

  it("preserves user ids containing non-ASCII and separator characters", async () => {
    // Ids are opaque; base64url encoding the id keeps "." usable as a separator.
    for (const id of ["a.b.c", "ünïcode-Ω", "0000-0000-0000"]) {
      __resetWsTicketsForTests();
      expect(await redeemWsTicket(mintWsTicket(id))).toBe(id);
    }
  });

  it("is single use — a replayed ticket is rejected", async () => {
    const ticket = mintWsTicket("user-123");
    expect(await redeemWsTicket(ticket)).toBe("user-123");
    expect(await redeemWsTicket(ticket)).toBeNull();
  });

  it("consults the store only for a signed, unexpired ticket", async () => {
    // A forged or expired ticket must be refused BEFORE the store is asked,
    // so the shared table cannot be filled with attacker-chosen nonces.
    const calls: string[] = [];
    const spyStore: NonceStore = {
      async consume(nonce) { calls.push(nonce); return true; },
    };
    const now = Date.now();
    const good = mintWsTicket("user-123", now);
    const parts = good.split(".");
    const forged = [parts[0], parts[1], parts[2], "not-a-signature"].join(".");

    expect(await redeemWsTicket(forged, now, spyStore)).toBeNull();
    expect(await redeemWsTicket(good, now + TICKET_TTL_MS + 1, spyStore)).toBeNull();
    expect(calls).toEqual([]);

    expect(await redeemWsTicket(good, now, spyStore)).toBe("user-123");
    expect(calls).toEqual([parts[2]]);
  });

  it("refuses when the store reports the nonce already consumed", async () => {
    const refusing: NonceStore = { async consume() { return false; } };
    expect(await redeemWsTicket(mintWsTicket("user-123"), Date.now(), refusing)).toBeNull();
  });

  it("expires after its TTL", async () => {
    const now = Date.now();
    const ticket = mintWsTicket("user-123", now);
    // Still valid a moment before expiry, dead a moment after.
    expect(await redeemWsTicket(ticket, now + TICKET_TTL_MS - 1000)).toBe("user-123");
    __resetWsTicketsForTests();
    expect(await redeemWsTicket(ticket, now + TICKET_TTL_MS + 1)).toBeNull();
  });

  it("rejects a tampered user id (signature covers the payload)", async () => {
    const ticket = mintWsTicket("user-123");
    const parts = ticket.split(".");
    const forgedId = Buffer.from("admin-user", "utf8").toString("base64url");
    const forged = [forgedId, parts[1], parts[2], parts[3]].join(".");
    expect(await redeemWsTicket(forged)).toBeNull();
  });

  it("rejects a tampered expiry (cannot extend its own lifetime)", async () => {
    const now = Date.now();
    const ticket = mintWsTicket("user-123", now);
    const parts = ticket.split(".");
    const extended = [parts[0], String(now + 86_400_000), parts[2], parts[3]].join(".");
    expect(await redeemWsTicket(extended, now + TICKET_TTL_MS + 1)).toBeNull();
  });

  it("rejects a wrong or absent signature", async () => {
    const parts = mintWsTicket("user-123").split(".");
    expect(await redeemWsTicket([parts[0], parts[1], parts[2], "not-a-signature"].join("."))).toBeNull();
    expect(await redeemWsTicket([parts[0], parts[1], parts[2]].join("."))).toBeNull();
  });

  it("rejects malformed, empty, and oversized input without throwing", async () => {
    for (const bad of ["", "...", "a.b", "a.b.c.d.e", "x".repeat(600)]) {
      expect(await redeemWsTicket(bad)).toBeNull();
    }
  });

  it("issues a distinct ticket every time", async () => {
    // Nonce-based, so two tickets for the same user never collide — otherwise
    // the single-use rule would lock a user out of their second connection.
    const a = mintWsTicket("user-123");
    const b = mintWsTicket("user-123");
    expect(a).not.toBe(b);
    expect(await redeemWsTicket(a)).toBe("user-123");
    expect(await redeemWsTicket(b)).toBe("user-123");
  });

  it("the in-process store is the default", async () => {
    // Explicit so a future refactor can't silently make the default a no-op.
    const ticket = mintWsTicket("user-123");
    expect(await redeemWsTicket(ticket, Date.now(), memoryNonceStore)).toBe("user-123");
    expect(await redeemWsTicket(ticket)).toBeNull();
  });
});
