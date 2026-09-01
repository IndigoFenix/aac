// THE FARM SOURCE REGION — food-scale E-round, E-b (+ the E-g conservation
// pins): a field is one more expression of a resource-source endpoint. The
// builder (`farmAreaRecord`) mints a fully sown, fully ripe region whose cap
// the caller derives from `yieldPerM2Daily`; the draw is the forest draw
// unchanged (pick path — conservation to the unit); the RIPEN walk is the
// field pulse (regrowth for a record drawn while folded — forests keep
// resume-on-expand); the SOW arm plants class-0 and arms first ripenings.
// Growth timing rides `generation`, never `resourceCompression` — the
// periods handed in here are derived that way, as the caller law requires.
//
// + IMPORT-DISPLACEMENT ROUND, STAGE A (2026-09-01): harvest caps follow the
// stand's CLASS MIX (`standHarvestCaps`, one derivation, sow + advance both
// call it) and `localYieldPerDay` reads cap as the per-day rate. The
// deliberate pin change is in "the starter stand": a sown apple orchard is
// SAPLINGS and bears 0 until it climbs — the old suite pinned the defect.
// Slice: `npm run test:engine -- farm-region`

import { describe, it, expect } from "@jest/globals";
import {
  farmAreaRecord, farmAreaKey, sowWildArea, ripenWildArea, drawWildArea,
  advanceWildArea, localYieldPerDay, localDailyUnitsForGood, standHarvestCaps,
  plantsForYield, seedAccessOf, seedGlyphsOf, sowStarterStand, standingSpeciesOf,
  STARTER_STAND_FRACTION,
  wildAreaStock, wildAreaPopulation, type WildAreaRecord,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import { sourceSuitabilityAt, type ClimateSample } from "@shared/world-engine/products.js";
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
// The caller's class-climb period (`growthClassPeriodS` lives outside the pure
// module). Any positive number: what is pinned is the ORDER of the clocks, not
// the calendar the host derives them from.
const CLIMB_S = 400 * DAY_S;

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

// ── A FARM ON HOSTILE GROUND (2026-09-01, suitability-as-yield) ─────────────
// The live cap is now `area × yieldPerM2Daily × sourceSuitabilityAt(crop,
// climate)`, and on ground the crop's niche scores 0 for (fertility 0, frozen,
// bone dry) that product is 0. The host MINTS the region anyway — barren is an
// answer, not a degeneracy — so the market reads an honest 0 through the same
// haul reader instead of falling back to the catchment formula and conjuring
// food out of a field that grew none. This pins that a 0 cap is a legal record
// end to end: no NaN, no division by a zero population, no phantom stock.
describe("a zero cap — the region stands, and it stands empty", () => {
  const barren = (now = 0): WildAreaRecord =>
    farmAreaRecord({
      key: farmAreaKey("scree"),
      area: { x: -500, y: -500, w: 1000, h: 1093 },
      seed: 7,
      species: "carrot_plant",
      capUnits: { carrot: 0 },
      now,
    });

  it("mints 0 plants and 0 stock — a farm that stands, bearing nothing", () => {
    const rec = barren();
    expect(rec.key).toBe("farm-scree");
    expect(wildAreaPopulation(rec)).toBe(0); // the per-plant divisor is guarded
    expect(wildAreaStock(rec)).toEqual({});
    expect(rec.stands[0]!.cap).toEqual({}); // a 0 cap is not a cap entry
    expect(rec.stands[0]!.regrowAt).toEqual({});
    expect(rec.stands[0]!.climbAt).toHaveLength(0);
    expect(Number.isFinite(wildAreaPopulation(rec))).toBe(true);
  });

  it("the pulse never fires and the haul draws nothing — no NaN anywhere", () => {
    const rec = barren();
    // A population-0 stand is skipped by the ripening walk: nothing bears, so
    // nothing re-ripens, and the record is returned UNTOUCHED (same object).
    expect(ripenWildArea(rec, 10 * DAY_S, period)).toBe(rec);
    // …and the day's haul finds nothing to take: pure, unmoved, conserving.
    const { rec: after, taken } = drawWildArea(rec, { glyph: "carrot", units: 300, now: 10 });
    expect(taken).toEqual({});
    expect(after).toBe(rec);
    expect(wildAreaStock(after).carrot ?? 0).toBe(0);
  });

  it("sowing is what brings it back — barren ground is not a dead record", () => {
    // The one honest recovery: a region with 0 plants still accepts the sow
    // arm, so nothing about a zero cap is terminal.
    const rec = sowWildArea(barren(), "carrot_plant", 4, 20, () => REGROW_S);
    expect(wildAreaPopulation(rec)).toBe(4);
    expect(rec.stands[0]!.cap.carrot).toBe(8); // 4 plants × midpoint 2
    expect(wildAreaStock(rec).carrot ?? 0).toBe(0); // production arrives on the clock
    expect(wildAreaStock(ripenWildArea(rec, 20 + REGROW_S, period)).carrot).toBe(8);
  });
});

// ── SEED-ARRIVAL CULTIVATION (resource-access round Stage 3, 2026-09-01) ────
//
// The user's ruling: "a place may plant a species only once the good has
// landed there — derivable from FLOW MEMORY, never a new list", and the arc it
// buys: expensive import → local planting → the import fades (the Columbian
// exchange). Two halves, both pinned here at the PURE layer, because no test
// may value-import quest-host:
//
//   • the READ — `seedAccessOf(place, species)` over two plain string sets
//     (what stands here, what has ever landed here), joined to the catalogue
//     through `foodPlants()`;
//   • the ACT — `sowStarterStand`, a modest deterministic trial plot sized
//     off the field's own founding crop and scaled by Stage 2's suitability
//     multiplier.
//
// The host supplies the sets (`standingSpeciesOf` over its area records, the
// transfer ledger's first-arrival rows) and hard-gates the ACT on
// `session.climate`; neither of those needs a quest-host to be pinned.

// Perfect apple ground: rain AT the niche optimum (.9), temp AT it (12),
// sea-level, and the tree declares no fertility window ⇒ suitability exactly 1.
const APPLE_PERFECT: ClimateSample = { rain: 0.9, tempC: 12, elevation: 0, fertility: 7 };
// The same tree, wetter and colder: still inside every apple bound, so it
// lives — but marginally, which by Stage 2's law thins the crop rather than
// refusing it.
const APPLE_MARGINAL: ClimateSample = { rain: 1.15, tempC: 3, elevation: 0, fertility: 7 };
// Tropical: the apple sets no fruit past 25 °C — a breached HARD bound.
const TROPICS: ClimateSample = { rain: 2.0, tempC: 28, elevation: 0, fertility: 9 };

describe("seed access — derived from flow memory, never a list", () => {
  it("a species already STANDING here needs no evidence at all", () => {
    const standing = standingSpeciesOf([freshFarm()]);
    expect([...standing]).toEqual(["carrot_plant"]);
    // Layer-2 presence IS seeds at hand: you take them off the plants.
    expect(seedAccessOf({ standing, arrived: [] }, "carrot_plant")).toBe(true);
  });

  it("a food glyph in the arrival evidence unlocks the species that BEARS it", () => {
    expect(seedGlyphsOf("apple_tree")).toEqual(["apple"]);
    const place = { standing: ["carrot_plant"], arrived: ["apple", "cookie"] };
    expect(seedAccessOf(place, "apple_tree")).toBe(true);
    // …and only that species: the evidence names a GOOD, and the catalogue
    // says which plant it came off.
    expect(seedAccessOf(place, "banana_plant")).toBe(false);
    expect(seedAccessOf(place, "grape_vine")).toBe(false);
  });

  it("neither standing nor landed is false, and a non-bearing species never unlocks", () => {
    expect(seedAccessOf({ standing: [], arrived: [] }, "apple_tree")).toBe(false);
    expect(seedAccessOf({ standing: ["carrot_plant"], arrived: ["wood", "cookie"] }, "apple_tree"))
      .toBe(false);
    // `rock` bears no food glyph at all — no amount of evidence plants a stone.
    expect(seedGlyphsOf("rock")).toEqual([]);
    expect(seedAccessOf({ standing: [], arrived: ["apple", "wood", "cookie"] }, "rock")).toBe(false);
    // …but standing IS still standing, for anything.
    expect(seedAccessOf({ standing: ["rock"], arrived: [] }, "rock")).toBe(true);
  });

  it("head-matches the evidence — a facted glyph is still the good", () => {
    expect(seedAccessOf({ standing: [], arrived: ["apple.ripe"] }, "apple_tree")).toBe(true);
  });

  it("standingSpeciesOf reads every stand across every record", () => {
    const farm = sowWildArea(freshFarm(), "apple_tree", 4, 0, () => REGROW_S);
    const wood: WildAreaRecord = {
      key: "wild-1", area: { x: 0, y: 0, w: 10, h: 10 }, seed: 1, at: 0,
      stands: [{ species: "oak", byClass: [3], stock: {}, cap: {}, climbAt: [], regrowAt: {} }],
      draw: [],
    };
    expect([...standingSpeciesOf([farm, wood])].sort())
      .toEqual(["apple_tree", "carrot_plant", "oak"]);
  });
});

describe("the starter stand — the arc's second half, at the wild-area level", () => {
  // The sizing, stated once: a tenth of the FOUNDING crop's cap, scaled by how
  // well this ground grows the newcomer, converted to plants through the same
  // per-plant bearing the region builder mints from.
  const sow = (rec: WildAreaRecord, species: string, climate?: ClimateSample) =>
    sowStarterStand(rec, species, {
      now: 100,
      suitability: sourceSuitabilityAt(species, climate),
      regrowPeriodS: () => REGROW_S,
    });
  /** The same act with the class clock the host supplies — an orchard that can
   *  actually grow up (the bare `sow` above arms no climb, so its saplings
   *  stay saplings forever, which is what the pure module is told to do). */
  const sowClassed = (rec: WildAreaRecord, species: string, climate?: ClimateSample) =>
    sowStarterStand(rec, species, {
      now: 100,
      suitability: sourceSuitabilityAt(species, climate),
      regrowPeriodS: () => REGROW_S,
      classPeriodS: () => CLIMB_S,
    });

  const units = Math.round(CAP * STARTER_STAND_FRACTION);
  const plants = plantsForYield("apple_tree", units); // apple midpoint 2

  it("plants a tenth of the founding crop's cap, in plants, and arms their clocks", () => {
    expect(sourceSuitabilityAt("apple_tree", APPLE_PERFECT)).toBe(1);
    expect(plants).toBe(Math.ceil(units / 2));
    expect(plants).toBeGreaterThan(100); // ~113 off the Q3 field — a trial plot

    const rec = freshFarm();
    const sown = sow(rec, "apple_tree", APPLE_PERFECT);
    expect(sown).not.toBe(rec);
    expect(rec.stands).toHaveLength(1); // pure: the input is untouched
    expect(sown.stands).toHaveLength(2);
    const st = sown.stands[1]!;
    expect(st.species).toBe("apple_tree");
    // Sown as SAPLINGS (class 0 of two) — nothing bears at the act…
    expect(st.byClass).toEqual([plants, 0]);
    expect(wildAreaStock(sown).apple ?? 0).toBe(0);
    // ⚖️ …AND NOTHING BEARS AFTER IT EITHER, until the trees grow up (import-
    // displacement Stage A — this pin used to read `plants * 2` and pinned the
    // defect: cap was booked at the MATURE bearing on the day of planting, so
    // an 8-year orchard yielded its full crop one pulse after the seeds
    // landed). A sapling's yieldMul is 0, so it lifts the cap by nothing.
    expect(st.cap.apple ?? 0).toBe(0);
    // The first ripening is still QUEUED per plant — the clock is armed by
    // what the plant will ever bear, not by what it bears today.
    expect(st.regrowAt.apple).toHaveLength(plants);
    // The founding crop is untouched — a corner of the field, not a conversion.
    expect(sown.stands[0]!.cap).toEqual({ carrot: CAP });
    expect(wildAreaStock(sown).carrot).toBe(CAP);
    // The first pulse brings the newcomer NOTHING: a cap of 0 is a pulse with
    // nothing to refill, and the walk is a no-op over the whole record.
    const firstPulse = ripenWildArea(sown, 100 + REGROW_S, period);
    expect(firstPulse).toBe(sown); // same object: nothing moved anywhere
    expect(wildAreaStock(firstPulse).apple ?? 0).toBe(0);
  });

  it("🚨 the climb is what brings the orchard in — cap follows the class mix", () => {
    const sown = sowClassed(freshFarm(), "apple_tree", APPLE_PERFECT);
    const young = sown.stands[1]!;
    expect(young.climbAt).toHaveLength(plants); // one clock per sapling
    expect(young.cap.apple ?? 0).toBe(0);

    // The regrow deadlines pass while the cap is 0. 🚨 They are NOT dropped:
    // `ripenWildArea` skips a glyph with no cap BEFORE it touches `regrowAt`,
    // so the whole queue sits stale in the past and the record never moves.
    const stalled = ripenWildArea(sown, 100 + REGROW_S * 5, period);
    expect(stalled).toBe(sown);
    expect(stalled.stands[1]!.regrowAt.apple).toHaveLength(plants);

    // THE CLIMB: every sapling matures, and the harvest cap follows the mix
    // through the same `standHarvestCaps` the sow arm books with.
    const grown = advanceWildArea(stalled, 100 + CLIMB_S, () => CLIMB_S, () => REGROW_S);
    const old = grown.stands[1]!;
    expect(old.byClass).toEqual([0, plants]);
    expect(old.climbAt).toHaveLength(0); // mature: the clock retires
    expect(old.cap.apple).toBe(plants * 2);
    expect(old.cap.apple).toBe(standHarvestCaps("apple_tree", [0, plants]).apple);
    expect(wildAreaStock(grown).apple ?? 0).toBe(0); // a climb is not a harvest
    // The founding crop rode through untouched — a climb books a DIFFERENCE.
    expect(grown.stands[0]!.cap).toEqual({ carrot: CAP });

    // …and the first pulse AFTER the climb brings the orchard in, off the
    // stale deadlines the cap-0 years preserved.
    const ripe = ripenWildArea(grown, 100 + CLIMB_S + REGROW_S, period);
    expect(wildAreaStock(ripe).apple).toBe(plants * 2);
    expect(ripe.stands[1]!.regrowAt.apple).toBeUndefined(); // at cap: retired
  });

  it("a GROWTHLESS newcomer still bears on the first pulse — the contrast", () => {
    // The tropics that plant no apple at all are exactly where the banana
    // stands, and the banana declares NO growth block: one class, born mature.
    expect(sourceSuitabilityAt("banana_plant", TROPICS)).toBe(1);
    const bUnits = Math.round(CAP * STARTER_STAND_FRACTION);
    const bPlants = plantsForYield("banana_plant", bUnits); // midpoint 2
    const sown = sowClassed(freshFarm(), "banana_plant", TROPICS);
    const st = sown.stands[1]!;
    expect(st.byClass).toEqual([bPlants]); // one bucket, and it is the mature one
    expect(st.climbAt).toHaveLength(0); // nothing to climb to
    expect(st.cap.banana).toBe(bPlants * 2); // bearing at the act, as always
    expect(wildAreaStock(sown).banana ?? 0).toBe(0); // production is the clock's
    expect(wildAreaStock(ripenWildArea(sown, 100 + REGROW_S, period)).banana)
      .toBe(bPlants * 2);
  });

  it("DEDUPES ON THE STAND — a second arrival of the same species sows nothing", () => {
    const once = sow(freshFarm(), "apple_tree", APPLE_PERFECT);
    const twice = sow(once, "apple_tree", APPLE_PERFECT);
    expect(twice).toBe(once); // the same object back: nothing moved
    expect(twice.stands).toHaveLength(2);
    // A DIFFERENT species still plants — the dedupe is per stand, not a latch.
    const withGrape = sow(twice, "grape_vine", APPLE_PERFECT);
    expect(withGrape.stands.map((s) => s.species))
      .toEqual(["carrot_plant", "apple_tree", "grape_vine"]);
    // …and it is sized off the FOUNDING crop, never off the growing total:
    // adding species cannot inflate the next newcomer's plot.
    const grapeSuit = sourceSuitabilityAt("grape_vine", APPLE_PERFECT);
    const grapeUnits = Math.round(CAP * STARTER_STAND_FRACTION * grapeSuit);
    expect(withGrape.stands[2]!.cap.grape).toBe(plantsForYield("grape_vine", grapeUnits) * 2);
  });

  it("suitability MULTIPLIES the planting, never gates it — marginal ground, thin plot", () => {
    const suit = sourceSuitabilityAt("apple_tree", APPLE_MARGINAL);
    expect(suit).toBeGreaterThan(0);
    expect(suit).toBeLessThan(1);
    const thin = sow(freshFarm(), "apple_tree", APPLE_MARGINAL);
    const full = sow(freshFarm(), "apple_tree", APPLE_PERFECT);
    const n = (r: WildAreaRecord) => r.stands[1]!.byClass[0]!;
    expect(n(thin)).toBe(plantsForYield("apple_tree", Math.round(CAP * STARTER_STAND_FRACTION * suit)));
    expect(n(thin)).toBeGreaterThan(0);
    expect(n(thin)).toBeLessThan(n(full));
  });

  it("ground that breaches a hard bound plants nothing — the ground's verdict", () => {
    expect(sourceSuitabilityAt("apple_tree", TROPICS)).toBe(0);
    const rec = freshFarm();
    expect(sow(rec, "apple_tree", TROPICS)).toBe(rec);
    // …and a field with no founding stand to size against plants nothing either.
    const empty: WildAreaRecord = { ...rec, stands: [] };
    expect(sowStarterStand(empty, "apple_tree", {
      now: 0, suitability: 1, regrowPeriodS: () => REGROW_S,
    })).toBe(empty);
  });

  it("plantsForYield is the region builder's own derivation, guarded at the edges", () => {
    expect(plantsForYield("apple_tree", 0)).toBe(0);
    expect(plantsForYield("no_such_plant", 100)).toBe(0);
    expect(plantsForYield("rock", 100)).toBe(0); // no harvest product bears
    expect(plantsForYield("apple_tree", 1)).toBe(1); // never rounds down to nothing
  });
});

// ── ⚖️ CLASS-AWARE HARVEST CAPS (import-displacement round, Stage A) ────────
//
// ONE derivation of a stand's caps from its class mix, called by the sow arm
// and by the growth walk. These pin the derivation itself and the CLOCK
// LIFECYCLE around it — the sapling stand's cap is 0, and `ripenWildArea`
// retires clocks at cap, so "does a cap-0 stand lose its regrow queue" is the
// question the whole ramp turns on.
describe("standHarvestCaps — the one derivation, and the clock that survives it", () => {
  it("sums the class mix, per harvest product, and omits a zero", () => {
    // apple: sapling yieldMul 0, mature 1, midpoint 2.
    expect(standHarvestCaps("apple_tree", [5, 0])).toEqual({}); // a 0 is not an entry
    expect(standHarvestCaps("apple_tree", [0, 5])).toEqual({ apple: 10 });
    expect(standHarvestCaps("apple_tree", [3, 5])).toEqual({ apple: 10 }); // the mix
    // growthless: one bucket, and it bears the catalogue's own midpoint.
    expect(standHarvestCaps("carrot_plant", [7])).toEqual({ carrot: 14 });
    expect(standHarvestCaps("banana_plant", [7])).toEqual({ banana: 14 });
    // kill-only and unknown species bear nothing — no phantom entry, no throw.
    expect(standHarvestCaps("oak", [0, 0, 9])).toEqual({});
    expect(standHarvestCaps("no_such_plant", [9])).toEqual({});
    expect(standHarvestCaps("apple_tree", [])).toEqual({});
  });

  /** A stand mid-climb with NO regrow queue at all — the shape the belt in
   *  `advanceWildArea` exists for (a sown stand keeps its stale deadlines; a
   *  folded one that was picked to cap and retired them does not). */
  const midClimb = (): WildAreaRecord => ({
    key: "wild-orchard",
    area: { x: 0, y: 0, w: 100, h: 100 },
    seed: 3,
    at: 0,
    stands: [{
      species: "apple_tree",
      byClass: [1, 0],
      stock: {},
      cap: {},
      climbAt: [{ cls: 0, at: 50 }],
      regrowAt: {},
    }],
    draw: [],
  });

  it("🚨 a climb that RAISES the cap arms the refill it just made possible", () => {
    const grown = advanceWildArea(midClimb(), 50, () => CLIMB_S, () => REGROW_S);
    const st = grown.stands[0]!;
    expect(st.byClass).toEqual([0, 1]);
    expect(st.cap.apple).toBe(2); // the climb's DIFFERENCE, booked
    expect(st.regrowAt.apple).toEqual([50 + REGROW_S]); // the belt armed it
    // …and the pulse at that date fills the tree, one period after maturity.
    expect(wildAreaStock(ripenWildArea(grown, 50 + REGROW_S, period)).apple).toBe(2);
  });

  it("without the period the walk is byte-identical, and the HEAL arm still covers it", () => {
    // The 4th argument is optional: every shipped caller passes three, and the
    // record that comes back is the shipped one plus the cap delta.
    const bare = advanceWildArea(midClimb(), 50, () => CLIMB_S);
    expect(bare.stands[0]!.cap.apple).toBe(2);
    expect(bare.stands[0]!.regrowAt).toEqual({}); // nothing armed
    // `ripenWildArea`'s HEAL arm arms one at now + period instead, so the
    // orchard fills one pulse LATER — the belt buys exactly that pulse.
    const healed = ripenWildArea(bare, 50 + REGROW_S, period);
    expect(wildAreaStock(healed).apple ?? 0).toBe(0);
    expect(healed.stands[0]!.regrowAt.apple).toEqual([50 + 2 * REGROW_S]);
    expect(wildAreaStock(ripenWildArea(healed, 50 + 2 * REGROW_S, period)).apple).toBe(2);
  });
});

// ── ⚖️ THE LOCAL-SUPPLY READER (import-displacement round, Stage A) ─────────
//
// `cap` is the per-pulse refill and the host's pulse is one day, so cap IS the
// daily production rate. The `excludeSpecies` seat is the books' double-count
// guard (Stage B excludes the books-asserted founding crop).
describe("localYieldPerDay — cap IS the daily rate", () => {
  it("a carrot-only region answers its founding cap, per glyph", () => {
    expect(localYieldPerDay(freshFarm())).toEqual({ carrot: CAP });
    // Not stock: a picked field still PRODUCES the same amount per day.
    const picked = drawWildArea(freshFarm(), { glyph: "carrot", units: 500, now: 10 }).rec;
    expect(wildAreaStock(picked).carrot).toBe(CAP - 500);
    expect(localYieldPerDay(picked)).toEqual({ carrot: CAP });
  });

  it("sums every stand, and excludeSpecies drops the excluded one's glyphs", () => {
    const rec = sowWildArea(freshFarm(), "banana_plant", 6, 20, () => REGROW_S);
    expect(localYieldPerDay(rec)).toEqual({ carrot: CAP, banana: 12 });
    expect(localYieldPerDay(rec, { excludeSpecies: ["carrot_plant"] }))
      .toEqual({ banana: 12 });
    expect(localYieldPerDay(rec, { excludeSpecies: ["banana_plant"] }))
      .toEqual({ carrot: CAP });
    // Absent / empty / unknown are all "every stand" — the seat never gates.
    expect(localYieldPerDay(rec, {})).toEqual({ carrot: CAP, banana: 12 });
    expect(localYieldPerDay(rec, { excludeSpecies: [] })).toEqual({ carrot: CAP, banana: 12 });
    expect(localYieldPerDay(rec, { excludeSpecies: ["oak"] })).toEqual({ carrot: CAP, banana: 12 });
    expect(localYieldPerDay(rec, { excludeSpecies: ["carrot_plant", "banana_plant"] }))
      .toEqual({});
  });

  it("a sapling orchard reads 0 — this is why a fade cannot fire at planting", () => {
    const sown = sowStarterStand(freshFarm(), "apple_tree", {
      now: 100, suitability: 1, regrowPeriodS: () => REGROW_S, classPeriodS: () => CLIMB_S,
    });
    const want = plantsForYield("apple_tree", Math.round(CAP * STARTER_STAND_FRACTION));
    expect(localYieldPerDay(sown)).toEqual({ carrot: CAP });
    const grown = advanceWildArea(sown, 100 + CLIMB_S, () => CLIMB_S, () => REGROW_S);
    expect(localYieldPerDay(grown)).toEqual({ carrot: CAP, apple: want * 2 });
  });

  it("a barren region produces nothing, and says so without a NaN", () => {
    const barren = farmAreaRecord({
      key: farmAreaKey("scree"),
      area: { x: 0, y: 0, w: 10, h: 10 },
      seed: 1, species: "carrot_plant", capUnits: { carrot: 0 }, now: 0,
    });
    expect(localYieldPerDay(barren)).toEqual({});
  });
});

// ── ⚖️ STAGE B — THE SAME READING IN THE TRADE TIER'S OWN KEYS ──────────────
//
// `localDailyUnitsForGood` is the glyph→good projection and NOTHING else: the
// host's books term (`localDailyBooks`) is this sum times the one street→book
// converter, so if this function is right the signal is right. It takes an
// ITERABLE on purpose — the caller decides which ground counts, because the
// town's field is production the books can hear about and the wild scatter is
// not (the round's carried-forward law).
describe("localDailyUnitsForGood — glyph production, projected onto a good key", () => {
  const withBananas = () => sowWildArea(freshFarm(), "banana_plant", 6, 20, () => REGROW_S);

  it("routes every food glyph to `food`, and answers 0 for a good nothing grows", () => {
    const rec = withBananas();
    // carrot CAP + banana 12 — two glyphs, ONE good. Neither name appears in
    // the call: `goodKeyOfGlyph` is what knows a banana is food.
    expect(localDailyUnitsForGood([rec], "food")).toBe(CAP + 12);
    expect(localDailyUnitsForGood([rec], "clothing")).toBe(0);
    expect(localDailyUnitsForGood([rec], "wood")).toBe(0);
  });

  it("🚨 excludeSpecies is the books' double-count guard, and it is the WHOLE gap", () => {
    // The host excludes the founding crop because the compiled farm process
    // already asserts it — what is left is exactly the SOWN stands, which is
    // the only production the books have never heard of.
    expect(localDailyUnitsForGood([withBananas()], "food", {
      excludeSpecies: ["carrot_plant"],
    })).toBe(12);
    // 🔒 THE SHIPPED SAVE: a farm with no sown stand answers exactly 0 under
    // the same guard — this is why the term is a no-op for every world that
    // pre-dates the round.
    expect(localDailyUnitsForGood([freshFarm()], "food", {
      excludeSpecies: ["carrot_plant"],
    })).toBe(0);
  });

  it("sums the records it is GIVEN — no sweep, no records, no supply", () => {
    const a = withBananas();
    const b = sowWildArea(freshFarm(), "grape_vine", 4, 20, () => REGROW_S);
    expect(localDailyUnitsForGood([a, b], "food"))
      .toBe(localDailyUnitsForGood([a], "food") + localDailyUnitsForGood([b], "food"));
    expect(localDailyUnitsForGood([], "food")).toBe(0);
  });

  it("a sapling orchard contributes NOTHING until it climbs — the fade's floor", () => {
    const sown = sowStarterStand(freshFarm(), "apple_tree", {
      now: 100, suitability: 1, regrowPeriodS: () => REGROW_S, classPeriodS: () => CLIMB_S,
    });
    const only = { excludeSpecies: ["carrot_plant"] };
    expect(localDailyUnitsForGood([sown], "food", only)).toBe(0);
    const grown = advanceWildArea(sown, 100 + CLIMB_S, () => CLIMB_S, () => REGROW_S);
    const want = plantsForYield("apple_tree", Math.round(CAP * STARTER_STAND_FRACTION));
    expect(localDailyUnitsForGood([grown], "food", only)).toBe(want * 2);
  });
});

// ── ⚖️ THE SHIPPED FARM DOES NOT MOVE (import-displacement round, Stage A) ──
//
// `carrot_plant` declares no growth block — ONE class, born mature — and the
// shipped farm is a carrot farm. Every number below is what the suite pinned
// BEFORE class-aware caps landed; the whole point of the derivation is that a
// single-class crop cannot tell it happened.
describe("growthless byte-identity — the shipped farm, to the unit", () => {
  it("mint → sow → advance → ripen answers exactly the pre-change numbers", () => {
    const rec = freshFarm();
    // MINT — cap from the caller's `capUnits`, plants from the mature bearing.
    expect(rec.stands[0]!.cap).toEqual({ carrot: CAP });
    expect(rec.stands[0]!.stock).toEqual({ carrot: CAP });
    expect(rec.stands[0]!.byClass).toEqual([Math.ceil(CAP / 2)]);
    expect(rec.stands[0]!.climbAt).toHaveLength(0);
    expect(rec.stands[0]!.regrowAt).toEqual({});

    // SOW — class 0 IS the mature class, so the cap lift is the identical
    // `plants × midpoint` it always was (10 × 2).
    const sown = sowWildArea(rec, "carrot_plant", 10, 20, () => REGROW_S);
    expect(standHarvestCaps("carrot_plant", [10])).toEqual({ carrot: 20 });
    expect(sown.stands[0]!.cap).toEqual({ carrot: CAP + 20 });
    expect(sown.stands[0]!.stock).toEqual({ carrot: CAP });
    expect(sown.stands[0]!.byClass).toEqual([Math.ceil(CAP / 2) + 10]);
    expect(sown.stands[0]!.regrowAt.carrot).toHaveLength(10);
    expect(sown.stands).toHaveLength(1); // one species, one stand

    // ADVANCE — no growth block and no climb queue: the SAME OBJECT back, at
    // any clock. That short-circuit is what keeps a shipped save inert.
    expect(advanceWildArea(sown, 1e9, () => CLIMB_S, () => REGROW_S)).toBe(sown);
    expect(advanceWildArea(sown, 1e9, () => CLIMB_S)).toBe(sown);

    // RIPEN — the pulse refills to the lifted cap and retires the queue.
    const ripe = ripenWildArea(sown, 20 + REGROW_S, period);
    expect(ripe.stands[0]!.stock).toEqual({ carrot: CAP + 20 });
    expect(ripe.stands[0]!.cap).toEqual({ carrot: CAP + 20 });
    expect(ripe.stands[0]!.regrowAt).toEqual({});
    expect(localYieldPerDay(ripe)).toEqual({ carrot: CAP + 20 });
  });

  it("sowStarterStand still sizes off the founding cap it always read", () => {
    // `baseCap` is stand 0's cap total — the growthless carrot's, unchanged —
    // so a newcomer's plot is the same size it was before Stage A, and a
    // growthless newcomer bears at the act exactly as it used to.
    const rec = freshFarm();
    expect(Object.values(rec.stands[0]!.cap).reduce((a, b) => a + b, 0)).toBe(CAP);
    const sown = sowStarterStand(rec, "grape_vine", {
      now: 100, suitability: 1, regrowPeriodS: () => REGROW_S,
    });
    const want = plantsForYield("grape_vine", Math.round(CAP * STARTER_STAND_FRACTION));
    expect(sown.stands[1]!.byClass).toEqual([want]);
    expect(sown.stands[1]!.cap.grape).toBe(want * 2);
  });
});
