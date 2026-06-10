import * as THREE from "three";
import { createNoise3D } from "simplex-noise";
import { mulberry32 } from "./galaxy";
import type { Atmosphere } from "./physics-system/features";
import {
  createWeatherMap,
  zonalSpeedMs,
  type SynopticParams,
  type SynopticSample,
  type WeatherMap,
} from "./weather-map";

// Cloud density field — a pure function of (position, time, seed) defined in
// planet-local Cartesian coordinates (meters from planet center).
//
// Split across two scales with two owners:
//
//   SYNOPTIC (≥ ~200 km) — weather-map.ts. Banding, fronts, vortices,
//   coverage, convective vigor. Baked to an equirect RGBA map that the
//   orbital shell samples in GLSL and this module bilinear-samples in JS,
//   so every renderer sees the SAME weather.
//
//   LOCAL (~1–100 km) — this module. Vertical profile, vigor-driven cloud
//   tops, and 3D detail noise that turns the synoptic cover value into
//   individual puffs / decks / towers. Detail varies per layer and is
//   advected by the zonal wind so puffs drift with their parent system.
//
// Convention: planet-local +Y is the rotation axis. Latitude derives from
// asin(localPos.y / r); longitude from atan2(z, x).

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
  /** Outer altitude above planet surface (meters) at FULL vertical
   *  development. The local top is lower where vigor is low. */
  topAltitudeM: number;
  /** 0..1 — peak opacity multiplier inside this layer. */
  density: number;
  /** Multiplier on the synoptic cover channel for this layer (a cirrus
   *  veil uses a fraction of the main deck's coverage). */
  coverageMul: number;
  /** Tint where air is rising (zones — top-of-atmosphere chemistry). */
  zoneColor: THREE.Color;
  /** Tint where air is sinking (belts — deeper, often darker). */
  beltColor: THREE.Color;
  /** Horizontal wavelength (m) of the layer's detail noise. */
  detailScaleM: number;
  /** Vertical wavelength (m) of the detail noise. */
  vertScaleM: number;
  /** 0..1 — baseline physical shape axis (0 = flat stratus deck, 1 =
   *  volumetric cumulus). The LOCAL value blends this with the synoptic
   *  vigor channel — one planet carries both stratus sheets and towers,
   *  flowing into each other where vigor changes. */
  cumuliformity: number;
  /** 0..1 — how strongly synoptic vigor affects this layer (lifts tops,
   *  raises cumuliformity, sharpens detail). 0 for haze/cirrus veils. */
  vigorResponse: number;
  /** Longitude offset (radians) applied when sampling the weather map —
   *  decorrelates stacked layers so a cirrus veil doesn't trace the
   *  cumulus deck exactly. */
  mapLonOffsetRad: number;
}

export interface CloudFieldParams {
  seed: number;
  planetRadiusM: number;
  layers: CloudLayer[];
  synoptic: SynopticParams;
  /** Filled lazily by the sampler — do not set directly. */
  _noise?: NoiseFns;
}

export interface CloudSample {
  /** 0..1 — instantaneous cloud opacity at the sampled point. */
  density: number;
  /** Local tinted cloud color (zone/belt blended, storm-darkened; the
   *  renderer applies sun shading on top). */
  color: THREE.Color;
  /** Index of the layer contributing the dominant density, or -1. */
  layerIndex: number;
  /** 0..1 — local cumuliformity (flat deck ↔ volumetric tower). */
  cumuliformity: number;
  /** 0..1 — local storminess (darkens bases, future precipitation). */
  storm: number;
}

interface NoiseFns {
  detail: (x: number, y: number, z: number) => number;
}

function ensureNoise(field: CloudFieldParams): NoiseFns {
  if (field._noise) return field._noise;
  const rng = mulberry32(field.seed);
  field._noise = { detail: createNoise3D(rng) };
  return field._noise;
}

// ── Wind ───────────────────────────────────────────────────────────────────

const _crossUp = new THREE.Vector3(0, 1, 0);

/** Local wind vector at a position, planet-local frame (m/s). Zonal-only:
 *  speed from the shared jet profile, direction = local east. Used to
 *  advect the detail noise so puffs drift with their parent system. */
export function windAtLocal(
  field: CloudFieldParams,
  localPos: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const len = localPos.length();
  if (len < 1) return out.set(0, 0, 0);
  const sinLat = THREE.MathUtils.clamp(localPos.y / len, -1, 1);
  const lat = Math.asin(sinLat);
  const speed = zonalSpeedMs(field.synoptic, lat);
  // East = +Y × radial. Result has zero y-component (drift is pure zonal).
  out.crossVectors(_crossUp, localPos);
  const eastLen = out.length();
  if (eastLen < 1e-6) return out.set(0, 0, 0);
  return out.multiplyScalar(speed / eastLen);
}

// ── Sampler ────────────────────────────────────────────────────────────────

const _sampleWind = new THREE.Vector3();
const _synTmp: SynopticSample = { cover: 0, vigor: 0, zoneT: 0, storm: 0 };

/** Perf counters surfaced in the debug readout — sample calls are the
 *  dominant cloud CPU cost, so visibility here matters when tuning. */
export const cloudFieldStats = { samples: 0 };

export interface CloudSampleOpts {
  /** Wind/drift multiplier (debug slider). */
  windMult: number;
  /** Multiplier on the vigor channel (debug slider). */
  vigorMult: number;
  /** Multiplier on detail-noise contrast (debug slider). */
  detailMult: number;
}

export const DEFAULT_SAMPLE_OPTS: CloudSampleOpts = {
  windMult: 1,
  vigorMult: 1,
  detailMult: 1,
};

/** Sample the cloud field at (localPos, time). `map` is the body's baked
 *  weather map (the synoptic authority); this adds vertical structure and
 *  local detail. Fills and returns `out`. Cheap enough to call ~10k times
 *  per frame: one bilinear map read + ≤2 simplex octaves per layer. */
export function cloudDensityAt(
  field: CloudFieldParams,
  map: WeatherMap,
  localPos: THREE.Vector3,
  timeSeconds: number,
  opts: CloudSampleOpts,
  out: CloudSample,
): CloudSample {
  cloudFieldStats.samples++;
  out.density = 0;
  out.color.setRGB(0, 0, 0);
  out.layerIndex = -1;
  out.cumuliformity = 0;
  out.storm = 0;
  if (field.layers.length === 0) return out;

  const radius = localPos.length();
  if (radius < 1) return out;
  const altitude = radius - field.planetRadiusM;
  const sinLat = THREE.MathUtils.clamp(localPos.y / radius, -1, 1);
  const lat = Math.asin(sinLat);
  const lon = Math.atan2(localPos.z, localPos.x);

  const noise = ensureNoise(field);

  // Detail advection: drift the detail-noise sample position upwind so
  // puffs travel with the synoptic pattern. Same jet profile as the map's
  // residual scroll → both scales move together.
  windAtLocal(field, localPos, _sampleWind);
  const driftT = timeSeconds * opts.windMult;
  const sx = localPos.x - _sampleWind.x * driftT;
  const sy = localPos.y - _sampleWind.y * driftT;
  const sz = localPos.z - _sampleWind.z * driftT;

  let bestDensity = 0;
  for (let li = 0; li < field.layers.length; li++) {
    const layer = field.layers[li];
    if (altitude < layer.baseAltitudeM || altitude > layer.topAltitudeM) continue;

    // Synoptic sample — the layer's lon offset decorrelates stacked layers.
    map.sample(lon + layer.mapLonOffsetRad, lat, timeSeconds, opts.windMult, _synTmp);
    const cover = Math.min(1, _synTmp.cover * layer.coverageMul);
    if (cover < 0.015) continue;
    const vigor = Math.min(1, _synTmp.vigor * opts.vigorMult) * layer.vigorResponse;

    // Local cloud top rises with vigor: low-vigor regions are shallow
    // decks, high-vigor regions develop the layer's full depth (towers).
    const fullThick = layer.topAltitudeM - layer.baseAltitudeM;
    const localThick = fullThick * (layer.vigorResponse > 0.01
      ? 0.3 + 0.7 * vigor
      : 1);
    const altT = (altitude - layer.baseAltitudeM) / Math.max(1, localThick);
    if (altT >= 1) continue;

    // Local shape axis: baseline cumuliformity pushed up by vigor.
    const cum = Math.min(1, layer.cumuliformity + vigor * 0.85);

    // Vertical profile — sin curve, flattened toward the base for
    // cumuliform cloud (real cumulus have flat condensation-level bases
    // and bulging tops).
    const profile = Math.pow(Math.sin(altT * Math.PI), 1 - 0.45 * cum);

    // Detail noise — 2 octaves. Contrast (how much detail carves the
    // synoptic cover into separate puffs) scales with cumuliformity:
    // stratus decks stay smooth, convective fields break into cells.
    const fh = 1 / Math.max(1, layer.detailScaleM);
    const fv = 1 / Math.max(1, layer.vertScaleM);
    let dn = noise.detail(sx * fh, sy * fv, sz * fh)
      + 0.5 * noise.detail(sx * fh * 2.07 + 31.7, sy * fv * 2.07, sz * fh * 2.07);
    dn = (dn / 1.5 + 1) * 0.5; // → 0..1
    const detailAmp = Math.min(1, (0.25 + 0.6 * cum) * opts.detailMult);
    const shape = 0.55 * (1 - detailAmp) + dn * detailAmp;

    // Combine: cover gates how much of the detail field condenses.
    //   cover → 0   : nothing
    //   cover ~ 0.4 : isolated puffs where detail peaks
    //   cover → 1   : solid deck with textured top
    // The ramp is steep so individual puffs read opaque — broken skies
    // come from the gaps between clouds, not from translucent cloud.
    const x = 0.55 * cover + 0.9 * shape * Math.pow(cover, 0.6);
    let d = (x - 0.2) / 0.45;
    if (d <= 0) continue;
    if (d > 1) d = 1;
    d *= profile * layer.density;

    if (d > bestDensity) {
      bestDensity = d;
      out.density = d;
      out.layerIndex = li;
      out.cumuliformity = cum;
      out.storm = _synTmp.storm;
      out.color.copy(layer.beltColor).lerp(layer.zoneColor, _synTmp.zoneT);
      // Storm darkening — deep convective systems read darker from
      // every angle (renderer adds the sun-side/base shading).
      const darken = 1 - 0.35 * _synTmp.storm;
      out.color.multiplyScalar(darken);
    }
  }
  return out;
}

// ── Derivation from Atmosphere ─────────────────────────────────────────────
//
// Maps the physics-system's regime-blended Atmosphere to CloudFieldParams.
// Everything is a continuous parameter — cloud "types" only pick anchor
// values, and the regime blending upstream means borderline worlds land
// between the anchors.

export interface DeriveCloudFieldOpts {
  atmosphere: Atmosphere;
  planetRadiusM: number;
  /** features.atmosphericBandCount — visible bands when seen from space. */
  bandCount: number;
  /** features.atmosphericBanding — 0..1 banding intensity. */
  bandingIntensity: number;
  /** features.rotation.periodHours — absolute value used. */
  rotationPeriodHours: number;
  /** Per-body seed for noise + vortex placement. */
  seed: number;
}

interface CloudTypeAnchor {
  /** Synoptic feature wavelength (m) — cyclone/front/oval scale. */
  synopticScaleM: number;
  /** Detail puff wavelength (m). */
  detailScaleM: number;
  /** Baseline cumuliformity of the main layer. */
  cumuliformity: number;
  /** Convective vigor ceiling. */
  convectiveVigor: number;
  /** Vortex activity 0..1. */
  vortexActivity: number;
  /** Vortex lifecycle (weather-days). */
  vortexLifetimeDays: number;
  /** Whether the world gets a thin high cirrus veil layer. */
  cirrus: boolean;
}

/** Hand-tuned per-chemistry anchors. Water worlds churn (cyclones, towers,
 *  fronts); acid and haze decks are smooth and near-permanent; ammonia
 *  giants run banded with long-lived ovals. */
const CLOUD_TYPE_ANCHORS: Record<Atmosphere["cloudType"], CloudTypeAnchor> = {
  none: {
    synopticScaleM: 1_000_000, detailScaleM: 30_000, cumuliformity: 0,
    convectiveVigor: 0, vortexActivity: 0, vortexLifetimeDays: 10, cirrus: false,
  },
  water: {
    synopticScaleM: 1_400_000, detailScaleM: 18_000, cumuliformity: 0.35,
    convectiveVigor: 0.85, vortexActivity: 0.65, vortexLifetimeDays: 6, cirrus: true,
  },
  sulfuric_acid: {
    synopticScaleM: 3_000_000, detailScaleM: 120_000, cumuliformity: 0.05,
    convectiveVigor: 0.1, vortexActivity: 0.15, vortexLifetimeDays: 60, cirrus: false,
  },
  ammonia: {
    synopticScaleM: 7_000_000, detailScaleM: 250_000, cumuliformity: 0.15,
    convectiveVigor: 0.45, vortexActivity: 0.8, vortexLifetimeDays: 400, cirrus: false,
  },
  methane: {
    synopticScaleM: 4_000_000, detailScaleM: 200_000, cumuliformity: 0.05,
    convectiveVigor: 0.25, vortexActivity: 0.35, vortexLifetimeDays: 80, cirrus: false,
  },
  co2_ice: {
    synopticScaleM: 900_000, detailScaleM: 40_000, cumuliformity: 0.1,
    convectiveVigor: 0.15, vortexActivity: 0.25, vortexLifetimeDays: 4, cirrus: false,
  },
  iron_silicate: {
    synopticScaleM: 15_000_000, detailScaleM: 500_000, cumuliformity: 0.1,
    convectiveVigor: 0.35, vortexActivity: 0.5, vortexLifetimeDays: 200, cirrus: false,
  },
};

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

  const empty = (): CloudFieldParams => ({
    seed,
    planetRadiusM,
    layers: [],
    synoptic: {
      seed,
      planetRadiusM,
      coverage: 0,
      synopticScaleM: 1_000_000,
      bandCells: 1,
      bandStrength: 0,
      bandWaviness: 0,
      jetSpeedMs: 0,
      streakiness: 0,
      vortexActivity: 0,
      vortexRadiusRad: 0.1,
      vortexLifetimeDays: 10,
      vortexSpin: 0,
      convectiveVigor: 0,
      equatorVigorBoost: 0,
      weatherDaysPerSecond: WEATHER_DAYS_PER_SECOND,
    },
  });

  if (atmosphere.cloudType === "none" || atmosphere.cloudCoverage < 0.01) {
    return empty();
  }

  const anchor = CLOUD_TYPE_ANCHORS[atmosphere.cloudType];
  const baseM = atmosphere.cloudBaseAltitudeKm * 1000;
  const thickM = Math.max(500, atmosphere.cloudThicknessKm * 1000);
  const zoneColor = atmosphere.skyZenithColor.clone();
  const beltColor = deriveBeltColor(zoneColor);

  // Circulation derivation:
  //  - cellsPerHemisphere = ceil(bandCount/2), since bandCount counts both
  //    zones and belts visually. Earth (bandCount usually 0 → fallback 3).
  //  - jet speed scales with rotation rate (faster spin → stronger jets)
  //    and banding intensity.
  //  - waviness is the inverse of banding: weakly-banded worlds (Earth)
  //    meander; strongly-banded fast rotators (Jupiter) run straight.
  const bandCells = bandCount >= 2
    ? Math.max(2, Math.ceil(bandCount / 2))
    : 3; // Earth-default Hadley/Ferrel/Polar
  const rotFactor = Math.sqrt(24 / Math.max(1, Math.abs(rotationPeriodHours)));
  const jetSpeedMs = 25 * rotFactor * (0.3 + 0.7 * bandingIntensity);
  const bandWaviness = (1 - bandingIntensity) * 0.8 + 0.15;
  // Streaks follow jet shear — strongly-banded fast rotators smear their
  // clouds zonally; calm worlds keep isotropic cells.
  const streakiness = Math.min(1, bandingIntensity * 0.85 + rotFactor * 0.15);

  // Vortex sizing: a storm spans a fraction of a circulation cell.
  const vortexRadiusRad = Math.min(0.35, (Math.PI / 2) / bandCells * 0.35);

  const synoptic: SynopticParams = {
    seed,
    planetRadiusM,
    coverage: atmosphere.cloudCoverage,
    synopticScaleM: anchor.synopticScaleM,
    bandCells,
    bandStrength: bandingIntensity,
    bandWaviness,
    jetSpeedMs,
    streakiness,
    vortexActivity: anchor.vortexActivity,
    vortexRadiusRad,
    vortexLifetimeDays: anchor.vortexLifetimeDays,
    vortexSpin: 2.2,
    convectiveVigor: anchor.convectiveVigor,
    // ITCZ band only matters on convective (water-cycle) worlds.
    equatorVigorBoost: anchor.convectiveVigor > 0.5 ? 0.5 : 0,
    weatherDaysPerSecond: WEATHER_DAYS_PER_SECOND,
  };

  const layers: CloudLayer[] = [{
    baseAltitudeM: baseM,
    topAltitudeM: baseM + thickM,
    density: 1,
    coverageMul: 1,
    zoneColor,
    beltColor,
    detailScaleM: anchor.detailScaleM,
    vertScaleM: Math.max(500, thickM * 0.6),
    cumuliformity: anchor.cumuliformity,
    vigorResponse: anchor.convectiveVigor > 0.05 ? 1 : 0,
    mapLonOffsetRad: 0,
  }];

  // High cirrus veil for water worlds — thin, streaky, decorrelated from
  // the main deck. Cheap (its altitude band only adds samples near its
  // own shell) and carries a lot of "real sky" feel.
  if (anchor.cirrus) {
    const cirrusBase = baseM + thickM + 2000;
    layers.push({
      baseAltitudeM: cirrusBase,
      topAltitudeM: cirrusBase + 1500,
      density: 0.4,
      coverageMul: 0.55,
      zoneColor: zoneColor.clone().lerp(new THREE.Color(1, 1, 1), 0.5),
      beltColor: zoneColor.clone(),
      detailScaleM: anchor.detailScaleM * 4,
      vertScaleM: 1200,
      cumuliformity: 0,
      vigorResponse: 0,
      mapLonOffsetRad: Math.PI * 0.6,
    });
  }

  return { seed, planetRadiusM, layers, synoptic };
}

/** Weather evolution pacing — how many "weather days" (vortex lifecycle
 *  units, field morphing) pass per sim-second. 1/240 → an Earth storm
 *  (≈6-day lifecycle) is born and dies over ~24 minutes of play. */
export const WEATHER_DAYS_PER_SECOND = 1 / 240;

/** Build the runtime weather map for a derived field. The map starts
 *  empty (clear sky) — the cloud system bakes the first sweep at an
 *  elevated per-frame budget, so weather fades in over the first couple
 *  of seconds after materialize instead of stalling a frame on a full
 *  synchronous bake. */
export function buildWeatherMap(field: CloudFieldParams, timeSec: number): WeatherMap {
  const map = createWeatherMap(field.synoptic);
  map.epochSec = timeSec;
  return map;
}
