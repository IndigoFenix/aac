/**
 * money.ts — THE NUMERAIRE (nations arc P3/E4 — money as an emergent
 * unit of account, nations-and-empires.md §4).
 *
 * MONEY'S IDENTITY (user law, 2026-07-19): currency is the creature-level
 * favor DEBT made visible, concrete, and universal within a culture that
 * accepts the exchange medium. Nothing here invents a price mechanism —
 * the ⑤ barter pair-worth math is UNCHANGED; a price is simply worth
 * expressed against ONE common good (the economy doc's `numeraire`).
 *
 * EMERGENCE, not a switch: barter stays the law until the town's trade
 * network is dense enough that a common medium pays — the threshold is a
 * count of DISTINCT ACTIVE TRADE RELATIONSHIPS (standing barter pairs ×
 * partners). Below it, quotes stay goods-for-goods; at or above it, the
 * clerk's default take-side becomes the numeraire and terms read as
 * prices ("3 wood for 2 metal"). Direct pairs remain legal forever —
 * gradual by construction, a barter-only village is never forced onto
 * coin.
 *
 * Pure arithmetic over ⑤'s signals; deterministic; kernel-layered.
 */

import { barterWorth, type BarterSignals } from "./barter.js";
import type { TransferAgreement } from "./transfer.js";

/** Distinct active trade relationships before a numeraire pays its way:
 *  with three or more standing flows, goods-for-goods bookkeeping has
 *  more pairs than a common medium has edges. */
export const NUMERAIRE_PAIRS_THRESHOLD = 3;

/**
 * Count the DISTINCT trade relationships alive in a ledger: one per
 * (partner, give-good, take-good) barter row still standing (done/failed
 * rows are history). Deterministic.
 */
export function activeTradePairs(agreements: readonly TransferAgreement[]): number {
  const seen = new Set<string>();
  for (const a of agreements) {
    if (!a.barter) continue;
    if (a.status === "done" || a.status === "failed") continue;
    seen.add(`${a.barter.partnerKey}|${a.barter.giveGood}|${a.barter.takeGood}`);
  }
  return seen.size;
}

/**
 * Is the numeraire IN FORCE here? Needs a declared medium (economy doc),
 * and a trade network at threshold. The medium must not be priced against
 * itself — a numeraire-less economy or a thin network reads false and
 * everything stays barter.
 */
export function numeraireActive(
  numeraire: string | null,
  agreements: readonly TransferAgreement[],
  threshold = NUMERAIRE_PAIRS_THRESHOLD,
): boolean {
  return numeraire !== null && activeTradePairs(agreements) >= threshold;
}

/**
 * The PRICE of `good` in numeraire units: the ⑤ pair-worth ratio aimed at
 * the medium (worth(good) / worth(numeraire)), clamped to the same [1/3,3]
 * band spoken quotes always lived in. Same math, one fixed denominator —
 * that is the whole trick.
 */
export function priceInNumeraire(
  good: string,
  numeraire: string,
  us: BarterSignals,
  them: BarterSignals,
): number {
  if (good === numeraire) return 1;
  const w = (g: string) => barterWorth(g, us, them);
  const r = w(good) / Math.max(1e-9, w(numeraire));
  return Math.max(1 / 3, Math.min(3, r));
}

/**
 * A SPEAKABLE integer price pair for the board words (one/two/three):
 * `give` units of `good` for `take` units of the numeraire — smallest
 * whole pair within the quantity vocabulary, best-fit to the real ratio
 * (the ⑤ barterQuote discipline: SPOKEN TERMS = EXECUTED TERMS).
 */
export function priceQuote(
  good: string,
  numeraire: string,
  us: BarterSignals,
  them: BarterSignals,
): { give: number; take: number } {
  const r = priceInNumeraire(good, numeraire, us, them); // numeraire per unit good
  let best = { give: 1, take: 1 };
  let bestErr = Infinity;
  for (let give = 1; give <= 3; give++) {
    for (let take = 1; take <= 3; take++) {
      const err = Math.abs(take / give - r);
      if (err < bestErr - 1e-12) {
        bestErr = err;
        best = { give, take };
      }
    }
  }
  return best;
}
