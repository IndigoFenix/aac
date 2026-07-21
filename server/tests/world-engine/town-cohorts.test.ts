// PER-DISTRICT COHORTS (city-expansion ④) at the pure layer — the exact
// pieces quest-host wires: district mapping over zone charters (the ③ ords;
// unzoned = ONE default district), household demotion/promotion that
// CONSERVES totals, the hysteretic transition planner (no flapping at the
// boundary), idle-safe rate integration on the town-day clock, the pool as
// a real ② StockEndpoint, and serialization riding SerializedTownDeltas.
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { createTownDeltas } from "@shared/world-engine/kernel/town/construction.js";
import type { ZoneCharter } from "@shared/world-engine/kernel/town/zoning.js";
import {
  COHORT_SWAP_MARGIN,
  DEFAULT_DISTRICT,
  TRACKED_RESIDENTS_DEFAULT,
  cohortEndpoint,
  cohortEndpointId,
  cohortPopulation,
  cohortRatesStep,
  cohortTotals,
  cohortWalkerCount,
  cohortWalkerSpots,
  demoteHousehold,
  districtOfPoint,
  emptyCohortRow,
  parseCohortEndpointId,
  planCohortTransition,
  pooledHouseIndices,
  promoteHousehold,
  type CohortHouseCandidate,
  type CohortRow,
} from "@shared/world-engine/kernel/town/population.js";
import {
  createTransferLedger,
  runDueTransfers,
  transferStock,
  type StockEndpoint,
} from "@shared/world-engine/kernel/town/transfer.js";

const charter = (ord: number, x: number, y: number, r: number, category: string | null): ZoneCharter =>
  ({ ord, x, y, r, category, issuer: "i_me" });

describe("district mapping — zoneAt governance", () => {
  it("unzoned ground is ONE default district", () => {
    expect(districtOfPoint([], 5, 5)).toBe(DEFAULT_DISTRICT);
  });

  it("the governing charter's ord IS the district id", () => {
    const zones = [charter(0, 0, 0, 10, "farm"), charter(1, 30, 0, 10, "craft")];
    expect(districtOfPoint(zones, 2, 2)).toBe(0);
    expect(districtOfPoint(zones, 30, 0)).toBe(1);
    expect(districtOfPoint(zones, 100, 100)).toBe(DEFAULT_DISTRICT);
  });

  it("later charters paint over (the ③ overlap rule), clearing reads default", () => {
    const zones = [
      charter(0, 0, 0, 10, "farm"),
      charter(1, 0, 0, 6, "craft"), // painted over the center
      charter(2, 0, 0, 3, null), // cleared at the bullseye
    ];
    expect(districtOfPoint(zones, 8, 0)).toBe(0); // farm ring
    expect(districtOfPoint(zones, 5, 0)).toBe(1); // craft ring
    expect(districtOfPoint(zones, 0, 0)).toBe(DEFAULT_DISTRICT); // cleared
  });
});

describe("demote/promote — conservation of totals", () => {
  it("a demoted household's souls and carried stacks land in the pool", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 3, { index: 7, members: 5 }, { food: 2, "wood.wet": 1 }, 0.6);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ district: 3, pop: 5 });
    expect(rows[0]!.stack).toEqual({ food: 2, "wood.wet": 1 });
    expect(pooledHouseIndices(rows).has(7)).toBe(true);
  });

  it("promotion returns exactly the pooled members; the stack stays district property", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 3, { index: 7, members: 5 }, { food: 2 }, 0.6);
    const out = promoteHousehold(rows, 7);
    expect(out).toEqual({ district: 3, house: { index: 7, members: 5 } });
    // The row survives while its stack holds units — nothing vanished.
    expect(cohortTotals(rows)).toEqual({ pop: 0, stack: { food: 2 } });
    expect(pooledHouseIndices(rows).size).toBe(0);
  });

  it("totals are conserved across repeated demote/promote cycles", () => {
    const rows: CohortRow[] = [];
    const before = { pop: 0, carried: 4 };
    demoteHousehold(rows, DEFAULT_DISTRICT, { index: 0, members: 5 }, { food: 4 }, 0.7);
    demoteHousehold(rows, 2, { index: 1, members: 4 }, {}, 0.5);
    for (let cycle = 0; cycle < 3; cycle++) {
      promoteHousehold(rows, 0);
      demoteHousehold(rows, DEFAULT_DISTRICT, { index: 0, members: 5 }, {}, 0.7);
      promoteHousehold(rows, 1);
      demoteHousehold(rows, 2, { index: 1, members: 4 }, {}, 0.5);
    }
    const totals = cohortTotals(rows);
    expect(totals.pop).toBe(9);
    expect(totals.stack).toEqual({ food: before.carried });
    expect(cohortPopulation(rows)).toBe(9);
  });

  it("wellbeing pools member-weighted", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 0, { index: 0, members: 5 }, {}, 1.0);
    demoteHousehold(rows, 0, { index: 1, members: 5 }, {}, 0.0);
    expect(rows[0]!.wellbeing).toBeCloseTo(0.5, 9);
  });

  it("a fully-drained row is dropped; promoting an untracked house is a no-op", () => {
    const rows: CohortRow[] = [];
    demoteHousehold(rows, 1, { index: 4, members: 5 }, {}, 0.7);
    expect(promoteHousehold(rows, 4)).not.toBeNull();
    expect(rows).toHaveLength(0);
    expect(promoteHousehold(rows, 4)).toBeNull();
  });
});

describe("planCohortTransition — hysteresis, no flapping", () => {
  const cand = (over: Partial<CohortHouseCandidate> & { index: number }): CohortHouseCandidate => ({
    members: 5,
    score: 0,
    pooled: false,
    ...over,
  });

  it("is STRICTLY DORMANT below the cap with no pools", () => {
    const houses = [cand({ index: 0, score: -10 }), cand({ index: 1, score: -900 })];
    expect(planCohortTransition(TRACKED_RESIDENTS_DEFAULT, houses)).toBeNull();
  });

  it("over the cap, demotes the worst-scored UNPINNED house", () => {
    const houses = [
      cand({ index: 0, score: -10, pinned: true }),
      cand({ index: 1, score: -500 }),
      cand({ index: 2, score: -900, pinned: true }), // pinned survives even at the bottom
      cand({ index: 3, score: -200 }),
    ];
    expect(planCohortTransition(15, houses)).toEqual({ kind: "demote", index: 1 });
  });

  it("promotes into free room, best score first", () => {
    const houses = [
      cand({ index: 0, score: -10 }),
      cand({ index: 1, score: -50, pooled: true }),
      cand({ index: 2, score: -20, pooled: true }),
    ];
    expect(planCohortTransition(15, houses)).toEqual({ kind: "promote", index: 2 });
  });

  it("swaps ONLY past the margin — and the swap cannot flap back", () => {
    const tracked = cand({ index: 0, score: -100 });
    const pooled = cand({ index: 1, score: -100 + COHORT_SWAP_MARGIN, pooled: true });
    // AT the margin: no swap (the hysteresis band holds).
    expect(planCohortTransition(5, [tracked, pooled])).toBeNull();
    // Past it: swap.
    const closer = cand({ index: 1, score: -100 + COHORT_SWAP_MARGIN + 1, pooled: true });
    expect(planCohortTransition(5, [tracked, closer])).toEqual({ kind: "swap", demote: 0, promote: 1 });
    // After the swap the pair CANNOT trade back — the gap points the other way.
    const after = [
      cand({ index: 0, score: -100, pooled: true }),
      cand({ index: 1, score: -100 + COHORT_SWAP_MARGIN + 1 }),
    ];
    expect(planCohortTransition(5, after)).toBeNull();
  });

  it("is deterministic on ties (higher index demotes first, lower promotes first)", () => {
    const houses = [
      cand({ index: 2, score: -100 }),
      cand({ index: 5, score: -100 }),
    ];
    expect(planCohortTransition(5, houses)).toEqual({ kind: "demote", index: 5 });
    const pools = [
      cand({ index: 0, score: 0, pooled: true }),
      cand({ index: 3, score: 0, pooled: true }),
      cand({ index: 9, score: 0, pooled: true }),
    ];
    expect(planCohortTransition(5, pools)).toEqual({ kind: "promote", index: 0 });
  });
});

describe("cohortRatesStep — idle-safe integration on the day clock", () => {
  const rates = { production: { food: 10 }, perCapita: { food: 1 } };

  it("one 5-day catch-up moves the same stock as five 1-day steps", () => {
    const a = emptyCohortRow(0);
    a.pop = 8;
    a.stack.food = 20;
    const b = JSON.parse(JSON.stringify(a)) as CohortRow;
    cohortRatesStep(a, 5, rates);
    for (let d = 1; d <= 5; d++) cohortRatesStep(b, d, rates);
    expect(a.stack).toEqual(b.stack);
    expect(a.needs).toEqual(b.needs);
    expect(a.ratesDay).toBe(5);
  });

  it("plenty feeds (needs 1, wellbeing rises); famine starves (needs fall, wellbeing sinks)", () => {
    const fed = emptyCohortRow(0);
    fed.pop = 5;
    fed.stack.food = 100;
    cohortRatesStep(fed, 3, rates);
    expect(fed.needs.food).toBe(1);
    expect(fed.wellbeing).toBeGreaterThan(0.75);

    const starved = emptyCohortRow(0);
    starved.pop = 50; // eats 50/day against 10/day production, no reserve
    cohortRatesStep(starved, 3, { production: { food: 10 }, perCapita: { food: 1 } });
    expect(starved.needs.food!).toBeLessThan(0.5);
    expect(starved.wellbeing).toBeLessThan(0.75);
  });

  it("facted variants pay toward their head (wood.wet feeds a wood need)", () => {
    const row = emptyCohortRow(0);
    row.pop = 2;
    row.stack["food.dry"] = 10;
    cohortRatesStep(row, 1, { production: {}, perCapita: { food: 1 } });
    expect(row.needs.food).toBe(1);
    expect(row.stack["food.dry"]).toBeCloseTo(8, 9);
  });

  it("the stack cap trims the pool (surplus flows off abstractly)", () => {
    const row = emptyCohortRow(0);
    row.pop = 1;
    cohortRatesStep(row, 1, { production: { food: 100 }, perCapita: { food: 1 }, stackCap: { food: 6 } });
    expect(row.stack.food).toBeCloseTo(6, 9);
  });

  it("a stale day is a no-op (the clock never runs backward)", () => {
    const row = emptyCohortRow(0, 4);
    row.pop = 3;
    row.stack.food = 9;
    cohortRatesStep(row, 2, rates);
    expect(row.stack.food).toBe(9);
    expect(row.ratesDay).toBe(4);
  });
});

describe("the pool as a ② StockEndpoint", () => {
  it("endpoint id round-trips, including the default district", () => {
    expect(parseCohortEndpointId(cohortEndpointId(3))).toBe(3);
    expect(parseCohortEndpointId(cohortEndpointId(DEFAULT_DISTRICT))).toBe(DEFAULT_DISTRICT);
    expect(parseCohortEndpointId("town:yard")).toBeNull();
    expect(parseCohortEndpointId("cohort:x")).toBeNull();
  });

  it("the endpoint stack ALIASES the row (one-container law)", () => {
    const row = emptyCohortRow(2);
    const ep = cohortEndpoint(row, { x: 10, y: 10 });
    ep.stack.food = 5;
    expect(row.stack.food).toBe(5);
    expect(ep.kind).toBe("cohort");
  });

  it("transfers to and from the pool conserve", () => {
    const row = emptyCohortRow(2);
    const pool = cohortEndpoint(row, { x: 0, y: 0 });
    const yard: StockEndpoint = { id: "town:yard", kind: "yard", stack: { wood: 6 } };
    transferStock(yard, pool, { wood: 4 });
    expect(yard.stack.wood).toBe(2);
    expect(row.stack.wood).toBe(4);
    transferStock(pool, yard, { wood: 1 });
    expect(yard.stack.wood).toBe(3);
    expect(row.stack.wood).toBe(3);
  });

  it("a standing agreement's scheduled leg reaches the pool (runDueTransfers)", () => {
    const row = emptyCohortRow(0);
    const yardStack = { food: 10 };
    const resolve = (id: string): StockEndpoint | null => {
      if (id === "town:yard") return { id, kind: "yard", stack: yardStack };
      return parseCohortEndpointId(id) === 0 ? cohortEndpoint(row, { x: 0, y: 0 }) : null;
    };
    const ledger = createTransferLedger();
    ledger.post({
      from: "town:yard", to: cohortEndpointId(0), goods: { food: 3 },
      issuer: "i_me", mode: "scheduled", every: 10, now: 0,
    });
    const reports = runDueTransfers(ledger, resolve, 10);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.moved).toEqual({ food: 3 });
    expect(row.stack.food).toBe(3);
    expect(yardStack.food).toBe(7);
  });
});

describe("serialization — cohorts ride SerializedTownDeltas", () => {
  it("round-trips through toJSON → createTownDeltas, deep-copied", () => {
    const deltas = createTownDeltas();
    demoteHousehold(deltas.cohorts, 1, { index: 6, members: 5 }, { food: 2 }, 0.6, 3);
    const json = deltas.toJSON();
    expect(json.cohorts).toHaveLength(1);
    // The JSON is a snapshot, never an alias.
    json.cohorts![0]!.stack.food = 999;
    expect(deltas.cohorts[0]!.stack.food).toBe(2);
    const revived = createTownDeltas(deltas.toJSON());
    expect(revived.cohorts).toEqual(deltas.cohorts);
    expect(revived.toJSON()).toEqual(deltas.toJSON());
  });

  it("an empty store serializes an empty pool list (and revives dormant)", () => {
    const deltas = createTownDeltas();
    expect(deltas.toJSON().cohorts).toEqual([]);
    expect(createTownDeltas(deltas.toJSON()).cohorts).toEqual([]);
  });
});

describe("the resident model skips pooled houses (stage seam)", () => {
  it("a pooled house streams no bodies; tracked houses stream exactly as before", async () => {
    const { buildTownPlay } = await import(
      "@shared/world-engine/interaction/town/town-play.js"
    );
    const config = { seed: 5, days: 10, questCount: 0, key: "smalltown", startPop: 20 };
    const baseline = buildTownPlay(config);
    const center = baseline.stage.center;
    const f0 = baseline.stage.frame(center, 0);
    const spawnedHouses = new Set(
      f0.add.map((n) => Number(n.id.split("_")[1])).filter((n) => Number.isFinite(n)),
    );
    expect(spawnedHouses.size).toBeGreaterThan(0);
    const pooledHouse = [...spawnedHouses][0]!;

    const pooled = buildTownPlay(config); // deterministic twin
    const f1 = pooled.stage.frame(
      center, 0, undefined, undefined, undefined, undefined,
      (hi) => hi === pooledHouse,
    );
    // Nobody from the pooled house...
    expect(f1.add.some((n) => n.id.startsWith(`resident_${pooledHouse}_`))).toBe(false);
    // ...while every OTHER house that streamed in the baseline still streams.
    const others = new Set(
      f1.add.map((n) => Number(n.id.split("_")[1])).filter((n) => Number.isFinite(n)),
    );
    for (const h of spawnedHouses) {
      if (h !== pooledHouse) expect(others.has(h)).toBe(true);
    }
  });

  it("no predicate = byte-identical streaming (the dormancy guarantee)", async () => {
    const { buildTownPlay } = await import(
      "@shared/world-engine/interaction/town/town-play.js"
    );
    const config = { seed: 5, days: 10, questCount: 0, key: "smalltown", startPop: 20 };
    const a = buildTownPlay(config);
    const b = buildTownPlay(config);
    const fa = a.stage.frame(a.stage.center, 0);
    const fb = b.stage.frame(b.stage.center, 0, undefined, undefined, undefined, undefined, () => false);
    expect(fb.add).toEqual(fa.add);
    expect(fb.errands).toEqual(fa.errands);
  });
});

describe("sampled walkers — deterministic, cosmetic-only", () => {
  it("counts scale with the pool, capped small", () => {
    expect(cohortWalkerCount(0)).toBe(0);
    expect(cohortWalkerCount(5)).toBe(1);
    expect(cohortWalkerCount(25)).toBe(3);
    expect(cohortWalkerCount(500)).toBe(3);
  });

  it("spots hash off (seed, day, district) — replay-identical, new day new deal", () => {
    const anchor = { x: 100, y: 100, r: 20 };
    const a = cohortWalkerSpots(7, 3, 1, anchor, 3);
    expect(cohortWalkerSpots(7, 3, 1, anchor, 3)).toEqual(a);
    expect(cohortWalkerSpots(7, 4, 1, anchor, 3)).not.toEqual(a);
    for (const s of a) {
      expect(Math.hypot(s.x - anchor.x, s.y - anchor.y)).toBeLessThanOrEqual(anchor.r);
    }
  });
});
