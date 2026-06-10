// shared/goal-tree/solver.ts
//
// Certifies that a goal-tree game is completable, on the logical world.
// This is the automated replacement for playtesting: a game ships only with
// a completion certificate (the plan), and the plan length doubles as a
// difficulty/duration estimate.
//
// The grammar has NO destructive effects — clearing guards only opens
// passages, collecting only accumulates, nothing is consumed or lost — so
// progress is monotone and a fixpoint iteration is both sound and complete:
// if the fixpoint doesn't complete the root, no play-through can.
//
// Completion rules:
//   reach    — its zone is reachable
//   choose   — the poser's zone is reachable (answering is always possible;
//              wrong picks retry, so reachability == completability)
//   collect  — its zone and every one of its item-placement zones reachable
//              (placement counts sum exactly to the goal count, so ALL
//              placements are needed)
//   overcome — its site is reachable AND its key goal is completed
//   passage  — crossable once every guard's overcome node is completed

import type { GoalNode, GoalNodeType, GoalTreeGame } from "./types.js";
import { measureGoalTree, walkGoalTree } from "./walk.js";
import type { LogicalWorld } from "./logical-world.js";

export type SolverStep =
  | { kind: "zone-opened"; zoneId: string; viaPassageId: string }
  | { kind: "goal-completed"; nodeId: string; nodeType: GoalNodeType; zoneId: string };

export interface SolverStats {
  zoneCount: number;
  passageCount: number;
  goalCounts: Record<GoalNodeType, number>;
  totalNodes: number;
  maxDepth: number;
  /** Steps in the certified plan (zone openings + goal completions). */
  planLength: number;
  /**
   * Estimated passage crossings to play the plan in order, measured on the
   * full zone graph ignoring guard state (guards are cleared by plan order).
   * A rough session-length signal for the generation pipeline's size knob.
   */
  estimatedTravelLegs: number;
}

export interface BlockedReason {
  nodeId?: string;
  zoneId?: string;
  reason: string;
}

export type SolverResult =
  | { solvable: true; plan: SolverStep[]; stats: SolverStats }
  | { solvable: false; blocked: BlockedReason[]; stats: SolverStats };

export type SolvedGame = Extract<SolverResult, { solvable: true }>;

export function solveGoalTreeGame(
  game: GoalTreeGame,
  world: LogicalWorld,
): SolverResult {
  const nodes = [...walkGoalTree(game.root)].map((v) => v.node);
  const itemZonesByNode = new Map<string, string[]>();
  for (const item of world.items) {
    const zones = itemZonesByNode.get(item.forNodeId) ?? [];
    zones.push(item.zoneId);
    itemZonesByNode.set(item.forNodeId, zones);
  }

  const reachable = new Set<string>([world.startZoneId]);
  const completed = new Set<string>();
  const plan: SolverStep[] = [];

  const isCompletable = (node: GoalNode): boolean => {
    const site = world.sites[node.id];
    if (!reachable.has(site)) return false;
    switch (node.type) {
      case "reach":
      case "choose":
        return true;
      case "collect":
        return (itemZonesByNode.get(node.id) ?? []).every((z) => reachable.has(z));
      case "overcome":
        return completed.has(node.key.id);
    }
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (const passage of world.passages) {
      const fromIn = reachable.has(passage.from);
      const toIn = reachable.has(passage.to);
      if (fromIn === toIn) continue;
      if (passage.guards.every((g) => completed.has(g.overcomeNodeId))) {
        const opened = fromIn ? passage.to : passage.from;
        reachable.add(opened);
        plan.push({ kind: "zone-opened", zoneId: opened, viaPassageId: passage.id });
        changed = true;
      }
    }

    for (const node of nodes) {
      if (completed.has(node.id)) continue;
      if (isCompletable(node)) {
        completed.add(node.id);
        plan.push({
          kind: "goal-completed",
          nodeId: node.id,
          nodeType: node.type,
          zoneId: world.sites[node.id],
        });
        changed = true;
      }
    }
  }

  const measure = measureGoalTree(game.root);
  const stats: SolverStats = {
    zoneCount: world.zones.length,
    passageCount: world.passages.length,
    goalCounts: measure.byType,
    totalNodes: measure.totalNodes,
    maxDepth: measure.maxDepth,
    planLength: plan.length,
    estimatedTravelLegs: estimateTravelLegs(world, plan),
  };

  if (completed.has(game.root.id)) {
    return { solvable: true, plan, stats };
  }
  return {
    solvable: false,
    blocked: explainBlocked(nodes, world, reachable, completed, itemZonesByNode),
    stats,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics for unsolvable worlds
// ---------------------------------------------------------------------------

function explainBlocked(
  nodes: GoalNode[],
  world: LogicalWorld,
  reachable: Set<string>,
  completed: Set<string>,
  itemZonesByNode: Map<string, string[]>,
): BlockedReason[] {
  const blocked: BlockedReason[] = [];

  const guardsBlockingZone = (zoneId: string): string => {
    const inbound =
      world.passages.find((p) => p.to === zoneId) ??
      world.passages.find((p) => p.from === zoneId);
    if (!inbound) return "no passage leads there";
    const pending = inbound.guards
      .filter((g) => !completed.has(g.overcomeNodeId))
      .map((g) => g.overcomeNodeId);
    return pending.length
      ? `blocked by uncleared obstacle(s): ${pending.join(", ")}`
      : "its passage's far side was never reached";
  };

  for (const node of nodes) {
    if (completed.has(node.id)) continue;
    const site = world.sites[node.id];

    if (!reachable.has(site)) {
      blocked.push({
        nodeId: node.id,
        zoneId: site,
        reason: `goal "${node.id}" (${node.type}) sits in unreachable zone "${site}" — ${guardsBlockingZone(site)}`,
      });
      continue;
    }
    if (node.type === "overcome") {
      blocked.push({
        nodeId: node.id,
        reason: `obstacle "${node.id}" cannot clear — its key goal "${node.key.id}" is incomplete`,
      });
      continue;
    }
    if (node.type === "collect") {
      const unreachableZones = (itemZonesByNode.get(node.id) ?? []).filter(
        (z) => !reachable.has(z),
      );
      blocked.push({
        nodeId: node.id,
        reason:
          `collect "${node.id}" cannot finish — item zone(s) unreachable: ` +
          unreachableZones.map((z) => `"${z}" (${guardsBlockingZone(z)})`).join(", "),
      });
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Travel estimate
// ---------------------------------------------------------------------------

/**
 * Sums BFS distances between consecutive goal sites in plan order, starting
 * from the start zone, on the undirected zone graph (guards ignored — the
 * plan clears them before they are crossed).
 */
function estimateTravelLegs(world: LogicalWorld, plan: SolverStep[]): number {
  const adjacency = new Map<string, string[]>();
  for (const zone of world.zones) adjacency.set(zone.id, []);
  for (const p of world.passages) {
    adjacency.get(p.from)?.push(p.to);
    adjacency.get(p.to)?.push(p.from);
  }

  const distance = (from: string, to: string): number => {
    if (from === to) return 0;
    const seen = new Set<string>([from]);
    let frontier = [from];
    let dist = 0;
    while (frontier.length) {
      dist += 1;
      const next: string[] = [];
      for (const zone of frontier) {
        for (const neighbor of adjacency.get(zone) ?? []) {
          if (seen.has(neighbor)) continue;
          if (neighbor === to) return dist;
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return 0; // disconnected — only happens in hand-mutated worlds
  };

  let total = 0;
  let at = world.startZoneId;
  for (const step of plan) {
    if (step.kind !== "goal-completed") continue;
    total += distance(at, step.zoneId);
    at = step.zoneId;
  }
  return total;
}
