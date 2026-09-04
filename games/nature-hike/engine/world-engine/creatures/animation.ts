// Creature animation controller — stand / walk / run / pick up / put down.
//
// PURE MATH. No three.js — node-testable, server-importable, like the rest
// of the creature core (blueprint / skeleton / gait / balance).
//
// The controller does NOT pose bones. Each frame it emits the INPUTS the
// existing solvers consume — a gait (cycled feet + bob + lean), a posture
// (bodyHeight/bodyPitch, which the strain engine turns into folded or
// straightened legs), and pose overrides (hand IK targets, arm swing) —
// and buildSkeleton produces the frame's pose exactly the way it produces
// the rest pose. Standing is the gait at zero speed; a pick-up is just a
// posture crouch plus a hand target that happens to be an object.
//
// The caller drives the loop:
//   const frame = animator.update(dt);
//   blueprint.posture = frame.posture;               // scratch copy
//   const skel = buildSkeleton(blueprint, frame.gait, frame.pose, undefined,
//                              { gravity, loads: frame.loads });
//   animator.observe(skel);                       // hand-position feedback
// The observe() feedback is what makes reaching robust: if the hands aren't
// closing on the object, the controller keeps crouching — no closed-form
// reachability math to drift out of sync with the strain solver. It is also
// what makes the body HONEST ABOUT WEIGHT: the ledger it reads back is what
// the refusal gate measures against and what the carried mass is compared to,
// so a host that never observes gets the poses and none of the physics.
//
// Grasping is one-handed, two-handed, or by MOUTH. One hand needs an
// opposable digit (a thumb); TWO hands need none — the palms bracket the
// object from opposite sides and act as the pincer — so thumbless kind
// with free forelimbs can still lift things, and any kind uses both
// hands once the object outgrows a single palm. A kind with neither
// (a bird, a dog) but with a jaw (head.mouthOpen > 0) picks up with its
// beak/muzzle: the same crouch feedback walks the snout tip onto the
// object and the jaw does the pinching (pose.gape open → closed). The
// timeline slows for bulky objects.

import type { Blueprint } from "./blueprint";
import { locomotionGait, type GaitParams, type GaitPattern } from "./gait";
import {
  bendCapacity,
  cantileverStress,
  canBear,
  objectMassFromSize,
  type BearVerdict,
  type CarriedLoad,
} from "./physio";
import {
  limbChainName,
  limbTip,
  type CreatureSkeleton,
  type PoseOverrides,
  type SupportDiagnostics,
  type Vec3,
} from "./skeleton";

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
/** Smoothstep ease for action timelines. */
const ease = (t: number): number => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};

// Action timeline durations, seconds (lift/lower stretch with object size).
// `point`/`point-back` raise and drop the pointing limb; `point-hold` is timed
// separately (the caller's hold duration).
const DUR = { reach: 0.9, grasp: 0.3, lift: 0.8, lower: 0.9, release: 0.3, return: 0.6, point: 0.45, "point-back": 0.5 } as const;
/** How much LONGER a lift/lower takes for a load as heavy as the body itself.
 *  Multiplies the existing bulk factor (which is about SIZE — a wide object is
 *  awkward whatever it weighs) rather than replacing it: a big light thing is
 *  slow because it is big, a small heavy thing because it is heavy. */
const LOAD_HEFT = 2;
const GRIP_CLOSED = 0.85;
const GRIP_WRAP = 0.55; // two flat palms pressing a bulky object
const GRIP_OPEN = 0.1;
const GAPE_WIDE = 0.9; // jaw open, about to bite
const GAPE_HOLD = 0.22; // jaw clamped on the carried object

export type ActionKind =
  | "none" | "reach" | "grasp" | "lift" | "carry" | "lower" | "release" | "return"
  // Deictic pointing: raise the chosen limb toward a direction, hold, drop.
  | "point" | "point-hold" | "point-back";

/**
 * A sustained ACTIVITY the body performs in place — SPECIES-AGNOSTIC by
 * construction: each one is pure posture/pose modulation through the same
 * solvers every body plan already rides (bodyHeight folds the legs via the
 * strain engine, bodyPitch bows the trunk, a hand IK target reaches — no
 * per-species keyframes anywhere).
 *   • "sleep" — legs fold, the frame emits `recline` so the model lays the
 *     whole body flat (lying is a root transform, not a solver pose);
 *   • "eat"  — a periodic hand-to-mouth for a handed kind, a bow for the rest;
 *   • "sit"  — a held crouch (the strain engine folds the legs), trunk upright;
 *   • "play" — down over a spot on the ground in front, working at it: the legs
 *     fold, the trunk bows forward, and the FRONT bilateral pair paddles a low
 *     forward point in alternation. Hands if the kind has them, else the same
 *     front legs it stands on (the dog batting a ball), else — with no usable
 *     pair at all — the SNOUT, nosing the thing about on the trunk's own pitch.
 *     That ladder is the whole reason this is limb-group-picked rather than
 *     keyframed; see `pickFrontGroup`.
 *     (The pre-2026-07-28 "play" was a light bounce + sway in place. That reads
 *     as a basic DANCE, not as playing with something, which is why it was
 *     replaced — and it is the natural starting point for the `dance` activity
 *     the song/dance chapter adds: bounce at PLAY_BOUNCE_HZ ≈ 1.8 with a ±0.05
 *     lift and a 0.9 Hz pitch sway.)
 * Unlike an action it has no timeline: the caller holds it set and the animator
 * eases it in/out (`setActivity`).
 */
export type BodyActivity = "none" | "sleep" | "eat" | "sit" | "play";

// Activity tuning: blend rate + the rhythm of the periodic ones.
const ACTIVITY_BLEND_RATE = 2.6; // 1/s → ~0.4 s ease in/out
const EAT_PERIOD_S = 1.6; // one hand-to-mouth / bow per period
// PLAY: down at a spot on the ground in front, front limbs working at it.
const PLAY_PADDLE_HZ = 1.5; // limb strokes per second at the play spot
const PLAY_CROUCH = 0.5; // legs fold nearly as deep as a sit — the body comes DOWN
const PLAY_BOW = 0.3; // trunk pitch over the spot (a handless kind bows harder)
const PLAY_GRIP = 0.35; // a loose paw pushing the thing about, not a grasp
const SIT_CROUCH = 0.55; // held crouch amount 0..1 (legs fold, trunk stays up)
const SLEEP_CROUCH = 0.3; // relaxed, slightly-bent legs while lying

type SideKey = "L" | "R";
const sideKey = (s: 1 | -1): SideKey => (s > 0 ? "R" : "L");

export interface AnimPosture {
  bodyPitch: number;
  bodyHeight: number;
}

export interface AnimFrame {
  /** Gait to feed buildSkeleton — undefined while standing still. */
  gait?: GaitParams;
  /** Posture to write into the (scratch) blueprint before building. */
  posture: AnimPosture;
  /** Limb overrides (hand IK targets, arm swing) for buildSkeleton. */
  pose: PoseOverrides;
  /** True while the object is attached to the hand(s) — the renderer
   *  should draw it at the hand tip (one hand) or between them (two). */
  holding: boolean;
  /** Bone-chain prefixes of the acting graspers, when an action is
   *  running: one entry for a single-hand grasp, two (L then R) for a
   *  two-handed carry, ["snout"] (or ["jaw"]) for a mouth carry — the
   *  renderer draws the held object at the tip (or between two tips).
   *  `handChain` is the first, kept for convenience. */
  handChains?: string[];
  handChain?: string;
  /** Ground speed the current gait implies (m/s) — for a host that moves
   *  the creature through the world (the lab treadmills in place). */
  speedMps: number;
  /** Current action phase, for UIs/tests. */
  action: ActionKind;
  /** Eased 0..1 "lie the body flat" amount (the sleep activity). The MODEL
   *  applies it as a root rotation — lying isn't a solver pose, so the pure-math
   *  animator only reports how far along the recline is. */
  recline?: number;
  /** 🚨 WHAT THE BODY IS CARRYING THIS FRAME, and the CALLER'S CONTRACT:
   *  merge it into the `phys` you already pass to `buildSkeleton` —
   *
   *      const skel = buildSkeleton(bp, frame.gait, frame.pose, undefined,
   *                                 { gravity, loads: frame.loads });
   *
   *  A load is extra WEIGHT at a point, not a ground contact: it raises the
   *  total the legs hold, drags the CoM toward itself, and bends the part it
   *  hangs from. Ignoring it costs nothing but the honesty — the pose is then
   *  the unloaded one, exactly as before this existed.
   *
   *  Undefined (never an empty array) when nothing is carried, so
   *  `{ loads: frame.loads }` is the byte-identical unloaded build.
   *
   *  The points are creature-local POST-LIFT — the frame `pose.limbTargets`
   *  and `pose.snoutTarget` live in, and the frame the caller is already
   *  drawing the object in. They are ONE FRAME OLD where they come from
   *  `observe` (the hand tips, the snout tip, the back's girth peak), which is
   *  exactly what the renderer does with the same points.
   *
   *  A held object appears here from the LIFT (when `holding` goes true) to
   *  the RELEASE; a `setBackLoad` pack appears every frame until it is
   *  cleared. An object still sitting on the ground is not a load. */
  loads?: CarriedLoad[];
}

/** Where a load can ride: the root of a carrying part and how thick it is —
 *  what a cantilever needs. Read off the last observed skeleton, never
 *  computed from the blueprint, so it is the body that was actually built. */
interface CarrySeat {
  root: Vec3;
  radius: number;
}

/** The limb group usable as a ONE-handed grasper: bilateral, non-membranous,
 *  with an opposable digit — "has a thumb" is what makes a single hand able
 *  to grip. Front groups win ties. -1 if none. */
export function pickHandGroup(g: Blueprint): number {
  let best = -1;
  let bestScore = 0.3; // opposition floor — below this one hand can't grip
  g.limbGroups.forEach((grp, i) => {
    if (grp.placement !== "bilateral" || grp.membrane >= 0.55) return;
    const score = grp.opposition + (1 - grp.stationStart) * 0.2;
    if (grp.opposition >= 0.3 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** Fallback graspers for TWO-handed lifts: a free forelimb pair — bilateral,
 *  non-membranous, and clearly shorter than the longest such group (too
 *  short to stand on, so it hangs as arms). No thumb needed: the two palms
 *  bracket the object. -1 if the creature has no free pair. */
export function pickArmGroup(g: Blueprint): number {
  const leggy = g.limbGroups.filter((l) => l.placement === "bilateral" && l.membrane < 0.55);
  const longest = Math.max(0, ...leggy.map((l) => l.lengthFrac));
  let best = -1;
  let bestScore = 0;
  g.limbGroups.forEach((grp, i) => {
    if (grp.placement !== "bilateral" || grp.membrane >= 0.55) return;
    if (grp.lengthFrac >= longest * 0.75) return; // a standing leg, not an arm
    const score = 1 - grp.stationStart + (longest - grp.lengthFrac);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/**
 * The FRONT bilateral limb pair — what a creature paddles a toy with when it has
 * no hands (toys-and-song-expansion.md: "animals without hands also play by
 * moving the items with their front legs"). Unlike `pickArmGroup` this does NOT
 * require the pair to be too short to stand on: a quadruped's front legs ARE
 * standing legs, and batting a ball with one is exactly what a dog does. Front-
 * most wins (lowest `stationStart`), longest breaking ties so a stubby vestigial
 * pair never beats the real forelegs. -1 if the body has no bilateral pair.
 */
export function pickFrontGroup(g: Blueprint): number {
  let best = -1;
  let bestScore = -Infinity;
  g.limbGroups.forEach((grp, i) => {
    if (grp.placement !== "bilateral" || grp.membrane >= 0.55) return;
    const score = -grp.stationStart + grp.lengthFrac * 0.1;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/**
 * The limb a creature POINTS with — anatomy, not a hardcoded "arm". The rule
 * (works for any body the builder makes): "raise and straighten the limb that
 * extends furthest from the body in a neutral stance, NOT counting the ones
 * needed for balance."
 *
 * Real limb groups only (non-membranous — a wing/fin can't point). A limb
 * clearly shorter than the standing legs hangs FREE (an arm / foreleg) and can
 * be raised without losing balance → a humanoid points with its arm. When every
 * limb is a full-length leg, a creature with SEVERAL leg groups (a quadruped)
 * can spare its front-most pair on tripod balance → a dog lifts a front paw; a
 * single leg group (a pure biped, a snake) has nothing to spare → null (the
 * host falls back to turning the whole body). Among the sparable limbs, the one
 * that reaches furthest wins.
 *
 * (Flexible chains — an elephant's trunk — are an even better pointer but pose
 * through a different, wave-driven path; deferred until a chain-bearing
 * creature ships. See instructions/creatures.md.)
 */
export function pickPointLimb(g: Blueprint): number {
  const limbs = g.limbGroups
    .map((grp, i) => ({ grp, i }))
    .filter(({ grp }) => grp.membrane < 0.55);
  if (limbs.length === 0) return -1;
  const longest = Math.max(...limbs.map(({ grp }) => grp.lengthFrac));
  // Arms: dangling limbs, clearly shorter than the standing legs.
  let candidates = limbs.filter(({ grp }) => grp.lengthFrac < longest * 0.75);
  if (candidates.length === 0) {
    // No free arm. A creature with >1 leg group can spare its front pair; a
    // single leg group can't stand on fewer.
    if (limbs.length < 2) return -1;
    const front = limbs.reduce((a, b) => (b.grp.stationStart < a.grp.stationStart ? b : a));
    candidates = [front];
  }
  // Furthest-reaching sparable limb.
  const best = candidates.reduce((a, b) => (b.grp.lengthFrac > a.grp.lengthFrac ? b : a));
  return best.i;
}

export class CreatureAnimator {
  private readonly g: Blueprint;
  private readonly legLen: number;
  private readonly handGroup: number;
  private readonly armGroup: number;
  /** The pair that works a toy at the play spot — hands, else the front legs
   *  (pickFrontGroup). -1 for a body with no bilateral pair at all. */
  private readonly playGroup: number;
  /** Chain whose tip is the bite point ("snout", or "jaw" for a snoutless
   *  mouth) — null when the kind has no jaw to grasp with. */
  private readonly mouthChain: string | null;
  private readonly basePosture: AnimPosture;

  private time = 0;
  private phase = 0; // gait cycle phase 0..1
  private speed = 0; // smoothed 0..1
  private speedTarget = 0;
  pattern: GaitPattern = "trot";

  private action: ActionKind = "none";
  private actionT = 0;
  /** Sustained activity: the currently-posed kind, the caller's target kind,
   *  and the eased blend amount for the posed kind. A kind change eases the
   *  old pose out to 0 first, then switches and eases the new one in. */
  private activity: BodyActivity = "none";
  private activityTarget: BodyActivity = "none";
  private activityAmt = 0;
  /** Limb group + sides doing the current grasp (2 sides = two-handed). */
  private activeGroup: number;
  private sides: Array<1 | -1> = [];
  private objectPos: Vec3 = v3(0, 0, 0);
  private objectSize = 0;
  private putPos: Vec3 = v3(0, 0, 0);
  private crouch = 0; // 0..1 extra crouch the reach feedback has added
  private holding = false;
  private grip = GRIP_OPEN;
  private gape = 0;
  /** Grasping with the mouth this action (no usable limb pair). */
  private usingMouth = false;

  /** The limb this creature points with (anatomy-picked), and the current
   *  point's direction/side/hold. -1 = nothing can point (host turns the body). */
  private readonly pointGroup: number;
  private pointDir: Vec3 = v3(0, 0, 1);
  private pointSide: 1 | -1 = 1;
  private pointHoldT = 0;

  /** Hand tips observed from the last built skeleton, per side. */
  private handTips: Record<SideKey, Vec3 | null> = { L: null, R: null };
  /** Standing hand positions captured when the action started (each reach's
   *  start point and each return's end point). */
  private restHands: Record<SideKey, Vec3 | null> = { L: null, R: null };
  private lastTargets: Record<SideKey, Vec3 | null> = { L: null, R: null };
  private lastHandDist = 0;
  /** Standing snout-tip position, observed from the last idle skeleton — the
   *  mouth's equivalent of `restHands`. Null until one has been seen. */
  private restSnout: Vec3 | null = null;
  /** The snout tip as of the LAST frame, idle or not — where a mouth-carried
   *  object actually is (the renderer draws it at this same point). */
  private snoutTip: Vec3 | null = null;

  // ── Carried mass ──────────────────────────────────────────────────────
  /** Proxy mass of the object being picked up / carried (physio units — see
   *  `objectMassFromSize`). 0 = carrying nothing, and the frame then emits no
   *  load for the hands/mouth. */
  private loadMass = 0;
  /** A persistent pack: mass riding on the spine's girth peak until cleared.
   *  Independent of any action — the beast-of-burden seam. */
  private backLoad = 0;
  /** The last ledger `observe` saw. The refusal gate is a MEASUREMENT, so
   *  with none it cannot veto (see `pickUp`). */
  private lastSupport: SupportDiagnostics | null = null;
  /** Why the last `pickUp` said no. Null after any accepted one. */
  private refusal: BearVerdict | null = null;
  private seatNeck: CarrySeat | null = null;
  private seatHand: Record<SideKey, CarrySeat | null> = { L: null, R: null };
  /** Top of the fattest torso bone — where a pack sits. */
  private seatBack: Vec3 | null = null;

  constructor(blueprint: Blueprint) {
    this.g = blueprint;
    const legs = blueprint.limbGroups.filter((l) => l.membrane < 0.55);
    this.legLen = Math.max(0.1, ...legs.map((l) => l.lengthFrac)) * blueprint.spine.torsoLengthM;
    this.handGroup = pickHandGroup(blueprint);
    this.armGroup = pickArmGroup(blueprint);
    // Hands if it has them, else the front legs it stands on — the play stroke
    // is the one activity that drives limbs a grasp would refuse.
    this.playGroup = this.handGroup >= 0 ? this.handGroup : pickFrontGroup(blueprint);
    this.mouthChain = blueprint.head.mouthOpen > 0
      ? (blueprint.head.snoutLengthFrac > 0 ? "snout" : "jaw")
      : null;
    this.activeGroup = this.handGroup >= 0 ? this.handGroup : this.armGroup;
    this.pointGroup = pickPointLimb(blueprint);
    this.basePosture = { bodyPitch: blueprint.posture.bodyPitch, bodyHeight: blueprint.posture.bodyHeight };
  }

  /** 0 = stand, ~0.3 = walk, 1 = full run. Eased, so speed changes blend. */
  setSpeed(target01: number): void {
    this.speedTarget = clamp01(target01);
  }

  get currentAction(): ActionKind {
    return this.action;
  }

  /** Hold (or clear, with "none") a sustained body activity. Idempotent — a
   *  host sets it every frame from its own state; the animator eases the pose
   *  in while set and back out once cleared. */
  setActivity(kind: BodyActivity): void {
    this.activityTarget = kind;
  }

  get currentActivity(): BodyActivity {
    return this.activity;
  }

  /** Eased 0..1 strength of the CURRENT activity's pose — a model syncs its own
   *  root transforms (the slide onto a bed) to this so they blend as one move. */
  activityLevel(): number {
    return ease(this.activityAmt);
  }

  /** The SMOOTHED locomotion dial (0 = still, 1 = full run) — not the raw target
   *  `setSpeed` was handed, but the eased value the gait rides. A model syncs its
   *  anchor slide-OFF to this so a body walking off a fixture eases away over the
   *  speed ramp instead of snapping the instant the sim velocity spikes. */
  speedLevel(): number {
    return clamp01(this.speed);
  }

  /** True while any activity pose is in effect or still blending out — a baked
   *  NPC's temporary dynamic body must not retire until this clears. */
  activityBusy(): boolean {
    return this.activityTarget !== "none" || this.activityAmt > 0.01;
  }

  hasHands(): boolean {
    return this.activeGroup >= 0;
  }

  /** True if pickUp() can do anything: hands, a bracket pair, or a jaw. */
  canGrasp(): boolean {
    return this.activeGroup >= 0 || this.mouthChain !== null;
  }

  /** True if the creature has a limb it can raise to point (else the host turns
   *  the whole body toward the target instead). */
  canPoint(): boolean {
    return this.pointGroup >= 0;
  }

  /**
   * Raise the pointing limb toward a DIRECTION (creature-local, +Z forward;
   * only the horizontal component is used) and hold it `holdS` seconds before
   * dropping it. The limb straightens fully along the ray — the deictic "it's
   * that way". No-op (false) if nothing can point or an action is already
   * running.
   */
  point(dirLocal: Vec3, holdS = 1.4): boolean {
    if (this.action !== "none" || this.pointGroup < 0) return false;
    const len = Math.hypot(dirLocal.x, dirLocal.z);
    const fx = len > 1e-6 ? dirLocal.x / len : 0;
    const fz = len > 1e-6 ? dirLocal.z / len : 1;
    this.pointDir = v3(fx, 0, fz);
    this.pointSide = fx >= 0 ? 1 : -1;
    this.pointHoldT = Math.max(0, holdS);
    this.activeGroup = this.pointGroup;
    this.sides = [this.pointSide];
    this.restHands[sideKey(this.pointSide)] = this.restHandOf(this.pointSide);
    this.action = "point";
    this.actionT = 0;
    this.grip = GRIP_OPEN;
    return true;
  }

  /** The straight-arm point target: a spot BEYOND the limb's reach along the
   *  point direction at shoulder height, so the IK straightens the whole limb
   *  toward it (an out-of-range target is approached along the reach line). */
  private pointTarget(): Vec3 {
    const grp = this.g.limbGroups[this.pointGroup];
    const reach = grp ? grp.lengthFrac * this.g.spine.torsoLengthM : this.legLen;
    const shoulderY = this.legLen * 0.9;
    const d = reach * 1.6;
    return v3(this.pointDir.x * d, shoulderY, this.pointDir.z * d);
  }

  private restHandOf(s: 1 | -1): Vec3 {
    return this.restHands[sideKey(s)] ??
      v3(s * 0.25 * this.legLen, this.legLen * 0.8, 0.1 * this.g.spine.torsoLengthM);
  }

  /** Start reaching for an object at `target` (creature-local, +Z forward),
   *  `sizeM` across, weighing `massProxy` (default: `objectMassFromSize`, an
   *  object as dense as the body carrying it — pass your own for a bale of
   *  hay or an anvil; the units are physio's volume proxy, NOT kilograms).
   *
   *  Small objects take the near-side hand; an object wider than a palm — or
   *  any object, for a kind without opposable digits — takes BOTH hands,
   *  bracketing it from opposite sides. A kind with no usable limb pair at all
   *  falls back to its MOUTH (needs head.mouthOpen).
   *
   *  🚨 FALSE MEANS NOTHING STARTED, and there are three reasons: no grasper,
   *  an action already running, or the body REFUSES the mass — it cannot bear
   *  it (see `admits` / `lastRefusal`). The refusal check runs before any
   *  state is touched, so a refused pick-up leaves the animator exactly as it
   *  was. */
  pickUp(target: Vec3, sizeM = 0, massProxy?: number): boolean {
    if (this.action !== "none") return false;
    const mass = Math.max(0, massProxy ?? objectMassFromSize(sizeM));
    const thumbed = this.handGroup >= 0;
    const group = thumbed ? this.handGroup : this.armGroup;
    if (group < 0) {
      if (!this.mouthChain) return false;
      if (!this.admits(mass, true, [], group)) return false;
      // Mouth grasp — no limb targets: the crouch/lean feedback carries
      // the whole head down until the snout tip closes on the object.
      this.usingMouth = true;
      this.sides = [];
      this.objectSize = sizeM;
      this.loadMass = mass;
      this.objectPos = v3(target.x, target.y, target.z);
      this.action = "reach";
      this.actionT = 0;
      this.gape = 0;
      return true;
    }
    const grp = this.g.limbGroups[group];
    const palm = Math.max(0.05 * this.legLen,
      grp.footLengthFrac * grp.lengthFrac * this.g.spine.torsoLengthM);
    const two = !thumbed || sizeM > palm * 1.5;
    const sides: Array<1 | -1> = two ? [-1, 1] : [target.x >= 0 ? 1 : -1];
    if (!this.admits(mass, false, sides, group)) return false;
    this.usingMouth = false;
    this.activeGroup = group;
    this.objectSize = sizeM;
    this.loadMass = mass;
    this.sides = sides;
    this.objectPos = v3(target.x, target.y, target.z);
    for (const s of this.sides) this.restHands[sideKey(s)] = this.restHandOf(s);
    this.action = "reach";
    this.actionT = 0;
    this.grip = GRIP_OPEN;
    return true;
  }

  /** Lower the carried object to `spot` (default: the ground under the
   *  spot it was picked from). False unless currently carrying. */
  putDown(spot?: Vec3): boolean {
    if (this.action !== "carry") return false;
    this.putPos = spot ? v3(spot.x, spot.y, spot.z) : v3(this.objectPos.x, this.objectPos.y, this.objectPos.z);
    this.action = "lower";
    this.actionT = 0;
    return true;
  }

  /** One hand's grip point on an object centered at `base`: the object's
   *  center for a single hand; for two hands, offset to opposite sides
   *  along the horizontal perpendicular of the body→object line, so the
   *  palms bracket it. */
  private gripPoint(base: Vec3, s: 1 | -1): Vec3 {
    if (this.sides.length < 2) return base;
    const len = Math.hypot(base.x, base.z);
    const px = len > 1e-6 ? base.z / len : 1; // rightward perpendicular
    const pz = len > 1e-6 ? -base.x / len : 0;
    const half = this.objectSize / 2;
    return v3(base.x + s * px * half, base.y, base.z + s * pz * half);
  }

  /** Where the object's CENTER rides while carried: chest height, ahead.
   *  Parameterised because the refusal gate asks where a load WOULD ride
   *  before `sides`/`activeGroup` have been committed to. */
  private carryCenter(sides: readonly (1 | -1)[] = this.sides, group = this.activeGroup): Vec3 {
    let rx = 0, ry = 0, rz = 0;
    for (const s of sides) {
      const r = this.restHandOf(s);
      rx += r.x / sides.length; ry += r.y / sides.length; rz += r.z / sides.length;
    }
    const grp = this.g.limbGroups[group];
    const armLen = grp ? grp.lengthFrac * this.g.spine.torsoLengthM : this.legLen * 0.5;
    const inward = sides.length === 1 ? -sides[0] * 0.15 * armLen : 0;
    return v3(rx + inward, ry + 0.4 * armLen, rz + 0.32 * armLen + this.objectSize * 0.3);
  }

  /** The point the mouth is currently working toward — the object while
   *  reaching/biting, the put-down spot while lowering, else nothing. This is
   *  the ARRIVAL test's target (how far the snout still has to go), not the
   *  neck's steering target; `snoutTarget` below is that. */
  private mouthTarget(): Vec3 | null {
    if (this.action === "reach" || this.action === "grasp") return this.objectPos;
    if (this.action === "lower" || this.action === "release") return this.putPos;
    return null;
  }

  /**
   * Where the neck should put the snout THIS frame — the mouth's counterpart
   * to `targetOf`, and lerped through the same phases for the same reason: a
   * carried object rides in the jaws, so the mouth's whole timeline is
   *   rest → object → (bite) → back to rest carrying it → down to the spot →
   *   (let go) → back to rest.
   * Every leg of it lands exactly on `restSnout` at the end, so dropping the
   * target on "carry" and "none" (which returns the neck to its own rest
   * curve, and the build to its byte-identical no-target path) is continuous
   * rather than a snap.
   *
   * Null before the first `observe` has seen a snout: with no idea where the
   * mouth rests there is nothing to lerp out of, and the neck simply holds
   * its blueprint curve.
   */
  private snoutTarget(): Vec3 | null {
    const rest = this.restSnout;
    if (!rest) return null;
    switch (this.action) {
      case "reach": return lerpV(rest, this.objectPos, ease(this.actionT));
      case "grasp": return this.objectPos;
      case "lift": return lerpV(this.objectPos, rest, ease(this.actionT));
      case "lower": return lerpV(rest, this.putPos, ease(this.actionT));
      case "release": return this.putPos;
      case "return": return lerpV(this.putPos, rest, ease(this.actionT));
      default: return null;
    }
  }

  /** Feed back the skeleton actually built from the last frame. Keeps the
   *  standing hand positions fresh and measures reach progress. */
  observe(skel: CreatureSkeleton): void {
    // The ledger and the carry seats come off EVERY observation, before any of
    // the early returns below: they are what the refusal gate measures against
    // and where `AnimFrame.loads` hangs its masses, and both have to describe
    // the body that was actually built rather than the blueprint's idea of it.
    this.lastSupport = skel.support;
    this.readSeats(skel);
    if (this.mouthChain && (this.usingMouth || this.action === "none")) {
      const tip = limbTip(skel, this.mouthChain);
      if (tip) this.snoutTip = tip;
      // The STANDING snout position, refreshed whenever nothing is running —
      // the mouth's `restHands`. It is where a mouth reach lerps out of and
      // back to, and it must be observed rather than computed: the snout tip
      // is the far end of a neck curve and a head assembly, not a formula the
      // animator has any business restating.
      if (tip && this.action === "none") this.restSnout = tip;
      const target = this.mouthTarget();
      if (tip && target) this.lastHandDist = dist3(tip, target);
      if (this.usingMouth) return;
    }
    if (this.activeGroup < 0) return;
    for (const s of [-1, 1] as const) {
      const tip = limbTip(skel, limbChainName(this.g, this.activeGroup, 0, s));
      if (tip) this.handTips[sideKey(s)] = tip;
    }
    // Reach progress = the WORST hand — a two-handed grab isn't done until
    // both palms arrive.
    let worst = 0;
    for (const s of this.sides) {
      const tip = this.handTips[sideKey(s)];
      const target = this.lastTargets[sideKey(s)];
      if (tip && target) worst = Math.max(worst, dist3(tip, target));
    }
    if (this.sides.length > 0) this.lastHandDist = worst;
  }

  /** One pass over the built bones for the three places a load can ride: the
   *  neck root (a mouth carry bends the neck about it), the acting limbs'
   *  roots (a hand carry bends the arm about its shoulder) and the top of the
   *  girth peak (where a pack sits). Cheap — a few comparisons per bone — and
   *  it holds no reference to the skeleton afterwards. */
  private readSeats(skel: CreatureSkeleton): void {
    const wantL = this.activeGroup >= 0 ? limbChainName(this.g, this.activeGroup, 0, -1) : null;
    const wantR = this.activeGroup >= 0 ? limbChainName(this.g, this.activeGroup, 0, 1) : null;
    let neck: typeof skel.bones[number] | null = null;
    let head: typeof skel.bones[number] | null = null;
    let fat: typeof skel.bones[number] | null = null;
    let armL: typeof skel.bones[number] | null = null;
    let armR: typeof skel.bones[number] | null = null;
    for (const b of skel.bones) {
      if (!neck && b.kind === "neck") neck = b;
      else if (!head && b.kind === "head") head = b;
      if (b.kind === "torso" &&
        (!fat || b.radiusHead + b.radiusTail > fat.radiusHead + fat.radiusTail)) fat = b;
      // Bones are pushed root-first, so the FIRST bone of a chain is its root.
      if (wantL && !armL && b.chain === wantL) armL = b;
      if (wantR && !armR && b.chain === wantR) armR = b;
    }
    const front = neck ?? head;
    this.seatNeck = front ? { root: front.head, radius: front.radiusHead } : null;
    this.seatHand = {
      L: armL ? { root: armL.head, radius: armL.radiusHead } : null,
      R: armR ? { root: armR.head, radius: armR.radiusHead } : null,
    };
    // ON the back, not inside it: the load sits on the skin over the girth
    // peak, which is the bone's own radius above its centreline.
    this.seatBack = fat
      ? v3((fat.head.x + fat.tail.x) / 2,
        (fat.head.y + fat.tail.y) / 2 + (fat.radiusHead + fat.radiusTail) / 2,
        (fat.head.z + fat.tail.z) / 2)
      : null;
  }

  /** Where the carried object IS right now — the same point the renderer
   *  draws it at: the observed grasper tip(s), falling back to the target this
   *  frame is steering them toward (the first frame of a lift, before anything
   *  has been observed holding it). Null when nothing is being carried. */
  private carryPointNow(): Vec3 | null {
    if (this.usingMouth) return this.snoutTip ?? this.snoutTarget() ?? this.restSnout;
    if (this.sides.length === 0) return null;
    let x = 0, y = 0, z = 0, n = 0;
    for (const s of this.sides) {
      const k = sideKey(s);
      const p = this.handTips[k] ?? this.lastTargets[k];
      if (!p) continue;
      x += p.x; y += p.y; z += p.z; n++;
    }
    return n > 0 ? v3(x / n, y / n, z / n) : null;
  }

  /** Where a load WOULD ride once carried — the refusal gate's lever, asked
   *  before the action starts and so before anything has been observed
   *  holding anything. */
  private carryPointFor(mouth: boolean, sides: readonly (1 | -1)[], group: number): Vec3 | null {
    if (mouth) return this.restSnout;
    if (sides.length === 0) return null;
    return this.carryCenter(sides, group);
  }

  /**
   * 🚨 REFUSAL — can this body actually take that load? The honest coarse
   * gate: the stance legs against the new total weight, and the ONE part that
   * would hold the thing (the neck for a mouth carry, the arm for a hand
   * carry) against the load alone, in bending. Whichever binds, binds; the
   * threshold is physio's own `MAX_BEARABLE_STRESS`, which is the same 1.0
   * that means "at capacity" everywhere else in the ledger.
   *
   * ⚖️ IT FAILS OPEN WITH NO LEDGER. The gate measures against the last
   * skeleton `observe` saw; a caller that never observes (there are hosts that
   * only want the poses) gets exactly the behaviour it had before refusal
   * existed. Any host running the documented loop — update, build, observe —
   * has a ledger from its first frame.
   */
  private admits(mass: number, mouth: boolean, sides: readonly (1 | -1)[], group: number): boolean {
    this.refusal = null;
    const sup = this.lastSupport;
    if (!sup || !(mass > 0)) return true;
    const gravity = sup.body.gravity;
    // Legs the body is standing ON. None (a belly rest, a swimmer) means the
    // legs are not what holds this body up, so the stance side cannot bind.
    const stanceStrengths: number[] = [];
    for (const leg of sup.legs) if (leg.grounded) stanceStrengths.push(leg.strength);
    // The worst-off carrier: two hands split the load, so each takes half —
    // but the arms are not always symmetric, and the gate wants the one that
    // gives out first.
    let carrier: { load: number; lever: number; radius: number; baseMoment?: number } | undefined;
    const at = this.carryPointFor(mouth, sides, group);
    if (at) {
      const seats: CarrySeat[] = mouth
        ? (this.seatNeck ? [this.seatNeck] : [])
        : sides.map((s) => this.seatHand[sideKey(s)]).filter((x): x is CarrySeat => !!x);
      const share = seats.length > 0 ? (mass * gravity) / seats.length : 0;
      // 🚨 A NECK IS ALREADY HOLDING A HEAD OUT THERE. Its current moment is
      // exactly `chainStress.neck × capacity` — the ledger's own number, run
      // backwards — so the gate weighs the same sum the ledger will after the
      // lift, and cannot admit a load that turns the neck red. A LIMB gets no
      // base: what an arm already carries is its share of the body's weight,
      // which is compression, not a moment about the shoulder.
      const baseMoment = mouth
        ? (sup.chainStress.neck ?? 0) * bendCapacity(this.seatNeck?.radius ?? 0)
        : 0;
      let worst = -1;
      for (const seat of seats) {
        const lever = Math.hypot(at.x - seat.root.x, at.z - seat.root.z);
        const sigma = cantileverStress(share * lever + baseMoment, 1, seat.radius);
        if (sigma > worst) {
          worst = sigma;
          carrier = { load: share, lever, radius: seat.radius, baseMoment };
        }
      }
    }
    const verdict = canBear({
      // `body.weight` already carries whatever this body is holding (a pack,
      // an object in the other hand) — the new load goes on top of it.
      totalWeight: sup.body.weight + mass * gravity,
      stanceStrengths,
      carrier,
    });
    if (verdict.ok) return true;
    this.refusal = verdict;
    return false;
  }

  /** Why the last `pickUp` returned false — the two stresses, the threshold
   *  and which one bound. Null when the last one was accepted (or when the
   *  refusal was structural: no grasper, or an action already running). */
  lastRefusal(): BearVerdict | null {
    return this.refusal;
  }

  /** Mass currently carried in the hands/mouth (proxy units), 0 when empty. */
  carriedMass(): number {
    return this.holding ? this.loadMass : 0;
  }

  /**
   * Put a persistent load on the animal's BACK — a pack, a rider, a pair of
   * baskets — riding at the spine's girth peak and emitted every frame until
   * it is cleared with `setBackLoad(0)`. Deliberately dumb: no straps, no
   * balance, no timeline, and NOT gated by refusal (a pack is something
   * someone else puts on the animal). What the load does is then the ledger's
   * business — the stance sags, every standing leg's force rises and
   * `chainStress.spine` says how hard the body is working.
   *
   * Nothing is emitted until a skeleton has been observed: with no body built
   * there is no girth peak to hang it from.
   */
  setBackLoad(massProxy: number): void {
    this.backLoad = Number.isFinite(massProxy) ? Math.max(0, massProxy) : 0;
  }

  /** The pack's proxy mass (0 = none). */
  get backLoadMass(): number {
    return this.backLoad;
  }

  update(dtS: number): AnimFrame {
    const dt = Math.max(0, Math.min(0.1, dtS));
    this.time += dt;

    // ── Locomotion: smooth the speed dial, advance the cycle ────────────
    const ds = this.speedTarget - this.speed;
    this.speed += Math.sign(ds) * Math.min(Math.abs(ds), dt * 0.8);
    const moving = this.speed > 0.02;
    let gait: GaitParams | undefined;
    let speedMps = 0;
    if (moving) {
      const loco = locomotionGait(this.speed, this.legLen);
      this.phase = (this.phase + dt * loco.cadenceHz) % 1;
      gait = {
        phase: this.phase,
        strideFrac: loco.strideFrac,
        stepHeight: loco.stepHeight,
        dutyFactor: loco.dutyFactor,
        pattern: this.pattern,
      };
      speedMps = loco.speedMps;
    }

    // ── Action timeline (bulky objects lift and lower more slowly) ──────
    const durs: Partial<Record<ActionKind, number>> = DUR;
    const dur = durs[this.action];
    if (dur !== undefined) {
      // HEAVY IS SLOW, and it is slow on top of BULKY: the size factor is the
      // awkwardness of the shape, the heft factor is the mass, and a big heavy
      // thing is both. Heft is a ratio of the load to the body that is lifting
      // it (the ledger's own body mass), so the same crate is nothing to a
      // horse and a struggle for a cat — and it is 1 with no ledger observed,
      // which is the pre-load timeline exactly.
      const bulk = this.action === "lift" || this.action === "lower"
        ? (1 + 0.6 * Math.min(1, this.objectSize / this.legLen)) * this.liftHeft()
        : 1;
      this.actionT += dt / (dur * bulk);
      if (this.actionT >= 1) {
        this.actionT = 0;
        switch (this.action) {
          case "reach": this.action = "grasp"; break;
          case "grasp": this.action = "lift"; this.holding = true; break;
          case "lift": this.action = "carry"; break;
          case "lower": this.action = "release"; this.holding = false; break;
          case "release": this.action = "return"; break;
          case "return":
            this.action = "none";
            this.lastTargets = { L: null, R: null };
            this.sides = [];
            this.usingMouth = false;
            // The object is on the ground and off the books. (It stops being a
            // LOAD at the release — `holding` — but the mass is kept through
            // the lower so the descent is as slow as the lift was.)
            this.loadMass = 0;
            break;
          case "point": this.action = "point-hold"; break;
          case "point-back":
            this.action = "none";
            this.lastTargets = { L: null, R: null };
            this.sides = [];
            break;
        }
      }
    }
    // The point HOLD is timed by the caller's duration, not a fixed DUR.
    if (this.action === "point-hold") {
      this.pointHoldT -= dt;
      if (this.pointHoldT <= 0) {
        this.action = "point-back";
        this.actionT = 0;
      }
    }

    // Reach feedback: while closing on a low target, crouch until the hands
    // actually get there (the strain engine folds the legs); ease back
    // upright the rest of the time. A mouth reach has no arm lerp doing the
    // early travel — the crouch IS the reach — so it engages sooner, and
    // "arrived" means the snout tip touches the object's SURFACE, not its
    // center.
    const reachingDown = this.action === "grasp" ||
      ((this.action === "reach" || this.action === "lower") &&
        this.actionT > (this.usingMouth ? 0.15 : 0.45));
    const nearEnough = 0.05 * this.legLen + (this.usingMouth ? this.objectSize * 0.55 : 0);
    if (reachingDown && this.lastHandDist > nearEnough) {
      this.crouch = Math.min(1, this.crouch + dt * 1.1);
    } else if (
      this.action === "none" || this.action === "carry" || this.action === "lift" ||
      this.action === "return" || this.action === "point" || this.action === "point-hold" ||
      this.action === "point-back"
    ) {
      // Pointing stays upright — ease any residual crouch back out.
      this.crouch = Math.max(0, this.crouch - dt * 1.4);
    }

    // ── Hand target(s) for the current action phase ─────────────────────
    const gripClosed = this.sides.length > 1 ? GRIP_WRAP : GRIP_CLOSED;
    const targetOf = (s: 1 | -1): Vec3 | null => {
      const rest = this.restHandOf(s);
      switch (this.action) {
        case "reach":
          return lerpV(rest, this.gripPoint(this.objectPos, s), ease(this.actionT));
        case "grasp":
          return this.gripPoint(this.objectPos, s);
        case "lift":
          return lerpV(this.gripPoint(this.objectPos, s), this.gripPoint(this.carryCenter(), s), ease(this.actionT));
        case "carry":
          return this.gripPoint(this.carryCenter(), s);
        case "lower":
          return lerpV(this.gripPoint(this.carryCenter(), s), this.gripPoint(this.putPos, s), ease(this.actionT));
        case "release":
          return this.gripPoint(this.putPos, s);
        case "return":
          return lerpV(this.gripPoint(this.putPos, s), rest, ease(this.actionT));
        case "point":
          return lerpV(rest, this.pointTarget(), ease(this.actionT));
        case "point-hold":
          return this.pointTarget();
        case "point-back":
          return lerpV(this.pointTarget(), rest, ease(this.actionT));
        default:
          return null;
      }
    };
    switch (this.action) {
      case "grasp":
        this.grip = GRIP_OPEN + (gripClosed - GRIP_OPEN) * ease(this.actionT);
        break;
      case "lift":
      case "carry":
      case "lower":
        this.grip = gripClosed;
        break;
      case "release":
        this.grip = gripClosed + (GRIP_OPEN - gripClosed) * ease(this.actionT);
        break;
      default:
        this.grip = GRIP_OPEN;
    }

    // Jaw gape for a mouth grasp: opens wide on approach, clamps down on
    // the object at the bite, cracks open again to let go.
    if (this.usingMouth) {
      switch (this.action) {
        case "reach":
          this.gape = GAPE_WIDE * ease((this.actionT - 0.35) / 0.5);
          break;
        case "grasp":
          this.gape = GAPE_WIDE + (GAPE_HOLD - GAPE_WIDE) * ease(this.actionT);
          break;
        case "lift":
        case "carry":
        case "lower":
          this.gape = GAPE_HOLD;
          break;
        case "release":
          this.gape = GAPE_HOLD + (GAPE_WIDE * 0.8 - GAPE_HOLD) * ease(this.actionT);
          break;
        case "return":
          this.gape = GAPE_WIDE * 0.8 * (1 - ease(this.actionT));
          break;
        default:
          this.gape = 0;
      }
    } else {
      this.gape = 0;
    }

    // ── Sustained activity: ease the blend, kind changes go through 0 ─────
    if (this.activity !== this.activityTarget) {
      this.activityAmt = Math.max(0, this.activityAmt - dt * ACTIVITY_BLEND_RATE);
      if (this.activityAmt <= 0) this.activity = this.activityTarget;
    } else if (this.activity !== "none") {
      this.activityAmt = Math.min(1, this.activityAmt + dt * ACTIVITY_BLEND_RATE);
    } else {
      this.activityAmt = 0;
    }
    // Walking dissolves the pose (a woken sleeper stands and goes): the
    // activity's strength fades out with the (eased) speed dial, so a body
    // that starts moving mid-activity stands up smoothly rather than popping.
    const act = ease(this.activityAmt) * (1 - clamp01(this.speed / 0.2));
    // Per-kind posture modulation (applied to the posture below). All of it is
    // solver INPUT — the strain engine folds legs for the crouches, the trunk
    // bows through bodyPitch — so it fits any body plan the builder makes.
    let actCrouch = 0; // extra crouch 0..1, same channel the reach feedback uses
    let actPitch = 0; // added trunk pitch (negative = bow forward)
    let actLift = 0; // direct bodyHeight offset
    let recline = 0;
    let eatCycle = 0; // 0..1..0 rhythm shared by the bow and the hand-to-mouth
    let playAmt = 0; // eased strength of the play pose — drives the limb stroke
    switch (this.activity) {
      case "sleep":
        recline = act;
        actCrouch = SLEEP_CROUCH * act;
        break;
      case "sit":
        actCrouch = SIT_CROUCH * act;
        actPitch = 0.06 * act; // settle slightly back — seated, not stooping
        break;
      case "eat":
        eatCycle = act * (0.5 - 0.5 * Math.cos((this.time / EAT_PERIOD_S) * Math.PI * 2));
        // A handed kind carries food up instead of diving down; a handless one
        // bows to the plate (the mouth does the work).
        actPitch = -(this.handGroup >= 0 ? 0.12 : 0.4) * eatCycle;
        break;
      case "play": {
        // DOWN over a spot on the ground in front, not a bounce in place: the
        // legs fold (the same crouch channel the sit and the reach use) and the
        // trunk bows forward over the toy. A handless kind must get its
        // shoulders lower and its head out of the way to work with its front
        // legs, so it bows harder — the same handed/handless split `eat` makes.
        actCrouch = PLAY_CROUCH * act;
        const noLimbs = this.playGroup < 0;
        actPitch = -PLAY_BOW * (this.handGroup >= 0 ? 1 : 1.6) * act;
        if (noLimbs) {
          // NO USABLE LIMB PAIR AT ALL — the body plays with its SNOUT, nosing
          // the thing about. There is nothing to drive but the head, so the
          // stroke rides the trunk pitch itself: a rhythmic dip over the spot on
          // top of the standing bow. Same rhythm as the limb stroke, so a
          // snout-player and a paw-player read as doing the same thing.
          actPitch -= PLAY_BOW * 0.5 * act *
            Math.max(0, Math.sin(this.time * Math.PI * 2 * PLAY_PADDLE_HZ));
        }
        playAmt = act;
        break;
      }
      default:
        break;
    }

    // ── Posture: base + idle sway + reach crouch/lean ────────────────────
    const idleSway = !moving && this.action === "none" ? 0.012 * Math.sin(this.time * 1.4) : 0;
    // The reach/carry crouch RELEASES as the body starts to move — the same speed
    // dial the sustained activity uses (`act`, above). A body that begins its next
    // walk while a pick / put gesture is still finishing then stands up smoothly
    // instead of gliding along locked in the crouch (the "using while moving" bug).
    const crouchE = ease(this.crouch) * (1 - clamp01(this.speed / 0.2));
    // Running leans the trunk into the motion; reaching bends it over the
    // target while the crouch folds the legs. The reach bend scales with
    // how erect the creature stands — an upright biped must fold its trunk
    // well forward to bring its shoulders near the ground (the hips can
    // only drop as far as the folded legs allow), while a horizontal
    // quadruped only dips its nose.
    //
    // 🚨 THE MOUTH REACH USED TO PITCH AT 1.05 HERE, AND THAT WAS THE
    // HANDSTAND. With no neck channel the trunk was the only thing that
    // could lower a snout, so the mouth path dived the whole body nose-down
    // past horizontal — which lifts the hind hips out of their legs' reach,
    // drops the hind legs out of support for free, and stands the animal on
    // its forelegs. Both halves of that are fixed elsewhere now: the neck
    // reaches (`pose.snoutTarget`) and the skeleton refuses to pitch a
    // support leg off the ground (the posture negotiation). So the mouth
    // takes the SAME modest trunk lean as a hand, and the bow it still needs
    // comes out of the negotiation as a differential front-leg fold.
    const reachLean = crouchE * (0.3 + 0.55 * Math.max(0, this.basePosture.bodyPitch));
    // Activity and reach share the crouch channel — the strain engine folds the
    // legs for whichever asks deeper.
    const foldE = Math.max(crouchE, ease(actCrouch));
    const posture: AnimPosture = {
      bodyPitch: this.basePosture.bodyPitch - reachLean - 0.14 * this.speed + actPitch,
      bodyHeight: Math.max(0.02, this.basePosture.bodyHeight * (1 - 0.95 * foldE) + idleSway + actLift),
    };

    // ── Pose overrides ────────────────────────────────────────────────────
    // `restPitch` rides on every frame: the skeleton decides which limbs are
    // LEGS (and so whose ground contact it must protect) at the posture the
    // body holds when it is NOT acting, never at the one this frame is
    // asking for. Without it the classification would drift as the action
    // deepened.
    const pose: PoseOverrides = { restPitch: this.basePosture.bodyPitch };
    if (moving) pose.armSwing = 0.12 + 0.45 * this.speed;
    let handChains: string[] | undefined;
    if (this.usingMouth) {
      if (this.action !== "none") {
        handChains = [this.mouthChain!];
        pose.gape = this.gape;
      }
      // THE NECK DOES THE REACHING. The mouth path has no arm to travel with,
      // so before this the crouch and a 1.05-rad trunk dive were the whole
      // gesture. Now the snout goes to the object down the same channel a
      // grazing animal uses — the neck curls and the head rides it down —
      // and the crouch is left doing what it does for a hand: bringing the
      // shoulders down the last stretch when the neck alone cannot span it.
      const snout = this.snoutTarget();
      if (snout) pose.snoutTarget = snout;
    } else if (this.action !== "none" && this.activeGroup >= 0 && this.sides.length > 0) {
      handChains = [];
      pose.limbTargets = [];
      for (const s of this.sides) {
        const target = targetOf(s);
        if (!target) continue;
        this.lastTargets[sideKey(s)] = target;
        handChains.push(limbChainName(this.g, this.activeGroup, 0, s));
        pose.limbTargets.push({
          group: this.activeGroup,
          index: 0,
          side: s,
          target,
          grip: this.grip,
        });
      }
    }
    // EAT, for a kind with a graspable hand and no action running: a rhythmic
    // hand-to-mouth — the hand rises from its rest position to just before the
    // mouth and back, once per period. Handless kinds already bow instead.
    if (eatCycle > 0.001 && this.action === "none" && this.handGroup >= 0) {
      const s: 1 | -1 = 1;
      const rest = this.restHandOf(s);
      const mouth = v3(0.05 * this.legLen, this.legLen * 1.02, 0.24 * this.g.spine.torsoLengthM);
      pose.limbTargets = [
        { group: this.handGroup, index: 0, side: s, target: lerpV(rest, mouth, ease(eatCycle)), grip: 0.6 },
      ];
    }
    // EAT, for a HANDLESS kind: the same rhythm the handed one carries a hand
    // to its mouth on, spent the other way round — the mouth goes to the food.
    // The trunk still bows (actPitch, above) but the bow is no longer the
    // whole gesture: the neck dips the snout to the ground under it and lifts
    // again, which is what a grazing or bowl-fed animal actually does, and it
    // asks nothing of the trunk that the posture negotiation would have to
    // take back off the hind legs.
    if (eatCycle > 0.001 && this.action === "none" && this.handGroup < 0 && this.restSnout) {
      const plate = v3(this.restSnout.x, 0.06 * this.legLen, this.restSnout.z);
      pose.snoutTarget = lerpV(this.restSnout, plate, ease(eatCycle));
    }
    // PLAY, with no action running: the front pair WORKS a spot on the ground
    // just ahead of the feet — each side stroking half a cycle out of phase with
    // the other, so the thing gets batted between them rather than pawed in
    // unison. Local frame is restHandOf's (+Z forward, Y up from the feet), and
    // every target is lerped OUT of the rest pose by the activity's own eased
    // strength, so starting and stopping play blends like the other activities
    // instead of snapping the limbs to the ground.
    if (playAmt > 0.001 && this.action === "none" && this.playGroup >= 0) {
      const fwd = 0.3 * this.g.spine.torsoLengthM + 0.3 * this.legLen;
      pose.limbTargets = [];
      for (const s of [-1, 1] as const) {
        const stroke = Math.sin(this.time * Math.PI * 2 * PLAY_PADDLE_HZ + (s > 0 ? 0 : Math.PI));
        const spot = v3(
          s * 0.18 * this.legLen + 0.05 * this.legLen * stroke,
          // Just off the ground, lifting on the up-stroke — a paw pushing at a
          // thing, never sunk through the floor.
          this.legLen * (0.08 + 0.1 * Math.max(0, stroke)),
          fwd + 0.1 * this.legLen * stroke,
        );
        pose.limbTargets.push({
          group: this.playGroup,
          index: 0,
          side: s,
          target: lerpV(this.restHandOf(s), spot, playAmt),
          grip: PLAY_GRIP,
        });
      }
    }

    // ── What the body is carrying, at the point it is carrying it ────────
    // The held object rides wherever the graspers are THIS frame — the hand
    // tip(s), between two of them, or the snout tip — and a pack rides the
    // girth peak. Both are points the renderer is already drawing at, which is
    // the whole trick: nothing here is a second opinion about where the thing
    // is. Undefined when there is nothing, so the caller's build is the
    // byte-identical unloaded one.
    let loads: CarriedLoad[] | undefined;
    if (this.holding && this.loadMass > 0) {
      const at = this.carryPointNow();
      if (at) (loads ??= []).push({ mass: this.loadMass, at });
    }
    if (this.backLoad > 0 && this.seatBack) {
      (loads ??= []).push({ mass: this.backLoad, at: this.seatBack });
    }

    return {
      gait,
      posture,
      pose,
      holding: this.holding,
      handChains,
      handChain: handChains?.[0],
      speedMps,
      action: this.action,
      recline,
      loads,
    };
  }

  /** How much longer this lift/lower takes for the mass in hand: 1 empty, up
   *  to 1 + LOAD_HEFT for a load as heavy as the body. 1 with no observed
   *  ledger — there is no body mass to compare against. */
  private liftHeft(): number {
    const body = this.lastSupport?.body.mass ?? 0;
    if (!(this.loadMass > 0) || !(body > 0)) return 1;
    return 1 + LOAD_HEFT * clamp01(this.loadMass / body);
  }
}
