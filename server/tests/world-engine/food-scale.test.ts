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
//   3. `catchmentSpacingM` and the `max(declared, catchment)` spacing.
//   4. Stage α: `popCap` / `popSpill` on the plan, and the works loop scaled
//      by the capacity that actually stood.
//   5. The works loop's missing `count > 0` guard, the fallback ring's period-6
//      angle collision, the civic slot-release defect, and the field block's
//      housing gate.
//   6. The famine cross-check at the shipped dials.
//   7. `satiationDays` as DATA (default 1 ⇒ ingest unchanged; Phase B wires it).
//   8. Stage β2 (plan honesty): field geometry sized from the SEATED
//      population (`min(pop, popCap)`), the STAPLE-ONLY works floor, and the
//      map↔books divergence both open — recorded, never silent.
//   9. Stage β4 (the dial flip): `resource_compression` 20 → 7.5 — the
//      re-solve at the MEASURED village popCap 140 that the Phase A close
//      deferred until population followed capacity (β1-β3) — and the 7.4592
//      crossover cliff the shipped dial sits 0.55% above, pinned by name.
//
// Pure logic + headless `buildTownPlay` (no DOM/GL/DB).

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTownPlay, townPlayEconomy } from "@shared/world-engine/interaction/town/town-play.js";
import { foundingScan } from "@shared/world-engine/kernel/civ/bands.js";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import { HOUSEHOLD } from "@shared/world-engine/kernel/town/goods.js";
import { townPlan } from "@shared/world-engine/kernel/town/plan.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import {
  DEFAULT_SATIATION_DAYS, FOOD_KINDS, SATIATION_DAYS, satiationDaysOf,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import {
  DOLLHOUSE_SCALE, ERRAND_SHARE, ERRAND_WALK_MPS, M2_PER_ACRE, REAL_ARABLE_FRACTION,
  REAL_FARM_ACRES_PER_PERSON, REAL_FOOD_HEADROOM, REAL_SCALE, REAL_SURPLUS_FRAC,
  REAL_TIER_EXTENT_M, REAL_TOWN_EXTENT_M,
  REAL_TOWN_SPACING_M, STREET_TREE_MIN_EXTENT_M, TIER_POP_CAP, farmAcresPerPerson,
  farmAreaPerPersonM2, catchmentSpacingM, needFillS, resolveWorldScale, serviceRadiusM,
  tierExtentM, townExtentM, townSpacingM, yieldPerM2Daily,
} from "@shared/world-engine/scale.js";

/** The shipped dials — declared at FOUR sites in lockstep (games/world-lab/
 *  src/worlds.ts Earthlike System / Home Planet / Nature Hike, plus
 *  games/nature-hike/src/game.spec.json): a 1/10 village lattice, and the
 *  food dial at Stage β4's re-solve — 7.5, derived from the MEASURED village
 *  popCap 140 (A_allowed = 2 500² × 0.25 × 0.70 / (140 × 1.20) = 6 510
 *  m²/person ⇒ dial = 12 × 4 046.8564 / 6 510 = 7.46 → 7.5). Phase A shipped
 *  a conservative 20 while fields were still sized from RAW population;
 *  β1-β3 made population follow capacity, which is what the re-solve waited
 *  for (food-scale-round.md "# STAGE β" › β4). */
const SHIPPED = resolveWorldScale({ gap_compression: 10, resource_compression: 7.5 });
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

/** The same fixture with the town's ASSIGNED population read off the books —
 *  the β2 pins compare the map (plan) against the books (population scalar). */
const cityPlay = (seed: number, scale = SHIPPED) => {
  const play = buildTownPlay({ seed, key: "z", startPop: 200, days: 160, charter: { ...CHARTER }, scale });
  return { plan: play.plan, pop: Math.max(0, play.town.scalar("population")), town: play.town, eco: play.eco };
};

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

  it("keeps them EVEN WITH a popCap — at REAL the day's walk beats the catchment", () => {
    // A 1 065-soul market town's catchment is 18 830 m; the day's walk is 25 000.
    expect(catchmentSpacingM(1065, REAL_SCALE)).toBeCloseTo(18_832, 0);
    expect(townSpacingM(REAL_SCALE, 1065)).toBe(REAL_TOWN_SPACING_M);
    expect(townExtentM(REAL_SCALE, townSpacingM(REAL_SCALE, 1065))).toBe(REAL_TOWN_EXTENT_M);
  });

  it("keeps the farm anchors, and the dial arithmetic — Phase A's and the shipped β4 dial's", () => {
    expect(farmAcresPerPerson("ancient")).toBe(12);
    expect(farmAreaPerPersonM2("ancient")).toBeCloseTo(12 * M2_PER_ACRE, 6);
    // Dial 20 — Phase A's conservative choice, KEPT AS FUNCTION ARITHMETIC
    // (a literal argument, not the shipped dial since β4): 0.6 acres =
    // 2 428 m² per person.
    expect(farmAcresPerPerson("ancient", 20)).toBeCloseTo(0.6, 6);
    expect(farmAreaPerPersonM2("ancient", 20)).toBeCloseTo(2_428.1, 1);
    // Dial 7.5 — the shipped Stage β4 re-solve: 12 / 7.5 = 1.6 acres =
    // 6 474.97 m² per person.
    expect(farmAcresPerPerson("ancient", SHIPPED.resourceCompression)).toBeCloseTo(1.6, 6);
    expect(farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression)).toBeCloseTo(6_474.97, 1);
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

describe("the staple catchment — the clock enters spacing through LAND, never through the day", () => {
  it("is the area solve, stated once", () => {
    const pop = 1000;
    const need = pop * farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression)
      * (1 + REAL_SURPLUS_FRAC.staple);
    const usableFrac = REAL_ARABLE_FRACTION * (1 - REAL_FOOD_HEADROOM);
    expect(REAL_ARABLE_FRACTION).toBe(0.25);
    expect(REAL_FOOD_HEADROOM).toBe(0.3);
    expect(catchmentSpacingM(pop, SHIPPED)).toBeCloseTo(Math.sqrt(need / usableFrac), 6);
    // No population, no catchment — and never a negative or NaN spacing.
    expect(catchmentSpacingM(0, SHIPPED)).toBe(0);
    expect(catchmentSpacingM(-5, SHIPPED)).toBe(0);
  });

  it("BINDS above the declared lattice once a settlement is big enough to eat it", () => {
    const declared = townSpacingM(SHIPPED);
    expect(declared).toBe(2_500);
    // A hamlet and a village fit inside the declared 2 500 m lattice — the
    // village only just (catchment 2 493.19 m; the cliff pin below names the gap)…
    expect(townSpacingM(SHIPPED, 14)).toBe(declared);
    expect(townSpacingM(SHIPPED, 140)).toBe(declared);
    expect(catchmentSpacingM(140, SHIPPED)).toBeLessThan(declared);
    // …a market town and a city do NOT: the food term pushes them apart.
    expect(catchmentSpacingM(1104, SHIPPED)).toBeGreaterThan(declared);
    expect(townSpacingM(SHIPPED, 1104)).toBeCloseTo(catchmentSpacingM(1104, SHIPPED), 6);
    expect(townSpacingM(SHIPPED, 5000)).toBeCloseTo(catchmentSpacingM(5000, SHIPPED), 6);
    // ⚖️ THE FAMINE TRAP IS UNREPRESENTABLE: a stingy dial pushes harder, it
    // never starves. (dial 1 = real acreage ⇒ a far wider catchment.)
    const stingy = resolveWorldScale({ gap_compression: 10 });
    expect(catchmentSpacingM(140, stingy)).toBeGreaterThan(catchmentSpacingM(140, SHIPPED));
  });

  it("THE DIAL SITS ABOVE A NAMED CLIFF — 7.5 clears the 7.4592 village-catchment crossover", () => {
    // Below the crossover the VILLAGE catchment out-grows the declared 2 500 m
    // lattice and the entire planet lattice re-founds (every founding scan,
    // every planet cache). Solve catchment(villageCap) = declared for the dial:
    //   catchment² = cap × (acres/dial) × M2_PER_ACRE × (1+σ) / (arable × (1−headroom))
    //   ⇒ crossover = cap × acres × M2_PER_ACRE × (1+σ)
    //                 / (arable × (1−headroom)) / declared²
    //               = 140 × 12 × 4 046.8564 × 1.2 / 0.175 / 2 500²
    //               = 7.459166 — computed from the REAL constants, so this
    // pin reds if anyone lowers the dial, raises the village popCap, or moves
    // the surplus/arable/headroom anchors without re-solving.
    const declared = townSpacingM(SHIPPED);
    expect(declared).toBe(2_500);
    const crossover = (TIER_POP_CAP.village * REAL_FARM_ACRES_PER_PERSON.ancient * M2_PER_ACRE
      * (1 + REAL_SURPLUS_FRAC.staple))
      / (REAL_ARABLE_FRACTION * (1 - REAL_FOOD_HEADROOM))
      / (declared * declared);
    expect(crossover).toBeCloseTo(7.459166, 5);
    // The headroom, pinned: the shipped 7.5 is 0.55% ABOVE the cliff…
    expect(SHIPPED.resourceCompression).toBeGreaterThan(crossover);
    // …and the consequence stated directly: the village catchment provably does
    // not re-found the lattice (2 493.19 m < 2 500 m), which is what keeps
    // every planet cache and founding pin unmoved by the β4 flip.
    expect(catchmentSpacingM(TIER_POP_CAP.village, SHIPPED)).toBeLessThan(declared);
  });
});

describe("Stage β4 — the dial's FOUR declaration sites move in lockstep", () => {
  // The shipped dial is declared across two files: the games/world-lab/src/
  // worlds.ts presets (Earthlike System, Home Planet, Nature Hike, Frontier
  // Planet) and the Nature Hike game's OWN spec, games/nature-hike/src/
  // game.spec.json — a file no test imported until β4, which is exactly how it
  // could fork from the lab preset silently (mutation M3: JSON left at 20,
  // worlds.ts flipped, the whole suite stayed green). Read both and compare, so
  // they can never fork again without a red.
  //
  // The site COUNT is a floor, not an equality: the law is that every site
  // carries the same dial, and a new compliant preset must not red this. The
  // floor is still needed, though — if the field were renamed the regex would
  // match nothing and the per-value loop would pass over an empty array.
  it("worlds.ts declares SHIPPED's dial at every preset site, and the hike spec matches", () => {
    const worldsSrc = readFileSync(
      join(process.cwd(), "games", "world-lab", "src", "worlds.ts"), "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments out…
      .replace(/\/\/.*$/gm, "");        // …and line comments (they discuss dials)
    const declared = [...worldsSrc.matchAll(/resource_compression:\s*([0-9.]+)/g)]
      .map(m => Number(m[1]));
    expect(declared.length).toBeGreaterThanOrEqual(3);
    for (const dial of declared) expect(dial).toBe(SHIPPED.resourceCompression);
    const hikeSpec = JSON.parse(readFileSync(
      join(process.cwd(), "games", "nature-hike", "src", "game.spec.json"), "utf8",
    )) as { game: { scale: { resource_compression: number } } };
    expect(hikeSpec.game.scale.resource_compression).toBe(SHIPPED.resourceCompression);
  });
});

describe("famine cross-check at the shipped dials", () => {
  // The village tier as MEASURED (step 0, 4 seeds at extent 120): 12-34 lots,
  // mean 28 ⇒ popCap 140. (The design document's interpolated `lots(120) ≈ 75`
  // is superseded by this measurement — see the round's landing note.) Read
  // off the ⑩ table so the two numbers can never fork.
  const VILLAGE_POP_CAP = TIER_POP_CAP.village;
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

  it("FARMS DWARF THE VILLAGE, and two catchments never touch", () => {
    expect(fieldDiscR).toBeGreaterThanOrEqual(3 * townR);
    expect(2 * fieldDiscR).toBeLessThan(spacing);
  });

  it("THE FARMER'S WALK fits inside one hunger cycle (the field slabs do not)", () => {
    // A farmer walks to the farm BUILDING, clamped inside the town's extent —
    // never to a field slab, which is a RENDERER of a resource source.
    const roundTripS = (2 * townR) / ERRAND_WALK_MPS;
    expect(roundTripS).toBeLessThan(needFillS(DOLLHOUSE_SCALE, "hunger"));
    // …and the far edge of the catchment is far past ANY errand budget one-way
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
    //
    // ⚠️ β2: it cannot see the STAPLE FLOOR's gates either — at count 0 the
    // whole works list short-circuits before any floor runs. The pin that
    // discriminates an un-gated floor is "NO PHANTOM FARM" in the Stage β2
    // block below (a seated town whose books never built a farm).
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
    // ⚖️ β2 MOVED PIN, WITH WHY (staple-only floor, survey correction 7).
    // Was: nothing beyond the civic core stands in a town of five souls. Now
    // the STAPLE joins it — exactly one farm, the one building whose absence
    // contradicts the town's own food books (its seated households eat every
    // day and their grain comes off fields drawn right outside) — and the
    // crafts still scale to zero: five souls are not an industrial base.
    for (const w of cramped.works) expect(["hall", "market", "farm"]).toContain(w.type);
    expect(cramped.works.filter(w => w.type === "farm")).toHaveLength(1);
    expect(cramped.works.filter(w => w.type === "weaver" || w.type === "tailor")).toHaveLength(0);
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
      // ⚖️ β2 MOVED PIN, WITH WHY (staple-only floor). Was: works empty — the
      // civic core stood down and nothing else survived the seated scaling.
      // The civic core STILL stands down (no frontage claimed), but the three
      // seated households eat, so the one building the floor guarantees now
      // stands: the farm, and only the farm.
      expect(p.works).toHaveLength(1);
      expect(p.works[0]!.type).toBe("farm");
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
    //
    // ⚖️ β2 MOVED PIN, WITH WHY (fields from the seated). The raw-area ratio
    // no longer isolates the dial: cramped now seats 5 souls against
    // shipped's 973, so its honest fields shrank ~200× on the head count
    // alone. Per SEATED PERSON the dial is still the whole story — cramped is
    // undialed (12 acres each), shipped is dialed 7.5× down — so the
    // ratio-is-the-dial pin is restated per seated soul. β4 RE-PIN: the ratio
    // IS the dial to fp precision (MEASURED 7.499999999999996; at the old
    // dial it read 20 the same way), pinned as the LITERAL so a silent
    // re-dial of SHIPPED reds here rather than following the mutation.
    const shipped = cityPlay(11);
    const cramped = cityPlay(11, CRAMPED);
    const area = (p: { fields: ReadonlyArray<{ w: number; h: number }> }) =>
      p.fields.reduce((s, f) => s + f.w * f.h, 0);
    const perSeated = (x: { plan: { fields: ReadonlyArray<{ w: number; h: number }>; popCap: number }; pop: number }) =>
      area(x.plan) / Math.min(x.pop, x.plan.popCap);
    expect(perSeated(cramped) / perSeated(shipped)).toBeCloseTo(7.5, 6);
    expect(SHIPPED.resourceCompression).toBe(7.5);
    // …and the sixth-of-the-world lie is dead twice over: the cramped town's
    // whole hinterland is now under a square kilometre.
    expect(area(cramped.plan)).toBeLessThan(1_000_000);
    // ⚖️ β4 RE-PIN, WITH WHY (was `< 1_000`). At dial 7.5 the visited capital
    // (seated 973) draws areaScale ≈ 9.43; the ≤14-patch cap saturates and
    // the max patch dimension reaches ~1 022-1 037 m across the 4 seeds. A
    // ~1 km open-field strip feeding a ~1 000-soul town is the historically
    // honest shape (open-field furlongs), not a rendering bug — the bound
    // moves to 1 100 and stays a bound, not a target.
    for (const f of shipped.plan.fields) {
      expect(Math.max(f.w, f.h)).toBeLessThan(1_100);
    }
  });
});

describe("Stage β2 — plan honesty: the map draws the SEATED, the books feed the assigned", () => {
  const area = (p: { fields: ReadonlyArray<{ w: number; h: number }> }) =>
    p.fields.reduce((s, f) => s + f.w * f.h, 0);

  it("FIELDS-FROM-SEATED: an over-subscribed site draws the seated souls' fields, not the scalar's", () => {
    // The regression fixture over-subscribes ~65-195×: the books assign 973
    // souls, the 71 m ground seats 5-15 (1-3 lots × HOUSEHOLD). MEASURED
    // (probe, 4 seeds): field area lands at 0.90-1.00× the seated target and
    // 0.005-0.015× the raw-pop one — before this clamp it was 0.90-1.00× of
    // RAW (a 56.7M m² hinterland around one house, a sixth of a 2 km world).
    //
    // ⚖️ THE DIVERGENCE THIS OPENS IS THE PIN, NOT A LEAK: `plan.fields` has
    // no economic reader, and books supply and need both derive from the same
    // `population` scalar — the clamp starves nothing. The map draws the
    // seated, the books feed the assigned, `popSpill` is the published
    // reconciliation, and Stage β3's spill-founding is what converges the two
    // (food-scale-round.md "# STAGE β" › "The β stages"). Map ≡ books AT
    // SEATED POP — the identity's other half lives in town-farm-area.test.ts.
    for (const seed of SEEDS) {
      const { plan: p, pop } = cityPlay(seed, CRAMPED);
      expect(pop).toBeGreaterThan(900);
      expect(p.popCap).toBeLessThanOrEqual(15);
      expect(p.popSpill).toBeGreaterThan(900);
      const seated = Math.min(pop, p.popCap);
      const perPerson = farmAreaPerPersonM2("ancient", CRAMPED.resourceCompression)
        * (1 + REAL_SURPLUS_FRAC.staple);
      // The suite's standard ±40% patch-jitter band around the SEATED target…
      expect(area(p)).toBeGreaterThan(seated * perPerson * 0.6);
      expect(area(p)).toBeLessThan(seated * perPerson * 1.4);
      // …which is ~seated/pop (0.5-1.5%) of the raw-pop area — nowhere near it.
      expect(area(p)).toBeLessThan(pop * perPerson * 0.1);
    }
  });

  it("THE FLOOR IS STAPLE-ONLY: the seated village raises its farm, the crafts still scale to zero", () => {
    // Survey correction 7: a 3-lot hamlet with farm+weaver+tailor is a worse
    // lie than none — the farm is the ONE building whose absence contradicts
    // the town's own food books. The books here really carry a craft economy
    // (weavers/tailors > 0 on the scalars), so a blanket floor WOULD raise
    // them; only the staple stands.
    for (const seed of SEEDS) {
      const { plan: p, town } = cityPlay(seed, CRAMPED);
      expect(town.scalar("weavers")).toBeGreaterThan(0);
      expect(town.scalar("tailors")).toBeGreaterThan(0);
      expect(p.works.filter(w => w.type === "farm")).toHaveLength(1);
      expect(p.works.filter(w => w.type === "weaver" || w.type === "tailor")).toHaveLength(0);
    }
  });

  it("NO PHANTOM FARM: a seated town whose books never built a farm gets no floor", () => {
    // The floor's gates, discriminated (the count-0 pin above cannot see them:
    // its whole works list short-circuits). Here 40 houses stand and
    // seatedFrac === 1, but `farms` is 0 — food must be built, not assumed
    // (the founding law's own words), so the floor stays down. A bare
    // `max(1, …)` floor would stand a farm the economy never funded.
    const eco = compileEconomy([townPlayEconomy()], { construction: true });
    const town = createTownWorld({
      economy: eco, charter: { ...CHARTER },
      startPop: 200, seedScalars: { farms: 0 }, key: "nofarm",
    });
    const p = townPlan(town, eco, "nofarm", 11);
    expect(p.houses.length).toBeGreaterThan(0);
    expect(p.popCap).toBeGreaterThanOrEqual(200); // fully seated — the gate at work is scalar, not seating
    expect(town.scalar("farms")).toBe(0);
    expect(p.works.filter(w => w.type === "farm")).toHaveLength(0);
  });
});

describe("⑩ the tier, threaded — the catchment prices what the site BECOMES", () => {
  it("TIER_POP_CAP carries the MEASURED street-tree capacities", () => {
    expect(TIER_POP_CAP).toEqual({ hamlet: 14, village: 140, town: 1_104, city: 5_000 });
    // village = the measured mean 28 slots at extent 120 × HOUSEHOLD.
    expect(TIER_POP_CAP.village).toBe(28 * HOUSEHOLD);
    // town = the MEASURED 1 104; Q3's analytic 1 065 (213 lots × 5) survives
    // only as a lower bound (the ladder is ask-bound above E ~ 300).
    expect(TIER_POP_CAP.town).toBeGreaterThan(1_065);
  });

  it("foundingScan + village popCap is INERT at the shipped dials — the landing table's own row", () => {
    // village catchment 2 493.19 m < the declared 2 500 m lattice ⇒ byte-identical
    // — by 6.8 m since β4 (the pinned cliff): 140 × (12/7.5 × 4 046.8564) ×
    // 1.2 / 0.175 = 6 215 971 m² ⇒ √ = 2 493.185.
    expect(catchmentSpacingM(TIER_POP_CAP.village, SHIPPED)).toBeCloseTo(2_493.185, 2);
    expect(townSpacingM(SHIPPED, TIER_POP_CAP.village)).toBe(2_500);
    const base = { scale: SHIPPED, foundPop: 25, cellSizeM: 100, minSpacingFloorCells: 4 };
    const bare = foundingScan(base);
    const village = foundingScan({ ...base, popCap: TIER_POP_CAP.village });
    expect(bare.minSpacing).toBe(25); // round(2 500 / 100)
    expect(village.minSpacing).toBe(bare.minSpacing);
  });

  it("…and WIDENS once the tier out-eats its lattice (the town catchment binds)", () => {
    // 1 104 × (12/7.5 × 4 046.8564) × 1.2 / 0.175 = 49 017 374 m² ⇒ √ = 7 001.24.
    expect(catchmentSpacingM(TIER_POP_CAP.town, SHIPPED)).toBeCloseTo(7_001.24, 1);
    const base = { scale: SHIPPED, foundPop: 25, cellSizeM: 100, minSpacingFloorCells: 4 };
    const town = foundingScan({ ...base, popCap: TIER_POP_CAP.town });
    expect(town.minSpacing).toBe(
      Math.round(townSpacingM(SHIPPED, TIER_POP_CAP.town) / 100), // 70
    );
    expect(town.minSpacing).toBeGreaterThan(foundingScan(base).minSpacing);
  });

  it("…and the CHART CAP clips the catchment — the honest small-planet collapse, as intended", () => {
    // A chart 30 cells wide cannot express a 70-cell gap: capped, the tier
    // says "at most one settlement fits here" instead of keying a grid past
    // its own stride (border.ts's measured throw).
    const clipped = foundingScan({
      scale: SHIPPED, foundPop: 25, cellSizeM: 100,
      minSpacingFloorCells: 4, minSpacingCapCells: 30, popCap: TIER_POP_CAP.town,
    });
    expect(clipped.minSpacing).toBe(30);
  });

  it("tierExtentM('village') is the 120 m body wherever the gap clears 480 m", () => {
    expect(tierExtentM("village", SHIPPED, 2_500)).toBe(120);
    expect(tierExtentM("village", SHIPPED)).toBe(120); // default spacing IS the shipped lattice
    // The cross point: the clip term is spacing/4, so 480 m is where the cap
    // starts binding — and there is NO floor under the clip below it.
    expect(tierExtentM("village", SHIPPED, 480)).toBe(120);
    expect(tierExtentM("village", SHIPPED, 479)).toBeLessThan(120);
  });

  it("THE TIER REACHES PLAY: tier 'village' lays the 120 m body; absent = 'town' at the PLAN layer", () => {
    // ⚖️ β1 MOVED PIN, WITH WHY (sibling stage — the capacity seat). This used
    // to compare `buildTownPlay({ tier: "town" })` byte-identical to tierless,
    // which held while `tier` only reached the PLAN. β1 (town-play.ts) now
    // wires an explicit tier into the SIM too — `vitals.capacity =
    // TIER_POP_CAP[tier]`, the births-taper — so a declared tier grows a
    // capacity-tapered trajectory ON PURPOSE and play-level byte-identity
    // with tierless no longer holds (that seat's own pins live in
    // town-capacity.test.ts). The law THIS pin keeps is plan.ts's: townPlan's
    // absent tier IS "town" — the same plan to the byte on the same world.
    const play = cityPlay(11);
    const town = play.plan;
    const planDefault = townPlan(
      play.town, play.eco, "z", 11, 0, undefined, [], undefined, undefined, SHIPPED, [], [], undefined,
    );
    const planTown = townPlan(
      play.town, play.eco, "z", 11, 0, undefined, [], undefined, undefined, SHIPPED, [], [], "town",
    );
    expect(JSON.stringify(planTown)).toBe(JSON.stringify(planDefault));
    // The village body: the plan's built radius fits the 120 m extent and
    // the settlement is genuinely the smaller one, in ground and in souls.
    const village = cityPlan(11, SHIPPED, { tier: "village" });
    expect(village.radius).toBeLessThanOrEqual(120);
    expect(village.radius).toBeLessThan(town.radius);
    expect(village.houses.length).toBeGreaterThan(0);
    expect(village.houses.length).toBeLessThan(town.houses.length);
    expect(village.popCap).toBeLessThan(town.popCap);
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
    // 🌿 …and the WILD LARDER appended after it (2026-09-04): berry, nut and
    // onion, the three forage plants a settler eats off the land.
    expect(FOOD_KINDS).toEqual([
      "apple", "banana", "grape", "carrot", "berry", "nut", "onion",
    ]);
    // 🚨 APPEND-ONLY: residents' and pets' favourite foods hash by INDEX, so
    // the three shipped fruits must keep 0/1/2 forever — and the carrot 3,
    // which is what "appended, never inserted" has meant since.
    expect(FOOD_KINDS.slice(0, 4)).toEqual(["apple", "banana", "grape", "carrot"]);
    // …and it needs no `SATIATION_DAYS` row: the FOOD_KINDS fallthrough already
    // routes it to a fifth of a person-day.
    expect(satiationDaysOf("carrot")).toBe(SATIATION_DAYS.food);
    expect(satiationDaysOf("carrot.hot")).toBe(SATIATION_DAYS.meal);
  });

  it("yieldPerM2Daily is the two anchors divided — 1 carrot per 1 294.99 m² per day", () => {
    // 6 474.97 m²/person (dial 7.5) × 0.2 satiation = 1 294.994 m² per carrot.
    const y = yieldPerM2Daily("ancient", SHIPPED, satiationDaysOf("carrot"));
    expect(1 / y).toBeCloseTo(1_294.99, 1);
    expect(y).toBeCloseTo(
      1 / (farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression) * 0.2), 12,
    );
    // Nothing is minted from a glyph that clears no hunger.
    expect(yieldPerM2Daily("ancient", SHIPPED, 0)).toBe(0);
  });

  it("THE σ IDENTITY: a field sized for pop out-yields its table by exactly 1 + σ", () => {
    // The Q3 village at the β4 dial: 375 × 6 474.97 × 1.2 = 2 913 736.62 m².
    // (Output 2 250 and demand 1 875 are dial-free — the dial cancels.)
    const pop = 375;
    const satiation = 0.2;
    const regionM2 = pop * farmAreaPerPersonM2("ancient", SHIPPED.resourceCompression)
      * (1 + REAL_SURPLUS_FRAC.staple);
    const output = regionM2 * yieldPerM2Daily("ancient", SHIPPED, satiation);
    const demand = pop / satiation;
    expect(regionM2).toBeCloseTo(2_913_736.62, 1);
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
