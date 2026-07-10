/**
 * THE EQUIVALENCE GATE (step 6d): the compiled economy reproduces the
 * hand-calibrated fragments byte-for-byte.
 *
 * The expected values below are a FROZEN COPY of triBase's hand-written
 * economy as it stood when the content seam was built (step 5b shipped,
 * calibration lessons folded in). They are deliberately NOT derived from
 * the live triBase — after the rewire triBase itself compiles from
 * CORE_BASE/CORE_GOODS2, and a live comparison would be a tautology.
 * If a compiler change breaks this test, the compiler changed the
 * economy's behavior; if a deliberate recalibration changes the economy,
 * update BOTH the content doc and this frozen reference, consciously.
 */

import { describe, expect, it } from "vitest";
import { compileEconomy } from "../economy";
import { CORE_BASE, CORE_GOODS2 } from "../economy-core";
import { FOOD_GOOD, TOOLS_GOOD } from "../food";

/* ---------- the frozen hand-written fragments (pre-rewire triBase) ---------- */

const v = (name: string, max: number, int = false) =>
  ({ name, min: 0, max, initial: 0, ...(int ? { int: true } : {}) });

const legacyBuild = (id: string, building: string, cap: string, threshold: number, cost: number) => ({
  id,
  when: {
    all: [
      { cmp: ">=" as const, left: { scalar: "granary" }, right: { const: threshold } },
      { cmp: "<" as const, left: { scalar: building }, right: { scalar: cap } },
    ],
  },
  trigger: { every: true as const },
  effects: [
    { add: { scalar: building, amount: 1 } },
    { add: { scalar: "granary", amount: -cost } },
  ],
});

const legacyBaseDone = [
  { cmp: ">=" as const, left: { scalar: "farms" }, right: { scalar: "farm_cap" } },
  { cmp: ">=" as const, left: { scalar: "mines" }, right: { scalar: "mine_cap" } },
  { cmp: ">=" as const, left: { scalar: "smelters" }, right: { scalar: "smelter_cap" } },
];

function legacyEconomy(construction: boolean, goods2: boolean) {
  return {
    vars: [
      v("farms", 40, true), v("mines", 40, true), v("smelters", 40, true),
      v("grain_out", 200), v("food_out", 200), v("food_need", 200), v("food_got", 200),
      v("ore_out", 100), v("ore_need", 100), v("ore_got", 100),
      v("metal_out", 100), v("metal_need", 100), v("metal_got", 100),
      ...(construction ? [v("granary", 500), v("farm_cap", 40), v("mine_cap", 40), v("smelter_cap", 40)] : []),
      ...(goods2
        ? [
            v("sawmills", 40, true), v("smithies", 40, true),
            v("planks_out", 200), v("planks_got", 200), v("plank_store", 500),
            v("tools_out", 100), v("tools_need", 100), v("tools_got", 100),
            v("metal_want_pop", 100), v("smith_metal_draw", 100), v("smith_plank_draw", 200),
            v("metal_for_pop", 100), v("metal_for_smiths", 100),
          ]
        : []),
      ...(goods2 && construction ? [v("sawmill_cap", 40), v("smithy_cap", 40)] : []),
    ],
    rules: [
      ...(construction
        ? [
            legacyBuild("build-farm", "farms", "farm_cap", 20, 20),
            legacyBuild("build-mine", "mines", "mine_cap", 50, 30),
            legacyBuild("build-smelter", "smelters", "smelter_cap", 90, 40),
          ]
        : []),
      ...(construction && goods2
        ? [
            {
              id: "build-sawmill",
              when: {
                all: [
                  ...legacyBaseDone,
                  { cmp: ">=" as const, left: { scalar: "granary" }, right: { const: 25 } },
                  { cmp: "<" as const, left: { scalar: "sawmills" }, right: { scalar: "sawmill_cap" } },
                ],
              },
              trigger: { every: true as const },
              effects: [
                { add: { scalar: "sawmills", amount: 1 } },
                { add: { scalar: "granary", amount: -25 } },
              ],
            },
            {
              id: "build-smithy",
              when: {
                all: [
                  ...legacyBaseDone,
                  { cmp: ">=" as const, left: { scalar: "granary" }, right: { const: 55 } },
                  { cmp: ">=" as const, left: { scalar: "plank_store" }, right: { const: 10 } },
                  { cmp: "<" as const, left: { scalar: "smithies" }, right: { scalar: "smithy_cap" } },
                ],
              },
              trigger: { every: true as const },
              effects: [
                { add: { scalar: "smithies", amount: 1 } },
                { add: { scalar: "granary", amount: -30 } },
                { add: { scalar: "plank_store", amount: -10 } },
              ],
            },
          ]
        : []),
    ],
    processes: [
      { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityBy: "farms", capacityRate: 5 },
      { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      { id: "mine", input: "ore_access", output: "ore_out", efficiency: 0.02, capacityBy: "mines", capacityRate: 4 },
      { id: "furnace-draw", input: "smelters", output: "ore_need", efficiency: 8 },
      { id: "smelt", input: "ore_got", output: "metal_out", efficiency: 0.9, capacityBy: "smelters", capacityRate: 8 },
      ...(construction
        ? [
            { id: "farm-cap", input: "farmland", output: "farm_cap", efficiency: 1 / 60 },
            { id: "mine-cap", input: "ore_access", output: "mine_cap", efficiency: 1 / 40 },
            { id: "smelter-cap", input: "ore_access", output: "smelter_cap", efficiency: 1 / 80 },
          ]
        : []),
      ...(goods2
        ? [
            { id: "mill-planks", input: "timberland", output: "planks_out", efficiency: 0.02, capacityBy: "sawmills", capacityRate: 4 },
            { id: "smith-metal-draw", input: "smithies", output: "smith_metal_draw", efficiency: 2 },
            { id: "smith-plank-draw", input: "smithies", output: "smith_plank_draw", efficiency: 3 },
            {
              id: "tools",
              inputs: [
                { scalar: "metal_for_smiths", efficiency: 1.5 },
                { scalar: "planks_got", efficiency: 1 },
              ],
              output: "tools_out", capacityBy: "smithies", capacityRate: 4,
            },
          ]
        : []),
      ...(goods2 && construction
        ? [
            { id: "sawmill-cap", input: "timberland", output: "sawmill_cap", efficiency: 1 / 50 },
            { id: "smithy-cap", input: "population", output: "smithy_cap", efficiency: 0.0002 },
          ]
        : []),
    ],
    sums: goods2
      ? [{ id: "metal-want", output: "metal_need", terms: [{ scalar: "metal_want_pop" }, { scalar: "smith_metal_draw" }] }]
      : [],
    allocates: goods2
      ? [{
          id: "metal-split", source: "metal_got",
          shares: [
            { output: "metal_for_smiths", demand: "smith_metal_draw" },
            { output: "metal_for_pop", demand: "metal_want_pop" },
          ],
        }]
      : [],
    flownets: [
      { id: "food", source: "food_out", demand: "food_need", by: "road", satisfied: "food_got", ...(construction ? { drift: "granary" } : {}) },
      { id: "oreflow", source: "ore_out", demand: "ore_need", by: "road", satisfied: "ore_got" },
      { id: "metal", source: "metal_out", demand: "metal_need", by: "road", satisfied: "metal_got" },
      ...(goods2
        ? [
            { id: "planks", source: "planks_out", demand: "smith_plank_draw", by: "road", satisfied: "planks_got", drift: "plank_store" },
            { id: "tools", source: "tools_out", demand: "tools_need", by: "road", satisfied: "tools_got" },
          ]
        : []),
    ],
    roads: [
      { attr: "road", use: "food", rate: 0.002, decay: 0.001 },
      { attr: "road", use: "metal", rate: 0.002, decay: 0.001 },
    ],
    demandInputs: goods2
      ? [
          { resource: "food", scalar: "food_need" },
          { resource: "metal", scalar: "metal_want_pop" },
          { resource: "tools", scalar: "tools_need" },
        ]
      : [
          { resource: "food", scalar: "food_need" },
          { resource: "metal", scalar: "metal_need" },
        ],
    traitDemands: [
      { resource: "food", value: 0.001 },
      { resource: "metal", value: 0.0002 },
      ...(goods2 ? [{ resource: "tools", value: 0.0002 }] : []),
    ],
  };
}

/* --------------------------------- the gate --------------------------------- */

const byName = (vars: Array<{ name: string }>): Map<string, unknown> =>
  new Map(vars.map(x => [x.name, x]));

const cases: Array<{ label: string; construction: boolean; goods2: boolean }> = [
  { label: "acceptance shape (no construction, no goods2)", construction: false, goods2: false },
  { label: "construction only", construction: true, goods2: false },
  { label: "construction + goods2 (genesis/tectonic shape)", construction: true, goods2: true },
];

describe("compiled economy == the frozen hand-written fragments", () => {
  for (const c of cases) {
    it(c.label, () => {
      const docs = c.goods2 ? [CORE_BASE, CORE_GOODS2] : [CORE_BASE];
      const eco = compileEconomy(docs, { construction: c.construction });
      const legacy = legacyEconomy(c.construction, c.goods2);

      // Vars are name-keyed at runtime — compare as maps (same set,
      // same min/max/int), not as ordered arrays.
      expect(byName(eco.vars)).toEqual(byName(legacy.vars));
      // Everything order-sensitive compares exactly: processes chain
      // same-step in array order, allocate shares are priority, build
      // rules stagger cumulatively in declaration order.
      expect(eco.rules).toEqual(legacy.rules);
      expect(eco.processes).toEqual(legacy.processes);
      expect(eco.sums).toEqual(legacy.sums);
      expect(eco.allocates).toEqual(legacy.allocates);
      expect(eco.flownets).toEqual(legacy.flownets);
      expect(eco.roads).toEqual(legacy.roads);
      expect(eco.demandInputs).toEqual(legacy.demandInputs);
      expect(eco.traitDemands).toEqual(legacy.traitDemands);
    });
  }

  it("street goods compile to the exact shipped descriptors (byte-stable towns)", () => {
    const eco = compileEconomy([CORE_BASE, CORE_GOODS2], { construction: true });
    expect(eco.goods.map(g => g.key)).toEqual(["food", "tools"]);
    // Hash draws and source ordering ride these — they must not move.
    expect(eco.goods[0]).toEqual(FOOD_GOOD);
    expect(eco.goods[1]).toEqual(TOOLS_GOOD);
    expect(eco.goods.map(g => g.slot)).toEqual([0, 1]);
  });

  it("the capacity-anchor law: an unanchored building is rejected at compile", () => {
    expect(() =>
      compileEconomy([{
        buildings: [{
          key: "shed", countScalar: "sheds", cap: { by: "population", rate: 0 },
          processes: [], construction: { tier: "base", costs: [{ stockpile: "granary", amount: 10 }] },
          leansToward: null, mapCap: 1, district: null,
          style: { color: "#000", w: 5, h: 5 }, vignette: { w: 4, h: 4 },
          glyph: "?", title: "?", info: [],
        }],
      }]),
    ).toThrow(/capacity anchor/);
  });
});
