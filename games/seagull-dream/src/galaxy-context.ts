// galaxyContext.ts — Procedural galaxy-level parameter sampling and the
// non-spatial fields the per-star generator queries.
//
// The density field (in galaxy.ts) already does the spatial work — where
// stars currently are. This module adds:
//   1. sampleGalaxyParams: pick a random galaxy type + draw parameters
//      consistent with that type's observed properties.
//   2. sfrAt / sampleAgeAt: temporal SFR field; lets us sample a star's
//      birth time from the local mix of (bulge / disc / arm / clump)
//      contributions.
//   3. meanMetallicityAt / sampleMetallicityAt: chemical field for [Fe/H].
//
// Each call site in expandLeafCell queries the latter two for every star
// it places, so they must be cheap. The SFR sampler builds a small
// per-call CDF grid; with SFR_GRID_POINTS = 32 it's a few hundred ops per
// star, which is fine for the per-cell expansion budget.

import * as THREE from "three";
import { mulberry32 } from "./galaxy";
import type { GalaxyParams } from "./galaxy";

// ── sampleGalaxyParams ─────────────────────────────────────────────────
//
// Picks galaxy type (spiral 60%, elliptical 25%, irregular 15% — rough
// cosmic field mix biased toward visually distinctive examples), then
// draws type-appropriate parameter ranges. Returned object is a complete
// GalaxyParams ready to hand to generateUniverse().

export function sampleGalaxyParams(seed: number): GalaxyParams {
  const rng = mulberry32(seed);
  const typeRoll = rng();
  if (typeRoll < 0.60) return sampleSpiral(rng);
  if (typeRoll < 0.85) return sampleElliptical(rng);
  return sampleIrregular(rng);
}

function sampleSpiral(rng: () => number): GalaxyParams {
  // Galaxy age: spirals are typically old (most disc stars are billions of
  // years old) but actively forming. 7-13 Gyr covers MW-analogs and
  // somewhat younger discs.
  const galaxyAgeGyr = 7 + rng() * 6;
  return {
    radius: 30000 + rng() * 50000,
    arms: 2 + Math.floor(rng() * 4),       // 2-5 arms
    spin: 0.0005 + rng() * 0.0008,
    armSharpness: 2 + rng() * 4,
    armStrength: 1.0 + rng() * 1.5,
    discScaleR: 10000 + rng() * 10000,
    discScaleZ: 150 + rng() * 200,
    discDensity: 0.03 + rng() * 0.04,
    bulgeScale: 2000 + rng() * 3000,
    bulgeDensity: 0.1 + rng() * 0.3,

    type: "spiral",
    galaxyAgeGyr,

    sfrPeakGyr: 2 + rng() * 3,
    sfrTauInner: 1.5 + rng() * 1.5,
    sfrTauOuter: 4 + rng() * 4,
    bulgeBurstWidthGyr: 0.8 + rng() * 1.0,
    armYouthBoost: 0.6 + rng() * 0.3,

    fehCentral: 0.2 + rng() * 0.3,
    // Radial gradient: ~-0.07 dex/kpc in MW. Converted to dex/ly:
    // 0.07 / 3262 ly/kpc ≈ 2.1e-5 dex/ly. Spread covers MW to flatter discs.
    fehGradient: -1.5e-5 - rng() * 1.5e-5,
    fehVerticalGradient: -8e-4 - rng() * 4e-4,
    fehScatter: 0.10 + rng() * 0.05,
    ageMetallicityFactor: 0.04 + rng() * 0.03,
  };
}

function sampleElliptical(rng: () => number): GalaxyParams {
  // Ellipticals: no disc, no arms; just a spheroid. Spatially we represent
  // this with the existing bulge term inflated to fill the galaxy, and
  // the disc term zeroed out. SFR is a single early burst.
  const galaxyAgeGyr = 9 + rng() * 4.5;  // old
  const radius = 20000 + rng() * 60000;
  return {
    radius,
    arms: 0,
    spin: 0,
    armSharpness: 1,
    armStrength: 0,
    discScaleR: 1,        // unused — disc term will be near-zero
    discScaleZ: 1,
    discDensity: 0,
    bulgeScale: radius * 0.3,
    bulgeDensity: 0.15 + rng() * 0.20,

    type: "elliptical",
    galaxyAgeGyr,

    sfrPeakGyr: 0.5 + rng() * 1.0,         // burst near galaxy birth
    sfrTauInner: 0.5 + rng() * 0.5,        // short decay
    sfrTauOuter: 0.5 + rng() * 0.5,
    bulgeBurstWidthGyr: 0.5 + rng() * 0.8,
    armYouthBoost: 0,

    fehCentral: 0.0 + rng() * 0.4,
    fehGradient: -5e-6 - rng() * 5e-6,     // weak gradient
    fehVerticalGradient: 0,
    fehScatter: 0.10 + rng() * 0.05,
    ageMetallicityFactor: 0,               // most stars same age → no AMR
  };
}

function sampleIrregular(rng: () => number): GalaxyParams {
  // Irregulars: low-mass, low-metallicity, gas-rich, stochastic SF. We
  // model spatial structure with a soft disc + a small handful of
  // localized over-dense clumps that represent current star-forming
  // regions. The clump positions are baked into GalaxyParams so the
  // density field can read them deterministically.
  const galaxyAgeGyr = 5 + rng() * 7;
  const radius = 5000 + rng() * 15000;

  const nClumps = 3 + Math.floor(rng() * 8);
  const irregularClumps: { position: THREE.Vector3; scale: number; density: number }[] = [];
  for (let i = 0; i < nClumps; i++) {
    const r = rng() * radius * 0.8;
    const theta = rng() * Math.PI * 2;
    irregularClumps.push({
      position: new THREE.Vector3(
        r * Math.cos(theta),
        (rng() - 0.5) * radius * 0.2,
        r * Math.sin(theta),
      ),
      scale: 500 + rng() * 1500,
      density: 0.05 + rng() * 0.15,
    });
  }

  return {
    radius,
    arms: 0,
    spin: 0,
    armSharpness: 1,
    armStrength: 0,
    discScaleR: radius * 0.5,
    discScaleZ: radius * 0.15,
    discDensity: 0.01 + rng() * 0.02,
    bulgeScale: radius * 0.3,
    bulgeDensity: 0.02 + rng() * 0.03,

    type: "irregular",
    galaxyAgeGyr,
    irregularClumps,

    sfrPeakGyr: galaxyAgeGyr * 0.4,
    sfrTauInner: 5 + rng() * 5,
    sfrTauOuter: 5 + rng() * 5,
    bulgeBurstWidthGyr: 1.5 + rng() * 1.5,
    armYouthBoost: 0,

    fehCentral: -0.8 + rng() * 0.4,
    fehGradient: 0,
    fehVerticalGradient: 0,
    fehScatter: 0.20 + rng() * 0.10,
    ageMetallicityFactor: 0.03 + rng() * 0.02,
  };
}

// ── SFR at position and time ───────────────────────────────────────────
//
// Unnormalized weight for star formation at (x,y,z) and time t (Gyr since
// galaxy birth). Composed of three temporal shapes, each weighted by the
// local spatial component:
//
//   bulgeWeight × gaussian_burst(t)
//   discWeight  × delayed_tau(t, with tau growing outward)
//   armEnhance  × young_step(t)
//   clumpWeight × recent_step(t)
//
// The spatial weights mirror the structure of densityAt — same exponentials
// and angular term — so the SFR field is consistent with the density field
// at present-day.

export function sfrAt(
  p: GalaxyParams,
  x: number, y: number, z: number,
  t: number,
): number {
  if (t < 0 || t > p.galaxyAgeGyr) return 0;

  const r2 = x * x + z * z;
  const r = Math.sqrt(r2);
  const r3 = Math.sqrt(r2 + y * y);
  const absY = Math.abs(y);

  const bulgeWeight = p.bulgeDensity * Math.exp(-r3 / p.bulgeScale);
  const discWeight = p.discDensity * Math.exp(-r / p.discScaleR) * Math.exp(-absY / p.discScaleZ);

  // Bulge: gaussian burst centered at sfrPeakGyr.
  const bulgeT = Math.exp(-((t - p.sfrPeakGyr) ** 2) / (2 * p.bulgeBurstWidthGyr ** 2));

  // Disc: delayed-τ. tau grows with radius (inside-out formation), and the
  // onset time shifts later for the outer disc.
  const rFrac = Math.min(1, r / p.radius);
  const tau = p.sfrTauInner + (p.sfrTauOuter - p.sfrTauInner) * rFrac;
  const tForm = p.sfrPeakGyr * (1 - 0.5 * rFrac);
  const dt = t - tForm;
  const discT = dt > 0 ? dt * Math.exp(-dt / tau) : 0;

  // Arms: only contribute to very young populations (last few × 10^8 yr).
  // The arms in densityAt already enhance the present-day disc; here we
  // add an additional age-bias factor for them.
  let armT = 0;
  if (p.armStrength > 0 && t > p.galaxyAgeGyr - 0.5) {
    const theta = Math.atan2(z, x);
    const armPhase = p.arms * theta + r * p.spin;
    const armFactor = Math.max(0, Math.cos(armPhase));
    armT = Math.pow(armFactor, p.armSharpness) * p.armStrength * p.armYouthBoost;
  }

  // Irregular clumps: only contribute to recent SF.
  let clumpT = 0;
  if (p.irregularClumps && t > p.galaxyAgeGyr - 1.0) {
    for (const c of p.irregularClumps) {
      const dx = x - c.position.x, dy = y - c.position.y, dz = z - c.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      clumpT += c.density * Math.exp(-d2 / (2 * c.scale * c.scale));
    }
  }

  return bulgeWeight * bulgeT + discWeight * (discT + armT) + clumpT;
}

// ── Birth time / age sampling ──────────────────────────────────────────
//
// Discretize sfrAt onto a small time grid (32 points across the galaxy's
// life), build a CDF, inverse-sample. The fine-grained PDF would be a
// continuous function we could analytically invert, but the multi-component
// shape makes that fiddly; the grid approach is fast and the bin width
// (galaxyAgeGyr / 32, e.g. ~400 Myr for a 12 Gyr galaxy) is finer than
// gameplay timescales need.

const SFR_GRID_POINTS = 32;

export function sampleBirthTimeAt(
  p: GalaxyParams,
  x: number, y: number, z: number,
  rng: () => number,
): number {
  const grid: number[] = new Array(SFR_GRID_POINTS);
  const dt = p.galaxyAgeGyr / SFR_GRID_POINTS;
  let total = 0;
  for (let i = 0; i < SFR_GRID_POINTS; i++) {
    const t = (i + 0.5) * dt;
    const w = sfrAt(p, x, y, z, t);
    grid[i] = w;
    total += w;
  }
  if (total <= 0) {
    // Shouldn't happen for a populated cell, but as a fallback pick a
    // uniform random time so the star at least exists.
    return rng() * p.galaxyAgeGyr;
  }
  const target = rng() * total;
  let acc = 0;
  for (let i = 0; i < SFR_GRID_POINTS; i++) {
    acc += grid[i];
    if (target <= acc) {
      // Sub-bin uniform smoothing — avoids visible 400-Myr quantization
      // if you later visualize age distributions.
      return i * dt + rng() * dt;
    }
  }
  return p.galaxyAgeGyr;
}

/** Age in Gyr (galaxy age − birth time). */
export function sampleAgeAt(
  p: GalaxyParams,
  x: number, y: number, z: number,
  rng: () => number,
): number {
  return p.galaxyAgeGyr - sampleBirthTimeAt(p, x, y, z, rng);
}

// ── Metallicity ────────────────────────────────────────────────────────
//
// Mean [Fe/H] is a linear combination of position and age. Scatter is
// drawn from a gaussian via Box-Muller. Old stars in the same location are
// systematically more metal-poor (the age-metallicity relation).

export function meanMetallicityAt(
  p: GalaxyParams,
  x: number, y: number, z: number,
  ageGyr: number,
): number {
  const r = Math.sqrt(x * x + z * z);
  const absY = Math.abs(y);
  return (
    p.fehCentral
    + p.fehGradient * r
    + p.fehVerticalGradient * absY
    - p.ageMetallicityFactor * ageGyr
  );
}

export function sampleMetallicityAt(
  p: GalaxyParams,
  x: number, y: number, z: number,
  ageGyr: number,
  rng: () => number,
): number {
  const mean = meanMetallicityAt(p, x, y, z, ageGyr);
  // Box-Muller. Clamping u1 away from 0 avoids log(0) → -Infinity.
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + p.fehScatter * n;
}