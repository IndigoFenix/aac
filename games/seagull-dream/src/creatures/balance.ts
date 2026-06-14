// Whole-body balance — keep the center of mass over the support polygon.
//
// PURE MATH. No three.js — node-testable, server-importable, like genome /
// skeleton / gait.
//
// A standing creature is stable only while its CoM (projected to the ground)
// sits inside the convex hull of its planted feet. When it doesn't — a
// sprawl whose weight has drifted, a biped over a single foot — the body
// LEANS: it shifts horizontally so the CoM moves back over the feet. A fast
// gait adds a forward lean (momentum), which is what lets a runner or a biped
// spend part of the stride with the CoM ahead of the support.
//
// Coordinates: ground plane is (x, z); +z is forward (the travel direction).

export interface Pt {
  x: number;
  z: number;
}

/** Convex hull (CCW) of the support points — Andrew's monotone chain. */
export function convexHull2D(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

const distToSeg = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

/** Signed support margin: how far the CoM sits INSIDE the hull (> 0 = inside
 *  by that distance, < 0 = outside). A degenerate hull (a line / point / no
 *  feet) is never "inside", so the body is treated as needing to lean. */
export function supportMargin(com: Pt, hull: Pt[]): number {
  if (hull.length === 0) return -Infinity;
  if (hull.length === 1) return -Math.hypot(com.x - hull[0].x, com.z - hull[0].z);
  if (hull.length === 2) return -distToSeg(com, hull[0], hull[1]);
  let minD = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const elen = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    // CCW edge: a point to the LEFT (positive cross) is inside.
    const d = ((b.x - a.x) * (com.z - a.z) - (b.z - a.z) * (com.x - a.x)) / elen;
    minD = Math.min(minD, d);
  }
  return minD;
}

/** The horizontal shift that re-balances the body: 0 when the CoM already
 *  sits at least `margin` inside the support, else a move toward the feet's
 *  mean just large enough to cover the shortfall (the body leaning over its
 *  feet). */
export function balanceShift(com: Pt, feet: Pt[], margin: number): Pt {
  if (feet.length === 0) return { x: 0, z: 0 };
  const m = supportMargin(com, convexHull2D(feet));
  if (m >= margin) return { x: 0, z: 0 };
  let mx = 0, mz = 0;
  for (const f of feet) { mx += f.x; mz += f.z; }
  mx /= feet.length; mz /= feet.length;
  const tx = mx - com.x, tz = mz - com.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-6) return { x: 0, z: 0 };
  const move = Math.min(len, margin - m); // cover the shortfall, don't overshoot the mean
  return { x: (tx / len) * move, z: (tz / len) * move };
}
