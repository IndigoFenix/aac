/**
 * landed-cost.ts — THE LANE-PRICER (resources-and-trade.md ⑤;
 * resource-access-round.md's Layer 3: "can society reach it").
 *
 * Layer 1 says a thing CAN grow here, Layer 2 says whether it is standing
 * here, and this is Layer 3: what it costs society to have it HERE, in the
 * one currency the engine already keeps — SECONDS OF A HAND'S TIME.
 *
 *   landed = (producer + freight) / delivered      per unit
 *   advantage = local − landed                     per unit
 *   lane value = Σ advantage × units, over the goods worth carrying
 *
 * Every term is an existing law read at this rung; nothing here is a new
 * dial:
 *  · FREIGHT is `haulBreakEvenDays`'s own arithmetic per unit — the round
 *    trip's hand-seconds over the load's RATION-WORTH (`payloadBulk ×
 *    valueDensity`). That makes the anchor exact rather than approximate: at
 *    `legM = carryReachM(scale, f)` one unit's freight is EXACTLY one hunger
 *    fill of hand time, for EVERY good and every payload — the Ox Paradox
 *    per unit, reused, not re-derived (see `freightUnitS`).
 *  · DELIVERED is `deliveredFraction`, whole. Both the producer's cost and
 *    the freight were spent on what LEFT, so loss makes the survivors dearer
 *    on BOTH terms — which is why the division wraps the sum.
 *  · LOCAL is the town rung's own street-day price of a unit it is out of.
 *  · The SIGN is `netValueS`'s sign: positive = worth doing. One gate.
 *
 * 🚨 PURE, BODY-BLIND, SPEC-BLIND. No kind ids, no session, no registry, no
 * side effects: the caller hands in a `Freight` row and two costs. A test
 * greps this file for good-name literals precisely so it stays that way.
 *
 * ── ⚠️ WHY THIS FILE DOES NOT IMPORT pricing.ts (read before "fixing" it) ──
 * The three quantities below are pricing.ts's `journeyTimeS`, `townFillS` and
 * `goodsValueS(1, s, fill, 1)`, and importing them is what the S1 brief
 * pinned. It cannot be done: pricing.ts is NOT a leaf. It value-imports
 * `costTotalS` from scope-shape.ts, which value-imports `totalStackUnits`
 * from goods-kinds.ts, which value-imports `RARE_IMPORT_KIND` from trade.ts —
 * and trade.ts imports complementary.ts, which imports this file. That closes
 *
 *   trade → complementary → landed-cost → pricing → scope-shape
 *         → goods-kinds → trade
 *
 * into a cycle whose weakest link is a TOP-LEVEL read: goods-kinds.ts:82
 * `export const TREAT_KINDS = [RARE_IMPORT_KIND]`. Enter that cycle at
 * trade.ts (every town test does) and goods-kinds evaluates while trade.ts's
 * body has not run, so `RARE_IMPORT_KIND` is in its temporal dead zone and
 * `import trade.js` throws. The whole reason complementary.ts exists as a
 * sibling of barter.ts rather than a section of it is this same law (see its
 * header), so this file keeps it: it imports freight.ts and scale.ts, both
 * true leaves, and NOTHING ELSE.
 *
 * The cost of that is the one thing this codebase hates — the same arithmetic
 * written twice — so it is paid the way `equilibriumExportScale` pays it: the
 * two are pinned EQUAL, term for term, by a jest gate
 * (`server/tests/world-engine/landed-cost.test.ts`, "the pricer IS pricing.ts").
 * The test file is a leaf consumer of both and may import either. If someone
 * later cuts the goods-kinds → trade edge, delete the three shims and import
 * pricing.ts; the gate will prove nothing moved.
 */

import {
  deliveredFraction,
  REAL_PORTER_BULK,
  type Freight,
} from "../../freight.js";
import { dailyTravelM, type WorldScale } from "../../scale.js";

/** pricing.ts `townFillS` — THE STREET DAY, the town rung's fill clock.
 *  Pinned equal to it; see the header for why it is not imported. */
const townDayS = (scale: WorldScale): number => Math.max(1, scale.dayLengthS);

/** pricing.ts `journeyTimeS(distM, dailyTravelM(scale) / dayLengthS)` — the
 *  leg's walking seconds at the region rung's own gait. Zero/negative speed
 *  prices the leg unreachable (+∞), exactly as `journeyTimeS` does. */
const legJourneyS = (legM: number, scale: WorldScale): number => {
  const speedMps = dailyTravelM(scale) / scale.dayLengthS;
  if (!(speedMps > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, legM) / speedMps;
};

/**
 * ⚖️ HAND-SECONDS ONE UNIT COSTS TO MOVE `legM` — one way AND back.
 *
 *   freight = 2 × legSeconds / (payloadBulk × valueDensity)
 *
 * The denominator is the load's RATION-WORTH, which is the quantity
 * `haulBreakEvenDays` already prices the whole haul against, so a "unit"
 * here is the SAME unit that function's break-even is quoted in. The
 * consequence is an identity, not an approximation: at
 * `legM = carryReachM(scale, f)` this returns EXACTLY
 * `needFillDays(scale, "hunger") × scale.dayLengthS` — one hunger fill of a
 * hand's time — for every good, every valueDensity and every payload, because
 *
 *   2 · (dailyTravel · payload · vd · fillDays / 2) / (dailyTravel/dayLen)
 *     ÷ (payload · vd)  =  fillDays · dayLen.
 *
 * That is the Ox Paradox per unit: the anchor the freight laws are already
 * built on, read at the rung a caravan actually bids in.
 *
 * ⚖️ TWO CLOCKS (R-8). The leg's seconds come from `dailyTravelM × dayLengthS`
 * — the SOLAR coupling `barterLegSeconds` already ships. It is CONSUMED here,
 * never added to: this function introduces no clock of its own.
 *
 * `legM ≤ 0` ⇒ 0 (no road, no freight). A world whose legs take no time, or a
 * load worth nothing, ⇒ +∞: unpayable, the resource-access law's own word.
 */
export function freightUnitS(
  f: Freight,
  legM: number,
  scale: WorldScale,
  payloadBulk: number = REAL_PORTER_BULK,
): number {
  const m = Math.max(0, legM);
  if (!(m > 0)) return 0;
  const rationWorth = Math.max(0, payloadBulk) * Math.max(0, f.valueDensity);
  if (!(rationWorth > 0)) return Number.POSITIVE_INFINITY;
  const oneWayS = legJourneyS(m, scale);
  if (!Number.isFinite(oneWayS)) return Number.POSITIVE_INFINITY;
  return (2 * oneWayS) / rationWorth;
}

/**
 * ⚖️ WHAT ONE UNIT IS WORTH HERE, at our own shortage — pricing.ts's
 * `goodsValueS(1, shortage, townFillS(scale), 1)` verbatim: "one unit of a
 * good the town is completely out of is worth one day of a hand's time, and
 * everything else is that scaled by shortage".
 *
 * It is deliberately the SAME reading on both sides of a lane: ours is what
 * doing without costs us, theirs is what parting with it costs them (the
 * producer's own books). Shortage is clamped to [0,1] at the boundary.
 */
export function localUnitCostS(shortage01: number, scale: WorldScale): number {
  const s = Math.max(0, Math.min(1, shortage01));
  return s * townDayS(scale);
}

export interface LandedCostInputs {
  /** One-way road metres between the two books. */
  legM: number;
  scale: WorldScale;
  /** The GOOD's transport row — never its name (this module is spec-blind). */
  freight: Freight;
  /**
   * The producer's cost per unit at ITS OWN books. At this rung the caller
   * passes `localUnitCostS(theirShortage, scale) ÷ their competence`: what
   * parting with a unit costs the town that has it, over that region's
   * average skill at making it (skill-learning-round.md, the REGIONAL slice —
   * `BarterSignals.competence`, read in complementary.ts; NOT an additive
   * term, and NOT read here: this pricer stays body- and skill-blind, and a
   * novice region divides by exactly 1).
   */
  producerUnitCostS: number;
  /** The hauler's load, in bulk units (default: the porter anchor). */
  payloadBulk?: number;
}

/**
 * ⚖️ THE LANDED COST OF ONE UNIT, in hand-seconds:
 *
 *   (producer + freight) / deliveredFraction
 *
 * BOTH terms are divided because both were spent on what LEFT — the producer
 * made, and the porter carried, the whole load; only a fraction of it arrives,
 * so the survivors carry the cost of the ones that did not. `delivered ≤ 0`
 * ⇒ +∞ (a good the road eats entirely is unpayable at any price, which is the
 * selfConsuming arm's behaviour exactly at `carryReachM`).
 */
export function landedUnitCostS(inp: LandedCostInputs): number {
  const { legM, scale, freight, payloadBulk } = inp;
  const freightS = freightUnitS(freight, legM, scale, payloadBulk);
  if (!Number.isFinite(freightS)) return Number.POSITIVE_INFINITY;
  const producer = Math.max(0, inp.producerUnitCostS);
  const perDay = dailyTravelM(scale);
  const oneWayDays = perDay > 0 ? Math.max(0, legM) / perDay : 0;
  const delivered = deliveredFraction(
    scale,
    freight,
    oneWayDays,
    payloadBulk === undefined ? {} : { payloadBulk },
  );
  if (!(delivered > 0)) return Number.POSITIVE_INFINITY;
  return (producer + freightS) / delivered;
}

/**
 * ⚖️ THE WORTHWHILE GATE, per unit: what doing without costs us, minus what
 * having it delivered costs. `netValueS`'s own subtraction and `netValueS`'s
 * own sign — positive means the lane is worth walking for this good, and
 * nothing else is consulted. A good inside every freight gate can still land
 * here at zero or below (a bulky good over half its reach), and that is the
 * whole point: reach says the haul does not DESTROY the cargo, this says
 * whether it is worth making.
 */
export function laneAdvantageS(localS: number, landedS: number): number {
  return localS - landedS;
}

/** One good's contribution to a lane: its per-unit advantage and how many
 *  units of the hold it was dealt. */
export interface LaneGoodRow {
  good: string;
  advantageS: number;
  units: number;
}

/**
 * ⚖️ WHAT A WHOLE LANE IS WORTH, in seconds — Σ advantage × units over the
 * goods that clear the gate. Rows at or below zero contribute NOTHING rather
 * than subtracting: a lane is not made worse by a good nobody would ship over
 * it, it simply does not carry it (membership already drops those, so this is
 * the same fact defended twice on purpose).
 *
 * This is the number one lane is compared with another by. It is in SECONDS,
 * so it compares with every other cost the engine keeps.
 */
export function laneValueS(rows: readonly LaneGoodRow[]): number {
  let sum = 0;
  for (const r of rows) {
    if (!(r.advantageS > 0)) continue;
    const units = Number.isFinite(r.units) ? Math.max(0, r.units) : 0;
    sum += r.advantageS * units;
  }
  return sum;
}
