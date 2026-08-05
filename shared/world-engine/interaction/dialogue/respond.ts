// shared/world-engine/interaction/dialogue/respond.ts
//
// WHO ANSWERS — fuzzy response arbitration for a conversation with more than two
// people in it. (planning-docs/games/world-engine/multi-entity-conversations.md §3c.)
//
// ═══ WHY THIS IS NOT AN `if` ═════════════════════════════════════════════════
// In a dyad the question never came up: somebody said something, the other one
// answered, and the code said so in a straight line. Put three bodies around a
// table and that line becomes a claim nobody can defend — that the SAME creature
// answers every time, instantly, whoever was being looked at, whatever was said,
// however recently it last spoke. Real floors do not work like that. Somebody is
// asked and answers; somebody else jumps in because the question was actually
// about THEIR cookie; a remark to the room lands on nobody and everyone just
// looks up.
//
// So the choice is a WEIGHTED DRAW, and this module produces the weights. Each
// member gets an URGE — one number saying how much it wants to be the one who
// speaks next — and a seeded roulette over `[urges…, SILENCE]` picks. One draw,
// injected rng, so a replay is a replay and two devices agree.
//
// ═══ FOUR THINGS DECIDE AN URGE ══════════════════════════════════════════════
//   ADDRESSED — were the words aimed at ME, at the room, or at somebody else?
//               By far the strongest term, and deliberately so: this is the
//               mechanism that keeps cause and effect learnable. A child speaks
//               to a creature and that creature answers, because being addressed
//               multiplies your urge by 1 while everyone else's is cut to 0.15.
//   ATTEND    — the willingness family's fourth gate (willingness.ts): am I the
//               sort that speaks, do I care who is speaking, am I here right now.
//   CONTENT   — can I answer / does this touch my needs (`relevance`, which the
//               caller computes; `defaultRelevance` below is the stock ladder).
//               Floored at half, because "I have nothing to add" is a reason to
//               be quieter, never a reason to be mute.
//   COURTESY  — I just spoke, so I yield. The one term that decays with TIME,
//               and the reason a conversation circulates instead of becoming two
//               people talking at each other.
//
// ═══ SILENCE IS VISIBLE (non-negotiable) ═════════════════════════════════════
// The outcome "nobody answers" is a legitimate draw, and it is the one outcome
// that must never render as nothing happening. A child who says something and
// gets no response cannot tell "the world heard me and had no answer" from "the
// world is broken" — and for this audience that difference is the whole product.
// So a full silence ALWAYS emits at least one reaction: the addressee (or, for a
// remark to the room, whoever came closest to answering) glances up, or turns
// away if it is hostile. `silent` is never empty while there are candidates.
// This is the same discipline as the `dont-understand` act and voice-policy.ts:
// an explicit not-answering over a silent drop.
//
// ═══ AND THE MIRROR OF IT: WHICH CHANNEL A SPEAKER ADDRESSES THROUGH ═════════
// `chooseAddressChannel` (conversation-in-motion.md ④) is the same shape of
// question asked from the SPEAKER's side — dyad / look / name / floor — and it
// lives here because it draws through the same `attend` gate and the same soft
// edge (`gateProbability`) the urges above are weighted by. One decision, one
// seeded draw, and only when a busy body has something to decide.
//
// ═══ AND THE TERM ALL OF IT IS SCALED BY: `engagement` ═══════════════════════
// `engagementOf` (⑫⑧) is the one input above that is genuinely LIVE — the
// roster's own `engagement` field, which had a reader (this file) long before
// it had a writer. It lives here because it is priced in the same currency as
// everything else on this page: a floor, temperament-shaped, bought back by
// having been addressed on the decay curve `courtesy` already uses.
//
// ═══ WHAT THIS MODULE IS NOT ═════════════════════════════════════════════════
// Pure and world-light. It picks WHO speaks; WHAT they say is the unchanged
// 24-arm `selectAct` under the chosen responder's own perspective. It holds no
// state, mutates nothing, reads no clock and owns no rng — the tick and the draw
// both arrive as parameters.

import {
  itemMatchesNeed,
  knownProvider,
  openNeeds,
  type CreatureId,
  type CreatureNeed,
  type CreatureState,
  type CreatureWorld,
  type ItemState,
  type NeedTarget,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { knowsFact } from "@shared/world-engine/interaction/behavior/facts.js";
import {
  attend,
  gateProbability,
  gateTemperature,
  type Rng,
} from "@shared/world-engine/interaction/behavior/willingness.js";
import type { Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import type { Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import type { ConvoMember, Tick, Utterance } from "@shared/world-engine/interaction/dialogue/conversation.js";
import type {
  DialogueAct,
  DialogueActKind,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0);

// ---------------------------------------------------------------------------
// The tuning block
// ---------------------------------------------------------------------------

/**
 * Every dial this module turns, in one place (the world-tunables.ts convention:
 * a flat, boring, serialisable shape a future per-game settings surface can
 * carry). Nothing here is derived at runtime and nothing here is read from
 * outside except by tests — but a value with no name is a value nobody retunes,
 * and half of these have a pedagogical justification that has to survive the
 * next person who thinks 0.35 looks arbitrary.
 */
export const ARBITRATION = {
  // ── ADDRESSED: how directly the words came at me ─────────────────────────
  /** Aimed at ME by name/gaze/vocative. The reference point — everything else
   *  is a fraction of "you were asked". */
  addressedDirect: 1,
  /** Said to THE FLOOR (no addressee). Anyone may pick it up and nobody owes an
   *  answer; a third of the pull of being asked. Above `addressedOther` because
   *  an open remark genuinely IS an invitation, which a remark to your neighbour
   *  is not. */
  addressedFloor: 0.35,
  /** Aimed at SOMEBODY ELSE. Not zero — barging in is a real thing people do,
   *  and the whole point of a fuzzy model is that a creature holding the very
   *  cookie under discussion can speak up. Small enough that it stays the
   *  exception: this single number is what makes the addressee's ~0.9 hold. */
  addressedOther: 0.15,

  // ── CONTENT: can I answer / does it touch my needs ───────────────────────
  /** The FLOOR under the content term (`content = base + (1−base)·relevance`).
   *  Half, because relevance modulates an urge — it never gags anybody. A
   *  creature with nothing useful to say still says hello back. */
  contentBase: 0.5,

  // ── COURTESY: I just spoke, so I yield ───────────────────────────────────
  /** How much of its urge even an IMPATIENT creature gives up immediately after
   *  speaking. The unconditional part of the yield: nobody answers themselves
   *  twice in a row on reflex. */
  courtesyBase: 0.3,
  /** How much MORE a patient creature yields (`base + this·patience`, so 0.3 at
   *  patience 0 and 0.8 at patience 1). Patience is already the dial for
   *  "forgiving of pauses" (personality.ts), which is exactly the temperament
   *  that lets a silence sit rather than filling it — so a patient creature both
   *  yields harder AND stays yielded longer, since the deeper curve takes more
   *  half-lives to climb back past any given bar. No new dial, per the reasoning
   *  that made `sociability` reuse `generosity`'s formula. */
  courtesyPatience: 0.5,
  /** Decay constant, IN THE CALLER'S OWN TICK UNIT (the `conversation.ts`
   *  convention — sim ticks, never wall time). Four, chosen for a host whose
   *  tick is one sim second, because an NPC turn is due in 0.8–3.5 s (§3f): one
   *  other person's turn buys back roughly half the yield, three turns nearly
   *  all of it. A host counting in something else retunes this. */
  courtesyTicks: 4,

  // ── SILENCE: the weight of nobody answering ──────────────────────────────
  /** `SILENCE_BASE` — the standing weight of the empty chair, against urges that
   *  run 0…1. Small: most things said to a group get picked up by somebody. */
  silenceBase: 0.08,
  /** Multiplier when SOMEBODY WAS DIRECTLY ADDRESSED — silence all but leaves
   *  the wheel. This is the cause-and-effect guarantee in one number: ask a
   *  creature something and it answers, near-always, which is what makes the
   *  world legible to a learner. The doc's "≈0". */
  silenceAddressed: 0.05,
  /** Multiplier when a remark to THE FLOOR interests NOBODY (every urge under
   *  `nobodyCares`). Triples the empty chair, so a room can visibly fail to pick
   *  something up — which is information, not a bug. */
  silenceIgnored: 3,
  /**
   * Below this urge, a member does not really want to answer. Only consulted
   * for the "nobody cares" scaling above.
   *
   * ⚠️ Calibrated against DIRECT urges, and a floor remark can never reach it at
   * neutral dials: `addressedFloor · attend · content` tops out at 0.35 × 0.6 ×
   * 1 = 0.21 for a wholly neutral creature, so an ordinary room lets an ordinary
   * remark drop roughly a third of the time. Clearing the bar takes somebody who
   * is actually keen — expressive, fond of the speaker, or engaged. That is the
   * intended shape (a remark to nobody in particular often lands on nobody in
   * particular), but it is a real behavior and not an accident of the number, so
   * retune it here rather than working around it at a call site.
   */
  nobodyCares: 0.25,

  // ── REACTIONS: what the non-answerers do ─────────────────────────────────
  /** `GLANCE_MIN` — above this urge, a member who did NOT get the floor still
   *  visibly reacts. Sits just under `nobodyCares` so "wanted to answer" and
   *  "cared at all" are the same rough band, read from two directions. */
  glanceMin: 0.2,

  // ── `defaultRelevance`'s ladder ──────────────────────────────────────────
  /** It is about a thing that is MINE — I hold it, or it answers an open need. */
  relevanceMine: 1,
  /** A question I can actually ANSWER (I know the fact / where the thing is). */
  relevanceAnswerable: 0.8,
  /** SMALL TALK — anyone may take it, nobody is uniquely placed to. */
  relevanceSmallTalk: 0.5,
  /** The FLOOR. Never 0: "this has nothing to do with me" still leaves a
   *  creature in the conversation, and a zero here would silently delete the
   *  possibility of a bystander ever speaking. */
  relevanceFloor: 0.1,
} as const;

// ---------------------------------------------------------------------------
// ⑫④ — WHICH CHANNEL TO ADDRESS SOMEBODY THROUGH
// ---------------------------------------------------------------------------

/**
 * The dial the channel choice turns, in the same flat shape as `ARBITRATION`
 * above and for the same reason: a value with no name is a value nobody
 * retunes.
 */
export const ADDRESS_CHANNEL = {
  /**
   * `THE INTERRUPT BAR` — the `attend` score a BUSY creature must clear to stop
   * what it is doing and turn.
   *
   * 0.6 is not arbitrary: it is `attend` at NEUTRAL for a fully engaged member
   * (0.45·0.5 + 0.35·0.5 + 0.2·1), so an ordinary creature toward an ordinary
   * fellow member is a genuine coin flip about whether the conversation is worth
   * putting the work down for — which is exactly the decision this chapter is
   * about. A talkative one (expressiveness 1, engaged) reaches ~0.9 and nearly
   * always turns; a stolid one (0.1) sits at ~0.42 and nearly always keeps
   * working and names them instead. Nobody is fined either way: the two are
   * different CHANNELS, not a success and a failure.
   */
  interruptBar: 0.6,
} as const;

/**
 * HOW SOMEBODY IS ADDRESSED — the four channels of law ② as one answer.
 *
 *   `dyad`   free      exactly one other member; nothing to disambiguate (law ④)
 *   `look`   a beat    the body stops and turns — the LOOK, paid in time
 *   `name`   a slot    a word in the sentence — the channel that survives a
 *                      busy body, which is exactly why learning names is worth
 *                      something to a child
 *   `floor`  —         no channel spent: the line goes to the room, and
 *                      arbitration decides whether anybody picks it up
 */
export type AddressChannel = "dyad" | "look" | "name" | "floor";

export interface AddressChannelInput {
  /** How many OTHER members are in this conversation (the roster minus the
   *  speaker). One ⇒ the dyad exemption; `conversation.ts`'s `soleOther` is the
   *  same test read from the other side. */
  others: number;
  /** Whom the speaker means to address this turn. ABSENT = nobody — a remark to
   *  the room, which buys no channel because it needs none. */
  intended?: CreatureId;
  /** Whom the speaker is ALREADY addressing (`ConvoMember.addressing`, read
   *  live). When it is the same person, the channel was bought on an earlier
   *  turn and is not bought again — that is the whole of what "durable" means. */
  already?: CreatureId;
  /** Is the speaker's body busy — legs or hands already own its heading (law
   *  ①)? Only then is turning a real interruption, and only then is there
   *  anything to decide. */
  busy: boolean;
  /** Does the ACT need a named person to execute (`ADDRESSEE_REQUIRED_ACTS`)?
   *  Passed as a boolean rather than an act kind so this module stays free of
   *  `creature-converse.ts`, which imports it. */
  requiresAddressee: boolean;
  /** The speaker's own dials — `expressiveness` decides whether it is the sort
   *  that stops, `stability` decides how predictable that is (`gateTemperature`). */
  personality: Personality;
  /** The speaker's attitude TOWARD THE INTENDED ADDRESSEE — whether it cares
   *  enough about this particular person to put the work down. */
  relation: Relation;
  /** 0..1 — how much of the speaker's attention this conversation holds. The one
   *  LIVE term in the `attend` family. */
  engagement: number;
  /** REQUIRED, and always seeded (`mulberry32(hashSeed(…))`). Drawn from AT MOST
   *  ONCE, and only in the busy branch — see below. */
  rng: Rng;
}

/**
 * ★ WHICH CHANNEL — the ONE decision of conversation-in-motion ④. ★
 *
 * Asked in this order, first hit wins:
 *
 *   ① ONE OTHER PERSON ⇒ `dyad`. Law ④: there is nothing to disambiguate, so no
 *      channel is needed and none is charged. Asked first and nothing below it
 *      can override it — a dyad NEVER pays.
 *   ② NOBODY IN MIND ⇒ `floor`. The floor is not a channel you buy; it is what
 *      you get when you buy none. (A well-formedness rung: it also keeps the
 *      "already === intended" test below from reading two absences as a match.)
 *   ③ ALREADY ADDRESSING THEM ⇒ `look`, free. The beat was paid on the turn the
 *      body turned, and an address is durable until the speaker looks elsewhere
 *      or moves. Charging it again every turn is the bug that would make a
 *      creature spin in place while it talked.
 *   ④ THE BODY IS FREE ⇒ `look`. It can afford to stop, so it does; the beat is
 *      the price and it is affordable.
 *   ⑤ THE BODY IS BUSY ⇒ ★ THE DRAW ★ — the ONE place this function touches the
 *      rng, and the user's decision in one line: *"a creature must decide if it
 *      is worth stopping its activity to focus on the conversation."* It is the
 *      same soft edge the rest of the willingness family reads its gates through
 *      (`gateProbability` on a logistic centred on the bar, widened by the
 *      creature's own `stability`), over the same `attend` score arbitration
 *      already uses — so an EXPRESSIVE creature interrupts itself to turn and a
 *      STOLID one keeps working. No new machinery, no new dial family.
 *   ⑥ IT KEPT WORKING ⇒ `name` if the act cannot execute without a named person,
 *      else `floor`. This is law ②'s point made mechanical: the name is the
 *      channel that survives a busy body.
 *
 * NO DEFAULT PATH DRAWS (the byte-identity bar, chapter §5): rungs ①–④ return
 * before the rng is touched, so a free body, a dyad and a standing address all
 * leave the seeded stream exactly where they found it.
 *
 * Pure and total: no world, no clock, no state. A second device re-derives the
 * same channel from the same inputs and the same stream.
 */
export function chooseAddressChannel(i: AddressChannelInput): AddressChannel {
  // ① Law ④. `<= 1` rather than `=== 1`: a roster with nobody else in it has
  // even less to disambiguate than a pair, and it must not fall through to a
  // branch that would charge for addressing a person who is not there.
  if (i.others <= 1) return "dyad";
  // ② A remark to the room.
  if (!i.intended) return "floor";
  // ③ Paid already — the durable address.
  if (i.already !== undefined && i.already === i.intended) return "look";
  // ④ A free body turns; that is what a free body is for.
  if (!i.busy) return "look";
  // ⑤ THE DECISION.
  const worthStopping = gateProbability(
    clamp01(attend(i.personality, i.relation, i.engagement)),
    ADDRESS_CHANNEL.interruptBar,
    gateTemperature(i.personality),
  );
  if (i.rng() < worthStopping) return "look";
  // ⑥ It kept working, so the name is the only channel left — where the act
  // needs one at all.
  return i.requiresAddressee ? "name" : "floor";
}

// ---------------------------------------------------------------------------
// ⑫⑧ — HOW MUCH OF A MEMBER'S ATTENTION THE CONVERSATION HOLDS
// ---------------------------------------------------------------------------

/**
 * The dials `engagementOf` turns, in the same flat shape as the two blocks
 * above and for the same reason.
 *
 * 🚨 `busyFloor − temperSpan` MUST STAY ≥ the host's `ENGAGE_MIN` (0.4,
 * quest-host), and that is not a style note. `ENGAGE_MIN` is the bar a
 * creature must clear before the spark will direct it at all
 * (`authorEngagement(...) >= ENGAGE_MIN`), and engagement inside a shared
 * roster is READ OFF THIS FIELD (`engagementToward`). Sink the floor under it
 * and a member who picked something up silently drops out of the child's
 * directable set — the conversation would still list it and the board would
 * still show it, and nothing would happen when the child pointed. `floorMin`
 * is the belt to that pair of braces; the engagement test pins it.
 */
export const ENGAGEMENT = {
  /** Where a NEUTRAL busy member sits (patience === assertiveness). Not a
   *  fraction of anything — the point of the chapter is that a person working
   *  beside you is still IN the conversation, so most of their attention is
   *  still on it. Through `attend`'s 0.2 share this costs a neutral creature
   *  ~13% of its urge to answer: a lean, not a wall. */
  busyFloor: 0.6,
  /** How far `patience − assertiveness` (−1…1) moves that floor. The two dials
   *  already MEAN this: patience is "forgiving of pauses" — the temperament
   *  that lets a conversation sit while its hands work — and assertiveness is
   *  the one that would rather get on with the job. No new dial, per the
   *  reasoning that made `sociability` reuse `generosity`'s formula. */
  temperSpan: 0.15,
  /** THE HARD FLOOR under the floor. See the 🚨 above: this is the number that
   *  must never dip below `ENGAGE_MIN`. */
  floorMin: 0.45,
} as const;

export interface EngagementInput {
  /**
   * Is the member's heading already spoken for — legs walking, hands reaching
   * (law ①, the host's `headingSpokenFor`)? THE ONLY "busy" this module knows
   * about, and deliberately the same predicate the channel choice reads, so
   * the two can never disagree about what a busy body is.
   */
  busy: boolean;
  /** The member's own dials. `patience − assertiveness` widens or narrows the
   *  floor; nothing else here is consulted. */
  personality: Personality;
  /** NOW, in the host's own sim-tick unit — only ever differenced against
   *  `lastAddressedTick`, so the unit never has to be known here. */
  tick: Tick;
  /** When this member was last DIRECTLY addressed (`ConvoMember`). Absent =
   *  nobody has said anything to it in particular, which is not a debt — it
   *  simply buys nothing back. */
  lastAddressedTick?: Tick;
}

/**
 * ★ ⑫⑧ — `ConvoMember.engagement` AS HONEST STATE. ★
 *
 * The field has existed since the roster shipped, has always been read (it is
 * `attend`'s live term, so it flows into every response urge and into the
 * channel choice), and has never once been WRITTEN: every member sat at
 * `DEFAULT_ENGAGEMENT = 1` from join to departure. Its own doc says "how much
 * of this member's attention the conversation holds", and until now the answer
 * was always "all of it", including for the member hauling a crate past you.
 *
 * This is the answer, and it is BOOKKEEPING, not a fine (law ③). Nothing here
 * punishes a working creature and nothing multiplies its work slower — the
 * number simply stops claiming something untrue, and the consequence is that a
 * busy member answers a little less often. Three terms:
 *
 *   ① A FREE BODY IS WHOLLY HERE ⇒ 1. Standing in a circle with nothing else
 *      claiming your heading IS full attention; that is the roster-is-
 *      engagement law (`engagementToward`) read from the inside.
 *   ② A BUSY BODY FALLS TO A FLOOR, NEVER TO ZERO. The floor is the chapter's
 *      premise stated as a number — *a person working beside you is still in
 *      the conversation* — and it is widened by `patience − assertiveness`,
 *      the two dials that already mean exactly this.
 *   ③ …AND BEING ASKED SOMETHING BUYS IT BACK, decaying on
 *      `ARBITRATION.courtesyTicks` — the SAME curve courtesy already uses,
 *      because "somebody just spoke to me" and "I just spoke" are the same
 *      clock read from opposite ends. This gives `lastAddressedTick` — written
 *      since ⑦, read by nothing — its first reader.
 *
 * Pure and total: a weird tick, a missing `lastAddressedTick` and out-of-range
 * dials all produce a number in [`floorMin`, 1] rather than an exception.
 */
export function engagementOf(i: EngagementInput): number {
  // ① Nothing else has a claim on this body.
  if (!i.busy) return 1;
  // ② The floor, temperament-shaped. `patience − assertiveness` runs −1…1, so
  // the span is applied whole in both directions and then held above the bar
  // the spark's directable set is drawn at.
  const temper = clamp01(i.personality.patience) - clamp01(i.personality.assertiveness);
  const floor = Math.max(
    ENGAGEMENT.floorMin,
    Math.min(1, ENGAGEMENT.busyFloor + ENGAGEMENT.temperSpan * temper),
  );
  // ③ What being spoken to recently buys back. A member who was never
  // addressed carries no lift at all — silence is not a debt, exactly as it is
  // not one in `courtesy`.
  if (i.lastAddressedTick === undefined) return floor;
  const since = Math.max(0, i.tick - i.lastAddressedTick);
  const recall = Math.exp(-since / ARBITRATION.courtesyTicks);
  return clamp01(floor + (1 - floor) * recall);
}

// ---------------------------------------------------------------------------
// Response urge
// ---------------------------------------------------------------------------

export interface UrgeInput {
  /** The member being weighed — its `engagement` feeds `attend` and its
   *  `lastSpokeTick` feeds courtesy. */
  member: ConvoMember;
  /** What was just said: who spoke, and at whom (an absent/empty `addresseeIds`
   *  means the FLOOR — see conversation.ts). */
  utterance: Utterance;
  /** NOW, in the host's own sim-tick unit. Only ever differenced against
   *  `member.lastSpokeTick`, so the unit never has to be known here. */
  tick: Tick;
  /** THIS member's intrinsic dials. */
  personality: Personality;
  /** THIS member's directed attitude TOWARD THE SPEAKER (not toward the
   *  addressee — what moves an urge is who is talking to me). */
  relation: Relation;
  /** 0..1 content relevance, caller-computed. `defaultRelevance` below is the
   *  stock ladder; a game with its own notion of "this concerns me" supplies
   *  its own without touching the arbitration math. */
  relevance: number;
}

/**
 * How much this member wants to be the one who speaks next, 0..1.
 *
 *   urge = addressed × attend(personality, relation, engagement)
 *        × (contentBase + (1−contentBase)·relevance)
 *        × courtesy(ticks since I spoke, patience-shaped)
 *
 * A PRODUCT, not a sum, and that is the design: each factor is a veto in
 * miniature. Being ignored, being unable to contribute, being the person who
 * just finished talking — each one alone should quiet a creature down, and a
 * sum would let a single loud term drown the others out.
 *
 * Total by construction: a weird tick, a missing `lastSpokeTick`, an
 * out-of-range relevance and a member who was never addressed all produce a
 * number in [0,1] rather than an exception. This runs on every member on every
 * utterance; it is not a place to throw.
 */
export function responseUrge(i: UrgeInput): number {
  // Nobody answers themselves. Courtesy alone would only DAMPEN the speaker
  // (it just spoke, so the decay term is at full depth) — but "dampened" is not
  // the law. A creature is never a candidate to reply to its own words, and
  // saying so here means no caller has to remember to filter.
  if (i.member.id === i.utterance.speakerId) return 0;

  const addressed = addressedWeight(i.member.id, i.utterance);
  const gate = clamp01(attend(i.personality, i.relation, i.member.engagement));
  const content = ARBITRATION.contentBase + (1 - ARBITRATION.contentBase) * clamp01(i.relevance);
  return clamp01(addressed * gate * content * courtesy(i.member, i.tick, i.personality));
}

/** 1.0 aimed at me · 0.35 to the floor · 0.15 aimed at somebody else. An empty
 *  `addresseeIds` reads as the floor, matching `recordUtterance`'s
 *  normalization — a caller that builds one either way gets one meaning. */
function addressedWeight(id: CreatureId, u: Utterance): number {
  const to = u.addresseeIds;
  if (!to || to.length === 0) return ARBITRATION.addressedFloor;
  return to.includes(id) ? ARBITRATION.addressedDirect : ARBITRATION.addressedOther;
}

/**
 * The yield after speaking: `1 − depth·exp(−since/courtesyTicks)`, where depth
 * is `courtesyBase + courtesyPatience·patience`.
 *
 * A member who has NEVER spoken carries no penalty at all (factor 1) — silence
 * so far is not a debt, and the newcomer to a circle should be the readiest to
 * answer, not the least. A negative `since` (a peer's utterance delivered late,
 * so the member's last word looks like it is in the future) is clamped to 0 and
 * therefore reads as "just spoke", which is the conservative direction: at worst
 * a creature is briefly too polite.
 */
function courtesy(member: ConvoMember, tick: Tick, personality: Personality): number {
  if (member.lastSpokeTick === undefined) return 1;
  const since = Math.max(0, tick - member.lastSpokeTick);
  const depth = ARBITRATION.courtesyBase + ARBITRATION.courtesyPatience * clamp01(personality.patience);
  return clamp01(1 - depth * Math.exp(-since / ARBITRATION.courtesyTicks));
}

// ---------------------------------------------------------------------------
// Arbitration
// ---------------------------------------------------------------------------

/**
 * What a non-answering member does with its face.
 *
 * v1 produces `glance` and `turn-away` only. `nod` and `shrug` are declared
 * because the renderer's vocabulary is a contract and adding a member to a union
 * later churns every consumer — but no rule below emits them, and inventing one
 * ("a low urge shrugs") would be a behavior nobody designed. They are here to be
 * wired deliberately.
 */
export type SilentReactionKind = "glance" | "nod" | "shrug" | "turn-away";

export interface SilentReaction {
  id: CreatureId;
  kind: SilentReactionKind;
}

export interface ResponderChoice {
  /** Whoever gets the floor. ABSENT = full silence — which is an OUTCOME, not a
   *  failure, and `silent` is guaranteed non-empty when there were candidates. */
  responderId?: CreatureId;
  /** Everyone who reacted without speaking, in candidate order. A chosen
   *  responder NEVER appears here: it is answering, which is not a silence. */
  silent: SilentReaction[];
}

export interface ResponseCandidate {
  id: CreatureId;
  /** From `responseUrge` (or a caller's own weighting). Clamped here. */
  urge: number;
  /** Does this member regard the speaker with hostility? Only consulted for the
   *  full-silence reaction: a hostile creature that will not answer TURNS AWAY
   *  rather than glancing up, so the refusal reads as a refusal. The caller owns
   *  the threshold (affinity is a continuum; "hostile" is a game's call). */
  hostile?: boolean;
}

/**
 * Pick who answers — ONE seeded draw over `[…urges, SILENCE]`.
 *
 * Deterministic given the rng: exactly one call to `opts.rng()` per invocation,
 * whatever the roster size, so a caller stepping a stream stays in step with
 * every other device replaying it. (That is also why the reaction set is derived
 * rather than rolled — every extra draw is another thing to keep synchronized.)
 *
 * `addressedIds` is passed separately from the candidate list because the two
 * answer different questions: the candidates are who COULD speak, the addressees
 * are who was SPOKEN TO, and an addressee may be neither a candidate nor even
 * still present. Note the corollary: "someone was directly addressed" is read
 * off the utterance, so if the addressee has since left the roster, silence
 * still shrinks and a bystander picks the question up. That is the intended
 * reading for now (somebody has to answer); if a departed addressee should
 * instead re-open the floor, that is a deliberate change here, not a caller fix.
 */
export function arbitrateResponse(
  candidates: ReadonlyArray<ResponseCandidate>,
  opts: { addressedIds?: readonly CreatureId[]; rng: () => number },
): ResponderChoice {
  // Nobody to ask. Not a silence — a silence needs someone to be silent.
  if (candidates.length === 0) return { silent: [] };

  const urges = candidates.map((c) => clamp01(c.urge));
  const directlyAddressed = (opts.addressedIds?.length ?? 0) > 0;
  const ignored = !directlyAddressed && urges.every((u) => u < ARBITRATION.nobodyCares);
  const silence =
    ARBITRATION.silenceBase *
    (directlyAddressed
      ? ARBITRATION.silenceAddressed
      : ignored
        ? ARBITRATION.silenceIgnored
        : 1);

  const pick = roulette([...urges, silence], opts.rng);
  const responderId = pick < candidates.length ? candidates[pick]!.id : undefined;

  return {
    ...(responderId !== undefined ? { responderId } : {}),
    silent: reactions(candidates, urges, responderId, opts.addressedIds),
  };
}

/**
 * Weighted index. The SILENCE slot is last, and it is also the fallback for both
 * degenerate cases — a zero total (no urges and, impossibly, no silence weight)
 * and float drift at the very top of the range. Falling back to silence rather
 * than to a member is the safe direction: an unearned answer is a lie about the
 * world, an extra silence is merely quiet — and a visible one, at that.
 */
function roulette(weights: readonly number[], rng: () => number): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return weights.length - 1;
  let roll = clamp01(rng()) * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]! > 0 ? weights[i]! : 0;
    roll -= w;
    // Strict `<` so a zero-weight entry can never win, even on a roll of 0.
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

/**
 * Who visibly reacts, and how. Two rules, in this order:
 *
 *   1. Anyone who WANTED the floor and did not get it (urge above `glanceMin`)
 *      glances. Cheap, and it is what makes a group read as a group: three
 *      people look up, one of them speaks.
 *   2. THE LAW — on a full silence, the addressee always reacts (hostile ⇒
 *      turn away, else glance). Falls back to the highest-urge member when the
 *      words went to the floor or the addressee is not among the candidates, so
 *      the result is never empty while anybody is present.
 *
 * Rule 2 overwrites rule 1 for the same member, which is the right precedence:
 * a hostile addressee turning away is a stronger and more specific statement
 * than the generic glance it would otherwise have earned.
 */
function reactions(
  candidates: ReadonlyArray<ResponseCandidate>,
  urges: readonly number[],
  responderId: CreatureId | undefined,
  addressedIds: readonly CreatureId[] | undefined,
): SilentReaction[] {
  const kinds = new Map<CreatureId, SilentReactionKind>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.id === responderId) continue;
    if (urges[i]! > ARBITRATION.glanceMin) kinds.set(c.id, "glance");
  }

  if (responderId === undefined) {
    const focus = silenceFocus(candidates, urges, addressedIds);
    if (focus) kinds.set(focus.id, focus.hostile ? "turn-away" : "glance");
  }

  // Candidate order, which the host keeps deterministic (`(joinedTick, id)`).
  const out: SilentReaction[] = [];
  for (const c of candidates) {
    const kind = kinds.get(c.id);
    if (kind) out.push({ id: c.id, kind });
  }
  return out;
}

/** The member a full silence hangs on: the first ADDRESSEE that is present,
 *  else the one who came closest to answering. Ties go to the earlier candidate
 *  (strict `>`), so the pick is a function of the roster order alone. */
function silenceFocus(
  candidates: ReadonlyArray<ResponseCandidate>,
  urges: readonly number[],
  addressedIds: readonly CreatureId[] | undefined,
): ResponseCandidate | undefined {
  for (const id of addressedIds ?? []) {
    const hit = candidates.find((c) => c.id === id);
    if (hit) return hit;
  }
  let best: ResponseCandidate | undefined;
  let bestUrge = -1;
  for (let i = 0; i < candidates.length; i++) {
    if (urges[i]! > bestUrge) {
      bestUrge = urges[i]!;
      best = candidates[i]!;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The stock relevance ladder
// ---------------------------------------------------------------------------

export interface RelevanceOpts {
  /**
   * Does this member know the PLACE a directions question names? Place-facts are
   * the host's (`askDirections` is a projection hook for exactly this reason —
   * see creature-dialogue.ts), and this layer cannot see them without importing
   * a world it has no business knowing about. Absent hook ⇒ "can't tell", and a
   * can't-tell drops the question to the floor rung rather than inventing an
   * answer.
   */
  knowsPlace?: (subjectId: string, memberId: CreatureId) => boolean;
}

/**
 * Small talk — acts anyone present may pick up, and nobody is uniquely placed
 * to. `bye` and `invite` sit here because they DO want an answer from whoever
 * is there, they just do not want it from a particular person.
 *
 * ⚠️ There is no `greet` kind today: a greeting arrives as `how-are-you` (the
 * vocative slice of §4 binds the addressee, not a new act). When a distinct
 * greeting act lands, it belongs in this set.
 */
const SMALL_TALK: ReadonlySet<DialogueActKind> = new Set<DialogueActKind>([
  "how-are-you",
  "tell",
  "tell-fact",
  "invite",
  "bye",
]);

/**
 * The stock answer to "does this concern me?", 0..1 — four rungs, asked in
 * order, first hit wins:
 *
 *   1.0  IT IS ABOUT SOMETHING OF MINE. The act names a thing I hold, or a
 *        thing that answers an open need of mine. Both halves matter and they
 *        are the two sides of the same coin: "give me the cookie" concerns
 *        whoever HAS the cookie, and "I have a cookie" concerns whoever WANTS
 *        one. Requests and offers are the motivating cases; the test is written
 *        against the named item rather than the act kind, so a `where-is` about
 *        the thing in my hand lands here too — which is correct, and a kind
 *        whitelist would have missed it.
 *   0.8  A QUESTION I CAN ANSWER. Knowing the answer is the second-strongest
 *        claim on the floor after owning the subject. Strictly what the
 *        dialogue layer would actually resolve — `knowsFact` for `ask-fact`,
 *        the known location or the known provider for `where-is` — so this
 *        never promises a reply the 24-arm evaluator would then have to walk
 *        back with "I don't know".
 *   0.5  SMALL TALK. An invitation to anyone.
 *   0.1  THE FLOOR. Menu navigation, an act aimed at machinery, a kind this
 *        ladder has never heard of. Deliberately not 0 — see `relevanceFloor`.
 *
 * BEST-EFFORT AND TOTAL. An unknown member, an item that no longer exists, a
 * query shape from a future act — every one of them returns the floor. This is
 * called for every member on every utterance, on the sim tick; a throw here
 * would take a conversation down over a stale id.
 */
export function defaultRelevance(
  world: CreatureWorld,
  memberId: CreatureId,
  act: DialogueAct,
  opts: RelevanceOpts = {},
): number {
  const member = world?.creatures?.[memberId];
  if (!member || !act) return ARBITRATION.relevanceFloor;
  if (namesMyThing(world, member, act)) return ARBITRATION.relevanceMine;
  if (canAnswer(world, member, act, opts)) return ARBITRATION.relevanceAnswerable;
  if (SMALL_TALK.has(act.kind)) return ARBITRATION.relevanceSmallTalk;
  return ARBITRATION.relevanceFloor;
}

/** Rung 1: does the act name a thing I hold, or a thing I want? */
function namesMyThing(world: CreatureWorld, member: CreatureState, act: DialogueAct): boolean {
  const needs = openNeeds(member);
  const mine = (item: ItemState): boolean =>
    item.ownerId === member.id || needs.some((n) => itemMatchesNeed(n, item));

  if (act.itemId) {
    const item = world.items[act.itemId];
    if (item) {
      if (mine(item)) return true;
    } else if (needs.some((n) => n.itemId === act.itemId)) {
      // The instance is gone from the world (or never was) but a need names it
      // by id — the act is still about the thing I am after.
      return true;
    }
  }

  // A SORT reference ("give me food") — resolved the way the where-is arm does
  // it, with a throwaway need carrying the target as its predicate. One pass
  // over the items, early exit; conversations are small and this runs per
  // member per utterance, not per frame.
  if (act.target) return sortTouchesMe(world, member, act.target, needs);
  return false;
}

function sortTouchesMe(
  world: CreatureWorld,
  member: CreatureState,
  target: NeedTarget,
  needs: readonly CreatureNeed[],
): boolean {
  const probe: CreatureNeed = { itemId: "", value: 0, target };
  for (const item of Object.values(world.items)) {
    if (!itemMatchesNeed(probe, item)) continue;
    if (item.ownerId === member.id) return true;
    if (needs.some((n) => itemMatchesNeed(n, item))) return true;
  }
  return false;
}

/** Rung 2: is this a question whose answer I actually hold? */
function canAnswer(
  world: CreatureWorld,
  member: CreatureState,
  act: DialogueAct,
  opts: RelevanceOpts,
): boolean {
  switch (act.kind) {
    case "ask-fact":
      return !!act.query && knowsFact(world, member.id, act.query) !== null;

    case "where-is": {
      // An INSTANCE question: do I know where that thing is?
      if (act.itemId && member.knowledge[act.itemId]) return true;
      if (!act.target) return false;
      // A SORT question follows the same fallback chain the where-is arm walks:
      // a known instance matching the predicate, else a known PROVIDER.
      if (knownProvider(member, [act.target.kind, act.target.category])) return true;
      const probe: CreatureNeed = { itemId: "", value: 0, target: act.target };
      for (const id of Object.keys(member.knowledge)) {
        const item = world.items[id];
        if (item && itemMatchesNeed(probe, item)) return true;
      }
      return false;
    }

    case "ask-directions":
    case "directions-pick":
      return !!act.subjectId && (opts.knowsPlace?.(act.subjectId, member.id) ?? false);

    case "what-doing":
      // "What is the dog doing?" — the dog is the one who can say. An absent
      // `about.id` is the broad ask, which nobody is uniquely placed to answer.
      return act.about?.id === member.id;

    default:
      return false;
  }
}
