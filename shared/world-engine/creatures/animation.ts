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
//   const skel = buildSkeleton(blueprint, frame.gait, frame.pose);
//   animator.observe(skel);                       // hand-position feedback
// The observe() feedback is what makes reaching robust: if the hands aren't
// closing on the object, the controller keeps crouching — no closed-form
// reachability math to drift out of sync with the strain solver.
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
  limbChainName,
  limbTip,
  type CreatureSkeleton,
  type PoseOverrides,
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
 *   • "play" — a light bounce + sway.
 * Unlike an action it has no timeline: the caller holds it set and the animator
 * eases it in/out (`setActivity`).
 */
export type BodyActivity = "none" | "sleep" | "eat" | "sit" | "play";

// Activity tuning: blend rate + the rhythm of the periodic ones.
const ACTIVITY_BLEND_RATE = 2.6; // 1/s → ~0.4 s ease in/out
const EAT_PERIOD_S = 1.6; // one hand-to-mouth / bow per period
const PLAY_BOUNCE_HZ = 1.8;
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

  constructor(blueprint: Blueprint) {
    this.g = blueprint;
    const legs = blueprint.limbGroups.filter((l) => l.membrane < 0.55);
    this.legLen = Math.max(0.1, ...legs.map((l) => l.lengthFrac)) * blueprint.spine.torsoLengthM;
    this.handGroup = pickHandGroup(blueprint);
    this.armGroup = pickArmGroup(blueprint);
    this.mouthChain = blueprint.head.mouthOpen > 0
      ? (blueprint.head.beakLengthFrac > 0 ? "snout" : "jaw")
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
   *  `sizeM` across. Small objects take the near-side hand; an object wider
   *  than a palm — or any object, for a kind without opposable digits —
   *  takes BOTH hands, bracketing it from opposite sides. A kind with no
   *  usable limb pair at all falls back to its MOUTH (needs head.mouthOpen).
   *  False if there's no grasper or an action is already running. */
  pickUp(target: Vec3, sizeM = 0): boolean {
    if (this.action !== "none") return false;
    const thumbed = this.handGroup >= 0;
    const group = thumbed ? this.handGroup : this.armGroup;
    if (group < 0) {
      if (!this.mouthChain) return false;
      // Mouth grasp — no limb targets: the crouch/lean feedback carries
      // the whole head down until the snout tip closes on the object.
      this.usingMouth = true;
      this.sides = [];
      this.objectSize = sizeM;
      this.objectPos = v3(target.x, target.y, target.z);
      this.action = "reach";
      this.actionT = 0;
      this.gape = 0;
      return true;
    }
    this.usingMouth = false;
    const grp = this.g.limbGroups[group];
    const palm = Math.max(0.05 * this.legLen,
      grp.footLengthFrac * grp.lengthFrac * this.g.spine.torsoLengthM);
    const two = !thumbed || sizeM > palm * 1.5;
    this.activeGroup = group;
    this.objectSize = sizeM;
    this.sides = two ? [-1, 1] : [target.x >= 0 ? 1 : -1];
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

  /** Where the object's CENTER rides while carried: chest height, ahead. */
  private carryCenter(): Vec3 {
    let rx = 0, ry = 0, rz = 0;
    for (const s of this.sides) {
      const r = this.restHandOf(s);
      rx += r.x / this.sides.length; ry += r.y / this.sides.length; rz += r.z / this.sides.length;
    }
    const grp = this.g.limbGroups[this.activeGroup];
    const armLen = grp ? grp.lengthFrac * this.g.spine.torsoLengthM : this.legLen * 0.5;
    const inward = this.sides.length === 1 ? -this.sides[0] * 0.15 * armLen : 0;
    return v3(rx + inward, ry + 0.4 * armLen, rz + 0.32 * armLen + this.objectSize * 0.3);
  }

  /** The point the mouth is currently working toward — the object while
   *  reaching/biting, the put-down spot while lowering, else nothing. */
  private mouthTarget(): Vec3 | null {
    if (this.action === "reach" || this.action === "grasp") return this.objectPos;
    if (this.action === "lower" || this.action === "release") return this.putPos;
    return null;
  }

  /** Feed back the skeleton actually built from the last frame. Keeps the
   *  standing hand positions fresh and measures reach progress. */
  observe(skel: CreatureSkeleton): void {
    if (this.usingMouth) {
      const tip = limbTip(skel, this.mouthChain!);
      const target = this.mouthTarget();
      if (tip && target) this.lastHandDist = dist3(tip, target);
      return;
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
      const bulk = this.action === "lift" || this.action === "lower"
        ? 1 + 0.6 * Math.min(1, this.objectSize / this.legLen)
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
    let actLift = 0; // direct bodyHeight offset (the play bounce)
    let recline = 0;
    let eatCycle = 0; // 0..1..0 rhythm shared by the bow and the hand-to-mouth
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
        const bounce = Math.abs(Math.sin(this.time * Math.PI * PLAY_BOUNCE_HZ));
        actLift = 0.05 * act * bounce;
        actPitch = 0.05 * act * Math.sin(this.time * Math.PI * 2 * 0.9); // sway
        break;
      }
      default:
        break;
    }

    // ── Posture: base + idle sway + reach crouch/lean ────────────────────
    const idleSway = !moving && this.action === "none" ? 0.012 * Math.sin(this.time * 1.4) : 0;
    const crouchE = ease(this.crouch);
    // Running leans the trunk into the motion; reaching bends it over the
    // target while the crouch folds the legs. The reach bend scales with
    // how erect the creature stands — an upright biped must fold its trunk
    // well forward to bring its shoulders near the ground (the hips can
    // only drop as far as the folded legs allow), while a horizontal
    // quadruped only dips its nose. A MOUTH reach pitches much harder:
    // hands hang below the shoulders and cover the last stretch, but a
    // beak sits on top of a lifted neck — the trunk must tip nose-down
    // past horizontal, a bird pecking over its feet. The feedback loop
    // still stops the dive the moment the beak arrives.
    const leanBase = this.usingMouth ? 1.05 : 0.3;
    const reachLean = crouchE * (leanBase + 0.55 * Math.max(0, this.basePosture.bodyPitch));
    // Activity and reach share the crouch channel — the strain engine folds the
    // legs for whichever asks deeper.
    const foldE = Math.max(crouchE, ease(actCrouch));
    const posture: AnimPosture = {
      bodyPitch: this.basePosture.bodyPitch - reachLean - 0.14 * this.speed + actPitch,
      bodyHeight: Math.max(0.02, this.basePosture.bodyHeight * (1 - 0.95 * foldE) + idleSway + actLift),
    };

    // ── Pose overrides ────────────────────────────────────────────────────
    const pose: PoseOverrides = {};
    if (moving) pose.armSwing = 0.12 + 0.45 * this.speed;
    let handChains: string[] | undefined;
    if (this.usingMouth) {
      if (this.action !== "none") {
        handChains = [this.mouthChain!];
        pose.gape = this.gape;
      }
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
    };
  }
}
