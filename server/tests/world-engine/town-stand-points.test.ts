// STAND-POINT PLANNING (interaction/quest/stand-points.ts) — where a body
// stands to use a fixture, and the door-aware routes that walk it there.
// Pins the observed field bug (DEBUG-CREATURE-BEHAVIOR §5): a chest hugging
// the rear wall, crowded on every interior side, got its stand point probed
// PAST the wall — clear ground BEHIND THE HOUSE — and the body walked out the
// front door and ground against the back wall forever. A stand candidate must
// share the fixture's ROOM, not merely be locally clear. Pure geometry, no GL.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  expandWorldBuildings,
  routeThroughDoors,
  structuresWalkable,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  fixtureCovering,
  nearestClearSpot,
  sameRoomAs,
  standClear,
  standPointFor,
} from "@shared/world-engine/interaction/quest/stand-points.js";
import { fixturesWalkable } from "@shared/world-engine/engine.js";
import { idlePadOf } from "@shared/world-engine/interaction/quest/floor-route.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { livingRect } from "@shared/world-engine/kernel/town/rooms.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

function spec(buildings: BuildingSpec[], objects: ObjectSpec[] = [], size = 40): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: size, height: size },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3 }],
    objects,
    buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

const fixture = (id: string, x: number, y: number, radius: number, kind: string): ObjectSpec => ({
  id,
  x,
  y,
  shape: "box",
  radius,
  fixture: kind as ObjectSpec["fixture"],
  interactions: [],
});

function openAllDoors(s: WorldState): void {
  for (const d of Object.values(s.doors)) d.open = 1;
}

describe("standPointFor — the same-room gate (the behind-the-house bug)", () => {
  // One room, front door south. The chest hugs the NORTH (rear) wall, its
  // goods-box neighbors flank it, a bed crowds the approach — the dollhouse
  // shape that walled in every interior candidate. The only locally-CLEAR
  // probe is past the rear wall, outside the house.
  const room: BuildingSpec = {
    id: "A",
    footprint: { x: 0, y: 0, w: 8, h: 6 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [{ edge: "south", offset: 4, width: 1.4 }],
  };
  const walledIn = [
    fixture("chest", 4, 0.75, 0.55, "chest"),
    fixture("nb_w", 2.8, 0.75, 0.55, "chest"),
    fixture("nb_e", 5.2, 0.75, 0.55, "barrel"),
    fixture("bed", 4, 2.6, 0.9, "bed"),
  ];

  it("REGRESSION: never hands back a stand point on the far side of the wall", () => {
    const s = createWorldState(expandWorldBuildings(spec([room], walledIn)), "me");
    const body = { x: 2, y: 4 };
    // Sanity: the bug's escape hatch IS locally clear — two steps past the
    // rear wall is open ground. Only the room gate can rule it out.
    expect(standClear(s, { x: 4, y: -1.02 })).toBe(true);
    expect(sameRoomAs(s, { x: 4, y: 0.75 }, { x: 4, y: -1.02 })).toBe(false);
    const p = standPointFor(s, "chest", { x: 4, y: 0.75 }, body);
    // Wherever it lands (walled-in here means the best-effort fallback), it
    // must be INSIDE the room — never behind the house.
    expect(sameRoomAs(s, { x: 4, y: 0.75 }, p)).toBe(true);
    expect(p.y).toBeGreaterThan(0);
  });

  it("an uncrowded wall chest still gets a clear interior stand point", () => {
    const s = createWorldState(
      expandWorldBuildings(spec([room], [fixture("chest", 4, 0.75, 0.55, "chest")])),
      "me",
    );
    const p = standPointFor(s, "chest", { x: 4, y: 0.75 }, { x: 2, y: 4 });
    expect(standClear(s, p)).toBe(true);
    expect(sameRoomAs(s, { x: 4, y: 0.75 }, p)).toBe(true);
  });

  // An item resting ON a table reports the tabletop's CENTRE as its position
  // (addVisibleContainedProp) — walking to the item's own coordinate grinds
  // into the solid table ("stuck reaching the consume point, into the table's
  // centre"). Both stand-point resolvers must nudge off the CONTAINING fixture.
  describe("item on a table — the stand point must clear the table box", () => {
    const bigRoom: BuildingSpec = {
      id: "A",
      footprint: { x: 0, y: 0, w: 12, h: 10 },
      floors: 1,
      wallThickness: 0.4,
      doorways: [{ edge: "south", offset: 6, width: 1.4 }],
    };

    it("standPointFor(item containedIn table) resolves off the table's edge", () => {
      const s = createWorldState(expandWorldBuildings(spec([bigRoom], [fixture("table", 6, 5, 0.8, "table")])), "me");
      (s.objects as unknown as Record<string, unknown>)["small:apple"] = {
        id: "small:apple", x: 6, y: 5, floor: 0, containedIn: { objectId: "table", relation: "on" },
      };
      const p = standPointFor(s, "small:apple", { x: 6, y: 5 }, { x: 3, y: 2.5 });
      expect(fixturesWalkable(s, p, 0.4)).toBe(true); // a body fits — not the blocked centre
      expect(Math.hypot(p.x - 6, p.y - 5)).toBeGreaterThan(1.2); // outside the table's no-stand box
      expect(sameRoomAs(s, { x: 6, y: 5 }, p)).toBe(true);
    });

    it("fixtureCovering reports the table for a point at its centre, null in the open", () => {
      const s = createWorldState(expandWorldBuildings(spec([bigRoom], [fixture("table", 6, 5, 0.8, "table")])), "me");
      expect(fixtureCovering(s, { x: 6, y: 5 })?.id).toBe("table");
      expect(fixtureCovering(s, { x: 2, y: 8 })).toBeNull();
    });

    it("nearestClearSpot nudges an item-on-a-BIG-table off the table box (girth-aware)", () => {
      // A radius-1.2 table: the old fixed 0.9/1.6 sweep can't clear its 1.6 box
      // and fell back to the blocked centre — the fixture-aware branch scales.
      const s = createWorldState(expandWorldBuildings(spec([bigRoom], [fixture("table", 6, 5, 1.2, "table")])), "me");
      const p = nearestClearSpot(s, { x: 6, y: 5 }, { x: 6, y: 9 });
      expect(fixturesWalkable(s, p, 0.4)).toBe(true);
      expect(Math.hypot(p.x - 6, p.y - 5)).toBeGreaterThan(1.6);
    });
  });

  it("nearestClearSpot never nudges a room anchor through a wall", () => {
    // A planned point inside a fixture that hugs the WEST wall: the outward
    // (−x) nudge is locally clear but outside — it must be rejected.
    const s = createWorldState(
      expandWorldBuildings(spec([room], [fixture("box", 0.9, 3, 0.6, "chest")])),
      "me",
    );
    const p = nearestClearSpot(s, { x: 0.9, y: 3 }, { x: 0.95, y: 3.01 });
    expect(sameRoomAs(s, { x: 0.9, y: 3 }, p)).toBe(true);
  });
});

describe("door-aware routes over REAL generated houses", () => {
  const center = { x: 200, y: 200 };
  const mkHouse = (index: number, w: number, h: number, door: TownHouse["door"]): TownHouse => ({
    index,
    dx: -w / 2,
    dy: -h / 2,
    w,
    h,
    door,
    color: "#a8875f",
    floors: 1,
  });

  /** Stage a house exactly like town-stage's FULL form: one building per room. */
  function stagedWorld(house: TownHouse): { s: WorldState; rooms: ReturnType<typeof houseRoomPlan>["rooms"] } {
    const rooms = houseRoomPlan(center, house).rooms;
    const buildings: BuildingSpec[] = rooms.map((room) => ({
      id: room.id,
      footprint: room.rect,
      floors: 1,
      stairs: false,
      wallThickness: 0.4,
      doorways: room.doorways,
      color: house.color,
    }));
    const s = createWorldState(expandWorldBuildings(spec(buildings, [], 400)), "me");
    openAllDoors(s);
    return { s, rooms };
  }

  /** Every straight sub-leg of the routed polyline must be WALKABLE (doors
   *  open) — a sample that lands in a wall is exactly the "cyan hop crossing
   *  a wall" the Paths overlay showed. */
  function polylineWalkable(s: WorldState, from: { x: number; y: number }, pts: { x: number; y: number }[]): boolean {
    let prev = from;
    for (const pt of pts) {
      const len = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      const n = Math.max(1, Math.ceil(len / 0.2));
      for (let i = 1; i <= n; i++) {
        const p = { x: prev.x + ((pt.x - prev.x) * i) / n, y: prev.y + ((pt.y - prev.y) * i) / n };
        if (!structuresWalkable(s, p, 0.1)) return false;
      }
      prev = pt;
    }
    return true;
  }

  const centerOf = (r: { x: number; y: number; w: number; h: number }) => ({
    x: r.x + r.w / 2,
    y: r.y + r.h / 2,
  });

  it("routes between every room pair thread doors — no leg crosses a wall", () => {
    for (const house of [mkHouse(0, 12, 9, "south"), mkHouse(3, 11, 10, "north"), mkHouse(7, 9, 12, "east")]) {
      const { s, rooms } = stagedWorld(house);
      if (rooms.length < 2) continue;
      for (const a of rooms) {
        for (const b of rooms) {
          if (a.id === b.id) continue;
          const from = centerOf(a.rect);
          const to = centerOf(b.rect);
          const pts = routeThroughDoors(s, from, to);
          expect(polylineWalkable(s, from, pts)).toBe(true);
        }
      }
    }
  });

  it("interior legs stay INSIDE the house — never out the front door and back", () => {
    const house = mkHouse(0, 12, 9, "south");
    const { s, rooms } = stagedWorld(house);
    const x0 = center.x + house.dx;
    const y0 = center.y + house.dy;
    for (const a of rooms) {
      for (const b of rooms) {
        if (a.id === b.id) continue;
        const pts = routeThroughDoors(s, centerOf(a.rect), centerOf(b.rect));
        for (const p of pts) {
          expect(p.x).toBeGreaterThanOrEqual(x0 - 0.1);
          expect(p.x).toBeLessThanOrEqual(x0 + house.w + 0.1);
          expect(p.y).toBeGreaterThanOrEqual(y0 - 0.1);
          expect(p.y).toBeLessThanOrEqual(y0 + house.h + 0.1);
        }
      }
    }
  });

  it("IDLE PADS: every furnished living room yields a clear rect, fully standable", () => {
    // The idle-pacing contract (DEBUG-CREATURE-BEHAVIOR §1.2): wander has no
    // router, so idle bodies pace only inside a designated furniture-free
    // rectangle. The pad must exist for ordinary homes, sit inside the living
    // room, and be walkable across its whole area at the body's girth.
    for (const house of [mkHouse(0, 12, 9, "south"), mkHouse(3, 11, 10, "north"), mkHouse(23, 11.8, 9.8, "west")]) {
      const rooms = houseRoomPlan(center, house).rooms;
      const buildings: BuildingSpec[] = rooms.map((room) => ({
        id: room.id,
        footprint: room.rect,
        floors: 1,
        stairs: false,
        wallThickness: 0.4,
        doorways: room.doorways,
        color: house.color,
      }));
      const pieces = houseFurniture(center, house, [{ key: "food", slot: 0 }, { key: "cloth", slot: 1 }]);
      const objects = pieces.map((p) => fixture(p.id, p.x, p.y, p.radius, p.kind));
      const s = createWorldState(expandWorldBuildings(spec(buildings, objects, 400)), "me");
      const lr = livingRect(center, house);
      const pad = idlePadOf(s, lr);
      expect(pad).not.toBeNull();
      // Inside the living room…
      expect(pad!.x).toBeGreaterThanOrEqual(lr.x);
      expect(pad!.y).toBeGreaterThanOrEqual(lr.y);
      expect(pad!.x + pad!.w).toBeLessThanOrEqual(lr.x + lr.w + 0.01);
      expect(pad!.y + pad!.h).toBeLessThanOrEqual(lr.y + lr.h + 0.01);
      // …big enough to pace in (a clear LANE counts), standable across a grid.
      expect(Math.min(pad!.w, pad!.h)).toBeGreaterThanOrEqual(0.9);
      expect(pad!.w * pad!.h).toBeGreaterThanOrEqual(2.5);
      for (let gx = 0.15; gx <= 0.86; gx += 0.35) {
        for (let gy = 0.15; gy <= 0.86; gy += 0.35) {
          const p = { x: pad!.x + pad!.w * gx, y: pad!.y + pad!.h * gy };
          expect(standClear(s, p)).toBe(true);
        }
      }
    }
  });

  it("a body outside walks in through the street door to a back room", () => {
    const house = mkHouse(0, 12, 9, "south"); // street door on the +y side
    const { s, rooms } = stagedWorld(house);
    const back = rooms.reduce((best, r) => (r.rect.y < best.rect.y ? r : best), rooms[0]!);
    const from = { x: center.x, y: center.y + house.h / 2 + 3 }; // on the street
    const pts = routeThroughDoors(s, from, centerOf(back.rect));
    expect(pts.length).toBeGreaterThan(1); // threaded at least one door
    expect(polylineWalkable(s, from, pts)).toBe(true);
  });
});
