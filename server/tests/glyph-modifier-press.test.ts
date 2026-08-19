/**
 * applyModifierPress — one modifier press keeping a slot coherent.
 *
 * The bug this closes: the sentence builder's general modifier rail (including
 * the ENGINE-driven one) applied a plain toggle, so two members of one axis
 * could land on the same head. `.hot` then `.cold` composed `apple.hot.cold`,
 * which the renderer reads out as "a hot cold apple" — two presses to reach, and
 * not undoable in one. Counts did the same (`one` + `three`).
 *
 * Only the dedicated colour / emotion / gauge pickers were exclusive before;
 * everything else stacked.
 */

import { describe, it, expect } from "@jest/globals";
import { applyModifierPress } from "@shared/glyph-builder-ops";
import { parseGlyph, serializeGlyph } from "@shared/glyph-compositor";

/** Compose presses onto slot 0 of a single-head glyph and read it back. */
function press(head: string, ...keys: string[]): string {
  let g = parseGlyph(head);
  for (const k of keys) g = applyModifierPress(g, 0, k);
  return serializeGlyph(g);
}

describe("declared opposites (pairKey) cannot both sit on a head", () => {
  it("hot then cold is COLD, not both", () => {
    expect(press("apple", "hot")).toBe("apple.hot");
    expect(press("apple", "hot", "cold")).toBe("apple.cold");
  });

  it("works back the other way too", () => {
    expect(press("apple", "cold", "hot")).toBe("apple.hot");
  });

  it("holds for the other declared pairs", () => {
    expect(press("shirt", "dirty", "clean")).toBe("shirt.clean");
  });
});

describe("naturally exclusive families replace rather than stack", () => {
  it("a count is a count — one then many is many", () => {
    expect(press("apple", "one", "many")).toBe("apple.many");
  });
});

describe("what must still stack", () => {
  it("keeps modifiers from DIFFERENT axes side by side", () => {
    // "a hot big apple" is a perfectly good description; only same-axis conflicts.
    const out = press("apple", "hot", "big");
    expect(out.startsWith("apple.")).toBe(true);
    const mods = out.slice("apple.".length).split(".");
    expect(mods.sort()).toEqual(["big", "hot"]);
  });
});

describe("the toggle survives", () => {
  it("a second press of the SAME modifier removes it", () => {
    expect(press("apple", "hot", "hot")).toBe("apple");
  });

  it("removing one of a pair leaves the head bare", () => {
    expect(press("apple", "hot", "cold", "cold")).toBe("apple");
  });
});

describe("unknown keys", () => {
  it("still toggle — an AI-only symbol has no registry entry to consult", () => {
    expect(press("apple", "sparkly_ai_only")).toBe("apple.sparkly_ai_only");
    expect(press("apple", "sparkly_ai_only", "sparkly_ai_only")).toBe("apple");
  });

  it("is a no-op on a slot that does not exist", () => {
    const g = parseGlyph("apple");
    expect(applyModifierPress(g, 5, "hot")).toBe(g);
  });
});
