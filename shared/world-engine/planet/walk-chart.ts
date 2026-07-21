// shared/world-engine/planet/walk-chart.ts
//
// THE TANGENT CHART — walking a spherical planet up-close. The world-engine
// sim is plan-view 2D; this module makes those sim coordinates a LOCAL CHART
// on the sphere: x east, y north (metres), anchored at a surface point, with
// a GroundSampler that maps chart → sphere → terrain height (the planet's
// own render sampler, so walkers stand on exactly the terrain that draws).
//
// Why one chart is enough for a whole session: the gnomonic chart's metric
// error is ~(d/R)² — centimetres at 20 km on an Earth-radius world, still
// sub-metre at 100 km. Walking never outruns it. `reanchorAt` exists for
// hosts that stream farther (vehicles, multi-day journeys): it yields an
// equivalent chart centred where the walker stands, with axes PARALLEL-
// TRANSPORTED (not re-seeded) so headings stay continuous, and an offset
// mapping old sim coords to new. Heights are anchor-relative (0 at the
// anchor's ground), so a re-anchor shifts all heights uniformly — a host
// applies the same shift to its camera and nothing visibly moves.
//
// Deterministic throughout: a chart is a pure function of (surface, radius,
// anchor) — an address, like everything else on the ladder.

export type Vec3 = readonly [number, number, number];

/** What the chart samples — the planet's render surface (planet/surface.ts). */
export interface ChartSurface {
  heightAt(dir: Vec3): number;
}

export interface WalkChart {
  /** Anchor direction (unit) and tangent axes (unit, orthonormal). */
  readonly dir0: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
  readonly radius: number;
  /** Terrain height at chart (x, y), metres, RELATIVE to the anchor's
   *  ground (0 at the anchor). Curvature-corrected — a GroundSampler. */
  groundAt(x: number, y: number): number;
  /** Chart (x, y) → unit sphere direction. */
  dirAt(x: number, y: number): Vec3;
  /** Inverse of `dirAt`: a unit sphere direction → chart (x, y). The gnomonic
   *  un-projection — exact (round-trips `dirAt`) for any direction in the
   *  anchor's hemisphere (dir·dir0 > 0). Used by the flight handoff: a landing
   *  3D position is turned into the town's sim coordinates. `onFar` is true when
   *  `dir` is on the far hemisphere (dir·dir0 ≤ 0), where the chart doesn't
   *  reach — callers should re-anchor first. */
  chartXY(dir: Vec3): { x: number; y: number; onFar: boolean };
  /** An equivalent chart anchored at chart point (x, y). Old sim coords map
   *  to the new chart as `new = old − offset`; heights shift uniformly by
   *  `heightShift` (the new anchor's old-chart ground). */
  reanchorAt(x: number, y: number): { chart: WalkChart; offset: { x: number; y: number }; heightShift: number };
}

const norm = (v: [number, number, number]): [number, number, number] => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};
const cross = (a: Vec3, b: Vec3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function makeChart(
  surface: ChartSurface,
  radius: number,
  dir0: Vec3,
  east: Vec3,
  north: Vec3,
  curvature: boolean,
): WalkChart {
  const h0 = Math.max(0, surface.heightAt(dir0));

  const dirAt = (x: number, y: number): Vec3 =>
    norm([
      dir0[0] * radius + east[0] * x + north[0] * y,
      dir0[1] * radius + east[1] * x + north[1] * y,
      dir0[2] * radius + east[2] * x + north[2] * y,
    ]);

  const groundAt = (x: number, y: number): number => {
    const h = Math.max(0, surface.heightAt(dirAt(x, y)));
    // Anchor-relative terrain height. For a STANDALONE walking session this
    // is the whole story — every consumer (field mesh, buildings, feet)
    // reads the same sampler, so it is self-consistent AND exactly
    // seamless across re-anchors. The sphere-drop term ((x²+y²)/2R) is
    // OPT-IN (`curvature`) for hosts embedding the session in a scene that
    // also draws the true sphere: it aligns the chart with the planet mesh
    // but makes heights plane-relative, so a re-anchor there shifts far
    // heights by (anchor·offset)/R — such hosts restream around the new
    // anchor anyway.
    return (h - h0) - (curvature ? (x * x + y * y) / (2 * radius) : 0);
  };

  // Gnomonic un-projection. dir0/east/north are orthonormal (east·dir0 =
  // north·dir0 = 0), so for p = dir0·R + east·x + north·y we have p·dir0 = R,
  // p·east = x, p·north = y. dirAt returns d = p/|p|, hence x = R·(d·east)/(d·dir0)
  // and y = R·(d·north)/(d·dir0). Diverges as d·dir0 → 0 (the tangent horizon).
  const chartXY = (dir: Vec3): { x: number; y: number; onFar: boolean } => {
    const dDir0 = dot(dir, dir0);
    if (dDir0 <= 1e-6) return { x: 0, y: 0, onFar: true };
    const s = radius / dDir0;
    return { x: dot(dir, east) * s, y: dot(dir, north) * s, onFar: false };
  };

  return {
    dir0, east, north, radius,
    groundAt,
    dirAt,
    chartXY,
    reanchorAt(x, y) {
      const d = dirAt(x, y);
      // PARALLEL TRANSPORT: project the old axes onto the new tangent plane
      // — headings stay continuous instead of snapping to a re-seeded frame.
      const e = norm([
        east[0] - dot(east, d) * d[0],
        east[1] - dot(east, d) * d[1],
        east[2] - dot(east, d) * d[2],
      ]);
      const n = norm(cross(d, e));
      return {
        chart: makeChart(surface, radius, d, e, n, curvature),
        offset: { x, y },
        heightShift: groundAt(x, y),
      };
    },
  };
}

export interface WalkChartOpts {
  /** Fold the sphere's drop into heights (see groundAt's note). Default
   *  false — the standalone-session contract, exactly re-anchorable. */
  curvature?: boolean;
}

/** Chart the sphere at `anchorDir` (deterministic axes from the standard
 *  seed-axis rule; use `reanchorAt` to move a live session's chart). */
export function createWalkChart(
  surface: ChartSurface,
  radius: number,
  anchorDir: Vec3,
  opts: WalkChartOpts = {},
): WalkChart {
  const d = norm([anchorDir[0], anchorDir[1], anchorDir[2]]);
  const seed: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const east = norm(cross(seed, d));
  const north = norm(cross(d, east));
  return makeChart(surface, radius, d, east, north, opts.curvature === true);
}
