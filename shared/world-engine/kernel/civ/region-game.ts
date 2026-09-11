/**
 * The REGION scope builder — a world document whose whole game is one
 * FLAT map: the classic cols×rows substrate (the 2D scope the regional
 * games run on), grown by the same causal chain as a planet, minus the
 * sphere: flat plate tectonics bakes height and ore, the substrate
 * settles (rivers carve, fertility greens, wild crowds pool), and the
 * crowds propose founding sites — tomorrow's `initial_focus` targets.
 *
 * Validation follows the module law: the kernel gated `game`'s shape;
 * this builder owns the deep validation of the region-scoped `world`
 * object, path-exact, reject-never-skip.
 */
import type { GameSettings } from "../manifest";
import type { CellGrid, FoundingSite } from "../cells/index";
import { findFoundingSites } from "../cells/index";
import { makeFlatTopology } from "../cells/topology";
import { runTectonics, bakeAuthors, SEA_HEIGHT, type TectonicWorld, type TectonicFrame } from "../geology/tectonics";
import { prepareSubstrate } from "./tri";
import { validateFields, type FieldSpec, type GroupSpec } from "../spec-schema";
import { climateFields, applyClimate, type ClimateFields } from "../../planet/climate";
import { applyEcology, DEFAULT_BIOSPHERE } from "../../planet/ecology";
import { planeMetric, type SurfaceMetric } from "../../planet/surface-metric";
import { PREMISE_FIELDS } from "../../space/space-game";

export interface RegionWorldSpec {
  size: { cols: number; rows: number };
  geology: {
    seed: number;
    epochs: number;
    plates?: number;
    continentR?: number;
    hotspots?: number;
  };
  /** Mature the substrate after baking (default true). */
  settle: boolean;
  /** Climate knob: multiplies the substrate's rain sources (default 1). */
  rain: number;
  /** ⚖️ THE REGION FIXTURE (planet-boot round S3b) — metres per lattice
   *  cell. A real-substrate stand-in for the hamlet ring: chosen so the
   *  nearest cities stand at a freight-viable distance (report/search in
   *  the round's landing note), never tuned to any single content outcome. */
  cell_m: number;
  /** Max relief, metres — the plane's `metresPerUnit` (travel pricing,
   *  climate lapse) is `relief_m / (63 − SEA_HEIGHT)`. */
  relief_m: number;
  /** The map's centre latitude, degrees — a row's own latitude is this plus
   *  a row offset (`planeMetric`'s `latRad`). */
  latitude: number;
  /** Large-scale climate — SAME two knobs the planet scope declares
   *  (`meanTempC`/`wetness`); absent = earthlike. Duplicated rather than
   *  imported from `planet/planet-game.ts` (`PLANET_CLIMATE_FIELDS` is
   *  private there) — the two field specs are the whole shared fact, and
   *  region-game.ts must not create a dependency on the planet's own
   *  world-field module for it. */
  climate?: { meanTempC?: number; wetness?: number };
  /** ⚖️ THE PREMISE (S1's `PREMISE_FIELDS`, appended here per the ledger:
   *  "one declaration, appended twice") — what game starts in this region.
   *  See `space/space-game.ts SolarWorldSpec` for the field docs. */
  premise?: "founding";
  premise_stock?: Record<string, number>;
  premise_population?: number;
}

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

const REGION_SIZE_FIELDS: readonly FieldSpec[] = [
  { key: "cols", kind: "int", min: 8, max: 256, default: 96, facet: "interior", label: "Columns" },
  { key: "rows", kind: "int", min: 8, max: 256, default: 64, facet: "interior", label: "Rows" },
];

/** Tectonic/geology knobs — SHARED with the planet scope's `geology` sub-spec
 *  (same causal chain minus the sphere). */
export const GEOLOGY_FIELDS: readonly FieldSpec[] = [
  { key: "seed", kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, default: 1,
    facet: "boundary", ui: "seed", label: "Geology seed" },
  { key: "epochs", kind: "number", min: 0, max: 5000, default: 350, facet: "interior", label: "Epochs" },
  { key: "plates", kind: "number", min: 2, max: 32, facet: "interior", label: "Plates" },
  { key: "continentR", kind: "number", min: 0.05, max: 1.5, facet: "interior", label: "Continent radius" },
  { key: "hotspots", kind: "number", min: 0, max: 64, facet: "interior", label: "Hotspots" },
];

/** Climate knobs — a byte-for-byte duplicate of `planet-game.ts`'s private
 *  `PLANET_CLIMATE_FIELDS` (see `RegionWorldSpec.climate`). */
const REGION_CLIMATE_FIELDS: readonly FieldSpec[] = [
  { key: "meanTempC", kind: "number", min: -100, max: 100, default: 14, facet: "boundary", label: "Mean temp (°C)" },
  { key: "wetness", kind: "number", min: 0, max: 10, default: 1, facet: "boundary", label: "Wetness" },
];

/** The region scope's `world` descriptor. */
export const REGION_WORLD_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the region definition)",
  fields: [
    { key: "size", kind: "object", fields: REGION_SIZE_FIELDS, default: { cols: 96, rows: 64 },
      facet: "interior", label: "Grid size" },
    { key: "geology", kind: "object", fields: GEOLOGY_FIELDS, default: { seed: 1, epochs: 350 },
      facet: "boundary", label: "Geology" },
    { key: "settle", kind: "boolean", default: true, facet: "interior",
      label: "Settle", description: "Mature the substrate after baking." },
    { key: "rain", kind: "number", min: 0, max: 10, default: 1, facet: "interior",
      label: "Rain", description: "Multiplies the substrate's rain sources." },
    // ⚖️ THE REGION PRODUCER (planet-boot round S3b) — a baked flat map boots
    // the same founding camp headless: real cells, sites, cities, routes and
    // partners, no planet. `cell_m`/`relief_m`/`latitude` feed `planeMetric`;
    // `climate` folds rain/temperature into the substrate exactly as the
    // planet scope does (`planet-game.ts buildPlanetWorld`'s climate tail).
    { key: "cell_m", kind: "number", min: 1, max: 1_000_000, default: 500, facet: "interior",
      label: "Metres per cell", description: "The region fixture: metres a lattice cell spans." },
    { key: "relief_m", kind: "number", min: 0, max: 20_000, default: 2000, facet: "interior",
      label: "Relief (m)", description: "Max mountain elevation, metres." },
    { key: "latitude", kind: "number", min: -90, max: 90, default: 45, facet: "interior",
      label: "Latitude", description: "The map's centre latitude, degrees." },
    { key: "climate", kind: "object", fields: REGION_CLIMATE_FIELDS, facet: "boundary", label: "Climate",
      description: "Large-scale climate; absent = earthlike (meanTempC 14, wetness 1)." },
    // …AND THE PREMISE (S1's PREMISE_FIELDS, appended here too): what game
    // starts in this region.
    ...PREMISE_FIELDS,
  ],
};

/** Deep gate for a region-scoped `world` object. */
export function parseRegionWorld(raw: unknown, path: string): RegionWorldSpec {
  return validateFields(raw, REGION_WORLD_FIELDS, path) as unknown as RegionWorldSpec;
}

/** Founding scan used for the candidate readout and focus resolution —
 *  the acceptance worlds' proportions (same numbers as the planet). */
const REGION_FOUNDING = { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 };

export interface BuiltRegion {
  spec: RegionWorldSpec;
  /** The settled substrate — the same grid a civ layer would found on. */
  grid: CellGrid;
  sites: FoundingSite[];
  geology: { world: TectonicWorld; frames: TectonicFrame[] };
  /** ⚖️ THE PLANE METRIC (S3b) — `planeMetric(cols, rows, cell_m, relief_m,
   *  latitude)`, always present (even on an unsettled/raw region) so a
   *  caller never has to re-derive it from the spec. */
  metric: SurfaceMetric;
}

/** Build the flat map a `scope: "region"` game plays in. */
export function buildRegionWorld(game: GameSettings, label = "game"): BuiltRegion {
  if (game.scope !== "region") {
    fail(`${label}.scope`, `buildRegionWorld builds "region" games (got "${game.scope}")`);
  }
  const spec = parseRegionWorld(game.world, `${label}.world`);
  const cols = spec.size.cols;
  const rows = spec.size.rows;
  const metric = planeMetric(cols, rows, spec.cell_m, spec.relief_m, spec.latitude);

  const geology = runTectonics({
    cols,
    rows,
    seed: spec.geology.seed,
    epochs: spec.geology.epochs,
    plates: spec.geology.plates,
    continentR: spec.geology.continentR,
    hotspots: spec.geology.hotspots,
  });
  const authors = bakeAuthors(geology.world);

  // ⚖️ LARGE-SCALE CLIMATE (planet-boot round S3b) — the SAME tail
  // `planet-game.ts buildPlanetWorld` runs (§6b of the round ledger),
  // computed BEFORE the substrate settles because the rivers drink it: the
  // per-cell rain, normalized to land-mean 1, seeds the `runoff` field the
  // river var reads as its flow `sourceField`. A flat region has NO climate
  // pass otherwise — `climateSampleAt`/`ecoAbundanceAt` would throw/null on
  // every cell, and the founding scan would never see a climate-adjusted
  // crowd (ledger §6b "THE HIDDEN COUPLING").
  let regionClimate: ClimateFields | null = null;
  let runoffAt: ((x: number, y: number) => number) | undefined;
  if (spec.settle) {
    const preHeight = new Float64Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) preHeight[y * cols + x] = Math.max(0, Math.min(63, Math.round(authors.height(x, y))));
    }
    // A standalone flat topology (no settled grid exists yet) purely for the
    // pre-settle BFS `climateFields` runs (`seaDistance`'s `n`/`neighbours`/
    // `maxDegree`) — `makeFlatTopology` is cheap and pure, and `prepareSubstrate`
    // below builds an identical one internally for the settled grid.
    const topo = makeFlatTopology(cols, rows, false);
    regionClimate = climateFields({
      topo,
      height: preHeight,
      seaHeight: SEA_HEIGHT,
      metresPerUnit: metric.metresPerUnit,
      radiusM: 0, // unused with `metric` — the plane has no radius
      meanTempC: spec.climate?.meanTempC,
      wetness: spec.climate?.wetness,
      metric,
    });
    let sum = 0;
    let land = 0;
    for (let c = 0; c < cols * rows; c++) {
      if (preHeight[c] >= SEA_HEIGHT) { sum += regionClimate.rain[c]; land++; }
    }
    const mean = land > 0 ? sum / land : 0;
    if (mean > 1e-9) {
      const rain = regionClimate.rain;
      const inv = 1 / mean;
      runoffAt = (x: number, y: number): number => rain[y * cols + x] * inv;
    }
  }

  const prep = prepareSubstrate({
    cols,
    rows,
    height: authors.height,
    ore: authors.ore,
    founding: REGION_FOUNDING,
    settle: spec.settle,
    rain: spec.rain,
    runoff: runoffAt,
  });

  // Fold the climate into the settled substrate — rain-fed fertility, ice
  // caps, per-species ecology — then the founding scan re-runs so sites see
  // the climate-adjusted crowds (planet-game.ts's own sequence, verbatim).
  if (spec.settle && regionClimate) {
    applyClimate(prep.grid, regionClimate, { seaHeight: SEA_HEIGHT });
    applyEcology(prep.grid, { species: DEFAULT_BIOSPHERE, seaHeight: SEA_HEIGHT, perSpecies: true });
    const ice = prep.grid.fields.ice;
    prep.sites = findFoundingSites(prep.grid, REGION_FOUNDING).filter(s => ice[s.cell] < 1);
  }

  return { spec, grid: prep.grid, sites: spec.settle ? prep.sites : [], geology, metric };
}
