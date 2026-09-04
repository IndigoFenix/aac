// WILDERNESS scatter (founding flow): deterministic resource features
// (trees = wood containers, rocks = stone containers) + possessable
// creatures over open ground. Pins determinism, bounds, the spawn
// clearing, the material stacks, and the live-harvest regrow rules
// (step ④: pick/shear/milk — the standing source bears again).

import { describe, it, expect } from "@jest/globals";
import {
  armHarvestRegrow,
  buildWilderness,
  dueGrowthAdvance,
  dueHarvestRegrowth,
  faunaForBiome,
  growthClassPeriodS,
  homesteadWildMix,
  reseedGrowthStock,
  wildAnimalBodyId,
  wildFeatureContainerId,
  wildFeatureEmbodied,
  wildFeatureRadius,
  wildFeatureSizeRank,
  wildLocalCast,
  wildLocalIcon,
  wildMixForBiome,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import {
  getSpecies,
  listSpecies,
  speciesCanSpeak,
} from "@shared/world-engine/creatures/species.js";
import {
  naturalSourceOf,
  nicheSuitabilityOf,
  usefulPlants,
  type ClimateSample,
} from "@shared/world-engine/products.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

describe("buildWilderness", () => {
  it("is deterministic in the seed", () => {
    const a = buildWilderness({ seed: 11 });
    const b = buildWilderness({ seed: 11 });
    expect(a).toEqual(b);
    const c = buildWilderness({ seed: 12 });
    expect(c).not.toEqual(a);
  });

  it("lays the requested counts with the right material stacks", () => {
    const w = buildWilderness({ seed: 3, trees: 5, rocks: 4, creatures: 2 });
    const trees = w.features.filter((f) => f.species === "oak");
    const rocks = w.features.filter((f) => f.species === "rock");
    expect(trees).toHaveLength(5);
    expect(rocks).toHaveLength(4);
    expect(w.creatures).toHaveLength(2);
    // The bounds come off the CATALOGUE, never literals: the yields were
    // rescaled in phase 6 against real block bills, and what this pins is that
    // a laid feature carries its species' own declared roll.
    const bounds = (species: string, glyph: string): { min: number; max: number } =>
      naturalSourceOf(species)!.products.find((p) => p.glyph === glyph)!.yield;
    for (const t of trees) {
      expect(Object.keys(t.stock)).toEqual(["wood"]);
      expect(t.stock.wood).toBeGreaterThanOrEqual(bounds("oak", "wood").min);
      expect(t.stock.wood).toBeLessThanOrEqual(bounds("oak", "wood").max);
    }
    for (const r of rocks) {
      expect(Object.keys(r.stock)).toEqual(["stone"]);
      expect(r.stock.stone).toBeGreaterThanOrEqual(bounds("rock", "stone").min);
      expect(r.stock.stone).toBeLessThanOrEqual(bounds("rock", "stone").max);
    }
  });

  it("keeps everything inside the manifold and out of the spawn clearing", () => {
    const w = buildWilderness({ seed: 7, side: 240 });
    expect(w.spawn).toEqual({ x: 120, y: 120 });
    for (const e of [...w.features, ...w.creatures]) {
      expect(e.x).toBeGreaterThanOrEqual(8);
      expect(e.x).toBeLessThanOrEqual(232);
      expect(e.y).toBeGreaterThanOrEqual(8);
      expect(e.y).toBeLessThanOrEqual(232);
      expect(Math.hypot(e.x - w.spawn.x, e.y - w.spawn.y)).toBeGreaterThanOrEqual(6);
    }
  });

  it("ids follow the session protocols (features wild:<species>_<n>, creatures wild_<n>)", () => {
    const w = buildWilderness({ seed: 5, trees: 2, rocks: 1, creatures: 2 });
    expect(w.features.map((f) => f.id)).toEqual(["wild:oak_0", "wild:oak_1", "wild:rock_0"]);
    expect(w.creatures.map((c) => c.id)).toEqual(["wild_0", "wild_1"]);
  });

  it("floors the side at 60 m", () => {
    expect(buildWilderness({ seed: 1, side: 10 }).side).toBe(60);
  });

  // ── Visible depletion (construction phase 5 step ④: rock bodies) ──────────
  describe("wildFeatureRadius", () => {
    const ROCK_R = naturalSourceOf("rock")!.feature!.radiusM; // 0.55 today
    const OAK_R = naturalSourceOf("oak")!.feature!.radiusM;
    // FULL is the species' own maximum roll, read off the catalogue — never a
    // literal. The yields were rescaled in phase 6 (a house is 120 blocks, so
    // a tree had to be worth more than two units of wood), and a test that
    // spells "full" as `{ stone: 2 }` fails on a rebalance while claiming the
    // shrink curve broke. What this describe is ABOUT is that depletion reads;
    // that is true at any max.
    const maxKill = (species: string, glyph: string): number =>
      naturalSourceOf(species)!.products.find((p) => p.glyph === glyph)!.yield.max;
    const ROCK_FULL = maxKill("rock", "stone");
    const OAK_FULL = maxKill("oak", "wood");

    it("stands a full source at its declared radius", () => {
      expect(wildFeatureRadius("rock", { stone: ROCK_FULL })).toBeCloseTo(ROCK_R, 6);
      expect(wildFeatureRadius("oak", { wood: OAK_FULL })).toBeCloseTo(OAK_R, 6);
    });

    it("shrinks with the REMAINING kill stock — one stone reads as a pebble", () => {
      const full = wildFeatureRadius("rock", { stone: ROCK_FULL });
      const half = wildFeatureRadius("rock", { stone: Math.floor(ROCK_FULL / 2) });
      const last = wildFeatureRadius("rock", { stone: 1 });
      const spent = wildFeatureRadius("rock", { stone: 0 });
      expect(half).toBeLessThan(full * 0.8); // unmistakably smaller, not a nuance
      expect(last).toBeLessThan(half);
      expect(spent).toBeLessThan(last);
      expect(spent).toBeGreaterThan(0); // never a speck — felling removes it, not the size
    });

    it("size means UNITS LEFT, not a fraction of its own roll", () => {
      // An outcrop that rolled a single stone and one quarried down to its
      // last stone are the same pebble — otherwise a poor roll would stand
      // as tall as a fresh boulder.
      expect(wildFeatureRadius("rock", { stone: 1 })).toBeCloseTo(
        wildFeatureRadius("rock", { stone: 1 }),
        6,
      );
      expect(wildFeatureRadius("rock", { stone: 1 })).toBeLessThan(
        wildFeatureRadius("rock", { stone: 2 }),
      );
    });

    it("never shrinks a source with no kill products (a picked bush is still a bush)", () => {
      const full = wildFeatureRadius("banana_plant", { banana: 3 });
      expect(wildFeatureRadius("banana_plant", {})).toBeCloseTo(full, 6);
      expect(wildFeatureRadius("banana_plant", undefined)).toBeCloseTo(full, 6);
    });

    it("is pure and total — same input, same answer; unknown species get the default", () => {
      expect(wildFeatureRadius("rock", { stone: 1 })).toBe(wildFeatureRadius("rock", { stone: 1 }));
      expect(wildFeatureRadius("nothing_at_all", undefined)).toBeGreaterThan(0);
      // Over-stocked (a regrow overshoot could never happen for kill glyphs,
      // but the clamp must hold) never grows past the declared radius.
      expect(wildFeatureRadius("rock", { stone: 99 })).toBeCloseTo(ROCK_R, 6);
    });
  });

  it("kill-only features carry no harvest capacity or regrow ledger", () => {
    const w = buildWilderness({ seed: 9, trees: 2, rocks: 1, creatures: 0 });
    for (const f of w.features) {
      expect(f.harvestCap).toBeUndefined();
      expect(f.regrowAt).toBeUndefined();
    }
  });

  it("an explicit mix replaces the oak-and-rock default (biome selection seam)", () => {
    const w = buildWilderness({
      seed: 4,
      creatures: 0,
      mix: [
        { species: "apple_tree", count: 2 },
        { species: "rock", count: 1 },
      ],
    });
    expect(w.features.map((f) => f.id)).toEqual([
      "wild:apple_tree_0",
      "wild:apple_tree_1",
      "wild:rock_0",
    ]);
    for (const f of w.features.filter((x) => x.species === "apple_tree")) {
      // A living orchard source: felling wood in the stock, ripe fruit at
      // its rolled bearing capacity, ready to regrow after a pick.
      expect(f.stock.wood).toBeGreaterThanOrEqual(1);
      expect(f.harvestCap!.apple).toBeGreaterThanOrEqual(1);
      expect(f.harvestCap!.apple).toBeLessThanOrEqual(3);
      expect(f.stock.apple).toBe(f.harvestCap!.apple);
    }
  });

  it("an ANIMAL mix entry scatters walking product bodies, not box features", () => {
    const w = buildWilderness({
      seed: 6,
      creatures: 1,
      mix: [
        { species: "sheep", count: 2 },
        { species: "rock", count: 1 },
      ],
    });
    // The sheep are creatures; only the rock stands as a feature.
    expect(w.features.map((f) => f.id)).toEqual(["wild:rock_0"]);
    const sheep = w.creatures.filter((c) => c.species === "sheep");
    expect(sheep.map((c) => c.id)).toEqual(["wild_sheep_0", "wild_sheep_1"]);
    for (const s of sheep) {
      // Meat (kill) + wool at its rolled bearing capacity, ready to regrow.
      expect(s.stock!.meat).toBeGreaterThanOrEqual(1);
      expect(s.stock!.wool).toBe(s.harvestCap!.wool);
      expect(s.harvestCap!.wool).toBeGreaterThanOrEqual(1);
      expect(s.harvestCap!.wool).toBeLessThanOrEqual(2);
      expect(s.icon).toBe(""); // the body comes from the species
      expect(wildAnimalBodyId(s)).toBe(`fauna:sheep:${s.id}`);
    }
    // The legacy possessable local still spawns alongside.
    expect(w.creatures.filter((c) => !c.species).map((c) => c.id)).toEqual(["wild_0"]);
  });

  it("the default mix is byte-identical to the legacy trees/rocks scatter", () => {
    const legacy = buildWilderness({ seed: 11 });
    const viaMix = buildWilderness({
      seed: 11,
      mix: [
        { species: "oak", count: 10 },
        { species: "rock", count: 6 },
      ],
    });
    expect(viaMix).toEqual(legacy);
  });

  // ── S&D S3 H1 — THE RESOURCE-CONVERSION DIAL ──────────────────────────────
  describe("conversionDial — multiplier ① routed through the scatter", () => {
    it("dial 1 (default AND explicit) is byte-identical", () => {
      const bare = buildWilderness({ seed: 3, trees: 5, rocks: 4, creatures: 2 });
      const explicit = buildWilderness({ seed: 3, trees: 5, rocks: 4, creatures: 2, conversionDial: 1 });
      expect(explicit).toEqual(bare);
    });

    it("⚖️ INVARIANCE (S3 review): a passed dial changes NOTHING — abundance is dial-free", () => {
      const bare = buildWilderness({ seed: 3, trees: 5, rocks: 4, creatures: 0 });
      const dialed = buildWilderness({ seed: 3, trees: 5, rocks: 4, creatures: 0, conversionDial: 2 });
      expect(dialed).toEqual(bare);
    });

    it("a freshly-scattered tree stands MATURE — sizeClass/growAt stay unset", () => {
      const w = buildWilderness({ seed: 3, trees: 3, rocks: 0, creatures: 0 });
      for (const f of w.features) {
        expect(f.sizeClass).toBeUndefined();
        expect(f.growAt).toBeUndefined();
      }
    });
  });
});

// ── THE WANDERING LOCALS ARE FAUNA (2026-09-02) ────────────────────────────
// The bug this pins: the scatter used to pick one of four hand-written EMOJI
// faces and let the host map the FACE to a body. When the four animal people
// became a creature MOD, that map's species stopped existing in most worlds and
// every local fell through to the world's speaking cast — a frontier homestead
// spawning wild HUMANS. The direction is flipped for good: the SPECIES is
// chosen, the face is derived from it.
describe("wildLocalCast — a wilderness local is FAUNA, never a person", () => {
  it("never offers a SPEAKING species (the wild-humans bug)", () => {
    const cast = wildLocalCast();
    expect(cast.length).toBeGreaterThan(0);
    expect(cast).not.toContain("human");
    for (const id of cast) expect(speciesCanSpeak(id)).toBe(false);
    // The complement is the PERSON cast, and the two must not overlap: every
    // speaking creature the world has is somebody, not wildlife.
    const speaking = listSpecies().filter((sp) => speciesCanSpeak(sp.id)).map((sp) => sp.id);
    expect(cast.filter((id) => speaking.includes(id))).toEqual([]);
  });

  it("never offers a body nothing can build (🚨 a stub THROWS at materialisation)", () => {
    for (const id of wildLocalCast()) {
      const sp = getSpecies(id)!;
      expect(sp.kind).toBe("creature");
      expect(sp.stub).toBeFalsy();
      expect(sp.bodiless).toBeFalsy();
    }
    // The retired four-face cast: `bear`, `frog` and `rabbit` are stub rows
    // (the bases `animal_people` derives from) and have no body to stand.
    for (const id of ["bear", "frog", "rabbit"]) {
      expect(wildLocalCast()).not.toContain(id);
    }
  });

  it("is derived from the registry, not listed — and stays in registry order", () => {
    const ids = listSpecies().map((sp) => sp.id);
    const cast = wildLocalCast();
    expect(cast).toEqual(ids.filter((id) => cast.includes(id)));
  });
});

describe("buildWilderness locals — the species decides, the face follows", () => {
  it("gives every local a real fauna body and derives its icon from it", () => {
    const w = buildWilderness({ seed: 4, trees: 0, rocks: 0, creatures: 6 });
    const cast = wildLocalCast();
    expect(w.creatures).toHaveLength(6);
    for (const c of w.creatures) {
      expect(cast).toContain(c.bodySpecies);
      expect(c.icon).toBe(wildLocalIcon(c.bodySpecies!));
    }
  });

  it("keeps the scatter seed-deterministic", () => {
    const a = buildWilderness({ seed: 21, creatures: 5 });
    const b = buildWilderness({ seed: 21, creatures: 5 });
    expect(a.creatures).toEqual(b.creatures);
    expect(a.creatures.map((c) => c.bodySpecies)).not.toEqual(
      buildWilderness({ seed: 22, creatures: 5 }).creatures.map((c) => c.bodySpecies),
    );
  });

  it("takes the cast from the CALLER when one is supplied (the biome seam)", () => {
    const w = buildWilderness({ seed: 9, creatures: 4, locals: ["deer", "sheep"] });
    for (const c of w.creatures) expect(["deer", "sheep"]).toContain(c.bodySpecies);
  });

  it("leaves PRODUCT ANIMALS exactly as they were (species set, face empty)", () => {
    const w = buildWilderness({
      seed: 6,
      creatures: 0,
      mix: [{ species: "sheep", count: 2 }],
    });
    expect(w.creatures.map((c) => c.id)).toEqual(["wild_sheep_0", "wild_sheep_1"]);
    for (const c of w.creatures) {
      expect(c.species).toBe("sheep");
      expect(c.icon).toBe("");
      expect(c.bodySpecies).toBeUndefined();
      expect(wildAnimalBodyId(c)).toBe(`fauna:sheep:${c.id}`);
    }
  });
});

describe("homesteadWildMix — multiplier ⑤ (standing counts, and they are DIAL-FREE)", () => {
  // ⚖️ INVARIANCE (S3 review): wild counts are DIAL-FREE — abundance is not
  // conversion, so the dial seat never survived review into this signature.
  // These cases used to pass a third argument the function has never had (JS
  // ignored it, and tests are not typechecked), which read as a pin on a
  // parameter that did not exist; the third seat is now `climate`, so the
  // invariance is stated the only way it can be — the mix is a pure function
  // of (biome, seed), with no third input in the abundance story at all.
  it("counts depend on nothing but the biome and the seed", () => {
    expect(homesteadWildMix("farmland", 1)).toEqual(homesteadWildMix("farmland", 1));
    expect(homesteadWildMix("mining", 5)).toEqual(homesteadWildMix("mining", 5));
    const counts = homesteadWildMix("farmland", 1).map((e) => e.count);
    expect(counts).toEqual([8, 2, 4, 2, 1]); // oak, fruit, rock, sheep, cow
    expect(homesteadWildMix("mining", 5).map((e) => e.count)).toEqual([8, 2, 10]);
  });
});

// ── THE NICHE JOIN (2026-09-01) — what a scatter site plants ────────────────
// The bearer used to be picked off the FOOD vocabulary by seed alone, so a
// homestead could stand a banana in the snow. Both pick sites now read the
// GROWER'S query (products.ts `usefulPlants` — plants carrying a live
// renewable take), optionally filtered by the cell's climate. The no-climate
// arm is the legacy contract and must stay byte-identical: the headless bench
// transcripts byte-hold on it.
describe("the pick sites — usefulPlants, with and without a climate", () => {
  const TEMPERATE: ClimateSample = { rain: 1.0, tempC: 18, elevation: 0, fertility: 5 };

  it("no climate: the fruit is the seed's pick off the unfiltered grower's query", () => {
    // Stated as the FORMULA, not a literal species: the pin is that the
    // legacy arm still picks `(seed >>> 3) % rows.length` over the whole
    // list, whatever the catalogue happens to hold.
    const rows = usefulPlants();
    for (const seed of [0, 1, 9, 17, 1234567]) {
      const want = rows[(seed >>> 3) % rows.length]!.species;
      const mix = homesteadWildMix("farmland", seed);
      expect(mix.map((e) => e.species)).toEqual(["oak", want, "rock", "sheep", "cow"]);
      expect(homesteadWildMix("mining", seed).map((e) => e.species)).toEqual([
        "oak", want, "rock",
      ]);
    }
  });

  it("with a temperate sample the homestead never stands a banana — at any seed", () => {
    for (let seed = 0; seed <= 40; seed++) {
      const species = homesteadWildMix("farmland", seed, TEMPERATE).map((e) => e.species);
      expect(species).not.toContain("banana_plant");
      // …and something still bears: a filtered list is not an empty one here.
      expect(species.length).toBe(5);
    }
  });

  it("the climate arm picks from the FILTERED list, and only ever from it", () => {
    // ⚖️ THE FORMULA MOVED (2026-09-01, layer-1 completion): this case used to
    // pin `(seed >>> 3) % rows.length` on BOTH arms. The climate arm now
    // weights the pick by suitability (see the weighted-pick case below), so
    // what survives here is the part that is actually about the filter — the
    // bearer is always one of the rows this cell admits, at every seed. The
    // no-climate arm's modulo is pinned verbatim two cases up, where it
    // belongs: that is the arm the bench transcripts hold.
    const admitted = usefulPlants(TEMPERATE).map((s) => s.species);
    for (let seed = 0; seed <= 60; seed++) {
      expect(admitted).toContain(homesteadWildMix("farmland", seed, TEMPERATE)[1]!.species);
    }
  });

  it("dead ground bears nothing AND grazes nothing — never a fallback to the unfiltered mix", () => {
    const dead: ClimateSample = { rain: 0.05, tempC: -20, elevation: 100, fertility: 0 };
    expect(usefulPlants(dead)).toEqual([]);
    // ⚖️ THE LIVESTOCK JOINED THE FILTER (2026-09-01): sheep and cow declared
    // no niche until this round, so they used to stand on dead scree exactly
    // the way the banana used to — this case pinned that hole. Both rows now
    // have real windows and both close here, leaving the structural content
    // (the switch's oak and rock) untouched.
    expect(homesteadWildMix("farmland", 7, dead).map((e) => e.species)).toEqual(["oak", "rock"]);
    expect(homesteadWildMix("mining", 7, dead).map((e) => e.species)).toEqual(["oak", "rock"]);
  });

  it("wildMixForBiome keeps the legacy per-biome shape (forest = oak 10, fruit, rock 6)", () => {
    // MOVED HERE FROM TWO GAMES (2026-09-01): world-lab and nature-hike
    // carried byte-identical copies, both still calling the removed
    // `orchardPlants()`. The counts and the DEFAULT_BIOSPHERE biome indices
    // (0 barren / 1 tree / 2 grass / 3 horse) are the game copies' own.
    const forest = wildMixForBiome(1, 0);
    expect(forest.map((e) => e.species)).toEqual(["oak", usefulPlants()[0]!.species, "rock"]);
    expect(forest.map((e) => e.count)).toEqual([10, 2, 6]); // forest bears 2, elsewhere 1
    expect(wildMixForBiome(2, 0).map((e) => e.count)).toEqual([3, 1, 5, 2]);
    expect(wildMixForBiome(3, 0).map((e) => e.count)).toEqual([3, 1, 5, 2, 1]);
    expect(wildMixForBiome(2, 0).map((e) => e.species)).toContain("sheep");
    expect(wildMixForBiome(3, 0).map((e) => e.species)).toContain("cow");
  });

  it("barren (biome 0) never bears fruit, climate or no climate", () => {
    // The biome switch already said nothing grows; a climate that would
    // otherwise admit a bearer must not put one on bare scree.
    expect(wildMixForBiome(0, 3)).toEqual([{ species: "rock", count: 8 }]);
    expect(wildMixForBiome(0, 3, TEMPERATE)).toEqual([{ species: "rock", count: 8 }]);
  });

  it("faunaForBiome grazes the open biomes only", () => {
    expect(faunaForBiome(0)).toEqual({ horses: 0 });
    expect(faunaForBiome(1)).toEqual({ horses: 0 }); // closed forest
    expect(faunaForBiome(2)).toEqual({ horses: 4 });
    expect(faunaForBiome(3)).toEqual({ horses: 6 });
  });
});

// ── ⛏️ LAYER-1 COMPLETION (2026-09-01) — the climate arm gets honest ────────
// Round #46 filtered the FRUIT by climate and left everything else alone, so
// the arm was half-honest in two ways: the biome switch's livestock still
// stood wherever the switch named them (sheep and cow declared no niche at
// all), and a bearer that merely SCRAPED past the filter stood as often as the
// one that peaks here. Both are the same fix — ask `nicheSuitabilityOf`, the
// one uniform Layer-1 answer, and use the whole number rather than just its
// sign. Both live ONLY in the climate arm; the last case here re-asserts that.
describe("the climate arm — livestock filtering and the suitability-weighted pick", () => {
  const TEMPERATE: ClimateSample = { rain: 1.0, tempC: 18, elevation: 0, fertility: 5 };
  const MILD_STEPPE: ClimateSample = { rain: 0.5, tempC: 16, elevation: 0, fertility: 5 };
  /** Cold dry grassland — the sward the flock keeps and the herd cannot. */
  const FRIGID_DRY: ClimateSample = { rain: 0.3, tempC: -8, elevation: 0, fertility: 5 };
  const HOSTILE: ClimateSample = { rain: 0.05, tempC: -20, elevation: 100, fertility: 0 };

  it("grazer range on a MILD steppe carries both flock and herd (the control)", () => {
    const mix = wildMixForBiome(3, 0, MILD_STEPPE);
    expect(mix.map((e) => e.species)).toContain("sheep");
    expect(mix.map((e) => e.species)).toContain("cow");
    // The switch's own counts are untouched by a filter that keeps a row.
    expect(mix.find((e) => e.species === "sheep")!.count).toBe(2);
    expect(mix.find((e) => e.species === "cow")!.count).toBe(1);
  });

  it("🎯 a FRIGID steppe keeps the sheep and drops the cattle", () => {
    // THE HEADLINE CASE. The biome index says "grazer range — flocks and wild
    // cattle", which is true of the CLASS of ground; this particular cell is a
    // Mongolian winter, and the class cannot know that. Nothing grows here at
    // all either (every bearer freezes out), so there is no fruit line.
    expect(usefulPlants(FRIGID_DRY)).toEqual([]);
    expect(wildMixForBiome(3, 0, FRIGID_DRY)).toEqual([
      { species: "oak", count: 3 },
      { species: "rock", count: 5 },
      { species: "sheep", count: 2 },
    ]);
    // Steppe (biome 2) never listed cattle to begin with — the flock stands.
    expect(wildMixForBiome(2, 0, FRIGID_DRY).map((e) => e.species)).toEqual([
      "oak", "rock", "sheep",
    ]);
    // …and the homestead does the same thing off its LAND-USE label: a
    // charter's "farmland" says a holding keeps animals, never which ones.
    expect(homesteadWildMix("farmland", 0, FRIGID_DRY).map((e) => e.species)).toEqual([
      "oak", "rock", "sheep",
    ]);
  });

  it("hostile ground drops BOTH animals and leaves oak/rock counts alone", () => {
    // The filter removes lines; it never rewrites the ones it keeps. Structural
    // content (what the biome switch says the ground IS) is not re-litigated.
    expect(wildMixForBiome(3, 0, HOSTILE)).toEqual([
      { species: "oak", count: 3 },
      { species: "rock", count: 5 },
    ]);
    expect(wildMixForBiome(1, 0, HOSTILE)).toEqual([
      { species: "oak", count: 10 },
      { species: "rock", count: 6 },
    ]);
    expect(homesteadWildMix("mining", 0, HOSTILE)).toEqual([
      { species: "oak", count: 8 },
      { species: "rock", count: 10 },
    ]);
  });

  it("a nicheless / uncatalogued entry passes through — the band convention", () => {
    // `rock` declares no niche (stone is substrate) and must survive the most
    // hostile sample there is; that is the same convention that lets a future
    // row join without declaring anything.
    expect(wildMixForBiome(0, 3, HOSTILE)).toEqual([{ species: "rock", count: 8 }]);
  });

  it("🎯 the pick is SUITABILITY-WEIGHTED: a range-edge plant is RARE here, not equally likely", () => {
    const rows = usefulPlants(TEMPERATE);
    const weightOf = (species: string): number =>
      nicheSuitabilityOf(naturalSourceOf(species)!, TEMPERATE);
    const ranked = [...rows].sort((a, b) => weightOf(a.species) - weightOf(b.species));
    const marginal = ranked[0]!.species;
    const peak = ranked[ranked.length - 1]!.species;
    expect(weightOf(marginal)).toBeLessThan(weightOf(peak));

    const counts: Record<string, number> = {};
    for (let seed = 0; seed <= 60; seed++) {
      const s = homesteadWildMix("farmland", seed, TEMPERATE)[1]!.species;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    // The whole point: admission is not abundance. The plant clinging to its
    // range edge here appears strictly less often than the one that peaks.
    expect(counts[marginal] ?? 0).toBeLessThan(counts[peak] ?? 0);
    // A ZERO-weight plant is not rare, it is impossible — filtered before the
    // walk, and stepped over by the walk even if it were not.
    expect(nicheSuitabilityOf(naturalSourceOf("banana_plant")!, TEMPERATE)).toBe(0);
    expect(counts["banana_plant"] ?? 0).toBe(0);
    // …and the weighting BITES: at least one seed answers differently from the
    // uniform modulo the no-climate arm still uses.
    const uniform = (seed: number): string => rows[(seed >>> 3) % rows.length]!.species;
    const moved = Array.from({ length: 61 }, (_, seed) => seed).some(
      (seed) => homesteadWildMix("farmland", seed, TEMPERATE)[1]!.species !== uniform(seed),
    );
    expect(moved).toBe(true);
  });

  it("deterministic per (seed, climate) — the same cell answers the same species forever", () => {
    for (const seed of [0, 3, 11, 64, 1234567]) {
      expect(homesteadWildMix("farmland", seed, TEMPERATE)).toEqual(
        homesteadWildMix("farmland", seed, TEMPERATE),
      );
      expect(wildMixForBiome(3, seed, MILD_STEPPE)).toEqual(
        wildMixForBiome(3, seed, MILD_STEPPE),
      );
      // No rng, no clock: the pick is a pure hash of the seed walked over the
      // cell's own weights, so two callers standing on one cell agree.
      expect(homesteadWildMix("farmland", seed, MILD_STEPPE)[1]!.species).toBe(
        wildMixForBiome(3, seed, MILD_STEPPE)[1]!.species,
      );
    }
  });

  it("⚖️ NOTHING REACHABLE WITHOUT A CLIMATE MOVED — the bench law, re-asserted", () => {
    // The headless text harness founds with `homesteadWildMix(biome, seed)` and
    // no third argument at all, and its transcripts byte-hold below the fence.
    // Neither the animal filter nor the weighted pick may be reachable from a
    // call that passed no sample — so the legacy arm is re-pinned here, whole:
    // the modulo over the UNFILTERED grower's query, every switch line intact.
    const rows = usefulPlants();
    for (let seed = 0; seed <= 60; seed++) {
      const want = rows[(seed >>> 3) % rows.length]!.species;
      expect(homesteadWildMix("farmland", seed).map((e) => e.species)).toEqual([
        "oak", want, "rock", "sheep", "cow",
      ]);
      expect(homesteadWildMix("mining", seed).map((e) => e.species)).toEqual([
        "oak", want, "rock",
      ]);
      expect(wildMixForBiome(1, seed).map((e) => e.species)).toEqual(["oak", want, "rock"]);
      expect(wildMixForBiome(2, seed).map((e) => e.species)).toEqual([
        "oak", want, "rock", "sheep",
      ]);
      expect(wildMixForBiome(3, seed).map((e) => e.species)).toEqual([
        "oak", want, "rock", "sheep", "cow",
      ]);
      expect(wildMixForBiome(0, seed)).toEqual([{ species: "rock", count: 8 }]);
    }
    // Counts too — the filter is the only new step and it never runs here.
    expect(homesteadWildMix("farmland", 1).map((e) => e.count)).toEqual([8, 2, 4, 2, 1]);
    expect(homesteadWildMix("mining", 5).map((e) => e.count)).toEqual([8, 2, 10]);
    expect(wildMixForBiome(1, 0).map((e) => e.count)).toEqual([10, 2, 6]);
    expect(wildMixForBiome(3, 0).map((e) => e.count)).toEqual([3, 1, 5, 2, 1]);
  });
});

// The regrow calculators are PURE — the host applies their results to its
// live stock copy. An apple tree (regrowDays 1) at day-length 100 s.
const DAY = 100;
const appleTree = (): WildernessFeature => ({
  id: "wild:apple_tree_0",
  species: "apple_tree",
  x: 0,
  y: 0,
  stock: { apple: 2, wood: 1 },
  harvestCap: { apple: 2 },
});

describe("live-harvest regrow (dueHarvestRegrowth / armHarvestRegrow)", () => {
  it("a live take arms the clock one regrow period out; kill glyphs never arm", () => {
    const f = appleTree();
    armHarvestRegrow(f, "wood", 10, DAY); // kill glyph — no-op
    expect(f.regrowAt).toBeUndefined();
    armHarvestRegrow(f, "apple", 10, DAY);
    expect(f.regrowAt).toEqual({ apple: 10 + DAY });
    // A second take during regrowth keeps the standing cadence.
    armHarvestRegrow(f, "apple", 50, DAY);
    expect(f.regrowAt).toEqual({ apple: 10 + DAY });
  });

  it("nothing matures before the deadline; one unit per period after it", () => {
    const f = appleTree();
    armHarvestRegrow(f, "apple", 0, DAY);
    expect(dueHarvestRegrowth(f, { apple: 1, wood: 1 }, DAY - 1, DAY)).toBeNull();
    const due = dueHarvestRegrowth(f, { apple: 1, wood: 1 }, DAY, DAY);
    expect(due).not.toBeNull();
    expect(due!.add).toEqual({ apple: 1 });
    // Back at capacity (1 + 1 = cap 2) — the ledger entry retires.
    expect(due!.regrowAt).toEqual({});
  });

  it("a long absence catches up whole periods but stops at capacity", () => {
    const f = appleTree();
    armHarvestRegrow(f, "apple", 0, DAY);
    // Picked clean (live stock 0), away for 10 periods: refills to cap 2, not 10.
    const due = dueHarvestRegrowth(f, { apple: 0, wood: 1 }, 10 * DAY, DAY);
    expect(due!.add).toEqual({ apple: 2 });
    expect(due!.regrowAt).toEqual({});
  });

  it("below capacity, the ledger advances to the next deadline", () => {
    const f = appleTree();
    f.harvestCap = { apple: 3 };
    armHarvestRegrow(f, "apple", 0, DAY);
    // One period elapsed, two units short of cap: one matures, next is due a period later.
    const due = dueHarvestRegrowth(f, { apple: 1, wood: 1 }, DAY, DAY);
    expect(due!.add).toEqual({ apple: 1 });
    expect(due!.regrowAt).toEqual({ apple: 2 * DAY });
  });

  it("an unarmed feature has nothing pending", () => {
    expect(dueHarvestRegrowth(appleTree(), { apple: 2, wood: 1 }, 1e9, DAY)).toBeNull();
  });
});

describe("embodiment rule — bodyHeightM is the data flip", () => {
  it("a plant with bodyHeightM stands as a grown flora body; minerals stay boxes", () => {
    const apple = appleTree();
    expect(wildFeatureEmbodied(apple)).toBe(true);
    expect(wildFeatureContainerId(apple)).toBe("flora:apple_tree:wild:apple_tree_0");
    // OAK embodied (one tree authority, 2026-07-30): a wild oak stands as a
    // real grown body — the same species the flora streaming field renders,
    // so a session twin materializing under a suppressed scenery instance IS
    // the same tree. Still purely the bodyHeightM data flip, never a name rule.
    const oak: WildernessFeature = { id: "wild:oak_0", species: "oak", x: 0, y: 0, stock: { wood: 3 } };
    const rock: WildernessFeature = { id: "wild:rock_0", species: "rock", x: 0, y: 0, stock: { stone: 1 } };
    expect(wildFeatureEmbodied(oak)).toBe(true);
    expect(wildFeatureContainerId(oak)).toBe("flora:oak:wild:oak_0");
    expect(wildFeatureEmbodied(rock)).toBe(false); // minerals never embody
  });
});

// ── S&D S3 H2 — THE TIMBER GROWTH CLOCK ─────────────────────────────────────
const oakGrowth = () => naturalSourceOf("oak")!.growth!;
const oakFeature = (over: Partial<WildernessFeature> = {}): WildernessFeature => ({
  id: "wild:oak_0", species: "oak", x: 0, y: 0, stock: { wood: 16 }, ...over,
});

describe("growthClassPeriodS — real years → game seconds, the generation family precedent", () => {
  it("at REAL_SCALE, dividing evenly across the classes", () => {
    const g = oakGrowth();
    const steps = g.classes.length - 1;
    const period = growthClassPeriodS(REAL_SCALE, g);
    // REAL_SCALE: dayLengthS = 86400, generation = 1, so this is just
    // (maturityYears / steps) real years, in seconds.
    expect(period).toBeCloseTo((g.maturityYears / steps) * 365.25 * 86400, 0);
  });

  it("generation compresses it — a faster-aging world grows its trees faster too", () => {
    const g = oakGrowth();
    const fast = { ...REAL_SCALE, generation: 10 };
    expect(growthClassPeriodS(fast, g)).toBeCloseTo(growthClassPeriodS(REAL_SCALE, g) / 10, 3);
  });

  it("resourceCompression never enters it — orthogonal to the growth clock", () => {
    const g = oakGrowth();
    const dialed = { ...REAL_SCALE, resourceCompression: 50 };
    expect(growthClassPeriodS(dialed, g)).toBeCloseTo(growthClassPeriodS(REAL_SCALE, g), 3);
  });
});

describe("dueGrowthAdvance — the sibling of dueHarvestRegrowth, size classes not units", () => {
  const PERIOD = 100;

  it("null: no growAt armed, or the species has no growth clock", () => {
    expect(dueGrowthAdvance(oakFeature(), 1e9, PERIOD)).toBeNull();
    const rock: Pick<WildernessFeature, "species" | "sizeClass" | "growAt"> =
      { species: "rock", sizeClass: 0, growAt: 0 };
    expect(dueGrowthAdvance(rock, 1e9, PERIOD)).toBeNull();
  });

  it("nothing matures before the deadline; one class per period after it", () => {
    const f = oakFeature({ sizeClass: 0, growAt: 100 });
    expect(dueGrowthAdvance(f, 99, PERIOD)).toBeNull();
    const due = dueGrowthAdvance(f, 100, PERIOD);
    expect(due).not.toBeNull();
    expect(due!.sizeClass).toBe(1); // sapling → young
    expect(due!.growAt).toBe(200); // still below mature (3 classes: 0,1,2)
    expect(due!.stock.wood).toBe(growthYieldAt("oak", 1)); // young's yield
  });

  it("a long absence catches up whole classes but STOPS AT MATURE, clock retires", () => {
    const f = oakFeature({ sizeClass: 0, growAt: 100 });
    const due = dueGrowthAdvance(f, 100_000, PERIOD);
    expect(due!.sizeClass).toBe(2); // mature — the last class
    expect(due!.growAt).toBeUndefined(); // retired, exactly like a full harvest ledger
    expect(due!.stock.wood).toBe(growthYieldAt("oak", 2));
  });

  it("LARGER-FIRST ordering data: stock REPLACES, never accumulates", () => {
    // A felled-then-regrown tree's wood is a function of its CURRENT class,
    // not a running total — the same "size means units left" law
    // wildFeatureRadius states for depletion, read forward for growth.
    const f = oakFeature({ sizeClass: 0, growAt: 100, stock: { wood: 999 } });
    const due = dueGrowthAdvance(f, 100, PERIOD)!;
    expect(due.stock.wood).toBe(growthYieldAt("oak", 1));
    expect(due.stock.wood).not.toBe(999 + growthYieldAt("oak", 1));
  });
});

function growthYieldAt(species: string, cls: number, dial = 1): number {
  const src = naturalSourceOf(species)!;
  const p = src.products.find((q) => q.method === "kill")!;
  const mid = (p.yield.min + p.yield.max) / 2;
  return Math.max(0, Math.round(mid * src.growth!.classes[cls]!.yieldMul * dial));
}

describe("reseedGrowthStock — the fell→sapling replacement", () => {
  it("class 0 (sapling): zero wood, at dial 1 or any dial", () => {
    expect(reseedGrowthStock("oak", oakGrowth())).toEqual({ wood: 0 });
    expect(reseedGrowthStock("oak", oakGrowth(), 5)).toEqual({ wood: 0 }); // 0 × 5 = 0
  });

  it("only kill glyphs — a fruit tree's harvest glyph is untouched here", () => {
    const stock = reseedGrowthStock("apple_tree", naturalSourceOf("apple_tree")!.growth!);
    expect(stock).toEqual({ wood: 0 });
    expect(stock.apple).toBeUndefined();
  });
});

describe("wildFeatureSizeRank — LARGER TREES CUT FIRST (user law, verbatim)", () => {
  it("unset sizeClass (never felled) ranks as MATURE — the most negative key", () => {
    const mature = oakFeature(); // sizeClass unset
    const sapling = oakFeature({ sizeClass: 0 });
    expect(wildFeatureSizeRank(mature)).toBeLessThan(wildFeatureSizeRank(sapling));
  });

  it("a bigger class always outranks (sorts first under an ascending comparator)", () => {
    const young = oakFeature({ sizeClass: 1 });
    const sapling = oakFeature({ sizeClass: 0 });
    expect(wildFeatureSizeRank(young)).toBeLessThan(wildFeatureSizeRank(sapling));
  });

  it("a species with no growth clock (rock) has NO size preference — always 0", () => {
    const rock: WildernessFeature = { id: "wild:rock_0", species: "rock", x: 0, y: 0, stock: { stone: 1 } };
    expect(wildFeatureSizeRank(rock)).toBe(0);
    expect(wildFeatureSizeRank({ ...rock, sizeClass: 3 })).toBe(0);
  });
});
