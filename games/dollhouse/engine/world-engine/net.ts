// shared/world-engine/net.ts
//
// The wire layer between peers in the distributed-authority model. Each client
// runs its own WorldState (engine.ts) and exchanges compact messages over the
// call mesh's unreliable data channel:
//
//   • every peer broadcasts its OWN avatar and any toy IT owns (possessed or
//     free-rolling) — high-frequency, latest-wins, loss-tolerant,
//   • discrete possession changes (grab / release / rest / leave) ride the same
//     channel; collectOutbound turns a tick's events into them.
//
// Possession arbitration here is PHASE-1 peer-to-peer: deterministic "lower
// participant id wins" so both sides converge on the same owner without a
// server. Phase 2 replaces this with a server-owned possession token
// (applyPossession becomes the authoritative committer); the message shapes and
// applyInbound stay, only the arbiter moves. Documented so it isn't mistaken
// for the final design.

import {
  applyRemoteAvatar,
  applyRemoteObject,
  removeAvatar,
  setAvatarSpeech,
  WORLD_ENGINE_DEFAULTS,
  type WorldEvent,
  type WorldState,
} from "./engine.js";
import { parsePlayerAction, type PlayerAction } from "./player-action.js";

// ---------------------------------------------------------------------------
// Wire messages (short keys — these go out ~15×/sec per peer)
// ---------------------------------------------------------------------------

export type WorldNetMessage =
  | { t: "avatar"; id: string; x: number; y: number; fx: number; fy: number; vx: number; vy: number; floor?: number }
  | { t: "object"; id: string; x: number; y: number; vx: number; vy: number }
  | { t: "grab"; id: string; by: string }
  | { t: "release"; id: string; by: string; at: number }
  | { t: "rest"; id: string }
  | { t: "leave"; id: string }
  // Display-only: a one-shot speech bubble for the sender's avatar (NOT streamed
  // every frame — emitted once when the peer speaks). `text` is the line; `glyph`
  // is the optional composed AAC glyph string for a symbol rendering.
  | { t: "say"; id: string; text: string; glyph?: string }
  // RARE body-claim announcement (owner-authoritative worlds): peer `id`'s
  // spark now rides avatar `body` (`null` = released, back to its own light).
  // Emitted on every claim/release AND rebroadcast ~5-secondly by the claim
  // holder, so a late joiner converges without a state sync. Display-only —
  // it feeds WorldState.peerClaims, which only the render layer reads.
  | { t: "claim"; id: string; body: string | null };

export interface NetOptions {
  /** Cooldown applied to a peer that loses possession, to damp re-grab churn. */
  grabCooldown: number;
}

const NET_DEFAULTS: NetOptions = {
  grabCooldown: WORLD_ENGINE_DEFAULTS.grabCooldown,
};

// ---------------------------------------------------------------------------
// Outbound — what this peer should broadcast this frame
// ---------------------------------------------------------------------------

/**
 * Build the messages to broadcast for the local peer: every avatar it OWNS, the
 * toys it owns, and any discrete possession changes from the tick just run. Call
 * at the network send rate (~15 Hz) rather than every render frame.
 *
 * `ownedAvatarIds` defaults to just the local player. A peer that hosts NPCs
 * passes its NPC ids too, so each NPC streams over the mesh and every peer renders
 * it as an ordinary remote avatar (no NPC-aware code needed on the receiving end).
 */
export function collectOutbound(
  state: WorldState,
  tickEvents: readonly WorldEvent[] = [],
  ownedAvatarIds: readonly string[] = [state.localId],
): WorldNetMessage[] {
  const out: WorldNetMessage[] = [];
  const me = state.localId;

  for (const id of ownedAvatarIds) {
    const a = state.avatars[id];
    if (!a) continue;
    out.push({
      t: "avatar",
      id,
      x: a.x, y: a.y,
      fx: a.fx, fy: a.fy,
      vx: a.vx, vy: a.vy,
      ...(a.floor ? { floor: a.floor } : {}),
    });
  }

  // Stream the position of every object this peer is authoritative for (pushing,
  // free-rolling, or carrying it — so a carried object isn't frozen for peers).
  for (const obj of Object.values(state.objects)) {
    if (obj.possessedBy === me || obj.freeRollOwner === me || obj.carriedBy === me) {
      out.push({ t: "object", id: obj.id, x: obj.x, y: obj.y, vx: obj.vx, vy: obj.vy });
    }
  }

  // Discrete events → possession messages.
  for (const ev of tickEvents) {
    if (ev.type === "possession-request") {
      out.push({ t: "grab", id: ev.objectId, by: ev.participantId });
    } else if (ev.type === "possession-released") {
      out.push({ t: "release", id: ev.objectId, by: ev.participantId, at: ev.at });
    } else if (ev.type === "object-rest") {
      out.push({ t: "rest", id: ev.objectId });
    }
  }

  return out;
}

/** A peer is leaving the room — tell the others to drop its avatar. */
export function leaveMessage(localId: string): WorldNetMessage {
  return { t: "leave", id: localId };
}

// ---------------------------------------------------------------------------
// Inbound — apply a peer's message to the local state
// ---------------------------------------------------------------------------

export function applyInbound(
  state: WorldState,
  msg: WorldNetMessage,
  opts: NetOptions = NET_DEFAULTS,
): void {
  switch (msg.t) {
    case "avatar":
      applyRemoteAvatar(state, {
        id: msg.id,
        x: msg.x, y: msg.y,
        fx: msg.fx, fy: msg.fy,
        vx: msg.vx, vy: msg.vy,
        floor: msg.floor ?? 0,
      });
      break;

    case "object":
      applyRemoteObject(state, msg.id, { x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy });
      break;

    case "grab":
      applyRemoteGrab(state, msg.id, msg.by, opts);
      break;

    case "release": {
      const obj = state.objects[msg.id];
      if (!obj) break;
      // Honor the release of whoever we believe holds it (or our own stale
      // belief that we do). The releaser keeps simulating the free-roll.
      if (obj.possessedBy === msg.by || obj.possessedBy === state.localId) {
        if (obj.possessedBy === state.localId) {
          obj.grabCooldownUntil = msg.at + opts.grabCooldown;
        }
        obj.possessedBy = null;
        obj.freeRollOwner = msg.by;
        obj.lastPossessor = msg.by;
      }
      break;
    }

    case "rest": {
      const obj = state.objects[msg.id];
      if (!obj) break;
      // Only accept a remote "at rest" if we aren't the one simulating it.
      if (obj.possessedBy !== state.localId && obj.freeRollOwner !== state.localId) {
        obj.possessedBy = null;
        obj.freeRollOwner = null;
        obj.vx = 0;
        obj.vy = 0;
      }
      break;
    }

    case "leave":
      removeAvatar(state, msg.id);
      break;

    case "say":
      setAvatarSpeech(state, msg.id, { text: msg.text, glyph: msg.glyph });
      break;

    case "claim": {
      // Track which body each remote spark rides (WorldState.peerClaims) so the
      // render layer can park its light beside the claimed body. Idempotent —
      // the holder rebroadcasts for late joiners.
      const claims = (state.peerClaims ??= {});
      if (msg.body === null) delete claims[msg.id];
      else claims[msg.id] = msg.body;
      break;
    }

    // VERSION-SKEW TOLERANCE: peers run vendored engine snapshots of different
    // ages, so an unknown message kind from a newer peer must be silently
    // ignored, never a crash. (The type says this is unreachable; the wire does
    // not.)
    default:
      break;
  }
}

/** Build the one-shot "say" message a peer broadcasts when it speaks. */
export function sayMessage(id: string, text: string, glyph?: string): WorldNetMessage {
  return glyph ? { t: "say", id, text, glyph } : { t: "say", id, text };
}

/** Build the rare claim/release announcement peer `id` broadcasts when its
 *  spark claims avatar `body` (`null` = released back to its own light). */
export function claimMessage(id: string, body: string | null): WorldNetMessage {
  return { t: "claim", id, body };
}

// ---------------------------------------------------------------------------
// Commands — the RELIABLE relay beside the lossy mesh
// ---------------------------------------------------------------------------
//
// In the owner-authoritative model (quest worlds — the dollhouse), followers
// freeze the world-mutating sim and RELAY their intents to the owner, which
// injects them into its normal dispatch chain with explicit actor/target
// context. Commands must not be lost, so they ride the platform's reliable
// channel — a different pipe from WorldNetMessage, hence a separate type.

/** A follower's intent, relayed (reliably) to the owning peer.
 *  `from` is always the sender's network id (its personId on the wire). */
/**
 * A relayed command IS a `PlayerAction` plus WHO performed it — there is no
 * separate wire vocabulary for "things a peer did". The owner runs it through
 * the same executor as its own actions; see player-action.ts for the line
 * between what travels and what stays local.
 */
export type WorldCommand = PlayerAction & { from: string };

/** Parse an untrusted relayed payload into a WorldCommand, or null — tolerant
 *  of malformed and future-versioned shapes (never throws). The action half is
 *  the shared `parsePlayerAction`; all this layer adds is the sender. */
export function parseWorldCommand(raw: unknown): WorldCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const from = (raw as { from?: unknown }).from;
  if (typeof from !== "string" || !from) return null;
  const action = parsePlayerAction(raw);
  return action ? { ...action, from } : null;
}

/**
 * A remote peer claims an object. Deterministic precedence: a free object is
 * always taken; a contested one goes to the lower participant id, so every peer
 * converges on the same owner without a server. A peer that loses the local
 * object gets a brief re-grab cooldown to stop ping-ponging.
 */
function applyRemoteGrab(
  state: WorldState,
  objectId: string,
  by: string,
  opts: NetOptions,
): void {
  const obj = state.objects[objectId];
  if (!obj) return;
  const current = obj.possessedBy;

  const remoteWins = current === null || by < current;
  if (!remoteWins) return;

  if (current === state.localId) {
    // We just lost possession we thought we had — back off briefly.
    obj.lastPossessor = state.localId;
    obj.grabCooldownUntil = state.time + opts.grabCooldown;
  }
  obj.possessedBy = by;
  obj.freeRollOwner = null;
  obj.vx = 0;
  obj.vy = 0;
}
