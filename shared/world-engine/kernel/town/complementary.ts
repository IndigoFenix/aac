/**
 * complementary.ts — WHAT TWO TOWNS ACTUALLY HAVE FOR EACH OTHER
 * (resources-and-trade ⑤, economy-arc-opening T2).
 *
 * Until now a trade line's `imports`/`exports` were AUTHORED CONSTANTS
 * (trade.ts `TRADE_IMPORT_KINDS` and the one export good): nothing joined one
 * town's yields to another's fills, so a licensed weaver next door and a
 * granary across the water landed the child the identical crate of trinkets.
 * This module is that join — a PURE READ of both sides' books plus the road
 * between them, with nothing scheduled, mutated or remembered.
 *
 * Two gates, both borrowed rather than invented:
 *   • WANT — `BARTER_WANT_MIN` read in BOTH directions. Below it a town "has
 *     enough" (literally what the willingness refusal calls it), so below it
 *     on their side is a SURPLUS and at/above it on ours is a WANT. One line,
 *     read twice, so a derived list can never disagree with the refusal a deal
 *     on that good would actually get.
 *   • FREIGHT — the good must survive the leg. Nothing about how badly a town
 *     wants milk makes milk cross a day of road, and a list that promised it
 *     would be a lie the caravan then quietly breaks. Since the
 *     import-displacement round that gate is a FLOOR with a slope above it:
 *     what survives also WEIGHS the row (`freightArrivalFraction`), so the
 *     hold is dealt by landed cost rather than by raw appetite.
 *
 * WHY A SIBLING OF barter.ts RATHER THAN A SECTION OF IT. `bindPartner`
 * (trade.ts) is the seam that derives a route's two lists, and the module
 * graph already runs barter → transfer → trade. Putting the read in barter.ts
 * would have closed that into a require cycle; this leaf imports only
 * freight.ts and scale.ts (leaves themselves) plus barter's `BarterSignals`
 * TYPE, which erases. `BARTER_WANT_MIN` lives here for the same reason and is
 * re-exported under its established name by barter.ts — ONE definition, the
 * name every caller already uses.
 *
 * ⚠️ THAT LAW STILL BINDS, and now binds this file's own imports too: the two
 * modules added by the trade-topology round — `landed-cost.ts` (the pricer)
 * and `allocate.ts` (the one conserving allocator) — import NOTHING but true
 * leaves, which is why they may be named here. See landed-cost.ts's header
 * for the cycle that pricing.ts would have closed (trade → complementary →
 * landed-cost → pricing → scope-shape → goods-kinds → trade, with a top-level
 * read at the far end) if the pricer had been allowed to import it.
 *
 * ── ⚖️ THE THIRD GATE (trade-topology round, R-2): WORTHWHILE ─────────────
 * WANT says a town is short of it; FREIGHT says the road does not destroy it;
 * neither asks whether the trip is worth MAKING. A bulky good half-way to its
 * own reach clears both and still costs more hand-seconds to land than doing
 * without it costs — the trade destroys value, which is the one thing the
 * economy arc's §0 pricing exists to notice. So a row now also carries what
 * it is WORTH — `advantageS`, seconds per unit, from landed-cost.ts — and a
 * good stays on a lane only while that is positive. The list's ORDER is that
 * number too (ties by input index), so the hold is dealt by landed cost
 * rather than by appetite: a dense good outbids a bulky one it merely tied
 * with on shortage. `want` is unchanged and stays for every reader that needs
 * a 0..1.
 */

import {
  carryReachM,
  deliveredFraction,
  freightOf,
} from "../../freight.js";
import { dailyTravelM, type WorldScale } from "../../scale.js";
// ⚖️ R-1/R-2 — the lane-pricer. A leaf (freight + scale only); see its header.
import {
  landedUnitCostS,
  laneAdvantageS,
  laneValueS,
  localUnitCostS,
} from "./landed-cost.js";
// ⚖️ ONE conserving allocator (allocate.ts imports nothing). This is the SAME
// call trade.ts's `allotmentSplit` wraps — never a second apportionment.
import { allocate } from "./allocate.js";
// TYPE ONLY (erased at build) — barter.ts owns the named interface; this leaf
// borrows the shape without taking a runtime edge back up the graph.
import type { BarterSignals } from "./barter.js";

/** Below this, a town doesn't WANT a good ("they have enough wood").
 *  Re-exported by barter.ts as `BARTER_WANT_MIN` — its public name. */
export const BARTER_WANT_MIN = 0.15;

/**
 * ⚖️ G2 — HOW MUCH OF ITS SURPLUS A TOWN ACTUALLY SHIPS, 0..1: the want gate
 * above, converted from a CLIFF into a SLOPE.
 *
 * `rank()` below asks a boolean of the SPARING side ("is its own shortage
 * under `BARTER_WANT_MIN`?"), so a town at shortage 0.149 exported its whole
 * surplus and one at 0.151 exported nothing — a step function on the one
 * quantity a player can watch. The economy-arc §0 law is that a claim on a
 * committed resource is priced against what its holder could otherwise do
 * with it, and that price is continuous: the hungrier we are, the less of our
 * own surplus we let out, reaching zero exactly AT the gate the boolean
 * already draws.
 *
 *   scale = clamp01((BARTER_WANT_MIN − ourShortage) / BARTER_WANT_MIN)
 *
 * 1 when fully fed, 0 at the gate, linear between — the SAME constant, so the
 * list and the volume can never disagree about where exporting stops. Pure;
 * the caller supplies its own books' reading.
 *
 * (Its famine-side twin is barter.ts's `barterSpareFraction`, which converts
 * `BARTER_FAMINE_MAX`'s wall by the identical formula — one shape, two gates.)
 */
export function exportSpareScale(ourShortage: number): number {
  return clamp01((BARTER_WANT_MIN - clamp01(ourShortage)) / BARTER_WANT_MIN);
}

/**
 * ⚖️ BATCH 3 · B4 — THE SAME VALVE AT ITS FIXED POINT, closed form.
 *
 * `exportSpareScale` above answers "how much may we spare, given a shortage".
 * Once the books DEBIT what the lane carries away (B3's `owed` term), the
 * shortage it reads is itself a function of how much we ship — feed the slope
 * its own output and a naive loop oscillates or crawls. The interior algebra
 * of the loop has one solution and it can just be written down:
 *
 *   s = (WANT_MIN − S) / WANT_MIN   with   S = S₀ + s·burden
 *   ⇒ s·WANT_MIN = WANT_MIN − S₀ − s·burden
 *   ⇒ s* = (WANT_MIN − S₀) / (WANT_MIN + burden)
 *
 *  • `preShortage` (S₀) — what we would be short of the good if the lane
 *    carried nothing today (the bank-blind `1 − fill()` reading, as shipped).
 *  • `burden` — the whole authored export rate expressed against the town's
 *    own daily need, in the books' units (`exportDaily_book / need`). 0.3 for
 *    an authored exporter, whose surplus is a third of its draw.
 *
 * The equilibrium the caller lands on is `S₀ + s*·burden`: at S₀ = 0 and
 * burden 0.3 that is s* = 1/3 and a 10% pinch — a fed exporter ships a third
 * of the authored volume and its own households feel the rest, just under the
 * want gate. S₀ ≥ WANT_MIN ⇒ 0 (a famine town does not export, G1/G2 intact).
 * burden 0 ⇒ the expression IS `exportSpareScale`'s, term for term, so a town
 * that exports nothing is byte-identical to the batch-2 slope.
 */
export function equilibriumExportScale(preShortage: number, burden: number): number {
  const b = Number.isFinite(burden) ? Math.max(0, burden) : 0;
  return clamp01((BARTER_WANT_MIN - clamp01(preShortage)) / (BARTER_WANT_MIN + b));
}

/** Fraction of a load that must still ARRIVE for the good to be worth listing
 *  (the rest is what the road ate). Half: below that the caravan is hauling
 *  mostly air, and the pair should be trading something else. */
export const FREIGHT_SURVIVAL_MIN = 0.5;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * ⚖️ DOES THIS GOOD SURVIVE THIS ROAD? Both freight reads, each in its own
 * terms: the leg must sit inside the good's `carryReachM` (past it the haul
 * destroys value — wages for a durable, substance for a staple), and what
 * lands must be at least `FREIGHT_SURVIVAL_MIN` of what left
 * (`deliveredFraction`).
 *
 * A FRAGILE good fails the moment the road runs past its own loss half-life,
 * however desperate either side is — desperation is not a preservative, and
 * "charcoal doesn't travel" stays an OUTPUT of the arithmetic (freight.ts's
 * law) rather than a rule anybody wrote here.
 */
export function freightSurvivesLeg(good: string, legM: number, scale: WorldScale): boolean {
  const f = freightOf(good);
  const m = Math.max(0, legM);
  if (!(m > 0)) return true; // no road between them: nothing to survive
  if (m > carryReachM(scale, f)) return false;
  const perDay = dailyTravelM(scale);
  if (!(perDay > 0)) return true; // a world with no legs prices no loss
  return deliveredFraction(scale, f, m / perDay) >= FREIGHT_SURVIVAL_MIN;
}

/**
 * ⚖️ HOW MUCH OF THE LOAD ACTUALLY LANDS, 0..1 — `freightSurvivesLeg`'s
 * CONTINUOUS twin (import-displacement round, Stage B).
 *
 * The boolean above is the FLOOR and stays exactly where it is: below half,
 * the caravan is hauling air and the pair should be trading something else.
 * This is the slope ABOVE that floor, and it is the producer+freight half of
 * the landed-cost law read at this rung's fidelity — quantity is the whole
 * story, so "what it costs to land" IS "how little of it lands".
 *
 * SAME TWO DEGENERATE GUARDS, read the same way as the gate: no road between
 * them, or a world whose legs take no time, delivers everything. A DURABLE
 * good is 1 at every distance by freight.ts's own law — the ox never eats the
 * cargo — so only a selfConsuming or fragile good on a long leg moves.
 *
 * 🚨 NOT a second conversion dial: `deliveredFraction` is freight.ts's, whole.
 */
export function freightArrivalFraction(good: string, legM: number, scale: WorldScale): number {
  const m = Math.max(0, legM);
  if (!(m > 0)) return 1;
  const perDay = dailyTravelM(scale);
  if (!(perDay > 0)) return 1;
  return clamp01(deliveredFraction(scale, freightOf(good), m / perDay));
}

/** The two sides of one pair's trade, best first (by LANDED ADVANTAGE — see
 *  `ComplementaryRow.advantageS`). */
export interface ComplementaryTrade {
  /** Goods THEY can spare that WE are short of, and that are worth the trip —
   *  ranked by what one unit GAINS us landed over this road. */
  imports: string[];
  /** The mirror: what we can spare that they need, same reading. */
  exports: string[];
}

/** ⚖️ G3 — ONE ROW of the ranking: the good AND the weight it was ranked by. */
export interface ComplementaryRow {
  good: string;
  /**
   * ⚖️ THE LANDED WEIGHT, 0..1 — the needing side's own shortage times the
   * share of a load that survives the leg (`freightArrivalFraction`), NOT the
   * raw shortage (import-displacement round, Stage B).
   *
   * The ADMISSION test is still the raw shortage against `BARTER_WANT_MIN`, so
   * membership of the list is unchanged; what the road eats is priced into the
   * BID instead. A durable good's fraction is 1, so its weight IS its
   * shortage; a staple over a long leg weighs lower than its hunger, because a
   * cart of it arrives smaller than it left.
   *
   * ⚖️ NO LONGER THE RANKING KEY (trade-topology round, R-2): `advantageS` is.
   * This is RETAINED — unchanged, to the bit — because it is the row's 0..1
   * reading and several readers want a fraction rather than a duration.
   */
  want: number;
  /**
   * ⚖️ WHAT THE ROW IS WORTH, in HAND-SECONDS PER UNIT (trade-topology round,
   * R-1/R-2): `local − landed`, i.e. what doing without one unit costs the
   * needing side, minus what having one landed over `legM` costs it.
   *
   *   local     = localUnitCostS(needing side's shortage)
   *   producer  = localUnitCostS(sparing side's shortage) — their own books,
   *               and the NAMED SEAT the regional skill slice adds to
   *   landed    = (producer + freight) / delivered
   *
   * Always > 0 on a row that is on a list: the sign IS the third membership
   * gate (`netValueS`'s own sign), so a good the road makes dearer than doing
   * without never appears at all. Unlike `want` it is a DURATION, which is
   * what lets rows of one lane sum into a number comparable with another
   * lane's (`laneValueS`) and with every other cost the engine keeps.
   */
  advantageS: number;
}

/** The ranking BEFORE it is flattened to two name lists. */
export interface ComplementaryRanking {
  imports: ComplementaryRow[];
  exports: ComplementaryRow[];
}

/**
 * ⚖️ THE PAIR'S COMPLEMENTARY SCARCITY — their surplus ∩ our shortage, and the
 * mirror, each filtered by what survives `legM` of road.
 *
 * PERSPECTIVE CONSISTENT by construction, exactly as `barterRatio` is: the
 * import list computed from our side is the SAME LIST the partner's own call
 * produces as its export list — same predicate, same ranking key, same input
 * order — so "A's imports from B ⊆ B's exports to A" cannot drift. The two
 * calls must be handed the same `goods`, `legM` and `scale`: those are the
 * PAIR's facts, not one side's.
 *
 * DETERMINISTIC: pure arithmetic over the two signal reads and the freight
 * rows; ranked by landed advantage, ties breaking toward the earlier good in
 * `goods`, the same rule `defaultTakeGood` uses.
 */
export function complementaryTrade(
  us: BarterSignals,
  them: BarterSignals,
  goods: readonly string[],
  legM: number,
  scale: WorldScale,
): ComplementaryTrade {
  const r = complementaryRanking(us, them, goods, legM, scale);
  return { imports: r.imports.map((x) => x.good), exports: r.exports.map((x) => x.good) };
}

/**
 * ⚖️ G3 — THE SAME READ, WITH ITS OWN EVIDENCE KEPT. `complementaryTrade`
 * above is this function's names-only projection, so there is exactly ONE
 * ranking rule and the two can never disagree about order.
 *
 * The `want` was always computed here and thrown away on the last line, and
 * the caravan then split its payload EVENLY across the survivors — a hold
 * that ignores which shortage is worse. A payload is finite capacity many
 * goods bid for (§0's third pressure), so the bid needs its number; keeping
 * it costs nothing and is the whole of `importUnitsPerVisit`'s weighting.
 *
 * ⚖️ AND THE BID IS THE LANDED ONE (import-displacement round, Stage B): the
 * weight is `want × freightArrivalFraction`, so a good the road half-eats bids
 * half as hard for the same hold.
 *
 * ⚖️ AND THE BID IS NOW A PRICE (trade-topology round, R-1/R-2): `advantageS`,
 * in hand-seconds per unit, off landed-cost.ts. It is the RANKING KEY and the
 * third membership gate, and it subsumes Stage B's re-rank rather than
 * repeating it — the same `deliveredFraction` divides the landed cost, so a
 * good the road half-eats is still twice as dear, and now the freight and the
 * PRODUCER's own cost are in the number too.
 *
 * WHICH ARM EACH PARTNER KIND TAKES — the answer is NEITHER, and that is the
 * design. A cluster neighbour hands in real books (`townShortage`); a
 * condensed city or an `away:` stub hands in `stubPartnerSignals`' proxy.
 * Both are a `BarterSignals`, i.e. both answer `shortage(good)`, so BOTH are
 * priced by the identical line below: a partner's cost per unit is
 * `localUnitCostS(their shortage)` whoever they are. The only difference is
 * where that shortage came from, and this module is not entitled to know —
 * which is exactly what keeps a stub from needing its own pricing arm.
 *
 * TIES break by input index (the `defaultTakeGood` rule), unchanged. Two goods
 * tie in `advantageS` only when their shortages AND their freight rows agree.
 */
export function complementaryRanking(
  us: BarterSignals,
  them: BarterSignals,
  goods: readonly string[],
  legM: number,
  scale: WorldScale,
): ComplementaryRanking {
  const rank = (need: BarterSignals, spare: BarterSignals): ComplementaryRow[] => {
    const rows: Array<ComplementaryRow & { i: number }> = [];
    const seen = new Set<string>();
    goods.forEach((good, i) => {
      if (seen.has(good)) return;
      seen.add(good);
      const theirs = clamp01(spare.shortage(good));
      if (theirs >= BARTER_WANT_MIN) return; // not spare
      const want = clamp01(need.shortage(good));
      if (want < BARTER_WANT_MIN) return; // nobody on this side wants it
      if (!freightSurvivesLeg(good, legM, scale)) return; // the road eats it
      // ⚖️ IS IT WORTH MAKING THE TRIP FOR? (R-2) What one unit relieves here,
      // minus what one unit costs landed — the producer's own books plus the
      // road, over what survives it. Non-positive ⇒ the trade destroys value
      // and the good is not on this lane, however badly it is wanted.
      const advantageS = laneAdvantageS(
        localUnitCostS(want, scale),
        landedUnitCostS({
          legM,
          scale,
          freight: freightOf(good),
          producerUnitCostS: localUnitCostS(theirs, scale),
        }),
      );
      if (!(advantageS > 0)) return;
      // ⚖️ LANDED, NOT WISHED FOR (Stage B). The 0..1 weight is retained for
      // readers that want a fraction; the ranking key is the price above.
      rows.push({
        good,
        want: want * freightArrivalFraction(good, legM, scale),
        advantageS,
        i,
      });
    });
    rows.sort((a, b) => b.advantageS - a.advantageS || a.i - b.i);
    return rows.map((r) => ({ good: r.good, want: r.want, advantageS: r.advantageS }));
  };
  return { imports: rank(us, them), exports: rank(them, us) };
}

// ---------------------------------------------------------------------------
// ⑤ THE LANE RANKING — which NEIGHBOUR, not just which goods
// ---------------------------------------------------------------------------

/** One neighbour we could bind, as the pricer needs to see it: a key, the
 *  road between us, and whatever reads its books (real or stub — see
 *  `complementaryRanking`'s header on why one arm serves both). */
export interface LaneCandidate {
  key: string;
  /** One-way ROAD metres. A candidate with no road of its own is priced at
   *  the `away:` fiction's own distance by the caller (R-6) — never here. */
  legM: number;
  signals: BarterSignals;
}

/** One priced lane: what it would carry, dealt, and what that is worth. */
export interface LaneRank {
  key: string;
  legM: number;
  /** Σ advantage × units over the IMPORT rows — hand-seconds per visit. */
  valueS: number;
  imports: ComplementaryRow[];
  exports: ComplementaryRow[];
  /** The visit's hold, dealt across the import goods by advantage. */
  units: Map<string, number>;
}

/**
 * ⚖️ RANK THE NEIGHBOURS BY WHAT A LANE TO EACH IS WORTH (trade-topology
 * round, R-3) — the read a bind decision is made from, and nothing else:
 * pure, no session, no places, no side effects.
 *
 * The value of a lane is the value of what it BRINGS US (imports only). Our
 * exports are the partner's own gain and are ranked, by perspective
 * consistency, in the partner's own call — counting them here would double
 * every lane by a number nobody on this side pays.
 *
 * DISTANCE NEVER FORMS A LANE. It is already inside `valueS` twice (freight
 * seconds, and what the road eats), so it needs no separate term; it appears
 * below only to break ties between lanes of EQUAL value, nearest first, and
 * then the caller's own order. A candidate with no complementary good at all
 * scores 0 and still appears — a bind with an empty crate is a real outcome
 * (R-4), and dropping it would resurrect the authored fallback in a world
 * that has neighbours.
 */
export function rankLanes(
  us: BarterSignals,
  candidates: readonly LaneCandidate[],
  goods: readonly string[],
  scale: WorldScale,
  allotment: number,
): LaneRank[] {
  const ranked = candidates.map((c, i) => {
    const pair = complementaryRanking(us, c.signals, goods, c.legM, scale);
    // The hold, dealt by advantage — the SAME `allocate` call trade.ts's
    // `allotmentSplit` wraps, so a lane's preview and the caravan's own split
    // are one definition and cannot disagree.
    const shares = allocate({
      mode: "largest-remainder",
      weights: pair.imports.map((r) => r.advantageS),
      total: allotment,
    });
    const units = new Map<string, number>(
      pair.imports.map((r, j) => [r.good, shares[j] ?? 0]),
    );
    const valueS = laneValueS(
      pair.imports.map((r) => ({
        good: r.good,
        advantageS: r.advantageS,
        units: units.get(r.good) ?? 0,
      })),
    );
    return { key: c.key, legM: c.legM, valueS, imports: pair.imports, exports: pair.exports, units, i };
  });
  ranked.sort((a, b) => b.valueS - a.valueS || a.legM - b.legM || a.i - b.i);
  return ranked.map(({ i: _i, ...lane }) => lane);
}
