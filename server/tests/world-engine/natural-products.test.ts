// NATURAL SOURCES registry (products.ts) — the one definition of what
// plants/animals/minerals yield, what each product is FOR, and HOW it is
// acquired (live harvest vs destructive kill). Pins the registry's internal
// coherence AND the derived vocabularies the rest of the engine reads from
// it (FOOD_KINDS, SITE_MATERIAL_GLYPHS, foodPlants), so the abstract
// economy and the visible collection can never disagree.

import { describe, it, expect, beforeAll } from "@jest/globals";
import {
  band,
  buildingMaterialGlyphs,
  drinkGlyphs,
  effectiveInPerOut,
  foodGlyphs,
  glyphTakeableFrom,
  growthClassYield,
  harvestProductsOf,
  harvestStockOf,
  bodyStockOf,
  naturalSourceOf,
  naturalSources,
  nicheSuitabilityOf,
  foodPlants,
  productFeedsGood,
  registerNaturalSource,
  rollYield,
  sourceDepletes,
  sourceIsConsumable,
  sourceIsCuttable,
  sourceSpent,
  sourceSuitabilityAt,
  sourcesForGood,
  takeUnitsOf,
  usefulPlants,
  type ClimateSample,
  type NaturalSource,
} from "@shared/world-engine/products.js";
import {
  band as ecologyBand,
  climateSampleAt,
  GRASS,
  HORSE,
} from "@shared/world-engine/planet/ecology.js";
import type { CellGrid } from "@shared/world-engine/kernel/cells/index.js";
import { getSpecies } from "@shared/world-engine/creatures/species.js";
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

  it("the model's canonical examples hold, across ALL THREE methods", () => {
    // ⚖️ THREE, not two, since 2026-09-02 (user ruling). `harvest` takes what
    // a source BEARS; `kill` is all-or-nothing and needs the killing act;
    // `deplete` takes from the object itself, diminishing it, and ends it when
    // it is exhausted — the outcrop, and moss-like growers after it.
    const methodOf = (species: string, glyph: string) =>
      naturalSourceOf(species)!.products.find((p) => p.glyph === glyph)!.method;
    expect(methodOf("sheep", "wool")).toBe("harvest");
    expect(methodOf("cow", "milk")).toBe("harvest");
    expect(methodOf("apple_tree", "apple")).toBe("harvest");
    expect(methodOf("oak", "wood")).toBe("kill");
    expect(methodOf("sheep", "meat")).toBe("kill");
    // 🚨 STONE MOVED. It was `kill`, and that is exactly what made every tree
    // behave like an outcrop — quarried a unit at a time until it silently
    // vanished. The shrink-as-you-take path is this method's and no other's.
    expect(methodOf("rock", "stone")).toBe("deplete");
  });

  it("consumability = carrying any product made of the source's own substance", () => {
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

  it("bodyStockOf rolls only the kill products (the legacy wilderness stacks)", () => {
    // The roll spans the DECLARED bounds, read off the catalogue rather than
    // spelled out: the yields were rescaled in phase 6 (a house is 120 blocks,
    // so a 24 m oak had to be worth more than two units of timber), and what
    // this line is about is that a kill rolls its own product's range — true
    // at any bounds. `() => 0.99` is the top of the range, not a literal count.
    const bounds = (species: string, glyph: string): { min: number; max: number } =>
      naturalSourceOf(species)!.products.find((p) => p.glyph === glyph)!.yield;
    expect(bodyStockOf("oak", () => 0)).toEqual({ wood: bounds("oak", "wood").min });
    expect(bodyStockOf("oak", () => 0.99)).toEqual({ wood: bounds("oak", "wood").max });
    expect(bodyStockOf("rock", () => 0)).toEqual({ stone: bounds("rock", "stone").min });
    expect(bodyStockOf("rock", () => 0.99)).toEqual({ stone: bounds("rock", "stone").max });
    // A pure-harvest source releases nothing on a kill — there is no kill.
    expect(bodyStockOf("grape_vine", () => 0.5)).toEqual({});
    // Harvest products stay out of the kill stock even on mixed sources.
    expect(Object.keys(bodyStockOf("sheep", () => 0.5))).toEqual(["meat"]);
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

  it("sourceSpent — the felling test reads KILL glyphs only", () => {
    const oak = naturalSourceOf("oak")!;
    const appleTree = naturalSourceOf("apple_tree")!;
    const banana = naturalSourceOf("banana_plant")!;
    // Wood remaining keeps the tree standing; wood gone fells it.
    expect(sourceSpent(oak, { wood: 2 })).toBe(false);
    expect(sourceSpent(oak, { wood: 0 })).toBe(true);
    expect(sourceSpent(oak, {})).toBe(true);
    expect(sourceSpent(oak, undefined)).toBe(true);
    // Hanging fruit does NOT keep a wood-emptied tree standing — the last
    // wood taken IS the felling; the fruit dies with it.
    expect(sourceSpent(appleTree, { apple: 3, wood: 0 })).toBe(true);
    expect(sourceSpent(appleTree, { apple: 0, wood: 1 })).toBe(false);
    // A pure-harvest source is never felled, even picked clean.
    expect(sourceSpent(banana, {})).toBe(false);
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
      // 🥕 …and the first VEGETABLE (food-scale-round E-a), appended last.
      // 🌿 …then the WILD LARDER (2026-09-04): the four FORAGE plants a settler
      // eats off the land. They are living plant sources of food by exactly the
      // same property the four cultivars are, so a query over that property has
      // to return them — the split that matters (found vs planted) is rarity
      // and niche, never a second list.
    ).toEqual([
      "apple_tree", "banana_plant", "grape_vine", "carrot_plant",
      "bush", "hazel", "wild_onion",
    ]);
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
    // 🥕 CARROT IS APPENDED, NEVER INSERTED (food-scale-round E-a): the food
    // vocabulary was three fruits and no vegetable, so "farmland" had no crop
    // behind it. Residents' and pets' favourite foods hash BY INDEX into this
    // list, so a new food species may only ever land at the END — apple,
    // banana and grape keep index 0/1/2 and nobody's likes re-roll.
    // 🌿 …and the WILD LARDER (2026-09-04) obeyed the same law: berry, nut
    // and onion are APPENDED (the mushroom was dropped — its standing body IS
    // its picked body, see products.ts), so apple/banana/grape/carrot keep
    // indices 0–3. (The LENGTH still moves, and with it the hash of any cast
    // that does not author its own `likes` — unavoidable the moment the world
    // grows a new food, and the reason the order clause is the part that is
    // pinned.)
    expect(foodGlyphs()).toEqual([
      "apple", "banana", "grape", "carrot", "berry", "nut", "onion",
    ]);
    expect(FOOD_KINDS).toEqual([
      "apple", "banana", "grape", "carrot", "berry", "nut", "onion",
    ]);
    expect(FOOD_KINDS.slice(0, 4)).toEqual(["apple", "banana", "grape", "carrot"]);
  });

  it("SITE_MATERIAL_GLYPHS = the building CHAIN's glyphs (phase 3)", () => {
    expect(buildingMaterialGlyphs()).toEqual(["wood", "stone"]);
    // The yard accepts the whole chain — raws AND their refined target.
    expect(SITE_MATERIAL_GLYPHS).toEqual(["wood", "block", "stone"]);
  });

  it("every catalogue species has a real body in the species registry", () => {
    // The seam this pins: the CATALOGUE names a species, the species registry
    // builds its blueprint from a worked example at module load — but nothing
    // joined the two, so a catalogue row could name a species that does not
    // exist and every consumer of foodPlants() would receive an
    // id that getSpecies() cannot resolve (found live 2026-08-16: carrot_plant
    // shipped with only the `carrot` FRUIT body, no plant).
    // Minerals are exempt: a rock is a standing FEATURE (`feature:` on the
    // row), never a grown body, so it has no registry entry by design.
    const grown = naturalSources().filter((src) => src.kind !== "mineral");
    const missing = grown.filter((src) => !getSpecies(src.species)).map((src) => src.species);
    expect(missing).toEqual([]);
    for (const src of grown) {
      // Catalogue "animal" is registry "creature"; plants match by name.
      const want = src.kind === "animal" ? "creature" : src.kind;
      expect(getSpecies(src.species)!.kind).toBe(want);
    }
  });

  it("foodPlants() = every plant bearing a harvestable food, derived", () => {
    // A PROPERTY query, so a new food plant joins by existing — the carrot row
    // needed no edit here and no second list updated. It used to be called
    // `foodPlants()` against a hand-kept `OrchardFruit` union, which is how
    // a carrot ended up in the orchard.
    expect(foodPlants()).toEqual([
      { food: "apple", species: "apple_tree" },
      { food: "banana", species: "banana_plant" },
      { food: "grape", species: "grape_vine" },
      { food: "carrot", species: "carrot_plant" },
      // 🌿 The wild larder joined by EXISTING, exactly as the carrot did — no
      // edit to this query and no second list anywhere.
      { food: "berry", species: "bush" },
      { food: "nut", species: "hazel" },
      { food: "onion", species: "wild_onion" },
    ]);
  });

  it("is exactly the catalogue's own food-harvest rows — it owns no list", () => {
    // The point of the rename: the answer must be RE-DERIVABLE from the
    // catalogue by anyone, with no privileged knowledge held here.
    const expected = naturalSources()
      .filter((s) => s.kind === "plant")
      .flatMap((s) => s.products
        .filter((p) => p.use === "food" && p.method === "harvest")
        .map((p) => ({ food: p.glyph, species: s.species })));
    expect(foodPlants()).toEqual(expected);
    // …and its glyphs are the food glyphs, from the same rows.
    expect(foodPlants().map((r) => r.food)).toEqual(foodGlyphs());
  });

  it("drink glyphs include the sources' drink yields (milk)", () => {
    expect(drinkGlyphs()).toContain("milk");
  });

  it("sheep still shears (harvestProductsOf)", () => {
    expect(harvestProductsOf("sheep").map((p) => p.glyph)).toEqual(["wool"]);
  });
});

// ── THE NICHE JOIN (2026-09-01) ─────────────────────────────────────────────
// Two registries used to describe plants: the catalogue said what a plant
// YIELDS, planet/ecology.ts said where a species LIVES, and nothing joined
// them — so the scatter sites picked a bearer by seed alone and stood bananas
// on cold homesteads. The join is that both now read ONE niche vocabulary
// (products.ts owns `Tolerance`/`band`/`SpeciesNiche`; ecology re-exports),
// so a catalogue niche calibrated against TREE/GRASS means what the biosphere
// means by it. What is pinned here: every grower's-query plant declares a
// niche, the windows separate the plants they are supposed to separate, and
// the filter is a SUBSET of the unfiltered list — never a re-ordering, never
// a species the catalogue does not carry.

/** The samples are ecology-field units: rain ~0..1.3, tempC °C, elevation in
 *  height units above sea, fertility 0..15 (ecology.ts SpeciesDef.niche). */
const TEMPERATE_FOREST: ClimateSample = { rain: 1.0, tempC: 18, elevation: 0, fertility: 5 };
const TROPICAL: ClimateSample = { rain: 1.1, tempC: 27, elevation: 0, fertility: 5 };
const STEPPE: ClimateSample = { rain: 0.5, tempC: 16, elevation: 0, fertility: 5 };
/** Hostile on EVERY axis at once — dry, frozen, high and barren. */
const DEAD_SCREE: ClimateSample = { rain: 0.05, tempC: -20, elevation: 100, fertility: 0 };

const speciesAt = (c?: ClimateSample): string[] => usefulPlants(c).map((s) => s.species);

describe("the niche join — usefulPlants(climate)", () => {
  it("every plant worth growing declares a niche (the drift pin)", () => {
    // A new bearer row cannot silently grow EVERYWHERE: absent niche means
    // indifferent (band(v, undefined) = 1), which is the right default for a
    // mineral and the wrong one for a crop. Whoever adds the fibre plant has
    // to say where it lives.
    const undeclared = usefulPlants().filter((s) => !s.niche).map((s) => s.species);
    expect(undeclared).toEqual([]);
  });

  it("named for the property, not one use: the grower's query is HARVEST-bearing plants", () => {
    // Not "food plants" — the property that makes a plant worth putting in
    // the ground is the LIVE renewable take. Today's four harvest-bearing
    // plants happen to be the four food plants, which is a coincidence of
    // content, not the definition: every food bearer must appear, and the
    // query is derived from the catalogue with no list of its own.
    const derived = naturalSources()
      .filter((s) => s.kind === "plant" && s.products.some((p) => p.method === "harvest"))
      .map((s) => s.species);
    expect(speciesAt()).toEqual(derived);
    for (const r of foodPlants()) expect(speciesAt()).toContain(r.species);
    // Rows, not a derived list — a caller reads the plant's real products.
    expect(usefulPlants()[0]!.products.some((p) => p.method === "harvest")).toBe(true);
  });

  it("temperate forest bears apples and carrots — never a banana", () => {
    const here = speciesAt(TEMPERATE_FOREST);
    expect(here).toContain("apple_tree");
    expect(here).toContain("carrot_plant");
    // THE HEADLINE CASE: banana_plant's tempC floor (19 °C) is what the whole
    // join exists to enforce — an 18 °C mean does not carry one.
    expect(here).not.toContain("banana_plant");
  });

  it("the tropics bear bananas — never an apple (the window closes both ways)", () => {
    const here = speciesAt(TROPICAL);
    expect(here).toContain("banana_plant");
    // A filter that only ever REMOVED cold-climate misfits would be half a
    // join: the apple's 25 °C ceiling has to bite at 27 °C too.
    expect(here).not.toContain("apple_tree");
  });

  it("the dry steppe middle bears the vine and the root crop", () => {
    const here = speciesAt(STEPPE);
    expect(here).toContain("grape_vine");
    expect(here).toContain("carrot_plant");
  });

  it("no fruitless growing biome — every real climate carries at least one bearer", () => {
    // The carrot's generalist window is what holds this: a founding that can
    // grow anything at all can always plant something.
    for (const c of [TEMPERATE_FOREST, TROPICAL, STEPPE]) {
      expect(usefulPlants(c).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("the filtered list is a SUBSET in catalogue order, and hostile ground yields nothing", () => {
    const all = speciesAt();
    for (const c of [TEMPERATE_FOREST, TROPICAL, STEPPE]) {
      const here = speciesAt(c);
      expect(all.filter((s) => here.includes(s))).toEqual(here); // subset, order kept
    }
    // Dry AND frozen AND high AND barren: zero on any axis is zero overall,
    // and EMPTY IS AN ANSWER — the caller plants nothing, it does not fall
    // back to the unfiltered list.
    expect(speciesAt(DEAD_SCREE)).toEqual([]);
  });

  it("nicheSuitabilityOf: no niche = indifferent everywhere; a breached bound = 0", () => {
    // A mineral declares no niche, so it is placeable anywhere — the rock
    // outcrop must not need a climate to exist.
    expect(nicheSuitabilityOf(naturalSourceOf("rock")!, DEAD_SCREE)).toBe(1);
    expect(nicheSuitabilityOf(naturalSourceOf("banana_plant")!, TROPICAL)).toBeGreaterThan(0);
    expect(nicheSuitabilityOf(naturalSourceOf("banana_plant")!, TEMPERATE_FOREST)).toBe(0);
  });

  // ── SUITABILITY-AS-YIELD (2026-09-01) ─────────────────────────────────────
  // The niche stopped being only a membership filter: `sourceSuitabilityAt` is
  // the ONE bridge both cultivated seats multiply by (the live farm region's
  // output cap in quest-host, and the farm process's `efficiency` in the
  // books), so a site's ground quality reaches the visible field and the
  // abstract field as the same number. What is pinned here is the bridge's
  // contract — the two absences answer 1, a breached bound answers 0 — and the
  // carrot's new fertility band, which is what makes soil matter at all.
  it("the bridge: no climate ⇒ 1, no catalogue row ⇒ 1 (both absences are 'indifferent')", () => {
    // NO CLIMATE — a preset town, a flat pad, a charter-only founding. Not
    // "unknown, assume the worst": a seat with nothing to read must stay
    // byte-identical to the pre-niche world.
    expect(sourceSuitabilityAt("carrot_plant")).toBe(1);
    expect(sourceSuitabilityAt("banana_plant")).toBe(1);
    // …even for a species that would score 0 if it HAD been asked.
    expect(nicheSuitabilityOf(naturalSourceOf("banana_plant")!, DEAD_SCREE)).toBe(0);
    expect(sourceSuitabilityAt("banana_plant", undefined)).toBe(1);
    // NO CATALOGUE ROW — no row means no niche, and no niche already means
    // indifferent everywhere. A game's own crop that never registered a source
    // must not silently starve its town.
    expect(sourceSuitabilityAt("no_such_plant", TEMPERATE_FOREST)).toBe(1);
    expect(sourceSuitabilityAt("no_such_plant", DEAD_SCREE)).toBe(1);
    // With both in hand it IS `nicheSuitabilityOf`, and nothing else.
    for (const c of [TEMPERATE_FOREST, TROPICAL, STEPPE, DEAD_SCREE]) {
      for (const s of ["carrot_plant", "apple_tree", "grape_vine", "rock"]) {
        expect(sourceSuitabilityAt(s, c)).toBe(nicheSuitabilityOf(naturalSourceOf(s)!, c));
      }
    }
  });

  it("🥕 soil matters: barren ground grows no root crop, decent ground grows a full one", () => {
    const at = (fertility: number): number =>
      sourceSuitabilityAt("carrot_plant", { ...STEPPE, fertility });
    // fertility 0 is the SUBSTRATE'S OWN verdict (climate.ts writes 0 on sea,
    // ice cap, above the treeline, bare stone and true desert) — a farm there
    // stands barren, and this is the seat that says so.
    expect(at(0)).toBe(0);
    // The `lo` bound is where the cosine REACHES zero, not where it starts —
    // so the very poorest soil the substrate still calls arable grows nothing
    // either, and the curve climbs from just above it.
    expect(at(1)).toBe(0);
    // …and above that it is a MULTIPLIER, never a gate: thin soil still grows
    // something, badly.
    expect(at(2)).toBeGreaterThan(0);
    expect(at(2)).toBeLessThan(at(4));
    expect(at(4)).toBeLessThan(at(6));
    // The standard fert-5 samples this suite has always used are UNCHANGED in
    // MEMBERSHIP (the carrot is still admitted everywhere it was) and score a
    // partial yield, which is the whole point of a multiplier: the fertility
    // FACTOR at 5 is cos-eased three quarters of the way up the 1→7 window,
    // whatever the rest of the sample says.
    for (const c of [TEMPERATE_FOREST, STEPPE]) {
      expect(speciesAt(c)).toContain("carrot_plant");
      expect(c.fertility).toBe(5); // the sample this suite has always used
      const full = sourceSuitabilityAt("carrot_plant", { ...c, fertility: 7 });
      expect(sourceSuitabilityAt("carrot_plant", c) / full).toBeCloseTo(0.75, 10);
    }
    // Past the optimum there is no ceiling — river-rich land (15) is not
    // penalized for being rich (one-sided `band`), so every rung from the
    // optimum up scores identically. (STEPPE's own rain/tempC still ride in;
    // what is pinned is that FERTILITY stops contributing above 7.)
    expect(at(12)).toBe(at(7));
    expect(at(15)).toBe(at(7));
    expect(at(7)).toBe(band(0.5, { lo: 0.2, opt: 0.6 }) * band(16, { lo: -5, opt: 14, hi: 31 }));
  });

  it("band() answers from its new home — ecology re-exports the SAME function", () => {
    // The move is only safe because there is exactly one band() left: the
    // planet biosphere and the catalogue must evaluate a window identically.
    expect(band).toBe(ecologyBand);
    expect(band(5, undefined)).toBe(1);
    expect(band(5, { lo: 0, opt: 5, hi: 10 })).toBe(1); // at the optimum
    expect(band(11, { lo: 0, opt: 5, hi: 10 })).toBe(0); // past the bound
  });

  it("climateSampleAt reads a cell the way ecologyFields does (and refuses raw ground)", () => {
    // Only grid.fields is read, so a field bag stands in for a substrate.
    const grid = (fields: Record<string, Float64Array>): CellGrid =>
      ({ fields }) as unknown as CellGrid;
    const climated = grid({
      height: Float64Array.from([3, 9]),
      rain: Float64Array.from([0.4, 1.0]),
      tempC: Float64Array.from([2, 18]),
      fertility: Float64Array.from([1, 5]),
    });
    // Elevation is height ABOVE the sea line, floored at 0 — ecologyFields'
    // own reading, so both answers describe the same cell. ⛏️ `ore` joined the
    // sample in the same shape as `fertility` (2026-09-01): always PRESENT,
    // answering 0 on a substrate that carries no ore field, so a caller never
    // has to ask which axes this particular grid happened to have.
    expect(climateSampleAt(climated, 0)).toEqual({ rain: 0.4, tempC: 2, elevation: 0, fertility: 1, ore: 0 });
    expect(climateSampleAt(climated, 1)).toEqual({ rain: 1.0, tempC: 18, elevation: 6, fertility: 5, ore: 0 });
    // A substrate with no fertility field answers 0, not undefined.
    const noFert = grid({
      height: Float64Array.from([9]),
      rain: Float64Array.from([1]),
      tempC: Float64Array.from([18]),
    });
    expect(climateSampleAt(noFert, 0).fertility).toBe(0);
    expect(climateSampleAt(noFert, 0).ore).toBe(0);
    // …and a substrate that DOES carry the geology field reads it straight
    // through, in the field's own 0..15 units (worldgen writes; runtime only
    // depletes) — the one honest way a lode-bound niche gets its number.
    const withOre = grid({
      height: Float64Array.from([9, 9]),
      rain: Float64Array.from([1, 1]),
      tempC: Float64Array.from([18, 18]),
      ore: Float64Array.from([0, 12]),
    });
    expect(climateSampleAt(withOre, 0).ore).toBe(0);
    expect(climateSampleAt(withOre, 1).ore).toBe(12);
    // Un-climated ground is an ERROR, never a silent zero sample: a zeroed
    // sample reads as a frozen desert and would empty every scatter.
    expect(() => climateSampleAt(grid({ height: Float64Array.from([9]) }), 0)).toThrow(/applyClimate/);
  });
});

// ── ⛏️ LAYER-1 COMPLETION (2026-09-01) — ONE ANSWER FOR EVERY SOURCE ────────
// The niche join landed with two holes in it: minerals had no axis to declare
// (the substrate's ore field was invisible to the catalogue) and the two
// livestock rows declared nothing at all, so `nicheSuitabilityOf` answered 1
// for them EVERYWHERE and a scatter site's "wild flocks" could stand cattle on
// a frozen steppe. Both close here, and they close the same way: one more band
// in the one product, no new query, no per-kind machinery. What is pinned: the
// ore band behaves exactly like every other band, an ore-LESS sample still
// answers (every pre-geology caller is untouched), and the sheep/cow windows
// tell the ecological story they were calibrated against GRASS/HORSE to tell.

describe("the ore axis — minerals' analogue of rain", () => {
  /** THE FUTURE SCARCE MINERAL, constructed here rather than added to the
   *  catalogue: the axis has to work before a row needs it, and a test row in
   *  CATALOGUE order would re-roll every resident's likes hash (FOOD_KINDS is
   *  index-hashed — the carrot row's own law). `rock` stays nicheless on
   *  purpose; this is what a row that ISN'T substrate looks like. */
  const tinLode: NaturalSource = {
    species: "tin_lode_test",
    kind: "mineral",
    niche: { ore: { lo: 4, opt: 10 } },
    products: [{
      glyph: "tin", use: "raw", refinesTo: { into: "bronze", inPerOut: 2 },
      method: "kill", yield: { min: 1, max: 2 },
    }],
  };
  /** The steppe sample with a geology reading bolted on — only the ore axis
   *  moves, so every number below is the ore band and nothing else. */
  const withOre = (ore: number): ClimateSample => ({ ...STEPPE, ore });

  it("bands to 0 below the floor and 1 at the optimum, exactly like rain or tempC", () => {
    expect(nicheSuitabilityOf(tinLode, withOre(0))).toBe(0);
    expect(nicheSuitabilityOf(tinLode, withOre(3))).toBe(0);
    // AT the floor is the shoulder's own zero — a bound is a bound on every
    // axis, which is what makes `> 0` mean "lives here" uniformly.
    expect(nicheSuitabilityOf(tinLode, withOre(4))).toBe(0);
    expect(nicheSuitabilityOf(tinLode, withOre(10))).toBe(1);
    // Between floor and optimum the cosine shoulder rises, never jumps.
    const mid = nicheSuitabilityOf(tinLode, withOre(7));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // One-sided at the rich end (no `hi`): richer ground is simply fine.
    expect(nicheSuitabilityOf(tinLode, withOre(15))).toBe(1);
  });

  it("a sample with NO ore reads as barren ground for a lode-bound row, not as a free pass", () => {
    // `?? 0` — absent means zero ore, because a substrate carrying no ore
    // field carries no exposed metal. The alternative (absent ⇒ indifferent)
    // would put a tin mine on every pre-geology test world.
    expect(STEPPE.ore).toBeUndefined();
    expect(nicheSuitabilityOf(tinLode, STEPPE)).toBe(0);
  });

  it("BACKWARD COMPATIBLE: a source with no ore window ignores the axis entirely", () => {
    // The #46 samples above declare no `ore` and are used UNMODIFIED — every
    // pre-geology answer has to survive the new band verbatim.
    for (const c of [TEMPERATE_FOREST, TROPICAL, STEPPE, DEAD_SCREE]) {
      const rich: ClimateSample = { ...c, ore: 15 };
      const poor: ClimateSample = { ...c, ore: 0 };
      for (const species of ["apple_tree", "banana_plant", "grape_vine", "carrot_plant", "rock"]) {
        const src = naturalSourceOf(species)!;
        expect(nicheSuitabilityOf(src, rich)).toBe(nicheSuitabilityOf(src, c));
        expect(nicheSuitabilityOf(src, poor)).toBe(nicheSuitabilityOf(src, c));
      }
    }
    // …and the grower's query, which is a filter over the same number, is
    // likewise unmoved by a geology reading.
    expect(speciesAt({ ...TEMPERATE_FOREST, ore: 15 })).toEqual(speciesAt(TEMPERATE_FOREST));
  });

  it("rock is NICHELESS ON PURPOSE — stone is substrate, and it does not freeze", () => {
    // Suitability 1 on the most hostile sample the suite has, ore-poor and
    // ore-rich alike: the ore FIELD is metal richness, not stone presence, so
    // an outcrop on dead scree is exactly where stone is easiest to take.
    const rock = naturalSourceOf("rock")!;
    expect(rock.niche).toBeUndefined();
    expect(nicheSuitabilityOf(rock, DEAD_SCREE)).toBe(1);
    expect(nicheSuitabilityOf(rock, { ...DEAD_SCREE, ore: 0 })).toBe(1);
    expect(nicheSuitabilityOf(rock, { ...DEAD_SCREE, ore: 15 })).toBe(1);
  });
});

describe("the livestock niches — the hardy flock and the lush-pasture herd", () => {
  const sheep = (): NaturalSource => naturalSourceOf("sheep")!;
  const cow = (): NaturalSource => naturalSourceOf("cow")!;
  /** A cold dry grassland — the case the whole animal filter exists for. */
  const FRIGID_DRY: ClimateSample = { rain: 0.3, tempC: -8, elevation: 0, fertility: 5 };

  it("both livestock rows declare a niche (the drift pin, animal side)", () => {
    // Before this round they declared none, so `nicheSuitabilityOf` answered 1
    // for them on ice, in a desert and at 4000 m alike — the one gap that made
    // "one uniform answer for every source" untrue.
    for (const src of naturalSources().filter((s) => s.kind === "animal")) {
      expect(src.niche).toBeDefined();
    }
  });

  it("the steppe middle suits BOTH — the shared ground the calibration must keep", () => {
    expect(nicheSuitabilityOf(sheep(), STEPPE)).toBeGreaterThan(0);
    expect(nicheSuitabilityOf(cow(), STEPPE)).toBeGreaterThan(0);
  });

  it("🎯 a frigid dry steppe keeps the flock and EXCLUDES the herd", () => {
    // THE HEADLINE CASE, the animal counterpart of the banana: cattle stop at
    // GRASS's own −2 °C floor because that is where the pasture stops; sheep
    // carry on to −12. The two rows must not be the same row.
    expect(nicheSuitabilityOf(sheep(), FRIGID_DRY)).toBeGreaterThan(0);
    expect(nicheSuitabilityOf(cow(), FRIGID_DRY)).toBe(0);
  });

  it("truly hostile ground carries NEITHER", () => {
    // Dry AND frozen AND high AND barren — a window that let a grazer through
    // here would not be a window.
    expect(nicheSuitabilityOf(sheep(), DEAD_SCREE)).toBe(0);
    expect(nicheSuitabilityOf(cow(), DEAD_SCREE)).toBe(0);
  });

  it("the WARM end is not an exclusion — both graze the tropics, thinly", () => {
    // A filter that only ever removed things would be half a calibration. The
    // hot-wet sample is admitted by both (marginally: near the wet and warm
    // shoulders of each), and "marginal" is a real answer now that the pick is
    // suitability-WEIGHTED rather than uniform.
    expect(nicheSuitabilityOf(sheep(), TROPICAL)).toBeGreaterThan(0);
    expect(nicheSuitabilityOf(cow(), TROPICAL)).toBeGreaterThan(0);
    expect(nicheSuitabilityOf(sheep(), TROPICAL)).toBeLessThan(nicheSuitabilityOf(sheep(), STEPPE));
    expect(nicheSuitabilityOf(cow(), TROPICAL)).toBeLessThan(nicheSuitabilityOf(cow(), STEPPE));
  });

  it("the two windows are genuinely different windows (the story, read off the data)", () => {
    const s = sheep().niche!;
    const c = cow().niche!;
    // Sheep is the DRIER and COLDER row at every floor it declares…
    expect(s.rain!.lo!).toBeLessThan(c.rain!.lo!);
    expect(s.tempC!.lo!).toBeLessThan(c.tempC!.lo!);
    // …cow's whole moisture window sits WET of it (a real sward, not scrub)…
    expect(c.rain!.opt).toBeGreaterThan(s.rain!.opt);
    // …and elevation is the axis sheep deliberately leaves OPEN: the mountain
    // is where the flock beats everything, so declaring a ceiling there would
    // state the opposite of the row's story.
    expect(s.elevation).toBeUndefined();
    expect(c.elevation!.hi!).toBeGreaterThan(0);
    // Neither is lode-bound — livestock has no opinion about the geology axis.
    expect(s.ore).toBeUndefined();
    expect(c.ore).toBeUndefined();
  });

  it("calibrated against the sward they eat: GRASS/HORSE are the reference rows", () => {
    // The catalogue niche is only meaningful because it is evaluated by the
    // SAME band() the biosphere runs — so the numbers are stated relative to
    // the species whose grass these animals are standing in.
    expect(sheep().niche!.rain!.lo!).toBeLessThan(GRASS.niche.rain!.lo!);   // rough hill grazing
    expect(sheep().niche!.tempC!.lo!).toBeLessThan(HORSE.niche.tempC!.lo!); // hardier than the grazer
    expect(cow().niche!.tempC!.lo!).toBe(GRASS.niche.tempC!.lo!);           // stops where pasture stops
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

  it("bodyStockOf/harvestStockOf thread the SAME dial to rollYield", () => {
    expect(bodyStockOf("oak", () => 0, 2)).toEqual({ wood: 24 });
    expect(bodyStockOf("oak", () => 0, 1)).toEqual({ wood: 12 });
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

// ── ⚖️ THE FELL-FIRST GATE — WHOM IT BINDS, AND WHY IT NEEDS A REMEDY ───────
//
// User ruling 2026-09-02: a kill product comes off a body only once that body
// is down. The gate has exactly ONE key — `downed` — and `downed` is a state
// only a wilderness FEATURE can reach, through the one cut. Bind anything else
// with it and the result is a refusal whose remedy does not exist.
//
// 🚨 WHICH IS WHAT HAPPENED TO A SHEEP. `wildSourceOf` covers features AND
// product animals, so the session reader answered "cut it down first" for a
// living sheep's meat; `cutWildFeature` is features-only, so there was no cut
// button, no cut act, and no way for the player to ever reach it — while the
// automated draw, which cuts what it cannot take and whose cut on a creature is
// a silent no-op, went on drawing meat off the living animal. Two paths, two
// answers, one unreachable good. The gate is now stated for downable bodies
// only, at the ONE predicate both paths read.

describe("the fell-first gate binds DOWNABLE bodies only", () => {
  it("a standing tree keeps its timber; a felled one gives it up", () => {
    const oak = naturalSourceOf("oak")!;
    expect(glyphTakeableFrom(oak, "wood", false)).toBe(false);
    expect(glyphTakeableFrom(oak, "wood", true)).toBe(true);
    // Its BEARING is never gated, standing or down.
    const apple = naturalSourceOf("apple_tree")!;
    expect(glyphTakeableFrom(apple, "apple", false)).toBe(true);
    expect(glyphTakeableFrom(apple, "apple", true)).toBe(true);
  });

  it("🚨 a LIVING ANIMAL's own substance stays takeable — nothing can down it", () => {
    // THE REGRESSION THIS BLOCK EXISTS FOR. Meat was obtainable before the
    // fell-first gate landed (the take drained the stock and the body went with
    // the last unit, which is the kill distributed over acts) and it is
    // obtainable again. `sourceSpent` still retires the body at zero, so
    // nothing about the ENDING changed — only who may reach the first unit.
    for (const species of ["sheep", "cow"]) {
      const src = naturalSourceOf(species)!;
      expect(src.kind).toBe("animal");
      expect(glyphTakeableFrom(src, "meat", false)).toBe(true);
    }
    // …and the live takes it always had are untouched.
    expect(glyphTakeableFrom(naturalSourceOf("sheep")!, "wool", false)).toBe(true);
    expect(glyphTakeableFrom(naturalSourceOf("cow")!, "milk", false)).toBe(true);
  });

  it("an ANIMAL is not CUTTABLE either — the two halves of the law agree", () => {
    // *"'fight the sheep' must never mean 'uproot the sheep'"*. If the gate
    // exempts a creature but the cut still claimed it, the board would offer a
    // button for an act the wilderness cannot perform on a body at all.
    expect(sourceIsCuttable("sheep", undefined)).toBe(false);
    expect(sourceIsCuttable("cow", undefined)).toBe(false);
  });

  it("a depleting outcrop is never gated — taking IS how stone is got", () => {
    expect(glyphTakeableFrom(naturalSourceOf("rock")!, "stone", false)).toBe(true);
    expect(sourceIsCuttable("rock", undefined)).toBe(false); // its ending is the wearing away
  });

  it("⚖️ NO REFUSAL WITHOUT A REMEDY — everything the gate holds back can be CUT", () => {
    // The invariant the sheep broke, walked over the whole catalogue so a new
    // row cannot re-open it in either direction: if a standing source refuses a
    // glyph, the act that unrefuses it must exist for that source.
    for (const src of naturalSources()) {
      for (const p of src.products) {
        if (glyphTakeableFrom(src, p.glyph, false)) continue;
        expect(sourceIsCuttable(src.species, undefined)).toBe(true);
        expect(glyphTakeableFrom(src, p.glyph, true)).toBe(true);
      }
    }
  });

  it("a glyph the source does not yield is nobody's business here", () => {
    expect(glyphTakeableFrom(naturalSourceOf("oak")!, "milk", false)).toBe(true);
    expect(glyphTakeableFrom(undefined, "wood", false)).toBe(true);
  });
});

// ── ⚖️ A MIXED SOURCE — BEARS, DEPLETES *AND* YIELDS ONLY WHEN FELLED ───────
//
// 🚨 THIS DESCRIBE MUST STAY LAST IN THE FILE. It REGISTERS a source into the
// module-level catalogue and there is no unregister; every describe above walks
// `naturalSources()` and would see it. Jest runs describes in declaration
// order, so a `beforeAll` here lands after all of them.
//
// The row this file's own header promises: *"one source may perfectly well bear
// fruit, deplete a fibre and yield timber only when felled, and `kind` could not
// describe that thing at all."* `sourceIsCuttable` read `!sourceDepletes` and so
// answered FALSE for exactly that source — leaving its kill glyph gated behind a
// cut it could never receive, which is the same dead end the sheep was in.

describe("a source that bears, depletes AND yields a body product", () => {
  const MIXED = "test_mixed_shrub";
  const PURE_DEPLETE = "test_moss_patch";

  beforeAll(() => {
    registerNaturalSource({
      species: MIXED,
      kind: "plant",
      feature: { icon: "🌿", radiusM: 0.6 },
      products: [
        { glyph: "test_berry", use: "food", method: "harvest", yield: { min: 1, max: 3 }, regrowDays: 2 },
        { glyph: "test_fibre", use: "raw", method: "deplete", yield: { min: 2, max: 4 } },
        { glyph: "test_timber", use: "building", method: "kill", yield: { min: 4, max: 6 } },
      ],
    });
    // A moss patch — the `deplete` method with NO body product behind it, which
    // is the outcrop's side of the line and must stay there.
    registerNaturalSource({
      species: PURE_DEPLETE,
      kind: "plant",
      feature: { icon: "🌱", radiusM: 0.4 },
      products: [{ glyph: "test_moss", use: "raw", method: "deplete", yield: { min: 1, max: 3 } }],
    });
  });

  it("is CUTTABLE — having substance to give up outranks also wearing away", () => {
    const src = naturalSourceOf(MIXED)!;
    expect(sourceDepletes(src)).toBe(true); // it really does deplete
    expect(src.products.some((p) => p.method === "kill")).toBe(true);
    expect(sourceIsCuttable(MIXED, undefined)).toBe(true);
  });

  it("gates its TIMBER until it is down, and nothing else, ever", () => {
    const src = naturalSourceOf(MIXED)!;
    expect(glyphTakeableFrom(src, "test_timber", false)).toBe(false);
    expect(glyphTakeableFrom(src, "test_timber", true)).toBe(true);
    // The fibre comes off the standing shrub unit by unit — that is what
    // `deplete` means — and the berry is a live take. Neither waits on a cut.
    expect(glyphTakeableFrom(src, "test_fibre", false)).toBe(true);
    expect(glyphTakeableFrom(src, "test_berry", false)).toBe(true);
  });

  it("a PURE-deplete source keeps the outcrop's ending", () => {
    expect(sourceIsCuttable(PURE_DEPLETE, undefined)).toBe(false);
    expect(glyphTakeableFrom(naturalSourceOf(PURE_DEPLETE)!, "test_moss", false)).toBe(true);
  });
});
