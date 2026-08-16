// shared/world-engine/kernel/town/pricing.ts
//
// THE CURRENCY — hand-seconds (scope-behaviors.md §3, step ④ of
// scope-unification.md).
//
// User law (2026-08-02): "we don't need to hard-code specific behaviors for
// how creatures prioritize the movement of objects — only the costs and goals
// of each action. … Everything becomes an economic decision."
//
// ── WHAT THIS MODULE IS ───────────────────────────────────────────────────
// The four VerbCost terms live in scope-shape.ts; this is the one place that
// PRICES them, so a body's market trip and a caravan's route are the same
// arithmetic at different constants. Deliberately tiny: the 2026-08-02
// surveys found the engine already owns every input (distances, dwell times,
// fill clocks, shortages) — what was missing is the subtraction. Rung-specific
// assembly (which distance, which dwell, what urgency means for a meter vs a
// stock row) belongs to the callers; the formulas live once, here.
//
// 🚨 UNITS. Everything is SECONDS OF A HAND'S TIME. The value side converts
// through the drive's own fill clock (`needFillS`) — the same normalization
// `serviceRadiusM` already uses to size districts: a journey is expensive
// relative to the need it serves, which is why the same metres are cheap for
// a caravan and dear for a thirst.

import { costTotalS, type VerbCost } from "./scope-shape.js";
import type { WorldScale } from "../../scale.js";

/** Walking time for a leg. Zero/negative speed prices the leg unreachable. */
export function journeyTimeS(distM: number, speedMps: number): number {
  if (!(speedMps > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, distM) / speedMps;
}

/** Assemble a VerbCost from whichever terms the caller can price. Missing
 *  terms are 0 — `forgoneS` in particular starts life at 0 everywhere
 *  (scope-behaviors.md §3: it is produced by the argmax itself, later). */
export function priceOf(parts: Partial<VerbCost>): VerbCost {
  return {
    journeyS: parts.journeyS ?? 0,
    handsS: parts.handsS ?? 0,
    spoilageS: parts.spoilageS ?? 0,
    forgoneS: parts.forgoneS ?? 0,
  };
}

/**
 * VALUE of serving a drive: urgency × the drive's own fill clock. A
 * full-blown hunger (urgency 1) is worth a fill-cycle's worth of walking,
 * because that is what the engine already believes when it derives district
 * radii from fill clocks. Urgency is clamped to [0, 1] — a decider supplies
 * how far past its threshold the drive is; over-urgent never buys more than
 * the whole clock.
 */
export function driveValueS(urgency01: number, needFillS: number): number {
  const u = Math.max(0, Math.min(1, urgency01));
  return u * Math.max(0, needFillS);
}

/**
 * VALUE of units of a good with no live drive attached (a deposit, a
 * provision, a haul): each unit is worth the scarcity-weighted share of the
 * fill clock it serves. `unitsPerFill` is how many units one fill cycle
 * consumes (a pantry's daily draw, a bill's blocks) — so a unit of a
 * plentiful good rounds to nothing and a unit of a famine good approaches a
 * day's walking, which is the same judgement barter's `worth` makes with the
 * same `shortage` input.
 */
export function goodsValueS(
  units: number,
  shortage01: number,
  needFillS: number,
  unitsPerFill: number,
): number {
  const s = Math.max(0, Math.min(1, shortage01));
  const perUnit = (s * Math.max(0, needFillS)) / Math.max(1, unitsPerFill);
  return Math.max(0, units) * perUnit;
}

/** The comparison. Positive = worth doing; the argmax over candidates is the
 *  PREFER primitive, and the sign is the WORTHWHILE gate. */
export function netValueS(valueS: number, cost: VerbCost): number {
  return valueS - costTotalS(cost);
}

/**
 * ⚖️ THE TOWN RUNG'S FILL CLOCK (economy arc batch 2) — the STREET DAY.
 *
 * `goodsValueS` needs a fill clock to price a unit, and at the BODY rung that
 * clock is the drive's own (`needFillS`: one ration serves one hunger cycle).
 * A town has no hunger meter; what it has is a DAY — every stock number the
 * town rung owns is quoted per street day (`GoodSpec.perCapitaDaily` is
 * "units one person draws per street day", `FoundedBuilding.buildDays` is
 * street-days of work, the dawn shelf refills once a day). So one unit of a
 * good the town is completely out of is worth one day of a hand's time, and
 * everything else is that scaled by shortage. Named once here so a poster, a
 * shift price and a build-work value cannot drift apart.
 */
export function townFillS(scale: WorldScale): number {
  return Math.max(1, scale.dayLengthS);
}

/**
 * ⚖️ WHAT PULLING A SCHEDULED WORKER OFF SHIFT WOULD DESTROY, in hand-seconds
 * — the ATTENDANCE MODEL READ FORWARD (economy arc batch 2, L2).
 *
 * THE DERIVATION, end to end, and every step of it is already shipped:
 *
 *   1. `noteAbsence` (roster.ts) tallies the SECONDS a scheduled body spends
 *      away from its shift. A claim that occupies the body for `occupiedS`
 *      seconds of its window adds exactly `occupiedS` to that tally.
 *   2. `attendanceFactor` turns the tally into a multiplier:
 *      `1 − absent / (staff × windowLen × daySec)`. So one absent second
 *      costs the work `1 / (staff × windowLen × daySec)` of its output.
 *   3. `producerAttendance` multiplies the work's good onto tomorrow's dawn
 *      shelf by that factor, so the units that never appear are
 *      `unitsPerDay × occupiedS / (staff × windowLen × daySec)`.
 *   4. `goodsValueS` prices one of those units at the town's own fill clock
 *      ({@link townFillS}), weighted by how short the town already is.
 *
 * ⚠️ ORACLE, NEVER DECIDER (scope-behaviors §6): nothing here writes an
 * absence. The attendance controller stays a controller — this only ASKS it
 * what a claim would cost before the claim is made, so the decision and the
 * consequence are the same arithmetic instead of two guesses.
 *
 * ⚠️ THE FLOOR IS DELIBERATELY NOT APPLIED. `attendanceFactor` clamps at
 * `ATTENDANCE_FLOOR`, so a work already abandoned all day loses nothing more
 * from one more absence; charging the linear rate anyway prices the MARGINAL
 * claim as if the crew were whole, which errs toward protecting the shift.
 * Reading the live tally here would make the price depend on who was pulled
 * earlier today — a decision that remembers grudges. It stays memoryless.
 *
 * Zero whenever the shift is not real (no staff, no window, no output) or the
 * good is not short — a town in surplus does not protect a worker whose
 * marginal unit is worth nothing, which is the honest reading.
 */
export function shiftForgoneS(p: {
  /** Units of its good this ONE work puts out in a street day. */
  unitsPerDay: number;
  /** Souls scheduled on the work's shift (`assignTownJobs` rows). */
  staff: number;
  /** Shift length in street-day fractions (`Duty.window.len`). */
  windowLen: number;
  /** Seconds in the street day the attendance model buckets by. */
  daySec: number;
  /** Seconds the claim would hold the body (its plan's journey + hands). */
  occupiedS: number;
  /** Hand-seconds one unit of the good is worth — `goodsValueS(1, …)`. */
  unitValueS: number;
}): number {
  const scheduledSec = Math.max(0, p.staff) * Math.max(0, p.windowLen) * Math.max(0, p.daySec);
  if (!(scheduledSec > 0) || !(p.unitsPerDay > 0) || !(p.occupiedS > 0)) return 0;
  return (p.unitsPerDay / scheduledSec) * p.occupiedS * Math.max(0, p.unitValueS);
}
