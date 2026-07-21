/**
 * Shared tri-world definitions — the §6 acceptance world and the
 * many-settlements stress world, used by BOTH the vitest suites and the
 * lab (one source of truth, so what the tests prove is what the lab
 * shows).
 */

import { findFoundingSites, worldgenSubstrate, type FoundingSite } from "@cells/index";
import { prepareSubstrate, foundTri, type TriCharter, type TriPrep, type TriWorld } from "./tri";
import { runTectonics, bakeAuthors, type TectonicFrame } from "./tectonics";
import type { DualSpec } from "./dual";
import {
  citizenStartpop, compileEconomy, harvestStartpop, wildSubstrate,
  type CompiledEconomy, type EconomyDoc,
} from "./economy";
import { CORE_BASE, CORE_GOODS2 } from "./economy-core";
import { CLOTHING } from "./economy-clothing";
import { WILDLIFE } from "./economy-wildlife";
import { DWARVES } from "./economy-dwarves";

export const TREELINE = 40;
// Threshold sized for the TIGHT fertility band (grass hugs streams now,
// so qualifying crowds are river-bank bands, not broad valley sprawls).
// maxHarvest (§2a, applied to the HARVEST — step 6f follow-up): a
// founding takes at most 600 grid persons (15k souls — squarely the
// village band), so a fat MIXED box (human + dwarven fields stacked)
// still founds SMALL and leaves the residue wild. Single-species boxes
// on this substrate top out under the cap (~470), so every calibrated
// human arc is untouched.
export const FOUNDING = { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 };

/** West ridge over an eastward valley with a channel at y=16. */
export function ridgeValley(x: number, y: number): number {
  return x < 8 ? 50 : Math.min(63, Math.max(3, 26 - (x - 8)) + Math.abs(y - 16));
}

/** Three ridge/valley stripes with offset channels: many fertile pockets,
 *  three ore ridges — a dozen-plus cities of varied size and biome. */
export function stripes(x: number, y: number): number {
  const s = Math.floor(x / 24);
  const local = x % 24;
  return local < 6 ? 50 : Math.min(63, Math.max(3, 24 - local) + Math.abs(y - (8 + s * 8)));
}

/** Settlement TIERS (civilization-emergence.md §2a): render-and-dynamics
 *  regimes over the population scalar, nothing more. Data, not code —
 *  future lifecycle events (colonization, conquest) arm by tier. Sized
 *  to this economy as MEASURED: wild crowds pool to capacity fast, so
 *  foundings land at ~10–19k souls (a radius-2 box maxes at 775 grid
 *  people × scale 25 ≈ 19k) — always a village; a mid charter carries
 *  ~35k (town); only fat river-valley charters reach ~85k (city). */
export const TIERS: Array<{ key: string; min: number }> = [
  { key: "village", min: 0 },
  { key: "town", min: 20_000 },
  { key: "city", min: 40_000 },
];

/** Construction costs live with the content now (economy-core.ts) —
 *  re-exported so calibration notes and older call sites keep working.
 *  Guards are STAGGERED cumulatively (farm ≥ 20, mine ≥ 50, smelter ≥
 *  90) so every rule that fires in one step is fully funded — guards
 *  read step-start state, so independent thresholds could overdraw.
 *  The stagger is now a COMPILER LAW (economy.ts), not hand-arithmetic.
 *
 *  CALIBRATION LAW (measured in genesis): at Malthus equilibrium
 *  fill* < 1, so the food net's drift is ≤ 0 — surplus exists only in
 *  the FED TRANSIENT after each build re-opens headroom. A cost must sit
 *  inside that transient's integral (~3–5 surplus/day for ~10–25 days
 *  before population catches up) or construction fires once and starves:
 *  at cost 60 a village built ONE farm in 200 days; at 20 the ladder
 *  climbs to the charter cap ahead of the population. */
export {
  FARM_COST, MINE_COST, SMELTER_COST, SAWMILL_COST, SMITHY_COST, SMITHY_PLANKS,
} from "./economy-core";

/** Economic absorption profile (civilization-emergence.md §2b): a stalled
 *  settlement within 10 tiles of a same-civ, cold-border neighbor 3× its
 *  size folds into it. Sized so similar-age siblings coexist (genesis
 *  villages mature within ~1.5× of each other) and only a genuinely
 *  outgrown neighbor absorbs. */
export const MERGE = {
  every: 5,
  range: 10,
  ratio: 3,
  stallFill: 0.95,
  needScalar: "food_need",
  gotScalar: "food_got",
  hostilityAttr: "hostility",
};

const COLONY_NAMES = ["Orehold", "Deepdig", "Stonegate", "Pickhaven", "Gritmoor", "Farshaft"];

/** Half the colony cost arrives AS the camp's starting granary — the
 *  expedition carries stores. This matters structurally, not just for
 *  flavor: colonies tend to found when the parent already sits at its
 *  Malthus plateau, where the food net's drift is ≤ 0 (the step-1
 *  calibration law) — a camp waiting on the component's surplus mean
 *  would never bank its first mine. Carried stores break that trap: the
 *  camp builds mine + smelter off its own wagons, then lives on imports
 *  and its ore. */
export const COLONY_STORES = 150;

/** Colonization profile (civilization-emergence.md §2c): a TOWN whose
 *  metal fill has sat under 50% for 3 scans, with a funded granary,
 *  founds a mining camp on the best ore within 30 tiles — colonists walk
 *  from the parent, so the camp is born inside the civ (uniform
 *  migration carries the membership trait; no startpop needed). The cost
 *  (300 — most of the granary clamp) means expansion only follows a
 *  built-out, food-secure home town, and re-arming takes real
 *  accumulation. Only for `triBase({construction: true})` worlds — the
 *  granary is the funding scalar. */
export const COLONIZE = {
  every: 5,
  minTier: "town",
  window: 3,
  cost: 300,
  costScalar: "granary",
  colonists: 2_000,
  range: 30,
  maxColonies: 4,
  resources: [
    { field: "ore", needScalar: "metal_need", gotScalar: "metal_got", threshold: 0.5, minField: 40 },
  ],
  colonyFactory: (_site: unknown, index: number, _ch: TriCharter, _parent: string) => ({
    key: `camp${index}`,
    name: COLONY_NAMES[index] ?? `Camp ${index + 1}`,
    scalars: (ch: TriCharter, pop: number): Record<string, number> =>
      ({ ...villageSeed(ch, pop), granary: COLONY_STORES }),
  }),
};

/** Civilization keyframes (civilization-emergence.md §3a): every 5 days,
 *  per-city pop/civ/dead + road wear and border heat — a scrubbable
 *  history that actually happened. Pure read; cheap at any scale. */
export const HISTORY = { every: 5, roadAttr: "road", hostilityAttr: "hostility" };

export interface TriBaseOpts {
  /** Grow buildings from accumulated food surplus instead of granting
   *  them at founding (civilization-emergence.md §2a "found small").
   *  Adds a granary fed by the food net's drift, charter-derived caps,
   *  and every-triggered build rules (edge-triggered timers stall when
   *  the granary overshoots twice the cost — the spend must re-arm the
   *  guard, and a rich town's never falls back below it). Opt-in: the
   *  acceptance/stress fixtures keep their pre-granted stock, and a
   *  granary crawling to its clamp would stall their rest tests. */
  construction?: boolean;
  /** Arm CONQUEST (civilization-emergence.md §2d): civ-level strength
   *  from population + ore presence, sieges on hot borders, political
   *  flips for towns / physical absorption for villages, skirmish
   *  attrition on stalemated borders. Opt-in for the same reason as
   *  construction: the acceptance fixture asserts a PERSISTING secession
   *  (hostility 1 at day 120) that a 2×-stronger Aurelia would promptly
   *  reconquer. */
  conquest?: boolean;
  /** GOODS V2 (world-content.md §3d / civilization-emergence.md step 5b):
   *  the widened reagent economy — planks milled from timberland
   *  (charter-anchored sawmills), tools smithed from metal + planks (the
   *  multi-reagent Leontief; smithies anchor to population, the
   *  sanctioned footloose anchor), metal demand AGGREGATED from
   *  households + smithies (fan-in sum), the delivery ALLOCATED
   *  smiths-first (fan-out — priority is data, and it matters:
   *  households-first starves the tool chain once metalware demand
   *  outgrows supply), plank surplus banking in a second stockpile that
   *  part-pays smithies. Pair with `construction` — sawmills and
   *  smithies are grown, never granted. */
  goods2?: boolean;
  /** CLOTHING (step 6d) — the first PURE-CONTENT chain: wool grazed on
   *  the pasture charter, cloth woven and sold over the weaver's
   *  counter (economy-clothing.ts). Requires goods2 + construction
   *  (industry tier). */
  clothing?: boolean;
  /** URBAN WILDLIFE (step 6e) — commensal species as content: rats, a
   *  settlement scalar chasing 2% of the civic population
   *  (economy-wildlife.ts / content/wildlife.economy.json). */
  wildlife?: boolean;
  /** DWARVES (step 6f) — a second sapient people as content, with
   *  their own WILD substrate field pooling on the ore (economy-
   *  dwarves.ts). Pair with a `wildSubstrate`-extended prep. */
  dwarves?: boolean;
  /** EXTERNAL content documents appended after the built-ins — the
   *  developer-mod seam (parse files with economy-json.ts first; the
   *  compiler and the idle-safety validator gate them at boot). */
  extraContent?: EconomyDoc[];
}

/** The compiled economy for a tri world's options — the SAME object
 *  triBase builds its spec from; pass it to `foundTri({economy})` so the
 *  street layer reads the matching registries (TriWorld.economy). */
export function triEconomy(opts: TriBaseOpts = {}): CompiledEconomy {
  return compileEconomy(
    [
      CORE_BASE,
      ...(opts.goods2 ? [CORE_GOODS2] : []),
      ...(opts.clothing ? [CLOTHING] : []),
      ...(opts.wildlife ? [WILDLIFE] : []),
      ...(opts.dwarves ? [DWARVES] : []),
      ...(opts.extraContent ?? []),
    ],
    { construction: opts.construction ?? false },
  );
}

/** The §6 settlement layer: grain/food at the farms, ore/metal at the
 *  mines, three flow nets, roads worn by food+metal traffic, hostility.
 *  The ECONOMY portion (chains, build rules, demand rows) compiles from
 *  content (economy-core.ts) — the equivalence test pins it to the
 *  hand-calibrated fragments; only the STRUCTURAL parts live here. */
export function triBase(opts: TriBaseOpts = {}): Omit<DualSpec, "nodes" | "edges"> {
  const v = (name: string, max: number): { name: string; min: number; max: number; initial: number } =>
    ({ name, min: 0, max, initial: 0 });
  const eco = triEconomy(opts);
  return {
    settlement: {
      id: "tri-settlement",
      entity: {
        id: "city",
        vars: [
          // Structural: the population the coupling writes, the charter
          // attrs tri.ts samples from the substrate, the unrest input.
          v("population", 1_000_000), v("farmland", 2000), v("ore_access", 2000), v("timberland", 2000),
          v("pasture", 2000),
          ...eco.vars,
          v("unrest", 1),
        ],
        rules: eco.rules,
      },
      edge: { vars: [{ name: "road", min: 0.05, max: 1, initial: 0.05 }, { name: "hostility", min: 0, max: 1, initial: 0 }] },
      processes: eco.processes,
      ...(eco.sums.length ? { sums: eco.sums } : {}),
      ...(eco.allocates.length ? { allocates: eco.allocates } : {}),
      // Flow nets + road wear compile from the content too (the food
      // net's construction-gated granary drift is legal because the
      // road can't sever — min 0.05 > 0; see world-validate.ts).
      flownets: eco.flownets,
      roads: eco.roads,
    } as DualSpec["settlement"],
    composition: {
      name: "Tri",
      start_age: 0, use_date: false,
      phase: [{ key: "spread", name: "Spread" }],
      trait: [
        // The SPECIES traits (human first, demand from the commodity
        // rows) — compiled from content like everything else.
        ...eco.speciesTraits,
        { key: "member_x", name: "Aurelia", color: "90,120,220,1", hereditary: true },
        {
          key: "member_y", name: "Free Kragholm", color: "190,90,220,1", hereditary: true,
          // After secession the new civ ABSORBS its sympathizers: the
          // `creed` vector's seek zeroes everyone without sep_idea, so
          // this transmit converts exactly the fellow-travellers left
          // behind by the one-shot flip.
          transmit: [{ vector: ["creed"], apply: ["member_y"], remove: ["member_x"], value: 0.4, sd: 0, phase: "spread", ranged: 0 }],
        },
        {
          key: "sep_idea", name: "Separatism", color: "240,150,40,1",
          transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 0.5, sd: 0, phase: "spread", ranged: 0 }],
        },
      ],
      vector: [
        { key: "v1", name: "Contact" },
        { key: "creed", name: "Creed", seek: [{ not_trait: ["sep_idea"], mult: 0 }] },
      ],
      breakaway: [{
        key: "kragholm_secession", dissent: "sep_idea", from: "member_x", to: "member_y",
        threshold: 0.1, coherence: 0.5,
      }],
    },
    coupling: {
      populationScalar: "population",
      // Civic accounting: only sapient species tier a settlement or arm
      // its strength — a herd of sheep is wealth, not a town.
      civicTraits: eco.civicTraits,
      roadAttr: "road",
      strengthScale: 2,
      traitInputs: [{ trait: "sep_idea", scalar: "unrest" }, ...eco.traitInputs],
      // With fan-in (goods2), the trait demand is ONE TERM of metal_need
      // (the sum adds the smithies' draw) — it lands in its own scalar
      // so the relay owns the aggregate. All compiled from content.
      demandInputs: eco.demandInputs,
      civs: [
        { trait: "member_x", name: "Aurelia", color: "#5a78dc" },
        { trait: "member_y", name: "Free Kragholm", color: "#be5adc" },
      ],
      breakawayHostility: { attr: "hostility", amount: 1 },
      // Per-species Malthusian policies (human first — 0.02/0.01/0.05
      // on the food fill, exactly the numbers this world has always
      // run; declared species bring their own diets and pen caps).
      vitals: eco.vitals,
      // The imperial cycle (§2d): v1 strength = population + ore presence
      // (the user's decided drivers — a mining civ punches above its
      // headcount), sieges take 10 hot days, a fallen town changes flags,
      // a fallen hamlet is emptied, stalemates bleed slowly.
      ...(opts.conquest
        ? {
            conquest: {
              strengthScalars: [
                { scalar: "population", weight: 1 },
                { scalar: "ore_access", weight: 50 },
              ],
              hostilityAttr: "hostility",
              ratio: 2,
              siegeDays: 10,
              casualties: 0.03,
              villagePop: 5_000,
              failedSiegeCooling: 0.25,
              skirmish: 0.001,
            },
          }
        : {}),
    },
  };
}

export const CITIZEN = { startpop: [{ size: 1, apply: ["human", "member_x"] }] };

export const buildings = (ch: TriCharter): Record<string, number> => ({
  farms: Math.max(1, Math.round(ch.farmland / 60)),
  mines: Math.round(ch.ore_access / 40),
  smelters: Math.max(0, Math.ceil(ch.ore_access / 80)),
});

/** Found SMALL (civilization-emergence.md §2a): a village is the harvested
 *  crowd plus SUBSISTENCE farms — just enough to feed the founding crowd
 *  (need = pop × 0.001 food/soul, a farm caps at 5 food), never the
 *  charter-sized stock `buildings()` used to grant. Everything past
 *  subsistence is GROWN INTO through the construction rules. Sizing to
 *  the crowd matters: a fat crowd founding on one farm starves to the
 *  single-farm carrying capacity with the granary pinned at 0 — the
 *  Malthus trap — and construction never starts. Mining camps found with
 *  farms only: they feed themselves first, then dig. */
export const villageSeed = (_ch: TriCharter, pop: number): Record<string, number> => ({
  farms: Math.max(1, Math.ceil((pop * 0.001) / 5)),
});

export function pickBiomes(prep: TriPrep): { valley: FoundingSite; highland: FoundingSite } {
  const byFert = findFoundingSites(prep.grid, { ...FOUNDING, score: [{ field: "fertility", weight: 10 }] });
  const byOre = findFoundingSites(prep.grid, { ...FOUNDING, score: [{ field: "ore", weight: 10 }] });
  const valley = byFert.find(s => prep.grid.fields.height[s.cell] < TREELINE);
  const highland = byOre.find(s => prep.grid.fields.height[s.cell] > TREELINE);
  if (!valley || !highland) throw new Error("pickBiomes: expected candidates in both biomes");
  return { valley, highland };
}

export interface AcceptanceWorld {
  prep: TriPrep;
  tri: TriWorld;
  gridPeople0: number;
  gridOre0: number;
}

/** The §6 acceptance world: Riverton + Kragholm on the ridge-valley map,
 *  full stack (economy, faith-driven demand, vitals, secession, mining). */
export async function buildAcceptanceTri(seed: number): Promise<AcceptanceWorld> {
  const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
  const { valley, highland } = pickBiomes(prep);

  const gridPeople0 = prep.grid.fields.people.reduce((a, b) => a + b, 0);
  const gridOre0 = prep.grid.fields.ore.reduce((a, b) => a + b, 0);

  const tri = await foundTri(prep, {
    base: triBase(),
    economy: triEconomy(),
    cities: [
      { at: valley, key: "riverton", name: "Riverton", site: CITIZEN, scalars: buildings },
      {
        at: highland, key: "kragholm", name: "Kragholm",
        site: { ...CITIZEN, transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 10, sd: 0, phase: "spread" }] },
        scalars: buildings,
      },
    ],
    edges: [["riverton", "kragholm"]],
    peopleScale: 25,
    seed,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    history: HISTORY,
  });

  return { prep, tri, gridPeople0, gridOre0 };
}

const GENESIS_NAMES = ["Riverton", "Kragholm", "Fordham", "Stonewatch", "Millbrook", "Dunmark"];

/**
 * The GENESIS world — the full causal chain, live and city-less at boot:
 * the raw substrate settles on screen (rivers carve, fertility greens,
 * wild crowds pool), and every `every` days the densest crowd founds a
 * city naturally. Mountain foundings (charter more ore than farmland)
 * seed separatism, so the breakaway arc also emerges instead of being
 * scripted. Sculpting the terrain re-routes everything downstream.
 */
export async function buildGenesisTri(seed: number, extraContent?: EconomyDoc[]): Promise<AcceptanceWorld> {
  const eco = { construction: true, goods2: true, clothing: true, wildlife: true, dwarves: true, extraContent };
  const compiled = triEconomy(eco);
  const prep = prepareSubstrate({
    cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE,
    founding: FOUNDING, oreSeed: 7, settle: false, // raw: it lives on screen
    // The substrate grows every declared species' WILD field (step 6f):
    // dwarven crowds pool on the ore ridges beside the human valleys.
    spec: wildSubstrate(worldgenSubstrate, compiled.species),
  });
  const gridPeople0 = 0;
  const gridOre0 = prep.grid.fields.ore.reduce((a, b) => a + b, 0);

  // Founding crowds carry WHO WAS HARVESTED (the demography decides the
  // mix; herds ride on top; only sapient founders take the civ trait).
  const citizens = (mix?: Record<string, number>): Record<string, unknown> => ({
    startpop: mix ? harvestStartpop(compiled, ["member_x"], mix) : citizenStartpop(compiled, ["member_x"]),
  });
  const tri = await foundTri(prep, {
    base: triBase({ ...eco, conquest: true }),
    economy: compiled,
    cities: [],
    edges: [],
    peopleScale: 25,
    seed,
    tiers: TIERS,
    merge: MERGE,
    colonize: COLONIZE,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    history: HISTORY,
    gridStepsPerDay: 8, // the oasis pipeline is deeper (rain→table→springs→rivers)
    autoFound: {
      every: 5,
      maxCities: 6,
      cityFactory: (site, index, ch, mix) => ({
        key: `city${index}`,
        name: GENESIS_NAMES[index] ?? `Town ${index + 1}`,
        scalars: villageSeed,
        site: ch.ore_access > ch.farmland
          ? { ...citizens(mix), transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 10, sd: 0, phase: "spread" }] }
          : citizens(mix),
      }),
    },
  });

  return { prep, tri, gridPeople0, gridOre0 };
}

const TECTONIC_NAMES = [
  "Sutherhold", "Rifton", "Archaven", "Plumeport", "Terranova", "Orogen's Rest", "Vulcayn", "Drift's End",
];

/**
 * The TECTONIC world — same causal chain as genesis, but the LANDSCAPE
 * itself has a history: a plate-tectonic stepper (tectonics.ts) drifts
 * continents, raises mountain belts at convergent boundaries, and emplaces
 * ore by geologic event (arcs, sutures, rifts, hotspots), exposed only
 * where erosion has stripped the cover. The civ layers consume the baked
 * fields through the ordinary prepareSubstrate path — provenance-
 * independence made concrete (timescales.md §1): nothing above the
 * Substrate can tell this world from an authored one.
 */
export async function buildTectonicTri(seed: number, extraContent?: EconomyDoc[]): Promise<AcceptanceWorld & { frames: TectonicFrame[] }> {
  // 144×64 — four times the acceptance map. SIZE is what makes tectonic
  // hydrology work: catchments need room to concentrate, so a bigger world
  // grows real river networks (and with them farm country) at NORMAL rain
  // where a small one needed a wet-climate crutch. The planet-sized goal
  // runs through this dial; the stepper and the settle are both ~linear.
  const { world, frames } = runTectonics({ cols: 144, rows: 64, seed, plates: 5, epochs: 350, keyframeEvery: 25 });
  const authors = bakeAuthors(world);
  const eco = { construction: true, goods2: true, clothing: true, wildlife: true, dwarves: true, extraContent };
  const compiled = triEconomy(eco);
  const prep = prepareSubstrate({
    cols: 144, rows: 64, height: authors.height, ore: authors.ore,
    treeline: TREELINE, founding: FOUNDING,
    spec: wildSubstrate(worldgenSubstrate, compiled.species),
  });
  const gridPeople0 = prep.grid.fields.people.reduce((a, b) => a + b, 0);
  const gridOre0 = prep.grid.fields.ore.reduce((a, b) => a + b, 0);

  const citizens = (mix?: Record<string, number>): Record<string, unknown> => ({
    startpop: mix ? harvestStartpop(compiled, ["member_x"], mix) : citizenStartpop(compiled, ["member_x"]),
  });
  const tri = await foundTri(prep, {
    base: triBase({ ...eco, conquest: true }),
    economy: compiled,
    cities: [],
    edges: [],
    peopleScale: 25,
    seed,
    tiers: TIERS,
    merge: MERGE,
    colonize: COLONIZE,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    history: HISTORY,
    autoFound: {
      every: 5,
      maxCities: 12, // the 144×64 world offers 50+ qualifying sites
      cityFactory: (site, index, ch, mix) => ({
        key: `city${index}`,
        name: TECTONIC_NAMES[index] ?? `Town ${index + 1}`,
        scalars: villageSeed,
        site: ch.ore_access > ch.farmland
          ? { ...citizens(mix), transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 10, sd: 0, phase: "spread" }] }
          : citizens(mix),
      }),
    },
  });

  return { prep, tri, gridPeople0, gridOre0, frames };
}
