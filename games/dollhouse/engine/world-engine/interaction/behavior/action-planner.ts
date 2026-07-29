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

/** When two RESOLVED points are the SAME SPOT (metres). Both sides come from the
 *  same resolver, which reports an item on a station and the station itself at
 *  one shared approach point — so this is float slack on an equality test, not a
 *  proximity radius. */
const SAME_SPOT_M = 0.01;

// ---------------------------------------------------------------------------
// Predicates — the state a goal wants TRUE (the "meaning" layer)
// ---------------------------------------------------------------------------

/** A world/agent state predicate the planner reasons about. Refs are RESOLVED
 *  (concrete ids), so planning is pure geometry over the resolver. */
export type Predicate =
  | { kind: "at"; place: PlaceRef } // the actor stands at a place
  | { kind: "near"; item: ItemId } // the actor stands by an item
  // `takeFrom` = a SOURCE creature the plan may take the item FROM ("take ball
  // from dog"): its hands are a legitimate pickup spot, not a block.
  | { kind: "holding"; item: ItemId; takeFrom?: CreatureId } // the item is in the actor's hand
  | { kind: "in"; item: ItemId; container: PlaceRef } // the item sits in a container
  | { kind: "possessed"; item: ItemId; by: CreatureId } // a creature holds the item
  // `at` = dining preference (station kinds): eat THERE when one resolves.
  | { kind: "consumed"; item: ItemId; at?: readonly string[] } // the item is used up (eaten/drunk)
  | { kind: "facet"; item: ItemId; state: string } // the item carries a state (clean/hot)
  | { kind: "toggled"; item: ItemId; state: string } // a device is open/closed/on/off
  // `dwellS` = episode length (a need's nap vs the commanded-sit default);
  // `pose` overrides the fixture-derived pose — plan parameters riding the
  // predicate, not world state.
  | { kind: "rested"; place: PlaceRef; dwellS?: number; pose?: "sleep" | "sit" | "play" } // the body has occupied a rest station
  | { kind: "openState"; place: PlaceRef; open: boolean } // a container lid is open/shut
  | { kind: "worn"; item: ItemId } // the garment is ON the body
  | { kind: "colored"; item: ItemId; color: string } // the item carries the colour facet
  | { kind: "socialized"; partner: CreatureId } // the actor has exchanged with the partner
  // Stack-economy micro-targets (S3): `units` of `category` moved between the
  // named store and the actor's abstract bag. Terminal by design — one leg, one
  // act; the SELECTOR paces multi-leg errands (take at the market, then a fresh
  // stow-at-home goal), exactly the needs walker's bounded-step granularity.
  | { kind: "unitsTaken"; from: PlaceRef; category: string; units: number; affords?: string; tplKey?: string }
  | { kind: "unitsStowed"; into: PlaceRef; category: string; units: number; tplKey?: string }
  | { kind: "stackProcessed"; at: PlaceRef; category: string; drop?: string; add?: string; dwellS?: number; tplKey?: string }
  | { kind: "stackEquipped"; category: string; tplKey?: string }
  | { kind: "stackDropped"; category: string; units: number; tplKey?: string }
  | { kind: "stackConsumed"; category: string; at?: readonly string[]; tplKey?: string };

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
      if (holder) {
        // An explicitly named SOURCE creature may be taken from ("take ball
        // from dog"): walk to the holder, hand-to-hand take. Any OTHER holder
        // stays not-snatchable.
        if (target.takeFrom !== undefined && holder === target.takeFrom) {
          const to = r.positionOf(holder);
          return to ? [...legTo(to), { kind: "pick", itemId: target.item, from: holder }] : null;
        }
        return null;
      }
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
          // ALREADY SERVED — the meal is ON the station it would be carried to.
          // A dining leg only makes sense when the food is somewhere ELSE; food
          // resting on the table (the plated meal, the filled bowl) resolves to
          // that station's own approach point, so regressing `holding` first
          // sends the body to lift a plate off the very table it is walking
          // toward. Worse, a prop shown on a surface is a MIRROR of a stack unit
          // and offers no carry affordance at all, so that pickup can never
          // succeed and the plan never advances — the observed "told to eat
          // something off the table, gets stuck". Walk over and eat it where it
          // sits, exactly the eat-where-it-lies below.
          const on = holder === self ? null : r.itemPosition(target.item);
          if (on && Math.hypot(on.x - spot.x, on.y - spot.y) <= SAME_SPOT_M) {
            return [...legTo(spot), { kind: "eat", itemId: target.item }];
          }
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
      return [
        ...legTo(pos),
        {
          kind: "rest",
          place: target.place,
          ...(target.dwellS !== undefined ? { dwellS: target.dwellS } : {}),
          ...(target.pose ? { pose: target.pose } : {}),
        },
      ];
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
    case "colored": {
      // Recolour with the item IN HAND at a coloring tub (a water barrel/bath):
      // regress `holding` (carry it over), walk to the tub if one resolves, then
      // swap the colour. No tub nearby → recolour in hand where you stand (like
      // `consumed`'s else-in-place), so a commanded colour never dead-ends. The
      // terminal `color` step's `last` ends the pursuit.
      const hold = achieve({ kind: "holding", item: target.item }, self, r);
      if (!hold) return null;
      const tub = r.colorStation?.(self) ?? null;
      const leg = tub ? legTo(tub) : [];
      return [...hold, ...leg, { kind: "color", itemId: target.item, color: target.color }];
    }
    case "socialized": {
      // Walk to the partner, then EXCHANGE. Re-planned each tick, so a partner
      // that wanders is chased (the position updates); gone entirely → null
      // (blocked). The terminal `converse` step's `last` ends the pursuit.
      const to = r.positionOf(target.partner);
      return to ? [...legTo(to), { kind: "converse", target: target.partner }] : null;
    }
    case "unitsTaken": {
      // Walk to the store and WITHDRAW — the executor moves the units into the
      // abstract bag (market accounting, lid access, carry bounds all its own).
      // The store must be a NAMED object: the id the walk resolves is the id
      // the withdraw acts on, one source of truth.
      if (target.from.kind !== "named") return null;
      const pos = r.place(target.from);
      if (!pos) return null;
      return [
        ...legTo(pos),
        {
          kind: "withdraw",
          fromId: target.from.id,
          goodKey: target.category,
          units: target.units,
          ...(target.affords ? { affords: target.affords } : {}),
          ...(target.tplKey ? { tplKey: target.tplKey } : {}),
        },
      ];
    }
    case "unitsStowed": {
      // Walk to the container and STOW the carried units into it.
      if (target.into.kind !== "named") return null;
      const pos = r.place(target.into);
      if (!pos) return null;
      return [
        ...legTo(pos),
        {
          kind: "stow",
          intoId: target.into.id,
          goodKey: target.category,
          units: target.units,
          ...(target.tplKey ? { tplKey: target.tplKey } : {}),
        },
      ];
    }
    case "stackProcessed": {
      // Walk to the station and WORK the carried units there (the executor
      // dwells the body posed and lands the facet edit — dirty drops, hot adds).
      if (target.at.kind !== "named") return null;
      const pos = r.place(target.at);
      if (!pos) return null;
      return [
        ...legTo(pos),
        {
          kind: "processStack",
          atId: target.at.id,
          goodKey: target.category,
          ...(target.drop ? { drop: target.drop } : {}),
          ...(target.add ? { add: target.add } : {}),
          ...(target.dwellS !== undefined ? { dwellS: target.dwellS } : {}),
          ...(target.tplKey ? { tplKey: target.tplKey } : {}),
        },
      ];
    }
    case "stackEquipped":
      // In place — you dress where you stand (the carried garment goes ON).
      return [{ kind: "equipStack", goodKey: target.category, ...(target.tplKey ? { tplKey: target.tplKey } : {}) }];
    case "stackDropped":
      // In place — set the carried units down at the feet.
      return [
        {
          kind: "dropStack",
          goodKey: target.category,
          units: target.units,
          ...(target.tplKey ? { tplKey: target.tplKey } : {}),
        },
      ];
    case "stackConsumed": {
      // Eat from the BAG: walk to the dining station when the preference
      // resolves (the seat show), else consume where you stand — the
      // consumeAt/consumeHere pair as one plan.
      const spot = target.at?.length ? (r.diningSpot?.(self, target.at) ?? null) : null;
      return [
        ...(spot ? legTo(spot) : []),
        {
          kind: "consumeStack",
          goodKey: target.category,
          ...(target.at ? { at: target.at } : {}),
          ...(target.tplKey ? { tplKey: target.tplKey } : {}),
        },
      ];
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
  const resolve = (ref: Parameters<WorldResolver["resolveItem"]>[0], from?: PlaceRef) =>
    r.resolveItem(ref, self, from);
  switch (goal.kind) {
    case "fetch": {
      const id = resolve(goal.item, goal.from);
      if (!id) return null;
      const takeFrom = goal.from?.kind === "creature" ? goal.from.id : undefined;
      return { kind: "holding", item: id, ...(takeFrom !== undefined ? { takeFrom } : {}) };
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
      return {
        kind: "rested",
        place: goal.place,
        ...(goal.dwellS !== undefined ? { dwellS: goal.dwellS } : {}),
        ...(goal.pose ? { pose: goal.pose } : {}),
      };
    case "setOpen":
      return { kind: "openState", place: goal.place, open: goal.open };
    case "wear": {
      const id = resolve(goal.item);
      return id ? { kind: "worn", item: id } : null;
    }
    case "color": {
      const id = resolve(goal.item);
      return id ? { kind: "colored", item: id, color: goal.color } : null;
    }
    case "converse":
      return { kind: "socialized", partner: goal.target };
    case "takeUnits":
      return {
        kind: "unitsTaken",
        from: goal.from,
        category: goal.category,
        units: goal.units,
        ...(goal.affords ? { affords: goal.affords } : {}),
        ...(goal.tplKey ? { tplKey: goal.tplKey } : {}),
      };
    case "putUnits":
      return {
        kind: "unitsStowed",
        into: goal.into,
        category: goal.category,
        units: goal.units,
        ...(goal.tplKey ? { tplKey: goal.tplKey } : {}),
      };
    case "processUnits":
      return {
        kind: "stackProcessed",
        at: goal.at,
        category: goal.category,
        ...(goal.drop ? { drop: goal.drop } : {}),
        ...(goal.add ? { add: goal.add } : {}),
        ...(goal.dwellS !== undefined ? { dwellS: goal.dwellS } : {}),
        ...(goal.tplKey ? { tplKey: goal.tplKey } : {}),
      };
    case "equipUnits":
      return { kind: "stackEquipped", category: goal.category, ...(goal.tplKey ? { tplKey: goal.tplKey } : {}) };
    case "dropUnits":
      return {
        kind: "stackDropped",
        category: goal.category,
        units: goal.units,
        ...(goal.tplKey ? { tplKey: goal.tplKey } : {}),
      };
    case "consumeUnits":
      return {
        kind: "stackConsumed",
        category: goal.category,
        ...(goal.at ? { at: goal.at } : {}),
        ...(goal.tplKey ? { tplKey: goal.tplKey } : {}),
      };
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
