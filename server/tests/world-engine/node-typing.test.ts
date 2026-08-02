// NODE TYPING (node-typing.ts — resources-and-trade.md §②): founding sites
// classified as the economic node their geography makes them, read off
// terrain the substrate already carries. Geography chooses, spec marks —
// each scenario below AUTHORS terrain and asserts the taxonomy falls out,
// plus the fractal law's mechanical test: every reading PRINTS its
// job-description sentence, including the honest null ("no reason to be
// more than the land around it") and the water-first veto.

import { describe, it, expect } from "@jest/globals";
import {
  createGrid, worldgenSubstrate,
  classifyNode, markShadows, rawBulkReachCells, NODE_PRECEDENCE,
  type NodeReading,
} from "@shared/world-engine/kernel/cells/index.js";
import { foundCitiesFromSites } from "@shared/world-engine/planet/cities.js";
import { REAL_SCALE, DOLLHOUSE_SCALE, dailyTravelM } from "@shared/world-engine/scale.js";

const COLS = 32;
const ROWS = 24;

/** A fresh flat substrate, all land at height 20 (no rivers, no life). */
function plain() {
  const grid = createGrid(worldgenSubstrate, COLS, ROWS);
  grid.fields.height.fill(20);
  grid.fields.fertility.fill(0);
  grid.fields.ore.fill(0);
  grid.fields.river.fill(0);
  return grid;
}
const at = (x: number, y: number): number => y * COLS + x;

describe("the taxonomy — terrain in, node out", () => {
  it("mouth: a river entering the sea names the job", () => {
    const grid = plain();
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < 4; x++) grid.fields.height[at(x, y)] = 0; // sea
    for (let x = 4; x < COLS; x++) grid.fields.river[at(x, 10)] = 80; // a major river reaching it
    const n = classifyNode(grid, at(6, 10));
    expect(n.type).toBe("mouth");
    expect(n.freshWater).toBe(true);
    expect(n.sentence).toMatch(/because the river meets the sea/);
  });

  it("anchorage: a pocket bay reads sheltered; an open beachfront does not", () => {
    const bay = plain();
    for (let y = 0; y <= 2; y++) for (let x = 14; x <= 16; x++) bay.fields.height[at(x, y)] = 0;
    bay.fields.fertility[at(15, 6)] = 2; // a spring meadow — fresh water
    const n = classifyNode(bay, at(15, 4));
    expect(n.type).toBe("anchorage");
    expect(n.sentence).toMatch(/shelters hulls/);

    const coast = plain();
    for (let y = 0; y <= 7; y++) for (let x = 0; x < COLS; x++) coast.fields.height[at(x, y)] = 0;
    expect(classifyNode(coast, at(16, 9)).types).not.toContain("anchorage");
  });

  it("chokepoint: the gap in a mountain wall — and dry, it caps at waystation", () => {
    const grid = plain();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 20; x <= 26; x++) {
        if (y !== 11 && y !== 12) grid.fields.height[at(x, y)] = 50; // high ground
      }
    }
    const n = classifyNode(grid, at(23, 11));
    expect(n.types).toContain("chokepoint");
    expect(n.freshWater).toBe(false);
    expect(n.sentence).toMatch(/one passable way through/);
    expect(n.sentence).toMatch(/no fresh water: a waystation/);
  });

  it("junction: a confluence — two watercourses feeding one — inside the box", () => {
    const grid = plain();
    for (let x = 0; x < 12; x++) grid.fields.river[at(x, 18)] = 60; // upper trunk
    for (let x = 12; x < COLS; x++) grid.fields.river[at(x, 18)] = 100; // joined trunk
    for (let y = 12; y < 18; y++) grid.fields.river[at(12, y)] = 30; // the feeder
    const n = classifyNode(grid, at(14, 16));
    expect(n.types).toContain("junction");
    expect(n.sentence).toMatch(/watercourses meet/);
  });

  it("extraction: ore country out-yields its own farmland", () => {
    const grid = plain();
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) grid.fields.ore[at(x, y)] = 10;
    grid.fields.river[at(1, 4)] = 20; // a stream to drink from
    const n = classifyNode(grid, at(4, 4));
    expect(n.type).toBe("extraction");
    expect(n.freshWater).toBe(true);
    expect(n.sentence).toMatch(/the ground yields what the lowlands lack/);
  });

  it("surplus: flat, wet, fertile — the caloric battery", () => {
    const grid = plain();
    for (let y = 2; y <= 8; y++) for (let x = 8; x <= 18; x++) grid.fields.fertility[at(x, y)] = 12;
    grid.fields.river[at(13, 5)] = 20;
    const n = classifyNode(grid, at(13, 5));
    expect(n.type).toBe("surplus");
    expect(n.sentence).toMatch(/grows more here than its farmers can eat/);
  });

  it("rough or dry fertile land is NOT surplus", () => {
    const rough = plain();
    for (let y = 2; y <= 8; y++) for (let x = 8; x <= 18; x++) {
      rough.fields.fertility[at(x, y)] = 12;
      if ((x + y) % 3 === 0) rough.fields.height[at(x, y)] = 30; // broken country
    }
    rough.fields.river[at(13, 5)] = 20;
    expect(classifyNode(rough, at(13, 5)).types).not.toContain("surplus");
  });

  it("ordinary land matches nothing — and says so honestly (Gate C's village-cap seed)", () => {
    const n = classifyNode(plain(), at(16, 12));
    expect(n.type).toBeNull();
    expect(n.types).toEqual([]);
    expect(n.sentence).toMatch(/no reason to be more than the land around it/);
  });

  it("precedence: a fertile river mouth is a MOUTH that also farms", () => {
    const grid = plain();
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < 4; x++) grid.fields.height[at(x, y)] = 0;
    for (let x = 4; x < COLS; x++) grid.fields.river[at(x, 10)] = 80;
    for (let y = 7; y <= 13; y++) for (let x = 4; x <= 10; x++) grid.fields.fertility[at(x, y)] = 12;
    const n = classifyNode(grid, at(6, 10));
    expect(n.types).toContain("surplus");
    expect(n.type).toBe("mouth");
    // The precedence list is total over the taxonomy.
    for (const t of n.types) expect(NODE_PRECEDENCE).toContain(t);
  });
});

describe("the shadow pass — distance is the reason refining exists", () => {
  const surplusReading = (): NodeReading => ({
    type: "surplus", types: ["surplus"], freshWater: true,
    sentence: "exists because flat wet land grows more here than its farmers can eat",
  });

  it("surplus country beyond every market's raw-bulk reach becomes shadow; reached country stays surplus", () => {
    const grid = plain();
    const cities = [
      { cell: at(5, 5), node: surplusReading() },
      { cell: at(8, 5), node: surplusReading() },   // 3 cells from the first
      { cell: at(28, 20), node: surplusReading() }, // far beyond reach of both
    ];
    markShadows(grid, cities, 6);
    expect(cities[0].node.type).toBe("surplus");
    expect(cities[1].node.type).toBe("surplus");
    expect(cities[2].node.type).toBe("shadow");
    expect(cities[2].node.types).toEqual(["shadow", "surplus"]);
    expect(cities[2].node.sentence).toMatch(/cannot reach a market as grain/);
  });

  it("rawBulkReachCells is the Ox Paradox on the lattice — and compression shrinks it with the world", () => {
    // REAL_SCALE: break-even 10 days × a waking day's walk, over 1 km cells.
    const real = rawBulkReachCells(REAL_SCALE, 1000);
    expect(real).toBeCloseTo((10 * dailyTravelM(REAL_SCALE)) / 1000);
    const doll = rawBulkReachCells(DOLLHOUSE_SCALE, 1000);
    expect(doll / real).toBeCloseTo((1 / 360) * ((1 - 0.05) / (1 - 1 / 3)));
  });
});

describe("the SITES pass wears the taxonomy (foundCitiesFromSites)", () => {
  function fertileGridWithTwoSites() {
    const grid = plain();
    for (const [cx, cy] of [[6, 6], [24, 18]] as const) {
      for (let y = cy - 3; y <= cy + 3; y++) {
        for (let x = cx - 3; x <= cx + 3; x++) grid.fields.fertility[at(x, y)] = 12;
      }
      grid.fields.river[at(cx - 1, cy)] = 20;
    }
    return grid;
  }
  const site = (x: number, y: number) => ({ x, y, cell: at(x, y), density: 60, score: 60 });

  it("every committed city carries its node reading, and the shadow pass runs when reach is given", () => {
    const grid = fertileGridWithTwoSites();
    const found = (rawReachCells?: number) =>
      foundCitiesFromSites({
        sites: [site(6, 6), site(24, 18)],
        grid,
        seedBase: 7,
        dirOf: () => [0, 1, 0] as const,
        ...(rawReachCells !== undefined ? { rawReachCells } : {}),
      });

    // Both are watered surplus country; within reach of each other → surplus.
    const near = found(30);
    expect(near.map(c => c.node.type)).toEqual(["surplus", "surplus"]);
    for (const c of near) expect(c.node.sentence).toMatch(/because/);

    // Reach shorter than their separation → each is beyond the other's
    // market: both read shadow (their grain must refine or stay village).
    const far = found(10);
    expect(far.map(c => c.node.type)).toEqual(["shadow", "shadow"]);

    // No reach declared → the shadow pass is skipped, typing still attached.
    const untyped = found();
    expect(untyped.map(c => c.node.type)).toEqual(["surplus", "surplus"]);
  });
});
