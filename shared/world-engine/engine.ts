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

import type {
  BuildingSpec,
  ContainRelation,
  DoorSpec,
  ObjectInteraction,
  ObjectShape,
  ObjectSpec,
  PushSpec,
  Rect,
  StairSpec,
  StructureSpec,
  Vec2,
  WorldSpec,
} from "./types.js";
import { PASSTHROUGH_FIXTURES } from "./types.js";

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
  /** Storey level: 0 = ground floor; fractional while on stairs (a ramp between
   *  integer floors). The renderer lifts the body by floor × floor-height; the
   *  structural constraint only enforces walls on the avatar's (rounded) floor. */
  floor: number;
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
  /** Can this body OPEN doors (and containers)? The player and hands-having
   *  creatures can; a graspless one (a pet) cannot — it may only pass through /
   *  take from things ANOTHER opened. Set by the game layer; ABSENT ⇒ true (the
   *  player and every ordinary body). Read by `tickDoors`. */
  canOpen?: boolean;
  /** A one-shot GESTURE for a creature-bodied avatar (e.g. an NPC pointing the
   *  way). Display-only — `tickWorld` never reads it. The renderer's creature
   *  factory fires it once per new `id` (converting the world target into the
   *  body's local frame) and animates it; set by the game layer. */
  gesture?: AvatarGesture;
  /** A sustained ACTIVITY the body is performing (asleep on a bed, eating at
   *  the table, sitting, playing). Display-only like `gesture` — `tickWorld`
   *  never reads it. The game layer SETS it while the activity is underway and
   *  clears it when it ends; the renderer's model factory poses the body (a 2D
   *  renderer may ignore it entirely). */
  activity?: AvatarActivity;
  /** OUTFIT override — an outfit-preset index (creatures/clothing.ts
   *  `outfitPresetFor`) the body is WEARING now. Display-only like `activity`
   *  (`tickWorld` never reads it): the creature model factory watches it and
   *  re-dresses the body live when it changes (the visible change of clothes).
   *  Absent = the factory's own `outfitFor` default. */
  wearing?: number;
  /** RENDER ALTITUDE — metres the body floats ABOVE its ground stand height.
   *  Display-only (`tickWorld` never reads it; the sim stays plan-view 2D). The
   *  FLIGHT channel: while a `can_fly` avatar is airborne, the game layer drives
   *  the plan `(x, y)` + this altitude from the reused space flight-sim, so the
   *  renderer lifts the body (and the follow camera) off the ground without a
   *  scene swap. 0 / absent = grounded. */
  altitude?: number;
}

/** What a body is DOING at its station — the species-agnostic activity set the
 *  creature rig knows how to pose (see creatures/animation.ts BodyActivity). */
export type AvatarActivityKind = "sleep" | "eat" | "sit" | "play";

/** A sustained, display-only activity on an avatar. Unlike a gesture it has no
 *  one-shot id: it stays set for as long as the activity runs and the renderer
 *  blends the pose in/out as it appears/clears. */
export interface AvatarActivity {
  kind: AvatarActivityKind;
  /** The world object (a FIXTURE) the activity centers on — a sleeper's BED,
   *  so the view can lay the body ON it (bodies can't stand on solid fixtures,
   *  so the sim keeps the sleeper standing beside it). Unknown/absent id ⇒ the
   *  body performs the activity where it stands (a doze in place). */
  objId?: string;
}

/** A one-shot gesture request on an avatar: a deictic POINT, or the carry
 *  reaches — PICKUP (reach → grasp → lift into the carry pose, which the body
 *  HOLDS until a putdown; the model stays full-fidelity while carrying) and
 *  PUTDOWN (lower → release). The animator no-ops a pickup mid-action and a
 *  putdown when nothing is carried, so hosts may fire these unconditionally. */
export interface AvatarGesture {
  kind: "point" | "pickup" | "putdown";
  /** WORLD point to gesture at (the factory converts to the body-local frame):
   *  what's pointed at, or the spot the object is taken from / lowered to. */
  targetX: number;
  targetY: number;
  /** How long to hold the point, seconds (point only). */
  holdS: number;
  /** Apparent size of the picked object, meters (pickup only) — a wide object
   *  takes a two-handed bracket, and a graspless species mouths it. */
  sizeM?: number;
  /** Monotonic id — the renderer performs the gesture once per NEW id. */
  id: number;
}

/**
 * A display-only speech bubble in the world — the ONE caption channel, used the
 * same way for a remote player's utterance and an in-game character's line.
 * `tickWorld` never reads it (display-only), so it can't perturb physics. Add via
 * showWorldBubble(); the renderer floats it over the anchor and fades it out at
 * `at` + `ttl`.
 */
export interface WorldBubble {
  /** Where the bubble floats: tracking an AVATAR each frame, or a fixed world
   *  POINT (a non-avatar character, object, or caption). */
  anchor:
    | { kind: "avatar"; id: string }
    | { kind: "point"; x: number; y: number };
  /** The spoken / captioned line. */
  text: string;
  /** Composed AAC glyph string for a symbol rendering (absent = plain text). */
  glyph?: string;
  /** LOCAL sim-time (state.time) when shown — the renderer fades it on its own
   *  clock, never the speaker's wall clock (which differs per machine). */
  at: number;
  /** Total seconds visible before it fully fades out. */
  ttl: number;
  /** Visual variant: "speech" (default — solid border, triangle tail) or
   *  "thought" (dashed border, circle tail) for something WISHED rather than
   *  said — the Request-c inference scaffold. */
  style?: "speech" | "thought";
}

/** Default bubble lifetime (sim-seconds) when a caller doesn't specify one.
 *  Matches speech-bubble.ts BUBBLE_TTL_SECONDS (kept here so the headless engine
 *  needn't import the canvas module). */
export const BUBBLE_DEFAULT_TTL = 6;

export interface ObjectState {
  id: string;
  shape: ObjectShape;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Storey the object rests on (a carried object inherits its carrier's floor). */
  floor: number;
  // --- push (possession-dribble) — only meaningful for "push" objects ---------
  /** Participant currently controlling (dribbling) the object, or null if free. */
  possessedBy: string | null;
  /** Participant responsible for simulating the object while it rolls free; null
   *  once at rest (the server then holds it). */
  freeRollOwner: string | null;
  /** Last controller — blocked from instantly re-grabbing after a kick. */
  lastPossessor: string | null;
  /** Sim-time before which `lastPossessor` may not re-grab this object. */
  grabCooldownUntil: number;
  // --- carry — only meaningful for "carry" objects ----------------------------
  /** Avatar currently carrying this object (it follows them), or null. */
  carriedBy: string | null;
  // --- containment ------------------------------------------------------------
  /** When placed on/in/under a container, where it rests; null when free. */
  containedIn: { objectId: string; relation: ContainRelation } | null;
  // --- fixtures ----------------------------------------------------------------
  /** Eased lid swing of an `openable` fixture, 0 (shut) → 1 (open). The lid now
   *  follows `heldOpen` (an EXPLICIT open state a creature sets when it accesses
   *  the container), not proximity — so an opened lid STAYS open until closed. */
  open: number;
  /** Is this fixture explicitly OPEN? Set by the game layer when a creature
   *  opens the container (to reach its contents) and cleared when it's done —
   *  the lid eases toward this, and access checks read it. Absent ⇒ shut. */
  heldOpen?: boolean;
}

/**
 * Live state of a `door` structure. `open` is the eased swing amount, 0 (closed
 * & solid) → 1 (open & passable); `locked` blocks it from ever opening until
 * cleared (by unlockDoor or its key object). Derived locally each tick from
 * avatar positions, so it carries no network identity of its own.
 */
export interface DoorState {
  id: string;
  open: number;
  locked: boolean;
  /** Is the door explicitly HELD open? A body that CAN open doors sets this as
   *  it comes to pass through (and it eases open); it stays open while any body
   *  lingers and shuts once all leave — so a graspless creature can follow
   *  through, and slip through a door another left open, but can never open a
   *  shut one itself. `pinned` (an "open the door" command) keeps it open with
   *  nobody near. Absent ⇒ shut. */
  held?: boolean;
  pinned?: boolean;
}

/**
 * Ground-height sampler for an IRREGULAR site: world/sim (x, y) in, ground
 * height in METERS out. MUST be pure and deterministic (peers sample it
 * independently from the same seed; heights are never networked). The sim
 * stays plan-view 2D — no z coordinate — but the sampler's GRADIENT shapes
 * movement ("2.5D"): between SLOPE_SLOW_ANGLE and SLOPE_WALL_ANGLE the stride
 * scales linearly toward 0, and at/above the wall angle terrain blocks like a
 * wall (same gate + stuck-escape failsafe as structures). Flat ground (no
 * sampler, or a constant one) is byte-identical to the sampler-free sim.
 */
export type GroundSampler = (x: number, y: number) => number;

/**
 * Water-coverage sampler: true where (x, y) is water. Same contract as
 * GroundSampler (pure, deterministic, never networked). Water is a MECHANICS
 * field only — impassable to walkers/NPC bodies via the movement gate (with
 * the same stuck-escape failsafe); rendering it is the host's ground-mesh
 * concern. Absent ⇒ dry everywhere.
 */
export type WaterSampler = (x: number, y: number) => boolean;

/**
 * Movement-DRAG sampler (construction v1): a stride scale for heavy going —
 * 1 = free ground, 0.5 = wading. Composes with the slope cost exactly like
 * it: velocity keeps the INTENT (steering/facing/arrive read it), only the
 * ground covered shrinks. The canonical producer is storage-room clutter
 * (unplaced furniture slows a room without ever BLOCKING it — pathing,
 * routing and the service floods stay untouched); mud/snow later. Absent ⇒
 * ×1 exact, keeping every existing world byte-identical. Applies to every
 * body advanceAvatar moves — the player and the NPCs alike.
 */
export type DragSampler = (x: number, y: number) => number;

export interface WorldState {
  spec: WorldSpec;
  /** This peer's participant id — THE SPARK. Network identity only: who owns
   *  what, and which inbound packets to ignore ("never let the network move
   *  us"). It is NOT "the player's body": a spark is not an avatar.
   *
   *  Kept distinct from `drivenId` on purpose. These two were ONE field, which
   *  silently worked only because the spark's default body shares its id — and
   *  that conflation is what forced possession to DESTROY a creature and
   *  re-skin the player walker, rather than simply drive the creature's body. */
  localId: string;
  /** THE BODY THIS SPARK DRIVES — the avatar `tickWorld` steers from the gaze.
   *  Defaults to `localId` (the spark's own body); claiming a creature points it
   *  at that creature's body instead, and releasing points it back. The claimed
   *  creature is never removed: its controller is merely suspended, so its
   *  personality/needs/job resume when the spark leaves (see the party model). */
  drivenId: string;
  avatars: Record<string, AvatarState>;
  objects: Record<string, ObjectState>;
  /** Live door swing/lock state, keyed by door id (only `door` structures). */
  doors: Record<string, DoorState>;
  /** Display-only speech bubbles, keyed by a caller-chosen id (re-using a key
   *  replaces that bubble). The single caption channel — see showWorldBubble. */
  bubbles: Record<string, WorldBubble>;
  /** Ground-height sampler (see GroundSampler). Its gradient shapes movement
   *  (slope slow/wall) as well as vertical placement. Absent ⇒ flat 0. */
  ground?: GroundSampler;
  /** Water sampler (see WaterSampler) — impassable to walkers. Absent ⇒ dry. */
  water?: WaterSampler;
  /** Movement-drag sampler (see DragSampler) — stride scale for heavy
   *  going (storage clutter). Absent ⇒ free ground everywhere. */
  drag?: DragSampler;
  time: number;
}

export interface WorldInput {
  /** Gaze/pointer aim in world coordinates, or null to coast to a stop. */
  aim: Vec2 | null;
}

/**
 * Optional collision constraint applied to a locally-advanced avatar each step.
 * The engine integrates velocity to a PROPOSED position, then asks the
 * constraint whether that point is occupiable; if not, it slides along whichever
 * axis stays walkable (zeroing the blocked component). Pure geometry supplied by
 * the caller — the engine stays ignorant of WHAT blocks movement (an embedded
 * goal-tree quest's room walls today; terrain/solids later), exactly as
 * SceneOverlay keeps it ignorant of what's drawn. No constraint → open-field
 * motion (the default; sandbox/social worlds pass none, so they're unaffected).
 */
export interface MoveConstraint {
  /** True if an avatar of `radius` may occupy world point `p`. */
  walkable(p: Vec2, radius: number): boolean;
}

export type WorldEvent =
  /** Local peer wants this free object — the server confirms via applyPossession. */
  | { type: "possession-request"; objectId: string; participantId: string }
  /** Local peer released an object (stop or kick); it now rolls free. */
  | { type: "possession-released"; objectId: string; participantId: string; at: number }
  /** A free-rolled object this peer owned came to rest. */
  | { type: "object-rest"; objectId: string };

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
  /** Approach gain (1/sec): desired speed is `gain × distance-to-stop`, capped at
   *  `steerMaxSpeed`. So the creature runs flat out only while the gaze is further
   *  than `steerMaxSpeed / gain` ahead, and eases down proportionally inside that.
   *  Distance-proportional ON PURPOSE: the old √(2·a·d) arrive law only tapered
   *  inside `maxSpeed²/(2·accel)` ≈ 0.7 m, so the walker cruised at full speed
   *  until it was basically on top of the aim, then stopped dead. */
  steerApproachGain: number;
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
  /** Door swing ease rate (1/sec): how fast a door opens/closes toward its target. */
  doorSwingRate: number;
  /** A door is passable once its `open` reaches this (its leaf has swung clear). */
  doorPassThreshold: number;
  /** Default avatar→door-center distance that triggers opening, when a DoorSpec
   *  omits `openRadius`. Added to half the door's width at runtime. */
  doorOpenMargin: number;
}

export const WORLD_ENGINE_DEFAULTS: WorldEngineConfig = {
  avatarRadius: 0.4,
  steerAccel: 18,
  steerMaxSpeed: 5,
  steerStopRadius: 0.5,
  // Full speed once the gaze is > 5/2 = 2.5 m ahead; proportional inside that.
  steerApproachGain: 2,
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
  doorSwingRate: 6,
  doorPassThreshold: 0.5,
  doorOpenMargin: 1.4,
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
  ground?: GroundSampler,
  water?: WaterSampler,
): WorldState {
  const r = WORLD_ENGINE_DEFAULTS.avatarRadius;
  let x: number;
  let y: number;
  let facing: number;
  if (spawnAt) {
    if (spec.manifold.bounded === false) {
      // Unbounded (planet-mounted): a handoff may legitimately land outside
      // the content rect — the planet has ground there.
      x = spawnAt.x;
      y = spawnAt.y;
    } else {
      x = Math.min(spec.manifold.width - r, Math.max(r, spawnAt.x));
      y = Math.min(spec.manifold.height - r, Math.max(r, spawnAt.y));
    }
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
    floor: 0,
  };

  const objects: Record<string, ObjectState> = {};
  for (const o of spec.objects) objects[o.id] = initialObjectState(o);

  const doors: Record<string, DoorState> = {};
  for (const s of spec.structures ?? []) {
    if (s.kind === "door") {
      doors[s.id] = { id: s.id, open: 0, locked: s.locked ?? false };
    }
  }

  return {
    spec,
    localId,
    drivenId: localId, // a fresh spark drives its own body until it claims one
    avatars: { [localId]: avatar },
    objects,
    doors,
    bubbles: {},
    ...(ground ? { ground } : {}),
    ...(water ? { water } : {}),
    time: 0,
  };
}

/** Ground height under a world point — 0 when the world has no sampler (flat).
 *  THE single read point for state.ground, shared by renderers and tests. */
export function groundHeightAt(state: WorldState, x: number, y: number): number {
  return state.ground?.(x, y) ?? 0;
}

// --- Terrain movement costs (the "2.5D" walking rules) ----------------------
// Threshold parity with the flight sim's walker (flight-config PLAYER:
// walkSlopeSlowAngle 0.55, walkSlopeWallAngle 0.95, groundNormalEpsilon 1.5) —
// mirrored, NOT imported: the town engine stays flight-free.
/** Slope angle (rad, ≈31°) above which the stride starts shrinking. */
const SLOPE_SLOW_ANGLE = 0.55;
/** Slope angle (rad, ≈54°) at/above which terrain blocks like a wall. */
const SLOPE_WALL_ANGLE = 0.95;
/** Central finite-difference epsilon (m) for the ground gradient. */
const SLOPE_SAMPLE_EPSILON = 1.5;

/** Slope angle (rad) of the ground at (x, y) — direction-blind (gradient
 *  magnitude), so up- and downhill cost the same. */
function slopeAngleAt(ground: GroundSampler, x: number, y: number): number {
  const e = SLOPE_SAMPLE_EPSILON;
  const gx = (ground(x + e, y) - ground(x - e, y)) / (2 * e);
  const gy = (ground(x, y + e) - ground(x, y - e)) / (2 * e);
  return Math.atan(Math.hypot(gx, gy));
}

/** Stride multiplier for the ground under (x, y): 1 at/below SLOPE_SLOW_ANGLE,
 *  linear → 0 approaching SLOPE_WALL_ANGLE. Over-steep ground returns 1: the
 *  gate's failsafe lets a body ALREADY on a cliff walk out, so the scale must
 *  not trap it (mirrors the stuck-in-geometry escape). */
function slopeStrideScale(ground: GroundSampler, x: number, y: number): number {
  const ang = slopeAngleAt(ground, x, y);
  if (ang <= SLOPE_SLOW_ANGLE || ang >= SLOPE_WALL_ANGLE) return 1;
  return 1 - (ang - SLOPE_SLOW_ANGLE) / (SLOPE_WALL_ANGLE - SLOPE_SLOW_ANGLE);
}

/** True if the terrain fields let a walker stand at `p`: not water, not
 *  wall-steep. Point test (terrain has no meaningful body radius). Shared by
 *  the movement gate and hosts' waypoint/detour oracles. */
export function terrainWalkable(state: WorldState, p: Vec2): boolean {
  if (state.water?.(p.x, p.y)) return false;
  if (state.ground && slopeAngleAt(state.ground, p.x, p.y) >= SLOPE_WALL_ANGLE) return false;
  return true;
}

/** The terrain fields as a MoveConstraint, or undefined when the world has
 *  neither (flat dry worlds keep the sampler-free code path). */
function makeTerrainConstraint(state: WorldState): MoveConstraint | undefined {
  if (!state.ground && !state.water) return undefined;
  return { walkable: (p) => terrainWalkable(state, p) };
}

/**
 * Add a LOCALLY-OWNED avatar to the state (an NPC this peer hosts). Unlike a
 * remote avatar it carries no smoothing target (t* fields), so smoothRemoteAvatars
 * leaves it alone — the host advances it directly via steerAvatar each frame, just
 * like the local player's avatar. Returns the created avatar.
 */
export function addLocalAvatar(
  state: WorldState,
  id: string,
  x: number,
  y: number,
  facing = 0,
): AvatarState {
  const a: AvatarState = {
    id,
    x,
    y,
    fx: Math.cos(facing),
    fy: Math.sin(facing),
    vx: 0,
    vy: 0,
    floor: 0,
  };
  state.avatars[id] = a;
  return a;
}

/**
 * Advance ONE locally-owned avatar by `dt` toward `aim` (or coast to a stop when
 * null), using the same locomotion as the local player. This is the injection
 * point for AI-driven NPCs: a controller computes the aim, the engine moves the
 * body — so an NPC can never move in a way a player couldn't. Toy possession is
 * intentionally NOT run for NPCs (that path is keyed to the local player); NPCs
 * walk and turn, they don't dribble. No-ops if the id isn't present.
 */
export function steerAvatar(
  state: WorldState,
  id: string,
  aim: Vec2 | null,
  dt: number,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
  constraint?: MoveConstraint,
): void {
  const a = state.avatars[id];
  if (!a) return;
  const step = Math.min(Math.max(dt, 0), config.maxStep);
  // NPC bodies respect walls/doors too — compose the engine's structural
  // constraint (scoped to the NPC's storey) with any external one, then re-derive
  // its floor so an NPC can use stairs as well.
  if (step > 0) {
    advanceAvatar(a, aim, state, config, step, effectiveConstraint(state, constraint, config, a.floor));
    updateAvatarFloor(state, a);
  }
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
  constraint?: MoveConstraint,
): WorldTickResult {
  const step = Math.min(Math.max(dt, 0), config.maxStep);
  const events: WorldEvent[] = [];
  const local = state.avatars[state.drivenId];

  // Pre-update possessor speed feeds the hard-brake ("kick") release test.
  const prevSpeed = local ? Math.hypot(local.vx, local.vy) : 0;

  // Doors ease open/shut from the avatars' CURRENT positions, then locomotion
  // runs under the engine's structural constraint (walls + closed doors) composed
  // with any external one — so a door that just swung open is passable this step.
  tickDoors(state, step, config);
  tickFixtures(state, step, config);
  if (local && step > 0) {
    // Collide against the avatar's CURRENT storey, move, then re-derive its floor
    // (a stairway it stepped onto ramps it up/down).
    advanceAvatar(local, input.aim, state, config, step, effectiveConstraint(state, constraint, config, local.floor));
    updateAvatarFloor(state, local);
  }
  state.time += step;

  for (const obj of Object.values(state.objects)) {
    simulateObject(obj, state, local, prevSpeed, step, config, events);
  }

  return { state, events };
}

// ---------------------------------------------------------------------------
// Avatar locomotion (steer toward the aim point; ease to a stop near it)
// ---------------------------------------------------------------------------

/** Minimum speed (world units/sec) at which the avatar re-aims its FACING from
 *  velocity. Below it, facing is held — so brake/gaze jitter near a stop can't flip
 *  the heading (and a carried item's placement) back and forth. */
const FACE_SPEED_MIN = 0.15;
/** Max facing turn rate (rad/sec). Caps how fast the heading can rotate toward its
 *  desired direction, so no single frame can produce a 180° flip (≈0.5s for a full
 *  reversal at 12 rad/s — still snappy for real turns). */
const FACE_TURN_RATE = 12;

function advanceAvatar(
  a: AvatarState,
  aim: Vec2 | null,
  state: WorldState,
  config: WorldEngineConfig,
  step: number,
  constraint?: MoveConstraint,
): void {
  const spec = state.spec;
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
        // Clamp the brake so it can't push velocity PAST zero (which would flip its
        // sign — and thus facing — every frame near a stop; see FACE_SPEED_MIN).
        const brake = step > 0 ? Math.min(config.steerAccel, s / step) : config.steerAccel;
        ax = (-a.vx / s) * brake;
        ay = (-a.vy / s) * brake;
      }
      if (d > 1e-4) faceAim = { x: dirx, y: diry };
    } else {
      // Speed is a CONSTANT FUNCTION OF DISTANCE: `gain × dStop`, capped at
      // steerMaxSpeed. Far gaze → flat out; the last few metres are a smooth
      // proportional ease onto the aim rather than a cruise-then-stop.
      const desiredSpeed = Math.min(config.steerMaxSpeed, config.steerApproachGain * dStop);
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
      // Clamp so braking lands exactly on zero rather than overshooting into a
      // sign-flip (the source of the per-frame 180° facing flip near a stop).
      const brake = step > 0 ? Math.min(config.steerAccel, s / step) : config.steerAccel;
      ax = (-a.vx / s) * brake;
      ay = (-a.vy / s) * brake;
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

  // Terrain slope cost: the stride (positional step) shrinks on steep ground —
  // a hill is work. Velocity keeps the INTENT (steering/facing/arrive read it);
  // only the ground covered shrinks. Symmetric v1: the scale is direction-blind
  // (gradient magnitude), so downhill costs the same as uphill. `× 1` on flat
  // or sampler-free ground is exact, keeping flat worlds byte-identical.
  let stride = state.ground ? step * slopeStrideScale(state.ground, a.x, a.y) : step;
  // Movement drag (construction v1) — clutter/heavy ground shrinks the
  // stride the same way slope does. Clamped so a bad sampler can neither
  // freeze a body (min 0.15) nor speed one up (max 1).
  if (state.drag) stride *= Math.min(1, Math.max(0.15, state.drag(a.x, a.y)));

  // Proposed step, then (optionally) constrained: if the target cell is solid,
  // slide along whichever axis stays walkable and zero the blocked component, so
  // the avatar grazes walls instead of sticking or tunnelling. Mirrors the
  // Space2D slide; lifted here so any constrained world (a goal-tree quest's
  // rooms) gets it without re-implementing locomotion.
  const nx = a.x + a.vx * stride;
  const ny = a.y + a.vy * stride;
  if (!constraint) {
    a.x = nx;
    a.y = ny;
  } else {
    const r = config.avatarRadius;
    if (constraint.walkable({ x: nx, y: ny }, r)) {
      a.x = nx;
      a.y = ny;
    } else if (!constraint.walkable({ x: a.x, y: a.y }, r)) {
      // FAILSAFE: the avatar is ALREADY inside geometry (a spawn landed
      // in a wall, a streamed structure materialized over a body, a spec
      // put furniture on the start point). An invalid position must
      // never be a prison — the constraint gates entry into solids FROM
      // VALID SPACE only, so a stuck body moves freely and walks out
      // (a thin wall resolves within a step or two, after which the
      // normal gate takes over again).
      a.x = nx;
      a.y = ny;
    } else if (constraint.walkable({ x: nx, y: a.y }, r)) {
      a.x = nx;
      a.vy = 0;
    } else if (constraint.walkable({ x: a.x, y: ny }, r)) {
      a.y = ny;
      a.vx = 0;
    } else {
      a.vx = 0;
      a.vy = 0;
    }
  }
  clampToManifold(a, spec, config.avatarRadius);

  // Facing: DESIRED heading = toward the aim when parked on it, else velocity while
  // genuinely MOVING (speed-gated so a near-stationary avatar ignores brake/gaze
  // jitter), else keep current. Then TURN toward it at a capped angular rate. The
  // cap is the real safeguard: a physical avatar can't spin 180° in one frame, so a
  // jittery target (a gaze resting on/near the avatar, whose direction flips frame
  // to frame) can only nudge the heading, never flip it — which is what made a held
  // item (positioned at carrier.f·CARRY_HOLD) snap front↔back every frame.
  let tfx = a.fx;
  let tfy = a.fy;
  if (faceAim) {
    tfx = faceAim.x;
    tfy = faceAim.y;
  } else {
    const moving = Math.hypot(a.vx, a.vy);
    if (moving > FACE_SPEED_MIN) {
      tfx = a.vx / moving;
      tfy = a.vy / moving;
    }
  }
  const curAng = Math.atan2(a.fy, a.fx);
  const tgtAng = Math.atan2(tfy, tfx);
  let dAng = Math.atan2(Math.sin(tgtAng - curAng), Math.cos(tgtAng - curAng));
  const maxTurn = FACE_TURN_RATE * step;
  if (dAng > maxTurn) dAng = maxTurn;
  else if (dAng < -maxTurn) dAng = -maxTurn;
  const nAng = curAng + dAng;
  a.fx = Math.cos(nAng);
  a.fy = Math.sin(nAng);
}

// ---------------------------------------------------------------------------
// Object simulation — carried / contained / push (possession-dribble)
// ---------------------------------------------------------------------------

/** Distance ahead of a carrier a carried object is held. Exported so the host can
 *  steer the carrier to stop this far SHORT of a drop point, so the held object
 *  ends up OVER the point rather than on top of the avatar. */
export const CARRY_HOLD = 1.0;

function simulateObject(
  obj: ObjectState,
  state: WorldState,
  local: AvatarState | undefined,
  prevPossessorSpeed: number,
  step: number,
  config: WorldEngineConfig,
  events: WorldEvent[],
): void {
  const spec = objectSpecFor(state.spec, obj.id);

  // Carried: held a step ahead of the carrier, no physics.
  if (obj.carriedBy) {
    const carrier = state.avatars[obj.carriedBy];
    if (carrier) {
      obj.x = carrier.x + carrier.fx * CARRY_HOLD;
      obj.y = carrier.y + carrier.fy * CARRY_HOLD;
      obj.floor = carrier.floor;
    }
    obj.vx = 0;
    obj.vy = 0;
    return;
  }

  // Contained: snap to its container's position (relation = render placement).
  if (obj.containedIn) {
    const container = state.objects[obj.containedIn.objectId];
    if (container) {
      obj.x = container.x;
      obj.y = container.y;
      obj.floor = container.floor;
    }
    obj.vx = 0;
    obj.vy = 0;
    return;
  }

  // Push (possession-dribble) — only for objects that allow it.
  const push = spec.push;
  if (!spec.interactions.includes("push") || !push) return;

  // 1. Acquisition: a free object the local avatar is MOVING into (and isn't on
  //    cooldown for) may be grabbed. The request is always emitted; the local
  //    optimistic grab is what makes single-peer play feel instant.
  const localSpeed = local ? Math.hypot(local.vx, local.vy) : 0;
  if (
    local &&
    obj.possessedBy === null &&
    localSpeed >= config.grabMinSpeed &&
    canGrab(obj, local, push.touchRadius, state.time)
  ) {
    events.push({ type: "possession-request", objectId: obj.id, participantId: local.id });
    if (config.optimisticPossession) {
      obj.possessedBy = local.id;
      obj.freeRollOwner = null;
      obj.vx = 0;
      obj.vy = 0;
    }
  }

  // 2. Simulate only what THIS peer owns. Keyed to the DRIVEN BODY, not the
  //    spark: `possessedBy`/`freeRollOwner` are stamped with the possessing
  //    AVATAR's id (`local.id` / `possessor.id`), so a spark driving a claimed
  //    creature must test against that body or its toy would go unsimulated.
  if (obj.possessedBy === state.drivenId && local) {
    dribbleOrRelease(obj, local, prevPossessorSpeed, step, state.time, push, config, events);
  } else if (obj.possessedBy === null && obj.freeRollOwner === state.drivenId) {
    freeRoll(obj, state.spec, push, spec.radius, config, step, events);
  }
  // Otherwise the object is owned by a remote peer (or resting under server
  // ownership) — applyRemoteObject / applyPossession update it, not the tick.
}

function dribbleOrRelease(
  obj: ObjectState,
  possessor: AvatarState,
  prevSpeed: number,
  step: number,
  now: number,
  push: PushSpec,
  config: WorldEngineConfig,
  events: WorldEvent[],
): void {
  const speed = Math.hypot(possessor.vx, possessor.vy);

  // Two release triggers:
  //   • stop — possessor slowed below releaseSpeed (drops at feet),
  //   • kick — possessor braked hard while still moving (object keeps the speed).
  const stopped = speed < push.releaseSpeed;
  const decel = step > 0 ? (prevSpeed - speed) / step : 0;
  const kicked = !stopped && decel > config.kickDecel;

  if (stopped || kicked) {
    // It leaves with the possessor's current velocity: a hard-braked kick keeps
    // real speed; a gentle stop leaves it nearly still.
    obj.vx = possessor.vx;
    obj.vy = possessor.vy;
    obj.possessedBy = null;
    obj.freeRollOwner = possessor.id;
    obj.lastPossessor = possessor.id;
    obj.grabCooldownUntil = now + config.grabCooldown;
    events.push({
      type: "possession-released",
      objectId: obj.id,
      participantId: possessor.id,
      at: now,
    });
    return;
  }

  // Carry it one dribbleDistance ahead of the possessor along its facing.
  obj.x = possessor.x + possessor.fx * push.dribbleDistance;
  obj.y = possessor.y + possessor.fy * push.dribbleDistance;
  obj.vx = possessor.vx;
  obj.vy = possessor.vy;
}

function freeRoll(
  obj: ObjectState,
  world: WorldSpec,
  push: PushSpec,
  radius: number,
  config: WorldEngineConfig,
  step: number,
  events: WorldEvent[],
): void {
  // Exponential per-second friction decay.
  const decay = Math.pow(push.friction, step);
  obj.vx *= decay;
  obj.vy *= decay;

  obj.x += obj.vx * step;
  obj.y += obj.vy * step;
  bounceOffWalls(obj, world, radius, config.wallRestitution);

  if (Math.hypot(obj.vx, obj.vy) < config.restSpeed) {
    obj.vx = 0;
    obj.vy = 0;
    obj.freeRollOwner = null; // server now holds it at rest
    events.push({ type: "object-rest", objectId: obj.id });
  }
}

// ---------------------------------------------------------------------------
// Carry + containment — explicit verbs a game layer triggers (e.g. on dwell)
// ---------------------------------------------------------------------------

/** Pick up a carryable object (it then follows `by`). False if it can't be
 *  carried or is already held. Clears any push/containment it was in. */
export function carryObject(state: WorldState, objectId: string, by: string): boolean {
  const obj = state.objects[objectId];
  if (!obj || obj.carriedBy) return false;
  if (!objectSpecFor(state.spec, objectId).interactions.includes("carry")) return false;
  obj.possessedBy = null;
  obj.freeRollOwner = null;
  obj.containedIn = null;
  obj.carriedBy = by;
  obj.vx = 0;
  obj.vy = 0;
  return true;
}

/** Put a carried object down at a world point (free on the ground). */
export function dropObject(state: WorldState, objectId: string, x: number, y: number): void {
  const obj = state.objects[objectId];
  if (!obj) return;
  obj.carriedBy = null;
  obj.containedIn = null;
  obj.x = x;
  obj.y = y;
  obj.vx = 0;
  obj.vy = 0;
}

/** Place an object on/in/under a container, if it offers that relation and has
 *  spare capacity there. False otherwise (caller can fall back to dropObject). */
export function placeInContainer(
  state: WorldState,
  objectId: string,
  containerId: string,
  relation: ContainRelation,
): boolean {
  if (objectId === containerId) return false;
  const obj = state.objects[objectId];
  const container = state.objects[containerId];
  if (!obj || !container) return false;
  const slot = objectSpecFor(state.spec, containerId).contains?.find((s) => s.relation === relation);
  if (!slot) return false;
  const used = Object.values(state.objects).filter(
    (o) => o.containedIn?.objectId === containerId && o.containedIn.relation === relation,
  ).length;
  if (used >= (slot.capacity ?? 1)) return false;
  obj.possessedBy = null;
  obj.freeRollOwner = null;
  obj.carriedBy = null;
  obj.containedIn = { objectId: containerId, relation };
  return true;
}

/** Whether the spec allows `interaction` on object `id`. */
export function objectAllows(spec: WorldSpec, id: string, interaction: ObjectInteraction): boolean {
  return spec.objects.find((o) => o.id === id)?.interactions.includes(interaction) ?? false;
}

/** The container object whose footprint covers `point` (excluding `exclude`), or
 *  null. Box footprint = a square of ±radius; sphere = within radius. */
export function containerAt(state: WorldState, point: Vec2, exclude?: string): ObjectState | null {
  for (const obj of Object.values(state.objects)) {
    if (obj.id === exclude) continue;
    const spec = state.spec.objects.find((o) => o.id === obj.id);
    if (!spec?.contains?.length) continue;
    const r = spec.radius;
    const inside =
      obj.shape === "box"
        ? Math.abs(point.x - obj.x) <= r && Math.abs(point.y - obj.y) <= r
        : Math.hypot(point.x - obj.x, point.y - obj.y) <= r;
    if (inside) return obj;
  }
  return null;
}

/** Put a carried object down at `point`: into the container under that point (the
 *  first relation it offers with spare room), else free on the ground. */
export function placeCarriedObject(state: WorldState, objectId: string, point: Vec2): void {
  const container = containerAt(state, point, objectId);
  if (container) {
    const slots = state.spec.objects.find((o) => o.id === container.id)?.contains ?? [];
    for (const slot of slots) {
      if (placeInContainer(state, objectId, container.id, slot.relation)) return;
    }
  }
  dropObject(state, objectId, point.x, point.y);
}

// ---------------------------------------------------------------------------
// Structures — engine-owned collision (walls + doors)
// ---------------------------------------------------------------------------

/** Shortest distance from point `p` to the segment a→b (a capsule's centerline).
 *  The wall/door collision test compares this to thickness/2 + the avatar radius. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The distance at which an avatar opens a door — its spec's `openRadius`, else
 *  half the door's width plus a margin (so it triggers a bit before you arrive). */
function doorOpenRadius(s: DoorSpec, config: WorldEngineConfig): number {
  if (s.openRadius !== undefined) return s.openRadius;
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) / 2 + config.doorOpenMargin;
}

/**
 * True if an avatar of `radius` on storey `floor` may stand at `p` given the
 * spec's structures: a wall (always) and a closed door (open < doorPassThreshold)
 * block within thickness/2 + radius of their centerline. A structure with a
 * `floor` set only blocks an avatar on that (rounded) storey; one without blocks
 * on every storey. Stairs are never solid. No structures ⇒ always true.
 */
export function structuresWalkable(
  state: WorldState,
  p: Vec2,
  radius: number,
  floor = 0,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
): boolean {
  const structures = state.spec.structures;
  if (!structures) return true;
  const onFloor = Math.round(floor);
  for (const s of structures) {
    if (s.kind === "stairs") continue; // walkable — it changes your floor, not blocks
    if (s.floor !== undefined && s.floor !== onFloor) continue; // a different storey's wall
    if (s.kind === "wall") {
      if (pointSegmentDistance(p, s.a, s.b) < s.thickness / 2 + radius) return false;
    } else {
      const open = state.doors[s.id]?.open ?? 0;
      if (open < config.doorPassThreshold && pointSegmentDistance(p, s.a, s.b) < s.thickness / 2 + radius) {
        return false;
      }
    }
  }
  return true;
}

/** The spec's structures as a MoveConstraint for an avatar on `floor` (live —
 *  reads door state each call), or undefined when the world has none. */
export function makeStructureConstraint(
  state: WorldState,
  floor = 0,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
): MoveConstraint | undefined {
  if (!state.spec.structures?.length) return undefined;
  return { walkable: (p, r) => structuresWalkable(state, p, r, floor, config) };
}

/** Combine constraints into one that requires ALL to agree (a point is walkable
 *  iff every constraint says so). Undefined inputs are dropped; returns undefined
 *  if none remain (open-field motion). */
export function combineConstraints(
  ...cs: (MoveConstraint | undefined)[]
): MoveConstraint | undefined {
  const list = cs.filter((c): c is MoveConstraint => !!c);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return { walkable: (p, r) => list.every((c) => c.walkable(p, r)) };
}

/** The constraint locomotion actually moves under: the engine's structural one
 *  (scoped to the moving avatar's storey) composed with whatever the caller (a
 *  goal-tree quest, terrain) supplied. */
function effectiveConstraint(
  state: WorldState,
  external: MoveConstraint | undefined,
  config: WorldEngineConfig,
  floor = 0,
): MoveConstraint | undefined {
  return combineConstraints(
    external,
    makeStructureConstraint(state, floor, config),
    makeFixtureConstraint(state, floor),
    makeTerrainConstraint(state),
  );
}

// ---------------------------------------------------------------------------
// Floors — stairs ramp the avatar's storey level
// ---------------------------------------------------------------------------

function rectContainsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/** The fractional floor an avatar at (x,y) is on if it's standing on a stairway
 *  (interpolated along the stair's ascent axis), else null. When stairwells stack
 *  (multi-storey buildings put each flight in the same footprint), pick the flight
 *  whose floor span brackets the avatar's CURRENT storey, so going 1→2 takes the
 *  1→2 flight, not the 0→1 one underneath it. */
function avatarFloorOnStairs(state: WorldState, x: number, y: number, currentFloor: number): number | null {
  const here = (state.spec.structures ?? []).filter(
    (s): s is StairSpec => s.kind === "stairs" && rectContainsPoint(s.rect, x, y),
  );
  if (!here.length) return null;
  const cur = Math.round(currentFloor);
  const s =
    here.find((f) => Math.min(f.fromFloor, f.toFloor) <= cur && cur <= Math.max(f.fromFloor, f.toFloor)) ?? here[0];
  let p: number;
  switch (s.axis) {
    case "+x": p = (x - s.rect.x) / s.rect.w; break;
    case "-x": p = 1 - (x - s.rect.x) / s.rect.w; break;
    case "+y": p = (y - s.rect.y) / s.rect.h; break;
    default: p = 1 - (y - s.rect.y) / s.rect.h; break; // "-y"
  }
  p = p < 0 ? 0 : p > 1 ? 1 : p;
  return s.fromFloor + (s.toFloor - s.fromFloor) * p;
}

/** Set the avatar's storey from its position: a fractional ramp while on a
 *  stairway, else snapped to the integer floor it last reached (a landing). Runs
 *  each tick after locomotion, for the local player and hosted NPCs alike. */
export function updateAvatarFloor(state: WorldState, avatar: AvatarState): void {
  const onStair = avatarFloorOnStairs(state, avatar.x, avatar.y, avatar.floor);
  avatar.floor = onStair !== null ? onStair : Math.round(avatar.floor);
}

// ---------------------------------------------------------------------------
// Buildings — sugar that lowers into perimeter wall/door/stairs structures
// ---------------------------------------------------------------------------

/** Walls + a door for one perimeter edge from P→Q, with `gaps` (doorways measured
 *  along the edge) cut out as door leaves and the spans between them as walls. */
function edgeStructures(
  bid: string,
  edge: string,
  P: Vec2,
  Q: Vec2,
  gaps: { offset: number; width: number; locked?: boolean }[],
  thickness: number,
  color?: string,
): StructureSpec[] {
  const L = Math.hypot(Q.x - P.x, Q.y - P.y);
  const dx = (Q.x - P.x) / L;
  const dy = (Q.y - P.y) / L;
  const at = (s: number): Vec2 => ({ x: P.x + dx * s, y: P.y + dy * s });
  const tint = color ? { color } : {};
  const out: StructureSpec[] = [];
  let cursor = 0;
  let wi = 0;
  let di = 0;
  for (const g of [...gaps].sort((a, b) => a.offset - b.offset)) {
    const gs = Math.max(0, Math.min(L, g.offset - g.width / 2));
    const ge = Math.max(0, Math.min(L, g.offset + g.width / 2));
    if (gs - cursor > 1e-3) out.push({ kind: "wall", id: `${bid}_${edge}_w${wi++}`, a: at(cursor), b: at(gs), thickness, ...tint });
    // The door carries the building color too — it tints the LINTEL the
    // renderer raises above the leaf, so the doorway wall matches its house.
    out.push({ kind: "door", id: `${bid}_${edge}_d${di++}`, a: at(gs), b: at(ge), thickness, ...(g.locked ? { locked: true } : {}), ...tint });
    cursor = ge;
  }
  if (L - cursor > 1e-3) out.push({ kind: "wall", id: `${bid}_${edge}_w${wi++}`, a: at(cursor), b: at(L), thickness, ...tint });
  return out;
}

/** Lower a building into its collision structures: four perimeter edges (with
 *  doorways cut to doors) and, when multi-storey, one stairway per floor gap. The
 *  perimeter is full-height (no `floor` ⇒ blocks every storey); the floors/roof
 *  are render-only (see the renderer). */
export function buildingStructures(b: BuildingSpec): StructureSpec[] {
  const { x, y, w, h } = b.footprint;
  const t = b.wallThickness;
  const NW: Vec2 = { x, y };
  const NE: Vec2 = { x: x + w, y };
  const SW: Vec2 = { x, y: y + h };
  const SE: Vec2 = { x: x + w, y: y + h };
  const byEdge: Record<string, { offset: number; width: number; locked?: boolean }[]> = {
    north: [], south: [], east: [], west: [],
  };
  for (const d of b.doorways ?? []) byEdge[d.edge].push(d);
  const out: StructureSpec[] = [
    ...edgeStructures(b.id, "north", NW, NE, byEdge.north, t, b.color),
    ...edgeStructures(b.id, "south", SW, SE, byEdge.south, t, b.color),
    ...edgeStructures(b.id, "west", NW, SW, byEdge.west, t, b.color),
    ...edgeStructures(b.id, "east", NE, SE, byEdge.east, t, b.color),
  ];
  if ((b.stairs ?? b.floors > 1) && b.floors > 1) {
    const sw = 2;
    const sh = Math.min(4, Math.max(2, h - 2 * t - 1));
    for (let f = 0; f < b.floors - 1; f++) {
      out.push({
        kind: "stairs",
        id: `${b.id}_stair${f}`,
        rect: { x: x + t + 0.5 + f * (sw + 0.5), y: y + t + 0.5, w: sw, h: sh },
        fromFloor: f,
        toFloor: f + 1,
        axis: "+y",
      });
    }
  }
  return out;
}

/**
 * Replace the world's structure set at runtime — the STRUCTURE-STREAMING seam.
 * A large world can't hold every wall in its spec; a streamer swaps in the
 * structures around the player as they travel. Collision, door auto-open, and
 * rendering all read `state.spec.structures` live, so the swap takes effect
 * immediately. Door states are PRESERVED for ids that persist (a door the
 * player left open stays open), created closed for new doors, and dropped with
 * removed ones. Local-only: peers stream their own copy from the same seed.
 */
export function setWorldStructures(state: WorldState, structures: StructureSpec[]): void {
  state.spec = { ...state.spec, structures };
  const doors: Record<string, DoorState> = {};
  for (const s of structures) {
    if (s.kind === "door") {
      doors[s.id] = state.doors[s.id] ?? { id: s.id, open: 0, locked: s.locked ?? false };
    }
  }
  state.doors = doors;
}

/**
 * Replace the world's STREAMED buildings: registers the building volumes
 * (so `buildingAt` works — roofs, floor slabs, the see-inside fade and
 * the indoor-avatar cull all key on them) AND lowers them into their
 * wall/door/stairs structures in one move. Streaming hosts (towns) call
 * this instead of `setWorldStructures` — flattened walls alone lose the
 * building identity, which is exactly a roofless, cull-less house.
 */
function initialObjectState(o: ObjectSpec): ObjectState {
  return {
    id: o.id,
    shape: o.shape,
    x: o.x,
    y: o.y,
    vx: 0,
    vy: 0,
    floor: 0,
    possessedBy: null,
    freeRollOwner: null,
    lastPossessor: null,
    grabCooldownUntil: 0,
    carriedBy: null,
    containedIn: null,
    open: 0,
  };
}

/** Add a STREAMED object at runtime (furniture arriving with its house).
 *  No-op if the id already exists. The spec's object list is REPLACED
 *  (renderers key removal sweeps on the array identity). */
export function addWorldObject(state: WorldState, spec: ObjectSpec): boolean {
  if (state.objects[spec.id]) return false;
  state.spec = { ...state.spec, objects: [...state.spec.objects, spec] };
  state.objects[spec.id] = initialObjectState(spec);
  return true;
}

/** Remove a streamed object. Whatever it contained is set free where it
 *  stands (nothing vanishes inside a despawning cupboard). */
export function removeWorldObject(state: WorldState, id: string): boolean {
  if (!state.objects[id]) return false;
  for (const o of Object.values(state.objects)) {
    if (o.containedIn?.objectId === id) o.containedIn = null;
  }
  state.spec = { ...state.spec, objects: state.spec.objects.filter((o) => o.id !== id) };
  delete state.objects[id];
  return true;
}

/** Fixtures are SOLID: a square footprint of the object's radius, on its
 *  floor. Composed into the effective constraint beside the structures.
 *  Pass-through kinds (a chair — see PASSTHROUGH_FIXTURES) are skipped:
 *  they stand where bodies must be able to stand. Exported so PLANNING
 *  predicates (the host's detour/waypoint logic) can see the same solids
 *  locomotion collides with — a blind planner slides along tables forever. */
export function fixturesWalkable(state: WorldState, p: Vec2, radius: number, floor = 0): boolean {
  for (const f of state.spec.objects) {
    if (!f.fixture || PASSTHROUGH_FIXTURES.has(f.fixture)) continue;
    const o = state.objects[f.id];
    if (!o || o.floor !== floor) continue;
    if (Math.abs(p.x - o.x) < f.radius + radius && Math.abs(p.y - o.y) < f.radius + radius) return false;
  }
  return true;
}

function makeFixtureConstraint(state: WorldState, floor: number): MoveConstraint | undefined {
  if (!state.spec.objects.some((o) => o.fixture && !PASSTHROUGH_FIXTURES.has(o.fixture))) return undefined;
  return { walkable: (p, r) => fixturesWalkable(state, p, r, floor) };
}

/** Ease every `openable` fixture's lid toward its EXPLICIT open state
 *  (`heldOpen`) — a creature opens the container to reach its contents and the
 *  lid stays open until closed, rather than swinging on mere proximity. */
function tickFixtures(state: WorldState, step: number, config: WorldEngineConfig): void {
  for (const spec of state.spec.objects) {
    if (!spec.fixture || !spec.openable) continue;
    const o = state.objects[spec.id];
    if (!o) continue;
    const target = o.heldOpen ? 1 : 0;
    o.open += (target - o.open) * (1 - Math.exp(-config.doorSwingRate * step));
    if (Math.abs(target - o.open) < 0.01) o.open = target;
  }
}

export function setWorldBuildings(state: WorldState, buildings: BuildingSpec[]): void {
  state.spec = { ...state.spec, buildings };
  setWorldStructures(state, buildings.flatMap(buildingStructures));
}

/** Lower every building in the spec into perimeter structures, appended to any
 *  hand-authored ones. Idempotent only if called once — certifyWorldSpec runs it
 *  after validation, so the engine always sees a ready spec. */
export function expandWorldBuildings(spec: WorldSpec): WorldSpec {
  if (!spec.buildings?.length) return spec;
  const generated: StructureSpec[] = [];
  for (const b of spec.buildings) generated.push(...buildingStructures(b));
  return { ...spec, structures: [...(spec.structures ?? []), ...generated] };
}

/** True if (x,y) is within a building's footprint. */
export function insideBuilding(b: BuildingSpec, x: number, y: number): boolean {
  const { x: bx, y: by, w, h } = b.footprint;
  return x >= bx && x <= bx + w && y >= by && y <= by + h;
}

/** Spatial index over a buildings array — buildingAt is called per body and
 *  per door EVERY FRAME (indoor cull, door connectivity, roof visibility),
 *  and a linear scan over a whole town's staged rooms was a measurable slice
 *  of the frame. Keyed by ARRAY IDENTITY (WeakMap): setWorldBuildings and
 *  every other writer replaces the array wholesale, never mutates in place,
 *  so a cached grid can never go stale. */
const BUILDING_GRID_CELL = 32;
const buildingGridCache = new WeakMap<BuildingSpec[], Map<string, BuildingSpec[]>>();
function buildingGridOf(buildings: BuildingSpec[]): Map<string, BuildingSpec[]> {
  let grid = buildingGridCache.get(buildings);
  if (grid) return grid;
  grid = new Map();
  for (const b of buildings) {
    const { x, y, w, h } = b.footprint;
    const cx0 = Math.floor(x / BUILDING_GRID_CELL);
    const cx1 = Math.floor((x + w) / BUILDING_GRID_CELL);
    const cy0 = Math.floor(y / BUILDING_GRID_CELL);
    const cy1 = Math.floor((y + h) / BUILDING_GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = `${cx},${cy}`;
        const cell = grid.get(key);
        if (cell) cell.push(b);
        else grid.set(key, [b]);
      }
    }
  }
  buildingGridCache.set(buildings, grid);
  return grid;
}

/** The building whose footprint contains (x,y), or null — used by the renderer to
 *  decide when to fade the floors above an occupant. */
export function buildingAt(state: WorldState, x: number, y: number): BuildingSpec | null {
  const buildings = state.spec.buildings;
  if (!buildings?.length) return null;
  // Tiny sets: the scan beats the hash + key allocation.
  if (buildings.length <= 12) {
    for (const b of buildings) if (insideBuilding(b, x, y)) return b;
    return null;
  }
  const cell = buildingGridOf(buildings).get(
    `${Math.floor(x / BUILDING_GRID_CELL)},${Math.floor(y / BUILDING_GRID_CELL)}`,
  );
  if (cell) for (const b of cell) if (insideBuilding(b, x, y)) return b;
  return null;
}

/** How near a viewer a doorway must be for it to reveal the space beyond — the
 *  "player is nearby" clause. Beyond this, an open door across the map doesn't
 *  pull its room into view. */
export const VISIBILITY_REVEAL_RADIUS = 9;

/** The "open ground" node in the door-connectivity graph — a doorway's exterior
 *  side, distinct from any building id. */
const OUTDOORS = " outdoors";

/**
 * Undirected graph of building interiors joined by the doors `accept` admits.
 * Each admitted door links the two building ids just inside its faces (OUTDOORS
 * for an exterior side), sampled a hair past the wall along its normal.
 */
function doorConnectivity(
  state: WorldState,
  accept: (door: DoorState, mid: { x: number; y: number }) => boolean,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const s of state.spec.structures ?? []) {
    if (s.kind !== "door") continue;
    const door = state.doors[s.id];
    if (!door) continue;
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    if (!accept(door, mid)) continue;
    let nx = -(s.b.y - s.a.y);
    let ny = s.b.x - s.a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const eps = s.thickness / 2 + 0.3;
    const sideA = buildingAt(state, mid.x + nx * eps, mid.y + ny * eps)?.id ?? OUTDOORS;
    const sideB = buildingAt(state, mid.x - nx * eps, mid.y - ny * eps)?.id ?? OUTDOORS;
    link(sideA, sideB);
  }
  return adj;
}

/**
 * The set of building ids whose INTERIOR is currently revealed to `viewer` — the
 * single source of truth for "can I see inside this building", shared by the
 * renderer (roof/slab fade + the indoor body cull) and the resident streamer
 * (embodiment/abstraction). Player-position feeds it, but VISIBILITY — not the
 * player's building — is what those behaviors key on.
 *
 * The rule (avatar mode): a building is visible if the viewer is INSIDE it, or a
 * doorway PHYSICALLY OPEN (swung clear, unlocked) and NEAR the viewer connects it
 * to the space the viewer is in. It floods across such doorways — the rooms of a
 * house you're walking through reveal as their doors stand open — but never leaks
 * back out to the street and into a neighbour (a building→outdoors edge is a
 * dead end unless outdoors is where the viewer started).
 *
 * Rooms-as-buildings (a multi-room house is one BuildingSpec per room) then Just
 * Works: the room you stand in seeds the set and every room reachable through an
 * open door joins it, while a locked gate room stays hidden until it's unlocked.
 */
export function visibleBuildings(
  state: WorldState,
  viewer: { x: number; y: number },
  passThreshold: number = WORLD_ENGINE_DEFAULTS.doorPassThreshold,
  revealRadius: number = VISIBILITY_REVEAL_RADIUS,
): Set<string> {
  const buildings = state.spec.buildings ?? [];
  if (!buildings.length) return new Set();
  const startNode = buildingAt(state, viewer.x, viewer.y)?.id ?? OUTDOORS;
  const adj = doorConnectivity(
    state,
    (door, mid) =>
      !door.locked &&
      door.open >= passThreshold &&
      Math.hypot(mid.x - viewer.x, mid.y - viewer.y) <= revealRadius,
  );

  // Flood from the viewer's space. A building→OUT→building chain is forbidden
  // (leaving to the street ends the reveal), so only the outdoors START may
  // enter buildings through their open exterior doors.
  const visible = new Set<string>();
  const seen = new Set<string>([startNode]);
  const queue = [startNode];
  while (queue.length) {
    const node = queue.shift()!;
    if (node !== OUTDOORS) visible.add(node);
    for (const next of adj.get(node) ?? []) {
      if (seen.has(next)) continue;
      if (node !== OUTDOORS && next === OUTDOORS) continue; // don't spill back outdoors
      seen.add(next);
      queue.push(next);
    }
  }
  return visible;
}

/**
 * The set of building interiors REACHABLE (through UNLOCKED doors) from where the
 * spirit IS — spirit ("dollhouse") visibility. A formless overhead viewer doesn't
 * walk or swing doors, so this ignores door swing AND proximity: every room you
 * could reach without passing a locked door is on show, and a puzzle that LOCKS
 * an area walls it off (it keeps its roof) until the lock is cleared.
 *
 * The seed is the spirit's own location (`viewer`), NOT open ground — an embedded
 * house is a SEALED box of interior-only doors (the entrance room is merely where
 * the spirit spawns; there's no door to the outside), so a flood from outdoors
 * would reach nothing. When the spirit sits inside a room, its whole reachable
 * suite lights up; with no viewer (or one outdoors) it falls back to whatever an
 * exterior door admits.
 */
export function accessibleBuildings(
  state: WorldState,
  viewer?: { x: number; y: number },
): Set<string> {
  const buildings = state.spec.buildings ?? [];
  if (!buildings.length) return new Set();
  const adj = doorConnectivity(state, (door) => !door.locked);
  const startNode = (viewer && buildingAt(state, viewer.x, viewer.y)?.id) || OUTDOORS;

  const visible = new Set<string>();
  const seen = new Set<string>([startNode]);
  const queue = [startNode];
  while (queue.length) {
    const node = queue.shift()!;
    if (node !== OUTDOORS) visible.add(node);
    for (const next of adj.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return visible;
}

/**
 * Door-aware waypoints from `from` to `to`: whenever the straight line would
 * cross a room/building boundary, insert a pair of transit points that LINE UP
 * with the real doorway (its live segment center, so an OFF-CENTRE door is
 * honoured) — one a step short on the near side, one a step past on the far
 * side. An NPC steered through these approaches the door head-on (auto-opening
 * it), passes, and continues, instead of grinding on the wall beside it.
 *
 * Returns the waypoints AFTER `from`, ending at `to`. Same room (or no door
 * chain / an all-locked barrier between them) ⇒ just `[to]` (the straight line;
 * the caller's per-leg timeout copes). Routes only through UNLOCKED doors.
 */
export function routeThroughDoors(
  state: WorldState,
  from: { x: number; y: number },
  to: { x: number; y: number },
  transit = 1.1,
): Vec2[] {
  const fromNode = buildingAt(state, from.x, from.y)?.id ?? OUTDOORS;
  const toNode = buildingAt(state, to.x, to.y)?.id ?? OUTDOORS;
  if (fromNode === toNode) return [to];

  // Every unlocked door as an edge between the two rooms it joins, keeping its
  // real center + wall normal (sideA is the +normal side).
  interface DoorEdge {
    a: string;
    b: string;
    mid: Vec2;
    nx: number;
    ny: number;
  }
  const edges: DoorEdge[] = [];
  const adj = new Map<string, { node: string; edge: DoorEdge }[]>();
  const link = (n: string, m: string, e: DoorEdge) =>
    (adj.get(n) ?? adj.set(n, []).get(n)!).push({ node: m, edge: e });
  for (const s of state.spec.structures ?? []) {
    if (s.kind !== "door") continue;
    const door = state.doors[s.id];
    if (!door || door.locked) continue;
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    let nx = -(s.b.y - s.a.y);
    let ny = s.b.x - s.a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const eps = s.thickness / 2 + 0.3;
    const sideA = buildingAt(state, mid.x + nx * eps, mid.y + ny * eps)?.id ?? OUTDOORS;
    const sideB = buildingAt(state, mid.x - nx * eps, mid.y - ny * eps)?.id ?? OUTDOORS;
    if (sideA === sideB) continue;
    const edge: DoorEdge = { a: sideA, b: sideB, mid, nx, ny };
    edges.push(edge);
    link(sideA, sideB, edge);
    link(sideB, sideA, edge);
  }

  // Shortest door chain fromNode → toNode.
  const prev = new Map<string, { node: string; edge: DoorEdge } | null>([[fromNode, null]]);
  const queue = [fromNode];
  let found = false;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toNode) {
      found = true;
      break;
    }
    for (const nb of adj.get(cur) ?? []) {
      if (prev.has(nb.node)) continue;
      prev.set(nb.node, { node: cur, edge: nb.edge });
      queue.push(nb.node);
    }
  }
  if (!found) return [to];

  const chain: { from: string; edge: DoorEdge }[] = [];
  for (let node = toNode; ; ) {
    const p = prev.get(node);
    if (!p) break;
    chain.push({ from: p.node, edge: p.edge });
    node = p.node;
  }
  chain.reverse();

  const pts: Vec2[] = [];
  for (const { from: fromSide, edge } of chain) {
    const nearPlus = edge.a === fromSide; // is the near side on +normal?
    const s = nearPlus ? 1 : -1;
    pts.push({ x: edge.mid.x + edge.nx * transit * s, y: edge.mid.y + edge.ny * transit * s });
    pts.push({ x: edge.mid.x - edge.nx * transit * s, y: edge.mid.y - edge.ny * transit * s });
  }
  pts.push(to);
  return pts;
}

/** Ease every door toward open (an avatar is within range and it isn't locked)
 *  or shut (nobody near). A locked door opens for an avatar carrying its key
 *  object (which permanently unlocks it). Runs once per tick, before locomotion. */
function tickDoors(state: WorldState, step: number, config: WorldEngineConfig): void {
  const structures = state.spec.structures;
  if (!structures) return;
  const avatars = Object.values(state.avatars);
  for (const s of structures) {
    if (s.kind !== "door") continue;
    const door = state.doors[s.id];
    if (!door) continue;
    const cx = (s.a.x + s.b.x) / 2;
    const cy = (s.a.y + s.b.y) / 2;
    const radius = doorOpenRadius(s, config);
    let anyNear = false;
    let capableNear = false; // a body that CAN open doors is here to work the door
    for (const a of avatars) {
      if (Math.hypot(a.x - cx, a.y - cy) > radius) continue;
      anyNear = true;
      if (a.canOpen !== false) capableNear = true;
      if (door.locked && s.keyObjectId && state.objects[s.keyObjectId]?.carriedBy === a.id) {
        door.locked = false; // the key turns the lock
      }
    }
    // OPENING is a CAPABILITY (not free proximity): only a body that can open
    // doors works one, and once open it is HELD — it stays open while ANY body
    // lingers (so a graspless follower keeps it open and can slip through), and
    // shuts only when everyone has left. A `pinned` door (an "open the door"
    // command) stays open with nobody near.
    if (!door.locked && capableNear) door.held = true;
    else if (!anyNear && !door.pinned) door.held = false;
    const target = !door.locked && door.held ? 1 : 0;
    if (step > 0) {
      door.open += (target - door.open) * (1 - Math.exp(-config.doorSwingRate * step));
    }
    if (Math.abs(target - door.open) < 0.01) door.open = target;
  }
}

/** Unlock a door (a game layer calls this when the player meets its condition —
 *  the engine-level analog of "used the key"). No-op for an unknown id. */
export function unlockDoor(state: WorldState, doorId: string): void {
  const d = state.doors[doorId];
  if (d) d.locked = false;
}

/** Re-lock a door (it will shut and stay solid until unlocked again). */
export function lockDoor(state: WorldState, doorId: string): void {
  const d = state.doors[doorId];
  if (d) d.locked = true;
}

// ---------------------------------------------------------------------------
// Remote / authority application (called by the transport + server layer)
// ---------------------------------------------------------------------------

/**
 * Write a remote peer's avatar from a network packet. The reported values become
 * the SMOOTHING TARGET (t*); the displayed x/y/fx/fy are advanced toward it by
 * smoothRemoteAvatars each render frame, so motion stays fluid between packets.
 * On first sight the display snaps to the reported pose. `floor` is optional on
 * the packet (older peers / the presence relay may omit it) and defaults to 0.
 */
/** Is `id` a body THIS peer simulates — its spark's own body, or a creature the
 *  spark has claimed? The network may never move either: our sim is
 *  authoritative for both, and a claimed body is streamed OUT by us. */
export function isLocallyDriven(state: WorldState, id: string): boolean {
  return id === state.localId || id === state.drivenId;
}

export function applyRemoteAvatar(
  state: WorldState,
  avatar: Omit<AvatarState, "floor"> & { floor?: number },
): void {
  if (isLocallyDriven(state, avatar.id)) return; // never let the network move us
  const cur = state.avatars[avatar.id];
  if (!cur) {
    state.avatars[avatar.id] = {
      id: avatar.id,
      x: avatar.x, y: avatar.y,
      fx: avatar.fx, fy: avatar.fy,
      vx: avatar.vx, vy: avatar.vy,
      floor: avatar.floor ?? 0,
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
    // Floor isn't smoothed — it's a discrete level; snap the displayed avatar to it.
    cur.floor = avatar.floor ?? cur.floor;
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
    if (isLocallyDriven(state, a.id) || a.tx === undefined || a.ty === undefined) continue;
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

/** CLAIM a body: point this spark's gaze-steering at `id`, or null to return to
 *  the spark's own body. The claimed body is NOT removed, moved or re-skinned —
 *  it keeps its model, and the CALLER suspends its controller so its own drives
 *  pause and resume on release. Returns false if that body isn't present. */
export function setDrivenBody(state: WorldState, id: string | null): boolean {
  const next = id ?? state.localId;
  if (!state.avatars[next]) return false;
  state.drivenId = next;
  return true;
}

/** Remove a peer who left the room (and any speech bubble anchored to them). */
export function removeAvatar(state: WorldState, id: string): void {
  if (id === state.localId) return;
  // A claimed body leaving the world (town unload, despawn) releases the spark
  // back to its own body — never leave a spark steering a ghost. Guarding on
  // drivenId instead would make a claimed body un-removable.
  if (state.drivenId === id) state.drivenId = state.localId;
  delete state.avatars[id];
  delete state.bubbles[`speech:${id}`];
}

/** The bubble key an avatar's own speech occupies. */
function avatarSpeechKey(id: string): string {
  return `speech:${id}`;
}

/**
 * Show (or replace) a world speech bubble under `key`. THE single caption entry
 * point — a remote player's utterance and an in-game character's line go through
 * the same call and render identically. Re-using a key updates that bubble in
 * place. Display-only: `tickWorld` never reads bubbles, so this can't perturb the
 * sim. Blank text clears the key. `at` is stamped with the local sim time.
 */
export function showWorldBubble(
  state: WorldState,
  key: string,
  spec: {
    anchor: WorldBubble["anchor"];
    text: string;
    glyph?: string;
    ttl?: number;
    style?: WorldBubble["style"];
  },
): void {
  const text = spec.text.trim();
  // Blank text clears the key — UNLESS a glyph rides along (a glyph-only
  // bubble is a legitimate symbol-first caption; it renders without a text row).
  if (!text && !spec.glyph) {
    delete state.bubbles[key];
    return;
  }
  state.bubbles[key] = {
    anchor: spec.anchor,
    text,
    glyph: spec.glyph,
    at: state.time,
    ttl: spec.ttl ?? BUBBLE_DEFAULT_TTL,
    ...(spec.style ? { style: spec.style } : {}),
  };
}

/** Remove a world bubble by key. */
export function clearWorldBubble(state: WorldState, key: string): void {
  delete state.bubbles[key];
}

/**
 * Attach (or clear) an AVATAR's speech bubble — a thin wrapper over the unified
 * showWorldBubble that anchors to the avatar (so the bubble tracks it as it
 * moves). The networked "say" path and the local speaker both call this. No-ops
 * for an unknown id (a "say" can race ahead of the avatar's first position
 * packet). Blank text clears it.
 */
export function setAvatarSpeech(
  state: WorldState,
  id: string,
  speech: { text: string; glyph?: string } | null,
): void {
  if (!state.avatars[id]) return;
  const key = avatarSpeechKey(id);
  if (!speech || !speech.text.trim()) {
    clearWorldBubble(state, key);
    return;
  }
  showWorldBubble(state, key, {
    anchor: { kind: "avatar", id },
    text: speech.text,
    glyph: speech.glyph,
  });
}

/** Write an object's position from the peer that currently owns it. */
export function applyRemoteObject(
  state: WorldState,
  objectId: string,
  patch: Partial<Pick<ObjectState, "x" | "y" | "vx" | "vy">>,
): void {
  const obj = state.objects[objectId];
  if (!obj) return;
  // Ignore remote position while WE own it — our sim is authoritative for it.
  // Driven body, not the spark: see the ownership note in tickObject.
  if (obj.possessedBy === state.drivenId || obj.freeRollOwner === state.drivenId) return;
  Object.assign(obj, patch);
}

/**
 * Commit a server possession decision. participantId = grantee, or null to
 * free the object. This is the authoritative source once a real server arbiter
 * exists; until then the optimistic local grab stands in for it.
 */
export function applyPossession(
  state: WorldState,
  objectId: string,
  participantId: string | null,
  at: number,
  grabCooldown = WORLD_ENGINE_DEFAULTS.grabCooldown,
): void {
  const obj = state.objects[objectId];
  if (!obj) return;
  if (participantId === null) {
    if (obj.possessedBy !== null) {
      obj.lastPossessor = obj.possessedBy;
      obj.grabCooldownUntil = at + grabCooldown;
    }
    obj.possessedBy = null;
  } else {
    obj.possessedBy = participantId;
    obj.freeRollOwner = null;
    obj.vx = 0;
    obj.vy = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canGrab(
  obj: ObjectState,
  avatar: AvatarState,
  touchRadius: number,
  now: number,
): boolean {
  if (now < obj.grabCooldownUntil && obj.lastPossessor === avatar.id) return false;
  const d = Math.hypot(obj.x - avatar.x, obj.y - avatar.y);
  return d <= touchRadius;
}

function clampToManifold(a: AvatarState, spec: WorldSpec, radius: number): void {
  // An unbounded manifold (a planet-mounted session) has no walls: the rect
  // is content extent, not a physical boundary. The planet's own terrain
  // fields (ground/water samplers answer everywhere) are the only limits.
  if (spec.manifold.bounded === false) return;
  const { width, height } = spec.manifold;
  if (a.x < radius) { a.x = radius; if (a.vx < 0) a.vx = 0; }
  if (a.x > width - radius) { a.x = width - radius; if (a.vx > 0) a.vx = 0; }
  if (a.y < radius) { a.y = radius; if (a.vy < 0) a.vy = 0; }
  if (a.y > height - radius) { a.y = height - radius; if (a.vy > 0) a.vy = 0; }
}

function bounceOffWalls(
  obj: ObjectState,
  spec: WorldSpec,
  radius: number,
  restitution: number,
): void {
  if (spec.manifold.bounded === false) return; // no walls to bounce off
  const { width, height } = spec.manifold;
  if (obj.x < radius) { obj.x = radius; obj.vx = Math.abs(obj.vx) * restitution; }
  if (obj.x > width - radius) { obj.x = width - radius; obj.vx = -Math.abs(obj.vx) * restitution; }
  if (obj.y < radius) { obj.y = radius; obj.vy = Math.abs(obj.vy) * restitution; }
  if (obj.y > height - radius) { obj.y = height - radius; obj.vy = -Math.abs(obj.vy) * restitution; }
}

function objectSpecFor(spec: WorldSpec, objectId: string): ObjectSpec {
  // createWorldState only ever builds objects present in the spec, so this holds.
  return spec.objects.find((x) => x.id === objectId) as ObjectSpec;
}
