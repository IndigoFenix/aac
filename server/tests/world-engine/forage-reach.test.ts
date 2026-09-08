/**
 * 🥾 FORAGE REACH = THE WALK BUDGET, NEVER THE OWNERSHIP DISC
 * (user ruling 2026-09-08 — plant-growth-render-round.md PART 5).
 *
 * THE MEASURED DEFECT. A hunger row's forage arm iterated
 * `session.wilderness.features` and nothing else. On a PLANET world those
 * features are post-filtered by the NEAR-STAND DISC — `nearStandRadiusM` = 30 m
 * at zero buildings, 0.28 ha — which is the site's OWNERSHIP answer ("what may
 * I fell, what may I designate"), not a walk. Measured on
 * `frontier-planet.spec.json` seed 11 over 10 play-days: ONE food plant in
 * reach, 9 take events, **0.18 rations/day** against the 5.00 five settlers
 * eat, hunger climbing linearly to 10.2 meals overdue and 45 starvation
 * body-days — while **318 food units stood in the eight ring-1
 * `wild:area:tile-<i>-<j>` records** the neighbouring-stands round (#49) minted
 * as *"what the site REACHES FOR"*, read by construction hauls only and never
 * by a hunger row. `forageRadiusM` — 182.4 m, the body's own answer — never
 * bound, because the disc had already deleted everything past 30 m.
 *
 * WHAT THIS FILE PINS:
 *   ① THE CLOCK — the forage walk budget rides the METABOLIC clock (half a
 *      meal-interval's walk), not the solar day. Behaviour-identical on every
 *      shipped world; different the moment a world declares `metabolism ≠ 1`.
 *   ② THE GEOMETRY — ring 1 is inside a body's budget and ring 2 is not, at the
 *      shipped clock, AND the ring cap refuses ring 2 independently of any
 *      distance so the bound survives a scale change.
 *   ③ THE LIST, on the real arc — a settler's forage take lands on a ring-1
 *      TILE record, that take DEBITS the record and BOOKS its direction, and
 *      the party eats. Emergent on purpose: the union list exists nowhere else.
 *   ④ THE DISC IS NOT CONSULTED FOR FOOD — the arc delivers more than the
 *      whole disc could ever renew, which no reading of the disc can explain.
 *   ⑤ 🔒 A COUNT WORLD IS UNTOUCHED — no tiles are minted there, so the union
 *      degenerates to the shipped list and every bench world is byte-identical
 *      by construction (#49's own bench-safety law, read from the needs side).
 *
 * DB-free / GL-free — `npm run test:engine -- forage-reach`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  isNeighborTileKey,
  neighborTileIndex,
  neighborTileRect,
  NEIGHBOR_TILE_M,
} from "@shared/world-engine/interaction/quest/neighbor-stands.js";
import {
  wildRectPointToward,
  type WildAreaRecord,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import { nearStandRadiusM } from "@shared/world-engine/interaction/quest/wilderness.js";
import { naturalSourceOf } from "@shared/world-engine/products.js";
import { FOOD_KINDS, satiationDaysOf } from "@shared/world-engine/kernel/town/goods-kinds.js";
import {
  DOLLHOUSE_SCALE,
  dailyTravelM,
  forageRadiusM,
  needFillS,
  resolveWorldScale,
  walkSpeedMps,
  type WorldScale,
} from "@shared/world-engine/scale.js";

const SEED = 11;
const DT = 0.5;
const DAY_S = 240;

const readDoc = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", name), "utf8"));

/** The shipped frontier homestead's clock (worlds.ts `frontier-planet`). */
const STREET_CLOCK: WorldScale = resolveWorldScale({
  rotation: 360,
  sleep_fraction: 0.05,
  construction: 720,
  gap_compression: 10,
  resource_compression: 7.5,
} as never);

const FOOD = new Set<string>(FOOD_KINDS);

/** Food units a record holds that a FORAGE take could actually move — the
 *  harvest half only (a body product is a felling, never a hunger row's). */
function recordFoodUnits(rec: WildAreaRecord): number {
  let n = 0;
  for (const st of rec.stands) {
    const src = naturalSourceOf(st.species);
    if (!src) continue;
    for (const [g, u] of Object.entries(st.stock)) {
      if (!(u > 0) || !FOOD.has(g)) continue;
      if (!src.products.some((p) => p.glyph === g && p.method === "harvest")) continue;
      n += u;
    }
  }
  return n;
}

const ringOf = (key: string): number => {
  const i = neighborTileIndex(key)!;
  return Math.max(Math.abs(i.i), Math.abs(i.j));
};

// ── ① THE CLOCK ────────────────────────────────────────────────────────────
//
// TWO CLOCKS (space-time-compression.md `## ⚖️ RULINGS 2026-09-08`): the day is
// the SOLAR clock, the meal interval is the METABOLIC one, and a budget for
// walking after FOOD belongs to the second. `forageRadiusM` multiplied
// `dayLengthS` until this round, which is the same number only while
// `NEED_FILL_DAYS.hunger / metabolism` happens to be 1.

describe("① the forage walk budget rides the METABOLIC clock", () => {
  it("is half a meal-interval's waking walk — and unchanged on every shipped world", () => {
    // The identity, spelled out: gait × meal interval × waking share ÷ 2.
    expect(forageRadiusM(DOLLHOUSE_SCALE)).toBeCloseTo(
      (walkSpeedMps(DOLLHOUSE_SCALE) * needFillS(DOLLHOUSE_SCALE, "hunger") * (1 - DOLLHOUSE_SCALE.sleepFraction)) / 2,
      9,
    );
    // 🔒 BEHAVIOUR-IDENTICAL TODAY. Every world that boots declares
    // `metabolism: 1`, where the meal interval IS the day — so the re-key moves
    // no shipped number, and this is the assertion that says so.
    expect(needFillS(DOLLHOUSE_SCALE, "hunger")).toBe(DOLLHOUSE_SCALE.dayLengthS);
    expect(forageRadiusM(DOLLHOUSE_SCALE)).toBeCloseTo(dailyTravelM(DOLLHOUSE_SCALE) / 2, 9);
    expect(forageRadiusM(STREET_CLOCK)).toBeCloseTo(182.4, 6);
  });

  it("…and it is the metabolism that moves it, which is the whole point of the re-key", () => {
    const fast = { ...DOLLHOUSE_SCALE, metabolism: 3 }; // a meal every 80 s
    // A body that must eat three times a game-day cannot forage over a whole
    // day's walk. The SOLAR answer is blind to that; the metabolic one is not.
    expect(forageRadiusM(fast)).toBeCloseTo(forageRadiusM(DOLLHOUSE_SCALE) / 3, 6);
    expect(dailyTravelM(fast) / 2).toBeCloseTo(forageRadiusM(DOLLHOUSE_SCALE), 6); // the day did NOT move
    // Legs still move reach without touching either clock (the standing pin).
    expect(forageRadiusM({ ...DOLLHOUSE_SCALE, locomotion: 2 })).toBeCloseTo(
      2 * forageRadiusM(DOLLHOUSE_SCALE),
      6,
    );
  });
});

// ── ② THE GEOMETRY ─────────────────────────────────────────────────────────

describe("② which tiles a body may forage — the ring, and the budget", () => {
  const centre = { x: 1000, y: 1000 };
  /** The rect-edge distance a forage candidate is PRICED at (`wildRectPointToward`
   *  — the director's unclamped answer, so ring 1 and ring 2 rank differently). */
  const edgeDistance = (i: number, j: number): number => {
    const area = neighborTileRect(centre, i, j, NEIGHBOR_TILE_M);
    const p = wildRectPointToward({ key: "", area, seed: 0, at: 0, stands: [], draw: [] }, centre);
    return Math.hypot(p.x - centre.x, p.y - centre.y);
  };

  it("ring 1 is inside the shipped walk budget and ring 2 is outside it", () => {
    const budget = forageRadiusM(STREET_CLOCK);
    expect(edgeDistance(1, 0)).toBeCloseTo(NEIGHBOR_TILE_M / 2, 9); // 100 m
    expect(edgeDistance(1, 1)).toBeCloseTo(Math.hypot(100, 100), 9); // 141.4 m
    expect(edgeDistance(1, 0)).toBeLessThan(budget);
    expect(edgeDistance(1, 1)).toBeLessThan(budget);
    expect(edgeDistance(2, 0)).toBeCloseTo(300, 9);
    expect(edgeDistance(2, 0)).toBeGreaterThan(budget);
  });

  it("🚫 …and the RING is the structural bound, not the distance", () => {
    // The budget alone would admit ring 2 the moment a world declared a longer
    // meal interval or faster legs — and a body walking there would spend the
    // far half of the trip on ground no frame ever renders (a ring-2 rect lies
    // WHOLLY outside the session's manifold). The ring cap is what makes reach
    // bounded by the records that describe walkable ground, not by a number.
    const roomy = { ...STREET_CLOCK, locomotion: 4 };
    expect(forageRadiusM(roomy)).toBeGreaterThan(edgeDistance(2, 0));
    // The near stand, meanwhile, can never grow into ring-1 ground at all —
    // #49's no-double-count invariant, which is also why the two tiers can be
    // unioned without a tree being represented twice.
    expect(nearStandRadiusM(STREET_CLOCK, 1 << 20)).toBeLessThan(NEIGHBOR_TILE_M / 2);
  });
});

// ── ③④ THE REAL ARC ────────────────────────────────────────────────────────
//
// EMERGENT ON PURPOSE. The union list is built inside `bodyNeedCtx` /
// `residentNeedCtx` and exists nowhere a unit test can reach; a unit test of
// the candidate builder would have passed happily throughout the entire defect
// (PART 4 made exactly that mistake and "ruled reach out"). What can be
// observed from outside is what the RECORDS look like after a party has been
// hungry for three play-days, and that is what these assert.

describe("③④ a settler forages the ring-1 tiles — the real founding arc", () => {
  let run: TextQuestRun;
  let discFoodPlants: number;
  let ring1AtBoot: number;
  let ring1After: number;
  let drawByRing: Map<number, number>;

  beforeAll(() => {
    run = bootTextQuest({ world: readDoc("frontier-planet.spec.json"), seed: SEED, dt: DT });
    const s = run.session;
    // The disc's own larder, at boot: how many STANDING food plants a hunger
    // row could have seen before this round.
    const r = nearStandRadiusM(s.scale, 0);
    const c = s.town!.stage.center;
    discFoodPlants = (s.wilderness?.features ?? []).filter(
      (f) =>
        (naturalSourceOf(f.species)?.products ?? []).some(
          (p) => p.method === "harvest" && FOOD.has(p.glyph),
        ) && Math.hypot(f.x - c.x, f.y - c.y) <= r,
    ).length;
    ring1AtBoot = 0;
    for (const [k, rec] of s.areaRecords) {
      if (isNeighborTileKey(k) && ringOf(k) === 1) ring1AtBoot += recordFoodUnits(rec);
    }
    // Three play-days: long enough that the founders' kit is gone and every
    // body has been hungry more than once.
    run.advanceS(3 * DAY_S);
    ring1After = 0;
    drawByRing = new Map();
    for (const [k, rec] of s.areaRecords) {
      if (!isNeighborTileKey(k)) continue;
      const ring = ringOf(k);
      if (ring === 1) ring1After += recordFoodUnits(rec);
      const drawn = rec.draw.reduce((a, b) => a + b, 0);
      drawByRing.set(ring, (drawByRing.get(ring) ?? 0) + drawn);
    }
  }, 900_000);

  afterAll(() => run?.dispose());

  it("the fixture is the defect's own world: eight ring-1 tiles, a near-EMPTY clearing", () => {
    // If this ever stops being true the arc below proves nothing — fail loud
    // rather than measuring a world that was never short of food.
    expect([...run.session.areaRecords.keys()].filter((k) => isNeighborTileKey(k) && ringOf(k) === 1))
      .toHaveLength(8);
    expect(discFoodPlants).toBeLessThanOrEqual(2);
    expect(ring1AtBoot).toBeGreaterThan(100);
  });

  it("③ a forage take DEBITS a ring-1 record and BOOKS the direction it came from", () => {
    // The units left the stand — they were not minted onto a shelf and they
    // were not conjured on the body. (Regrowth pushes the total back up between
    // takes, so this is a *net* drop across three days of eating, which is the
    // stronger statement.)
    expect(ring1After).toBeLessThan(ring1AtBoot);
    // …and the harvest-direction histogram carries it, which is what makes the
    // near side of a tile thin first (`drawWildArea`'s own `addWildDraw`).
    expect(drawByRing.get(1) ?? 0).toBeGreaterThan(0);
  });

  it("③ …and never past ring 1 — reach is bounded by the records that exist", () => {
    for (const [ring, drawn] of drawByRing) {
      if (ring > 1) expect(drawn).toBe(0);
    }
  });

  it("④ the party EATS — hunger no longer climbs without a ceiling", () => {
    // BEFORE (same seed, same dt, the disc alone): every settler's hunger row
    // was 3.40 meals overdue at day 3 and rose linearly to 10.16 by day 10.
    // AFTER: the rows cycle around 1 — the shape of a body that eats.
    const fillS = needFillS(run.session.scale, "hunger");
    const now = run.session.townClock;
    const levels: number[] = [];
    for (const [, rows] of run.session.bodyNeeds) {
      const row = rows.get("hunger:food");
      if (row) levels.push(row.level + (now - row.at) / fillS);
    }
    expect(levels.length).toBe(5); // the five founders
    for (const v of levels) expect(v).toBeLessThan(2.5);
  });

  it("④ the DISC cannot explain what was eaten — so it is not what was consulted", () => {
    // What the clearing can renew, closed-form: one unit per `regrowDays` per
    // bearing plant (`dueHarvestRegrowth`), at 0.2 rations a unit. With one
    // apple tree standing that is 0.20 rations/day — 0.60 over this arc, out of
    // a 15.00-ration demand. The tiles moved units an order of magnitude past
    // anything inside 30 m, and the record's own books are the witness.
    const eaten = (ring1AtBoot - ring1After) * satiationDaysOf("berry");
    expect(satiationDaysOf("berry")).toBeCloseTo(0.2, 9);
    expect(eaten).toBeGreaterThan(discFoodPlants * 3 * satiationDaysOf("berry"));
  });
});

// ── ⑤ THE BENCH LAW ────────────────────────────────────────────────────────

describe("⑤ a COUNT world mints no tiles, so the union degenerates to the old list", () => {
  let run: TextQuestRun;

  beforeAll(() => {
    run = bootTextQuest({ world: readDoc("homestead.spec.json"), seed: SEED, dt: DT });
    run.advanceS(DAY_S);
  }, 900_000);

  afterAll(() => run?.dispose());

  it("has no tile records at all — the charter arm is untouched by this round", () => {
    // #49's bench-safety law: a `count` mix describes an AUTHORED stand, so
    // nothing is minted outside it and a forage list has exactly the standing
    // features it always had. Every dollhouse/preset/harness world is on this
    // arm, which is why the bench transcript cannot move.
    expect([...run.session.areaRecords.keys()].filter(isNeighborTileKey)).toHaveLength(0);
    // …and its own countryside is real, so the arm being tested is live, not absent.
    expect((run.session.wilderness?.features ?? []).length).toBeGreaterThan(0);
  });
});
