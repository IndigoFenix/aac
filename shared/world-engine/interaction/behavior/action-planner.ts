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
//
// ---------------------------------------------------------------------------
// THE TRACE — the plan's edges ARE causal facts (elemental-actions §2)
// ---------------------------------------------------------------------------
//
// The regression above builds a TREE and then throws it away: `achieve` returns
// a flat, concatenated `GoalStep[]`, so a body standing at the pantry cannot say
// WHY it is there. Elemental-actions §2 is explicit that the tree's edges are
// exactly the `because` / `in_order_to` chain the creature would speak — "I'm
// taking the food because I want to eat because I'm hungry" — so the fix is not
// to invent a second derivation but to KEEP the one the planner already makes.
//
// `achieveTraced` / `planStepsTraced` / `planTrace` / `pursueTraced` return a
// `PlanTrace` — a PARALLEL, INDEX-ALIGNED array with one `PlanEdge` per emitted
// step. It is parallel on purpose: the step objects stay byte-identical to what
// `achieve` / `planSteps` / `planGoal` / `pursue` have always emitted (they are
// deep-equality-pinned against `compileGoal`'s hand-written arrays), and the
// untraced entry points are unchanged, so this whole layer is additive and
// opt-in. Nothing in the engine reads it yet.
//
// The reading rule, one line: **every step an operator arm emits ITSELF traces
// to that arm's own target predicate (`serves`), with `parent` = the predicate
// whose precondition the arm was regressed for.** Steps that came out of a
// recursive sub-`achieve` carry the entry that recursion made. Because `near`
// and `at` are themselves operator arms, a walk leg that exists to reach a
// precondition traces as `near(item)` / `at(place)` — while a walk leg an arm
// emits DIRECTLY (the dining detour, the colour tub, the approach to a
// recipient) serves that arm's own predicate, because there is no separate
// predicate for it and inventing one would be a lie.
//
// Following `parent` upward from the current step yields the rung chain
// `near(banana) → holding(banana) → consumed(banana)`; the goal's own target
// predicate has no `parent`, which terminates the walk. That chain is the PLAN
// rung `reasonChainOf` (quest-host) is missing between link 0 (`creatureActivity`)
// and the origin ladder — see why-chains.md §4 `ReasonLink` / `reasonChainOf`.
// Wiring it into the host is a LATER stage; this module only keeps the facts.
//
// The trace is as deterministic as the steps: it is produced by the same single
// pass, with no search and no RNG, so the same inputs give a deep-equal trace.

import type { CreatureId, ItemId } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { GoalSpec, PlaceRef, PursuitGoal } from "@shared/world-engine/interaction/behavior/rules.js";
import type { GoalPlan, GoalStep, WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import type { Operator } from "@shared/world-engine/kernel/means-ends.js";
import { journeyTimeS, priceOf } from "@shared/world-engine/kernel/town/pricing.js";
import type { VerbCost } from "@shared/world-engine/kernel/town/scope-shape.js";
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
  // ⑫⑧ — the actor is FACING the member it is talking to. The mirror of
  // `socialized` with the journey taken out: same person, no walk, and the
  // price is the turn (`ADDRESS_DWELL_S`).
  | { kind: "addressed"; target: CreatureId }
  // Stack-economy micro-targets (S3): `units` of `category` moved between the
  // named store and the actor's own CARRY — the container it is holding or
  // wearing, else its hands (scope-unification.md §2.1). Terminal by design — one leg, one
  // act; the SELECTOR paces multi-leg errands (take at the market, then a fresh
  // stow-at-home goal), exactly the needs walker's bounded-step granularity.
  | { kind: "unitsTaken"; from: PlaceRef; category: string; units: number; affords?: string; tplKey?: string }
  | { kind: "unitsStowed"; into: PlaceRef; category: string; units: number; tplKey?: string }
  | { kind: "stackProcessed"; at: PlaceRef; category: string; drop?: string; add?: string; dwellS?: number; tplKey?: string }
  | { kind: "stackEquipped"; category: string; tplKey?: string }
  | { kind: "stackDropped"; category: string; units: number; tplKey?: string }
  | { kind: "stackConsumed"; category: string; at?: readonly string[]; tplKey?: string };

// ---------------------------------------------------------------------------
// The trace — one causal edge per emitted step (see the header)
// ---------------------------------------------------------------------------

/** ONE step's place in the regression tree: the predicate it directly achieves,
 *  and the predicate whose PRECONDITION that one is. `parent` is absent exactly
 *  on the goal's own target predicate, so walking `parent` upward terminates. */
export interface PlanEdge {
  /** The predicate this step directly achieves (pick → `holding`, eat →
   *  `consumed`, a precondition walk leg → the `near`/`at` it walks to). */
  readonly serves: Predicate;
  /** The predicate `serves` is a precondition OF — absent on the goal target. */
  readonly parent?: Predicate;
}

/** The regression tree kept as a flat, INDEX-ALIGNED companion to the step list:
 *  `trace[i]` is the causal edge of `steps[i]`, so `trace.length === steps.length`
 *  always. Parallel (never a field on `GoalStep`) so the steps stay byte-identical. */
export type PlanTrace = readonly PlanEdge[];

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
  return achieveInto(target, self, r, null);
}

/**
 * A traced plan, or the reason there isn't one.
 *
 * ⚖️ D7 — PRECONDITIONS ARE THE RESPONSE (elemental-actions §4). The untraced
 * entry points still answer a bare `null`; the TRACED ones answer with
 * `blockedAt` — the DEEPEST predicate whose operator arm returned null. Today
 * `achieveInto` rolls the trace back on a dead branch and the reason is lost
 * (`:184-186`), so `pursuitBlockLine` can only speak a line per GOAL KIND. The
 * EDGE roll-back stays exactly as it was — a null plan still leaves no edges —
 * and only the failed TARGET is recorded beside it.
 */
export type TracedPlan =
  | { steps: GoalStep[]; trace: PlanTrace; blockedAt?: undefined }
  | { steps: null; trace?: undefined; blockedAt?: Predicate };

/** The deepest-failure slot threaded through the regression (see `TracedPlan`).
 *  A mutable one-field box rather than a return value, so the arms' own shapes
 *  and the untraced path stay byte-identical. */
interface FailSlot {
  at?: Predicate;
}

/**
 * `achieve` plus the regression tree it walked, as an index-aligned `PlanTrace`
 * (header: "THE TRACE"). The `steps` are byte-identical to `achieve`'s — this is
 * the same single pass with a collector attached, not a second derivation.
 *
 * On failure the `blockedAt` arm is ALWAYS populated (the target itself when no
 * sub-goal got deeper) — `planStepsTraced` is the entry that can answer without
 * one, because a goal that isn't an item errand has no predicate to name.
 */
export function achieveTraced(target: Predicate, self: CreatureId, r: WorldResolver): TracedPlan {
  const trace: PlanEdge[] = [];
  const fail: FailSlot = {};
  const steps = achieveInto(target, self, r, trace, undefined, fail);
  return steps ? { steps, trace } : { steps: null, blockedAt: fail.at ?? target };
}

/**
 * The regression, with an OPTIONAL edge collector. `trace === null` is the
 * untraced path and runs exactly the code it always did; when a collector is
 * supplied, each arm appends one edge per step IT emitted, after the edges its
 * recursive sub-plans appended for the steps they contributed (every arm below
 * puts its sub-plan's steps FIRST and its own steps after, so append order and
 * step order agree). A sub-plan that succeeded inside an arm that then fails is
 * rolled back to the mark, so a null plan leaves no edges behind.
 *
 * ⚖️ D7 — `fail` records the DEEPEST arm that returned null, and mirrors the
 * trace's own mark/roll-back discipline: an arm that SUCCEEDS restores whatever
 * the slot held on entry, so a failure inside an abandoned branch (the dining
 * leg's `holding` regression, before the arm falls through to eat-where-it-lies)
 * is discarded exactly as its edges are. Deepest wins because the innermost arm
 * fails FIRST and its ancestors only fill an EMPTY slot.
 */
function achieveInto(
  target: Predicate,
  self: CreatureId,
  r: WorldResolver,
  trace: PlanEdge[] | null,
  parent?: Predicate,
  fail?: FailSlot,
): GoalStep[] | null {
  const mark = trace ? trace.length : 0;
  const failMark = fail?.at;
  const steps = achieveOperator(target, self, r, trace, fail);
  if (!steps) {
    if (trace) trace.length = mark; // this branch is dead — un-record it
    if (fail && fail.at === undefined) fail.at = target; // …and the deepest failure is kept
    return null;
  }
  if (fail) fail.at = failMark; // this branch lived — un-record any dead sub-branch
  if (trace) {
    // Everything not accounted for by a sub-plan's edges is this arm's own.
    const own = steps.length - (trace.length - mark);
    for (let i = 0; i < own; i++) trace.push(parent === undefined ? { serves: target } : { serves: target, parent });
  }
  return steps;
}

function achieveOperator(
  target: Predicate,
  self: CreatureId,
  r: WorldResolver,
  trace: PlanEdge[] | null,
  fail?: FailSlot,
): GoalStep[] | null {
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
      const near = achieveInto({ kind: "near", item: target.item }, self, r, trace, target, fail);
      return near ? [...near, { kind: "pick", itemId: target.item }] : null;
    }
    case "in": {
      const hold = achieveInto({ kind: "holding", item: target.item }, self, r, trace, target, fail);
      if (!hold) return null;
      const pos = r.place(target.container);
      if (!pos) return null;
      return [...hold, ...legTo(pos), { kind: "place", itemId: target.item, place: target.container }];
    }
    case "possessed": {
      const hold = achieveInto({ kind: "holding", item: target.item }, self, r, trace, target, fail);
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
          const hold = achieveInto({ kind: "holding", item: target.item }, self, r, trace, target, fail);
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
      const hold = achieveInto({ kind: "holding", item: target.item }, self, r, trace, target, fail);
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
      const hold = achieveInto({ kind: "holding", item: target.item }, self, r, trace, target, fail);
      return hold ? [...hold, { kind: "equip", itemId: target.item }] : null;
    }
    case "colored": {
      // Recolour with the item IN HAND at a coloring tub (a water barrel/bath):
      // regress `holding` (carry it over), walk to the tub if one resolves, then
      // swap the colour. No tub nearby → recolour in hand where you stand (like
      // `consumed`'s else-in-place), so a commanded colour never dead-ends. The
      // terminal `color` step's `last` ends the pursuit.
      const hold = achieveInto({ kind: "holding", item: target.item }, self, r, trace, target, fail);
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
    case "addressed": {
      // ⑫⑧ — TURN, WHERE YOU STAND. **No `legTo`, on purpose**: addressing is
      // the channel you buy WITHOUT going anywhere (law ② — the look is a
      // beat, not a journey), and emitting a walk leg here would quietly turn
      // it into `converse` and price it as one. So the plan is ONE step, and
      // `pricePlan` therefore reports `journeyS: 0` on its own arithmetic
      // rather than on a special case — which is the honest reading: the
      // distance to somebody you are already standing in a ring with is not
      // what stopping to face them costs.
      //
      // A target with no position at all is somebody who is not here to be
      // faced ⇒ null (blocked), the same answer `socialized` gives.
      return r.positionOf(target.target) ? [{ kind: "address", target: target.target }] : null;
    }
    case "unitsTaken": {
      // Walk to the store and WITHDRAW — the executor moves the units onto the
      // body (market accounting, lid access, carry bounds all its own).
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
// THE OPERATOR GRAPH AS DATA (emergent-plans-round.md D3)
// ---------------------------------------------------------------------------
//
// The switch above IS the schema, written as engine code. This table is the
// SAME schema written as rows — one row per arm, `needs` = exactly the
// predicate kinds that arm regresses through `achieveInto`, `link` = the
// GoalStep kind the arm's own step emits.
//
// ⚖️ IT IS A MIRROR, NOT A SOURCE. The switch is not rewritten to walk it:
// re-expressing 20 hand-tuned arms (the dining fork, the already-served case,
// the take-from hand-off, the optional colour tub) as row data would be a
// refactor with zero behavioural gain across a 1 100-line pin surface. What the
// table buys is what the doc actually wanted (§3.2): the chain becomes a
// DERIVED property — `validateOperators` proves it acyclic and 3 deep instead
// of a header comment claiming it, and a later teaching seam has a table to add
// a row to. A jest pin replays the planner suite's own fixtures and asserts
// every `parent → serves` pair the regression ACTUALLY emits is an edge here,
// so the mirror cannot drift from the switch unnoticed.
//
// 🚨 PRIMITIVES-ONLY: every id below is a predicate KIND or a step KIND. No
// world kind ever appears, and none may.
export const OPERATOR_GRAPH: readonly Operator<Predicate["kind"], GoalStep["kind"]>[] = [
  // Leaves — a walk, or a walk-then-act with nothing to acquire first.
  { link: "moveTo", achieves: "at", needs: [] },
  { link: "moveTo", achieves: "near", needs: [] },
  { link: "toggle", achieves: "toggled", needs: [] },
  { link: "rest", achieves: "rested", needs: [] },
  { link: "openClose", achieves: "openState", needs: [] },
  { link: "converse", achieves: "socialized", needs: [] },
  { link: "address", achieves: "addressed", needs: [] },
  // The one rung with a precondition of its own: you must be BESIDE a thing to
  // lift it. (The take-from hand-off walks to the HOLDER instead — same arm,
  // same `holding` target, no `near` rung; that is a branch inside the arm, not
  // a second operator.)
  { link: "pick", achieves: "holding", needs: ["near"] },
  // …and everything an item errand does to a thing it must first be HOLDING.
  { link: "place", achieves: "in", needs: ["holding"] },
  { link: "give", achieves: "possessed", needs: ["holding"] },
  { link: "eat", achieves: "consumed", needs: ["holding"] },
  { link: "transform", achieves: "facet", needs: ["holding"] },
  { link: "equip", achieves: "worn", needs: ["holding"] },
  { link: "color", achieves: "colored", needs: ["holding"] },
  // The stack micro-targets are TERMINAL BY DESIGN — one leg, one act; the
  // SELECTOR paces a multi-leg errand (`:106-108`). So every one of them is a
  // leaf, and a schema row that gave one a precondition would be describing a
  // different engine.
  { link: "withdraw", achieves: "unitsTaken", needs: [] },
  { link: "stow", achieves: "unitsStowed", needs: [] },
  { link: "processStack", achieves: "stackProcessed", needs: [] },
  { link: "equipStack", achieves: "stackEquipped", needs: [] },
  { link: "dropStack", achieves: "stackDropped", needs: [] },
  { link: "consumeStack", achieves: "stackConsumed", needs: [] },
];

// ---------------------------------------------------------------------------
// Goal → target predicate (the vocabulary table)
// ---------------------------------------------------------------------------

/** The item-errand family the planner OWNS. Movement (goHome/goTo/follow/stay),
 *  social acts, and host-policy goals (build/area/trade/help/place) stay in
 *  compileGoal — they aren't precondition chains over a carried item. */
export function goalTarget(goal: PursuitGoal, self: CreatureId, r: WorldResolver): Predicate | null {
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
    case "address":
      return { kind: "addressed", target: goal.target };
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

/**
 * THE INVERSE OF `goalTarget` — a predicate back to the goal that wants it
 * (emergent-plans-round.md D6).
 *
 * ⚖️ WORD-FREE, AND THAT IS THE WHOLE POINT (why-chains law ④ — NO NEW
 * LEXICON). The `why` chain needs a READING for a rung of the plan, and the one
 * function that already words every goal in the engine is `goalActivity`. So
 * this hands the plan rung back to that function instead of growing a second
 * predicate→words table beside it: `goalActivity(predicateGoal(edge.serves))`
 * is the same sentence the same body would speak about the same goal, which is
 * exactly why the activity a creature claims and the chain it explains cannot
 * disagree.
 *
 * TWO KINDS ANSWER NULL, both deliberately:
 *   • `near` — NO GoalSpec's target predicate is `near`; `goTo` maps to `at`,
 *     over a PLACE, and a `goTo` synthesised at an item's position would be a
 *     goal nobody has. A walk leg that serves `near(item)` speaks its PARENT's
 *     reading ("get the apple"), which is what the legacy need-step path has
 *     always said of a take's walk (`going.ts:84-94`) — D6's walk-leg rule.
 *   • `addressed` — an `AddressGoal` is deliberately OUTSIDE `GoalSpec`
 *     ("an order is not negotiable", `rules.ts:300-319`), so it cannot be
 *     returned from a `GoalSpec` seat. The address rung collapses, law ④.
 */
export function predicateGoal(p: Predicate): GoalSpec | null {
  switch (p.kind) {
    case "at":
      return { kind: "goTo", place: p.place };
    case "near":
      return null; // the parent speaks for it — see the docblock
    case "holding":
      return {
        kind: "fetch",
        item: { id: p.item },
        ...(p.takeFrom !== undefined ? { from: { kind: "creature" as const, id: p.takeFrom } } : {}),
      };
    case "in":
      return { kind: "putIn", item: { id: p.item }, container: p.container };
    case "possessed":
      return { kind: "give", item: { id: p.item }, to: p.by };
    case "consumed":
      return { kind: "consume", item: { id: p.item }, ...(p.at ? { at: p.at } : {}) };
    case "facet":
      return { kind: "transform", item: { id: p.item }, state: p.state };
    case "toggled":
      return { kind: "toggle", device: { id: p.item }, state: p.state };
    case "rested":
      return {
        kind: "rest",
        place: p.place,
        ...(p.dwellS !== undefined ? { dwellS: p.dwellS } : {}),
        ...(p.pose ? { pose: p.pose } : {}),
      };
    case "openState":
      return { kind: "setOpen", place: p.place, open: p.open };
    case "worn":
      return { kind: "wear", item: { id: p.item } };
    case "colored":
      return { kind: "color", item: { id: p.item }, color: p.color };
    case "socialized":
      return { kind: "converse", target: p.partner };
    case "addressed":
      return null; // an AddressGoal is not a GoalSpec — see the docblock
    case "unitsTaken":
      return {
        kind: "takeUnits",
        from: p.from,
        category: p.category,
        units: p.units,
        ...(p.affords ? { affords: p.affords } : {}),
        ...(p.tplKey ? { tplKey: p.tplKey } : {}),
      };
    case "unitsStowed":
      return {
        kind: "putUnits",
        into: p.into,
        category: p.category,
        units: p.units,
        ...(p.tplKey ? { tplKey: p.tplKey } : {}),
      };
    case "stackProcessed":
      return {
        kind: "processUnits",
        at: p.at,
        category: p.category,
        ...(p.drop ? { drop: p.drop } : {}),
        ...(p.add ? { add: p.add } : {}),
        ...(p.dwellS !== undefined ? { dwellS: p.dwellS } : {}),
        ...(p.tplKey ? { tplKey: p.tplKey } : {}),
      };
    case "stackEquipped":
      return { kind: "equipUnits", category: p.category, ...(p.tplKey ? { tplKey: p.tplKey } : {}) };
    case "stackDropped":
      return {
        kind: "dropUnits",
        category: p.category,
        units: p.units,
        ...(p.tplKey ? { tplKey: p.tplKey } : {}),
      };
    case "stackConsumed":
      return {
        kind: "consumeUnits",
        category: p.category,
        ...(p.at ? { at: p.at } : {}),
        ...(p.tplKey ? { tplKey: p.tplKey } : {}),
      };
  }
}

// ---------------------------------------------------------------------------
// THE PRICE OF A PLAN (step ④ — scope-behaviors.md §2.3 PREFER, §3 the
// currency, §5 seat 3)
// ---------------------------------------------------------------------------
//
// The surveys' verdict on this layer: "`handsS` and `forgoneS` have zero
// implementations in the repo — labour is free everywhere", and the geometric
// special cases below (`SAME_SPOT_M`, the dining leg, the tub fork) are
// comparisons spelled as branches. This is the missing arithmetic, and NOTHING
// else: a plan is a list of legs and acts, so its price is the walking plus the
// hands, in that order, summed. The formulas stay in kernel/town/pricing.ts, so
// a body's market trip and a caravan's route price the same way.
//
// 🚨 THE WALK IS CHAINED, not radial. Leg two starts where leg one ended, which
// is the whole reason a plan can be priced at all: "fetch the basket, then go to
// the market" is dearer than "go to the market" by exactly the detour, and that
// difference IS the ENABLE comparison (§2.4). Measuring every leg from the body
// would price a detour as free.

/**
 * Price a compiled step list in hand-seconds. `spoilageS`/`forgoneS` stay 0
 * this pass (chapter §3 — forgone is what the argmax itself produces, once
 * there is an argmax to read it off).
 *
 * An UNPRICED resolver (`r.price` absent) returns all zeros, which is what
 * makes an unpriced candidate set tie and the first-compilable order decide —
 * the byte-identical property every seat's flag promises.
 */
export function pricePlan(steps: readonly GoalStep[], self: CreatureId, r: WorldResolver): VerbCost {
  const p = r.price;
  if (!p) return priceOf({});
  // Where the walk starts. An unlocatable body prices its FIRST leg at zero and
  // chains honestly from there — a plan is still comparable by its detours even
  // when the world cannot say where the walker stands.
  let at = r.positionOf(self);
  let journeyS = 0;
  let handsS = 0;
  // ⚖️ W1 — PAY WHAT YOU PRICE. A leg's metres are whatever the body will
  // really walk: street metres in a town (the resolver hands its road measure
  // down through `p.journeyM`), the chord everywhere else. The default keeps
  // an unwired world byte-identical.
  const legM = p.journeyM ?? ((a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y));
  for (const step of steps) {
    if (step.kind === "moveTo") {
      if (at) journeyS += journeyTimeS(legM(at, step.pos), p.walkMps);
      at = step.pos;
      continue;
    }
    handsS += p.handsS(step);
  }
  return priceOf({ journeyS, handsS });
}

/** The step list for a goal by target-predicate regression, or null when it
 *  isn't an item errand (caller falls back to compileGoal) or can't be reached
 *  right now. `planGoal` is this plus the price. */
export function planSteps(goal: PursuitGoal, self: CreatureId, r: WorldResolver): GoalStep[] | null {
  const target = goalTarget(goal, self, r);
  if (!target) return null;
  return achieve(target, self, r);
}

/** `planSteps` plus the plan's causal edges (header: "THE TRACE"). `steps` is
 *  byte-identical to `planSteps`; `trace` is index-aligned with it, so
 *  `trace.length === steps.length` and `trace[i]` says which predicate `steps[i]`
 *  achieves and which predicate that one is a precondition of. `steps: null` on
 *  exactly the same inputs `planSteps` returns null for.
 *
 *  ⚖️ D7 — `blockedAt` names the deepest predicate whose arm failed, and is
 *  ABSENT in exactly one case: `goalTarget` answered null, i.e. this is not an
 *  item errand (or its item does not resolve), so there is no predicate to
 *  name and inventing one would be a lie. */
export function planStepsTraced(goal: PursuitGoal, self: CreatureId, r: WorldResolver): TracedPlan {
  const target = goalTarget(goal, self, r);
  if (!target) return { steps: null };
  return achieveTraced(target, self, r);
}

/** Just the causal edges of the plan for `goal` — the `why` rung, without the
 *  steps. Walk `parent` upward from `trace[i]` to read a step's reason chain
 *  (`near(banana) → holding(banana) → consumed(banana)`); the goal's own target
 *  has no `parent`, so the walk terminates. */
export function planTrace(goal: PursuitGoal, self: CreatureId, r: WorldResolver): PlanTrace | null {
  return planStepsTraced(goal, self, r).trace ?? null;
}

/** Plan a goal into body steps by target-predicate regression, or null when it
 *  isn't an item errand (caller falls back to compileGoal) or can't be reached
 *  right now. The deterministic twin of compileGoal for the item family. */
export function planGoal(goal: PursuitGoal, self: CreatureId, r: WorldResolver): GoalPlan | null {
  const steps = planSteps(goal, self, r);
  return steps ? { steps, cost: pricePlan(steps, self, r) } : null;
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
export function pursue(goal: PursuitGoal, self: CreatureId, r: WorldResolver): PursuitStep {
  const plan = planGoal(goal, self, r);
  if (!plan) return { kind: "blocked" };
  if (plan.steps.length === 0) return { kind: "done" };
  const first = plan.steps[0]!;
  if (first.kind === "moveTo") return { kind: "move", pos: first.pos };
  return { kind: "act", step: first, last: plan.steps.length === 1 };
}

/** A `PursuitStep` carrying the CURRENT step's causal edge. `serves`/`parent`
 *  ride only the traced call — `pursue`'s own shape is untouched — and are
 *  absent on `done`/`blocked` (there is no step to explain).
 *
 *  ⚖️ D7 — `blockedAt` rides `blocked` alone, and only when a predicate can
 *  honestly be named (see `planStepsTraced`): the caller may speak the FAILED
 *  PRECONDITION instead of a line per goal kind. */
export type TracedPursuitStep = PursuitStep & {
  serves?: Predicate;
  parent?: Predicate;
  blockedAt?: Predicate;
};

/**
 * `pursue` plus the WHY of the step it chose: which predicate this tick's move
 * or act directly achieves, and which predicate that one serves. Walking
 * `parent` upward from `serves` (via the full `planTrace`) is the plan rung of
 * a `why` answer — "I'm walking over BECAUSE I want to hold it BECAUSE I want
 * to eat it". The move/act decision is the same arithmetic `pursue` does, on
 * the same steps; only the extra fields are new.
 */
export function pursueTraced(goal: PursuitGoal, self: CreatureId, r: WorldResolver): TracedPursuitStep {
  const planned = planStepsTraced(goal, self, r);
  if (planned.steps === null) {
    return planned.blockedAt ? { kind: "blocked", blockedAt: planned.blockedAt } : { kind: "blocked" };
  }
  const { steps, trace } = planned;
  if (steps.length === 0) return { kind: "done" };
  const first = steps[0]!;
  const edge = trace[0];
  const why = edge ? { serves: edge.serves, ...(edge.parent !== undefined ? { parent: edge.parent } : {}) } : {};
  if (first.kind === "moveTo") return { kind: "move", pos: first.pos, ...why };
  return { kind: "act", step: first, last: steps.length === 1, ...why };
}
