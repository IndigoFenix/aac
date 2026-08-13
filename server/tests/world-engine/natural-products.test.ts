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
  effectiveInPerOut,
  foodGlyphs,
  growthClassYield,
  harvestProductsOf,
  harvestStockOf,
  killStockOf,
  naturalSourceOf,
  naturalSources,
  orchardPlants,
  productFeedsGood,
  rollYield,
  sourceIsConsumable,
  sourceKillExhausted,
  sourcesForGood,
  takeUnitsOf,
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
        // Every RAW must refine (raw is useless until processed), and any
        // product MAY (a preservation refinement concentrates a perishable
        // — milk → cheese, resources-and-trade ③). Whoever refines does it
        // with a MASS-LOSSY ratio (①: inPerOut ≥ 1 — refining concentrates,
        // it never multiplies substance).
        if (p.use === "raw") expect(p.refinesTo).toBeDefined();
        if (p.refinesTo) {
          expect(p.refinesTo.into.length).toBeGreaterThan(0);
          expect(p.refinesTo.inPerOut).toBeGreaterThanOrEqual(1);
        }
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
    // The roll spans the DECLARED bounds, read off the catalogue rather than
    // spelled out: the yields were rescaled in phase 6 (a house is 120 blocks,
    // so a 24 m oak had to be worth more than two units of timber), and what
    // this line is about is that a kill rolls its own product's range — true
    // at any bounds. `() => 0.99` is the top of the range, not a literal count.
    const bounds = (species: string, glyph: string): { min: number; max: number } =>
      naturalSourceOf(species)!.products.find((p) => p.glyph === glyph)!.yield;
    expect(killStockOf("oak", () => 0)).toEqual({ wood: bounds("oak", "wood").min });
    expect(killStockOf("oak", () => 0.99)).toEqual({ wood: bounds("oak", "wood").max });
    expect(killStockOf("rock", () => 0)).toEqual({ stone: bounds("rock", "stone").min });
    expect(killStockOf("rock", () => 0.99)).toEqual({ stone: bounds("rock", "stone").max });
    // A pure-harvest source releases nothing on a kill — there is no kill.
    expect(killStockOf("grape_vine", () => 0.5)).toEqual({});
    // Harvest products stay out of the kill stock even on mixed sources.
    expect(Object.keys(killStockOf("sheep", () => 0.5))).toEqual(["meat"]);
  });

  it("harvestStockOf rolls only the harvest products (the standing bearing)", () => {
    expect(harvestStockOf("apple_tree", () => 0)).toEqual({ apple: 1 });
    expect(harvestStockOf("apple_tree", () => 0.99)).toEqual({ apple: 3 });
    // Kill products stay out of the bearing even on mixed sources.
    expect(Object.keys(harvestStockOf("sheep", () => 0.5))).toEqual(["wool"]);
    expect(Object.keys(harvestStockOf("cow", () => 0.5))).toEqual(["milk"]);
    // A kill-only source bears nothing live.
    expect(harvestStockOf("oak", () => 0.5)).toEqual({});
    expect(harvestStockOf("rock", () => 0.5)).toEqual({});
  });

  it("takeUnitsOf — the right tool multiplies the take; bare hands always work at one", () => {
    const oak = naturalSourceOf("oak");
    const rock = naturalSourceOf("rock");
    const has = (tools: string[]) => (g: string) => tools.includes(g);
    // Axe on wood, pick on stone (registry-declared, never engine constants).
    expect(takeUnitsOf(oak, "wood", has(["axe"]))).toBe(2);
    expect(takeUnitsOf(oak, "wood", has([]))).toBe(1);
    expect(takeUnitsOf(oak, "wood", has(["pick"]))).toBe(1); // wrong tool
    expect(takeUnitsOf(rock, "stone", has(["pick"]))).toBe(2);
    expect(takeUnitsOf(rock, "stone", has(["axe"]))).toBe(1);
    // Products with no declared tool (fruit, wool) always move one.
    expect(takeUnitsOf(naturalSourceOf("apple_tree"), "apple", has(["axe", "pick"]))).toBe(1);
    // Unknown source/glyph stays safe.
    expect(takeUnitsOf(undefined, "wood", has(["axe"]))).toBe(1);
    expect(takeUnitsOf(oak, "stone", has(["axe", "pick"]))).toBe(1);
  });

  it("sourceKillExhausted — the felling test reads KILL glyphs only", () => {
    const oak = naturalSourceOf("oak")!;
    const appleTree = naturalSourceOf("apple_tree")!;
    const banana = naturalSourceOf("banana_plant")!;
    // Wood remaining keeps the tree standing; wood gone fells it.
    expect(sourceKillExhausted(oak, { wood: 2 })).toBe(false);
    expect(sourceKillExhausted(oak, { wood: 0 })).toBe(true);
    expect(sourceKillExhausted(oak, {})).toBe(true);
    expect(sourceKillExhausted(oak, undefined)).toBe(true);
    // Hanging fruit does NOT keep a wood-emptied tree standing — the last
    // wood taken IS the felling; the fruit dies with it.
    expect(sourceKillExhausted(appleTree, { apple: 3, wood: 0 })).toBe(true);
    expect(sourceKillExhausted(appleTree, { apple: 0, wood: 1 })).toBe(false);
    // A pure-harvest source is never felled, even picked clean.
    expect(sourceKillExhausted(banana, {})).toBe(false);
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

  it("SITE_MATERIAL_GLYPHS = the building CHAIN's glyphs (phase 3)", () => {
    expect(buildingMaterialGlyphs()).toEqual(["wood", "stone"]);
    // The yard accepts the whole chain — raws AND their refined target.
    expect(SITE_MATERIAL_GLYPHS).toEqual(["wood", "block", "stone"]);
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

// ── S&D S3 H1 — THE RESOURCE-CONVERSION DIAL ────────────────────────────────
describe("the conversion dial — multiplier ① (yields × dial)", () => {
  it("rollYield: dial 1 is byte-identical (default AND explicit)", () => {
    const p = naturalSourceOf("oak")!.products[0]!;
    expect(rollYield(p, () => 0)).toBe(p.yield.min);
    expect(rollYield(p, () => 0, 1)).toBe(p.yield.min);
    expect(rollYield(p, () => 0.999999)).toBe(p.yield.max);
    expect(rollYield(p, () => 0.999999, 1)).toBe(p.yield.max);
  });

  it("rollYield: the dial scales the RANGE before rolling, one roll() call either way", () => {
    const p = naturalSourceOf("oak")!.products[0]!; // wood: 12..20
    let calls = 0;
    const roll = () => { calls++; return 0; };
    expect(rollYield(p, roll, 2)).toBe(24); // min×2
    expect(calls).toBe(1); // deterministic call count — unchanged by the dial
    const rollMax = () => 0.999999;
    expect(rollYield(p, rollMax, 2)).toBe(40); // max×2
  });

  it("killStockOf/harvestStockOf thread the SAME dial to rollYield", () => {
    expect(killStockOf("oak", () => 0, 2)).toEqual({ wood: 24 });
    expect(killStockOf("oak", () => 0, 1)).toEqual({ wood: 12 });
    expect(harvestStockOf("apple_tree", () => 0, 3)).toEqual({ apple: 3 }); // min 1 × 3
  });
});

describe("effectiveInPerOut — multiplier ② (bills ÷ dial)", () => {
  it("dial 1 is byte-identical", () => {
    expect(effectiveInPerOut(2)).toBe(2);
    expect(effectiveInPerOut(2, 1)).toBe(2);
  });

  it("scales down with the dial, floored at 1 raw unit (never free)", () => {
    expect(effectiveInPerOut(2, 2)).toBe(1);
    expect(effectiveInPerOut(10, 4)).toBe(3); // round(10/4) = round(2.5) = 3 (JS rounds .5 up)
    expect(effectiveInPerOut(2, 1000)).toBe(1); // floored, never 0
  });

  it("below 1 the bill grows — the same paired direction as rollYield's ×dial", () => {
    expect(effectiveInPerOut(2, 0.5)).toBe(4);
  });
});

describe("S&D S3 H2 — the growth clock (wood-bearing species only)", () => {
  it("oak and apple_tree declare growth; every other species does not", () => {
    expect(naturalSourceOf("oak")!.growth).toBeDefined();
    expect(naturalSourceOf("apple_tree")!.growth).toBeDefined();
    for (const s of ["rock", "sheep", "cow", "banana_plant", "grape_vine"]) {
      expect(naturalSourceOf(s)!.growth).toBeUndefined();
    }
  });

  it("growth classes: sapling yields NOTHING, the LAST class is the catalogue's own mature anchor", () => {
    for (const species of ["oak", "apple_tree"]) {
      const src = naturalSourceOf(species)!;
      const g = src.growth!;
      expect(g.classes[0]!.yieldMul).toBe(0);
      expect(g.classes[g.classes.length - 1]!.yieldMul).toBe(1);
      expect(g.maturityYears).toBeGreaterThan(0);
    }
  });

  it("growthClassYield: dial 1, mature class (mul 1) reproduces the yield MIDPOINT, deterministically", () => {
    const p = naturalSourceOf("oak")!.products[0]!; // wood 12..20, mid 16
    expect(growthClassYield(p, 1)).toBe(16);
    expect(growthClassYield(p, 1, 1)).toBe(16);
    expect(growthClassYield(p, 0)).toBe(0); // sapling
    expect(growthClassYield(p, 0.25)).toBe(4); // young: round(16 × 0.25)
  });

  it("growthClassYield: the SAME ×dial direction as rollYield, no RNG (repeatable)", () => {
    const p = naturalSourceOf("oak")!.products[0]!;
    expect(growthClassYield(p, 1, 2)).toBe(32);
    expect(growthClassYield(p, 1, 2)).toBe(growthClassYield(p, 1, 2)); // pure
  });
});
