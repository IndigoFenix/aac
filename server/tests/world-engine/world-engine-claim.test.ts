// THE PLAYER IS THE SPARK; THE AVATAR IS JUST A BODY.
//
// `WorldState.localId` (the spark's network identity) and `WorldState.drivenId`
// (the body it steers) used to be ONE field. That conflation silently worked
// only because a spark's default body shares its id — and it forced possession
// to DESTROY the creature and re-skin the player walker, then resurrect it on
// dismiss with a hardcoded generic `wander`. A baker came back a generic
// wanderer: its mind survived, its job did not.
//
// These tests pin the split: claiming steers the creature's OWN body, leaves the
// creature in the world, and releases cleanly.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  addLocalAvatar,
  applyRemoteAvatar,
  removeAvatar,
  setDrivenBody,
  isLocallyDriven,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/index.js";
import { socialFieldSpec } from "@shared/world-engine/specs/social-field.js";

const DT = 1 / 60;
const BOB = "npc_bob";

/** A world with the spark ("me") and one creature body standing at (40, 30). */
function world(): WorldState {
  const s = createWorldState(socialFieldSpec, "me", 2);
  addLocalAvatar(s, BOB, 40, 30, 0);
  return s;
}

/** Drive `state` toward `aim` for `seconds`. */
function run(s: WorldState, aim: { x: number; y: number } | null, seconds = 1): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) tickWorld(s, { aim }, DT);
}

describe("claiming a body — the spark/body split", () => {
  it("a fresh spark drives its own body", () => {
    const s = world();
    expect(s.drivenId).toBe("me");
    expect(s.localId).toBe("me");
  });

  it("CLAIMING DOES NOT DESTROY THE CREATURE — its body stays in the world", () => {
    const s = world();
    expect(setDrivenBody(s, BOB)).toBe(true);
    // The headline: the creature is still here. The old possession removed it.
    expect(s.avatars[BOB]).toBeDefined();
    // ...and so is the spark's own body. Nothing was swapped or teleported.
    expect(s.avatars.me).toBeDefined();
  });

  it("steers the CLAIMED body and leaves the spark's own body parked", () => {
    const s = world();
    const myStart = { x: s.avatars.me!.x, y: s.avatars.me!.y };
    setDrivenBody(s, BOB);
    run(s, { x: 40, y: 44 }, 1.5);

    // Bob walked toward the aim...
    expect(s.avatars[BOB]!.y).toBeGreaterThan(31);
    // ...and the spark's own body never budged.
    expect(s.avatars.me!.x).toBeCloseTo(myStart.x, 6);
    expect(s.avatars.me!.y).toBeCloseTo(myStart.y, 6);
  });

  it("releases back to the spark's own body, leaving the creature where it stood", () => {
    const s = world();
    setDrivenBody(s, BOB);
    run(s, { x: 40, y: 44 }, 1.5);
    const bobAt = { x: s.avatars[BOB]!.x, y: s.avatars[BOB]!.y };

    expect(setDrivenBody(s, null)).toBe(true);
    expect(s.drivenId).toBe("me");
    // The creature stands exactly where the spark left it — not removed, not moved.
    expect(s.avatars[BOB]!.x).toBeCloseTo(bobAt.x, 6);
    expect(s.avatars[BOB]!.y).toBeCloseTo(bobAt.y, 6);

    // The gaze now moves the spark's own body again, not Bob's.
    run(s, { x: 28, y: 30 }, 1);
    expect(Math.hypot(s.avatars[BOB]!.x - bobAt.x, s.avatars[BOB]!.y - bobAt.y)).toBeLessThan(0.2);
  });

  it("refuses to claim a body that isn't in the world", () => {
    const s = world();
    expect(setDrivenBody(s, "npc_ghost")).toBe(false);
    expect(s.drivenId).toBe("me"); // unchanged
  });

  it("a claimed body leaving the world releases the spark instead of stranding it", () => {
    const s = world();
    setDrivenBody(s, BOB);
    removeAvatar(s, BOB); // town unload / despawn
    expect(s.drivenId).toBe("me"); // never left steering a ghost
    // And the spark is still drivable.
    run(s, { x: 28, y: 30 }, 0.5);
    expect(s.avatars.me).toBeDefined();
  });
});

describe("claiming a body — network ownership", () => {
  it("the network may not move a body we have claimed", () => {
    const s = world();
    setDrivenBody(s, BOB);
    const at = { x: s.avatars[BOB]!.x, y: s.avatars[BOB]!.y };
    // A stale peer insists Bob is elsewhere. Our sim is authoritative: we drive him.
    applyRemoteAvatar(s, { id: BOB, x: 99, y: 99, fx: 1, fy: 0, vx: 0, vy: 0 });
    expect(s.avatars[BOB]!.x).toBeCloseTo(at.x, 6);
    expect(s.avatars[BOB]!.y).toBeCloseTo(at.y, 6);
  });

  it("the network MAY move that same body once we release it", () => {
    const s = world();
    setDrivenBody(s, BOB);
    setDrivenBody(s, null);
    applyRemoteAvatar(s, { id: BOB, x: 99, y: 99, fx: 1, fy: 0, vx: 0, vy: 0 });
    // Released → an ordinary remote body again (applyRemoteAvatar seeds the
    // smoothing target; the displayed pose eases onto it).
    expect(s.avatars[BOB]!.tx ?? s.avatars[BOB]!.x).toBeCloseTo(99, 0);
  });

  it("isLocallyDriven covers the spark AND its claimed body", () => {
    const s = world();
    expect(isLocallyDriven(s, "me")).toBe(true);
    expect(isLocallyDriven(s, BOB)).toBe(false);
    setDrivenBody(s, BOB);
    // Both, now: our own body is still ours even while we wear another.
    expect(isLocallyDriven(s, "me")).toBe(true);
    expect(isLocallyDriven(s, BOB)).toBe(true);
  });
});
