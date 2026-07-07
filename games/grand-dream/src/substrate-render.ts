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
import { easeToward, frameDt } from "./transients";

const SAND = [214, 184, 124], FERTILE_SOIL = [97, 71, 38];
const WATER_SHALLOW = [99, 178, 220], WATER_DEEP = [17, 64, 122];
const PLANT_SPARSE = [120, 176, 74], PLANT_DENSE = [28, 110, 46];
const SHADE = { promRadius: 4, promStrength: 0.05, heightStrength: 0.012, baseline: 16, min: 0.5, max: 1.5 };

/** A presenter's eased copies of paint-relevant fields (see
 *  createSubstratePresenter). Only the PAINT reads these — the sim's
 *  fields stay authoritative everywhere else. */
export interface EasedFields {
  river?: Float32Array | null;
  plant?: Float32Array | null;
  fertility?: Float32Array | null;
}

/** Fill `img` (cols × rows) with the current substrate frame. `ts` in
 *  seconds drives the water glints. */
export function paintSubstrateImage(grid: CellGrid, img: ImageData, ts: number, eased?: EasedFields): void {
  const { cols, rows } = grid;
  const f = grid.fields;
  const height = f.height, ore = f.ore, solid = f.solid, people = f.people;
  const water = f.water ?? null;       // oasis substrate
  const river = eased?.river ?? f.river ?? null; // computed-river substrate (possibly eased)
  const plant = eased?.plant ?? f.plant;
  const moisture = f.moisture ?? null;
  const fertility = eased?.fertility ?? f.fertility;
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
      // Computed-river substrates carry no standing-water field, so the
      // SEA is read straight from the height semantics the substrate
      // itself uses (height < 3 = submarine, worldgenSubstrate's sea
      // line): a flat ocean basin has no flow ACCUMULATION — every
      // seafloor cell is its own sink — so depth, not river, is what
      // makes it water. Rivers still paint from accumulation and now
      // visibly pour into the sea they feed.
      const riverWet = river && river[i] > 10 ? 1 + (river[i] - 10) / 60 : 0;
      const seaWet = !water && height[i] < 3 ? 1 + (3 - height[i]) : 0;
      const wetDepth = water ? water[i] : Math.max(riverWet, seaWet);
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

/* ------------------- interpolated transients (§5b) -------------------- */
/**
 * The river field is a DERIVED solve — it jumps to its new answer the
 * instant terrain changes. This presenter is timescales.md §5b made real:
 * the authoritative field stays instant, and a presentation copy EASES
 * toward it, so re-routes read as a process instead of a cut.
 *
 *   - Growth CARVES headwaters → mouth: a tile fills only as its upstream
 *     feeder (the neighbour with strictly smaller target accumulation —
 *     accumulation strictly increases downstream, so the ordering is the
 *     drainage tree itself) delivers water. A small trickle floor keeps
 *     fronts from deadlocking on odd topology.
 *   - Decay is a plain ease: dam a river and the whole downstream bed
 *     dwindles in place, which is what real cut-off channels do.
 *   - Ease-toward has NO memory of the start, so the substrate changing
 *     again MID-TRANSIENT just moves the target — the shown field bends
 *     from wherever it visibly is. Retargeting is free by construction.
 *
 * One-way contract: the sim never reads `shown`. Consumers that act on
 * the world (collision, founding, charters, mining) keep reading the live
 * grid; only the water PAINT eases. Call paint() from as many views as
 * share the world — dt derives from ts, so extra same-frame calls are
 * no-ops.
 */
export interface SubstratePresenter {
  paint(img: ImageData, ts: number): void;
  /** The shown (eased) river at one cell — for tests and debug overlays. */
  river(cell: number): number;
  /** The shown (eased) vegetation at one cell. */
  plant(cell: number): number;
}

const CARVE_TAU = 0.5;   // s per tile-fill once the front reaches it
const DRY_TAU = 2.0;     // s for an abandoned bed to dwindle
const FRONT_GATE = 0.3;  // upstream fraction that opens a tile's fill
const SOURCE_ACC = 12;   // accumulation at/below which a tile is a headwater (fills ungated)
// Deadlock-breaker on gated growth, in ABSOLUTE units per second. It must
// be absolute: a floor proportional to the target let far-downstream tiles
// (huge accumulation) cross the absolute PAINT threshold in under a second
// of trickle alone, so rivers appeared at the mouth and "extended uphill"
// — the front ran backwards visually. At <1 unit/s a big tile takes ~15 s
// to self-reveal; the real front arrives long before that.
const TRICKLE_PER_SEC = 0.8;
const VEG_GROW_TAU = 1.5; // s — greening eases in
const VEG_DIE_TAU = 3.0;  // s — dieback eases out

export function createSubstratePresenter(grid: CellGrid): SubstratePresenter {
  // NOTE: read grid.fields.* FRESH each frame — recomputeFlows REPLACES the
  // river array on every re-solve; a captured reference goes stale.
  const shown = grid.fields.river ? Float32Array.from(grid.fields.river) : null;
  const shownPlant = grid.fields.plant ? Float32Array.from(grid.fields.plant) : null;
  const shownFert = grid.fields.fertility ? Float32Array.from(grid.fields.fertility) : null;
  let lastTs = -1;

  /** Plain per-cell ease toward the live field (vegetation, soil damp):
   *  the sim's own convergence is gradual in SIM time, but the lab steps
   *  the grid at frame rate — time-lapse cadence — so the display needs
   *  its own clock. This is transients.ts' easeToward, field-shaped. */
  const easeField = (live: ArrayLike<number>, s: Float32Array, dt: number): void => {
    for (let i = 0; i < s.length; i++) {
      s[i] = easeToward(s[i], live[i], dt, VEG_GROW_TAU, VEG_DIE_TAU, 0.05);
    }
  };

  const update = (ts: number): void => {
    const dt = frameDt(lastTs, ts);
    lastTs = ts;
    if (dt <= 0) return;

    if (shownPlant && grid.fields.plant) easeField(grid.fields.plant, shownPlant, dt);
    if (shownFert && grid.fields.fertility) easeField(grid.fields.fertility, shownFert, dt);

    const live = grid.fields.river ?? null;
    if (!live || !shown) return;
    const kGrow = 1 - Math.exp(-dt / CARVE_TAU);
    const kDry = 1 - Math.exp(-dt / DRY_TAU);
    const trickle = TRICKLE_PER_SEC * dt;
    const { cols, rows } = grid;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      const t = live[i];
      let s = shown[i];
      if (s === t) continue;
      if (s < t) {
        // Carve: fill only as the upstream feeder delivers; the absolute
        // trickle breaks deadlocks without ever outrunning the front.
        let feed = t <= SOURCE_ACC ? 1 : 0;
        if (feed < 1) {
          const x = i % cols;
          const y = (i - x) / cols;
          // The gate demands delivery proportional to MY size: normalising
          // by min(feeder, me) let a delivered 4-unit side trickle fully
          // open a 192-unit trunk, and the whole channel filled at once.
          const need = FRONT_GATE * t;
          const consider = (j: number): void => {
            const tj = live[j];
            if (tj > 0 && tj < t) {
              const g = Math.min(1, shown[j] / need);
              if (g > feed) feed = g;
            }
          };
          if (x + 1 < cols) consider(i + 1);
          if (x > 0) consider(i - 1);
          if (y + 1 < rows) consider(i + cols);
          if (y > 0) consider(i - cols);
        }
        s = Math.min(t, s + (t - s) * kGrow * feed + trickle);
      } else {
        s += (t - s) * kDry;
      }
      shown[i] = Math.abs(t - s) < 0.5 ? t : s;
    }
  };

  return {
    paint(img, ts) {
      update(ts);
      paintSubstrateImage(grid, img, ts, { river: shown, plant: shownPlant, fertility: shownFert });
    },
    river(cell) {
      return shown ? shown[cell] : grid.fields.river?.[cell] ?? 0;
    },
    plant(cell) {
      return shownPlant ? shownPlant[cell] : grid.fields.plant?.[cell] ?? 0;
    },
  };
}
