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
  applyRemoteToy,
  removeAvatar,
  setAvatarSpeech,
  WORLD_ENGINE_DEFAULTS,
  type WorldEvent,
  type WorldState,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Wire messages (short keys — these go out ~15×/sec per peer)
// ---------------------------------------------------------------------------

export type WorldNetMessage =
  | { t: "avatar"; id: string; x: number; y: number; fx: number; fy: number; vx: number; vy: number }
  | { t: "toy"; id: string; x: number; y: number; vx: number; vy: number }
  | { t: "grab"; id: string; by: string }
  | { t: "release"; id: string; by: string; at: number }
  | { t: "rest"; id: string }
  | { t: "leave"; id: string }
  // Display-only: a one-shot speech bubble for the sender's avatar (NOT streamed
  // every frame — emitted once when the peer speaks). `text` is the line; `glyph`
  // is the optional composed AAC glyph string for a symbol rendering.
  | { t: "say"; id: string; text: string; glyph?: string };

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
    });
  }

  // Stream the position of every toy this peer is authoritative for.
  for (const toy of Object.values(state.toys)) {
    if (toy.possessedBy === me || toy.freeRollOwner === me) {
      out.push({ t: "toy", id: toy.id, x: toy.x, y: toy.y, vx: toy.vx, vy: toy.vy });
    }
  }

  // Discrete events → possession messages.
  for (const ev of tickEvents) {
    if (ev.type === "possession-request") {
      out.push({ t: "grab", id: ev.toyId, by: ev.participantId });
    } else if (ev.type === "possession-released") {
      out.push({ t: "release", id: ev.toyId, by: ev.participantId, at: ev.at });
    } else if (ev.type === "toy-rest") {
      out.push({ t: "rest", id: ev.toyId });
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
      });
      break;

    case "toy":
      applyRemoteToy(state, msg.id, { x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy });
      break;

    case "grab":
      applyRemoteGrab(state, msg.id, msg.by, opts);
      break;

    case "release": {
      const toy = state.toys[msg.id];
      if (!toy) break;
      // Honor the release of whoever we believe holds the toy (or our own stale
      // belief that we do). The releaser keeps simulating the free-roll.
      if (toy.possessedBy === msg.by || toy.possessedBy === state.localId) {
        if (toy.possessedBy === state.localId) {
          toy.grabCooldownUntil = msg.at + opts.grabCooldown;
        }
        toy.possessedBy = null;
        toy.freeRollOwner = msg.by;
        toy.lastPossessor = msg.by;
      }
      break;
    }

    case "rest": {
      const toy = state.toys[msg.id];
      if (!toy) break;
      // Only accept a remote "at rest" if we aren't the one simulating it.
      if (toy.possessedBy !== state.localId && toy.freeRollOwner !== state.localId) {
        toy.possessedBy = null;
        toy.freeRollOwner = null;
        toy.vx = 0;
        toy.vy = 0;
      }
      break;
    }

    case "leave":
      removeAvatar(state, msg.id);
      break;

    case "say":
      setAvatarSpeech(state, msg.id, { text: msg.text, glyph: msg.glyph });
      break;
  }
}

/** Build the one-shot "say" message a peer broadcasts when it speaks. */
export function sayMessage(id: string, text: string, glyph?: string): WorldNetMessage {
  return glyph ? { t: "say", id, text, glyph } : { t: "say", id, text };
}

/**
 * A remote peer claims a toy. Deterministic precedence: a free toy is always
 * taken; a contested toy goes to the lower participant id, so every peer
 * converges on the same owner without a server. A peer that loses the local
 * toy gets a brief re-grab cooldown to stop ping-ponging.
 */
function applyRemoteGrab(
  state: WorldState,
  toyId: string,
  by: string,
  opts: NetOptions,
): void {
  const toy = state.toys[toyId];
  if (!toy) return;
  const current = toy.possessedBy;

  const remoteWins = current === null || by < current;
  if (!remoteWins) return;

  if (current === state.localId) {
    // We just lost possession we thought we had — back off briefly.
    toy.lastPossessor = state.localId;
    toy.grabCooldownUntil = state.time + opts.grabCooldown;
  }
  toy.possessedBy = by;
  toy.freeRollOwner = null;
  toy.vx = 0;
  toy.vy = 0;
}
