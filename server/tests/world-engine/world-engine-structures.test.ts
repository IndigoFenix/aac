// Engine-owned structures: walls + doors. Pure engine logic, no GL — safe in the
// default `npm test`. Confirms a wall blocks movement, a door swings open on
// approach and is then passable, a locked door stays solid until unlocked, and a
// carried key object opens its door. Also exercises the collision math directly.

import { describe, it, expect } from "@jest/globals";
import {
  carryObject,
  createWorldState,
  expandWorldBuildings,
  makeStructureConstraint,
  pointSegmentDistance,
  setDoorOpen,
  structuresWalkable,
  tickWorld,
  unlockDoor,
  WORLD_ENGINE_DEFAULTS,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { BuildingSpec, ObjectSpec, StructureSpec, WorldSpec } from "@shared/world-engine/types.js";

function spec(structures: StructureSpec[], objects: ObjectSpec[] = []): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 10, y: 2, facing: 0 }],
    objects,
    structures,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

// A wall/door spanning x∈[6,14] at y=8, thickness 1 — a barrier between the
// avatar (spawned at y=2) and the far side (y>8).
const wall: StructureSpec = { kind: "wall", id: "w", a: { x: 6, y: 8 }, b: { x: 14, y: 8 }, thickness: 1 };
const door = (extra: Partial<Extract<StructureSpec, { kind: "door" }>> = {}): StructureSpec => ({
  kind: "door",
  id: "d",
  a: { x: 6, y: 8 },
  b: { x: 14, y: 8 },
  thickness: 1,
  openRadius: 3,
  ...extra,
});

/** Steer the local avatar toward (aimX, aimY) for `seconds` at 60fps. */
function steerFor(state: WorldState, aimX: number, aimY: number, seconds: number): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) tickWorld(state, { aim: { x: aimX, y: aimY } }, 1 / 60);
}

describe("structures — geometry", () => {
  it("pointSegmentDistance clamps to the segment endpoints", () => {
    expect(pointSegmentDistance({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe(0);
    expect(pointSegmentDistance({ x: 10, y: 5 }, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe(5);
    // Beyond endpoint b → distance to b, not to the infinite line.
    expect(pointSegmentDistance({ x: 25, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe(5);
  });

  it("a wall makes points within thickness/2 + radius impassable", () => {
    const s = createWorldState(spec([wall]), "me");
    const c = makeStructureConstraint(s)!;
    expect(c.walkable({ x: 10, y: 8 }, 0.4)).toBe(false); // on the wall
    expect(c.walkable({ x: 10, y: 8.8 }, 0.4)).toBe(false); // within 0.5+0.4=0.9
    expect(c.walkable({ x: 10, y: 10 }, 0.4)).toBe(true); // clear
    expect(c.walkable({ x: 2, y: 8 }, 0.4)).toBe(true); // past the segment end
  });
});

describe("walls block movement", () => {
  it("an avatar cannot cross a wall", () => {
    const s = createWorldState(spec([wall]), "me");
    steerFor(s, 10, 20, 3); // aim across the wall for 3s
    expect(s.avatars.me.y).toBeLessThan(8); // stuck on the near side
  });
});

// A DOOR IS OPENED BY AN ACT, NEVER BY PROXIMITY.
//
// Two acts, and nothing else: a body walks the route leg through it (it declares
// `crossingDoorId`, which routeThroughDoors tags onto both transit points of the
// pair), or something opens it deliberately (`setDoorOpen`). Standing beside a
// door, or crossing the room in front of one, does nothing at all — the door
// does not read the room. This is the same rule container lids follow
// (`ObjectState.heldOpen`, world-engine-fixtures.test.ts).
//
// These tests steer the avatar directly, so they play the part the host plays for
// real bodies: set `crossingDoorId` while the body is on the crossing, clear it
// when it isn't.
describe("doors", () => {
  /** Declare (or withdraw) the door this body is walking through — what
   *  world-host does each frame from the live errand waypoint's tag. */
  function crossing(state: WorldState, id: string, doorId: string | null): void {
    state.avatars[id]!.crossingDoorId = doorId;
  }

  it("a closed door blocks until a body walking through it declares the crossing", () => {
    const s = createWorldState(spec([door()]), "me");
    expect(s.doors.d.open).toBe(0);
    expect(structuresWalkable(s, { x: 10, y: 8 }, 0.4)).toBe(false); // closed = solid

    // Walk straight at the doorway WITHOUT declaring anything: the door is a wall.
    steerFor(s, 10, 20, 4);
    expect(s.doors.d.open).toBe(0);
    expect(s.avatars.me.y).toBeLessThan(8); // stuck on the near side

    // Now the body is walking this door's transit leg — and gets through.
    crossing(s, "me", "d");
    steerFor(s, 10, 20, 4);
    expect(s.avatars.me.y).toBeGreaterThan(8);
  });

  it("shuts again once the body is no longer crossing it", () => {
    const s = createWorldState(spec([door()]), "me");
    crossing(s, "me", "d");
    steerFor(s, 10, 20, 4); // open it + pass through
    expect(s.doors.d.open).toBeGreaterThan(0.5);
    // The transit leg is done: the host clears the declaration, and the door lets
    // go — measured after walking clear, so "in the opening" can't hold it.
    crossing(s, "me", null);
    steerFor(s, 10, 30, 3);
    expect(s.doors.d.open).toBeLessThan(0.5);
  });

  it("ignores a body that merely walks past the opening", () => {
    // A narrow door at x∈[9,11], y=8, flanked by solid wall. The body ambles
    // PARALLEL right in front of the opening for six seconds — under the old
    // geometric rule this was the bug being chased with ever-tighter throat
    // tests; now it needs no test of aim or velocity at all, because the body
    // never claimed to be crossing.
    const narrow: StructureSpec[] = [
      { kind: "wall", id: "wl", a: { x: 0, y: 8 }, b: { x: 9, y: 8 }, thickness: 1 },
      { kind: "wall", id: "wr", a: { x: 11, y: 8 }, b: { x: 20, y: 8 }, thickness: 1 },
      { kind: "door", id: "d", a: { x: 9, y: 8 }, b: { x: 11, y: 8 }, thickness: 1, openRadius: 3 },
    ];
    const s = createWorldState({ ...spec(narrow), spawns: [{ id: "s", x: 2, y: 6.6, facing: 0 }] }, "s");
    let peak = 0;
    for (let i = 0; i < 360; i++) {
      tickWorld(s, { aim: { x: 18, y: 6.6 } }, 1 / 60);
      peak = Math.max(peak, s.doors.d.open);
    }
    expect(peak).toBe(0); // not "small" — it never moved
  });

  it("opens BEFORE the body reaches the leaf, so a crossing never stalls", () => {
    // The no-delay contract. The near transit point sits ~1.1 m short of the
    // door, and the swing rate clears doorPassThreshold in a fraction of that
    // walk — so by the time the body is at the leaf the way is already open and
    // it keeps its stride. If this ever regresses, bodies visibly hitch at every
    // doorway in the town.
    const s = createWorldState({ ...spec([door()]), spawns: [{ id: "s", x: 10, y: 6.9, facing: 0 }] }, "s");
    crossing(s, "s", "d");
    let ticks = 0;
    while (ticks < 240 && s.doors.d.open < WORLD_ENGINE_DEFAULTS.doorPassThreshold) {
      tickWorld(s, { aim: { x: 10, y: 20 } }, 1 / 60);
      ticks += 1;
    }
    expect(s.doors.d.open).toBeGreaterThanOrEqual(WORLD_ENGINE_DEFAULTS.doorPassThreshold);
    expect(ticks).toBeLessThan(20); // under a third of a second
    // And the body has not been stopped by the leaf it was walking toward.
    expect(s.avatars.s.vy).toBeGreaterThan(0);
  });

  it("does not shut on a body standing in the doorway", () => {
    // Holding a door open for a body physically in the opening is not a second
    // way to OPEN one — it is a refusal to swing a leaf through somebody. It is
    // also what lets a graspless creature follow through behind someone.
    const s = createWorldState(spec([door()]), "me");
    crossing(s, "me", "d");
    steerFor(s, 10, 8, 3); // walk INTO the opening and stop there
    expect(Math.abs(s.avatars.me.y - 8)).toBeLessThan(1);
    crossing(s, "me", null); // the leg ended while it stands in the gap
    steerFor(s, 10, 8, 2);
    expect(s.doors.d.open).toBeGreaterThan(0.5); // still open — it's standing there
  });

  it("refuses to open for a body that cannot open doors", () => {
    // A pet may pass through what somebody else opened, never work one itself.
    const s = createWorldState(spec([door()]), "me");
    s.avatars.me.canOpen = false;
    crossing(s, "me", "d");
    steerFor(s, 10, 20, 4);
    expect(s.doors.d.open).toBe(0);
    expect(s.avatars.me.y).toBeLessThan(8);
  });

  it("setDoorOpen pins a door open with nobody near, and releases it", () => {
    // The ACTION half: opening a door is not the same as walking through one —
    // it stays open afterwards, which is the entire point.
    const s = createWorldState(spec([door()]), "me");
    setDoorOpen(s, "d", true);
    steerFor(s, 10, 2, 2); // stay put, far from the door
    expect(s.doors.d.open).toBe(1);
    expect(structuresWalkable(s, { x: 10, y: 8 }, 0.4)).toBe(true);

    setDoorOpen(s, "d", false);
    steerFor(s, 10, 2, 2);
    expect(s.doors.d.open).toBe(0);
  });

  it("setDoorOpen cannot open a LOCKED door", () => {
    // Otherwise "open the door" would be a way around every lock in the world.
    const s = createWorldState(spec([door({ locked: true })]), "me");
    setDoorOpen(s, "d", true);
    steerFor(s, 10, 2, 2);
    expect(s.doors.d.open).toBe(0);
    expect(s.doors.d.pinned).toBeFalsy();
  });

  it("a locked door stays solid even for a crossing body; unlockDoor lets it open", () => {
    const s = createWorldState(spec([door({ locked: true })]), "me");
    expect(s.doors.d.locked).toBe(true);
    crossing(s, "me", "d");
    steerFor(s, 10, 20, 4);
    expect(s.doors.d.open).toBe(0); // never opened
    expect(s.avatars.me.y).toBeLessThan(8); // blocked like a wall

    unlockDoor(s, "d");
    steerFor(s, 10, 20, 4);
    expect(s.avatars.me.y).toBeGreaterThan(8); // now passable
  });

  it("carrying the key through unlocks + opens a locked door", () => {
    const key: ObjectSpec = { id: "key", x: 10, y: 2, shape: "box", radius: 0.3, interactions: ["carry"] };
    const s = createWorldState(spec([door({ locked: true, keyObjectId: "key" })], [key]), "me");
    carryObject(s, "key", "me"); // the avatar holds the key
    crossing(s, "me", "d"); // …and is taking it THROUGH this door
    steerFor(s, 10, 20, 4);
    expect(s.doors.d.locked).toBe(false); // the key turned the lock
    expect(s.avatars.me.y).toBeGreaterThan(8); // and we walked through
  });

  it("opens BOTH leaves of one doorway, so a room boundary is really passable", () => {
    // A gap between two rooms is realised twice — each room lowers its OWN wall
    // to its own door leaf — so `expandWorldBuildings` emits two door structures
    // on the same segment. Collision blocks on either, so a declaration naming
    // whichever leaf the router picked has to swing the twin as well or the
    // "open" doorway is still a wall. This is the bug that stalled every routed
    // errand into another room the moment doors stopped opening by proximity.
    const rooms: BuildingSpec[] = [
      { id: "A", footprint: { x: 0, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "east", offset: 3, width: 2 }] },
      { id: "B", footprint: { x: 6, y: 0, w: 6, h: 6 }, floors: 1, wallThickness: 0.4, doorways: [{ edge: "west", offset: 3, width: 2 }] },
    ];
    const s = createWorldState(
      expandWorldBuildings({ ...spec([]), buildings: rooms, spawns: [{ id: "s", x: 3, y: 3, facing: 0 }] }),
      "s",
    );
    const leaves = (s.spec.structures ?? []).filter((st) => st.kind === "door").map((st) => st.id);
    expect(leaves.length).toBe(2); // one doorway, two leaves — the whole point

    // Declare only ONE of them, as the router does.
    crossing(s, "s", leaves[0]!);
    steerFor(s, 9, 3, 4);
    for (const id of leaves) expect(s.doors[id]!.open).toBeGreaterThan(0.5);
    expect(s.avatars.s.x).toBeGreaterThan(6.5); // and the body is in the next room

    // Same for the deliberate act: pinning one leaf pins the doorway.
    const s2 = createWorldState(
      expandWorldBuildings({ ...spec([]), buildings: rooms, spawns: [{ id: "s", x: 3, y: 3, facing: 0 }] }),
      "s",
    );
    setDoorOpen(s2, leaves[0]!, true);
    steerFor(s2, 3, 3, 1);
    for (const id of leaves) expect(s2.doors[id]!.open).toBe(1);
  });

  it("does not turn the lock for a key carried past a door it isn't crossing", () => {
    // The key opens the door you take it through, not every locked door you own.
    const key: ObjectSpec = { id: "key", x: 2, y: 2, shape: "box", radius: 0.3, interactions: ["carry"] };
    const s = createWorldState(
      { ...spec([door({ locked: true, keyObjectId: "key" })], [key]), spawns: [{ id: "s", x: 2, y: 2, facing: 0 }] },
      "s",
    );
    carryObject(s, "key", "s");
    steerFor(s, 18, 2, 4); // walk the length of the room, well clear of the doorway
    expect(s.doors.d.locked).toBe(true);
  });
});

describe("structures — schema", () => {
  it("accepts a valid wall + door", () => {
    expect(validateWorldSpec(spec([wall, door()])).ok).toBe(true);
  });

  it("rejects a degenerate segment", () => {
    const bad = spec([{ kind: "wall", id: "w", a: { x: 5, y: 5 }, b: { x: 5, y: 5 }, thickness: 1 }]);
    expect(validateWorldSpec(bad).ok).toBe(false);
  });

  it("rejects a door whose keyObjectId is not a carryable object", () => {
    const bad = spec([door({ locked: true, keyObjectId: "nope" })]);
    expect(validateWorldSpec(bad).ok).toBe(false);
  });

  it("rejects a structure id that collides with an object id", () => {
    const obj: ObjectSpec = { id: "d", x: 3, y: 3, shape: "box", radius: 0.4, interactions: ["carry"] };
    const bad = spec([door()], [obj]); // door id "d" == object id "d"
    expect(validateWorldSpec(bad).ok).toBe(false);
  });
});
