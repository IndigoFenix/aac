// THE PLAN TRACE (action-planner.ts) — the regression tree kept as a PARALLEL,
// index-aligned companion to the step list, so a body at the pantry can say WHY
// it is there (elemental-actions-emergent-plans.md §2: "the plan's edges ARE
// causal facts"; why-chains.md §4 `ReasonLink` / `reasonChainOf`'s missing plan
// rung). Two properties are load-bearing and both are pinned here:
//
//   1. `trace.length === steps.length`, and `trace[i]` explains `steps[i]`.
//   2. The STEPS ARE UNTOUCHED. The trace rides beside them, never on them, so
//      the 70 deep-equality pins in symbol-game-action-planner.test.ts (which
//      compare `planGoal` against `compileGoal`'s hand-written arrays) cannot
//      move. The untraced `pursue`/`planSteps`/`planGoal` are byte-identical.
//
// Pure — no DB, no host. Safe in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import type { WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import {
  achieveTraced,
  planStepsTraced,
  planTrace,
  pursue,
  pursueTraced,
  planSteps,
  OPERATOR_GRAPH,
  type PlanTrace,
  type Predicate,
} from "@shared/world-engine/interaction/behavior/action-planner.js";
import { validateOperators } from "@shared/world-engine/kernel/means-ends.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";
import type { GoalStep } from "@shared/world-engine/interaction/behavior/goal-selection.js";

/** Narrow a traced plan to its SUCCESS arm. ⚖️ D7 widened the traced entries
 *  from `… | null` to `… | { steps: null; blockedAt }`, so the old `!` no
 *  longer narrows; the blocked pins below assert on the other arm directly. */
function planned(res: ReturnType<typeof planStepsTraced>): { steps: GoalStep[]; trace: PlanTrace } {
  expect(res.steps).not.toBeNull();
  return res as { steps: GoalStep[]; trace: PlanTrace };
}

// The SAME tiny world the action-planner suite uses, so a trace pin and a step
// pin are talking about the same plan: bear at origin, apple loose at (10,0), a
// named place ("box"/station) at (4,0), mara at (6,0), a state station at (2,0).
function resolver(carrier: string | null = null): WorldResolver {
  const items: Record<string, { x: number; y: number }> = { apple1: { x: 10, y: 0 } };
  const creatures: Record<string, { x: number; y: number }> = { bear: { x: 0, y: 0 }, mara: { x: 6, y: 0 } };
  return {
    positionOf: (id) => creatures[id] ?? null,
    homeOf: () => ({ x: -5, y: 0 }),
    place: (p) =>
      p.kind === "named"
        ? { x: 4, y: 0 }
        : p.kind === "creature"
          ? (creatures[p.id] ?? null)
          : p.kind === "point"
            ? { x: p.x, y: p.y }
            : null,
    resolveItem: (ref) => ("id" in ref ? ref.id : "apple1"),
    itemPosition: (id) => items[id] ?? null,
    stationFor: () => ({ x: 2, y: 0 }),
    carrierOf: (id) => (id === "apple1" ? carrier : null),
  };
}

/** The dining world: the apple is loose at (10,0), the table is at (3,0). */
const dining = (carrier: string | null = null): WorldResolver => ({
  ...resolver(carrier),
  diningSpot: (_self, kinds) => (kinds.includes("table") ? { x: 3, y: 0 } : null),
});

const NEAR_APPLE: Predicate = { kind: "near", item: "apple1" };
const HOLD_APPLE: Predicate = { kind: "holding", item: "apple1" };

/** Walk `parent` upward from `trace[i]`, cycle-guarded. Returns the rung chain
 *  bottom-up; the last rung is the one with no parent (the goal's own target). */
function chainOf(trace: PlanTrace, i: number): Predicate[] {
  const chain: Predicate[] = [];
  const seen = new Set<string>();
  let edge = trace[i];
  while (edge) {
    const key = JSON.stringify(edge.serves);
    expect(seen.has(key)).toBe(false); // no cycles — the regression graph is acyclic
    seen.add(key);
    chain.push(edge.serves);
    if (edge.parent === undefined) break;
    const up = edge.parent;
    // The parent rung is the edge of the step that achieves it — find its own
    // edge so the walk can continue, else the parent IS the terminal rung.
    const next = trace.find((e) => JSON.stringify(e.serves) === JSON.stringify(up));
    if (!next) {
      chain.push(up);
      break;
    }
    edge = next;
  }
  return chain;
}

/** The invariant every traced plan owes: aligned length, and every chain ends
 *  at `target` with nothing above it. */
function expectWellFormed(steps: readonly unknown[], trace: PlanTrace, target: Predicate) {
  expect(trace.length).toBe(steps.length);
  for (let i = 0; i < trace.length; i++) {
    const chain = chainOf(trace, i);
    expect(chain[chain.length - 1]).toEqual(target); // terminates at the goal target
  }
  // Exactly the goal's own predicate is parentless.
  for (const e of trace) if (e.parent === undefined) expect(e.serves).toEqual(target);
}

describe("consume, far, loose on the floor — the headline chain near → holding → consumed", () => {
  const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
  const target: Predicate = { kind: "consumed", item: "apple1", at: ["table"] };

  it("the STEPS are exactly what the untraced planner emits (nothing moved)", () => {
    const traced = planned(planStepsTraced(goal, "bear", dining()));
    expect(traced.steps).toEqual([
      { kind: "moveTo", pos: { x: 10, y: 0 } }, // to the apple
      { kind: "pick", itemId: "apple1" }, // hold it
      { kind: "moveTo", pos: { x: 3, y: 0 } }, // carry it to the table
      { kind: "eat", itemId: "apple1" },
    ]);
    expect(traced.steps).toEqual(planSteps(goal, "bear", dining()));
  });

  it("the TRACE is index-aligned and reads `near BECAUSE holding BECAUSE consumed`", () => {
    const trace = planTrace(goal, "bear", dining())!;
    expect(trace).toEqual([
      { serves: NEAR_APPLE, parent: HOLD_APPLE }, // the walk, to get near the apple
      { serves: HOLD_APPLE, parent: target }, // the pick, to hold it
      { serves: target }, // the dining leg the consume arm emits itself
      { serves: target }, // the eat
    ]);
  });

  it("length matches, the parent chain terminates at the goal target, and has no cycles", () => {
    const { steps, trace } = planned(planStepsTraced(goal, "bear", dining()));
    expectWellFormed(steps, trace, target);
    // The chain the creature would SPEAK, from the step it is on right now.
    expect(chainOf(trace, 0)).toEqual([NEAR_APPLE, HOLD_APPLE, target]);
  });

  it("eat-where-it-lies (no dining station): both steps serve the consume itself", () => {
    // No `at` preference ⇒ the consume arm emits its own approach leg; there is
    // no separate predicate for it, and inventing one would be a lie (header).
    const plain: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    const plainTarget: Predicate = { kind: "consumed", item: "apple1" };
    const { steps, trace } = planned(planStepsTraced(plain, "bear", resolver()));
    expect(steps).toEqual([{ kind: "moveTo", pos: { x: 10, y: 0 } }, { kind: "eat", itemId: "apple1" }]);
    expect(trace).toEqual([{ serves: plainTarget }, { serves: plainTarget }]);
    expectWellFormed(steps, trace, plainTarget);
  });
});

describe("fetch / give / putIn from the three states the planner suite pins", () => {
  const cases: { name: string; goal: GoalSpec; target: Predicate }[] = [
    { name: "fetch", goal: { kind: "fetch", item: { id: "apple1" } }, target: HOLD_APPLE },
    {
      name: "give",
      goal: { kind: "give", item: { id: "apple1" }, to: "mara" },
      target: { kind: "possessed", item: "apple1", by: "mara" },
    },
    {
      name: "putIn",
      goal: { kind: "putIn", item: { id: "apple1" }, container: { kind: "named", id: "box" } },
      target: { kind: "in", item: "apple1", container: { kind: "named", id: "box" } },
    },
  ];

  for (const { name, goal, target } of cases) {
    it(`${name} — loose: trace length equals step length, chain ends at the goal`, () => {
      const { steps, trace } = planned(planStepsTraced(goal, "bear", resolver()));
      expect(steps).toEqual(planSteps(goal, "bear", resolver()));
      expectWellFormed(steps, trace, target);
      expect(trace[0]).toEqual({ serves: NEAR_APPLE, parent: HOLD_APPLE });
    });

    it(`${name} — already in hand: the pruned precondition drops BOTH its step and its edge`, () => {
      const { steps, trace } = planned(planStepsTraced(goal, "bear", resolver("bear")));
      expect(steps).toEqual(planSteps(goal, "bear", resolver("bear")));
      expect(trace.length).toBe(steps.length);
      // The walk-to-the-apple and the pick are gone; so are their two edges.
      expect(trace.some((e) => e.serves.kind === "near")).toBe(false);
      expect(trace.some((e) => e.serves.kind === "holding")).toBe(false);
      if (steps.length) expectWellFormed(steps, trace, target);
    });

    it(`${name} — held by ANOTHER creature: no plan, and therefore no trace`, () => {
      // ⚖️ D7 PIN MOVE — the traced entry no longer answers a bare `null`: it
      // NAMES the predicate that failed. `holding` is the deepest arm that
      // returned null in all three cases (the give and the putIn regress it
      // first), so the reason survives the branch roll-back that used to eat it.
      // The trace itself is still empty and `planSteps` is untouched.
      expect(planStepsTraced(goal, "bear", resolver("mara"))).toEqual({
        steps: null,
        blockedAt: HOLD_APPLE,
      });
      expect(planTrace(goal, "bear", resolver("mara"))).toBeNull();
      expect(planSteps(goal, "bear", resolver("mara"))).toBeNull();
    });
  }

  it("fetch already in hand is an EMPTY plan and an empty trace", () => {
    const { steps, trace } = planned(planStepsTraced({ kind: "fetch", item: { id: "apple1" } }, "bear", resolver("bear")));
    expect(steps).toEqual([]);
    expect(trace).toEqual([]);
  });

  it("a FAILED branch leaves no edges behind (the roll-back to the mark)", () => {
    // `possessed` regresses `holding` FIRST (which succeeds and records two
    // edges), then fails on the recipient's position. The null plan must not
    // leak the sub-plan's edges.
    const noMara: WorldResolver = { ...resolver(), positionOf: (id) => (id === "bear" ? { x: 0, y: 0 } : null) };
    const goal: GoalSpec = { kind: "give", item: { id: "apple1" }, to: "mara" };
    expect(planSteps(goal, "bear", noMara)).toBeNull();
    // ⚖️ D7 PIN MOVE — the edges are still rolled back (that is the pin's own
    // subject), and the REASON is now kept beside them: the `holding` sub-plan
    // SUCCEEDED here, so the deepest arm that actually failed is `possessed`
    // itself (there is no Mara to give it to), not the pickup.
    expect(planStepsTraced(goal, "bear", noMara)).toEqual({
      steps: null,
      blockedAt: { kind: "possessed", item: "apple1", by: "mara" },
    });
    // …and the collector is not shared across calls: the next plan is clean.
    expect(planTrace({ kind: "fetch", item: { id: "apple1" } }, "bear", noMara)).toEqual([
      { serves: NEAR_APPLE, parent: HOLD_APPLE },
      { serves: HOLD_APPLE },
    ]);
  });

  it("take-from: a hand-to-hand pickup is two steps of ONE predicate (no near rung)", () => {
    const goal: GoalSpec = { kind: "fetch", item: { id: "apple1" }, from: { kind: "creature", id: "mara" } };
    const target: Predicate = { kind: "holding", item: "apple1", takeFrom: "mara" };
    const { steps, trace } = planned(planStepsTraced(goal, "bear", resolver("mara")));
    expect(steps).toEqual([
      { kind: "moveTo", pos: { x: 6, y: 0 } },
      { kind: "pick", itemId: "apple1", from: "mara" },
    ]);
    expect(trace).toEqual([{ serves: target }, { serves: target }]);
    expectWellFormed(steps, trace, target);
  });
});

describe("the rest of the operator vocabulary traces the predicate its arm owns", () => {
  const cases: { name: string; goal: GoalSpec; r: WorldResolver; last: Predicate }[] = [
    {
      name: "transform → facet",
      goal: { kind: "transform", item: { id: "apple1" }, state: "hot" },
      r: resolver(),
      last: { kind: "facet", item: "apple1", state: "hot" },
    },
    {
      name: "toggle → toggled",
      goal: { kind: "toggle", device: { id: "apple1" }, state: "on" },
      r: resolver(),
      last: { kind: "toggled", item: "apple1", state: "on" },
    },
    {
      name: "wear → worn",
      goal: { kind: "wear", item: { id: "apple1" } },
      r: resolver(),
      last: { kind: "worn", item: "apple1" },
    },
    {
      name: "color → colored",
      goal: { kind: "color", item: { id: "apple1" }, color: "red" },
      r: resolver(),
      last: { kind: "colored", item: "apple1", color: "red" },
    },
    {
      name: "rest → rested",
      goal: { kind: "rest", place: { kind: "named", id: "bed" } },
      r: resolver(),
      last: { kind: "rested", place: { kind: "named", id: "bed" } },
    },
    {
      name: "setOpen → openState",
      goal: { kind: "setOpen", place: { kind: "named", id: "box" }, open: true },
      r: resolver(),
      last: { kind: "openState", place: { kind: "named", id: "box" }, open: true },
    },
    {
      name: "converse → socialized",
      goal: { kind: "converse", target: "mara" },
      r: resolver(),
      last: { kind: "socialized", partner: "mara" },
    },
    {
      name: "goTo → at",
      goal: { kind: "goTo", place: { kind: "named", id: "box" } },
      r: resolver(),
      last: { kind: "at", place: { kind: "named", id: "box" } },
    },
    {
      name: "takeUnits → unitsTaken",
      goal: { kind: "takeUnits", from: { kind: "named", id: "market" }, category: "food", units: 2 },
      r: resolver(),
      last: { kind: "unitsTaken", from: { kind: "named", id: "market" }, category: "food", units: 2 },
    },
    {
      name: "consumeUnits → stackConsumed",
      goal: { kind: "consumeUnits", category: "food", at: ["table"] },
      r: dining(),
      last: { kind: "stackConsumed", category: "food", at: ["table"] },
    },
  ];

  for (const { name, goal, r, last } of cases) {
    it(`${name}: steps unchanged, trace aligned, terminal edge is the goal target`, () => {
      const { steps, trace } = planned(planStepsTraced(goal, "bear", r));
      expect(steps).toEqual(planSteps(goal, "bear", r));
      expectWellFormed(steps, trace, last);
      expect(trace[trace.length - 1]).toEqual({ serves: last });
    });
  }

  it("address emits ONE step with ONE edge — no walk leg to explain", () => {
    const target: Predicate = { kind: "addressed", target: "mara" };
    const got = achieveTraced(target, "bear", resolver())!;
    expect(got.steps).toEqual([{ kind: "address", target: "mara" }]);
    expect(got.trace).toEqual([{ serves: target }]);
  });
});

describe("pursueTraced — the current step's WHY, three ticks (far → arrived → done)", () => {
  function drive() {
    let bear = { x: 0, y: 0 };
    let carrier: string | null = null;
    const r: WorldResolver = {
      ...resolver(),
      positionOf: (id) => (id === "bear" ? bear : id === "mara" ? { x: 6, y: 0 } : null),
      carrierOf: () => carrier,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    const goal: GoalSpec = { kind: "fetch", item: { id: "apple1" } };
    return {
      tick: () => pursueTraced(goal, "bear", r),
      plain: () => pursue(goal, "bear", r),
      walkTo: (x: number, y: number) => (bear = { x, y }),
      grab: () => (carrier = "bear"),
    };
  }

  it("far ⇒ move, serving `near` in order to `holding`", () => {
    const w = drive();
    expect(w.tick()).toEqual({ kind: "move", pos: { x: 10, y: 0 }, serves: NEAR_APPLE, parent: HOLD_APPLE });
    expect(w.plain()).toEqual({ kind: "move", pos: { x: 10, y: 0 } }); // untraced shape untouched
  });

  it("arrived ⇒ act(last), serving `holding` — the goal target, so no parent", () => {
    const w = drive();
    w.walkTo(9.5, 0);
    expect(w.tick()).toEqual({
      kind: "act",
      step: { kind: "pick", itemId: "apple1" },
      last: true,
      serves: HOLD_APPLE,
    });
    expect(w.plain()).toEqual({ kind: "act", step: { kind: "pick", itemId: "apple1" }, last: true });
  });

  it("done ⇒ no step, therefore no `serves`/`parent` to report", () => {
    const w = drive();
    w.walkTo(9.5, 0);
    w.grab();
    expect(w.tick()).toEqual({ kind: "done" });
    expect(Object.keys(w.tick())).toEqual(["kind"]);
  });

  it("blocked ⇒ no `serves`/`parent` either", () => {
    const gone: WorldResolver = { ...resolver(), resolveItem: () => null };
    const step = pursueTraced({ kind: "fetch", item: { id: "apple1" } }, "bear", gone);
    expect(step).toEqual({ kind: "blocked" });
    expect(Object.keys(step)).toEqual(["kind"]);
  });
});

describe("the untraced `pursue` is BYTE-IDENTICAL to before (frozen copy, 5 goals)", () => {
  // Hand-written from the behavior that shipped before the trace landed. If the
  // collector ever leaked into the plan, one of these five moves.
  const frozen: { name: string; goal: GoalSpec; r: () => WorldResolver; want: unknown }[] = [
    {
      name: "fetch (loose, far)",
      goal: { kind: "fetch", item: { id: "apple1" } },
      r: () => resolver(),
      want: { kind: "move", pos: { x: 10, y: 0 } },
    },
    {
      name: "give (already in hand)",
      goal: { kind: "give", item: { id: "apple1" }, to: "mara" },
      r: () => resolver("bear"),
      want: { kind: "move", pos: { x: 6, y: 0 } },
    },
    {
      name: "putIn (loose, far)",
      goal: { kind: "putIn", item: { id: "apple1" }, container: { kind: "named", id: "box" } },
      r: () => resolver(),
      want: { kind: "move", pos: { x: 10, y: 0 } },
    },
    {
      name: "consume (already in hand)",
      goal: { kind: "consume", item: { id: "apple1" } },
      r: () => resolver("bear"),
      want: { kind: "act", step: { kind: "eat", itemId: "apple1" }, last: true },
    },
    {
      name: "transform (loose, far)",
      goal: { kind: "transform", item: { id: "apple1" }, state: "hot" },
      r: () => resolver(),
      want: { kind: "move", pos: { x: 10, y: 0 } },
    },
  ];

  for (const { name, goal, r, want } of frozen) {
    it(`${name} — pursue is unchanged and carries NO trace fields`, () => {
      const got = pursue(goal, "bear", r());
      expect(got).toEqual(want);
      expect("serves" in got).toBe(false);
      expect("parent" in got).toBe(false);
    });

    it(`${name} — pursueTraced makes the same decision, only annotated`, () => {
      const traced = pursueTraced(goal, "bear", r()) as Record<string, unknown>;
      const { serves: _s, parent: _p, ...bare } = traced;
      expect(bare).toEqual(want);
    });
  }
});

describe("determinism — the trace is as reproducible as the steps", () => {
  const goals: GoalSpec[] = [
    { kind: "consume", item: { id: "apple1" }, at: ["table"] },
    { kind: "give", item: { id: "apple1" }, to: "mara" },
    { kind: "putIn", item: { id: "apple1" }, container: { kind: "named", id: "box" } },
    { kind: "transform", item: { id: "apple1" }, state: "hot" },
    { kind: "color", item: { id: "apple1" }, color: "red" },
  ];

  it("same inputs twice ⇒ deep-equal traces (and deep-equal steps)", () => {
    for (const goal of goals) {
      const a = planStepsTraced(goal, "bear", dining());
      const b = planStepsTraced(goal, "bear", dining());
      expect(b).toEqual(a);
      expect(planTrace(goal, "bear", dining())).toEqual(a!.trace);
    }
  });

  it("a second call on the SAME resolver instance repeats itself exactly", () => {
    const r = dining();
    for (const goal of goals) {
      const a = planStepsTraced(goal, "bear", r);
      const b = planStepsTraced(goal, "bear", r);
      expect(b).toEqual(a);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEMA AS DATA (emergent-plans-round.md D3) — the table is a MIRROR of
// the switch, and this is the mirror's own guarantee: the graph is acyclic and
// 3 rows deep by MEASUREMENT, and every causal edge the regression ACTUALLY
// emits over this suite's fixtures is a row of the table. Drift is a failure
// here rather than a lie in the `why` chain.
// ═══════════════════════════════════════════════════════════════════════════

describe("OPERATOR_GRAPH mirrors the switch — validated, and checked against the traces", () => {
  it("is acyclic with a longest chain of 3 rows (`in → holding → near`)", () => {
    const r = validateOperators(OPERATOR_GRAPH);
    expect(r.acyclic).toBe(true);
    expect(r.longestPath).toBe(3);
    expect(r.unreachable).toEqual([]);
  });

  it("every observed `parent → serves` pair over the suite's fixtures IS a schema edge", () => {
    // Every goal/resolver pair this file plans, in one list. A regression that
    // grows a new precondition edge without a row lands here first.
    const fixtures: { goal: GoalSpec; r: WorldResolver }[] = [
      { goal: { kind: "consume", item: { id: "apple1" }, at: ["table"] }, r: dining() },
      { goal: { kind: "consume", item: { id: "apple1" } }, r: resolver() },
      { goal: { kind: "consume", item: { id: "apple1" }, at: ["table"] }, r: dining("bear") },
      { goal: { kind: "fetch", item: { id: "apple1" } }, r: resolver() },
      { goal: { kind: "fetch", item: { id: "apple1" } }, r: resolver("bear") },
      { goal: { kind: "fetch", item: { id: "apple1" }, from: { kind: "creature", id: "mara" } }, r: resolver("mara") },
      { goal: { kind: "give", item: { id: "apple1" }, to: "mara" }, r: resolver() },
      { goal: { kind: "give", item: { id: "apple1" }, to: "mara" }, r: resolver("bear") },
      { goal: { kind: "putIn", item: { id: "apple1" }, container: { kind: "named", id: "box" } }, r: resolver() },
      { goal: { kind: "putIn", item: { id: "apple1" }, container: { kind: "named", id: "box" } }, r: resolver("bear") },
      { goal: { kind: "transform", item: { id: "apple1" }, state: "hot" }, r: resolver() },
      { goal: { kind: "toggle", device: { id: "apple1" }, state: "on" }, r: resolver() },
      { goal: { kind: "wear", item: { id: "apple1" } }, r: resolver() },
      { goal: { kind: "color", item: { id: "apple1" }, color: "red" }, r: resolver() },
      { goal: { kind: "rest", place: { kind: "named", id: "bed" } }, r: resolver() },
      { goal: { kind: "setOpen", place: { kind: "named", id: "box" }, open: true }, r: resolver() },
      { goal: { kind: "converse", target: "mara" }, r: resolver() },
      { goal: { kind: "goTo", place: { kind: "named", id: "box" } }, r: resolver() },
      { goal: { kind: "takeUnits", from: { kind: "named", id: "market" }, category: "food", units: 2 }, r: resolver() },
      { goal: { kind: "putUnits", into: { kind: "named", id: "box" }, category: "food", units: 1 }, r: resolver() },
      { goal: { kind: "processUnits", at: { kind: "named", id: "oven" }, category: "food", add: "hot" }, r: resolver() },
      { goal: { kind: "equipUnits", category: "cloth" }, r: resolver() },
      { goal: { kind: "dropUnits", category: "food", units: 1 }, r: resolver() },
      { goal: { kind: "consumeUnits", category: "food", at: ["table"] }, r: dining() },
    ];

    const observed = new Set<string>();
    const served = new Set<string>();
    for (const { goal, r } of fixtures) {
      const trace = planTrace(goal, "bear", r);
      if (!trace) continue;
      for (const e of trace) {
        served.add(e.serves.kind);
        if (e.parent !== undefined) observed.add(`${e.parent.kind}→${e.serves.kind}`);
      }
    }
    // The fixtures really do exercise the regression (a silently empty set
    // would make this test pass by saying nothing).
    expect(observed.size).toBeGreaterThan(0);

    const edges = new Set(
      OPERATOR_GRAPH.flatMap((op) => op.needs.map((need) => `${op.achieves}→${need}`)),
    );
    for (const pair of [...observed].sort()) expect([...edges]).toContain(pair);
    // …and the headline chain is one of them, both rungs.
    expect(observed.has("holding→near")).toBe(true);
    expect(observed.has("consumed→holding")).toBe(true);
    // Every predicate any step served has a row of its own.
    const achieved = new Set(OPERATOR_GRAPH.map((op) => op.achieves));
    for (const kind of [...served].sort()) expect([...achieved]).toContain(kind);
  });
});

describe("blockedAt names the DEEPEST failed arm (D7 — preconditions are the response)", () => {
  it("an unlocatable item blocks at `near`, not at the `holding` above it", () => {
    const nowhere: WorldResolver = { ...resolver(), itemPosition: () => null };
    expect(planStepsTraced({ kind: "fetch", item: { id: "apple1" } }, "bear", nowhere)).toEqual({
      steps: null,
      blockedAt: NEAR_APPLE,
    });
  });

  it("a station that grants no such state blocks at `facet` — the arm that asked for it", () => {
    const noStation: WorldResolver = { ...resolver(), stationFor: () => null };
    expect(
      planStepsTraced({ kind: "transform", item: { id: "apple1" }, state: "hot" }, "bear", noStation),
    ).toEqual({ steps: null, blockedAt: { kind: "facet", item: "apple1", state: "hot" } });
  });

  it("a goal that is not an item errand names NOTHING — there is no predicate to name", () => {
    const gone: WorldResolver = { ...resolver(), resolveItem: () => null };
    expect(planStepsTraced({ kind: "fetch", item: { id: "apple1" } }, "bear", gone)).toEqual({ steps: null });
    expect(pursueTraced({ kind: "fetch", item: { id: "apple1" } }, "bear", gone)).toEqual({ kind: "blocked" });
  });

  it("`pursueTraced` carries it onto `blocked`, and `pursue` still answers the bare shape", () => {
    const r = resolver("mara");
    const goal: GoalSpec = { kind: "fetch", item: { id: "apple1" } };
    expect(pursueTraced(goal, "bear", r)).toEqual({ kind: "blocked", blockedAt: HOLD_APPLE });
    expect(pursue(goal, "bear", r)).toEqual({ kind: "blocked" });
  });

  it("a DEAD SUB-BRANCH inside a plan that SUCCEEDS records nothing", () => {
    // The dining leg regresses `holding` and, when that fails, falls through to
    // eating where it lies. The abandoned branch's failure must be discarded
    // exactly as its edges are — a successful plan has no `blockedAt`.
    const served = planStepsTraced({ kind: "consume", item: { id: "apple1" }, at: ["table"] }, "bear", dining());
    expect(served.steps).not.toBeNull();
    expect(served.blockedAt).toBeUndefined();
  });
});
