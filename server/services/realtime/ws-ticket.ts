// Short-lived, single-use tickets that authenticate a WebSocket upgrade when
// the session cookie cannot travel with the handshake.
//
// WHY THIS EXISTS — the iPad (Capacitor) case:
//   The AAC iPad shell is served from capacitor://localhost and talks to a
//   cross-origin https backend. WKWebView refuses to store/send the server's
//   SameSite=None session cookie (ITP third-party rules), so the API layer was
//   moved to CapacitorHttp, which performs requests natively and keeps cookies
//   in the NATIVE (URLSession) cookie store — see client-aac/src/lib/queryClient.ts.
//
//   That fixes HTTP but not WebSockets: `new WebSocket(...)` is executed by
//   WKWebView, whose cookie jar never received the session cookie at all. The
//   upgrade request therefore arrives with no cookie, authenticateUpgrade
//   returns null, and the client sees a bare `1006` close before `onopen`.
//   The session cookie is httpOnly, so JS cannot copy it across either.
//
// The ticket closes that gap without weakening the upgrade-boundary check: the
// client asks an ALREADY-AUTHENTICATED HTTP endpoint (which does carry the
// cookie, natively) to mint a ticket, then presents it on the handshake. The
// identity still comes from the same express session — only the transport of
// the proof changes.
//
// Properties that keep this safe to put in a URL:
//   - HMAC-signed with a key derived from SESSION_SECRET; unforgeable.
//   - 60-second TTL — expired well before any log retention matters.
//   - Single use — redeeming consumes the nonce, so a replayed URL is dead.
//     The consumed set lives behind `NonceStore`: in production that is a
//     Postgres table shared by every ECS task (ws-ticket-store-pg.ts); the
//     in-process default here is for tests and single-task dev. An in-process
//     set alone is NOT single-use once there are two tasks behind the ALB.
//   - Carries only a user id; no PHI, no session id, and it cannot be exchanged
//     back into a session cookie.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** How long a freshly minted ticket stays valid. Deliberately tiny — the
 *  client mints one immediately before calling `new WebSocket(...)`. */
export const TICKET_TTL_MS = 60_000;

/**
 * Where redeemed nonces are remembered until they would have expired anyway.
 * `consume` must be atomic: it returns true exactly once per nonce across
 * every process that shares the store.
 */
export interface NonceStore {
  consume(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

/** Derive a dedicated key rather than signing with SESSION_SECRET directly, so
 *  a leaked ticket signature can never be replayed against session cookies. */
function ticketKey(): Buffer {
  const base = process.env.SESSION_SECRET || "fallback-secret-key-for-dev";
  return createHmac("sha256", base).update("aivota:ws-ticket:v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", ticketKey()).update(payload).digest("base64url");
}

// ── In-process store (tests, single-task dev) ─────────────────────────────

const consumed = new Map<string, number>();

function pruneConsumed(now: number): void {
  if (consumed.size < 256) return; // cheap: only sweep once it's worth it
  for (const [nonce, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(nonce);
  }
}

export const memoryNonceStore: NonceStore = {
  async consume(nonce, expiresAt, now) {
    if (consumed.has(nonce)) return false;
    consumed.set(nonce, expiresAt);
    pruneConsumed(now);
    return true;
  },
};

// ── Tickets ───────────────────────────────────────────────────────────────

/**
 * Mint a ticket for an authenticated user. Call only from a route that has
 * already established the session.
 */
export function mintWsTicket(userId: string, now: number = Date.now()): string {
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = now + TICKET_TTL_MS;
  // "." is not produced by base64url, so it is a safe field separator.
  const payload = `${Buffer.from(userId, "utf8").toString("base64url")}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify and CONSUME a ticket. Returns the user id it was minted for, or null
 * if it is malformed, forged, expired, or already used (per `store`).
 */
export async function redeemWsTicket(
  ticket: string,
  now: number = Date.now(),
  store: NonceStore = memoryNonceStore,
): Promise<string | null> {
  if (!ticket || ticket.length > 512) return null;

  const parts = ticket.split(".");
  if (parts.length !== 4) return null;
  const [encodedUserId, expiresAtRaw, nonce, signature] = parts;

  const payload = `${encodedUserId}.${expiresAtRaw}.${nonce}`;
  const expected = sign(payload);

  // Compare in constant time; timingSafeEqual throws on length mismatch.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  // Only a SIGNED, UNEXPIRED nonce reaches the store, so the store never
  // fills with attacker-chosen garbage.
  if (!(await store.consume(nonce, expiresAt, now))) return null; // replay

  const userId = Buffer.from(encodedUserId, "base64url").toString("utf8");
  return userId || null;
}

/** Test-only: drop the in-process replay set so cases don't leak into each other. */
export function __resetWsTicketsForTests(): void {
  consumed.clear();
}
