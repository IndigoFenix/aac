// Tests for the board button's SVG outline. Pure geometry, no DOM.
//
// The property that matters and is easy to get wrong: every cut arc must be
// centred on the GRID VERTEX, not on the button's own corner. Only then do the
// four buttons meeting at a vertex cut against one shared circle, so the space
// between them reads as a single disc instead of a four-lobed blob.

import { describe, it, expect } from "@jest/globals";
import {
  cornerCutPath,
  cornerInset,
  pointInCornerCut,
  roundedRectPath,
  restSpaceRatio,
  REST_SPACE,
} from "@shared/button-shape.js";

const W = 200;
const H = 140;
const OFFSET = 4; // half of an 8px grid gap

describe("corner inset", () => {
  it("is zero when the circle is too small to reach past the gutter", () => {
    expect(cornerInset(3, OFFSET)).toBe(0);
    expect(cornerInset(OFFSET, OFFSET)).toBe(0);
  });

  it("grows with the radius", () => {
    expect(cornerInset(30, OFFSET)).toBeGreaterThan(cornerInset(20, OFFSET));
  });

  it("matches the circle-edge intersection", () => {
    // The arc centred at (-o,-o) crosses the top edge (y=0) where
    // (x+o)² + o² = r², i.e. x = sqrt(r²-o²) - o.
    const r = 24;
    expect(cornerInset(r, OFFSET)).toBeCloseTo(Math.sqrt(r * r - OFFSET * OFFSET) - OFFSET, 6);
  });
});

describe("corner-cut path", () => {
  it("uses sweep-flag 0 — concave corners sweep opposite to convex ones", () => {
    const d = cornerCutPath({ w: W, h: H, radius: 24, offset: OFFSET });
    const arcs = d.match(/A [\d.]+ [\d.]+ 0 0 (\d)/g) ?? [];
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) expect(arc.endsWith("0")).toBe(true);

    // The ordinary rounded rect bulges the other way.
    const convex = roundedRectPath(W, H, 12).match(/A [\d.]+ [\d.]+ 0 0 (\d)/g) ?? [];
    expect(convex).toHaveLength(4);
    for (const arc of convex) expect(arc.endsWith("1")).toBe(true);
  });

  it("starts and ends its straight edges at the inset, not the corner", () => {
    const r = 24;
    const a = cornerInset(r, OFFSET);
    const d = cornerCutPath({ w: W, h: H, radius: r, offset: OFFSET });
    expect(d.startsWith(`M ${Number(a.toFixed(2))} 0`)).toBe(true);
    // No segment may reach the literal corner (0,0) — that's the bitten-out part.
    expect(d).not.toMatch(/L 0 0/);
  });

  it("degenerates to a plain rectangle when nothing can be cut", () => {
    const d = cornerCutPath({ w: W, h: H, radius: 2, offset: OFFSET });
    expect(d).toBe(`M 0 0 L ${W} 0 L ${W} ${H} L 0 ${H} Z`);
  });

  it("clamps the radius so four cuts can't swallow a small button", () => {
    // A huge radius on a small button would otherwise produce arcs that cross.
    const d = cornerCutPath({ w: 40, h: 40, radius: 500, offset: OFFSET });
    const inset = Number(d.match(/^M ([\d.]+) 0/)![1]);
    expect(inset).toBeLessThanOrEqual(20); // half the smaller side
    expect(inset).toBeGreaterThan(0);
  });
});

describe("shared-circle property", () => {
  it("four buttons around a vertex cut against ONE circle", () => {
    // Two buttons side by side with an 8px gap; the shared vertex is the point
    // between them. A probe just inside that circle must fall in a cut for
    // BOTH buttons — that is what makes the empty space read as one disc.
    const gap = OFFSET * 2;
    const radius = 26;
    const left = { left: 0, top: 0, right: W, bottom: H };
    const right = { left: W + gap, top: 0, right: W + gap + W, bottom: H };
    const below = { left: 0, top: H + gap, right: W, bottom: H + gap + H };

    const vx = W + gap / 2;
    const vy = H + gap / 2;

    // A point 80% of the way out from the shared vertex, toward each button.
    const d = radius * 0.8 * Math.SQRT1_2;
    expect(pointInCornerCut(left, radius, OFFSET, vx - d, vy - d)).toBe(true);
    expect(pointInCornerCut(right, radius, OFFSET, vx + d, vy - d)).toBe(true);
    expect(pointInCornerCut(below, radius, OFFSET, vx - d, vy + d)).toBe(true);
  });

  it("excludes points outside the circle", () => {
    const rect = { left: 0, top: 0, right: W, bottom: H };
    expect(pointInCornerCut(rect, 26, OFFSET, W / 2, H / 2)).toBe(false); // centre
    expect(pointInCornerCut(rect, 26, OFFSET, 60, 4)).toBe(false); // along the top edge
  });

  it("includes the button's own corner, which is always inside the cut", () => {
    const rect = { left: 0, top: 0, right: W, bottom: H };
    // The corner is offset*sqrt(2) from the circle's centre, well within it.
    expect(pointInCornerCut(rect, 26, OFFSET, 0, 0)).toBe(true);
    expect(pointInCornerCut(rect, 26, OFFSET, W, H)).toBe(true);
  });

  it("cuts nothing when the board asks for no corner space", () => {
    const rect = { left: 0, top: 0, right: W, bottom: H };
    expect(pointInCornerCut(rect, 0, OFFSET, 0, 0)).toBe(false);
  });
});

describe("rest space levels", () => {
  it("offers a bigger and a smaller bite", () => {
    expect(REST_SPACE.large).toBeGreaterThan(REST_SPACE.small);
    expect(REST_SPACE.none).toBe(0);
  });

  it("falls back to the default for unknown or missing values", () => {
    expect(restSpaceRatio(undefined)).toBe(REST_SPACE.small);
    expect(restSpaceRatio(null)).toBe(REST_SPACE.small);
    expect(restSpaceRatio("nonsense")).toBe(REST_SPACE.small);
    expect(restSpaceRatio("large")).toBe(REST_SPACE.large);
  });
});
