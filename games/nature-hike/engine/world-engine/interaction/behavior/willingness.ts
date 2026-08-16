// shared/world-engine/interaction/behavior/willingness.ts
//
// The GENEROSITY GATE (semantic-behavior.md §4b) — one shared, pure decision for
// "will this creature part with an item it holds?", used by BOTH a direct REQUEST
// ("give me X") and a where-is treated as a SEMI-REQUEST ("where is X" = "how do I
// get X"). The answer is give / redirect / decline, weighted by ownership + the
// ledger + who the asker IS — the WANT-side mirror of `compliance` (relations.ts):
// compliance gates DO (obey a command), generosity gates WANT (give what's asked).
//
// Layering: `requestItem` (creatures.ts) is the FOUNDATION and stays debt-only
// (consent by settlement). This module sits ABOVE creatures + relations + personality
// (which creatures.ts can't import without a cycle) and is what the dialogue layer
// calls to add the relational/dispositional path on top of bare consent. Pure +
// deterministic (no AMBIENT RNG, no world coordinates) — headless-testable.
//
// The last section adds the PROBABILISTIC layer (multi-entity-conversations.md
// §3d): the same scores, read through a soft edge instead of a hard threshold.
// `gateProbability` itself stays pure — it produces a PROBABILITY, never draws.
// The verdict functions above draw from a stream THE CALLER SUPPLIES (`input.rng`,
// always seeded), so a replay is a replay; with no stream they fall back to the
// old hard comparison, byte for byte. The module still owns no randomness of its
// own — there is no `Math.random` anywhere below.

import {
  itemMatchesNeed,
  type CreatureId,
  type CreatureState,
  type CreatureWorld,
  type ItemState,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { DEFAULT_RELATION, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import { NEUTRAL_PERSONALITY, type Personality } from "@shared/world-engine/interaction/behavior/personality.js";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampSigned = (v: number): number => Math.min(1, Math.max(-1, v));

/** The outcome of a want directed at the owner (§4b). A `give` names WHY (for tests /
 *  affect events); a `redirect` means "not from me — go to the source"; a `decline`
 *  is a plain no with a reason (nothing to point at, or the owner won't/can't). */
export type GiveResponse =
  | { kind: "give"; reason: "debt" | "affinity" | "surplus" }
  | { kind: "redirect" }
  | { kind: "decline"; reason: "bound" | "own-need" | "ungenerous" };

export interface WillingnessInput {
  /** The OWNER's directed attitude toward the requester (relations.ts). */
  relation?: Relation;
  /** The OWNER's intrinsic dials (warmth is the disposition to give). */
  personality?: Personality;
  /** Does the owner know a PROVIDER of this item (a market/vendor) to point the asker
   *  to? Turns a withholding into a helpful REDIRECT instead of a dead "no". Supplied
   *  by the caller (the `provides`/place layer), so this stays pure/coordinate-free. */
  knowsSource?: boolean;
  /**
   * The caller's SEEDED draw (`mulberry32(hashSeed(worldSeed, "convo", …))`).
   * Present ⇒ the generosity verdict is a soft draw (`passesGate`); ABSENT ⇒ the
   * old hard `score >= threshold`, unchanged to the byte. Optional on purpose:
   * every existing caller — and every test that pins a give/refuse outcome —
   * keeps the deterministic answer it was written against, and a call site opts
   * into the fuzz by handing over a stream it can reproduce.
   */
  rng?: Rng;
}

/**
 * How disposed the owner is to give FREELY (0..1) — its warmth (general disposition)
 * lifted by affinity toward this particular asker. Exported so the same number can
 * shape adjacent choices (e.g. how readily an NPC OFFERS). A neutral stranger sits
 * below the free-gift threshold; a warm creature toward a liked asker clears it.
 */
export function generosity(personality: Personality, relation: Relation): number {
  const affinity = (clampSigned(relation.affinity) + 1) / 2; // 0..1
  return clamp01(0.55 * personality.warmth + 0.55 * affinity - 0.1);
}

/** At/above this generosity score, a liked asker is gifted without a covering debt. */
const GIVE_FREELY_THRESHOLD = 0.7;

/**
 * SOCIABILITY — how disposed a creature is to do something WITH the asker
 * ("eat with me", "let's play together"). The third member of the family:
 * `compliance` gates DO (obey an order), `generosity` gates GIVE (part with a
 * thing), this gates JOIN (share an activity).
 *
 * Deliberately the SAME formula as `generosity` rather than a new dial set —
 * the personality system is still being developed, and a gate with its own
 * tuning surface would be one more thing to revisit when it grows. Warmth is
 * the disposition, affinity is who is asking; that is the whole model.
 */
export function sociability(personality: Personality, relation: Relation): number {
  return generosity(personality, relation);
}

/** Company is CHEAPER THAN PROPERTY: coming to the table costs a creature
 *  nothing it keeps, so the bar sits below the free-gift one. Calibrated so a
 *  NEUTRAL creature toward a NEUTRAL asker (0.45) accepts — a family that
 *  wouldn't come to dinner unless it already adored you would be wrong — while
 *  a cold one, or one that dislikes the asker, declines. */
const JOIN_THRESHOLD = 0.35;

export interface JoinInput extends Pick<WillingnessInput, "relation" | "personality" | "rng"> {
  /** The asked-for activity's own meter, as a FRACTION of its threshold — the
   *  same units `RitualCall.level` speaks (rituals.ts), so 1 means "that need
   *  is firing". A creature that genuinely wants the thing accepts whoever
   *  asks: you do not refuse dinner because you dislike the cook. */
  level?: number;
}

/**
 * Will `owner` do the thing WITH the asker? True when it wants the activity
 * anyway, or when its disposition toward this particular asker clears the join
 * bar. Dial-driven — no per-character code: a warm creature says yes to almost
 * anyone, a cold one only to friends, and the difference is visible in play
 * without a line of scripting.
 *
 * TWO GATES, ONLY ONE OF THEM FUZZY (§3d). The "it wants this anyway" branch
 * stays DETERMINISTICALLY TRUE: a firing need is not an opinion about the asker,
 * and a creature that turns down dinner it is hungry for on a bad roll is not
 * ambivalence, it is a bug wearing probability's clothes. The DISPOSITION branch
 * is the one where "just barely willing" is a real state, so that is the one the
 * draw belongs to.
 *
 * ⚠️ This gates the SOCIAL question only. Whether the gathering is physically
 * possible — a seat, a place, room on the roster — is `ritualAnswer`'s
 * (rituals.ts), and the two are asked separately so a refusal can say WHICH.
 */
export function willingnessToJoin(input: JoinInput = {}): boolean {
  if ((input.level ?? 0) >= 1) return true; // it wants this anyway — never a draw
  const relation = input.relation ?? DEFAULT_RELATION;
  const personality = input.personality ?? NEUTRAL_PERSONALITY;
  return passesGate(sociability(personality, relation), JOIN_THRESHOLD, personality, input.rng);
}

/** Two items are "the same sort of thing" — same kind, or a shared category — so a
 *  spare instance of the kind can settle a want for it (the surplus path). */
function sameSort(a: ItemState, b: ItemState): boolean {
  return (!!a.kind && a.kind === b.kind) || (!!a.category && a.category === b.category);
}

/**
 * Does the owner hold more of this item's sort than it needs AND keeps for itself —
 * i.e. a genuine SPARE? A creature keeps at least one of anything (`max(needed, 1)`),
 * so its single apple is never "surplus" even with no hunger; three apples and one
 * hunger leaves two to spare. This is what stops a creature gifting away its only
 * possession to a passing stranger.
 */
export function hasSurplus(owner: CreatureState, item: ItemState, world: CreatureWorld): boolean {
  const owned = Object.values(world.items).filter(
    (i) => i.ownerId === owner.id && (i.id === item.id || sameSort(i, item)),
  ).length;
  const needed = owner.needs.filter((n) => !n.fulfilled && itemMatchesNeed(n, item)).length;
  return owned > Math.max(needed, 1);
}

/**
 * Will `owner` part with `item` for `requesterId`? The gate, in order:
 *   1. BOUND (a keepsake / in use) — never given → withhold.
 *   2. A COVERING DEBT (owes ≥ the item's value) — settlement is consent → give("debt").
 *      (This is exactly `requestItem`'s existing rule, subsumed here.)
 *   3. The owner NEEDS it itself (an open matching need) — keeps it → withhold.
 *   4. GENEROSITY: warm disposition × affinity toward this asker clears the free-gift
 *      threshold → give("affinity").
 *   5. SURPLUS of the sort (owns more than it needs) → give("surplus").
 *   6. else withhold.
 * A withholding becomes a REDIRECT when the owner knows a provider (go buy it), else a
 * plain DECLINE — the "tell them to buy it themselves" branch (§4b).
 *
 * ONLY STEP 4 IS FUZZY (§3d). Steps 1–3 are LEGIBLE BEDROCK and stay hard: a bound
 * keepsake is never given, a covering debt is always settled, and a creature never
 * hands over the thing it needs itself. Those three are the rules a child can learn
 * by watching, and a rule that holds 90% of the time is not a rule — it is noise
 * with a story attached. Step 4 is the only one that was ever a JUDGMENT ("do I like
 * you enough?"), so it is the only one that becomes a draw. Step 5 (surplus) is
 * arithmetic about how many apples are in the room, not an opinion, so it stays hard
 * too.
 */
export function willingnessToGive(
  owner: CreatureState,
  item: ItemState,
  requesterId: CreatureId,
  world: CreatureWorld,
  input: WillingnessInput = {},
): GiveResponse {
  const withhold = (reason: "bound" | "own-need" | "ungenerous"): GiveResponse =>
    input.knowsSource ? { kind: "redirect" } : { kind: "decline", reason };

  if (item.bound || item.ownerId !== owner.id) return withhold("bound");

  const debt = owner.debts[requesterId] ?? 0;
  if (debt >= item.value) return { kind: "give", reason: "debt" };

  // Won't gift what it needs itself (unless already owed for it — handled above).
  if (owner.needs.some((n) => !n.fulfilled && itemMatchesNeed(n, item))) return withhold("own-need");

  const relation = input.relation ?? DEFAULT_RELATION;
  const personality = input.personality ?? NEUTRAL_PERSONALITY;
  if (passesGate(generosity(personality, relation), GIVE_FREELY_THRESHOLD, personality, input.rng)) {
    return { kind: "give", reason: "affinity" };
  }

  if (hasSurplus(owner, item, world)) return { kind: "give", reason: "surplus" };

  return withhold("ungenerous");
}

// ---------------------------------------------------------------------------
// Probabilistic willingness (multi-entity-conversations.md §3d)
// ---------------------------------------------------------------------------

/**
 * A uniform draw in [0,1). ALWAYS seeded — `mulberry32(hashSeed(worldSeed, …))`
 * from shared/prng.ts, never `Math.random`. The whole point of routing every
 * roll through an explicit parameter is that a world is a function of its seed:
 * a replay, a certifier simulation and a second device all have to reach the
 * same answer, and an ambient global would silently break all three. Where this
 * type appears in a signature, it is REQUIRED — a "fall back to Math.random"
 * default is exactly the hole it exists to close.
 */
export type Rng = () => number;

/** Below this, a temperature is a step function — and a step is not a
 *  probability curve. Clamping keeps `gateProbability` strictly monotone (and
 *  finite) no matter what a caller hands it. */
const MIN_TEMPERATURE = 0.01;

/**
 * The soft edge: a logistic centred on the OLD hard threshold, so nothing about
 * the score changes — only what a score just short of the bar now means.
 * `score >= threshold` becomes `rng() < gateProbability(score, threshold, t)`,
 * and the boundary case is honest about itself: exactly at the threshold the
 * answer is a coin flip, which is what "just barely willing" always was.
 *
 * Two properties the rest of the design leans on:
 *   • STRICTLY INCREASING in `score`. Every dial that used to move a creature
 *     toward yes still moves it toward yes, by the same ordering. No decision
 *     inverts, so no tuning already done has to be redone.
 *   • SATURATING. Two tenths above the bar is already ~99.99% for a stable
 *     creature, and half a point does it for anyone. This is the PEDAGOGY
 *     mechanism, not a footnote: a fixed
 *     game seeds the player very high `Relation.authority`/affinity, which
 *     pushes the score far up the curve, and near-certainty is what makes
 *     cause and effect learnable. Fuzziness lives where the world is
 *     ambivalent; where the game has taught a bond, the bond wins.
 * Symmetrically, well below the threshold the answer is ~0 — a creature that
 * clearly won't does not surprise a child with a lucky yes.
 */
export function gateProbability(score: number, threshold: number, temperature: number): number {
  const t = Math.max(MIN_TEMPERATURE, temperature);
  return 1 / (1 + Math.exp(-(score - threshold) / t));
}

/**
 * How wide that edge is FOR THIS CREATURE — its own temperament decides how
 * predictable it is. `stability` is already the dial for "how fast relations
 * swing" (personality.ts), so it is the honest source: a volatile creature is
 * noisy at the margin (0.18 — a genuine maybe), an even one is near-
 * deterministic (0.02 — effectively the old hard threshold, which is why a
 * `drone`/`unit` still behaves like a mechanism). No new dial, per the same
 * reasoning that made `sociability` reuse `generosity`'s formula.
 */
export function gateTemperature(p: Personality): number {
  return 0.02 + 0.16 * (1 - clamp01(p.stability));
}

/**
 * THE DRAW — the one place in the gate family where a verdict is actually rolled,
 * shared by `willingnessToGive` (step 4) and `willingnessToJoin` (the disposition
 * branch) so the two can never drift apart.
 *
 *   rng  ⇒  rng() < gateProbability(score, threshold, gateTemperature(personality))
 *   none ⇒  score >= threshold          — the LEGACY path, byte-identical
 *
 * The absent-rng branch is not a courtesy to old callers, it is the acceptance
 * bar: a call site that hands over no stream must reach EXACTLY the answer it
 * reached before this file learned about probability, which is what lets the
 * whole existing suite stay green unedited and what keeps a single-player world
 * a function of its seed alone.
 *
 * WHY A CURVE AND NOT A COIN (the fixed-game pedagogy mechanism, decision 2).
 * `gateProbability` is strictly monotone and SATURATING, and both properties are
 * load-bearing here:
 *   • MONOTONE — every dial that used to push a creature toward yes still pushes
 *     it toward yes, in the same order. Fuzzy did not re-tune anything.
 *   • SATURATING — a score a couple of tenths clear of the bar is already
 *     ~99.99% for a stable creature. So an authored game that seeds the player
 *     high `Relation.authority`/affinity (`meta.playerRelation`, read by
 *     quest-host's `relationToward`) buys back near-determinism WITHOUT a
 *     special case: the same curve that makes a stranger a genuine maybe makes a
 *     bonded family member a reliable yes. Cause and effect stays learnable
 *     exactly where the game has taught a bond; the fuzz lives where the world
 *     is honestly ambivalent, and free play — which sets no knob — keeps it.
 * A volatile creature's wider temperature widens the maybe band around the bar,
 * never the certainty at either end.
 */
function passesGate(score: number, threshold: number, personality: Personality, rng?: Rng): boolean {
  if (!rng) return score >= threshold;
  return rng() < gateProbability(score, threshold, gateTemperature(personality));
}

/**
 * ATTEND — the fourth member of the family: `compliance` gates DO (obey an
 * order), `generosity` gates GIVE (part with a thing), `sociability` gates JOIN
 * (share an activity), and this gates ANSWER (be the one who speaks next).
 *
 * It is the one gate that could not reuse `generosity`'s formula, and the reason
 * is a real difference rather than a tuning preference: answering costs nothing
 * and gives nothing away, so warmth — the disposition to PART WITH something —
 * is not what decides it. What decides it is whether a creature is the sort that
 * speaks (`expressiveness`, the dial for how legible it makes itself), whether
 * it cares who is speaking (affinity, as everywhere in this family), and whether
 * it is in this conversation right now (`engagement`, the only LIVE term in the
 * family — the other three read state, this one reads attention). Weighted in
 * that order, because a quiet creature stays quiet even among friends, and a
 * talkative one will answer a stranger.
 *
 * Feeds an urge, not a decision: the arbitration layer multiplies this by how
 * directly the utterance was addressed and rolls a seeded roulette against
 * silence. Saturation carries over — a directly-addressed, well-liked,
 * fully-engaged creature answers as good as always, which is the same
 * cause-and-effect guarantee `gateProbability` makes for the other three.
 */
export function attend(personality: Personality, relation: Relation, engagement: number): number {
  const affinity01 = (clampSigned(relation.affinity) + 1) / 2; // 0..1
  return clamp01(
    0.45 * clamp01(personality.expressiveness) + 0.35 * affinity01 + 0.2 * clamp01(engagement),
  );
}
