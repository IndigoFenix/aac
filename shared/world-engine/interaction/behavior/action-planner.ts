// shared/world-engine/interaction/behavior/action-planner.ts
//
// THE ACTION PLANNER — the universal, data-driven twin of compileGoal's
// hand-written switch (concept-parser.md §"universal logic"). Instead of
// enumerating the step sequence per goal, it splits a command into two layers:
//
//   • WHAT a goal MEANS — a target STATE PREDICATE ("the food is consumed",
//     "the recipient possesses it"). This is vocabulary: `GOAL_TARGET` maps a
//     GoalSpec to the predicate that fulfils it. One line per goal, not a plan.
//   • HOW to reach it — OPERATORS, each an { predicate → { preconditions,
//     emit } } rule. `achieve` regresses from the target through the operators,
//     satisfying preconditions first (walk before pick, pick before give), and
//     emits the same GoalStep[] the body executor already runs.
//
// PURE + deterministic given the WorldResolver: one operator per predicate kind
// (no search, no RNG), an ACYCLIC precondition graph (`in` → `holding` → `near`,
// depth ≤ 3), and already-satisfied guards (`holding` skips the pickup when the
// actor already carries it) — so it terminates and reproduces the hand-wired
// plans exactly. `planGoal` is a drop-in for `compileGoal` on the item-errand
// family; movement/social/host-policy goals stay in compileGoal.

import type { CreatureId, ItemId } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { GoalSpec, PlaceRef } from "@shared/world-engine/interaction/behavior/rules.js";
import type { GoalPlan, GoalStep, WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import type { Vec2 } from "../../types.js";

// ---------------------------------------------------------------------------
// Predicates — the state a goal wants TRUE (the "meaning" layer)
// ---------------------------------------------------------------------------

/** A world/agent state predicate the planner reasons about. Refs are RESOLVED
 *  (concrete ids), so planning is pure geometry over the resolver. */
export type Predicate =
  | { kind: "at"; place: PlaceRef } // the actor stands at a place
  | { kind: "near"; item: ItemId } // the actor stands by an item
  | { kind: "holding"; item: ItemId } // the item is in the actor's hand
  | { kind: "in"; item: ItemId; container: PlaceRef } // the item sits in a container
  | { kind: "possessed"; item: ItemId; by: CreatureId } // a creature holds the item
  // `at` = dining preference (station kinds): eat THERE when one resolves.
  | { kind: "consumed"; item: ItemId; at?: readonly string[] } // the item is used up (eaten/drunk)
  | { kind: "facet"; item: ItemId; state: string } // the item carries a state (clean/hot)
  | { kind: "toggled"; item: ItemId; state: string } // a device is open/closed/on/off
  // `dwellS` = episode length (a need's nap vs the commanded-sit default) — a
  // plan parameter riding the predicate, not world state.
  | { kind: "rested"; place: PlaceRef; dwellS?: number } // the body has occupied a rest station (bed/chair/box)
  | { kind: "openState"; place: PlaceRef; open: boolean } // a container lid is open/shut
  | { kind: "worn"; item: ItemId } // the garment is ON the body
  | { kind: "socialized"; partner: CreatureId }; // the actor has exchanged with the partner

// ---------------------------------------------------------------------------
// Operators — HOW to make a predicate true (the "mechanism" layer)
// ---------------------------------------------------------------------------

/**
 * Regress from `target` to a concrete step list, or null when a precondition
 * can't be met (unknown position / someone else holds the thing). Each arm is
 * ONE operator: its preconditions are achieved FIRST (recursively), then the
 * operator's own step is emitted. Already-satisfied preconditions contribute no
 * steps, which is what keeps plans minimal and the recursion terminating.
 */
export function achieve(target: Predicate, self: CreatureId, r: WorldResolver): GoalStep[] | null {
  // ONE walk-leg helper — arrival-aware: an already-reached destination emits
  // NO step, so re-running the plan each tick advances past legs the body has
  // already walked (`r.arrived` absent ⇒ always walk ⇒ static-bake parity).
  const legTo = (pos: Vec2): GoalStep[] => (r.arrived?.(self, pos) ? [] : [{ kind: "moveTo", pos }]);
  switch (target.kind) {
    case "at": {
      const pos = r.place(target.place);
      return pos ? legTo(pos) : null;
    }
    case "near": {
      const pos = r.itemPosition(target.item);
      return pos ? legTo(pos) : null;
    }
    case "holding": {
      const holder = r.carrierOf?.(target.item) ?? null;
      if (holder === self) return []; // already in hand — nothing to do
      if (holder) return null; // someone else holds it — not snatchable
      const near = achieve({ kind: "near", item: target.item }, self, r);
      return near ? [...near, { kind: "pick", itemId: target.item }] : null;
    }
    case "in": {
      const hold = achieve({ kind: "holding", item: target.item }, self, r);
      if (!hold) return null;
      const pos = r.place(target.container);
      if (!pos) return null;
      return [...hold, ...legTo(pos), { kind: "place", itemId: target.item, place: target.container }];
    }
    case "possessed": {
      const hold = achieve({ kind: "holding", item: target.item }, self, r);
      if (!hold) return null;
      const to = r.positionOf(target.by);
      if (!to) return null;
      return [...hold, ...legTo(to), { kind: "give", itemId: target.item, to: target.by }];
    }
    case "consumed": {
      const holder = r.carrierOf?.(target.item) ?? null;
      if (holder && holder !== self) return null; // can't eat what another holds
      // THE DINING LEG: a consume with an `at` preference (the need templates'
      // satisfy.at — people at the table, a pet at its bowl) carries the item
      // to the station and eats THERE: regress holding (walk over + pick it
      // up), walk to the station, eat. No such station nearby → fall through
      // to eating where it lies, exactly the templates' own else-in-place.
      if (target.at?.length) {
        const spot = r.diningSpot?.(self, target.at) ?? null;
        if (spot) {
          const hold = achieve({ kind: "holding", item: target.item }, self, r);
          if (hold) return [...hold, ...legTo(spot), { kind: "eat", itemId: target.item }];
        }
      }
      // Eat where it lies, or straight from the hand if already carried.
      const pos = r.itemPosition(target.item);
      const approach = holder === self ? [] : pos ? legTo(pos) : null;
      return approach ? [...approach, { kind: "eat", itemId: target.item }] : null;
    }
    case "facet": {
      // Transforming happens AT A STATION (fire→hot, tub→cold) with the item IN
      // HAND: regress `holding` first (carry it over), then walk to the station,
      // then work it. The body-carried model matches the needs cook/wash (the
      // walker hauls the units to the oven) and the action-hold crouch that
      // performs the swap. No station that grants the state → null (blocked).
      const pos = r.stationFor(target.state);
      if (!pos) return null;
      const hold = achieve({ kind: "holding", item: target.item }, self, r);
      if (!hold) return null;
      return [...hold, ...legTo(pos), { kind: "transform", itemId: target.item, state: target.state }];
    }
    case "toggled": {
      const pos = r.itemPosition(target.item);
      return pos ? [...legTo(pos), { kind: "toggle", deviceId: target.item, state: target.state }] : null;
    }
    case "rested": {
      // Walk to the station, then DWELL there (the dwell primitive poses the
      // body for a spell). No re-clear guard (like `facet`): the terminal step's
      // `last` ends the pursuit, so a command rests once. A place that can't be
      // resolved (no such station here) → null (blocked).
      const pos = r.place(target.place);
      if (!pos) return null;
      return [...legTo(pos), { kind: "rest", place: target.place, ...(target.dwellS !== undefined ? { dwellS: target.dwellS } : {}) }];
    }
    case "openState": {
      // Walk to the container, then work its lid. OPENING needs a grasp — a
      // graspless body (a pet) can't, so the plan BLOCKS (the honest "I can't
      // open it" reason) rather than a silent no-op. Closing needs no hands.
      const pos = r.place(target.place);
      if (!pos) return null;
      if (target.open && r.canOpen?.(self) === false) return null;
      return [...legTo(pos), { kind: "openClose", place: target.place, open: target.open }];
    }
    case "worn": {
      // Acquire the garment (walk to it + pick it up), then put it ON in place.
      // No station: you dress where you stand. The terminal `equip` step's `last`
      // ends the pursuit (the garment is consumed onto the body — re-planning
      // would read it gone, so `last` guards the false block, like `eat`).
      const hold = achieve({ kind: "holding", item: target.item }, self, r);
      return hold ? [...hold, { kind: "equip", itemId: target.item }] : null;
    }
    case "socialized": {
      // Walk to the partner, then EXCHANGE. Re-planned each tick, so a partner
      // that wanders is chased (the position updates); gone entirely → null
      // (blocked). The terminal `converse` step's `last` ends the pursuit.
      const to = r.positionOf(target.partner);
      return to ? [...legTo(to), { kind: "converse", target: target.partner }] : null;
    }
  }
}

// ---------------------------------------------------------------------------
// Goal → target predicate (the vocabulary table)
// ---------------------------------------------------------------------------

/** The item-errand family the planner OWNS. Movement (goHome/goTo/follow/stay),
 *  social acts, and host-policy goals (build/area/trade/help/place) stay in
 *  compileGoal — they aren't precondition chains over a carried item. */
export function goalTarget(goal: GoalSpec, self: CreatureId, r: WorldResolver): Predicate | null {
  const resolve = (ref: Parameters<WorldResolver["resolveItem"]>[0]) => r.resolveItem(ref, self);
  switch (goal.kind) {
    case "fetch": {
      const id = resolve(goal.item);
      return id ? { kind: "holding", item: id } : null;
    }
    case "give": {
      const id = resolve(goal.item);
      return id ? { kind: "possessed", item: id, by: goal.to } : null;
    }
    case "putIn": {
      const id = resolve(goal.item);
      return id ? { kind: "in", item: id, container: goal.container } : null;
    }
    case "consume": {
      const id = resolve(goal.item);
      return id ? { kind: "consumed", item: id, ...(goal.at ? { at: goal.at } : {}) } : null;
    }
    case "transform": {
      const id = resolve(goal.item);
      return id ? { kind: "facet", item: id, state: goal.state } : null;
    }
    case "toggle": {
      const id = resolve(goal.device);
      return id ? { kind: "toggled", item: id, state: goal.state } : null;
    }
    case "rest":
      return { kind: "rested", place: goal.place, ...(goal.dwellS !== undefined ? { dwellS: goal.dwellS } : {}) };
    case "setOpen":
      return { kind: "openState", place: goal.place, open: goal.open };
    case "wear": {
      const id = resolve(goal.item);
      return id ? { kind: "worn", item: id } : null;
    }
    case "converse":
      return { kind: "socialized", partner: goal.target };
    case "goTo":
      return { kind: "at", place: goal.place };
    default:
      return null; // not an item-errand — compileGoal keeps it
  }
}

/** Plan a goal into body steps by target-predicate regression, or null when it
 *  isn't an item errand (caller falls back to compileGoal) or can't be reached
 *  right now. The deterministic twin of compileGoal for the item family. */
export function planGoal(goal: GoalSpec, self: CreatureId, r: WorldResolver): GoalPlan | null {
  const target = goalTarget(goal, self, r);
  if (!target) return null;
  const steps = achieve(target, self, r);
  return steps ? { steps } : null;
}

// ---------------------------------------------------------------------------
// Per-tick pursuit — the ONE loop a command and a need both run
// ---------------------------------------------------------------------------

/** What a pursuing body should do THIS tick toward its goal. Because `planGoal`
 *  is state-relative (arrival + carrier aware), the pursuit is just "re-plan
 *  from where I am now, do the first thing": */
export type PursuitStep =
  /** The goal's target already holds — stop (the errand is complete). */
  | { kind: "done" }
  /** No plan reaches the goal from here (thing gone / unreachable / another
   *  holds it) — the caller speaks the reason and drops the pursuit. */
  | { kind: "blocked" }
  /** Still en route — walk toward `pos` (the next unwalked leg). */
  | { kind: "move"; pos: Vec2 }
  /** Arrived — perform `step` HERE. `last` ⇒ it's the final step, so the goal is
   *  achieved by doing it (don't re-plan into a false `blocked` when the acted-on
   *  item vanishes, e.g. an eaten apple no longer resolves). */
  | { kind: "act"; step: GoalStep; last: boolean };

/**
 * Decide the next move toward `goal` from the CURRENT world (via `r`). Re-run it
 * every tick: the state-relative planner drops walked legs and satisfied
 * preconditions, so the same call returns move → move → act → … → done as the
 * body progresses, and adapts for free when the world shifts under it (a closer
 * instance appears, the item is taken, an easier path opens). This is the whole
 * of "each step evaluated separately, interruptions resume, easier paths taken".
 */
export function pursue(goal: GoalSpec, self: CreatureId, r: WorldResolver): PursuitStep {
  const plan = planGoal(goal, self, r);
  if (!plan) return { kind: "blocked" };
  if (plan.steps.length === 0) return { kind: "done" };
  const first = plan.steps[0]!;
  if (first.kind === "moveTo") return { kind: "move", pos: first.pos };
  return { kind: "act", step: first, last: plan.steps.length === 1 };
}
