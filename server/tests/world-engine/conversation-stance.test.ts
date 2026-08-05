/**
 * CONVERSATION IN MOTION ⑫① — THE LEGS OWN THE HEADING.
 *
 * A conversation borrows a heading that is otherwise free, and never takes one.
 * `advanceAvatar` re-aims a moving body's facing from its VELOCITY every frame,
 * and the renderer takes yaw from `fx`/`fy` while taking the walk cycle from
 * `|v|` — with no strafe gait anywhere — so a facing forced against the velocity
 * is not a stance, it is a MOONWALK. `headingHeldByLegs` is the predicate, and
 * `faceGroup` enforces it INTRINSICALLY so no call site can forget.
 *
 * The threshold is `advanceAvatar`'s own `FACE_SPEED_MIN`: the two rules are
 * complementary by construction, so there is no speed band in which both the
 * legs and the circle believe they own the heading.
 *
 * Pure + deterministic. `face-group.test.ts` pins the stance itself and stays
 * untouched — every body it builds is idle (`vx: 0, vy: 0`), which is exactly
 * the case this law leaves alone.
 */
import { describe, it, expect } from "@jest/globals";
import {
  FACE_SPEED_MIN,
  faceGroup,
  headingHeldByLegs,
  type AvatarState,
} from "@shared/world-engine/engine.js";
import { socialYawOffset, faceCameraYawOffset, CONV_FACE_MAX_TURN } from "@shared/world-engine/render3d.js";

function makeAvatar(id: string, x: number, y: number, v?: { vx: number; vy: number }): AvatarState {
  return { id, x, y, fx: 1, fy: 0, vx: v?.vx ?? 0, vy: v?.vy ?? 0, floor: 0 };
}

const angle = (a: AvatarState): number => Math.atan2(a.fy, a.fx);
const bearing = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.atan2(b.y - a.y, b.x - a.x);
const angDiff = (x: number, y: number): number => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));

describe("headingHeldByLegs — the predicate", () => {
  it("an idle body's heading is FREE", () => {
    expect(headingHeldByLegs(makeAvatar("a", 0, 0))).toBe(false);
  });

  it("a walking body's heading is HELD", () => {
    expect(headingHeldByLegs(makeAvatar("a", 0, 0, { vx: 1.6, vy: 0 }))).toBe(true);
  });

  it("the threshold is exactly advanceAvatar's own FACE_SPEED_MIN", () => {
    // Below and at the bar the facing is held by nobody (locomotion ignores it
    // too, which is the whole point of sharing the constant); above it, the legs
    // have taken it. A strict `>` on both sides would leave a band where both
    // systems think they own the heading.
    const under = makeAvatar("a", 0, 0, { vx: FACE_SPEED_MIN - 1e-6, vy: 0 });
    const at = makeAvatar("b", 0, 0, { vx: FACE_SPEED_MIN, vy: 0 });
    const over = makeAvatar("c", 0, 0, { vx: FACE_SPEED_MIN + 1e-6, vy: 0 });
    expect(headingHeldByLegs(under)).toBe(false);
    expect(headingHeldByLegs(at)).toBe(false);
    expect(headingHeldByLegs(over)).toBe(true);
  });

  it("reads the SPEED, not one axis — a body walking on the diagonal is held", () => {
    const d = FACE_SPEED_MIN; // each axis alone is under the bar; the hypot is over it
    expect(headingHeldByLegs(makeAvatar("a", 0, 0, { vx: d, vy: d }))).toBe(true);
  });
});

describe("faceGroup honors the law intrinsically", () => {
  it("a WALKING listener keeps its own heading", () => {
    const speaker = makeAvatar("s", 0, 0);
    const walker = makeAvatar("w", 3, 0, { vx: 0, vy: 1.4 });
    const before = angle(walker);
    faceGroup([speaker, walker], speaker);
    expect(angle(walker)).toBeCloseTo(before, 12);
  });

  it("an IDLE listener beside a walking one still turns — the circle is not disabled", () => {
    const speaker = makeAvatar("s", 0, 0);
    const walker = makeAvatar("w", 3, 0, { vx: 0, vy: 1.4 });
    const idle = makeAvatar("i", 0, 3);
    faceGroup([speaker, walker, idle], speaker);
    expect(angDiff(angle(idle), bearing(idle, speaker))).toBeLessThan(1e-6);
  });

  it("a walking listener still COUNTS as present in the broadcast centroid", () => {
    // It is in the conversation; it just isn't turning for it. Dropping it from
    // the centroid would make the speaker address a room it can't see.
    const speaker = makeAvatar("s", 0, 0);
    const walker = makeAvatar("w", 4, 0, { vx: 1.4, vy: 0 });
    const idle = makeAvatar("i", 0, 4);
    faceGroup([speaker, walker, idle], speaker);
    // Centroid of (4,0) and (0,4) is (2,2) — 45°. Had the walker been dropped,
    // the speaker would look straight up at the idle one (90°).
    expect(angDiff(angle(speaker), Math.PI / 4)).toBeLessThan(1e-6);
  });

  it("a WALKING speaker keeps its heading, and its listeners still turn to it", () => {
    const speaker = makeAvatar("s", 0, 0, { vx: 1.6, vy: 0 });
    const a = makeAvatar("a", 0, 3);
    const b = makeAvatar("b", 0, -3);
    const before = angle(speaker);
    faceGroup([speaker, a, b], speaker);
    expect(angle(speaker)).toBeCloseTo(before, 12);
    expect(angDiff(angle(a), bearing(a, speaker))).toBeLessThan(1e-6);
    expect(angDiff(angle(b), bearing(b, speaker))).toBeLessThan(1e-6);
  });

  it("a walking speaker does not turn even toward an explicit addressee", () => {
    const speaker = makeAvatar("s", 0, 0, { vx: 0, vy: -1.6 });
    const addressee = makeAvatar("t", 5, 5);
    const before = angle(speaker);
    faceGroup([speaker, addressee], speaker, addressee);
    expect(angle(speaker)).toBeCloseTo(before, 12);
  });

  it("IDLE bodies are byte-identical to the pre-law behaviour", () => {
    // The acceptance bar: everything face-group.test.ts pins must be untouched,
    // and every body it builds is idle.
    const speaker = makeAvatar("s", 1, 2);
    const a = makeAvatar("a", 4, 2);
    const b = makeAvatar("b", 1, 6);
    faceGroup([speaker, a, b], speaker, a);
    expect(angDiff(angle(a), bearing(a, speaker))).toBeLessThan(1e-6);
    expect(angDiff(angle(b), bearing(b, speaker))).toBeLessThan(1e-6);
    expect(angDiff(angle(speaker), bearing(speaker, a))).toBeLessThan(1e-6);
  });

  it("stays idempotent and order-independent with movers in the roster", () => {
    const mk = () => {
      const s = makeAvatar("s", 0, 0);
      const w = makeAvatar("w", 3, 1, { vx: 1.2, vy: 0 });
      const i = makeAvatar("i", -2, 2);
      return { s, w, i };
    };
    const once = mk();
    faceGroup([once.s, once.w, once.i], once.s);
    const twice = mk();
    faceGroup([twice.s, twice.w, twice.i], twice.s);
    faceGroup([twice.i, twice.w, twice.s], twice.s); // re-run, reordered
    expect(angle(twice.i)).toBeCloseTo(angle(once.i), 12);
    expect(angle(twice.w)).toBeCloseTo(angle(once.w), 12);
    expect(angle(twice.s)).toBeCloseTo(angle(once.s), 12);
  });

  it("never moves a body — facing only", () => {
    const speaker = makeAvatar("s", 0, 0);
    const walker = makeAvatar("w", 3, 0, { vx: 1.4, vy: 0.2 });
    faceGroup([speaker, walker], speaker);
    expect(walker.x).toBe(3);
    expect(walker.y).toBe(0);
    expect(walker.vx).toBe(1.4);
    expect(walker.vy).toBe(0.2);
  });
});

describe("socialYawOffset — the courtesy turn shares ONE budget", () => {
  const body = { x: 0, y: 0, fx: 1, fy: 0 };

  it("with no one to look at it IS faceCameraYawOffset", () => {
    for (const [cx, cz] of [[5, 5], [-3, 2], [0, -7], [4, 0]] as const) {
      expect(socialYawOffset(body, null, cx, cz)).toBeCloseTo(faceCameraYawOffset(body, cx, cz), 12);
    }
  });

  it("social + camera NEVER exceeds the budget, at any bearing", () => {
    // The stacking failure this composition exists to prevent: two independent
    // ±30° leans summing into a 60° twist.
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const look = { x: Math.cos(a) * 6, y: Math.sin(a) * 6 };
      for (let j = 0; j < 24; j++) {
        const c = (j / 24) * Math.PI * 2;
        const off = socialYawOffset(body, look, Math.cos(c) * 9, Math.sin(c) * 9);
        expect(Math.abs(off)).toBeLessThanOrEqual(CONV_FACE_MAX_TURN + 1e-9);
      }
    }
  });

  it("a body already facing the speaker spends nothing, and keeps the full camera lean", () => {
    const look = { x: 10, y: 0 }; // dead ahead of a body facing +x
    expect(socialYawOffset(body, look, 0, 9)).toBeCloseTo(faceCameraYawOffset(body, 0, 9), 12);
  });

  it("a body that must turn the full budget toward the speaker gets NO camera lean", () => {
    const look = { x: 0, y: 10 }; // 90° off: the social turn saturates at maxTurn
    const off = socialYawOffset(body, look, -9, 0);
    expect(Math.abs(off)).toBeCloseTo(CONV_FACE_MAX_TURN, 9);
  });

  it("leans toward the speaker, in the right direction (THE NEGATION holds)", () => {
    // A speaker to the body's LEFT in game space (+y) is a positive game-angle
    // turn, which is a NEGATIVE yaw delta.
    const left = socialYawOffset(body, { x: 0, y: 10 }, 0, 0);
    const right = socialYawOffset(body, { x: 0, y: -10 }, 0, 0);
    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(0);
    expect(left).toBeCloseTo(-right, 12);
  });

  it("a speaker sitting on top of the body contributes no turn", () => {
    expect(socialYawOffset(body, { x: 0, y: 0 }, 5, 5)).toBeCloseTo(faceCameraYawOffset(body, 5, 5), 12);
  });
});
