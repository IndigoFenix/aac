// Engine-owned structures: walls + doors. Pure engine logic, no GL — safe in the
// default `npm test`. Confirms a wall blocks movement, a door swings open on
// approach and is then passable, a locked door stays solid until unlocked, and a
// carried key object opens its door. Also exercises the collision math directly.

import { describe, it, expect } from "@jest/globals";
import {
  carryObject,
  createWorldState,
  makeStructureConstraint,
  pointSegmentDistance,
  structuresWalkable,
  tickWorld,
  unlockDoor,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { ObjectSpec, StructureSpec, WorldSpec } from "@shared/world-engine/types.js";

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

describe("doors", () => {
  it("a closed door blocks, swings open on approach, then is passable", () => {
    const s = createWorldState(spec([door()]), "me");
    expect(s.doors.d.open).toBe(0);
    expect(structuresWalkable(s, { x: 10, y: 8 }, 0.4)).toBe(false); // closed = solid

    // Walk into/through the doorway, tracking the peak swing (it reopens + shuts
    // again once the avatar has walked out the far side past openRadius).
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      tickWorld(s, { aim: { x: 10, y: 20 } }, 1 / 60);
      peak = Math.max(peak, s.doors.d.open);
    }
    expect(peak).toBeGreaterThan(0.5); // it opened
    expect(s.avatars.me.y).toBeGreaterThan(8); // and the avatar got through
  });

  it("a door closes again once nobody is near", () => {
    const s = createWorldState(spec([door()]), "me");
    steerFor(s, 10, 20, 4); // open it + pass through
    expect(s.doors.d.open).toBeGreaterThan(0.5);
    steerFor(s, 10, 30, 3); // walk far away
    expect(s.doors.d.open).toBeLessThan(0.5); // swung shut
  });

  it("opens for a body TRAVERSING the doorway, not one passing nearby", () => {
    // A narrow door at x∈[9,11], y=8, flanked by solid wall either side. A body
    // to the SIDE, or ambling PARALLEL in front of the opening, must not swing
    // it; only a body on a course THROUGH it does.
    const narrow = (): StructureSpec[] => [
      { kind: "wall", id: "wl", a: { x: 0, y: 8 }, b: { x: 9, y: 8 }, thickness: 1 },
      { kind: "wall", id: "wr", a: { x: 11, y: 8 }, b: { x: 20, y: 8 }, thickness: 1 },
      { kind: "door", id: "d", a: { x: 9, y: 8 }, b: { x: 11, y: 8 }, thickness: 1, openRadius: 3 },
    ];

    // (a) Walking PARALLEL to the wall, passing right in front of the opening
    // (along y=6.6, from x=2 to x=18) — near the door the whole time, but never
    // crossing it. The door stays shut.
    const sPar = createWorldState({ ...spec(narrow()), spawns: [{ id: "s", x: 2, y: 6.6, facing: 0 }] }, "s");
    let peakPar = 0;
    for (let i = 0; i < 360; i++) {
      tickWorld(sPar, { aim: { x: 18, y: 6.6 } }, 1 / 60);
      peakPar = Math.max(peakPar, sPar.doors.d.open);
    }
    expect(peakPar).toBeLessThan(0.3); // never opened for a body just passing by

    // (b) The same door, a body walking straight THROUGH it (x≈10, y 2→20).
    const sThru = createWorldState({ ...spec(narrow()), spawns: [{ id: "s", x: 10, y: 2, facing: 0 }] }, "s");
    let peakThru = 0;
    for (let i = 0; i < 360; i++) {
      tickWorld(sThru, { aim: { x: 10, y: 20 } }, 1 / 60);
      peakThru = Math.max(peakThru, sThru.doors.d.open);
    }
    expect(peakThru).toBeGreaterThan(0.5); // opened for the body going through
    expect(sThru.avatars.s.y).toBeGreaterThan(8); // and it got across
  });

  it("a locked door stays solid; unlockDoor lets it open", () => {
    const s = createWorldState(spec([door({ locked: true })]), "me");
    expect(s.doors.d.locked).toBe(true);
    steerFor(s, 10, 20, 4);
    expect(s.doors.d.open).toBe(0); // never opened
    expect(s.avatars.me.y).toBeLessThan(8); // blocked like a wall

    unlockDoor(s, "d");
    steerFor(s, 10, 20, 4);
    expect(s.avatars.me.y).toBeGreaterThan(8); // now passable
  });

  it("carrying the key object unlocks + opens a locked door", () => {
    const key: ObjectSpec = { id: "key", x: 10, y: 2, shape: "box", radius: 0.3, interactions: ["carry"] };
    const s = createWorldState(spec([door({ locked: true, keyObjectId: "key" })], [key]), "me");
    carryObject(s, "key", "me"); // the avatar holds the key
    steerFor(s, 10, 20, 4);
    expect(s.doors.d.locked).toBe(false); // the key turned the lock
    expect(s.avatars.me.y).toBeGreaterThan(8); // and we walked through
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
