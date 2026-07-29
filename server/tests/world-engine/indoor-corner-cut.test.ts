// NO CORNER-CUTTING INDOORS — the corridor-fidelity pin.
//
// THE LAW. A point the indoor router placed inside a building sits on a
// corridor it MEASURED, often a gap of a few centimetres between two fixtures'
// keep-outs (floor-route.ts plans at exactly the mover's collision radius).
// Every such point is marked `tight`, and a tight point must be walked EXACTLY:
// no steer-time shortcut may move the body off the planned line, because the
// only ground either side of that line is the furniture the route went around.
//
// THREE SHORTCUTS EXIST, AND ALL THREE ANSWER TO THE FLAG:
//   1. `detourAim` — the host's local aim bend (world-host: vetoed on a tight leg).
//   2. WALL-GLIDE — the engine's contact steering (engine.ts `wallGlide`), which
//      does not bend the aim but REPLACES it with the pressed face's tangent, and
//      whose contact outlives its last collision frame (CONTACT_HOLD_S) so the
//      body keeps walking a face it has already cleared. Granted at steer time
//      by the host — and, since this pin, withheld on a tight leg.
//   3. The PURE-PURSUIT CARROT itself (npc-controller): its 1.1 m lookahead
//      dwarfs the router's corner spacing (cells ≤ 0.25 m), so a carrot allowed
//      to walk its budget THROUGH a routed corner sits two or three corners
//      downstream and the body chords the whole dogleg. It now clamps on a tight
//      vertex (reach-extended, so the body keeps pace rather than braking into
//      the corner — the historical "brake-stalled tight arrival").
//
// Each of 2 and 3 was independently measured cutting a real routed dogleg: the
// carrot passed 0.13 m CLOSER to a table than any routed point did (on a route
// whose own margin was 0.13 m — i.e. it spent the whole budget and grazed the
// keep-out), and the glide left the planned line by 0.50 m where the glide-free
// body left it by 0.11 m.
//
// The pin is scale-free and states the law directly: THE BODY MAY NEVER PASS
// CLOSER TO A FIXTURE THAN THE ROUTE ITSELF DOES. It also insists the body still
// ARRIVES — a follower that holds its line by stalling has not fixed anything.
//
// Pure engine + controller logic, no GL — safe in `npm test`.

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
import { routeIndoorAware } from "@shared/world-engine/interaction/quest/floor-route.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

/** The mover's collision radius — the engine default, and the girth the router
 *  plans at (floor-route planGeom `plan`). */
const BODY_R = WORLD_ENGINE_DEFAULTS.avatarRadius;
/** One room, one table parked mid-floor: the smallest world that forces the
 *  router into a dogleg and gives the follower a corner to cut. */
const ROOM = { x: 100, y: 100, w: 12, h: 10 };
const TABLE = { x: 106, y: 105, radius: 1.1 };
/** Fixture keep-outs are SQUARES (engine fixturesWalkable) — clearance is the
 *  L∞ gap between the body's own collision square and the table's box. 0 = the
 *  body's edge is touching the fixture; negative is impossible (the constraint
 *  gates it) — which is why a cut shows up as clearance spent, not as overlap. */
function clearance(p: { x: number; y: number }): number {
  return Math.max(Math.abs(p.x - TABLE.x), Math.abs(p.y - TABLE.y)) - TABLE.radius - BODY_R;
}

function mkWorld(): WorldState {
  const buildings: BuildingSpec[] = [
    {
      id: "room",
      footprint: ROOM,
      floors: 1,
      stairs: false,
      wallThickness: 0.4,
      doorways: [{ edge: "south", offset: 5, width: 1.4 }],
      color: "#a8875f",
    },
  ];
  const objects: ObjectSpec[] = [
    { id: "table", x: TABLE.x, y: TABLE.y, shape: "box", radius: TABLE.radius, fixture: "table", interactions: [] },
  ];
  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 400, height: 400 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 5 }], // the local player, parked far away
    objects,
    buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  return createWorldState(expandWorldBuildings(spec), "me");
}

/** Distance from `p` to the walked plan (the entry point + every routed point). */
function distToPlan(p: { x: number; y: number }, poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const bx = b.x - a.x;
    const by = b.y - a.y;
    const len2 = bx * bx + by * by;
    const t = len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * bx + (p.y - a.y) * by) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + bx * t), p.y - (a.y + by * t)));
  }
  return best;
}

/** The ROUTE's own worst clearance — densely sampled, because the corridor the
 *  planner certified is the whole polyline, not just its vertices. This is the
 *  budget the follower is allowed to spend, and no more. */
function planClearance(poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02));
    for (let k = 0; k <= n; k++) {
      best = Math.min(best, clearance({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }));
    }
  }
  return best;
}

interface WalkResult {
  /** The plan as the host would build it (quest-host doorRouteErrand's fields). */
  plan: NpcErrandPoint[];
  planClear: number;
  bodyClear: number;
  maxDev: number;
  arrived: boolean;
}

/**
 * Walk one indoor errand EXACTLY the way the live host does: the real leg
 * assembly (routeIndoorAware + doorRouteErrand's `tight`/`arrive` tagging), the
 * real follower, the real detour veto, and — the part this file exists for —
 * the real STEER CONFIG, wall-glide granted to the NPC and withheld on a tight
 * leg. Steering with the bare defaults (as this harness once did) tests a
 * locomotion production does not run.
 */
function walkIndoor(from: { x: number; y: number }, to: { x: number; y: number }): WalkResult {
  const s = mkWorld();
  const body = addLocalAvatar(s, "npc", from.x, from.y);
  const ctrl = createNpcController({ id: "npc", x: from.x, y: from.y, behavior: { movement: "stationary" } });
  const mem = createDetourMemory();
  const walk = (p: { x: number; y: number }, r: number) =>
    structuresWalkable(s, p, r, 0) && fixturesWalkable(s, p, r, 0);
  // quest-host doorRouteErrand's point construction, verbatim: a point the
  // router placed inside a building is TIGHT; only the endpoint keeps the
  // caller's own arrival semantics.
  const legs = routeIndoorAware(s, from, to, BODY_R);
  const plan: NpcErrandPoint[] = legs.map((p, i) => ({
    x: p.x,
    y: p.y,
    ...(buildingAt(s, p.x, p.y) ? { tight: true } : {}),
    ...(i === legs.length - 1 ? {} : { arrive: p.arrive ?? 0.9 }),
  }));
  ctrl.setErrand({ points: plan });
  // world-host's steerConfigOf: glide is a steer-time grant, vetoed on a tight leg.
  const GLIDE: WorldEngineConfig = { ...WORLD_ENGINE_DEFAULTS, wallGlide: true };
  const poly = [{ x: from.x, y: from.y }, ...plan.map((p) => ({ x: p.x, y: p.y }))];
  const dt = 1 / 60;
  let t = 0;
  let bodyClear = Infinity;
  let maxDev = 0;
  for (let f = 0; f < 30 * 60 && ctrl.hasErrand(); f++) {
    const aim = ctrl.computeAim({
      self: body,
      humans: [],
      now: t,
      width: 400,
      height: 400,
      rng: () => 0.5,
      walkable: walk,
      radius: BODY_R,
    });
    // The world-host steering block, verbatim (one reading of the veto, two uses).
    const legTight = ctrl.errandLegTight();
    let bent = aim;
    if (aim && !legTight) {
      bent = detourAim({ x: body.x, y: body.y }, aim, walk, BODY_R, mem.prefer("npc", t));
      if (bent !== aim) mem.record("npc", sideOfBend({ x: body.x, y: body.y }, aim, bent), t);
    }
    body.crossingDoorId = ctrl.crossingDoorId();
    steerAvatar(s, "npc", bent, dt, legTight ? WORLD_ENGINE_DEFAULTS : GLIDE);
    tickWorld(s, { aim: null }, dt); // doors ease; the parked player brakes
    t += dt;
    bodyClear = Math.min(bodyClear, clearance(body));
    maxDev = Math.max(maxDev, distToPlan(body, poly));
  }
  return {
    plan,
    planClear: planClearance(poly),
    bodyClear,
    maxDev,
    arrived: Math.hypot(body.x - to.x, body.y - to.y) <= 1.0,
  };
}

// The three shapes a mid-room table produces: a dogleg staircase round its
// south-west corner, a single-corner diagonal, and a leg that merely GRAZES the
// corner (the one the glide used to drag half a metre off-plan).
const CASES: [string, { x: number; y: number }, { x: number; y: number }][] = [
  ["a dogleg round the table", { x: 102.5, y: 105 }, { x: 109.5, y: 105 }],
  ["a diagonal past its corner", { x: 102.5, y: 102.5 }, { x: 109.5, y: 107.5 }],
  ["a leg grazing the corner", { x: 102.5, y: 105 }, { x: 106, y: 107.6 }],
];

describe("no corner-cutting indoors — the walked line stays inside the routed corridor", () => {
  for (const [name, from, to] of CASES) {
    it(`${name}: the body never passes closer to the table than the route does`, () => {
      const r = walkIndoor(from, to);
      // Sanity: this case must actually be a TIGHT indoor plan, or it pins nothing.
      expect(r.plan.every((p) => p.tight === true)).toBe(true);
      // THE LAW. The route's own clearance is the entire budget; a follower that
      // spends it is standing where the planner never said it could. The 5 cm
      // tolerance is locomotion's own discretisation (one frame at walking pace),
      // not a licence to cut.
      expect(r.bodyClear).toBeGreaterThan(r.planClear - 0.05);
    });

    it(`${name}: the body holds the planned line`, () => {
      const r = walkIndoor(from, to);
      // A corridor measured in centimetres tolerates a hand's width of drift, no
      // more. Pre-fix this read 0.34 m (carrot chording) and 0.50 m (glide).
      expect(r.maxDev).toBeLessThan(0.25);
    });

    it(`${name}: and still ARRIVES`, () => {
      // Holding the line by refusing to move is not a fix. The tight-vertex
      // carrot clamp is reach-extended precisely so the body keeps walking pace
      // into a corner instead of braking onto it.
      expect(walkIndoor(from, to).arrived).toBe(true);
    });
  }
});

describe("the tight flag is what the host reads", () => {
  it("a routed indoor point is tight; a plain outdoor waypoint is not", () => {
    const ctrl = createNpcController({ id: "npc", x: 0, y: 0, behavior: { movement: "stationary" } });
    // Outdoors: a road waypoint carries the default arrival and no flag — the
    // aim bend and the glide both stay available (open ground, unmodelled rocks).
    ctrl.setErrand({ points: [{ x: 20, y: 0, arrive: 0.9 }, { x: 40, y: 0 }] });
    expect(ctrl.errandLegTight()).toBe(false);
    // Indoors: the router's say-so, whatever the arrival radius.
    ctrl.setErrand({ points: [{ x: 20, y: 0, arrive: 0.9, tight: true }, { x: 40, y: 0 }] });
    expect(ctrl.errandLegTight()).toBe(true);
    // A door transit predates the flag and is tight by its arrival radius alone.
    ctrl.setErrand({ points: [{ x: 20, y: 0, arrive: 0.4 }, { x: 40, y: 0 }] });
    expect(ctrl.errandLegTight()).toBe(true);
  });
});
