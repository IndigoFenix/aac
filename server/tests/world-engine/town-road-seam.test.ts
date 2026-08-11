// THE ROUTE → TOWN SEAM (growth phase B stage 2, §2.1–§2.3). Before this,
// only `number[]` bearings crossed from the planet's roads into the town
// layer: the polylines existed at the call site and were thrown away. Now
// the roads themselves arrive as growth seeds, so the town's BASELINE is
// the through road rather than a guess aimed along it.
//
// What this suite pins:
//   §2.1  townRoadSeeds — the producer. The overlap rule (an unclipped
//         route has no port and seeds nothing), the through/spur split,
//         determinism against the caller's incident ORDER, the cap.
//   §2.1  the whole pipe: registry → townBias → growStreets → the town's
//         own ports, and the SAVE round-trip (deltas.seeds) that lets a
//         reload regrow the identical tree with an empty registry.
//   §2.2  the gate IS the port — a span-seeded town's baseline reaches the
//         route's endpoint, so spliceRouteAtTown has nothing to bend.
//   §2.3  arrival: the primary port for a route town, the plaza otherwise.

import { describe, it, expect, afterEach } from "@jest/globals";
import {
  arterialTips, roadPortOf, spliceRouteAtTown, toPlanetDir, townRoadSeeds,
  type TownFrame,
} from "@shared/world-engine/kernel/town/approach.js";
import {
  portTerminateRoute, routeFromDirs, type PlanetRoute,
} from "@shared/world-engine/planet/routes.js";
import {
  growStreets, townPorts, type GrowSeed, type Vec2,
} from "@shared/world-engine/kernel/town/streets.js";
import {
  provideTownRoadSeeds, townRoadSeedsOf,
} from "@shared/world-engine/kernel/town/host.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { townArrival } from "@shared/world-engine/interaction/town/town-stage.js";
import { townPlaza } from "@shared/world-engine/kernel/town/plan.js";

const R = 1_000_000;
const FRAME: TownFrame = { center: [0, 0, 1], east: [1, 0, 0], north: [0, 1, 0] };
const EXT = 450;

/** A route through town-local waypoints, ending at the town centre. */
function routeThrough(local: Array<[number, number]>, a = 1, b = 2): PlanetRoute {
  const route = routeFromDirs(local.map(([x, y]) => toPlanetDir(FRAME, R, { x, y })), R, a, b);
  if (!route) throw new Error("degenerate test route");
  return route;
}

/** The same route as planet/routes.ts EMITS it: ported at the extent. */
function ported(local: Array<[number, number]>, end: "a" | "b", a = 1, b = 2): PlanetRoute {
  const route = routeThrough(local, a, b);
  const t = { id: end === "a" ? route.a : route.b, dir: FRAME.center, extentM: EXT };
  return portTerminateRoute(route, R, end === "a" ? t : null, end === "b" ? t : null);
}

/** A road in from the east, and one out to the west — the through road. */
const EAST = (): PlanetRoute => ported([[9000, 200], [4000, 80], [0, 0]], "b", 1, 2);
const WEST = (): PlanetRoute => ported([[-9000, -200], [-4000, -80], [0, 0]], "b", 3, 2);
const NORTH = (): PlanetRoute => ported([[100, 9000], [40, 4000], [0, 0]], "b", 4, 2);

const spanOf = (s: GrowSeed): { pts: Vec2[]; portA?: true; portB?: true } =>
  s as { pts: Vec2[]; portA?: true; portB?: true };
const rOf = (p: Vec2): number => Math.hypot(p.x, p.y);

describe("§2.1 townRoadSeeds — the roads become what the town grows around", () => {
  it("pairs the most-opposed ports into ONE through span, both ends flagged", () => {
    const seeds = townRoadSeeds(
      [{ route: EAST(), end: "b" }, { route: WEST(), end: "b" }], FRAME, R, EXT,
    );
    expect(seeds).toHaveLength(1);
    const span = spanOf(seeds[0]!);
    expect(seeds[0]!.kind).toBe("span");
    expect(span.portA).toBe(true);
    expect(span.portB).toBe(true);
    // It runs gate to gate — both ends sit ON the extent, and it crosses
    // the middle rather than skirting it.
    expect(rOf(span.pts[0]!)).toBeCloseTo(EXT, 0);
    expect(rOf(span.pts[span.pts.length - 1]!)).toBeCloseTo(EXT, 0);
    const mid = span.pts[span.pts.length >> 1]!;
    expect(rOf(mid)).toBeLessThan(60);
  });

  it("a road that only ENDS here becomes a spur: the far end alone is a port", () => {
    const seeds = townRoadSeeds([{ route: NORTH(), end: "b" }], FRAME, R, EXT);
    expect(seeds).toHaveLength(1);
    const span = spanOf(seeds[0]!);
    expect(span.portA).toBeUndefined();
    expect(span.portB).toBe(true);
    expect(rOf(span.pts[0]!)).toBeLessThan(1);          // starts in the middle
    expect(rOf(span.pts[span.pts.length - 1]!)).toBeCloseTo(EXT, 0);
  });

  it("THE OVERLAP RULE: an unclipped route ports nowhere and seeds nothing", () => {
    // portTerminateRoute hands back the raw route when the two towns'
    // extents swallow the whole road — its endpoint is the cell centre.
    const raw = routeThrough([[300, 0], [150, 0], [0, 0]]);
    expect(roadPortOf(raw, "b", FRAME, R, EXT)).toBeNull();
    expect(townRoadSeeds([{ route: raw, end: "b" }], FRAME, R, EXT)).toEqual([]);
    // …and a town where every road is like that falls back, silently.
    expect(townRoadSeeds([], FRAME, R, EXT)).toEqual([]);
  });

  it("is deterministic in (planet, city): the caller's incident ORDER cannot move it", () => {
    const inc = [
      { route: EAST(), end: "b" as const },
      { route: WEST(), end: "b" as const },
      { route: NORTH(), end: "b" as const },
    ];
    const a = townRoadSeeds(inc, FRAME, R, EXT);
    const b = townRoadSeeds([inc[2]!, inc[0]!, inc[1]!], FRAME, R, EXT);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a).toHaveLength(2); // the through road, plus the northern spur
  });

  it("collapses roads sharing a compass bucket and honours the cap", () => {
    const twin = ported([[9000, -200], [4000, -80], [0, 0]], "b", 5, 2);
    const inc = [
      { route: EAST(), end: "b" as const }, { route: twin, end: "b" as const },
      { route: NORTH(), end: "b" as const },
    ];
    // The twin east road shares the gate; two seeds come back, not three.
    expect(townRoadSeeds(inc, FRAME, R, EXT)).toHaveLength(2);
    expect(townRoadSeeds(inc, FRAME, R, EXT, 1)).toHaveLength(1);
  });
});

describe("§2.1/§2.2 the seeded tree: the baseline IS the road, the gate IS the port", () => {
  const seeds = townRoadSeeds(
    [{ route: EAST(), end: "b" }, { route: WEST(), end: "b" }, { route: NORTH(), end: "b" }],
    FRAME, R, EXT,
  );

  it("lays street 0 along the through span and declares its ends as ports", () => {
    const net = growStreets(7, "spanburg", 300, { seeds });
    const base = net.streets[0]!;
    expect(base.baseline).toBe(true);
    // Both ends of the baseline reach the extent…
    expect(rOf(base.pts[0]!)).toBeCloseTo(EXT, 0);
    expect(rOf(base.pts[base.pts.length - 1]!)).toBeCloseTo(EXT, 0);
    // …and both are declared gates, plus the northern spur's far end.
    const ports = townPorts(net);
    expect(ports).toHaveLength(3);
    for (const p of ports) expect(rOf(p)).toBeGreaterThan(EXT - 20);
  });

  it("the route's port needs NO connector — the town already reaches it", () => {
    const net = growStreets(7, "spanburg", 300, { seeds });
    const gates = arterialTips(net.streets, net.ports);
    for (const route of [EAST(), WEST(), NORTH()]) {
      expect(spliceRouteAtTown(route, "b", FRAME, EXT, gates, R)).toBeNull();
    }
  });

  it("a town whose streets stop SHORT of the port still splices (the stub path)", () => {
    // No seeds: growth invents a stub baseline and its arterials peter out
    // well inside the extent, so the road has to reach in for its gate.
    const stub = growStreets(7, "stubburg", 300, { bearings: [0] });
    const gates = arterialTips(stub.streets, stub.ports);
    const cut = spliceRouteAtTown(EAST(), "b", FRAME, EXT, gates, R);
    expect(cut).not.toBeNull();
    expect(cut!.route.lengthM).toBeGreaterThan(0);
  });
});

describe("§2.1 the pipe: registry → bias → tree, and the SAVE that replays it", () => {
  afterEach(() => {
    provideTownRoadSeeds("seamville", null);
  });

  it("registered seeds reach the plan, and clearing the registry restores the fallback", () => {
    const seeds = townRoadSeeds(
      [{ route: EAST(), end: "b" }, { route: WEST(), end: "b" }], FRAME, R, EXT,
    );
    provideTownRoadSeeds("seamville", seeds);
    expect(townRoadSeedsOf("seamville")).toHaveLength(1);
    const play = buildTownPlay({ seed: 5, key: "seamville", days: 220 });
    expect(play.plan.streets.seeds.some(s => s.kind === "span")).toBe(true);
    expect(townPorts(play.plan.streets).length).toBeGreaterThan(0);

    provideTownRoadSeeds("seamville", null);
    const bare = buildTownPlay({ seed: 5, key: "seamville", days: 220 });
    expect(bare.plan.streets.seeds.some(s => s.kind === "span")).toBe(false);
    // The road really did change the town — that is WHY it must be saved.
    expect(JSON.stringify(bare.plan.streets.slots))
      .not.toBe(JSON.stringify(play.plan.streets.slots));
  });

  it("the seed set is RECORDED in the deltas and regrows the identical tree", () => {
    const seeds = townRoadSeeds(
      [{ route: EAST(), end: "b" }, { route: WEST(), end: "b" }, { route: NORTH(), end: "b" }],
      FRAME, R, EXT,
    );
    provideTownRoadSeeds("seamville", seeds);
    const play = buildTownPlay({ seed: 5, key: "seamville", days: 220 });
    const saved = JSON.parse(JSON.stringify(play.deltas.toJSON())) as { seeds?: unknown[] };
    expect(saved.seeds).toHaveLength(seeds.length);

    // THE RELOAD: registry empty (a fresh session that never flew past the
    // roads), the save alone. The tree must come back byte-identical.
    provideTownRoadSeeds("seamville", null);
    const back = buildTownPlay({ seed: 5, key: "seamville", days: 220, deltas: saved as never });
    expect(JSON.stringify(back.plan.streets.streets))
      .toBe(JSON.stringify(play.plan.streets.streets));
    expect(JSON.stringify(back.plan.streets.slots))
      .toBe(JSON.stringify(play.plan.streets.slots));
    // The ord discipline holds: replaying a save never appends a second set.
    const twice = (back.deltas.toJSON() as { seeds?: unknown[] }).seeds;
    expect(twice).toHaveLength(seeds.length);
  });

  it("a town that declared nothing records nothing — growth re-invents its stub", () => {
    const play = buildTownPlay({ seed: 5, key: "quietville", days: 220 });
    expect(play.plan.streets.seeds).toEqual([]);
    const saved = JSON.parse(JSON.stringify(play.deltas.toJSON())) as { seeds?: unknown[] };
    expect(saved.seeds ?? []).toHaveLength(0);
    const back = buildTownPlay({ seed: 5, key: "quietville", days: 220, deltas: saved as never });
    expect(JSON.stringify(back.plan.streets.slots))
      .toBe(JSON.stringify(play.plan.streets.slots));
  });
});

describe("§2.3 arrival — you come in by the road when there IS one", () => {
  afterEach(() => {
    provideTownRoadSeeds("gateburg", null);
  });

  it("a ROUTE town is entered at its primary port, on the extent", () => {
    provideTownRoadSeeds("gateburg", townRoadSeeds(
      [{ route: EAST(), end: "b" }, { route: WEST(), end: "b" }], FRAME, R, EXT,
    ));
    const play = buildTownPlay({ seed: 5, key: "gateburg", days: 220 });
    const at = townArrival(play.plan, play.deltas.founded());
    expect(rOf(at)).toBeGreaterThan(EXT - 20);
    const primary = townPorts(play.plan.streets)[0]!;
    expect(at).toEqual({ x: primary.x, y: primary.y });
    // The stage's own spawn is the same point, offset into world coords.
    const spawn = play.stage.spec.spawns[0]!;
    expect(spawn.x).toBeCloseTo(play.stage.center.x + at.x, 6);
    expect(spawn.y).toBeCloseTo(play.stage.center.y + at.y, 6);
  });

  it("a town with no road arrives at the PLAZA, never the bare frame origin", () => {
    const play = buildTownPlay({ seed: 5, key: "gateburg", days: 220 });
    const at = townArrival(play.plan, play.deltas.founded());
    expect(at).toEqual(townPlaza(play.plan));
  });
});
