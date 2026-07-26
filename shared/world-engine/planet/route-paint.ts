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

import type { PlanetRoute } from "./routes.js";

type V3 = readonly [number, number, number];

/** Hard cap on paintable road half-width — sizes the spatial bins, so it is
 *  a build-time budget, not a style knob. Wider than any lane we draw. */
const MAX_HALF_W_M = 8;
/** Packed-dirt road colour (linear), blended toward at full strength inside
 *  the lane, feathered at the edge — deliberately matte and static. */
const ROAD_R = 0.24, ROAD_G = 0.175, ROAD_B = 0.105;
const PAINT_MAX = 0.8;

export interface RoutePaint {
  /** Merge a route set into the index under an idempotency key; returns
   *  false (no-op) when the key was already added. `halfWidthM` is the
   *  lane's TRUE half-width (clamped to the module budget). */
  addRoutes(key: string, routes: readonly PlanetRoute[], halfWidthM: number): boolean;
  /** Blend road colour into `rgb` where `dir` lies on a lane — true width,
   *  coverage-faded below the mesh's resolution (`vertSpanM`; 0 = exact). */
  tintAt(dir: V3, vertSpanM: number, rgb: [number, number, number]): void;
  /** Segments indexed so far (host diagnostics). */
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
  const key = (x: number, y: number, z: number): number =>
    (Math.floor((x + 1) / binU) * 2053 + Math.floor((y + 1) / binU)) * 2053 + Math.floor((z + 1) / binU);
  const register = (k: number, si: number): void => {
    const b = bins.get(k);
    if (b) { if (b[b.length - 1] !== si) b.push(si); } else bins.set(k, [si]);
  };

  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  const addedKeys = new Set<string>();

  return {
    addRoutes(addKey, routes, halfWidthM) {
      if (addedKeys.has(addKey)) return false;
      addedKeys.add(addKey);
      const halfW = Math.max(0.5, Math.min(MAX_HALF_W_M, halfWidthM));
      for (const route of routes) {
        const L = route.lengthM;
        if (!(L > 0)) continue;
        const vertexSpacing = L / Math.max(1, route.dirs.length - 1);
        const step = Math.max(25, Math.min(stepM, vertexSpacing * 2));
        const steps = Math.max(1, Math.ceil(L / step));
        dirAtArc(route, 0, a);
        for (let i = 0; i < steps; i++) {
          dirAtArc(route, (L * (i + 1)) / steps, b);
          const si = segs.length;
          segs.push(a[0], a[1], a[2], b[0], b[1], b[2], halfW);
          register(key(a[0], a[1], a[2]), si);
          register(key(b[0], b[1], b[2]), si);
          a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
        }
      }
      return true;
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
      if (qDist === Infinity) return;
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
    segmentCount: () => segs.length / 7,
  };
}
