// ONE DATUM — the terrain a walker stands on IS the terrain the mesh draws,
// rivers included (walk-chart.ts's own header). These pin the seam that broke:
// `attachRiverRelief` folded a valley NOTCH into surface.heightAt while
// chunk.ts separately ADDED the channel's water depth to the vertex radius, so
// the two answers diverged — measured at 58 m on a planet whose entire relief
// budget is 25 m, because the notch/water magnitudes were absolute metre
// constants that never asked how tall the world was allowed to be.
//
// Pure and fast: no tectonics bake. A hand-painted flow field on a small
// cube-sphere is all the river tracer needs, and a synthetic PlanetSurface is
// all the fold needs — so these run in the DB-free engine suite.

import { describe, it, expect } from "@jest/globals";
import { makeCubeSphereTopology } from "@shared/world-engine/kernel/cells/topology.js";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics.js";
import { attachRiverRelief, buildRiverRelief } from "@shared/world-engine/planet/rivers.js";
import { buildChunkGeometry, PLANET_FACES } from "@shared/world-engine/planet/chunk.js";
import type { BuiltPlanet } from "@shared/world-engine/planet/planet-game.js";
import type { PlanetSurface, Vec3 } from "@shared/world-engine/planet/surface.js";

const FACE_N = 8;
/** Height units every land cell carries — well clear of SEA_HEIGHT so the
 *  tracer calls the whole world land and the coastal floor never binds. */
const LAND_UNITS = 30;
/** Uncarved ground the synthetic surface reports, in metres. Deliberately far
 *  above any notch either scale can cut, so the notch is what we measure. */
const BASE_H_M = 400;
/** The substrate's height range (0..63) — one unit is relief·radius/(63−sea). */
const MAX_UNITS = 63;

/** A hand-painted trunk river: a greedy walk of adjacent cells starting from
 *  the one nearest `from`, each pointing downstream at the next, the last a
 *  sink. Enough drainage tree for traceRiverPolylines to emit one polyline. */
function paintRiver(topo: ReturnType<typeof makeCubeSphereTopology>, from: Vec3, length: number): {
  height: Float64Array; river: Float64Array; riverDown: Float64Array; chain: number[];
} {
  const n = topo.n;
  const height = new Float64Array(n).fill(LAND_UNITS);
  const river = new Float64Array(n);
  const riverDown = new Float64Array(n).fill(-1);
  let start = 0;
  let best = -Infinity;
  for (let c = 0; c < n; c++) {
    const p = topo.pos3!(c);
    const d = p[0] * from[0] + p[1] * from[1] + p[2] * from[2];
    if (d > best) { best = d; start = c; }
  }
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  const chain: number[] = [start];
  const used = new Set<number>([start]);
  while (chain.length < length) {
    const k = topo.neighbours(chain[chain.length - 1]!, nb);
    let next = -1;
    for (let j = 0; j < k; j++) if (!used.has(nb[j]!)) { next = nb[j]!; break; }
    if (next < 0) break;
    used.add(next);
    chain.push(next);
  }
  // Accumulation rises downstream, all of it over RIVER_MIN_ACCUM (16).
  for (let i = 0; i < chain.length; i++) {
    river[chain[i]!] = 100 + i * 50;
    riverDown[chain[i]!] = i + 1 < chain.length ? chain[i + 1]! : -1;
  }
  return { height, river, riverDown, chain };
}

/** A synthetic planet at a given radius/relief, with a flat synthetic surface
 *  (BASE_H_M everywhere) and one painted river. */
function makePlanet(radius: number, relief: number): {
  built: BuiltPlanet; chain: number[]; unitElevM: number; budgetM: number;
} {
  const topo = makeCubeSphereTopology(FACE_N);
  const { height, river, riverDown, chain } = paintRiver(topo, [1, 0, 0], 6);
  const surface: PlanetSurface = {
    radius,
    heightAt: () => BASE_H_M,
    colorAt: (_h, _dir, out) => { out[0] = 0.3; out[1] = 0.3; out[2] = 0.3; },
  };
  const built = {
    spec: { radius, relief },
    topo,
    grid: { topo, fields: { height, river, riverDown } },
    sites: [],
    surface,
  } as unknown as BuiltPlanet;
  const budgetM = relief * radius;
  return { built, chain, unitElevM: budgetM / (MAX_UNITS - SEA_HEIGHT), budgetM };
}

/** Every main-grid vertex of a face-0 chunk `halfExtentM` metres either side
 *  of `center`, as (dir, drawn elevation, wet). Face 0 is the +X face
 *  (PLANET_FACES[0]: n=+X, u=−Z, v=+Y), which is where paintRiver puts the
 *  trunk — so (uu, vv) = (−z/x, y/x) locates it on that face's chart.
 *
 *  The patch is sized in METRES rather than in face units on purpose: a
 *  channel is ~100 m wide at any radius, so a fixed uv patch that resolves it
 *  on a 5 km planet has 200 km vertex spacing on a real one and steps clean
 *  over every river there (which is the honest render answer, and useless for
 *  measuring the datum). */
function chunkVertices(
  surface: PlanetSurface, center: Vec3, halfExtentM: number, N: number,
): Array<{ dir: Vec3; drawn: number; wet: boolean }> {
  const face = 0;
  const F = PLANET_FACES[face]!;
  const e = halfExtentM / surface.radius;
  const cu = -center[2] / center[0];
  const cv = center[1] / center[0];
  const uMin = cu - e, uMax = cu + e, vMin = cv - e, vMax = cv + e;
  const geo = buildChunkGeometry({
    face, uMin, uMax, vMin, vMax, resolution: N, surface,
    skirtDepth: surface.radius * 1e-5, seaClamp: true,
  });
  const out: Array<{ dir: Vec3; drawn: number; wet: boolean }> = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const uu = uMin + ((uMax - uMin) * i) / (N - 1);
      const vv = vMin + ((vMax - vMin) * j) / (N - 1);
      let dx = F.n[0] + F.u[0] * uu + F.v[0] * vv;
      let dy = F.n[1] + F.u[1] * uu + F.v[1] * vv;
      let dz = F.n[2] + F.u[2] * uu + F.v[2] * vv;
      const m = Math.hypot(dx, dy, dz);
      dx /= m; dy /= m; dz /= m;
      const o = (j * N + i) * 3;
      const ax = geo.positions[o]! + geo.center[0];
      const ay = geo.positions[o + 1]! + geo.center[1];
      const az = geo.positions[o + 2]! + geo.center[2];
      out.push({
        dir: [dx, dy, dz],
        drawn: Math.hypot(ax, ay, az) - surface.radius,
        wet: geo.water[j * N + i] === 1,
      });
    }
  }
  return out;
}

describe("river relief is bounded by the world's own relief budget", () => {
  it("a compressed world cannot be cut deeper than it is tall", () => {
    // The reported defect's planet: 5 km radius at relief 0.005 — 25 m of
    // total relief, into which the absolute constants cut 95 m.
    const { built, chain, unitElevM, budgetM } = makePlanet(5_000, 0.005);
    const relief = buildRiverRelief(built)!;
    expect(relief).not.toBeNull();
    expect(relief.rivers.length).toBeGreaterThan(0);

    let deepest = 0;
    for (const cell of chain) {
      const dir = built.topo.pos3!(cell);
      deepest = Math.max(deepest, BASE_H_M - relief.groundAt(BASE_H_M, dir));
    }
    expect(deepest).toBeGreaterThan(0); // it really does carve
    // The whole valley (notch, before the water refills half of it) stays
    // inside 3 substrate height units — carveValleys' own currency.
    expect(deepest).toBeLessThanOrEqual(3 * unitElevM);
    expect(deepest).toBeLessThan(budgetM);
  });

  it("a real-radius world keeps the absolute human-scale ceiling", () => {
    // One height unit is ~531 m at Earth radius, so the 150 m absolute cap is
    // the binding one and nothing about a real planet moves.
    const { built, chain, unitElevM } = makePlanet(6_371_000, 0.005);
    expect(3 * unitElevM).toBeGreaterThan(150);
    const relief = buildRiverRelief(built)!;
    let deepest = 0;
    for (const cell of chain) {
      deepest = Math.max(deepest, BASE_H_M - relief.groundAt(BASE_H_M, built.topo.pos3!(cell)));
    }
    // Water fills the top RIVER_FILL (0.5) of a 150 m notch, so the drawn
    // ground sits 75 m under the banks at the centreline.
    expect(deepest).toBeGreaterThan(10);
    expect(deepest).toBeCloseTo(75, 0);
  });

  it("a river is carved INTO the terrain, never stacked above it", () => {
    for (const radius of [5_000, 6_371_000]) {
      const { built } = makePlanet(radius, 0.005);
      const relief = buildRiverRelief(built)!;
      // Sample a dense band across the channel and its banks — the notch
      // profile, its shoulder, and the dry ground beyond.
      const a = built.topo.pos3!(0);
      for (let c = 0; c < built.topo.n; c++) {
        const p = built.topo.pos3!(c);
        for (let t = 0; t <= 8; t++) {
          const f = t / 8;
          const x = a[0] + (p[0] - a[0]) * f, y = a[1] + (p[1] - a[1]) * f, z = a[2] + (p[2] - a[2]) * f;
          const m = Math.hypot(x, y, z) || 1;
          const g = relief.groundAt(BASE_H_M, [x / m, y / m, z / m]);
          expect(g).toBeLessThanOrEqual(BASE_H_M);
        }
      }
    }
  });

  it("the reported water depth is a shading signal inside the budget, not a lift", () => {
    const { built, chain, unitElevM } = makePlanet(5_000, 0.005);
    attachRiverRelief(built);
    const rgb: [number, number, number] = [0, 0, 0];
    const flow: [number, number, number] = [0, 0, 0];
    let deepest = 0;
    for (const cell of chain) {
      deepest = Math.max(deepest, built.surface.riverSampleAt!(built.topo.pos3!(cell), 0, rgb, flow));
    }
    expect(deepest).toBeGreaterThan(0);
    // Half the notch — and the notch is 3 units at most, so the water can
    // never be the 47 m the mesh once stacked on a 25 m planet.
    expect(deepest).toBeLessThanOrEqual(1.5 * unitElevM);
  });

  it("the depth is span-independent — the mesh's LOD glyph never reaches water", () => {
    const { built, chain } = makePlanet(5_000, 0.005);
    attachRiverRelief(built);
    const rgb: [number, number, number] = [0, 0, 0];
    const flow: [number, number, number] = [0, 0, 0];
    const dir = built.topo.pos3!(chain[2]!);
    const spans = [0.02, 5, 60, 360].map(s => built.surface.riverSampleAt!(dir, s, rgb, flow));
    for (const s of spans) expect(s).toBeCloseTo(spans[0]!, 9);
  });
});

describe("walkers stand on exactly the terrain that draws", () => {
  it.each([[5_000], [6_371_000]])("the chunk mesh equals surface.heightAt at radius %i", (radius) => {
    const { built, chain } = makePlanet(radius, 0.005);
    attachRiverRelief(built);
    const surface = built.surface;
    // A ±400 m patch straddling the trunk — fine enough that vertices land in
    // the channel at either radius. seaClamp on, but BASE_H_M is land
    // everywhere, so the ocean branch never fires and every vertex is walkable.
    const verts = chunkVertices(surface, built.topo.pos3!(chain[2]!), 400, 33);
    const wetVerts = verts.filter(v => v.wet);
    expect(wetVerts.length).toBeGreaterThan(0); // the patch really does hold a river

    // Float32 center-relative storage is the only error budget (see chunk.ts's
    // PRECISION note) — it scales with the chunk, not with the river.
    const tol = Math.max(1e-4, radius * 1e-6);
    let worst = 0;
    let worstWet = 0;
    for (const v of verts) {
      const err = Math.abs(v.drawn - surface.heightAt(v.dir));
      worst = Math.max(worst, err);
      if (v.wet) worstWet = Math.max(worstWet, err);
    }
    expect(worst).toBeLessThanOrEqual(tol);
    expect(worstWet).toBeLessThanOrEqual(tol);
  });

  it("the drawn surface stays inside the planet's relief budget", () => {
    const { built, budgetM, chain } = makePlanet(5_000, 0.005);
    attachRiverRelief(built);
    // COARSE (2 km across, ~62 m spacing) and FINE (±400 m) chunks over the
    // same trunk — the LOD fade is a paint rule, so neither may move geometry.
    const at = built.topo.pos3!(chain[2]!);
    const verts = [...chunkVertices(built.surface, at, 1_000, 33), ...chunkVertices(built.surface, at, 400, 33)];
    for (const v of verts) {
      // The synthetic ground sits at BASE_H_M; a river may only dig down from
      // it, and never by more than the budget.
      expect(v.drawn).toBeLessThanOrEqual(BASE_H_M + 1e-3);
      expect(BASE_H_M - v.drawn).toBeLessThan(budgetM);
    }
  });

  it("away from any river the datum is the untouched surface", () => {
    const { built } = makePlanet(5_000, 0.005);
    attachRiverRelief(built);
    // The antipode of the painted trunk — far outside any shoulder.
    expect(built.surface.heightAt([-1, 0, 0])).toBe(BASE_H_M);
  });
});
