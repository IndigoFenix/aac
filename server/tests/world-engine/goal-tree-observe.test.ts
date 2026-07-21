// Tests for the `observe` node — the symbol-learning WATCH beat: travel to a
// stage, watch a demonstration, get it labelled with a glyph. Pure-logic, no DB
// / no LLM. Drives the runtime with direct inputs (a mock space), the way the
// other runtime tests do, so this exercises the primitive itself, not movement.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import { buildLogicalWorld } from "@shared/world-engine/solver/logical-world.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeState,
} from "@shared/world-engine/solver/runtime.js";
import { validateGoalTreeGame } from "@shared/world-engine/solver/schema.js";
import type { GoalTreeGame, ObserveNode } from "@shared/world-engine/solver/types.js";

/** Smallest observe lesson: a one-room game whose root is "watch the ball get
 *  big", labelled with the `big` glyph (contrast `small`). */
function bigLessonGame(): GoalTreeGame {
  const root: ObserveNode = {
    type: "observe",
    id: "learn_big",
    intro: "Watch this!",
    outro: "It got big!",
    targetGlyph: "big",
    contrastGlyph: "small",
    stageEntityId: "ball",
    zoneHint: "play mat",
    demonstrate: [
      { kind: "scale", entityId: "ball", to: 3, seconds: 1.2 },
    ],
  };
  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: { title: "Big", locale: "en", theme: "learning", learningGoals: ["big"] },
    entities: [{ id: "ball", kind: "item", label: "ball", iconRef: "⚽" }],
    root,
  };
}

describe("goal-tree observe (symbol-learning WATCH beat)", () => {
  it("certifies (schema → world → solver → layout) and is solvable", () => {
    const certified = certifyGoalTreeGame(bigLessonGame());
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    // The observe node got its own zone with a stage figure (like reach).
    expect(certified.world.sites["learn_big"]).toBe("zone:learn_big");
    expect(certified.world.figures).toContainEqual(
      expect.objectContaining({ entityId: "ball", forNodeId: "learn_big", role: "marker" }),
    );
    expect(certified.layout.figures.some((f) => f.nodeId === "learn_big")).toBe(true);
    expect(certified.solution.solvable).toBe(true);
    expect(certified.solution.stats.goalCounts.observe).toBe(1);
  });

  it("touching the stage plays the demonstration and completes the lesson", () => {
    const game = bigLessonGame();
    const world = buildLogicalWorld(game);
    const ctx = createRuntimeContext(game, world);
    let state: RuntimeState = createRuntimeState();

    state = applyRuntimeInput(ctx, state, { type: "start" }).state;
    const out = applyRuntimeInput(ctx, state, { type: "touch-figure", nodeId: "learn_big" });

    // The demonstrate command carries the glyph + the authored cues, verbatim.
    const demo = out.commands.find((c) => c.type === "demonstrate");
    expect(demo).toMatchObject({
      type: "demonstrate",
      nodeId: "learn_big",
      targetGlyph: "big",
      contrastGlyph: "small",
      cues: [{ kind: "scale", entityId: "ball", to: 3, seconds: 1.2 }],
    });

    // The taught glyph is surfaced to observers/AI…
    expect(out.events).toContainEqual({
      type: "demonstration-shown",
      nodeId: "learn_big",
      targetGlyph: "big",
    });
    // …and the beat completes (root → win), never gating.
    expect(out.events.some((e) => e.type === "goal-completed" && e.nodeId === "learn_big")).toBe(true);
    expect(out.events.some((e) => e.type === "game-won")).toBe(true);
    expect(out.state.won).toBe(true);
  });

  it("re-touching a completed observe is a no-op (idempotent, eyegaze-safe)", () => {
    const game = bigLessonGame();
    const world = buildLogicalWorld(game);
    const ctx = createRuntimeContext(game, world);
    let state = applyRuntimeInput(ctx, createRuntimeState(), { type: "start" }).state;
    state = applyRuntimeInput(ctx, state, { type: "touch-figure", nodeId: "learn_big" }).state;
    const again = applyRuntimeInput(ctx, state, { type: "touch-figure", nodeId: "learn_big" });
    expect(again.commands.some((c) => c.type === "demonstrate")).toBe(false);
  });

  it("schema rejects a demo cue that references an unknown entity", () => {
    const game = bigLessonGame() as GoalTreeGame & { root: ObserveNode };
    game.root.demonstrate = [{ kind: "scale", entityId: "ghost", to: 2 }];
    const res = validateGoalTreeGame(game);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toMatch(/unknown entity "ghost"/);
  });

  it("schema rejects an empty demonstration", () => {
    const game = bigLessonGame() as GoalTreeGame & { root: ObserveNode };
    game.root.demonstrate = [];
    expect(validateGoalTreeGame(game).ok).toBe(false);
  });
});
