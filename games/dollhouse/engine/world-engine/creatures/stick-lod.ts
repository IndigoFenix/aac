// Creature/plant STICK LOD — the tier between the cheap loft and the capsule.
//
// A body at 45-110 m is 18-44 px tall on screen: its skin is a handful of
// pixels wide and every ring of the loft is wasted. This tier throws the loft
// away and draws the body the way an anatomist sketches one — a few TAPERED
// CAPSULES (thick lines with round ends) laid along the bones, plus a fat
// short one for the skull. Round caps mean every joint is a circle for free,
// so the figure reads as one continuous body rather than a pile of sticks.
//
// It sits below `simple` and above the capsule (see creature-model.ts's
// CreatureDetail and quest-host.ts's CreatureTier):
//
//   full (sides 8)  →  simple (sides 5)  →  STICK  →  capsule
//   ~884 v / 1574 t    ~612 v / 1032 t      ~70 v      pill, no species
//
// WHY IT IS A SHADER AND NOT GEOMETRY. Two things a static mesh cannot do at
// this range, both of which decide whether the tier is worth having:
//
//   • CONSTANT APPARENT THICKNESS. A 3D tube built at 2 px wide flickers
//     between 1.4 and 2 px as the body turns. A camera-facing ribbon does not
//     turn, so a limb keeps its weight from every angle.
//   • A MINIMUM SCREEN WIDTH. A forearm is 0.95 px wide at 110 m — thinner
//     than a pixel, so a plain mesh aliases it into a dashed shimmer, then
//     into nothing. The vertex shader floors every radius at
//     `STICK_LOD.minWidthPx` screen pixels, which is exactly why this tier can
//     hold a legible body out to (and past) the capsule band.
//
// So ONE quad per capsule (4 verts / 2 triangles), expanded in the vertex
// shader and carved back to a true tapered-capsule silhouette by an SDF in the
// fragment shader. The SDF is the SHAPE, not a nicety: without it a capsule is
// a rectangle with square ends, and the round caps are where every joint
// circle — and the circle a canopy blob IS — comes from.
//
// UNLIT, BY DESIGN (owner's call: the tier exists to draw LARGE GROUPS AT A
// DISTANCE fast). No normals, no lighting, no per-fragment shading maths, and
// no gl_FragDepth refinement — a quad writes the depth of its own plane. Each
// stick is flat `color × uStickTint`. Consequences, accepted deliberately:
//
//   • The figure reads by SILHOUETTE alone. At 11-26 px tall that is all that
//     survives anyway, and it is what the tier is for.
//   • Impostors intersect on their QUAD planes, so two overlapping capsules
//     meet in a flat cut rather than a curved seam. Invisible at range; it is
//     the "pile of discs" look if you inspect a stick tree from a metre away
//     in the creature lab.
//   • Nothing here follows the engine-wide standard/toon swap, because there
//     is no lighting to swap. `uStickTint` (setStickTint) is the one dial that
//     keeps an unlit body sitting in the same brightness range as the lit tier
//     it hands over to, so the boundary does not flash.
//
// This is the same bargain plant-lod.ts's billboards already take (see the
// unlit note in materials.ts).
//
// The material is still built by patching a STOCK three material through
// onBeforeCompile rather than a bare ShaderMaterial, so tone mapping, fog and
// logarithmic depth keep working untouched.
//
// PURE-ish THREE layer: the skeleton/growth math it reads is the same pure
// data the loft reads (skeleton.ts, growth.ts), so a stick figure can be
// derived headlessly (see `creatureSticks`) and only `buildStickGeometry` /
// `stickMaterial` touch the GPU.

import * as THREE from "three";
import type { Blueprint } from "./blueprint";
import type { CreatureBone, CreatureSkeleton, Vec3 } from "./skeleton";
import type { GrowthInstance } from "./skeleton";
// NOT materials.ts: this tier is unlit by design (see the header), so it takes
// no part in the engine-wide lit-material swap.


// ── Tunables ────────────────────────────────────────────────────────────────

/** Live-tunable stick quality (the lab sliders' handle — mirrors mesh.ts LOFT). */
export const STICK_LOD = {
  /** Merge consecutive bones of a chain while every member's direction stays
   *  within this angle (radians) of the merged run's overall direction. This
   *  is what collapses a 6-bone spine to one or two sticks while KEEPING the
   *  knee and the elbow — the joints that survive are the bent ones, which is
   *  also why a disc at every surviving joint is never wasted. */
  mergeAngle: 0.30,
  /** Hard cap on sticks per chain, whatever the merge decides. */
  maxPerChain: 4,
  /** Drop any bone thinner than this (metres) — the vestigial 4 mm spine every
   *  PLANT carries under its trunk would otherwise draw a stub in the soil. */
  minRadiusM: 0.006,
  /** …and thinner than this fraction of the body's own height, so the rule
   *  scales from a cat to an oak. */
  minRadiusFrac: 0.004,
  /** Growth (plant/horn) segments kept, coarse-to-fine. generateGrowth emits
   *  with a PREFIX guarantee (see plant-lod.ts), so this truncation keeps the
   *  trunk and the main branches bit-identical to the full tree. */
  growthSegments: 40,
  /** Leaves per growth above which foliage becomes canopy CIRCLES instead of
   *  being dropped. Mirrors plant-lod.ts's CANOPY_BLOB_MIN_LEAVES so both
   *  tiers agree on what counts as a dense canopy. */
  canopyMinLeaves: 30,
  /** Screen-space floor on a stick's DIAMETER, in device pixels. Below ~1 px a
   *  line stops being drawn reliably and starts to shimmer; 1.4 keeps a limb
   *  solid at 110 m without fattening a near body (the floor only ever wins
   *  when the real radius is already sub-pixel). */
  minWidthPx: 1.4,
  /** Quad oversize. The fragment SDF carves the exact silhouette, so this only
   *  has to guarantee the quad COVERS it (a strongly tapered capsule's
   *  tangent silhouette bulges a hair past the linear interpolation). */
  quadPad: 1.15,
  /** Flat multiplier on every stick's colour — the whole of this tier's
   *  "shading". It exists so an UNLIT body sits in the same brightness range as
   *  the lit tier it hands over to at 45 m, instead of flashing brighter as it
   *  crosses. Calibrated against render3d's standard rig (hemisphere 0.95 +
   *  key 0.7·N·L, so a lit surface averages a little under its albedo). Push it
   *  through `setStickTint` if a host ever dims its world. */
  tint: 0.9,
};

// ── The primitive ───────────────────────────────────────────────────────────

/** One tapered capsule: a thick line from `a` to `b`, round-capped at both
 *  ends. `a` === `b` is legal and draws a CIRCLE (a canopy blob) — the vertex
 *  shader falls back to a screen-aligned basis for the degenerate axis. */
export interface StickSegment {
  a: Vec3;
  b: Vec3;
  ra: number;
  rb: number;
  color: THREE.Color;
}

export interface StickFigure {
  segments: StickSegment[];
  /** Creature-local AABB of the capsules (anchors inflated by radius). */
  bounds: { min: Vec3; max: Vec3 };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** Unit direction a→b, or null for a degenerate pair. */
function dirOf(a: Vec3, b: Vec3): Vec3 | null {
  const l = dist(a, b);
  if (l < 1e-9) return null;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l, z: (b.z - a.z) / l };
}

const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

// ── Bone chains → sticks ────────────────────────────────────────────────────

/** Digit chains (`limb0Ld3` — minted at skeleton.ts's `addDigits`, the ONE
 *  place the name is formed). Fingers and toes are 2 cm of body at 100 m;
 *  drawing them costs a fifth of the whole figure's sticks and shows nothing. */
const DIGIT_CHAIN = /d\d+$/;

/** Merge a chain's bones into at most `maxPerChain` sticks, breaking a run
 *  wherever the body actually BENDS. Radii come from the run's two ends, so
 *  taper survives the merge (a thigh still thickens toward the hip). */
function mergeChain(bones: CreatureBone[], color: THREE.Color, out: StickSegment[]): void {
  if (bones.length === 0) return;
  const { mergeAngle, maxPerChain } = STICK_LOD;
  const cos = Math.cos(mergeAngle);
  // Break the chain into runs, then, if there are still too many, keep
  // breaking at the SHARPEST joints only (a chain never exceeds the cap).
  const runs: CreatureBone[][] = [];
  let run: CreatureBone[] = [];
  for (const b of bones) {
    if (run.length === 0) {
      run = [b];
      continue;
    }
    const overall = dirOf(run[0].head, b.tail);
    const mine = dirOf(b.head, b.tail);
    // A run holds while every member — including the newcomer — points within
    // `mergeAngle` of where the run as a whole would end up going.
    let holds = overall !== null && mine !== null && dot3(overall, mine) >= cos;
    if (holds && overall) {
      for (const m of run) {
        const d = dirOf(m.head, m.tail);
        if (!d || dot3(overall, d) < cos) {
          holds = false;
          break;
        }
      }
    }
    if (holds) run.push(b);
    else {
      runs.push(run);
      run = [b];
    }
  }
  if (run.length) runs.push(run);
  // Over the cap: repeatedly fuse the pair of neighbouring runs whose junction
  // bends LEAST, so the sharpest joints are the ones that survive.
  while (runs.length > maxPerChain) {
    let bestAt = 0;
    let bestCos = -2;
    for (let i = 0; i + 1 < runs.length; i++) {
      const d0 = dirOf(runs[i][0].head, runs[i][runs[i].length - 1].tail);
      const d1 = dirOf(runs[i + 1][0].head, runs[i + 1][runs[i + 1].length - 1].tail);
      const c = d0 && d1 ? dot3(d0, d1) : 1;
      if (c > bestCos) {
        bestCos = c;
        bestAt = i;
      }
    }
    runs.splice(bestAt, 2, [...runs[bestAt], ...runs[bestAt + 1]]);
  }
  for (const r of runs) {
    const first = r[0];
    const last = r[r.length - 1];
    if (dist(first.head, last.tail) < 1e-6) continue;
    out.push({
      a: first.head,
      b: last.tail,
      ra: first.radiusHead,
      rb: last.radiusTail,
      color,
    });
  }
}

// ── Head ────────────────────────────────────────────────────────────────────

/** The skull as one fat capsule along the braincase, plus a thinner one down
 *  the muzzle when the species has one. This is where the "circles for the
 *  head" live: a braincase capsule seen at 20 px IS a circle, and a body plan
 *  with a snout gets the snout instead of a guessed second ball. */
function appendHead(skel: CreatureSkeleton, bp: Blueprint, base: THREE.Color, accent: THREE.Color, out: StickSegment[]): void {
  const lm = skel.head;
  if (!lm) return;
  // Braincase half-width and half-height average into one round radius — the
  // capsule has no cross-section, so a tall narrow skull and a wide flat one
  // must at least agree on bulk.
  const r = Math.max(1e-4, (lm.radius + lm.domeHalf) * 0.5);
  if (r < STICK_LOD.minRadiusM) return;
  const axis = lm.braincaseAxis;
  const half = lm.halfLen * 0.45; // shortened: the caps add `r` at each end
  out.push({
    a: { x: lm.center.x - axis.x * half, y: lm.center.y - axis.y * half, z: lm.center.z - axis.z * half },
    b: { x: lm.center.x + axis.x * half, y: lm.center.y + axis.y * half, z: lm.center.z + axis.z * half },
    ra: r,
    rb: r,
    color: base,
  });
  // Muzzle — same keratin blend the loft paints it with (mesh.ts), so the tier
  // swap does not change a beak's colour.
  const snout = dist(lm.rostrumBase, lm.rostrumTip);
  if (snout > r * 0.4) {
    const h = bp.head.beak;
    const kerat = h * h * 0.9 + h * 0.1;
    out.push({
      a: lm.rostrumBase,
      b: lm.rostrumTip,
      ra: r * 0.55,
      rb: r * 0.3,
      color: base.clone().lerp(accent, kerat),
    });
  }
}

// ── Growths (plant structure, horns, antlers) ───────────────────────────────

/** Cluster a dense canopy's leaf cards into a few CIRCLES — the same
 *  voxel-centroid clustering plant-lod.ts blobs LOD1 foliage with, emitting
 *  zero-length capsules instead of icosahedra. Deterministic, no RNG. */
function appendCanopy(gw: GrowthInstance, plantHeight: number, out: StickSegment[]): void {
  if (gw.leaves.length < STICK_LOD.canopyMinLeaves) return;
  const color = new THREE.Color(gw.blueprint.foliage.leafColor);
  const voxel = Math.max(0.4, plantHeight / 4);
  interface Cluster { x: number; y: number; z: number; n: number; leafLen: number }
  const clusters = new Map<string, Cluster>();
  for (const lf of gw.leaves) {
    if (lf.kind !== "leaf") continue;
    const key = `${Math.round(lf.pos.x / voxel)},${Math.round(lf.pos.y / voxel)},${Math.round(lf.pos.z / voxel)}`;
    let c = clusters.get(key);
    if (!c) {
      c = { x: 0, y: 0, z: 0, n: 0, leafLen: 0 };
      clusters.set(key, c);
    }
    c.x += lf.pos.x;
    c.y += lf.pos.y;
    c.z += lf.pos.z;
    c.n++;
    c.leafLen = Math.max(c.leafLen, lf.lengthM);
  }
  for (const c of clusters.values()) {
    const p = { x: c.x / c.n, y: c.y / c.n, z: c.z / c.n };
    const r = Math.min(voxel * 0.9, c.leafLen * (1.2 + Math.cbrt(c.n) * 0.55));
    out.push({ a: p, b: p, ra: r, rb: r, color });
  }
}

/** A growth's woody structure: a PREFIX of its segments (coarse-to-fine, so
 *  the trunk and main boughs are the same lines the full tree draws) plus its
 *  canopy circles. */
function appendGrowth(gw: GrowthInstance, base: THREE.Color, accent: THREE.Color, plantHeight: number, out: StickSegment[]): void {
  const hard = gw.blueprint.stem.hardness;
  const color = base.clone().lerp(accent, hard * hard * 0.9 + hard * 0.1);
  const n = Math.min(gw.segments.length, STICK_LOD.growthSegments);
  for (let i = 0; i < n; i++) {
    const s = gw.segments[i];
    if (dist(s.a, s.b) < 1e-6) continue;
    out.push({ a: s.a, b: s.b, ra: s.radiusA, rb: s.radiusB, color });
  }
  appendCanopy(gw, plantHeight, out);
}

// ── The figure ──────────────────────────────────────────────────────────────

/** Reduce a posed skeleton to its stick figure. PURE — no THREE geometry, so a
 *  test (or a headless tool) can assert what a body reduces to without a GL
 *  context. Serves creatures AND plants: a plant is a blueprint whose body is
 *  a vestigial spine under one big growth, and the same rules drop the spine
 *  and keep the trunk. */
export function creatureSticks(skel: CreatureSkeleton, bp: Blueprint): StickFigure {
  const base = new THREE.Color(bp.skin.baseColor);
  const accent = new THREE.Color(bp.skin.accentColor);
  const height = Math.max(1e-3, skel.bounds.max.y - skel.bounds.min.y);
  const minR = Math.max(STICK_LOD.minRadiusM, height * STICK_LOD.minRadiusFrac);
  const segments: StickSegment[] = [];

  // Bone chains. The whole HEAD REGION (kind "head" covers the head, snout,
  // nose and jaw chains) is skipped — the skull landmarks draw it as one
  // capsule below, which is both cheaper and rounder than four thin chains.
  const chains = new Map<string, CreatureBone[]>();
  for (const b of skel.bones) {
    if (b.kind === "head") continue;
    if (DIGIT_CHAIN.test(b.chain)) continue;
    if (Math.max(b.radiusHead, b.radiusTail) < minR) continue;
    const c = chains.get(b.chain);
    if (c) c.push(b);
    else chains.set(b.chain, [b]);
  }
  for (const bones of chains.values()) mergeChain(bones, base, segments);

  appendHead(skel, bp, base, accent, segments);

  // Growths — plant structure, horns, antlers.
  let plantHeight = 1;
  for (const gw of skel.growths) for (const s of gw.segments) plantHeight = Math.max(plantHeight, s.b.y);
  for (const gw of skel.growths) appendGrowth(gw, base, accent, plantHeight, segments);

  // Bounds from the capsules themselves (anchors inflated by radius) — the
  // shader expands the quads, so a bounding box read off `position` alone
  // would cull a body a frame early at the screen edge.
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const s of segments) {
    for (const [p, r] of [[s.a, s.ra], [s.b, s.rb]] as const) {
      min.x = Math.min(min.x, p.x - r); max.x = Math.max(max.x, p.x + r);
      min.y = Math.min(min.y, p.y - r); max.y = Math.max(max.y, p.y + r);
      min.z = Math.min(min.z, p.z - r); max.z = Math.max(max.z, p.z + r);
    }
  }
  if (!Number.isFinite(min.x)) {
    min.x = min.y = min.z = 0;
    max.x = max.y = max.z = 0;
  }
  return { segments, bounds: { min, max } };
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Corner layout of a capsule's quad: (across, along). `across` ∈ {-1,+1} is
 *  the side of the line; `along` ∈ {0,1} picks which end the corner rides. */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [-1, 1], [1, 1],
];
const QUAD_INDEX = [0, 1, 2, 2, 1, 3];

/** One quad per capsule. Every attribute but `aCorner` and `color` is constant
 *  across a quad — the shader needs the WHOLE segment at each corner to
 *  billboard it and to run the silhouette SDF. */
export function buildStickGeometry(fig: StickFigure): THREE.BufferGeometry {
  const n = fig.segments.length;
  const pos = new Float32Array(n * 4 * 3);
  const segA = new Float32Array(n * 4 * 3);
  const segB = new Float32Array(n * 4 * 3);
  const radii = new Float32Array(n * 4 * 2);
  const corner = new Float32Array(n * 4 * 2);
  const color = new Float32Array(n * 4 * 3);
  const index = new Uint32Array(n * 6);
  // NO `normal` attribute — this geometry is for `stickMaterial` and nothing
  // else, and that material is UNLIT (see the header), so nothing ever reads
  // one. That is a quarter of the vertex buffer saved on a tier whose entire
  // job is drawing crowds. ⚠️ Handing this geometry to a LIT material would
  // read the absent attribute as (0,0,0), and normalize(vec3(0)) is NaN — black
  // bodies, then a black frame once bloom smears them (see plant-lod.ts). It
  // would render nonsense anyway: `position` here is a capsule ANCHOR, not a
  // surface point, and only the stick shader knows how to expand it.

  for (let s = 0; s < n; s++) {
    const seg = fig.segments[s];
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      const [u, t] = CORNERS[c];
      const p = t === 0 ? seg.a : seg.b;
      pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
      segA[v * 3] = seg.a.x; segA[v * 3 + 1] = seg.a.y; segA[v * 3 + 2] = seg.a.z;
      segB[v * 3] = seg.b.x; segB[v * 3 + 1] = seg.b.y; segB[v * 3 + 2] = seg.b.z;
      radii[v * 2] = seg.ra; radii[v * 2 + 1] = seg.rb;
      corner[v * 2] = u; corner[v * 2 + 1] = t;
      color[v * 3] = seg.color.r; color[v * 3 + 1] = seg.color.g; color[v * 3 + 2] = seg.color.b;
    }
    for (let k = 0; k < 6; k++) index[s * 6 + k] = s * 4 + QUAD_INDEX[k];
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(color, 3));
  g.setAttribute("aSegA", new THREE.BufferAttribute(segA, 3));
  g.setAttribute("aSegB", new THREE.BufferAttribute(segB, 3));
  g.setAttribute("aRadii", new THREE.BufferAttribute(radii, 2));
  g.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  // Bounds come from the FIGURE (radius-inflated), not from `position`.
  const b = fig.bounds;
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(b.min.x, b.min.y, b.min.z),
    new THREE.Vector3(b.max.x, b.max.y, b.max.z),
  );
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

// ── Material ────────────────────────────────────────────────────────────────

/** ONE uniform object shared by every stick material ever built, so the host
 *  updates the viewport in a single call however many species are on screen.
 *  (three copies the uniform OBJECT reference into each program, so assigning
 *  the same object is what makes one write reach them all.) */
const STICK_UNIFORMS = {
  uStickViewportPx: { value: 1080 },
  uStickMinPx: { value: STICK_LOD.minWidthPx },
  uStickTint: { value: new THREE.Color().setScalar(STICK_LOD.tint) },
};

/** Tell the stick shader how tall the DRAWING BUFFER is, in device pixels
 *  (logical height × devicePixelRatio) — the min-width floor is meaningless
 *  without it. render3d's `resize` pushes this; a host that never calls it
 *  gets a 1080-tall guess, which only misjudges the floor, never the shape. */
export function setStickViewportPx(px: number): void {
  STICK_UNIFORMS.uStickViewportPx.value = Math.max(1, px);
}

/** The flat multiplier on every stick's colour — this tier's entire substitute
 *  for lighting. Defaults to `STICK_LOD.tint`, calibrated against render3d's
 *  standard rig; a host with its own (dimmer, tinted, day/night) lighting
 *  should push its ambient here so the 45 m boundary does not flash. */
export function setStickTint(color: THREE.ColorRepresentation): void {
  STICK_UNIFORMS.uStickTint.value.set(color);
}

/** Re-read the `STICK_LOD` dials after a lab slider moves one. */
export function refreshStickTunables(): void {
  STICK_UNIFORMS.uStickMinPx.value = STICK_LOD.minWidthPx;
  STICK_UNIFORMS.uStickTint.value.setScalar(STICK_LOD.tint);
}

const VERT_DECLS = /* glsl */`
attribute vec3 aSegA;
attribute vec3 aSegB;
attribute vec2 aRadii;
attribute vec2 aCorner;
uniform float uStickViewportPx;
uniform float uStickMinPx;
varying vec3 vStickA;
varying vec3 vStickB;
varying vec3 vStickPos;
varying float vStickRA;
varying float vStickRB;
`;

/** Replaces `<project_vertex>`: billboard the capsule's quad in VIEW space and
 *  hand the standard pipeline a normal `mvPosition` / `gl_Position`, so every
 *  chunk downstream (log depth, fog, vViewPosition) keeps working untouched.
 *  The batching/instancing branches mirror the stock chunk — an instanced
 *  stick forest (flora-field) goes through the same path. */
const VERT_BILLBOARD = /* glsl */`
	vec4 sA = vec4( aSegA, 1.0 );
	vec4 sB = vec4( aSegB, 1.0 );
	vec4 sScale = vec4( aSegA + vec3( 1.0, 0.0, 0.0 ), 1.0 );

	#ifdef USE_BATCHING
		sA = batchingMatrix * sA;
		sB = batchingMatrix * sB;
		sScale = batchingMatrix * sScale;
	#endif

	#ifdef USE_INSTANCING
		sA = instanceMatrix * sA;
		sB = instanceMatrix * sB;
		sScale = instanceMatrix * sScale;
	#endif

	sA = modelViewMatrix * sA;
	sB = modelViewMatrix * sB;
	sScale = modelViewMatrix * sScale;

	// Object→view scale, measured rather than assumed: a creature model is
	// scaled to stand its species height, and the radii ride that scale.
	float stickScale = length( sScale.xyz - sA.xyz );

	// Screen-space floor on the radius, taken at the segment's MIDPOINT so all
	// four corners agree (projectionMatrix[1][1] = 1 / tan( fovY / 2 )).
	vec3 stickCentre = mix( sA.xyz, sB.xyz, 0.5 );
	float stickDepth = max( 1e-4, - stickCentre.z );
	float unitsPerPx = 2.0 * stickDepth / max( 1.0, uStickViewportPx * projectionMatrix[ 1 ][ 1 ] );
	float minR = 0.5 * uStickMinPx * unitsPerPx;
	vStickRA = max( aRadii.x * stickScale, minR );
	vStickRB = max( aRadii.y * stickScale, minR );
	vStickA = sA.xyz;
	vStickB = sB.xyz;

	float stickT = aCorner.y;
	vec3 stickAnchor = mix( sA.xyz, sB.xyz, stickT );
	vec3 toEye = normalize( - stickAnchor );

	// The quad is built in the SCREEN PLANE: the capsule axis is projected
	// perpendicular to the eye ray, so a segment pointing straight at the
	// camera (or a zero-length one — a canopy circle) still expands into a
	// square that covers its disc instead of collapsing to a sliver.
	vec3 upRef = abs( toEye.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 stickAxis = sB.xyz - sA.xyz;
	vec3 axisPerp = stickAxis - toEye * dot( stickAxis, toEye );
	float axisPerpLen = length( axisPerp );
	vec3 capDir = axisPerpLen > 1e-5
		? axisPerp / axisPerpLen
		: normalize( upRef - toEye * dot( upRef, toEye ) );
	vec3 sideDir = cross( capDir, toEye );

	float rHere = mix( vStickRA, vStickRB, stickT ) * ${STICK_LOD.quadPad.toFixed(3)};
	vec3 stickPos = stickAnchor
		+ sideDir * ( aCorner.x * rHere )
		+ capDir * ( ( stickT * 2.0 - 1.0 ) * rHere );
	vStickPos = stickPos;

	vec4 mvPosition = vec4( stickPos, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
`;

/** Newline for the shader-chunk splices below. */
const NL = String.fromCharCode(10);

const FRAG_DECLS = /* glsl */`
uniform vec3 uStickTint;
varying vec3 vStickA;
varying vec3 vStickB;
varying vec3 vStickPos;
varying float vStickRA;
varying float vStickRB;
`;

/** Carve the padded quad down to the true tapered-capsule silhouette. The
 *  round caps fall out of the `clamp` — which is where every joint circle, and
 *  the circle a canopy blob IS, comes from. This is the tier's SHAPE, not a
 *  nicety: without it every capsule is a rectangle with square ends. */
const FRAG_SILHOUETTE = /* glsl */`
	vec3 stickPA = vStickPos - vStickA;
	vec3 stickBA = vStickB - vStickA;
	float stickH = clamp( dot( stickPA, stickBA ) / max( dot( stickBA, stickBA ), 1e-9 ), 0.0, 1.0 );
	vec3 stickRadial = stickPA - stickBA * stickH;
	float stickDist = length( stickRadial );
	float stickR = max( mix( vStickRA, vStickRB, stickH ), 1e-6 );
	if ( stickDist > stickR ) discard;
`;

/** THE ONLY "shading" this tier does: one multiply. `MeshBasicMaterial` has
 *  already folded the vertex colour into `diffuseColor` via `<color_fragment>`,
 *  so the tint lands straight after it. */
const FRAG_TINT = /* glsl */`
	diffuseColor.rgb *= uStickTint;
`;

/** THE ONE MATERIAL every stick body and stick plant shares.
 *
 *  `MeshBasicMaterial` — UNLIT, on purpose (see the header): no normals, no
 *  light loop, no cel ramp, no depth refinement. What is left per fragment is
 *  the silhouette SDF (which IS the shape) and one multiply. That is the whole
 *  point of a tier whose job is drawing crowds at a distance.
 *
 *  Patched rather than hand-written as a ShaderMaterial so tone mapping, fog
 *  and logarithmic depth come along from the stock chunks unchanged.
 *
 *  `side: DoubleSide` because the quads are camera-facing by construction but a
 *  body's own yaw can wind one backwards — and with no lighting there is no
 *  back face to shade wrong, so it costs nothing. */
export function stickMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    name: "stick-lod",
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStickViewportPx = STICK_UNIFORMS.uStickViewportPx;
    shader.uniforms.uStickMinPx = STICK_UNIFORMS.uStickMinPx;
    shader.uniforms.uStickTint = STICK_UNIFORMS.uStickTint;
    shader.vertexShader = VERT_DECLS + shader.vertexShader.replace(
      "#include <project_vertex>",
      VERT_BILLBOARD,
    );
    // The silhouette discard goes as EARLY as main allows, so a culled fragment
    // does no further work; the tint lands after the vertex colour is folded in.
    shader.fragmentShader = FRAG_DECLS + shader.fragmentShader
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>" + NL + FRAG_SILHOUETTE)
      .replace("#include <color_fragment>", "#include <color_fragment>" + NL + FRAG_TINT);
  };
  // Programs are cached per shader source; ours is ONE variant, so a constant
  // key keeps every stick material in the world sharing a single compiled
  // program however many species are on screen.
  mat.customProgramCacheKey = () => "stick-lod";
  return mat;
}

// ── Convenience ─────────────────────────────────────────────────────────────

/** Skeleton → drawable stick geometry in one call (the common path). The
 *  material MUST come from `stickMaterial()` — see buildStickGeometry. */
export function buildStickMesh(skel: CreatureSkeleton, bp: Blueprint, material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(buildStickGeometry(creatureSticks(skel, bp)), material);
}
