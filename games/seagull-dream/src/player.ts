import * as THREE from "three";
import { PLAYER, CONTROLS, SPEED, READOUT } from "./config";
import type { World, GravityContext, AtmosphericReading } from "./world";
import type { CelestialBody } from "./body";

// Player physics in a space-first world.
//
// Each frame we ask the world for the gravity context at our position. The
// dominant planet (if any) defines "down" — we use that to decide between:
//
//   walking  — within landingAltitude of the dominant planet's surface;
//              position locked to the surface, forward stays tangent.
//   flying   — within gravity influence but airborne; body smoothly orients
//              so bodyUp aligns with gravity-up, scaled by influence.
//   drifting — no dominant planet (deep space); body frame is preserved
//              between frames, controls become 6-DOF-ish.
//
// The maintained `bodyRight` axis avoids gimbal lock — body up is derived
// from forward × bodyRight, never from a cross product that goes to zero
// at vertical pitch.

// "takeoff" covers the brief (250 ms) wing-unfold + body-twist animation
// that bridges walking and flying when the player triggers a jump takeoff.
// During this phase ground movement still decays via friction (spec: "do
// not completely pause ground movement, but slow down") and body
// orientation rotates from current attitude to launch attitude — used to
// flip the bird upright when launching off steep slopes.
//
// "stunned" is entered on a bad landing or high-energy crash. Player
// input is ignored; gravity + residual momentum determine motion until
// the stun timer runs out. If the bird is on the ground when the timer
// expires it transitions to walking; otherwise back to flying.
//
// "swimming" is the on-water analogue of walking — same control scheme
// but body sits slightly below the surface and the pre-takeoff speed
// cap is smaller. "diving" is a short animation phase (analogous to
// "takeoff") that bridges swimming → underwater. "underwater" is a
// constant-low-speed exploration mode entered from a dive OR a
// steep-angle water hit from flight.
export type PlayerMode =
  | "walking"
  | "takeoff"
  | "flying"
  | "drifting"
  | "stunned"
  | "swimming"
  | "diving"
  | "underwater";

export interface Input {
  /** Normalized mouse position, (0,0) top-left, (1,1) bottom-right. */
  mouseX: number;
  mouseY: number;
}

export interface PlayerState {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  /** Body-frame right axis. Maintained orthogonal to forward across frames. */
  bodyRight: THREE.Vector3;
  /** Local "up" (toward sky/away from dominant planet center). Equals body-up
   *  when drifting. */
  up: THREE.Vector3;
  /** Terrain normal at the player's position — only meaningful while walking. */
  groundNormal: THREE.Vector3;
  mode: PlayerMode;
  bank: number;
  walkSpeed: number;
  /** REAL world-frame velocity — gravity-affected, inertial. Persists
   *  across mode changes; matches local wind at takeoff so leaving an
   *  atmosphere keeps you in orbit naturally. */
  velocity: THREE.Vector3;
  /** WARP-drive velocity. Independent inertia/friction system. In space
   *  this is the dominant component of motion (~km/s); near bodies the
   *  warp drag decays it rapidly so real velocity takes over. Position
   *  update is `pos += (realVel + warpVel) * dt`. */
  warpVelocity: THREE.Vector3;
  /** Cached gravity context from the last frame (for HUD / sky / etc.). */
  gravity: GravityContext;
  /** Cached warp multiplier from the most recent flight frame. 1 when walking. */
  lastWarpFactor: number;
  /** Wing-flap animation phase (radians, monotonic). */
  flapPhase: number;
  /** Cached thrust boost from the most recent atmospheric-flight frame.
   *  Used to drive the rocket-particle effect. 1.0 = no boost. */
  lastThrustBoost: number;
  /** Which propulsion mode is currently strongest, from the three-mode
   *  speed blend. Drives visual effects (rocket plume in ROCKET, warp
   *  distortion in WARP, regular wing animation in WING). */
  activeMode: "wing" | "rocket" | "warp";
  /** Per-mode normalized weights from the p-norm blend (sum = 1).
   *  Used for partial-blend visuals — e.g. rocket plume intensity
   *  scales with `lastModeWeights.rocket`. */
  lastModeWeights: { wing: number; rocket: number; warp: number };
  /** Wing-extension regime, 0..1. 0 = fully tucked (folded against
   *  the body, walking-with-closed-wings pose). 1 = fully spread
   *  (running-takeoff or flying). Walking lerps this toward 1 when
   *  the player is aiming above ground at non-trivial speed (the
   *  pre-takeoff running state) and toward 0 otherwise. Acts as a
   *  REGIME variable: speedCap during walking interpolates between
   *  `walkSpeedMax` (extension=0) and `runningTakeoffSpeed`
   *  (extension=1), and downstream "is the bird in running takeoff"
   *  checks treat values above ~0.7 as deployed. */
  wingExtension: number;
  /** Progress through the jump-takeoff animation, 0..1. Only
   *  meaningful while `mode === "takeoff"`. */
  takeoffPhase: number;
  /** Captured launch parameters at the start of a jump takeoff —
   *  re-read each frame of the animation so the body slerps from
   *  start to target attitude and the launch velocity matches the
   *  attitude the bird actually had when triggered. */
  takeoffData: {
    startForward: THREE.Vector3;
    startBodyRight: THREE.Vector3;
    targetForward: THREE.Vector3;
    targetBodyRight: THREE.Vector3;
    targetUp: THREE.Vector3;
    /** Whether thrust comes from rockets (airless world) rather than
     *  wings. Purely a visual difference — physics is identical. */
    useRocket: boolean;
  } | null;
  /** Inertial wing-speed magnitude (m/s). Spec calls for asymmetric
   *  friction: speed bleeds gently when diving (carries momentum into
   *  a swoop) and firmly when climbing (so the upward cap holds).
   *  Snaps to the inertialess target outside atmosphere. */
  wingSpeed: number;
  /** Leg extension 0..1. 0 = fully tucked back (in flight), 1 = fully
   *  extended downward (walking / landing). Lerps smoothly between
   *  these in response to obstacle proximity. */
  legsExtended: number;
  /** Monotonically increasing stride-phase accumulator (radians). Each
   *  full 2π = one complete L/R step cycle. Advanced by walkSpeed
   *  while grounded; consumed by the leg animation to swing each
   *  pivot forward/back in counter-phase. */
  legStridePhase: number;
  /** Seconds remaining in the current stun. 0 means not stunned. Set
   *  by bad landings / high-energy crashes; ticks down each frame. */
  stunnedTime: number;
  /** Progress through the dive-down animation (0..1). Only meaningful
   *  while `mode === "diving"`. */
  divePhase: number;
  /** Composite flight-strain factor (0..1). Captures how hard the
   *  bird is working to maintain flight: high in vacuum, climbing,
   *  or high gravity; low when gliding level in dense atmosphere.
   *  Drives wing flap intensity / rocket plume intensity so the
   *  visual transition between regimes reads as a phase shift
   *  rather than a sudden mode swap. Computed each airborne frame. */
  flightStrain: number;
  /** Visual wing-vs-rocket split (0..1). 0 = pure wing visuals (full
   *  flap), 1 = pure rocket visuals (wings tucked, plume firing).
   *  Driven solely by atmosphere and gravity — speed itself is the
   *  same number either way; rockets just take over when wings can't
   *  generate enough thrust at the local α / g. */
  rocketRegimeWeight: number;
  /** ID of the body the player has locked onto (or null). Lock applies
   *  an extra distance-proportional speed cap so approaches smoothly
   *  brake — it does NOT reorient the bird. */
  lockedBodyId: string | null;
  /** Lock-on progress, 0..1. Climbs while the player keeps the same
   *  candidate body in the forward cone, decays when they look away.
   *  Lock's approach cap is active at 1. */
  lockProgress: number;
  /** Gaze-driven hyperspeed multiplier. Starts at 1. Grows
   *  exponentially while the player looks at the center of the screen
   *  (their direction of motion); decays faster when off-center or in
   *  atmosphere. Effective desired speed = baseSpeed × hyperMult,
   *  capped at HYPER_MAX_SPEED. */
  hyperMult: number;
  /** Most recent atmospheric α (normalized density) at the player's
   *  position. Cached for HUD readouts. */
  lastAtmAlpha: number;
  /** Local gravity magnitude (m/s²) at the player's position, cached
   *  for HUD readouts. */
  lastGravityMag: number;
  /** Diagnostic snapshot of the three-mode blend's intermediate
   *  values. Updated each airborne frame; left stale in other modes
   *  (HUD shows the last airborne sample). */
  flightDebug: {
    /** Inertial wingSpeed — the bird's actual flight-frame speed,
     *  lerped toward `targetSpeed` with asymmetric friction. */
    vWing: number;
    /** sqrt(2 × A × h) — altitude-derived component of the target. */
    altSpeed: number;
    /** max(MIN_FLIGHT_SPEED, altSpeed) — the floor-clamped target. */
    targetSpeed: number;
    /** baseSpeed × hyperMult, capped at HYPER_MAX_SPEED. */
    desiredSpeed: number;
    totalSpeed: number;
    climbT: number;
    forwardUp: number;
    /** (R/r)^N inhibition factor from the dominant body. 0 = no
     *  inhibition (deep space), 1 = at surface. Drives the warp
     *  friction. */
    warpInhibition: number;
    /** Combined gate (atm × gravFactor) on the hyperMult contribution.
     *  0 = baseSpeed only (atm or surface), 1 = full multiplier (deep
     *  space). */
    warpGate: number;
    /** altitude / (hillRadius - bodyRadius) on the dominant body
     *  (readout-only — not used in the friction formula). */
    hillFraction: number;
    /** ID of the local-system dominant body (smallest hill sphere
     *  containing the player; nearest-by-distance as fallback). */
    dominantBodyId: string | null;
    /** Player's altitude above the dominant body's surface. */
    dominantAlt: number;
    /** Dominant body's hill radius (m). */
    dominantHillRadius: number;
    nearestBodyId: string | null;
    nearestAlt: number;
    nearestHillRadius: number;
    obstacleClearance: number;
    lowAltCap: number;
    upwardSpeed: number;
  };
}

export interface Player {
  state: PlayerState;
  object: THREE.Object3D;
  update(input: Input, dt: number): void;
  /** Re-sync the bird mesh transform from `state.position`. Needs to
   *  run AFTER the world's continuous floating-origin rebase
   *  (`checkActiveSystem`), which mutates `state.position` and would
   *  otherwise leave `object.position` at the pre-rebase value. */
  sync(): void;
  /**
   * Install a hook that returns a unit world-space direction the bird
   * should gently orient toward, or null to disable. The hook is read
   * each airborne frame; while it returns a vector, `forward` lerps
   * toward it at READOUT.birdPull per second. Used by the object-
   * readout overlay so the bird faces the focused body during approach.
   */
  setReadoutHook(hook: (() => THREE.Vector3 | null) | null): void;
}

export function createPlayer(world: World, scene: THREE.Scene): Player {
  // Spawn the player on the home planet's SUN-FACING side. Spawning at the
  // +Y pole (an "ecliptic pole") leaves the surface normal perpendicular to
  // the sun direction → no direct illumination at takeoff → everything
  // looks washed-out brown. Instead, use (origin - planet.worldPosition)
  // — the direction from the planet to the system center, where the star
  // sits. Surface normal there aligns with the sun direction → full day.
  //
  // homePlanet is nullable on the world (it's null in GALACTIC mode after
  // the player leaves the initial system), but createPlayer only runs at
  // startup when the home system is freshly materialized, so we can
  // assert non-null here.
  const home = world.homePlanet;
  if (!home) throw new Error("createPlayer requires an initial home planet");
  const startDir = new THREE.Vector3();
  if (home.worldPosition.lengthSq() > 1) {
    startDir.copy(home.worldPosition).negate().normalize();
  } else {
    startDir.set(0, 1, 0); // fall back if planet is at origin (shouldn't happen)
  }
  // If the canonical spawn direction lands underwater (common — earthlike
  // planets are ~70% ocean), spiral outward sampling heightAt until we find
  // dry land. The planet's orientation at t=0 is identity, so world
  // direction == local direction for the height query. Capped at N tries so
  // a fully-aquatic seed still spawns somewhere instead of looping.
  if (home.heightAt && home.surfaceAt) {
    const _local = new THREE.Vector3();
    const _axisA = new THREE.Vector3();
    const _axisB = new THREE.Vector3();
    const tmpUp = Math.abs(startDir.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    _axisA.crossVectors(startDir, tmpUp).normalize();
    _axisB.crossVectors(startDir, _axisA).normalize();
    const trial = new THREE.Vector3();
    const SAMPLES = 48;
    const MAX_RADIUS = 0.5; // ~28°, generous radius from the chosen spawn pole
    for (let i = 0; i < SAMPLES; i++) {
      // Phyllotaxis spiral — points evenly spread without rings.
      const t = i / SAMPLES;
      const angle = i * 2.39996; // golden-angle, ~137.5°
      const r = Math.sqrt(t) * MAX_RADIUS;
      trial.copy(startDir)
        .addScaledVector(_axisA, Math.cos(angle) * r)
        .addScaledVector(_axisB, Math.sin(angle) * r)
        .normalize();
      _local.copy(trial).applyQuaternion(home.inverseOrientation);
      if (home.heightAt(_local) > 20) {
        startDir.copy(trial);
        break;
      }
    }
  }
  const spawnAttempt = new THREE.Vector3()
    .copy(home.worldPosition)
    .addScaledVector(startDir, home.radius + 100);
  // DEBUG SPAWN: in the air, in flying mode.
  const SPAWN_ALTITUDE = 1500;
  const startSurface = home.surfaceAt!(spawnAttempt, new THREE.Vector3());
  const startUp = home.upAt(startSurface, new THREE.Vector3());
  const startPos = startSurface.clone().addScaledVector(startUp, SPAWN_ALTITUDE);
  // Pick a seed direction for "forward" that isn't axis-aligned with the
  // local up. If we always seed with +X and the planet happens to spawn
  // along the +X axis (so startUp == ±X), projectTangent collapses to
  // (0, 0, 0) and forward ends up zero. Fall back to +Z when up is too
  // close to ±X.
  const initSeed = Math.abs(startUp.x) < 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 0, 1);
  const initForward = projectTangent(initSeed, startUp).normalize();
  const initBodyRight = new THREE.Vector3().crossVectors(startUp, initForward).normalize();

  // Inherit ONLY the planet's translational velocity, not its surface
  // rotation. Surface rotation would carry the player off at hundreds of
  // m/s tangentially, which is what caused the previous escape-velocity
  // problem. Orbital velocity is necessary so the player stays in the
  // planet's frame — without it, the planet immediately leaves you
  // behind in world coordinates.
  const initVelocity = new THREE.Vector3().copy(home.velocity);
  initVelocity.addScaledVector(initForward, PLAYER.flySpeed);

  const gravity: GravityContext = {
    dominant: home,
    influence: 0.95,
    up: startUp.clone(),
    altitude: SPAWN_ALTITUDE,
  };

  const state: PlayerState = {
    position: startPos,
    forward: initForward,
    bodyRight: initBodyRight,
    up: startUp.clone(),
    groundNormal: startUp.clone(),
    // DEBUG: start in flying so we can isolate flight-physics bugs from
    // takeoff bugs. Switch back to "walking" when flight feels stable.
    mode: "flying",
    bank: 0,
    walkSpeed: 0,
    velocity: initVelocity,
    warpVelocity: new THREE.Vector3(),
    gravity,
    lastWarpFactor: 1,
    flapPhase: 0,
    lastThrustBoost: 1,
    activeMode: "wing",
    lastModeWeights: { wing: 1, rocket: 0, warp: 0 },
    wingExtension: 0,
    takeoffPhase: 0,
    takeoffData: null,
    wingSpeed: PLAYER.flySpeed,
    legsExtended: 1,
    legStridePhase: 0,
    stunnedTime: 0,
    divePhase: 0,
    flightStrain: 0,
    rocketRegimeWeight: 0,
    lockedBodyId: null,
    lockProgress: 0,
    hyperMult: 1,
    lastAtmAlpha: 0,
    lastGravityMag: 0,
    flightDebug: {
      vWing: 0,
      altSpeed: 0,
      targetSpeed: 0,
      desiredSpeed: 0,
      totalSpeed: 0,
      climbT: 0.5,
      forwardUp: 0,
      warpInhibition: 0,
      warpGate: 0,
      hillFraction: 0,
      dominantBodyId: null,
      dominantAlt: Infinity,
      dominantHillRadius: Infinity,
      nearestBodyId: null,
      nearestAlt: Infinity,
      nearestHillRadius: Infinity,
      obstacleClearance: Infinity,
      lowAltCap: Infinity,
      upwardSpeed: 0,
    },
  };

  // ── Visual body (placeholder seagull) ────────────────────────────────────
  const object = new THREE.Group();
  object.name = "player";

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 });
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.7, side: THREE.DoubleSide });
  const beakMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.5 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), bodyMat);
  body.scale.set(0.7, 0.65, 1.4);
  object.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 10), bodyMat);
  head.position.set(0, 0.18, 0.45);
  object.add(head);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 8), beakMat);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.16, 0.72);
  object.add(beak);

  // Legs hang off two pivot groups under the belly. While walking the
  // pivots are at "extended" (legs straight down for ground contact);
  // while flying the pivots rotate UP so the legs tuck under the tail,
  // aerodynamic. On approach to ground/obstacles the legs gradually
  // extend (lerp driven by `state.legsExtended` 0..1).
  //
  // legUpright orientation = legs hanging down, feet at the body's
  // belly + a bit forward. legTucked orientation = legs folded back
  // toward the tail, almost parallel to the body's forward axis.
  const legMat = beakMat; // same orange as beak — sea-gull yellow-orange
  const legGeom = new THREE.CylinderGeometry(0.025, 0.025, 0.32, 6);
  const footGeom = new THREE.BoxGeometry(0.08, 0.025, 0.16);

  function makeLeg(side: 1 | -1): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(0.08 * side, -0.18, -0.05);
    const leg = new THREE.Mesh(legGeom, legMat);
    leg.position.set(0, -0.16, 0); // cylinder axis is along +Y; drop it down by half its length
    pivot.add(leg);
    const foot = new THREE.Mesh(footGeom, legMat);
    foot.position.set(0, -0.32, 0.04);
    pivot.add(foot);
    return pivot;
  }
  const legLPivot = makeLeg(-1);
  const legRPivot = makeLeg(1);
  object.add(legLPivot);
  object.add(legRPivot);

  // Resting pose quats. Down = legs straight down (walking).
  // Tucked  = legs folded back under tail (flying).
  const _legDownQuat = new THREE.Quaternion(); // identity — leg cylinder is already pointing down
  const _legTuckQuat = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 - 0.3);
  const _legAnimQuat = new THREE.Quaternion();
  // Step swing — rotation around the bird's right axis (+X local). A
  // positive angle swings the leg FORWARD (foot forward, hip back);
  // negative swings it back. Driven by sin(stridePhase) with the L
  // and R legs in counter-phase. Reused per frame.
  const _legStepAxis = new THREE.Vector3(1, 0, 0);
  const _legStepQuat = new THREE.Quaternion();
  const _legPoseQuat = new THREE.Quaternion();

  // Wings hang off two pivot groups parked at the body's side — that's
  // the attachment point, the spot the wing should rotate around. The
  // wing mesh itself is offset OUTWARD from the pivot so its body-side
  // edge sits at the pivot's origin. Animating the pivot's quaternion
  // (flap around forward, sweep around up) then rotates the wing around
  // its attachment point, the way a real bird's wing hinges on the body.
  const wingGeom = new THREE.PlaneGeometry(1.7, 0.55);
  const wingBaseQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2,
  );

  const wingLPivot = new THREE.Group();
  wingLPivot.position.set(-0.10, 0.05, 0); // body's left attachment point
  object.add(wingLPivot);
  const wingL = new THREE.Mesh(wingGeom, wingMat);
  wingL.position.set(-0.85, 0, 0); // wing center 0.85 outward from pivot
  wingL.quaternion.copy(wingBaseQuat);
  wingLPivot.add(wingL);

  const wingRPivot = new THREE.Group();
  wingRPivot.position.set(0.10, 0.05, 0);
  object.add(wingRPivot);
  const wingR = new THREE.Mesh(wingGeom, wingMat);
  wingR.position.set(0.85, 0, 0);
  wingR.quaternion.copy(wingBaseQuat);
  wingRPivot.add(wingR);

  const _flapAxis = new THREE.Vector3(0, 0, 1); // bird-local forward
  const _sweepAxis = new THREE.Vector3(0, 1, 0); // bird-local up
  const _flapQuat = new THREE.Quaternion();
  const _sweepQuat = new THREE.Quaternion();

  const tailGeom = new THREE.PlaneGeometry(0.5, 0.4);
  const tail = new THREE.Mesh(tailGeom, wingMat);
  tail.rotation.x = -Math.PI / 2;
  tail.position.set(0, 0.05, -0.65);
  object.add(tail);

  scene.add(object);

  // ── Rocket-trail particles ───────────────────────────────────────────────
  // Parented to the bird object — positions and velocities are stored
  // in BIRD-LOCAL space, so the trail follows the bird as it turns and
  // doesn't fan out into world-space dispersion patterns. The Points
  // mesh inherits the bird's transform when rendered.
  //
  // Particles spawn at the tail (local Z ≈ -0.65) and drift in local
  // -Z (further behind the bird) until they fade out. Emission is
  // gated on LOW ATMOSPHERIC DENSITY, not on the in-atmosphere thrust
  // boost — so the particles tell the player when the bird has
  // transitioned out of normal atmospheric flight into "space thrust"
  // mode (thin air, moons, vacuum), not when normal wing-flapping is
  // happening at sea level.
  const THRUST_PARTICLES = 80;
  const THRUST_LIFE = 0.55;
  const thrustPositions = new Float32Array(THRUST_PARTICLES * 3);
  const thrustColors = new Float32Array(THRUST_PARTICLES * 3);
  const thrustVelocities = new Float32Array(THRUST_PARTICLES * 3);
  const thrustLifetimes = new Float32Array(THRUST_PARTICLES);
  const thrustGeom = new THREE.BufferGeometry();
  thrustGeom.setAttribute("position", new THREE.BufferAttribute(thrustPositions, 3));
  thrustGeom.setAttribute("color", new THREE.BufferAttribute(thrustColors, 3));
  const thrustTexture = makeThrustTexture();
  const thrustMat = new THREE.PointsMaterial({
    size: 18,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    map: thrustTexture,
    alphaTest: 0.005,
  });
  const thrustPoints = new THREE.Points(thrustGeom, thrustMat);
  thrustPoints.name = "thrust-trail";
  thrustPoints.frustumCulled = false;
  object.add(thrustPoints); // parented — positions are in bird-local space
  let thrustSpawnAccumulator = 0;

  let takeoffHeld = 0;

  // Object-readout auto-orient hook. When set + returning a unit vector,
  // the airborne update lerps `forward` toward that direction at the
  // configured pull rate so the bird visibly faces the focused body
  // during approach. The hook is consulted AFTER the player's own
  // pitch/yaw input has been applied — pull is gentle so the user can
  // still steer away.
  let readoutHook: (() => THREE.Vector3 | null) | null = null;
  const _readoutPullDir = new THREE.Vector3();

  // ── Reusable temporaries ─────────────────────────────────────────────────
  const tmpUp = new THREE.Vector3();
  const tmpForward = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpDelta = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const _attachQuat = new THREE.Quaternion();
  const _atmReading: AtmosphericReading = { density: 0, body: null };
  const _attachReading: AtmosphericReading = { density: 0, body: null };
  const _atmUp = new THREE.Vector3();
  const _gravTmp = new THREE.Vector3();
  const _playerLocal = new THREE.Vector3();
  const _radial = new THREE.Vector3();
  const _objDelta = new THREE.Vector3();

  // ── Scatter collision ────────────────────────────────────────────────────
  // Player vs. trees/rocks. We resolve in PLANET-LOCAL space so the planet's
  // rotation isn't part of every distance check: scatter objects are stored
  // in local coords, the player is transformed in once. The radial component
  // of any push is removed before applying — collisions slide the player
  // along the tangent plane, leaving the subsequent surface snap to handle
  // vertical positioning.
  //
  // Spherical bounding spheres only. They're the most forgiving option on a
  // curved surface (no tangent-frame tracking per obstacle) and the visuals
  // — short trunks, irregular rocks — match a fat-sphere collider better
  // than a tight cylinder anyway.
  function resolveScatterCollisions(planet: NonNullable<GravityContext["dominant"]>): void {
    const scatter = planet.scatter;
    if (!scatter || scatter.size === 0) return;
    // World → local.
    _playerLocal.copy(state.position).sub(planet.worldPosition).applyQuaternion(planet.inverseOrientation);
    let movedAny = false;
    for (let iter = 0; iter < 3; iter++) {
      let movedThisIter = false;
      _radial.copy(_playerLocal).normalize();
      for (const obj of scatter) {
        const sumR = PLAYER.collisionRadius + obj.collisionRadius;
        _objDelta.copy(_playerLocal).sub(obj.localPosition);
        const distSq = _objDelta.lengthSq();
        if (distSq >= sumR * sumR || distSq < 1e-8) continue;
        // Strip the radial component so we push along the surface, not up.
        const radialComp = _objDelta.dot(_radial);
        _objDelta.addScaledVector(_radial, -radialComp);
        const tangentLen = _objDelta.length();
        if (tangentLen < 1e-6) {
          // Player is exactly on the radial line through the object —
          // pick an arbitrary tangent direction (using forward as a hint).
          _objDelta.copy(state.forward).addScaledVector(_radial, -state.forward.dot(_radial));
          if (_objDelta.lengthSq() < 1e-8) continue;
          _objDelta.normalize();
        } else {
          _objDelta.divideScalar(tangentLen);
        }
        // Push to exactly the contact distance. sumR is Euclidean and we're
        // moving along tangent — for tree-sized obstacles on a 50km planet,
        // the chord-vs-arc error is sub-millimeter, safe to ignore.
        const overlap = sumR - Math.sqrt(distSq);
        _playerLocal.addScaledVector(_objDelta, overlap);
        movedThisIter = true;
        movedAny = true;
      }
      if (!movedThisIter) break;
    }
    if (movedAny) {
      state.position.copy(_playerLocal).applyQuaternion(planet.orientation).add(planet.worldPosition);
    }
  }

  // ── Walking ──────────────────────────────────────────────────────────────
  // Mouse position drives both heading and target speed. mouseY is treated
  // as an "aim distance" along the ground:
  //
  //   top of screen     → far ahead → max forward intent (1.0)
  //   middle of screen  → at bird's feet → stopped (0.0)
  //   bottom of screen  → behind → max backward intent (-1.0)
  //
  // Speed acceleration / deceleration is symmetric and proportional to the
  // gap to the target — no jumps. Slope-aware: actual horizontal step is
  // reduced when going uphill (the velocity along forward is the same, but
  // surface-snap re-anchors vertically so vertical "climb" eats some of
  // the per-frame distance). Past `walkSlopeWallAngle` (~54°) the slope
  // acts as a wall and forward target collapses to zero.
  //
  // Takeoff triggers are handled here too:
  //   1. Jump takeoff: small top-center zone → 250 ms animation (`mode`
  //      flips to "takeoff").
  //   2. Running takeoff: top portion of screen, zone grows with current
  //      walk speed. Wings unfold (`wingExtension` ramps to 1); target speed
  //      shifts from walkSpeedMax to runningTakeoffSpeed. Once the bird
  //      reaches takeoff speed, `mode` flips directly to "flying".
  function updateWalking(input: Input, dt: number, planet: NonNullable<GravityContext["dominant"]>) {
    const mx = input.mouseX * 2 - 1;
    const my = -(input.mouseY * 2 - 1);

    planet.upAt(state.position, state.up);

    // Turn rate scales with horizontal mouse offset — same as before.
    if (Math.abs(mx) > 0.02) {
      // See historic note in pre-rewrite: screen-right turn is a NEGATIVE
      // rotation around +up in our right-handed basis.
      const turnRate = -mx * 2.5 * dt;
      tmpQuat.setFromAxisAngle(state.up, turnRate);
      state.forward.applyQuaternion(tmpQuat);
      state.bodyRight.applyQuaternion(tmpQuat);
      reTangent(state.forward, state.up);
    }

    // Pull the local atmospheric density once — used for both the
    // running-takeoff thrust-mode decision (wings in atmosphere, rockets
    // in vacuum) and any future air-friction effects on walking.
    world.atmosphericDensityAt(state.position, _atmReading);
    const alpha = _atmReading.density;

    // Resolve takeoff intents BEFORE picking a target speed — the running-
    // takeoff zone widens as walkSpeed approaches walkSpeedMax, so the
    // intent has to read the current frame's speed but write the new
    // wingExtension lerp for THIS frame's target.
    const speedFrac = Math.min(1, Math.abs(state.walkSpeed) / PLAYER.walkSpeedMax);

    // Jump-takeoff zone: small top-center band. Fires immediately
    // regardless of current speed.
    const inJumpZone =
      input.mouseY < CONTROLS.jumpTakeoffMouseThreshold &&
      Math.abs(mx) < CONTROLS.jumpTakeoffMouseRadius;
    if (inJumpZone) {
      beginJumpTakeoff(planet, alpha);
      return; // mode is now "takeoff" — the next frame will run updateTakeoff
    }

    // Running-takeoff zone: top of screen, expands with current walk speed.
    // mouseY (screen-space 0..1) below this threshold counts as "above
    // the horizon" for the purposes of unfolding wings.
    const runZoneCeiling =
      CONTROLS.runTakeoffMouseThreshold + CONTROLS.runZoneSpeedScale * speedFrac;
    const aimAboveGround = input.mouseY < runZoneCeiling && state.walkSpeed > 0;

    // Extend wings when aiming high while moving forward; retract once
    // back below the threshold AND we've decelerated under walkSpeedMax
    // (so brief mouse twitches don't fold the wings mid-run). The
    // boolean intent is converted to a continuous wingExtension via
    // a lerp so it reads as a regime variable rather than a flip.
    let wingTarget = state.wingExtension;
    if (aimAboveGround && state.walkSpeed > PLAYER.walkSpeedMax * 0.5) {
      wingTarget = 1;
    } else if (!aimAboveGround && state.walkSpeed <= PLAYER.walkSpeedMax) {
      wingTarget = 0;
    }
    state.wingExtension += (wingTarget - state.wingExtension)
      * Math.min(1, PLAYER.wingExtendRate * dt);

    // Forward intent comes from how far above center the mouse is.
    // Mapping:
    //   my =  1 (top)    → +1 (full forward)
    //   my =  0 (middle) → 0  (stopped)
    //   my = -1 (bottom) → -1 (full backward)
    // Clamp first to remove the screen-edge plateau.
    const forwardIntent = THREE.MathUtils.clamp(my, -1, 1);

    // Slope handling. groundNormal sits between state.up (flat ground) and
    // some tilted vector on a slope. The angle between them is the slope
    // angle; we use it for two effects:
    //   1. WALL cutoff: above walkSlopeWallAngle, forward target → 0.
    //   2. Soft slope penalty: between walkSlopeSlowAngle and the wall
    //      angle, scale forward intent linearly toward zero.
    const slopeCos = THREE.MathUtils.clamp(state.groundNormal.dot(state.up), -1, 1);
    const slopeAngle = Math.acos(slopeCos);
    let slopeScale = 1;
    if (slopeAngle >= PLAYER.walkSlopeWallAngle) {
      slopeScale = 0;
    } else if (slopeAngle > PLAYER.walkSlopeSlowAngle) {
      const t = (slopeAngle - PLAYER.walkSlopeSlowAngle)
        / Math.max(1e-6, PLAYER.walkSlopeWallAngle - PLAYER.walkSlopeSlowAngle);
      slopeScale = 1 - t;
    }
    // Speed cap interpolates with wing extension so the run-up
    // accelerates smoothly as wings unfold rather than snapping to a
    // higher cap the instant the player triggers the run zone.
    const speedCap = THREE.MathUtils.lerp(
      PLAYER.walkSpeedMax,
      PLAYER.runningTakeoffSpeed,
      state.wingExtension,
    );
    const targetSpeed = forwardIntent > 0
      ? forwardIntent * speedCap * slopeScale
      : forwardIntent * PLAYER.walkSpeedMax; // backing up isn't affected by extended wings
    state.walkSpeed += (targetSpeed - state.walkSpeed) * Math.min(1, PLAYER.walkAccel * dt);

    tmpDelta.copy(state.forward).multiplyScalar(state.walkSpeed * dt);
    state.position.add(tmpDelta);

    // Push out of any trees / rocks we walked into. Done before the surface
    // snap so the snap re-anchors vertically after the lateral nudge.
    resolveScatterCollisions(planet);

    // Snap to surface + eye height, and re-derive the local frame at the new
    // position. updateWalking is only called when state.mode === "walking",
    // which only happens on walkable bodies, so the optional samplers are
    // guaranteed present.
    const surface = planet.surfaceAt!(state.position, tmpDelta);
    planet.upAt(surface, state.up);
    state.position.copy(surface).addScaledVector(state.up, PLAYER.eyeHeight);
    reTangent(state.forward, state.up);
    state.bodyRight.crossVectors(state.up, state.forward).normalize();
    planet.groundNormalAt!(state.position, PLAYER.groundNormalEpsilon, state.groundNormal);

    // Running takeoff completion: once we've reached takeoff speed with
    // wings out AND aim is still above ground, transition to flying. No
    // separate animation — the wings have already been flapping during
    // the run-up.
    if (
      state.wingExtension > 0.85 &&
      state.walkSpeed >= PLAYER.runningTakeoffSpeed * 0.95 &&
      aimAboveGround
    ) {
      enterFlyingFromGround(planet, state.walkSpeed, 0.3);
      return;
    }

    // Walking onto water → switch to swimming. heightAt < seaLevel
    // means terrain at this direction is below the water surface, so
    // we're standing in / on water.
    if (planet.hasOcean && isOverWater(planet, state.position)) {
      state.mode = "swimming";
      // Snap to the water surface so we don't keep using the (now
      // submerged) terrain position. Surface = planet.radius + seaLevel.
      snapToWaterSurface(planet);
      state.bank = 0;
      state.lastWarpFactor = 1;
      return;
    }

    state.bank = 0;
    state.lastWarpFactor = 1;
  }

  // ── Swimming ────────────────────────────────────────────────────────────
  // Spec: physics similar to walking, but the model sits slightly below
  // the surface and the top pre-takeoff cap is smaller. Diving requires
  // the player to angle straight down. The dive trigger ALSO works
  // during the running-takeoff equivalent here, so a fast swim that
  // angles down dives without slowing.
  function updateSwimming(input: Input, dt: number, planet: NonNullable<GravityContext["dominant"]>) {
    const mx = input.mouseX * 2 - 1;
    const my = -(input.mouseY * 2 - 1);

    planet.upAt(state.position, state.up);

    // Yaw — same convention as walking.
    if (Math.abs(mx) > 0.02) {
      const turnRate = -mx * 2.5 * dt;
      tmpQuat.setFromAxisAngle(state.up, turnRate);
      state.forward.applyQuaternion(tmpQuat);
      state.bodyRight.applyQuaternion(tmpQuat);
      reTangent(state.forward, state.up);
    }

    // Dive trigger: aim is well below horizontal. We compute the
    // aiming direction implicitly via forwardUp = state.forward · up.
    // Tilting the camera/aim down rotates state.forward downward
    // through the airborne pitch logic — but in swimming we don't
    // pitch the bird forward. Use mouse Y as the proxy: a very low
    // mouseY (deep dive zone at bottom) triggers a dive.
    if (my < PLAYER.swimDiveMouseThreshold && input.mouseY > 0.7) {
      beginDive(planet);
      return;
    }

    // Forward intent + acceleration, same shape as walking but with
    // swimSpeedMax as the cap.
    const forwardIntent = THREE.MathUtils.clamp(my, -1, 1);
    const targetSpeed = forwardIntent * PLAYER.swimSpeedMax;
    state.walkSpeed += (targetSpeed - state.walkSpeed) * Math.min(1, PLAYER.walkAccel * dt);

    tmpDelta.copy(state.forward).multiplyScalar(state.walkSpeed * dt);
    state.position.add(tmpDelta);

    // Snap to water surface (eye sits `swimSubmersion` below it).
    snapToWaterSurface(planet);

    // Leaving water (swam onto land) → switch back to walking.
    if (!isOverWater(planet, state.position)) {
      state.mode = "walking";
      const surface = planet.surfaceAt!(state.position, tmpDelta);
      planet.upAt(surface, state.up);
      state.position.copy(surface).addScaledVector(state.up, PLAYER.eyeHeight);
      planet.groundNormalAt!(state.position, PLAYER.groundNormalEpsilon, state.groundNormal);
    }

    state.bank = 0;
    state.lastWarpFactor = 1;
  }

  // Snap the bird's eye position to (water surface) − swimSubmersion.
  function snapToWaterSurface(planet: NonNullable<GravityContext["dominant"]>) {
    const localPos = tmpDelta;
    localPos.copy(state.position).sub(planet.worldPosition).applyQuaternion(planet.inverseOrientation);
    const dir = localPos.normalize();
    const waterR = planet.radius + planet.seaLevel - PLAYER.swimSubmersion;
    // World-space surface = waterR × planet.orientation × dir + planet.worldPos.
    tmpForward.copy(dir).applyQuaternion(planet.orientation).multiplyScalar(waterR);
    state.position.copy(tmpForward).add(planet.worldPosition);
    planet.upAt(state.position, state.up);
    reTangent(state.forward, state.up);
    state.bodyRight.crossVectors(state.up, state.forward).normalize();
    // groundNormal = water surface normal (smooth, == up).
    state.groundNormal.copy(state.up);
  }

  // ── Diving ──────────────────────────────────────────────────────────────
  // Brief animation that bridges swimming → underwater. Pitches forward
  // straight down through the dive phase so the underwater entry is
  // already nose-down.
  function beginDive(planet: NonNullable<GravityContext["dominant"]>) {
    planet.upAt(state.position, state.up);
    state.takeoffData = {
      startForward: state.forward.clone(),
      startBodyRight: state.bodyRight.clone(),
      // Target forward = straight down (opposite of up). Heading is
      // preserved via bodyRight.
      targetForward: state.up.clone().multiplyScalar(-1).normalize(),
      targetBodyRight: state.bodyRight.clone(),
      targetUp: state.up.clone(),
      useRocket: false,
    };
    state.divePhase = 0;
    state.mode = "diving";
  }

  function updateDiving(_input: Input, dt: number, planet: NonNullable<GravityContext["dominant"]>) {
    const data = state.takeoffData;
    if (!data) {
      state.mode = "swimming";
      return;
    }
    state.divePhase = Math.min(1, state.divePhase + dt / PLAYER.diveSeconds);
    const t = state.divePhase;
    const ease = 1 - (1 - t) * (1 - t);
    state.forward.copy(data.startForward).lerp(data.targetForward, ease).normalize();
    state.bodyRight.copy(data.startBodyRight).lerp(data.targetBodyRight, ease).normalize();
    state.bodyRight.addScaledVector(state.forward, -state.bodyRight.dot(state.forward)).normalize();

    // Sink slightly during the animation.
    state.position.addScaledVector(state.up, -PLAYER.swimSubmersion * dt * 3);

    if (state.divePhase >= 1) {
      state.takeoffData = null;
      state.divePhase = 0;
      state.mode = "underwater";
      state.wingSpeed = PLAYER.underwaterSpeed;
    }

    void planet;
    state.bank = 0;
    state.lastWarpFactor = 1;
  }

  // ── Underwater ──────────────────────────────────────────────────────────
  // Constant low speed, full 6-DOF aim. Surfacing happens when the bird
  // re-crosses the water surface from below while heading up.
  function updateUnderwater(input: Input, dt: number, planet: NonNullable<GravityContext["dominant"]>) {
    const mx = input.mouseX * 2 - 1;
    const my = -(input.mouseY * 2 - 1);
    planet.upAt(state.position, state.up);

    // Yaw around radial-up, pitch around bodyRight — same axes as
    // atmospheric flight in a dense medium.
    tmpQuat.setFromAxisAngle(state.bodyRight, -my * PLAYER.flyPitchRate * dt);
    state.forward.applyQuaternion(tmpQuat).normalize();
    tmpQuat.setFromAxisAngle(state.up, -mx * PLAYER.flyYawRate * dt);
    state.forward.applyQuaternion(tmpQuat).normalize();
    state.bodyRight.applyQuaternion(tmpQuat).normalize();
    state.bodyRight.addScaledVector(state.forward, -state.bodyRight.dot(state.forward)).normalize();

    // Constant locomotion speed forward.
    state.wingSpeed = PLAYER.underwaterSpeed;
    state.position.addScaledVector(state.forward, PLAYER.underwaterSpeed * dt);

    // Surfacing: if we've crossed back above the water surface AND
    // we're heading up, return to swimming.
    const localPos = tmpDelta;
    localPos.copy(state.position).sub(planet.worldPosition).applyQuaternion(planet.inverseOrientation);
    const dist = localPos.length();
    const waterR = planet.radius + planet.seaLevel;
    if (dist >= waterR - PLAYER.swimSubmersion && state.forward.dot(state.up) > 0) {
      state.mode = "swimming";
      snapToWaterSurface(planet);
    }

    state.bank = 0;
    state.lastWarpFactor = 1;

    void input;
  }

  // Detect whether the player is currently over a water surface.
  // heightAt returns the terrain height; if it's below seaLevel and
  // the body has an ocean, water fills the gap.
  function isOverWater(
    planet: NonNullable<GravityContext["dominant"]>,
    worldPos: THREE.Vector3,
  ): boolean {
    if (!planet.hasOcean || !planet.heightAt) return false;
    const localPos = tmpDelta;
    localPos.copy(worldPos).sub(planet.worldPosition).applyQuaternion(planet.inverseOrientation);
    const dir = tmpForward.copy(localPos).normalize();
    return planet.heightAt(dir) < planet.seaLevel;
  }

  // ── Jump takeoff ────────────────────────────────────────────────────────
  // Capture launch parameters at the moment of trigger and flip mode to
  // "takeoff". The actual interpolation happens in updateTakeoff; this
  // function only stages the starting / target frames.
  function beginJumpTakeoff(
    planet: NonNullable<GravityContext["dominant"]>,
    alpha: number,
  ): void {
    // Re-sample the ground normal so the launch direction respects the
    // exact slope under the bird at trigger time.
    planet.upAt(state.position, state.up);
    planet.groundNormalAt!(state.position, PLAYER.groundNormalEpsilon, state.groundNormal);

    const startForward = state.forward.clone();
    const startBodyRight = state.bodyRight.clone();

    // Target launch direction: perpendicular to GRAVITY-up (not ground
    // normal — using ground normal on a steep slope launches the bird
    // sideways), pitched slightly toward the current heading by
    // `jumpTakeoffPitchBelow` rad so the bird arcs forward rather than
    // launching straight up.
    const targetUp = state.up.clone(); // points away from planet center
    // Project current forward onto gravity-up's tangent plane to pick the
    // heading-aligned launch direction. Re-tangent then pitches it down
    // slightly so the bird actually moves forward as it climbs.
    const headingTangent = state.forward.clone();
    reTangent(headingTangent, targetUp);
    if (headingTangent.lengthSq() < 1e-6) {
      // Bird was looking straight up/down — pick an arbitrary tangent.
      const seed = Math.abs(targetUp.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 0, 1);
      headingTangent.copy(projectTangent(seed, targetUp)).normalize();
    } else {
      headingTangent.normalize();
    }
    // Launch direction: rotate targetUp `(π/2 - pitchBelow)` toward
    // headingTangent. That places it slightly below the vertical, in the
    // bird's heading. forward = up·cos(pitch) + heading·sin(pitch),
    // where pitch ∈ [0..π/2] measured from straight up.
    const launchPitchFromUp = (Math.PI / 2) - PLAYER.jumpTakeoffPitchBelow;
    const targetForward = new THREE.Vector3()
      .copy(targetUp).multiplyScalar(Math.cos(launchPitchFromUp))
      .addScaledVector(headingTangent, Math.sin(launchPitchFromUp))
      .normalize();
    // Target body-right: perpendicular to both targetForward and targetUp
    // (body-right is canonical screen-right when bird is upright in
    // gravity frame). This is what flips the bird right-side-up on a
    // steep slope where startBodyRight may be pointing sideways or
    // downward.
    const targetBodyRight = new THREE.Vector3()
      .crossVectors(targetUp, targetForward).normalize();

    state.takeoffData = {
      startForward,
      startBodyRight,
      targetForward,
      targetBodyRight,
      targetUp,
      useRocket: alpha < PLAYER.rocketRegimeAlpha,
    };
    state.takeoffPhase = 0;
    state.mode = "takeoff";
    state.wingExtension = 1; // jump-takeoff animation drives the visual sweep itself
  }

  // ── Takeoff animation ───────────────────────────────────────────────────
  function updateTakeoff(_input: Input, dt: number, planet: NonNullable<GravityContext["dominant"]>) {
    const data = state.takeoffData;
    if (!data) {
      // Defensive — should never happen, but if it does fall back to
      // walking so we don't get stuck in this mode.
      state.mode = "walking";
      return;
    }

    state.takeoffPhase = Math.min(1, state.takeoffPhase + dt / PLAYER.jumpTakeoffSeconds);
    const t = state.takeoffPhase;
    // Ease-out so the body's twist accelerates early then settles —
    // matches the wing-snap feel.
    const ease = 1 - (1 - t) * (1 - t);

    // Slerp forward + body-right between start and target attitudes. Use
    // separate slerps via quaternion-from-vectors so the body twists
    // around the shortest path even on a steep slope.
    state.forward.copy(data.startForward).lerp(data.targetForward, ease).normalize();
    state.bodyRight.copy(data.startBodyRight).lerp(data.targetBodyRight, ease).normalize();
    state.bodyRight.addScaledVector(state.forward, -state.bodyRight.dot(state.forward)).normalize();

    // Friction bleeds remaining ground speed during the animation — spec
    // says do NOT pause ground motion entirely, just slow it down.
    const frictionT = Math.min(1, PLAYER.jumpTakeoffGroundFriction * dt);
    state.walkSpeed *= 1 - frictionT;
    // Apply residual ground motion along the START forward so the bird
    // doesn't suddenly pivot mid-skid.
    tmpDelta.copy(data.startForward).multiplyScalar(state.walkSpeed * dt);
    state.position.add(tmpDelta);
    // Surface snap during the skid so we don't sink into the terrain.
    const surface = planet.surfaceAt!(state.position, tmpDelta);
    planet.upAt(surface, state.up);
    state.position.copy(surface).addScaledVector(state.up, PLAYER.eyeHeight);

    if (state.takeoffPhase >= 1) {
      // Animation complete — commit to flying with launch velocity.
      // jumpTakeoffSpeed along the target launch direction, plus the
      // planet's translational velocity so we stay in the planet's
      // frame (matching the running-takeoff path).
      enterFlyingFromGround(planet, PLAYER.jumpTakeoffSpeed, 1.5);
      state.takeoffData = null;
      state.takeoffPhase = 0;
    }

    state.bank = 0;
    state.lastWarpFactor = 1;
  }

  // Shared launch helper for both running and jumping takeoff. Lifts the
  // bird off the surface by enough to clear `landingAltitude` so the
  // auto-land guard in updateAirborne doesn't slam us back into walking
  // on the first airborne frame.
  function enterFlyingFromGround(
    planet: NonNullable<GravityContext["dominant"]>,
    launchSpeed: number,
    altitudeBoost: number,
  ): void {
    state.mode = "flying";
    state.position.addScaledVector(state.up, CONTROLS.landingAltitude + altitudeBoost);
    // Inherit planet's orbital translational velocity + forward launch.
    state.velocity.copy(planet.velocity).addScaledVector(state.forward, launchSpeed);
    // Seed wingSpeed so the asymmetric-friction inertia starts at our
    // actual launch speed rather than at zero (which would feel like
    // the wings instantly stalling on the first flight frame).
    state.wingSpeed = launchSpeed;
    state.walkSpeed = 0;
    state.wingExtension = 1; // wings stay spread for flight
  }

  // ── Flying / drifting ────────────────────────────────────────────────────
  function updateAirborne(input: Input, dt: number, ctx: GravityContext) {
    const mx = input.mouseX * 2 - 1;
    const my = -(input.mouseY * 2 - 1);
    // See updateWalking — screen-right turn is a NEGATIVE rotation around
    // +up, so yawInput is -mx. targetBank below uses -yawInput, which then
    // works out to +mx*flyBankAmount (positive bank for mouse-right), which
    // with our basis convention renders as a visual bank into the turn.
    const yawInput = -mx;
    const pitchInput = my;

    // ── Atmospheric density drives everything orientation-related ───────
    // Read this FIRST. It controls (a) which axis we yaw around, (b)
    // whether gravity-align kicks in, (c) drag, (d) warp factor, and (e)
    // bank visual amount. Outside any atmosphere (α=0) the player is in
    // free 6-DOF — no auto-orient, yaw around their own body-up.
    world.atmosphericDensityAt(state.position, _atmReading);
    const alpha = _atmReading.density;
    const atmBody = _atmReading.body;
    const inAtmosphere = atmBody !== null && alpha > 0.001;

    // Sample local gravity magnitude — needed for flight-strain math
    // below. Cached on state.lastGravityMag for HUD readout too.
    world.gravityAccelerationAt(state.position, _gravTmp);
    state.lastGravityMag = _gravTmp.length();

    // "Local up" reference for atmospheric flight: away from the atm body's
    // center. In free space, fall back to body-up so yaw still makes sense.
    if (inAtmosphere) {
      _atmUp.copy(state.position).sub(atmBody!.worldPosition).normalize();
    } else {
      _atmUp.crossVectors(state.forward, state.bodyRight).normalize();
    }

    // Pitch around the maintained body-right axis (no degeneracy).
    tmpQuat.setFromAxisAngle(state.bodyRight, -pitchInput * PLAYER.flyPitchRate * dt);
    state.forward.applyQuaternion(tmpQuat).normalize();

    // Yaw around the local "up" computed above.
    tmpQuat.setFromAxisAngle(_atmUp, yawInput * PLAYER.flyYawRate * dt);
    state.forward.applyQuaternion(tmpQuat).normalize();
    state.bodyRight.applyQuaternion(tmpQuat).normalize();
    state.bodyRight.addScaledVector(state.forward, -state.bodyRight.dot(state.forward)).normalize();

    // ── Object-readout auto-orient pull ────────────────────────────────
    // When the readout popup is open the hook returns a unit world-space
    // direction toward the focused body. We lerp `forward` toward that
    // direction at a soft rate so the bird visibly faces the body during
    // approach without overriding the player's own steering.
    if (readoutHook) {
      const dir = readoutHook();
      if (dir) {
        _readoutPullDir.copy(dir);
        const k = Math.min(1, READOUT.birdPull * dt);
        state.forward.lerp(_readoutPullDir, k).normalize();
        // Re-orthogonalize bodyRight against the new forward so the
        // basis stays valid (avoids tweaking pitch/yaw input axes mid-
        // frame).
        state.bodyRight.addScaledVector(state.forward, -state.bodyRight.dot(state.forward)).normalize();
      }
    }

    // Gravity-align — ONLY when in atmosphere. Outside atmosphere the body
    // keeps whatever orientation the player has set; "down" doesn't exist.
    // Previously this used ctx.influence which made the star "down" the
    // moment a planet's gravity faded, even though the star's atmosphere
    // wasn't reaching the player.
    if (inAtmosphere) {
      tmpRight.crossVectors(_atmUp, state.forward).normalize();
      const rate = Math.min(1, CONTROLS.gravityAlignRate * alpha * dt);
      state.bodyRight.lerp(tmpRight, rate).normalize();
      state.bodyRight.addScaledVector(state.forward, -state.bodyRight.dot(state.forward)).normalize();
    }

    // Bank visual — fades with α so deep-space turning doesn't bank.
    const targetBank = -yawInput * PLAYER.flyBankAmount * alpha;
    state.bank += (targetBank - state.bank) * Math.min(1, 4 * dt);

    // ── Speed model ─────────────────────────────────────────────────────
    // Speed is a SINGLE quantity, computed from altitude (with floor +
    // brakes) and blended with the separate warp regime. Wing vs rocket
    // is a purely visual choice based on what the bird would need to
    // do to maintain this speed at the local α and gravity — they
    // don't compete for "best speed", they share the same number.
    //
    //   altSpeed = sqrt(2 × A × h)      — physical: speed reached by
    //                                     coasting up from rest under A
    //   target   = max(MIN_FLIGHT_SPEED, altSpeed)
    //
    // wingSpeed (inertial) lerps toward target with asymmetric climb /
    // dive friction so dives carry momentum past the target and climbs
    // are anchored firmly.
    const alphaNorm = world.atmosphericAlphaAt(state.position);
    const alphaClamped = Math.max(0, Math.min(1, alphaNorm));

    const forwardUp = state.forward.dot(_atmUp);
    const climbT = (forwardUp + 1) * 0.5;

    const { body: nearestBody, altitude: nearestAlt } = world.nearestBodyAltitudeAt(state.position);
    // altitude may be > 0 even when nearestBody is null (galactic mode
    // fallback returns distance to nearest registry star). Use the
    // altitude value directly so baseSpeed grows with distance in
    // interstellar space too — otherwise targetSpeed stays clamped at
    // MIN_FLIGHT_SPEED and hyperMult-driven travel feels broken.
    const altSpeed = nearestAlt > 0 && Number.isFinite(nearestAlt)
      ? Math.sqrt(2 * SPEED.ALTITUDE_ACCEL_FACTOR * nearestAlt)
      : 0;
    const targetSpeed = Math.max(SPEED.MIN_FLIGHT_SPEED, altSpeed);

    // Asymmetric climb/dive friction toward `targetSpeed`. Climbs are
    // firm (anchors the upward cap); dives are gentle (carry momentum
    // through the bottom of a swoop); a climb whose wingSpeed is still
    // above target gets the swoop-softened friction so swoop reads as a
    // natural carry rather than a snap-cap. Atmosphere multiplies the
    // friction rate — in vacuum, no drag, so wingSpeed snaps to target.
    // ── Lock-on candidate (separate from hyperMult — only adds an
    //    approach-cap as you near the locked body). ──────────────────────
    // Same forward-cone candidate-picker as before; lock builds while
    // the player keeps the same body in the cone, decays when they
    // look away. Doesn't reorient — only caps desired speed during
    // approach.
    const inSpace = alphaClamped < SPEED.HYPER_SPACE_ALPHA;
    if (inSpace) {
      const candidate = pickLockCandidate(
        state.position,
        state.forward,
        world.bodies,
        SPEED.HYPER_CONE_COS,
        state.lockedBodyId,
      );
      if (candidate && state.lockedBodyId === candidate.id) {
        state.lockProgress = Math.min(1, state.lockProgress + dt / SPEED.HYPER_LOCK_TIME);
      } else if (candidate) {
        state.lockedBodyId = candidate.id;
        state.lockProgress = 0;
      } else {
        state.lockProgress = Math.max(0, state.lockProgress - dt / SPEED.HYPER_LOCK_DECAY);
        if (state.lockProgress <= 0) state.lockedBodyId = null;
      }
    } else {
      // In atmosphere — drop any lock fast.
      state.lockProgress = Math.max(0, state.lockProgress - dt / SPEED.HYPER_LOCK_DECAY);
      if (state.lockProgress <= 0) state.lockedBodyId = null;
    }

    // ── Warp-inhibition gate (gravity- and atmosphere-derived). ─────────
    // The hyperMult multiplier is gated by space-emptiness — in dense
    // atmosphere or deep in a body's gravity well, the multiplier's
    // contribution is suppressed and the desired speed reverts to
    // baseSpeed. In deep space, the multiplier is fully available.
    //
    //   atmFactor  = (1 - α)^WARP_GATE_POWER         — 0 in atm, 1 in vacuum
    //   gravFactor = 1 - (R_dom / r_dom)^N           — 0 at surface, 1 at infinity
    //   spaceMult  = atmFactor × gravFactor          — fully open in deep space
    //
    // The hill sphere is approximately the locus where (R/r)² matches
    // between parent and child bodies, so the gravFactor flips smoothly
    // when the dominant body changes — no flicker.
    const dominant = world.dominantBodyAt(state.position);
    const dominantBody = dominant.body;
    const hillFraction = dominant.hillFraction;
    let warpInhibition = 0;
    let warpDomGate = 1;
    if (dominantBody) {
      const r = Math.max(dominantBody.radius, dominant.altitude + dominantBody.radius);
      const ratio = dominantBody.radius / r;
      warpInhibition = Math.pow(ratio, SPEED.WARP_INHIBITION_POWER);
      warpDomGate = 1 - warpInhibition;
    }
    const atmFactor = Math.pow(Math.max(0, 1 - alphaClamped), SPEED.WARP_GATE_POWER);
    const spaceMult = THREE.MathUtils.clamp(atmFactor * warpDomGate, 0, 1);

    // ── HyperMult — gaze-driven speed multiplier (intent). ──────────────
    // Gain scales with spaceMult: hyperMult only builds when it would
    // actually contribute to speed (high enough altitude / thin enough
    // atmosphere). Without this, the player can "load up" hyperMult
    // while hovering near an airless body's surface where it has no
    // visible effect, then shoot off when they climb and the gate opens.
    // Decay rate scales with how far off-center the gaze is — slight
    // drift bleeds slowly, looking at the screen edge bleeds sharply.
    {
      const mxn = (input.mouseX - 0.5) * 2;
      const myn = (input.mouseY - 0.5) * 2;
      const gazeOffset = Math.hypot(mxn, myn);
      if (inSpace && gazeOffset < SPEED.HYPER_CENTER_THRESHOLD) {
        // Gain rate × sqrt(spaceMult) — softer suppression than linear
        // so low-orbit flight still builds hyperMult at a reasonable
        // pace (sqrt(0.05) = 0.22 → ~22% gain rate at 154 km on Earth)
        // while ground-level (spaceMult ≈ 0) still gets no growth.
        const gainScale = Math.sqrt(spaceMult);
        state.hyperMult *= Math.exp(SPEED.HYPER_GAIN_RATE * gainScale * dt);
      } else {
        // Decay rate × gaze offset × (1 + log10(mult)): higher current
        // hyperMult bleeds faster for the same gaze drift, so a sharp
        // u-turn drops out of hyperdrive quickly regardless of current
        // speed. log scaling keeps decay manageable at low mult while
        // making interstellar speeds responsive to intent.
        const off = Math.max(0, gazeOffset - SPEED.HYPER_CENTER_THRESHOLD);
        const speedScale = 1 + Math.log10(state.hyperMult);
        state.hyperMult *= Math.exp(-SPEED.HYPER_LOSS_RATE * off * speedScale * dt);
      }
      if (state.hyperMult < 1) state.hyperMult = 1;
    }

    const effectiveHyperMult = 1 + (state.hyperMult - 1) * spaceMult;

    // Galactic-density cap: cap is HYPER_MAX_SPEED at the reference
    // density (rough solar-position disc density), boosted up to
    // ×GALACTIC_DENSITY_BOOST in sparse regions (outer arms,
    // intergalactic). Lower local density → higher cap → faster
    // cross-galaxy travel. The boost factor is interpolated linearly
    // in `ref / (ref + local)` so it asymptotes smoothly.
    const localGalacticDensity = world.galacticDensityAt(state.position);
    const densityFactor = SPEED.GALACTIC_REFERENCE_DENSITY
      / (SPEED.GALACTIC_REFERENCE_DENSITY + localGalacticDensity);
    const densityBoost = 1 + (SPEED.GALACTIC_DENSITY_BOOST - 1) * densityFactor;
    const effectiveMaxSpeed = SPEED.HYPER_MAX_SPEED * densityBoost;

    // Desired speed = baseSpeed × (gated) hyperMult, capped at the
    // density-scaled hyper limit.
    let desiredSpeed = Math.min(targetSpeed * effectiveHyperMult, effectiveMaxSpeed);

    // Lock-on approach cap: caps both desired AND wingSpeed itself.
    // When the cap is actively reducing speed, it CONSUMES hyperMult
    // at HYPER_BRAKE_RATE — the brake is real. If lock breaks, the
    // bird's accumulated hyperMult is already low, so speed doesn't
    // snap back up. Without this, releasing the lock instantly
    // re-accelerates the bird because hyperMult is still huge.
    let lockBlendedCap = Infinity;
    if (state.lockedBodyId && state.lockProgress > 0) {
      const tgt = findBodyById(world.bodies, state.lockedBodyId);
      if (tgt) {
        const distToTarget = state.position.distanceTo(tgt.worldPosition);
        const lockCap = SPEED.LOCK_APPROACH_RATE * SPEED.LOCK_APPROACH_BOOST
          * Math.max(0, distToTarget - tgt.radius);
        lockBlendedCap = Math.min(effectiveMaxSpeed, lockCap / state.lockProgress);
        if (lockBlendedCap < desiredSpeed) {
          // Brake is actively engaged — consume hyperMult so the
          // slowdown is permanent, not just a temporary cap. Scale
          // decay rate by 1 + log10(hyperMult) so massive stored
          // mults drain fast (so they can't "store up" while the
          // bird approaches slowly and then erupt when lock breaks)
          // while small mults still drain at the tuned BRAKE_RATE.
          const brakeScale = 1 + Math.log10(state.hyperMult);
          state.hyperMult *= Math.exp(-SPEED.HYPER_BRAKE_RATE * brakeScale * dt);
          if (state.hyperMult < 1) state.hyperMult = 1;
          // Recompute desired with the now-reduced hyperMult, then
          // apply the cap. Subsequent frames see the lower hyperMult
          // and naturally lower desired.
          const newEffective = 1 + (state.hyperMult - 1) * spaceMult;
          desiredSpeed = Math.min(targetSpeed * newEffective, effectiveMaxSpeed);
          if (lockBlendedCap < desiredSpeed) desiredSpeed = lockBlendedCap;
        }
      }
    }

    // Inertial integration — accelerate toward desired. No friction
    // term: the gate above already suppresses hyperMult near bodies, so
    // baseSpeed is always achievable (atm cap = baseSpeed) and the only
    // way to slow is the desired dropping (gate closing or lock cap).
    const accelStep = 1 - Math.exp(-SPEED.HYPER_ACCEL_RATE * dt);
    state.wingSpeed += (desiredSpeed - state.wingSpeed) * accelStep;
    if (state.wingSpeed < 0) state.wingSpeed = 0;
    // Hard cap on actual speed when locked — prevents momentum
    // overshoot on approach.
    if (state.wingSpeed > lockBlendedCap) state.wingSpeed = lockBlendedCap;

    let totalSpeed = state.wingSpeed;

    // Low-altitude safety brake. Spec: "This is a special cap unrelated
    // to atmospheric pressure and is intended to prevent crashing rather
    // than representing physical limitations" + "Close-to-ground friction
    // should be applied gradually while slowing down (don't hard-cap
    // speed)." Applies to the TOTAL three-mode speed (wing/rocket/warp
    // blend) — not just wingSpeed — so rocket-mode approach over a moon
    // also feels the brake. We bleed wingSpeed (the inertial component)
    // AND clamp totalSpeed in the same step so the blend can't outrun
    // the brake.
    let lowAltCap = Infinity;
    let obstacleClearance = Infinity;
    if (nearestBody && nearestBody.walkable) {
      obstacleClearance = computeObstacleClearance(nearestBody, state.position);
      lowAltCap =
        PLAYER.flyLowAltCap *
        (1 + Math.max(0, obstacleClearance) / PLAYER.flyLowAltClearScale);
      if (totalSpeed > lowAltCap) {
        // Friction strength scales with how far over the cap we are.
        const overshootRatio = (totalSpeed - lowAltCap) / Math.max(1, lowAltCap);
        const frictionRate = Math.min(
          PLAYER.flyLowAltMaxFriction,
          PLAYER.flyLowAltFrictionBase * (1 + overshootRatio),
        );
        const step = Math.min(1, frictionRate * dt);
        if (state.wingSpeed > lowAltCap) {
          state.wingSpeed += (lowAltCap - state.wingSpeed) * step;
        }
        totalSpeed += (lowAltCap - totalSpeed) * step;
      }
    }

    // (Removed: the legacy "300 kph winged flight cap" on upward
    // component of totalSpeed. It belonged to the wing-only model
    // where flight speed = wingCap × α; in the new altitude-target
    // model it was clamping the climb-rate band around ~100 m/s and
    // preventing the bird from ever reaching altitudes where the
    // target speed grows past it. The altitude formula itself
    // naturally limits low-altitude speed.)

    // ── Flight strain ───────────────────────────────────────────────────
    // Single 0..1 factor used by visual systems. Captures how hard the
    // bird is working against gravity / thin air. Combines:
    //   vacuum   → (1 - α) contribution (wings can't push thin air)
    //   climb    → climbT in atmosphere (gravity resistance)
    //   gravity  → (gravNorm - 1) in atmosphere (high-G worlds)
    const gravNorm = state.lastGravityMag / 9.81;
    const climbContribution =
      (climbT - 0.5) * 2 * SPEED.STRAIN_CLIMB_WEIGHT * alphaClamped; // [-W, +W] × α
    const vacuumContribution = (1 - alphaClamped) * SPEED.STRAIN_VACUUM_WEIGHT;
    const gravityContribution =
      Math.max(0, gravNorm - 1) * SPEED.STRAIN_GRAVITY_WEIGHT * alphaClamped;
    state.flightStrain = THREE.MathUtils.clamp(
      vacuumContribution + climbContribution + gravityContribution,
      0,
      1,
    );

    // ── Visual wing / rocket split ──────────────────────────────────────
    // Speed is one number; the visual question is which propulsion the
    // bird would NEED to maintain it at the local α and gravity. Wings
    // generate thrust proportional to α; required thrust scales with
    // gravity. When (WING_LIFT_THRESHOLD × α) drops below gravNorm,
    // wings can't keep up and rockets pick up the slack:
    //
    //   rocketRegimeWeight = clamp(0, 1, 1 - WING_LIFT_THRESHOLD × α / gravNorm)
    //
    // Default WING_LIFT_THRESHOLD = 6 puts the visual transition at
    // α ≈ 1/6 ≈ 0.17 on Earth, which lands at ~15 km via Earth's
    // ~8400 m scale height. Heavier-gravity / thinner-atm worlds shift
    // the transition naturally — no magic per-body tuning.
    const gravForVis = Math.max(0.01, gravNorm);
    state.rocketRegimeWeight = THREE.MathUtils.clamp(
      1 - (SPEED.WING_LIFT_THRESHOLD * alphaClamped) / gravForVis,
      0,
      1,
    );

    // lastModeWeights / activeMode: warp share derived from how much
    // of the current speed is above the natural baseSpeed (i.e. how
    // much hyperMult is contributing). wing + rocket + warp sum to 1.
    const warpRatio = totalSpeed > 1
      ? Math.max(0, Math.min(1, 1 - targetSpeed / totalSpeed))
      : 0;
    state.lastModeWeights.warp = warpRatio;
    state.lastModeWeights.rocket = (1 - warpRatio) * state.rocketRegimeWeight;
    state.lastModeWeights.wing = (1 - warpRatio) * (1 - state.rocketRegimeWeight);
    if (state.lastModeWeights.warp >= state.lastModeWeights.wing && state.lastModeWeights.warp >= state.lastModeWeights.rocket) {
      state.activeMode = "warp";
    } else if (state.lastModeWeights.rocket >= state.lastModeWeights.wing) {
      state.activeMode = "rocket";
    } else {
      state.activeMode = "wing";
    }

    // Populate debug snapshot for HUD readouts.
    state.flightDebug.vWing = state.wingSpeed;
    state.flightDebug.targetSpeed = targetSpeed;
    state.flightDebug.altSpeed = altSpeed;
    state.flightDebug.desiredSpeed = desiredSpeed;
    state.flightDebug.totalSpeed = totalSpeed;
    state.flightDebug.climbT = climbT;
    state.flightDebug.forwardUp = forwardUp;
    state.flightDebug.warpInhibition = warpInhibition;
    state.flightDebug.warpGate = spaceMult;
    state.flightDebug.hillFraction = hillFraction;
    state.flightDebug.dominantBodyId = dominantBody ? dominantBody.id : null;
    state.flightDebug.dominantAlt = dominant.altitude;
    state.flightDebug.dominantHillRadius = dominantBody ? dominantBody.hillRadius : Infinity;
    state.flightDebug.nearestBodyId = nearestBody ? nearestBody.id : null;
    state.flightDebug.nearestAlt = nearestAlt;
    state.flightDebug.nearestHillRadius = nearestBody ? nearestBody.hillRadius : Infinity;
    state.flightDebug.obstacleClearance = obstacleClearance;
    state.flightDebug.lowAltCap = lowAltCap;
    state.flightDebug.upwardSpeed = totalSpeed * Math.max(0, forwardUp);
    state.lastAtmAlpha = alphaClamped;

    state.lastWarpFactor = Math.max(1, totalSpeed / Math.max(1, PLAYER.flySpeed));
    state.lastThrustBoost = 1;

    // Snap warpVelocity to forward × totalSpeed each frame. Wing inertia
    // is carried by `state.wingSpeed` (above); rocket and warp are
    // inertialess so the snap is honest for them.
    state.warpVelocity.copy(state.forward).multiplyScalar(totalSpeed);
    if (ctx.dominant) {
      state.velocity.copy(ctx.dominant.velocity);
    } else {
      state.velocity.set(0, 0, 0);
    }

    state.position.addScaledVector(state.velocity, dt);
    state.position.addScaledVector(state.warpVelocity, dt);

    // Update local up. With a dominant body, snap to the radial-from-
    // center direction (planet/star surface "up"). With no dominant
    // body (GALACTIC frame, interstellar transit) we FREEZE state.up
    // at whatever value it last had — typically the radial-from-the-
    // star-we-just-left. This keeps the chase camera trailing in a
    // stable direction throughout interstellar transit instead of
    // drifting as the bird pitches/yaws (body-up = forward×bodyRight
    // tilts with attitude, which is what was causing the camera to
    // "shift above" when leaving a system). When the player enters a
    // new star's domain, state.up snaps to the new radial — same as
    // entering for the first time.
    if (ctx.dominant) {
      ctx.dominant.upAt(state.position, state.up);
    }

    // Ground contact. Stars and gas planets have an altitude but no
    // terrain to walk on — flying into one should pass through rather
    // than land (damage / "you flew into a star" effects are a future
    // concern).
    if (ctx.dominant && ctx.dominant.walkable) {
      const alt = ctx.dominant.altitudeAt(state.position);
      if (alt < CONTROLS.landingAltitude) {
        resolveGroundImpact(ctx.dominant);
      }
    }
  }

  // ── Ground impact resolution ────────────────────────────────────────────
  // Spec: on impact, compute collision energy and landing quality. Pick
  // one of {land, stun-bad-angle, bounce, stun-high-speed} and apply
  // the matching transition.
  //
  // The impact speed used here is `wingSpeed` (the inertial drive
  // magnitude). State.velocity carries only the planet's translational
  // frame, so we don't include it. The bird's effective ground speed
  // relative to the planet IS state.wingSpeed.
  function resolveGroundImpact(planet: NonNullable<GravityContext["dominant"]>) {
    // Sample fresh ground normal at the impact point.
    planet.upAt(state.position, state.up);
    planet.groundNormalAt!(state.position, PLAYER.groundNormalEpsilon, state.groundNormal);

    // Water-impact branches BEFORE the ground-landing dispatch.
    //   Steep angle into water → enter underwater directly (the bird
    //     dives through the surface using its momentum).
    //   Shallow angle → settle into swimming.
    if (isOverWater(planet, state.position)) {
      const forwardDot = state.forward.dot(state.up);
      if (forwardDot < PLAYER.waterDiveImpactDot) {
        state.mode = "underwater";
        state.takeoffData = null;
        state.divePhase = 0;
        state.wingSpeed = Math.max(PLAYER.underwaterSpeed, state.wingSpeed * 0.5);
        state.wingExtension = 0;
        snapToWaterSurface(planet);
        // Push the bird below the surface a bit so the surfacing check
        // doesn't immediately bounce us back up.
        state.position.addScaledVector(state.up, -0.5);
        state.bank = 0;
        return;
      }
      state.mode = "swimming";
      state.wingExtension = 0;
      state.wingSpeed = 0;
      state.walkSpeed = 0;
      snapToWaterSurface(planet);
      state.bank = 0;
      return;
    }

    // Bird's body-up axis (the spine direction; legs point opposite).
    // High dot with ground normal means belly-down / feet-down — good
    // landing posture.
    tmpUp.crossVectors(state.forward, state.bodyRight).normalize();
    const angleDot = tmpUp.dot(state.groundNormal);

    const impactSpeed = state.wingSpeed;

    // Snap position to terrain + eye height so subsequent frames don't
    // re-detect the same impact.
    const surface = planet.surfaceAt!(state.position, tmpDelta);
    state.position.copy(surface).addScaledVector(state.up, PLAYER.eyeHeight);

    if (impactSpeed > PLAYER.landStunSpeed) {
      // Too fast — stun regardless of angle. Bird is launched along the
      // reflected direction at retained energy; momentum + gravity take
      // over for the duration.
      bounceVelocity(state, PLAYER.bounceRetention);
      state.mode = "stunned";
      state.stunnedTime = PLAYER.stunDurationHighSpeed;
      state.wingExtension = 0;
      state.bank = 0;
      // TODO: spawn dust particles in ground color (spec line 56).
    } else if (impactSpeed > PLAYER.landBounceSpeed) {
      // High but not stunning. Bounce off the surface, keep flying.
      bounceVelocity(state, PLAYER.bounceRetention);
      state.bank = 0;
    } else if (angleDot < PLAYER.landGoodAngleDot) {
      // Bad-angle low-speed touch: stun briefly, body tumbles.
      state.wingSpeed *= 0.3; // most energy absorbed by the bad landing
      state.mode = "stunned";
      state.stunnedTime = PLAYER.stunDurationBadAngle;
      state.wingExtension = 0;
      state.bank = 0;
    } else {
      // Good-angle low-speed: clean landing. Drop straight into the
      // running-takeoff state so the player can immediately accelerate
      // back into the air without re-jumping. Inherits forward
      // direction tangent to the surface.
      state.mode = "walking";
      state.wingExtension = 1; // soft landing into running-takeoff with wings still out
      state.walkSpeed = Math.min(impactSpeed, PLAYER.runningTakeoffSpeed);
      reTangent(state.forward, state.up);
      state.bodyRight.crossVectors(state.up, state.forward).normalize();
      state.bank = 0;
    }
  }

  // Reflect the bird's effective velocity off the ground normal and
  // multiply by `retain` (0..1) for energy loss. Implemented on
  // wingSpeed + forward: redirect forward to the reflected direction,
  // scale wingSpeed by `retain`. Lift the bird up off the surface by a
  // small offset so the very next frame isn't still under landingAltitude.
  function bounceVelocity(s: PlayerState, retain: number) {
    const dot = s.forward.dot(s.groundNormal);
    if (dot < 0) {
      // Reflect: f' = f - 2 (f·n) n
      tmpDelta.copy(s.groundNormal).multiplyScalar(-2 * dot);
      s.forward.add(tmpDelta).normalize();
      // Re-orthogonalize bodyRight against the new forward.
      s.bodyRight.addScaledVector(s.forward, -s.bodyRight.dot(s.forward)).normalize();
    }
    s.wingSpeed *= retain;
    s.position.addScaledVector(s.up, CONTROLS.landingAltitude + 0.5);
  }

  // ── Stunned ─────────────────────────────────────────────────────────────
  // Player input is ignored. The bird is in ballistic flight — gravity
  // accelerates it, residual wingSpeed coasts along the (frozen)
  // forward direction. When the stun timer expires AND the bird is on
  // (or near) the ground, transition into walking from a rest. If still
  // airborne when the timer expires, flip back to flying so the player
  // regains control.
  function updateStunned(dt: number, ctx: GravityContext) {
    state.stunnedTime = Math.max(0, state.stunnedTime - dt);

    // Apply real gravity to wingSpeed direction over time. We model
    // gravity by adding gravity-down to a working velocity built from
    // wingSpeed × forward, then split it back into magnitude +
    // direction at the end. This makes the bird arc instead of moving
    // in a straight line.
    if (ctx.dominant) {
      world.gravityAccelerationAt(state.position, tmpDelta);
      // Working velocity in the planet's frame: wingSpeed × forward.
      tmpForward.copy(state.forward).multiplyScalar(state.wingSpeed);
      tmpForward.addScaledVector(tmpDelta, dt);
      const newSpeed = tmpForward.length();
      if (newSpeed > 1e-3) {
        state.forward.copy(tmpForward).divideScalar(newSpeed);
      }
      state.wingSpeed = newSpeed;
    }

    // Position advance — planet translational frame + own drift.
    if (ctx.dominant) state.velocity.copy(ctx.dominant.velocity);
    state.warpVelocity.copy(state.forward).multiplyScalar(state.wingSpeed);
    state.position.addScaledVector(state.velocity, dt);
    state.position.addScaledVector(state.warpVelocity, dt);

    // Ground re-contact during stun is treated as a non-controlled
    // landing — additional bounces or final settle.
    if (ctx.dominant && ctx.dominant.walkable) {
      const alt = ctx.dominant.altitudeAt(state.position);
      if (alt < CONTROLS.landingAltitude) {
        if (state.wingSpeed > PLAYER.landBounceSpeed) {
          // Still going too fast — bounce again, keep stunned.
          planet_groundNormal_refresh(ctx.dominant);
          bounceVelocity(state, PLAYER.bounceRetention * 0.5);
        } else {
          // Settle. Force position to surface and end the stun once the
          // timer expires; in the meantime stay grounded but inert.
          planet_groundNormal_refresh(ctx.dominant);
          state.wingSpeed *= 0.5;
          const surface = ctx.dominant.surfaceAt!(state.position, tmpDelta);
          state.position.copy(surface).addScaledVector(state.up, PLAYER.eyeHeight);
          if (state.stunnedTime <= 0) {
            state.mode = "walking";
            state.walkSpeed = 0;
            state.wingExtension = 0;
            return;
          }
        }
      }
    }

    if (state.stunnedTime <= 0) {
      // Time's up and we're not on the ground — return control to the
      // player in flight.
      state.mode = "flying";
    }

    state.lastWarpFactor = 1;
    state.lastThrustBoost = 1;
  }

  function planet_groundNormal_refresh(planet: NonNullable<GravityContext["dominant"]>) {
    planet.upAt(state.position, state.up);
    planet.groundNormalAt!(state.position, PLAYER.groundNormalEpsilon, state.groundNormal);
  }

  // ── Wing-flap + sweep animation ─────────────────────────────────────────
  // Flap and sweep are two separate degrees of freedom on each wing
  // pivot, composed via a quaternion. Behaviour:
  //
  //   • Climbing (forward·up > 0): wings flap with rate and amplitude
  //     scaling with the climb angle. Stronger climbs → bigger, faster
  //     beats. No flap when not climbing.
  //   • Diving (forward·up < 0): wings sweep BACK around the body's up
  //     axis, like a stooping raptor. Flap is suppressed in proportion.
  //   • Rocket-boosting (boost > 1): also sweeps back — the bird is
  //     "tucked" while rocket thrust takes over. Flap suppressed.
  //
  // The flap is applied first, sweep second, so as the wing folds back
  // it pivots cleanly around the body's vertical axis from its flapped
  // pose. Note: the wing mesh is parented INSIDE the pivot — pivot
  // quaternion drives where the wing-tip ends up; the mesh itself only
  // carries the static -π/2 base orientation.
  function updateWings(dt: number) {
    let sweepAngle = 0;
    let flap = 0;

    if (state.mode === "walking") {
      // Continuous regime: wingExtension 0 → fully tucked, 1 → spread
      // and flapping for the running takeoff. Sweep angle slerps
      // between the two poses; flap rate / amplitude scale with
      // extension AND walk speed so the run-up visibly unfolds the
      // wings rather than snapping them out.
      const speedFrac = Math.min(1, state.walkSpeed / PLAYER.runningTakeoffSpeed);
      const ext = state.wingExtension;
      sweepAngle = (1 - ext) * 1.45; // 0 → 1.45 across extension
      if (ext > 0.05) {
        const flapHz = 2.5 + speedFrac * 3.5;
        state.flapPhase += flapHz * 2 * Math.PI * dt * ext;
        flap = Math.sin(state.flapPhase) * (0.4 + speedFrac * 0.4) * ext;
      }
    } else if (state.mode === "takeoff") {
      // 250 ms jump-takeoff animation: wings snap from folded to spread,
      // then beat once. takeoffPhase 0..1 drives both unfold and flap.
      const t = state.takeoffPhase;
      sweepAngle = (1 - t) * 1.45; // unfold from tucked to fully spread
      // One big down-stroke over the whole animation (sin from 0 → π).
      flap = Math.sin(t * Math.PI) * 0.9;
    } else {
      // Airborne (flying / drifting). Wing fold-back is driven by
      // EITHER a steep dive (raptor-stoop pose) OR the visual
      // rocket-regime weight (rocketRegimeWeight + warpRatio tucks
      // the wings). Flap rate / amplitude scale with wingWeight so
      // beats slow down + shrink together as rocket mode takes over.
      // Strain modulates how hard the wings work while in the wing
      // regime — thin air / high-G / climbing all increase strain.
      const forwardUp = state.forward.dot(state.up);
      const diveStrength = Math.max(0, -forwardUp);
      const nonWingMode = state.lastModeWeights.rocket + state.lastModeWeights.warp;
      const sweepFrac = Math.max(diveStrength, nonWingMode);
      sweepAngle = sweepFrac * 1.25;

      const wingWeight = state.lastModeWeights.wing;
      const strain = state.flightStrain;
      if (strain > 0.02 && sweepFrac < 0.8 && wingWeight > 0.05) {
        const flapHz = (0.8 + strain * 5.5) * wingWeight;
        state.flapPhase += flapHz * 2 * Math.PI * dt;
        const amp = strain * 0.7 * (1 - sweepFrac) * wingWeight;
        flap = Math.sin(state.flapPhase) * amp;
      }
    }

    // Left wing: flap negative around forward (tip up), sweep negative
    // around up (wing folds back). Right wing mirrors both signs.
    _flapQuat.setFromAxisAngle(_flapAxis, -flap);
    _sweepQuat.setFromAxisAngle(_sweepAxis, -sweepAngle);
    wingLPivot.quaternion.multiplyQuaternions(_sweepQuat, _flapQuat);
    _flapQuat.setFromAxisAngle(_flapAxis, flap);
    _sweepQuat.setFromAxisAngle(_sweepAxis, sweepAngle);
    wingRPivot.quaternion.multiplyQuaternions(_sweepQuat, _flapQuat);
  }

  // ── Rocket-trail particles ──────────────────────────────────────────────
  // Particles live in BIRD-LOCAL space (positions/velocities relative
  // to the bird's transform). The Points geometry is a child of the
  // bird's `object`, so three.js applies the bird's world transform
  // automatically when rendering. Bird-local +Z is forward, so the
  // trail emits at local Z ≈ -0.65 (tail) and drifts toward more
  // negative Z (further behind).
  //
  // Emission is gated on atmospheric density: NO particles in dense
  // atmosphere, ramping up as α drops below ~0.4. This makes the
  // particles a visual indicator of being in the "space thrust" regime
  // — visible on the moon and similar thin-atm bodies, in upper
  // atmosphere on rocky planets, and in vacuum.
  const _atmGate: AtmosphericReading = { density: 0, body: null };
  function updateThrustParticles(dt: number) {
    // Advance existing particles in local space.
    for (let i = 0; i < THRUST_PARTICLES; i++) {
      if (thrustLifetimes[i] <= 0) {
        thrustColors[i * 3 + 0] = 0;
        thrustColors[i * 3 + 1] = 0;
        thrustColors[i * 3 + 2] = 0;
        continue;
      }
      thrustLifetimes[i] -= dt;
      const o = i * 3;
      thrustPositions[o + 0] += thrustVelocities[o + 0] * dt;
      thrustPositions[o + 1] += thrustVelocities[o + 1] * dt;
      thrustPositions[o + 2] += thrustVelocities[o + 2] * dt;
      const fade = Math.max(0, thrustLifetimes[i] / THRUST_LIFE);
      // Hot yellow-white core → orange → dark red as life shortens.
      thrustColors[o + 0] = fade;
      thrustColors[o + 1] = fade * fade * 0.7;
      thrustColors[o + 2] = fade * fade * fade * 0.2;
    }

    // Emit when the bird is in flying mode AND the rocket weight from
    // the three-mode blend is non-trivial — OR during a rocket-takeoff
    // (jumping takeoff in an airless world fires rockets instead of
    // wings). This ties the visual directly to the propulsion mode the
    // player is actually in.
    const rocketTakeoff = state.mode === "takeoff" && state.takeoffData?.useRocket === true;
    if (state.mode === "flying" || rocketTakeoff) {
      const emitIntensity = rocketTakeoff ? 1 : state.lastModeWeights.rocket;
      if (emitIntensity > 0.05) {
        const emitRate = emitIntensity * 110;
        thrustSpawnAccumulator += emitRate * dt;
        let toSpawn = Math.floor(thrustSpawnAccumulator);
        thrustSpawnAccumulator -= toSpawn;
        // Spawn in bird-local space at the tail. Backward drift in -Z.
        const lateral = 0.15;
        const back = 18;
        for (let i = 0; i < THRUST_PARTICLES && toSpawn > 0; i++) {
          if (thrustLifetimes[i] > 0) continue;
          thrustLifetimes[i] = THRUST_LIFE;
          const o = i * 3;
          thrustPositions[o + 0] = (Math.random() - 0.5) * lateral;
          thrustPositions[o + 1] = 0.05 + (Math.random() - 0.5) * lateral;
          thrustPositions[o + 2] = -0.65 + (Math.random() - 0.5) * 0.1;
          thrustVelocities[o + 0] = (Math.random() - 0.5) * 1.5;
          thrustVelocities[o + 1] = (Math.random() - 0.5) * 1.5;
          thrustVelocities[o + 2] = -back + (Math.random() - 0.5) * 3;
          toSpawn--;
        }
      } else {
        thrustSpawnAccumulator = 0;
      }
    } else {
      thrustSpawnAccumulator = 0;
    }
    (thrustGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (thrustGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  // ── Visual sync ──────────────────────────────────────────────────────────
  function syncObjectTransform() {
    // Walking / takeoff (skidding while wings unfold) / swimming use
    // the GROUND normal as the body's up so the bird sits on the
    // surface. Flying / drifting / diving / underwater use body-up so
    // attitude follows the chase view.
    const useGroundUp =
      state.mode === "walking" ||
      state.mode === "takeoff" ||
      state.mode === "swimming";
    if (useGroundUp) {
      tmpUp.copy(state.groundNormal);
      tmpForward.copy(state.forward);
      tmpForward.addScaledVector(tmpUp, -tmpForward.dot(tmpUp)).normalize();
      tmpRight.crossVectors(tmpUp, tmpForward).normalize();
      tmpUp.crossVectors(tmpForward, tmpRight).normalize();
    } else {
      tmpForward.copy(state.forward);
      tmpRight.copy(state.bodyRight);
      tmpUp.crossVectors(tmpForward, tmpRight).normalize();
    }

    const m = new THREE.Matrix4().makeBasis(tmpRight, tmpUp, tmpForward);
    object.quaternion.setFromRotationMatrix(m);

    if (state.mode === "walking") {
      // Spec body pitch:
      //   speed 0           → tilted UPWARDS by walkRestPitch (rest stance)
      //   speed walkSpeedMax → near horizontal (crossover point)
      //   speed runningTakeoff → forward lean by walkLeanMax (running stance)
      // Single linear interp between -walkRestPitch (nose up) at zero
      // forward speed and +walkLeanMax (nose down) at runningTakeoffSpeed.
      // Backward walking keeps the rest pose so it doesn't look like the
      // bird is reverse-running.
      const fwdSpeed = Math.max(0, state.walkSpeed);
      const f = Math.min(1, fwdSpeed / PLAYER.runningTakeoffSpeed);
      const pitch = -PLAYER.walkRestPitch * (1 - f) + PLAYER.walkLeanMax * f;
      const leanQ = new THREE.Quaternion().setFromAxisAngle(tmpRight, pitch);
      object.quaternion.premultiply(leanQ);
    } else if (state.mode === "takeoff") {
      // During the 250 ms jump anim the body's local pitch interpolates
      // toward "nose down" (forward lean) so the launch reads as a
      // committed pose by the time we hit flying.
      const t = state.takeoffPhase;
      const pitch = -PLAYER.walkRestPitch * (1 - t) + PLAYER.walkLeanMax * t;
      const leanQ = new THREE.Quaternion().setFromAxisAngle(tmpRight, pitch);
      object.quaternion.premultiply(leanQ);
    }
    if (state.bank !== 0) {
      const bankQ = new THREE.Quaternion().setFromAxisAngle(tmpForward, state.bank);
      object.quaternion.premultiply(bankQ);
    }
    object.position.copy(state.position);
  }

  return {
    state,
    object,
    update(input, dt) {
      // Resolve gravity at our position first; mode and physics flow from it.
      world.gravityAt(state.position, state.gravity);
      const ctx = state.gravity;

      // Frame-attach the player to the dominant body's rotation. Walking
      // is rigid attachment (player glued to surface, follows both
      // translation and rotation of the planet). Flying is partial:
      // when in atmosphere the player tracks the planet's rotation
      // through the air, but fades out toward zero coupling at vacuum
      // edge so the player isn't being yanked around by the planet's
      // spin once they've cleared the atmosphere.
      //
      // The velocity is also rotated in the body's translational frame
      // so a player flying "east" relative to the planet keeps flying
      // east after rotation, not "out into space."
      if (ctx.dominant) {
        const body = ctx.dominant;
        let attachStrength = 0;
        if (state.mode === "walking") {
          attachStrength = 1;
        } else if (state.mode === "flying" || state.mode === "stunned") {
          // Smoothly couple flight attachment to atmospheric density.
          // Stunned bird is also in the planet's atmospheric frame —
          // the bird hangs in the air, not in space.
          const reading = _attachReading;
          world.atmosphericDensityAt(state.position, reading);
          attachStrength = THREE.MathUtils.smoothstep(reading.density, 0.0, 0.05);
        }

        if (body.rotation.rate !== 0 && attachStrength > 0.001) {
          _attachQuat.setFromAxisAngle(
            body.rotation.axis,
            body.rotation.rate * dt * attachStrength,
          );
        } else {
          _attachQuat.identity();
        }

        if (state.mode === "walking") {
          // Rigid attachment: rotate around the body's prev center AND
          // translate to its current center in one combined op.
          state.position.sub(body.prevWorldPosition);
          state.position.applyQuaternion(_attachQuat);
          state.position.add(body.worldPosition);
          state.groundNormal.applyQuaternion(_attachQuat);
        } else if (attachStrength > 0.001) {
          // Flying-with-atmosphere: rotate position around the body's
          // CURRENT center (translation is already in velocity), and
          // rotate the player's velocity in the body's translational
          // frame so "flying east" stays east relative to the planet.
          state.position.sub(body.worldPosition);
          state.position.applyQuaternion(_attachQuat);
          state.position.add(body.worldPosition);
          state.velocity.sub(body.velocity);
          state.velocity.applyQuaternion(_attachQuat);
          state.velocity.add(body.velocity);
        }

        state.forward.applyQuaternion(_attachQuat);
        state.bodyRight.applyQuaternion(_attachQuat);
        state.up.applyQuaternion(_attachQuat);
      }

      // Mode transitions driven by gravity context:
      //   no dominant body  → drifting
      //   dominant body but non-walkable (e.g. star, gas planet) → flying
      //   dominant body, walkable, alt < landingAltitude → walking (handled
      //     by auto-land inside updateAirborne)
      // The "takeoff" mode is sticky — it owns its own transition (to
      // flying) at the end of the animation, so we don't override it
      // here. Defensive: if the dominant body disappears mid-takeoff
      // (player crossed into deep space somehow during the 250 ms),
      // bail to drifting.
      if (!ctx.dominant) {
        state.mode = state.mode === "takeoff" ? "drifting" : "drifting";
        state.takeoffData = null;
      } else if (state.mode === "drifting") {
        state.mode = "flying";
      } else if (state.mode === "walking" && !ctx.dominant.walkable) {
        // Defensive: dominant shifted to a non-walkable body while we
        // thought we were walking. Bail out of walking.
        state.mode = "flying";
      } else if (state.mode === "takeoff" && !ctx.dominant.walkable) {
        // Same defensive: walking surface vanished. Commit to flight.
        state.mode = "flying";
        state.takeoffData = null;
      } else if (
        (state.mode === "swimming" ||
          state.mode === "diving" ||
          state.mode === "underwater") &&
        (!ctx.dominant.walkable || !ctx.dominant.hasOcean)
      ) {
        // Defensive: water vanished beneath us. Bail to flight.
        state.mode = "flying";
        state.takeoffData = null;
        state.divePhase = 0;
      }

      // Decay hyperMult in any mode where it can't actually do work
      // (walking on a surface, takeoff anim, swim/dive/underwater,
      // stunned). Without this, hyperMult is preserved across mode
      // transitions: build it up during flight → land → walk around
      // → take off → bird shoots off at the previously-accumulated
      // mult. Decay rate uses HYPER_LOSS_RATE × 1.0 (full off-center
      // intensity) so it drains fast.
      if (
        state.mode !== "flying" &&
        state.mode !== "drifting"
      ) {
        state.hyperMult *= Math.exp(-SPEED.HYPER_LOSS_RATE * dt);
        if (state.hyperMult < 1) state.hyperMult = 1;
      }

      if (state.mode === "walking" && ctx.dominant) {
        updateWalking(input, dt, ctx.dominant);
      } else if (state.mode === "takeoff" && ctx.dominant) {
        updateTakeoff(input, dt, ctx.dominant);
      } else if (state.mode === "swimming" && ctx.dominant) {
        updateSwimming(input, dt, ctx.dominant);
      } else if (state.mode === "diving" && ctx.dominant) {
        updateDiving(input, dt, ctx.dominant);
      } else if (state.mode === "underwater" && ctx.dominant) {
        updateUnderwater(input, dt, ctx.dominant);
      } else if (state.mode === "stunned") {
        updateStunned(dt, ctx);
      } else {
        updateAirborne(input, dt, ctx);
      }
      // Note: visual sync (object.position/quaternion) is intentionally
      // NOT done here — the main loop calls `player.sync()` after
      // `world.checkActiveSystem()` so the bird mesh reflects the
      // POST-floating-origin position. Wings/particles still update
      // here (they're animations driven by state, not by position).
      updateWings(dt);
      updateLegs(dt, ctx);
      updateThrustParticles(dt);
    },
    sync: syncObjectTransform,
    setReadoutHook(hook) {
      readoutHook = hook;
    },
  };

  // ── Leg extension ───────────────────────────────────────────────────────
  // Walking / takeoff → legs always extended (1).
  // Flying → legs extend in proportion to obstacle proximity using the
  // SAME clearance metric as the low-altitude cap. When the bird is far
  // from any obstacle the legs are tucked (0); within ~3× the cap
  // ramp scale they're extending; under it they're fully out and ready
  // to land.
  function updateLegs(dt: number, ctx: GravityContext) {
    let target: number;
    if (state.mode === "walking" || state.mode === "takeoff") {
      target = 1;
    } else if (ctx.dominant && ctx.dominant.walkable) {
      const clearance = computeObstacleClearance(ctx.dominant, state.position);
      // Same ramp scale as the low-alt cap so the visual cue lines up
      // with the speed brake. Within `flyLowAltClearScale` of the
      // worst-case obstacle → fully extended. Past 3× → tucked.
      const t = THREE.MathUtils.clamp(
        1 - clearance / (PLAYER.flyLowAltClearScale * 3),
        0, 1,
      );
      target = t;
    } else {
      target = 0;
    }
    const lerpRate = Math.min(1, 4 * dt);
    state.legsExtended += (target - state.legsExtended) * lerpRate;

    // Stride cycle. Advance the phase by walkSpeed × stride-per-meter
    // — faster walking = faster stride. A floor rate keeps the legs
    // moving subtly even when speed is tiny so a slow shuffle still
    // reads as a stride rather than skating.
    const fwdSpeed = Math.abs(state.walkSpeed);
    let stepAmp = 0;
    if (state.mode === "walking" && fwdSpeed > 0.05 && state.legsExtended > 0.5) {
      const stridesPerMeter = 1.1; // ≈ one full L/R cycle per meter of travel
      state.legStridePhase += fwdSpeed * stridesPerMeter * dt * Math.PI * 2;
      // Amplitude grows with speed but is capped — at a run the legs
      // swing through ~50°.
      const f = Math.min(1, fwdSpeed / PLAYER.walkSpeedMax);
      stepAmp = THREE.MathUtils.lerp(0.12, 0.45, f);
    }

    // Compose pose: extension slerp first, then per-leg step swing.
    _legAnimQuat.copy(_legTuckQuat).slerp(_legDownQuat, state.legsExtended);

    // Left leg leads positive phase; right leg is offset by π so the
    // two legs are always in opposing positions. sin gives smooth
    // forward → back swing.
    const lSwing = Math.sin(state.legStridePhase) * stepAmp;
    _legStepQuat.setFromAxisAngle(_legStepAxis, lSwing);
    _legPoseQuat.multiplyQuaternions(_legAnimQuat, _legStepQuat);
    legLPivot.quaternion.copy(_legPoseQuat);

    const rSwing = Math.sin(state.legStridePhase + Math.PI) * stepAmp;
    _legStepQuat.setFromAxisAngle(_legStepAxis, rSwing);
    _legPoseQuat.multiplyQuaternions(_legAnimQuat, _legStepQuat);
    legRPivot.quaternion.copy(_legPoseQuat);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Soft hot-core gradient for the rocket-trail particle sprite. Tighter
// than the body-halo / star textures because the trail wants a punchier,
// concentrated glow rather than a diffuse smear.
function makeThrustTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,220,150,0.85)");
  g.addColorStop(0.55, "rgba(255,140,60,0.35)");
  g.addColorStop(1.0, "rgba(255,80,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function projectTangent(v: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  return v.clone().sub(up.clone().multiplyScalar(v.dot(up)));
}

// Vertical clearance (m) between the player and the highest sampled
// terrain peak within `flyLowAltSampleRadius` of the player's projected
// ground position. Used by the low-altitude flight cap.
//
// Samples a 4-point tangent cross around the player on the body's
// surface, plus the player's own radial. The minimum altitude across
// these is the player's clearance to the worst nearby peak — if a
// mountain sits beside the player, the sample over its summit returns
// a low (or negative) altitude even when the player's own
// surface-under-foot is far below.
//
// Returns Infinity if `heightAt` isn't available on the body (e.g.
// stars, gas planets) — the caller should already gate on `walkable`.
const _clearanceTmp = new THREE.Vector3();
const _clearanceRadial = new THREE.Vector3();
const _clearanceTangentA = new THREE.Vector3();
const _clearanceTangentB = new THREE.Vector3();
const _clearanceSamplePos = new THREE.Vector3();
const _clearanceSeed = new THREE.Vector3();
function computeObstacleClearance(
  body: {
    worldPosition: THREE.Vector3;
    altitudeAt(worldPos: THREE.Vector3): number;
  },
  playerPos: THREE.Vector3,
): number {
  _clearanceTmp.copy(playerPos).sub(body.worldPosition);
  const playerDist = _clearanceTmp.length();
  if (playerDist < 1e-3) return Infinity;
  _clearanceRadial.copy(_clearanceTmp).divideScalar(playerDist);

  // Build two tangent axes orthogonal to the radial. The seed-axis
  // dodge avoids degeneracy when radial ≈ ±Y.
  if (Math.abs(_clearanceRadial.y) < 0.9) _clearanceSeed.set(0, 1, 0);
  else _clearanceSeed.set(1, 0, 0);
  _clearanceTangentA.crossVectors(_clearanceRadial, _clearanceSeed).normalize();
  _clearanceTangentB.crossVectors(_clearanceRadial, _clearanceTangentA).normalize();

  // Angular offset that puts the sample point `flyLowAltSampleRadius`
  // off in the tangent plane at the player's altitude. The asin
  // keeps it accurate as the bird climbs (small angle at altitude,
  // larger angle close to surface).
  const angularOffset = Math.atan(PLAYER.flyLowAltSampleRadius / playerDist);
  const cosO = Math.cos(angularOffset);
  const sinO = Math.sin(angularOffset);

  let minAlt = body.altitudeAt(playerPos);
  const sampleDir = _clearanceTmp; // reuse — we're done with the original copy
  for (let i = 0; i < 4; i++) {
    const ax = i < 2 ? _clearanceTangentA : _clearanceTangentB;
    const sign = i % 2 === 0 ? 1 : -1;
    sampleDir.copy(_clearanceRadial).multiplyScalar(cosO).addScaledVector(ax, sign * sinO);
    _clearanceSamplePos.copy(sampleDir).multiplyScalar(playerDist).add(body.worldPosition);
    const alt = body.altitudeAt(_clearanceSamplePos);
    if (alt < minAlt) minAlt = alt;
  }
  return minAlt;
}

// ── Hyperjump lock-on helpers ─────────────────────────────────────────────
//
// `pickLockCandidate` returns the body the player's `forward` vector most
// plausibly indicates intent toward: within a forward-cone of `coneCos`,
// scored by `angularRadius × dot²` so a larger body in the gaze cone wins
// over a smaller one even slightly closer to dead-center.
const _hypTmpDir = new THREE.Vector3();
function pickLockCandidate(
  position: THREE.Vector3,
  forward: THREE.Vector3,
  bodies: readonly CelestialBody[],
  baseConeCos: number,
  currentLockId: string | null,
): CelestialBody | null {
  // A body counts as "in the gaze cone" when the gaze direction falls
  // inside the body's angular extent PLUS a small buffer for gaze
  // imprecision. This means the cone scales with how big the body
  // appears: a sub-pixel star uses the tight `baseConeCos`; a body
  // that fills the screen lets the player gaze anywhere on it and
  // still hold lock. Without this, approaching any body until it
  // fills the screen breaks the lock the moment gaze drifts off the
  // body's center direction (Moon at 30% of screen = 30° angular
  // radius → fixed 15° cone is exceeded → lock decays → speed cap
  // released → kicked out of system from accumulated hyperMult).
  let best: CelestialBody | null = null;
  let bestScore = -Infinity;
  for (const b of bodies) {
    _hypTmpDir.copy(b.worldPosition).sub(position);
    const dist = _hypTmpDir.length();
    if (dist < 1 || dist <= b.radius) continue;
    _hypTmpDir.divideScalar(dist);
    const dot = forward.dot(_hypTmpDir);
    // Effective cone = the WIDER of (a) the base intent cone and
    // (b) the body's own angular extent + buffer. asin is safe
    // because radius < dist here.
    const angularRadius = Math.asin(b.radius / dist);
    const effectiveConeCos = Math.min(
      baseConeCos,
      Math.cos(angularRadius + LOCK_CONE_BUFFER),
    );
    if (dot < effectiveConeCos) continue;
    // Score by angular footprint × alignment, with a hysteresis
    // bonus for the currently-locked body so candidate doesn't
    // oscillate when several bodies are roughly in the cone.
    const ar = b.radius / dist;
    let score = ar * dot * dot;
    if (currentLockId !== null && b.id === currentLockId) {
      score *= LOCK_HYSTERESIS;
    }
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

// Buffer (radians) added to a body's angular radius before testing the
// forward-cone. Default ~3° — accommodates gaze imprecision without
// extending the cone so far that a body off to the side gets locked.
const LOCK_CONE_BUFFER = 0.05;
// Score multiplier for the currently-locked body, biasing the picker
// toward staying locked once a target is acquired. ×1.5 keeps the
// existing target unless a competitor's raw score is ≥ 1.5× higher.
const LOCK_HYSTERESIS = 1.5;

function findBodyById(bodies: readonly CelestialBody[], id: string): CelestialBody | null {
  for (const b of bodies) {
    if (b.id === id) return b;
  }
  return null;
}

function reTangent(forward: THREE.Vector3, up: THREE.Vector3): void {
  const d = forward.dot(up);
  forward.addScaledVector(up, -d).normalize();
}

function pitchForward(forward: THREE.Vector3, up: THREE.Vector3, amount: number): void {
  const right = new THREE.Vector3().crossVectors(up, forward).normalize();
  const q = new THREE.Quaternion().setFromAxisAngle(right, -amount);
  forward.applyQuaternion(q).normalize();
}
