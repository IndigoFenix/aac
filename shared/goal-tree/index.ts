// shared/goal-tree/index.ts — public surface for the goal-tree game engine.
//
// The certification gauntlet (schema → logical world → solver) lives here as
// certifyGoalTreeGame(). The generation pipeline must only persist games that
// certify; the runtime may assume any stored definition already has a
// completion certificate.

export * from "./types.js";
export * from "./walk.js";
export * from "./schema.js";
export * from "./logical-world.js";
export * from "./solver.js";
export * from "./space.js";
export * from "./runtime.js";
export * from "./layout2d.js";
export * from "./space2d.js";
export * from "./projector2d.js";

import type { GoalTreeGame } from "./types.js";
import { validateGoalTreeGame } from "./schema.js";
import { buildLogicalWorld, type LogicalWorld } from "./logical-world.js";
import { solveGoalTreeGame, type SolvedGame } from "./solver.js";
import type { Layout2D } from "./layout2d.js";
import { projectLayout2D, validateLayout2D } from "./projector2d.js";

export type CertificationResult =
  | {
      ok: true;
      game: GoalTreeGame;
      world: LogicalWorld;
      solution: SolvedGame;
      /** The canonical projected layout (before clinician overrides). */
      layout: Layout2D;
    }
  | {
      ok: false;
      /** Which gauntlet stage rejected the game. */
      stage: "schema" | "solver" | "layout";
      errors: string[];
    };

/**
 * Full certification gauntlet: parse + structural validation, logical-world
 * build, solver completability proof, map projection + layout validation.
 * Returns everything downstream stages need (the typed game, the world, the
 * plan for difficulty, the playable layout).
 *
 * Clinician layout overrides are NOT applied here — the editor validates an
 * overridden layout separately via validateLayout2D (+ solver re-run).
 */
export function certifyGoalTreeGame(input: unknown): CertificationResult {
  const validated = validateGoalTreeGame(input);
  if (!validated.ok) {
    return { ok: false, stage: "schema", errors: validated.errors };
  }

  const world = buildLogicalWorld(validated.data);
  const solved = solveGoalTreeGame(validated.data, world);
  if (!solved.solvable) {
    return {
      ok: false,
      stage: "solver",
      errors: solved.blocked.map((b) => b.reason),
    };
  }

  const layout = projectLayout2D(validated.data, world);
  const layoutErrors = validateLayout2D(validated.data, world, layout);
  if (layoutErrors.length > 0) {
    return { ok: false, stage: "layout", errors: layoutErrors };
  }

  return { ok: true, game: validated.data, world, solution: solved, layout };
}
