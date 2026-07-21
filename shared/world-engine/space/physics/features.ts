// features.ts — Exotic / derived body features.
//
// Computed lazily from a Body's current BodyState + parent context. None
// of these feed back into the core physics — they're an additional output
// layer describing what makes each body interesting. Adding new features
// here doesn't require regenerating systems.
//
// Per-body stochastic rolls (rings, life) use a hash of body.id, so the
// same body always yields the same outcome regardless of when it's
// queried or how many other systems have been materialized.

import {
  Body,
  BodyState,
  ParentContext,
  M_EARTH_PER_M_SUN,
} from "./body";
import { mulberry32 } from "../galaxy";
import * as THREE from "three";

// ── Deterministic per-body RNG ─────────────────────────────────────────

function bodyHash(id: string): number {
  // FNV-1a — stable, no project dependencies, suitable for short strings.
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** A deterministic RNG keyed on body.id and a salt. The salt namespace
 *  prevents correlations between feature rolls (e.g. ring presence and
 *  life status would otherwise share a stream). */
function bodyRng(b: Body, salt: number): () => number {
  return mulberry32((bodyHash(b.id) ^ salt) >>> 0);
}

// ── Types ──────────────────────────────────────────────────────────────

export interface BodyFeatures {
  rotation: RotationState;
  /** Internal heat flux out of the body's surface, W/m². Radiogenic +
   *  residual formation cooling + (for gas giants) gravitational
   *  contraction. */
  internalHeatFlux: number;
  /** Tidal heating flux, W/m². Significant only for eccentric orbits
   *  close to a massive parent (Io-like). */
  tidalHeatFlux: number;
  /** 0 = inert/cold (Mercury-like), 1 = vigorous plate tectonics +
   *  volcanism (Earth-like). For gas giants this becomes a "convective
   *  vigor" — same number, different physical meaning. */
  tectonicActivity: number;
  rings: RingSystem | null;
  /** 0 = uniform surface, 1 = sharply banded (Jupiter-like). */
  atmosphericBanding: number;
  /** Distinct visible bands. 0 if no banding. */
  atmosphericBandCount: number;
  life: LifeState;
  atmosphere: Atmosphere;
  /** Surface temp adjusted for greenhouse forcing. Use this for habitability,
   *  visual rendering, anything player-facing. The raw `state.surfaceTemp`
   *  is the radiative-equilibrium temperature before atmosphere.  */
  effectiveSurfaceTempK: number;
  terrain: Terrain;
  /** Final visible color, integrating surface composition + cloud layer +
   *  greenhouse haze. Replaces state.color for non-fusing bodies; for
   *  stars/remnants, defer to state.color. */
  surfaceColor: THREE.Color;
}

export interface RotationState {
  /** Current effective rotation period. For tidally locked bodies this
   *  equals the orbital period (or 2/3 of it for 3:2 resonances). Negative
   *  values denote retrograde rotation (Venus-like spin flips). */
  periodHours: number;
  axialTilt: number;              // radians
  tidallyLocked: boolean;
  /** 1 = synchronous, 1.5 = Mercury-like 3:2, 0 = chaotic. */
  spinOrbitResonance: number;
}

export type AtmosphereComposition =
  | "none"
  | "trace_co2"          // Mars-like — thin, freezing on poles
  | "thick_co2"          // Venus-like runaway — thick, hot
  | "n2_o2"              // Earth-like — biogenic O2 + N2 + water
  | "n2_co2"             // pre-biogenic Earth, Titan-class
  | "h_he"               // primary envelope retained — giant planet
  | "h_he_methane"       // ice-giant — H/He with methane absorption
  | "h_he_ammonia";      // gas-giant — H/He with ammonia clouds

export type CloudType =
  | "none"
  | "water"              // 200-400 K, water vapor present — Earth
  | "sulfuric_acid"      // 350+ K, thick CO2, sulfur outgassing — Venus
  | "methane"            // <100 K, methane condenses — Uranus, Neptune, Titan
  | "ammonia"            // 100-200 K H/He giant — Jupiter, Saturn
  | "co2_ice"            // <200 K w/ CO2 atmosphere — Martian polar
  | "iron_silicate";     // >1500 K — hot Jupiter day side

export interface Atmosphere {
  /** Atmospheric mass in M_earth. */
  massEarth: number;
  /** Surface pressure (bar) — Earth=1, Venus=92, Mars=0.006, Titan=1.5. */
  surfacePressureBar: number;
  composition: AtmosphereComposition;
  /** Temperature increase from greenhouse effect (K). */
  greenhouseDeltaK: number;
  cloudType: CloudType;
  /** 0 = clear (Mars), 1 = fully covered (Venus). */
  cloudCoverage: number;
  /** Cloud-deck base altitude above surface (km). Set by cloud-type physics:
   *  water=1–6 km, sulfuric_acid=45 km (Venus), methane=10 km (Titan)
   *  / upper-atm (ice giants), ammonia=0 km (gas-giant 1-bar level),
   *  co2_ice=15 km, iron_silicate=1000 km. Zero if cloudType="none". */
  cloudBaseAltitudeKm: number;
  /** Vertical extent of the cloud layer (km). Earth deck ~3 km, Venus
   *  main deck ~25 km, Jupiter ammonia ~50 km. */
  cloudThicknessKm: number;
  /** Typical horizontal visibility through the clear atmosphere (km). Earth
   *  ~200 km (Rayleigh-limited), Mars ~50 km (dust), Venus ~3 km below
   *  clouds (dense haze), Titan ~25 km (organic haze). Used for fog far
   *  plane and visual atmospheric depth. */
  visibilityKm: number;
  /** Altitude of the visible "top" of the atmosphere (km) — ~5 scale
   *  heights, beyond which density is below 1% of surface. Drives the
   *  atmosphere halo shell radius and the sky→space transition altitude.
   *  Earth ~80 km, Venus ~250 km, Mars ~80 km. Zero if no atmosphere. */
  atmosphereTopKm: number;
  /** Sky color at zenith (overhead) viewed from the surface in daylight.
   *  Derived from Rayleigh scattering of the host star's light through
   *  the atmospheric composition + cloud absorption. Earth=blue,
   *  Mars=butterscotch, Venus=dim yellow-orange, Titan=orange,
   *  no-atmosphere=black. */
  skyZenithColor: THREE.Color;
  /** Sky color near the horizon — longer light path through atmosphere
   *  shifts toward warmer / hazier tones (Mie scattering + aerosols).
   *  Earth=pale white-yellow, Mars=blue-grey (inverse of Earth — dust
   *  forward-scatters red toward the antisolar zenith), Venus=hazy
   *  orange. Matches zenith when atmosphere is too thin to differentiate. */
  skyHorizonColor: THREE.Color;
}

export interface Terrain {
  /** Local gravity at surface, in g (Earth=1.0). */
  surfaceGravityG: number;
  /** Maximum mountain height supportable by crust strength + gravity. km. */
  maxReliefKm: number;
  /** Typical mountain-range height. km. */
  typicalReliefKm: number;
  /** "How varied" the surface is: 0 = totally smooth (icy moon, gas giant),
   *  1 = highly textured (Earth, Io). */
  roughness: number;
}

export interface RingSystem {
  /** Inner edge in multiples of the body's radius. */
  innerBodyRadii: number;
  outerBodyRadii: number;
  /** Optical depth — 0 nearly invisible (Jupiter), 1 dense (Saturn A/B). */
  opticalDepth: number;
  composition: "ice" | "rock" | "dust";
}

export type LifeStage =
  | "none"
  | "prebiotic"
  | "microbial"
  | "complex"
  | "intelligent"
  | "post_civilization";

export interface LifeState {
  stage: LifeStage;
  /** Gyr since biogenesis. 0 if no life. */
  biosphereAgeGyr: number;
  /** Continuous habitability score 0-1, useful for UI display even when
   *  no life ended up emerging. */
  habitability: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const R_EARTH_M = 6.371e6;
const M_EARTH_KG = 5.972e24;

// ── Main entry ─────────────────────────────────────────────────────────

export function bodyFeatures(
  body: Body,
  state: BodyState,
  parent: ParentContext,
): BodyFeatures {
  const rotation = computeRotation(body, state, parent);
  const internalHeatFlux = computeInternalHeat(body, state);
  const tidalHeatFlux = computeTidalHeating(body, state, parent);
  const tectonicActivity = computeTectonicActivity(
    state,
    internalHeatFlux,
    tidalHeatFlux,
  );
  const rings = computeRings(body, state);
  const banding = computeBanding(
    state,
    Math.abs(rotation.periodHours),
    internalHeatFlux + tidalHeatFlux,
  );

  // Atmosphere first — both effective temperature and color depend on it.
  // The raw state.surfaceTemp is "bare body" radiative equilibrium; we
  // apply greenhouse forcing here to get the temperature life experiences.
  const atmosphere = computeAtmosphere(
    body, state, parent, tectonicActivity,
  );
  const effectiveSurfaceTempK = state.surfaceTemp + atmosphere.greenhouseDeltaK;

  const terrain = computeTerrain(body, state, tectonicActivity);
  const surfaceColor = computeSurfaceColor(
    body, state, atmosphere, effectiveSurfaceTempK,
  );

  // Life uses the GREENHOUSE-ADJUSTED temperature, not the bare equilibrium.
  // Otherwise Earth (T_eq = 254 K) reads as too cold and Venus (T_eq = 327 K)
  // reads as merely warm.
  const life = computeLife(body, state, parent, effectiveSurfaceTempK);

  return {
    rotation,
    internalHeatFlux,
    tidalHeatFlux,
    tectonicActivity,
    rings,
    atmosphericBanding: banding.intensity,
    atmosphericBandCount: banding.bandCount,
    life,
    atmosphere,
    effectiveSurfaceTempK,
    terrain,
    surfaceColor,
  };
}

// ── Rotation + tidal locking ───────────────────────────────────────────
//
// Tidal locking timescale (Goldreich-Soter simplified):
//   τ_lock ∝ a^6 × M_body × R_body^-5 / M_parent^2
// Calibrated so Earth (a=1 AU, M=R=1) yields τ ≈ 64,000 Gyr (not locked);
// a Hot Jupiter (a=0.05 AU, M=300, R=11) yields τ ≈ 2e-6 Gyr (instantly
// locked); Io (a=0.003 AU around Jupiter) yields τ ≈ 2e-5 Gyr (locked);
// our Moon (a=0.0026 AU around Earth) yields τ ≈ 2 Gyr (locked since
// Earth's youth).

const TIDAL_LOCK_CONSTANT = 0.0001;

function tidalLockTimescaleGyr(
  semiMajorAU: number,
  bodyMassEarth: number,
  bodyRadiusEarth: number,
  parentMassSun: number,
): number {
  if (parentMassSun <= 0 || bodyRadiusEarth <= 0 || bodyMassEarth <= 0) {
    return Infinity;
  }
  return (
    TIDAL_LOCK_CONSTANT
    * Math.pow(semiMajorAU / 0.05, 6)
    / Math.pow(parentMassSun, 2)
    * bodyMassEarth
    / Math.pow(bodyRadiusEarth, 5)
  );
}

function computeRotation(
  b: Body,
  state: BodyState,
  parent: ParentContext,
): RotationState {
  // Convention: formationRotationHours can be negative for retrograde
  // rotation (the rare Venus-like spin flip is sampled at formation).
  // We work with the magnitude for tidal-locking math, then restore the
  // sign at the end.
  const formationSign = Math.sign(b.formationRotationHours) || 1;
  let periodHours = Math.abs(b.formationRotationHours);
  const tilt = b.formationAxialTilt;
  let locked = false;
  let resonance = 1;

  if (b.parentId !== null && parent.mass > 0 && b.formationSemiMajor > 0) {
    const tauLock = tidalLockTimescaleGyr(
      b.formationSemiMajor,
      state.totalMass,
      state.radius,
      parent.mass,
    );
    // Mercury-style 3:2 resonance has a separate, SHORTER timescale than
    // synchronous lock for moderately eccentric orbits. Real physics:
    // resonant capture is the dominant outcome whenever e > ~0.1, because
    // the synchronous-lock attractor is destabilized by eccentricity.
    // Empirically the capture timescale into 3:2 is ~1% of the naive
    // synchronous lock timescale. Mercury (e=0.21, τ_lock = 144 Gyr) gets
    // captured at ~1.4 Gyr — comfortably before the system's 4.6 Gyr age.
    const eccentricity = b.formationEccentricity;
    if (eccentricity > 0.1 && isFinite(tauLock)) {
      const tauResonance = tauLock * 0.01;
      if (state.ageGyr > tauResonance) {
        // Captured into 3:2 resonance.
        locked = true;
        resonance = 1.5;
        const orbitalYears = Math.sqrt(
          Math.pow(b.formationSemiMajor, 3) / parent.mass,
        );
        const orbitalHours = orbitalYears * 8766;
        periodHours = orbitalHours * (2 / 3);
      }
    }
    // Synchronous lock — the deeper attractor for low-e bodies.
    if (!locked && state.ageGyr > tauLock && isFinite(tauLock)) {
      locked = true;
      const orbitalYears = Math.sqrt(
        Math.pow(b.formationSemiMajor, 3) / parent.mass,
      );
      const orbitalHours = orbitalYears * 8766;
      resonance = 1;
      periodHours = orbitalHours;
    }
  }

  // Tidally locked bodies forget their formation spin direction; otherwise
  // restore the sign so retrograde rotation persists.
  const signedPeriod = locked ? periodHours : periodHours * formationSign;

  return {
    periodHours: signedPeriod,
    axialTilt: tilt,
    tidallyLocked: locked,
    spinOrbitResonance: resonance,
  };
}

// ── Internal heat ──────────────────────────────────────────────────────
//
// Three sources, all expressed as a surface flux (W/m²):
//   1. Radiogenic decay — long-lived isotopes in rocky material. Earth
//      produces ~0.08 W/m² today, decaying with τ ≈ 5 Gyr.
//   2. Residual formation heat — large initial budget, decays as t^(-1).
//   3. Gravitational contraction — significant only for gas giants;
//      Jupiter emits ~5.4 W/m² total, mostly from this source.

function computeInternalHeat(b: Body, state: BodyState): number {
  if (state.totalMass < 0.001) return 0;
  const ageGyr = Math.max(0.01, state.ageGyr);

  // Radiogenic power (W). Calibrated so a 1-M_earth body of pure refractory
  // matter at age 4.5 Gyr produces ~25 TW (Earth's current radiogenic budget).
  const radioFactor = Math.exp(-(ageGyr - 4.5) / 5);
  const radioPower = 25e12 * b.formationRefractory * radioFactor;

  // Residual formation heat — fades as t^(-1).
  const residualPower = 5e12 * b.formationRefractory / ageGyr;

  // Gas-giant contraction. Only significant if envelope mass is large.
  let contractionPower = 0;
  if (state.currentHHe > 50) {
    contractionPower = 3.5e17 * (state.currentHHe / 300) / Math.sqrt(ageGyr);
  }

  const totalPower = radioPower + residualPower + contractionPower;
  const radiusM = state.radius * R_EARTH_M;
  if (radiusM <= 0) return 0;
  const surfaceArea = 4 * Math.PI * radiusM * radiusM;
  return totalPower / surfaceArea;
}

// ── Tidal heating ──────────────────────────────────────────────────────
//
// Significant only for eccentric orbits near massive parents. Calibrated
// so Io (e≈0.004 around Jupiter at 0.0028 AU) yields ~2 W/m², which
// matches its observed surface heat flux. Earth gets <0.01 W/m² from
// solar/lunar tides combined.

function computeTidalHeating(
  b: Body,
  state: BodyState,
  parent: ParentContext,
): number {
  if (b.parentId === null || parent.mass <= 0) return 0;
  if (b.formationEccentricity < 0.005) return 0;
  if (b.formationSemiMajor <= 0) return 0;

  const flux =
    0.3
    * Math.pow(parent.mass, 2)
    * Math.pow(b.formationEccentricity, 2)
    * state.radius
    / Math.pow(b.formationSemiMajor, 4);
  return Math.min(flux, 50);  // physical cap — beyond this body is being torn apart
}

// ── Tectonic activity ──────────────────────────────────────────────────
//
// A composite score 0-1 driven by total heat flux. Calibration points:
//   Earth (~0.08 W/m², radiogenic) → ~0.8 (vigorous tectonics)
//   Mars (~0.03 W/m²) → ~0.3 (stagnant lid, episodic volcanism)
//   Mercury (~0.01 W/m²) → ~0.05 (essentially dead)
//   Io (~2 W/m², tidal) → 1.0 (most volcanically active body known)
// For non-rocky bodies the same number describes "interior dynamism" —
// gas giants get high values from their convective interiors. UI should
// interpret accordingly.

function computeTectonicActivity(
  state: BodyState,
  internalFlux: number,
  tidalFlux: number,
): number {
  if (state.totalMass < 0.01) return 0;
  if (state.fusionMode !== "none") return 0;  // not meaningful for stars
  const totalFlux = internalFlux + tidalFlux;
  if (totalFlux < 0.005) return 0;
  return Math.min(1, totalFlux / 0.1);
}

// ── Rings ──────────────────────────────────────────────────────────────
//
// Stochastic per body. Probability scales with the body's ability to
// retain ring material (mass), composition (gas/ice giants more likely),
// and inversely with age (rings spread/dissipate over Gyr unless
// replenished). All four giant planets in our system have rings, but
// most are faint; we capture that with a low-optical-depth tail.

function computeRings(b: Body, state: BodyState): RingSystem | null {
  if (state.fusionMode !== "none") return null;
  if (state.totalMass < 1) return null;

  const rng = bodyRng(b, 0x6e1de23a);
  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);

  // Base probability by composition.
  let pRings: number;
  if (hheFrac > 0.5 && state.totalMass > 30) pRings = 0.80;       // gas giant
  else if (state.totalMass > 5 && b.formationIce > b.formationRefractory) pRings = 0.50;  // ice giant
  else if (state.totalMass > 1) pRings = 0.03;                     // rocky
  else pRings = 0.01;

  // Older bodies have had longer to lose rings to shepherd moons / collisions.
  pRings *= Math.exp(-state.ageGyr / 8);

  if (rng() > pRings) return null;

  const innerR = 1.5 + rng() * 0.5;
  const outerR = innerR + 0.5 + rng() * 2.5;
  // Optical depth is heavy-tailed — most rings are tenuous, rarely
  // Saturn-class. Use rng^2 for skew.
  const opticalDepth = 0.01 + Math.pow(rng(), 2) * 0.99;

  let composition: "ice" | "rock" | "dust";
  if (hheFrac > 0.5 && b.formationIce > 0.01 * state.totalMass) {
    composition = "ice";
  } else if (b.formationIce > b.formationRefractory) {
    composition = rng() < 0.5 ? "ice" : "dust";
  } else {
    composition = rng() < 0.5 ? "rock" : "dust";
  }

  return { innerBodyRadii: innerR, outerBodyRadii: outerR, opticalDepth, composition };
}

// ── Atmospheric banding ────────────────────────────────────────────────
//
// Cloud bands form from differential rotation + convection. Needs:
//   - Substantial atmosphere mass fraction
//   - Significant rotation (slower than a few days)
//   - Internal heat or strong solar forcing to drive convection
// Jupiter is the type case: rapid rotation, deep convective atmosphere,
// big internal heat budget. Uranus has bands but they're faint —
// internal heat is anomalously low.

function computeBanding(
  state: BodyState,
  rotationHours: number,
  totalHeatFlux: number,
): { intensity: number; bandCount: number } {
  const atmFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  if (atmFrac < 0.0001) return { intensity: 0, bandCount: 0 };
  if (rotationHours <= 0) return { intensity: 0, bandCount: 0 };

  const massPart = Math.min(1, Math.pow(atmFrac / 0.5, 0.3));
  const rotationPart = Math.min(1, Math.pow(24 / rotationHours, 0.5));
  const heatPart = Math.min(1, Math.pow(totalHeatFlux / 5, 0.3));

  const intensity = Math.min(1, massPart * rotationPart * (0.5 + 0.5 * heatPart));

  // Band count scales with rotation rate and body size. Jupiter: ~17
  // visible bands. Smaller / slower bodies: fewer.
  const bandCount = intensity > 0.05
    ? Math.round(
        3
        + Math.min(20,
          10 * Math.pow(24 / rotationHours, 0.5)
            * Math.pow(state.radius / 11, 0.3)),
      )
    : 0;

  return { intensity, bandCount };
}

// ── Life ───────────────────────────────────────────────────────────────
//
// The most speculative part. Habitability score gates whether biogenesis
// rolls happen; given biogenesis, biosphere age + habitability determine
// the developmental stage.
//
// Requirements (graded, not binary):
//   - Temperature: liquid water range, ~273-373 K is optimal, broader is
//     tolerable
//   - Composition: needs water (ice mass) and an atmosphere
//   - Time: ~0.5 Gyr stable conditions for microbial; ~3 Gyr for complex;
//     longer for intelligence
//   - Parent star stability: must outlive the time needed for evolution
//
// Stages:
//   prebiotic: chemistry started, no replication yet
//   microbial: bacterial-grade life
//   complex: multicellular
//   intelligent: technological civilization extant
//   post_civilization: intelligence existed but is gone (extinct, transcended)

function computeLife(
  b: Body,
  state: BodyState,
  parent: ParentContext,
  effectiveTempK: number,
): LifeState {
  // Hard exclusions.
  if (state.fusionMode !== "none") return { stage: "none", biosphereAgeGyr: 0, habitability: 0 };
  if (state.totalMass < 0.05 || state.totalMass > 30) {
    return { stage: "none", biosphereAgeGyr: 0, habitability: 0 };
  }

  // Temperature window — broad tolerance, optimum at liquid water range.
  // Use greenhouse-adjusted temp so Earth (T_eff = 287 K) reads as optimal.
  const T = effectiveTempK;
  let tempFactor: number;
  if (T < 150 || T > 500) tempFactor = 0;
  else if (T >= 273 && T <= 373) tempFactor = 1;
  else if (T < 273) tempFactor = Math.max(0, 1 - (273 - T) / 123);
  else tempFactor = Math.max(0, 1 - (T - 373) / 127);

  // Water availability — ice mass at formation is the proxy. Thresholds
  // calibrated against Earth's actual water budget (~0.00023 M_earth as
  // surface water; perhaps 10× that locked in mantle):
  //   iceFrac > 0.01    → ocean world or wet super-earth (waterFactor 1.0)
  //   iceFrac > 0.0005  → Earth-class wet world (waterFactor 0.6)
  //   iceFrac > 0.00005 → Mars-class trace water (waterFactor 0.15)
  //   below             → effectively dry (waterFactor 0.02)
  const iceFrac = b.formationIce / Math.max(1e-9, state.totalMass);
  let waterFactor: number;
  if (iceFrac > 0.01) waterFactor = 1;
  else if (iceFrac > 0.0005) waterFactor = 0.6;
  else if (iceFrac > 0.00005) waterFactor = 0.15;
  else waterFactor = 0.02;

  // Atmosphere retention.
  const atmFactor =
    state.totalMass > 0.3
      ? 1
      : Math.max(0, (state.totalMass - 0.05) / 0.25);

  // Parent stability — high-mass stars die fast.
  const parentMassSun = parent.mass;
  const parentFactor =
    parentMassSun < 2
      ? 1
      : Math.max(0, 1 - (parentMassSun - 2) / 3);

  const habitability = tempFactor * waterFactor * atmFactor * parentFactor;

  if (habitability < 0.05) return { stage: "none", biosphereAgeGyr: 0, habitability };

  // Biogenesis roll.
  const rng = bodyRng(b, 0xc01dca7e);
  const biogenesisProbability = habitability * 0.5;
  if (rng() > biogenesisProbability) {
    return { stage: "none", biosphereAgeGyr: 0, habitability };
  }

  // Biogenesis lag — life doesn't appear instantly even on a habitable world.
  const biogenesisDelay = 0.3 + rng() * 1.2;
  const biosphereAge = state.ageGyr - biogenesisDelay;
  if (biosphereAge <= 0) {
    return { stage: "prebiotic", biosphereAgeGyr: 0, habitability };
  }

  // Stage assignment.
  let stage: LifeStage;
  if (biosphereAge < 0.5) {
    stage = "prebiotic";
  } else if (biosphereAge < 2.5) {
    stage = "microbial";
  } else if (biosphereAge < 3.5) {
    // Complex life is roughly half the time after the microbial era.
    stage = habitability > 0.5 ? "complex" : "microbial";
  } else {
    // Past 3.5 Gyr of biosphere age — chance for intelligence.
    const intelRoll = rng();
    if (intelRoll < 0.001 * habitability) {
      stage = "intelligent";
    } else if (intelRoll < 0.01 * habitability) {
      // Civilizations come and go. Some worlds show evidence of intelligence
      // that's no longer present.
      stage = rng() < 0.5 ? "post_civilization" : "complex";
    } else {
      stage = habitability > 0.5 ? "complex" : "microbial";
    }
  }

  return { stage, biosphereAgeGyr: biosphereAge, habitability };
}

// ── Atmosphere & greenhouse ────────────────────────────────────────────
//
// Two regimes:
//
//   1. Primary atmosphere — body retained its H/He envelope. The
//      atmosphere IS the envelope; composition is H/He with traces from
//      formation ice/refractory inventory. Greenhouse forcing is modest
//      in the conventional sense but the body's interior holds an
//      enormous heat reservoir (already in internalHeatFlux).
//
//   2. Secondary atmosphere — body has little/no H/He. Outgassing from
//      tectonics builds the atmosphere from refractory volatiles (CO2)
//      and ice (water vapor). Loss mechanisms (Jeans escape, hydrodynamic
//      escape, stellar wind) reduce mass over time. Balance determines
//      current pressure.
//
// Calibration points (effective greenhouse boost in K):
//   Mercury: 0    (no atmosphere)
//   Venus:   +500 (runaway CO2)
//   Earth:   +33  (Earth's real greenhouse — N2/O2/H2O/CO2)
//   Mars:    +5   (thin CO2)
//   Titan:   +10  (N2 + CH4)
//   Jupiter: N/A  (greenhouse not meaningful for envelope-dominated bodies)

function computeAtmosphere(
  b: Body,
  state: BodyState,
  parent: ParentContext,
  tectonicActivity: number,
): Atmosphere {
  // Stars: no atmosphere model.
  if (state.fusionMode !== "none") return emptyAtmosphere();

  // H/He envelope fraction is continuous. Past ~5% by mass the body
  // behaves as a gas giant; below it as a secondary-atmosphere rocky
  // body. We compute both and blend across the boundary to avoid a
  // visible step in characteristics for borderline mini-Neptunes.
  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  const wPrimary = smoothstep(hheFrac, 0.03, 0.10);

  // Tiny bodies retain nothing. Smooth ramp so a 0.04 vs 0.06 M_earth
  // mass doesn't switch on/off — both produce wisps that may or may not
  // be visible.
  const retentionMass = smoothstep(state.totalMass, 0.03, 0.10);
  if (wPrimary < 0.001 && retentionMass < 0.001) return emptyAtmosphere();

  // Compute both regimes and blend by wPrimary. Below the threshold,
  // primary contribution is multiplied by ~0 so the secondary dominates.
  const secondary = secondaryRegimeMix(b, state, parent, tectonicActivity);
  const primary = primaryRegimeMix(state);

  // Blend the regime weight maps. Weights for primary regimes
  // (h_he_*) get scaled by wPrimary; weights for secondary regimes
  // (trace/n2/thick) by (1 - wPrimary). All weights are then re-mixed
  // by `blendAtmosphereFromWeights` into final continuous outputs.
  const weights: Partial<Record<RegimeKey, number>> = {};
  const wSec = 1 - wPrimary;
  for (const [k, v] of Object.entries(secondary.weights) as [RegimeKey, number][]) {
    weights[k] = (weights[k] ?? 0) + v * wSec * retentionMass;
  }
  for (const [k, v] of Object.entries(primary.weights) as [RegimeKey, number][]) {
    weights[k] = (weights[k] ?? 0) + v * wPrimary;
  }

  // Blend mass + pressure + coverage as scalars from each branch
  // (primary's pressure dwarfs secondary's so wPrimary effectively
  // controls "do we have a gas-giant envelope").
  const massEarth = secondary.massEarth * wSec * retentionMass + primary.massEarth * wPrimary;
  const surfacePressureBar = secondary.surfacePressureBar * wSec * retentionMass
    + primary.surfacePressureBar * wPrimary;
  const coverage = clamp01(
    secondary.cloudCoverage * wSec * retentionMass + primary.cloudCoverage * wPrimary,
  );

  if (massEarth < 1e-12) return emptyAtmosphere();

  return blendAtmosphereFromWeights({
    weights,
    massEarth,
    surfacePressureBar,
    cloudCoverage: coverage,
    surfaceGravityG: state.totalMass / Math.max(0.001, state.radius * state.radius),
    surfaceTempK: state.surfaceTemp,
  });
}

function emptyAtmosphere(): Atmosphere {
  return {
    massEarth: 0,
    surfacePressureBar: 0,
    composition: "none",
    greenhouseDeltaK: 0,
    cloudType: "none",
    cloudCoverage: 0,
    cloudBaseAltitudeKm: 0,
    cloudThicknessKm: 0,
    visibilityKm: 0,
    atmosphereTopKm: 0,
    // No atmosphere → black sky at all viewing angles. Lunar / Mercury.
    skyZenithColor: new THREE.Color(0, 0, 0),
    skyHorizonColor: new THREE.Color(0, 0, 0),
  };
}

// ── Regime mix model ───────────────────────────────────────────────────
//
// Every atmosphere is a continuous mix of named regimes. Each regime is
// a prototype: a recipe for one corner of "atmosphere phase space."
// Real bodies live at some weighted blend of these corners — there are
// no boundaries, just regions where one prototype dominates the mix.
//
// Mars-like + Earth-like + cold-icy is a thin atmosphere with a hint of
// water clouds; Earth + Venus blends produce muggy super-Earths with
// patchy haze. Coverage, sky color, cloud height, visibility, scale
// height, μ are all computed as weighted averages across the mix, then
// the regime with the largest weight is reported as the categorical
// `composition`/`cloudType` tag for downstream code that needs a name.

type RegimeKey =
  | "mars"        // thin CO2 dusty (trace_co2 / no clouds)
  | "earth"       // N2-CO2 + water clouds + carbon cycle
  | "venus"       // thick CO2 + sulfuric acid haze (runaway)
  | "cold_dry"    // freeze-out (trace_co2 + co2 ice)
  | "titan"       // N2-CH4 + organic haze
  | "warm_giant"  // H/He + water deck
  | "jovian"      // H/He + ammonia deck
  | "ice_giant"   // H/He + methane (Uranus/Neptune)
  | "hot_jovian"; // H/He + silicate-iron clouds

interface RegimePrototype {
  composition: AtmosphereComposition;
  cloudType: CloudType;
  /** Coverage anchor 0..1; final coverage is weighted-blended across mix
   *  then nudged by tectonic activity outside this table. */
  cloudCoverage: number;
  /** Cloud-deck base altitude above the body's nominal surface, in km. */
  cloudBaseKm: number;
  cloudThickKm: number;
  /** Mean molecular weight (amu) — drives scale height. */
  muAmu: number;
  /** CO2-cycle sink factor for outgassed mass. 1.0 = no sink, 0.005 = Earth. */
  sinkFactor: number;
  /** Greenhouse plateau (K) and characteristic pressure (bar). */
  ghMaxK: number;
  ghScaleBar: number;
  /** Typical clear-air visibility (km) at the regime's anchor pressure. */
  visibilityKm: number;
  /** Visible "top" anchor (km) — overridden by 5 × scaleHeight when larger. */
  topAnchorKm: number;
  /** Daytime sky colors at the surface (zenith and horizon). */
  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  /** Cloud albedo color — same palette as computeSurfaceColor below. */
  cloudColor: THREE.Color;
}

const REGIMES: Record<RegimeKey, RegimePrototype> = {
  mars: {
    composition: "trace_co2", cloudType: "none",
    cloudCoverage: 0.05, cloudBaseKm: 12, cloudThickKm: 8,
    muAmu: 44, sinkFactor: 0.5, ghMaxK: 5, ghScaleBar: 0.01,
    visibilityKm: 80, topAnchorKm: 80,
    // Butterscotch zenith from forward-scattering off suspended iron-
    // oxide dust; blue horizon (the famous Mars-sunset effect).
    skyZenith: new THREE.Color(0.78, 0.62, 0.50),
    skyHorizon: new THREE.Color(0.50, 0.55, 0.65),
    cloudColor: new THREE.Color(0.85, 0.83, 0.82),
  },
  earth: {
    composition: "n2_co2", cloudType: "water",
    cloudCoverage: 0.55, cloudBaseKm: 2, cloudThickKm: 5,
    muAmu: 29, sinkFactor: 0.005, ghMaxK: 33, ghScaleBar: 0.5,
    visibilityKm: 200, topAnchorKm: 80,
    skyZenith: new THREE.Color(0.30, 0.50, 0.85),
    skyHorizon: new THREE.Color(0.78, 0.83, 0.92),
    cloudColor: new THREE.Color(0.95, 0.95, 0.97),
  },
  venus: {
    composition: "thick_co2", cloudType: "sulfuric_acid",
    cloudCoverage: 1.0, cloudBaseKm: 45, cloudThickKm: 25,
    muAmu: 44, sinkFactor: 1.0, ghMaxK: 500, ghScaleBar: 30,
    visibilityKm: 4, topAnchorKm: 250,
    // Venus reads as dim sulfur-orange even at noon — sulfuric clouds
    // scatter yellow forward, blue is absorbed by CO2.
    skyZenith: new THREE.Color(0.78, 0.55, 0.30),
    skyHorizon: new THREE.Color(0.90, 0.70, 0.45),
    cloudColor: new THREE.Color(0.92, 0.85, 0.70),
  },
  cold_dry: {
    composition: "trace_co2", cloudType: "co2_ice",
    cloudCoverage: 0.15, cloudBaseKm: 12, cloudThickKm: 6,
    muAmu: 44, sinkFactor: 0.3, ghMaxK: 4, ghScaleBar: 0.05,
    visibilityKm: 60, topAnchorKm: 60,
    // Near-black with a faint cold tint — thin atmosphere can't scatter
    // much, so the daytime sky reads almost like the void.
    skyZenith: new THREE.Color(0.20, 0.25, 0.35),
    skyHorizon: new THREE.Color(0.35, 0.40, 0.50),
    cloudColor: new THREE.Color(0.85, 0.85, 0.88),
  },
  titan: {
    composition: "n2_co2", cloudType: "methane",
    cloudCoverage: 0.6, cloudBaseKm: 10, cloudThickKm: 15,
    muAmu: 28, sinkFactor: 0.05, ghMaxK: 12, ghScaleBar: 0.5,
    visibilityKm: 25, topAnchorKm: 600,
    // Tholin haze — solid orange-brown smog. Surface lighting is dim,
    // the whole sky reads as a warm dirty orange.
    skyZenith: new THREE.Color(0.72, 0.52, 0.28),
    skyHorizon: new THREE.Color(0.82, 0.65, 0.40),
    cloudColor: new THREE.Color(0.78, 0.62, 0.42),
  },
  warm_giant: {
    composition: "h_he", cloudType: "water",
    cloudCoverage: 0.9, cloudBaseKm: 0, cloudThickKm: 30,
    muAmu: 2.3, sinkFactor: 1.0, ghMaxK: 0, ghScaleBar: 1,
    visibilityKm: 30, topAnchorKm: 200,
    skyZenith: new THREE.Color(0.40, 0.55, 0.85),
    skyHorizon: new THREE.Color(0.80, 0.85, 0.95),
    cloudColor: new THREE.Color(0.95, 0.95, 0.97),
  },
  jovian: {
    composition: "h_he_ammonia", cloudType: "ammonia",
    cloudCoverage: 0.85, cloudBaseKm: 0, cloudThickKm: 50,
    muAmu: 2.3, sinkFactor: 1.0, ghMaxK: 0, ghScaleBar: 1,
    visibilityKm: 25, topAnchorKm: 250,
    skyZenith: new THREE.Color(0.40, 0.55, 0.85),
    skyHorizon: new THREE.Color(0.86, 0.78, 0.66),
    cloudColor: new THREE.Color(0.86, 0.78, 0.66),
  },
  ice_giant: {
    composition: "h_he_methane", cloudType: "methane",
    cloudCoverage: 0.6, cloudBaseKm: 50, cloudThickKm: 100,
    muAmu: 2.5, sinkFactor: 1.0, ghMaxK: 0, ghScaleBar: 1,
    visibilityKm: 50, topAnchorKm: 400,
    // Methane absorbs red strongly → pale cyan sky (Uranus/Neptune).
    skyZenith: new THREE.Color(0.30, 0.55, 0.75),
    skyHorizon: new THREE.Color(0.55, 0.70, 0.80),
    cloudColor: new THREE.Color(0.62, 0.78, 0.88),
  },
  hot_jovian: {
    composition: "h_he", cloudType: "iron_silicate",
    cloudCoverage: 0.95, cloudBaseKm: 1000, cloudThickKm: 500,
    muAmu: 2.3, sinkFactor: 1.0, ghMaxK: 0, ghScaleBar: 1,
    visibilityKm: 10, topAnchorKm: 2000,
    // Silicate haze reads as a smoky brown-orange.
    skyZenith: new THREE.Color(0.55, 0.32, 0.20),
    skyHorizon: new THREE.Color(0.75, 0.50, 0.30),
    cloudColor: new THREE.Color(0.65, 0.45, 0.35),
  },
};

/** Smooth-blend output of a regime computation: weights + the scalar
 *  per-branch inputs needed to assemble the final Atmosphere. */
interface RegimeMix {
  weights: Partial<Record<RegimeKey, number>>;
  /** Atmospheric mass contributed by this branch (M_earth). */
  massEarth: number;
  /** Surface pressure contributed by this branch (bar). */
  surfacePressureBar: number;
  /** Cloud coverage contributed by this branch (0..1). */
  cloudCoverage: number;
}

function secondaryRegimeMix(
  b: Body,
  state: BodyState,
  parent: ParentContext,
  tectonicActivity: number,
): RegimeMix {
  const age = Math.max(0.01, state.ageGyr);
  const massE = state.totalMass;
  const radiusE = state.radius;
  const g = massE / Math.max(0.001, radiusE * radiusE);

  // Outgassing budget. Earth calibration: refr=1, activity=0.8, age=4.6
  // → ~4e-4 M_earth.
  const outgasMass = 5e-4 * b.formationRefractory
    * tectonicActivity * Math.sqrt(age / 4.5);
  const escapeProxy = Math.sqrt(massE / Math.max(0.01, radiusE));
  const thermalRetention = 1 - Math.exp(-Math.pow(escapeProxy, 6));
  const xuvProxy = parent.luminosity / Math.max(0.01, Math.pow(b.formationSemiMajor, 2));
  const windRetention = Math.exp(-xuvProxy / 2);
  const retention = thermalRetention * windRetention;
  const baseAtmMass = outgasMass * retention;

  const stellarFlux = parent.luminosity / Math.max(0.01, Math.pow(b.formationSemiMajor, 2));
  const iceFrac = b.formationIce / Math.max(1e-9, massE);
  const T_eq = state.surfaceTemp;

  // ── Continuous regime weights ────────────────────────────────────────
  //
  // Each weight in [0,1]. Inputs that gate a regime use smoothstep so
  // adjacent bodies blur between regimes rather than snapping.

  // Venus-class: insolation > 1 S_earth, low water, significant outgassing.
  // Tectonic activity boosts because SO2 production (the source of the
  // sulfuric cloud deck) is volcanic.
  //
  // Dry-threshold note: previously (0.001, 0.01) — but the `computeLife`
  // waterFactor thresholds in this same file treat iceFrac > 0.0005 as
  // "Earth-class wet". The Venus classifier left Earth (iceFrac 0.003)
  // sitting at wRunawayDry ≈ 0.87, which gave Venus enough weight to
  // win argmax over Earth → Earth got Venus's sulfuric-acid clouds at
  // 28 km. Tightened to (0.0001, 0.001) so Earth-class water reads as
  // fully wet for the Venus exclusion too. Mars / Mercury remain
  // correctly dry; Venus itself (iceFrac 0) stays at wDry = 1.
  const wRunawayInsol = smoothstep(stellarFlux, 0.9, 1.3);
  const wRunawayDry = 1 - smoothstep(iceFrac, 0.0001, 0.001);
  const wRunawayMass = smoothstep(baseAtmMass, 1e-8, 1e-6);
  const wVenus = wRunawayInsol * wRunawayDry * wRunawayMass
    * (0.5 + 0.5 * tectonicActivity);

  // Earth-class: liquid water + temperate. Strong gate on water,
  // smoother T window from 200..360 K.
  const wWaterAvail = smoothstep(iceFrac, 0.00005, 0.0005);
  const wTempLiquid = smoothstep(T_eq, 200, 250) * (1 - smoothstep(T_eq, 320, 360));
  const wEarth = wWaterAvail * wTempLiquid * (1 - wVenus);

  // Titan-class: cold N2/CH4 with organic haze. T window 60–120 K,
  // requires nontrivial atmosphere mass (so an icy moon with negligible
  // outgassing doesn't qualify).
  const wTitanT = smoothstep(T_eq, 60, 90) * (1 - smoothstep(T_eq, 110, 140));
  const wTitanMass = smoothstep(baseAtmMass, 1e-9, 1e-7);
  const wTitan = wTitanT * wTitanMass * wWaterAvail;

  // Cold-dry: frozen body with thin CO2. T < 200 K, low water.
  const wColdT = 1 - smoothstep(T_eq, 180, 240);
  const wColdDry = wColdT * (1 - wTitan) * (1 - wEarth);

  // Mars-class: everything that doesn't fit elsewhere. Default fill.
  let wMars = 1 - (wVenus + wEarth + wTitan + wColdDry);
  if (wMars < 0) wMars = 0;

  // Normalize so all weights sum to 1.
  const total = wVenus + wEarth + wTitan + wColdDry + wMars;
  const norm = total > 1e-6 ? 1 / total : 0;
  const w = {
    mars: wMars * norm,
    earth: wEarth * norm,
    venus: wVenus * norm,
    cold_dry: wColdDry * norm,
    titan: wTitan * norm,
  };

  // Coverage anchor blended from prototypes, with tectonic activity
  // adding extra cumulus + volcanic-aerosol haze on active worlds.
  let coverage = 0;
  let sinkFactor = 0;
  for (const k of ["mars", "earth", "venus", "cold_dry", "titan"] as const) {
    const wk = w[k] ?? 0;
    coverage += wk * REGIMES[k].cloudCoverage;
    sinkFactor += wk * REGIMES[k].sinkFactor;
  }
  // Volcanic moisture/SO2 increase coverage on tectonically active worlds.
  coverage = clamp01(coverage + 0.15 * tectonicActivity * (w.earth + w.venus));

  const atmMassE = baseAtmMass * sinkFactor;
  const surfacePressureBar = (atmMassE * g / Math.max(0.01, radiusE * radiusE)) * 1.15e6;

  return {
    weights: w,
    massEarth: atmMassE,
    surfacePressureBar,
    cloudCoverage: coverage,
  };
}

function primaryRegimeMix(state: BodyState): RegimeMix {
  const T = state.surfaceTemp;

  // Smooth weights across the four gas-giant prototypes. The temperature
  // bands overlap so a planet at 150 K sits between jovian and ice_giant.
  const wIce = 1 - smoothstep(T, 90, 130);
  const wJovianBand = smoothstep(T, 100, 140) * (1 - smoothstep(T, 200, 300));
  const wWarmBand = smoothstep(T, 250, 350) * (1 - smoothstep(T, 700, 900));
  const wHotBand = smoothstep(T, 700, 1000);

  let wSum = wIce + wJovianBand + wWarmBand + wHotBand;
  if (wSum < 1e-6) {
    // Fallback for extremely cold bodies — pure ice-giant regime.
    return {
      weights: { ice_giant: 1 },
      massEarth: state.currentHHe,
      surfacePressureBar: 1e5,
      cloudCoverage: REGIMES.ice_giant.cloudCoverage,
    };
  }
  const inv = 1 / wSum;
  const w: Partial<Record<RegimeKey, number>> = {
    ice_giant: wIce * inv,
    jovian: wJovianBand * inv,
    warm_giant: wWarmBand * inv,
    hot_jovian: wHotBand * inv,
  };

  let coverage = 0;
  for (const k of ["ice_giant", "jovian", "warm_giant", "hot_jovian"] as const) {
    coverage += (w[k] ?? 0) * REGIMES[k].cloudCoverage;
  }

  return {
    weights: w,
    massEarth: state.currentHHe,
    surfacePressureBar: 1e5,
    cloudCoverage: coverage,
  };
}

interface BlendInputs {
  weights: Partial<Record<RegimeKey, number>>;
  massEarth: number;
  surfacePressureBar: number;
  cloudCoverage: number;
  surfaceGravityG: number;
  surfaceTempK: number;
}

function blendAtmosphereFromWeights(inputs: BlendInputs): Atmosphere {
  const { weights, massEarth, surfacePressureBar, cloudCoverage } = inputs;
  const keys = Object.keys(weights) as RegimeKey[];

  // Normalize the weight map. The two branches multiplied by wPrimary /
  // wSec / retentionMass produce a total < 1 when the body has very
  // little envelope OR is on the edge of mass retention; re-normalize so
  // all downstream blends use proper convex combinations.
  let total = 0;
  for (const k of keys) total += weights[k] ?? 0;
  const inv = total > 1e-6 ? 1 / total : 0;

  // Blended scalars and colors.
  let muAmu = 0;
  let cloudBaseKm = 0;
  let cloudThickKm = 0;
  let visibilityKm = 0;
  let topAnchorKm = 0;
  let ghMaxK = 0;
  let ghScaleBar = 0;
  const zenith = new THREE.Color(0, 0, 0);
  const horizon = new THREE.Color(0, 0, 0);
  const cloudColor = new THREE.Color(0, 0, 0);

  for (const k of keys) {
    const wk = (weights[k] ?? 0) * inv;
    if (wk <= 0) continue;
    const r = REGIMES[k];
    muAmu += wk * r.muAmu;
    cloudBaseKm += wk * r.cloudBaseKm;
    cloudThickKm += wk * r.cloudThickKm;
    visibilityKm += wk * r.visibilityKm;
    topAnchorKm += wk * r.topAnchorKm;
    ghMaxK += wk * r.ghMaxK;
    ghScaleBar += wk * r.ghScaleBar;
    zenith.r += wk * r.skyZenith.r; zenith.g += wk * r.skyZenith.g; zenith.b += wk * r.skyZenith.b;
    horizon.r += wk * r.skyHorizon.r; horizon.g += wk * r.skyHorizon.g; horizon.b += wk * r.skyHorizon.b;
    cloudColor.r += wk * r.cloudColor.r; cloudColor.g += wk * r.cloudColor.g; cloudColor.b += wk * r.cloudColor.b;
  }

  // Pick the dominant regime as the categorical tag. Downstream code
  // (palette selection, surface color) takes a single name; we hand it
  // the argmax of the mix. Visual outputs still come from the blend.
  let argmaxKey: RegimeKey = "mars";
  let argmaxW = -1;
  for (const k of keys) {
    const wk = weights[k] ?? 0;
    if (wk > argmaxW) { argmaxW = wk; argmaxKey = k; }
  }
  const dominant = REGIMES[argmaxKey];

  // Greenhouse forcing — exponential saturation to the blended plateau.
  let greenhouseDeltaK = 0;
  if (ghMaxK > 0 && ghScaleBar > 0 && surfacePressureBar > 0) {
    greenhouseDeltaK = ghMaxK * (1 - Math.exp(-surfacePressureBar / ghScaleBar));
  }
  const effT = inputs.surfaceTempK + greenhouseDeltaK;

  // Scale height H = k_B T / (μ g_SI), in km. Use the blended μ.
  const kB = 1.380649e-23;
  const muKg = Math.max(2, muAmu) * 1.66053906660e-27;
  const gSi = Math.max(0.01, inputs.surfaceGravityG) * 9.81;
  const scaleHeightKm = (kB * effT) / (muKg * gSi) / 1000;
  const atmosphereTopKm = Math.max(topAnchorKm, 5 * scaleHeightKm);

  // Pressure-modulated visibility: thicker atmospheres scatter more,
  // dropping visible range. Earth at 0.3 bar (Mt. Everest) sees farther
  // than at 1 bar; Venus at 90 bar sees nothing.
  if (surfacePressureBar > 0.5) {
    visibilityKm /= Math.sqrt(surfacePressureBar);
  }
  visibilityKm = Math.max(2, visibilityKm);

  // Cloud overcast desaturates both sky colors toward the cloud's
  // albedo — standing under a thick deck (Venus, Earth on a cloudy day),
  // the sky takes on the cloud color rather than the clear-air tint.
  // 60% of coverage so even fully overcast retains some compositional hint.
  if (cloudCoverage > 0.01) {
    const t = cloudCoverage * 0.6;
    zenith.lerp(cloudColor, t);
    horizon.lerp(cloudColor, t);
  }

  return {
    massEarth,
    surfacePressureBar,
    composition: dominant.composition,
    greenhouseDeltaK,
    cloudType: dominant.cloudType,
    cloudCoverage,
    cloudBaseAltitudeKm: Math.max(0, cloudBaseKm),
    cloudThicknessKm: Math.max(0, cloudThickKm),
    visibilityKm,
    atmosphereTopKm: Math.max(10, atmosphereTopKm),
    skyZenithColor: zenith,
    skyHorizonColor: horizon,
  };
}

// ── Numeric helpers ────────────────────────────────────────────────────

function smoothstep(x: number, edge0: number, edge1: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ── Terrain ────────────────────────────────────────────────────────────
//
// Max sustainable mountain height is set by isostasy + crustal strength,
// roughly proportional to 1/g. Earth (g=9.8 m/s²) supports ~9 km
// (Everest); Mars (g=3.7) supports ~22 km (Olympus Mons); the Moon (g=1.6)
// supports ~10 km but topography is limited by formation/age, not
// strength. Active tectonics generate ongoing relief but also erosion;
// stagnant-lid bodies can build single tall volcanoes over Gyr.
//
// "Roughness" is a qualitative scalar useful for shader displacement
// scaling: high for active rocky bodies and tidally-heated icy moons;
// low for smooth featureless surfaces (Europa-like) and any gas-giant
// "surface" (which is just the visible cloud deck).

function computeTerrain(
  b: Body,
  state: BodyState,
  tectonicActivity: number,
): Terrain {
  if (state.fusionMode !== "none") {
    // Stars — concept doesn't apply.
    return { surfaceGravityG: 0, maxReliefKm: 0, typicalReliefKm: 0, roughness: 0 };
  }

  const radiusE = Math.max(0.001, state.radius);
  const surfaceGravityG = state.totalMass / (radiusE * radiusE);

  // Gas-giants and ice-giants have no surface. Return null-equivalent.
  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  if (hheFrac > 0.1) {
    return { surfaceGravityG, maxReliefKm: 0, typicalReliefKm: 0, roughness: 0 };
  }

  // Max sustainable mountain height scales as 1/g, calibrated against
  // Earth (g=1, max=9 km) and Mars (g=0.38, max=22 km). The 1/g^1.1
  // exponent fits both anchor points slightly better than 1/g.
  const baseMaxKm = 9 / Math.pow(surfaceGravityG, 1.1);

  // Tectonic activity modulates achievable relief:
  //   - High activity (Earth-like): relief built by uplift, eroded by water/wind.
  //     Achievable relief ~80% of theoretical max.
  //   - Low activity (Mars-like): stagnant lid + low erosion → single
  //     volcanoes can grow to theoretical max. ~100%.
  //   - Zero activity (Mercury-like): no fresh relief; only impact basins +
  //     primordial features. Achievable ~50%.
  let activityMod: number;
  if (tectonicActivity > 0.6) activityMod = 0.8;
  else if (tectonicActivity > 0.2) activityMod = 1.0;
  else activityMod = 0.5;
  const maxReliefKm = baseMaxKm * activityMod;

  // Typical relief — the "background" mountain range height, much less
  // than the extremes. Earth typical: ~2-3 km.
  const typicalReliefKm = maxReliefKm * 0.25;

  // Roughness: combines tectonic activity, age effects (older = more
  // impact craters = rougher), and composition (icy = smoother due to
  // viscous relaxation over time, unless tidally heated).
  let roughness = 0.4 + 0.5 * tectonicActivity;
  const isIcyDominated = b.formationIce > 1.5 * b.formationRefractory;
  if (isIcyDominated) {
    // Icy bodies relax viscously — smoother unless actively heated.
    roughness *= (tectonicActivity > 0.3 ? 1.0 : 0.4);
  }
  roughness = Math.min(1, Math.max(0, roughness));

  return { surfaceGravityG, maxReliefKm, typicalReliefKm, roughness };
}

// ── Surface color ──────────────────────────────────────────────────────
//
// What the body looks like from outside. Three contributions:
//   - Surface composition (rocky bodies without atmosphere)
//   - Cloud layer (bodies with thick atmosphere — cloud color dominates)
//   - Atmospheric absorption (methane → blue, etc. for translucent atmospheres)
//
// Colors are calibrated to REAL appearances (NASA imagery without
// saturation boosting). The famous "deep blue Neptune" of pre-2024
// imagery was a processing artifact; Neptune is actually pale cyan like
// Uranus. Mars is butterscotch/peach rather than deep red.

const COLOR_REFRACTORY_DARK = new THREE.Color(0.42, 0.40, 0.38);   // Mercury — basalt regolith
const COLOR_REFRACTORY_FE   = new THREE.Color(0.55, 0.42, 0.32);   // iron-rich (Mercury core anomaly)
const COLOR_RUST            = new THREE.Color(0.76, 0.56, 0.40);   // Mars — oxidized iron dust
const COLOR_ICE_PURE        = new THREE.Color(0.92, 0.94, 0.96);   // pure water ice (Europa)
const COLOR_ICE_DIRTY       = new THREE.Color(0.78, 0.75, 0.70);   // dust-laden ice (Callisto)
const COLOR_OCEAN           = new THREE.Color(0.20, 0.40, 0.65);   // open water
const COLOR_LAND            = new THREE.Color(0.40, 0.38, 0.30);   // continental average

const COLOR_CLOUD_WATER     = new THREE.Color(0.95, 0.95, 0.97);   // pure water cloud
const COLOR_CLOUD_SULFURIC  = new THREE.Color(0.92, 0.85, 0.70);   // Venus pale cream
const COLOR_CLOUD_AMMONIA   = new THREE.Color(0.86, 0.78, 0.66);   // Jupiter/Saturn tan
const COLOR_CLOUD_METHANE   = new THREE.Color(0.62, 0.78, 0.88);   // Uranus/Neptune pale cyan
const COLOR_CLOUD_CO2_ICE   = new THREE.Color(0.85, 0.83, 0.82);   // Mars polar caps
const COLOR_CLOUD_HOT_HAZE  = new THREE.Color(0.65, 0.45, 0.35);   // hot Jupiter silicate haze

function lerpColor(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return new THREE.Color(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

function computeSurfaceColor(
  b: Body,
  state: BodyState,
  atm: Atmosphere,
  effectiveTempK: number,
): THREE.Color {
  // Stars/remnants — use the existing state.color (blackbody-derived).
  if (state.fusionMode === "hydrogen"
      || state.fusionMode === "deuterium_done"
      || state.fusionMode === "remnant") {
    return state.color.clone();
  }

  // Envelope-dominated bodies — cloud-deck color dominates, methane/
  // ammonia absorption gives the body its character.
  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  if (hheFrac > 0.1) {
    switch (atm.cloudType) {
      case "methane":       return COLOR_CLOUD_METHANE.clone();
      case "ammonia":       return COLOR_CLOUD_AMMONIA.clone();
      case "water":         return COLOR_CLOUD_WATER.clone();
      case "iron_silicate": return COLOR_CLOUD_HOT_HAZE.clone();
      default:              return COLOR_CLOUD_AMMONIA.clone();
    }
  }

  // Rocky / icy body. Determine SURFACE color first, then blend with
  // cloud color according to cloud coverage and atmospheric opacity.
  let surface: THREE.Color;

  const ironRich = b.refractoryDensityFactor > 1.3;
  const isIcyDominated = b.formationIce > 1.5 * b.formationRefractory;
  const hasOceans = effectiveTempK >= 273 && effectiveTempK <= 373
    && b.formationIce / Math.max(1e-9, state.totalMass) > 0.0001;
  const veryHot = effectiveTempK > 700;

  if (veryHot) {
    // Lava/molten surface; tied to blackbody emission.
    return state.color.clone();
  } else if (hasOceans && !isIcyDominated) {
    // Earth-class — blend ocean + land based on assumed coverage.
    // For a Body with water + temperate climate + significant atmosphere,
    // ocean cover is ~70%.
    surface = lerpColor(COLOR_LAND, COLOR_OCEAN, 0.7);
  } else if (isIcyDominated) {
    // Frozen surface. Dust contamination ranges with age + impact history.
    const dustyness = Math.min(1, state.ageGyr / 8);
    surface = lerpColor(COLOR_ICE_PURE, COLOR_ICE_DIRTY, dustyness);
  } else if (ironRich) {
    surface = COLOR_REFRACTORY_FE.clone();
  } else {
    // Default rocky — modulate by temperature/oxidation:
    //   - Cool (200-400 K) bodies with traces of oxygen become rusty (Mars)
    //   - Hotter dry bodies stay basalt-gray (Mercury)
    //   - Very hot bodies → covered above
    if (effectiveTempK > 180 && effectiveTempK < 320) {
      surface = COLOR_RUST.clone();
    } else {
      surface = COLOR_REFRACTORY_DARK.clone();
    }
  }

  // Apply cloud layer. Clouds occlude surface in proportion to coverage
  // × opacity; we use cloudCoverage directly as the blend factor for the
  // visible disk-averaged color.
  if (atm.cloudType !== "none" && atm.cloudCoverage > 0.01) {
    let cloudColor: THREE.Color;
    switch (atm.cloudType) {
      case "water":         cloudColor = COLOR_CLOUD_WATER;     break;
      case "sulfuric_acid": cloudColor = COLOR_CLOUD_SULFURIC;  break;
      case "ammonia":       cloudColor = COLOR_CLOUD_AMMONIA;   break;
      case "methane":       cloudColor = COLOR_CLOUD_METHANE;   break;
      case "co2_ice":       cloudColor = COLOR_CLOUD_CO2_ICE;   break;
      case "iron_silicate": cloudColor = COLOR_CLOUD_HOT_HAZE;  break;
      default:              cloudColor = COLOR_CLOUD_WATER;
    }
    surface = lerpColor(surface, cloudColor, atm.cloudCoverage);
  }

  return surface;
}