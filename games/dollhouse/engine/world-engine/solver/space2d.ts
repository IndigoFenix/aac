// shared/goal-tree/space2d.ts
//
// Headless Space2D: the deterministic top-down simulation the 2D renderer
// draws and feeds input into. Lives in shared/ on purpose — the client stays
// an input/display shell (per the AAC construction strategy), and full games
// can be auto-played in CI by ticking this sim.
//
// Two locomotion modes, chosen per STUDENT (an accessibility setting, never
// a game property):
//   - "steer":  continuous gaze steering (space-trader style). Each tick
//               receives the gaze point in world coordinates; the player
//               accelerates toward it and eases to a stop near it.
//   - "walk":   point-and-click / dwell-to-walk. The client resolves what
//               was dwelled on (figure, item, door, floor) and sets a walk
//               target; the player auto-paths through door centers.
//
// Spatial events become SpaceInput for the runtime:
//   - entering a new zone            → enter-zone
//   - proximity to an item          → pick-item (once per radius entry)
//   - proximity to a figure         → touch-figure (once per radius entry —
//     works identically in both modes, so steer mode needs no click verb)
//   - bumping/arriving at a locked door → touch-door (cooldown-limited)
// The sim applies runtime SpaceCommands (unlock-passage, collect-item) to
// keep its world in sync.

import type {
  DoorLayout,
  Layout2D,
  Rect,
  Vec2,
} from "./layout2d.js";
import { dist, rectCenter, rectContains } from "./layout2d.js";
import type { LogicalWorld } from "./logical-world.js";
import type { SpaceCommand, SpaceInput } from "./space.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Space2DConfig {
  /** Player collision radius, world units. */
  playerRadius: number;
  /** Auto-pick items within this distance. */
  pickRadius: number;
  /** Figures/doors activate within this distance. */
  touchRadius: number;
  /** Walk-mode speed, units/sec. */
  walkSpeed: number;
  /** Steer-mode acceleration, units/sec². */
  steerAccel: number;
  /** Steer-mode max speed, units/sec. */
  steerMaxSpeed: number;
  /** Steer-mode: ease to a stop inside this distance of the gaze point. */
  steerStopRadius: number;
  /** Seconds between repeated touch-door emissions for the same door. */
  doorTouchCooldown: number;
}

export const SPACE2D_DEFAULTS: Space2DConfig = {
  playerRadius: 0.35,
  pickRadius: 0.8,
  touchRadius: 1.0,
  walkSpeed: 4,
  steerAccel: 18,
  steerMaxSpeed: 5,
  steerStopRadius: 0.6,
  doorTouchCooldown: 1.5,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type WalkIntent =
  | { kind: "point" }
  | { kind: "figure"; nodeId: string }
  | { kind: "item"; instanceId: string }
  | { kind: "door"; passageId: string };

export interface WalkTarget {
  point: Vec2;
  intent: WalkIntent;
  /** Door-center waypoints to traverse before heading to `point`. */
  waypoints: Vec2[];
}

export interface Space2DState {
  pos: Vec2;
  vel: Vec2;
  zoneId: string;
  target: WalkTarget | null;
  /** Passages opened by the runtime. */
  unlocked: Record<string, true>;
  /** Items removed by the runtime (collected). */
  removed: Record<string, true>;
  /** Items currently inside pick radius (edge-triggered emission). */
  inPickRadius: Record<string, true>;
  /** Figures currently inside touch radius (edge-triggered emission). */
  inTouchRadius: Record<string, true>;
  /** Sim-time of last touch-door per passage (cooldown). */
  lastDoorTouch: Record<string, number>;
  time: number;
}

export interface Space2DTickResult {
  state: Space2DState;
  inputs: SpaceInput[];
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function createSpace2DState(
  layout: Layout2D,
  world: LogicalWorld,
): Space2DState {
  // Unguarded passages are open from the start; the runtime only ever sends
  // unlock-passage for guarded ones.
  const unlocked: Record<string, true> = {};
  for (const passage of world.passages) {
    if (passage.guards.length === 0) unlocked[passage.id] = true;
  }
  return {
    pos: { ...layout.spawn },
    vel: { x: 0, y: 0 },
    zoneId: zoneAt(layout, layout.spawn) ?? layout.zones[0]?.zoneId ?? "",
    target: null,
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

export function applySpace2DCommand(
  state: Space2DState,
  command: SpaceCommand,
): Space2DState {
  switch (command.type) {
    case "unlock-passage":
      return { ...state, unlocked: { ...state.unlocked, [command.passageId]: true } };
    case "collect-item":
      return { ...state, removed: { ...state.removed, [command.instanceId]: true } };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Walk mode: set a target (client resolved what was activated)
// ---------------------------------------------------------------------------

export function setWalkTarget(
  layout: Layout2D,
  world: LogicalWorld,
  state: Space2DState,
  point: Vec2,
  intent: WalkIntent,
): Space2DState {
  const fromZone = zoneAt(layout, state.pos);
  const toZone = zoneAt(layout, point);
  const waypoints =
    fromZone && toZone && fromZone !== toZone
      ? doorWaypoints(layout, world, fromZone, toZone)
      : [];
  return {
    ...state,
    vel: { x: 0, y: 0 },
    target: { point, intent, waypoints },
  };
}

export function clearWalkTarget(state: Space2DState): Space2DState {
  return { ...state, target: null };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface Space2DControl {
  /** Steer mode: gaze point in world coordinates (null = no gaze). Ignored
   * while a walk target is set. */
  steer?: Vec2 | null;
}

export function tickSpace2D(
  layout: Layout2D,
  state: Space2DState,
  control: Space2DControl,
  dt: number,
  config: Space2DConfig = SPACE2D_DEFAULTS,
): Space2DTickResult {
  let next: Space2DState = {
    ...state,
    pos: { ...state.pos },
    vel: { ...state.vel },
    inPickRadius: { ...state.inPickRadius },
    inTouchRadius: { ...state.inTouchRadius },
    lastDoorTouch: { ...state.lastDoorTouch },
    time: state.time + dt,
  };
  const inputs: SpaceInput[] = [];

  if (next.target) {
    moveAlongTarget(layout, next, inputs, dt, config);
  } else if (control.steer) {
    steerToward(next, control.steer, dt, config);
    slideMove(layout, next, inputs, dt, config);
  } else {
    next.vel = { x: 0, y: 0 };
  }

  detectZoneChange(layout, next, inputs);
  detectItemPickups(layout, next, inputs, config);
  detectFigureTouches(layout, next, inputs, config);

  return { state: next, inputs };
}

// ---------------------------------------------------------------------------
// Movement internals
// ---------------------------------------------------------------------------

function steerToward(
  state: Space2DState,
  gaze: Vec2,
  dt: number,
  config: Space2DConfig,
): void {
  const toGaze = { x: gaze.x - state.pos.x, y: gaze.y - state.pos.y };
  const distance = Math.hypot(toGaze.x, toGaze.y);
  if (distance < config.steerStopRadius) {
    // Ease out near the gaze point so the player can rest on a spot.
    state.vel.x *= Math.max(0, 1 - dt * 8);
    state.vel.y *= Math.max(0, 1 - dt * 8);
    return;
  }
  const dir = { x: toGaze.x / distance, y: toGaze.y / distance };
  state.vel.x += dir.x * config.steerAccel * dt;
  state.vel.y += dir.y * config.steerAccel * dt;
  const speed = Math.hypot(state.vel.x, state.vel.y);
  // Scale max speed down when close, for fine control near targets.
  const maxSpeed = Math.min(
    config.steerMaxSpeed,
    config.steerMaxSpeed * (distance / (config.steerStopRadius * 4)) + 0.5,
  );
  if (speed > maxSpeed) {
    state.vel.x = (state.vel.x / speed) * maxSpeed;
    state.vel.y = (state.vel.y / speed) * maxSpeed;
  }
}

function moveAlongTarget(
  layout: Layout2D,
  state: Space2DState,
  inputs: SpaceInput[],
  dt: number,
  config: Space2DConfig,
): void {
  const target = state.target;
  if (!target) return;

  const waypoint = target.waypoints[0] ?? target.point;
  const toWaypoint = { x: waypoint.x - state.pos.x, y: waypoint.y - state.pos.y };
  const distance = Math.hypot(toWaypoint.x, toWaypoint.y);

  const arriveRadius = arrivalRadius(target, config, target.waypoints.length > 0);
  if (distance <= arriveRadius) {
    if (target.waypoints.length > 0) {
      state.target = { ...target, waypoints: target.waypoints.slice(1) };
      return;
    }
    emitArrival(state, inputs, target, config);
    state.target = null;
    state.vel = { x: 0, y: 0 };
    return;
  }

  const step = Math.min(config.walkSpeed * dt, distance);
  state.vel = {
    x: (toWaypoint.x / distance) * config.walkSpeed,
    y: (toWaypoint.y / distance) * config.walkSpeed,
  };
  const desired = {
    x: state.pos.x + (toWaypoint.x / distance) * step,
    y: state.pos.y + (toWaypoint.y / distance) * step,
  };

  if (walkable(layout, desired, state.unlocked, config.playerRadius)) {
    state.pos = desired;
    return;
  }

  // Blocked — a locked door in the way becomes an interaction, not a wall.
  const lockedDoor = lockedDoorAt(layout, state.unlocked, desired, config.playerRadius);
  if (lockedDoor) {
    emitDoorTouch(state, inputs, lockedDoor, config);
  }
  state.target = null;
  state.vel = { x: 0, y: 0 };
}

function arrivalRadius(
  target: WalkTarget,
  config: Space2DConfig,
  isWaypoint: boolean,
): number {
  if (isWaypoint) return config.playerRadius;
  switch (target.intent.kind) {
    case "figure":
    case "door":
      return config.touchRadius;
    case "item":
      return config.pickRadius;
    case "point":
      return config.playerRadius / 2;
  }
}

function emitArrival(
  state: Space2DState,
  inputs: SpaceInput[],
  target: WalkTarget,
  config: Space2DConfig,
): void {
  switch (target.intent.kind) {
    case "door":
      emitDoorTouchById(state, inputs, target.intent.passageId, config);
      break;
    case "figure":
    case "item":
    case "point":
      // Figure touches and item pickups are proximity-driven (the arrival
      // radius brings the player inside the detection radius).
      break;
  }
}

function slideMove(
  layout: Layout2D,
  state: Space2DState,
  inputs: SpaceInput[],
  dt: number,
  config: Space2DConfig,
): void {
  const desired = {
    x: state.pos.x + state.vel.x * dt,
    y: state.pos.y + state.vel.y * dt,
  };
  if (walkable(layout, desired, state.unlocked, config.playerRadius)) {
    state.pos = desired;
    return;
  }

  const lockedDoor = lockedDoorAt(layout, state.unlocked, desired, config.playerRadius);
  if (lockedDoor) emitDoorTouch(state, inputs, lockedDoor, config);

  // Slide along whichever axis stays walkable.
  const slideX = { x: desired.x, y: state.pos.y };
  const slideY = { x: state.pos.x, y: desired.y };
  if (walkable(layout, slideX, state.unlocked, config.playerRadius)) {
    state.pos = slideX;
    state.vel.y = 0;
  } else if (walkable(layout, slideY, state.unlocked, config.playerRadius)) {
    state.pos = slideY;
    state.vel.x = 0;
  } else {
    state.vel = { x: 0, y: 0 };
  }
}

// ---------------------------------------------------------------------------
// World queries
// ---------------------------------------------------------------------------

export function zoneAt(layout: Layout2D, p: Vec2): string | null {
  for (const zone of layout.zones) {
    if (rectContains(zone.rect, p)) return zone.zoneId;
  }
  return null;
}

function walkable(
  layout: Layout2D,
  p: Vec2,
  unlocked: Record<string, true>,
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

function lockedDoorAt(
  layout: Layout2D,
  unlocked: Record<string, true>,
  p: Vec2,
  radius: number,
): DoorLayout | null {
  for (const door of layout.doors) {
    if (unlocked[door.passageId]) continue;
    if (rectContains(inflate(door.rect, radius), p)) return door;
  }
  return null;
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/**
 * Door-center waypoints for the zone path from → to (BFS over passages —
 * locked doors are traversed too: the player walks up and "tries" them,
 * which surfaces the obstacle interaction).
 */
function doorWaypoints(
  layout: Layout2D,
  world: LogicalWorld,
  fromZone: string,
  toZone: string,
): Vec2[] {
  const doorByPassage = new Map(layout.doors.map((d) => [d.passageId, d]));
  const neighbors = new Map<string, { zone: string; passageId: string }[]>();
  for (const p of world.passages) {
    (neighbors.get(p.from) ?? neighbors.set(p.from, []).get(p.from)!).push({
      zone: p.to,
      passageId: p.id,
    });
    (neighbors.get(p.to) ?? neighbors.set(p.to, []).get(p.to)!).push({
      zone: p.from,
      passageId: p.id,
    });
  }

  const cameFrom = new Map<string, { zone: string; passageId: string }>();
  const seen = new Set([fromZone]);
  let frontier = [fromZone];
  while (frontier.length && !seen.has(toZone)) {
    const next: string[] = [];
    for (const zone of frontier) {
      for (const edge of neighbors.get(zone) ?? []) {
        if (seen.has(edge.zone)) continue;
        seen.add(edge.zone);
        cameFrom.set(edge.zone, { zone, passageId: edge.passageId });
        next.push(edge.zone);
      }
    }
    frontier = next;
  }
  if (!seen.has(toZone)) return [];

  const passageIds: string[] = [];
  let cursor = toZone;
  while (cursor !== fromZone) {
    const edge = cameFrom.get(cursor)!;
    passageIds.unshift(edge.passageId);
    cursor = edge.zone;
  }
  return passageIds
    .map((id) => doorByPassage.get(id))
    .filter((d): d is DoorLayout => !!d)
    .map((d) => rectCenter(d.rect));
}

// ---------------------------------------------------------------------------
// Event detection
// ---------------------------------------------------------------------------

function detectZoneChange(
  layout: Layout2D,
  state: Space2DState,
  inputs: SpaceInput[],
): void {
  const zone = zoneAt(layout, state.pos);
  if (zone && zone !== state.zoneId) {
    state.zoneId = zone;
    inputs.push({ type: "enter-zone", zoneId: zone });
  }
}

function detectItemPickups(
  layout: Layout2D,
  state: Space2DState,
  inputs: SpaceInput[],
  config: Space2DConfig,
): void {
  for (const item of layout.items) {
    if (state.removed[item.instanceId]) continue;
    const within = dist(state.pos, item.pos) <= config.pickRadius;
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
  state: Space2DState,
  inputs: SpaceInput[],
  config: Space2DConfig,
): void {
  for (const figure of layout.figures) {
    const within = dist(state.pos, figure.pos) <= config.touchRadius;
    const wasWithin = !!state.inTouchRadius[figure.nodeId];
    if (within && !wasWithin) {
      inputs.push({ type: "touch-figure", nodeId: figure.nodeId });
    }
    if (within) state.inTouchRadius[figure.nodeId] = true;
    else delete state.inTouchRadius[figure.nodeId];
  }
}

function emitDoorTouch(
  state: Space2DState,
  inputs: SpaceInput[],
  door: DoorLayout,
  config: Space2DConfig,
): void {
  emitDoorTouchById(state, inputs, door.passageId, config);
}

function emitDoorTouchById(
  state: Space2DState,
  inputs: SpaceInput[],
  passageId: string,
  config: Space2DConfig,
): void {
  const last = state.lastDoorTouch[passageId];
  if (last !== undefined && state.time - last < config.doorTouchCooldown) return;
  state.lastDoorTouch[passageId] = state.time;
  inputs.push({ type: "touch-door", passageId });
}
