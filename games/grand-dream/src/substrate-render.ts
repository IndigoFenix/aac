/**
 * The substrate rasterizer — the ORIGINAL sandbox's renderer, ported:
 * `materialColor` palette (water by DEPTH, plants as a ramp, bare ground
 * sand→damp-brown by how wet the soil is) times a PROMINENCE shade
 * (brightness from how far a tile stands above its surroundings, plus a
 * gentle absolute-height tint) — that shading is what makes the terrain
 * read as 3D. Plus a travelling glint on flowing water, ore veins, and a
 * warm tint where wild people pool.
 *
 * One tile = one pixel; callers scale it up however they like (the map
 * stretches the whole grid, the overworld view draws a camera window).
 */

import type { CellGrid } from "@cells/index";

const SAND = [214, 184, 124], FERTILE_SOIL = [97, 71, 38];
const WATER_SHALLOW = [99, 178, 220], WATER_DEEP = [17, 64, 122];
const PLANT_SPARSE = [120, 176, 74], PLANT_DENSE = [28, 110, 46];
const SHADE = { promRadius: 4, promStrength: 0.05, heightStrength: 0.012, baseline: 16, min: 0.5, max: 1.5 };

/** Fill `img` (cols × rows) with the current substrate frame. `ts` in
 *  seconds drives the water glints. */
export function paintSubstrateImage(grid: CellGrid, img: ImageData, ts: number): void {
  const { cols, rows } = grid;
  const f = grid.fields;
  const height = f.height, plant = f.plant, ore = f.ore, solid = f.solid, people = f.people;
  const water = f.water ?? null;       // oasis substrate
  const river = f.river ?? null;       // computed-river substrate
  const moisture = f.moisture ?? null;
  const fertility = f.fertility;
  const lerp3 = (a: number[], b: number[], t: number): number[] => {
    const k = Math.max(0, Math.min(1, t));
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };
  const h = (x: number, y: number): number =>
    height[Math.max(0, Math.min(rows - 1, y)) * cols + Math.max(0, Math.min(cols - 1, x))];
  const R = SHADE.promRadius;
  const area = (2 * R + 1) * (2 * R + 1);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      // --- materialColor, original priority: water > plants > soil.
      const wetDepth = water ? water[i] : (river && river[i] > 10 ? 1 + (river[i] - 10) / 60 : 0);
      let c: number[];
      if (wetDepth >= 1) {
        c = lerp3(WATER_SHALLOW, WATER_DEEP, wetDepth / 3);
      } else if (plant[i] > 0.5) {
        c = lerp3(PLANT_SPARSE, PLANT_DENSE, plant[i] / 7);
      } else {
        const table = moisture && height[i] > 0 ? moisture[i] / height[i] : 0;
        const damp = Math.max(fertility[i] / 15, table);
        c = lerp3(SAND, FERTILE_SOIL, damp);
      }
      if (ore[i] > 0.5 && wetDepth < 1 && plant[i] <= 0.5) c = lerp3([150, 130, 160], [90, 60, 120], ore[i] / 15);
      if (solid[i] > 0.5) c = [110, 110, 115];
      if (people[i] > 0) c = lerp3(c, [225, 150, 70], 0.5 * Math.min(1, people[i] / 31));

      // --- the ORIGINAL depth: prominence shading + height tint.
      let sum = 0;
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) sum += h(x + ox, y + oy);
      const prominence = height[i] - sum / area;
      let factor = 1 + prominence * SHADE.promStrength + (height[i] - SHADE.baseline) * SHADE.heightStrength;
      if (factor < SHADE.min) factor = SHADE.min;
      else if (factor > SHADE.max) factor = SHADE.max;

      // --- travelling glints on flowing water (crest-only, sparse).
      if (water && water[i] >= 1) {
        const s = height[i] + water[i];
        let drop = 0, fdx = 0, fdy = 0;
        const cand: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of cand) {
          const nx = x + dx, ny = y + dy;
          const ns = nx < 0 || nx >= cols || ny < 0 || ny >= rows
            ? 0
            : height[ny * cols + nx] + water[ny * cols + nx];
          const e = s - ns;
          if (e > drop) { drop = e; fdx = dx; fdy = dy; }
        }
        const dnx = x + fdx, dny = y + fdy;
        const downstreamWet = dnx >= 0 && dnx < cols && dny >= 0 && dny < rows && water[dny * cols + dnx] >= 1;
        if (drop > 0.5 && downstreamWet) {
          const strength = Math.min(1, drop / 2);
          const phase = (x * fdx + y * fdy) * 0.32 - ts * 0.7 * (0.5 + strength);
          const crest = Math.max(0, Math.sin(phase * Math.PI * 2));
          factor *= 1 + 0.22 * strength * crest * crest;
        }
      }

      const o = i * 4;
      img.data[o] = Math.max(0, Math.min(255, c[0] * factor));
      img.data[o + 1] = Math.max(0, Math.min(255, c[1] * factor));
      img.data[o + 2] = Math.max(0, Math.min(255, c[2] * factor));
      img.data[o + 3] = 255;
    }
  }
}
