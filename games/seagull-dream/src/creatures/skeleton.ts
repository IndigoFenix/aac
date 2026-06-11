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

import type { EndEffector, FlexChainGenome, Genome, LimbFunction, LimbPlacement } from "./genome";

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
  const p = g.spine.profile;
  if (!p || p.length === 0) return 1;
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
// keeps its function / placement / end-effector and group/index so the
// gait layer (phase 2) can coordinate a group's copies together. This is
// where the "≤3 leg TYPES, duplicated" simplification is unfolded.

/** One concrete limb copy (a bilateral row or a radial spoke). */
export interface ResolvedLimb {
  function: LimbFunction;
  placement: LimbPlacement;
  endEffector: EndEffector;
  station: number;
  /** Source group index — copies of one group share a gait later. */
  group: number;
  /** Copy index within the group, 0 = first. */
  index: number;
  /** Radial spoke angle (radians); 0 for bilateral. */
  azimuth: number;
  segments: number;
  lengthFrac: number;
  radiusFrac: number;
  taper: number;
  membrane: number;
  splay: number;
  kneeLift: number;
  crouch: number;
  footLengthFrac: number;
  stance: number;
  toeCount: number;
  toeLengthFrac: number;
  toeSpread: number;
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
        function: grp.function,
        placement: grp.placement,
        endEffector: grp.endEffector,
        station,
        group: gi,
        index: r,
        azimuth,
        segments: grp.segments,
        lengthFrac: grp.lengthFrac * mult,
        radiusFrac: grp.radiusFrac * mult,
        taper: grp.taper,
        membrane: grp.membrane,
        splay: grp.splay,
        kneeLift: grp.kneeLift,
        crouch: grp.crouch,
        footLengthFrac: grp.footLengthFrac,
        stance: grp.stance,
        toeCount: grp.toeCount,
        toeLengthFrac: grp.toeLengthFrac,
        toeSpread: grp.toeSpread,
      });
    }
  });
  return { limbs };
}

// ── Build ────────────────────────────────────────────────────────────────

export function buildSkeleton(g: Genome): CreatureSkeleton {
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

  // 5) Limbs — ONE unified path over resolveLimbs(). Function "leg"
  //    ground-solves to y=0 after the body lift; arms/wings/fins fold out
  //    statically. Placement lays copies bilaterally (mirrored L/R) or
  //    radially (spokes around the body). The end-effector caps the tip
  //    (foot / hoof / hand / claw / paddle).
  //
  // Leg statics — everything about a leg's stance that doesn't depend on
  // the body lift. Contact centerlines sit slightly below their radius
  // (×0.85) so the skin visibly bears weight instead of grazing.
  const hasSole = (eff: EndEffector): boolean =>
    eff === "foot" || eff === "hoof" || eff === "hand";
  interface LegStatics {
    legLen: number;
    effLen: number;
    lateral: number;
    drop: number;
    footLen: number;
    ankleH: number;
    contactY: number;
    ballR: number;
    tipR: number;
  }
  const legStatics = (limb: ResolvedLimb): LegStatics => {
    const legLen = limb.lengthFrac * L;
    const baseR = limb.radiusFrac * maxR;
    const tipR = baseR * limb.taper;
    const footLen = hasSole(limb.endEffector) ? limb.footLengthFrac * legLen : 0;
    const ballR = tipR * 1.05;
    const contactY = (footLen > 1e-6 ? ballR : tipR) * 0.85;
    const effLen = legLen * (1 - 0.5 * limb.crouch) * 0.98;
    const lateral = limb.splay * legLen * 0.45;
    // Arched (arthropod) limbs sling the body LOW between high knees.
    const bodyLow = 1 - 0.5 * limb.kneeLift;
    const drop =
      Math.sqrt(Math.max(effLen * effLen - lateral * lateral, (0.25 * effLen) ** 2)) * bodyLow;
    const ankleH = footLen > 1e-6 ? footLen * (0.1 + 0.7 * limb.stance) : 0;
    return { legLen, effLen, lateral, drop, footLen, ankleH, contactY, ballR, tipR };
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

  // End-effector digits: builds the toe/finger/pincer bones at a limb's
  // contact point (`ball`), pointing along `fwd`. Used by both the leg
  // ground-solve (grounded = digit tips rest on y≈radius) and the static
  // arm build (grounded = false → digits curl down-forward like a hand).
  // Digits are single-bone chains (`<chain>d<k>`) parented to `parentIdx`.
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
    const footLen = hasSole(o.limb.endEffector) ? o.limb.footLengthFrac * legLen : 0;
    const span = footLen > 1e-6 ? footLen : legLen * 0.18;
    const eff = o.limb.endEffector;
    // Per-digit fan angle + length/radius multipliers.
    const specs: Array<{ ang: number; lenMult: number; radMult: number }> = [];
    if (eff === "hoof") {
      specs.push({ ang: 0, lenMult: 0.5, radMult: 2 });
    } else if (eff === "claw") {
      specs.push({ ang: 0.32, lenMult: 1.3, radMult: 1.2 });
      specs.push({ ang: -0.32, lenMult: 1.3, radMult: 1.2 });
    } else if (eff === "hand") {
      const n = Math.max(2, Math.min(5, Math.round(o.limb.toeCount)));
      for (let k = 0; k < n; k++) {
        const a = n > 1 ? (k / (n - 1) - 0.5) * o.limb.toeSpread * 0.7 : 0;
        specs.push({ ang: a, lenMult: 1.4, radMult: 0.55 });
      }
      // Opposed thumb, off to one side.
      specs.push({ ang: -o.sideSign * (o.limb.toeSpread * 0.5 + 0.5), lenMult: 1, radMult: 0.7 });
    } else {
      const n = Math.max(0, Math.round(o.limb.toeCount));
      for (let k = 0; k < n; k++) {
        const a = n > 1 ? (k / (n - 1) - 0.5) * o.limb.toeSpread : 0;
        specs.push({ ang: a, lenMult: 1, radMult: 1 });
      }
    }
    const r = ballR * (0.6 - 0.05 * Math.max(0, specs.length - 1));
    specs.forEach((sp, di) => {
      const dir = rotate(o.fwd, Y_AXIS, sp.ang);
      const dlen = o.limb.toeLengthFrac * span * sp.lenMult;
      const dr = Math.max(r * sp.radMult, 1e-4);
      const tipR2 = dr * 0.6; // the digit's tail radius
      const name = `${o.chain}d${di}`;
      // Grounded: the digit TIP centerline sits at ~0.85× its tip radius
      // so the skin bears weight (above ground, within one radius of it).
      const tail = o.grounded
        ? v3(o.ball.x + dir.x * dlen, tipR2 * 0.85, o.ball.z + dir.z * dlen)
        : v3(o.ball.x + dir.x * dlen, o.ball.y - dlen * 0.5, o.ball.z + dir.z * dlen);
      bones.push({
        id: name,
        parent: o.parentIdx,
        kind: "limb",
        chain: name,
        head: o.ball,
        tail,
        radiusHead: dr,
        radiusTail: dr * 0.6,
        flatten: 0,
        aspect: 1,
      });
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
    const segs = limb.segments;
    const segLen = (limb.lengthFrac * L) / segs;
    const parentBone = torsoBoneAt(limb.station);
    const tR = torsoRadiusAt(g, limb.station);
    const center = stationPoint(limb.station);
    const isLeg = limb.function === "leg";
    const isArm = limb.function === "arm";
    const paddle = limb.endEffector === "paddle";
    // Paddle/flipper forces the limb into a flattened blade.
    const limbFlatten = paddle ? Math.max(limb.membrane, 0.8) : limb.membrane;
    const statics = legStatics(limb);

    for (const inst of placeInstances(limb)) {
      const chain = `limb${limbIdx}${inst.label}`;
      const hip = add(
        center,
        add(scale(inst.outDir, tR * csW * 0.85), v3(0, -tR * csH * 0.25, 0)),
      );

      if (isLeg) {
        // Placeholder straight-down chain; ground-solved after the lift.
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
            flatten: limbFlatten,
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
      } else {
        // arm / wing / fin — fold out statically (not ground-solved).
        let dir = isArm
          ? normalize(add(scale(inst.outDir, 0.25), v3(0, -0.85, 0.3)))
          : normalize(add(scale(inst.outDir, 0.9), v3(0, 0.15, -0.35)));
        let point = hip;
        for (let i = 0; i < segs; i++) {
          if (i > 0) {
            dir = isArm
              ? normalize(rotate(dir, X_AXIS, -0.45)) // curl forward
              : normalize(rotate(dir, Y_AXIS, inst.sideSign * 0.55)); // fold rearward
          }
          const next = add(point, scale(dir, segLen));
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
            flatten: limbFlatten,
            aspect: 1,
          });
          point = next;
        }
        // A grasping arm grows a hand/claw at its tip (curls down-forward).
        if (isArm && (limb.endEffector === "hand" || limb.endEffector === "claw")) {
          addDigits({ ball: point, fwd: dir, parentIdx: bones.length - 1, chain, limb, sideSign: inst.sideSign, grounded: false });
        }
      }
    }
    limbIdx++;
  }

  // 6) Body lift — how high the torso center sits so the creature RESTS
  //    on y=0. Legged: tallest leg pair sets the height (others bend
  //    more); always at least belly clearance. Legless: belly touches.
  // Lowest skin point of the axial body (torso+tail+neck+head bones).
  let lowestSurface = Infinity;
  for (const b of bones) {
    if (b.kind === "limb") continue;
    lowestSurface = Math.min(
      lowestSurface,
      b.head.y - b.radiusHead,
      b.tail.y - b.radiusTail,
    );
  }
  let lift: number;
  if (pendingLegs.length > 0) {
    // Every foot must reach the ground: the SHORTEST requirement wins
    // and longer legs fold more (real animals bend, they don't stilt).
    // The belly-clearance floor still applies — stubby legs on a fat
    // body may end up stretched or dangling, which is honest.
    let wanted = Infinity;
    for (const leg of pendingLegs) {
      const s = leg.statics;
      wanted = Math.min(wanted, s.drop + s.ankleH + s.contactY - leg.hip.y);
    }
    lift = Math.max(-lowestSurface + 0.02 * L, wanted);
  } else {
    lift = -lowestSurface;
  }
  for (const b of bones) {
    b.head = add(b.head, v3(0, lift, 0));
    b.tail = add(b.tail, v3(0, lift, 0));
  }

  // 7) Ground-solve the legs: two-pseudo-bone analytic IK from the
  //    lifted hip to the ANKLE (ball + stance height), with the
  //    elbow/knee arcing toward a continuous POLE direction —
  //    kneeLift 0 = sagittal fold (mammal: front pairs fold backward
  //    like elbows, rear pairs forward like knees), ~0.5 = lateral
  //    elbow-out (reptile sprawl), 1 = arched above the torso
  //    (arthropod). The foot then runs forward to the ball, and toes
  //    fan from the ball to the ground.
  for (const leg of pendingLegs) {
    const s = leg.statics;
    const hip = add(leg.hip, v3(0, lift, 0));
    const ankleY = s.contactY + s.ankleH;
    // The foot steps OUT along the limb's outward direction (±X for
    // bilateral, the spoke for radial).
    const ankle = v3(hip.x + leg.outDir.x * s.lateral, ankleY, hip.z + leg.outDir.z * s.lateral);

    const dx = ankle.x - hip.x;
    const dy = ankle.y - hip.y;
    const dz = ankle.z - hip.z;
    let dist = Math.hypot(dx, dy, dz);
    const l1 = s.legLen * 0.52;
    const l2 = s.legLen * 0.48;
    dist = Math.min(dist, (l1 + l2) * 0.999);
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
    const dirN = dist > 1e-9 ? v3(dx / dist, dy / dist, dz / dist) : v3(0, -1, 0);

    // Pole direction: quadratic blend mammal → reptile → arthropod. The
    // lateral/arthropod lean follows the limb's outward direction, so it
    // works for radial spokes as well as bilateral ±X.
    const sagZ = leg.limb.station < 0.5 ? -1 : 1;
    const k = leg.limb.kneeLift;
    const w0 = (1 - k) * (1 - k);
    const w1 = 2 * k * (1 - k);
    const w2 = k * k;
    const pole = normalize(v3(
      leg.outDir.x * (w1 * 1.0 + w2 * 0.55),
      w0 * 0.1 + w1 * 0.35 + w2 * 1.0,
      leg.outDir.z * (w1 * 1.0 + w2 * 0.55) + w0 * sagZ + w1 * sagZ * 0.25,
    ));
    // Project the pole perpendicular to the hip→ankle axis.
    const dot = pole.x * dirN.x + pole.y * dirN.y + pole.z * dirN.z;
    let perp = v3(pole.x - dirN.x * dot, pole.y - dirN.y * dot, pole.z - dirN.z * dot);
    perp = length(perp) > 1e-6 ? normalize(perp) : normalize(v3(0, -dirN.z, dirN.y));
    const knee = add(add(hip, scale(dirN, a)), scale(perp, h));

    // Distribute the chain's segments along hip→knee→ankle, then
    // zigzag the interior joints (alternating along the pole) so
    // 3–4 segment crouched legs read as folded, not bowed.
    const segs = leg.limb.segments;
    const upperSegs = Math.max(1, Math.floor(segs / 2));
    const points: Vec3[] = [];
    for (let i = 0; i <= segs; i++) {
      if (i <= upperSegs) {
        const t = i / upperSegs;
        points.push(v3(
          hip.x + (knee.x - hip.x) * t,
          hip.y + (knee.y - hip.y) * t,
          hip.z + (knee.z - hip.z) * t,
        ));
      } else {
        const t = (i - upperSegs) / (segs - upperSegs);
        points.push(v3(
          knee.x + (ankle.x - knee.x) * t,
          knee.y + (ankle.y - knee.y) * t,
          knee.z + (ankle.z - knee.z) * t,
        ));
      }
    }
    if (segs >= 3) {
      const zig = leg.limb.crouch * s.legLen * 0.06;
      for (let i = 1; i < segs; i++) {
        if (i === upperSegs) continue; // the knee itself is the apex
        const sign = i % 2 === 0 ? 1 : -1;
        points[i] = add(points[i], scale(perp, sign * zig));
      }
    }
    for (let i = 0; i < segs; i++) {
      const b = bones[leg.firstBone + i];
      b.head = points[i];
      b.tail = points[i + 1];
    }

    // End-effector. The foot runs forward (+Z) with a splay-driven
    // toe-out; the contact point (ball, or the bare leg tip when there is
    // no sole) anchors the digits, which the shared builder fans onto the
    // ground per the effector (foot/hoof/hand/claw).
    const fwd = normalize(add(v3(0, 0, 1), scale(leg.outDir, 0.3 * leg.limb.splay)));
    let ball = ankle;
    if (leg.footBone >= 0) {
      const dropF = ankleY - s.contactY;
      const run = Math.sqrt(Math.max(s.footLen * s.footLen - dropF * dropF, (0.15 * s.footLen) ** 2));
      ball = v3(ankle.x + fwd.x * run, s.contactY, ankle.z + fwd.z * run);
      const fb = bones[leg.footBone];
      fb.head = ankle;
      fb.tail = ball;
    }
    const eff = leg.limb.endEffector;
    if (eff !== "none" && eff !== "paddle") {
      const parentIdx = leg.footBone >= 0 ? leg.footBone : leg.firstBone + leg.limb.segments - 1;
      addDigits({ ball, fwd, parentIdx, chain: leg.chain, limb: leg.limb, sideSign: leg.sideSign, grounded: true });
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
