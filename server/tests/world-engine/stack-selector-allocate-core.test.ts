// THE TWO UNIFICATION CORES (kernel/town) — new coverage for the pieces that
// didn't exist before this pass:
//
//  · goods-kinds.ts `matchesGlyph`/`countUnits` — the ONE stack-counting
//    core behind transfer.ts's `stackUnits`/`stackTotal`, scope.ts's
//    `unitsOf`, and this module's own `stackTotalOf`/`carryTotalOf`.
//  · allocate.ts `allocate()` — the ONE conserving proportional allocator
//    behind city-districts.ts `allocateDistrictFill`, scope-shape.ts
//    `allocateHands`, and trade.ts `allotmentSplit`.
//
// The five/three original functions keep their own test coverage
// (furniture-naming.test.ts, town-scope.test.ts, scope-shape.test.ts,
// trade-import-channel.test.ts, town-districts-scale.test.ts) — this file
// is for the shared primitives themselves, and for pinning each sibling to
// the exact policy/selector its docstring claims.
//
// Pure logic only — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  countUnits,
  matchesGlyph,
  stackTotalOf,
  carryTotalOf,
  totalStackUnits,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import { stackHead, stackUnits, stackTotal } from "@shared/world-engine/kernel/town/transfer.js";
import { unitsOf } from "@shared/world-engine/kernel/town/scope.js";
import { allocate } from "@shared/world-engine/kernel/town/allocate.js";
import { allocateDistrictFill } from "@shared/world-engine/kernel/town/city-districts.js";
import { allocateHands } from "@shared/world-engine/kernel/town/scope-shape.js";
import { allotmentSplit } from "@shared/world-engine/kernel/town/trade.js";

describe("matchesGlyph — the three match rules, named", () => {
  it("head: matches a facted variant, AND collapses furniture pieces to their kind", () => {
    expect(matchesGlyph("wood.wet", { head: "wood" })).toBe(true);
    expect(matchesGlyph("wood", { head: "wood.wet" })).toBe(true);
    expect(matchesGlyph("furn.chair.color_red", { head: "furn.chair" })).toBe(true);
    // 🚨 the whole reason `prefix` exists: head-matching a bench answers yes
    // for a stored chair, because every furniture piece shares head "furn".
    expect(matchesGlyph("furn.chair", { head: "furn.bench" })).toBe(false);
  });

  it("prefix: this glyph or a further-facted extension — dot-bounded, not a naive startsWith", () => {
    expect(matchesGlyph("apple", { prefix: "apple" })).toBe(true);
    expect(matchesGlyph("apple.hot", { prefix: "apple" })).toBe(true);
    expect(matchesGlyph("applesauce", { prefix: "apple" })).toBe(false); // no dot boundary
    // The scope.ts warning, at the primitive level: furniture shares a head
    // but NOT a prefix, so a bench query never answers yes for a chair.
    expect(matchesGlyph("furn.chair", { prefix: "furn.bench" })).toBe(false);
    expect(matchesGlyph("furn.bench.color_blue", { prefix: "furn.bench" })).toBe(true);
  });

  it("kinds: exact key membership, nothing else", () => {
    expect(matchesGlyph("apple", { kinds: ["apple", "pear"] })).toBe(true);
    expect(matchesGlyph("apple.hot", { kinds: ["apple", "pear"] })).toBe(false); // exact, not prefix
  });

  it("all: every row, unconditionally", () => {
    expect(matchesGlyph("anything.at.all", { all: true })).toBe(true);
  });
});

describe("countUnits — the clamp policy per selector", () => {
  it("head and prefix clamp negative rows to 0 (the defensive floor stackUnits/unitsOf always had)", () => {
    expect(countUnits({ wood: -3, "wood.wet": 2 }, { head: "wood" })).toBe(2);
    expect(countUnits({ apple: -1, "apple.hot": 4 }, { prefix: "apple" })).toBe(4);
  });

  it("kinds sums raw — unclamped, exactly like the original `stock?.[k] ?? 0` reduce", () => {
    expect(countUnits({ shirt: -2 }, { kinds: ["shirt"] })).toBe(-2);
    expect(countUnits({}, { kinds: ["shirt"] })).toBe(0); // missing key reads 0
  });

  it("all defaults to raw (totalStackUnits), and opts into clamping (stackTotal) via clampNegatives", () => {
    expect(countUnits({ a: -3, b: 5 }, { all: true })).toBe(2);
    expect(countUnits({ a: -3, b: 5 }, { all: true, clampNegatives: true })).toBe(5);
  });
});

describe("the five counting functions are exactly the documented selector", () => {
  const stack = { wood: 2, "wood.wet": 3, "furn.chair": 1, "furn.chair.color_red": 1 };

  it("transfer.ts stackUnits === countUnits(head)", () => {
    expect(stackUnits(stack, "wood")).toBe(countUnits(stack, { head: "wood" }));
    expect(stackUnits(stack, "wood")).toBe(5);
  });

  it("scope.ts unitsOf === countUnits(prefix) — and disagrees with stackUnits on furniture, on purpose", () => {
    expect(unitsOf(stack, "furn.chair")).toBe(countUnits(stack, { prefix: "furn.chair" }));
    expect(unitsOf(stack, "furn.chair")).toBe(2);
    // stackHead collapses furn.chair AND furn.chair.color_red under "furn.chair"
    // too here (single-kind stack), but crucially unitsOf never widens to a
    // DIFFERENT furniture kind sharing the "furn" head — stackHead's own head
    // rule is what unitsOf refuses to use for exactly that reason.
    expect(stackHead("furn.bench")).not.toBe(stackHead("furn.chair"));
  });

  it("transfer.ts stackTotal clamps; goods-kinds totalStackUnits does not — the one preserved quirk", () => {
    const withNegative = { wood: -3, apple: 5 };
    expect(stackTotal(withNegative)).toBe(5);
    expect(totalStackUnits(withNegative)).toBe(2);
  });

  it("stackTotalOf / carryTotalOf stay the kinds-list selector", () => {
    expect(stackTotalOf({ apple: 2, pear: 1 }, "food")).toBeGreaterThanOrEqual(0);
    expect(carryTotalOf(undefined, "food")).toBe(0);
  });
});

describe("allocate() — the shared conserving core, one branch per sibling", () => {
  it("fair-floor reproduces allocateDistrictFill exactly", () => {
    const needs = [4, 2, 6, 1];
    const supplyDist = [30, 10, 50, 5];
    for (const fair of [0, 0.3, 0.6, 1]) {
      const viaCore = allocate({
        mode: "fair-floor",
        needs,
        supplyDist,
        fair,
        floorFrac: 0.5,
        spread: 0.35,
      });
      expect(viaCore).toEqual(allocateDistrictFill(needs, supplyDist, fair));
    }
  });

  it("even-floor reproduces allocateHands exactly", () => {
    const caps = [1, 3, 3];
    for (const supply of [0, 2, 6, 20]) {
      expect(allocate({ mode: "even-floor", caps, supply })).toEqual(allocateHands(caps, supply));
    }
    expect(allocate({ mode: "even-floor", caps: [1, 3, 3], supply: 6 })).toEqual([1, 3, 2]);
  });

  it("largest-remainder reproduces allotmentSplit exactly", () => {
    const weights = [1, 0.5, 0.2];
    for (const total of [0, 5.9, 6, 11]) {
      expect(allocate({ mode: "largest-remainder", weights, total })).toEqual(
        allotmentSplit(weights, total),
      );
    }
    expect(allocate({ mode: "largest-remainder", weights: [1, 1, 1, 1], total: 6 })).toEqual([
      2, 2, 1, 1,
    ]);
  });

  it("conserves exactly across all three modes (Σ-exactness)", () => {
    const needs = [3, 5, 2];
    const fillOut = allocate({
      mode: "fair-floor",
      needs,
      supplyDist: [1, 2, 3],
      fair: 0.7,
      floorFrac: 0.5,
      spread: 0.35,
    });
    const got = fillOut.reduce((s, f, i) => s + f * needs[i]!, 0);
    expect(got).toBeCloseTo(0.7 * needs.reduce((a, b) => a + b, 0), 9);

    const handsOut = allocate({ mode: "even-floor", caps: [3, 1, 3, 2], supply: 4.5 });
    expect(handsOut.reduce((a, b) => a + b, 0)).toBeCloseTo(4.5, 9);

    const splitOut = allocate({ mode: "largest-remainder", weights: [2, 1, 1], total: 7 });
    expect(splitOut.reduce((a, b) => a + b, 0)).toBe(7);
  });
});
