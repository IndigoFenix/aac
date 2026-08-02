// GATE A — settle when you own more than you can carry (bands.ts step ④,
// settlement-emergence.md §5) — and the STORAGE axis it runs on
// (freight.ts keepDays): every gate here is a dimensionless ratio of
// declared quantities, and the negative cases are the point — the rich
// frontier walks away, the fragile staple never fills a store.

import { describe, it, expect } from "@jest/globals";
import {
  KEEP_DAYS_DEFAULT, keepDaysOf, keepHalfLifeGameDays, storedFraction,
  keepThroughLean, freightOf, REAL_PORTER_BULK, type Freight,
} from "@shared/world-engine/freight.js";
import { REAL_SCALE, SEASONAL_SCALE, needFillDays } from "@shared/world-engine/scale.js";
import {
  createGrid, type SystemSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import {
  gatherBand, stepBandDay, bandCarryCapacity, bandPressure, gateASettles,
  boxCapacity, PRESSURE_FLOOR_DEFAULT,
  type Band, type WildSpecies,
} from "@shared/world-engine/kernel/civ/bands.js";

const COLS = 24;
const ROWS = 18;
const at = (x: number, y: number): number => y * COLS + x;

const spec: SystemSpec = {
  id: "gate-a-test",
  name: "Gate A test",
  vars: [{ name: "forage", min: 0, max: 31, initial: 0, init: "flat", int: true }],
  rules: [],
};
const HUMANS: WildSpecies[] = [{ key: "human", field: "forage" }];

const mkBand = (cell: number, size: number, store = 0): Band =>
  ({ cell, mix: { human: size }, size, store, mode: "forager" });

const GRAIN: Freight = { valueDensity: 1, transit: "selfConsuming" };
const MILK: Freight = { valueDensity: 1, transit: "fragile", keepDays: 1 };

describe("keeping — the storage axis is separate from the road", () => {
  it("keepDays defaults by transit class; catalogue rows override per good", () => {
    expect(keepDaysOf({ valueDensity: 1, transit: "durable" })).toBe(Infinity);
    expect(keepDaysOf(GRAIN)).toBe(KEEP_DAYS_DEFAULT.selfConsuming); // ~two harvests
    expect(keepDaysOf({ valueDensity: 1, transit: "fragile" })).toBe(KEEP_DAYS_DEFAULT.fragile);
    // Content rows: milk sours in a day, an apple cellar holds a season.
    expect(keepDaysOf(freightOf("milk"))).toBe(1);
    expect(keepDaysOf(freightOf("apple"))).toBe(90);
    // Grain (the staple anchor) rides the class default — it stores; that
    // it TRAVELS self-consumingly is a different fact about it.
    expect(keepDaysOf(freightOf("food"))).toBe(KEEP_DAYS_DEFAULT.selfConsuming);
  });

  it("spoilage is exponential in the half-life, and the durable pile never rots", () => {
    const half = keepHalfLifeGameDays(REAL_SCALE, MILK);
    expect(storedFraction(REAL_SCALE, MILK, half)).toBeCloseTo(0.5);
    expect(storedFraction(REAL_SCALE, MILK, 2 * half)).toBeCloseTo(0.25);
    expect(storedFraction(REAL_SCALE, { valueDensity: 1, transit: "durable" }, 10_000)).toBe(1);
  });

  it("rot rides the metabolism dial — one factor per process class, microbes included", () => {
    // SEASONAL_SCALE eats 3× per day; its piles rot 3× as fast in game days.
    expect(keepHalfLifeGameDays(SEASONAL_SCALE, GRAIN))
      .toBeCloseTo(keepHalfLifeGameDays(REAL_SCALE, GRAIN) / SEASONAL_SCALE.metabolism);
  });

  it("the granary ratio: grain crosses any winter, milk crosses none", () => {
    for (const scale of [REAL_SCALE, SEASONAL_SCALE]) {
      expect(keepThroughLean(scale, GRAIN)).toBeGreaterThan(1); // civilisation possible
      expect(keepThroughLean(scale, MILK)).toBeLessThan(0.1);   // must refine to keep
    }
  });
});

describe("the band's day — draw, eat, bank, spoil", () => {
  it("a surplus day banks yield − need; a deficit day draws the store", () => {
    const grid = createGrid(spec, COLS, ROWS);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) grid.fields.forage[at(x, y)] = 3;
    const fill = needFillDays(REAL_SCALE, "hunger");
    const band = mkBand(at(6, 6), 10);
    const opts = { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: GRAIN };

    // Box capacity 27, band 10 → 17/fill banked per day.
    const fat = stepBandDay(grid, band, opts);
    expect(fat.need).toBeCloseTo(10 / fill);
    expect(fat.yield).toBeCloseTo(27 / fill);
    expect(fat.banked).toBeCloseTo(17 / fill);
    expect(fat.shortfall).toBe(0);

    // Winter (yieldFactor 0): the store feeds them, then fails.
    const store0 = band.store;
    const lean = stepBandDay(grid, band, { ...opts, yieldFactor: 0 });
    expect(lean.yield).toBe(0);
    expect(band.store).toBeLessThan(store0);
    expect(lean.shortfall).toBe(0);
    band.store = 0;
    const starving = stepBandDay(grid, band, { ...opts, yieldFactor: 0 });
    expect(starving.shortfall).toBeCloseTo(10 / fill);
  });

  it("the pile rots before it feeds — spoilage applies first", () => {
    const grid = createGrid(spec, COLS, ROWS); // barren: yield 0
    const band = mkBand(at(6, 6), 10, 100);
    const fill = needFillDays(REAL_SCALE, "hunger");
    stepBandDay(grid, band, { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: MILK, yieldFactor: 0 });
    // 100 halves to 50 (keep 1 day), THEN the band draws its 10/fill.
    expect(band.store).toBeCloseTo(50 - 10 / fill);
  });

  it("a fragile staple PLATEAUS below carry — pastoralists never settle by store", () => {
    const grid = createGrid(spec, COLS, ROWS);
    // A lush box: capacity 4× the band — huge daily surplus, forever.
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) grid.fields.forage[at(x, y)] = 5;
    const band = mkBand(at(6, 6), 10);
    const carry = bandCarryCapacity(band, MILK);
    for (let d = 0; d < 60; d++) {
      stepBandDay(grid, band, { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: MILK });
    }
    // Geometric plateau: banked/(1 − dailyKeep) ≈ 2 × daily surplus ≪ carry.
    expect(band.store).toBeLessThan(carry);
    // The same land, banking grain instead, blows past carry.
    const grain = mkBand(at(6, 6), 10);
    for (let d = 0; d < 60; d++) {
      stepBandDay(grid, grain, { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: GRAIN });
    }
    expect(grain.store).toBeGreaterThan(bandCarryCapacity(grain, GRAIN));
  });
});

describe("Gate A — store > carry AND nowhere to walk to", () => {
  it("carryCapacity is the backs available × the pack × the staple's worth", () => {
    expect(bandCarryCapacity(mkBand(0, 10), GRAIN)).toBe(10 * REAL_PORTER_BULK);
    expect(bandCarryCapacity(mkBand(0, 10), { valueDensity: 4, transit: "durable" })).toBe(10 * REAL_PORTER_BULK * 4);
  });

  it("pressure: a lone oasis is cornered (→1); a uniform frontier is free (0)", () => {
    const oasis = createGrid(spec, COLS, ROWS);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) oasis.fields.forage[at(x, y)] = 5;
    const cornered = bandPressure(oasis, ["forage"], mkBand(at(6, 6), 10), { radius: 1, searchCells: 8 });
    expect(cornered.best).toBe(0);
    expect(cornered.pressure).toBe(1);

    const frontier = createGrid(spec, COLS, ROWS);
    frontier.fields.forage.fill(5);
    const free = bandPressure(frontier, ["forage"], mkBand(at(6, 6), 10), { radius: 1, searchCells: 8 });
    expect(free.best).toBeGreaterThanOrEqual(free.current);
    expect(free.pressure).toBe(0);
  });

  it("claims corner a band the raw land would have freed", () => {
    const grid = createGrid(spec, COLS, ROWS);
    grid.fields.forage.fill(5); // a frontier…
    const band = mkBand(at(6, 6), 10);
    const claimed = bandPressure(grid, ["forage"], band, {
      radius: 1, searchCells: 8, claimed: () => true, // …entirely spoken for
    });
    expect(claimed.pressure).toBe(1);
  });

  it("the gate needs BOTH halves", () => {
    const band = mkBand(0, 10);
    const carry = bandCarryCapacity(band, GRAIN);
    const cornered = { current: 27, best: 0, pressure: 1 };
    const free = { current: 27, best: 27, pressure: 0 };
    band.store = carry + 1;
    expect(gateASettles(band, GRAIN, cornered)).toBe(true);
    expect(gateASettles(band, GRAIN, free)).toBe(false);   // rich frontier: walk away
    band.store = carry - 1;
    expect(gateASettles(band, GRAIN, cornered)).toBe(false); // nothing worth guarding
    // The floor is a declared dial.
    expect(gateASettles(band, GRAIN, { current: 27, best: 24, pressure: 1 - 24 / 27 },
      { pressureFloor: 0.05 })).toBe(false); // store too small still fails
    band.store = carry + 1;
    expect(gateASettles(band, GRAIN, { current: 27, best: 24, pressure: 1 - 24 / 27 },
      { pressureFloor: 0.05 })).toBe(true);
    expect(PRESSURE_FLOOR_DEFAULT).toBeGreaterThan(0.05);
  });

  it("gather → live → settle: the whole arc conserves people", () => {
    const grid = createGrid(spec, COLS, ROWS);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) grid.fields.forage[at(x, y)] = 5;
    const total0 = boxCapacity(grid, ["forage"], at(6, 6), 1);
    const band = gatherBand(grid, HUMANS, { x: 6, y: 6, cell: at(6, 6), density: total0, score: total0 }, { radius: 1 });
    expect(band.size).toBe(total0);
    // The field regrows in the live world; here it is empty — the band
    // lives on nothing, draws nothing, and its people never change count.
    stepBandDay(grid, band, { scale: REAL_SCALE, radius: 1, fields: ["forage"], freight: GRAIN, yieldFactor: 0 });
    expect(band.size).toBe(total0);
  });
});
