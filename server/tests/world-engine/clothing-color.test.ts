// CLOTHING COLOUR (Phase 1): a garment is a COLOURED item — its glyph carries a
// `color_*` facet (`shirt.color_red`), colour enters the KIND enumeration (like
// fruit), and the colour survives the whole buy → wear → dirty → wash → stow
// lifecycle. Two layers are pinned here: the creatures/clothing.ts (head × colour)
// bijection that the render `wearing` index rides, and the kernel goods-kinds
// vocabulary every count/deal/carry projection reads through.

import { describe, expect, it } from "@jest/globals";
import {
  OUTFIT_PRESET_COUNT,
  GARMENT_WEARABLE_HEADS,
  GARMENT_COLORS,
  GARMENT_COLOR_HEX,
  DEFAULT_DRESS_PALETTE,
  outfitPresetFor,
  outfitIndexOf,
  outfitIndexForDress,
  dressPaletteFrom,
  garmentOfIndex,
  garmentGlyphOfIndex,
  GARMENT_COLOR_HEX,
} from "@shared/world-engine/creatures/clothing.js";
import { COLOR_DIMENSION } from "@shared/world-engine/variations.js";
import {
  CLOTHING_HEADS,
  CLOTHING_KINDS,
  LAUNDRY_KINDS,
  isLaundryGlyph,
  kindsOf,
  isKindOf,
  goodKeyOfGlyph,
  stackTotalOf,
  carryKindsOf,
  carryTotalOf,
  splitStock,
} from "@shared/world-engine/kernel/town/goods-kinds.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

describe("clothing colour — the (head × colour) outfit bijection", () => {
  it("the index space is heads × colours, and every colour has a hex", () => {
    expect(OUTFIT_PRESET_COUNT).toBe(GARMENT_WEARABLE_HEADS.length * GARMENT_COLORS.length);
    for (const c of GARMENT_COLORS) {
      expect(GARMENT_COLOR_HEX[c]).toBeDefined();
      expect(GARMENT_COLOR_HEX[c]!.fabric).toMatch(HEX);
      expect(GARMENT_COLOR_HEX[c]!.accent).toMatch(HEX);
    }
  });

  it("garmentOfIndex ↔ outfitIndexOf round-trips for every slot", () => {
    for (let i = 0; i < OUTFIT_PRESET_COUNT; i++) {
      const { head, color } = garmentOfIndex(i);
      expect(GARMENT_WEARABLE_HEADS).toContain(head);
      expect(GARMENT_COLORS).toContain(color);
      expect(outfitIndexOf(head, color)).toBe(i);
      expect(garmentGlyphOfIndex(i)).toBe(`${head}.${color}`);
    }
  });

  it("outfitPresetFor renders the colour's fabric hex on the main garment", () => {
    const i = outfitIndexOf("shirt", "color_red");
    const outfit = outfitPresetFor(i);
    // shirt slot = coloured shirt + default pants; the shirt carries the colour.
    const shirt = outfit.garments.find((g) => g.kind === "shirt")!;
    expect(shirt.color.toLowerCase()).toBe(GARMENT_COLOR_HEX.color_red!.fabric);
    expect(outfit.garments.some((g) => g.kind === "pants")).toBe(true);
    // a dress slot renders the coloured dress alone.
    const dress = outfitPresetFor(outfitIndexOf("dress", "color_green"));
    expect(dress.garments).toHaveLength(1);
    expect(dress.garments[0]!.kind).toBe("dress");
    expect(dress.garments[0]!.color.toLowerCase()).toBe(GARMENT_COLOR_HEX.color_green!.fabric);
  });

  it("wraps any integer/hash to a valid slot (negatives, overflow, NaN)", () => {
    expect(garmentGlyphOfIndex(-1)).toBe(garmentGlyphOfIndex(OUTFIT_PRESET_COUNT - 1));
    expect(garmentGlyphOfIndex(OUTFIT_PRESET_COUNT * 5 + 2)).toBe(garmentGlyphOfIndex(2));
    expect(() => garmentGlyphOfIndex(Number.NaN)).not.toThrow();
    // an unknown head/colour clamps to the first slot rather than throwing.
    expect(outfitIndexOf("cape", "color_teal")).toBe(0);
  });
});

describe("clothing colour — aligned with the canonical variation dimension", () => {
  it("every garment colour is a value of the canonical colour dimension (no drift)", () => {
    const canonical = new Set(COLOR_DIMENSION.values);
    for (const c of GARMENT_COLORS) expect(canonical.has(c)).toBe(true);
    // and every garment shade key is a garment colour (GARMENT_COLOR_HEX ↔ palette).
    for (const c of GARMENT_COLORS) expect(GARMENT_COLOR_HEX[c]).toBeDefined();
  });
});

describe("clothing colour — culture dress palette (Phase 2)", () => {
  it("the vocabulary is the full colour superset; the default palette is a curated subset", () => {
    // Phase 2 widened the VOCABULARY to all 10 board colours so a culture can
    // pick any; the DEFAULT a town wears stays a small curated set.
    expect(GARMENT_COLORS.length).toBe(10);
    expect(DEFAULT_DRESS_PALETTE.colors.length).toBeLessThanOrEqual(6);
    expect(DEFAULT_DRESS_PALETTE.colors.every((c) => (GARMENT_COLORS as readonly string[]).includes(c))).toBe(true);
    expect(DEFAULT_DRESS_PALETTE.heads).toEqual([...GARMENT_WEARABLE_HEADS]);
  });

  it("dressPaletteFrom keeps valid selections, drops junk, and defaults the empty", () => {
    const warm = dressPaletteFrom(["dress"], ["color_pink", "color_purple"]);
    expect(warm).toEqual({ heads: ["dress"], colors: ["color_pink", "color_purple"] });
    // junk colours/heads are dropped against the vocabulary...
    const filtered = dressPaletteFrom(["shirt", "cape"], ["color_red", "color_teal"]);
    expect(filtered).toEqual({ heads: ["shirt"], colors: ["color_red"] });
    // ...and an absent / all-invalid selection falls back to the curated default.
    expect(dressPaletteFrom(undefined, undefined)).toEqual(DEFAULT_DRESS_PALETTE);
    expect(dressPaletteFrom([], ["color_teal"])).toEqual(DEFAULT_DRESS_PALETTE);
  });

  it("outfitIndexForDress only ever lands inside the active palette", () => {
    const dress = { heads: ["dress"], colors: ["color_pink", "color_purple"] };
    const seen = new Set<string>();
    for (let h = 0; h < 500; h++) {
      const idx = outfitIndexForDress(h * 2654435761, dress);
      const { head, color } = garmentOfIndex(idx);
      expect(dress.heads).toContain(head);
      expect(dress.colors).toContain(color);
      seen.add(`${head}.${color}`);
    }
    // and it actually SPREADS across the palette, not one fixed pick.
    expect(seen.size).toBe(dress.heads.length * dress.colors.length);
  });

  it("the same body picks the same culture garment forever (deterministic)", () => {
    const dress = { heads: ["shirt", "dress"], colors: ["color_red", "color_blue"] };
    expect(outfitIndexForDress(12345, dress)).toBe(outfitIndexForDress(12345, dress));
  });
});

describe("clothing colour — the kernel kind vocabulary", () => {
  it("clothing KINDS are the (head × colour) product; laundry adds .dirty", () => {
    expect(CLOTHING_HEADS).toEqual([...GARMENT_WEARABLE_HEADS]);
    expect(CLOTHING_KINDS).toContain("shirt.color_red");
    expect(CLOTHING_KINDS).toContain("dress.color_blue");
    expect(CLOTHING_KINDS).toHaveLength(GARMENT_WEARABLE_HEADS.length * GARMENT_COLORS.length);
    expect(CLOTHING_KINDS.every((k) => /^(shirt|dress)\.color_/.test(k))).toBe(true);
    expect(LAUNDRY_KINDS).toContain("shirt.color_red.dirty");
    expect(kindsOf("clothing")).toEqual(CLOTHING_KINDS);
    expect(kindsOf("laundry")).toEqual(LAUNDRY_KINDS);
  });

  it("clothing KINDS are NOT bare heads — the head-conflation trap (provisionedHeads livelock)", () => {
    // A clothing kind is `shirt.color_red` (head × colour), so any code that
    // builds a HEAD set from kindsOf() MUST strip the colour facet, or garments
    // stop being recognised as provisioned and the tidy chore livelocks against
    // the dress/laundry/stow rows. This pins the invariant that made that bug
    // possible: the kinds' HEADS are exactly CLOTHING_HEADS, and no kind is a
    // bare head.
    const heads = new Set(kindsOf("clothing").map((k) => k.split(".")[0]));
    expect([...heads].sort()).toEqual([...CLOTHING_HEADS].sort());
    expect(kindsOf("clothing").some((k) => (CLOTHING_HEADS as readonly string[]).includes(k))).toBe(false);
  });

  it("goodKeyOfGlyph routes a coloured garment AND its dirty variant to clothing", () => {
    expect(goodKeyOfGlyph("shirt.color_red")).toBe("clothing");
    expect(goodKeyOfGlyph("dress.color_yellow")).toBe("clothing");
    // dirty banks into the wardrobe too — the HEAD routes, colour is a middle facet.
    expect(goodKeyOfGlyph("shirt.color_red.dirty")).toBe("clothing");
  });

  it("isKindOf is head-based for clothing, dirty-facet-based for laundry", () => {
    expect(isKindOf("shirt.color_red", "clothing")).toBe(true);
    expect(isKindOf("dress.color_green", "clothing")).toBe(true);
    expect(isKindOf("apple", "clothing")).toBe(false);
    expect(isKindOf("shirt.color_red.dirty", "laundry")).toBe(true);
    expect(isKindOf("shirt.color_red", "laundry")).toBe(false); // clean is not laundry
  });

  it("isLaundryGlyph is colour- and facet-order tolerant", () => {
    expect(isLaundryGlyph("shirt.color_red.dirty")).toBe(true);
    expect(isLaundryGlyph("dress.color_blue.dirty")).toBe(true);
    expect(isLaundryGlyph("shirt.dirty")).toBe(true); // colourless authored glyph still recognised
    expect(isLaundryGlyph("shirt.color_red")).toBe(false); // clean
    expect(isLaundryGlyph("apple.hot")).toBe(false);
  });

  it("count + deal projections enumerate every colour", () => {
    const stock = { "shirt.color_red": 2, "dress.color_blue": 3, apple: 9 };
    expect(stackTotalOf(stock, "clothing")).toBe(5); // ignores the apple
    expect(carryKindsOf("clothing")).toEqual(CLOTHING_KINDS);
    expect(carryTotalOf({ "shirt.color_green": 1, "dress.color_yellow": 1 }, "clothing")).toBe(2);
    // splitStock deals across the coloured kinds — a wardrobe fills with a mix.
    const dealt = splitStock("clothing", 8, 0);
    expect(Object.values(dealt).reduce((a, b) => a + b, 0)).toBe(8);
    expect(Object.keys(dealt).every((k) => CLOTHING_KINDS.includes(k))).toBe(true);
    expect(Object.keys(dealt).length).toBeGreaterThan(1); // more than one colour dealt
  });

  it("the doff → wash seam keeps the colour: clean + .dirty ∈ LAUNDRY, wash drops only .dirty", () => {
    const clean = "shirt.color_red";
    const doffed = `${clean}.dirty`;
    expect(LAUNDRY_KINDS).toContain(doffed);
    expect(stackTotalOf({ [doffed]: 1 }, "laundry")).toBe(1);
    // the wash strips the `dirty` facet only — the colour returns to a clean key.
    const washed = doffed.split(".").filter((f) => f !== "dirty").join(".");
    expect(washed).toBe(clean);
    expect(stackTotalOf({ [washed]: 1 }, "clothing")).toBe(1);
  });
});
