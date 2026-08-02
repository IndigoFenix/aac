// BANDS AS ENTITIES (kernel/civ/bands.ts — settlement-emergence.md §3):
// the substrate's `forage` field is the LAND's capacity; the people are
// band ENTITIES, gathered off the field, settled into foundings, and
// dispersible back — the reversible arc, conserving at every move. Step ③
// is behaviour-preserving: gather+settle IS the founding harvest tri.ts
// always ran (same passes, same largest-remainder, same scan order).

import { describe, it, expect } from "@jest/globals";
import {
  createGrid, worldgenSubstrate, findFoundingSites, totalField,
  type SystemSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import {
  gatherBand, settleBand, disperseBand, type WildSpecies,
} from "@shared/world-engine/kernel/civ/bands.js";

const COLS = 16;
const ROWS = 12;
const at = (x: number, y: number): number => y * COLS + x;

/** A bare two-species test substrate: no dynamics, just the wild fields
 *  (rules never step in these tests — bands are day-boundary surgery). */
const twoWilds: SystemSpec = {
  id: "band-test",
  name: "Band test",
  vars: [
    { name: "forage", min: 0, max: 31, initial: 0, init: "flat", int: true },
    { name: "gob", min: 0, max: 31, initial: 0, init: "flat", int: true },
  ],
  rules: [],
};

const HUMANS: WildSpecies[] = [{ key: "human", field: "forage" }];
const BOTH: WildSpecies[] = [{ key: "human", field: "forage" }, { key: "gob", field: "gob" }];
const site = (x: number, y: number) => ({ x, y, cell: at(x, y), density: 0, score: 0 });

describe("the rename — the field is the land, and founding still reads it", () => {
  it("worldgenSubstrate carries `forage` (capacity), and no `people` var remains", () => {
    const names = (worldgenSubstrate.vars ?? []).map(v => v.name);
    expect(names).toContain("forage");
    expect(names).not.toContain("people");
    // The recovery rule tracks the lure — the Sugarscape landscape, renamed.
    const rule = worldgenSubstrate.rules.find(r => r.id === "multiply")!;
    expect(rule.effects).toEqual([
      { toward: { scalar: "forage", target: { scalar: "lure", scale: 2 }, rate: 0.25 } },
    ]);
  });

  it("findFoundingSites reads `forage` by default", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    for (let y = 4; y <= 8; y++) for (let x = 4; x <= 8; x++) grid.fields.forage[at(x, y)] = 4;
    const sites = findFoundingSites(grid, { threshold: 30, radius: 2, minSpacing: 5 });
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0].density).toBeGreaterThanOrEqual(30);
  });
});

describe("gather — the crowd leaves the grid as a band", () => {
  it("conserves: the band holds exactly what left the field, residue stays wild", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) grid.fields.forage[at(x, y)] = 3;
    grid.fields.forage[at(12, 2)] = 9; // outside the box — stays wild
    const before = totalField(grid, "forage");

    const band = gatherBand(grid, HUMANS, site(6, 6), { radius: 2 });
    expect(band.size).toBe(27);
    expect(band.mix).toEqual({ human: 27 });
    expect(band.store).toBe(0);
    expect(band.mode).toBe("forager");
    expect(totalField(grid, "forage")).toBe(before - band.size);
    expect(grid.fields.forage[at(12, 2)]).toBe(9);
  });

  it("FOUND SMALL: the cap apportions across species by largest remainder, exactly", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    // humans 20, gobs 10 in the box — a 2:1 mix.
    for (let x = 5; x <= 8; x++) grid.fields.forage[at(x, 6)] = 5;
    for (let x = 5; x <= 6; x++) grid.fields.gob[at(x, 7)] = 5;

    const band = gatherBand(grid, BOTH, site(6, 6), { radius: 2, maxHarvest: 9 });
    // 9 × 20/30 = 6 humans; 9 × 10/30 = 3 gobs — Σ = cap, proportions kept.
    expect(band.size).toBe(9);
    expect(band.mix).toEqual({ human: 6, gob: 3 });
    // The residue stayed on the land, per species.
    expect(totalField(grid, "forage")).toBe(20 - 6);
    expect(totalField(grid, "gob")).toBe(10 - 3);
  });

  it("an empty box gathers a size-0 band and takes nothing", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    const band = gatherBand(grid, BOTH, site(2, 2), { radius: 2 });
    expect(band.size).toBe(0);
    expect(band.mix).toEqual({});
  });
});

describe("settle — an ordinary state change on an existing entity", () => {
  it("the founding crowd is the band, mix and all", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    for (let x = 5; x <= 8; x++) grid.fields.forage[at(x, 6)] = 5;
    grid.fields.gob[at(6, 7)] = 4;
    const band = gatherBand(grid, BOTH, site(6, 6), { radius: 2 });
    const founded = settleBand(band);
    expect(founded.total).toBe(24);
    expect(founded.mix).toEqual({ human: 20, gob: 4 });
  });
});

describe("disperse — the exact inverse (Gate D's mechanism, pinned early)", () => {
  it("gather → disperse round-trips the field totals; the band empties", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) {
      grid.fields.forage[at(x, y)] = 3;
      grid.fields.gob[at(x, y)] = 2;
    }
    const forage0 = totalField(grid, "forage");
    const gob0 = totalField(grid, "gob");

    const band = gatherBand(grid, BOTH, site(6, 6), { radius: 2 });
    expect(band.size).toBe(forage0 + gob0);
    const unplaced = disperseBand(grid, BOTH, band, 2);
    expect(unplaced).toBe(0);
    expect(band.size).toBe(0);
    expect(totalField(grid, "forage")).toBe(forage0);
    expect(totalField(grid, "gob")).toBe(gob0);
  });

  it("honors tile headroom: a full valley reports the overflow and keeps it in the band", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    // Fill the whole disperse box to one-below-max: radius-1 box = 9 tiles,
    // 1 headroom each.
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) grid.fields.forage[at(x, y)] = 30;
    const band = { cell: at(6, 6), mix: { human: 15 }, size: 15, store: 0, mode: "forager" };
    const unplaced = disperseBand(grid, HUMANS, band, 1);
    expect(unplaced).toBe(15 - 9); // 9 seats in the valley
    expect(band.size).toBe(6);
    expect(band.mix.human).toBe(6);
    for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) {
      expect(grid.fields.forage[at(x, y)]).toBe(31); // clamped exactly at max
    }
  });
});
