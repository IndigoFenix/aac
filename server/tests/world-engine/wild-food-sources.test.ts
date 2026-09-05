// 🌿 THE WILD LARDER — can a settler eat off the land?
//
// USER RULING, 2026-09-04, verbatim: *"We should also add some wild food
// sources so that settlers can survive in the wilderness - most areas just have
// trees right now."*
//
// THE MEASURED PREMISE. Before this round `wildMixForBiome` stood a forest cell
// as `oak ×10` + ONE cultivar `×2` + `rock ×6` — two features in eighteen bore
// anything edible, the edible one was a CROP picked by seed rather than
// anything a forager would find, and the one line that scales with the land
// (`oak`, off the biosphere's own `standDensityPerHa`) is the line that bears
// no food at all.
//
// WHAT THIS FILE PINS, in the order the round built it:
//   ① THE ROWS — four ordinary natural sources, each with one live food take,
//      a real body, and NOTHING to fell it for.
//   ② THE NICHES — each resolves on its own ground and closes on somebody
//      else's, so the four are not interchangeable and the wilderness reads
//      differently in a boreal wood, a wet wood and open grass.
//   ③ THE THREE QUERIES — `foodPlants` location-blind, `usefulPlants` the
//      grower's, `wildFoodPlants` the forager's; none is another's filter.
//   ④ THE SCATTER — the mix deals them where the climate fits, at counts that
//      come off the species' own `rarity`, with no duplicate species (the id
//      collision that would silently overwrite a stand's stock).
//   ⑤ THE TAKE — food comes off a LIVING bush. `glyphTakeableFrom` says so at
//      the gate, and the real host's board says so at the screen: `take:berry`
//      is offered on a bush that has never been cut. (⚖️ fell-first is
//      FEATURES-only; #49 E1's law — no refusal without a remedy.)
//
// Run:  npm run test:engine -- wild-food

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  foodGlyphs,
  foodPlants,
  glyphTakeableFrom,
  harvestStockOf,
  naturalSourceOf,
  nicheSuitabilityOf,
  sourceIsConsumable,
  sourceRarityOf,
  usefulPlants,
  wildFoodPlants,
  type ClimateSample,
  type NaturalSource,
} from "@shared/world-engine/products.js";
import {
  buildWilderness,
  homesteadWildMix,
  wildFeatureContainerId,
  wildFeatureEmbodied,
  wildFeatureRadius,
  wildMixForBiome,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { FOOD_KINDS, satiationDaysOf, SATIATION_DAYS } from "@shared/world-engine/kernel/town/goods-kinds.js";
import { getSpecies } from "@shared/world-engine/creatures/species.js";
import { specWords } from "@shared/world-engine/interaction/content/words.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

/** The four rows this round added, and the food each one bears. */
const LARDER: ReadonlyArray<{ species: string; food: string }> = [
  { species: "bush", food: "berry" },
  { species: "hazel", food: "nut" },
  { species: "wild_onion", food: "onion" },
];

/** Cells calibrated against ecology.ts TREE / GRASS, in the substrate's own
 *  units — the same shape `climateSampleAt` builds from a real grid. */
const CELLS: Readonly<Record<string, ClimateSample>> = {
  temperateForest: { rain: 1.0, tempC: 12, elevation: 5, fertility: 8, ore: 2 },
  borealForest: { rain: 0.8, tempC: 2, elevation: 8, fertility: 5, ore: 2 },
  forestEdge: { rain: 0.7, tempC: 14, elevation: 4, fertility: 7, ore: 2 },
  grassland: { rain: 0.5, tempC: 16, elevation: 6, fertility: 6, ore: 2 },
  tropical: { rain: 1.1, tempC: 27, elevation: 2, fertility: 9, ore: 2 },
  frozenScree: { rain: 0.05, tempC: -25, elevation: 60, fertility: 0, ore: 1 },
};

const row = (species: string): NaturalSource => {
  const s = naturalSourceOf(species);
  if (!s) throw new Error(`${species} is not in the natural-sources catalogue`);
  return s;
};

// ── ① THE ROWS ─────────────────────────────────────────────────────────────

describe("the four forage rows are ordinary natural sources", () => {
  it("each bears ONE live food take, and nothing anybody has to fell it for", () => {
    for (const { species, food } of LARDER) {
      const src = row(species);
      expect(src.kind).toBe("plant");
      const foods = src.products.filter((p) => p.use === "food" && p.method === "harvest");
      expect(foods.map((p) => p.glyph)).toEqual([food]);
      // ⚖️ NO BODY PRODUCT AT ALL. These are things you PICK: there is no wood
      // in a berry bush and no timber in an onion, so `sourceIsConsumable` is
      // false and a bush picked clean is still a whole bush — which is also why
      // none of them declares a growth ladder (there is no felling to re-seed
      // from).
      expect(sourceIsConsumable(src)).toBe(false);
      expect(src.growth).toBeUndefined();
      // A LIVE take bears again: every one of them says how long that takes.
      for (const p of foods) expect(p.regrowDays).toBeGreaterThan(0);
    }
  });

  it("each stands as a REAL body — a species row with a worked blueprint", () => {
    for (const { species } of LARDER) {
      const sp = getSpecies(species);
      expect(sp).toBeDefined();
      expect(sp!.kind).toBe("plant");
      // 🚨 NOT A STUB. `spawnWildFeature` stands an embodied plant with
      // `addNpc`, and `createBakedCreature` → `requireSpecies` THROWS on a
      // species whose blueprint is empty — so a forage row naming a stub would
      // crash the scatter rather than render badly.
      expect(sp!.stub).not.toBe(true);
      expect(Object.keys(sp!.blueprint).length).toBeGreaterThan(0);
      // …and the catalogue row declares the height it is stood at, which is
      // what `wildFeatureEmbodied` keys on.
      expect(row(species).bodyHeightM).toBeGreaterThan(0);
      expect(wildFeatureEmbodied({ species } as WildernessFeature)).toBe(true);
    }
  });

  it("⚖️ NO SYNONYMS: two of the four re-use species the world already draws", () => {
    // `bush` ships a blueprint literally titled "Bush (berries)", with four
    // lexemes and a [plants] button already — re-using it adds NO button to a
    // category tab that lists its whole category. The two NEW source species
    // carry no `words` at all, for the same reason `oak` and `apple_tree` carry
    // none: a body the world builds is not a word a child says. Their FOOD is
    // the word, and it lives in the glyph registry and ITEM_WORDS.
    expect(getSpecies("bush")!.words).toBeDefined();
    expect(getSpecies("hazel")!.words).toBeUndefined();
    expect(getSpecies("wild_onion")!.words).toBeUndefined();
    // …and the item bodies carry none either — one definition per head, and
    // theirs is in ITEM_WORDS (`duplicateSpecWordHeads` is the gate).
    for (const { food } of LARDER) expect(getSpecies(food)!.words).toBeUndefined();
  });

  it("every food it yields is a WORD — a glyph, and a lexeme on the spec side", () => {
    for (const { food } of LARDER) {
      // The AAC board's picture and label (all 11 locales — `validate-glyphs`
      // is the gate; here we only pin that the row exists at all).
      expect(getVocabularyItem(food)?.emoji).toBeTruthy();
      // …and the world-engine's own grammar layer, which fails SILENTLY: with
      // no lexeme `baseWord` returns the raw head, and a head IS an English
      // word, so a Hebrew container board would read "berry".
      for (const locale of ["en", "he", "es", "pt"] as const) {
        expect(specWords(locale)[food]?.w).toBeTruthy();
      }
    }
  });
});

// ── ② THE NICHES ───────────────────────────────────────────────────────────

describe("each niche resolves on its own ground — and closes on somebody else's", () => {
  const lives = (species: string, cell: keyof typeof CELLS): boolean =>
    nicheSuitabilityOf(row(species), CELLS[cell]!) > 0;

  it("🫐 the berry bush is the FOREST EDGE and the COLD — the one a frontier can count on", () => {
    expect(lives("bush", "temperateForest")).toBe(true);
    expect(lives("bush", "borealForest")).toBe(true);
    expect(lives("bush", "forestEdge")).toBe(true);
    expect(lives("bush", "grassland")).toBe(true);
    // …and it is the ONLY one of the four that peaks cool: on a boreal cell it
    // beats every sibling that lives there at all.
    const boreal = CELLS.borealForest!;
    const mine = nicheSuitabilityOf(row("bush"), boreal);
    for (const { species } of LARDER) {
      if (species === "bush") continue;
      expect(nicheSuitabilityOf(row(species), boreal)).toBeLessThan(mine);
    }
    // The tropics are not berry country (a hard tempC ceiling, 26 °C).
    expect(lives("bush", "tropical")).toBe(false);
  });

  it("🌰 the hazel is CLOSED TEMPERATE FOREST — no boreal, no tropics, no open grass", () => {
    expect(lives("hazel", "temperateForest")).toBe(true);
    expect(lives("hazel", "forestEdge")).toBe(true);
    expect(lives("hazel", "borealForest")).toBe(false); // tempC floor 2 °C
    expect(lives("hazel", "tropical")).toBe(false); // …and a 27 °C ceiling
    expect(lives("hazel", "grassland")).toBe(false); // rain floor .55, above TREE's
  });

  it("🍄 the WET FOREST FLOOR is a recorded gap, not an oversight", () => {
    // The mushroom was designed for it and is NOT in the catalogue — a food
    // glyph must name a `kind:"fruit"` species while its source names a
    // `kind:"plant"` one, and a mushroom is the one food whose standing body
    // and picked body are the same thing. products.ts states the two ways out
    // and why neither is this lane's call; this pin exists so the day somebody
    // rules, the gap is found rather than remembered.
    expect(naturalSourceOf("mushroom")).toBeUndefined();
    // The species, its blueprint and its [plants] button are all still there —
    // nothing was taken away to make room for the decision.
    expect(getSpecies("mushroom")!.kind).toBe("plant");
    expect(getSpecies("mushroom")!.words).toBeDefined();
  });

  it("🧅 the wild onion is OPEN COUNTRY — and it is the grassland's own answer", () => {
    expect(lives("wild_onion", "grassland")).toBe(true);
    expect(lives("wild_onion", "forestEdge")).toBe(true);
    // Closed wet forest shuts it out at the rain ceiling (1.0), which is what
    // keeps the bulb and the closed-canopy nut tree off each other's ground.
    expect(lives("wild_onion", "temperateForest")).toBe(false);
    expect(lives("wild_onion", "tropical")).toBe(false);
    // On open grass it beats every sibling that lives there.
    const grass = CELLS.grassland!;
    const mine = nicheSuitabilityOf(row("wild_onion"), grass);
    for (const { species } of LARDER) {
      if (species === "wild_onion") continue;
      expect(nicheSuitabilityOf(row(species), grass)).toBeLessThan(mine);
    }
  });

  it("frozen scree feeds nobody — every one of the four closes", () => {
    for (const { species } of LARDER) {
      expect(nicheSuitabilityOf(row(species), CELLS.frozenScree!)).toBe(0);
    }
    expect(wildFoodPlants(CELLS.frozenScree!)).toEqual([]);
  });
});

// ── ③ THE THREE QUERIES ────────────────────────────────────────────────────

describe("three queries over one catalogue, and none is another's filter", () => {
  it("every forage food joins `foodPlants()` and FOOD_KINDS by EXISTING", () => {
    const pairs = foodPlants();
    for (const { species, food } of LARDER) {
      expect(pairs).toContainEqual({ food, species });
      expect(FOOD_KINDS).toContain(food);
      expect(foodGlyphs()).toContain(food);
      // Raw food: a fifth of a person-day, through the FOOD_KINDS fallthrough —
      // no `SATIATION_DAYS` row of its own, exactly like the carrot.
      expect(satiationDaysOf(food)).toBe(SATIATION_DAYS.food);
      expect(satiationDaysOf(`${food}.hot`)).toBe(SATIATION_DAYS.meal);
    }
    // 🚨 APPENDED, NEVER INSERTED — likes hash by index.
    expect(FOOD_KINDS.slice(0, 4)).toEqual(["apple", "banana", "grape", "carrot"]);
  });

  it("`foodPlants()` is LOCATION-BLIND and takes no sample at all", () => {
    // The vocabulary query: a child names a banana on any continent. It has no
    // climate parameter, so the compiler is half the pin and this is the other
    // half — the answer on a frozen world is the answer everywhere.
    expect(foodPlants().map((p) => p.food)).toContain("banana");
    expect(foodPlants().length).toBe(wildFoodPlants().length);
  });

  it("`wildFoodPlants` is FOOD-ONLY and LOCATION-AWARE — a strict subset of the grower's query", () => {
    for (const cell of Object.values(CELLS)) {
      const forage = wildFoodPlants(cell).map((s) => s.species);
      const grower = usefulPlants(cell).map((s) => s.species);
      for (const s of forage) expect(grower).toContain(s);
      // Every row it returns really does bear food, and really does live here.
      for (const s of forage) {
        expect(row(s).products.some((p) => p.use === "food" && p.method === "harvest")).toBe(true);
        expect(nicheSuitabilityOf(row(s), cell)).toBeGreaterThan(0);
      }
      // …and nothing that lives here and bears food is missing from it.
      const missed = usefulPlants(cell).filter(
        (s) => s.products.some((p) => p.use === "food" && p.method === "harvest") && !forage.includes(s.species),
      );
      expect(missed).toEqual([]);
    }
  });
});

// ── ④ THE SCATTER ──────────────────────────────────────────────────────────

describe("the scatter deals the larder where the climate fits", () => {
  const dealt = (mix: ReturnType<typeof wildMixForBiome>): Record<string, number> =>
    Object.fromEntries(mix.map((e) => [e.species, e.count]));

  it("a temperate FOREST cell carries berries and nuts", () => {
    const m = dealt(wildMixForBiome(1, 11, CELLS.temperateForest!));
    expect(m["bush"]).toBeGreaterThan(0);
    // Hazel is here too — either as a forage line or as the seed's own sprinkle
    // pick, which is what the de-duplication makes indistinguishable by design.
    expect(m["hazel"]).toBeGreaterThan(0);
    expect(m["wild_onion"]).toBeUndefined(); // closed forest shuts the bulb out
    // …and the point of the whole round, stated as the user stated it: a forest
    // cell is no longer "just trees". Counted over every food-bearing plant the
    // cell stands (the forage rows AND the occasional wild cultivar), the
    // larder now OUTNUMBERS the timber line — where before it was two features
    // in eighteen.
    const food = wildFoodPlants().reduce((n, s) => n + (m[s.species] ?? 0), 0);
    expect(food).toBeGreaterThan(m["oak"] ?? 0);
  });

  it("a GRASSLAND cell carries the bulb, and not the nut", () => {
    const m = dealt(wildMixForBiome(2, 11, CELLS.grassland!));
    expect(m["wild_onion"]).toBeGreaterThan(0);
    expect(m["hazel"]).toBeUndefined();
    expect(m["sheep"]).toBe(2); // the switch's own content, untouched
  });

  it("a BOREAL cell is berry country, and thin in everything else", () => {
    const m = dealt(wildMixForBiome(1, 11, CELLS.borealForest!));
    expect(m["hazel"]).toBeUndefined(); // its 2 °C floor closes here
    expect(m["bush"]).toBeGreaterThan(m["wild_onion"] ?? 0);
  });

  it("BARREN ground stays barren — the larder never reaches it", () => {
    for (const cell of [CELLS.temperateForest!, CELLS.grassland!]) {
      expect(wildMixForBiome(0, 11, cell)).toEqual([{ species: "rock", count: 8 }]);
    }
  });

  it("⚖️ ABUNDANCE COMES OFF THE SPECIES' OWN `rarity`, not off the switch", () => {
    // The berry bush is the default (1 — "under everyone's feet"); every other
    // forage row and every cultivar declares less. On one cell that ALL of them
    // suit equally the ordering is the rarity ordering, which is the whole
    // claim: the switch supplies one number (how much ground there is), the
    // rows supply the rest.
    expect(sourceRarityOf(row("bush"))).toBe(1);
    for (const s of ["hazel", "wild_onion", "apple_tree", "banana_plant", "grape_vine", "carrot_plant"]) {
      expect(sourceRarityOf(row(s))).toBeLessThan(1);
    }
    // With NO climate there is nothing to weight by, so the mix IS the rarity
    // ladder at the biome's base — the cleanest reading of the law.
    const m = dealt(wildMixForBiome(1, 11));
    expect(m["bush"]).toBeGreaterThan(m["hazel"]!);
    expect(m["hazel"]).toBeGreaterThan(m["carrot_plant"]!);
  });

  it("🚨 NO SPECIES IS DEALT TWICE — the id collision that would eat a stand's stock", () => {
    // `buildWilderness` mints `wild:<species>_<i>`, so two mix lines naming one
    // species would give two features the same id and the second would silently
    // overwrite the first's container record. The sprinkle and the forage line
    // can both want the same plant, so the de-duplication is load-bearing.
    for (const cell of [undefined, ...Object.values(CELLS)]) {
      for (const biome of [0, 1, 2, 3]) {
        const species = wildMixForBiome(biome, 11, cell).map((e) => e.species);
        expect(new Set(species).size).toBe(species.length);
      }
      for (const b of ["farmland", "mining"] as const) {
        const species = homesteadWildMix(b, 11, cell).map((e) => e.species);
        expect(new Set(species).size).toBe(species.length);
      }
    }
    // …and the laid scatter proves it end to end.
    const laid = buildWilderness({ seed: 11, side: 240, mix: homesteadWildMix("farmland", 11) });
    const ids = laid.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a dealt forage feature stands bearing its food, with a cap to regrow to", () => {
    const laid = buildWilderness({
      seed: 4242,
      side: 240,
      mix: wildMixForBiome(1, 4242, CELLS.temperateForest!),
    });
    for (const { species, food } of LARDER) {
      const stands = laid.features.filter((f) => f.species === species);
      if (!stands.length) continue; // this cell may not carry it — ② covers that
      for (const f of stands) {
        expect(f.stock[food]).toBeGreaterThan(0);
        expect(f.harvestCap?.[food]).toBe(f.stock[food]);
        // A pure-harvest source never shrinks: a bush picked clean is a bush.
        expect(wildFeatureRadius(species, f.stock)).toBe(
          wildFeatureRadius(species, { [food]: 0 }),
        );
      }
    }
  });

  it("the rolled bearing is deterministic in the seed", () => {
    let n = 0;
    const roll = () => ((n = (n * 1103515245 + 12345) >>> 0) / 4294967296);
    const a = LARDER.map(({ species }) => { n = 7; return harvestStockOf(species, roll); });
    const b = LARDER.map(({ species }) => { n = 7; return harvestStockOf(species, roll); });
    expect(a).toEqual(b);
  });
});

// ── ⑤ THE TAKE — food off a LIVING plant ───────────────────────────────────

describe("⚖️ FELL-FIRST IS FEATURES-ONLY — food comes off a plant that is still alive", () => {
  it("the gate says yes on a STANDING instance, with no `downed` anywhere", () => {
    for (const { species, food } of LARDER) {
      // `downed` defaults false, which is the only state a fresh scatter is in.
      expect(glyphTakeableFrom(row(species), food)).toBe(true);
      expect(glyphTakeableFrom(row(species), food, false)).toBe(true);
    }
    // The contrast that names the law: an oak's timber IS the oak, so it is
    // NOT takeable until the cut — and that is the one arm this round must not
    // have widened.
    expect(glyphTakeableFrom(row("oak"), "wood")).toBe(false);
    expect(glyphTakeableFrom(row("oak"), "wood", true)).toBe(true);
  });
});

// The live half: the REAL host, the shipped frontier world, the gaze and a
// press — the idiom `wild-body-press.test.ts` established.
const doc = JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

describe("frontier — a berry bush offers its berries without being cut", () => {
  let run: TextQuestRun;
  const boards: { kind: string; nodeId?: string; options: string[] }[] = [];

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    run.addPresenterTap({
      board: (v) =>
        boards.push({
          kind: v.kind,
          ...(v.nodeId ? { nodeId: v.nodeId } : {}),
          options: v.options.map((o) => o.id),
        }),
    });
    run.advance(20);
  }, 600_000);

  afterAll(() => run?.dispose());

  const hoverAndOpen = (
    at: { x: number; y: number },
    wantId: string,
  ): { kind: string; nodeId?: string; options: string[] } | null => {
    run.clearLook();
    run.advance(2);
    boards.length = 0;
    run.look(at.x, at.y);
    let landed = false;
    for (let i = 0; i < 24 && !landed; i++) {
      run.stepFrame();
      landed = run.view.probe().intent?.cursor?.hoverId === wantId;
    }
    if (!landed) {
      throw new Error(`the gaze never landed on ${wantId} — fixture broken, not a finding`);
    }
    run.advance(4);
    return boards.findLast((b) => b.kind === "acts" && b.nodeId === wantId) ?? null;
  };

  it("🫐 the board offers `take:berry` on a bush that has never been cut", () => {
    const c = run.session.town!.stage.center;
    const bush: WildernessFeature = {
      id: "probe:larder_bush",
      species: "bush",
      x: c.x + 150,
      y: c.y - 130,
      stock: { berry: 3 },
      harvestCap: { berry: 3 },
    };
    if (!run.host.addWildFeature(bush)) {
      throw new Error("the probe bush would not spawn — fixture broken, not a finding");
    }
    const ep = wildFeatureContainerId(bush);
    // It stands as a BODY (the `bush` blueprint), exactly as an oak does.
    expect(ep).toBe("flora:bush:probe:larder_bush");
    expect(run.state.avatars[ep]).toBeDefined();

    const board = hoverAndOpen(bush, ep);
    expect(board).not.toBeNull();
    // 🚨 THE WHOLE POINT. The berries are offered while it is STANDING — no
    // cut first, no refusal whose remedy destroys the source that bears the
    // food. (The cut is still on the board: a bush IS cuttable, it just is not
    // a prerequisite for eating.)
    expect(board!.options).toContain("take:berry");
    expect(board!.options).toContain(`cut:${ep}`);
    expect(
      run.session.wilderness!.features.find((f) => f.id === "probe:larder_bush")?.downed,
    ).not.toBe(true);
  }, 600_000);

  it("🌿 the frontier world stands forage of its own — not just trees", () => {
    // The user's sentence, as an assertion over the shipped world: the
    // countryside a founding lands in carries something to eat.
    const forage = run.session.wilderness!.features.filter((f) =>
      LARDER.some((l) => l.species === f.species && f.id !== "probe:larder_bush"),
    );
    expect(forage.length).toBeGreaterThan(0);
    for (const f of forage) {
      const food = LARDER.find((l) => l.species === f.species)!.food;
      expect(f.stock[food]).toBeGreaterThan(0);
    }
  }, 600_000);
});
