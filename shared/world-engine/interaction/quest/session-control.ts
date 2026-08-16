// shared/world-engine/interaction/quest/session-control.ts
//
// SESSION-CONTROL ENVELOPES — generic engine machinery: the reliable-pipe
// counterpart to WorldCommand (net.ts), carrying how the elected session
// coordinator assigns / re-anchors / hands sessions over, for the reliable
// pipe of any shared multiplayer world (not specific to any one game).
// session-split.ts computes WHO is in WHICH session and WHO hosts it; this
// module is the WIRE for telling everyone.
//
// DISCRIMINANT `sc`, deliberately distinct from PlayerAction's `kind`
// (player-action.ts) and WorldNetMessage's `t` (net.ts): a session-control
// envelope, a relayed player action, and a loose-mesh update may all ride
// mixed traffic on the same connection, and each parser must be able to look
// at ANY of the three shapes and cleanly say "not mine" instead of
// half-parsing a stranger's fields. Three different discriminant keys make
// the three parsers mutually null-safe BY CONSTRUCTION — no envelope can
// accidentally satisfy more than one parser's switch.
//
// Pure and dependency-free, same discipline as player-action.ts: no world, no
// session, no renderer, zero imports. The game-side coordinator is the only
// intended caller; a later module teaches `handover.payload` its actual
// shape — this module only carries it opaque.

/** Direction + elevation, planet-frame: a body-local unit vector `d` and
 *  elevation `e` in metres — the same shape session-split.ts uses for a
 *  session's anchor, redeclared here (not imported) so this module stays
 *  import-free. */
export interface SessionAnchor {
  d: [number, number, number];
  e: number;
}

/**
 * One session-control envelope, riding the reliable pipe beside
 * `WorldCommand` (net.ts). Sent by the elected coordinator (N6b); every
 * member — coordinator included — applies what it receives.
 *
 * - `assign`: the full session roster as of `epoch` — who's in which session
 *   and who has authority over it. Replaces the previous roster whole (the
 *   wire form of session-split.ts's `SessionAssignment`).
 * - `anchor`: session `sessionId` re-anchored (member centroid moved), so
 *   every member — not just the authority — rebases identically, rather
 *   than each computing its own local anchor and drifting apart.
 * - `handover`: authority for `sessionId` is moving from `from` to `to`.
 *   `payload` is opaque here — N6c teaches the consumer its shape (condensed
 *   wild-area records + avatar snapshots); this module only carries it.
 */
export type SessionControl =
  | {
      sc: "assign";
      epoch: number;
      sessions: Array<{ id: string; members: string[]; authority: string; anchor: SessionAnchor }>;
    }
  | { sc: "anchor"; sessionId: string; epoch: number; loc: SessionAnchor }
  | { sc: "handover"; sessionId: string; from: string; to: string; payload: unknown };

function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function strArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Read a `SessionAnchor` off an untrusted payload, or null if any part is
 *  malformed — an anchor is never partially trusted (unlike, say, a
 *  `Gesture`, where each part stands alone). */
function parseAnchor(raw: unknown): SessionAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as { d?: unknown; e?: unknown };
  if (!Array.isArray(a.d) || a.d.length !== 3) return null;
  if (!a.d.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (!num(a.e)) return null;
  return { d: [a.d[0], a.d[1], a.d[2]] as [number, number, number], e: a.e };
}

/** Read ONE session row off an untrusted `assign` payload, or null. Unknown
 *  extra fields on the row are dropped, not preserved — version skew: a
 *  newer peer may add fields, and only the known shape is trusted forward. */
function parseSessionRow(
  raw: unknown,
): { id: string; members: string[]; authority: string; anchor: SessionAnchor } | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { id?: unknown; members?: unknown; authority?: unknown; anchor?: unknown };
  if (!str(s.id) || !strArray(s.members) || !str(s.authority)) return null;
  const anchor = parseAnchor(s.anchor);
  if (!anchor) return null;
  return { id: s.id, members: s.members, authority: s.authority, anchor };
}

/**
 * Parse an untrusted payload into a `SessionControl`, or null. Never throws:
 * this rides the same mesh as `WorldCommand`, so a half-read envelope must be
 * dropped rather than acted on against whatever the missing field would have
 * named — the same law `parsePlayerAction`/`parseWorldCommand` follow.
 *
 * Unknown extra properties — top-level or per-session — are silently ignored
 * rather than rejected: a newer peer's envelope with a field this build
 * doesn't know about still parses into everything this build DOES know, so
 * an older coordinator or follower degrades gracefully instead of dropping
 * the whole roster over one unrecognised field. `handover.payload` is the
 * one deliberate exception: it is carried through as `unknown` and never
 * inspected here (N6c owns its shape).
 */
export function parseSessionControl(raw: unknown): SessionControl | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  switch (m.sc) {
    case "assign": {
      if (!num(m.epoch) || !Array.isArray(m.sessions)) return null;
      const sessions: Array<{ id: string; members: string[]; authority: string; anchor: SessionAnchor }> = [];
      for (const row of m.sessions) {
        const parsed = parseSessionRow(row);
        if (!parsed) return null;
        sessions.push(parsed);
      }
      return { sc: "assign", epoch: m.epoch, sessions };
    }
    case "anchor": {
      if (!str(m.sessionId) || !num(m.epoch)) return null;
      const loc = parseAnchor(m.loc);
      if (!loc) return null;
      return { sc: "anchor", sessionId: m.sessionId, epoch: m.epoch, loc };
    }
    case "handover": {
      if (!str(m.sessionId) || !str(m.from) || !str(m.to)) return null;
      return { sc: "handover", sessionId: m.sessionId, from: m.from, to: m.to, payload: m.payload };
    }
    default:
      // Unknown/missing `sc` — including a PlayerAction's `kind` or a
      // WorldNetMessage's `t`, neither of which sets `sc` at all — is
      // version skew or a foreign envelope, not an error.
      return null;
  }
}

/** Build an `assign` envelope: the full session roster as of `epoch`. */
export function assignControl(
  epoch: number,
  sessions: Array<{ id: string; members: string[]; authority: string; anchor: SessionAnchor }>,
): SessionControl {
  return { sc: "assign", epoch, sessions };
}

/** Build an `anchor` envelope: session `sessionId` re-anchored at `loc`. */
export function anchorControl(sessionId: string, epoch: number, loc: SessionAnchor): SessionControl {
  return { sc: "anchor", sessionId, epoch, loc };
}

/** Build a `handover` envelope: authority for `sessionId` moves `from` → `to`,
 *  carrying `payload` opaque (N6c teaches the consumer its shape). */
export function handoverControl(
  sessionId: string,
  from: string,
  to: string,
  payload: unknown,
): SessionControl {
  return { sc: "handover", sessionId, from, to, payload };
}
