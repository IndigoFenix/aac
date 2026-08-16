// system.ts — Full solar system materialization, unified Body model.
//
// Given a StarRecord (system primary from expandLeafCell), produce all the
// other bodies in its system:
//   - Cloud-collapse companions (binaries / triples / quads)
//   - Disk-accretion bodies (planets, brown dwarfs, etc.) around each
//     cloud-collapse body
//   - Moons around each sufficiently-massive disk body — recursive
//     application of the same disk-accretion machinery at smaller scale
//
// Everything is a Body. Labels like "planet" / "moon" / "stellar
// companion" emerge from physics post-hoc; the generator never reads them.
//
// Storage is FORMATION-STATE ONLY (lazy evaluation). SystemBlueprint.bodies
// holds Body records. To get any body's current observable state, use
// resolveSystem(), which also computes the BodyFeatures layer.

import { mulberry32 } from "../galaxy";
import type { StarRecord, GalaxyParams } from "../galaxy";
import {
  Body,
  BodyState,
  ParentContext,
  bodyState,
  bodyRadiusEarth,
  starToBody,
  isTidallyDisrupted,
  M_EARTH_PER_M_SUN,
  M_HYDROGEN_FUSION_SUN,
  NO_PARENT,
} from "./body";
import { bodyFeatures, BodyFeatures } from "./features";
import { msLuminosity } from "../stellar";

// ── Records ────────────────────────────────────────────────────────────

export interface SystemBlueprint {
  starId: string;
  systemSeed: number;
  /** All surviving bodies in the system. parentId references form a tree
   *  rooted at the system primary (whose parentId is null). Tree depth:
   *  primary → stellar companions / planets → moons. */
  bodies: Body[];
}

// ── Constants ──────────────────────────────────────────────────────────

const R_EARTH_IN_AU = 4.2635e-5;

// ── Rotation & tilt sampling ───────────────────────────────────────────
//
// Formation-time stochastic rolls for non-stellar bodies. Stars get the
// sun-like defaults from starToBody; planets / moons get sampled values
// here since their rotational diversity matters more for downstream
// features (tidal locking, banding, etc.).

function sampleRotationHours(rng: () => number): number {
  // Log-normal centered on ~12 h, with tails to fast (~3 h, like Jupiter)
  // and slow (~50 h). Pre-tidal-evolution; tidal locking modifies later.
  // ~3% probability of retrograde rotation (sign flipped), modeling rare
  // catastrophic events like Venus's hypothesized resonance lock with the
  // Sun via thick atmospheric tides. Even rarer: extremely slow rotation
  // (~2000+ h) representing partial atmospheric spin coupling.
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  let period = Math.max(2, Math.exp(Math.log(12) + 0.6 * z));

  // Slow-spinning outlier — Venus's 5832h rotation is ~30σ off the normal
  // distribution. We sample it explicitly with low probability.
  if (rng() < 0.01) {
    period = period * (50 + rng() * 500);
  }

  // Retrograde flip.
  if (rng() < 0.03) {
    period = -period;
  }

  return period;
}

function sampleAxialTilt(rng: () => number): number {
  // Heavily weighted toward small tilts (most bodies form aligned with
  // their disk's angular momentum). Long tail to extreme values comes
  // from giant impacts and resonances. Calibration aims to roughly
  // reproduce solar system tilt diversity (Mercury 0°, Earth 23°,
  // Uranus 98°, Venus 177°).
  const u = rng();
  const deg = Math.PI / 180;
  if (u < 0.70) return (u / 0.70) * 30 * deg;
  if (u < 0.93) return (30 + (u - 0.70) / 0.23 * 30) * deg;
  if (u < 0.99) return (60 + (u - 0.93) / 0.06 * 50) * deg;
  return (110 + (u - 0.99) / 0.01 * 70) * deg;
}

/**
 * Sample refractoryDensityFactor for inner rocky bodies. The mechanism for
 * iron-rich anomalies is mantle stripping by giant impacts close to the
 * host star, where the dust is also iron-enriched by sublimation of
 * silicates. Probability rises sharply for bodies inside ~0.5 AU and is
 * negligible past 1 AU.
 */
function sampleRefractoryDensityFactor(
  semiMajorAU: number,
  totalMassEarth: number,
  rng: () => number,
): number {
  if (totalMassEarth > 1) return 1.0;            // big bodies can't be fully stripped
  const closeness = Math.max(0, 1 - semiMajorAU / 0.7);
  const pAnomaly = 0.15 * closeness;             // ~15% inside 0.4 AU
  if (rng() > pAnomaly) return 1.0;
  return 1.3 + rng() * 0.6;                       // 1.3-1.9
}

// ── Cloud-collapse multiplicity ─────────────────────────────────────────
// Mass-dependent fractions of single / binary / triple / quad systems.

interface MultiplicityRow {
  massCap: number;
  single: number; binary: number; triple: number; quad: number;
}

const MULTIPLICITY: MultiplicityRow[] = [
  { massCap: 0.5,      single: 0.65, binary: 0.30, triple: 0.04, quad: 0.01 },
  { massCap: 0.8,      single: 0.55, binary: 0.38, triple: 0.06, quad: 0.01 },
  { massCap: 1.5,      single: 0.46, binary: 0.41, triple: 0.11, quad: 0.02 },
  { massCap: 2.0,      single: 0.30, binary: 0.45, triple: 0.22, quad: 0.03 },
  { massCap: 16,       single: 0.20, binary: 0.45, triple: 0.30, quad: 0.05 },
  { massCap: Infinity, single: 0.05, binary: 0.30, triple: 0.50, quad: 0.15 },
];

function pickNComponents(primaryMass: number, rng: () => number): number {
  let row = MULTIPLICITY[MULTIPLICITY.length - 1];
  for (const r of MULTIPLICITY) {
    if (primaryMass < r.massCap) { row = r; break; }
  }
  const u = rng();
  if (u < row.single) return 1;
  if (u < row.single + row.binary) return 2;
  if (u < row.single + row.binary + row.triple) return 3;
  return 4;
}

function sampleLogPeriodDays(primaryMass: number, rng: () => number): number {
  let mu: number, sigma: number;
  if (primaryMass < 0.5) { mu = 4.0; sigma = 2.0; }
  else if (primaryMass < 1.5) { mu = 5.0; sigma = 2.3; }
  else if (primaryMass < 8) { mu = 4.5; sigma = 2.4; }
  else { mu = 3.5; sigma = 2.4; }
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + sigma * z;
}

function sampleMassRatio(periodLogDays: number, rng: () => number): number {
  const twinExcess = periodLogDays < 1 ? 0.20 : 0.10;
  if (rng() < twinExcess) return 0.95 + rng() * 0.05;
  return 0.10 + rng() * 0.85;
}

function sampleEccentricity(periodDays: number, rng: () => number): number {
  if (periodDays < 12) return rng() * 0.05;
  return rng() * 0.9;
}

function periodToSemiMajorAU(logPeriodDays: number, totalMassSun: number): number {
  const periodYears = Math.pow(10, logPeriodDays) / 365.25;
  return Math.pow(totalMassSun * periodYears * periodYears, 1 / 3);
}

// ── Disk-accretion: candidate sampling ─────────────────────────────────
//
// Generic disk sampler. Used for both circumstellar disks (planets around
// stars) and circumplanetary disks (moons around planets). Same physics,
// different scale. The caller provides bounds and a mass budget.

const N_DISK_CANDIDATES = 35;
const N_MOON_CANDIDATES = 12;
const SNOW_LINE_COEFF = 1.7;

interface DiskCandidate {
  semiMajorAU: number;
  refractory: number;
  ice: number;
  hhe: number;
}

function sampleStellarDiskCandidates(
  hostMassSun: number,
  hostLuminositySun: number,
  hostFeh: number,
  rng: () => number,
): DiskCandidate[] {
  const innerAU = 0.03;
  const outerAU = 100;
  const snowLineAU = SNOW_LINE_COEFF * Math.sqrt(Math.max(0.001, hostLuminositySun));
  const metalFactor = Math.pow(10, hostFeh);

  const candidates: DiskCandidate[] = [];
  for (let i = 0; i < N_DISK_CANDIDATES; i++) {
    const u = rng();
    const a = innerAU * Math.pow(outerAU / innerAU, u);

    const baseSolid =
      metalFactor
      * 7.1
      * Math.pow(hostMassSun, 1.5)
      * Math.pow(a, -1.5);
    const isPastSnow = a > snowLineAU;
    const surfaceSolid = isPastSnow ? baseSolid * 3 : baseSolid;

    const logSpan = Math.log(outerAU / innerAU) / N_DISK_CANDIDATES;
    const annulusMass = surfaceSolid * 2 * Math.PI * a * a * logSpan;
    const coreEfficiency = 0.2 + rng() * 0.6;
    const coreMass = annulusMass * coreEfficiency * 1e-3;
    if (coreMass < 0.005) continue;

    let refractory: number, ice: number;
    if (isPastSnow) {
      refractory = coreMass * 0.3;
      ice = coreMass * 0.7;
    } else {
      refractory = coreMass;
      ice = 0;
    }

    // Gas accretion regime by core mass.
    let hhe = 0;
    if (coreMass > 10) {
      if (rng() < 0.6) hhe = coreMass * (1 + rng() * 30);
      else hhe = coreMass * (0.2 + rng() * 0.6);
    } else if (coreMass > 3) {
      if (rng() < 0.5) hhe = coreMass * (0.1 + rng() * 0.8);
      else hhe = coreMass * (0.01 + rng() * 0.05);
    } else if (coreMass > 0.5) {
      if (rng() < 0.3) hhe = coreMass * (0.005 + rng() * 0.03);
    }

    candidates.push({ semiMajorAU: a, refractory, ice, hhe });
  }

  candidates.sort((a, b) => a.semiMajorAU - b.semiMajorAU);
  return candidates;
}

/**
 * Generate moon candidates around a planet-class body. Same machinery as
 * stellar disks, scaled down. Disk bounds set by:
 *   - Inner edge: ~2× host radius (above Roche limit)
 *   - Outer edge: ~0.3 × host's Hill radius around its parent
 * Composition follows a host-radiation-set snow line: close-in moons
 * rocky, distant moons icy. No H/He accretion — moons are too small.
 */
function sampleMoonCandidates(
  hostBody: Body,
  hostMassSun: number,
  hostRadiusEarth: number,
  parentMassSun: number,
  rng: () => number,
): DiskCandidate[] {
  if (parentMassSun <= 0 || hostBody.formationSemiMajor <= 0) return [];
  if (hostRadiusEarth <= 0) return [];

  const hostRadiusAU = hostRadiusEarth * R_EARTH_IN_AU;
  const hillRadiusAU = hostBody.formationSemiMajor
    * Math.pow(hostMassSun / (3 * parentMassSun), 1 / 3);

  const innerAU = 2 * hostRadiusAU;
  const outerAU = 0.3 * hillRadiusAU;
  if (outerAU <= innerAU * 1.5) return [];   // moon zone too narrow

  const candidates: DiskCandidate[] = [];
  const hostTotalE = hostBody.formationRefractory + hostBody.formationIce + hostBody.formationHHe;
  // Circumplanetary disk solid mass ≈ 1e-4 × host mass. Galilean moons
  // sum to ~4e-4 × Jupiter mass, of which a quarter is rocky — consistent.
  const cpDiskFactor = 1e-4 * Math.pow(10, hostBody.feh);
  const moonSnowAU = hostRadiusAU * 7;

  for (let i = 0; i < N_MOON_CANDIDATES; i++) {
    const u = rng();
    const a = innerAU * Math.pow(outerAU / innerAU, u);
    const annulusFrac = 1 / N_MOON_CANDIDATES;
    const annulusMass = hostTotalE * cpDiskFactor * annulusFrac;
    const accretionEff = Math.pow(rng(), 2) * 2;  // skew toward small
    const moonMass = annulusMass * accretionEff;
    if (moonMass < 0.0001) continue;

    let refractory: number, ice: number;
    if (a < moonSnowAU) {
      refractory = moonMass;
      ice = 0;
    } else {
      refractory = moonMass * 0.35;
      ice = moonMass * 0.65;
    }
    candidates.push({ semiMajorAU: a, refractory, ice, hhe: 0 });
  }

  candidates.sort((a, b) => a.semiMajorAU - b.semiMajorAU);
  return candidates;
}

// ── Hill-stability merge pass ──────────────────────────────────────────

const HILL_DELTA_CRIT_MIN = 8;
const HILL_DELTA_CRIT_MAX = 12;

function mutualHillRadiusAU(
  a1: number, a2: number,
  m1Sun: number, m2Sun: number,
  hostMassSun: number,
): number {
  return ((a1 + a2) / 2) * Math.pow((m1Sun + m2Sun) / (3 * hostMassSun), 1 / 3);
}

function hillMerge(
  candidates: DiskCandidate[],
  hostMassSun: number,
  rng: () => number,
): DiskCandidate[] {
  const deltaCrit = HILL_DELTA_CRIT_MIN + rng() * (HILL_DELTA_CRIT_MAX - HILL_DELTA_CRIT_MIN);
  const stable: DiskCandidate[] = [];
  for (const cand of candidates) {
    if (stable.length === 0) { stable.push(cand); continue; }
    const prev = stable[stable.length - 1];
    const mPrev = (prev.refractory + prev.ice + prev.hhe) * M_EARTH_PER_M_SUN;
    const mCand = (cand.refractory + cand.ice + cand.hhe) * M_EARTH_PER_M_SUN;
    const rh = mutualHillRadiusAU(prev.semiMajorAU, cand.semiMajorAU, mPrev, mCand, hostMassSun);
    const sep = (cand.semiMajorAU - prev.semiMajorAU) / rh;
    if (sep >= deltaCrit) {
      stable.push(cand);
    } else {
      stable[stable.length - 1] = {
        semiMajorAU: (prev.semiMajorAU + cand.semiMajorAU) / 2,
        refractory: prev.refractory + cand.refractory,
        ice: prev.ice + cand.ice,
        hhe: prev.hhe + cand.hhe,
      };
    }
  }
  return stable;
}

// ── Main entry ──────────────────────────────────────────────────────────

export function materializeSystem(
  star: StarRecord,
  galaxyParams: GalaxyParams,
): SystemBlueprint {
  const rng = mulberry32(star.systemSeed);

  const galaxyAgeNow = galaxyParams.galaxyAgeGyr;
  const systemBirthTime = galaxyAgeNow - star.age;

  // 1. Primary becomes a Body.
  const primary = starToBody("A", star.massInit, star.age, star.feh, systemBirthTime);
  const bodies: Body[] = [primary];

  const massById = new Map<string, { massSun: number }>();
  massById.set("A", { massSun: star.massInit });

  // 2. Cloud-collapse companions.
  const nComponents = pickNComponents(star.massInit, rng);
  let innerSemiMajor = 0;
  let innerMassSum = star.massInit;
  const ids = ["A", "B", "C", "D"];

  for (let i = 1; i < nComponents; i++) {
    let logP = sampleLogPeriodDays(star.massInit, rng);
    for (let att = 0; att < 8; att++) {
      const periodYears = Math.pow(10, logP) / 365.25;
      const aTentative = Math.pow(innerMassSum * periodYears * periodYears, 1 / 3);
      if (innerSemiMajor === 0 || aTentative >= innerSemiMajor * 5) break;
      logP = sampleLogPeriodDays(star.massInit, rng);
    }
    const q = sampleMassRatio(logP, rng);
    const compMass = Math.max(0.08, star.massInit * q);
    const totalThisOrbit = innerMassSum + compMass;
    const semiMajor = periodToSemiMajorAU(logP, totalThisOrbit);
    const periodDays = Math.pow(10, logP);
    const ecc = sampleEccentricity(periodDays, rng);

    const compBody = starToBody(ids[i], compMass, star.age, star.feh, systemBirthTime);
    compBody.formationSemiMajor = semiMajor;
    compBody.formationEccentricity = ecc;
    compBody.parentId = "A";
    bodies.push(compBody);
    massById.set(compBody.id, { massSun: compMass });

    innerSemiMajor = semiMajor;
    innerMassSum = totalThisOrbit;
  }

  // 3. Disk-accretion bodies around each cloud-collapse body.
  const cloudCollapseSnapshot = bodies.slice();
  const diskBornBodies: Body[] = [];

  for (const host of cloudCollapseSnapshot) {
    if (host.parentId !== null && host.formationSemiMajor < 5) continue;

    const hostMassSun = massById.get(host.id)!.massSun;
    const hostL = hostMassSun >= M_HYDROGEN_FUSION_SUN ? msLuminosity(hostMassSun) : 1e-4;

    let candidates = sampleStellarDiskCandidates(hostMassSun, hostL, host.feh, rng);
    candidates = hillMerge(candidates, hostMassSun, rng);

    let diskIdx = 0;
    for (const cand of candidates) {
      // Sample density anomaly for inner rocky bodies. Past the snow line
      // or for substantial gas-bearing bodies it stays 1.0.
      const totalE = cand.refractory + cand.ice + cand.hhe;
      const densityFactor = (cand.hhe < 0.1 * totalE)
        ? sampleRefractoryDensityFactor(cand.semiMajorAU, totalE, rng)
        : 1.0;
      const planet: Body = {
        id: `${host.id}p${diskIdx++}`,
        formationRefractory: cand.refractory,
        formationIce: cand.ice,
        formationHHe: cand.hhe,
        formationSemiMajor: cand.semiMajorAU,
        formationEccentricity: rng() * 0.1,
        formationInclination: rng() * 0.05,
        parentId: host.id,
        formationRotationHours: sampleRotationHours(rng),
        formationAxialTilt: sampleAxialTilt(rng),
        birthTimeGyr: host.birthTimeGyr,
        feh: host.feh,
        refractoryDensityFactor: densityFactor,
      };
      bodies.push(planet);
      diskBornBodies.push(planet);
    }
  }

  // 3a. Late-veneer water delivery. After primary accretion ends, the
  //     residual planetesimal swarm — biased toward icy material from
  //     beyond the snow line — scatters inward and impacts rocky bodies,
  //     delivering a fraction-of-a-percent water mass. This is how Earth
  //     got its oceans. Mars got less because of Jupiter's perturbation;
  //     Venus may have gotten as much as Earth and lost it.
  //
  //     We model: inner rocky bodies (a < snowLine, low HHe) receive a
  //     stochastic ice contribution scaled by how close they are to the
  //     snow line and modulated by an RNG roll. Far inside (<0.4 AU):
  //     little reaches. Just inside the snow line: substantial delivery.
  for (const host of cloudCollapseSnapshot) {
    if (host.parentId !== null && host.formationSemiMajor < 5) continue;
    const hostMassSun = massById.get(host.id)!.massSun;
    const hostL = hostMassSun >= M_HYDROGEN_FUSION_SUN ? msLuminosity(hostMassSun) : 1e-4;
    const snowLineAU = SNOW_LINE_COEFF * Math.sqrt(Math.max(0.001, hostL));
    for (const planet of diskBornBodies) {
      if (planet.parentId !== host.id) continue;
      if (planet.formationSemiMajor >= snowLineAU) continue;
      const planetTotal = planet.formationRefractory + planet.formationIce + planet.formationHHe;
      if (planet.formationHHe > 0.1 * planetTotal) continue;  // gas-bearing — skip

      // How much volatile reaches: peaked at the snow line, falling
      // toward zero at very inner orbits. Fraction (of body mass) varies
      // 0 - 5% with a stochastic factor.
      const proximity = planet.formationSemiMajor / snowLineAU;     // 0..1
      const reachFactor = Math.pow(proximity, 1.5);                 // inner = less
      const stochastic = Math.pow(rng(), 1.5);                      // skewed low — most worlds get little
      const veneerFrac = reachFactor * stochastic * 0.05;
      const delivered = planet.formationRefractory * veneerFrac;
      planet.formationIce += delivered;
    }
  }

  // 3b. Giant impact branch. Roll for each rocky/icy body (no thick H/He
  //     envelope) — low probability of a Moon-forming collision. When
  //     triggered:
  //       - Spawn one large moon (1-3% of host mass)
  //       - Boost axial tilt substantially (up to +90°)
  //       - Small chance of retrograde spin (Venus-style)
  //       - For small inner bodies: chance of mantle stripping
  //         (refractoryDensityFactor jumps up) — Mercury scenario
  //
  //     We schedule giant impacts here but DELAY moon creation until step
  //     4 so the moon goes through the same Hill-merge + disruption pass.
  const giantImpactMoons: Array<{ host: Body; moonMass: number }> = [];
  for (const planet of diskBornBodies) {
    const totalE = planet.formationRefractory + planet.formationIce + planet.formationHHe;
    if (totalE < 0.05 || totalE > 5) continue;       // only terrestrial-scale
    if (planet.formationHHe > 0.1 * totalE) continue; // skip mini-Neptunes

    const pImpact = 0.10;  // 10% of terrestrial-class bodies experience a moon-forming collision
    if (rng() > pImpact) continue;

    // Moon formation: 1-3% of host mass becomes a moon.
    const moonFrac = 0.01 + rng() * 0.02;
    const moonMass = totalE * moonFrac;
    giantImpactMoons.push({ host: planet, moonMass });

    // Tilt boost: add 20-90° onto the existing tilt.
    const tiltBoost = (20 + rng() * 70) * Math.PI / 180;
    planet.formationAxialTilt = Math.min(Math.PI, planet.formationAxialTilt + tiltBoost);

    // Small chance of retrograde flip (very rare — Venus-like).
    if (rng() < 0.05) {
      planet.formationRotationHours = -Math.abs(planet.formationRotationHours);
    }

    // Mantle stripping for small inner bodies — Mercury scenario.
    if (totalE < 0.3 && planet.formationSemiMajor < 0.6) {
      if (rng() < 0.4) {
        planet.refractoryDensityFactor = Math.max(
          planet.refractoryDensityFactor, 1.5 + rng() * 0.4
        );
      }
    }
  }

  // 4. Moons around each sufficiently-massive disk-born body.
  //
  // Threshold: bodies of formation total ≥ 1 M_earth get a moon-generation
  // pass. Real solar-system: Earth-mass and above tend to host moon
  // systems; smaller bodies rarely do. The Hill radius and disk-mass
  // scaling naturally suppress moons for bodies that don't deserve them.
  //
  // We use the body's FORMATION radius (computed from formation
  // composition) rather than current radius. This is the radius the body
  // had when the moon disk was actively accreting; later envelope loss
  // doesn't retroactively change where moons formed.
  for (const planet of diskBornBodies) {
    const totalE = planet.formationRefractory + planet.formationIce + planet.formationHHe;
    if (totalE < 1) {
      // Below threshold for regular disk-derived moons — but a giant
      // impact may still have produced one. Skip the disk path, but the
      // giant-impact moon (if any) is emitted below.
    } else {
      const planetMassSun = totalE * M_EARTH_PER_M_SUN;
      const fusionAtFormation =
        planetMassSun >= M_HYDROGEN_FUSION_SUN ? "hydrogen" : "none";
      const planetRadiusE = bodyRadiusEarth(
        planet.formationRefractory,
        planet.formationIce,
        planet.formationHHe,
        300,                  // placeholder formation surface temperature
        fusionAtFormation,
        planet.refractoryDensityFactor,
      );
      const parentMassSun = massById.get(planet.parentId!)!.massSun;

      let moonCandidates = sampleMoonCandidates(
        planet, planetMassSun, planetRadiusE, parentMassSun, rng,
      );
      moonCandidates = hillMerge(moonCandidates, planetMassSun, rng);

      let moonIdx = 0;
      for (const cand of moonCandidates) {
        bodies.push({
          id: `${planet.id}m${moonIdx++}`,
          formationRefractory: cand.refractory,
          formationIce: cand.ice,
          formationHHe: 0,
          formationSemiMajor: cand.semiMajorAU,
          formationEccentricity: rng() * 0.05,
          formationInclination: rng() * 0.05,
          parentId: planet.id,
          formationRotationHours: sampleRotationHours(rng),
          formationAxialTilt: sampleAxialTilt(rng),
          birthTimeGyr: planet.birthTimeGyr,
          feh: planet.feh,
          refractoryDensityFactor: 1.0,
        });
      }
      massById.set(planet.id, { massSun: planetMassSun });
    }
  }

  // 4b. Giant-impact moons. These are emitted regardless of host mass;
  //     they come from the planet's own material thrown into orbit by the
  //     impactor and are typically much larger than disk-accretion moons
  //     would be for the same host. Placed at ~3-15 planet radii (Earth's
  //     Moon: 60 R_earth currently, but ~3-5 R_earth at formation before
  //     tidal recession; we use the formation distance for orbital
  //     stability and let UI show the current Moon position elsewhere).
  for (const { host, moonMass } of giantImpactMoons) {
    const totalE = host.formationRefractory + host.formationIce + host.formationHHe;
    const hostMassSun = totalE * M_EARTH_PER_M_SUN;
    const hostRadiusE = bodyRadiusEarth(
      host.formationRefractory, host.formationIce, host.formationHHe,
      300, "none", host.refractoryDensityFactor,
    );
    const hostRadiusAU = hostRadiusE * R_EARTH_IN_AU;
    // Place the moon at 3-8 host radii — close-in initially, will recede
    // via tidal evolution.
    const moonSemiMajor = hostRadiusAU * (3 + rng() * 5);
    // Composition: moon-forming impacts typically scatter mantle material,
    // so moons are refractory-dominated even when the host had ice
    // available. Earth's Moon is famously ice-poor relative to expectation.
    const moonRefractory = moonMass * 0.95;
    const moonIce = moonMass * 0.05;

    bodies.push({
      id: `${host.id}gim`,
      formationRefractory: moonRefractory,
      formationIce: moonIce,
      formationHHe: 0,
      formationSemiMajor: moonSemiMajor,
      formationEccentricity: rng() * 0.03,
      formationInclination: rng() * 0.1,
      parentId: host.id,
      formationRotationHours: sampleRotationHours(rng),
      formationAxialTilt: sampleAxialTilt(rng),
      birthTimeGyr: host.birthTimeGyr,
      feh: host.feh,
      refractoryDensityFactor: 1.0,
    });

    if (!massById.has(host.id)) {
      massById.set(host.id, { massSun: hostMassSun });
    }
  }

  // 5. Tidal disruption pruning. Bodies inside their parent's Roche
  // radius wouldn't have survived formation — drop them.
  const survivors = bodies.filter(b => {
    if (b.parentId === null) return true;
    const host = massById.get(b.parentId);
    if (!host) return true;
    return !isTidallyDisrupted(b, host.massSun);
  });

  return {
    starId: star.id,
    systemSeed: star.systemSeed,
    bodies: survivors,
  };
}

// ── Convenience: resolve all bodies + features at a given galaxy time ───

export interface ResolvedBody {
  body: Body;
  state: BodyState;
  features: BodyFeatures;
}

export function resolveSystem(
  system: SystemBlueprint,
  galaxyTimeGyr: number,
): ResolvedBody[] {
  const resolvedState = new Map<string, BodyState>();

  // Resolve state hierarchically: roots first, then children of resolved
  // parents, in waves.
  for (const b of system.bodies) {
    if (b.parentId === null) {
      resolvedState.set(b.id, bodyState(b, galaxyTimeGyr, NO_PARENT));
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const b of system.bodies) {
      if (resolvedState.has(b.id)) continue;
      if (b.parentId === null) continue;
      const parentState = resolvedState.get(b.parentId);
      if (!parentState) continue;
      const ctx: ParentContext = {
        luminosity: parentState.luminosity,
        mass: parentState.totalMass * M_EARTH_PER_M_SUN,
      };
      resolvedState.set(b.id, bodyState(b, galaxyTimeGyr, ctx));
      progressed = true;
    }
  }

  // Features: one pass over everything, using the resolved parent state
  // for context. Tidal heating and locking depend on parent properties,
  // so this couldn't be done before state was resolved.
  const features = new Map<string, BodyFeatures>();
  for (const b of system.bodies) {
    const state = resolvedState.get(b.id);
    if (!state) continue;
    const parent = b.parentId === null
      ? NO_PARENT
      : (() => {
          const ps = resolvedState.get(b.parentId);
          if (!ps) return NO_PARENT;
          return { luminosity: ps.luminosity, mass: ps.totalMass * M_EARTH_PER_M_SUN };
        })();
    features.set(b.id, bodyFeatures(b, state, parent));
  }

  return system.bodies.map(b => ({
    body: b,
    state: resolvedState.get(b.id) ?? bodyState(b, galaxyTimeGyr, NO_PARENT),
    features: features.get(b.id)!,
  }));
}