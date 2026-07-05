/**
 * Demo scenarios for the routes lab. Each carries the engine JSON plus a
 * lab-only `layout` (site key → normalized [x, y] in 0..1) for map
 * placement — PopuSim Sites have no coordinates, so position is purely a
 * rendering concern, exactly as the unified-world-model doc intends.
 *
 * A scenario with `dual` boots BOTH layers (step 2): a cell-systems
 * settlement world coupled to the PopuSim composition world at the day
 * boundary (see dual.ts).
 */

import type { DualSpec } from "./dual";
import { buildAcceptanceTri, buildGenesisTri, type AcceptanceWorld } from "./tri-worlds";

export interface LabScenario {
  key: string;
  name: string;
  desc: string;
  layout: Record<string, [number, number]>;
  json?: Record<string, unknown>;
  dual?: DualSpec;
  /** TRI scenarios boot all three layers; city positions come from the
   *  substrate (tile coords), not from `layout`. */
  tri?: (seed: number) => Promise<AcceptanceWorld>;
}

/** A ranged influence transmit hung off `convinced`. */
function convincedTrait(ranged: number) {
  return {
    key: "convinced", name: "Convinced", color: "230,60,60,1",
    transmit: [{ vector: ["v1"], apply: ["convinced"], value: 0.6, sd: 0, phase: "spread", ranged }],
  };
}

const twoCity: LabScenario = {
  key: "two-city",
  name: "Two cities — ranged spread",
  desc:
    "Convinced people seeded in City A spread locally, and a fraction of each day's " +
    "vectors travels the route to City B — arriving a day later. Turn the route " +
    "off (delete it in the editor) and B stays clean.",
  layout: { city_a: [0.25, 0.5], city_b: [0.75, 0.5] },
  json: {
    name: "Two cities",
    start_age: 0, use_date: false,
    phase: [{ key: "spread", name: "Spread" }],
    trait: [convincedTrait(0.4)],
    vector: [{ key: "v1", name: "Contact" }],
    site: [
      { key: "city_a", name: "City A", pop: 200_000,
        transmit: [{ vector: ["v1"], apply: ["convinced"], value: 30, sd: 0, phase: "spread" }] },
      { key: "city_b", name: "City B", pop: 200_000 },
    ],
    route: [{ key: "road", sites: ["city_a", "city_b"], strength: 1, migration: 0 }],
  },
};

const chain: LabScenario = {
  key: "chain",
  name: "Chain — hop delay",
  desc:
    "Four towns in a line. Spread seeded at the west end reaches each town a " +
    "day after its neighbour — you can watch the wave travel east one hop at a time.",
  layout: { t1: [0.12, 0.5], t2: [0.37, 0.5], t3: [0.62, 0.5], t4: [0.87, 0.5] },
  json: {
    name: "Chain",
    start_age: 0, use_date: false,
    phase: [{ key: "spread", name: "Spread" }],
    trait: [convincedTrait(0.5)],
    vector: [{ key: "v1", name: "Contact" }],
    site: [
      { key: "t1", name: "Town 1", pop: 100_000,
        transmit: [{ vector: ["v1"], apply: ["convinced"], value: 30, sd: 0, phase: "spread" }] },
      { key: "t2", name: "Town 2", pop: 100_000 },
      { key: "t3", name: "Town 3", pop: 100_000 },
      { key: "t4", name: "Town 4", pop: 100_000 },
    ],
    route: [
      { key: "r12", sites: ["t1", "t2"], strength: 1, migration: 0 },
      { key: "r23", sites: ["t2", "t3"], strength: 1, migration: 0 },
      { key: "r34", sites: ["t3", "t4"], strength: 1, migration: 0 },
    ],
  },
};

const migration: LabScenario = {
  key: "migration",
  name: "Migration — population diffusion",
  desc:
    "No ranged spread. The overcrowded capital diffuses population outward along " +
    "its roads until sizes even out; the total never changes. Convinced people " +
    "migrate too, carrying the trait with them (uniform by syndrome).",
  layout: { cap: [0.5, 0.5], n: [0.5, 0.14], s: [0.5, 0.86], e: [0.85, 0.5], w: [0.15, 0.5] },
  json: {
    name: "Migration",
    start_age: 0, use_date: false,
    phase: [{ key: "spread", name: "Spread" }],
    trait: [convincedTrait(0)],
    vector: [{ key: "v1", name: "Contact" }],
    site: [
      { key: "cap", name: "Capital", pop: 400_000,
        transmit: [{ vector: ["v1"], apply: ["convinced"], value: 20, sd: 0, phase: "spread" }] },
      { key: "n", name: "North", pop: 40_000 },
      { key: "s", name: "South", pop: 40_000 },
      { key: "e", name: "East", pop: 40_000 },
      { key: "w", name: "West", pop: 40_000 },
    ],
    route: [
      { key: "cn", sites: ["cap", "n"], strength: 0, migration: 0.06 },
      { key: "cs", sites: ["cap", "s"], strength: 0, migration: 0.06 },
      { key: "ce", sites: ["cap", "e"], strength: 0, migration: 0.06 },
      { key: "cw", sites: ["cap", "w"], strength: 0, migration: 0.06 },
    ],
  },
};

const idea: LabScenario = {
  key: "idea-network",
  name: "Idea network — ranged + migration",
  desc:
    "A five-city network where a new idea (treated exactly like a contagion) " +
    "spreads along trade routes while people also migrate between hubs. This is " +
    "the civilization-scale use of the same machinery: swap 'convinced' for an " +
    "ideology or a technology.",
  layout: { hub: [0.5, 0.5], a: [0.2, 0.22], b: [0.82, 0.28], c: [0.8, 0.78], d: [0.2, 0.8] },
  json: {
    name: "Idea network",
    start_age: 0, use_date: false,
    phase: [{ key: "spread", name: "Spread" }],
    trait: [{
      key: "convinced", name: "Convinced", color: "90,150,240,1",
      transmit: [{ vector: ["word"], apply: ["convinced"], value: 0.5, sd: 0, phase: "spread", ranged: 0.35 }],
    }],
    vector: [{ key: "word", name: "Word of mouth" }],
    site: [
      { key: "hub", name: "Hub", pop: 150_000 },
      { key: "a", name: "North Market", pop: 120_000,
        transmit: [{ vector: ["word"], apply: ["convinced"], value: 25, sd: 0, phase: "spread" }] },
      { key: "b", name: "East Port", pop: 120_000 },
      { key: "c", name: "South Fields", pop: 120_000 },
      { key: "d", name: "West Gate", pop: 120_000 },
    ],
    route: [
      { key: "ha", sites: ["hub", "a"], strength: 1, migration: 0.02 },
      { key: "hb", sites: ["hub", "b"], strength: 1, migration: 0.02 },
      { key: "hc", sites: ["hub", "c"], strength: 1, migration: 0.02 },
      { key: "hd", sites: ["hub", "d"], strength: 1, migration: 0.02 },
      { key: "ab", sites: ["a", "b"], strength: 0.5, migration: 0 },
    ],
  },
};

/**
 * DUAL-LAYER demo (steps 2+4): a steady-state flow-net economy under the
 * idea dynamics. The capital's production ships to every town's demand as
 * a SOLVED flow field (§4c) — caravans on the map are a render of that
 * field, not agents. Caravan traffic wears roads in (desire paths), roads
 * raise route strength, and the idea seeded in the capital follows the
 * trade. Supply matches demand, so once roads and migration settle the
 * world is AT REST while goods visibly keep moving — "stabilise in
 * motion". People also diffuse out of the crowded capital, carrying the
 * idea; 'convinced' prevalence feeds back into each town's `unrest`.
 */
const dualTrade: LabScenario = {
  key: "dual-trade",
  name: "DUAL — caravans, roads, ideas",
  desc:
    "Two engines over one graph, plus the §4c steady-state economy and §7 breakaway. " +
    "The capital's production ships to every town's demand as a SOLVED flow field — " +
    "the marching gold dashes ARE that field (no agents). Caravan traffic wears in " +
    "roads; route strength mirrors them, so the capital's idea crosses fastest where " +
    "trade runs thickest. Meanwhile separatism brews in Farhold (select the sep_idea " +
    "trait to watch it): when the faction is big AND territorially coherent, Farhold " +
    "SECEDES — its ring turns purple, the border turns hostile, and the war wears " +
    "the border road down until tempers cool and the caravans return. Supply = " +
    "demand, so once everything settles the world is AT REST while goods still move.",
  layout: { cap: [0.32, 0.5], north: [0.5, 0.14], east: [0.68, 0.62], far: [0.9, 0.78] },
  dual: {
    nodes: [
      {
        key: "cap", name: "Capital", pop: 150_000,
        scalars: { production: 60, consumption: 15 },
        site: {
          startpop: [{ size: 1, apply: ["member_x"] }],
          transmit: [{ vector: ["v1"], apply: ["convinced"], value: 30, sd: 0, phase: "spread" }],
        },
      },
      { key: "north", name: "Northton", pop: 50_000, scalars: { consumption: 15 }, site: { startpop: [{ size: 1, apply: ["member_x"] }] } },
      { key: "east", name: "Eastmarch", pop: 50_000, scalars: { consumption: 15 }, site: { startpop: [{ size: 1, apply: ["member_x"] }] } },
      {
        key: "far", name: "Farhold", pop: 50_000, scalars: { consumption: 15 },
        site: {
          startpop: [{ size: 1, apply: ["member_x"] }],
          // Separatism brews locally (its transmit is ranged 0 — it never
          // crosses routes, which is exactly why it stays coherent).
          transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 15, sd: 0, phase: "spread" }],
        },
      },
    ],
    edges: [
      { a: "cap", b: "north", key: "cn" },
      { a: "cap", b: "east", key: "ce" },
      { a: "east", b: "far", key: "ef" },
    ],
    settlement: {
      id: "settlement",
      entity: {
        id: "town",
        vars: [
          { name: "population", min: 0, max: 1_000_000, initial: 0 },
          { name: "goods", min: 0, max: 100, initial: 0 },
          { name: "production", min: 0, max: 100, initial: 0 },
          { name: "consumption", min: 0, max: 100, initial: 0 },
          { name: "unrest", min: 0, max: 1, initial: 0 },
        ],
        rules: [],
      },
      // Roads floor at a dirt track (0.05): the base conductance that lets
      // the first caravans through, so traffic can wear the road in.
      edge: {
        vars: [
          { name: "road", min: 0.05, max: 1, initial: 0.05 },
          { name: "hostility", min: 0, max: 1, initial: 0 },
        ],
        rules: [
          // War on a border wears the road down while tempers slowly cool;
          // when hostility drops the caravans wear it back in.
          {
            id: "border-war",
            when: { cmp: ">", left: { scalar: "hostility" }, right: { const: 0.5 } },
            trigger: { every: true },
            effects: [
              { add: { scalar: "road", amount: -0.02 } },
              { add: { scalar: "hostility", amount: -0.004 } },
            ],
          },
        ],
      },
      exchanges: [{ scalar: "population", rate: 0.02 }],
      flownets: [{ id: "trade", source: "production", demand: "consumption", by: "road", drift: "goods" }],
      roads: [{ attr: "road", use: "trade", rate: 0.002, decay: 0.004 }],
    },
    composition: {
      name: "Dual trade",
      start_age: 0, use_date: false,
      phase: [{ key: "spread", name: "Spread" }],
      trait: [
        {
          key: "convinced", name: "Convinced", color: "230,60,60,1",
          transmit: [{ vector: ["v1"], apply: ["convinced"], value: 0.55, sd: 0, phase: "spread", ranged: 0.4 }],
        },
        { key: "member_x", name: "Aurelia", color: "90,120,220,1" },
        { key: "member_y", name: "Farhold Free State", color: "190,90,220,1" },
        {
          key: "sep_idea", name: "Separatism", color: "240,150,40,1",
          transmit: [{ vector: ["v1"], apply: ["sep_idea"], value: 0.8, sd: 0, phase: "spread", ranged: 0 }],
        },
      ],
      vector: [{ key: "v1", name: "Contact" }],
      breakaway: [{
        key: "farhold_secession",
        dissent: "sep_idea", from: "member_x", to: "member_y",
        threshold: 0.12, coherence: 0.5,
      }],
    },
    coupling: {
      populationScalar: "population",
      roadAttr: "road",
      strengthScale: 2,
      traitInputs: [{ trait: "convinced", scalar: "unrest" }],
      civs: [
        { trait: "member_x", name: "Aurelia", color: "#5a78dc" },
        { trait: "member_y", name: "Farhold Free State", color: "#be5adc" },
      ],
      breakawayHostility: { attr: "hostility", amount: 1 },
    },
  },
};

/**
 * TRI-LAYER world (world-content.md §6): the whole stack on one map. The
 * substrate paints behind the graph — ridge, valley, rivers, ore veins,
 * wild camps; Riverton and Kragholm were FOUNDED from harvested crowds.
 */
const triWorld: LabScenario = {
  key: "tri-world",
  name: "TRI — the layered world",
  desc:
    "All three layers over one map. The terrain painted behind the cities is the live " +
    "substrate: computed rivers feed the green valley, ore veins (purple) speckle the " +
    "ridge, and the warm-tinted tiles are wild people pooling where the land is good — " +
    "Riverton and Kragholm were FOUNDED by harvesting those crowds. Above it: farms " +
    "feed everyone, the mountain ships metal down the pass (gold caravans = the solved " +
    "flow field), populations live and die on the food supply (watch total pop climb), " +
    "Kragholm's separatists secede around day 25 (ring turns purple, the border arms), " +
    "and the mines visibly draw the mountain down — ore in the header ticks away. " +
    "Select the sep_idea trait to watch the faction cohere before it fires.",
  layout: {}, // positions come from the substrate tiles
  tri: (seed: number) => buildAcceptanceTri(seed),
};

/**
 * GENESIS (the sandbox, merged in): the world boots EMPTY — raw terrain,
 * no rivers, no green, no people, no cities. Everything after that is the
 * causal chain running live, and the player's hand is the first cause.
 */
const triGenesis: LabScenario = {
  key: "tri-genesis",
  name: "TRI — genesis (sculpt the cradle)",
  desc:
    "The full chain, from nothing, while you watch: the raw terrain settles — drainage " +
    "carves rivers, rivers write fertility, fertility greens and draws wild people " +
    "(warm tiles) — and every few days the densest crowd FOUNDS A CITY where it " +
    "stands. Valley towns farm; mountain foundings breed separatists and secede. " +
    "Pick ⛰️ Raise or ⛏️ Dig and drag on the map: your motion reshapes the land, the " +
    "rivers re-route instantly, fertility follows, crowds move — and sooner or later " +
    "a city rises in the valley you made. Press Play to let the days run.",
  layout: {},
  tri: (seed: number) => buildGenesisTri(seed),
};

export const SCENARIOS: LabScenario[] = [triGenesis, triWorld, dualTrade, twoCity, chain, migration, idea];

/** Fresh deep clone — the World mutates `data` in place during start. */
export function cloneScenarioJson(s: LabScenario): Record<string, unknown> {
  if (!s.json) throw new Error(`scenario ${s.key} has no engine JSON (dual scenario?)`);
  return JSON.parse(JSON.stringify(s.json)) as Record<string, unknown>;
}
