// Cell Systems — worldgen helpers (grand-dream world-content.md).
//
// Generation-time writes and pure read-side scans that sit OUTSIDE the rule
// engine: ore deposits are placed once (a finite budget the runtime may only
// deplete), and founding candidates are detected by reading the settled
// `forage` field (the land's forage capacity — the crowd it feeds is
// proportional, settlement-emergence.md §3). Neither adds dynamics, so the
// substrate's idle-safety is untouched. Everything here is deterministic —
// keyed hashes, fixed scan order — because founding a city must replay
// bit-identically.

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

export interface CarveOpts {
  /** Flow at/below which no valley is cut (default 16 — travel.ts's
   *  "genuine watercourse" line, and the foot of the fertility band). */
  minFlow?: number;
  /** Flow at which the cut reaches `maxDepth` (default 200 — the top of the
   *  display layer's river ramp, so the bed deepens over exactly the range
   *  the 2D map already shades). */
  fullFlow?: number;
  /** Deepest cut, in height units (default 2). Kept small on purpose: the
   *  macro field is the DRAINAGE potential and a deep cut would make the
   *  rendered ground disagree with the walk/collision datum by more than a
   *  creature can climb. */
  maxDepth?: number;
  /** Cells within this many tiles of a channel ease down toward it, so a
   *  riverside cell is a graded bank rather than a cliff edge (default 2). */
  bankRadius?: number;
  /** Ground never cuts below this (default 0 = the var's floor). */
  floor?: number;
  riverField?: string;
  heightField?: string;
  groundField?: string;
  valleyField?: string;
}

/**
 * Cut river valleys into a SECOND height layer: `ground` = `height` − a cut
 * that grows with river flow, eased outward over `bankRadius` into banks.
 *
 * WHY A SECOND LAYER. `height` is the drainage potential — `river` is a pure
 * function of it (grid.ts computeFlow). Subtracting a river-derived cut back
 * out of `height` would make flow an input to itself: the world would re-route
 * every recompute and never reach the rest the spec's termination argument
 * depends on (spec.ts: a flow field is "recomputed only when `potential`
 * changes"). So the derivation stays strictly one-way —
 *
 *     height (macro: drainage, climate, treeline, sea)
 *       └→ river = computeFlow(height)
 *            └→ ground = height − valleyDepth(river)   ← nothing reads this back
 *
 * — and `ground` is what creatures walk on, towns build on, and the sphere
 * renders, while `height` keeps answering for rainfall and temperature. The
 * same rule holds at every tier: a child substrate (planet/refine.ts) samples
 * its parent's MACRO height, never `ground`, or each refinement would carve a
 * valley into the last one's valley.
 *
 * `ground` is deliberately FLOAT where `height` is int. The integer grid is a
 * termination device — whole-unit transport reaches crisp rest — and it's why
 * a hand-dug canyon needs a full unit per row (a sub-unit slope becomes
 * alternating flats that break the drainage thread). Nothing drains over
 * `ground`, so it is free to carry the sub-unit profile that makes a valley
 * read as a valley instead of a staircase.
 *
 * RELICT VALLEYS. The persistent state is the CUT (`valley`), not the result:
 * the cut only ever deepens, because erosion is one-way — rock does not grow
 * back. So a river that re-routes or dries leaves its valley behind as the dry
 * bed it really is, and because the cut rides on live `height` rather than
 * replacing it, sculpting the land up still raises it, gorge and all. Called
 * once at worldgen this is identical to a plain subtraction; it is what makes
 * a SECOND call after a re-route mean something.
 *
 * Worldgen-time and idle-safe: a pure function of the settled `river`, no
 * dynamics, no per-step cost. Writes IN PLACE — planet/surface.ts captures the
 * array in a long-lived closure, so replacing it would strand every surface
 * already built on the old one.
 */
export function carveValleys(grid: CellGrid, opts: CarveOpts = {}): void {
  const {
    minFlow = 16, fullFlow = 200, maxDepth = 2, bankRadius = 2, floor = 0,
    riverField = 'river', heightField = 'height', groundField = 'ground',
    valleyField = 'valley',
  } = opts;
  const river = grid.fields[riverField];
  const height = grid.fields[heightField];
  const ground = grid.fields[groundField];
  const valley = grid.fields[valleyField];
  if (!river || !height || !ground || !valley) return;
  const { topo } = grid;
  const span = Math.max(1e-6, fullFlow - minFlow);

  // A channel's own depth. sqrt of the flow ramp: a watercourse's section
  // grows roughly with the root of its discharge, so tributaries read as
  // creases and trunk rivers as valleys without the headwaters vanishing.
  const channel = (c: number): number => {
    const f = river[c];
    if (f <= minFlow) return 0;
    return maxDepth * Math.sqrt(Math.min(1, (f - minFlow) / span));
  };

  for (let c = 0; c < topo.n; c++) {
    // The cut is the deepest nearby channel, attenuated by distance — a
    // max (not a sum) so two neighbouring streams don't dig twice as deep
    // as either, and so the profile is bounded by `maxDepth` everywhere.
    let cut = 0;
    topo.disk(c, bankRadius, (cell, dist) => {
      const d = channel(cell) * (1 - dist / (bankRadius + 1));
      if (d > cut) cut = d;
    });
    if (cut > valley[c]) valley[c] = cut; // monotone: the bed never fills back in
    ground[c] = Math.max(floor, height[c] - valley[c]);
  }
}

export interface FoundingOpts {
  /** Density needed: Σ forage within `radius` (box) ≥ threshold. */
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
  /** The capacity field crowds are read off (default 'forage'; a wild
   *  species' declared field when its crowds scout for themselves). */
  forageField?: string;
  /** Sugarscape hook: rank candidates by density PLUS weighted resource
   *  sums over the same box (e.g. [{field:'ore', weight:3}] makes
   *  prospector towns outrank equally-crowded farm hamlets). Crowds still
   *  gate via `threshold` — resources rank, crowds found. This is where
   *  day-boundary SUPPLY/DEMAND plugs in later: the settlement layer sets
   *  the weights from scarcity (metal dear → ore weight up), and founding
   *  starts answering the market (world-content §5). */
  score?: Array<{ field: string; weight: number }>;
  /** Candidate ELIGIBILITY, applied inside the scan (never as a post-
   *  filter): a cell for which this returns false is not a candidate at
   *  all, so it can't consume a spacing slot or skew score ranking — the
   *  ownership-mask requirement of the region tier (planet/refine.ts): a
   *  phantom sliver site accepted then filtered would still have blocked
   *  the real site beside it. Absent = every cell is eligible. */
  eligible?: (cell: number) => boolean;
  /** WATER MASK: the flow-accumulation field a site may not stand in
   *  (default 'river'; absent from the substrate ⇒ no mask). Towns sit on
   *  the BANK, not in the channel — without this the picker founds mid-
   *  river by construction, because `river > 45` is the unique global
   *  maximum of the `forage` field it ranks on (fertility 15 → lure 15 →
   *  forage 30) AND the exact cells zoom.ts calls unwalkable. Rejecting
   *  the channel doesn't cost the river its pull: `density` is a box-sum
   *  over `radius`, so a bank cell still counts the whole watercourse's
   *  crowds and still outranks dry land. Rivers stay the strongest
   *  founding signal in the world — they just stop being the site. */
  wetField?: string;
  /** Flow OVER which `wetField` is too much water to stand in. Default 45,
   *  exactly zoom.ts's `BLOCK_RIVER` — the line where terrain collision
   *  stops a creature walking. A town may not stand where its residents
   *  can't.
   *
   *  Deliberately NOT travel.ts's fording threshold (16). That line means
   *  "a route pays to cross here", and a town astride a fordable creek is
   *  a real town, not a bug. Masking it also masks the whole `15 < river
   *  <= 45` fertility band, which pushes foundings to the dry edge of a
   *  floodplain where their charter box (cities.ts, disk radius 3) catches
   *  far less farmland — towns that then never build a farm. Keeping the
   *  two thresholds distinct is the point: fordable = crossable, 45+ =
   *  unwalkable. */
  wetOver?: number;
}

export interface FoundingSite {
  /** Flat-chart coordinates of `cell` (x = cell % cols, y = cell / cols) —
   *  consumers' distance math and render placement read these. On curved
   *  topologies these become face-local chart coords; index-based reads
   *  should prefer `cell` + grid.topo. */
  x: number;
  y: number;
  cell: number;
  /** Σ forage in the box — the crowd a founding would harvest. */
  density: number;
  /** density + Σ weight × resource box-sums — the ranking key. */
  score: number;
}

/**
 * Scan the settled `forage` field for tiles dense enough to found a city
 * (world-content §5). Pure read, deterministic: candidates rank by
 * (score desc, cell index asc) and are accepted greedily under the
 * spacing rule against occupied AND already-accepted sites. The harvest /
 * entity+site creation is the caller's day-boundary transaction.
 */
export function findFoundingSites(grid: CellGrid, opts: FoundingOpts): FoundingSite[] {
  const {
    threshold, radius, minSpacing, occupied = [], forageField = 'forage', score = [], eligible,
    wetField = 'river', wetOver = 45,
  } = opts;
  const forage = grid.fields[forageField];
  if (!forage) return [];
  const { cols, topo } = grid;
  const scoreFields = score
    .map(s => ({ arr: grid.fields[s.field], weight: s.weight }))
    .filter(s => s.arr);
  const wet = grid.fields[wetField];

  const candidates: FoundingSite[] = [];
  for (let c = 0; c < topo.n; c++) {
    if (wet && wet[c] > wetOver) continue; // the channel is water, not a site
    if (eligible && !eligible(c)) continue;
    let density = 0;
    let rank = 0;
    topo.disk(c, radius, cell => {
      density += forage[cell];
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
