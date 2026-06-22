/**
 * Phase 4 cost-saving — the regenerating energy model exposed to the Observer.
 * Pins the drain/regen/clamp math and the band thresholds so the cost-aware
 * guidance can't silently drift. See planning-docs/aac-cost-saving-spec.md §4.
 */

import { describe, it, expect } from "@jest/globals";
import {
  initEnergy,
  regenerate,
  applyCharge,
  energyPercent,
  energyBand,
  energyCostPercent,
  minutesToEmpty,
  type EnergyConfig,
} from "../../shared/aac/energy-meter.js";

const HOUR = 3_600_000;
const cfg: EnergyConfig = { ceiling: 6, perHour: 6 }; // regenerates the whole ceiling in 1h

describe("energy drain + regeneration", () => {
  it("starts full", () => {
    const t0 = 1_000_000;
    expect(energyPercent(initEnergy(t0), t0, cfg)).toBe(100);
  });

  it("a charge lowers energy proportionally to the ceiling", () => {
    const t0 = 1_000_000;
    const s = applyCharge(initEnergy(t0), 3, t0, cfg.perHour); // half the ceiling
    expect(energyPercent(s, t0, cfg)).toBe(50);
  });

  it("regenerates over time toward full", () => {
    const t0 = 1_000_000;
    const s = applyCharge(initEnergy(t0), 6, t0, cfg.perHour); // empty
    expect(energyPercent(s, t0, cfg)).toBe(0);
    // Half an hour regenerates half the ceiling at 6/hr.
    expect(energyPercent(s, t0 + HOUR / 2, cfg)).toBe(50);
    // A full hour fully recovers.
    expect(energyPercent(s, t0 + HOUR, cfg)).toBe(100);
  });

  it("clamps drain at 0 (never over-regenerates into surplus)", () => {
    const t0 = 1_000_000;
    const s = applyCharge(initEnergy(t0), 1, t0, cfg.perHour);
    const r = regenerate(s, t0 + HOUR, cfg.perHour); // way more regen than drain
    expect(r.drain).toBe(0);
    expect(energyPercent(r, t0 + HOUR, cfg)).toBe(100);
  });

  it("energy floors at 0 even past the ceiling (heavy spend)", () => {
    const t0 = 1_000_000;
    const s = applyCharge(initEnergy(t0), 100, t0, cfg.perHour);
    expect(energyPercent(s, t0, cfg)).toBe(0);
  });

  it("treats a past timestamp as no elapsed time (no negative regen)", () => {
    const t0 = 1_000_000;
    const s = applyCharge(initEnergy(t0), 3, t0, cfg.perHour);
    const r = regenerate(s, t0 - HOUR, cfg.perHour);
    expect(r.drain).toBe(3); // unchanged
  });
});

describe("energyBand", () => {
  it("maps percent to coarse bands", () => {
    expect(energyBand(100)).toBe("high");
    expect(energyBand(67)).toBe("high");
    expect(energyBand(66)).toBe("moderate");
    expect(energyBand(25)).toBe("moderate");
    expect(energyBand(24)).toBe("low");
    expect(energyBand(0)).toBe("low");
  });
});

describe("energyCostPercent", () => {
  it("expresses a charge as a 1-decimal percentage of the budget ceiling", () => {
    expect(energyCostPercent(3, cfg)).toBe(50);      // half of ceiling 6
    expect(energyCostPercent(0.6, cfg)).toBe(10);
    expect(energyCostPercent(0.06, cfg)).toBe(1);
    expect(energyCostPercent(0.003, cfg)).toBe(0.1); // rounds to one decimal
  });
  it("tracks the master budget — a bigger ceiling makes the same charge cheaper", () => {
    expect(energyCostPercent(3, { ceiling: 3, perHour: 1 })).toBe(100);
    expect(energyCostPercent(3, { ceiling: 12, perHour: 1 })).toBe(25);
  });
  it("returns 0 for non-positive charge or ceiling", () => {
    expect(energyCostPercent(0, cfg)).toBe(0);
    expect(energyCostPercent(-5, cfg)).toBe(0);
    expect(energyCostPercent(3, { ceiling: 0, perHour: 6 })).toBe(0);
  });
});

describe("minutesToEmpty", () => {
  it("computes time-to-empty net of regeneration", () => {
    // ceiling 6, regen 6/hr = 0.1/min. Spending 0.6/min nets 0.5/min → 12 min.
    expect(minutesToEmpty(0.6, cfg, cfg.perHour)).toBe(12);
  });
  it("returns null when spend stays within regen (never empties)", () => {
    expect(minutesToEmpty(0.1, cfg, cfg.perHour)).toBeNull(); // == regen rate
    expect(minutesToEmpty(0.05, cfg, cfg.perHour)).toBeNull();
  });
});
