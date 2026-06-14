// Creature skeleton — genome → bone chains in a grounded rest pose.
//
// PURE MATH. No three.js — plain {x,y,z} vectors so this stays
// node-testable and server-importable. The mesh builder (mesh.ts) turns
// these bones into THREE.Bone + a lofted SkinnedMesh; the animation
// layer (phase 2) poses them.
//
// Creature-local coordinates: +Y up, +Z forward, origin under the torso
// center at GROUND level — the rest pose stands feet (or belly) on the
// y=0 plane by construction.
//
// Bones store explicit head/tail POINTS rather than parent-relative
// transforms: integration math stays trivial here, and mesh.ts derives
// whatever transform representation three.js needs.

import type { FlexChainGenome, Genome, LimbPlacement } from "./genome";
import { bodyBob, footCycle, legPhaseOffset, type GaitParams } from "./gait";
import { balanceShift, type Pt } from "./balance";

// ── Vec3 (minimal, allocation-per-call is fine at build time) ───────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
};
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

// ── Limb model constants — a 3-section chain (femur / tibia / foot) posed
// by 3 DOF: protraction (fore/aft), levation (up/down), flexion (knee).
// The femur+tibia loft as LEG_SEGS bones (for a smooth skin); the foot is
// its own bone. Extra arthropod "joints" would be a render subdivision, not
// more DOF.
const LEG_SEGS = 4; // femur 2 + tibia 2 loft bones
const PROTRACT_MAX = 1.3; // rad — full fore/aft swing
const FLEX_MAX = 2.4; // rad — full knee fold
const LOAD_GAIN = 26; // how hard the borne weight straightens the knee vs. the joints' springs
/** Femur elevation angle from straight-down for a rest levation in [-1,1]:
 *  -1 → ~down (mammal tuck), 0 → out to the side, +1 → up (wing / raised). */
const levationElevation = (restLevation: number): number =>
  0.12 + ((restLevation + 1) / 2) * 1.83;

/** Rodrigues rotation of `v` around unit `axis` by `angle`. */
function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  const cross = v3(
    axis.y * v.z - axis.z * v.y,
    axis.z * v.x - axis.x * v.z,
    axis.x * v.y - axis.y * v.x,
  );
  return v3(
    v.x * c + cross.x * s + axis.x * dot * (1 - c),
    v.y * c + cross.y * s + axis.y * dot * (1 - c),
    v.z * c + cross.z * s + axis.z * dot * (1 - c),
  );
}

const X_AXIS = v3(1, 0, 0);
const Y_AXIS = v3(0, 1, 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ── Output types ─────────────────────────────────────────────────────────

export type BoneKind = "torso" | "neck" | "tail" | "head" | "limb" | "chain";

export interface CreatureBone {
  /** Stable id, e.g. "torso2", "limb0L1". */
  id: string;
  /** Index of the parent bone in `bones`, or -1 for the root. */
  parent: number;
  kind: BoneKind;
  /** Chain this bone belongs to ("spine", "tail", "neck", "head",
   *  "limb0L", "limb1R", ...) — consecutive bones of a chain are
   *  contiguous in the array, head-to-tail. */
  chain: string;
  /** Rest-pose start/end points, creature-local. A bone's `head` always
   *  equals the previous chain bone's `tail`. */
  head: Vec3;
  tail: Vec3;
  /** Loft radii at the two ends, meters. */
  radiusHead: number;
  radiusTail: number;
  /** Cross-section ellipticity from `membrane`: 0 = round, 1 = fully
   *  flattened airfoil. mesh.ts widens/flattens rings by this. */
  flatten: number;
  /** Body cross-section width:height ratio at this bone (spine.crossSection
   *  eased back to 1 off the trunk). 1 = round, > 1 = wide/flat, < 1 =
   *  tall/narrow. Independent of `flatten` (membrane). mesh.ts scales the
   *  ring's width/height by this. */
  aspect: number;
}

export type DetailKind = "beak" | "eye";

export interface RigidDetail {
  kind: DetailKind;
  /** Bone the detail is welded to (single skin weight). */
  bone: number;
  /** Creature-local rest position (cone base center / eyeball center). */
  position: Vec3;
  /** Unit direction the detail points (beak axis; eye outward normal). */
  direction: Vec3;
  /** Primary size: cone base radius / eyeball radius. */
  radius: number;
  /** Secondary size: cone length (unused for eyes). */
  lengthM: number;
  /** 0 fleshy (base color, blunt) .. 1 hard (accent color, sharp).
   *  Only meaningful for beaks. */
  hardness: number;
}

/** One cross-rib of a midline membrane: a base point on the body surface
 *  and a tip raised out along the membrane's outward direction, plus the
 *  in-plane normal (the thin sheet's facing) and the bone it's welded to.
 *  mesh.ts stitches consecutive ribs into a thin two-sided web. */
export interface MembraneRib {
  base: Vec3;
  tip: Vec3;
  normal: Vec3;
  bone: number;
}

export interface MembranePanel {
  ribs: MembraneRib[];
  /** Half-thickness of the web (meters). */
  thickness: number;
}

export interface CreatureSkeleton {
  bones: CreatureBone[];
  details: RigidDetail[];
  /** Midline webs (dorsal/anal/caudal fins, sails). */
  membranes: MembranePanel[];
  /** Max torso radius actually used, meters — handy reference for
   *  consumers (eye/beak sizes, camera framing). */
  maxTorsoRadius: number;
  /** Rough creature-local AABB of the bone points (not the skin). */
  bounds: { min: Vec3; max: Vec3 };
}

// ── Torso radius profile ─────────────────────────────────────────────────
// Station t: 0 = chest (front) .. 1 = hip (rear), matching genome
// semantics for girthPeak and limb stations. Cosine-eased falloff from
// the peak toward each end, end radius set by the taper amount — smooth
// at the peak, blunt-to-needle at the ends, no discrete shapes.

export function torsoRadiusAt(g: Genome, t: number): number {
  const maxR = g.spine.girth * g.spine.torsoLengthM;
  const peak = g.spine.girthPeak;
  let tn: number;
  let taper: number;
  if (t < peak) {
    tn = peak > 1e-6 ? (peak - t) / peak : 0;
    taper = g.spine.frontTaper;
  } else {
    tn = peak < 1 - 1e-6 ? (t - peak) / (1 - peak) : 0;
    taper = g.spine.rearTaper;
  }
  const ease = (1 - Math.cos(Math.min(1, tn) * Math.PI)) / 2;
  const endR = maxR * (1 - 0.95 * taper);
  return (maxR - (maxR - endR) * ease) * profileFactorAt(g, t);
}

// Trunk profile (tagmata): piecewise-linear radius multiplier from the
// genome's control points. Flat 1 outside the points' span, so a body
// with no profile is unchanged. Points are sorted on clamp.
export function profileFactorAt(g: Genome, t: number): number {
  const raw = g.spine.profile;
  if (!raw || raw.length === 0) return 1;
  // Tolerate unsorted input (the lab edits points in place) — clamp keeps
  // the canonical interchange form sorted, but don't depend on it here.
  const p = raw.length > 1 ? [...raw].sort((a, b) => a.at - b.at) : raw;
  if (t <= p[0].at) return p[0].scale;
  const last = p[p.length - 1];
  if (t >= last.at) return last.scale;
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i].at) {
      const a = p[i - 1];
      const b = p[i];
      const span = b.at - a.at;
      const u = span > 1e-9 ? (t - a.at) / span : 0;
      return a.scale + (b.scale - a.scale) * u;
    }
  }
  return 1;
}

// ── Resolve limbs ──────────────────────────────────────────────────────
// Unfold the genome's compact `limbGroups` into a flat list of concrete
// copies the bone builder consumes. A bilateral group becomes `count`
// rows spread along its station span; a radial group becomes `count`
// spokes at one station. Size gravitation scales each copy. Every copy
// keeps its placement and group/index so the gait layer (phase 2) can
// coordinate a group's copies together. Every limb is a leg — role
// (leg / wing / arm) emerges in the build from shape + posture.

/** One concrete limb copy (a bilateral row or a radial spoke). */
export interface ResolvedLimb {
  placement: LimbPlacement;
  station: number;
  /** Source group index — copies of one group share a gait later. */
  group: number;
  /** Copy index within the group, 0 = first. */
  index: number;
  /** Radial spoke angle (radians); 0 for bilateral. */
  azimuth: number;
  lengthFrac: number;
  radiusFrac: number;
  taper: number;
  membrane: number;
  attachHeight: number;
  restProtraction: number;
  restLevation: number;
  restFlexion: number;
  flexRange: number;
  legTwist: number;
  legBalance: number;
  footLengthFrac: number;
  stance: number;
  ankleRange: number;
  toeCount: number;
  toeLengthFrac: number;
  toeSpread: number;
  toeContrast: number;
  opposition: number;
  toeCurl: number;
}

export function resolveLimbs(g: Genome): { limbs: ResolvedLimb[] } {
  const limbs: ResolvedLimb[] = [];
  g.limbGroups.forEach((grp, gi) => {
    const count = Math.max(1, Math.round(grp.count));
    // Size gravitation: largest at copy fraction `sizePeak`, the farthest
    // copy shrinking by up to `sizeContrast`.
    const denom = Math.max(grp.sizePeak, 1 - grp.sizePeak, 1e-3);
    for (let r = 0; r < count; r++) {
      const t = count > 1 ? r / (count - 1) : 0;
      const mult = 1 - grp.sizeContrast * (Math.abs(t - grp.sizePeak) / denom);
      const station = grp.placement === "radial"
        ? grp.stationStart
        : grp.stationStart + (grp.stationEnd - grp.stationStart) * t;
      const azimuth = grp.placement === "radial" ? (r / count) * Math.PI * 2 : 0;
      limbs.push({
        placement: grp.placement,
        station,
        group: gi,
        index: r,
        azimuth,
        lengthFrac: grp.lengthFrac * mult,
        radiusFrac: grp.radiusFrac * mult,
        taper: grp.taper,
        membrane: grp.membrane,
        attachHeight: grp.attachHeight,
        restProtraction: grp.restProtraction,
        restLevation: grp.restLevation,
        restFlexion: grp.restFlexion,
        flexRange: grp.flexRange,
        legTwist: grp.legTwist,
        legBalance: grp.legBalance,
        footLengthFrac: grp.footLengthFrac,
        stance: grp.stance,
        ankleRange: grp.ankleRange,
        toeCount: grp.toeCount,
        toeLengthFrac: grp.toeLengthFrac,
        toeSpread: grp.toeSpread,
        toeContrast: grp.toeContrast,
        opposition: grp.opposition,
        toeCurl: grp.toeCurl,
      });
    }
  });
  return { limbs };
}

// ── Build ────────────────────────────────────────────────────────────────

export function buildSkeleton(g: Genome, gait?: GaitParams): CreatureSkeleton {
  const bones: CreatureBone[] = [];
  const details: RigidDetail[] = [];

  const L = g.spine.torsoLengthM;
  const maxR = g.spine.girth * L;
  const cs = g.spine.crossSection; // body cross-section width:height ratio
  // Area-preserving width/height factors for the elliptical cross-section
  // — used to seat hips on the actual body surface of a flattened body.
  const csW = Math.sqrt(cs);
  const csH = 1 / csW;
  const pitch = g.posture.bodyPitch;
  // Torso axis, rear→front, pitched around X (positive pitch = chest up).
  const axis = normalize(v3(0, Math.sin(pitch), Math.cos(pitch)));

  // 1) Torso chain, rear (station 1) → front (station 0), centered on
  //    the origin for now; the whole skeleton is lifted at the end.
  const rear = scale(axis, -L / 2);
  const torsoStart = bones.length;
  {
    const n = g.spine.torsoSegments;
    for (let i = 0; i < n; i++) {
      const t0 = 1 - i / n; // station at bone head
      const t1 = 1 - (i + 1) / n; // station at bone tail
      bones.push({
        id: `torso${i}`,
        parent: i === 0 ? -1 : bones.length - 1,
        kind: "torso",
        chain: "spine",
        head: add(rear, scale(axis, (i / n) * L)),
        tail: add(rear, scale(axis, ((i + 1) / n) * L)),
        radiusHead: torsoRadiusAt(g, t0),
        radiusTail: torsoRadiusAt(g, t1),
        flatten: 0,
        aspect: cs,
      });
    }
  }
  const torsoEnd = bones.length - 1; // front-most torso bone
  const frontPoint = bones[torsoEnd].tail;
  const frontRadius = bones[torsoEnd].radiusTail;
  const rearRadius = bones[torsoStart].radiusHead;

  // 2) Tail chain — integrates rearward from the rear point, bending
  //    down by droop spread across the segments. Tapers to near zero.
  if (g.tail.segments > 0) {
    const segLen = (g.tail.lengthFrac * L) / g.tail.segments;
    const baseR = g.tail.radiusFrac * maxR;
    let dir = scale(axis, -1);
    let point = rear;
    const step = g.tail.droop / g.tail.segments;
    for (let i = 0; i < g.tail.segments; i++) {
      // Positive droop bends the (rearward) tail downward.
      dir = normalize(rotate(dir, X_AXIS, step));
      const next = add(point, scale(dir, segLen));
      const f0 = 1 - i / g.tail.segments;
      const f1 = 1 - (i + 1) / g.tail.segments;
      bones.push({
        id: `tail${i}`,
        parent: i === 0 ? torsoStart : bones.length - 1,
        kind: "tail",
        chain: "tail",
        head: point,
        tail: next,
        radiusHead: Math.min(rearRadius, baseR) * f0 + 0.004 * (1 - f0),
        radiusTail: Math.min(rearRadius, baseR) * f1 + 0.004 * (1 - f1),
        flatten: 0,
        aspect: cs,
      });
      point = next;
    }
  }

  // 3) Neck chain — integrates forward+up from the front point.
  let headBase = frontPoint;
  let headDir = axis;
  let headParent = torsoEnd;
  if (g.neck.segments > 0) {
    const segLen = (g.neck.lengthFrac * L) / g.neck.segments;
    const neckR = g.neck.radiusFrac * maxR;
    let dir = axis;
    let point = frontPoint;
    const step = -g.neck.lift / g.neck.segments; // negative X-rot = up for +Z dir
    for (let i = 0; i < g.neck.segments; i++) {
      dir = normalize(rotate(dir, X_AXIS, step));
      const next = add(point, scale(dir, segLen));
      const f0 = i / g.neck.segments;
      const f1 = (i + 1) / g.neck.segments;
      // Blend from the torso's front radius into the neck radius so the
      // loft flows instead of stepping.
      const r0 = frontRadius * (1 - f0) + neckR * f0;
      const r1 = frontRadius * (1 - f1) + neckR * f1;
      bones.push({
        id: `neck${i}`,
        parent: i === 0 ? torsoEnd : bones.length - 1,
        kind: "neck",
        chain: "neck",
        head: point,
        tail: next,
        radiusHead: r0,
        radiusTail: r1,
        flatten: 0,
        // Ease the body cross-section back to round along the neck.
        aspect: cs + (1 - cs) * ((f0 + f1) / 2),
      });
      point = next;
    }
    headBase = point;
    headDir = dir;
    headParent = bones.length - 1;
  }

  // 4) Head bone — one bone, an ellipsoid bulb in the loft. Its axis
  //    levels halfway back toward horizontal so long lifted necks don't
  //    point the face at the sky.
  const headR = g.head.sizeFrac * maxR;
  {
    const level = normalize(v3(0, headDir.y * 0.5, Math.max(0.2, headDir.z)));
    const headLen = headR * 2;
    bones.push({
      id: "head",
      parent: headParent,
      kind: "head",
      chain: "head",
      head: headBase,
      tail: add(headBase, scale(level, headLen)),
      radiusHead: headR,
      radiusTail: headR,
      flatten: 0,
      aspect: 1,
    });
  }
  const headBoneIdx = bones.length - 1;
  const headBone = bones[headBoneIdx];
  const headAxis = normalize(v3(
    headBone.tail.x - headBone.head.x,
    headBone.tail.y - headBone.head.y,
    headBone.tail.z - headBone.head.z,
  ));
  const headCenter = scale(add(headBone.head, headBone.tail), 0.5);

  // 5) Limbs — ONE kind: a leg. Every limb is built as a leg that tries
  //    to reach the ground. Leg LENGTH is fixed; the posture engine
  //    (step 6) sets the body height (tallest leg leads), then each leg
  //    folds/sprawls to reach — or, if it can't reach at that height,
  //    lifts off and hangs (an arm). Role is emergent, never tagged.
  //
  // Leg statics — stance facts independent of the body height. Contact
  // centerlines sit ~0.85× their radius so the skin bears weight.
  interface LegStatics {
    legLen: number;
    maxDrop: number; // vertical hip→foot reach with the leg straight down
    minDrop: number; // vertical reach with the leg fully folded
    footLen: number;
    ankleH: number;
    maxAnkleH: number;
    contactY: number;
    ballR: number;
    tipR: number;
  }
  const legStatics = (limb: ResolvedLimb): LegStatics => {
    const legLen = limb.lengthFrac * L;
    const baseR = limb.radiusFrac * maxR;
    const tipR = baseR * limb.taper;
    const ballR = tipR * 1.05;
    const footLen = limb.footLengthFrac * legLen;
    const contactY = (footLen > 1e-6 ? ballR : tipR) * 0.85;
    const maxDrop = 0.96 * legLen;
    const minDrop = 0.32 * legLen;
    const ankleH = footLen > 1e-6 ? footLen * (0.1 + 0.7 * limb.stance) : 0;
    // Highest the ankle can ride (foot up on its tip) — this is the extra
    // standing height the toes can give, so the body's reach envelope
    // includes going unguligrade, which is what makes the stance emerge.
    const restTheta = Math.max(0, Math.min(1, limb.stance)) * 1.3;
    const maxTheta = Math.min(1.45, restTheta + Math.max(0, Math.min(1, limb.ankleRange)) * (1.45 - restTheta));
    const maxAnkleH = footLen > 1e-6 ? footLen * Math.sin(maxTheta) : 0;
    return { legLen, maxDrop, minDrop, footLen, ankleH, maxAnkleH, contactY, ballR, tipR };
  };

  interface PendingLeg {
    limb: ResolvedLimb;
    chain: string;
    outDir: Vec3; // horizontal outward unit (±X bilateral, spoke radial)
    sideSign: 1 | -1;
    hip: Vec3;
    statics: LegStatics;
    firstBone: number;
    footBone: number; // -1 when no sole
  }
  const pendingLegs: PendingLeg[] = [];

  const { limbs } = resolveLimbs(g);

  const torsoBoneAt = (station: number): number =>
    torsoStart +
    Math.min(
      g.spine.torsoSegments - 1,
      Math.floor((1 - station) * g.spine.torsoSegments),
    );

  const stationPoint = (station: number): Vec3 =>
    add(rear, scale(axis, (1 - station) * L));

  // Digits: builds toe/finger/pincer bones at the limb's contact point
  // (`ball`), fanned along `fwd`. There are no digit "types" — a hoof is
  // one thick digit, a hand is several with the end one opposed, a claw is
  // a curled pair. Differentiation works like leg rows: `toeContrast`
  // shrinks the outer digits, `opposition` swings the last digit back as a
  // thumb, `toeCurl` curls them under. Digit radius scales so the row ≈
  // the limb-tip girth, so feet line up with the limb. Single-bone chains
  // (`<chain>d<k>`) parented to `parentIdx`. grounded=false → a hanging
  // hand (digits curl down-forward).
  const addDigits = (o: {
    ball: Vec3;
    fwd: Vec3;
    parentIdx: number;
    chain: string;
    limb: ResolvedLimb;
    sideSign: 1 | -1;
    grounded: boolean;
  }): void => {
    const baseR = o.limb.radiusFrac * maxR;
    const tipR = baseR * o.limb.taper;
    const ballR = tipR * 1.05;
    const legLen = o.limb.lengthFrac * L;
    const footLen = o.limb.footLengthFrac * legLen;
    const span = footLen > 1e-6 ? footLen : legLen * 0.18;
    const n = Math.max(1, Math.round(o.limb.toeCount));
    const curl = o.limb.toeCurl;
    // Digit radius so the fanned row spans roughly the limb-tip girth
    // (1 digit ≈ a hoof matching the tip; many digits get thinner).
    const rBase = ballR * (1.15 / Math.sqrt(n));
    for (let k = 0; k < n; k++) {
      const t = n > 1 ? k / (n - 1) : 0.5; // 0..1 across the row
      const mult = 1 - o.limb.toeContrast * (Math.abs(t - 0.5) / 0.5);
      const isThumb = k === n - 1 && n >= 2 && o.limb.opposition > 0.05;
      let ang = n > 1 ? (t - 0.5) * o.limb.toeSpread : 0;
      if (isThumb) ang -= o.sideSign * o.limb.opposition * 1.6; // swing back/in
      const dir = rotate(o.fwd, Y_AXIS, ang);
      const dlen = o.limb.toeLengthFrac * span * mult * (isThumb ? 0.8 : 1);
      const dr = Math.max(rBase * mult, 1e-4);
      const tipDr = dr * 0.55;
      const name = `${o.chain}d${k}`;
      let tail: Vec3;
      if (o.grounded) {
        // On the ground; curl digs the tip down and shortens the run
        // (claws); an opposed thumb lifts off the ground.
        const run = dlen * (1 - 0.45 * curl);
        const y = isThumb ? o.ball.y + dlen * 0.4 : tipDr * 0.85 - curl * tipDr * 0.6;
        tail = v3(o.ball.x + dir.x * run, Math.max(y, tipDr * 0.2), o.ball.z + dir.z * run);
      } else {
        // Hanging hand: curl down-forward; the thumb opposes inward.
        const drop = dlen * (0.4 + 0.5 * curl);
        tail = v3(o.ball.x + dir.x * dlen, o.ball.y - drop, o.ball.z + dir.z * dlen);
      }
      bones.push({
        id: name,
        parent: o.parentIdx,
        kind: "limb",
        chain: name,
        head: o.ball,
        tail,
        radiusHead: dr,
        radiusTail: tipDr,
        flatten: 0,
        aspect: 1,
      });
    }
  };

  // Lay a limb's copies into concrete instances: bilateral → mirrored
  // L/R; radial → a single outward spoke at its azimuth.
  const placeInstances = (
    limb: ResolvedLimb,
  ): Array<{ outDir: Vec3; sideSign: 1 | -1; label: string }> => {
    if (limb.placement === "radial") {
      return [{ outDir: v3(Math.cos(limb.azimuth), 0, Math.sin(limb.azimuth)), sideSign: 1, label: "r" }];
    }
    return [
      { outDir: v3(-1, 0, 0), sideSign: -1, label: "L" },
      { outDir: v3(1, 0, 0), sideSign: 1, label: "R" },
    ];
  };

  // A running index gives every limb copy a unique chain prefix
  // `limb<idx>` — mesh.ts lofts anything starting "limb".
  let limbIdx = 0;
  for (const limb of limbs) {
    const baseR = limb.radiusFrac * maxR;
    const tipR = baseR * limb.taper;
    const segs = LEG_SEGS;
    const segLen = (limb.lengthFrac * L) / segs;
    const parentBone = torsoBoneAt(limb.station);
    const tR = torsoRadiusAt(g, limb.station);
    const center = stationPoint(limb.station);
    const statics = legStatics(limb);

    for (const inst of placeInstances(limb)) {
      const chain = `limb${limbIdx}${inst.label}`;
      // MOUNT: attachHeight sweeps the hip around the body cross-section
      // from the ventral midline (phi 0) to the dorsal midline (phi π).
      // This is only where the limb roots; how it AIMS is the 3 rest DOF,
      // applied in the pose pass (step 7).
      const phi = limb.attachHeight * Math.PI;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      const hip = add(center, v3(
        inst.outDir.x * sinP * tR * csW,
        -cosP * tR * csH,
        inst.outDir.z * sinP * tR * csW,
      ));
      // Placeholder straight-down chain; the pose pass (step 7) either
      // ground-solves it or holds it at its neutral 3-DOF pose.
      const firstBone = bones.length;
      let point = hip;
      for (let i = 0; i < segs; i++) {
        const next = add(point, v3(0, -segLen, 0));
        const f0 = i / segs;
        const f1 = (i + 1) / segs;
        bones.push({
          id: `${chain}${i}`,
          parent: i === 0 ? parentBone : bones.length - 1,
          kind: "limb",
          chain,
          head: point,
          tail: next,
          radiusHead: baseR * (1 - f0) + tipR * f0,
          radiusTail: baseR * (1 - f1) + tipR * f1,
          flatten: limb.membrane,
          aspect: 1,
        });
        point = next;
      }
      let footBone = -1;
      if (statics.footLen > 1e-6) {
        footBone = bones.length;
        bones.push({
          id: `${chain}foot`,
          parent: bones.length - 1,
          kind: "limb",
          chain, // same chain → the loft flows leg→foot around the ankle
          head: point,
          tail: add(point, v3(0, -statics.footLen, 0)),
          radiusHead: tipR,
          radiusTail: statics.ballR,
          flatten: 0.35,
          aspect: 1,
        });
      }
      pendingLegs.push({ limb, chain, outDir: inst.outDir, sideSign: inst.sideSign, hip, statics, firstBone, footBone });
    }
    limbIdx++;
  }

  // 6) Posture + strain engine. Leg length is FIXED; `bodyHeight` rides the
  //    body up the support legs' reach envelope (the tallest SUPPORT leg
  //    leads). Then a per-limb strain solve decides whether each limb can
  //    plant a foot cheaply (it bears weight) or must lift off and fold
  //    (a wing, a raised forelimb). Role is emergent from WHERE a limb
  //    attaches (its socket cone) and HOW strong it is (its girth).
  // A limb can bear weight only if it MOUNTS low enough to plant a foot
  // under the body. A dorsally-mounted limb (a wing) roots on top of the
  // body and can't reach the ground without wrapping around it, so it never
  // supports. Where the limb is CARRIED (restLevation) is independent — a
  // mantis mounts low (so this is true) yet holds its forearms raised.
  const canSupport = (leg: PendingLeg): boolean => leg.limb.attachHeight < 0.6;

  // The horizontal direction a foot plants toward: out to the side (the
  // sprawl), swung fore/aft by the limb's neutral protraction. The swing is
  // mirrored by side (`-sideSign`) so +protraction carries BOTH legs forward
  // — without the mirror the same rotation throws one leg fore and one aft.
  const footAim = (leg: PendingLeg): Vec3 =>
    normalize(rotate(leg.outDir, Y_AXIS, -leg.sideSign * leg.limb.restProtraction * PROTRACT_MAX));

  // Natural stance width as a fraction of leg length, from how the limb is
  // CARRIED: a depressed (mammal) limb stands narrow, straight under the
  // body; a levated (sprawled reptile/arthropod) limb plants WIDE for a
  // broad, stable base, which also arcs the knee up.
  const stanceFrac = (limb: ResolvedLimb): number => {
    const t = Math.max(0, Math.min(1, (limb.restLevation + 0.6) / 1.2));
    return 0.05 + 0.6 * t * t;
  };

  // Where a supporting leg plants its foot at a given body lift: out along
  // its sprawl aim by its natural stance width (capped so the foot can still
  // touch the ground), then onto the y = contact plane. Returns the ankle
  // point + its lever ratio λ, or null if the leg can't reach.
  interface FootSolve { foot: Vec3; lambda: number }
  const solveFoot = (leg: PendingLeg, atLift: number): FootSolve | null => {
    const s = leg.statics;
    const hy = leg.hip.y + atLift;
    // Reach is checked against the foot fully EXTENDED (up on its tip), so a
    // tall stance that the toes help reach isn't wrongly rejected.
    const c = s.contactY + s.maxAnkleH;
    const gap = hy - c;
    if (gap <= 1e-4 || gap > s.legLen * 0.999) return null; // can't reach
    const maxLat = Math.sqrt(Math.max(s.legLen * s.legLen - gap * gap, 0)) * 0.97;
    const lat = Math.min(s.legLen * stanceFrac(leg.limb), maxLat);
    const aim = footAim(leg);
    const hip = add(leg.hip, v3(0, atLift, 0));
    const foot = v3(hip.x + aim.x * lat, c, hip.z + aim.z * lat);
    return { foot, lambda: lat / s.legLen };
  };

  // Could this limb bear weight at all? A wing/fin (membranous) or a
  // thread-thin slender limb can't — it lifts and folds regardless of reach.
  // (Body weight vs leg girth is handled separately, as a stand-height cap.)
  const isLeggy = (leg: PendingLeg): boolean =>
    leg.limb.membrane < 0.55 &&
    leg.limb.radiusFrac / Math.max(leg.limb.lengthFrac, 0.1) >= 0.03;

  // How RELUCTANT a capable limb is to be recruited for support — read off
  // its neutral aim. A limb aimed laterally and extended (restProtraction ≈
  // 0, restFlexion ≈ 0, not strongly levated) is a natural stander; one
  // reaching forward and folded up (a crab claw, a mantis forearm) is a
  // manipulator that only bears weight if the body genuinely needs it.
  const recruitCost = (leg: PendingLeg): number => {
    const lim = leg.limb;
    // Reaching forward only marks a MANIPULATOR when the limb is also FOLDED
    // to grasp — an extended forward-reaching leg is still a fine stander, so
    // protraction's weight scales with how folded the knee is. Being carried
    // high (levation) marks a raised forearm on its own.
    const flexFold = Math.min(1, Math.abs(lim.restFlexion) / 0.5);
    const manip = Math.abs(lim.restProtraction) * (0.3 + 0.7 * flexFold)
      + 0.6 * Math.max(0, lim.restLevation - 0.3);
    const weak = Math.max(0, 0.04 - lim.radiusFrac) * 5; // very thin → poor support
    return manip + weak;
  };

  let lowestSurface = Infinity;
  let bodyMass = 0; // volume proxy (Σ r²·len over the axial body)
  let comX = 0, comZ = 0; // mass-weighted centroid (for balance)
  for (const b of bones) {
    if (b.kind === "limb") continue;
    lowestSurface = Math.min(lowestSurface, b.head.y - b.radiusHead, b.tail.y - b.radiusTail);
    if (b.kind === "torso" || b.kind === "tail") {
      const rmid = (b.radiusHead + b.radiusTail) * 0.5;
      const m = rmid * rmid * length(v3(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z));
      bodyMass += m;
      comX += m * (b.head.x + b.tail.x) * 0.5;
      comZ += m * (b.head.z + b.tail.z) * 0.5;
    }
  }
  comX = bodyMass > 1e-9 ? comX / bodyMass : 0;
  comZ = bodyMass > 1e-9 ? comZ / bodyMass : 0;
  const RECRUIT_FREE = 0.35; // below this a limb is a natural stander, not a manipulator
  // Only NATURAL STANDERS set how tall the body stands and how much weight
  // it can hold up — a manipulator (a forward-folded claw, even one with a
  // long foot) must not inflate the standing height and strand the real
  // legs. (Manipulators can still be RECRUITED for balance, below.)
  const canBear = (leg: PendingLeg): boolean => canSupport(leg) && isLeggy(leg);
  let supporters = pendingLegs.filter((leg) => canBear(leg) && recruitCost(leg) < RECRUIT_FREE);
  if (supporters.length === 0) supporters = pendingLegs.filter(canBear); // all-manipulator fallback
  // Body weight vs the cross-section of the legs holding it up: a heavy body
  // on thin legs can't stand as tall — it sags toward belly-rest. (Girth of
  // both body and limb now matters: thicker body = heavier, thicker leg =
  // stronger.)
  const capacity = supporters.reduce(
    (sum, leg) => sum + (leg.limb.radiusFrac * maxR) ** 2 * (1 - 0.7 * leg.limb.membrane), 0);
  // Gentle: a normally-proportioned body (even a two-legged one) stands at
  // full height; only a genuinely overloaded body (thin legs under a heavy
  // trunk) sags toward belly-rest.
  const heightFactor = capacity > 1e-9
    ? Math.max(0.45, Math.min(1, (capacity * 24) / Math.max(bodyMass, 1e-6)))
    : 1;
  // restLift = the belly flat on the ground (the absolute floor: the body
  // never sinks below this). Standing legs raise it above this.
  const restLift = -lowestSurface;
  // Lift at which a support leg is exactly straight (its ceiling).
  const liftStraight = (leg: PendingLeg): number =>
    leg.statics.contactY + leg.statics.maxAnkleH + leg.statics.maxDrop - leg.hip.y;
  let lift: number;
  if (supporters.length > 0) {
    const hHigh = Math.max(...supporters.map(liftStraight));
    const standLow = Math.max(restLift + 0.02 * L, hHigh * 0.4);
    const stand = standLow + (hHigh - standLow) * g.posture.bodyHeight * heightFactor;
    // Floor at the belly: if the legs are too short (or too weak) to lift
    // the body clear, it rests its belly down and the legs fold/tiptoe.
    lift = Math.max(restLift, Math.min(hHigh, stand));
  } else {
    lift = restLift;
  }

  // Load recruitment: only the limbs the body NEEDS bear weight; the rest
  // relax to their neutral pose. Candidates are limbs that COULD plant a
  // foot (mount low enough, leggy, in reach). Natural standers (cheap) are
  // always recruited; a manipulator (a forward-folded claw / a raised mantis
  // forearm) is recruited only while the body is still under-supported — so
  // it stays raised when the other legs already hold the body up, but
  // deploys to the ground if those legs are removed.
  const grounded = new Map<PendingLeg, boolean>();
  const footAt = new Map<PendingLeg, Vec3>();
  // Group each limb's bilateral L/R copies (they share one ResolvedLimb) into
  // a single recruitment UNIT, so the two sides always recruit together — a
  // body never stands on one side of a pair.
  const units = new Map<ResolvedLimb, { legs: PendingLeg[]; feet: Vec3[]; cost: number }>();
  for (const leg of pendingLegs) {
    grounded.set(leg, false);
    if (!canBear(leg)) continue;
    const sol = solveFoot(leg, lift);
    if (!sol) continue;
    footAt.set(leg, sol.foot);
    let u = units.get(leg.limb);
    if (!u) { u = { legs: [], feet: [], cost: recruitCost(leg) }; units.set(leg.limb, u); }
    u.legs.push(leg);
    u.feet.push(sol.foot);
  }
  const unitList = [...units.values()].sort((a, b) => a.cost - b.cost);
  const recruited: Vec3[] = [];
  // How far the CoM sits OUTSIDE the planted feet (axis-aligned proxy for
  // "outside the support polygon"); 0 = the body is balanced over its feet.
  const comGap = (feet: Vec3[]): number => {
    if (feet.length === 0) return Infinity;
    const xs = feet.map((f) => f.x), zs = feet.map((f) => f.z);
    const dx = Math.max(0, Math.min(...xs) - comX, comX - Math.max(...xs));
    const dz = Math.max(0, Math.min(...zs) - comZ, comZ - Math.max(...zs));
    return Math.hypot(dx, dz);
  };
  const balanced = (): boolean => recruited.length >= 3 && comGap(recruited) <= 0.05 * L;
  const RECRUIT_CEILING = 1.2; // a dedicated manipulator above this never stands
  for (const u of unitList) {
    let take = u.cost < RECRUIT_FREE; // natural standers always bear weight
    if (!take && u.cost < RECRUIT_CEILING && !balanced()) {
      // The body still needs support — recruit this manipulator only if its
      // feet actually pull the base under the CoM (else it's wasted strain).
      take = comGap([...recruited, ...u.feet]) < comGap(recruited) - 1e-6;
    }
    if (take) {
      for (const leg of u.legs) grounded.set(leg, true);
      recruited.push(...u.feet);
    }
  }

  // Gait body bob — a vertical lilt on top of the stand height. The planted
  // foot targets (footAt) stay on the ground; bobbing the body up just
  // straightens the bearing legs, which the IK below resolves.
  const nSupport = [...grounded.values()].filter(Boolean).length;
  const bodyLift = lift + (gait ? bodyBob(gait, nSupport).dy * L : 0);
  // Body weight spread over the bearing legs — drives the per-joint strain
  // solve below (heavy share → joints yield toward a load-cheap pose).
  const loadShare = bodyMass / Math.max(1, nSupport);

  // Whole-body balance: gather the PLANTED feet (with the gait's current
  // fore/aft offset) into the support polygon and shift the body horizontally
  // so the CoM rides over it — the creature leaning over its feet when the
  // stance is asymmetric (a biped, a lifted leg). A fast (low-duty) gait adds
  // a forward lean (momentum), letting the CoM ride ahead of the support.
  const supportFeet: Pt[] = [];
  for (const leg of pendingLegs) {
    if (!grounded.get(leg)) continue;
    const foot = footAt.get(leg);
    if (!foot) continue;
    let planted = true, dz = 0;
    if (gait) {
      const cyc = footCycle(legPhaseOffset({ stationFrac: leg.limb.station, side: leg.sideSign }, gait.pattern), gait);
      planted = cyc.planted;
      dz = cyc.advance * gait.strideFrac * leg.statics.legLen;
    }
    if (planted) supportFeet.push({ x: foot.x, z: foot.z + dz });
  }
  const shift = balanceShift({ x: comX, z: comZ }, supportFeet, 0.04 * L);
  const leanZ = gait ? gait.strideFrac * (1 - gait.dutyFactor) * 0.3 * L : 0;
  const bodyShift = v3(shift.x, bodyLift, shift.z + leanZ);

  for (const b of bones) {
    b.head = add(b.head, bodyShift);
    b.tail = add(b.tail, bodyShift);
  }

  // Tail drag — the tail does not hold itself up. Any part that droops
  // below the ground rests on it instead of clipping through. Re-link
  // afterward so the chain stays contiguous.
  const tailBones = bones.filter((b) => b.kind === "tail");
  for (const b of tailBones) {
    if (b.head.y < b.radiusHead) b.head = v3(b.head.x, b.radiusHead, b.head.z);
    if (b.tail.y < b.radiusTail) b.tail = v3(b.tail.x, b.radiusTail, b.tail.z);
  }
  for (let i = 1; i < tailBones.length; i++) tailBones[i].head = tailBones[i - 1].tail;

  // 7) Pose each limb as a 3-section chain (femur / tibia / foot) from the
  //    three DOF. A RECRUITED (grounded) limb deviates levation+flexion from
  //    neutral until its foot reaches the strain-solved contact — a 2-bone
  //    IK — with the knee arching by restLevation and folding the way
  //    restFlexion says; the foot then lies in the limb's own plane (so a
  //    sprawled leg's foot points outward, not forced forward). An
  //    un-recruited limb just holds its neutral three angles by forward
  //    kinematics (wing folds up, arm hangs, crab claw extends forward).
  const upperSegs = Math.max(1, Math.floor(LEG_SEGS / 2));
  // Lay LEG_SEGS loft bones along hip→knee (femur) then knee→ankle (tibia).
  const mix = (p: Vec3, q: Vec3, t: number): Vec3 =>
    v3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t);
  const placeChain = (firstBone: number, hip: Vec3, knee: Vec3, ankle: Vec3): void => {
    const points: Vec3[] = [];
    for (let i = 0; i <= LEG_SEGS; i++) {
      points.push(i <= upperSegs
        ? mix(hip, knee, i / upperSegs)
        : mix(knee, ankle, (i - upperSegs) / (LEG_SEGS - upperSegs)));
    }
    for (let i = 0; i < LEG_SEGS; i++) {
      bones[firstBone + i].head = points[i];
      bones[firstBone + i].tail = points[i + 1];
    }
  };
  for (const leg of pendingLegs) {
    const s = leg.statics;
    // The hip rides with the balanced body (lift + horizontal lean); the
    // planted feet (footAt) stay put, so the legs angle as the body leans.
    const hip = add(leg.hip, bodyShift);
    // Femur/tibia split from legBalance (0 even, + long shank, - long femur).
    const bal = Math.max(-1, Math.min(1, leg.limb.legBalance));
    const l1 = s.legLen * (0.5 - bal * 0.28); // femur
    const l2 = s.legLen * (0.5 + bal * 0.28); // tibia

    if (grounded.get(leg)) {
      // The BALL plants on the ground (lateral stance from solveFoot); the
      // gait slides it fore/aft and lifts it during swing.
      const plant = footAt.get(leg) ?? v3(hip.x, s.contactY, hip.z);
      let cyc = { advance: 0, lift: 0, planted: true };
      if (gait) {
        const off = legPhaseOffset({ stationFrac: leg.limb.station, side: leg.sideSign }, gait.pattern);
        cyc = footCycle(off, gait);
      }
      const px = plant.x;
      const pz = plant.z + cyc.advance * (gait ? gait.strideFrac : 0) * s.legLen;
      const ballY = s.contactY + cyc.lift * (gait ? gait.stepHeight : 0) * s.legLen;

      // Foot azimuth follows the leg's own sprawl (horizontal hip→plant),
      // easing to body-forward when tucked under. Taken from the REST plant
      // (not the gait-shifted one) so a stride slides the foot fore/aft
      // without twisting it — otherwise narrow-stance feet flop each step.
      const horizOff = v3(plant.x - hip.x, 0, plant.z - hip.z);
      const hlen = length(horizOff);
      const sprawlDir = hlen > 1e-4 ? scale(horizOff, 1 / hlen) : footAim(leg);
      const sprawlAmt = Math.min(1, hlen / (0.4 * s.legLen));
      const fwd = normalize(add(scale(v3(0, 0, 1), 1 - sprawlAmt), scale(sprawlDir, sprawlAmt)));

      // ANKLE as a real joint. Its pitch is the limb's ONE free DOF (hip,
      // foot plant, and socket aim are all fixed), so it settles where total
      // STRAIN is least: the muscle effort to hold the knee and ankle off
      // their rest angles (springs, stiff ∝ girth) PLUS the effort to bear
      // the load with a bent (non-columnar) knee. A heavy share straightens
      // the knee into a pillar and drops the heel flat; a light limb relaxes
      // toward its rest crouch and rides up onto the tip — emergent.
      const footLen = s.footLen;
      const restTheta = Math.max(0, Math.min(1, leg.limb.stance)) * 1.3;
      const maxTheta = Math.min(1.45, restTheta + Math.max(0, Math.min(1, leg.limb.ankleRange)) * (1.45 - restTheta));
      const loTheta = Math.max(0, restTheta - 0.5);
      const reach = (l1 + l2) * 0.99;
      const ankleAt = (theta: number): Vec3 => v3(
        px - fwd.x * footLen * Math.cos(theta),
        ballY + footLen * Math.sin(theta),
        pz - fwd.z * footLen * Math.cos(theta),
      );
      const stiff = Math.max(0.04, (leg.limb.radiusFrac / Math.max(g.spine.girth, 0.03)) ** 2);
      const restKnee = Math.PI * (1 - 0.45 * Math.abs(leg.limb.restFlexion));
      const strainAt = (theta: number): number => {
        const an = ankleAt(theta);
        const d = length(v3(an.x - hip.x, an.y - hip.y, an.z - hip.z));
        if (d > reach) return Infinity; // foot can't reach the ground at this pitch
        const cosK = Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)));
        const knee = Math.acos(cosK); // included knee angle (π = straight)
        const spring = stiff * (knee - restKnee) ** 2 + 0.6 * stiff * (theta - restTheta) ** 2;
        const loadEffort = loadShare * LOAD_GAIN * (Math.PI - knee); // bent knee under load costs effort
        return spring + loadEffort;
      };
      let theta = restTheta;
      if (footLen > 1e-6) {
        let best = Infinity;
        for (let i = 0; i <= 24; i++) {
          const t = loTheta + (maxTheta - loTheta) * (i / 24);
          const sc = strainAt(t);
          if (sc < best) { best = sc; theta = t; }
        }
      }
      const ankle = footLen > 1e-6 ? ankleAt(theta) : v3(px, ballY, pz);

      // 2-bone IK femur+tibia → ankle, with the knee fold capped by flexRange.
      const dx = ankle.x - hip.x, dy = ankle.y - hip.y, dz = ankle.z - hip.z;
      const minReach = (l1 + l2) * (1 - 0.9 * Math.max(0, Math.min(1, leg.limb.flexRange)));
      let dist = Math.max(minReach, Math.min(Math.hypot(dx, dy, dz), (l1 + l2) * 0.999));
      const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
      const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
      const dirN = dist > 1e-9 ? v3(dx / dist, dy / dist, dz / dist) : v3(0, -1, 0);

      // Knee pole from levation (arch) + flexion sign (fore/aft), then TWISTED
      // about the leg axis by legTwist (out-of-plane curl).
      const k = Math.max(0, Math.min(1, (leg.limb.restLevation + 1) / 2));
      const w0 = (1 - k) * (1 - k), w1 = 2 * k * (1 - k), w2 = k * k;
      const bend = leg.limb.restFlexion;
      let pole = normalize(v3(
        leg.outDir.x * (w1 * 0.9 + w2 * 0.5),
        w0 * 0.1 + w1 * 0.45 + w2 * 1.2,
        leg.outDir.z * (w1 * 0.9 + w2 * 0.5) + bend * (w0 + w1 * 0.4),
      ));
      // Mirror the twist by side so L/R pronate symmetrically (a +legTwist
      // curls both claws inward, not one in and one out).
      const gTwist = leg.sideSign * leg.limb.legTwist;
      if (Math.abs(gTwist) > 1e-4) pole = rotate(pole, dirN, gTwist);
      const pd = pole.x * dirN.x + pole.y * dirN.y + pole.z * dirN.z;
      let perp = v3(pole.x - dirN.x * pd, pole.y - dirN.y * pd, pole.z - dirN.z * pd);
      perp = length(perp) > 1e-6 ? normalize(perp) : normalize(v3(0, -dirN.z, dirN.y));
      const knee = add(add(hip, scale(dirN, a)), scale(perp, h));
      placeChain(leg.firstBone, hip, knee, ankle);

      const ball = v3(px, ballY, pz);
      if (leg.footBone >= 0) {
        bones[leg.footBone].head = ankle;
        bones[leg.footBone].tail = ball;
      }
      const parentIdx = leg.footBone >= 0 ? leg.footBone : leg.firstBone + LEG_SEGS - 1;
      addDigits({ ball, fwd, parentIdx, chain: leg.chain, limb: leg.limb, sideSign: leg.sideSign, grounded: cyc.planted });
    } else {
      // UN-RECRUITED — hold the neutral three angles by forward kinematics.
      // Femur aimed by protraction (fore/aft swing of `outDir`) + levation
      // (elevation from straight-down); tibia folded by flexion in the limb's
      // vertical plane; foot pitched on by `stance`.
      const hAim = footAim(leg); // horizontal aim, swung by protraction
      const e = levationElevation(leg.limb.restLevation);
      const femurDir = normalize(v3(hAim.x * Math.sin(e), -Math.cos(e), hAim.z * Math.sin(e)));
      // Mirror the twist by side so L/R pronate symmetrically.
      const twist = leg.sideSign * leg.limb.legTwist;
      let flexAxis = cross(Y_AXIS, hAim);
      flexAxis = length(flexAxis) > 1e-6 ? normalize(flexAxis) : X_AXIS;
      // legTwist (pronation) rotates the knee's bend plane about the femur.
      if (Math.abs(twist) > 1e-4) flexAxis = rotate(flexAxis, femurDir, twist);
      const tibiaDir = rotate(femurDir, flexAxis, leg.limb.restFlexion * FLEX_MAX);
      const knee = add(hip, scale(femurDir, l1));
      const ankle = add(knee, scale(tibiaDir, l2));
      placeChain(leg.firstBone, hip, knee, ankle);

      // Foot pitch by `stance`: 0 hangs it down (the folded-in mantis claw /
      // a dropped sole), 1 continues off the tibia (up on the tip). The
      // down-target is twisted by legTwist a second time, so the foot folds
      // INWARD for a 3D-curling claw instead of straight down.
      const st = Math.max(0, Math.min(1, leg.limb.stance));
      let foldTarget = v3(0, -1, 0);
      if (Math.abs(twist) > 1e-4) foldTarget = rotate(foldTarget, tibiaDir, twist);
      const footDir = normalize(add(scale(tibiaDir, st), scale(foldTarget, 1 - st)));
      let ball = ankle;
      if (leg.footBone >= 0) {
        ball = add(ankle, scale(footDir, s.footLen));
        bones[leg.footBone].head = ankle;
        bones[leg.footBone].tail = ball;
      }
      const parentIdx = leg.footBone >= 0 ? leg.footBone : leg.firstBone + LEG_SEGS - 1;
      addDigits({ ball, fwd: footDir, parentIdx, chain: leg.chain, limb: leg.limb, sideSign: leg.sideSign, grounded: false });
    }
  }

  // 7.5) Flexible chains — antennae, tentacles, trunk, eyestalks, lures.
  //      Built post-lift (already in final coords): never ground-solved,
  //      never affect the body lift. Each instance is its own "chain*"
  //      chain, which mesh.ts lofts exactly like a limb. The tip feature
  //      becomes an eye/stinger detail or a swollen club bone.
  {
    const liftedHeadMid = scale(add(headBone.head, headBone.tail), 0.5);
    const headFwd = headAxis;
    const headSide = length(cross(Y_AXIS, headFwd)) > 1e-6
      ? normalize(cross(Y_AXIS, headFwd)) : X_AXIS;
    const headUp = normalize(cross(headFwd, headSide));
    const bSide = length(cross(Y_AXIS, axis)) > 1e-6
      ? normalize(cross(Y_AXIS, axis)) : X_AXIS;
    const bUp = normalize(cross(axis, bSide));

    let chainIdx = 0;
    for (const ch of g.chains) {
      const count = Math.max(1, Math.round(ch.count));
      const instances: Array<{ root: Vec3; dir: Vec3 }> = [];

      if (ch.attach === "head") {
        const rootBase = add(liftedHeadMid, scale(headFwd, headR * 0.5));
        if (ch.radial) {
          // Crown around the face axis; aim opens/closes the cone.
          const coneHalf = lerp(0.25, 1.4, 0.5 - 0.5 * ch.aim) + ch.spread * 0.3;
          for (let k = 0; k < count; k++) {
            const a = (k / count) * Math.PI * 2;
            const spoke = add(scale(headSide, Math.cos(a)), scale(headUp, Math.sin(a)));
            const dir = normalize(add(scale(headFwd, Math.cos(coneHalf)), scale(spoke, Math.sin(coneHalf))));
            instances.push({ root: add(rootBase, scale(spoke, headR * 0.5)), dir });
          }
        } else {
          // Bilateral: optional centered chain + mirrored pairs, tilted
          // up/down by aim, swept apart by spread.
          const tilted = normalize(rotate(headFwd, headSide, -ch.aim * 1.2));
          const pairs = Math.floor(count / 2);
          if (count % 2 === 1) instances.push({ root: rootBase, dir: tilted });
          for (let p = 1; p <= pairs; p++) {
            const az = ch.spread * (p / pairs);
            for (const sgn of [1, -1] as const) {
              instances.push({
                root: add(rootBase, scale(headSide, sgn * headR * 0.4)),
                dir: normalize(rotate(tilted, headUp, sgn * az)),
              });
            }
          }
        }
      } else {
        const center = add(stationPoint(ch.station), v3(0, lift, 0));
        const tR = torsoRadiusAt(g, ch.station);
        if (ch.radial) {
          // Crown around the body axis (anemone/jellyfish column).
          for (let k = 0; k < count; k++) {
            const a = (k / count) * Math.PI * 2;
            const spoke = add(scale(bSide, Math.cos(a)), scale(bUp, Math.sin(a)));
            const dir = normalize(add(scale(spoke, 0.5 + ch.spread), v3(0, ch.aim * 1.5, 0)));
            instances.push({ root: add(center, scale(spoke, tR * csW)), dir });
          }
        } else {
          const pairs = Math.floor(count / 2);
          if (count % 2 === 1) {
            instances.push({ root: add(center, v3(0, tR * csH, 0)), dir: normalize(v3(0, 1, ch.aim)) });
          }
          for (let p = 1; p <= pairs; p++) {
            for (const sgn of [1, -1] as const) {
              instances.push({ root: add(center, v3(sgn * tR * csW, 0, 0)), dir: normalize(v3(sgn, ch.aim, 0)) });
            }
          }
        }
      }

      const parentBone = ch.attach === "head" ? headBoneIdx : torsoBoneAt(ch.station);
      const segs = Math.max(2, Math.round(ch.segments));
      const baseR = ch.radiusFrac * maxR;
      const tipR = baseR * ch.taper;
      const rFloor = baseR * 0.05 + 1e-4;
      const segLen = (ch.lengthFrac * L) / segs;
      const step = ch.curl / segs;

      for (const inst of instances) {
        const name = `chain${chainIdx}`;
        const curlAxis = length(cross(Y_AXIS, inst.dir)) > 1e-6
          ? normalize(cross(Y_AXIS, inst.dir)) : X_AXIS;
        let dir = inst.dir;
        let point = inst.root;
        for (let i = 0; i < segs; i++) {
          if (i > 0) dir = normalize(rotate(dir, curlAxis, step));
          const next = add(point, scale(dir, segLen));
          const f0 = i / segs;
          const f1 = (i + 1) / segs;
          const r0 = Math.max(baseR * (1 - f0) + tipR * f0, rFloor);
          let r1 = Math.max(baseR * (1 - f1) + tipR * f1, rFloor);
          if (ch.tip === "club" && i === segs - 1) r1 = baseR * 0.8; // terminal knob
          bones.push({
            id: `${name}_${i}`,
            parent: i === 0 ? parentBone : bones.length - 1,
            kind: "chain",
            chain: name,
            head: point,
            tail: next,
            radiusHead: r0,
            radiusTail: r1,
            flatten: 0,
            aspect: 1,
          });
          point = next;
        }
        const tipIdx = bones.length - 1;
        const tipBone = bones[tipIdx];
        const tipDir = normalize(v3(
          tipBone.tail.x - tipBone.head.x,
          tipBone.tail.y - tipBone.head.y,
          tipBone.tail.z - tipBone.head.z,
        ));
        if (ch.tip === "eye") {
          details.push({
            kind: "eye", bone: tipIdx, position: tipBone.tail, direction: tipDir,
            radius: Math.max(baseR * 1.8, 0.01), lengthM: 0, hardness: 1,
          });
        } else if (ch.tip === "stinger") {
          details.push({
            kind: "beak", bone: tipIdx, position: tipBone.tail, direction: tipDir,
            radius: baseR * 0.9, lengthM: baseR * 3, hardness: 1,
          });
        }
        chainIdx++;
      }
    }
  }

  // 7.6) Midline membranes — dorsal/ventral webs along the body (dorsal
  //      fin, anal fin, sail; a dorsal + ventral pair over the tail makes
  //      a caudal fin). Sampled from the axial centerline (tail tip →
  //      torso front) post-lift; mesh.ts stitches the ribs into a thin
  //      two-sided sheet. They ride on the body and never affect the lift.
  const membranes: MembranePanel[] = [];
  if (g.membranes.length > 0) {
    const indexed = bones.map((b, i) => ({ b, i }));
    const tailArr = indexed.filter((x) => x.b.chain === "tail");
    const spineArr = indexed.filter((x) => x.b.chain === "spine");
    const cl: Array<{ p: Vec3; r: number; bone: number }> = [];
    if (tailArr.length > 0) {
      const last = tailArr[tailArr.length - 1];
      cl.push({ p: last.b.tail, r: last.b.radiusTail, bone: last.i });
      for (let k = tailArr.length - 1; k >= 0; k--) {
        cl.push({ p: tailArr[k].b.head, r: tailArr[k].b.radiusHead, bone: tailArr[k].i });
      }
    } else if (spineArr.length > 0) {
      cl.push({ p: spineArr[0].b.head, r: spineArr[0].b.radiusHead, bone: spineArr[0].i });
    }
    for (let k = 0; k < spineArr.length; k++) {
      cl.push({ p: spineArr[k].b.tail, r: spineArr[k].b.radiusTail, bone: spineArr[k].i });
    }

    if (cl.length >= 2) {
      const arc: number[] = [0];
      for (let k = 1; k < cl.length; k++) {
        arc.push(arc[k - 1] + length(v3(cl[k].p.x - cl[k - 1].p.x, cl[k].p.y - cl[k - 1].p.y, cl[k].p.z - cl[k - 1].p.z)));
      }
      const total = arc[arc.length - 1] || 1;
      const sampleAt = (s: number): { p: Vec3; r: number; tan: Vec3; bone: number } => {
        const target = s * total;
        let k = 1;
        while (k < arc.length && arc[k] < target) k++;
        const k0 = Math.max(0, k - 1);
        const k1 = Math.min(cl.length - 1, k);
        const seg = arc[k1] - arc[k0];
        const u = seg > 1e-9 ? (target - arc[k0]) / seg : 0;
        const p = v3(
          cl[k0].p.x + (cl[k1].p.x - cl[k0].p.x) * u,
          cl[k0].p.y + (cl[k1].p.y - cl[k0].p.y) * u,
          cl[k0].p.z + (cl[k1].p.z - cl[k0].p.z) * u,
        );
        const r = cl[k0].r + (cl[k1].r - cl[k0].r) * u;
        let tan = v3(cl[k1].p.x - cl[k0].p.x, cl[k1].p.y - cl[k0].p.y, cl[k1].p.z - cl[k0].p.z);
        tan = length(tan) > 1e-9 ? normalize(tan) : v3(0, 0, 1);
        return { p, r, tan, bone: u < 0.5 ? cl[k0].bone : cl[k1].bone };
      };

      for (const m of g.membranes) {
        const start = Math.min(m.start, m.end);
        const end = Math.max(m.start, m.end);
        if (end - start < 1e-3 || m.height <= 1e-4) continue;
        const ribCount = Math.max(4, Math.round((end - start) * 26));
        const sign = m.edge === "dorsal" ? 1 : -1;
        const ribs: MembraneRib[] = [];
        for (let i = 0; i <= ribCount; i++) {
          const u = i / ribCount;
          const smp = sampleAt(start + (end - start) * u);
          let side = cross(Y_AXIS, smp.tan);
          side = length(side) > 1e-6 ? normalize(side) : X_AXIS;
          const outward = scale(normalize(cross(smp.tan, side)), sign);
          // Height profile: 0 at the ends, peaking at heightPeak; rays
          // scallop the outer edge like finrays.
          const peak = m.heightPeak;
          const tt = u < peak ? u / Math.max(peak, 1e-3) : (1 - u) / Math.max(1 - peak, 1e-3);
          let shape = Math.sin(Math.min(1, tt) * (Math.PI / 2));
          if (m.rays > 0) shape *= 1 - 0.18 * (0.5 - 0.5 * Math.cos(2 * Math.PI * u * m.rays));
          const base = add(smp.p, scale(outward, smp.r * 0.9));
          ribs.push({ base, tip: add(base, scale(outward, m.height * L * shape)), normal: side, bone: smp.bone });
        }
        membranes.push({ ribs, thickness: Math.max(maxR * 0.05, 0.003) });
      }
    }
  }

  // 8) Rigid details — beak/muzzle and eyes on the head bone. Positions
  //    must be computed AFTER the lift (head bone already shifted).
  const liftedHeadCenter = add(headCenter, v3(0, lift, 0));
  {
    const beakLen = g.head.beakLengthFrac * headR;
    if (beakLen > 1e-4) {
      details.push({
        kind: "beak",
        bone: headBoneIdx,
        position: add(liftedHeadCenter, scale(headAxis, headR * 0.85)),
        direction: headAxis,
        radius: headR * (0.5 - 0.25 * g.head.beak),
        lengthM: beakLen,
        hardness: g.head.beak,
      });
    }
    const eyeR = g.head.eyeSizeFrac * headR;
    for (let p = 0; p < g.head.eyePairs; p++) {
      for (const side of [-1, 1] as const) {
        // Rotate the head axis sideways by ±eyeAngle around the head's
        // up; extra pairs stack slightly up and back.
        let dir = rotate(headAxis, Y_AXIS, side * g.head.eyeAngle);
        dir = normalize(add(dir, v3(0, 0.35 + p * 0.5, -p * 0.3)));
        details.push({
          kind: "eye",
          bone: headBoneIdx,
          position: add(liftedHeadCenter, scale(dir, headR * 0.92)),
          direction: dir,
          radius: eyeR,
          lengthM: 0,
          hardness: 1,
        });
      }
    }
  }

  // 9) Bounds over bone points (skin adds radii; consumers wanting the
  //    skin AABB should pad by max radius).
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const b of bones) {
    for (const p of [b.head, b.tail]) {
      min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
    }
  }

  return { bones, details, membranes, maxTorsoRadius: maxR, bounds: { min, max } };
}
