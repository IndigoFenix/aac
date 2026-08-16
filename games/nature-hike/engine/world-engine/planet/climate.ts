// shared/world-engine/planet/climate.ts
//
// LARGE-SCALE CLIMATE — per-cell RAIN and TEMPERATURE fields over a built
// planet's lattice, folded into the settled substrate as a worldgen
// composition (like founding: pure, deterministic, day-zero — NOT a new
// runtime dynamic).
//
// Why: the substrate's fertility was river-adjacency only (the fertile-banks
// halo), with one uniform `rain` scalar scaling flow sources — planets read
// far too dry, and snow was elevation-only (no ice caps). Climate adds
// rain-fed fertility and freezes the poles.
//
// The rain field also FEEDS THE RIVERS: planet-game.ts computes these fields
// BEFORE the substrate settles (climate needs only heights, which the settle
// never moves) and seeds the per-cell rain — normalized to land-mean 1 — as
// the `runoff` field the river var reads as its flow `sourceField`. So
// accumulation measures upstream rainfall, not bare catchment area, and the
// carved/green/founded world downstream of it is climate-shaped. Region and
// border charts inherit the parent's runoff like ore (refine.ts/border.ts).
//
// The model (v1, axis = +Y — matches the cloud system's convention in
// space/cloud-field.ts, so ground climate and the synoptic cloud deck agree
// on where the equator is):
//
//   RAIN  = wetness × latitudeBand × continentality × orographic
//     latitudeBand — Hadley-consistent: wet ITCZ belt at the equator, dry
//       subtropics (~±25–35°, the descending cell boundary), wetter
//       mid-latitude storm tracks (~±40–60°), dry poles. Smooth Gaussian
//       mixture, no steps. The 3-cell structure mirrors weather-map.ts's
//       Earth default (bandCells = 3 + equatorVigorBoost), so the rain on
//       the ground sits under the convective belts the clouds render.
//     continentality — moisture decays with distance from the sea (BFS over
//       cells from height < seaHeight), e-folding at 1,500 km, floored so
//       deep interiors are dry but not airless-dry.
//     orographic v1 — elevation dries (e-fold 3 km). Windward/lee shadows
//       need prevailing winds (weather-map.ts's zonal jet profile is the
//       intended source) — named follow-up.
//
//   TEMP °C = meanTempC + latitude curve − lapse × elevation
//     latitude curve — +13 °C at the equator, −31 °C at the poles (relative
//       to the mean), annual-mean shaped; 0 °C crossing ≈ ±57° on an
//       earthlike (meanTempC 14).
//     lapse — 6.5 °C/km of elevation (metresPerUnit converts height units).
//       Elevation is measured above the CONTINENTAL PLATFORM (the median
//       land height), not the sea line: the substrate's height scale is
//       stylized (the render default exaggerates silhouettes ~3.5× on an
//       earthlike), and the platform is where the plains live — anchoring
//       at the sea line froze 76% of land on the calibration world.
//       Region-tier lapse corrections use height DELTAS, so the anchor
//       cancels there.
//
// applyClimate then rewrites the substrate's REST STATE consistently with
// its own rule targets: fertility = max(river halo, rain-fed), plant tracks
// the new fertility (the greenery sensor formula), lure = max(fertility,
// ore), forage = 2 × lure — exactly what the rules converge to, so an
// unchanged cell keeps its settled value bit-identically. tempC < ICE_TEMP_C
// is ICE CAP: fertility 0, plant 0, forage 0 (nothing founds on the caps),
// ice = 1; tempC in [ICE_TEMP_C, 0) is cold-barren (fertility 0 via the
// growing season, crowds only at ore). A later wake (sculpt, mining,
// harvest) re-settles that cell to the river-only value — rain-aware
// substrate RULES are a named follow-up.

import type { GridTopology } from "../kernel/cells/topology";
import type { CellGrid } from "../kernel/cells/index";

/** Standard atmospheric lapse rate, °C per metre of elevation. */
export const LAPSE_C_PER_M = 6.5 / 1000;

/** Thermal conversion ceiling, metres per height unit — an honest-Earth
 *  full relief (~9.6 km over the 60-unit span). `relief` is a render
 *  silhouette knob (the default draws 32 km mountains on an earthlike);
 *  letting it steepen the lapse froze every upland and all ore country.
 *  Worlds with genuinely gentler relief pass their own scale through. */
export const THERMAL_M_PER_UNIT_CAP = 160;

/** Annual-mean temperature below which land is ICE CAP (fertility 0,
 *  forage 0, ice = 1). The 0 °C annual isotherm crosses inhabited taiga
 *  (Moscow), so the cap line sits at the ice-sheet ≈ −8 °C; between −8
 *  and 0 the land is cold-barren (growing season 0 ⇒ fertility 0, crowds
 *  only where ore lures them) but not capped. */
export const ICE_TEMP_C = -8;

// Rain-model constants (calibrated on the earthlike: faceN 24, seed 7,
// real radius — see climate.test.ts's dryness-fix numbers).
const CONTINENTAL_EFOLD_M = 1_500_000; // moisture e-fold from the coast
const CONTINENTAL_MIN = 0.15;          // deep-interior floor
const CONTINENTAL_CAP_M = 6 * CONTINENTAL_EFOLD_M;
const OROGRAPHIC_EFOLD_M = 3_000;      // elevation drying e-fold

// Fertility mapping: rain below the floor is desert; full rain-fed
// fertility caps BELOW the river-rich 15 so watercourses stay premium land.
const RAIN_FERT_MAX = 12;
const RAIN_DESERT = 0.25;
const RAIN_LUSH = 1.0;

/** Latitude rain band, ~0.12 (poles) .. ~1.27 (ITCZ); ~0.28 subtropics. */
export function latitudeRain(latRad: number): number {
  const deg = Math.abs(latRad) * (180 / Math.PI);
  const itcz = 1.15 * Math.exp(-((deg / 14) ** 2));
  const stormTrack = 0.65 * Math.exp(-(((deg - 48) / 15) ** 2));
  return 0.12 + itcz + stormTrack;
}

/** Sea-level temperature at a latitude: +13 °C over the mean at the
 *  equator, −31 °C under it at the poles (annual-mean shape). */
export function latitudeTempC(latRad: number, meanTempC: number): number {
  const s2 = Math.sin(latRad) ** 2;
  return meanTempC + 13 - 27 * s2 - 17 * s2 * s2;
}

/** Multi-source BFS hop distance from the sea (height < seaHeight) over
 *  the lattice. Sea cells are 0; unreachable (no sea at all) = -1. */
export function seaDistance(
  topo: GridTopology, height: ArrayLike<number>, seaHeight: number,
): Int32Array {
  const n = topo.n;
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let c = 0; c < n; c++) {
    if (height[c] < seaHeight) { dist[c] = 0; queue.push(c); }
  }
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const k = topo.neighbours(c, nb);
    for (let j = 0; j < k; j++) {
      const ni = nb[j];
      if (dist[ni] < 0) { dist[ni] = dist[c] + 1; queue.push(ni); }
    }
  }
  return dist;
}

export interface ClimateFieldOpts {
  /** The planet lattice — pos3 required (latitude = asin(dir·+Y)). */
  topo: GridTopology;
  /** Substrate height, in height units. */
  height: ArrayLike<number>;
  /** The substrate's sea line in height units (geology's SEA_HEIGHT). */
  seaHeight: number;
  /** Metres per height unit (relief × radius / (63 − seaHeight)). */
  metresPerUnit: number;
  /** Planet radius in metres — converts BFS hops to coast distance. On a
   *  toy-radius world every cell is "coastal" and continentality is ~1;
   *  only real-radius worlds grow interior deserts. */
  radiusM: number;
  /** Global mean sea-level temperature (default 14 — earthlike). */
  meanTempC?: number;
  /** Global rain multiplier (default 1). */
  wetness?: number;
}

export interface ClimateFields {
  /** Effective rainfall, ~0 (desert) .. ~1.3 × wetness (rainforest). */
  rain: Float64Array;
  /** Surface air temperature, °C. */
  tempC: Float64Array;
}

/** Mean neighbour angle over a strided cell sample — one cell's pitch in
 *  radians (deterministic; the render sampler measures the same way). */
function meanPitch(topo: GridTopology): number {
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  const step = Math.max(1, Math.floor(topo.n / 256));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < topo.n; i += step) {
    const k = topo.neighbours(i, nb);
    const p = topo.pos3!(i);
    for (let j = 0; j < k; j++) {
      const q = topo.pos3!(nb[j]);
      const dp = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
      sum += Math.acos(dp);
      count++;
    }
  }
  return count > 0 ? sum / count : Math.PI / 64;
}

/** Per-cell rain + temperature over the lattice — pure and deterministic. */
export function climateFields(opts: ClimateFieldOpts): ClimateFields {
  const { topo, height, seaHeight, radiusM } = opts;
  if (!topo.pos3) throw new Error("climateFields: the topology has no pos3 (climate lives on curved lattices)");
  const meanTempC = opts.meanTempC ?? 14;
  const wetness = opts.wetness ?? 1;
  const metresPerUnit = Math.min(opts.metresPerUnit, THERMAL_M_PER_UNIT_CAP);

  const n = topo.n;
  const rain = new Float64Array(n);
  const tempC = new Float64Array(n);
  const hops = seaDistance(topo, height, seaHeight);
  const pitchM = meanPitch(topo) * radiusM;

  // The continental platform: median land height — thermal "sea level"
  // (see the header; the stylized height scale would otherwise put every
  // plain kilometres up). Deterministic: counting sort over height units.
  const counts = new Map<number, number>();
  let landCells = 0;
  for (let c = 0; c < n; c++) {
    if (height[c] < seaHeight) continue;
    const h = Math.round(height[c]);
    counts.set(h, (counts.get(h) ?? 0) + 1);
    landCells++;
  }
  let platformH = seaHeight;
  if (landCells > 0) {
    let seen = 0;
    for (const h of [...counts.keys()].sort((a, b) => a - b)) {
      seen += counts.get(h)!;
      if (seen >= landCells / 2) { platformH = h; break; }
    }
  }
  platformH = Math.max(platformH, seaHeight);

  for (let c = 0; c < n; c++) {
    const dir = topo.pos3(c);
    const lat = Math.asin(Math.max(-1, Math.min(1, dir[1])));
    const elevM = Math.max(0, height[c] - platformH) * metresPerUnit;

    tempC[c] = latitudeTempC(lat, meanTempC) - LAPSE_C_PER_M * elevM;

    const distM = hops[c] < 0 ? CONTINENTAL_CAP_M : Math.min(hops[c] * pitchM, CONTINENTAL_CAP_M);
    const continental = CONTINENTAL_MIN + (1 - CONTINENTAL_MIN) * Math.exp(-distM / CONTINENTAL_EFOLD_M);
    const orographic = Math.exp(-elevM / OROGRAPHIC_EFOLD_M);
    rain[c] = wetness * latitudeRain(lat) * continental * orographic;
  }
  return { rain, tempC };
}

export interface ApplyClimateOpts {
  /** Substrate sea line (default 3). */
  seaHeight?: number;
  /** Fertility ceiling elevation (default 40 — the worldgen treeline). */
  treeline?: number;
  /** "recompute" (default): forage re-derives from the climate-adjusted
   *  lure (tier 0, before founding — the rules' own rest value).
   *  "iceOnly": only ice zeroes forage — tier 1, where the parent budget
   *  owns crowd density and must not be overwritten. */
  forage?: "recompute" | "iceOnly";
}

export interface ClimateSummary {
  /** Land cells (height ≥ seaHeight). */
  land: number;
  /** Land cells frozen (tempC < 0). */
  ice: number;
  /** Land cells at fertility ≥ 8 (the river-"ok" band — the per-cell
   *  founding-relevant level) before / after the fold. */
  greenBefore: number;
  greenAfter: number;
}

/** Growing-season factor: nothing below 0 °C, full growth by 10 °C,
 *  scorched back to nothing across 35–45 °C. */
function tempGrowth(tC: number): number {
  const cold = Math.max(0, Math.min(1, tC / 10));
  const hot = Math.max(0, Math.min(1, (45 - tC) / 10));
  return cold * hot;
}

/**
 * Fold climate into a SETTLED substrate. Rewrites fertility (max of the
 * river halo and rain-fed), plant, lure and forage to the rule-consistent
 * rest values, freezes ice cells, and writes `rain` / `tempC` / `ice`
 * into grid.fields for renderers and region refinement. Deterministic;
 * no scheduler wake (worldgen composition, like founding).
 */
export function applyClimate(
  grid: CellGrid, fields: ClimateFields, opts: ApplyClimateOpts = {},
): ClimateSummary {
  const seaHeight = opts.seaHeight ?? 3;
  const treeline = opts.treeline ?? 40;
  const forageMode = opts.forage ?? "recompute";
  const { rain, tempC } = fields;

  const n = grid.topo.n;
  const height = grid.fields.height;
  const river = grid.fields.river;
  const solid = grid.fields.solid;
  const fert = grid.fields.fertility;
  const plant = grid.fields.plant;
  const ore = grid.fields.ore;
  const lure = grid.fields.lure;
  const forage = grid.fields.forage;
  if (!height || !fert) throw new Error("applyClimate: substrate has no height/fertility fields");

  const ice = new Float64Array(n);
  const summary: ClimateSummary = { land: 0, ice: 0, greenBefore: 0, greenAfter: 0 };

  for (let c = 0; c < n; c++) {
    const land = height[c] >= seaHeight;
    if (land) {
      summary.land++;
      if (fert[c] >= 8) summary.greenBefore++;
    }

    if (tempC[c] < ICE_TEMP_C) {
      ice[c] = 1;
      if (land) summary.ice++;
      fert[c] = 0;
      if (forage) forage[c] = 0;
      continue;
    }

    // Arable gate = the substrate's own fertility gates (worldgenSubstrate's
    // fertile-*/barren rules): land, below the treeline, not stone.
    const arable = land && height[c] < treeline && (!solid || solid[c] < 0.5);
    if (!arable) { fert[c] = 0; continue; }

    // River halo (the rules' rest targets — kept: watercourses stay the
    // premium land, and a desert river keeps its fertile banks).
    const rv = river ? river[c] : 0;
    const riverFert = rv > 45 ? 15 : rv > 15 ? 8 : 0;

    // Rain-fed fertility: desert below the floor, saturating below the
    // river-rich 15, scaled by the growing season.
    const rainT = Math.max(0, Math.min(1, (rain[c] - RAIN_DESERT) / (RAIN_LUSH - RAIN_DESERT)));
    const rainFert = Math.round(RAIN_FERT_MAX * rainT * tempGrowth(tempC[c]));

    fert[c] = Math.max(riverFert, rainFert);
  }

  // Vegetation tracks the NEW fertility (the greenery rule's rest value:
  // plant = neighbourhood mean fertility × 0.8, gated like fertility).
  if (plant) {
    const next = new Float64Array(n);
    for (let c = 0; c < n; c++) {
      const grows = ice[c] < 1 && height[c] >= seaHeight && height[c] < treeline && (!solid || solid[c] < 0.5);
      if (!grows) { next[c] = 0; continue; }
      let sum = 0;
      let count = 0;
      grid.topo.disk(c, 1, cell => { sum += fert[cell]; count++; });
      next[c] = Math.max(0, Math.min(7, Math.round((count ? sum / count : 0) * 0.8)));
    }
    plant.set(next);
  }

  // Lure and crowds follow (the Sugarscape rules' rest values) — founding
  // must see climate-adjusted forage. Ice was zeroed above.
  for (let c = 0; c < n; c++) {
    if (ice[c] >= 1) continue;
    const l = Math.max(fert[c], ore ? ore[c] : 0);
    if (lure) lure[c] = Math.min(15, l);
    if (forage && forageMode === "recompute") forage[c] = Math.max(0, Math.min(31, Math.round(2 * l)));
  }

  grid.fields.rain = Float64Array.from(rain);
  grid.fields.tempC = Float64Array.from(tempC);
  grid.fields.ice = ice;

  for (let c = 0; c < n; c++) {
    if (height[c] >= seaHeight && fert[c] >= 8) summary.greenAfter++;
  }
  return summary;
}
