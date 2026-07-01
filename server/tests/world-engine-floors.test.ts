// The floor dimension (Phase B1): a storey index on avatars, stairs that ramp it,
// and floor-scoped wall collision. Pure engine logic, no GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  structuresWalkable,
  tickWorld,
  updateAvatarFloor,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { StructureSpec, WorldSpec } from "@shared/world-engine/types.js";

function spec(structures: StructureSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 10, y: 4, facing: Math.PI / 2 }], // faces +y (into the stairs)
    objects: [],
    structures,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

// Stairs occupying y∈[8,16], ascending +y from floor 0 to floor 1.
const stair: StructureSpec = {
  kind: "stairs", id: "st", rect: { x: 8, y: 8, w: 4, h: 8 }, fromFloor: 0, toFloor: 1, axis: "+y",
};

function steerFor(state: WorldState, aimX: number, aimY: number, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) tickWorld(state, { aim: { x: aimX, y: aimY } }, 1 / 60);
}

describe("floors", () => {
  it("an avatar starts on the ground floor", () => {
    expect(createWorldState(spec([]), "me").avatars.me.floor).toBe(0);
  });
});

describe("stairs ramp the avatar's floor", () => {
  it("halfway up the footprint is a fractional floor", () => {
    const s = createWorldState(spec([stair]), "me");
    s.avatars.me.x = 10;
    s.avatars.me.y = 12; // midpoint of y∈[8,16]
    updateAvatarFloor(s, s.avatars.me);
    expect(s.avatars.me.floor).toBeCloseTo(0.5, 1);
  });

  it("walking up + off the top lands on the upper floor", () => {
    const s = createWorldState(spec([stair]), "me");
    steerFor(s, 10, 30, 6); // walk north through the stairwell and out the top
    expect(s.avatars.me.y).toBeGreaterThan(16);
    expect(s.avatars.me.floor).toBe(1); // snapped to the landing
  });
});

describe("floor-scoped wall collision", () => {
  const f1wall: StructureSpec = { kind: "wall", id: "w1", a: { x: 6, y: 20 }, b: { x: 14, y: 20 }, thickness: 1, floor: 1 };
  const anyWall: StructureSpec = { kind: "wall", id: "w0", a: { x: 6, y: 25 }, b: { x: 14, y: 25 }, thickness: 1 };

  it("a floor-1 wall blocks only avatars on floor 1", () => {
    const s = createWorldState(spec([f1wall]), "me");
    expect(structuresWalkable(s, { x: 10, y: 20 }, 0.4, 0)).toBe(true); // floor-0 avatar passes
    expect(structuresWalkable(s, { x: 10, y: 20 }, 0.4, 1)).toBe(false); // floor-1 avatar blocked
  });

  it("a floorless wall blocks on every floor", () => {
    const s = createWorldState(spec([anyWall]), "me");
    expect(structuresWalkable(s, { x: 10, y: 25 }, 0.4, 0)).toBe(false);
    expect(structuresWalkable(s, { x: 10, y: 25 }, 0.4, 1)).toBe(false);
  });
});

describe("stairs — schema", () => {
  it("accepts valid stairs", () => {
    expect(validateWorldSpec(spec([stair])).ok).toBe(true);
  });

  it("rejects stairs that connect a floor to itself", () => {
    const bad = spec([{ kind: "stairs", id: "st", rect: { x: 8, y: 8, w: 4, h: 8 }, fromFloor: 1, toFloor: 1, axis: "+y" }]);
    expect(validateWorldSpec(bad).ok).toBe(false);
  });

  it("rejects a footprint outside the manifold", () => {
    const bad = spec([{ kind: "stairs", id: "st", rect: { x: 38, y: 38, w: 10, h: 10 }, fromFloor: 0, toFloor: 1, axis: "+y" }]);
    expect(validateWorldSpec(bad).ok).toBe(false);
  });
});
