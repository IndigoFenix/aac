// SUBTRACTIVE SATIATION + THE RATION/ITEM SEAM (food-scale-round.md Q2, Phase B
// steps ⑦/⑧) — the pure pins for the arithmetic that split the RATION (one
// person-day, the unit the economy counts) from the ITEM (the thing a hand
// lifts). LEAF MODULES ONLY — goods-kinds / goods / scale — NEVER quest-host
// (play-level behavior belongs to text mode; a value-import of the host pays a
// heavy per-worker transform tax).
//
// Pinned here:
//   1. `rationsOf` / `rationTotalOf` / `carryRationTotalOf` — the container
//      boundary reads (mixed stacks, empty, unknown-glyph default 1).
//   2. `unitsForRations` — the inverse seam's rounding and its round-trip
//      conservation bound (never mint or lose beyond half of one glyph).
//   3. `grainSatiationDaysOf` + the UNIFORM-GRAIN invariant the deal-site
//      conversions rely on (every kind one deal produces shares one value).
//   4. `mealDrawPlan` — the NPC meal's ceil/min/stop-early/at-least-one logic.
//   5. `ingestMeterAfter` — the subtraction, its full-clear-with-overshoot
//      byte-identity, and the NEED_FILL_DAYS.hunger divisor anchor (M5: a
//      metabolism-scaled divisor moves the five-apples arithmetic and reds
//      these pins).
//   6. WIRING conformance (source-text, no import): the quest-host call sites
//      the mutations M1-M3 would revert.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SATIATION_DAYS,
  FOOD_KINDS,
  SATIATION_DAYS,
  TREAT_KINDS,
  satiationDaysOf,
  rationsOf,
  rationTotalOf,
  carryRationTotalOf,
  unitsForRations,
  grainSatiationDaysOf,
  mealDrawPlan,
  ingestMeterAfter,
  kindsOf,
  CLOTHING_KINDS,
  MEAL_KINDS,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import { NEED_FILL_DAYS } from "@shared/world-engine/scale.js";

const FRUIT = FOOD_KINDS[0]!; // a raw food kind (satiation 0.2)
const STEW = `${FRUIT}.hot`; // its cooked meal (satiation 1)
const COOKIE = TREAT_KINDS[0]!; // the rare-import treat (satiation 0.1)

describe("rationsOf — the container boundary read (⑧)", () => {
  it("mixed stack: 3 fruit + 1 stew + 2 cookies = 0.6 + 1 + 0.2 = 1.8 rations", () => {
    expect(rationsOf({ [FRUIT]: 3, [STEW]: 1, [COOKIE]: 2 })).toBeCloseTo(1.8, 10);
  });

  it("empty stack is 0", () => {
    expect(rationsOf({})).toBe(0);
  });

  it("an unknown glyph defaults to 1 (the old welded behavior)", () => {
    expect(satiationDaysOf("mystery_thing")).toBe(DEFAULT_SATIATION_DAYS);
    expect(rationsOf({ mystery_thing: 4 })).toBe(4);
  });

  it("rationTotalOf counts the GOOD's strict kinds only — a stashed treat or a hot unit never inflates the pantry clock", () => {
    const chest = { [FRUIT]: 5, [COOKIE]: 3, [STEW]: 1, wood: 7 };
    expect(rationTotalOf(chest, "food")).toBeCloseTo(1.0, 10); // 5 × 0.2
  });

  it("carryRationTotalOf uses the CARRY projection: a gifted cookie counts at its own 0.1", () => {
    const hand = { [FRUIT]: 5, [COOKIE]: 3, [STEW]: 1 };
    // 5 × 0.2 + 3 × 0.1 — the hot unit is the MEAL category, not food's carry.
    expect(carryRationTotalOf(hand, "food")).toBeCloseTo(1.3, 10);
    expect(carryRationTotalOf(hand, "meal")).toBeCloseTo(1.0, 10);
  });
});

describe("unitsForRations — the inverse seam (⑧)", () => {
  it("one ration of raw food is five items; of a meal, one", () => {
    expect(unitsForRations(1, FRUIT)).toBe(5);
    expect(unitsForRations(1, STEW)).toBe(1);
    expect(unitsForRations(1, COOKIE)).toBe(10);
  });

  it("rounds to nearest and floors at 0", () => {
    expect(unitsForRations(0.49, STEW)).toBe(0);
    expect(unitsForRations(0.51, STEW)).toBe(1);
    expect(unitsForRations(-2, FRUIT)).toBe(0);
  });

  it("round-trip conservation: dealing then reading back never drifts by more than HALF of one glyph's satiation", () => {
    for (const glyph of [FRUIT, STEW, COOKIE, "water"]) {
      const w = satiationDaysOf(glyph);
      for (let r = 0; r <= 15; r += 0.1) {
        const dealt = unitsForRations(r, glyph);
        const back = rationsOf({ [glyph]: dealt });
        expect(Math.abs(back - r)).toBeLessThanOrEqual(w / 2 + 1e-9);
      }
    }
  });
});

describe("grainSatiationDaysOf — the deal grain (⑧)", () => {
  it("food deals at 0.2, water/clothing/meal at their own grain", () => {
    expect(grainSatiationDaysOf("food")).toBe(SATIATION_DAYS.food);
    expect(grainSatiationDaysOf("water")).toBe(1);
    expect(grainSatiationDaysOf("clothing")).toBe(1);
    expect(grainSatiationDaysOf("meal")).toBe(SATIATION_DAYS.meal);
  });

  it("UNIFORM-GRAIN INVARIANT: every kind a single deal can produce shares its good's grain (the load-edge conversion relies on it)", () => {
    for (const goodKey of ["food", "water", "clothing", "meal", "laundry"]) {
      const grain = grainSatiationDaysOf(goodKey);
      for (const k of kindsOf(goodKey)) {
        expect(satiationDaysOf(k)).toBe(grain);
      }
    }
    // Belt and braces on the two enumerations the deal actually walks.
    for (const k of CLOTHING_KINDS) expect(satiationDaysOf(k)).toBe(1);
    for (const k of MEAL_KINDS) expect(satiationDaysOf(k)).toBe(SATIATION_DAYS.meal);
  });
});

describe("mealDrawPlan — the NPC meal (⑦, R1)", () => {
  it("satiation-1 content draws exactly ONE unit (byte-identity with the old single draw)", () => {
    const plan = mealDrawPlan(1, [{ glyph: STEW, units: 3 }]);
    expect(plan.draws).toEqual([1]);
    expect(plan.satiationDays).toBe(1);
  });

  it("a one-ration appetite over raw fruit draws FIVE units (M2: a single-unit meal reds this)", () => {
    const plan = mealDrawPlan(1, [{ glyph: FRUIT, units: 12 }]);
    expect(plan.draws).toEqual([5]);
    expect(plan.satiationDays).toBeCloseTo(1, 10);
  });

  it("prices each unit at its OWN glyph: stew first stops the meal; fruit-first mixes", () => {
    // Hot meal offered first (the eat order): one stew covers the appetite.
    expect(mealDrawPlan(1, [{ glyph: STEW, units: 1 }, { glyph: FRUIT, units: 10 }]).draws).toEqual([1, 0]);
    // Fruit first: 2 apples (0.4) then the stew tops it past 1 → 1.4 total.
    const mixed = mealDrawPlan(1, [{ glyph: FRUIT, units: 2 }, { glyph: STEW, units: 1 }]);
    expect(mixed.draws).toEqual([2, 1]);
    expect(mixed.satiationDays).toBeCloseTo(1.4, 10);
  });

  it("stops early when the larder runs dry — partial satiation reported, nothing invented (R2)", () => {
    const short = mealDrawPlan(1, [{ glyph: FRUIT, units: 2 }]);
    expect(short.draws).toEqual([2]);
    expect(short.satiationDays).toBeCloseTo(0.4, 10);
  });

  it("AT LEAST ONE unit whenever anything is offered — the commanded bite (appetite 0)", () => {
    const bite = mealDrawPlan(0, [{ glyph: FRUIT, units: 3 }]);
    expect(bite.draws).toEqual([1]);
    expect(bite.satiationDays).toBeCloseTo(0.2, 10);
  });

  it("nothing offered → nothing drawn (the give-up guard's input)", () => {
    expect(mealDrawPlan(1, [])).toEqual({ draws: [], satiationDays: 0 });
  });

  it("a sub-ration appetite draws ceil(appetite / satiation): 0.3 over fruit is 2 units", () => {
    expect(mealDrawPlan(0.3, [{ glyph: FRUIT, units: 9 }]).draws).toEqual([2]);
  });
});

describe("ingestMeterAfter — the subtraction (⑦, R3/R4)", () => {
  it("a covering meal clears the appetite, OVERSHOOT INCLUDED (byte-identity with the old zero)", () => {
    expect(ingestMeterAfter(1.04, 1)).toBe(0); // the default-1 call
    expect(ingestMeterAfter(0.4, 1)).toBe(0);
    expect(ingestMeterAfter(2.5, 1.4)).toBe(0); // a mixed 1.4 meal covers too
  });

  it("FIVE FEEDS: each hand-fed apple visibly moves the meter by exactly 0.2 (M1: set-0 reds this; M5: a metabolism-scaled divisor reds this)", () => {
    // The divisor is NEED_FILL_DAYS.hunger — the RATION ANCHOR — never
    // needFillDays(scale, "hunger"): under a 3× metabolism the mutated
    // arithmetic would subtract 0.6/feed and finish in two, not five.
    let meter = 1.0;
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) {
      meter = ingestMeterAfter(meter, SATIATION_DAYS.food!);
      steps.push(meter);
    }
    expect(steps.map((v) => Number(v.toFixed(10)))).toEqual([0.8, 0.6, 0.4, 0.2, 0]);
  });

  it("partial meal subtracts what was eaten and clamps at 0 — never a free clear", () => {
    expect(ingestMeterAfter(1.04, 0.4)).toBeCloseTo(0.64, 10);
    expect(ingestMeterAfter(0.1, 0.2)).toBe(0);
  });

  it("the ration anchor itself: NEED_FILL_DAYS.hunger is 1 (every book normalizes to one ration per day)", () => {
    expect(NEED_FILL_DAYS.hunger).toBe(1);
  });
});

// ── WIRING CONFORMANCE (source-text, no host import) ────────────────────────
// The mutations M1-M3 revert CALL SITES in quest-host; booting the host in
// jest is off-limits (transform tax — play behavior belongs to text mode), so
// the wiring itself is pinned as text: cheap, DB-free, and red the moment a
// site is quietly reverted.
describe("quest-host wiring (⑦/⑧ call sites)", () => {
  const src = readFileSync(
    join(process.cwd(), "shared", "world-engine", "interaction", "quest", "quest-host.ts"),
    "utf8",
  );

  it("M1 — the spoken-eat path passes the eaten glyph's satiation into the ingest effect", () => {
    expect(src).toMatch(/applyIngestEffect\(session, cid, meterKey\.slice\(cid\.length \+ 1\), satiationDaysOf\(glyph\)\)/);
  });

  it("M2 — the consume branch draws the meal through mealDrawPlan and ingests ONCE with the drawn total", () => {
    expect(src).toMatch(/const plan = mealDrawPlan\(appetite, offers\)/);
    expect(src).toMatch(/applyIngestEffect\(session, cid, step\.tplKey, satEaten\)/);
  });

  it("M3 — reanchorHouseGoods feeds the goods clock RATIONS, not raw item counts", () => {
    const start = src.indexOf("function reanchorHouseGoods");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("\n  function ", start + 1);
    const fn = src.slice(start, end > start ? end : start + 700);
    expect(fn).toContain("rationTotalOf(");
    expect(fn).not.toContain("stackTotalOf(");
  });

  it("the load edge and the first seeding convert the ration level to items at the deal grain", () => {
    const deals = src.match(/dealGood\(session\.dress, g\.good\.key, unitsForRations\(level, kindsOf\(g\.good\.key\)\[0\] \?\? g\.good\.key\), house\.index\)/g);
    expect(deals?.length).toBe(2);
  });

  it("the hunger meter subtraction has ONE owner (ingestMeterAfter) — no inline divisor to drift", () => {
    expect(src).toMatch(/ingestMeterAfter\(session\.needMeters\.get\(key\) \?\? 0, satiationDays\)/);
  });
});
