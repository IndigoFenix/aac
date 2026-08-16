// STEP ④, PASS 5 — ⑥ SOURCE/EXCHANGE PRICING AT THE TOWN RUNG
// (planning-docs/games/world-engine/scope-behaviors.md §2.2 SOURCE, §2.7 EXCHANGE, §3, §4.7,
//  §7 step 6).
//
// The chapter's indictment of what stood here, verbatim:
//   · SOURCE — "Town: nearest-first with lexicographic ties, IMPLEMENTED THREE
//     TIMES (`planTransferSources`, `resolveMaterials`, `requestPiece`) — and
//     inconsistently: construction uses crow-flies `hypot` while shopping
//     (`sourceOf`) and district deficits use `roadDistance`."
//   · EXCHANGE — "a partner 3 km away and one next door quote identically";
//     "what the town's own EXCHANGE lacks (distance-blind quotes, the flat
//     `BARTER_LEG_DAY_FRAC` leg time) is §2.2's pricing".
//   · §4.7 — "`rarePerVisit`'s 900/1600 m breakpoints — the two literals that
//     should be `carryReachM`; and `civicRecruitRadius`'s literal-plus-
//     geometry, which should be scale-derived like `serviceRadiusM`."
//
// What this file pins:
//  ① THE COMPAT PROOF for the one priced walk: with equal terms the priced
//     order IS the shipped nearest-first order, candidate for candidate — and
//     the seat is real, because a per-source term moves it.
//  ② the ordering seam through all three former copies (`planTransferSources`,
//     `resolveMaterials`, and the `rankPricedSources` call that replaced
//     `requestPiece`'s inline sort), with the RESERVATION LIFECYCLE untouched.
//  ③ every DERIVED CONSTANT, old literal beside new derivation, at the SHIPPED
//     street profile and at REAL_SCALE — pacing changes pinned, not smuggled.
//  ④ `releaseEpoch`, the ledger's additive wake signal.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import {
  planTransferSources,
  rankPricedSources,
  sourceCostS,
  stackUnits,
  type TransferSource,
} from "@shared/world-engine/kernel/town/transfer.js";
import {
  createReservationLedger,
  freeUnits,
  resolveMaterials,
} from "@shared/world-engine/kernel/town/reservations.js";
import {
  AWAY_DISTANCE_M,
  RARE_IMPORT_KIND,
  RARE_MAX_PER_VISIT,
  RARE_PORTER_BULK,
  TRADE_DWELL_SEC,
  rarePerVisit,
} from "@shared/world-engine/kernel/town/trade.js";
import {
  BARTER_LEG_DAY_FRAC,
  barterLegSeconds,
} from "@shared/world-engine/kernel/town/barter.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import { carryReachM, freightOf } from "@shared/world-engine/freight.js";
import {
  DOLLHOUSE_SCALE,
  ERRAND_WALK_MPS,
  REAL_SCALE,
  TRANSACTION_DAY_FRAC_DEFAULT,
  dailyTravelM,
  serviceRadiusM,
  transactionDayFrac,
} from "@shared/world-engine/scale.js";

const src = (id: string, d: number, stack: Record<string, number> = { wood: 5 }): TransferSource => ({
  id,
  stack,
  d,
});

/** THE SHIPPED SORT, verbatim from before this pass — the thing the priced
 *  walk has to reproduce. Kept as the oracle, not as a description of it. */
function shippedNearestFirst(sources: readonly TransferSource[], glyph: string): TransferSource[] {
  return [...sources]
    .filter((s) => stackUnits(s.stack, glyph) > 0)
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ═══ ① THE COMPAT PROOF ═══════════════════════════════════════════════════

describe("⚖️ SOURCE — one priced walk, and nearest-first is its special case", () => {
  // A deterministic spread of distances, several exact ties, ids deliberately
  // out of distance order so a stable-sort accident can't pass for a tie-break.
  const TABLE: TransferSource[] = [
    src("zulu", 12),
    src("alpha", 12), // exact tie with zulu — the lexicographic rule
    src("mike", 0), // at the destination
    src("bravo", 41.5),
    src("kilo", 3.25),
    src("echo", 41.5), // second exact tie, further out
    src("delta", 7),
    src("golf", 120.75),
  ];

  it("🔒 EQUAL TERMS ⇒ BYTE-IDENTICAL ORDER — the whole compat argument", () => {
    // `cost = d / speed + hands` is strictly monotone increasing in `d` for a
    // fixed positive speed, so ordering by cost IS ordering by distance; the
    // tie-break is the same lexicographic id. Every shipped caller passes equal
    // terms, so every shipped ordering is unchanged.
    const priced = rankPricedSources(TABLE, (s) => stackUnits(s.stack, "wood")).map((s) => s.id);
    expect(priced).toEqual(shippedNearestFirst(TABLE, "wood").map((s) => s.id));
    expect(priced).toEqual([
      "mike", "kilo", "delta", "alpha", "zulu", "bravo", "echo", "golf",
    ]);
  });

  it("empty sources drop out exactly as they did (the filter is the caller's)", () => {
    const mixed = [...TABLE, src("hotel", 1, {}), src("india", 1, { stone: 4 })];
    expect(rankPricedSources(mixed, (s) => stackUnits(s.stack, "wood")).map((s) => s.id)).toEqual(
      shippedNearestFirst(mixed, "wood").map((s) => s.id),
    );
    // …and the same list ranked for STONE sees only the stone holder.
    expect(rankPricedSources(mixed, (s) => stackUnits(s.stack, "stone")).map((s) => s.id)).toEqual([
      "india",
    ]);
  });

  it("deterministic — the same input replays identically, twenty times", () => {
    const once = rankPricedSources(TABLE, (s) => stackUnits(s.stack, "wood")).map((s) => s.id);
    for (let i = 0; i < 20; i++) {
      expect(rankPricedSources(TABLE, (s) => stackUnits(s.stack, "wood")).map((s) => s.id)).toEqual(
        once,
      );
    }
  });

  it("the key really is hand-seconds: journey at the errand pace, plus the dwell", () => {
    expect(sourceCostS(src("a", 16))).toBeCloseTo(16 / ERRAND_WALK_MPS, 9);
    expect(sourceCostS(src("a", 16), { loadDwellS: 20 })).toBeCloseTo(16 / ERRAND_WALK_MPS + 20, 9);
    // A dwell equal across the walk cancels — which is exactly why seating it
    // changed no shipped order.
    const withDwell = rankPricedSources(TABLE, () => 1, { loadDwellS: 20 }).map((s) => s.id);
    expect(withDwell).toEqual(rankPricedSources(TABLE, () => 1).map((s) => s.id));
  });

  it("🚨 THE SEAT IS REAL — a per-source term moves the order distance cannot", () => {
    // The nearer chest is up a hill the cart crawls: 10 m at 0.4 m/s (25 s)
    // loses to 30 m at 1.6 m/s (18.75 s). Nearest-first could never say this.
    const hill = [src("near_uphill", 10), src("far_flat", 30)];
    expect(rankPricedSources(hill, () => 1).map((s) => s.id)).toEqual(["near_uphill", "far_flat"]);
    expect(
      rankPricedSources(hill, () => 1, {
        perSource: (s) => (s.id === "near_uphill" ? { speedMps: 0.4 } : undefined),
      }).map((s) => s.id),
    ).toEqual(["far_flat", "near_uphill"]);
  });

  it("an UNREACHABLE candidate ties instead of poisoning the comparator", () => {
    // `journeyTimeS(d, 0)` is +Infinity; the old `a.d − b.d` comparator would
    // have produced NaN for two of them and left the order undefined.
    const stuck = rankPricedSources([src("b", 5), src("a", 5), src("c", 1)], () => 1, {
      speedMps: 0,
    }).map((s) => s.id);
    expect(stuck).toEqual(["a", "b", "c"]); // all ∞ ⇒ pure id order, deterministic
  });
});

// ═══ ② THE THREE FORMER COPIES ════════════════════════════════════════════

describe("⚖️ all three source walks route through the one function", () => {
  const SOURCES: TransferSource[] = [
    src("yard", 30, { wood: 4 }),
    src("chest", 8, { wood: 2 }),
    src("crate", 8, { wood: 3 }), // ties with chest — "chest" wins lexicographically
  ];

  it("planTransferSources: greedy drain + shortfall contract, unchanged", () => {
    const plan = planTransferSources(SOURCES, "wood", 6);
    expect(plan).toEqual({
      draws: [
        { id: "chest", take: 2 },
        { id: "crate", take: 3 },
        { id: "yard", take: 1 },
      ],
      shortfall: 0,
    });
    expect(planTransferSources(SOURCES, "wood", 20).shortfall).toBe(11);
  });

  it("resolveMaterials: same ORDER, and the reservation lifecycle untouched", () => {
    const ledger = createReservationLedger();
    const { draws, shortfall } = resolveMaterials({
      holder: "job:1",
      costs: { wood: 6 },
      sources: SOURCES,
      ledger,
    });
    expect(draws).toEqual([
      { endpoint: "chest", glyph: "wood", take: 2 },
      { endpoint: "crate", glyph: "wood", take: 3 },
      { endpoint: "yard", glyph: "wood", take: 1 },
    ]);
    expect(shortfall).toEqual({});
    // …and every draw is spoken for under the holder, nothing else moved.
    expect(ledger.reservedUnits("chest", "wood")).toBe(2);
    expect(ledger.reservedUnits("yard", "wood")).toBe(1);
    expect(freeUnits(SOURCES[1]!.stack, ledger, "chest", "wood")).toBe(0);
    expect(SOURCES[1]!.stack).toEqual({ wood: 2 }); // intents, not escrow
    ledger.release("job:1");
    expect(ledger.reservedUnits("chest", "wood")).toBe(0);
  });

  it("resolveMaterials draws only FREE units, in priced order, as it always did", () => {
    const ledger = createReservationLedger();
    ledger.reserve("someone-else", "chest", "wood", 2); // the near chest is spoken for
    const { draws } = resolveMaterials({
      holder: "job:2",
      costs: { wood: 4 },
      sources: SOURCES,
      ledger,
    });
    expect(draws).toEqual([
      { endpoint: "crate", glyph: "wood", take: 3 },
      { endpoint: "yard", glyph: "wood", take: 1 },
    ]);
  });

  it("requestPiece's retired inline sort: the same walk with its own units test", () => {
    // The director now asks `rankPricedSources(sources, s => s.stack[glyph] ?? 0)[0]`
    // — an EXACT-glyph test (a `furn.bed` is not a `furn` head), which is the
    // one thing that copy legitimately did differently.
    const shelves = [
      src("far", 40, { "furn.bed": 1 }),
      src("near", 4, { "furn.chair": 1 }),
      src("mid", 20, { "furn.bed": 1 }),
    ];
    expect(rankPricedSources(shelves, (s) => s.stack["furn.bed"] ?? 0)[0]!.id).toBe("mid");
  });
});

// ═══ ③ THE DERIVED CONSTANTS — old literal beside new derivation ══════════

describe("⚖️ rarePerVisit — the 900/1600 literals become carryReachM", () => {
  // OLD: `d <= 900 ? 3 : d <= 1600 ? 2 : 1` — two street-scale metres wearing
  // no scale at all.
  // NEW: the road measured against the treat's OWN one-porter carry reach, one
  // unit lost per 1/RARE_MAX_PER_VISIT of it.
  const reachStreet = carryReachM(DOLLHOUSE_SCALE, freightOf(RARE_IMPORT_KIND), "land", undefined, {
    payloadBulk: RARE_PORTER_BULK,
  });

  it("the derivation is what it says it is (the exchange rate, spelled out)", () => {
    // 1 porter × valueDensity 16 × 1 hunger-day / 2 = 8 travel days;
    // 8 × a street day's walking (1.6 m/s × 240 s × 0.95 = 364.8 m) = 2918.4 m.
    expect(dailyTravelM(DOLLHOUSE_SCALE)).toBeCloseTo(364.8, 6);
    expect(reachStreet).toBeCloseTo(2918.4, 4);
    // "a rare import survives one third of its own reach per unit"
    expect(reachStreet / RARE_MAX_PER_VISIT).toBeCloseTo(972.8, 4);
  });

  it("🔒 answers 3 / 2 / 1 at exactly the old literals' probes", () => {
    expect(rarePerVisit(900, DOLLHOUSE_SCALE)).toBe(3); // old: d ≤ 900 ⇒ 3
    expect(rarePerVisit(1600, DOLLHOUSE_SCALE)).toBe(2); // old: d ≤ 1600 ⇒ 2
    expect(rarePerVisit(AWAY_DISTANCE_M, DOLLHOUSE_SCALE)).toBe(1); // old: else ⇒ 1
    expect(rarePerVisit(0, DOLLHOUSE_SCALE)).toBe(RARE_MAX_PER_VISIT);
  });

  it("📌 PACING PIN — what actually moved: two bands, both by one unit", () => {
    // The breakpoints slid outward from the literals to the derived thirds of
    // the reach (900 → 972.8, 1600 → 1945.6), so a partner sitting in either
    // band is now one treat better off. Stated, not smuggled.
    const old = (d: number) => (d <= 900 ? 3 : d <= 1600 ? 2 : 1);
    expect(old(950)).toBe(2);
    expect(rarePerVisit(950, DOLLHOUSE_SCALE)).toBe(3); // 950 < 972.8
    expect(old(1800)).toBe(1);
    expect(rarePerVisit(1800, DOLLHOUSE_SCALE)).toBe(2); // 1800 < 1945.6
    // Everywhere else the two agree, across the whole shipped range.
    for (let d = 0; d <= 4000; d += 25) {
      const changed = d > 900 && d <= 972.8;
      const changed2 = d > 1600 && d <= 1945.6;
      if (!changed && !changed2) expect(rarePerVisit(d, DOLLHOUSE_SCALE)).toBe(old(d));
    }
  });

  it("📌 PACING PIN — and now it FOLLOWS THE WORLD, which is the point", () => {
    // On REAL_SCALE a porter walks 92 km a day and eats once a day, so the
    // cookie's one-porter reach is 737 km: a 3 km neighbour is next door and
    // the caravan arrives full. The literal said "far" because it was written
    // for a 240 s day; the derivation says "near" because it can see the legs.
    expect(carryReachM(REAL_SCALE, freightOf(RARE_IMPORT_KIND), "land", undefined, {
      payloadBulk: RARE_PORTER_BULK,
    })).toBeCloseTo(737280, 0);
    expect(rarePerVisit(AWAY_DISTANCE_M, REAL_SCALE)).toBe(3); // old, scale-blind: 1
    expect(rarePerVisit(400_000, REAL_SCALE)).toBe(2);
    expect(rarePerVisit(900_000, REAL_SCALE)).toBe(1); // never below one caravan-load
  });

  it("bounded and integral, whatever the road", () => {
    for (const d of [0, 1, 900, 1600, 3000, 1e6, Number.MAX_SAFE_INTEGER]) {
      const n = rarePerVisit(d, DOLLHOUSE_SCALE);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(RARE_MAX_PER_VISIT);
    }
  });
});

describe("⚖️ barterLegSeconds — the flat 0.35-day leg becomes a road", () => {
  it("a STUB partner is unchanged: no geometry, the honest flat price", () => {
    expect(barterLegSeconds(DOLLHOUSE_SCALE, null)).toBeCloseTo(FOOD_DAY_SEC * BARTER_LEG_DAY_FRAC, 9);
    expect(barterLegSeconds(DOLLHOUSE_SCALE, undefined)).toBeCloseTo(84, 9);
    expect(barterLegSeconds(DOLLHOUSE_SCALE, Number.POSITIVE_INFINITY)).toBeCloseTo(84, 9);
  });

  it("🔒 a 3 km partner's leg is visibly longer than a 300 m partner's", () => {
    const near = barterLegSeconds(DOLLHOUSE_SCALE, 300);
    const far = barterLegSeconds(DOLLHOUSE_SCALE, 3000);
    expect(near).toBeCloseTo((300 / dailyTravelM(DOLLHOUSE_SCALE)) * DOLLHOUSE_SCALE.dayLengthS, 6);
    expect(near).toBeCloseTo(197.37, 1);
    expect(far).toBeCloseTo(1973.68, 1);
    expect(far / near).toBeCloseTo(10, 6); // ten times the road, ten times the wait
  });

  it("the old constant survives as the FLOOR — nobody's caravan teleports", () => {
    expect(barterLegSeconds(DOLLHOUSE_SCALE, 0)).toBeCloseTo(84, 9);
    expect(barterLegSeconds(DOLLHOUSE_SCALE, 10)).toBeCloseTo(84, 9);
    // The floor bites out to where the road's own price overtakes it.
    const crossover = (FOOD_DAY_SEC * BARTER_LEG_DAY_FRAC * dailyTravelM(DOLLHOUSE_SCALE)) /
      DOLLHOUSE_SCALE.dayLengthS;
    expect(crossover).toBeCloseTo(127.68, 2);
    expect(barterLegSeconds(DOLLHOUSE_SCALE, crossover + 1)).toBeGreaterThan(84);
  });

  it("it is a RATIO of declared dials: compress the world, compress the leg", () => {
    // Same 3 km on a real-clock world: a day of walking is 92 km, so the road
    // is a rounding error and the flat floor takes over.
    expect(barterLegSeconds(REAL_SCALE, 3000, REAL_SCALE.dayLengthS)).toBeCloseTo(
      REAL_SCALE.dayLengthS * BARTER_LEG_DAY_FRAC,
      6,
    );
  });
});

// ═══ ③b THE GENERIC TRANSACTION-PACING SEAT (user law, 2026-08-13) ═══════
//
// "Food per day isn't meant to be a constant, and other forms of barter
// aren't either — they are supposed to emerge from the needs of the
// entities performing the transaction... these constants probably SHOULD be
// merged... tied to a generic variable that is given specific values by the
// transaction in question." `BARTER_LEG_DAY_FRAC` above and trade.ts's
// caravan visit budget were the two `0.35`s the law names; both now route
// through `scale.ts`'s `transactionDayFrac`, and v1 answers every kind with
// the SAME shipped default — bit-identical, old expression reimplemented
// verbatim beside the new call, per this file's own §3 convention.

describe("⚖️ transactionDayFrac — the generic seat both 0.35s now route through", () => {
  it("🔒 both transaction kinds still answer the shipped 0.35, exactly", () => {
    expect(transactionDayFrac({ kind: "shipment-leg" })).toBe(0.35);
    expect(transactionDayFrac({ kind: "caravan-visit" })).toBe(0.35);
    expect(TRANSACTION_DAY_FRAC_DEFAULT).toBe(0.35);
  });

  it("🔒 BARTER_LEG_DAY_FRAC IS the seat's shipment-leg answer, not a coincidence", () => {
    expect(BARTER_LEG_DAY_FRAC).toBe(transactionDayFrac({ kind: "shipment-leg" }));
  });

  it("🔒 the caravan's speed formula (trade.ts createTownTrade) is bit-identical through the seat", () => {
    // OLD: `Math.max(2.2, (len * 2) / Math.max(30, FOOD_DAY_SEC * 0.35 -
    // TRADE_DWELL_SEC))` — trade.ts's inline formula before this round,
    // reimplemented verbatim here as the oracle (never asserted, only reused).
    const oldSpeed = (len: number) =>
      Math.max(2.2, (len * 2) / Math.max(30, FOOD_DAY_SEC * 0.35 - TRADE_DWELL_SEC));
    const newSpeed = (len: number) =>
      Math.max(
        2.2,
        (len * 2) / Math.max(30, FOOD_DAY_SEC * transactionDayFrac({ kind: "caravan-visit" }) - TRADE_DWELL_SEC),
      );
    for (const len of [1, 30, 137.4, 500, 5000]) {
      expect(newSpeed(len)).toBe(oldSpeed(len));
    }
  });

  it("v1: every kind anchors to ONE default — merged, as the law asks, not two constants that agree by luck", () => {
    const kinds = ["shipment-leg", "caravan-visit"] as const;
    for (const kind of kinds) expect(transactionDayFrac({ kind })).toBe(TRANSACTION_DAY_FRAC_DEFAULT);
  });
});

describe("⚖️ civicRecruitRadius — the +80 margin becomes serviceRadiusM", () => {
  // The function itself is a quest-host/director closure; what is pinnable
  // here is the derivation it now uses, against the literal it replaced.
  it("🔒 76.8 m against the old 80 — within 4 %, so no shipped town reshapes", () => {
    const margin = serviceRadiusM(DOLLHOUSE_SCALE, "social");
    expect(margin).toBeCloseTo(76.8, 6);
    expect(Math.abs(margin - 80) / 80).toBeLessThan(0.05);
  });

  it("📌 PACING PIN — a radius that follows the world instead of staying 80", () => {
    // Faster legs or a slower appetite widen the call; a compressed day
    // narrows it. The literal did none of that.
    expect(serviceRadiusM({ ...DOLLHOUSE_SCALE, locomotion: 2 }, "social")).toBeCloseTo(153.6, 6);
    expect(serviceRadiusM({ ...DOLLHOUSE_SCALE, metabolism: 2 }, "social")).toBeCloseTo(38.4, 6);
    expect(serviceRadiusM(REAL_SCALE, "social")).toBeCloseTo(27648, 0); // whole-town at real scale
  });

  it("the town's own DIAMETER stays geometry, not a constant", () => {
    // `plan.radius × 2 + margin` — the margin is the only thing that was ever
    // a literal, and the max() floor off a town (SITE_HAUL_FOCUS_R, the
    // wilderness earshot rule) is deliberately left standing.
    const radius = 140;
    expect(radius * 2 + serviceRadiusM(DOLLHOUSE_SCALE, "social")).toBeCloseTo(356.8, 6);
  });
});

// ═══ ④ THE LEDGER'S ADDITIVE WAKE SIGNAL ═════════════════════════════════

describe("⏸️ releaseEpoch — a released claim is an EVENT, not a tick", () => {
  it("counts releases that actually freed units, never bare calls", () => {
    const ledger = createReservationLedger();
    expect(ledger.releaseEpoch()).toBe(0);
    ledger.release("nobody"); // the sweeps do this constantly
    expect(ledger.releaseEpoch()).toBe(0); // …and it must not tick, or no park holds
    ledger.reserve("job:1", "yard", "wood", 3);
    expect(ledger.releaseEpoch()).toBe(0); // reserving is not freeing
    ledger.release("job:1");
    expect(ledger.releaseEpoch()).toBe(1);
    ledger.release("job:1"); // already gone
    expect(ledger.releaseEpoch()).toBe(1);
  });

  it("a fully CONSUMED holder leaves nothing to free (no residue, no event)", () => {
    const ledger = createReservationLedger();
    ledger.reserve("haul:7", "chest", "wood", 2);
    expect(ledger.consume("haul:7", "chest", "wood", 2)).toBe(2);
    ledger.release("haul:7");
    expect(ledger.releaseEpoch()).toBe(0);
  });

  it("not serialized — a reload starts at 0, and so does every park", () => {
    const ledger = createReservationLedger();
    ledger.reserve("job:1", "yard", "wood", 1);
    ledger.release("job:1");
    expect(ledger.releaseEpoch()).toBe(1);
    expect(Object.keys(ledger.toJSON())).toEqual(["serial", "rows"]);
    expect(createReservationLedger(ledger.toJSON()).releaseEpoch()).toBe(0);
  });
});
