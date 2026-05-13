/**
 * Pure-logic tests for the glyph registry. The registry is the shared
 * source of truth for the construction board, the glyph compositor, and
 * the guessing-mode dimension overlap.
 */

import { describe, it, expect } from "@jest/globals";
import {
  getVocabularyItem,
  listAllVocabulary,
  listByCategory,
  listByModeChip,
  modifiersFor,
  listDimensions,
  getDimension,
  MODE_CHIPS,
  defaultModeChip,
} from "../../shared/glyph-registry.js";

describe("glyph registry", () => {
  it("returns the same item for getVocabularyItem and the listing", () => {
    const item = getVocabularyItem("water");
    expect(item).toBeDefined();
    expect(item!.key).toBe("water");
    expect(item!.tKey).toBe("aac.glyph.water");
    expect(item!.pos).toBe("noun");
  });

  it("returns undefined for unknown keys", () => {
    expect(getVocabularyItem("not_a_real_thing")).toBeUndefined();
  });

  it("vocabulary tKeys are uniformly namespaced", () => {
    for (const v of listAllVocabulary()) {
      expect(v.tKey).toMatch(/^aac\.glyph\./);
    }
  });

  it("vocabulary keys are unique", () => {
    const all = listAllVocabulary();
    const keys = new Set(all.map((v) => v.key));
    expect(keys.size).toBe(all.length);
  });

  it("listByCategory returns items in that category", () => {
    const who = listByCategory("who");
    expect(who.length).toBeGreaterThan(0);
    expect(who.every((v) => v.categories.includes("who"))).toBe(true);
    expect(who.some((v) => v.key === "mom")).toBe(true);
  });

  it("cross-listed items (home) appear under both WHAT and WHERE", () => {
    const home = getVocabularyItem("home");
    expect(home).toBeDefined();
    expect(home!.categories).toContain("where");
    expect(home!.categories).toContain("what");
    expect(listByCategory("where").some((v) => v.key === "home")).toBe(true);
    expect(listByCategory("what").some((v) => v.key === "home")).toBe(true);
  });

  it("listByModeChip filters by category and chip", () => {
    const food = listByModeChip("what", "food");
    expect(food.some((v) => v.key === "food")).toBe(true);
    // `water` is under `drink`, not `food`
    expect(food.some((v) => v.key === "water")).toBe(false);
  });

  it("modifiersFor noun returns big, small, not, my, numbers", () => {
    const mods = modifiersFor("noun");
    const keys = new Set(mods.map((m) => m.key));
    expect(keys.has("big")).toBe(true);
    expect(keys.has("small")).toBe(true);
    expect(keys.has("not")).toBe(true);
    expect(keys.has("my")).toBe(true);
    expect(keys.has("one")).toBe(true);
  });

  it("modifiersFor verb does NOT include size/quantity modifiers", () => {
    const verbMods = new Set(modifiersFor("verb").map((m) => m.key));
    expect(verbMods.has("big")).toBe(false);
    expect(verbMods.has("one")).toBe(false);
    // But intensity/social verb modifiers should be present
    expect(verbMods.has("very")).toBe(true);
    expect(verbMods.has("please")).toBe(true);
    expect(verbMods.has("not")).toBe(true);
  });

  it("modifiers are sorted by their `order` field", () => {
    const mods = modifiersFor("noun");
    for (let i = 1; i < mods.length; i++) {
      expect(mods[i].modifier!.order).toBeGreaterThanOrEqual(
        mods[i - 1].modifier!.order
      );
    }
  });

  it("`big` is both a modifier AND a dimension value for `size`", () => {
    const big = getVocabularyItem("big")!;
    expect(big.modifier).toBeDefined();
    expect(big.dimensionValue).toEqual({ dimension: "size", value: "big" });
  });

  it("dimensions reference the right vocabulary value keys", () => {
    const size = getDimension("size");
    expect(size).toBeDefined();
    expect(size!.values).toEqual(["big", "small"]);
    // Both referenced values must exist in the registry
    for (const v of size!.values) {
      expect(getVocabularyItem(v)).toBeDefined();
    }
  });

  it("listDimensions filters by category", () => {
    const whatDims = listDimensions("what");
    expect(whatDims.some((d) => d.id === "size")).toBe(true);
    const doDims = listDimensions("do");
    expect(doDims.some((d) => d.id === "intensity")).toBe(true);
  });

  it("every category has at least one mode chip", () => {
    for (const cat of ["who", "do", "what", "where", "when"] as const) {
      expect(MODE_CHIPS[cat].length).toBeGreaterThan(0);
      expect(defaultModeChip(cat)).toBe(MODE_CHIPS[cat][0]);
    }
  });

  it("every vocabulary item's modeChip entries point to valid chips", () => {
    for (const v of listAllVocabulary()) {
      for (const cat of Object.keys(v.modeChips) as Array<keyof typeof v.modeChips>) {
        const validChips = new Set(MODE_CHIPS[cat as keyof typeof MODE_CHIPS]);
        for (const chip of v.modeChips[cat]!) {
          expect(validChips.has(chip)).toBe(true);
        }
      }
    }
  });

  it("every item provides at least one renderable visual (image or emoji)", () => {
    for (const v of listAllVocabulary()) {
      expect(!!v.imagePath || !!v.emoji || !!v.faIcon).toBe(true);
    }
  });

  it("modifier facets reference only known parts of speech", () => {
    const known = new Set([
      "person", "animal", "noun", "verb", "place", "time", "feeling", "modifier",
    ]);
    for (const v of listAllVocabulary()) {
      if (!v.modifier) continue;
      for (const p of v.modifier.appliesTo) {
        expect(known.has(p)).toBe(true);
      }
    }
  });
});
