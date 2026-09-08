/**
 * cohort-needs.ts — WHAT A BODY METER BECOMES WHEN ITS PERSON DEMOTES TO A
 * STATISTIC (body-anchored-needs round, design point D5).
 *
 * PURE arithmetic: no host, no clock, no RNG, no world. The cohort tier
 * conserves exactly two things today — SOULS and UNITS (population.ts's own
 * header) — and everything else about a person is destroyed at demote and
 * re-derived at promote. A need meter is neither a soul nor a unit: it is
 * *the record that food was eaten* (the item-conservation law), so it can
 * neither ride `stockOf` nor simply vanish. What it becomes instead is a
 * HOUSEHOLD MEAN DEFICIT per need, stamped with the fold day, and what comes
 * back out is that mean plus WHAT THE POOL FAILED TO FEED.
 *
 * ⚖️ THE TWO ARMS, and why they differ (round ruling U7):
 *
 *  · COMMODITY-BACKED rows (`hunger:food`, `thirst:water` — a need whose
 *    satisfier is a good the pool actually books) have an honest record of
 *    whether the folded soul ate: `CohortRow.needs[good]`, the served
 *    fraction `cohortRatesStep` writes every window. A pool that was fed
 *    (sat 1) fed its folded members too, so nothing accrues; a pool that
 *    starved (sat 0) starved them, and the meter climbs at exactly the rate
 *    it would have climbed on the body — `elapsed / needFillDays`. Partial
 *    service accrues the unfed fraction. This is the ONE place a statistic
 *    becomes a body meter again, and it must not invent hunger the books
 *    never recorded.
 *
 *  · EVERY OTHER row (energy, social, fun, hygiene, waste, dress …) has no
 *    commodity behind it, so the pool holds no record at all — the household
 *    slept, talked and washed unobserved, and the honest answer is that the
 *    meter comes back no worse than it went in, capped by the same 0.7 the
 *    reveal seed already spreads a freshly-shown household's motives by
 *    (quest-host's tick block). It is a CAP, not a floor: a household that
 *    folded content promotes content.
 *
 * NOTHING ABOVE THE FOLD MEAN APPEARS EXCEPT UNFED TIME. That sentence is
 * the whole conservation statement for this payload, and both arms obey it.
 *
 * Kernel layering: pure data + arithmetic; the only import is the pacing
 * anchor every rung already shares (`NEED_FILL_DAYS`, the same table
 * `needRate` and `stepBandDay` read).
 */

import { NEED_FILL_DAYS, type NeedKey } from "../../scale.js";

/**
 * The non-commodity unfold CAP — the existing reveal-seed spread factor
 * (quest-host seeds a freshly-shown member's non-hunger motives at
 * `hash × 0.7`), reused rather than re-invented. A promoted household is
 * never more rested than a revealed one.
 *
 * NOT a new pacing constant: it moves no rate and prices nothing. It is the
 * ceiling on a meter the pool kept no books for.
 */
export const NON_COMMODITY_UNFOLD_CAP = 0.7;

/**
 * The `NeedKey` behind a COMMODITY-BACKED template key, or `null`.
 *
 * The shape is `<needKey>:<goodKey>` — `hungerTemplate`/`thirstTemplate`
 * spell `hunger:food` / `thirst:water`, and the good half is exactly how
 * `CohortRow.needs` is keyed (`cohortRatesStep` writes `row.needs[g]` for
 * each `rates.perCapita` good, and the host's `cohortDistrictRates` fills
 * that from `g.good.key`). A colon alone is not enough: `provision:food`
 * and `adopt:*` share the shape but name no drive in `NEED_FILL_DAYS`, so
 * they take the non-commodity arm like any other errand row.
 */
export function commodityNeedKeyOf(tplKey: string): NeedKey | null {
  const i = tplKey.indexOf(":");
  if (i <= 0 || i >= tplKey.length - 1) return null;
  const head = tplKey.slice(0, i);
  return head in NEED_FILL_DAYS ? (head as NeedKey) : null;
}

/** The GOOD half of a commodity-backed template key (`hunger:food` → `food`)
 *  — the key `CohortRow.needs` quotes its satisfaction under. `null` for a
 *  row with no commodity behind it. */
export function needGoodKeyOf(tplKey: string): string | null {
  if (commodityNeedKeyOf(tplKey) === null) return null;
  return tplKey.slice(tplKey.indexOf(":") + 1);
}

/**
 * FOLD: N members' meter rows → one household MEAN per template key.
 *
 * The mean is taken over THE MEMBERS THAT HAD THE ROW, not over the
 * household — a row only exists for a body that was actually ticked, and
 * averaging a present meter against absent ones would report a household
 * less hungry than any of its people. Keys come back in sorted order so the
 * serialized payload is byte-stable across replays (the cohort tier's own
 * determinism law). Non-finite readings are dropped, never propagated: a
 * NaN reaching `row.pop` poisons the population.
 */
export function foldNeedMeans(
  levelsPerMember: ReadonlyArray<Readonly<Record<string, number>>>,
): Record<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const row of levelsPerMember) {
    for (const [key, level] of Object.entries(row)) {
      if (!Number.isFinite(level)) continue;
      const e = sums.get(key) ?? { sum: 0, n: 0 };
      e.sum += level;
      e.n += 1;
      sums.set(key, e);
    }
  }
  const out: Record<string, number> = {};
  for (const key of [...sums.keys()].sort()) {
    const e = sums.get(key)!;
    if (e.n > 0) out[key] = Math.max(0, e.sum / e.n);
  }
  return out;
}

export interface UnfoldNeedInput {
  /** The household mean this row folded at (threshold units, 1 = firing). */
  mean: number;
  /** The need TEMPLATE key (`hunger:food`, `energy`, …). */
  key: string;
  /** The pool's satisfaction for this row's commodity, 0..1 (`CohortRow.needs[good]`).
   *  1 = the pool fed it fully — the honest default when the books say nothing. */
  sat: number;
  /** Town street-days between the fold stamp and now (`CohortHouse.foldedDay`). */
  elapsedDays: number;
  /** `WorldScale.metabolism` — the same dial `needFillDays` divides by. */
  metabolism: number;
}

/**
 * UNFOLD one row: the mean the household folded at, plus what the pool
 * failed to feed while it was a statistic (U7).
 *
 *   commodity-backed:  mean + (1 − sat) × elapsedDays / (NEED_FILL_DAYS[k] / metabolism)
 *   everything else:   min(mean, NON_COMMODITY_UNFOLD_CAP)
 *
 * The divisor IS `needFillDays(scale, k)` written out — this is an ACCRUAL
 * (time × rate), the same quantity `needRate` quotes per second, so
 * metabolism enters exactly as it does there. (Contrast `ingestMeterAfter`,
 * where metabolism must NOT enter: that one denominates a RATION, not time.)
 *
 * At `elapsedDays === 0` — or against a fully-fed pool — this is the
 * identity on the mean, which is the round-trip pin.
 */
export function unfoldNeedLevel(input: UnfoldNeedInput): number {
  const mean = Number.isFinite(input.mean) ? Math.max(0, input.mean) : 0;
  const needKey = commodityNeedKeyOf(input.key);
  if (needKey === null) return Math.min(mean, NON_COMMODITY_UNFOLD_CAP);
  const metabolism = Number.isFinite(input.metabolism) ? Math.max(0, input.metabolism) : 0;
  const fillDays = NEED_FILL_DAYS[needKey] / metabolism; // = needFillDays(scale, needKey)
  const elapsed = Number.isFinite(input.elapsedDays) ? Math.max(0, input.elapsedDays) : 0;
  const sat = Number.isFinite(input.sat) ? Math.max(0, Math.min(1, input.sat)) : 1;
  // metabolism 0 ⇒ fillDays Infinity ⇒ nothing accrues (a world with no
  // metabolism has no appetite), and no NaN ever leaves this function.
  if (!(fillDays > 0) || !Number.isFinite(fillDays)) return mean;
  return Math.max(0, mean + ((1 - sat) * elapsed) / fillDays);
}
