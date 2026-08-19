/**
 * Pure-logic tests for multi-frame camera capture merging.
 *
 * A menu is rarely one photo, and consecutive shots OVERLAP. These tests pin
 * the overlap handling and the review-escalation rules, neither of which needs
 * a vision model to exercise.
 *
 * DB-free, no LLM: `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  mergeExtractedPages,
  itemKey,
  LOW_CONFIDENCE_THRESHOLD,
  type ExtractedPage,
} from "../services/venue-menus/page-merge.js";
import { parseExtractionResponse } from "../services/venue-menus/camera-extraction.js";

const page = (items: ExtractedPage["items"], extra: Partial<ExtractedPage> = {}): ExtractedPage => ({
  items,
  ...extra,
});

describe("itemKey", () => {
  it("ignores bidi control characters", () => {
    // The live טומי רול extraction contained "‫לקוחות יקרים!" with an embedded
    // RIGHT-TO-LEFT EMBEDDING mark. Two frames of one Hebrew menu can differ by
    // exactly that and nothing else.
    const withMark = { name: "‫רול אנטריקוט", price: 48 };
    const without = { name: "רול אנטריקוט", price: 48 };
    expect(itemKey(withMark)).toBe(itemKey(without));
  });

  it("ignores case and whitespace differences", () => {
    expect(itemKey({ name: "  Chicken   Roll " })).toBe(itemKey({ name: "chicken roll" }));
  });

  it("treats different prices as different items", () => {
    // Two sizes of one dish often share a name. Collapsing them would silently
    // remove a choice from the student.
    expect(itemKey({ name: "Burger", price: 49 })).not.toBe(itemKey({ name: "Burger", price: 73 }));
  });
});

describe("mergeExtractedPages", () => {
  it("concatenates distinct pages in capture order", () => {
    const out = mergeExtractedPages([
      page([{ name: "Starter" }]),
      page([{ name: "Main" }]),
      page([{ name: "Dessert" }]),
    ]);
    expect(out.items.map((i) => i.name)).toEqual(["Starter", "Main", "Dessert"]);
    expect(out.droppedDuplicates).toBe(0);
  });

  it("drops cross-frame overlap and keeps the first occurrence", () => {
    // Menu order is meaningful (starters before desserts) and the board is laid
    // out from it, so the first sighting must win.
    const out = mergeExtractedPages([
      page([{ name: "Soup" }, { name: "Salad" }]),
      page([{ name: "Salad" }, { name: "Steak" }]),
    ]);
    expect(out.items.map((i) => i.name)).toEqual(["Soup", "Salad", "Steak"]);
    expect(out.droppedDuplicates).toBe(1);
  });

  it("drops rows with no usable name", () => {
    // OCR noise from a border. Letting it through would shift every later index
    // in the refinement pass's index space.
    const out = mergeExtractedPages([page([{ name: "  " }, { name: "" }, { name: "Real Dish" }])]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].name).toBe("Real Dish");
  });

  it("takes language and currency from the first frame that reports them", () => {
    // A later frame of just photographs must not blank out what page 1 said.
    const out = mergeExtractedPages([
      page([{ name: "A" }], { language: "he", currency: "ILS" }),
      page([{ name: "B" }]),
    ]);
    expect(out.language).toBe("he");
    expect(out.currency).toBe("ILS");
  });

  it("survives an empty or malformed page list", () => {
    expect(mergeExtractedPages([]).items).toEqual([]);
    expect(mergeExtractedPages([page(undefined as any)]).items).toEqual([]);
  });
});

describe("mergeExtractedPages — review escalation", () => {
  it("does not require review for a clean, confident capture", () => {
    const out = mergeExtractedPages([page([{ name: "Soup", confidence: 0.95 }])]);
    expect(out.requiresReview).toBe(false);
    expect(out.lowConfidenceCount).toBe(0);
  });

  it("requires review when any row is low-confidence", () => {
    // requireReview:'web_only' exempts camera menus because they cannot suffer
    // the wrong-restaurant defect. It cannot exempt a menu we could not READ.
    const out = mergeExtractedPages([
      page([
        { name: "Soup", confidence: 0.95 },
        { name: "Sm0ked Sa1mon", confidence: LOW_CONFIDENCE_THRESHOLD - 0.01 },
      ]),
    ]);
    expect(out.lowConfidenceCount).toBe(1);
    expect(out.requiresReview).toBe(true);
  });

  it("treats the threshold itself as confident enough", () => {
    const out = mergeExtractedPages([page([{ name: "Soup", confidence: LOW_CONFIDENCE_THRESHOLD }])]);
    expect(out.requiresReview).toBe(false);
  });

  it("treats a missing confidence as confident", () => {
    const out = mergeExtractedPages([page([{ name: "Soup" }])]);
    expect(out.requiresReview).toBe(false);
  });

  it("requires review for an EMPTY capture", () => {
    // Saving zero items silently would present as "this restaurant has no food"
    // rather than "the photo missed the menu, try again".
    expect(mergeExtractedPages([]).requiresReview).toBe(true);
    expect(mergeExtractedPages([page([])]).requiresReview).toBe(true);
  });
});

describe("parseExtractionResponse", () => {
  it("reads a forced-tool-call envelope", () => {
    // The shape ClaudeStructuredProvider actually returns: the forced tool's
    // input arrives as a JSON STRING in `content`. An earlier version of this
    // fixture asserted an `output: [{type:"function_call"}]` array instead,
    // which no provider in this repo emits — and so it passed while the real
    // camera path read nothing at all. See venue-structured-payload.test.ts.
    const out = parseExtractionResponse({
      content: JSON.stringify({
        language: "he",
        items: [{ name: "רול עוף", price: 48, priceText: "₪48", confidence: 0.9 }],
      }),
      toolCalls: [],
      refused: false,
    });
    expect(out?.language).toBe("he");
    expect(out?.items[0]).toEqual({ name: "רול עוף", price: 48, priceText: "₪48", confidence: 0.9 });
  });

  it("reads an output_text envelope", () => {
    const out = parseExtractionResponse({ output_text: JSON.stringify({ items: [{ name: "Soup" }] }) });
    expect(out?.items).toHaveLength(1);
  });

  it("returns null rather than throwing on junk", () => {
    // One unreadable frame must not lose the other seven.
    for (const junk of [null, undefined, "", 5, {}, { output_text: "not json" }, { items: "nope" }]) {
      expect(parseExtractionResponse(junk)).toBeNull();
    }
  });

  it("drops fields of the wrong type instead of passing them through", () => {
    const out = parseExtractionResponse({
      output_text: JSON.stringify({
        items: [{ name: "Soup", price: "forty-eight", confidence: 0.9, category: 7 }],
      }),
    });
    expect(out?.items[0].price).toBeUndefined();
    expect(out?.items[0].category).toBeUndefined();
    expect(out?.items[0].name).toBe("Soup");
  });

  it("drops nameless rows", () => {
    const out = parseExtractionResponse({
      output_text: JSON.stringify({ items: [{ price: 10 }, { name: "Real" }] }),
    });
    expect(out?.items).toHaveLength(1);
  });
});
