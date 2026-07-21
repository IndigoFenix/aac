// The live goal/rule runtime (creature-goal-runtime.ts): default curfew rules parse+
// compile, and stepCreatureGoals issues a go-home errand at night, clears by day.
// Pure/headless — safe in default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  createCreatureGoalState,
  defaultCurfewRules,
  stepCreatureGoals,
  type GoalRuntimeHooks,
} from "@shared/world-engine/interaction/behavior/creature-goal-runtime.js";
import type { GoalPlan, WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";

describe("defaultCurfewRules — authored through the real pipeline", () => {
  it("compiles one self-authored 'when night go home' rule per creature", () => {
    const rules = defaultCurfewRules(["bear", "fox"]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      id: "curfew_bear",
      author: "bear", // self-authored → full compliance (a town custom)
      binding: { kind: "agent", id: "bear" },
      trigger: { kind: "worldState", token: "night" },
      lifetime: "while",
      action: { kind: "goHome" },
    });
  });
});

describe("stepCreatureGoals — the live curfew", () => {
  function harness() {
    const world = createCreatureWorld([{ id: "bear" }], []);
    const gs = createCreatureGoalState(defaultCurfewRules(["bear"]), { dayLength: 100 });
    const issued: { cid: string; plan: GoalPlan }[] = [];
    const resolver: WorldResolver = {
      positionOf: () => ({ x: 0, y: 0 }),
      homeOf: () => ({ x: 5, y: 5 }),
      place: () => null,
      resolveItem: () => null,
      itemPosition: () => null,
      stationFor: () => null,
    };
    const hooks: GoalRuntimeHooks = {
      world,
      creatureIds: ["bear"],
      resolver,
      isBusy: () => false,
      issue: (cid, plan) => issued.push({ cid, plan }),
    };
    return { gs, hooks, issued };
  }

  it("issues a go-home errand at night (clock starts at midnight)", () => {
    const { gs, hooks, issued } = harness();
    stepCreatureGoals(gs, 0.1, hooks); // t≈0.1s → night
    expect(issued).toHaveLength(1);
    expect(issued[0].cid).toBe("bear");
    expect(issued[0].plan.steps).toEqual([{ kind: "moveTo", pos: { x: 5, y: 5 } }]);
  });

  it("does not re-issue while it stays night (only on goal CHANGE)", () => {
    const { gs, hooks, issued } = harness();
    stepCreatureGoals(gs, 0.1, hooks);
    stepCreatureGoals(gs, 0.1, hooks); // still night
    expect(issued).toHaveLength(1);
  });

  it("clears the goal by midday and re-issues the next night", () => {
    const { gs, hooks, issued } = harness();
    stepCreatureGoals(gs, 0.1, hooks); // night → issued
    stepCreatureGoals(gs, 50, hooks); // advance to ~midday → goal clears, no new errand
    expect(issued).toHaveLength(1);
    stepCreatureGoals(gs, 50, hooks); // back around to night → issue again
    expect(issued).toHaveLength(2);
  });

  it("holds off while the creature is busy on another errand", () => {
    const { gs, hooks, issued } = harness();
    stepCreatureGoals(gs, 0.1, { ...hooks, isBusy: () => true });
    expect(issued).toHaveLength(0); // deferred; retries when the goal next changes
  });
});
