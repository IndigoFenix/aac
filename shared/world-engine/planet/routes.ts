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
import { sphereWorld, type SettledWorld, type SurfaceMetric } from "./surface-metric.js";

export interface PlanetRoute {
  /** Endpoint city cells (tier-0 substrate cells), in route order. */
  a: number;
  b: number;
  /** Smoothed polyline of UNIT directions from the planet's center on a
   *  sphere, or metres (x, y, 0) on a plane (endpoints pinned to the
   *  cities' own positions). */
  dirs: Array<readonly [number, number, number]>;
  /** Cumulative surface metres along `dirs` (cum[0] = 0). */
  cum: number[];
  lengthM: number;
  /** Which `SurfaceMetric` this route was solved on — absent = sphere (every
   *  route this planet ever shipped). `routePointAt` reads it to skip the
   *  sphere's re-normalising `project`; nothing else does. */
  frame?: "plane";
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

const norm3 = (v: readonly [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** One corner-cutting pass (endpoints pinned): each interior segment is
 *  replaced by its 1/4 and 3/4 points, re-PROJECTED onto the surface — two
 *  passes turn a cell-center staircase into a road a cart would plausibly
 *  walk. `project` is the substrate's own (`norm3` on a sphere, identity on
 *  a plane — `SurfaceMetric.project`), so this is ONE curve-smoother, not
 *  two (planet-boot round S3b). */
export function chaikin(
  dirs: Array<readonly [number, number, number]>,
  project: (v: readonly [number, number, number]) => readonly [number, number, number],
): Array<readonly [number, number, number]> {
  if (dirs.length < 3) return dirs;
  const out: Array<readonly [number, number, number]> = [dirs[0]!];
  for (let i = 0; i + 1 < dirs.length; i++) {
    const a = dirs[i]!;
    const b = dirs[i + 1]!;
    out.push(
      project([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2] * 0.75 + b[2] * 0.25]),
      project([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2] * 0.25 + b[2] * 0.75]),
    );
  }
  out.push(dirs[dirs.length - 1]!);
  return out;
}

/** The sphere's own smoother — `chaikin(dirs, norm3)`, kept exported under
 *  its original name (byte-identical output; every existing caller keeps
 *  resolving). */
export const chaikinSphere = (
  dirs: Array<readonly [number, number, number]>,
): Array<readonly [number, number, number]> => chaikin(dirs, norm3);

const arcM = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
): number => {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d) * radius;
};

/**
 * Wrap a (pre-smoothed) polyline into the PlanetRoute shape — cumulative
 * metres over `metric.distM`; `a`/`b` are the caller's endpoint identities
 * (tier-0 cells, composite village keys, or synthetic ids). Null when
 * degenerate (fewer than 2 points, or under a metre long). Stamps
 * `frame: "plane"` for a plane metric; a sphere metric leaves it OFF (the
 * shipped shape — see `PlanetRoute.frame`), so `routeFromDirs` below stays
 * byte-identical to every route this planet ever built.
 */
export function routeFrom(
  dirs: Array<readonly [number, number, number]>,
  metric: Pick<SurfaceMetric, "distM" | "kind">,
  a: number,
  b: number,
): PlanetRoute | null {
  if (dirs.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < dirs.length; i++) {
    cum.push(cum[i - 1]! + metric.distM(dirs[i - 1]!, dirs[i]!));
  }
  const lengthM = cum[cum.length - 1]!;
  if (lengthM < 1) return null;
  return metric.kind === "plane" ? { a, b, dirs, cum, lengthM, frame: "plane" } : { a, b, dirs, cum, lengthM };
}

/** The sphere wrapper of `routeFrom` — `arcM` over `radius`, unchanged
 *  signature/behaviour, every existing caller keeps resolving. */
export function routeFromDirs(
  dirs: Array<readonly [number, number, number]>,
  radius: number,
  a: number,
  b: number,
): PlanetRoute | null {
  return routeFrom(dirs, { kind: "sphere", distM: (p, q) => arcM(p, q, radius) }, a, b);
}

/** Position at arc position `s` along a route (binary-search over cum +
 *  lerp). A SPHERE route re-projects onto the surface (nlerp — the smoothed
 *  polyline's segment angles are tiny); a PLANE route is already ON the
 *  plane, so the projection is skipped (`route.frame === "plane"`) — the
 *  only place a route's frame is read. The data-side twin of the renderers'
 *  samplePos, for consumers that need the path itself (chart-crossing
 *  detection, caravan projection). */
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
  const p: [number, number, number] = [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
  return route.frame === "plane" ? p : norm3(p);
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

/** Fraction along `in → out` where the distance to `c` reaches the extent —
 *  bisection on the SAME `lerp` `routePointAt` interpolates with (nlerp on a
 *  sphere, plain lerp on a plane), so the pinned endpoint lies exactly on
 *  the sampled polyline. */
function portFracOn(
  metric: Pick<SurfaceMetric, "lerp" | "inside">,
  vIn: readonly [number, number, number],
  vOut: readonly [number, number, number],
  c: readonly [number, number, number],
  extentM: number,
): number {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const m = metric.lerp(vIn, vOut, mid);
    if (metric.inside(m, c, extentM)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Arc position where the route leaves `t`'s extent, scanning inward from
 *  `end`. Returns the end's own arc position when the endpoint already lies
 *  outside (nothing to clip), and the FAR end's when the whole route is
 *  inside (the caller's midpoint clamp then rescues it). */
function portCrossingSOn(
  route: PlanetRoute,
  metric: Pick<SurfaceMetric, "lerp" | "inside">,
  end: "a" | "b",
  t: RouteTerminal,
): number {
  const c = t.dir;
  const inside = (v: readonly [number, number, number]): boolean => metric.inside(v, c, t.extentM);
  const n = route.dirs.length;
  if (end === "a") {
    let i = 0;
    while (i < n && inside(route.dirs[i]!)) i++;
    if (i === 0) return 0;
    if (i >= n) return route.lengthM;
    const f = portFracOn(metric, route.dirs[i - 1]!, route.dirs[i]!, c, t.extentM);
    return route.cum[i - 1]! + f * (route.cum[i]! - route.cum[i - 1]!);
  }
  let j = n - 1;
  while (j >= 0 && inside(route.dirs[j]!)) j--;
  if (j === n - 1) return route.lengthM;
  if (j < 0) return 0;
  const f = portFracOn(metric, route.dirs[j + 1]!, route.dirs[j]!, c, t.extentM);
  return route.cum[j + 1]! + f * (route.cum[j]! - route.cum[j + 1]!);
}

/**
 * Clip a route's ends at its terminals' extents — the PORT LAW made
 * geometry. For each end whose identity matches its terminal, the polyline
 * inside `extentM` of the terminal is dropped and the new endpoint is pinned
 * exactly ON the crossing (interpolated with routePointAt's own lerp).
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
export function portTerminateOn(
  route: PlanetRoute,
  metric: Pick<SurfaceMetric, "lerp" | "inside" | "distM" | "kind">,
  a?: RouteTerminal | null,
  b?: RouteTerminal | null,
): PlanetRoute {
  const termA = a && a.id === route.a ? a : null;
  const termB = b && b.id === route.b ? b : null;
  if (!termA && !termB) return route;
  const s0 = termA ? portCrossingSOn(route, metric, "a", termA) : 0;
  const s1 = termB ? portCrossingSOn(route, metric, "b", termB) : route.lengthM;
  // No open country between the extents ⇒ no ports ⇒ the road as solved.
  // (`portCrossingSOn` reports the FAR end when a whole route lies inside an
  // extent, so that case lands here too, with s1 − s0 ≤ 0.)
  if (s1 - s0 < MIN_PORT_ROUTE_M) return route;
  if (s0 <= PORT_EPS_M && s1 >= route.lengthM - PORT_EPS_M) return route;
  const dirs: Array<readonly [number, number, number]> = [routePointAt(route, s0)];
  for (let i = 0; i < route.dirs.length; i++) {
    const s = route.cum[i]!;
    if (s > s0 + PORT_EPS_M && s < s1 - PORT_EPS_M) dirs.push(route.dirs[i]!);
  }
  dirs.push(routePointAt(route, s1));
  return routeFrom(dirs, metric, route.a, route.b) ?? route;
}

/** The sphere wrapper of `portTerminateOn` — a `sphereGeometry(radius)`-style
 *  metric built inline (this module needs `lerp`/`inside`/`distM`/`kind`
 *  only; `planet/surface-metric.ts`'s exported `sphereGeometry` is the
 *  narrower `distM`/`offsetM` contract `partnerRows` types against, so this
 *  stays a private, route-local geometry rather than reusing that name).
 *  Unchanged signature/behaviour — every existing caller keeps resolving. */
export function portTerminateRoute(
  route: PlanetRoute,
  radius: number,
  a?: RouteTerminal | null,
  b?: RouteTerminal | null,
): PlanetRoute {
  return portTerminateOn(route, sphereRouteGeometry(radius), a, b);
}

function sphereRouteGeometry(radius: number): Pick<SurfaceMetric, "lerp" | "inside" | "distM" | "kind"> {
  return {
    kind: "sphere",
    distM: (p, q) => arcM(p, q, radius),
    lerp: (p, q, t) => norm3([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]),
    inside: (v, c, extentM) => {
      const cosLimit = Math.cos(Math.min(Math.PI, Math.max(0, extentM / radius)));
      return v[0] * c[0] + v[1] * c[1] + v[2] * c[2] > cosLimit;
    },
  };
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

/** `TravelOpts` off ANY `SurfaceMetric` — the region producer's own travel
 *  pricing (`planeMetric`'s `metresPerCell`/`metresPerUnit`) reads exactly
 *  this shape, so `statesOn`/`routesOn` need one function, not a
 *  sphere-specific and a plane-specific reading of the same two fields. */
export function travelOptsOf(metric: Pick<SurfaceMetric, "metresPerCell" | "metresPerUnit">): TravelOpts {
  return { metresPerUnit: metric.metresPerUnit, metresPerCell: metric.metresPerCell };
}

/**
 * ⚖️ THE SUBSTRATE-AGNOSTIC ROAD NET (planet-boot round S3b) — least-cost hub
 * routes between the given cities (travel.ts — slopes, forests, fords and
 * open sea all priced), smoothed into polylines a renderer can drape, over
 * ANY `SettledWorld`. `planetRoutes` below is its sphere WRAPPER: same
 * `chaikin`/`routeFrom`/`portTerminateOn` calls, fed `sphereWorld(built)`'s
 * metric — byte-identical to the pre-S3b implementation (the byte-hold,
 * `test:engine -- planet-scope`, is what proves it).
 *
 * PURE — the grid is never written (commitRoads' built-corridor feedback
 * would make a SECOND call route differently, breaking "same seed, same
 * net"), so the result is deterministic in (world, cities) however often
 * it's derived.
 */
export function routesOn(
  world: SettledWorld,
  cities: readonly PlanetCity[],
  opts: PlanetRouteOpts = {},
): PlanetRoute[] {
  if (cities.length < 2) return [];
  const { grid, metric } = world;
  const travel = { ...travelOptsOf(metric), kNearest: opts.kNearest ?? 2 };
  const cellRoutes = opts.pairs
    ? pairRoutes(grid, opts.pairs.map(([i, j]) => [cities[i]!.cell, cities[j]!.cell] as const), travel)
    : hubRoutes(grid, cities.map(c => c.cell), travel);

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
    const dirs = chaikin(chaikin(cells.map(c => metric.posOf(c)), metric.project), metric.project);
    const route = routeFrom(dirs, metric, cells[0]!, cells[cells.length - 1]!);
    if (!route) continue;
    out.push(extentM > 0
      ? portTerminateOn(route, metric, terminalOf(route.a), terminalOf(route.b))
      : route);
  }
  return out;
}

/**
 * The planet's intercity road net — the sphere WRAPPER of `routesOn`. Same
 * signature/behaviour as before this round; the grid is fed through
 * `sphereWorld(built)` internally.
 */
export function planetRoutes(
  built: BuiltPlanet,
  cities: readonly PlanetCity[],
  opts: PlanetRouteOpts = {},
): PlanetRoute[] {
  if (!built.topo.pos3) return [];
  return routesOn(sphereWorld(built), cities, opts);
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
