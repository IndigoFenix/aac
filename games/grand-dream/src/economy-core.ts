/**
 * economy-core.ts — the STANDARD ECONOMY as content (step 6d).
 *
 * The exact chains the tri worlds have always run, expressed in the
 * EconomyDoc format instead of hand-written spec fragments: CORE_BASE is
 * the subsistence world (food at the farms, ore at the mines, metal at
 * the smelters), CORE_GOODS2 the step-5b reagent economy (planks from
 * timber, tools from metal + planks, smiths-first allocation). The
 * equivalence test (economy-equivalence.test.ts) pins the compiled
 * output to the hand-calibrated fragments byte-for-byte — every number
 * here is a MEASURED calibration, not a guess; see the cost notes in
 * tri-worlds.ts (the fed-transient law).
 *
 * This is also the template for new content: a chain is a few
 * commodities and buildings in this shape, and clothing
 * (economy-clothing.ts) is the first chain that was born here rather
 * than in code.
 */

import { compileEconomy, type CompiledEconomy, type EconomyDoc } from "./economy";

/** Construction costs, in granary units (accumulated food surplus) —
 *  each must sit inside the fed-transient integral (tri-worlds.ts). */
export const FARM_COST = 20;
export const MINE_COST = 30;
export const SMELTER_COST = 40;
export const SAWMILL_COST = 25;
export const SMITHY_COST = 30;
/** A smithy also costs banked planks (the multi-stockpile case: each
 *  cost inside its own resource's fed-transient integral). */
export const SMITHY_PLANKS = 10;

/** The subsistence economy: grain/food, ore, metal — three flow nets,
 *  roads worn by food+metal traffic. */
export const CORE_BASE: EconomyDoc = {
  stockpiles: [
    { key: "granary", max: 500, name: "Granary", construction: true },
  ],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true, wearsRoad: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations",
        producers: ["farm", "hall"], market: true, stockColor: "#e0b25c",
        boxLabel: "Pantry", errandName: "shopping",
      },
    },
    { key: "ore", scalarMax: 100, transport: { id: "oreflow" } },
    { key: "metal", scalarMax: 100, perPersonDaily: 0.0002, transport: { wearsRoad: true } },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: FARM_COST }] },
      sells: ["food"],
      leansToward: "fertility", mapCap: 6, district: "farm",
      style: { color: "#c9a94e", w: 18, h: 12 }, vignette: { w: 6, h: 5 },
      glyph: "🌾", title: "🌾 Farmstead",
      info: [
        "{farms} farms working {farmland:0} farmland.",
        "Grain: {per:grain_out/farms}.",
        "Sells at the gate to its district.",
      ],
    },
    {
      key: "mine", countScalar: "mines", cap: { by: "ore_access", rate: 1 / 40 },
      processes: [
        { id: "mine", input: "ore_access", output: "ore_out", efficiency: 0.02, capacityRate: 4 },
      ],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: MINE_COST }] },
      leansToward: "ore", mapCap: 6, district: "mining",
      style: { color: "#70707a", w: 16, h: 11 }, vignette: { w: 6, h: 5 },
      glyph: "⛏", title: "⛏ Mine",
      info: [
        "{mines} mines on {ore_access:0} chartered ore.",
        "Ore: {per:ore_out/mines}.",
      ],
    },
    {
      key: "smelter", countScalar: "smelters", cap: { by: "ore_access", rate: 1 / 80 },
      processes: [
        { id: "furnace-draw", input: "smelters", output: "ore_need", efficiency: 8 },
        { id: "smelt", input: "ore_got", output: "metal_out", efficiency: 0.9, capacityRate: 8 },
      ],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: SMELTER_COST }] },
      leansToward: "ore", mapCap: 4, district: "mining",
      style: { color: "#a05038", w: 16, h: 11 }, vignette: { w: 6, h: 5 },
      glyph: "🔥", title: "🔥 Smelter",
      info: [
        "{smelters} smelters.",
        "Metal: {per:metal_out/smelters}.",
      ],
    },
  ],
};

/** The step-5b reagent economy. NOTE the metal OVERRIDE: with industry
 *  also drawing metal, the population's want lands in its own scalar
 *  (fan-in builds metal_need) and the delivery splits SMITHS-FIRST —
 *  priority is policy, and households-first kills the tool chain. */
export const CORE_GOODS2: EconomyDoc = {
  stockpiles: [
    { key: "plank_store", max: 500, name: "Plank store" },
  ],
  commodities: [
    {
      key: "metal", scalarMax: 100, perPersonDaily: 0.0002,
      popScalar: "metal_want_pop",
      transport: { wearsRoad: true },
      needSum: ["metal_want_pop", "smith_metal_draw"],
      allocate: [
        { share: "metal_for_smiths", demand: "smith_metal_draw" },
        { share: "metal_for_pop", demand: "metal_want_pop" },
      ],
    },
    {
      key: "planks", scalarMax: 200,
      transport: { demand: "smith_plank_draw", drift: "plank_store" },
    },
    {
      key: "tools", scalarMax: 100, perPersonDaily: 0.0002,
      transport: {},
      street: {
        capDays: 9, shopSec: 26, cartRations: 40, unit: "tool-days",
        producers: ["smithy"], stockColor: "#9aa4b2",
        boxLabel: "Wares chest", errandName: "wares",
      },
    },
  ],
  buildings: [
    {
      key: "sawmill", countScalar: "sawmills", cap: { by: "timberland", rate: 1 / 50 },
      processes: [
        { id: "mill-planks", input: "timberland", output: "planks_out", efficiency: 0.02, capacityRate: 4 },
      ],
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: SAWMILL_COST }] },
      leansToward: "plant", mapCap: 4, district: "craft",
      style: { color: "#7d6b38", w: 18, h: 12 }, vignette: { w: 6, h: 5 },
      glyph: "🪚", title: "🪚 Sawmill",
      info: [
        "{sawmills} sawmills on {timberland:0} chartered timber.",
        "Planks: {per:planks_out/sawmills}.",
      ],
    },
    {
      key: "smithy", countScalar: "smithies", cap: { by: "population", rate: 0.0002 },
      processes: [
        { id: "smith-metal-draw", input: "smithies", output: "smith_metal_draw", efficiency: 2 },
        { id: "smith-plank-draw", input: "smithies", output: "smith_plank_draw", efficiency: 3 },
        {
          id: "tools",
          inputs: [
            { scalar: "metal_for_smiths", efficiency: 1.5 },
            { scalar: "planks_got", efficiency: 1 },
          ],
          output: "tools_out", capacityRate: 4,
        },
      ],
      vars: [
        { name: "smith_metal_draw", max: 100 },
        { name: "smith_plank_draw", max: 200 },
      ],
      construction: {
        tier: "industry",
        costs: [
          { stockpile: "granary", amount: SMITHY_COST },
          { stockpile: "plank_store", amount: SMITHY_PLANKS },
        ],
      },
      sells: ["tools"], shelved: true,
      leansToward: null, mapCap: 3, district: "craft",
      style: { color: "#524c48", w: 14, h: 10 }, vignette: { w: 5, h: 4 },
      glyph: "🔨", title: "🔨 Smithy",
      info: [
        "{smithies} smithies.",
        "Tools: {per:tools_out/smithies}.",
        "Draws {smith_metal_draw:1} metal + {smith_plank_draw:1} planks/day.",
      ],
    },
  ],
};

/** The street/presentation FALLBACK registry: worlds that don't attach
 *  their own compiled economy (older fixtures, test stubs) read this —
 *  the full standard registry, so towns render exactly as before the
 *  content seam existed. Undeclared scalars read 0, so a base world
 *  simply places no sawmills off it. */
export const DEFAULT_ECONOMY: CompiledEconomy =
  compileEconomy([CORE_BASE, CORE_GOODS2], { construction: true });
