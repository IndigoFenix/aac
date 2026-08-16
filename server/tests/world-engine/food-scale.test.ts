// THE FOOD-SCALE ROUND (planning-docs/games/world-engine/food-scale-round.md,
// Phase A) — the pins for "food pressure is the honest driver of settlement
// size", and for the four `kernel/town/plan.ts` defects
// `earthlike-city-regression.md` measured.
//
// USER RULING (2026-08-15): *"Villages are often about 100-300 meters across in
// typical adventure games — about 1/10th of realistic size, compared to our
// current 1/360 ratio."* Plus the standing principle: POPULATION FOLLOWS
// CAPACITY — a site too small for its population gets a smaller population.
//
// What is pinned here:
//   1. The TIER ANCHORS and the geometric floor under a street tree.
//   2. REAL byte-identity: nothing this round added may move `REAL_SCALE`.
//   3. `foodShedSpacingM` and the `max(declared, shed)` spacing.
//   4. Stage α: `popCap` / `popSpill` on the plan, and the works loop scaled
//      by the capacity that actually stood.
//   5. The works loop's missing `count > 0` guard, the fallback ring's period-6
//      angle collision, the civic slot-release defect, and the field block's
//      housing gate.
//   6. The famine cross-check at the shipped dials.
//   7. `satiationDays` as DATA (default 1 ⇒ ingest unchanged; Phase B wires it).
//
// Pure logic + headless `buildTownPlay` (no DOM/GL/DB).

import { describe, it, expect } from "@jest/globals";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { HOUSEHOLD } from "@shared/world-engine/kernel/town/goods.js";
import {
  DEFAULT_SATIATION_DAYS, FOOD_KINDS, SATIATION_DAYS, satiationDaysOf,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import {
  DOLLHOUSE_SCALE, ERRAND_SHARE, ERRAND_WALK_MPS, M2_PER_ACRE, REAL_ARABLE_FRACTION,
  REAL_FOOD_HEADROOM, REAL_SCALE, REAL_SURPLUS_FRAC, REAL_TIER_EXTENT_M, REAL_TOWN_EXTENT_M,
  REAL_TOWN_SPACING_M, STREET_TREE_MIN_EXTENT_M, farmAcresPerPerson, farmAreaPerPersonM2,
  foodShedSpacingM, needFillS, resolveWorldScale, serviceRadiusM, tierExtentM, townExtentM,
  townSpacingM, yieldPerM2Daily,
} from "@shared/world-engine/scale.js";

/** The one shipped world this round re-dialled (games/world-lab/src/worlds.ts
 *  "Earthlike System"): a 1/10 village lattice and the food requirement lowered
 *  where it belongs. */
const SHIPPED = resolveWorldScale({ gap_compression: 10, resource_compression: 20 });
/** The dials `earthlike-city-regression.md` diagnosed — kept as a REGRESSION
 *  FIXTURE (no shipped world declares it any more): a 71 m extent, under the
 *  street tree's geometric floor, is where all four plan defects surface. */
const CRAMPED = resolveWorldScale({ gap_compression: 88 });

const SEEDS = [11, 101, 4242, 90210] as const;
const CHARTER = { farmland: 420, ore_access: 0 } as const;

/** The measurement `earthlike-city-regression.md` used, verbatim: a visited
 *  city as `games/world-lab/src/city-towns.ts cityTownConfig` hands it over. */
const cityPlan = (seed: number, scale = SHIPPED, extra: Record<string, unknown> = {}) =>
  buildTownPlay({ seed, key: "z", startPop: 200, days: 160, charter: { ...CHARTER }, scale, ...extra }).plan;

const overlaps = (
  a: { dx: number; dy: number; w: number; h: number },
  b: { dx: number; dy: number; w: number; h: number },
) => a.dx < b.dx + b.w && b.dx < a.dx + a.w && a.dy < b.dy + b.h && b.dy < a.dy + a.h;

const clashCount = (rects: ReadonlyArray<{ dx: number; dy: number; w: number; h: number }>) => {
  let n = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i]!, rects[j]!)) n++;
  }
  return n;
};

describe("tier anchors — a hamlet is not a market town", () => {
  it("carries the user's 100-300 m village band, and the town row IS the old anchor", () => {
    expect(REAL_TIER_EXTENT_M).toEqual({ hamlet: 60, village: 120, town: 450, city: 1500 });
    // The village reads as a 240 m adventure-game village, dead centre of the band.
    expect(REAL_TIER_EXTENT_M.village * 2).toBe(240);
    // ONE definition of "how big is a town": the tier table reads the anchor.
    expect(REAL_TIER_EXTENT_M.town).toBe(REAL_TOWN_EXTENT_M);
  });

  it("tierExtentM applies the SAME clip law, and townExtentM IS its town row", () => {
    for (const tier of ["hamlet", "village", "town", "city"] as const) {
      // REAL's 25 km spacing puts the clip ceiling at 6 250 m, so every tier's
      // declared body binds.
      expect(tierExtentM(tier, REAL_SCALE)).toBe(REAL_TIER_EXTENT_M[tier]);
    }
    expect(townExtentM(REAL_SCALE)).toBe(tierExtentM("town", REAL_SCALE));
    // …and the clip still bites when the world is the smaller truth: at the
    // shipped 2 500 m lattice the ceiling is 625 m, so `city` is clipped and
    // the three smaller tiers are not.
    expect(tierExtentM("city", SHIPPED)).toBeCloseTo(625, 6);
    expect(tierExtentM("town", SHIPPED)).toBe(450);
    expect(tierExtentM("village", SHIPPED)).toBe(120);
  });

  it("states the geometric floor a tier may not be declared under by accident", () => {
    // gate = extentM − BUILT_MARGIN 46 must clear PLAZA_R 30 plus two lot
    // pitches, i.e. ~106 m. MEASURED (step 0, 4 seeds): extent 60 ⇒ 1-4 slots,
    // extent 106 ⇒ 9-12, extent 120 ⇒ 12-34.
    expect(STREET_TREE_MIN_EXTENT_M).toBe(106);
    // The hamlet is DELIBERATELY below it — a cluster of lots, not a town.
    expect(REAL_TIER_EXTENT_M.hamlet).toBeLessThan(STREET_TREE_MIN_EXTENT_M);
    expect(REAL_TIER_EXTENT_M.village).toBeGreaterThan(STREET_TREE_MIN_EXTENT_M);
  });
});

describe("REAL byte-identity — the round may not move the anchor world", () => {
  it("keeps townSpacingM(REAL) === 25 000 and townExtentM(REAL) === 450", () => {
    expect(townSpacingM(REAL_SCALE)).toBe(REAL_TOWN_SPACING_M);
    expect(townExtentM(REAL_SCALE)).toBe(REAL_TOWN_EXTENT_M);
  });

  it("keeps them EVEN WITH a popCap — at REAL the day's walk beats the shed", () => {
    // A 1 065-soul market town's shed is 18 830 m; the day's walk is 25 000.
    expect(foodShedSpacingM(1065, REAL_SCALE)).toBeCloseTo(18_832, 0);
    expect(townSpacingM(REAL_SCALE, 1065)).toBe(REAL_TOWN_SPACING_M);
    expect(townExtentM(REAL_SCALE, townSpacingM(REAL_SCALE, 1065))).toBe(REAL_TOWN_EXTENT_M);
  });

  it("keeps the farm anchors, and the dial arithmetic the round solved for", () => {
    expect(farmAcresPerPerson("ancient")).toBe(12);
    expect(farmAreaPerPersonM2("ancient")).toBeCloseTo(12 * M2_PER_ACRE, 6);
    // resource_compression 20: 0.6 acres = 2 428 m² per person.
    expect(farmAcresPerPerson("ancient", 20)).toBeCloseTo(0.6, 6);
    expect(farmAreaPerPersonM2("ancient", 20)).toBeCloseTo(2_428.1, 1);
  });

  it("leaves the district sizer alone — one hunger cycle is still one game-day", () => {
    // ⚖️ The ration split (satiationDays) must NEVER shorten the eating PERIOD:
    // serviceRadiusM is derived from it, and a fifth of the period is a fifth
    // of the reach (96 m → 19 m, and no body could leave its own street).
    expect(needFillS(DOLLHOUSE_SCALE, "hunger")).toBe(240);
    expect(serviceRadiusM(DOLLHOUSE_SCALE, "hunger")).toBeCloseTo(96, 6);
    expect(serviceRadiusM(REAL_SCALE, "hunger")).toBeCloseTo(
      (ERRAND_WALK_MPS * 86_400 * ERRAND_SHARE) / 2, 6,
    );
  });
});

describe("the food shed — the clock enters spacing through LAND, never through the day", () => {
  it("is the area solve, stated once", () => {
    const pop = 1000;
    const need = pop * farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression)
      * (1 + REAL_SURPLUS_FRAC.staple);
    const usableFrac = REAL_ARABLE_FRACTION * (1 - REAL_FOOD_HEADROOM);
    expect(REAL_ARABLE_FRACTION).toBe(0.25);
    expect(REAL_FOOD_HEADROOM).toBe(0.3);
    expect(foodShedSpacingM(pop, SHIPPED)).toBeCloseTo(Math.sqrt(need / usableFrac), 6);
    // No population, no shed — and never a negative or NaN spacing.
    expect(foodShedSpacingM(0, SHIPPED)).toBe(0);
    expect(foodShedSpacingM(-5, SHIPPED)).toBe(0);
  });

  it("BINDS above the declared lattice once a settlement is big enough to eat it", () => {
    const declared = townSpacingM(SHIPPED);
    expect(declared).toBe(2_500);
    // A hamlet and a village fit inside the declared 2 500 m lattice…
    expect(townSpacingM(SHIPPED, 14)).toBe(declared);
    expect(townSpacingM(SHIPPED, 140)).toBe(declared);
    expect(foodShedSpacingM(140, SHIPPED)).toBeLessThan(declared);
    // …a market town and a city do NOT: the food term pushes them apart.
    expect(foodShedSpacingM(1104, SHIPPED)).toBeGreaterThan(declared);
    expect(townSpacingM(SHIPPED, 1104)).toBeCloseTo(foodShedSpacingM(1104, SHIPPED), 6);
    expect(townSpacingM(SHIPPED, 5000)).toBeCloseTo(foodShedSpacingM(5000, SHIPPED), 6);
    // ⚖️ THE FAMINE TRAP IS UNREPRESENTABLE: a stingy dial pushes harder, it
    // never starves. (dial 1 = real acreage ⇒ a far wider shed.)
    const stingy = resolveWorldScale({ gap_compression: 10 });
    expect(foodShedSpacingM(140, stingy)).toBeGreaterThan(foodShedSpacingM(140, SHIPPED));
  });
});

describe("famine cross-check at the shipped dials", () => {
  // The village tier as MEASURED (step 0, 4 seeds at extent 120): 12-34 lots,
  // mean 28 ⇒ popCap 140. (The design document's interpolated `lots(120) ≈ 75`
  // is superseded by this measurement — see the round's landing note.)
  const VILLAGE_POP_CAP = 140;
  const townR = REAL_TIER_EXTENT_M.village;
  const spacing = townSpacingM(SHIPPED, VILLAGE_POP_CAP);
  const fieldAreaM2 = VILLAGE_POP_CAP
    * farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression)
    * (1 + REAL_SURPLUS_FRAC.staple);
  const fieldDiscR = Math.sqrt(fieldAreaM2 / Math.PI);

  it("LAND: the village's fields fit inside its arable territory, with slack", () => {
    const arable = spacing * spacing * REAL_ARABLE_FRACTION;
    expect(fieldAreaM2).toBeLessThanOrEqual(arable * (1 - REAL_FOOD_HEADROOM));
  });

  it("FARMS DWARF THE VILLAGE, and two sheds never touch", () => {
    expect(fieldDiscR).toBeGreaterThanOrEqual(3 * townR);
    expect(2 * fieldDiscR).toBeLessThan(spacing);
  });

  it("THE FARMER'S WALK fits inside one hunger cycle (the field slabs do not)", () => {
    // A farmer walks to the farm BUILDING, clamped inside the town's extent —
    // never to a field slab, which is a RENDERER of a resource source.
    const roundTripS = (2 * townR) / ERRAND_WALK_MPS;
    expect(roundTripS).toBeLessThan(needFillS(DOLLHOUSE_SCALE, "hunger"));
    // …and the far edge of the shed is far past ANY errand budget one-way
    // (`ERRAND_SHARE` of a hunger cycle is what a body may spend walking),
    // which is exactly why no body may ever be routed to a field slab.
    const errandBudgetS = needFillS(DOLLHOUSE_SCALE, "hunger") * ERRAND_SHARE;
    expect(fieldDiscR / ERRAND_WALK_MPS).toBeGreaterThan(errandBudgetS);
    // (The farm commute is 150 s — over `ERRAND_SHARE` at the worst case, and
    // knowingly so: a SHIFT is not a grocery run. It is still a third of the
    // walk to the far field.)
    expect(roundTripS).toBeLessThan(fieldDiscR / ERRAND_WALK_MPS);
  });
});

describe("Stage α — population follows capacity", () => {
  it("publishes popCap/popSpill, and they agree with `built`", () => {
    for (const seed of SEEDS) {
      const p = cityPlan(seed);
      expect(p.popCap).toBe(p.built * HOUSEHOLD);
      expect(p.popSpill).toBeGreaterThanOrEqual(0);
    }
  });

  it("seats everybody at the shipped dials — 195 houses, ZERO spill", () => {
    for (const seed of SEEDS) {
      const p = cityPlan(seed);
      expect(p.streets.slots.length).toBeGreaterThan(200);
      expect(p.houses.length).toBe(195);
      expect(p.want).toBe(195);
      expect(p.popCap).toBe(975);
      expect(p.popSpill).toBe(0);
    }
  });

  it("tells the truth on a site too small for its population", () => {
    // The regression fixture: a 71 m town cannot seat 973 souls, and now says so
    // instead of carrying a want of 195 against 1 placed house in silence.
    for (const seed of SEEDS) {
      const p = cityPlan(seed, CRAMPED);
      expect(p.want).toBe(195);
      expect(p.houses.length).toBeLessThan(10);
      expect(p.popCap).toBe(p.built * HOUSEHOLD);
      expect(p.popSpill).toBeGreaterThan(900);
    }
  });
});

describe("the four plan defects earthlike-city-regression.md measured", () => {
  it("WORKS ARE GATED: no workplaces stand around a town with no houses", () => {
    // A founding-age town lays no base houses (every building it will ever have
    // goes up through founded deltas). The production-works loop was the ONE
    // list with no `count > 0` guard — the civic list and the field block both
    // had it — so the plan raised workplaces onto empty ground.
    //
    // 🔎 HONEST NOTE (mutation-verified): this is a REGRESSION GUARD, not a
    // discriminating pin. Turning the `count > 0` guard off leaves it green,
    // because the capacity scaling below zeroes every count at `count === 0`
    // anyway and the civic-slot release makes a zero-house town unreachable in
    // the first place. No input distinguishes the three; the guard is kept as
    // belt-and-braces mirroring the two lists that always had it.
    for (const seed of [11, 4242]) {
      const p = cityPlan(seed, SHIPPED, { days: 1 });
      expect(p.houses.length).toBe(0);
      expect(p.works).toHaveLength(0);
    }
  });

  it("WORKS ARE SCALED: a site seating a fifth of its people employs a fifth of its economy", () => {
    // MEASURED across the extent ladder: works climb 0 → 2 → 3 → 6 → 9 → 13
    // with the capacity that actually stood, instead of standing at 11-13 for
    // every town however empty.
    const full = cityPlan(11);
    expect(full.works.length).toBe(13);
    const cramped = cityPlan(11, CRAMPED);
    expect(cramped.popCap).toBeLessThan(full.popCap / 10);
    expect(cramped.works.length).toBeLessThan(full.works.length);
    // Nothing that is not the civic core stands in a town of five souls.
    for (const w of cramped.works) expect(["hall", "market"]).toContain(w.type);
  });

  it("THE RING DOES NOT ALIAS: no two work footprints overlap", () => {
    // The fallback arm advanced by exactly 2π/6 and clamped `out` to the same
    // value for every placement, so work N landed ON work N+6 to the metre —
    // and it performed no collision test at all. This fixture drives the arm:
    // build-up raises the seated capacity toward the full 975 while a ~150 m
    // extent leaves fewer street tips than there are production works, so the
    // ring places the remainder. These five (scale, seed) pairs are MEASURED to
    // put an overlapping pair on the ring under the old generator — a general
    // "nothing overlaps" sweep does NOT reach the defect, because the works
    // loop's capacity scaling (above) removed the 11-works-in-a-71 m-town
    // overload that used to make it fire seven times over.
    const RING_CASES: ReadonlyArray<readonly [number, number]> = [
      [38, 101], [38, 909], [41.67, 1234], [45, 7], [45, 90210],
    ];
    for (const [gap, seed] of RING_CASES) {
      const p = cityPlan(seed, resolveWorldScale({ gap_compression: gap }), { buildUp: 8 });
      const tips = p.streets.streets.filter(s => !s.baseline && s.pts.length >= 3).length;
      expect(tips).toBeLessThan(p.works.length); // the fallback arm really fires
      expect(clashCount(p.works)).toBe(0);
    }
  });

  it("THE CIVIC CORE RELEASES THE LAST LOT rather than eating it", () => {
    // A 60 m extent yields 1-4 frontage slots; `placeCivic` claimed every one
    // of them, the works list then DROPPED the civic rows for want of a house,
    // and the claims were never released — a town of nothing. Now the
    // households get the frontage and the hall is the thing that isn't there.
    const tiny = resolveWorldScale({ gap_compression: 104.17 });
    for (const seed of [101, 90210]) {
      const p = cityPlan(seed, tiny);
      expect(p.streets.slots.length).toBe(3);
      expect(p.houses.length).toBe(3); // every slot became a house
      expect(p.works).toHaveLength(0); // …and the civic core stood down
      expect(p.civicSlots ?? []).toHaveLength(0);
    }
  });

  it("FIELDS ARE THE HINTERLAND: land is farmed because people eat, not because lots were found", () => {
    // Gated on `count > 0` — the PLACED houses — whether a town had any
    // countryside at all was a coin flip on lot luck: 3 of 6 measured seeds
    // grew a full economy with ZERO fields. Now the gate is the WANT, so a
    // 60 m town has its hinterland however few lots its street tree found.
    const tiny = resolveWorldScale({ gap_compression: 104.17 });
    for (const seed of SEEDS) {
      const p = cityPlan(seed, tiny);
      expect(p.want).toBeGreaterThan(0);
      expect(p.fields.length).toBeGreaterThan(0);
    }
    // …but NOT the founding-age town: it wants no houses yet, and a wagon that
    // arrived yesterday has no cultivated hinterland. (Gating on `pop` — the
    // design document's letter — would have handed it one; the founding law
    // wins, and the S1 coin flip is closed by the WANT either way.)
    const founding = cityPlan(11, SHIPPED, { days: 1 });
    expect(founding.houses.length).toBe(0);
    expect(founding.want).toBe(0);
    expect(founding.fields).toHaveLength(0);
  });

  it("shrinks the drawn fields by the dial, not by the gate", () => {
    // gap 88 drew 2 404 × 1 755 m slabs (areaScale ≈ 25) around a 71 m town on
    // a 2 km planet — one town's fields covered a sixth of the world. The dial
    // is what fixes that, and it belongs on the FIELD YIELD.
    const shipped = cityPlan(11);
    const cramped = cityPlan(11, CRAMPED);
    const area = (p: { fields: ReadonlyArray<{ w: number; h: number }> }) =>
      p.fields.reduce((s, f) => s + f.w * f.h, 0);
    expect(area(cramped) / area(shipped)).toBeGreaterThan(15);
    for (const f of shipped.fields) {
      expect(Math.max(f.w, f.h)).toBeLessThan(1_000);
    }
  });
});

describe("satiationDays — DATA this round, wiring in Phase B", () => {
  it("carries the content ladder: a cooked meal is five apples, and ten cookies", () => {
    expect(SATIATION_DAYS).toEqual({ treat: 0.1, food: 0.2, bread: 0.5, meal: 1 });
    expect(satiationDaysOf("apple")).toBe(0.2);
    expect(satiationDaysOf("cookie")).toBe(0.1);
    // COOKED FIRST — a `.hot` variant is a meal whatever it was raw, which is
    // what makes the cook's transform worth the walk.
    expect(satiationDaysOf("apple.hot")).toBe(1);
    expect(satiationDaysOf("cookie.hot")).toBe(1);
  });

  it("defaults to 1, so everything not named is byte-identical to today", () => {
    expect(DEFAULT_SATIATION_DAYS).toBe(1);
    expect(satiationDaysOf("wood")).toBe(1);
    expect(satiationDaysOf("shirt.color_red")).toBe(1);
    expect(satiationDaysOf("water")).toBe(1);
  });
});

describe("E-round — the field gets a crop and a mint rate", () => {
  it("CARROT joins the food vocabulary, LAST (likes hash by index)", () => {
    // USER RULING: *"We don't have a bread industry set up, so it would
    // probably be simpler to start with vegetables."* Before this, `FOOD_KINDS`
    // was three fruits — nothing a field grows.
    expect(FOOD_KINDS).toEqual(["apple", "banana", "grape", "carrot"]);
    // 🚨 APPEND-ONLY: residents' and pets' favourite foods hash by INDEX, so
    // the three shipped fruits must keep 0/1/2 forever.
    expect(FOOD_KINDS.indexOf("carrot")).toBe(FOOD_KINDS.length - 1);
    // …and it needs no `SATIATION_DAYS` row: the FOOD_KINDS fallthrough already
    // routes it to a fifth of a person-day.
    expect(satiationDaysOf("carrot")).toBe(SATIATION_DAYS.food);
    expect(satiationDaysOf("carrot.hot")).toBe(SATIATION_DAYS.meal);
  });

  it("yieldPerM2Daily is the two anchors divided — 1 carrot per 485.6 m² per day", () => {
    const y = yieldPerM2Daily("ancient", SHIPPED, satiationDaysOf("carrot"));
    expect(1 / y).toBeCloseTo(485.6, 1);
    expect(y).toBeCloseTo(
      1 / (farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression) * 0.2), 12,
    );
    // Nothing is minted from a glyph that clears no hunger.
    expect(yieldPerM2Daily("ancient", SHIPPED, 0)).toBe(0);
  });

  it("THE σ IDENTITY: a field sized for pop out-yields its table by exactly 1 + σ", () => {
    // The Q3 village, in the document's own numbers.
    const pop = 375;
    const satiation = 0.2;
    const regionM2 = pop * farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression)
      * (1 + REAL_SURPLUS_FRAC.staple);
    const output = regionM2 * yieldPerM2Daily("ancient", SHIPPED, satiation);
    const demand = pop / satiation;
    expect(regionM2).toBeCloseTo(1_092_651, 0);
    expect(output).toBeCloseTo(2_250, 6);
    expect(demand).toBe(1_875);
    expect(output / demand).toBeCloseTo(1 + REAL_SURPLUS_FRAC.staple, 12);
    // …and it is an IDENTITY, not a coincidence of these numbers: any dial,
    // any crop, any population.
    const other = resolveWorldScale({ resource_compression: 3.5 });
    const p2 = 87;
    const r2 = p2 * farmAreaPerPersonM2("ancient", other.resourceCompression)
      * (1 + REAL_SURPLUS_FRAC.staple);
    expect((r2 * yieldPerM2Daily("ancient", other, 0.5)) / (p2 / 0.5))
      .toBeCloseTo(1 + REAL_SURPLUS_FRAC.staple, 12);
  });
});
