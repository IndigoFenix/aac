/**
 * Land detail fields — generated, never loaded.
 *
 * Same contract as the wave field (water-normals.ts): one RGBA DataTexture per
 * material, tangent-space normal in RGB, a scalar in ALPHA. The scalar is what
 * each material's tint ramp reads, so the shader needs one sample to get both
 * the relief and the colour variation.
 *
 * WHY THIS IS SAFE TO PERTURB AND WATER BARELY WAS: land is roughness 0.95 /
 * metalness 0 (three.ts). There is no specular lobe to drag around, so normal
 * detail here produces diffuse shading variation, not moving glint — the hazard
 * the whole of terrain-shading.ts's safety note is about does not arise. That is
 * a property of the MATERIAL, not of this file: it stops being true the moment
 * someone makes terrain glossy.
 *
 * TILING is inherited from land-noise.ts and is not optional — see DETAIL_TILE_M
 * in chunk.ts. Every tile size here must divide it.
 */
import * as THREE from "three";
import { tileFbm, tileNoise } from "./land-noise";
import { mulberry32 } from "./noise";

const SIZE = 256;

// ── The bake ────────────────────────────────────────────────────────────────

interface FieldSpec {
  /** Relief at (u,v) ∈ [0,1)², differenced into the RGB normal. Units and
   *  amplitude are free: the bake rescales to hit `medianTiltDeg`, so only the
   *  SHAPE of this function matters. */
  height(u: number, v: number): number;
  /** Scalar packed into ALPHA, for the material's tint ramp. */
  scalar(u: number, v: number): number;
  /** The MEDIAN normal tilt the baked field should have, in degrees — the
   *  physical claim ("sand ripples are shallow, grit is bumpy"), stated as the
   *  thing you'd actually measure.
   *
   *  The bake solves for the scale that hits it, rather than taking a raw
   *  multiplier, because a raw multiplier is not comparable between fields: an
   *  fbm and a stack of sine harmonics at the same frequency have completely
   *  different gradients, so the same number means ~4× different tilt. That is
   *  not hypothetical — it shipped one revision of sand at a measured 29°
   *  median (a corrugated roof) under a constant whose comment claimed 7°.
   *
   *  Free of the seizure constraint (see the module note): land is matte and
   *  static, so this varies diffuse shading only. */
  medianTiltDeg: number;
}

/** Bake a field to an RGBA DataTexture: normal in RGB, scalar in ALPHA. */
function bakeDetailField(spec: FieldSpec): THREE.DataTexture {
  const height = new Float32Array(SIZE * SIZE);
  const scalar = new Float32Array(SIZE * SIZE);
  const data = new Uint8Array(SIZE * SIZE * 4);

  let sMin = Infinity;
  let sMax = -Infinity;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      height[y * SIZE + x] = spec.height(u, v);
      const s = spec.scalar(u, v);
      scalar[y * SIZE + x] = s;
      if (s < sMin) sMin = s;
      if (s > sMax) sMax = s;
    }
  }

  // Raw gradients first. Central difference with WRAPPED neighbours — a clamped
  // edge would bake a flat-normal border into a texture whose whole job is to
  // tile.
  const gx = new Float32Array(SIZE * SIZE);
  const gy = new Float32Array(SIZE * SIZE);
  const mags = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const xm = (x - 1 + SIZE) % SIZE;
      const xp = (x + 1) % SIZE;
      const ym = (y - 1 + SIZE) % SIZE;
      const yp = (y + 1) % SIZE;
      const i = y * SIZE + x;
      gx[i] = (height[y * SIZE + xp] - height[y * SIZE + xm]) * 0.5;
      gy[i] = (height[yp * SIZE + x] - height[ym * SIZE + x]) * 0.5;
      mags[i] = Math.hypot(gx[i], gy[i]);
    }
  }
  // Solve for the scale that puts the MEDIAN tilt where the spec asked, so the
  // constant states the outcome instead of a number whose meaning depends on
  // the height function's amplitude. See medianTiltDeg.
  const sorted = Float64Array.from(mags).sort();
  const gMed = sorted[sorted.length >> 1] || 1e-9;
  const k = Math.tan((spec.medianTiltDeg * Math.PI) / 180) / gMed;

  for (let i = 0; i < SIZE * SIZE; i++) {
    const nx = -gx[i] * k;
    const ny = -gy[i] * k;
    const len = Math.hypot(nx, ny, 1);
    const o = i * 4;
    data[o + 0] = Math.round((nx / len * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
  }

  // Normalize against the ACTUAL range, like the wave field's alpha: an fbm
  // never reaches its theoretical 0..1, so the tint ramp would otherwise only
  // ever use its middle and the material would come out uniform.
  const span = sMax - sMin || 1;
  for (let i = 0; i < scalar.length; i++) {
    data[i * 4 + 3] = Math.round(((scalar[i] - sMin) / span) * 255);
  }

  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Mipmaps ARE the distance treatment (see the wave field): from altitude the
  // tile goes sub-pixel and the chain averages it back to the flat vertex
  // colour, instead of aliasing into crawling speckle as the camera moves.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Expand a 0..1 value's contrast about its midpoint. Turns fbm mush into
 *  something with discrete-looking features. */
const contrast = (t: number, k: number): number => {
  const c = Math.min(1, Math.max(0, (t - 0.5) * k + 0.5));
  return c * c * (3 - 2 * c);
};

// ── Grass ───────────────────────────────────────────────────────────────────

/** Grass tile, in metres. Divides DETAIL_TILE_M (64). At SIZE=256 this is
 *  ~3 cm/texel — fine enough that a standing camera sees clumps rather than
 *  pixels, coarse enough that the 8 m repeat is broken up by the second
 *  sampling scale rather than needing a bigger texture. */
export const GRASS_TILE_M = 8;

/** Cycles across the grass tile.
 *
 *  CLUMP feeds both the relief and the base of the tint: at an 8 m tile these
 *  are 2 m / 1 m / 0.5 m features — tussocks, the scale that reads as a meadow
 *  from standing height.
 *
 *  BLADE is tint ONLY, and deliberately not in the normal. The normal comes
 *  from a finite difference of the baked height, so anything approaching a few
 *  texels per cycle differences to noise — the same trap water-normals.ts
 *  avoided by going analytic. At 4 texels/cycle BLADE is past that line for
 *  relief, but it costs nothing in albedo, where no derivative is taken. */
const CLUMP_FREQ = 4;
const CLUMP_OCTAVES = 3;
const BLADE_FREQ = 32;
const BLADE_OCTAVES = 2;
/** Tussocks catch light gently — this is the value the first grass cut shipped
 *  at and that read correctly. */
const CLUMP_TILT_DEG = 8;

/** Tint MULTIPLIERS on the vertex colour at the two ends of the lushness
 *  scalar, not absolute colours.
 *
 *  Multiplying is what keeps this compatible with the rest of the planet: the
 *  vertex colour already carries fertility and the ecology's biome palette
 *  (surface.ts), so a forest and a steppe arrive here as different greens. An
 *  absolute grass colour would flatten both into the same lawn and throw away
 *  the simulation's output. */
export const GRASS_DRY_TINT: readonly [number, number, number] = [1.22, 1.06, 0.72];
export const GRASS_LUSH_TINT: readonly [number, number, number] = [0.80, 0.96, 0.86];

/** How hard to re-expand lushness around 0.5 AFTER the two-layer blend.
 *
 *  Not a taste knob — it corrects a measured defect. The shader reads lushness
 *  as 0.6·A + 0.4·B, and averaging two samples of a distribution NARROWS it:
 *  the baked field spreads its middle 90% over 0.23..0.79, but the blend pulls
 *  that to 0.30..0.71 with 56% of all ground inside the middle fifth. Feeding
 *  that to the tint ramp uses only its middle and every meadow comes out the
 *  same mid-green — precisely the flat look the texture exists to remove.
 *
 *  So this cannot be baked into the texture: the narrowing happens AT BLEND
 *  TIME, downstream of the bake. Baking contrast in and then blending just
 *  re-narrows it. 1.6 restores a roughly even spread (measured 13/20/25/25/17
 *  across five buckets, 90% spanning 0.09..0.93). */
export const LUSH_CONTRAST = 1.6;

let grassField: THREE.DataTexture | null = null;

/** Lazy shared singleton — every terrain material samples this one texture.
 *  Never disposed with a mesh (it outlives any single world), like the toon
 *  ramp and the wave field. */
export function getGrassField(): THREE.DataTexture {
  if (!grassField) {
    grassField = bakeDetailField({
      height: (u, v) => tileFbm(u, v, CLUMP_FREQ, CLUMP_OCTAVES, 11),
      // Clump-dominant: the big patches decide whether an area reads dry or
      // lush, and the blade layer only breaks up the inside of a patch. Equal
      // weight here washes the patches out into uniform static.
      scalar: (u, v) => tileFbm(u, v, CLUMP_FREQ, CLUMP_OCTAVES, 11) * 0.65
        + tileFbm(u, v, BLADE_FREQ, BLADE_OCTAVES, 27) * 0.35,
      medianTiltDeg: CLUMP_TILT_DEG,
    });
  }
  return grassField;
}

// ── Sand ────────────────────────────────────────────────────────────────────
// TWO fields, not one field at two strengths, because the regimes are
// structurally different patterns rather than the same pattern louder:
//
//   FINE — wind ripples. Directional and periodic, because that is what wind
//     sorting produces. This is the one case in the whole detail system where a
//     visible repeat is CORRECT: real ripple fields do repeat, so the tile
//     hides itself.
//   COARSE — grit. Wind cannot move it, so there are no ripples at all; it is
//     scattered granules. Blobby, high-frequency, no direction.
//
// The shader mixes them per fragment by the sand grain regime (surface.ts), so
// a cobbly cliff-foot beach and a sorted delta flat read as different ground.

/** Sand tile, in metres. Divides DETAIL_TILE_M (64). Smaller than grass because
 *  ripple crests are ~15 cm apart and need the texel budget: at SIZE=256 this
 *  is ~1.5 cm/texel. */
export const SAND_TILE_M = 4;

/** Ripple direction, in cycles across the sand tile — ONE direction, plus
 *  harmonics of it.
 *
 *  Unidirectional is the point, and it is the exact opposite of the wave
 *  field's rule (water-normals.ts spreads directions by the golden angle
 *  specifically to avoid a grid). Wind ripples ARE unidirectional; the
 *  harmonics sharpen the crest into the asymmetric sawtooth that reads as sand
 *  rather than as a sine. What must NOT happen here is a second, non-parallel
 *  ripple set — a near-perpendicular pair is what drew the plaid in the wave
 *  field, and it would draw it again here.
 *
 *  Integer, like every frequency in the system: |k| = √10 ≈ 3.16 cycles per 4 m
 *  tile ≈ a 1.3 m ripple wavelength. */
const RIPPLE_DIR: readonly [number, number] = [3, 1];
/** Amplitude of harmonic 1, 2, 3 — a clipped sawtooth, not a sine. */
const RIPPLE_HARMONICS: readonly number[] = [1, 0.42, 0.18];
/** Phase warp: without it the ripples are dead-straight ruled lines. Tileable
 *  because tileNoise is, so the warp cannot break the wrap. */
const RIPPLE_WARP_FREQ = 3;
const RIPPLE_WARP = 1.9;
/** Wind ripples are SHALLOW — a few centimetres of relief over a ~1.3 m
 *  wavelength. Getting this wrong is loud: at 29° the beach read as corrugated
 *  iron. */
const RIPPLE_TILT_DEG = 6;

/** Grit: high-frequency blobs. The contrast curve is what turns fbm mush into
 *  something that reads as discrete granules rather than as fog. */
const GRIT_FREQ = 24;
const GRIT_OCTAVES = 3;
const GRIT_CONTRAST = 2.4;
/** Grit is bumpy — that is the whole difference from sand. Roughly double the
 *  ripple tilt, still far from a rock face. */
const GRIT_TILT_DEG = 13;

/** Tint multipliers, as with grass — but selected by the REGIME (grain), not by
 *  the texture scalar. Fine sand is pale and even; grit is darker and more
 *  varied, because it is broken rock rather than sorted quartz. */
export const SAND_FINE_TINT: readonly [number, number, number] = [1.06, 1.04, 1.0];
export const SAND_COARSE_TINT: readonly [number, number, number] = [0.82, 0.80, 0.76];
/** How much the texture's own scalar varies brightness WITHIN a regime. The
 *  regime picks the base tint; this speckles it. */
export const SAND_VARIATION = 0.22;

const rippleTheta = (u: number, v: number): number =>
  2 * Math.PI * (RIPPLE_DIR[0] * u + RIPPLE_DIR[1] * v)
  + (tileNoise(u, v, RIPPLE_WARP_FREQ, 51) - 0.5) * RIPPLE_WARP;

/** Exported for tests. The thing that makes sand read as sand is that ripples
 *  are ANISOTROPIC and grit is not — asserting on 256² encoded texels says
 *  little, but that distinction is the whole regime. */
export const rippleHeight = (u: number, v: number): number => {
  const theta = rippleTheta(u, v);
  let h = 0;
  // Harmonics of ONE warped fundamental — so the crest sharpens while the whole
  // stack stays parallel and stays tileable.
  for (let i = 0; i < RIPPLE_HARMONICS.length; i++) h += Math.sin((i + 1) * theta) * RIPPLE_HARMONICS[i];
  return h;
};

/** Exported for tests — see rippleHeight. */
export const gritHeight = (u: number, v: number): number =>
  contrast(tileFbm(u, v, GRIT_FREQ, GRIT_OCTAVES, 73), GRIT_CONTRAST);

let sandFineField: THREE.DataTexture | null = null;
let sandCoarseField: THREE.DataTexture | null = null;

export function getSandFineField(): THREE.DataTexture {
  if (!sandFineField) {
    sandFineField = bakeDetailField({
      height: rippleHeight,
      // Crests read slightly lighter than troughs, as real ripples do, over a
      // slow drift so a beach isn't one flat tone.
      scalar: (u, v) => rippleHeight(u, v) * 0.35 + tileFbm(u, v, 4, 2, 63) * 0.65,
      medianTiltDeg: RIPPLE_TILT_DEG,
    });
  }
  return sandFineField;
}

// ── Rock ────────────────────────────────────────────────────────────────────

/** Rock tile, in metres. Divides DETAIL_TILE_M (64). Bigger than sand because
 *  rock reads by fracture blocks, not grains. */
export const ROCK_TILE_M = 8;

/** Vertical period of the STRATA bed sequence, in metres.
 *
 *  This is the one tile in the whole system with NO divisibility constraint,
 *  and the reason is worth keeping: strata are sampled along `detailW`
 *  (elevation), which chunk.ts does not wrap — it can't, because layers are
 *  surfaces of constant elevation and a wrapped w would step every layer at
 *  every chunk border. The DETAIL_TILE_M rule applies only to the wrapped axes.
 *
 *  48 m over STRATA_STEPS texels gives beds of roughly 1–6 m. It repeats up a
 *  tall cliff, which is the one repeat in this system nobody should try to hide:
 *  real sedimentary sequences ARE cyclic. */
export const STRATA_PERIOD_M = 48;

const STRATA_STEPS = 256;
const STRATA_BED_MIN = 6;
const STRATA_BED_MAX = 32;

let strataRamp: THREE.DataTexture | null = null;

/** The bed sequence: a 1-D run of flat-toned layers of varying thickness.
 *
 *  A DEDICATED 1-D ramp, not a column of the rock field, and that is a fix
 *  rather than a preference. Reading a 1-D slice out of a 2-D texture inherits
 *  the 2-D normalization: measured, the slice at u=0.37 came out 84% pale / 4%
 *  dark, because a single column has no reason to span the range the whole
 *  field was normalized against. It rendered as a uniformly pale wall with a
 *  couple of streaks. Normalizing the sequence you actually READ is the only
 *  thing that keeps both ends of the tint ramp in play — the same lesson as
 *  LUSH_CONTRAST, one dimension down.
 *
 *  Beds are laid whole, so boundaries are STEPS. Everything else in this file
 *  works to be continuous at the wrap; this alone doesn't need to, because a
 *  discontinuity is exactly what a bed boundary is. */
export function getStrataRamp(): THREE.DataTexture {
  if (strataRamp) return strataRamp;
  const data = new Uint8Array(STRATA_STEPS);
  // Deterministic, and quantized so the tones are DISTINCT beds rather than a
  // drift: a sequence of near-identical greys reads as dirt, not as strata.
  const rand = mulberry32(90210);
  let y = 0;
  while (y < STRATA_STEPS) {
    const thick = STRATA_BED_MIN + Math.floor(rand() * (STRATA_BED_MAX - STRATA_BED_MIN));
    const tone = Math.round(rand() * 4) / 4; // 5 distinct rock tones
    const end = Math.min(STRATA_STEPS, y + thick);
    for (; y < end; y++) data[y] = Math.round(tone * 255);
  }
  const tex = new THREE.DataTexture(data, STRATA_STEPS, 1, THREE.RedFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Mipped: a cliff seen from altitude packs many beds into a pixel, and
  // unmipped that aliases into crawling stripes as the camera moves.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  strataRamp = tex;
  return tex;
}

const ROCK_FREQ = 6;
const ROCK_OCTAVES = 4;
const ROCK_CONTRAST = 1.5;
/** Rock is the bumpiest thing here — fracture faces, not sorted material. */
const ROCK_TILT_DEG = 20;

/** Strata tints: successive beds are different rock. Multipliers on the vertex
 *  colour, like every other material's. */
export const ROCK_PALE_TINT: readonly [number, number, number] = [1.14, 1.10, 1.04];
export const ROCK_DARK_TINT: readonly [number, number, number] = [0.72, 0.70, 0.71];

let rockField: THREE.DataTexture | null = null;

export function getRockField(): THREE.DataTexture {
  if (!rockField) {
    rockField = bakeDetailField({
      height: (u, v) => contrast(tileFbm(u, v, ROCK_FREQ, ROCK_OCTAVES, 137), ROCK_CONTRAST),
      scalar: (u, v) => tileFbm(u, v, ROCK_FREQ, ROCK_OCTAVES, 137) * 0.6
        + tileFbm(u, v, ROCK_FREQ * 4, 2, 151) * 0.4,
      medianTiltDeg: ROCK_TILT_DEG,
    });
  }
  return rockField;
}

export function getSandCoarseField(): THREE.DataTexture {
  if (!sandCoarseField) {
    sandCoarseField = bakeDetailField({
      height: gritHeight,
      // The granules ARE the colour variation — a pebble is a different rock
      // from the one beside it, so the scalar follows the same blobs.
      scalar: (u, v) => gritHeight(u, v) * 0.7 + tileFbm(u, v, 6, 2, 89) * 0.3,
      medianTiltDeg: GRIT_TILT_DEG,
    });
  }
  return sandCoarseField;
}
