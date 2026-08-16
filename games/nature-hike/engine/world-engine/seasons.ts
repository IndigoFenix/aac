// shared/world-engine/seasons.ts
//
// SEASONALITY — the global orbital phase and the yield curve it drives
// (settlement-emergence.md §6, step ②).
//
// The design constraint everything here serves: **fields keep resting; only
// the DRAW cycles.** The phase is a pure function of the world clock and the
// `revolution` dial — no per-cell dynamic field, no scheduler wake, nothing
// accumulating flux at a boundary. Fertility stays a settled substrate value;
// consumers (charters, harvests, forage) multiply their draw against it by
// `seasonYield(phase)`. Idle-safety is untouched because seasonality adds no
// state at all — it is the one sanctioned indefinite cycle (a clock) read
// closed-form.
//
// Without a lean season there is no reason to store: this curve is what makes
// the granary invariant (scale.ts GRANARY_MEALS_MIN, §4c) a live constraint
// rather than a decorative number — and the lean-window deficit it creates is
// EXACTLY `leanSeasonMeals(scale)` by construction (asserted in tests).
//
// The curve is insolation-shaped: yield ∝ max(0, cos(πL) − cos(2π·phase)),
// normalized so the ANNUAL MEAN IS 1. Mean-1 is the load-bearing choice —
// a seasonal world grows the same annual total as the aseasonal one, so
// anchored capacities and Malthus plateaus keep their meaning; the season
// only REDISTRIBUTES the year into a surplus to bank and a deficit to
// survive. `leanFraction` (a WorldScale property, spec-declared) is the
// share of the year at exactly zero yield.
//
// Phase convention (calendar-shaped): 0 = midwinter (the trough), 0.5 =
// midsummer (the peak). The lean window straddles the year boundary —
// [1 − L/2, 1) ∪ [0, L/2) — like winter straddles New Year.

import { yearGameDays, yearLengthS, type WorldScale } from "./scale.js";

/** Orbital phase in [0,1) at a game-day count. `phase0` is the phase at
 *  day 0 — a world founds itself in spring by declaring 0.25, not by
 *  shifting its calendar. */
export function seasonPhaseAtDay(scale: WorldScale, day: number, phase0 = 0): number {
  const p = (phase0 + day / yearGameDays(scale)) % 1;
  return p < 0 ? p + 1 : p;
}

/** Orbital phase in [0,1) at a real-seconds world clock. */
export function seasonPhaseAtS(scale: WorldScale, tS: number, phase0 = 0): number {
  const p = (phase0 + tS / yearLengthS(scale)) % 1;
  return p < 0 ? p + 1 : p;
}

/** Annual mean of the un-normalized curve max(0, c − cosθ), c = cos(πL) —
 *  the normalizer that makes the yield's annual mean exactly 1. */
function curveMean(leanFraction: number): number {
  const c = Math.cos(Math.PI * leanFraction);
  return c * (1 - leanFraction) + Math.sin(Math.PI * leanFraction) / Math.PI;
}

/**
 * THE SEASONAL YIELD MULTIPLIER at a phase, for a lean fraction.
 *
 *   yield(p) = max(0, cos(πL) − cos(2πp)) / M(L)      mean over the year = 1
 *
 * Zero for exactly `leanFraction` of the year (centred on phase 0,
 * midwinter); peaks at midsummer (phase 0.5) at `seasonPeakYield`.
 * Continuous everywhere — the shoulders (sow, harvest) ramp, which is what
 * gives crop stages their look and trade its timing. At L = 0 the curve is
 * 1 − cos(2πp): even a leanless world keeps an insolation swing (only its
 * zero measure vanishes) — a world wanting FLAT yield is a world without
 * this function in its draw path, not a special case inside it.
 */
export function seasonYieldAt(phase: number, leanFraction: number): number {
  const L = Math.max(0, Math.min(0.95, leanFraction));
  const m = curveMean(L);
  if (m <= 0) return 0;
  const p = ((phase % 1) + 1) % 1;
  return Math.max(0, Math.cos(Math.PI * L) - Math.cos(2 * Math.PI * p)) / m;
}

/** The yield multiplier under a world's scale (reads its leanFraction). */
export function seasonYield(scale: WorldScale, phase: number): number {
  return seasonYieldAt(phase, scale.leanFraction);
}

/** Midsummer's multiplier — the fat-season peak the granary is banked at.
 *  L = 0.4 ⇒ ≈ 2.68: a harvest is worth nearly three flat months. */
export function seasonPeakYield(leanFraction: number): number {
  const L = Math.max(0, Math.min(0.95, leanFraction));
  const m = curveMean(L);
  return m > 0 ? (Math.cos(Math.PI * L) + 1) / m : 0;
}

/**
 * CROP STAGES — the year as a child can say it (the teaching layer:
 * plant / grow / harvest / wait). The lean window is `stubble`; the growing
 * window splits in thirds. Pure vocabulary over the phase — nothing in the
 * engine branches on the stage name.
 */
export type SeasonStage = "sow" | "green" | "harvest" | "stubble";

export function seasonStageAt(phase: number, leanFraction: number): SeasonStage {
  const L = Math.max(0, Math.min(0.95, leanFraction));
  const p = ((phase % 1) + 1) % 1;
  if (p < L / 2 || p >= 1 - L / 2) return "stubble";
  const u = (p - L / 2) / (1 - L); // 0..1 across the growing window
  return u < 1 / 3 ? "sow" : u < 2 / 3 ? "green" : "harvest";
}

/** The conventional founding phase — early spring, sowing ahead, a whole
 *  fat season before the first winter. (A default, not a law: tri worlds
 *  take it as `seasons.phase0`'s fallback.) */
export const SPRING_PHASE = 0.25;
