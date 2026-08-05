// shared/world-engine/net.ts
//
// The wire layer between peers in the distributed-authority model. Each client
// runs its own WorldState (engine.ts) and exchanges compact messages over the
// call mesh's unreliable data channel:
//
//   • every peer broadcasts its OWN avatar and any toy IT owns (possessed or
//     free-rolling) — high-frequency, latest-wins, loss-tolerant,
//   • discrete possession changes (grab / release / rest / leave) ride the same
//     channel; collectOutbound turns a tick's events into them,
//   • plus the rare ONE-SHOTS that are display or view state rather than
//     physics — `say` (a speech bubble: a player's own utterance and a
//     creature's line alike), `claim` (whose body a spark rides) and `convo`
//     (owner→follower conversation sync). Sent when something happens, never
//     streamed, and every one of them is safe to lose.
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
// TYPE-ONLY (erased at build): the conversation sync carries the dialogue
// layer's own records, so the wire never re-describes them. This layer stays
// dependency-free at runtime.
import type { ConversationState } from "./interaction/dialogue/conversation.js";
import type { DeviceBoardState } from "./interaction/dialogue/creature-dialogue.js";
import type { SyntaxLevel } from "./interaction/dialogue/dialogue-gen.js";

/**
 * The SHARED half of a conversation — the only half that crosses the wire.
 *
 * `revealed` (what was said out loud, so everyone present heard it) and `pairs`
 * (what each owner quoted each asker) belong to the conversation, so a follower
 * needs them to project its own board. The other half of the old memo — which
 * sub-menu this device has open — is `DeviceBoardState`, and it deliberately has
 * no wire shape at all: syncing one player's open pick-list would make the
 * other's board jump under their thumb. What is not sendable cannot be sent by
 * accident. (multi-entity-conversations.md §3a.)
 */
export type ConvoShared = Pick<ConversationState, "revealed" | "pairs">;

/**
 * CONVERSATION SYNC (owner-authoritative worlds) — what the owner last told us
 * about each conversation member, keyed by that member's WIRE id: which
 * creature they are talking to, the syntax level their turn is projected at,
 * the shared state the conversation has accumulated, and — when the sync
 * ANSWERS that member's own turn — the board transition that turn produced.
 *
 * `seq` is monotone PER CONVERSATION, which is what lets the reader tell a
 * fresh sync from one the mesh delivered late: this channel is unreliable and
 * unordered, so "the last packet to arrive" and "the last state the owner was
 * in" are not the same thing. A follower re-projects only on a NEW seq, so a
 * duplicate costs nothing and a straggler can never rewind a board.
 *
 * Declared here rather than in engine.ts because nothing in the ENGINE reads
 * it — it is wire state parked on the state object beside `peerClaims`, for the
 * game layer to pick up (see the applyInbound arm).
 */
declare module "./engine.js" {
  interface WorldState {
    convoSync?: Record<
      string,
      {
        cid: string;
        level: SyntaxLevel;
        shared: ConvoShared;
        ui?: DeviceBoardState;
        /** ⑫④ — WHOM THAT MEMBER IS TALKING TO, as the OWNER has it. Absent =
         *  nobody: the member's next line goes to the floor. */
        addressing?: string;
        seq: number;
      }
    >;
  }
}

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
  | { t: "claim"; id: string; body: string | null }
  // OWNER→FOLLOWER conversation sync: how the owner is projecting ONE member's
  // place in creature `cid`'s conversation — `member` is that member's wire id,
  // `level` its own syntax tier (the world holds every rung at once, so two
  // students in one conversation keep different ones) and `shared` what the
  // CONVERSATION remembers (revealed needs + per-pair quotes). Sent when the
  // record changes, never streamed. Loss-tolerant like the rest of this channel:
  // the owner holds the conversation, so a dropped packet costs a board refresh,
  // never state. Without it a follower's conversation board freezes the moment
  // it opens.
  //
  // `ui` is the ONE exception to "board navigation never crosses the wire", and
  // it proves the rule: it is present only when this sync answers THIS member's
  // OWN turn, and it carries that turn's transition (open the trade menu, turn
  // the page) back to the device that asked for it. The owner ran the turn, so
  // the owner is the only one who knows what it did to the board — but the
  // result belongs to exactly one device and is never copied to the others.
  // `seq` is monotone per conversation (see convoSync above).
  //
  // ⑫④ — `addressing` is WHOM THAT MEMBER IS TALKING TO, on the owner's roster:
  // the durable answer the LOOK channel buys (conversation-in-motion.md law ②),
  // sent so a follower's own `ConvoMember.addressing` stops being an optimistic
  // guess and becomes the owner's answer. ABSENT = nobody — the floor — which is
  // a real state and not a missing field, so a reader must treat "no key" as
  // "addressing nobody" and not as "unchanged". PURELY ADDITIVE on the wire: an
  // older owner sends none and `validConvo` never asks for it, so the sync it
  // does send still lands (see the seq/ui reasoning there — same rule, same
  // reason).
  | {
      t: "convo";
      cid: string;
      member: string;
      level: SyntaxLevel;
      shared: ConvoShared;
      ui?: DeviceBoardState;
      addressing?: string;
      seq: number;
    };

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

    case "convo": {
      // STORED, not acted on: the host re-projects a follower's board from this
      // on its own frame (quest-host, multi-entity-conversations.md §4.6).
      // Nothing in the engine or the renderer reads it.
      //
      // Latest-wins per member, but "latest" means the HIGHEST SEQ and not the
      // last packet through the door: this channel reorders, and applying a
      // straggler would rewind a follower's board to a state the owner has
      // already left. A sync for a DIFFERENT conversation always wins — that is
      // the member walking away from one creature and up to another, and its
      // seq counts a different conversation's turns.
      if (!validConvo(msg)) break;
      const sync = (state.convoSync ??= {});
      const seq = typeof msg.seq === "number" && Number.isFinite(msg.seq) ? msg.seq : 0;
      const prev = sync[msg.member];
      if (prev && prev.cid === msg.cid && prev.seq > seq) break;
      const ui = readConvoUi((msg as { ui?: unknown }).ui);
      // ⑫④ — a garbled `addressing` costs the ADDRESS and nothing else, exactly
      // as a garbled `ui` costs the transition: it reads as the floor, which is
      // a legitimate state a follower can render. Anything that is not a
      // non-empty string is not somebody.
      const addressing = (msg as { addressing?: unknown }).addressing;
      sync[msg.member] = {
        cid: msg.cid,
        level: msg.level,
        shared: msg.shared,
        ...(ui ? { ui } : {}),
        ...(typeof addressing === "string" && addressing.length > 0 ? { addressing } : {}),
        seq,
      };
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

/**
 * Build the owner→follower sync for ONE member of creature `cid`'s conversation
 * — that member's own syntax level and the conversation's shared state.
 *
 * Board navigation crosses only as `opts.ui`, and only for the member whose own
 * turn produced it (see the message type). `seq` defaults to 0 so a caller that
 * keeps no counter still builds a well-formed message; a real owner passes its
 * conversation's monotone one.
 *
 * ⑫④ — `opts.addressing` is whom that member is talking to, and it is LEFT OFF
 * when there is nobody, because "no key" IS the floor. An owner that passes it
 * unconditionally from a live read (`addressingOf`, which answers undefined for
 * a departed target) therefore says "nobody" the moment the address dies,
 * without a second message shape for the clearing.
 */
export function convoMessage(
  cid: string,
  member: string,
  level: SyntaxLevel,
  shared: ConvoShared,
  opts: { ui?: DeviceBoardState; addressing?: string; seq?: number } = {},
): WorldNetMessage {
  return {
    t: "convo",
    cid,
    member,
    level,
    shared,
    ...(opts.ui ? { ui: opts.ui } : {}),
    ...(opts.addressing ? { addressing: opts.addressing } : {}),
    seq: opts.seq ?? 0,
  };
}

/** Is this convo sync well-formed? The mesh is untrusted and version-skewed —
 *  the TYPE says these fields are there, the wire does not — so a malformed one
 *  is dropped exactly like an unknown kind, never half-applied. Both halves of
 *  `shared` are checked: a payload missing `pairs` would otherwise land as a
 *  conversation whose price lookups throw on the first quote.
 *
 *  `seq`, `ui` and `addressing` are deliberately NOT grounds for rejection. All
 *  three are newer than the message itself, so an older owner sends none of
 *  them, and dropping its syncs would freeze exactly the board this message
 *  exists to un-freeze — a missing seq reads as 0, a garbled `ui` is left off
 *  (see readConvoUi) and a garbled `addressing` reads as the floor. */
function validConvo(msg: Extract<WorldNetMessage, { t: "convo" }>): boolean {
  const m = msg as { cid: unknown; member: unknown; level: unknown; shared: unknown };
  if (
    typeof m.cid !== "string" || m.cid.length === 0 ||
    typeof m.member !== "string" || m.member.length === 0 ||
    !(m.level === "a" || m.level === "b" || m.level === "c") ||
    !m.shared || typeof m.shared !== "object"
  ) {
    return false;
  }
  const s = m.shared as { revealed: unknown; pairs: unknown };
  return !!s.revealed && typeof s.revealed === "object" && !!s.pairs && typeof s.pairs === "object";
}

/**
 * Read a board transition off the wire — field by field, keeping what arrived
 * intact and dropping what didn't.
 *
 * Unlike `shared`, a bad `ui` is not worth failing the whole sync over: it is
 * OPTIONAL by construction (absent = the board stays where it is), so the level
 * and the shared state still land and the follower is merely a page behind
 * rather than frozen. A half-read `list`, on the other hand, IS dropped whole —
 * a menu name with no page (or a page with no menu) would open a pick-list
 * nobody can navigate.
 */
function readConvoUi(raw: unknown): DeviceBoardState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as { tradeMenu?: unknown; list?: unknown };
  const l = u.list as { menu?: unknown; page?: unknown } | undefined;
  const ui: DeviceBoardState = {
    ...(u.tradeMenu === true ? { tradeMenu: true } : {}),
    ...(l && typeof l === "object" && typeof l.menu === "string" && l.menu.length > 0 &&
    typeof l.page === "number" && Number.isFinite(l.page)
      ? { list: { menu: l.menu, page: l.page } }
      : {}),
  };
  return Object.keys(ui).length ? ui : undefined;
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
