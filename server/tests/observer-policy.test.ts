/**
 * Observer economy policy resolver — the standing constraints (default backend /
 * live permission / always-conservative) the AgentCoordinator reads to pick the
 * Observer backend, gate the set_observation_mode tool, and force the
 * conservative regime. Pins the per-tier DEFAULTS and the per-student OVERRIDE
 * precedence so the policy layer stays decoupled from the budget number.
 */

import { describe, it, expect } from "@jest/globals";
import { tierByKey } from "../../shared/aac/budget-tiers.js";
import {
  resolveObserverPolicy,
  tierPolicyDefaults,
} from "../../shared/aac/observer-policy.js";

describe("observer economy policy — tier defaults", () => {
  it("Demo: economy backend, no live, always conservative", () => {
    const p = resolveObserverPolicy(tierByKey("demo"));
    expect(p).toEqual({ defaultBackend: "economy", allowLive: false, alwaysConservative: true });
  });

  it("Standard: economy default but may go live, not forced-conservative", () => {
    const p = resolveObserverPolicy(tierByKey("standard"));
    expect(p).toEqual({ defaultBackend: "economy", allowLive: true, alwaysConservative: false });
  });

  it("Plus / Premium: live by default, unconstrained", () => {
    for (const key of ["plus", "premium"]) {
      const p = resolveObserverPolicy(tierByKey(key));
      expect(p).toEqual({ defaultBackend: "live", allowLive: true, alwaysConservative: false });
    }
  });

  it("tierPolicyDefaults falls through to live/unconstrained for unknown keys", () => {
    expect(tierPolicyDefaults("something-new")).toEqual({
      defaultBackend: "live",
      allowLive: true,
      alwaysConservative: false,
    });
  });
});

describe("observer economy policy — per-student overrides", () => {
  it("an explicit field overrides the tier default", () => {
    // Demo would forbid live + force conservative; overrides lift both.
    const p = resolveObserverPolicy(tierByKey("demo"), {
      observerAllowLive: true,
      observerBackend: "live",
      observerAlwaysConservative: false,
    });
    expect(p).toEqual({ defaultBackend: "live", allowLive: true, alwaysConservative: false });
  });

  it("nullish override fields fall back to the tier default", () => {
    const p = resolveObserverPolicy(tierByKey("standard"), {
      observerBackend: null,
      observerAllowLive: undefined,
      observerAlwaysConservative: null,
    });
    expect(p).toEqual({ defaultBackend: "economy", allowLive: true, alwaysConservative: false });
  });

  it("forbidding live pins the default backend to economy even if 'live' is asked", () => {
    const p = resolveObserverPolicy(tierByKey("premium"), {
      observerAllowLive: false,
      observerBackend: "live",
    });
    expect(p.allowLive).toBe(false);
    expect(p.defaultBackend).toBe("economy");
  });

  it("can force conservative onto a richer tier without touching the backend", () => {
    const p = resolveObserverPolicy(tierByKey("premium"), { observerAlwaysConservative: true });
    expect(p).toEqual({ defaultBackend: "live", allowLive: true, alwaysConservative: true });
  });
});
