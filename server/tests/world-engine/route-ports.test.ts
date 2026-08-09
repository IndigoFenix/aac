// THE PORT LAW at the route rung (planning-docs/games/world-engine/
// growth-phase-a-port-fix.md A1): an intercity route ends at the town's
// EXTENT, never at the city cell's centre.
//
// This is the structural fix for roads-through-buildings. All three
// downstream representations — the terrain vertex PAINT (never spliced),
// the ribbon mesh, the caravan carts — read the route polyline directly, so
// clipping once at GENERATION is what makes them agree. A mounted town then
// REFINES its port to a gate with a short connector (approach.ts); the route
// data itself never changes.

import { describe, it, expect } from "@jest/globals";
import {
  portTerminateRoute, routeFromDirs, routePointAt,
  type PlanetRoute, type RouteTerminal,
} from "@shared/world-engine/planet/routes.js";
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions.js";

const R = 1_000_000; // planet radius (m)
const CENTER: readonly [number, number, number] = [0, 0, 1];

/** A tangent-chart point (town-local metres at the north pole of the chart)
 *  as a unit direction — the same gnomonic convention approach.ts uses. */
function dirAt(x: number, y: number): [number, number, number] {
  const m = Math.hypot(x, y, R);
  return [x / m, y / m, R / m];
}

/** Arc distance (m) from a unit direction to `to`. */
function arcTo(d: readonly [number, number, number], to: readonly [number, number, number]): number {
  return Math.acos(Math.max(-1, Math.min(1, d[0] * to[0] + d[1] * to[1] + d[2] * to[2]))) * R;
}

function routeThrough(pts: Array<[number, number]>, a = 11, b = 22): PlanetRoute {
  const route = routeFromDirs(pts.map(([x, y]) => dirAt(x, y)), R, a, b);
  if (!route) throw new Error("degenerate test route");
  return route;
}

const term = (
  id: number, at: readonly [number, number, number], extentM = TOWN_DIMS.townRMax,
): RouteTerminal => ({ id, dir: at, extentM });

/** A road curving in from the far north-east and straightening onto the
 *  town's +y axis — the least-cost shape the real solve emits. */
const CURVED: Array<[number, number]> = [
  [18_000, 18_000], [12_000, 15_000], [7000, 11_000], [3000, 6000],
  [800, 2500], [120, 900], [0, 0],
];

describe("portTerminateRoute — the endpoint lands ON the town's extent", () => {
  it("clips the 'b' end at extentM arc-distance from the terminal", () => {
    const route = routeThrough(CURVED);
    const clipped = portTerminateRoute(route, R, null, term(22, CENTER));
    expect(clipped).not.toBe(route);
    const end = clipped.dirs[clipped.dirs.length - 1]!;
    expect(arcTo(end, CENTER)).toBeCloseTo(TOWN_DIMS.townRMax, 3);
  });

  it("clips the 'a' end of the reversed route the same way", () => {
    const route = routeThrough([...CURVED].reverse(), 22, 11);
    const clipped = portTerminateRoute(route, R, term(22, CENTER), null);
    expect(arcTo(clipped.dirs[0]!, CENTER)).toBeCloseTo(TOWN_DIMS.townRMax, 3);
  });

  it("leaves NO vertex inside the extent — the paint law", () => {
    const route = routeThrough(CURVED);
    // The raw route runs right through the town: several vertices inside.
    expect(route.dirs.filter(d => arcTo(d, CENTER) < TOWN_DIMS.townRMax).length)
      .toBeGreaterThan(0);
    const clipped = portTerminateRoute(route, R, null, term(22, CENTER));
    for (const d of clipped.dirs) {
      expect(arcTo(d, CENTER)).toBeGreaterThan(TOWN_DIMS.townRMax - 1e-3);
    }
  });

  it("clips BOTH ends when both terminals match", () => {
    const a: readonly [number, number, number] = dirAt(18_000, 18_000);
    const route = routeThrough(CURVED);
    const clipped = portTerminateRoute(route, R, term(11, a), term(22, CENTER));
    expect(arcTo(clipped.dirs[0]!, a)).toBeCloseTo(TOWN_DIMS.townRMax, 3);
    expect(arcTo(clipped.dirs[clipped.dirs.length - 1]!, CENTER))
      .toBeCloseTo(TOWN_DIMS.townRMax, 3);
    // lengthM is an honest PORT-TO-PORT figure (what trade and caravan
    // counts price), i.e. both extents shorter than the raw solve.
    expect(clipped.lengthM).toBeCloseTo(route.lengthM - 2 * TOWN_DIMS.townRMax, 0);
  });
});

describe("portTerminateRoute — the route stays a well-formed route", () => {
  it("preserves identities and rebuilds cum/lengthM consistently", () => {
    const route = routeThrough(CURVED, 7, 9);
    const clipped = portTerminateRoute(route, R, term(7, dirAt(18_000, 18_000)), term(9, CENTER));
    expect(clipped.a).toBe(7);
    expect(clipped.b).toBe(9);
    expect(clipped.dirs.length).toBeGreaterThanOrEqual(2);
    expect(clipped.cum.length).toBe(clipped.dirs.length);
    expect(clipped.cum[0]).toBe(0);
    for (let i = 1; i < clipped.cum.length; i++) {
      expect(clipped.cum[i]).toBeGreaterThanOrEqual(clipped.cum[i - 1]!);
    }
    expect(clipped.lengthM).toBeCloseTo(clipped.cum[clipped.cum.length - 1]!, 9);
    for (const d of clipped.dirs) {
      expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1)).toBeLessThan(1e-9);
    }
    // The pinned endpoint really is ON the parent polyline (routePointAt's
    // own nlerp), not a fresh great-circle guess.
    const onParent = routePointAt(route, route.lengthM - TOWN_DIMS.townRMax);
    const end = clipped.dirs[clipped.dirs.length - 1]!;
    expect(arcTo(end, onParent)).toBeLessThan(1);
  });

  it("TOWNS THAT OVERLAP HAVE NO PORTS: the road comes back unclipped", () => {
    // 600 m apart, 450 m extents each — ordinary on a compressed world. The
    // extents swallow the road, so there is no open country to cross and no
    // port to find. Clipping anyway would mint a metres-long stub whose
    // caravan period is seconds; the road as solved is the honest answer.
    const a = dirAt(600, 0);
    const route = routeThrough([[600, 0], [300, 0], [0, 0]], 1, 2);
    expect(portTerminateRoute(route, R, term(1, a), term(2, CENTER))).toBe(route);
  });

  it("returns a route wholly inside one extent unchanged, never a stub", () => {
    const route = routeThrough([[200, 0], [100, 0], [0, 0]], 1, 2);
    expect(portTerminateRoute(route, R, null, term(2, CENTER, 5000))).toBe(route);
  });

  it("NEVER emits a stub: a clipped route always outlives the minimum", () => {
    // Sweep the whole overlap boundary — every gap from "extents swallow the
    // road" to "comfortably clear" either clips to a real road or is left
    // alone. Nothing in between may leak out as a few metres of geometry.
    for (let gap = 700; gap <= 1400; gap += 5) {
      const a = dirAt(gap, 0);
      const route = routeThrough([[gap, 0], [gap / 2, 0], [0, 0]], 1, 2);
      const clipped = portTerminateRoute(route, R, term(1, a), term(2, CENTER));
      if (clipped === route) continue;             // no ports — left alone
      expect(clipped.lengthM).toBeGreaterThanOrEqual(10);
      expect(arcTo(clipped.dirs[0]!, a)).toBeCloseTo(TOWN_DIMS.townRMax, 3);
      expect(arcTo(clipped.dirs[clipped.dirs.length - 1]!, CENTER))
        .toBeCloseTo(TOWN_DIMS.townRMax, 3);
    }
  });
});

describe("portTerminateRoute — identity gating and determinism", () => {
  it("returns the route UNCHANGED when no terminal identity matches", () => {
    const route = routeThrough(CURVED, 11, 22);
    expect(portTerminateRoute(route, R, term(99, CENTER), term(98, CENTER))).toBe(route);
    expect(portTerminateRoute(route, R)).toBe(route);
    // A terminal for the OTHER end never clips this one.
    expect(portTerminateRoute(route, R, term(22, CENTER), null)).toBe(route);
  });

  it("returns the route unchanged when the endpoint is already outside", () => {
    const route = routeThrough([[9000, 0], [5000, 0], [1200, 0]], 11, 22);
    expect(portTerminateRoute(route, R, null, term(22, CENTER))).toBe(route);
  });

  it("is deterministic: the same inputs yield a byte-identical route", () => {
    const route = routeThrough(CURVED);
    const one = portTerminateRoute(route, R, null, term(22, CENTER));
    const two = portTerminateRoute(route, R, null, term(22, CENTER));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it("does not mutate the parent route", () => {
    const route = routeThrough(CURVED);
    const before = JSON.stringify(route);
    portTerminateRoute(route, R, term(11, dirAt(18_000, 18_000)), term(22, CENTER));
    expect(JSON.stringify(route)).toBe(before);
  });
});
