// shared/goal-tree/space3d.ts
//
// Space3D — the goal-tree quest runtime embedded into the WORLD ENGINE, the
// long-reserved "Space3D" the space.ts boundary anticipates ("Space2D now,
// Space3D … later") and the world-engine's reserved `ContentKind: "goal-tree"`
// ("embed via Space"). It is the headless half of the Phase-0 merge spike:
//
//   • locomotion is the world engine's — the avatar moves by the same gaze→aim
//     "arrive" steering a sandbox world uses (engine.steerAvatar), in the SAME
//     ground coordinates, so a quest plays with the social world's 3D feel;
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
import type { WorldSpec } from "../world-engine/types.js";
import {
  createWorldState,
  steerAvatar,
  type MoveConstraint,
  type WorldState,
} from "../world-engine/engine.js";

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
    toys: [],
    multiplayer: { maxPlayers: 1, authority: "distributed" },
    content: { kind: "sandbox" },
  };

  return { spec, layout: translated };
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
  /** The world-engine sim; the avatar (PLAYER_ID) lives in here. */
  world: WorldState;
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

export interface Space3DTickResult {
  state: Space3DState;
  inputs: SpaceInput[];
}

export function createSpace3DState(
  embedding: WorldEmbedding,
  world: LogicalWorld,
): Space3DState {
  const unlocked: Record<string, true> = {};
  for (const passage of world.passages) {
    if (passage.guards.length === 0) unlocked[passage.id] = true;
  }
  const ws = createWorldState(embedding.spec, PLAYER_ID, 0);
  const a = ws.avatars[PLAYER_ID];
  return {
    world: ws,
    zoneId: zoneAt(embedding.layout, { x: a.x, y: a.y }) ?? world.startZoneId,
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
// Tick: locomotion (world engine) + proximity detection (→ SpaceInput)
// ---------------------------------------------------------------------------

export interface Space3DControl {
  /** Gaze/pointer aim in world (ground) coordinates, or null to coast to rest. */
  aim: Vec2 | null;
}

export function tickSpace3D(
  layout: Layout2D,
  state: Space3DState,
  control: Space3DControl,
  dt: number,
  config: Space3DConfig = SPACE3D_DEFAULTS,
): Space3DTickResult {
  // Locomotion is the world engine's "arrive" steering, now CONSTRAINED by the
  // quest's walls: zone interiors + currently-open doors are walkable, locked
  // doors are solid. The engine slides the avatar along them. Mutates the avatar
  // in place (engine sims own their state).
  const constraint: MoveConstraint = {
    walkable: (p, r) => walkableInLayout(layout, state.unlocked, p, r),
  };
  steerAvatar(state.world, PLAYER_ID, control.aim, dt, undefined, constraint);
  state.time += Math.max(0, dt);

  const inputs: SpaceInput[] = [];
  const a = state.world.avatars[PLAYER_ID];
  const pos: Vec2 = { x: a.x, y: a.y };

  // Detection is plain proximity now — walls already prevent the avatar from
  // getting near content in a room it hasn't opened.
  detectZoneChange(layout, state, pos, inputs);
  detectItemPickups(layout, state, pos, config, inputs);
  detectFigureTouches(layout, state, pos, config, inputs);
  detectDoorTouches(layout, state, pos, config, inputs);

  return { state, inputs };
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
