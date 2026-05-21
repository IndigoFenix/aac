import * as THREE from "three";
import { createNoise3D } from "simplex-noise";
import { mulberry32 } from "./galaxy";
import type { Atmosphere } from "./physics-system/features";

// Cloud density field — a pure function of (position, time, seed) defined in
// planet-local Cartesian coordinates (meters from planet center).
//
// The field is the authority on what a cloud IS at every point in the
// atmosphere; the renderer (cloud-system.ts) samples it at cell centers
// to decide what to draw. Storms, banding, and drift are all contributions
// to the field — no objects materialize, no state evolves.
//
// Convention: planet-local +Y is the rotation axis. Latitude derives from
// dot(localPos.normalized, +Y). Eastward direction at a point is
// cross(+Y, localPos.normalized).
//
// Banding physics: gas-giant zones (bright) and belts (dark) are the
// surface signatures of latitudinal Hadley-like circulation cells —
// rising air carries top-of-atmosphere chemistry to view (zones); sinking
// air clears the high deck and exposes deeper, darker layers (belts).
// Zonal jet streams are strongest at the boundaries between cells, where
// vertical velocity crosses zero. One `circulation` parameter drives all
// three visual effects (density modulation, color shift, wind drift).

// ── Universal cell sizes ───────────────────────────────────────────────────
//
// Constant across all bodies — a 200 m puff on Earth and a 200 m puff on
// Jupiter render identically. Giant planets activate additional outer tiers
// rather than scaling the cells up. The /5 cap in `activeCloudTiers`
// prevents individual cells from spanning more than ~20° of arc.

export const CLOUD_CELL_SIZES_M = [200, 2000, 20000, 200000, 2000000] as const;

/** Tiers a body of `planetRadiusM` activates — contiguous prefix of
 *  CLOUD_CELL_SIZES_M capped so no cell spans >20° of arc. Always returns
 *  at least the smallest tier so airless bodies (with no field) still
 *  return a valid array. */
export function activeCloudTiers(planetRadiusM: number): number[] {
  const maxCell = planetRadiusM / 5;
  const tiers: number[] = [];
  for (let i = 0; i < CLOUD_CELL_SIZES_M.length; i++) {
    if (CLOUD_CELL_SIZES_M[i] <= maxCell) tiers.push(i);
  }
  if (tiers.length === 0) tiers.push(0);
  return tiers;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CloudLayer {
  /** Inner altitude above planet surface (meters). */
  baseAltitudeM: number;
  /** Outer altitude above planet surface (meters). */
  topAltitudeM: number;
  /** 0..1 — controls noise threshold. Higher = more cloud. */
  coverage: number;
  /** 0..1 — peak opacity multiplier inside this layer. */
  density: number;
  /** Tint where air is rising (zones — top-of-atmosphere chemistry). */
  zoneColor: THREE.Color;
  /** Tint where air is sinking (belts — deeper, often darker). */
  beltColor: THREE.Color;
  /** Base horizontal noise wavelength (meters). FBM octaves go finer. */
  horizScaleM: number;
  /** Vertical noise wavelength (meters). */
  vertScaleM: number;
}

export interface CloudClump {
  /** Center in planet-local Cartesian (meters from planet center). */
  localPos: THREE.Vector3;
  /** Characteristic radius (meters). Density falls off as gaussian. */
  scaleM: number;
  /** Density contribution at center (0..1, may be summed with other clumps). */
  strength: number;
}

export interface CloudCirculation {
  /** Number of Hadley-like circulation cells per hemisphere. Earth ≈ 3
   *  (Hadley/Ferrel/Polar); Jupiter ≈ 8. */
  cellsPerHemisphere: number;
  /** 0..1 — how strongly circulation modulates density and color. */
  strength: number;
  /** Peak zonal jet speed at cell boundaries (m/s). */
  jetSpeedMs: number;
}

export interface CloudFieldParams {
  seed: number;
  planetRadiusM: number;
  layers: CloudLayer[];
  clumps: CloudClump[];
  circulation: CloudCirculation;
  /** Filled lazily by the sampler — do not set directly. */
  _noise?: NoiseFns;
}

export interface CloudSample {
  /** 0..1 — instantaneous cloud opacity at the sampled point. */
  density: number;
  /** Local tinted cloud color (already blended between zone/belt). */
  color: THREE.Color;
  /** Index of the layer contributing the dominant density, or -1. */
  layerIndex: number;
}

interface NoiseFns {
  base: (x: number, y: number, z: number) => number;
}

function ensureNoise(field: CloudFieldParams): NoiseFns {
  if (field._noise) return field._noise;
  const rng = mulberry32(field.seed);
  field._noise = { base: createNoise3D(rng) };
  return field._noise;
}

// ── Wind ───────────────────────────────────────────────────────────────────

const _crossUp = new THREE.Vector3(0, 1, 0);

/** Local wind vector at a position, planet-local frame (m/s).
 *
 *  Currently zonal-only: speed = -jetSpeedMs × sin(2N × lat), direction
 *  is the local "east" (cross(+Y, normalized localPos)). At cell
 *  boundaries (where vertical velocity = cos = 0) the wind is maximum;
 *  at zone/belt centers (cos = ±1) the wind is zero. Direction
 *  alternates between adjacent cells. */
export function windAtLocal(
  field: CloudFieldParams,
  localPos: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const len = localPos.length();
  if (len < 1) return out.set(0, 0, 0);
  const sinLat = THREE.MathUtils.clamp(localPos.y / len, -1, 1);
  const lat = Math.asin(sinLat);
  const N = Math.max(1, field.circulation.cellsPerHemisphere);
  const zonalSpeed = -field.circulation.jetSpeedMs * Math.sin(2 * N * lat);
  // East = +Y × radial. Result has zero y-component (drift is pure zonal).
  out.crossVectors(_crossUp, localPos);
  const eastLen = out.length();
  if (eastLen < 1e-6) return out.set(0, 0, 0);
  return out.multiplyScalar(zonalSpeed / eastLen);
}

// ── Sampler ────────────────────────────────────────────────────────────────

const _sampleWind = new THREE.Vector3();
const _samplePos = new THREE.Vector3();
const _zoneColor = new THREE.Color();
const _beltColor = new THREE.Color();

/** Sample the cloud field at (localPos, time). Out is filled (and returned)
 *  with density, color and which layer dominated. Cheap enough to call ~10 k
 *  times per frame — single simplex noise with 4 fbm octaves per layer. */
export function cloudDensityAt(
  field: CloudFieldParams,
  localPos: THREE.Vector3,
  timeSeconds: number,
  out?: CloudSample,
): CloudSample {
  const result = out ?? {
    density: 0,
    color: new THREE.Color(0, 0, 0),
    layerIndex: -1,
  };
  result.density = 0;
  result.color.setRGB(0, 0, 0);
  result.layerIndex = -1;
  if (field.layers.length === 0) return result;

  const radius = localPos.length();
  if (radius < 1) return result;
  const altitude = radius - field.planetRadiusM;
  const sinLat = THREE.MathUtils.clamp(localPos.y / radius, -1, 1);
  const lat = Math.asin(sinLat);

  // Circulation: cos(2N × lat). +1 = full rising (zone); -1 = full sinking
  // (belt). Modulates BOTH density and color.
  const N = Math.max(1, field.circulation.cellsPerHemisphere);
  const vertical = Math.cos(2 * N * lat);
  const circulationFactor = 1 + field.circulation.strength * vertical;
  const zoneT = (vertical + 1) * 0.5; // 0 = belt, 1 = zone

  // Wind drift: subtract wind × t from sample position. Wind is zonal-only
  // (y-component = 0) so altitude / latitude evaluated at localPos stay
  // valid for the drifted noise sample.
  windAtLocal(field, localPos, _sampleWind);
  _samplePos.copy(localPos).addScaledVector(_sampleWind, -timeSeconds);

  const noise = ensureNoise(field);

  let bestDensity = 0;
  for (let li = 0; li < field.layers.length; li++) {
    const layer = field.layers[li];
    if (altitude < layer.baseAltitudeM || altitude > layer.topAltitudeM) continue;
    // Vertical profile — sin curve peaks at mid-layer, zero at edges.
    // Avoids hard cutoffs at the inner / outer altitude.
    const altT = (altitude - layer.baseAltitudeM)
      / Math.max(1, layer.topAltitudeM - layer.baseAltitudeM);
    const altProfile = Math.sin(altT * Math.PI);

    // FBM with 4 octaves. Simplex noise returns -1..1; we sum and renormalize.
    let n = 0, amp = 1, totalAmp = 0;
    let fh = 1 / Math.max(1, layer.horizScaleM);
    let fv = 1 / Math.max(1, layer.vertScaleM);
    for (let o = 0; o < 4; o++) {
      n += amp * noise.base(_samplePos.x * fh, _samplePos.y * fv, _samplePos.z * fh);
      totalAmp += amp;
      amp *= 0.5;
      fh *= 2.07;
      fv *= 2.07;
    }
    const noiseN = (n / totalAmp + 1) * 0.5; // 0..1

    // Coverage threshold. coverage=1 → all noise passes; coverage=0 → none.
    const threshold = 1 - layer.coverage;
    const span = Math.max(0.05, 1 - threshold);
    let layerDensity = Math.max(0, (noiseN - threshold) / span);
    layerDensity *= altProfile * layer.density * circulationFactor;

    // Clump over-densities — gaussian contributions, modulated by altitude
    // profile so storms are vertically confined to the layer.
    for (let ci = 0; ci < field.clumps.length; ci++) {
      const c = field.clumps[ci];
      const dx = _samplePos.x - c.localPos.x;
      const dy = _samplePos.y - c.localPos.y;
      const dz = _samplePos.z - c.localPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const sigma2 = c.scaleM * c.scaleM;
      if (d2 < sigma2 * 9) {  // 3σ cutoff for cheapness
        layerDensity += c.strength * Math.exp(-d2 / (2 * sigma2)) * altProfile;
      }
    }
    if (layerDensity > 1) layerDensity = 1;
    if (layerDensity < 0) layerDensity = 0;

    if (layerDensity > bestDensity) {
      bestDensity = layerDensity;
      result.density = layerDensity;
      result.layerIndex = li;
      _zoneColor.copy(layer.zoneColor);
      _beltColor.copy(layer.beltColor);
      result.color.copy(_beltColor).lerp(_zoneColor, zoneT);
    }
  }
  return result;
}

// ── Derivation from Atmosphere ─────────────────────────────────────────────
//
// Maps the physics-system's regime-blended Atmosphere to a CloudFieldParams.
// The atmosphere already carries cloud base / thickness / coverage / colors;
// we add noise wavelengths per cloud type, derive circulation from band
// count + rotation, and emit one layer per body. Multi-layer setups (cumulus
// + cirrus, etc.) are reserved for later iterations.

export interface DeriveCloudFieldOpts {
  atmosphere: Atmosphere;
  planetRadiusM: number;
  /** features.atmosphericBandCount — visible bands when seen from space. */
  bandCount: number;
  /** features.atmosphericBanding — 0..1 banding intensity. */
  bandingIntensity: number;
  /** features.rotation.periodHours — absolute value used. */
  rotationPeriodHours: number;
  /** Per-body seed for noise + clump positions. */
  seed: number;
}

/** Picks a horizontal feature scale per cloud type. Hand-tuned so each
 *  regime reads visually distinct — water clouds are small puffs, ammonia
 *  bands are continent-scale, hot-Jupiter silicate haze is hemispheric. */
function pickHorizScaleM(cloudType: Atmosphere["cloudType"]): number {
  switch (cloudType) {
    case "water":          return 30_000;
    case "sulfuric_acid":  return 200_000;
    case "ammonia":        return 600_000;
    case "methane":        return 300_000;
    case "co2_ice":        return 80_000;
    case "iron_silicate":  return 1_500_000;
    default:               return 50_000;
  }
}

/** Tint where air is sinking. Darken the zone color and shift toward the
 *  warmer end — belts on Jupiter expose deeper, warmer chemistry. */
function deriveBeltColor(zone: THREE.Color): THREE.Color {
  const belt = zone.clone().multiplyScalar(0.7);
  // Push slightly red — sinking air shows hotter, redder chemistry below.
  belt.r = Math.min(1, belt.r * 1.1);
  belt.b *= 0.85;
  return belt;
}

export function deriveCloudField(opts: DeriveCloudFieldOpts): CloudFieldParams {
  const {
    atmosphere, planetRadiusM, bandCount, bandingIntensity,
    rotationPeriodHours, seed,
  } = opts;

  if (atmosphere.cloudType === "none" || atmosphere.cloudCoverage < 0.01) {
    return {
      seed,
      planetRadiusM,
      layers: [],
      clumps: [],
      circulation: { cellsPerHemisphere: 1, strength: 0, jetSpeedMs: 0 },
    };
  }

  const baseM = atmosphere.cloudBaseAltitudeKm * 1000;
  const thickM = Math.max(500, atmosphere.cloudThicknessKm * 1000);
  const zoneColor = atmosphere.skyZenithColor.clone();
  // Cloud colors in REGIMES are explicit — prefer them over skyZenith when
  // they meaningfully differ (sky tint may have been pushed by coverage in
  // the atmosphere blend). For V1 we use skyZenithColor as the bright top.
  const beltColor = deriveBeltColor(zoneColor);

  const horizScaleM = pickHorizScaleM(atmosphere.cloudType);
  const vertScaleM = Math.max(500, thickM * 0.6);

  const layer: CloudLayer = {
    baseAltitudeM: baseM,
    topAltitudeM: baseM + thickM,
    coverage: atmosphere.cloudCoverage,
    density: 1,
    zoneColor,
    beltColor,
    horizScaleM,
    vertScaleM,
  };

  // Circulation derivation:
  //  - cellsPerHemisphere = ceil(bandCount/2), since bandCount counts both
  //    zones and belts visually. Earth (bandCount usually 0 → fallback 3).
  //  - strength tracks bandingIntensity (0..1).
  //  - jetSpeedMs scales with rotation rate (faster spin → stronger jets)
  //    and banding intensity.
  let cellsPerHemisphere: number;
  if (bandCount >= 2) {
    cellsPerHemisphere = Math.max(2, Math.ceil(bandCount / 2));
  } else {
    cellsPerHemisphere = 3; // Earth-default Hadley/Ferrel/Polar
  }
  const rotFactor = Math.sqrt(24 / Math.max(1, Math.abs(rotationPeriodHours)));
  const jetSpeedMs = 25 * rotFactor * (0.3 + 0.7 * bandingIntensity);

  return {
    seed,
    planetRadiusM,
    layers: [layer],
    clumps: [],
    circulation: {
      cellsPerHemisphere,
      strength: bandingIntensity,
      jetSpeedMs,
    },
  };
}
