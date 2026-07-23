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

/** The lattice-agnostic tracer inputs — any grid whose flow solver recorded
 *  its drainage tree can trace, whatever its cells are placed on (the planet's
 *  cube-sphere, or a refined region's chart tiles — refine.ts). */
export interface TraceRiversOpts {
  n: number;
  river: ArrayLike<number>;
  height: ArrayLike<number>;
  /** The solver's own downstream pointer per cell (`<field>Down`); −1 = sink. */
  downstream: ArrayLike<number>;
  /** Cell → unit sphere direction. */
  posOf: (cell: number) => V3;
  radius: number;
  minAccum: number;
  /** Multiply accumulations on OUTPUT — a child chart converts its cell-units
   *  into the parent's (refine.ts: 1 / child-cells-per-parent). Default 1. */
  accumScale?: number;
  /** Emit only spans of cells this accepts (chart OWNERSHIP: the neighbour
   *  region emits its own spans of a shared stream, so nothing draws twice).
   *  The walk still traces whole chains, so junction claiming stays correct. */
  include?: (cell: number) => boolean;
  /** Route endpoint identity per cell (default the cell index; refine.ts
   *  passes composite village-style keys so tiers never collide). */
  keyOf?: (cell: number) => number;
}

/**
 * Trace a flow field into source→mouth polylines.
 *
 * The drainage forms an in-tree: every wet cell flows to exactly one
 * downstream neighbour (the edge computeFlow routed the catchment down),
 * rooted at the sea or at inland sinks. To cover each reach once, we walk
 * downstream from every SOURCE (a wet cell nothing wet drains into) and stop
 * when the path joins a reach another source already claimed — a tributary
 * ends exactly where it meets its trunk. Sources walk in DESCENDING
 * accumulation order (ties by cell — deterministic), so the mainstem claims
 * its whole course first and no small tributary "inherits" a trunk's tail.
 */
export function traceRiverPolylines(o: TraceRiversOpts): RiverPolyline[] {
  const { n, river, height, downstream, posOf, radius, minAccum } = o;
  const accumScale = o.accumScale ?? 1;
  const keyOf = o.keyOf ?? ((c: number) => c);
  const wet = (c: number): boolean => height[c] >= SEA_HEIGHT && river[c] > minAccum;

  const inWetDegree = new Uint16Array(n);
  for (let c = 0; c < n; c++) {
    if (!wet(c)) continue;
    const d = downstream[c];
    if (d >= 0 && wet(d)) inWetDegree[d]++;
  }
  const sources: number[] = [];
  for (let c = 0; c < n; c++) if (wet(c) && inWetDegree[c] === 0) sources.push(c);
  sources.sort((a, b) => river[b] - river[a] || a - b);

  const claimed = new Uint8Array(n);
  const out: RiverPolyline[] = [];
  const emit = (chain: number[]): void => {
    if (chain.length < 2) return;
    // Cell chain → smoothed unit-dir polyline (the road recipe, unchanged).
    const dirs = chaikinSphere(chaikinSphere(chain.map(cell => posOf(cell))));
    const route = routeFromDirs(dirs, radius, keyOf(chain[0]!), keyOf(chain[chain.length - 1]!));
    if (!route) return;
    // Accumulation at the ends. A mouth in the sea carries no accumulation of
    // its own, so use the last IN-river cell as the widest point.
    const last = chain[chain.length - 1]!;
    const mouthCell = height[last] < SEA_HEIGHT ? chain[chain.length - 2]! : last;
    out.push({ route, accumSource: river[chain[0]!] * accumScale, accumMouth: river[mouthCell] * accumScale });
  };

  for (const s of sources) {
    if (claimed[s]) continue;
    const chain: number[] = [s];
    claimed[s] = 1;
    let c = s;
    for (;;) {
      const next = downstream[c];
      if (next < 0) break; // inland sink — the reach ends in a lake (or off a chart edge)
      chain.push(next);
      if (height[next] < SEA_HEIGHT) break; // reached the sea — `next` is the mouth
      if (claimed[next]) break; // joined a trunk another source already drew
      claimed[next] = 1;
      c = next;
    }
    if (!o.include) { emit(chain); continue; }
    // Ownership windows: each maximal included run is its own polyline.
    let run: number[] = [];
    for (const cell of chain) {
      if (o.include(cell)) run.push(cell);
      else { emit(run); run = []; }
    }
    emit(run);
  }
  return out;
}

/**
 * Trace the planet's river field into source→mouth polylines.
 *
 * downstream[c]: THE SOLVER'S OWN drainage edge (`<field>Down`, recorded by
 * computeFlow over the depression-filled, flat-resolved potential). This
 * must NOT be re-derived from raw height: integer terrain is flats and
 * filled basins everywhere, and raw descent disagrees with the routed flow
 * on every one of them — the extracted chains then break mid-river and the
 * network shreds into short orphan stubs (the bug this replaced). The raw
 * fallback below only serves grids serialized before the pointer existed.
 */
export function extractRiverNetwork(built: BuiltPlanet, opts: RiverNetworkOpts = {}): RiverPolyline[] {
  const minAccum = opts.minAccum ?? 16;
  const grid = built.grid;
  const topo = built.topo;
  const riverField = opts.riverField ?? "river";
  const river = grid.fields[riverField];
  const height = grid.fields[opts.heightField ?? "height"];
  if (!river || !height || !topo.pos3) return [];
  const n = topo.n;

  const wet = (c: number): boolean => height[c] >= SEA_HEIGHT && river[c] > minAccum;
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  const downField = grid.fields[riverField + "Down"];
  const downstream = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    if (!wet(c)) continue;
    if (downField) {
      downstream[c] = downField[c];
    } else {
      const k = topo.neighbours(c, nb);
      let low = -1;
      let lowH = height[c];
      for (let j = 0; j < k; j++) {
        const ni = nb[j];
        if (height[ni] < lowH || (height[ni] === lowH && low >= 0 && ni < low)) { lowH = height[ni]; low = ni; }
      }
      downstream[c] = low;
    }
  }

  return traceRiverPolylines({
    n, river, height, downstream,
    posOf: cell => topo.pos3!(cell),
    radius: built.spec.radius,
    minAccum,
  });
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
 *  notch, and the debug ribbons so they always agree on "how wide". The FLOOR
 *  is tier-specific: base-tier reaches are ≥16 whole cells of catchment and
 *  draw at ≥80 m so a planet-scale line survives; a refined region's creeks
 *  (refine.ts, parent-equivalent accum ≪ 1) pass ~1 m and stay creek-sized —
 *  the paint's LOD glyph, not the width, keeps them visible from afar. */
export const RIVER_MIN_ACCUM = 16;
export function riverHalfWidthM(accum: number, floorM = 80): number {
  return Math.max(floorM, Math.min(1200, 120 * Math.sqrt(accum / RIVER_MIN_ACCUM)));
}

/** Notch depth for a channel half-width, metres. Sub-cell render relief only
 *  (macro/fields never see it), so it reads in absolute human scale. */
const NOTCH_DEPTH_MAX_M = 150;
const notchDepthM = (halfW: number): number => Math.min(NOTCH_DEPTH_MAX_M, halfW * 0.4);
/** The valley shoulder: the notch profile reaches zero at this multiple of
 *  the water's half-width — banks, not a slot canyon. */
const SHOULDER = 2.5;
/** How much of its notch a river FILLS with standing water (0..1 of the
 *  centerline depth). The water surface sits at one level across the channel
 *  — the top slice of the notch profile — so it reads as a flat run of water
 *  between dry banks, and its lateral reach (~1.25 × half-width at 0.5) stays
 *  channel-scale, never valley-scale. */
const RIVER_FILL = 0.5;

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
  /** Merge MORE polylines into the index under an idempotency key — a refined
   *  region's streams (refine.ts) joining the paint/notch when the region
   *  loads. Returns false (no-op) when the key was already added. Chunks
   *  built AFTER the add see the streams; the host repaints nearby chunks
   *  (lod.refresh) for the ones already standing. `halfWidthFloorM`: pass
   *  ~1 m for child-tier creeks (see riverHalfWidthM). */
  addRivers(key: string, rivers: RiverPolyline[], halfWidthFloorM?: number): boolean;
  /** Blend water colour into `rgb` where `dir` lies within a channel.
   *  `minHalfWidthM` is the caller's vertex spacing clamp (capped). */
  tintAt(dir: V3, minHalfWidthM: number, rgb: [number, number, number]): void;
  /** Valley-notch depth at `dir`, metres (0 away from rivers). */
  depthAt(dir: V3): number;
  /** THE WATER LAYER: depth of standing water above the notched ground at
   *  `dir` (0 = dry), filling `outFlow` with the unit DOWNSTREAM direction
   *  (planet-local, tangent-ish to the sphere) when wet. The river fills the
   *  top RIVER_FILL of its notch, so the water surface is level across the
   *  channel and the banks stay dry. TRUE width only — never the LOD glyph
   *  (glyphed water was the region-sized animated "sea" bug). */
  waterAt(dir: V3, outFlow: [number, number, number]): number;
  /** ONE query for the mesh builder's hot path: paint (tintAt) + water depth
   *  + flow direction (waterAt) from a single spatial lookup. */
  sampleAt(dir: V3, minHalfWidthM: number, rgb: [number, number, number], outFlow: [number, number, number]): number;
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

  // GROWABLE: refined regions merge their streams in later (addRivers), so
  // the index is a plain array + bins that accept appends. A segment is never
  // longer than stepM, so the binU sizing above stays valid for every add
  // (children are strictly narrower and sampled at least as finely).
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
  const addPolylines = (add: RiverPolyline[], floorM: number): void => {
    for (const river of add) {
      const L = river.route.lengthM;
      // Follow the curve at least as finely as its own vertices (a child
      // chart's wiggles are child-cell-sized, far under the base stepM).
      const vertexSpacing = L / Math.max(1, river.route.dirs.length - 1);
      const step = Math.max(25, Math.min(stepM, vertexSpacing * 2));
      const steps = Math.max(1, Math.ceil(L / step));
      const w0 = riverHalfWidthM(river.accumSource, floorM);
      const w1 = riverHalfWidthM(river.accumMouth, floorM);
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
  };
  addPolylines(rivers, 80);
  const addedKeys = new Set<string>();

  // Nearest-segment scan. Returns channel-relative results through the
  // out-params style below (kept allocation-free — this runs per mesh vertex).
  // qTx/qTy/qTz: the nearest segment's RAW downstream chord (segments are laid
  // source→mouth, so a→b IS the direction the water goes) — normalized by the
  // consumer that needs it, not per candidate.
  let qDist = Infinity;
  let qHalfW = 0;
  let qTx = 0, qTy = 0, qTz = 0;
  const query = (dx: number, dy: number, dz: number): void => {
    qDist = Infinity; qHalfW = 0; qTx = 0; qTy = 0; qTz = 0;
    const bx = Math.floor((dx + 1) / binU);
    const by = Math.floor((dy + 1) / binU);
    const bz = Math.floor((dz + 1) / binU);
    for (let ix = bx - 1; ix <= bx + 1; ix++) {
      for (let iy = by - 1; iy <= by + 1; iy++) {
        for (let iz = bz - 1; iz <= bz + 1; iz++) {
          const cell = bins.get((ix * 2053 + iy) * 2053 + iz);
          if (!cell) continue;
          for (const si of cell) {
            const ax = segs[si]!, ay = segs[si + 1]!, az = segs[si + 2]!;
            const vx = segs[si + 3]! - ax, vy = segs[si + 4]! - ay, vz = segs[si + 5]! - az;
            const wx = dx - ax, wy = dy - ay, wz = dz - az;
            const vv = vx * vx + vy * vy + vz * vz;
            let t = vv > 1e-18 ? (wx * vx + wy * vy + wz * vz) / vv : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const ex = wx - vx * t, ey = wy - vy * t, ez = wz - vz * t;
            const d = Math.sqrt(ex * ex + ey * ey + ez * ez) * radius; // chord ≈ arc at these scales
            if (d < qDist) { qDist = d; qHalfW = segs[si + 6]!; qTx = vx; qTy = vy; qTz = vz; }
          }
        }
      }
    }
  };

  const hwCap = paintHalfWidthCapM(radius);

  // The three reads off ONE query's state (qDist/qHalfW/qTx..) — so the mesh
  // builder's combined sampleAt pays a single spatial lookup per vertex.
  const paintFromQuery = (minHalfWidthM: number, rgb: [number, number, number]): void => {
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
  };
  const notchFromQuery = (): number => {
    if (qDist === Infinity) return 0;
    const shoulder = SHOULDER * qHalfW; // TRUE width only — geometry never glyphs
    if (qDist >= shoulder) return 0;
    const f = 1 - qDist / shoulder;
    return notchDepthM(qHalfW) * f * f * (3 - 2 * f); // smooth banks, flat-ish floor
  };
  const waterFromQuery = (outFlow: [number, number, number]): number => {
    // Water fills the TOP slice of the notch: its own surface sits at a
    // constant cut of (1−RIVER_FILL)×centerDepth, so depth here = how far the
    // local notch dips below that surface. Zero on the banks by construction.
    const cut = notchFromQuery();
    if (cut <= 0) return 0;
    const depth = cut - notchDepthM(qHalfW) * (1 - RIVER_FILL);
    if (depth <= 0) return 0;
    const m = Math.hypot(qTx, qTy, qTz);
    if (m > 1e-12) { outFlow[0] = qTx / m; outFlow[1] = qTy / m; outFlow[2] = qTz / m; }
    else { outFlow[0] = 0; outFlow[1] = 0; outFlow[2] = 0; }
    return depth;
  };

  return {
    rivers,
    addRivers(addKey, add, halfWidthFloorM = 1) {
      if (addedKeys.has(addKey)) return false;
      addedKeys.add(addKey);
      addPolylines(add, halfWidthFloorM);
      rivers.push(...add);
      return true;
    },
    tintAt(dir, minHalfWidthM, rgb) {
      query(dir[0], dir[1], dir[2]);
      paintFromQuery(minHalfWidthM, rgb);
    },
    depthAt(dir) {
      query(dir[0], dir[1], dir[2]);
      return notchFromQuery();
    },
    waterAt(dir, outFlow) {
      query(dir[0], dir[1], dir[2]);
      return waterFromQuery(outFlow);
    },
    sampleAt(dir, minHalfWidthM, rgb, outFlow) {
      query(dir[0], dir[1], dir[2]);
      paintFromQuery(minHalfWidthM, rgb);
      return waterFromQuery(outFlow);
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
  built.riverRelief = relief; // the host's handle for merging refined-region streams (addRivers)
  const surface = built.surface;
  surface.riverTintAt = relief.tintAt;
  surface.riverSampleAt = relief.sampleAt;
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
