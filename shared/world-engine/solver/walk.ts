// shared/goal-tree/walk.ts
//
// Pre-order traversal over a goal tree. Children of a node are:
//   reach    → its `via` obstacles
//   collect  → its `via` obstacles + each placement's `via` obstacles
//   choose   → (leaf)
//   overcome → its `key`
//   observe  → its `via` obstacles
//   transport→ its `via` obstacles
//   converse → its `via` obstacles (the dialogue turns are node-internal data)

import type { GoalNode, GoalNodeType } from "./types.js";

/** How a node hangs off its parent. */
export type GoalEdge = "root" | "via" | "key" | "placement-via";

export interface GoalNodeVisit {
  node: GoalNode;
  parent: GoalNode | null;
  edge: GoalEdge;
  /** Root = 1. */
  depth: number;
}

export function* walkGoalTree(root: GoalNode): Generator<GoalNodeVisit> {
  yield* visit(root, null, "root", 1);
}

function* visit(
  node: GoalNode,
  parent: GoalNode | null,
  edge: GoalEdge,
  depth: number,
): Generator<GoalNodeVisit> {
  yield { node, parent, edge, depth };
  switch (node.type) {
    case "reach":
      for (const o of node.via ?? []) yield* visit(o, node, "via", depth + 1);
      break;
    case "collect":
      for (const o of node.via ?? []) yield* visit(o, node, "via", depth + 1);
      for (const p of node.placements ?? []) {
        for (const o of p.via ?? []) {
          yield* visit(o, node, "placement-via", depth + 1);
        }
      }
      break;
    case "choose":
      break;
    case "overcome":
      yield* visit(node.key, node, "key", depth + 1);
      break;
    case "observe":
      for (const o of node.via ?? []) yield* visit(o, node, "via", depth + 1);
      break;
    case "transport":
      for (const o of node.via ?? []) yield* visit(o, node, "via", depth + 1);
      break;
    case "converse":
      for (const o of node.via ?? []) yield* visit(o, node, "via", depth + 1);
      break;
    case "fulfill":
      for (const o of node.via ?? []) yield* visit(o, node, "via", depth + 1);
      break;
  }
}

export interface GoalTreeMeasure {
  totalNodes: number;
  maxDepth: number;
  byType: Record<GoalNodeType, number>;
}

export function measureGoalTree(root: GoalNode): GoalTreeMeasure {
  const measure: GoalTreeMeasure = {
    totalNodes: 0,
    maxDepth: 0,
    byType: { reach: 0, collect: 0, choose: 0, overcome: 0, observe: 0, transport: 0, converse: 0, fulfill: 0 },
  };
  for (const { node, depth } of walkGoalTree(root)) {
    measure.totalNodes += 1;
    measure.byType[node.type] += 1;
    if (depth > measure.maxDepth) measure.maxDepth = depth;
  }
  return measure;
}
