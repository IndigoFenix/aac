/**
 * Pure-logic tests for the menu refinement pass.
 *
 * The point of `applyMenuRefinement` is that a refinement model CANNOT invent a
 * dish, because there is no field an invented dish could arrive in. Most of the
 * suite below is adversarial: it feeds the validator output a hostile or broken
 * model could produce and asserts the facts survive untouched.
 *
 * Fixtures are drawn from the real teardowns in
 * planning-docs/aac-restaurant-menus.md §2 — the Tommy Roll notice rows and the
 * duplicated Aroma salad are the actual failures this pass exists to fix.
 *
 * DB-free, no LLM: belongs in `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  applyMenuRefinement,
  boardableItems,
  type RawMenuItem,
} from "../services/venue-menus/menu-refinement.js";

/** Shape of the real טומי רול extraction, trimmed to the interesting rows. */
const RAW: RawMenuItem[] = [
  { name: "רול אנטריקוט", description: "בחרו ירקות, סלטים ורטבים", price: 48, priceText: "₪48", category: "טורטיות" },
  { name: "‫לקוחות יקרים!", description: "תפריט מוצרי טומי רול ומחיריהם במשלוחים...", category: "💙" },
  { name: "קוקה קולה פחית", price: 13, priceText: "₪13", category: "שתייה קלה" },
  { name: "רוטב שום", price: 1, priceText: "₪1", category: "רטבים בתשלום" },
];

describe("applyMenuRefinement — facts are never taken from the model", () => {
  it("re-reads every factual field from the raw record", () => {
    // A hostile refinement that tries to overwrite the facts. None of these
    // fields are on MenuRefinementEntry, so none of them may land.
    const hostile = [
      {
        index: 0,
        keep: true,
        kind: "food",
        name: "Wagyu Steak",
        price: 500,
        priceText: "₪500",
        description: "invented",
      },
    ];
    const out = applyMenuRefinement(RAW, hostile);
    expect(out.items[0].name).toBe("רול אנטריקוט");
    expect(out.items[0].price).toBe(48);
    expect(out.items[0].priceText).toBe("₪48");
    expect(out.items[0].description).toBe("בחרו ירקות, סלטים ורטבים");
  });

  it("cannot add an item that was not extracted", () => {
    const invented = [
      { index: 0, keep: true },
      { index: 99, keep: true, kind: "food" }, // no such row
    ];
    const out = applyMenuRefinement(RAW, invented);
    expect(out.items).toHaveLength(RAW.length);
    expect(out.rejected).toContainEqual({ index: 99, reason: "index_out_of_range" });
    expect(out.items.map((i) => i.name)).toEqual(RAW.map((r) => r.name));
  });

  it("never invents a price for an unpriced row", () => {
    // The notice row has no price. A model 'helpfully' supplying one must not win.
    const out = applyMenuRefinement(RAW, [{ index: 1, keep: true, price: 25 }]);
    expect(out.items[1].price).toBeUndefined();
    expect(out.items[1].priceText).toBeUndefined();
  });

  it("keeps the original name alongside a translation", () => {
    const out = applyMenuRefinement(RAW, [
      { index: 0, keep: true, kind: "food", translatedName: "Entrecote roll" },
    ]);
    expect(out.items[0].name).toBe("רול אנטריקוט"); // original survives
    expect(out.items[0].translatedName).toBe("Entrecote roll");
  });
});

describe("applyMenuRefinement — annotation fails OPEN", () => {
  it("keeps rows the model said nothing about", () => {
    // Losing a real menu item because the model omitted it is worse than
    // showing an unclassified one.
    const out = applyMenuRefinement(RAW, [{ index: 0, keep: true, kind: "food" }]);
    expect(out.items).toHaveLength(4);
    expect(out.items[2].kind).toBe("unknown");
  });

  it("keeps everything when refinement is missing entirely", () => {
    for (const empty of [null, undefined, []]) {
      const out = applyMenuRefinement(RAW, empty);
      expect(out.items).toHaveLength(RAW.length);
      expect(out.items.every((i) => i.kind === "unknown")).toBe(true);
    }
  });

  it("keeps the item but drops a malformed imageKey", () => {
    const bad = ["Chocolate Croissant", "רול", "food/burger", "_leading", "x".repeat(60), 42, ""];
    for (const key of bad) {
      const out = applyMenuRefinement(RAW, [{ index: 0, keep: true, imageKey: key }]);
      expect(out.items[0].name).toBe("רול אנטריקוט"); // row survives
      expect(out.items[0].imageKey).toBeUndefined(); // annotation refused
      expect(out.rejected.some((r) => r.reason === "bad_image_key")).toBe(true);
    }
  });

  it("folds a well-formed LEGACY imageKey into `icon` — one field to check forever", () => {
    for (const key of ["croissant", "iced_coffee", "coca_cola_can", "burger2"]) {
      const out = applyMenuRefinement(RAW, [{ index: 0, keep: true, imageKey: key }]);
      expect(out.items[0].icon).toBe(key);
      expect(out.items[0].imageKey).toBeUndefined();
    }
  });
});

describe("applyMenuRefinement — icon in regular-board glyph syntax", () => {
  it("accepts heads, `.modifier` toppings, `+` joins, and emoji parts", () => {
    for (const icon of [
      "falafel",
      "pizza.olive",
      "ice_cream.chocolate.vanilla",
      "burger+french_fries",
      "🍕",
      "pizza.🫒",
      "burger+🍟+cola",
    ]) {
      const out = applyMenuRefinement(RAW, [{ index: 0, keep: true, icon }]);
      expect(out.items[0].icon).toBe(icon);
      expect(out.rejected).toHaveLength(0);
    }
  });

  it("keeps the item but refuses an icon outside the documented subset", () => {
    const bad = [
      "Pizza", // caps — a proper noun trying to sneak in
      "פיצה", // not English
      "want(pizza)", // payload syntax is the live model's, not an annotation's
      "pizza#request", // tone tags likewise
      "symbol:abc123", // must never mint refs into the student's symbol store
      "face:xyz", // ditto
      "[pizza]", // bracket marker
      "pizza olives", // whitespace
      "a+b+c+d", // more slots than a button can draw
      "pizza.a.b.c", // more badges than the compositor can place
      "pizza..olive", // empty part
      "x".repeat(70), // a sentence, not a picture
    ];
    for (const icon of bad) {
      const out = applyMenuRefinement(RAW, [{ index: 0, keep: true, icon }]);
      expect(out.items[0].name).toBe("רול אנטריקוט"); // row survives
      expect(out.items[0].icon).toBeUndefined(); // annotation refused
      expect(out.rejected.some((r) => r.reason === "bad_icon")).toBe(true);
    }
  });

  it("prefers `icon` over a legacy imageKey when the model sends both", () => {
    const out = applyMenuRefinement(RAW, [
      { index: 0, keep: true, icon: "pizza.olive", imageKey: "pizza" },
    ]);
    expect(out.items[0].icon).toBe("pizza.olive");
  });
});

describe("applyMenuRefinement — facts fail CLOSED", () => {
  it("refuses a non-integer or non-numeric index", () => {
    const out = applyMenuRefinement(RAW, [
      { index: 1.5, keep: false },
      { index: "0", keep: false },
      { index: NaN, keep: false },
    ]);
    expect(out.items).toHaveLength(RAW.length); // nothing dropped
    expect(out.rejected.filter((r) => r.reason === "index_not_an_integer")).toHaveLength(3);
  });

  it("refuses a negative index", () => {
    const out = applyMenuRefinement(RAW, [{ index: -1, keep: false }]);
    expect(out.rejected).toContainEqual({ index: -1, reason: "index_out_of_range" });
    expect(out.items).toHaveLength(RAW.length);
  });

  it("honours the first annotation for an index and refuses the second", () => {
    const out = applyMenuRefinement(RAW, [
      { index: 0, keep: true, kind: "food" },
      { index: 0, keep: false },
    ]);
    expect(out.items.some((i) => i.name === "רול אנטריקוט")).toBe(true);
    expect(out.rejected).toContainEqual({ index: 0, reason: "duplicate_index" });
  });

  it("refuses non-object entries without disturbing the rest", () => {
    const out = applyMenuRefinement(RAW, ["nope", null, 7, [], { index: 0, keep: true, kind: "food" }]);
    expect(out.items[0].kind).toBe("food");
    expect(out.rejected.filter((r) => r.reason === "malformed_entry").length).toBeGreaterThan(0);
  });
});

describe("applyMenuRefinement — dropping", () => {
  it("drops a notice row when the model says not to keep it", () => {
    // "לקוחות יקרים!" (Dear customers!) — the real defect (f) case.
    const out = applyMenuRefinement(RAW, [{ index: 1, keep: false }]);
    expect(out.items.map((i) => i.name)).not.toContain("‫לקוחות יקרים!");
    expect(out.dropped).toContainEqual({ index: 1, name: "‫לקוחות יקרים!", reason: "not_kept" });
  });

  it("drops a flagged duplicate and keeps its target", () => {
    // The Aroma "Greek Chickpea Salad" x2 case.
    const dupes: RawMenuItem[] = [
      { name: "Greek Chickpea Salad", price: 40 },
      { name: "Greek Chickpea Salad", price: 40 },
    ];
    const out = applyMenuRefinement(dupes, [
      { index: 0, keep: true, kind: "food" },
      { index: 1, duplicateOf: 0 },
    ]);
    expect(out.items).toHaveLength(1);
    expect(out.dropped).toContainEqual({ index: 1, name: "Greek Chickpea Salad", reason: "duplicate" });
  });

  it("refuses a self-referential duplicate rather than dropping the row", () => {
    const out = applyMenuRefinement(RAW, [{ index: 0, duplicateOf: 0 }]);
    expect(out.items.some((i) => i.name === "רול אנטריקוט")).toBe(true);
    expect(out.rejected).toContainEqual({ index: 0, reason: "self_duplicate" });
  });

  it("refuses a duplicate pointing outside the list", () => {
    const out = applyMenuRefinement(RAW, [{ index: 0, duplicateOf: 99 }]);
    expect(out.items.some((i) => i.name === "רול אנטריקוט")).toBe(true);
    expect(out.rejected.some((r) => r.reason === "bad_duplicate_target")).toBe(true);
  });

  it("preserves raw order among the survivors", () => {
    const out = applyMenuRefinement(RAW, [{ index: 1, keep: false }]);
    expect(out.items.map((i) => i.name)).toEqual([
      "רול אנטריקוט",
      "קוקה קולה פחית",
      "רוטב שום",
    ]);
  });
});

describe("boardableItems", () => {
  it("drops notices but KEEPS condiments", () => {
    // Folding twelve ₪1 sauces into a modifier is a layout decision (§8).
    // Dropping them here would silently remove the student's ability to ask
    // for garlic sauce.
    const out = applyMenuRefinement(RAW, [
      { index: 0, keep: true, kind: "food" },
      { index: 1, keep: true, kind: "notice" },
      { index: 2, keep: true, kind: "drink" },
      { index: 3, keep: true, kind: "condiment" },
    ]);
    const boardable = boardableItems(out);
    expect(boardable.map((i) => i.kind)).toEqual(["food", "drink", "condiment"]);
  });

  it("keeps unclassified rows on the board", () => {
    const out = applyMenuRefinement(RAW, []);
    expect(boardableItems(out)).toHaveLength(RAW.length);
  });
});
