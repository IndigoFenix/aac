/**
 * Per-student seizure config → DSP threshold resolution. The visible technical
 * settings (master enable + per-detector sensitivity) must map to detector
 * behavior: Off disables a detector, higher sensitivity = lower thresholds =
 * fires more readily. "medium" must reproduce the DSP's built-in defaults so the
 * unconfigured/legacy path is unchanged.
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolveThresholds, coerceSeizureConfig, DEFAULT_SEIZURE_CONFIG, type SeizureConfig,
} from "../../shared/aac/seizure-config.js";
import { DEFAULT_THRESHOLDS } from "../../shared/aac/seizure-signature.js";

const cfg = (over: Partial<SeizureConfig>): SeizureConfig => ({ ...DEFAULT_SEIZURE_CONFIG, ...over });

describe("resolveThresholds", () => {
  it("disables everything when the master switch is off", () => {
    const t = resolveThresholds(cfg({ enabled: false, rhythmic: "high", atonic: "high", audioCorroboration: true }));
    expect(t.rhythmic.enabled).toBe(false);
    expect(t.atonic.enabled).toBe(false);
    expect(t.audioCorroboration).toBe(false);
  });

  it("disables a single detector set to off, leaving the other on", () => {
    const t = resolveThresholds(cfg({ enabled: true, rhythmic: "off", atonic: "medium" }));
    expect(t.rhythmic.enabled).toBe(false);
    expect(t.atonic.enabled).toBe(true);
  });

  it("medium reproduces the DSP defaults", () => {
    const t = resolveThresholds(cfg({ enabled: true, rhythmic: "medium", atonic: "medium" }));
    expect(t.rhythmic.involvementMult).toBe(DEFAULT_THRESHOLDS.rhythmic.involvementMult);
    expect(t.rhythmic.escalateConfidence).toBe(DEFAULT_THRESHOLDS.rhythmic.escalateConfidence);
    expect(t.atonic.dropFrac).toBe(DEFAULT_THRESHOLDS.atonic.dropFrac);
  });

  it("higher sensitivity = lower thresholds (fires more readily)", () => {
    const low = resolveThresholds(cfg({ enabled: true, rhythmic: "low", atonic: "low" }));
    const high = resolveThresholds(cfg({ enabled: true, rhythmic: "high", atonic: "high" }));
    expect(high.rhythmic.involvementMult).toBeLessThan(low.rhythmic.involvementMult);
    expect(high.rhythmic.escalateConfidence).toBeLessThan(low.rhythmic.escalateConfidence);
    expect(high.atonic.dropFrac).toBeLessThan(low.atonic.dropFrac);
  });

  it("audio corroboration follows the master switch AND its own flag", () => {
    expect(resolveThresholds(cfg({ enabled: true, audioCorroboration: true })).audioCorroboration).toBe(true);
    expect(resolveThresholds(cfg({ enabled: true, audioCorroboration: false })).audioCorroboration).toBe(false);
    expect(resolveThresholds(cfg({ enabled: false, audioCorroboration: true })).audioCorroboration).toBe(false);
  });
});

describe("coerceSeizureConfig — tolerates legacy/partial stored values", () => {
  it("fills defaults for null/garbage", () => {
    expect(coerceSeizureConfig(null)).toEqual(DEFAULT_SEIZURE_CONFIG);
    expect(coerceSeizureConfig({ rhythmic: "bogus" }).rhythmic).toBe(DEFAULT_SEIZURE_CONFIG.rhythmic);
  });
  it("keeps valid values", () => {
    expect(coerceSeizureConfig({ enabled: true, rhythmic: "high", atonic: "low", audioCorroboration: true }))
      .toEqual({ enabled: true, rhythmic: "high", atonic: "low", audioCorroboration: true, markers: [] });
  });
});
