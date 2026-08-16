// shared/world-engine/planet/states.ts
//
// THE CIV LAYER'S THIRD RUNG: a settled planet's capitals claim TERRITORY.
// A state is the COST-VORONOI cell of its capital — every land cell belongs
// to the capital that is cheapest to reach under the same travel pricing all
// routes here pay (slopes, forests, fords; open sea claims nothing), so a
// mountain wall pushes a border exactly where it would turn a traveler
// around, and two capitals separated by ocean are never neighbours.
//
// Data only, THREE-free, deterministic: the same built planet always claims
// the same territory. A state is an INDEX into the founding city list and
// territory is a LABEL FIELD — so a future merge (two player-rulers joining
// crowns) is a relabel in the MUTATION layer, not new geometry here, and a
// village's state is simply the label of its region's tier-0 cell.

import { costClaims, edgeCost } from "../kernel/civ/travel.js";
import { chaikinSphere, planetTravelOpts } from "./routes.js";
import type { BuiltPlanet } from "./planet-game.js";
import type { PlanetCity } from "./cities.js";

export interface StateAdjacency {
  /** State indices (into the founding cities array), a < b. */
  a: number;
  b: number;
  /** Least capital-to-capital travel cost across their shared border, in
   *  flat-land-equivalent metres. Exact, and free: on a cost-Voronoi
   *  partition the cheapest path between two capitals crosses their shared
   *  border at its cheapest crossing, so min(claim(a) + edge + claim(b))
   *  over the border IS the least route cost. INFINITY when the states
   *  touch but no crossing is passable — a seed on an open-sea cell (a
   *  harbour city-state) borders its neighbour without a land route. */
  costM: number;
}

export interface PlanetStates {
  /** State index per tier-0 cell (-1 = unclaimed: open sea, and land the
   *  sea isolates from every capital). */
  stateOf: Int32Array;
  /** Claim cost per cell, flat-equivalent metres (Infinity = unclaimed). */
  costM: Float64Array;
  /** Adjacent state pairs (shared land border), cheapest-crossing priced. */
  adjacency: StateAdjacency[];
  /** Claimed cell pairs [a, b] (a < b) whose states differ — the raw
   *  material stateBorders draws. */
  borderCells: Array<[number, number]>;
}

/**
 * Claim the planet for its capitals. One multi-source Dijkstra over the
 * tier-0 substrate plus one adjacency scan — PURE (the grid is never
 * written) and deterministic in (built, cities).
 */
export function planetStates(built: BuiltPlanet, cities: readonly PlanetCity[]): PlanetStates {
  const grid = built.grid;
  const travel = planetTravelOpts(built);
  const mpc = travel.metresPerCell ?? 1000;
  const { owner, dist } = costClaims(grid, cities.map(c => c.cell), travel);

  const costM = new Float64Array(dist.length);
  for (let i = 0; i < dist.length; i++) costM[i] = dist[i]! * mpc;

  // Adjacency + border scan: every claimed neighbour pair with different
  // owners is a border edge; per state pair, keep the cheapest crossing.
  const borderCells: Array<[number, number]> = [];
  const cheapest = new Map<string, StateAdjacency>();
  const nb: number[] = new Array(grid.topo.maxDegree).fill(0);
  for (let i = 0; i < grid.topo.n; i++) {
    const si = owner[i]!;
    if (si < 0) continue;
    const k = grid.topo.neighbours(i, nb);
    for (let j = 0; j < k; j++) {
      const t = nb[j]!;
      if (t <= i) continue; // each unordered pair once
      const st = owner[t]!;
      if (st < 0 || st === si) continue;
      borderCells.push([i, t]);
      const a = Math.min(si, st);
      const b = Math.max(si, st);
      const key = `${a}:${b}`;
      // Crossing priced in the cheaper direction — a border is not a wall.
      const cross = Math.min(edgeCost(grid, i, t, travel), edgeCost(grid, t, i, travel));
      const joint = (dist[i]! + dist[t]! + cross) * mpc;
      const seen = cheapest.get(key);
      if (!seen) cheapest.set(key, { a, b, costM: joint });
      else if (joint < seen.costM) seen.costM = joint;
    }
  }
  const adjacency = [...cheapest.values()].sort((p, q) => p.a - q.a || p.b - q.b);
  return { stateOf: owner, costM, adjacency, borderCells };
}

export interface StatePairOpts {
  /** Drop adjacent pairs costlier than this multiple of the MEDIAN pair
   *  cost (default 3) — the net keeps every honest neighbour but no state
   *  is forced to pave a road across a continent-sized wasteland. */
  maxCostFactor?: number;
}

/** The road topology the states imply: every adjacent capital pair a cart
 *  could actually reach (untraversable borders — sea-locked seeds — drop),
 *  capped by relative cost. City-index pairs — planetRoutes' `pairs` option. */
export function statePairs(states: PlanetStates, opts: StatePairOpts = {}): Array<[number, number]> {
  const factor = opts.maxCostFactor ?? 3;
  const passable = states.adjacency.filter(x => Number.isFinite(x.costM));
  if (!passable.length) return [];
  const costs = passable.map(x => x.costM).sort((p, q) => p - q);
  const cap = costs[costs.length >> 1]! * factor;
  return passable.filter(x => x.costM <= cap).map(x => [x.a, x.b]);
}

// ── Borders: the claim map drawn as lines ───────────────────────────────────

const norm3 = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The borders as smoothed sphere polylines a renderer can drape — one
 * polyline per contiguous border run (closed loops around enclaves, open
 * chains where a border meets the sea or a multi-state corner).
 *
 * Geometry: a border edge separates two adjacent cells; on the cube-sphere's
 * quad lattice its endpoints are the LATTICE CORNERS where those two cells
 * meet their two flanking cells (found as adjacent neighbour pairs — no
 * corner table needed). Corner points are the normalized mean of the cells
 * that meet there, so the same corner derived from any of its edges lands on
 * the same key AND the same point; segments then chain by corner identity.
 */
export function stateBorders(
  built: BuiltPlanet,
  states: PlanetStates,
): Array<Array<readonly [number, number, number]>> {
  const topo = built.topo;
  const pos3 = topo.pos3;
  if (!pos3) return [];

  const cornerPt = new Map<string, readonly [number, number, number]>();
  const cornerOf = (cells: number[]): string => {
    const sorted = [...cells].sort((p, q) => p - q);
    const key = sorted.join(",");
    if (!cornerPt.has(key)) {
      const v: [number, number, number] = [0, 0, 0];
      for (const c of sorted) {
        const d = pos3(c);
        v[0] += d[0]; v[1] += d[1]; v[2] += d[2];
      }
      cornerPt.set(key, norm3(v));
    }
    return key;
  };

  const na: number[] = new Array(topo.maxDegree).fill(0);
  const nbr: number[] = new Array(topo.maxDegree).fill(0);
  const nc: number[] = new Array(topo.maxDegree).fill(0);
  const adjacent = (c: number, d: number): boolean => {
    const k = topo.neighbours(c, nc);
    for (let i = 0; i < k; i++) if (nc[i] === d) return true;
    return false;
  };

  // Each border cell pair → a segment between its two flanking corners.
  const links = new Map<string, string[]>(); // corner key → neighbours (dedup by segment)
  const segSeen = new Set<string>();
  const link = (k1: string, k2: string): void => {
    if (k1 === k2) return;
    const segKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    if (segSeen.has(segKey)) return;
    segSeen.add(segKey);
    (links.get(k1) ?? links.set(k1, []).get(k1)!).push(k2);
    (links.get(k2) ?? links.set(k2, []).get(k2)!).push(k1);
  };

  for (const [a, b] of states.borderCells) {
    const corners: string[] = [];
    const ka = topo.neighbours(a, na);
    const kb = topo.neighbours(b, nbr);
    for (let i = 0; i < ka && corners.length < 2; i++) {
      const c = na[i]!;
      if (c === b) continue;
      for (let j = 0; j < kb && corners.length < 2; j++) {
        const d = nbr[j]!;
        if (d === a || d === b) continue;
        if (c === d) {
          // A cube-corner meeting: three cells share the lattice vertex.
          const key = cornerOf([a, b, c]);
          if (!corners.includes(key)) corners.push(key);
        } else if (adjacent(c, d)) {
          const key = cornerOf([a, b, c, d]);
          if (!corners.includes(key)) corners.push(key);
        }
      }
    }
    // A lattice irregularity that yields one corner: fall back to the edge
    // midpoint so the chain still closes rather than gapping.
    if (corners.length === 1) {
      const key = `m:${Math.min(a, b)}:${Math.max(a, b)}`;
      if (!cornerPt.has(key)) {
        const da = pos3(a);
        const db = pos3(b);
        cornerPt.set(key, norm3([da[0] + db[0], da[1] + db[1], da[2] + db[2]]));
      }
      corners.push(key);
    }
    if (corners.length === 2) link(corners[0]!, corners[1]!);
  }

  // Chain segments into polylines: open runs first (from odd-degree
  // corners — sea mouths and multi-state meets), then the closed loops.
  // Key iteration follows insertion order, so the walk is deterministic.
  const used = new Set<string>();
  const out: Array<Array<readonly [number, number, number]>> = [];
  const walk = (start: string): void => {
    const chain = [start];
    let cur = start;
    let prev = "";
    for (;;) {
      const next = (links.get(cur) ?? []).find(k => {
        const segKey = cur < k ? `${cur}|${k}` : `${k}|${cur}`;
        return !used.has(segKey) && k !== prev;
      }) ?? (links.get(cur) ?? []).find(k => {
        const segKey = cur < k ? `${cur}|${k}` : `${k}|${cur}`;
        return !used.has(segKey);
      });
      if (!next) break;
      used.add(cur < next ? `${cur}|${next}` : `${next}|${cur}`);
      chain.push(next);
      prev = cur;
      cur = next;
    }
    if (chain.length < 2) return;
    const dirs = chain.map(k => cornerPt.get(k)!);
    out.push(chaikinSphere(chaikinSphere(dirs)));
  };
  for (const [key, nbs] of links) if (nbs.length % 2 === 1) walk(key);
  for (const key of links.keys()) {
    const nbs = links.get(key)!;
    const hasUnused = nbs.some(k => !used.has(key < k ? `${key}|${k}` : `${k}|${key}`));
    if (hasUnused) walk(key);
  }
  return out;
}
