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
  gaugeModifiersFor,
  qualityPairsFor,
  listConnectors,
  canAcceptPayload,
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

  it("exposes question-word bases that resolve and are AI-visible", () => {
    // person#question = who, thing#question = what, place#question = where,
    // time#question = when, cause#question = why (how reuses `use`).
    for (const key of ["person", "thing", "place", "time", "cause"]) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(item!.exposeToAi).toBe(true);
      expect(item!.tKey).toBe(`aac.glyph.${key}`);
    }
    // Category placement drives the <bundled_icons> grouping.
    expect(getVocabularyItem("person")!.categories).toContain("who");
    expect(getVocabularyItem("thing")!.categories).toContain("what");
    expect(getVocabularyItem("place")!.categories).toContain("where");
    expect(getVocabularyItem("time")!.categories).toContain("when");
  });

  it("gender modifiers apply to person via the gender_body transform", () => {
    for (const key of ["male", "female", "plural"]) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(item!.modifier?.transform).toBe("gender_body");
      expect(item!.modifier?.appliesTo).toContain("person");
    }
    // Surfaced in the person modifier carousel.
    const personMods = modifiersFor("person").map((m) => m.key);
    expect(personMods).toEqual(expect.arrayContaining(["male", "female", "plural"]));
  });

  it("gauge quantifiers form the amount scale on nouns", () => {
    const levels: Record<string, number> = { none: 0, some: 0.33, half: 0.5, most: 0.8, all: 1 };
    for (const [key, level] of Object.entries(levels)) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(item!.modifier?.transform).toBe("gauge");
      expect(item!.modifier?.gauge).toBe(level);
      expect(item!.modifier?.appliesTo).toContain("noun");
    }
    // Surfaced via the dedicated amount picker, not the main carousel.
    expect(gaugeModifiersFor("noun").map((m) => m.key)).toEqual(
      expect.arrayContaining(["none", "some", "all"]),
    );
  });

  it("quality opposite-pairs link via pairKey", () => {
    // good/bad render as emoji badges; right/wrong use the polarity ✓/✗ mark.
    expect(getVocabularyItem("good")!.modifier?.pairKey).toBe("bad");
    expect(getVocabularyItem("bad")!.modifier?.pairKey).toBe("good");
    expect(getVocabularyItem("right")!.modifier?.transform).toBe("polarity");
    expect(getVocabularyItem("right")!.modifier?.polarity).toBe("pos");
    expect(getVocabularyItem("wrong")!.modifier?.polarity).toBe("neg");
    expect(getVocabularyItem("wrong")!.modifier?.pairKey).toBe("right");
    // Surfaced via the dedicated quality pole-toggle picker, not the carousel.
    expect(qualityPairsFor("noun").map((p) => p.pos.key)).toEqual(
      expect.arrayContaining(["good", "right"]),
    );
  });

  it("connectors are pos 'connector', AI-visible, and not modifiers", () => {
    for (const key of ["and", "or", "but", "if", "because"]) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(item!.pos).toBe("connector");
      expect(item!.exposeToAi).toBe(true);
      expect(item!.modifier).toBeUndefined();
    }
  });

  it("spatial relations are forward-binding joins (pos connector)", () => {
    for (const key of ["to", "from", "in", "out", "on", "under", "over", "through"]) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(item!.pos).toBe("connector");
      expect(item!.exposeToAi).toBe(true);
    }
  });

  it("builder-picker helpers surface the new families", () => {
    expect(gaugeModifiersFor("noun").map((m) => m.key)).toEqual(
      expect.arrayContaining(["none", "some", "all"]),
    );
    const goodPair = qualityPairsFor("noun").find((p) => p.pos.key === "good");
    expect(goodPair?.neg.key).toBe("bad");
    expect(listConnectors().map((c) => c.key)).toEqual(
      expect.arrayContaining(["and", "or", "because", "to", "under"]),
    );
  });

  it("gauge + quality mods are hidden from the main modifier carousel", () => {
    const nounCarousel = modifiersFor("noun").map((m) => m.key);
    expect(nounCarousel).not.toContain("none");
    expect(nounCarousel).not.toContain("good");
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

  it("composable hand verbs accept noun payloads", () => {
    for (const k of ["want", "give", "take", "receive", "have"]) {
      const item = getVocabularyItem(k);
      expect(item).toBeDefined();
      expect(item!.composable).toBeDefined();
      expect(canAcceptPayload(item!, "noun")).toBe(true);
    }
  });

  it("mental verbs (say, think) are composable", () => {
    for (const k of ["say", "think"]) {
      const item = getVocabularyItem(k);
      expect(item).toBeDefined();
      expect(item!.composable).toBeDefined();
      expect(canAcceptPayload(item!, "noun")).toBe(true);
    }
  });

  it("composable.suggestCategories reference known categories", () => {
    const knownCats = new Set(["who", "do", "what", "where", "when"]);
    for (const v of listAllVocabulary()) {
      if (!v.composable) continue;
      for (const c of v.composable.suggestCategories) {
        expect(knownCats.has(c)).toBe(true);
      }
    }
  });

  it("canAcceptPayload returns false for items without composable facet", () => {
    const i_me = getVocabularyItem("i_me")!;
    expect(canAcceptPayload(i_me, "noun")).toBe(false);
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
