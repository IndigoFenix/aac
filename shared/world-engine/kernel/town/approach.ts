/**
 * approach.ts — where a road ACTUALLY arrives at a town. An intercity
 * route is a least-cost polyline over the substrate (planet/routes.ts):
 * it curves around hills, so its bearing where it crosses the town edge
 * rarely matches the straight line to the neighbor city — the bearing
 * townBias historically grew the arterial with. These pure helpers close
 * that gap from both sides:
 *
 *   • routeApproachBearing / approachBearings — the route's TRUE bearing
 *     at the town radius, in the town's local frame. Hosts feed these to
 *     townBias (TownHost.roadBearings) so the street tree grows its
 *     arterials where the ribbons really come in.
 *   • spliceRouteAtTown — the RENDER-ONLY seam that guarantees the joint:
 *     clip the incident ribbon at the town edge and bridge it to the
 *     street tree's nearest arterial tip (the refineHighways law — route
 *     data, lengths and caravan arcs never change; carts project onto the
 *     spliced geometry per client).
 *
 * Geometry in, geometry out — deterministic, THREE-free, no state.
 */

import {
  routeFromDirs, routePointAt, type PlanetRoute,
} from "../../planet/routes.js";
import type { Street, Vec2 } from "./streets";

export type Vec3 = readonly [number, number, number];

/** Bearings quantize to 16 compass buckets (townBias's law: slow drift in
 *  the inputs must not re-lay a town under the player's feet). */
export const BEARING_QUANT = Math.PI / 8;
export const quantB = (a: number): number => Math.round(a / BEARING_QUANT) * BEARING_QUANT;

/** Smallest absolute angular separation between two bearings. */
function angSep(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A town's tangent frame on the planet — the surface-anchor convention
 *  every ground layer mounts with (world-lab attachSurfaceAnchor): town
 *  plan x runs along `east`, plan y along `north`. All unit vectors,
 *  planet-local. */
export interface TownFrame {
  center: Vec3;
  east: Vec3;
  north: Vec3;
}

/** Unit sphere direction → town-local metres (gnomonic, exact round-trip
 *  of toPlanetDir). Null on the far hemisphere. */
export function toTownLocal(frame: TownFrame, radius: number, dir: Vec3): Vec2 | null {
  const k = dot3(dir, frame.center);
  if (k <= 1e-6) return null;
  const s = radius / k;
  return { x: dot3(dir, frame.east) * s, y: dot3(dir, frame.north) * s };
}

/** Town-local metres → unit sphere direction (walk-chart's dirAt). */
export function toPlanetDir(frame: TownFrame, radius: number, p: Vec2): [number, number, number] {
  const { center: c, east: e, north: n } = frame;
  const v: [number, number, number] = [
    c[0] * radius + e[0] * p.x + n[0] * p.y,
    c[1] * radius + e[1] * p.x + n[1] * p.y,
    c[2] * radius + e[2] * p.x + n[2] * p.y,
  ];
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}

/**
 * The route's bearing where it crosses the town radius: the direction
 * from the town center to the route point `radiusM` metres of arc from
 * the town's endpoint (`end` names which endpoint the town is), in the
 * town's local frame. UNQUANTIZED — callers quantize where the street
 * law requires it. Null when the sample degenerates (a route shorter
 * than the radius collapses onto the center axis).
 */
export function routeApproachBearing(
  route: PlanetRoute, end: "a" | "b", frame: TownFrame, radiusM: number,
): number | null {
  const inset = Math.min(Math.max(0, radiusM), route.lengthM / 2);
  const s = end === "a" ? inset : route.lengthM - inset;
  const p = routePointAt(route, s);
  // Tangent-plane component of the sample relative to the town center.
  const k = dot3(p, frame.center);
  const t: Vec3 = [p[0] - frame.center[0] * k, p[1] - frame.center[1] * k, p[2] - frame.center[2] * k];
  if (Math.hypot(t[0], t[1], t[2]) < 1e-9) return null;
  return Math.atan2(dot3(t, frame.north), dot3(t, frame.east));
}

/**
 * True approach bearings for a town's incident routes, most important
 * first (the caller's route order carries importance), quantized to the
 * street law's compass buckets and deduped at growStreets' own gate
 * (two roads a bucket apart share one arterial). The result is what a
 * host hands townBias through TownHost.roadBearings.
 */
export function approachBearings(
  incident: ReadonlyArray<{ route: PlanetRoute; end: "a" | "b" }>,
  frame: TownFrame, radiusM: number, max = 2,
): number[] {
  const out: number[] = [];
  for (const { route, end } of incident) {
    if (out.length >= max) break;
    const b = routeApproachBearing(route, end, frame, radiusM);
    if (b === null) continue;
    const q = quantB(b);
    if (out.some(g => angSep(g, q) < 0.5)) continue;
    out.push(q);
  }
  return out;
}

/* ------------------- the render splice at the town edge ------------------- */

/** A gen-0 street's outer end — where an incident ribbon can join. */
export interface ArterialTip {
  street: number;
  /** Bearing of the tip from the plaza (town frame). */
  bearing: number;
  /** The street polyline's last point (town-local metres). */
  tip: Vec2;
  /** Unit outward direction of the street's last segment. */
  out: Vec2;
}

/** The street tree's arterial tips (gen 0, plaza ring excluded). */
export function arterialTips(
  streets: ReadonlyArray<Pick<Street, "id" | "gen" | "ring" | "pts">>,
): ArterialTip[] {
  const tips: ArterialTip[] = [];
  for (const s of streets) {
    if (s.gen !== 0 || s.ring || s.pts.length < 2) continue;
    const p = s.pts[s.pts.length - 1]!;
    const q = s.pts[s.pts.length - 2]!;
    const len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
    tips.push({
      street: s.id,
      bearing: Math.atan2(p.y, p.x),
      tip: { x: p.x, y: p.y },
      out: { x: (p.x - q.x) / len, y: (p.y - q.y) / len },
    });
  }
  return tips;
}

/** The tip whose bearing is nearest `bearing` (ties keep list order). */
export function nearestArterialTip(
  tips: readonly ArterialTip[], bearing: number,
): ArterialTip | null {
  let best: ArterialTip | null = null;
  let bestSep = Infinity;
  for (const t of tips) {
    const sep = angSep(t.bearing, bearing);
    if (sep < bestSep) { bestSep = sep; best = t; }
  }
  return best;
}

/** One corner-cutting pass in the plane, endpoints pinned. */
function chaikin2(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [pts[0]!];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    out.push(
      { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
      { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
    );
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/**
 * The connector bridging the ribbon's clip point to an arterial tip:
 * leaves the clip point along the route's own travel direction
 * (`clipDir`, unit, pointing into town), arrives along the arterial's
 * axis, smoothed so the joint never reads as a kink. First point is
 * exactly `clip`, last exactly the tip.
 */
export function spliceConnector(clip: Vec2, clipDir: Vec2, tip: ArterialTip): Vec2[] {
  const d = Math.hypot(tip.tip.x - clip.x, tip.tip.y - clip.y);
  if (d < 1) return [clip, { x: tip.tip.x, y: tip.tip.y }];
  const k = Math.min(d / 3, 40);
  return chaikin2(chaikin2([
    clip,
    { x: clip.x + clipDir.x * k, y: clip.y + clipDir.y * k },
    { x: tip.tip.x + tip.out.x * k, y: tip.tip.y + tip.out.y * k },
    { x: tip.tip.x, y: tip.tip.y },
  ]));
}

/** What a renderer swaps in for a route's last stretch into a town. */
export interface RouteTownSplice {
  /** PARENT arc span the connector replaces (metres on the parent). */
  s0: number;
  s1: number;
  /** Connector geometry PARAM-ALIGNED with the span: parent arc s0 maps
   *  to connector arc 0 — the override shape caravans project through. */
  route: PlanetRoute;
  /** The same connector oriented clip → tip, for ribbon drawing. */
  draw: PlanetRoute;
  /** The arterial street joined (draw-dedupe key for shared tips). */
  street: number;
}

/**
 * Clip `route` at the town edge and bridge it to the bearing-nearest
 * arterial tip. RENDER-ONLY by construction: the parent route is read,
 * never written, and the returned span mapping preserves the parent's
 * caravan parametrization. Null when the splice cannot hold (no
 * arterials, towns so close their radii overlap, a degenerate sample) —
 * callers keep the plain ribbon there.
 */
export function spliceRouteAtTown(
  route: PlanetRoute, end: "a" | "b", frame: TownFrame,
  townRadiusM: number, tips: readonly ArterialTip[], planetRadius: number,
): RouteTownSplice | null {
  if (!tips.length) return null;
  const bearing = routeApproachBearing(route, end, frame, townRadiusM);
  if (bearing === null) return null;
  const tip = nearestArterialTip(tips, bearing)!;
  // Clip OUTSIDE the joined tip so the connector always runs inward.
  const clipR = Math.max(townRadiusM, Math.hypot(tip.tip.x, tip.tip.y) + 20);
  if (route.lengthM < clipR * 2.2) return null;
  const sEdge = end === "a" ? clipR : route.lengthM - clipR;
  const clip = toTownLocal(frame, planetRadius, routePointAt(route, sEdge));
  if (!clip) return null;
  const sIn = end === "a" ? sEdge - 30 : sEdge + 30;
  const inner = toTownLocal(frame, planetRadius, routePointAt(route, sIn));
  if (!inner) return null;
  const dl = Math.hypot(inner.x - clip.x, inner.y - clip.y) || 1;
  const clipDir = { x: (inner.x - clip.x) / dl, y: (inner.y - clip.y) / dl };
  const pts = spliceConnector(clip, clipDir, tip);
  const dirs = pts.map(p => toPlanetDir(frame, planetRadius, p));
  const fwd = routeFromDirs(dirs, planetRadius, -2, -2);
  const rev = routeFromDirs([...dirs].reverse(), planetRadius, -2, -2);
  if (!fwd || !rev) return null;
  // Parent arc grows a→b, so the town-at-`a` span [0, sEdge] must map its
  // LOW arc to the tip (the town end) — the reversed connector.
  return end === "a"
    ? { s0: 0, s1: sEdge, route: rev, draw: fwd, street: tip.street }
    : { s0: sEdge, s1: route.lengthM, route: fwd, draw: fwd, street: tip.street };
}
