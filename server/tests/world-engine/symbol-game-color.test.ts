// THE COLOR COMMAND (P3 — generic recolour): "color the shirt red" picks up the
// garment, carries it to a coloring tub (a water barrel/bath doubling as the dye
// vat), and swaps its colour facet. Like `transform` (cook/cool), it regresses
// through the action planner: `colored` target → holding → walk-to-tub → color
// step; `compileGoal` delegates so the static bake and the live pursuit never
// drift. GENERIC — the same verb recolours any item (withVariation is
// kind-agnostic). Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { compileGoal as compileGoalPriced, type GoalPlan, type WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import { planGoal as planGoalPriced, goalTarget, pursue } from "@shared/world-engine/interaction/behavior/action-planner.js";
import type { CreatureId } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// STEP ④ SEAM: a compile carries a `cost` now (goal-selection.ts `GoalPlan`).
// These cases are about the STEPS the colour goal regresses to, so they read the
// steps; `plan-costs-and-bags.test.ts` owns the price.
const stepsOnly = (p: GoalPlan | null) => (p ? { steps: p.steps } : null);
const planGoal = (g: GoalSpec, self: CreatureId, r: WorldResolver) => stepsOnly(planGoalPriced(g, self, r));
const compileGoal = (g: GoalSpec, self: CreatureId, r: WorldResolver) => stepsOnly(compileGoalPriced(g, self, r));
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// bear at origin; a shirt loose at (10,0); a coloring tub at (2,0). `carrier`
// says the actor already holds the shirt; `tub=false` removes the tub.
function resolver(carrier: string | null = null, tub = true): WorldResolver {
  const items: Record<string, { x: number; y: number }> = { shirt1: { x: 10, y: 0 } };
  const creatures: Record<string, { x: number; y: number }> = { bear: { x: 0, y: 0 } };
  return {
    positionOf: (id) => creatures[id] ?? null,
    homeOf: () => ({ x: -5, y: 0 }),
    place: () => null,
    resolveItem: (ref) => ("id" in ref ? ref.id : "shirt1"),
    itemPosition: (id) => items[id] ?? null,
    stationFor: () => null,
    colorStation: () => (tub ? { x: 2, y: 0 } : null),
    carrierOf: (id) => (id === "shirt1" ? carrier : null),
  };
}

const colorGoal = (): GoalSpec => ({ kind: "color", item: { id: "shirt1" }, color: "color_red" });

describe("color — regresses through holding → the coloring tub", () => {
  it("loose garment: walk to it, pick it up, carry it to the tub, then color", () => {
    expect(planGoal(colorGoal(), "bear", resolver())).toEqual({
      steps: [
        { kind: "moveTo", pos: { x: 10, y: 0 } }, // to the shirt
        { kind: "pick", itemId: "shirt1" }, // hold it
        { kind: "moveTo", pos: { x: 2, y: 0 } }, // to the tub
        { kind: "color", itemId: "shirt1", color: "color_red" },
      ],
    });
  });

  it("already in hand: the pickup leg drops — just walk to the tub and color", () => {
    expect(planGoal(colorGoal(), "bear", resolver("bear"))).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 2, y: 0 } }, { kind: "color", itemId: "shirt1", color: "color_red" }],
    });
  });

  it("held by ANOTHER creature is unreachable — can't snatch it to colour", () => {
    expect(planGoal(colorGoal(), "bear", resolver("mara"))).toBeNull();
  });

  it("NO tub nearby → recolour in hand where you stand (never a dead-end)", () => {
    // Unlike transform (which blocks without its station), a colour command with
    // no tub recolours in place — the item still gets its new colour.
    expect(planGoal(colorGoal(), "bear", resolver("bear", false))).toEqual({
      steps: [{ kind: "color", itemId: "shirt1", color: "color_red" }],
    });
  });

  it("the colour rides the step verbatim (any color_* value)", () => {
    const g: GoalSpec = { kind: "color", item: { id: "shirt1" }, color: "color_green" };
    const plan = planGoal(g, "bear", resolver("bear"))!;
    expect(plan.steps.at(-1)).toEqual({ kind: "color", itemId: "shirt1", color: "color_green" });
  });
});

describe("color — the goal is planner-owned and compileGoal delegates", () => {
  it("goalTarget maps color → the `colored` predicate", () => {
    expect(goalTarget(colorGoal(), "bear", resolver())).toEqual({
      kind: "colored",
      item: "shirt1",
      color: "color_red",
    });
  });

  it("compileGoal returns exactly what planGoal returns (one owner, no drift)", () => {
    for (const c of [null, "bear", "mara"] as const) {
      expect(compileGoal(colorGoal(), "bear", resolver(c))).toEqual(planGoal(colorGoal(), "bear", resolver(c)));
    }
  });

  it("pursue drives it to a terminal color act, then done", () => {
    // Already at the tub with the shirt in hand ⇒ the first (only) step is the
    // color act, flagged `last` (the recolour ends the pursuit).
    const atTub: WorldResolver = { ...resolver("bear"), arrived: () => true };
    const step = pursue(colorGoal(), "bear", atTub);
    expect(step).toEqual({ kind: "act", step: { kind: "color", itemId: "shirt1", color: "color_red" }, last: true });
  });
});
