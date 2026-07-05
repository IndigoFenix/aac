/**
 * TriWorld — gate 6 (world-content.md §6): all three layers over one map.
 *
 *   Substrate  — the worldgen grid (height, rivers, fertility, ore, wild
 *                people), settled to rest before anyone founds anything.
 *   Settlement — cell-systems entities chartered against the grid.
 *   Composition— PopuSim sites born from HARVESTED crowds.
 *
 * The two tri-specific couplings, both day-boundary:
 *   Harvest founding — a founding site's crowd leaves the grid and becomes
 *     the city's population (× peopleScale souls per grid person). The
 *     transaction conserves: Δ grid people × scale = the city's birth pop.
 *     Afterwards the wild people REGROW toward the land's lure — wildlife
 *     is a renewable source, and later crowds can found later cities; the
 *     ongoing ledger is the dual layer's (births/deaths/histfigs).
 *   Mining depletion — each day a mining city's output draws down the ore
 *     tiles under it (richest first, deterministic), and its chartered
 *     ore_access follows. Ore is the substrate's one finite budget:
 *     exhausted mountains are a real long-arc event.
 */

import {
  createGrid, worldStep, pendingCount, injectTile,
  seedOreAboveTreeline, findFoundingSites, worldgenSubstrate,
  type CellGrid, type FoundingSite, type FoundingOpts, type SystemSpec,
} from "@cells/index";
import { bootDual, type DualWorld, type DualSpec, type DualNode, type DualEdge } from "./dual";

export interface TriPrep {
  grid: CellGrid;
  /** Founding candidates on the settled substrate (unweighted ranking —
   *  re-run findFoundingSites with score weights to pick biases). */
  sites: FoundingSite[];
  founding: FoundingOpts;
  treeline: number;
}

export interface PrepareOpts {
  cols: number;
  rows: number;
  /** Deterministic terrain author. */
  height: (x: number, y: number) => number;
  treeline?: number;
  oreSeed?: number;
  founding: FoundingOpts;
  /** Settle cap for the pristine substrate. */
  settleCap?: number;
  /** false = leave the substrate RAW (genesis worlds: the lab steps it
   *  live, so rivers carve and crowds pool on screen). Default true. */
  settle?: boolean;
  /** Substrate spec (default worldgenSubstrate — computed rivers, true
   *  rest; oasisSubstrate = the original sandbox's living pipeline). */
  spec?: SystemSpec;
}

/** Build the substrate (settled by default), then detect founding candidates. */
export function prepareSubstrate(opts: PrepareOpts): TriPrep {
  const treeline = opts.treeline ?? 40;
  const grid = createGrid(opts.spec ?? worldgenSubstrate, opts.cols, opts.rows);
  for (let y = 0; y < opts.rows; y++) {
    for (let x = 0; x < opts.cols; x++) {
      grid.fields.height[y * opts.cols + x] = Math.max(0, Math.min(63, Math.round(opts.height(x, y))));
    }
  }
  grid.flowDirty = true;
  seedOreAboveTreeline(grid, { treeline, seed: opts.oreSeed ?? 1 });

  // Mature the substrate: run to quiet, or to the budget — living specs
  // (oasisSubstrate) cycle forever by design, so the cap is the contract,
  // not a failure.
  if (opts.settle !== false) {
    const cap = opts.settleCap ?? 20_000;
    for (let i = 0; i < cap && pendingCount(grid) > 0; i++) worldStep(grid);
  }

  return { grid, sites: findFoundingSites(grid, opts.founding), founding: opts.founding, treeline };
}

export interface TriCharter {
  farmland: number;
  ore_access: number;
  timberland: number;
}

export interface TriCityDef {
  at: FoundingSite;
  key: string;
  name: string;
  /** Settlement scalars beyond the chartered trio (buildings etc.), may be
   *  a function of the charter. */
  scalars?: Record<string, number> | ((charter: TriCharter) => Record<string, number>);
  /** PopuSim site JSON passthrough (startpop, transmit). */
  site?: Record<string, unknown>;
}

export interface FoundTriOpts {
  base: Omit<DualSpec, "nodes" | "edges">;
  cities: TriCityDef[];
  /** Roads by city key. */
  edges: Array<[string, string]>;
  /** Souls per grid person (default 25). */
  peopleScale?: number;
  /** Charter sampling radius (default 3). */
  charterRadius?: number;
  seed: number;
  /** Mining depletion: each day, ore tiles under a city lose
   *  ore_out × rate whole units (accumulated via a carry). */
  mining?: { oreOutScalar: string; rate: number };
  /** Grid catch-up budget per day inside advanceDays (default 4; raise
   *  for living substrates whose pipeline is deeper). The lab also steps
   *  the grid at frame rate, so this mainly matters headless. */
  gridStepsPerDay?: number;
  /** EMERGENT civilization: every `every` days, scan the settled crowds
   *  for founding candidates (respecting existing cities) and found the
   *  best one — cities appear naturally as the land fills, and sculpting
   *  new fertile valleys eventually raises new towns. */
  autoFound?: {
    every: number;
    maxCities?: number;
    /** Ranking weights (the supply/demand socket). */
    score?: Array<{ field: string; weight: number }>;
    cityFactory: (site: FoundingSite, index: number, charter: TriCharter) => {
      key: string;
      name: string;
      scalars?: Record<string, number> | ((ch: TriCharter) => Record<string, number>);
      site?: Record<string, unknown>;
    };
  };
}

export interface TriWorld {
  grid: CellGrid;
  dual: DualWorld;
  /** Founded cities, in founding order — GROWS when autoFound fires. */
  cities: Array<{ key: string; x: number; y: number; harvested: number }>;
  /** Souls per harvested grid person. */
  peopleScale: number;
  charterOf(key: string): TriCharter;
  /** Σ wild people currently on the grid. */
  gridPeople(): number;
  /** Σ people harvested at founding (grid persons). */
  harvestedTotal(): number;
  /** Total grid ore remaining. */
  gridOre(): number;
  /** Advance n days: dual day + mining depletion + substrate catch-up.
   *  With no mining and a resting substrate, delegates to the dual
   *  layer's O(1) jump. */
  advanceDays(n: number): Promise<{ stepped: number; skipped: number }>;
}

function boxSum(grid: CellGrid, field: string, cx: number, cy: number, r: number): number {
  const arr = grid.fields[field];
  let sum = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= grid.rows) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= grid.cols) continue;
      sum += arr[y * grid.cols + x];
    }
  }
  return sum;
}

/** Found the cities (harvesting their crowds), boot the dual world over
 *  them, and return the coupled tri-world. */
export async function foundTri(prep: TriPrep, opts: FoundTriOpts): Promise<TriWorld> {
  const { grid } = prep;
  const scale = opts.peopleScale ?? 25;
  const charterR = opts.charterRadius ?? 3;

  const charter = (x: number, y: number): TriCharter => ({
    farmland: boxSum(grid, "fertility", x, y, charterR),
    ore_access: boxSum(grid, "ore", x, y, charterR),
    timberland: boxSum(grid, "plant", x, y, charterR),
  });

  // The founding transaction, substrate side: the crowd leaves the grid.
  const harvest = (c: FoundingSite): number => {
    let taken = 0;
    const r = prep.founding.radius;
    for (let dy = -r; dy <= r; dy++) {
      const y = c.y + dy;
      if (y < 0 || y >= grid.rows) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = c.x + dx;
        if (x < 0 || x >= grid.cols) continue;
        const cell = y * grid.cols + x;
        const here = grid.fields.people[cell];
        if (here > 0) { injectTile(grid, cell, "people", -here); taken += here; }
      }
    }
    return taken;
  };

  const cities: TriWorld["cities"] = [];
  const nodes: DualNode[] = [];
  for (const def of opts.cities) {
    const taken = harvest(def.at);
    if (taken <= 0) throw new Error(`foundTri: no crowd to harvest at (${def.at.x},${def.at.y})`);
    const ch = charter(def.at.x, def.at.y);
    const extra = typeof def.scalars === "function" ? def.scalars(ch) : (def.scalars ?? {});
    cities.push({ key: def.key, x: def.at.x, y: def.at.y, harvested: taken });
    nodes.push({
      key: def.key,
      name: def.name,
      pop: taken * scale,
      scalars: { farmland: ch.farmland, ore_access: ch.ore_access, timberland: ch.timberland, ...extra },
      site: def.site,
    });
  }
  const edges: DualEdge[] = opts.edges.map(([a, b], i) => ({ a, b, key: `road${i}` }));

  const dual = await bootDual({ ...opts.base, nodes, edges } as DualSpec, opts.seed);

  const cityIndex = new Map(cities.map((c, i) => [c.key, i] as const));
  let harvestedTotal = cities.reduce((a, c) => a + c.harvested, 0);
  let miningCarry = new Float64Array(cities.length);
  let dayCount = 0;

  /** Emergent founding: the best qualifying crowd becomes a city. */
  const maybeFound = async (): Promise<void> => {
    const auto = opts.autoFound;
    if (!auto) return;
    if (auto.maxCities !== undefined && cities.length >= auto.maxCities) return;
    const candidates = findFoundingSites(grid, {
      ...prep.founding,
      score: auto.score,
      occupied: cities.map(c => [c.x, c.y] as [number, number]),
    });
    if (candidates.length === 0) return;
    const at = candidates[0];
    const taken = harvest(at);
    if (taken <= 0) return;

    const ch = charter(at.x, at.y);
    const def = auto.cityFactory(at, cities.length, ch);
    const extra = typeof def.scalars === "function" ? def.scalars(ch) : (def.scalars ?? {});
    // Road to the nearest existing city (the first city stands alone).
    const roadEdges: Array<{ to: string }> = [];
    if (cities.length > 0) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < cities.length; i++) {
        const d2 = (cities[i].x - at.x) ** 2 + (cities[i].y - at.y) ** 2;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      roadEdges.push({ to: cities[best].key });
    }

    const idx = await dual.foundSettlement({
      key: def.key,
      name: def.name,
      pop: taken * scale, // the harvested crowd, ledgered by this tri world
      scalars: { farmland: ch.farmland, ore_access: ch.ore_access, timberland: ch.timberland, ...extra },
      site: def.site,
      edges: roadEdges,
    });
    if (idx < 0) return;
    cities.push({ key: def.key, x: at.x, y: at.y, harvested: taken });
    cityIndex.set(def.key, cities.length - 1);
    harvestedTotal += taken;
    const grown = new Float64Array(cities.length);
    grown.set(miningCarry);
    miningCarry = grown;
  };

  /** One whole unit of ore leaves the richest tile in the city's charter
   *  box (ties → lowest index) — deterministic, and the wakeup lets the
   *  substrate re-settle (lure falls, camps thin out). */
  const depleteOne = (ci: number): boolean => {
    const c = cities[ci];
    let best = -1;
    let bestOre = 0;
    for (let dy = -charterR; dy <= charterR; dy++) {
      const y = c.y + dy;
      if (y < 0 || y >= grid.rows) continue;
      for (let dx = -charterR; dx <= charterR; dx++) {
        const x = c.x + dx;
        if (x < 0 || x >= grid.cols) continue;
        const cell = y * grid.cols + x;
        if (grid.fields.ore[cell] > bestOre) { bestOre = grid.fields.ore[cell]; best = cell; }
      }
    }
    if (best === -1) return false;
    injectTile(grid, best, "ore", -1);
    return true;
  };

  const advanceDays = async (n: number): Promise<{ stepped: number; skipped: number }> => {
    let stepped = 0;
    let remaining = Math.floor(n);
    while (remaining > 0) {
      // Quiet tri-world (no mining, no pending foundings, substrate at
      // rest): the dual layer's resting jump is exact for the whole world.
      if (!opts.mining && !opts.autoFound && pendingCount(grid) === 0) {
        const r = await dual.advanceDays(remaining);
        return { stepped: stepped + r.stepped, skipped: r.skipped };
      }
      await dual.step();
      stepped++;
      remaining--;
      dayCount++;

      if (opts.autoFound && dayCount % opts.autoFound.every === 0) {
        await maybeFound();
      }

      if (opts.mining) {
        const oreOut = dual.entityWorld.scalars[opts.mining.oreOutScalar];
        for (let ci = 0; ci < cities.length; ci++) {
          const i = cityIndex.get(cities[ci].key)!;
          miningCarry[ci] += (oreOut ? oreOut[i] : 0) * opts.mining.rate;
          while (miningCarry[ci] >= 1) {
            if (!depleteOne(ci)) { miningCarry[ci] = 0; break; }
            miningCarry[ci] -= 1;
          }
          // Re-charter: the settlement reads the mountain as it is now.
          dual.entityWorld.scalars.ore_access[i] = boxSum(grid, "ore", cities[ci].x, cities[ci].y, charterR);
        }
      }

      // Substrate catch-up: cheap while quiet, bounded while re-settling.
      const budget = opts.gridStepsPerDay ?? 4;
      let guard = 0;
      while (pendingCount(grid) > 0 && guard++ < budget) worldStep(grid);
    }
    return { stepped, skipped: 0 };
  };

  return {
    grid,
    dual,
    cities,
    peopleScale: scale,
    charterOf: (key) => {
      const c = cities[cityIndex.get(key) ?? -1];
      if (!c) throw new Error(`charterOf: unknown city ${key}`);
      return charter(c.x, c.y);
    },
    gridPeople: () => {
      let s = 0;
      for (const v of grid.fields.people) s += v;
      return s;
    },
    harvestedTotal: () => harvestedTotal,
    gridOre: () => {
      let s = 0;
      for (const v of grid.fields.ore) s += v;
      return s;
    },
    advanceDays,
  };
}
