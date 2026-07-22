// The canonical FACET taxonomy (shared/world-engine/variations.ts): head +
// variations (colour/size/material) + states, the one source of truth for
// reading a composed item glyph. Pins the split, the appearance composition, the
// generic variant enumeration, and the dye-shaped `withVariation`.

import { describe, expect, it } from "@jest/globals";
import {
  headOf,
  facetsOf,
  composeGlyph,
  withVariation,
  appearanceOf,
  variantKindsOf,
  variationFacetsOf,
  stateFacetsOf,
  isVariationFacet,
  isStateFacet,
  STATE_FACETS,
  VARIATION_DIMENSIONS,
  DIMENSION_OF_VALUE,
} from "@shared/world-engine/variations.js";

describe("headOf — the one head extractor", () => {
  it("returns the kind head regardless of variation/state facets", () => {
    expect(headOf("shirt")).toBe("shirt");
    expect(headOf("shirt.color_red")).toBe("shirt");
    expect(headOf("shirt.color_red.dirty")).toBe("shirt");
    expect(headOf("chair.material_wood")).toBe("chair");
    expect(headOf("")).toBe("");
  });
});

describe("facetsOf — variations vs states", () => {
  it("splits a multi-facet glyph into head / variations / states", () => {
    expect(facetsOf("shirt.color_red.dirty")).toEqual({
      head: "shirt",
      variations: ["color_red"],
      states: ["dirty"],
    });
    expect(facetsOf("table.material_iron.big")).toEqual({
      head: "table",
      variations: ["material_iron", "big"],
      states: [],
    });
  });
  it("an unknown mod is a DESCRIPTOR/variation, never a state (matches legacy glyphFacets)", () => {
    // States are the CLOSED registered set; anything else dotted is a descriptor.
    expect(facetsOf("apple.sparkly").variations).toContain("sparkly");
    expect(facetsOf("apple.sparkly").states).toEqual([]);
    expect(facetsOf("apple.hot").states).toEqual(["hot"]);
  });
  it("classifiers agree with the sets", () => {
    expect(isVariationFacet("color_red")).toBe(true);
    expect(isVariationFacet("big")).toBe(true);
    expect(isVariationFacet("dirty")).toBe(false);
    expect(isStateFacet("dirty")).toBe(true);
    expect(STATE_FACETS.has("hot")).toBe(true);
    expect(DIMENSION_OF_VALUE.get("color_red")).toBe("color");
    expect(DIMENSION_OF_VALUE.get("material_wood")).toBe("material");
    expect(DIMENSION_OF_VALUE.get("big")).toBe("size");
  });
});

describe("composeGlyph / withVariation", () => {
  it("composes in canonical order (variations by dimension, then states)", () => {
    expect(composeGlyph("shirt", ["color_red"], ["dirty"])).toBe("shirt.color_red.dirty");
    // colour (dim 0) before material (dim 2) regardless of input order.
    expect(composeGlyph("table", ["material_iron", "color_black"])).toBe("table.color_black.material_iron");
  });
  it("round-trips through facetsOf", () => {
    const g = composeGlyph("dress", ["color_blue"], ["dirty"]);
    const f = facetsOf(g);
    expect(composeGlyph(f.head, f.variations, f.states)).toBe(g);
  });
  it("withVariation replaces within a dimension, keeps other facets (the dye op)", () => {
    expect(withVariation("shirt.color_blue", "color_red")).toBe("shirt.color_red");
    expect(withVariation("shirt", "color_red")).toBe("shirt.color_red"); // colourless → coloured
    // dyeing keeps the dirty STATE and any other-dimension facet.
    expect(withVariation("shirt.color_blue.dirty", "color_red")).toBe("shirt.color_red.dirty");
    expect(withVariation("table.material_wood", "color_black")).toBe("table.color_black.material_wood");
  });
});

describe("appearanceOf — composed variation look", () => {
  it("colour sets hex; size multiplies scale; material sets PBR", () => {
    expect(appearanceOf("ball.color_red").hex).toBe("#DC2626");
    expect(appearanceOf("ball.big").scale).toEqual([1.7, 1.7, 1.7]);
    const iron = appearanceOf("table.material_iron");
    expect(iron.hex).toBe("#8a919c");
    expect(iron.metalness).toBeGreaterThan(0);
  });
  it("composes across facets; the dirty STATE does not affect appearance", () => {
    const a = appearanceOf("shirt.color_green.big.dirty");
    expect(a.hex).toBe("#16A34A");
    expect(a.scale).toEqual([1.7, 1.7, 1.7]);
  });
  it("no glyph / bare head → identity appearance", () => {
    expect(appearanceOf(undefined).scale).toEqual([1, 1, 1]);
    expect(appearanceOf("shirt").hex).toBeUndefined();
  });
});

describe("variantKindsOf — the generic stack-kind expansion", () => {
  it("a head with no dimension is just itself (fruit, water)", () => {
    expect(variantKindsOf("apple", [])).toEqual(["apple"]);
    expect(variantKindsOf("water", ["nope"])).toEqual(["water"]);
  });
  it("one dimension × active values (clothing colour)", () => {
    expect(variantKindsOf("shirt", ["color"], { color: ["color_red", "color_blue"] })).toEqual([
      "shirt.color_red",
      "shirt.color_blue",
    ]);
  });
  it("no active values → the whole dimension", () => {
    expect(variantKindsOf("shirt", ["color"]).length).toBe(VARIATION_DIMENSIONS.color!.values.length);
  });
  it("cartesian across multiple dimensions in canonical order", () => {
    const kinds = variantKindsOf("chair", ["color", "material"], {
      color: ["color_red"],
      material: ["material_wood", "material_iron"],
    });
    expect(kinds).toEqual(["chair.color_red.material_wood", "chair.color_red.material_iron"]);
  });
});
