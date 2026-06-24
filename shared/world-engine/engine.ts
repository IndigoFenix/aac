// shared/world-engine/engine.ts
//
// Headless, deterministic 2D world simulation driven by a WorldSpec. Lives in
// shared/ so the AAC client stays a thin input/display shell and full worlds
// can be auto-played in CI. No rendering, no transport: the engine consumes
// local input + remote deltas and produces world state + discrete events the
// transport layer broadcasts.
//
// Multiplayer authority — the "distributed" model (no server physics tick):
//   • each peer owns its OWN avatar (advanced from local input here),
//   • a toy is owned by its possessor; once released it is "free-rolled" by its
//     last possessor until it comes to rest, after which nobody simulates it,
//   • tickWorld advances ONLY the state this peer owns. Remote avatars/toys are
//     written verbatim by applyRemote*; possession changes are arbitrated by
//     the server and committed via applyPossession.
//
// For a single-peer harness / the Phase-1 "world on a call" slice, set
// config.optimisticPossession so a touch grabs a free ball locally (the request
// event is still emitted for the server to confirm/deny later).

import type { SoccerBallSpec, ToyKind, Vec2, WorldSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export interface AvatarState {
  id: string;
  x: number;
  y: number;
  /** Facing unit vector (retains last heading while stopped). */
  fx: number;
  fy: number;
  /** Velocity, world units/sec. */
  vx: number;
  vy: number;
  // --- Remote render-smoothing target (REMOTE avatars only) -----------------
  // x/y/fx/fy/vx/vy above are the SMOOTHED display values the renderer draws;
  // these t* fields are the latest values the NETWORK reported. smoothRemoteAvatars
  // dead-reckons the display toward them so motion is fluid between the ~8–15 Hz
  // position packets instead of snapping. Absent on the local avatar.
  tx?: number;
  ty?: number;
  tvx?: number;
  tvy?: number;
  tfx?: number;
  tfy?: number;
  /** Seconds since the last network packet — caps dead-reckoning so a peer whose
   *  packets stop (e.g. a backgrounded tab) freezes instead of gliding away. */
  tAge?: number;
}

export interface ToyState {
  id: string;
  kind: ToyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Participant currently controlling the toy, or null if free. */
  possessedBy: string | null;
  /** Participant responsible for simulating the toy while it rolls free; null
   *  once at rest (the server then holds it). */
  freeRollOwner: string | null;
  /** Last controller — blocked from instantly re-grabbing after a kick. */
  lastPossessor: string | null;
  /** Sim-time before which `lastPossessor` may not re-grab this toy. */
  grabCooldownUntil: number;
}

export interface WorldState {
  spec: WorldSpec;
  /** This peer's participant id (its avatar is the one tickWorld advances). */
  localId: string;
  avatars: Record<string, AvatarState>;
  toys: Record<string, ToyState>;
  time: number;
}

export interface WorldInput {
  /** Gaze/pointer aim in world coordinates, or null to coast to a stop. */
  aim: Vec2 | null;
}

export type WorldEvent =
  /** Local peer wants this free toy — the server confirms via applyPossession. */
  | { type: "possession-request"; toyId: string; participantId: string }
  /** Local peer released a toy (stop or kick); it now rolls free. */
  | { type: "possession-released"; toyId: string; participantId: string; at: number }
  /** A free-rolled toy this peer owned came to rest. */
  | { type: "toy-rest"; toyId: string };

export interface WorldTickResult {
  state: WorldState;
  events: WorldEvent[];
}

// ---------------------------------------------------------------------------
// Config (engine feel; per-toy values live in the spec)
// ---------------------------------------------------------------------------

export interface WorldEngineConfig {
  avatarRadius: number;
  /** Steer-mode acceleration toward the aim point, units/sec². */
  steerAccel: number;
  steerMaxSpeed: number;
  /** (Unused since the "arrive" rewrite — kept for config back-compat.) */
  steerStopRadius: number;
  /** Aim within this distance of the avatar is treated as "on" it: the avatar
   *  stops moving and just turns to FACE the aim. Also the margin the avatar aims
   *  to STOP SHORT of the gaze (the "arrive" target), so it decelerates and
   *  settles a hair before the point instead of sliding through it — and a
   *  generous radius makes "look at yourself to stop" forgiving for eye-gaze. */
  aimDeadRadius: number;
  /** Minimum avatar speed (units/sec) to take possession of a free ball. A
   *  stationary avatar on the ball does nothing — possession is a thing you do
   *  by moving INTO the ball, which also stops idle possession churn. */
  grabMinSpeed: number;
  /** Deceleration (units/sec²) above which a moving possessor "kicks" the ball
   *  — releasing it at the current speed instead of dropping it underfoot. */
  kickDecel: number;
  /** Seconds the kicker is blocked from re-grabbing a ball it just released. */
  grabCooldown: number;
  /** Free-roll speed (units/sec) below which a toy is considered at rest. */
  restSpeed: number;
  /** Velocity retained on a wall bounce (free-rolling toys). */
  wallRestitution: number;
  /** Max simulated step; longer real frames are clamped to keep the sim sane. */
  maxStep: number;
  /** Optimistically grab free balls on touch (single-peer / Phase-1 slice). */
  optimisticPossession: boolean;
  /** Remote-avatar position correction rate (1/sec): how fast the smoothed
   *  display position eases toward the latest network position. */
  smoothPosRate: number;
  /** Remote-avatar velocity easing rate (1/sec): how fast the smoothed velocity
   *  (used for dead-reckoning extrapolation) tracks the network velocity. */
  smoothVelRate: number;
  /** Max seconds to dead-reckon a remote avatar past its last packet before
   *  freezing the target (stops a stale/backgrounded peer gliding off). */
  maxExtrapSec: number;
}

export const WORLD_ENGINE_DEFAULTS: WorldEngineConfig = {
  avatarRadius: 0.4,
  steerAccel: 18,
  steerMaxSpeed: 5,
  steerStopRadius: 0.5,
  // Kept below the ball's touchRadius (1.2) so aiming AT the ball still lets the
  // avatar reach it (it stops this far short of the gaze, but is still within
  // grab range while decelerating).
  aimDeadRadius: 0.8,
  grabMinSpeed: 0.3,
  kickDecel: 12,
  grabCooldown: 0.5,
  restSpeed: 0.2,
  wallRestitution: 0.6,
  maxStep: 0.1,
  optimisticPossession: true,
  smoothPosRate: 12,
  smoothVelRate: 10,
  maxExtrapSec: 0.25,
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build the initial world state for one peer. The local avatar spawns at
 * `spawnAt` when given (clamped into the field — used to drop players who enter
 * together near each other), else at spawns[spawnIndex] (wrapped). Toys start at
 * their spec positions, free and at rest. Remote avatars are added later via
 * applyRemoteAvatar.
 */
export function createWorldState(
  spec: WorldSpec,
  localId: string,
  spawnIndex = 0,
  spawnAt?: Vec2,
): WorldState {
  const r = WORLD_ENGINE_DEFAULTS.avatarRadius;
  let x: number;
  let y: number;
  let facing: number;
  if (spawnAt) {
    x = Math.min(spec.manifold.width - r, Math.max(r, spawnAt.x));
    y = Math.min(spec.manifold.height - r, Math.max(r, spawnAt.y));
    facing = 0;
  } else {
    const spawn = spec.spawns[spawnIndex % spec.spawns.length];
    x = spawn.x;
    y = spawn.y;
    facing = spawn.facing ?? 0;
  }
  const avatar: AvatarState = {
    id: localId,
    x,
    y,
    fx: Math.cos(facing),
    fy: Math.sin(facing),
    vx: 0,
    vy: 0,
  };

  const toys: Record<string, ToyState> = {};
  for (const t of spec.toys) {
    toys[t.id] = {
      id: t.id,
      kind: t.kind,
      x: t.x,
      y: t.y,
      vx: 0,
      vy: 0,
      possessedBy: null,
      freeRollOwner: null,
      lastPossessor: null,
      grabCooldownUntil: 0,
    };
  }

  return { spec, localId, avatars: { [localId]: avatar }, toys, time: 0 };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Advance the simulation by `dt` seconds. Mutates and returns `state` (the
 * goal-tree sims do the same — callers treat it as owned), plus the discrete
 * events produced this step.
 */
export function tickWorld(
  state: WorldState,
  input: WorldInput,
  dt: number,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
): WorldTickResult {
  const step = Math.min(Math.max(dt, 0), config.maxStep);
  const events: WorldEvent[] = [];
  const local = state.avatars[state.localId];

  // Pre-update possessor speed feeds the hard-brake ("kick") release test.
  const prevSpeed = local ? Math.hypot(local.vx, local.vy) : 0;

  if (local && step > 0) {
    advanceAvatar(local, input.aim, state.spec, config, step);
  }
  state.time += step;

  for (const toy of Object.values(state.toys)) {
    simulateToy(toy, state, local, prevSpeed, step, config, events);
  }

  return { state, events };
}

// ---------------------------------------------------------------------------
// Avatar locomotion (steer toward the aim point; ease to a stop near it)
// ---------------------------------------------------------------------------

function advanceAvatar(
  a: AvatarState,
  aim: Vec2 | null,
  spec: WorldSpec,
  config: WorldEngineConfig,
  step: number,
): void {
  let ax = 0;
  let ay = 0;
  let faceAim: Vec2 | null = null;
  // Braking = no thrust toward a target: brake along velocity and snap to rest.
  let braking = false;

  if (aim) {
    const dx = aim.x - a.x;
    const dy = aim.y - a.y;
    const d = Math.hypot(dx, dy);
    const dirx = d > 1e-4 ? dx / d : 0;
    const diry = d > 1e-4 ? dy / d : 0;
    // Distance at which we want to be STOPPED — a hair short of the gaze.
    const dStop = d - config.aimDeadRadius;
    if (dStop <= 0) {
      // Gaze is resting ON (or just off) the avatar: don't chase it — brake to a
      // stop, but turn to face it.
      braking = true;
      const s = Math.hypot(a.vx, a.vy);
      if (s > 1e-4) {
        ax = (-a.vx / s) * config.steerAccel;
        ay = (-a.vy / s) * config.steerAccel;
      }
      if (d > 1e-4) faceAim = { x: dirx, y: diry };
    } else {
      // "Arrive" steering: pick the fastest speed from which we can still brake to
      // rest over the remaining distance at steerAccel (v = √(2·a·d)), so the
      // avatar eases down as it nears the gaze and settles a hair short instead of
      // sliding past. The clamp keeps the per-step velocity change within accel.
      const desiredSpeed = Math.min(config.steerMaxSpeed, Math.sqrt(2 * config.steerAccel * dStop));
      let cx = (dirx * desiredSpeed - a.vx) / step;
      let cy = (diry * desiredSpeed - a.vy) / step;
      const cm = Math.hypot(cx, cy);
      if (cm > config.steerAccel) {
        cx = (cx / cm) * config.steerAccel;
        cy = (cy / cm) * config.steerAccel;
      }
      ax = cx;
      ay = cy;
    }
  } else {
    // Gaze left the game window: brake along velocity (keep current facing).
    braking = true;
    const s = Math.hypot(a.vx, a.vy);
    if (s > 1e-4) {
      ax = (-a.vx / s) * config.steerAccel;
      ay = (-a.vy / s) * config.steerAccel;
    }
  }

  a.vx += ax * step;
  a.vy += ay * step;

  // Clamp to max speed.
  const s = Math.hypot(a.vx, a.vy);
  if (s > config.steerMaxSpeed) {
    a.vx = (a.vx / s) * config.steerMaxSpeed;
    a.vy = (a.vy / s) * config.steerMaxSpeed;
  }

  // When braking, snap tiny residual velocity to zero so the avatar actually
  // stops (and a possessed ball can release cleanly).
  if (braking && Math.hypot(a.vx, a.vy) < 0.05) {
    a.vx = 0;
    a.vy = 0;
  }

  a.x += a.vx * step;
  a.y += a.vy * step;
  clampToManifold(a, spec, config.avatarRadius);

  // Facing: toward the aim when stopped on top of it; else follows velocity
  // while moving; else retained.
  if (faceAim) {
    a.fx = faceAim.x;
    a.fy = faceAim.y;
  } else {
    const moving = Math.hypot(a.vx, a.vy);
    if (moving > 1e-3) {
      a.fx = a.vx / moving;
      a.fy = a.vy / moving;
    }
  }
}

// ---------------------------------------------------------------------------
// Toy simulation — soccer-ball possession-dribble
// ---------------------------------------------------------------------------

function simulateToy(
  toy: ToyState,
  state: WorldState,
  local: AvatarState | undefined,
  prevPossessorSpeed: number,
  step: number,
  config: WorldEngineConfig,
  events: WorldEvent[],
): void {
  const spec = toySpecFor(state.spec, toy.id);

  // 1. Acquisition: a free ball the local avatar is MOVING into (and isn't on
  //    cooldown for) may be grabbed. The request is always emitted; the local
  //    optimistic grab is what makes single-peer play feel instant.
  const localSpeed = local ? Math.hypot(local.vx, local.vy) : 0;
  if (
    local &&
    toy.possessedBy === null &&
    localSpeed >= config.grabMinSpeed &&
    canGrab(toy, local, spec, state.time)
  ) {
    events.push({ type: "possession-request", toyId: toy.id, participantId: local.id });
    if (config.optimisticPossession) {
      toy.possessedBy = local.id;
      toy.freeRollOwner = null;
      toy.vx = 0;
      toy.vy = 0;
    }
  }

  // 2. Simulate only what THIS peer owns.
  if (toy.possessedBy === state.localId && local) {
    dribbleOrRelease(toy, local, prevPossessorSpeed, step, state.time, spec, config, events);
  } else if (toy.possessedBy === null && toy.freeRollOwner === state.localId) {
    freeRoll(toy, state.spec, spec, config, step, events);
  }
  // Otherwise the toy is owned by a remote peer (or resting under server
  // ownership) — applyRemoteToy / applyPossession update it, not the tick.
}

function dribbleOrRelease(
  toy: ToyState,
  possessor: AvatarState,
  prevSpeed: number,
  step: number,
  now: number,
  spec: SoccerBallSpec,
  config: WorldEngineConfig,
  events: WorldEvent[],
): void {
  const speed = Math.hypot(possessor.vx, possessor.vy);

  // Two release triggers:
  //   • stop — possessor slowed below the ball's releaseSpeed (drops at feet),
  //   • kick — possessor braked hard while still moving (ball keeps the speed).
  const stopped = speed < spec.releaseSpeed;
  const decel = step > 0 ? (prevSpeed - speed) / step : 0;
  const kicked = !stopped && decel > config.kickDecel;

  if (stopped || kicked) {
    // Ball leaves with the possessor's current velocity: a hard-braked kick
    // keeps real speed; a gentle stop leaves it nearly still.
    toy.vx = possessor.vx;
    toy.vy = possessor.vy;
    toy.possessedBy = null;
    toy.freeRollOwner = possessor.id;
    toy.lastPossessor = possessor.id;
    toy.grabCooldownUntil = now + config.grabCooldown;
    events.push({
      type: "possession-released",
      toyId: toy.id,
      participantId: possessor.id,
      at: now,
    });
    return;
  }

  // Carry the ball one dribbleDistance ahead of the possessor along its
  // facing, moving with it.
  toy.x = possessor.x + possessor.fx * spec.dribbleDistance;
  toy.y = possessor.y + possessor.fy * spec.dribbleDistance;
  toy.vx = possessor.vx;
  toy.vy = possessor.vy;
}

function freeRoll(
  toy: ToyState,
  world: WorldSpec,
  spec: SoccerBallSpec,
  config: WorldEngineConfig,
  step: number,
  events: WorldEvent[],
): void {
  // Exponential per-second friction decay.
  const decay = Math.pow(spec.friction, step);
  toy.vx *= decay;
  toy.vy *= decay;

  toy.x += toy.vx * step;
  toy.y += toy.vy * step;
  bounceOffWalls(toy, world, spec.radius, config.wallRestitution);

  if (Math.hypot(toy.vx, toy.vy) < config.restSpeed) {
    toy.vx = 0;
    toy.vy = 0;
    toy.freeRollOwner = null; // server now holds it at rest
    events.push({ type: "toy-rest", toyId: toy.id });
  }
}

// ---------------------------------------------------------------------------
// Remote / authority application (called by the transport + server layer)
// ---------------------------------------------------------------------------

/**
 * Write a remote peer's avatar from a network packet. The reported values become
 * the SMOOTHING TARGET (t*); the displayed x/y/fx/fy are advanced toward it by
 * smoothRemoteAvatars each render frame, so motion stays fluid between packets.
 * On first sight the display snaps to the reported pose.
 */
export function applyRemoteAvatar(state: WorldState, avatar: AvatarState): void {
  if (avatar.id === state.localId) return; // never let the network move us
  const cur = state.avatars[avatar.id];
  if (!cur) {
    state.avatars[avatar.id] = {
      id: avatar.id,
      x: avatar.x, y: avatar.y,
      fx: avatar.fx, fy: avatar.fy,
      vx: avatar.vx, vy: avatar.vy,
      tx: avatar.x, ty: avatar.y,
      tvx: avatar.vx, tvy: avatar.vy,
      tfx: avatar.fx, tfy: avatar.fy,
      tAge: 0,
    };
  } else {
    cur.tx = avatar.x; cur.ty = avatar.y;
    cur.tvx = avatar.vx; cur.tvy = avatar.vy;
    cur.tfx = avatar.fx; cur.tfy = avatar.fy;
    cur.tAge = 0;
  }
}

/**
 * Advance every REMOTE avatar's displayed pose toward its network target,
 * dead-reckoning by velocity so it keeps gliding between the (~8–15 Hz) position
 * packets and eases onto each correction instead of snapping. Render-only — the
 * deterministic sim (tickWorld) never calls this; the canvas does, once a frame.
 */
export function smoothRemoteAvatars(
  state: WorldState,
  dt: number,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
): void {
  if (dt <= 0) return;
  const posK = 1 - Math.exp(-config.smoothPosRate * dt);
  const velK = 1 - Math.exp(-config.smoothVelRate * dt);
  for (const a of Object.values(state.avatars)) {
    if (a.id === state.localId || a.tx === undefined || a.ty === undefined) continue;
    // Dead-reckon the TARGET forward by its last known velocity, so it keeps
    // advancing between packets (each packet resets it via applyRemoteAvatar);
    // this is what lets the display glide continuously instead of stepping. Stop
    // once the packets dry up, so a stale peer freezes rather than gliding away.
    a.tAge = (a.tAge ?? 0) + dt;
    if (a.tAge < config.maxExtrapSec) {
      a.tx += (a.tvx ?? 0) * dt;
      a.ty += (a.tvy ?? 0) * dt;
    }
    // Track the network velocity, glide the display forward with it…
    a.vx += ((a.tvx ?? 0) - a.vx) * velK;
    a.vy += ((a.tvy ?? 0) - a.vy) * velK;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    // …and ease onto the (moving) target, smoothing out each correction.
    a.x += (a.tx - a.x) * posK;
    a.y += (a.ty - a.y) * posK;
    // Ease facing toward the target heading and renormalize.
    a.fx += ((a.tfx ?? a.fx) - a.fx) * posK;
    a.fy += ((a.tfy ?? a.fy) - a.fy) * posK;
    const m = Math.hypot(a.fx, a.fy);
    if (m > 1e-4) { a.fx /= m; a.fy /= m; }
  }
}

/** Remove a peer who left the room. */
export function removeAvatar(state: WorldState, id: string): void {
  if (id === state.localId) return;
  delete state.avatars[id];
}

/** Write a toy's position from the peer that currently owns it. */
export function applyRemoteToy(
  state: WorldState,
  toyId: string,
  patch: Partial<Pick<ToyState, "x" | "y" | "vx" | "vy">>,
): void {
  const toy = state.toys[toyId];
  if (!toy) return;
  // Ignore remote position while WE own the toy — our sim is authoritative for it.
  if (toy.possessedBy === state.localId || toy.freeRollOwner === state.localId) return;
  Object.assign(toy, patch);
}

/**
 * Commit a server possession decision. participantId = grantee, or null to
 * free the toy. This is the authoritative source once a real server arbiter
 * exists; until then the optimistic local grab stands in for it.
 */
export function applyPossession(
  state: WorldState,
  toyId: string,
  participantId: string | null,
  at: number,
  grabCooldown = WORLD_ENGINE_DEFAULTS.grabCooldown,
): void {
  const toy = state.toys[toyId];
  if (!toy) return;
  if (participantId === null) {
    if (toy.possessedBy !== null) {
      toy.lastPossessor = toy.possessedBy;
      toy.grabCooldownUntil = at + grabCooldown;
    }
    toy.possessedBy = null;
  } else {
    toy.possessedBy = participantId;
    toy.freeRollOwner = null;
    toy.vx = 0;
    toy.vy = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canGrab(
  toy: ToyState,
  avatar: AvatarState,
  spec: SoccerBallSpec,
  now: number,
): boolean {
  if (now < toy.grabCooldownUntil && toy.lastPossessor === avatar.id) return false;
  const d = Math.hypot(toy.x - avatar.x, toy.y - avatar.y);
  return d <= spec.touchRadius;
}

function clampToManifold(a: AvatarState, spec: WorldSpec, radius: number): void {
  const { width, height } = spec.manifold;
  if (a.x < radius) { a.x = radius; if (a.vx < 0) a.vx = 0; }
  if (a.x > width - radius) { a.x = width - radius; if (a.vx > 0) a.vx = 0; }
  if (a.y < radius) { a.y = radius; if (a.vy < 0) a.vy = 0; }
  if (a.y > height - radius) { a.y = height - radius; if (a.vy > 0) a.vy = 0; }
}

function bounceOffWalls(
  toy: ToyState,
  spec: WorldSpec,
  radius: number,
  restitution: number,
): void {
  const { width, height } = spec.manifold;
  if (toy.x < radius) { toy.x = radius; toy.vx = Math.abs(toy.vx) * restitution; }
  if (toy.x > width - radius) { toy.x = width - radius; toy.vx = -Math.abs(toy.vx) * restitution; }
  if (toy.y < radius) { toy.y = radius; toy.vy = Math.abs(toy.vy) * restitution; }
  if (toy.y > height - radius) { toy.y = height - radius; toy.vy = -Math.abs(toy.vy) * restitution; }
}

function toySpecFor(spec: WorldSpec, toyId: string): SoccerBallSpec {
  // createWorldState only ever builds toys present in the spec, so this holds.
  return spec.toys.find((x) => x.id === toyId) as SoccerBallSpec;
}
