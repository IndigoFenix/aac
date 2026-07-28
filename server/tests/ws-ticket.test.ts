// Guards the WebSocket upgrade ticket — the iPad path where the session cookie
// cannot reach a WKWebView-issued handshake. This is an authentication
// boundary, so the negative cases matter more than the happy one.
//
// DB-free: ws-ticket.ts is pure crypto over env + an in-process replay set.

import {
  mintWsTicket,
  redeemWsTicket,
  TICKET_TTL_MS,
  __resetWsTicketsForTests,
} from "../services/realtime/ws-ticket";

describe("ws-ticket", () => {
  beforeEach(() => {
    __resetWsTicketsForTests();
  });

  it("round-trips the user id it was minted for", () => {
    const ticket = mintWsTicket("user-123");
    expect(redeemWsTicket(ticket)).toBe("user-123");
  });

  it("preserves user ids containing non-ASCII and separator characters", () => {
    // Ids are opaque; base64url encoding the id keeps "." usable as a separator.
    for (const id of ["a.b.c", "ünïcode-Ω", "0000-0000-0000"]) {
      __resetWsTicketsForTests();
      expect(redeemWsTicket(mintWsTicket(id))).toBe(id);
    }
  });

  it("is single use — a replayed ticket is rejected", () => {
    const ticket = mintWsTicket("user-123");
    expect(redeemWsTicket(ticket)).toBe("user-123");
    expect(redeemWsTicket(ticket)).toBeNull();
  });

  it("expires after its TTL", () => {
    const now = Date.now();
    const ticket = mintWsTicket("user-123", now);
    // Still valid a moment before expiry, dead a moment after.
    expect(redeemWsTicket(ticket, now + TICKET_TTL_MS - 1000)).toBe("user-123");
    __resetWsTicketsForTests();
    expect(redeemWsTicket(ticket, now + TICKET_TTL_MS + 1)).toBeNull();
  });

  it("rejects a tampered user id (signature covers the payload)", () => {
    const ticket = mintWsTicket("user-123");
    const parts = ticket.split(".");
    const forgedId = Buffer.from("admin-user", "utf8").toString("base64url");
    const forged = [forgedId, parts[1], parts[2], parts[3]].join(".");
    expect(redeemWsTicket(forged)).toBeNull();
  });

  it("rejects a tampered expiry (cannot extend its own lifetime)", () => {
    const now = Date.now();
    const ticket = mintWsTicket("user-123", now);
    const parts = ticket.split(".");
    const extended = [parts[0], String(now + 86_400_000), parts[2], parts[3]].join(".");
    expect(redeemWsTicket(extended, now + TICKET_TTL_MS + 1)).toBeNull();
  });

  it("rejects a wrong or absent signature", () => {
    const parts = mintWsTicket("user-123").split(".");
    expect(redeemWsTicket([parts[0], parts[1], parts[2], "not-a-signature"].join("."))).toBeNull();
    expect(redeemWsTicket([parts[0], parts[1], parts[2]].join("."))).toBeNull();
  });

  it("rejects malformed, empty, and oversized input without throwing", () => {
    for (const bad of ["", "...", "a.b", "a.b.c.d.e", "x".repeat(600)]) {
      expect(redeemWsTicket(bad)).toBeNull();
    }
  });

  it("issues a distinct ticket every time", () => {
    // Nonce-based, so two tickets for the same user never collide — otherwise
    // the single-use rule would lock a user out of their second connection.
    const a = mintWsTicket("user-123");
    const b = mintWsTicket("user-123");
    expect(a).not.toBe(b);
    expect(redeemWsTicket(a)).toBe("user-123");
    expect(redeemWsTicket(b)).toBe("user-123");
  });
});
