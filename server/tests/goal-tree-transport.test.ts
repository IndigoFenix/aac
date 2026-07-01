// The `transport` node — the "move object A→B" puzzle: carry an object onto a
// destination container. Pure-logic, no DB / no GL. Confirms it certifies, the
// player-side helper materializes the carry object + container, and the runtime
// completes on a place-object input.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import { buildLogicalWorld } from "@shared/goal-tree/logical-world.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
} from "@shared/goal-tree/runtime.js";
import { validateGoalTreeGame } from "@shared/goal-tree/schema.js";
import { buildTransportObjects, embedLayoutInWorld } from "@shared/goal-tree/space3d.js";
import type { GoalTreeGame, TransportNode } from "@shared/goal-tree/types.js";

function putCupGame(): GoalTreeGame {
  const root: TransportNode = {
    type: "transport",
    id: "put_cup",
    intro: "Put the cup on the table.",
    outro: "On the table — nice!",
    objectEntityId: "cup",
    destEntityId: "table",
    relation: "on",
    zoneHint: "kitchen",
  };
  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: { title: "On the table", locale: "en", theme: "kitchen", learningGoals: ["on"] },
    entities: [
      { id: "cup", kind: "item", label: "Cup", iconRef: "☕" },
      { id: "table", kind: "marker", label: "Table", iconRef: "🪑" },
    ],
    root,
  };
}

describe("goal-tree transport (move object A→B)", () => {
  it("certifies and is solvable", () => {
    const certified = certifyGoalTreeGame(putCupGame());
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    expect(certified.solution.solvable).toBe(true);
    expect(certified.solution.stats.goalCounts.transport).toBe(1);
    expect(certified.world.sites["put_cup"]).toBe("zone:put_cup");
  });

  it("materializes the carry object + destination container in the zone", () => {
    const certified = certifyGoalTreeGame(putCupGame());
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    const embedding = embedLayoutInWorld(certified.layout);
    const { objects, placements } = buildTransportObjects(certified.game, certified.world, embedding.layout);

    const obj = objects.find((o) => o.id === "obj_put_cup");
    const dest = objects.find((o) => o.id === "dest_put_cup");
    expect(obj).toMatchObject({ shape: "box", interactions: ["carry"] });
    expect(dest).toMatchObject({ interactions: [], contains: [{ relation: "on" }] });
    expect(placements).toEqual([{ nodeId: "put_cup", objectId: "obj_put_cup", distractorObjectIds: [], destId: "dest_put_cup", relation: "on" }]);
    // Both sit inside the transport node's zone.
    const rect = embedding.layout.zones.find((z) => z.zoneId === "zone:put_cup")!.rect;
    for (const o of [obj!, dest!]) {
      expect(o.x).toBeGreaterThanOrEqual(rect.x);
      expect(o.x).toBeLessThanOrEqual(rect.x + rect.w);
    }
  });

  it("completes the transport on a place-object input (and wins)", () => {
    const game = putCupGame();
    const world = buildLogicalWorld(game);
    const ctx = createRuntimeContext(game, world);
    let state = applyRuntimeInput(ctx, createRuntimeState(), { type: "start" }).state;
    const out = applyRuntimeInput(ctx, state, { type: "place-object", nodeId: "put_cup" });
    expect(out.state.completed["put_cup"]).toBe(true);
    expect(out.state.won).toBe(true);
    expect(out.events.some((e) => e.type === "game-won")).toBe(true);
  });

  it("schema rejects a transport pointing at a non-item object", () => {
    const game = putCupGame() as GoalTreeGame & { root: TransportNode };
    game.root.objectEntityId = "table"; // a marker, not an item
    expect(validateGoalTreeGame(game).ok).toBe(false);
  });
});
