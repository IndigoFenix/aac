/**
 * Multi-window persistent budget meter (the layer above the per-session energy
 * meter). Pins the parallel-bucket math, binding-window selection, and the tier
 * scaling so the monthly cap + throttle can't silently drift.
 * See planning-docs/aac-budget-tiers-spec.md §2-4, §9.
 */

import { describe, it, expect } from "@jest/globals";
import {
  initBudget,
  applyBudgetCharge,
  bindingEnergy,
  budgetReadings,
  mergeBudgetState,
  worseBand,
  type BudgetWindow,
} from "../../shared/aac/budget-meter.js";
import { idleThresholdScaleForBand } from "../../server/services/dual-agent/idle-watchdog.js";
import {
  baseWindows,
  windowsForTier,
  tierByKey,
  BUDGET_TIERS,
  defaultTierKey,
} from "../../shared/aac/budget-tiers.js";

const HOUR = 3_600_000;

// Three toy windows with DISTINCT regen rates (short refills fastest, long
// slowest) so the "binding window" logic is exercised meaningfully. Caps 2/8/20
// keep the percentages easy to reason about.
const WINDOWS: BudgetWindow[] = [
  { key: "short", cfg: { ceiling: 2, perHour: 2 } },   // full ceiling back in 1h
  { key: "mid", cfg: { ceiling: 8, perHour: 1 } },
  { key: "long", cfg: { ceiling: 20, perHour: 0.5 } }, // slowest
];

describe("budget-meter — multi-window basics", () => {
  it("starts every window full", () => {
    const t0 = 1_000_000;
    const s = initBudget(WINDOWS, t0);
    for (const r of budgetReadings(s, WINDOWS, t0)) expect(r.percent).toBe(100);
    expect(bindingEnergy(s, WINDOWS, t0).percent).toBe(100);
  });

  it("a charge lowers every window proportionally to its own ceiling", () => {
    const t0 = 1_000_000;
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 1, t0);
    const r = Object.fromEntries(budgetReadings(s, WINDOWS, t0).map(x => [x.key, x.percent]));
    // 1 credit is half of short(2), 1/8 of mid(8), 1/20 of long(20).
    expect(r.short).toBe(50);
    expect(r.mid).toBe(88); // 100 - 12.5 → round
    expect(r.long).toBe(95);
  });

  it("reports minutes-until-refill per window (drain ÷ regen)", () => {
    const t0 = 1_000_000;
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 1, t0);
    const r = Object.fromEntries(budgetReadings(s, WINDOWS, t0).map(x => [x.key, x.refillMinutes]));
    // short: drain 1 ÷ 2/hr = 0.5h = 30m. mid: 1 ÷ 1/hr = 60m. long: 1 ÷ 0.5/hr = 120m.
    expect(r.short).toBe(30);
    expect(r.mid).toBe(60);
    expect(r.long).toBe(120);
  });

  it("refill minutes is 0 for a full window", () => {
    const t0 = 1_000_000;
    const r = budgetReadings(initBudget(WINDOWS, t0), WINDOWS, t0);
    for (const x of r) expect(x.refillMinutes).toBe(0);
  });

  it("does not mutate the input state (returns a new object)", () => {
    const t0 = 1_000_000;
    const s0 = initBudget(WINDOWS, t0);
    const s1 = applyBudgetCharge(s0, WINDOWS, 1, t0);
    expect(s0.short.drain).toBe(0);
    expect(s1.short.drain).toBe(1);
  });
});

describe("budget-meter — binding window is the tightest", () => {
  it("reports the lowest window as binding", () => {
    const t0 = 1_000_000;
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 1, t0);
    const b = bindingEnergy(s, WINDOWS, t0);
    expect(b.window).toBe("short"); // 50% < 88% < 95%
    expect(b.percent).toBe(50);
    expect(b.band).toBe("moderate");
  });

  it("a long window with headroom permits a burst while the short window binds and throttles", () => {
    const t0 = 1_000_000;
    // Spend the whole short ceiling in one burst.
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 2, t0);
    const b = bindingEnergy(s, WINDOWS, t0);
    expect(b.window).toBe("short");
    expect(b.percent).toBe(0); // short empty → throttle
    expect(b.band).toBe("low");
    // ...yet the long window still has plenty of budget left.
    const long = budgetReadings(s, WINDOWS, t0).find(r => r.key === "long")!;
    expect(long.percent).toBe(90);
  });

  it("the short window recovers fastest, releasing the throttle while the long window stays the anchor", () => {
    const t0 = 1_000_000;
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 2, t0);
    // After 1h: short (regen 2/hr) fully refills; mid/long lag, so the binding
    // window moves off "short" to a slower-recovering one.
    const b = bindingEnergy(s, WINDOWS, t0 + HOUR);
    expect(b.window).not.toBe("short"); // short back to full
    const short = budgetReadings(s, WINDOWS, t0 + HOUR).find(r => r.key === "short")!;
    expect(short.percent).toBe(100);
  });

  it("ties resolve to the earliest (shortest) window", () => {
    const t0 = 1_000_000;
    // Equal % everywhere → no charge, all 100. Binding should be the first.
    const b = bindingEnergy(initBudget(WINDOWS, t0), WINDOWS, t0);
    expect(b.window).toBe("short");
  });

  it("treats a window missing from persisted state as full", () => {
    const t0 = 1_000_000;
    const partial = { short: { drain: 2, asOf: t0 } }; // only one window stored
    const b = bindingEnergy(partial, WINDOWS, t0);
    expect(b.window).toBe("short"); // the only drained one binds
    const mid = budgetReadings(partial, WINDOWS, t0).find(r => r.key === "mid")!;
    expect(mid.percent).toBe(100); // absent → fresh/full
  });
});

describe("budget-tiers", () => {
  it("scales every base window cap and regen by the tier scale", () => {
    const demo = windowsForTier(tierByKey("demo"));
    const premium = windowsForTier(tierByKey("premium"));
    const demo14 = demo.find(w => w.key === "14d")!;
    const prem14 = premium.find(w => w.key === "14d")!;
    expect(prem14.cfg.ceiling).toBe(demo14.cfg.ceiling * 8);
    // Span is preserved: ceiling/perHour ratio (= hours) is identical across tiers.
    expect(prem14.cfg.ceiling / prem14.cfg.perHour).toBeCloseTo(demo14.cfg.ceiling / demo14.cfg.perHour, 9);
  });

  it("derives regen as cap ÷ span hours", () => {
    const demo = windowsForTier(tierByKey("demo"));
    const w3h = demo.find(w => w.key === "3h")!;
    expect(w3h.cfg.ceiling).toBe(2);
    expect(w3h.cfg.perHour).toBeCloseTo(2 / 3, 9);
  });

  it("Premium's 3h window covers ~8 continuous hours without binding", () => {
    // Optimized mixed use ≈ $1.5/hr. 8h ≈ $12 spent in the rolling 3h window's
    // worst case is bounded by ~3h of spend = ~$4.5, well under the scaled cap.
    const premium = windowsForTier(tierByKey("premium"));
    const w3h = premium.find(w => w.key === "3h")!;
    expect(w3h.cfg.ceiling).toBe(16); // 2 × 8
    const spend3h = 1.5 * 3; // credits accrued within the rolling 3h span
    expect(spend3h).toBeLessThan(w3h.cfg.ceiling);
  });

  it("falls back to the default tier for unknown/empty keys", () => {
    expect(tierByKey(undefined).key).toBe(defaultTierKey());
    expect(tierByKey("nonsense").key).toBe("demo");
    expect(tierByKey("PREMIUM").key).toBe("premium"); // case-insensitive
  });

  it("exposes the four documented price points", () => {
    expect(Object.keys(BUDGET_TIERS).sort()).toEqual(["demo", "plus", "premium", "standard"]);
    expect(BUDGET_TIERS.demo.priceMonthly).toBe(30);
    expect(BUDGET_TIERS.premium.priceMonthly).toBe(250);
  });

  it("base windows are declared shortest-first", () => {
    const keys = baseWindows().map(w => w.key);
    expect(keys).toEqual(["3h", "3d", "14d"]);
  });
});

describe("worseBand — governing band folds two signals", () => {
  it("returns the lower-ranked band (low < moderate < high)", () => {
    expect(worseBand("high", "high")).toBe("high");
    expect(worseBand("high", "moderate")).toBe("moderate");
    expect(worseBand("moderate", "low")).toBe("low");
    expect(worseBand("low", "high")).toBe("low");
    expect(worseBand("moderate", "moderate")).toBe("moderate");
  });
});

describe("throttle ladder — binding band drives idle→sleep scaling", () => {
  it("a spent short window tightens the idle thresholds even with healthy long windows", () => {
    const t0 = 1_000_000;
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 2, t0); // short → empty
    const b = bindingEnergy(s, WINDOWS, t0);
    expect(b.band).toBe("low");
    // The governing band maps to the aggressive ~3× sooner idle scale.
    expect(idleThresholdScaleForBand(b.band)).toBeCloseTo(1 / 3, 9);
  });

  it("healthy budget leaves idle timing untouched (scale 1)", () => {
    const t0 = 1_000_000;
    const b = bindingEnergy(initBudget(WINDOWS, t0), WINDOWS, t0);
    expect(b.band).toBe("high");
    expect(idleThresholdScaleForBand(b.band)).toBe(1);
  });
});

describe("persistence — JSONB round-trip", () => {
  it("survives JSON serialize/deserialize unchanged (the students.budget_meters path)", () => {
    const t0 = 1_000_000;
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 1.3, t0);
    const reloaded = JSON.parse(JSON.stringify(s));
    // Regen applied from the same `now` must match before and after a round-trip.
    const before = bindingEnergy(s, WINDOWS, t0 + HOUR);
    const after = bindingEnergy(reloaded, WINDOWS, t0 + HOUR);
    expect(after).toEqual(before);
  });
});

describe("mergeBudgetState — stale writers can't clobber accumulated drain", () => {
  const t0 = 1_000_000;

  it("null/empty sides pass the other side through", () => {
    const s = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 1, t0);
    expect(mergeBudgetState(null, s, WINDOWS, t0)).toEqual(s);
    expect(mergeBudgetState(s, null, WINDOWS, t0)).toEqual(s);
    expect(mergeBudgetState(null, undefined, WINDOWS, t0)).toEqual({});
  });

  it("unions windows present on only one side", () => {
    const a = { short: { drain: 1, asOf: t0 } };
    const b = { long: { drain: 3, asOf: t0 } };
    const m = mergeBudgetState(a, b, WINDOWS, t0);
    expect(m.short).toEqual(a.short);
    expect(m.long).toEqual(b.long);
  });

  it("at the same asOf, the higher drain wins per window", () => {
    const a = { short: { drain: 1.5, asOf: t0 }, mid: { drain: 0.2, asOf: t0 } };
    const b = { short: { drain: 0.4, asOf: t0 }, mid: { drain: 6, asOf: t0 } };
    const m = mergeBudgetState(a, b, WINDOWS, t0);
    expect(m.short.drain).toBe(1.5); // from a
    expect(m.mid.drain).toBe(6); // from b
  });

  it("compares regen-NORMALIZED drain — an old record decays before comparing", () => {
    // "short" regens 2/hr. An hour-old drain of 1.9 is worth 0 now; a fresh
    // drain of 0.5 is the fuller record despite the lower raw number.
    const a = { short: { drain: 1.9, asOf: t0 } };
    const b = { short: { drain: 0.5, asOf: t0 + HOUR } };
    const m = mergeBudgetState(a, b, WINDOWS, t0 + HOUR);
    expect(m.short.drain).toBeCloseTo(0.5, 9);
    expect(m.short.asOf).toBe(t0 + HOUR);
  });

  it("the reconnect-clobber scenario: a coordinator saving from a stale base cannot erase accumulated spend", () => {
    // DB holds a session's accumulated drain. A reconnect-resumed coordinator
    // seeded from a stale snapshot spends a little and saves. The merge must
    // keep the accumulated record, not the stale-based overwrite.
    const accumulated = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 6, t0);
    const staleBased = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 0.3, t0 + 60_000);
    const m = mergeBudgetState(accumulated, staleBased, WINDOWS, t0 + 60_000);
    // long window regens 0.5/hr → 6 drain has decayed only ~0.008 in a minute.
    expect(m.long.drain).toBeGreaterThan(5.9);
    // And the binding view reflects the real spend, not the reset.
    expect(bindingEnergy(m, WINDOWS, t0 + 60_000).percent)
      .toBe(bindingEnergy(accumulated, WINDOWS, t0 + 60_000).percent);
  });

  it("merge is commutative on the normalized result", () => {
    const a = applyBudgetCharge(initBudget(WINDOWS, t0), WINDOWS, 2, t0);
    const b = applyBudgetCharge(initBudget(WINDOWS, t0 + 30_000), WINDOWS, 0.7, t0 + 30_000);
    const now = t0 + 60_000;
    expect(mergeBudgetState(a, b, WINDOWS, now)).toEqual(mergeBudgetState(b, a, WINDOWS, now));
  });

  it("a key with no window config (old tier leftover) compares raw drain and is preserved", () => {
    const a = { legacy: { drain: 4, asOf: t0 } };
    const b = { legacy: { drain: 1, asOf: t0 + HOUR } };
    const m = mergeBudgetState(a, b, WINDOWS, t0 + HOUR);
    expect(m.legacy.drain).toBe(4); // no regen model → higher raw drain wins
  });
});
