// shared/world-engine/planet/rivers.ts
//
// RIVERS AS POLYLINES — the flow-accumulation field, traced into the drawable
// river network the way planetRoutes traces roads.
//
// WHY THIS EXISTS. A river is a CURVE — a 1-D path orders of magnitude longer
// than it is wide — but the substrate stores it as a FIELD (accumulation per
// cell). Painting the field colours cells, and a coloured cell is a blob the
// size of a cell; at planet scale that reads as "a region flooded", never as a
// river. Flow accumulation already knows the drainage TOPOLOGY (which cells the
// water crosses, and — via steepest descent — in what order); this module reads
// that topology out as source→mouth polylines so the renderer can draw the
// water as the thin line it actually is. Same recipe as roads: cell chain →
// pos3 per cell → double chaikin → routeFromDirs (planet/routes.ts).
//
// Data only, THREE-free, deterministic — the same built planet always yields
// the same rivers. Reads the BASE tier, because the flight renderer draws the
// base substrateSurface (refined regions never build a terrain mesh).

import { SEA_HEIGHT } from "../kernel/geology/tectonics.js";
import type { BuiltPlanet } from "./planet-game.js";
import { chaikinSphere, routeFromDirs, type PlanetRoute } from "./routes.js";

export interface RiverPolyline {
  /** The drapeable path, in the road/route shape (unit dirs + arc-metres). */
  route: PlanetRoute;
  /** Flow accumulation at the SOURCE end (narrowest) and the MOUTH end
   *  (widest). Accumulation rises monotonically downstream — more catchment —
   *  so the renderer ramps width between these along the arc. */
  accumSource: number;
  accumMouth: number;
}

export interface RiverNetworkOpts {
  /** Accumulation OVER which a cell carries a drawn river (default 16 —
   *  travel.ts's "genuine watercourse", the same line the fill and the tint
   *  use). Raise it to draw only the trunks and skip the capillaries. */
  minAccum?: number;
  /** Field names (defaults river / height — the MACRO height, which is the
   *  drainage potential the accumulation was solved over). */
  riverField?: string;
  heightField?: string;
}

/**
 * Trace the river field into source→mouth polylines.
 *
 * The drainage forms an in-tree: every wet cell flows to exactly one
 * downstream neighbour (steepest macro-height descent — the same edge
 * computeFlow routed the catchment down), rooted at the sea or at inland
 * sinks. To cover each reach once, we walk downstream from every SOURCE (a wet
 * cell nothing wet drains into) and stop when the path joins a reach another
 * source already claimed — so a tributary ends exactly where it meets its
 * trunk, and the trunk is drawn once, by whichever headwater reached it first.
 */
export function extractRiverNetwork(built: BuiltPlanet, opts: RiverNetworkOpts = {}): RiverPolyline[] {
  const minAccum = opts.minAccum ?? 16;
  const grid = built.grid;
  const topo = built.topo;
  const river = grid.fields[opts.riverField ?? "river"];
  const height = grid.fields[opts.heightField ?? "height"];
  if (!river || !height || !topo.pos3) return [];
  const n = topo.n;
  const radius = built.spec.radius;

  const wet = (c: number): boolean => height[c] >= SEA_HEIGHT && river[c] > minAccum;

  // downstream[c]: the lowest macro-height neighbour of a wet cell (ties to the
  // lowest cell index for determinism), or -1 for a sink. May point at a
  // BELOW-SEA cell — that neighbour is the river's MOUTH at the coast.
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  const downstream = new Int32Array(n).fill(-1);
  const inWetDegree = new Uint16Array(n);
  for (let c = 0; c < n; c++) {
    if (!wet(c)) continue;
    const k = topo.neighbours(c, nb);
    let low = -1;
    let lowH = height[c];
    for (let j = 0; j < k; j++) {
      const ni = nb[j];
      if (height[ni] < lowH || (height[ni] === lowH && low >= 0 && ni < low)) { lowH = height[ni]; low = ni; }
    }
    downstream[c] = low;
    if (low >= 0 && wet(low)) inWetDegree[low]++;
  }

  const claimed = new Uint8Array(n);
  const out: RiverPolyline[] = [];

  // Sources first, in cell order → deterministic claiming of shared trunks.
  for (let s = 0; s < n; s++) {
    if (!wet(s) || inWetDegree[s] > 0 || claimed[s]) continue;
    const chain: number[] = [s];
    claimed[s] = 1;
    let c = s;
    for (;;) {
      const next = downstream[c];
      if (next < 0) break; // inland sink — the reach ends in a lake
      chain.push(next);
      if (height[next] < SEA_HEIGHT) break; // reached the sea — `next` is the mouth
      if (claimed[next]) break; // joined a trunk another source already drew
      claimed[next] = 1;
      c = next;
    }
    if (chain.length < 2) continue;

    // Cell chain → smoothed unit-dir polyline (the road recipe, unchanged).
    const dirs = chaikinSphere(chaikinSphere(chain.map(cell => topo.pos3!(cell))));
    const route = routeFromDirs(dirs, radius, chain[0], chain[chain.length - 1]);
    if (!route) continue;

    // Accumulation at the ends. A mouth in the sea carries no accumulation of
    // its own, so use the last IN-river cell as the widest point.
    const mouthCell = height[chain[chain.length - 1]] < SEA_HEIGHT ? chain[chain.length - 2] : chain[chain.length - 1];
    out.push({ route, accumSource: river[chain[0]], accumMouth: river[mouthCell] });
  }

  return out;
}
