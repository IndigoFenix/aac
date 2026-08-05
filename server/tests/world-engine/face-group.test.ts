/**
 * MULTI-ENTITY CONVERSATIONS ⑨ (presentation) — GROUP FACING.
 *
 * `faceGroup(members, speaker, addressee?)` is the n-way stance: listeners look
 * at the speaker, the speaker looks at whoever it is addressing, or at the
 * centroid of the others when it speaks to the floor. THE ADDRESSEE CUE IS THE
 * FACING (§3f/§2.3: a reply says "you" and the speaker visibly turns), so who a
 * body ends up pointing at is not decoration — it is the only thing that
 * disambiguates "you" in a group.
 *
 * Facing is a UNIT VECTOR in GAME space; the renderer owns the game-angle→yaw
 * mirror, so nothing here converts to yaw (same contract as
 * creature-conversation-facing, which pins the pair and stays untouched).
 * Pure + deterministic.
 */
import { describe, it, expect } from "@jest/globals";
import {
  faceEachOther,
  faceGroup,
  type AvatarState,
} from "@shared/world-engine/engine.js";

function makeAvatar(id: string, x: number, y: number): AvatarState {
  return { id, x, y, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 };
}

/** The heading a body looks along, as a game angle — computed independently of
 *  the code under test. */
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

/** Assert `a` looks straight at `t`. */
function expectFacing(a: AvatarState, t: { x: number; y: number }): void {
  expect(angDiff(facingAngle(a), bearing(a, t))).toBeLessThan(1e-6);
  expect(Math.hypot(a.fx, a.fy)).toBeCloseTo(1, 6);
}

describe("faceGroup — listeners", () => {
  it("every listener turns to the SPEAKER, wherever they stand", () => {
    const s = makeAvatar("s", 0, 0);
    const l1 = makeAvatar("l1", 5, 0);
    const l2 = makeAvatar("l2", -2, 6);
    const l3 = makeAvatar("l3", -4, -3);
    faceGroup([s, l1, l2, l3], s);
    expectFacing(l1, s);
    expectFacing(l2, s);
    expectFacing(l3, s);
  });

  it("a listener standing ON the speaker keeps its heading (no defined direction)", () => {
    const s = makeAvatar("s", 3, 3);
    const stacked = makeAvatar("stacked", 3, 3);
    stacked.fx = 0;
    stacked.fy = 1;
    faceGroup([s, stacked], s);
    expect(stacked.fx).toBe(0);
    expect(stacked.fy).toBe(1);
  });

  it("the speaker is not counted as its own listener (identity by id, too)", () => {
    const s = makeAvatar("s", 0, 0);
    const other = makeAvatar("other", 4, 0);
    // A roster that names the speaker through a DIFFERENT object with the same
    // id (a projected copy) must still not be turned round to face itself.
    const alias = makeAvatar("s", 0, 0);
    alias.fx = 0;
    alias.fy = 1;
    faceGroup([alias, other], s);
    expect(alias.fx).toBe(0);
    expect(alias.fy).toBe(1);
    expectFacing(other, s);
  });
});

describe("faceGroup — the speaker", () => {
  it("faces its ADDRESSEE when it has one (the 'you' cue)", () => {
    const s = makeAvatar("s", 0, 0);
    const you = makeAvatar("you", 2, 9);
    const third = makeAvatar("third", -7, 1);
    faceGroup([s, you, third], s, you);
    expectFacing(s, you);
    // …and both of the others still watch the speaker, addressed or not.
    expectFacing(you, s);
    expectFacing(third, s);
  });

  it("addressing ONE of three is visibly different from addressing the other", () => {
    const mk = () => [makeAvatar("s", 0, 0), makeAvatar("a", 6, 1), makeAvatar("b", -1, 7)];
    const [s1, a1, b1] = mk();
    faceGroup([s1, a1, b1], s1, a1);
    const [s2, a2, b2] = mk();
    faceGroup([s2, a2, b2], s2, b2);
    expect(angDiff(facingAngle(s1), facingAngle(s2))).toBeGreaterThan(0.5);
  });

  it("faces the CENTROID of the others when broadcasting to the floor", () => {
    const s = makeAvatar("s", 0, 0);
    const a = makeAvatar("a", 10, 0);
    const b = makeAvatar("b", 10, 6);
    faceGroup([s, a, b], s);
    expectFacing(s, { x: 10, y: 3 });
    // Not at any ONE of them: the broadcast heading splits the difference.
    expect(angDiff(facingAngle(s), bearing(s, a))).toBeGreaterThan(1e-3);
    expect(angDiff(facingAngle(s), bearing(s, b))).toBeGreaterThan(1e-3);
  });

  it("an addressee OUTSIDE the roster is still faced (addressing across the room)", () => {
    const s = makeAvatar("s", 0, 0);
    const inRoom = makeAvatar("inRoom", 5, 0);
    const outsider = makeAvatar("outsider", -3, -9);
    faceGroup([s, inRoom], s, outsider);
    expectFacing(s, outsider);
    expectFacing(inRoom, s);
  });

  it("keeps its heading when it is alone, or addresses itself", () => {
    const s = makeAvatar("s", 1, 1);
    s.fx = 0;
    s.fy = -1;
    faceGroup([s], s);
    expect(s.fx).toBe(0);
    expect(s.fy).toBe(-1);
    faceGroup([s], s, s);
    expect(s.fx).toBe(0);
    expect(s.fy).toBe(-1);
    faceGroup([], s);
    expect(s.fx).toBe(0);
    expect(s.fy).toBe(-1);
  });
});

describe("faceGroup — contract", () => {
  it("n = 2 IS faceEachOther (broadcast and addressed alike)", () => {
    // A diagonal pair, where a mishandled sign would show up.
    const pairA = makeAvatar("a", 1, 2);
    const pairB = makeAvatar("b", 6, 9);
    faceEachOther(pairA, pairB);

    const groupA = makeAvatar("a", 1, 2);
    const groupB = makeAvatar("b", 6, 9);
    faceGroup([groupA, groupB], groupA); // broadcast: the centroid IS the other one
    expect(groupA.fx).toBeCloseTo(pairA.fx, 12);
    expect(groupA.fy).toBeCloseTo(pairA.fy, 12);
    expect(groupB.fx).toBeCloseTo(pairB.fx, 12);
    expect(groupB.fy).toBeCloseTo(pairB.fy, 12);

    const addrA = makeAvatar("a", 1, 2);
    const addrB = makeAvatar("b", 6, 9);
    faceGroup([addrA, addrB], addrA, addrB); // addressed: the same stance
    expect(addrA.fx).toBeCloseTo(pairA.fx, 12);
    expect(addrA.fy).toBeCloseTo(pairA.fy, 12);
    expect(addrB.fx).toBeCloseTo(pairB.fx, 12);
    expect(addrB.fy).toBeCloseTo(pairB.fy, 12);
  });

  it("is IDEMPOTENT — reasserting it every tick changes nothing", () => {
    const s = makeAvatar("s", 0, 0);
    const a = makeAvatar("a", 4, 1);
    const b = makeAvatar("b", -2, 5);
    faceGroup([s, a, b], s, a);
    const snap = [s, a, b].map((m) => [m.fx, m.fy]);
    for (let i = 0; i < 5; i++) faceGroup([s, a, b], s, a);
    expect([s, a, b].map((m) => [m.fx, m.fy])).toEqual(snap);
  });

  it("is ORDER-INDEPENDENT — facing never moves a body", () => {
    const build = () => ({
      s: makeAvatar("s", 0, 0),
      a: makeAvatar("a", 4, 1),
      b: makeAvatar("b", -2, 5),
    });
    const one = build();
    faceGroup([one.s, one.a, one.b], one.s);
    const two = build();
    faceGroup([two.b, two.a, two.s], two.s);
    expect([two.s.fx, two.s.fy, two.a.fx, two.a.fy, two.b.fx, two.b.fy]).toEqual([
      one.s.fx, one.s.fy, one.a.fx, one.a.fy, one.b.fx, one.b.fy,
    ]);
  });

  it("moves NOTHING — it is a facing-only operation", () => {
    const s = makeAvatar("s", 0, 0);
    const a = makeAvatar("a", 4, 1);
    faceGroup([s, a], s);
    expect([s.x, s.y, s.vx, s.vy]).toEqual([0, 0, 0, 0]);
    expect([a.x, a.y, a.vx, a.vy]).toEqual([4, 1, 0, 0]);
  });

  it("a ring all faces inward — nobody is left looking out of the circle", () => {
    const n = 5;
    const r = 2;
    const ring = Array.from({ length: n }, (_, i) =>
      makeAvatar(`m${i}`, 10 + r * Math.cos((2 * Math.PI * i) / n), 10 + r * Math.sin((2 * Math.PI * i) / n)),
    );
    const speaker = ring[0];
    faceGroup(ring, speaker);
    const centre = { x: 10, y: 10 };
    for (const m of ring) {
      // Each heading has a positive component toward the circle's centre.
      const toCentre = { x: centre.x - m.x, y: centre.y - m.y };
      expect(m.fx * toCentre.x + m.fy * toCentre.y).toBeGreaterThan(0);
    }
  });
});
