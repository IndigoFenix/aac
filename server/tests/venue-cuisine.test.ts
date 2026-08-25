/**
 * The food types a student can browse by (shared/venue-cuisine.ts).
 *
 * Pure and DB-free. Two things it has to get right, and both are the kind of
 * thing that fails silently: OSM tag values are messier than the wiki suggests,
 * and every category key has to be a real glyph-registry entry or the grid
 * renders a raw key at a child.
 */

import { describe, test, expect } from "@jest/globals";
import {
  CUISINE_CATEGORIES,
  CUISINE_CATEGORY_KEYS,
  countByCategory,
  cuisineCategory,
  cuisineTokens,
  matchCuisineCategory,
  venueServes,
} from "@shared/venue-cuisine";
import { getVocabularyItem } from "@shared/glyph-registry";

describe("the category table", () => {
  test("every key is a real glyph-registry entry", () => {
    // The grid draws its label from `aac.glyph.<key>` and its art from the
    // registry. A key with no entry renders the key itself — English, and
    // meaningless to a child who cannot read.
    for (const key of CUISINE_CATEGORY_KEYS) {
      expect(getVocabularyItem(key)).toBeTruthy();
    }
  });

  test("no key appears twice", () => {
    expect(new Set(CUISINE_CATEGORY_KEYS).size).toBe(CUISINE_CATEGORY_KEYS.length);
  });

  test("every category carries a fallback emoji", () => {
    // All twelve are in the art queue today, so the emoji IS what renders.
    for (const category of CUISINE_CATEGORIES) {
      expect(category.emoji.trim()).not.toBe("");
    }
  });

  test("fills whole rows of a four-column grid", () => {
    expect(CUISINE_CATEGORIES.length % 4).toBe(0);
  });

  test("an unknown key is a miss, not a throw", () => {
    expect(cuisineCategory("shawarma_palace")).toBeUndefined();
  });
});

describe("matchCuisineCategory", () => {
  test("takes the key itself", () => {
    expect(matchCuisineCategory("pizza")?.key).toBe("pizza");
  });

  test("takes a tag the category already claims", () => {
    // How `cuisine=italian` finds the pizza glyph, reused for the AI's word.
    expect(matchCuisineCategory("italian")?.key).toBe("pizza");
  });

  test("finds the food inside a sentence the Speaker phrased", () => {
    // The Speaker passes what the student SAID, not a key.
    expect(matchCuisineCategory("I want a burger")?.key).toBe("burger");
  });

  test("finds a TWO-WORD food inside a sentence", () => {
    // No single word in "I want ice cream" is a key; the pair is.
    expect(matchCuisineCategory("I want ice cream")?.key).toBe("ice_cream");
    expect(matchCuisineCategory("fried chicken please")?.key).toBe("chicken");
  });

  test("does not match on a substring", () => {
    // "chickpea" must not open the chicken grid on a word nobody said.
    expect(matchCuisineCategory("chickpea salad")).toBeNull();
  });

  test("an unrecognised phrase is null, so the whole grid opens", () => {
    // Null is a real answer: show everything and let the student choose,
    // rather than opening on a guess about what they meant.
    expect(matchCuisineCategory("something nice")).toBeNull();
    expect(matchCuisineCategory("")).toBeNull();
    expect(matchCuisineCategory(null)).toBeNull();
  });
});

describe("cuisineTokens", () => {
  test("splits OSM's semicolon lists", () => {
    expect(cuisineTokens("pizza;italian")).toEqual(["pizza", "italian"]);
  });

  test("survives the untidy tags people actually write", () => {
    // Real OSM data has spaces around separators, capitals, and spaces or
    // hyphens where the wiki says underscore.
    expect(cuisineTokens("Pizza ; Ice Cream")).toEqual(["pizza", "ice_cream"]);
    expect(cuisineTokens("ice-cream")).toEqual(["ice_cream"]);
  });

  test("empty and null are no tokens, not one empty token", () => {
    expect(cuisineTokens(null)).toEqual([]);
    expect(cuisineTokens("")).toEqual([]);
    expect(cuisineTokens(";;")).toEqual([]);
  });
});

describe("venueServes", () => {
  const pizza = cuisineCategory("pizza")!;
  const coffee = cuisineCategory("coffee")!;
  const iceCream = cuisineCategory("ice_cream")!;

  test("matches on the obvious tag", () => {
    expect(venueServes({ cuisine: "pizza" }, pizza)).toBe(true);
  });

  test("matches a nationality tag under the food a child can see", () => {
    // OSM says `italian`; a nonverbal student cannot read "Italian" and there
    // is no picture of it. It has to turn up under the pizza glyph or it is
    // unreachable.
    expect(venueServes({ cuisine: "italian" }, pizza)).toBe(true);
  });

  test("matches one entry of a multi-value tag", () => {
    expect(venueServes({ cuisine: "restaurant;pizza;pasta" }, pizza)).toBe(true);
  });

  test("amenity alone is enough where the amenity IS the answer", () => {
    // Most cafés carry no `cuisine` tag at all. Ignoring amenity would empty
    // the two categories a child is most likely to press.
    expect(venueServes({ cuisine: null, venueType: "cafe" }, coffee)).toBe(true);
    expect(venueServes({ cuisine: null, venueType: "ice_cream" }, iceCream)).toBe(true);
  });

  test("amenity is only consulted for categories that claim one", () => {
    // A café is not a pizzeria just because both are places that serve food.
    expect(venueServes({ cuisine: null, venueType: "cafe" }, pizza)).toBe(false);
  });

  test("an untagged venue matches nothing", () => {
    expect(venueServes({ cuisine: null, venueType: null }, pizza)).toBe(false);
  });

  test("does not match on a substring", () => {
    // "pizzeria" is not in the table; matching it by prefix would also match
    // things the table never listed, which is how a grid starts lying.
    expect(venueServes({ cuisine: "pizzeria" }, pizza)).toBe(false);
  });
});

describe("countByCategory", () => {
  const venues = [
    { cuisine: "pizza", venueType: "restaurant" },
    { cuisine: "italian", venueType: "restaurant" },
    { cuisine: null, venueType: "cafe" },
    { cuisine: "kebab", venueType: "restaurant" },
  ];

  test("counts what is actually there", () => {
    const counts = countByCategory(venues);
    expect(counts.get("pizza")).toBe(2);
    expect(counts.get("coffee")).toBe(1);
  });

  test("a venue can answer two categories", () => {
    // A kebab place is both falafel and meat, and a child looking under either
    // should find it. Nothing is bound by a match, so overlap costs nothing —
    // which is why the table lists a tag under every food it plausibly means.
    const counts = countByCategory(venues);
    expect(counts.get("falafel")).toBe(1);
    expect(counts.get("meat")).toBe(1);
  });

  test("categories with nothing behind them are ABSENT, not zero", () => {
    // A button that leads nowhere costs a student a dwell and the belief that
    // buttons mean something — the same rule allergen-filtered items follow.
    const counts = countByCategory(venues);
    expect(counts.has("ice_cream")).toBe(false);
    for (const n of counts.values()) expect(n).toBeGreaterThan(0);
  });

  test("no venues means no categories", () => {
    expect(countByCategory([]).size).toBe(0);
  });
});
