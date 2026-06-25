// Headless tests for the INTERACT intent (P3): turning a gaze ground-point into a
// picked entity + the type-aware engaging aim. Pure world math — no GPU/DOM.

import { describe, it, expect } from "@jest/globals";
import { createWorldState, applyRemoteAvatar } from "@shared/world-engine/engine.js";
import { socialFieldSpec } from "@shared/world-engine/specs/index.js";
import { pickEntity, approachAim } from "@shared/world-engine/interact.js";
import { DEFAULT_INTERACT_TUNABLES } from "@shared/world-engine/world-tunables.js";

function stateWithBobAt(x: number, y: number) {
  const state = createWorldState(socialFieldSpec, "me", 0);
  applyRemoteAvatar(state, { id: "bob", x, y, fx: 1, fy: 0, vx: 0, vy: 0 });
  return state;
}

describe("interact — pickEntity", () => {
  it("picks a toy when the gaze rests on it, nothing when far", () => {
    const state = createWorldState(socialFieldSpec, "me", 0);
    const ball = Object.values(state.toys)[0];
    expect(ball).toBeDefined();

    const onBall = pickEntity({ x: ball.x, y: ball.y }, state, "me");
    expect(onBall).not.toBeNull();
    expect(onBall!.kind).toBe("toy");
    expect(onBall!.id).toBe(ball.id);

    const far = pickEntity({ x: ball.x + 6, y: ball.y + 6 }, state, "me");
    expect(far).toBeNull();
  });

  it("picks a peer avatar, never the local player", () => {
    const state = stateWithBobAt(10, 10);
    const onBob = pickEntity({ x: 10, y: 10 }, state, "me");
    expect(onBob).not.toBeNull();
    expect(onBob!.kind).toBe("avatar");
    expect(onBob!.id).toBe("bob");

    // Resting on the LOCAL avatar's own position must not pick anyone (that's the
    // WATCH/sit path, not interact).
    const me = state.avatars["me"];
    const onSelf = pickEntity({ x: me.x, y: me.y }, state, "me");
    expect(onSelf?.id).not.toBe("me");
  });
});

describe("interact — approachAim", () => {
  it("aims AT a toy (walk in to dribble)", () => {
    const aim = approachAim({ x: 0, y: 0 }, { x: 5, y: 2 }, "toy");
    expect(aim).toEqual({ x: 5, y: 2 });
  });

  it("stops a person's stop-distance short and on the approach line", () => {
    const aim = approachAim({ x: 0, y: 0 }, { x: 10, y: 0 }, "avatar", DEFAULT_INTERACT_TUNABLES);
    expect(aim.x).toBeCloseTo(10 - DEFAULT_INTERACT_TUNABLES.npcStopDistance, 5); // 8
    expect(aim.y).toBeCloseTo(0, 5);
  });

  it("holds position (a hair toward them) when already in conversation range", () => {
    const aim = approachAim({ x: 0, y: 0 }, { x: 1, y: 0 }, "avatar", DEFAULT_INTERACT_TUNABLES);
    // d (1) < npcStopDistance (2): aim is essentially the avatar, nudged toward them.
    expect(aim.x).toBeGreaterThan(0);
    expect(aim.x).toBeLessThan(0.1);
    expect(aim.y).toBeCloseTo(0, 5);
  });
});
