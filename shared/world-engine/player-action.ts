// shared/world-engine/player-action.ts
//
// WHAT A PLAYER DOES TO THE WORLD — the one vocabulary.
//
// A player has three ways to reach the simulation: they press a button on their
// board, they compose a sentence and play it, or they instruct with their gaze.
// Those are three INPUTS, not three kinds of act, and the difference between
// them dies here: each resolves to one `PlayerAction`, and every path into the
// simulation runs through the single gate that takes one (quest-host's
// `performPlayerAction`).
//
// THE LINE THIS TYPE DRAWS:
//
//   ABOVE it — local, always, on the device that did it: voicing the sentence,
//   paging the board, opening a menu or a conversation, moving the camera, the
//   spark's own position. Nobody else's world changes, so nobody else is asked.
//
//   BELOW it — the simulation. In a multiplayer world exactly one peer owns
//   that, so below the gate an action either runs here (owner / single player)
//   or travels to the owner as a `WorldCommand` — a PlayerAction plus WHO did
//   it. Same union on both sides of the wire; the owner runs a relayed action
//   through the very same executor as its own.
//
// Ids and positions travel INSIDE the action because the sender's context is
// the truth — the owner has no idea what that peer was looking at, and
// re-resolving against its own gaze would carry out somebody else's
// instruction against the wrong subject. Ids are portable because every peer
// builds the same deterministic cast from the same spec and seed.
//
// Pure and dependency-free: no world, no session, no renderer (the one import
// is a TYPE, erased at build).

import type { DialogueAct } from "./interaction/dialogue/creature-dialogue.js";

/**
 * WHAT THE SPEAKER WAS INDICATING while they said it.
 *
 * An utterance is a glyph AND a gesture, and the gesture is half the meaning: a
 * lone "apple" means *ask me for one* said to a creature, and *take that one*
 * said into an open chest. This is what makes single-glyph speech complete
 * rather than impoverished — and it is the same deixis the parser already
 * names, where `this/that/here/there` resolve against "the gaze/selection
 * referent" (concept-parser.md §4.3).
 *
 * THE RULE IT OBEYS: **anything a player can say, a creature can say too.** A
 * gesture is not a player-only affordance smuggled into the language — creatures
 * indicate places bodily (the directions answer swings an arm at the building it
 * names), so a concept expressible as one glyph plus one gesture is expressible
 * by either side. That is the test for whether a single-glyph button is honest.
 * A button that needs more context than a gesture can carry is simply not
 * available in single-glyph mode, and that is the right outcome.
 *
 * It travels WITH the utterance because the speaker's gaze is the truth: the
 * owner resolving "there" against its own screen would send a creature to a
 * place nobody pointed at.
 */
export interface Gesture {
  /** The creature being spoken to. */
  addressee?: string;
  /** The ground being indicated — "there", "here", and the place an order with
   *  no named place lands in. */
  place?: { x: number; y: number };
  /** The container whose contents are on the speaker's board: the thing they
   *  are reaching into. A bare noun said into one names a stack inside it. */
  container?: string;
  /** The build spot the speaker settled on — a named place, indicated. */
  spot?: string;
}

/** One act a player performs on the world. Closed union — a new way to reach
 *  the simulation is a new variant here, never a new path around the gate. */
export type PlayerAction =
  /** A composed sentence, played — with the gesture that completes it. */
  | { kind: "speak"; sentence: string; gesture?: Gesture }
  /** A board option, pressed. `optionId` is the engine's own option id; `glyph`
   *  is the sentence it speaks — the last thing that still means something if
   *  the option itself doesn't survive the trip. A press is an utterance like
   *  any other, so it carries the same gesture a spoken sentence does. */
  | { kind: "board"; optionId: string; glyph?: string; gesture?: Gesture }
  /**
   * A turn in a creature's conversation. The ACT travels, not the board
   * position that chose it: a conversation board's options are indices into the
   * act list THIS player's device projected from the creature, so an index
   * means nothing anywhere else — and the sentence it displays can't be
   * re-derived by parsing, because picking an act never went through the parser
   * in the first place. The act is what the player actually did.
   */
  | { kind: "converse"; cid: string; act: DialogueAct; gesture?: Gesture }
  /**
   * WHAT THIS PLAYER DID TO THEIR PLACE IN A CONVERSATION: they joined creature
   * `cid`'s conversation, they left it, or — ⑫④ — they turned to `cid` and made
   * them the person they are talking TO.
   *
   * OPENING A BOARD is local — it is a view of a conversation, and views live
   * above this line. BELONGING to one is not: the roster lives with the
   * simulation, because the creature answers ITS members, holds one shared
   * memory of the exchange, and projects each member's turn at that member's
   * own syntax level. So a follower relays the membership change and the owner
   * maintains the roster; the per-member state comes back over the mesh as a
   * `convo` message (net.ts).
   *
   * ★ ⑫④ — `address` IS THE LOOK CROSSING THE GATE
   * (conversation-in-motion.md build-order ④). ★
   *
   * `cid` names the FELLOW MEMBER being addressed, not the conversation: the
   * owner resolves the conversation from the SPEAKER's own membership (it holds
   * the roster; the sender does not have to tell it what it already knows), and
   * writes `ConvoMember.addressing` on the speaker's row — the durable answer to
   * "whom is this member talking to" that conversation.ts law 5 built the field
   * for.
   *
   * WHY IT IS AN OP AND NOT A NINTH KIND. It is a fact about this player's place
   * in one conversation, exactly like joining and leaving it, and it belongs on
   * the same variant so the three cannot drift apart. And it is deliberately NOT
   * `attendCreature`: that commands a THIRD PARTY to go and attend somebody
   * (writing a spark row and sending a body across the square), whereas this
   * changes nothing in the world but who the next sentence is said to.
   *
   * ⚠️ DEGRADATION, BY DESIGN. `parsePlayerAction`'s convo arm rejects an op it
   * does not recognise, so an OLD owner drops this action whole rather than
   * guessing at it — and the cost is nil, because the sentence that follows
   * carries its own `Gesture.addressee` (stamped by the gate from this device's
   * own gaze) and the owner honours that as an explicit target. The address is
   * simply not DURABLE against an old owner: it lasts the utterance instead of
   * lasting until the child looks elsewhere.
   */
  | { kind: "convo"; cid: string; op: "join" | "leave" | "address" }
  /** Gaze: send the creature this player is talking to, to this spot. */
  | { kind: "sendTo"; cid: string; x: number; y: number }
  /** Gaze: point it at a thing (need-gated where it lands). */
  | { kind: "attendObject"; cid: string; id: string; x: number; y: number }
  /** Gaze: point it at another person (likewise). */
  | { kind: "attendCreature"; cid: string; id: string }
  /** The player's spark took a body (`null` = let it go). */
  | { kind: "claim"; body: string | null };

/** Every action kind, so a reader can see the whole surface at once. */
export const PLAYER_ACTION_KINDS = [
  "speak", "board", "converse", "convo", "sendTo", "attendObject", "attendCreature", "claim",
] as const;

function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Read a gesture off an untrusted payload. Each part stands alone — a garbled
 *  place doesn't cost you the addressee — and an empty gesture is no gesture. */
function parseGesture(raw: unknown): Gesture | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as { addressee?: unknown; place?: unknown; container?: unknown; spot?: unknown };
  const p = g.place as { x?: unknown; y?: unknown } | undefined;
  const gesture: Gesture = {
    ...(str(g.addressee) ? { addressee: g.addressee } : {}),
    ...(p && num(p.x) && num(p.y) ? { place: { x: p.x, y: p.y } } : {}),
    ...(str(g.container) ? { container: g.container } : {}),
    ...(str(g.spot) ? { spot: g.spot } : {}),
  };
  return Object.keys(gesture).length ? gesture : undefined;
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Parse an untrusted payload into a PlayerAction, or null. Never throws: this
 * arrives from another device, and a half-read instruction must be dropped
 * rather than carried out against whatever the missing field would have named.
 * Unknown kinds return null too — that is version skew, not an error.
 */
export function parsePlayerAction(raw: unknown): PlayerAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const gesture = parseGesture(a.gesture);
  /** Attach the gesture, if there was one, to a parsed utterance. */
  const attach = <T extends Extract<PlayerAction, { gesture?: Gesture }>>(action: T): T =>
    gesture ? { ...action, gesture } : action;
  switch (a.kind) {
    case "speak":
      if (typeof a.sentence !== "string" || !a.sentence.trim()) return null;
      return attach({ kind: "speak", sentence: a.sentence });
    case "board": {
      if (!str(a.optionId)) return null;
      return attach({
        kind: "board",
        optionId: a.optionId,
        ...(str(a.glyph) ? { glyph: a.glyph } : {}),
      });
    }
    case "converse": {
      // The act is the dialogue layer's own record. Checked structurally — it
      // carries a kind and the glyph it speaks; the dialogue evaluator judges
      // the rest against the live world (an act the sender's copy thought was
      // available may honestly answer "I don't have one" here).
      if (!str(a.cid) || !a.act || typeof a.act !== "object") return null;
      const act = a.act as { kind?: unknown; glyph?: unknown };
      if (!str(act.kind) || !str(act.glyph)) return null;
      return attach({ kind: "converse", cid: a.cid, act: a.act as DialogueAct });
    }
    case "convo":
      // A conversation act names a creature AND what happened — an op we don't
      // recognise is version skew, dropped like an unknown kind rather than
      // guessed at (guessing "join" would seat a player in a conversation their
      // device never opened, and guessing "address" would put words in their
      // mouth aimed at somebody they never looked at). ⑫④'s `address` rides
      // this same guard, which is exactly what makes an old owner degrade
      // safely — see the variant's doc.
      if (!str(a.cid) || (a.op !== "join" && a.op !== "leave" && a.op !== "address")) return null;
      return { kind: "convo", cid: a.cid, op: a.op };
    case "sendTo":
      if (!str(a.cid) || !num(a.x) || !num(a.y)) return null;
      return { kind: "sendTo", cid: a.cid, x: a.x, y: a.y };
    case "attendObject":
      if (!str(a.cid) || !str(a.id) || !num(a.x) || !num(a.y)) return null;
      return { kind: "attendObject", cid: a.cid, id: a.id, x: a.x, y: a.y };
    case "attendCreature":
      if (!str(a.cid) || !str(a.id)) return null;
      return { kind: "attendCreature", cid: a.cid, id: a.id };
    case "claim":
      if (typeof a.body !== "string" && a.body !== null) return null;
      return { kind: "claim", body: a.body as string | null };
    default:
      return null;
  }
}
