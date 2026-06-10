// Guards the goal-tree-player's built-in demo content: the game must pass
// the full certification gauntlet (schema → solver → projected layout).
// Layout geometry itself is produced by the shared projector and covered by
// goal-tree-projector.test.ts.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import { demoGame } from "../../games/goal-tree-player/src/demo-content.js";

describe("goal-tree-player demo content", () => {
  it("passes the full certification gauntlet", () => {
    const result = certifyGoalTreeGame(demoGame());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.plan.length).toBeGreaterThan(0);
    expect(result.layout.zones).toHaveLength(4);
    expect(result.layout.doors).toHaveLength(3);
  });

  it("every entity referenced by the demo has a displayable icon", () => {
    const game = demoGame();
    for (const entity of game.entities) {
      expect(entity.iconRef ?? entity.imageKey ?? entity.symbolPath).toBeTruthy();
    }
  });
});
