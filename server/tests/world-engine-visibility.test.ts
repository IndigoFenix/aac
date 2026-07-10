// visibleBuildings — the single "can I see inside this building" signal shared
// by the renderer (roof fade + indoor body cull) and the resident streamer.
// Rooms-as-buildings: an open, unlocked door joins rooms into one visible space;
// a locked/shut door hides the room beyond; and the reveal never spills from
// inside a house back out to the street and into a neighbour. Pure engine logic.

import { describe, it, expect } from "@jest/globals";
import {
  accessibleBuildings,
  createWorldState,
  expandWorldBuildings,
  visibleBuildings,
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

/** Two rooms of one house sharing the wall at x=6, joined by an interior door,
 *  plus an exterior door on A's west wall (onto the street at x=0). */
const HOUSE: BuildingSpec[] = [
  {
    id: "A",
    footprint: { x: 0, y: 0, w: 6, h: 6 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [
      { edge: "east", offset: 3, width: 2 }, // interior, shared with B (mid ≈ (6,3))
      { edge: "west", offset: 3, width: 2 }, // exterior, onto the street (mid ≈ (0,3))
    ],
  },
  {
    id: "B",
    footprint: { x: 6, y: 0, w: 6, h: 6 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [{ edge: "west", offset: 3, width: 2 }], // interior, shared with A
  },
];

/** An ENCLOSED house — two rooms joined by ONE interior door, with NO door to the
 *  outside (the real household embedding: a sealed box the spirit spawns inside). */
const ENCLOSED: BuildingSpec[] = [
  { id: "A", footprint: { x: 0, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "east", offset: 3, width: 2 }] },
  { id: "B", footprint: { x: 6, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "west", offset: 3, width: 2 }] },
];

/** Two SEPARATE houses across a yard (gap x∈(6,10)), each with an exterior door
 *  facing the gap. Nothing shares a wall. */
const YARD: BuildingSpec[] = [
  { id: "A", footprint: { x: 0, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "east", offset: 3, width: 2 }] },
  { id: "B", footprint: { x: 10, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "west", offset: 3, width: 2 }] },
];

function world(buildings: BuildingSpec[]): WorldState {
  return createWorldState(expandWorldBuildings(spec(buildings)), "me");
}

/** Set the swing/lock of every door whose midpoint x is near `atX`. */
function setDoors(s: WorldState, atX: number, open: number, locked = false): void {
  for (const st of s.spec.structures ?? []) {
    if (st.kind !== "door") continue;
    if (Math.abs((st.a.x + st.b.x) / 2 - atX) > 0.5) continue;
    s.doors[st.id]!.open = open;
    s.doors[st.id]!.locked = locked;
  }
}

describe("visibleBuildings — avatar-mode interior visibility", () => {
  it("reveals the room you stand in and every room an OPEN unlocked door joins to it", () => {
    const s = world(HOUSE);
    setDoors(s, 6, 1); // interior door swung open
    const vis = visibleBuildings(s, { x: 3, y: 3 }); // inside room A
    expect([...vis].sort()).toEqual(["A", "B"]);
  });

  it("a SHUT interior door hides the room beyond (only your room shows)", () => {
    const s = world(HOUSE);
    setDoors(s, 6, 0); // interior door closed
    const vis = visibleBuildings(s, { x: 3, y: 3 });
    expect([...vis]).toEqual(["A"]);
  });

  it("a LOCKED interior door hides the room beyond even while swung", () => {
    const s = world(HOUSE);
    setDoors(s, 6, 1, true); // open but locked = the gated puzzle room
    const vis = visibleBuildings(s, { x: 3, y: 3 });
    expect([...vis]).toEqual(["A"]);
  });

  it("from outdoors, an open exterior door NEAR the viewer reveals the interior (and rooms beyond)", () => {
    const s = world(HOUSE);
    setDoors(s, 0, 1); // exterior (street) door open
    setDoors(s, 6, 1); // interior door open
    const vis = visibleBuildings(s, { x: -1.5, y: 3 }); // just outside the street door
    expect([...vis].sort()).toEqual(["A", "B"]);
  });

  it("an open exterior door too FAR from the viewer reveals nothing (the 'nearby' clause)", () => {
    const s = world(HOUSE);
    setDoors(s, 0, 1);
    setDoors(s, 6, 1);
    const vis = visibleBuildings(s, { x: -20, y: 3 }); // way down the street
    expect(vis.size).toBe(0);
  });
});

describe("visibleBuildings — no reveal spills to a neighbour", () => {
  it("standing INSIDE a house does not see through its open front door into a neighbour", () => {
    const s = world(YARD);
    setDoors(s, 6, 1); // A's yard door open
    setDoors(s, 10, 1); // B's yard door open
    const vis = visibleBuildings(s, { x: 5, y: 3 }); // inside A, beside its open door
    expect([...vis]).toEqual(["A"]); // NOT B — leaving to the yard ends the reveal
  });

  it("standing IN the yard between them reveals both (outdoors is the shared space)", () => {
    const s = world(YARD);
    setDoors(s, 6, 1);
    setDoors(s, 10, 1);
    const vis = visibleBuildings(s, { x: 8, y: 3 }); // outdoors, both doors near + open
    expect([...vis].sort()).toEqual(["A", "B"]);
  });
});

describe("accessibleBuildings — spirit-mode (dollhouse) visibility", () => {
  it("reveals every room reachable through UNLOCKED doors, ignoring door swing + distance", () => {
    const s = world(HOUSE);
    setDoors(s, 0, 0); // exterior door SHUT (swing ignored for accessibility)
    setDoors(s, 6, 0); // interior door SHUT too
    expect([...accessibleBuildings(s)].sort()).toEqual(["A", "B"]);
  });

  it("a puzzle-LOCKED interior door walls off the room beyond (it keeps its roof)", () => {
    const s = world(HOUSE);
    setDoors(s, 0, 1); // entrance reachable
    setDoors(s, 6, 0, true); // interior door locked → B inaccessible
    expect([...accessibleBuildings(s)]).toEqual(["A"]);
  });

  it("a LOCKED entrance hides the whole house (nothing reachable from outside)", () => {
    const s = world(HOUSE);
    setDoors(s, 0, 0, true); // only way in is locked
    setDoors(s, 6, 0); // interior unlocked, but A can't be reached
    expect(accessibleBuildings(s).size).toBe(0);
  });

  it("unlocking the gate later re-admits the room (the roof lifts)", () => {
    const s = world(HOUSE);
    setDoors(s, 0, 0);
    setDoors(s, 6, 0, true);
    expect([...accessibleBuildings(s)]).toEqual(["A"]);
    setDoors(s, 6, 0, false); // the puzzle clears the lock
    expect([...accessibleBuildings(s)].sort()).toEqual(["A", "B"]);
  });

  it("SEEDS from the spirit's room, not open ground — a sealed house reveals nothing without a viewer", () => {
    const s = world(ENCLOSED); // no door to the outside
    // No viewer → flood from outdoors reaches nothing (the reported bug).
    expect(accessibleBuildings(s).size).toBe(0);
    // Seeded at the spirit's spawn room, the whole reachable suite lights up.
    expect([...accessibleBuildings(s, { x: 3, y: 3 })].sort()).toEqual(["A", "B"]);
  });

  it("a locked door still walls off a room when seeded from inside a sealed house", () => {
    const s = world(ENCLOSED);
    setDoors(s, 6, 0, true); // the only interior door is locked
    expect([...accessibleBuildings(s, { x: 3, y: 3 })]).toEqual(["A"]);
  });
});
