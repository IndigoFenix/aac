/**
 * Civilization-tier travel (kernel/civ/travel.ts): traversal costs on the
 * cell substrate, least-cost routing, the betweenness/traffic field that
 * puts towns at NATURAL CHOKEPOINTS (passes, fords, isthmuses), and road
 * commitment as data (bridge/tunnel classification + the cost feedback).
 * Grids here are hand-authored (fields written directly, never stepped) —
 * every travel function is a pure read of the fields.
 */
import { describe, it, expect } from "vitest";
import {
  createGrid, findFoundingSites, type CellGrid,
  worldgenSubstrate,
} from "@shared/world-engine/kernel/cells/index";
import {
  edgeCost, leastCostRoute, travelTraffic, hubRoutes, commitRoads,
  type TravelOpts,
} from "@shared/world-engine/kernel/civ/travel";

/** A hand-authored grid: height from the author, rivers/people zeroed
 *  (createGrid seeds a bowl + its flow network — wipe it). */
function makeGrid(cols: number, rows: number, heightAt: (x: number, y: number) => number): CellGrid {
  const grid = createGrid(worldgenSubstrate, cols, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      grid.fields.height[i] = heightAt(x, y);
      grid.fields.river[i] = 0;
      grid.fields.people[i] = 0;
    }
  }
  return grid;
}

// 10 m per height unit over 100 m cells: a 40-unit cliff is grade 4 (way
// over the 0.78 wall grade); a 2-unit rise is grade 0.2 (a mild slope).
const OPTS: TravelOpts = { metresPerUnit: 10, metresPerCell: 100 };

describe("edgeCost — the cost model", () => {
  const cols = 9, rows = 5;
  const grid = makeGrid(cols, rows, () => 20);
  const at = (x: number, y: number) => y * cols + x;

  it("flat neighbors cost the base 1", () => {
    expect(edgeCost(grid, at(2, 2), at(3, 2), OPTS)).toBe(1);
  });

  it("slope multiplies (symmetric in |Δheight|)", () => {
    grid.fields.height[at(4, 2)] = 24; // grade 0.4 → 1 + 25·0.16 = 5
    expect(edgeCost(grid, at(3, 2), at(4, 2), OPTS)).toBeCloseTo(5, 10);
    expect(edgeCost(grid, at(4, 2), at(3, 2), OPTS)).toBeCloseTo(5, 10);
    grid.fields.height[at(4, 2)] = 20;
  });

  it("entering a watercourse costs the ford multiple; leaving does not", () => {
    grid.fields.river[at(5, 2)] = 100;
    expect(edgeCost(grid, at(4, 2), at(5, 2), OPTS)).toBeCloseTo(6, 10);
    expect(edgeCost(grid, at(5, 2), at(4, 2), OPTS)).toBeCloseTo(1, 10);
    grid.fields.river[at(5, 2)] = 0;
  });

  it("open sea is Infinity; the shallow shelf is a ford", () => {
    grid.fields.height[at(6, 2)] = 0; // deep basin
    grid.fields.height[at(7, 2)] = 2; // shelf, below the sea line
    expect(edgeCost(grid, at(5, 2), at(6, 2), OPTS)).toBe(Infinity);
    expect(edgeCost(grid, at(6, 2), at(5, 2), OPTS)).toBe(Infinity);
    expect(edgeCost(grid, at(8, 2), at(7, 2), OPTS)).toBeGreaterThan(1); // ford + slope, finite
    expect(Number.isFinite(edgeCost(grid, at(8, 2), at(7, 2), OPTS))).toBe(true);
    grid.fields.height[at(6, 2)] = 20;
    grid.fields.height[at(7, 2)] = 20;
  });

  it("a committed road divides the cost", () => {
    grid.fields.road = new Float64Array(grid.topo.n);
    grid.fields.road[at(2, 2)] = 1;
    grid.fields.road[at(3, 2)] = 1;
    expect(edgeCost(grid, at(2, 2), at(3, 2), OPTS)).toBeCloseTo(0.35, 10);
    // Stepping ONTO a road end from wilderness is undiscounted.
    expect(edgeCost(grid, at(1, 2), at(2, 2), OPTS)).toBe(1);
    delete grid.fields.road;
  });
});

describe("vegetation & mounts — the biosphere's travel rules", () => {
  const cols = 9, rows = 5;
  const at = (x: number, y: number) => y * cols + x;

  it("off-road forest drags: ×3 at full abundance, linear below", () => {
    const grid = makeGrid(cols, rows, () => 20);
    grid.fields.eco_tree = new Float64Array(grid.topo.n);
    grid.fields.eco_tree[at(3, 2)] = 100;
    grid.fields.eco_tree[at(4, 2)] = 50;
    expect(edgeCost(grid, at(2, 2), at(3, 2), OPTS)).toBeCloseTo(3, 10);
    expect(edgeCost(grid, at(3, 2), at(4, 2), OPTS)).toBeCloseTo(2, 10);
    // Leaving the wood onto open ground is the base step.
    expect(edgeCost(grid, at(3, 2), at(3, 1), OPTS)).toBeCloseTo(1, 10);
  });

  it("a mount pays on open grass, and forest negates it", () => {
    const grid = makeGrid(cols, rows, () => 20);
    grid.fields.eco_grass = new Float64Array(grid.topo.n).fill(100);
    const mounted: TravelOpts = { ...OPTS, mount: 1 };
    expect(edgeCost(grid, at(2, 2), at(3, 2), mounted)).toBeCloseTo(0.5, 10);
    // Unmounted, the same sward is just the base step.
    expect(edgeCost(grid, at(2, 2), at(3, 2), OPTS)).toBeCloseTo(1, 10);
    // Full canopy over the grass: no gallop, full forest drag.
    grid.fields.eco_tree = new Float64Array(grid.topo.n);
    grid.fields.eco_tree[at(3, 2)] = 100;
    expect(edgeCost(grid, at(2, 2), at(3, 2), mounted)).toBeCloseTo(3, 10);
  });

  it("a committed road is a cleared corridor: no drag, mount in full", () => {
    const grid = makeGrid(cols, rows, () => 20);
    grid.fields.eco_tree = new Float64Array(grid.topo.n).fill(100);
    grid.fields.road = new Float64Array(grid.topo.n);
    grid.fields.road[at(2, 2)] = 1;
    grid.fields.road[at(3, 2)] = 1;
    expect(edgeCost(grid, at(2, 2), at(3, 2), OPTS)).toBeCloseTo(0.35, 10);
    expect(edgeCost(grid, at(2, 2), at(3, 2), { ...OPTS, mount: 1 })).toBeCloseTo(0.175, 10);
  });

  it("routes squeeze through the forest gap — the grass corridor is the pass", () => {
    const gapY = 5;
    const grid = makeGrid(31, 11, () => 20);
    const at31 = (x: number, y: number) => y * 31 + x;
    // A forest belt down columns 14..16, except the open row at gapY.
    grid.fields.eco_tree = new Float64Array(grid.topo.n);
    for (let y = 0; y < 11; y++) {
      if (y === gapY) continue;
      for (let x = 14; x <= 16; x++) grid.fields.eco_tree[at31(x, y)] = 100;
    }
    const route = leastCostRoute(grid, at31(3, 1), at31(27, 9), OPTS)!;
    expect(route).not.toBeNull();
    // The crossing runs the open row, never the deep wood.
    for (const c of route.cells) expect(grid.fields.eco_tree[c]).toBe(0);
    expect(route.cells).toContain(at31(15, gapY));
  });

  it("a grid without the biosphere fields travels exactly as before", () => {
    const grid = makeGrid(cols, rows, () => 20);
    expect(edgeCost(grid, at(2, 2), at(3, 2), { ...OPTS, mount: 1 })).toBe(1);
  });
});

describe("chokepoints — a mountain range pierced by one pass", () => {
  const cols = 31, rows = 21;
  const passX = 15, passY = 10;
  // A wall-steep range down column 15 (height 60 over a 20 plain), except
  // the low pass at (15, 10) at height 22.
  const heightAt = (x: number, y: number) =>
    x === passX ? (y === passY ? 22 : 60) : 20;
  const at = (x: number, y: number) => y * cols + x;
  const pass = at(passX, passY);

  it("the least-cost route goes through the pass", () => {
    const grid = makeGrid(cols, rows, heightAt);
    const route = leastCostRoute(grid, at(3, 4), at(27, 16), OPTS);
    expect(route).not.toBeNull();
    expect(route!.cells).toContain(pass);
    // No route cell climbs the wall.
    for (const c of route!.cells) expect(grid.fields.height[c]).toBeLessThan(40);
  });

  it("travelTraffic concentrates at the pass (every cross-range pair)", () => {
    const grid = makeGrid(cols, rows, heightAt);
    const hubs = [at(3, 5), at(3, 15), at(27, 5), at(27, 15)];
    const traffic = travelTraffic(grid, hubs, OPTS);
    expect(traffic[pass]).toBe(4); // all 4 cross pairs squeeze through
    // Off-pass wall cells and far plain carry nothing.
    expect(traffic[at(passX, 3)]).toBe(0);
    expect(traffic[at(8, 1)]).toBe(0);
    let max = 0;
    for (let i = 0; i < traffic.length; i++) max = Math.max(max, traffic[i]);
    expect(traffic[pass]).toBe(max);
  });

  it("founding with the traffic weight places a site at/adjacent to the pass", () => {
    const grid = makeGrid(cols, rows, heightAt);
    for (let i = 0; i < grid.topo.n; i++) grid.fields.people[i] = 2; // uniformly crowded
    const hubs = [at(3, 5), at(3, 15), at(27, 5), at(27, 15)];
    grid.fields.traffic = travelTraffic(grid, hubs, OPTS);
    const sites = findFoundingSites(grid, {
      threshold: 25, radius: 2, minSpacing: 6,
      score: [{ field: "traffic", weight: 3 }],
    });
    expect(sites.length).toBeGreaterThan(0);
    // The top-ranked site is the route town at the chokepoint.
    const d = Math.sqrt(grid.topo.dist2(sites[0].cell, pass));
    expect(d).toBeLessThanOrEqual(3);
  });

  it("a committed route through the wall (no pass) classifies tunnel", () => {
    const grid = makeGrid(cols, rows, (x) => (x === passX ? 60 : 20)); // no pass at all
    const route = leastCostRoute(grid, at(3, 10), at(27, 10), OPTS);
    expect(route).not.toBeNull();
    const { segments } = commitRoads(grid, [route!.cells], OPTS);
    const wallSeg = segments.find(s => s.cell % cols === passX);
    expect(wallSeg?.kind).toBe("tunnel");
    expect(segments.filter(s => s.kind === "tunnel").length).toBeLessThanOrEqual(3);
    expect(segments.filter(s => s.kind === "road").length).toBeGreaterThan(10);
  });
});

describe("water — fords, bridges, isthmuses", () => {
  const cols = 31, rows = 11;
  const at = (x: number, y: number) => y * cols + x;

  it("a river band is crossed at exactly one ford; committed it is a bridge", () => {
    const grid = makeGrid(cols, rows, () => 20);
    for (let y = 0; y < rows; y++) grid.fields.river[at(15, y)] = 100;
    const route = leastCostRoute(grid, at(3, 5), at(27, 5), OPTS);
    expect(route).not.toBeNull();
    const wet = route!.cells.filter(c => grid.fields.river[c] >= 16);
    expect(wet.length).toBe(1); // one ford, not a river walk
    const { segments } = commitRoads(grid, [route!.cells], OPTS);
    expect(segments.find(s => s.cell === wet[0])?.kind).toBe("bridge");
    expect(segments.filter(s => s.kind === "bridge").length).toBe(1);
  });

  it("open sea disconnects; an isthmus reconnects and takes all the traffic", () => {
    const sea = makeGrid(cols, rows, (x) => (x >= 13 && x <= 17 ? 0 : 20));
    expect(leastCostRoute(sea, at(3, 5), at(27, 5), OPTS)).toBeNull();
    // The same sea with a one-row land bridge at y = 5.
    const isthmus = makeGrid(cols, rows, (x, y) =>
      x >= 13 && x <= 17 ? (y === 5 ? 20 : 0) : 20);
    const route = leastCostRoute(isthmus, at(3, 9), at(27, 1), OPTS);
    expect(route).not.toBeNull();
    for (const c of route!.cells) expect(isthmus.fields.height[c]).toBe(20);
    const traffic = travelTraffic(isthmus, [at(3, 1), at(3, 9), at(27, 1), at(27, 9)], OPTS);
    // Every cross-sea pair funnels over every isthmus cell.
    for (let x = 13; x <= 17; x++) expect(traffic[at(x, 5)]).toBe(4);
  });
});

describe("roads feedback — later routes prefer the built corridor", () => {
  const cols = 31, rows = 15;
  const at = (x: number, y: number) => y * cols + x;

  it("after commitRoads a nearby pair routes along the road, strictly cheaper", () => {
    const grid = makeGrid(cols, rows, () => 20);
    const first = leastCostRoute(grid, at(5, 7), at(25, 7), OPTS)!;
    expect(first.cost).toBeCloseTo(20, 10);
    const { road } = commitRoads(grid, [first.cells], OPTS);
    const second = leastCostRoute(grid, at(5, 9), at(25, 9), OPTS)!;
    expect(second.cost).toBeLessThan(20); // beats the straight overland line
    const onRoad = second.cells.filter(c => road[c] > 0).length;
    expect(onRoad).toBeGreaterThan(10); // it actually rides the corridor
  });
});

describe("determinism — identical outputs across runs", () => {
  const cols = 31, rows = 21;
  const heightAt = (x: number, y: number) =>
    x === 15 ? (y === 10 ? 22 : 60) : 20 + ((x * 7 + y * 13) % 3);
  const at = (x: number, y: number) => y * cols + x;

  it("routes, traffic and commits replay bit-identically", () => {
    const run = () => {
      const grid = makeGrid(cols, rows, heightAt);
      grid.fields.river[at(8, 10)] = 40;
      const hubs = [at(3, 5), at(3, 15), at(27, 5), at(27, 15), at(15, 2)];
      const routes = hubRoutes(grid, hubs, OPTS);
      const traffic = travelTraffic(grid, hubs, OPTS);
      const { road, segments } = commitRoads(grid, routes, OPTS);
      return { routes, traffic: Array.from(traffic), road: Array.from(road), segments };
    };
    const a = run();
    const b = run();
    expect(b.routes).toEqual(a.routes);
    expect(b.traffic).toEqual(a.traffic);
    expect(b.road).toEqual(a.road);
    expect(b.segments).toEqual(a.segments);
  });
});
