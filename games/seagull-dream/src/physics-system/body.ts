// body.ts — Unified celestial body model.
//
// A Body is four numbers (refractory mass, ice mass, H/He mass, formation
// orbit) plus a parent and an age. From these — and the parent's current
// state — everything else emerges:
//
//   - Whether it fuses hydrogen or deuterium → label "star" or "brown dwarf"
//   - Whether it retained its H/He envelope → label "gas giant" or "rocky"
//   - Whether it's close to its parent + young → label "hot Jupiter"
//   - All visual / observational properties
//
// The categorical labels never enter the generator. They exist purely for
// post-hoc UI description (bodyLabel for player-facing text).
//
// Evolution is LAZY: Body stores only formation state. bodyState(b, t,
// parentState) re-evolves on each query. This makes a time-toggle for free
// — call bodyState with a different t to see what the body looked like
// (or will look like) at a different age.

import * as THREE from "three";
import {
  msRadius,
  resolveStellarState,
  colorFromTeff,
  StellarState,
} from "../stellar";

// ── Constants ───────────────────────────────────────────────────────────

export const M_EARTH_PER_M_SUN = 1 / 333000;
export const M_EARTH_PER_M_JUP = 1 / 318;
export const R_SUN_IN_R_EARTH = 109;

/** Mass fraction of metals (everything heavier than He) in solar material.
 *  Solar [Fe/H] = 0 → Z ≈ 0.014. Other metallicities scale as 10^feh. */
export const Z_SOLAR = 0.014;

/** Hydrogen burning floor. Below this, no sustained H fusion; body cools. */
export const M_HYDROGEN_FUSION_SUN = 0.075;
/** Deuterium burning floor. Between this and M_HYDROGEN_FUSION → "brown dwarf"
 *  in conventional labeling. Brief D fusion, then cooling. */
export const M_DEUTERIUM_FUSION_SUN = 0.013;

/** Densities used to compute core radius. Refractory ≈ Earth's bulk density;
 *  ice ≈ water-rich. These are crude — real bodies have radial structure. */
const DENSITY_REFRACTORY = 5.51; // g/cm³
const DENSITY_ICE = 1.5;

// ── Types ───────────────────────────────────────────────────────────────

/** Formation-time parameters. Constants for a body's lifetime. */
export interface Body {
  id: string;

  // Composition at formation, in M_earth.
  formationRefractory: number;
  formationIce: number;
  formationHHe: number;

  // Orbit at formation (around parent body or galactic center).
  formationSemiMajor: number;     // AU. 0 for system primaries.
  formationEccentricity: number;
  formationInclination: number;   // radians

  /** ID of the body this orbits. null = top of hierarchy (orbits galactic
   *  center; for system primaries). */
  parentId: string | null;

  /** Initial rotation period at formation (hours). Tidal evolution may
   *  modify the effective current rotation, but the formation value is
   *  the natural seed. */
  formationRotationHours: number;
  /** Initial axial tilt at formation (radians). Most bodies form near 0;
   *  giant impacts produce the long tail. */
  formationAxialTilt: number;

  /** Birth time, as Gyr since the galaxy formed. The body's "age now" is
   *  always (galaxy age now − birthTime). All sibling bodies in a system
   *  formed together so they share this. */
  birthTimeGyr: number;

  /** Local metallicity at formation ([Fe/H], dex). Sets H/He vs metals
   *  split for the formation cloud, and the disk's solid inventory. */
  feh: number;

  /** Multiplier on bulk refractory density. Default 1.0; values > 1 model
   *  iron-rich anomalies where mantle stripping (or differential accretion
   *  near the host) has produced a body with an oversized iron core
   *  relative to its silicate mantle. Mercury is the canonical case at
   *  ~1.7 (density 5.43 g/cm³ at ~0.055 M_earth, vs ~3.5 expected). Earth-
   *  like bodies sit at 1.0. */
  refractoryDensityFactor: number;
}

export type FusionMode = "hydrogen" | "deuterium_done" | "none" | "remnant";

/** Derived current state. Recomputed on each bodyState() call. */
export interface BodyState {
  ageGyr: number;                 // age at the query time
  currentHHe: number;             // M_earth; envelope mass after evolution
  totalMass: number;              // M_earth; refractory + ice + currentHHe
  fusionMode: FusionMode;
  /** Phase, meaningful for fusing bodies. Non-fusing bodies are just "stable". */
  phase: StellarState["phase"] | "stable" | "stripped" | "disrupted";
  radius: number;                 // R_earth
  surfaceTemp: number;            // K
  luminosity: number;             // L_sun (≈0 for non-fusing bodies)
  color: THREE.Color;
  /** Convenience label for UI — emerges from physical parameters; never an
   *  input to generation. Do not use in code logic. */
  label: BodyLabel;
}

export type BodyLabel =
  | "star"
  | "brown_dwarf"
  | "gas_giant"
  | "hot_gas_giant"
  | "ice_giant"
  | "mini_neptune"
  | "super_earth"
  | "ocean_world"
  | "rocky"
  | "ice_dwarf"
  | "stripped_core"
  | "remnant_white_dwarf"
  | "remnant_neutron_star"
  | "remnant_black_hole";

// ── Envelope evolution ──────────────────────────────────────────────────
//
// Hydrogen/helium envelopes are lost to photoevaporation, driven by XUV
// flux from the parent star. The dominant loss is energy-limited:
// dM/dt ∝ F_XUV × R² / (G M / R).
//
// We approximate the integrated mass loss with a single timescale
// τ_strip(M, a, L) and treat the loss as exponential. τ scales as M² (high
// binding energy holds envelopes tight) and a² (flux dilutes with
// distance²), and inversely with L (XUV scales with stellar bolometric).
// The numerical prefactor is calibrated so Jupiter-mass bodies at 0.05 AU
// retain their envelopes for >>Hubble time while 5-M_earth bodies at the
// same orbit strip in <1 Gyr — matching the observed radius valley.

const STRIP_TIMESCALE_PREFACTOR_GYR = 0.1;
const STRIP_MASS_REF_EARTH = 5;
const STRIP_SEMI_REF_AU = 0.05;

export function envelopeStrippingTimescaleGyr(
  totalMassEarth: number,
  semiMajorAU: number,
  parentLuminositySun: number,
): number {
  // No parent radiation = no photoevaporation. Use a very long timescale.
  if (parentLuminositySun <= 0) return Infinity;
  return (
    STRIP_TIMESCALE_PREFACTOR_GYR
    * Math.pow(totalMassEarth / STRIP_MASS_REF_EARTH, 2)
    * Math.pow(semiMajorAU / STRIP_SEMI_REF_AU, 2)
    / parentLuminositySun
  );
}

/** Current H/He mass after `ageGyr` of evolution at `semiMajorAU` around a
 *  parent of `parentLuminositySun`. */
export function evolveEnvelope(
  formationHHe: number,
  totalMassEarthAtFormation: number,
  semiMajorAU: number,
  parentLuminositySun: number,
  ageGyr: number,
): number {
  if (formationHHe < 1e-6) return 0;
  const tau = envelopeStrippingTimescaleGyr(
    totalMassEarthAtFormation,
    semiMajorAU,
    parentLuminositySun,
  );
  if (!isFinite(tau)) return formationHHe;
  // Exponential decay. Approximation — real loss couples to changing R
  // and M as envelope leaves, but for snapshot purposes this captures the
  // "retained vs stripped" outcome correctly.
  const remaining = formationHHe * Math.exp(-ageGyr / tau);
  return remaining < 1e-6 ? 0 : remaining;
}

// ── Radius ──────────────────────────────────────────────────────────────
//
// One function across the full mass range. Three regimes blend smoothly:
//
//   1. Bare cores (negligible H/He): R from refractory + ice volumes.
//      Earth-like density mix, ~M^(1/3) with mild compression.
//   2. With H/He envelope: R adds an envelope contribution that saturates
//      toward Jupiter radius as envelope mass grows. Around Jupiter and
//      throughout the brown dwarf range, R sits at ~11 R_earth — the
//      degeneracy plateau.
//   3. Above hydrogen fusion threshold: stellar M-R relation takes over.
//      The non-fusing curve already meets this near 0.075 M_sun (the
//      lowest-mass stars are still about Jupiter-sized), so the transition
//      is continuous.

function coreRadiusEarth(mRef: number, mIce: number, densityFactor: number = 1.0): number {
  // Volume in "Earth volume units" — 1 = volume of 1 M_earth of standard
  // refractory at density 5.51 g/cm³. Iron-rich bodies use densityFactor > 1,
  // shrinking their refractory volume contribution.
  const volRef = mRef / densityFactor;
  const volIce = mIce * (DENSITY_REFRACTORY / DENSITY_ICE);
  const totalVol = volRef + volIce;
  if (totalVol <= 0) return 0;
  // Slightly steeper than 1/3 power — compression at high mass increases
  // density. R ∝ M^0.27 is the standard fit up through super-Earth range.
  return Math.pow(totalVol, 0.27);
}

export function bodyRadiusEarth(
  mRef: number,
  mIce: number,
  mHHe: number,
  surfaceTempK: number,
  fusionMode: FusionMode,
  densityFactor: number = 1.0,
): number {
  const totalE = mRef + mIce + mHHe;
  const totalSun = totalE * M_EARTH_PER_M_SUN;

  // Fusing body: use stellar M-R relation. Hot bodies (subgiant, RGB,
  // supergiant) handled by caller via resolveStellarState — this branch
  // is just for the ZAMS-like instantaneous M-R.
  if (fusionMode === "hydrogen") {
    return msRadius(totalSun) * R_SUN_IN_R_EARTH;
  }

  // Non-fusing: core + envelope contribution.
  const rCore = coreRadiusEarth(mRef, mIce, densityFactor);

  // Negligible envelope: just the core.
  if (mHHe < 0.005 * (mRef + mIce + 0.01)) {
    return Math.max(rCore, 0.05);
  }

  // Envelope contribution. Saturating function: tiny for small envelopes,
  // approaches ~9 R_earth for Jupiter-class. The 30 M_earth scale matches
  // the transition mass between "thin envelope on rocky core" and "gas
  // giant" — below this you get sub-Neptune radii, above you saturate.
  const R_ENV_MAX = 9.0;
  const HHE_SCALE = 30;
  const rEnv = R_ENV_MAX * Math.sqrt(mHHe / (mHHe + HHE_SCALE));

  // Thermal inflation. Hot envelopes are puffier (atmospheric scale height
  // ∝ T). Mild effect for cool gas giants, several percent for hot Jupiters.
  const inflation = 1 + 0.1 * Math.log10(Math.max(50, surfaceTempK) / 200);

  let R = (rCore + rEnv) * inflation;

  // Cap at Jupiter for non-fusing bodies (gas-giant + brown dwarf plateau).
  // Above the H-fusion threshold the stellar M-R takes over and gets a
  // chance to come back up.
  if (totalSun > 0.005) {
    R = Math.min(R, 11.5 * inflation);
  }

  return R;
}

// ── Surface temperature ─────────────────────────────────────────────────
//
// For non-fusing bodies: combine equilibrium temperature from parent
// radiation with internal heat (gravitational contraction + radiogenic
// heating, both decaying with age). Combined via T_surf^4 = T_eq^4 + T_int^4.
//
// For fusing bodies: surface temperature is fully set by L and R via
// Stefan-Boltzmann (in resolveStellarState).

const T_INTERNAL_PREFACTOR_K = 250;

/** Internal temperature contribution at given age, parameterized by total
 *  mass (more massive bodies form hotter and cool slower). */
function internalTempK(totalMassEarth: number, ageGyr: number): number {
  if (totalMassEarth < 0.01) return 0;
  // Formation temperature scales mildly with mass; cooling τ^(-0.4).
  const T0 = T_INTERNAL_PREFACTOR_K * Math.pow(totalMassEarth, 0.2);
  const tEff = Math.max(0.001, ageGyr);
  return T0 * Math.pow(tEff / 0.1, -0.4);
}

export function bodySurfaceTempK(
  semiMajorAU: number,
  parentLuminositySun: number,
  albedo: number,
  totalMassEarth: number,
  ageGyr: number,
): number {
  // Equilibrium from parent radiation.
  const tEq =
    parentLuminositySun > 0 && semiMajorAU > 0
      ? 278 * Math.pow(parentLuminositySun, 0.25) / Math.sqrt(semiMajorAU) * Math.pow(1 - albedo, 0.25)
      : 0;
  const tInt = internalTempK(totalMassEarth, ageGyr);
  return Math.pow(tEq * tEq * tEq * tEq + tInt * tInt * tInt * tInt, 0.25);
}

// ── Color ───────────────────────────────────────────────────────────────
//
// Hot bodies (>1500 K surface) emit as quasi-blackbodies — use stellar
// color. Cold bodies appear by reflection; the color is the parent star's
// light filtered through the body's composition + clouds.
//
// We approximate the cold-body case with composition-keyed presets:
// gas/ice giants get banded warm tones (Jovian palette), icy bodies are
// bluish white, rocky bodies range gray-to-rust. This is rendering-ish; a
// more careful treatment would compute reflected light from parent color
// × albedo spectrum.

function colorForColdBody(
  mRef: number,
  mIce: number,
  mHHe: number,
): THREE.Color {
  const total = mRef + mIce + mHHe + 1e-9;
  const fHHe = mHHe / total;
  const fIce = mIce / total;
  if (fHHe > 0.3) {
    // Gas-dominated — pale tan/cream (Jovian-like).
    return new THREE.Color(0.92, 0.84, 0.72);
  }
  if (fIce > 0.5) {
    // Ice-dominated — bluish white.
    return new THREE.Color(0.78, 0.88, 0.95);
  }
  if (fIce > 0.2) {
    // Mixed icy-rocky — gray-blue.
    return new THREE.Color(0.6, 0.65, 0.7);
  }
  // Rocky-dominated — varies from gray to rust.
  return new THREE.Color(0.55, 0.48, 0.42);
}

// ── bodyState — the main lazy evaluator ─────────────────────────────────

export interface ParentContext {
  /** Parent's current luminosity (L_sun), for XUV stripping and equilibrium T. */
  luminosity: number;
  /** Parent's current mass (M_sun) — used by Hill stability checks elsewhere. */
  mass: number;
}

/** No parent (top of hierarchy — system primary orbits galactic center). */
export const NO_PARENT: ParentContext = { luminosity: 0, mass: 1 };

/**
 * Resolve a body's current state at a given galaxy time. Lazy: nothing is
 * stored on the Body; everything is recomputed.
 *
 * `galaxyTimeGyr` is the absolute time (Gyr since galaxy birth). The body's
 * age is derived as galaxyTimeGyr − body.birthTimeGyr.
 *
 * `parent` is the resolved state context of the body the body orbits.
 * For system primaries, pass NO_PARENT.
 */
export function bodyState(
  b: Body,
  galaxyTimeGyr: number,
  parent: ParentContext = NO_PARENT,
): BodyState {
  const ageGyr = Math.max(0, galaxyTimeGyr - b.birthTimeGyr);

  // Step 1: envelope evolution.
  const totalFormation = b.formationRefractory + b.formationIce + b.formationHHe;
  const currentHHe = evolveEnvelope(
    b.formationHHe,
    totalFormation,
    b.formationSemiMajor,
    parent.luminosity,
    ageGyr,
  );
  const totalMass = b.formationRefractory + b.formationIce + currentHHe;
  const totalMassSun = totalMass * M_EARTH_PER_M_SUN;

  // Step 2: fusion mode + phase. For massive bodies, defer to stellar
  // physics via resolveStellarState — that gives us the full evolutionary
  // phase (MS, RGB, remnant, etc.) at no extra cost.
  let fusionMode: FusionMode;
  let phase: BodyState["phase"];
  let luminosity: number;
  let radius: number;
  let surfaceTemp: number;
  let color: THREE.Color;

  if (totalMassSun >= M_HYDROGEN_FUSION_SUN) {
    // Hydrogen fusion: full stellar evolution.
    const ss = resolveStellarState(totalMassSun, ageGyr, b.feh);
    if (ss.phase === "white_dwarf" || ss.phase === "neutron_star" || ss.phase === "black_hole") {
      fusionMode = "remnant";
    } else {
      fusionMode = "hydrogen";
    }
    phase = ss.phase;
    luminosity = ss.luminosity;
    radius = ss.radius * R_SUN_IN_R_EARTH;
    surfaceTemp = ss.teff;
    color = ss.color;
  } else if (totalMassSun >= M_DEUTERIUM_FUSION_SUN) {
    // Brown dwarf range — brief D fusion then cooling.
    fusionMode = "deuterium_done";
    phase = "stable";
    surfaceTemp = bodySurfaceTempK(
      b.formationSemiMajor,
      parent.luminosity,
      0.3,
      totalMass,
      ageGyr,
    );
    // Add a small intrinsic from residual heat + D burning history.
    const tInternalContribution = 800 * Math.pow(Math.max(0.001, ageGyr / 0.1), -0.3);
    surfaceTemp = Math.max(surfaceTemp, tInternalContribution);
    radius = bodyRadiusEarth(
      b.formationRefractory, b.formationIce, currentHHe,
      surfaceTemp, fusionMode, b.refractoryDensityFactor,
    );
    luminosity = (radius / R_SUN_IN_R_EARTH) ** 2 * Math.pow(surfaceTemp / 5778, 4);
    color = colorFromTeff(surfaceTemp);
  } else {
    // Sub-stellar: planet, dwarf planet, stripped core, etc.
    fusionMode = "none";
    if (currentHHe < 0.005 * (b.formationRefractory + b.formationIce + 0.01)
        && b.formationHHe > 0.01) {
      phase = "stripped";
    } else {
      phase = "stable";
    }
    // Albedo: gas-rich bodies higher, rocky lower.
    const fHHe = currentHHe / Math.max(1e-9, totalMass);
    const albedo = fHHe > 0.3 ? 0.5 : (b.formationIce > b.formationRefractory ? 0.4 : 0.3);
    surfaceTemp = bodySurfaceTempK(
      b.formationSemiMajor,
      parent.luminosity,
      albedo,
      totalMass,
      ageGyr,
    );
    radius = bodyRadiusEarth(
      b.formationRefractory, b.formationIce, currentHHe,
      surfaceTemp, fusionMode, b.refractoryDensityFactor,
    );
    // Cold bodies: appear by reflection — composition-keyed color. Hot
    // bodies (>1500 K, like hot Jupiters or very-near-star rocky worlds):
    // blackbody emission starts to matter.
    if (surfaceTemp > 1500) {
      color = colorFromTeff(surfaceTemp);
    } else {
      color = colorForColdBody(b.formationRefractory, b.formationIce, currentHHe);
    }
    luminosity = (radius / R_SUN_IN_R_EARTH) ** 2
      * Math.pow(surfaceTemp / 5778, 4);
  }

  return {
    ageGyr,
    currentHHe,
    totalMass,
    fusionMode,
    phase,
    radius,
    surfaceTemp,
    luminosity,
    color,
    label: bodyLabel(b, currentHHe, totalMass, fusionMode, phase, surfaceTemp),
  };
}

// ── Labeling ────────────────────────────────────────────────────────────
//
// Pure post-hoc descriptor — DO NOT USE in generation logic. Maps the
// physical state of a body to a human-readable category for UI display.
// Adding new labels here is fine; the generator doesn't care.

export function bodyLabel(
  b: Body,
  currentHHe: number,
  totalMass: number,
  fusionMode: FusionMode,
  phase: BodyState["phase"],
  surfaceTemp: number,
): BodyLabel {
  if (phase === "white_dwarf") return "remnant_white_dwarf";
  if (phase === "neutron_star") return "remnant_neutron_star";
  if (phase === "black_hole") return "remnant_black_hole";
  if (fusionMode === "hydrogen") return "star";
  if (fusionMode === "deuterium_done") return "brown_dwarf";

  const totalSun = totalMass * M_EARTH_PER_M_SUN;
  const fHHe = currentHHe / Math.max(1e-9, totalMass);

  // Gas-dominated
  if (fHHe > 0.5 && totalSun < M_DEUTERIUM_FUSION_SUN) {
    return surfaceTemp > 1000 ? "hot_gas_giant" : "gas_giant";
  }
  // Significant H/He but not dominated
  if (fHHe > 0.05) {
    if (b.formationIce > b.formationRefractory) return "ice_giant";
    return "mini_neptune";
  }
  // Stripped (used to have envelope, lost it)
  if (b.formationHHe > 0.05 * (b.formationRefractory + b.formationIce) && fHHe < 0.005) {
    return "stripped_core";
  }
  // No significant envelope ever
  if (totalMass < 0.1) return "ice_dwarf";
  if (b.formationIce > 2 * b.formationRefractory) return "ocean_world";
  if (totalMass > 2) return "super_earth";
  return "rocky";
}

// ── Composition utilities ───────────────────────────────────────────────

/** Convert a primary "star" StarRecord (mass M_sun, age, [Fe/H]) into a Body.
 *  Stars are dominantly H/He with traces of heavier elements set by [Fe/H].
 *  This is how a Kroupa-sampled stellar mass enters the unified model. */
export function starToBody(
  id: string,
  massSun: number,
  ageGyr: number,
  feh: number,
  birthTimeGyr: number,
): Body {
  const totalE = massSun / M_EARTH_PER_M_SUN;
  // Metal fraction: solar value scaled by 10^feh. Split between refractory
  // and ice somewhat arbitrarily — for stars it makes essentially no
  // difference (they're 98%+ H/He).
  const Z = Math.min(0.05, Z_SOLAR * Math.pow(10, feh));
  const refFrac = Z * 0.4;
  const iceFrac = Z * 0.6;
  const hheFrac = 1 - Z;
  return {
    id,
    formationRefractory: totalE * refFrac,
    formationIce: totalE * iceFrac,
    formationHHe: totalE * hheFrac,
    formationSemiMajor: 0,
    formationEccentricity: 0,
    formationInclination: 0,
    parentId: null,
    // Sun-like default: ~25 days rotation, ~7° tilt. Real stars vary; this
    // can be replaced with sampled values by the caller if needed.
    formationRotationHours: 24 * 25,
    formationAxialTilt: 7 * Math.PI / 180,
    birthTimeGyr,
    feh,
    refractoryDensityFactor: 1.0,
  };
}

// ── Disruption check ────────────────────────────────────────────────────
//
// A body whose Roche radius exceeds its orbital semi-major axis at the
// parent is tidally disrupted. Used during materialization to drop bodies
// that wouldn't survive — these don't appear in the final system.

export function isTidallyDisrupted(
  b: Body,
  parentMassSun: number,
): boolean {
  // Mean density of body at formation (g/cm³).
  const totalE = b.formationRefractory + b.formationIce + b.formationHHe;
  if (totalE <= 0) return true;
  // Roche limit for fluid body: d ≈ 2.44 × R_parent × (ρ_parent / ρ_body)^(1/3).
  // We don't have R_parent at formation — use an approximation: any body
  // forming inside ~0.005 AU around a solar-mass star is likely disrupted.
  // Better implementation pulls the parent's current radius.
  const minSafeAU = 0.005 * Math.pow(parentMassSun, 1 / 3);
  return b.formationSemiMajor < minSafeAU;
}