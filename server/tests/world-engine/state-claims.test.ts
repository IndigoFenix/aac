// TERRITORY (states round S2 — states-round.md §9/§11/§14-①): the locality
// cap on cost-Voronoi claims (land beyond every capital's reach stays
// UNCLAIMED — the frontier), and the POINT claim read (`claimAt`) that
// re-points MEANING to the catchment at sub-cell grain: interior cells agree
// with the plain cell label; a border-crossed cell answers for the side of
// the true cost border a point stands on; identity/keys never move (§9).
// planetStates' opts.maxClaimCostM is a metres/mpc division over the same
// capped costClaims pinned here.
// Slice: `npm run test:engine -- state-claims`

import { describe, it, expect } from "@jest/globals";
import { costClaims } from "@shared/world-engine/kernel/civ/travel.js";
import { claimAt, type ClaimPointTopo, type PlanetStates } from "@shared/world-engine/planet/states.js";
import { createGrid, type SystemSpec } from "@shared/world-engine/kernel/cells/index.js";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics.js";

// ── The cap: a frontier is land no capital can afford to reach ─────────────

const COLS = 12;
const ROWS = 12;
const at = (x: number, y: number): number => y * COLS + x;
const spec: SystemSpec = {
  id: "claims-test",
  name: "Claims test",
  vars: [{ name: "height", min: 0, max: 63, initial: SEA_HEIGHT + 10, init: "flat" }],
  rules: [],
};

describe("costClaims maxCost — the locality cap (§14-①)", () => {
  it("uncapped claims everything; the default IS Infinity, byte for byte", () => {
    const grid = createGrid(spec, COLS, ROWS);
    const seeds = [at(2, 2)];
    const open = costClaims(grid, seeds);
    const inf = costClaims(grid, seeds, undefined, Infinity);
    expect(open.owner).toEqual(inf.owner);
    expect(open.dist).toEqual(inf.dist);
    expect(open.owner[at(11, 11)]).toBe(0); // the far corner is still somebody's
    expect(Number.isFinite(open.dist[at(11, 11)]!)).toBe(true);
  });

  it("capped claims stop at the cap: near land claimed, far land frontier", () => {
    const grid = createGrid(spec, COLS, ROWS);
    const capped = costClaims(grid, [at(2, 2)], undefined, 4);
    expect(capped.owner[at(2, 2)]).toBe(0);
    expect(capped.owner[at(3, 2)]).toBe(0);              // one flat step
    expect(capped.owner[at(11, 11)]).toBe(-1);           // ≥ 9 steps of cost — frontier
    expect(capped.dist[at(11, 11)]).toBe(Infinity);
    // Every claimed cell is within the cap; every unclaimed one carries no cost.
    for (let c = 0; c < COLS * ROWS; c++) {
      if (capped.owner[c]! >= 0) expect(capped.dist[c]!).toBeLessThanOrEqual(4);
      else expect(capped.dist[c]).toBe(Infinity);
    }
  });

  it("two crowned islands in one wilderness: the middle belongs to nobody", () => {
    const grid = createGrid(spec, COLS, ROWS);
    const capped = costClaims(grid, [at(2, 2), at(9, 9)], undefined, 3);
    expect(capped.owner[at(2, 2)]).toBe(0);
    expect(capped.owner[at(9, 9)]).toBe(1);
    expect(capped.owner[at(6, 6)]).toBe(-1); // beyond both crowns' reach
  });
});

// ── The point read: an arc of six cells, two crowns ────────────────────────
//
// Centers at longitudes θ = 0 … 0.5 on a radius-1000 equator, so adjacent
// centers sit 100 arc-metres apart. Seats at cells 0 and 5; the political
// border falls between the mid-cost interiors, cells 2 and 3.

const RADIUS_M = 1000;
const THETA = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const centers = THETA.map(t => [Math.cos(t), 0, Math.sin(t)] as const);
const dirAt = (t: number): readonly [number, number, number] => [Math.cos(t), 0, Math.sin(t)];

const arcTopo: ClaimPointTopo = {
  maxDegree: 2,
  pos3: cell => centers[cell]!,
  cellAt: dir => {
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < centers.length; i++) {
      const p = centers[i]!;
      const d = dir[0] * p[0] + dir[1] * p[1] + dir[2] * p[2];
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  },
  neighbours: (cell, out) => {
    let k = 0;
    if (cell > 0) out[k++] = cell - 1;
    if (cell < centers.length - 1) out[k++] = cell + 1;
    return k;
  },
};

const claims = (stateOf: number[], costM: number[]): Pick<PlanetStates, "stateOf" | "costM"> => ({
  stateOf: Int32Array.from(stateOf),
  costM: Float64Array.from(costM),
});

describe("claimAt — the catchment read at sub-cell grain (§9)", () => {
  it("interior points agree with the plain cell label", () => {
    const s = claims([0, 0, 0, 1, 1, 1], [0, 100, 200, 200, 100, 0]);
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0))).toBe(0);
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.1))).toBe(0);
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.5))).toBe(1);
  });

  it("a border-crossed cell answers by the COST border, not its label", () => {
    // Crown 0's side is cheaper (claim 160 vs 200 at the facing interior
    // centers), so the true cost border sits at θ ≈ 0.27 — INSIDE cell 3.
    // A point at 0.26 stands in cell 3 by address, on crown 0's side by cost.
    const s = claims([0, 0, 0, 1, 1, 1], [0, 80, 160, 200, 120, 0]);
    expect(arcTopo.cellAt!(dirAt(0.26))).toBe(3);
    expect(s.stateOf[3]).toBe(1);                               // the cell label…
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.26))).toBe(0);  // …and the honest read
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.29))).toBe(1);  // past the crossover
    // Symmetric costs put the border at the cell boundary: labels stand.
    const even = claims([0, 0, 0, 1, 1, 1], [0, 100, 200, 200, 100, 0]);
    expect(claimAt(arcTopo, RADIUS_M, even, dirAt(0.26))).toBe(1);
  });

  it("the frontier: deep unclaimed answers nobody; a cut cell's near side answers", () => {
    const s = claims([0, 0, -1, -1, -1, -1], [0, 100, Infinity, Infinity, Infinity, Infinity]);
    // Deep in the unclaimed end — every candidate center is unreachable.
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.4))).toBe(-1);
    // Just inside the unclaimed cell: the border cuts through it — the near
    // side is genuinely within crown 0's reach through center 1.
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.21))).toBe(0);
    // …unless the locality cap says that reach is spent (100 + 110 > 150).
    expect(claimAt(arcTopo, RADIUS_M, s, dirAt(0.21), 150)).toBe(-1);
  });

  it("degrades honestly on thin topologies", () => {
    const s = claims([0, 0, 0, 1, 1, 1], [0, 80, 160, 200, 120, 0]);
    // No cellAt: no address, no answer.
    expect(claimAt({ maxDegree: 2 }, RADIUS_M, s, dirAt(0.26))).toBe(-1);
    // No pos3: the plain cell label (the pre-S2 read, unchanged).
    const flat: ClaimPointTopo = { maxDegree: 2, cellAt: arcTopo.cellAt, neighbours: arcTopo.neighbours };
    expect(claimAt(flat, RADIUS_M, s, dirAt(0.26))).toBe(1);
  });
});
