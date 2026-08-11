// The space-time-compression coherence diagnostics (planning-docs/games/world-engine/
// space-time-compression.md §7): the dimensionless ratios where scale
// incoherence hides, asserted so they are documentation instead of ambushes.
//
// The LAW under test: realism is the engine default (REAL_SCALE, real-day
// world clock); compression is a per-world DECLARATION (`game.scale`), and
// the shipped street-clock pacing survives exactly as the DOLLHOUSE_SCALE
// profile the town demos declare.
import { describe, expect, it } from "@jest/globals";
import {
  DAY_S,
  DOLLHOUSE_SCALE,
  ERRAND_WALK_MPS,
  NEED_FILL_S,
  REAL_DAY_S,
  REAL_HOUSE_BUILD_DAYS,
  REAL_LAND_FRACTION,
  REAL_PLANET_RADIUS_M,
  REAL_SCALE,
  REAL_SLEEP_FRACTION,
  REAL_TOWN_EXTENT_M,
  REAL_TOWN_SPACING_M,
  REST_DWELL_S,
  townExtentM,
  townSpacingM,
  TIME_COMPRESSION,
  TOWN_SESSION_DAY_S,
  constructionGameDays,
  dailyRangeM,
  gameDaysToCross,
  needFillS,
  needRate,
  parseWorldScaleSpec,
  realDaysPerGameYear,
  resolveWorldScale,
  restDwellS,
  roadMountSpeedMps,
  scaleSpecOf,
  townsOnPlanet,
  // settlement-emergence.md step ① — the independently-moving clocks
  GRANARY_MEALS_MAX,
  GRANARY_MEALS_MIN,
  REAL_GROWTH_FRACTION,
  REAL_LEAN_FRACTION,
  REAL_LIFESPAN_YEARS,
  REAL_YEAR_DAYS,
  SEASONAL_SCALE,
  SESSION_YEAR_MAX_MINUTES,
  SESSION_YEAR_MIN_MINUTES,
  apparentSizeGain,
  apparentStarGain,
  carryDays,
  dayLengthFor,
  dependencyRatio,
  forageRadiusM,
  growthGameDays,
  leanSeasonMeals,
  lifespanGameDays,
  lifespanGameYears,
  mealsPerLifetime,
  mealsPerYear,
  realHoursPerLifespan,
  realMinutesPerYear,
  revolutionForYearDays,
  scaleRatios,
  scaleWarnings,
  walkSpeedMps,
  yearGameDays,
} from "@shared/world-engine/scale.js";
import { FOOD_DAY_SEC, ERRAND_WALK } from "@shared/world-engine/kernel/town/goods.js";
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions.js";
import { HUNGER_RATE } from "@shared/world-engine/kernel/town/activity.js";
import { DEFAULT_TOWN_DAY_LENGTH } from "@shared/world-engine/interaction/behavior/creature-goal-runtime.js";
import { DEFAULT_WORLD_CLOCK_CONFIG } from "@shared/world-engine/world-clock.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";

describe("realism is the engine default", () => {
  it("REAL_SCALE is the real world — every dial at unity", () => {
    expect(REAL_SCALE.dayLengthS).toBe(86_400);
    expect(REAL_SCALE.sleepFraction).toBeCloseTo(1 / 3, 12);
    expect(REAL_SCALE.construction).toBe(1);
    expect(REAL_SCALE.planetCompression).toBe(1);
    expect(REAL_SCALE.rotation).toBe(1);
    expect(REAL_SCALE.revolution).toBe(1);
    expect(REAL_SCALE.metabolism).toBe(1);
    expect(REAL_SCALE.locomotion).toBe(1);
    expect(REAL_SCALE.generation).toBe(1);
  });
  it("real life: a 365-day year, a 70-year life, 18 years of childhood", () => {
    expect(yearGameDays(REAL_SCALE)).toBeCloseTo(365.25, 6);
    expect(lifespanGameYears(REAL_SCALE)).toBe(REAL_LIFESPAN_YEARS);
    expect(growthGameDays(REAL_SCALE) / yearGameDays(REAL_SCALE)).toBeCloseTo(18, 6);
    expect(walkSpeedMps(REAL_SCALE)).toBe(ERRAND_WALK_MPS);
  });
  it("the world-clock default day is a real day", () => {
    expect(DEFAULT_WORLD_CLOCK_CONFIG.dayLength).toBe(REAL_DAY_S);
  });
  it("an empty declaration resolves to realism", () => {
    expect(resolveWorldScale(null)).toEqual(REAL_SCALE);
    expect(resolveWorldScale({})).toEqual(REAL_SCALE);
  });
  it("real pacing: eat daily, sleep 8 hours, a house in half a year", () => {
    expect(needFillS(REAL_SCALE, "hunger")).toBe(86_400);
    expect(restDwellS(REAL_SCALE)).toBeCloseTo(28_800, 6);
    expect(constructionGameDays(1, REAL_SCALE)).toBe(REAL_HOUSE_BUILD_DAYS);
  });
});

describe("the DOLLHOUSE profile reproduces the shipped street-clock numbers", () => {
  it("day, session playback, food day", () => {
    expect(DOLLHOUSE_SCALE.dayLengthS).toBe(240);
    // ...and the day is DERIVED: the planet spins 360× (the multiplier law).
    expect(DOLLHOUSE_SCALE.rotation).toBe(360);
    expect(dayLengthFor(DOLLHOUSE_SCALE.rotation)).toBe(DOLLHOUSE_SCALE.dayLengthS);
    expect(DAY_S).toBe(240);
    expect(FOOD_DAY_SEC).toBe(DAY_S);
    expect(TOWN_SESSION_DAY_S).toBe(60);
    expect(DEFAULT_TOWN_DAY_LENGTH).toBe(TOWN_SESSION_DAY_S);
    expect(HUNGER_RATE).toBeCloseTo(needRate(DOLLHOUSE_SCALE, "hunger"), 12);
  });
  it("need pacing (the dollhouse motive set, exactly as shipped)", () => {
    expect(NEED_FILL_S.hunger).toBe(240);
    expect(NEED_FILL_S.energy).toBe(384);
    expect(NEED_FILL_S.social).toBe(192);
    expect(NEED_FILL_S.fun).toBe(240);
    expect(NEED_FILL_S.thirst).toBe(300);
    expect(NEED_FILL_S.waste).toBe(600);
    expect(NEED_FILL_S.hygiene).toBe(700);
    expect(NEED_FILL_S.dirt).toBe(480);
  });
  it("the 12 s nap and the one-day house", () => {
    expect(REST_DWELL_S).toBe(12);
    expect(restDwellS(DOLLHOUSE_SCALE)).toBe(12);
    expect(constructionGameDays(1, DOLLHOUSE_SCALE)).toBe(1); // house
    expect(constructionGameDays(2, DOLLHOUSE_SCALE)).toBe(2); // farm/market
    expect(constructionGameDays(1.5, DOLLHOUSE_SCALE)).toBe(1.5); // workshop
  });
  it("walk speed is the one villager pace", () => {
    expect(ERRAND_WALK).toBe(ERRAND_WALK_MPS);
    expect(ERRAND_WALK_MPS).toBe(1.6);
  });
});

describe("the `game.scale` declaration", () => {
  it("round-trips a profile through spec form", () => {
    expect(resolveWorldScale(scaleSpecOf(DOLLHOUSE_SCALE))).toEqual(DOLLHOUSE_SCALE);
    expect(resolveWorldScale(scaleSpecOf(REAL_SCALE))).toEqual(REAL_SCALE);
  });
  it("rejects unknown fields and out-of-range values, path-exact", () => {
    expect(() => parseWorldScaleSpec({ day_len: 240 }, "g.scale")).toThrow(/g\.scale\.day_len: unknown field/);
    expect(() => parseWorldScaleSpec({ rotation: 0 }, "g.scale")).toThrow(/g\.scale\.rotation/);
    expect(() => parseWorldScaleSpec({ planet_compression: 0.5 }, "g.scale")).toThrow(/g\.scale\.planet_compression/);
  });
  it("the retired absolute names its replacement instead of failing blankly", () => {
    // LAW: compression is a MULTIPLIER. A world still writing the old absolute
    // is told what to write, not just that it was wrong.
    expect(() => parseWorldScaleSpec({ day_length_s: 240 }, "g.scale")).toThrow(
      /g\.scale\.day_length_s: retired.*rotation: 360/s,
    );
  });
  it("rides the game envelope (parseGameSettings)", () => {
    const game = parseGameSettings(
      {
        scope: "town",
        world: { seed: 1 },
        scale: { rotation: 360, sleep_fraction: 0.05, construction: 180 },
      },
      "game",
    );
    expect(game.scale).toEqual({ rotation: 360, sleep_fraction: 0.05, construction: 180 });
    expect(resolveWorldScale(game.scale)).toEqual({ ...DOLLHOUSE_SCALE });
    // Absent = null = realism.
    expect(parseGameSettings({ scope: "town", world: {} }, "game").scale).toBeNull();
    expect(() => parseGameSettings({ scope: "town", world: {}, scale: { x: 1 } }, "game")).toThrow(
      /game\.scale\.x: unknown field/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// settlement-emergence.md step ① — the independently-moving clocks and the
// dimensionless ratios the settlement gates will read (§4b) plus the four
// invariants (§4c). THE LAW: no settlement rule may name an absolute duration,
// distance or quantity; and every compression variable is a MULTIPLIER over a
// real anchor, never an absolute.
// ─────────────────────────────────────────────────────────────────────────────

describe("compression variables are multipliers, not absolutes", () => {
  it("the day is derived from the planet's spin", () => {
    expect(dayLengthFor(1)).toBe(REAL_DAY_S);
    expect(dayLengthFor(360)).toBe(240);
    expect(resolveWorldScale({ rotation: 360 }).dayLengthS).toBe(240);
  });
  it("spin and orbit move INDEPENDENTLY — the year is their ratio", () => {
    // Spin 360× and leave the orbit alone: a year still takes a real year, it
    // just contains 131 490 short days.
    expect(yearGameDays(DOLLHOUSE_SCALE)).toBeCloseTo(REAL_YEAR_DAYS * 360, 6);
    expect(realMinutesPerYear(DOLLHOUSE_SCALE)).toBeCloseTo((REAL_YEAR_DAYS * 86_400) / 60, 3);
    // Accelerate the orbit too and the year closes up.
    expect(yearGameDays(SEASONAL_SCALE)).toBeCloseTo(12, 9);
  });
  it("revolutionForYearDays is the authoring inverse", () => {
    const rev = revolutionForYearDays(360, 12);
    expect(rev).toBeCloseTo(SEASONAL_SCALE.revolution, 9);
    expect(yearGameDays({ ...SEASONAL_SCALE, revolution: rev })).toBeCloseTo(12, 9);
  });
  it("the spec round-trips through multipliers and never emits the derived day", () => {
    const spec = scaleSpecOf(SEASONAL_SCALE);
    expect(spec).not.toHaveProperty("day_length_s");
    expect(resolveWorldScale(spec)).toEqual(SEASONAL_SCALE);
    expect(resolveWorldScale(scaleSpecOf(DOLLHOUSE_SCALE))).toEqual(DOLLHOUSE_SCALE);
    expect(resolveWorldScale(scaleSpecOf(REAL_SCALE))).toEqual(REAL_SCALE);
  });
});

describe("compression scales EVERY body in the universe (relative scales preserved)", () => {
  it("the distance dials default to the BODY dial — uniform shrink", () => {
    const mini = resolveWorldScale({ planet_compression: 25 });
    expect(mini.interplanetary).toBe(25);
    expect(mini.interstellar).toBe(25);
    // Uniform shrink is invisible: everything keeps its apparent size.
    expect(apparentSizeGain(mini)).toBe(1);
    expect(apparentStarGain(mini)).toBe(1);
  });
  it("a big moon in the sky is BOUGHT, never stumbled into", () => {
    // Pull orbits in harder than bodies shrink and neighbours loom — the
    // deliberate exception the law allows, and it reports itself.
    const storybook = resolveWorldScale({ planet_compression: 25, interplanetary: 100 });
    expect(apparentSizeGain(storybook)).toBe(4);
    // ...and the night sky can be tuned separately from the daytime one.
    expect(apparentStarGain(resolveWorldScale({ planet_compression: 25, interstellar: 250 }))).toBe(10);
  });
  it("real and dollhouse skies are honest (gain 1)", () => {
    expect(apparentSizeGain(REAL_SCALE)).toBe(1);
    expect(apparentSizeGain(DOLLHOUSE_SCALE)).toBe(1);
    expect(apparentStarGain(SEASONAL_SCALE)).toBe(1);
  });
  it("the distance dials round-trip and are gated path-exact", () => {
    const spec = { planet_compression: 25, interplanetary: 100, interstellar: 250 };
    expect(scaleSpecOf(resolveWorldScale(spec))).toMatchObject(spec);
    expect(() => parseWorldScaleSpec({ interplanetary: 0 }, "g.scale")).toThrow(/g\.scale\.interplanetary/);
    expect(() => parseWorldScaleSpec({ interstellar: 0 }, "g.scale")).toThrow(/g\.scale\.interstellar/);
  });
});

// ── THE SETTLED MAP (growth phase C §1.1) ─────────────────────────────────
// `gap_compression` and the two derivations it drives. The identities below
// are the phase's own guardrail: real scale must reproduce the historical
// anchors EXACTLY, so shipping the dial re-lays nothing that already exists.
describe("gap_compression and the settled map's two distances", () => {
  it("REAL reproduces both anchors EXACTLY — the identity pins", () => {
    expect(townSpacingM(REAL_SCALE)).toBe(REAL_TOWN_SPACING_M); // 25 000 m
    expect(townExtentM(REAL_SCALE)).toBe(REAL_TOWN_EXTENT_M); // 450 m
    // ...and the town dimensions read the SAME anchor (one definition).
    expect(TOWN_DIMS.townRMax).toBe(REAL_TOWN_EXTENT_M);
  });

  it("every SHIPPED profile is untouched — the street clock does not crowd towns", () => {
    // The clock is deliberately absent from the derivation (the walking
    // trilemma: a 240 s day with real legs would stand towns 91 m apart while
    // their own houses are 10 m wide). Only the SPACE dial moves them.
    for (const s of [REAL_SCALE, DOLLHOUSE_SCALE, SEASONAL_SCALE]) {
      expect(townSpacingM(s)).toBe(REAL_TOWN_SPACING_M);
      expect(townExtentM(s)).toBe(REAL_TOWN_EXTENT_M);
    }
  });

  it("the dial defaults to the BODY dial, like the two sky dials", () => {
    expect(resolveWorldScale({ planet_compression: 25 }).gapCompression).toBe(25);
    // ...and is separable: a real-radius world may still crowd its towns.
    expect(resolveWorldScale({ gap_compression: 40 }).gapCompression).toBe(40);
    expect(resolveWorldScale({ planet_compression: 25, gap_compression: 4 }).gapCompression).toBe(4);
  });

  it("a compressed world crowds its towns and shrinks their extents with them", () => {
    const mini = resolveWorldScale({ gap_compression: 32 });
    expect(townSpacingM(mini)).toBeCloseTo(781.25, 6);
    expect(townExtentM(mini)).toBeCloseTo(195.3125, 6);
  });

  it("gait moves the spacing — a day's walk is longer on longer legs", () => {
    expect(townSpacingM(resolveWorldScale({ locomotion: 2 }))).toBe(2 * REAL_TOWN_SPACING_M);
  });

  it("THE CLIP LAW holds at every gap: the road always outlives the two towns", () => {
    // 2·extent + MIN_PORT_ROUTE_M < the shortest route, for any world whose
    // towns are more than 20 m apart. Swept rather than argued.
    for (const gap of [25_000, 5_000, 1_200, 867, 500, 200, 100, 50, 21]) {
      const e = townExtentM(REAL_SCALE, gap);
      expect(2 * e + 10).toBeLessThan(gap);
    }
    // ...and the declared extent still caps it wherever the world is roomy.
    expect(townExtentM(REAL_SCALE, 1e9)).toBe(REAL_TOWN_EXTENT_M);
  });

  it("the dial round-trips and is gated path-exact", () => {
    expect(scaleSpecOf(resolveWorldScale({ gap_compression: 32 }))).toMatchObject({ gap_compression: 32 });
    expect(() => parseWorldScaleSpec({ gap_compression: 0 }, "g.scale")).toThrow(/g\.scale\.gap_compression/);
    expect(() => parseWorldScaleSpec({ gap_compression: 10_001 }, "g.scale")).toThrow(/g\.scale\.gap_compression/);
  });

  it("a gap compressed past the point of towns REPORTS, never throws", () => {
    const absurd = resolveWorldScale({ gap_compression: 5_000 });
    expect(townExtentM(absurd)).toBeLessThan(2);
    expect(scaleWarnings(absurd).join(" ")).toMatch(/gap: towns stand/);
    // The shipped profiles say nothing about gaps.
    expect(scaleWarnings(REAL_SCALE).join(" ")).not.toMatch(/gap:/);
  });
});

describe("metabolism is a dial of its own (the eating period is not the day)", () => {
  it("at metabolism 1 every shipped need time is byte-identical", () => {
    for (const key of ["hunger", "energy", "social", "fun", "thirst", "waste", "hygiene", "dirt"] as const) {
      expect(needFillS(DOLLHOUSE_SCALE, key)).toBe(NEED_FILL_S[key]);
    }
  });
  it("raising it shortens every motive together — the ratios survive", () => {
    const fast = { ...DOLLHOUSE_SCALE, metabolism: 3 };
    expect(needFillS(fast, "hunger")).toBeCloseTo(80, 9); // a meal every 80 s
    // Hunger still bites before tiredness, in the same proportion.
    expect(needFillS(fast, "energy") / needFillS(fast, "hunger")).toBeCloseTo(
      needFillS(DOLLHOUSE_SCALE, "energy") / needFillS(DOLLHOUSE_SCALE, "hunger"),
      9,
    );
  });
  it("locomotion moves reach without touching the clock", () => {
    expect(walkSpeedMps(DOLLHOUSE_SCALE)).toBe(ERRAND_WALK_MPS);
    expect(walkSpeedMps({ ...DOLLHOUSE_SCALE, locomotion: 2 })).toBeCloseTo(3.2, 9);
    // The district sizer rides it (serviceRadiusM defaults to the world's gait).
    expect(forageRadiusM({ ...DOLLHOUSE_SCALE, locomotion: 2 })).toBeCloseTo(
      2 * forageRadiusM(DOLLHOUSE_SCALE),
      6,
    );
  });
});

describe("the settlement ratios (§4b)", () => {
  it("real world: 365 meals a year, ~146 stored to cross a temperate winter", () => {
    expect(mealsPerYear(REAL_SCALE)).toBeCloseTo(365.25, 6);
    expect(leanSeasonMeals(REAL_SCALE)).toBeCloseTo(365.25 * REAL_LEAN_FRACTION, 6);
  });
  it("the ox paradox: a payload of rations IS a travel budget", () => {
    // 10 rations at one-a-day = 10 game-days out (5 there and back).
    expect(carryDays(REAL_SCALE, 10)).toBeCloseTo(10, 9);
    // Eat three times a day and the same load buys a third of the range.
    expect(carryDays({ ...REAL_SCALE, metabolism: 3 }, 10)).toBeCloseTo(10 / 3, 9);
  });
  it("the dependency ratio comes from the growth stage alone", () => {
    expect(dependencyRatio(REAL_SCALE)).toBeCloseTo(REAL_GROWTH_FRACTION / (1 - REAL_GROWTH_FRACTION), 9);
    expect(dependencyRatio(REAL_SCALE)).toBeCloseTo(0.346, 3); // ~1 child per 3 adults
  });
  it("childhood rides the lifespan — compressing a life compresses growing up", () => {
    const fast = { ...REAL_SCALE, generation: 10 };
    expect(lifespanGameYears(fast)).toBe(7);
    expect(growthGameDays(fast) / lifespanGameDays(fast)).toBeCloseTo(REAL_GROWTH_FRACTION, 9);
    expect(dependencyRatio(fast)).toBeCloseTo(dependencyRatio(REAL_SCALE), 9); // invariant 3, by construction
  });
  it("mealsPerLifetime is where metabolism and generation MEET", () => {
    // The lifetime food cost of a person — moving the two dials apart moves it,
    // and it sets the surplus a society needs to carry anyone at all.
    expect(mealsPerLifetime(REAL_SCALE)).toBeCloseTo(365.25 * 70, 3);
    expect(mealsPerLifetime({ ...REAL_SCALE, metabolism: 3 })).toBeCloseTo(3 * 365.25 * 70, 3);
    expect(mealsPerLifetime({ ...REAL_SCALE, generation: 10 })).toBeCloseTo(365.25 * 7, 3);
  });
  it("scaleRatios reports every one of them", () => {
    expect(Object.keys(scaleRatios(SEASONAL_SCALE)).sort()).toEqual(
      [
        "apparentSizeGain", "apparentStarGain", "dependencyRatio", "forageRadiusM",
        "growthGameDays", "leanSeasonMeals", "lifespanGameYears", "mealsPerLifetime",
        "mealsPerYear", "realHoursForRatchet", "realHoursPerLifespan",
        "realMinutesPerYear",
        // MOVED (growth phase C §1.1): the settled map's two derived
        // distances joined the diagnostics when `gap_compression` gave a
        // world a way to move them.
        "townSpacingM", "townExtentM",
        "yearGameDays",
      ].sort(),
    );
  });
});

describe("the invariants (§4c), and who currently breaks them", () => {
  it("REAL_SCALE stores coherently but cannot be WATCHED — and that is the point", () => {
    // Realism is the anchor for storage: a temperate winter costs ~146 rations,
    // which is exactly what a real granary held. It is NOT session-legal — a
    // real year takes a real year — and that is what the compression dials are
    // for. The pedagogy profile is not the play profile.
    const warnings = scaleWarnings(REAL_SCALE);
    expect(leanSeasonMeals(REAL_SCALE)).toBeCloseTo(146.1, 1);
    expect(warnings.join(" ")).not.toMatch(/granary/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/never sees the cycle close/);
  });
  it("SEASONAL_SCALE clears the granary AND session bands at once", () => {
    expect(scaleWarnings(SEASONAL_SCALE)).toEqual([]);
    const lean = leanSeasonMeals(SEASONAL_SCALE);
    expect(lean).toBeGreaterThanOrEqual(GRANARY_MEALS_MIN);
    expect(lean).toBeLessThanOrEqual(GRANARY_MEALS_MAX);
    expect(lean).toBeCloseTo(14.4, 6);
    const mins = realMinutesPerYear(SEASONAL_SCALE);
    expect(mins).toBeGreaterThanOrEqual(SESSION_YEAR_MIN_MINUTES);
    expect(mins).toBeLessThanOrEqual(SESSION_YEAR_MAX_MINUTES);
    expect(mins).toBeCloseTo(48, 6);
  });
  it("THE TENSION, on the record: at metabolism 1 the two bands cannot BOTH be met", () => {
    // A session-legal year (5–15 game-days) eaten once a day yields at most
    // 15 × 0.4 = 6 lean rations — below the granary floor. The eating period
    // MUST be its own dial; this is why `metabolism` exists.
    for (const days of [5, 10, 15]) {
      const s = { ...DOLLHOUSE_SCALE, revolution: revolutionForYearDays(360, days) };
      expect(realMinutesPerYear(s)).toBeGreaterThanOrEqual(SESSION_YEAR_MIN_MINUTES);
      expect(realMinutesPerYear(s)).toBeLessThanOrEqual(SESSION_YEAR_MAX_MINUTES);
      expect(leanSeasonMeals(s)).toBeLessThan(GRANARY_MEALS_MIN);
      expect(scaleWarnings(s).join(" ")).toMatch(/storing is pointless/);
    }
  });
  it("the shipped DOLLHOUSE profile is seasonally incoherent, and says so", () => {
    // A fast spin with a real orbit: nothing ever sees a season, and a winter
    // would cost 52 596 rations. This is WHY the shipped town has no seasons.
    const warnings = scaleWarnings(DOLLHOUSE_SCALE);
    expect(warnings.join(" ")).toMatch(/no band can bank that/);
    expect(warnings.join(" ")).toMatch(/never sees the cycle close/);
    expect(leanSeasonMeals(DOLLHOUSE_SCALE)).toBeCloseTo(REAL_YEAR_DAYS * 360 * 0.4, 0);
  });
  it("a childhood that outweighs adulthood is reported, not silently allowed", () => {
    expect(scaleWarnings({ ...REAL_SCALE, growthFraction: 0 }).join(" ")).toMatch(/nothing is inherited/);
    expect(scaleWarnings({ ...REAL_SCALE, growthFraction: 0.8 }).join(" ")).toMatch(/dependents per producer/);
  });
  it("generational visibility: a real life is unwatchable, so the arc is scrubbed", () => {
    // exploitation-economics §Q4 wants 10 generations of feedback. Under the
    // seasonal profile that is ~56 real hours — the history scrubber's job,
    // not something a session lives through (§4c invariant 4).
    expect(realHoursPerLifespan(SEASONAL_SCALE)).toBeCloseTo(5.6, 1);
    expect(scaleRatios(SEASONAL_SCALE).realHoursForRatchet).toBeGreaterThan(24);
  });
});

describe("time compression (street clock)", () => {
  it("the street clock runs ~360× real time", () => {
    expect(TIME_COMPRESSION).toBeCloseTo(360, 10);
  });
  it("one game-year passes in about one real day — the multiplayer aging cadence", () => {
    expect(realDaysPerGameYear()).toBeCloseTo(1.014, 2);
  });
  it("street sleep is compressed ~7× beyond the day itself (5% vs the real third)", () => {
    expect(DOLLHOUSE_SCALE.sleepFraction).toBeCloseTo(0.05, 10);
    expect(REAL_SLEEP_FRACTION / DOLLHOUSE_SCALE.sleepFraction).toBeCloseTo(6.67, 1);
  });
});

describe("current incoherence, on the record (doc §2/§3)", () => {
  it("a street game-day of walking covers 384 m — not the 25 km the spacing assumes", () => {
    expect(dailyRangeM(ERRAND_WALK_MPS)).toBe(384);
  });
  it("the 'day's walk' to the next town is actually ~65 game-days (the trilemma)", () => {
    expect(gameDaysToCross(REAL_TOWN_SPACING_M, ERRAND_WALK_MPS)).toBeCloseTo(65.1, 1);
  });
});

describe("the planned resolution holds arithmetically (doc §3)", () => {
  it("road + mount makes ~9.1 m/s — the mounted courier is the fastest thing in the world", () => {
    expect(roadMountSpeedMps(ERRAND_WALK_MPS)).toBeCloseTo(9.14, 2);
  });
  it("a 5 km compressed gap by road+mount is the storybook two days' ride", () => {
    expect(gameDaysToCross(5_000, roadMountSpeedMps(ERRAND_WALK_MPS))).toBeCloseTo(2.28, 2);
  });
  it("...and on foot cross-country stays a ~13-day expedition (remoteness preserved)", () => {
    expect(gameDaysToCross(5_000, ERRAND_WALK_MPS)).toBeCloseTo(13.0, 1);
  });
  it("a 2.3-day ride debits rations and nights — inns become mechanically necessary", () => {
    const days = gameDaysToCross(5_000, roadMountSpeedMps(ERRAND_WALK_MPS));
    const rations = Math.ceil(days);
    const nights = Math.floor(days);
    expect(rations).toBe(3);
    expect(nights).toBe(2);
  });
});

describe("planet-scale diagnostics (doc §5)", () => {
  it("a life-size Earth at 25 km spacing implies ~240k towns — the premise's question", () => {
    const towns = townsOnPlanet(REAL_PLANET_RADIUS_M, REAL_TOWN_SPACING_M, REAL_LAND_FRACTION);
    expect(towns).toBeGreaterThan(230_000);
    expect(towns).toBeLessThan(245_000);
  });
  it("a compressed ÷25 Earth is a ~250 km storybook planet", () => {
    expect(REAL_PLANET_RADIUS_M / 25).toBeCloseTo(254_840, 0);
  });
  it("sanity: real day really is 86400 s", () => {
    expect(REAL_DAY_S).toBe(86_400);
  });
});
