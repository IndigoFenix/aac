// Creature skeleton — blueprint → bone chains in a grounded rest pose.
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

import type { FlexChainBlueprint, Blueprint, LimbPlacement } from "./blueprint";
import { bodyBob, footCycle, legPhaseOffset, type GaitParams } from "./gait";
import { balanceShift, type Pt } from "./balance";
import {
  generateGrowth,
  MAX_GROWTH_SEGMENTS,
  type GrowthFruitInstance,
  type GrowthBlueprint,
  type GrowthLeaf,
  type GrowthSegment,
  type GrowthStructure,
} from "./growth";

// ── Vec3 (minimal, allocation-per-call is fine at build time) ───────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
};
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

// ── Limb model constants — a 3-section chain (femur / tibia / foot) posed
// by 3 DOF: protraction (fore/aft), levation (up/down), flexion (knee).
// The femur+tibia loft as LEG_SEGS bones (for a smooth skin); the foot is
// its own bone. Extra arthropod "joints" would be a render subdivision, not
// more DOF.
const LEG_SEGS = 4; // femur 2 + tibia 2 loft bones
const PROTRACT_MAX = 1.3; // rad — full fore/aft swing
const FLEX_MAX = 2.4; // rad — full knee fold
const LOAD_GAIN = 26; // how hard the borne weight straightens the knee vs. the joints' springs
/** How far a digit must run PAST the ball it grows from, in multiples of its
 *  own radius. Feeds a floor in `addDigits`, never a target: it is the point
 *  below which a digit stops reading as a digit and becomes a bump on the
 *  ankle. 1.5 is the largest value at which every hand-tuned body (human,
 *  quadruped, dog, cat, deer, ram, cow, ungulate) still clears the floor on
 *  its own authored `toeLengthFrac` — so the bodies somebody posed in the lab
 *  are untouched and only the ones the floor exists for move. */
const DIGIT_MIN_ASPECT = 1.5;
/** How mesh.ts's loft turns a bone's `flatten` into a CROSS-SECTION: a ring of
 *  radius r and flatten f lofts at half-WIDTH `r * (1 + XSECTION_WIDEN * f)` and
 *  half-HEIGHT `r * (1 - XSECTION_FLATTEN * f)`. Owned here, re-exported by
 *  mesh.ts's `LOFT`, because the SKELETON has to place digits against the
 *  sole's RENDERED width: a foot is flattened, so its bone radius is NOT its
 *  half-width, and sizing toes off the radius made them (and their spread)
 *  1.56x too small on every footed limb. */
export const XSECTION_WIDEN = 1.6;
export const XSECTION_FLATTEN = 0.7;
/** Half-width of a lofted ring, per unit of bone radius, at this `flatten`. */
export const halfWidthFactor = (flatten: number): number => 1 + XSECTION_WIDEN * flatten;
/** The sole's own flatten: a foot is about twice as wide as it is tall. */
export const FOOT_FLATTEN = 0.35;
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

/** One placed copy of a growth (a horn, a plant's trunk-and-branches):
 *  segments/leaves/fruits in CREATURE-LOCAL coords, welded as rigid
 *  geometry to a single bone — growths add NO bones. Bilateral L copies
 *  are reflections (spiral chirality flips), so paired horns mirror. */
export interface GrowthInstance {
  /** The clamped blueprint entry (mesh reads colors/hardness from it). */
  blueprint: GrowthBlueprint;
  /** Bone all of this instance's geometry welds to (single skin weight). */
  bone: number;
  segments: GrowthSegment[];
  leaves: GrowthLeaf[];
  fruits: GrowthFruitInstance[];
}

/** The mouth as a SEAM in the single head loft, not a jaw solid stuck
 *  through a skull. The head+snout is one continuous tube; over the mouth
 *  region (everything forward of `hinge`) the mesh splits each ring at the
 *  mouth line and swings the LOWER arc down about the hinge by `gapeAngle`,
 *  opening a real wedge. At gapeAngle 0 the arcs coincide — a closed mouth
 *  is an invisible seam, so morphing a blueprint never slides a fake line. */
export interface MouthSpec {
  /** Jaw hinge / pivot (post-lift) — under the rear of the cranium. The lower
   *  jaw (cut flat at the bite) swings open about this. */
  hinge: Vec3;
  /** Opening rotation axis (post-lift, horizontal across the face). */
  axis: Vec3;
  /** Radians the lower jaw swings open (0 = closed). */
  gapeAngle: number;
  /** The lower-jaw bone (its verts swing + bind here). */
  jawBone: number;
  /** The upper-jaw / head bone. */
  headBone: number;
  /** Bite-line offset on the cross-section (mouthVertical): where the upper
   *  jaw's flat bottom / the lower jaw's flat top sit, as a fraction of the
   *  local half-height above the muzzle centre. */
  biteFrac: number;
}

/** Parametric skull landmarks + frame, creature-local, POST-LIFT. The
 *  skull is a braincase capsule + a rostrum wedge; these named points and
 *  the head frame are the anchors the (later) soft-tissue and appendage
 *  layers hang off, so a cheek / lip / ear moves correctly when a skull
 *  dial changes. Absent when the creature has no meaningful head. */
export interface HeadLandmarks {
  /** Braincase center. */
  center: Vec3;
  /** Front pole of the braincase — the rostrum root. */
  rostrumBase: Vec3;
  /** Muzzle tip (= rostrumBase when there is no rostrum). */
  rostrumTip: Vec3;
  /** Top of the braincase (the crown). */
  crown: Vec3;
  /** Mandible tip (chin), or the mouth line front when the jaw is fused. */
  chin: Vec3;
  /** Level braincase axis (rear→front). */
  braincaseAxis: Vec3;
  /** Rostrum axis, pitched off the braincase by facePitch. */
  rostrumAxis: Vec3;
  /** Sideways (across the face, +X). */
  side: Vec3;
  /** Up in the face frame (+Y). */
  up: Vec3;
  /** Braincase half-width (the head radius reference). */
  radius: number;
  /** Braincase half-length. */
  halfLen: number;
  /** Braincase height half-axis (radius · braincaseDome). */
  domeHalf: number;
}

/** One guide primitive of the skull: an ellipsoid (center, sagittal axis
 *  `dir`, half-axes rx across / ry up / halfLen along dir). The skull's
 *  visible surface is the UNION of these — the round cranium is a
 *  MATHEMATICAL entity guiding the shape, never rendered as a ball, and
 *  the muzzle stations flow out of it as one fused surface. */
export interface SkullPrim {
  center: Vec3;
  /** Unit axis of this primitive (sagittal — x = 0). */
  dir: Vec3;
  /** Half-axes: across the face / up / along `dir`. */
  rx: number;
  ry: number;
  halfLen: number;
  /** Bite-plane height (world Y) — set on snout-proper stations only; the
   *  mesh clips the upper jaw flat here (the palate). */
  biteY?: number;
  /** True when this muzzle station sits BEHIND the mouth commissure
   *  (mouthOpen = how far back from the tip the lips part): cheek skin
   *  spans the jaws here — the visible mouth is SMALLER than the
   *  mandible's full gape. */
  cheek?: boolean;
  /** Skinning for the ring the mesh lofts at this station. */
  boneA?: number;
  boneB?: number;
  weightA?: number;
}

/** A point on the skull's dorsal contour + its outward surface normal. */
export interface SkullContourPt {
  p: Vec3;
  n: Vec3;
}

/** The whole skull as ONE model with flexible anchor points (post-lift):
 *  guide primitives for the surface union, the sagittal centerline the
 *  mesh lofts rings along, and the dorsal contour add-ons slide on. */
export interface SkullGuide {
  cranium: SkullPrim;
  /** Forehead + snout stations, cranium → tip (empty when no snout). */
  stations: SkullPrim[];
  /** Index into `stations` where the snout proper (the upper jaw — bite
   *  clip + keratin tint) begins. */
  muzzleFrom: number;
  /** When mouthOpen > 1 the mouth corner sits BEHIND the muzzle root, on
   *  the jawline at this longitudinal z (croc/snake gape). The mesh opens
   *  the cheek region forward of it. Absent for mouthOpen ≤ 1 (the corner
   *  is then a real muzzle station — see `cheek` flags). */
  mouthCorner?: { z: number };
  /** Dorsal contour, snout tip → bridge → crown → occiput → skull base,
   *  with outward normals — the slide rail for noses and head growths. */
  dorsal: SkullContourPt[];
}

/** Farthest exit (t along unit `d` from `o`) out of the skull-guide union,
 *  with the outward normal of the winning primitive at the hit — or null
 *  when the ray leaves no primitive ahead of the origin. This is how the
 *  mesh and every add-on find the REAL skull surface. */
export function skullRaycast(
  guide: SkullGuide,
  o: Vec3,
  d: Vec3,
): { t: number; n: Vec3 } | null {
  let bestT = -1;
  let bestN: Vec3 | null = null;
  const hit = (pr: SkullPrim): void => {
    const F = pr.dir;
    const U = normalize(cross(F, X_AXIS)); // sagittal up for a sagittal axis
    const rel = sub(o, pr.center);
    const ox = dot3(rel, X_AXIS) / pr.rx;
    const oy = dot3(rel, U) / pr.ry;
    const oz = dot3(rel, F) / pr.halfLen;
    const dx = dot3(d, X_AXIS) / pr.rx;
    const dy = dot3(d, U) / pr.ry;
    const dz = dot3(d, F) / pr.halfLen;
    const a = dx * dx + dy * dy + dz * dz;
    if (a < 1e-12) return;
    const b = ox * dx + oy * dy + oz * dz;
    const c = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - a * c;
    if (disc < 0) return;
    const t = (-b + Math.sqrt(disc)) / a; // exit point
    if (t <= 1e-9 || t <= bestT) return;
    // Unit-sphere hit coords → world normal (gradient of the ellipsoid).
    const hx = ox + t * dx, hy = oy + t * dy, hz = oz + t * dz;
    bestT = t;
    bestN = normalize(add(
      add(scale(X_AXIS, hx / pr.rx), scale(U, hy / pr.ry)),
      scale(F, hz / pr.halfLen)));
  };
  hit(guide.cranium);
  for (const pr of guide.stations) hit(pr);
  return bestN ? { t: bestT, n: bestN } : null;
}

export interface CreatureSkeleton {
  bones: CreatureBone[];
  details: RigidDetail[];
  /** Midline webs (dorsal/anal/caudal fins, sails). */
  membranes: MembranePanel[];
  /** Dermal growths / plant structures (horns, antlers, trunks). */
  growths: GrowthInstance[];
  /** The articulated mouth seam, when the head opens (mouthOpen > 0). */
  mouth?: MouthSpec;
  /** Skull landmarks + frame (post-lift) for soft-tissue / appendages. */
  head?: HeadLandmarks;
  /** The skull guide union (post-lift) — the mesh lofts ONE fused surface
   *  over this; noses/growths raycast it to seat on the real contour. */
  skull?: SkullGuide;
  /** Max torso radius actually used, meters — handy reference for
   *  consumers (eye/beak sizes, camera framing). */
  maxTorsoRadius: number;
  /** Rough creature-local AABB of the bone points (not the skin). */
  bounds: { min: Vec3; max: Vec3 };
}

// ── Pose overrides — the animation layer's handle on the skeleton ───────
// The gait cycles the WEIGHT-BEARING feet; these drive everything else:
// an un-recruited limb (an arm, a claw) can be steered to an explicit IK
// target (reaching for an object), and hanging arms counter-swing with
// the gait. Coordinates are creature-local, post-lift (the skeleton's
// output space) — same frame the caller reads bone points in.

/** Steer one un-recruited limb's tip to a target point. */
export interface LimbTargetOverride {
  /** Which limb: blueprint limbGroups index + copy index + bilateral side. */
  group: number;
  index: number;
  /** +1 = right (+X), -1 = left. Radial limbs use +1. */
  side: 1 | -1;
  /** Where the limb tip (the hand's digits) should reach, creature-local.
   *  Clamped to the limb's reach — an out-of-range target is approached. */
  target: Vec3;
  /** Digit curl override while reaching: 0 open .. 1 gripped. */
  grip?: number;
}

export interface PoseOverrides {
  limbTargets?: LimbTargetOverride[];
  /** Fore/aft counter-swing amplitude for hanging (depressed, un-recruited)
   *  limbs during a gait, in protraction units — a walking biped's arms.
   *  Each limb swings at its own leg phase, so diagonal coordination falls
   *  out of the same pattern machinery as the feet. */
  armSwing?: number;
  /** Mouth opening, 0 closed .. 1 wide — swings the lower lip of the mouth
   *  commissure (head.mouthOpen) open. An animation input like grip, never
   *  a blueprint value. */
  gape?: number;
}

/** The bone-chain prefix skeleton gives one limb copy: "limb<flat><L|R|r>".
 *  Lets callers find a specific limb's bones (e.g. the reaching hand). */
export function limbChainName(g: Blueprint, group: number, index: number, side: 1 | -1): string {
  const { limbs } = resolveLimbs(g);
  const flat = limbs.findIndex((l) => l.group === group && l.index === index);
  if (flat < 0) return "";
  return `limb${flat}${limbs[flat].placement === "radial" ? "r" : side < 0 ? "L" : "R"}`;
}

/** Tip point of a limb/chain: the LAST main-chain bone's tail (the foot's
 *  ball for a footed limb — digits are their own chains). Null if absent. */
export function limbTip(skel: CreatureSkeleton, chain: string): Vec3 | null {
  for (let i = skel.bones.length - 1; i >= 0; i--) {
    if (skel.bones[i].chain === chain) return skel.bones[i].tail;
  }
  return null;
}

// ── Torso radius profile ─────────────────────────────────────────────────
// Station t: 0 = chest (front) .. 1 = hip (rear), matching blueprint
// semantics for girthPeak and limb stations. Cosine-eased falloff from
// the peak toward each end, end radius set by the taper amount — smooth
// at the peak, blunt-to-needle at the ends, no discrete shapes.

export function torsoRadiusAt(g: Blueprint, t: number): number {
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
// blueprint's control points. Flat 1 outside the points' span, so a body
// with no profile is unchanged. Points are sorted on clamp.
export function profileFactorAt(g: Blueprint, t: number): number {
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
// Unfold the blueprint's compact `limbGroups` into a flat list of concrete
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

export function resolveLimbs(g: Blueprint): { limbs: ResolvedLimb[] } {
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

export function buildSkeleton(
  g: Blueprint,
  gait?: GaitParams,
  pose?: PoseOverrides,
  /** Override the total growth segment budget (default MAX_GROWTH_SEGMENTS)
   *  — the plant LOD tiers rebuild the same blueprint at smaller budgets. */
  growthBudget?: number,
): CreatureSkeleton {
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

  // 4) Head — ONE coherent skull. The UPPER skull (cranium → forehead → upper
  //    jaw) is a SINGLE continuous surface: the "snout" chain runs the forehead
  //    slope into the upper jaw and emerges from the cranium, so the dorsal
  //    profile is unbroken and the nose slides along it. The LOWER jaw is a
  //    SEPARATE bone: the muzzle's outer shape, cut flat at the bite plane,
  //    deepened by jawDepth, on a ramus reaching back under the cranium. Both
  //    jaws are cut at the bite (mesh clip) and fit together; the gape swings
  //    the lower one open to reveal the cavity. jawOffset = over/underbite,
  //    mouthVertical = bite-line height.
  const headR = g.head.sizeFrac * maxR;
  const aL = headR * g.head.lengthFrac;
  const bH = headR * g.head.braincaseDome;
  const aW = headR * g.head.crossSection;
  const braincaseAxis = v3(0, 0, 1);
  const faceSide = X_AXIS;
  const faceUp = v3(0, 1, 0);
  const domeHalf = bH;
  // The neck joins the skull at its BASE, not the back of the cranium: the
  // attach direction runs from the cranium center back along the neck,
  // biased downward — a level neck enters low-rear (lizard/cow), a vertical
  // neck enters the bottom (human). The skull's own shape is fixed in its
  // frame; changing the neck angle only moves WHERE the neck tube meets it,
  // never deforms the back of the skull.
  const attachDir = normalize(add(scale(headDir, -1), v3(0, -0.45, 0)));
  // Seat distance uses the NEUTRAL skull ball for width/height (dome and
  // crossSection grow the vault around a fixed seat — they must never move
  // the muzzle) and the real half-length axially (long skulls seat further
  // back).
  const attachDist = 1 / Math.sqrt(
    (attachDir.x / headR) ** 2 + (attachDir.y / headR) ** 2 + (attachDir.z / aL) ** 2 + 1e-12);
  // Sunk slightly inside the guide surface so the neck tube buries its cap.
  const headCenter = sub(headBase, scale(attachDir, attachDist * 0.88));
  bones.push({
    id: "head", parent: headParent, kind: "head", chain: "head",
    head: sub(headCenter, scale(braincaseAxis, aL)),
    tail: add(headCenter, scale(braincaseAxis, aL)),
    radiusHead: headR, radiusTail: headR, flatten: 0, aspect: g.head.crossSection,
  });
  const headBoneIdx = bones.length - 1;
  const headBone = bones[headBoneIdx];
  const craniumFront = headBone.tail;

  // Snout params.
  const snoutLen = g.head.snoutLengthFrac * headR;
  const snoutBaseR = headR * g.head.snoutRadiusFrac;
  const snoutAspect = Math.max(0.35, Math.min(3, g.head.snoutFlatten * g.head.crossSection));
  const snoutUR = snoutBaseR / Math.sqrt(snoutAspect);
  const tipFrac = Math.max(0.06, lerp(0.1, 1.0, g.head.muzzleSquash) - 0.3 * g.head.beak);
  // A muzzle cannot TAPER faster than it PROJECTS. Shrinking the radius by
  // more than the rostrum advances turns it into a disc, and a disc lofts as
  // a stack of near-coincident rings with wildly different radii — vertical
  // annuli, which read as the indentations a short muzzle shows above and
  // below the jaw. Capping the taper at ~45° lets a short muzzle degenerate
  // into a rounded stub (the cap rounds it off) instead of a pancake, and
  // leaves any muzzle long enough to carry its own taper untouched.
  const tipR = Math.max(snoutBaseR * tipFrac, snoutBaseR - snoutLen);
  const snoutSR = snoutBaseR * Math.sqrt(snoutAspect);
  const hasSnout = snoutLen > 1e-4;
  const nSeg = Math.max(1, Math.round(g.head.snoutSegments));

  // TURN IS PAID FOR IN LENGTH. A tube of radius R that turns by θ over a
  // length L folds in on itself once θ > L/R: the inside of the curve turns
  // inside out. A short muzzle therefore cannot pitch or curve much — trying
  // to is what pinched a stubby snout into the indentations above and below
  // the jaw, and it got worse the harder the dials were pushed because the
  // whole turn was being spent across almost no distance.
  //
  // So both dials are capped by what the rostrum's LENGTH can carry. A muzzle
  // long enough to afford its turn is untouched; a stub simply stays straight.
  // Both dials read as a FRACTION OF WHAT IS ALLOWED, not as an absolute
  // that gets clipped: clipping leaves a dead zone at the top of the slider
  // where turning it further does nothing, and two blueprints that look
  // different on paper render identically. Scaling keeps the whole range
  // live and still cannot fold the tube.
  const segLen = snoutLen / nSeg;
  const turnBudget = hasSnout ? (0.9 * segLen) / Math.max(1e-6, snoutBaseR) : Infinity;
  /** Full-scale bend each dial asks for at ±1, before the budget applies. */
  const PITCH_FULL = 0.9; // facePitch's own range, radians
  const CURVE_FULL = 1.2; // snoutCurve's full-scale bend, radians
  // `facePitch` is spent entirely between the skull-owned root ring and the
  // FIRST muzzle station, so it gets one segment's allowance; `snoutCurve`
  // accumulates along the whole rostrum, so it gets every segment's.
  const facePitchUsed = (g.head.facePitch / PITCH_FULL) * Math.min(PITCH_FULL, turnBudget);
  const curveTotal = g.head.snoutCurve * Math.min(CURVE_FULL, turnBudget * nSeg);
  const rostrumDir0 = normalize(rotate(braincaseAxis, faceSide, -facePitchUsed));
  /** Cumulative muzzle bend at fraction `f` along the rostrum — a genuine
   *  CURVATURE: zero at the root, so the muzzle always leaves the skull
   *  along the axis `facePitch` set, and accumulating along its length.
   *
   *  The old form was `snoutCurve·(0.3 + 0.9f) + 0.5·max(0, f − 0.6)`. The
   *  0.3 meant a third of the full bend was already applied AT THE ROOT, so
   *  `snoutCurve` mostly acted as a second pitch dial — which is why it and
   *  `facePitch` looked like the same control and compounded when pushed the
   *  same way. The trailing term was worse: an unconditional hook drooping
   *  every muzzle tip by up to 0.2 rad whatever the dials said. */
  const snoutBend = (f: number): number => curveTotal * f;
  /** Direction of the FIRST muzzle segment (its midpoint bend) — the tangent
   *  the forehead bridge must arrive along. */
  const snoutDir0 = normalize(rotate(rostrumDir0, faceSide, snoutBend(0.5 / nSeg)));

  // MUZZLE ROOT — an X/Y POINT in the sagittal face plane, not a walk around
  // the cranium. `foreheadHeight` sets its HEIGHT and `foreheadLength` its
  // FORWARD REACH, independently: raising the brow must never drag the snout
  // backward. The reach is measured from the cranium's FRONT POLE, so however
  // the two dials are set the root sits at or ahead of the skull — the bridge
  // always runs forward, and the loft's dorsal/ventral anchor sweeps can never
  // cross (a crossed sweep inverts every ring: the caved-in face).
  //
  // The root is the ring's CENTRE (a fat snout no longer drops its own seat)
  // and its cross-section belongs to the CRANIUM, square to the braincase
  // axis: `facePitch` hinges only what grows OUT of the seat. rootTop is then
  // always above rootBot at a z ahead of the centre, which is what makes the
  // no-crossing guarantee hold at every pitch.
  // 0 = the muzzle roots at or below the floor of the cranium (a horse, a
  // long-faced grazer), 1 = at the crown (a whale's blowhole, a stargazer).
  // The seat may sit outside the skull at either end: the bridge spans it.
  const rootY = lerp(-1 * bH, 0.9 * bH, g.head.foreheadHeight);
  const rootZ = aL + g.head.foreheadLength * headR;
  const muzzleRoot = add(headCenter, add(scale(braincaseAxis, rootZ), scale(faceUp, rootY)));
  /** The "red dot" landmark other layers hang off: the TOP of the root ring. */
  const redDot = add(muzzleRoot, scale(faceUp, snoutUR));

  // UPPER JAW chain "snout" = FOREHEAD bones (cranium front → muzzle root,
  // dipping, bowed by foreheadSlope) + SNOUT bones (muzzle root → tip). One
  // continuous loft off the cranium. `snoutCenters/snoutR` record the upper-jaw
  // stations (for the lower jaw); `dorsal` is the top profile the nose slides
  // along (FRONT tip → BACK crown).
  const snoutCenters: Vec3[] = [];
  const snoutR: { rx: number; ry: number }[] = [];
  const snoutDirs: Vec3[] = []; // per joint, aligned with snoutCenters
  /** Forehead-bridge guide stations (interior only), cranium → muzzle root. */
  const bridge: SkullPrim[] = [];
  /** Dorsal edge of the forehead bridge, cranium contact (0) → root top (1). */
  let bridgeDorsal: ((t: number) => Vec3) | null = null;
  /** Ellipse angle where the bridge leaves the cranium (the dorsal contact). */
  let bridgeContactAng = 0;
  let rostrumTip = muzzleRoot;
  // Sagittal guide ellipse of the cranium, and the tangency of a line drawn
  // to it from a point outside — the contact where the face can leave the
  // skull with NO corner (`upper` picks the higher of the two contacts).
  const ellipseAt = (ang: number): Vec3 =>
    add(headCenter, add(scale(braincaseAxis, aL * Math.cos(ang)), scale(faceUp, bH * Math.sin(ang))));
  const tangentAngle = (p: Vec3, upper: boolean): number => {
    const rel = sub(p, headCenter);
    const qz = dot3(rel, braincaseAxis) / aL;
    const qy = dot3(rel, faceUp) / bH;
    const q2 = qz * qz + qy * qy;
    if (q2 <= 1.0001) return Math.atan2(qy, qz);
    const r = Math.sqrt(q2 - 1);
    const y1 = (qy + qz * r) / q2, z1 = (qz - qy * r) / q2;
    const y2 = (qy - qz * r) / q2, z2 = (qz + qy * r) / q2;
    return (y1 >= y2) === upper ? Math.atan2(y1, z1) : Math.atan2(y2, z2);
  };
  if (hasSnout) {
    // FOREHEAD BRIDGE — the cranium→muzzle ramp, built ONCE and shared by the
    // bones, the guide stations and the dorsal rail. Those were three separate
    // constructions that quietly disagreed about where the face is, which is
    // why a sharp wall appeared above the snout at unpredictable ratios.
    //
    // Its DORSAL edge is the TANGENT line from the muzzle root's top rim to
    // the cranium: tangency means the face leaves the skull with no corner,
    // whatever the dials say. Its VENTRAL edge mirrors that underneath. The
    // bridge's own cross-section is the gap BETWEEN those two edges, so it can
    // never bulge past the cranium it grows out of — the old bug where a
    // forehead station poked through the brow.
    const rootTop = add(muzzleRoot, scale(faceUp, snoutUR));
    const rootBot = sub(muzzleRoot, scale(faceUp, snoutUR));
    const topAng = tangentAngle(rootTop, true);
    const cTop = ellipseAt(topAng);
    const cBot = ellipseAt(tangentAngle(rootBot, false));
    bridgeContactAng = topAng;
    // `foreheadSlope` bows the dorsal edge — with a profile that is zero in
    // BOTH value and slope at each end, so the tangency at the cranium and
    // the seat at the root survive any bow. It can shape the brow; it can no
    // longer detach the face from the skull.
    const chordT = sub(rootTop, cTop);
    let perpT = normalize(cross(faceSide, chordT));
    if (perpT.y < 0) perpT = scale(perpT, -1);
    const bowT = 0.35 * g.head.foreheadSlope * length(chordT);
    const dorsalAt = (t: number): Vec3 => add(
      add(scale(cTop, 1 - t), scale(rootTop, t)),
      scale(perpT, Math.sin(Math.PI * t) ** 2 * bowT));
    const ventralAt = (t: number): Vec3 => add(scale(cBot, 1 - t), scale(rootBot, t));
    const midAt = (t: number): Vec3 => scale(add(dorsalAt(t), ventralAt(t)), 0.5);
    const halfAt = (t: number): number => length(sub(dorsalAt(t), ventralAt(t))) * 0.5;
    bridgeDorsal = dorsalAt;
    // Sample density follows the TURN: an under-sampled turn IS the sharp
    // wall above the snout, so a steep bridge earns more stations.
    const drop = Math.acos(Math.max(-1, Math.min(1,
      dot3(normalize(sub(rootTop, cTop)), braincaseAxis))));
    const nFore = Math.max(2, Math.min(6, Math.round(2 + (drop / (Math.PI / 2)) * 4)));
    let parent = headBoneIdx;
    let prevF = midAt(0);
    for (let i = 0; i < nFore; i++) {
      const f0 = i / nFore, f1 = (i + 1) / nFore;
      const next = midAt(f1);
      bones.push({
        id: `forehead${i}`, parent, kind: "head", chain: "snout",
        head: prevF, tail: next,
        radiusHead: Math.max(halfAt(f0), 1e-4),
        radiusTail: Math.max(halfAt(f1), 1e-4),
        flatten: 0, aspect: lerp(g.head.crossSection, snoutAspect, f1),
      });
      parent = bones.length - 1;
      prevF = next;
    }
    // Interior guide stations on the SAME ramp. The ends are omitted: the
    // cranium owns t = 0 and the muzzle's own station 0 owns t = 1, so the
    // union ramps monotonically with nothing to overlap or step against.
    const nBridge = Math.max(2, nFore);
    for (let k = 0; k < nBridge; k++) {
      const t = (k + 1) / (nBridge + 1);
      const tan = normalize(sub(midAt(Math.min(1, t + 0.05)), midAt(Math.max(0, t - 0.05))));
      bridge.push({
        center: midAt(t), dir: tan,
        rx: lerp(aW * 0.9, snoutSR, t), ry: Math.max(halfAt(t), 1e-4), halfLen: 0,
        boneA: headBoneIdx, boneB: headBoneIdx, weightA: 1,
      });
    }
    // Snout bones.
    let prev = muzzleRoot;
    let prevDir: Vec3 | null = null;
    for (let i = 0; i < nSeg; i++) {
      const f0 = i / nSeg, f1 = (i + 1) / nSeg;
      const rHead = snoutBaseR * (1 - f0) + tipR * f0;
      const rTail = snoutBaseR * (1 - f1) + tipR * f1;
      // A segment's direction is the bend at its MIDPOINT, so the chain
      // integrates the curvature instead of running one step ahead of it.
      const dir = normalize(rotate(rostrumDir0, faceSide, snoutBend((f0 + f1) / 2)));
      const next = add(prev, scale(dir, snoutLen / nSeg));
      bones.push({
        id: `snout${i}`, parent, kind: "head", chain: "snout",
        head: prev, tail: next, radiusHead: rHead, radiusTail: rTail,
        flatten: 0, aspect: snoutAspect,
      });
      parent = bones.length - 1;
      snoutCenters.push(prev);
      snoutR.push({ rx: rHead * Math.sqrt(snoutAspect), ry: rHead / Math.sqrt(snoutAspect) });
      // The ROOT ring is skull-owned — square to the braincase axis, so no
      // amount of facePitch can tilt the seat into the cranium and cross the
      // loft's sweeps. Every ring after it follows the pitched muzzle.
      snoutDirs.push(prevDir ? normalize(add(prevDir, dir)) : braincaseAxis);
      prevDir = dir;
      prev = next;
    }
    snoutCenters.push(prev);
    snoutR.push({ rx: tipR * Math.sqrt(snoutAspect), ry: tipR / Math.sqrt(snoutAspect) });
    snoutDirs.push(prevDir!);
    rostrumTip = prev;
  }

  // LOWER JAW chain "jaw": the muzzle's outer shape cut at the bite, deepened
  // by jawDepth, on a ramus reaching back under the cranium. Built at REST; the
  // mesh clips its flat top (the floor) and swings it open by the gape.
  let mouthPre: {
    hinge: Vec3; axis: Vec3; gapeAngle: number; jawBone: number; biteFrac: number;
  } | null = null;
  if (hasSnout) {
    const gape = Math.max(0, Math.min(1, pose?.gape ?? 0));
    const gapeAngle = g.head.mouthOpen > 1e-4 ? gape * lerp(0.2, 1.0, g.head.mouthOpen) : 0;
    const jawExtra = g.head.jawDepth * headR;                       // extra depth below the muzzle
    const biteFrac = Math.max(-1, Math.min(1, g.head.mouthVertical)); // bite-line offset
    const jawOffZ = g.head.jawOffset * snoutBaseR * 0.5;            // over/underbite (fore/aft)
    const jawJoint = add(headCenter, add(scale(braincaseAxis, -aL * 0.1), scale(faceUp, -bH * 0.35)));
    // The mandible DEEPENS FORWARD, from flush with the muzzle at the root
    // to `jawDepth` at the chin, along a smoothstep. These bones are the
    // skinning spine of the shell mesh.ts lofts, and they follow the same
    // law it does: a constant +jawExtra put a V in the chain at the root —
    // the ramus descending, the jaw body immediately climbing again.
    const nJawSeg = Math.max(1, snoutCenters.length - 1);
    const jawDepthAt = (i: number): number => {
      const f = Math.min(1, i / nJawSeg / 0.6); // full depth by 60% along, then held
      return jawExtra * (f * f * (3 - 2 * f));
    };
    // Ramus: joint (merged into the cranium) → the jaw body root, curving up
    // and back so the mandible links to the skull instead of floating. Its
    // tail radius IS the jaw body's head radius, so the chain is continuous
    // across the junction.
    const jawRoot = add(snoutCenters[0], scale(braincaseAxis, jawOffZ));
    const ry0j = snoutR[0].ry + jawDepthAt(0);
    const jawRootR = Math.sqrt(snoutR[0].rx * ry0j);
    bones.push({
      id: "ramus0", parent: headBoneIdx, kind: "head", chain: "jaw",
      head: jawJoint, tail: jawRoot,
      radiusHead: ry0j * 0.55, radiusTail: jawRootR,
      flatten: 0, aspect: 1,
    });
    let parent = bones.length - 1;
    // Jaw body: along the snout centerline (shifted by jawOffset). Its ring
    // shares the muzzle WIDTH (rx) so it fits the upper jaw.
    for (let i = 0; i < snoutCenters.length - 1; i++) {
      const c0 = add(snoutCenters[i], scale(braincaseAxis, jawOffZ));
      const c1 = add(snoutCenters[i + 1], scale(braincaseAxis, jawOffZ));
      const rx0 = snoutR[i].rx, ry0 = snoutR[i].ry + jawDepthAt(i);
      const rx1 = snoutR[i + 1].rx, ry1 = snoutR[i + 1].ry + jawDepthAt(i + 1);
      bones.push({
        id: `jaw${i}`, parent, kind: "head", chain: "jaw",
        head: c0, tail: c1,
        radiusHead: Math.sqrt(rx0 * ry0), radiusTail: Math.sqrt(rx1 * ry1),
        flatten: 0, aspect: (rx0 / ry0 + rx1 / ry1) / 2,
      });
      parent = bones.length - 1;
    }
    mouthPre = { hinge: jawJoint, axis: faceSide, gapeAngle, jawBone: bones.length - 1, biteFrac };
  }

  // SKULL GUIDE — the whole upper skull as ONE model (pre-lift; shifted
  // into skel.skull after the body lift). The cranium ellipsoid and the
  // forehead/snout station ellipsoids are mathematical guides: the mesh
  // ray-casts their UNION to loft one fused surface, and add-ons ray-cast
  // it to seat on the real contour.
  const skullGuidePre: SkullGuide = (() => {
    // The forehead bridge's own stations, straight off the shared C1 curve —
    // no second construction to disagree with the bones.
    const stations: SkullPrim[] = bridge.map((pr) => ({ ...pr }));
    const snout0Idx = bones.findIndex((b) => b.id === "snout0");
    const muzzleFrom = stations.length;
    const nJaw = snoutCenters.length; // snout joints (0 when no snout)
    // Commissure: the lips part only over the front `mouthOpen` fraction of
    // the jaw; stations behind it are cheek-covered (the visible mouth is
    // smaller than the mandible's gape — horse, human). mouthOpen > 1
    // slides the corner PAST the root along the jawline (croc/snake).
    const mo = Math.min(1.5, Math.max(0, g.head.mouthOpen));
    for (let i = 0; i < nJaw; i++) {
      const fTip = nJaw > 1 ? (nJaw - 1 - i) / (nJaw - 1) : 0;
      stations.push({
        center: snoutCenters[i], dir: snoutDirs[i],
        rx: snoutR[i].rx, ry: snoutR[i].ry, halfLen: 0,
        biteY: mouthPre ? snoutCenters[i].y + mouthPre.biteFrac * snoutR[i].ry * 0.5 : undefined,
        cheek: mo > 1 + 1e-9 ? false : fTip >= mo - 1e-9,
        boneA: snout0Idx + Math.max(0, i - 1),
        boneB: snout0Idx + Math.min(i, Math.max(0, nJaw - 2)),
        weightA: i === 0 || i === nJaw - 1 ? 1 : 0.5,
      });
    }
    // The SLIDING mouth-corner ring: mouthOpen lands between joints, so
    // insert an interpolated station exactly at the commissure — both
    // shells get a real ring there and the corner moves continuously
    // instead of snapping per segment.
    if (nJaw > 1 && mo < 1 - 1e-9) {
      const u = (nJaw - 1) * (1 - mo); // joint-space position of the corner
      const i0 = Math.floor(u);
      const ft = u - i0;
      if (ft > 1e-6 && i0 < nJaw - 1) {
        const a = stations[muzzleFrom + i0], b = stations[muzzleFrom + i0 + 1];
        stations.splice(muzzleFrom + i0 + 1, 0, {
          center: add(scale(a.center, 1 - ft), scale(b.center, ft)),
          dir: normalize(add(scale(a.dir, 1 - ft), scale(b.dir, ft))),
          rx: lerp(a.rx, b.rx, ft), ry: lerp(a.ry, b.ry, ft), halfLen: 0,
          biteY: a.biteY !== undefined && b.biteY !== undefined
            ? lerp(a.biteY, b.biteY, ft) : undefined,
          cheek: true, // the corner itself closes the covered zone
          boneA: snout0Idx + i0, boneB: snout0Idx + i0, weightA: 1,
        });
      }
    }
    // Corner behind the root (mouthOpen > 1): every muzzle station is open;
    // the corner rides the jawline toward the hinge (85% of the way at 1.5).
    const mouthCorner = mouthPre && mo > 1 + 1e-9 && nJaw > 0
      ? { z: snoutCenters[0].z - ((mo - 1) / 0.5) * 0.85 * (snoutCenters[0].z - mouthPre.hinge.z) }
      : undefined;
    // The muzzle-root joint blends across the forehead→snout junction.
    if (muzzleFrom < stations.length && muzzleFrom > 0) {
      stations[muzzleFrom].boneA = Math.max(headBoneIdx, snout0Idx - 1);
      stations[muzzleFrom].boneB = snout0Idx;
      stations[muzzleFrom].weightA = 0.5;
    }
    // Axial extents: overlap the neighbor spacing so the union is connected
    // between stations, but stay short of the NEXT station so each ring
    // keeps its own exact cross-section (no bleed fattening the tip).
    for (let i = 0; i < stations.length; i++) {
      const dPrev = i > 0 ? length(sub(stations[i].center, stations[i - 1].center)) : 0;
      const dNext = i < stations.length - 1 ? length(sub(stations[i + 1].center, stations[i].center)) : 0;
      const span = Math.max(dPrev, dNext);
      stations[i].halfLen = Math.max(span * 0.72, Math.min(stations[i].rx, stations[i].ry) * 0.35, 1e-4);
    }
    const cranium: SkullPrim = {
      center: headCenter, dir: braincaseAxis, rx: aW, ry: bH, halfLen: aL,
    };
    // DORSAL RAIL — the profile noses, horns and hats slide along, front to
    // back: the muzzle tops (tip → root), the bridge's own dorsal edge (root
    // → cranium contact), then the cranium arc over the crown to the base of
    // the skull. Every stretch is the SAME curve the surface is built from,
    // and the bridge meets the cranium at a tangency, so the rail has no
    // corner for an add-on to straddle.
    const dorsal: SkullContourPt[] = [];
    const pushPt = (p: Vec3, n: Vec3): void => { dorsal.push({ p, n }); };
    if (stations.length > muzzleFrom) {
      // The rail STARTS at the muzzle's forward POLE — a point on the surface,
      // one station half-length ahead of the tip ring — whose outward normal
      // is the muzzle AXIS, not the tip ring's "up". On a pitched muzzle that
      // up points back over the head, so anything seated at position 0 (the
      // snout tip, where a nose usually goes) grew straight into the skull.
      const tip = stations[stations.length - 1];
      pushPt(add(tip.center, scale(tip.dir, tip.halfLen)), tip.dir);
    }
    for (let i = snoutCenters.length - 1; i >= 0; i--) {
      const up = normalize(cross(snoutDirs[i], faceSide));
      pushPt(add(snoutCenters[i], scale(up, snoutR[i].ry)), up);
    }
    if (bridgeDorsal) {
      const nB = 4;
      for (let k = nB - 1; k >= 1; k--) {
        const t = k / nB;
        const p = bridgeDorsal(t);
        const tan = normalize(sub(bridgeDorsal(Math.min(1, t + 0.05)), bridgeDorsal(Math.max(0, t - 0.05))));
        // Outward normal of a sagittal profile: rotate the tangent a quarter
        // turn about the face axis, pointing away from the skull.
        let n = normalize(cross(tan, faceSide));
        if (dot3(n, sub(p, headCenter)) < 0) n = scale(n, -1);
        pushPt(p, n);
      }
    }
    // Cranium arc from the bridge's contact (the front pole when there is no
    // muzzle) over the crown to the base of the skull.
    const startAng = hasSnout ? bridgeContactAng : 0;
    const endAng = (250 * Math.PI) / 180;
    const nArc = 12;
    for (let k = 0; k <= nArc; k++) {
      const th = startAng + ((endAng - startAng) * k) / nArc;
      pushPt(ellipseAt(th), normalize(v3(0, Math.sin(th) / bH, Math.cos(th) / aL)));
    }
    return { cranium, stations, muzzleFrom, mouthCorner, dorsal };
  })();
  /** Index of the crown on the dorsal rail — its highest point, by
   *  definition — the hinge `nosePosition`/`noseHeight` 1.0 maps to. */
  const crownDorsalIdx = skullGuidePre.dorsal.reduce(
    (best, d, i) => (d.p.y > skullGuidePre.dorsal[best].p.y ? i : best), 0);

  /** Half-thickness of the surface a point sits ON — the guide prim whose
   *  boundary it is nearest. Add-ons are sized against THIS, never against
   *  the head: a nose measured in head radii can be fatter than the snout it
   *  grows out of, which reads as a ball stuck on a stick. */
  const hostRadiusAt = (p: Vec3): number => {
    let best = Infinity;
    let r = skullGuidePre.cranium.ry;
    for (const pr of [skullGuidePre.cranium, ...skullGuidePre.stations]) {
      const U = normalize(cross(pr.dir, faceSide));
      const rel = sub(p, pr.center);
      const q = Math.hypot(rel.x / pr.rx, dot3(rel, U) / pr.ry, dot3(rel, pr.dir) / pr.halfLen);
      if (Math.abs(q - 1) < best) {
        best = Math.abs(q - 1);
        r = Math.min(pr.rx, pr.ry);
      }
    }
    return r;
  };

  // Nose — slides its ROOT along the dorsal contour: 0 = beak tip … 1 =
  // crown … 1.5 = the base of the skull. It rides the real surface and
  // protrudes along the LOCAL outward normal, bending by noseDroop.
  {
    const dorsal = skullGuidePre.dorsal;
    const noseLen = g.head.noseLengthFrac * headR;
    if (noseLen > 1e-4 && dorsal.length >= 2) {
      const nNose = Math.max(1, Math.round(g.head.noseSegments));
      const h = Math.max(0, Math.min(1.5, g.head.nosePosition));
      const u = h <= 1
        ? h * crownDorsalIdx
        : crownDorsalIdx + ((h - 1) / 0.5) * (dorsal.length - 1 - crownDorsalIdx);
      const i0 = Math.max(0, Math.min(dorsal.length - 2, Math.floor(u)));
      const ft = u - i0;
      const railP = add(scale(dorsal[i0].p, 1 - ft), scale(dorsal[i0 + 1].p, ft));
      const protrude = normalize(add(scale(dorsal[i0].n, 1 - ft), scale(dorsal[i0 + 1].n, ft)));
      // Seat the root on the REAL surface. The rail is sampled from the guide,
      // but a neighbouring station's ellipsoid can still swallow the sample
      // when the stations are unevenly spaced — a stub muzzle on a long
      // bridge inherits the bridge's spacing and reaches past the whole
      // muzzle. Casting out along the protrusion puts the root where the
      // surface actually is, so a nose can never start inside the head.
      const exit = skullRaycast(skullGuidePre, railP, protrude);
      const root = exit ? add(railP, scale(protrude, exit.t)) : railP;
      // Sized against its HOST, so it always reads as part of that surface.
      const noseR = Math.max(1e-4, g.head.noseRadiusFrac * hostRadiusAt(root));
      const tipFracN = Math.max(0, Math.min(1, g.head.noseTaper));
      // Droop is a FRACTION of what the nose's own length can carry — the
      // same turn-vs-length law the muzzle obeys — and it accumulates from
      // ZERO at the root. The old form applied 0.3 of it immediately, which
      // TILTED the nose off its seat rather than bending it, and at a large
      // value curled the first segment straight back into the face.
      const noseSegLen = noseLen / nNose;
      const noseBudget = (0.9 * noseSegLen) / noseR;
      const DROOP_FULL = 1.5; // noseDroop's own range, radians
      const droopTotal = (g.head.noseDroop / DROOP_FULL)
        * Math.min(DROOP_FULL, noseBudget * nNose);
      let prevN = root;
      for (let i = 0; i < nNose; i++) {
        const f0 = i / nNose, f1 = (i + 1) / nNose;
        // Bend at the segment's MIDPOINT, so the chain integrates the curve.
        const dir = normalize(rotate(protrude, faceSide, droopTotal * (f0 + f1) * 0.5));
        const next = add(prevN, scale(dir, noseSegLen));
        bones.push({
          id: `nose${i}`, parent: i === 0 ? headBoneIdx : bones.length - 1,
          kind: "head", chain: "nose",
          head: prevN, tail: next,
          radiusHead: noseR * lerp(1, tipFracN, f0),
          radiusTail: noseR * lerp(1, tipFracN, f1),
          flatten: 0, aspect: g.head.noseFlatten,
        });
        prevN = next;
      }
    }
  }

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
  //
  // ⚖️ DIGIT LENGTH IS TIED TO THE LIMB, NOT ONLY TO THE FOOT. `toeLengthFrac`
  // measures a digit against the FOOT, which says nothing about how THICK the
  // limb is — so the same human toe fraction carried onto a bear-thick leg
  // (exactly what `bipedalize` does: posture from the template, girth kept from
  // the animal) produced a toe shorter than the ball it sprouts from, i.e. a
  // bump buried in the ankle. Every digit therefore also clears its own ball
  // and runs `DIGIT_MIN_ASPECT` of its own thickness beyond it; whichever of
  // the two lengths is longer wins, so a slender hoof or a long claw authored
  // through `toeLengthFrac` is untouched and only the buried cases grow.
  // Because the digit's own radius is 1/n of the foot, the floor is
  // count-aware for free: a lone hoof has to run far to clear the ball it IS,
  // five toes barely have to.
  const addDigits = (o: {
    ball: Vec3;
    fwd: Vec3;
    parentIdx: number;
    chain: string;
    limb: ResolvedLimb;
    sideSign: 1 | -1;
    grounded: boolean;
    /** Curl override (a gripping hand); defaults to the blueprint's toeCurl. */
    curl?: number;
  }): void => {
    const baseR = o.limb.radiusFrac * maxR;
    const tipR = baseR * o.limb.taper;
    const ballR = tipR * 1.05;
    const legLen = o.limb.lengthFrac * L;
    const footLen = o.limb.footLengthFrac * legLen;
    const span = footLen > 1e-6 ? footLen : legLen * 0.18;
    const n = Math.max(1, Math.round(o.limb.toeCount));
    const curl = o.curl ?? o.limb.toeCurl;
    // ⚖️ A DIGIT IS A SPLIT IN THE FOOT. The whole row spans the foot, so each
    // digit takes 1/n of it: one digit is the full width (a hoof), two are half
    // each, five are a fifth each. (It used to be `1.15/√n`, which claimed to
    // match the tip girth but didn't — at five digits the row came out 2.6× the
    // foot's width, so the digits overlapped into one blob instead of reading
    // as toes.)
    const rBase = ballR / n;
    // ⚠️ THE FOOT IS NOT AS WIDE AS ITS BONE RADIUS. A sole lofts FLATTENED, so
    // its half-width is `ballR * halfWidthFactor(FOOT_FLATTEN)` — 1.56x the bone
    // radius — while a `flatten: 0` digit lofts at exactly its radius. Splitting
    // the BONE radius therefore laid a row only 1/1.56 of the sole across it:
    // toes too thin, too close together, on a foot they were meant to tile. The
    // digits take the sole's own flatten (a toe is wider than tall too), which
    // makes their WIDTHS tile for free, and the root spread below is widened by
    // the same factor.
    const ballFlatten = footLen > 1e-6 ? FOOT_FLATTEN : o.limb.membrane;
    const widen = halfWidthFactor(ballFlatten);
    // Across-the-foot axis. `cross(Y, fwd)` IS the derivative of
    // `rotate(fwd, Y, ang)` at ang=0, so a digit's root and its splay lean the
    // same way. A hand hanging straight down has no horizontal `fwd` to take a
    // side from (its digits get no angular splay either, and hang parallel like
    // fingers on a palm) — fall back to the body's lateral axis so the row
    // still lies ACROSS the palm instead of collapsing onto one point.
    const sideRaw = cross(Y_AXIS, o.fwd);
    const sideAxis = length(sideRaw) > 1e-3 ? normalize(sideRaw) : X_AXIS;
    for (let k = 0; k < n; k++) {
      const t = n > 1 ? k / (n - 1) : 0.5; // 0..1 across the row
      const mult = 1 - o.limb.toeContrast * (Math.abs(t - 0.5) / 0.5);
      const isThumb = k === n - 1 && n >= 2 && o.limb.opposition > 0.05;
      let ang = n > 1 ? (t - 0.5) * o.limb.toeSpread : 0;
      if (isThumb) ang -= o.sideSign * o.limb.opposition * 1.6; // swing back/in
      const dir = rotate(o.fwd, Y_AXIS, ang);
      // ...and the split is a split in POSITION too: the row of roots TILES the
      // sole's width rather than every digit sprouting from its centre. Slot
      // centres run from -(ballR - rBase) to +(ballR - rBase), scaled by the
      // sole's `widen`, so the outer digits' outer edges land on its rim.
      // Rooting them all at one point left a wide foot ending in a narrow
      // tassel; this is what makes four toes read as a foot SPLIT four ways.
      // mesh.ts then cuts each digit's BASE RING out of the sole's end polygon
      // at this slot, so the toes join the foot instead of sitting on it.
      const root =
        n > 1
          ? add(o.ball, scale(sideAxis, (t - 0.5) * 2 * (ballR - rBase) * widen))
          : o.ball;
      // The digit still runs FORWARD out of the ball, so a length under `ballR`
      // is swallowed by it whatever the lateral offset. Both terms shrink with
      // `mult`, so the outer-digit contrast survives the floor.
      const minLen = (ballR + rBase * DIGIT_MIN_ASPECT) * mult;
      const dlen =
        Math.max(o.limb.toeLengthFrac * span * mult, minLen) * (isThumb ? 0.8 : 1);
      const dr = Math.max(rBase * mult, 1e-4);
      const tipDr = dr * 0.55;
      const name = `${o.chain}d${k}`;
      let tail: Vec3;
      if (o.grounded) {
        // On the ground; curl digs the tip down and shortens the run
        // (claws); an opposed thumb lifts off the ground.
        const run = dlen * (1 - 0.45 * curl);
        const y = isThumb ? root.y + dlen * 0.4 : tipDr * 0.85 - curl * tipDr * 0.6;
        tail = v3(root.x + dir.x * run, Math.max(y, tipDr * 0.2), root.z + dir.z * run);
      } else {
        // Hanging hand: curl down-forward; the thumb opposes inward.
        const drop = dlen * (0.4 + 0.5 * curl);
        tail = v3(root.x + dir.x * dlen, root.y - drop, root.z + dir.z * dlen);
      }
      bones.push({
        id: name,
        parent: o.parentIdx,
        kind: "limb",
        chain: name,
        head: root,
        tail,
        radiusHead: dr,
        radiusTail: tipDr,
        flatten: ballFlatten,
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
          flatten: FOOT_FLATTEN,
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
  const footAim = (leg: PendingLeg, protraction = leg.limb.restProtraction): Vec3 =>
    normalize(rotate(leg.outDir, Y_AXIS, -leg.sideSign * protraction * PROTRACT_MAX));

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

  // Whole-body balance: gather the support feet into a polygon and shift
  // the body horizontally so the CoM rides over it — the creature leaning
  // over its feet when the stance is asymmetric (a biped, a sprawl). The
  // polygon is every RECRUITED foot at its REST plant, deliberately
  // ignoring the gait's instantaneous stance/swing state: re-balancing
  // over whichever subset happens to be planted made the body lurch fore/
  // aft and side to side every step, where a real walker carries the
  // transient imbalance with momentum. The dynamic part is the constant
  // forward lean below (leanZ), which grows as the gait commits to flight.
  const supportFeet: Pt[] = [];
  for (const leg of pendingLegs) {
    if (!grounded.get(leg)) continue;
    const foot = footAt.get(leg);
    if (foot) supportFeet.push({ x: foot.x, z: foot.z });
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
      // easing to body-forward when tucked under. Taken ENTIRELY in the
      // unshifted rest frame — the rest plant against the UNSHIFTED hip —
      // so neither the stride nor the body's balance sway twists a planted
      // foot; mixing the shifted hip with the unshifted plant used to
      // splay feet outward at the start of each stride.
      const horizOff = v3(plant.x - leg.hip.x, 0, plant.z - leg.hip.z);
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
      // The ARCH — how far the knee is carried OUT and UP. Fore/aft is added
      // below, in the perpendicular plane, not here.
      let pole = normalize(v3(
        leg.outDir.x * (w1 * 0.9 + w2 * 0.5),
        w0 * 0.1 + w1 * 0.45 + w2 * 1.2,
        leg.outDir.z * (w1 * 0.9 + w2 * 0.5),
      ));
      // Mirror the twist by side so L/R pronate symmetrically (a +legTwist
      // curls both claws inward, not one in and one out).
      const gTwist = leg.sideSign * leg.limb.legTwist;
      if (Math.abs(gTwist) > 1e-4) pole = rotate(pole, dirN, gTwist);
      // The knee can only sit in the plane ⊥ hip→ankle, so everything that
      // aims it has to be expressed THERE.
      const perpOf = (v: Vec3): Vec3 => {
        const d = v.x * dirN.x + v.y * dirN.y + v.z * dirN.z;
        return v3(v.x - dirN.x * d, v.y - dirN.y * d, v.z - dirN.z * d);
      };
      const arch = perpOf(pole);
      // ⚖️ THE FOLD IS TAKEN IN THAT PLANE, NOT BEFORE IT. Mixing `restFlexion`
      // into a world-space pole and projecting afterwards let the projection
      // strip out more fore/aft than the fold put in — so the knee could point
      // the OPPOSITE way from the dial, silently, and the smaller the fold the
      // likelier it was. Splitting the plane into a fore/aft axis and an arch
      // axis makes the sign of `restFlexion` the knee's direction BY
      // CONSTRUCTION. (Bilateral only: "fore/aft" is the axis the dial names,
      // and a RADIAL spoke — an octopus arm — has no fore/aft of its own, so it
      // keeps arching along its own azimuth.)
      const fwdRaw = leg.limb.placement === "bilateral" ? perpOf(v3(0, 0, 1)) : v3(0, 0, 0);
      const bend = Math.max(-1, Math.min(1, leg.limb.restFlexion * (w0 + w1 * 0.4)));
      let perp: Vec3;
      if (length(fwdRaw) > 1e-6) {
        const fwdPerp = normalize(fwdRaw);
        const ad = arch.x * fwdPerp.x + arch.y * fwdPerp.y + arch.z * fwdPerp.z;
        const side = v3(arch.x - fwdPerp.x * ad, arch.y - fwdPerp.y * ad, arch.z - fwdPerp.z * ad);
        const mixed = length(side) > 1e-6
          ? add(scale(normalize(side), 1 - Math.abs(bend)), scale(fwdPerp, bend))
          : scale(fwdPerp, bend >= 0 ? 1 : -1);
        perp = length(mixed) > 1e-6 ? normalize(mixed) : fwdPerp;
      } else {
        perp = length(arch) > 1e-6 ? normalize(arch) : normalize(v3(0, -dirN.z, dirN.y));
      }
      const knee = add(add(hip, scale(dirN, a)), scale(perp, h));
      placeChain(leg.firstBone, hip, knee, ankle);

      const ball = v3(px, ballY, pz);
      if (leg.footBone >= 0) {
        bones[leg.footBone].head = ankle;
        bones[leg.footBone].tail = ball;
      }
      const parentIdx = leg.footBone >= 0 ? leg.footBone : leg.firstBone + LEG_SEGS - 1;
      addDigits({ ball, fwd, parentIdx, chain: leg.chain, limb: leg.limb, sideSign: leg.sideSign, grounded: cyc.planted });
    } else if (pose?.limbTargets?.some((o) =>
      o.group === leg.limb.group && o.index === leg.limb.index && o.side === leg.sideSign,
    )) {
      // REACHING — an un-recruited limb steered to an explicit target (a
      // hand toward an object). 2-bone IK hip→wrist along the reach line;
      // the foot section (the palm) spans wrist→target and the digits curl
      // by `grip`. The elbow points DOWN for a forward reach and eases BACK
      // for a near-vertical one (both human-natural), blended continuously
      // so a moving target never pops the elbow.
      const ov = pose.limbTargets.find((o) =>
        o.group === leg.limb.group && o.index === leg.limb.index && o.side === leg.sideSign,
      )!;
      const totalReach = l1 + l2 + s.footLen;
      const toT = v3(ov.target.x - hip.x, ov.target.y - hip.y, ov.target.z - hip.z);
      const rawD = length(toT);
      const dirT = rawD > 1e-6 ? scale(toT, 1 / rawD) : v3(0, -1, 0);
      const d = Math.min(rawD, totalReach * 0.98);
      const ball = add(hip, scale(dirT, d));
      const ankle = add(hip, scale(dirT, Math.max(d - s.footLen, (l1 + l2) * 0.2)));

      // Elbow pole: gravity's component ⊥ the reach line, easing to
      // "elbow back" (-Z) when reaching straight down/up.
      const gPerp = v3(dirT.x * dirT.y, dirT.y * dirT.y - 1, dirT.z * dirT.y);
      const bPerp = v3(-dirT.x * -dirT.z, -dirT.y * -dirT.z, dirT.z * dirT.z - 1);
      const gLen = length(gPerp);
      const w = Math.max(0, Math.min(1, (gLen - 0.05) / 0.25));
      let pole = add(scale(gLen > 1e-6 ? scale(gPerp, 1 / gLen) : v3(0, 0, -1), w),
        scale(length(bPerp) > 1e-6 ? normalize(bPerp) : v3(0, 0, -1), 1 - w));
      pole = length(pole) > 1e-6 ? normalize(pole) : v3(0, 0, -1);

      const dx2 = ankle.x - hip.x, dy2 = ankle.y - hip.y, dz2 = ankle.z - hip.z;
      let dist = Math.max((l1 + l2) * 0.05, Math.min(Math.hypot(dx2, dy2, dz2), (l1 + l2) * 0.999));
      const a2 = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
      const h2 = Math.sqrt(Math.max(l1 * l1 - a2 * a2, 0));
      const dirN = dist > 1e-9 ? v3(dx2 / dist, dy2 / dist, dz2 / dist) : v3(0, -1, 0);
      const pd = pole.x * dirN.x + pole.y * dirN.y + pole.z * dirN.z;
      let perp = v3(pole.x - dirN.x * pd, pole.y - dirN.y * pd, pole.z - dirN.z * pd);
      perp = length(perp) > 1e-6 ? normalize(perp) : normalize(v3(0, -dirN.z, dirN.y));
      const knee = add(add(hip, scale(dirN, a2)), scale(perp, h2));
      placeChain(leg.firstBone, hip, knee, ankle);

      if (leg.footBone >= 0) {
        bones[leg.footBone].head = ankle;
        bones[leg.footBone].tail = ball;
      }
      const parentIdx = leg.footBone >= 0 ? leg.footBone : leg.firstBone + LEG_SEGS - 1;
      addDigits({ ball, fwd: dirT, parentIdx, chain: leg.chain, limb: leg.limb, sideSign: leg.sideSign, grounded: false, curl: ov.grip });
    } else {
      // UN-RECRUITED — hold the neutral three angles by forward kinematics.
      // Femur aimed by protraction (fore/aft swing of `outDir`) + levation
      // (elevation from straight-down); tibia folded by flexion in the limb's
      // vertical plane; foot pitched on by `stance`.
      // A hanging (depressed) arm counter-swings with the gait: the whole
      // limb pitches fore/aft (a pendulum from the shoulder) at the leg
      // phase its (station, side) would give it, which lands hanging
      // forelimbs in antiphase with their same-side leg — the walker's arm
      // swing — from the same pattern machinery as the feet. `armSwing` is
      // the pitch amplitude in radians.
      let swing = 0;
      if (gait && pose?.armSwing && leg.limb.placement === "bilateral" &&
        leg.limb.restLevation <= -0.2 && isLeggy(leg)) {
        const off = legPhaseOffset({ stationFrac: leg.limb.station, side: leg.sideSign }, gait.pattern);
        swing = pose.armSwing * Math.sin((gait.phase + off) * Math.PI * 2);
      }
      const hAim = footAim(leg); // horizontal aim, swung by protraction
      const e = levationElevation(leg.limb.restLevation);
      let femurDir = normalize(v3(hAim.x * Math.sin(e), -Math.cos(e), hAim.z * Math.sin(e)));
      // Pendulum arm swing: pitch the whole limb fore/aft about the hip
      // (positive swing carries the hand forward, +Z).
      if (Math.abs(swing) > 1e-4) femurDir = rotate(femurDir, X_AXIS, -swing);
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
    const headFwd = braincaseAxis;
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
        // Full body shift (lift + bob + balance lean), not just the lift —
        // body-attached chains must ride with the shifted trunk.
        const center = add(stationPoint(ch.station), bodyShift);
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

  // 8) Rigid details — eyes seated on the skull's ellipsoid surface.
  //    Positions must be computed AFTER the lift (head bone already
  //    shifted): full body shift (lift + bob + balance lean), matching
  //    the shifted head bone — otherwise the eyes detach when the gait
  //    leans. The snout/muzzle is real loft bones now (step 4), so the
  //    only rigid head details left are the eyeballs.
  const liftedHeadCenter = add(headCenter, bodyShift);
  // The mouth in the shifted frame (only the hinge POINT shifts; axis / up /
  // forward are directions). The muzzle loft splits its lower arc about this.
  const mouth: MouthSpec | undefined = mouthPre ? {
    hinge: add(mouthPre.hinge, bodyShift),
    axis: mouthPre.axis,
    gapeAngle: mouthPre.gapeAngle,
    jawBone: mouthPre.jawBone,
    headBone: headBoneIdx,
    biteFrac: mouthPre.biteFrac,
  } : undefined;
  // The skull guide in the shifted frame (points move, directions don't).
  const skull: SkullGuide = {
    cranium: { ...skullGuidePre.cranium, center: add(skullGuidePre.cranium.center, bodyShift) },
    stations: skullGuidePre.stations.map((st) => ({
      ...st,
      center: add(st.center, bodyShift),
      biteY: st.biteY === undefined ? undefined : st.biteY + bodyShift.y,
    })),
    muzzleFrom: skullGuidePre.muzzleFrom,
    mouthCorner: skullGuidePre.mouthCorner
      ? { z: skullGuidePre.mouthCorner.z + bodyShift.z }
      : undefined,
    dorsal: skullGuidePre.dorsal.map((dp) => ({ p: add(dp.p, bodyShift), n: dp.n })),
  };
  {
    const eyeR = g.head.eyeSizeFrac * headR;
    // Seat the orbits on the BRAINCASE ellipsoid (not the muzzle) — the
    // half-axes are the real skull dimensions, so an eye never sinks into a
    // long snout or floats off a flat face. `eyeAngle` is the convergence
    // (frontal↔lateral), `eyeHeight` the elevation, `eyeBulge` how proud the
    // globe sits.
    const aW = headR * g.head.crossSection;      // width half-axis
    const bH = headR * g.head.braincaseDome;     // height half-axis
    const cL = aL;                               // length half-axis
    for (let p = 0; p < g.head.eyePairs; p++) {
      for (const side of [-1, 1] as const) {
        const az = g.head.eyeAngle;
        const el = g.head.eyeHeight + p * 0.5;
        // Direction cosines in the (side, up, forward) = (X, Y, Z) frame.
        const ns = side * Math.sin(az) * Math.cos(el);
        const nu = Math.sin(el);
        const nf = Math.cos(az) * Math.cos(el);
        const outward = normalize(v3(ns, nu, nf));
        // Seat on the REAL fused surface (the guide union) — a brow or
        // muzzle bulging past the bare cranium must not bury the globe;
        // fall back to the cranium ellipsoid if the ray somehow misses.
        const rc = skullRaycast(skull, liftedHeadCenter, outward);
        const t = rc ? rc.t
          : 1 / Math.sqrt((ns / aW) ** 2 + (nu / bH) ** 2 + (nf / cL) ** 2 + 1e-9);
        const surf = add(liftedHeadCenter, scale(outward, t));
        // eyeBulge 0 = globe flush in the socket; 1 = a proud frog dome.
        const pos = add(surf, scale(outward, eyeR * (0.5 * g.head.eyeBulge - 0.1)));
        details.push({
          kind: "eye",
          bone: headBoneIdx,
          position: pos,
          direction: outward,
          radius: eyeR,
          lengthM: 0,
          hardness: 1,
        });
      }
    }
  }

  // Skull landmarks + frame (post-lift) for the soft-tissue / appendage
  // layers. The braincase axis / side / up are world-aligned directions
  // (unaffected by the lift); the points shift with the body.
  const head: HeadLandmarks = {
    center: liftedHeadCenter,
    rostrumBase: add(redDot, bodyShift),
    rostrumTip: add(rostrumTip, bodyShift),
    crown: add(add(headCenter, scale(faceUp, domeHalf)), bodyShift),
    chin: mouthPre ? add(bones[mouthPre.jawBone].tail, bodyShift) : add(rostrumTip, bodyShift),
    braincaseAxis,
    rostrumAxis: rostrumDir0,
    side: faceSide,
    up: faceUp,
    radius: headR,
    halfLen: aL,
    domeHalf,
  };

  // 8.5) Dermal growths & plants — the branching/spiral grammar
  //      (growth.ts). Post-lift like chains, but pure GEOMETRY welded to
  //      one bone (head bears horns, a torso station bears a plant stem):
  //      no new bones, so bone counts stay flat and horns ride the head
  //      rigidly. One structure is generated per growth blueprint (cached —
  //      the lab rebuilds every animated frame) in a local frame with
  //      +Y = the attach normal, then transformed per instance; the L
  //      copy of a bilateral pair uses a REFLECTED basis, which flips the
  //      spiral chirality — paired ram horns mirror properly.
  const growths: GrowthInstance[] = [];
  const growthBlueprints = g.growths ?? [];
  if (growthBlueprints.length > 0) {
    // Every instance costs geometry, so the shared segment budget divides
    // across the total instance count (deterministic — LOD prefixes stay
    // aligned across rebuilds).
    const totalInstances = growthBlueprints.reduce((s, gr) => s + Math.max(1, Math.round(gr.count)), 0);
    const totalBudget = Math.min(growthBudget ?? MAX_GROWTH_SEGMENTS, MAX_GROWTH_SEGMENTS);
    const budget = Math.max(2, Math.floor(totalBudget / Math.max(1, totalInstances)));

    const headFwd = braincaseAxis;
    const headSide = length(cross(Y_AXIS, headFwd)) > 1e-6
      ? normalize(cross(Y_AXIS, headFwd)) : X_AXIS;
    const bSide = length(cross(Y_AXIS, axis)) > 1e-6
      ? normalize(cross(Y_AXIS, axis)) : X_AXIS;
    const bUp = normalize(cross(axis, bSide));
    const reflectX = (v: Vec3): Vec3 => v3(-v.x, v.y, v.z);

    // A head growth's `station` slides its socket along the skull's
    // sagittal profile — 0 = the snout tip … 0.5 = the cranium center …
    // 1 = toward the base of the skull — and phi sweeps around that
    // station. The socket seats on the REAL surface (ray-cast against the
    // skull guide union), so horns follow the contour of the whole skull:
    // beak, snout, forehead, cranium.
    const frontRail: Vec3[] = skull.stations.length > 0
      ? [skull.cranium.center, ...skull.stations.map((s) => s.center)]
      : [skull.cranium.center, add(skull.cranium.center, scale(braincaseAxis, aL * 0.9))];
    const railLens: number[] = [0];
    for (let i = 1; i < frontRail.length; i++) {
      railLens.push(railLens[i - 1] + length(sub(frontRail[i], frontRail[i - 1])));
    }
    const railTotal = railLens[railLens.length - 1] || 1;
    const headSeatAt = (st: number): { p: Vec3; tan: Vec3 } => {
      const s = Math.max(0, Math.min(1, st));
      if (s >= 0.5) {
        // Rear half: straight back along the braincase axis to the occiput.
        const u = (s - 0.5) / 0.5;
        return {
          p: add(skull.cranium.center, scale(braincaseAxis, -aL * 0.9 * u)),
          tan: braincaseAxis,
        };
      }
      // Front half: walk the center → tip rail by arc length (tip at 0).
      const want = (1 - s / 0.5) * railTotal;
      for (let i = 1; i < frontRail.length; i++) {
        if (railLens[i] >= want - 1e-9) {
          const span = railLens[i] - railLens[i - 1];
          const f = span > 1e-9 ? (want - railLens[i - 1]) / span : 0;
          return {
            p: add(scale(frontRail[i - 1], 1 - f), scale(frontRail[i], f)),
            tan: normalize(sub(frontRail[i], frontRail[i - 1])),
          };
        }
      }
      return { p: frontRail[frontRail.length - 1], tan: braincaseAxis };
    };

    for (const gr of growthBlueprints) {
      const structure = cachedGrowthStructure(gr, L, budget);
      // Empty only if nothing at all was produced. A fruit/root growth has
      // NO stem segments (just a fruit body + crown), so don't gate on
      // segments alone.
      if (structure.segments.length === 0 && structure.fruits.length === 0) continue;

      // Frame pieces for this attach point: center, radii, and the local
      // side/up/fwd axes the phi angle sweeps through.
      const onHead = gr.attach === "head";
      const seat = onHead ? headSeatAt(gr.station) : null;
      const center = seat ? seat.p : add(stationPoint(gr.station), bodyShift);
      const sideAxis = onHead ? headSide : bSide;
      const fwdAxis = seat ? seat.tan : axis;
      const upAxis = seat ? normalize(cross(fwdAxis, sideAxis)) : bUp;
      const rLat = torsoRadiusAt(g, gr.station) * csW;
      const rVert = torsoRadiusAt(g, gr.station) * csH;
      const bone = onHead ? headBoneIdx : torsoBoneAt(gr.station);
      const phiAng = gr.phi * Math.PI; // 0 ventral .. π dorsal (limb convention)

      // Resolve instances as orthonormal bases {root, side, up, fwd}. The
      // structure's +Y maps onto `up` (the outward surface normal at the
      // socket), +Z onto `fwd` (what stem.lean tilts toward).
      interface GrowthBasis { root: Vec3; side: Vec3; up: Vec3; fwd: Vec3 }
      const bases: GrowthBasis[] = [];
      const makeBasis = (outDir: Vec3, splay: number, splayRef: Vec3): GrowthBasis => {
        const out = normalize(outDir);
        let root: Vec3;
        let up: Vec3;
        if (onHead) {
          // Seat on the real skull surface; the socket's up is the local
          // surface NORMAL, so the growth stands off the actual contour.
          const rc = skullRaycast(skull, center, out);
          root = add(center, scale(out, (rc ? rc.t : headR) * 0.94));
          up = rc ? rc.n : out;
        } else {
          root = add(center, v3(
            out.x * rLat * 0.92,
            out.y * rVert * 0.92,
            out.z * rLat * 0.92,
          ));
          up = out;
        }
        if (splay !== 0) up = normalize(rotate(up, splayRef, splay));
        const fwd0 = add(fwdAxis, scale(up, -dot3(fwdAxis, up)));
        const fwd = length(fwd0) > 1e-6 ? normalize(fwd0) : normalize(cross(up, sideAxis));
        const side = normalize(cross(up, fwd));
        return { root, side, up, fwd };
      };

      const count = Math.max(1, Math.round(gr.count));
      if (gr.placement === "radial") {
        // Spokes around the fwd axis (a crown of spikes / anemone column),
        // starting from the phi angle; spread tilts each spoke toward fwd.
        for (let k = 0; k < count; k++) {
          const a = phiAng + (k / count) * Math.PI * 2;
          const outDir = normalize(add(scale(sideAxis, Math.sin(a)), scale(upAxis, -Math.cos(a))));
          const basis = makeBasis(outDir, 0, fwdAxis);
          if (gr.spread !== 0) {
            const tiltAxis = normalize(cross(basis.up, basis.fwd));
            basis.up = normalize(rotate(basis.up, tiltAxis, gr.spread));
            basis.side = normalize(cross(basis.up, basis.fwd));
          }
          bases.push(basis);
        }
      } else {
        // Bilateral, the chains convention: odd count = one midline copy
        // plus mirrored pairs; spread splays the pairs apart around fwd.
        const pairs = Math.floor(count / 2);
        if (count % 2 === 1) {
          // Midline copy: only the vertical component of phi (a lateral
          // phi ≈ 0.5 has no midline direction — fall back to dorsal).
          const vert = -Math.cos(phiAng);
          const outDir = Math.abs(vert) > 1e-3 ? scale(upAxis, Math.sign(vert)) : upAxis;
          bases.push(makeBasis(outDir, 0, fwdAxis));
        }
        for (let p = 1; p <= pairs; p++) {
          const outDir = normalize(add(scale(sideAxis, Math.sin(phiAng)), scale(upAxis, -Math.cos(phiAng))));
          const right = makeBasis(outDir, gr.spread * (p / pairs), fwdAxis);
          bases.push(right);
          // The L copy is the mirror image: reflect the whole basis across
          // the creature midplane (an improper rotation — chirality flips).
          bases.push({
            root: reflectX(right.root),
            side: reflectX(right.side),
            up: reflectX(right.up),
            fwd: reflectX(right.fwd),
          });
        }
      }

      for (const basis of bases) {
        const place = (p: { x: number; y: number; z: number }): Vec3 => add(basis.root, v3(
          basis.side.x * p.x + basis.up.x * p.y + basis.fwd.x * p.z,
          basis.side.y * p.x + basis.up.y * p.y + basis.fwd.y * p.z,
          basis.side.z * p.x + basis.up.z * p.y + basis.fwd.z * p.z,
        ));
        const orient = (p: { x: number; y: number; z: number }): Vec3 => v3(
          basis.side.x * p.x + basis.up.x * p.y + basis.fwd.x * p.z,
          basis.side.y * p.x + basis.up.y * p.y + basis.fwd.y * p.z,
          basis.side.z * p.x + basis.up.z * p.y + basis.fwd.z * p.z,
        );
        growths.push({
          blueprint: gr,
          bone,
          segments: structure.segments.map((s) => ({
            ...s, a: place(s.a), b: place(s.b),
          })),
          leaves: structure.leaves.map((lf) => ({
            ...lf, pos: place(lf.pos), dir: orient(lf.dir), normal: orient(lf.normal),
          })),
          fruits: structure.fruits.map((fr) => ({
            ...fr,
            rings: fr.rings.map((r) => ({ ...r, center: place(r.center) })),
            axis: orient(fr.axis),
          })),
        });
      }
    }
  }

  // 9) Bounds over bone points (skin adds radii; consumers wanting the
  //    skin AABB should pad by max radius). Growth geometry folds in too
  //    — a tree is FAR taller than its body nub, and the lab frames the
  //    camera from these bounds.
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  const fold = (p: Vec3, r: number): void => {
    min.x = Math.min(min.x, p.x - r); min.y = Math.min(min.y, p.y - r); min.z = Math.min(min.z, p.z - r);
    max.x = Math.max(max.x, p.x + r); max.y = Math.max(max.y, p.y + r); max.z = Math.max(max.z, p.z + r);
  };
  for (const b of bones) {
    fold(b.head, 0);
    fold(b.tail, 0);
  }
  for (const gw of growths) {
    for (const s of gw.segments) {
      fold(s.a, s.radiusA);
      fold(s.b, s.radiusB);
    }
    for (const lf of gw.leaves) fold(lf.pos, lf.lengthM);
    for (const fr of gw.fruits) for (const r of fr.rings) fold(r.center, r.radius);
  }

  return { bones, details, membranes, growths, mouth, head, skull, maxTorsoRadius: maxR, bounds: { min, max } };
}

// ── Growth structure cache ───────────────────────────────────────────────
// generateGrowth is a pure function of (blueprint entry, torso length,
// budget), and the lab rebuilds the whole skeleton every animated frame —
// so structures are memoized here and only the cheap per-instance
// transform reruns. Small FIFO; keys are exact JSON.

const GROWTH_CACHE = new Map<string, GrowthStructure>();

function cachedGrowthStructure(gr: GrowthBlueprint, torsoLengthM: number, budget: number): GrowthStructure {
  const key = `${torsoLengthM}|${budget}|${JSON.stringify(gr)}`;
  let s = GROWTH_CACHE.get(key);
  if (!s) {
    s = generateGrowth(gr, torsoLengthM, budget);
    if (GROWTH_CACHE.size >= 32) {
      const first = GROWTH_CACHE.keys().next().value;
      if (first !== undefined) GROWTH_CACHE.delete(first);
    }
    GROWTH_CACHE.set(key, s);
  }
  return s;
}
