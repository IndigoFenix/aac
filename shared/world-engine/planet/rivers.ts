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

type V3 = readonly [number, number, number];

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

// ── RIVER RELIEF — the network folded back into the TERRAIN ─────────────────
//
// Draped chrome (ribbons) can never track the terrain mesh: the quadtree's
// height at a point CHANGES WITH LOD (a coarse triangle chords across a
// concave valley), so anything draped at the true surface floats where the
// mesh is low and buries where it is high — there is no lift constant that
// fixes both. The stable strategy is to make the river part of the terrain
// itself:
//
//   - riverTintAt: paints water colour into the terrain VERTEX COLOURS within
//     the channel's half-width of the polylines. The paint moves with the mesh
//     at every LOD by construction. The mesh builder passes its own vertex
//     spacing so a thin channel widens to stay visible on coarse chunks (the
//     glyph exaggeration roads use, applied to colour instead of geometry).
//   - depthAt: a sub-cell VALLEY NOTCH subtracted from heightAt along the
//     curve. carveValleys cuts real valleys, but at CELL resolution — a
//     kilometre of depth spread over a hundreds-of-km cell is an invisible
//     0.5% dish. The notch is what makes the depression exist at the scale a
//     player sees. heightAt is the one seam every consumer reads (mesh, walk,
//     collision, drapes), so the cut is real everywhere at once.
//
// LAW GUARD (ground-vs-macro): the notch wraps surface.heightAt ONLY. The
// flow solve reads grid FIELDS, refinement seeds children from macroHeightAt —
// neither ever sees the notch, so no feedback loop.

/** Half-width of a watercourse at an accumulation, in metres — a channel's
 *  section grows with the root of its discharge. Shared by the paint, the
 *  notch, and the debug ribbons so they always agree on "how wide". */
export const RIVER_MIN_ACCUM = 16;
export function riverHalfWidthM(accum: number): number {
  return Math.max(80, Math.min(1200, 120 * Math.sqrt(accum / RIVER_MIN_ACCUM)));
}

/** Notch depth for a channel half-width, metres. Sub-cell render relief only
 *  (macro/fields never see it), so it reads in absolute human scale. */
const NOTCH_DEPTH_MAX_M = 150;
const notchDepthM = (halfW: number): number => Math.min(NOTCH_DEPTH_MAX_M, halfW * 0.4);
/** The valley shoulder: the notch profile reaches zero at this multiple of
 *  the water's half-width — banks, not a slot canyon. */
const SHOULDER = 2.5;

/** How much a coarse mesh may widen the PAINT (never the notch), as the cap
 *  on the vertex-spacing clamp — glyph width, radius-scaled. */
const paintHalfWidthCapM = (radius: number): number => Math.max(2000, radius * 0.002);

/** Linear-space water colour the paint blends toward (dull blue — static
 *  vertex colour, no specular, no motion: not the seizure hazard). */
const WATER_R = 0.045, WATER_G = 0.17, WATER_B = 0.40;
const PAINT_MAX = 0.85;

/** Interpolate a route's unit direction at arc position `s` (same walk the
 *  ribbon renderers do, THREE-free). */
function dirAtArc(route: PlanetRoute, s: number, out: [number, number, number]): void {
  const { cum, dirs, lengthM } = route;
  const ss = Math.max(0, Math.min(lengthM, s));
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= ss) lo = mid; else hi = mid;
  }
  const a = dirs[lo]!;
  const b = dirs[Math.min(lo + 1, dirs.length - 1)]!;
  const seg = cum[Math.min(lo + 1, cum.length - 1)]! - cum[lo]!;
  const f = seg > 1e-9 ? (ss - cum[lo]!) / seg : 0;
  const x = a[0] + (b[0] - a[0]) * f;
  const y = a[1] + (b[1] - a[1]) * f;
  const z = a[2] + (b[2] - a[2]) * f;
  const m = Math.hypot(x, y, z) || 1;
  out[0] = x / m; out[1] = y / m; out[2] = z / m;
}

export interface RiverRelief {
  rivers: RiverPolyline[];
  /** Blend water colour into `rgb` where `dir` lies within a channel.
   *  `minHalfWidthM` is the caller's vertex spacing clamp (capped). */
  tintAt(dir: V3, minHalfWidthM: number, rgb: [number, number, number]): void;
  /** Valley-notch depth at `dir`, metres (0 away from rivers). */
  depthAt(dir: V3): number;
}

/**
 * Build the spatial index over the extracted network: segments (unit-sphere
 * chords ~stepM long, each carrying its local half-width) hashed into 3D bins
 * sized to the largest query radius, so a lookup scans the 27 neighbouring
 * bins and takes the nearest segment. Deterministic; ~O(total river length).
 */
export function buildRiverRelief(built: BuiltPlanet, opts: RiverNetworkOpts = {}): RiverRelief | null {
  const rivers = extractRiverNetwork(built, opts);
  if (!rivers.length) return null;
  const radius = built.spec.radius;

  // Segment sampling step: fine enough to follow the chaikin curve (whose
  // wiggles are cell-sized), coarse enough to keep the index small.
  const stepM = Math.max(400, Math.min(4000, radius * 0.0005));

  // Max query reach: the paint's LOD-widened edge, or the notch shoulder.
  const maxReachM = Math.max(1.3 * paintHalfWidthCapM(radius), SHOULDER * riverHalfWidthM(4000));
  // Bin edge (unit-chord space): one bin ≥ reach + half a segment, so ±1-bin
  // scans see every segment that could matter.
  const binU = (1.15 * (maxReachM + stepM / 2)) / radius;

  const segs: number[] = []; // stride 7: ax ay az bx by bz halfW
  const bins = new Map<number, number[]>();
  const key = (x: number, y: number, z: number): number =>
    (Math.floor((x + 1) / binU) * 2053 + Math.floor((y + 1) / binU)) * 2053 + Math.floor((z + 1) / binU);
  const register = (k: number, si: number): void => {
    const b = bins.get(k);
    if (b) { if (b[b.length - 1] !== si) b.push(si); } else bins.set(k, [si]);
  };

  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  for (const river of rivers) {
    const L = river.route.lengthM;
    const steps = Math.max(1, Math.ceil(L / stepM));
    const w0 = riverHalfWidthM(river.accumSource);
    const w1 = riverHalfWidthM(river.accumMouth);
    dirAtArc(river.route, 0, a);
    for (let i = 0; i < steps; i++) {
      dirAtArc(river.route, (L * (i + 1)) / steps, b);
      const si = segs.length;
      const halfW = w0 + (w1 - w0) * ((i + 0.5) / steps);
      segs.push(a[0], a[1], a[2], b[0], b[1], b[2], halfW);
      register(key(a[0], a[1], a[2]), si);
      register(key(b[0], b[1], b[2]), si);
      a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
    }
  }
  const segArr = Float64Array.from(segs);

  // Nearest-segment scan. Returns channel-relative results through the two
  // out-params style below (kept allocation-free — this runs per mesh vertex).
  let qDist = Infinity;
  let qHalfW = 0;
  const query = (dx: number, dy: number, dz: number): void => {
    qDist = Infinity; qHalfW = 0;
    const bx = Math.floor((dx + 1) / binU);
    const by = Math.floor((dy + 1) / binU);
    const bz = Math.floor((dz + 1) / binU);
    for (let ix = bx - 1; ix <= bx + 1; ix++) {
      for (let iy = by - 1; iy <= by + 1; iy++) {
        for (let iz = bz - 1; iz <= bz + 1; iz++) {
          const cell = bins.get((ix * 2053 + iy) * 2053 + iz);
          if (!cell) continue;
          for (const si of cell) {
            const ax = segArr[si], ay = segArr[si + 1], az = segArr[si + 2];
            const vx = segArr[si + 3] - ax, vy = segArr[si + 4] - ay, vz = segArr[si + 5] - az;
            const wx = dx - ax, wy = dy - ay, wz = dz - az;
            const vv = vx * vx + vy * vy + vz * vz;
            let t = vv > 1e-18 ? (wx * vx + wy * vy + wz * vz) / vv : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const ex = wx - vx * t, ey = wy - vy * t, ez = wz - vz * t;
            const d = Math.sqrt(ex * ex + ey * ey + ez * ez) * radius; // chord ≈ arc at these scales
            if (d < qDist) { qDist = d; qHalfW = segArr[si + 6]; }
          }
        }
      }
    }
  };

  const hwCap = paintHalfWidthCapM(radius);
  return {
    rivers,
    tintAt(dir, minHalfWidthM, rgb) {
      query(dir[0], dir[1], dir[2]);
      if (qDist === Infinity) return;
      // Paint width: the channel's own, widened to the caller's vertex
      // spacing (capped) so coarse LODs keep a visible line.
      const hw = Math.max(qHalfW, Math.min(minHalfWidthM, hwCap));
      // Full water inside 0.8×hw, feathered to zero at 1.3×hw.
      const t = (1.3 * hw - qDist) / (0.5 * hw);
      if (t <= 0) return;
      const s = (t >= 1 ? 1 : t * t * (3 - 2 * t)) * PAINT_MAX;
      rgb[0] += (WATER_R - rgb[0]) * s;
      rgb[1] += (WATER_G - rgb[1]) * s;
      rgb[2] += (WATER_B - rgb[2]) * s;
    },
    depthAt(dir) {
      query(dir[0], dir[1], dir[2]);
      if (qDist === Infinity) return 0;
      const shoulder = SHOULDER * qHalfW; // TRUE width only — geometry never glyphs
      if (qDist >= shoulder) return 0;
      const f = 1 - qDist / shoulder;
      return notchDepthM(qHalfW) * f * f * (3 - 2 * f); // smooth banks, flat-ish floor
    },
  };
}

/**
 * Fold the river relief into a built planet's surface: recolor via
 * `surface.riverTintAt` (the mesh builder calls it per vertex) and notch the
 * valley into `surface.heightAt`. macroHeightAt is untouched — refinement and
 * the flow solve keep reading the uncarved potential (the LAW above).
 */
export function attachRiverRelief(built: BuiltPlanet, opts: RiverNetworkOpts = {}): RiverRelief | null {
  const relief = buildRiverRelief(built, opts);
  if (!relief) return null;
  const surface = built.surface;
  surface.riverTintAt = relief.tintAt;
  const base = surface.heightAt.bind(surface);
  surface.heightAt = (dir) => {
    const h = base(dir);
    if (h <= 2) return h; // the coast and the sea keep their line
    const d = relief.depthAt(dir);
    // Never notch below the coastal band: a riverbed stays land, at altitude.
    return d > 0 ? Math.max(2, h - d) : h;
  };
  return relief;
}
