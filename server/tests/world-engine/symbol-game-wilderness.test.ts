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
  growthClassPeriodS,
  homesteadWildMix,
  reseedGrowthStock,
  wildAnimalBodyId,
  wildFeatureContainerId,
  wildFeatureEmbodied,
  wildFeatureRadius,
  wildFeatureSizeRank,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { naturalSourceOf } from "@shared/world-engine/products.js";
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

describe("homesteadWildMix — multiplier ⑤ (the dial, the same × direction as yield)", () => {
  it("dial 1 (default AND explicit) is byte-identical", () => {
    expect(homesteadWildMix("farmland", 1)).toEqual(homesteadWildMix("farmland", 1, 1));
    expect(homesteadWildMix("mining", 5)).toEqual(homesteadWildMix("mining", 5, 1));
  });

  it("⚖️ INVARIANCE (S3 review): counts are dial-free — abundance is not conversion", () => {
    const base = homesteadWildMix("farmland", 1);
    expect(homesteadWildMix("farmland", 1, 2)).toEqual(base);
    expect(homesteadWildMix("farmland", 1, 0.01)).toEqual(base);
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
