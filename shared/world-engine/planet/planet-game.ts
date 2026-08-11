/**
 * The PLANET scope builder — the composition helper that turns a world
 * document's `game` settings (scope: "planet") into a living planet:
 *
 *   world JSON → cube-sphere lattice → sphere tectonics (a baked, causal
 *   terrain history) → settled substrate (rivers, fertility, wild crowds,
 *   founding candidates) → a PlanetSurface the quadtree renderer draws.
 *
 * Validation follows the module law: the manifest kernel gated the SHAPE
 * of `game`; this builder owns the deep validation of the planet-scoped
 * `world` object — unknown fields and out-of-range numbers are path-exact
 * refusals, never skips.
 *
 * The founding candidates ride along in the result: they are tomorrow's
 * `initial_focus` targets (focus a town = focus a site) and today's lab
 * readout. Deterministic end to end — same document, same planet.
 */
import type { GameSettings } from "../kernel/manifest";
import { makeCubeSphereTopology, type GridTopology } from "../kernel/cells/topology";
import { deserializeGrid, findFoundingSites, recomputeGridFlows, type CellGrid, type FoundingSite } from "../kernel/cells/index";
import { resolveSiteFocus, type SiteFocus } from "../kernel/cells/site-focus";
import { runSphereTectonics, type SphereTectonicWorld, type TectonicFrame } from "../kernel/geology/sphere-tectonics";
import { bakeCellAuthors } from "../kernel/geology/sphere-tectonics";
import { SEA_HEIGHT } from "../kernel/geology/tectonics";
import { prepareSubstrateOn } from "../kernel/civ/tri";
import { foundingScan } from "../kernel/civ/bands";
import { REAL_SCALE, resolveWorldScale, type WorldScaleSpec } from "../scale";
import type { FoundingOpts } from "../kernel/cells/worldgen";
import { climateFields, applyClimate, type ClimateFields } from "./climate";
import { applyEcology, biomePalette, DEFAULT_BIOSPHERE } from "./ecology";
import { substrateSurface, type PlanetSurface, type PlanetPalette, type RGB } from "./surface";
import { attachRiverRelief, type RiverRelief } from "./rivers";
import { createRoutePaint, type RoutePaint } from "./route-paint";
import { EARTHLIKE_BLUE, hexToLinear } from "./palettes";
import { validateFields, type FieldSpec, type GroupSpec } from "../kernel/spec-schema";
import { GEOLOGY_FIELDS } from "../kernel/civ/region-game";

export interface PlanetWorldSpec {
  topology: { kind: "cube-sphere"; faceN: number };
  geology: {
    seed: number;
    epochs: number;
    plates?: number;
    continentR?: number;
    hotspots?: number;
  };
  /** Mature the substrate after baking (rivers carve, fertility greens,
   *  wild crowds pool — what the civ layer founds on). Default true. */
  settle: boolean;
  /** Climate knob: multiplies the substrate's rain sources (default 1). */
  rain: number;
  /** LARGE-SCALE CLIMATE (climate.ts): per-cell rain/temperature fields —
   *  rain-fed fertility and polar ice caps, folded in after the settle.
   *  Omitted = earthlike defaults (meanTempC 14, wetness 1); the field
   *  stays absent so older specs parse byte-identically. */
  climate?: { meanTempC: number; wetness: number };
  /** Founding-scan overrides (settlement density). Omitted = the map-scope
   *  defaults; see parsePlanetWorld's note on planetary scale. */
  founding?: { threshold: number; radius: number; minSpacing: number; maxHarvest: number };
  /** Planet radius in render units (default 2000). */
  radius: number;
  /** Max mountain elevation as a fraction of the radius (default 0.005 —
   *  the renderer's honest silhouette default; NOT exaggerated. Worlds
   *  that want drama opt in explicitly). */
  relief: number;
  /** Sub-cell surface-detail amplitude (surface.ts `detail`; default 0.6). */
  detail: number;
  /** Terrain colour bands. Omitted = earthlike; solar-system planets get one
   *  derived from their physics (Mars red, Moon grey, ice white, …). */
  palette?: PlanetPalette;
  /** Quest-giving residents per founded town (0..3; default 0). */
  questCount?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, `must be a number (${min}..${max})`);
  if (v < min || v > max) fail(path, `out of range (${min}..${max})`);
  return v;
}

/** GRID PERSONS one tier-0 founding raises — the FOUND-SMALL take
 *  (grand-dream civilization-emergence §2a). THE tier's one content
 *  declaration about founding; everything else in the scan derives from it
 *  through Gate A (growth phase C §3.1, `kernel/civ/bands.ts foundingScan`). */
const PLANET_FOUND_POP = 100;

/** The founding scan at REALISM — the candidate readout's defaults, and what
 *  a world that declares nothing about its settlement gap gets.
 *
 *  `minSpacing` stays a CHART number here, deliberately: a tier-0 cell IS the
 *  capital lattice (417 km wide on a real planet), so the day's-walk law that
 *  `townSpacingM` states is a TIER-1 fact — `planet/refine.ts` and
 *  `planet/border.ts` are where it binds. A world that DECLARES its own gap
 *  (`scale.gap_compression`, or `planet_compression` uniformly) is making a
 *  claim about tier 0 too, and `planetFoundingOpts` derives the spacing for it.
 *
 *  Declared ABOVE the descriptor that cites its numbers (const TDZ). */
const PLANET_FOUNDING = foundingScan({
  scale: REAL_SCALE, foundPop: PLANET_FOUND_POP, minSpacing: 6,
});

/** True when the world SAYS something about how far apart its towns stand —
 *  the declaration that lets tier-0 spacing derive rather than sit in the
 *  chart's own units. */
function declaresSettlementGap(spec: WorldScaleSpec | null): boolean {
  return !!spec && ("gap_compression" in spec || "planet_compression" in spec);
}

/** THE SCAN THIS PLANET FOUNDS BY. Authored `world.founding` wins (content
 *  outranks derivation); otherwise Gate A's closed form, with the spacing
 *  derived when — and only when — the world declared a gap to derive it from. */
export function planetFoundingOpts(
  spec: PlanetWorldSpec, scale: WorldScaleSpec | null = null,
): FoundingOpts {
  if (spec.founding) return spec.founding;
  if (!declaresSettlementGap(scale)) return PLANET_FOUNDING;
  // Chart pitch: a cube-sphere face spans a quarter turn in `faceN` cells.
  const cellSizeM = ((Math.PI / 2) * spec.radius) / spec.topology.faceN;
  return foundingScan({
    scale: resolveWorldScale(scale), foundPop: PLANET_FOUND_POP, cellSizeM,
    minSpacingFloorCells: 1,
  });
}

const PLANET_TOPOLOGY_FIELDS: readonly FieldSpec[] = [
  // kind is required-and-fixed: a planet is a curved lattice. Same message
  // whether the key is missing or wrong (a planet cannot be flat).
  { key: "kind", kind: "literal", constant: "cube-sphere", required: true,
    requiredMessage: 'a planet is a curved lattice — expected "cube-sphere" (icosahedral hex will join it)',
    invalidMessage: 'a planet is a curved lattice — expected "cube-sphere" (icosahedral hex will join it)',
    facet: "interior", label: "Lattice" },
  { key: "faceN", kind: "int", min: 2, max: 128, default: 24, facet: "interior", label: "Face resolution" },
];

const PLANET_CLIMATE_FIELDS: readonly FieldSpec[] = [
  { key: "meanTempC", kind: "number", min: -100, max: 100, default: 14, facet: "boundary", label: "Mean temp (°C)" },
  { key: "wetness", kind: "number", min: 0, max: 10, default: 1, facet: "boundary", label: "Wetness" },
];

const PLANET_FOUNDING_FIELDS: readonly FieldSpec[] = [
  { key: "threshold", kind: "number", min: 0, max: 1e6, default: PLANET_FOUNDING.threshold, facet: "interior", label: "Threshold" },
  { key: "radius", kind: "number", min: 1, max: 8, default: PLANET_FOUNDING.radius, facet: "interior", label: "Radius" },
  { key: "minSpacing", kind: "number", min: 1, max: 64, default: PLANET_FOUNDING.minSpacing, facet: "interior", label: "Min spacing" },
  { key: "maxHarvest", kind: "number", min: 1, max: 1e6, default: PLANET_FOUND_POP, facet: "interior", label: "Max harvest" },
];

/** The planet scope's `world` descriptor. `geology` is the SHARED sub-spec —
 *  a planet and a region grow terrain by the same causal chain. */
export const PLANET_WORLD_FIELDS: GroupSpec = {
  objectMessage: "expected an object (the planet definition)",
  fields: [
    { key: "topology", kind: "object", fields: PLANET_TOPOLOGY_FIELDS, default: { kind: "cube-sphere", faceN: 24 },
      facet: "interior", label: "Topology" },
    { key: "geology", kind: "object", fields: GEOLOGY_FIELDS, default: { seed: 1, epochs: 350 },
      facet: "boundary", label: "Geology" },
    { key: "settle", kind: "boolean", default: true, facet: "interior", label: "Settle",
      description: "Mature the substrate after baking (rivers, fertility, wild crowds)." },
    { key: "rain", kind: "number", min: 0, max: 10, default: 1, facet: "interior", label: "Rain",
      description: "Multiplies the substrate's rain sources." },
    { key: "climate", kind: "object", fields: PLANET_CLIMATE_FIELDS, facet: "boundary", label: "Climate",
      description: "Large-scale climate; absent = earthlike (meanTempC 14, wetness 1)." },
    { key: "radius", kind: "number", min: 1, max: 1e9, default: 2000, facet: "boundary", label: "Radius",
      description: "Planet radius in render units." },
    { key: "relief", kind: "number", min: 0.001, max: 0.2, default: 0.005, facet: "interior", label: "Relief",
      description: "Max mountain elevation as a fraction of the radius." },
    { key: "detail", kind: "number", min: 0, max: 5, default: 0.6, facet: "interior", label: "Surface detail" },
    { key: "palette", kind: "custom", validate: (v, p) => parsePalette(v, p), facet: "interior", label: "Palette",
      description: 'Terrain colour bands; each is "#rrggbb" or an [r,g,b] linear tuple.' },
    { key: "founding", kind: "object", fields: PLANET_FOUNDING_FIELDS, facet: "interior", label: "Founding",
      description: "Settlement-density overrides for the founding scan." },
    { key: "questCount", kind: "int", min: 0, max: 3, facet: "interior", label: "Quests per town",
      description: "Quest-giving residents per founded town (0..3; default 0)." },
  ],
};

/** Deep gate for a planet-scoped `world` object. */
export function parsePlanetWorld(raw: unknown, path: string): PlanetWorldSpec {
  return validateFields(raw, PLANET_WORLD_FIELDS, path) as unknown as PlanetWorldSpec;
}

/** A terrain palette in the spec: each of the 6 bands is a "#rrggbb" hex or an
 *  [r,g,b] linear tuple; omitted bands fall back to the earthlike scheme. */
function parsePalette(raw: unknown, path: string): PlanetPalette {
  if (!isObj(raw)) fail(path, "expected an object of colour bands");
  const bands = ["oceanFloor", "oceanSurface", "sand", "grass", "forest", "rock", "snow"] as const;
  for (const k of Object.keys(raw)) {
    if (!(bands as readonly string[]).includes(k)) fail(`${path}.${k}`, `unknown band (allowed: ${bands.join(", ")})`);
  }
  const band = (v: unknown, p: string): RGB => {
    if (typeof v === "string") {
      if (!/^#?[0-9a-fA-F]{6}$/.test(v)) fail(p, 'must be a "#rrggbb" hex string');
      return hexToLinear(v);
    }
    if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")) {
      return [num(v[0], `${p}[0]`, 0, 1), num(v[1], `${p}[1]`, 0, 1), num(v[2], `${p}[2]`, 0, 1)];
    }
    fail(p, 'must be a "#rrggbb" hex or an [r,g,b] tuple (0..1)');
  };
  const out = { ...EARTHLIKE_BLUE };
  for (const k of bands) if (k in raw) (out as Record<string, RGB>)[k] = band((raw as Record<string, unknown>)[k], `${path}.${k}`);
  return out;
}

export interface BuiltPlanet {
  spec: PlanetWorldSpec;
  topo: GridTopology;
  /** The settled substrate — the same grid a civ layer would found on. */
  grid: CellGrid;
  /** Founding candidates on the settled substrate (empty when unsettled). */
  sites: FoundingSite[];
  /** The tectonic history. Absent when the planet was rebuilt from a
   *  worker's baked fields (rebuiltPlanetWorld) — the render/civ consumers
   *  read the SUBSTRATE, not the history. */
  geology?: { world: SphereTectonicWorld; frames: TectonicFrame[] };
  surface: PlanetSurface;
  /** The river paint/notch index (attachRiverRelief fills this in both build
   *  paths) — the host's handle for merging a refined region's streams into
   *  the terrain when the region loads (`addRivers`). Absent on riverless
   *  worlds. */
  riverRelief?: RiverRelief;
  /** ROAD PAINT (planet/route-paint.ts) — always present, starts EMPTY: the
   *  host merges route sets as they appear (interstates at founding, region
   *  lanes on refine, stitches) and repaints standing chunks. */
  routePaint: RoutePaint;
}

/** The surface both build paths share — one construction, one look. */
function surfaceFor(spec: PlanetWorldSpec, grid: CellGrid): PlanetSurface {
  return substrateSurface({
    substrate: grid,
    radius: spec.radius,
    maxElevation: spec.relief * spec.radius,
    seaHeight: SEA_HEIGHT,
    seed: spec.geology.seed,
    detail: spec.detail,
    palette: spec.palette,
    // Ice caps paint snow-white where applyClimate froze the land (the
    // sampler no-ops when the grid carries no ice field — unsettled worlds).
    iceField: "ice",
    // Where the rivers cut down to bedrock, the ground reads as rock and gets
    // its strata (terrain-shading.ts) — so a river valley is stone-walled
    // instead of green to the waterline. No-ops on a substrate that carves
    // nothing. Rivers don't make strata; they expose them.
    valleyField: "valley",
    // Vegetation reads as its DOMINANT PLANT (ecology.ts): forest deep
    // green, steppe meadow. No-ops when the grid carries no biome field.
    biomeField: "biome",
    biomeColors: biomePalette(DEFAULT_BIOSPHERE),
  });
}

/** Rebuild a flyable/foundable planet from a WORKER's bake: the serialized
 *  grid (serializeGrid) + sites + the spec that produced them. Everything a
 *  consumer reads (substrate fields, founding sites, terrain surface) is
 *  identical to buildPlanetWorld's output; only the tectonic history stays
 *  behind in the worker. */
export function rebuiltPlanetWorld(
  spec: PlanetWorldSpec,
  gridJson: string,
  sites: FoundingSite[],
): BuiltPlanet {
  const grid = deserializeGrid(gridJson);
  if (!grid) throw new Error("rebuiltPlanetWorld: the baked grid failed to deserialize");
  // Heal bakes serialized before the drainage pointer existed: without
  // `riverDown`, river extraction falls back to raw-height descent and
  // SHREDS the network on every flat. Recomputing is pure — a healthy grid
  // re-derives its identical accumulation and just gains the pointers.
  if (grid.fields.river && !grid.fields.riverDown) recomputeGridFlows(grid);
  const built: BuiltPlanet = {
    spec, topo: grid.topo, grid, sites,
    surface: surfaceFor(spec, grid),
    routePaint: createRoutePaint(spec.radius),
  };
  built.surface.roadTintAt = built.routePaint.tintAt;
  attachRiverRelief(built); // same fold as buildPlanetWorld — a rebuilt planet renders identically
  return built;
}

/** Build the planet a `scope: "planet"` game plays in. */
export function buildPlanetWorld(game: GameSettings, label = "game"): BuiltPlanet {
  if (game.scope !== "planet") {
    fail(`${label}.scope`, `buildPlanetWorld builds "planet" games (got "${game.scope}")`);
  }
  const spec = parsePlanetWorld(game.world, `${label}.world`);

  const topo = makeCubeSphereTopology(spec.topology.faceN);
  const geology = runSphereTectonics({
    topo,
    seed: spec.geology.seed,
    epochs: spec.geology.epochs,
    plates: spec.geology.plates,
    continentR: spec.geology.continentR,
    hotspots: spec.geology.hotspots,
    // Final frame only: nothing on the planet path consumes intermediate
    // keyframes (scrub tooling runs on the flat stepper), and each one
    // pays a full depression-fill + bake. A future scrubber passes its
    // own cadence here.
    keyframeEvery: 0,
  });
  const authors = bakeCellAuthors(geology.world);

  // LARGE-SCALE CLIMATE (climate.ts) — computed BEFORE the substrate settles,
  // because the rivers drink it: the per-cell rain, normalized to land-mean 1,
  // seeds the `runoff` field the river var reads as its flow `sourceField`.
  // Accumulation then measures upstream RAINFALL, not bare catchment area —
  // dense networks in wet country, sparse in deserts. The normalization makes
  // it a pure REDISTRIBUTION (the planet's total water budget, and with it the
  // shared watercourse thresholds, keep their calibration; `spec.rain` stays
  // the global multiplier, and `wetness` — a constant factor — cancels here,
  // acting on fertility as before). Climate needs only the pre-settle heights,
  // and heights are static through the settle, so the SAME fields fold into
  // fertility/ice afterwards.
  let climate: ClimateFields | null = null;
  let runoffAt: ((c: number) => number) | undefined;
  if (spec.settle) {
    const preHeight = new Float64Array(topo.n);
    for (let c = 0; c < topo.n; c++) preHeight[c] = Math.max(0, Math.min(63, Math.round(authors.height(c))));
    climate = climateFields({
      topo,
      height: preHeight,
      seaHeight: SEA_HEIGHT,
      metresPerUnit: (spec.relief * spec.radius) / (63 - SEA_HEIGHT),
      radiusM: spec.radius,
      meanTempC: spec.climate?.meanTempC,
      wetness: spec.climate?.wetness,
    });
    let sum = 0, land = 0;
    for (let c = 0; c < topo.n; c++) {
      if (preHeight[c] >= SEA_HEIGHT) { sum += climate.rain[c]; land++; }
    }
    const mean = land > 0 ? sum / land : 0;
    if (mean > 1e-9) {
      const rain = climate.rain;
      const inv = 1 / mean;
      runoffAt = (c: number): number => rain[c] * inv;
    }
  }

  // THE SCAN IS DERIVED (§3.1) — Gate A's closed form, not a per-caller
  // aesthetic. One object, read by the settle pass and by every rescan below.
  const founding = planetFoundingOpts(spec, game.scale);
  const prep = prepareSubstrateOn({
    topology: { kind: "cube-sphere", faceN: spec.topology.faceN },
    height: authors.height,
    ore: authors.ore,
    founding,
    settle: spec.settle,
    rain: spec.rain,
    runoff: runoffAt,
  });

  // Fold the climate into the settled substrate — rain-fed fertility, ice
  // caps — then the founding scan re-runs so sites see the climate-adjusted
  // crowds. A candidate whose center froze is no site at all.
  if (spec.settle && climate) {
    applyClimate(prep.grid, climate, { seaHeight: SEA_HEIGHT });
    // BIOMES from the climate: forest / steppe / etc. compete for each cell
    // (ecology.ts). Writes grid.fields.biome; founding then reads a settled,
    // climated AND biomed substrate.
    applyEcology(prep.grid, { species: DEFAULT_BIOSPHERE, seaHeight: SEA_HEIGHT });
    const ice = prep.grid.fields.ice;
    prep.sites = findFoundingSites(prep.grid, founding)
      .filter(s => ice[s.cell] < 1);
  }

  const surface = surfaceFor(spec, prep.grid);

  const built: BuiltPlanet = {
    spec, topo, grid: prep.grid, sites: spec.settle ? prep.sites : [], geology, surface,
    routePaint: createRoutePaint(spec.radius),
  };
  built.surface.roadTintAt = built.routePaint.tintAt;
  // Fold the river network back into the terrain: recolor + valley notch
  // (rivers.ts). After surfaceFor so it wraps the finished surface.
  attachRiverRelief(built);
  return built;
}

// --- initial_focus -------------------------------------------------------------

export type PlanetFocus = SiteFocus;

/** Resolve a planet game's `initial_focus` against the built world —
 *  planet focus targets are the founding sites the settled substrate
 *  proposed (the generic site-focus contract, cells/site-focus.ts). */
export function resolvePlanetFocus(
  built: BuiltPlanet,
  focus: GameSettings["initialFocus"],
  label = "game",
): PlanetFocus | null {
  return resolveSiteFocus(built.grid, built.sites, focus, label);
}
