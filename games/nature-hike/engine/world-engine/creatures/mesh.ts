// Creature mesh — skeleton → ONE low-poly skinned capsule loft.
//
// The whole creature is a single THREE.SkinnedMesh (one draw call):
// - The AXIAL body (tail tip → torso → neck → head bulb → snout) is one
//   continuous ring loft — no seams at chain boundaries; joint rings are
//   weighted 50/50 between the adjacent bones so bending stays smooth.
// - Each limb is its own ring loft, capped at the tip; its root ring
//   starts just inside the torso so no hole shows at the shoulder/hip.
// - Rigid details (beak cone, eye spheres) are merged into the same
//   geometry with single-bone weights — hard parts really are rigid.
// - Colors are per-vertex (base/belly blend by ring-relative height,
//   accent for the beak) so one material serves every creature.
//
// Bones carry NO rest rotation: each THREE.Bone is a pure translation
// from its parent (rest pose == bind pose), so the skeleton hierarchy is
// trivially derived from CreatureBone head points. Phase-2 animation
// rotates bones around their heads, which is exactly the hinge a real
// joint is.

import * as THREE from "three";
import type { Blueprint } from "./blueprint";
import { resolveLimbs, skullRaycast, XSECTION_WIDEN, XSECTION_FLATTEN } from "./skeleton";
import type { CreatureBone, CreatureSkeleton, MouthSpec, SkullGuide, Vec3 } from "./skeleton";
import { standaloneFruitStructure, type GrowthFruitBlueprint } from "./growth";
import type { GarmentBlueprint } from "./clothing";
import { surfaceMaterial } from "../materials";

// Live-tunable loft quality (lab sliders; later per-LOD presets).
export const LOFT = {
  /** Vertices per ring. 6 = chunky low-poly, 10 = smooth. */
  sides: 8,
  /** Extra rings lofted along the head bulb. */
  headRings: 6,
  /** Cross-section widening at membrane=1 (wing chord multiplier).
   *  ⚠️ Defined in skeleton.ts: the skeleton has to place digits against a
   *  sole's RENDERED half-width, so these two cannot be owned here alone. */
  membraneWiden: XSECTION_WIDEN,
  /** Cross-section flattening at membrane=1. */
  membraneFlatten: XSECTION_FLATTEN,
  /** Wing chord as a fraction of limb length at membrane=1. Radius-based
   *  widening alone leaves wings looking like rods — the chord has to
   *  scale with the LIMB, not its skinny cross-section. */
  membraneChordFrac: 0.2,
};

export interface BuiltCreature {
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  /** Root bone (added as a child of the mesh). */
  root: THREE.Bone;
  stats: { vertices: number; triangles: number; bones: number; buildMs: number };
  /** Per-vertex construction-section label — empty unless built with
   *  `debugTags` (the lab picker + color-by-section views use it). */
  sections: string[];
}

// ── Geometry accumulator ─────────────────────────────────────────────────

class GeoBuilder {
  positions: number[] = [];
  colors: number[] = [];
  skinIndices: number[] = [];
  skinWeights: number[] = [];
  index: number[] = [];
  /** Per-vertex construction-section label (debug provenance). Only
   *  populated when `tag` is on — the picker/color-by-section views read
   *  it so a vertex reports WHAT it is ("throat.endFill") not just an ID. */
  sections: string[] = [];
  private _sec = "";
  private _tag: boolean;

  constructor(tag = false) {
    this._tag = tag;
  }

  /** Name the construction step now emitting — every subsequent vertex
   *  (including those from loftChain/capRing) is tagged with this. */
  section(name: string): void {
    this._sec = name;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(
    p: THREE.Vector3,
    color: THREE.Color,
    boneA: number,
    boneB: number,
    weightA: number,
  ): number {
    const i = this.vertexCount;
    this.positions.push(p.x, p.y, p.z);
    this.colors.push(color.r, color.g, color.b);
    this.skinIndices.push(boneA, boneB, 0, 0);
    this.skinWeights.push(weightA, 1 - weightA, 0, 0);
    if (this._tag) this.sections.push(this._sec);
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    // a-b on ring N, d-c the matching verts on ring N+1; outward winding.
    this.index.push(a, b, c, a, c, d);
  }

  tri(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.skinIndices, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.skinWeights, 4));
    geo.setIndex(this.index);
    geo.computeVertexNormals();
    return geo;
  }
}

// ── Ring loft ────────────────────────────────────────────────────────────

/** One landmark-anchored soft-tissue bulge: a Gaussian mound of flesh
 *  centered at `center`, falling off over `radius`, `weight` m tall. */
interface TissueBulge {
  center: THREE.Vector3;
  radius: number;
  weight: number;
}

/** The soft-tissue field applied to a skull ring: an even outward `pad`
 *  (fraction of the ring radius) plus localized `bulges`. Vertices are
 *  displaced along their outward normal (see loftChain). */
interface TissueField {
  pad: number;
  bulges: TissueBulge[];
}

interface RingSpec {
  center: THREE.Vector3;
  /** Loft direction at this ring (unit). Frames are parallel-transported
   *  along the chain to avoid twist. */
  direction: THREE.Vector3;
  radius: number;
  /** Explicit vertex positions (length = sides) — used by the skull loft,
   *  whose rings are ray-cast against the guide union rather than being
   *  ellipses. Tissue/clip/coloring still apply; radius stays meaningful
   *  as the vertical half-extent (belly blend). */
  points?: THREE.Vector3[];
  /** 0 round .. 1 flattened+widened (membrane cross-section). */
  flatten: number;
  /** Body cross-section width:height ratio (1 = round). Independent of
   *  `flatten`; scales the ring's width/height area-preservingly. */
  aspect?: number;
  /** Extra absolute chord width (m) added to the wide axis — used to
   *  give membrane limbs a wing chord proportional to limb length. */
  chordBoost?: number;
  /** Per-ring color override (the muzzle keratin tint), else loft colors. */
  colorBase?: THREE.Color;
  colorBelly?: THREE.Color;
  /** Bite-plane clip (world Y): keep the arc on one side of `planeY` and
   *  flatten the rest onto it — the FLAT cut face of a jaw. keep +1 = keep
   *  above (upper jaw / palate below), −1 = keep below (lower jaw / floor
   *  above). Flattened verts take `color` (the dark mouth interior);
   *  `skinRim` keeps the snapped CREASE verts surface-colored (a cheek
   *  seam that must not read as a dark band — only the lip line and the
   *  interior stay dark). `rimSnap: false` records the crossings in the
   *  rims WITHOUT snapping boundary verts to them — the shell's surface
   *  simply ends at the kept verts and the cheek membrane (permanently
   *  attached to that outermost edge) owns the region below. */
  clip?: { planeY: number; keep: number; color: THREE.Color; skinRim?: boolean; rimSnap?: boolean };
  /** Soft-tissue displacement (skull rings only): pushes each vertex out
   *  along its normal by the padding + any nearby bulges. */
  tissue?: TissueField;
  /** Skin binding: boneB only used when weightA < 1. */
  boneA: number;
  boneB: number;
  weightA: number;
}

interface RingColors {
  base: THREE.Color;
  belly: THREE.Color;
}

const _q = new THREE.Quaternion();
const _tmpColor = new THREE.Color();
const _tissueN = new THREE.Vector3();

/** One recorded edge point: position + the SURFACE color the loft gave
 *  that spot (base↔belly blend, per-ring tints) — a membrane stitched to
 *  it can match the shells' coloration exactly, not just their shape. */
interface RimPoint {
  p: THREE.Vector3;
  c: THREE.Color;
}

/** The crease points where a clipped ring's arc actually crosses its cut
 *  plane — ON the emitted mesh edge (the snapped boundary verts), so a
 *  membrane stitched to them attaches with no gap — plus the adjacent KEPT
 *  verts (`outerLeft/Right`): the ring's outermost surviving edge, one step
 *  outside the cut. Null when unclipped. */
interface RingRim {
  left: RimPoint | null;
  right: RimPoint | null;
  outerLeft: RimPoint | null;
  outerRight: RimPoint | null;
}

/** Loft a sequence of rings into a tube, parallel-transporting the frame.
 *  Returns the vertex index ranges of the first and last rings so the
 *  caller can cap them, plus each ring's clip-crease rim points. */
/** The frame and half-extents a loft ended on — everything needed to build a
 *  ring that MEETS the last ring rather than merely sitting near it. */
export interface LoftEnd {
  center: THREE.Vector3;
  direction: THREE.Vector3;
  /** Unit axes the ring's ellipse was drawn on: `rx` along side, `ry` along up. */
  side: THREE.Vector3;
  up: THREE.Vector3;
  rx: number;
  ry: number;
}

function loftChain(
  geo: GeoBuilder,
  rings: RingSpec[],
  sides: number,
  colors: RingColors,
  /** Frame to START on, instead of deriving one from world up. ⚠️ Required
   *  whenever `rings[0].points` were laid out on SOMEONE ELSE'S frame — a
   *  digit's base ring is cut from its sole's end ring, and a fresh frame
   *  wrings the toe round its own axis by whatever angle the two differ by.
   *  Must be orthonormal and perpendicular to `rings[0].direction`. */
  startFrame?: { side: THREE.Vector3; up: THREE.Vector3 },
): { firstRing: number; lastRing: number; rims: RingRim[]; end: LoftEnd } {
  // Initial frame: side = cross(worldUp, dir), fall back when vertical.
  let dir = rings[0].direction.clone();
  let side = startFrame ? startFrame.side.clone() : new THREE.Vector3(0, 1, 0).cross(dir);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  let up = startFrame
    ? startFrame.up.clone().normalize()
    : new THREE.Vector3().crossVectors(dir, side).normalize();

  let prevStart = -1;
  let firstRing = -1;
  const rims: RingRim[] = [];
  let end: LoftEnd | null = null;
  for (const ring of rings) {
    // Parallel-transport the frame onto this ring's direction.
    _q.setFromUnitVectors(dir, ring.direction);
    side = side.clone().applyQuaternion(_q).normalize();
    up = up.clone().applyQuaternion(_q).normalize();
    dir = ring.direction.clone();

    // Body cross-section: area-preserving width/height split, then the
    // membrane widen/flatten (wings/fins) composes on top.
    const aw = Math.sqrt(ring.aspect ?? 1);
    const ah = 1 / aw;
    const rx = ring.radius * aw * (1 + LOFT.membraneWiden * ring.flatten) + (ring.chordBoost ?? 0);
    const ry = ring.radius * ah * (1 - LOFT.membraneFlatten * ring.flatten);
    const start = geo.vertexCount;
    if (firstRing < 0) firstRing = start;
    end = { center: ring.center.clone(), direction: ring.direction.clone(), side: side.clone(), up: up.clone(), rx, ry };
    const ringBase = ring.colorBase ?? colors.base;
    const ringBelly = ring.colorBelly ?? colors.belly;

    // First pass — positions (soft tissue applied) + which side of the
    // clip plane each vertex falls on.
    const pos: THREE.Vector3[] = [];
    const wrong: boolean[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const p = ring.points
        ? ring.points[s].clone()
        : ring.center
          .clone()
          .addScaledVector(side, Math.cos(a) * rx)
          .addScaledVector(up, Math.sin(a) * ry);
      // Soft tissue: push the vertex out along its (radial) normal by the
      // padding + any nearby landmark bulges (cheeks, jowls, brow, …).
      if (ring.tissue) {
        _tissueN.copy(p).sub(ring.center);
        const nl = _tissueN.length() || 1;
        _tissueN.multiplyScalar(1 / nl);
        let push = ring.tissue.pad * ring.radius;
        for (const b of ring.tissue.bulges) {
          const dx = p.x - b.center.x, dy = p.y - b.center.y, dz = p.z - b.center.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          push += b.weight * Math.exp(-d2 / (2 * b.radius * b.radius));
        }
        if (push !== 0) p.addScaledVector(_tissueN, push);
      }
      pos.push(p);
      wrong.push(!!ring.clip &&
        (ring.clip.keep > 0 ? p.y < ring.clip.planeY : p.y > ring.clip.planeY));
    }

    // Bite-plane clip. The BOUNDARY verts of each clipped run snap to the
    // exact edge∩plane crossing — they stay ON the shell's outer surface
    // (the crease the cheek membrane stitches to). Only the INTERIOR verts
    // flatten onto the plane and tuck inside the rim (the roof/floor of
    // the mouth), so the mating shell hides them and coplanar palate/floor
    // can't z-fight.
    const rim: RingRim = { left: null, right: null, outerLeft: null, outerRight: null };
    // The surface color the loft would give a point of this ring — rims
    // record it so membranes can match the shells' coloration exactly.
    const surfCol = (p: THREE.Vector3): THREE.Color => {
      const downness = ring.radius > 1e-6
        ? THREE.MathUtils.clamp(0.5 - ((p.y - ring.center.y) / Math.max(ry, 1e-6)) * 0.6, 0, 1)
        : 0.5;
      return ringBase.clone().lerp(ringBelly, downness * downness);
    };
    if (ring.clip && wrong.some(Boolean)) {
      const planeY = ring.clip.planeY;
      const snapped = new Set<number>();
      if (!wrong.every(Boolean)) {
        const doSnap = ring.clip.rimSnap !== false;
        const kept = new Set<number>(); // kept verts adjacent to the cut
        const crossings: THREE.Vector3[] = [];
        const crossing = (keep: number, cut: number): THREE.Vector3 => {
          const a = pos[keep], b = pos[cut];
          const t = Math.abs(b.y - a.y) > 1e-9 ? (planeY - a.y) / (b.y - a.y) : 0;
          return a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1));
        };
        for (let s = 0; s < sides; s++) {
          const n = (s + 1) % sides;
          if (!wrong[s] && wrong[n] && !snapped.has(n)) {
            const cp = crossing(s, n);
            crossings.push(cp);
            if (doSnap) { pos[n] = cp; snapped.add(n); }
            kept.add(s);
          } else if (wrong[s] && !wrong[n] && !snapped.has(s)) {
            const cp = crossing(n, s);
            crossings.push(cp);
            if (doSnap) { pos[s] = cp; snapped.add(s); }
            kept.add(n);
          }
        }
        let L: THREE.Vector3 | null = null, R: THREE.Vector3 | null = null;
        for (const cp of crossings) {
          if (!R || cp.x > R.x) R = cp;
          if (!L || cp.x < L.x) L = cp;
        }
        rim.left = L ? { p: L, c: surfCol(L) } : null;
        rim.right = R ? { p: R, c: surfCol(R) } : null;
        let oL: THREE.Vector3 | null = null, oR: THREE.Vector3 | null = null;
        for (const s of kept) {
          if (!oR || pos[s].x > oR.x) oR = pos[s];
          if (!oL || pos[s].x < oL.x) oL = pos[s];
        }
        rim.outerLeft = oL ? { p: oL.clone(), c: surfCol(oL) } : null;
        rim.outerRight = oR ? { p: oR.clone(), c: surfCol(oR) } : null;
      }
      // Roof (keep>0) and floor (keep<0) both flatten to the plane; the
      // floor drops a hair below so the coincident cut faces can't z-fight.
      const flatY = planeY - (ring.clip.keep < 0 ? ring.radius * 0.012 : 0);
      for (let s = 0; s < sides; s++) {
        if (!wrong[s] || snapped.has(s)) continue;
        pos[s].y = flatY;
        pos[s].x = ring.center.x + (pos[s].x - ring.center.x) * 0.93;
        pos[s].z = ring.center.z + (pos[s].z - ring.center.z) * 0.97;
      }
      // A skin-rim crease takes the surface color below (no dark band
      // bleeding onto the cheek) — drop it from the clipped set.
      if (ring.clip.skinRim) for (const s of snapped) wrong[s] = false;
    }
    rims.push(rim);

    // Second pass — emit (interior clipped verts take the clip color:
    // the mouth interior / lip-seam tint).
    for (let s = 0; s < sides; s++) {
      if (wrong[s]) {
        geo.vertex(pos[s], ring.clip!.color, ring.boneA, ring.boneB, ring.weightA);
      } else {
        // Belly blend: how far below the ring center the vertex sits.
        const downness = ring.radius > 1e-6
          ? THREE.MathUtils.clamp(0.5 - ((pos[s].y - ring.center.y) / Math.max(ry, 1e-6)) * 0.6, 0, 1)
          : 0.5;
        _tmpColor.copy(ringBase).lerp(ringBelly, downness * downness);
        geo.vertex(pos[s], _tmpColor, ring.boneA, ring.boneB, ring.weightA);
      }
    }
    if (prevStart >= 0) {
      for (let s = 0; s < sides; s++) {
        const sn = (s + 1) % sides;
        geo.quad(prevStart + s, prevStart + sn, start + sn, start + s);
      }
    }
    prevStart = start;
  }
  return { firstRing, lastRing: prevStart, rims, end: end! };
}

/** Cap a ring with a triangle fan to a center point. `flip` controls
 *  winding (cap at the START of a loft faces backward). */
function capRing(
  geo: GeoBuilder,
  ringStart: number,
  sides: number,
  center: THREE.Vector3,
  color: THREE.Color,
  boneA: number,
  flip: boolean,
): void {
  const c = geo.vertex(center, color, boneA, 0, 1);
  for (let s = 0; s < sides; s++) {
    const sn = (s + 1) % sides;
    if (flip) geo.tri(c, ringStart + sn, ringStart + s);
    else geo.tri(c, ringStart + s, ringStart + sn);
  }
}

/** Centre of digit `k` of `n` along the sole's wide axis, measured from the
 *  ring centre: the slots tile `[-rx, +rx]`, so slot k spans
 *  `[-rx + 2rx·k/n, -rx + 2rx·(k+1)/n]`. */
function slotCenterU(rx: number, k: number, n: number): number {
  return n > 1 ? -rx + (2 * rx * (k + 0.5)) / n : 0;
}

/**
 * The base ring for one digit: the sole's end POLYGON clipped to that digit's
 * slot, sampled at the same `sides` angles the digit's own rings use.
 *
 * Both shapes are convex — the end ring is a regular `sides`-gon on the
 * ellipse (rx, ry), the slot is a slab — so their intersection is convex and a
 * ray from the slot's centre meets its boundary exactly once. That makes the
 * sampling ORDER match a plain ellipse ring's, so the loft to the digit's tip
 * carries no twist, and it makes the slices EXACT: adjacent digits share their
 * dividing chord and the union is the whole polygon, so the row seals the sole
 * with no flat left between toes. ⚠️ Clip against the POLYGON, not the ideal
 * ellipse the polygon is inscribed in, or the seal leaks at every chord.
 */
function digitBasePoints(
  end: LoftEnd,
  k: number,
  n: number,
  sides: number,
): THREE.Vector3[] {
  const { rx, ry } = end;
  const cu = slotCenterU(rx, k, n);
  const uLo = n > 1 ? -rx + (2 * rx * k) / n : -rx;
  const uHi = n > 1 ? -rx + (2 * rx * (k + 1)) / n : rx;
  // Half-planes: the polygon's edges, then the slot's two chords. Each is
  // `a·u + b·v <= c` with the slot centre strictly inside.
  const half: Array<{ a: number; b: number; c: number }> = [];
  for (let i = 0; i < sides; i++) {
    const a0 = ((i / sides) * Math.PI * 2), a1 = (((i + 1) / sides) * Math.PI * 2);
    const p0 = { u: Math.cos(a0) * rx, v: Math.sin(a0) * ry };
    const p1 = { u: Math.cos(a1) * rx, v: Math.sin(a1) * ry };
    const nu = p1.v - p0.v, nv = -(p1.u - p0.u); // outward for CCW winding
    half.push({ a: nu, b: nv, c: nu * p0.u + nv * p0.v });
  }
  half.push({ a: 1, b: 0, c: uHi });
  half.push({ a: -1, b: 0, c: -uLo });

  const pts: THREE.Vector3[] = [];
  for (let sIdx = 0; sIdx < sides; sIdx++) {
    const ang = (sIdx / sides) * Math.PI * 2;
    const du = Math.cos(ang), dv = Math.sin(ang);
    let t = Infinity;
    for (const h of half) {
      const denom = h.a * du + h.b * dv;
      if (denom <= 1e-12) continue; // parallel or moving inward
      const hit = (h.c - (h.a * cu + h.b * 0)) / denom;
      if (hit >= 0 && hit < t) t = hit;
    }
    if (!Number.isFinite(t)) t = 0;
    pts.push(
      end.center
        .clone()
        .addScaledVector(end.side, cu + du * t)
        .addScaledVector(end.up, dv * t),
    );
  }
  return pts;
}

// ── Growth lofting ───────────────────────────────────────────────────────
// Growth segments are rigid geometry welded to ONE bone (no bones of
// their own — see skeleton.ts pass 8.5), so they get their own small
// emitters instead of the skinned chain path. The growth loft also does
// two things the shared loftChain deliberately doesn't: per-ring LOBES
// (cactus ribs) and the blade RIBBON representation for flatten ≥ ~0.7
// (grass — a two-sided strip, not a tube).

/** Flatten value at which a growth run switches from tube to ribbon. */
const GROWTH_RIBBON_FLATTEN = 0.7;
/** Ring sides per branch level — twigs don't deserve trunk polygons. */
const GROWTH_SIDES = [6, 5, 4, 3, 3];

interface GrowthRing {
  center: THREE.Vector3;
  direction: THREE.Vector3;
  radius: number;
  lobes: number;
  flatten: number;
}

/** Loft one growth branch run as a tube: parallel-transported frame,
 *  optional rib lobes, mild flattening below the ribbon threshold. */
function loftGrowthRun(
  geo: GeoBuilder,
  rings: GrowthRing[],
  sides: number,
  color: THREE.Color,
  bone: number,
): { firstRing: number; lastRing: number } {
  let dir = rings[0].direction.clone();
  let side = new THREE.Vector3(0, 1, 0).cross(dir);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  let up = new THREE.Vector3().crossVectors(dir, side).normalize();

  let prevStart = -1;
  let firstRing = -1;
  for (const ring of rings) {
    _q.setFromUnitVectors(dir, ring.direction);
    side = side.clone().applyQuaternion(_q).normalize();
    up = up.clone().applyQuaternion(_q).normalize();
    dir = ring.direction.clone();

    const rx = ring.radius * (1 + 0.7 * ring.flatten);
    const ry = ring.radius * (1 - 0.55 * ring.flatten);
    const start = geo.vertexCount;
    if (firstRing < 0) firstRing = start;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      // Cactus ribs: scallop the ring radius. Depth eases off for high
      // lobe counts so the silhouette stays solid.
      const rib = ring.lobes > 0 ? 1 - 0.16 * (0.5 + 0.5 * Math.cos(ring.lobes * a)) : 1;
      const p = ring.center
        .clone()
        .addScaledVector(side, Math.cos(a) * rx * rib)
        .addScaledVector(up, Math.sin(a) * ry * rib);
      geo.vertex(p, color, bone, 0, 1);
    }
    if (prevStart >= 0) {
      for (let s = 0; s < sides; s++) {
        const sn = (s + 1) % sides;
        geo.quad(prevStart + s, prevStart + sn, start + sn, start + s);
      }
    }
    prevStart = start;
  }
  return { firstRing, lastRing: prevStart };
}

/** Emit one growth branch run as a two-sided blade ribbon (grass). The
 *  blade lies across `cross(dir, worldUp)` and tapers with the radius. */
function emitGrowthRibbon(
  geo: GeoBuilder,
  rings: GrowthRing[],
  color: THREE.Color,
  bone: number,
): void {
  if (rings.length < 2) return;
  // Two mirrored single-face strips (separate vertices — shared flipped
  // verts would corrupt computeVertexNormals).
  for (const flip of [false, true]) {
    let prevL = -1;
    let prevR = -1;
    for (const ring of rings) {
      const side = new THREE.Vector3(0, 1, 0).cross(ring.direction);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const w = ring.radius * 2.2;
      const l = geo.vertex(ring.center.clone().addScaledVector(side, -w), color, bone, 0, 1);
      const r = geo.vertex(ring.center.clone().addScaledVector(side, w), color, bone, 0, 1);
      if (prevL >= 0) {
        if (flip) geo.quad(prevR, prevL, l, r);
        else geo.quad(prevL, prevR, r, l);
      }
      prevL = l;
      prevR = r;
    }
  }
}

/** Emit one leaf/petal as a double-faced diamond card (2 tris per face,
 *  separate vertices per face so normals stay sane). */
function emitLeafCard(
  geo: GeoBuilder,
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  normal: THREE.Vector3,
  lengthM: number,
  widthM: number,
  color: THREE.Color,
  bone: number,
): void {
  const across = new THREE.Vector3().crossVectors(normal, dir).normalize();
  const mid = pos.clone().addScaledVector(dir, lengthM * 0.45);
  const tip = pos.clone().addScaledVector(dir, lengthM);
  const left = mid.clone().addScaledVector(across, -widthM * 0.5);
  const right = mid.clone().addScaledVector(across, widthM * 0.5);
  for (const flip of [false, true]) {
    const vBase = geo.vertex(pos, color, bone, 0, 1);
    const vL = geo.vertex(left, color, bone, 0, 1);
    const vR = geo.vertex(right, color, bone, 0, 1);
    const vTip = geo.vertex(tip, color, bone, 0, 1);
    if (flip) {
      geo.tri(vBase, vL, vTip);
      geo.tri(vBase, vTip, vR);
    } else {
      geo.tri(vBase, vTip, vL);
      geo.tri(vBase, vR, vTip);
    }
  }
}

/** Number of dome rings added at each pole to round it (a wide end reads
 *  as a dome, a narrow one as a point — no separate "pointed" flag). */
const FRUIT_POLE_RINGS = 2;
/** Pole dome depth as a fraction of the end ring's radius — a SHALLOW cap
 *  (< 1 = flattened pole, so wide-ended fruit doesn't stretch tall). */
const FRUIT_POLE_ROUND = 0.55;

/** Emit a fruit BODY: a profiled ring list (built by growth.ts along a
 *  possibly-curved centerline) lofted with the shared growth lofter (so
 *  cactus-style `lobes` come for free). The two poles are rounded with a
 *  quarter-circle dome sized to each end's radius, so a wide end domes and
 *  a taper-to-nothing end points — with NO cone artifact.
 *
 *  `detail` (0..1) is the LOD dial: at 1 the body keeps every ring, a
 *  lobe-aware side count, and full pole domes; below ~0.75 it drops lobes
 *  (ribs are invisible at distance) and thins sides, and below ~0.6 it
 *  subsamples the body rings and flattens the domes. A coarse fruit is a
 *  smooth few-ring blob — the same silhouette, a third the geometry. */
function emitFruitProfile(
  geo: GeoBuilder,
  fruitRings: Array<{ center: Vec3; radius: number }>,
  lobes: number,
  baseSides: number,
  color: THREE.Color,
  bone: number,
  detail = 1,
): void {
  const nIn = fruitRings.length;
  if (nIn < 2) return;
  // Coarse tiers drop the ribs (they alias/vanish at distance) and thin
  // the ring; a lobed fruit at full detail needs enough sides to resolve
  // every rib.
  const keepLobes = detail >= 0.75 ? lobes : 0;
  const sides = keepLobes > 0
    ? Math.min(28, Math.max(baseSides, keepLobes * 3))
    : Math.max(4, Math.round(baseSides * Math.min(1, detail + 0.25)));
  const poleRings = detail < 0.6 ? 1 : FRUIT_POLE_RINGS;

  // Subsample the body rings to the detail budget, always keeping the two
  // endpoints (they carry length + curvature).
  const targetRings = Math.max(3, Math.round(nIn * detail));
  const picked: Array<{ center: Vec3; radius: number }> = [];
  if (targetRings >= nIn) {
    picked.push(...fruitRings);
  } else {
    for (let k = 0; k < targetRings; k++) {
      picked.push(fruitRings[Math.round((k * (nIn - 1)) / (targetRings - 1))]);
    }
  }
  const n = picked.length;

  const dirAt = (i: number): THREE.Vector3 => {
    const a = picked[Math.max(0, i - 1)].center;
    const b = picked[Math.min(n - 1, i + 1)].center;
    const d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    return d.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : d.normalize();
  };
  const body: GrowthRing[] = picked.map((r, i) => ({
    center: new THREE.Vector3(r.center.x, r.center.y, r.center.z),
    direction: dirAt(i),
    radius: r.radius,
    lobes: keepLobes,
    flatten: 0,
  }));

  // Shallow dome rings stepping OUT from an end ring toward its pole: the
  // radius closes along a quarter-circle (so the surface stays smooth into
  // the cap) while the axial depth is only FRUIT_POLE_ROUND × radius, so a
  // wide end reads as a flattened dome and a taper-to-nothing end a point.
  const dome = (end: GrowthRing, outward: THREE.Vector3): GrowthRing[] => {
    const out: GrowthRing[] = [];
    for (let k = 1; k <= poleRings; k++) {
      const ang = (k / (poleRings + 1)) * (Math.PI / 2);
      out.push({
        center: end.center.clone().addScaledVector(outward, end.radius * FRUIT_POLE_ROUND * Math.sin(ang)),
        direction: end.direction.clone(),
        radius: Math.max(1e-4, end.radius * Math.cos(ang)),
        lobes: keepLobes,
        flatten: 0,
      });
    }
    return out;
  };
  const baseOut = body[0].direction.clone().negate();
  const tipOut = body[n - 1].direction.clone();
  const rings: GrowthRing[] = [
    ...dome(body[0], baseOut).reverse(),
    ...body,
    ...dome(body[n - 1], tipOut),
  ];

  const { firstRing, lastRing } = loftGrowthRun(geo, rings, sides, color, bone);
  capRing(geo, firstRing, sides, body[0].center.clone().addScaledVector(baseOut, body[0].radius * FRUIT_POLE_ROUND), color, bone, true);
  capRing(geo, lastRing, sides, body[n - 1].center.clone().addScaledVector(tipOut, body[n - 1].radius * FRUIT_POLE_ROUND), color, bone, false);
}

/** Build one fruit as a standalone MARKET ITEM — a plain static Mesh whose
 *  base pole sits at the origin, oriented up +Y, at the fruit's real
 *  `sizeM`. Full shape (profile / curvature / lobes / crown). `scale`
 *  multiplies the intrinsic size; `detail` (0..1) is the LOD dial for
 *  cheap distant/instanced copies (1 = full). */
export function buildFruitMesh(fruit: GrowthFruitBlueprint, scale = 1, detail = 1): THREE.Mesh {
  const geo = new GeoBuilder();
  const structure = standaloneFruitStructure({ ...fruit, sizeM: fruit.sizeM * scale });
  const inst = structure.fruits[0];
  if (inst) emitFruitProfile(geo, inst.rings, inst.lobes, 8, new THREE.Color(fruit.color), 0, detail);
  // Crown/calyx leaves read as green foliage regardless of fruit color.
  const leafColor = new THREE.Color("#3f7a34");
  for (const lf of structure.leaves) {
    emitLeafCard(geo, vec(lf.pos), vec(lf.dir), vec(lf.normal), lf.lengthM, lf.widthM, leafColor, 0);
  }
  const g = geo.build();
  // Skin attributes are inert on a non-skinned mesh; drop them.
  g.deleteAttribute("skinIndex");
  g.deleteAttribute("skinWeight");
  const mesh = new THREE.Mesh(g, surfaceMaterial({ roughness: 0.7 }));
  mesh.geometry.computeBoundingSphere();
  return mesh;
}

// ── Helpers over skeleton data ───────────────────────────────────────────

const vec = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v.x, v.y, v.z);

const boneDir = (b: CreatureBone): THREE.Vector3 =>
  vec(b.tail).sub(vec(b.head)).normalize();

/** Rings for one bone chain: one at the chain head, one per joint
 *  (direction averaged across the joint, weight split 50/50), one at the
 *  chain tail. `boneIndexOf` maps chain-array position → skeleton index. */
function chainRings(chain: CreatureBone[], boneIndexOf: (i: number) => number): RingSpec[] {
  const rings: RingSpec[] = [];
  for (let i = 0; i <= chain.length; i++) {
    if (i === 0) {
      const b = chain[0];
      rings.push({
        center: vec(b.head),
        direction: boneDir(b),
        radius: b.radiusHead,
        flatten: b.flatten,
        aspect: b.aspect,
        boneA: boneIndexOf(0),
        boneB: boneIndexOf(0),
        weightA: 1,
      });
    } else if (i === chain.length) {
      const b = chain[i - 1];
      rings.push({
        center: vec(b.tail),
        direction: boneDir(b),
        radius: b.radiusTail,
        flatten: b.flatten,
        aspect: b.aspect,
        boneA: boneIndexOf(i - 1),
        boneB: boneIndexOf(i - 1),
        weightA: 1,
      });
    } else {
      const a = chain[i - 1];
      const b = chain[i];
      rings.push({
        center: vec(b.head),
        direction: boneDir(a).add(boneDir(b)).normalize(),
        radius: (a.radiusTail + b.radiusHead) / 2,
        flatten: (a.flatten + b.flatten) / 2,
        aspect: (a.aspect + b.aspect) / 2,
        boneA: boneIndexOf(i - 1),
        boneB: boneIndexOf(i),
        weightA: 0.5,
      });
    }
  }
  return rings;
}

// ── Clothing ─────────────────────────────────────────────────────────────

/**
 * Emit an OUTFIT (clothing.ts) as offset shells re-lofted over the SAME rings
 * the body used — same bones, same weights — so garments deform with every
 * gait/pose in both the dynamic and baked paths and the dressed creature stays
 * ONE draw call. Nothing is species-specific: a torso garment covers a SPINE
 * SPAN (rear 0 → front 1) plus partial sleeves on whatever limbs ROOT inside
 * that span; a hat rides the skull landmarks (a headless creature wears none).
 * The same shirt is a shirt on a human, a blanket on a quadruped, a tube on a
 * snake.
 */
function emitOutfit(
  geo: GeoBuilder,
  skel: CreatureSkeleton,
  blueprint: Blueprint,
  outfit: NonNullable<Blueprint["outfit"]>,
  chains: Map<string, { bones: CreatureBone[]; indices: number[] }>,
  sides: number,
): void {
  const garments = outfit.garments;
  const spine = chains.get("spine")!;
  const headIdx = chains.get("head")!.indices[0];
  // Garments (clothing.ts) are OFFSET SHELLS re-lofted over the SAME rings
  // the body used — same bones, same weights — so they deform with every
  // gait/pose in both the dynamic and baked paths and the dressed creature
  // stays ONE draw call. Nothing is species-specific: a torso garment covers
  // a SPINE SPAN (rear 0 → front 1) plus partial sleeves on whatever limbs
  // ROOT inside that span; a hat rides the skull landmarks. The same shirt
  // is a shirt on a human, a blanket on a quadruped, a tube on a snake.
  // Fresh spine rings (the axial set was junction-tweaked); ring 0 = REAR.
  const trunkRings = chainRings(spine.bones, (i) => spine.indices[Math.min(i, spine.indices.length - 1)]);
  const cumOf = (rings: RingSpec[]): { cum: number[]; total: number } => {
    const cum = [0];
    for (let i = 1; i < rings.length; i++) cum.push(cum[i - 1] + rings[i].center.distanceTo(rings[i - 1].center));
    return { cum, total: cum[cum.length - 1] || 1 };
  };
  /** Interpolated copy of the ring at fraction `f` of the chain's length. */
  const ringAtFrac = (rings: RingSpec[], cum: number[], total: number, f: number): RingSpec => {
    const d = Math.min(1, Math.max(0, f)) * total;
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const t = (d - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i]);
    const a = rings[i];
    const b = rings[i + 1];
    return {
      center: a.center.clone().lerp(b.center, t),
      direction: a.direction.clone().lerp(b.direction, t).normalize(),
      radius: a.radius + (b.radius - a.radius) * t,
      flatten: a.flatten + (b.flatten - a.flatten) * t,
      aspect: (a.aspect ?? 1) + ((b.aspect ?? 1) - (a.aspect ?? 1)) * t,
      chordBoost: (a.chordBoost ?? 0) + ((b.chordBoost ?? 0) - (a.chordBoost ?? 0)) * t,
      boneA: t < 0.5 ? a.boneA : b.boneA,
      boneB: t < 0.5 ? a.boneB : b.boneB,
      weightA: t < 0.5 ? a.weightA : b.weightA,
    };
  };
  /** Clean copies of the rings spanning [f0, f1], with exact interpolated
   *  hem rings at both boundaries. */
  const sliceRings = (rings: RingSpec[], f0: number, f1: number): RingSpec[] => {
    const { cum, total } = cumOf(rings);
    const out: RingSpec[] = [ringAtFrac(rings, cum, total, f0)];
    rings.forEach((r, i) => {
      const f = cum[i] / total;
      if (f > f0 + 1e-4 && f < f1 - 1e-4) {
        out.push({ ...r, center: r.center.clone(), direction: r.direction.clone() });
      }
    });
    out.push(ringAtFrac(rings, cum, total, f1));
    return out;
  };
  /** Turn body rings into a fabric shell: inflate (fit + a hem/cuff ease
   *  that grows toward `easeEnd`), recolor, band the trim rings. */
  const fabricize = (
    rings: RingSpec[],
    g: GarmentBlueprint,
    fabric: THREE.Color,
    trim: THREE.Color,
    opts2: { trimFirst?: boolean; trimLast?: boolean; easeEnd?: "first" | "last" },
  ): void => {
    rings.forEach((r, i) => {
      const t = rings.length > 1 ? i / (rings.length - 1) : 0;
      const ease = opts2.easeEnd === "last" ? t : opts2.easeEnd === "first" ? 1 - t : 0;
      r.radius += Math.max(r.radius * 0.08, 0.006) + r.radius * 0.12 * g.flare * ease;
      const banded = (opts2.trimFirst && i === 0) || (opts2.trimLast && i === rings.length - 1);
      r.colorBase = banded ? trim : fabric;
      r.colorBelly = banded ? trim : fabric;
    });
  };
  const emitShell = (rings: RingSpec[], capFirst: boolean, capLast: boolean): void => {
    if (rings.length < 2) return;
    const colors: RingColors = { base: rings[0].colorBase!, belly: rings[0].colorBelly! };
    const { firstRing, lastRing } = loftChain(geo, rings, sides, colors);
    const a = rings[0];
    const b = rings[rings.length - 1];
    // Caps sit flat at the hem plane; the body passing through hides the
    // interior, the visible annulus reads as the hem's underside.
    if (capFirst) capRing(geo, firstRing, sides, a.center.clone(), a.colorBase!, a.boneA, true);
    if (capLast) capRing(geo, lastRing, sides, b.center.clone(), b.colorBase!, b.boneA, false);
  };
  // Limb root stations in the clothing convention (rear 0 → front 1):
  // resolveLimbs stations are 0 chest .. 1 hip, so invert. Chains are named
  // `limb{flat}{L|R|r}` — parse the flat index back to its resolved limb.
  const resolved = resolveLimbs(blueprint).limbs;
  const limbFracOf = (chainName: string): number | null => {
    const m = /^limb(\d+)/.exec(chainName);
    if (!m) return null;
    const limb = resolved[Number(m[1])];
    return limb ? 1 - limb.station : null;
  };

  for (const g of garments) {
    geo.section(`garment:${g.kind}`);
    const fabric = new THREE.Color(g.color);
    const trim = new THREE.Color(g.accentColor);

    if (g.kind === "hat") {
      // A crown riding the braincase + an optional brim annulus. Ring plane
      // ⊥ the face-frame up; sized to cover the skull whatever its aspect.
      const lm = skel.head;
      if (!lm) continue; // headless wears no hat
      const up = vec(lm.up);
      const R = Math.max(lm.radius, lm.halfLen) * 1.06 + 0.004;
      const baseC = vec(lm.center).addScaledVector(up, lm.domeHalf * 0.45);
      const hCrown = Math.max(0.15, g.coverage) * lm.radius * 1.3;
      const ring = (h: number, r: number, c: THREE.Color): RingSpec => ({
        center: baseC.clone().addScaledVector(up, h),
        direction: up.clone(),
        radius: r,
        flatten: 0,
        colorBase: c,
        colorBelly: c,
        boneA: headIdx,
        boneB: headIdx,
        weightA: 1,
      });
      if (g.flare > 0.05) {
        // Brim: a shallow cone from the outer rim up to the crown base.
        const brim = [ring(-hCrown * 0.06, R * (1 + g.flare * 1.2), trim), ring(0.01, R, trim)];
        loftChain(geo, brim, sides, { base: trim, belly: trim });
      }
      const crown = [ring(0, R, trim), ring(hCrown * 0.55, R * 0.96, fabric), ring(hCrown, R * 0.62, fabric)];
      const { lastRing } = loftChain(geo, crown, sides, { base: fabric, belly: fabric });
      capRing(geo, lastRing, sides, baseC.clone().addScaledVector(up, hCrown + R * 0.12), fabric, headIdx, false);
      continue;
    }

    // Trunk span (rear 0 → front 1): shirt/dress hang from the FRONT end,
    // pants rise from the REAR end (clothing.ts coverage semantics).
    const span: [number, number] =
      g.kind === "pants" ? [0, Math.min(1, g.coverage)] : [Math.max(0, 1 - g.coverage), 1];
    const bodice = sliceRings(trunkRings, span[0], span[1]);
    fabricize(bodice, g, fabric, trim, {
      // Collar at the front end of a shirt/dress, waistband at a pants' top;
      // the open hem gets the flare ease.
      trimFirst: g.kind !== "pants",
      trimLast: g.kind === "pants",
      easeEnd: "first",
    });
    // The rear hem BEFORE the skirt widens it — the skirt hangs from here.
    const hem = bodice[0];
    emitShell(bodice, true, true);

    // DRESS: a skirt cone hung from the rear hem, dropping toward the
    // ground (world -Y — gravity, whatever the trunk's pitch), widening by
    // flare. Bound to the hem's bones, so it sways with the hip.
    if (g.kind === "dress") {
      const drop = Math.max(hem.radius * 0.6, hem.center.y * g.skirtLength);
      const steps = 3;
      const skirt: RingSpec[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        skirt.push({
          center: hem.center.clone().add(new THREE.Vector3(0, -drop * t, 0)),
          direction: new THREE.Vector3(0, -1, 0),
          radius: hem.radius * (1 + g.flare * 1.8 * t),
          flatten: 0,
          aspect: hem.aspect,
          colorBase: t === 1 ? trim : fabric,
          colorBelly: t === 1 ? trim : fabric,
          boneA: hem.boneA,
          boneB: hem.boneB,
          weightA: hem.weightA,
        });
      }
      emitShell(skirt, false, true);
    }

    // SLEEVES / PANT LEGS: partial shells over every limb chain whose ROOT
    // station falls inside the trunk span. `limbCoverage` is the fraction
    // of the limb the sleeve runs down; the cuff gets the trim band.
    if (g.limbCoverage > 0.02) {
      for (const [name, chain] of chains) {
        if (!name.startsWith("limb")) continue;
        const frac = limbFracOf(name);
        if (frac === null || frac < span[0] || frac > span[1]) continue;
        const limbRings = chainRings(chain.bones, (i) => chain.indices[Math.min(i, chain.indices.length - 1)]);
        // Match the body loft's membrane chord so a sleeve follows a wing.
        const chainLen = chain.bones.reduce(
          (sum, b) => sum + Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z),
          0,
        );
        limbRings.forEach((r, i) => {
          const t = limbRings.length > 1 ? i / (limbRings.length - 1) : 0;
          r.chordBoost =
            r.flatten * chainLen * LOFT.membraneChordFrac * Math.sin(Math.PI * Math.min(1, t * 1.2)) ** 0.7;
        });
        const sleeve = sliceRings(limbRings, 0, Math.min(1, g.limbCoverage));
        fabricize(sleeve, g, fabric, trim, { trimLast: true, easeEnd: "last" });
        // Sink the root under the bodice so the join never shows.
        sleeve[0].center.addScaledVector(sleeve[0].direction, -sleeve[0].radius * 0.5);
        emitShell(sleeve, false, true);
      }
    }
  }
}

// ── Main entry ───────────────────────────────────────────────────────────

export function buildCreatureMesh(
  skel: CreatureSkeleton,
  blueprint: Blueprint,
  opts: { sides?: number; fruitDetail?: number; bareSkull?: boolean; toon?: boolean; debugTags?: boolean } = {},
): BuiltCreature {
  const t0 = performance.now();
  const sides = Math.max(5, Math.round(opts.sides ?? LOFT.sides));
  const fruitDetail = opts.fruitDetail ?? 1;
  const bareSkull = opts.bareSkull === true;
  const geo = new GeoBuilder(opts.debugTags === true);

  const base = new THREE.Color(blueprint.skin.baseColor);
  const belly = new THREE.Color(blueprint.skin.bellyColor);
  const accent = new THREE.Color(blueprint.skin.accentColor);
  const eyeColor = new THREE.Color("#14181c");
  const axialColors: RingColors = { base, belly };

  // Group bones by chain (chains are contiguous in skeleton.bones).
  const chains = new Map<string, { bones: CreatureBone[]; indices: number[] }>();
  skel.bones.forEach((b, i) => {
    let c = chains.get(b.chain);
    if (!c) {
      c = { bones: [], indices: [] };
      chains.set(b.chain, c);
    }
    c.bones.push(b);
    c.indices.push(i);
  });

  // ── Axial body: tail (tip→base) + spine (rear→front) + neck + head ────
  // Assembled as ONE ring sequence so the loft is seamless. The tail
  // chain points rearward, so its rings are generated reversed with the
  // loft direction negated (pointing forward, toward the torso).
  const axialRings: RingSpec[] = [];
  const tail = chains.get("tail");
  if (tail) {
    // The tail chain points rearward; reverse it (and swap each bone's
    // ends) so its rings loft tip→base, flowing into the spine.
    const reversed = [...tail.bones].reverse().map((b): CreatureBone => ({
      ...b,
      head: b.tail,
      tail: b.head,
      radiusHead: b.radiusTail,
      radiusTail: b.radiusHead,
    }));
    const revIndices = [...tail.indices].reverse();
    const rings = chainRings(reversed, (i) => revIndices[Math.min(i, revIndices.length - 1)]);
    // Drop the last ring (tail base) — the spine's first ring covers it.
    axialRings.push(...rings.slice(0, -1));
  }
  const spine = chains.get("spine")!;
  const spineRings = chainRings(spine.bones, (i) => spine.indices[Math.min(i, spine.indices.length - 1)]);
  // Blend the tail→spine junction weights: if a tail exists, the first
  // spine ring sits at the tail base; weight it across tail-base bone
  // and first torso bone for smooth bending.
  if (tail) {
    spineRings[0].boneB = tail.indices[0];
    spineRings[0].weightA = 0.5;
  }
  axialRings.push(...spineRings);

  const neck = chains.get("neck");
  if (neck) {
    const rings = chainRings(neck.bones, (i) => neck.indices[Math.min(i, neck.indices.length - 1)]);
    // First neck ring duplicates the spine's last ring position — skip
    // it, but re-weight the spine's last ring across the junction.
    const prev = axialRings[axialRings.length - 1];
    prev.boneB = neck.indices[0];
    prev.weightA = 0.5;
    axialRings.push(...rings.slice(1));
  }

  // Head — ONE fused skull (see skeleton.ts step 4 / skull-diagram.png +
  // forehead-diagram.png). The round cranium is a MATHEMATICAL guide, never
  // a rendered ball: the whole upper skull (cranium → forehead → upper jaw)
  // is a single loft whose rings are ray-cast against the skull-guide
  // union, so the axial loft ends at the neck and only the hinged LOWER
  // jaw is a separate (bite-cut) loft. Muzzle keratin rides per-ring colors.
  const headChain = chains.get("head")!;
  const headBone = headChain.bones[0];
  const headIdx = headChain.indices[0];
  const h = blueprint.head.beak;
  const kerat = h * h * 0.9 + h * 0.1;
  const muzzleBase = base.clone().lerp(accent, kerat);
  const muzzleBelly = belly.clone().lerp(accent, kerat);
  // Soft-tissue field over the skull (null when bare, or no head landmarks):
  // padding rounds the whole head out; landmark bulges fill the hollows
  // (cheeks, jowl, brow, the cranium→muzzle stop, lips).
  const headTissue: TissueField | null = (bareSkull || !skel.head) ? null : (() => {
    const hd = blueprint.head, lm = skel.head!;
    const C = vec(lm.center), F = vec(lm.braincaseAxis), U = vec(lm.up), S = vec(lm.side);
    const R = lm.radius, dome = lm.domeHalf, hl = lm.halfLen;
    const rBase = vec(lm.rostrumBase), rTip = vec(lm.rostrumTip), chin = vec(lm.chin);
    const at = (b: THREE.Vector3, f: number, s: number, u: number) =>
      b.clone().addScaledVector(F, f).addScaledVector(S, s).addScaledVector(U, u);
    const bulges: TissueBulge[] = [];
    // Cheeks / masseter — fill the triangle between the jaw ramus and the
    // cranium (the side of the face below and behind the eye).
    if (hd.cheek > 0) for (const sd of [-1, 1]) bulges.push({ center: at(C, -hl * 0.1, sd * R * 0.72, -dome * 0.45), radius: R * 0.7, weight: hd.cheek * R * 0.3 });
    // Muzzle pad — fills the forehead→snout stop so the face flows in.
    if (hd.muzzlePad > 0) bulges.push({ center: rBase.clone().addScaledVector(U, -dome * 0.08), radius: R * 0.6, weight: hd.muzzlePad * R * 0.24 });
    // Brow — pads over the eyes.
    if (hd.brow > 0) for (const sd of [-1, 1]) bulges.push({ center: at(C, hl * 0.5, sd * R * 0.45, dome * 0.35), radius: R * 0.45, weight: hd.brow * R * 0.18 });
    // Jowl — hangs under the jaw / throat.
    if (hd.jowl > 0) bulges.push({ center: chin.clone().addScaledVector(U, -R * 0.12).addScaledVector(F, -hl * 0.25), radius: R * 0.6, weight: hd.jowl * R * 0.32 });
    // Lips — thicken around the mouth line.
    if (hd.lips > 0) bulges.push({ center: rBase.clone().lerp(rTip, 0.5).addScaledVector(U, -R * 0.05), radius: R * 0.4, weight: hd.lips * R * 0.16 });
    // Chin — the mental protuberance, a forward boss at the mandible tip.
    // Uniquely human at high values; an ape's jawline recedes (0).
    if (hd.chin > 0) bulges.push({ center: chin.clone().addScaledVector(F, R * 0.1).addScaledVector(U, -R * 0.03), radius: R * 0.36, weight: hd.chin * R * 0.24 });
    return { pad: hd.padding * 0.22, bulges };
  })();
  // Evaluate the tissue thickness at a point (to keep the eyes at the fleshed
  // surface instead of sinking under the padding).
  const tissuePushAt = (p: THREE.Vector3): number => {
    if (!headTissue || !skel.head) return 0;
    let push = headTissue.pad * skel.head.radius;
    for (const b of headTissue.bulges) {
      const dx = p.x - b.center.x, dy = p.y - b.center.y, dz = p.z - b.center.z;
      push += b.weight * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * b.radius * b.radius));
    }
    return push;
  };
  {
    // The axial loft ENDS at the neck (or torso front): the skull is its
    // own fused surface below, so the last axial ring sinks toward the
    // cranium center and caps INSIDE the skull. The neck can meet the base
    // of the skull at any angle without deforming the back of the skull.
    const prev = axialRings[axialRings.length - 1];
    prev.boneB = headIdx;
    prev.weightA = 0.5;
    const target = skel.skull ? vec(skel.skull.cranium.center) : vec(headBone.tail);
    const inward = target.sub(prev.center);
    const dist = inward.length() || 1e-4;
    inward.multiplyScalar(1 / dist);
    axialRings.push({
      center: prev.center.clone().addScaledVector(inward, Math.min(dist * 0.55, prev.radius * 1.1)),
      direction: inward,
      radius: prev.radius * 0.72,
      flatten: 0, aspect: prev.aspect,
      boneA: headIdx, boneB: headIdx, weightA: 1,
    });
  }
  {
    geo.section("axial");
    const { firstRing, lastRing } = loftChain(geo, axialRings, sides, axialColors);
    const first = axialRings[0];
    capRing(
      geo, firstRing, sides,
      first.center.clone().addScaledVector(first.direction, -first.radius * 0.6),
      base, first.boneA, true,
    );
    // Close the neck stub off inside the skull.
    const last = axialRings[axialRings.length - 1];
    capRing(geo, lastRing, sides, last.center.clone().addScaledVector(last.direction, last.radius * 0.5), base, last.boneA, false);
  }

  // Bite plane (world Y) for a muzzle ring: the mouth line, `mouthVertical`
  // above/below the muzzle centre. The upper jaw keeps ABOVE it, the lower jaw
  // BELOW it; both flatten onto it and fit together.
  const mouthInner = new THREE.Color("#3a1d1a");

  // The JAWLINE — where the mandible separates from the upper skull. The
  // mandible is the WHOLE lower face (skull-diagram: the jaw runs from the
  // joint around the bottom of the head), so the line runs from the HINGE
  // forward to the bite plane at the muzzle root, then along the muzzle
  // stations' own bite planes. The upper skull is cut ABOVE it, the
  // mandible shell BELOW it, and the cheek membrane is stitched along it.
  const jawline = (() => {
    if (!skel.mouth || !skel.skull) return null;
    const sts = skel.skull.stations.slice(skel.skull.muzzleFrom);
    if (sts.length === 0 || sts[0].biteY === undefined) return null;
    const hinge = vec(skel.mouth.hinge);
    const rootZ = sts[0].center.z;
    const rootBite = sts[0].biteY;
    if (rootZ - hinge.z < 1e-4) return null;
    return {
      hinge, rootZ, rootBite,
      /** Cut height at longitudinal z; null behind the hinge (the occiput
       *  and skull base stay whole). */
      yAt(z: number): number | null {
        if (z <= hinge.z) return null;
        if (z >= rootZ) return rootBite; // muzzle stations use their own biteY
        return hinge.y + ((z - hinge.z) / (rootZ - hinge.z)) * (rootBite - hinge.y);
      },
    };
  })();

  // ── Skull: ONE fused surface over the guide union ───────────────────────
  // Rings march the sagittal centerline from the occiput to the snout tip.
  // Each ring hangs on a dorsal + ventral anchor pair (ray-cast from the
  // centerline), then every vertex ray-casts the union of cranium +
  // forehead/snout station ellipsoids — so cranium, forehead and upper jaw
  // are one continuous surface with no ball-with-parts-stuck-on seams, and
  // the sharp forehead turn of a human face can't fold the loft. Snout
  // rings are clipped flat at the bite plane (the palate) and tinted.
  // The skull's jawline/bite crease per side — REAL mesh-edge points (with
  // their surface colors) captured from the loft, rear → front, for the
  // cheek membrane to stitch to with no gap and no color step.
  let skullCrease: { left: RimPoint[]; right: RimPoint[] } | null = null;
  const lerpRim = (a: RimPoint, b: RimPoint, f: number): RimPoint => ({
    p: a.p.clone().lerp(b.p, f),
    c: a.c.clone().lerp(b.c, f),
  });
  // Clipped union rings, saved for the mandible: its rear shells reuse the
  // SAME point arrays with the opposite keep, so the two shells share the
  // exact crossing verts and mate with no seam band along the jawline.
  const complementRings: {
    points: THREE.Vector3[]; center: THREE.Vector3; dir: THREE.Vector3;
    radius: number; planeY: number;
  }[] = [];
  // The skull's LAST UNCUT ring — where the braincase dome cuts off at the
  // bottom. The throat stitch bridges it to the mandible's rear ring.
  let skullLastFull: { points: THREE.Vector3[]; center: THREE.Vector3; radius: number } | null = null;
  if (skel.skull) {
    geo.section("skull");
    const gd = skel.skull;
    const XV = new THREE.Vector3(1, 0, 0);
    const cast = (o: THREE.Vector3, d: THREE.Vector3) =>
      skullRaycast(gd, { x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
    const cC = vec(gd.cranium.center);
    const cF = vec(gd.cranium.dir); // forward
    const cU = new THREE.Vector3().crossVectors(cF, XV).normalize(); // sagittal up
    const aL = gd.cranium.halfLen, bH = gd.cranium.ry;
    // The cranium + forehead region lofts between paired DORSAL and VENTRAL
    // outline anchors, both swept from the cranium center (the region is
    // star-shaped from there): dorsal from the rear pole over the crown to
    // the muzzle-root TOP, ventral from the rear pole under the base to the
    // muzzle-root BOTTOM. Anchored planes rotate monotonically, so even the
    // near-vertical forehead drop of a human face cannot fold the loft.
    const muzzleSts = gd.stations.slice(gd.muzzleFrom);
    // The union sweep is star-shaped FROM THE CRANIUM CENTRE — that is what
    // lets it rotate monotonically and never fold. The MUZZLE breaks that
    // assumption the moment it pitches or curves far enough to rise into the
    // sweep's own angular range: rays meant for the cranium then land far up
    // the snout, and a single "cranium" ring splays along the muzzle instead
    // of cutting across it (rings spanning a third of the head in z). That is
    // the face coming apart at high pitch or curve.
    //
    // So the sweep sees ONLY the cranium and the forehead bridge. The muzzle
    // is lofted from its own station rings straight after, and does not need
    // — or want — to be visible to the sweep.
    const sweepGuide: SkullGuide = {
      cranium: gd.cranium,
      stations: gd.stations.slice(0, gd.muzzleFrom),
      muzzleFrom: gd.muzzleFrom,
      dorsal: [],
    };
    const castSweep = (o: THREE.Vector3, d: THREE.Vector3) =>
      skullRaycast(sweepGuide, { x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
    const root = muzzleSts[0];
    let aTopEnd = 0.12, aBotEnd = -0.12; // no muzzle: close at the front pole
    let rootTopV: THREE.Vector3 | null = null, rootBotV: THREE.Vector3 | null = null;
    if (root) {
      const rd = vec(root.dir);
      const rUp = new THREE.Vector3().crossVectors(rd, XV).normalize();
      rootTopV = vec(root.center).addScaledVector(rUp, root.ry);
      rootBotV = vec(root.center).addScaledVector(rUp, -root.ry);
      const angOf = (p: THREE.Vector3): number => {
        const rel = p.clone().sub(cC);
        return Math.atan2(rel.dot(cU) / bH, rel.dot(cF) / aL);
      };
      aTopEnd = angOf(rootTopV);
      aBotEnd = angOf(rootBotV);
    }
    const rings: RingSpec[] = [];
    const nU = Math.max(7, LOFT.headRings + 3); // union rings (rear → face)
    for (let k = 1; k < nU; k++) {
      // The sweep STOPS SHORT of the muzzle root. The muzzle's own station
      // ring is the ring at the root; emitting a second one there — pinned
      // to the root rim for its centre and axis, but RAY-CAST for its actual
      // vertices, so a different size — left a flat annulus of quads
      // standing in the z plane. That annulus IS the vertical plate above
      // the snout: a wall with no thickness, invisible to any sagittal
      // measure because the whole defect is in the cross-section.
      //
      // Rings also BUNCH toward the face (the exponent), because the bridge
      // is where the cross-section changes fastest and an under-sampled
      // bridge is a hard facet even without the duplicate ring.
      const u = Math.pow(k / nU, 0.8);
      // Dorsal sweep: rear pole (π) over the crown toward the root top.
      const at = Math.PI - u * (Math.PI - aTopEnd);
      // Ventral sweep: rear pole (π) under the base toward the root bottom.
      const ab = Math.PI + u * (Math.PI + aBotEnd);
      const anchor = (ang: number): THREE.Vector3 => {
        const dir = cF.clone().multiplyScalar(Math.cos(ang) * aL)
          .addScaledVector(cU, Math.sin(ang) * bH).normalize();
        const hit = castSweep(cC, dir);
        return cC.clone().addScaledVector(dir, hit ? hit.t : Math.min(aL, bH));
      };
      const top = anchor(at);
      const bottom = anchor(ab);
      const c = top.clone().add(bottom).multiplyScalar(0.5);
      const bHat = top.clone().sub(bottom);
      const halfB = Math.max(bHat.length() * 0.5, 1e-4);
      bHat.normalize();
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const dir = XV.clone().multiplyScalar(Math.cos(a)).addScaledVector(bHat, Math.sin(a)).normalize();
        const hit = castSweep(c, dir);
        pts.push(c.clone().addScaledVector(dir, hit ? hit.t : halfB));
      }
      // Forward of the hinge, the lower face belongs to the MANDIBLE: cut
      // the fixed skull at the jawline (the mandible shell renders that
      // region — from the SAME ring, see complementRings — and swings it).
      const jy = jawline ? jawline.yAt(c.z) : null;
      const ringDir = new THREE.Vector3().crossVectors(XV, bHat).normalize();
      if (jy !== null) {
        complementRings.push({ points: pts, center: c, dir: ringDir, radius: halfB, planeY: jy });
      }
      // Forward of a past-the-root mouth corner (mouthOpen > 1 — croc/
      // snake) the cheek region is OPEN mouth: the cut edge snaps crisp
      // and stays dark. Behind it (the normal case) the surface ends at
      // the outermost kept edge and the membrane owns the strip below —
      // rimSnap false, so no coplanar polygon sits under the membrane.
      const cornerOpen = gd.mouthCorner !== undefined && c.z > gd.mouthCorner.z;
      if (jy === null) skullLastFull = { points: pts, center: c, radius: halfB };
      rings.push({
        center: c, direction: ringDir,
        radius: halfB, flatten: 0, aspect: 1,
        points: pts,
        clip: jy !== null
          ? (cornerOpen
            ? { planeY: jy, keep: 1, color: mouthInner }
            : { planeY: jy, keep: 1, color: mouthInner, rimSnap: false })
          : undefined,
        tissue: headTissue ?? undefined,
        boneA: headIdx, boneB: headIdx, weightA: 1,
      });
    }
    // Muzzle proper: the EXACT station ellipses — the lower jaw is cut from
    // the same stations, so palate and floor mate at the bite plane.
    for (const st of muzzleSts) {
      const c = vec(st.center);
      const d = vec(st.dir);
      const upL = new THREE.Vector3().crossVectors(d, XV).normalize();
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        pts.push(c.clone()
          .addScaledVector(XV, Math.cos(a) * st.rx)
          .addScaledVector(upL, Math.sin(a) * st.ry));
      }
      rings.push({
        center: c, direction: d, radius: st.ry, flatten: 0, aspect: 1,
        points: pts,
        colorBase: muzzleBase, colorBelly: muzzleBelly,
        // Behind the commissure the crease is skin (cheek seam); forward
        // it stays dark — the visible lip line.
        clip: st.biteY !== undefined
          ? { planeY: st.biteY, keep: 1, color: mouthInner, skinRim: st.cheek === true }
          : undefined,
        tissue: headTissue ?? undefined,
        boneA: st.boneA ?? headIdx, boneB: st.boneB ?? headIdx,
        weightA: st.weightA ?? 1,
      });
    }
    const { firstRing, lastRing, rims } = loftChain(geo, rings, sides, axialColors);
    // Collect the skull edge the cheek membrane hangs from, out to the
    // commissure. Over the CRANIUM (union rings) it is PERMANENTLY the
    // outermost surviving edge — the head's silhouette edge — open or
    // closed (the membrane is the only surface between that edge and the
    // jaw rim; see rimSnap above). Over the muzzle it is the bite-line
    // crossing (the lip edge). A past-the-root corner (mouthOpen > 1)
    // TRIMS the union run at the corner z, with an interpolated end point
    // so the corner still slides continuously.
    {
      const uni: { z: number; L: RimPoint; R: RimPoint }[] = [];
      const mzL: RimPoint[] = [], mzR: RimPoint[] = [];
      rims.forEach((rm, i) => {
        const stIdx = i - (nU - 1); // rings 0..nU-2 are union rings
        if (stIdx < 0) {
          const L = rm.outerLeft ?? rm.left, R = rm.outerRight ?? rm.right;
          if (L && R) uni.push({ z: rings[i].center.z, L, R });
        } else if (muzzleSts[stIdx]?.cheek === true && rm.left && rm.right) {
          mzL.push(rm.left);
          mzR.push(rm.right);
        }
      });
      let covered = uni;
      const corner = gd.mouthCorner;
      if (corner) {
        covered = uni.filter((u) => u.z <= corner.z);
        const next = uni.find((u) => u.z > corner.z);
        const prev = covered[covered.length - 1];
        if (prev && next) {
          const f = (corner.z - prev.z) / Math.max(1e-6, next.z - prev.z);
          covered = [...covered, { z: corner.z, L: lerpRim(prev.L, next.L, f), R: lerpRim(prev.R, next.R, f) }];
        }
      }
      const left = [...covered.map((u) => u.L), ...mzL];
      const right = [...covered.map((u) => u.R), ...mzR];
      if (left.length >= 1) skullCrease = { left, right };
    }
    // Round the occiput off at the rear pole of the cranium guide.
    const pole = vec(gd.cranium.center).addScaledVector(vec(gd.cranium.dir), -gd.cranium.halfLen);
    capRing(geo, firstRing, sides, pole, base, headIdx, true);
    // A hard beak closes to a point; a squashed muzzle stays a flatter wall.
    const last = rings[rings.length - 1];
    const hasMuzzle = gd.stations.length > 0;
    const capExt = hasMuzzle ? (0.4 + 1.6 * h) * (1 - 0.7 * blueprint.head.muzzleSquash) : 0.6;
    capRing(geo, lastRing, sides,
      last.center.clone().addScaledVector(last.direction, last.radius * capExt),
      hasMuzzle ? muzzleBase : base, last.boneA, false);
  }

  // ── Mandible: the WHOLE lower face, hinge → chin ────────────────────────
  // The lower half of the head forward of the jaw hinge IS the mandible
  // (skull-diagram: the jaw runs from the joint around the bottom of the
  // head) — it is NOT the fixed skull ball. REAR shells are the head's own
  // lower-face cross-sections (ray-cast off the same guide union, so the
  // closed head is unchanged) cut BELOW the jawline; they flow into the
  // muzzle-based jaw body cut at the bite. The whole loft swings about the
  // hinge, taking cheek and chin with it.
  const jawChain = chains.get("jaw");
  if (jawChain && skel.mouth && skel.skull && jawline) {
    geo.section("mandible");
    const m = skel.mouth;
    const gdc = skel.skull;
    const XV = new THREE.Vector3(1, 0, 0);
    const cast = (o: THREE.Vector3, d: THREE.Vector3) =>
      skullRaycast(gdc, { x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
    const muzzleSts = gdc.stations.slice(gdc.muzzleFrom);
    const headRadius = headBone.radiusHead;
    const jawExtra = blueprint.head.jawDepth * headRadius;
    const jawOffZ = blueprint.head.jawOffset * headRadius * blueprint.head.snoutRadiusFrac * 0.5;
    const axisF = vec(gdc.cranium.dir);
    const hinge = jawline.hinge;
    const cg = Math.cos(m.gapeAngle), sg = Math.sin(m.gapeAngle);
    const swing = (p: THREE.Vector3): THREE.Vector3 => {
      if (m.gapeAngle <= 1e-5) return p;
      const y = p.y - hinge.y, z = p.z - hinge.z;
      p.y = hinge.y + y * cg - z * sg;
      p.z = hinge.z + y * sg + z * cg;
      return p;
    };
    const ramusIdx = skel.bones.findIndex((b) => b.id === "ramus0");
    const jaw0Idx = skel.bones.findIndex((b) => b.id === "jaw0");
    const nJawBones = skel.bones.filter((b) => b.id.startsWith("jaw")).length;
    const jawBoneAt = (i: number): number =>
      jaw0Idx >= 0 ? jaw0Idx + Math.min(i, Math.max(0, nJawBones - 1)) : headIdx;
    const root = muzzleSts[0];
    const rootC = vec(root.center);
    // ── The mandible's DEPTH FIELD, hinge → chin ─────────────────────────
    // At the muzzle root the mandible is still the head's own lower face —
    // the rear shells that precede it ARE the head's cross-sections — so it
    // has to start exactly as deep as the head hangs there, whatever
    // `jawDepth` says. `jawDepth` is the depth at the CHIN. The two are
    // joined by a smoothstep, which is flat at both ends, so neither the
    // handover from the rear shells nor the arrival at the chin creases.
    //
    // The rear shells END EXACTLY ON THE ROOT RIM — the union sweep that
    // produced them lands its last ring there — so the first muzzle ring
    // must carry NO extra depth at all, or the mandible steps off the head
    // the instant the muzzle begins. That step was the reported defect, and
    // it was NOT jawDepth's doing: the old field anchored on a straight-DOWN
    // raycast from the root, which measures how deep the whole head hangs
    // beneath that point — the bottom of the cranium, far below the rim the
    // shells actually hand over at. Every muzzled creature stepped, at any
    // jawDepth, including jawDepth 0.
    //
    // From there the depth reaches `jawDepth` early and HOLDS: it is the
    // mandible's depth ALONG the muzzle, not at one point — a massive jaw is
    // deep the whole way (a hyena, a hippo). Ramping to the tip instead puts
    // the entire depth at the chin, a wedge jutting off a slender jaw.
    const DEPTH_REACHED_AT = 0.6; // fraction of the muzzle the blend spans
    const muzzleExtra = (i: number): number => {
      const frac = muzzleSts.length > 1 ? i / (muzzleSts.length - 1) : 1;
      const t = Math.min(1, frac / DEPTH_REACHED_AT);
      return jawExtra * t * t * (3 - 2 * t); // smoothstep — flat at both ends
    };

    const rings: RingSpec[] = [];
    // Rear shells: the EXACT complements of the skull's clipped rings —
    // same point arrays, same plane, opposite keep. Both shells therefore
    // share the same snapped crossing verts and mate along the jawline
    // with no seam band (dark-bands.png was the mismatch of two
    // independently-sampled cut edges).
    for (const cr of complementRings) {
      // Forward of a past-the-root mouth corner the jaw's top rim is an
      // open mouth edge (dark); behind it a skin-colored cheek seam.
      const cornerOpen = gdc.mouthCorner !== undefined && cr.center.z > gdc.mouthCorner.z;
      rings.push({
        center: cr.center, direction: cr.dir,
        radius: cr.radius, flatten: 0, aspect: 1,
        points: cr.points,
        clip: { planeY: cr.planeY, keep: -1, color: mouthInner, skinRim: !cornerOpen },
        tissue: headTissue ?? undefined,
        boneA: ramusIdx >= 0 ? ramusIdx : headIdx,
        boneB: ramusIdx >= 0 ? ramusIdx : headIdx,
        weightA: 1,
      });
    }
    const nRear = complementRings.length;
    muzzleSts.forEach((st, i) => {
      if (st.biteY === undefined) return;
      const d = vec(st.dir);
      const upL = new THREE.Vector3().crossVectors(d, XV).normalize();
      const c = vec(st.center).addScaledVector(axisF, jawOffZ);
      const ry = st.ry + muzzleExtra(i);
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        pts.push(c.clone()
          .addScaledVector(XV, Math.cos(a) * st.rx)
          .addScaledVector(upL, Math.sin(a) * ry));
      }
      rings.push({
        center: c, direction: d, radius: ry, flatten: 0, aspect: 1,
        points: pts,
        colorBase: muzzleBase, colorBelly: muzzleBelly,
        // Skin crease behind the commissure; dark lip line forward of it.
        clip: { planeY: st.biteY, keep: -1, color: mouthInner, skinRim: st.cheek === true },
        tissue: headTissue ?? undefined,
        boneA: jawBoneAt(i), boneB: jawBoneAt(i), weightA: 1,
      });
    });
    const vStart = geo.vertexCount;
    const { firstRing, lastRing, rims } = loftChain(geo, rings, sides, axialColors);
    // Rear cap tucks back toward the hinge, inside the head.
    capRing(geo, firstRing, sides,
      rings[0].center.clone().add(new THREE.Vector3(0, 0, -Math.max(0, rings[0].center.z - hinge.z) * 0.6)),
      base, rings[0].boneA, true);
    const last = rings[rings.length - 1];
    capRing(geo, lastRing, sides, last.center.clone().addScaledVector(last.direction, last.radius * 0.4), muzzleBase, last.boneA, false);
    const vEnd = geo.vertexCount;
    // Swing the whole lower face open about the hinge.
    if (m.gapeAngle > 1e-5) {
      for (let i = vStart; i < vEnd; i++) {
        const y = geo.positions[3 * i + 1] - hinge.y, z = geo.positions[3 * i + 2] - hinge.z;
        geo.positions[3 * i + 1] = hinge.y + (y * cg - z * sg);
        geo.positions[3 * i + 2] = hinge.z + (y * sg + z * cg);
      }
    }
    // ── Throat stitch: bridge the two cut-off edges ──────────────────────
    // The braincase dome cuts off sharply at the bottom (its last UNCUT
    // ring) and the back of the mandible cuts off sharply at the back (its
    // rear complement ring). Bridge them directly: start at the bottom-
    // middle vertex of each and work up both sides, connecting each vertex
    // to its corresponding one — the rings come from the same anchored
    // sweep, so index s pairs them naturally. The front edge swings with
    // the jaw; when closed this reproduces the original smooth surface.
    if (skullLastFull && complementRings.length > 0) {
      geo.section("throat.stitch");
      const rear = skullLastFull;
      const front = complementRings[0];
      // The loft displaced these rings' verts by the tissue field before
      // emitting — replicate it so the stitch lands on the real edges.
      const tissuePos = (raw: THREE.Vector3, center: THREE.Vector3, radius: number): THREE.Vector3 => {
        const p = raw.clone();
        if (!headTissue) return p;
        const n = p.clone().sub(center);
        const nl = n.length() || 1;
        n.multiplyScalar(1 / nl);
        let push = headTissue.pad * radius;
        for (const b of headTissue.bulges) {
          const dx = p.x - b.center.x, dy = p.y - b.center.y, dz = p.z - b.center.z;
          push += b.weight * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * b.radius * b.radius));
        }
        if (push !== 0) p.addScaledVector(n, push);
        return p;
      };
      const colAt = (p: THREE.Vector3, cy: number, ry: number): THREE.Color => {
        const dn = THREE.MathUtils.clamp(0.5 - ((p.y - cy) / Math.max(ry, 1e-6)) * 0.6, 0, 1);
        return base.clone().lerp(belly, dn * dn);
      };
      const boneF = ramusIdx >= 0 ? ramusIdx : headIdx;
      let prevR = -1, prevF = -1;
      let firstK = -1, lastK = -1, firstR = -1, firstF = -1, lastR = -1, lastF = -1;
      for (let k = Math.floor(sides / 2); k <= sides; k++) {
        const s = k % sides;
        const f = tissuePos(front.points[s], front.center, front.radius);
        // Stop where the mandible ring rises past its cut — above that the
        // shells and membrane already own the surface.
        if (f.y > front.planeY) { prevR = -1; prevF = -1; continue; }
        const r = tissuePos(rear.points[s], rear.center, rear.radius);
        swing(f);
        const vR = geo.vertex(r, colAt(r, rear.center.y, rear.radius), headIdx, 0, 1);
        const vF = geo.vertex(f, colAt(f, front.center.y, front.radius), boneF, 0, 1);
        if (prevR >= 0) geo.quad(prevR, vR, vF, prevF);
        if (firstK < 0) { firstK = k; firstR = vR; firstF = vF; }
        lastK = k; lastR = vR; lastF = vF;
        prevR = vR; prevF = vF;
      }
      // One more fill on each SIDE: the strip ends one vertex short of the
      // jawline — bridge its end pair up to the mandible's rim crossing
      // (swung) and the skull ring's next vertex, closing the corner gap.
      const endFill = (kIn: number, kUp: number, leftEnd: boolean): void => {
        geo.section("throat.endFill");
        const sIn = ((kIn % sides) + sides) % sides;
        const sUp = ((kUp % sides) + sides) % sides;
        const fIn = tissuePos(front.points[sIn], front.center, front.radius);
        const fUp = tissuePos(front.points[sUp], front.center, front.radius);
        if (fUp.y <= front.planeY || Math.abs(fUp.y - fIn.y) < 1e-9) return;
        const t = THREE.MathUtils.clamp((front.planeY - fIn.y) / (fUp.y - fIn.y), 0, 1);
        const M = fIn.clone().lerp(fUp, t); // the ring's rim crossing
        swing(M);
        const A = tissuePos(rear.points[sUp], rear.center, rear.radius);
        const vM = geo.vertex(M, colAt(M, front.center.y, front.radius), boneF, 0, 1);
        const vA = geo.vertex(A, colAt(A, rear.center.y, rear.radius), headIdx, 0, 1);
        const vRend = leftEnd ? firstR : lastR;
        const vFend = leftEnd ? firstF : lastF;
        if (leftEnd) geo.quad(vRend, vFend, vM, vA);
        else geo.quad(vFend, vRend, vA, vM);
        // The remaining sliver between the mandible RING's own corner vertex
        // and this rim: the mandible loft ends at swing(fUp) (its s0/s4
        // corner), one step off the rim crossing vM — join that corner to
        // vM and the skull corner vA. (User: "join 286 and 287 to 146.")
        const vUp = geo.vertex(swing(fUp.clone()), colAt(fUp, front.center.y, front.radius), boneF, 0, 1);
        if (leftEnd) geo.tri(vUp, vA, vM);
        else geo.tri(vUp, vM, vA);
        // …and the apex sliver, right up to the hinge: close onto the same
        // hinge-surface point the cheek membrane anchors to.
        const sideSign = leftEnd ? -1 : 1;
        const hsHit = cast(hinge, new THREE.Vector3(sideSign, 0, 0));
        const apex = hinge.clone().addScaledVector(new THREE.Vector3(sideSign, 0, 0), hsHit ? hsHit.t : 0);
        const vApex = geo.vertex(apex, colAt(apex, rear.center.y, rear.radius), headIdx, 0, 1);
        if (leftEnd) geo.tri(vA, vM, vApex);
        else geo.tri(vM, vA, vApex);
        // …and the "earhole": the skull's transition band dives inward
        // between the last-full ring vertex and the membrane's first upper
        // rim point — one triangle from those two onto the apex seals it.
        const crease = leftEnd ? skullCrease?.left : skullCrease?.right;
        if (crease && crease.length > 0) {
          const o1 = crease[0];
          const vO1 = geo.vertex(o1.p, o1.c, headIdx, 0, 1);
          if (leftEnd) geo.tri(vO1, vA, vApex);
          else geo.tri(vA, vO1, vApex);
        }
      };
      if (firstK >= 0) {
        endFill(firstK, firstK - 1, true);
        endFill(lastK, lastK + 1, false);
      }
    }

    // The mandible's crease out to the commissure — swung with the jaw
    // (rims were recorded at rest). Rings 0..nRear-1 are the rear shells;
    // a past-the-root corner trims them with an interpolated end point.
    const swingRim = (r: RimPoint): RimPoint => ({ p: swing(r.p.clone()), c: r.c });
    const mandRear: { z: number; L: RimPoint; R: RimPoint }[] = [];
    const mandMzL: RimPoint[] = [], mandMzR: RimPoint[] = [];
    rims.forEach((rm, i) => {
      if (!rm.left || !rm.right) return;
      const stIdx = i - nRear;
      if (stIdx < 0) mandRear.push({ z: rings[i].center.z, L: rm.left, R: rm.right });
      else if (muzzleSts[stIdx]?.cheek === true) { mandMzL.push(rm.left); mandMzR.push(rm.right); }
    });
    let mandCovered = mandRear;
    if (gdc.mouthCorner) {
      const cz = gdc.mouthCorner.z;
      mandCovered = mandRear.filter((u) => u.z <= cz);
      const next = mandRear.find((u) => u.z > cz);
      const prev = mandCovered[mandCovered.length - 1];
      if (prev && next) {
        const f = (cz - prev.z) / Math.max(1e-6, next.z - prev.z);
        mandCovered = [...mandCovered, { z: cz, L: lerpRim(prev.L, next.L, f), R: lerpRim(prev.R, next.R, f) }];
      }
    }
    const mandCrease = {
      left: [...mandCovered.map((u) => u.L), ...mandMzL].map(swingRim),
      right: [...mandCovered.map((u) => u.R), ...mandMzR].map(swingRim),
    };

    // ── Cheek membrane: stitched to the ACTUAL crease edges ──────────────
    // Per mouth-membrane-position.png: the upper rim is the skull's
    // jawline/bite crease POLYLINE and the lower rim the mandible's (swung)
    // — both are chains of real mesh-edge points recorded by the loft, so
    // the membrane attaches with no gap and no floating rim; the hinge
    // anchors the rear corner. Resampled so the two edges pair up.
    // Skin outside, mouth-interior dark inside; degenerate when closed.
    if (skullCrease && mandCrease.left.length >= 1) {
      geo.section("cheek");
      const resample = (pts: RimPoint[], k: number): RimPoint[] => {
        if (pts.length === k) return pts;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].p.distanceTo(pts[i - 1].p));
        const total = cum[cum.length - 1] || 1;
        const out: RimPoint[] = [];
        for (let j = 0; j < k; j++) {
          const want = (j / (k - 1)) * total;
          let i = 1;
          while (i < pts.length - 1 && cum[i] < want) i++;
          const span = cum[i] - cum[i - 1];
          const f = span > 1e-9 ? (want - cum[i - 1]) / span : 0;
          out.push(lerpRim(pts[i - 1], pts[i], f));
        }
        return out;
      };
      const boneL = ramusIdx >= 0 ? ramusIdx : headIdx;
      for (const side of [1, -1] as const) {
        // Rear anchor: the head's SURFACE at the hinge (not the interior
        // midline pivot — that dived inside the head and left the outer
        // pocket by the joint open). Points level with the hinge axis are
        // swing-invariant, so one anchor serves both rims.
        const uSide = side > 0 ? skullCrease.right : skullCrease.left;
        const lSide = side > 0 ? mandCrease.right : mandCrease.left;
        if (uSide.length < 1 || lSide.length < 1) continue;
        const hs = cast(hinge, new THREE.Vector3(side, 0, 0));
        const anchorP = hs
          ? hinge.clone().addScaledVector(new THREE.Vector3(side, 0, 0), hs.t)
          : hinge.clone();
        const U = [{ p: anchorP.clone(), c: uSide[0].c }, ...uSide];
        const L = [{ p: anchorP.clone(), c: uSide[0].c }, ...lSide];
        const K = Math.max(U.length, L.length);
        const Ur = resample(U, K), Lr = resample(L, K);
        // Two mirrored single-face strips (separate verts, membrane-style).
        // Outer faces take the RECORDED edge colors — the shells' own
        // belly-blended surface tones — so the membrane is color-continuous
        // with the skin around it (the "red wedge" was a flat base-color
        // gradient against belly-blended neighbors).
        for (const inner of [false, true]) {
          let prevU = -1, prevL = -1;
          for (let j = 0; j < K; j++) {
            const u = geo.vertex(Ur[j].p, inner ? mouthInner : Ur[j].c, headIdx, 0, 1);
            const l = geo.vertex(Lr[j].p, inner ? mouthInner : Lr[j].c, boneL, 0, 1);
            if (prevU >= 0) {
              if ((side > 0) !== inner) geo.quad(prevU, u, l, prevL);
              else geo.quad(u, prevU, prevL, l);
            }
            prevU = u; prevL = l;
          }
        }
      }
    }
  }

  // ── Nose ───────────────────────────────────────────────────────────────
  // A separate protrusion (bump, trunk, blowhole) lofted like a small limb,
  // its root ring sunk into the head so no seam shows.
  {
    const nose = chains.get("nose");
    if (nose) {
      geo.section("nose");
      const rings = chainRings(nose.bones, (i) => nose.indices[Math.min(i, nose.indices.length - 1)]);
      rings[0].center.addScaledVector(rings[0].direction, -rings[0].radius * 0.8);
      const { firstRing, lastRing } = loftChain(geo, rings, sides, axialColors);
      const first = rings[0];
      capRing(geo, firstRing, sides, first.center.clone().addScaledVector(first.direction, -first.radius * 0.4), base, first.boneA, true);
      const last = rings[rings.length - 1];
      capRing(geo, lastRing, sides, last.center.clone().addScaledVector(last.direction, last.radius * 0.6), base, last.boneA, false);
    }
  }

  // ── Limbs ─────────────────────────────────────────────────────────────
  // ⚖️ A DIGIT'S BASE IS A SLICE OF THE SOLE'S END POLYGON, not a tube parked
  // on top of it. Lofted as an independent ellipse, a toe left flat cap showing
  // between it and its neighbours and met the sole at a floating rim. So the
  // limbs loft in TWO passes: every sole first, recording the frame its last
  // ring ended on (`LoftEnd`), then the digits, each taking as its base ring
  // the part of that polygon inside its own slot. The slots tile the polygon,
  // so no flat shows between them; the sole's own cap (flattened, since the
  // toes are seated on it) stays as the single seal behind the row.
  const limbChains = [...chains].filter(
    ([n]) => n.startsWith("limb") || n.startsWith("chain"),
  );
  const isDigit = (n: string): boolean => /d\d+$/.test(n) && n.startsWith("limb");
  /** `limb0L` → the ring its loft ended on. */
  const soleEnds = new Map<string, LoftEnd>();
  /** `limb0L` → its digit chain names, in row order. */
  const soleDigits = new Map<string, string[]>();
  for (const [n] of limbChains) {
    const m = /^(limb\d+[LRr])d(\d+)$/.exec(n);
    if (!m) continue;
    const row = soleDigits.get(m[1]) ?? [];
    row.push(n);
    soleDigits.set(m[1], row);
  }
  for (const row of soleDigits.values()) {
    row.sort((a, b) => Number(/d(\d+)$/.exec(a)![1]) - Number(/d(\d+)$/.exec(b)![1]));
  }
  /** Whether this limb has a SOLE for its digits to split (a wing does not:
   *  its tip ring is a membrane chord, and tiling that would give the wing a
   *  paddle instead of a finger). */
  const limbsForSoles = resolveLimbs(blueprint).limbs;
  const hasSole = (chainName: string): boolean => {
    const m = /^limb(\d+)/.exec(chainName);
    const limb = m ? limbsForSoles[Number(m[1])] : undefined;
    return !!limb && limb.footLengthFrac > 1e-6;
  };

  for (const [name, chain] of [...limbChains].sort(
    (a, b) => Number(isDigit(a[0])) - Number(isDigit(b[0])),
  )) {
    geo.section(name.startsWith("chain") ? `chain:${name}` : `limb:${name}`);
    const rings = chainRings(chain.bones, (i) => chain.indices[Math.min(i, chain.indices.length - 1)]);
    // Membrane chord: widen the airfoil proportionally to LIMB LENGTH,
    // peaking mid-limb and tapering toward shoulder and tip — this is
    // what makes a wing read as a wing instead of a rod.
    const chainLen = chain.bones.reduce(
      (sum, b) => sum + Math.hypot(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z),
      0,
    );
    rings.forEach((ring, i) => {
      const t = rings.length > 1 ? i / (rings.length - 1) : 0;
      ring.chordBoost =
        ring.flatten * chainLen * LOFT.membraneChordFrac * Math.sin(Math.PI * Math.min(1, t * 1.2)) ** 0.7;
    });
    // A digit whose sole was lofted takes its slot of that end polygon as its
    // base ring; everything else sinks its root ring into its parent to hide
    // the join.
    const dm = /^(limb\d+[LRr])d(\d+)$/.exec(name);
    const soleEnd = dm ? soleEnds.get(dm[1]) : undefined;
    const tiled = !!dm && !!soleEnd && hasSole(name);
    if (tiled) {
      const row = soleDigits.get(dm![1])!;
      rings[0].points = digitBasePoints(soleEnd!, row.indexOf(name), row.length, sides);
      rings[0].center = soleEnd!.center
        .clone()
        .addScaledVector(soleEnd!.side, slotCenterU(soleEnd!.rx, row.indexOf(name), row.length));
      rings[0].direction = soleEnd!.direction.clone();
    } else {
      // Sink the root ring slightly along the first bone so it sits inside
      // the torso — hides the join, no visible cap.
      const rootDir = rings[0].direction;
      rings[0].center.addScaledVector(rootDir, -rings[0].radius * 0.6);
    }
    const { firstRing, lastRing, end } = loftChain(
      geo,
      rings,
      sides,
      axialColors,
      // A tiled digit inherits the sole's frame — see `startFrame`.
      tiled ? { side: soleEnd!.side, up: soleEnd!.up } : undefined,
    );
    if (!isDigit(name)) soleEnds.set(name, end);
    const first = rings[0];
    // A tiled digit needs NO base cap: its base ring lies in the sole's end
    // plane, which the sole's own cap already fills right behind it. Capping
    // both would put two coplanar surfaces in the same place.
    if (!tiled) {
      capRing(geo, firstRing, sides, first.center.clone().addScaledVector(first.direction, -first.radius * 0.4), base, first.boneA, true);
    }
    const last = rings[rings.length - 1];
    // A sole that carries digits caps FLAT rather than with the usual
    // forward-bulged cone — the toes are seated ON that plane, and a cone
    // would push through between them.
    const carriesDigits = soleDigits.has(name) && hasSole(name);
    capRing(
      geo,
      lastRing,
      sides,
      carriesDigits
        ? last.center.clone()
        : last.center.clone().addScaledVector(last.direction, last.radius * 0.5),
      base,
      last.boneA,
      false,
    );
  }

  // ── Rigid details ─────────────────────────────────────────────────────
  for (const d of skel.details) {
    geo.section(d.kind === "beak" ? "beak" : "eye");
    if (d.kind === "beak") {
      // Low-poly cone: base ring + tip. Color blends muzzle→accent with
      // hardness; soft muzzles also get a blunter (offset) tip.
      _tmpColor.copy(base).lerp(accent, d.hardness * d.hardness * 0.9 + d.hardness * 0.1);
      const beakColor = _tmpColor.clone();
      const dir = vec(d.direction);
      let side = new THREE.Vector3(0, 1, 0).cross(dir);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const up = new THREE.Vector3().crossVectors(dir, side).normalize();
      const baseCenter = vec(d.position);
      const start = geo.vertexCount;
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const p = baseCenter
          .clone()
          .addScaledVector(side, Math.cos(a) * d.radius)
          .addScaledVector(up, Math.sin(a) * d.radius * 0.8);
        geo.vertex(p, beakColor, d.bone, 0, 1);
      }
      const tip = baseCenter
        .clone()
        .addScaledVector(dir, d.lengthM)
        // Beaks point straight; soft muzzles droop a touch.
        .addScaledVector(up, -(1 - d.hardness) * d.lengthM * 0.15);
      const tipIdx = geo.vertex(tip, beakColor, d.bone, 0, 1);
      for (let s = 0; s < sides; s++) {
        const sn = (s + 1) % sides;
        geo.tri(start + s, start + sn, tipIdx);
      }
      // Back cap (against the head, mostly hidden).
      capRing(geo, start, sides, baseCenter.clone().addScaledVector(dir, -d.radius * 0.2), beakColor, d.bone, true);
    } else {
      // Eye — tiny two-ring sphere approximation.
      const dir = vec(d.direction);
      let side = new THREE.Vector3(0, 1, 0).cross(dir);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const up = new THREE.Vector3().crossVectors(dir, side).normalize();
      const c = vec(d.position);
      // Ride the eyeball out to the fleshed surface so padding doesn't bury it.
      c.addScaledVector(dir, tissuePushAt(c) * 0.85);
      const eyeSides = 6;
      const rings: number[] = [];
      for (const [h, rr] of [[-0.55, 0.7], [0.1, 1.0], [0.7, 0.6]] as const) {
        const start = geo.vertexCount;
        for (let s = 0; s < eyeSides; s++) {
          const a = (s / eyeSides) * Math.PI * 2;
          const p = c
            .clone()
            .addScaledVector(dir, h * d.radius)
            .addScaledVector(side, Math.cos(a) * d.radius * rr)
            .addScaledVector(up, Math.sin(a) * d.radius * rr);
          geo.vertex(p, eyeColor, d.bone, 0, 1);
        }
        rings.push(start);
      }
      for (let r = 0; r < rings.length - 1; r++) {
        for (let s = 0; s < eyeSides; s++) {
          const sn = (s + 1) % eyeSides;
          geo.quad(rings[r] + s, rings[r] + sn, rings[r + 1] + sn, rings[r + 1] + s);
        }
      }
      capRing(geo, rings[0], eyeSides, c.clone().addScaledVector(dir, -0.8 * d.radius), eyeColor, d.bone, true);
      capRing(geo, rings[rings.length - 1], eyeSides, c.clone().addScaledVector(dir, 0.95 * d.radius), eyeColor, d.bone, false);
    }
  }

  // ── Midline membranes ─────────────────────────────────────────────────
  // Each panel is a row of ribs (base on the body, tip raised). Give the
  // sheet a little thickness along each rib's normal so it's a proper
  // two-sided solid (no normal cancellation), color it base→accent from
  // root to tip, and weight every vertex to the rib's axial bone.
  geo.section("membrane");
  for (const panel of skel.membranes) {
    const ribs = panel.ribs;
    if (ribs.length < 2) continue;
    const th = panel.thickness;
    // Four corner vertices per rib: base/tip × left/right (±normal).
    const corner: number[][] = []; // [ribIndex] = [baseL, baseR, tipL, tipR]
    for (const rib of ribs) {
      const b = vec(rib.base);
      const t = vec(rib.tip);
      const n = vec(rib.normal).multiplyScalar(th);
      const rootC = base.clone();
      const tipC = base.clone().lerp(accent, 0.45);
      const mk = (p: THREE.Vector3, c: THREE.Color): number => geo.vertex(p, c, rib.bone, 0, 1);
      corner.push([
        mk(b.clone().sub(n), rootC),
        mk(b.clone().add(n), rootC),
        mk(t.clone().sub(n), tipC),
        mk(t.clone().add(n), tipC),
      ]);
    }
    for (let i = 0; i < ribs.length - 1; i++) {
      const [bl0, br0, tl0, tr0] = corner[i];
      const [bl1, br1, tl1, tr1] = corner[i + 1];
      geo.quad(br0, tr0, tr1, br1); // right face
      geo.quad(bl0, bl1, tl1, tl0); // left face (reversed)
      geo.quad(tl0, tr0, tr1, tl1); // outer (top) edge
    }
    // End caps so the sheet's leading/trailing edges aren't hollow.
    {
      const [bl, br, tl, tr] = corner[0];
      geo.quad(bl, tl, tr, br);
    }
    {
      const [bl, br, tl, tr] = corner[ribs.length - 1];
      geo.quad(br, tr, tl, bl);
    }
  }

  // ── Growths (horns, antlers, plant structures) ────────────────────────
  // Rigid geometry welded to one bone (skeleton.ts pass 8.5). Segments
  // arrive as a flat coarse-to-fine stream; consecutive segments whose
  // `parent` is the previous index form one branch RUN, lofted (or
  // ribboned) as a unit. Stem color blends base→accent with hardness —
  // the beak rule: green shoots are skin-colored, wood/keratin is accent.
  geo.section("growth");
  for (const gw of skel.growths) {
    const gg = gw.blueprint;
    const stemColor = base.clone().lerp(accent, gg.stem.hardness * gg.stem.hardness * 0.9 + gg.stem.hardness * 0.1);
    const leafColor = new THREE.Color(gg.foliage.leafColor);
    const petalColor = new THREE.Color(gg.flowers.flowerColor);
    const fruitColor = new THREE.Color(gg.fruit.color);

    // Split the segment stream into branch runs.
    let run: typeof gw.segments = [];
    const flushRun = (): void => {
      if (run.length === 0) return;
      const level = run[0].level;
      const sides = GROWTH_SIDES[Math.min(level, GROWTH_SIDES.length - 1)];
      const dirOf = (s: (typeof run)[number]): THREE.Vector3 =>
        new THREE.Vector3(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z).normalize();
      // Rings: head of the run, each joint (averaged dir), the tip.
      const rings: GrowthRing[] = [];
      rings.push({
        center: vec(run[0].a), direction: dirOf(run[0]),
        radius: run[0].radiusA, lobes: run[0].lobes, flatten: Math.min(run[0].flatten, GROWTH_RIBBON_FLATTEN),
      });
      for (let i = 1; i < run.length; i++) {
        rings.push({
          center: vec(run[i].a),
          direction: dirOf(run[i - 1]).add(dirOf(run[i])).normalize(),
          radius: (run[i - 1].radiusB + run[i].radiusA) / 2,
          lobes: run[i].lobes,
          flatten: Math.min(run[i].flatten, GROWTH_RIBBON_FLATTEN),
        });
      }
      const last = run[run.length - 1];
      rings.push({
        center: vec(last.b), direction: dirOf(last),
        radius: last.radiusB, lobes: last.lobes, flatten: Math.min(last.flatten, GROWTH_RIBBON_FLATTEN),
      });

      if (last.flatten >= GROWTH_RIBBON_FLATTEN) {
        emitGrowthRibbon(geo, rings, stemColor, gw.bone);
      } else {
        // Sink the root ring into whatever it sprouts from (parent branch
        // or the body) so the join never shows a hole.
        const sink = run[0].parent >= 0
          ? Math.min(gw.segments[run[0].parent].radiusA, run[0].radiusA * 2) * 0.6
          : run[0].radiusA * 0.8;
        rings[0].center.addScaledVector(rings[0].direction, -sink);
        const { firstRing, lastRing } = loftGrowthRun(geo, rings, sides, stemColor, gw.bone);
        const first = rings[0];
        capRing(geo, firstRing, sides, first.center.clone().addScaledVector(first.direction, -first.radius * 0.4), stemColor, gw.bone, true);
        const tip = rings[rings.length - 1];
        capRing(geo, lastRing, sides, tip.center.clone().addScaledVector(tip.direction, tip.radius * 0.9), stemColor, gw.bone, false);
      }
      run = [];
    };
    gw.segments.forEach((s, i) => {
      // A continuation follows its predecessor at the SAME level; a child
      // sprouting from index i-1 (level + 1) is a new run, not a merge.
      if (run.length > 0 && (s.parent !== i - 1 || s.level !== run[run.length - 1].level)) flushRun();
      run.push(s);
    });
    flushRun();

    for (const lf of gw.leaves) {
      emitLeafCard(
        geo, vec(lf.pos), vec(lf.dir), vec(lf.normal),
        lf.lengthM, lf.widthM,
        lf.kind === "petal" ? petalColor : leafColor,
        gw.bone,
      );
    }
    for (const fr of gw.fruits) {
      emitFruitProfile(geo, fr.rings, fr.lobes, 8, fruitColor, gw.bone, fruitDetail);
    }
  }

  // ── Clothing ──────────────────────────────────────────────────────────
  // Garments (clothing.ts) loft over the SAME rings and bones as the skin —
  // slightly inflated, fabric-colored — so they follow every gait and pose
  // for free (dynamic or baked) and the dressed creature stays one draw call.
  if (blueprint.outfit && blueprint.outfit.garments.length > 0) {
    emitOutfit(geo, skel, blueprint, blueprint.outfit, chains, sides);
  }

  // ── Bones + skinned mesh ──────────────────────────────────────────────
  // Pure-translation rest pose: each bone's local position is its head
  // offset from the parent's head; bind pose == rest pose.
  const threeBones: THREE.Bone[] = skel.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.id;
    return bone;
  });
  skel.bones.forEach((b, i) => {
    const bone = threeBones[i];
    if (b.parent >= 0) {
      const p = skel.bones[b.parent];
      bone.position.set(b.head.x - p.head.x, b.head.y - p.head.y, b.head.z - p.head.z);
      threeBones[b.parent].add(bone);
    } else {
      bone.position.set(b.head.x, b.head.y, b.head.z);
    }
  });

  // Cel/toon shading is a MATERIAL swap only — the geometry, vertex colors
  // and skinning are identical, so the lab (and later the game) can toggle
  // it without touching the build. `opts.toon` forces one creature's shading
  // for side-by-side comparison; unset follows the engine-wide mode.
  const material = surfaceMaterial({
    mode: opts.toon === undefined ? undefined : opts.toon ? "toon" : "standard",
  });
  const mesh = new THREE.SkinnedMesh(geo.build(), material);
  mesh.add(threeBones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(threeBones));
  mesh.frustumCulled = true;
  mesh.geometry.computeBoundingSphere();

  return {
    mesh,
    skeleton: mesh.skeleton,
    root: threeBones[0],
    stats: {
      vertices: geo.vertexCount,
      triangles: geo.index.length / 3,
      bones: threeBones.length,
      buildMs: performance.now() - t0,
    },
    sections: geo.sections,
  };
}
