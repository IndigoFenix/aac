// CONSTRAINT CEILINGS (cells/ceilings.ts — resources-and-trade.md §④):
// a town's size is the MINIMUM of its constraints, each summed over a
// SUPPLY ZONE the freight arithmetic draws — a land disc stretched along
// river ribbons at the world's asymmetry, direction-aware via the height
// field (cargo floats down to the town, rows up to it). The §② water
// veto becomes a real waystation cap; a city above its ceiling is a
// PARASITE with a printed diagnostic. Every scenario AUTHORS terrain and
// asserts the geometry falls out.

import { describe, it, expect } from "@jest/globals";
import {
  createGrid, worldgenSubstrate,
  supplyZone, constraintCeiling, constraintReachCells, parasiteReading,
  WAYSTATION_HEADS,
  type ConstraintDef,
} from "@shared/world-engine/kernel/cells/index.js";
import { foundCitiesFromSites } from "@shared/world-engine/planet/cities.js";
import { carryReachM, freightOf } from "@shared/world-engine/freight.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

const COLS = 32;
const ROWS = 24;

/** A fresh flat substrate: all land at height 20, nothing growing. */
function plain() {
  const grid = createGrid(worldgenSubstrate, COLS, ROWS);
  grid.fields.height.fill(20);
  grid.fields.fertility.fill(0);
  grid.fields.ore.fill(0);
  grid.fields.river.fill(0);
  grid.fields.plant.fill(0);
  return grid;
}
const at = (x: number, y: number): number => y * COLS + x;

describe("supplyZone — the land disc, stretched along the river", () => {
  it("dry land: the zone is the plain travel disc (Manhattan on a 4-lattice)", () => {
    const grid = plain();
    const z = supplyZone(grid, at(16, 12), { reachCells: 3 });
    expect(z.cost.get(at(16, 12))).toBe(0);
    expect(z.cost.get(at(13, 12))).toBe(3); // straight west, 3 steps
    expect(z.cells).not.toContain(at(12, 12)); // 4 steps: past the rim
    expect(z.cells).not.toContain(at(14, 14)); // Manhattan 4
    expect(z.truncated).toBe(false);
  });

  it("a river stretches the zone ASYMMETRICALLY: upstream country reaches farthest", () => {
    const grid = plain();
    // A river along y=12, falling west → east; the town sits mid-river.
    for (let x = 0; x < COLS; x++) {
      grid.fields.river[at(x, 12)] = 60;
      grid.fields.height[at(x, 12)] = 40 - x; // west is HIGH ground
    }
    const asym = { land: 1 as const, downstream: 4, upstream: 2 };
    const z = supplyZone(grid, at(16, 12), { reachCells: 3, asym });

    // West of town is UPSTREAM: its grain floats DOWN to us — ¼ cost,
    // reach 12 cells. East is downstream: rowed up at ½ — reach 6. Off
    // the river it is all legs — reach 3.
    expect(z.cells).toContain(at(16 - 12, 12));
    expect(z.cells).not.toContain(at(16 - 13, 12));
    expect(z.cells).toContain(at(16 + 6, 12));
    expect(z.cells).not.toContain(at(16 + 7, 12));
    expect(z.cells).toContain(at(16, 12 - 3));
    expect(z.cells).not.toContain(at(16, 12 - 4));
  });

  it("is deterministic — same terrain, same zone, same order", () => {
    const grid = plain();
    for (let x = 0; x < COLS; x++) {
      grid.fields.river[at(x, 12)] = 60;
      grid.fields.height[at(x, 12)] = 40 - x;
    }
    const a = supplyZone(grid, at(16, 12), { reachCells: 3 });
    const b = supplyZone(grid, at(16, 12), { reachCells: 3 });
    expect(a.cells).toEqual(b.cells);
  });

  it("honours the size budget and says so", () => {
    const grid = plain();
    const z = supplyZone(grid, at(16, 12), { reachCells: 10, maxCells: 8 });
    expect(z.cells.length).toBe(8);
    expect(z.truncated).toBe(true);
  });
});

describe("constraintReachCells — the reach is the good's own freight", () => {
  it("fuel's wood disc is smaller than food's — the fuel crisis is geometry", () => {
    const cellM = 1000;
    const food: ConstraintDef = { key: "food", field: "fertility", headsPerUnit: 1 };
    const fuel: ConstraintDef = { key: "fuel", field: "plant", headsPerUnit: 1, good: "wood" };
    const rFood = constraintReachCells(REAL_SCALE, cellM, food, undefined, Infinity);
    const rFuel = constraintReachCells(REAL_SCALE, cellM, fuel, undefined, Infinity);
    expect(rFuel).toBeLessThan(rFood);
    expect(rFood).toBeCloseTo(carryReachM(REAL_SCALE, { valueDensity: 1, transit: "selfConsuming" }) / cellM);
    expect(rFuel).toBeCloseTo(carryReachM(REAL_SCALE, freightOf("wood")) / cellM);
  });
});

describe("constraintCeiling — the minimum of the constraints binds", () => {
  // Pitch the world so the caloric anchor reaches 4 cells.
  const cellM = carryReachM(REAL_SCALE, { valueDensity: 1, transit: "selfConsuming" }) / 4;
  const CONSTRAINTS: ConstraintDef[] = [
    { key: "food", field: "fertility", headsPerUnit: 10 },
    { key: "fuel", field: "plant", headsPerUnit: 10, good: "wood" },
  ];
  const opts = { scale: REAL_SCALE, cellM, constraints: CONSTRAINTS };

  it("rich fields, sparse woods: fuel binds, and the sentence says so", () => {
    const grid = plain();
    grid.fields.fertility.fill(6); // food everywhere
    grid.fields.plant[at(16, 11)] = 2; // one thin stand
    const r = constraintCeiling(grid, at(16, 12), opts);
    expect(r.binding).toBe("fuel");
    expect(r.ceiling).toBe(20); // 2 plant × 10 heads
    expect(r.factors.find(f => f.key === "food")!.heads).toBeGreaterThan(r.ceiling);
    expect(r.sentence).toMatch(/capped at 20 souls by fuel/);
    // The fuel disc is genuinely smaller than the food disc.
    const [food, fuel] = r.factors;
    expect(fuel.reachCells).toBeLessThan(food.reachCells);
    expect(fuel.zoneCells).toBeLessThan(food.zoneCells);
  });

  it("a river town eats from a bigger hinterland than its dry twin", () => {
    const dry = plain();
    dry.fields.fertility.fill(2);
    dry.fields.plant.fill(4);
    const river = plain();
    river.fields.fertility.fill(2);
    river.fields.plant.fill(4);
    for (let x = 0; x < COLS; x++) {
      river.fields.river[at(x, 12)] = 60;
      river.fields.height[at(x, 12)] = 40 - x;
    }
    const a = constraintCeiling(dry, at(16, 12), opts);
    const b = constraintCeiling(river, at(16, 12), opts);
    expect(b.factors[0].zoneCells).toBeGreaterThan(a.factors[0].zoneCells);
    expect(b.ceiling).toBeGreaterThan(a.ceiling);
  });

  it("the §② veto becomes a real cap: dry site = waystation, whatever the land", () => {
    const grid = plain();
    grid.fields.fertility.fill(6);
    grid.fields.plant.fill(6);
    const r = constraintCeiling(grid, at(16, 12), { ...opts, freshWater: false });
    expect(r.ceiling).toBe(WAYSTATION_HEADS);
    expect(r.binding).toBe("water");
    expect(r.sentence).toMatch(/waystation .*no fresh water/);
    // ...but a land poorer than the waystation binds harder than thirst.
    const poor = plain();
    poor.fields.fertility[at(16, 12)] = 1;
    poor.fields.plant.fill(6);
    const p = constraintCeiling(poor, at(16, 12), { ...opts, freshWater: false });
    expect(p.ceiling).toBe(10);
    expect(p.binding).toBe("food");
  });

  it("refuses a ceiling of nothing", () => {
    expect(() => constraintCeiling(plain(), at(16, 12), { ...opts, constraints: [] }))
      .toThrow(/at least one constraint/);
  });
});

describe("parasiteReading — the diagnostic, never an ambush", () => {
  it("above the ceiling: a parasite, legal only while a partner covers", () => {
    const r = { ceiling: 100, binding: "food", factors: [], truncated: false, sentence: "" };
    const p = parasiteReading(250, r);
    expect(p.parasite).toBe(true);
    expect(p.strain).toBeCloseTo(2.5);
    expect(p.sentence).toMatch(/2\.5× beyond its food — a parasite/);
    expect(p.sentence).toMatch(/leaves, not riots/);
    const ok = parasiteReading(80, r);
    expect(ok.parasite).toBe(false);
    expect(ok.sentence).toMatch(/lives within its food/);
  });
});

describe("the planet founding wears its cap (foundCitiesFromSites)", () => {
  const site = (grid: ReturnType<typeof plain>) => ({
    sites: [{ x: 16, y: 12, cell: at(16, 12), density: 300, score: 300 }],
    grid,
    seedBase: 7,
    dirOf: () => [0, 0, 1] as const,
    minFarmland: 0,
  });
  const cellM = carryReachM(REAL_SCALE, { valueDensity: 1, transit: "selfConsuming" }) / 4;

  it("with ceilings: the cap rides the city and clamps the founding crowd", () => {
    const grid = plain();
    grid.fields.fertility.fill(1);
    grid.fields.plant.fill(6);
    // 300 density × 5 = 1500 souls wanted; the land feeds far fewer.
    const [city] = foundCitiesFromSites({
      ...site(grid),
      ceilings: {
        scale: REAL_SCALE, cellM,
        constraints: [{ key: "food", field: "fertility", headsPerUnit: 2 }],
      },
    });
    expect(city.cap).toBeDefined();
    expect(city.cap!.binding).toBe("food");
    expect(city.startPop).toBe(Math.min(1500, city.cap!.ceiling));
    expect(city.startPop).toBeLessThan(1500);
    expect(city.cap!.sentence).toMatch(/capped at .* souls by food/);
  });

  it("without ceilings: the shipped clamp, bit for bit — and no cap field", () => {
    const grid = plain();
    grid.fields.fertility.fill(1);
    const [city] = foundCitiesFromSites(site(grid));
    expect(city.cap).toBeUndefined();
    expect(city.startPop).toBe(1500);
  });
});
