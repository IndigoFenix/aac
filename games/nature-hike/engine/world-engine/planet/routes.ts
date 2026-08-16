// shared/world-engine/planet/routes.ts
//
// THE CIV LAYER'S SECOND RUNG: a settled planet's cities join into a ROAD
// NET. The region tier already builds its village roads through
// kernel/civ/travel.ts (refine.ts); this module runs the SAME machinery at
// tier 0 — hub-pair least-cost routes between the capitals over the planet
// substrate, squeezed through passes, around forests and across fords, and
// committed to the grid's `road` field.
//
// Data only, THREE-free, deterministic: the same built planet always yields
// the same roads. The CARAVANS on them are a CLOSED-FORM function of absolute
// time (dual.ts §4c's law: caravans are DRAWN from the flow, not simulated) —
// so every client sharing the seed and the clock sees the same cart at the
// same bend, with nothing on a wire. Mutations are someone else's layer.

import { hubRoutes, pairRoutes, type TravelOpts } from "../kernel/civ/travel.js";
import { SEA_HEIGHT } from "../kernel/geology/tectonics.js";
// THE PORT LAW's one dimension: a town's extent. dimensions.ts is a
// constants-only leaf (no imports at all), so reading it here keeps ONE
// definition of "how far a town reaches" instead of a planet-side copy.
import { REAL_SCALE, townExtentM, type WorldScale } from "../scale.js";
import type { BuiltPlanet } from "./planet-game.js";
import type { PlanetCity } from "./cities.js";

export interface PlanetRoute {
  /** Endpoint city cells (tier-0 substrate cells), in route order. */
  a: number;
  b: number;
  /** Smoothed polyline of UNIT directions from the planet's center
   *  (endpoints pinned to the cities' own dirs). */
  dirs: Array<readonly [number, number, number]>;
  /** Cumulative surface metres along `dirs` (cum[0] = 0). */
  cum: number[];
  lengthM: number;
}

export interface PlanetRouteOpts {
  /** Routes per city, to its K nearest fellow cities by route cost
   *  (default 2 — a sparse planet net; travel's own default of 3 reads
   *  cluttered at capital spacing). */
  kNearest?: number;
  /** EXPLICIT topology: route these CITY-INDEX pairs instead of each city's
   *  K nearest — the polity-aware net (states.ts adjacency), where every
   *  interstate joins two neighbouring capitals across their real border. */
  pairs?: ReadonlyArray<readonly [number, number]>;
  /** THE PORT LAW (growth-unification §1): every route ends at its town's
   *  EXTENT, never at the city cell's center — otherwise the terrain paint,
   *  the ribbon and the carts all drive through the buildings. Default: the
   *  DERIVED extent for `scale` (scale.ts `townExtentM`, = townRMax at real
   *  scale); 0 keeps the raw centre-to-centre polyline (tests that measure
   *  the substrate solve itself). */
  townExtentM?: number;
  /** The world's space-time compression, for the extent derivation above —
   *  a planet that declares `gap_compression` crowds its towns and must
   *  shrink their extents with them, or the ports have no open country to
   *  cross. Absent = realism (the engine default). */
  scale?: WorldScale;
}

const norm3 = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** One corner-cutting pass on the sphere (endpoints pinned): each interior
 *  segment is replaced by its 1/4 and 3/4 points, re-normalized — two passes
 *  turn a cell-center staircase into a road a cart would plausibly walk. */
export function chaikinSphere(
  dirs: Array<readonly [number, number, number]>,
): Array<readonly [number, number, number]> {
  if (dirs.length < 3) return dirs;
  const out: Array<readonly [number, number, number]> = [dirs[0]!];
  for (let i = 0; i + 1 < dirs.length; i++) {
    const a = dirs[i]!;
    const b = dirs[i + 1]!;
    out.push(
      norm3([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2] * 0.75 + b[2] * 0.25]),
      norm3([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2] * 0.25 + b[2] * 0.75]),
    );
  }
  out.push(dirs[dirs.length - 1]!);
  return out;
}

const arcM = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
): number => {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d) * radius;
};

/** Wrap a (pre-smoothed) polyline of unit dirs into the PlanetRoute shape —
 *  cumulative arc-metres over `radius`; `a`/`b` are the caller's endpoint
 *  identities (tier-0 cells, composite village keys, or synthetic ids).
 *  Null when degenerate (fewer than 2 points, or under a metre long). */
export function routeFromDirs(
  dirs: Array<readonly [number, number, number]>,
  radius: number,
  a: number,
  b: number,
): PlanetRoute | null {
  if (dirs.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < dirs.length; i++) {
    cum.push(cum[i - 1]! + arcM(dirs[i - 1]!, dirs[i]!, radius));
  }
  const lengthM = cum[cum.length - 1]!;
  if (lengthM < 1) return null;
  return { a, b, dirs, cum, lengthM };
}

/** Unit direction at arc position `s` along a route (binary-search over
 *  cum + nlerp — the smoothed polyline's segment angles are tiny). The
 *  data-side twin of the renderers' samplePos, for consumers that need the
 *  path itself (chart-crossing detection, caravan projection). */
export function routePointAt(route: PlanetRoute, s: number): [number, number, number] {
  const cum = route.cum;
  const ss = Math.max(0, Math.min(route.lengthM, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= ss) lo = mid; else hi = mid;
  }
  const a = route.dirs[lo]!;
  const b = route.dirs[Math.min(lo + 1, route.dirs.length - 1)]!;
  const seg = cum[Math.min(lo + 1, cum.length - 1)]! - cum[lo]!;
  const f = seg > 1e-9 ? (ss - cum[lo]!) / seg : 0;
  return norm3([
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ]);
}

// ── THE PORT LAW: a route ends at the town's EXTENT, not at its centre ─────
//
// growth-unification §1: circulation crosses a scope boundary only at a PORT,
// and a route is the CONDENSED representation of the scope interaction. A
// condensed (unmounted) town has no street plan, so its port is derivable
// with nothing but its extent: the crossing of the town's extent circle.
// Clipping here — at GENERATION, once — is what makes the three downstream
// representations agree: the terrain vertex paint, the ribbon mesh and the
// caravan arcs all read this one geometry, so none of them can run through
// the buildings. Mounting the town REFINES the port to the gate (a short
// connector, kernel/town/approach.ts) — an expanded VIEW of the same data.

/** A route endpoint's TOWN: the identity the route names it by, where its
 *  centre stands, and how far its built extent reaches. */
export interface RouteTerminal {
  /** The endpoint identity claimed (must equal `route.a` / `route.b`). */
  id: number;
  /** Unit direction of the town centre from the planet's centre. */
  dir: readonly [number, number, number];
  /** Arc distance from `dir` at which the route PORTS (metres). */
  extentM: number;
}

/** The shortest road a port pair may leave standing. Below this the two
 *  towns' extents have swallowed the whole road and there is no open
 *  country between them to cross — see portTerminateRoute. */
const MIN_PORT_ROUTE_M = 10;

/** Arc positions this close are the same point (kills zero-length segments
 *  when a clip lands exactly on a vertex). */
const PORT_EPS_M = 1e-3;

/** Fraction along `in → out` where the great-circle distance to `c` reaches
 *  the extent — bisection on the SAME nlerp `routePointAt` interpolates
 *  with, so the pinned endpoint lies exactly on the sampled polyline. */
function portFrac(
  vIn: readonly [number, number, number],
  vOut: readonly [number, number, number],
  c: readonly [number, number, number],
  cosLimit: number,
): number {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const m = norm3([
      vIn[0] + (vOut[0] - vIn[0]) * mid,
      vIn[1] + (vOut[1] - vIn[1]) * mid,
      vIn[2] + (vOut[2] - vIn[2]) * mid,
    ]);
    if (m[0] * c[0] + m[1] * c[1] + m[2] * c[2] > cosLimit) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Arc position where the route leaves `t`'s extent, scanning inward from
 *  `end`. Returns the end's own arc position when the endpoint already lies
 *  outside (nothing to clip), and the FAR end's when the whole route is
 *  inside (the caller's midpoint clamp then rescues it). */
function portCrossingS(route: PlanetRoute, radius: number, end: "a" | "b", t: RouteTerminal): number {
  const c = t.dir;
  const cosLimit = Math.cos(Math.min(Math.PI, Math.max(0, t.extentM / radius)));
  const inside = (v: readonly [number, number, number]): boolean =>
    v[0] * c[0] + v[1] * c[1] + v[2] * c[2] > cosLimit;
  const n = route.dirs.length;
  if (end === "a") {
    let i = 0;
    while (i < n && inside(route.dirs[i]!)) i++;
    if (i === 0) return 0;
    if (i >= n) return route.lengthM;
    const f = portFrac(route.dirs[i - 1]!, route.dirs[i]!, c, cosLimit);
    return route.cum[i - 1]! + f * (route.cum[i]! - route.cum[i - 1]!);
  }
  let j = n - 1;
  while (j >= 0 && inside(route.dirs[j]!)) j--;
  if (j === n - 1) return route.lengthM;
  if (j < 0) return 0;
  const f = portFrac(route.dirs[j + 1]!, route.dirs[j]!, c, cosLimit);
  return route.cum[j + 1]! + f * (route.cum[j]! - route.cum[j + 1]!);
}

/**
 * Clip a route's ends at its terminals' extents — the PORT LAW made
 * geometry. For each end whose identity matches its terminal, the polyline
 * inside `extentM` of the terminal is dropped and the new endpoint is pinned
 * exactly ON the crossing (interpolated with routePointAt's own nlerp).
 *
 * TOWNS THAT OVERLAP HAVE NO PORTS. Where the extents swallow the whole road
 * — neighbours closer together than their own extents, which is ordinary on
 * a compressed world (the 2 km test planet spaces its cities ~800 m apart
 * against a 450 m extent) — the route comes back UNCLIPPED. A port is the
 * crossing of a boundary into open country, and between overlapping towns
 * there is no open country to cross; minting a metres-long stub there would
 * give it a caravan period of seconds and a ribbon of noise. Unclipped is
 * the honest answer, and it is never null for a route that existed.
 *
 * The result is an ordinary PlanetRoute: `cum`/`lengthM` are honest
 * PORT-TO-PORT figures (so caravan counts, arcs and trade distances price
 * the road that exists), identities are unchanged, and a route with no
 * matching terminal comes back by reference. Pure and deterministic.
 */
export function portTerminateRoute(
  route: PlanetRoute,
  radius: number,
  a?: RouteTerminal | null,
  b?: RouteTerminal | null,
): PlanetRoute {
  const termA = a && a.id === route.a ? a : null;
  const termB = b && b.id === route.b ? b : null;
  if (!termA && !termB) return route;
  const s0 = termA ? portCrossingS(route, radius, "a", termA) : 0;
  const s1 = termB ? portCrossingS(route, radius, "b", termB) : route.lengthM;
  // No open country between the extents ⇒ no ports ⇒ the road as solved.
  // (`portCrossingS` reports the FAR end when a whole route lies inside an
  // extent, so that case lands here too, with s1 − s0 ≤ 0.)
  if (s1 - s0 < MIN_PORT_ROUTE_M) return route;
  if (s0 <= PORT_EPS_M && s1 >= route.lengthM - PORT_EPS_M) return route;
  const dirs: Array<readonly [number, number, number]> = [routePointAt(route, s0)];
  for (let i = 0; i < route.dirs.length; i++) {
    const s = route.cum[i]!;
    if (s > s0 + PORT_EPS_M && s < s1 - PORT_EPS_M) dirs.push(route.dirs[i]!);
  }
  dirs.push(routePointAt(route, s1));
  return routeFromDirs(dirs, radius, route.a, route.b) ?? route;
}

/** The travel scaling the tier-0 substrate really has (the same numbers
 *  planet-game's climate pass derives). */
export function planetTravelOpts(built: BuiltPlanet): TravelOpts {
  const spec = built.spec;
  return {
    metresPerUnit: (spec.relief * spec.radius) / (63 - SEA_HEIGHT),
    metresPerCell: ((Math.PI / 2) * spec.radius) / spec.topology.faceN,
  };
}

/**
 * The planet's intercity road net: least-cost hub routes between the given
 * cities (travel.ts — slopes, forests, fords and open sea all priced),
 * smoothed into surface polylines a renderer can drape. PURE — the grid is
 * never written (commitRoads' built-corridor feedback would make a SECOND
 * call route differently, breaking "same seed, same net"), so the result is
 * deterministic in (built, cities) however often it's derived.
 */
export function planetRoutes(
  built: BuiltPlanet,
  cities: readonly PlanetCity[],
  opts: PlanetRouteOpts = {},
): PlanetRoute[] {
  const pos3 = built.topo.pos3;
  if (!pos3 || cities.length < 2) return [];
  const travel = { ...planetTravelOpts(built), kNearest: opts.kNearest ?? 2 };
  const cellRoutes = opts.pairs
    ? pairRoutes(
        built.grid,
        opts.pairs.map(([i, j]) => [cities[i]!.cell, cities[j]!.cell] as const),
        travel,
      )
    : hubRoutes(built.grid, cities.map(c => c.cell), travel);

  const radius = built.spec.radius;
  // THE PORT LAW: every endpoint is a CITY, so every end ports at that
  // city's extent — the raw solve ends on the cell centre, i.e. inside the
  // town's buildings.
  const extentM = opts.townExtentM ?? townExtentM(opts.scale ?? REAL_SCALE);
  const byCell = new Map<number, PlanetCity>();
  for (const c of cities) byCell.set(c.cell, c);
  const terminalOf = (cell: number): RouteTerminal | null => {
    const city = byCell.get(cell);
    return city ? { id: cell, dir: city.dir, extentM } : null;
  };
  const out: PlanetRoute[] = [];
  for (const cells of cellRoutes) {
    if (cells.length < 2) continue;
    const dirs = chaikinSphere(chaikinSphere(cells.map(c => pos3(c))));
    const route = routeFromDirs(dirs, radius, cells[0]!, cells[cells.length - 1]!);
    if (!route) continue;
    out.push(extentM > 0
      ? portTerminateRoute(route, radius, terminalOf(route.a), terminalOf(route.b))
      : route);
  }
  return out;
}

// ── Caravans: the road's traffic as a pure function of the clock ───────────

/** Cart pace on a made road (m/s) — a walking team, brisk but honest. */
export const CARAVAN_SPEED_MPS = 4;

/** How many caravans a route carries: one per ~13 km of road — dense enough
 *  that standing anywhere ON the road, traffic is in sight or minutes away
 *  (at 120-km spacing we measured a ~15% chance of ever seeing one). Renderers
 *  only evaluate the routes near the player, so density is cheap. */
export function caravanCount(route: PlanetRoute): number {
  return Math.max(2, Math.min(320, Math.round(route.lengthM / 13_000)));
}

const hash01 = (a: number, b: number, i: number): number => {
  let h = (0x811c9dc5 ^ Math.imul(a + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (b + 0x517cc1b7), 0x01000193) >>> 0;
  h = Math.imul(h ^ (i + 0x2545f491), 0x85ebca6b) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

export interface CaravanArc {
  /** Arc position along the route, metres from endpoint `a`. */
  s: number;
  /** +1 travelling a→b, −1 coming back. */
  sign: 1 | -1;
}

/** Where caravan `index` of a route stands at absolute time `tSec` — a
 *  triangle wave over the round trip (out to `b`, home to `a`), phase-hashed
 *  per caravan so the road carries traffic BOTH ways at any moment. Closed
 *  form: no state, no wire, identical on every client that shares the clock. */
export function caravanArc(route: PlanetRoute, index: number, tSec: number): CaravanArc {
  const period = (2 * route.lengthM) / CARAVAN_SPEED_MPS;
  const phase = hash01(route.a, route.b, index) * period;
  const u = (((tSec + phase) % period) + period) % period;
  const d = u * CARAVAN_SPEED_MPS;
  return d <= route.lengthM
    ? { s: d, sign: 1 }
    : { s: 2 * route.lengthM - d, sign: -1 };
}
