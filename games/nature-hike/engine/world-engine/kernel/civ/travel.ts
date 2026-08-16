// Civilization tier — traversal costs, least-cost routing, chokepoint
// traffic, and road commitment over the cell substrate (kernel/cells).
//
// Every function is a PURE read of the grid's fields (commitRoads writes
// exactly one field, deterministically): no dynamics, no randomness, fixed
// scan orders — founding a route town must replay bit-identically, the
// worldgen.ts law. The chokepoint logic in one line: stepping is cheap on
// flat land (cheapest mounted on open grass), dear on slopes and through
// forest, ~6× through fords, impossible over open sea — so least-cost
// routes between hubs SQUEEZE through passes, fords, isthmuses and forest
// gaps, and the accumulated betweenness (travelTraffic) is a founding
// score field (FoundingOpts.score): towns appear where travelers must pass.
// Committed roads divide the cost, so later routes prefer built corridors —
// the feedback that grows a network. Construction economics deliberately
// absent: commitment is data.

import type { CellGrid } from '../cells/index';
import { SEA_HEIGHT } from '../geology/tectonics';
import { METRES_PER_CELL, METRES_PER_HEIGHT_UNIT } from '../../scale';

export interface TravelOpts {
  /** One height-field unit in metres (refine.ts: unitElev). The slope
   *  penalty is a dimensionless grade, so the model works at any tier. */
  metresPerUnit?: number;
  /** One cell-unit of center distance in metres (refine.ts: cellSizeM). */
  metresPerCell?: number;
  /** Sea line (default kernel/geology SEA_HEIGHT): height below = water. */
  seaHeight?: number;
  /** height ≤ seaHeight − margin = OPEN SEA, impassable (default 2 — the
   *  tectonic bake floors basins at 0..2; the top of that band stays a
   *  fordable shelf, the rest is Infinity). */
  deepSeaMargin?: number;
  /** river accumulation ≥ this = a genuine watercourse (default 16 —
   *  worldgenSubstrate's fertility band starts at river > 15). */
  riverThreshold?: number;
  /** Cost multiple for STEPPING INTO a water cell (default 6). */
  fordFactor?: number;
  /** Cost multiple when BOTH cells carry a committed road (default 0.35). */
  roadFactor?: number;
  /** Slope penalty stiffness: cost × (1 + slopeK·grade²) (default 25 —
   *  a 20% grade doubles the step, a wall-steep one is ~16×). */
  slopeK?: number;
  /** Grade at/above which a committed cell classifies "tunnel" (default
   *  0.78 ≈ tan 38° — the walker's wall threshold, one tier down). */
  wallGrade?: number;
  // --- Vegetation & mounts (the biosphere's travel rules) -------------------
  // Both fields are the ecology layer's abundance bakes (0..100); a grid
  // without them travels exactly as before — every term below is a no-op.
  /** Tree-abundance field (default "eco_tree"). Stepping OFF-ROAD into
   *  forest multiplies cost up to `forestFactor` at full abundance — routes
   *  squeeze through forest gaps and along open country, so chokepoint
   *  traffic (and route-town founding) collects at the wood's edges. */
  forestField?: string;
  /** Off-road cost multiple at full forest (default 3). */
  forestFactor?: number;
  /** Grass-abundance field (default "eco_grass") — where mounts pay. */
  grassField?: string;
  /** How mounted this traveler is, 0..1 (a town's horsepower saturation).
   *  Mounted steps divide cost by up to `mountFactor`: fully on roads, and
   *  off-road only on OPEN GRASS — forest negates the mount (no galloping
   *  under trees), and fords are never galloped (fordFactor unchanged). */
  mount?: number;
  /** Full-mount speed multiple (default 2). */
  mountFactor?: number;
  /** travelTraffic: routes per hub, to its K nearest fellow hubs by route
   *  cost (default 3) — the pair-count cap. */
  kNearest?: number;
  heightField?: string;
  riverField?: string;
  roadField?: string;
}

interface Resolved {
  height: Float64Array;
  river: Float64Array | null;
  road: Float64Array | null;
  tree: Float64Array | null;
  grass: Float64Array | null;
  mpu: number;
  mpc: number;
  sea: number;
  deep: number;
  riverMin: number;
  ford: number;
  roadF: number;
  slopeK: number;
  wallGrade: number;
  forestF: number;
  mount: number;
  mountF: number;
}

function resolve(grid: CellGrid, o: TravelOpts = {}): Resolved {
  const height = grid.fields[o.heightField ?? 'height'];
  if (!height) throw new Error('travel: the grid has no height field');
  const sea = o.seaHeight ?? SEA_HEIGHT;
  return {
    height,
    river: grid.fields[o.riverField ?? 'river'] ?? null,
    road: grid.fields[o.roadField ?? 'road'] ?? null,
    tree: grid.fields[o.forestField ?? 'eco_tree'] ?? null,
    grass: grid.fields[o.grassField ?? 'eco_grass'] ?? null,
    mpu: o.metresPerUnit ?? METRES_PER_HEIGHT_UNIT,
    mpc: o.metresPerCell ?? METRES_PER_CELL,
    sea,
    deep: sea - (o.deepSeaMargin ?? 2),
    riverMin: o.riverThreshold ?? 16,
    ford: o.fordFactor ?? 6,
    roadF: o.roadFactor ?? 0.35,
    slopeK: o.slopeK ?? 25,
    wallGrade: o.wallGrade ?? 0.78,
    forestF: o.forestFactor ?? 3,
    mount: Math.max(0, Math.min(1, o.mount ?? 0)),
    mountF: o.mountFactor ?? 2,
  };
}

const isWater = (r: Resolved, c: number): boolean =>
  r.height[c] < r.sea || (r.river !== null && r.river[c] >= r.riverMin);

/** Grade (rise/run, dimensionless) of the a→b edge. */
function edgeGrade(grid: CellGrid, r: Resolved, a: number, b: number): number {
  const d = Math.sqrt(grid.topo.dist2(a, b)) || 1;
  return (Math.abs(r.height[b] - r.height[a]) * r.mpu) / (d * r.mpc);
}

function stepCost(grid: CellGrid, r: Resolved, a: number, b: number): number {
  if (r.height[a] <= r.deep || r.height[b] <= r.deep) return Infinity; // open sea
  const d = Math.sqrt(grid.topo.dist2(a, b)) || 1; // base 1 on flat lattices; center distance elsewhere
  const g = edgeGrade(grid, r, a, b);
  let cost = d * (1 + r.slopeK * g * g);
  const onRoad = r.road !== null && r.road[a] > 0 && r.road[b] > 0;
  if (onRoad) {
    // A committed road is a CLEARED corridor: no vegetation drag, and a
    // mount pays in full — the mounted courier on a road is the fastest
    // thing in the world.
    cost *= r.roadF;
    if (r.mount > 0) cost /= 1 + r.mount * (r.mountF - 1);
  } else {
    const t = r.tree !== null ? Math.min(1, r.tree[b] / 100) : 0;
    if (t > 0) cost *= 1 + (r.forestF - 1) * t; // pushing through the wood
    if (r.mount > 0) {
      // Off-road, a mount only pays on OPEN GRASS — the sward share less
      // whatever canopy stands over it.
      const open = (r.grass !== null ? Math.min(1, r.grass[b] / 100) : 0) * (1 - t);
      if (open > 0) cost /= 1 + r.mount * (r.mountF - 1) * open;
    }
  }
  if (isWater(r, b)) cost *= r.ford; // entering a ford/shelf — never galloped
  return cost;
}

/** Cost of stepping between NEIGHBOR cells a → b (directional: the water
 *  ford applies on entry). Infinity = impassable (open sea). */
export function edgeCost(grid: CellGrid, a: number, b: number, opts?: TravelOpts): number {
  return stepCost(grid, resolve(grid, opts), a, b);
}

// --- Dijkstra ------------------------------------------------------------------

/** Multi-source Dijkstra over topo.neighbours. The heap orders (cost asc,
 *  cell index asc) and predecessors/owners update only on STRICT improvement,
 *  so every equal-cost choice resolves the same way on every run. `owner` is
 *  the index (into `froms`) of the seed that reached each cell cheapest.
 *  Stops early once every `until` cell is settled. */
function dijkstra(
  grid: CellGrid, r: Resolved, froms: number[], until?: Set<number>,
): { dist: Float64Array; prev: Int32Array; owner: Int32Array } {
  const n = grid.topo.n;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const owner = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const hc: number[] = [];
  const hi: number[] = [];
  const less = (x: number, y: number): boolean =>
    hc[x] < hc[y] || (hc[x] === hc[y] && hi[x] < hi[y]);
  const swap = (x: number, y: number): void => {
    const c = hc[x]; hc[x] = hc[y]; hc[y] = c;
    const i = hi[x]; hi[x] = hi[y]; hi[y] = i;
  };
  const push = (cost: number, cell: number): void => {
    hc.push(cost); hi.push(cell);
    let k = hc.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (!less(k, p)) break; swap(k, p); k = p; }
  };
  const pop = (): number => {
    const top = hi[0];
    const last = hc.length - 1;
    hc[0] = hc[last]; hi[0] = hi[last];
    hc.pop(); hi.pop();
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, rr = l + 1;
      let m = k;
      if (l < hc.length && less(l, m)) m = l;
      if (rr < hc.length && less(rr, m)) m = rr;
      if (m === k) break;
      swap(k, m); k = m;
    }
    return top;
  };

  for (let s = 0; s < froms.length; s++) {
    const f = froms[s];
    if (owner[f] !== -1) continue; // duplicate seed — the first claim stands
    dist[f] = 0;
    owner[f] = s;
    push(0, f);
  }
  const remaining = until ? new Set(until) : null;
  for (const f of froms) remaining?.delete(f);
  const nb = new Array<number>(grid.topo.maxDegree).fill(0);
  while (hc.length) {
    const c = pop();
    if (settled[c]) continue; // lazy deletion
    settled[c] = 1;
    if (remaining) { remaining.delete(c); if (remaining.size === 0) break; }
    const k = grid.topo.neighbours(c, nb);
    for (let j = 0; j < k; j++) {
      const t = nb[j];
      if (settled[t]) continue;
      const w = stepCost(grid, r, c, t);
      if (!Number.isFinite(w)) continue;
      const nd = dist[c] + w;
      if (nd < dist[t]) { dist[t] = nd; prev[t] = c; owner[t] = owner[c]; push(nd, t); }
    }
  }
  return { dist, prev, owner };
}

function walkPrev(prev: Int32Array, to: number): number[] {
  const cells: number[] = [];
  for (let c = to; c !== -1; c = prev[c]) cells.push(c);
  cells.reverse();
  return cells;
}

/** The least-cost route between two cells, or null when open sea (or a
 *  missing landbridge) disconnects them. `cells` runs from → to inclusive. */
export function leastCostRoute(
  grid: CellGrid, from: number, to: number, opts?: TravelOpts,
): { cells: number[]; cost: number } | null {
  const r = resolve(grid, opts);
  if (from === to) return { cells: [from], cost: 0 };
  const { dist, prev } = dijkstra(grid, r, [from], new Set([to]));
  if (!Number.isFinite(dist[to])) return null;
  return { cells: walkPrev(prev, to), cost: dist[to] };
}

/** COST-VORONOI CLAIMS: every reachable cell is claimed by the seed that
 *  reaches it CHEAPEST under the same pricing every route here pays — a
 *  mountain wall or a wide forest pushes a claim boundary exactly where it
 *  would turn a traveler around. One multi-source Dijkstra; `owner` is the
 *  seed INDEX per cell (-1 = unreachable: open sea and what it isolates),
 *  `dist` the claim cost. Deterministic: seeds seed in array order, ties
 *  resolve by the heap's (cost, cell) order, owners move only on strict
 *  improvement. */
export function costClaims(
  grid: CellGrid, seeds: number[], opts?: TravelOpts,
): { owner: Int32Array; dist: Float64Array } {
  const r = resolve(grid, opts);
  const { dist, owner } = dijkstra(grid, r, seeds);
  return { owner, dist };
}

/** Routes for EXPLICIT hub pairs — the caller already knows which hubs join
 *  (an adjacency graph, not a nearest-K guess). Unordered duplicates dedupe,
 *  unreachable pairs drop, and the result follows the input pair order, so
 *  the net is deterministic in (grid, pairs). One Dijkstra per distinct
 *  lower endpoint, targets batched — cost stays O(sources), not O(pairs). */
export function pairRoutes(
  grid: CellGrid,
  pairs: ReadonlyArray<readonly [number, number]>,
  opts?: TravelOpts,
): number[][] {
  const r = resolve(grid, opts);
  const bySource = new Map<number, number[]>();
  const order: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    if (a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let g = bySource.get(lo);
    if (!g) { g = []; bySource.set(lo, g); }
    g.push(hi);
    order.push([lo, hi]);
  }
  const found = new Map<string, number[]>();
  for (const [from, targets] of bySource) {
    const { dist, prev } = dijkstra(grid, r, [from], new Set(targets));
    for (const t of targets) {
      if (Number.isFinite(dist[t])) found.set(`${from}:${t}`, walkPrev(prev, t));
    }
  }
  const out: number[][] = [];
  for (const [lo, hi] of order) {
    const route = found.get(`${lo}:${hi}`);
    if (route) out.push(route);
  }
  return out;
}

// --- Betweenness (the chokepoint field) ------------------------------------------

/** Deterministic hub-pair routes: each hub routes to its kNearest fellow
 *  hubs BY ROUTE COST — one Dijkstra per hub, so the pair count stays
 *  O(hubs·K). Unordered pairs dedupe; the first (lower hub-array index)
 *  selection fixes a pair's route, so equal-cost alternatives never flap.
 *  Unreachable hubs (across open sea) simply drop out. */
export function hubRoutes(grid: CellGrid, hubs: number[], opts?: TravelOpts): number[][] {
  const r = resolve(grid, opts);
  const K = Math.max(1, opts?.kNearest ?? 3);
  const uniq: number[] = [];
  for (const h of hubs) if (!uniq.includes(h)) uniq.push(h);
  const routes: number[][] = [];
  const done = new Set<string>();
  for (let i = 0; i < uniq.length; i++) {
    const from = uniq[i];
    const others = uniq.filter(h => h !== from);
    if (!others.length) continue;
    const { dist, prev } = dijkstra(grid, r, [from], new Set(others));
    const ranked = others
      .filter(t => Number.isFinite(dist[t]))
      .sort((a, b) => dist[a] - dist[b] || a - b)
      .slice(0, K);
    for (const t of ranked) {
      const key = from < t ? `${from}:${t}` : `${t}:${from}`;
      if (done.has(key)) continue;
      done.add(key);
      routes.push(walkPrev(prev, t));
    }
  }
  return routes;
}

/** +1 on every cell of every route — the betweenness accumulator. */
export function trafficFromRoutes(n: number, routes: number[][]): Float64Array {
  const out = new Float64Array(n);
  for (const route of routes) for (const c of route) out[c] += 1;
  return out;
}

/** The CHOKEPOINT field: betweenness sampled over hub-pair least-cost
 *  routes (hubRoutes). Passes, fords and isthmuses accumulate traffic
 *  because every route squeezes through them — feed it to founding as
 *  score: [{ field: 'traffic', weight }] and route towns rise there. */
export function travelTraffic(grid: CellGrid, hubs: number[], opts?: TravelOpts): Float64Array {
  return trafficFromRoutes(grid.topo.n, hubRoutes(grid, hubs, opts));
}

// --- Road commitment (data, not economics) ----------------------------------------

export interface RoadSegment {
  cell: number;
  /** water cell → "bridge"; wall-steep entry edge → "tunnel"; else "road". */
  kind: 'road' | 'bridge' | 'tunnel';
}

/** Write the `road` field (created on the grid if absent — an extra field
 *  is inert to the rule engine and rides serialization) marking every
 *  route cell, and classify each NEWLY committed cell by the terrain it
 *  crosses: water → bridge, wall-steep entry edge (a route's first cell
 *  reads its exit edge) → tunnel, else road. Already-committed cells are
 *  skipped, so shared corridors and repeat commits stay idempotent.
 *  Committed roads divide edgeCost by ~1/roadFactor — later routes prefer
 *  the built network. */
export function commitRoads(
  grid: CellGrid, routes: number[][], opts?: TravelOpts,
): { road: Float64Array; segments: RoadSegment[] } {
  const r = resolve(grid, opts);
  const name = opts?.roadField ?? 'road';
  let road = grid.fields[name];
  if (!road) { road = new Float64Array(grid.topo.n); grid.fields[name] = road; }
  const segments: RoadSegment[] = [];
  for (const route of routes) {
    for (let i = 0; i < route.length; i++) {
      const c = route[i];
      if (road[c] > 0) continue;
      road[c] = 1;
      let kind: RoadSegment['kind'] = 'road';
      if (isWater(r, c)) {
        kind = 'bridge';
      } else {
        const from = i > 0 ? route[i - 1] : route.length > 1 ? route[1] : c;
        if (from !== c && edgeGrade(grid, r, from, c) >= r.wallGrade) kind = 'tunnel';
      }
      segments.push({ cell: c, kind });
    }
  }
  return { road, segments };
}
