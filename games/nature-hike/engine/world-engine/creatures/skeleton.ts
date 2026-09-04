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
import { balanceShift, convexHull2D, supportMargin, type Pt } from "./balance";
import {
  bendCapacity,
  boneFraction,
  cantileverStress,
  combinedCoM,
  contactStrength,
  emaDetail,
  legCapacity,
  legStrength,
  loadMassTotal,
  massProperties,
  solveFootForces,
  stress as stressOf,
  type CarriedLoad,
  type EnvPhysics,
  type LegCapacity,
} from "./physio";
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
/** 🚨 THE DIGIT LENGTH FLOOR IS GONE — IT MIGRATED TO THE PAD.
 *
 *  `addDigits` used to floor a digit's length against the BALL it sprouts
 *  from (`ballR + ballR/n × 1.5`), on the reasoning that a digit shorter than
 *  its own ball is a bump, not a toe. The reasoning was right and the cure was
 *  in the wrong place: the ball is a function of LIMB GIRTH, so the floor made
 *  `toeLengthFrac` inert on exactly the bodies whose toes anyone would want to
 *  dial — the cow's hoof was drawn at ×3.0 its authored length and the
 *  elephant's toes at ×2.5 (40 cm toes on a foot 25 cm long), and the dial
 *  "didn't seem to do anything" because on a thick limb it genuinely didn't.
 *
 *  ⚖️ A THICK LIMB DEMANDS A WIDE PAD, NOT LONG TOES. What actually keeps a
 *  fat-legged animal's foot from ending in a tassel of stubs is the fat filling
 *  the ankle — `padFrac`. So the floor is now a floor on the PAD (`padR` in
 *  `legStaticsOf`), `toeLengthFrac` is a live dial with nothing between it and
 *  the drawn toe, and an elephant's toes derive SHORT: nails on the pad's face,
 *  which is what an elephant has. */
/** Ankle rest pitch at `stance` 1, radians. THE UNGULIGRADE END OF THE DIAL.
 *  It used to be 1.3 (74.5°), which is a foot still slanting forward a sixth of
 *  its own length — and on the horse that slant WAS the whole posture cost: a
 *  7.1 cm knee-to-contact moment arm against a 6.5 cm muscle arm, ema 2.08, σ
 *  1.06. A real unguligrade column stands its metapodial vertical and its toes
 *  in line with it, which is the half of `stance` that was missing. */
const STANCE_PITCH_MAX = 1.45;
/** Hard ceiling on the ankle's SOLVED pitch (`ankleRange` opens the band
 *  between rest and this). 83° — a foot may stand as a column, never past its
 *  own joint.
 *
 *  🚨 DELIBERATELY THE SAME NUMBER as `STANCE_PITCH_MAX`, and deliberately the
 *  value it already had. Raising it by 0.08 to leave the new stance endpoint
 *  some headroom raised every body's maximum standing height by a hair, and the
 *  human — whose knee sits a centimetre from its own sole's centre of pressure
 *  — answered by going from σ 1.06 to 1.25 on a round that had no business
 *  touching a plantigrade foot. Stance 1 simply IS the ceiling: an unguligrade
 *  foot has no pitch left to give, so `ankleRange` correctly buys it nothing. */
const ANKLE_PITCH_CAP = 1.45;
/** Where on the `stance` dial the toes stop hinging at the ball and start
 *  ALIGNING with the foot's line. Below it a toe lies flat and the sole/ball
 *  meets the ground (plantigrade → digitigrade, unchanged); above it the toe
 *  becomes a continuation of the foot column and the body stands on its TIP.
 *  0.75 puts every currently-authored body except the hooved ones (dog/cat
 *  0.6, a bird-footed theropod 0.7, arthropod tarsi 0.7–0.8) on the flat side,
 *  so alignment is a top-quarter phenomenon and nothing else moved for it. */
const TOE_ALIGN_START = 0.75;
/** How far a FLAT foot's toes may dip to meet the ground, as a sine (≈37°).
 *  A ball resting on the ground has its axis a ball-radius up, so even a
 *  plantigrade toe has to slope a little to put its tip down — that is an
 *  artifact of two radii, not a stance, and it must not be gated by
 *  `toeAlign` or every flat foot would float its toes. The cap is what keeps a
 *  digit far TOO short to reach (an elephant's nail over a padded foot) from
 *  turning into a claw hanging straight down: it stays a nail on the face. */
const FLAT_TOE_DIP = 0.6;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smooth 0→1 ramp; `t` is pre-normalised. */
const smoothstep01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** The ankle's REST pitch for a stance: 0 = sole flat on the ground
 *  (plantigrade), `STANCE_PITCH_MAX` = the foot standing as a vertical column
 *  (unguligrade). */
export const restAnklePitch = (stance: number): number => clamp01(stance) * STANCE_PITCH_MAX;
/** How far the toes have swung from "flat on the ground, hinged at the ball"
 *  (0) to "in line with the foot, standing on their tips" (1). */
export const toeAlignOf = (stance: number): number =>
  smoothstep01((clamp01(stance) - TOE_ALIGN_START) / (1 - TOE_ALIGN_START));
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
  /** 🚨 THIS BONE'S TIP IS KERATIN — a hoof or a claw cap. DERIVED, never
   *  authored: a digit gets it exactly when the body stands on that digit's
   *  TIP (`stance` high enough that the toes align), because anything bearing
   *  weight on a toe tip has to grow keratin there or wear the toe away. mesh.ts
   *  draws the blunt cap and tints it with the same keratin colour the beak and
   *  the muzzle use. */
  keratin?: boolean;
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

/** One leg's row in the stress ledger. Present for EVERY limb, standing or
 *  not — a leg that dropped out of support is exactly the thing worth
 *  seeing (force 0 while the body still weighs what it weighs). */
export interface LegSupport {
  /** Bone-chain prefix, e.g. "limb0L" — matches `CreatureBone.chain`. */
  chain: string;
  /** +1 = right (+X), -1 = left. Radial limbs report +1. */
  side: 1 | -1;
  /** 🚨 WHAT THIS LIMB IS FOR, from the same predicate the posture
   *  negotiation obeys (`stanceStations`). "support" = a leg the body stands
   *  on and whose ground contact the negotiation is required to preserve;
   *  "manipulator" = an arm, a wing, a raised claw — a limb that is ALLOWED
   *  to be off the ground. Without this the ledger cannot tell a hind leg
   *  that LOST the ground (support, grounded false — a bug) from a relaxed
   *  arm (manipulator, grounded false — correct), and both read as
   *  `force: 0`. */
  role: "support" | "manipulator";
  /** Is this leg bearing weight in the posed skeleton? */
  grounded: boolean;
  /** WHY this leg carries the force it does — the reason a 0 is a 0:
   *   • "ground"     — planted; the force is its share of the body.
   *   • "belly-rest" — RELIEVED BY THE BELLY. The trunk is on the ground and
   *     taking `body.bellyShare` of the weight, and this leg is one the body
   *     would otherwise stand on: it is either planted (and carrying only the
   *     small remainder the belly left it) or splayed toward the floor
   *     because its hip is too high to plant. Either way it has a `foot`.
   *     ⚖️ Phase 4 made this force a RESIDUAL, not a zero — the belly takes
   *     the load in proportion to its footprint, which is most of it but
   *     never quite all of it while a foot is still down.
   *   • "unreachable"— no `foot` AT ALL: the ground is out of reach and the
   *     limb is folded to its neutral pose in the air. Since phase 4 this is
   *     the FLYING sense only — a wing, a limb that cannot bear — because a
   *     resting body splays its legs at the floor instead (see "belly-rest").
   *     On a `role: "support"` leg it remains the handstand signature.
   *   • "slack"      — it could have planted and was not recruited: an arm
   *     the body does not need, kept free. */
  bearing: "ground" | "belly-rest" | "unreachable" | "slack";
  /** Where this leg's foot actually IS: its rest plant when it reaches the
   *  ground (present for a reachable-but-unrecruited leg too), or — for a
   *  splayed leg under a belly rest — the ball at full extension toward the
   *  floor. Absent = out of reach entirely with no splay, which is the
   *  handstand/flying signature. */
  foot?: Vec3;
  /** Downward force the ground supplies through this foot (0 when lifted). */
  force: number;
  /** 🚨 WHAT THE LEG CAN CARRY — the LESSER of crushing (cross-section ×
   *  muscle constant) and Euler buckling (∝ r⁴/L²). Which one that was is
   *  `bind`. Crushing alone said a 2 mm leg under a 20 kg body was merely
   *  overloaded; buckling says a column that slender does not stand up at all,
   *  and for anything under r:L ≈ 0.04 it is the smaller — and truer — number. */
  strength: number;
  /** 🚨 WHAT POSTURE COSTS, as a multiplier on the ground force (physio's
   *  `emaMultiplier`). 1 = a columnar limb, foot under the hip, knee straight:
   *  the bone is a pillar and carries the weight and nothing else. Above 1 =
   *  the ground reaction acts off the joints' axes, so muscles have to balance
   *  a moment and the bone carries THEIR force too. Measured off this built
   *  leg's own geometry — the knee the IK actually solved and the plant the
   *  limb actually made — which is strictly better information than the
   *  size-regression (EMA ∝ W^0.25) the literature has to use.
   *
   *  Reported for every limb, standing or not; on a limb carrying nothing it
   *  is geometry only and costs nothing, since `force` is 0. */
  ema: number;
  /** WHICH JOINT set `ema` — the knee's fold or the hip's sprawl. The two are
   *  fixed by opposite edits (straighten the leg vs. pull the feet under the
   *  body), so a re-proportioning cannot act on the multiplier alone
   *  (physio.ts `emaDetail`). */
  emaJoint: "knee" | "hip";
  /** Which failure mode set `strength`. */
  bind: "crush" | "buckle";
  /** 🚨 THE LIMB'S FLESH RADIUS IN METRES — `radiusFrac × maxTorsoRadius`, the
   *  ONE number both capacities are computed from. Reported because it is the
   *  only way a reader can put a leg on the Campione line
   *  (`radius / campioneLimbRadiusM(kg, k)` ≈ 0.9–1.1 is a real animal); a
   *  consumer re-deriving it from the blueprint has to reproduce the limb
   *  resolution to get the same value, and the ratio is the actionable column
   *  in every re-proportioning table. */
  radius: number;
  /** force × ema / strength. 1.0 = at capacity. */
  stress: number;
}

/** What the body stands in, and what it is holding.
 *
 *  🚨 THE ONE ASYMMETRY WORTH KNOWING: `gravity` is diagnostics-only (it
 *  scales forces, never a bone), `loads` are NOT. A body carrying something
 *  really does stand lower — the ledger knows the true weight-vs-strength
 *  ratio, so section 6 lets the stand height sag by it. Everything is gated
 *  on `loads` being non-empty, so an unloaded build is unchanged. */
export interface SkeletonPhysics {
  gravity?: number;
  /** Masses riding on the body, in creature-local POST-LIFT coordinates —
   *  the same frame `PoseOverrides.limbTargets`/`snoutTarget` use, which is
   *  the frame `CreatureAnimator` emits `AnimFrame.loads` in. */
  loads?: readonly CarriedLoad[];
}

/** 🚨 THE STRESS LEDGER (physio.ts) — a DIAGNOSTIC read of the posed body:
 *  what it weighs, where that weight lands, and how hard each leg is working.
 *  Phase 1 only REPORTS it; nothing here feeds back into the pose yet. The
 *  legacy `bodyMass` / `capacity` / `heightFactor` / `loadShare` in section 6
 *  still drive posture unchanged. */
export interface SupportDiagnostics {
  body: {
    /** Volume proxy over ALL bones (see physio.ts units note). The BODY's own
     *  mass — what it is carrying is `loadMass`, kept separate so a readout
     *  can say "body 0.28 + load 0.02". */
    mass: number;
    /** Σ of the carried loads' masses (`SkeletonPhysics.loads`), same units.
     *  0 for a body carrying nothing, which is every body that does not pass
     *  `phys.loads`. */
    loadMass: number;
    /** CoM of the SUPPORTED SYSTEM in the final posed frame — body plus
     *  everything it carries, mass-weighted (physio.combinedCoM). Equal to
     *  the body's own CoM whenever `loadMass` is 0, and it is the point the
     *  force solve balances under, which is how a mouth-carried object loads
     *  up the front feet without any part of the solver knowing about it. */
    com: Vec3;
    /** (mass + loadMass) × gravity — what the ground has to hold. */
    weight: number;
    gravity: number;
    /** How far the CoM sits inside the planted feet's hull, meters
     *  (balance.ts; < 0 = outside, the body is tipping).
     *
     *  ⚖️ `supportMargin === -tipping` WHENEVER THE CoM IS OUTSIDE THE HULL,
     *  and that identity is structural, not a coincidence to be tuned away.
     *  `solveFootForces` minimises ‖Σfᵢ(pᵢ − com)‖ over f ≥ 0 with Σf fixed,
     *  and the reachable centres of pressure are exactly the convex hull of
     *  the feet — so the optimal CoP is the Euclidean PROJECTION of the CoM
     *  onto that hull, and the leftover moment arm `tipping` is the distance
     *  from the CoM to the hull. Which is what `supportMargin` measures, with
     *  the opposite sign, from the other side. Inside the hull they carry
     *  different information (margin > 0 says how much room is left; tipping
     *  is 0 because the moment can be zeroed exactly). */
    supportMargin: number;
    /** Distance from the CoM to the ground's actual center of pressure,
     *  meters. > 0 means no non-negative foot force can balance the body —
     *  the handstand detector. */
    tipping: number;
    /** Where the ground's push actually acts, Σf·p / Σf, on the ground plane.
     *  Null when nothing is bearing (no planted feet, or a belly rest).
     *  Exposed rather than re-derived: a consumer drawing the support polygon
     *  and the tipping lever needs the same point the solver used. */
    centerOfPressure: { x: number; z: number } | null;
    /** Unit direction the body topples in (CoP → CoM), zero when balanced. */
    tipDir: { x: number; z: number };
    /** The lift is pinned at the belly floor: the body is lying down, and
     *  the ground under the trunk — not the legs alone — carries it. */
    bellyRest: boolean;
    /** 🚨 FRACTION OF THE WEIGHT THE BELLY CARRIES — a real number in [0, 1],
     *  0 whenever `bellyRest` is false.
     *
     *  Phase 4 turned this from a flag into a measurement. The belly is now a
     *  CONTACT like any foot: the trunk's footprint on the ground (see
     *  `bellyArea`) enters the same force balance the feet are in, and load
     *  splits between them in proportion to what each can carry. So a body
     *  whose belly is wide and whose legs are barely touching reads ~0.95
     *  here and gives its feet the rest; a body just kissing the floor with
     *  a narrow strip reads low and keeps standing on its legs. The invariant
     *  the whole model is built on:
     *
     *      Σ (planted leg forces) + bellyShare · weight = weight
     *
     *  exactly, every frame — which is what makes a belly rest a supported
     *  pose rather than a hole the weight falls through. */
    bellyShare: number;
    /** Area of the belly's ground contact patch, m² — the trunk's silhouette
     *  where it lies on (or within a hair of) the floor. 0 when not resting.
     *  This is what makes the belly STRONG: it is compared against a hoof's
     *  cross-section through one shared law (`physio.contactStrength`). */
    bellyArea: number;
    /** Centroid of that patch on the ground plane, null when not resting. */
    bellyContact: { x: number; z: number } | null;
  };
  legs: LegSupport[];
  /** Non-limb chains mapped to a 0..1-ish stress for whole-body tinting —
   *  "spine", "neck", "tail", "belly", and one "chain<i>" per flexible chain
   *  (tentacles, antennae, fronds), all on the same cantilever measure:
   *  "spine" (body weight vs Σ standing-leg strength), "neck" (mass forward
   *  of the neck root × lever vs neck cross-section), "tail" (usually ~0). */
  chainStress: Record<string, number>;
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
  /** The stress ledger over the posed body — diagnostics only. */
  support: SupportDiagnostics;
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
  /** Put the MOUTH TIP (the snout's, or the cranium's front pole on a
   *  snoutless head) here, creature-local, by bending the NECK — the channel
   *  a quadruped actually lowers its head through. The head assembly rides
   *  the repositioned neck end exactly as it rides the neck's rest curve.
   *  Bending is sagittal and capped per joint (see NECK_JOINT_BEND), so an
   *  out-of-reach target is APPROACHED, never overshot into the chest.
   *  Absent → the neck builds exactly as it does today. */
  snoutTarget?: Vec3;
  /** The trunk pitch this body holds when it is NOT acting. The posture
   *  negotiation decides which limbs are LEGS at this pitch rather than at
   *  the commanded one, so the answer cannot change mid-action (see
   *  `stanceStations`). Defaults to the blueprint's own `posture.bodyPitch`,
   *  which is what a direct rest-pose build wants. */
  restPitch?: number;
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
  padFrac: number;
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
        padFrac: grp.padFrac,
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

// ── Leg statics + support ROLE (pure) ────────────────────────────────────
// These were closures inside `buildSkeleton`'s strain engine (section 6).
// They are pure functions of one resolved limb (plus the body's torso length
// and max radius), and the posture negotiation (section 0, below) has to ask
// them BEFORE a single bone exists — which is the whole point of the analytic
// pre-pass. Section 6 still calls exactly these, so role and reach can never
// be answered two different ways in one build.

/** Stance facts independent of the body height. Contact centerlines sit
 *  ~0.85× their radius so the skin, not the axis, bears weight. */
export interface LegStatics {
  legLen: number;
  maxDrop: number; // vertical hip→foot reach with the leg straight down
  minDrop: number; // vertical reach with the leg fully folded
  footLen: number;
  ankleH: number;
  maxAnkleH: number;
  /** LOWEST the ankle can ride — the foot rolled down as flat as the ankle's
   *  own solve will take it (`loTheta` in section 7's strain search, which is
   *  where this number has to agree or the contact test and the pose disagree
   *  about what the leg can do). Phase 4's crouch spends it: a hip that has
   *  sunk BELOW its own tiptoe contact plane still plants, flat-footed,
   *  instead of dropping out of support. */
  minAnkleH: number;
  /** Height of the BALL's centre when the foot is planted. On a flat-footed
   *  limb that is the ball resting on the ground; on an unguligrade one the
   *  ball rides a toe-length up in the air and the TOE TIPS are what the ground
   *  holds, so this carries the toes' contribution to standing height. */
  contactY: number;
  ballR: number;
  tipR: number;
  /** The main digit's own length — the last link of the heel→sole→ball→tip
   *  column, and the part of it that only counts once the toes align. */
  toeLen: number;
  /** 0 = toes flat, hinged at the ball; 1 = toes in line with the foot,
   *  standing on their tips. `toeAlignOf(stance)`. */
  toeAlign: number;
  /** Radius of the heel/ankle pad's ground disc; 0 with no pad. */
  padR: number;
}

/** The digit row's own geometry, derived ONCE so `legStaticsOf` (which has to
 *  answer "how tall does this foot stand" before a bone exists) and `addDigits`
 *  (which draws it) cannot disagree about how long a toe is. */
export interface DigitMetrics {
  n: number;
  /** What `toeLengthFrac` is a fraction OF — the foot, or a stand-in for a
   *  limb with no foot bone at all. */
  span: number;
  /** One digit's share of the ball's width. */
  rBase: number;
  /** The size multiplier of the LONGEST (most central) digit — the one whose
   *  tip the body actually stands on. */
  maxMult: number;
  /** That digit's length and tip radius. */
  mainLen: number;
  mainTipR: number;
}

export function digitMetricsOf(limb: ResolvedLimb, legLen: number, ballR: number): DigitMetrics {
  const footLen = limb.footLengthFrac * legLen;
  const span = footLen > 1e-6 ? footLen : legLen * 0.18;
  const n = Math.max(1, Math.round(limb.toeCount));
  const rBase = ballR / n;
  // `mult` in `addDigits` is 1 − toeContrast·|t−0.5|/0.5 over t = k/(n−1);
  // the central digit is the least contrasted, so its |t−0.5| is the smallest
  // any k reaches: 0 for an odd row, 0.5/(n−1) for an even one.
  const off = n <= 1 ? 0 : (n % 2 === 1 ? 0 : 0.5 / (n - 1));
  const maxMult = 1 - limb.toeContrast * (off / 0.5);
  const mainLen = limb.toeLengthFrac * span * maxMult;
  return { n, span, rBase, maxMult, mainLen, mainTipR: rBase * maxMult * 0.55 };
}

export function legStaticsOf(limb: ResolvedLimb, L: number, maxR: number): LegStatics {
  const legLen = limb.lengthFrac * L;
  const baseR = limb.radiusFrac * maxR;
  const tipR = baseR * limb.taper;
  const ballR = tipR * 1.05;
  const footLen = limb.footLengthFrac * legLen;
  const maxDrop = 0.96 * legLen;
  const minDrop = 0.32 * legLen;
  const ankleH = footLen > 1e-6 ? footLen * (0.1 + 0.7 * limb.stance) : 0;
  // Highest the ankle can ride (foot up on its tip) — this is the extra
  // standing height the toes can give, so the body's reach envelope
  // includes going unguligrade, which is what makes the stance emerge.
  const restTheta = restAnklePitch(limb.stance);
  const maxTheta = Math.min(
    ANKLE_PITCH_CAP,
    restTheta + Math.max(0, Math.min(1, limb.ankleRange)) * (ANKLE_PITCH_CAP - restTheta),
  );
  const maxAnkleH = footLen > 1e-6 ? footLen * Math.sin(maxTheta) : 0;
  // …and the flattest it can lie, from the SAME bound the ankle strain search
  // uses for its low end. Not zero: a foot cannot rotate past its own joint.
  const loTheta = Math.max(0, restTheta - 0.5);
  const minAnkleH = footLen > 1e-6 ? footLen * Math.sin(loTheta) : 0;
  // 🚨 THE TOES ARE PART OF THE COLUMN NOW. As `stance` passes
  // `TOE_ALIGN_START` the digits stop lying flat and swing into line with the
  // foot, so what meets the ground is a TIP and the ball rides a toe-length
  // above it. `contactY` is where the BALL sits, which is what every plant,
  // reach and stand-height test in this file is written against — so the extra
  // height an unguligrade foot buys enters all of them for free, and at
  // `toeAlign` 0 this is byte-for-byte the old `ballR * 0.85`.
  const dm = digitMetricsOf(limb, legLen, ballR);
  const toeAlign = footLen > 1e-6 ? toeAlignOf(limb.stance) : 0;
  const toeLen = dm.mainLen;
  // WHICHEVER REACHES LOWER holds the foot up — the ball's own underside, or
  // the toe tips hanging off it. A `lerp` between the two reads as "the tips
  // take over as the stance rises", which is only true if the toes are long
  // enough to have taken over; on an elephant's stub nails it sank the whole
  // foot 4 cm into the floor. `max` asks the question the ground asks.
  const restY = footLen > 1e-6 ? ballR : tipR;
  const contactY = footLen > 1e-6
    ? Math.max(restY * 0.85, dm.mainTipR * 0.85 + toeLen * Math.sin(restTheta * toeAlign))
    : restY * 0.85;
  // ⚖️ THE PAD IS THE FLOOR THE TOES USED TO CARRY. Its disc is the sole's own
  // width, so it scales with limb girth exactly the way the old digit floor
  // did — a thick limb still gets something broad under it, it is just the
  // right something. `padFrac` says how much of the ankle wedge is filled.
  const padR = footLen > 1e-6 ? ballR * clamp01(limb.padFrac) : 0;
  return {
    legLen, maxDrop, minDrop, footLen, ankleH, maxAnkleH, minAnkleH, contactY,
    ballR, tipR, toeLen, toeAlign, padR,
  };
}

// A limb can bear weight only if it MOUNTS low enough to plant a foot under
// the body. A dorsally-mounted limb (a wing) roots on top of the body and
// can't reach the ground without wrapping around it, so it never supports.
// Where the limb is CARRIED (restLevation) is independent — a mantis mounts
// low (so this is true) yet holds its forearms raised.
const canSupport = (limb: ResolvedLimb): boolean => limb.attachHeight < 0.6;

// Could this limb bear weight at all? A wing/fin (membranous) or a
// thread-thin slender limb can't — it lifts and folds regardless of reach.
// (Body weight vs leg girth is handled separately, as a stand-height cap.)
const isLeggy = (limb: ResolvedLimb): boolean =>
  limb.membrane < 0.55 && limb.radiusFrac / Math.max(limb.lengthFrac, 0.1) >= 0.03;

// How RELUCTANT a capable limb is to be recruited for support — read off its
// neutral aim. A limb aimed laterally and extended (restProtraction ≈ 0,
// restFlexion ≈ 0, not strongly levated) is a natural stander; one reaching
// forward and folded up (a crab claw, a mantis forearm) is a manipulator that
// only bears weight if the body genuinely needs it.
const recruitCost = (limb: ResolvedLimb): number => {
  // Reaching forward only marks a MANIPULATOR when the limb is also FOLDED
  // to grasp — an extended forward-reaching leg is still a fine stander, so
  // protraction's weight scales with how folded the knee is. Being carried
  // high (levation) marks a raised forearm on its own.
  const flexFold = Math.min(1, Math.abs(limb.restFlexion) / 0.5);
  const manip = Math.abs(limb.restProtraction) * (0.3 + 0.7 * flexFold)
    + 0.6 * Math.max(0, limb.restLevation - 0.3);
  const weak = Math.max(0, 0.04 - limb.radiusFrac) * 5; // very thin → poor support
  return manip + weak;
};

/** Below this a limb is a natural stander, not a manipulator. */
const RECRUIT_FREE = 0.35;

const canBear = (limb: ResolvedLimb): boolean => canSupport(limb) && isLeggy(limb);

/** The limbs the body could bear weight on — natural standers, or (a body of
 *  nothing but manipulators) whatever can bear at all. Sets the stand height
 *  and the load capacity in section 6. NOT the same as the STANCE set below:
 *  a human's arms are in here (they hang straight, they mount just under the
 *  0.6 line, they are perfectly good weight-bearers on all fours) and they are
 *  emphatically not what an upright human stands on. */
function supportLimbs(limbs: readonly ResolvedLimb[]): ResolvedLimb[] {
  const natural = limbs.filter((l) => canBear(l) && recruitCost(l) < RECRUIT_FREE);
  return natural.length > 0 ? natural : limbs.filter(canBear);
}

// ── Posture negotiation (section 0 — runs BEFORE any bone) ───────────────
// 🚨 THE HANDSTAND FIX. `bodyPitch` and `bodyHeight` arrive as DESIRES, not
// as commands. The contact constraint is: every support leg keeps its foot on
// the ground. A leg reaches the ground from a body lift λ exactly when
//
//     ε  <  hipY(pitch) + λ − contact  ≤  legLen·0.999          (solveFoot)
//
// so each support leg i is an INTERVAL of admissible lifts, and the body can
// stand at all only where those intervals overlap. Everything below is that
// one inequality, read twice.
//
// The geometry is exactly linear in u = sin(pitch): a hip sits on the torso
// axis at station tᵢ plus a radial mount offset that pitch does not rotate,
//
//     hipYᵢ(u) = aᵢ·u + bᵢ        aᵢ = L(0.5 − tᵢ),  bᵢ = −cos(φᵢ)·tRᵢ·csH
//
// — a is the hip's signed distance in front of the torso centre, which is why
// a nose-down pitch (u < 0) DROPS the front hips and RAISES the hind ones.
// Writing Aᵢ(u) = contactᵢ − hipYᵢ(u) for the lift that puts hip i exactly at
// its contact height, the admissible lifts are
//
//     max_i Aᵢ(u) + ε  <  λ  ≤  min_i (Aᵢ(u) + Λᵢ)              Λᵢ = legLenᵢ·REACH_RESERVE
//
// The left side is a max of affine functions of u (convex), the right a min
// (concave), so the feasible u is a single interval — computable EXACTLY from
// the pairwise constraints, no iteration, no rebuild. That is the whole cost:
// one pass over ≤ n² pairs of DISTINCT support limbs (2 for a quadruped, 1
// for a biped, so this is a handful of flops per creature per frame).
//
// Two clamps come out of it, and they do different jobs:
//   • the PITCH clamp (here) fires only when NO lift satisfies every support
//     leg — the dive is so deep the front hips would go through the floor
//     while the hind ones are still out of reach;
//   • the LIFT clamp (section 6) fires much sooner, and is what produces the
//     PLAY BOW: a nose-down pitch pulls the ceiling min(Aᵢ+Λᵢ) down with the
//     rising hind hips, the body comes down with it, and the front hips —
//     already dropping with the pitch — take the whole difference and their
//     legs fold. The trunk pitches about the REAR support cluster instead of
//     about its own centre, without anyone rotating anything about anything:
//     it falls out of "the hind feet may not leave the ground".
// A body with fewer than two DISTINCT support stations (a biped, a radial
// octopus, a snake with no legs at all) has nothing to negotiate BETWEEN and
// passes through untouched.

/** ε in the contact inequality — a hair above solveFoot's own 1e-4 so a lift
 *  clamped to this floor still reads as reaching. */
const CONTACT_EPS = 1.01e-4;

/** Reach the negotiation will actually spend, as a fraction of leg length.
 *  `solveFoot` rejects a leg at > 0.999, and a clamp that lands EXACTLY on
 *  its own boundary is decided by float round-off — which is precisely what
 *  happened: the ceiling came out at 0.999·legLen to the last bit and the
 *  hind legs dropped out anyway. The 0.4% reserve also leaves the hind knee a
 *  trace of bend instead of locking it at the singularity. */
const REACH_RESERVE = 0.995;

/** One stance limb's contact geometry, as the affine coefficients the
 *  negotiation needs. `k` = contact − b (the lift that puts the hip exactly on
 *  its contact plane at pitch 0), `a` = signed distance in front of centre. */
interface SupportStation {
  limb: ResolvedLimb;
  a: number;
  k: number;
  reach: number; // Λ = legLen · REACH_RESERVE, just inside solveFoot's own test
  drop: number; // maxDrop — the straight-leg lift, for the stance test
}

/**
 * ⚖️ A LIMB IS SEATED WHERE ITS OWN GIRTH FITS.
 *
 * The hip rides the body's elliptical cross-section at `attachHeight`, sweeping
 * from the ventral midline (φ=0) to the dorsal one (φ=π), so its lateral
 * half-offset is `sin(φ) · torsoRadiusAt(station) · csW`. Nothing ever checked
 * that offset against the limb's OWN radius. It did not need to while limbs
 * were thin — but the re-proportioning round multiplied `radiusFrac` by 3-7×
 * on most quadrupeds (cow 0.13→0.49, deer 0.08→0.54) while SHRINKING `girth`
 * and the trunk, and the thighs outgrew their seats. Both edits push the same
 * way: the thigh grew, the seat did not.
 *
 * Measured at rest: the closest approach of a left femur to its right one is at
 * exactly s=t=0 — the hip ring where the limb meets the skin, not mid-thigh and
 * not the feet, which clear by 3-15 cm. A horse's femur, flesh radius 0.145
 * seated at a half-offset of only 0.073, reached 0.072 m PAST the midline and
 * engulfed its opposite number: 0.114 m of interpenetration, 44% of the radius
 * sum. The elephant's was 0.168 m and ran three segments down the column.
 *
 * So sweep the seat along the cross-section until the limb's own radius fits
 * beside its mirror image. This is an ANGLE clamp, not a translation: the hip
 * stays ON the body surface, so nothing floats off the flank — it just rides
 * higher up it, which is where a thick-thighed animal's hip actually is. A limb
 * that already fits is untouched. When the thigh is thicker than the whole
 * flank is wide (deer and the other three rows sitting on the `radiusFrac` 0.6
 * clamp) the seat lands at the widest point, φ=π/2, and the residue is a limb
 * RADIUS problem the physics round owns, not a seating one.
 */
function seatAngle(g: Blueprint, limb: ResolvedLimb, maxR: number): number {
  const phi = limb.attachHeight * Math.PI;
  // Only a bilateral pair has a mirror image to collide with; a radial spoke
  // is placed by its own azimuth and has no midline to cross.
  if (limb.placement !== "bilateral") return phi;
  const halfWidth = torsoRadiusAt(g, limb.station) * Math.sqrt(g.spine.crossSection);
  if (halfWidth < 1e-9) return phi;
  // The femur's flesh radius at the hip ring is `radiusFrac · maxR` (the
  // `radiusHead` of its first segment), so two of them want `2r` between
  // centres — but ADJACENT THIGHS TOUCHING IS NORMAL ANATOMY, and the defect
  // is a thigh whose AXIS crosses the midline, not two that graze. Demanding
  // the full `2r` buys nothing (the registry's worst residue is the same 0.008
  // either way) and costs real behaviour: every centimetre the seat rises
  // lowers the body by the same amount, and at full clearance the cute cat —
  // a short-legged body already near the belly floor — sank onto its belly
  // mid-play and broke the no-op guarantee in creature-belly-rest. Allowing a
  // tenth of the flesh to overlap keeps that body standing and still seats the
  // horse and the elephant clear.
  const FIT = 0.9;
  const lo = Math.asin(Math.min(1, (FIT * limb.radiusFrac * maxR) / halfWidth));
  return Math.min(Math.max(phi, lo), Math.PI - lo);
}

function stationOf(g: Blueprint, limb: ResolvedLimb): SupportStation {
  const L = g.spine.torsoLengthM;
  const maxR = g.spine.girth * L;
  const csH = 1 / Math.sqrt(g.spine.crossSection);
  const s = legStaticsOf(limb, L, maxR);
  // Same seat the geometry uses — see `seatAngle`. The support solver and the
  // bone placement MUST read the hip off the same angle or they disagree about
  // how tall the body stands.
  const b = -Math.cos(seatAngle(g, limb, maxR)) * torsoRadiusAt(g, limb.station) * csH;
  return {
    limb,
    a: L * (0.5 - limb.station),
    k: s.contactY + s.maxAnkleH - b,
    reach: s.legLen * REACH_RESERVE,
    drop: s.maxDrop,
  };
}

/** The lift at which each limb's leg is straight down (its own ceiling on how
 *  tall the body can stand), at pitch `u = sin(pitch)`. */
const straightLift = (s: SupportStation, u: number): number => s.k - s.a * u + s.drop;

/**
 * 🚨 THE STANCE SET — the legs the body is STANDING ON, and the only ones the
 * negotiation is allowed to constrain the posture for.
 *
 * `supportLimbs` is too generous by exactly one case, and it is the case that
 * matters: an upright human's ARMS pass every one of its tests (mounted at
 * attachHeight 0.56, hanging straight so `recruitCost` reads them as natural
 * standers, thick enough to be leggy). They are weight-bearers — a human on
 * all fours really does stand on them — and today they quietly inflate the
 * stand height and then fail to reach. Hand the negotiation that set and it
 * concludes the body must come down until its HANDS touch the floor: a
 * standing human folded to the ground, which is a far worse bug than the one
 * being fixed.
 *
 * What separates an arm from a leg is not the limb, it is the POSTURE the
 * limb is carried in. So the test is exactly that: at the body's REST pitch,
 * can this limb reach the ground when the body stands at its own MINIMUM
 * standing height (`0.4 · hHigh` — section 6's `standLow`, the same constant)?
 * A leg can, at any body height it will ever hold. An upright human's arm
 * cannot, by a factor of 1.7 in the shipped body. Measured over every shipped
 * species: every quadruped, spider, crab and centipede keeps ALL its legs;
 * the human keeps its legs and drops its arms.
 *
 * ⚖️ THE REFERENCE PITCH IS AN INPUT, NOT THE COMMANDED ONE (`PoseOverrides.
 * restPitch`). Membership has to be a body-plan fact that holds for the whole
 * action: evaluated at the commanded pitch instead, a deepening dive would
 * eventually push a hind leg's ceiling under the threshold, the leg would
 * leave the stance set mid-reach, and the handstand would pop back in at
 * around −0.55 rad. At the rest pitch the set cannot move while the body acts.
 */
function stanceStations(
  g: Blueprint, limbs: readonly ResolvedLimb[], restPitch: number,
): { bearers: SupportStation[]; stance: SupportStation[] } {
  const bearers = supportLimbs(limbs).map((l) => stationOf(g, l));
  if (bearers.length < 2) return { bearers, stance: bearers };
  const u0 = Math.sin(restPitch);
  const hHigh = Math.max(...bearers.map((s) => straightLift(s, u0)));
  const standLow = 0.4 * hHigh;
  const stance = bearers.filter((s) => s.k - s.a * u0 + s.reach >= standLow);
  // A body that can't stand on ANY of them is not posing, it is lying down;
  // leave it to the belly-rest path rather than inventing a stance for it.
  return { bearers, stance: stance.length > 0 ? stance : bearers };
}

/**
 * 🚨 WHERE A REACH TARGET LIVES. `snoutTarget` is in the skeleton's OUTPUT
 * space (post-lift, like `limbTargets`) — the frame a caller can actually see
 * an object in. The neck is built long before the body is lifted onto its
 * legs, so the solve has to know the lift in advance or it aims a metre high.
 *
 * Section 6's lift is reproduced here EXACTLY, with one substitution: the
 * belly floor `restLift` is measured over the torso and tail — every axial
 * bone that exists at neck time — instead of over bones that include the
 * head this very solve is about to move. `hHigh`, `standLow`, `capacity`,
 * `heightFactor`, the window clamp and the min/max order are the same
 * expressions on the same inputs, so for anything standing on its legs (where
 * the belly floor does not bind at all) this IS the final lift.
 *
 * The residual, for a body whose head or neck hangs below its own belly while
 * that belly is on the ground, is a few centimetres of aim — and the animator
 * closes exactly that kind of gap by watching the snout and crouching further
 * (`observe`). It deliberately ignores the balance shift and the gait bob for
 * the same reason: both are bounded by a few percent of a torso length, and
 * both are already inside the feedback loop.
 */
function provisionalLift(
  g: Blueprint,
  bones: readonly CreatureBone[],
  bearers: readonly SupportStation[],
  stance: readonly SupportStation[],
  pitch: number,
): number {
  const L = g.spine.torsoLengthM;
  const maxR = g.spine.girth * L;
  let lowestSurface = Infinity;
  let bodyMass = 0;
  // Only the torso and tail exist yet — the neck and head are what this lift
  // is about to be used to AIM, and a reaching head is not the body's floor
  // anyway (see section 6's `headIsReaching`).
  for (const b of bones) {
    if (b.kind !== "torso" && b.kind !== "tail") continue;
    lowestSurface = Math.min(lowestSurface, b.head.y - b.radiusHead, b.tail.y - b.radiusTail);
    const rmid = (b.radiusHead + b.radiusTail) * 0.5;
    bodyMass += rmid * rmid * length(sub(b.tail, b.head));
  }
  const restLift = Number.isFinite(lowestSurface) ? -lowestSurface : 0;
  if (bearers.length === 0) return restLift;
  const u = Math.sin(pitch);
  const hHigh = Math.max(...bearers.map((s) => straightLift(s, u)));
  const capacity = bearers.reduce(
    (sum, s) => sum + (s.limb.radiusFrac * maxR) ** 2 * (1 - 0.7 * s.limb.membrane), 0);
  const heightFactor = capacity > 1e-9
    ? Math.max(0.45, Math.min(1, (capacity * 24) / Math.max(bodyMass, 1e-6)))
    : 1;
  const standLow = Math.max(restLift + 0.02 * L, hHigh * 0.4);
  const stand = standLow + (hHigh - standLow) * g.posture.bodyHeight * heightFactor;
  const win = liftWindow(stance, pitch);
  const wanted = Math.min(hHigh, stand);
  return Math.max(restLift, Math.max(Math.min(wanted, win.ceiling), Math.min(win.floor, win.ceiling)));
}

/** The admissible lifts at a given pitch: `[floor, ceiling]`, empty when
 *  floor > ceiling. Section 6 clamps its own stand height into this. */
function liftWindow(st: readonly SupportStation[], pitch: number): { floor: number; ceiling: number } {
  const u = Math.sin(pitch);
  let floor = -Infinity;
  let ceiling = Infinity;
  for (const s of st) {
    const A = s.k - s.a * u;
    floor = Math.max(floor, A + CONTACT_EPS);
    ceiling = Math.min(ceiling, A + s.reach);
  }
  return { floor, ceiling };
}

/**
 * The pitch the body may actually take: the commanded one, or the nearest
 * pitch at which SOME lift keeps every support leg on the ground.
 *
 * Solved in u = sin(pitch), where the feasible set is the interval
 * { u : max_i Aᵢ(u) + ε ≤ min_j (Aⱼ(u) + Λⱼ) }. Each ordered pair (i, j) of
 * support limbs contributes one half-line
 *
 *     u·(aⱼ − aᵢ) ≤ (kⱼ + Λⱼ) − kᵢ − ε
 *
 * (note Aᵢ(u) = kᵢ − aᵢu, so the u-coefficients subtract the other way round);
 * intersecting them is the whole solve. A pair with equal `a` — two limbs at
 * the same station, so the same L/R pair or a radial crown — carries no u at
 * all and is either always satisfied or an infeasible BODY, which is not a
 * posture problem: we leave the pitch alone and let the belly-rest path have
 * it (that is the cute-float, phase 4's).
 *
 * Pitch is restricted to |pitch| < π/2 so asin inverts it; every shipped
 * posture range lives well inside that.
 */
function negotiatePitch(commanded: number, st: readonly SupportStation[]): number {
  if (st.length < 2) return commanded;
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < st.length; i++) {
    for (let j = 0; j < st.length; j++) {
      if (i === j) continue;
      const coef = st[j].a - st[i].a;
      const rhs = st[j].k + st[j].reach - st[i].k - CONTACT_EPS;
      if (Math.abs(coef) < 1e-9) {
        if (rhs < 0) return commanded; // no pitch can fix this body — hands off
        continue;
      }
      if (coef > 0) hi = Math.min(hi, rhs / coef);
      else lo = Math.max(lo, rhs / coef);
    }
  }
  if (!(lo <= hi)) return commanded; // infeasible at every pitch — hands off
  const u = Math.sin(commanded);
  if (u >= lo && u <= hi) return commanded; // the desire is already legal
  return Math.asin(Math.max(-1, Math.min(1, u < lo ? lo : hi)));
}

// ── Head seat + the NECK REACH CHANNEL ───────────────────────────────────
// 🚨 THE HEAD IS WELDED TO THE NECK'S END, AND ONLY TO IT. Everything the
// skull owns — cranium, forehead bridge, muzzle, jaw, landmarks, the skull
// guide the mesh lofts — is built as a FIXED offset from `headCenter`, in the
// creature's own axes (`braincaseAxis` is +Z, `faceUp` is +Y; the skull does
// not rotate with the neck, it only rides it). And `headCenter` is a function
// of exactly two things: where the neck ENDS and which way it points.
//
// That is what makes a neck reach channel possible without touching one line
// of the head build: bend the neck, and the whole head assembly follows,
// because it was never expressed in any other frame. The mouth tip therefore
// sits at `headSeat(end, dir) + mouthTipOffset(g)` — a constant vector plus a
// seat — and "put the snout on that object" becomes a one-parameter solve.
//
// The three helpers below are the SHARED expressions, lifted out of the head
// build verbatim rather than restated: the build destructures them, the reach
// solve calls them, and there is no second opinion about where a muzzle is.
// (`server/tests/world-engine/creature-posture.test.ts` pins the offset
// against the real built snout tip for every shipped body, so a future edit
// to the head cannot silently desynchronise them.)

/** Where the skull's centre sits, given the neck's end point and direction. */
function headSeat(headBase: Vec3, headDir: Vec3, headR: number, aL: number): Vec3 {
  // The neck joins the skull at its BASE, not the back of the cranium: the
  // attach direction runs from the cranium center back along the neck, biased
  // downward — a level neck enters low-rear (lizard/cow), a vertical neck
  // enters the bottom (human).
  const attachDir = normalize(add(scale(headDir, -1), v3(0, -0.45, 0)));
  // Seat distance uses the NEUTRAL skull ball for width/height (dome and
  // crossSection grow the vault around a fixed seat — they must never move
  // the muzzle) and the real half-length axially (long skulls seat further
  // back).
  const attachDist = 1 / Math.sqrt(
    (attachDir.x / headR) ** 2 + (attachDir.y / headR) ** 2 + (attachDir.z / aL) ** 2 + 1e-12);
  // Sunk slightly inside the guide surface so the neck tube buries its cap.
  return sub(headBase, scale(attachDir, attachDist * 0.88));
}

interface RostrumGeometry {
  snoutLen: number;
  snoutBaseR: number;
  snoutAspect: number;
  snoutUR: number;
  tipR: number;
  snoutSR: number;
  hasSnout: boolean;
  nSeg: number;
}

/** Muzzle proportions — pure in `g.head` and the skull radius. */
function rostrumGeometry(g: Blueprint, headR: number): RostrumGeometry {
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
  return {
    snoutLen,
    snoutBaseR,
    snoutAspect,
    snoutUR,
    tipR,
    snoutSR: snoutBaseR * Math.sqrt(snoutAspect),
    hasSnout: snoutLen > 1e-4,
    nSeg: Math.max(1, Math.round(g.head.snoutSegments)),
  };
}

/** The muzzle's launch direction and its total accumulated curvature, both
 *  capped by what the rostrum's LENGTH can carry (see the build's note). */
function rostrumBend(
  g: Blueprint, snoutLen: number, snoutBaseR: number, hasSnout: boolean, nSeg: number,
  braincaseAxis: Vec3 = v3(0, 0, 1), faceSide: Vec3 = X_AXIS,
): { rostrumDir0: Vec3; curveTotal: number } {
  const segLen = snoutLen / nSeg;
  const turnBudget = hasSnout ? (0.9 * segLen) / Math.max(1e-6, snoutBaseR) : Infinity;
  const PITCH_FULL = 0.9; // facePitch's own range, radians
  const CURVE_FULL = 1.2; // snoutCurve's full-scale bend, radians
  // `facePitch` is spent entirely between the skull-owned root ring and the
  // FIRST muzzle station, so it gets one segment's allowance; `snoutCurve`
  // accumulates along the whole rostrum, so it gets every segment's.
  const facePitchUsed = (g.head.facePitch / PITCH_FULL) * Math.min(PITCH_FULL, turnBudget);
  return {
    rostrumDir0: normalize(rotate(braincaseAxis, faceSide, -facePitchUsed)),
    curveTotal: g.head.snoutCurve * Math.min(CURVE_FULL, turnBudget * nSeg),
  };
}

/** The muzzle root's offset from the skull centre, in the skull's own axes. */
function muzzleSeat(g: Blueprint, headR: number, aL: number, bH: number): { rootY: number; rootZ: number } {
  return {
    // 0 = the muzzle roots at or below the floor of the cranium (a horse, a
    // long-faced grazer), 1 = at the crown (a whale's blowhole).
    rootY: lerp(-1 * bH, 0.9 * bH, g.head.foreheadHeight),
    // Measured from the cranium's FRONT POLE, so the root always sits at or
    // ahead of the skull.
    rootZ: aL + g.head.foreheadLength * headR,
  };
}

/**
 * The MOUTH TIP's offset from the skull centre — the point a `snoutTarget`
 * asks for. Integrates the same curved rostrum the bone loop lays down (the
 * bend at each segment's MIDPOINT, so the chain integrates the curvature),
 * from the same `rostrumGeometry` / `rostrumBend` / `muzzleSeat` the build
 * destructures.
 *
 * A SNOUTLESS head has no rostrum and no jaw bones at all (the mandible is
 * built inside `if (hasSnout)`), so its "mouth" is the front pole of the
 * cranium — which is where a beakless, muzzleless face bites from anyway.
 */
function mouthTipOffset(g: Blueprint, maxR: number): Vec3 {
  const headR = g.head.sizeFrac * maxR;
  const aL = headR * g.head.lengthFrac;
  const bH = headR * g.head.braincaseDome;
  const geo = rostrumGeometry(g, headR);
  if (!geo.hasSnout) return v3(0, 0, aL);
  const { rootY, rootZ } = muzzleSeat(g, headR, aL, bH);
  const { rostrumDir0, curveTotal } = rostrumBend(g, geo.snoutLen, geo.snoutBaseR, true, geo.nSeg);
  let y = rootY;
  let z = rootZ;
  for (let i = 0; i < geo.nSeg; i++) {
    const dir = rotate(rostrumDir0, X_AXIS, curveTotal * ((i + 0.5) / geo.nSeg));
    const step = geo.snoutLen / geo.nSeg;
    y += dir.y * step;
    z += dir.z * step;
  }
  return v3(0, y, z);
}

// ── The neck's bend budget ───────────────────────────────────────────────
// A neck bends by REDISTRIBUTING its own curve: each joint can add a little
// to the rest lift the blueprint gave it, and the head goes wherever the sum
// of those joints puts it. Two limits, both structural, neither a magic dial:
//
//   • PER JOINT, the same law the muzzle obeys — a tube of radius r bending
//     by θ across a segment of length ℓ folds in on itself once θ > ℓ/r. The
//     0.9 keeps a margin below that, exactly as the rostrum's turn budget
//     does. A thick short neck can barely bend; a slim long one can curl.
//   • PER JOINT AGAIN, a flat cap: no single vertebra hinges more than
//     NECK_JOINT_CAP however slim it is, so the neck reads as a CURVE rather
//     than an elbow.
//
// The budget is per JOINT and the reach is the SUM over joints, which makes
// the two limits behave quite differently — worth stating plainly, because
// the obvious guess is wrong:
//
//   • The no-fold term is JOINT-COUNT-BLIND. Segment length is neckLen/n, so
//     Σ 0.9·segLen/r = 0.9·neckLen/r whatever n is. What buys a neck reach is
//     being LONG and SLIM, not being finely jointed — the tube can only turn
//     through so much before it folds, and slicing it thinner does not change
//     that. (Measured on the dog: 2, 4, 6 and 10 segments all land the muzzle
//     within 3 cm of each other.)
//   • The CAP is what a coarse neck runs into. One joint can only give
//     NECK_JOINT_CAP, so a 1-segment neck reaches visibly less than the same
//     neck cut in two (dog: 0.39 m of drop against 0.50 m), and a 2-segment
//     neck reaches further than a 1-segment one for the same reason. Past the
//     point where the cap stops binding, more joints buy nothing but a
//     smoother curve.
//
// A neck with no segments at all (the head sits straight on the chest) has no
// budget and no reach channel — the trunk is that body's only way down.
const NECK_JOINT_CAP = 0.55; // rad, ~31° per vertebra

/** Search resolution for the reach solve: a coarse sweep over the whole bend
 *  range (which is bounded, so this cannot miss a basin by more than one
 *  step) then a golden-section refinement inside the best bracket. ~28 tip
 *  evaluations of a handful of rotations each — cheap enough to run per
 *  creature per frame, and deterministic. */
const NECK_SWEEP = 16;
const NECK_REFINE = 12;

/**
 * Solve the neck's extra per-joint bend that brings the MOUTH TIP closest to
 * `target`, as a fraction `-1..1` of each joint's own budget.
 *
 * ⚖️ SAGITTAL ONLY. The skull does not rotate with the neck in this rig (its
 * axes are the creature's), so a lateral bend would slide the face sideways
 * while it still stared straight ahead. The horizontal miss is left to the
 * body's own turn, which is how the host aims a creature at anything else.
 *
 * The target is APPROACHED, never overshot: the search runs inside the budget
 * and returns the closest reachable tip, so an object under the belly bends
 * the neck as far as it may and stops, rather than folding it into the chest.
 */
function solveNeckBend(
  target: Vec3,
  segLen: number,
  budgets: readonly number[],
  restStep: number,
  axis: Vec3,
  frontPoint: Vec3,
  headR: number,
  aL: number,
  tipOff: Vec3,
  floorY: number,
): number {
  const n = budgets.length;
  let total = 0;
  for (const b of budgets) total += b;
  const tipAt = (k: number): Vec3 => {
    let dir = axis;
    let px = frontPoint.x;
    let py = frontPoint.y;
    let pz = frontPoint.z;
    for (let i = 0; i < n; i++) {
      dir = normalize(rotate(dir, X_AXIS, restStep + k * budgets[i]));
      px += dir.x * segLen;
      py += dir.y * segLen;
      pz += dir.z * segLen;
    }
    const seat = headSeat(v3(px, py, pz), dir, headR, aL);
    // The skull rides down with the neck's extra turn (section 4), so the
    // mouth offset must be pitched by exactly the same angle the build will
    // pitch it by — otherwise the solve aims at a mouth that isn't there.
    const off = rotate(tipOff, X_AXIS, k * total);
    return v3(seat.x + off.x, seat.y + off.y, seat.z + off.z);
  };
  const miss = (k: number): number => {
    const t = tipAt(k);
    // Sagittal solve: the lateral miss is constant in k, so leaving x out of
    // the objective keeps a side-offset target from biasing the dip.
    // The GROUND is a hard term, not a hope: a target under the body is out
    // of reach in z, and the closest point of the neck's arc to it is then
    // BELOW the floor — the muzzle buried in the ground. The stiff penalty
    // makes the solve stop at the surface and approach from there instead.
    const under = Math.max(0, floorY - t.y);
    return (t.y - target.y) ** 2 + (t.z - target.z) ** 2 + 9 * under * under;
  };
  let best = 0;
  let bestV = Infinity;
  for (let i = 0; i <= NECK_SWEEP; i++) {
    const k = -1 + (2 * i) / NECK_SWEEP;
    const v = miss(k);
    if (v < bestV) { bestV = v; best = k; }
  }
  // Golden-section inside the bracket the sweep found.
  const step = 2 / NECK_SWEEP;
  let lo = Math.max(-1, best - step);
  let hi = Math.min(1, best + step);
  const phi = 0.6180339887498949;
  let c = hi - (hi - lo) * phi;
  let d = lo + (hi - lo) * phi;
  let fc = miss(c);
  let fd = miss(d);
  for (let i = 0; i < NECK_REFINE; i++) {
    if (fc < fd) { hi = d; d = c; fd = fc; c = hi - (hi - lo) * phi; fc = miss(c); }
    else { lo = c; c = d; fc = fd; d = lo + (hi - lo) * phi; fd = miss(d); }
  }
  return (lo + hi) / 2;
}

// ── Build ────────────────────────────────────────────────────────────────

export function buildSkeleton(
  g: Blueprint,
  gait?: GaitParams,
  pose?: PoseOverrides,
  /** Override the total growth segment budget (default MAX_GROWTH_SEGMENTS)
   *  — the plant LOD tiers rebuild the same blueprint at smaller budgets. */
  growthBudget?: number,
  /** Environment + what the body is CARRYING (`skel.support`). Gravity scales
   *  the reported forces and stresses and NOTHING else — it must never move a
   *  bone. Loads DO move bones (a loaded body stands lower, see section 6),
   *  but only when there are any: with `loads` absent or empty every path
   *  below is byte-for-byte the unloaded one. Default: Earth (1), nothing
   *  carried. */
  phys?: SkeletonPhysics,
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
  // 0) POSTURE NEGOTIATION. `bodyPitch` is a DESIRE; the support legs have a
  //    veto. See the section-0 block above buildSkeleton for the whole model —
  //    here it is one call, because the constraint is analytic in the hip
  //    stations and leg reaches, both of which are known before any bone.
  const { limbs } = resolveLimbs(g);
  const { bearers, stance } = stanceStations(g, limbs, pose?.restPitch ?? g.posture.bodyPitch);
  const pitch = negotiatePitch(g.posture.bodyPitch, stance);
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
  /** Extra sagittal turn the reach channel put into the neck — 0 with no
   *  `snoutTarget`, and the angle the skull rides down with when there is
   *  one. See the skull-frame note in section 4. */
  let headPitch = 0;
  if (g.neck.segments > 0) {
    const segLen = (g.neck.lengthFrac * L) / g.neck.segments;
    const neckR = g.neck.radiusFrac * maxR;
    let dir = axis;
    let point = frontPoint;
    const step = -g.neck.lift / g.neck.segments; // negative X-rot = up for +Z dir
    // THE REACH CHANNEL. Each joint may add up to its own budget on top of
    // the rest curve; `bendK` is the single fraction of that budget the solve
    // picked. No target → bendK is 0 and every rotation below is the rest
    // step to the last bit, which is what keeps the no-target build
    // byte-identical to the one that had no channel at all.
    const budgets: number[] = [];
    for (let i = 0; i < g.neck.segments; i++) {
      const f = (i + 0.5) / g.neck.segments;
      const r = frontRadius * (1 - f) + neckR * f;
      budgets.push(Math.min(NECK_JOINT_CAP, (0.9 * segLen) / Math.max(1e-6, r)));
    }
    let bendK = 0;
    if (pose?.snoutTarget) {
      // Into the frame the neck is being built in: the whole body rises by
      // the lift at the end, so the target comes DOWN by it here.
      const lift0 = provisionalLift(g, bones, bearers, stance, pitch);
      const t = pose.snoutTarget;
      const headR0 = g.head.sizeFrac * maxR;
      bendK = solveNeckBend(
        v3(t.x, t.y - lift0, t.z), segLen, budgets, step, axis, frontPoint,
        headR0, headR0 * g.head.lengthFrac, mouthTipOffset(g, maxR),
        // The ground, in this same pre-lift frame, with the muzzle's own tip
        // radius so the SKIN rests on it rather than the centreline.
        -lift0 + rostrumGeometry(g, headR0).tipR);
    }
    headPitch = bendK * budgets.reduce((a, b) => a + b, 0);
    for (let i = 0; i < g.neck.segments; i++) {
      dir = normalize(rotate(dir, X_AXIS, step + bendK * budgets[i]));
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
  // ⚖️ THE SKULL'S OWN FRAME. It is normally the creature's own axes — the
  // face looks straight along +Z whatever the neck below it is doing, which
  // is why a horse's near-vertical neck still carries a level head and why
  // pitching the trunk does not point the muzzle at the floor. That is a
  // deliberate rig invariant and every shipped body depends on it, so it
  // holds exactly as long as nothing is REACHING: `headPitch` is 0 unless a
  // `snoutTarget` bent the neck, and then the face follows that bend by the
  // same angle the neck's last joint turned through — the head carrying on
  // the cervical curve, an animal nosing down at something. The three axes
  // stay orthonormal and everything downstream (guide prims, landmarks, head
  // growths, the mesh's loft) reads the frame from them, so it all rotates
  // coherently. faceSide is the rotation axis, so it never moves.
  const braincaseAxis = normalize(rotate(v3(0, 0, 1), X_AXIS, headPitch));
  const faceSide = X_AXIS;
  const faceUp = normalize(rotate(v3(0, 1, 0), X_AXIS, headPitch));
  const domeHalf = bH;
  // The neck joins the skull at its BASE, not the back of the cranium: the
  // attach direction runs from the cranium center back along the neck,
  // biased downward — a level neck enters low-rear (lizard/cow), a vertical
  // neck enters the bottom (human). The skull's own shape is fixed in its
  // frame; changing the neck angle only moves WHERE the neck tube meets it,
  // never deforms the back of the skull.
  // (`headSeat` — module scope, because the neck's reach solve has to ask
  // where a candidate neck end would put the skull, before any of it exists.)
  const headCenter = headSeat(headBase, headDir, headR, aL);
  bones.push({
    id: "head", parent: headParent, kind: "head", chain: "head",
    head: sub(headCenter, scale(braincaseAxis, aL)),
    tail: add(headCenter, scale(braincaseAxis, aL)),
    radiusHead: headR, radiusTail: headR, flatten: 0, aspect: g.head.crossSection,
  });
  const headBoneIdx = bones.length - 1;
  const headBone = bones[headBoneIdx];
  const craniumFront = headBone.tail;

  // Snout params — `rostrum`, module scope, because `mouthTipOffset` builds
  // the muzzle's tip out of exactly these and the neck solve needs it.
  const { snoutLen, snoutBaseR, snoutAspect, snoutUR, tipR, snoutSR, hasSnout, nSeg } =
    rostrumGeometry(g, headR);

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
  const { rostrumDir0, curveTotal } =
    rostrumBend(g, snoutLen, snoutBaseR, hasSnout, nSeg, braincaseAxis, faceSide);
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
  const { rootY, rootZ } = muzzleSeat(g, headR, aL, bH);
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
  // Leg statics — stance facts independent of the body height (module-scope
  // `legStaticsOf`, bound here to this body's torso length and girth).
  const legStatics = (limb: ResolvedLimb): LegStatics => legStaticsOf(limb, L, maxR);

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
  // ⚖️ DIGIT LENGTH IS NOW EXACTLY `toeLengthFrac`, AND NOTHING ELSE.
  // There used to be a floor here, against the limb's own girth, so a digit
  // could never come out shorter than the ball it sprouts from. It bought a
  // real thing (a buried toe is a bump, not a digit) at a price nobody had
  // measured: on a thick-limbed body the floor was ALWAYS the binding term, so
  // `toeLengthFrac` did nothing at all and the elephant wore 40 cm toes on a
  // 25 cm foot. The floor moved to `padFrac` (see the note on
  // `STANCE_PITCH_MAX` above) — a thick limb gets a wide PAD — and the dial is
  // live again.
  //
  // 🚨 THE TOES ARE A CONDITIONAL FLAP. A digit runs FORWARD out of the ball
  // when the ball is on the ground, and swings DOWN toward the ground when the
  // ball is not — which is one law, not two, because `sin(pitch)` is just "how
  // far below the root the ground is, in digit lengths". Low stance: the ball
  // is down, the swing is zero, a toe lies flat and hinges at the ball (the
  // behaviour every plantigrade and digitigrade body has always had, bit for
  // bit). High stance: `legStaticsOf` has ridden the ball up a toe-length and
  // the toes swing into line with the foot and take the ground on their TIPS.
  // The swing is capped by `toeAlign` so nothing below `TOE_ALIGN_START` can
  // ever tip its toes, whatever a drape or a gait does with the ball.
  //
  // Cat and dog skeletons really do bend the digits back at the base rather
  // than continuing the metapodial; from outside, and for the purpose of
  // holding an animal up, the merged bases read as one flap — model the
  // function, not the joint count (the same call as the 3-part arthropod leg).
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
    const dm = digitMetricsOf(o.limb, legLen, ballR);
    const span = dm.span;
    const n = dm.n;
    const curl = o.curl ?? o.limb.toeCurl;
    // How far the row may swing down out of the horizontal, as a sine. A foot
    // that never aligns keeps 0 and draws exactly what it always drew.
    const toeAlign = footLen > 1e-6 ? toeAlignOf(o.limb.stance) : 0;
    const maxSwingSin = Math.sin(
      toeAlign * Math.min(
        ANKLE_PITCH_CAP,
        restAnklePitch(o.limb.stance)
          + Math.max(0, Math.min(1, o.limb.ankleRange)) * (ANKLE_PITCH_CAP - restAnklePitch(o.limb.stance)),
      ),
    );
    /** A digit standing on its TIP needs keratin there — that, and only that,
     *  is where a hoof comes from. No dial of its own. */
    const capped = toeAlign > 0.5 && o.grounded;
    // ⚖️ A DIGIT IS A SPLIT IN THE FOOT. The whole row spans the foot, so each
    // digit takes 1/n of it: one digit is the full width (a hoof), two are half
    // each, five are a fifth each. (It used to be `1.15/√n`, which claimed to
    // match the tip girth but didn't — at five digits the row came out 2.6× the
    // foot's width, so the digits overlapped into one blob instead of reading
    // as toes.)
    const rBase = dm.rBase;
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
    // same way.
    // ⚠️ BUT IT IS ILL-CONDITIONED FOR A VERTICAL FOOT, and the old `> 1e-3`
    // guard only caught `fwd` EXACTLY vertical. A hand hangs about a degree off
    // vertical, which gives the cross product a length of ~0.017 — comfortably
    // past that guard — while its DIRECTION is decided entirely by the hand's
    // tiny tilt azimuth. The row of finger roots therefore landed a measured
    // 88° away from the lateral axis mesh.ts tiles the digit slots on, spreading
    // the fingers across the palm's EDGE rather than its width.
    // So take the body's lateral axis made perpendicular to `fwd`, and keep
    // `cross(Y, fwd)` only for the case that one degenerates in: a foot pointing
    // ALONG X. The two agree wherever both are conditioned — for any HORIZONTAL
    // `fwd` they are the same vector, same sign, since both are its horizontal
    // normal — so this is a strictly better-conditioned reading of the same
    // axis, not a different one. It is also the law `limbStartFrame` in mesh.ts
    // seeds the loft roll with (same 0.95 switch-over), which is what keeps the
    // row of ROOTS and the row of SLOTS from disagreeing about which way is
    // across the foot.
    const fwdN = normalize(o.fwd);
    const lateral = sub(X_AXIS, scale(fwdN, fwdN.x));
    const sideAxis =
      length(lateral) > 0.22 ? normalize(lateral) : normalize(cross(Y_AXIS, fwdN));
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
      const dlen = o.limb.toeLengthFrac * span * mult * (isThumb ? 0.8 : 1);
      const dr = Math.max(rBase * mult, 1e-4);
      const tipDr = dr * 0.55;
      const name = `${o.chain}d${k}`;
      let tail: Vec3;
      let hoof = false;
      if (o.grounded) {
        // On the ground; curl digs the tip down and shortens the run
        // (claws); an opposed thumb lifts off the ground.
        const run = dlen * (1 - 0.45 * curl);
        const y = isThumb ? root.y + dlen * 0.4 : tipDr * 0.85 - curl * tipDr * 0.6;
        const floorY = Math.max(y, tipDr * 0.2);
        // 🚨 THE FLAP, AS ONE LAW. The digit is a RIGID segment of length `run`
        // that pitches down by however much it takes to put its tip on the
        // ground — capped by what its stance permits. That is the whole of it:
        //   • ball on the ground (any plantigrade/digitigrade foot): the drop
        //     is just the ball's radius over the tip's, the dip is shallow, the
        //     toe lies forward and its tip touches. Today's foot.
        //   • ball ridden up a toe-length (unguligrade, `toeAlign` → 1): the
        //     drop IS a toe length, the dip goes to the foot's own pitch, and
        //     the digit becomes the last link of a vertical column standing on
        //     its tip. The half of `stance` that was missing.
        //   • too short to reach either way (an elephant's nail on a padded
        //     foot): it stops at the cap and stays a nail on the foot's face,
        //     which is what a nail is.
        // Because the segment is rigid, the DRAWN length of a digit is now
        // exactly `toeLengthFrac × span × mult` — the dial and the art agree.
        const sinWant = run > 1e-9 ? (root.y - floorY) / run : 0;
        const sinP = isThumb
          ? 0
          : Math.max(0, Math.min(1, Math.min(sinWant, Math.max(maxSwingSin, FLAT_TOE_DIP))));
        const cosP = Math.sqrt(Math.max(0, 1 - sinP * sinP));
        hoof = capped && !isThumb && sinP > 0.5;
        tail = v3(
          root.x + dir.x * run * cosP,
          isThumb ? floorY : Math.max(root.y - run * sinP, floorY),
          root.z + dir.z * run * cosP,
        );
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
        // A hoofed tip does not taper to a point: keratin is a BLUNT cap over
        // the end of the digit, and that bluntness is the whole read.
        radiusTail: hoof ? dr * 0.92 : tipDr,
        flatten: ballFlatten,
        aspect: 1,
        ...(hoof ? { keratin: true } : {}),
      });
    }
  };

  /** 🚨 THE PAD — the fat fill of the heel and ankle, as one bone hanging
   *  straight down from the ankle to the ground. It is what makes a padded
   *  limb read as a COLUMN instead of a leg standing on a slanted strut: the
   *  wedge between a raised ankle and the sole in front of it is exactly the
   *  space an elephant's foot is full of. It is also a real ground contact —
   *  `footContactArea` prices it, and `legGeometry` runs the load path down
   *  through it — so the three jobs `padFrac` does are one piece of geometry
   *  and cannot drift apart.
   *
   *  It is a separate chain (`<chain>pad`), the same way digits are, so it
   *  lofts on its own and nothing that walks a leg chain has to learn a new
   *  bone in the middle of one. */
  const addPad = (o: {
    ankle: Vec3;
    ball: Vec3;
    parentIdx: number;
    chain: string;
    statics: LegStatics;
  }): void => {
    const padR = o.statics.padR;
    if (!(padR > 1e-6)) return;
    // The wedge is bounded BELOW by the sole's own contact plane, never by the
    // world floor — which is what keeps a lifted foot (a swing leg, a folded
    // one, a reaching hand) wearing its pad instead of trailing a column down
    // to the ground it is nowhere near.
    const bottom = Math.max(padR * 0.85, o.ball.y);
    if (o.ankle.y <= bottom + padR * 0.15) return; // no wedge to fill
    bones.push({
      id: `${o.chain}pad`,
      parent: o.parentIdx,
      kind: "limb",
      chain: `${o.chain}pad`,
      head: o.ankle,
      tail: v3(o.ankle.x, bottom, o.ankle.z),
      // Narrow where it meets the ankle, full width on the ground — a pad
      // spreads under load, it does not hang like a sausage.
      radiusHead: Math.max(o.statics.tipR * 0.9, padR * 0.55),
      radiusTail: padR,
      flatten: FOOT_FLATTEN,
      aspect: 1,
    });
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
      // ...clamped so the limb's own girth fits beside its mirror image — see
      // `seatAngle`.
      const phi = seatAngle(g, limb, maxR);
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
  // (`canSupport` / `isLeggy` / `recruitCost` / `canBear` / `supportLimbs`
  // are module-scope now — the posture negotiation asks them before any bone
  // exists, and both callers must get the same answer. See section 0.)

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
  //
  // ⚖️ THE STANCE WIDTH ALREADY RELAXES ITSELF, and that is worth saying
  // out loud because it is half of phase 4's "contact-preserving crouch":
  // `lat` is a MIN against `maxLat`, the widest plant that still leaves the
  // leg long enough to span the gap. So as the body sinks and the gap grows,
  // the natural width is squeezed continuously toward 0 (the foot walks in
  // under the hip) and the plant survives. A narrower stance can therefore
  // never be the thing that was missing — which is why the crouch ladder
  // below spends the ANKLE instead.
  interface FootSolve { foot: Vec3; lambda: number }
  /** One plant attempt at a GIVEN contact-plane height `c` (i.e. at a given
   *  ankle roll). Everything about reach lives here; the tiers differ only in
   *  which `c` values they are willing to try. */
  const plantAt = (leg: PendingLeg, atLift: number, c: number): FootSolve | null => {
    const s = leg.statics;
    const hy = leg.hip.y + atLift;
    const gap = hy - c;
    if (gap <= 1e-4 || gap > s.legLen * 0.999) return null; // can't reach
    const maxLat = Math.sqrt(Math.max(s.legLen * s.legLen - gap * gap, 0)) * 0.97;
    const lat = Math.min(s.legLen * stanceFrac(leg.limb), maxLat);
    const aim = footAim(leg);
    const hip = add(leg.hip, v3(0, atLift, 0));
    const foot = v3(hip.x + aim.x * lat, c, hip.z + aim.z * lat);
    return { foot, lambda: lat / s.legLen };
  };
  /** TIER 1 — the plant every body has always made. Reach is checked against
   *  the foot fully EXTENDED (up on its tip), so a tall stance that the toes
   *  help reach isn't wrongly rejected. Unchanged, and the only tier a body
   *  standing clear of its belly ever reaches. */
  const solveFoot = (leg: PendingLeg, atLift: number): FootSolve | null =>
    plantAt(leg, atLift, leg.statics.contactY + leg.statics.maxAnkleH);

  /** TIER 2 — the ANKLE RELAX, belly-bound only. A COMPLETENESS GUARD; see
   *  the measurement below before assuming it does work.
   *
   *  Tier 1 asks one question: can the leg span the gap to the ground with
   *  the foot up on its tip? That is the RIGHT guess — up on its tip is the
   *  configuration with the most reach there is. It has exactly one blind
   *  spot: a hip that has sunk BELOW its own tiptoe contact plane, which tier
   *  1 reads as "can't reach" (`gap <= 1e-4`) and folds into the air, when
   *  what the animal does is put its sole down. So: try the tip, then flat.
   *
   *  ⚖️ MEASURED, AND THE ANSWER IS "NEVER, TODAY". Swept over girth,
   *  attachHeight, leg length and foot length — every combination that
   *  belly-rests at all — no clamped body plan puts a hip inside that window.
   *  It cannot: resting the belly requires legs short against the torso
   *  radius, and that same ratio holds the hip well above a foot's own
   *  height. The branch is kept because it is the honest completion of the
   *  ankle's range and it costs one call, not because anything reaches it.
   *
   *  🚨 AND THE STANCE WIDTH BUYS NOTHING EITHER — the other half of the
   *  "relax the solve" idea, checked and rejected on the same geometry. `lat`
   *  is already min'd against `maxLat`, so it shrinks toward 0 by itself as
   *  the gap grows (see `plantAt`), and a WIDER plant only ever costs reach.
   *  Between them, tier 1 is already at maximum extension in both dials: the
   *  total slack left in the reach test (the 0.999 factor, the 1.45-rad ankle
   *  cap) is under a millimetre on a metre-long body. Which is why the legs
   *  that still cannot reach are handed to tier 3 rather than haggled with. */
  const solveFootCrouched = (leg: PendingLeg, atLift: number): FootSolve | null => {
    const s = leg.statics;
    return solveFoot(leg, atLift) ?? plantAt(leg, atLift, s.contactY + s.minAnkleH);
  };

  /** How much of its full extension a draped leg will actually spend. The
   *  chain IK clamps at 0.999 of its own span and the ankle is straight, so
   *  this is "as far down as the limb goes" with a hair left for float. */
  const DRAPE_REACH = 0.999;

  /** TIER 3 — THE SPLAY, belly-bound only, and the visible half of phase 4.
   *
   *  A leg whose hip is genuinely too high for ANY plant used to fold to its
   *  neutral FK pose — knee up, foot tucked, hanging in mid-air under a body
   *  lying on the ground. That fold is correct for a WING or a lifted claw
   *  and absurd for a resting animal's legs, and nothing in the old code told
   *  the two apart: both were simply "not recruited".
   *
   *  Here the leg instead AIMS at the ground, along its own sprawl cone —
   *  `footAim` out by the natural stance width `stanceFrac`, exactly the
   *  direction it would have planted in, so a mammal's leg drops nearly
   *  straight down and a sprawled reptile's still goes out to the side. Then
   *  it extends toward that point as far as it reaches:
   *    • if full extension covers the distance, the foot lands ON the
   *      ground and is a real (if barely loaded) contact — `planted`;
   *    • if it doesn't, the leg drapes toward the floor at maximum reach,
   *      which is what a hind leg does when the rump is propped too high.
   *  Either way the ball ends up aimed at the floor rather than folded into
   *  the air, and the belly (section 10) carries the body. */
  const solveDrape = (
    leg: PendingLeg, shift: Vec3,
  ): { target: Vec3; ball: Vec3; planted: boolean } | null => {
    const s = leg.statics;
    const hip = add(leg.hip, shift);
    const aim = footAim(leg);
    const lat = s.legLen * stanceFrac(leg.limb);
    const target = v3(hip.x + aim.x * lat, s.contactY, hip.z + aim.z * lat);
    const to = v3(target.x - hip.x, target.y - hip.y, target.z - hip.z);
    const dist = length(to);
    if (!(dist > 1e-9)) return null; // the hip is already on the floor
    const reach = (s.legLen + s.footLen) * DRAPE_REACH;
    if (dist <= reach) return { target, ball: target, planted: true };
    const dir = scale(to, 1 / dist);
    return { target, ball: add(hip, scale(dir, reach)), planted: false };
  };

  let lowestSurface = Infinity;
  // ⚖️ LEGACY MASS. Torso + tail only — head, neck and limbs are invisible to
  // it, and a midpoint centroid ignores taper. The stress ledger (physio.ts,
  // `skel.support`, section 10) measures the WHOLE body and supersedes this in
  // a later phase; until then these numbers keep driving the pose unchanged.
  let bodyMass = 0; // volume proxy (Σ r²·len over the axial body)
  let comX = 0, comZ = 0; // mass-weighted centroid (for balance)
  // 🚨 A REACHING HEAD IS NOT THE BODY'S FLOOR. `lowestSurface` is the belly
  // clearance — how far the body must be lifted for the parts it RESTS on to
  // clear the ground. A head steered to a `snoutTarget` is doing the opposite
  // of resting: it is being driven at a point that is usually ON the ground,
  // and counting it here made the body climb to keep its own nose up. (The
  // horse's eat bow: the dip put the muzzle under the belly, the floor rose
  // with it, the body was pushed off its legs and the ledger reported a belly
  // rest for an animal that was standing.) With no target the head counts
  // exactly as it always did, so nothing at rest moves.
  const headIsReaching = pose?.snoutTarget !== undefined;
  for (const b of bones) {
    if (b.kind === "limb") continue;
    if (!(headIsReaching && (b.kind === "head" || b.kind === "neck"))) {
      lowestSurface = Math.min(lowestSurface, b.head.y - b.radiusHead, b.tail.y - b.radiusTail);
    }
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
  // Only NATURAL STANDERS set how tall the body stands and how much weight
  // it can hold up — a manipulator (a forward-folded claw, even one with a
  // long foot) must not inflate the standing height and strand the real
  // legs. (Manipulators can still be RECRUITED for balance, below.) The set
  // is `supportLimbs`, the same one the negotiation protected in section 0.
  const supportRole = new Set(supportLimbs(limbs));
  const supporters = pendingLegs.filter((leg) => supportRole.has(leg.limb));
  // Body weight vs the cross-section of the legs holding it up: a heavy body
  // on thin legs can't stand as tall — it sags toward belly-rest. (Girth of
  // both body and limb now matters: thicker body = heavier, thicker leg =
  // stronger.)
  // ⚖️ LEGACY CAPACITY. A bare r² (no π, no muscle constant), summed over the
  // NATURAL STANDERS only and compared to `bodyMass` through the magic 24 —
  // so it is a proportion, not a force, and it says nothing about which leg
  // is overloaded. `physio.legStrength` + `solveFootForces` (section 10) give
  // the per-leg version; this one still sets the stand height.
  const capacity = supporters.reduce(
    (sum, leg) => sum + (leg.limb.radiusFrac * maxR) ** 2 * (1 - 0.7 * leg.limb.membrane), 0);
  // Gentle: a normally-proportioned body (even a two-legged one) stands at
  // full height; only a genuinely overloaded body (thin legs under a heavy
  // trunk) sags toward belly-rest.
  const heightFactor = capacity > 1e-9
    ? Math.max(0.45, Math.min(1, (capacity * 24) / Math.max(bodyMass, 1e-6)))
    : 1;
  // 🚨 STANCE SAG UNDER LOAD — the ONE place a load moves a bone, and the one
  // number in this section that is not legacy. A loaded body stands lower, and
  // the ledger already knows by how much: `legStrength` says what the standing
  // legs can carry, the load says what is being added, and the ratio between
  // them IS the extra leg stress the load imposes (the same measure
  // `chainStress.spine` reports). So the body gives up exactly that fraction
  // of its stand height — a load worth a tenth of the legs' capacity costs a
  // tenth of the standing lift — floored at the legacy 0.45 so a pack animal
  // sags toward its belly instead of through it.
  //
  // Derived rather than tuned, deliberately: piling a second magic constant on
  // the legacy `capacity * 24` would have made the sag a second opinion about
  // strength. GRAVITY IS NOT IN IT — a mass ratio, not a force ratio — because
  // the gravity dial must still never move a bone (see SkeletonPhysics).
  //
  // 1 exactly when nothing is carried, and `x * 1` is exact in IEEE-754, so
  // the unloaded stand height below is bit-for-bit what it always was.
  const carriedMass = loadMassTotal(phys?.loads);
  let loadSag = 1;
  if (carriedMass > 0 && supporters.length > 0) {
    const k = boneFraction(g.spine.skeleton);
    const standStrength = supporters.reduce(
      (sum, leg) => sum + legStrength(leg.limb.radiusFrac * maxR, leg.limb.membrane, k), 0);
    if (standStrength > 1e-12) loadSag = Math.max(0.45, 1 - carriedMass / standStrength);
  }
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
    const stand = standLow + (hHigh - standLow) * g.posture.bodyHeight * heightFactor * loadSag;
    // 🚨 THE CONTACT CLAMP — the negotiation's working half (section 0). The
    // desired stand height is pulled back into the window where EVERY support
    // leg can still reach the ground:
    //   • the ceiling is the first support hip to run out of leg. A nose-down
    //     pitch raises the hind hips, so it drags this ceiling down, the body
    //     follows it down, and the front hips — already dropping with the
    //     pitch — fold their legs to take the difference. That is the play
    //     bow, and it is the whole handstand fix: the hind feet never leave
    //     the ground because the body is not allowed to stand where they
    //     would have to.
    //   • the floor keeps a support hip from sinking below its own contact
    //     plane (a hip through the floor plants nothing).
    // A CLAMP, so it is a strict no-op wherever the legs already reach —
    // which is every shipped rest pose, by construction: they are all built
    // with all their support legs planted.
    const win = liftWindow(stance, pitch);
    const wanted = Math.min(hHigh, stand);
    const held = Math.max(Math.min(wanted, win.ceiling), Math.min(win.floor, win.ceiling));
    // Floor at the belly: if the legs are too short (or too weak) to lift
    // the body clear, it rests its belly down and the legs fold/tiptoe. The
    // ground under the trunk outranks the negotiation — a body already lying
    // down is phase 4's cute-float problem, not a posture to bargain over.
    lift = Math.max(restLift, held);
  } else {
    lift = restLift;
  }
  // 🚨 THE BELLY FLOOR IS BINDING — the one condition that unlocks phase 4's
  // crouch ladder and the belly's seat in the force balance. Contact with the
  // ground under the trunk is not a matter of degree: either the body is
  // resting on it or it is standing clear, and a body standing clear takes
  // EVERY path below exactly as phases 1–3 left it.
  const bellyBound = lift <= restLift + 1e-6 * Math.max(L, 1e-3);

  // Load recruitment: only the limbs the body NEEDS bear weight; the rest
  // relax to their neutral pose. Candidates are limbs that COULD plant a
  // foot (mount low enough, leggy, in reach). Natural standers (cheap) are
  // always recruited; a manipulator (a forward-folded claw / a raised mantis
  // forearm) is recruited only while the body is still under-supported — so
  // it stays raised when the other legs already hold the body up, but
  // deploys to the ground if those legs are removed.
  const grounded = new Map<PendingLeg, boolean>();
  const footAt = new Map<PendingLeg, Vec3>();
  /** Legs the crouch ladder had to SPLAY (tier 3): the ground point each one
   *  is aimed at. Present only under `bellyBound`, and it is what section 7
   *  poses them from instead of the mid-air neutral fold. */
  const drapeAt = new Map<PendingLeg, Vec3>();
  // Group each limb's bilateral L/R copies (they share one ResolvedLimb) into
  // a single recruitment UNIT, so the two sides always recruit together — a
  // body never stands on one side of a pair.
  const units = new Map<ResolvedLimb, { legs: PendingLeg[]; feet: Vec3[]; cost: number }>();
  for (const leg of pendingLegs) {
    grounded.set(leg, false);
    if (!canBear(leg.limb)) continue;
    // THE CROUCH LADDER. Off the belly floor this is tier 1 and nothing else,
    // so it is the same single call it has always been. On the floor, a leg
    // that tier 1 gives up on gets the ankle's full range (tier 2) and then,
    // if the ground is genuinely out of reach, the splay (tier 3) — which is
    // a POSE, not a plant, unless full extension actually lands on the floor.
    let sol = solveFoot(leg, lift);
    if (!sol && bellyBound) sol = solveFootCrouched(leg, lift);
    if (!sol && bellyBound) {
      const dr = solveDrape(leg, v3(0, lift, 0));
      if (dr) {
        drapeAt.set(leg, dr.target);
        // The ledger reads `footAt` for where the foot ENDED UP; a draped leg
        // that could not touch still has a foot, aimed at the floor, and
        // saying so is the whole difference from "unreachable".
        footAt.set(leg, dr.ball);
        if (dr.planted) sol = { foot: dr.ball, lambda: 0 };
      }
    }
    if (!sol) continue;
    footAt.set(leg, sol.foot);
    let u = units.get(leg.limb);
    if (!u) { u = { legs: [], feet: [], cost: recruitCost(leg.limb) }; units.set(leg.limb, u); }
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
  // ⚖️ LEGACY LOAD SHARE. An even split: every standing leg is assumed to
  // carry the same share no matter where the CoM sits, so a body leaning over
  // its front feet still loads the hind ones. `solveFootForces` (section 10)
  // computes the real per-foot distribution; this even split still drives the
  // ankle strain solve.
  //
  // ⚖️ A CARRIED LOAD IS PART OF WHAT THE LEGS HOLD, so it enters here too —
  // this is the "carry crouch": the strain solve yields toward a load-cheap
  // pose, so a laden body's knees bend as well as its stand height dropping.
  // The units agree (both are π-dropped volume proxies), and `+ 0` is exact,
  // so an unladen body's share is untouched.
  const loadShare = (bodyMass + carriedMass) / Math.max(1, nSupport);

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

  // 🚨 RE-AIM THE SPLAYED LEGS AT THE BODY THAT WAS ACTUALLY BUILT. The drape
  // had to be solved before this point — recruitment decides which feet exist,
  // and the balance shift is computed FROM those feet — so it ran against the
  // unshifted hip. A planted foot can stay where it is while the body leans
  // over it (that is what makes a leg angle), but a splayed leg hangs FROM its
  // hip and has to travel with it. Re-solving here is what keeps the ledger's
  // `foot`, the rendered ball and the aim line the same three points; without
  // it the ledger reported a hoof several centimetres from where it was drawn.
  for (const leg of [...drapeAt.keys()]) {
    const dr = solveDrape(leg, bodyShift);
    if (!dr) continue;
    drapeAt.set(leg, dr.target);
    footAt.set(leg, dr.ball);
  }

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

    const drapeTarget = drapeAt.get(leg);
    if (drapeTarget) {
      // 🚨 SPLAYED (tier 3) — the body is on its belly and this leg's hip is
      // too high for a plant. It reaches DOWN, along the sprawl direction it
      // would have planted in, to the fullest extension the chain allows:
      // ankle and ball on one straight line at the aim, so the foot is a
      // pointed toe brushing the floor rather than a fold in the air.
      //
      // ⚖️ WHY THIS IS NOT THE `limbTargets` BRANCH. That one is a REACH — an
      // arm steered at an object, elbow posed for a hand, and it keeps 2% of
      // its span in reserve so a moving target never snaps the arm straight.
      // A draped leg wants the opposite of a reserve: every millimetre it can
      // spend downward is a millimetre closer to the ground, and the shipped
      // marginal case (the cute sheep's hind pair) is short by less than that
      // very reserve. So it gets its own clamp and its own knee.
      const span = l1 + l2;
      const totalReach = (span + s.footLen) * DRAPE_REACH;
      const toT = v3(drapeTarget.x - hip.x, drapeTarget.y - hip.y, drapeTarget.z - hip.z);
      const rawD = length(toT);
      const dirT = rawD > 1e-6 ? scale(toT, 1 / rawD) : v3(0, -1, 0);
      const d = Math.min(rawD, totalReach);
      const ball = add(hip, scale(dirT, d));
      const ankle = add(hip, scale(dirT, Math.max(d - s.footLen, span * 0.2)));

      const dx2 = ankle.x - hip.x, dy2 = ankle.y - hip.y, dz2 = ankle.z - hip.z;
      const dist = Math.max(span * 0.05, Math.min(Math.hypot(dx2, dy2, dz2), span * 0.999));
      const a2 = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
      const h2 = Math.sqrt(Math.max(l1 * l1 - a2 * a2, 0));
      const dirN = dist > 1e-9 ? v3(dx2 / dist, dy2 / dist, dz2 / dist) : v3(0, -1, 0);
      // The knee still folds the way the limb's own dial says — a stifle
      // forward, a hock back — projected into the only plane it can sit in.
      // A nearly straight leg barely uses it, which is the point: the drape
      // must not invent a bend the body plan never had.
      const want = leg.limb.placement === "bilateral"
        ? v3(0, 0, leg.limb.restFlexion >= 0 ? 1 : -1)
        : leg.outDir;
      const pd = want.x * dirN.x + want.y * dirN.y + want.z * dirN.z;
      let perp = v3(want.x - dirN.x * pd, want.y - dirN.y * pd, want.z - dirN.z * pd);
      perp = length(perp) > 1e-6 ? normalize(perp) : normalize(v3(0, -dirN.z, dirN.y));
      const knee = add(add(hip, scale(dirN, a2)), scale(perp, h2));
      placeChain(leg.firstBone, hip, knee, ankle);

      if (leg.footBone >= 0) {
        bones[leg.footBone].head = ankle;
        bones[leg.footBone].tail = ball;
      }
      // Toes splay along the ground, not along the leg: a near-vertical drape
      // has no forward of its own, so fall back to the limb's sprawl aim.
      const horiz = v3(dirT.x, 0, dirT.z);
      const fwd = length(horiz) > 1e-6 ? normalize(horiz) : footAim(leg);
      const parentIdx = leg.footBone >= 0 ? leg.footBone : leg.firstBone + LEG_SEGS - 1;
      addDigits({ ball, fwd, parentIdx, chain: leg.chain, limb: leg.limb, sideSign: leg.sideSign, grounded: grounded.get(leg) === true });
      addPad({ ankle, ball, parentIdx, chain: leg.chain, statics: s });
    } else if (grounded.get(leg)) {
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
      const restTheta = restAnklePitch(leg.limb.stance);
      const maxTheta = Math.min(
        ANKLE_PITCH_CAP,
        restTheta + Math.max(0, Math.min(1, leg.limb.ankleRange)) * (ANKLE_PITCH_CAP - restTheta),
      );
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
      // ⚖️ THE ARCH IS A STRENGTH, NOT JUST A DIRECTION, so this vector is
      // deliberately NOT normalized. `w0 * 0.1` says a fully tucked limb arches
      // its knee only weakly — but normalizing threw that magnitude away and
      // handed a 0.1-long pole the same authority as a 1.2-long one, which is
      // half of why every knee in the registry pointed sideways.
      // `spread` is the other half. `w0` is tuckedness (1 at restLevation −1),
      // so `(1 − w0)²` is how far the limb is from a full tuck, and the OUT
      // term is gated by it: A TUCKED LIMB'S KNEE BELONGS IN THE SAGITTAL
      // PLANE — a horse's stifle points forward, and the fold is what aims it.
      // Ungated, the Bernstein middle term is still ~0.23 at a horse's
      // restLevation of −0.73 (w1 rises like 2k), so it put 0.22 of OUT against
      // a fold of 0.13 and bowed the leg. This costs a sprawler nothing: its
      // leg axis is diagonal, so what projects into the knee's plane as OUT is
      // the UP term, which is ungated and largest exactly where it is levated.
      const spread = (1 - w0) * (1 - w0);
      let pole = v3(
        leg.outDir.x * (w1 * 0.9 + w2 * 0.5) * spread,
        w0 * 0.1 + w1 * 0.45 + w2 * 1.2,
        leg.outDir.z * (w1 * 0.9 + w2 * 0.5) * spread,
      );
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
        // ⚖️ AN ARCH THAT ISN'T THERE GETS NO VOTE. `normalize(side)` promoted
        // the arch to a full unit vector however weak it actually was, then gave
        // it weight `1 − |bend|` — so the knee's lateral share was a function of
        // `restFlexion` ALONE and never of the arch's real strength. The
        // elephant and the sauropod convict it cleanly: both are levation −1, so
        // their pole is exactly vertical and its in-plane residue measures 0.018
        // and 0.034 — yet normalization promoted those to weights of 0.85 and
        // 0.92, and their knees came out 98.5% and 99.6% lateral.
        // Adding the two vectors AS THEY ARE compares an authored arch strength
        // against an authored fold strength, which is what the two dials mean.
        // It also makes the tetrapod sign law hold by construction rather than
        // by luck: `side` is perpendicular to `fwdPerp`, and `fwdPerp` is the
        // normalized projection of +Z into the plane, so `side` has exactly ZERO
        // world-Z component and the knee's fore/aft sign IS the sign of `bend`.
        const mixed = add(side, scale(fwdPerp, bend));
        perp = length(mixed) > 1e-6 ? normalize(mixed) : scale(fwdPerp, bend >= 0 ? 1 : -1);
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
      addPad({ ankle, ball, parentIdx, chain: leg.chain, statics: s });
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
      addPad({ ankle, ball, parentIdx, chain: leg.chain, statics: s });
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
        leg.limb.restLevation <= -0.2 && isLeggy(leg.limb)) {
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
      addPad({ ankle, ball, parentIdx, chain: leg.chain, statics: s });
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

  // 10) STRESS LEDGER — physio.ts read over the FINAL posed bones. Pure
  //     diagnostics: nothing below feeds back into a bone position, and
  //     `gravity` deliberately touches only forces. See SupportDiagnostics.
  const support = buildSupportDiagnostics({
    bones,
    env: { gravity: phys?.gravity ?? 1 },
    // ⚖️ THE BODY'S OWN DENSITY, straight off the blueprint — a MASS-only dial
    // (physio's `massKg`). It is deliberately read here and not in the pose
    // pass: a pneumatised body weighs less, and that is the whole of the
    // effect. Every shipped body is 1.
    density: g.spine.density,
    // ⚖️ AND THE BODY'S SKELETON PLAN — the strength-side twin of `density`,
    // read in the same place for the same reason. "endo" (every vertebrate,
    // and every blueprint that never heard of the field) is the old constant
    // exactly, so no mammal's number moves.
    k: boneFraction(g.spine.skeleton),
    loads: phys?.loads,
    pendingLegs,
    grounded,
    footAt,
    maxR,
    bellyRest: bellyBound,
    // Measured over the FINAL posed bones, so the patch describes the body
    // that was actually built (the same rule the rest of the ledger follows).
    bellyPatch: bellyBound ? bellyContactPatch(bones, headIsReaching, L) : null,
    draped: new Set(drapeAt.keys()),
    stance: new Set(stance.map((s) => s.limb)),
  });

  return { bones, details, membranes, growths, mouth, head, skull, maxTorsoRadius: maxR, bounds: { min, max }, support };
}

// ── Support diagnostics ──────────────────────────────────────────────────
// Assembled from the strain engine's own outputs (`grounded`, `footAt`, the
// post-shift bones) so the ledger describes the pose that was ACTUALLY built,
// never a second opinion about it.

// ── The belly as a support ───────────────────────────────────────────────
// 🚨 PHASE 4'S CENTRAL CLAIM: a belly on the ground is a CONTACT PATCH, and
// the only honest way to say how much it carries is to measure it and put it
// in the force balance next to the feet.
//
// WHAT IT IS. The trunk's own footprint: every axial slice whose UNDERSIDE
// (centreline minus radius) has reached the floor, contributing its length
// times its full silhouette width 2r. A rigid cylinder tangent to a plane
// touches along a line of zero area, which is not a physical answer — it
// would say a lying animal is supported by nothing. A belly is soft and
// flattens, and the silhouette is exactly how far it can flatten, so that is
// the number taken. It is an upper bound, deliberately: it is also the only
// bound with a geometric meaning rather than a tuned one.
//
// WHY IT IS SEVERAL CONTACTS AND NOT ONE. A patch resists moments; a point
// does not. Collapsed to its centroid, a sheep lying peacefully on its side
// would report `tipping` of several centimetres the moment its CoM sat a
// little forward of that centroid — a body that physically cannot tip, filed
// as falling over. So the patch is quantised: binned along the trunk, and
// each bin split left/right at the 2-point Gauss abscissa of its own width
// (±r/√3, which reproduces a uniform strip's second moment exactly). A dozen
// contacts at most, the solver's active set eats them, and a lying body reads
// tipping 0 because it genuinely cannot fall over.
const BELLY_BINS = 4;

/** One quantised piece of the belly's contact patch. */
interface BellyContact { x: number; z: number; area: number }

interface BellyPatch {
  area: number;
  center: Pt;
  /** The load-bearing quantisation (see BELLY_BINS). */
  contacts: BellyContact[];
  /** Points for the support hull — the patch's real extent, so `supportMargin`
   *  and `tipping` keep describing the same polygon. */
  hull: Pt[];
}

/**
 * Measure the trunk's contact with the ground in the FINAL posed frame.
 *
 * `headIsReaching` is threaded through for the same reason section 6 has it:
 * a head steered at a `snoutTarget` is being driven at a point that is
 * usually ON the ground, and counting it as belly would let a grazing muzzle
 * masquerade as a body lying down.
 */
function bellyContactPatch(
  bones: readonly CreatureBone[], headIsReaching: boolean, L: number,
): BellyPatch | null {
  // "At or NEAR the floor" — the band is what makes this a patch instead of a
  // single tangent point, and it is a fraction of the body so it means the
  // same thing on a mouse and on a whale.
  const band = 0.02 * L;
  const SAMPLES = 8;
  const raw: Array<{ x: number; z: number; area: number; r: number }> = [];
  let area = 0;
  let cx = 0;
  let cz = 0;
  for (const b of bones) {
    if (b.kind === "limb") continue;
    if (headIsReaching && (b.kind === "head" || b.kind === "neck")) continue;
    const len = length(v3(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z));
    if (!(len > 1e-9)) continue;
    const seg = len / SAMPLES;
    for (let i = 0; i < SAMPLES; i++) {
      const t = (i + 0.5) / SAMPLES;
      const r = b.radiusHead + (b.radiusTail - b.radiusHead) * t;
      const y = b.head.y + (b.tail.y - b.head.y) * t;
      if (y - r > band) continue; // this slice is still in the air
      const x = b.head.x + (b.tail.x - b.head.x) * t;
      const z = b.head.z + (b.tail.z - b.head.z) * t;
      const a = seg * 2 * r; // silhouette footprint of the slice
      if (!(a > 0)) continue;
      raw.push({ x, z, area: a, r });
      area += a;
      cx += a * x;
      cz += a * z;
    }
  }
  if (!(area > 1e-12)) return null;
  cx /= area;
  cz /= area;

  // Bin along the trunk (creature +Z is forward, so a body's long axis is z),
  // then split each bin across its own width. Empty bins simply vanish.
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const s of raw) {
    zMin = Math.min(zMin, s.z);
    zMax = Math.max(zMax, s.z);
  }
  const spanZ = zMax - zMin;
  const bins = new Array(BELLY_BINS).fill(null).map(() => ({ area: 0, x: 0, z: 0, r: 0 }));
  for (const s of raw) {
    const k = spanZ > 1e-9
      ? Math.min(BELLY_BINS - 1, Math.floor(((s.z - zMin) / spanZ) * BELLY_BINS))
      : 0;
    const bin = bins[k];
    bin.area += s.area;
    bin.x += s.area * s.x;
    bin.z += s.area * s.z;
    bin.r += s.area * s.r;
  }
  const contacts: BellyContact[] = [];
  const hull: Pt[] = [];
  const GAUSS = 1 / Math.sqrt(3);
  for (const bin of bins) {
    if (!(bin.area > 1e-12)) continue;
    const bx = bin.x / bin.area;
    const bz = bin.z / bin.area;
    const half = (bin.r / bin.area) * GAUSS;
    contacts.push({ x: bx - half, z: bz, area: bin.area * 0.5 });
    contacts.push({ x: bx + half, z: bz, area: bin.area * 0.5 });
    hull.push({ x: bx - half, z: bz }, { x: bx + half, z: bz });
  }
  if (contacts.length === 0) return null;
  return { area, center: { x: cx, z: cz }, contacts, hull };
}

/** Structural echo of section 5's PendingLeg — only the fields the ledger
 *  reads, so this helper can live outside `buildSkeleton`'s closure. */
interface LedgerLeg {
  limb: ResolvedLimb;
  chain: string;
  sideSign: 1 | -1;
  /** Needed for the CONTACT patch — the ball is what meets the ground, and it
   *  is a very different size from the leg holding it up. */
  statics: LegStatics;
  /** Index of this leg's first bone in `bones`. The EMA and buckling terms
   *  read the leg the pose pass actually BUILT — hip, knee and contact — and
   *  this is the handle on it (`bones[firstBone + i]`, i < LEG_SEGS, then the
   *  optional foot bone). */
  firstBone: number;
  /** Index of the foot bone, or -1 for a limb with no foot. */
  footBone: number;
}

/** Hip, knee, and the point the ground pushes at, for one BUILT leg.
 *
 *  The pose pass lays LEG_SEGS loft bones along hip → knee → ankle, splitting
 *  at `upperSegs` (see `placeChain`), so the knee is a bone boundary and not
 *  something to be re-derived from angles. The contact is the foot's ball when
 *  there is one — the same point `solveFootForces` balanced at, which is what
 *  makes the moment arms below consistent with the forces they multiply. */
interface LegGeometry {
  hip: Vec3;
  knee: Vec3;
  contact: Vec3;
  /** 🚨 WHERE THE GROUND ACTUALLY PUSHES, for the EMA moment arms only —
   *  the centre of the foot's contact, which is NOT its tip when the sole is
   *  down. A digitigrade or unguligrade foot (dog, horse, cat, elephant: the
   *  ankle rides high and only the ball touches) contacts at a point, and this
   *  is that point. A PLANTIGRADE foot lying flat — a human's, a crocodile's,
   *  measured: ankle and ball at the same height — contacts along its whole
   *  sole, and its centre of pressure sits mid-sole.
   *
   *  Taking the tip in that case charges the knee a moment arm of the ENTIRE
   *  foot length, which is the moment arm of a body standing on tiptoe. It
   *  read the shipped human at ema 6.6 (and so σ 4.0) for a body whose limbs
   *  are otherwise dead on the Campione line — an artifact of the contact
   *  point, not a fact about the body, and exactly the kind of thing that
   *  would send a re-proportioning round chasing the wrong number.
   *
   *  ⚖️ THE FORCE SOLVE IS NOT TOUCHED. It keeps balancing at the plant point,
   *  because that is where the pose put the foot and the two must agree about
   *  the body's geometry. This is a strictly better estimate of where, WITHIN
   *  that contact, the pressure centres. */
  groundPush: Vec3;
  /** Straight-line hip → contact: the column's effective length for Euler. */
  span: number;
}

/** Below this vertical rise over the foot's own length (≈15°), the sole counts
 *  as lying flat and its contact is the whole sole rather than the tip. */
const SOLE_FLAT_SIN = 0.25;

/** Where the femur/tibia split lands in the bone list — `placeChain`'s
 *  `upperSegs`, kept in one place so the two cannot drift apart. */
const LEG_UPPER_SEGS = Math.max(1, Math.floor(LEG_SEGS / 2));

function legGeometry<Leg extends LedgerLeg>(
  bones: readonly CreatureBone[], leg: Leg, foot: Vec3 | undefined,
): LegGeometry | null {
  const first = bones[leg.firstBone];
  const kneeBone = bones[leg.firstBone + LEG_UPPER_SEGS - 1];
  const ankleBone = bones[leg.firstBone + LEG_SEGS - 1];
  if (!first || !kneeBone || !ankleBone) return null;
  const hip = first.head;
  const knee = kneeBone.tail;
  // The ball if the leg has a foot and it is planted; the ankle otherwise. A
  // limb that never reached the ground still gets a geometry (its EMA is a
  // fact about its shape), it just never multiplies a force.
  const footBone = leg.footBone >= 0 ? bones[leg.footBone] : undefined;
  const contact = foot ?? footBone?.tail ?? ankleBone.tail;
  // 🚨 THE CENTRE OF PRESSURE IS THE MIDPOINT OF WHATEVER IS DOWN — ONE rule,
  // and the pad is simply a second way for the HEEL end to be down.
  //
  // The ball is always down; that is what a plant is. Behind it, the back of
  // the foot reaches the ground either because the sole is LYING FLAT (a
  // human's, a crocodile's) or because a PAD fills the wedge under a raised
  // ankle (an elephant's). Both put load at the ankle end, so both pull the
  // pressure centre back from the toe toward the middle of the foot, and
  // `heelDown` is just how much of the back is bearing.
  //
  //   heelDown 0  → contact at the ball. A bare digitigrade foot: the knee pays
  //                 a moment arm of the whole slanted foot, which is honest.
  //   heelDown 1  → mid-foot. Byte-for-byte the flat-sole rule that has been
  //                 here since it caught the shipped human at a phantom ema 6.6.
  //
  // What this buys the pad is precisely the elephant/sauropod case: a foot too
  // steep to count as flat, whose fat nevertheless carries load straight DOWN
  // from the ankle instead of out along a bent lever. What it deliberately does
  // NOT do is move a flat foot — a plantigrade sole is already bearing at both
  // ends, so `max` takes the flat term and a human's pad changes nothing about
  // where its pressure centres. A pad must not be able to make a foot worse.
  let groundPush = contact;
  if (footBone) {
    const dx = footBone.tail.x - footBone.head.x;
    const dy = footBone.tail.y - footBone.head.y;
    const dz = footBone.tail.z - footBone.head.z;
    const len = Math.hypot(dx, dy, dz);
    const flat = len > 1e-6 && Math.abs(dy) / len < SOLE_FLAT_SIN ? 1 : 0;
    const heelDown = Math.max(flat, Math.max(0, Math.min(1, leg.limb.padFrac)));
    if (heelDown > 0) {
      const k = heelDown * 0.5;
      groundPush = v3(contact.x - dx * k, contact.y - dy * k, contact.z - dz * k);
    }
  }
  return {
    hip, knee, contact, groundPush,
    span: Math.hypot(contact.x - hip.x, contact.y - hip.y, contact.z - hip.z),
  };
}

/** Ground contact area of one foot: the ball it stands on (or the bare leg
 *  tip, for a limb with no foot bone) — the SAME thing `contactY` measures
 *  from, so the ledger and the pose agree about what touches.
 *
 *  ⚖️ NOT `legStrength`'s cross-section, and the difference is the whole
 *  reason this function exists. A dog's thigh is enormous next to its paw;
 *  weighting the load split by structural strength would have the animal
 *  lying on the floor carrying itself on its toes. What shares load between a
 *  belly and a paw is how much GROUND each one is pressed against. */
export function footContactArea(s: LegStatics): number {
  const r = s.footLen > 1e-6 ? s.ballR : s.tipR;
  // ⚖️ A PADDED FOOT PUTS TWO THINGS ON THE GROUND — the ball in front and the
  // pad's disc behind it, under the ankle — so it presses a broader patch than
  // its ball, and the ledger has to know or a padded column reads as strong as
  // a bare peg. `padR` is the sole's own width, so at `padFrac` 1 a foot is
  // worth twice its ball; at 0 the term vanishes and this is the old function.
  return Math.PI * (r * r + s.padR * s.padR);
}

// ── Where a carried load LANDS ───────────────────────────────────────────
// A load is a mass at a point; the body part that holds it is whichever part
// that point is ON. So the seam is found geometrically — the nearest bone —
// rather than declared by the caller, which means a host that only knows
// where an object is (and every host knows that: it is drawing it there)
// gets the right chain stressed without saying a word about anatomy.
//
// Three destinations, and they are the three the body actually has:
//   • a HEAD/NECK bone → the neck cantilever. The load's moment about the
//     neck root joins the head's own moment BEFORE the division, because a
//     stress is a ratio and two ratios do not add.
//   • a LIMB bone (or one of its digits) → that limb's row, as BENDING about
//     the limb root — which is why a weight at arm's length is the hard part.
//     Added to the leg's compression stress: a limb that is both standing and
//     carrying is doing both jobs at once.
//   • anything else (torso, tail, a chain) → the SPINE, and nothing extra is
//     computed: a back load is already in the total weight, so it is already
//     in every foot force and therefore in `chainStress.spine`, which is that
//     force sum over the standing legs' strength. Inventing a second beam
//     term for it would be counting it twice.

/** Squared distance from a point to a bone's segment. */
function distToBone2(b: CreatureBone, p: Vec3): number {
  const dx = b.tail.x - b.head.x, dy = b.tail.y - b.head.y, dz = b.tail.z - b.head.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 1e-18) {
    t = ((p.x - b.head.x) * dx + (p.y - b.head.y) * dy + (p.z - b.head.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const qx = b.head.x + dx * t - p.x;
  const qy = b.head.y + dy * t - p.y;
  const qz = b.head.z + dz * t - p.z;
  return qx * qx + qy * qy + qz * qz;
}

/** The bone a load hangs from — nearest by surface, so a fat torso claims a
 *  pack sitting on it over a thin neck bone that happens to be as close to
 *  its centreline. Null for an empty bone list. */
function nearestBone(bones: readonly CreatureBone[], p: Vec3): CreatureBone | null {
  let best: CreatureBone | null = null;
  let bestD = Infinity;
  for (const b of bones) {
    const r = (b.radiusHead + b.radiusTail) * 0.5;
    const d = Math.sqrt(distToBone2(b, p)) - r;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

/** Loads grouped by the part that carries them. */
interface LoadSeams {
  neck: CarriedLoad[];
  /** Keyed by the leg's chain name (digit bones map to their leg). */
  limb: Map<string, CarriedLoad[]>;
  /** Everything the trunk carries — kept for the readout's sake; no extra
   *  stress term (see above). */
  spine: CarriedLoad[];
}

function attributeLoads(
  bones: readonly CreatureBone[],
  loads: readonly CarriedLoad[] | undefined,
  legChains: readonly string[],
): LoadSeams {
  const seams: LoadSeams = { neck: [], limb: new Map(), spine: [] };
  if (!loads) return seams;
  for (const load of loads) {
    if (!(load.mass > 0) || !Number.isFinite(load.mass)) continue;
    const b = nearestBone(bones, load.at);
    if (!b) continue;
    if (b.kind === "head" || b.kind === "neck") { seams.neck.push(load); continue; }
    if (b.kind === "limb") {
      // Digit bones are `${legChain}d${k}` (addDigits) — a toe belongs to its
      // leg, the same rule the lab's stress tint uses.
      const chain = legChains.find((c) => b.chain === c || b.chain.startsWith(`${c}d`));
      if (chain) {
        const list = seams.limb.get(chain);
        if (list) list.push(load);
        else seams.limb.set(chain, [load]);
        continue;
      }
    }
    seams.spine.push(load);
  }
  return seams;
}

interface SupportInputs<Leg extends LedgerLeg> {
  bones: readonly CreatureBone[];
  env: EnvPhysics;
  /** Body density relative to tissue (blueprint `spine.density`, 1 = solid
   *  flesh). Scales mass and therefore weight; never a strength. */
  density: number;
  /** 🚨 THE BODY'S BONE FRACTION — `boneFraction(spine.skeleton)`. The mirror
   *  image of `density`: density is mass-only, this is STRENGTH-only. An
   *  exoskeleton wears its structure on the outside, so the same drawn capsule
   *  carries ~22× more in compression and ~484× more against buckling. */
  k: number;
  /** What the body is carrying, in the final posed frame. */
  loads?: readonly CarriedLoad[];
  pendingLegs: readonly Leg[];
  grounded: ReadonlyMap<Leg, boolean>;
  footAt: ReadonlyMap<Leg, Vec3>;
  /** Max torso radius — a limb's radiusFrac is a fraction of it. */
  maxR: number;
  bellyRest: boolean;
  /** The trunk's measured contact with the ground, when it has one. */
  bellyPatch: BellyPatch | null;
  /** Legs the crouch ladder SPLAYED at the floor — they have a foot and are
   *  relieved by the belly, which is a different thing from unrecruited. */
  draped: ReadonlySet<Leg>;
  /** The limbs the body STANDS on — `role: "support"`. Section 0's set, so
   *  the ledger reports exactly what the negotiation protects. */
  stance: ReadonlySet<ResolvedLimb>;
}

function buildSupportDiagnostics<Leg extends LedgerLeg>(inp: SupportInputs<Leg>): SupportDiagnostics {
  const { bones, env, pendingLegs, grounded, footAt, maxR, bellyRest, stance } = inp;
  const { bellyPatch, draped } = inp;
  const gravity = env.gravity;
  const density = inp.density;

  // Whole body, every bone kind — this is where the ledger and the legacy
  // `bodyMass` part ways (head/neck/limbs, and a real tapered centroid).
  const props = massProperties(bones, density);
  // 🚨 WHAT IS BEING HELD UP is the body PLUS what it carries: the total
  // weight grows and the CoM slides toward the load. Both go into the same
  // solve the unloaded body already ran — a mouth-held object pulls the CoM
  // forward, the front feet answer, and `solveFootForces` never learns that
  // loads exist. With nothing carried `combinedCoM` returns the body's own
  // CoM object and `(mass + 0) * gravity` is exact, so this is the phase-4
  // path bit for bit.
  const loads = inp.loads;
  const carriedMass = loadMassTotal(loads);
  const system = combinedCoM(props.mass, props.com, loads);
  const weight = system.mass * gravity;

  // Planted feet, in build order, at their REST plants — the same polygon the
  // balance shift was computed over (the gait's instantaneous stance is
  // deliberately ignored, see section 6).
  // 🚨 EVERY LEG'S CAPACITY AND POSTURE COST, ONCE, UP FRONT — the ledger asks
  // for them in three different places below (the stance's load share, the
  // per-leg row, the spine mean) and they must be the same numbers in all
  // three. `legCapacity` takes the built span so buckling can bind; the EMA
  // multiplier comes off the same built geometry.
  const capacity = new Array<LegCapacity>(pendingLegs.length);
  const emaOf = new Array<number>(pendingLegs.length).fill(1);
  const emaJoint = new Array<"knee" | "hip">(pendingLegs.length).fill("knee");
  for (let i = 0; i < pendingLegs.length; i++) {
    const leg = pendingLegs[i];
    const radius = leg.limb.radiusFrac * maxR;
    const geom = legGeometry(bones, leg, footAt.get(leg));
    capacity[i] = legCapacity(radius, geom?.span ?? 0, leg.limb.membrane, inp.k);
    if (geom) {
      const horiz = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
      const d = emaDetail({
        kneeArm: horiz(geom.knee, geom.groundPush),
        limbRadius: radius,
        hipArm: horiz(geom.hip, geom.groundPush),
        // The hip's muscles span the trunk, not the limb — see EmaGeometry.
        hipSpan: maxR,
      });
      emaOf[i] = d.mult;
      emaJoint[i] = d.joint;
    }
  }

  const standing: number[] = [];
  const feet: Vec3[] = [];
  const footStrength: number[] = [];
  const footArea: number[] = [];
  for (let i = 0; i < pendingLegs.length; i++) {
    const leg = pendingLegs[i];
    if (!grounded.get(leg)) continue;
    const f = footAt.get(leg);
    if (!f) continue;
    standing.push(i);
    feet.push(f);
    footStrength.push(capacity[i].strength);
    footArea.push(footContactArea(leg.statics));
  }

  // 🚨 THE BELLY TAKES ITS SEAT. Off the floor this is all inert and the
  // solve below is byte-for-byte the one phases 1-3 ran. On the floor the
  // patch's contacts join the feet in ONE balance over the FULL weight —
  // no pre-split, no share handed out by fiat — and `stiffness` tells the
  // solver what each contact can carry so the tie-break lands where physics
  // would put it. Load then distributes so every contact works equally hard,
  // which for a wide belly and a few toes means the belly takes nearly all
  // of it and no part of the body is overloaded.
  const bellyStrength = bellyRest && bellyPatch ? contactStrength(bellyPatch.area) : 0;
  const bellyOn = bellyStrength > 0;
  const contacts: Pt[] = feet.map((f) => ({ x: f.x, z: f.z }));
  const nFeet = contacts.length;
  let stiffness: number[] | undefined;
  if (bellyOn && bellyPatch) {
    // Weighted by CONTACT AREA, so the tie-break the solver takes is "every
    // contact reaches the same ground pressure" — the bed-of-springs answer,
    // and the one that matches what a lying animal looks like: the belly is
    // a hundred paws wide, so it takes a hundred paws' worth of the load.
    stiffness = footArea.slice();
    for (const c of bellyPatch.contacts) {
      contacts.push({ x: c.x, z: c.z });
      stiffness.push(c.area);
    }
  }

  // The CoM to balance under is the POST-shift, whole-body one: the body has
  // already leaned (section 6) and the planted feet did not move with it.
  const ground: Pt = { x: system.com.x, z: system.com.z };
  const solved = solveFootForces({ feet: contacts, com: ground, weight, stiffness });
  const hullPts: Pt[] = feet.map((f) => ({ x: f.x, z: f.z }));
  if (bellyOn && bellyPatch) hullPts.push(...bellyPatch.hull);
  const margin = supportMargin(ground, convexHull2D(hullPts));

  // What the belly ended up holding — summed over its quantised contacts, so
  // the invariant Sum(legForces) + bellyForce = weight is the solver's own
  // Sum(f) = weight and cannot drift.
  let bellyForce = 0;
  for (let i = nFeet; i < contacts.length; i++) bellyForce += solved.forces[i];
  const bellyShare = weight > 1e-12 ? Math.min(1, Math.max(0, bellyForce / weight)) : 0;

  // Which part carries what (see the block above `attributeLoads`). Skipped
  // entirely — one allocation of two empty containers — when nothing is
  // carried, and every consumer below then reads the phase-4 value.
  const seams = attributeLoads(bones, loads, pendingLegs.map((l) => l.chain));
  /** The root bone of a chain (bones are pushed root-first), for the lever a
   *  carried load bends that chain over. */
  const rootBone = (chain: string): CreatureBone | undefined =>
    bones.find((b) => b.chain === chain);

  const legs: LegSupport[] = [];
  let standingStrength = 0;
  let legLoad = 0;
  for (let i = 0; i < pendingLegs.length; i++) {
    const leg = pendingLegs[i];
    const k = standing.indexOf(i);
    const force = k >= 0 ? solved.forces[k] : 0;
    // Strength is min(crush, buckle) over this leg's own built geometry — the
    // same entry `footStrength` handed the solver, so the load share and the
    // stress it produces are measured against one number.
    const cap = capacity[i];
    const strength = cap.strength;
    const ema = emaOf[i];
    if (k >= 0) {
      standingStrength += strength;
      // ⚖️ THE STANCE MEAN CARRIES THE POSTURE COST TOO. `chainStress.spine` is
      // Σ(demand) / Σ(capacity), and the demand a crouched leg makes on the
      // ground is force × ema — summing raw forces here would make the whole-
      // body number the one place posture is free.
      legLoad += force * ema;
    }
    const foot = footAt.get(leg);
    // 🚨 WHAT A CARRYING LIMB COSTS. A limb holding something is loaded in
    // BENDING about its root, on the horizontal lever from shoulder to grip —
    // and that is the only stress a REACHING limb has, since its `force` is 0
    // while it is off the ground. Added to the compression term rather than
    // maxed with it: a foreleg that is both standing and holding a thing is
    // doing both jobs, and the ledger's job is to say so.
    let carryStress = 0;
    const held = seams.limb.get(leg.chain);
    if (held) {
      const root = rootBone(leg.chain);
      if (root) {
        for (const ld of held) {
          const lever = Math.hypot(ld.at.x - root.head.x, ld.at.z - root.head.z);
          carryStress += cantileverStress(ld.mass * gravity, lever, root.radiusHead);
        }
      }
    }
    legs.push({
      chain: leg.chain,
      side: leg.sideSign,
      role: stance.has(leg.limb) ? "support" : "manipulator",
      grounded: k >= 0,
      // A leg the belly relieved — planted under it, or splayed at the floor
      // because its hip was too high to plant — says so. Everything else
      // keeps the phase-3 reading exactly: no foot is "unreachable", a foot
      // the body chose not to stand on is "slack".
      bearing: !foot ? "unreachable"
        : bellyOn && (k >= 0 || draped.has(leg)) ? "belly-rest"
        : k < 0 ? "slack" : "ground",
      foot,
      force,
      strength,
      ema,
      emaJoint: emaJoint[i],
      bind: cap.bind,
      radius: leg.limb.radiusFrac * maxR,
      // force × ema — the load the BONE takes once the muscles have balanced
      // the ground reaction's moment — over what the column can hold. The
      // carry term is a separate bending stress about the limb's root and is
      // still added, not maxed: a foreleg both standing and holding a thing is
      // doing both jobs.
      stress: carryStress > 0
        ? stressOf(force * ema, strength) + carryStress
        : stressOf(force * ema, strength),
    });
  }

  // ── Chain stress ───────────────────────────────────────────────────────
  // spine: the whole body's weight against everything holding it up. Equal to
  // the mean leg stress, and the number a whole-body tint wants. A belly-rest
  // body is being carried by the ground, so its spine bridges nothing (0).
  // ⚖️ A BACK LOAD IS ALREADY IN HERE: it is part of the weight, so it is part
  // of every foot force, so it is part of this sum. That is the whole of what
  // a pack does to a body — no separate beam term (see `attributeLoads`).
  const spine = standing.length > 0 ? stressOf(legLoad, standingStrength) : 0;

  // belly: the same force/capacity ratio every other contact is measured by,
  // over the patch's own footprint. It reads LOW by construction — that is
  // the physical content of "the belly is a wide support", not a nicety — and
  // it is the number that says a lying animal is comfortable rather than
  // collapsed. 0 for any body standing clear of the ground.
  const belly = bellyOn ? stressOf(bellyForce, bellyStrength) : 0;

  // neck: the head + neck held out in FRONT of the neck root is a cantilever —
  // its moment (mass × g × horizontal lever) against the root's section
  // modulus (∝ r³). This is the load a long-necked body actually carries and
  // that the legacy numbers cannot see at all, since they never weigh a head.
  const neckBones = bones.filter((b) => b.kind === "neck");
  const headBones = bones.filter((b) => b.kind === "head");
  const front = neckBones.length > 0 ? neckBones : headBones;
  //
  // 🚨 A MOUTH-CARRIED LOAD HANGS OFF THE END OF THAT LEVER, so it joins the
  // head's own moment about the same root before anything is divided — a
  // stress is a ratio, and adding two ratios would understate a load carried
  // further out than the head's own centre of mass (which is every mouth
  // carry: the object is at the snout tip, the head's mass is not).
  let neck = 0;
  if (front.length > 0) {
    const carried = massProperties(neckBones.concat(headBones), density);
    const root = front[0].head;
    const lever = Math.hypot(carried.com.x - root.x, carried.com.z - root.z);
    if (seams.neck.length === 0) {
      neck = cantileverStress(carried.mass * gravity, lever, front[0].radiusHead);
    } else {
      let moment = Math.abs(carried.mass * gravity * lever);
      for (const ld of seams.neck) {
        moment += Math.abs(ld.mass * gravity *
          Math.hypot(ld.at.x - root.x, ld.at.z - root.z));
      }
      neck = stressOf(moment, bendCapacity(front[0].radiusHead));
    }
  }

  // tail: the same cantilever from the tail root — but a tail DRAGS (section 6
  // rests any drooping part on the ground), and a bone lying on the ground
  // carries itself. Only the airborne part loads the root, so a normal droopy
  // tail reads ~0 and a tail held out straight reads real.
  const tailBones = bones.filter((b) => b.kind === "tail");
  let tail = 0;
  if (tailBones.length > 0) {
    const airborne = tailBones.filter((b) =>
      Math.min(b.head.y - b.radiusHead, b.tail.y - b.radiusTail) > 1e-6);
    if (airborne.length > 0) {
      const carried = massProperties(airborne, density);
      const root = tailBones[0].head;
      const lever = Math.hypot(carried.com.x - root.x, carried.com.z - root.z);
      tail = cantileverStress(carried.mass * gravity, lever, tailBones[0].radiusHead);
    }
  }

  const chainStress: Record<string, number> = { spine, neck, tail, belly };
  // Flexible chains (tentacles, antennae, fronds, a jellyfish's trailing
  // arms) — the SAME cantilever the neck and tail take, per chain: what the
  // chain carries, on the lever from its root, against its root's section
  // modulus. Grouped by chain name so an octopus reads eight separate
  // numbers rather than one average, and a chain lying on the ground carries
  // itself exactly as a dragging tail does.
  const flex = new Map<string, CreatureBone[]>();
  for (const b of bones) {
    if (b.kind !== "chain") continue;
    const list = flex.get(b.chain);
    if (list) list.push(b);
    else flex.set(b.chain, [b]);
  }
  for (const [name, segs] of flex) {
    const airborne = segs.filter((b) =>
      Math.min(b.head.y - b.radiusHead, b.tail.y - b.radiusTail) > 1e-6);
    if (airborne.length === 0) { chainStress[name] = 0; continue; }
    const carried = massProperties(airborne, density);
    const root = segs[0].head;
    const lever = Math.hypot(carried.com.x - root.x, carried.com.z - root.z);
    chainStress[name] = cantileverStress(carried.mass * gravity, lever, segs[0].radiusHead);
  }

  return {
    body: {
      mass: props.mass,
      loadMass: carriedMass,
      com: system.com,
      weight,
      gravity,
      supportMargin: margin,
      tipping: solved.tipping,
      centerOfPressure: solved.centerOfPressure,
      tipDir: solved.tipDir,
      bellyRest,
      bellyShare,
      bellyArea: bellyOn && bellyPatch ? bellyPatch.area : 0,
      bellyContact: bellyOn && bellyPatch ? bellyPatch.center : null,
    },
    legs,
    chainStress,
  };
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
