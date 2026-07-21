// The APPROACH seam (shared/world-engine/kernel/town/approach.ts) — where
// a road ACTUALLY arrives at a town. Two composable halves:
//
//   C. routeApproachBearing/approachBearings: the route polyline's TRUE
//      bearing where it crosses the town radius (a least-cost road curves
//      around hills, so this differs from the straight line to the
//      neighbor) — what townBias grows the arterials with when a host
//      hands it through TownHost.roadBearings.
//   D. spliceRouteAtTown: the render-only clip-and-join at the town edge
//      onto the street tree's nearest gen-0 arterial tip.
//
// Plus the seam laws: quantization to the street compass, determinism,
// and the persisted-bearings regrow contract (same (seed, key, bearings)
// ⇒ the same prefix-stable street tree).

import { describe, it, expect } from "@jest/globals";
import {
  approachBearings,
  arterialTips,
  nearestArterialTip,
  quantB,
  routeApproachBearing,
  spliceConnector,
  spliceRouteAtTown,
  toPlanetDir,
  toTownLocal,
  BEARING_QUANT,
  type TownFrame,
} from "@shared/world-engine/kernel/town/approach.js";
import { routeFromDirs, routePointAt, type PlanetRoute } from "@shared/world-engine/planet/routes.js";
import { townBias } from "@shared/world-engine/kernel/town/plan.js";
import { growStreets, type Street } from "@shared/world-engine/kernel/town/streets.js";
import type { TownHost } from "@shared/world-engine/kernel/town/host.js";
import type { CompiledEconomy } from "@shared/world-engine/kernel/modules/economy/economy.js";

const R = 1_000_000; // planet radius (metres) — tangent-chart errors ~ (d/R)²
const FRAME: TownFrame = { center: [0, 0, 1], east: [1, 0, 0], north: [0, 1, 0] };

/** A route through town-local waypoints (last point = the town center). */
function routeThrough(local: Array<[number, number]>): PlanetRoute {
  const dirs = local.map(([x, y]) => toPlanetDir(FRAME, R, { x, y }));
  const route = routeFromDirs(dirs, R, 1, 2);
  if (!route) throw new Error("degenerate test route");
  return route;
}

/** A CURVED route into the town: from the far northeast, swinging around
 *  to a final approach straight down the +y axis. Straight-line bearing
 *  to the far endpoint is π/4; the bearing AT the town radius is π/2. */
const CURVED: Array<[number, number]> = [
  [8000, 8000], [6000, 7200], [3500, 6200], [1500, 4200], [0, 2000], [0, 0],
];

const angSep = (a: number, b: number): number => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
};

describe("routeApproachBearing — the route's TRUE bearing at the town radius", () => {
  it("reads the final approach, not the straight line to the far endpoint", () => {
    const route = routeThrough(CURVED); // town at end 'b'
    const b = routeApproachBearing(route, "b", FRAME, 450);
    expect(b).not.toBeNull();
    expect(angSep(b!, Math.PI / 2)).toBeLessThan(0.05); // due +y
    const straight = Math.atan2(8000, 8000); // π/4 toward the neighbor
    expect(angSep(b!, straight)).toBeGreaterThan(0.5);
    expect(quantB(b!)).not.toBe(quantB(straight));
  });

  it("reads the same approach from endpoint 'a' of the reversed route", () => {
    const route = routeThrough([...CURVED].reverse());
    const b = routeApproachBearing(route, "a", FRAME, 450);
    expect(b).not.toBeNull();
    expect(angSep(b!, Math.PI / 2)).toBeLessThan(0.05);
  });

  it("round-trips the chart: toTownLocal inverts toPlanetDir", () => {
    const p = { x: 1234.5, y: -678.9 };
    const back = toTownLocal(FRAME, R, toPlanetDir(FRAME, R, p));
    expect(back).not.toBeNull();
    expect(back!.x).toBeCloseTo(p.x, 6);
    expect(back!.y).toBeCloseTo(p.y, 6);
  });
});

describe("approachBearings — quantized, deduped, most important first", () => {
  it("quantizes to the street compass and keeps the caller's order", () => {
    const east = routeThrough([[9000, 300], [4000, 100], [0, 0]]);
    const north = routeThrough([[300, 9000], [100, 4000], [0, 0]]);
    const out = approachBearings(
      [{ route: east, end: "b" }, { route: north, end: "b" }], FRAME, 450,
    );
    expect(out).toHaveLength(2);
    for (const b of out) {
      expect(Math.abs(b / BEARING_QUANT - Math.round(b / BEARING_QUANT))).toBeLessThan(1e-9);
    }
    expect(angSep(out[0]!, 0)).toBeLessThan(0.3);            // east road first
    expect(angSep(out[1]!, Math.PI / 2)).toBeLessThan(0.3);  // north road second
  });

  it("dedupes near-identical approaches (one arterial serves both) and caps at max", () => {
    const east = routeThrough([[9000, 300], [4000, 100], [0, 0]]);
    const eastToo = routeThrough([[9000, -300], [4000, -100], [0, 0]]);
    const north = routeThrough([[300, 9000], [100, 4000], [0, 0]]);
    const west = routeThrough([[-9000, 0], [-4000, 0], [0, 0]]);
    const out = approachBearings(
      [
        { route: east, end: "b" }, { route: eastToo, end: "b" },
        { route: north, end: "b" }, { route: west, end: "b" },
      ],
      FRAME, 450,
    );
    expect(out).toHaveLength(2); // twin east collapsed, west beyond the cap
    expect(angSep(out[0]!, 0)).toBeLessThan(0.3);
    expect(angSep(out[1]!, Math.PI / 2)).toBeLessThan(0.3);
  });

  it("is deterministic: the same inputs yield byte-equal bearings", () => {
    const route = routeThrough(CURVED);
    const a = approachBearings([{ route, end: "b" }], FRAME, 450);
    const b = approachBearings([{ route, end: "b" }], FRAME, 450);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ---------------- townBias reads the host's true bearings ---------------- */

const ECO = { works: [] } as unknown as CompiledEconomy;

function hostWith(roadBearings: (() => readonly number[] | null) | undefined): TownHost {
  const host: TownHost = {
    cities: [{ key: "t", x: 10, y: 10 }, { key: "o", x: 15, y: 10 }],
    charterOf: () => ({ farmland: 100, ore_access: 0 }),
    dual: Object.assign(
      { settlementScalar: () => 0 },
      { routes: () => [{ site_a: { key: "t" }, site_b: { key: "o" } }] },
    ),
  };
  if (roadBearings) host.roadBearings = roadBearings;
  return host;
}

describe("townBias — host approach bearings beat the straight line", () => {
  it("uses the host's bearings, quantized", () => {
    const bias = townBias(hostWith(() => [1.0]), ECO, "t");
    expect(bias.bearings).toEqual([quantB(1.0)]);
  });

  it("trusts an EMPTY answer (a verified roadless town — no fallback)", () => {
    const bias = townBias(hostWith(() => []), ECO, "t");
    expect(bias.bearings).toEqual([]);
  });

  it("falls back to straight-line neighbor bearings when the host knows nothing", () => {
    for (const bias of [
      townBias(hostWith(() => null), ECO, "t"),
      townBias(hostWith(undefined), ECO, "t"),
    ]) {
      expect(bias.bearings).toEqual([quantB(Math.atan2(0, 5))]); // due east
    }
  });
});

/* ------------------- the splice at the town edge (fix D) ------------------ */

/** Two gen-0 arterials (east and north), the plaza ring, and a lane. */
function testStreets(): Array<Pick<Street, "id" | "gen" | "ring" | "pts">> {
  return [
    { id: 0, gen: -1, ring: true, pts: [{ x: 30, y: 0 }, { x: 0, y: 30 }, { x: -30, y: 0 }] },
    { id: 1, gen: 0, pts: [{ x: 30, y: 0 }, { x: 150, y: 10 }, { x: 290, y: 24 }] },
    { id: 2, gen: 0, pts: [{ x: 0, y: 30 }, { x: -14, y: 160 }, { x: -20, y: 300 }] },
    { id: 3, gen: 1, pts: [{ x: 150, y: 10 }, { x: 170, y: 90 }] },
  ];
}

describe("arterial tips and the splice connector", () => {
  it("collects gen-0 tips only (ring and lanes excluded)", () => {
    const tips = arterialTips(testStreets());
    expect(tips.map(t => t.street)).toEqual([1, 2]);
    expect(tips[0]!.tip).toEqual({ x: 290, y: 24 });
  });

  it("picks the bearing-nearest gen-0 street", () => {
    const tips = arterialTips(testStreets());
    expect(nearestArterialTip(tips, 0.2)!.street).toBe(1);          // ~east
    expect(nearestArterialTip(tips, Math.PI / 2 - 0.2)!.street).toBe(2); // ~north
  });

  it("bridges clip point to tip exactly (endpoints pinned through smoothing)", () => {
    const tips = arterialTips(testStreets());
    const clip = { x: 460, y: 40 };
    const pts = spliceConnector(clip, { x: -1, y: 0 }, tips[0]!);
    expect(pts[0]).toEqual(clip);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(290, 9);
    expect(pts[pts.length - 1]!.y).toBeCloseTo(24, 9);
  });
});

describe("spliceRouteAtTown — the render-only clip-and-join", () => {
  const tips = arterialTips(testStreets());

  it("clips at the town edge and joins the bearing-nearest arterial tip", () => {
    const route = routeThrough(CURVED); // approaches due +y → street 2
    const cut = spliceRouteAtTown(route, "b", FRAME, 320, tips, R);
    expect(cut).not.toBeNull();
    expect(cut!.street).toBe(2);
    // The span replaces the parent's last stretch, up to the endpoint.
    expect(cut!.s1).toBe(route.lengthM);
    expect(cut!.s0).toBeGreaterThan(route.lengthM - 500);
    // The drawn connector starts ON the parent at the clip arc…
    const clipLocal = toTownLocal(FRAME, R, routePointAt(route, cut!.s0))!;
    const drawStart = toTownLocal(FRAME, R, cut!.draw.dirs[0]!)!;
    expect(drawStart.x).toBeCloseTo(clipLocal.x, 4);
    expect(drawStart.y).toBeCloseTo(clipLocal.y, 4);
    // …and ends at the arterial tip (within float epsilon).
    const drawEnd = toTownLocal(FRAME, R, cut!.draw.dirs[cut!.draw.dirs.length - 1]!)!;
    expect(drawEnd.x).toBeCloseTo(-20, 4);
    expect(drawEnd.y).toBeCloseTo(300, 4);
    // The caravan-projection route is param-aligned with the span: parent
    // arc s0 ↦ connector arc 0 (the clip), parent end ↦ the tip.
    const projStart = toTownLocal(FRAME, R, routePointAt(cut!.route, 0))!;
    expect(projStart.x).toBeCloseTo(clipLocal.x, 4);
    const projEnd = toTownLocal(FRAME, R, routePointAt(cut!.route, cut!.route.lengthM))!;
    expect(projEnd.y).toBeCloseTo(300, 4);
  });

  it("maps the town-at-'a' span with arc 0 at the TIP (parent arc grows a→b)", () => {
    const route = routeThrough([...CURVED].reverse());
    const cut = spliceRouteAtTown(route, "a", FRAME, 320, tips, R);
    expect(cut).not.toBeNull();
    expect(cut!.s0).toBe(0);
    const atCenter = toTownLocal(FRAME, R, routePointAt(cut!.route, 0))!;
    expect(atCenter.y).toBeCloseTo(300, 4); // the tip, not the plaza
  });

  it("refuses when towns overlap (route shorter than the clip window) or no tips", () => {
    const short = routeThrough([[600, 0], [300, 0], [0, 0]]);
    expect(spliceRouteAtTown(short, "b", FRAME, 320, tips, R)).toBeNull();
    const route = routeThrough(CURVED);
    expect(spliceRouteAtTown(route, "b", FRAME, 320, [], R)).toBeNull();
  });

  it("is deterministic: double-call byte-equal", () => {
    const route = routeThrough(CURVED);
    const a = spliceRouteAtTown(route, "b", FRAME, 320, tips, R);
    const b = spliceRouteAtTown(route, "b", FRAME, 320, tips, R);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* --------------- the persisted-bearings regrow seam still holds ----------- */

describe("prefix-stable regrow with stored bearings", () => {
  it("echoes its input bearings and regrows byte-identically from the echo", () => {
    const bearings = [quantB(1.0), quantB(-2.0)];
    const net = growStreets(7, "seamtown", 40, { bearings });
    expect(net.bearings).toEqual(bearings); // the echo persisted deltas carry
    const again = growStreets(7, "seamtown", 40, { bearings: net.bearings });
    expect(JSON.stringify(again)).toBe(JSON.stringify(net));
  });

  it("grows prefix-stably under the same bearings (deltas never re-lay)", () => {
    const bearings = [quantB(1.0)];
    const small = growStreets(7, "seamtown", 40, { bearings });
    const large = growStreets(7, "seamtown", 90, { bearings });
    expect(JSON.stringify(large.slots.slice(0, small.slots.length)))
      .toBe(JSON.stringify(small.slots));
  });

  it("changed bearings re-lay the town — which is WHY stored bearings must be reused", () => {
    const a = growStreets(7, "seamtown", 40, { bearings: [quantB(1.0)] });
    const b = growStreets(7, "seamtown", 40, { bearings: [quantB(2.0)] });
    expect(JSON.stringify(a.slots)).not.toBe(JSON.stringify(b.slots));
  });
});
