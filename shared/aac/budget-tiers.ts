// shared/aac/budget-tiers.ts
//
// Price tiers for the AAC budget meter. A tier is just a NAMED budget = a scale
// factor on a common set of window caps (regen scales with the cap, so every
// tier has the identical leaky-bucket SHAPE, only larger). This keeps the
// $30/mo demo and the $250/mo near-constant-use plan on one mechanism: the
// Demo tier is 1×, Premium is 8×.
//
// Window caps are expressed as { hours, ceiling } and the regen is DERIVED
// (`perHour = ceiling / hours`) so a window can never drift from its rolling
// span. Base caps + the default tier are overridable via env so pricing/limits
// move without a deploy. Units are credits = USD (1:1 today; see cost-helpers).
// See planning-docs/aac-budget-tiers-spec.md §3-4.

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
  /** Headline monthly price (USD). Informational — the windows do the bounding. */
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

/**
 * Base windows at the 1× (Demo, $30/mo) tier. Three windows operate together:
 *  - 3h   anti-binge  — caps a single sitting (~1–1.5 active hrs, then throttle)
 *  - 3d   smoother    — can't burn the fortnight in two sittings
 *  - 14d  budget anchor — ~half the month; the dominant guard
 * Declared SHORTEST-FIRST so binding-window ties attribute to the tightest span.
 */
export function baseWindows(): WindowDef[] {
  return [
    { key: "3h", hours: 3, ceiling: envNum("AAC_BUDGET_3H_CEILING", 2) },
    { key: "3d", hours: 72, ceiling: envNum("AAC_BUDGET_3D_CEILING", 5) },
    { key: "14d", hours: 336, ceiling: envNum("AAC_BUDGET_14D_CEILING", 15) },
  ];
}

/** The price tiers. Scales chosen so the 14d anchor lands near each headline
 *  price's monthly budget at an optimized ~$1.5/hr mixed rate. */
export const BUDGET_TIERS: Record<string, BudgetTier> = {
  demo: { key: "demo", priceMonthly: 30, scale: 1 },
  standard: { key: "standard", priceMonthly: 75, scale: 2.5 },
  plus: { key: "plus", priceMonthly: 150, scale: 5 },
  premium: { key: "premium", priceMonthly: 250, scale: 8 },
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
