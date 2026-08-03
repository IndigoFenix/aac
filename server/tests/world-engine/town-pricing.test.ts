/**
 * THE CURRENCY (kernel/town/pricing.ts) — step ④ of scope-unification.md,
 * scope-behaviors.md §3. Hand-seconds, one place.
 *
 * No DOM / GL / session.
 */
import { describe, it, expect } from "@jest/globals";
import {
  driveValueS,
  goodsValueS,
  journeyTimeS,
  netValueS,
  priceOf,
} from "@shared/world-engine/kernel/town/pricing.js";

describe("journeys", () => {
  it("prices a leg as time", () => {
    expect(journeyTimeS(120, 1.5)).toBe(80);
    expect(journeyTimeS(0, 1.5)).toBe(0);
  });

  it("an unreachable leg prices infinite, never NaN — that IS the failure cooldown's replacement", () => {
    expect(journeyTimeS(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(journeyTimeS(10, -1)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(journeyTimeS(10, 0))).toBe(false);
  });
});

describe("assembly", () => {
  it("missing terms are zero — forgoneS starts life at 0 everywhere", () => {
    expect(priceOf({ journeyS: 30 })).toEqual({ journeyS: 30, handsS: 0, spoilageS: 0, forgoneS: 0 });
  });
});

describe("value", () => {
  it("a full-blown drive is worth its whole fill clock, and urgency clamps", () => {
    expect(driveValueS(1, 3600)).toBe(3600);
    expect(driveValueS(0.5, 3600)).toBe(1800);
    expect(driveValueS(2, 3600)).toBe(3600);
    expect(driveValueS(-1, 3600)).toBe(0);
  });

  it("a unit of a plentiful good rounds to nothing; a famine good approaches the clock", () => {
    expect(goodsValueS(1, 0, 3600, 15)).toBe(0);
    expect(goodsValueS(1, 1, 3600, 15)).toBe(240);
    // Five units at half scarcity: 5 × (0.5 × 3600 / 15)
    expect(goodsValueS(5, 0.5, 3600, 15)).toBe(600);
  });

  it("unitsPerFill floors at 1 so a rare bill never divides by zero", () => {
    expect(goodsValueS(1, 1, 3600, 0)).toBe(3600);
  });
});

describe("the comparison", () => {
  it("net = value − the four terms; the sign is the WORTHWHILE gate", () => {
    const cost = priceOf({ journeyS: 100, handsS: 20 });
    expect(netValueS(300, cost)).toBe(180);
    expect(netValueS(100, cost)).toBeLessThan(0);
  });

  it("an infinite journey loses every argmax without any cooldown machinery", () => {
    expect(netValueS(1e9, priceOf({ journeyS: Number.POSITIVE_INFINITY }))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});
