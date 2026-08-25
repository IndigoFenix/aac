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
  classifyNode, constraintCeiling, findFoundingSites, markShadows,
  type CeilingOpts, type CeilingReading, type CellGrid, type FoundingOpts, type FoundingSite,
  type NodeReading, type NodeTypingOpts,
} from "../kernel/cells/index.js";
import { hinterlandJobs, cityLicense, type CityLicense } from "../kernel/civ/jobs.js";
import { TIER_POP_CAP, type SettlementTier } from "../scale.js";

/** GRID PERSONS one TIER-1 founding raises — a hamlet's worth, against the
 *  capital's hundred (`planet-game.ts PLANET_FOUND_POP`). The region and
 *  border tiers' ONE content declaration about founding: Gate A's closed
 *  form (`kernel/civ/bands.ts foundingScan`, growth phase C §3.1) derives
 *  the crowd density that keeps them, `townSpacingM` the gap between them,
 *  and the take itself is this number. Lives here rather than in
 *  `refine.ts` because `border.ts` reads it too and refine already imports
 *  border — one direction only. */
export const REGION_FOUND_POP = 25;

// ── SPILL FOUNDING (food-scale-round.md "# STAGE β", survey correction 8 +
// β3) — the user's law: "the region answers with more towns, never
// overstuffed ones". A founding site's potential crowd is the SAME formula
// `foundCitiesFromSites` uses for startPop — min(2000, round(density × 5)),
// pre-visit-clamp — but the village tier seats only `TIER_POP_CAP.village`
// of it. The excess is a real crowd the land wanted to seat; Stage β's
// answer is that it founds MORE villages on marginal land instead of
// inflating any single row past its tier.

/** THE ONE HONEST LEVER (correction 8): the first scan already accepts every
 *  spacing-disjoint cell clearing gateAThreshold, so extra sites can only
 *  come from BELOW-threshold land — pressure colonizes marginal land, a
 *  daughter settlement provisioned by its mother clears a lower founding
 *  bar (historically honest). 0.5 is the FLOOR — no deeper relaxation —
 *  and spacing NEVER shrinks: the lattice is the priced staple catchment
 *  (`townSpacingM`), not a crowding knob. */
export const SPILL_THRESHOLD_RELAX = 0.5;

/** THE REGION'S SPILL BUDGET: Σ over the FIRST-PASS interior sites of the
 *  crowd the village tier turns away — `max(0, min(2000, round(density × 5))
 *  − TIER_POP_CAP.village)` per site. The 2000 sanity clamp applies BEFORE
 *  the subtraction (a metropolis-dense site owes at most 1 860, exactly as
 *  its startPop could never exceed 2 000), and the per-site floor of 0 means
 *  a hamlet-sized site owes nothing.
 *
 *  SINGLE DISCHARGE: spill sites do NOT recurse — their own potential never
 *  re-enters this sum. The budget is the first-pass truth about the land;
 *  a recursive pass would mint crowd from the relaxation itself (each
 *  relaxed round funding the next), which is exactly the overstuffing the
 *  user's law forbids. One extra pass, done. */
export function spillBudget(sites: ReadonlyArray<Pick<FoundingSite, "density">>): number {
  let sum = 0;
  for (const s of sites) {
    sum += Math.max(0, Math.min(2000, Math.round(s.density * 5)) - TIER_POP_CAP.village);
  }
  return sum;
}

/** THE SECOND PASS (β3): re-scan at the relaxed threshold with the SAME
 *  spacing and the first-pass sites as occupied fixed points, then take
 *  rank-ordered marginal sites until their seats (`TIER_POP_CAP.village`
 *  each) cover the budget — `taken × 140 ≥ budget`, i.e. ceil(budget/140)
 *  sites — or candidates exhaust. A candidate above the original threshold
 *  cannot reappear here: anything spacing-disjoint from the whole first-pass
 *  set would already have been accepted by that pass's greedy sweep, so
 *  every taken site is genuinely marginal land.
 *
 *  `filter` mirrors the caller's post-scan site veto (refine's ice filter)
 *  and runs BEFORE the take, so a vetoed cell never consumes seats of the
 *  budget. Returns candidates too — the ledger's measurement seam. */
export function spillFoundingSites(
  grid: CellGrid,
  founding: FoundingOpts,
  firstPass: readonly FoundingSite[],
  budget: number,
  filter?: (s: FoundingSite) => boolean,
): { candidates: FoundingSite[]; taken: FoundingSite[] } {
  if (budget <= 0) return { candidates: [], taken: [] };
  const relaxed = findFoundingSites(grid, {
    ...founding,
    threshold: founding.threshold * SPILL_THRESHOLD_RELAX,
    occupied: [
      ...(founding.occupied ?? []),
      ...firstPass.map(s => [s.x, s.y] as [number, number]),
    ],
  });
  const candidates = filter ? relaxed.filter(filter) : relaxed;
  const taken = candidates.slice(
    0, Math.min(candidates.length, Math.ceil(budget / TIER_POP_CAP.village)),
  );
  return { candidates, taken };
}

export interface PlanetCity {
  /** The substrate cell the city sits on — its identity AND its town seed. */
  cell: number;
  /** THE SETTLEMENT TIER this row founds at (food-scale-round ⑩): names the
   *  BODY the visited town builds (`REAL_TIER_EXTENT_M` through plan.ts's
   *  `tierExtentM` seat). The village tier of `planet/refine.ts` /
   *  `planet/border.ts` stamps `"village"`; tier-0 capitals DELIBERATELY
   *  carry none — absent = `"town"`, byte-identical to everything that
   *  existed before the tier was threaded (the `city` tier is unmeasured;
   *  see `TIER_POP_CAP`). */
  tier?: SettlementTier;
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
