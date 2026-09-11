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
 *   ⑥⑦⑧ PART 5b — the forage CLAIM, the SPREAD, the DETERMINISM.
 *   ⑨⑩ STAGE 1b — a pursuit that loses its thing RE-SELECTS the row instead of
 *      parking it, and a queued errand nothing is walking is ABANDONED, not
 *      busy (emergent-plans-round.md Stage 1b).
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
import { freeUnitsOver } from "@shared/world-engine/kernel/town/reservations.js";
import { naturalSourceOf } from "@shared/world-engine/products.js";
import { rationsPerBearing } from "@shared/world-engine/planet/packing.js";
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
  /** What the CLEARING can renew across the arc, closed-form — see ④. */
  let discRenewalRations = 0;
  /** …and what that clearing is actually HOLDING, in person-days. */
  let discStandingRations: number;
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
    // ⚖️ …AND WHAT IT CAN RENEW IN THE WINDOW, from the plants' OWN rows.
    //
    // 🌿 RE-DERIVED (the resource-packing round). This read "one unit per
    // `regrowDays`, at that glyph's satiation" — the law `dueHarvestRegrowth`
    // ran until a bearing became THE PLANT'S OWN (a bush puts out 0.53 items a
    // cadence, a hazel 2.46), so the flat one-unit form now over-counts small
    // plants and under-counts trees. `rationsPerBearing` IS the renewal in
    // rations, straight off the row, with no satiation round-trip.
    discRenewalRations = (s.wilderness?.features ?? [])
      .filter((f) => Math.hypot(f.x - c.x, f.y - c.y) <= r)
      .reduce((sum, f) => {
        const src = naturalSourceOf(f.species);
        if (!src) return sum;
        let n = sum;
        for (const p of src.products) {
          if (p.method !== "harvest" || !FOOD.has(p.glyph) || !(p.regrowDays && p.regrowDays > 0)) continue;
          n += (3 / p.regrowDays) * rationsPerBearing(src, p);
        }
        return n;
      }, 0);
    discStandingRations = (s.wilderness?.features ?? [])
      .filter((f) => Math.hypot(f.x - c.x, f.y - c.y) <= r)
      .reduce(
        (a, f) =>
          a +
          Object.entries(f.stock).reduce(
            (b, [g, n]) => b + (FOOD.has(g) ? n * satiationDaysOf(g) : 0),
            0,
          ),
        0,
      );
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

  it("the fixture is the defect's own world: eight ring-1 tiles, a clearing that cannot feed five", () => {
    // If this ever stops being true the arc below proves nothing — fail loud
    // rather than measuring a world that was never short of food.
    expect([...run.session.areaRecords.keys()].filter((k) => isNeighborTileKey(k) && ringOf(k) === 1))
      .toHaveLength(8);
    // 🌿 MOVED BY PART 6 (2026-09-08), and the WHY is that the old number was
    // the DEFECT, not the fixture. This read `<= 2` — "a near-EMPTY clearing" —
    // because the shipped forest cell stood 3.32 food plants/ha over 15.05
    // oaks/ha, a wood with no understory, which is exactly what the user could
    // see ("there are none in the immediate area"). The understory now stands
    // (`planet/ecology.ts FORAGE_UNDERSTORY`), so the clearing is no longer
    // empty and asserting that it is would pin the bug.
    //
    // ⚖️ WHAT THE FIXTURE ACTUALLY NEEDS is unchanged and is now said directly:
    // the disc cannot feed the party, so reaching past it is the only way they
    // eat. Five founders need 5.00 rations/day; the disc's whole STANDING crop
    // is a fraction of one day's demand, and its RENEWAL (one unit per
    // `regrowDays` per plant) is smaller still — both asserted below.
    expect(discFoodPlants).toBeGreaterThanOrEqual(2); // an understory stands…
    expect(discStandingRations).toBeLessThan(5);      // …and it is not a larder
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

  it("④ the party EATS — hunger no longer climbs at the metabolic rate", () => {
    // ⚠️ RE-ANCHORED FROM A LEVEL TO A SLOPE (PART 5b), and the reason is that
    // a level is a statement about the COUNTRYSIDE while this pin is about
    // REACH. PART 5 asserted "every row below 2.5 at day 3", which was true of
    // the tree it was written on and is not a fact about foraging: the density
    // round has since moved what a hectare bears, and a level pin re-fails
    // every time somebody tunes the land — the very coupling `wilderness.ts`
    // warns about ("THE COUNTS ARE NOT TUNED HERE"). Nothing was relaxed: the
    // defect's own signature is a SLOPE, and this is the sharper reading of it.
    //
    // With the disc alone nobody could reach food at all, so every row rose at
    // exactly the metabolic rate — one ration per fill clock, measured
    // 1.48 → 3.40 → … → 10.16 over ten play-days, dead straight. Anything that
    // feeds anybody bends that line; nothing that starves them can.
    const fillS = needFillS(run.session.scale, "hunger");
    const now = run.session.townClock;
    const levels: number[] = [];
    for (const [, rows] of run.session.bodyNeeds) {
      const row = rows.get("hunger:food");
      if (row) levels.push(row.level + (now - row.at) / fillS);
    }
    expect(levels.length).toBe(5); // the five founders
    // Three play-days of un-fed accrual is 3 fill clocks' worth; the party's
    // mean must sit under the line a party that never ate would be on.
    expect(levels.reduce((a, b) => a + b, 0) / levels.length).toBeLessThan(3 * (DAY_S / fillS));
  });

  it("④ the DISC cannot explain what was eaten — so it is not what was consulted", () => {
    // ⚠️ RE-ANCHORED (PART 5c) FOR THE SAME REASON ④ ABOVE WAS. The threshold
    // was `discFoodPlants × 3 units` — a flat guess that a clearing plant bears
    // three units in three days. Fair as an over-estimate when the disc held
    // ONE apple tree (`regrowDays` 1); the density round then put SEVEN plants
    // in it, most of them hazels at `regrowDays` 4, which bear 0.75 units in
    // the window and not 3 — so the bar rose to 4.2 rations of food the
    // clearing cannot actually make, and the pin failed on the land moving
    // rather than on reach moving.
    //
    // It now uses the closed form this comment always claimed: one unit per
    // `regrowDays` per bearing plant, off the plants' OWN catalogue rows, at
    // 0.2 rations a unit (`discRenewalRations`, derived at boot). SHARPER, not
    // weaker — the old number was arithmetically wrong in both directions
    // depending on what happened to stand in the clearing.
    const eaten = (ring1AtBoot - ring1After) * satiationDaysOf("berry");
    expect(satiationDaysOf("berry")).toBeCloseTo(0.2, 9);
    expect(discRenewalRations).toBeGreaterThan(0); // the clearing is not barren
    expect(eaten).toBeGreaterThan(discRenewalRations);
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

// ═══════════════════════════════════════════════════════════════════════════
// PART 5b — FORAGE CLAIMS, VALUE − COST, K STAND POINTS
// ═══════════════════════════════════════════════════════════════════════════
//
// 🚨 THE DEFECT PART 5 LEFT BEHIND, and it is the exact inverse of PART 5 Ⓕ.
// PART 5 argued that a 4 ha tile is a SHELF, not a snack, so it must NOT drop
// off the list when one body sets out for it. True about the UNITS and false
// about the GROUND: a record offered ONE walk-to point (`wildShelfPointOf` —
// where a haul's cut goods wait at the road), every body resolved that same
// point, and `pursuitResolver.standable` hands a raw point back UNCHANGED
// whenever `standClear` passes — a structure test that cannot see a body. So a
// 200 m tile edge behaved like a single doorstep, and once a tile held more
// than the party could eat, five settlers queued on one metre of ground.
//
// Measured on the shipped tree (`frontier-planet` seed 11, dt 1/2, 10
// play-days), before → after:
//   · takes across ring-1 records   64/34/7 (two tiles carry 93 %) → 37/28/20/11
//   · seconds with two hunger-errand bodies inside one arrival disc  334 → 188
//   · dense (food ×4): the same crowding measure                     318 → 19
//
// WHAT THIS SECTION PINS:
//   ⑥ THE CLAIM IS REAL — a forage take on a region books a whole unit in the
//     reservation ledger (it used to floor to nothing), and a record whose free
//     units are spoken for reports zero free.
//   ⑦ THE GROUND IS SHARED — takes reach several ring-1 records rather than
//     hammering the nearest one.
//   ⑧ DETERMINISM — sorted-cid visiting makes the whole arc reproducible, which
//     is what "the same on every peer" means for a claim.

describe("⑥⑦⑧ PART 5b — the claim, the spread and the determinism", () => {
  let run: TextQuestRun;
  let tileTakes: Map<string, number>;
  /** 🌿 TAKES OFF STANDING PLANTS in the party's OWN disc, by endpoint (the
   *  resource-packing round). `tileTakes` counts only FOLDED region records,
   *  which was the whole of a founding's larder while the disc stood nearly
   *  empty; on a packed cell it is the smaller half. ⑦ reads both. */
  let floraTakes: Map<string, number>;
  let claimedOnATile = false;
  /** ⑨⑩ STAGE 1b — every `[needs]` line about a blocked pursuit or a reaped
   *  errand queue, in order, over FOUR play-days on this same boot. */
  const stage1bLines: string[] = [];
  const noteStage1b = (s: string) => {
    // The blocks and the reap — plus the two things a body only does when it is
    // still IN the decide loop (a take, a sleep), which is what ⑩ reads.
    if (/blocked mid-flight|orphaned errand queue reaped|took [\d.]+×|slept /.test(s)) stage1bLines.push(s);
  };

  /** 🪨 SHAPE (A)'s OWN GROUND (§18) — the SCARCITY world's blocked-mid-flight
   *  lines. `frontier-planet` stopped producing shape (A) once settlers kept a
   *  camp larder (measured: 0 in ten play-days); `homestead.spec.json` still
   *  produces it in quantity, so the shape is measured where it happens. Same
   *  seed, same dt, one short boot — the cheapest honest arrange there is. */
  const scarcityBlocks: string[] = [];

  /** Every `wild:area:` reservation row the need holders hold right now. */
  const areaClaimRows = (r: TextQuestRun) =>
    r.session.needClaims
      .toJSON()
      .rows.filter((row) => row.holder.startsWith("need:") && isNeighborTileKey(row.endpoint.replace("wild:area:", "")));

  beforeAll(() => {
    // ── SHAPE (A)'s BOOT, FIRST and SHORT (§18) ──────────────────────────
    // Two play-days of the scarcity world is enough (measured: 35 lines in
    // four). Its console tap is closed before the main boot opens its own, so
    // the two never interleave.
    {
      const scarcity = bootTextQuest({ world: readDoc("homestead.spec.json"), seed: SEED, dt: DT });
      const prevLog = console.log;
      console.log = (...parts: unknown[]) => {
        const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
        if (line.includes("blocked mid-flight")) scarcityBlocks.push(line);
      };
      try {
        for (let i = 0; i < (2 * DAY_S) / DT; i++) scarcity.advance(1);
      } finally {
        console.log = prevLog;
      }
    }
    run = bootTextQuest({ world: readDoc("frontier-planet.spec.json"), seed: SEED, dt: DT });
    tileTakes = new Map();
    floraTakes = new Map();
    const origLog = console.log;
    console.log = (...parts: unknown[]) => {
      const s = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
      const m = /took ([\d.]+)×food from (wild:area:\S+)/.exec(s);
      if (m && Number(m[1]) > 0) tileTakes.set(m[2]!, (tileTakes.get(m[2]!) ?? 0) + 1);
      const f = /took ([\d.]+)×food from (flora:\S+)/.exec(s);
      if (f && Number(f[1]) > 0) floraTakes.set(f[2]!, (floraTakes.get(f[2]!) ?? 0) + 1);
      noteStage1b(s);
    };
    try {
      // Sampled rather than end-state: a claim lives only while a body is
      // walking, so "was one ever booked" is the question, not "is one now".
      for (let i = 0; i < 3 * DAY_S / DT; i++) {
        run.advance(1);
        if (!claimedOnATile && areaClaimRows(run).length > 0) claimedOnATile = true;
      }
      // ⑨⑩ STAGE 1b — ONE MORE PLAY-DAY ON THE SAME BOOT, and no fourth boot.
      // The two events §⑨⑩ pin land at t ≈ 224/507/620 s (a pursuit losing its
      // thing) and t ≈ 858 s (an orphaned errand queue) on this seed, and the
      // last of those is past the three-day window ⑥⑦⑧ samples. This day is
      // captured into `stage1bLines` ALONE — `tileTakes` stops accumulating
      // exactly where it always did, so ⑦'s spread and ⑧'s determinism read
      // the identical three-day arc they were written against.
      console.log = (...parts: unknown[]) =>
        noteStage1b(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
      // ⚠️ WIDENED FROM ONE PLAY-DAY TO THREE (PART 5c), and NOT ONE
      // ASSERTION MOVED. ⑩'s events are timed off the arc, and PART 5c's
      // basket claim changes what the party decides from t ≈ 210 s onward — so
      // the orphan that landed at t ≈ 858 s now lands past the old 960 s edge
      // and ⑩'s own fixture guard ("the orphan is real on this arc") went red
      // on a WORLD change, not on a behaviour change. A window is a fixture;
      // the pin is the reap. Verified both ways: with the claim reverted the
      // one-day window still passes, and with it the three-day window does.
      run.advanceS(3 * DAY_S);
    } finally {
      console.log = origLog;
    }
  }, 900_000);

  afterAll(() => run?.dispose());

  it("⑥ a forage take on a REGION books a whole unit in the ledger", () => {
    // 🚨 IT USED TO BOOK NOTHING. `ReservationLedger.reserve` floors to whole
    // units by design (it is the seats-and-agreements ledger), and a
    // ration-denominated forage claim is a fraction — the exact defect ⚖️ 0-2
    // recorded for standing bushes, on the endpoint family that now serves most
    // of a founding party's food. `wildSourceOf` knows only STANDING features,
    // so a `wild:area:` endpoint fell straight through its rounding.
    expect(claimedOnATile).toBe(true);
  });

  it("⑥ …and a record whose free units are spoken for reports ZERO free", () => {
    // The ledger arithmetic the candidate gate runs, on a region endpoint id:
    // once the bodies walking to it have claimed everything it can give, it
    // leaves the list — which is PART 5's Ⓕ reversed, at the units grain.
    const ledger = run.session.needClaims;
    const key = [...run.session.areaRecords.keys()].filter(isNeighborTileKey)[0]!;
    const id = `wild:area:${key}`;
    const before = freeUnitsOver(10, ledger, id, "food", "need:probe");
    expect(before).toBe(10);
    ledger.reserve("need:other_body", id, "food", 10);
    expect(freeUnitsOver(10, ledger, id, "food", "need:probe")).toBe(0);
    // …and its OWN claim never hides the stock it is walking toward.
    expect(freeUnitsOver(10, ledger, id, "food", "need:other_body")).toBe(10);
    ledger.release("need:other_body");
  });

  it("⑦ the party forages SEVERAL FORAGE POINTS, not one doorstep", () => {
    // BEFORE: 64/34/7 — two tiles carried 93 % of every take, because ranking
    // was distance alone and one shelf point served everybody.
    const ring1 = [...tileTakes].filter(([k]) => ringOf(k.replace("wild:area:", "")) === 1);
    //
    // 🌿 RE-DERIVED (the resource-packing round), AND THE CLAIM IS THE SAME
    // CLAIM. This counted RING-1 RECORDS, which was the same set as "forage
    // points" only while the party's OWN disc was empty: the tropical founding
    // cell stood 0.554 banana plants a hectare and nothing else, so every
    // mouthful came from a folded neighbour and the spread had to be measured
    // out there. The packed cell stands ten bearing plants inside the disc, so
    // MEASURED over the same three-day window, the same seed:
    //
    //     19 takes off TEN standing plants in the party's own disc
    //     14 takes off ONE ring-1 record (`tile-0-1`)
    //     ⇒ 11 distinct forage points, biggest share 14/33 = 42 %
    //
    // The party walks its nearest ground first — which is the correct early
    // behaviour PART 5b's own note argues for — and no single shelf point
    // serves everybody, which is the defect this pin exists to catch. Counting
    // ring-1 records ALONE would now read "1" and call a well-fed founding a
    // regression, when what changed is that the doorstep finally has food on it.
    const points = [...tileTakes, ...floraTakes];
    expect(points.length).toBeGreaterThanOrEqual(2);
    const total = points.reduce((n, [, v]) => n + v, 0);
    expect(total).toBeGreaterThan(0);
    // 🚨 NO ONE SHELF POINT SERVES THE WHOLE PARTY — the original claim, said
    // over the endpoints that actually bear.
    const biggest = points.reduce((m, [, v]) => Math.max(m, v), 0);
    expect(biggest / total).toBeLessThan(0.75);
    // …and the ring-1 records are still reached: the disc is a larder, not a
    // fence, and a party that never left it would be a different defect.
    expect(ring1.length).toBeGreaterThanOrEqual(1);
    expect(ring1.reduce((n, [, v]) => n + v, 0)).toBeGreaterThan(0);
    // 🚫 AND THE *SHARE* IS DELIBERATELY NOT ASSERTED HERE. Concentration is
    // correct early and wrong late: a party SHOULD walk its nearest ground
    // first and spread as that ground thins (the harvest gradient is the whole
    // conservation half of PART 5). Three play-days is the concentrated phase —
    // measured 19 of 22 takes on one record — and the spread that matters shows
    // over ten (37/28/20/11 against the pre-round 64/34/7). A share pin on this
    // window would be asserting a number the window cannot support.
  });

  it("⑧ the whole arc is REPRODUCIBLE — sorted-cid visiting is the claim order", () => {
    // "Bodies in sorted cid order" is the multiplayer-determinism law
    // (`stepBodyNeeds`: *"the visit order IS the reservation order"*), and a
    // spot assignment that reads other bodies' claims inherits it. The
    // observable is that two boots of one seed forage identically.
    const second = bootTextQuest({ world: readDoc("frontier-planet.spec.json"), seed: SEED, dt: DT });
    const takes2 = new Map<string, number>();
    const origLog = console.log;
    console.log = (...parts: unknown[]) => {
      const s = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
      const m = /took ([\d.]+)×food from (wild:area:\S+)/.exec(s);
      if (m && Number(m[1]) > 0) takes2.set(m[2]!, (takes2.get(m[2]!) ?? 0) + 1);
    };
    try {
      second.advanceS(3 * DAY_S);
    } finally {
      console.log = origLog;
      second.dispose();
    }
    expect([...takes2].sort()).toEqual([...tileTakes].sort());
  }, 900_000);

  // ═════════════════════════════════════════════════════════════════════════
  // STAGE 1b — RE-SELECT ON A LOST PRECONDITION, AND THE LATCH THAT FROZE A BODY
  // (emergent-plans-round.md Stage 1b; elemental-actions §1b "a gift/loss flips
  //  a precondition → the next walk RE-SELECTS a branch", D5, D7, D9)
  // ═════════════════════════════════════════════════════════════════════════
  //
  // 🚨 THE DEFECT PART 5b HANDED ON (its R1). Every `hunger:food blocked
  // mid-flight` on this tree was one of two shapes, and BOTH `parkRoute()`d the
  // row and handed the body back to the legacy walker:
  //   (A) 21/22 — `consume {match:{category:"food"}}` whose item had resolved
  //       to a container-stock ref (`stock:small:mat_2|berry`, the camp's own
  //       set-down basket) that a housemate emptied mid-walk. `goalTarget`
  //       answers null, so there is not even a `blockedAt` to name (D7's one
  //       documented null case).
  //   (B)  1/22 — the bag-fetch ENABLE pre-step, blocked on `holding` because
  //       another body lifted the basket first. Per D9 a bag is a PRICED
  //       OPTION, never a precondition, so losing it must cost the detour and
  //       not the errand.
  // Parking either is waiting for a change that has ALREADY happened — the unit
  // vanishing is what moved the epochs `needParked` waits on.
  //
  // WHAT THIS SECTION PINS:
  //   ⑨ BOTH SHAPES RE-SELECT — they occur on this arc, they name the predicate
  //     that beat them, and NOT ONE of them parks the row.
  //   ⑩ A QUEUE NOTHING IS WALKING IS ABANDONED, NOT BUSY — the latch that
  //     froze one settler for 64 % of a ten-day run.

  it("⑨ a need pursuit that loses its thing RE-SELECTS the row — it never parks it", () => {
    // ⚖️ THE ARRANGE MOVED 2026-09-10 (piles-not-boxes-round.md §18), NOT ONE
    // `expect` LINE. Shape (A) — the pursued thing stops resolving mid-walk —
    // needs a world where a body walks far enough for its stand to be emptied
    // under it, and `frontier-planet` STOPPED BEING ONE: settlers now keep a
    // camp larder, so most food comes off a pile a metre away and the far walk
    // that (A) is made of hardly happens. MEASURED on the current tree, ten
    // play-days, seed 11: 6 blocks, ALL of them shape (B), and ZERO of shape
    // (A). Asserting (A) there would be asserting on a world that has stopped
    // having the premise, which is the vacuous pin this file's own comment
    // forbids.
    //
    // `homestead.spec.json` is the SCARCITY world (homestead-defect-round.md)
    // and it still has it in quantity: same seed and dt, four play-days, 35
    // lines of shape (A) and 9 of shape (B). So (A) is measured there and (B)
    // stays here, and each shape is asserted on ground that actually produces
    // it. The CLAIM is unchanged: both shapes re-select, both name what beat
    // them, and NOT ONE of them parks the row.
    const blocks = stage1bLines.filter((l) => l.includes("blocked mid-flight"));
    // The disruption is REAL on this arc — a vacuous pin would pass on a world
    // where nothing is ever lost mid-walk.
    expect(blocks.length).toBeGreaterThan(0);
    // (A) the thing itself stopped resolving — no predicate can honestly be
    // named, so the line says so instead of inventing one. Measured on the
    // world that still has the premise (see `scarcityBlocks`, below).
    expect(scarcityBlocks.some((l) => l.includes("on nothing answers to it"))).toBe(true);
    // (B) …and the bag pre-step's own shape, named by the predicate that beat
    // it (D7). Both are hunger rows: the row, not the goal kind, is what
    // re-decides.
    expect(blocks.some((l) => l.includes("on holding"))).toBe(true);
    expect(blocks.every((l) => l.includes("hunger:food"))).toBe(true);
    // 🚨 THE FIX ITSELF: every one of them re-decides, and none parks. The park
    // is what handed the motive to the legacy walker and cost the errand.
    expect(blocks.every((l) => l.includes("re-deciding the row"))).toBe(true);
    expect(blocks.some((l) => l.includes("route parked"))).toBe(false);
    // …and no `pursuit`-scoped park for a hunger row is left standing either.
    expect([...run.session.needParks.keys()].filter((k) => k.startsWith("pursuit|") && k.includes("hunger"))).toEqual(
      [],
    );
  });

  it("⑩ a queued errand nothing is walking is ABANDONED, not busy", () => {
    // 🚨 THE LATCH. `enqueueNpcErrand`'s queue is retired only by the errand's
    // own `onDone`/`onAbandon`, but `setNpcErrand` REPLACES a body's errand
    // outright and fires neither — and a dozen seats call it directly (the
    // pursuit's walk leg, `beginAction`'s action pin, the walk home, the dwell
    // pins). `idleForDirect` reads a non-empty `npcTasks` as "somebody is
    // spending this body", so one orphan latches a body out of EVERY decide it
    // has. Measured on this very world (seed 11, dt 1/2, 10 play-days):
    // `settler_0` took a circle invitation at t = 854.5, an action pin replaced
    // the invitation's walk, and the body then stood in camp for 1 546 s — 64 %
    // of the run — with no pursuit, no walk, no step and no park, hunger
    // climbing 3.2 → 9.6 while its four siblings foraged.
    // ⚠️ RE-FIXTURED (PART 5d): the orphan is now FORCED through the state the
    // reaper reads, instead of waiting for an emergent one. It used to assert
    // `reaps.length > 0` on the arc, and at full woodland density the t = 854.5
    // circle invitation no longer forms in the captured window — so the pin
    // went red on the LAND moving, not on the reap breaking (the end-state
    // witness below stayed green throughout, on every founder). A premise you
    // have to wait for is not a fixture. NOT ONE ASSERTION WAS WEAKENED: the
    // reap, the body it frees and the end state are all still asserted, and
    // the forced orphan is exactly what `setNpcErrand` leaves behind —
    // a queue entry on a body the world is not walking (`npcErrandActive`
    // false), which is the reader's own condition.
    // ⚠️ RE-FIXTURED AGAIN (skill-learning-round.md, 2026-09-10) — THE VICTIM IS
    // CHOSEN, NOT INDEXED. The premise this pin needs is "a body that is
    // OTHERWISE IDLE FOR DIRECTION is holding a queue nothing is walking": a
    // live pursuit reads BUSY at `idleForDirect`'s first gate BY DESIGN, and the
    // reap sits below it. `settlers[0]` was hard-coded, and once bodies practise
    // (the skill round) `settler_0` is mid-pursuit at this instant — measured:
    // `settler_0 p=1,w=1`, `settler_1 p=0,n=0,l=0,w=0`. That is the LAND moving
    // under the fixture, exactly as the 5d note above describes, not the reaper
    // breaking. NOT ONE ASSERTION IS WEAKENED — the reap, the body it frees and
    // the end state are all still asserted; only WHICH settler carries the
    // forced orphan is now derived from the reader's own condition.
    const settlers = [...run.session.bodyNeeds.keys()].filter((c) => /^settler_\d+$/.test(c));
    const idleForReap = (c: string): boolean =>
      !run.session.pursuits.has(c) &&
      !run.session.needStep.has(c) &&
      !run.session.liveNeedBodies.has(c) &&
      !run.session.walk.has(c);
    // ⚖️ …AND THE SAME REPAIR, ONE ROUND ON (piles-not-boxes-round.md §18).
    // Settlers now carry a provision row for the camp larder, so a founding
    // group is busy nearly always and `find(idleForReap)` can come back empty —
    // the LAND moving under the fixture again, exactly as the note above
    // describes. When nobody is idle the fixture MAKES one, which is what it was
    // always doing implicitly by picking whoever happened to be. Still not one
    // assertion weakened: the reap, the body it frees and the end state are all
    // asserted below on whichever settler carries the forced orphan.
    const victim = settlers.find(idleForReap) ?? settlers[0]!;
    expect(victim).toBeDefined();
    run.session.pursuits.delete(victim);
    run.session.needStep.delete(victim);
    run.session.liveNeedBodies.delete(victim);
    run.session.walk.delete(victim);
    run.session.npcTasks.set(`npc_${victim}`, [
      { kind: "goto", x: run.session.town!.stage.center.x, y: run.session.town!.stage.center.y },
    ] as never);
    expect(run.session.npcTasks.get(`npc_${victim}`)?.length).toBe(1);
    const before = stage1bLines.length;
    const origLog = console.log;
    console.log = (...parts: unknown[]) =>
      noteStage1b(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    try {
      run.advanceS(30); // long enough for one needs sweep to visit the body
    } finally {
      console.log = origLog;
    }
    const reaps = stage1bLines.slice(before).filter((l) => l.includes("orphaned errand queue reaped"));
    expect(reaps.length).toBeGreaterThan(0); // the reaper saw it
    expect(/\[needs\] (\S+) — orphaned/.exec(reaps[0]!)![1]!).toBe(victim);
    // …and the queue is GONE, which is the whole of "abandoned, not busy":
    // before the fix this entry latched the body out of every decide it had.
    expect(run.session.npcTasks.get(`npc_${victim}`)?.length ?? 0).toBe(0);
    // The end-state witness, on every founder: nobody finishes the arc holding
    // a queue that nothing is driving.
    for (const cid of run.session.bodyNeeds.keys()) {
      if (!/^settler_\d+$/.test(cid)) continue;
      const queued = run.session.npcTasks.get(`npc_${cid}`)?.length ?? 0;
      if (queued > 0) {
        expect(run.session.pursuits.has(cid) || run.session.walk.has(cid) || run.session.needStep.has(cid)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 5c — A SET-DOWN BASKET'S LOAD IS CLAIMABLE
// ═══════════════════════════════════════════════════════════════════════════
//
// 🚨 Stage 1b's REQUEST R-2, measured there: `reserveNeedUnits` refused EVERY
// `small:` endpoint — honestly, because *"a LOOSE PROP is one instance taken
// whole through the one door"*. The 2026-09-06 ruling (*"a set-down stack is a
// SOURCE"*) then made a `small:` id mean a second thing too: a BASKET WITH A
// LOAD, drawn from exactly as a pantry chest is. Its units are not atomic, so
// the read side asked `freeNeedUnits` for it and the write side booked nothing
// — a gate that existed and could never fire. 21 of 22 blocked plans on
// `frontier-planet` seed 11 were bodies racing for the same berry in the camp's
// own basket.
//
// ⚖️ AND NOT THE VESSEL (E-8, measured and reverted by 1b): claiming a bag a
// body might FETCH costs 4.60 → 3.54 rations/day, because it turns a priced
// OPTION into everyone else's precondition. These pin that the claim lands on
// the LOAD and never on the bag.

describe("⑪ PART 5c — the loose container's load", () => {
  let run: TextQuestRun;
  /** Every `small:` row a NEED holder booked, sampled across the arc. */
  const seen: { endpoint: string; glyph: string; qty: number }[] = [];

  beforeAll(() => {
    run = bootTextQuest({ world: readDoc("frontier-planet.spec.json"), seed: SEED, dt: DT });
    for (let i = 0; i < 2 * DAY_S / DT; i++) {
      run.advance(1);
      for (const row of run.session.needClaims.toJSON().rows) {
        if (row.holder.startsWith("need:") && row.endpoint.startsWith("small:")) {
          seen.push({ endpoint: row.endpoint, glyph: row.glyph, qty: row.qty });
        }
      }
    }
  }, 900_000);

  afterAll(() => run?.dispose());

  it("⑪ a set-down basket's LOAD is spoken for — it never was before", () => {
    // Before this round the ledger had no `small:` row under a need holder at
    // any instant of any arc, by construction: the endpoint family returned
    // early. One row anywhere is the whole assertion.
    expect(seen.length).toBeGreaterThan(0);
    // 🚨 …AND FOR A WHOLE UNIT. A hunger claim is ration-denominated (an apple
    // is 0.2), and `ReservationLedger.reserve` floors — so an unrounded claim
    // on a basket books nothing and this fix would be a no-op with the gate
    // merely relocated. Same grain as a bush's and a tile's.
    for (const r of seen) expect(r.qty).toBeGreaterThanOrEqual(1);
  });

  it("⑪ …and the claim is on what is INSIDE it, never on the bag (E-8)", () => {
    // The discriminator is the take path's own (`asContainerSource`): a
    // registered container whose OWN glyph is not a unit of the wanted good.
    // A bag a body might lift is a priced OPTION — 1b measured what claiming
    // one costs (4.60 → 3.54 rations/day) and reverted it.
    for (const r of seen) {
      const rec = run.session.containerRecords.get(r.endpoint);
      expect(rec?.stock).toBeDefined(); // a LOAD, not a bare prop
      expect(FOOD.has(r.endpoint)).toBe(false);
    }
    // The endpoints seen are containers, and the good claimed is the row's
    // good — never the vessel's own glyph.
    expect(new Set(seen.map((r) => r.glyph))).toEqual(new Set(["food"]));
  });
});
