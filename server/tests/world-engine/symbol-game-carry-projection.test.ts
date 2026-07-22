// The CARRY projection (DEBUG-CREATURE-BEHAVIOR §4 — "carries it around
// forever"): everything that reads a HAND (ctx.carried, the deposit effect,
// the carry prop) projects through carryKindsOf, so a carried TREAT counts
// under FOOD. Without this a gifted cookie projects to 0 for every template
// the creature owns — no row ever fires on it and it rides the hands forever.
// Pantry counts and market baskets keep the strict kindsOf: treats are never
// dealt into mixes or counted toward provisioning.
import { describe, expect, it } from "@jest/globals";
import { carryKindsOf, carryTotalOf, CLOTHING_KINDS } from "@shared/world-engine/kernel/town/goods-kinds.js";
import { RARE_IMPORT_KIND } from "@shared/world-engine/kernel/town/trade.js";

describe("carryKindsOf — the hand projection", () => {
  it("FOOD's carry kinds include the treats (the gifted cookie)", () => {
    expect(carryKindsOf("food")).toEqual(
      expect.arrayContaining(["apple", "banana", "grape", RARE_IMPORT_KIND]),
    );
  });
  it("non-food goods project exactly their own kinds", () => {
    // Clothing kinds are (head × palette colour) pairs — every clean garment key.
    expect(carryKindsOf("clothing")).toEqual(CLOTHING_KINDS);
    expect(carryKindsOf("clothing")).toContain("shirt.color_red");
    expect(carryKindsOf("clothing").every((k) => /^(shirt|dress)\.color_/.test(k))).toBe(true);
    expect(carryKindsOf("water")).toEqual(["water"]);
  });
  it("counts a treat-only hand under food — the strict kind list would read 0", () => {
    expect(carryTotalOf({ [RARE_IMPORT_KIND]: 2 }, "food")).toBe(2);
    expect(carryTotalOf({ apple: 1, [RARE_IMPORT_KIND]: 1 }, "food")).toBe(2);
  });
  it("a treat is FOOD, not anything else — no cross-good bleed", () => {
    expect(carryTotalOf({ [RARE_IMPORT_KIND]: 1 }, "clothing")).toBe(0);
    expect(carryTotalOf({ [RARE_IMPORT_KIND]: 1 }, "water")).toBe(0);
  });
});
