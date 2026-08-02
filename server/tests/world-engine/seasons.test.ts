// SEASONALITY (seasons.ts — settlement-emergence.md §6, step ②): the global
// orbital phase and the mean-1 insolation yield curve. Pins the laws that
// make the granary invariant live: the annual mean is EXACTLY 1 (a seasonal
// world grows the same yearly total — the season only redistributes), the
// zero-yield window is EXACTLY the declared leanFraction, and the lean
// window's consumption deficit is EXACTLY scale.ts leanSeasonMeals — the
// number that decides whether civilisation happens at all.

import { describe, it, expect } from "@jest/globals";
import {
  seasonPhaseAtDay,
  seasonPhaseAtS,
  seasonPeakYield,
  seasonStageAt,
  seasonYield,
  seasonYieldAt,
  SPRING_PHASE,
} from "@shared/world-engine/seasons.js";
import {
  DOLLHOUSE_SCALE,
  leanSeasonMeals,
  mealsPerYear,
  REAL_SCALE,
  SEASONAL_SCALE,
  yearGameDays,
  yearLengthS,
} from "@shared/world-engine/scale.js";

const LEANS = [0, 0.15, 0.25, 0.4, 0.6, 0.9];
const N = 20_000; // numeric-integration resolution

describe("the yield curve — mean-1 insolation with a declared dead window", () => {
  it("annual mean is exactly 1 for every lean fraction (the redistribution law)", () => {
    for (const L of LEANS) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += seasonYieldAt((i + 0.5) / N, L);
      expect(sum / N).toBeCloseTo(1, 3);
    }
  });

  it("the zero-yield window is exactly the lean fraction, centred on midwinter", () => {
    for (const L of [0.15, 0.25, 0.4, 0.6]) {
      let zero = 0;
      for (let i = 0; i < N; i++) if (seasonYieldAt((i + 0.5) / N, L) === 0) zero++;
      expect(zero / N).toBeCloseTo(L, 2);
      // Midwinter is dead, midsummer is the peak.
      expect(seasonYieldAt(0, L)).toBe(0);
      expect(seasonYieldAt(0.5, L)).toBeCloseTo(seasonPeakYield(L));
      // The window straddles the year boundary like winter straddles New Year.
      expect(seasonYieldAt(1 - L / 2 + 0.01, L)).toBe(0);
      expect(seasonYieldAt(L / 2 - 0.01, L)).toBe(0);
    }
  });

  it("is continuous (no cliff a child would watch the world fall off)", () => {
    for (const L of LEANS) {
      // Analytic slope bound: |dy/dp| ≤ 2π/M = 2π·peak/(1 + cos πL).
      const maxStep = ((2 * Math.PI * seasonPeakYield(L)) / (1 + Math.cos(Math.PI * L)) / 2000) * 1.01;
      let prev = seasonYieldAt(0, L);
      for (let i = 1; i <= 2000; i++) {
        const y = seasonYieldAt(i / 2000, L);
        expect(Math.abs(y - prev)).toBeLessThanOrEqual(maxStep);
        prev = y;
      }
    }
  });

  it("the temperate peak: a harvest is worth nearly three flat months", () => {
    expect(seasonPeakYield(0.4)).toBeGreaterThan(2.5);
    expect(seasonPeakYield(0.4)).toBeLessThan(3);
    // More winter ⇒ a more violent summer (the mean must still be 1).
    expect(seasonPeakYield(0.6)).toBeGreaterThan(seasonPeakYield(0.4));
    expect(seasonPeakYield(0.15)).toBeLessThan(seasonPeakYield(0.4));
  });

  it("the LEANLESS world keeps a mild insolation swing, mean 1, zero only at an instant", () => {
    expect(seasonYieldAt(0, 0)).toBe(0);
    expect(seasonYieldAt(0.5, 0)).toBeCloseTo(2);
    let zero = 0;
    for (let i = 0; i < N; i++) if (seasonYieldAt((i + 0.5) / N, 0) === 0) zero++;
    expect(zero).toBe(0); // the single zero has measure zero
  });
});

describe("the phase — a pure function of the clock and the revolution dial", () => {
  it("SEASONAL_SCALE: a 12-day year — day 6 is midsummer from a midwinter start", () => {
    expect(yearGameDays(SEASONAL_SCALE)).toBeCloseTo(12);
    expect(seasonPhaseAtDay(SEASONAL_SCALE, 6)).toBeCloseTo(0.5);
    expect(seasonPhaseAtDay(SEASONAL_SCALE, 12)).toBeCloseTo(0);
    expect(seasonPhaseAtDay(SEASONAL_SCALE, 0, SPRING_PHASE)).toBeCloseTo(0.25);
  });

  it("phase by seconds and by days agree through yearLengthS", () => {
    for (const scale of [REAL_SCALE, DOLLHOUSE_SCALE, SEASONAL_SCALE]) {
      const tS = 0.37 * yearLengthS(scale);
      const day = 0.37 * yearGameDays(scale);
      expect(seasonPhaseAtS(scale, tS)).toBeCloseTo(seasonPhaseAtDay(scale, day));
    }
  });

  it("the dollhouse's seasonal incoherence is visible here too: a session moves the phase imperceptibly", () => {
    // 360 game-days of dollhouse play (a day and a half of real time) cross
    // under 1% of the year — exactly why the shipped town has no seasons.
    expect(seasonPhaseAtDay(DOLLHOUSE_SCALE, 360)).toBeLessThan(0.01);
  });
});

describe("the granary linkage — the lean deficit IS leanSeasonMeals", () => {
  it("consumption minus yield over the lean window equals scale.ts's granary number", () => {
    // Eating is flat (1 ration per hunger period); yield is the curve. The
    // deficit a store must cover = ∫ over zero-yield window of (1 − 0) ×
    // mealsPerYear = leanFraction × mealsPerYear = leanSeasonMeals. Assert
    // numerically so seasons.ts and scale.ts can never drift apart.
    for (const scale of [SEASONAL_SCALE, REAL_SCALE]) {
      let deficit = 0;
      for (let i = 0; i < N; i++) {
        const y = seasonYield(scale, (i + 0.5) / N);
        if (y === 0) deficit += mealsPerYear(scale) / N;
      }
      expect(deficit).toBeCloseTo(leanSeasonMeals(scale), 1);
    }
    // And SEASONAL_SCALE's number sits inside the granary band (10–400).
    expect(leanSeasonMeals(SEASONAL_SCALE)).toBeCloseTo(14.4, 1);
  });
});

describe("crop stages — the year as a child can say it", () => {
  it("partitions the year: stubble around midwinter, sow → green → harvest across the growing window", () => {
    const L = 0.4;
    expect(seasonStageAt(0, L)).toBe("stubble");
    expect(seasonStageAt(0.95, L)).toBe("stubble");
    expect(seasonStageAt(0.15, L)).toBe("stubble");
    expect(seasonStageAt(0.25, L)).toBe("sow");
    expect(seasonStageAt(0.5, L)).toBe("green");
    expect(seasonStageAt(0.75, L)).toBe("harvest");
    // The default founding phase lands in sowing season.
    expect(seasonStageAt(SPRING_PHASE, L)).toBe("sow");
    // Stage boundaries cover the whole circle — no phase without a name.
    for (let i = 0; i < 1000; i++) {
      expect(["sow", "green", "harvest", "stubble"]).toContain(seasonStageAt(i / 1000, L));
    }
  });
});
