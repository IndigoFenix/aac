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
 *     would be a lie the caravan then quietly breaks.
 *
 * WHY A SIBLING OF barter.ts RATHER THAN A SECTION OF IT. `bindPartner`
 * (trade.ts) is the seam that derives a route's two lists, and the module
 * graph already runs barter → transfer → trade. Putting the read in barter.ts
 * would have closed that into a require cycle; this leaf imports only
 * freight.ts and scale.ts (leaves themselves) plus barter's `BarterSignals`
 * TYPE, which erases. `BARTER_WANT_MIN` lives here for the same reason and is
 * re-exported under its established name by barter.ts — ONE definition, the
 * name every caller already uses.
 */

import {
  carryReachM,
  deliveredFraction,
  freightOf,
} from "../../freight.js";
import { dailyTravelM, type WorldScale } from "../../scale.js";
// TYPE ONLY (erased at build) — barter.ts owns the named interface; this leaf
// borrows the shape without taking a runtime edge back up the graph.
import type { BarterSignals } from "./barter.js";

/** Below this, a town doesn't WANT a good ("they have enough wood").
 *  Re-exported by barter.ts as `BARTER_WANT_MIN` — its public name. */
export const BARTER_WANT_MIN = 0.15;

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

/** The two sides of one pair's trade, best first. */
export interface ComplementaryTrade {
  /** Goods THEY can spare that WE are short of — ranked by our own need. */
  imports: string[];
  /** The mirror: what we can spare that they need — ranked by their need. */
  exports: string[];
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
 * rows; ties break toward the earlier good in `goods`, the same rule
 * `defaultTakeGood` uses.
 */
export function complementaryTrade(
  us: BarterSignals,
  them: BarterSignals,
  goods: readonly string[],
  legM: number,
  scale: WorldScale,
): ComplementaryTrade {
  const rank = (need: BarterSignals, spare: BarterSignals): string[] => {
    const rows: Array<{ good: string; want: number; i: number }> = [];
    const seen = new Set<string>();
    goods.forEach((good, i) => {
      if (seen.has(good)) return;
      seen.add(good);
      if (clamp01(spare.shortage(good)) >= BARTER_WANT_MIN) return; // not spare
      const want = clamp01(need.shortage(good));
      if (want < BARTER_WANT_MIN) return; // nobody on this side wants it
      if (!freightSurvivesLeg(good, legM, scale)) return; // the road eats it
      rows.push({ good, want, i });
    });
    rows.sort((a, b) => b.want - a.want || a.i - b.i);
    return rows.map((r) => r.good);
  };
  return { imports: rank(us, them), exports: rank(them, us) };
}
