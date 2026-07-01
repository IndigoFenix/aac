// shared/goal-tree/logical-world.ts
//
// Derives the LOGICAL world from a goal tree: zones connected by (possibly
// guarded) passages, plus where items and figures are placed. This is the
// topology half of map projection — geometric embedding (actual 2D/3D
// coordinates) happens later, in the renderer-specific projector, and must
// preserve this topology. The solver certifies completability on this
// structure, so geometry can never break solvability.
//
// Construction rules ("context zone" = where the player engages a node):
//   - The root's context is the start zone.
//   - reach   → new zone; one passage context→zone carrying the via guards;
//               the marker figure stands in the new zone.
//   - collect → new zone (same passage rule). Each placement either scatters
//               its items in the collect zone, or — when guarded — gets a
//               pocket zone hanging off the collect zone. Distractors scatter
//               in the collect zone.
//   - choose  → no zone; the poser figure stands in the context zone.
//   - overcome as a via guard → sits on the passage; its key sub-tree builds
//               with context = the passage's near side, so a key is always
//               accessible without crossing its own lock.
//   - overcome as a goal (root / key chain) → obstacle figure stands in the
//               context zone; its key builds in the same context.
//
// Zone/passage ids use ":" as a separator, which cannot appear in node ids
// (schema restricts ids to [a-zA-Z0-9_]) — collisions are impossible.

import type { CollectNode, GoalNode, GoalTreeGame, OvercomeNode } from "./types.js";

export const START_ZONE_ID = "start";

export type ZoneKind = "start" | "reach" | "collect" | "pocket";

export interface ZoneSpec {
  id: string;
  kind: ZoneKind;
  /** Goal node that created this zone; null for the start zone. */
  ownerNodeId: string | null;
  /** Theme hint for projection/skinning. */
  hint?: string;
}

export interface PassageGuard {
  /** The overcome node acting as this lock. */
  overcomeNodeId: string;
  obstacleEntityId: string;
}

export interface PassageSpec {
  id: string;
  from: string;
  to: string;
  /** All guards must be cleared before the passage can be crossed. */
  guards: PassageGuard[];
}

export interface ItemPlacementSpec {
  zoneId: string;
  /** The collect node these items belong to. */
  forNodeId: string;
  /** Acceptable target entities (any mix of these satisfies the count). */
  itemEntityIds: string[];
  count: number;
}

export interface DistractorPlacementSpec {
  zoneId: string;
  forNodeId: string;
  entityIds: string[];
}

export type FigureRole = "marker" | "poser" | "obstacle";

export interface FigureSpec {
  zoneId: string;
  entityId: string;
  role: FigureRole;
  forNodeId: string;
}

export interface LogicalWorld {
  startZoneId: string;
  zones: ZoneSpec[];
  passages: PassageSpec[];
  items: ItemPlacementSpec[];
  distractors: DistractorPlacementSpec[];
  figures: FigureSpec[];
  /**
   * Where each goal node is performed: reach/collect → their own zone,
   * choose/overcome → their context zone.
   */
  sites: Record<string, string>;
}

/** Assumes a schema-valid game (see schema.ts); never throws on one. */
export function buildLogicalWorld(game: GoalTreeGame): LogicalWorld {
  const world: LogicalWorld = {
    startZoneId: START_ZONE_ID,
    zones: [{ id: START_ZONE_ID, kind: "start", ownerNodeId: null }],
    passages: [],
    items: [],
    distractors: [],
    figures: [],
    sites: {},
  };

  buildNode(world, game.root, START_ZONE_ID);
  return world;
}

function buildNode(world: LogicalWorld, node: GoalNode, contextZoneId: string): void {
  switch (node.type) {
    case "reach": {
      const zoneId = addZone(world, "reach", node.id, node.zoneHint);
      addPassage(world, contextZoneId, zoneId, buildVia(world, node.via, contextZoneId));
      world.figures.push({
        zoneId,
        entityId: node.markerEntityId,
        role: "marker",
        forNodeId: node.id,
      });
      world.sites[node.id] = zoneId;
      break;
    }
    case "collect": {
      buildCollect(world, node, contextZoneId);
      break;
    }
    case "choose": {
      world.figures.push({
        zoneId: contextZoneId,
        entityId: node.posedByEntityId,
        role: "poser",
        forNodeId: node.id,
      });
      world.sites[node.id] = contextZoneId;
      break;
    }
    case "overcome": {
      // Standalone overcome (root goal or key chain) — the obstacle stands
      // in the context zone rather than on a passage.
      world.figures.push({
        zoneId: contextZoneId,
        entityId: node.obstacleEntityId,
        role: "obstacle",
        forNodeId: node.id,
      });
      world.sites[node.id] = contextZoneId;
      buildNode(world, node.key, contextZoneId);
      break;
    }
    case "observe": {
      // Like reach: a new zone you travel to, with a "stage" figure standing in
      // it (reusing the marker role — it's a point of interest you approach).
      // The demonstration plays when the runtime sees the figure touched.
      const zoneId = addZone(world, "reach", node.id, node.zoneHint);
      addPassage(world, contextZoneId, zoneId, buildVia(world, node.via, contextZoneId));
      world.figures.push({
        zoneId,
        entityId: node.stageEntityId,
        role: "marker",
        forNodeId: node.id,
      });
      world.sites[node.id] = zoneId;
      break;
    }
    case "transport": {
      // A new zone you travel to; the carry OBJECT + destination container are
      // materialized there as real world-engine objects by the player (not
      // goal-tree figures), so no figure is placed here — just the zone.
      const zoneId = addZone(world, "reach", node.id, node.zoneHint);
      addPassage(world, contextZoneId, zoneId, buildVia(world, node.via, contextZoneId));
      world.sites[node.id] = zoneId;
      break;
    }
  }
}

function buildCollect(
  world: LogicalWorld,
  node: CollectNode,
  contextZoneId: string,
): void {
  const zoneId = addZone(world, "collect", node.id, node.zoneHint);
  addPassage(world, contextZoneId, zoneId, buildVia(world, node.via, contextZoneId));
  world.sites[node.id] = zoneId;

  const placements = node.placements ?? [{ count: node.count, via: undefined }];
  placements.forEach((placement, index) => {
    let itemZoneId = zoneId;
    if (placement.via?.length) {
      itemZoneId = addPocketZone(world, node, index);
      addPassage(world, zoneId, itemZoneId, buildVia(world, placement.via, zoneId));
    }
    world.items.push({
      zoneId: itemZoneId,
      forNodeId: node.id,
      itemEntityIds: [...node.itemEntityIds],
      count: placement.count,
    });
  });

  if (node.distractorEntityIds?.length) {
    world.distractors.push({
      zoneId,
      forNodeId: node.id,
      entityIds: [...node.distractorEntityIds],
    });
  }
}

/**
 * Registers the via obstacles' key sub-trees in the near-side zone and
 * returns the guard list for the passage they sit on. Building keys in the
 * near-side context guarantees no key is ever locked behind its own lock.
 */
function buildVia(
  world: LogicalWorld,
  via: OvercomeNode[] | undefined,
  nearZoneId: string,
): PassageGuard[] {
  const guards: PassageGuard[] = [];
  for (const overcome of via ?? []) {
    world.sites[overcome.id] = nearZoneId;
    buildNode(world, overcome.key, nearZoneId);
    guards.push({
      overcomeNodeId: overcome.id,
      obstacleEntityId: overcome.obstacleEntityId,
    });
  }
  return guards;
}

function addZone(
  world: LogicalWorld,
  kind: Exclude<ZoneKind, "start" | "pocket">,
  nodeId: string,
  hint?: string,
): string {
  const id = `zone:${nodeId}`;
  world.zones.push({ id, kind, ownerNodeId: nodeId, hint });
  return id;
}

function addPocketZone(
  world: LogicalWorld,
  node: CollectNode,
  placementIndex: number,
): string {
  const id = `pocket:${node.id}:${placementIndex}`;
  world.zones.push({ id, kind: "pocket", ownerNodeId: node.id, hint: node.zoneHint });
  return id;
}

function addPassage(
  world: LogicalWorld,
  from: string,
  to: string,
  guards: PassageGuard[],
): void {
  world.passages.push({ id: `passage:${from}->${to}`, from, to, guards });
}
