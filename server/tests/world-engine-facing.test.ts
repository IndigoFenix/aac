// Regression test for the "held item / avatar flips 180° every frame near a stop"
// bug. Root cause: braking could push velocity PAST zero (sign flip), and facing
// was snapped to that sign-flipping velocity — so a carried item (positioned at
// carrier + facing·CARRY_HOLD) jumped front↔back each frame. Fixed by clamping the
// brake to land on zero and by holding facing below FACE_SPEED_MIN. Pure sim, no GL.

import { describe, it, expect } from "@jest/globals";
import { createWorldState, tickWorld, carryObject } from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "x" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 20, y: 20, facing: 0 }],
    objects: [{ id: "cookie", x: 21, y: 20, shape: "box", radius: 0.5, interactions: ["carry"] }],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

describe("avatar facing stability near a stop", () => {
  it("braking to rest never flips facing sign (gaze off screen)", () => {
    const state = createWorldState(spec(), "me");
    const me = state.avatars["me"]!;
    me.fx = 1; me.fy = 0;
    me.vx = 0.2; me.vy = 0; // small forward velocity, prone to brake-overshoot

    let prevFx = me.fx;
    for (let i = 0; i < 12; i++) {
      tickWorld(state, { aim: null }, 1 / 60); // aim null = gaze left the surface → brake
      // Facing must never reverse relative to the previous frame.
      expect(me.fx * prevFx).toBeGreaterThanOrEqual(0);
      expect(me.fx).toBeGreaterThan(0.5); // stays pointing ~+x, never flips to −x
      prevFx = me.fx;
    }
    expect(Math.hypot(me.vx, me.vy)).toBeLessThan(0.05); // came to rest
  });

  it("an aim jittering to OPPOSITE sides of the avatar never flips facing 180°", () => {
    // Reproduces the in-game trigger: a gaze resting ON/near the avatar whose world
    // point crosses side to side each frame → `faceAim` desired-direction flips 180°.
    // The turn-rate cap must turn this into a tiny wobble, not a per-frame flip.
    const state = createWorldState(spec(), "me");
    const me = state.avatars["me"]!;
    me.fx = 1; me.fy = 0;
    let prevFx = me.fx;
    let flips = 0;
    for (let i = 0; i < 30; i++) {
      const aim = { x: me.x + (i % 2 === 0 ? 0.3 : -0.3), y: me.y }; // hops across the avatar
      tickWorld(state, { aim }, 1 / 60);
      if (me.fx * prevFx < -0.2) flips++;
      prevFx = me.fx;
    }
    expect(flips).toBe(0);
    expect(me.fx).toBeGreaterThan(0.7); // stayed pointing ~+x (tiny wobble at most)
  });

  it("a carried item does not jump sides while the carrier brakes to a stop", () => {
    const state = createWorldState(spec(), "me");
    const me = state.avatars["me"]!;
    me.fx = 1; me.fy = 0;
    me.vx = 0.2; me.vy = 0;
    expect(carryObject(state, "cookie", "me")).toBe(true);

    let prevX = state.objects["cookie"]!.x;
    for (let i = 0; i < 12; i++) {
      tickWorld(state, { aim: null }, 1 / 60);
      const obj = state.objects["cookie"]!;
      // The held item stays IN FRONT (+x side of the carrier), never snapping ~2·HOLD
      // to the far side (which a 180° facing flip would cause).
      expect(obj.x).toBeGreaterThan(me.x); // always ahead along +x facing
      expect(Math.abs(obj.x - prevX)).toBeLessThan(0.6); // no front↔back jump
      prevX = obj.x;
    }
  });
});
