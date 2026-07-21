// shared/world-engine/planet/cities.ts
//
// THE CIV LAYER'S FIRST RUNG: a settled planet's founding sites become its
// CITIES. The substrate scan (worldgen's findFoundingSites) already found
// where crowds pool on fertile, watered land — this module just commits the
// best of them to named cities a visitor can see from orbit and land at.
//
// Data only, THREE-free, deterministic: the same built planet always yields
// the same cities with the same names, so a city is an ADDRESS (its cell), not
// a session artifact — every visit founds the identical town from its charter
// (the descend seam's law).

import type { BuiltPlanet } from "./planet-game.js";
import type { FoundingSite } from "../kernel/cells/index.js";

export interface PlanetCity {
  /** The substrate cell the city sits on — its identity AND its town seed. */
  cell: number;
  /** Deterministic display name (unique within the planet). */
  name: string;
  /** Unit direction from the planet's center (topo.pos3). */
  dir: readonly [number, number, number];
  /** Σ people in the founding box — the crowd the founding harvested. */
  density: number;
  /** The radius-3 charter box the town is founded from (descend's shape). */
  charter: { farmland: number; ore_access: number; timberland: number };
  /** Founding population (descend's souls-per-grid-person clamp). */
  startPop: number;
}

export interface PlanetCityOpts {
  /** Optional cap (best sites first). Default: UNCAPPED — a real-sized world
   *  founds a city at every site that can feed itself. */
  maxCities?: number;
  /** Minimum farmland in the charter box — a granary-less mining camp
   *  honestly starves (we watched it happen), so it never becomes a city. */
  minFarmland?: number;
}

const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Syllable pools sized so two draws already give ~500 first parts × ~20 tails;
// collisions fall back to a numbered suffix rather than looping.
const HEADS = [
  "Al", "Bar", "Cor", "Dan", "El", "Fen", "Gal", "Hol", "Ist", "Jor",
  "Kel", "Lor", "Mar", "Nor", "Or", "Pel", "Quin", "Ral", "Sol", "Tar",
  "Umb", "Vel", "Wyn", "Yor", "Zel",
] as const;
const MIDS = ["a", "e", "i", "o", "u", "ar", "en", "il", "or", "un"] as const;
const TAILS = [
  "burg", "dale", "ford", "gate", "haven", "hollow", "mere", "mont",
  "port", "reach", "ridge", "stead", "vale", "wick",
] as const;

/** A pronounceable town name from a city-seeded rng. */
function cityName(rng: () => number): string {
  const head = HEADS[Math.floor(rng() * HEADS.length)];
  const mid = rng() < 0.5 ? MIDS[Math.floor(rng() * MIDS.length)] : "";
  const tail = TAILS[Math.floor(rng() * TAILS.length)];
  return `${head}${mid}${tail}`;
}

/** The charter box a founding reads: radius-3 sums around the site. */
function charterBox(grid: SubstrateGrid, cell: number) {
  const box = (field: string): number => {
    const arr = grid.fields[field];
    if (!arr) return 0;
    let sum = 0;
    grid.topo.disk(cell, 3, c => { sum += arr[c]; });
    return sum;
  };
  return { farmland: box("fertility"), ore_access: box("ore"), timberland: box("plant") };
}

/** What the founding helper reads off a substrate — a CellGrid satisfies it. */
export interface SubstrateGrid {
  topo: { disk(i: number, r: number, visit: (cell: number, d: number) => void): void };
  fields: Record<string, ArrayLike<number>>;
}

export interface FoundCitiesOpts extends PlanetCityOpts {
  sites: FoundingSite[];
  grid: SubstrateGrid;
  /** Name/identity seed (the world's geology seed at tier 0; a region hash
   *  at tier 1). */
  seedBase: number;
  /** Unit sphere direction of a site's cell. */
  dirOf(cell: number): readonly [number, number, number];
  /** Identity of a site in the HOST's key space (default: the cell itself.
   *  A region's villages compose (regionCell, childCell) here so tiers
   *  never collide). Also the town's deterministic seed. */
  cellKey?(cell: number): number;
}

/** The tier-agnostic founding: sites → named, chartered settlements. Used
 *  by tier 0 (planetCities — capitals) and tier 1 (region villages). */
export function foundCitiesFromSites(opts: FoundCitiesOpts): PlanetCity[] {
  const maxCities = Math.max(1, Math.floor(opts.maxCities ?? Infinity));
  const minFarmland = opts.minFarmland ?? 40;
  const cellKey = opts.cellKey ?? ((c: number) => c);

  const cities: PlanetCity[] = [];
  const taken = new Set<string>();
  for (const site of opts.sites) {
    if (cities.length >= maxCities) break;
    const charter = charterBox(opts.grid, site.cell);
    if (charter.farmland < minFarmland) continue;

    const key = cellKey(site.cell);
    const rng = mulberry32((opts.seedBase ^ Math.imul(key, 0x9e3779b1)) >>> 0);
    let name = cityName(rng);
    if (taken.has(name)) name = `${name} ${cities.length + 1}`;
    taken.add(name);

    cities.push({
      cell: key,
      name,
      dir: opts.dirOf(site.cell),
      density: site.density,
      charter,
      // The site's crowd founds the town (a few souls per grid person —
      // clamped so a thin camp still functions and a metropolis stays sane).
      startPop: Math.max(40, Math.min(2000, Math.round(site.density * 5))),
    });
  }
  return cities;
}

/**
 * Found the planet's cities from its settled substrate. Sites arrive ranked
 * (worldgen's score) and spacing-disjoint; we keep the best that can feed
 * themselves. Deterministic per built planet.
 */
export function planetCities(built: BuiltPlanet, opts: PlanetCityOpts = {}): PlanetCity[] {
  const pos3 = built.topo.pos3;
  if (!pos3) {
    throw new Error("planetCities: the topology has no pos3 — cities live on curved worlds");
  }
  return foundCitiesFromSites({
    ...opts,
    sites: built.sites,
    grid: built.grid,
    seedBase: built.spec.geology.seed,
    dirOf: cell => pos3(cell),
  });
}
