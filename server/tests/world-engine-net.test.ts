// Two-peer integration test for the world-engine net layer (the Phase-1
// "world on a call" sync, exercised headlessly). Each peer runs its own
// WorldState; collectOutbound → applyInbound stands in for the call mesh's
// data channel. Proves the thing that can't be unit-tested in isolation: that
// a ball dribbled, kicked, and re-grabbed by the OTHER peer stays consistent
// across both states without a server arbiter.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  tickWorld,
  collectOutbound,
  applyInbound,
  type WorldState,
  type Vec2,
} from "@shared/world-engine/index.js";
import { socialFieldSpec } from "@shared/world-engine/specs/social-field.js";

const DT = 1 / 60;

/** One synchronized frame: tick both peers, then exchange their broadcasts. */
function frame(a: WorldState, b: WorldState, aimA: Vec2 | null, aimB: Vec2 | null): void {
  const ea = tickWorld(a, { aim: aimA }, DT).events;
  const eb = tickWorld(b, { aim: aimB }, DT).events;
  const ma = collectOutbound(a, ea);
  const mb = collectOutbound(b, eb);
  for (const m of ma) applyInbound(b, m);
  for (const m of mb) applyInbound(a, m);
}

function frames(
  a: WorldState,
  b: WorldState,
  aimA: Vec2 | null,
  aimB: Vec2 | null,
  seconds: number,
): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) frame(a, b, aimA, aimB);
}

function framesUntil(
  a: WorldState,
  b: WorldState,
  aimA: () => Vec2 | null,
  aimB: () => Vec2 | null,
  pred: () => boolean,
  capSeconds = 12,
): void {
  const n = Math.round(capSeconds / DT);
  for (let i = 0; i < n; i++) {
    frame(a, b, aimA(), aimB());
    if (pred()) break;
  }
}

describe("world-engine net sync (two peers)", () => {
  it("propagates possession + position and hands a ball off cleanly", () => {
    // A at the west spawn (id "A"), B at the east spawn (id "B"). "A" < "B" so
    // A wins any contested grab — but this flow is uncontested by design.
    const A = createWorldState(socialFieldSpec, "A", 2);
    const B = createWorldState(socialFieldSpec, "B", 3);

    // --- A runs at the ball and takes possession; B holds still. ---
    framesUntil(
      A, B,
      () => ({ x: 52, y: 30 }),
      () => null,
      () => A.toys.ball.possessedBy === "A",
    );
    expect(A.toys.ball.possessedBy).toBe("A");

    // B learns about it over the wire, and sees the ball where A holds it.
    frames(A, B, { x: 52, y: 30 }, null, 0.2);
    expect(B.toys.ball.possessedBy).toBe("A");
    expect(Math.hypot(B.toys.ball.x - A.toys.ball.x, B.toys.ball.y - A.toys.ball.y))
      .toBeLessThan(0.5);

    // --- A kicks (hard brake) and the ball rolls free to rest. ---
    frame(A, B, null, null); // the braking frame → release
    expect(A.toys.ball.possessedBy).toBeNull();
    expect(B.toys.ball.possessedBy).toBeNull();

    frames(A, B, null, null, 4); // both coast; ball comes to rest
    expect(Math.hypot(A.toys.ball.vx, A.toys.ball.vy)).toBe(0);
    expect(A.toys.ball.freeRollOwner).toBeNull();
    expect(B.toys.ball.freeRollOwner).toBeNull();
    // The free-roll stayed in sync across the wire.
    expect(Math.abs(A.toys.ball.x - B.toys.ball.x)).toBeLessThan(0.6);

    // --- B dribbles THROUGH the resting ball and takes it; A sees the handoff.
    // (Aiming at it would "arrive" and stop on it — and stopping drops the ball;
    // possession is something you do by MOVING into it, so B aims past it.) ---
    const throughBall: Vec2 = { x: A.toys.ball.x - 8, y: A.toys.ball.y };
    framesUntil(
      A, B,
      () => null,
      () => throughBall,
      () => B.toys.ball.possessedBy === "B",
    );
    expect(B.toys.ball.possessedBy).toBe("B");

    frames(A, B, null, throughBall, 0.1);
    expect(A.toys.ball.possessedBy).toBe("B"); // the grab reached A over the wire
  });

  it("resolves a contested grab deterministically (lower id wins)", () => {
    const A = createWorldState(socialFieldSpec, "A", 0);
    const B = createWorldState(socialFieldSpec, "B", 0);

    // Both believe they grabbed the free ball on the same frame. Feed each the
    // other's claim; both must converge on "A".
    applyInbound(A, { t: "grab", id: "ball", by: "B" });
    applyInbound(B, { t: "grab", id: "ball", by: "A" });

    // A held "A" and a "B" claim must NOT override it (B is not lower).
    // (A never received its own claim; it set possession locally — emulate that.)
    A.toys.ball.possessedBy = "A";
    applyInbound(A, { t: "grab", id: "ball", by: "B" });
    expect(A.toys.ball.possessedBy).toBe("A");

    // B held "B"; an "A" claim overrides it.
    B.toys.ball.possessedBy = "B";
    applyInbound(B, { t: "grab", id: "ball", by: "A" });
    expect(B.toys.ball.possessedBy).toBe("A");
  });
});
