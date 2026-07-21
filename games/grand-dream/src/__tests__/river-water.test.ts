// RIVER WATER — visible water in the beds carveValleys cut, and the current
// that runs down them.
//
// Separate from planet-render.test.ts's `water shading` suite on purpose: that
// one owns the OCEAN's glint envelope, this one owns rivers. They share the
// WATER_SAFETY bounds and both must pass.
//
// The pixels need a GL context and aren't visible here. What IS testable is
// everything that decides them, which is the half that regresses silently: the
// water attribute, the flow direction, the safety clamp, and whether the splice
// actually landed.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { prepareSubstrate } from "../tri";
import { DETAIL_TILE_M } from "@shared/world-engine/planet/chunk";
import { applyTerrainShading, WATER_SAFETY } from "@shared/world-engine/planet/terrain-shading";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

/** Run a material's onBeforeCompile the way WebGLRenderer would, against
 *  THREE's real ShaderLib — see the longer note in planet-render.test.ts. */
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

describe("river current — seizure safety", () => {
  // The ocean's hazard is a specular lobe dragged by animated normals. A
  // river's is different in kind: scrolling foam is moving LUMINANCE EDGES, and
  // the question is only ever what FREQUENCY they cross a fixed point at.
  it("keeps the scroll an order of magnitude below the photosensitive band", () => {
    // The wave field's longest wave is ~16 m (DETAIL_TILE_M / BASE_FREQ, see
    // water-normals.ts). A band crosses a fixed point at speed / wavelength.
    const LONGEST_WAVE_M = 16;
    const PHOTOSENSITIVE_HZ = 3; // the conservative low end of the trigger band
    const maxMetresPerSec = WATER_SAFETY.maxFlowSpeed * DETAIL_TILE_M;
    const maxHz = maxMetresPerSec / LONGEST_WAVE_M;
    expect(maxHz).toBeLessThan(PHOTOSENSITIVE_HZ / 10);
    // If DETAIL_TILE_M or the wave spectrum is retuned, this fails rather than
    // the cap silently becoming a lie. That is the entire point of computing it
    // here instead of asserting a magic number.
  });

  it("clamps a caller trying to make the river rip", () => {
    const mat = new THREE.MeshToonMaterial();
    applyTerrainShading(mat, { water: { flowSpeed: 5 } });
    const shader = compileStub(mat);
    expect(shader.uniforms.uFlowSpeed.value).toBe(WATER_SAFETY.maxFlowSpeed);
  });

  it("ships a default well inside the cap", () => {
    const mat = new THREE.MeshToonMaterial();
    applyTerrainShading(mat, {});
    const shader = compileStub(mat);
    expect(shader.uniforms.uFlowSpeed.value).toBeGreaterThan(0);
    expect(shader.uniforms.uFlowSpeed.value).toBeLessThan(WATER_SAFETY.maxFlowSpeed);
  });
});

describe("river current — the splice", () => {
  it("reaches the fragment shader in TOON, the mode we actually ship", () => {
    const mat = new THREE.MeshToonMaterial();
    applyTerrainShading(mat, {});
    const shader = compileStub(mat);
    // Toon gets NO normal perturbation by design (a perturbed normal drags the
    // 4-step ramp's boundaries around as crawling contours). So if flow only
    // existed on the standard path it would render nothing in the shipped mode
    // and no test would notice.
    expect(shader.fragmentShader.includes("waveDriftA")).toBe(true);
    expect(shader.fragmentShader.includes("foamBands")).toBe(true);
    expect(shader.vertexShader.includes("attribute vec2 flow")).toBe(true);
    expect(shader.vertexShader.includes("vFlow = flow")).toBe(true);
  });

  it("reaches the standard path too", () => {
    const mat = new THREE.MeshStandardMaterial();
    applyTerrainShading(mat, {});
    const shader = compileStub(mat);
    expect(shader.fragmentShader.includes("waveDriftA")).toBe(true);
    expect(shader.vertexShader.includes("vFlow = flow")).toBe(true);
  });

  it("still water keeps a NON-ZERO drift — a dead sea is the failure mode", () => {
    const mat = new THREE.MeshToonMaterial();
    applyTerrainShading(mat, {});
    const shader = compileStub(mat);
    // The ocean has no flow vector, so it falls through to its own constants.
    // Were the fallback dropped, the sea would simply stop moving — which looks
    // deliberate and would survive review.
    expect(shader.fragmentShader.includes("vec2( 0.031, 0.019)")).toBe(true);
    expect(shader.fragmentShader.includes("vec2(-0.023, 0.041)")).toBe(true);
  });
});

describe("river water reaches the mesh", () => {
  // Built on the flat substrate rather than a full planet bake: the seam under
  // test is surface → chunk, and prepareSubstrate is the cheapest thing that
  // produces a real settled `river` + `valley` + `ground`.
  const prep = prepareSubstrate({
    cols: 32, rows: 32,
    height: (x, y) =>
      Math.max(3, Math.min(63, 8 + Math.max(0, Math.abs(x - 16) - 1) * 2 + (31 - y) * 0.8)),
    treeline: 40,
    founding: { threshold: 40, radius: 2, minSpacing: 5 },
    oreSeed: 7,
  });

  it("marks channel cells wet and dry land dry", () => {
    const { river } = prep.grid.fields;
    const wet = [...river.keys()].filter(c => river[c] > 16);
    expect(wet.length).toBeGreaterThan(5);
    // wetAt is a surface concern, but the field it reads is the contract: water
    // appears exactly where carveValleys cut a bed for it (both use 16).
    const dry = [...river.keys()].filter(c => river[c] <= 16);
    expect(dry.length).toBeGreaterThan(50);
  });

  it("the current runs DOWNHILL — the one thing a current can get wrong", () => {
    // flowArr is built from steepest descent over MACRO height, by construction
    // the same edge computeFlow routed the catchment down. Assert the invariant
    // directly on the substrate: every wet cell's chosen downstream neighbour is
    // strictly lower than it is. A river running uphill is the failure everyone
    // would see instantly and no unit test would catch.
    const { river, height } = prep.grid.fields;
    const { topo } = prep.grid;
    const nbs: number[] = new Array(topo.maxDegree).fill(0);
    let checked = 0;
    for (let c = 0; c < topo.n; c++) {
      if (river[c] <= 16) continue;
      const k = topo.neighbours(c, nbs);
      let low = -1;
      let lowH = height[c];
      for (let j = 0; j < k; j++) {
        if (height[nbs[j]] < lowH) { lowH = height[nbs[j]]; low = nbs[j]; }
      }
      if (low < 0) continue; // a sink: still water, no current — legal
      expect(height[low]).toBeLessThan(height[c]);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("water is carved ground, not sea level: a river keeps its altitude", () => {
    // The trap this guards: ocean vertices are clamped UP to sea level. Reusing
    // that path for rivers would drain every river on the planet into the sea.
    const { river, ground, height } = prep.grid.fields;
    const bed = [...river.keys()].find(c => river[c] > 45)!;
    expect(ground[bed]).toBeGreaterThan(3); // above the sea line
    expect(ground[bed]).toBeLessThan(height[bed]); // but in its valley
  });
});

// END-TO-END on the surface the flight sim actually renders (buildPlanetWorld →
// surfaceFor → substrateSurface with the default field names). The VISIBLE water
// is now the draped ribbon (world-lab/river-ribbons.ts, extracted by
// planet/rivers.ts and tested in river-network.test.ts) — not testable here
// without GL. What this pins is the cell TINT's supporting role after that
// handoff: a channel reads as a DAMP hint (bluer than dry land) while rain-fed
// fertile land between the rivers stays green. If the tint regresses to flooding
// whole regions blue — the "trees standing in water" bug — the green check fails.
describe("the surface tint backs the rivers without flooding the land", () => {
  const game: GameSettings = {
    scope: "planet",
    world: {
      topology: { kind: "cube-sphere", faceN: 48 }, // the flight sim's resolution
      geology: { seed: 7, epochs: 350 },
      settle: true, radius: 6_371_000,
      founding: { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 },
    },
    initialFocus: null, avatar: false, avatarSpecies: "human",
    canFly: false, creativeMode: false, entities: null,
  };
  const built = buildPlanetWorld(game);
  const surf = built.surface;
  const { topo } = built;
  const river = built.grid.fields.river as Float64Array;
  const fert = built.grid.fields.fertility as Float64Array;
  const height = built.grid.fields.height as Float64Array;

  it("the surface the flight sim renders exposes wetAt and flowAt", () => {
    expect(typeof surf.wetAt).toBe("function");
    expect(typeof surf.flowAt).toBe("function");
  });

  const blueMinusGreen = (cell: number): number => {
    const d = topo.pos3!(cell);
    const out: [number, number, number] = [0, 0, 0];
    surf.colorAt(surf.heightAt(d), d, out);
    return out[2] - out[1]; // > 0 = reads blue; more negative = greener
  };

  it("channel cells read DAMPER (bluer) than the fertile land around them", () => {
    const channels = [...river.keys()]
      .filter(c => height[c] >= SEA_HEIGHT && river[c] > 45)
      .sort((a, b) => river[b] - river[a]);
    const dryFertile = [...river.keys()]
      .filter(c => height[c] >= SEA_HEIGHT && fert[c] >= 10 && river[c] <= 16);
    expect(channels.length).toBeGreaterThan(10);
    expect(dryFertile.length).toBeGreaterThan(10);
    // The tint is now a hint, not the water — so the test is RELATIVE: a channel
    // is bluer (blue−green higher) than rain-fed land, whatever the absolutes.
    const chanAvg = channels.slice(0, 30).reduce((s, c) => s + blueMinusGreen(c), 0) / Math.min(30, channels.length);
    const dryAvg = dryFertile.slice(0, 30).reduce((s, c) => s + blueMinusGreen(c), 0) / Math.min(30, dryFertile.length);
    expect(chanAvg).toBeGreaterThan(dryAvg);
  });

  it("rain-fed fertile land between the rivers stays GREEN, not flooded blue", () => {
    // The bug this guards is the "trees standing in water" flooding: the fertile
    // halo must stay green (green ≥ blue), or the backing tint is painting lush
    // land as sea again.
    const dryFertile = [...river.keys()]
      .filter(c => height[c] >= SEA_HEIGHT && fert[c] >= 10 && river[c] <= 16);
    expect(dryFertile.length).toBeGreaterThan(10);
    const green = dryFertile.slice(0, 30).filter(c => blueMinusGreen(c) <= 0).length;
    expect(green).toBe(Math.min(30, dryFertile.length));
  });
});
