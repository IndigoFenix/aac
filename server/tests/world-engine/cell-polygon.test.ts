// CELL POLYGONS — the scatter counterpart of `cellAt` (nations P6b): the
// primitive that lets a renderer paint a per-cell FIELD as AREA instead of
// sampling it at a point (territory claims, plate ids, biome washes).
//
// The load-bearing property is CRACK-FREE TILING: a corner must be the
// EXACT same direction for every cell that touches it, including across a
// cube-face seam, or a whole-lattice wash shows hairline gaps and
// double-covered slivers along every face edge.

import { describe, it, expect } from "@jest/globals";
import { makeTopology, type GridTopology } from "@shared/world-engine/kernel/cells/topology.js";

const N = 8;
const topo: GridTopology = makeTopology({ kind: "cube-sphere", faceN: N });
const poly = (i: number) => topo.cellPolygon!(i);
const key = (d: readonly [number, number, number]) =>
  d.map(x => (Math.abs(x) < 1e-12 ? 0 : x).toFixed(9)).join(",");

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!,
] as const;

describe("cellPolygon — the per-cell area primitive", () => {
  it("gives four unit-length corners per cell, everywhere on the lattice", () => {
    for (let i = 0; i < topo.n; i++) {
      const p = poly(i);
      expect(p).toHaveLength(4);
      for (const c of p) expect(Math.hypot(c[0], c[1], c[2])).toBeCloseTo(1, 12);
    }
  });

  it("contains its own center — the polygon really is THIS cell's area", () => {
    for (let i = 0; i < topo.n; i++) {
      const c = topo.pos3!(i);
      // The center must sit strictly inside all four edge planes.
      const p = poly(i);
      for (let e = 0; e < 4; e++) {
        const n = cross(p[e]!, p[(e + 1) % 4]!); // edge great-circle normal
        expect(dot(n, c)).toBeGreaterThan(0);
      }
    }
  });

  it("is wound CCW seen from OUTSIDE (the face frames' orientation)", () => {
    for (let i = 0; i < topo.n; i++) {
      const p = poly(i);
      const c = topo.pos3!(i);
      // (p1-p0) × (p2-p0) points outward for CCW-from-outside winding.
      const e1 = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]] as const;
      const e2 = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]] as const;
      expect(dot(cross(e1, e2), c)).toBeGreaterThan(0);
    }
  });

  it("TILES WITHOUT CRACKS: every corner is bit-identical across all cells sharing it", () => {
    // Corner → how many cells claim it. On a cube-sphere every corner is
    // shared by exactly 4 cells, except the 8 cube corners (3 cells each).
    const shared = new Map<string, number>();
    for (let i = 0; i < topo.n; i++) for (const c of poly(i)) {
      shared.set(key(c), (shared.get(key(c)) ?? 0) + 1);
    }
    const counts = new Map<number, number>();
    for (const n of shared.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
    // If corners disagreed by even a float ulp across a seam, the shared
    // count would collapse to 1s and 2s and this distribution would break.
    expect(counts.get(3)).toBe(8);           // the cube's own corners
    expect([...counts.keys()].sort()).toEqual([3, 4]); // nothing else exists
    // Euler check on the quad mesh: V − E + F = 2.
    const V = shared.size;
    const F = topo.n;
    const E = (4 * F) / 2;
    expect(V - E + F).toBe(2);
  });

  it("neighbouring cells share exactly one EDGE (two corners), seams included", () => {
    const nb: number[] = new Array(topo.maxDegree).fill(0);
    for (let i = 0; i < topo.n; i++) {
      const mine = new Set(poly(i).map(key));
      const k = topo.neighbours(i, nb);
      for (let s = 0; s < k; s++) {
        const theirs = poly(nb[s]!).map(key);
        const common = theirs.filter(c => mine.has(c));
        expect({ cell: i, neighbour: nb[s], shared: common.length })
          .toEqual({ cell: i, neighbour: nb[s], shared: 2 });
      }
    }
  });

  it("the polygons cover the whole sphere — total solid angle is 4π", () => {
    // Spherical excess per quad, summed. A crack or an overlap anywhere
    // would show up as a shortfall or surplus here.
    let total = 0;
    for (let i = 0; i < topo.n; i++) {
      const p = poly(i);
      for (const tri of [[0, 1, 2], [0, 2, 3]]) {
        const [a, b, c] = tri.map(t => p[t]!);
        // l'Huilier via the vector triple product form.
        const num = Math.abs(dot(a!, cross(b!, c!)));
        const den = 1 + dot(a!, b!) + dot(b!, c!) + dot(c!, a!);
        total += 2 * Math.atan2(num, den);
      }
    }
    expect(total).toBeCloseTo(4 * Math.PI, 9);
  });

  it("flat lattices omit it — the curved-only contract", () => {
    expect(makeTopology({ kind: "flat", cols: 4, rows: 4 }).cellPolygon).toBeUndefined();
  });
});

describe("SUBDIVIDED cells still meet exactly (what the territory wash draws)", () => {
  // Mirrors the fill renderer (games/world-lab/src/trade-roads.ts): a cell
  // is drawn as SUB×SUB sub-quads, each vertex bilinear across the four
  // corners and pushed back onto the sphere. If two cells disagreed by a
  // float along a shared edge, the wash would show a hairline crack down
  // every cell boundary on the planet.
  const SUB = 3;
  const sub = (p: ReturnType<typeof poly>, s: number, t: number) => {
    const x = (1 - s) * (1 - t) * p[0]![0] + s * (1 - t) * p[1]![0] + s * t * p[2]![0] + (1 - s) * t * p[3]![0];
    const y = (1 - s) * (1 - t) * p[0]![1] + s * (1 - t) * p[1]![1] + s * t * p[2]![1] + (1 - s) * t * p[3]![1];
    const z = (1 - s) * (1 - t) * p[0]![2] + s * (1 - t) * p[1]![2] + s * t * p[2]![2] + (1 - s) * t * p[3]![2];
    const m = Math.hypot(x, y, z);
    return [x / m, y / m, z / m] as const;
  };

  it("every sub-vertex lands on the unit sphere", () => {
    for (let i = 0; i < topo.n; i += 7) {
      const p = poly(i);
      for (let a = 0; a <= SUB; a++) for (let b = 0; b <= SUB; b++) {
        const d = sub(p, a / SUB, b / SUB);
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
      }
    }
  });

  it("a shared EDGE generates the identical sub-vertex set in both cells", () => {
    // The edge sub-vertices depend only on the two shared corners (the
    // bilinear collapses to a normalized chord when s or t is pinned), so
    // both neighbours must produce the same points — possibly reversed.
    const nb: number[] = new Array(topo.maxDegree).fill(0);
    const edgePoints = (i: number): Set<string> => {
      const p = poly(i);
      const out = new Set<string>();
      for (let k = 0; k <= SUB; k++) {
        const u = k / SUB;
        for (const d of [sub(p, u, 0), sub(p, u, 1), sub(p, 0, u), sub(p, 1, u)]) out.add(key(d));
      }
      return out;
    };
    let checked = 0;
    for (let i = 0; i < topo.n; i += 11) {
      const mine = edgePoints(i);
      const k = topo.neighbours(i, nb);
      for (let s = 0; s < k; s++) {
        const theirs = edgePoints(nb[s]!);
        // The SUB+1 vertices of the shared edge appear in both sets.
        const common = [...mine].filter(c => theirs.has(c));
        expect({ cell: i, nb: nb[s], shared: common.length })
          .toEqual({ cell: i, nb: nb[s], shared: SUB + 1 });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
