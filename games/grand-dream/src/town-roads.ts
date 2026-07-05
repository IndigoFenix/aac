/**
 * town-roads.ts — the street NETWORK of a town, derived closed-form from
 * the same ring geometry the town plan uses. Roads exist so that people
 * routed through town WALK LIKE PEOPLE: out their door, down their
 * street, around the ring, in along a cross street — never through a
 * neighbor's parlor (straight-line errands were wedging NPCs into house
 * walls).
 *
 *   • the PLAZA RING is a circular road at `rings[0]` (the plaza edge);
 *   • a RING ROAD runs in the 15 m gap between each pair of house rings
 *     (radius 28 + 15·i + 7.5 — house lots keep ≥ ~0.4 m clear of the
 *     center line by construction, see townPlan's jitter/depth bounds);
 *   • four SPOKES (E/S/W/N) run down the cross-street corridors the lot
 *     sequence already keeps clear, from the plaza out to the workshops.
 *
 * `roadRoute` plans door-to-door paths on this network: hop to the
 * nearest road, ride rings and spokes (whichever of the four spokes — or
 * a direct same-ring arc — is shortest), hop off at the destination.
 * Deterministic; every intermediate waypoint lies ON a road.
 */

import type { TownPlan } from "./zoom";

/** The plaza-edge circular road (house lots start at 28). */
export const PLAZA_ROAD_R = 22;
/** First house ring radius / ring pitch — must match townPlan's lotAt. */
const RING0 = 28;
const RING_STEP = 15;
/** Ring roads sit midway in the inter-ring gap. */
const RING_ROAD_OFF = 7.5;
/** Arc waypoint spacing (meters of chord). */
const ARC_STEP = 10;

export interface TownRoads {
  /** Circular road radii, ascending; `rings[0]` is the plaza ring. */
  rings: number[];
  /** Spokes run from the plaza ring out to this radius. */
  spokeMax: number;
}

interface Vec2 {
  x: number;
  y: number;
}

/** E, S, W, N in screen coordinates (y grows south). */
const SPOKE_THETA = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

export function buildTownRoads(plan: TownPlan): TownRoads {
  let maxR = RING0;
  for (const h of plan.houses) {
    const r = Math.hypot(h.dx + h.w / 2, h.dy + h.h / 2);
    if (r > maxR) maxR = r;
  }
  const lastRing = Math.max(0, Math.round((maxR - RING0) / RING_STEP));
  const rings = [PLAZA_ROAD_R];
  for (let i = 0; i <= lastRing; i++) rings.push(RING0 + RING_STEP * i + RING_ROAD_OFF);
  return { rings, spokeMax: Math.max(plan.radius, rings[rings.length - 1] + 1) };
}

interface Proj {
  /** Spoke index (0..3) when projected onto a spoke, -1 on a ring. */
  spoke: number;
  r: number;
  theta: number;
  d: number;
  pt: Vec2;
}

/** Nearest point of the road network to `p` (town-local meters). */
function project(roads: TownRoads, p: Vec2): Proj {
  const r = Math.hypot(p.x, p.y);
  const theta = r > 1e-9 ? Math.atan2(p.y, p.x) : 0;
  let best: Proj | null = null;
  for (const R of roads.rings) {
    const d = Math.abs(r - R);
    if (!best || d < best.d) {
      best = { spoke: -1, r: R, theta, d, pt: { x: Math.cos(theta) * R, y: Math.sin(theta) * R } };
    }
  }
  for (let k = 0; k < 4; k++) {
    const ct = Math.cos(SPOKE_THETA[k]);
    const st = Math.sin(SPOKE_THETA[k]);
    const along = p.x * ct + p.y * st;
    const perp = Math.abs(-p.x * st + p.y * ct);
    const alongC = Math.max(roads.rings[0], Math.min(roads.spokeMax, along));
    const d = Math.hypot(perp, along - alongC);
    if (d < best!.d) {
      best = { spoke: k, r: alongC, theta: SPOKE_THETA[k], d, pt: { x: ct * alongC, y: st * alongC } };
    }
  }
  return best!;
}

/** Shortest signed angular difference a→b in (-π, π]. */
function angDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Waypoints along the arc of radius R from θ1 to θ2 (shortest way),
 *  ending exactly at θ2. Empty when the arc is negligible. */
function arcPoints(R: number, th1: number, th2: number): Vec2[] {
  const d = angDelta(th1, th2);
  const len = Math.abs(d) * R;
  if (len < 0.5) return [];
  const steps = Math.max(1, Math.ceil(len / ARC_STEP));
  const out: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = th1 + (d * i) / steps;
    out.push({ x: Math.cos(t) * R, y: Math.sin(t) * R });
  }
  return out;
}

function nearestRing(roads: TownRoads, r: number): number {
  let best = roads.rings[0];
  for (const R of roads.rings) if (Math.abs(r - R) < Math.abs(r - best)) best = R;
  return best;
}

/** Door-to-door path riding the road network (town-local meters). The
 *  first and last points are `from`/`to` themselves (the hop between a
 *  doorstep and its road is the only off-road step, and doorsteps face
 *  their road). Consecutive duplicates are pruned. */
export function roadRoute(roads: TownRoads, from: Vec2, to: Vec2): Vec2[] {
  const a = project(roads, from);
  const b = project(roads, to);

  // Same spoke: pure radial travel.
  if (a.spoke >= 0 && a.spoke === b.spoke) {
    return prune([from, a.pt, b.pt, to]);
  }

  // Arcs happen on ring roads only — a spoke projection rides out to its
  // nearest ring before arcing.
  const Ra = a.spoke >= 0 ? nearestRing(roads, a.r) : a.r;
  const Rb = b.spoke >= 0 ? nearestRing(roads, b.r) : b.r;

  const arcLen = (R: number, t1: number, t2: number): number => Math.abs(angDelta(t1, t2)) * R;
  // Candidate transfers: each spoke, plus the direct same-ring arc.
  let bestCost = Infinity;
  let bestSpoke = -1; // -1 = direct arc (only valid when Ra === Rb)
  if (Ra === Rb) {
    bestCost = arcLen(Ra, a.theta, b.theta);
    bestSpoke = -1;
  }
  for (let k = 0; k < 4; k++) {
    const t = SPOKE_THETA[k];
    const cost = arcLen(Ra, a.theta, t) + Math.abs(Ra - Rb) + arcLen(Rb, t, b.theta);
    if (cost < bestCost) {
      bestCost = cost;
      bestSpoke = k;
    }
  }

  const pts: Vec2[] = [from, a.pt];
  if (a.spoke >= 0 && Math.abs(Ra - a.r) > 0.25) {
    pts.push({ x: Math.cos(a.theta) * Ra, y: Math.sin(a.theta) * Ra });
  }
  if (bestSpoke < 0) {
    pts.push(...arcPoints(Ra, a.theta, b.theta));
  } else {
    const t = SPOKE_THETA[bestSpoke];
    pts.push(...arcPoints(Ra, a.theta, t));
    if (Math.abs(Ra - Rb) > 0.25) pts.push({ x: Math.cos(t) * Rb, y: Math.sin(t) * Rb });
    pts.push(...arcPoints(Rb, t, b.theta));
  }
  pts.push(b.pt, to);
  return prune(pts);
}

function prune(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) out.push(p);
  }
  // The endpoints are the actual doorsteps — keep them EXACT even when
  // they landed within pruning distance of a road point.
  const fin = pts[pts.length - 1];
  const last = out[out.length - 1];
  if (last !== fin) {
    if (Math.hypot(fin.x - last.x, fin.y - last.y) > 0.5 || out.length < 2) out.push(fin);
    else out[out.length - 1] = fin;
  }
  return out.length >= 2 ? out : [pts[0], fin];
}

export function routeLength(pts: Array<{ x: number; y: number }>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}
