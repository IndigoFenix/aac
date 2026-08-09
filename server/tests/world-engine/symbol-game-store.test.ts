// Store depletion over the time-pure economy (goods.ts): the discrete consumed-offset
// layer a market CONTAINER uses so the player pulling items out DEPLETES the same shelf
// the modelled shoppers drain, resetting each economy day (the dawn refill). Pure.

import { describe, it, expect } from "@jest/globals";
import {
  FOOD_DAY_SEC,
  HOUSEHOLD,
  economyDay,
  storeUnitsLeft,
  addStoreConsumption,
  shopPeriod,
  pantryLevel,
  SURPLUS_FRAC_MIN,
  SURPLUS_FRAC_MAX,
} from "@shared/world-engine/kernel/town/goods.js";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import {
  TOWN_PLAY_ECONOMY,
  townPlayEconomy,
} from "@shared/world-engine/interaction/town/town-play.js";
import {
  clothingFillDays,
  DOLLHOUSE_SCALE,
  REAL_CLOTHING_DAYS,
  REAL_SCALE,
  SEASONAL_SCALE,
} from "@shared/world-engine/scale.js";

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

// ─────────────────────────────────────────────────────────────────────────
// F4 — CLOTHING DEMAND, GROUNDED (economy-arc-opening.md)
//
// USER LAW (2026-08-09), verbatim: *"How much clothing do these people need,
// anyway? I think people need new food a lot more than they need new clothes.
// Ground it in a roughly normal value (we'll handle adjustments later), and
// assume that the need scales at the metabolic multiplier."*
//
// One anchor (`REAL_CLOTHING_DAYS = 180`) and derivations off it. Everything
// here is a RATIO or a derivation — the only absolute pinned is the anchor
// itself, because the anchor IS the decision. Pure; no boot.
// ─────────────────────────────────────────────────────────────────────────

describe("F4 — the clothing anchor and its derivations", () => {
  it("REAL_CLOTHING_DAYS is the half-year garment, and wear scales at METABOLISM", () => {
    expect(REAL_CLOTHING_DAYS).toBe(180);
    // Realism: a garment lasts the anchor. The dollhouse spins its planet and
    // nothing else, so its wear is the anchor too.
    expect(clothingFillDays(REAL_SCALE)).toBe(180);
    expect(clothingFillDays(DOLLHOUSE_SCALE)).toBe(180);
    // A world that eats three times a game-day wears clothes out three times
    // as fast — the SAME 180 meals per garment, which is the point.
    expect(clothingFillDays(SEASONAL_SCALE)).toBe(60);
    expect(clothingFillDays({ ...REAL_SCALE, metabolism: 4 })).toBe(45);
  });

  it("the BOOKS say 180 : 1 — food is the caloric anchor and does not move", () => {
    const food = TOWN_PLAY_ECONOMY.commodities!.find((c) => c.key === "food")!;
    const clothing = TOWN_PLAY_ECONOMY.commodities!.find((c) => c.key === "clothing")!;
    // 🔒 THE CALORIC ANCHOR, byte-for-byte what it has always been.
    expect(food.perPersonDaily).toBe(0.001);
    expect(food.perPersonDaily! / clothing.perPersonDaily!).toBeCloseTo(180, 9);
    // …and it is DERIVED, not typed: a faster metabolism re-grounds it.
    const fast = townPlayEconomy({ ...REAL_SCALE, metabolism: 3 });
    const fastFood = fast.commodities!.find((c) => c.key === "food")!;
    const fastClothing = fast.commodities!.find((c) => c.key === "clothing")!;
    expect(fastFood.perPersonDaily).toBe(food.perPersonDaily); // the anchor never moves
    expect(fastFood.perPersonDaily! / fastClothing.perPersonDaily!).toBeCloseTo(60, 9);
  });

  it("🚨 the STREET hears the books: `perCapitaDaily` is food-normalized, not a flat 1", () => {
    // The mis-wiring F4 closes: the compiler used to hard-set `perCapitaDaily: 1`
    // for EVERY street good, so clothing was bought as often as bread whatever
    // the books said, and `capDays` was the only cadence lever anyone had.
    const eco = compileEconomy([TOWN_PLAY_ECONOMY], { construction: true });
    const food = eco.goods.find((g) => g.key === "food")!;
    const clothing = eco.goods.find((g) => g.key === "clothing")!;
    expect(food.perCapitaDaily).toBe(1); // 🔒 the RATION, exactly — the unit itself
    expect(clothing.perCapitaDaily).toBeCloseTo(1 / 180, 12);
  });

  it("the WARDROBE holds a whole number of garments at any metabolism", () => {
    // `capDays` is DERIVED (boxUnits × wearDays ÷ HOUSEHOLD) precisely so the
    // pinned box formula comes out whole instead of degenerating to ~0.56.
    for (const metabolism of [1, 2, 3, 7]) {
      const eco = compileEconomy([townPlayEconomy({ ...REAL_SCALE, metabolism })], { construction: true });
      const clothing = eco.goods.find((g) => g.key === "clothing")!;
      const boxCap = HOUSEHOLD * clothing.capDays * clothing.perCapitaDaily;
      expect(boxCap).toBeCloseTo(2, 9);
    }
    // The staple's box is untouched — HOUSEHOLD(5) × capDays(3) × 1 ration.
    const eco = compileEconomy([TOWN_PLAY_ECONOMY], { construction: true });
    const food = eco.goods.find((g) => g.key === "food")!;
    expect(HOUSEHOLD * food.capDays * food.perCapitaDaily).toBe(15);
  });

  it("a doc whose staple declares no per-person draw keeps the pre-F4 flat rate", () => {
    // The fallback is deliberate: an intermediate that somehow carries a box is
    // never silently zeroed off the street.
    const eco = compileEconomy([{
      commodities: [
        // The implicit human's declared diet — present, but NOT a street good
        // and carrying no per-person row, so there is no staple to quote against.
        { key: "food", scalarMax: 200, transport: {} },
        {
          key: "widget", scalarMax: 10, transport: {},
          street: {
            capDays: 4, shopSec: 10, cartRations: 10, unit: "widgets",
            producers: ["hall"], stockColor: "#fff", boxLabel: "Box", errandName: "widgets",
          },
        },
      ],
    }]);
    expect(eco.goods.find((g) => g.key === "widget")!.perCapitaDaily).toBe(1);
  });
});
