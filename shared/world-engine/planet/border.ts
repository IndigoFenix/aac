// shared/world-engine/planet/border.ts
//
// BORDER TOWNS — the EDGE-owned founding pass of the region tier.
//
// The interior founding of refine.ts obeys the ownership rule (a region only
// founds on child cells of ITS OWN tier-0 cell) plus a half-spacing setback
// from non-owned territory, so two regions' interior villages can never
// overlap or crowd each other. That setback band is not dead land: it belongs
// to THIS pass. For each tier-0 edge (cellA, cellB) we build a small band
// chart of the border itself, solve a mini substrate on it, and found 0–2
// towns — deterministically and SYMMETRICALLY in the canonical pair, so both
// adjacent regions compute byte-identical border towns without ever reading
// each other (the stitchRegions precedent, one tier up the founding stack).
//
// Determinism contract: everything derives from (built planet, the unordered
// pair). refineRegion deliberately passes NO per-region options through here —
// two regions refined with different RefineOpts must still agree on the edge.

import type { BuiltPlanet } from "./planet-game.js";
import { applyClimate, LAPSE_C_PER_M, THERMAL_M_PER_UNIT_CAP } from "./climate.js";
import { prepareSubstrate } from "../kernel/civ/tri.js";
import { findFoundingSites, type FoundingOpts } from "../kernel/cells/index.js";
import { SEA_HEIGHT } from "../kernel/geology/tectonics.js";
import { foundCitiesFromSites, type PlanetCity } from "./cities.js";
import { REAL_TOWN_SPACING_M } from "../scale.js";

export interface BorderTown extends PlanetCity {
  /** The tier-0 cell that OWNS this town: the cell containing its dir
   *  (topo.cellAt). Exactly one of the pair — both sides agree, so exactly
   *  one region appends it to its `villages` output. */
  owner: number;
}

export interface BorderTownOpts {
  /** Farmland floor (foundCitiesFromSites) — a barren border founds
   *  nothing. Default 25, the village floor. */
  minFarmland?: number;
  /** Towns per edge (default 2). */
  maxTowns?: number;
}

// ── Border-town KEY SPACE ───────────────────────────────────────────────────
//
// Keys seed towns and hash caravan phases, so they must NEVER collide with
// any other settlement identity. The existing key spaces are:
//   tier-0 capitals:  cell            ∈ [0, 6·faceN²)          — non-negative
//   tier-1 villages:  regionCell·16384 + childCell ≥ 0         — non-negative
// Border towns therefore live in the NEGATIVE integers:
//   key = −((cellA·nCells + cellB)·BAND_KEY_STRIDE + bandCell + 1)
// with cellA < cellB (the canonical pair). cellA·nCells + cellB is injective
// over ordered pairs; bandCell < BAND_KEY_STRIDE (the band grid is capped
// below it); the +1 keeps −0 out. Distinct edges get disjoint key ranges,
// distinct band cells distinct keys, and sign alone separates the namespace
// from every capital and village forever. Magnitude < (6·faceN²)²·2¹⁴ —
// < 2⁴⁸ for any faceN ≤ 64, exact in a double.
export const BAND_KEY_STRIDE = 16384;

/** The composite identity of a border town (see the key-space note above). */
export const borderTownKey = (pairIndex: number, bandCell: number): number =>
  -(pairIndex * BAND_KEY_STRIDE + bandCell + 1);

/** True for keys minted by borderTownKey — villages/capitals are ≥ 0. */
export const isBorderTownKey = (key: number): boolean => key < 0;

// ── Small vector helpers (module-local; refine.ts has its own) ──────────────

type V3 = readonly [number, number, number];

const norm = (v: [number, number, number]): [number, number, number] => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The band's gnomonic tangent frame (the region-chart pattern, shrunk):
 *  centered on the border midpoint, `east` ALONG the border, `north`
 *  ACROSS it (A side → B side). */
interface BandFrame {
  dir0: V3;
  east: V3;
  north: V3;
  cols: number;
  rows: number;
  cellSizeM: number;
}

const bandDir = (f: BandFrame, radius: number, x: number, y: number): [number, number, number] => {
  const ox = (x + 0.5 - f.cols / 2) * f.cellSizeM;
  const oy = (y + 0.5 - f.rows / 2) * f.cellSizeM;
  return norm([
    f.dir0[0] * radius + f.east[0] * ox + f.north[0] * oy,
    f.dir0[1] * radius + f.east[1] * ox + f.north[1] * oy,
    f.dir0[2] * radius + f.east[2] * ox + f.north[2] * oy,
  ]);
};

// ── Chebyshev distance transform (shared with refine.ts) ────────────────────

/**
 * Multi-source chebyshev (8-neighbour) BFS over a cols×rows chart: each
 * cell's hop distance to the nearest `source` cell. `seedOnes` are cells
 * known to sit beside an OFF-CHART source (the virtual ring probe — the
 * chart is a window, not the world) and start at distance ≤ 1. Chebyshev
 * never exceeds euclidean, so `dist[c] ≥ k` guarantees euclidean ≥ k —
 * the safe direction for a spacing setback. Deterministic scan order.
 */
export function chebyshevDistance(
  cols: number,
  rows: number,
  source: (cell: number) => boolean,
  seedOnes?: Iterable<number>,
): Int32Array {
  const n = cols * rows;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < n; c++) {
    if (source(c)) { dist[c] = 0; queue[tail++] = c; }
  }
  if (seedOnes) {
    for (const c of seedOnes) {
      if (c >= 0 && c < n && dist[c] < 0) { dist[c] = 1; queue[tail++] = c; }
    }
  }
  while (head < tail) {
    const c = queue[head++]!;
    const x = c % cols;
    const y = (c / cols) | 0;
    const d = dist[c] + 1;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= cols) continue;
        const i = yy * cols + xx;
        if (dist[i] < 0) { dist[i] = d; queue[tail++] = i; }
      }
    }
  }
  // Unreached cells (no source anywhere) read as "infinitely far".
  for (let c = 0; c < n; c++) if (dist[c] < 0) dist[c] = 0x3fffffff;
  return dist;
}

// ── The edge pass ───────────────────────────────────────────────────────────

/**
 * Found the border towns of ONE tier-0 edge. Deterministic and symmetric:
 * the pair is canonicalized (cellA < cellB) and every derived quantity —
 * band frame, substrate, founding, names, keys, owners — is a pure function
 * of (built, the pair, opts), so both adjacent regions compute byte-identical
 * results with zero cross-region reads.
 *
 * The band chart is narrow across the border (the two half-setback bands the
 * interior founding of refine.ts renounces) and long along it, stopped short
 * of the cell corners; eligibility additionally sets candidates back half a
 * spacing from any THIRD cell's territory, so edge passes of edges meeting
 * at a triple point stay apart too. Callers pass ADJACENT cells; the
 * function does not verify adjacency (a non-adjacent pair just yields a
 * band over land owned by neither, which founds nothing).
 */
export function borderTowns(
  built: BuiltPlanet,
  cellA: number,
  cellB: number,
  opts: BorderTownOpts = {},
): BorderTown[] {
  let a = cellA;
  let b = cellB;
  if (b < a) [a, b] = [b, a]; // canonical pair — argument order is render timing, not data
  if (a === b) return [];
  const topo = built.topo;
  if (!topo.pos3 || !topo.cellAt) return [];
  const cellAt = topo.cellAt;
  const R = built.spec.radius;

  const pA = topo.pos3(a);
  const pB = topo.pos3(b);
  const dp = Math.max(-1, Math.min(1, dot(pA, pB)));
  const pitch = Math.acos(dp);
  if (!(pitch > 1e-9)) return [];

  // Frame: dir0 = the border midpoint; across = A→B (⊥ dir0 exactly, since
  // (pB−pA)·(pA+pB) = |pB|²−|pA|² = 0 on the unit sphere); along = the
  // border direction.
  const dir0 = norm([pA[0] + pB[0], pA[1] + pB[1], pA[2] + pB[2]]);
  const across = norm([pB[0] - pA[0], pB[1] - pA[1], pB[2] - pA[2]]);
  const along = norm(cross(dir0, across));

  // Band metrics mirror the region tier's DEFAULTS (96 children per pitch,
  // day's-walk spacing) — deliberately NOT the caller's RefineOpts, so both
  // regions agree whatever options they refined with.
  const pairPitchM = pitch * R;
  const cellSizeM = pairPitchM / 96;
  const minSpacing = Math.max(4, Math.round(REAL_TOWN_SPACING_M / cellSizeM));
  const setback = Math.ceil(minSpacing / 2);
  // Long along the border (stopped short of the corners), just wide enough
  // across for the two half-setback bands.
  const cols = Math.max(16, Math.round(96 * 0.9));
  const rows = Math.max(6, 2 * setback + 2);
  if (cols * rows > BAND_KEY_STRIDE) {
    throw new Error("borderTowns: band grid exceeds its key stride");
  }
  const frame: BandFrame = { dir0, east: along, north: across, cols, rows, cellSizeM };

  const n = cols * rows;
  const dirs: Array<[number, number, number]> = new Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) dirs[y * cols + x] = bandDir(frame, R, x, y);
  }

  // ── Eligibility: only the pair's own land, set back from any third cell —
  //    towns of edges meeting at a triple point must not converge. ─────────
  const inPair = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const own = cellAt(dirs[i]!);
    inPair[i] = own === a || own === b ? 1 : 0;
  }
  const seedOnes: number[] = [];
  const probeForeign = (x: number, y: number): boolean => {
    const own = cellAt(bandDir(frame, R, x, y));
    return own !== a && own !== b;
  };
  for (let x = 0; x < cols; x++) {
    if (probeForeign(x, -1)) seedOnes.push(x);
    if (probeForeign(x, rows)) seedOnes.push((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    if (probeForeign(-1, y)) seedOnes.push(y * cols);
    if (probeForeign(cols, y)) seedOnes.push(y * cols + cols - 1);
  }
  const thirdDist = chebyshevDistance(cols, rows, c => inPair[c] === 0, seedOnes);
  const eligible = (c: number): boolean => inPair[c] === 1 && thirdDist[c] >= setback;

  // ── TERRAIN: the same render-sampler inverse the region tier uses ────────
  const maxUnits = 63;
  const maxElevation = built.spec.relief * R;
  const unitElev = maxElevation / Math.max(1, maxUnits - SEA_HEIGHT);
  const maxDepth = maxElevation * 1.3;
  const elevToUnits = (elev: number): number =>
    elev >= 0 ? SEA_HEIGHT + elev / unitElev : SEA_HEIGHT + (elev / maxDepth) * SEA_HEIGHT;
  const surface = built.surface;
  // MACRO, not the carved ground — this seeds the child's drainage potential.
  // Same rule as refine.ts: valleys are derived from rivers, so they may
  // never feed the solve that computes rivers, at any tier.
  const macroAt = surface.macroHeightAt ?? surface.heightAt;
  const height = (x: number, y: number): number => elevToUnits(macroAt(dirs[y * cols + x]!));
  const oreArr = built.grid.fields.ore;
  const ore = (x: number, y: number): number => {
    const parent = cellAt(dirs[y * cols + x]!);
    return oreArr ? oreArr[parent]! : 0;
  };

  // ── CAPITALS as fixed points, projected into the band (they essentially
  //    never reach a border, but the invariant is cheap to keep). ──────────
  const occupied: Array<[number, number]> = [];
  for (const site of built.sites) {
    const d = topo.pos3(site.cell);
    const w = dot(d, dir0);
    if (w <= 0.5) continue;
    const px = (dot(d, frame.east) / w) * R;
    const py = (dot(d, frame.north) / w) * R;
    const tx = px / cellSizeM + cols / 2 - 0.5;
    const ty = py / cellSizeM + rows / 2 - 0.5;
    if (tx < -cols * 0.25 || tx > cols * 1.25 || ty < -rows * 0.25 || ty > rows * 1.25) continue;
    occupied.push([Math.round(tx), Math.round(ty)]);
  }

  const founding: FoundingOpts = {
    threshold: 25,
    radius: 2,
    minSpacing,
    maxHarvest: 600,
    occupied,
    eligible,
  };
  // Parent runoff passes through like ore (refine.ts's rule): the band's
  // local drainage re-solves at the parent's rainfall density.
  const parentRunoff = built.grid.fields.runoff;
  const prep = prepareSubstrate({
    cols, rows,
    height,
    ore,
    founding,
    settle: true,
    rain: built.spec.rain,
    runoff: parentRunoff
      ? (x, y) => parentRunoff[cellAt(dirs[y * cols + x]!)]!
      : undefined,
  });

  // ── BUDGET: density semantics, exactly the region tier's rescale ─────────
  const parentPeople = built.grid.fields.people;
  const childPeople = prep.grid.fields.people;
  if (parentPeople && childPeople) {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const parent = cellAt(dirs[i]!);
      let g = groups.get(parent);
      if (!g) { g = []; groups.set(parent, g); }
      g.push(i);
    }
    for (const [parent, children] of groups) {
      let sum = 0;
      for (const i of children) sum += childPeople[i]!;
      if (sum <= 0) continue;
      const scale = (parentPeople[parent]! * children.length) / sum;
      for (const i of children) childPeople[i]! *= scale;
    }
    prep.sites = findFoundingSites(prep.grid, founding);
  }

  // ── CLIMATE: parent rain passthrough + lapse-adjusted temperature, then
  //    the ice gate — a polar border founds nothing, like a polar interior.
  const parentRain = built.grid.fields.rain;
  const parentTempC = built.grid.fields.tempC;
  if (parentRain && parentTempC) {
    const childRain = new Float64Array(n);
    const childTempC = new Float64Array(n);
    const parentHeight = built.grid.fields.height;
    const childHeight = prep.grid.fields.height;
    const thermalM = Math.min(unitElev, THERMAL_M_PER_UNIT_CAP);
    for (let i = 0; i < n; i++) {
      const parent = cellAt(dirs[i]!);
      childRain[i] = parentRain[parent]!;
      const dElevM = (Math.max(0, childHeight[i]! - SEA_HEIGHT)
        - Math.max(0, parentHeight[parent]! - SEA_HEIGHT)) * thermalM;
      childTempC[i] = parentTempC[parent]! - LAPSE_C_PER_M * dElevM;
    }
    applyClimate(prep.grid, { rain: childRain, tempC: childTempC }, { people: "iceOnly" });
    const ice = prep.grid.fields.ice;
    prep.sites = findFoundingSites(prep.grid, founding).filter(s => ice[s.cell]! < 1);
  }

  // ── Founding, through the shared helper — same names, same charters ──────
  const pairIndex = a * topo.n + b;
  const maxTowns = Math.max(0, Math.floor(opts.maxTowns ?? 2));
  if (maxTowns === 0) return [];
  const seedBase = (built.spec.geology.seed ^ Math.imul(pairIndex, 0x85ebca6b) ^ 0x2545f491) >>> 0;
  const towns = foundCitiesFromSites({
    sites: prep.sites,
    grid: prep.grid,
    seedBase,
    maxCities: maxTowns,
    minFarmland: opts.minFarmland ?? 25,
    dirOf: cell => dirs[cell]!,
    cellKey: cell => borderTownKey(pairIndex, cell),
  });
  return towns.map(t => ({ ...t, owner: cellAt(t.dir) }));
}
