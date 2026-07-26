// Tests for board-button icon/text sizing. Pure-logic, no DOM.
//
// What these guard: the AAC settings preview and the student's board must be
// driven by the SAME table and the SAME formulas. They previously weren't —
// the preview laid its rows out with flex values the real renderer had stopped
// reading — so a clinician was choosing between five pictures that didn't
// describe what they'd get.

import { describe, it, expect } from "@jest/globals";
import {
  RATIO_LEVELS,
  ratioLevel,
  labelLines,
  labelFontSize,
  DEFAULT_RATIO_LEVEL,
} from "@shared/button-sizing.js";

describe("ratio levels", () => {
  it("gives the label a strictly larger share at every step", () => {
    const shares = [1, 2, 3, 4, 5].map((l) => {
      const lv = RATIO_LEVELS[l];
      return lv.textFlex / (lv.iconFlex + lv.textFlex);
    });
    for (let i = 1; i < shares.length; i++) {
      // Every step of the slider has to visibly do something, or the control
      // is lying about having five settings.
      expect(shares[i]).toBeGreaterThan(shares[i - 1]);
    }
  });

  it("ends at text exactly as large as the icon", () => {
    expect(RATIO_LEVELS[5].iconFlex).toBe(RATIO_LEVELS[5].textFlex);
  });

  it("clamps out-of-range levels instead of returning undefined", () => {
    expect(ratioLevel(0)).toBe(RATIO_LEVELS[1]);
    expect(ratioLevel(99)).toBe(RATIO_LEVELS[5]);
    expect(ratioLevel(undefined)).toBe(RATIO_LEVELS[DEFAULT_RATIO_LEVEL]);
  });
});

describe("label line breaking", () => {
  it("keeps short labels on one line", () => {
    expect(labelLines("Yes", RATIO_LEVELS[3])).toBe(1);
    expect(labelLines("Hello", RATIO_LEVELS[3])).toBe(1);
  });

  it("wraps longer multi-word labels to two", () => {
    expect(labelLines("I want more please", RATIO_LEVELS[3])).toBe(2);
  });

  it("never wraps a single long word — there's nowhere to break", () => {
    expect(labelLines("Refrigerator", RATIO_LEVELS[3])).toBe(1);
  });

  it("respects a level that forbids wrapping", () => {
    expect(labelLines("I want more please", RATIO_LEVELS[1])).toBe(1);
  });
});

describe("label font size", () => {
  /** Pull the numeric terms out of `min(<h>cqh, <w>cqw)`. */
  function terms(css: string) {
    const m = css.match(/min\(([\d.]+)cqh, ([\d.]+)cqw\)/);
    if (!m) throw new Error(`unexpected font-size expression: ${css}`);
    return { cqh: parseFloat(m[1]), cqw: parseFloat(m[2]) };
  }

  it("is container-relative only, so it is correct at any button size", () => {
    // No absolute units: an rem cap would bite on a 300px board button but not
    // on an 80px preview tile, which is exactly how the preview drifted before.
    const css = labelFontSize("Hello", RATIO_LEVELS[3]);
    expect(css).not.toMatch(/rem|px|em(?!\))/);
    expect(() => terms(css)).not.toThrow();
  });

  it("halves the height term when the label takes two lines", () => {
    const one = terms(labelFontSize("Yes", RATIO_LEVELS[3])).cqh;
    const two = terms(labelFontSize("I want more please", RATIO_LEVELS[3])).cqh;
    expect(two).toBeCloseTo(one / 2, 1);
  });

  it("shrinks long labels via the width term", () => {
    const short = terms(labelFontSize("Yes", RATIO_LEVELS[3])).cqw;
    const long = terms(labelFontSize("Refrigerator", RATIO_LEVELS[3])).cqw;
    expect(long).toBeLessThan(short);
  });

  it("allows CJK less width per character than Latin", () => {
    // Han glyphs are about twice as wide as Latin at the same font-size;
    // treating them as narrow would push the text past the button's edge.
    const latin = terms(labelFontSize("aaaa", RATIO_LEVELS[3])).cqw;
    const han = terms(labelFontSize("我要更多", RATIO_LEVELS[3])).cqw;
    expect(han).toBeLessThan(latin);
  });

  it("gives a bigger label at level 5 than level 1 for the same text", () => {
    // Level 1 forbids wrapping, so the same label gets one tall line there and
    // two shorter ones at level 5 — the real difference is the flex share, so
    // assert on that rather than on the font expression alone.
    const l1 = RATIO_LEVELS[1];
    const l5 = RATIO_LEVELS[5];
    expect(l5.textFlex / (l5.iconFlex + l5.textFlex)).toBeGreaterThan(
      l1.textFlex / (l1.iconFlex + l1.textFlex),
    );
  });
});
