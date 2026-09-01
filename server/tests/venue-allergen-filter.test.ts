/**
 * Tests for the allergen filter (§3.3).
 *
 * The required cases in §7 are all here, plus the ones the live teardowns
 * argued for. Two properties matter more than the rest and are asserted
 * repeatedly from different angles:
 *
 *   - NOTHING CLEARS AN ITEM. There is no tag, claim, or phrase that marks a
 *     dish safe. Items survive only by not matching.
 *   - AN UNKNOWN ALLERGEN IS STILL AN ALLERGEN. The curated groups are a
 *     convenience; the clinician's own words are searched literally, so an
 *     allergy this file has never heard of still filters.
 *
 * DB-free, no LLM: belongs in `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  filterItemsForAllergies,
  allergyTerms,
  textContainsTerm,
} from "../services/venue-menus/allergen-filter.js";
import type { RefinedMenuItem } from "../services/venue-menus/menu-refinement.js";

function item(partial: Partial<RefinedMenuItem> & { name: string }): RefinedMenuItem {
  return { kind: "food", ...partial };
}

describe("textContainsTerm — word matching, in two scripts", () => {
  it("does not strike an unrelated word that merely contains the term", () => {
    // The §7 case: an "egg" allergy must not remove eggplant. Over-filtering is
    // the safe direction, but a filter that removes obviously unrelated food
    // teaches a caretaker to distrust it — which is its own hazard.
    expect(textContainsTerm("Grilled eggplant", "egg")).toBe(false);
    expect(textContainsTerm("Egg salad", "egg")).toBe(true);
    expect(textContainsTerm("Fried eggs", "eggs")).toBe(true);
  });

  it("is case-insensitive and survives punctuation", () => {
    expect(textContainsTerm("PEANUT-butter cookie", "peanut")).toBe(true);
    expect(textContainsTerm("Cake (contains milk).", "milk")).toBe(true);
  });

  it("matches Hebrew through attached prefixes and plural suffixes", () => {
    // Hebrew glues ב/ה/ו/כ/ל/מ/ש onto the noun and pluralises by suffix, so a
    // \\b-style match would miss every real menu occurrence.
    expect(textContainsTerm("עוגה עם אגוזים", "אגוז")).toBe(true);
    expect(textContainsTerm("סלט באגוזים", "אגוז")).toBe(true);
    expect(textContainsTerm("רוטב בוטנים חריף", "בוטן")).toBe(true);
    expect(textContainsTerm("קינוח שוקולד", "אגוז")).toBe(false);
  });

  it("folds Hebrew final letters, so a singular term matches its own plural", () => {
    // Hebrew rewrites the last letter under suffixation: בוטן -> בוטנים, ן -> נ.
    // Without folding, the singular term stored in the group list does not
    // occur inside the plural printed on the menu, and the filter silently
    // misses it. Every pair below failed before the fold went in.
    expect(textContainsTerm("רוטב בוטנים חריף", "בוטן")).toBe(true);
    expect(textContainsTerm("לחמניה טרייה", "לחם")).toBe(true);
    expect(textContainsTerm("עוגיות שומשומים", "שומשום")).toBe(true);
    expect(textContainsTerm("ללא גלוטן", "גלוטן")).toBe(true);
  });

  it("sees through bidi control marks", () => {
    // The live טומי רול extraction carried an embedded RLE mark. A term match
    // must not be defeated by an invisible character.
    expect(textContainsTerm("‫עוגת אגוזים", "אגוז")).toBe(true);
  });
});

describe("textContainsTerm — bounded suffix growth", () => {
  // Found by the pipeline suite on its first run (2026-09-01): the Hebrew
  // free-suffix rule let פסטו (pesto, a genuine pine-nut term) grow into
  // פסטות — the PASTA category heading — so a peanut allergy erased every
  // pasta on every Israeli menu. Pesto itself must keep matching in all its
  // real positions; the pasta words must not.

  it("פסטו does not strike פסטות or פסטה", () => {
    expect(textContainsTerm("פסטות", "פסטו")).toBe(false);
    expect(textContainsTerm("פסטה רוזה", "פסטו")).toBe(false);
  });

  it("פסטו still strikes actual pesto — bare, prefixed, and mid-sentence", () => {
    expect(textContainsTerm("פסטו", "פסטו")).toBe(true);
    expect(textContainsTerm("בפסטו", "פסטו")).toBe(true);
    expect(textContainsTerm("רוטב פסטו ביתי", "פסטו")).toBe(true);
  });

  it("ordinary inflection still grows — בוטן catches בוטנים", () => {
    expect(textContainsTerm("עוגת בוטנים", "בוטן")).toBe(true);
  });
});

describe("allergyTerms — reading what a clinician typed", () => {
  it("strips the words that describe the allergy rather than the allergen", () => {
    const terms = allergyTerms("Severe allergy to peanuts");
    expect(terms).toContain("peanuts");
    expect(terms).not.toContain("severe");
    expect(terms).not.toContain("allergy");
  });

  it("expands a recognised allergen into its whole group", () => {
    // "peanuts" must also bring almonds, pistachios, marzipan, and the Hebrew
    // equivalents — a nut-allergic student is not only allergic to the nut
    // their record happens to name.
    const terms = allergyTerms("peanut allergy");
    expect(terms).toContain("almond");
    expect(terms).toContain("אגוז");
    expect(terms).toContain("marzipan");
  });

  it("keeps an unknown allergen as a literal search term", () => {
    const terms = allergyTerms("mango");
    expect(terms).toEqual(["mango"]);
  });

  it("reads a Hebrew allergy line, prefix and all", () => {
    const terms = allergyTerms("אלרגיה לבוטנים");
    expect(terms).toContain("בוטן"); // via the group
    expect(terms).not.toContain("אלרגיה");
  });

  it("returns nothing for an empty or content-free line", () => {
    expect(allergyTerms("")).toEqual([]);
    expect(allergyTerms("   ")).toEqual([]);
    expect(allergyTerms("severe allergy")).toEqual([]);
  });
});

describe("filterItemsForAllergies", () => {
  it("filters an almond item for a nut allergy — defect (b) as a test", () => {
    // MenuSpark returned `dietary: []` for "Almond Croissant". Our items do not
    // even carry a dietary field, so the only thing that can save this item is
    // the text filter. It must not.
    const result = filterItemsForAllergies(
      [item({ name: "Almond Croissant" }), item({ name: "Orange Juice", kind: "drink" })],
      ["nut allergy"],
    );

    expect(result.items.map((i) => i.name)).toEqual(["Orange Juice"]);
    expect(result.removed).toEqual([
      { name: "Almond Croissant", allergyText: "nut allergy", term: "almond" },
    ]);
  });

  it("filters on Hebrew ingredient text in the description", () => {
    const result = filterItemsForAllergies(
      [
        item({ name: "סלט ירוק", description: "עם שקדים קלויים" }),
        item({ name: "סלט עגבניות", description: "עגבניה, מלפפון" }),
      ],
      ["אלרגיה לאגוזים"],
    );

    expect(result.items.map((i) => i.name)).toEqual(["סלט עגבניות"]);
    expect(result.removed[0].term).toBe("שקד");
  });

  it("filters an allergen nobody taught it about", () => {
    const result = filterItemsForAllergies(
      [item({ name: "Mango Sorbet" }), item({ name: "Lemon Sorbet" })],
      ["mango"],
    );
    expect(result.items.map((i) => i.name)).toEqual(["Lemon Sorbet"]);
  });

  it("does not let a safety CLAIM clear an item", () => {
    // "Nut-free brownie" is removed for a nut allergy. That is over-filtering,
    // and it is the intended behaviour: no phrase on a scraped menu is evidence
    // of anything, and the failure we refuse to risk is the other one.
    const result = filterItemsForAllergies([item({ name: "Nut-free brownie" })], ["nuts"]);
    expect(result.items).toHaveLength(0);
  });

  it("drops an item with no readable text when allergies are recorded", () => {
    // Rule 4: we cannot check nothing.
    const result = filterItemsForAllergies(
      [item({ name: "   " }), item({ name: "Water", kind: "drink" })],
      ["nuts"],
    );
    expect(result.items.map((i) => i.name)).toEqual(["Water"]);
    expect(result.unreadableCount).toBe(1);
  });

  it("reports how much of the menu it could actually inspect", () => {
    // The honesty field. The טומי רול menu was 59 rows of name and price — the
    // filter's silence about them means very little, and a caller must be able
    // to tell a caretaker so rather than presenting this as a checked board.
    const result = filterItemsForAllergies(
      [
        item({ name: "רול אנטריקוט" }),
        item({ name: "קוקה קולה", kind: "drink" }),
        item({ name: "Green Salad", description: "lettuce, tomato, cucumber" }),
      ],
      ["nuts"],
    );

    expect(result.items).toHaveLength(3);
    expect(result.uninspectableCount).toBe(2); // the two bare names
  });

  it("filters nothing when no allergies are recorded", () => {
    const items = [item({ name: "Almond Croissant" }), item({ name: "Peanut Sauce" })];
    for (const allergies of [[], null, undefined]) {
      const result = filterItemsForAllergies(items, allergies);
      expect(result.items).toHaveLength(2);
      expect(result.uninspectableCount).toBe(0);
      expect(result.activeAllergies).toEqual([]);
    }
  });

  it("keeps a nameless row when there is nothing to check for", () => {
    // With no allergies, a blank row is junk rather than a hazard — the board
    // builder's own filtering owns that, not this file.
    const result = filterItemsForAllergies([item({ name: "  " })], []);
    expect(result.items).toHaveLength(1);
    expect(result.unreadableCount).toBe(0);
  });

  it("applies every recorded allergy, not only the first", () => {
    const result = filterItemsForAllergies(
      [
        item({ name: "Peanut Noodles" }),
        item({ name: "Shrimp Salad" }),
        item({ name: "Rice" }),
      ],
      ["peanuts", "shellfish"],
    );

    expect(result.items.map((i) => i.name)).toEqual(["Rice"]);
    expect(result.removed.map((r) => r.allergyText)).toEqual(["peanuts", "shellfish"]);
    expect(result.activeAllergies).toEqual(["peanuts", "shellfish"]);
  });

  it("reads the translated name and the category too, not just the name", () => {
    const result = filterItemsForAllergies(
      [item({ name: "מאפה מיוחד", translatedName: "Walnut pastry" })],
      ["nuts"],
    );
    expect(result.items).toHaveLength(0);
  });
});
