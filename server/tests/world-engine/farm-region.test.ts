// THE FARM SOURCE REGION — food-scale E-round, E-b (+ the E-g conservation
// pins): a field is one more expression of a resource-source endpoint. The
// builder (`farmAreaRecord`) mints a fully sown, fully ripe region whose cap
// the caller derives from `yieldPerM2Daily`; the draw is the forest draw
// unchanged (pick path — conservation to the unit); the RIPEN walk is the
// field pulse (regrowth for a record drawn while folded — forests keep
// resume-on-expand); the SOW arm plants class-0 and arms first ripenings.
// Growth timing rides `generation`, never `resourceCompression` — the
// periods handed in here are derived that way, as the caller law requires.
// Slice: `npm run test:engine -- farm-region`

import { describe, it, expect } from "@jest/globals";
import {
  farmAreaRecord, farmAreaKey, sowWildArea, ripenWildArea, drawWildArea,
  wildAreaStock, wildAreaPopulation, type WildAreaRecord,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import { yieldPerM2Daily, DAY_S, REAL_SCALE } from "@shared/world-engine/scale.js";
import { satiationDaysOf } from "@shared/world-engine/kernel/town/goods-kinds.js";

// The Q3-shaped region: the E2 check said 1.093e6 m² at dial 20 yields
// ~2 250 items/day. Cap derivation IS the caller's one closed form.
const AREA_M2 = 1_093_000;
const DIAL_20 = { ...REAL_SCALE, resourceCompression: 20 };
const CAP = Math.round(AREA_M2 * yieldPerM2Daily("ancient", DIAL_20, satiationDaysOf("carrot")));

// Growth rides generation: one game-day regrow, divided by the life dial.
const GENERATION = 5;
const REGROW_S = DAY_S / GENERATION;
const period = () => REGROW_S;

const freshFarm = (now = 0): WildAreaRecord =>
  farmAreaRecord({
    key: farmAreaKey("q3"),
    area: { x: -500, y: -500, w: 1000, h: 1093 },
    seed: 7,
    species: "carrot_plant",
    capUnits: { carrot: CAP },
    now,
  });

describe("the builder — a fully sown, fully ripe source region", () => {
  it("σ identity: the Q3 region's cap is the E2 table's ~2 250 items", () => {
    // 1.093e6 m² ÷ (2 428 × 0.2) — the two anchors divided, not a third number.
    expect(CAP).toBeGreaterThan(2200);
    expect(CAP).toBeLessThan(2300);
  });

  it("mints stock at cap, plants from per-plant bearing, no clocks running", () => {
    const rec = freshFarm();
    expect(rec.key).toBe("farm-q3");
    expect(wildAreaStock(rec)).toEqual({ carrot: CAP });
    expect(rec.stands[0]!.cap).toEqual({ carrot: CAP });
    // carrot yield 1-3 ⇒ midpoint 2 per plant.
    expect(wildAreaPopulation(rec)).toBe(Math.ceil(CAP / 2));
    expect(rec.stands[0]!.climbAt).toHaveLength(0);
    expect(rec.stands[0]!.regrowAt).toEqual({}); // full: no clock runs
    expect(() => farmAreaRecord({ ...({} as never), species: "no_such_plant" } as never)).toThrow();
  });
});

describe("the draw — the forest pick, conservation to the unit", () => {
  it("what leaves the stands equals the record's stock drop; nothing felled", () => {
    const rec = freshFarm();
    const before = wildAreaStock(rec).carrot!;
    const pop = wildAreaPopulation(rec);
    const { rec: after, taken } = drawWildArea(rec, { glyph: "carrot", units: 300, now: 10 });
    expect(taken.carrot).toBe(300);
    expect(wildAreaStock(after).carrot).toBe(before - 300);
    expect(wildAreaPopulation(after)).toBe(pop); // a pick, not a felling
    expect(wildAreaStock(rec).carrot).toBe(before); // pure: input untouched
  });
});

describe("the ripen walk — the field pulse, exact at the date", () => {
  it("heals a drawn stand with one clock, fires at the date, retires at cap", () => {
    let rec = freshFarm();
    rec = drawWildArea(rec, { glyph: "carrot", units: 500, now: 10 }).rec;
    // Below cap, no clock queued: the walk HEALS — arms one, refills nothing.
    rec = ripenWildArea(rec, 10, period);
    expect(wildAreaStock(rec).carrot).toBe(CAP - 500);
    expect(rec.stands[0]!.regrowAt.carrot).toEqual([10 + REGROW_S]);
    // Strictly before the date: nothing (quantized, never asymptotic).
    const early = ripenWildArea(rec, 10 + REGROW_S - 0.001, period);
    expect(wildAreaStock(early).carrot).toBe(CAP - 500);
    // At the date: the whole field bears again, and the clock retires.
    const ripe = ripenWildArea(rec, 10 + REGROW_S, period);
    expect(wildAreaStock(ripe).carrot).toBe(CAP);
    expect(ripe.stands[0]!.regrowAt.carrot).toBeUndefined();
    // At cap the walk is a no-op — the same object back.
    expect(ripenWildArea(ripe, 10 + 2 * REGROW_S, period)).toBe(ripe);
  });

  it("a century-skip is one pulse, not an integration", () => {
    let rec = freshFarm();
    rec = drawWildArea(rec, { glyph: "carrot", units: 100, now: 0 }).rec;
    rec = ripenWildArea(rec, 0, period); // heal: clock at REGROW_S
    const later = ripenWildArea(rec, REGROW_S * 1000, period);
    expect(wildAreaStock(later).carrot).toBe(CAP); // to cap, exactly once
  });
});

describe("the sow arm — planting moves the population, never the stock", () => {
  it("sows class-0 plants, lifts cap by their bearing, queues first ripening", () => {
    let rec = freshFarm();
    const pop = wildAreaPopulation(rec);
    rec = sowWildArea(rec, "carrot_plant", 10, 20, () => REGROW_S);
    expect(wildAreaPopulation(rec)).toBe(pop + 10);
    // A single-class crop's class-0 IS its mature bucket — the sown plants
    // join the standing ones (a classed species would enter a real nursery
    // class and climb).
    expect(rec.stands[0]!.byClass[0]).toBe(pop + 10);
    expect(rec.stands[0]!.cap.carrot).toBe(CAP + 20); // 10 plants × midpoint 2
    expect(wildAreaStock(rec).carrot).toBe(CAP); // nothing bears at the act
    expect(rec.stands[0]!.regrowAt.carrot).toHaveLength(10);
    // The first ripening brings the new plants' bearing in (the pulse
    // refills to the LIFTED cap).
    const ripe = ripenWildArea(rec, 20 + REGROW_S, period);
    expect(wildAreaStock(ripe).carrot).toBe(CAP + 20);
  });

  it("sowing an unknown species or nothing changes nothing", () => {
    const rec = freshFarm();
    expect(sowWildArea(rec, "no_such_plant", 5, 0, period)).toBe(rec);
    expect(sowWildArea(rec, "carrot_plant", 0, 0, period)).toBe(rec);
  });
});
