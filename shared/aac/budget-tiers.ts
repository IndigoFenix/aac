// shared/aac/budget-tiers.ts
//
// Price tiers for the AAC budget meter. A tier is just a NAMED budget = a scale
// factor on a common set of window caps (regen scales with the cap, so every
// tier has the identical leaky-bucket SHAPE, only larger). This keeps the
// $30/mo demo and the $250/mo near-constant-use plan on one mechanism: the
// scale is simply price ÷ the Demo price.
//
// Window caps are expressed as { hours, ceiling } and the regen is DERIVED
// (`perHour = ceiling / hours`) so a window can never drift from its rolling
// span. Base caps + the default tier are overridable via env so pricing/limits
// move without a deploy. Units are credits = USD (1:1 today; see cost-helpers).
// See planning-docs/aac-budget-tiers-spec.md §3-4.
//
// THE MONTHLY BOUND (2026-08-27). A leaky bucket with ceiling C and regen r
// admits, over any span S of continuous use starting full, C + r·S — the whole
// bucket at once, then regen for the rest of the span. With r = C/hours that is
// C × (1 + S/hours), NOT C. The old 14-day anchor ($120 at Premium) therefore
// admitted $120 × (1 + 31/14) = $386 in a 31-day month against a $250 price,
// which is how a student's month came in over the tier. The anchor's ceiling is
// no longer a free parameter: it is pinned so that its 31-day admission equals
// the tier price exactly (`ceilingForMonthlyBound`), and an env override may
// lower it but never raise it. `monthlyBound()` reports the resulting cap and
// the tests hold it ≤ price for every tier.

import type { BudgetWindow } from "./budget-meter.js";

/** A budget window before tier scaling: a rolling span + its cap (credits). */
export interface WindowDef {
  key: string;
  /** Rolling span in hours; regen = ceiling / hours. */
  hours: number;
  /** Spend cap (credits = USD) for this window AT THE 1× (Demo) tier. */
  ceiling: number;
}

export interface BudgetTier {
  key: string;
  /** Headline monthly price (USD). The anchor window is derived from it, so
   *  this IS the monthly cap, not just a label. */
  priceMonthly: number;
  /** Multiplier applied to every base window cap (and thus its regen). */
  scale: number;
}

// This module is shared between the server and the (Vite) browser client, where
// `process` is undefined. Read env defensively so a client import can't throw;
// the client has no env overrides and simply gets the built-in defaults.
const env = (name: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

const envNum = (name: string, fallback: number): number => {
  const v = Number(env(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** The month every tier price buys. 31 days, so the bound holds for EVERY
 *  calendar month rather than only a 30-day one. */
export const MONTH_HOURS = 31 * 24;

/** The tier the base windows are expressed at (Demo). Every other tier's
 *  scale is its price over this. */
export const BASE_PRICE_MONTHLY = 30;

/** Span of the budget anchor window. Also the burst/sustained split: a
 *  bucket of span H under a monthly bound P holds P / (1 + MONTH_HOURS/H) up
 *  front and regenerates the rest over the month — at 14 days that is ~31%
 *  burst, ~69% sustained. */
export const ANCHOR_HOURS = 14 * 24;

/** The most a window admits over `hours` of continuous use, starting full:
 *  the whole bucket, then regen for the rest of the span. This — not the
 *  ceiling — is what a monthly cap has to bound. */
export function maxSpendOverHours(w: BudgetWindow, hours: number): number {
  return w.cfg.ceiling + w.cfg.perHour * hours;
}

/** Ceiling for a window of `spanHours` whose 31-day admission is exactly
 *  `bound`: bound = ceiling × (1 + MONTH_HOURS / spanHours). */
export function ceilingForMonthlyBound(bound: number, spanHours: number): number {
  return bound / (1 + MONTH_HOURS / spanHours);
}

/** The most a set of windows admits in a month — the tightest window's 31-day
 *  admission. For every shipped tier this equals `priceMonthly`. */
export function monthlyBound(windows: BudgetWindow[]): number {
  if (windows.length === 0) return Infinity;
  return Math.min(...windows.map(w => maxSpendOverHours(w, MONTH_HOURS)));
}

/**
 * Base windows at the 1× (Demo, $30/mo) tier. Three windows operate together:
 *  - 3h   anti-binge  — caps a single sitting, then throttle
 *  - 3d   smoother    — can't burn the fortnight in two sittings
 *  - 14d  budget anchor — the monthly bound lives here (see header)
 * Declared SHORTEST-FIRST so binding-window ties attribute to the tightest span.
 * The short windows admit far more than a month's price over a month (a 3h
 * bucket refills ~248 times), so only the anchor carries the monthly bound.
 */
export function baseWindows(): WindowDef[] {
  const anchorBound = ceilingForMonthlyBound(BASE_PRICE_MONTHLY, ANCHOR_HOURS);
  return [
    { key: "3h", hours: 3, ceiling: envNum("AAC_BUDGET_3H_CEILING", 2) },
    { key: "3d", hours: 72, ceiling: envNum("AAC_BUDGET_3D_CEILING", 5) },
    // An operator may tighten the anchor, never loosen it past the bound.
    { key: "14d", hours: ANCHOR_HOURS, ceiling: Math.min(envNum("AAC_BUDGET_14D_CEILING", Infinity), anchorBound) },
  ];
}

const tier = (key: string, priceMonthly: number): BudgetTier => ({
  key,
  priceMonthly,
  scale: priceMonthly / BASE_PRICE_MONTHLY,
});

/** The price tiers. Scale = price ÷ Demo price, so the anchor's monthly bound
 *  lands on the headline price exactly. */
export const BUDGET_TIERS: Record<string, BudgetTier> = {
  demo: tier("demo", 30),
  standard: tier("standard", 75),
  plus: tier("plus", 150),
  premium: tier("premium", 250),
};

/** Default tier when a student/license names none. Env-overridable. */
export function defaultTierKey(): string {
  const k = env("AAC_BUDGET_DEFAULT_TIER")?.toLowerCase();
  return k && BUDGET_TIERS[k] ? k : "demo";
}

/** Resolve a tier by key, falling back to the default. Never returns undefined. */
export function tierByKey(key: string | null | undefined): BudgetTier {
  const k = key?.toLowerCase();
  return (k && BUDGET_TIERS[k]) || BUDGET_TIERS[defaultTierKey()];
}

/** Scale the base windows by a tier into runnable `BudgetWindow`s. Regen is
 *  derived from the scaled cap and the (unchanged) span, so the bucket shape is
 *  preserved across tiers. */
export function windowsForTier(tier: BudgetTier): BudgetWindow[] {
  return baseWindows().map(w => {
    const ceiling = w.ceiling * tier.scale;
    return { key: w.key, cfg: { ceiling, perHour: ceiling / w.hours } };
  });
}
