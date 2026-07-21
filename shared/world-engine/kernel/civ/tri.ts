/**
 * TriWorld — gate 6 (world-content.md §6): all three layers over one map.
 *
 *   Substrate  — the worldgen grid (height, rivers, fertility, ore, wild
 *                people), settled to rest before anyone founds anything.
 *   Settlement — cell-systems entities chartered against the grid.
 *   Composition— demographic sites (the CompositionWorld seam; PopuSim
 *                in grand-dream) born from HARVESTED crowds.
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
  createGrid, createGridOn, worldStep, pendingCount, injectTile, injectEntity,
  seedOreAboveTreeline, findFoundingSites, carveValleys, worldgenSubstrate,
  type CellGrid, type FoundingSite, type FoundingOpts, type CarveOpts, type SystemSpec, type TopologySpec,
} from "../cells/index";
import { bootDual, type DualWorld, type DualSpec, type DualNode, type DualEdge } from "./dual";
import type { CompositionBoot } from "./composition";

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
  /** Deterministic ore author (a geology provider's baked deposits —
   *  tectonics.ts). When present it REPLACES seedOreAboveTreeline: the
   *  cheat and the simulate provider are alternatives behind one seam
   *  (timescales.md §1). */
  ore?: (x: number, y: number) => number;
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
  /** CLIMATE knob: multiplies every computed-flow var's rain `source`
   *  (default 1). A wetter world grows wider river networks, and with
   *  them wider fertile bands — a per-world profile choice at the same
   *  seam as the height/ore authors, leaving the shared substrate's
   *  "what counts as a watercourse" thresholds alone. */
  rain?: number;
  /** Valley-carving profile (worldgen.carveValleys). Defaults are fine;
   *  a world with no `ground` var carves nothing. */
  carve?: CarveOpts;
  /** This grid is a CHART: a window on a bigger world (a refined region), so
   *  its water drains off the boundary. Default false — a standalone authored
   *  world keeps its water. See withFlowOpts. */
  chart?: boolean;
}

/** Clone a spec with flow sources scaled by `rain`, and (for a region chart)
 *  its flow vars draining off the chart edge.
 *
 *  `chart` is the "this grid is a WINDOW on a bigger world" declaration: a
 *  refined region's water genuinely flows off its boundary into the neighbouring
 *  land, where a standalone authored world's does not. It is also what gives an
 *  INLAND region an outlet at all — with no sea inside it, there is otherwise no
 *  spill level for the depression fill to work toward, and its drainage settles
 *  into a few hundred terminal puddles instead of a network that leaves. */
function withFlowOpts(spec: SystemSpec, rain: number, chart: boolean): SystemSpec {
  if (rain === 1 && !chart) return spec;
  return {
    ...spec,
    vars: (spec.vars ?? []).map(v =>
      v.flow
        ? { ...v, flow: {
            ...v.flow,
            source: (v.flow.source ?? 1) * rain,
            ...(chart ? { outletEdge: true } : {}),
          } }
        : v),
  };
}

/** Build the substrate (settled by default), then detect founding candidates. */
export function prepareSubstrate(opts: PrepareOpts): TriPrep {
  const treeline = opts.treeline ?? 40;
  const grid = createGrid(withFlowOpts(opts.spec ?? worldgenSubstrate, opts.rain ?? 1, !!opts.chart), opts.cols, opts.rows);
  for (let y = 0; y < opts.rows; y++) {
    for (let x = 0; x < opts.cols; x++) {
      grid.fields.height[y * opts.cols + x] = Math.max(0, Math.min(63, Math.round(opts.height(x, y))));
    }
  }
  grid.flowDirty = true;
  if (opts.ore) {
    for (let y = 0; y < opts.rows; y++) {
      for (let x = 0; x < opts.cols; x++) {
        grid.fields.ore[y * opts.cols + x] = Math.max(0, Math.min(15, Math.round(opts.ore(x, y))));
      }
    }
  } else {
    seedOreAboveTreeline(grid, { treeline, seed: opts.oreSeed ?? 1 });
  }

  // Mature the substrate: run to quiet, or to the budget — living specs
  // (oasisSubstrate) cycle forever by design, so the cap is the contract,
  // not a failure.
  if (opts.settle !== false) {
    const cap = opts.settleCap ?? 20_000;
    for (let i = 0; i < cap && pendingCount(grid) > 0; i++) worldStep(grid);
  }

  // The rivers have settled — cut their valleys into `ground`, the layer
  // the render and the walk chart read. Unconditional: with settle:false
  // no flow was solved, so the cut is zero and ground == height, which is
  // exactly right for a world with no rivers in it yet.
  carveValleys(grid, opts.carve);

  return { grid, sites: findFoundingSites(grid, opts.founding), founding: opts.founding, treeline };
}

export interface PrepareOnOpts {
  /** The lattice (flat, cube-sphere, …) — the world-level choice. */
  topology: TopologySpec;
  /** Deterministic terrain author, CELL-indexed (curved lattices have no
   *  (x, y) — sphere-tectonics' bakeCellAuthors plugs in here). */
  height: (cell: number) => number;
  /** Deterministic ore author (cell-indexed). When present it REPLACES
   *  seedOreAboveTreeline, same as the flat seam. */
  ore?: (cell: number) => number;
  treeline?: number;
  oreSeed?: number;
  founding: FoundingOpts;
  settleCap?: number;
  settle?: boolean;
  spec?: SystemSpec;
  rain?: number;
  /** Valley-carving profile (worldgen.carveValleys). */
  carve?: CarveOpts;
}

/** prepareSubstrate's lattice-generic twin: build the substrate on ANY
 *  topology (settled by default), then detect founding candidates. The
 *  flat path keeps its (x, y) authors; this one reads by cell. */
export function prepareSubstrateOn(opts: PrepareOnOpts): TriPrep {
  const treeline = opts.treeline ?? 40;
  // No `chart` here: prepareSubstrateOn builds CLOSED topologies (the planet
  // sphere), which have no edge to drain off — their outlet is the sea.
  const grid = createGridOn(withFlowOpts(opts.spec ?? worldgenSubstrate, opts.rain ?? 1, false), opts.topology);
  const n = grid.topo.n;
  for (let c = 0; c < n; c++) {
    grid.fields.height[c] = Math.max(0, Math.min(63, Math.round(opts.height(c))));
  }
  grid.flowDirty = true;
  if (opts.ore) {
    for (let c = 0; c < n; c++) {
      grid.fields.ore[c] = Math.max(0, Math.min(15, Math.round(opts.ore(c))));
    }
  } else {
    seedOreAboveTreeline(grid, { treeline, seed: opts.oreSeed ?? 1 });
  }
  if (opts.settle !== false) {
    const cap = opts.settleCap ?? 20_000;
    for (let i = 0; i < cap && pendingCount(grid) > 0; i++) worldStep(grid);
  }
  carveValleys(grid, opts.carve);
  return { grid, sites: findFoundingSites(grid, opts.founding), founding: opts.founding, treeline };
}

export interface TriCharter {
  farmland: number;
  ore_access: number;
  timberland: number;
  /** Chartered grazing land (the biosphere's grass, on the vegetation
   *  scale) — 0 on worlds without an ecology. Herding buildings anchor
   *  their caps here the way farms anchor on farmland. */
  pasture: number;
}

/** One recorded moment of civilization history (civilization-emergence.md
 *  §3a — the tectonic keyframe pattern pointed at the settlement graph).
 *  Per-city arrays follow tri.cities order and are PREFIX-STABLE: the
 *  roster only appends, so a frame's array length IS its roster size —
 *  a city absent from frame k was founded after it. */
export interface CivFrame {
  /** Tri-relative day (dayCount at capture). */
  day: number;
  pop: number[];
  /** Majority civ trait per city ("" = none). */
  civ: string[];
  dead: boolean[];
  /** Edges existing as of this frame (the edge roster is append-only). */
  edgeCount: number;
  /** Per-edge attrs (dual edge order, append-only); empty when the
   *  history option names no attr. */
  road: number[];
  hostility: number[];
}

/** The recorded history plus the (append-only) rosters that give frame
 *  indices their meaning. Rosters are snapshots taken at read time — they
 *  cover every frame recorded so far. */
export interface CivHistory {
  cities: Array<{ key: string; name: string; x: number; y: number }>;
  edges: Array<{ a: number; b: number }>;
  frames: CivFrame[];
}

export interface TriCityDef {
  at: FoundingSite;
  key: string;
  name: string;
  /** Settlement scalars beyond the chartered trio (buildings etc.), may be
   *  a function of the charter and the founding population (souls) — a
   *  village sizes its subsistence stock to the crowd it was born from. */
  scalars?: Record<string, number> | ((charter: TriCharter, pop: number) => Record<string, number>);
  /** PopuSim site JSON passthrough (startpop, transmit). */
  site?: Record<string, unknown>;
}

export interface FoundTriOpts {
  base: Omit<DualSpec, "nodes" | "edges">;
  /** The compiled economy the base was built from (triEconomy) — rides
   *  the TriWorld so the street/presentation registries always match
   *  the settlement spec they render. */
  economy?: import("../modules/economy/economy").CompiledEconomy;
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
  /** Settlement TIERS (civilization-emergence.md §2a): population
   *  thresholds, ascending — regimes, not classes. Data in the world
   *  spec; future lifecycle events (colonize, conquer) arm by tier. */
  tiers?: Array<{ key: string; min: number }>;
  /** ECONOMIC ABSORPTION (civilization-emergence.md §2b, physical mode):
   *  every `every` days, scan founding order for a STALLED settlement
   *  (food fill < stallFill — it cannot feed itself into a town) with a
   *  route-connected neighbor within `range` grid units, same civ, cold
   *  border, at least `ratio`× its size. The largest such neighbor
   *  absorbs it: people walk, the entity tombstones, the site empties, a
   *  RUIN remains. One merge per scan day — deaths read as events, not
   *  sweeps. */
  merge?: {
    every?: number;
    /** Max grid distance between the pair. */
    range: number;
    /** winnerPop ≥ ratio × loserPop. */
    ratio: number;
    /** Stalled = food fill < stallFill (default 0.95). */
    stallFill?: number;
    /** Settlement scalars for the fill test (demand / met). */
    needScalar: string;
    gotScalar: string;
    /** Edge attr that must be 0 on the connecting road (war blocks mercy). */
    hostilityAttr?: string;
  };
  /** COLONIZATION (civilization-emergence.md §2c): cities found daughters
   *  where their scarcity points. Every `every` days, scan founding order
   *  for a parent at/above `minTier` whose fill for some listed resource
   *  has stayed below its threshold for `window` consecutive scans, with
   *  `cost` banked in `costScalar`. It founds a colony at the best
   *  unoccupied site RANKED BY THE SCARCE FIELD within `range`: colonists
   *  walk from the parent (driven migration — conserving, and uniform by
   *  syndrome, so the colony is born INSIDE the parent's civ with no
   *  startpop needed), a road wires home, the cost is spent (the spend is
   *  the repeat mechanism), and the scarcity window resets. No crowd is
   *  harvested — wildlife stays wild; this is the PLANNED tendril beside
   *  autoFound's condensation. One colony per scan day. */
  colonize?: {
    every?: number;
    /** Parent tier gate (a key in `tiers`); villages don't found colonies. */
    minTier?: string;
    /** Consecutive scarce scans required (default 3). */
    window?: number;
    /** Stockpile spend that funds the expedition. */
    cost: number;
    costScalar: string;
    /** Souls that walk from the parent. */
    colonists: number;
    /** Max grid distance parent → colony site. */
    range: number;
    maxColonies?: number;
    resources: Array<{
      /** Substrate field that scores candidate sites (e.g. "ore"). */
      field: string;
      /** Settlement scalars: fill = got/need < threshold ⇒ scarce. */
      needScalar: string;
      gotScalar: string;
      threshold?: number;
      /** Candidate must hold at least this much of the field in its
       *  charter box (rejects crowd-scored sites with none of it). */
      minField?: number;
    }>;
    colonyFactory: (site: FoundingSite, index: number, charter: TriCharter, parentKey: string) => {
      key: string;
      name: string;
      scalars?: Record<string, number> | ((ch: TriCharter, pop: number) => Record<string, number>);
      site?: Record<string, unknown>;
    };
  };
  /** Record CIVILIZATION KEYFRAMES every `every` days (§3a: the
   *  boot-run/scrub pattern that tectonics shipped, pointed at the
   *  settlement graph): per-city population, majority civ, dead flag,
   *  plus the named edge attrs. Pure read — recording changes nothing.
   *  Frames are tiny (scalars per site), so any tri world can afford
   *  them; the civ-scrub presenter replays them as a history slider. */
  history?: { every: number; roadAttr?: string; hostilityAttr?: string };
  /** EMERGENT civilization: every `every` days, scan the settled crowds
   *  for founding candidates (respecting existing cities) and found the
   *  best one — cities appear naturally as the land fills, and sculpting
   *  new fertile valleys eventually raises new towns. */
  autoFound?: {
    every: number;
    maxCities?: number;
    /** Ranking weights (the supply/demand socket). */
    score?: Array<{ field: string; weight: number }>;
    /** `mix` (step 6f) = the HARVESTED grid persons per species key —
     *  who actually lived in the box; feed it to `harvestStartpop` so
     *  the founding composition is the demography, not a constant. */
    cityFactory: (site: FoundingSite, index: number, charter: TriCharter, mix?: Record<string, number>) => {
      key: string;
      name: string;
      scalars?: Record<string, number> | ((ch: TriCharter, pop: number) => Record<string, number>);
      site?: Record<string, unknown>;
    };
  };
}

export interface TriWorld {
  grid: CellGrid;
  dual: DualWorld;
  /** The compiled economy this world runs — street and presentation
   *  registries read off it; absent, they fall back to the game's
   *  standard registry (grand-dream: DEFAULT_ECONOMY). */
  economy?: import("../modules/economy/economy").CompiledEconomy;
  /** Founded cities, in founding order — GROWS when autoFound or
   *  colonization fires. An absorbed city stays in the list as a RUIN
   *  (`dead` set: the day it fell and the population that walked away); a
   *  colony carries its parent's key in `colonyOf` (harvested 0 — its
   *  people WALKED from the parent, conserving). Indices stay aligned
   *  with the dual world's nodes. */
  cities: Array<{
    key: string; name: string; x: number; y: number;
    /** The founding cell — all charter/distance reads key on this; x/y are
     *  the flat-chart coords kept for presentation. */
    cell: number;
    harvested: number;
    dead?: { day: number; pop: number };
    colonyOf?: string;
  }>;
  /** Recorded civilization keyframes (null when the world declares no
   *  history option). Rosters are read-time snapshots; frames accumulate
   *  as days advance. */
  history(): CivHistory | null;
  /** Frames recorded so far — cheap (for UI visibility checks). */
  historyFrames(): number;
  /** Souls per harvested grid person. */
  peopleScale: number;
  charterOf(key: string): TriCharter;
  /** The settlement's tier key (highest threshold its LIVE population
   *  meets), or null when the world declares no tiers. */
  tierOf(key: string): string | null;
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

/** Σ of a field over the lattice's radius-r neighbourhood of `cell` — the
 *  charter box. topo.disk replays the flat (2r+1)² scan bit-identically on
 *  flat grids and continues across seams on curved ones. */
function boxSum(grid: CellGrid, field: string, cell: number, r: number): number {
  const arr = grid.fields[field];
  let sum = 0;
  grid.topo.disk(cell, r, c => { sum += arr[c]; });
  return sum;
}

/** Found the cities (harvesting their crowds), boot the dual world over
 *  them (on the injected composition backend), and return the coupled
 *  tri-world. */
export async function foundTri(prep: TriPrep, opts: FoundTriOpts, boot: CompositionBoot): Promise<TriWorld> {
  const { grid } = prep;
  const scale = opts.peopleScale ?? 25;
  const charterR = opts.charterRadius ?? 3;

  // With a baked ecology, the vegetation charters read the REAL biosphere:
  // timber is trees (not the generic green halo) and pasture is grass —
  // a forest-edge founding charters sawmills, a grassland one stables.
  // Abundance (0..100) maps onto the plant scale (0..7) so every anchor
  // rate calibrated against `plant` carries over unchanged.
  const ECO_VEG_SCALE = 7 / 100;
  const charter = (cell: number): TriCharter => ({
    farmland: boxSum(grid, "fertility", cell, charterR),
    ore_access: boxSum(grid, "ore", cell, charterR),
    timberland: grid.fields.eco_tree
      ? boxSum(grid, "eco_tree", cell, charterR) * ECO_VEG_SCALE
      : boxSum(grid, "plant", cell, charterR),
    pasture: grid.fields.eco_grass
      ? boxSum(grid, "eco_grass", cell, charterR) * ECO_VEG_SCALE
      : 0,
  });

  // The WILD SPECIES this world's crowds come in (step 6f): every
  // sapient species with a wild substrate field — humans always (the
  // base `people` field), others per the compiled economy. Fields the
  // grid doesn't carry are skipped (fixed worlds on the bare substrate).
  const wilds: Array<{ key: string; field: string }> = (
    opts.economy?.species
      ?.filter(s => s.role === "sapient" && s.wild)
      .map(s => ({ key: s.key, field: s.wild!.field }))
    ?? []
  );
  if (!wilds.length) wilds.push({ key: "human", field: "people" });

  // The founding transaction, substrate side: the wild crowds in the
  // box leave the grid — a border camp harvests whoever lived there,
  // and the mix is who founds. FOUND SMALL applies to the HARVEST
  // (founding.maxHarvest, §2a one layer down): a fat box gives up at
  // most the cap, apportioned across species largest-remainder (the
  // mix keeps its proportions), and the RESIDUE stays wild — it
  // regrows, and may gate a later founding nearby.
  const harvest = (c: FoundingSite): { total: number; mix: Record<string, number> } => {
    const r = prep.founding.radius;
    // Pass 1: measure every species' crowd in the box (the founding site's
    // lattice neighbourhood — same cells the density scan counted).
    const boxes = wilds.map(w => {
      const arr = grid.fields[w.field];
      const tiles: Array<{ cell: number; here: number }> = [];
      let sum = 0;
      if (arr) {
        grid.topo.disk(c.cell, r, cell => {
          const here = arr[cell];
          if (here > 0) { tiles.push({ cell, here }); sum += here; }
        });
      }
      return { w, tiles, sum };
    });
    const grand = boxes.reduce((a, b) => a + b.sum, 0);
    const cap = prep.founding.maxHarvest;

    // Pass 2: how many each species gives up. Under the cap: largest-
    // remainder over the species sums (exact — Σ wants = cap; ties by
    // species order, deterministic).
    let wants = boxes.map(b => b.sum);
    if (cap !== undefined && grand > cap) {
      wants = boxes.map(b => Math.floor((cap * b.sum) / grand));
      let left = cap - wants.reduce((a, b) => a + b, 0);
      const order = boxes
        .map((b, i) => ({ i, rem: (cap * b.sum) / grand - wants[i] }))
        .sort((a, b) => b.rem - a.rem || a.i - b.i);
      for (const o of order) {
        if (left <= 0) break;
        if (boxes[o.i].sum > wants[o.i]) { wants[o.i]++; left--; }
      }
    }

    // Pass 3: take, tile by tile in scan order, up to each want.
    const mix: Record<string, number> = {};
    let total = 0;
    boxes.forEach((b, i) => {
      let remaining = wants[i];
      let taken = 0;
      for (const t of b.tiles) {
        if (remaining <= 0) break;
        const take = Math.min(t.here, remaining);
        injectTile(grid, t.cell, b.w.field, -take);
        remaining -= take;
        taken += take;
      }
      if (taken > 0) {
        mix[b.w.key] = taken;
        total += taken;
      }
    });
    return { total, mix };
  };

  const cities: TriWorld["cities"] = [];
  const nodes: DualNode[] = [];
  for (const def of opts.cities) {
    const { total: taken } = harvest(def.at);
    if (taken <= 0) throw new Error(`foundTri: no crowd to harvest at (${def.at.x},${def.at.y})`);
    const ch = charter(def.at.cell);
    const extra = typeof def.scalars === "function" ? def.scalars(ch, taken * scale) : (def.scalars ?? {});
    cities.push({ key: def.key, name: def.name, x: def.at.x, y: def.at.y, cell: def.at.cell, harvested: taken });
    nodes.push({
      key: def.key,
      name: def.name,
      pop: taken * scale,
      scalars: { farmland: ch.farmland, ore_access: ch.ore_access, timberland: ch.timberland, pasture: ch.pasture, ...extra },
      site: def.site,
    });
  }
  const edges: DualEdge[] = opts.edges.map(([a, b], i) => ({ a, b, key: `road${i}` }));

  const dual = await bootDual({ ...opts.base, nodes, edges } as DualSpec, opts.seed, boot);

  const cityIndex = new Map(cities.map((c, i) => [c.key, i] as const));
  let harvestedTotal = cities.reduce((a, c) => a + c.harvested, 0);
  let miningCarry = new Float64Array(cities.length);
  let dayCount = 0;

  /** Emergent founding: the best qualifying crowd becomes a city.
   *  Ruins don't block: founding spacing and road wiring see only the
   *  LIVING settlements (civilization-emergence.md §2b — a later crowd
   *  may rise beside, or on, a fallen one). `maxCities` caps WILD
   *  foundings only — colonies are the parent's spend, counted by
   *  colonize.maxColonies. */
  const maybeFound = async (): Promise<void> => {
    const auto = opts.autoFound;
    if (!auto) return;
    if (auto.maxCities !== undefined && cities.filter(c => !c.colonyOf).length >= auto.maxCities) return;
    const living = cities.filter(c => !c.dead);
    const occupied = living.map(c => [c.x, c.y] as [number, number]);
    // EVERY wild species scouts its own field (dwarven crowds on the
    // ore ridges gate foundings exactly like human crowds in the
    // valleys); the best-scoring candidate across species founds. Ties
    // break in species declaration order — deterministic.
    let at: FoundingSite | null = null;
    for (const w of wilds) {
      if (!grid.fields[w.field]) continue;
      const candidates = findFoundingSites(grid, {
        ...prep.founding,
        score: auto.score,
        peopleField: w.field,
        occupied,
      });
      if (candidates.length && (!at || candidates[0].score > at.score)) at = candidates[0];
    }
    if (!at) return;
    const { total: taken, mix } = harvest(at);
    if (taken <= 0) return;

    const ch = charter(at.cell);
    const def = auto.cityFactory(at, cities.length, ch, mix);
    const extra = typeof def.scalars === "function" ? def.scalars(ch, taken * scale) : (def.scalars ?? {});
    // Road to the nearest LIVING city (the first city stands alone).
    const roadEdges: Array<{ to: string }> = [];
    if (living.length > 0) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < living.length; i++) {
        const d2 = grid.topo.dist2(living[i].cell, at.cell);
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      roadEdges.push({ to: living[best].key });
    }

    const idx = await dual.foundSettlement({
      key: def.key,
      name: def.name,
      pop: taken * scale, // the harvested crowd, ledgered by this tri world
      scalars: { farmland: ch.farmland, ore_access: ch.ore_access, timberland: ch.timberland, pasture: ch.pasture, ...extra },
      site: def.site,
      edges: roadEdges,
    });
    if (idx < 0) return;
    cities.push({ key: def.key, name: def.name, x: at.x, y: at.y, cell: at.cell, harvested: taken });
    cityIndex.set(def.key, cities.length - 1);
    harvestedTotal += taken;
    const grown = new Float64Array(cities.length);
    grown.set(miningCarry);
    miningCarry = grown;
  };

  /** Economic absorption (§2b): a stalled settlement folds into its
   *  biggest qualifying neighbor. Deterministic: losers scan in founding
   *  order; the winner is the largest route-connected neighbor passing
   *  every gate; one merge per scan day. City index == dual node index
   *  (both grow in founding order), so entity adjacency reads directly. */
  const maybeMerge = (): void => {
    const mg = opts.merge;
    if (!mg) return;
    const stallFill = mg.stallFill ?? 0.95;
    const ew = dual.entityWorld;
    const needArr = ew.scalars[mg.needScalar];
    const gotArr = ew.scalars[mg.gotScalar];
    if (!needArr || !gotArr) throw new Error(`merge: unknown scalars ${mg.needScalar}/${mg.gotScalar}`);
    const hostArr = mg.hostilityAttr ? ew.edgeAttr[mg.hostilityAttr] : null;

    for (let li = 0; li < cities.length; li++) {
      const loser = cities[li];
      if (loser.dead) continue;
      const lPop = dual.settlementPop(loser.key);
      if (lPop <= 0) continue;
      // Stalled: it cannot feed itself into a town (a thriving village
      // stays independent — §2b as decided).
      if (!(needArr[li] > 0) || gotArr[li] / needArr[li] >= stallFill) continue;
      const lCiv = dual.civOf(loser.key)?.trait ?? null;

      let win = -1;
      let winPop = 0;
      for (const e of ew.adj[li]) {
        const oi = ew.edges[e].a === li ? ew.edges[e].b : ew.edges[e].a;
        const other = cities[oi];
        if (!other || other.dead) continue;
        const d2 = grid.topo.dist2(other.cell, loser.cell);
        if (d2 > mg.range * mg.range) continue;
        if (hostArr && hostArr[e] > 0) continue; // war blocks mercy
        if ((dual.civOf(other.key)?.trait ?? null) !== lCiv) continue;
        const oPop = dual.settlementPop(other.key);
        if (oPop < mg.ratio * lPop) continue;
        if (oPop > winPop) { winPop = oPop; win = oi; }
      }
      if (win < 0) continue;
      if (dual.absorbSettlement(loser.key, cities[win].key)) {
        loser.dead = { day: dayCount, pop: lPop };
        return; // one merge per scan day — a death is an event, not a sweep
      }
    }
  };

  // Per-(resource, city) consecutive-scarcity counters for colonization —
  // the "sustained unmet demand" window (§2c). Keys are stable strings;
  // iteration order never matters (reads are by explicit key).
  const scarceRuns = new Map<string, number>();

  // Civilization keyframes (§3a) — a history that actually happened,
  // recorded as it does. Pure read; arrays copied at capture.
  const civFrames: CivFrame[] = [];
  const captureFrame = (): void => {
    const h = opts.history;
    if (!h) return;
    const ew = dual.entityWorld;
    const pop: number[] = [];
    const civKeys: string[] = [];
    const dead: boolean[] = [];
    for (const c of cities) {
      pop.push(dual.settlementPop(c.key));
      civKeys.push(dual.civOf(c.key)?.trait ?? "");
      dead.push(!!c.dead);
    }
    const roadArr = h.roadAttr ? ew.edgeAttr[h.roadAttr] : undefined;
    const hostArr = h.hostilityAttr ? ew.edgeAttr[h.hostilityAttr] : undefined;
    civFrames.push({
      day: dayCount,
      pop,
      civ: civKeys,
      dead,
      edgeCount: ew.edges.length,
      road: roadArr ? Array.from(roadArr) : [],
      hostility: hostArr ? Array.from(hostArr) : [],
    });
  };

  /** Colonization (§2c): a scarce, funded, big-enough parent founds a
   *  daughter at the best site FOR THE SCARCE RESOURCE in range. The
   *  colonists walk (conserving, uniform ⇒ the colony is born inside the
   *  parent's civ); the cost is spent (the repeat mechanism); the window
   *  resets. One colony per scan day, first qualifying parent in
   *  founding order — deterministic. */
  const maybeColonize = async (): Promise<void> => {
    const co = opts.colonize;
    if (!co) return;
    const windowLen = co.window ?? 3;
    const ew = dual.entityWorld;
    const costArr = ew.scalars[co.costScalar];
    if (!costArr) throw new Error(`colonize: unknown scalar ${co.costScalar}`);
    const minTierPop = co.minTier ? (opts.tiers?.find(t => t.key === co.minTier)?.min ?? 0) : 0;

    // 1. Every living settlement's scarcity windows tick — a fact about
    //    the economy, tracked whether or not the city could act on it.
    for (let ri = 0; ri < co.resources.length; ri++) {
      const r = co.resources[ri];
      const needArr = ew.scalars[r.needScalar];
      const gotArr = ew.scalars[r.gotScalar];
      if (!needArr || !gotArr) throw new Error(`colonize: unknown scalars ${r.needScalar}/${r.gotScalar}`);
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

    // 2. First qualifying parent founds one colony.
    for (let ci = 0; ci < cities.length; ci++) {
      const parent = cities[ci];
      if (parent.dead) continue;
      const parentPop = dual.settlementPop(parent.key);
      if (parentPop < minTierPop) continue; // villages don't found colonies
      if (parentPop <= co.colonists) continue; // never empty yourself
      if (costArr[ci] < co.cost) continue; // the expedition must be funded

      for (let ri = 0; ri < co.resources.length; ri++) {
        const r = co.resources[ri];
        if ((scarceRuns.get(ri + ":" + parent.key) ?? 0) < windowLen) continue;

        // The best unoccupied box of the scarce field, within reach, that
        // actually holds some of it (density can outrank an empty box).
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
          if (boxSum(grid, r.field, cand.cell, charterR) < (r.minField ?? 1)) continue;
          at = cand;
          break;
        }
        if (!at) continue;

        const ch = charter(at.cell);
        const def = co.colonyFactory(at, colonyCount, ch, parent.key);
        const extra = typeof def.scalars === "function" ? def.scalars(ch, co.colonists) : (def.scalars ?? {});
        const idx = await dual.foundSettlement({
          key: def.key,
          name: def.name,
          pop: 0, // colonists WALK — nothing is minted, no crowd harvested
          scalars: { farmland: ch.farmland, ore_access: ch.ore_access, timberland: ch.timberland, pasture: ch.pasture, ...extra },
          site: def.site,
          edges: [{ to: parent.key }],
          colonists: [{ from: parent.key, count: co.colonists }],
        });
        if (idx < 0) continue;

        injectEntity(ew, ci, co.costScalar, -co.cost); // the spend re-arms the next expedition
        cities.push({ key: def.key, name: def.name, x: at.x, y: at.y, cell: at.cell, harvested: 0, colonyOf: parent.key });
        cityIndex.set(def.key, cities.length - 1);
        const grown = new Float64Array(cities.length);
        grown.set(miningCarry);
        miningCarry = grown;
        for (let rj = 0; rj < co.resources.length; rj++) scarceRuns.set(rj + ":" + parent.key, 0);
        return; // one colony per scan day
      }
    }
  };

  /** One whole unit of ore leaves the richest tile in the city's charter
   *  box (ties → lowest index) — deterministic, and the wakeup lets the
   *  substrate re-settle (lure falls, camps thin out). */
  const depleteOne = (ci: number): boolean => {
    let best = -1;
    let bestOre = 0;
    grid.topo.disk(cities[ci].cell, charterR, cell => {
      if (grid.fields.ore[cell] > bestOre) { bestOre = grid.fields.ore[cell]; best = cell; }
    });
    if (best === -1) return false;
    injectTile(grid, best, "ore", -1);
    return true;
  };

  const advanceDays = async (n: number): Promise<{ stepped: number; skipped: number }> => {
    let stepped = 0;
    let remaining = Math.floor(n);
    while (remaining > 0) {
      // Quiet tri-world (no mining, no pending foundings, colonies or
      // mergers, substrate at rest): the dual layer's resting jump is
      // exact for the whole world.
      if (!opts.mining && !opts.autoFound && !opts.merge && !opts.colonize && pendingCount(grid) === 0) {
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
      if (opts.colonize && dayCount % (opts.colonize.every ?? 5) === 0) {
        await maybeColonize();
      }
      if (opts.merge && dayCount % (opts.merge.every ?? 5) === 0) {
        maybeMerge();
      }
      // Keyframe AFTER the day's structural events — the frame records
      // the day as it ended.
      if (opts.history && dayCount % opts.history.every === 0) {
        captureFrame();
      }

      if (opts.mining) {
        const oreOut = dual.entityWorld.scalars[opts.mining.oreOutScalar];
        for (let ci = 0; ci < cities.length; ci++) {
          if (cities[ci].dead) continue; // ruins dig nothing
          const i = cityIndex.get(cities[ci].key)!;
          miningCarry[ci] += (oreOut ? oreOut[i] : 0) * opts.mining.rate;
          while (miningCarry[ci] >= 1) {
            if (!depleteOne(ci)) { miningCarry[ci] = 0; break; }
            miningCarry[ci] -= 1;
          }
          // Re-charter: the settlement reads the mountain as it is now.
          dual.entityWorld.scalars.ore_access[i] = boxSum(grid, "ore", cities[ci].cell, charterR);
        }
      }

      // Substrate catch-up: cheap while quiet, bounded while re-settling.
      const budget = opts.gridStepsPerDay ?? 4;
      let guard = 0;
      while (pendingCount(grid) > 0 && guard++ < budget) worldStep(grid);
    }
    return { stepped, skipped: 0 };
  };

  captureFrame(); // day-0 baseline: the world as founded

  return {
    grid,
    dual,
    ...(opts.economy ? { economy: opts.economy } : {}),
    cities,
    history: () => {
      if (!opts.history) return null;
      return {
        cities: cities.map(c => ({ key: c.key, name: c.name, x: c.x, y: c.y })),
        edges: dual.entityWorld.edges.map(e => ({ a: e.a, b: e.b })),
        frames: civFrames.slice(),
      };
    },
    historyFrames: () => civFrames.length,
    peopleScale: scale,
    charterOf: (key) => {
      const c = cities[cityIndex.get(key) ?? -1];
      if (!c) throw new Error(`charterOf: unknown city ${key}`);
      return charter(c.cell);
    },
    tierOf: (key) => {
      if (!opts.tiers || opts.tiers.length === 0) return null;
      const ci = cityIndex.get(key);
      if (ci === undefined) throw new Error(`tierOf: unknown city ${key}`);
      if (cities[ci].dead) return "ruin"; // a regime too — pop 0, permanent
      const pop = dual.settlementPop(key);
      let best = opts.tiers[0].key;
      for (const t of opts.tiers) if (pop >= t.min) best = t.key;
      return best;
    },
    gridPeople: () => {
      // Σ across EVERY wild species' field — the whole unharvested world.
      let s = 0;
      for (const w of wilds) {
        const arr = grid.fields[w.field];
        if (!arr) continue;
        for (const v of arr) s += v;
      }
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
