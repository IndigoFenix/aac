// COHORT-FOLD RECONCILIATION (body-anchored-needs round, D5) at the pure
// layer — what a body meter BECOMES when its person demotes to a statistic,
// and what comes back out when the statistic becomes a person again.
//
// The cohort tier conserves exactly two things: SOULS and UNITS. A need
// meter is neither (it is "the record that food was eaten"), so the round
// gives it a third, explicitly bounded fate: a household MEAN per need,
// stamped with the fold day, restored as that mean PLUS WHAT THE POOL FAILED
// TO FEED. Nothing above the fold mean may appear except unfed time — that
// sentence is the conservation statement these pins enforce.
//
// No DOM / GL / host.

import { describe, it, expect } from "@jest/globals";
import { NEED_FILL_DAYS } from "@shared/world-engine/scale.js";
import {
  NON_COMMODITY_UNFOLD_CAP,
  commodityNeedKeyOf,
  foldNeedMeans,
  needGoodKeyOf,
  unfoldNeedLevel,
} from "@shared/world-engine/kernel/town/cohort-needs.js";
import {
  cohortPopulation,
  cohortTotals,
  demoteHousehold,
  promoteHousehold,
  type CohortRow,
} from "@shared/world-engine/kernel/town/population.js";

// ---------------------------------------------------------------------------

describe("commodityNeedKeyOf / needGoodKeyOf — which rows the pool keeps books for", () => {
  it("a `<needKey>:<good>` row names its drive AND its commodity", () => {
    expect(commodityNeedKeyOf("hunger:food")).toBe("hunger");
    expect(needGoodKeyOf("hunger:food")).toBe("food");
    expect(commodityNeedKeyOf("thirst:water")).toBe("thirst");
    expect(needGoodKeyOf("thirst:water")).toBe("water");
  });

  it("a colonless motive has no commodity behind it", () => {
    for (const k of ["energy", "social", "fun", "hygiene", "waste", "dress"]) {
      expect(commodityNeedKeyOf(k)).toBeNull();
      expect(needGoodKeyOf(k)).toBeNull();
    }
  });

  it("🚨 a colon is NOT enough — an errand row is not a drive", () => {
    // `provision:food` and `adopt:*` share the shape but name nothing in
    // NEED_FILL_DAYS, so they must take the capped arm like any chore.
    expect(commodityNeedKeyOf("provision:food")).toBeNull();
    expect(commodityNeedKeyOf("adopt:pet")).toBeNull();
    expect(commodityNeedKeyOf("address:orrin")).toBeNull();
  });

  it("a malformed key is refused, never split into nonsense", () => {
    expect(commodityNeedKeyOf(":food")).toBeNull();
    expect(commodityNeedKeyOf("hunger:")).toBeNull();
    expect(commodityNeedKeyOf("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("foldNeedMeans — five bodies become one household statistic", () => {
  it("the mean is over the members that HAD the row, not over the household", () => {
    // Three members ticked; only two of them ever ran a thirst row. A thirst
    // mean of (1 + 0.4)/3 would report a household less thirsty than either
    // of the people in it.
    const means = foldNeedMeans([
      { "hunger:food": 0.2, "thirst:water": 1 },
      { "hunger:food": 0.8, "thirst:water": 0.4 },
      { "hunger:food": 0.5 },
    ]);
    expect(means["hunger:food"]).toBeCloseTo(0.5, 12);
    expect(means["thirst:water"]).toBeCloseTo(0.7, 12);
  });

  it("no rows ⇒ no payload (an unmeasured household folds with nothing)", () => {
    expect(foldNeedMeans([])).toEqual({});
    expect(foldNeedMeans([{}, {}, {}])).toEqual({});
  });

  it("keys come back SORTED — the serialized payload is byte-stable", () => {
    const means = foldNeedMeans([{ social: 0.1, "hunger:food": 0.2, energy: 0.3 }]);
    expect(Object.keys(means)).toEqual(["energy", "hunger:food", "social"]);
  });

  it("🚨 a non-finite reading is DROPPED, never averaged in", () => {
    // A NaN that reaches the pool poisons `row.pop` downstream.
    const means = foldNeedMeans([{ energy: NaN }, { energy: 0.4 }, { energy: Infinity }]);
    expect(means.energy).toBeCloseTo(0.4, 12);
    expect(Number.isFinite(means.energy!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("unfoldNeedLevel — the mean, plus what the pool failed to feed (U7)", () => {
  const base = { key: "hunger:food", sat: 1, elapsedDays: 0, metabolism: 1 };

  it("🚨 AT ELAPSED 0 THE MEAN IS RESTORED — the round-trip identity", () => {
    expect(unfoldNeedLevel({ ...base, mean: 0.37 })).toBeCloseTo(0.37, 12);
    expect(unfoldNeedLevel({ ...base, key: "thirst:water", mean: 0.9 })).toBeCloseTo(0.9, 12);
    expect(unfoldNeedLevel({ ...base, key: "energy", mean: 0.5 })).toBeCloseTo(0.5, 12);
  });

  it("an UNFED interval (sat 0) accrues exactly elapsed / fill", () => {
    // hunger fills in NEED_FILL_DAYS.hunger = 1 street-day at metabolism 1,
    // so three unfed days put three thresholds on the meter.
    const got = unfoldNeedLevel({ ...base, mean: 0.25, sat: 0, elapsedDays: 3 });
    expect(got).toBeCloseTo(0.25 + 3 / NEED_FILL_DAYS.hunger, 12);
    // thirst is the slower row and accrues correspondingly less.
    const thirst = unfoldNeedLevel({
      ...base, key: "thirst:water", mean: 0, sat: 0, elapsedDays: 5,
    });
    expect(thirst).toBeCloseTo(5 / NEED_FILL_DAYS.thirst, 12);
  });

  it("a FED interval (sat 1) accrues NOTHING however long it slept", () => {
    expect(unfoldNeedLevel({ ...base, mean: 0.25, sat: 1, elapsedDays: 400 })).toBeCloseTo(0.25, 12);
  });

  it("partial service accrues exactly the UNFED fraction", () => {
    const got = unfoldNeedLevel({ ...base, mean: 0.1, sat: 0.25, elapsedDays: 2 });
    expect(got).toBeCloseTo(0.1 + (0.75 * 2) / NEED_FILL_DAYS.hunger, 12);
  });

  it("metabolism enters the ACCRUAL exactly as `needFillDays` does", () => {
    // A 3× metabolism world eats three times a day, so an unfed day is worth
    // three thresholds — the same dial `needRate` divides by.
    const got = unfoldNeedLevel({ ...base, mean: 0, sat: 0, elapsedDays: 1, metabolism: 3 });
    expect(got).toBeCloseTo(3 / NEED_FILL_DAYS.hunger, 12);
  });

  it("a missing satisfaction reads FED (the books said nothing, so invent no hunger)", () => {
    // The host passes `row.needs[good] ?? 1`; this pins the same default here.
    expect(unfoldNeedLevel({ ...base, mean: 0.2, sat: 1, elapsedDays: 9 })).toBeCloseTo(0.2, 12);
  });

  it("🚨 NON-COMMODITY rows cap at the reveal-seed spread factor (0.7)", () => {
    expect(NON_COMMODITY_UNFOLD_CAP).toBe(0.7);
    // The household slept unobserved: it comes back no worse than it went in,
    // and never worse than a freshly-revealed household's own seed.
    expect(unfoldNeedLevel({ ...base, key: "energy", mean: 3, sat: 0, elapsedDays: 40 })).toBe(0.7);
    expect(unfoldNeedLevel({ ...base, key: "social", mean: 0.2, sat: 0, elapsedDays: 40 }))
      .toBeCloseTo(0.2, 12);
    // …and an errand row with a colon takes the same arm.
    expect(unfoldNeedLevel({ ...base, key: "provision:food", mean: 5, sat: 0, elapsedDays: 40 }))
      .toBe(0.7);
  });

  it("everything clamps ≥ 0 and stays finite (no NaN reaches a pool)", () => {
    expect(unfoldNeedLevel({ ...base, mean: -3 })).toBe(0);
    expect(unfoldNeedLevel({ ...base, mean: NaN, sat: 0, elapsedDays: 1 })).toBeCloseTo(1, 12);
    expect(unfoldNeedLevel({ ...base, mean: 0.4, sat: NaN, elapsedDays: 5 })).toBeCloseTo(0.4, 12);
    expect(unfoldNeedLevel({ ...base, mean: 0.4, sat: 0, elapsedDays: NaN })).toBeCloseTo(0.4, 12);
    expect(unfoldNeedLevel({ ...base, mean: 0.4, sat: 0, elapsedDays: 2, metabolism: 0 }))
      .toBeCloseTo(0.4, 12);
    expect(unfoldNeedLevel({ ...base, mean: 0.4, sat: 0, elapsedDays: 2, metabolism: NaN }))
      .toBeCloseTo(0.4, 12);
    // A backwards clock cannot un-hunger anybody.
    expect(unfoldNeedLevel({ ...base, mean: 0.4, sat: 0, elapsedDays: -9 })).toBeCloseTo(0.4, 12);
  });
});

// ---------------------------------------------------------------------------

describe("demote → promote — the fold carries the meters and STILL conserves", () => {
  const house = (index: number, needs?: Record<string, number>, foldedDay?: number) => ({
    index,
    members: 5,
    ...(needs ? { needs } : {}),
    ...(foldedDay !== undefined ? { foldedDay } : {}),
  });

  it("🚨 the household MEANS and the fold DAY ride the pooled row and come back", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 2, house(7, { "hunger:food": 0.6, energy: 0.4 }, 12.5), { food: 2 }, 0.6, 12.5);
    expect(rows[0]!.houses[0]).toMatchObject({
      index: 7,
      members: 5,
      needs: { "hunger:food": 0.6, energy: 0.4 },
      foldedDay: 12.5,
    });
    const out = promoteHousehold(rows, 7);
    expect(out?.house.needs).toEqual({ "hunger:food": 0.6, energy: 0.4 });
    expect(out?.house.foldedDay).toBe(12.5);
  });

  it("an UNMEASURED household carries no payload at all (byte-identical to the shipped fold)", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 0, house(3), {}, 0.7, 4);
    expect(rows[0]!.houses[0]).toEqual({ index: 3, members: 5 });
    expect(promoteHousehold(rows, 3)?.house.needs).toBeUndefined();
  });

  it("the pooled row COPIES the means — the caller's object is never aliased", () => {
    const rows: CohortRow[] = [];
    const mine = { "hunger:food": 0.6 };
    demoteHousehold(rows, 0, house(1, mine, 0), {}, 0.7, 0);
    mine["hunger:food"] = 99;
    expect(rows[0]!.houses[0]!.needs).toEqual({ "hunger:food": 0.6 });
  });

  it("SOULS and UNITS are still conserved across repeated cycles (the tier's own law)", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, -1, house(0, { "hunger:food": 0.3 }, 1), { food: 4 }, 0.7, 1);
    demoteHousehold(rows, 2, { index: 1, members: 4 }, {}, 0.5, 1);
    for (let i = 0; i < 3; i++) {
      promoteHousehold(rows, 0);
      demoteHousehold(rows, -1, house(0, { "hunger:food": 0.3 }, 1), {}, 0.7, 1);
      promoteHousehold(rows, 1);
      demoteHousehold(rows, 2, { index: 1, members: 4 }, {}, 0.5, 1);
    }
    expect(cohortPopulation(rows)).toBe(9);
    expect(cohortTotals(rows).stack).toEqual({ food: 4 });
  });

  it("the payload is plain JSON — it survives the serialization round trip", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 1, house(6, { "hunger:food": 0.6, energy: 0.4 }, 3), { food: 2 }, 0.6, 3);
    const revived = JSON.parse(JSON.stringify(rows)) as CohortRow[];
    expect(revived[0]!.houses[0]).toEqual({
      index: 6,
      members: 5,
      needs: { "hunger:food": 0.6, energy: 0.4 },
      foldedDay: 3,
    });
  });

  it("END TO END: a household folds hungry, the pool starves, and it wakes hungrier", () => {
    // The whole D5 sentence in one run: fold five bodies' meters into a mean,
    // pool them for two street-days over a pool that fed nothing (sat 0), and
    // read the members back out.
    const rows: CohortRow[] = [];
    const means = foldNeedMeans([
      { "hunger:food": 0.4, energy: 0.9 },
      { "hunger:food": 0.6, energy: 0.5 },
    ]);
    demoteHousehold(rows, 0, { index: 4, members: 2, needs: means, foldedDay: 10 }, {}, 0.7, 10);
    rows[0]!.needs.food = 0; // the pool fed nobody while they were a statistic
    const sat = { ...rows[0]!.needs };
    const out = promoteHousehold(rows, 4)!;
    const elapsedDays = 12 - (out.house.foldedDay ?? 0);
    const level = (key: string) =>
      unfoldNeedLevel({
        mean: out.house.needs![key]!,
        key,
        sat: (needGoodKeyOf(key) !== null ? sat[needGoodKeyOf(key)!] : undefined) ?? 1,
        elapsedDays,
        metabolism: 1,
      });
    // Hunger: the mean (0.5) plus two unfed days.
    expect(level("hunger:food")).toBeCloseTo(0.5 + 2 / NEED_FILL_DAYS.hunger, 12);
    // Energy: no commodity, so the household's sleep is capped at 0.7 — the
    // pool kept no books for it and none are invented.
    expect(level("energy")).toBe(0.7);
  });
});
