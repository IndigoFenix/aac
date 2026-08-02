/**
 * DOLLHOUSE SLICE 4 — the conversation-follow camera (construction phase 5,
 * step 5), as far as a headless test can reach it.
 *
 * `updateCamera` itself is GL: it writes a THREE camera and rotates avatar
 * groups, and there is no honest way to assert that without a GPU. So the three
 * decisions that can actually be WRONG were pulled out as pure functions and are
 * pinned here:
 *
 *   • `conversationBounds` — framing a pair into a centre + span.
 *   • `faceCameraYawOffset` — the bounded three-quarter turn, INCLUDING the
 *     game-angle → THREE-yaw negation (the repeat bug in render3d.ts).
 *   • `easeApproach` — the ease, and that the rates chosen are the SLOW ones the
 *     user asked for after rejecting the slice-2 dolly.
 *
 * What remains GL-only: that the blended frame looks right through an orbit,
 * and that the root-group yaw offset composes with the creature rig's own yaw.
 */
import { describe, it, expect } from "@jest/globals";
import {
  conversationBounds,
  faceCameraYawOffset,
  easeApproach,
  rigYawTo,
  CONV_DOLLY_IN_RATE,
  CONV_DOLLY_OUT_RATE,
  CONV_TRACK_RATE,
  CONV_FACE_RATE,
  CONV_FACE_MAX_TURN,
  CONV_MIN_SPAN,
  CONV_PAIR_MARGIN,
} from "@shared/world-engine/render3d.js";

/** A body at a game point, facing a game angle. */
const body = (x: number, y: number, facing: number) => ({
  x,
  y,
  fx: Math.cos(facing),
  fy: Math.sin(facing),
});

/** Shortest signed difference between two angles. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The whole-building frame a small house produces — the ceiling every
 *  conversation frame is clamped under. */
const HOUSE_SPAN = 24;

describe("conversation frame — a pair into a span", () => {
  it("centres on the MIDPOINT of the two conversants", () => {
    const f = conversationBounds({ x: 10, y: 4 }, { x: 16, y: 12 }, HOUSE_SPAN);
    expect(f.cx).toBeCloseTo(13, 6);
    expect(f.cz).toBeCloseTo(8, 6);
  });

  it("spans their separation plus margin, so neither is on the frame edge", () => {
    const f = conversationBounds({ x: 0, y: 0 }, { x: 9, y: 0 }, HOUSE_SPAN);
    expect(f.span).toBeCloseTo(9 + CONV_PAIR_MARGIN, 6);
    // …and the pair genuinely fits inside it.
    expect(f.span).toBeGreaterThan(9);
  });

  it("floors at CONV_MIN_SPAN — a close pair is never a face close-up", () => {
    const f = conversationBounds({ x: 5, y: 5 }, { x: 5.4, y: 5 }, HOUSE_SPAN);
    expect(f.span).toBeCloseTo(CONV_MIN_SPAN, 6);
  });

  it("is NEVER wider than the base frame — a dolly in, never a retreat", () => {
    // Two people at opposite ends of the world would otherwise pull the camera
    // back past the house.
    const f = conversationBounds({ x: 0, y: 0 }, { x: 400, y: 0 }, HOUSE_SPAN);
    expect(f.span).toBe(HOUSE_SPAN);
  });

  it("a house smaller than the minimum span keeps its own frame", () => {
    const tiny = 6;
    const f = conversationBounds({ x: 3, y: 3 }, { x: 3, y: 3 }, tiny);
    expect(f.span).toBe(tiny);
  });

  it("one visible body (a formless spirit's partner) frames that one person", () => {
    const only = { x: 20, y: 7 };
    const f = conversationBounds(only, only, HOUSE_SPAN);
    expect(f.cx).toBeCloseTo(20, 6);
    expect(f.cz).toBeCloseTo(7, 6);
    expect(f.span).toBeCloseTo(CONV_MIN_SPAN, 6);
  });

  it("always dollies IN or holds — the span never grows past the house", () => {
    for (let sep = 0; sep <= 60; sep += 3) {
      const f = conversationBounds({ x: 0, y: 0 }, { x: sep, y: 0 }, HOUSE_SPAN);
      expect(f.span).toBeLessThanOrEqual(HOUSE_SPAN + 1e-9);
    }
  });
});

describe("face-camera — the game-angle → yaw NEGATION", () => {
  // Body at the origin facing game +x (angle 0). Camera at game (0, +10),
  // i.e. THREE (x=0, z=10) — square to its left, a pure profile.
  const profile = body(0, 0, 0);

  it("turns toward the camera by the full bound when square-on in profile", () => {
    // toCamera = +π/2, facing = 0 ⇒ the GAME turn is +CONV_FACE_MAX_TURN…
    const off = faceCameraYawOffset(profile, 0, 10);
    // …and the YAW offset is its NEGATIVE. Get this backwards and the pair turns
    // AWAY from the lens (invisible head-on, inverted at the sides).
    expect(off).toBeCloseTo(-CONV_FACE_MAX_TURN, 6);
  });

  it("the offset IS rigYawTo of the turned game angle (the negation, end to end)", () => {
    const off = faceCameraYawOffset(profile, 0, 10);
    // Composing the offset onto the rig yaw the sim facing produced must equal
    // the rig yaw of the body having actually turned by +maxTurn in GAME angle.
    expect(rigYawTo(0) + off).toBeCloseTo(rigYawTo(0 + CONV_FACE_MAX_TURN), 6);
  });

  it("the turn genuinely reduces the angle to the camera", () => {
    for (const facing of [0, 0.7, 1.9, -2.4, Math.PI]) {
      const b = body(3, 3, facing);
      const camX = 3;
      const camZ = 25; // game +y from the body
      const toCam = Math.atan2(camZ - b.y, camX - b.x);
      const off = faceCameraYawOffset(b, camX, camZ);
      const turned = facing - off; // yaw offset −turn ⇒ game turn = −off
      const before = Math.abs(wrap(toCam - facing));
      const after = Math.abs(wrap(toCam - turned));
      expect(after).toBeLessThanOrEqual(before + 1e-9);
    }
  });

  it("is BOUNDED by CONV_FACE_MAX_TURN from every angle (three-quarter, not full-front)", () => {
    for (let a = -Math.PI; a <= Math.PI; a += Math.PI / 24) {
      const off = faceCameraYawOffset(body(0, 0, a), 0, 10);
      expect(Math.abs(off)).toBeLessThanOrEqual(CONV_FACE_MAX_TURN + 1e-9);
    }
    // 30° is a three-quarter lean: a body in profile ends up well short of
    // facing the lens (60° off), so the pair never reads as posing for a photo.
    expect(CONV_FACE_MAX_TURN).toBeLessThan(Math.PI / 4);
  });

  it("a squared-up pair leans APART (exact negatives) — both toward the lens", () => {
    // A at x=−1 facing +x, B at x=+1 facing −x: they face each other.
    const a = body(-1, 0, 0);
    const b = body(1, 0, Math.PI);
    const offA = faceCameraYawOffset(a, 0, 30);
    const offB = faceCameraYawOffset(b, 0, 30);
    expect(offA).toBeCloseTo(-offB, 6);
    expect(offA).not.toBeCloseTo(0, 2); // they DID turn
  });

  it("still reads as facing each other: neither turns more than the bound", () => {
    const a = body(-1, 0, 0);
    const b = body(1, 0, Math.PI);
    const turnA = -faceCameraYawOffset(a, 0, 30);
    const turnB = -faceCameraYawOffset(b, 0, 30);
    // After turning, A's heading is still within maxTurn of pointing at B.
    const aToB = Math.atan2(b.y - a.y, b.x - a.x);
    expect(Math.abs(wrap(aToB - (0 + turnA)))).toBeLessThanOrEqual(CONV_FACE_MAX_TURN + 1e-9);
    const bToA = Math.atan2(a.y - b.y, a.x - b.x);
    expect(Math.abs(wrap(bToA - (Math.PI + turnB)))).toBeLessThanOrEqual(CONV_FACE_MAX_TURN + 1e-9);
  });

  it("does nothing when the body already faces the camera", () => {
    // Facing +y (game π/2), camera straight ahead at game (0, 10).
    expect(faceCameraYawOffset(body(0, 0, Math.PI / 2), 0, 10)).toBeCloseTo(0, 6);
  });

  it("does not FLIP when a body has its back squarely to the camera", () => {
    // The dangerous case: a clamped-difference rule strobes ±maxTurn as the
    // body drifts through exactly 180°. Here the turn fades out through it.
    const back = faceCameraYawOffset(body(0, 0, -Math.PI / 2), 0, 10);
    expect(Math.abs(back)).toBeLessThan(1e-9);
    const eps = 0.02;
    const left = faceCameraYawOffset(body(0, 0, -Math.PI / 2 + eps), 0, 10);
    const right = faceCameraYawOffset(body(0, 0, -Math.PI / 2 - eps), 0, 10);
    // Opposite signs (they lean the two different ways) but both VANISHINGLY
    // small — no 60° jump across the crossing.
    expect(Math.abs(left - right)).toBeLessThan(0.1);
  });

  it("is continuous everywhere — no step a camera could strobe on", () => {
    let prev = faceCameraYawOffset(body(0, 0, -Math.PI), 0, 10);
    for (let a = -Math.PI + 0.01; a <= Math.PI; a += 0.01) {
      const cur = faceCameraYawOffset(body(0, 0, a), 0, 10);
      expect(Math.abs(cur - prev)).toBeLessThan(CONV_FACE_MAX_TURN * 0.05);
      prev = cur;
    }
  });
});

describe("the ease", () => {
  it("approaches without overshooting, and stops at the target", () => {
    let v = 0;
    // 30 seconds at 60 fps — this dolly is slow enough that 10 s still leaves
    // half a percent on the table, which is the point of it.
    for (let i = 0; i < 1800; i++) {
      const next = easeApproach(v, 1, CONV_DOLLY_IN_RATE, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(v);
      expect(next).toBeLessThanOrEqual(1);
      v = next;
    }
    expect(v).toBeCloseTo(1, 4);
  });

  it("is frame-rate independent (60 small steps == one big step)", () => {
    let fine = 0;
    for (let i = 0; i < 60; i++) fine = easeApproach(fine, 1, CONV_DOLLY_IN_RATE, 1 / 60);
    const coarse = easeApproach(0, 1, CONV_DOLLY_IN_RATE, 1);
    expect(fine).toBeCloseTo(coarse, 6);
  });

  it("does nothing on a zero dt or a zero rate", () => {
    expect(easeApproach(0.3, 1, CONV_DOLLY_IN_RATE, 0)).toBe(0.3);
    expect(easeApproach(0.3, 1, 0, 1 / 60)).toBe(0.3);
  });

  it("the dolly is SLOW — far below the 4/s the user rejected as 'too fast'", () => {
    const OLD_REJECTED_RATE = 4;
    expect(CONV_DOLLY_IN_RATE).toBeLessThan(OLD_REJECTED_RATE / 5);
    // In the first second the old rate covered ~98% of the move; this covers
    // well under half, so the camera reads as drifting rather than lurching.
    expect(easeApproach(0, 1, OLD_REJECTED_RATE, 1)).toBeGreaterThan(0.95);
    expect(easeApproach(0, 1, CONV_DOLLY_IN_RATE, 1)).toBeLessThan(0.5);
    // …and it still gets there: mostly settled after five seconds.
    expect(easeApproach(0, 1, CONV_DOLLY_IN_RATE, 5)).toBeGreaterThan(0.9);
  });

  it("pulling back out is gentler still, and no rate is a snap", () => {
    expect(CONV_DOLLY_OUT_RATE).toBeLessThan(CONV_DOLLY_IN_RATE);
    // Every rate in the feature keeps a single frame's move imperceptible.
    for (const rate of [CONV_DOLLY_IN_RATE, CONV_DOLLY_OUT_RATE, CONV_TRACK_RATE, CONV_FACE_RATE]) {
      expect(easeApproach(0, 1, rate, 1 / 60)).toBeLessThan(0.05);
    }
  });

  it("tracking a drifting pair is no faster than the dolly itself", () => {
    // One speed for every motion the feature can produce — nothing can beat
    // against anything else.
    expect(CONV_TRACK_RATE).toBeLessThanOrEqual(CONV_DOLLY_IN_RATE);
  });
});
