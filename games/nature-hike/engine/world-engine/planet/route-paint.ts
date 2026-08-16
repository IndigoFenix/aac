// shared/world-engine/planet/route-paint.ts
//
// ROADS AS TERRAIN PAINT — the river-relief treatment applied to routes.
//
// Draped road ribbons have the same disease river ribbons had (rivers.ts):
// the quadtree's height at a point changes with LOD, so a draped ribbon
// floats where the mesh is low and buries where it is high — and the wide
// "map glyph" version washed the ground from altitude exactly like the
// glyphed river paint did. The stable answer is the same: paint the road
// into the terrain's own vertex colours at its TRUE width, and let a road
// narrower than the mesh can resolve FADE by coverage instead of widening.
// No notch, no water — a road is colour only.
//
// The index is GROWABLE like the river relief: the host merges route sets as
// they appear (the interstate net at founding, a refined region's lanes, a
// border stitch), idempotent per key, and repaints standing chunks through
// PlanetLod.refresh. Painted roads persist after a region evicts — they are
// the world's deterministic truth, not region chrome.
//
// THE REPAINT SEAM (growth phase C §3.4). Growable was not enough. A key's
// paint could never be taken back, which cost two things: a town RE-LAID
// mid-session kept its first connectors, and a refined highway span could
// not be painted at all, because its parent interstate is painted for its
// whole length and diverges from the refinement by a measured mean of
// 22.4 km — paint them both and the ground carries two roads where there is
// one. So the segments are PARTITIONED BY KEY and `replaceRoutes` swaps a
// key's paint for another: it matches the paint standing against the paint
// asked for, frees only what really left, lays only what really arrived, and
// hands back the ground it disturbed so the host can re-sample exactly that
// patch (repaintStaleFill's shape). A key may paint a route WHOLE or by ARC
// SPAN, which is how the parent survives everywhere the refinement did not
// take it over.

import type { PlanetRoute } from "./routes.js";

type V3 = readonly [number, number, number];

/** Hard cap on paintable road half-width — sizes the spatial bins, so it is
 *  a build-time budget, not a style knob. Wider than any lane we draw. */
const MAX_HALF_W_M = 8;
/** Packed-dirt road colour (linear), blended toward at full strength inside
 *  the lane, feathered at the edge — deliberately matte and static. */
const ROAD_R = 0.24, ROAD_G = 0.175, ROAD_B = 0.105;
const PAINT_MAX = 0.8;

/** What a key paints: a whole route, or ONE ARC SPAN of one. The span form
 *  is how a refined highway erases its parent — the parent re-paints as the
 *  spans the refinement did NOT take over. Omitting the bounds paints the
 *  whole route, byte-identically to passing the bare `PlanetRoute`, so every
 *  existing call site is unmoved. */
export type RoutePaintEntry =
  | PlanetRoute
  | { route: PlanetRoute; s0?: number; s1?: number };

/** The ground a repaint disturbed — everything that stopped being painted
 *  plus everything that started — as one ball in `refreshTerrain`'s own
 *  terms. NULL IS THE "NOTHING CHANGED" ANSWER: a `changed` flag beside a
 *  nullable return would be two ways to say one thing. */
export interface PaintPatch {
  /** Unit planet-local direction of the ball's centre. */
  center: [number, number, number];
  /** Chord radius in metres (PlanetLod.refresh measures chords). */
  radiusM: number;
}

export interface RoutePaint {
  /** Merge a route set into the index under an idempotency key; returns
   *  false (no-op) when the key was already added. `halfWidthM` is the
   *  lane's TRUE half-width (clamped to the module budget). */
  addRoutes(key: string, entries: readonly RoutePaintEntry[], halfWidthM: number): boolean;
  /** REPLACE what a key paints. Returns the patch of ground the swap
   *  disturbed (old ∪ new, tight — an unchanged segment is not disturbed),
   *  or null when the key already paints exactly this. Idempotent BY
   *  CONTENT, which is strictly stronger than `addRoutes`' idempotency by
   *  key: laying the same road twice is free, and laying a different one
   *  under the same key repaints instead of ghosting. */
  replaceRoutes(key: string, entries: readonly RoutePaintEntry[], halfWidthM: number): PaintPatch | null;
  /** Blend road colour into `rgb` where `dir` lies on a lane — true width,
   *  coverage-faded below the mesh's resolution (`vertSpanM`; 0 = exact). */
  tintAt(dir: V3, vertSpanM: number, rgb: [number, number, number]): void;
  /** LIVE segments indexed so far (host diagnostics). A replace leaves holes
   *  in the backing array rather than reindexing — every bin names a segment
   *  by index — and a hole is not a segment, so it is not counted. */
  segmentCount(): number;
}

/** Interpolate a route's unit direction at arc position `s` (the same walk
 *  rivers.ts does — kept local so this module stays dependency-light). */
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

/** A segment's identity as its seven numbers — what "the same paint" means
 *  when a replace decides whether anything moved. Doubles round-trip through
 *  their default string form exactly, so this is equality, not a hash. */
function signatureAt(flat: readonly number[], i: number): string {
  return `${flat[i]},${flat[i + 1]},${flat[i + 2]},${flat[i + 3]},${flat[i + 4]},${flat[i + 5]},${flat[i + 6]}`;
}

export function createRoutePaint(radius: number): RoutePaint {
  // Segment sampling step: fine enough to follow the curve, coarse enough to
  // keep the index small. Roads are narrow, so bins can be tight — the reach
  // is 1.3 × the width budget, plus half a step so the ±1-bin scan always
  // sees every segment that could matter (the rivers.ts sizing argument).
  const stepM = 400;
  const maxReachM = 1.3 * MAX_HALF_W_M;
  const binU = (1.15 * (maxReachM + stepM / 2)) / radius;

  const segs: number[] = []; // stride 7: ax ay az bx by bz halfW
  const bins = new Map<number, number[]>();
  // THE PARTITION: which start indices each key owns, ascending. Without it
  // there is no removal, and without removal there is no repaint seam.
  const keySegs = new Map<string, number[]>();
  // Slots a replace freed, sorted so pop() hands back the LOWEST hole first
  // — the backing array is holed, never compacted, because every bin names a
  // segment by its index and reindexing would invalidate all of them.
  const freeSlots: number[] = [];

  const binOf = (x: number, y: number, z: number): number =>
    (Math.floor((x + 1) / binU) * 2053 + Math.floor((y + 1) / binU)) * 2053 + Math.floor((z + 1) / binU);
  const register = (k: number, si: number): void => {
    const b = bins.get(k);
    if (b) { if (b[b.length - 1] !== si) b.push(si); } else bins.set(k, [si]);
  };
  const unregister = (k: number, si: number): void => {
    const b = bins.get(k);
    if (!b) return;
    const at = b.indexOf(si);
    if (at >= 0) b.splice(at, 1);
    if (!b.length) bins.delete(k); // an empty bin is a bin the scan can skip
  };

  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];

  /** Walk entries into a flat stride-7 array. PURE — nothing is indexed —
   *  so a replace can compare the paint it is about to lay against the paint
   *  already standing before it disturbs anything. */
  const emit = (entries: readonly RoutePaintEntry[], halfWidthM: number): number[] => {
    const halfW = Math.max(0.5, Math.min(MAX_HALF_W_M, halfWidthM));
    const out: number[] = [];
    for (const item of entries) {
      const entry: { route: PlanetRoute; s0?: number; s1?: number } =
        "route" in item ? item : { route: item };
      const route = entry.route;
      const L = route.lengthM;
      if (!(L > 0)) continue;
      const s0 = Math.min(Math.max(entry.s0 ?? 0, 0), L);
      const s1 = Math.min(Math.max(entry.s1 ?? L, s0), L);
      const arc = s1 - s0;
      if (!(arc > 0)) continue;
      // THE SAMPLE GRID BELONGS TO THE ROUTE, NOT THE SPAN — cuts at whole
      // multiples of the step from arc 0, at EVERY POLYLINE VERTEX, and at
      // the span's own two ends. Two things fall out of that.
      //
      // Cheap repaints: a span's segments are exactly the segments the whole
      // route would have laid there, so subtracting a refined stretch out of
      // a parent leaves everything either side untouched and the disturbed
      // patch is the stretch itself. Subdividing each span into equal pieces
      // instead moved every sample on the route and made the patch the whole
      // road (MEASURED: a 2 787 km refresh ball against 162 km).
      //
      // And the paint lands ON the road: a route's vertices are where it
      // TURNS, and a chord that straddles one cuts the corner — MEASURED at
      // up to 59 m on tier-0 lines and 107 m on a refined highway, whose
      // ~900 m vertices turn far more often than the 400 m step can follow.
      // The ribbon draws the true polyline, so uncut corners would put the
      // ground paint a hundred metres off the road you can see.
      const cum = route.cum;
      const vertexSpacing = L / Math.max(1, route.dirs.length - 1);
      const step = Math.max(25, Math.min(stepM, vertexSpacing * 2));
      dirAtArc(route, s0, a);
      let prev = s0;
      let vi = 0;
      while (vi < cum.length && cum[vi]! <= s0) vi++;
      for (let k = Math.ceil(s0 / step); ;) {
        // Merge the two ascending cut streams, grid before vertex on a tie.
        const grid = k * step;
        const vert = vi < cum.length ? cum[vi]! : Infinity;
        let at: number;
        if (grid <= vert) { at = grid; k++; if (grid === vert) vi++; }
        else { at = vert; vi++; }
        if (!(at < s1)) break;
        if (at > prev) {
          dirAtArc(route, at, b);
          out.push(a[0], a[1], a[2], b[0], b[1], b[2], halfW);
          a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
          prev = at;
        }
      }
      dirAtArc(route, s1, b);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], halfW);
    }
    return out;
  };

  /** Lay one emitted segment into a slot (a freed hole, else the tail) and
   *  bin both its ends. `owned` collects the key's indices. */
  const place = (flat: readonly number[], from: number, owned: number[]): void => {
    const si = freeSlots.length ? freeSlots.pop()! : segs.length;
    for (let k = 0; k < 7; k++) segs[si + k] = flat[from + k]!;
    register(binOf(segs[si]!, segs[si + 1]!, segs[si + 2]!), si);
    register(binOf(segs[si + 3]!, segs[si + 4]!, segs[si + 5]!), si);
    owned.push(si);
  };

  /** A ball covering a set of unit endpoints, in refresh terms: centroid,
   *  then the farthest point. Not the minimal enclosing ball — an honest
   *  over-cover only re-samples a chunk that did not need it, while an
   *  under-cover leaves stale colour standing. Feather margin included,
   *  because paint reaches 1.3 half-widths past the line. */
  const patchOf = (pts: readonly number[]): PaintPatch => {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < pts.length; i += 3) { cx += pts[i]!; cy += pts[i + 1]!; cz += pts[i + 2]!; }
    let m = Math.hypot(cx, cy, cz);
    // A change spread over the whole sphere has no centroid to speak of —
    // anchor on the first point and let the radius say "everywhere".
    if (!(m > 1e-9)) { cx = pts[0]!; cy = pts[1]!; cz = pts[2]!; m = Math.hypot(cx, cy, cz) || 1; }
    cx /= m; cy /= m; cz /= m;
    let far = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const dx = pts[i]! - cx, dy = pts[i + 1]! - cy, dz = pts[i + 2]! - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > far) far = d;
    }
    return { center: [cx, cy, cz], radiusM: Math.sqrt(far) * radius + maxReachM };
  };

  return {
    addRoutes(addKey, entries, halfWidthM) {
      if (keySegs.has(addKey)) return false;
      const flat = emit(entries, halfWidthM);
      const owned: number[] = [];
      for (let i = 0; i < flat.length; i += 7) place(flat, i, owned);
      keySegs.set(addKey, owned);
      return true;
    },
    replaceRoutes(addKey, entries, halfWidthM) {
      const flat = emit(entries, halfWidthM);
      const prev = keySegs.get(addKey) ?? [];
      // MATCH FIRST. Most repaints re-lay most of the same road (a region
      // lands and takes over one span of one interstate), so the pass that
      // matters is the one that finds what did NOT move: it keeps those
      // segments in place — no bin churn — and it is what makes the returned
      // patch the ground that really changed rather than the key's whole
      // extent. Duplicates are matched by count, lowest offset first, so the
      // outcome is a function of the inputs alone.
      const pool = new Map<string, number[]>();
      for (let i = 0; i < flat.length; i += 7) {
        const sig = signatureAt(flat, i);
        const list = pool.get(sig);
        if (list) list.push(i); else pool.set(sig, [i]);
      }
      const taken = new Uint8Array(flat.length / 7);
      const kept: number[] = [];
      const dropped: number[] = [];
      for (const si of prev) {
        const list = pool.get(signatureAt(segs, si));
        if (list?.length) { taken[list.shift()! / 7] = 1; kept.push(si); }
        else dropped.push(si);
      }
      const added: number[] = [];
      for (let i = 0; i < flat.length; i += 7) if (!taken[i / 7]) added.push(i);
      if (!dropped.length && !added.length) return null;

      // The disturbed ground is read off both sides BEFORE anything moves.
      const pts: number[] = [];
      for (const si of dropped) {
        pts.push(segs[si]!, segs[si + 1]!, segs[si + 2]!, segs[si + 3]!, segs[si + 4]!, segs[si + 5]!);
      }
      for (const i of added) {
        pts.push(flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!, flat[i + 4]!, flat[i + 5]!);
      }

      for (const si of dropped) {
        unregister(binOf(segs[si]!, segs[si + 1]!, segs[si + 2]!), si);
        unregister(binOf(segs[si + 3]!, segs[si + 4]!, segs[si + 5]!), si);
        segs[si + 6] = 0; // a freed slot paints nothing even if a bin leaked
        freeSlots.push(si);
      }
      if (dropped.length) freeSlots.sort((x, y) => y - x); // pop() = lowest hole
      for (const i of added) place(flat, i, kept);
      kept.sort((x, y) => x - y);
      keySegs.set(addKey, kept);
      return patchOf(pts);
    },
    tintAt(dir, vertSpanM, rgb) {
      const dx = dir[0], dy = dir[1], dz = dir[2];
      let qDist = Infinity;
      let qHalfW = 0;
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
              const d = Math.sqrt(ex * ex + ey * ey + ez * ez) * radius;
              if (d < qDist) { qDist = d; qHalfW = segs[si + 6]!; }
            }
          }
        }
      }
      // A zero half-width is a freed slot, never a lane — belt and braces
      // against a bin reference outliving its segment (it would divide by 0).
      if (qDist === Infinity || !(qHalfW > 0)) return;
      const hw = qHalfW;
      const t = (1.3 * hw - qDist) / (0.5 * hw);
      if (t <= 0) return;
      // The rivers.ts minification fade: coverage, never width.
      const coverage = vertSpanM > 0 ? Math.min(1, (2.6 * hw) / vertSpanM) : 1;
      const s = (t >= 1 ? 1 : t * t * (3 - 2 * t)) * PAINT_MAX * coverage;
      rgb[0] += (ROAD_R - rgb[0]) * s;
      rgb[1] += (ROAD_G - rgb[1]) * s;
      rgb[2] += (ROAD_B - rgb[2]) * s;
    },
    segmentCount: () => segs.length / 7 - freeSlots.length,
  };
}
