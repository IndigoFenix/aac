/**
 * The unified machine-written baseline envelope.
 *
 * Two things are being protected here. First, the merge rules — a baseline that
 * one odd session can swing is worse than none. Second, the ABSENCE rules: a
 * region that was out of frame, or a session with no face, must leave the
 * stored value untouched rather than record a zero. That distinction is the
 * whole reason PersistedBaseline is documented as sparse.
 */

import { describe, it, expect } from "@jest/globals";
import {
  coerceLearnedBaselines, mergeLearnedBaselines, mergeSeizureBaseline,
  hasObservation, readSeizureBaselineForSeed, readHeadNeutralForSeed,
  SEIZURE_SESSION_MIN_SAMPLES,
  type LearnedBaselines,
} from "../../shared/aac/learned-baselines.js";
import { NEUTRAL_MIN_SAMPLES, NEUTRAL_MIN_SESSIONS } from "../../shared/aac/head-attention.js";

const ISO = "2026-09-02T00:00:00.000Z";

describe("coerceLearnedBaselines", () => {
  it("returns an empty set for junk rather than throwing", () => {
    expect(coerceLearnedBaselines(null)).toEqual({});
    expect(coerceLearnedBaselines("nonsense")).toEqual({});
    expect(coerceLearnedBaselines({ seizure: 5, headNeutral: [] })).toEqual({});
  });

  it("keeps a well-formed seizure baseline", () => {
    const c = coerceLearnedBaselines({
      seizure: { regionEnergy: { head: 0.2 }, samples: 100, updatedAt: ISO },
    });
    expect(c.seizure?.samples).toBe(100);
    expect(c.seizure?.regionEnergy.head).toBeCloseTo(0.2);
  });

  it("drops non-numeric region energies instead of importing NaN", () => {
    const c = coerceLearnedBaselines({
      seizure: { regionEnergy: { head: 0.2, torso: "x" }, samples: 10 },
    });
    expect(c.seizure?.regionEnergy.head).toBeCloseTo(0.2);
    expect(c.seizure?.regionEnergy.torso).toBeUndefined();
  });

  it("keeps a well-formed head neutral", () => {
    const c = coerceLearnedBaselines({
      headNeutral: { yaw: 0.1, pitch: 0.2, yawSpread: 0.05, pitchSpread: 0.05, n: 500, sessions: 4 },
    });
    expect(c.headNeutral?.n).toBe(500);
    expect(c.headNeutral?.sessions).toBe(4);
  });
});

describe("mergeSeizureBaseline", () => {
  it("ignores a session too short to describe habitual motion", () => {
    const stored = { regionEnergy: { head: 0.2 }, samples: 500, updatedAt: ISO };
    const merged = mergeSeizureBaseline(
      stored, { regionEnergy: { head: 9 }, samples: SEIZURE_SESSION_MIN_SAMPLES - 1 }, ISO);
    expect(merged).toEqual(stored);
  });

  it("adopts a region never seen before", () => {
    const merged = mergeSeizureBaseline(
      undefined, { regionEnergy: { head: 0.3 }, samples: 200 }, ISO)!;
    expect(merged.regionEnergy.head).toBeCloseTo(0.3);
    expect(merged.samples).toBe(200);
  });

  it("LEAVES an unobserved region untouched — absent is not zero", () => {
    const stored = {
      regionEnergy: { head: 0.2, leftHand: 0.5 },
      regionSamples: { head: 1000, leftHand: 1000 },
      samples: 1000, updatedAt: ISO,
    };
    // The hand was out of frame all session.
    const merged = mergeSeizureBaseline(stored, { regionEnergy: { head: 0.25 }, samples: 300 }, ISO)!;
    expect(merged.regionEnergy.leftHand).toBeCloseTo(0.5);
    expect(merged.regionSamples?.leftHand).toBe(1000);
  });

  it("moves an established region only slightly", () => {
    const stored = {
      regionEnergy: { head: 0.2 }, regionSamples: { head: 5000 },
      samples: 5000, updatedAt: ISO,
    };
    const merged = mergeSeizureBaseline(stored, { regionEnergy: { head: 2.0 }, samples: 200 }, ISO)!;
    expect(merged.regionEnergy.head!).toBeLessThan(0.4);
    expect(merged.regionEnergy.head!).toBeGreaterThan(0.2);
  });

  it("still converges when the student's habitual motion genuinely changes", () => {
    let b = mergeSeizureBaseline(undefined, { regionEnergy: { head: 0.2 }, samples: 200 }, ISO);
    for (let i = 0; i < 60; i++) {
      b = mergeSeizureBaseline(b, { regionEnergy: { head: 1.0 }, samples: 200 }, ISO);
    }
    expect(b!.regionEnergy.head!).toBeGreaterThan(0.8);
  });
});

describe("mergeLearnedBaselines", () => {
  it("leaves the head neutral alone when a session saw no face", () => {
    const stored: LearnedBaselines = {
      headNeutral: { yaw: 0.3, pitch: 0.1, yawSpread: 0.05, pitchSpread: 0.05, n: 900, sessions: 5, updatedAt: ISO },
    };
    const merged = mergeLearnedBaselines(stored, { seizure: { regionEnergy: { head: 0.2 }, samples: 200 } }, ISO);
    expect(merged.headNeutral).toEqual(stored.headNeutral);
    expect(merged.seizure).toBeDefined();
  });

  it("leaves the seizure baseline alone when the DSP observed nothing", () => {
    const stored: LearnedBaselines = {
      seizure: { regionEnergy: { head: 0.2 }, samples: 800, updatedAt: ISO },
    };
    const merged = mergeLearnedBaselines(stored, {
      headNeutral: { yaw: 0.1, pitch: 0, yawSpread: 0.04, pitchSpread: 0.04, n: 300 },
    }, ISO);
    expect(merged.seizure).toEqual(stored.seizure);
    expect(merged.headNeutral).toBeDefined();
  });

  it("carries both forward when both were observed", () => {
    const merged = mergeLearnedBaselines(null, {
      seizure: { regionEnergy: { head: 0.2 }, samples: 200 },
      headNeutral: { yaw: 0.1, pitch: 0, yawSpread: 0.04, pitchSpread: 0.04, n: 300 },
    }, ISO);
    expect(merged.seizure?.samples).toBe(200);
    expect(merged.headNeutral?.sessions).toBe(1);
  });

  it("accumulates across sessions until the head neutral is trusted", () => {
    let b: LearnedBaselines = {};
    for (let i = 0; i < NEUTRAL_MIN_SESSIONS; i++) {
      b = mergeLearnedBaselines(b, {
        headNeutral: {
          yaw: 0.2, pitch: 0.05, yawSpread: 0.04, pitchSpread: 0.04,
          n: Math.ceil(NEUTRAL_MIN_SAMPLES / NEUTRAL_MIN_SESSIONS),
        },
      }, ISO);
    }
    expect(b.headNeutral!.sessions).toBe(NEUTRAL_MIN_SESSIONS);
    expect(b.headNeutral!.n).toBeGreaterThanOrEqual(NEUTRAL_MIN_SAMPLES);
  });
});

describe("hasObservation", () => {
  it("is false for nothing worth a round trip", () => {
    expect(hasObservation(null)).toBe(false);
    expect(hasObservation({})).toBe(false);
    expect(hasObservation({ seizure: { regionEnergy: {}, samples: 1 } })).toBe(false);
  });

  it("is true once either kind has real data", () => {
    expect(hasObservation({ seizure: { regionEnergy: { head: 1 }, samples: 200 } })).toBe(true);
    expect(hasObservation({
      headNeutral: { yaw: 0, pitch: 0, yawSpread: 0, pitchSpread: 0, n: 100 },
    })).toBe(true);
  });
});

describe("seeding / legacy compatibility", () => {
  it("prefers the unified home", () => {
    const seed = readSeizureBaselineForSeed({
      learnedBaselines: { seizure: { regionEnergy: { head: 0.9 }, samples: 400 } },
      seizureDetection: { baseline: { regionEnergy: { head: 0.1 }, samples: 10 } },
    });
    expect(seed?.regionEnergy.head).toBeCloseTo(0.9);
  });

  it("falls back to the legacy seizureDetection.baseline — no migration needed", () => {
    const seed = readSeizureBaselineForSeed({
      seizureDetection: { baseline: { regionEnergy: { head: 0.1 }, samples: 10 } },
    });
    expect(seed?.regionEnergy.head).toBeCloseTo(0.1);
  });

  it("returns null when nothing was ever learned", () => {
    expect(readSeizureBaselineForSeed({})).toBeNull();
    expect(readHeadNeutralForSeed({})).toBeNull();
  });

  it("reports the head neutral's trust alongside it", () => {
    const seed = readHeadNeutralForSeed({
      learnedBaselines: {
        headNeutral: {
          yaw: 0.2, pitch: 0, yawSpread: 0.04, pitchSpread: 0.04,
          n: NEUTRAL_MIN_SAMPLES, sessions: NEUTRAL_MIN_SESSIONS,
        },
      },
    });
    expect(seed?.trust).toBe(1);
  });

  it("reports LOW trust for a thin profile rather than hiding it", () => {
    const seed = readHeadNeutralForSeed({
      learnedBaselines: {
        headNeutral: { yaw: 0.2, pitch: 0, yawSpread: 0.04, pitchSpread: 0.04, n: 20, sessions: 1 },
      },
    });
    expect(seed).not.toBeNull();
    expect(seed!.trust).toBeGreaterThan(0);
    expect(seed!.trust).toBeLessThan(0.5);
  });
});
