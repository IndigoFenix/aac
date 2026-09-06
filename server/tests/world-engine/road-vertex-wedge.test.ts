// THE FRONTIER PATHING WEDGE — two solids standing on ground navigation needs.
//
// MEASURED (frontier.spec seed 11, dt 1/2, 2026-09-06): every failed craft haul
// died in one of two ~10 m boxes on the house-24 ↔ town-yard corridor, and
// neither is a steering bug — a walkability scan of the straight between each
// wedged body and its own live waypoint reads `F` (fixture) end to end.
//
//   ① `resident_24_0` / `_24_1` pinned at (243.1, 242.2), live waypoint
//      (243.0, 244.7), `npcErrandActive` still true. The plan's PREVIOUS vertex
//      was (243.36377663584867, 243.36377663584867) — the town WELL's exact
//      centre (radius 0.8, solid), because the plaza well is placed at the town
//      centre and the town centre IS the street graph's origin junction. The
//      errand had been handed a waypoint inside a solid; the legs either side of
//      it were then planned from opposite faces of it (hence the 0.25 m
//      "staircase" hugging its keep-out and the BACKWARD step north), so the
//      straight joining them crosses the well and nothing can free the body.
//   ② `resident_3_3` / `_8_3` pinned at (251.7, 244.2) at door `w_1_west_d0`.
//      `store:food:0` (250.651, 244.047) and `store:clothing:0` (250.651,
//      244.247), radius 0.6 each, stand IN that 2.00 m opening — `w_1`'s ONLY
//      door, 1 clear lane in 41. The building is SEALED; its two workers can
//      never leave. Cause: the market shelf was placed at a blind `src.x + 1.4`
//      from `workDoorstep`, which for a WEST-facing seller points back through
//      its own door.
//
// Both pins are PURE (fixture world + the real assembly + the real follower),
// and both are LAWS, not numbers: a routed waypoint must be ground a body can
// occupy, and a prop must not seal the building it belongs to.
//
// THE FOLLOWER IS RUN WITH A WATCHER IN RANGE ON PURPOSE. npc-controller's
// stall watchdog force-passes a FLOW vertex only while nobody can see the body
// or its destination (`stalled && !watched`, VIEW_R 42) — and in the measured
// session somebody could, which is why the wedge lasted the whole arc instead
// of self-clearing in 5 s. A pin that walks an unwatched body is pinning the
// backstop, not the route.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  buildingAt,
  createWorldState,
  expandWorldBuildings,
  fixturesWalkable,
  steerAvatar,
  structuresWalkable,
  tickWorld,
  WORLD_ENGINE_DEFAULTS,
  type WorldEngineConfig,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  createDetourMemory,
  createNpcController,
  detourAim,
  sideOfBend,
  type NpcErrandPoint,
} from "@shared/world-engine/npc-controller.js";
import { routeIndoorAware, standableVia } from "@shared/world-engine/interaction/quest/floor-route.js";
import { propSpotClearOfRect, standClear } from "@shared/world-engine/interaction/quest/stand-points.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const BODY_R = WORLD_ENGINE_DEFAULTS.avatarRadius;
/** The frontier's plaza well, verbatim: a solid box fixture of radius 0.8. */
const WELL_R = 0.8;
/** A market shelf, verbatim (quest-host `MARKET_SHELF_R`). */
const SHELF_R = 0.6;

function mkSpec(buildings: BuildingSpec[], objects: ObjectSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 400, height: 400 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5 }],
    objects,
    buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/**
 * The host's own errand assembly (quest-host `doorRouteErrand` + `roadLeg`),
 * restated ONLY where the test must supply the street route: the via list is
 * handed in, each entry answered by the production `standableVia`, and every
 * emitted point tagged exactly as the host tags it (tight indoors, `arrive`
 * everywhere but the endpoint).
 */
function planErrand(
  s: WorldState,
  from: { x: number; y: number },
  via: { x: number; y: number }[],
  to: { x: number; y: number },
): NpcErrandPoint[] {
  const legs: { x: number; y: number }[] = [];
  for (const v of via) {
    const q = standableVia(s, v, from, BODY_R);
    if (q) legs.push(q);
  }
  legs.push(to);
  const plan: NpcErrandPoint[] = [];
  let prev = from;
  legs.forEach((q, li) => {
    const isFinal = li === legs.length - 1;
    const routed = routeIndoorAware(s, prev, q, BODY_R);
    routed.forEach((p, i) => {
      const isEndpoint = isFinal && i === routed.length - 1;
      plan.push({
        x: p.x,
        y: p.y,
        ...(buildingAt(s, p.x, p.y) ? { tight: true } : {}),
        ...(isEndpoint ? {} : { arrive: p.arrive ?? 0.9 }),
        ...(p.doorId ? { doorId: p.doorId } : {}),
      });
    });
    prev = q;
  });
  return plan;
}

/** Walk a plan with the REAL follower and the REAL world-host steering block
 *  (aim bend and wall-glide both withheld on a tight leg), a watcher parked
 *  beside the destination. Returns where the body ended and whether it landed. */
function walkPlan(
  s: WorldState,
  from: { x: number; y: number },
  to: { x: number; y: number },
  plan: NpcErrandPoint[],
  seconds = 120,
): { x: number; y: number; arrived: boolean } {
  const body = addLocalAvatar(s, "npc", from.x, from.y);
  const watcher = addLocalAvatar(s, "watcher", to.x + 1.5, to.y + 1.5);
  const ctrl = createNpcController({ id: "npc", x: from.x, y: from.y, behavior: { movement: "stationary" } });
  const mem = createDetourMemory();
  const walk = (p: { x: number; y: number }, r: number) =>
    structuresWalkable(s, p, r, 0) && fixturesWalkable(s, p, r, 0);
  ctrl.setErrand({ points: plan });
  const GLIDE: WorldEngineConfig = { ...WORLD_ENGINE_DEFAULTS, wallGlide: true };
  const dt = 1 / 60;
  let t = 0;
  for (let f = 0; f < seconds * 60 && ctrl.hasErrand(); f++) {
    const aim = ctrl.computeAim({
      self: body,
      humans: [watcher],
      now: t,
      width: 400,
      height: 400,
      rng: () => 0.5,
      walkable: walk,
      radius: BODY_R,
    });
    const legTight = ctrl.errandLegTight();
    let bent = aim;
    if (aim && !legTight) {
      bent = detourAim({ x: body.x, y: body.y }, aim, walk, BODY_R, mem.prefer("npc", t));
      if (bent !== aim) mem.record("npc", sideOfBend({ x: body.x, y: body.y }, aim, bent), t);
    }
    body.crossingDoorId = ctrl.crossingDoorId();
    steerAvatar(s, "npc", bent, dt, legTight ? WORLD_ENGINE_DEFAULTS : GLIDE);
    tickWorld(s, { aim: null }, dt);
    t += dt;
  }
  return { x: body.x, y: body.y, arrived: Math.hypot(body.x - to.x, body.y - to.y) <= 1.2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① THE PLAZA WELL ON THE STREET GRAPH'S ORIGIN JUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/** The town centre — the street net's local origin, and where the plaza well is
 *  placed. The approach and departure legs are the frontier's own, expressed as
 *  offsets from the well: the carrier came from (+5.81, +13.83) and was leaving
 *  toward (−15.89, +1.84). */
const WELL = { x: 200, y: 200 };
const APPROACH = { x: WELL.x + 5.81, y: WELL.y + 13.83 };
const DEPART = { x: WELL.x - 15.89, y: WELL.y + 1.84 };

function wellWorld(): WorldState {
  return createWorldState(
    expandWorldBuildings(
      mkSpec([], [
        { id: "well", x: WELL.x, y: WELL.y, shape: "box", radius: WELL_R, fixture: "barrel", interactions: [] },
      ]),
    ),
    "me",
  );
}

describe("a street-route vertex a body cannot stand on never becomes an errand waypoint", () => {
  it("the fixture that produced the wedge really does block its own centre", () => {
    // Sanity: without this the pins below prove nothing.
    const s = wellWorld();
    expect(standClear(s, WELL, BODY_R)).toBe(false);
  });

  it("every routed waypoint is ground the mover can occupy", () => {
    const s = wellWorld();
    const plan = planErrand(s, APPROACH, [WELL], DEPART);
    const bad = plan.filter((p) => !standClear(s, p, BODY_R));
    // Pre-fix this listed the well's exact centre — `roadLeg` spliced the street
    // vertex in verbatim and `routeIndoorAware` pushed it through untouched.
    expect(bad).toEqual([]);
  });

  it("the plan never turns BACK across the obstruction", () => {
    // The measured tell: the leg INTO the vertex ended south of the well and the
    // leg OUT of it started north of it, so the connecting straight crossed it.
    // Stated scale-free: consecutive waypoints must be joined by walkable ground.
    const s = wellWorld();
    const plan = planErrand(s, APPROACH, [WELL], DEPART);
    const poly = [APPROACH, ...plan];
    const crossings: string[] = [];
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
      for (let k = 0; k <= n; k++) {
        const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        if (!fixturesWalkable(s, q, BODY_R, 0)) {
          crossings.push(`${i}→${i + 1} @ ${q.x.toFixed(2)},${q.y.toFixed(2)}`);
          break;
        }
      }
    }
    expect(crossings).toEqual([]);
  });

  it("and the body actually gets there — watched, with no escape hatch", () => {
    const s = wellWorld();
    const plan = planErrand(s, APPROACH, [WELL], DEPART);
    const r = walkPlan(s, APPROACH, DEPART, plan);
    // Pre-fix the body stopped ~1.2 m short of the well's south face and stayed
    // there: aim-bend and glide both withheld (the next corner's `arrive 0.5`
    // reads as tight), and the flow force-pass suppressed by the watcher.
    expect(r.arrived).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② THE MARKET SHELF IN THE SELLER'S OWN DOORWAY
// ─────────────────────────────────────────────────────────────────────────────

/** The seller: a 12 × 20 shop with ONE door, on its WEST wall — `w_1`'s shape. */
const SHOP = { x: 100, y: 100, w: 12, h: 20 };
const DOOR_W = 2.0;
/** `workDoorstep`, verbatim: 1.5 m out from the DOOR edge along its normal. */
const DOORSTEP = { x: SHOP.x - 1.5, y: SHOP.y + SHOP.h / 2 };
/** `stockContainers`' own offset: 1.4 m aside, one 0.2 m lane per good. */
const shelfOffset = (gi: number) => ({ x: 1.4, y: -0.2 + gi * 0.2 });

function shopWorld(spots: { x: number; y: number }[]): WorldState {
  const buildings: BuildingSpec[] = [
    {
      id: "shop",
      footprint: SHOP,
      floors: 1,
      stairs: false,
      wallThickness: 0.4,
      doorways: [{ edge: "west", offset: SHOP.h / 2, width: DOOR_W }],
      color: "#c9803a",
    },
  ];
  const objects: ObjectSpec[] = spots.map((p, i) => ({
    id: `store:good:${i}`,
    x: p.x,
    y: p.y,
    shape: "box",
    radius: SHELF_R,
    fixture: "chest",
    interactions: [],
  }));
  return createWorldState(expandWorldBuildings(mkSpec(buildings, objects)), "me");
}

/** Where the two shelves go under the production rule. */
function shelfSpots(): { x: number; y: number }[] {
  return [0, 1].map((gi) =>
    propSpotClearOfRect(DOORSTEP, shelfOffset(gi), SHOP, SHELF_R + BODY_R),
  );
}

describe("a market shelf never seals the seller it belongs to", () => {
  it("the blind offset really did land in the doorway", () => {
    // Sanity, and the shape of the original defect: `workDoorstep` sits on the
    // door's OUTWARD normal, so +x for a west-facing seller walks back inside.
    const raw = [0, 1].map((gi) => ({ x: DOORSTEP.x + shelfOffset(gi).x, y: DOORSTEP.y + shelfOffset(gi).y }));
    const sealed = shopWorld(raw);
    const lanes = doorLanes(sealed);
    expect(lanes).toBe(0);
  });

  it("the chosen spots leave a lane a body can walk", () => {
    expect(doorLanes(shopWorld(shelfSpots()))).toBeGreaterThan(0);
  });

  it("a worker inside can walk out and reach the street", () => {
    const s = shopWorld(shelfSpots());
    const from = { x: SHOP.x + 4, y: SHOP.y + SHOP.h / 2 };
    const to = { x: SHOP.x - 8, y: SHOP.y + SHOP.h / 2 };
    const plan = planErrand(s, from, [], to);
    const r = walkPlan(s, from, to, plan);
    expect(r.arrived).toBe(true);
  });

  it("a shelf that already stands clear is NOT moved", () => {
    // The rule is a veto, not a re-planner: every town whose stalls were placed
    // on the right side of their seller keeps them exactly where they were.
    const east = { x: SHOP.x + SHOP.w + 1.5, y: SHOP.y + SHOP.h / 2 }; // an east-facing seller
    for (const gi of [0, 1]) {
      const off = shelfOffset(gi);
      expect(propSpotClearOfRect(east, off, SHOP, SHELF_R + BODY_R)).toEqual({
        x: east.x + off.x,
        y: east.y + off.y,
      });
    }
  });
});

/** How many lanes across the door's opening a body could stand in — the same
 *  measure the live probe reported as "clearLanes 1/41". */
function doorLanes(s: WorldState): number {
  const door = (s.spec.structures ?? []).find((st) => st.kind === "door");
  if (!door) return 0;
  const mid = { x: (door.a.x + door.b.x) / 2, y: (door.a.y + door.b.y) / 2 };
  const len = Math.hypot(door.b.x - door.a.x, door.b.y - door.a.y) || 1;
  const ux = (door.b.x - door.a.x) / len;
  const uy = (door.b.y - door.a.y) / len;
  let lanes = 0;
  // Only lanes a body could actually stand in: the last body-radius at each end
  // is inside the jamb, whatever the fixtures say (the live probe's own "1 of
  // 41 clear" was exactly that endpoint).
  const half = Math.max(0, len / 2 - BODY_R);
  for (let k = -20; k <= 20; k++) {
    const t = (k / 20) * half;
    const p = { x: mid.x + ux * t, y: mid.y + uy * t };
    // The leaf itself is not the question — whether a body fits through is.
    const clear = [-0.8, 0, 0.8].every((d) =>
      fixturesWalkable(s, { x: p.x - uy * d, y: p.y + ux * d }, BODY_R, 0),
    );
    if (clear) lanes++;
  }
  return lanes;
}
