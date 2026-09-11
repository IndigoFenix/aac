// shared/world-engine/planet/surface-metric.ts
//
// THE SEAM BETWEEN A SPHERE AND A FLAT REGION (planet-boot round S3b).
//
// ⚖️ THE USER'S RULING: *"it's not that important, but it is a feature we'll
// want in the spec. Could also help with faster testing since we don't have
// to build the whole planet every time."* A `region`-scope document with
// declared geology + rain boots the SAME founding camp headless as the
// planet document does — real cells, sites, cities, routes and partners, no
// planet.
//
// Everything that reads a settled world's GEOMETRY (cities, roads, states'
// travel pricing, climate's latitude/pitch) used to ask a sphere directly —
// `topo.pos3`, `spec.radius`, `acos(dot)×radius`. This file is the one place
// that question is asked generically: a `SurfaceMetric` answers "where is
// this cell", "how far apart are two points", "which way is that from here"
// and "am I inside this town's extent" for EITHER substrate, and every other
// planet/*.ts module is threaded through it (`citiesOn`, `routesOn`,
// `statesOn`, `climateFields`'s `metric` seat) so the SPHERE arm is the exact
// same formulas, parameterised, never rewritten — the byte-hold
// (`server/tests/world-engine/planet-scope.test.ts` — checksum `ece0d9ba`,
// 1757 cities, 2708 routes) is what proves it did not move.
//
// `SurfaceMetric.kind` distinguishes the two without a runtime type test on
// the metric's shape; `posOf`/`distM`/`offsetM` are the ORIGINAL seam
// `interaction/town/planet-scope.ts` shipped in S1 (a founded beacon's
// partner scan — `partnerRows` — reads ONLY these two, on the app's own row
// list, so they stay the minimal, re-exported contract); the rest
// (`project`, `lerp`, `inside`, `latRad`, `pitchM`, `metresPerCell`,
// `metresPerUnit`) are ADDITIVE, for the route/travel/climate seams this
// round threads.

import type { GridTopology } from "../kernel/cells/topology.js";
import type { CellGrid } from "../kernel/cells/grid.js";
import type { FoundingSite } from "../kernel/cells/index.js";
import type { BuiltPlanet } from "./planet-game.js";
import { SEA_HEIGHT } from "../kernel/geology/tectonics.js";

export type Vec3 = readonly [number, number, number];

/**
 * WHERE THINGS ARE AND HOW FAR APART — one interface, two substrates.
 *
 * `posOf`/`distM`/`offsetM` are the contract `partnerRows`
 * (`interaction/town/planet-scope.ts`) already types against
 * (`Pick<SurfaceMetric, "distM" | "offsetM">`) — unchanged by this move.
 */
export interface SurfaceMetric {
  kind: "sphere" | "plane";
  /** The cell's position — a unit direction on a sphere, metres (x, y, 0)
   *  on a plane. */
  posOf(cell: number): Vec3;
  /** Project an arbitrary point back onto the surface — `norm3` on a
   *  sphere, identity on a plane (a plane point is already ON the plane). */
  project(v: Vec3): Vec3;
  /** Surface metres between two positions. */
  distM(a: Vec3, b: Vec3): number;
  /** Component lerp THEN project — the curve-smoothing (`chaikin`) and
   *  port-crossing (`portFrac`) primitive both substrates share. */
  lerp(a: Vec3, b: Vec3, t: number): Vec3;
  /** Is `v` within `extentM` of town centre `c`? Sphere: the great-circle
   *  cosLimit form (bit-identical to the original `portCrossingS`); plane:
   *  a flat disc. */
  inside(v: Vec3, c: Vec3, extentM: number): boolean;
  /** `to` seen from `from` in the LOCAL TOWN FRAME (x east, y north), in
   *  metres. Null when the direction is undefined — the two points are the
   *  same place, or (on a sphere) antipodal. A null row is SKIPPED, which is
   *  what makes a founded beacon standing on a city's own cell drop out. */
  offsetM(from: Vec3, to: Vec3): { x: number; y: number } | null;
  /** Latitude at a cell, radians — sphere: `asin(pos3(cell).y)`; plane: the
   *  map's declared centre latitude plus a row offset. */
  latRad(cell: number): number;
  /** Mean neighbour-to-neighbour pitch, in metres — sphere:
   *  `meanPitch(topo) × radiusM`; plane: the cell pitch itself (`cellM`). */
  pitchM: number;
  /** Metres per lattice cell (travel pricing). */
  metresPerCell: number;
  /** Metres per substrate height unit (travel pricing / climate lapse). */
  metresPerUnit: number;
}

/** A settled world's geometry, ready for the civ layer (`citiesOn`,
 *  `statesOn`, `routesOn`) — the sphere half is `sphereWorld(built)`; the
 *  region half is assembled by `buildRegionScope`. */
export interface SettledWorld {
  grid: CellGrid;
  sites: FoundingSite[];
  /** Name/identity seed — the world's geology seed. */
  seedBase: number;
  metric: SurfaceMetric;
}

// ── shared vector helpers ────────────────────────────────────────────────────

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const norm3 = (v: readonly [number, number, number]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// ── THE SPHERE HALF (moved verbatim from interaction/town/planet-scope.ts,
// S1's own math — the tangent-frame quaternion, the great-circle angle and
// its offset projection) ─────────────────────────────────────────────────────

/**
 * The tangent frame at a unit direction, WITHOUT THREE — the half-angle form
 * of `new THREE.Quaternion().setFromUnitVectors(+Y, dir)` applied to `(1,0,0)`
 * (east) and `(0,0,1)` (north), which is the surface-anchor convention every
 * town on the planet renders and plans in (`main.ts townFrameOf`,
 * `attachSurfaceAnchor`).
 *
 * Written out rather than imported because the headless boot must stay
 * THREE-free. THREE's own antiparallel branch is reproduced too — it cannot
 * fire on a founding cell (`dir ≈ −Y` is the south pole) but a frame that
 * quietly disagrees with the renderer at ONE input is exactly the kind of
 * drift this round exists to close. `games/world-lab/src/__tests__/
 * planet-frame.test.ts` compares both arms against real THREE at 1e-9.
 */
export function tangentFrameAt(dir: Vec3): { east: Vec3; north: Vec3 } {
  // setFromUnitVectors(vFrom = (0,1,0), vTo = dir), inlined:
  //   r = vFrom·vTo + 1 ; xyz = vFrom × vTo ; w = r ; then normalize().
  const r = dir[1] + 1;
  let qx: number, qy: number, qz: number, qw: number;
  if (r < 1e-8) {
    // Opposite directions. |vFrom.x| (0) > |vFrom.z| (0) is false ⇒ the else
    // arm: (0, −vFrom.z, vFrom.y, 0) = (0, 0, 1, 0).
    qx = 0; qy = 0; qz = 1; qw = 0;
  } else {
    qx = dir[2]; qy = 0; qz = -dir[0]; qw = r;
  }
  const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (len === 0) { qx = 0; qy = 0; qz = 0; qw = 1; }
  else { const inv = 1 / len; qx *= inv; qy *= inv; qz *= inv; qw *= inv; }
  return { east: applyQuat(1, 0, 0, qx, qy, qz, qw), north: applyQuat(0, 0, 1, qx, qy, qz, qw) };
}

/** `THREE.Vector3.applyQuaternion`, verbatim. */
function applyQuat(
  vx: number, vy: number, vz: number,
  qx: number, qy: number, qz: number, qw: number,
): Vec3 {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

/**
 * THE SPHERE'S GEOMETRY WITHOUT ITS LATTICE — `distM` + `offsetM` for a body
 * of this radius, and nothing that needs a cell.
 *
 * ⚖️ It exists because the BROWSER's partner scan has no lattice to ask
 * (S3): it enumerates `flight.cities()`, whose rows include the FOUNDED
 * BEACON at a synthetic cell `pos3` cannot answer, and it already holds every
 * row's direction. `partnerRows` therefore takes positions, not cells — so
 * the app needs this half and not `posOf`. Re-exported from `planet-scope.ts`
 * unchanged (same name, same two-key return shape) so `main.ts`'s import
 * keeps resolving.
 */
export function sphereGeometry(radiusM: number): Pick<SurfaceMetric, "distM" | "offsetM"> {
  const angle = (a: Vec3, b: Vec3): number => {
    const denominator = Math.sqrt(dot3(a, a) * dot3(b, b));
    if (denominator === 0) return Math.PI / 2;
    return Math.acos(clamp(dot3(a, b) / denominator, -1, 1));
  };
  return {
    distM: (a, b) => angle(a, b) * radiusM,
    offsetM: (from, to) => {
      // `toward` = the great-circle bearing: `to` with the `from` component
      // taken out, normalised. Zero-length ⇒ the same place or antipodal, and
      // the app skips both (`ang < 1e-9`, then `lengthSq < 1e-12`).
      const k = dot3(to, from);
      const tx = to[0] - k * from[0];
      const ty = to[1] - k * from[1];
      const tz = to[2] - k * from[2];
      const lenSq = tx * tx + ty * ty + tz * tz;
      if (lenSq < 1e-12) return null;
      const inv = 1 / Math.sqrt(lenSq);
      const toward: Vec3 = [tx * inv, ty * inv, tz * inv];
      const { east, north } = tangentFrameAt(from);
      const d = angle(from, to) * radiusM;
      return { x: dot3(toward, east) * d, y: dot3(toward, north) * d };
    },
  };
}

/** Mean neighbour angle over a strided cell sample — one cell's pitch in
 *  radians. Deliberately duplicated from `planet/climate.ts`'s (private)
 *  `meanPitch` rather than imported: this file must not create a dependency
 *  from `climate.ts` back to here, and the formula is the whole content —
 *  moving it byte-for-byte is the safety property, not sharing one copy. */
function meanPitch(topo: Pick<GridTopology, "n" | "maxDegree" | "neighbours" | "pos3">): number {
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  const step = Math.max(1, Math.floor(topo.n / 256));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < topo.n; i += step) {
    const k = topo.neighbours(i, nb);
    const p = topo.pos3!(i);
    for (let j = 0; j < k; j++) {
      const q = topo.pos3!(nb[j]);
      const dp = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
      sum += Math.acos(dp);
      count++;
    }
  }
  return count > 0 ? sum / count : Math.PI / 64;
}

/**
 * THE SPHERE IMPLEMENTATION — today's planet math exactly (`nearbyCityPartners`
 * main.ts:3224-3266): great-circle angle × radius for distance, and the
 * tangent-frame projection of the great-circle bearing for the offset.
 *
 * `relief`/`faceN` are OPTIONAL — `interaction/town/planet-scope.ts`'s own
 * call (`sphereMetric(built.topo, body.radiusM)`) never reads
 * `metresPerCell`/`metresPerUnit` (its consumers are `measuredEnvironment`/
 * `partnerRows`, which only touch `posOf`/`distM`/`offsetM`), so those two
 * fields are `NaN` when omitted rather than forcing every existing 2-arg call
 * site to learn a planet's relief.
 */
export function sphereMetric(
  topo: Pick<GridTopology, "pos3" | "n" | "maxDegree" | "neighbours">,
  radiusM: number,
  relief?: number,
  faceN?: number,
): SurfaceMetric {
  const pos3 = topo.pos3;
  if (!pos3) {
    throw new Error("sphereMetric: the topology has no pos3 — a sphere metric lives on a curved lattice");
  }
  const geo = sphereGeometry(radiusM);
  return {
    kind: "sphere",
    posOf: (cell) => pos3(cell),
    project: (v) => norm3(v),
    distM: geo.distM,
    lerp: (a, b, t) => norm3([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]),
    inside: (v, c, extentM) => {
      const cosLimit = Math.cos(Math.min(Math.PI, Math.max(0, extentM / radiusM)));
      return dot3(v, c) > cosLimit;
    },
    offsetM: geo.offsetM,
    latRad: (cell) => Math.asin(clamp(pos3(cell)[1], -1, 1)),
    pitchM: meanPitch(topo) * radiusM,
    metresPerCell: faceN !== undefined ? ((Math.PI / 2) * radiusM) / faceN : NaN,
    metresPerUnit: relief !== undefined ? (relief * radiusM) / (63 - SEA_HEIGHT) : NaN,
  };
}

/** A built planet's `SettledWorld` — `sphereMetric` fed the substrate's own
 *  relief/faceN, so `metresPerCell`/`metresPerUnit` ARE the values
 *  `planetTravelOpts(built)` computes today (`routes.ts`'s sphere wrappers
 *  prove the two agree). */
export function sphereWorld(built: BuiltPlanet): SettledWorld {
  return {
    grid: built.grid,
    sites: built.sites,
    seedBase: built.spec.geology.seed,
    metric: sphereMetric(built.topo, built.spec.radius, built.spec.relief, built.spec.topology.faceN),
  };
}

// ── THE PLANE HALF (NEW — the region producer) ──────────────────────────────

/** Earth's radius, metres — the region fixture's `latitude` field converts a
 *  row offset to a latitude delta at this scale (ledger §6b: `lat0 + (row −
 *  rows/2)·cell_m/R_EARTH_M`). A local constant rather than an import from
 *  `space/planet-geography.ts`: this file has no other reason to depend on
 *  the space chain, and the physical constant is the whole borrowed fact. */
const R_EARTH_M = 6_371_000;

/**
 * A BAKED FLAT REGION'S GEOMETRY — cell centres in METRES on a plane, no
 * curvature, no antipodes. `posOf(cell)` returns `[colM, rowM, 0]` (the
 * cell's centre, row-major indexing — `cell = row × cols + col`, the same
 * layout `grid.fields.height` uses); `project` is the identity (a plane
 * point is already on the plane); `offsetM` is `to − from` outright (no
 * tangent-frame projection needed — the plane IS the tangent frame).
 */
export function planeMetric(
  cols: number, rows: number, cellM: number, reliefM: number, latDeg: number = 0,
): SurfaceMetric {
  const lat0 = (latDeg * Math.PI) / 180;
  const posOf = (cell: number): Vec3 => {
    const x = cell % cols;
    const y = Math.floor(cell / cols);
    return [(x + 0.5) * cellM, (y + 0.5) * cellM, 0];
  };
  return {
    kind: "plane",
    posOf,
    project: (v) => v,
    distM: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0],
    inside: (v, c, extentM) => Math.hypot(v[0] - c[0], v[1] - c[1]) < extentM,
    offsetM: (from, to) => {
      const x = to[0] - from[0];
      const y = to[1] - from[1];
      if (Math.hypot(x, y) < 1e-9) return null;
      return { x, y };
    },
    latRad: (cell) => lat0 + ((Math.floor(cell / cols) - rows / 2) * cellM) / R_EARTH_M,
    pitchM: cellM,
    metresPerCell: cellM,
    metresPerUnit: reliefM / (63 - SEA_HEIGHT),
  };
}
