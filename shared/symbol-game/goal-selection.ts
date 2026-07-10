// shared/symbol-game/goal-selection.ts
//
// The living-sim GOAL CHOOSER — the first realization of creature-needs.md §6 as
// running code (society-rules.md §6 build step 3). Each tick it decides what a
// creature does: answer a conversation partner (hard tier), pursue a survival need
// (hard tier), or — for everything discretionary — pick the strongest CANDIDATE
// among the creature's own needs and the player's standing RULES, where a rule's
// weight is priority × compliance (rules.ts / relations.ts / personality.ts). Rules
// are NOT law: a well-regarded commander's rule outweighs a chore, a stranger's
// doesn't, and the creature keeps doing its own thing.
//
// TWO HALVES:
//   • selectGoal(...) — PURE decision: needs + rules → a chosen GoalSpec + updated
//     rule runtime (cooldowns, edge/until lifetime). Headless-testable; deterministic
//     (no RNG). This is the mind.
//   • compileGoal(goal, resolver) — the world ADAPTER: a GoalSpec → a GoalPlan (move/
//     pick/give/… steps) the body executes (an NpcErrand in world-host). It needs
//     positions, so it takes an injected WorldResolver; still pure given the resolver.
//
// The RESPONSE-AFFORDANCE contract (world-lab footer, by design): Yes / No / more-
// options are always present, so ANY statement a creature makes is yes/no-answerable
// and any option list is extensible. The chooser assumes that — a creature acting on
// a goal can always be answered, and dialogue lists stay ≤8 (concept-parser.md).

import type { CreatureId, CreatureNeed, CreatureState, CreatureWorld, ItemId } from "./creatures.js";
import { openNeeds } from "./creatures.js";
import type { Relation } from "./relations.js";
import {
  chooseCandidate,
  conditionHolds,
  ruleBinds,
  ruleComplianceWeight,
  type GoalCandidate,
  type GoalSpec,
  type ItemRef,
  type PlaceRef,
  type Rule,
  type RuleContext,
} from "./rules.js";
import type { Vec2 } from "../world-engine/types.js";

// ---------------------------------------------------------------------------
// Need → goal (the creature pursuing its OWN motives)
// ---------------------------------------------------------------------------

/** An item a need references: an exact instance unless the need is loose (a `target`
 *  predicate — motive-driven-needs.md). */
function needItemRef(need: CreatureNeed): ItemRef {
  return need.target ? { match: need.target } : { id: need.itemId };
}

/** The goal a creature adopts to pursue one of its OWN needs, or null if the need
 *  isn't a self-actionable shape. Mirrors the shipped need kinds. */
export function needToGoal(need: CreatureNeed): GoalSpec | null {
  if (need.fulfilled) return null;
  if (need.atPlace) return { kind: "goTo", place: { kind: "creature", id: need.atPlace } };
  if (need.deviceState) return { kind: "toggle", device: needItemRef(need), state: need.deviceState };
  if (need.placedAt) return { kind: "putIn", item: needItemRef(need), container: { kind: "named", id: need.placedAt } };
  if (need.forCreature) return { kind: "give", item: needItemRef(need), to: need.forCreature };
  if (need.requiresState) return { kind: "transform", item: needItemRef(need), state: need.requiresState };
  return { kind: "fetch", item: needItemRef(need) };
}

function needCandidate(need: CreatureNeed): GoalCandidate | null {
  const goal = needToGoal(need);
  return goal ? { goal, weight: need.value, source: { kind: "need" } } : null;
}

// ---------------------------------------------------------------------------
// Rule lifetime + oscillation state machine
// ---------------------------------------------------------------------------

/** Per-(creature, rule) runtime bookkeeping the pure decision can't hold in the
 *  stateless Rule: the edge/until lifetime and the re-fire cooldown. */
export interface RuleRuntime {
  /** Rule is inactive until this sim time (edge re-fire debounce). */
  cooldownUntil: number;
  /** `edge`: ready to fire on the next rising edge (armed after the condition clears). */
  armed: boolean;
  /** `until`: the condition became true, so the rule self-removed. */
  removed: boolean;
}

export function freshRuntime(): RuleRuntime {
  return { cooldownUntil: -Infinity, armed: true, removed: false };
}

export interface GoalSelectionConfig {
  /** A need whose value ≥ this is a SURVIVAL crisis — a hard tier that wins outright. */
  survivalValue: number;
  /** Multiplier on an `urgent` rule's weight (still scaled by compliance). */
  urgentMultiplier: number;
  /** Debounce (sim seconds) before an `edge` rule may fire on a new rising edge. */
  cooldownSeconds: number;
}

export const DEFAULT_GOAL_SELECTION_CONFIG: GoalSelectionConfig = {
  survivalValue: 8,
  urgentMultiplier: 2.5,
  cooldownSeconds: 3,
};

/**
 * Advance one rule's lifetime given whether its trigger holds this tick and whether
 * the world reports its goal completed (`goalDone`, for edge). Returns whether the
 * rule is ACTIVE (its action is a live candidate) and the next runtime. Pure.
 *   • while — active exactly while the condition holds.
 *   • edge  — fires on the rising edge (armed && condition), latches until goalDone,
 *             then cooldown + disarm; re-arms when the condition clears.
 *   • until — active while the condition is NOT yet true; self-removes when it is.
 */
export function stepRuleLifetime(
  rule: Rule,
  rt: RuleRuntime,
  conditionNow: boolean,
  now: number,
  goalDone: boolean,
  cfg: GoalSelectionConfig,
): { active: boolean; rt: RuleRuntime } {
  if (rt.removed) return { active: false, rt };
  if (now < rt.cooldownUntil) return { active: false, rt };

  switch (rule.lifetime) {
    case "while":
      return { active: conditionNow, rt };
    case "until":
      // The action runs UNTIL the stop-condition becomes true, then the rule is gone.
      return conditionNow ? { active: false, rt: { ...rt, removed: true } } : { active: true, rt };
    case "edge": {
      if (!conditionNow) return { active: false, rt: { ...rt, armed: true } }; // re-arm
      if (!rt.armed) return { active: false, rt }; // already fired this edge
      if (goalDone) {
        return { active: false, rt: { ...rt, armed: false, cooldownUntil: now + cfg.cooldownSeconds } };
      }
      return { active: true, rt };
    }
  }
}

// ---------------------------------------------------------------------------
// selectGoal — the per-tick decision
// ---------------------------------------------------------------------------

export interface SelectGoalInputs {
  /** The rule-evaluation context for THIS creature (self, world, worldConditions,
   *  personality, role/extra resolvers) — same object rules.ts uses. */
  ctx: RuleContext;
  /** Standing rules (any binding; the chooser filters to this creature). */
  rules: Rule[];
  /** This creature's directed relation toward a rule's author (relations.ts). */
  relationTo: (author: CreatureId) => Relation;
  /** Per-rule runtime, keyed by rule id. MUTATED IN PLACE (live sim state). */
  runtimes: Map<string, RuleRuntime>;
  /** Sim time (world clock), for cooldowns. */
  now: number;
  /** The creature is in conversation with this partner → hard-tier REACT. */
  activePartner?: CreatureId | null;
  /** Did the world report an `edge` rule's goal completed since last tick? */
  goalDone?: (ruleId: string) => boolean;
  cfg?: GoalSelectionConfig;
}

export interface SelectGoalResult {
  /** The chosen motive (goal + weight + source), or null → fall through to idle. */
  chosen: GoalCandidate | null;
}

/**
 * Decide the creature's goal this tick. Hard tiers (active conversation, a survival
 * need) short-circuit; everything else is a weighted argmax over need candidates and
 * live rule candidates. Deterministic — ties break toward the earlier candidate
 * (needs are added before rules, and rules in array/tray order).
 */
export function selectGoal(input: SelectGoalInputs): SelectGoalResult {
  const cfg = input.cfg ?? DEFAULT_GOAL_SELECTION_CONFIG;
  const { ctx } = input;

  // Hard tier 1 — answer a conversation partner (never ignored for a chore).
  if (input.activePartner) {
    return {
      chosen: {
        goal: { kind: "stay", place: { kind: "creature", id: input.activePartner } },
        weight: Infinity,
        source: { kind: "react", partner: input.activePartner },
      },
    };
  }

  const candidates: GoalCandidate[] = [];

  // Need candidates (weight = need value). A SURVIVAL-level need is a hard tier.
  for (const need of openNeeds(ctx.self)) {
    const cand = needCandidate(need);
    if (!cand) continue;
    if (cand.weight >= cfg.survivalValue) return { chosen: cand };
    candidates.push(cand);
  }

  // Rule candidates — lifetime-gated, compliance-weighted.
  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    const rt = input.runtimes.get(rule.id) ?? freshRuntime();
    const binds = ruleBinds(rule, ctx);
    // For `until`, the trigger is the STOP condition; for others it's the START.
    const conditionNow = binds && conditionHolds(rule.trigger, ctx);
    const step = stepRuleLifetime(rule, rt, conditionNow, input.now, input.goalDone?.(rule.id) ?? false, cfg);
    input.runtimes.set(rule.id, step.rt);
    if (!binds || !step.active) continue;
    let weight = ruleComplianceWeight(rule, ctx, input.relationTo(rule.author));
    if (weight <= 0) continue;
    if (rule.urgent) weight *= cfg.urgentMultiplier;
    candidates.push({
      goal: rule.action,
      weight,
      source: { kind: "rule", ruleId: rule.id, author: rule.author, urgent: rule.urgent ?? false },
    });
  }

  return { chosen: chooseCandidate(candidates) };
}

// ---------------------------------------------------------------------------
// compileGoal — the world adapter (GoalSpec → an executable plan)
// ---------------------------------------------------------------------------

/** Positions + lookups the pure layer can't have (creatures.ts is coordinate-free).
 *  The world-host supplies the real one; tests pass a mock. */
export interface WorldResolver {
  positionOf(id: CreatureId): Vec2 | null;
  homeOf(id: CreatureId): Vec2 | null;
  place(place: PlaceRef): Vec2 | null;
  /** Resolve an item reference to a concrete item id (nearest match / by id). */
  resolveItem(ref: ItemRef, seeker: CreatureId): ItemId | null;
  itemPosition(id: ItemId): Vec2 | null;
  /** A station that applies `state` (fire→hot, water→cold). */
  stationFor(state: string): Vec2 | null;
}

/** One executable step. The world-host maps `moveTo` to an NpcErrand waypoint and the
 *  action steps to `onArrive` callbacks that call the creatures.ts rule functions. */
export type GoalStep =
  | { kind: "moveTo"; pos: Vec2 }
  | { kind: "faceHold"; target?: CreatureId } // stop and face (follow/stay/react)
  | { kind: "pick"; itemId: ItemId }
  | { kind: "give"; itemId: ItemId; to: CreatureId }
  | { kind: "place"; itemId: ItemId; place: PlaceRef }
  | { kind: "toggle"; deviceId: ItemId; state: string }
  | { kind: "transform"; itemId: ItemId; state: string }
  | { kind: "selfAct"; need: string }; // eat / rest / sleep

export interface GoalPlan {
  steps: GoalStep[];
}

/**
 * Turn a chosen GoalSpec into concrete steps, or null if it can't be resolved right
 * now (unknown position / no matching item) — the world falls back to idle, never
 * errors. `build` is intentionally unmapped here (a civ-scope world order, not a body
 * errand — society-rules.md §5).
 */
export function compileGoal(goal: GoalSpec, self: CreatureId, r: WorldResolver): GoalPlan | null {
  const steps: GoalStep[] = [];
  const move = (pos: Vec2 | null): boolean => {
    if (!pos) return false;
    steps.push({ kind: "moveTo", pos });
    return true;
  };

  switch (goal.kind) {
    case "goHome":
      return move(r.homeOf(self)) ? { steps } : null;
    case "goTo":
      return move(r.place(goal.place)) ? { steps } : null;
    case "follow": {
      if (!move(r.positionOf(goal.target))) return null;
      steps.push({ kind: "faceHold", target: goal.target });
      return { steps };
    }
    case "stay": {
      if (goal.place) {
        const p = r.place(goal.place);
        if (p) steps.push({ kind: "moveTo", pos: p });
      }
      steps.push({ kind: "faceHold", target: goal.place?.kind === "creature" ? goal.place.id : undefined });
      return { steps };
    }
    case "fetch": {
      const id = r.resolveItem(goal.item, self);
      if (!id || !move(r.itemPosition(id))) return null;
      steps.push({ kind: "pick", itemId: id });
      return { steps };
    }
    case "give": {
      const id = r.resolveItem(goal.item, self);
      if (!id || !move(r.positionOf(goal.to))) return null;
      steps.push({ kind: "give", itemId: id, to: goal.to });
      return { steps };
    }
    case "putIn": {
      const id = r.resolveItem(goal.item, self);
      if (!id || !move(r.place(goal.container))) return null;
      steps.push({ kind: "place", itemId: id, place: goal.container });
      return { steps };
    }
    case "toggle": {
      const id = r.resolveItem(goal.device, self);
      if (!id || !move(r.itemPosition(id))) return null;
      steps.push({ kind: "toggle", deviceId: id, state: goal.state });
      return { steps };
    }
    case "transform": {
      const id = r.resolveItem(goal.item, self);
      if (!id || !move(r.stationFor(goal.state))) return null;
      steps.push({ kind: "transform", itemId: id, state: goal.state });
      return { steps };
    }
    case "satisfy":
      return { steps: [{ kind: "selfAct", need: goal.need }] };
    case "build":
      return null; // civ-scope world order, handled by the town-gen layer, not a body errand
  }
}
