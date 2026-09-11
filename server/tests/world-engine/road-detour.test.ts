// THE ROAD ROUTE THAT GOES THE WRONG WAY — a 54 m trip planned as 165 m.
//
// MEASURED (dollhouse seed 12, dt 1/20, 900 sim-s, no player command): the
// civic haul to the pending annex `h_206_a0` is issued from (183.7, 315.8) to
// (175.9, 262.1) — 54.3 m due NORTH — and `roadLeg` splices a street route of
// 165.2 m that runs SOUTH-EAST first, out to (227.0, 314.1), 87 m from the
// site, before it ever turns back. The claimant's window expires; the row
// re-posts; the annex cycled nine claims for one arrival.
//
// TWO INDEPENDENT CAUSES, both pinned here:
//
//   ① THE ENTRY VERTEX IS NOT THE NEAREST. `project` (kernel/town/streets.ts)
//      scans `net.streets` and never `net.links`, so a body standing ON one of
//      the graph's own shortcut links is projected onto a STREET 8–15 m away.
//      Measured: all six dollhouse links carry interior vertices 8.4–15.1 m
//      from the nearest street, and every detoured leg of a 50 sim-s arc
//      begins or ends on one. The emitted route then walks OUT to that street,
//      back along the link over the body's own position, past the destination,
//      out to the destination's projection and back: 71.6 m of plan for a
//      12.6 m walk. The vertices of the real route are reproduced verbatim in
//      ② below.
//   ② THE STREETS GENUINELY DO NOT GO THERE. After ①, `h_206_a0` is still a
//      137.8 m on-street walk for a 54.3 m trip — the town's tree has no edge
//      across those blocks — so the road is not a shortcut and taking it is a
//      lie.
//
// `roadLegVia` (floor-route.ts) answers both: the entry and exit are the
// route's NEAREST vertices to the leg's own ends (a prefix/suffix is cut only
// when the straight replacing it is ground the mover can walk, so the trim can
// never invent a route through a wall), and what survives is spliced only while
// it stays inside `ROAD_DETOUR_MAX` × the DIRECT floor route.
//
// PURE: fixture worlds, the production function, no host and no sim.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  expandWorldBuildings,
  WORLD_ENGINE_DEFAULTS,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  ROAD_DETOUR_MAX,
  roadLegVia,
  routeIndoorAware,
} from "@shared/world-engine/interaction/quest/floor-route.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const BODY_R = WORLD_ENGINE_DEFAULTS.avatarRadius;
type V = { x: number; y: number };

function mkSpec(buildings: BuildingSpec[], objects: ObjectSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 600, height: 600 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5 }],
    objects,
    buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/** An open field — nothing on it, so the direct route between any two points
 *  IS the straight line and the road has nothing to buy. */
function openWorld(objects: ObjectSpec[] = []): WorldState {
  return createWorldState(expandWorldBuildings(mkSpec([], objects)), "me");
}

/** A solid box fixture, the same shape the frontier's plaza well is. */
function solid(id: string, x: number, y: number, r = 0.8): ObjectSpec {
  return { id, x, y, shape: "box", radius: r, fixture: "barrel", interactions: [] };
}

function polyLen(pts: V[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return n;
}
const planLen = (from: V, via: V[], to: V): number => polyLen([from, ...via, to]);
const directLen = (s: WorldState, from: V, to: V): number =>
  polyLen([from, ...routeIndoorAware(s, from, to, BODY_R)]);

// ─────────────────────────────────────────────────────────────────────────────
// ① THE LINK THE PROJECTOR CANNOT SEE — the entry and exit are the NEAREST
// ─────────────────────────────────────────────────────────────────────────────

/** `roadRoute(net, (244.8,352.3), (232.3,354.2))` on the dollhouse, seed 12,
 *  interior vertices verbatim (`scripts/tmp-road-probe.ts`, 2026-09-09). Both
 *  ENDS of the trip lie on link[1]'s centreline — `244.8,352.3` and
 *  `232.3,354.2` are two of its four points — and the route walks over both of
 *  them on its way out to the projections that bracket them. */
const LINK_FROM: V = { x: 244.8, y: 352.3 };
const LINK_TO: V = { x: 232.3, y: 354.2 };
const LINK_VIA: V[] = [
  { x: 250.6, y: 346.2 }, // pa.pt — street 4, 8.4 m from a body standing on the link
  { x: 257.3, y: 350.5 },
  { x: 244.8, y: 352.3 }, // …the body's own position, four vertices in
  { x: 232.3, y: 354.2 }, // …and the destination
  { x: 219.8, y: 356.0 },
  { x: 223.7, y: 360.9 }, // pb.pt — street 8, 11.0 m the far side
];

describe("the entry and exit of a spliced road leg are its nearest vertices", () => {
  it("the measured dollhouse route really does walk 5.7× the trip", () => {
    // Sanity: without this the pin below proves nothing.
    const chord = Math.hypot(LINK_TO.x - LINK_FROM.x, LINK_TO.y - LINK_FROM.y);
    expect(chord).toBeCloseTo(12.64, 1);
    expect(planLen(LINK_FROM, LINK_VIA, LINK_TO)).toBeGreaterThan(70);
  });

  it("splices the stretch between them and drops the walk out and back", () => {
    const s = openWorld();
    const kept = roadLegVia(s, LINK_FROM, LINK_TO, LINK_VIA, BODY_R);
    // The nearest vertex to the body is index 2 (it IS the body's spot) and the
    // nearest to the destination is index 3 — so exactly those two survive.
    expect(kept).toEqual([LINK_VIA[2], LINK_VIA[3]]);
    expect(planLen(LINK_FROM, kept, LINK_TO)).toBeCloseTo(12.64, 1);
  });

  it("returns the caller's own vertices, never a new point", () => {
    const s = openWorld();
    const kept = roadLegVia(s, LINK_FROM, LINK_TO, LINK_VIA, BODY_R);
    // Identity, not equality: the endpoints and the vertices are the caller's.
    for (const p of kept) expect(LINK_VIA.some((v) => v === p)).toBe(true);
    // …and in the route's own order.
    const idx = kept.map((p) => LINK_VIA.indexOf(p));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("splices nothing when the route reaches the destination before the body", () => {
    // exit < entry: the whole route runs backwards over itself, so no stretch of
    // it carries the body forward at all.
    const s = openWorld();
    const from: V = { x: 10, y: 0 };
    const to: V = { x: 0, y: 0 };
    const via: V[] = [{ x: 0, y: 5 }, { x: 10, y: 5 }];
    expect(roadLegVia(s, from, to, via, BODY_R)).toEqual([]);
  });

  it("never cuts a corner the mover cannot walk", () => {
    const from: V = { x: 0, y: 0 };
    const to: V = { x: 60, y: 0 };
    const away: V = { x: -6, y: 0 };
    const near: V = { x: 3, y: 0 };
    // Open ground: the nearer vertex wins and the walk out west is dropped.
    expect(roadLegVia(openWorld(), from, to, [away, near], BODY_R)).toEqual([near]);
    // A solid on that shortcut, and the trim is refused — the road's own first
    // vertex stands rather than a straight through the obstruction.
    const walled = openWorld([solid("rock", 1.5, 0)]);
    expect(roadLegVia(walled, from, to, [away, near], BODY_R)).toEqual([away, near]);
  });

  it("is a no-op with no street vertices to weigh", () => {
    expect(roadLegVia(openWorld(), { x: 0, y: 0 }, { x: 40, y: 0 }, [], BODY_R)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② THE STREETS THAT DO NOT GO THERE — the bound, measured on the direct route
// ─────────────────────────────────────────────────────────────────────────────

/** `roadRoute(net, (183.7,315.8), (175.9,262.1))` on the dollhouse, seed 12 —
 *  the `h_206_a0` haul's own route, interior vertices verbatim. The trip is
 *  54.3 m due north; the plan is 165.2 m and its third vertex is 87 m from the
 *  site. Both ends are honestly off-network here (10.6 m and 16.8 m), so ①
 *  leaves the list alone: this one is the street tree, not the projector. */
const ANNEX_FROM: V = { x: 183.7, y: 315.8 };
const ANNEX_TO: V = { x: 175.9, y: 262.1 };
const ANNEX_VIA: V[] = [
  { x: 179.3, y: 325.4 }, { x: 183.5, y: 327.3 }, { x: 197.3, y: 335.4 },
  { x: 211.9, y: 342.1 }, { x: 219.4, y: 328.1 }, { x: 227.0, y: 314.1 },
  { x: 221.5, y: 308.3 }, { x: 209.2, y: 298.1 }, { x: 195.7, y: 289.4 },
  { x: 181.0, y: 283.0 }, { x: 168.8, y: 277.4 },
];

describe("a road leg longer than the direct route by more than the bound is not spliced", () => {
  it("the measured h_206_a0 route really is 3× the trip and turns the wrong way", () => {
    const chord = Math.hypot(ANNEX_TO.x - ANNEX_FROM.x, ANNEX_TO.y - ANNEX_FROM.y);
    expect(chord).toBeCloseTo(54.3, 1);
    const road = planLen(ANNEX_FROM, ANNEX_VIA, ANNEX_TO);
    expect(road).toBeGreaterThan(160);
    expect(road / chord).toBeGreaterThan(3);
    // …and it walks AWAY first: the farthest vertex from the site is 87 m off.
    const away = Math.max(...ANNEX_VIA.map((p) => Math.hypot(p.x - ANNEX_TO.x, p.y - ANNEX_TO.y)));
    expect(away).toBeGreaterThan(86);
  });

  it("drops it, and the caller plans the direct leg", () => {
    const s = openWorld();
    expect(roadLegVia(s, ANNEX_FROM, ANNEX_TO, ANNEX_VIA, BODY_R)).toEqual([]);
  });

  it("keeps a road that stays inside the bound", () => {
    // One block's worth of detour — the rectilinear cost the bound is derived
    // from — is what a road is FOR, and it is spliced unchanged.
    const s = openWorld();
    const from: V = { x: 0, y: 0 };
    const to: V = { x: 40, y: 0 };
    const via: V[] = [{ x: 0, y: 12 }, { x: 40, y: 12 }];
    const kept = roadLegVia(s, from, to, via, BODY_R);
    expect(kept).toEqual(via);
    expect(planLen(from, kept, to)).toBeLessThanOrEqual(ROAD_DETOUR_MAX * 40);
  });

  it("weighs the road against the DIRECT ROUTE, not the straight line", () => {
    // A U of solids around the body, mouth to the WEST: the direct route has to
    // walk out of it and back round, so the honest comparison is against that
    // walk and not against the straight line the body cannot take.
    const from: V = { x: 0, y: 0 };
    const to: V = { x: 6, y: 0 };
    const wall: ObjectSpec[] = [];
    let n = 0;
    for (let y = -3; y <= 3; y += 1.2) wall.push(solid(`e${n++}`, 2, y)); // the east face
    for (let x = -3; x <= 2; x += 1.2) wall.push(solid(`n${n++}`, x, -3)); // …and north
    for (let x = -3; x <= 2; x += 1.2) wall.push(solid(`s${n++}`, x, 3)); //  …and south
    const trapped = openWorld(wall);
    const chord = 6;
    const via: V[] = [{ x: 0, y: -9 }, { x: 6, y: -9 }];
    const road = planLen(from, via, to);
    // The fixture's own properties, asserted so the pin cannot rot silently:
    // the road is well past the bound on the CHORD…
    expect(road).toBeCloseTo(24, 3);
    expect(road).toBeGreaterThan(ROAD_DETOUR_MAX * chord);
    // …the open field agrees and drops it…
    expect(roadLegVia(openWorld(), from, to, via, BODY_R)).toEqual([]);
    // …but inside the U the direct route is long enough to justify it.
    const direct = directLen(trapped, from, to);
    expect(direct).toBeGreaterThan(ROAD_DETOUR_MAX * chord);
    expect(road).toBeLessThanOrEqual(ROAD_DETOUR_MAX * direct);
    expect(roadLegVia(trapped, from, to, via, BODY_R)).toEqual(via);
  });

  it("the bound is a factor on a measured route, not a distance", () => {
    // Scale the whole picture and the answer must not change — a bound with a
    // length in it would flip here.
    const s = openWorld();
    const from: V = { x: 0, y: 0 };
    for (const k of [1, 3, 10]) {
      const to: V = { x: 10 * k, y: 0 };
      const inside: V[] = [{ x: 0, y: 4 * k }, { x: 10 * k, y: 4 * k }];
      const outside: V[] = [{ x: 0, y: 9 * k }, { x: 10 * k, y: 9 * k }];
      expect(roadLegVia(s, from, to, inside, BODY_R)).toEqual(inside);
      expect(roadLegVia(s, from, to, outside, BODY_R)).toEqual([]);
    }
  });
});
