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
// deterministic (no RNG, no world coordinates) — headless-testable.

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

export interface JoinInput extends Pick<WillingnessInput, "relation" | "personality"> {
  /** The asked-for activity's own meter, as a FRACTION of its threshold — the
   *  same units `RitualCall.level` speaks (rituals.ts), so 1 means "that need
   *  is firing". A creature that genuinely wants the thing accepts whoever
   *  asks: you do not refuse dinner because you dislike the cook. */
  level?: number;
}

/**
 * Will `owner` do the thing WITH the asker? True when it wants the activity
 * anyway, or when its disposition toward this particular asker clears the join
 * bar. Pure and dial-driven — no RNG, no per-character code: a warm creature
 * says yes to almost anyone, a cold one only to friends, and the difference is
 * visible in play without a line of scripting.
 *
 * ⚠️ This gates the SOCIAL question only. Whether the gathering is physically
 * possible — a seat, a place, room on the roster — is `ritualAnswer`'s
 * (rituals.ts), and the two are asked separately so a refusal can say WHICH.
 */
export function willingnessToJoin(input: JoinInput = {}): boolean {
  if ((input.level ?? 0) >= 1) return true; // it wants this anyway
  const relation = input.relation ?? DEFAULT_RELATION;
  const personality = input.personality ?? NEUTRAL_PERSONALITY;
  return sociability(personality, relation) >= JOIN_THRESHOLD;
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
 * plain DECLINE — the "tell them to buy it themselves" branch (§4b). Pure.
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
  if (generosity(personality, relation) >= GIVE_FREELY_THRESHOLD) return { kind: "give", reason: "affinity" };

  if (hasSurplus(owner, item, world)) return { kind: "give", reason: "surplus" };

  return withhold("ungenerous");
}
