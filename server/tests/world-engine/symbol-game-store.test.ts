// Store depletion over the time-pure economy (goods.ts): the discrete consumed-offset
// layer a market CONTAINER uses so the player pulling items out DEPLETES the same shelf
// the modelled shoppers drain, resetting each economy day (the dawn refill). Pure.

import { describe, it, expect } from "@jest/globals";
import {
  FOOD_DAY_SEC,
  economyDay,
  storeUnitsLeft,
  addStoreConsumption,
  shopPeriod,
  pantryLevel,
  SURPLUS_FRAC_MIN,
  SURPLUS_FRAC_MAX,
} from "@shared/world-engine/kernel/town/goods.js";

describe("economyDay — dawn-to-dawn buckets", () => {
  it("floors time into FOOD_DAY_SEC-long days", () => {
    expect(economyDay(0)).toBe(0);
    expect(economyDay(FOOD_DAY_SEC - 1)).toBe(0);
    expect(economyDay(FOOD_DAY_SEC)).toBe(1);
    expect(economyDay(FOOD_DAY_SEC * 3.5)).toBe(3);
  });
});

describe("storeUnitsLeft — base minus what the player has pulled this day", () => {
  it("no consumption → the whole shelf", () => {
    expect(storeUnitsLeft(10, undefined, 5)).toBe(10);
  });

  it("subtracts this-day consumption and clamps at zero", () => {
    expect(storeUnitsLeft(10, { day: 0, units: 3 }, 5)).toBe(7);
    expect(storeUnitsLeft(2, { day: 0, units: 5 }, 5)).toBe(0); // oversold → sold out
  });

  it("a PRIOR day's offset is ignored — the dawn cart refilled the shelf", () => {
    // t is on day 1; a day-0 tally no longer counts.
    expect(storeUnitsLeft(10, { day: 0, units: 8 }, FOOD_DAY_SEC + 5)).toBe(10);
  });
});

describe("addStoreConsumption — accumulate within a day, reset across days", () => {
  it("accumulates while the day holds", () => {
    let c = addStoreConsumption(undefined, 5); // day 0, 1 unit
    expect(c).toEqual({ day: 0, units: 1 });
    c = addStoreConsumption(c, 10, 2); // +2 same day
    expect(c).toEqual({ day: 0, units: 3 });
  });

  it("resets the tally when the day rolls over", () => {
    const prior = { day: 0, units: 4 };
    const c = addStoreConsumption(prior, FOOD_DAY_SEC + 1); // now day 1
    expect(c).toEqual({ day: 1, units: 1 });
  });

  it("a take then a full day later starts the shelf fresh", () => {
    // Take 3 on day 0; by day 1 the store shows the whole base again.
    let c = addStoreConsumption(undefined, 0);
    c = addStoreConsumption(c, 0);
    c = addStoreConsumption(c, 0); // day 0, units 3
    expect(storeUnitsLeft(10, c, 0)).toBe(7);
    expect(storeUnitsLeft(10, c, FOOD_DAY_SEC)).toBe(10); // refilled next day
  });
});

describe("shopPeriod — surplus drives shopping frequency (§13a)", () => {
  const trip = 30;
  const capDays = 3;
  it("MORE surplus ⇒ SHORTER period ⇒ shops sooner/oftener (never runs dry)", () => {
    const lean = shopPeriod(trip, capDays, SURPLUS_FRAC_MIN, 1);
    const hoarder = shopPeriod(trip, capDays, SURPLUS_FRAC_MAX, 1);
    expect(hoarder).toBeLessThan(lean);
  });

  it("period = capDays·(1−surplusFrac)·FOOD_DAY_SEC (scaled by fill), above the trip floor", () => {
    expect(shopPeriod(trip, capDays, 0.25, 1)).toBeCloseTo(capDays * 0.75 * FOOD_DAY_SEC);
    expect(shopPeriod(trip, capDays, 0.25, 0.5)).toBeCloseTo(capDays * 0.75 * FOOD_DAY_SEC * 0.5);
  });

  it("never shorter than the trip can fit (floor)", () => {
    // A tiny cap / heavy surplus can't push the period below trip·1.5.
    expect(shopPeriod(trip, 0.01, 0.4, 0.25)).toBe(trip * 1.5);
  });
});

describe("pantryLevel — a never-empty sawtooth bottoming at the surplus buffer (§13a)", () => {
  const boxCap = 15; // HOUSEHOLD(5) × capDays(3) × perCapitaDaily(1)
  const surplus = 3; // 20% buffer
  const period = 100;
  const trip = 20;

  it("FULL at the return home (u = trip)", () => {
    expect(pantryLevel(boxCap, surplus, period, trip, trip)).toBeCloseTo(boxCap);
  });

  it("bottoms EXACTLY at the surplus buffer just before the next return (never 0)", () => {
    // One full period after the refill is the low point.
    expect(pantryLevel(boxCap, surplus, period, trip, trip + period - 1e-6)).toBeCloseTo(surplus);
  });

  it("stays within [surplus, boxCap] and drains monotonically since the last refill", () => {
    let prev = boxCap + 1;
    for (let e = 0; e < period; e += 5) {
      const v = pantryLevel(boxCap, surplus, period, trip, trip + e); // e = seconds since refill
      expect(v).toBeGreaterThanOrEqual(surplus - 1e-9);
      expect(v).toBeLessThanOrEqual(boxCap + 1e-9);
      expect(v).toBeLessThanOrEqual(prev + 1e-9); // non-increasing
      prev = v;
    }
    expect(prev).toBeLessThan(boxCap); // it did drain
  });
});
