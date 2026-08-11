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
 *   • townRoadSeeds — THE SEAM (growth phase B §2.1). A bearing is all the
 *     old street layer could hear; what a town actually grows around is the
 *     ROAD ITSELF. This turns a city's incident routes into `GrowSeed`s in
 *     the town's own metres: the most-opposed pair of PORTS becomes one
 *     through-road SPAN (the baseline the town forms along), every other
 *     port a spur running in to meet it. Routes the overlap rule left
 *     UNCLIPPED (portTerminateRoute: neighbours closer than their own
 *     extents have no open country between them, so no port) yield nothing
 *     — spans are optional by construction and the stub fallback stands.
 *   • spliceRouteAtTown — PORT → GATE. Routes END at the town's extent
 *     (planet/routes.ts portTerminateRoute: the PORT LAW at generation).
 *     When the town's own baseline reaches that port — a span-seeded town —
 *     THE GATE IS THE PORT and there is nothing to splice. Only a town whose
 *     streets stop short (the stub fallback) still needs the connector that
 *     bends the road's last stretch onto its nearest gate (the refineHighways
 *     law — route data, lengths and caravan arcs never change; carts project
 *     onto the spliced geometry per client).
 *
 * Geometry in, geometry out — deterministic, THREE-free, no state.
 */

import {
  routeFromDirs, routePointAt, type PlanetRoute,
} from "../../planet/routes.js";
import type { GrowSeed, Street, TownPort, Vec2 } from "./streets";

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
 *
 * PORTS ARE PLURAL (pairwise over single artery): ONE bearing per incident
 * route, up to `max` — a crossroads town with five roads grows five
 * arterials, not two. The dedup gate still collapses roads that arrive on
 * the same compass bucket.
 */
export function approachBearings(
  incident: ReadonlyArray<{ route: PlanetRoute; end: "a" | "b" }>,
  frame: TownFrame, radiusM: number, max = 6,
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

/* ---------------- THE SEAM: incident routes → growth seeds --------------- */

/** One end of one incident road, read in the town's own metres. */
export interface RoadPort {
  /** The port itself — where the route stops, town-local metres. */
  at: Vec2;
  /** Unit direction of travel INTO town at the port. */
  inward: Vec2;
  /** Bearing of the port from the town frame's origin. */
  bearing: number;
  /** The road's port-to-port length (its importance, and the canonical
   *  sort key — an interstate outranks a village lane). */
  lengthM: number;
  /** Endpoint-identity key, order-independent — the sort's tiebreak. */
  key: string;
}

/** How far back along the road the inward tangent is sampled. Short enough
 *  that a bend near the gate still reads, long enough that the polyline's
 *  own chaikin wobble doesn't. */
const PORT_TANGENT_M = 60;

/** How far apart two gates must stand, in bearing, before the road between
 *  them reads as passing THROUGH the town rather than doubling back around
 *  it. Below this the pair is two roads out of the same side, and each gets
 *  its own spur instead of a hairpin "through road". */
export const THROUGH_MIN_SEP = 1.9;

/** Below this the road's port and a declared town gate are THE SAME POINT
 *  and no connector exists between them (§2.2 — the gate IS the port). */
export const PORT_MEET_M = 12;

/**
 * A route end read as a PORT, or null when it isn't one.
 *
 * THE OVERLAP RULE (planet/routes.ts): where two towns' extents swallow the
 * whole road, `portTerminateRoute` hands the route back UNCLIPPED and its
 * endpoint is still the city cell's own centre. That is not a port — there
 * is no boundary crossing into open country — so it seeds nothing. The test
 * is the endpoint's own radius: a port sits ON the extent, an unclipped
 * endpoint sits at the origin, and nothing lands between.
 */
export function roadPortOf(
  route: PlanetRoute, end: "a" | "b", frame: TownFrame,
  planetRadius: number, extentM: number,
): RoadPort | null {
  const sPort = end === "a" ? 0 : route.lengthM;
  const at = toTownLocal(frame, planetRadius, routePointAt(route, sPort));
  if (!at) return null;
  const r = Math.hypot(at.x, at.y);
  if (r < extentM * 0.5 || r > extentM * 1.5) return null;
  // A sample further ALONG the road (i.e. outside the town): port − sample
  // is the direction a traveller faces walking in.
  const back = Math.min(PORT_TANGENT_M, route.lengthM / 2);
  const outside = toTownLocal(
    frame, planetRadius, routePointAt(route, end === "a" ? back : route.lengthM - back),
  );
  if (!outside) return null;
  const dx = at.x - outside.x;
  const dy = at.y - outside.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  const lo = Math.min(route.a, route.b);
  const hi = Math.max(route.a, route.b);
  return {
    at,
    inward: { x: dx / d, y: dy / d },
    bearing: Math.atan2(at.y, at.x),
    lengthM: route.lengthM,
    key: `${lo}:${hi}:${end}`,
  };
}

/** A smooth in-town path leaving `a` along `da` and arriving at `b` along
 *  `db` (both unit, both pointing the way travel goes). Endpoints are
 *  EXACT through the smoothing — the port the kernel lays its baseline to
 *  is the same point the route ends at, to the float. */
function bendPath(a: Vec2, da: Vec2, b: Vec2, db: Vec2): Vec2[] {
  const k = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) / 3);
  let pts: Vec2[] = [
    a,
    { x: a.x + da.x * k, y: a.y + da.y * k },
    { x: b.x - db.x * k, y: b.y - db.y * k },
    b,
  ];
  for (let i = 0; i < 3; i++) pts = chaikin2(pts);
  return pts;
}

/**
 * THE SEAM (§2.1): a city's incident roads → the seed set its street tree
 * grows around, in town-local metres.
 *
 * The most-opposed pair of ports is the road that PASSES THROUGH — one
 * `span` seed carrying both ports, which the kernel lays whole as street 0
 * (the baseline). Every other port becomes its own one-ended span running
 * from the town's middle out to its gate; the kernel attaches those by an
 * access lane, so the tree stays a tree and only the FAR end is a port.
 *
 * DETERMINISTIC IN (planet, city): ports are sorted by road length then by
 * endpoint identity, so the caller's incident ORDER — which depends on which
 * regions happen to be streamed — cannot change the answer. Stitch-pair
 * roads are excluded upstream (the caller's own law) and inherited here.
 *
 * Returns [] when no incident route ports at this town (the overlap rule on
 * a compressed planet, or a genuinely roadless site): the caller falls back
 * to bearings → stub seeds, exactly as before the seam existed.
 */
export function townRoadSeeds(
  incident: ReadonlyArray<{ route: PlanetRoute; end: "a" | "b" }>,
  frame: TownFrame, planetRadius: number, extentM: number, max = 6,
): GrowSeed[] {
  const found: RoadPort[] = [];
  for (const { route, end } of incident) {
    const p = roadPortOf(route, end, frame, planetRadius, extentM);
    if (p) found.push(p);
  }
  found.sort((a, b) => b.lengthM - a.lengthM || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // One gate per compass bucket — growStreets' own dedup law, applied here
  // so two roads arriving together share a gate instead of crowding two.
  const gates: RoadPort[] = [];
  for (const p of found) {
    if (gates.length >= max) break;
    if (gates.some(g => angSep(g.bearing, p.bearing) < 0.5)) continue;
    gates.push(p);
  }
  if (!gates.length) return [];

  // The THROUGH road: the most-opposed pair (ties keep canonical order).
  let ia = -1;
  let ib = -1;
  let bestSep = -1;
  for (let i = 0; i < gates.length; i++) {
    for (let j = i + 1; j < gates.length; j++) {
      const sep = angSep(gates[i]!.bearing, gates[j]!.bearing);
      if (sep > bestSep + 1e-9) { bestSep = sep; ia = i; ib = j; }
    }
  }
  const seeds: GrowSeed[] = [];
  const spent = new Set<number>();
  if (bestSep >= THROUGH_MIN_SEP) {
    const a = gates[ia]!;
    const b = gates[ib]!;
    seeds.push({
      kind: "span",
      pts: bendPath(a.at, a.inward, b.at, { x: -b.inward.x, y: -b.inward.y }),
      portA: true,
      portB: true,
    });
    spent.add(ia);
    spent.add(ib);
  }
  // Every remaining road ENDS here: a spur from the town's middle out to
  // its gate. The kernel joins its near end to the nearest network point,
  // so the near end is never a port — only the gate is.
  for (let i = 0; i < gates.length; i++) {
    if (spent.has(i)) continue;
    const g = gates[i]!;
    const inLen = Math.hypot(g.at.x, g.at.y) || 1;
    const away = { x: g.at.x / inLen, y: g.at.y / inLen };
    seeds.push({
      kind: "span",
      pts: bendPath({ x: 0, y: 0 }, away, g.at, { x: -g.inward.x, y: -g.inward.y }),
      portB: true,
    });
  }
  return seeds;
}

/* ------------------- the render splice at the town edge ------------------- */

/** A GATE: where an incident ribbon can join the street tree. */
export interface ArterialTip {
  street: number;
  /** Which end of that street (0 = origin, 1 = far tip). */
  end: 0 | 1;
  /** Bearing of the gate from the town frame's origin. */
  bearing: number;
  /** The gate point (town-local metres). */
  tip: Vec2;
  /** Unit outward direction of the street's last segment at that end. */
  out: Vec2;
}

/** The gate at one end of a street, or null when the street is a point. */
function gateAt(s: Pick<Street, "id" | "pts">, end: 0 | 1): ArterialTip | null {
  const n = s.pts.length;
  if (n < 2) return null;
  const p = end === 0 ? s.pts[0]! : s.pts[n - 1]!;
  const q = end === 0 ? s.pts[1]! : s.pts[n - 2]!;
  const len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
  return {
    street: s.id,
    end,
    bearing: Math.atan2(p.y, p.x),
    tip: { x: p.x, y: p.y },
    out: { x: (p.x - q.x) / len, y: (p.y - q.y) / len },
  };
}

/**
 * THE TOWN'S GATES.
 *
 * Given the street tree's DECLARED ports (`TownStreets.ports` — the road out
 * of town is an output of growth now, growth-phase-B §1.2/§1.3), those ARE
 * the gates: the baseline's own span ends for a route town, the outer tips
 * of the arterials that continue it for a stub town.
 *
 * Without them — a hand-built net, a legacy payload — the fallback re-reads
 * gen-0 semantics: every gen-0 street's outer tip AND the baseline's two
 * ends. The baseline used to be excluded because the plaza ring was topology
 * and not pavement; street 0 is a real road now, so its ends are real gates.
 */
export function arterialTips(
  streets: ReadonlyArray<Pick<Street, "id" | "gen" | "baseline" | "pts">>,
  ports?: readonly TownPort[],
): ArterialTip[] {
  const tips: ArterialTip[] = [];
  if (ports?.length) {
    for (const p of ports) {
      const byIndex = streets[p.street];
      const s = byIndex?.id === p.street ? byIndex : streets.find(x => x.id === p.street);
      const gate = s ? gateAt(s, p.end) : null;
      if (gate) tips.push(gate);
    }
    return tips;
  }
  for (const s of streets) {
    if (s.gen !== 0 || s.pts.length < 2) continue;
    if (s.baseline) {
      const a = gateAt(s, 0);
      if (a) tips.push(a);
    }
    const b = gateAt(s, 1);
    if (b) tips.push(b);
  }
  return tips;
}

/** Widest angle a road may be bent through to reach a gate. Past a right
 *  angle the "nearest" tip is on the far side of town and the connector
 *  would chord straight across the edge lots — no gate at all.
 *
 *  STUB-TOWN LAW ONLY (§2.2): a span-seeded town's baseline already ENDS at
 *  the port, so nothing is bent anywhere. This governs the fallback, where
 *  the streets stop short of the boundary and the road has to reach in. */
export const MAX_GATE_SEP = Math.PI / 2;

/** The tip whose bearing is nearest `bearing` (ties keep list order), or
 *  null when even the nearest is more than `maxSep` away — the town has no
 *  gate facing this road and the plain ribbon stands. */
export function nearestArterialTip(
  tips: readonly ArterialTip[], bearing: number, maxSep = MAX_GATE_SEP,
): ArterialTip | null {
  let best: ArterialTip | null = null;
  let bestSep = Infinity;
  for (const t of tips) {
    const sep = angSep(t.bearing, bearing);
    if (sep < bestSep) { bestSep = sep; best = t; }
  }
  return bestSep > maxSep ? null : best;
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
  /** The street joined, and which of its ends — together the draw-dedupe
   *  key for shared gates (one street can carry two: an open baseline's
   *  own two ends are two different gates). */
  street: number;
  end: 0 | 1;
}

/** Below this the port and the gate are effectively the same point and a
 *  connector would be shorter than the joint it smooths. */
const MIN_CONNECTOR_M = 60;

/**
 * PORT → GATE: refine the route's port into the mounted town's gate.
 *
 * The route already ENDS at the town's extent (planet/routes.ts
 * portTerminateRoute — the PORT LAW applied at generation), so this is no
 * longer a clip: it is the EXPANDED VIEW of a condensed scope interaction.
 * The last stretch of road is re-shaped into a connector running from the
 * road onto the street tree's bearing-nearest arterial tip, so the ribbon
 * and the carts enter town by a gate instead of stopping at the boundary.
 *
 * RENDER-ONLY by construction: the parent route is read, never written, and
 * the returned span mapping preserves the parent's caravan parametrization
 * (and is CONTINUOUS with it at the span's outer edge — a cart never jumps).
 * Null when the refinement cannot hold (no arterials, no gate within a right
 * angle of the road, a route shorter than its own connector, an endpoint
 * that is not this town's port) — callers keep the plain ribbon there.
 *
 * ALSO NULL — and this is the phase-B case, not a failure — when the nearest
 * gate IS the port (§2.2): a span-seeded town laid its baseline to this very
 * point, so the road runs onto the high street with no connector, no bend
 * and no paint of its own. There is nothing to refine when the two agree.
 *
 * `portExtentM` is the SAME extent the routes were clipped at, so an
 * endpoint that is not really this town's port can be told apart from one
 * that is.
 */
export function spliceRouteAtTown(
  route: PlanetRoute, end: "a" | "b", frame: TownFrame,
  portExtentM: number, tips: readonly ArterialTip[], planetRadius: number,
): RouteTownSplice | null {
  if (!tips.length) return null;
  // Sampling inset 0 = the endpoint itself = the PORT.
  const bearing = routeApproachBearing(route, end, frame, 0);
  if (bearing === null) return null;
  const sPort = end === "a" ? 0 : route.lengthM;
  const port = toTownLocal(frame, planetRadius, routePointAt(route, sPort));
  if (!port) return null;
  // An endpoint at the town CENTRE is an unclipped route (no port); one far
  // outside the extent belongs to some other town.
  const portR = Math.hypot(port.x, port.y);
  if (portR < 1 || portR > portExtentM * 2) return null;
  const tip = nearestArterialTip(tips, bearing);
  if (!tip) return null;
  // THE GATE IS THE PORT (§2.2): the town's own baseline reaches this point,
  // so the road and the street already meet. A connector here would be a
  // 60 m ghost lane doubling the last stretch of a road that has arrived.
  if (Math.hypot(tip.tip.x - port.x, tip.tip.y - port.y) < PORT_MEET_M) return null;
  // The connector spans the port→gate gap, and the parent lends it exactly
  // that much arc — so the drawn ribbon and the cart projection are both
  // continuous where the span begins.
  const connM = Math.max(MIN_CONNECTOR_M, Math.hypot(tip.tip.x - port.x, tip.tip.y - port.y));
  if (route.lengthM < connM * 1.5) return null;
  const sEdge = end === "a" ? connM : route.lengthM - connM;
  const clip = toTownLocal(frame, planetRadius, routePointAt(route, sEdge));
  if (!clip) return null;
  // Travel direction at the clip: along the road toward the port (and on
  // into town), the same tangent the old edge clip took.
  const dl = Math.hypot(port.x - clip.x, port.y - clip.y) || 1;
  const clipDir = { x: (port.x - clip.x) / dl, y: (port.y - clip.y) / dl };
  const pts = spliceConnector(clip, clipDir, tip);
  const dirs = pts.map(p => toPlanetDir(frame, planetRadius, p));
  const fwd = routeFromDirs(dirs, planetRadius, -2, -2);
  const rev = routeFromDirs([...dirs].reverse(), planetRadius, -2, -2);
  if (!fwd || !rev) return null;
  // Parent arc grows a→b, so the town-at-`a` span [0, sEdge] must map its
  // LOW arc to the tip (the town end) — the reversed connector.
  return end === "a"
    ? { s0: 0, s1: sEdge, route: rev, draw: fwd, street: tip.street, end: tip.end }
    : { s0: sEdge, s1: route.lengthM, route: fwd, draw: fwd, street: tip.street, end: tip.end };
}
