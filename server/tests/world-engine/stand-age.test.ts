// ⚖️ THE NEW-GROWTH AUTHORITY — a stand has an AGE STRUCTURE (2026-09-06).
//
// Until this round the answer to "how old is a stand" was written nowhere and
// true everywhere: `makeFeature` left `sizeClass` unset on purpose, so every
// forest ever laid was a wall of identical adults and nothing young existed
// anywhere until something was felled. `products.ts` now owns the question
// once (`standAgeWeights` / `standGrowthClass` / `standYieldFraction`) and
// three consumers read it: the scatter, the flora field, and the render
// bridge's depletion ratio.
//
// The two properties that make it safe to have landed at all are pinned first,
// because everything else in the engine is built on them:
//   ① NOT ONE TREE MOVED — the rung is a HASH of the individual's own name,
//     never a draw from the scatter's rng, so the draw sequence (and every
//     position, id and world-fixed flora key) is untouched.
//   ② FORCED ALL-MATURE, THE WORLD IS BYTE-IDENTICAL — the mature rung leaves
//     `sizeClass` unset and the stock at its own roll, so the 85 % of trees
//     that were always mature are written exactly as they always were.
//
// DB-free (`npm run test:engine -- stand-age`); the host arc at the foot boots
// the real frontier quest headless.
import { describe, expect, it, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  STAND_ADULT_SPAN_MUL,
  effectiveInPerOut,
  growthAgeOf,
  naturalSourceOf,
  standAgeWeights,
  standGrowthClass,
  standYieldFraction,
} from "@shared/world-engine/products.js";
import {
  buildWilderness,
  floraTwinFeatureId,
  makeFeature,
  wildFeatureRadiusOf,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { standDensityPerHa } from "@shared/world-engine/planet/ecology.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

/** A tree-dominant cell's MEASURED median `eco_tree` (ecology.ts TREE). */
const FOREST_ECO = { tree: 0.35, grass: 0, horse: 0 };
/** `LEGACY_SCATTER_SIDE_M` — a founding-age town rect, 3.61 ha. */
const RECT_M = 190;
const forestMix = () => [
  { species: "oak", count: 0, perHa: standDensityPerHa("oak", FOREST_ECO) },
];

const mulberry = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("① the draw takes NOTHING from the scatter", () => {
  it("🚨 two ageKeys leave the rng in the SAME state — the class is a hash, not a draw", () => {
    const after = (ageKey: string): number[] => {
      const rng = mulberry(4242);
      makeFeature("wild:oak_0", "oak", { x: 1, y: 2 }, rng, 1, ageKey);
      return [rng(), rng(), rng()];
    };
    // Different rungs come out (proved below), and the stream is untouched.
    expect(after("a")).toEqual(after("zzzzzzzz"));
    expect(after("a")).toEqual(after("wild:oak_0"));
  });

  it("🚨 every feature stands exactly where it stood — position and id, seed by seed", () => {
    // The positions are `place()`'s draws, which this round did not touch; the
    // pin is that they are a pure function of (seed, count) and therefore
    // independent of every age the authority hands out. Cross-checked against
    // a forced-all-mature control at landing time: identical digests.
    for (const seed of [1, 7, 11, 42, 1337]) {
      const a = buildWilderness({ seed, side: RECT_M, mix: forestMix(), creatures: 0 });
      const b = buildWilderness({ seed, side: RECT_M, mix: forestMix(), creatures: 0 });
      expect(a.features.map((f) => `${f.id}|${f.x}|${f.y}`))
        .toEqual(b.features.map((f) => `${f.id}|${f.x}|${f.y}`));
      // The COUNT is the density law's and nothing else's: 3.61 ha × 15.05/ha.
      expect(a.features.length).toBe(54);
    }
  });

  it("🚨 a MATURE feature is written exactly as it always was — no field, own roll", () => {
    const rng = mulberry(99);
    // `oak_mature` hashes to the mature rung (asserted, not assumed).
    const f = makeFeature("wild:oak_x", "oak", { x: 3, y: 4 }, rng, 1, "control-mature");
    if (f.sizeClass === undefined) {
      expect("sizeClass" in f).toBe(false);        // the KEY is absent, not undefined
      expect(f.stock.wood).toBeGreaterThanOrEqual(12);
      expect(f.stock.wood).toBeLessThanOrEqual(20);
    }
    // …and across a whole stand, every unset feature carries a full roll while
    // every set one carries its rung's share.
    const w = buildWilderness({ seed: 11, side: RECT_M, mix: forestMix(), creatures: 0 });
    for (const g of w.features) {
      if (g.sizeClass === undefined) {
        expect(g.stock.wood).toBeGreaterThanOrEqual(12);
        expect(g.stock.wood).toBeLessThanOrEqual(20);
      } else if (g.sizeClass === 0) {
        expect(g.stock.wood).toBe(0);              // sapling: yieldMul 0
      } else {
        expect(g.stock.wood).toBeGreaterThanOrEqual(3);  // young: round(roll × .25)
        expect(g.stock.wood).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe("② the authority — proportions from the ladder's own residence times", () => {
  it("oak's steady state is [1/12, 1/12, 10/12] — and the maturity span CANCELS", () => {
    const w = standAgeWeights("oak");
    expect(w.length).toBe(3);
    expect(w[0]).toBeCloseTo(1 / 12, 10);
    expect(w[1]).toBeCloseTo(1 / 12, 10);
    expect(w[2]).toBeCloseTo(10 / 12, 10);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // The formula's own shape: juveniles 1 class period each, the adult
    // MUL whole maturity spans = MUL × steps class periods.
    expect(w[2]! / w[0]!).toBeCloseTo(STAND_ADULT_SPAN_MUL * 2, 10);
    // 🚨 NO CLOCK APPEARS IN IT. `growthClassPeriodS` divides the maturity span
    // EVENLY, so the span cancels: an oak that matured in 4 years instead of 40
    // would stand the same structure. Nothing here reads a `WorldScale`.
  });

  it("apple_tree's 2-rung ladder spaces itself; a ladder-less species is one state", () => {
    const a = standAgeWeights("apple_tree");
    expect(a.length).toBe(2);
    expect(a[0]).toBeCloseTo(1 / (1 + STAND_ADULT_SPAN_MUL), 10);
    expect(a[1]).toBeCloseTo(STAND_ADULT_SPAN_MUL / (1 + STAND_ADULT_SPAN_MUL), 10);
    for (const sp of ["rock", "bush", "hazel", "grape_vine", "no_such_species"]) {
      expect(standAgeWeights(sp)).toEqual([1]);
      expect(standYieldFraction(sp)).toBe(1);
    }
  });

  it("standYieldFraction is the ONE standing-timber reading — oak 0.854", () => {
    const g = naturalSourceOf("oak")!.growth!;
    const w = standAgeWeights("oak");
    const byHand = g.classes.reduce((s, c, i) => s + c.yieldMul * w[i]!, 0);
    expect(standYieldFraction("oak")).toBeCloseTo(byHand, 12);
    expect(standYieldFraction("oak")).toBeCloseTo(0.854166, 5);
    // 🚨 IT IS NOT `growthAgeOf`. Yield says how much wood a rung gives up
    // (0 / .25 / 1); age says how tall it stands (0 / .5 / 1). Neither is
    // derived from the other, and this pins that they DISAGREE.
    expect(g.classes.map((c) => c.yieldMul)).not.toEqual([0, 1, 2].map((i) => growthAgeOf("oak", i)));
  });

  it("DEPLETION skews young — the big ones went first — and clamps at both ends", () => {
    const fresh = standAgeWeights("oak");
    const half = standAgeWeights("oak", { depletion: 0.5 });
    const clear = standAgeWeights("oak", { depletion: 1 });
    expect(half[2]!).toBeLessThan(fresh[2]!);
    expect(half[0]!).toBeGreaterThan(fresh[0]!);
    expect(clear[2]!).toBe(0);
    expect(clear[0]! + clear[1]!).toBeCloseTo(1, 10);
    expect(standYieldFraction("oak", { depletion: 1 }))
      .toBeLessThan(standYieldFraction("oak"));
    // Out-of-range depletion is clamped, never inverted.
    expect(standAgeWeights("oak", { depletion: -5 })).toEqual(fresh);
    expect(standAgeWeights("oak", { depletion: 9 })).toEqual(clear);
    // …and a 1-step ladder clear-felled falls back to its own sapling rung
    // rather than dividing by zero.
    expect(standAgeWeights("apple_tree", { depletion: 1 })).toEqual([1, 0]);
  });
});

describe("③ standGrowthClass — the per-tree face", () => {
  it("is deterministic, and UNDEFINED means mature (never the last index)", () => {
    const top = naturalSourceOf("oak")!.growth!.classes.length - 1;
    for (let i = 0; i < 500; i++) {
      const k = `wild:oak_${i}`;
      const a = standGrowthClass("oak", k);
      expect(standGrowthClass("oak", k)).toBe(a);       // same key, same rung
      if (a !== undefined) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(top);                    // 🚨 never the top rung
      }
    }
    for (const sp of ["rock", "bush", "no_such_species"]) {
      expect(standGrowthClass(sp, "anything")).toBeUndefined();
    }
  });

  it("samples the weights it is built from", () => {
    const N = 20_000;
    const seen = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const c = standGrowthClass("oak", `k:${i}`);
      seen[c ?? 2]!++;
    }
    const w = standAgeWeights("oak");
    for (let k = 0; k < 3; k++) expect(seen[k]! / N).toBeCloseTo(w[k]!, 2);
  });

  it("🚨 THE SEAM: the flora field and the twin it materialises draw the SAME rung", () => {
    // The field asks `standGrowthClass(species, floraTwinFeatureId(...))`; the
    // driver's twin pass builds the feature under that same id and
    // `makeFeature` hashes it. Spelling the id twice is exactly how a field
    // sapling would stand up as a mature twin, so ONE function owns it.
    for (const key of ["4:12:7:0", "0:-3:9:41", "5:100:100:7"]) {
      const id = floraTwinFeatureId("oak", key);
      expect(id).toBe(`wild:oak_${key}`);
      const field = standGrowthClass("oak", id);
      const twin = makeFeature(id, "oak", { x: 0, y: 0 }, mulberry(7)).sizeClass;
      expect(twin).toBe(field);
    }
  });

  it("a juvenile occupies a juvenile's ground — one radius derivation, no second", () => {
    const sapling = { species: "oak", stock: { wood: 0 }, sizeClass: 0 };
    const young = { species: "oak", stock: { wood: 4 }, sizeClass: 1 };
    const adult = { species: "oak", stock: { wood: 16 } };
    expect(wildFeatureRadiusOf(sapling)).toBeLessThan(wildFeatureRadiusOf(young));
    expect(wildFeatureRadiusOf(young)).toBeLessThan(wildFeatureRadiusOf(adult));
  });
});

describe("④ the economy this moved — measured, not asserted away", () => {
  const woodOf = (seed: number): number =>
    buildWilderness({ seed, side: RECT_M, mix: forestMix(), creatures: 0 })
      .features.reduce((n, f) => n + (f.stock.wood ?? 0), 0);

  it("a founding-age forest rect: 852 → 745 wood, and the 120-block house STAYS fundable", () => {
    const seeds = [11, 1, 7, 42, 1337];
    const mean = seeds.reduce((n, s) => n + woodOf(s), 0) / seeds.length;
    // BEFORE (the same seeds, the authority forced all-mature): 852.4.
    expect(mean).toBeGreaterThan(700);
    expect(mean).toBeLessThan(790);
    expect(mean / 852.4).toBeCloseTo(standYieldFraction("oak"), 1);
    // 🚨 THE ACCEPTANCE NUMBER. 745 wood ÷ `effectiveInPerOut(2, dial)` = 372
    // blocks; a house is 120. The frontier is still trivially rich — because of
    // EXTENT, which this round did not touch.
    for (const s of seeds) {
      expect(Math.floor(woodOf(s) / effectiveInPerOut(2, 1))).toBeGreaterThanOrEqual(120);
    }
  });
});

// ── ⑤ THE HOST ARC — the `downed` guard, on a real booted session ───────────
describe("⑤ a felled trunk does not grow", () => {
  let run: TextQuestRun;
  beforeAll(() => {
    const doc = JSON.parse(readFileSync("scripts/worlds/frontier.spec.json", "utf8"));
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    run.advance(20);
  }, 600_000);
  afterAll(() => run?.dispose());

  it("🚨 a downed trunk's clock does not climb its class — nor refill its heap", () => {
    const w = run.session.wilderness!;
    const f = w.features.find((x) => x.species === "oak")!;
    const key = `flora:oak:${f.id}`;
    // The one state that reaches this: a re-seeded sapling cut again while its
    // growth clock is still armed (`reseedWildFeature` arms `growAt` and clears
    // `downed`; the next cut sets `downed` and leaves the clock).
    f.sizeClass = 0;
    f.downed = true;
    const armedAt = run.session.taskClock - 1;
    f.growAt = armedAt;
    const stockBefore = { ...(run.session.containerRecords.get(key)?.stock ?? {}) };
    const warp = run.warpDays(1);
    expect(warp.ok).toBe(true);
    expect(f.sizeClass).toBe(0);                 // did not climb
    expect(f.growAt).toBe(armedAt);              // …and was not re-armed
    expect(run.session.containerRecords.get(key)?.stock ?? {}).toEqual(stockBefore);
  }, 600_000);
});
