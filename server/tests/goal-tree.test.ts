// Unit tests for the shared goal-tree game engine (schema, logical world,
// solver, certification). Pure-logic, no DB / no LLM — safe in the default
// `npm test` run.

import { describe, it, expect } from "@jest/globals";
import type { GoalNode, OvercomeNode } from "@shared/goal-tree/types.js";
import {
  GOAL_TREE_MAX_DEPTH,
  GOAL_TREE_MAX_NODES,
} from "@shared/goal-tree/types.js";
import { measureGoalTree, walkGoalTree } from "@shared/goal-tree/walk.js";
import { validateGoalTreeGame } from "@shared/goal-tree/schema.js";
import { buildLogicalWorld, START_ZONE_ID } from "@shared/goal-tree/logical-world.js";
import { solveGoalTreeGame } from "@shared/goal-tree/solver.js";
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import {
  deepChainGame,
  entity,
  game,
  minimalChooseGame,
  picnicGame,
} from "./helpers/goal-tree-fixtures.js";

function expectInvalid(g: unknown, fragment: string): void {
  const res = validateGoalTreeGame(g);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.errors.join("\n")).toContain(fragment);
  }
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

describe("goal-tree walk", () => {
  it("visits every node in the picnic game with correct edges and depth", () => {
    const visits = [...walkGoalTree(picnicGame().root)];
    expect(visits.map((v) => [v.node.id, v.edge, v.depth])).toEqual([
      ["picnic", "root", 1],
      ["bridge_out", "via", 2],
      ["gather_logs", "key", 3],
      ["log_gate", "placement-via", 4],
      ["match_key", "key", 5],
    ]);
  });

  it("measures node counts by type", () => {
    const m = measureGoalTree(picnicGame().root);
    expect(m.totalNodes).toBe(5);
    expect(m.maxDepth).toBe(5);
    expect(m.byType).toEqual({
      reach: 1,
      collect: 1,
      choose: 1,
      overcome: 2,
      observe: 0,
      transport: 0,
      converse: 0,
      fulfill: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("goal-tree schema", () => {
  it("accepts the picnic game", () => {
    const res = validateGoalTreeGame(picnicGame());
    expect(res.ok).toBe(true);
  });

  it("accepts a minimal single-choose game", () => {
    expect(validateGoalTreeGame(minimalChooseGame()).ok).toBe(true);
  });

  it("rejects non-object input and wrong engine literals", () => {
    expectInvalid(null, "");
    expectInvalid({ ...picnicGame(), engine: "custom-app" }, "engine");
  });

  it("rejects unknown fields (closed schema)", () => {
    const g = picnicGame() as unknown as Record<string, unknown>;
    g.cheatCodes = true;
    expectInvalid(g, "cheatCodes");
  });

  it("rejects duplicate entity ids", () => {
    const g = picnicGame();
    g.entities.push(entity("log", "item"));
    expectInvalid(g, "duplicate entity id: log");
  });

  it("rejects duplicate goal node ids", () => {
    const g = minimalChooseGame();
    g.root = {
      type: "overcome",
      id: "pick_cow",
      obstacleEntityId: "rock",
      key: g.root,
    };
    g.entities.push(entity("rock", "obstacle"));
    expectInvalid(g, "duplicate goal node id: pick_cow");
  });

  it("rejects references to unknown entities", () => {
    const g = minimalChooseGame();
    g.entities = g.entities.filter((e) => e.id !== "cow");
    expectInvalid(g, 'references unknown entity "cow"');
  });

  it("rejects entity references of the wrong kind", () => {
    const g = picnicGame();
    // marker slot pointing at an item
    (g.root as { markerEntityId: string }).markerEntityId = "log";
    expectInvalid(g, 'expected marker | character');
  });

  it("rejects a choose with no correct option", () => {
    const g = minimalChooseGame();
    const root = g.root as Extract<GoalNode, { type: "choose" }>;
    root.options = [{ entityId: "cow" }, { entityId: "duck" }];
    expectInvalid(g, "has 0 correct options");
  });

  it("rejects a choose with two correct options", () => {
    const g = minimalChooseGame();
    const root = g.root as Extract<GoalNode, { type: "choose" }>;
    root.options = [
      { entityId: "cow", correct: true },
      { entityId: "duck", correct: true },
    ];
    expectInvalid(g, "has 2 correct options");
  });

  it("rejects a choose repeating an option entity", () => {
    const g = minimalChooseGame();
    const root = g.root as Extract<GoalNode, { type: "choose" }>;
    root.options = [
      { entityId: "cow", correct: true },
      { entityId: "cow" },
    ];
    expectInvalid(g, 'repeats option entity "cow"');
  });

  it("rejects a choose with a single option", () => {
    const g = minimalChooseGame();
    const root = g.root as Extract<GoalNode, { type: "choose" }>;
    root.options = [{ entityId: "cow", correct: true }];
    expectInvalid(g, "options");
  });

  it("rejects collect placements that do not sum to count", () => {
    const g = picnicGame();
    const collect = (g.root as { via: OvercomeNode[] }).via[0]
      .key as Extract<GoalNode, { type: "collect" }>;
    collect.placements = [{ count: 1 }, { count: 1 }];
    expectInvalid(g, "placements sum to 2 but count is 3");
  });

  it("rejects an item listed as both target and distractor", () => {
    const g = picnicGame();
    const collect = (g.root as { via: OvercomeNode[] }).via[0]
      .key as Extract<GoalNode, { type: "collect" }>;
    collect.distractorEntityIds = ["log"];
    expectInvalid(g, 'both a target and a distractor');
  });

  it("accepts a tree at the max depth and rejects one past it", () => {
    expect(validateGoalTreeGame(deepChainGame(GOAL_TREE_MAX_DEPTH)).ok).toBe(true);
    expectInvalid(
      deepChainGame(GOAL_TREE_MAX_DEPTH + 1),
      `max is ${GOAL_TREE_MAX_DEPTH}`,
    );
  });

  it("rejects trees over the node cap", () => {
    // root reach + N via overcomes, each with a choose key → 1 + 2N nodes
    const pairs = Math.ceil(GOAL_TREE_MAX_NODES / 2);
    const via: OvercomeNode[] = [];
    for (let i = 0; i < pairs; i++) {
      via.push({
        type: "overcome",
        id: `lock_${i}`,
        obstacleEntityId: "rock",
        key: {
          type: "choose",
          id: `quiz_${i}`,
          posedByEntityId: "teacher",
          prompt: "Pick one",
          options: [{ entityId: "cow", correct: true }, { entityId: "duck" }],
        },
      });
    }
    const g = game(
      { type: "reach", id: "goal", markerEntityId: "flag", via },
      [
        entity("flag", "marker"),
        entity("rock", "obstacle"),
        entity("teacher", "character"),
        entity("cow", "item"),
        entity("duck", "item"),
      ],
    );
    expectInvalid(g, `max is ${GOAL_TREE_MAX_NODES}`);
  });
});

// ---------------------------------------------------------------------------
// Logical world
// ---------------------------------------------------------------------------

describe("goal-tree logical world", () => {
  it("projects the picnic game into the expected topology", () => {
    const g = picnicGame();
    const world = buildLogicalWorld(g);

    expect(world.zones.map((z) => z.id).sort()).toEqual([
      "pocket:gather_logs:1",
      START_ZONE_ID,
      "zone:gather_logs",
      "zone:picnic",
    ].sort());

    // A tree of zones: passages = zones - 1
    expect(world.passages).toHaveLength(world.zones.length - 1);

    const byTo = new Map(world.passages.map((p) => [p.to, p]));
    // Key sub-tree builds on the NEAR side: the log forest hangs off start,
    // not off the locked picnic zone.
    expect(byTo.get("zone:gather_logs")!.from).toBe(START_ZONE_ID);
    expect(byTo.get("zone:gather_logs")!.guards).toEqual([]);
    expect(byTo.get("zone:picnic")!.guards.map((x) => x.overcomeNodeId)).toEqual([
      "bridge_out",
    ]);
    expect(
      byTo.get("pocket:gather_logs:1")!.guards.map((x) => x.overcomeNodeId),
    ).toEqual(["log_gate"]);

    // Items: 2 free logs in the collect zone, 1 in the gated pocket.
    expect(world.items).toEqual([
      expect.objectContaining({ zoneId: "zone:gather_logs", count: 2 }),
      expect.objectContaining({ zoneId: "pocket:gather_logs:1", count: 1 }),
    ]);
    expect(world.distractors).toEqual([
      expect.objectContaining({ zoneId: "zone:gather_logs", entityIds: ["acorn"] }),
    ]);

    // Figures: marker at the destination, poser in the collect zone (the
    // near side of the pocket gate it unlocks).
    expect(world.figures).toContainEqual(
      expect.objectContaining({ entityId: "picnic_blanket", zoneId: "zone:picnic" }),
    );
    expect(world.figures).toContainEqual(
      expect.objectContaining({ entityId: "squirrel", zoneId: "zone:gather_logs" }),
    );

    expect(world.sites).toEqual({
      picnic: "zone:picnic",
      bridge_out: START_ZONE_ID,
      gather_logs: "zone:gather_logs",
      log_gate: "zone:gather_logs",
      match_key: "zone:gather_logs",
    });
  });

  it("places a standalone overcome's obstacle in the context zone", () => {
    const g = deepChainGame(2); // root overcome + choose key, all in start
    const world = buildLogicalWorld(g);
    expect(world.zones).toHaveLength(1);
    expect(world.figures).toContainEqual(
      expect.objectContaining({
        entityId: "rock",
        role: "obstacle",
        zoneId: START_ZONE_ID,
      }),
    );
    expect(world.sites["lock_1"]).toBe(START_ZONE_ID);
  });
});

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

describe("goal-tree solver", () => {
  it("certifies the picnic game with a sensible plan", () => {
    const g = picnicGame();
    const world = buildLogicalWorld(g);
    const result = solveGoalTreeGame(g, world);

    expect(result.solvable).toBe(true);
    if (!result.solvable) return;

    const completions = result.plan
      .filter((s) => s.kind === "goal-completed")
      .map((s) => (s.kind === "goal-completed" ? s.nodeId : ""));
    // Dependencies resolve inner-first; the root completes last.
    expect(completions).toEqual([
      "match_key",
      "log_gate",
      "gather_logs",
      "bridge_out",
      "picnic",
    ]);

    expect(result.stats.zoneCount).toBe(4);
    expect(result.stats.passageCount).toBe(3);
    expect(result.stats.goalCounts).toEqual({
      reach: 1,
      collect: 1,
      choose: 1,
      overcome: 2,
      observe: 0,
      transport: 0,
      converse: 0,
      fulfill: 0,
    });
    expect(result.stats.estimatedTravelLegs).toBeGreaterThan(0);
  });

  it("solves a single-choose game in place", () => {
    const g = minimalChooseGame();
    const result = solveGoalTreeGame(g, buildLogicalWorld(g));
    expect(result.solvable).toBe(true);
    if (!result.solvable) return;
    expect(result.plan).toEqual([
      expect.objectContaining({ kind: "goal-completed", nodeId: "pick_cow" }),
    ]);
    expect(result.stats.estimatedTravelLegs).toBe(0);
  });

  it("detects a key locked behind its own lock (safety net)", () => {
    // The builder never produces this by construction; mutate the world to
    // simulate a future projector bug: the squirrel (whose answer opens the
    // pocket gate) ends up INSIDE the pocket.
    const g = picnicGame();
    const world = buildLogicalWorld(g);
    world.sites["match_key"] = "pocket:gather_logs:1";

    const result = solveGoalTreeGame(g, world);
    expect(result.solvable).toBe(false);
    if (result.solvable) return;
    const text = result.blocked.map((b) => b.reason).join("\n");
    expect(text).toContain('"match_key"');
    expect(text).toContain("unreachable zone");
    expect(text).toContain("log_gate");
  });

  it("reports collect goals blocked by unreachable item pockets", () => {
    const g = picnicGame();
    const world = buildLogicalWorld(g);
    // Sever the pocket: pretend its gate guard never clears by pointing the
    // guard at a nonexistent overcome node.
    const pocketPassage = world.passages.find(
      (p) => p.to === "pocket:gather_logs:1",
    )!;
    pocketPassage.guards = [
      { overcomeNodeId: "never_clears", obstacleEntityId: "gate" },
    ];

    const result = solveGoalTreeGame(g, world);
    expect(result.solvable).toBe(false);
    if (result.solvable) return;
    const text = result.blocked.map((b) => b.reason).join("\n");
    expect(text).toContain('collect "gather_logs"');
    expect(text).toContain("never_clears");
  });
});

// ---------------------------------------------------------------------------
// Certification (full gauntlet)
// ---------------------------------------------------------------------------

describe("certifyGoalTreeGame", () => {
  it("certifies a valid game end to end", () => {
    const result = certifyGoalTreeGame(picnicGame());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.game.meta.title).toBe("Test Game");
    expect(result.world.zones.length).toBe(4);
    expect(result.solution.plan.length).toBeGreaterThan(0);
  });

  it("fails at the schema stage with readable errors", () => {
    const g = picnicGame();
    g.entities = g.entities.filter((e) => e.id !== "squirrel");
    const result = certifyGoalTreeGame(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("schema");
    expect(result.errors.join("\n")).toContain("squirrel");
  });

  it("rejects junk input without throwing", () => {
    for (const junk of [undefined, null, 42, "game", [], {}]) {
      const result = certifyGoalTreeGame(junk);
      expect(result.ok).toBe(false);
    }
  });
});
