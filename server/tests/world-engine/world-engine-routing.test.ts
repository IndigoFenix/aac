// routeThroughDoors — door-aware waypoints. An errand leg that crosses a room
// boundary must line up with the REAL doorway (its live segment center, so an
// off-centre door is honoured) and pass through it, instead of cutting straight
// through the wall (npc-controller only slides on walls, never re-paths). Pure
// engine geometry, no GL.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  expandWorldBuildings,
  routeThroughDoors,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

function spec(buildings: BuildingSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3, facing: 0 }],
    objects: [],
    buildings,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/** Two rooms sharing the wall at x=6, joined by ONE interior door at `offset`
 *  along that wall (offset 3 = centered on the 6-tall wall; 1.5 = off-centre). */
function twoRooms(offset: number): BuildingSpec[] {
  return [
    { id: "A", footprint: { x: 0, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "east", offset, width: 2 }] },
    { id: "B", footprint: { x: 6, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "west", offset, width: 2 }] },
  ];
}

function world(buildings: BuildingSpec[]): WorldState {
  return createWorldState(expandWorldBuildings(spec(buildings)), "me");
}

function lockDoors(s: WorldState): void {
  for (const st of s.spec.structures ?? []) if (st.kind === "door") s.doors[st.id]!.locked = true;
}

describe("routeThroughDoors", () => {
  it("returns just the destination when start and end share a room", () => {
    const s = world(twoRooms(3));
    expect(routeThroughDoors(s, { x: 2, y: 3 }, { x: 4, y: 4 })).toEqual([{ x: 4, y: 4 }]);
  });

  it("inserts a near/far transit pair lined up with the doorway when crossing rooms", () => {
    const s = world(twoRooms(3)); // centered door → mid (6,3)
    const to = { x: 9, y: 3 };
    const pts = routeThroughDoors(s, { x: 2, y: 3 }, to);
    expect(pts).toHaveLength(3); // approach, exit, destination
    const [approach, exit, dest] = pts;
    expect(dest).toEqual(to);
    // Both transit points hug the door center line (y≈3) and straddle the wall x=6.
    expect(approach!.x).toBeLessThan(6); // on A's side
    expect(exit!.x).toBeGreaterThan(6); // on B's side
    expect(Math.abs(approach!.y - 3)).toBeLessThan(0.01);
    expect(Math.abs(exit!.y - 3)).toBeLessThan(0.01);
  });

  it("targets the REAL (off-centre) door, not the wall midpoint", () => {
    const s = world(twoRooms(1.5)); // door low on the wall → mid (6,1.5)
    const pts = routeThroughDoors(s, { x: 2, y: 3 }, { x: 9, y: 3 });
    expect(pts).toHaveLength(3);
    // The transit points line up with the door at y≈1.5 — NOT the side center y=3.
    expect(Math.abs(pts[0]!.y - 1.5)).toBeLessThan(0.01);
    expect(Math.abs(pts[1]!.y - 1.5)).toBeLessThan(0.01);
  });

  it("falls back to a straight line when the only door is locked (no route)", () => {
    const s = world(twoRooms(3));
    lockDoors(s);
    const to = { x: 9, y: 3 };
    expect(routeThroughDoors(s, { x: 2, y: 3 }, to)).toEqual([to]);
  });

  it("tags BOTH transit points with the doorway they cross", () => {
    // The tag is what opens the door: whoever steers the body copies the live
    // waypoint's `doorId` into `AvatarState.crossingDoorId`, and tickDoors swings
    // only doors somebody is walking through. An untagged pair means a body walks
    // its crossing without declaring it — and stands at a shut door forever.
    const s = world(twoRooms(3));
    const doorId = (s.spec.structures ?? []).find((st) => st.kind === "door")!.id;
    const pts = routeThroughDoors(s, { x: 2, y: 3 }, { x: 9, y: 3 });
    expect(pts[0]!.doorId).toBe(doorId);
    expect(pts[1]!.doorId).toBe(doorId);
  });

  it("leaves the leg's own endpoint untagged — arriving is not crossing", () => {
    const s = world(twoRooms(3));
    const pts = routeThroughDoors(s, { x: 2, y: 3 }, { x: 9, y: 3 });
    expect(pts[pts.length - 1]!.doorId).toBeUndefined();
    // …and the same-room case is a bare destination, so nothing is declared for a
    // walk that crosses no doorway at all.
    expect(routeThroughDoors(s, { x: 2, y: 3 }, { x: 4, y: 4 })[0]!.doorId).toBeUndefined();
  });

  it("names each door separately across a chain of rooms", () => {
    // Three rooms in a row, two doors. A body two doorways from its goal must
    // declare only the door it is at — so the pairs cannot share one tag.
    const s = world([
      { id: "A", footprint: { x: 0, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "east", offset: 3, width: 2 }] },
      { id: "B", footprint: { x: 6, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "west", offset: 3, width: 2 }, { edge: "east", offset: 3, width: 2 }] },
      { id: "C", footprint: { x: 12, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "west", offset: 3, width: 2 }] },
    ]);
    const pts = routeThroughDoors(s, { x: 2, y: 3 }, { x: 15, y: 3 });
    const tags = pts.map((p) => p.doorId);
    expect(tags[tags.length - 1]).toBeUndefined();
    const crossed = [...new Set(tags.filter((t): t is string => !!t))];
    expect(crossed).toHaveLength(2); // two distinct doorways on the way
  });
});
