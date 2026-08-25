// ⏩ THE MID-SESSION CLOCK WARP (shared/world-engine/interaction/quest/clock-warp.ts)
//
// THE CLAIM UNDER TEST (user, 2026-08-13): *"for a lot of tests, nothing is
// leaving the clock and it is focusing on ledgers, not physics — so the clock
// can probably be sped up significantly."* The town's economic arm is
// closed-form and DAY-EDGE triggered, so N days of books is N day edges, not
// N × 4 800 frames. This file is the proof, in three parts:
//
//   ① THE ENUMERATION, pure. `runLedgerWarp` over a fake arms table: which
//      edges a span crosses, in what order, with the clock parked where. No
//      quest-host, no boot — this half costs nothing.
//   ② THE TWIN DOCTRINE, live. An UNOBSERVED town (`setCrowdBudget(0)` — the
//      orbit rung, where the streamer embodies nobody) warped N days vs the
//      same town TICKED across the same N day edges: the books must be
//      IDENTICAL, term for term.
//   ③ THE GUARD. A live-need body mid-errand refuses the warp outright, and a
//      refusal moves NOTHING — not the clock, not a scalar.
//
// ⚠️ FIVE BOOTS, and every one is load-bearing. A quest-host-importing suite
// pays the ~300-module transform tax plus a dollhouse boot per session (CLAUDE.md
// §Testing), so the count is kept to what the doctrine needs: two identical
// sessions for the twin, two more for the live slicing law (the twins have both
// moved on by then), and one for the guard. Long play arcs still belong in the
// tsx CLI, not here — this file buys ~115 s, of which ~71 s is the TICKED half
// of the twin, i.e. the price of the proof rather than of the feature.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  refuseLedgerWarp,
  runLedgerWarp,
  WARP_BLOCKERS_SHOWN,
  type LedgerWarpArms,
} from "@shared/world-engine/interaction/quest/clock-warp.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import {
  drawWildArea, farmAreaKey, ripenWildArea, wildAreaStock,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import { satiationDaysOf } from "@shared/world-engine/kernel/town/goods-kinds.js";

// ─────────────────────────────────────────────────────────────────────────
// ① THE ENUMERATION — pure, over a recording arms table
// ─────────────────────────────────────────────────────────────────────────

/** A fake clock + arms that records every call, in order. */
function recorder(startClock = 0, dayS = 240) {
  const log: string[] = [];
  let clock = startClock;
  const arms: LedgerWarpArms = {
    dayS,
    clockNow: () => clock,
    setClock: (t) => {
      clock = t;
      log.push(`clock=${t}`);
    },
    dayArm: (d) => log.push(`day=${d}`),
    economySweeps: () => log.push("sweeps"),
    settleLazyClocks: () => log.push("lazy"),
  };
  return { arms, log, clockNow: () => clock };
}

describe("① the bucket enumeration", () => {
  it("🚨 crosses exactly one edge per day, clock PARKED on the edge before the arm runs", () => {
    const r = recorder(0);
    const out = runLedgerWarp(r.arms, 3);
    expect(out.ok).toBe(true);
    expect(out.edges).toBe(3);
    expect(out.from).toBe(0);
    expect(out.to).toBe(720);
    expect(r.log).toEqual([
      // ⚖️ ⑤ the PRIME, at the clock the warp starts from — where a ticked run's
      // first task sweep latches every first-sight edge detector.
      "sweeps",
      "clock=240", "day=1", "sweeps",
      "clock=480", "day=2", "sweeps",
      "clock=720", "day=3", "sweeps",
      // the tail: the span's own last instant, and the sweeps that a leg due
      // between the last edge and it would have fired at.
      "clock=720", "sweeps", "lazy",
    ]);
  });

  it("🚨 ⑤ THE PRIME IS NOT OPTIONAL — the sweeps run at t₀ BEFORE any clock write", () => {
    // The bug this pins, measured: `stepTradeCargo`'s bucket boundary is
    // phase-shifted off the day edge, so a warp that latched `tradeCargoDay` at
    // the first EDGE instead of at t₀ silently skipped one caravan landing —
    // 0.105 book units of granary the export debit never charged. The prime
    // must therefore come before the first `setClock`, always.
    const r = recorder(0);
    runLedgerWarp(r.arms, 2);
    expect(r.log[0]).toBe("sweeps");
    expect(r.log.indexOf("sweeps")).toBeLessThan(r.log.findIndex((l) => l.startsWith("clock=")));
  });

  it("🚨 PHASE IS PRESERVED — a warp from mid-day crosses the same edges a tick would", () => {
    const r = recorder(100);
    const out = runLedgerWarp(r.arms, 7);
    expect(out.edges).toBe(7); // 240 … 1680
    expect(out.to).toBe(100 + 7 * 240);
    expect(r.log.filter((l) => l.startsWith("day="))).toEqual(
      ["day=1", "day=2", "day=3", "day=4", "day=5", "day=6", "day=7"],
    );
    // …and it ends off-edge, exactly where the ticked clock would be.
    expect(r.clockNow()).toBe(1780);
  });

  it("🚨 THE SLICING LAW — one warp of N ≡ N warps of 1 (the boot fast-forward's own law)", () => {
    // `town-play.ts`: "Slicing the fast-forward is exactly equivalent to one
    // big step (the byte-identical test pins it)." The mid-session lever
    // inherits that law or it is not the same lever.
    const one = recorder(37);
    runLedgerWarp(one.arms, 5);
    const sliced = recorder(37);
    for (let i = 0; i < 5; i++) runLedgerWarp(sliced.arms, 1);
    // The sliced run repeats the tail (`clock=<end>`, `sweeps`, `lazy`) per
    // slice; the DAY ARMS and the edges they run at are what must agree, and
    // they do — every edge, once, in order.
    expect(sliced.log.filter((l) => l.startsWith("day="))).toEqual(
      one.log.filter((l) => l.startsWith("day=")),
    );
    expect(sliced.clockNow()).toBe(one.clockNow());
  });

  it("🔒 a clock already ON an edge does not re-run that edge", () => {
    const r = recorder(240);
    runLedgerWarp(r.arms, 1);
    expect(r.log.filter((l) => l.startsWith("day="))).toEqual(["day=2"]);
  });

  it("🔒 zero (and negative, and fractional) days move nothing", () => {
    for (const d of [0, -3, 0.9]) {
      const r = recorder(500);
      const out = runLedgerWarp(r.arms, d);
      expect(out.edges).toBe(0);
      expect(out.to).toBe(500);
      expect(r.log).toEqual([]);
    }
  });

  it("🔒 a refusal is an ANSWER, not an error — same shape, nothing moved", () => {
    const out = refuseLedgerWarp(7, 1234, ["a", "b", "c", "d", "e", "f"]);
    expect(out.ok).toBe(false);
    expect(out.edges).toBe(0);
    expect(out.from).toBe(1234);
    expect(out.to).toBe(1234);
    expect(out.blocked).toBe(6);
    expect(out.blockers).toHaveLength(WARP_BLOCKERS_SHOWN);
    expect(out.note).toContain("and 2 more");
    expect(out.note).toContain("may not complete abstractly");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ②/③ — the live half
// ─────────────────────────────────────────────────────────────────────────

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = () => JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
const SEED = 12;
const DT = 1 / 20;
/** Days the twins are compared over. Each ticked edge costs ~50 frames. */
const SPAN = 5;

/**
 * THE LEDGER, all of it, as one comparable object: the settlement's own scalars
 * (the economy's declared vars plus the structural ring) and the durable drift
 * bank. This is what "the same books" means — everything the closed-form clock
 * arm writes.
 *
 * 🚨 THE COHORT ROSTER IS DELIBERATELY NOT HERE, and its absence is a FINDING,
 * not a convenience — see the "what legitimately diverges" case below. Which
 * households are POOLED is decided by `stepCohortTier`, a per-frame hysteretic
 * LOD sweep that moves ONE house per sweep off camera distance; a warp does not
 * move the camera and does not run frames, so it does not pool. What the cohort
 * arm DOES own — the rows' RATES (`stepCohortDay` → `cohortRatesStep`) — is in
 * the warp, and is pinned separately.
 */
function bookDigest(run: TextQuestRun): unknown {
  const t = run.session.town!;
  const names = [
    "population", "farmland", "ore_access", "timberland", "pasture", "unrest",
    ...t.eco.vars.map((v) => v.name),
  ].sort();
  const scalars: Record<string, number> = {};
  for (const n of names) scalars[n] = Number(t.town.scalar(n).toFixed(9));
  const bank: Record<string, number> = {};
  for (const k of Object.keys(t.deltas.driftBank).sort()) {
    bank[k] = Number((t.deltas.driftBank[k] ?? 0).toFixed(9));
  }
  return {
    day: Math.floor(run.session.townClock / FOOD_DAY_SEC),
    scalars,
    bank,
  };
}

/**
 * An UNOBSERVED town: `setCrowdBudget(0)` is the ORBIT rung — "0 = none
 * (orbit / >~1 km)" — so the streamer embodies nobody and the only thing moving
 * is the books. This is the condition the twin doctrine is stated under, and it
 * is the shipped LOD lever, not a test back door.
 *
 * 🚨 THE 1.5 s IS LOAD-BEARING, AND IT IS ABOUT THE TICKED TWIN, NOT THE WARP.
 * `stepTaskPool` is throttled to `TASK_CLAIM_INTERVAL_S` (1 s), so a session
 * that has run only a frame or two has NOT yet latched its first-sight edge
 * detectors — and the ticked twin below reaches its first edge by POKING the
 * clock, which means its first sweep would latch at day 1's eve instead of at
 * t₀. That is not what any real session does (a live host sweeps within its
 * first second), and it made the ticked twin miss the day-1 caravan the warp
 * correctly landed: a 0.105 granary gap that read as the WARP being wrong when
 * it was the poke that was. Settling one real sweep first makes both twins
 * start where a real session starts. The genuinely frame-ticked comparison
 * needs none of this and agrees byte-for-byte (see clock-warp.ts law ⑤).
 */
function bootUnobserved(): TextQuestRun {
  const run = bootTextQuest({ world: doc(), seed: SEED, dt: DT });
  run.host.setCrowdBudget(0);
  run.advanceS(1.5); // ≥1 task sweep: the budget reaches the stage AND the detectors latch
  return run;
}

describe("② the twin doctrine — a warped span and a ticked span leave the SAME books", () => {
  let warped: TextQuestRun;
  let ticked: TextQuestRun;

  beforeAll(() => {
    warped = bootUnobserved();
    ticked = bootUnobserved();
  });
  afterAll(() => {
    warped?.dispose();
    ticked?.dispose();
  });

  it("🚨 the two sessions START identical (or the comparison below means nothing)", () => {
    expect(bookDigest(warped)).toEqual(bookDigest(ticked));
  });

  it("🚨 …and END identical: N warped days ≡ N ticked day edges, term for term", () => {
    // THE TICKED TWIN drives its clock to the eve of each edge and steps the
    // REAL frame loop across it — `trade-import-channel.test.ts`'s own
    // established pattern ("the clock is driven, not walked"), because walking
    // five dollhouse days is 24 000 frames. Every day arm and every ledger
    // sweep therefore runs through the ordinary `onFrame` / `stepTaskPool`
    // path; only the empty middle of each day is skipped, and nothing in the
    // engine's clock arm reads it.
    const day0 = Math.floor(ticked.session.townClock / FOOD_DAY_SEC);
    for (let d = day0 + 1; d <= day0 + SPAN; d++) {
      ticked.session.townClock = d * FOOD_DAY_SEC - 0.4;
      ticked.session.taskClock = d * FOOD_DAY_SEC - 0.4;
      ticked.advanceS(2.5); // ≥1 task sweep lands after the crossing (throttle = 1 s)
    }
    const r = warped.host.advanceLedgerDays(SPAN);
    expect(r.ok).toBe(true);
    expect(r.edges).toBe(SPAN);
    // Land the warped twin's clock on the ticked twin's, so `day` matches and
    // any remaining difference is a difference in the BOOKS.
    warped.session.townClock = ticked.session.townClock;

    expect(bookDigest(warped)).toEqual(bookDigest(ticked));
  });

  it("🚨 CONSERVATION: a warp mints nothing and loses nothing — except the days' eating", () => {
    // The session stock audit is the repo's standing conservation probe (the
    // same reading the S4 fold has to keep identical across an LOD transition).
    // EVOLVED by the food-scale E-round: the town's FIELD REGION is audited
    // stock now, and each crossed day's modelled consumption leaves it (eaten
    // food — the one legal sink; `stepFarmSource`). Everything else stays
    // byte-identical, and the expected carrot line is computed by the PURE
    // TWIN of the sweep's own arms (law ⑤'s pattern): ripen + draw at exactly
    // the clocks the warp's sweeps run — prime at t₀, each edge, the landing.
    const t = warped.session.town!;
    const key = farmAreaKey(t.plan.key);
    const before = warped.host.stockAudit();
    let rec = warped.session.wildAreas.get(key)!;
    expect(rec).toBeDefined();
    const pop = t.town.scalar("population");
    const seated = t.plan.popCap > 0 ? Math.min(pop, t.plan.popCap) : pop;
    const perDay = Math.max(0, Math.round(seated / satiationDaysOf("carrot")));
    const t0 = warped.session.taskClock;
    const day0 = Math.floor(warped.session.townClock / FOOD_DAY_SEC);
    const startStock = wildAreaStock(rec).carrot ?? 0;
    const sweepAt = (clock: number, draws: boolean): void => {
      rec = ripenWildArea(rec, clock, () => FOOD_DAY_SEC);
      if (draws && perDay > 0) {
        rec = drawWildArea(rec, { glyph: "carrot", units: perDay, now: clock }).rec;
      }
    };
    sweepAt(t0, false); // the warp PRIMES before it jumps (law ⑤)
    for (let d = 1; d <= 3; d++) sweepAt((day0 + d) * FOOD_DAY_SEC, true);
    sweepAt(t0 + 3 * FOOD_DAY_SEC, false); // the landing sweep, same day as edge 3
    const expectedCarrot = (before.carrot ?? 0) + (wildAreaStock(rec).carrot ?? 0) - startStock;

    const r = warped.host.advanceLedgerDays(3);
    expect(r.ok).toBe(true);
    expect(warped.host.stockAudit()).toEqual({ ...before, carrot: expectedCarrot });
  });

  it("🔒 THE SLICING LAW, live: warp(N) leaves the same books as N × warp(1)", () => {
    // A FRESH PAIR: the law is about two sessions that started identical, and
    // the twins above have both moved on. Disposed immediately.
    const big = bootUnobserved();
    const slices = bootUnobserved();
    try {
      expect(big.host.advanceLedgerDays(4).edges).toBe(4);
      for (let i = 0; i < 4; i++) expect(slices.host.advanceLedgerDays(1).edges).toBe(1);
      expect(bookDigest(slices)).toEqual(bookDigest(big));
    } finally {
      big.dispose();
      slices.dispose();
    }
  });

  /**
   * 🚨 WHAT LEGITIMATELY DIVERGES, RECORDED RATHER THAN PAPERED OVER.
   *
   * The COHORT ROSTER — which households are pooled into a district statistic
   * and which are tracked individually — is written by `stepCohortTier`, a
   * per-frame hysteretic sweep that moves at most ONE house per
   * `COHORT_SWEEP_S` and scores candidates by distance from the CAMERA. It is
   * an LOD decision, not a day arm: a warp runs no frames and moves no camera,
   * so it pools nobody. The ticked twin, having run ~250 frames, has pooled a
   * handful.
   *
   * This is the honest shape of the lever, not a hole in it: a warp buys DAYS
   * OF BOOKS, and the streaming tier is bought with FRAMES. A consumer that
   * needs a settled roster must tick for it — and would have had to before the
   * warp existed too.
   */
  it("🚨 the COHORT ROSTER is frames, not days — and so a warp does not move it", () => {
    const cohortsOf = (r: TextQuestRun) => (r.session.town!.deltas.cohorts ?? []).length;
    // The ticked twin pooled while it stepped; the warped twin never did.
    expect(cohortsOf(ticked)).toBeGreaterThan(0);
    expect(cohortsOf(warped)).toBe(0);
    // …but the RATES arm of the cohort book IS a day arm, and the warp runs it:
    // every row the ticked twin holds is integrated up to today.
    const day = Math.floor(ticked.session.townClock / FOOD_DAY_SEC);
    const before = ticked.session.town!.deltas.cohorts!.map((c) => c.ratesDay);
    expect(before.every((d) => d === day)).toBe(true);
    const r = ticked.host.advanceLedgerDays(3);
    expect(r.ok).toBe(true);
    for (const c of ticked.session.town!.deltas.cohorts!) expect(c.ratesDay).toBe(day + 3);
  });
});

describe("③ the guard — an errand the clock owns is never jumped past", () => {
  let run: TextQuestRun;
  beforeAll(() => {
    run = bootUnobserved();
  });
  afterAll(() => run?.dispose());

  it("🚨 a LIVE-NEED body mid-errand refuses the warp, and NOTHING moves", () => {
    const clock = run.session.townClock;
    const before = bookDigest(run);
    run.session.liveNeedBodies.add("resident_7_0");
    const r = run.host.advanceLedgerDays(9);
    expect(r.ok).toBe(false);
    expect(r.blockers).toContain("resident_7_0");
    expect(r.edges).toBe(0);
    expect(run.session.townClock).toBe(clock);
    expect(bookDigest(run)).toEqual(before);
  });

  it("🔒 …and the moment it is done, the same warp is legal again", () => {
    run.session.liveNeedBodies.delete("resident_7_0");
    const r = run.host.advanceLedgerDays(2);
    expect(r.ok).toBe(true);
    expect(r.edges).toBe(2);
  });
});
