// CONVERSATION FACING — two idle creatures talking turn to face one another.
// Facing is stored as a UNIT VECTOR (fx, fy) in GAME space (the sim's native
// heading); the renderer owns the game-angle → three.js-yaw mirror. The fix is
// in the sim (facing state) via faceToward / faceEachOther — no hand-rolled
// atan2. Pure + deterministic.

import { describe, it, expect } from "@jest/globals";
import { faceEachOther, faceToward, type AvatarState } from "@shared/world-engine/engine.js";

function makeAvatar(id: string, x: number, y: number): AvatarState {
  return { id, x, y, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 };
}

/** The heading a body would look at, as a game angle (atan2 over fx/fy) — for
 *  asserting the facing POINTS at a target, computed independently of the code
 *  under test. */
function facingAngle(a: AvatarState): number {
  return Math.atan2(a.fy, a.fx);
}

/** The direction from `a` to `b` as a game angle. */
function bearing(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function angDiff(x: number, y: number): number {
  return Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
}

describe("faceToward", () => {
  it("points a body's facing vector straight at a target", () => {
    const a = makeAvatar("a", 0, 0);
    faceToward(a, { x: 3, y: 4 });
    // Unit vector toward (3,4): (0.6, 0.8).
    expect(a.fx).toBeCloseTo(0.6, 6);
    expect(a.fy).toBeCloseTo(0.8, 6);
    expect(Math.hypot(a.fx, a.fy)).toBeCloseTo(1, 6);
    expect(angDiff(facingAngle(a), bearing(a, { x: 3, y: 4 }))).toBeLessThan(1e-6);
  });

  it("is a no-op when the target is on top of the body (no defined heading)", () => {
    const a = makeAvatar("a", 5, 5);
    a.fx = 0;
    a.fy = 1;
    faceToward(a, { x: 5, y: 5 });
    expect(a.fx).toBe(0); // heading left as it was
    expect(a.fy).toBe(1);
  });
});

describe("faceEachOther — conversing creatures square up", () => {
  it("both participants' facing angles point at each other", () => {
    // A diagonal pair, so a mishandled game-angle → yaw sign would show up (the
    // ±π/2 fixture-mirror bug lives exactly at diagonals).
    const a = makeAvatar("a", 1, 2);
    const b = makeAvatar("b", 6, 9);
    faceEachOther(a, b);

    // Each faces the other: its heading angle equals the bearing to the other.
    expect(angDiff(facingAngle(a), bearing(a, b))).toBeLessThan(1e-6);
    expect(angDiff(facingAngle(b), bearing(b, a))).toBeLessThan(1e-6);

    // …which means they look in OPPOSITE directions along the line between them.
    expect(angDiff(facingAngle(a), facingAngle(b))).toBeCloseTo(Math.PI, 6);

    // And each facing vector projects positively onto the line toward the other
    // (dot of heading with the unit direction to the partner ≈ 1).
    const dab = { x: b.x - a.x, y: b.y - a.y };
    const nab = Math.hypot(dab.x, dab.y);
    expect((a.fx * dab.x + a.fy * dab.y) / nab).toBeCloseTo(1, 6);
    expect((b.fx * -dab.x + b.fy * -dab.y) / nab).toBeCloseTo(1, 6);
  });

  it("works for an axis-aligned pair too (facing survives at 0/π where a sign bug hides)", () => {
    const a = makeAvatar("a", 0, 0);
    const b = makeAvatar("b", 4, 0);
    faceEachOther(a, b);
    expect(a.fx).toBeCloseTo(1, 6); // a looks +x toward b
    expect(a.fy).toBeCloseTo(0, 6);
    expect(b.fx).toBeCloseTo(-1, 6); // b looks −x toward a
    expect(b.fy).toBeCloseTo(0, 6);
  });
});
