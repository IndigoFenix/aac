/**
 * PLANNED civilizational history — civilization-emergence.md §3b/§6 step 6.
 *
 * The "plan ahead, fake the growth" provider: given a RESTED substrate,
 * produce a whole economic history — foundings, construction, colonies,
 * merges, depletion — WITHOUT running the live sim, and emit it through
 * the SAME SEAM the live sim records (step 5's CivHistory), so the
 * scrubber replays a planned past exactly like a remembered one.
 *
 * Provider honesty (§3c: "the plan is built from the sim's own
 * attractors — the same solvers, invoked at plan time"): this v1 planner
 * is the cheapest provider that reuses the solvers VERBATIM —
 *
 *   • the real settlement EntityWorld runs every planned day (processes,
 *     flow nets, sums, allocators, construction rules, road wear: the
 *     exact engine, so the economic endpoint is the sim's own fixpoint);
 *   • population follows the Malthus POLICY in closed float form (the
 *     same rates the dual coupling applies through integer carries —
 *     the fill attractor keeps the trajectories glued; the agreement
 *     test bounds the drift);
 *   • the structural event gates (founding, colonize, merge) mirror
 *     tri.ts clause for clause, on the same scan cadence, fed by the
 *     same findFoundingSites/charter reads.
 *
 * What it OMITS — the §3b profile decisions: the whole Composition layer
 * (PopuSim) and with it politics — no breakaway, no conquest, civ column
 * constant. Boot the planned economic world and let §2d fight the wars
 * live. The upgrade path from here is O(events) instead of O(days):
 * analytic Malthus integration between scan days with the settlement
 * world stepped once per epoch — noted, not needed (a planned day is
 * microseconds: the expensive layer was never invited).
 *
 * The planner NEVER MUTATES the caller's grid: charters read the shared
 * (static, rested) fields, and mining depletion runs on a private copy
 * of the ore field. The live sim can run on the same prep afterwards —
 * which is exactly what the agreement test does.
 */

import {
  createWorld, stepWorld, addEntity, setEntityDisabled, injectEntity,
  findFoundingSites,
  type EntityWorld, type FoundingSite,
} from "../cells/index";
import type { CellGrid } from "../cells/index";
import type { DualSpec } from "./dual";
import type { TriPrep, TriCharter, TriCityDef, FoundTriOpts, CivFrame, CivHistory } from "./tri";

export interface PlanEvent {
  kind: "found" | "colony" | "merge";
  /** Planned day the event landed. */
  day: number;
  /** Cumulative births at the event — the §7 development clock (strictly
   *  monotone through collapse, unlike live population). */
  births: number;
  key: string;
  /** colony: the funding parent; merge: the absorbing winner. */
  other?: string;
}

export interface PlannedCity {
  key: string;
  name: string;
  x: number;
  y: number;
  /** The founding cell — charter/distance reads key on this (lattice-
   *  generic); x/y are flat-chart presentation coords. */
  cell: number;
  harvested: number;
  dead?: { day: number; pop: number };
  colonyOf?: string;
}

export interface PlanOpts {
  base: Omit<DualSpec, "nodes" | "edges">;
  /** Seeded cities + roads (the manual-founding arcs); [] for genesis. */
  cities: TriCityDef[];
  edges: Array<[string, string]>;
  peopleScale?: number;
  charterRadius?: number;
  /** Days of history to plan. */
  days: number;
  /** Frame cadence (mirrors FoundTriOpts.history.every). */
  history: { every: number; roadAttr?: string; hostilityAttr?: string };
  /** The same event options the live tri world takes — same gates, same
   *  cadence, same factories (reuse kills drift). */
  autoFound?: FoundTriOpts["autoFound"];
  colonize?: FoundTriOpts["colonize"];
  merge?: FoundTriOpts["merge"];
  mining?: FoundTriOpts["mining"];
  tiers?: Array<{ key: string; min: number }>;
  /** Civ trait stamped on every living city's frame column (the planner
   *  is politically silent — one civ, no wars). Default "". */
  civ?: string;
}

export interface PlannedHistory {
  history: CivHistory;
  events: PlanEvent[];
  cities: PlannedCity[];
  /** The planner's settlement world at the horizon — per-commodity fills
   *  and stocks for the §3c agreement comparison. */
  world: EntityWorld;
  /** Cumulative planned births/deaths (float — the policy integral). */
  births: number;
  deaths: number;
}

/** Per-capita demand rates, summed across every trait that declares any —
 *  the same numbers the dual coupling reads through PopuSim
 *  (siteResourceDemand over universal traits), taken as data. */
export function demandRatesFromBase(base: Omit<DualSpec, "nodes" | "edges">): Record<string, number> {
  const rates: Record<string, number> = {};
  const traits = (base.composition as { trait?: Array<{ demand?: Array<{ resource: string; value: number }> }> }).trait ?? [];
  for (const t of traits) {
    for (const d of t.demand ?? []) rates[d.resource] = (rates[d.resource] ?? 0) + d.value;
  }
  return rates;
}

export function planHistory(prep: TriPrep, opts: PlanOpts): PlannedHistory {
  const { grid } = prep;
  const scale = opts.peopleScale ?? 25;
  const charterR = opts.charterRadius ?? 3;
  const civ = opts.civ ?? "";
  // The planner's float Malthus models the CIVIC ledger — the first
  // vitals spec by convention (the population scalar it steps carries
  // civic souls only). Non-civic species (herds, commensals) are
  // planned only through their settlement-scalar effects; a planned
  // per-species composition is future §3c work.
  const rawVitals = opts.base.coupling.vitals;
  const vitals = Array.isArray(rawVitals) ? rawVitals[0] : rawVitals;
  const demandInputs = opts.base.coupling.demandInputs ?? [];
  const rates = demandRatesFromBase(opts.base);

  // Private ore field — depletion must not touch the caller's grid.
  const ore = Float64Array.from(grid.fields.ore);
  // The charter box, lattice-generic (topo.disk replays the flat scan
  // bit-identically on flat grids).
  const boxSum = (arr: ArrayLike<number>, cell: number, r: number): number => {
    let sum = 0;
    grid.topo.disk(cell, r, c => { sum += arr[c]; });
    return sum;
  };
  const charter = (cell: number): TriCharter => ({
    farmland: boxSum(grid.fields.fertility, cell, charterR),
    ore_access: boxSum(ore, cell, charterR),
    timberland: boxSum(grid.fields.plant, cell, charterR),
  });

  // --- The reduced world: the REAL settlement engine, no composition.
  const cities: PlannedCity[] = [];
  const pops: number[] = []; // float population per city (the Malthus state)
  const events: PlanEvent[] = [];
  const frames: CivFrame[] = [];
  let births = 0;
  let deaths = 0;
  let day = 0;

  const seedEntity = (ew: EntityWorld, i: number, ch: TriCharter, extra: Record<string, number>, pop: number): void => {
    const set = (name: string, value: number): void => {
      const arr = ew.scalars[name];
      if (arr) arr[i] = value;
    };
    set(opts.base.coupling.populationScalar, pop);
    set("farmland", ch.farmland);
    set("ore_access", ch.ore_access);
    set("timberland", ch.timberland);
    for (const [k, v] of Object.entries(extra)) set(k, v);
  };

  // Seeded cities (density is the crowd the live harvest would take —
  // founding boxes are spacing-disjoint, so standing crowds are exact).
  const initialDefs = opts.cities;
  const nodeKeys: string[] = [];
  const ew = createWorld(
    opts.base.settlement,
    initialDefs.length,
    opts.edges.map(([a, b]) => [
      initialDefs.findIndex(c => c.key === a),
      initialDefs.findIndex(c => c.key === b),
    ] as [number, number]),
  );
  initialDefs.forEach((def, i) => {
    // The harvest cap, mirrored (found-small on the harvest — §2a).
    const taken = Math.min(def.at.density, prep.founding.maxHarvest ?? Infinity);
    const ch = charter(def.at.cell);
    const extra = typeof def.scalars === "function" ? def.scalars(ch, taken * scale) : (def.scalars ?? {});
    cities.push({ key: def.key, name: def.name, x: def.at.x, y: def.at.y, cell: def.at.cell, harvested: taken });
    pops.push(taken * scale);
    nodeKeys.push(def.key);
    seedEntity(ew, i, ch, extra, taken * scale);
  });

  const popArr = (): Float64Array => ew.scalars[opts.base.coupling.populationScalar];
  const tierMin = opts.colonize?.minTier
    ? (opts.tiers?.find(t => t.key === opts.colonize!.minTier)?.min ?? 0)
    : 0;

  const captureFrame = (): void => {
    const roadArr = opts.history.roadAttr ? ew.edgeAttr[opts.history.roadAttr] : undefined;
    const hostArr = opts.history.hostilityAttr ? ew.edgeAttr[opts.history.hostilityAttr] : undefined;
    frames.push({
      day,
      pop: cities.map((c, i) => (c.dead ? 0 : Math.round(pops[i]))),
      civ: cities.map(c => (c.dead ? "" : civ)),
      dead: cities.map(c => !!c.dead),
      edgeCount: ew.edges.length,
      road: roadArr ? Array.from(roadArr) : [],
      hostility: hostArr ? Array.from(hostArr) : [],
    });
  };

  // --- Event scans: tri.ts clause for clause. -------------------------------

  const maybeFound = (): void => {
    const auto = opts.autoFound;
    if (!auto) return;
    if (auto.maxCities !== undefined && cities.filter(c => !c.colonyOf).length >= auto.maxCities) return;
    const living = cities.filter(c => !c.dead);
    const candidates = findFoundingSites(grid, {
      ...prep.founding,
      score: auto.score,
      occupied: living.map(c => [c.x, c.y] as [number, number]),
    });
    if (candidates.length === 0) return;
    const at = candidates[0];
    const taken = Math.min(at.density, prep.founding.maxHarvest ?? Infinity);
    if (taken <= 0) return;
    const ch = charter(at.cell);
    const def = auto.cityFactory(at, cities.length, ch);
    const extra = typeof def.scalars === "function" ? def.scalars(ch, taken * scale) : (def.scalars ?? {});
    const edges: Array<{ to: number }> = [];
    if (living.length > 0) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < living.length; i++) {
        const d2 = grid.topo.dist2(living[i].cell, at.cell);
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      edges.push({ to: nodeKeys.indexOf(living[best].key) });
    }
    const i = addEntity(ew, { edges });
    cities.push({ key: def.key, name: def.name, x: at.x, y: at.y, cell: at.cell, harvested: taken });
    pops.push(taken * scale);
    nodeKeys.push(def.key);
    seedEntity(ew, i, ch, extra, taken * scale);
    events.push({ kind: "found", day, births, key: def.key });
  };

  const scarceRuns = new Map<string, number>();
  const maybeColonize = (): void => {
    const co = opts.colonize;
    if (!co) return;
    const windowLen = co.window ?? 3;
    const costArr = ew.scalars[co.costScalar];
    if (!costArr) throw new Error(`plan: unknown scalar ${co.costScalar}`);

    for (let ri = 0; ri < co.resources.length; ri++) {
      const r = co.resources[ri];
      const needArr = ew.scalars[r.needScalar];
      const gotArr = ew.scalars[r.gotScalar];
      if (!needArr || !gotArr) throw new Error(`plan: unknown scalars ${r.needScalar}/${r.gotScalar}`);
      const thr = r.threshold ?? 0.9;
      for (let ci = 0; ci < cities.length; ci++) {
        if (cities[ci].dead) continue;
        const key = ri + ":" + cities[ci].key;
        const scarce = needArr[ci] > 0 && gotArr[ci] / needArr[ci] < thr;
        scarceRuns.set(key, scarce ? (scarceRuns.get(key) ?? 0) + 1 : 0);
      }
    }

    const colonyCount = cities.filter(c => c.colonyOf !== undefined).length;
    if (co.maxColonies !== undefined && colonyCount >= co.maxColonies) return;

    for (let ci = 0; ci < cities.length; ci++) {
      const parent = cities[ci];
      if (parent.dead) continue;
      if (pops[ci] < tierMin) continue;
      if (pops[ci] <= co.colonists) continue;
      if (costArr[ci] < co.cost) continue;

      for (let ri = 0; ri < co.resources.length; ri++) {
        const r = co.resources[ri];
        if ((scarceRuns.get(ri + ":" + parent.key) ?? 0) < windowLen) continue;
        const living = cities.filter(c => !c.dead);
        const candidates = findFoundingSites(grid, {
          threshold: 0,
          radius: prep.founding.radius,
          minSpacing: prep.founding.minSpacing,
          occupied: living.map(c => [c.x, c.y] as [number, number]),
          score: [{ field: r.field, weight: 10 }],
        });
        let at: FoundingSite | null = null;
        for (const cand of candidates) {
          const d2 = grid.topo.dist2(cand.cell, parent.cell);
          if (d2 > co.range * co.range) continue;
          const held = r.field === "ore"
            ? boxSum(ore, cand.cell, charterR)
            : boxSum(grid.fields[r.field], cand.cell, charterR);
          if (held < (r.minField ?? 1)) continue;
          at = cand;
          break;
        }
        if (!at) continue;

        const ch = charter(at.cell);
        const def = co.colonyFactory(at, colonyCount, ch, parent.key);
        const extra = typeof def.scalars === "function" ? def.scalars(ch, co.colonists) : (def.scalars ?? {});
        const i = addEntity(ew, { edges: [{ to: ci }] });
        cities.push({ key: def.key, name: def.name, x: at.x, y: at.y, cell: at.cell, harvested: 0, colonyOf: parent.key });
        pops.push(co.colonists);
        pops[ci] -= co.colonists;
        nodeKeys.push(def.key);
        seedEntity(ew, i, ch, extra, co.colonists);
        popArr()[ci] = pops[ci];
        injectEntity(ew, ci, co.costScalar, -co.cost);
        for (let rj = 0; rj < co.resources.length; rj++) scarceRuns.set(rj + ":" + parent.key, 0);
        events.push({ kind: "colony", day, births, key: def.key, other: parent.key });
        return;
      }
    }
  };

  const maybeMerge = (): void => {
    const mg = opts.merge;
    if (!mg) return;
    const stallFill = mg.stallFill ?? 0.95;
    const needArr = ew.scalars[mg.needScalar];
    const gotArr = ew.scalars[mg.gotScalar];
    if (!needArr || !gotArr) throw new Error(`plan: unknown scalars ${mg.needScalar}/${mg.gotScalar}`);
    const hostArr = mg.hostilityAttr ? ew.edgeAttr[mg.hostilityAttr] : null;

    for (let li = 0; li < cities.length; li++) {
      const loser = cities[li];
      if (loser.dead) continue;
      if (pops[li] <= 0) continue;
      if (!(needArr[li] > 0) || gotArr[li] / needArr[li] >= stallFill) continue;
      // Single civ, cold borders: the same-civ and hostility gates of the
      // live scan pass trivially in a politically silent plan.
      let win = -1;
      let winPop = 0;
      for (const e of ew.adj[li]) {
        const oi = ew.edges[e].a === li ? ew.edges[e].b : ew.edges[e].a;
        const other = cities[oi];
        if (!other || other.dead) continue;
        const d2 = (other.x - loser.x) ** 2 + (other.y - loser.y) ** 2;
        if (d2 > mg.range * mg.range) continue;
        if (hostArr && hostArr[e] > 0) continue;
        if (pops[oi] < mg.ratio * pops[li]) continue;
        if (pops[oi] > winPop) { winPop = pops[oi]; win = oi; }
      }
      if (win < 0) continue;
      const moved = pops[li];
      pops[win] += moved;
      pops[li] = 0;
      for (const v of opts.base.settlement.entity.vars ?? []) ew.scalars[v.name][li] = v.min;
      setEntityDisabled(ew, li);
      popArr()[win] = pops[win];
      loser.dead = { day, pop: Math.round(moved) };
      events.push({ kind: "merge", day, births, key: loser.key, other: cities[win].key });
      return;
    }
  };

  // Mining depletion on the PRIVATE ore copy — richest tile first,
  // recharter follows (tri.ts clause for clause).
  let miningCarry: number[] = [];
  const depleteOne = (ci: number): boolean => {
    let best = -1;
    let bestOre = 0;
    grid.topo.disk(cities[ci].cell, charterR, cell => {
      if (ore[cell] > bestOre) { bestOre = ore[cell]; best = cell; }
    });
    if (best === -1) return false;
    ore[best] = Math.max(0, ore[best] - 1);
    return true;
  };

  // --- The planned days. -----------------------------------------------------
  captureFrame(); // day-0 baseline, like the live recorder

  for (day = 1; day <= opts.days; day++) {
    // 1. Demand inputs from the standing population (the one-day-lag
    //    contract: start-of-day pops, same as the dual coupling).
    for (const di of demandInputs) {
      const arr = ew.scalars[di.scalar];
      if (!arr) continue;
      const rate = rates[di.resource] ?? 0;
      for (let i = 0; i < cities.length; i++) arr[i] = cities[i].dead ? 0 : pops[i] * rate;
    }

    // 2. One settlement day — the REAL engine: trade, chains, relays,
    //    construction, drift, road wear.
    stepWorld(ew);

    // 3. The Malthus policy in float (fill gates births, starvation the
    //    rest — the same rates the dual coupling applies via carries).
    if (vitals) {
      const needArr = vitals.foodNeed ? ew.scalars[vitals.foodNeed] : null;
      const gotArr = vitals.foodGot ? ew.scalars[vitals.foodGot] : null;
      for (let i = 0; i < cities.length; i++) {
        if (cities[i].dead || pops[i] <= 0) continue;
        const need = needArr ? needArr[i] : 0;
        const fill = need > 0 ? Math.min(1, (gotArr ? gotArr[i] : 0) / need) : 1;
        const b = pops[i] * vitals.birthRate * fill;
        const d = pops[i] * (vitals.deathRate + (vitals.starvation ?? 0) * (1 - fill));
        births += b;
        deaths += d;
        pops[i] = Math.max(0, pops[i] + b - d);
      }
    }
    for (let i = 0; i < cities.length; i++) if (!cities[i].dead) popArr()[i] = pops[i];

    // 4. Mining depletion + recharter (private ore copy).
    if (opts.mining) {
      const oreOut = ew.scalars[opts.mining.oreOutScalar];
      while (miningCarry.length < cities.length) miningCarry.push(0);
      for (let ci = 0; ci < cities.length; ci++) {
        if (cities[ci].dead) continue;
        miningCarry[ci] += (oreOut ? oreOut[ci] : 0) * opts.mining.rate;
        while (miningCarry[ci] >= 1) {
          if (!depleteOne(ci)) { miningCarry[ci] = 0; break; }
          miningCarry[ci] -= 1;
        }
        ew.scalars.ore_access[ci] = boxSum(ore, cities[ci].cell, charterR);
      }
    }

    // 5. Structural events on the live cadences, then the keyframe.
    if (opts.autoFound && day % opts.autoFound.every === 0) maybeFound();
    if (opts.colonize && day % (opts.colonize.every ?? 5) === 0) maybeColonize();
    if (opts.merge && day % (opts.merge.every ?? 5) === 0) maybeMerge();
    if (day % opts.history.every === 0) captureFrame();
  }

  return {
    history: {
      cities: cities.map(c => ({ key: c.key, name: c.name, x: c.x, y: c.y })),
      edges: ew.edges.map(e => ({ a: e.a, b: e.b })),
      frames,
    },
    events,
    cities,
    world: ew,
    births,
    deaths,
  };
}
