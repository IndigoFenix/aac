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
import { runTectonics, bakeAuthors, type TectonicWorld, type TectonicFrame } from "../geology/tectonics";
import { prepareSubstrate } from "./tri";
import { validateFields, type FieldSpec, type GroupSpec } from "../spec-schema";

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
}

/** Build the flat map a `scope: "region"` game plays in. */
export function buildRegionWorld(game: GameSettings, label = "game"): BuiltRegion {
  if (game.scope !== "region") {
    fail(`${label}.scope`, `buildRegionWorld builds "region" games (got "${game.scope}")`);
  }
  const spec = parseRegionWorld(game.world, `${label}.world`);

  const geology = runTectonics({
    cols: spec.size.cols,
    rows: spec.size.rows,
    seed: spec.geology.seed,
    epochs: spec.geology.epochs,
    plates: spec.geology.plates,
    continentR: spec.geology.continentR,
    hotspots: spec.geology.hotspots,
  });
  const authors = bakeAuthors(geology.world);

  const prep = prepareSubstrate({
    cols: spec.size.cols,
    rows: spec.size.rows,
    height: authors.height,
    ore: authors.ore,
    founding: REGION_FOUNDING,
    settle: spec.settle,
    rain: spec.rain,
  });

  return { spec, grid: prep.grid, sites: spec.settle ? prep.sites : [], geology };
}
