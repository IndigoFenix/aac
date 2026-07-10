// shared/aac/observer-policy.ts
//
// Observer ECONOMY POLICY — the standing constraints on how the AAC Observer
// runs, resolved once per session. Three independent knobs:
//   - defaultBackend:     which backend the Observer starts on (live vs the
//                         cheap HTTP "economy" backend) when the budget is healthy.
//   - allowLive:          whether the Observer may run / switch to the Live
//                         (native-audio) backend at all. When false the
//                         set_observation_mode tool + its <energy> prompt lines
//                         are omitted and the backend is pinned to economy.
//   - alwaysConservative: force the "conservative" observation regime (the
//                         moderate-band behaviour — lean on cheap text, go cold
//                         sooner) regardless of the actual budget level.
//
// These are a POLICY layer, deliberately NOT hard-wired to the budget number.
// The price tier only supplies DEFAULTS; an explicit per-student aac_settings
// field overrides any of them, so a future clinician toggle can decide when and
// how to apply each constraint (mirrors how `liveAudioSpeaker` overrides the
// Speaker backend). See [[project_observer_cost_overrun]] / [[project_budget_tiers]].

import type { BudgetTier } from "./budget-tiers.js";

export type ObserverBackend = "live" | "economy";

export interface ObserverEconomyPolicy {
  /** Backend the Observer starts on when the budget is healthy (the low-band
   *  floor can still force economy on top of this). */
  defaultBackend: ObserverBackend;
  /** Whether the Observer may run / switch to the Live backend at all. When
   *  false the backend is pinned to economy and the switch tool/prompt are gone. */
  allowLive: boolean;
  /** Force the conservative (moderate-band) observation regime at all energy
   *  levels. Safety always overrides — this only shapes HOW MUCH is observed. */
  alwaysConservative: boolean;
}

/** Per-tier DEFAULTS. Only defaults — an explicit per-student override wins (see
 *  resolveObserverPolicy). Kept off the tier definition itself so the constraints
 *  stay a policy layer rather than a property of the budget:
 *   - demo:     cheapest — economy by default, may NOT go live, always conservative.
 *   - standard: economy by default but MAY go live when something needs watching.
 *   - plus/premium and anything richer: live by default, unconstrained. */
export function tierPolicyDefaults(tierKey: string): ObserverEconomyPolicy {
  switch (tierKey) {
    case "demo":
      return { defaultBackend: "economy", allowLive: false, alwaysConservative: true };
    case "standard":
      return { defaultBackend: "economy", allowLive: true, alwaysConservative: false };
    default:
      return { defaultBackend: "live", allowLive: true, alwaysConservative: false };
  }
}

/** Optional per-student overrides (from aac_settings). A nullish field falls
 *  back to the tier default; any concrete value wins. */
export interface ObserverPolicyOverrides {
  observerBackend?: ObserverBackend | null;
  observerAllowLive?: boolean | null;
  observerAlwaysConservative?: boolean | null;
}

/** Resolve the effective policy: tier defaults, with any explicit override
 *  applied on top. Enforces the invariant that a session forbidden from Live
 *  starts on (and is pinned to) the economy backend. */
export function resolveObserverPolicy(
  tier: BudgetTier,
  overrides?: ObserverPolicyOverrides,
): ObserverEconomyPolicy {
  const base = tierPolicyDefaults(tier.key);
  const allowLive = overrides?.observerAllowLive ?? base.allowLive;
  let defaultBackend = overrides?.observerBackend ?? base.defaultBackend;
  // Can't default to a backend the session isn't allowed to use.
  if (!allowLive) defaultBackend = "economy";
  return {
    defaultBackend,
    allowLive,
    alwaysConservative: overrides?.observerAlwaysConservative ?? base.alwaysConservative,
  };
}
