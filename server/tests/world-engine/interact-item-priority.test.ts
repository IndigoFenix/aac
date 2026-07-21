// pickEntity: an ITEM co-located with a creature wins (so a gaze dwelling where an
// item sits on a creature's tile engages the item), and the carried item is never
// itself a target. Pure world math — headless.

import { describe, it, expect } from "@jest/globals";
import { createWorldState, applyRemoteAvatar, carryObject } from "@shared/world-engine/engine.js";
import { pickEntity } from "@shared/world-engine/interact.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "x" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 2, y: 2, facing: 0 }],
    objects: [{ id: "cookie", x: 20, y: 20, shape: "box", radius: 0.5, interactions: ["carry"] }],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

describe("pickEntity item priority", () => {
  it("prefers a co-located item over a creature at the same spot", () => {
    const state = createWorldState(spec(), "me");
    applyRemoteAvatar(state, { id: "bear", x: 20, y: 20, fx: 0, fy: 1, vx: 0, vy: 0 });
    const hit = pickEntity({ x: 20, y: 20 }, state, "me");
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("object");
    expect(hit!.id).toBe("cookie");
  });

  it("still picks the creature when no item is in range", () => {
    const state = createWorldState(spec(), "me");
    applyRemoteAvatar(state, { id: "bear", x: 5, y: 5, fx: 0, fy: 1, vx: 0, vy: 0 });
    const hit = pickEntity({ x: 5, y: 5 }, state, "me");
    expect(hit?.kind).toBe("avatar");
    expect(hit?.id).toBe("bear");
  });

  it("never targets the item the local player is carrying", () => {
    const state = createWorldState(spec(), "me");
    carryObject(state, "cookie", "me");
    state.objects["cookie"]!.x = 20;
    state.objects["cookie"]!.y = 20;
    // The gaze rests exactly where the carried cookie is → it must NOT be picked.
    const hit = pickEntity({ x: 20, y: 20 }, state, "me");
    expect(hit).toBeNull();
  });
});
