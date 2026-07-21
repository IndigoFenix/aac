// The space-time-compression coherence diagnostics (planning-docs/games/
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
  REAL_TOWN_SPACING_M,
  REST_DWELL_S,
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
} from "@shared/world-engine/scale.js";
import { FOOD_DAY_SEC, ERRAND_WALK } from "@shared/world-engine/kernel/town/goods.js";
import { HUNGER_RATE } from "@shared/world-engine/kernel/town/activity.js";
import { DEFAULT_TOWN_DAY_LENGTH } from "@shared/world-engine/interaction/behavior/creature-goal-runtime.js";
import { DEFAULT_WORLD_CLOCK_CONFIG } from "@shared/world-engine/world-clock.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";

describe("realism is the engine default", () => {
  it("REAL_SCALE is the real world", () => {
    expect(REAL_SCALE.dayLengthS).toBe(86_400);
    expect(REAL_SCALE.sleepFraction).toBeCloseTo(1 / 3, 12);
    expect(REAL_SCALE.construction).toBe(1);
    expect(REAL_SCALE.planetCompression).toBe(1);
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
    expect(() => parseWorldScaleSpec({ day_length_s: 0 }, "g.scale")).toThrow(/g\.scale\.day_length_s/);
    expect(() => parseWorldScaleSpec({ planet_compression: 0.5 }, "g.scale")).toThrow(/g\.scale\.planet_compression/);
  });
  it("rides the game envelope (parseGameSettings)", () => {
    const game = parseGameSettings(
      {
        scope: "town",
        world: { seed: 1 },
        scale: { day_length_s: 240, sleep_fraction: 0.05, construction: 180 },
      },
      "game",
    );
    expect(game.scale).toEqual({ day_length_s: 240, sleep_fraction: 0.05, construction: 180 });
    expect(resolveWorldScale(game.scale)).toEqual({ ...DOLLHOUSE_SCALE });
    // Absent = null = realism.
    expect(parseGameSettings({ scope: "town", world: {} }, "game").scale).toBeNull();
    expect(() => parseGameSettings({ scope: "town", world: {}, scale: { x: 1 } }, "game")).toThrow(
      /game\.scale\.x: unknown field/,
    );
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
