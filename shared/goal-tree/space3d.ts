// shared/goal-tree/space3d.ts
//
// Space3D — the goal-tree quest runtime embedded into the WORLD ENGINE, the
// long-reserved "Space3D" the space.ts boundary anticipates ("Space2D now,
// Space3D … later") and the world-engine's reserved `ContentKind: "goal-tree"`
// ("embed via Space"). It is the headless half of the Phase-0 merge spike:
//
//   • locomotion is the world engine's — the avatar is driven by runWorldHost
//     (the SAME per-frame loop the social world uses), constrained by the quest
//     walls (makeWallConstraint). Space3D no longer runs its own tick; the engine
//     owns movement and Space3D only supplies the wall constraint + detection;
//   • the quest runtime is UNCHANGED — Space3D feeds it the same SpaceInput
//     (enter-zone / pick-item / touch-figure / touch-door) and applies the same
//     SpaceCommand (unlock-passage / collect-item) as Space2D. The reducer,
//     solver, and certification never learn which space drives them.
//
// Walls are REAL: the layout's rooms (zone rects + open door rects) become a
// MoveConstraint the world engine enforces during locomotion (engine.advanceAvatar
// slides the avatar along solid edges). A locked door is solid, so a room stays
// physically sealed until its passage unlocks — the avatar can't reach a marker
// in an unopened room, and the quest can't be won early. This replaces the
// reachability substitute the first spike used; detection is now plain proximity,
// because the avatar can only get near content it can physically reach.
//
// Locked doors are "tried" by approach: a solid door still lets the avatar come
// within doorTouchRadius of it (it slides up against the wall), which fires
// touch-door → the runtime clears the obstacle if its key is done → the passage
// unlocks → the door rect becomes walkable and the avatar passes through.

import type { Layout2D, Rect, Vec2 } from "./layout2d.js";
import { dist, rectCenter, rectContains } from "./layout2d.js";
import type { LogicalWorld } from "./logical-world.js";
import type { SpaceCommand, SpaceInput } from "./space.js";
import type { GoalTreeGame, TransportRelation } from "./types.js";
import { walkGoalTree } from "./walk.js";
import type { ObjectSpec, WorldSpec } from "../world-engine/types.js";
import type { MoveConstraint } from "../world-engine/engine.js";

/** The single local avatar id Space3D drives. */
export const PLAYER_ID = "player";

/** Clearance left around the layout's bounding box when sizing the manifold, so
 *  the avatar (clamped to the manifold) can stand at the field's edge cells. */
const EMBED_MARGIN = 1.5;

// ---------------------------------------------------------------------------
// Embedding: Layout2D → WorldSpec
// ---------------------------------------------------------------------------

export interface WorldEmbedding {
  /** The generated world the engine simulates the avatar in. */
  spec: WorldSpec;
  /**
   * The layout TRANSLATED into world-engine coordinates (manifold origin at
   * 0,0). Space3D detection and the 3D overlay both read this — avatar and
   * content then share one coordinate space, so they line up with no per-call
   * offset math.
   */
  layout: Layout2D;
}

function shift(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h };
}
function shiftPoint(p: Vec2, dx: number, dy: number): Vec2 {
  return { x: p.x + dx, y: p.y + dy };
}

/**
 * Build a flat WorldSpec sized to the layout's bounding box (+margin) and
 * translate the layout into it so the manifold starts at (0,0). The world is a
 * single-player sandbox manifold — the quest content rides as the Space layer
 * on top (per the reserved-seam design), NOT encoded into WorldSpec fields, so
 * no world-engine schema change is needed for the spike.
 */
export function embedLayoutInWorld(layout: Layout2D): WorldEmbedding {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const z of layout.zones) {
    minX = Math.min(minX, z.rect.x);
    minY = Math.min(minY, z.rect.y);
    maxX = Math.max(maxX, z.rect.x + z.rect.w);
    maxY = Math.max(maxY, z.rect.y + z.rect.h);
  }
  const dx = EMBED_MARGIN - minX;
  const dy = EMBED_MARGIN - minY;

  const translated: Layout2D = {
    zones: layout.zones.map((z) => ({ ...z, rect: shift(z.rect, dx, dy) })),
    doors: layout.doors.map((d) => ({ ...d, rect: shift(d.rect, dx, dy) })),
    figures: layout.figures.map((f) => ({ ...f, pos: shiftPoint(f.pos, dx, dy) })),
    items: layout.items.map((i) => ({ ...i, pos: shiftPoint(i.pos, dx, dy) })),
    spawn: shiftPoint(layout.spawn, dx, dy),
  };

  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "quest", locale: "en", theme: "quest" },
    manifold: {
      kind: "flat",
      width: maxX - minX + EMBED_MARGIN * 2,
      height: maxY - minY + EMBED_MARGIN * 2,
    },
    terrain: { kind: "flat" },
    spawns: [{ id: "spawn", x: translated.spawn.x, y: translated.spawn.y }],
    objects: [],
    multiplayer: { maxPlayers: 1, authority: "distributed" },
    content: { kind: "sandbox" },
  };

  return { spec, layout: translated };
}

// ---------------------------------------------------------------------------
// Transport puzzles: world objects placed in a transport node's zone
// ---------------------------------------------------------------------------

/** A transport puzzle's runtime handles: the carry object(s) + their destination
 *  container, and the node that completes when the TARGET lands on it. */
export interface TransportPlacement {
  nodeId: string;
  /** World id of the TARGET carryable — the one that completes the beat. */
  objectId: string;
  /** World ids of WRONG carryables (selection beats); empty for plain transport. */
  distractorObjectIds: string[];
  destId: string;
  relation?: TransportRelation;
  /** Composed glyph of the wanted item, for a selection beat — the player shows
   *  it as a bubble over the destination ("bring THIS here"). Absent for a plain
   *  single-object transport. */
  wantGlyph?: string;
}

export interface TransportObjects {
  /** World-engine objects to add to the embedded WorldSpec (carryables + container). */
  objects: ObjectSpec[];
  placements: TransportPlacement[];
}

/**
 * Materialize each `transport` node's carryable(s) and destination CONTAINER as
 * real world-engine objects in the node's (translated) zone. A selection beat
 * (the node has `distractorEntityIds`) fans the target + distractors as a row of
 * carryables; the destination shows the TARGET's icon, so "bring the matching
 * one" reads with no words. The player adds `objects` to the embedded WorldSpec
 * and watches `placements` to know when the target lands (→ place-object) or a
 * distractor lands (→ decline + carry-again).
 */
export function buildTransportObjects(
  game: GoalTreeGame,
  world: LogicalWorld,
  layout: Layout2D,
): TransportObjects {
  const entityOf = (entityId: string) => game.entities.find((e) => e.id === entityId);
  const iconOf = (entityId: string): string | undefined => entityOf(entityId)?.iconRef;

  const objects: ObjectSpec[] = [];
  const placements: TransportPlacement[] = [];
  for (const { node } of walkGoalTree(game.root)) {
    if (node.type !== "transport") continue;
    const rect = layout.zones.find((z) => z.zoneId === world.sites[node.id])?.rect;
    if (!rect) continue;

    const objectId = `obj_${node.id}`;
    const destId = `dest_${node.id}`;
    const distractorIds = (node.distractorEntityIds ?? []).map((_, i) => `${objectId}_d${i}`);

    // Carryables fanned across the lower band of the zone, well separated so each
    // can be dwell-selected on its own.
    const carry: { id: string; iconRef?: string }[] = [
      { id: objectId, iconRef: iconOf(node.objectEntityId) },
      ...(node.distractorEntityIds ?? []).map((eid, i) => ({ id: distractorIds[i]!, iconRef: iconOf(eid) })),
    ];
    const n = carry.length;
    const x0 = rect.x + 1.6;
    const span = Math.max(0, rect.w - 3.2);
    const cyCarry = rect.y + rect.h * 0.34;
    carry.forEach((c, i) => {
      const x = n === 1 ? rect.x + rect.w * 0.5 : x0 + (span * i) / (n - 1);
      objects.push({
        id: c.id,
        x,
        y: cyCarry,
        shape: "box",
        radius: 0.45,
        interactions: ["carry"],
        ...(c.iconRef ? { iconRef: c.iconRef } : {}),
      });
    });

    // Destination shows its OWN icon (a basket/recipient) — NEVER a clone of the
    // item, so a recipient never wears the item's face. For a selection beat the
    // wanted item is communicated by a glyph bubble over it (the player draws it).
    const destIcon = iconOf(node.destEntityId);
    const wantGlyph = distractorIds.length ? entityOf(node.objectEntityId)?.glyph : undefined;
    objects.push({
      id: destId,
      x: rect.x + rect.w * 0.5,
      y: rect.y + rect.h * 0.74,
      shape: "box",
      radius: 1.0,
      interactions: [],
      contains: [{ relation: node.relation ?? "on" }],
      ...(destIcon ? { iconRef: destIcon } : {}),
    });

    placements.push({
      nodeId: node.id,
      objectId,
      distractorObjectIds: distractorIds,
      destId,
      relation: node.relation,
      ...(wantGlyph ? { wantGlyph } : {}),
    });
  }
  return { objects, placements };
}

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------

export interface Space3DConfig {
  /** Auto-pick items within this distance. */
  pickRadius: number;
  /** Figures activate within this distance. */
  touchRadius: number;
  /** A locked door is "tried" when the avatar comes this close to its center. */
  doorTouchRadius: number;
  /** Seconds between repeated touch-door emissions for the same door. */
  doorTouchCooldown: number;
}

export const SPACE3D_DEFAULTS: Space3DConfig = {
  pickRadius: 0.9,
  touchRadius: 1.2,
  doorTouchRadius: 1.1,
  doorTouchCooldown: 1.5,
};

export interface Space3DState {
  /** Last zone the avatar registered as entering. */
  zoneId: string;
  /** Passages opened by the runtime (unguarded ones start open). */
  unlocked: Record<string, true>;
  /** Items removed by the runtime (collected). */
  removed: Record<string, true>;
  inPickRadius: Record<string, true>;
  inTouchRadius: Record<string, true>;
  lastDoorTouch: Record<string, number>;
  time: number;
}

export function createSpace3DState(world: LogicalWorld): Space3DState {
  const unlocked: Record<string, true> = {};
  for (const passage of world.passages) {
    if (passage.guards.length === 0) unlocked[passage.id] = true;
  }
  // The avatar spawns at layout.spawn, which is inside the start zone.
  return {
    zoneId: world.startZoneId,
    unlocked,
    removed: {},
    inPickRadius: {},
    inTouchRadius: {},
    lastDoorTouch: {},
    time: 0,
  };
}

// ---------------------------------------------------------------------------
// Commands from the runtime
// ---------------------------------------------------------------------------

export function applySpace3DCommand(
  state: Space3DState,
  command: SpaceCommand,
): Space3DState {
  switch (command.type) {
    case "unlock-passage":
      state.unlocked[command.passageId] = true;
      return state;
    case "collect-item":
      state.removed[command.instanceId] = true;
      return state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Locomotion seam: a wall constraint the host applies to engine movement
// ---------------------------------------------------------------------------

/**
 * The quest's walls as an engine MoveConstraint: zone interiors + currently-open
 * doors are walkable, locked doors solid. The `walkable` closure reads the live
 * `state.unlocked`, so a door that opens becomes passable immediately. The host
 * (runWorldHost) applies it to the avatar's locomotion — Space3D no longer runs
 * its own tick; the engine owns movement.
 */
export function makeWallConstraint(layout: Layout2D, state: Space3DState): MoveConstraint {
  return { walkable: (p, r) => walkableInLayout(layout, state.unlocked, p, r) };
}

// ---------------------------------------------------------------------------
// Detection: per-frame proximity → SpaceInput (called from the host's onFrame)
// ---------------------------------------------------------------------------

/**
 * Edge-triggered proximity detection against the avatar's CURRENT position,
 * producing the same SpaceInput the runtime consumes. Walls already keep the
 * avatar away from content in an unopened room, so this is plain proximity. `dt`
 * advances the door-cooldown clock.
 */
export function detectSpace3D(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  dt: number,
  config: Space3DConfig = SPACE3D_DEFAULTS,
): SpaceInput[] {
  state.time += Math.max(0, dt);
  const inputs: SpaceInput[] = [];
  detectZoneChange(layout, state, pos, inputs);
  detectItemPickups(layout, state, pos, config, inputs);
  detectFigureTouches(layout, state, pos, config, inputs);
  detectDoorTouches(layout, state, pos, config, inputs);
  return inputs;
}

// ---------------------------------------------------------------------------
// Walls — the walkable region the engine constraint enforces
// ---------------------------------------------------------------------------

/**
 * The walkable region: any zone interior (inset by the avatar radius so it can't
 * stand half-inside a wall) OR an OPEN door rect (the slot bridging two
 * radius-inset zones — checked without inset, exactly as Space2D does, so 2D and
 * 3D agree on what's passable). A locked door is absent from `unlocked` and so is
 * solid.
 */
export function walkableInLayout(
  layout: Layout2D,
  unlocked: Record<string, true>,
  p: Vec2,
  radius: number,
): boolean {
  for (const zone of layout.zones) {
    if (rectContains(zone.rect, p, radius)) return true;
  }
  for (const door of layout.doors) {
    if (unlocked[door.passageId] && rectContains(door.rect, p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// World queries + detection (edge-triggered, mirroring Space2D)
// ---------------------------------------------------------------------------

export function zoneAt(layout: Layout2D, p: Vec2): string | null {
  for (const zone of layout.zones) {
    if (rectContains(zone.rect, p)) return zone.zoneId;
  }
  return null;
}

function detectZoneChange(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  inputs: SpaceInput[],
): void {
  const zone = zoneAt(layout, pos);
  if (zone && zone !== state.zoneId) {
    state.zoneId = zone;
    inputs.push({ type: "enter-zone", zoneId: zone });
  }
}

function detectItemPickups(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  config: Space3DConfig,
  inputs: SpaceInput[],
): void {
  for (const item of layout.items) {
    if (state.removed[item.instanceId]) continue;
    const within = dist(pos, item.pos) <= config.pickRadius;
    const wasWithin = !!state.inPickRadius[item.instanceId];
    if (within && !wasWithin) {
      inputs.push({
        type: "pick-item",
        instanceId: item.instanceId,
        entityId: item.entityId,
      });
    }
    if (within) state.inPickRadius[item.instanceId] = true;
    else delete state.inPickRadius[item.instanceId];
  }
}

function detectFigureTouches(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  config: Space3DConfig,
  inputs: SpaceInput[],
): void {
  for (const figure of layout.figures) {
    const within = dist(pos, figure.pos) <= config.touchRadius;
    const wasWithin = !!state.inTouchRadius[figure.nodeId];
    if (within && !wasWithin) {
      inputs.push({ type: "touch-figure", nodeId: figure.nodeId });
    }
    if (within) state.inTouchRadius[figure.nodeId] = true;
    else delete state.inTouchRadius[figure.nodeId];
  }
}

function detectDoorTouches(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  config: Space3DConfig,
  inputs: SpaceInput[],
): void {
  for (const door of layout.doors) {
    if (state.unlocked[door.passageId]) continue; // open — nothing to try
    // The avatar can only get within range of a locked door from a room it has
    // physically reached (the far side is walled off), so proximity alone is the
    // correct trigger — no reachability bookkeeping needed.
    if (dist(pos, rectCenter(door.rect)) <= config.doorTouchRadius) {
      const last = state.lastDoorTouch[door.passageId];
      if (last !== undefined && state.time - last < config.doorTouchCooldown) {
        continue;
      }
      state.lastDoorTouch[door.passageId] = state.time;
      inputs.push({ type: "touch-door", passageId: door.passageId });
    }
  }
}
