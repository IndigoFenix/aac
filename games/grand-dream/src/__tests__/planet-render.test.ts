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
import { runSphereTectonics, bakeCellAuthors } from "@shared/world-engine/kernel/geology/sphere-tectonics";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";
import { substrateSurface, EARTHLIKE_PALETTE, type PlanetSurface, type Vec3 } from "@shared/world-engine/planet/surface";
import { buildChunkGeometry, PLANET_FACES, DETAIL_TILE_M } from "@shared/world-engine/planet/chunk";
import { createPlanetLod, type PlanetLodHost } from "@shared/world-engine/planet/lod";
import * as THREE from "three";
import { buildWaves } from "@shared/world-engine/planet/water-normals";
import { applyTerrainShading, WATER_SAFETY, DETAIL_COMMON_GLSL, terrainPatchFor } from "@shared/world-engine/planet/terrain-shading";
import { computeTerminatorWidth, applyToonTerminator, NIGHT_FLOOR } from "@shared/world-engine/planet/day-night";
import { tileFbm, tileNoise } from "@shared/world-engine/planet/land-noise";
import { GRASS_TILE_M, LUSH_CONTRAST, ROCK_TILE_M, SAND_TILE_M, STRATA_PERIOD_M, getStrataRamp, gritHeight, rippleHeight } from "@shared/world-engine/planet/land-textures";

/** Run a material's onBeforeCompile the way WebGLRenderer would, without a GL
 *  context — the patch is a pure string/uniform transform, so everything it
 *  decides is testable here even though the pixels aren't.
 *
 *  Fed THREE's REAL ShaderLib source, not a stub. The patch works by splicing
 *  into named `#include` chunks, so a stub listing every chunk it wants would
 *  assert nothing: it would pass just as happily if the chunk had been renamed
 *  upstream and the real splice silently no-op'd. (That is not hypothetical —
 *  toon genuinely has no roughnessmap_fragment.) Using the real source means a
 *  three upgrade that moves a chunk fails here. */
function compileStub(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const lib = (material as THREE.MeshToonMaterial).isMeshToonMaterial
    ? THREE.ShaderLib.toon
    : THREE.ShaderLib.physical;
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, null as never);
  return shader;
}

/** Assert a patch actually landed: `String.replace` with a missing needle is a
 *  silent no-op, which is how a broken patch reverts water to flat blue while
 *  every other test still passes. */
function expectPatched(src: string, marker: string): void {
  expect(src.includes(marker)).toBe(true);
}

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

  describe("metric relief bands — a real-radius world has hills on foot", () => {
    // Same substrate, Earth radius and relief: the cube cells span ~625 km,
    // so ALL the angle-scaled wavelengths are tens of km — before the metric
    // bands, a 30 km walk measured near-zero height change (the user-visible
    // "earthlike planets are flat, airless moons are dramatic" asymmetry:
    // wavelengths scale with radius, relief does not).
    const R_EARTH = 6_370_000;
    const MAX_E = R_EARTH * 0.0015;
    const real = substrateSurface({
      substrate, radius: R_EARTH, maxElevation: MAX_E, seed: 3,
    });

    /** Max−min elevation over a ~30 km walk around `dir` (tangent arc). */
    const walkRelief = (surface: PlanetSurface, dir: Vec3, radius: number): number => {
      // Tangent axis (any perpendicular).
      const t: [number, number, number] = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const e: [number, number, number] = [
        t[1] * dir[2] - t[2] * dir[1],
        t[2] * dir[0] - t[0] * dir[2],
        t[0] * dir[1] - t[1] * dir[0],
      ];
      const el = Math.hypot(e[0], e[1], e[2]);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = -100; i <= 100; i++) {
        const s = (i / 100) * (15_000 / radius); // ±15 km in radians
        const d = norm([
          dir[0] + (e[0] / el) * s,
          dir[1] + (e[1] / el) * s,
          dir[2] + (e[2] / el) * s,
        ]);
        const h = surface.heightAt(d);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      return hi - lo;
    };

    // A solid inland cell (max height in a land region) — bands act on land.
    let inland = 0;
    for (let c = 0; c < topo.n; c++) if (height[c] > height[inland]) inland = c;

    it("a 30 km walk crosses real hills at Earth radius", () => {
      const dir = topo.pos3!(inland);
      // The bands are live (λ ≪ cellArc/3 ≈ 208 km) — tens of metres of
      // local relief where the smooth substrate is nearly constant.
      expect(walkRelief(real, dir, R_EARTH)).toBeGreaterThan(15);
    });

    it("the bands gate OFF below cell scale — small worlds keep their look", () => {
      // At toy radius every band λ exceeds cellArc/3, so the only detail is
      // the angular channel: the default surface may differ from a detail-0
      // surface by AT MOST detailAmp (0.6 × UNIT). Live bands would triple it.
      const bald = substrateSurface({ substrate, radius: RADIUS, seed: 3, detail: 0 });
      for (let i = 0; i < 500; i++) {
        const z = 2 * ((i * 0.6180339887) % 1) - 1;
        const phi = 2 * Math.PI * ((i * 0.7548776662) % 1);
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const dir: Vec3 = [r * Math.cos(phi), r * Math.sin(phi), z];
        expect(Math.abs(surf.heightAt(dir) - bald.heightAt(dir))).toBeLessThanOrEqual(UNIT * 0.6 + 1e-9);
      }
    });

    it("land still never sinks under the bands", () => {
      let checked = 0;
      for (let c = 0; c < topo.n; c++) {
        if (height[c] < SEA_HEIGHT + 2) continue;
        const p = topo.pos3!(c);
        expect(real.heightAt(p)).toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
    });

    it("stays deterministic with the bands live", () => {
      const again = substrateSurface({
        substrate, radius: R_EARTH, maxElevation: MAX_E, seed: 3,
      });
      for (let i = 0; i < 200; i++) {
        const z = 2 * ((i * 0.6180339887) % 1) - 1;
        const phi = 2 * Math.PI * ((i * 0.7548776662) % 1);
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const dir: Vec3 = [r * Math.cos(phi), r * Math.sin(phi), z];
        expect(again.heightAt(dir)).toBe(real.heightAt(dir));
      }
    });
  });
});

describe("chunk geometry", () => {
  const flat: PlanetSurface = {
    radius: RADIUS,
    heightAt: () => 0,
    colorAt: (_h, _d, out) => { out[0] = 0.5; out[1] = 0.5; out[2] = 0.5; },
  };

  // Positions are CENTER-RELATIVE (float32 planet-local at Earth radius
  // quantizes to ~0.5 m — the random ground-ripple bug); planet-local =
  // positions + geo.center, and the render adapter puts the mesh AT center.
  const absAt = (geo: { positions: Float32Array; center: readonly [number, number, number] }, v: number): [number, number, number] => [
    geo.positions[v * 3] + geo.center[0],
    geo.positions[v * 3 + 1] + geo.center[1],
    geo.positions[v * 3 + 2] + geo.center[2],
  ];

  it("puts every main vertex at radius + heightAt(dir), skirts below", () => {
    const geo = buildChunkGeometry({ face: 4, uMin: -1, uMax: 1, vMin: -1, vMax: 1, resolution: 9, surface: flat, skirtDepth: 25 });
    const mainVerts = 9 * 9;
    for (let v = 0; v < mainVerts; v++) {
      const r = Math.hypot(...absAt(geo, v));
      expect(r).toBeCloseTo(RADIUS, 1);
    }
    const total = mainVerts + 4 * 8;
    for (let v = mainVerts; v < total; v++) {
      const r = Math.hypot(...absAt(geo, v));
      expect(r).toBeCloseTo(RADIUS - 25, 1);
    }
    // Flat-sphere normals are radial.
    for (let v = 0; v < mainVerts; v += 7) {
      const p = norm(absAt(geo, v));
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
        // Edges are translation-invariant (center-relative = planet-local).
        const e1 = [geo.positions[i1] - geo.positions[i0], geo.positions[i1 + 1] - geo.positions[i0 + 1], geo.positions[i1 + 2] - geo.positions[i0 + 2]];
        const e2 = [geo.positions[i2] - geo.positions[i0], geo.positions[i2 + 1] - geo.positions[i0 + 1], geo.positions[i2 + 2] - geo.positions[i0 + 2]];
        const cx = e1[1] * e2[2] - e1[2] * e2[1];
        const cy = e1[2] * e2[0] - e1[0] * e2[2];
        const cz = e1[0] * e2[1] - e1[1] * e2[0];
        // Outward = away from planet center ≈ the triangle's PLANET-LOCAL
        // direction (add the chunk center back).
        const p0 = absAt(geo, geo.indices[t]);
        const dot = cx * p0[0] + cy * p0[1] + cz * p0[2];
        expect(dot).toBeGreaterThan(0);
      }
    }
    expect(PLANET_FACES.length).toBe(6);
  });

  it("terrain vertices follow the substrate surface exactly", () => {
    const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25 });
    for (let v = 0; v < 7 * 7; v += 5) {
      const p = absAt(geo, v);
      const r = Math.hypot(...p);
      const h = surf.heightAt(norm(p));
      expect(r).toBeCloseTo(RADIUS + h, 0);
    }
  });

  // The water attribute and detailUv feed the material patch in terrain-shading.ts.
  // Nothing here can see the shading itself — these pin the geometry contract
  // it rests on, which is what a refactor would break silently.
  describe("water attribute", () => {
    it("flags exactly the sea-clamped vertices, and only under seaClamp", () => {
      const p = { face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25 };
      const wet = buildChunkGeometry({ ...p, seaClamp: true });
      let sawWater = 0;
      let sawLand = 0;
      for (let v = 0; v < 7 * 7; v++) {
        const dir = norm(absAt(wet, v));
        const submerged = surf.heightAt(dir) < 0;
        expect(wet.water[v]).toBe(submerged ? 1 : 0);
        if (submerged) sawWater++; else sawLand++;
      }
      // A test that only ever saw land would pass vacuously.
      expect(sawWater).toBeGreaterThan(0);
      expect(sawLand).toBeGreaterThan(0);

      // Dry worlds have no water vertices to shade.
      const dry = buildChunkGeometry({ ...p, seaClamp: false });
      expect(dry.water.some((w) => w !== 0)).toBe(false);
    });

    it("flags water on the flat sea surface, not the seabed below it", () => {
      const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25, seaClamp: true });
      for (let v = 0; v < 7 * 7; v++) {
        if (geo.water[v] !== 1) continue;
        // Clamped UP to exactly sea level — that flat surface is what shades.
        expect(Math.hypot(...absAt(geo, v))).toBeCloseTo(RADIUS, 0);
      }
    });

    it("carries water and detailUv onto the skirt ring, like colors and normals", () => {
      const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25, seaClamp: true });
      const mainVerts = 7 * 7;
      const total = geo.positions.length / 3;
      expect(geo.water.length).toBe(total);
      expect(geo.detailUv.length).toBe(total * 2);
      // Skirt walls hide LOD cracks; a wall that shaded as land under water
      // would draw a dry seam right where the crack already is.
      for (let v = mainVerts; v < total; v++) {
        expect(geo.water[v] === 0 || geo.water[v] === 1).toBe(true);
      }
      expect(Array.from(geo.water.slice(mainVerts)).some((w) => w === 1)).toBe(true);
    });
  });

  describe("wave coord", () => {
    // The whole design: detailUv is wrapped by a WHOLE number of tiles per chunk,
    // so it stays float32-small while the pattern still lines up across chunks
    // and across LOD depths. Both halves are load-bearing.
    it("stays chunk-sized — never a raw planet-scale metre coord", () => {
      const geo = buildChunkGeometry({ face: 2, uMin: 0.5, uMax: 0.75, vMin: 0.5, vMax: 0.75, resolution: 9, surface: surf, skirtDepth: 25, seaClamp: true });
      const span = 0.25 * RADIUS;
      for (let i = 0; i < geo.detailUv.length; i++) {
        // Residual = chunk span + at most one tile of wrap slack.
        expect(Math.abs(geo.detailUv[i])).toBeLessThan(span + DETAIL_TILE_M * 2);
      }
    });

    it("agrees across LOD depths, modulo the tile — this is what stops seams", () => {
      const base = { face: 2, resolution: 9, surface: surf, skirtDepth: 25, seaClamp: true };
      // Chunks with DIFFERENT origins that meet at a shared planet point: the
      // coarse chunk's midpoint (u,v = 0.625) is the fine chunk's (uMin,vMin)
      // corner. Comparing two chunks with the same uMin would compare identical
      // origins and pass however broken the wrapping was.
      const coarse = buildChunkGeometry({ ...base, uMin: 0.5, uMax: 0.75, vMin: 0.5, vMax: 0.75 });
      const fine = buildChunkGeometry({ ...base, uMin: 0.625, uMax: 0.75, vMin: 0.625, vMax: 0.75 });
      // Coarse (i=4, j=4) of a 9×9 over 0.5..0.75 sits at u=v=0.625 — the same
      // planet point as fine's vertex 0.
      const cOff = (4 * 9 + 4) * 2;
      const dS = coarse.detailUv[cOff] - fine.detailUv[0];
      const dT = coarse.detailUv[cOff + 1] - fine.detailUv[1];
      // Guard the guard: if the origins agreed, this would prove nothing.
      expect(Math.abs(dS)).toBeGreaterThan(DETAIL_TILE_M);
      for (const d of [dS, dT]) {
        const offBy = Math.abs(d / DETAIL_TILE_M - Math.round(d / DETAIL_TILE_M));
        expect(offBy).toBeLessThan(1e-3);
      }
    });

    it("advances with real distance, so waves are a fixed size in metres", () => {
      const geo = buildChunkGeometry({ face: 2, uMin: 0, uMax: 0.25, vMin: 0, vMax: 0.25, resolution: 9, surface: surf, skirtDepth: 25, seaClamp: true });
      // Adjacent columns: one grid step apart in u. Near the face centre the
      // cube-face coord is close to arc length, so the wave coord should step
      // by roughly the real ground distance — not by a unit-cube fraction.
      const stepMetres = (0.25 / 8) * RADIUS;
      const dS = geo.detailUv[1 * 2] - geo.detailUv[0];
      expect(dS).toBeCloseTo(stepMetres, 0);
    });
  });
});

// The shading itself needs a GL context and can't be seen here. These pin the
// properties underneath it that are invisible until someone looks at a sunlit
// sea from a moving camera — i.e. the ones that regress silently.
describe("water shading", () => {
  describe("seizure safety", () => {
    // This platform serves children with Rett's Syndrome. A tight specular lobe
    // dragged around by animated normals is luminance flicker — the classic
    // photosensitive trigger. These bounds are ENFORCED, so this suite is the
    // thing that notices if someone relaxes them to make the sea pop.
    it("ships defaults inside the safe envelope", () => {
      // Defaults flow through the same clamp as caller opts, so patching with
      // no options must land in-envelope.
      expect(WATER_SAFETY.minRoughness).toBeGreaterThanOrEqual(0.35);
      expect(WATER_SAFETY.maxMetalness).toBeLessThanOrEqual(0.15);
      expect(WATER_SAFETY.maxWaveStrength).toBeLessThanOrEqual(1);
    });

    it("clamps a caller trying to make water shiny", () => {
      // The mirror settings from this file's first cut: roughness 0.12 /
      // metalness 0.25. They must not survive.
      const mat = new THREE.MeshStandardMaterial();
      applyTerrainShading(mat, { water: { roughness: 0.12, metalness: 0.25, waveStrength: 9 } });
      const shader = compileStub(mat);
      expect(shader.uniforms.uWaterRoughness.value).toBe(WATER_SAFETY.minRoughness);
      expect(shader.uniforms.uWaterMetalness.value).toBe(WATER_SAFETY.maxMetalness);
      expect(shader.uniforms.uWaveStrength.value).toBe(WATER_SAFETY.maxWaveStrength);
    });
  });

  describe("mode routing", () => {
    it("patches standard and toon differently, and leaves neither flat", () => {
      expect(terrainPatchFor("standard")).toBe("standard");
      expect(terrainPatchFor("toon")).toBe("toon");

      // Toon must NOT get the normal-perturbation patch: against a 4-step
      // nearest ramp it drags contour lines across the water instead of
      // rippling light. It gets foam bands cut from the height channel.
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, {});
      const stdShader = compileStub(std);
      const stdSrc = stdShader.fragmentShader;
      expect(stdSrc).toContain("waveNormal");
      expect(stdSrc).not.toContain("foamBands");
      // The DECLARATION existing proves nothing — it rides in on the <common>
      // splice. These prove the call sites landed in the real shader.
      expectPatched(stdSrc, "normal = normalize(T * dn.x");
      expectPatched(stdSrc, "roughnessFactor = mix(roughnessFactor, uWaterRoughness");
      expectPatched(stdSrc, "metalnessFactor = mix(metalnessFactor, uWaterMetalness");
      expectPatched(stdShader.vertexShader, "vDetailUv = detailUv;");

      const toon = new THREE.MeshToonMaterial();
      applyTerrainShading(toon, {});
      const toonShader = compileStub(toon);
      const toonSrc = toonShader.fragmentShader;
      expect(toonSrc).toContain("foamBands");
      expect(toonSrc).not.toContain("waveNormal");
      expectPatched(toonSrc, "mix(diffuseColor.rgb, uFoamColor");
      expectPatched(toonShader.vertexShader, "vDetailUv = detailUv;");
      // Toon has no roughnessmap/metalnessmap chunk to splice into — which is
      // exactly why it needs its own patch rather than a shared one.
      expect(toonSrc).not.toContain("uWaterRoughness");
    });

    it("gives the two modes distinct program cache keys", () => {
      // A shared key hands one mode the other's compiled program.
      const std = new THREE.MeshStandardMaterial();
      const toon = new THREE.MeshToonMaterial();
      applyTerrainShading(std, {});
      applyTerrainShading(toon, {});
      expect(std.customProgramCacheKey!()).not.toBe(toon.customProgramCacheKey!());
    });
  });

  describe("tiling", () => {
    // chunk.ts wraps detailUv by whole tiles; that is invisible ONLY if every
    // layer repeats with a period dividing the offset. A fractional scale (2.7
    // is the tempting one — it looks irregular) seams every chunk border.
    it("transforms layer B by an INTEGER matrix", () => {
      const m = DETAIL_COMMON_GLSL.match(/mat2\(([^)]*)\)/);
      expect(m).not.toBeNull();
      const entries = m![1].split(",").map((s) => Number(s.trim()));
      expect(entries).toHaveLength(4);
      for (const e of entries) {
        expect(Number.isFinite(e)).toBe(true);
        expect(Number.isInteger(e)).toBe(true);
      }
      // A singular transform would collapse layer B to a line.
      const [a, b, c, d] = entries;
      expect(a * d - b * c).not.toBe(0);
    });

    it("uses only integer wave frequencies", () => {
      for (const w of buildWaves()) {
        expect(Number.isInteger(w.kx)).toBe(true);
        expect(Number.isInteger(w.ky)).toBe(true);
        expect(w.kx === 0 && w.ky === 0).toBe(false);
      }
    });
  });

  describe("wave field is not a grid", () => {
    // "The ripples are kind of square, lots of right angles" — a small set of
    // waves all cresting at the origin sums to a lattice of square cells.
    const waves = buildWaves();

    it("has enough waves to stop reading as interference", () => {
      expect(waves.length).toBeGreaterThanOrEqual(16);
    });

    it("spreads phases instead of cresting everything at the origin", () => {
      // All-zero phases put every wave's peak at (0,0) — that alignment IS the
      // grid, whatever the directions do.
      const phases = waves.map((w) => w.phase);
      expect(new Set(phases.map((p) => p.toFixed(3))).size).toBeGreaterThan(waves.length * 0.8);
      const spread = Math.max(...phases) - Math.min(...phases);
      expect(spread).toBeGreaterThan(Math.PI);
    });

    it("has no duplicated or parallel directions", () => {
      const dirs = waves.map((w) => `${w.kx},${w.ky}`);
      expect(new Set(dirs).size).toBe(waves.length);
      // Parallel pairs act as one louder wave — the alignment being avoided.
      for (let i = 0; i < waves.length; i++) {
        for (let j = i + 1; j < waves.length; j++) {
          const cross = waves[i].kx * waves[j].ky - waves[i].ky * waves[j].kx;
          expect(cross).not.toBe(0);
        }
      }
    });

    it("avoids the near-perpendicular pairs that draw the right angles", () => {
      // Two waves ~90° apart weave a plaid. Some perpendicularity is
      // unavoidable across 180° of spread; a PILE of it is the bug.
      let square = 0;
      for (let i = 0; i < waves.length; i++) {
        for (let j = i + 1; j < waves.length; j++) {
          const a = waves[i];
          const b = waves[j];
          const cos = (a.kx * b.kx + a.ky * b.ky) / (Math.hypot(a.kx, a.ky) * Math.hypot(b.kx, b.ky));
          if (Math.abs(cos) < 0.08) square++;
        }
      }
      const pairs = (waves.length * (waves.length - 1)) / 2;
      expect(square / pairs).toBeLessThan(0.1);
    });

    it("uses no axis-aligned or 45° waves at all", () => {
      // The lattice's symmetry directions. Rounding pulls toward them, they
      // pair up perpendicular with each other, and they are precisely what
      // reads as square — so they're refused outright rather than rationed.
      for (const w of waves) {
        expect(w.kx === 0 || w.ky === 0).toBe(false);
        expect(Math.abs(w.kx)).not.toBe(Math.abs(w.ky));
      }
    });

    it("keeps perpendicular ENERGY low — weighted, since the long waves carry the look", () => {
      // Amplitude goes as 1/|k|, so an unweighted pair count hides a plaid
      // built from the two strongest waves — the state this field was in when
      // it looked square.
      //
      // Note what this does NOT assert: that no strong pair is perpendicular.
      // Spread N directions over 180° and near-perpendicular pairs are
      // unavoidable (six waves ~30° apart WILL contain a ~90° pair) — an
      // earlier version of this test demanded that and was simply impossible.
      // What's achievable, and what actually reads, is that little of the
      // field's energy sits in such pairs.
      let perp = 0;
      let total = 0;
      for (let i = 0; i < waves.length; i++) {
        for (let j = i + 1; j < waves.length; j++) {
          const a = waves[i];
          const b = waves[j];
          const cos = (a.kx * b.kx + a.ky * b.ky) / (Math.hypot(a.kx, a.ky) * Math.hypot(b.kx, b.ky));
          const energy = a.amp * b.amp;
          total += energy;
          if (Math.abs(cos) < 0.08) perp += energy;
        }
      }
      expect(perp / total).toBeLessThan(0.12);
    });

    it("keeps the longest wave a plausible size in metres", () => {
      // BASE_FREQ and DETAIL_TILE_M trade against each other; moving one alone
      // silently resizes every wave. Swell should read as swell, not ripples.
      const longest = DETAIL_TILE_M / Math.min(...waves.map((w) => Math.hypot(w.kx, w.ky)));
      expect(longest).toBeGreaterThan(6);
      expect(longest).toBeLessThan(30);
    });
  });
});

// Land detail (grass). Like water, the pixels aren't visible here — these pin
// the contracts underneath that regress SILENTLY: a seam law, a colour/material
// agreement, and the toon divergence.
describe("land detail", () => {
  // The shared `substrate` carries no fertility field, so its land is entirely
  // barren — grass weight would be zero everywhere and every assertion below
  // would pass without grass ever existing. This one has fertility, spread so
  // that some cells are lush and some are dust.
  const fertile = {
    topo,
    fields: {
      height,
      fertility: Float64Array.from({ length: topo.n }, (_, c) => c % 7),
    } as Record<string, ArrayLike<number>>,
  };
  const surf = substrateSurface({ substrate: fertile, radius: RADIUS, seed: 4 });

  describe("seam law", () => {
    // chunk.ts offsets detailUv by whole DETAIL_TILE_M. A texture only survives
    // that offset if its own tile divides it — otherwise the offset lands
    // mid-pattern and every chunk border becomes a hard seam. This is the one
    // rule a new land material is most likely to break, because a tile of, say,
    // 10 m looks perfectly fine until you cross a chunk.
    it("tiles grass at a size dividing the detail wrap — both sampling scales", () => {
      expect(DETAIL_TILE_M % GRASS_TILE_M).toBe(0);
      // Layer B samples at 4× the tile (terrain-shading.ts) — it has to divide too.
      expect(DETAIL_TILE_M % (GRASS_TILE_M * 4)).toBe(0);
    });

    it("tiles sand at a size dividing the detail wrap — both sampling scales", () => {
      expect(DETAIL_TILE_M % SAND_TILE_M).toBe(0);
      // Sand's layer B is 8× (terrain-shading.ts). The multiplied scale is the
      // easy half of this rule to forget, and it seams just as hard.
      expect(DETAIL_TILE_M % (SAND_TILE_M * 8)).toBe(0);
    });

    it("wraps the noise lattice, so the pattern meets itself", () => {
      // u=1 must BE u=0: the lattice is taken modulo freq.
      for (const f of [4, 8, 32]) {
        expect(tileNoise(1, 0.3, f, 7)).toBeCloseTo(tileNoise(0, 0.3, f, 7), 12);
        expect(tileNoise(0.3, 1, f, 7)).toBeCloseTo(tileNoise(0.3, 0, f, 7), 12);
      }
      // Continuity, not just equality at the endpoint: a broken modulo can still
      // land on the right value at exactly 1.0 while jumping just before it.
      const near = tileFbm(1 - 1e-4, 0.3, 4, 3, 11);
      expect(near).toBeCloseTo(tileFbm(0, 0.3, 4, 3, 11), 2);
    });

    it("expands lushness enough that the tint ramp uses its whole range", () => {
      // The shader reads 0.6*A + 0.4*B, and averaging two samples of a
      // distribution NARROWS it — measured: the baked field spans 0.23..0.79
      // over its middle 90%, the blend only 0.30..0.71, with 56% of ground in
      // the middle fifth. Left uncorrected the ramp uses its middle only and
      // every meadow is the same mid-green. This asserts LUSH_CONTRAST is
      // actually big enough to undo that, against the real blend arithmetic.
      const field = Float64Array.from({ length: 4096 }, (_, i) =>
        tileFbm((i % 64) / 64, Math.floor(i / 64) / 64, 4, 3, 11) * 0.65
        + tileFbm((i % 64) / 64, Math.floor(i / 64) / 64, 32, 2, 27) * 0.35);
      const lo = Math.min(...field);
      const span = Math.max(...field) - lo;
      const norm = Array.from(field, (v) => (v - lo) / span);
      // Blend two decorrelated samples, as the two sampling scales do.
      const blended = norm.map((v, i) => v * 0.6 + norm[(i * 37 + 11) % norm.length] * 0.4);
      const expand = (t: number): number => {
        const c = Math.min(1, Math.max(0, (t - 0.5) * LUSH_CONTRAST + 0.5));
        return c * c * (3 - 2 * c);
      };
      const out = blended.map(expand).sort((a, b) => a - b);
      const p05 = out[Math.floor(out.length * 0.05)];
      const p95 = out[Math.floor(out.length * 0.95)];
      // Guard the guard: the raw blend fails this, so the assertion has teeth.
      const raw = blended.slice().sort((a, b) => a - b);
      expect(raw[Math.floor(raw.length * 0.95)] - raw[Math.floor(raw.length * 0.05)]).toBeLessThan(0.6);
      expect(p95 - p05).toBeGreaterThan(0.6);
    });

    it("produces a field with real variation, not a constant", () => {
      // A hash that overflows int32 (plain `*` instead of Math.imul) still
      // returns numbers — it returns nearly the SAME number everywhere, which
      // reads as flat ground rather than as an error.
      const vals = [];
      for (let i = 0; i < 64; i++) vals.push(tileFbm(i / 64, (i * 7 % 64) / 64, 4, 3, 11));
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      expect(max - min).toBeGreaterThan(0.2);
    });
  });

  describe("material weights", () => {
    it("agrees with colorAt about where grass is", () => {
      // The stated contract in surface.ts: these weights say "draw grass here"
      // and colorAt says "be green here". If they drift apart the texture runs
      // past the colour it belongs to, which looks like a bug in the texture.
      const rgb: [number, number, number] = [0, 0, 0];
      const mat: [number, number, number] = [0, 0, 0];
      let sawGrass = 0;
      let sawWater = 0;
      for (let i = 0; i < 400; i++) {
        const a = (i / 400) * Math.PI * 2;
        const b = ((i * 13) % 400 / 400) * Math.PI;
        const dir: Vec3 = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
        const h = surf.heightAt(dir);
        surf.colorAt(h, dir, rgb);
        surf.materialAt!(h, dir, mat);
        if (h <= 0) {
          // Water/seabed belongs to the water pass; land detail must not touch it.
          expect(mat[0] + mat[1] + mat[2]).toBe(0);
          sawWater++;
        }
        if (mat[1] > 0.5) {
          // Where grass dominates, the colour must actually be green-dominant.
          expect(rgb[1]).toBeGreaterThan(rgb[2]);
          sawGrass++;
        }
      }
      // Neither branch may pass vacuously.
      expect(sawGrass).toBeGreaterThan(0);
      expect(sawWater).toBeGreaterThan(0);
    });

    it("never asks for more material than exists", () => {
      const mat: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < 300; i++) {
        const a = (i / 300) * Math.PI * 2;
        const dir: Vec3 = [Math.cos(a), 0.3, Math.sin(a)];
        const n = Math.hypot(...dir);
        const d: Vec3 = [dir[0] / n, dir[1] / n, dir[2] / n];
        surf.materialAt!(surf.heightAt(d), d, mat);
        for (const w of mat) {
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(1);
        }
        // Weights blend between materials; they must not stack into double-drawn
        // detail where two bands overlap.
        expect(mat[0] + mat[1] + mat[2]).toBeLessThanOrEqual(1 + 1e-9);
      }
    });

    it("rides onto the skirt ring, like colors and normals", () => {
      const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25, seaClamp: true });
      const total = geo.positions.length / 3;
      expect(geo.terrain.length).toBe(total * 3);
      // A skirt wall that shaded as bare rock under grass draws a dry seam right
      // where the LOD crack it exists to hide already is.
      expect(Array.from(geo.terrain.slice(7 * 7 * 3)).some((w) => w > 0)).toBe(true);
    });

    it("gives a surface without materialAt all-zero weights, not a crash", () => {
      // Absence is a real answer (surface.ts): a foreign PlanetSurface predating
      // materialAt must still render, as the flat vertex colour it always was.
      const bare: PlanetSurface = {
        radius: RADIUS,
        heightAt: () => 100,
        colorAt: (_h, _d, out) => { out[0] = 1; out[1] = 1; out[2] = 1; },
      };
      const geo = buildChunkGeometry({ face: 0, uMin: 0, uMax: 0.5, vMin: 0, vMax: 0.5, resolution: 5, surface: bare, skirtDepth: 10 });
      expect(geo.terrain.some((w) => w !== 0)).toBe(false);
    });
  });

  // The sand grain regime: fine sorted sand vs raw grit, driven off local
  // relief. The user's own worry about this was that it isn't testable because
  // sediment isn't in the physics — it is, because relief IS, and these are the
  // assertions that make the proxy honest rather than decorative.
  describe("sand grain regime", () => {
    const grainAt = (dir: Vec3): number => {
      const reg: [number, number, number] = [0, 0, 0];
      surf.regimeAt!(surf.heightAt(dir), dir, reg);
      return reg[0];
    };
    // Cell-level ruggedness, the signal regimeAt is supposed to be reading.
    const cellRelief = (c: number): number => {
      const nb: number[] = new Array(topo.maxDegree).fill(0);
      const k = topo.neighbours(c, nb);
      let sum = 0;
      for (let j = 0; j < k; j++) sum += Math.abs(height[c] - height[nb[j]]);
      return k > 0 ? sum / k : 0;
    };

    it("makes rugged country coarser than flat country", () => {
      // THE claim: sediment calibre tracks relief. Compare the flattest land
      // cells against the most rugged ones and the grain must follow.
      const land: number[] = [];
      for (let c = 0; c < topo.n; c++) if (height[c] >= SEA_HEIGHT) land.push(c);
      land.sort((a, b) => cellRelief(a) - cellRelief(b));
      const flat = land.slice(0, 60);
      const rugged = land.slice(-60);
      const mean = (cells: number[]) =>
        cells.reduce((s, c) => s + grainAt(topo.pos3!(c)), 0) / cells.length;
      const flatGrain = mean(flat);
      const ruggedGrain = mean(rugged);
      expect(ruggedGrain).toBeGreaterThan(flatGrain);
      // And by a real margin, not noise — the local stand-in must not drown the
      // physical signal it decorates.
      expect(ruggedGrain - flatGrain).toBeGreaterThan(0.3);
    });

    it("uses the whole fine..coarse range on real terrain", () => {
      // A regime pinned at one end renders as if it didn't exist. The default
      // thresholds were measured against this substrate's relief distribution
      // precisely because a plausible-looking guess (1..6) put 90% of all land
      // at fully coarse.
      const grains: number[] = [];
      for (let c = 0; c < topo.n; c++) {
        if (height[c] >= SEA_HEIGHT) grains.push(grainAt(topo.pos3!(c)));
      }
      expect(grains.filter((g) => g < 0.25).length / grains.length).toBeGreaterThan(0.1);
      expect(grains.filter((g) => g > 0.75).length / grains.length).toBeGreaterThan(0.1);
    });

    it("stays in 0..1 and is deterministic", () => {
      const again = substrateSurface({ substrate: fertile, radius: RADIUS, seed: 4 });
      const reg: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < 200; i++) {
        const z = 2 * ((i * 0.6180339887) % 1) - 1;
        const phi = 2 * Math.PI * ((i * 0.7548776662) % 1);
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const dir: Vec3 = [r * Math.cos(phi), r * Math.sin(phi), z];
        const g = grainAt(dir);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
        again.regimeAt!(again.heightAt(dir), dir, reg);
        expect(reg[0]).toBe(g);
      }
    });

    it("rides onto the chunk attribute and the skirt ring", () => {
      const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 7, surface: surf, skirtDepth: 25, seaClamp: true });
      const total = geo.positions.length / 3;
      expect(geo.regime.length).toBe(total * 3);
      expect(Array.from(geo.regime.slice(7 * 7 * 3)).some((w) => w > 0)).toBe(true);
      // Only the sand slot is live; grass and rock have no regime yet, and a
      // stray value there would silently become someone's shape parameter.
      for (let v = 0; v < total; v++) {
        expect(geo.regime[v * 3 + 1]).toBe(0);
        expect(geo.regime[v * 3 + 2]).toBe(0);
      }
    });

    it("gives a surface without regimeAt all-zero grain, not a crash", () => {
      const bare: PlanetSurface = {
        radius: RADIUS,
        heightAt: () => 100,
        colorAt: (_h, _d, out) => { out[0] = 1; out[1] = 1; out[2] = 1; },
      };
      const geo = buildChunkGeometry({ face: 0, uMin: 0, uMax: 0.5, vMin: 0, vMax: 0.5, resolution: 5, surface: bare, skirtDepth: 10 });
      expect(geo.regime.some((w) => w !== 0)).toBe(false);
    });
  });

  describe("sand pattern", () => {
    /** Structure-tensor anisotropy of a height field over its tile: 0 = no
     *  preferred direction, 1 = perfectly ruled lines. */
    const anisotropy = (f: (u: number, v: number) => number): number => {
      const N = 128;
      const h = (x: number, y: number) => f(((x % N) + N) % N / N, ((y % N) + N) % N / N);
      let xx = 0;
      let yy = 0;
      let xy = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const gx = (h(x + 1, y) - h(x - 1, y)) * 0.5;
          const gy = (h(x, y + 1) - h(x, y - 1)) * 0.5;
          xx += gx * gx; yy += gy * gy; xy += gx * gy;
        }
      }
      // Eigenvalues of [[xx, xy], [xy, yy]].
      const tr = xx + yy;
      const d = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
      return tr > 0 ? d / tr : 0;
    };

    it("makes ripples directional and grit not — that IS the regime", () => {
      // The wave field's hard-won lesson, INVERTED. Water spreads its
      // directions by the golden angle specifically to avoid a grid; sand
      // ripples are unidirectional by nature, and a second non-parallel ripple
      // set would draw the same plaid on the beach. Grit is the opposite: wind
      // can't sort it, so it must have no direction at all. If these two ever
      // converge the grain regime stops meaning anything, because both ends
      // render as the same ground.
      const ripple = anisotropy(rippleHeight);
      const grit = anisotropy(gritHeight);
      expect(ripple).toBeGreaterThan(0.6);
      expect(grit).toBeLessThan(0.2);
    });

    it("tiles the warped ripple — the warp must not break the wrap", () => {
      // The phase warp is what stops the ripples being ruled lines. It's also
      // the one part that could silently desynchronise the tile.
      for (const v of [0, 0.31, 0.77]) {
        expect(rippleHeight(1, v)).toBeCloseTo(rippleHeight(0, v), 10);
        expect(rippleHeight(v, 1)).toBeCloseTo(rippleHeight(v, 0), 10);
      }
    });
  });

  // Rock is the only material that projects triplanar, and the only one whose
  // presence depends on the rivers. Both are things a still screenshot would
  // hide until someone flew into a canyon.
  describe("rock — triplanar + strata", () => {
    it("carries a triplanar frame that tracks how vertical the ground is", () => {
      // triN is the normal in the (uHat, vHat, radial) frame. Its radial
      // component is what the shader weights the flat-ground projection by, so
      // if this is wrong the texture smears on cliffs exactly as it did before
      // triplanar existed — and nothing else would notice.
      const geo = buildChunkGeometry({ face: 2, uMin: -0.5, uMax: 0.5, vMin: -0.5, vMax: 0.5, resolution: 9, surface: surf, skirtDepth: 25, seaClamp: true });
      const total = geo.positions.length / 3;
      expect(geo.triN.length).toBe(total * 3);
      let flattest = 0;
      for (let v = 0; v < 9 * 9; v++) {
        const t: Vec3 = [geo.triN[v * 3], geo.triN[v * 3 + 1], geo.triN[v * 3 + 2]];
        // It's a rotation of a unit normal into an (almost) orthonormal frame.
        expect(Math.hypot(...t)).toBeCloseTo(1, 1);
        // Terrain normals point OUT, never into the planet.
        expect(t[2]).toBeGreaterThan(0);
        flattest = Math.max(flattest, t[2]);
      }
      // Flat ground must actually read as flat — a frame that never reaches
      // ~1 on the radial axis would mean uHat/vHat aren't tangent at all.
      expect(flattest).toBeGreaterThan(0.99);
    });

    it("puts the strata axis on ABSOLUTE elevation, unwrapped", () => {
      // Strata are surfaces of constant elevation. detailUv is wrapped by whole
      // tiles for precision; detailW must NOT be, or every chunk border would
      // step the layers. It doesn't need to be: elevation is bounded by relief.
      const geo = buildChunkGeometry({ face: 2, uMin: 0.5, uMax: 0.75, vMin: 0.5, vMax: 0.75, resolution: 9, surface: surf, skirtDepth: 25, seaClamp: true });
      for (let v = 0; v < 9 * 9; v++) {
        const dir = norm([
          geo.positions[v * 3] + geo.center[0],
          geo.positions[v * 3 + 1] + geo.center[1],
          geo.positions[v * 3 + 2] + geo.center[2],
        ]);
        const h = surf.heightAt(dir);
        // Sea-clamped vertices render AT sea level, so their strata axis is 0 —
        // the elevation you can see, not the seabed underneath.
        expect(geo.detailW[v]).toBeCloseTo(geo.water[v] > 0.5 ? 0 : h, 0);
      }
    });

    it("samples rock on three planes, two of them keyed to elevation", () => {
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, {});
      const shader = compileStub(std);
      const src = shader.fragmentShader;
      expectPatched(src, "rockTint(rockSample(triWeights()))");
      // The wall planes pair a horizontal axis with ELEVATION — that pairing IS
      // triplanar. Sampling all three at vDetailUv would compile and smear.
      expect(src).toContain("vec2(vDetailUv.y, vDetailW)");
      expect(src).toContain("vec2(vDetailUv.x, vDetailW)");
      expectPatched(shader.vertexShader, "vTriN = triN;");
      expect(shader.uniforms.uStrataPeriod).toBeDefined();
    });

    it("fades rock's normal out on the faces where its tangent frame dies", () => {
      // The frame is reconstructed from screen-space derivatives of detailUv,
      // which degenerate on near-vertical ground — precisely where rock lives.
      // The fix is that the perturbation is weighted by the flat-ground
      // projection's own triplanar weight, which goes to 0 on those faces.
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, {});
      const src = compileStub(std).fragmentShader;
      expectPatched(src, "float rkW = rockWeight() * rW.z;");
    });

    it("lays distinct beds across the whole tint ramp", () => {
      // The bug this pins is subtle and shipped once: strata originally read a
      // 1-D COLUMN out of the 2-D rock field, which inherits that field's 2-D
      // normalization. Measured, the column came out 84% pale / 4% dark — a
      // uniformly pale wall with a couple of streaks, not layers. A sequence
      // must be normalized over the sequence you actually read.
      const d = getStrataRamp().image.data as Uint8Array;
      const lo = Math.min(...d) / 255;
      const hi = Math.max(...d) / 255;
      expect(hi - lo).toBeGreaterThan(0.5);

      // Distinct tones, not a drift: near-identical greys read as dirt.
      expect(new Set(d).size).toBeGreaterThanOrEqual(3);

      // Actual beds, and thick enough to see. Boundaries are STEPS — the one
      // place in this system where a discontinuity is the correct answer.
      let beds = 1;
      for (let i = 1; i < d.length; i++) if (d[i] !== d[i - 1]) beds++;
      expect(beds).toBeGreaterThanOrEqual(4);
      const meanThickness = STRATA_PERIOD_M / beds;
      expect(meanThickness).toBeGreaterThan(1);
      expect(meanThickness).toBeLessThan(12);
    });

    it("does not pin strata to the detail wrap — unlike every other tile", () => {
      // STRATA_PERIOD_M is measured along the UNWRAPPED axis, so the divisibility
      // law that governs grass and sand genuinely does not apply here. Pinning it
      // to 64 anyway would be cargo-culting the rule.
      expect(STRATA_PERIOD_M).toBeGreaterThan(0);
      expect(DETAIL_TILE_M % ROCK_TILE_M).toBe(0); // the WRAPPED axes still obey it
    });
  });

  describe("bedrock exposure — what puts rock in a valley", () => {
    // Rock used to exist only above the treeline, so a river valley had no rock
    // to stratify. The `valley` field (carveValleys' cut depth) is what exposes
    // bedrock down at river level.
    const withValley = (valley: Float64Array, fertility: Float64Array) =>
      substrateSurface({
        substrate: { topo, fields: { height, valley, fertility } as Record<string, ArrayLike<number>> },
        radius: RADIUS,
        seed: 4,
        valleyField: "valley",
      });

    it("turns barren cut ground to rock, in BOTH the colour and the material", () => {
      // The two must agree — otherwise the strata texture runs past the rock
      // colour it belongs to, which reads as a bug in the texture.
      const deep = Float64Array.from({ length: topo.n }, () => 2);
      const none = Float64Array.from({ length: topo.n }, () => 0);
      const barren = Float64Array.from({ length: topo.n }, () => 0);
      const cut = withValley(deep, barren);
      const uncut = withValley(none, barren);

      const rgb: [number, number, number] = [0, 0, 0];
      const mat: [number, number, number] = [0, 0, 0];
      let checked = 0;
      for (let c = 0; c < topo.n; c += 7) {
        const dir = topo.pos3!(c);
        const h = cut.heightAt(dir);
        // Below the snow line, above the shore — the band where a valley lives.
        if (h <= 0) continue;
        cut.materialAt!(h, dir, mat);
        if (mat[2] < 0.9) continue;
        cut.colorAt(h, dir, rgb);
        // Fully-cut barren ground reads as the palette's rock, not as dust.
        expect(rgb[0]).toBeCloseTo(EARTHLIKE_PALETTE.rock[0], 1);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);

      // Guard the guard: with no cut, the same ground is NOT rock.
      let sawNonRock = 0;
      for (let c = 0; c < topo.n; c += 7) {
        const dir = topo.pos3!(c);
        const h = uncut.heightAt(dir);
        if (h <= 0 || h >= RADIUS * 0.005 * 0.5) continue;
        uncut.materialAt!(h, dir, mat);
        if (mat[2] < 0.5) sawNonRock++;
      }
      expect(sawNonRock).toBeGreaterThan(5);
    });

    it("lets vegetation cover the bedrock — fertile valleys stay green", () => {
      // The ecology keys fertility off river flow, so cut ground and green
      // ground coincide BY CONSTRUCTION. Without the 1-fert term the valleys
      // rivers make lush would render as bare stone.
      const deep = Float64Array.from({ length: topo.n }, () => 2);
      const lush = Float64Array.from({ length: topo.n }, () => 6); // fertilityFull
      const s = withValley(deep, lush);
      const mat: [number, number, number] = [0, 0, 0];
      let checked = 0;
      for (let c = 0; c < topo.n; c += 7) {
        const dir = topo.pos3!(c);
        const h = s.heightAt(dir);
        // Vegetated land only: below shoreShallow (unitElev/2) materialAt
        // rightly answers pure sand — a beach is a beach however fertile the
        // cell is — and above treeLine the rock is the elevation ramp's, not
        // the river's.
        if (h <= 1 || h >= RADIUS * 0.005 * 0.5) continue;
        s.materialAt!(h, dir, mat);
        expect(mat[2]).toBeCloseTo(0, 5); // fully lush ⇒ no exposure at all
        expect(mat[1]).toBeGreaterThan(0.9);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    });

    it("no valley field = no change, so uncarved worlds render as before", () => {
      const deep = Float64Array.from({ length: topo.n }, () => 2);
      const barren = Float64Array.from({ length: topo.n }, () => 0);
      const off = substrateSurface({
        substrate: { topo, fields: { height, valley: deep, fertility: barren } as Record<string, ArrayLike<number>> },
        radius: RADIUS,
        seed: 4,
        // valleyField deliberately not passed.
      });
      const on = withValley(deep, barren);
      const a: [number, number, number] = [0, 0, 0];
      const b: [number, number, number] = [0, 0, 0];
      let differed = 0;
      for (let c = 0; c < topo.n; c += 5) {
        const dir = topo.pos3!(c);
        const h = off.heightAt(dir);
        off.materialAt!(h, dir, a);
        on.materialAt!(h, dir, b);
        if (Math.abs(a[2] - b[2]) > 1e-6) differed++;
      }
      // The gate works AND the test isn't vacuous: turning it on changes things.
      expect(differed).toBeGreaterThan(5);
    });
  });

  describe("mode routing", () => {
    it("mixes the two sand regimes and tints by grain", () => {
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, {});
      const shader = compileStub(std);
      const src = shader.fragmentShader;
      // Two textures, not one at two strengths: ripples and grit are different
      // patterns, so there is no single field this could have come from.
      expect(shader.uniforms.uSandFineField).toBeDefined();
      expect(shader.uniforms.uSandCoarseField).toBeDefined();
      expectPatched(src, "sandTint(sandSample())");
      expectPatched(src, "dn = sandNormal(sandSample(), sW)");
      expectPatched(shader.vertexShader, "vRegime = regime;");
    });

    it("perturbs normals for standard grass but NOT for toon", () => {
      // Toon quantizes N·L through a 4-step nearest ramp. Perturbing a STATIC
      // normal there doesn't shade clumps — it freezes the ramp's step
      // boundaries into hard blotches wherever a clump straddles a step. Cel
      // ground gets tint only.
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, {});
      const stdSrc = compileStub(std).fragmentShader;
      expect(stdSrc).toContain("grassNormal");
      expectPatched(stdSrc, "diffuseColor.rgb *= mix(vec3(1.0), grassTint()");

      const toon = new THREE.MeshToonMaterial();
      applyTerrainShading(toon, {});
      const toonSrc = compileStub(toon).fragmentShader;
      expect(toonSrc).toContain("grassTint");
      expect(toonSrc).not.toContain("grassNormal");
    });

    it("compiles nothing for a section turned off", () => {
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, { grass: false });
      const src = compileStub(std).fragmentShader;
      expect(src).not.toContain("grassTint");
      expect(src).toContain("waveNormal");
    });

    it("keys the program cache on which sections compiled", () => {
      // three hands back a cached program for a matching key WITHOUT
      // recompiling. Two materials differing only by `grass: false` sharing one
      // key means one of them silently renders the other's shader.
      const a = new THREE.MeshStandardMaterial();
      const b = new THREE.MeshStandardMaterial();
      applyTerrainShading(a, {});
      applyTerrainShading(b, { grass: false });
      expect(a.customProgramCacheKey!()).not.toBe(b.customProgramCacheKey!());
    });
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

// The day/night terminator for planet-scale toon bodies. The shared 4-step cel
// ramp smears into disc-wide bands on a whole planet; this replaces it with a
// physical edge + a night floor. The pixels aren't visible here — these pin the
// physics of the width and that the shader splice actually lands (a missing
// needle in String.replace is a silent no-op that reverts to the ramp).
describe("day/night terminator", () => {
  // Earthlike reference: Sun radius / 1 AU, Earth radius, ~8 km scale height.
  const SUN_R = 6.96e8;
  const AU = 1.496e11;
  const EARTH_R = 6.371e6;

  describe("width physics", () => {
    it("widens with a thicker atmosphere and narrows with a bigger planet", () => {
      const base = { starRadiusM: SUN_R, starDistanceM: AU, planetRadiusM: EARTH_R };
      const thin = computeTerminatorWidth({ ...base, atmosphereScaleHeightM: 2_000 });
      const thick = computeTerminatorWidth({ ...base, atmosphereScaleHeightM: 30_000 });
      expect(thick).toBeGreaterThan(thin);
      // Same air, a bigger world: the atmosphere is proportionally thinner, edge sharper.
      const small = computeTerminatorWidth({ starRadiusM: SUN_R, starDistanceM: AU, planetRadiusM: EARTH_R * 0.25, atmosphereScaleHeightM: 8_000 });
      const large = computeTerminatorWidth({ starRadiusM: SUN_R, starDistanceM: AU, planetRadiusM: EARTH_R * 4, atmosphereScaleHeightM: 8_000 });
      expect(small).toBeGreaterThan(large);
    });

    it("sharpens as the star recedes (its penumbra shrinks)", () => {
      const near = computeTerminatorWidth({ starRadiusM: SUN_R, starDistanceM: AU * 0.2, planetRadiusM: EARTH_R, atmosphereScaleHeightM: 0 });
      const far = computeTerminatorWidth({ starRadiusM: SUN_R, starDistanceM: AU * 5, planetRadiusM: EARTH_R, atmosphereScaleHeightM: 0 });
      expect(near).toBeGreaterThan(far);
    });

    it("gives an airless world under a point-like star a near-razor edge, and stays clamped", () => {
      const airless = computeTerminatorWidth({ starRadiusM: SUN_R, starDistanceM: AU, planetRadiusM: EARTH_R, atmosphereScaleHeightM: 0 });
      expect(airless).toBeGreaterThanOrEqual(0.02);
      expect(airless).toBeLessThan(0.1);
      // A pathological soup (huge close star, thick air, tiny world) is bounded,
      // never a "terminator" swallowing the whole hemisphere.
      const soup = computeTerminatorWidth({ starRadiusM: SUN_R * 50, starDistanceM: AU * 0.01, planetRadiusM: 1e5, atmosphereScaleHeightM: 5e5 });
      expect(soup).toBeLessThanOrEqual(0.6);
    });
  });

  describe("shader splice", () => {
    it("replaces the cel ramp with the terminator on a toon planet material", () => {
      const toon = new THREE.MeshToonMaterial({ gradientMap: null });
      applyTerrainShading(toon, { terminator: { width: 0.08 } });
      const shader = compileStub(toon);
      const src = shader.fragmentShader;
      // Our getGradientIrradiance, not three's ramp sampler.
      expectPatched(src, "uNightFloor");
      expectPatched(src, "smoothstep( -uTermWidth, uTermWidth, dotNL )");
      expect(shader.uniforms.uTermWidth.value).toBeCloseTo(0.08, 6);
      expect(shader.uniforms.uNightFloor.value).toBe(NIGHT_FLOOR);
    });

    it("leaves a toon material WITHOUT terminator on the shared ramp", () => {
      // A ground/local scope must not get the space edge — it would clip the
      // hillside into day/night with no star overhead.
      const toon = new THREE.MeshToonMaterial();
      applyTerrainShading(toon, {});
      const src = compileStub(toon).fragmentShader;
      expect(src).not.toContain("uNightFloor");
      expect(src).not.toContain("uTermWidth");
    });

    it("does not touch a STANDARD material — Lambert is already a physical edge", () => {
      const std = new THREE.MeshStandardMaterial();
      applyTerrainShading(std, { terminator: { width: 0.08 } });
      const shader = compileStub(std);
      expect(shader.fragmentShader).not.toContain("uNightFloor");
      expect(shader.uniforms.uTermWidth).toBeUndefined();
    });

    it("gives terminator/non-terminator materials distinct cache keys", () => {
      const a = new THREE.MeshToonMaterial();
      const b = new THREE.MeshToonMaterial();
      applyTerrainShading(a, {});
      applyTerrainShading(b, { terminator: { width: 0.08 } });
      expect(a.customProgramCacheKey!()).not.toBe(b.customProgramCacheKey!());
    });

    it("standalone applyToonTerminator patches a plain toon sphere and honours nightFloor", () => {
      const toon = new THREE.MeshToonMaterial();
      applyToonTerminator(toon, { width: 0.05, nightFloor: 0.3 });
      const shader = compileStub(toon);
      expectPatched(shader.fragmentShader, "getGradientIrradiance");
      expectPatched(shader.fragmentShader, "uNightFloor");
      expect(shader.uniforms.uNightFloor.value).toBe(0.3);
      expect(shader.uniforms.uTermWidth.value).toBeCloseTo(0.05, 6);
    });

    it("standalone applyToonTerminator no-ops on a standard sphere", () => {
      const std = new THREE.MeshStandardMaterial();
      applyToonTerminator(std, { width: 0.05 });
      const shader = compileStub(std);
      expect(shader.fragmentShader).not.toContain("uNightFloor");
      expect(shader.uniforms.uTermWidth).toBeUndefined();
    });
  });
});
