// stellar.ts — Pure physical functions for stellar properties.
//
// Maps (massInit, age, [Fe/H]) → observable current state. No project
// dependencies; suitable for use both at galaxy expansion time (per-star
// color and intrinsic brightness) and at system materialization time
// (companion stellar states, snow line / HZ inputs).
//
// All functions are pure; no shared state. The IMF segment table is the
// only thing built at module load.

import * as THREE from "three";

// ── Phase + state ──────────────────────────────────────────────────────

export type StellarPhase =
  | "main_sequence"
  | "subgiant"
  | "red_giant"
  | "horizontal_branch"
  | "agb"
  | "supergiant"
  | "white_dwarf"
  | "neutron_star"
  | "black_hole";

export interface StellarState {
  phase: StellarPhase;
  /** Current luminosity, in L_sun. Spans ~10 orders of magnitude across
   *  the IMF; downstream rendering must compress. */
  luminosity: number;
  /** Current radius, in R_sun. */
  radius: number;
  /** Effective surface temperature, in Kelvin. 0 for black holes. */
  teff: number;
  /** Current mass after any mass loss (relevant for remnants). */
  currentMass: number;
  /** Display color derived from teff. Black for black holes. */
  color: THREE.Color;
}

// ── IMF (Kroupa 2001) ──────────────────────────────────────────────────
//
// Broken power-law dN/dM ∝ M^(-α) with α=1.3 below 0.5 M_sun and α=2.3
// above. Brown dwarfs (<0.08 M_sun) excluded — they don't visually behave
// as stars and would clog the registry. The CDF is closed-form on each
// segment, so we precompute the segment boundaries and invert.

const IMF_BREAKS = [0.08, 0.5, 120];
const IMF_ALPHAS = [1.3, 2.3];

interface IMFSegment {
  mLow: number;
  mHigh: number;
  alpha: number;
  cdfLow: number;   // normalized cumulative at mLow
  cdfHigh: number;  // normalized cumulative at mHigh
}

const IMF_SEGMENTS: IMFSegment[] = (() => {
  // Compute raw segment integrals (no normalization yet).
  const raws: { mLow: number; mHigh: number; alpha: number; raw: number }[] = [];
  let total = 0;
  for (let i = 0; i < IMF_ALPHAS.length; i++) {
    const mLow = IMF_BREAKS[i];
    const mHigh = IMF_BREAKS[i + 1];
    const alpha = IMF_ALPHAS[i];
    const oneMinusAlpha = 1 - alpha;
    const raw =
      Math.abs(oneMinusAlpha) < 1e-9
        ? Math.log(mHigh / mLow)
        : (Math.pow(mHigh, oneMinusAlpha) - Math.pow(mLow, oneMinusAlpha)) / oneMinusAlpha;
    raws.push({ mLow, mHigh, alpha, raw });
    total += raw;
  }
  // Build segments with normalized CDFs.
  const segs: IMFSegment[] = [];
  let acc = 0;
  for (const r of raws) {
    const cdfLow = acc / total;
    acc += r.raw;
    const cdfHigh = acc / total;
    segs.push({ mLow: r.mLow, mHigh: r.mHigh, alpha: r.alpha, cdfLow, cdfHigh });
  }
  return segs;
})();

/** Draw a stellar mass (M_sun) from the Kroupa IMF. */
export function sampleIMFMass(rng: () => number): number {
  const u = rng();
  let seg = IMF_SEGMENTS[0];
  for (const s of IMF_SEGMENTS) {
    if (u <= s.cdfHigh) {
      seg = s;
      break;
    }
  }
  // Fraction of the way through this segment in CDF space.
  const f = (u - seg.cdfLow) / (seg.cdfHigh - seg.cdfLow);
  const oneMinusAlpha = 1 - seg.alpha;
  // Within-segment inverse: integral from mLow to m of M^(-alpha) dM, set
  // equal to f × full-segment integral, solve for m.
  const mLowOMA = Math.pow(seg.mLow, oneMinusAlpha);
  const mHighOMA = Math.pow(seg.mHigh, oneMinusAlpha);
  const target = mLowOMA + f * (mHighOMA - mLowOMA);
  return Math.pow(target, 1 / oneMinusAlpha);
}

// ── Main sequence lifetime ─────────────────────────────────────────────
//
// Piecewise approximation. τ ≈ 10 Gyr × M^(-2.5) is the textbook form;
// I split at the upper end because the L-M slope changes for very massive
// stars and τ ∝ M / L flattens.

export function mainSequenceLifetimeGyr(massInit: number, feh: number = 0): number {
  let tau: number;
  if (massInit <= 1.5) {
    tau = 10 * Math.pow(massInit, -2.5);
  } else if (massInit <= 10) {
    tau = 10 * Math.pow(massInit, -3.0);
  } else {
    // Very massive stars: a few Myr regardless of finer slope.
    tau = 0.008 * Math.pow(massInit / 30, -1);
  }
  // Mild metallicity dependence: metal-rich stars live ~10% longer per dex
  // (more opacity → slightly slower fusion).
  return tau * Math.pow(10, 0.1 * feh);
}

// ── L, R on the main sequence ──────────────────────────────────────────

export function msLuminosity(massInit: number): number {
  if (massInit <= 0.43) return 0.23 * Math.pow(massInit, 2.3);
  if (massInit <= 2) return Math.pow(massInit, 4);
  if (massInit <= 20) return 1.4 * Math.pow(massInit, 3.5);
  // Above 20 M_sun radiation pressure dominates and L scales linearly.
  return 32000 * massInit;
}

export function msRadius(massInit: number): number {
  if (massInit <= 1) return Math.pow(massInit, 0.8);
  return Math.pow(massInit, 0.57);
}

const T_SUN = 5778;

/** Effective temperature from L and R (Stefan-Boltzmann), both in solar units. */
export function teffFromLR(lumSun: number, radSun: number): number {
  return T_SUN * Math.pow(lumSun, 0.25) / Math.pow(radSun, 0.5);
}

// ── Phase resolution ───────────────────────────────────────────────────

export function resolvePhase(massInit: number, age: number, feh: number = 0): StellarPhase {
  const tauMS = mainSequenceLifetimeGyr(massInit, feh);
  const f = age / tauMS;
  if (f < 0.99) return "main_sequence";
  if (f < 1.00) return "subgiant";
  if (f < 1.05) return massInit < 8 ? "red_giant" : "supergiant";
  if (f < 1.08) return massInit < 8 ? "horizontal_branch" : "supergiant";
  if (f < 1.10) return massInit < 8 ? "agb" : "supergiant";
  if (massInit < 8) return "white_dwarf";
  if (massInit < 25) return "neutron_star";
  return "black_hole";
}

// ── Remnant masses ─────────────────────────────────────────────────────

export function whiteDwarfMass(massInit: number): number {
  // Initial-final mass relation (Kalirai+ 2008, simplified linear fit).
  return Math.min(1.35, 0.084 * massInit + 0.444);
}

export function neutronStarMass(massInit: number): number {
  return Math.min(2.2, 1.2 + (massInit - 8) * 0.04);
}

export function blackHoleMass(massInit: number): number {
  // Rough: BH retains 30-70% of progenitor depending on mass loss.
  if (massInit < 40) return 5 + (massInit - 25) * 0.5;
  return Math.min(60, 12 + (massInit - 40) * 0.8);
}

// ── Resolve full current state ─────────────────────────────────────────
//
// One entry point: given (M_init, age, [Fe/H]), return phase + observables.
// Post-MS phases use rough but visually distinguishable values; if you
// want detailed evolutionary tracks later, swap in a MIST/PARSEC lookup
// without touching call sites.

export function resolveStellarState(
  massInit: number,
  age: number,
  feh: number = 0,
): StellarState {
  const phase = resolvePhase(massInit, age, feh);
  const tauMS = mainSequenceLifetimeGyr(massInit, feh);

  let luminosity: number;
  let radius: number;
  let teff: number;
  let currentMass = massInit;

  switch (phase) {
    case "main_sequence": {
      // ZAMS values, with a modest brightening as the star approaches TAMS.
      const L0 = msLuminosity(massInit);
      const R0 = msRadius(massInit);
      const fAge = age / tauMS;
      luminosity = L0 * (1 + 0.5 * fAge);
      radius = R0 * (1 + 0.2 * fAge);
      teff = teffFromLR(luminosity, radius);
      break;
    }
    case "subgiant": {
      luminosity = msLuminosity(massInit) * 2.5;
      radius = msRadius(massInit) * 3;
      teff = teffFromLR(luminosity, radius);
      break;
    }
    case "red_giant": {
      luminosity = msLuminosity(massInit) * 150;
      radius = 30;
      teff = teffFromLR(luminosity, radius);
      break;
    }
    case "horizontal_branch": {
      luminosity = msLuminosity(massInit) * 50;
      radius = 10;
      teff = teffFromLR(luminosity, radius);
      break;
    }
    case "agb": {
      luminosity = msLuminosity(massInit) * 3000;
      radius = 200;
      teff = teffFromLR(luminosity, radius);
      break;
    }
    case "supergiant": {
      luminosity = msLuminosity(massInit) * 100;
      radius = 500;
      teff = teffFromLR(luminosity, radius);
      break;
    }
    case "white_dwarf": {
      // Cooling. T_eff ∝ t^(-0.4) is a rough fit to Mestel cooling.
      currentMass = whiteDwarfMass(massInit);
      const coolGyr = Math.max(0.001, age - tauMS);
      teff = Math.max(3000, 100000 * Math.pow(coolGyr / 0.01, -0.4));
      radius = 0.013;
      luminosity = radius * radius * Math.pow(teff / T_SUN, 4);
      break;
    }
    case "neutron_star": {
      currentMass = neutronStarMass(massInit);
      radius = 1.45e-5; // ~10 km
      teff = Math.max(10000, 600000 * Math.exp(-(age - tauMS) / 1.0));
      luminosity = radius * radius * Math.pow(teff / T_SUN, 4);
      break;
    }
    case "black_hole": {
      currentMass = blackHoleMass(massInit);
      radius = 0;
      teff = 0;
      luminosity = 0;
      break;
    }
  }

  const color = colorFromTeff(teff);
  return { phase, luminosity, radius, teff, currentMass, color };
}

// ── Color from T_eff ───────────────────────────────────────────────────
//
// Tanner Helland's blackbody → RGB approximation. Cheap, no LUT, gives
// reasonable star colors across the relevant range. Black for invisible
// remnants (T_eff = 0). For T well above 40000 K we clamp; only relevant
// for the hottest WDs immediately post-formation.

export function colorFromTeff(teff: number, out?: THREE.Color): THREE.Color {
  const color = out ?? new THREE.Color();
  if (teff <= 0) {
    color.setRGB(0, 0, 0);
    return color;
  }
  const T = Math.max(1000, Math.min(40000, teff)) / 100;
  let r: number, g: number, b: number;

  if (T <= 66) r = 255;
  else r = 329.698727446 * Math.pow(T - 60, -0.1332047592);

  if (T <= 66) g = 99.4708025861 * Math.log(T) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(T - 60, -0.0755148492);

  if (T >= 66) b = 255;
  else if (T <= 19) b = 0;
  else b = 138.5177312231 * Math.log(T - 10) - 305.0447927307;

  color.setRGB(
    Math.max(0, Math.min(255, r)) / 255,
    Math.max(0, Math.min(255, g)) / 255,
    Math.max(0, Math.min(255, b)) / 255,
  );
  return color;
}

// ── Display brightness ─────────────────────────────────────────────────
//
// Stellar luminosity spans ~10 orders of magnitude across the IMF (M
// dwarfs ~1e-4 L_sun, O stars ~1e6 L_sun). The existing apparentAt() in
// universe.ts expects intrinsic values in roughly [0.05, 5]; storing raw
// L would blow that out. This function compresses log-scale luminosity
// into a band that plays nicely with the existing rendering pipeline.
//
// Calibration: M dwarf (L=1e-3) → ~0.1, Sun (L=1) → ~0.4, A star (L=10)
// → ~1.0, B star (L=10^4) → ~2.8, O star (L=10^6) → ~4.0. Followed by
// apparentToK's ^0.7 power, this gives bright stars about 14× the
// per-pixel intensity of M dwarfs at equal distance — visible
// differentiation without bloom blow-out.

export function intrinsicFromLuminosity(luminosity: number): number {
  if (luminosity <= 1e-9) return 0.01; // invisible remnants — small floor
  const log = Math.log10(luminosity);
  return Math.max(0.05, Math.min(6, 0.6 * log + 0.4 + 0.4));
}

// ── Spectral class label (UI only) ─────────────────────────────────────
// Not used in generation; provided for display.

export type SpectralClass = "O" | "B" | "A" | "F" | "G" | "K" | "M";

export function spectralClassFromTeff(teff: number): SpectralClass {
  if (teff >= 30000) return "O";
  if (teff >= 10000) return "B";
  if (teff >= 7500) return "A";
  if (teff >= 6000) return "F";
  if (teff >= 5200) return "G";
  if (teff >= 3700) return "K";
  return "M";
}