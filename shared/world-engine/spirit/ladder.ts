/**
 * ladder.ts — the SPIRIT LADDER: one gaze-driven level state machine over a
 * SpiritFrameProvider (see frame-provider.ts for the seam and the law).
 *
 *   FLIGHT  >  TOWN (town/district focus depths)  >  GROUND  >  STRUCTURE
 *
 * The ladder ALWAYS owns the camera. The structure rung queries the host's
 * dollhouse POSE (render3d.dollhousePose) and blends toward it — the old
 * camera-ownership handoff (and its jump) is gone. The zoom-out CEILING is a
 * mutable control limit (initial_focus sets it; gameplay may raise it),
 * clamped to the provider's scope; ascent past it simply doesn't accrue.
 *
 * GROUND (the glide) is a declared rung with its transitions landing in the
 * next stage — the state machine and ceiling arithmetic already treat it as
 * the level above STRUCTURE.
 */
import * as THREE from "three";
import { createGazeInterpreter, type GazeInterpreter } from "../gaze-intent.js";
import {
  DEFAULT_CAMERA_TUNABLES, DEFAULT_COMFORT_TUNABLES,
} from "../world-tunables.js";
import type {
  SphereGroundOps, SpiritChartFrame, SpiritCursorHost, SpiritFrameProvider,
  SpiritFocusTarget, SpiritGroundBuildingHit, SpiritGroundSession, SpiritLevel,
  SpiritNearTown, SpiritTownSession,
} from "./frame-provider.js";
import { LEVEL_RANK } from "./frame-provider.js";
import { createSpiritPose, blendPose, applyPose, type SpiritPose } from "./pose.js";
import { createChaseRig, type ChaseRig } from "./chase-rig.js";
import { createGroundGlide, type GroundGlide } from "./ground-glide.js";

// ── FLIGHT regimes (moved verbatim from world-lab main.ts spiritControl) ────
const DEAD_XY: [number, number] = [0, -0.3];
const DEAD_R = 0.24;
const DOWN_R = 0.55;
const DIVE_RATE = 0.9;
const CLIMB_RATE = 0.9;
const ASC_START = 0.35;
const FWD_START = 0.1;
const FWD_SPEED = 0.55;
const ROT_EDGE = 0.62;
const ROT_RATE = 1.0;
const SIDE_SPEED = 0.5;

// ── TOWN focus (moved from driveCityFocus) ──────────────────────────────────
export const CITY_FOCUS_ALT = 3_500;
export const TOWN_ENTER_FACTOR = 2.2;
const CITY_PITCH = 0.5;
const CITY_ORBIT = 1.3;
const CITY_ORBIT_EDGE = 0.45;
const CITY_EXIT_S = 0.5;
const CITY_DWELL_S = 0.6;
const CITY_FRAME = 1.35;
const CITY_BLEND_RATE = 2.6;
const DWELL_MOVE_PX = 40;

// ── STRUCTURE blend (the jump fix) ──────────────────────────────────────────
/** Seconds the orbit→dollhouse pose blend takes (and its reverse). */
const STRUCT_BLEND_S = 0.7;
/** Pointer forwards to the host (interaction) only past this blend. */
const STRUCT_INTERACT_T = 0.9;

// ── GROUND glide (the rung ABOVE structure) ─────────────────────────────────
/** Flight altitude at (or under) which the dive becomes the ground glide. */
export const GROUND_ENTER_ALT = 30;
/** Altitude the drone takes when the glide ascends back to flight. */
const GROUND_EXIT_ALT = 200;
/** Seconds the entry-pose → chase-rig blend takes. */
const GROUND_BLEND_S = 0.8;
/** Re-anchor the ground chart when the glide strays this far (tangent-plane
 *  error stays centimetric). */
/** Cap the gaze aim this far from the glide. Over open terrain the tangent
 *  plane extends to the horizon — an unclamped near-horizon gaze is hundreds
 *  of metres out, which pins the yaw law (yawDistGain / gazeDist → ~0: the
 *  glide can't turn) while the arrive law holds full speed (it drifts
 *  forever forward). A town-sized cap restores the avatar's feel: far gazes
 *  glide at speed, near gazes turn hard, a gaze at the glide stops it. */
const GROUND_AIM_MAX = 30;
/** Bisection steps for the gaze→terrain march (stepGround's screenToWorld).
 *  Halves the bracket each time, so ~12 pins a 40 m spread to a centimetre. */
const GAZE_BISECT_ITERS = 12;
/** The plane hit IS the answer when the ray meets the terrain within this of it
 *  (metres) — i.e. over level ground, which costs a single terrain sample. */
const GAZE_MARCH_EPS = 0.05;
/** Bracket-expansion step (metres of ground covered) when the plane hit misses.
 *  Doubles each try, so the bracket is found in a handful of samples. */
const GAZE_BRACKET_STEP = 4;
/** Stop marching once the gaze point is this far out. Beyond it the ray is
 *  grazing the horizon, where the crossing is ill-conditioned and the answer
 *  means little anyway (the STEERING aim is bounded far tighter — see
 *  GROUND_AIM_MAX). Generous on purpose: this is a guard, not the aim's cap. */
const GROUND_GAZE_MAX = 400;
/** Structure exit: the glide spawns this far OUTSIDE the building's
 *  footprint (camera side), so the next house over is never entered by the
 *  spawn itself. */
const STRUCT_EXIT_STEP = 2;
/** Seconds BOTH the glide and the settled gaze must rest inside the SAME
 *  building before it is possessed (its dollhouse opens) — flying THROUGH a
 *  house while looking past it never captures it. */
const GROUND_POSSESS_DWELL_S = 0.45;
/** A town's CONTENT reaches this many plan radii from its centre on the
 *  ground rung: inside, the glide's session resolves that town's buildings /
 *  gaze walker / driven body (and bottom-dwell exits to its district orbit).
 *  Re-evaluated EVERY frame as the glide moves — the town is content under
 *  the player, never a session constant (the entry-frozen ref was stale in
 *  both directions at the border). Same factor the flight→ground gate uses. */
const TOWN_GROUND_ATTACH = 1.25;

/** HUD gaze-spark distance in front of the camera (flight level). */
const SPARK_DIST = 6;
/** ILLUSORY MOTION (flight rung). The drone crosses the planet at hundreds of
 *  m/s, but the camera rides with it and the HUD spark is parented to the
 *  camera — so nothing on screen moves, and at speed the view reads as a still
 *  image. These fake it, from the steering RATES rather than the speeds.
 *
 *  Why the rate is the right signal: every flight control is already
 *  ALTITUDE-NORMALISED by design (`FWD_SPEED·alt` m/s forward; `climb` is a
 *  per-second FRACTION of altitude). Divide the altitude back out and what's
 *  left — s⁻¹ — is exactly "how fast does this feel", and it is the same at
 *  200 m as at 200 km. That is the same invariance the controls already have,
 *  which is why the illusion tracks them for free.
 *
 *  `SLIP_GAIN` then converts rate → HUD units/sec by scaling with the spark's
 *  own distance from the camera, so the streak keeps its screen length however
 *  the depth below is easing. */
const SLIP_GAIN = 1;
/** Fraction of `SPARK_DIST` the spark pulls in / pushes out at full dive /
 *  climb. Applied ALONG THE GAZE RAY, so the cursor never leaves its pixel —
 *  only its depth (and so its apparent size) changes.
 *
 *  THE SPARK LEADS, THE WAKE TRAILS. The camera looks straight down, so "up"
 *  is toward the viewer: climbing, the spark leads up out of the world and
 *  swells toward you; diving, it plunges out ahead and away. The embers do the
 *  opposite by construction (`slipDrift` negates), and that opposition is the
 *  whole read — a spark that fell backward with its own wake would just look
 *  like the pair were sliding, not accelerating. */
const SLIP_DEPTH_GAIN = 0.5;
/** Ease rate for the depth shift. The lag IS the effect: a step change would
 *  read as a size pop, whereas easing in over ~0.4 s reads as accelerating. */
const SLIP_EASE_K = 2.5;

const smooth01 = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface SpiritPointer {
  /** Viewport px (for NDC + dwell-move detection). */
  x: number;
  y: number;
  /** Client px (host pointer forwarding). */
  clientX: number;
  clientY: number;
}

export interface SpiritLadderOpts {
  provider: SpiritFrameProvider;
  /** The INITIAL zoom-out ceiling (initial_focus's rung); clamped to the
   *  provider's scope level. */
  ceiling: SpiritLevel;
  /** Where the game starts. Flight (default), a town session, or a single
   *  structure inside one (the standalone dollhouse). */
  start?:
    | { level: "flight" }
    | { level: "town"; town: unknown }
    | { level: "structure"; town: unknown; target: SpiritFocusTarget };
}

export interface SpiritStepResult {
  status: string;
  /** A bake/founding is loading behind the veil (host shows it). */
  waiting: string | null;
  /** The nearest town this frame (HUD). */
  nearTown: SpiritNearTown | null;
}

export interface SpiritLadder {
  step(pointer: SpiritPointer | null, dt: number, now: number): SpiritStepResult;
  /** Raise (or set) the zoom-out ceiling — a CONTROL limit, clamped to the
   *  provider's scope. */
  setCeiling(level: SpiritLevel): void;
  /** POSSESSION seam: place the ladder at the GROUND rung over `worldPoint`
   *  (the dismissed avatar's spot) — the glide resumes there, blending from
   *  wherever the camera currently is. `townRef` keeps town context. */
  dropToGround(worldPoint: THREE.Vector3, townRef?: unknown | null): void;
  /** The current rung's focus position (WORLD coords — a flat provider's are
   *  its sim coords): the glide point at GROUND, the focus chart at TOWN/
   *  STRUCTURE. False at FLIGHT / before any session. Hosts feed it to
   *  distance rules (leaving an empty site). */
  focusWorld(out: THREE.Vector3): boolean;
  readonly level: SpiritLevel;
  readonly ceiling: SpiritLevel;
  /** IS THE GLIDE STANDING IN A TOWN? (ground rung with a town ref attached —
   *  content under the glide, re-evaluated per frame). The host layer reads it
   *  to tick that town at the FULL frame rate: the player is in it, and its
   *  session is the cursor/interaction engine for the rung. False at every
   *  other rung — a town you merely orbit keeps the airborne cadence. */
  groundInTown(): boolean;
  /** DIAGNOSTICS (ground rung): which cursor OWNS the spark this frame —
   *  `rep` (an entity engine under the glide resolved it: wall stop, entity
   *  snap, dwell — the good path, identical to the flat host's), `prov` (the
   *  provider's bare drawn-world ray: position only, no engine reporting),
   *  `host` (a FLAT standalone drawing its own), `fallb` (overlay at the
   *  analytic gaze point), or `none`.
   *
   *  USER LAW the string still guards: the cursor is the PLAYER's, so it must
   *  never be resolved in TOWN-PLAZA coordinates — a town owns population and
   *  procgen, never the frame. `rep` is not that leak: the host reports in
   *  WORLD coords off the DRAWN planet skin, which is the same pick the
   *  wilderness makes. String only; no behaviour. */
  debugGround(): string;
  dispose(): void;
}

interface TownState {
  /** The provider's opaque town ref (re-opens sessions, seeds ground). */
  ref: unknown;
  session: SpiritTownSession;
  /** 0 = whole town, 1 = a district (the TOWN rig at two focus depths). */
  depth: 0 | 1;
  /** Eased orbit focus, chart-local metres from the town centre. */
  focus: { x: number; z: number };
  target: { x: number; z: number };
  radius: number;
  targetRadius: number;
  /** The district we descended through — structure-exit returns to it. */
  district: { x: number; z: number; radius: number };
  az: number;
  targetAz: number;
  /** 0 = free-flight pose, 1 = town orbit (smoothstepped). */
  blend: number;
  exiting: boolean;
  dwellHold: number;
  exitHold: number;
  dwellPx: number;
  dwellPy: number;
}

interface StructureState {
  frame: { x: number; y: number; w: number; h: number } | null;
  spiritAz: number;
  /** 0 = orbit pose, 1 = dollhouse pose (the blended zoom). */
  t: number;
  exiting: boolean;
  exitHold: number;
  engaged: boolean;
}

interface GroundState {
  session: SpiritGroundSession;
  /** Geometry backend: sphere ops (planet) or the flat 2D adapter. */
  geom: GroundGeom;
  /** The glide's surface address (backend-opaque, rebase-safe). */
  loc: THREE.Vector3;
  /** Frozen entry surface address (the from-pose blend re-lifts through it). */
  entryLoc: THREE.Vector3;
  /** DEV-frame ground height under the glide: accumulated local rise/fall of
   *  the true surface along the path (the rig's height law rides it). */
  gyDev: number;
  /** The glide runs in DEV coords — the rolling 2D law frame developed along
   *  the glide's own path (a moving tangent frame; NOT an anchor chart). */
  glide: GroundGlide;
  rig: ChaseRig;
  /** 0 = the entry pose (frozen rel. the entry frame), 1 = the chase rig. */
  t: number;
  fromRel: SpiritPose;
  exitHold: number;
  /** The town we glide within (building entries + the ascend return). */
  townRef: unknown | null;
  /** Building entry ARMS only after one frame OUTSIDE every footprint — a
   *  glide spawned at a doorstep never instantly (re-)possesses a house. */
  armed: boolean;
  /** LAST frame's settled aim (DEV coords) — the glide steers from it
   *  this frame, BEFORE the camera is re-posed (1-frame gaze latency). */
  aim: { x: number; z: number } | null;
  /** Accrued gaze+glide same-building dwell toward possession. */
  enterHold: number;
}

/** The ground rung's geometry backend. One rung, two geometries: `sphere`
 *  ops when the session provides them (planets — moving local frame, no
 *  anchor), else this 2D adapter over the legacy flat contract (on a plane
 *  the anchor frame IS every local frame, so the old math is exact and the
 *  flat providers stay untouched). */
interface GroundGeom {
  locFromWorld(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  surfaceAt(loc: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  frameAt(loc: THREE.Vector3): SpiritChartFrame;
  move(loc: THREE.Vector3, east: number, north: number, out: THREE.Vector3): THREE.Vector3;
  heightAbove(p: THREE.Vector3): number;
  buildingAt(loc: THREE.Vector3): SpiritGroundBuildingHit | null;
  placeAvatar(loc: THREE.Vector3): void;
  drivenBody(): { loc: THREE.Vector3; fx: number; fz: number } | null;
}

const _flatO = new THREE.Vector3();
const _flatBodyLoc = new THREE.Vector3();

/** Legacy 2D sessions: loc = session-local (x, 0, z). The anchor origin is
 *  re-read per query (never cached across frames). */
function flatGroundGeom(session: SpiritGroundSession): GroundGeom {
  const originNow = (): THREE.Vector3 => _flatO.copy(session.chartAt(0, 0).origin);
  return {
    locFromWorld(p, out) {
      const o = originNow();
      return out.set(p.x - o.x, 0, p.z - o.z);
    },
    surfaceAt: (loc, out) => out.copy(session.chartAt(loc.x, loc.z).origin),
    frameAt: (loc) => session.chartAt(loc.x, loc.z),
    move: (loc, e, n, out) => out.set(loc.x + e, 0, loc.z + n),
    heightAbove(p) {
      const o = originNow();
      return p.y - o.y - session.groundY(p.x - o.x, p.z - o.z);
    },
    buildingAt: (loc) => session.buildingAt(loc.x, loc.z),
    placeAvatar: (loc) => session.placeAvatar?.(loc.x, loc.z),
    drivenBody() {
      const b = session.drivenBody?.() ?? null;
      return b ? { loc: _flatBodyLoc.set(b.x, 0, b.z), fx: b.fx, fz: b.fz } : null;
    },
  };
}

/** Sphere sessions: pass-through (the provider already speaks loc). */
function sphereGroundGeom(s: SphereGroundOps): GroundGeom {
  return {
    locFromWorld: (p, out) => s.locFromWorld(p, out),
    surfaceAt: (loc, out) => s.surfaceAt(loc, out),
    frameAt: (loc) => s.frameAt(loc),
    move: (loc, e, n, out) => s.move(loc, e, n, out),
    heightAbove: (p) => s.heightAbove(p),
    buildingAt: (loc) => s.buildingAt(loc),
    placeAvatar: (loc) => { s.placeAvatar?.(loc); },
    drivenBody: () => s.drivenBody?.() ?? null,
  };
}

export function createSpiritLadder(opts: SpiritLadderOpts): SpiritLadder {
  const provider = opts.provider;
  const camera = provider.camera;
  const gaze: GazeInterpreter = createGazeInterpreter();

  const clampCeiling = (l: SpiritLevel): SpiritLevel =>
    LEVEL_RANK[l] > LEVEL_RANK[provider.scopeLevel] ? provider.scopeLevel : l;
  let ceiling = clampCeiling(opts.ceiling);

  let level: SpiritLevel = "flight";
  let town: TownState | null = null;
  let struct: StructureState | null = null;
  let ground: GroundState | null = null;
  let holdZoom = false;
  /** The entity engine currently opted OUT of drawing its own cursor for the
   *  ground rung (it reports; the provider draws). Held so the opt-out can be
   *  handed back when the rung ends or the engine changes under the glide. */
  let cursorOptedOut: SpiritCursorHost | null = null;
  /** DIAGNOSTICS: last ground frame's cursor-owner fork — see `debugGround`. */
  let groundDbg = "-";
  /** This frame's flight steering RATES (s⁻¹), captured by `driveFlightRegimes`
   *  and spent by `slipDrift` — the illusory-motion signal. Forward/side are
   *  the drone's own tangent axes, which the top-down camera maps to up-screen
   *  and right; `slipRot` is the turn rate; `slipClimb` is + up. */
  let slipFwd = 0, slipSide = 0, slipRot = 0, slipClimb = 0;
  /** Eased climb rate driving the spark's depth — the acceleration read. */
  let slipDepth = 0;

  // Scratch
  const _tmpDir = new THREE.Vector3();
  const _anchor = new THREE.Vector3();
  const _camOff = new THREE.Vector3();
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _sparkPos = new THREE.Vector3();
  const _slipVel = new THREE.Vector3();
  const _slipLocal = new THREE.Vector3();
  const _surfPt = new THREE.Vector3();
  const _gazeLoc = new THREE.Vector3();
  const _horiz = new THREE.Vector3();
  const _orbRel = new THREE.Vector3();
  const _orbLookRel = new THREE.Vector3();
  const _fltRel = new THREE.Vector3();
  const _fltLookRel = new THREE.Vector3();
  const _camRel = new THREE.Vector3();
  const _lookRel = new THREE.Vector3();
  const _upBlend = new THREE.Vector3();
  const _camAbs = new THREE.Vector3();
  const _dg = new THREE.Vector3();
  const _fromPose = createSpiritPose();
  const _toPose = createSpiritPose();
  const _outPose = createSpiritPose();

  const openTownState = (ref: unknown): TownState => {
    const session = provider.openTown(ref);
    const radius = session.radius();
    return {
      ref, session, depth: 0,
      focus: { x: 0, z: 0 }, target: { x: 0, z: 0 },
      radius, targetRadius: radius,
      district: { x: 0, z: 0, radius },
      az: 0, targetAz: 0,
      blend: provider.flight ? 0 : 1, // no flight seam ⇒ nothing to blend from
      exiting: false, dwellHold: 0, exitHold: 0, dwellPx: 0, dwellPy: 0,
    };
  };

  if (opts.start && opts.start.level === "town") {
    town = openTownState(opts.start.town);
    level = "town";
  } else if (opts.start && opts.start.level === "structure") {
    // The standalone dollhouse: the town rig exists underneath (its orbit is
    // the blend's from-pose and the ascend target), focused on the structure.
    const target = opts.start.target;
    const t = openTownState(opts.start.town);
    t.depth = 1;
    t.blend = 1;
    t.focus = { x: target.x, z: target.z };
    t.target = { x: target.x, z: target.z };
    t.radius = target.radius;
    t.targetRadius = target.radius;
    t.district = {
      x: target.x, z: target.z,
      radius: Math.max(30, Math.min(160, t.session.radius() * 0.33)),
    };
    town = t;
    struct = {
      frame: target.frame ?? null,
      spiritAz: 0,
      t: 0,
      exiting: false,
      exitHold: 0,
      engaged: false,
    };
    level = "structure";
  }

  /** Ascent to `to` allowed? (the ceiling law) */
  const mayAscendTo = (to: SpiritLevel): boolean => LEVEL_RANK[to] <= LEVEL_RANK[ceiling];

  // ── FLIGHT drive (spiritControl regimes, verbatim) ─────────────────────────
  function driveFlightRegimes(x: number, y: number, dt: number): void {
    const f = provider.flight!;
    const d = f.drone;
    const R = f.radius;
    const alt = d.altitude;
    const dead = 1 - smooth01(DEAD_R * 0.35, DEAD_R, Math.hypot(x - DEAD_XY[0], y - DEAD_XY[1]));
    const move = 1 - dead;
    slipFwd = slipSide = slipRot = slipClimb = 0;
    if (move < 1e-3) return;
    // A sub-flight ceiling (initial_focus = a town) caps the climb near the
    // town-approach shell — the ceiling is a CONTROL limit, enforced here.
    const maxAlt = mayAscendTo("flight") ? f.maxAlt : Math.min(f.maxAlt, CITY_FOCUS_ALT * 1.6);
    const down = Math.max(0, 1 - Math.hypot(x, y) / DOWN_R);
    if (down > 0) d.climb(-DIVE_RATE * down * move, dt, f.minAlt, maxAlt);
    const asc = smooth01(ASC_START, 1, -y);
    if (asc > 0) d.climb(CLIMB_RATE * asc * move, dt, f.minAlt, maxAlt);
    const fwd = smooth01(FWD_START, 1, y);
    if (fwd > 0) d.panForward(FWD_SPEED * alt * fwd * move * dt, R);
    const edge = smooth01(ROT_EDGE, 1, Math.abs(x));
    const rot = x * (1 - edge);
    const side = x * edge;
    if (Math.abs(rot) > 1e-4) d.rotate(rot * ROT_RATE * move * dt);
    if (Math.abs(side) > 1e-4) d.panSide(side * SIDE_SPEED * alt * move * dt, R);
    // The illusion's inputs — the SAME rates, with the altitude divided out
    // (each `alt` above is exactly what makes the control feel identical at
    // every height; drop it and the leftover is the felt rate). Climb is the
    // net of the two zones: they can overlap, and only the sum is the motion.
    slipClimb = CLIMB_RATE * asc * move - DIVE_RATE * down * move;
    slipFwd = FWD_SPEED * fwd * move;
    slipSide = side * SIDE_SPEED * move;
    slipRot = rot * ROT_RATE * move;
  }

  /** Fill `_slipVel` with the illusory velocity of the world past the HUD spark,
   *  in CAMERA-LOCAL axes, given the spark's camera-local position `p`.
   *
   *  The camera's local frame at the flight rung IS the drone's tangent basis
   *  (`drone.place`: +y = heading, +z = radial up because the view looks
   *  straight down, so +x = east = screen-right). So each rate maps to one axis
   *  with no projection — and every term is NEGATED, because the world moves
   *  opposite the camera: fly forward and the ground streams backward. */
  function slipDrift(p: THREE.Vector3): THREE.Vector3 {
    const scale = p.length() * SLIP_GAIN;
    _slipVel.set(-slipSide * scale, -slipFwd * scale, -slipClimb * scale);
    // Turning is not a translation: a world-fixed point sweeps at ω × p. The
    // camera's axes turn WITH the heading (+rot swings +y toward +x, i.e. −rot
    // about +z), so a fixed world point appears to turn by +rot about +z.
    if (Math.abs(slipRot) > 1e-5) {
      _slipVel.x += -slipRot * p.y;
      _slipVel.y += slipRot * p.x;
    }
    return _slipVel;
  }

  // ── TOWN orbit pose, relative to the focus chart origin ───────────────────
  /** Fill `_orbRel`/`_orbLookRel` from the current eased town state + a chart
   *  basis. Also fills `pose` (absolute) when `origin` is given. */
  function orbitRelPose(t: TownState, chart: { east: THREE.Vector3; north: THREE.Vector3; up: THREE.Vector3 }, fovRad: number): void {
    const dist = (t.radius / Math.tan(fovRad / 2)) * CITY_FRAME;
    _horiz.copy(chart.east).multiplyScalar(Math.cos(t.az)).addScaledVector(chart.north, Math.sin(t.az));
    _orbRel.copy(chart.up).multiplyScalar(dist * Math.sin(CITY_PITCH))
      .addScaledVector(_horiz, -dist * Math.cos(CITY_PITCH));
    _orbLookRel.copy(chart.up).multiplyScalar(t.radius * 0.35);
  }

  // ── Transitions ────────────────────────────────────────────────────────────
  // FACING CONTINUITY: every rung change starts the next rig at the azimuth
  // the camera already looks along, instead of a default orientation.
  //   orbit forward   = east·cos(az)  + north·sin(az)
  //   dollhouse fwd   = (sin saz, −cos saz) chart-local  ⇒  saz = az + π/2
  function enterTown(near: SpiritNearTown): void {
    town = openTownState(near.ref);
    if (provider.flight) {
      const chart = town.session.chartAt(0, 0);
      const h = provider.flight.drone.heading;
      const az = Math.atan2(h.dot(chart.north), h.dot(chart.east));
      town.az = az;
      town.targetAz = az;
    }
    level = "town";
  }

  function enterStructure(t: TownState, pick: SpiritFocusTarget, spiritAz: number): void {
    struct = {
      frame: pick.frame ?? null,
      spiritAz,
      t: 0,
      exiting: false,
      exitHold: 0,
      engaged: false,
    };
    // The orbit keeps easing toward the building while the blend runs — the
    // from-pose closes in as the dollhouse pose takes over (no jump).
    t.target = { x: pick.x, z: pick.z };
    t.targetRadius = pick.radius;
    level = "structure";
  }

  function exitStructureToDistrict(t: TownState): void {
    t.target = { x: t.district.x, z: t.district.z };
    t.targetRadius = t.district.radius;
    t.depth = 1;
    struct = null;
    level = "town";
  }

  /** Capture the CURRENT camera as a frozen from-pose relative to a chart
   *  origin (survives per-frame rebases) and enter the GROUND glide there. */
  function enterGround(worldPoint: THREE.Vector3, townRef: unknown | null, headingWorld: THREE.Vector3 | null): void {
    // GROUND uses AVATAR-mode visibility (a room opens only when its door is
    // open to the glide) — any lingering dollhouse cutaway seals up.
    if (townRef !== null && townRef !== undefined) {
      provider.openTown(townRef).structureHost()?.setSpiritFocus(null);
    }
    const session = provider.openGround(worldPoint, townRef ?? undefined);
    // One rung, two geometries: sphere ops when the session speaks loc
    // (planets), else the 2D adapter over the legacy flat contract.
    const geom = session.sphere ? sphereGroundGeom(session.sphere) : flatGroundGeom(session);
    const loc = geom.locFromWorld(worldPoint, new THREE.Vector3());
    const frame = geom.frameAt(loc);
    // Heading: re-express the world heading on the LOCAL frame (default +north).
    let fx = 0;
    let fz = 1;
    if (headingWorld) {
      const hx = headingWorld.dot(frame.east);
      const hz = headingWorld.dot(frame.north);
      if (Math.hypot(hx, hz) > 1e-6) { fx = hx; fz = hz; }
    }
    const g: GroundState = {
      session,
      geom,
      loc,
      entryLoc: loc.clone(),
      gyDev: 0,
      glide: createGroundGlide(0, 0, fx, fz),
      rig: createChaseRig(DEFAULT_CAMERA_TUNABLES, DEFAULT_COMFORT_TUNABLES),
      t: 0,
      fromRel: createSpiritPose(),
      exitHold: 0,
      townRef,
      armed: false,
      aim: null,
      enterHold: 0,
    };
    g.rig.snap(0, 0, fx, fz);
    // Freeze the entry pose RELATIVE to the entry frame (rebase-safe).
    camera.getWorldDirection(_tmpDir);
    g.fromRel.pos.copy(camera.position).sub(frame.origin);
    g.fromRel.look.copy(camera.position).addScaledVector(_tmpDir, 30).sub(frame.origin);
    g.fromRel.up.copy(camera.up);
    g.fromRel.fov = camera.fov;
    ground = g;
    struct = null;
    level = "ground";
  }

  /** Leave the glide upward: back to the district orbit when we came from a
   *  town, else back to flight (both ceiling-gated by the caller). */
  /** Hand the cursor BACK to whichever entity engine the ground rung borrowed
   *  it from. The opt-out is asserted per frame while gliding, so it must be
   *  released on the way out or that host stays cursor-less for the rest of its
   *  life — visible the moment the player walks it as an ordinary avatar. */
  function releaseGroundCursor(): void {
    cursorOptedOut?.setExternalCursor?.(false);
    cursorOptedOut = null;
  }

  function exitGroundUp(g: GroundState): void {
    releaseGroundCursor();
    const chart = g.geom.frameAt(g.loc);
    // Keep FACING: the orbit / the drone continue along the glide's heading,
    // read off the LOCAL frame (the dev axes ARE the local axes).
    _tmpDir.copy(chart.east).multiplyScalar(g.glide.fx)
      .addScaledVector(chart.north, g.glide.fz);
    if (g.townRef !== null) {
      const t = town && town.ref === g.townRef ? town : openTownState(g.townRef);
      town = t;
      t.blend = 1;
      t.exiting = false;
      // Frame a district-scale orbit around where the glide stands. (The
      // TOWN session is chart-rooted at the town centre — that is the town
      // rung's own viewer frame, a legitimate city scope.)
      const c0 = t.session.chartAt(0, 0);
      const dx = chart.origin.x - c0.origin.x;
      const dy = chart.origin.y - c0.origin.y;
      const dz = chart.origin.z - c0.origin.z;
      const lx = dx * c0.east.x + dy * c0.east.y + dz * c0.east.z;
      const lz = dx * c0.north.x + dy * c0.north.y + dz * c0.north.z;
      const radius = THREE.MathUtils.clamp(t.session.radius() * 0.33, 30, 160);
      const az = Math.atan2(_tmpDir.dot(c0.north), _tmpDir.dot(c0.east));
      t.az = az;
      t.targetAz = az;
      t.district = { x: lx, z: lz, radius };
      t.target = { x: lx, z: lz };
      t.targetRadius = radius;
      t.focus = { x: lx, z: lz };
      t.radius = radius;
      t.depth = 1;
      ground = null;
      level = "town";
    } else if (provider.flight) {
      provider.flight.drone.setGround(chart.up, GROUND_EXIT_ALT, _tmpDir);
      ground = null;
      town = null;
      level = "flight";
    }
  }

  // ── Level steps ────────────────────────────────────────────────────────────
  function stepFlight(pointer: SpiritPointer | null, dt: number, now: number): SpiritStepResult {
    const f = provider.flight!;
    const { w, h } = provider.viewSize();
    const fovRad = (camera.fov * Math.PI) / 180;

    const intent = gaze.update({
      pointer: pointer ? { x: pointer.x, y: pointer.y } : null,
      screenToWorld: (px, py) => f.screenToChart(px, py),
      avatar: { x: 0, y: 0 },
      dt, nowMs: now,
    });

    if (pointer && !holdZoom) {
      const ndcX = (pointer.x / w) * 2 - 1;
      const ndcY = -((pointer.y / h) * 2 - 1);
      driveFlightRegimes(ndcX, ndcY, dt);
    } else {
      // Not steering (no gaze, or a zoom transition owns the camera) — the
      // rates are only written by the drive above, so coast them to a stop
      // rather than leaving the last frame's showing.
      slipFwd = slipSide = slipRot = slipClimb = 0;
    }
    f.groundPoint(_anchor);
    f.drone.cameraOffset(_camOff);
    const nf = f.stepStreaming(_anchor, _camOff);
    f.placeCamera();
    camera.near = nf.near;
    camera.far = nf.far;
    camera.updateProjectionMatrix();

    // The gaze spark — a HUD cursor along the actual gaze ray.
    // ASCEND / DESCEND: ease the spark's DEPTH with the climb rate. It rides
    // the gaze ray, so the cursor holds its exact pixel and only its distance
    // changes — climbing draws it IN toward you and swells it, diving throws it
    // OUT ahead. The ease lag is what turns that into "accelerating".
    slipDepth += (slipClimb - slipDepth) * (1 - Math.exp(-SLIP_EASE_K * Math.max(0, dt)));
    if (pointer) {
      const sx = (pointer.x / w) * 2 - 1;
      const sy = -((pointer.y / h) * 2 - 1);
      _ray.setFromCamera(_ndc.set(sx, sy), camera);
      // − : the spark LEADS the motion (see SLIP_DEPTH_GAIN).
      const dist = SPARK_DIST * (1 - slipDepth * SLIP_DEPTH_GAIN);
      _sparkPos.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, dist);
      provider.spark(_sparkPos);
      // ...and the slipstream, in the camera's own axes (the frame the spark's
      // group lives in) — embers stream the opposite way and sell the motion.
      _slipLocal.copy(_sparkPos);
      camera.updateMatrixWorld(true); // the pose above is this frame's; don't read last frame's
      camera.worldToLocal(_slipLocal);
      provider.sparkDrift?.(slipDrift(_slipLocal));
    } else {
      provider.spark(null);
      provider.sparkDrift?.(null);
    }

    const post = provider.postFrame(dt, now);
    holdZoom = post.waiting !== null;

    // ENTER a town only when actually OVER it (its own radius, not its region).
    const near = post.nearTown;
    if (near && f.drone.altitude < CITY_FOCUS_ALT && near.distM < near.radius * TOWN_ENTER_FACTOR) {
      enterTown(near);
    } else if (f.drone.altitude <= GROUND_ENTER_ALT && !holdZoom) {
      // Close to open ground — the dive becomes the GROUND GLIDE (the town
      // gate above claims the descent first when a town is under us).
      f.groundPoint(_anchor);
      _tmpDir.copy(f.drone.heading);
      enterGround(_anchor, near && near.distM < near.radius * TOWN_GROUND_ATTACH ? near.ref : null, _tmpDir);
    }

    const status =
      `SPIRIT ladder-v1 [ptr:${pointer ? "Y" : "N"} aim:${intent.aim ? "Y" : "N"}] · FOCUS=none · ` +
      `alt ${Math.round(f.drone.altitude).toLocaleString()}m` +
      (near ? ` · ${near.label} ${Math.round(near.distM)}m/${Math.round(near.radius * TOWN_ENTER_FACTOR)}m` : " · no town near");
    return { status, waiting: post.waiting, nearTown: near };
  }

  function stepTown(pointer: SpiritPointer | null, dt: number, now: number): SpiritStepResult {
    const t = town!;
    const { w, h } = provider.viewSize();
    const fovRad = (camera.fov * Math.PI) / 180;
    const f = provider.flight ?? null;

    // Live plan radius once it loads (whole-town depth only).
    if (t.depth === 0 && !t.exiting) t.targetRadius = t.session.radius();
    // Ease focus/radius/az/blend from LAST frame's inputs (input lands below,
    // post-rebase — the 1-frame gaze latency discipline).
    t.focus.x += (t.target.x - t.focus.x) * Math.min(1, 5 * dt);
    t.focus.z += (t.target.z - t.focus.z) * Math.min(1, 5 * dt);
    t.radius += (t.targetRadius - t.radius) * Math.min(1, 4 * dt);
    t.az += (t.targetAz - t.az) * Math.min(1, 6 * dt);
    t.blend += ((t.exiting ? 0 : 1) - t.blend) * Math.min(1, CITY_BLEND_RATE * dt);
    const b = t.blend * t.blend * (3 - 2 * t.blend);

    // Poses RELATIVE to the (pre-rebase) focus chart origin.
    const chart = t.session.chartAt(t.focus.x, t.focus.z);
    orbitRelPose(t, chart, fovRad);
    if (f) {
      f.groundPoint(_dg);
      _fltRel.copy(_dg).sub(chart.origin);
      _fltLookRel.copy(_fltRel);
      _fltRel.addScaledVector(f.drone.pos, f.drone.altitude); // pos is the radial up
    } else {
      _fltRel.copy(_orbRel);
      _fltLookRel.copy(_orbLookRel);
    }
    _camRel.lerpVectors(_fltRel, _orbRel, b);
    _lookRel.lerpVectors(_fltLookRel, _orbLookRel, b);
    if (f) {
      const e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3();
      f.drone.basis(e, n, u);
      _upBlend.copy(n).lerp(chart.up, b).normalize();
    } else _upBlend.copy(chart.up);

    _camAbs.copy(chart.origin).add(_camRel);
    const nf = provider.rebaseOnCamera(_camAbs);
    if (nf.camAtOrigin) {
      camera.position.set(0, 0, 0);
      camera.up.copy(_upBlend);
      camera.lookAt(_lookRel.clone().sub(_camRel));
    } else {
      camera.position.copy(_camAbs);
      camera.up.copy(_upBlend);
      camera.lookAt(chart.origin.clone().add(_lookRel));
    }
    camera.near = nf.near;
    camera.far = nf.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // ── Gaze input (effects land next frame) ──
    let hint = t.depth === 0 ? "rest gaze on the town → district" : "rest gaze on a building → enter it";
    if (pointer && !t.exiting) {
      const ndcX = (pointer.x / w) * 2 - 1;
      const ndcY = -((pointer.y / h) * 2 - 1);
      const inZone = t.blend > 0.9 && Math.abs(ndcX) < CITY_ORBIT_EDGE && ndcY < 0.9;
      if (ndcX < -CITY_ORBIT_EDGE) t.targetAz += CITY_ORBIT * ((-CITY_ORBIT_EDGE - ndcX) / (1 - CITY_ORBIT_EDGE)) * dt;
      else if (ndcX > CITY_ORBIT_EDGE) t.targetAz -= CITY_ORBIT * ((ndcX - CITY_ORBIT_EDGE) / (1 - CITY_ORBIT_EDGE)) * dt;

      if (ndcY < -0.7) {
        // Step OUT one focus: district → town → flight (ceiling-gated).
        t.dwellHold = 0;
        const leavingLadder = t.depth === 0;
        if (leavingLadder && !mayAscendTo("flight")) {
          t.exitHold = 0;
          hint = "the ceiling holds here (this world is the town)";
        } else {
          t.exitHold += dt;
          if (t.exitHold >= CITY_EXIT_S) {
            t.exitHold = 0;
            if (t.depth === 1) {
              t.target = { x: 0, z: 0 };
              t.targetRadius = t.session.radius();
              t.depth = 0;
            } else if (f) {
              // Keep FACING: the drone leaves along the orbit's forward.
              _tmpDir.copy(chart.east).multiplyScalar(Math.cos(t.az))
                .addScaledVector(chart.north, Math.sin(t.az));
              f.drone.setGround(chart.up, CITY_FOCUS_ALT * 1.6, _tmpDir);
              t.exiting = true;
            }
          }
        }
      } else if (inZone) {
        t.exitHold = 0;
        const moved = Math.hypot(pointer.x - t.dwellPx, pointer.y - t.dwellPy) > DWELL_MOVE_PX;
        const pick = t.depth === 0
          ? t.session.pickDistrict(ndcX, ndcY)
          : t.session.pickBuilding(ndcX, ndcY);
        // At the district depth, a dwell on the STREET (no building near the
        // gaze, but real town ground) descends into the GROUND GLIDE.
        const groundPick = !pick && t.depth === 1 ? t.session.pickDistrict(ndcX, ndcY) : null;
        if ((!pick && !groundPick) || moved) {
          t.dwellHold = 0;
          t.dwellPx = pointer.x;
          t.dwellPy = pointer.y;
        }
        if (pick || groundPick) {
          t.dwellHold += dt;
          if (t.dwellHold >= CITY_DWELL_S) {
            t.dwellHold = 0;
            if (pick && t.depth === 0) {
              t.district = { x: pick.x, z: pick.z, radius: pick.radius };
              t.depth = 1;
              t.target = { x: pick.x, z: pick.z };
              t.targetRadius = pick.radius;
            } else if (pick) {
              enterStructure(t, pick, t.az + Math.PI / 2);
            } else if (groundPick) {
              const at = t.session.chartAt(groundPick.x, groundPick.z);
              // Keep FACING: glide off along the orbit's forward.
              _tmpDir.copy(chart.east).multiplyScalar(Math.cos(t.az))
                .addScaledVector(chart.north, Math.sin(t.az));
              enterGround(at.origin, t.ref, _tmpDir);
            }
          }
        }
      } else {
        t.exitHold = 0;
        t.dwellHold = 0;
        t.dwellPx = pointer.x;
        t.dwellPy = pointer.y;
      }
    }
    // INTERIOR RULE: a house's interior shows only when THAT house is the
    // focused dollhouse (structure rung) or a door is open to the ground
    // glide — at town/district framing every roof stays sealed.
    t.session.structureHost()?.setSpiritFocus(null);

    provider.spark(null);
    const post = provider.postFrame(dt, now);
    holdZoom = post.waiting !== null;

    if (t.exiting && t.blend < 0.02) {
      t.session.structureHost()?.setSpiritFocus(null);
      town = null;
      level = "flight";
    }

    const lvl = t.depth === 0 ? "TOWN" : "DISTRICT";
    const dwellPct = Math.round((t.dwellHold / CITY_DWELL_S) * 100);
    const status = `SPIRIT ladder-v1 · FOCUS=${lvl} (${t.session.label}) · ${hint} · dwell ${dwellPct}% · bottom → out`;
    return { status, waiting: post.waiting, nearTown: post.nearTown };
  }

  function stepStructure(pointer: SpiritPointer | null, dt: number, now: number): SpiritStepResult {
    const t = town!;
    const s = struct!;
    const { w, h } = provider.viewSize();
    const fovRad = (camera.fov * Math.PI) / 180;
    const host = t.session.structureHost();
    if (!host) {
      // The live session unmounted under us — fall back to the district orbit.
      exitStructureToDistrict(t);
      return stepTown(pointer, dt, now);
    }

    // Keep the orbit easing toward the building (the from-pose closes in).
    t.focus.x += (t.target.x - t.focus.x) * Math.min(1, 5 * dt);
    t.focus.z += (t.target.z - t.focus.z) * Math.min(1, 5 * dt);
    t.radius += (t.targetRadius - t.radius) * Math.min(1, 4 * dt);

    // Float32 precision: rebase the render origin on the viewer BEFORE the
    // pose reads (both pose sources evaluate fresh, post-rebase).
    _camAbs.copy(camera.position);
    const nf = provider.rebaseOnCamera(_camAbs);

    if (!s.engaged) {
      if (s.frame) host.placeGazeAvatar(s.frame.x + s.frame.w / 2, s.frame.y + s.frame.h / 2);
      s.engaged = true;
    }
    // Re-asserted EVERY frame (idempotent): the focus toggle is state on the
    // host's renderer, which can be (re)created under a streaming session —
    // an engage-once write can be silently lost.
    host.setSpiritFocus(s.frame);
    // The dollhouse is the TOWN-VIEW exception to the planet-cursor law: the
    // host's own spark (3D-occluded against its interiors) is the cursor
    // here. Undo the ground rung's opt-out — same every-frame idempotency.
    host.setExternalCursor?.(false);

    // Blend: live orbit pose (from) ↔ live dollhouse pose (to).
    s.t += (s.exiting ? -1 : 1) * (dt / STRUCT_BLEND_S);
    s.t = Math.max(0, Math.min(1, s.t));
    const chart = t.session.chartAt(t.focus.x, t.focus.z);
    orbitRelPose(t, chart, fovRad);
    _fromPose.pos.copy(chart.origin).add(_orbRel);
    _fromPose.look.copy(chart.origin).add(_orbLookRel);
    _fromPose.up.copy(chart.up);
    _fromPose.fov = camera.fov;
    host.dollhousePose(s.frame, s.spiritAz, _toPose);
    blendPose(_fromPose, _toPose, s.t, _outPose);
    applyPose(_outPose, camera);
    camera.near = nf.near;
    camera.far = nf.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // Gaze: L/R orbits the dollhouse azimuth; bottom-dwell steps back out;
    // pointer forwards to the host (interaction) only once the blend has
    // essentially arrived.
    if (pointer) {
      const ndcX = (pointer.x / w) * 2 - 1;
      const ndcY = -((pointer.y / h) * 2 - 1);
      if (ndcX < -CITY_ORBIT_EDGE) s.spiritAz += CITY_ORBIT * ((-CITY_ORBIT_EDGE - ndcX) / (1 - CITY_ORBIT_EDGE)) * dt;
      else if (ndcX > CITY_ORBIT_EDGE) s.spiritAz -= CITY_ORBIT * ((ndcX - CITY_ORBIT_EDGE) / (1 - CITY_ORBIT_EDGE)) * dt;
      if (s.t > STRUCT_INTERACT_T && !s.exiting) host.setPointer(pointer.clientX, pointer.clientY);
      else host.clearPointer();
      if (ndcY < -0.7) {
        // GROUND is the level ABOVE structure — the bottom dwell ascends into
        // the glide (ceiling-gated: a structure-scope/-focus world holds).
        if (mayAscendTo("ground")) {
          s.exitHold += dt;
          if (s.exitHold >= CITY_EXIT_S && !s.exiting) {
            s.exitHold = 0;
            s.exiting = true; // reverse the blend; land in the glide
          }
        } else s.exitHold = 0;
      } else s.exitHold = 0;
    } else host.clearPointer();

    // Step the host AFTER the pose write — its camera-dependent mesh sync
    // (cutaway wall sides, storey fades, blackout sightlines, its own gaze
    // picks) must read the camera as posed against THIS frame's advanced/
    // rebased world. Stepping it first left those reading the previous
    // frame's matrix, a full frame of planetary sweep off the surface —
    // every plane "blocked" (walls faded away wholesale) and the near-wall
    // test flip-flopped (the flickering door).
    host.step(dt, now);

    // The HOST'S own spark is the cursor here — the avatar engine's cursor
    // (3D-occluded, hover/select bloom), fed by the forwarded pointer. The
    // ladder's overlay spark stays hidden so there is only ever one cursor.
    provider.spark(null);
    const post = provider.postFrame(dt, now);
    holdZoom = post.waiting !== null;

    if (s.exiting && s.t <= 0) {
      host.clearPointer();
      host.setSpiritFocus(null);
      // Step out BESIDE the building, on the camera's side, just OUTSIDE its
      // footprint — the spawn itself can never land inside a neighbour (or
      // re-enter this house before the glide actually moves). The camera
      // keeps its current facing (the chase rig snaps to it).
      const halfDiag = s.frame ? Math.hypot(s.frame.w, s.frame.h) / 2 : t.targetRadius;
      const camAz = Math.PI / 2 + s.spiritAz; // the dollhouse camera's side
      const step = halfDiag + STRUCT_EXIT_STEP;
      const at = t.session.chartAt(
        t.target.x + Math.cos(camAz) * step,
        t.target.z + Math.sin(camAz) * step,
      );
      camera.getWorldDirection(_tmpDir);
      struct = null;
      enterGround(at.origin, t.ref, _tmpDir);
    }

    const status = `SPIRIT (${t.session.label})`;
    return { status, waiting: post.waiting, nearTown: post.nearTown };
  }

  function stepGround(pointer: SpiritPointer | null, dt: number, now: number): SpiritStepResult {
    const g = ground!;
    const { w, h } = provider.viewSize();

    // Camera-anchored streaming, then everything evaluates fresh.
    _camAbs.copy(camera.position);
    const nf = provider.rebaseOnCamera(_camAbs);

    // Steer from LAST frame's settled aim — the 1-frame gaze latency
    // discipline (stepTown's rule). The world just ADVANCED (planets orbit
    // and spin) and rebased on the camera point, so the previous frame's
    // camera matrix sits a full frame of that sweep off the surface; a
    // shallow gaze ray amplifies the offset into a huge forward jump (the
    // leaping spark) and the corrupted aim direction flips the rig's
    // overhead/shoulder hysteresis (the up-down camera jerk). The ray is
    // shot only AFTER the camera is posed against THIS frame's world.
    // THE SPARK'S BODY, asked for fresh every frame (never pushed — see
    // SpiritGroundSession.drivenBody). A claimed creature walks on its own legs
    // toward the same gaze; the glide FOLLOWS it instead of steering itself, so
    // the chase rig rides the real avatar. With no claim the glide is the fake
    // body a sparkless spirit needs, and steers as ever.
    const body = g.geom.drivenBody();
    // The LOCAL frame at the glide — rebuilt fresh each frame (rebase-safe);
    // the dev axes are, by construction, this frame's east/north.
    let frame = g.geom.frameAt(g.loc);
    const prevX = g.glide.x;
    const prevZ = g.glide.z;
    if (body) {
      // The claimed body → DEV coords: its local delta from the glide, in
      // the glide's frame; its heading re-expressed across frames (two
      // tangent frames differ by the curvature between them).
      g.geom.surfaceAt(body.loc, _surfPt).sub(frame.origin);
      const be = _surfPt.dot(frame.east);
      const bn = _surfPt.dot(frame.north);
      const bodyFrame = g.geom.frameAt(body.loc);
      _tmpDir.copy(bodyFrame.east).multiplyScalar(body.fx)
        .addScaledVector(bodyFrame.north, body.fz);
      g.glide.follow(
        prevX + be, prevZ + bn,
        _tmpDir.dot(frame.east), _tmpDir.dot(frame.north), dt,
      );
    } else {
      g.glide.update(g.aim, dt);
    }
    // Advance the SURFACE ADDRESS by the dev step — transport along the true
    // surface (great-circle on a planet, translation on a flat world) — and
    // accumulate the ground's local rise/fall for the rig's height law. No
    // anchor, no re-anchor: the frame moves with the glide.
    const de = g.glide.x - prevX;
    const dn = g.glide.z - prevZ;
    if (de !== 0 || dn !== 0) {
      g.geom.move(g.loc, de, dn, g.loc);
      g.gyDev += g.geom.surfaceAt(g.loc, _surfPt).sub(frame.origin).dot(frame.up);
      frame = g.geom.frameAt(g.loc);
    }

    // The glide IS the invisible avatar: park the host's gaze walker on it
    // every frame, so streaming, the static↔live handoff and the door-open
    // interior reveal all follow the glide (not a stale parked spot). While a
    // body is claimed this parks the SPARK'S OWN body on the claimed one —
    // which is exactly right: the spark is a light beside the avatar it rides.
    g.geom.placeAvatar(g.loc);
    // GROUND uses AVATAR-mode visibility — sealed roofs, rooms open only via
    // a door open to the glide. Asserted per frame: a spirit-session town
    // host that MOUNTS mid-glide boots with the frameless town-wide reveal.
    if (g.townRef !== null && g.townRef !== undefined) {
      provider.openTown(g.townRef).structureHost()?.setSpiritFocus(null);
    }

    // Chase rig (the avatar's camera laws) in DEV coords, re-expressed about
    // the glide's ground point and lifted through the LOCAL frame; blended
    // from the frozen entry pose (re-lifted through the entry frame).
    g.rig.update({
      x: g.glide.x, z: g.glide.z, groundY: g.gyDev,
      gaze: g.aim ? { x: g.aim.x, z: g.aim.z } : null,
      dt,
    });
    g.rig.pose(_toPose);
    _toPose.pos.x -= g.glide.x; _toPose.pos.y -= g.gyDev; _toPose.pos.z -= g.glide.z;
    _toPose.look.x -= g.glide.x; _toPose.look.y -= g.gyDev; _toPose.look.z -= g.glide.z;
    liftChartPose(_toPose, frame);
    const entryFrame = g.geom.frameAt(g.entryLoc);
    _fromPose.pos.copy(entryFrame.origin).add(g.fromRel.pos);
    _fromPose.look.copy(entryFrame.origin).add(g.fromRel.look);
    _fromPose.up.copy(g.fromRel.up);
    _fromPose.fov = g.fromRel.fov;
    g.t = Math.min(1, g.t + dt / GROUND_BLEND_S);
    blendPose(_fromPose, _toPose, g.t, _outPose);
    applyPose(_outPose, camera);
    camera.near = nf.near;
    camera.far = nf.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // Gaze with the FRESH camera → next frame's aim + this frame's spark.
    let committed: { x: number; z: number } | null = null;
    const intent = gaze.update({
      pointer: pointer ? { x: pointer.x, y: pointer.y } : null,
      screenToWorld: (px, py) => {
        const ndcx = (px / w) * 2 - 1;
        const ndcy = -((py / h) * 2 - 1);
        _ray.setFromCamera(_ndc.set(ndcx, ndcy), camera);
        const o = _ray.ray.origin;
        const d = _ray.ray.direction;
        // THE GAZE POINT IS WHERE THE RAY MEETS THE *TERRAIN* — not where it
        // meets a flat plane through the glide. Over relief those are different
        // places: on a 12% downhill a mid-screen gaze hit the plane ~4 m SHORT
        // of the ground actually being looked at, and the spark, drawn at the
        // terrain height under that short hit, sat well below the cursor —
        // worse the shallower the gaze, until it left the screen entirely.
        //
        // Solved by BISECTION, not by iterating plane-hit→terrain→plane-hit:
        // that fixed point only converges while the ray out-steepens the slope
        // it chases, and DIVERGES (oscillating) once the ground falls faster
        // than the ray descends — precisely the steep-hillside case this is for.
        // A bracketed bisection cannot diverge and costs a bounded ~18 samples.
        //
        // The march runs in WORLD space against the TRUE surface
        // (geom.heightAbove) — frame-free, so it is exact on a sphere at any
        // distance from anywhere; no anchor is involved. Only the RETURN
        // value is projected into the glide's local frame (DEV coords, for
        // the dwell/steer laws), and the hit is at most GROUND_GAZE_MAX away,
        // where the tangent projection is exact to ~(d/R)².
        const dY = d.dot(frame.up);
        const horiz = Math.hypot(d.dot(frame.east), d.dot(frame.north));
        if (horiz < 1e-6 || Math.abs(dY) < 1e-9) return null; // straight up/down
        const oY = _tmpDir.copy(o).sub(frame.origin).dot(frame.up);
        /** The ray point at `t`, projected to DEV coords about the glide. */
        const ptAt = (t: number): { x: number; y: number } => {
          _surfPt.copy(o).addScaledVector(d, t).sub(frame.origin);
          return {
            x: g.glide.x + _surfPt.dot(frame.east),
            y: g.glide.z + _surfPt.dot(frame.north),
          };
        };
        /** How high the ray flies above the terrain beneath it. Positive =
         *  still in the air; the crossing is the root. */
        const above = (t: number): number =>
          g.geom.heightAbove(_surfPt.copy(o).addScaledVector(d, t));
        const t0 = -oY / dY; // the local tangent-plane hit — the starting bracket
        if (t0 <= 0) return null; // the gaze is above the horizon
        const h0 = above(t0);
        // Level ground: the plane IS the terrain. One sample, exact, done.
        if (Math.abs(h0) < GAZE_MARCH_EPS) return ptAt(t0);
        // Bracket the crossing by expanding from the plane hit — outward when
        // the ray is still airborne there (the ground fell away), inward when it
        // is already underground (the ground rose to meet it).
        const maxT = GROUND_GAZE_MAX / horiz;
        let lo = t0; // airborne end
        let hi = t0; // underground end
        let step = GAZE_BRACKET_STEP / horiz;
        let bracketed = false;
        if (h0 > 0) {
          while (hi < maxT) {
            hi = Math.min(maxT, hi + step);
            if (above(hi) <= 0) { bracketed = true; break; }
            lo = hi;
            step *= 2;
          }
        } else {
          while (lo > 0) {
            lo = Math.max(0, lo - step);
            if (above(lo) > 0) { bracketed = true; break; }
            hi = lo;
            step *= 2;
          }
        }
        // No crossing within reach — a ray grazing the horizon over ground that
        // keeps dropping. Fall back to the plane hit, exactly as before.
        if (!bracketed) return ptAt(t0);
        for (let i = 0; i < GAZE_BISECT_ITERS; i++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid; else hi = mid;
        }
        // The TRUE ground point — the spark and the gaze-in-building test
        // read it unclamped; only the STEERING aim is bounded (below).
        return ptAt((lo + hi) / 2);
      },
      avatar: { x: g.glide.x, y: g.glide.z },
      dt, nowMs: now,
    });
    // Bound the STEERING aim near the glide (GROUND_AIM_MAX) — the avatar's
    // feel: an unbounded horizon aim would pin the yaw law at ~0 turn while
    // the arrive law held full speed.
    g.aim = null;
    if (intent.aim) {
      let ox = intent.aim.x - g.glide.x;
      let oz = intent.aim.y - g.glide.z;
      const od = Math.hypot(ox, oz);
      if (od > GROUND_AIM_MAX) {
        ox *= GROUND_AIM_MAX / od;
        oz *= GROUND_AIM_MAX / od;
      }
      g.aim = { x: g.glide.x + ox, z: g.glide.z + oz };
    }
    if (intent.committedWorld) committed = { x: intent.committedWorld.x, z: intent.committedWorld.y };

    // The cursor's content source: a live town host under the glide still
    // COMPUTES what the pointer rests on (hover snap point, select progress —
    // it receives the forwarded pointer), but it never DRAWS the cursor on
    // this rung. THE PLANET OWNS THE PLAYER'S SPARK (user law): the player is
    // on a planet; a town drawing the cursor was a frame leak, and it masked
    // the planet cursor everywhere a town happened to be mounted.
    const host = g.townRef !== null && g.townRef !== undefined
      ? provider.openTown(g.townRef).structureHost()
      : null;
    const hostHere = host !== null;
    // The committed gaze point's SURFACE ADDRESS (dev → loc via transport
    // from the glide) — the same-house gate reads it (and the overlay-spark
    // fallback below, on providers with no drawn world to raycast).
    const committedLoc = committed
      ? g.geom.move(g.loc, committed.x - g.glide.x, committed.z - g.glide.z, _gazeLoc)
      : null;
    // THE GROUND CURSOR — ONE PIPELINE, flat world or planet. Standing on the
    // ground is the same act in both; only the coordinate root differs, so the
    // cursor may not behave differently either. Each side supplies exactly what
    // it is the authority on:
    //
    //  • THE DRAWN WORLD gives the BARE GROUND POINT. The pointer ray is cast
    //    at the rendered skin (terrain LOD chunks, roads, town meshes, walls),
    //    so the spark sits on the pixel the player is looking at and stops
    //    against a wall the gaze rests on. An engine's analytic ground sampler
    //    cannot do this on a planet — the sampler and the LOD mesh disagree by
    //    metres, which is the spark sinking under the skin.
    //  • THE ENTITY ENGINE under the glide (the quest host — a town's, the
    //    wilderness's) gives the ENTITY SNAP and the DWELL: a settled gaze
    //    resting on a creature or an object reports that entity's head / top,
    //    and select progress blooms the spark. A raycast alone can never know
    //    it is looking AT someone. This is not "the town owning the player's
    //    cursor": buildings and creatures are planet entities that happen to
    //    stand in a town, and the report is WORLD coords — town-plaza
    //    coordinates never enter.
    //
    // A flat standalone world runs the very same split inside its host (its
    // sampler IS its drawn ground), which is why the flat cursor has always
    // read correctly and is the behaviour being matched here.
    //
    // WHO DRAWS IT: the provider, which owns the drawing frame. On a planet
    // that is the camera-parented spark (floating-origin safe, ONE cursor
    // whether or not a town happens to be mounted — no hand-off pop at the
    // town boundary); on a flat standalone world the host draws its own, in
    // the same scene, with the same GazeSpark laws.
    //
    // The march's committed point still drives steering/dwell/possession —
    // simulation truth — but the visible cursor never depends on it.
    let owner: string;
    // Assert the opt-out every frame (self-healing — the host may have
    // (re)mounted mid-glide, and its view mounts late). A host that draws its
    // own spark AND reports would put two cursors on screen.
    const reporter = provider.groundSpark ? (provider.cursorHost?.() ?? host) : null;
    if (reporter !== cursorOptedOut) releaseGroundCursor(); // the engine changed under the glide
    reporter?.setExternalCursor?.(true);
    cursorOptedOut = reporter;
    const report = provider.groundSpark && pointer
      ? (reporter?.cursorWorld?.(_sparkPos) ?? null)
      : null;
    if (provider.groundSpark) {
      // ONE call, one cursor: the provider puts its ground cursor where the
      // pointer ray meets the DRAWN world — unless an entity engine has SNAPPED
      // the gaze onto something it owns (a creature's head, an object's top),
      // which no ground ray can produce, in which case that point wins.
      provider.groundSpark(
        pointer ? { x: pointer.x, y: pointer.y } : null,
        report?.select ?? 0,
        report?.hovering ? _sparkPos : undefined,
      );
      owner = report?.hovering ? "rep" : report ? "prov+" : "prov";
    } else if (hostHere) {
      // FLAT standalone: the host draws its own engine cursor (unchanged).
      provider.spark(null);
      owner = "host";
    } else if (committedLoc) {
      // Fallback: TRUE surface point (frame-free), floated just above the
      // ground along the local up.
      g.geom.surfaceAt(committedLoc, _sparkPos).addScaledVector(frame.up, 0.4);
      provider.spark(_sparkPos);
      owner = "fallb";
    } else {
      provider.spark(null);
      owner = "none";
    }
    // PROBE: which owner drew the cursor, and the town state that decided it.
    // `rep` = an entity engine resolved it (the good path — hover + dwell);
    // `prov` = the bare drawn-world ray (no engine reporting: wilderness, or a
    // gaze that has settled on nothing); `host` = a flat standalone drawing its
    // own. `ptr` tells a MISSED cast apart from a frame nobody asked for a
    // cursor at all.
    groundDbg =
      `${owner} ptr:${pointer ? `${Math.round(pointer.x)},${Math.round(pointer.y)}` : "-"}` +
      ` town:${g.townRef !== null && g.townRef !== undefined ? "ref" : "-"}`;

    const post = provider.postFrame(dt, now);
    holdZoom = post.waiting !== null;

    // TOWN = CONTENT UNDER THE GLIDE, refreshed every frame (planet law).
    // Entry froze the ref for the whole session — stale in BOTH directions:
    // gliding OUT kept the old town resolving buildings/cursor over open
    // country; gliding IN from the wilderness never acquired the town at all
    // (no building entry, no gaze walker, no district exit above it). One
    // frame of latency (post.nearTown is measured this frame, consumed next)
    // is centimetres at glide speed. TWO opt-outs:
    //  • sessions WITHOUT `setTown` (flat standalone worlds) keep their entry
    //    ref forever — their town IS the world, and their postFrame reports
    //    no nearTown, so a refresh would strip a perfectly live ref;
    //  • while the spark RIDES one of the town's bodies the ref is pinned —
    //    the ride outranks the radius (dropping the ref would orphan the
    //    driven body mid-ride; the host layer's unmount guard makes the same
    //    call).
    if (!body && g.session.setTown) {
      const nt = post.nearTown;
      const freshRef = nt && nt.distM < nt.radius * TOWN_GROUND_ATTACH ? nt.ref : null;
      if (freshRef !== g.townRef) {
        g.townRef = freshRef;
        g.session.setTown?.(freshRef);
      }
    }

    // PINNED TO GROUND while the spark rides a body. BOTH rung changes below
    // are SPIRIT affordances that stop making sense once the player has legs:
    //  • the bottom dwell must not climb to the district orbit — the player
    //    asked for exactly this: with an avatar, the screen bottom is just the
    //    ground behind you, not a way out (and the camera abandoning the body
    //    you are walking is the bug this whole seam exists to fix);
    //  • gliding into a house must not cut its roof away. A dollhouse is a
    //    GHOST inspecting a building from outside; a body simply walks in, and
    //    the ground rung's own door-open reveal already shows it the room.
    // Both holds reset so a release never lands mid-dwell on a stale count.
    if (body) {
      g.enterHold = 0;
      g.exitHold = 0;
      return {
        status: "SPIRIT ladder-v1 · FOCUS=GROUND · riding a body",
        waiting: post.waiting,
        nearTown: post.nearTown,
      };
    }

    // GLIDING INTO A BUILDING descends into its dollhouse (structure mode).
    // Two gates: entry ARMS only once the glide has stood outside every
    // footprint (a doorstep spawn never instantly re-possesses), and BOTH
    // the glide and the settled GAZE must rest in the SAME building for a
    // short dwell — flying through a house while looking past it (the gaze
    // point lands beyond the far wall) never captures it.
    const hit = g.geom.buildingAt(g.loc);
    const gazeHit = hit && committedLoc ? g.geom.buildingAt(committedLoc) : null;
    const sameHouse = !!hit && !!gazeHit &&
      Math.abs(gazeHit.target.x - hit.target.x) < 0.5 &&
      Math.abs(gazeHit.target.z - hit.target.z) < 0.5;
    if (!g.armed) {
      if (!hit) g.armed = true;
      g.enterHold = 0;
    } else if (g.t > 0.9 && sameHouse) {
      g.enterHold += dt;
    } else {
      g.enterHold = 0;
    }
    if (g.armed && g.enterHold >= GROUND_POSSESS_DWELL_S && hit) {
      const t = town && town.ref === hit.town ? town : openTownState(hit.town);
      town = t;
      t.blend = 1;
      t.exiting = false;
      t.depth = 1;
      t.focus = { x: hit.target.x, z: hit.target.z };
      t.radius = hit.target.radius;
      // The district to return to = a neighbourhood around the building.
      t.district = {
        x: hit.target.x, z: hit.target.z,
        radius: THREE.MathUtils.clamp(t.session.radius() * 0.33, 30, 160),
      };
      // Keep FACING: the dollhouse starts at the glide's heading.
      const spiritAz = Math.atan2(g.glide.fx, -g.glide.fz);
      ground = null;
      releaseGroundCursor(); // the dollhouse draws its own (town-view exception)
      enterStructure(t, hit.target, spiritAz);
      return { status: "SPIRIT", waiting: post.waiting, nearTown: post.nearTown };
    }

    // Bottom-dwell ascends: back to the district orbit (a town glide) or to
    // flight (open ground) — ceiling-gated.
    let hint = "";
    if (pointer) {
      const ndcY = -((pointer.y / h) * 2 - 1);
      if (ndcY < -0.7) {
        const to: SpiritLevel = g.townRef !== null ? "town" : "flight";
        if (mayAscendTo(to)) {
          g.exitHold += dt;
          if (g.exitHold >= CITY_EXIT_S) {
            g.exitHold = 0;
            exitGroundUp(g);
          }
        } else {
          g.exitHold = 0;
          hint = "the ceiling holds here";
        }
      } else g.exitHold = 0;
    }

    const status = `SPIRIT ladder-v1 · FOCUS=GROUND · ${hint}`;
    return { status, waiting: post.waiting, nearTown: post.nearTown };
  }

  return {
    get level() { return level; },
    get ceiling() { return ceiling; },
    setCeiling(l) { ceiling = clampCeiling(l); },
    dropToGround(worldPoint, townRef = null) {
      // Keep FACING: resume the glide along the camera's current forward.
      camera.getWorldDirection(_tmpDir);
      enterGround(worldPoint, townRef, _tmpDir);
    },
    groundInTown() {
      return level === "ground" && !!ground &&
        ground.townRef !== null && ground.townRef !== undefined;
    },
    debugGround() {
      if (level !== "ground" || !ground) return "-";
      // The glide's height above the surface + the provider's own cursor
      // verdict: together they say whether the ray had anything to hit.
      // Glide position in DEV (chart-local) coords + the provider's own cursor
      // verdict. The glide is where the player IS; pair it with `cur:` to see
      // the cursor die exactly as the town's mount radius is crossed.
      return `${groundDbg} g:${ground.glide.x.toFixed(0)},${ground.glide.z.toFixed(0)} cur:${
        provider.debugCursor?.() ?? "-"
      }`;
    },
    focusWorld(out) {
      if (level === "ground" && ground) {
        ground.geom.surfaceAt(ground.loc, out);
        return true;
      }
      if ((level === "town" || level === "structure") && town) {
        out.copy(town.session.chartAt(town.focus.x, town.focus.z).origin);
        return true;
      }
      return false;
    },
    step(pointer, dt, now) {
      provider.advance(dt, now);
      // ILLUSORY MOTION is a FLIGHT-rung effect. Clear it for every other rung
      // up front, so a rung change can never leave the ground/town cursor
      // fizzing embers on the last rates flight happened to hold.
      if (level !== "flight") {
        slipFwd = slipSide = slipRot = slipClimb = slipDepth = 0;
        provider.sparkDrift?.(null);
      }
      if (level === "ground" && ground) return stepGround(pointer, dt, now);
      if (level === "structure" && town && struct) return stepStructure(pointer, dt, now);
      if (level === "town" && town) return stepTown(pointer, dt, now);
      if (provider.flight) return stepFlight(pointer, dt, now);
      // No flight seam and no session — nothing to drive (a flat provider
      // must always start inside a session).
      return { status: "SPIRIT ladder-v1 · no world", waiting: null, nearTown: null };
    },
    dispose() {
      releaseGroundCursor();
      town?.session.structureHost()?.clearPointer();
    },
  };
}

/** Lift a CHART-LOCAL pose (x = east, y = up, z = north metres) into world
 *  space through a chart frame, in place. */
function liftChartPose(pose: SpiritPose, chart: SpiritChartFrame): void {
  const px = pose.pos.x, py = pose.pos.y, pz = pose.pos.z;
  pose.pos.copy(chart.origin)
    .addScaledVector(chart.east, px)
    .addScaledVector(chart.up, py)
    .addScaledVector(chart.north, pz);
  const lx = pose.look.x, ly = pose.look.y, lz = pose.look.z;
  pose.look.copy(chart.origin)
    .addScaledVector(chart.east, lx)
    .addScaledVector(chart.up, ly)
    .addScaledVector(chart.north, lz);
  const ux = pose.up.x, uy = pose.up.y, uz = pose.up.z;
  pose.up.set(0, 0, 0)
    .addScaledVector(chart.east, ux)
    .addScaledVector(chart.up, uy)
    .addScaledVector(chart.north, uz)
    .normalize();
}
