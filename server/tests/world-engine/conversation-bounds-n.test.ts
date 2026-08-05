/**
 * MULTI-ENTITY CONVERSATIONS ⑨ (presentation) — the N-ARY conversation frame.
 *
 * `conversationBounds` (the pair form) is pinned by dollhouse-conversation-camera
 * and stays untouched; this suite pins the generalization underneath it:
 *
 *   • a group of 3 / 5 is framed by the BOUNDING BOX of everyone visible,
 *   • the one-visible-body degeneracy (a formless spirit's partner) still works,
 *   • the span is still floored at CONV_MIN_SPAN and CAPPED at the base frame —
 *     a dolly IN, never a retreat, whatever the group does,
 *   • and the 2-arg wrapper is EXACTLY the 2-point call, so nothing that held a
 *     pair changed by a float.
 *
 * Pure maths, no GL: what a blended frame looks like through an orbit is still
 * GL-only, as it was for the pair.
 */
import { describe, it, expect } from "@jest/globals";
import {
  conversationBounds,
  conversationBoundsN,
  CONV_MIN_SPAN,
  CONV_PAIR_MARGIN,
} from "@shared/world-engine/render3d.js";

/** The whole-building frame a small house produces — the ceiling every
 *  conversation frame is clamped under. */
const HOUSE_SPAN = 24;

const p = (x: number, y: number) => ({ x, y });

describe("conversationBoundsN — a group into a frame", () => {
  it("centres on the BOUNDING BOX of every visible member (not the first two)", () => {
    // A third member off to one side must move the frame; a midpoint rule
    // between two of them would leave them out of shot.
    const f = conversationBoundsN([p(0, 0), p(6, 0), p(6, 8)], HOUSE_SPAN);
    expect(f.cx).toBeCloseTo(3, 6);
    expect(f.cz).toBeCloseTo(4, 6);
  });

  it("spans the box DIAGONAL plus margin, so the extremes are not on the edge", () => {
    const f = conversationBoundsN([p(0, 0), p(6, 0), p(6, 8)], HOUSE_SPAN);
    expect(f.span).toBeCloseTo(10 + CONV_PAIR_MARGIN, 6); // hypot(6, 8) = 10
    // …and the group genuinely fits: the frame is wider than either side of the
    // box it has to hold.
    expect(f.span).toBeGreaterThan(8);
  });

  it("frames FIVE members — every one of them inside the span", () => {
    const ring = [p(10, 10), p(12, 11), p(11, 13), p(9, 12.5), p(8.5, 10.5)];
    const f = conversationBoundsN(ring, HOUSE_SPAN);
    const half = f.span / 2;
    for (const m of ring) {
      expect(Math.abs(m.x - f.cx)).toBeLessThanOrEqual(half);
      expect(Math.abs(m.y - f.cz)).toBeLessThanOrEqual(half);
    }
  });

  it("a member JOINING can only widen the frame, never narrow it", () => {
    const two = conversationBoundsN([p(0, 0), p(4, 0)], HOUSE_SPAN);
    const three = conversationBoundsN([p(0, 0), p(4, 0), p(4, 9)], HOUSE_SPAN);
    expect(three.span).toBeGreaterThanOrEqual(two.span);
  });

  it("floors at CONV_MIN_SPAN — a tight huddle is never a face close-up", () => {
    const f = conversationBoundsN([p(5, 5), p(5.4, 5), p(5.2, 5.3)], HOUSE_SPAN);
    expect(f.span).toBeCloseTo(CONV_MIN_SPAN, 6);
  });

  it("ONE visible body (the formless spirit's partner) frames that one person", () => {
    const f = conversationBoundsN([p(20, 7)], HOUSE_SPAN);
    expect(f.cx).toBeCloseTo(20, 6);
    expect(f.cz).toBeCloseTo(7, 6);
    expect(f.span).toBeCloseTo(CONV_MIN_SPAN, 6);
  });

  it("no visible bodies at all yields the minimum window, never NaN", () => {
    const f = conversationBoundsN([], HOUSE_SPAN);
    expect(Number.isFinite(f.cx)).toBe(true);
    expect(Number.isFinite(f.cz)).toBe(true);
    expect(f.span).toBe(CONV_MIN_SPAN);
  });

  it("is NEVER wider than the base frame, at any group size or spread", () => {
    for (let n = 1; n <= 6; n++) {
      for (let spread = 0; spread <= 120; spread += 15) {
        const pts = Array.from({ length: n }, (_, i) => p(i * spread, (i % 2) * spread));
        const f = conversationBoundsN(pts, HOUSE_SPAN);
        expect(f.span).toBeLessThanOrEqual(HOUSE_SPAN + 1e-9);
      }
    }
  });

  it("a house smaller than the minimum span keeps its own frame", () => {
    const tiny = 6;
    expect(conversationBoundsN([p(3, 3), p(3, 3), p(3, 3)], tiny).span).toBe(tiny);
    expect(conversationBoundsN([], tiny).span).toBe(tiny);
  });

  it("ignores member ORDER — the same roster frames the same way", () => {
    const a = conversationBoundsN([p(1, 2), p(9, 4), p(5, 11)], HOUSE_SPAN);
    const b = conversationBoundsN([p(5, 11), p(1, 2), p(9, 4)], HOUSE_SPAN);
    expect(b).toEqual(a);
  });
});

describe("the 2-arg wrapper is the 2-point call", () => {
  const pairs: [{ x: number; y: number }, { x: number; y: number }][] = [
    [p(10, 4), p(16, 12)], // diagonal
    [p(0, 0), p(9, 0)], // axis-aligned
    [p(5, 5), p(5.4, 5)], // inside the floor
    [p(0, 0), p(400, 0)], // past the cap
    [p(20, 7), p(20, 7)], // the one-body degeneracy
    [p(-3, -8), p(-11, 2)], // negative quadrant
  ];

  it("returns IDENTICAL numbers for every pair (not merely close)", () => {
    for (const [a, b] of pairs) {
      expect(conversationBounds(a, b, HOUSE_SPAN)).toEqual(
        conversationBoundsN([a, b], HOUSE_SPAN),
      );
    }
  });

  it("…in both argument orders — a pair's box does not care which is first", () => {
    for (const [a, b] of pairs) {
      expect(conversationBounds(b, a, HOUSE_SPAN)).toEqual(
        conversationBoundsN([a, b], HOUSE_SPAN),
      );
    }
  });

  it("the pair's box DIAGONAL is exactly their separation (why the wrapper holds)", () => {
    for (const [a, b] of pairs) {
      const sep = Math.hypot(b.x - a.x, b.y - a.y);
      const want = Math.min(Math.max(sep + CONV_PAIR_MARGIN, CONV_MIN_SPAN), HOUSE_SPAN);
      expect(conversationBoundsN([a, b], HOUSE_SPAN).span).toBe(want);
    }
  });
});
