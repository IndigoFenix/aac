// Tests for the 2D map projector, layout overrides, and layout validator.
// Pure-logic, no DB / no LLM — safe in the default `npm test` run.

import { describe, it, expect } from "@jest/globals";
import type { GoalNode, OvercomeNode } from "@shared/world-engine/solver/types.js";
import { buildLogicalWorld } from "@shared/world-engine/solver/logical-world.js";
import {
  applyLayout2DOverrides,
  projectLayout2D,
  validateLayout2D,
} from "@shared/world-engine/solver/projector2d.js";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import { solveGoalTreeGame } from "@shared/world-engine/solver/solver.js";
import { rectContains } from "@shared/world-engine/solver/layout2d.js";
import type { GoalTreeGame } from "@shared/world-engine/solver/types.js";
import {
  deepChainGame,
  entity,
  game,
  minimalChooseGame,
  picnicGame,
} from "../helpers/goal-tree-fixtures.js";

function project(g: GoalTreeGame) {
  const world = buildLogicalWorld(g);
  const layout = projectLayout2D(g, world);
  return { world, layout };
}

/** A start hub with `n` reach branches, each guarded by a quizzed gate. */
function multiBranchGame(n: number): GoalTreeGame {
  const via: OvercomeNode[] = [];
  for (let i = 0; i < n - 1; i++) {
    via.push({
      type: "overcome",
      id: `gate_${i}`,
      obstacleEntityId: "rock",
      key: {
        type: "reach",
        id: `waypoint_${i}`,
        markerEntityId: "flag",
      } satisfies GoalNode,
    });
  }
  return game(
    { type: "reach", id: "goal", markerEntityId: "flag", via },
    [entity("flag", "marker"), entity("rock", "obstacle")],
  );
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe("projectLayout2D", () => {
  it("projects the picnic game into a valid layout", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    expect(validateLayout2D(g, world, layout)).toEqual([]);

    expect(layout.zones).toHaveLength(4);
    expect(layout.doors).toHaveLength(3);
    // Distractor density: 3 targets → 2 acorns.
    expect(layout.items.filter((i) => i.distractor)).toHaveLength(2);
    expect(layout.items.filter((i) => !i.distractor)).toHaveLength(3);
  });

  it("stacks children on the parent's east edge (icicle structure)", () => {
    const g = picnicGame();
    const { layout } = project(g);
    const rect = new Map(layout.zones.map((z) => [z.zoneId, z.rect]));
    const start = rect.get("start")!;
    const logs = rect.get("zone:gather_logs")!;
    const picnic = rect.get("zone:picnic")!;
    const pocket = rect.get("pocket:gather_logs:1")!;

    // Both of start's children share its east edge; the pocket hangs off logs.
    expect(logs.x).toBeCloseTo(start.x + start.w);
    expect(picnic.x).toBeCloseTo(start.x + start.w);
    expect(pocket.x).toBeCloseTo(logs.x + logs.w);
    // Siblings occupy disjoint vertical bands.
    expect(logs.y + logs.h).toBeLessThanOrEqual(picnic.y + 1e-9);
  });

  it("is deterministic", () => {
    const g = picnicGame();
    const world = buildLogicalWorld(g);
    const a = projectLayout2D(g, world);
    const b = projectLayout2D(g, world);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("appending content leaves existing placements unchanged", () => {
    const before = project(picnicGame());

    // Same tree, one more free log (count 3→4 stays in the same size bucket).
    const bigger = picnicGame();
    const collect = (bigger.root as { via: OvercomeNode[] }).via[0]
      .key as Extract<GoalNode, { type: "collect" }>;
    collect.count = 4;
    collect.placements = [{ count: 3 }, collect.placements![1]];
    const after = project(bigger);

    expect(validateLayout2D(bigger, after.world, after.layout)).toEqual([]);
    // Zone geometry identical; previously placed things untouched.
    expect(JSON.stringify(after.layout.zones)).toBe(
      JSON.stringify(before.layout.zones),
    );
    expect(JSON.stringify(after.layout.figures)).toBe(
      JSON.stringify(before.layout.figures),
    );
    const posOf = (l: typeof before.layout, id: string) =>
      l.items.find((i) => i.instanceId === id)?.pos;
    for (const id of ["item:gather_logs:0:0", "item:gather_logs:0:1"]) {
      expect(posOf(after.layout, id)).toEqual(posOf(before.layout, id));
    }
  });

  it("handles a many-branch hub without overlaps", () => {
    const g = multiBranchGame(5);
    const { world, layout } = project(g);
    expect(validateLayout2D(g, world, layout)).toEqual([]);
    expect(layout.zones).toHaveLength(6); // start + goal + 4 waypoints
    // The hub stretched to host all bands.
    const start = layout.zones.find((z) => z.zoneId === "start")!.rect;
    const childBands = layout.zones
      .filter((z) => z.zoneId !== "start")
      .reduce((acc, z) => acc + z.rect.h, 0);
    expect(start.h).toBeGreaterThanOrEqual(childBands - 1e-9);
  });

  it("handles single-zone games (figures spaced off the spawn)", () => {
    const g = minimalChooseGame();
    const { world, layout } = project(g);
    expect(validateLayout2D(g, world, layout)).toEqual([]);
    expect(layout.zones).toHaveLength(1);
    expect(layout.doors).toHaveLength(0);
    const poser = layout.figures[0];
    const d = Math.hypot(poser.pos.x - layout.spawn.x, poser.pos.y - layout.spawn.y);
    expect(d).toBeGreaterThanOrEqual(1.7 - 1e-9);
  });

  it("stacks a deep standalone-overcome chain inside the start zone", () => {
    const g = deepChainGame(5);
    const { world, layout } = project(g);
    expect(validateLayout2D(g, world, layout)).toEqual([]);
    expect(layout.zones).toHaveLength(1);
    expect(layout.figures.length).toBe(5); // 4 rocks + 1 poser
  });

  it("keeps content clear of doorways", () => {
    const g = picnicGame();
    const { layout } = project(g);
    for (const door of layout.doors) {
      const center = {
        x: door.rect.x + door.rect.w / 2,
        y: door.rect.y + door.rect.h / 2,
      };
      for (const thing of [...layout.figures, ...layout.items]) {
        const d = Math.hypot(thing.pos.x - center.x, thing.pos.y - center.y);
        expect(d).toBeGreaterThanOrEqual(1.6 - 1e-9);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe("applyLayout2DOverrides", () => {
  it("moves a figure within its zone and stays valid", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    const logsRect = layout.zones.find((z) => z.zoneId === "zone:gather_logs")!.rect;
    const target = { x: logsRect.x + 2, y: logsRect.y + logsRect.h - 2 };

    const edited = applyLayout2DOverrides(layout, {
      figures: { match_key: target },
    });
    expect(edited.figures.find((f) => f.nodeId === "match_key")!.pos).toEqual(target);
    expect(validateLayout2D(g, world, edited)).toEqual([]);
    // Untouched layout objects are preserved.
    expect(edited.zones).toEqual(layout.zones);
  });

  it("flags a figure dragged outside its zone", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    const edited = applyLayout2DOverrides(layout, {
      figures: { match_key: { x: -50, y: -50 } },
    });
    const errors = validateLayout2D(g, world, edited);
    expect(errors.join("\n")).toContain('"match_key"');
    expect(errors.join("\n")).toContain("outside its zone");
  });

  it("flags zone edits that create overlaps or detach doors", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    const start = layout.zones.find((z) => z.zoneId === "start")!.rect;
    // Stretch start east over its children.
    const edited = applyLayout2DOverrides(layout, {
      zones: { start: { ...start, w: start.w + 6 } },
    });
    const errors = validateLayout2D(g, world, edited);
    expect(errors.some((e) => e.includes("overlap"))).toBe(true);
  });

  it("flags a door moved off its passage's shared edge", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    const edited = applyLayout2DOverrides(layout, {
      doors: {
        "passage:start->zone:picnic": { x: 0, y: 0, w: 1, h: 2 },
      },
    });
    const errors = validateLayout2D(g, world, edited);
    expect(errors.join("\n")).toContain("not crossable");
  });

  it("drops orphaned overrides silently", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    const edited = applyLayout2DOverrides(layout, {
      figures: { long_gone_node: { x: 1, y: 1 } },
      zones: { "zone:deleted": { x: 0, y: 0, w: 5, h: 5 } },
    });
    expect(JSON.stringify(edited)).toBe(JSON.stringify(layout));
    expect(validateLayout2D(g, world, edited)).toEqual([]);
  });

  it("validates spawn overrides", () => {
    const g = picnicGame();
    const { world, layout } = project(g);
    const bad = applyLayout2DOverrides(layout, { spawn: { x: 999, y: 999 } });
    expect(validateLayout2D(g, world, bad).join("\n")).toContain("spawn");
  });
});

// ---------------------------------------------------------------------------
// Certification gauntlet includes the layout stage
// ---------------------------------------------------------------------------

describe("certification with layout", () => {
  it("returns the projected layout for a valid game", () => {
    const result = certifyGoalTreeGame(picnicGame());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.zones.length).toBe(4);
    expect(validateLayout2D(result.game, result.world, result.layout)).toEqual([]);
    // The solver's certificate and the layout describe the same world.
    expect(solveGoalTreeGame(result.game, result.world).solvable).toBe(true);
    for (const zone of result.world.zones) {
      expect(result.layout.zones.some((z) => z.zoneId === zone.id)).toBe(true);
    }
  });

  it("spawn starts inside the start zone", () => {
    const result = certifyGoalTreeGame(picnicGame());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const startRect = result.layout.zones.find((z) => z.zoneId === "start")!.rect;
    expect(rectContains(startRect, result.layout.spawn, 0.35)).toBe(true);
  });
});
