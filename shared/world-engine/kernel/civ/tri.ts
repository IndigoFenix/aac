/**
 * TriWorld — gate 6 (world-content.md §6): all three layers over one map.
 *
 *   Substrate  — the worldgen grid (height, rivers, fertility, ore, wild
 *                forage), settled to rest before anyone founds anything.
 *   Settlement — cell-systems entities chartered against the grid.
 *   Composition— demographic sites (the CompositionWorld seam; PopuSim
 *                in grand-dream) born from HARVESTED crowds.
 *
 * The two tri-specific couplings, both day-boundary:
 *   Harvest founding — a founding site's crowd leaves the grid as a BAND
 *     (bands.ts) and settles into the city's population (× peopleScale
 *     souls per grid person). The transaction conserves: Δ grid forage ×
 *     scale = the city's birth pop. Afterwards the forage REGROWS toward
 *     the land's lure — the wild is a renewable source, and later crowds
 *     can found later cities; the ongoing ledger is the dual layer's
 *     (births/deaths/histfigs).
 *   Mining depletion — each day a mining city's output draws down the ore
 *     tiles under it (richest first, deterministic), and its chartered
 *     ore_access follows. Ore is the substrate's one finite budget:
 *     exhausted mountains are a real long-arc event.
 */

import {
  createGrid, createGridOn, worldStep, pendingCount, injectTile, injectEntity,
  seedOreAboveTreeline, findFoundingSites, carveValleys, worldgenSubstrate,
  classifyNode, constraintCeiling, parasiteReading,
  type CellGrid, type FoundingSite, type FoundingOpts, type CarveOpts, type SystemSpec, type TopologySpec,
  type CeilingReading, type ConstraintDef,
} from "../cells/index";
import { hinterlandJobs, cityLicense, type CityLicense } from "./jobs";
import { seasonPhaseAtDay, seasonYieldAt, SPRING_PHASE } from "../../seasons";
import type { WorldScale } from "../../scale";
import { bootDual, type DualWorld, type DualSpec, type DualNode, type DualEdge } from "./dual";
import {
  gatherBand, settleBand, disperseBandFully, stepBandDay, bandPressure,
  gateASettles, gateAThreshold, PRESSURE_FLOOR_DEFAULT,
  type Band, type CapacityField, type WildSpecies,
} from "./bands";
import {
  freightOf, refineryLicense,
  type Freight, type NamedFreight, type RefineryVerdict,
  type TransportAsymmetry, type TransportMode,
} from "../../freight";
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
  /** PER-CELL runoff author (planet climate rain, sampled at this grid's
   *  cells): seeds the `runoff` field the substrate's river var reads as
   *  its `sourceField`, so accumulation measures upstream RAINFALL, not
   *  bare catchment area. Normalize to ~1 at the mean so the shared
   *  watercourse thresholds keep their meaning; multiplies with `rain`.
   *  Omitted = uniform sources (unchanged behaviour). */
  runoff?: (x: number, y: number) => number;
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
  // Seed BEFORE the settle: the river var's `sourceField: 'runoff'` reads this
  // on every flow recompute, so the network that carves/greens is rain-shaped.
  if (opts.runoff) {
    const runoff = new Float64Array(opts.cols * opts.rows);
    for (let y = 0; y < opts.rows; y++) {
      for (let x = 0; x < opts.cols; x++) runoff[y * opts.cols + x] = Math.max(0, opts.runoff(x, y));
    }
    grid.fields.runoff = runoff;
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
  /** PER-CELL runoff author — see PrepareOpts.runoff (cell-indexed here). */
  runoff?: (cell: number) => number;
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
  // Seed BEFORE the settle — see the note in prepareSubstrate.
  if (opts.runoff) {
    const runoff = new Float64Array(n);
    for (let c = 0; c < n; c++) runoff[c] = Math.max(0, opts.runoff(c));
    grid.fields.runoff = runoff;
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
  /** SEASONALITY (settlement-emergence.md §6, step ②): the world's orbital
   *  phase modulates the GROWTH charters each day — `farmland` (and
   *  `pasture`) are written as charter × seasonYield(phase), so farm output
   *  swells through the fat season and dies through the lean one while the
   *  substrate's fertility keeps resting (only the DRAW cycles). The curve's
   *  annual mean is 1: a seasonal world grows the same yearly total, it just
   *  has to BANK it — pair with the food net's `driftFeeds` granary or the
   *  town starves every winter. Timber and ore charters don't cycle (a tree
   *  is wood all year; the mountain doesn't melt). Opt-in; a seasonal world
   *  steps its days (no resting O(1) jump — the season IS the motion). */
  seasons?: {
    /** The world's clock — leanFraction + yearGameDays come from here. */
    scale: WorldScale;
    /** Charter scalars that grow (default ["farmland", "pasture"]). */
    fields?: Array<keyof TriCharter>;
    /** Orbital phase at day 0 (default SPRING_PHASE = 0.25 — found in
     *  spring, a whole fat season before the first winter). */
    phase0?: number;
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
  /** GATE A (settlement-emergence.md §5, step ④) — founding as an
   *  ECONOMIC EVENT instead of a census. Opt-in, and it changes what
   *  autoFound means: the best crowd still GATHERS (bands.ts), but the
   *  band then LIVES — draws its box's forage each day (seasonal via
   *  `seasons`), banks the surplus, watches the bank spoil at its
   *  staple's keepDays — and only SETTLES when
   *  `store > carryCapacity ∧ pressure ≥ floor`. A band that finds
   *  comparable unclaimed land within walking reach walks away
   *  (disperses back into the wild — the rich open frontier grows no
   *  cities); a band that can't eat walks before it starves. Requires
   *  `autoFound` (the scan, the cadence, the factory). Without this
   *  block, autoFound keeps the shipped density-threshold behaviour
   *  bit for bit. */
  bandFounding?: {
    /** The world's clock — appetite (metabolism) and spoilage read it. */
    scale: WorldScale;
    /** Relocation reach of the pressure scan, in CELLS — how far a band
     *  could walk to comparable land. The caller derives it from its
     *  metre pitch (the engine never names a distance). */
    searchCells: number;
    /** Settle only when the best unclaimed alternative is at least this
     *  fraction worse than home (default PRESSURE_FLOOR_DEFAULT). */
    pressureFloor?: number;
    /** The staple the band banks — freight key resolved against the
     *  compiled economy's rows, then the registry (default "food"). */
    storeGood?: string;
    /** Bulk units one back carries (default REAL_PORTER_BULK). */
    portableBulk?: number;
    /** Cap on a GATHERED band (grid persons; composes with the founding's
     *  own maxHarvest — the smaller wins). Load-bearing: a band harvested
     *  AT its land's capacity has zero surplus by the mean-1 law and
     *  never fills a store — the band must be smaller than the box that
     *  feeds it (FOUND SMALL, one layer down). */
    maxBand?: number;
    /** GATE D (settlement-emergence.md §5) — the reverse, and it must
     *  exist: a settlement whose fill stays under `stallFill` for
     *  `window` consecutive cadence scans ABANDONS. The population does
     *  not riot and does not die — it WALKS, off the composition
     *  (dual.abandonSettlement — emigrants, never deaths) and back into
     *  a wild BAND standing on the ruin, which then lives or walks under
     *  Gate A like any band. Ruins stay re-foundable; a collapse feeds
     *  the next founding somewhere else. One abandonment per scan day. */
    desettle?: {
      /** Settlement scalars for the fill test (demand / met). */
      needScalar: string;
      gotScalar: string;
      /** Failing = fill < stallFill (default 0.5 — outright famine,
       *  deliberately harsher than merge's mild-stall 0.95). */
      stallFill?: number;
      /** Consecutive failing scans before the crowd walks (default 3). */
      window?: number;
    };
  };
  /** REFINERY LICENSING (resources-and-trade.md §③) — the WHY-HERE for
   *  every building the compiled economy declares `refines`. Each day,
   *  every living city's `{building}_license` scalar is written from the
   *  transport math (freight.ts refineryLicense): 1 when the nearest
   *  living settlement — the market — lies beyond the RAW good's carry
   *  reach (the town refines what it grows, or stays a village), else 0
   *  (ship it raw; the refinery's build rule stays shut — DISTANCE is
   *  the reason refining exists). A lone city has no market at all and
   *  is licensed (the shadow case at its purest). Already-built
   *  refineries stand when a market moves closer: counts are monotone —
   *  losing the license stops growth, never demolishes history.
   *  Requires a compiled economy. Without this block, licenses keep the
   *  compiler's initial 1 — every town may refine, the pre-③ behaviour,
   *  bit for bit. */
  refineLicensing?: {
    /** The world's clock — reach is legs × appetite (carryReachM). */
    scale: WorldScale;
    /** Metres per grid cell — the bridge from lattice distance to the
     *  freight arithmetic (the caller knows its pitch; the engine never
     *  names a distance). */
    cellM: number;
    /** Carry mode against the asymmetry (default "land" — route-aware
     *  water reach belongs to §⑤'s graph). */
    mode?: TransportMode;
    /** The world's declared asymmetry (default the Earth anchor). */
    asym?: TransportAsymmetry;
  };
  /** CONSTRAINT CEILINGS (resources-and-trade.md §④) — the anchor stops
   *  being hand-authored: each day every living city's `scalar` (default
   *  "pop_ceiling") is written as the MIN of its declared constraints
   *  over its supply zone (land disc + river ribbons at the world's
   *  asymmetry — cells/ceilings.ts). The scalar is a DERIVED ANCHOR the
   *  existing machinery consumes: a content doc that binds the primary
   *  species' `vitals.capacity` to it makes births taper as the city
   *  approaches what its land can feed — no new dynamics, the pens
   *  machinery at city scale. ⚠ Bind that capacity ONLY in worlds that
   *  declare this block: a declared capacity over a never-written scalar
   *  reads 0 and stops births outright. A city ABOVE its ceiling is a
   *  PARASITE (legal only while a partner covers the gap — §⑤);
   *  `ceilingReport()` prints the verdicts. Requires the settlement spec
   *  to declare the scalar (fails loud at boot). */
  ceilings?: {
    scale: WorldScale;
    /** Metres per grid cell (the caller knows its pitch). */
    cellM: number;
    /** The factors — content: fields, rates, and the freight good that
     *  prices each reach (fuel's wood disc is smaller than food's). */
    constraints: ConstraintDef[];
    /** Settlement scalar receiving the ceiling (default "pop_ceiling" —
     *  a sanctioned structural scalar). */
    scalar?: string;
    asym?: TransportAsymmetry;
    watercourse?: number;
    maxReachCells?: number;
    maxZoneCells?: number;
    /** GATE C (settlement-emergence.md §5): size licensed by FUNCTION —
     *  a settlement with no HINTERLAND JOB caps at village, whatever its
     *  land could feed (min'd into the same ceiling scalar; both anchors
     *  must pass). Jobs derive from what already shipped: the §② node
     *  taxonomy read off this grid at the city cell (mouth / anchorage /
     *  chokepoint / junction / extraction — `surplus` is a fat village,
     *  not a job), the road graph (a HUB of ≥ hubDegree living spokes =
     *  the store of last resort), and §③'s refinery licenses (honest
     *  only where `refineLicensing` runs — an unwritten license reads
     *  its compiled initial 1). A city that LOSES its job is not
     *  desettled: it shrinks back toward the village line under the same
     *  births-taper that grew it (Bruges silted up and became a town
     *  again; famine — Gate D — stays the only violent exit). */
    jobs?: {
      /** The village line in souls. Default: the SECOND-lowest declared
       *  tier threshold (the world's own "town" line — a ratio of
       *  declared quantities); required explicitly when the world
       *  declares fewer than two tiers. */
      villageHeads?: number;
      /** Living road neighbours at/over which the settlement is a hub
       *  (default 3 — variance reduction needs neighbours). */
      hubDegree?: number;
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
  /** Σ wild crowds currently on the grid (every wild species' forage
   *  field — the whole unharvested world, in grid persons). */
  gridPeople(): number;
  /** LIVE bands (bandFounding worlds; [] otherwise) — gathered crowds
   *  between the wild and the founding, in gather order. */
  bands(): ReadonlyArray<Band>;
  /** The refinery verdicts, one per living city × declared refinery
   *  (refineLicensing worlds; [] otherwise) — the fractal law's printed
   *  WHY-HERE, recomputed fresh from today's geography. */
  refineryReport(): Array<{
    city: string; building: string; licensed: boolean;
    verdict: RefineryVerdict; sentence: string;
  }>;
  /** The ceiling verdicts, one per living city (ceilings worlds; []
   *  otherwise) — the derived cap, its binding constraint, the parasite
   *  diagnostic against today's population, and (jobs worlds) the Gate C
   *  license with its hinterland jobs. `ceiling` is the EFFECTIVE anchor
   *  written to the scalar: min of the resource reading and the license
   *  cap — both must pass. */
  ceilingReport(): Array<{
    city: string; pop: number; ceiling: number; reading: CeilingReading;
    license?: CityLicense; parasite: boolean; sentence: string;
  }>;
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
  // base `forage` capacity field), others per the compiled economy.
  // Fields the grid doesn't carry are skipped (fixed worlds on the
  // bare substrate).
  const wilds: WildSpecies[] = (
    opts.economy?.species
      ?.filter(s => s.role === "sapient" && s.wild)
      .map(s => ({
        key: s.key,
        field: s.wild!.field,
        habitat: { field: s.wild!.habitat, scale: s.wild!.scale ?? 2 },
      }))
    ?? []
  );
  if (!wilds.length) {
    wilds.push({ key: "human", field: "forage", habitat: { field: "lure", scale: 2 } });
  }

  // The founding transaction, substrate side (bands.ts): the wild crowd
  // in the box leaves the grid as a BAND — an entity — and the band
  // settles, an ordinary state change. Today every gathered band settles
  // immediately (step ③ is behaviour-preserving); step ④'s Gate A is
  // where a band lives between the two. FOUND SMALL applies to the
  // GATHER (founding.maxHarvest, §2a one layer down): a fat box gives
  // up at most the cap, apportioned across species largest-remainder
  // (the mix keeps its proportions), and the RESIDUE stays wild — it
  // regrows, and may gate a later founding nearby.
  const harvest = (c: FoundingSite): { total: number; mix: Record<string, number> } =>
    settleBand(gatherBand(grid, wilds, c, {
      radius: prep.founding.radius,
      maxHarvest: prep.founding.maxHarvest,
    }));

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

  /** Today's season yield factor (1 on an aseasonal world) — the ONE
   *  number both the city charters and the bands' forage draw read, so
   *  the settled and the mobile feel the same winter. */
  const seasonFactorAt = (day: number): number => {
    const se = opts.seasons;
    if (!se) return 1;
    return seasonYieldAt(
      seasonPhaseAtDay(se.scale, day, se.phase0 ?? SPRING_PHASE),
      se.scale.leanFraction,
    );
  };

  /** Seasonal charter modulation (step ②): write each living city's growth
   *  charters as charter(cell) × seasonYield(phase of `day`). Reads the
   *  charter fresh (so mining depletion, sculpting and climate stay
   *  honest) and touches only the declared fields — the substrate rests;
   *  the DRAW cycles. */
  const applySeasons = (day: number): void => {
    const se = opts.seasons;
    if (!se) return;
    const y = seasonFactorAt(day);
    const fields = se.fields ?? (["farmland", "pasture"] as Array<keyof TriCharter>);
    for (let ci = 0; ci < cities.length; ci++) {
      if (cities[ci].dead) continue;
      const ch = charter(cities[ci].cell);
      for (const f of fields) {
        const arr = dual.entityWorld.scalars[f];
        if (arr) arr[ci] = ch[f] * y;
      }
    }
  };

  /** The best qualifying crowd site across every wild species' field —
   *  each species scouts its own field (dwarven crowds on the ore ridges
   *  gate foundings exactly like human crowds in the valleys); ties break
   *  in species declaration order — deterministic. */
  const bestCrowdSite = (occupied: Array<[number, number]>): FoundingSite | null => {
    const auto = opts.autoFound!;
    let at: FoundingSite | null = null;
    // ONE GATE, TWO ARMS (growth phase C §3.1). With bands declared, the
    // scan that picks where a band GATHERS reads the same threshold Gate A
    // will read when that band decides to STAY — the closed form of the very
    // loop below (`gateAThreshold`), so the two arms cannot disagree about
    // which land is worth settling. The census path (no `bandFounding`)
    // keeps the caller's authored scan, byte for byte.
    const threshold = scanThreshold();
    for (const w of wilds) {
      if (!grid.fields[w.field]) continue;
      const candidates = findFoundingSites(grid, {
        ...prep.founding,
        ...(threshold !== null ? { threshold } : {}),
        score: auto.score,
        forageField: w.field,
        occupied,
      });
      if (candidates.length && (!at || candidates[0].score > at.score)) at = candidates[0];
    }
    return at;
  };

  /** Commit a founding: the crowd (already off the grid) becomes a city
   *  with a road to its nearest living neighbour. Shared by the census
   *  path (maybeFound) and the Gate A path (a settling band). */
  const commitFounding = async (at: FoundingSite, taken: number, mix: Record<string, number>): Promise<boolean> => {
    const auto = opts.autoFound!;
    const living = cities.filter(c => !c.dead);
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
    if (idx < 0) return false;
    cities.push({ key: def.key, name: def.name, x: at.x, y: at.y, cell: at.cell, harvested: taken });
    cityIndex.set(def.key, cities.length - 1);
    harvestedTotal += taken;
    const grown = new Float64Array(cities.length);
    grown.set(miningCarry);
    miningCarry = grown;
    return true;
  };

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
    const at = bestCrowdSite(cities.filter(c => !c.dead).map(c => [c.x, c.y] as [number, number]));
    if (!at) return;
    const { total: taken, mix } = harvest(at);
    if (taken <= 0) return;
    await commitFounding(at, taken, mix);
  };

  // ---- GATE A (step ④): bands live between the wild and the founding ----

  const bf = opts.bandFounding;
  if (bf && !opts.autoFound) {
    throw new Error("foundTri: bandFounding requires autoFound (its scan, cadence and factory)");
  }
  const bands: Band[] = [];
  /** The staple a band banks: the economy's resolved row, else the
   *  freight registry's (spoilage reads its keepDays). */
  const bandStaple: Freight = ((): Freight => {
    const good = bf?.storeGood ?? "food";
    return opts.economy?.freights.find(f => f.good === good) ?? freightOf(good);
  })();
  /** What the land OFFERS a band per period: the habitat × scale each
   *  wild converges toward (falling back to the crowd field itself on a
   *  grid without the habitat) — never the standing crop a gather just
   *  emptied. */
  const bandFields = (): CapacityField[] => wilds.map(w =>
    w.habitat && grid.fields[w.habitat.field]
      ? { field: w.habitat.field, scale: w.habitat.scale ?? 1 }
      : w.field,
  );

  /** The FOUND-SMALL take a gather here would actually lift: the scan's own
   *  cap and the band cap, whichever binds (tri.ts's own rule below). */
  const bandTake = (): number | null => {
    const caps = [prep.founding.maxHarvest, bf?.maxBand].filter((c): c is number => c !== undefined);
    return caps.length ? Math.min(...caps) : null;
  };

  /**
   * THE SCAN'S THRESHOLD, CLOSED FORM (growth phase C §3.1) — null when this
   * world declares no bands, in which case nothing here speaks and the
   * caller's authored scan stands untouched.
   *
   * Declared beside the band machinery it reads (`bf`, `bandStaple`) rather
   * than beside its one caller: `bestCrowdSite` is a closure the day loop
   * calls, long after this line has run.
   */
  const scanThreshold = (): number | null => {
    if (!bf) return null;
    const take = bandTake();
    if (take === null) return null;
    return gateAThreshold(bf.scale, bandStaple, take, { portableBulk: bf.portableBulk });
  };

  /** Land already spoken for, from `self`'s point of view: living cities'
   *  charter boxes and other bands' working boxes. */
  const claimedFor = (self: Band) => (cell: number): boolean => {
    const cR2 = charterR * charterR;
    const bR2 = prep.founding.radius * prep.founding.radius;
    for (const c of cities) {
      if (!c.dead && grid.topo.dist2(cell, c.cell) <= cR2) return true;
    }
    for (const b of bands) {
      if (b !== self && grid.topo.dist2(cell, b.cell) <= bR2) return true;
    }
    return false;
  };

  /** One game day of every band's life (day-boundary surgery, like
   *  mining): draw the box's seasonal yield, eat, bank, spoil. A band
   *  the land plus the store can't feed WALKS — back into the wild,
   *  conserving — before it starves (bands are mobile; that is the
   *  whole point of them). */
  const stepBands = (day: number): void => {
    if (!bf) return;
    const y = seasonFactorAt(day);
    for (let i = bands.length - 1; i >= 0; i--) {
      const report = stepBandDay(grid, bands[i], {
        scale: bf.scale,
        radius: prep.founding.radius,
        fields: bandFields(),
        freight: bandStaple,
        yieldFactor: y,
      });
      if (report.shortfall > 0) {
        disperseBandFully(grid, wilds, bands[i], prep.founding.radius);
        bands.splice(i, 1);
      }
    }
  };

  // Per-city consecutive-failure counters for Gate D (the colonize
  // scarceRuns shape — reads are by explicit key, order never matters).
  const stallRuns = new Map<string, number>();

  /** GATE D: sustained famine ⇒ the settlement abandons. The crowd walks
   *  off the composition (emigrants, never deaths) and becomes a BAND on
   *  the ruin — Gate A decides its future like any band's: walk to
   *  better land, starve-walk into the wild, or bank and re-found (the
   *  ruin doesn't block: founding sees only the living). */
  const maybeDesettle = (): void => {
    const ds = bf?.desettle;
    if (!ds) return;
    const ew = dual.entityWorld;
    const needArr = ew.scalars[ds.needScalar];
    const gotArr = ew.scalars[ds.gotScalar];
    if (!needArr || !gotArr) throw new Error(`desettle: unknown scalars ${ds.needScalar}/${ds.gotScalar}`);
    const stallFill = ds.stallFill ?? 0.5;
    const windowLen = ds.window ?? 3;

    for (let ci = 0; ci < cities.length; ci++) {
      const city = cities[ci];
      if (city.dead) continue;
      const failing = needArr[ci] > 0 && gotArr[ci] / needArr[ci] < stallFill;
      const run = failing ? (stallRuns.get(city.key) ?? 0) + 1 : 0;
      stallRuns.set(city.key, run);
      if (run < windowLen) continue;

      // Who lives here, read BEFORE the walk (species = trait carriers).
      const soulsBySpecies = wilds.map(w => dual.popOnSiteWithTrait(city.key, w.key));
      const walked = dual.abandonSettlement(city.key);
      if (walked <= 0) continue;
      city.dead = { day: dayCount, pop: walked };
      stallRuns.delete(city.key);

      // Souls → grid persons, apportioned across species by who lived
      // there (largest remainder; an untraited crowd is all-primary).
      const size = Math.max(1, Math.round(walked / scale));
      const soulsTotal = soulsBySpecies.reduce((a, b) => a + b, 0);
      const mix: Record<string, number> = {};
      if (soulsTotal <= 0) {
        mix[wilds[0].key] = size;
      } else {
        let placed = 0;
        const shares = wilds.map((w, i) => {
          const exact = (size * soulsBySpecies[i]) / soulsTotal;
          const base = Math.floor(exact);
          if (base > 0) mix[w.key] = base;
          placed += base;
          return { i, rem: exact - base };
        });
        shares.sort((a, b) => b.rem - a.rem || a.i - b.i);
        for (const s of shares) {
          if (placed >= size) break;
          if (s.rem > 0) { mix[wilds[s.i].key] = (mix[wilds[s.i].key] ?? 0) + 1; placed++; }
        }
      }
      bands.push({ cell: city.cell, mix, size, store: 0, mode: "forager" });
      return; // one abandonment per scan day — a collapse is an event
    }
  };

  /** The Gate A cadence (rides autoFound's `every`): standing bands
   *  decide — walk away (free comparable land in reach: the frontier
   *  case), settle (store > carry AND cornered), or keep banking — and
   *  then at most one new band gathers at the best crowd. */
  const maybeBands = async (): Promise<void> => {
    if (!bf) return;
    const auto = opts.autoFound!;
    const floor = bf.pressureFloor ?? PRESSURE_FLOOR_DEFAULT;

    for (let i = bands.length - 1; i >= 0; i--) {
      const band = bands[i];
      const reading = bandPressure(grid, bandFields(), band, {
        radius: prep.founding.radius,
        searchCells: bf.searchCells,
        claimed: claimedFor(band),
      });
      if (reading.pressure < floor) {
        // A rich open frontier grows no cities: comparable unclaimed
        // land within walking reach — no store binds you.
        disperseBandFully(grid, wilds, band, prep.founding.radius);
        bands.splice(i, 1);
        continue;
      }
      if (gateASettles(band, bandStaple, reading, { portableBulk: bf.portableBulk, pressureFloor: floor })) {
        const at: FoundingSite = {
          x: band.cell % grid.cols, y: (band.cell / grid.cols) | 0,
          cell: band.cell, density: band.size, score: band.size,
        };
        const crowd = settleBand(band);
        // A refused founding keeps the band standing (people conserved).
        if (await commitFounding(at, crowd.total, crowd.mix)) bands.splice(i, 1);
      }
    }

    // Gate D AFTER the standing bands' decisions: a crowd that abandons
    // today STANDS on its ruin until the next cadence — the collapse and
    // the walk are two events, not one.
    maybeDesettle();

    if (auto.maxCities !== undefined && cities.filter(c => !c.colonyOf).length >= auto.maxCities) return;
    const occupied: Array<[number, number]> = [
      ...cities.filter(c => !c.dead).map(c => [c.x, c.y] as [number, number]),
      ...bands.map(b => [b.cell % grid.cols, (b.cell / grid.cols) | 0] as [number, number]),
    ];
    const at = bestCrowdSite(occupied);
    if (!at) return;
    const take = bandTake();
    const band = gatherBand(grid, wilds, at, {
      radius: prep.founding.radius,
      ...(take !== null ? { maxHarvest: take } : {}),
    });
    if (band.size > 0) bands.push(band);
  };

  // ---- REFINERY LICENSING (resources-and-trade.md §③): the why-here ----

  const rl = opts.refineLicensing;
  if (rl && !opts.economy) {
    throw new Error("foundTri: refineLicensing requires a compiled economy (its refineries and freights)");
  }
  const refineFreight = (good: string): NamedFreight =>
    opts.economy?.freights.find(f => f.good === good) ?? { good, ...freightOf(good) };

  /** One living city × one declared refinery: the market is the nearest
   *  OTHER living settlement (as the crow flies × cellM — route-aware
   *  water reach is §⑤'s); no other settlement = no market = licensed. */
  const refineVerdict = (city: TriWorld["cities"][number], r: { from: string; into: string }): RefineryVerdict => {
    let best = Infinity;
    for (const o of cities) {
      if (o === city || o.dead) continue;
      const d2 = grid.topo.dist2(city.cell, o.cell);
      if (d2 < best) best = d2;
    }
    const marketDistM = Number.isFinite(best) ? Math.sqrt(best) * rl!.cellM : Infinity;
    return refineryLicense(rl!.scale, refineFreight(r.from), refineFreight(r.into), marketDistM, {
      ...(rl!.mode ? { mode: rl!.mode } : {}),
      ...(rl!.asym ? { asym: rl!.asym } : {}),
    });
  };

  /** Write every living city's license scalars from today's geography —
   *  cheap (cities² × refineries) and self-healing: foundings, mergers
   *  and desettlements all move markets, and the next day's write
   *  reflects it (a city founded today is honest before its first
   *  settlement step). Ruins keep their last value: their rules rest. */
  const refreshRefineLicenses = (): void => {
    if (!rl) return;
    for (const r of opts.economy!.refineries) {
      const arr = dual.entityWorld.scalars[r.license];
      if (!arr) continue; // no construction ⇒ no license var ⇒ nothing gates
      for (let ci = 0; ci < cities.length; ci++) {
        if (cities[ci].dead) continue;
        arr[ci] = refineVerdict(cities[ci], r).licensed ? 1 : 0;
      }
    }
  };

  // ---- CONSTRAINT CEILINGS (resources-and-trade.md §④): derived anchors ----

  const ce = opts.ceilings;
  const ceilingScalar = ce?.scalar ?? "pop_ceiling";
  if (ce && !dual.entityWorld.scalars[ceilingScalar]) {
    throw new Error(`foundTri: ceilings requires the settlement spec to declare "${ceilingScalar}"`);
  }
  // GATE C's village line: the world's own tier vocabulary — the second-
  // lowest declared threshold is where "village" ends and "town" begins.
  const villageHeads = ((): number => {
    if (!ce?.jobs) return 0;
    if (ce.jobs.villageHeads !== undefined) return ce.jobs.villageHeads;
    const mins = (opts.tiers ?? []).map(t => t.min).sort((a, b) => a - b);
    if (mins.length < 2) {
      throw new Error("foundTri: ceilings.jobs needs villageHeads, or at least two declared tiers to read the town line from");
    }
    return mins[1];
  })();

  /** GATE C: this settlement's hinterland jobs and its license, read
   *  fresh — the node taxonomy off the grid, the hub off the LIVING road
   *  graph, the refineries off their current license scalars. */
  const licenseOf = (ci: number): CityLicense => {
    const city = cities[ci];
    const ew = dual.entityWorld;
    let roadDegree = 0;
    for (const e of ew.adj[ci] ?? []) {
      const oi = ew.edges[e].a === ci ? ew.edges[e].b : ew.edges[e].a;
      if (cities[oi] && !cities[oi].dead) roadDegree++;
    }
    const refineries = (opts.economy?.refineries ?? []).map(r => {
      const arr = ew.scalars[r.license];
      return { building: r.building, from: r.from, into: r.into, licensed: arr ? arr[ci] >= 1 : true };
    });
    const jobs = hinterlandJobs({
      node: classifyNode(grid, city.cell),
      roadDegree,
      ...(ce?.jobs?.hubDegree !== undefined ? { hubDegree: ce.jobs.hubDegree } : {}),
      refineries,
    });
    return cityLicense(jobs, villageHeads);
  };

  /** One living city's reading, off today's RESTING fields (a ceiling is
   *  annualized capacity — the granary crosses the winter; the lean
   *  months cap the store, not the head-count). Mining depletion,
   *  sculpting and climate all move it, which is why it re-reads. */
  const ceilingOf = (city: TriWorld["cities"][number]): CeilingReading =>
    constraintCeiling(grid, city.cell, {
      scale: ce!.scale,
      cellM: ce!.cellM,
      constraints: ce!.constraints,
      ...(ce!.asym ? { asym: ce!.asym } : {}),
      ...(ce!.watercourse !== undefined ? { watercourse: ce!.watercourse } : {}),
      ...(ce!.maxReachCells !== undefined ? { maxReachCells: ce!.maxReachCells } : {}),
      ...(ce!.maxZoneCells !== undefined ? { maxZoneCells: ce!.maxZoneCells } : {}),
    });

  /** Write every living city's derived anchor — the pens machinery at
   *  city scale reads it (vitals.capacity), so births taper as the town
   *  approaches what its land actually feeds. With `jobs` declared, the
   *  Gate C license MINs in: both anchors must pass — the worst resource
   *  AND the reason to exist. Ruins keep their last value: their rules
   *  rest. */
  const refreshCeilings = (): void => {
    if (!ce) return;
    const arr = dual.entityWorld.scalars[ceilingScalar];
    for (let ci = 0; ci < cities.length; ci++) {
      if (cities[ci].dead) continue;
      let v = ceilingOf(cities[ci]).ceiling;
      if (ce.jobs) v = Math.min(v, licenseOf(ci).cap);
      arr[ci] = v;
    }
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
      // mergers, no seasonal cycle, substrate at rest): the dual layer's
      // resting jump is exact for the whole world. A seasonal world steps
      // its days — the season is real motion, not a resting state.
      if (!opts.mining && !opts.autoFound && !opts.merge && !opts.colonize && !opts.seasons && pendingCount(grid) === 0) {
        const r = await dual.advanceDays(remaining);
        return { stepped: stepped + r.stepped, skipped: r.skipped };
      }
      applySeasons(dayCount);
      stepBands(dayCount); // the bands' day, on the same season the charters felt
      await dual.step();
      stepped++;
      remaining--;
      dayCount++;

      if (opts.autoFound && dayCount % opts.autoFound.every === 0) {
        if (opts.bandFounding) await maybeBands();
        else await maybeFound();
      }
      if (opts.colonize && dayCount % (opts.colonize.every ?? 5) === 0) {
        await maybeColonize();
      }
      if (opts.merge && dayCount % (opts.merge.every ?? 5) === 0) {
        maybeMerge();
      }
      // Licenses and ceilings re-read the day's final geography
      // (structural events move markets; mining and sculpting move
      // fields) — a static world already holds its boot-time verdicts
      // through the resting jump.
      refreshRefineLicenses();
      refreshCeilings();
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

  applySeasons(0); // a seasonal world is born already in its season
  refreshRefineLicenses(); // founding-day geography, before any rule fires
  refreshCeilings(); // the derived anchors exist before the first birth
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
    bands: () => bands,
    refineryReport: () => {
      if (!rl || !opts.economy) return [];
      const out: ReturnType<TriWorld["refineryReport"]> = [];
      for (const c of cities) {
        if (c.dead) continue;
        for (const r of opts.economy.refineries) {
          const v = refineVerdict(c, r);
          out.push({
            city: c.key, building: r.building, licensed: v.licensed,
            verdict: v, sentence: `${c.name} ${v.sentence}`,
          });
        }
      }
      return out;
    },
    ceilingReport: () => {
      if (!ce) return [];
      const out: ReturnType<TriWorld["ceilingReport"]> = [];
      for (let ci = 0; ci < cities.length; ci++) {
        const c = cities[ci];
        if (c.dead) continue;
        const reading = ceilingOf(c);
        const license = ce.jobs ? licenseOf(ci) : undefined;
        const ceiling = Math.min(reading.ceiling, license?.cap ?? Infinity);
        const pop = dual.settlementPop(c.key);
        const p = parasiteReading(pop, reading);
        out.push({
          city: c.key, pop, ceiling, reading,
          ...(license ? { license } : {}),
          parasite: p.parasite,
          sentence: `${c.name} ${reading.sentence}` +
            (license ? `; ${license.sentence}` : "") +
            `; ${p.sentence}`,
        });
      }
      return out;
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
