/**
 * Terrain detail shading — a patch on the terrain material, not meshes of its
 * own. Water and land live in ONE patch because they must: a material has a
 * single `onBeforeCompile` slot, so a second "just for grass" patch would not
 * layer onto this one, it would silently replace it and the sea would go back
 * to flat blue with no error anywhere.
 *
 * ── SEIZURE SAFETY — READ BEFORE TUNING (water) ────────────────────────────
 * This platform serves children with Rett's Syndrome, where seizure prevalence
 * is high. Moving specular glint is a flashing-light source: a tight highlight
 * dragged across the screen by animated normals is high-frequency luminance
 * flicker, which is the classic photosensitive-epilepsy trigger.
 *
 * So water here is deliberately DULL. `roughness` stays high and `metalness`
 * stays near zero — a broad, soft sheen that shifts, never a mirror that
 * strobes. The first cut of this file used roughness 0.12 / metalness 0.25 and
 * had to be pulled: it was effectively a mirror, and it flashed.
 *
 * These are not aesthetic knobs. Making water "pop" by lowering roughness,
 * raising metalness, or raising waveStrength re-creates the hazard. If water
 * must read stronger, reach for COLOUR and CONTRAST (surface.ts's ocean
 * palette), which don't flicker. Any change here needs a moving-camera check
 * over a sunlit sea at the ground rung, not a still screenshot.
 *
 * The LAND detail below is not under the same constraint, and the reason is
 * specific rather than a judgement call: terrain is roughness 0.95 / metalness
 * 0 (three.ts), so it has no specular lobe to move, and its detail texture is
 * STATIC — nothing about it changes between frames. Perturbing it varies
 * diffuse shading only. That stops being true if terrain is ever made glossy,
 * or if land detail is ever animated (wind). Either change moves land under
 * this note.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * THERE IS NO OCEAN SHELL, AND THIS IS NOT ONE. A coincident translucent
 * sphere was tried and removed: it z-fought the seabed under logarithmic depth
 * and darted "flickering waves" across the disc (see three.ts, and the
 * neutered corpse at games/seagull-dream/src/celestial-body.ts). The terrain
 * mesh already renders a flat, depth-shaded sea-level surface via seaClamp;
 * this only changes how the water VERTICES of that mesh shade. No new draw
 * call, no transparency sort, no depth bias, nothing to z-fight.
 *
 * WHAT EACH MODE DOES, AND WHY THEY DIVERGE:
 *
 *   standard — water: the wave field's NORMALS perturb the surface normal, so
 *     the soft sheen drifts, and water stops shading like dirt. Land: the grass
 *     field's normals do the same for clump relief, plus the tint below.
 *
 *   toon — water: the wave field's HEIGHT is thresholded into flat foam bands.
 *     Land: tint only, NO normal perturbation. Both follow from the same fact —
 *     MeshToonMaterial quantizes N·L through a 4-step nearest-filtered ramp
 *     (materials.ts). A perturbed normal there doesn't shade, it drags the
 *     ramp's step boundaries around: on water they crawl as contour lines, and
 *     on static ground they freeze into hard blotches wherever a clump happens
 *     to straddle a step. Cel surfaces are DRAWN, not lit.
 *
 * TWO LAYERS EVERYWHERE: each field is sampled twice and blended, because one
 * layer at any scale reads as a visible repeat — 8 m for grass is very visible
 * on open ground. The second layer is transformed by an INTEGER matrix (see
 * LAYER B) so the two never align.
 */
import * as THREE from "three";
import { getShadingMode, type LitMaterial, type ShadingMode } from "../materials";
import { DETAIL_TILE_M } from "./chunk";
import { getWaveField } from "./water-normals";
import { TERMINATOR_GLSL, setTerminatorUniforms, type PlanetTerminatorOpts } from "./day-night";
import {
  GRASS_DRY_TINT, GRASS_LUSH_TINT, GRASS_TILE_M, LUSH_CONTRAST, getGrassField,
  SAND_COARSE_TINT, SAND_FINE_TINT, SAND_TILE_M, SAND_VARIATION,
  getSandCoarseField, getSandFineField,
  ROCK_DARK_TINT, ROCK_PALE_TINT, ROCK_TILE_M, STRATA_PERIOD_M, getRockField, getStrataRamp,
} from "./land-textures";

export interface WaterShadingOpts {
  /** Standard only. HIGH = safe. See SEIZURE SAFETY. */
  roughness?: number;
  /** Standard only. NEAR ZERO = safe. See SEIZURE SAFETY. */
  metalness?: number;
  /** How hard the wave normals bite. See SEIZURE SAFETY before raising. */
  waveStrength?: number;
  /** Toon only: foam tint. */
  foamColor?: THREE.ColorRepresentation;
  /** Toon only: how much foam lifts the water colour, 0..1. */
  foamStrength?: number;
  /** How fast a RIVER's water runs, in detail tiles/sec (×DETAIL_TILE_M for
   *  m/s). Only vertices with a current use it — ocean and lakes keep their own
   *  fixed drift. Clamped to WATER_SAFETY.maxFlowSpeed. */
  flowSpeed?: number;
}

export interface GrassShadingOpts {
  /** Overall bite of the grass detail, 0..1 — scales both tint and relief. */
  strength?: number;
  /** Tint multiplier at the dry end of the lushness ramp. */
  dryTint?: THREE.ColorRepresentation;
  /** Tint multiplier at the lush end. */
  lushTint?: THREE.ColorRepresentation;
}

export interface SandShadingOpts {
  /** Overall bite of the sand detail, 0..1 — scales tint and relief. */
  strength?: number;
  /** Tint multiplier for fully-fine (sorted, rippled) sand. */
  fineTint?: THREE.ColorRepresentation;
  /** Tint multiplier for fully-coarse (grit) sand. */
  coarseTint?: THREE.ColorRepresentation;
}

export interface RockShadingOpts {
  /** Overall bite of the rock detail, 0..1. */
  strength?: number;
  /** How strongly strata recolour the rock, 0..1. */
  strataStrength?: number;
  /** Tint multipliers for the pale / dark ends of the bed sequence. */
  paleTint?: THREE.ColorRepresentation;
  darkTint?: THREE.ColorRepresentation;
}

export interface TerrainShadingOpts {
  /** `false` = flat blue sea (skips the water GLSL entirely). */
  water?: false | WaterShadingOpts;
  /** `false` = flat vertex-colour ground. */
  grass?: false | GrassShadingOpts;
  /** `false` = flat vertex-colour ground. */
  sand?: false | SandShadingOpts;
  /** `false` = flat vertex-colour ground. */
  rock?: false | RockShadingOpts;
  /** Planet-scale day/night terminator (toon only) — see day-night.ts. Set it
   *  for a body seen from space so the whole disc doesn't shade through the
   *  shared cel ramp's disc-wide bands. Omit for a ground/local scope, whose
   *  terminator is off-screen. No effect under standard shading. */
  terminator?: PlanetTerminatorOpts;
}

// Defaults. The water pair is deliberately close to matte — see SEIZURE
// SAFETY; this is the hazard's main dial.
const DEFAULT_ROUGHNESS = 0.55;
const DEFAULT_METALNESS = 0.02;
const DEFAULT_WAVE_STRENGTH = 0.6;
/** River current, in detail tiles/sec — ~3.2 m/s at DETAIL_TILE_M = 64, a
 *  brisk river. The point of the current is to make the FLOW LOGIC legible
 *  (which way the solver routed the water), and at walking pace over the
 *  river wave scale the drift read as still. Inside WATER_SAFETY.maxFlowSpeed;
 *  see the frequency math there (river waves are RIVER_WAVE_SCALE finer). */
const DEFAULT_FLOW_SPEED = 0.05;
const DEFAULT_FOAM_COLOR = 0x9fc4d8;
const DEFAULT_FOAM_STRENGTH = 0.3;
const DEFAULT_GRASS_STRENGTH = 0.75;
const DEFAULT_SAND_STRENGTH = 0.8;
const DEFAULT_ROCK_STRENGTH = 0.85;
const DEFAULT_STRATA_STRENGTH = 0.55;

/** Hard bounds on the glint hazard — see SEIZURE SAFETY. ENFORCED, not
 *  advisory: callers are clamped into this envelope rather than trusted, so a
 *  well-meaning `{ roughness: 0.05 }` at some call site can't quietly turn the
 *  ocean back into a strobing mirror. Widening these is a safety decision, not
 *  a rendering one. */
export const WATER_SAFETY = {
  /** Below this the specular lobe is tight enough to strobe as it moves. */
  minRoughness: 0.35,
  /** Above this the reflection sharpens toward mirror. */
  maxMetalness: 0.15,
  /** Above this the normals swing far enough to flick the highlight. */
  maxWaveStrength: 1,
  /** River current, in DETAIL TILES per second (×DETAIL_TILE_M for m/s).
   *
   *  Unlike its neighbours here this one is not close to the hazard, and the
   *  number says why rather than hiding it: river water samples the wave
   *  field RIVER_WAVE_SCALE (4×) finer than the ocean, so its longest wave is
   *  ~4 m and a band crosses a fixed point at speed × 64 / 4 Hz. At this cap
   *  (0.06 tiles/s ≈ 3.8 m/s, a fast river) that is ~0.96 Hz — a third of the
   *  ~3 Hz photosensitive band's floor, with the band's onset well above
   *  that. Recheck the maths if DETAIL_TILE_M, RIVER_WAVE_SCALE, or the wave
   *  spectrum moves; don't just raise the number. */
  maxFlowSpeed: 0.06,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
const elapsedSeconds = (): number =>
  typeof performance !== "undefined" ? (performance.now() - startedAt) / 1000 : 0;

/** Shared declarations + the two-layer sample coords.
 *
 *  LAYER B is transformed by mat2(2,1,-1,2) — a rotation of ~26.57° with scale
 *  √5. The rotation is what stops the two layers reinforcing each other's
 *  angles (they share one texture, so an unrotated B just redraws A's pattern
 *  at another size). It MUST stay an INTEGER matrix: chunk.ts wraps detailUv by
 *  whole DETAIL_TILE_M, which is invisible only if every layer's transform maps
 *  whole tiles to whole tiles. An integer matrix maps the lattice onto itself;
 *  an arbitrary rotation angle — or a fractional scale — turns every chunk
 *  border into a seam in that layer.
 *
 *  Every tile divisor below (uDetailTile for water, uGrassTile and ×4,
 *  uSandTile and ×8) must divide DETAIL_TILE_M for the same reason — including
 *  the multiplied ones, which is the easy half of the rule to forget.
 *  Water drift rates are per-frame uniforms
 *  and so are free of the wrap: those carry water's irregularity. Land has no
 *  such escape and lives entirely on the lattice. */
export const DETAIL_COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform float uDetailTile;
varying float vWater;
varying vec2 vFlow;
varying vec3 vTerrain;
varying vec3 vRegime;
varying vec2 vDetailUv;
varying float vDetailW;
varying vec3 vTriN;

const mat2 LAYER_B = mat2(2.0, 1.0, -1.0, 2.0);
`;

const WATER_GLSL = /* glsl */ `
uniform sampler2D uWaveField;
uniform float uFlowSpeed;

/** RIVER WAVE SCALE: flowing water samples the wave field this much FINER
 *  than the ocean. The ocean's ~16 m waves dwarf a creek — over a few metres
 *  of channel the pattern is essentially uniform and its drift reads as
 *  STILL. 4× gives ~4 m ripples that visibly travel at channel scale.
 *  MUST stay an INTEGER (the LAYER_B lattice-wrap rule: chunk borders seam
 *  for any transform that doesn't map whole tiles to whole tiles), and the
 *  WATER_SAFETY.maxFlowSpeed frequency math is written against it. */
const float RIVER_WAVE_SCALE = 4.0;

float isRiver() { return dot(vFlow, vFlow) > 1e-6 ? 1.0 : 0.0; }
float waveScale() { return mix(1.0, RIVER_WAVE_SCALE, isRiver()); }

/** The drift the wave field scrolls at, in TILES per second.
 *
 *  Still water (ocean, lakes, and anything with no river under it) keeps the
 *  two fixed drifts that carry its irregularity. A RIVER replaces them with its
 *  own current: vFlow is the unit downstream direction in detailUv metres
 *  (chunk.ts), zero wherever there is no current, which is what selects between
 *  the two here — no branch uniform, no second shader. The river drift is
 *  scaled by waveScale() so uFlowSpeed keeps meaning METRES per second over
 *  the finer river coordinate.
 *
 *  NEGATED because scrolling a texture coordinate by +d makes the pattern
 *  appear to travel in −d: to make the water run DOWNSTREAM, sample upstream.
 *
 *  Layer B's drift is transformed by LAYER_B for a reason that is easy to miss:
 *  B's coordinate is LAYER_B × uv, so a world-space displacement f shows up in
 *  B's space as LAYER_B·f. Drifting B by a raw f would send the second layer
 *  off at ~26° across the current. The 0.8 makes B lag A slightly — two layers
 *  at the same speed lock into one pattern, and the difference is the parallax
 *  that reads as depth. */
vec2 waveDriftA() {
  return isRiver() > 0.5 ? -vFlow * uFlowSpeed * waveScale() : vec2( 0.031, 0.019);
}
vec2 waveDriftB() {
  return isRiver() > 0.5 ? LAYER_B * (-vFlow * uFlowSpeed * waveScale() * 0.8) : vec2(-0.023, 0.041);
}

vec2 waveUvA() { return waveScale() * vDetailUv / uDetailTile + waveDriftA() * uTime; }
vec2 waveUvB() { return LAYER_B * (waveScale() * vDetailUv / uDetailTile) + waveDriftB() * uTime; }
`;

const ROCK_GLSL = /* glsl */ `
uniform sampler2D uRockField;
uniform sampler2D uStrataRamp;
uniform float uRockTile;
uniform float uRockStrength;
uniform float uStrataPeriod;
uniform float uStrataStrength;
uniform vec3 uRockPale;
uniform vec3 uRockDark;

float rockWeight() { return vTerrain.b * uRockStrength; }

/** Triplanar blend weights from the normal in the (u, v, radial) frame.
 *
 *  THIS is why rock needed new plumbing when grass and sand didn't. detailUv is
 *  a TANGENT-PLANE projection: fine for meadows and beaches, which lie flat, but
 *  on a cliff it barely changes down the face, so a single-plane sample smears
 *  the texture into vertical streaks — on exactly the terrain rock lives on. */
vec3 triWeights() {
  vec3 w = abs(vTriN);
  // Sharpened so the transition between projections is a narrow band rather
  // than a wide mush where all three are half-applied.
  w = w * w * w;
  return w / max(1e-5, w.x + w.y + w.z);
}

/** Rock sampled on all three planes at ONE tile size. The wall planes pair a
 *  horizontal axis with ELEVATION, which is what makes a cliff face read as a
 *  cliff face. rot passes the plane coordinates through a matrix so a second
 *  scale can be decorrelated from the first — see rockSample. */
vec4 rockPlane(float tile, mat2 rot, vec3 w) {
  vec2 pTop = rot * (vDetailUv / tile);                    // flat ground: (u, v)
  vec2 pU = rot * (vec2(vDetailUv.y, vDetailW) / tile);    // wall facing u: (v, w)
  vec2 pV = rot * (vec2(vDetailUv.x, vDetailW) / tile);    // wall facing v: (u, w)
  return texture2D(uRockField, pTop) * w.z
       + texture2D(uRockField, pU) * w.x
       + texture2D(uRockField, pV) * w.y;
}

/** Two scales of the one rock field. The fine tile carries fracture detail up
 *  close; a far coarser, LAYER_B-rotated layer modulates it, so the 8 m tile
 *  stops reading as a grid once the camera pulls back. This is the same
 *  repeat-hiding trick grass (uGrassTile*4) and sand (uSandTile*8) already use
 *  and that rock alone was missing — the fractal breakup that reads as natural
 *  at wide zoom lives in the coarse layer, the detail at close range in the
 *  fine one. Costs three extra texture reads on rock-weighted ground only. */
vec4 rockSample(vec3 w) {
  vec4 a = rockPlane(uRockTile, mat2(1.0, 0.0, 0.0, 1.0), w);
  vec4 b = rockPlane(uRockTile * 6.0, LAYER_B, w);
  return mix(a, b, 0.4);
}

/** The bed sequence, read off ELEVATION alone — which is the whole definition of
 *  a stratum, and why this needs no river field. Rivers don't make strata; they
 *  cut down and expose them (see surface.ts's exposureAt, which is what puts
 *  rock in a valley at all).
 *
 *  The ramp is a dedicated 1-D texture, normalized over the sequence actually
 *  read — see getStrataRamp for why a column of the rock field was wrong. Bed
 *  boundaries are baked as steps, so nothing here needs to sharpen them. */
vec3 strataTint() {
  // Keyed to elevation alone, beds run as surgically level lines — the "linear"
  // read. Warp the elevation the ramp is sampled at by a low-frequency function
  // of HORIZONTAL position, so a bed undulates a metre or two up and down across
  // a face instead of ruling a dead-straight line. Small on purpose: strata ARE
  // level to first order, tilting and folding is what makes them look laid down
  // rather than printed. Reuses the coarse rock field as the noise source.
  float warp = (texture2D(uRockField, LAYER_B * (vDetailUv / (uRockTile * 16.0))).w - 0.5) * 4.0;
  float bed = texture2D(uStrataRamp, vec2((vDetailW + warp) / uStrataPeriod, 0.5)).r;
  return mix(uRockDark, uRockPale, bed);
}

vec3 rockTint(vec4 s) {
  // Beds set the base colour; the sampled mottle varies it WITHIN a bed, so a
  // flat bench of one stratum isn't a single flat wash of colour.
  vec3 base = mix(vec3(1.0), strataTint(), uStrataStrength);
  return base * (1.0 + (s.w - 0.5) * 0.30);
}
`;

const SAND_GLSL = /* glsl */ `
uniform sampler2D uSandFineField;
uniform sampler2D uSandCoarseField;
uniform float uSandTile;
uniform float uSandStrength;
uniform float uSandVariation;
uniform vec3 uSandFineTint;
uniform vec3 uSandCoarseTint;

vec2 sandUvA() { return vDetailUv / uSandTile; }
vec2 sandUvB() { return LAYER_B * (vDetailUv / (uSandTile * 8.0)); }
// A THIRD, far coarser scale — tens of metres. Not ripples and not detail: the
// slow tonal drift of a real beach, patches of lighter and darker sand that
// stay visible when the ripple layer has long since mipped to a flat wash.
// This is the "uneven over larger distances" layer; it modulates TONE only.
vec2 sandUvC() { return LAYER_B * (vDetailUv / (uSandTile * 32.0)); }

float sandWeight() { return vTerrain.r * uSandStrength; }
/** Grain regime, 0 = fine sorted sand, 1 = raw grit. From local relief — see
 *  the SEDIMENT REGIME note in surface.ts. */
float sandGrain() { return vRegime.r; }

/** One sample of the sand field, already mixed between the two regimes: normal
 *  in xyz, tint scalar in w.
 *
 *  Mixing the two textures' RGBA in one lerp gets the regime blend for both the
 *  relief and the colour at once — a cobbly beach and a sorted flat are two
 *  different patterns, not one pattern at two strengths, so there is no single
 *  texture this could have been. */
vec4 sandSample() {
  float g = sandGrain();
  vec4 a = mix(texture2D(uSandFineField, sandUvA()), texture2D(uSandCoarseField, sandUvA()), g);
  // A far coarser second layer, for the slow light/dark drift across a beach.
  // Unlike grass this is NOT here to hide the tile: ripples are periodic in
  // reality, so the 4 m repeat is the one repeat in this system that reads as
  // correct rather than as an artifact.
  vec4 b = mix(texture2D(uSandFineField, sandUvB()), texture2D(uSandCoarseField, sandUvB()), g);
  return mix(a, b, 0.25);
}

vec3 sandTint(vec4 s) {
  // The REGIME picks the base colour; the texture scalar only speckles within
  // it. Fine sand is pale and even, grit is darker and varied.
  vec3 base = mix(uSandFineTint, uSandCoarseTint, sandGrain());
  // Macro tonal drift, keyed to the coarse third scale so it survives distance:
  // half the strength of the local speckle, since a beach's large-scale shading
  // is gentler than its grain. Sampled from the fine field's tint channel.
  float macro = (texture2D(uSandFineField, sandUvC()).w - 0.5) * uSandVariation * 0.5;
  return base * (1.0 + (s.w - 0.5) * uSandVariation + macro);
}
`;

const GRASS_GLSL = /* glsl */ `
uniform sampler2D uGrassField;
uniform float uGrassTile;
uniform float uGrassStrength;
uniform float uGrassContrast;
uniform vec3 uGrassDry;
uniform vec3 uGrassLush;

vec2 grassUvA() { return vDetailUv / uGrassTile; }
// 4x the tile: a slow modulation across the fast layer's repeat. This is what
// hides the 8 m tile on open ground — same texture, different scale, so it
// costs a sample and no memory.
vec2 grassUvB() { return LAYER_B * (vDetailUv / (uGrassTile * 4.0)); }

float grassWeight() { return vTerrain.g * uGrassStrength; }

/** Tint MULTIPLIER, never an absolute colour: the vertex colour already carries
 *  fertility and the ecology's biome palette, and replacing it would flatten
 *  forest and steppe into the same lawn. See land-textures.ts. */
vec3 grassTint() {
  float lush = texture2D(uGrassField, grassUvA()).a * 0.6
             + texture2D(uGrassField, grassUvB()).a * 0.4;
  // Re-expand around the midpoint: the blend above narrows the distribution and
  // would leave the ramp using only its middle. See LUSH_CONTRAST — this is a
  // correction, not a look.
  lush = smoothstep(0.0, 1.0, clamp((lush - 0.5) * uGrassContrast + 0.5, 0.0, 1.0));
  return mix(uGrassDry, uGrassLush, lush);
}
`;

interface Sections {
  water: false | WaterShadingOpts;
  grass: false | GrassShadingOpts;
  sand: false | SandShadingOpts;
  rock: false | RockShadingOpts;
  /** null = no terminator (ground scope / standard mode). */
  terminator: PlanetTerminatorOpts | null;
}

function resolve(opts: TerrainShadingOpts): Sections {
  return {
    water: opts.water ?? {},
    grass: opts.grass ?? {},
    sand: opts.sand ?? {},
    rock: opts.rock ?? {},
    terminator: opts.terminator ?? null,
  };
}

/** The cache key MUST encode which sections were compiled. three hands back a
 *  cached program for a matching key without recompiling, so two materials that
 *  differ only by `grass: false` would otherwise share one program and one of
 *  them would be wrong. */
function cacheKey(mode: ShadingMode, s: Sections): string {
  return `planet-terrain-${mode}-v3-${s.water !== false ? "w" : ""}${s.grass !== false ? "g" : ""}${s.sand !== false ? "s" : ""}${s.rock !== false ? "r" : ""}${s.terminator ? "t" : ""}`;
}

/** The land tint splice — byte-identical in both modes, because tinting is the
 *  part of land detail that has nothing to do with lighting.
 *
 *  Tints MULTIPLY, so they compose: ground that is part sand and part grass
 *  gets both, each scaled by its own weight, and the result is the same
 *  whichever order they land in. That is exactly why the NORMALS can't be done
 *  this way — a normal is a direction, not a scale, and two of them don't
 *  compose into anything meaningful. */
function landColorGlsl(s: Sections): string {
  const lines: string[] = [];
  if (s.rock !== false) {
    lines.push("if (vWater < 0.5) diffuseColor.rgb *= mix(vec3(1.0), rockTint(rockSample(triWeights())), rockWeight());");
  }
  if (s.sand !== false) {
    lines.push("if (vWater < 0.5) diffuseColor.rgb *= mix(vec3(1.0), sandTint(sandSample()), sandWeight());");
  }
  if (s.grass !== false) {
    lines.push("if (vWater < 0.5) diffuseColor.rgb *= mix(vec3(1.0), grassTint(), grassWeight());");
  }
  return lines.join("\n");
}

function patchStandard(material: THREE.MeshStandardMaterial, s: Sections): void {
  material.onBeforeCompile = (shader) => {
    applyCommonUniforms(shader, s);
    patchVertex(shader);

    let head = `#include <common>\n${DETAIL_COMMON_GLSL}`;
    if (s.water !== false) {
      // Clamped, not trusted — see WATER_SAFETY.
      const waveStrength = clamp(s.water.waveStrength ?? DEFAULT_WAVE_STRENGTH, 0, WATER_SAFETY.maxWaveStrength);
      shader.uniforms.uWaterRoughness = {
        value: clamp(s.water.roughness ?? DEFAULT_ROUGHNESS, WATER_SAFETY.minRoughness, 1),
      };
      shader.uniforms.uWaterMetalness = {
        value: clamp(s.water.metalness ?? DEFAULT_METALNESS, 0, WATER_SAFETY.maxMetalness),
      };
      shader.uniforms.uWaveStrength = { value: waveStrength };
      head += `
${WATER_GLSL}
uniform float uWaterRoughness;
uniform float uWaterMetalness;
uniform float uWaveStrength;

vec3 waveNormal() {
  vec3 nA = texture2D(uWaveField, waveUvA()).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uWaveField, waveUvB()).xyz * 2.0 - 1.0;
  // Whiteout blend: sum the slopes, keep z positive. Averaging the vectors
  // instead would pull both layers toward flat where they disagree.
  vec3 n = vec3(nA.xy + nB.xy, nA.z * nB.z);
  n.xy *= uWaveStrength;
  return normalize(n);
}`;
    }
    if (s.rock !== false) {
      head += `
${ROCK_GLSL}
vec3 rockNormal(vec4 smp, float w) {
  vec3 n = smp.xyz * 2.0 - 1.0;
  n.xy *= w;
  return normalize(n);
}`;
    }
    if (s.sand !== false) {
      head += `
${SAND_GLSL}
vec3 sandNormal(vec4 smp, float w) {
  vec3 n = smp.xyz * 2.0 - 1.0;
  n.xy *= w;
  return normalize(n);
}`;
    }
    if (s.grass !== false) {
      head += `
${GRASS_GLSL}
vec3 grassNormal(float w) {
  vec3 nA = texture2D(uGrassField, grassUvA()).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uGrassField, grassUvB()).xyz * 2.0 - 1.0;
  vec3 n = vec3(nA.xy + nB.xy, nA.z * nB.z);
  n.xy *= w;
  return normalize(n);
}`;
    }
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", head);

    // ── Normals ──────────────────────────────────────────────────────────────
    // After normal_fragment_begin so `normal` exists and is the geometric one;
    // before lighting consumes it.
    const normalBody: string[] = [];
    if (s.water !== false) normalBody.push("if (vWater > 0.5) dn = waveNormal();");
    // Land materials apply in ascending weight order, so the DOMINANT one wins
    // on ground that blends between them (a barren shore is part sand, part
    // grass). Averaging their normals instead would blend two unrelated reliefs
    // into mush that reads as neither — unlike the tints below, which multiply
    // and so genuinely compose.
    if (s.rock !== false) {
      // Rock's normal rides the FLAT-GROUND projection only, faded by that
      // projection's own triplanar weight.
      //
      // That fade is not a stylistic choice — it is required. The tangent frame
      // below is reconstructed from screen-space derivatives of detailUv, and on
      // a near-vertical face detailUv barely changes, so the frame degenerates
      // into noise exactly where rock is most exposed. triWeights().z goes to
      // zero on precisely those faces, so the perturbation retires itself right
      // where it would otherwise turn to garbage. Cliffs get their relief from
      // the triplanar ALBEDO and from the mesh's own geometry; flat rock benches
      // get the bumps.
      normalBody.push(`vec3 rW = triWeights();
  float rkW = rockWeight() * rW.z;
  if (vWater < 0.5 && rkW > 0.001) dn = rockNormal(rockSample(rW), rkW);`);
    }
    if (s.sand !== false) {
      normalBody.push(`float sW = sandWeight();
  if (vWater < 0.5 && sW > 0.001 && sW >= ${s.rock !== false ? "rockWeight()" : "0.0"}) dn = sandNormal(sandSample(), sW);`);
    }
    if (s.grass !== false) {
      normalBody.push(`float gW = grassWeight();
  if (vWater < 0.5 && gW > 0.001 && gW >= ${s.sand !== false ? "sandWeight()" : "0.0"}) dn = grassNormal(gW);`);
    }
    if (normalBody.length) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
{
  vec3 dn = vec3(0.0, 0.0, 1.0);
  ${normalBody.join("\n  ")}
  if (dn.x != 0.0 || dn.y != 0.0) {
    // Frame from screen-space derivatives of the detail coord — the geometry
    // carries no tangents, and generating them for every chunk would cost an
    // attribute and a rebuild.
    vec3 dpdx = dFdx(-vViewPosition);
    vec3 dpdy = dFdy(-vViewPosition);
    vec2 duvdx = dFdx(vDetailUv);
    vec2 duvdy = dFdy(vDetailUv);
    float det = duvdx.x * duvdy.y - duvdy.x * duvdx.y;
    if (abs(det) > 1e-12) {
      vec3 T = normalize((duvdy.y * dpdx - duvdx.y * dpdy) / det);
      vec3 B = normalize(cross(normal, T));
      T = cross(B, normal);
      normal = normalize(T * dn.x + B * dn.y + normal * dn.z);
    }
  }
}`,
      );
    }

    const landColor = landColorGlsl(s);
    if (landColor) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
${landColor}`,
      );
    }

    if (s.water !== false) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, uWaterRoughness, step(0.5, vWater));`,
        )
        .replace(
          "#include <metalnessmap_fragment>",
          `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uWaterMetalness, step(0.5, vWater));`,
        );
    }
  };
  material.customProgramCacheKey = () => cacheKey("standard", s);
}

function patchToon(material: THREE.MeshToonMaterial, s: Sections): void {
  material.onBeforeCompile = (shader) => {
    applyCommonUniforms(shader, s);
    patchVertex(shader);

    let head = `#include <common>\n${DETAIL_COMMON_GLSL}`;
    if (s.water !== false) {
      shader.uniforms.uFoamColor = { value: new THREE.Color(s.water.foamColor ?? DEFAULT_FOAM_COLOR) };
      shader.uniforms.uFoamStrength = { value: s.water.foamStrength ?? DEFAULT_FOAM_STRENGTH };
      head += `
${WATER_GLSL}
uniform vec3 uFoamColor;
uniform float uFoamStrength;

// Height, not slope: cel water is DRAWN. Two thresholds give two flat bands —
// a wide crest tint and a narrow bright cap — which is what reads as a stylised
// wave. A smooth gradient here would just look like a blurry photo of water and
// lose the cel look entirely.
float foamBands() {
  float h = (texture2D(uWaveField, waveUvA()).a + texture2D(uWaveField, waveUvB()).a) * 0.5;
  // step(), not smoothstep(): hard edges ARE the look, and the ramp in
  // materials.ts is nearest-filtered for the same reason.
  return step(0.62, h) * 0.55 + step(0.78, h) * 0.45;
}`;
    }
    if (s.rock !== false) head += `\n${ROCK_GLSL}`;
    if (s.sand !== false) head += `\n${SAND_GLSL}`;
    if (s.grass !== false) head += `\n${GRASS_GLSL}`;
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", head);

    // Planet-scale day/night: bypass the shared cel ramp's disc-wide bands for a
    // physical terminator + night floor (day-night.ts). Only when this material
    // clothes a body seen from space — a ground scope leaves `terminator` unset.
    if (s.terminator) {
      setTerminatorUniforms(shader, s.terminator);
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <gradientmap_pars_fragment>",
        TERMINATOR_GLSL,
      );
    }

    // diffuseColor exists after color_fragment (base colour × vertex colour).
    const body: string[] = [];
    if (s.water !== false) {
      body.push("if (vWater > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, foamBands() * uFoamStrength);");
    }
    // Tint only — no normal perturbation. See the mode note in the header.
    const land = landColorGlsl(s);
    if (land) body.push(land);
    if (body.length) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${body.join("\n")}`,
      );
    }
  };
  material.customProgramCacheKey = () => cacheKey("toon", s);
}

function applyCommonUniforms(shader: THREE.WebGLProgramParametersWithUniforms, s: Sections): void {
  // Live getter rather than a per-frame poke: three only re-uploads a
  // material's custom uniforms when it decides to refresh that material, so a
  // value written from an update() call can be silently dropped. Reading the
  // clock at upload time sidesteps the question — the same idiom the old
  // seagull ocean used for its depth bias.
  shader.uniforms.uTime = {
    get value() { return elapsedSeconds(); },
    set value(_v: number) { /* clock-driven; ignore writes */ },
  } as unknown as THREE.IUniform;
  shader.uniforms.uDetailTile = { value: DETAIL_TILE_M };
  if (s.water !== false) {
    shader.uniforms.uWaveField = { value: getWaveField() };
    // Clamped, not trusted — same rule as roughness/metalness/waveStrength.
    shader.uniforms.uFlowSpeed = {
      value: clamp(s.water.flowSpeed ?? DEFAULT_FLOW_SPEED, 0, WATER_SAFETY.maxFlowSpeed),
    };
  }
  if (s.rock !== false) {
    shader.uniforms.uRockField = { value: getRockField() };
    shader.uniforms.uRockTile = { value: ROCK_TILE_M };
    shader.uniforms.uRockStrength = { value: clamp(s.rock.strength ?? DEFAULT_ROCK_STRENGTH, 0, 1) };
    shader.uniforms.uStrataRamp = { value: getStrataRamp() };
    shader.uniforms.uStrataPeriod = { value: STRATA_PERIOD_M };
    shader.uniforms.uStrataStrength = { value: clamp(s.rock.strataStrength ?? DEFAULT_STRATA_STRENGTH, 0, 1) };
    shader.uniforms.uRockPale = {
      value: s.rock.paleTint !== undefined ? new THREE.Color(s.rock.paleTint) : new THREE.Color(...ROCK_PALE_TINT),
    };
    shader.uniforms.uRockDark = {
      value: s.rock.darkTint !== undefined ? new THREE.Color(s.rock.darkTint) : new THREE.Color(...ROCK_DARK_TINT),
    };
  }
  if (s.sand !== false) {
    shader.uniforms.uSandFineField = { value: getSandFineField() };
    shader.uniforms.uSandCoarseField = { value: getSandCoarseField() };
    shader.uniforms.uSandTile = { value: SAND_TILE_M };
    shader.uniforms.uSandStrength = { value: clamp(s.sand.strength ?? DEFAULT_SAND_STRENGTH, 0, 1) };
    shader.uniforms.uSandVariation = { value: SAND_VARIATION };
    shader.uniforms.uSandFineTint = {
      value: s.sand.fineTint !== undefined ? new THREE.Color(s.sand.fineTint) : new THREE.Color(...SAND_FINE_TINT),
    };
    shader.uniforms.uSandCoarseTint = {
      value: s.sand.coarseTint !== undefined ? new THREE.Color(s.sand.coarseTint) : new THREE.Color(...SAND_COARSE_TINT),
    };
  }
  if (s.grass !== false) {
    shader.uniforms.uGrassField = { value: getGrassField() };
    shader.uniforms.uGrassTile = { value: GRASS_TILE_M };
    shader.uniforms.uGrassStrength = { value: clamp(s.grass.strength ?? DEFAULT_GRASS_STRENGTH, 0, 1) };
    shader.uniforms.uGrassContrast = { value: LUSH_CONTRAST };
    shader.uniforms.uGrassDry = {
      value: s.grass.dryTint !== undefined ? new THREE.Color(s.grass.dryTint) : new THREE.Color(...GRASS_DRY_TINT),
    };
    shader.uniforms.uGrassLush = {
      value: s.grass.lushTint !== undefined ? new THREE.Color(s.grass.lushTint) : new THREE.Color(...GRASS_LUSH_TINT),
    };
  }
}

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
attribute float water;
attribute vec2 flow;
attribute vec3 terrain;
attribute vec3 regime;
attribute vec2 detailUv;
attribute float detailW;
attribute vec3 triN;
varying float vWater;
varying vec2 vFlow;
varying vec3 vTerrain;
varying vec3 vRegime;
varying vec2 vDetailUv;
varying float vDetailW;
varying vec3 vTriN;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
vWater = water;
vFlow = flow;
vTerrain = terrain;
vRegime = regime;
vDetailUv = detailUv;
vDetailW = detailW;
vTriN = triN;`,
    );
}

/** Patch a terrain material so its water and land vertices shade with detail.
 *
 *  Dispatches on the material's actual class rather than the engine-wide mode,
 *  so a per-material `mode` override (LitOpts.mode) still gets the right patch.
 *  Call ONCE per material — this owns `onBeforeCompile`, so a second call, or
 *  any other patch on the same material, replaces rather than adds. The material
 *  must be fed geometry carrying the `water`, `terrain` and `detailUv`
 *  attributes. */
export function applyTerrainShading(material: LitMaterial, opts: TerrainShadingOpts = {}): void {
  const s = resolve(opts);
  if (s.water === false && s.grass === false && s.sand === false && s.rock === false && !s.terminator) return;
  if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    patchStandard(material as THREE.MeshStandardMaterial, s);
  } else if ((material as THREE.MeshToonMaterial).isMeshToonMaterial) {
    patchToon(material as THREE.MeshToonMaterial, s);
  }
}

/** Which patch `applyTerrainShading` would apply to a material built in `mode`.
 *  Exported for tests — the shading itself needs a GL context, but the routing
 *  decision doesn't, and getting it wrong silently reverts terrain to flat. */
export function terrainPatchFor(mode: ShadingMode = getShadingMode()): "standard" | "toon" {
  return mode === "toon" ? "toon" : "standard";
}
