// FIXTURES (furniture): static, solid containers — a chest you cannot
// walk through, a lid that eases open when you stand beside it, and
// streamed add/remove so an unloaded house abstracts its furniture away.
// Pure engine logic, no GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  addWorldObject,
  createWorldState,
  removeWorldObject,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { validateWorldSpec } from "@shared/world-engine/schema.js";
import type { ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const chest: ObjectSpec = {
  id: "chest",
  x: 20,
  y: 16,
  shape: "box",
  radius: 0.55,
  fixture: "chest",
  openable: true,
  facing: Math.PI,
  interactions: [],
  contains: [{ relation: "in", capacity: 2 }],
};

function spec(objects: ObjectSpec[] = []): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 32 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 10, y: 16 }],
    objects,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

function steerFor(state: WorldState, aimX: number, aimY: number, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) tickWorld(state, { aim: { x: aimX, y: aimY } }, 1 / 60);
}

describe("fixtures", () => {
  it("schema: a fixture container passes; a pushable fixture is a contradiction", () => {
    expect(validateWorldSpec(spec([chest])).ok).toBe(true);
    const bad = validateWorldSpec(spec([{ ...chest, interactions: ["push"], push: { impulse: 1 } as never }]));
    expect(bad.ok).toBe(false);
  });

  it("is SOLID: walking straight at a chest stops at its face", () => {
    const s = createWorldState(spec([chest]), "me");
    steerFor(s, 20, 16, 4); // aim dead-center at the chest
    const me = s.avatars.me;
    // Blocked at half-extent + avatar radius, never inside the footprint.
    expect(Math.abs(me.x - 20)).toBeGreaterThanOrEqual(0.55);
    expect(me.x).toBeLessThan(20); // approached from the west, stayed west
  });

  it("opens beside you, closes behind you — the door rule on furniture", () => {
    const s = createWorldState(spec([chest]), "me");
    steerFor(s, 20, 16, 3); // walk up and stand at the chest
    expect(s.objects.chest.open).toBeGreaterThan(0.6);
    steerFor(s, 10, 16, 3); // walk away
    expect(s.objects.chest.open).toBeLessThan(0.3);
  });

  it("streams: addWorldObject collides immediately; removal frees contents", () => {
    const s = createWorldState(spec([]), "me");
    expect(addWorldObject(s, chest)).toBe(true);
    expect(addWorldObject(s, chest)).toBe(false); // id exists
    steerFor(s, 20, 16, 4);
    expect(Math.abs(s.avatars.me.x - 20)).toBeGreaterThanOrEqual(0.55);

    // Something placed IN the chest survives the chest's despawn, freed
    // where it stood (nothing vanishes inside a despawning cupboard).
    addWorldObject(s, {
      id: "loaf", x: 20, y: 16, shape: "sphere", radius: 0.2, interactions: ["carry"],
    });
    s.objects.loaf.containedIn = { objectId: "chest", relation: "in" };
    expect(removeWorldObject(s, "chest")).toBe(true);
    expect(s.objects.chest).toBeUndefined();
    expect(s.objects.loaf.containedIn).toBeNull();
    expect(s.spec.objects.map(o => o.id)).toEqual(["loaf"]);

    // The wall is gone with the chest: walking THROUGH its old spot works.
    steerFor(s, 30, 16, 5);
    expect(s.avatars.me.x).toBeGreaterThan(21);
  });
});
