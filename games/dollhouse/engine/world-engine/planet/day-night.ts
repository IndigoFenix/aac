/**
 * Planet-scale day/night shading — the TERMINATOR, i.e. the boundary between the
 * lit and unlit hemispheres of a body seen from space.
 *
 * THE PROBLEM THIS FIXES. In toon mode every lit surface shades through ONE
 * shared cel ramp (materials.ts: [70,135,200,255]), quantizing N·L into four
 * even steps. That ramp is authored for objects a few metres across — creatures,
 * props, a hillside — where four bands across a curved surface read as stylised
 * form. Wrapped around a whole PLANET the same four bands smear into wide, evenly
 * spaced stripes and the day→night edge crawls across a third of the disc: a real
 * terminator is a narrow line, not a gradient the width of a continent.
 *
 * WHAT THIS DOES INSTEAD. For planet-scale toon materials only, `getGradientIrradiance`
 * is replaced (the shared ramp is bypassed) with a terminator whose HALF-WIDTH is
 * a physical quantity — see `computeTerminatorWidth`. The transition from the
 * night floor to full daylight is compressed into ±width around the geometric
 * terminator (N·L = 0); a handful of cel steps are kept ONLY across that
 * transition, so the body still reads as toon without the whole disc banding.
 *
 * WHY WIDTH IS NOT A CONSTANT. Three things blur a real terminator, and all three
 * are already known per-body, so the width is derived rather than dialled:
 *   • the STAR's angular size (R_star / distance) — a nearby or giant star casts a
 *     wide penumbra; a distant point-like star casts a knife edge;
 *   • the ATMOSPHERE — scattering carries daylight around the limb, the twilight
 *     wrap ≈ √(2·k·H / R) for scale height H; thick air = a broad soft edge;
 *   • the PLANET's SIZE — it enters that same term as R: a big world has a
 *     proportionally thinner atmosphere and so a sharper edge than a small one
 *     with the same air.
 *
 * NIGHT IS NOT BLACK. A physically-unlit night hemisphere is correct and
 * unplayable — you cannot see where you are going. `NIGHT_FLOOR` is a flat
 * minimum brightness the unlit side never drops below. It is deliberately a
 * CONSTANT, not derived: it is a legibility guarantee, not a light model.
 *
 * This module is toon-only. Under standard shading the terminator is already a
 * Lambert falloff (a sharp, physical edge), so these patches no-op there.
 */
import * as THREE from "three";
import type { LitMaterial } from "../materials";

/** Flat minimum brightness on the unlit hemisphere, 0..1. A legibility floor so
 *  the night side is never total blackness — a constant on purpose (see header). */
export const NIGHT_FLOOR = 0.12;

/** Cel steps kept ACROSS the terminator transition (not across the whole disc).
 *  Higher = smoother edge; 1 would be a single hard line. */
const TERM_BANDS = 4;

/** A floor on the half-width so the terminator is never a raw one-pixel step that
 *  aliases as the body rotates — even an airless moon under a point-like star
 *  keeps this much softness. In N·L units (≈ radians of arc near the edge). */
const TERM_BASE = 0.03;

/** How many atmospheric scale heights of daylight wrap are optically visible as
 *  twilight. ~4 H is where scattered light fades below eye threshold. */
const ATMO_VISIBLE_SCALE_HEIGHTS = 4;

/** Hard bounds on the half-width. Below the low end the edge aliases; above the
 *  high end the "terminator" covers most of the hemisphere and stops reading as
 *  a day/night boundary at all. */
const TERM_MIN = 0.02;
const TERM_MAX = 0.6;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface TerminatorInputs {
  /** Radius of the illuminating star (m). */
  starRadiusM: number;
  /** Distance from the body to that star (m) — its orbital radius is a fine
   *  stand-in (circular orbits, and the terminator is insensitive to the small
   *  variation a moon's own orbit adds). */
  starDistanceM: number;
  /** The body's own radius (m). */
  planetRadiusM: number;
  /** The body's atmospheric e-folding scale height (m). Near-zero for airless
   *  bodies, which then get a sharp edge. */
  atmosphereScaleHeightM: number;
}

/** The terminator half-width in N·L units (≈ the angle in radians over which the
 *  edge fades, since N·L ≈ sin(angle-past-terminator) ≈ that angle near N·L = 0).
 *
 *  = base softness + star angular radius + atmospheric twilight wrap, clamped.
 *  See the header for why each term is here. */
export function computeTerminatorWidth(inp: TerminatorInputs): number {
  const starAngular = inp.starDistanceM > 0 ? inp.starRadiusM / inp.starDistanceM : 0;
  const atmo = inp.planetRadiusM > 0 && inp.atmosphereScaleHeightM > 0
    ? Math.sqrt((2 * ATMO_VISIBLE_SCALE_HEIGHTS * inp.atmosphereScaleHeightM) / inp.planetRadiusM)
    : 0;
  return clamp(TERM_BASE + starAngular + atmo, TERM_MIN, TERM_MAX);
}

export interface PlanetTerminatorOpts {
  /** Terminator half-width in N·L units — from `computeTerminatorWidth`. */
  width: number;
  /** Night-side brightness floor, 0..1. Defaults to `NIGHT_FLOOR`. */
  nightFloor?: number;
}

/** GLSL that REPLACES three's `#include <gradientmap_pars_fragment>` — it
 *  redefines `getGradientIrradiance` to ignore the shared cel ramp and shade the
 *  physical terminator instead, reading `uTermWidth` / `uNightFloor`. Shared by
 *  the standalone patch here and the terrain material's own patch
 *  (terrain-shading.ts owns a single onBeforeCompile slot, so it can't call the
 *  standalone patch — it splices this string in itself). */
export const TERMINATOR_GLSL = /* glsl */ `
uniform float uTermWidth;
uniform float uNightFloor;

vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
  float dotNL = dot( normal, lightDirection );
  // Night → full day compressed into ±uTermWidth around the geometric
  // terminator (dotNL = 0), instead of the shared ramp's disc-wide bands.
  float day = smoothstep( -uTermWidth, uTermWidth, dotNL );
  // Keep a few cel steps ONLY across that transition, so the body still reads as
  // toon while the edge itself stays a line rather than a gradient.
  day = floor( day * ${TERM_BANDS}.0 + 0.5 ) / ${TERM_BANDS}.0;
  // Never total blackness on the night side — a flat legibility floor.
  return vec3( mix( uNightFloor, 1.0, day ) );
}
`;

/** Attach the terminator uniforms this material's spliced GLSL reads. Shared so
 *  the standalone patch and the terrain patch set them identically. */
export function setTerminatorUniforms(
  shader: THREE.WebGLProgramParametersWithUniforms, opts: PlanetTerminatorOpts,
): void {
  shader.uniforms.uTermWidth = { value: Math.max(1e-4, opts.width) };
  shader.uniforms.uNightFloor = { value: clamp(opts.nightFloor ?? NIGHT_FLOOR, 0, 1) };
}

/** Give a PLAIN planet-scale toon material (a bare moon, or the interim sphere a
 *  rocky world shows while its terrain bakes) the physical terminator.
 *
 *  Standalone — it owns `onBeforeCompile`, so DON'T call it on a material already
 *  patched by `applyTerrainShading` (that patch splices `TERMINATOR_GLSL` itself;
 *  see its `terminator` option). No-ops on a standard material, whose Lambert
 *  falloff is already a physical edge. */
export function applyToonTerminator(material: LitMaterial, opts: PlanetTerminatorOpts): void {
  if (!(material as THREE.MeshToonMaterial).isMeshToonMaterial) return;
  material.onBeforeCompile = (shader) => {
    setTerminatorUniforms(shader, opts);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <gradientmap_pars_fragment>",
      TERMINATOR_GLSL,
    );
  };
  // The GLSL is identical whatever the width (it's a uniform), so one program
  // serves every terminator material — a constant key lets three share it.
  material.customProgramCacheKey = () => "planet-terminator-toon";
}
