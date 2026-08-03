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
