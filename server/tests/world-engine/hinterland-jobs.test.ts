// GATE C + GATE B (settlement-emergence.md §5, step ⑥):
//   • civ/jobs.ts — a settlement's HINTERLAND JOBS derived from what the
//     arc already shipped (the §② node taxonomy, the road graph's hub
//     degree, §③'s refinery licenses), and the VILLAGE CAP: no job ⇒
//     size caps at the village line, whatever the land could feed. Size
//     licensed by FUNCTION, never by an authored tier.
//   • economy.ts industryAfterSurplus — the compiler's tier gates rewired
//     from size to SURPLUS: the diet fill must be whole before anyone
//     eats without producing food. A big hungry village stops spawning
//     smithies.

import { describe, it, expect } from "@jest/globals";
import {
  hinterlandJobs, cityLicense,
} from "@shared/world-engine/kernel/civ/jobs.js";
import {
  createGrid, worldgenSubstrate, classifyNode,
  createWorld, stepWorld,
  type NodeReading, type WorldSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import {
  compileEconomy, type BuildingDef, type EconomyDoc,
} from "@shared/world-engine/kernel/modules/economy/economy.js";
import { foundCitiesFromSites } from "@shared/world-engine/planet/cities.js";
import { carryReachM } from "@shared/world-engine/freight.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

const reading = (types: NodeReading["types"]): NodeReading => ({
  type: types[0] ?? null, types, freshWater: true, sentence: "",
});

describe("hinterlandJobs — the sources the arc already shipped", () => {
  it("terrain jobs: the exchange taxa qualify; surplus is a fat village, not a city", () => {
    expect(hinterlandJobs({ node: reading(["junction"]) }).map(j => j.kind)).toEqual(["junction"]);
    expect(hinterlandJobs({ node: reading(["mouth", "surplus"]) }).map(j => j.kind)).toEqual(["mouth"]);
    expect(hinterlandJobs({ node: reading(["surplus"]) })).toEqual([]);
    expect(hinterlandJobs({ node: reading([]) })).toEqual([]);
    expect(hinterlandJobs({})).toEqual([]);
  });

  it("the hub: enough living spokes make a store of last resort", () => {
    expect(hinterlandJobs({ roadDegree: 3 }).map(j => j.kind)).toEqual(["hub"]);
    expect(hinterlandJobs({ roadDegree: 2 })).toEqual([]);
    expect(hinterlandJobs({ roadDegree: 2, hubDegree: 2 }).map(j => j.kind)).toEqual(["hub"]);
    const [hub] = hinterlandJobs({ roadDegree: 4 });
    expect(hub.sentence).toMatch(/4 roads meet at its granary/);
    expect(hub.sentence).toMatch(/store of last resort/);
  });

  it("the refinery: a LICENSED refinery is a job; an unlicensed one is nothing", () => {
    const r = { building: "weaver", from: "wool", into: "cloth" };
    expect(hinterlandJobs({ refineries: [{ ...r, licensed: true }] }).map(j => j.kind)).toEqual(["refinery"]);
    expect(hinterlandJobs({ refineries: [{ ...r, licensed: false }] })).toEqual([]);
    const [job] = hinterlandJobs({ refineries: [{ ...r, licensed: true }] });
    expect(job.sentence).toMatch(/wool cannot reach a market raw/);
  });

  it("cityLicense: the village cap, and the printed why", () => {
    const lic = cityLicense(hinterlandJobs({ node: reading(["chokepoint"]), roadDegree: 3 }), 2000);
    expect(lic.licensed).toBe(true);
    expect(lic.cap).toBe(Infinity);
    expect(lic.jobs.length).toBe(2);
    expect(lic.sentence).toMatch(/holds a job for its hinterland/);
    expect(lic.sentence).toMatch(/\(and 1 more\)/);

    const village = cityLicense([], 2000);
    expect(village.licensed).toBe(false);
    expect(village.cap).toBe(2000);
    expect(village.sentence).toMatch(/has no job for its hinterland — a village \(cap 2000 souls\)/);
  });
});

// ------------------------------------------------------------------- Gate B

const building = (key: string, extra: Partial<BuildingDef>): BuildingDef => ({
  key,
  countScalar: `${key}s`,
  cap: { by: "population", rate: 0.01 },
  processes: [],
  construction: { tier: "base", costs: [{ stockpile: "granary", amount: 25 }] },
  leansToward: null,
  mapCap: 1,
  district: null,
  style: { color: "#888", w: 10, h: 10 },
  vignette: { w: 4, h: 4 },
  glyph: "🏭",
  title: key,
  info: [],
  ...extra,
});

const DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    { key: "food", scalarMax: 200, transport: {} },
    { key: "tools", scalarMax: 100, transport: {} },
  ],
  buildings: [
    building("farm", {
      processes: [{ id: "grow", input: "population", output: "food_out", efficiency: 0.02, capacityRate: 4 }],
    }),
    building("smithy", {
      construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 25 }] },
      processes: [{ id: "smith", input: "population", output: "tools_out", efficiency: 0.001, capacityRate: 1 }],
    }),
  ],
};

describe("industryAfterSurplus — the tier gate reads the fill, not the size", () => {
  it("writes the surplus condition onto industry rules only", () => {
    const eco = compileEconomy([DOC], { construction: true, industryAfterSurplus: true });
    const gates = (id: string) =>
      (eco.rules.find(r => r.id === id)!.when as { all: Array<{ left?: { scalar?: string } }> }).all
        .filter(c => c.left?.scalar === "food_got");
    expect(gates("build-smithy").length).toBe(1);
    expect(gates("build-farm").length).toBe(0);
    const gate = gates("build-smithy")[0] as { cmp: string; right: { scalar: string; scale?: number } };
    expect(gate.cmp).toBe(">=");
    expect(gate.right).toEqual({ scalar: "food_need" });
  });

  it("a declared floor scales the demand side; absent = byte-stable rules", () => {
    const floored = compileEconomy([DOC], { construction: true, industryAfterSurplus: { floor: 1.25 } });
    const gate = (floored.rules.find(r => r.id === "build-smithy")!.when as {
      all: Array<{ left?: { scalar?: string }; right?: { scalar?: string; scale?: number } }>;
    }).all.find(c => c.left?.scalar === "food_got")!;
    expect(gate.right).toEqual({ scalar: "food_need", scale: 1.25 });

    const off = compileEconomy([DOC], { construction: true });
    const shipped = compileEconomy([DOC], { construction: true, industryAfterSurplus: undefined });
    expect(shipped.rules).toEqual(off.rules);
    expect(JSON.stringify(off.rules)).not.toMatch(/food_got/);
  });

  it("refuses a diet that isn't declared, or that doesn't ship", () => {
    expect(() => compileEconomy([DOC], { construction: true, industryAfterSurplus: { good: "ale" } }))
      .toThrow(/diet "ale" is not a declared commodity/);
    const dry: EconomyDoc = {
      ...DOC,
      commodities: [{ key: "food", scalarMax: 200 }, { key: "tools", scalarMax: 100, transport: {} }],
    };
    expect(() => compileEconomy([dry], { construction: true, industryAfterSurplus: true }))
      .toThrow(/does not ship .* transfer channel/);
  });

  it("a big HUNGRY village stops spawning smithies — and a fed one resumes", () => {
    const eco = compileEconomy([DOC], { construction: true, industryAfterSurplus: true });
    const spec: WorldSpec = {
      id: "surplus-lab",
      entity: {
        id: "town",
        vars: [{ name: "population", min: 0, max: 1_000_000, initial: 0 }, ...eco.vars],
        rules: eco.rules,
      },
      processes: eco.processes,
      sums: eco.sums,
      allocates: eco.allocates,
      flownets: eco.flownets,
    };
    const w = createWorld(spec, 2, []);
    for (const i of [0, 1]) {
      w.scalars.population[i] = 500;
      w.scalars.granary[i] = 400;
    }
    // Both towns want food; town 0's want is modest, town 1's is famine-
    // sized (its farms can never cover it). Nothing else writes _need.
    w.scalars.food_need[0] = 5;
    w.scalars.food_need[1] = 150;

    for (let d = 0; d < 10; d++) stepWorld(w); // base reaches cap, then industry may fire
    // Base tier builds in BOTH (subsistence is never gated)…
    expect(w.scalars.farms[0]).toBeGreaterThan(0);
    expect(w.scalars.farms[1]).toBeGreaterThan(0);
    // …but only the town whose fill is whole specializes.
    expect(w.scalars.food_got[0]).toBeGreaterThanOrEqual(w.scalars.food_need[0]);
    expect(w.scalars.food_got[1]).toBeLessThan(w.scalars.food_need[1]);
    expect(w.scalars.smithys[0]).toBeGreaterThan(0);
    expect(w.scalars.smithys[1]).toBe(0);

    // The famine ends (the want falls back to what the farms cover):
    // specialization resumes — the gate reads the fill, not history.
    w.scalars.food_need[1] = 5;
    stepWorld(w); // the net satisfies at the new demand…
    stepWorld(w); // …and the rule reads it
    expect(w.scalars.smithys[1]).toBeGreaterThan(0);
  });
});

// ------------------------------------------------- the planet founding

describe("the planet founding wears its license (foundCitiesFromSites)", () => {
  const COLS = 32;
  const ROWS = 24;
  const at = (x: number, y: number): number => y * COLS + x;
  const plain = () => {
    const grid = createGrid(worldgenSubstrate, COLS, ROWS);
    grid.fields.height.fill(20);
    grid.fields.fertility.fill(0);
    grid.fields.ore.fill(0);
    grid.fields.river.fill(0);
    grid.fields.plant.fill(0);
    return grid;
  };
  const cellM = carryReachM(REAL_SCALE, { valueDensity: 1, transit: "selfConsuming" }) / 4;
  const ceilings = {
    scale: REAL_SCALE, cellM,
    constraints: [{ key: "food", field: "fertility", headsPerUnit: 10 }],
    jobs: { villageHeads: 100 },
  };
  const found = (grid: ReturnType<typeof plain>, cell: number) => foundCitiesFromSites({
    sites: [{ x: cell % COLS, y: (cell / COLS) | 0, cell, density: 300, score: 300 }],
    grid, seedBase: 7, dirOf: () => [0, 0, 1] as const, minFarmland: 0, ceilings,
  })[0];

  it("fertile but jobless: the crowd founds at the village line", () => {
    const grid = plain();
    grid.fields.fertility.fill(6); // a caloric battery — reason to farm, not to city
    const city = found(grid, at(16, 12));
    expect(city.node.types.includes("surplus")).toBe(true);
    expect(city.license).toBeDefined();
    expect(city.license!.licensed).toBe(false);
    expect(city.cap!.ceiling).toBeGreaterThan(100); // the land could feed far more…
    expect(city.startPop).toBe(100); // …but function, not fertility, licenses size
    expect(city.license!.sentence).toMatch(/a village \(cap 100 souls\)/);
  });

  it("the same land at a river mouth is licensed — geography hands out the job", () => {
    const grid = plain();
    grid.fields.fertility.fill(6);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < 4; x++) grid.fields.height[at(x, y)] = 0; // sea
    for (let x = 4; x < COLS; x++) grid.fields.river[at(x, 12)] = 80; // a river reaching it
    const city = found(grid, at(6, 12));
    expect(city.license!.licensed).toBe(true);
    expect(city.license!.jobs.map(j => j.kind)).toContain("mouth");
    expect(city.startPop).toBeGreaterThan(100);
    expect(city.license!.sentence).toMatch(/holds a job for its hinterland/);
  });
});
