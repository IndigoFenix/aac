// Shared fixtures for goal-tree engine tests (schema/solver + runtime/space2d).

import type {
  EntityDef,
  GoalNode,
  GoalTreeGame,
  OvercomeNode,
} from "@shared/world-engine/solver/types.js";

export function entity(
  id: string,
  kind: EntityDef["kind"],
  label = id,
): EntityDef {
  return { id, kind, label };
}

export function game(root: GoalNode, entities: EntityDef[]): GoalTreeGame {
  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: { title: "Test Game", locale: "en", theme: "test" },
    entities,
    root,
  };
}

/**
 * The flagship example from the v2 plan: reach the picnic → bridge is out →
 * the squirrel opens it if you collect 3 logs → one log is behind a gate →
 * choose the matching key shape.
 */
export function picnicGame(): GoalTreeGame {
  const entities: EntityDef[] = [
    entity("picnic_blanket", "marker"),
    entity("broken_bridge", "obstacle"),
    entity("gate", "obstacle"),
    entity("squirrel", "character"),
    entity("log", "item"),
    entity("acorn", "item"),
    entity("key_round", "item"),
    entity("key_square", "item"),
  ];
  const root: GoalNode = {
    type: "reach",
    id: "picnic",
    intro: "Let's get to the picnic!",
    outro: "We made it to the picnic!",
    markerEntityId: "picnic_blanket",
    zoneHint: "sunny riverbank",
    via: [
      {
        type: "overcome",
        id: "bridge_out",
        obstacleEntityId: "broken_bridge",
        prompt: "The bridge is out!",
        key: {
          type: "collect",
          id: "gather_logs",
          itemEntityIds: ["log"],
          count: 3,
          distractorEntityIds: ["acorn"],
          zoneHint: "log forest",
          placements: [
            { count: 2 },
            {
              count: 1,
              via: [
                {
                  type: "overcome",
                  id: "log_gate",
                  obstacleEntityId: "gate",
                  key: {
                    type: "choose",
                    id: "match_key",
                    posedByEntityId: "squirrel",
                    prompt: "Which key fits the square lock?",
                    options: [
                      { entityId: "key_round", feedback: "Round does not fit." },
                      { entityId: "key_square", correct: true },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
  return game(root, entities);
}

export function minimalChooseGame(): GoalTreeGame {
  return game(
    {
      type: "choose",
      id: "pick_cow",
      posedByEntityId: "teacher",
      prompt: "Which one is the cow?",
      options: [
        { entityId: "cow", correct: true },
        { entityId: "duck" },
      ],
    },
    [entity("teacher", "character"), entity("cow", "item"), entity("duck", "item")],
  );
}

/** A chain of overcome keys `depth` nodes deep, ending in a choose. */
export function deepChainGame(depth: number): GoalTreeGame {
  let node: GoalNode = {
    type: "choose",
    id: "leaf",
    posedByEntityId: "teacher",
    prompt: "Pick one",
    options: [{ entityId: "cow", correct: true }, { entityId: "duck" }],
  };
  for (let i = depth - 1; i >= 1; i--) {
    node = {
      type: "overcome",
      id: `lock_${i}`,
      obstacleEntityId: "rock",
      key: node,
    } satisfies OvercomeNode;
  }
  return game(node, [
    entity("teacher", "character"),
    entity("cow", "item"),
    entity("duck", "item"),
    entity("rock", "obstacle"),
  ]);
}
