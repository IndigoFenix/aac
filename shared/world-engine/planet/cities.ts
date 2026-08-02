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
import {
  classifyNode, constraintCeiling, markShadows,
  type CeilingOpts, type CeilingReading, type FoundingSite, type NodeReading, type NodeTypingOpts,
} from "../kernel/cells/index.js";
import { hinterlandJobs, cityLicense, type CityLicense } from "../kernel/civ/jobs.js";

export interface PlanetCity {
  /** The substrate cell the city sits on — its identity AND its town seed. */
  cell: number;
  /** Deterministic display name (unique within the planet). */
  name: string;
  /** Unit direction from the planet's center (topo.pos3). */
  dir: readonly [number, number, number];
  /** Σ forage in the founding box — the crowd the founding harvested. */
  density: number;
  /** The radius-3 charter box the town is founded from (descend's shape). */
  charter: { farmland: number; ore_access: number; timberland: number };
  /** Founding population (descend's souls-per-grid-person clamp). */
  startPop: number;
  /** THE NODE TYPE (resources-and-trade.md §②): what this geography makes
   *  the settlement — its job-description seed, with the printed sentence
   *  and the water-first veto. Geography chooses, spec marks. */
  node: NodeReading;
  /** THE DERIVED CEILING (§④, opt-in via `ceilings`): the min of the
   *  site's constraints, the §② water veto turned into a real waystation
   *  cap, and the founding population clamped under it. */
  cap?: CeilingReading;
  /** GATE C at founding (settlement-emergence §5, opt-in via
   *  `ceilings.jobs`): the site's hinterland jobs read off its own node
   *  taxonomy — terrain only at this tier; the graph and the refineries
   *  live where settlements actually run (tri). No job ⇒ the founding
   *  crowd caps at the village line too. */
  license?: CityLicense;
}

export interface PlanetCityOpts {
  /** Optional cap (best sites first). Default: UNCAPPED — a real-sized world
   *  founds a city at every site that can feed itself. */
  maxCities?: number;
  /** Minimum farmland in the charter box — a granary-less mining camp
   *  honestly starves (we watched it happen), so it never becomes a city. */
  minFarmland?: number;
  /** Node-typing thresholds (defaults = the substrate's own lines). */
  nodeTyping?: NodeTypingOpts;
  /** Raw-bulk market reach in CELLS (node-typing rawBulkReachCells) —
   *  when present, the SHADOW pass runs over the founded set: surplus
   *  country with no other settlement within reach becomes a `shadow`
   *  node (distance is the reason refining exists, §③). Absent = skipped
   *  (the tier doesn't know its cell pitch). */
  rawReachCells?: number;
  /** CONSTRAINT CEILINGS (§④) — when present, every founded city carries
   *  its derived `cap` (min-of-constraints over its supply zone; the §②
   *  water veto caps a dry site at a waystation) and its startPop is
   *  clamped under the ceiling. `freshWater` comes from the node reading
   *  — never declare it here. `jobs` adds Gate C (§5): a site whose node
   *  taxonomy holds no hinterland job founds at most `villageHeads`
   *  souls. Absent = the shipped clamp, bit for bit. */
  ceilings?: Omit<CeilingOpts, "freshWater"> & { jobs?: { villageHeads: number } };
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

/** What the founding helper reads off a substrate — a CellGrid satisfies it.
 *  `n`/`neighbours`/`maxDegree`/`dist2` feed the node classifier; thinner
 *  grids degrade gracefully (node-typing.ts NodeGrid). */
export interface SubstrateGrid {
  topo: {
    n?: number;
    disk(i: number, r: number, visit: (cell: number, d: number) => void): void;
    neighbours?(i: number, out: number[]): number;
    maxDegree?: number;
    dist2?(a: number, b: number): number;
  };
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
  const siteCells: number[] = []; // SITE cell per accepted city (typing/distances)
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

    // Geography chooses, spec marks: the job-description seed, read off
    // the SITE's cell (typing keys on terrain, not the host key space).
    const node = classifyNode(opts.grid, site.cell, opts.nodeTyping);
    // The site's crowd founds the town (a few souls per grid person —
    // clamped so a thin camp still functions and a metropolis stays sane).
    let startPop = Math.max(40, Math.min(2000, Math.round(site.density * 5)));
    // §④: the derived ceiling — the veto is the node's own freshWater
    // reading, and nobody founds above what the constraints feed. With
    // `jobs`, Gate C mins in: no hinterland job in the taxonomy ⇒ the
    // crowd caps at the village line, whatever the land could feed.
    let cap: CeilingReading | undefined;
    let license: CityLicense | undefined;
    if (opts.ceilings) {
      const { jobs, ...ceilingOpts } = opts.ceilings;
      cap = constraintCeiling(opts.grid, site.cell, { ...ceilingOpts, freshWater: node.freshWater });
      let limit = cap.ceiling;
      if (jobs) {
        license = cityLicense(hinterlandJobs({ node }), jobs.villageHeads);
        limit = Math.min(limit, license.cap);
      }
      startPop = Math.max(1, Math.min(startPop, limit));
    }

    cities.push({
      cell: key,
      name,
      dir: opts.dirOf(site.cell),
      density: site.density,
      charter,
      startPop,
      node,
      ...(cap ? { cap } : {}),
      ...(license ? { license } : {}),
    });
    siteCells.push(site.cell);
  }
  // The shadow pass wants SITE cells for distances; cities carry host KEYS.
  // Pair them up, mark, done — the readings are shared references.
  if (opts.rawReachCells !== undefined && opts.grid.topo.dist2) {
    markShadows(
      opts.grid,
      cities.map((c, i) => ({ cell: siteCells[i], node: c.node })),
      opts.rawReachCells,
    );
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
