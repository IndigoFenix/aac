/**
 * Shared tri-world definitions — the §6 acceptance world and the
 * many-settlements stress world, used by BOTH the vitest suites and the
 * lab (one source of truth, so what the tests prove is what the lab
 * shows).
 */

import { findFoundingSites, type FoundingSite } from "@cells/index";
import { prepareSubstrate, foundTri, type TriCharter, type TriPrep, type TriWorld } from "./tri";
import { runTectonics, bakeAuthors, type TectonicFrame } from "./tectonics";
import type { DualSpec } from "./dual";

export const TREELINE = 40;
// Threshold sized for the TIGHT fertility band (grass hugs streams now,
// so qualifying crowds are river-bank bands, not broad valley sprawls).
export const FOUNDING = { threshold: 100, radius: 2, minSpacing: 6 };

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

/** The §6 settlement layer: grain/food at the farms, ore/metal at the
 *  mines, three flow nets, roads worn by food+metal traffic, hostility. */
export function triBase(): Omit<DualSpec, "nodes" | "edges"> {
  const v = (name: string, max: number, int = false): { name: string; min: number; max: number; initial: number; int?: boolean } =>
    ({ name, min: 0, max, initial: 0, ...(int ? { int: true } : {}) });
  return {
    settlement: {
      id: "tri-settlement",
      entity: {
        id: "city",
        vars: [
          v("population", 1_000_000), v("farmland", 2000), v("ore_access", 2000), v("timberland", 2000),
          v("farms", 40, true), v("mines", 40, true), v("smelters", 40, true),
          v("grain_out", 200), v("food_out", 200), v("food_need", 200), v("food_got", 200),
          v("ore_out", 100), v("ore_need", 100), v("ore_got", 100),
          v("metal_out", 100), v("metal_need", 100), v("metal_got", 100),
          v("unrest", 1),
        ],
        rules: [],
      },
      edge: { vars: [{ name: "road", min: 0.05, max: 1, initial: 0.05 }, { name: "hostility", min: 0, max: 1, initial: 0 }] },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityBy: "farms", capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
        { id: "mine", input: "ore_access", output: "ore_out", efficiency: 0.02, capacityBy: "mines", capacityRate: 4 },
        { id: "furnace-draw", input: "smelters", output: "ore_need", efficiency: 8 },
        { id: "smelt", input: "ore_got", output: "metal_out", efficiency: 0.9, capacityBy: "smelters", capacityRate: 8 },
      ],
      flownets: [
        { id: "food", source: "food_out", demand: "food_need", by: "road", satisfied: "food_got" },
        { id: "oreflow", source: "ore_out", demand: "ore_need", by: "road", satisfied: "ore_got" },
        { id: "metal", source: "metal_out", demand: "metal_need", by: "road", satisfied: "metal_got" },
      ],
      roads: [
        { attr: "road", use: "food", rate: 0.002, decay: 0.001 },
        { attr: "road", use: "metal", rate: 0.002, decay: 0.001 },
      ],
    } as DualSpec["settlement"],
    composition: {
      name: "Tri",
      start_age: 0, use_date: false,
      phase: [{ key: "spread", name: "Spread" }],
      trait: [
        {
          key: "human", name: "Human", color: "150,150,150,1", hereditary: true,
          demand: [{ resource: "food", value: 0.001 }, { resource: "metal", value: 0.0002 }],
        },
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
      roadAttr: "road",
      strengthScale: 2,
      traitInputs: [{ trait: "sep_idea", scalar: "unrest" }],
      demandInputs: [
        { resource: "food", scalar: "food_need" },
        { resource: "metal", scalar: "metal_need" },
      ],
      civs: [
        { trait: "member_x", name: "Aurelia", color: "#5a78dc" },
        { trait: "member_y", name: "Free Kragholm", color: "#be5adc" },
      ],
      breakawayHostility: { attr: "hostility", amount: 1 },
      vitals: { birthRate: 0.02, deathRate: 0.01, starvation: 0.05, foodNeed: "food_need", foodGot: "food_got" },
    },
  };
}

export const CITIZEN = { startpop: [{ size: 1, apply: ["human", "member_x"] }] };

export const buildings = (ch: TriCharter): Record<string, number> => ({
  farms: Math.max(1, Math.round(ch.farmland / 60)),
  mines: Math.round(ch.ore_access / 40),
  smelters: Math.max(0, Math.ceil(ch.ore_access / 80)),
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
export async function buildGenesisTri(seed: number): Promise<AcceptanceWorld> {
  const prep = prepareSubstrate({
    cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE,
    founding: FOUNDING, oreSeed: 7, settle: false, // raw: it lives on screen
  });
  const gridPeople0 = 0;
  const gridOre0 = prep.grid.fields.ore.reduce((a, b) => a + b, 0);

  const tri = await foundTri(prep, {
    base: triBase(),
    cities: [],
    edges: [],
    peopleScale: 25,
    seed,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    gridStepsPerDay: 8, // the oasis pipeline is deeper (rain→table→springs→rivers)
    autoFound: {
      every: 5,
      maxCities: 6,
      cityFactory: (site, index, ch) => ({
        key: `city${index}`,
        name: GENESIS_NAMES[index] ?? `Town ${index + 1}`,
        scalars: buildings,
        site: ch.ore_access > ch.farmland
          ? { ...CITIZEN, transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 10, sd: 0, phase: "spread" }] }
          : CITIZEN,
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
export async function buildTectonicTri(seed: number): Promise<AcceptanceWorld & { frames: TectonicFrame[] }> {
  // 144×64 — four times the acceptance map. SIZE is what makes tectonic
  // hydrology work: catchments need room to concentrate, so a bigger world
  // grows real river networks (and with them farm country) at NORMAL rain
  // where a small one needed a wet-climate crutch. The planet-sized goal
  // runs through this dial; the stepper and the settle are both ~linear.
  const { world, frames } = runTectonics({ cols: 144, rows: 64, seed, plates: 5, epochs: 350, keyframeEvery: 25 });
  const authors = bakeAuthors(world);
  const prep = prepareSubstrate({
    cols: 144, rows: 64, height: authors.height, ore: authors.ore,
    treeline: TREELINE, founding: FOUNDING,
  });
  const gridPeople0 = prep.grid.fields.people.reduce((a, b) => a + b, 0);
  const gridOre0 = prep.grid.fields.ore.reduce((a, b) => a + b, 0);

  const tri = await foundTri(prep, {
    base: triBase(),
    cities: [],
    edges: [],
    peopleScale: 25,
    seed,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    autoFound: {
      every: 5,
      maxCities: 12, // the 144×64 world offers 50+ qualifying sites
      cityFactory: (site, index, ch) => ({
        key: `city${index}`,
        name: TECTONIC_NAMES[index] ?? `Town ${index + 1}`,
        scalars: buildings,
        site: ch.ore_access > ch.farmland
          ? { ...CITIZEN, transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 10, sd: 0, phase: "spread" }] }
          : CITIZEN,
      }),
    },
  });

  return { prep, tri, gridPeople0, gridOre0, frames };
}
