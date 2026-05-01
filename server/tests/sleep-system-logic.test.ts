/**
 * Pure-logic tests for the AAC sleep system.
 *
 * The engagement-score combiner and sleep-state transition rules live in
 * client-aac/src/lib/sleepSystemLogic.ts and are pure TypeScript (no React,
 * no DOM) so we can import them directly into Jest.
 */

import { describe, it, expect } from "@jest/globals";
import {
  decayAndScore,
  pushedContribution,
  nextSleepState,
  bumpedMultiplier,
  decayedMultiplier,
  dataFlowForState,
  RESTING_DEEP_BOUNDARY,
  type SleepThresholds,
} from "../../client-aac/src/lib/sleepSystemLogic.js";
import { SLEEP_THRESHOLDS } from "../../client-aac/src/lib/cameraAttentivenessTypes.js";

const T: SleepThresholds = SLEEP_THRESHOLDS;

describe("decayAndScore", () => {
  it("returns score 0 for empty contributions", () => {
    const out = decayAndScore({}, 100, 8000);
    expect(out.score).toBe(0);
    expect(out.contributions).toEqual({});
  });

  it("decays by 50% over one half-life", () => {
    const out = decayAndScore({ face: 0.4 }, 8000, 8000);
    expect(out.contributions.face).toBeCloseTo(0.2, 3);
    expect(out.score).toBeCloseTo(0.2, 3);
  });

  it("drops sub-threshold contributions", () => {
    // After 10 half-lives at 0.5 starting → ~0.0005, below the 0.001 cutoff
    const out = decayAndScore({ motion: 0.5 }, 80000, 8000);
    expect(out.contributions.motion).toBeUndefined();
    expect(out.score).toBe(0);
  });

  it("sums multiple contributions and clamps at 1", () => {
    const out = decayAndScore({ face: 0.45, voice: 0.4, buttonPress: 0.5 }, 0, 8000);
    expect(out.score).toBe(1);
  });

  it("preserves contributions across decay", () => {
    const out = decayAndScore({ face: 0.4, voice: 0.2 }, 4000, 8000);
    // 4000ms with 8000ms half-life → factor ≈ 0.7071
    expect(out.contributions.face).toBeCloseTo(0.2828, 3);
    expect(out.contributions.voice).toBeCloseTo(0.1414, 3);
  });
});

describe("pushedContribution", () => {
  it("first push sets to weight × intensity", () => {
    expect(pushedContribution(undefined, 0.4, 1)).toBeCloseTo(0.4, 6);
    expect(pushedContribution(undefined, 0.4, 0.5)).toBeCloseTo(0.2, 6);
  });

  it("higher push refreshes upward", () => {
    expect(pushedContribution(0.1, 0.4, 1)).toBeCloseTo(0.4, 6);
  });

  it("lower push does not lower current (max behavior)", () => {
    expect(pushedContribution(0.4, 0.4, 0.1)).toBeCloseTo(0.4, 6);
  });

  it("clamps intensity below 0 and above 1", () => {
    expect(pushedContribution(0, 0.5, -1)).toBe(0);
    expect(pushedContribution(0, 0.5, 5)).toBe(0.5);
  });
});

describe("nextSleepState — sticky states", () => {
  it("Hibernation never transitions on score alone", () => {
    expect(nextSleepState("hibernation", 0, T, 1)).toBe("hibernation");
    expect(nextSleepState("hibernation", 1, T, 1)).toBe("hibernation");
  });

  it("Waking never transitions on score alone", () => {
    expect(nextSleepState("waking", 0, T, 1)).toBe("waking");
    expect(nextSleepState("waking", 1, T, 1)).toBe("waking");
  });
});

describe("nextSleepState — Awake transitions", () => {
  it("stays Awake when score >= rest", () => {
    expect(nextSleepState("awake", T.rest, T, 1)).toBe("awake");
    expect(nextSleepState("awake", 1, T, 1)).toBe("awake");
  });

  it("transitions to Resting when score drops below rest", () => {
    expect(nextSleepState("awake", T.rest - 0.01, T, 1)).toBe("resting");
    expect(nextSleepState("awake", 0, T, 1)).toBe("resting");
  });
});

describe("nextSleepState — Resting transitions", () => {
  it("stays Resting in the middle band", () => {
    const mid = (T.sleep + T.engaged) / 2;
    expect(nextSleepState("resting", mid, T, 1)).toBe("resting");
  });

  it("transitions to Awake when score >= engaged", () => {
    expect(nextSleepState("resting", T.engaged, T, 1)).toBe("awake");
    expect(nextSleepState("resting", 1, T, 1)).toBe("awake");
  });

  it("transitions to Asleep when score < sleep", () => {
    expect(nextSleepState("resting", T.sleep - 0.01, T, 1)).toBe("asleep");
    expect(nextSleepState("resting", 0, T, 1)).toBe("asleep");
  });
});

describe("nextSleepState — Asleep transitions", () => {
  it("stays Asleep when score < wakeup", () => {
    expect(nextSleepState("asleep", T.wakeup - 0.01, T, 1)).toBe("asleep");
    expect(nextSleepState("asleep", 0, T, 1)).toBe("asleep");
  });

  it("transitions to Awake when score >= wakeup", () => {
    expect(nextSleepState("asleep", T.wakeup, T, 1)).toBe("awake");
    expect(nextSleepState("asleep", 1, T, 1)).toBe("awake");
  });

  it("does not skip through Resting on wake", () => {
    // Asleep with score that would also satisfy resting→awake should still go awake
    expect(nextSleepState("asleep", T.wakeup, T, 1)).toBe("awake");
  });
});

describe("nextSleepState — hysteresis", () => {
  it("score between rest and engaged does not flap (Awake stays, Resting stays)", () => {
    const between = (T.rest + T.engaged) / 2;
    expect(nextSleepState("awake", between, T, 1)).toBe("awake");
    expect(nextSleepState("resting", between, T, 1)).toBe("resting");
  });

  it("score just at rest threshold: Awake stays, Resting → Awake only at engaged", () => {
    expect(nextSleepState("awake", T.rest, T, 1)).toBe("awake");
    expect(nextSleepState("resting", T.rest, T, 1)).toBe("resting");
  });
});

describe("nextSleepState — false-wake dampening", () => {
  it("dampMult raises wakeup threshold proportionally", () => {
    // wakeup = 0.65 * 1.2 = 0.78. Score 0.7 should NOT wake from Asleep with damp.
    expect(nextSleepState("asleep", 0.7, T, 1.2)).toBe("asleep");
    expect(nextSleepState("asleep", 0.8, T, 1.2)).toBe("awake");
  });

  it("dampMult raises engaged threshold proportionally", () => {
    // engaged = 0.45 * 1.2 = 0.54. Score 0.5 should NOT wake from Resting with damp.
    expect(nextSleepState("resting", 0.5, T, 1.2)).toBe("resting");
    expect(nextSleepState("resting", 0.55, T, 1.2)).toBe("awake");
  });

  it("dampMult does NOT affect rest or sleep thresholds (going-to-rest stays easy)", () => {
    expect(nextSleepState("awake", T.rest - 0.01, T, 5)).toBe("resting");
    expect(nextSleepState("resting", T.sleep - 0.01, T, 5)).toBe("asleep");
  });

  it("damped thresholds are clamped to 1.0", () => {
    // Even with extreme dampMult, score=1 should still be able to wake.
    expect(nextSleepState("asleep", 1, T, 100)).toBe("awake");
  });
});

describe("bumpedMultiplier", () => {
  it("multiplies by bumpFactor", () => {
    expect(bumpedMultiplier(1.0, 1.15, 0.65, 0.95)).toBeCloseTo(1.15, 6);
    expect(bumpedMultiplier(1.15, 1.15, 0.65, 0.95)).toBeCloseTo(1.3225, 4);
  });

  it("caps at maxThreshold / baseWakeup", () => {
    // 0.95 / 0.65 ≈ 1.4615 — bumping past this is capped
    expect(bumpedMultiplier(1.4, 1.5, 0.65, 0.95)).toBeCloseTo(0.95 / 0.65, 4);
  });
});

describe("decayedMultiplier", () => {
  it("decays excess above 1.0 by 50% per half-life", () => {
    // 1.5 over one half-life → 1 + (0.5 * 0.5) = 1.25
    expect(decayedMultiplier(1.5, 5 * 60 * 1000, 5 * 60 * 1000)).toBeCloseTo(1.25, 4);
  });

  it("at 1.0 stays at 1.0", () => {
    expect(decayedMultiplier(1.0, 1000, 5000)).toBeCloseTo(1.0, 6);
  });

  it("approaches 1.0 over many half-lives", () => {
    expect(decayedMultiplier(2.0, 30 * 60 * 1000, 5 * 60 * 1000)).toBeCloseTo(1.0156, 3);
  });
});

describe("dataFlowForState — Hibernation", () => {
  it("disables session and all data flow", () => {
    const flow = dataFlowForState("hibernation", 0);
    expect(flow.sessionActive).toBe(false);
    expect(flow.heartbeatMs).toBeNull();
    expect(flow.pcmMode).toBe("off");
    expect(flow.motionTriggerEnabled).toBe(false);
    expect(flow.bufferLocally).toBe(false);
  });
});

describe("dataFlowForState — Awake / Waking", () => {
  it("Awake uses 15s heartbeat with attached audio and continuous PCM", () => {
    const flow = dataFlowForState("awake", 0.8);
    expect(flow.heartbeatMs).toBe(15000);
    expect(flow.heartbeatAudioMs).toBe(3000);
    expect(flow.pcmMode).toBe("continuous");
    expect(flow.gridCols).toBe(4);
    expect(flow.gridRows).toBe(4);
    expect(flow.sessionActive).toBe(true);
    expect(flow.bufferLocally).toBe(false);
  });

  it("Waking matches Awake (transient state)", () => {
    const awake = dataFlowForState("awake", 0.5);
    const waking = dataFlowForState("waking", 0.5);
    expect(waking).toEqual(awake);
  });
});

describe("dataFlowForState — Resting (graduated)", () => {
  it("Resting-light (score >= 0.30): 30s heartbeat, no audio attached, full grid", () => {
    const flow = dataFlowForState("resting", 0.40);
    expect(flow.heartbeatMs).toBe(30000);
    expect(flow.heartbeatAudioMs).toBe(0);
    expect(flow.pcmMode).toBe("continuous");
    expect(flow.gridCols).toBe(4);
    expect(flow.gridRows).toBe(4);
  });

  it("Resting-deep (score < 0.30): heartbeat off, VAD-gated PCM, 3x3 grid", () => {
    const flow = dataFlowForState("resting", 0.20);
    expect(flow.heartbeatMs).toBeNull();
    expect(flow.heartbeatAudioMs).toBe(0);
    expect(flow.pcmMode).toBe("vad-gated");
    expect(flow.gridCols).toBe(3);
    expect(flow.gridRows).toBe(3);
    expect(flow.motionTriggerEnabled).toBe(true); // motion-only sends still allowed
  });

  it("Resting boundary at exactly RESTING_DEEP_BOUNDARY uses light tier", () => {
    const flow = dataFlowForState("resting", RESTING_DEEP_BOUNDARY);
    expect(flow.heartbeatMs).toBe(30000); // light tier
  });

  it("Resting just below boundary uses deep tier", () => {
    const flow = dataFlowForState("resting", RESTING_DEEP_BOUNDARY - 0.001);
    expect(flow.heartbeatMs).toBeNull(); // deep tier
  });
});

describe("dataFlowForState — Asleep", () => {
  it("disables sends but keeps session and capture (buffer locally)", () => {
    const flow = dataFlowForState("asleep", 0.05);
    expect(flow.sessionActive).toBe(true);
    expect(flow.heartbeatMs).toBeNull();
    expect(flow.pcmMode).toBe("off");
    expect(flow.motionTriggerEnabled).toBe(false);
    expect(flow.bufferLocally).toBe(true);
  });
});
