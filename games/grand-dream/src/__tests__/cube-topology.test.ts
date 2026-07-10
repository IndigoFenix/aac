/**
 * Cube-sphere topology (shared/engine/cells/topology.ts) — the first curved
 * lattice behind the GridTopology seam.
 *
 * What must hold for the engine's guarantees to carry over unchanged:
 *   - the lattice is a closed 4-regular surface (adjacency symmetric, no
 *     self-loops, openSides 0 — conservation has no leak to fall out of);
 *   - the geometric fold produced TRUE edge-neighbours (angular distance of
 *     every neighbour pair ≈ one cell pitch — a bad seam table shows up as a
 *     "neighbour" half a planet away);
 *   - disk() is the flat box away from seams, continues across seams, loses
 *     cells only at cube corners (the wedge deficit), never duplicates;
 *   - the grid engine itself runs on it: water flows downhill around the
 *     sphere, conserves exactly (nowhere to drain), and reaches rest;
 *   - a cube grid survives the serialize round-trip with its lattice intact.
 */
import { describe, it, expect } from "vitest";
import {
  makeCubeSphereTopology,
  createGridOn, worldStep, pendingCount, totalField, injectTile,
  serializeGrid, deserializeGrid,
  type SystemSpec,
} from "@cells/index";

const N = 6;
const topo = makeCubeSphereTopology(N);

describe("cube-sphere — lattice soundness", () => {
  it("is a closed 4-regular surface: symmetric adjacency, no self-loops, no open sides", () => {
    const nb: number[] = [0, 0, 0, 0];
    const back: number[] = [0, 0, 0, 0];
    for (let i = 0; i < topo.n; i++) {
      expect(topo.openSides(i)).toBe(0);
      const k = topo.neighbours(i, nb);
      expect(k).toBe(4);
      const distinct = new Set(nb.slice(0, k));
      expect(distinct.size).toBe(4);
      expect(distinct.has(i)).toBe(false);
      for (const j of nb.slice(0, k)) {
        const kb = topo.neighbours(j, back);
        expect(back.slice(0, kb)).toContain(i);
      }
    }
  });

  it("every neighbour is geometrically adjacent (≈ one cell pitch away)", () => {
    // A misfolded seam pairs cells on far sides of the sphere; the angular
    // gap between real edge-neighbours stays within a small factor of the
    // pitch even under the equal-angle mapping's residual distortion.
    const nb: number[] = [0, 0, 0, 0];
    for (let i = 0; i < topo.n; i++) {
      topo.neighbours(i, nb);
      for (const j of nb) {
        const d = Math.sqrt(topo.dist2(i, j));
        expect(d).toBeGreaterThan(0.4);
        expect(d).toBeLessThan(2.0);
      }
    }
  });

  it("dist2 is symmetric, zero only at self, and pos3 is on the unit sphere", () => {
    const a = 0;
    const b = ((4 * N + 2) * N + 3) | 0; // an arbitrary +Z-face cell
    expect(topo.dist2(a, a)).toBe(0);
    expect(topo.dist2(a, b)).toBeCloseTo(topo.dist2(b, a), 12);
    expect(topo.dist2(a, b)).toBeGreaterThan(0);
    const p = topo.pos3!(b);
    expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(1, 12);
  });

  it("cellAt inverts pos3 exactly (the gather/render lookup)", () => {
    for (let i = 0; i < topo.n; i++) {
      expect(topo.cellAt!(topo.pos3!(i))).toBe(i);
    }
    // And it tolerates unnormalized directions.
    const p = topo.pos3!(17);
    expect(topo.cellAt!([p[0] * 5, p[1] * 5, p[2] * 5])).toBe(17);
  });

  it("construction is deterministic", () => {
    const again = makeCubeSphereTopology(N);
    const nb1: number[] = [0, 0, 0, 0];
    const nb2: number[] = [0, 0, 0, 0];
    for (let i = 0; i < topo.n; i++) {
      topo.neighbours(i, nb1);
      again.neighbours(i, nb2);
      expect(nb2).toEqual(nb1);
    }
  });
});

describe("cube-sphere — disk (the unfolded chart)", () => {
  const cellOf = (f: number, u: number, v: number): number => (f * N + v) * N + u;
  const collect = (i: number, r: number): Map<number, number> => {
    const out = new Map<number, number>();
    topo.disk(i, r, (cell, d) => {
      expect(out.has(cell)).toBe(false); // never a duplicate visit
      out.set(cell, d);
    });
    return out;
  };

  it("face-interior disk is exactly the flat (2r+1)² box, distances included", () => {
    const center = cellOf(4, 3, 3); // +Z face interior, r=2 stays in-face
    const disk = collect(center, 2);
    expect(disk.size).toBe(25);
    const ds = [...disk.values()].sort((a, b) => a - b);
    // Flat box distance multiset: 0, 1×4, √2×4, 2×4, √5×8, 2√2×4.
    expect(ds[0]).toBe(0);
    expect(ds.filter(d => Math.abs(d - 1) < 1e-9).length).toBe(4);
    expect(ds.filter(d => Math.abs(d - Math.SQRT2) < 1e-9).length).toBe(4);
    expect(ds.filter(d => Math.abs(d - Math.sqrt(5)) < 1e-9).length).toBe(8);
  });

  it("continues across a face seam (edge cell, away from corners)", () => {
    const edgeCell = cellOf(4, N - 1, 3); // +Z face, east edge, mid-row
    const disk = collect(edgeCell, 1);
    expect(disk.size).toBe(9); // full box — the chart unfolds over the seam
    let offFace = 0;
    for (const cell of disk.keys()) if (((cell / (N * N)) | 0) !== 4) offFace++;
    expect(offFace).toBe(3); // the +u column came from the neighbouring face
  });

  it("shows the wedge deficit at a cube corner, and only there", () => {
    const cornerCell = cellOf(4, 0, 0);
    const disk = collect(cornerCell, 1);
    // Flat box = 9; around a degree-3 corner vertex one diagonal quadrant
    // is the same cell approached both ways — first arrival keeps it single.
    expect(disk.size).toBeLessThan(9);
    expect(disk.size).toBeGreaterThanOrEqual(7);
  });
});

describe("cube-sphere — the grid engine runs on it", () => {
  const SPEC: SystemSpec = {
    id: "sphere-water",
    vars: [
      { name: "height", min: 0, max: 63, initial: 0, int: true },
      { name: "water", min: 0, max: 1000, initial: 1 },
    ],
    rules: [
      { id: "flow", trigger: { every: true }, effects: [{ flowDown: { scalar: "water", potential: "height", rate: 0.2 } }] },
    ],
  };

  const buildWorld = (faceN: number) => {
    const grid = createGridOn(SPEC, { kind: "cube-sphere", faceN });
    // One continent: raise land on the northern hemisphere (pos3 z > 0),
    // higher toward the pole — authored through the sanctioned channel.
    for (let c = 0; c < grid.topo.n; c++) {
      const z = grid.topo.pos3!(c)[2];
      if (z > 0) injectTile(grid, c, "height", Math.round(30 * z));
    }
    return grid;
  };

  it("water drains off the highlands, conserves exactly, and reaches rest", () => {
    const grid = buildWorld(8);
    const total0 = totalField(grid, "water");
    expect(total0).toBeCloseTo(grid.topo.n, 9);
    let steps = 0;
    while (pendingCount(grid) > 0 && steps++ < 20_000) worldStep(grid);
    expect(pendingCount(grid)).toBe(0); // crisp rest — the scheduler slept
    expect(totalField(grid, "water")).toBeCloseTo(total0, 6); // closed surface: nothing drained off-map
    // The pole shed its water; the southern hemisphere holds more than it started with.
    let poleCell = 0;
    let bestZ = -2;
    for (let c = 0; c < grid.topo.n; c++) {
      const z = grid.topo.pos3!(c)[2];
      if (z > bestZ) { bestZ = z; poleCell = c; }
    }
    expect(grid.fields.water[poleCell]).toBeLessThan(0.05);
    let south = 0;
    let southCells = 0;
    for (let c = 0; c < grid.topo.n; c++) {
      if (grid.topo.pos3!(c)[2] < 0) { south += grid.fields.water[c]; southCells++; }
    }
    expect(south / southCells).toBeGreaterThan(1);
  });

  it("survives the serialize round-trip with its lattice and dynamics intact", () => {
    const a = buildWorld(6);
    for (let s = 0; s < 50; s++) worldStep(a);
    const b = deserializeGrid(serializeGrid(a))!;
    expect(b).not.toBeNull();
    expect(b.topo.n).toBe(a.topo.n);
    expect(b.topoSpec).toEqual({ kind: "cube-sphere", faceN: 6 });
    for (let s = 0; s < 50; s++) { worldStep(a); worldStep(b); }
    expect(Array.from(b.fields.water)).toEqual(Array.from(a.fields.water));
    expect(Array.from(b.fields.height)).toEqual(Array.from(a.fields.height));
  });
});
