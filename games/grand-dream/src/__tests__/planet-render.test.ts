/**
 * Planet renderer (shared/planet) — seagull-dream's cube-sphere quadtree
 * terrain, framework-free, sampling the shared substrate through the
 * PlanetSurface seam. This is the merge the migration was aiming at: the
 * tectonic/civ substrate becomes VISIBLE terrain.
 *
 * What must hold:
 *   - substrateSurface tracks the baked fields (land is up, sea is down),
 *     is CONTINUOUS across cell boundaries and face seams (the kernel
 *     cutoff contract), and is deterministic;
 *   - chunk geometry puts every vertex at radius + heightAt(dir), winds
 *     outward, and drops a proper skirt;
 *   - the LOD tree deepens under the camera, merges back when it leaves,
 *     and its host bookkeeping never leaks a mesh.
 */
import { describe, it, expect } from "vitest";
import { makeCubeSphereTopology } from "@cells/index";
import { runSphereTectonics, bakeCellAuthors } from "@shared/engine/geology/sphere-tectonics";
import { SEA_HEIGHT } from "@shared/engine/geology/tectonics";
import { substrateSurface, type PlanetSurface, type Vec3 } from "@shared/planet/surface";
import { buildChunkGeometry, PLANET_FACES } from "@shared/planet/chunk";
import { createPlanetLod, type PlanetLodHost } from "@shared/planet/lod";

const RADIUS = 10_000;
const MAX_ELEV = RADIUS * 0.005;
const UNIT = MAX_ELEV / (63 - SEA_HEIGHT);

const topo = makeCubeSphereTopology(16);
const { world } = runSphereTectonics({ topo, seed: 7, epochs: 350 });
const authors = bakeCellAuthors(world);
const height = new Float64Array(topo.n);
for (let c = 0; c < topo.n; c++) height[c] = authors.height(c);
const substrate = { topo, fields: { height } as Record<string, ArrayLike<number>> };
const surf = substrateSurface({ substrate, radius: RADIUS, seed: 3 });

const norm = (v: [number, number, number]): Vec3 => {
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
};

describe("substrate surface — the fields become terrain", () => {
  it("tracks the baked heights: land NEVER sinks, interior ocean never rises, coastal shelving bounded", () => {
    const nb: number[] = [0, 0, 0, 0];
    let landChecked = 0;
    let interiorSeaChecked = 0;
    let landViolations = 0;
    let interiorSeaViolations = 0;
    let worstShelf = 0;
    for (let c = 0; c < topo.n; c++) {
      const h = surf.heightAt(topo.pos3!(c));
      if (height[c] >= SEA_HEIGHT + 2) {
        landChecked++;
        if (h <= 0) landViolations++;
      } else if (height[c] <= SEA_HEIGHT - 2) {
        const k = topo.neighbours(c, nb);
        let coastal = false;
        for (let j = 0; j < k; j++) if (height[nb[j]] >= SEA_HEIGHT) coastal = true;
        if (coastal) {
          // A trench under a cliff wall may shelf up into a narrow beach —
          // the kernel's one accepted artifact; bounded, never a mountain.
          if (h > worstShelf) worstShelf = h;
        } else {
          interiorSeaChecked++;
          if (h >= 0) interiorSeaViolations++;
        }
      }
    }
    expect(landChecked).toBeGreaterThan(100);
    expect(interiorSeaChecked).toBeGreaterThan(100);
    expect(landViolations).toBe(0); // cities live on land — land renders as land
    expect(interiorSeaViolations).toBe(0);
    // Probed worst on this world: ~10 units under a 63-height cliff wall.
    expect(worstShelf).toBeLessThan(MAX_ELEV * 0.25);
  });

  it("stays in range and shows real relief both ways", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 5000; i++) {
      const z = 2 * ((i * 0.6180339887) % 1) - 1;
      const phi = 2 * Math.PI * ((i * 0.7548776662) % 1);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const h = surf.heightAt([r * Math.cos(phi), r * Math.sin(phi), z]);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    expect(min).toBeLessThan(-MAX_ELEV * 0.3); // ocean basins
    expect(max).toBeGreaterThan(MAX_ELEV * 0.3); // mountain country
    expect(min).toBeGreaterThanOrEqual(-MAX_ELEV * 1.3 - UNIT);
    expect(max).toBeLessThanOrEqual(MAX_ELEV + UNIT);
  });

  it("is continuous across cell boundaries and face seams (no stencil pops)", () => {
    // March a great circle that crosses many cells and 4+ cube edges at a
    // step of pitch/100; the worst legitimate slope on this world probes at
    // ~3.3 height units per step (a coast cliff) — a stencil discontinuity
    // pops a full cliff in ONE step (~70 units, the bug this pins).
    const pitch = Math.PI / 32;
    let worst = 0;
    const steps = 40_000;
    let prev = surf.heightAt(norm([Math.cos(0) * Math.cos(0.3), Math.sin(0) * Math.cos(0.3), Math.sin(0.3)]));
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const h = surf.heightAt(norm([Math.cos(t) * Math.cos(0.3), Math.sin(t) * Math.cos(0.3), Math.sin(0.3)]));
      const d = Math.abs(h - prev);
      if (d > worst) worst = d;
      prev = h;
    }
    // steps here = pitch/(2π/40000)… coarser than the probe's; bound scaled
    // generously: anything under ~15 units/step is slope, not a pop.
    expect(worst / UNIT).toBeLessThan(15);
  });

  it("is deterministic", () => {
    const again = substrateSurface({ substrate, radius: RADIUS, seed: 3 });
    for (let i = 0; i < 500; i++) {
      const z = 2 * ((i * 0.6180339887) % 1) - 1;
      const phi = 2 * Math.PI * ((i * 0.7548776662) % 1);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const dir: Vec3 = [r * Math.cos(phi), r * Math.sin(phi), z];
      expect(again.heightAt(dir)).toBe(surf.heightAt(dir));
    }
  });
});

describe("chunk geometry", () => {
  const flat: PlanetSurface = {
    radius: RADIUS,
    heightAt: () => 0,
    colorAt: (_h, _d, out) => { out[0] = 0.5; out[1] = 0.5; out[2] = 0.5; },
  };

  it("puts every main vertex at radius + heightAt(dir), skirts below", () => {
    const geo = buildChunkGeometry({ face: 4, uMin: -1, uMax: 1, vMin: -1, vMax: 1, resolution: 9, surface: flat, skirtDepth: 25 });
    const mainVerts = 9 * 9;
    for (let v = 0; v < mainVerts; v++) {
      const r = Math.hypot(geo.positions[v * 3], geo.positions[v * 3 + 1], geo.positions[v * 3 + 2]);
      expect(r).toBeCloseTo(RADIUS, 1);
    }
    const total = mainVerts + 4 * 8;
    for (let v = mainVerts; v < total; v++) {
      const r = Math.hypot(geo.positions[v * 3], geo.positions[v * 3 + 1], geo.positions[v * 3 + 2]);
      expect(r).toBeCloseTo(RADIUS - 25, 1);
    }
    // Flat-sphere normals are radial.
    for (let v = 0; v < mainVerts; v += 7) {
      const p = norm([geo.positions[v * 3], geo.positions[v * 3 + 1], geo.positions[v * 3 + 2]]);
      const dot = p[0] * geo.normals[v * 3] + p[1] * geo.normals[v * 3 + 1] + p[2] * geo.normals[v * 3 + 2];
      expect(dot).toBeGreaterThan(0.98);
    }
  });

  it("winds main triangles CCW from outside and keeps indices in range", () => {
    for (let face = 0; face < 6; face++) {
      const geo = buildChunkGeometry({ face, uMin: -1, uMax: 0, vMin: 0, vMax: 1, resolution: 5, surface: flat, skirtDepth: 10 });
      const vertCount = geo.positions.length / 3;
      for (const i of geo.indices) expect(i).toBeLessThan(vertCount);
      const mainTris = (5 - 1) * (5 - 1) * 2 * 3;
      for (let t = 0; t < mainTris; t += 3) {
        const i0 = geo.indices[t] * 3;
        const i1 = geo.indices[t + 1] * 3;
        const i2 = geo.indices[t + 2] * 3;
        const e1 = [geo.positions[i1] - geo.positions[i0], geo.positions[i1 + 1] - geo.positions[i0 + 1], geo.positions[i1 + 2] - geo.positions[i0 + 2]];
        const e2 = [geo.positions[i2] - geo.positions[i0], geo.positions[i2 + 1] - geo.positions[i0 + 1], geo.positions[i2 + 2] - geo.positions[i0 + 2]];
        const cx = e1[1] * e2[2] - e1[2] * e2[1];
        const cy = e1[2] * e2[0] - e1[0] * e2[2];
        const cz = e1[0] * e2[1] - e1[1] * e2[0];
        // Outward = away from planet center ≈ the triangle centroid direction.
        const dot = cx * geo.positions[i0] + cy * geo.positions[i0 + 1] + cz * geo.positions[i0 + 2];
        expect(dot).toBeGreaterThan(0);
      }
    }
    expect(PLANET_FACES.length).toBe(6);
  });

  it("terrain vertices follow the substrate surface exactly", () => {
    const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25 });
    for (let v = 0; v < 7 * 7; v += 5) {
      const p: [number, number, number] = [geo.positions[v * 3], geo.positions[v * 3 + 1], geo.positions[v * 3 + 2]];
      const r = Math.hypot(...p);
      const h = surf.heightAt(norm(p));
      expect(r).toBeCloseTo(RADIUS + h, 0);
    }
  });
});

describe("planet LOD", () => {
  const flat: PlanetSurface = {
    radius: RADIUS,
    heightAt: () => 0,
    colorAt: (_h, _d, out) => { out[0] = 1; out[1] = 1; out[2] = 1; },
  };

  const makeHost = () => {
    const existing = new Set<number>();
    const visible = new Set<number>();
    const host: PlanetLodHost = {
      addChunk: id => { existing.add(id); visible.add(id); },
      setChunkVisible: (id, vis) => { if (vis) visible.add(id); else visible.delete(id); },
      removeChunk: id => { existing.delete(id); visible.delete(id); },
    };
    return { host, existing, visible };
  };

  it("6 roots far away; deepens under a close camera; merges back; never leaks", () => {
    const { host, existing, visible } = makeHost();
    const lod = createPlanetLod(flat, host, { resolution: 5, maxDepth: 8 });

    lod.update([RADIUS * 10, 0, 0]);
    expect(lod.chunkCount()).toBe(6);
    expect(lod.visibleIds().length).toBe(6);

    // Hover just above the +Z face center: the tree deepens there.
    lod.update([0, 0, RADIUS * 1.02]);
    const closeCount = lod.chunkCount();
    expect(closeCount).toBeGreaterThan(6);
    expect(closeCount).toBeLessThan(400); // bounded — only under the camera
    expect(lod.visibleIds().length).toBeGreaterThan(6);
    expect(existing.size).toBe(closeCount); // host and tree agree
    for (const id of visible) expect(existing.has(id)).toBe(true);

    // Leave: everything merges back to the 6 roots, meshes disposed.
    lod.update([RADIUS * 10, 0, 0]);
    expect(lod.chunkCount()).toBe(6);
    expect(lod.visibleIds().length).toBe(6);
    expect(existing.size).toBe(6);

    lod.dispose();
    expect(existing.size).toBe(0);
  });

  it("hysteresis holds a subdivided node across small camera wobble", () => {
    const { host } = makeHost();
    const lod = createPlanetLod(flat, host, { resolution: 5, maxDepth: 6 });
    lod.update([0, 0, RADIUS * 1.05]);
    const settled = lod.chunkCount();
    // A wobble well inside the merge/subdivide dead zone changes nothing.
    lod.update([0, RADIUS * 0.001, RADIUS * 1.051]);
    expect(lod.chunkCount()).toBe(settled);
    lod.dispose();
  });
});
