// shared/world-engine/interaction/behavior/goal-selection.ts
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

import type { CreatureId, CreatureNeed, CreatureState, CreatureWorld, ItemId, ItemState } from "@shared/world-engine/interaction/behavior/creatures.js";
import { openNeeds } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { Relation } from "@shared/world-engine/interaction/behavior/relations.js";
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
} from "@shared/world-engine/interaction/behavior/rules.js";
import type { Vec2 } from "../../types.js";
import { planGoal } from "@shared/world-engine/interaction/behavior/action-planner.js";

// ---------------------------------------------------------------------------
// Need → goal (the creature pursuing its OWN motives)
// ---------------------------------------------------------------------------

/** An item a need references: an exact instance unless the need is loose (a `target`
 *  predicate — motive-driven-needs.md). */
function needItemRef(need: CreatureNeed): ItemRef {
  return need.target ? { match: need.target } : { id: need.itemId };
}

/** Does `item` fulfil the RESOURCE a need is about — its `target` predicate (loose)
 *  or its exact instance — IGNORING the state-need routing (placedAt/forCreature/…)?
 *  Unlike `itemMatchesNeed`, this answers "is this the thing I need to be HOLDING",
 *  so a placement/delivery need can tell whether its item is already in hand. State
 *  is ignored here: a `requiresState` need still counts the item as held (it then
 *  transforms it), and a plain resource is matched on kind/category/descriptors. */
function itemIsNeedResource(need: CreatureNeed, item: ItemState): boolean {
  if (need.target) {
    const t = need.target;
    if (t.kind && item.kind !== t.kind) return false;
    if (t.category && item.category !== t.category) return false;
    if (t.descriptors && !t.descriptors.every((d) => (item.descriptors ?? []).includes(d))) return false;
    return true;
  }
  return item.id === need.itemId;
}

/** Is the creature currently HOLDING (owning) an item that satisfies the need's
 *  resource? Drives the fetch-first, resumable errand: acquire before delivering. */
function holdsNeedResource(self: CreatureState, world: CreatureWorld, need: CreatureNeed): boolean {
  return Object.values(world.items).some((it) => it.ownerId === self.id && itemIsNeedResource(need, it));
}

/**
 * The goal a creature adopts to pursue one of its OWN needs, or null if the need isn't
 * self-actionable. **Fetch-first / resumable** (npc-behavior-and-town-economy.md §8.1b):
 * a need whose completion requires HOLDING an item (deliver-home `placedAt`, hand-off
 * `forCreature`, `transform` `requiresState`) first yields a `fetch` while the creature
 * isn't holding the resource, then the terminal goal once it is. So the whole shopping
 * errand — go to the market, then carry the goods home — EMERGES from one need, and is
 * resumable from any point: hand the creature the goods and it skips the market; it
 * loses them and it goes back. `holdsItem` is whether the creature already holds the
 * resource (default true keeps the terminal goal for callers that don't track it).
 */
export function needToGoal(need: CreatureNeed, holdsItem = true): GoalSpec | null {
  if (need.fulfilled) return null;
  if (need.atPlace) return { kind: "goTo", place: { kind: "creature", id: need.atPlace } };
  if (need.deviceState) return { kind: "toggle", device: needItemRef(need), state: need.deviceState };
  // Needs that must be COMPLETED with the item in hand: acquire it first if we lack it.
  const requiresHolding = !!(need.placedAt || need.forCreature || need.requiresState);
  if (requiresHolding && !holdsItem) return { kind: "fetch", item: needItemRef(need) };
  if (need.placedAt) return { kind: "putIn", item: needItemRef(need), container: { kind: "named", id: need.placedAt } };
  if (need.forCreature) return { kind: "give", item: needItemRef(need), to: need.forCreature };
  if (need.requiresState) return { kind: "transform", item: needItemRef(need), state: need.requiresState };
  return { kind: "fetch", item: needItemRef(need) };
}

function needCandidate(need: CreatureNeed, self: CreatureState, world: CreatureWorld): GoalCandidate | null {
  const goal = needToGoal(need, holdsNeedResource(self, world, need));
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
  /** THE ABSOLUTE-TABOO VETO (nations P2, laws.ts): true = this goal may
   *  not enter ANY tier — not weighed, not outranked, pruned even at
   *  survival strength (an absolute is what a member of the culture is
   *  physically unable to select). Omit = nothing vetoed. */
  veto?: (goal: GoalSpec) => boolean;
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
  // `cannotLeavePost` (puzzle-safety flag) suppresses SELF-fulfillment entirely — the
  // creature stays at its post and waits, still conversing/obeying rules (§8). One
  // behavior model; a puzzle creature is a regular one wearing this flag.
  if (!ctx.self.cannotLeavePost) {
    for (const need of openNeeds(ctx.self)) {
      const cand = needCandidate(need, ctx.self, ctx.world);
      if (!cand) continue;
      if (input.veto?.(cand.goal)) continue; // absolute taboo — pruned even at survival tier
      if (cand.weight >= cfg.survivalValue) return { chosen: cand };
      candidates.push(cand);
    }
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
    if (input.veto?.(rule.action)) continue; // absolute taboo — no author outranks it
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
  /** Resolve an item reference to a concrete item id (nearest match / by id).
   *  `from` = an explicit SOURCE endpoint ("take ball from box"): candidates are
   *  restricted to that source — held by the creature / in-or-at the place.
   *  Implementations may ignore it (legacy: nearest match anywhere). */
  resolveItem(ref: ItemRef, seeker: CreatureId, from?: PlaceRef): ItemId | null;
  itemPosition(id: ItemId): Vec2 | null;
  /** A station that applies `state` (fire→hot, water→cold). */
  stationFor(state: string): Vec2 | null;
  /** The nearest COLORING tub to `self` — a water barrel/bath doubling as the
   *  dye vat, where a `color` command carries the item to recolour it. Null ⇒
   *  none reachable (the command can't be fulfilled). Optional: absent ⇒ the
   *  coloring leg is skipped (recolour where you stand — the test seam). */
  colorStation?(self: CreatureId): Vec2 | null;
  /** Where `self` would EAT given a station-kind preference (["table"], a pet's
   *  ["bowl"]) — the dining leg of a consume-with-`at` plan. Null (or absent) ⇒
   *  no such station nearby ⇒ the item is consumed where it lies. */
  diningSpot?(self: CreatureId, kinds: readonly string[]): Vec2 | null;
  /** Can `self` work a lid/door open (grasp)? A graspless body (a pet) can't, so
   *  an "open the chest" plan for it regresses to BLOCKED (the honest reason)
   *  rather than a silent no-op. Optional: absent ⇒ assume it can (has hands). */
  canOpen?(self: CreatureId): boolean;
  /** Who is HOLDING the item right now (null = loose on the ground). Lets a
   *  give/putIn plan skip the pickup leg when the actor already carries it —
   *  and refuse when someone else does. Optional: absent reads as loose. */
  carrierOf?(id: ItemId): CreatureId | null;
  /** Is `self` ALREADY standing at `pos` (within arrival range)? The seam that
   *  turns a one-shot plan into a PER-TICK PURSUIT (action-planner.ts): when
   *  present, the planner drops the walk-leg it no longer needs, so re-running
   *  it each tick advances (far → [moveTo, act]; arrived → [act]; done → []).
   *  ABSENT ⇒ never arrived ⇒ every leg keeps its moveTo, so `planGoal`
   *  reproduces the static `compileGoal` exactly (the equivalence the tests
   *  pin). The pursuit loop supplies it; the static bake does not. */
  arrived?(self: CreatureId, pos: Vec2): boolean;
}

/** One executable step. The world-host maps `moveTo` to an NpcErrand waypoint and the
 *  action steps to `onArrive` callbacks that call the creatures.ts rule functions. */
export type GoalStep =
  | { kind: "moveTo"; pos: Vec2 }
  | { kind: "faceHold"; target?: CreatureId } // stop and face (follow/stay/react)
  // `from` = the SOURCE CREATURE the planner authorized a hand-to-hand take
  // from ("take ball from dog") — the executor performs the handover; without
  // it, picking something another creature holds stays refused.
  | { kind: "pick"; itemId: ItemId; from?: CreatureId }
  | { kind: "give"; itemId: ItemId; to: CreatureId }
  | { kind: "place"; itemId: ItemId; place: PlaceRef }
  | { kind: "drop"; itemId: ItemId } // set the held item down where you stand (ground putdown)
  | { kind: "toggle"; deviceId: ItemId; state: string }
  | { kind: "transform"; itemId: ItemId; state: string }
  | { kind: "openClose"; place: PlaceRef; open: boolean } // open/shut a container lid
  | { kind: "equip"; itemId: ItemId } // put a held garment ON (doff the old as .dirty)
  | { kind: "color"; itemId: ItemId; color: string } // recolor a held item at the tub (withVariation)
  | { kind: "converse"; target: CreatureId } // exchange with the partner (on arrival)
  | { kind: "rest"; place: PlaceRef; dwellS?: number; pose?: "sleep" | "sit" | "play" } // occupy a station and dwell there
  // Stack-economy manipulation (S3): move `units` between the reached store and
  // the abstract bag. `fromId`/`intoId` are the resolved object ids (a chest, a
  // market stall, "well", a loose "small:*" prop).
  | { kind: "withdraw"; fromId: string; goodKey: string; units: number; affords?: string; tplKey?: string }
  | { kind: "stow"; intoId: string; goodKey: string; units: number; tplKey?: string }
  // Named -Stack to keep clear of the SINGLE-PROP steps (`equip` wears a held
  // physical prop; `drop` releases one): these act on the abstract bag.
  | { kind: "processStack"; atId: string; goodKey: string; drop?: string; add?: string; dwellS?: number; tplKey?: string }
  | { kind: "equipStack"; goodKey: string; tplKey?: string }
  | { kind: "dropStack"; goodKey: string; units: number; tplKey?: string }
  | { kind: "consumeStack"; goodKey: string; at?: readonly string[]; tplKey?: string }
  | { kind: "selfAct"; need: string } // eat / rest / sleep
  | { kind: "eat"; itemId: ItemId } // consume a SPECIFIC item on arrival (use it up)
  | { kind: "socialAct"; target: CreatureId; act: string }; // hug (…comfort/greet later) — on arrival, at the target

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
  // Transitive goals (give/putIn) first ACQUIRE the item unless the actor is
  // already holding it; an item in someone ELSE's hands is not snatchable.
  const pickupLeg = (id: ItemId): boolean => {
    const holder = r.carrierOf?.(id) ?? null;
    if (holder === self) return true;
    if (holder) return false;
    if (!move(r.itemPosition(id))) return false;
    steps.push({ kind: "pick", itemId: id });
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
      const id = r.resolveItem(goal.item, self, goal.from);
      if (!id) return null;
      // A source CREATURE holding the item: walk to the holder for the
      // hand-to-hand take (the from-authorized pick). Else the classic
      // walk-to-it-and-lift.
      const holder = r.carrierOf?.(id) ?? null;
      const fromCid = goal.from?.kind === "creature" ? goal.from.id : undefined;
      if (holder && holder !== self && holder === fromCid) {
        if (!move(r.positionOf(holder))) return null;
        steps.push({ kind: "pick", itemId: id, from: fromCid });
        return { steps };
      }
      if (!move(r.itemPosition(id))) return null;
      steps.push({ kind: "pick", itemId: id });
      return { steps };
    }
    case "drop": {
      // Release the HELD item where you stand. You can only drop what you're
      // carrying — an item you're not holding has nothing to drop (null), so
      // the surfacer/creature treats it as not-understood rather than guessing.
      const id = r.resolveItem(goal.item, self);
      if (!id || (r.carrierOf?.(id) ?? null) !== self) return null;
      steps.push({ kind: "drop", itemId: id });
      return { steps };
    }
    case "give": {
      const id = r.resolveItem(goal.item, self);
      if (!id || !pickupLeg(id)) return null;
      if (!move(r.positionOf(goal.to))) return null;
      steps.push({ kind: "give", itemId: id, to: goal.to });
      return { steps };
    }
    case "putIn": {
      const id = r.resolveItem(goal.item, self);
      if (!id || !pickupLeg(id)) return null;
      if (!move(r.place(goal.container))) return null;
      steps.push({ kind: "place", itemId: id, place: goal.container });
      return { steps };
    }
    case "color":
      // Planner-owned (a station verb like transform/wear): the `colored` target
      // regresses acquire-the-item → walk-to-tub → recolour. planGoal is the
      // single owner so the static bake and the live pursuit never drift.
      return planGoal(goal, self, r);
    case "toggle": {
      const id = r.resolveItem(goal.device, self);
      if (!id || !move(r.itemPosition(id))) return null;
      steps.push({ kind: "toggle", deviceId: id, state: goal.state });
      return { steps };
    }
    case "transform":
      // Routed through the ACTION PLANNER like `consume` (action-planner.ts):
      // the `facet` target regresses `holding` → walk → transform, so a
      // commanded "cook the apple" carries it to the fire instead of magically
      // transforming a thing across the room. planGoal is the single owner.
      return planGoal(goal, self, r);
    case "rest":
      // Also planner-owned: the `rested` target regresses walk-to-station →
      // dwell. "Go to bed" walks to the bed and sleeps there.
      return planGoal(goal, self, r);
    case "setOpen":
      // Planner-owned: `openState` regresses walk-to-container → open/shut the
      // lid. Graspless bodies can't open, so the plan blocks (honest reason).
      return planGoal(goal, self, r);
    case "wear":
      // Planner-owned: `worn` regresses acquire-the-garment → equip.
      return planGoal(goal, self, r);
    case "converse":
      // Planner-owned: `socialized` regresses walk-to-partner → exchange.
      return planGoal(goal, self, r);
    case "takeUnits":
    case "putUnits":
    case "processUnits":
    case "equipUnits":
    case "dropUnits":
    case "consumeUnits":
      // Planner-owned (S3): the stack economy's bounded micro-goals — move the
      // units, work them at a station, wear one, or set them down.
      return planGoal(goal, self, r);
    case "satisfy":
      return { steps: [{ kind: "selfAct", need: goal.need }] };
    case "consume":
      // The first goal routed through the ACTION PLANNER (action-planner.ts):
      // "eat the banana" regresses target `consumed(item)` → walk-to + eat. The
      // planner reproduces fetch/give/putIn identically (proven in tests); this
      // is the migration's first live consumer, the rest staying hand-wired
      // here until each is swapped over.
      return planGoal(goal, self, r);
    case "socialAct": {
      // Walk to the target and perform the social act there (a hug). The host's
      // step handler applies the warmth — relations, meters, hearts.
      if (!move(r.positionOf(goal.target))) return null;
      steps.push({ kind: "socialAct", target: goal.target, act: goal.act });
      return { steps };
    }
    case "help":
      // An adoption ORDER — the host routes it to the needs walker (a standing
      // on-behalf supply row), never a one-shot body errand.
      return null;
    case "place":
      // A PLACEMENT order (construction v1) — the host routes it through the
      // placement search + willingness gate (quest-host's place branch): the
      // exact spot is the CREATURE's judgment, never a blind body errand.
      return null;
    case "build":
      return null; // civ-scope world order, handled by the town-gen layer, not a body errand
    case "buildwork":
      return null; // ⑥ standing site work — the construction sweep walks + banks it, never a compiled errand
    case "area":
      return null; // a spatial charter (③) — the host writes it; never a body errand
    case "transfer":
      // A stock-endpoint haul (city-expansion ②) — the host routes it through
      // the transfer ledger (load/unload over the live stack maps), never a
      // single-instance body errand.
      return null;
    case "trade":
      // Intercity barter (⑤) — the host quotes the ratio, gates willingness
      // and schedules the caravan on the ② ledger; never a body errand.
      return null;
  }
}
