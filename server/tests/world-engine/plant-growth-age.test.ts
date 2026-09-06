// PLANTS GROW LIKE PLANTS — the age function on a growth blueprint
// (creatures/growth.ts `ageGrowth`) and the ONE OWNER of "how old is this
// tree" (products.ts `growthAgeOf`).
//
// User 2026-09-06, verbatim: *"trees don't really grow visually, they appear
// fully-grown… While just scaling them would be the simple approach, ideally
// they should grow in the manner of real plants - starting as a shoot and
// then branching out."*
//
// PURE — no session, no DB, no THREE, no GL. Everything asserted here is
// arithmetic on blueprints and the generator's own deterministic structure,
// which is exactly the point: the generator was UNPINNED before this file
// (no test imported generateGrowth or the GROWTH_*_RANGES), and an age
// parameter is only safe to add to an unpinned generator if the adult is
// provably untouched.
//
// The four laws:
//   1. age ≥ 1 is IDENTITY — the same object, and the same generated
//      structure. Every plant drawn before ageing existed is byte-identical.
//   2. Growth is MONOTONE — nothing shrinks as a plant gets older.
//   3. An aged blueprint is a LEGAL blueprint — inside GROWTH_*_RANGES, so
//      clamp/validate cannot disagree with it.
//   4. A sapling is the adult's OWN first branches (the path-hash prune),
//      NOT a uniformly scaled copy of the adult — the thing the user
//      explicitly rejected.

import { describe, it, expect } from "@jest/globals";
import {
  ageGrowth,
  ageGrowths,
  clampGrowth,
  generateGrowth,
  growthHeightFactor,
  growthLevelsAt,
  growthValidationErrors,
  GROWTH_STEM_RANGES,
  type GrowthBlueprint,
  type GrowthSegment,
} from "@shared/world-engine/creatures/growth.js";
import { speciesBlueprint } from "@shared/world-engine/creatures/species.js";
import { growthAgeOf } from "@shared/world-engine/products.js";

/** The plant species whose bodies the wilderness and the orchards stand.
 *  Every law below is asserted over ALL of them, not just the oak. */
const PLANTS = ["oak", "apple_tree", "bush", "grass", "saguaro", "hazel"] as const;

/** A plant's single growth, as the game builds it (clamped). */
function growthOf(species: string): GrowthBlueprint {
  const bp = speciesBlueprint(species);
  expect(bp.growths.length).toBeGreaterThan(0);
  return bp.growths[0];
}

/** The plant nub torso every plant blueprint standardizes on. */
const NUB_M = 0.1;

const AGES = [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.99];

/** Same growth with only `branching.levels` changed — the STRUCTURAL half
 *  of ageing, isolated. */
function withLevels(g: GrowthBlueprint, levels: number): GrowthBlueprint {
  return { ...g, branching: { ...g.branching, levels } };
}

const segKey = (s: GrowthSegment): string =>
  `${s.level}|${s.parent}|${s.a.x},${s.a.y},${s.a.z}|${s.b.x},${s.b.y},${s.b.z}|${s.radiusA}|${s.radiusB}`;

describe("ageGrowth — the adult is untouched", () => {
  it("returns the SAME OBJECT at age 1 (identity, not a lerp landing on 1)", () => {
    for (const id of PLANTS) {
      const g = growthOf(id);
      expect(ageGrowth(g, 1)).toBe(g);
    }
  });

  it("returns the same object above 1, and for a non-finite age", () => {
    const g = growthOf("oak");
    expect(ageGrowth(g, 1.5)).toBe(g);
    expect(ageGrowth(g, Number.POSITIVE_INFINITY)).toBe(g);
    expect(ageGrowth(g, Number.NaN)).toBe(g);
  });

  it("generates a byte-identical structure at age 1", () => {
    for (const id of PLANTS) {
      const g = growthOf(id);
      expect(generateGrowth(ageGrowth(g, 1), NUB_M)).toEqual(generateGrowth(g, NUB_M));
    }
  });

  it("ageGrowths returns the blueprint ITSELF at age 1 (no fresh object per body)", () => {
    const bp = speciesBlueprint("oak");
    expect(ageGrowths(bp, 1)).toBe(bp);
    expect(ageGrowths(bp, 0.5)).not.toBe(bp);
    expect(ageGrowths(bp, 0.5).growths[0].branching.levels).toBe(2);
    // A view, never an edit: the authored blueprint is not mutated.
    expect(bp.growths[0].branching.levels).toBe(3);
  });

  it("does not touch the seed — a plant keeps its identity as it grows", () => {
    const g = growthOf("oak");
    for (const a of AGES) expect(ageGrowth(g, a).seed).toBe(g.seed);
  });
});

describe("ageGrowth — growth is monotone", () => {
  it("never shrinks: height, girth, flare, leaves and levels all rise with age", () => {
    for (const id of PLANTS) {
      const g = growthOf(id);
      let prev = ageGrowth(g, 0);
      for (const a of [...AGES.slice(1), 1]) {
        const now = ageGrowth(g, a);
        expect(now.stem.lengthFrac).toBeGreaterThanOrEqual(prev.stem.lengthFrac);
        expect(now.stem.girth).toBeGreaterThanOrEqual(prev.stem.girth);
        expect(now.stem.rootFlare).toBeGreaterThanOrEqual(prev.stem.rootFlare);
        expect(now.stem.hardness).toBeGreaterThanOrEqual(prev.stem.hardness);
        expect(now.foliage.leafDensity).toBeGreaterThanOrEqual(prev.foliage.leafDensity);
        expect(now.branching.levels).toBeGreaterThanOrEqual(prev.branching.levels);
        // A shoot branches LATE; the first branches move DOWN the stem as
        // the crown fills in.
        expect(now.branching.branchStart).toBeLessThanOrEqual(prev.branching.branchStart + 1e-12);
        prev = now;
      }
    }
  });

  it("the generated body is taller and has more segments with age", () => {
    const g = growthOf("oak");
    let prevLen = 0;
    let prevSegs = 0;
    for (const a of [...AGES, 1]) {
      const st = generateGrowth(ageGrowth(g, a), NUB_M);
      expect(st.lengthM).toBeGreaterThanOrEqual(prevLen);
      expect(st.segments.length).toBeGreaterThanOrEqual(prevSegs);
      prevLen = st.lengthM;
      prevSegs = st.segments.length;
    }
  });

  it("growthHeightFactor runs from a shoot to the adult", () => {
    expect(growthHeightFactor(0)).toBeCloseTo(0.015, 6);
    expect(growthHeightFactor(1)).toBeCloseTo(1, 12);
    expect(growthHeightFactor(-5)).toBeCloseTo(growthHeightFactor(0), 12);
    expect(growthHeightFactor(9)).toBeCloseTo(1, 12);
  });

  it("growthLevelsAt steps 0 → levels, and an unbranched plant stays at 0", () => {
    expect(growthLevelsAt(3, 0)).toBe(0);
    expect(growthLevelsAt(3, 0.24)).toBe(0);
    expect(growthLevelsAt(3, 0.25)).toBe(1);
    expect(growthLevelsAt(3, 0.5)).toBe(2);
    expect(growthLevelsAt(3, 0.75)).toBe(3);
    expect(growthLevelsAt(3, 1)).toBe(3);
    expect(growthLevelsAt(0, 1)).toBe(0); // a mushroom stem never branches
    expect(growthLevelsAt(0, 0)).toBe(0);
  });
});

describe("ageGrowth — a shoot at age 0", () => {
  it("has NO branch levels and stands on the stem alone", () => {
    for (const id of PLANTS) {
      const shoot = ageGrowth(growthOf(id), 0);
      expect(shoot.branching.levels).toBe(0);
      const st = generateGrowth(shoot, NUB_M);
      expect(st.segments.every((s) => s.level === 0)).toBe(true);
      expect(st.segments.length).toBeGreaterThan(0);
    }
  });

  it("is a SHOOT, not a vanished plant: at or above the minimum stem", () => {
    for (const id of PLANTS) {
      const shoot = ageGrowth(growthOf(id), 0);
      expect(shoot.stem.lengthFrac).toBeGreaterThanOrEqual(GROWTH_STEM_RANGES.lengthFrac.min);
      expect(generateGrowth(shoot, NUB_M).lengthM).toBeGreaterThan(0);
    }
  });

  it("is green, slender, unflared — and still wears leaves (a bare shoot is a stick)", () => {
    const oak = growthOf("oak");
    const shoot = ageGrowth(oak, 0);
    expect(shoot.stem.hardness).toBe(0);
    expect(shoot.stem.girth).toBeLessThan(oak.stem.girth * 0.2);
    expect(shoot.stem.rootFlare).toBeLessThan(1.05);
    expect(shoot.foliage.leafDensity).toBeGreaterThan(0);
    expect(generateGrowth(shoot, NUB_M).leaves.length).toBeGreaterThan(0);
  });

  it("🚨 wears PROPORTIONALLY LARGE leaves — the ratio rises as the plant shrinks", () => {
    // Measured, not argued: with `leafSizeFrac` scaled DOWN like an absolute
    // size, an oak shoot comes out as a bare vertical stick (crown width /
    // height 0.18). The frac is a ratio to the SEGMENT, and the segment
    // already shrank 60× with the plant.
    const oak = growthOf("oak");
    const shoot = ageGrowth(oak, 0);
    expect(shoot.foliage.leafSizeFrac).toBeGreaterThan(oak.foliage.leafSizeFrac);
    const longest = (g: GrowthBlueprint): number =>
      Math.max(...generateGrowth(g, NUB_M).leaves.map((l) => l.lengthM));
    // …and yet the leaves themselves are far SMALLER: a seedling's leaf is
    // still a seedling's leaf.
    expect(longest(shoot)).toBeLessThan(longest(oak) * 0.1);
  });

  it("bears no fruit and no flowers before maturity", () => {
    for (const id of ["apple_tree", "bush", "saguaro"]) {
      const g = growthOf(id);
      for (const a of [0, 0.25, 0.5, 0.6]) {
        const young = ageGrowth(g, a);
        expect(young.fruitDensity).toBe(0);
        expect(young.flowers.flowerDensity).toBe(0);
      }
      // …and it comes back by the time the plant is grown.
      expect(ageGrowth(g, 0.99).fruitDensity).toBeCloseTo(g.fruitDensity * 0.975, 6);
    }
  });
});

describe("ageGrowth — an aged blueprint is a LEGAL blueprint", () => {
  it("stays inside GROWTH_*_RANGES at every age, for every plant", () => {
    for (const id of PLANTS) {
      const g = growthOf(id);
      for (const a of [...AGES, 1]) {
        const aged = ageGrowth(g, a);
        expect(growthValidationErrors(aged, `${id}@${a}`)).toEqual([]);
        // The clamp is a no-op on it — nothing was pushed out of range and
        // silently pulled back.
        expect(clampGrowth(aged)).toEqual(aged);
      }
    }
  });

  it("survives an age outside [0,1] by clamping, never by producing garbage", () => {
    const g = growthOf("oak");
    expect(ageGrowth(g, -3)).toEqual(ageGrowth(g, 0));
  });
});

describe("ageGrowth — a sapling is the adult's OWN first branches", () => {
  // 🎁 THE PATH-HASH PRUNE. Every stochastic choice hashes on (seed, node
  // path); a child's path is `${parent}.${j*whorl+k}` and mentions `levels`
  // nowhere. Dropping levels is therefore a PRUNE, not a re-roll: the
  // retained sub-tree is bit-for-bit the adult's.
  it("a levels-pruned oak is a byte-identical PREFIX of the adult", () => {
    const oak = growthOf("oak");
    const adult = generateGrowth(oak, NUB_M).segments;
    for (const k of [0, 1, 2]) {
      const pruned = generateGrowth(withLevels(oak, k), NUB_M).segments;
      expect(pruned.length).toBeGreaterThan(0);
      expect(pruned.length).toBeLessThan(adult.length);
      expect(pruned.map(segKey)).toEqual(adult.slice(0, pruned.length).map(segKey));
    }
  });

  it("the same holds for every plant with branches", () => {
    for (const id of PLANTS) {
      const g = growthOf(id);
      if (g.branching.levels < 1) continue;
      const adult = generateGrowth(g, NUB_M).segments;
      const pruned = generateGrowth(withLevels(g, g.branching.levels - 1), NUB_M).segments;
      expect(pruned.map(segKey)).toEqual(adult.slice(0, pruned.length).map(segKey));
    }
  });

  it("an AGED sapling is the adult's own branches, at another size", () => {
    const oak = growthOf("oak");
    for (const a of [0.3, 0.5, 0.8]) {
      const aged = ageGrowth(oak, a);
      // The ADULT at adult size, wearing only the sapling's STRUCTURE (the
      // levels it has reached, and where its branches start). If ageing
      // re-rolled anything — a different branch, a different jitter — these
      // two would not be the same tree; the path hash is why they are.
      const twin: GrowthBlueprint = {
        ...oak,
        branching: {
          ...oak.branching,
          levels: aged.branching.levels,
          branchStart: aged.branching.branchStart,
        },
      };
      const A = generateGrowth(aged, NUB_M);
      const T = generateGrowth(twin, NUB_M);
      expect(A.segments.length).toBe(T.segments.length);
      expect(A.segments.map((s) => s.level)).toEqual(T.segments.map((s) => s.level));
      expect(A.segments.map((s) => s.parent)).toEqual(T.segments.map((s) => s.parent));
      // Every segment lands at the same place, scaled: same directions, same
      // branch angles, same wobble — the plant it will grow into.
      const k = A.lengthM / T.lengthM;
      for (let i = 0; i < A.segments.length; i++) {
        const p = A.segments[i].b;
        const q = T.segments[i].b;
        expect(p.x).toBeCloseTo(q.x * k, 6);
        expect(p.y).toBeCloseTo(q.y * k, 6);
        expect(p.z).toBeCloseTo(q.z * k, 6);
      }
    }
  });

  it("is NOT a uniform scale of the adult (the user's explicit rejection)", () => {
    const oak = growthOf("oak");
    const young = ageGrowth(oak, 0.5);
    const adult = generateGrowth(oak, NUB_M);
    const st = generateGrowth(young, NUB_M);
    const k = st.lengthM / adult.lengthM;
    expect(k).toBeGreaterThan(0.1);
    expect(k).toBeLessThan(0.9);
    // A uniform scale would put the trunk's base radius at exactly k× the
    // adult's. It is thinner than that — the young tree is SLENDER.
    const ratio = st.segments[0].radiusA / adult.segments[0].radiusA;
    expect(ratio).toBeLessThan(k * 0.95);
    // …and it has fewer branch levels than the adult, which no scale can do.
    expect(Math.max(...st.segments.map((s) => s.level))).toBeLessThan(
      Math.max(...adult.segments.map((s) => s.level)),
    );
  });

  it("is deterministic — the same (growth, age) twice is the same body", () => {
    const oak = growthOf("oak");
    expect(generateGrowth(ageGrowth(oak, 0.37), NUB_M)).toEqual(
      generateGrowth(ageGrowth(oak, 0.37), NUB_M),
    );
  });
});

describe("growthAgeOf — one owner of how old this tree is", () => {
  it("places an oak's class on its own ladder: 0 / 0.5 / 1", () => {
    expect(growthAgeOf("oak", 0)).toBe(0);
    expect(growthAgeOf("oak", 1)).toBe(0.5);
    expect(growthAgeOf("oak", 2)).toBe(1);
  });

  it("places an apple tree's two classes at 0 / 1", () => {
    expect(growthAgeOf("apple_tree", 0)).toBe(0);
    expect(growthAgeOf("apple_tree", 1)).toBe(1);
  });

  it("UNSET IS MATURE — the wilderness's own scatter law", () => {
    expect(growthAgeOf("oak")).toBe(1);
    expect(growthAgeOf("apple_tree")).toBe(1);
    expect(growthAgeOf("oak", undefined)).toBe(1);
  });

  it("a species with no growth ladder is always mature", () => {
    expect(growthAgeOf("bush")).toBe(1);
    expect(growthAgeOf("bush", 0)).toBe(1);
    expect(growthAgeOf("hazel", 0)).toBe(1);
    expect(growthAgeOf("rock", 0)).toBe(1);
  });

  it("an unknown species is mature (a standing thing we cannot reason about still stands)", () => {
    expect(growthAgeOf("dragon-tree-that-does-not-exist", 0)).toBe(1);
  });

  it("is NOT the yieldMul ladder (oak young: yield ×0.25, height age 0.5)", () => {
    // If these were ever derived from each other this would be 0.25.
    expect(growthAgeOf("oak", 1)).toBe(0.5);
  });

  it("drives the render: the oak's three classes are shoot / young / adult", () => {
    const oak = growthOf("oak");
    const heights = [0, 1, 2].map(
      (cls) => generateGrowth(ageGrowth(oak, growthAgeOf("oak", cls)), NUB_M).lengthM,
    );
    const levels = [0, 1, 2].map((cls) => ageGrowth(oak, growthAgeOf("oak", cls)).branching.levels);
    expect(levels).toEqual([0, 2, 3]);
    expect(heights[0]).toBeLessThan(1); // a shoot, under a metre of stem
    expect(heights[1]).toBeGreaterThan(heights[0] * 4);
    expect(heights[1]).toBeLessThan(heights[2] * 0.6);
    // Mature is the authored oak itself — the 23.8 m body, untouched.
    expect(heights[2]).toBe(generateGrowth(oak, NUB_M).lengthM);
    expect(heights[2]).toBeGreaterThan(10);
  });
});
