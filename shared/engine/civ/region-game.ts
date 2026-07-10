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

/** Deep gate for a region-scoped `world` object. */
export function parseRegionWorld(raw: unknown, path: string): RegionWorldSpec {
  if (!isObj(raw)) fail(path, "expected an object (the region definition)");
  for (const k of Object.keys(raw)) {
    if (!["size", "geology", "settle", "rain"].includes(k)) {
      fail(`${path}.${k}`, "unknown field (allowed: size, geology, settle, rain)");
    }
  }

  let cols = 96;
  let rows = 64;
  if ("size" in raw) {
    const s = raw.size;
    if (!isObj(s)) fail(`${path}.size`, "expected an object");
    for (const k of Object.keys(s)) {
      if (!["cols", "rows"].includes(k)) fail(`${path}.size.${k}`, "unknown field (allowed: cols, rows)");
    }
    if ("cols" in s) {
      cols = num(s.cols, `${path}.size.cols`, 8, 256);
      if (!Number.isInteger(cols)) fail(`${path}.size.cols`, "must be an integer");
    }
    if ("rows" in s) {
      rows = num(s.rows, `${path}.size.rows`, 8, 256);
      if (!Number.isInteger(rows)) fail(`${path}.size.rows`, "must be an integer");
    }
  }

  let seed = 1;
  let epochs = 350;
  let plates: number | undefined;
  let continentR: number | undefined;
  let hotspots: number | undefined;
  if ("geology" in raw) {
    const g = raw.geology;
    if (!isObj(g)) fail(`${path}.geology`, "expected an object");
    for (const k of Object.keys(g)) {
      if (!["seed", "epochs", "plates", "continentR", "hotspots"].includes(k)) {
        fail(`${path}.geology.${k}`, "unknown field (allowed: seed, epochs, plates, continentR, hotspots)");
      }
    }
    if ("seed" in g) seed = num(g.seed, `${path}.geology.seed`, 0, Number.MAX_SAFE_INTEGER);
    if ("epochs" in g) epochs = num(g.epochs, `${path}.geology.epochs`, 0, 5000);
    if ("plates" in g) plates = num(g.plates, `${path}.geology.plates`, 2, 32);
    if ("continentR" in g) continentR = num(g.continentR, `${path}.geology.continentR`, 0.05, 1.5);
    if ("hotspots" in g) hotspots = num(g.hotspots, `${path}.geology.hotspots`, 0, 64);
  }

  let settle = true;
  if ("settle" in raw) {
    if (typeof raw.settle !== "boolean") fail(`${path}.settle`, "must be true or false");
    settle = raw.settle;
  }
  const rain = "rain" in raw ? num(raw.rain, `${path}.rain`, 0, 10) : 1;

  return {
    size: { cols, rows },
    geology: { seed, epochs, ...(plates !== undefined ? { plates } : {}), ...(continentR !== undefined ? { continentR } : {}), ...(hotspots !== undefined ? { hotspots } : {}) },
    settle, rain,
  };
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
