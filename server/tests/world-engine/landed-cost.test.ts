// THE LANE-PRICER (trade-topology round S1; resources-and-trade.md ⑤,
// resource-access-round.md Layer 3).
//
// `landed-cost.ts` is the first thing in the engine that answers "what does it
// cost SOCIETY to have this here" in the currency everything else is already
// quoted in — hand-seconds. Four terms, every one of them an existing law
// read at a new rung:
//
//   freight  = 2 × leg seconds ÷ (payloadBulk × valueDensity)   [the Ox Paradox]
//   local    = shortage × the street day                        [goodsValueS]
//   landed   = (producer + freight) ÷ deliveredFraction         [both were spent]
//   advantage= local − landed                                   [netValueS's sign]
//
// This file pins the ARITHMETIC and the BLINDNESS. The pair-level consequences
// (membership, order, the hold split, lane ranking) are `complementary.test.ts`.
//
// Pure logic — no DOM / GL / DB / boot.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  freightUnitS,
  landedUnitCostS,
  laneAdvantageS,
  laneValueS,
  localUnitCostS,
} from "@shared/world-engine/kernel/town/landed-cost.js";
import {
  carryReachM,
  deliveredFraction,
  fragileHalfLifeDays,
  freightDeclared,
  freightOf,
  REAL_PORTER_BULK,
  type Freight,
} from "@shared/world-engine/freight.js";
import {
  goodsValueS,
  journeyTimeS,
  townFillS,
} from "@shared/world-engine/kernel/town/pricing.js";
import {
  dailyTravelM,
  DOLLHOUSE_SCALE,
  needFillDays,
  REAL_SCALE,
  type WorldScale,
} from "@shared/world-engine/scale.js";

const SCALE = DOLLHOUSE_SCALE;

// ─────────────────────────────────────────────────────────────────────────
// ① THE WORKED EXAMPLE — every number derived, and printed in the comment
// ─────────────────────────────────────────────────────────────────────────
//
// DOLLHOUSE_SCALE, the good `cloth`, a 600 m road, our shortage 1.0 (we have
// none), theirs 0.0 (they are flush). `cloth` IS a declared freight row
// (valueDensity 4 = VALUE_TIER.refined, transit "durable"), asserted below so
// the derivation cannot quietly read the undeclared default.
//
//   dailyTravelM(DOLLHOUSE)  = 1.6 m/s × 240 s × 0.95 waking =  364.8 m/day
//   gait                     = 364.8 / 240                   =    1.52 m/s
//   one-way leg              = 600 / 1.52                    =  394.7368421 s
//   ROUND TRIP               = ×2                            =  789.4736842 s
//   payload ration-worth     = 20 bulk × 4 vd                =   80 rations
//   freightUnitS             = 789.4736842 / 80              =    9.8684211 s
//   localUnitCostS(1.0)      = 1.0 × townFillS(240)          =  240 s
//   producerUnitCostS        = localUnitCostS(0.0)           =    0 s
//   deliveredFraction        = durable                       =    1
//   landedUnitCostS          = (0 + 9.8684211) / 1           =    9.8684211 s
//   advantageS               = 240 − 9.8684211               =  230.1315789 s
//
// Read out loud: a bolt of cloth we have none of is worth a whole street day
// of somebody's hands, and having it walked 600 m costs ten seconds of them.

describe("① the worked example — cloth, 600 m, DOLLHOUSE", () => {
  const CLOTH = freightOf("cloth");
  const LEG = 600;

  it("🔒 the premise: cloth is a DECLARED durable row at the refined tier", () => {
    expect(freightDeclared("cloth")).toBe(true);
    expect(CLOTH).toEqual({ valueDensity: 4, transit: "durable" });
  });

  it("🚨 every term of the pricer, to nine places", () => {
    expect(dailyTravelM(SCALE)).toBeCloseTo(364.8, 9);
    const gait = dailyTravelM(SCALE) / SCALE.dayLengthS;
    expect(gait).toBeCloseTo(1.52, 9);
    const roundTripS = 2 * journeyTimeS(LEG, gait);
    expect(roundTripS).toBeCloseTo(789.4736842105263, 9);
    const rationWorth = REAL_PORTER_BULK * CLOTH.valueDensity;
    expect(rationWorth).toBe(80);

    expect(freightUnitS(CLOTH, LEG, SCALE)).toBeCloseTo(9.868421052631579, 9);
    // …and it IS the round trip over the ration-worth, not a number beside it.
    expect(freightUnitS(CLOTH, LEG, SCALE)).toBeCloseTo(roundTripS / rationWorth, 12);

    expect(localUnitCostS(1, SCALE)).toBe(240);
    expect(localUnitCostS(0, SCALE)).toBe(0);
    expect(deliveredFraction(SCALE, CLOTH, LEG / dailyTravelM(SCALE))).toBe(1);

    const landed = landedUnitCostS({
      legM: LEG,
      scale: SCALE,
      freight: CLOTH,
      producerUnitCostS: localUnitCostS(0, SCALE),
    });
    expect(landed).toBeCloseTo(9.868421052631579, 9);
    expect(laneAdvantageS(localUnitCostS(1, SCALE), landed)).toBeCloseTo(230.13157894736842, 9);
  });

  it("🚨 THE ANCHOR IDENTITY — at its own carry reach, one unit's freight is ONE HUNGER FILL", () => {
    // The Ox Paradox per unit. `haulBreakEvenDays` prices the whole haul
    // against the load's ration-worth; dividing by that same ration-worth
    // makes the per-unit statement exact, for EVERY good and EVERY payload.
    const oneFillS = needFillDays(SCALE, "hunger") * SCALE.dayLengthS;
    expect(oneFillS).toBe(240);
    for (const good of ["cloth", "wood", "cookie", "clothing", "stone"]) {
      const f = freightOf(good);
      const reach = carryReachM(SCALE, f);
      expect(freightUnitS(f, reach, SCALE)).toBeCloseTo(oneFillS, 9);
    }
    // Independent of the payload too: a cart is a bigger payload, not a new
    // mechanic, and it moves the REACH by exactly as much as it moves the
    // per-unit cost, so the identity is untouched.
    const f = freightOf("cloth");
    for (const bulk of [1, 20, 137]) {
      expect(freightUnitS(f, carryReachM(SCALE, f, "land", undefined, { payloadBulk: bulk }), SCALE, bulk))
        .toBeCloseTo(oneFillS, 9);
    }
    // …and it is a property of the SCALE's own two clocks, not of the
    // dollhouse: a real-anchor world says the same thing in its own seconds.
    const realFill = needFillDays(REAL_SCALE, "hunger") * REAL_SCALE.dayLengthS;
    const rf = freightOf("cloth");
    expect(freightUnitS(rf, carryReachM(REAL_SCALE, rf), REAL_SCALE)).toBeCloseTo(realFill, 6);
  });

  it("🚨 THE SELF-CONSUMING ARM — a staple at its own reach lands UNPAYABLE", () => {
    // `food` is selfConsuming: the porters ate it. `deliveredFraction` hits
    // exactly 0 at `carryReachM` for every valueDensity by construction, and
    // the pricer's answer for a load that does not arrive is +∞ — the
    // resource-access law's own word, never a big number.
    const f = freightOf("food");
    expect(f.transit).toBe("selfConsuming");
    const reach = carryReachM(SCALE, f);
    expect(reach).toBeCloseTo(3648, 6);
    expect(deliveredFraction(SCALE, f, reach / dailyTravelM(SCALE))).toBe(0);
    expect(
      landedUnitCostS({ legM: reach, scale: SCALE, freight: f, producerUnitCostS: 0 }),
    ).toBe(Number.POSITIVE_INFINITY);
    // Half of it and the load is half eaten — dearer on BOTH terms, because
    // producer and porter both paid for the ones that did not arrive.
    const half = reach / 2;
    const delivered = deliveredFraction(SCALE, f, half / dailyTravelM(SCALE));
    expect(delivered).toBeCloseTo(0.5, 9);
    expect(landedUnitCostS({ legM: half, scale: SCALE, freight: f, producerUnitCostS: 30 }))
      .toBeCloseTo((30 + freightUnitS(f, half, SCALE)) / 0.5, 9);
  });

  it("🚨 THE FRAGILE ARM — one half-life of road DOUBLES producer AND freight", () => {
    // Derived from the loss law, never a literal: the leg is exactly
    // `fragileHalfLifeDays` of travel, so half the load lands and the
    // survivors carry twice the whole cost.
    const legM = dailyTravelM(SCALE) * fragileHalfLifeDays();
    const f = freightOf("milk");
    expect(f.transit).toBe("fragile");
    expect(deliveredFraction(SCALE, f, legM / dailyTravelM(SCALE))).toBeCloseTo(0.5, 12);
    const producer = 10;
    const freight = freightUnitS(f, legM, SCALE);
    expect(landedUnitCostS({ legM, scale: SCALE, freight: f, producerUnitCostS: producer }))
      .toBeCloseTo(2 * (producer + freight), 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② THE SHAPES — monotonicity, the degenerate arms, the gate's sign
// ─────────────────────────────────────────────────────────────────────────

describe("② the pricer's shape", () => {
  const CLOTH = freightOf("cloth");

  it("freight RISES with the leg, from exactly 0 at no road at all", () => {
    expect(freightUnitS(CLOTH, 0, SCALE)).toBe(0);
    expect(freightUnitS(CLOTH, -500, SCALE)).toBe(0); // a negative road is none
    let prev = 0;
    for (let m = 50; m <= 5000; m += 50) {
      const v = freightUnitS(CLOTH, m, SCALE);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    // Linear in the leg, because the leg is: double the road, double the cost.
    expect(freightUnitS(CLOTH, 1200, SCALE)).toBeCloseTo(2 * freightUnitS(CLOTH, 600, SCALE), 9);
  });

  it("freight FALLS with value density and with the payload — one ratio, two dials", () => {
    const dense: Freight = { valueDensity: 8, transit: "durable" };
    const thin: Freight = { valueDensity: 2, transit: "durable" };
    expect(freightUnitS(dense, 600, SCALE)).toBeCloseTo(freightUnitS(thin, 600, SCALE) / 4, 12);
    expect(freightUnitS(CLOTH, 600, SCALE, 40)).toBeCloseTo(freightUnitS(CLOTH, 600, SCALE, 20) / 2, 12);
  });

  it("🚨 a DURABLE good's landed cost is producer + freight, with nothing else in it", () => {
    // "the ox never eats the cargo": `deliveredFraction` is 1 at every
    // distance, so the division is a no-op and the two terms stand alone.
    for (const legM of [0, 137, 600, 5000, 14000]) {
      const freight = freightUnitS(CLOTH, legM, SCALE);
      for (const producer of [0, 12, 240]) {
        expect(landedUnitCostS({ legM, scale: SCALE, freight: CLOTH, producerUnitCostS: producer }))
          .toBeCloseTo(producer + freight, 12);
      }
    }
  });

  it("🚨 THE TWO +∞ ARMS — a road with no time in it, and a load worth nothing", () => {
    // A world whose legs take no time cannot walk anywhere at all: the gait is
    // 0 and the leg is unreachable, which is `journeyTimeS`'s own reading.
    const still: WorldScale = { ...SCALE, dayLengthS: 0 };
    expect(dailyTravelM(still)).toBe(0);
    expect(freightUnitS(CLOTH, 600, still)).toBe(Number.POSITIVE_INFINITY);
    expect(landedUnitCostS({ legM: 600, scale: still, freight: CLOTH, producerUnitCostS: 5 }))
      .toBe(Number.POSITIVE_INFINITY);
    // …but a leg of ZERO on that same world is free, not unpayable.
    expect(freightUnitS(CLOTH, 0, still)).toBe(0);
    expect(landedUnitCostS({ legM: 0, scale: still, freight: CLOTH, producerUnitCostS: 5 })).toBe(5);
    // A load with no ration-worth (nothing valuable, or no payload) can never
    // repay its own haul, at any distance.
    expect(freightUnitS({ valueDensity: 0, transit: "durable" }, 600, SCALE))
      .toBe(Number.POSITIVE_INFINITY);
    expect(freightUnitS(CLOTH, 600, SCALE, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("🚨 THE WORTHWHILE SIGN — `netValueS`'s subtraction, and what it refuses", () => {
    expect(laneAdvantageS(240, 10)).toBe(230);
    expect(laneAdvantageS(10, 240)).toBe(-230);
    expect(laneAdvantageS(240, Number.POSITIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    // AT its own carry reach a durable good is never worth importing, however
    // desperate we are and however flush they are: freight there is one whole
    // fill (the anchor above) and local is at most one whole fill, so the best
    // case in the world is a dead heat — which the strict sign refuses.
    const reach = carryReachM(SCALE, CLOTH);
    const best = laneAdvantageS(
      localUnitCostS(1, SCALE),
      landedUnitCostS({ legM: reach, scale: SCALE, freight: CLOTH, producerUnitCostS: 0 }),
    );
    expect(best).toBeCloseTo(0, 9);
    expect(best > 0).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ THE LANE — Σ advantage × units
// ─────────────────────────────────────────────────────────────────────────

describe("③ laneValueS — what a whole lane is worth", () => {
  it("sums advantage × units over the goods worth carrying", () => {
    expect(
      laneValueS([
        { good: "a", advantageS: 100, units: 3 },
        { good: "b", advantageS: 20, units: 2 },
      ]),
    ).toBe(340);
    expect(laneValueS([])).toBe(0);
  });

  it("🚨 a NON-POSITIVE row contributes nothing — it never subtracts", () => {
    const rows = [
      { good: "a", advantageS: 100, units: 3 },
      { good: "b", advantageS: -500, units: 6 },
      { good: "c", advantageS: 0, units: 6 },
      { good: "d", advantageS: Number.NEGATIVE_INFINITY, units: 1 },
    ];
    expect(laneValueS(rows)).toBe(300);
    // A lane is not made WORSE by a good nobody would ship over it.
    expect(laneValueS(rows)).toBe(laneValueS([rows[0]!]));
  });

  it("a row dealt no units is worth nothing, and an unreadable count is zero", () => {
    expect(laneValueS([{ good: "a", advantageS: 100, units: 0 }])).toBe(0);
    expect(laneValueS([{ good: "a", advantageS: 100, units: -4 }])).toBe(0);
    expect(laneValueS([{ good: "a", advantageS: 100, units: NaN }])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ THE BLINDNESS — and the ONE-DEFINITION gate the cycle forced
// ─────────────────────────────────────────────────────────────────────────

describe("④ the pricer is body-blind, spec-blind and pricing.ts's own arithmetic", () => {
  const SRC = readFileSync(
    join(process.cwd(), "shared", "world-engine", "kernel", "town", "landed-cost.ts"),
    "utf8",
  );
  /** The module with every comment removed — what actually RUNS. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("🚨 names no good, no kind and no need — the whole registry is the caller's", () => {
    // The same technique the glyph-registry tests use for names: read the
    // module and look. A pricer that knew `food` from `cloth` would be a
    // second freight registry, and the two would drift.
    for (const literal of ["food", "cloth", "clothing", "wood", "stone", "milk", "cookie", "hunger"]) {
      expect(CODE).not.toContain(`"${literal}"`);
      expect(CODE).not.toContain(`'${literal}'`);
    }
    // No string literal at all, in fact, outside the import specifiers.
    const strings = [...CODE.matchAll(/"[^"\n]*"/g)].map((m) => m[0]);
    expect(strings).toEqual(['"../../freight.js"', '"../../scale.js"']);
  });

  it("🚨 imports only TRUE LEAVES — freight.ts and scale.ts, and nothing else", () => {
    // complementary.ts's header law, extended to its new dependency: this
    // module is reachable FROM trade.ts, so anything it reaches must not lead
    // back. In particular NOT pricing.ts (→ scope-shape → goods-kinds →
    // trade), whose top-level `TREAT_KINDS = [RARE_IMPORT_KIND]` would sit in
    // its temporal dead zone and throw on `import trade.js`.
    const specs = [...SRC.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specs.sort()).toEqual(["../../freight.js", "../../scale.js"]);
  });

  it("🚨 …and pays for that with an EQUALITY: the pricer IS pricing.ts, term for term", () => {
    // `townFillS`, `journeyTimeS` and `goodsValueS(1, s, fill, 1)` could not be
    // imported (see the header). They are pinned equal here instead, across
    // the range and on both shipped scales, so the two can never drift in
    // silence — the same guard `equilibriumExportScale` gets against
    // `exportSpareScale`.
    for (const scale of [DOLLHOUSE_SCALE, REAL_SCALE]) {
      for (const s of [0, 0.001, 0.15, 0.3333, 0.5, 0.9, 1]) {
        expect(localUnitCostS(s, scale)).toBe(goodsValueS(1, s, townFillS(scale), 1));
      }
      // Out-of-range shortages clamp identically at both boundaries.
      expect(localUnitCostS(-3, scale)).toBe(goodsValueS(1, -3, townFillS(scale), 1));
      expect(localUnitCostS(4, scale)).toBe(goodsValueS(1, 4, townFillS(scale), 1));
      // …and the leg is `journeyTimeS` at the region rung's own gait, doubled.
      const gait = dailyTravelM(scale) / scale.dayLengthS;
      for (const m of [0, 137, 600, 9000]) {
        expect(freightUnitS({ valueDensity: 1, transit: "durable" }, m, scale, 1))
          .toBe(2 * journeyTimeS(m, gait));
      }
    }
  });
});
