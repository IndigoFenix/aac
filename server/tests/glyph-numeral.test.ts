/**
 * Tests for the constructed numeral glyph generator (shared/numeral-glyph.ts).
 * Pure geometry — no React/DOM. Validates the mark vocabulary (stroke/hand/
 * wheel/rings), the fold schedule, the digit fallback, and the left-cap rule
 * (a lower place never draws larger than the place on its left).
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildNumeralGlyph,
  isNumeralKey,
  parseNumeralValue,
  NUMERAL_MAX,
  type NumeralGlyph,
  type NumeralShape,
} from "../../shared/numeral-glyph.js";

// ── shape-counting helpers ───────────────────────────────────────────────────
function counts(g: NumeralGlyph) {
  const c = { line: 0, ring: 0, dot: 0, text: 0 };
  for (const s of g.shapes) c[s.kind]++;
  return c;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

/** Read every mark centered on a filled dot (a wheel hub or hand palm) → its
 *  x, spoke count, and OUTER extent = max(spoke length, surrounding ring radius).
 *  Size lives in the outer ring for ringed marks (a hundred's inner wheel is
 *  deliberately small), so the outer extent is what the cap rule governs. */
function marks(g: NumeralGlyph) {
  const dots = g.shapes.filter((s): s is Extract<NumeralShape, { kind: "dot" }> => s.kind === "dot");
  return dots.map((d) => {
    const spokes = g.shapes.filter(
      (s): s is Extract<NumeralShape, { kind: "line" }> =>
        s.kind === "line" && near(s.x1, d.cx) && near(s.y1, d.cy),
    );
    const spokeR = spokes.length ? Math.max(...spokes.map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1))) : 0;
    const ringR = g.shapes
      .filter((s): s is Extract<NumeralShape, { kind: "ring" }> => s.kind === "ring" && near(s.cx, d.cx) && near(s.cy, d.cy))
      .reduce((m, s) => Math.max(m, s.r), 0);
    return { x: d.cx, spokes: spokes.length, outer: Math.max(spokeR, ringR) };
  });
}

/** Assert mark size never increases left→right (equal within a column is fine).
 *  Small tolerance absorbs the ~2% plain-wheel-vs-ring rim difference. */
function assertNonIncreasing(ms: Array<{ x: number; outer: number }>) {
  const sorted = [...ms].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(0.6, sorted[i].outer * 0.05);
    expect(sorted[i].outer).toBeLessThanOrEqual(sorted[i - 1].outer + tol);
  }
}

function assertFinite(g: NumeralGlyph) {
  for (const s of g.shapes) {
    for (const v of Object.values(s)) {
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
  }
  expect(Number.isFinite(g.width)).toBe(true);
  expect(Number.isFinite(g.height)).toBe(true);
}

// ── key parsing ──────────────────────────────────────────────────────────────
describe("numeral key parsing", () => {
  it("accepts whole numbers in range", () => {
    expect(isNumeralKey("0")).toBe(true);
    expect(isNumeralKey("5")).toBe(true);
    expect(isNumeralKey("99999")).toBe(true);
    expect(isNumeralKey(" 12 ")).toBe(true);
  });
  it("rejects non-numbers and out-of-range", () => {
    expect(isNumeralKey("100000")).toBe(false); // 6 digits
    expect(isNumeralKey("-1")).toBe(false);
    expect(isNumeralKey("1.5")).toBe(false);
    expect(isNumeralKey("apple")).toBe(false);
    expect(isNumeralKey("")).toBe(false);
  });
  it("parseNumeralValue returns the integer or null", () => {
    expect(parseNumeralValue("42")).toBe(42);
    expect(parseNumeralValue(" 7 ")).toBe(7);
    expect(parseNumeralValue("two")).toBeNull();
    expect(parseNumeralValue("100000")).toBeNull();
    expect(NUMERAL_MAX).toBe(99999);
  });
});

// ── mark vocabulary ──────────────────────────────────────────────────────────
describe("mark vocabulary (stroke / hand / wheel / rings)", () => {
  it("1 is a single stroke", () => {
    expect(counts(buildNumeralGlyph(1))).toEqual({ line: 1, ring: 0, dot: 0, text: 0 });
  });
  it("5 is a hand: five fingers + one palm, no ring", () => {
    expect(counts(buildNumeralGlyph(5))).toEqual({ line: 5, ring: 0, dot: 1, text: 0 });
  });
  it("6 is a hand plus one stroke", () => {
    expect(counts(buildNumeralGlyph(6))).toEqual({ line: 6, ring: 0, dot: 1, text: 0 });
  });
  it("10 is a wheel: ten spokes + one hub, no ring", () => {
    const c = counts(buildNumeralGlyph(10));
    expect(c).toEqual({ line: 10, ring: 0, dot: 1, text: 0 });
    expect(marks(buildNumeralGlyph(10))[0].spokes).toBe(10);
  });
  it("15 is a wheel and a hand", () => {
    expect(counts(buildNumeralGlyph(15))).toEqual({ line: 15, ring: 0, dot: 2, text: 0 });
  });
  it("50 is a hand with one ring (×10)", () => {
    expect(counts(buildNumeralGlyph(50))).toEqual({ line: 5, ring: 1, dot: 1, text: 0 });
  });
});

// ── fold schedule ────────────────────────────────────────────────────────────
describe("fold schedule", () => {
  it("0 is empty", () => {
    const g = buildNumeralGlyph(0);
    expect(g.shapes.length).toBe(0);
    expect(g.width).toBe(0);
  });
  it("20 folds the ones but keeps two full wheels for the tens", () => {
    // f=0, tt=2, o=0 → exactly two wheels (20 spokes, 2 hubs), nothing else
    expect(counts(buildNumeralGlyph(20))).toEqual({ line: 20, ring: 0, dot: 2, text: 0 });
  });
  it("a zero interior place is held as a faint slot, not dropped", () => {
    // 3072 → thousands, held hundreds, tens, ones. The held slot is a faint ring.
    const g = buildNumeralGlyph(3072);
    expect(g.shapes.some((s) => s.kind === "ring" && s.faint)).toBe(true);
  });
  it("hands over to digits at 10,000", () => {
    const g = buildNumeralGlyph(12345);
    const t = g.shapes.find((s): s is Extract<NumeralShape, { kind: "text" }> => s.kind === "text");
    expect(t?.text).toBe("12345");
  });
  it("clamps above the max to 99999 digits", () => {
    const g = buildNumeralGlyph(200000);
    const t = g.shapes.find((s): s is Extract<NumeralShape, { kind: "text" }> => s.kind === "text");
    expect(t?.text).toBe("99999");
  });
});

// ── the left-cap rule ────────────────────────────────────────────────────────
describe("left-cap: a place never draws larger than the place on its left", () => {
  it("110 draws the hundred and the ten at (near-)equal size", () => {
    const hs = marks(buildNumeralGlyph(110)).filter((h) => h.spokes >= 8); // wheel hubs only
    expect(hs.length).toBe(2); // one hundred-mark, one ten-mark
    const ratio = Math.max(hs[0].outer, hs[1].outer) / Math.min(hs[0].outer, hs[1].outer);
    expect(ratio).toBeLessThan(1.05); // within 5% — visually equal
    assertNonIncreasing(hs);
  });
  it("120 draws the ten clearly smaller than the hundred", () => {
    const hs = marks(buildNumeralGlyph(120)).filter((h) => h.spokes >= 8);
    expect(hs.length).toBe(3); // one full hundred-mark + two half ten-marks
    const maxR = Math.max(...hs.map((h) => h.outer));
    const minR = Math.min(...hs.map((h) => h.outer));
    expect(maxR).toBeGreaterThan(minR * 1.3); // a real size gap
    const biggest = hs.reduce((a, b) => (b.outer > a.outer ? b : a));
    expect(biggest.x).toBeLessThan(Math.min(...hs.filter((h) => h.outer < maxR - 0.5).map((h) => h.x)));
    assertNonIncreasing(hs);
  });
  it("210 caps the lone ten down so it never out-sizes the two hundreds", () => {
    const hs = marks(buildNumeralGlyph(210)).filter((h) => h.spokes >= 8);
    expect(hs.length).toBe(3); // two hundred-marks + one ten-mark
    assertNonIncreasing(hs); // the rightmost (ten) is not larger than the hundreds
  });
  it("220 keeps both columns at the same shrunk size", () => {
    const hs = marks(buildNumeralGlyph(220)).filter((h) => h.spokes >= 8);
    expect(hs.length).toBe(4);
    assertNonIncreasing(hs);
  });
});

// ── robustness sweep ─────────────────────────────────────────────────────────
describe("robustness", () => {
  const reps = [1, 4, 5, 9, 10, 19, 20, 49, 50, 99, 100, 110, 120, 210, 220, 342, 500, 999, 1000, 3072, 5678, 9999, 10000, 99999];
  it("produces finite geometry with no NaN for every band", () => {
    for (const n of reps) {
      const g = buildNumeralGlyph(n);
      assertFinite(g);
      expect(g.width).toBeGreaterThan(0);
      expect(g.height).toBeGreaterThan(0);
      expect(g.shapes.length).toBeGreaterThan(0);
    }
  });
});
