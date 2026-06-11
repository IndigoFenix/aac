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
import type { Genome } from "./genome";
import type { CreatureBone, CreatureSkeleton, Vec3 } from "./skeleton";

// Live-tunable loft quality (lab sliders; later per-LOD presets).
export const LOFT = {
  /** Vertices per ring. 6 = chunky low-poly, 10 = smooth. */
  sides: 8,
  /** Extra rings lofted along the head bulb. */
  headRings: 4,
  /** Cross-section widening at membrane=1 (wing chord multiplier). */
  membraneWiden: 1.6,
  /** Cross-section flattening at membrane=1. */
  membraneFlatten: 0.7,
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
}

// ── Geometry accumulator ─────────────────────────────────────────────────

class GeoBuilder {
  positions: number[] = [];
  colors: number[] = [];
  skinIndices: number[] = [];
  skinWeights: number[] = [];
  index: number[] = [];

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

interface RingSpec {
  center: THREE.Vector3;
  /** Loft direction at this ring (unit). Frames are parallel-transported
   *  along the chain to avoid twist. */
  direction: THREE.Vector3;
  radius: number;
  /** 0 round .. 1 flattened+widened (membrane cross-section). */
  flatten: number;
  /** Body cross-section width:height ratio (1 = round). Independent of
   *  `flatten`; scales the ring's width/height area-preservingly. */
  aspect?: number;
  /** Extra absolute chord width (m) added to the wide axis — used to
   *  give membrane limbs a wing chord proportional to limb length. */
  chordBoost?: number;
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

/** Loft a sequence of rings into a tube, parallel-transporting the frame.
 *  Returns the vertex index ranges of the first and last rings so the
 *  caller can cap them. */
function loftChain(
  geo: GeoBuilder,
  rings: RingSpec[],
  sides: number,
  colors: RingColors,
): { firstRing: number; lastRing: number } {
  // Initial frame: side = cross(worldUp, dir), fall back when vertical.
  let dir = rings[0].direction.clone();
  let side = new THREE.Vector3(0, 1, 0).cross(dir);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  let up = new THREE.Vector3().crossVectors(dir, side).normalize();

  let prevStart = -1;
  let firstRing = -1;
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
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const p = ring.center
        .clone()
        .addScaledVector(side, Math.cos(a) * rx)
        .addScaledVector(up, Math.sin(a) * ry);
      // Belly blend: how far below the ring center the vertex sits.
      const downness = ring.radius > 1e-6
        ? THREE.MathUtils.clamp(0.5 - ((p.y - ring.center.y) / Math.max(ry, 1e-6)) * 0.6, 0, 1)
        : 0.5;
      _tmpColor.copy(colors.base).lerp(colors.belly, downness * downness);
      geo.vertex(p, _tmpColor, ring.boneA, ring.boneB, ring.weightA);
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

// ── Main entry ───────────────────────────────────────────────────────────

export function buildCreatureMesh(
  skel: CreatureSkeleton,
  genome: Genome,
  opts: { sides?: number } = {},
): BuiltCreature {
  const t0 = performance.now();
  const sides = Math.max(5, Math.round(opts.sides ?? LOFT.sides));
  const geo = new GeoBuilder();

  const base = new THREE.Color(genome.skin.baseColor);
  const belly = new THREE.Color(genome.skin.bellyColor);
  const accent = new THREE.Color(genome.skin.accentColor);
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

  // Head bulb — ellipsoid ring profile along the head bone, ending in a
  // small snout ring (the beak/muzzle cone takes it from there).
  const headChain = chains.get("head")!;
  const headBone = headChain.bones[0];
  const headIdx = headChain.indices[0];
  {
    const hHead = vec(headBone.head);
    const hDir = boneDir(headBone);
    const headLen = vec(headBone.tail).sub(hHead).length();
    const R = headBone.radiusHead;
    const prev = axialRings[axialRings.length - 1];
    prev.boneB = headIdx;
    prev.weightA = 0.5;
    const n = Math.max(3, LOFT.headRings);
    for (let i = 1; i <= n; i++) {
      const s = i / (n + 0.6); // stop short of the tip → snout ring
      const profile = Math.sqrt(Math.max(1 - (2 * s - 1) ** 2, 0.06));
      axialRings.push({
        center: hHead.clone().addScaledVector(hDir, s * headLen),
        direction: hDir,
        radius: R * profile,
        flatten: 0,
        boneA: headIdx,
        boneB: headIdx,
        weightA: 1,
      });
    }
  }

  {
    const { firstRing, lastRing } = loftChain(geo, axialRings, sides, axialColors);
    // Tail-tip cap (or rear cap when no tail) and snout cap.
    const first = axialRings[0];
    capRing(
      geo, firstRing, sides,
      first.center.clone().addScaledVector(first.direction, -first.radius * 0.6),
      base, first.boneA, true,
    );
    const last = axialRings[axialRings.length - 1];
    capRing(
      geo, lastRing, sides,
      last.center.clone().addScaledVector(last.direction, last.radius * 0.8),
      base, last.boneA, false,
    );
  }

  // ── Limbs ─────────────────────────────────────────────────────────────
  for (const [name, chain] of chains) {
    if (!name.startsWith("limb") && !name.startsWith("chain")) continue;
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
    // Sink the root ring slightly along the first bone so it sits inside
    // the torso — hides the join, no visible cap.
    const rootDir = rings[0].direction;
    rings[0].center.addScaledVector(rootDir, -rings[0].radius * 0.6);
    const { firstRing, lastRing } = loftChain(geo, rings, sides, axialColors);
    const first = rings[0];
    capRing(geo, firstRing, sides, first.center.clone().addScaledVector(first.direction, -first.radius * 0.4), base, first.boneA, true);
    const last = rings[rings.length - 1];
    capRing(geo, lastRing, sides, last.center.clone().addScaledVector(last.direction, last.radius * 0.5), base, last.boneA, false);
  }

  // ── Rigid details ─────────────────────────────────────────────────────
  for (const d of skel.details) {
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

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
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
  };
}
