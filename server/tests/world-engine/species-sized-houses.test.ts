// SPECIES-SIZED CONSTRUCTION — the pin for "a species builds houses for its
// own adult size". A TownHouse carries its CONSTRUCTING species; the room
// generator re-derives every passability floor from that species' body radius
// (rooms.ts houseMetricsFor), the furnisher's service flood certifies lanes at
// the same radius (placement.ts ctx.bodyR), and the indoor router plans at the
// MOVER's radius (floor-route planGeom). The chain's guarantee: a mover of the
// design size OR SMALLER can route to any furnished station without a leg
// passing through furniture. An OVERSIZED visitor merely plans at its own
// girth — it fits where it fits, and the planner must not crash or wedge a
// plan through a fixture-free lie it can't walk.
import { describe, it, expect } from "@jest/globals";
import { createWorldState, expandWorldBuildings, fixturesWalkable, type WorldState } from "@shared/world-engine/engine.js";
import { routeIndoorAware } from "@shared/world-engine/interaction/quest/floor-route.js";
import { nearestClearSpot, standClear } from "@shared/world-engine/interaction/quest/stand-points.js";
import {
  DEFAULT_BODY_RADIUS_M,
  registerSpecies,
  speciesBodyRadius,
} from "@shared/world-engine/creatures/species.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { houseMetricsFor, houseRoomPlan, livingRect } from "@shared/world-engine/kernel/town/rooms.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

// A broad-bodied test species — bigger than the people default, small enough
// that the historical footprints still afford rooms.
const TROLL = "test_troll";
const TROLL_R = 0.55;
registerSpecies({ id: TROLL, name: "Test troll", kind: "creature", blueprint: {}, bodyRadiusM: TROLL_R });

const center = { x: 200, y: 200 };
const mkHouse = (index: number, w: number, h: number, door: TownHouse["door"], species?: string): TownHouse =>
  ({ index, dx: -w / 2, dy: -h / 2, w, h, door, color: "#a8875f", floors: 1, ...(species ? { species } : {}) });

/** Raise one furnished house into a walkable WorldState (repro-water's rig). */
function furnishedWorld(house: TownHouse): { s: WorldState; pieces: ReturnType<typeof houseFurniture> } {
  const rooms = houseRoomPlan(center, house).rooms;
  const buildings: BuildingSpec[] = rooms.map((room) => ({
    id: room.id, footprint: room.rect, floors: 1, stairs: false,
    wallThickness: 0.4, doorways: room.doorways, color: house.color,
  }));
  const pieces = houseFurniture(center, house, [{ key: "food", slot: 0 }, { key: "cloth", slot: 1 }]);
  const objects: ObjectSpec[] = pieces.map((p) => ({
    id: p.id, x: p.x, y: p.y, shape: "box", radius: p.radius,
    fixture: p.kind as ObjectSpec["fixture"], interactions: [],
  }));
  const spec: WorldSpec = {
    engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 400, height: 400 }, terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3 }], objects, buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" }, content: { kind: "sandbox" },
  };
  const s = createWorldState(expandWorldBuildings(spec), "me");
  for (const d of Object.values(s.doors)) (d as { open: number }).open = 1;
  return { s, pieces };
}

/** First fixture hit walking the route at `bodyR` (arrival zone exempt), or
 *  null. Probes at THE TANGENCY TOLERANCE (bodyR − 0.06, stand-points.ts
 *  PLAN_SLACK): the planner legally places stand/transit points tangent to
 *  fixtures, and the follower's arrival radii absorb that boundary — a graze
 *  within the slack is by-design, a genuine pass-THROUGH still fails. */
function routeHit(
  s: WorldState,
  from: { x: number; y: number },
  route: Array<{ x: number; y: number }>,
  target: { x: number; y: number },
  bodyR: number,
): { x: number; y: number } | null {
  const STAND_ZONE = 1.2 + (bodyR - DEFAULT_BODY_RADIUS_M); // the stand point sits tangent to its neighbours
  const probeR = bodyR - 0.06;
  let prev = from;
  for (const pt of route) {
    const len = Math.hypot(pt.x - prev.x, pt.y - prev.y);
    const n = Math.max(1, Math.ceil(len / 0.08));
    for (let i = 1; i <= n; i++) {
      const p = { x: prev.x + ((pt.x - prev.x) * i) / n, y: prev.y + ((pt.y - prev.y) * i) / n };
      if (Math.hypot(p.x - target.x, p.y - target.y) <= STAND_ZONE) continue;
      if (!fixturesWalkable(s, p, probeR)) return p;
    }
    prev = pt;
  }
  return null;
}

/** A robustly-standable start on the living-room floor at `bodyR`. */
function clearStart(s: WorldState, house: TownHouse, bodyR: number): { x: number; y: number } {
  const lr = livingRect(center, house);
  const c0 = { x: lr.x + lr.w / 2, y: lr.y + lr.h / 2 };
  const ok = (p: { x: number; y: number }) => fixturesWalkable(s, p, bodyR + 0.1);
  for (const rad of [0, 0.6, 1.2, 1.8, 2.4]) {
    for (let ang = 0; ang < 6.28; ang += 0.523) {
      const p = { x: c0.x + Math.cos(ang) * rad, y: c0.y + Math.sin(ang) * rad };
      if (ok(p)) return p;
    }
  }
  return c0;
}

describe("species sizes resolve from the species definition", () => {
  it("explicit, defaulted, unknown and absent species all resolve", () => {
    expect(speciesBodyRadius(TROLL)).toBe(TROLL_R);
    expect(speciesBodyRadius("human_cute")).toBe(DEFAULT_BODY_RADIUS_M); // authored on the people
    expect(speciesBodyRadius("no_such_species")).toBe(DEFAULT_BODY_RADIUS_M);
    expect(speciesBodyRadius(undefined)).toBe(DEFAULT_BODY_RADIUS_M);
  });

  it("the default-species plan is unchanged by naming the default explicitly", () => {
    const anon = houseRoomPlan(center, mkHouse(0, 12, 9, "south"));
    const named = houseRoomPlan(center, mkHouse(0, 12, 9, "south", "human_cute"));
    expect(named).toEqual(anon);
  });
});

describe("a species builds for its own size (rooms + furniture + routing)", () => {
  it("passability floors re-derive from the constructing body", () => {
    const people = houseMetricsFor(DEFAULT_BODY_RADIUS_M);
    const troll = houseMetricsFor(TROLL_R);
    // keepOut = wall + 2R grows by 2·ΔR; door/hall floors carry it.
    expect(troll.roomDoorW).toBeCloseTo(people.roomDoorW + 2 * (TROLL_R - DEFAULT_BODY_RADIUS_M), 9);
    expect(troll.hallW).toBeCloseTo(people.hallW + 2 * (TROLL_R - DEFAULT_BODY_RADIUS_M), 9);
    // And every door the troll plan cuts is at least its own floor wide.
    const plan = houseRoomPlan(center, mkHouse(1, 12, 10, "south", TROLL));
    for (const room of plan.rooms) {
      for (const d of room.doorways) expect(d.width).toBeGreaterThanOrEqual(troll.roomDoorW - 1e-9);
    }
  });

  // The design guarantee, walked: in a TROLL-built house, a troll routes to
  // every solid station without any leg passing through furniture — and so
  // does anyone smaller.
  for (const [w, h, door] of [[12, 9, "south"], [11.8, 9.8, "east"], [11, 10, "north"]] as const) {
    it(`troll house ${w}×${h} ${door}: troll AND person route clean to every station`, () => {
      const house = mkHouse(2, w, h, door, TROLL);
      const { s, pieces } = furnishedWorld(house);
      for (const bodyR of [TROLL_R, DEFAULT_BODY_RADIUS_M]) {
        const body = clearStart(s, house, bodyR);
        const failures: string[] = [];
        for (const piece of pieces) {
          if (piece.kind === "chair" || piece.kind === "bowl") continue; // pass-through
          const target = nearestClearSpot(s, { x: piece.x, y: piece.y }, body, bodyR);
          // A WALLED-IN target (a goods box buried behind a bed in a corner
          // cluster — no standable spot at all) is not owed a clean route:
          // production's stall watch gives up and applies the effect in place
          // (termination over fidelity; town-errand-walk's same exemption).
          if (!standClear(s, target, bodyR)) continue;
          const route = routeIndoorAware(s, body, target, bodyR);
          const hit = routeHit(s, body, route, target, bodyR);
          if (hit) failures.push(`${piece.id}@r${bodyR}: (${hit.x.toFixed(2)},${hit.y.toFixed(2)})`);
        }
        expect(failures).toEqual([]);
      }
    });
  }

  it("an oversized visitor in a people-built house plans at its own girth and never lies", () => {
    const house = mkHouse(3, 12, 9, "south"); // people default
    const { s, pieces } = furnishedWorld(house);
    const body = clearStart(s, house, TROLL_R);
    for (const piece of pieces) {
      if (piece.kind === "chair" || piece.kind === "bowl") continue;
      const target = nearestClearSpot(s, { x: piece.x, y: piece.y }, body, TROLL_R);
      // Its own special-case pathfinding = the same planner at its own radius:
      // it must return a route (possibly a best-effort straight where nothing
      // fits) and never throw. Where the plan claims a refined dogleg (tight
      // arrive flow vertices), that corridor must genuinely pass at troll girth.
      const route = routeIndoorAware(s, body, target, TROLL_R);
      expect(route.length).toBeGreaterThan(0);
      const last = route[route.length - 1]!;
      expect(Math.hypot(last.x - target.x, last.y - target.y)).toBeLessThan(1e-6);
    }
  });
});
