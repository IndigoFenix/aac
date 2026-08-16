// shared/world-engine/interaction/dialogue/conversation.ts
//
// THE CONVERSATION — shared context that lives APART from any one member.
//
// ═══ WHY THIS IS AN ENTITY AND NOT A PAIR ════════════════════════════════════
// Everything upstream of this file still speaks in dyads: `projectDialogue(world,
// creature, player)` takes a positional pair, `ConversationMemo` is per-device
// presentation state, `RenderIntent.conversation` is a hard `{a, b}` 2-tuple.
// That arity is the bug. A conversation is not a property of the creature you
// happen to be facing — it is a THING in the world, with a roster, a floor, a
// memory of what has been said, and a life of its own that outlasts any single
// participant. Two players can talk to one shopkeeper; three NPCs can hold a
// circle; somebody can walk away mid-sentence and the circle keeps talking.
// (planning-docs/games/world-engine/multi-entity-conversations.md §3a.)
//
// Five laws are baked into the shapes below, and each one exists because the
// obvious implementation gets it wrong:
//
//   1. A MEMBER LEAVING NEVER DESTROYS STATE OTHERS ARE USING.
//      Today `closeCreatureConvo` deletes the shared record when ANY device
//      closes its view, so one player walking away wipes the conversation out
//      from under everyone else. `leaveConversation` therefore drops exactly two
//      things — the member row and the pair memos that named it — and touches
//      neither `history`, nor `context`, nor `revealed`. Those belong to the
//      conversation, not to whoever happened to trigger them.
//
//   2. THE WORLD HOLDS EVERY RUNG AT ONCE.
//      `level` is PER MEMBER, not per conversation. Two students in one circle
//      keep their own syntax tiers: the same creature line renders as one-word,
//      two-word or full-sentence depending on WHO is being rendered for. A
//      conversation-wide level would quietly demote the more able speaker (or
//      overshoot the less able one) the moment they shared a room, which is the
//      precise failure the leveled projection was built to avoid.
//
//   3. DETERMINISTIC MEMBER ORDER.
//      `members` is kept sorted by `(joinedTick, id)` at all times, so every
//      iteration — arbitration, ring-slot assignment, seeded rolls, wire
//      snapshots — visits the roster in the same order on every device and on
//      every replay of the same seed. Join order alone is not enough: two
//      devices can deliver joins in different orders on the same tick, and the
//      `id` tiebreak is what makes that unobservable.
//
//   4. SPOKEN ALOUD = EVERYONE PRESENT HEARD IT.
//      `revealed` is a property of the CONVERSATION, not of a listener's private
//      memo. A hidden need coaxed out by one member's small talk is out; the
//      other four members do not each have to ask again. (Prices are the
//      opposite case and stay per-pair — see `PairMemos`.)
//
//   5. AN ADDRESS IS DURABLE, AND IT NEVER DANGLES.
//      "Whom am I talking to" is a FACT about a member that outlives the
//      sentence that set it (conversation-in-motion.md ④ — an address lasts
//      until you look elsewhere or until you move; there is no timeout, because
//      both expiries are things somebody DID). So it is a field on the row,
//      `addressing`, and not something re-derived per utterance from whatever
//      the body happens to be pointed at. The cost of durability is that it can
//      outlive its target: `leaveConversation` therefore clears every OTHER
//      member's pointer at the departing one, exactly as it drops that member's
//      pair memos, and `addressingOf` re-checks membership on every READ so a
//      pointer written a tick before a departure can never resurrect it.
//      Law ④'s other half is `soleOther`: in a conversation of two there is
//      nothing to disambiguate, so no channel is needed and none is charged.
//
// ═══ WHAT THIS MODULE IS NOT ═════════════════════════════════════════════════
// Pure bookkeeping. It decides nothing: not who may join, not who answers, not
// what anyone says. Formation, arbitration and phrasing live in their own
// modules (`conversation-form.ts`, `respond.ts`, `creature-dialogue.ts`); this
// file only records what happened so those can be written without a world.
// It imports TYPES only — no world, no host, no clock, no RNG.
//
// ═══ MUTATION IN PLACE ═══════════════════════════════════════════════════════
// The host owns the instances (`conversations: Map<ConversationId,
// ConversationState>`) and these functions mutate them in place, following the
// `RelationBook` convention used everywhere else in the behavior layer rather
// than returning fresh objects. Reducer purity would buy nothing here — nothing
// diffs conversations — and would cost a copy per utterance on the sim tick.

import type { CreatureId, ItemId } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { SyntaxLevel } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import type { DialogueAct } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

export type ConversationId = string;

/**
 * SIM-CLOCK ticks — never wall time. Conversation timing has to survive a
 * paused tab, a space-time compression window and a deterministic replay, none
 * of which `Date.now()` survives. The unit is whatever the host counts in; this
 * module only ever compares and subtracts, so it never needs to know.
 */
export type Tick = number;

export interface ConvoMember {
  id: CreatureId;
  /** When this member joined — the primary key of the deterministic order. */
  joinedTick: Tick;
  /** THIS member's syntax rung (law 2). Never conversation-wide. */
  level: SyntaxLevel;
  /** 0..1 — how much of this member's attention the conversation holds. Feeds
   *  the response-urge `attend` gate and the idle-lapse rule. */
  engagement: number;
  /**
   * WHOM THIS MEMBER IS TALKING TO (law 5) — the durable answer, and the only
   * one anybody else on the roster can see. Absent = the FLOOR: whatever this
   * member says next is said to the room, and arbitration decides whether
   * anybody picks it up.
   *
   * Written by the host when a channel is actually spent (a look that cost a
   * beat, a name that cost a glyph slot) — never as a side effect of which way a
   * body happens to be pointed, because a board's aim is not a sentence's
   * addressee. READ through `addressingOf`, never off the row: a target that has
   * since left the conversation is not somebody you are talking to.
   */
  addressing?: CreatureId;
  /** Last tick this member SPOKE — courtesy decay ("I just talked"). */
  lastSpokeTick?: Tick;
  /** Last tick this member was DIRECTLY addressed — the strongest single input
   *  to whether they are the one expected to answer. */
  lastAddressedTick?: Tick;
}

export interface Utterance {
  /** Monotone per conversation. The seeded-RNG stream keys on it, so it must be
   *  assigned here (by `recordUtterance`) and never by a caller. */
  seq: number;
  tick: Tick;
  speakerId: CreatureId;
  /** ABSENT = spoken to the floor: no one member owes an answer, and everyone
   *  overhears. An empty array means the same thing and is normalized away. */
  addresseeIds?: CreatureId[];
  act: DialogueAct;
}

/**
 * What the conversation has most recently been ABOUT. Recorded now, consumed
 * later: the "it"/"there" pronouns these slots exist for are language-expansion
 * work, and the slot has to be filled before the word can point at anything.
 */
export interface ConvoContext {
  lastMentionedItem?: ItemId;
  lastMentionedCreature?: CreatureId;
  /** A place-fact SUBJECT id (the directions channel's currency), not geometry. */
  lastMentionedPlace?: string;
}

/**
 * PER-PAIR state, keyed `${ownerId}>${askerId}`.
 *
 * A price is quoted TO SOMEBODY. "Bring me the cookie and it's yours" said to
 * Ann is not a standing offer Ben can walk up and collect on — that is how a
 * shared price turns into a duplication exploit, and it is why this one field
 * did not follow `revealed` onto the conversation.
 *
 * ⚠️ Ids must not contain `>` (the key separator). Every id in this engine is a
 * generated node id, a species word, or `player[:<personId>]`, none of which do.
 */
export type PairMemos = Record<string, { statedPrice?: { kind: "need" | "return"; itemId: ItemId } }>;

export interface ConversationState {
  id: ConversationId;
  /** Sorted by `(joinedTick, id)` — invariant, maintained on every join. */
  members: ConvoMember[];
  /** Ring buffer, most recent LAST, capped at `HISTORY_CAP`. */
  history: Utterance[];
  context: ConvoContext;
  /** Creatures whose hidden need was spoken ALOUD here (law 4). */
  revealed: Record<CreatureId, true>;
  pairs: PairMemos;
  lastActivityTick: Tick;
  nextSeq: number;
}

/**
 * How many utterances a conversation remembers.
 *
 * Deliberately small. This is not a transcript — it is the working memory a
 * reply needs (who just spoke, what was just asked, has this already been
 * answered). Anything that must outlive the exchange belongs in knowledge
 * (`facts.ts`) or in the relation, both of which persist properly; letting the
 * ring grow instead would put an unbounded array on every conversation in the
 * world and tempt callers into treating it as durable memory.
 */
export const HISTORY_CAP = 16;

/**
 * Default silence after which a conversation counts as over, IN THE CALLER'S
 * OWN TICK UNIT — this module cannot know the host's tick rate, so it does not
 * pretend to. The value is 30, chosen for a host whose tick is one sim SECOND
 * (~30 s of nobody saying anything is a conversation that has ended, not a
 * pause). A host counting in anything else passes its own `ttl`.
 */
export const DEFAULT_IDLE_TTL: Tick = 30;

/** Joining IS engagement — the roster is the mutual-attention record (§3f). */
export const DEFAULT_ENGAGEMENT = 1;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function createConversation(id: ConversationId, tick: Tick): ConversationState {
  return {
    id,
    members: [],
    history: [],
    context: {},
    revealed: {},
    pairs: {},
    lastActivityTick: tick,
    nextSeq: 0,
  };
}

/** `(joinedTick, id)` — total, so the order is identical on every device. */
function memberOrder(a: ConvoMember, b: ConvoMember): number {
  if (a.joinedTick !== b.joinedTick) return a.joinedTick - b.joinedTick;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Add a member — IDEMPOTENT.
 *
 * A re-join is a no-op that hands back the row already there. It does not reset
 * the member's `level` (a rejoin must never demote a student mid-conversation),
 * its engagement, or anything the conversation holds in common. Joins arrive
 * from three uncoordinated places — a dwell, a mesh `convo` message and the
 * formation tick — and any of them may fire on a member who is already in; the
 * only safe reading of "join" is "make sure they are here".
 *
 * To CHANGE a member's level or engagement, mutate the returned row. That is a
 * deliberate act with a deliberate call site, not a side effect of joining.
 */
export function joinConversation(
  c: ConversationState,
  id: CreatureId,
  tick: Tick,
  level: SyntaxLevel,
  opts?: { engagement?: number },
): ConvoMember {
  const existing = memberOf(c, id);
  if (existing) return existing;
  const member: ConvoMember = {
    id,
    joinedTick: tick,
    level,
    engagement: opts?.engagement ?? DEFAULT_ENGAGEMENT,
  };
  c.members.push(member);
  c.members.sort(memberOrder);
  return member;
}

/**
 * Remove a member, the pair memos INVOLVING it (a price quoted to somebody who
 * left is not owed to whoever arrives next, and a departed quoter's terms die
 * with them), and every ADDRESS POINTED AT IT (law 5 — a durable address must
 * never dangle; the same discipline, for the same reason).
 *
 * Everything else is untouched, by law 1: history, context and `revealed` are
 * the conversation's, and the remaining members are still using them. Nor does
 * this bump `lastActivityTick` — leaving is not talking, and a conversation
 * abandoned by everyone should idle out on the tick it went quiet, not be kept
 * artificially alive by its own dissolution.
 *
 * The departing member's OWN `addressing` needs no clearing: the row goes with
 * it, and a rejoin builds a fresh one (`joinConversation`). Whom you were
 * talking to before you walked off is not a fact about the conversation you
 * walked back into.
 */
export function leaveConversation(c: ConversationState, id: CreatureId): void {
  const i = c.members.findIndex((m) => m.id === id);
  if (i >= 0) c.members.splice(i, 1);
  for (const m of c.members) {
    if (m.addressing === id) delete m.addressing;
  }
  for (const key of Object.keys(c.pairs)) {
    const [ownerId, askerId] = splitPairKey(key);
    if (ownerId === id || askerId === id) delete c.pairs[key];
  }
}

export function memberOf(c: ConversationState, id: CreatureId): ConvoMember | undefined {
  return c.members.find((m) => m.id === id);
}

/**
 * ★ THE DYAD EXEMPTION (conversation-in-motion.md law ④). ★
 *
 * The one other member of a two-person conversation, or undefined. Every
 * addressing rule in the engine asks this FIRST and stops if it answers: with
 * exactly one other person there is nothing to disambiguate, so no channel is
 * needed and none is charged. Every rule in that chapter is a rule about the
 * THIRD person.
 *
 * The size test comes first and is the only thing that can rule the exemption
 * out, so a speaker who is NOT on the roster — the world shouting into a pair, a
 * bodiless author — still gets an answer: the first of the two in the
 * conversation's own `(joinedTick, id)` order (law 3), which makes the pick
 * identical on every device and every replay. That is deliberate. A pair being
 * spoken at from outside is still a pair, and picking the deterministic senior
 * member is a better answer than pretending a two-person room is ambiguous.
 */
export function soleOther(c: ConversationState, speakerId: CreatureId): CreatureId | undefined {
  if (c.members.length !== 2) return undefined;
  return c.members.find((m) => m.id !== speakerId)?.id;
}

/**
 * WHOM THIS MEMBER IS TALKING TO, if that is still a live fact (law 5).
 *
 * A LIVE READ, on purpose: the pointer is only answered while its target is
 * still on the roster, so no caller can resurrect a stale one between the tick a
 * member walks off and the tick the host notices. `leaveConversation` clears
 * these too — belt and braces, because the two go wrong in different ways (a
 * cleared pointer survives a serialization round-trip; a live check survives a
 * departure nobody routed through `leaveConversation`).
 */
export function addressingOf(c: ConversationState, memberCid: CreatureId): CreatureId | undefined {
  const target = memberOf(c, memberCid)?.addressing;
  return target !== undefined && memberOf(c, target) ? target : undefined;
}

/** Is this conversation over? `tick - lastActivityTick >= ttl` — the boundary
 *  tick itself counts as expired, so a caller polling once per tick cannot slip
 *  past it. */
export function conversationIdle(c: ConversationState, tick: Tick, ttl: Tick = DEFAULT_IDLE_TTL): boolean {
  return tick - c.lastActivityTick >= ttl;
}

// ---------------------------------------------------------------------------
// Utterances
// ---------------------------------------------------------------------------

/**
 * Record something said. The single write path for `history`, `nextSeq`,
 * `lastActivityTick`, the speaking/addressed bookkeeping and `context` — every
 * one of those has to move together or the conversation drifts out of step with
 * itself.
 *
 * A speaker who is not on the roster is still recorded in history (the world may
 * shout into a circle), but gains no member bookkeeping — this function never
 * silently enrolls anybody. Joining is `joinConversation`, always.
 */
export function recordUtterance(c: ConversationState, u: Omit<Utterance, "seq">): Utterance {
  const addressees = u.addresseeIds && u.addresseeIds.length ? u.addresseeIds : undefined;
  const utterance: Utterance = {
    seq: c.nextSeq++,
    tick: u.tick,
    speakerId: u.speakerId,
    ...(addressees ? { addresseeIds: [...addressees] } : {}),
    act: u.act,
  };

  c.history.push(utterance);
  while (c.history.length > HISTORY_CAP) c.history.shift();

  // Monotone: a late-delivered utterance from a peer must never rewind the
  // idle clock into the past and expire a live conversation.
  if (u.tick > c.lastActivityTick) c.lastActivityTick = u.tick;

  const speaker = memberOf(c, u.speakerId);
  if (speaker) speaker.lastSpokeTick = u.tick;
  for (const id of addressees ?? []) {
    const m = memberOf(c, id);
    if (m) m.lastAddressedTick = u.tick;
  }

  noteContext(c.context, u.act);
  return utterance;
}

/**
 * A hidden need was spoken ALOUD (law 4) — everyone present heard it, so this is
 * conversation state and not the asker's private memo.
 *
 * It is an EXPLICIT call rather than something inferred inside `recordUtterance`
 * because the revealing utterance is the ANSWER to `how-are-you`, and an answer
 * is not a `DialogueAct` — acts are what a speaker may CHOOSE to say, and the
 * reply comes back through `ActResult`. Inferring the reveal from the question
 * would mark a need revealed the moment it was asked about, whether or not the
 * creature actually gave it up.
 */
export function markRevealed(c: ConversationState, creatureId: CreatureId): void {
  c.revealed[creatureId] = true;
}

/**
 * What the conversation is now ABOUT, read off the act.
 *
 * Only fields that genuinely exist on `DialogueAct` are consulted — the point of
 * these slots is that a later "it" can point at something real, and a slot
 * filled from an invented field points at nothing:
 *
 *   `itemId`    — every act that names a thing (request/offer/refuse/cant/
 *                 trade/trade-pick/where-is) carries it.
 *   `subjectId` — a place-fact subject: ask-directions, directions-pick, and a
 *                 where-is that answers with a SOURCE ("where do I get food").
 *   `about.id`  — what-doing's resolved subject creature ("what is the dog
 *                 doing"); an absent `id` means no such creature, so nothing is
 *                 mentioned.
 *   `query`/`fact` — ask-fact / tell-fact name their subject inside the
 *                 knowledge shape (facts.ts), which is where the item or the
 *                 creature actually is for those two arms.
 */
function noteContext(ctx: ConvoContext, act: DialogueAct): void {
  if (act.itemId) ctx.lastMentionedItem = act.itemId;
  if (act.subjectId) ctx.lastMentionedPlace = act.subjectId;
  if (act.about?.id) ctx.lastMentionedCreature = act.about.id;

  const q = act.query;
  if (q) {
    switch (q.kind) {
      case "location":
      case "whoHas":
      case "itemState":
        ctx.lastMentionedItem = q.item;
        break;
      case "condition":
      case "presence":
      case "want":
        ctx.lastMentionedCreature = q.creature;
        break;
      default:
        break; // stateSearch / conditionSearch name a VALUE, not a subject
    }
  }

  const f = act.fact;
  if (f) {
    switch (f.kind) {
      case "location":
      case "itemState":
        ctx.lastMentionedItem = f.item;
        break;
      case "want":
        ctx.lastMentionedCreature = f.creature;
        ctx.lastMentionedItem = f.item;
        break;
      case "condition":
        ctx.lastMentionedCreature = f.creature;
        break;
      case "presence":
        ctx.lastMentionedCreature = f.creature;
        ctx.lastMentionedPlace = f.place;
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Pair memos
// ---------------------------------------------------------------------------

export function pairKey(ownerId: CreatureId, askerId: CreatureId): string {
  return `${ownerId}>${askerId}`;
}

function splitPairKey(key: string): [CreatureId, CreatureId] {
  const i = key.indexOf(">");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

/**
 * The memo the OWNER holds about this ASKER — created empty on first touch.
 *
 * Directional on purpose: what Ann quoted Ben is not what Ben quoted Ann, and
 * the two must never share a row. Get-or-create because every call site wants to
 * write into it; an `undefined` return would only ever be followed by the same
 * three lines of set-up.
 */
export function pairMemo(
  c: ConversationState,
  ownerId: CreatureId,
  askerId: CreatureId,
): PairMemos[string] {
  const key = pairKey(ownerId, askerId);
  return (c.pairs[key] ??= {});
}
