// NATURAL SOURCES registry (products.ts) — the one definition of what
// plants/animals/minerals yield, what each product is FOR, and HOW it is
// acquired (live harvest vs destructive kill). Pins the registry's internal
// coherence AND the derived vocabularies the rest of the engine reads from
// it (FOOD_KINDS, SITE_MATERIAL_GLYPHS, FRUIT_TREES), so the abstract
// economy and the visible collection can never disagree.

import { describe, it, expect } from "@jest/globals";
import {
  buildingMaterialGlyphs,
  drinkGlyphs,
  foodGlyphs,
  harvestProductsOf,
  killStockOf,
  naturalSourceOf,
  naturalSources,
  orchardPlants,
  productFeedsGood,
  rollYield,
  sourceIsConsumable,
  sourcesForGood,
} from "@shared/world-engine/products.js";
import { FRUIT_TREES } from "@shared/world-engine/creatures/species.js";
import { FOOD_KINDS } from "@shared/world-engine/kernel/town/goods-kinds.js";
import { SITE_MATERIAL_GLYPHS } from "@shared/world-engine/interaction/town/founding.js";

describe("natural-sources registry — internal coherence", () => {
  it("every product is well-formed (yields, regrow, refinement rules)", () => {
    for (const s of naturalSources()) {
      expect(s.products.length).toBeGreaterThan(0);
      for (const p of s.products) {
        expect(p.glyph.length).toBeGreaterThan(0);
        expect(p.yield.min).toBeGreaterThanOrEqual(1);
        expect(p.yield.max).toBeGreaterThanOrEqual(p.yield.min);
        // A live harvest renews — it must say how fast. A kill never regrows.
        if (p.method === "harvest") expect(p.regrowDays ?? 0).toBeGreaterThan(0);
        else expect(p.regrowDays).toBeUndefined();
        // Only raws refine; every raw names its refined commodity.
        if (p.use === "raw") expect(p.refinesTo?.length ?? 0).toBeGreaterThan(0);
        else expect(p.refinesTo).toBeUndefined();
      }
    }
  });

  it("the model's canonical examples hold: wool/milk/fruit are live takes, wood/meat/stone are kills", () => {
    const methodOf = (species: string, glyph: string) =>
      naturalSourceOf(species)!.products.find((p) => p.glyph === glyph)!.method;
    expect(methodOf("sheep", "wool")).toBe("harvest");
    expect(methodOf("cow", "milk")).toBe("harvest");
    expect(methodOf("apple_tree", "apple")).toBe("harvest");
    expect(methodOf("oak", "wood")).toBe("kill");
    expect(methodOf("sheep", "meat")).toBe("kill");
    expect(methodOf("rock", "stone")).toBe("kill");
  });

  it("consumability = carrying any kill product", () => {
    expect(sourceIsConsumable(naturalSourceOf("oak")!)).toBe(true);
    expect(sourceIsConsumable(naturalSourceOf("rock")!)).toBe(true);
    // Pure-harvest sources persist when picked clean.
    expect(sourceIsConsumable(naturalSourceOf("banana_plant")!)).toBe(false);
    expect(sourceIsConsumable(naturalSourceOf("grape_vine")!)).toBe(false);
  });
});

describe("acquisition rolls", () => {
  it("rollYield spans exactly min..max, one roll each", () => {
    const p = naturalSourceOf("oak")!.products[0]!;
    expect(rollYield(p, () => 0)).toBe(p.yield.min);
    expect(rollYield(p, () => 0.999999)).toBe(p.yield.max);
  });

  it("killStockOf rolls only the kill products (the legacy wilderness stacks)", () => {
    // The stocks the scattered features held before the registry: trees
    // 2..4 wood, rocks 1..2 stone — one rng() per feature, unchanged.
    expect(killStockOf("oak", () => 0)).toEqual({ wood: 2 });
    expect(killStockOf("oak", () => 0.99)).toEqual({ wood: 4 });
    expect(killStockOf("rock", () => 0)).toEqual({ stone: 1 });
    expect(killStockOf("rock", () => 0.99)).toEqual({ stone: 2 });
    // A pure-harvest source releases nothing on a kill — there is no kill.
    expect(killStockOf("grape_vine", () => 0.5)).toEqual({});
    // Harvest products stay out of the kill stock even on mixed sources.
    expect(Object.keys(killStockOf("sheep", () => 0.5))).toEqual(["meat"]);
  });
});

describe("goods seam — sourcesForGood", () => {
  it("cloth's living source is the sheep (wool refines into it)", () => {
    const wool = naturalSourceOf("sheep")!.products[0]!;
    expect(productFeedsGood(wool, "cloth")).toBe(true);
    expect(
      sourcesForGood("cloth", { kind: "animal", method: "harvest" }).map((s) => s.species),
    ).toEqual(["sheep"]);
  });

  it("food's living plant sources are the orchard, and kill-fed animals stay out of the herd query", () => {
    expect(
      sourcesForGood("food", { kind: "plant", method: "harvest" }).map((s) => s.species),
    ).toEqual(["apple_tree", "banana_plant", "grape_vine"]);
    // Meat (a kill product) feeds food, but a HARVEST query never puts a
    // herd of it beside the farm — kill yields come from features/hunting.
    expect(sourcesForGood("food", { kind: "animal", method: "harvest" })).toEqual([]);
    expect(sourcesForGood("food", { kind: "animal" }).map((s) => s.species)).toEqual([
      "sheep",
      "cow",
    ]);
  });
});

describe("derived vocabularies — the registry IS the source of truth", () => {
  it("FOOD_KINDS = the orchard plants' harvest yields, order pinned (likes hash by index)", () => {
    expect(foodGlyphs()).toEqual(["apple", "banana", "grape"]);
    expect(FOOD_KINDS).toEqual(["apple", "banana", "grape"]);
  });

  it("SITE_MATERIAL_GLYPHS = the building-use product glyphs", () => {
    expect(buildingMaterialGlyphs()).toEqual(["wood", "stone"]);
    expect(SITE_MATERIAL_GLYPHS).toEqual(["wood", "stone"]);
  });

  it("FRUIT_TREES = the orchard mapping", () => {
    expect(orchardPlants()).toEqual([
      { fruit: "apple", species: "apple_tree" },
      { fruit: "banana", species: "banana_plant" },
      { fruit: "grape", species: "grape_vine" },
    ]);
    expect([...FRUIT_TREES]).toEqual(orchardPlants());
  });

  it("drink glyphs include the sources' drink yields (milk)", () => {
    expect(drinkGlyphs()).toContain("milk");
  });

  it("sheep still shears (harvestProductsOf)", () => {
    expect(harvestProductsOf("sheep").map((p) => p.glyph)).toEqual(["wool"]);
  });
});
