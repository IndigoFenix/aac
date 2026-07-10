// Cell Systems — worldgen helpers (grand-dream world-content.md).
//
// Generation-time writes and pure read-side scans that sit OUTSIDE the rule
// engine: ore deposits are placed once (a finite budget the runtime may only
// deplete), and founding candidates are detected by reading the settled
// `people` field. Neither adds dynamics, so the substrate's idle-safety is
// untouched. Everything here is deterministic — keyed hashes, fixed scan
// order — because founding a city must replay bit-identically.

import type { CellGrid } from './grid';

/** Deterministic per-cell hash in [0,1) — worldgen-only (never per-step). */
function hash01(seed: number, cell: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ cell, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1597334677) >>> 0;
  h ^= h >>> 16;
  return h / 4294967296;
}

export interface OreSeedOpts {
  /** Elevation above which deposits appear (the treeline — world-content §1:
   *  ore and fertility anti-correlate BY CONSTRUCTION through this line). */
  treeline: number;
  /** Cap written into the ore field (should match the var's max). */
  maxOre?: number;
  seed?: number;
  oreField?: string;
  heightField?: string;
}

/**
 * Place finite ore deposits above the treeline: richness rises with
 * elevation, thinned by a deterministic per-cell lottery so deposits are
 * veins, not a uniform cap. Call ONCE at worldgen — the runtime treats ore
 * as a budget (mining only subtracts).
 */
export function seedOreAboveTreeline(grid: CellGrid, opts: OreSeedOpts): void {
  const { treeline, maxOre = 15, seed = 1, oreField = 'ore', heightField = 'height' } = opts;
  const ore = grid.fields[oreField];
  const height = grid.fields[heightField];
  if (!ore || !height) return;
  let maxH = treeline + 1;
  for (let i = 0; i < height.length; i++) if (height[i] > maxH) maxH = height[i];
  for (let i = 0; i < ore.length; i++) {
    if (height[i] <= treeline) { ore[i] = 0; continue; }
    const rise = (height[i] - treeline) / (maxH - treeline); // 0..1 above the line
    const lottery = hash01(seed, i);
    // ~40% of high tiles carry a vein; richer with elevation and luck.
    ore[i] = lottery < 0.4 ? Math.round(maxOre * rise * (0.5 + 0.5 * hash01(seed + 1, i))) : 0;
  }
}

export interface FoundingOpts {
  /** Density needed: Σ people within `radius` (box) ≥ threshold. */
  threshold: number;
  radius: number;
  /** Minimum euclidean distance to every existing/accepted settlement. */
  minSpacing: number;
  /** FOUND SMALL, applied to the harvest (grand-dream civilization-
   *  emergence §2a): a founding takes at most this many grid persons
   *  from the box — the residue stays WILD (it regrows and feeds later
   *  foundings). The scanner ignores it (crowds still gate and rank by
   *  their full density); the HARVESTER honors it, apportioning the
   *  take across species proportionally. Absent = take everyone. */
  maxHarvest?: number;
  /** Existing settlement positions ([x, y] tile coords). */
  occupied?: Array<[number, number]>;
  peopleField?: string;
  /** Sugarscape hook: rank candidates by density PLUS weighted resource
   *  sums over the same box (e.g. [{field:'ore', weight:3}] makes
   *  prospector towns outrank equally-crowded farm hamlets). People still
   *  gate via `threshold` — resources rank, crowds found. This is where
   *  day-boundary SUPPLY/DEMAND plugs in later: the settlement layer sets
   *  the weights from scarcity (metal dear → ore weight up), and founding
   *  starts answering the market (world-content §5). */
  score?: Array<{ field: string; weight: number }>;
}

export interface FoundingSite {
  /** Flat-chart coordinates of `cell` (x = cell % cols, y = cell / cols) —
   *  consumers' distance math and render placement read these. On curved
   *  topologies these become face-local chart coords; index-based reads
   *  should prefer `cell` + grid.topo. */
  x: number;
  y: number;
  cell: number;
  /** Σ people in the box — the crowd a founding would harvest. */
  density: number;
  /** density + Σ weight × resource box-sums — the ranking key. */
  score: number;
}

/**
 * Scan the settled `people` field for tiles dense enough to found a city
 * (world-content §5). Pure read, deterministic: candidates rank by
 * (score desc, cell index asc) and are accepted greedily under the
 * spacing rule against occupied AND already-accepted sites. The harvest /
 * entity+site creation is the caller's day-boundary transaction.
 */
export function findFoundingSites(grid: CellGrid, opts: FoundingOpts): FoundingSite[] {
  const { threshold, radius, minSpacing, occupied = [], peopleField = 'people', score = [] } = opts;
  const people = grid.fields[peopleField];
  if (!people) return [];
  const { cols, topo } = grid;
  const scoreFields = score
    .map(s => ({ arr: grid.fields[s.field], weight: s.weight }))
    .filter(s => s.arr);

  const candidates: FoundingSite[] = [];
  for (let c = 0; c < topo.n; c++) {
    let density = 0;
    let rank = 0;
    topo.disk(c, radius, cell => {
      density += people[cell];
      for (const s of scoreFields) rank += s.weight * s.arr![cell];
    });
    if (density >= threshold) candidates.push({ x: c % cols, y: (c / cols) | 0, cell: c, density, score: density + rank });
  }

  candidates.sort((a, b) => b.score - a.score || a.cell - b.cell);
  const accepted: FoundingSite[] = [];
  const spacing2 = minSpacing * minSpacing;
  const occupiedCells = occupied.map(([px, py]) => py * cols + px);
  for (const c of candidates) {
    if (!occupiedCells.every(o => topo.dist2(c.cell, o) >= spacing2)) continue;
    if (!accepted.every(a => topo.dist2(c.cell, a.cell) >= spacing2)) continue;
    accepted.push(c);
  }
  return accepted;
}
