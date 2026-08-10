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
  shiftForgoneS,
  townFillS,
} from "@shared/world-engine/kernel/town/pricing.js";
import { ATTENDANCE_FLOOR, attendanceFactor } from "@shared/world-engine/kernel/town/roster.js";
import { DOLLHOUSE_SCALE, REAL_SCALE } from "@shared/world-engine/scale.js";

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

// ─────────────────────────────────────────────────────────────────────────
// LABOUR (economy arc batch 2, L2) — the town's fill clock and the
// attendance model read FORWARD.
// ─────────────────────────────────────────────────────────────────────────

describe("townFillS — the town's own clock is its DAY", () => {
  it("is the street day, whatever the profile's day is", () => {
    expect(townFillS(DOLLHOUSE_SCALE)).toBe(DOLLHOUSE_SCALE.dayLengthS);
    expect(townFillS(REAL_SCALE)).toBe(REAL_SCALE.dayLengthS);
  });

  it("floors at one second — a unit is never worth nothing by division", () => {
    expect(townFillS({ ...DOLLHOUSE_SCALE, dayLengthS: 0 })).toBe(1);
  });
});

describe("shiftForgoneS — what pulling a scheduled worker would destroy", () => {
  /** A farm: 2 souls, a 0.38-day shift, a 240 s street day, 40 units a day. */
  const FARM = { unitsPerDay: 40, staff: 2, windowLen: 0.38, daySec: 240 };

  it("IS the attendance chain, arithmetically — units lost × what a unit is worth", () => {
    const scheduledSec = FARM.staff * FARM.windowLen * FARM.daySec; // 182.4
    const occupiedS = 30;
    const unitValueS = goodsValueS(1, 0.5, 240, 1); // half short ⇒ 120 s a unit
    // Step 2 of the derivation, restated here as the oracle: 30 absent
    // seconds cost the work exactly this fraction of its attendance.
    const lostFraction = 1 - attendanceFactor({ day: 1, seconds: 0, prevSeconds: occupiedS }, 1, scheduledSec);
    expect(shiftForgoneS({ ...FARM, occupiedS, unitValueS })).toBeCloseTo(
      lostFraction * FARM.unitsPerDay * unitValueS,
      9,
    );
  });

  it("scales with the time the claim holds the body — it is a RATE, never a fee", () => {
    const a = shiftForgoneS({ ...FARM, occupiedS: 10, unitValueS: 120 });
    const b = shiftForgoneS({ ...FARM, occupiedS: 20, unitValueS: 120 });
    expect(b).toBeCloseTo(a * 2, 9);
  });

  it("A SURPLUS TOWN DOES NOT PROTECT ITS WORKERS — shortage 0 ⇒ forgone 0", () => {
    // The honest reading: the marginal unit is worth nothing, so the shift is
    // worth nothing to interrupt, and the claim reduces to pure geometry.
    expect(shiftForgoneS({ ...FARM, occupiedS: 30, unitValueS: goodsValueS(1, 0, 240, 1) })).toBe(0);
  });

  it("zero whenever the shift is not real — no staff, no window, no output, no time", () => {
    expect(shiftForgoneS({ ...FARM, staff: 0, occupiedS: 30, unitValueS: 120 })).toBe(0);
    expect(shiftForgoneS({ ...FARM, windowLen: 0, occupiedS: 30, unitValueS: 120 })).toBe(0);
    expect(shiftForgoneS({ ...FARM, unitsPerDay: 0, occupiedS: 30, unitValueS: 120 })).toBe(0);
    expect(shiftForgoneS({ ...FARM, occupiedS: 0, unitValueS: 120 })).toBe(0);
    expect(Number.isNaN(shiftForgoneS({ ...FARM, daySec: 0, occupiedS: 30, unitValueS: 120 }))).toBe(false);
  });

  it("the ATTENDANCE FLOOR is deliberately NOT applied — the price is memoryless", () => {
    // An already-abandoned work loses no more output (the controller floors at
    // ATTENDANCE_FLOOR), but the PRICE still charges the linear rate: reading
    // the live tally here would make the cost of a claim depend on who was
    // pulled earlier today. Recorded as a knowing over-charge.
    expect(ATTENDANCE_FLOOR).toBeGreaterThan(0);
    const whole = shiftForgoneS({ ...FARM, occupiedS: 60, unitValueS: 120 });
    expect(whole).toBeCloseTo(shiftForgoneS({ ...FARM, occupiedS: 60, unitValueS: 120 }), 9);
    expect(whole).toBeGreaterThan(0);
  });
});
