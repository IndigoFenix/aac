// The ACTION PLANNER (action-planner.ts): a goal → its target predicate →
// regressed body steps. The migration's safety proof — the planner must emit
// the IDENTICAL GoalStep[] as the hand-wired compileGoal for the errands that
// stay hand-wired, so routing new goals (consume) through it can't regress the
// old ones when they're migrated. Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { compileGoal, type WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import { planGoal, achieve, pursue } from "@shared/world-engine/interaction/behavior/action-planner.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// A tiny world: bear at origin, an apple loose at (10,0), a box place at (4,0),
// mara (recipient) at (6,0). `carrier` lets a test say the actor already holds
// the apple (skip the pickup leg).
function resolver(carrier: string | null = null): WorldResolver {
  const items: Record<string, { x: number; y: number }> = { apple1: { x: 10, y: 0 } };
  const creatures: Record<string, { x: number; y: number }> = { bear: { x: 0, y: 0 }, mara: { x: 6, y: 0 } };
  return {
    positionOf: (id) => creatures[id] ?? null,
    homeOf: () => ({ x: -5, y: 0 }),
    place: (p) =>
      p.kind === "named" ? { x: 4, y: 0 } : p.kind === "creature" ? (creatures[p.id] ?? null) : p.kind === "point" ? { x: p.x, y: p.y } : null,
    resolveItem: (ref) => ("id" in ref ? ref.id : "apple1"),
    itemPosition: (id) => items[id] ?? null,
    stationFor: () => ({ x: 2, y: 0 }),
    carrierOf: (id) => (id === "apple1" ? carrier : null),
  };
}

describe("planner ≡ compileGoal — the errands that stay hand-wired reproduce exactly", () => {
  const cases: [string, GoalSpec][] = [
    ["give (loose item)", { kind: "give", item: { id: "apple1" }, to: "mara" }],
    ["putIn (loose item)", { kind: "putIn", item: { id: "apple1" }, container: { kind: "named", id: "box" } }],
  ];
  for (const [name, goal] of cases) {
    it(`${name} — loose`, () => {
      expect(planGoal(goal, "bear", resolver())).toEqual(compileGoal(goal, "bear", resolver()));
    });
    it(`${name} — already in hand (pickup leg skipped identically)`, () => {
      expect(planGoal(goal, "bear", resolver("bear"))).toEqual(compileGoal(goal, "bear", resolver("bear")));
    });
    it(`${name} — held by ANOTHER creature is unreachable for both`, () => {
      expect(planGoal(goal, "bear", resolver("mara"))).toEqual(compileGoal(goal, "bear", resolver("mara")));
    });
  }

  it("fetch — loose item reproduces [moveTo, pick]", () => {
    const goal: GoalSpec = { kind: "fetch", item: { id: "apple1" } };
    expect(planGoal(goal, "bear", resolver())).toEqual(compileGoal(goal, "bear", resolver()));
  });

  it("fetch — already-held UNIFIES to an empty plan (the planner's cleaner reading)", () => {
    // compileGoal re-walks+re-picks a thing already in hand; the planner sees
    // `holding` already satisfied and emits nothing. The intended improvement.
    const goal: GoalSpec = { kind: "fetch", item: { id: "apple1" } };
    expect(planGoal(goal, "bear", resolver("bear"))).toEqual({ steps: [] });
  });
});

describe("consume — the first goal the planner OWNS", () => {
  it("eats a loose item: walk to it, then the eat step", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 10, y: 0 } }, { kind: "eat", itemId: "apple1" }],
    });
  });

  it("eats straight from the hand (no walk) when already carried", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    expect(planGoal(goal, "bear", resolver("bear"))).toEqual({ steps: [{ kind: "eat", itemId: "apple1" }] });
  });

  it("can't eat what another creature holds", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    expect(planGoal(goal, "bear", resolver("mara"))).toBeNull();
  });

  it("compileGoal routes consume through the planner (same result)", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    expect(compileGoal(goal, "bear", resolver())).toEqual(planGoal(goal, "bear", resolver()));
  });
});

describe("transform — cook/cool regresses through holding → station (S0)", () => {
  it("loose item: walk to it, pick it up, carry it to the station, then transform", () => {
    // The whole chain — the fix for "the apple transforms across the room". The
    // body must HOLD the thing and stand at the station granting the state.
    const goal: GoalSpec = { kind: "transform", item: { id: "apple1" }, state: "hot" };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 10, y: 0 } }, // to the apple
        { kind: "pick", itemId: "apple1" }, // hold it
        { kind: "moveTo", pos: { x: 2, y: 0 } }, // to the station
        { kind: "transform", itemId: "apple1", state: "hot" },
      ],
    });
  });

  it("already in hand: the pickup leg drops, just walk to the station and work it", () => {
    const goal: GoalSpec = { kind: "transform", item: { id: "apple1" }, state: "hot" };
    expect(planGoal(goal, "bear", resolver("bear"))).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 2, y: 0 } }, { kind: "transform", itemId: "apple1", state: "hot" }],
    });
  });

  it("held by ANOTHER creature is unreachable — can't snatch it to cook", () => {
    const goal: GoalSpec = { kind: "transform", item: { id: "apple1" }, state: "hot" };
    expect(planGoal(goal, "bear", resolver("mara"))).toBeNull();
  });

  it("no station grants the state → blocked (null), never a partial plan", () => {
    const goal: GoalSpec = { kind: "transform", item: { id: "apple1" }, state: "clean" };
    const noStation: WorldResolver = { ...resolver(), stationFor: () => null };
    expect(planGoal(goal, "bear", noStation)).toBeNull();
  });

  it("compileGoal routes transform through the planner (identical result)", () => {
    const goal: GoalSpec = { kind: "transform", item: { id: "apple1" }, state: "hot" };
    expect(compileGoal(goal, "bear", resolver())).toEqual(planGoal(goal, "bear", resolver()));
  });

  it("pursue drives move → pick → move → transform as the world updates each tick", () => {
    let bear = { x: 0, y: 0 };
    let holder: string | null = null;
    const r: WorldResolver = {
      positionOf: (id) => (id === "bear" ? bear : null),
      homeOf: () => null,
      place: () => null,
      resolveItem: () => "apple1",
      itemPosition: () => ({ x: 10, y: 0 }),
      stationFor: () => ({ x: 2, y: 0 }),
      carrierOf: () => holder,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    const goal: GoalSpec = { kind: "transform", item: { id: "apple1" }, state: "hot" };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 10, y: 0 } }); // to the apple
    bear = { x: 10, y: 0 };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "act", step: { kind: "pick", itemId: "apple1" }, last: false });
    holder = "bear"; // the host applied the pick
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 2, y: 0 } }); // carry it to the station
    bear = { x: 2, y: 0 };
    expect(pursue(goal, "bear", r)).toEqual({
      kind: "act",
      step: { kind: "transform", itemId: "apple1", state: "hot" },
      last: true, // the transform completes the goal — the pursuit clears (no false re-plan)
    });
  });
});

describe("rest — go to a station and dwell there (S0)", () => {
  const goal: GoalSpec = { kind: "rest", place: { kind: "named", id: "bed" } };

  it("walks to the station, then the dwell step", () => {
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 4, y: 0 } }, { kind: "rest", place: { kind: "named", id: "bed" } }],
    });
  });

  it("no such station (unresolvable place) → blocked (null), never a partial plan", () => {
    const noPlace: WorldResolver = { ...resolver(), place: () => null };
    expect(planGoal(goal, "bear", noPlace)).toBeNull();
  });

  it("compileGoal routes rest through the planner (identical result)", () => {
    expect(compileGoal(goal, "bear", resolver())).toEqual(planGoal(goal, "bear", resolver()));
  });

  it("pursue drives move → dwell, the dwell being the terminal (last) step", () => {
    let bear = { x: 0, y: 0 };
    const r: WorldResolver = {
      positionOf: (id) => (id === "bear" ? bear : null),
      homeOf: () => null,
      place: () => ({ x: 4, y: 0 }),
      resolveItem: () => null,
      itemPosition: () => null,
      stationFor: () => null,
      carrierOf: () => null,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 4, y: 0 } });
    bear = { x: 4, y: 0 };
    expect(pursue(goal, "bear", r)).toEqual({
      kind: "act",
      step: { kind: "rest", place: { kind: "named", id: "bed" } },
      last: true, // the dwell completes the goal — the pursuit clears (no false re-plan)
    });
  });
});

describe("setOpen — open/shut a container lid (S0, task 22)", () => {
  const openGoal: GoalSpec = { kind: "setOpen", place: { kind: "named", id: "chest" }, open: true };
  const shutGoal: GoalSpec = { kind: "setOpen", place: { kind: "named", id: "chest" }, open: false };

  it("open: walk to the container, then the open step", () => {
    expect(planGoal(openGoal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "openClose", place: { kind: "named", id: "chest" }, open: true },
      ],
    });
  });

  it("shut: walk to it, then the close step", () => {
    expect(planGoal(shutGoal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "openClose", place: { kind: "named", id: "chest" }, open: false },
      ],
    });
  });

  it("a graspless body CAN'T open → blocked (null — the honest 'I can't open it')", () => {
    const graspless: WorldResolver = { ...resolver(), canOpen: () => false };
    expect(planGoal(openGoal, "bear", graspless)).toBeNull();
  });

  it("but a graspless body CAN shut (closing needs no hands)", () => {
    const graspless: WorldResolver = { ...resolver(), canOpen: () => false };
    expect(planGoal(shutGoal, "bear", graspless)).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "openClose", place: { kind: "named", id: "chest" }, open: false },
      ],
    });
  });

  it("no such container (unresolvable place) → blocked (null), never a partial plan", () => {
    const noPlace: WorldResolver = { ...resolver(), place: () => null };
    expect(planGoal(openGoal, "bear", noPlace)).toBeNull();
  });

  it("compileGoal routes setOpen through the planner (identical result)", () => {
    expect(compileGoal(openGoal, "bear", resolver())).toEqual(planGoal(openGoal, "bear", resolver()));
  });

  it("pursue drives move → open, the open being the terminal (last) step", () => {
    let bear = { x: 0, y: 0 };
    const r: WorldResolver = {
      positionOf: (id) => (id === "bear" ? bear : null),
      homeOf: () => null,
      place: () => ({ x: 4, y: 0 }),
      resolveItem: () => null,
      itemPosition: () => null,
      stationFor: () => null,
      carrierOf: () => null,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    expect(pursue(openGoal, "bear", r)).toEqual({ kind: "move", pos: { x: 4, y: 0 } });
    bear = { x: 4, y: 0 };
    expect(pursue(openGoal, "bear", r)).toEqual({
      kind: "act",
      step: { kind: "openClose", place: { kind: "named", id: "chest" }, open: true },
      last: true,
    });
  });
});

describe("wear — pick up a garment and put it on (S0)", () => {
  // apple1 stands in for a garment here — the planner doesn't check clothing-ness
  // (the intent gate does); it just regresses acquire → equip.
  const goal: GoalSpec = { kind: "wear", item: { id: "apple1" } };

  it("loose garment: walk to it, pick it up, then equip", () => {
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 10, y: 0 } },
        { kind: "pick", itemId: "apple1" },
        { kind: "equip", itemId: "apple1" },
      ],
    });
  });

  it("already in hand: the pickup leg drops, just equip", () => {
    expect(planGoal(goal, "bear", resolver("bear"))).toEqual({ steps: [{ kind: "equip", itemId: "apple1" }] });
  });

  it("held by ANOTHER creature is unreachable — can't take it to wear", () => {
    expect(planGoal(goal, "bear", resolver("mara"))).toBeNull();
  });

  it("compileGoal routes wear through the planner (identical result)", () => {
    expect(compileGoal(goal, "bear", resolver())).toEqual(planGoal(goal, "bear", resolver()));
  });

  it("pursue drives move → pick → equip, the equip being the terminal (last) step", () => {
    let bear = { x: 0, y: 0 };
    let holder: string | null = null;
    const r: WorldResolver = {
      positionOf: (id) => (id === "bear" ? bear : null),
      homeOf: () => null,
      place: () => null,
      resolveItem: () => "apple1",
      itemPosition: () => ({ x: 10, y: 0 }),
      stationFor: () => null,
      carrierOf: () => holder,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 10, y: 0 } });
    bear = { x: 10, y: 0 };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "act", step: { kind: "pick", itemId: "apple1" }, last: false });
    holder = "bear"; // the host applied the pick
    expect(pursue(goal, "bear", r)).toEqual({ kind: "act", step: { kind: "equip", itemId: "apple1" }, last: true });
  });
});

describe("converse — walk to a partner and exchange (S0)", () => {
  const goal: GoalSpec = { kind: "converse", target: "mara" };

  it("walks to the partner, then the exchange step", () => {
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 6, y: 0 } }, { kind: "converse", target: "mara" }],
    });
  });

  it("partner gone (unresolvable position) → blocked (null), never a partial plan", () => {
    const noPartner: WorldResolver = { ...resolver(), positionOf: () => null };
    expect(planGoal(goal, "bear", noPartner)).toBeNull();
  });

  it("compileGoal routes converse through the planner (identical result)", () => {
    expect(compileGoal(goal, "bear", resolver())).toEqual(planGoal(goal, "bear", resolver()));
  });

  it("pursue drives move → exchange (last); a partner that DRIFTS is re-approached", () => {
    let bear = { x: 0, y: 0 };
    let mara = { x: 6, y: 0 };
    const r: WorldResolver = {
      positionOf: (id) => (id === "bear" ? bear : id === "mara" ? mara : null),
      homeOf: () => null,
      place: () => null,
      resolveItem: () => null,
      itemPosition: () => null,
      stationFor: () => null,
      carrierOf: () => null,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 6, y: 0 } });
    mara = { x: 8, y: 0 }; // partner drifts before we arrive — re-plan chases it
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 8, y: 0 } });
    bear = { x: 8, y: 0 };
    expect(pursue(goal, "bear", r)).toEqual({
      kind: "act",
      step: { kind: "converse", target: "mara" },
      last: true,
    });
  });
});

describe("achieve — the precondition graph is acyclic and terminates", () => {
  it("`in` regresses through holding → near (depth 3), minimal steps", () => {
    const steps = achieve({ kind: "in", item: "apple1", container: { kind: "named", id: "box" } }, "bear", resolver());
    expect(steps).toEqual([
      { kind: "moveTo", pos: { x: 10, y: 0 } }, // near the apple
      { kind: "pick", itemId: "apple1" }, // hold it
      { kind: "moveTo", pos: { x: 4, y: 0 } }, // to the box
      { kind: "place", itemId: "apple1", place: { kind: "named", id: "box" } },
    ]);
  });

  it("an unresolvable position yields null, never a partial/looping plan", () => {
    const r: WorldResolver = { ...resolver(), itemPosition: () => null };
    expect(achieve({ kind: "holding", item: "apple1" }, "bear", r)).toBeNull();
  });
});

describe("arrival-aware planning — the seam that makes a plan a per-tick pursuit", () => {
  // A resolver whose `arrived` says the actor is standing ON the apple, so the
  // walk-leg drops and only the action remains.
  const atApple = (): WorldResolver => ({ ...resolver(), arrived: (_s, p) => p.x === 10 && p.y === 0 });

  it("drops the walk-leg the body has already reached (consume → just eat)", () => {
    expect(planGoal({ kind: "consume", item: { id: "apple1" } }, "bear", atApple())).toEqual({
      steps: [{ kind: "eat", itemId: "apple1" }],
    });
  });

  it("without `arrived`, the same plan keeps its walk-leg (static-bake parity)", () => {
    expect(planGoal({ kind: "consume", item: { id: "apple1" } }, "bear", resolver())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 10, y: 0 } }, { kind: "eat", itemId: "apple1" }],
    });
  });
});

describe("pursue — re-run each tick: move → act → done, resume/adapt/abandon", () => {
  // A mutable world the pursuit drives against: the bear walks, then eats.
  function driveConsume() {
    let bear = { x: 0, y: 0 };
    let appleGone = false;
    const r: WorldResolver = {
      positionOf: (id) => (id === "bear" ? bear : null),
      homeOf: () => null,
      place: () => null,
      resolveItem: () => (appleGone ? null : "apple1"),
      itemPosition: () => (appleGone ? null : { x: 10, y: 0 }),
      stationFor: () => null,
      carrierOf: () => null,
      arrived: (_s, p) => Math.hypot(bear.x - p.x, bear.y - p.y) <= 1.3,
    };
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    return {
      tick: () => pursue(goal, "bear", r),
      walkTo: (x: number, y: number) => (bear = { x, y }),
      eat: () => (appleGone = true),
    };
  }

  it("far → move; arrived → act(last); consumed → done, never a false block", () => {
    const w = driveConsume();
    expect(w.tick()).toEqual({ kind: "move", pos: { x: 10, y: 0 } }); // still walking
    w.walkTo(9.5, 0); // within arrival range
    const step = w.tick();
    expect(step).toEqual({ kind: "act", step: { kind: "eat", itemId: "apple1" }, last: true });
    // The host applies the eat; the item is gone. `last` told it the goal is
    // DONE, so it must NOT re-plan (which would now read `blocked`).
    w.eat();
    expect(w.tick()).toEqual({ kind: "blocked" }); // proves why `last` matters
  });

  it("a goal already satisfied is immediately done (nothing to walk)", () => {
    const held: WorldResolver = { ...resolver(), carrierOf: () => "bear" };
    expect(pursue({ kind: "fetch", item: { id: "apple1" } }, "bear", held)).toEqual({ kind: "done" });
  });

  it("an unreachable goal is blocked, not silently idle", () => {
    const gone: WorldResolver = { ...resolver(), resolveItem: () => null };
    expect(pursue({ kind: "consume", item: { id: "apple1" } }, "bear", gone)).toEqual({ kind: "blocked" });
  });
});

describe("consume with a DINING preference (`at`) — the need templates' satisfy.at rides the pursuit (S2)", () => {
  // The resolver's dining table sits at (3,0); the apple is loose at (10,0).
  const dining = (carrier: string | null = null): WorldResolver => ({
    ...resolver(carrier),
    diningSpot: (_self, kinds) => (kinds.includes("table") ? { x: 3, y: 0 } : null),
  });

  it("carries the item to the table: walk to it, pick it up, walk to the table, eat THERE", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    expect(planGoal(goal, "bear", dining())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 10, y: 0 } }, // to the apple
        { kind: "pick", itemId: "apple1" }, // hold it
        { kind: "moveTo", pos: { x: 3, y: 0 } }, // to the table
        { kind: "eat", itemId: "apple1" },
      ],
    });
  });

  it("already in hand: just walk to the table and eat", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    expect(planGoal(goal, "bear", dining("bear"))).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 3, y: 0 } }, { kind: "eat", itemId: "apple1" }],
    });
  });

  it("no such station nearby → falls through to eating where it lies (the templates' else-in-place)", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["bowl"] };
    expect(planGoal(goal, "bear", dining())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 10, y: 0 } }, { kind: "eat", itemId: "apple1" }],
    });
  });

  it("a resolver WITHOUT the dining hook behaves exactly as a bare consume (commands unchanged)", () => {
    const withAt: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    const bare: GoalSpec = { kind: "consume", item: { id: "apple1" } };
    expect(planGoal(withAt, "bear", resolver())).toEqual(planGoal(bare, "bear", resolver()));
  });

  it("held by ANOTHER creature stays unreachable, dining or not", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    expect(planGoal(goal, "bear", dining("mara"))).toBeNull();
  });

  // ── ALREADY SERVED — the food is ON the station it would be carried to ─────
  // The observed bug: a body told to eat something off the table planned a
  // PICKUP first, walked to the table, reached for a prop that mirrors a stack
  // unit and so offers no carry affordance at all, and looped there — while the
  // SAME food, once loose on the floor, was eaten without trouble.
  //
  // A resolver reports an item resting on a solid fixture at that fixture's own
  // approach point (both nudge off the same edge), so "already served" IS the
  // two positions coinciding. Nothing kind-specific: emergent from the geometry.
  const served = (carrier: string | null = null): WorldResolver => ({
    ...resolver(carrier),
    itemPosition: () => ({ x: 3, y: 0 }), // the meal sits ON the table
    diningSpot: (_self, kinds) => (kinds.includes("table") ? { x: 3, y: 0 } : null),
  });

  it("food already ON the table is eaten where it sits — no pickup leg at all", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    expect(planGoal(goal, "bear", served())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 3, y: 0 } }, { kind: "eat", itemId: "apple1" }],
    });
  });

  it("…and the plan NEVER contains a pick — that step is the one that could not complete", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    const steps = planGoal(goal, "bear", served())?.steps ?? [];
    expect(steps.some((s) => s.kind === "pick")).toBe(false);
  });

  it("standing AT the table already: the whole plan is the eat", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    const there: WorldResolver = { ...served(), arrived: (_s, p) => p.x === 3 && p.y === 0 };
    expect(planGoal(goal, "bear", there)).toEqual({ steps: [{ kind: "eat", itemId: "apple1" }] });
  });

  it("food a HAIR off the station is still carried (this is an equality test, not a reach)", () => {
    // 0.5 m away is a different place — the body picks it up and brings it over.
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    const nearby: WorldResolver = { ...served(), itemPosition: () => ({ x: 3.5, y: 0 }) };
    expect(planGoal(goal, "bear", nearby)).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 3.5, y: 0 } },
        { kind: "pick", itemId: "apple1" },
        { kind: "moveTo", pos: { x: 3, y: 0 } },
        { kind: "eat", itemId: "apple1" },
      ],
    });
  });

  it("something ALREADY IN HAND at the table still walks and eats (the carry case is untouched)", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    expect(planGoal(goal, "bear", served("bear"))).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 3, y: 0 } }, { kind: "eat", itemId: "apple1" }],
    });
  });

  it("a served meal ANOTHER creature holds is still refused", () => {
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    expect(planGoal(goal, "bear", served("mara"))).toBeNull();
  });

  it("the pursuit DRIVES the served meal to completion instead of looping", () => {
    // The failure mode was a pursuit that re-derived the same un-completable
    // pick every tick. Standing at the table, the next thing to do is the eat,
    // and it is the LAST step — so the pursuit ends rather than re-planning.
    const goal: GoalSpec = { kind: "consume", item: { id: "apple1" }, at: ["table"] };
    const there: WorldResolver = { ...served(), arrived: (_s, p) => p.x === 3 && p.y === 0 };
    expect(pursue(goal, "bear", there)).toEqual({
      kind: "act",
      step: { kind: "eat", itemId: "apple1" },
      last: true,
    });
  });
});

describe("rest with a dwell length (`dwellS`) — a need's nap vs the commanded-sit default (S2)", () => {
  it("carries the dwell through to the rest step", () => {
    const goal: GoalSpec = { kind: "rest", place: { kind: "named", id: "bed" }, dwellS: 42 };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 4, y: 0 } }, { kind: "rest", place: { kind: "named", id: "bed" }, dwellS: 42 }],
    });
  });

  it("absent dwell emits the bare step (the command default stays the executor's)", () => {
    const goal: GoalSpec = { kind: "rest", place: { kind: "named", id: "bed" } };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 4, y: 0 } }, { kind: "rest", place: { kind: "named", id: "bed" } }],
    });
  });
});

describe("takeUnits / putUnits — the stack economy's bounded micro-goals (S3)", () => {
  it("takeUnits: walk to the named store, then withdraw N into the bag", () => {
    const goal: GoalSpec = { kind: "takeUnits", from: { kind: "named", id: "chest1" }, category: "food", units: 4, tplKey: "provision:food" };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "withdraw", fromId: "chest1", goodKey: "food", units: 4, tplKey: "provision:food" },
      ],
    });
  });

  it("takeUnits by AFFORDANCE (fun's toy) carries the selector through", () => {
    const goal: GoalSpec = { kind: "takeUnits", from: { kind: "named", id: "toybox" }, category: "", units: 1, affords: "play", tplKey: "fun" };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "withdraw", fromId: "toybox", goodKey: "", units: 1, affords: "play", tplKey: "fun" },
      ],
    });
  });

  it("putUnits: walk to the container, then stow N out of the bag", () => {
    const goal: GoalSpec = { kind: "putUnits", into: { kind: "named", id: "chest1" }, category: "food", units: 3, tplKey: "provision:food" };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "stow", intoId: "chest1", goodKey: "food", units: 3, tplKey: "provision:food" },
      ],
    });
  });

  it("an unresolvable store blocks (null), never a partial plan", () => {
    const gone: WorldResolver = { ...resolver(), place: () => null };
    const goal: GoalSpec = { kind: "takeUnits", from: { kind: "named", id: "chest1" }, category: "food", units: 1 };
    expect(planGoal(goal, "bear", gone)).toBeNull();
  });

  it("a non-named store ref blocks — the walked id and the acted-on id must be ONE", () => {
    const goal: GoalSpec = { kind: "takeUnits", from: { kind: "point", x: 4, y: 0 }, category: "food", units: 1 };
    expect(planGoal(goal, "bear", resolver())).toBeNull();
  });

  it("compileGoal routes both through the planner (identical result)", () => {
    for (const goal of [
      { kind: "takeUnits", from: { kind: "named", id: "chest1" }, category: "food", units: 2 },
      { kind: "putUnits", into: { kind: "named", id: "chest1" }, category: "food", units: 2 },
    ] as GoalSpec[]) {
      expect(compileGoal(goal, "bear", resolver())).toEqual(planGoal(goal, "bear", resolver()));
    }
  });

  it("pursue drives the micro-goal: move while far, act(last) on arrival — terminal by design", () => {
    let bear = { x: 0, y: 0 };
    const r: WorldResolver = {
      ...resolver(),
      arrived: (_self, pos) => Math.hypot(bear.x - pos.x, bear.y - pos.y) <= 1.3,
    };
    const goal: GoalSpec = { kind: "takeUnits", from: { kind: "named", id: "chest1" }, category: "food", units: 2 };
    expect(pursue(goal, "bear", r)).toEqual({ kind: "move", pos: { x: 4, y: 0 } });
    bear = { x: 3.5, y: 0 };
    expect(pursue(goal, "bear", r)).toEqual({
      kind: "act",
      step: { kind: "withdraw", fromId: "chest1", goodKey: "food", units: 2 },
      last: true,
    });
  });
});

describe("processUnits / equipUnits / dropUnits — the dwelled transform and the in-place stack acts (S3 slice 2)", () => {
  it("processUnits: walk to the station, then the dwelled facet edit", () => {
    const goal: GoalSpec = { kind: "processUnits", at: { kind: "named", id: "bath1" }, category: "laundry", drop: "dirty", dwellS: 6, tplKey: "laundry" };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 4, y: 0 } },
        { kind: "processStack", atId: "bath1", goodKey: "laundry", drop: "dirty", dwellS: 6, tplKey: "laundry" },
      ],
    });
  });

  it("equipUnits / dropUnits are act-only plans — you dress and unload where you stand", () => {
    expect(planGoal({ kind: "equipUnits", category: "clothing", tplKey: "dress" }, "bear", resolver())).toEqual({
      steps: [{ kind: "equipStack", goodKey: "clothing", tplKey: "dress" }],
    });
    expect(planGoal({ kind: "dropUnits", category: "", units: 2, tplKey: "unload" }, "bear", resolver())).toEqual({
      steps: [{ kind: "dropStack", goodKey: "", units: 2, tplKey: "unload" }],
    });
  });

  it("pursue on an act-only plan acts immediately (last) — no phantom walk", () => {
    expect(pursue({ kind: "equipUnits", category: "clothing" }, "bear", resolver())).toEqual({
      kind: "act",
      step: { kind: "equipStack", goodKey: "clothing" },
      last: true,
    });
  });

  it("an unresolvable station blocks processUnits (null)", () => {
    const gone: WorldResolver = { ...resolver(), place: () => null };
    expect(planGoal({ kind: "processUnits", at: { kind: "named", id: "bath1" }, category: "laundry" }, "bear", gone)).toBeNull();
  });
});

describe("consumeUnits — eat from the bag (S4), and the rest pose override", () => {
  it("with a resolvable dining station: walk there, then consume from the bag", () => {
    const dining: WorldResolver = { ...resolver(), diningSpot: () => ({ x: 3, y: 0 }) };
    const goal: GoalSpec = { kind: "consumeUnits", category: "food", at: ["table"], tplKey: "hunger:food" };
    expect(planGoal(goal, "bear", dining)).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 3, y: 0 } },
        { kind: "consumeStack", goodKey: "food", at: ["table"], tplKey: "hunger:food" },
      ],
    });
  });

  it("no station (or no hook): consume in place — the consumeHere shape", () => {
    const goal: GoalSpec = { kind: "consumeUnits", category: "food", at: ["table"] };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [{ kind: "consumeStack", goodKey: "food", at: ["table"] }],
    });
  });

  it("rest carries a pose override through to the step (fun's play, the open-air sleep)", () => {
    const goal: GoalSpec = { kind: "rest", place: { kind: "point", x: 1, y: 2 }, dwellS: 7, pose: "play" };
    expect(planGoal(goal, "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 1, y: 2 } },
        { kind: "rest", place: { kind: "point", x: 1, y: 2 }, dwellS: 7, pose: "play" },
      ],
    });
  });
});
