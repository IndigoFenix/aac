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

// Resting is an AI decision (the model calls rest()), applied via
// setSleepState — NOT the score machine. So nextSleepState never moves
// awake↔resting on score. Awake only auto-sleeps when the room empties.
describe("nextSleepState — Awake transitions", () => {
  it("stays Awake across the whole engaged range (never auto-rests)", () => {
    expect(nextSleepState("awake", 1, T, 1)).toBe("awake");
    expect(nextSleepState("awake", T.rest, T, 1)).toBe("awake");
    // Below the legacy `rest` threshold but above `sleep`: used to go resting,
    // now stays awake.
    expect(nextSleepState("awake", T.rest - 0.01, T, 1)).toBe("awake");
    expect(nextSleepState("awake", T.sleep, T, 1)).toBe("awake");
  });

  it("drops straight to Asleep when the room empties (score < sleep)", () => {
    expect(nextSleepState("awake", T.sleep - 0.01, T, 1)).toBe("asleep");
    expect(nextSleepState("awake", 0, T, 1)).toBe("asleep");
  });
});

describe("nextSleepState — Resting transitions (AI-set, sticky)", () => {
  it("stays Resting even when a present/engaged user keeps the score high", () => {
    // The whole point: presence (face/voice past the legacy `engaged` band)
    // must NOT pull resting back to awake. Only an always-wake trigger or
    // wake_up() does that, via setSleepState — not this function.
    expect(nextSleepState("resting", 1, T, 1)).toBe("resting");
    expect(nextSleepState("resting", T.engaged, T, 1)).toBe("resting");
    expect(nextSleepState("resting", (T.sleep + T.engaged) / 2, T, 1)).toBe("resting");
  });

  it("falls to Asleep once the room actually empties (score < sleep)", () => {
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

describe("nextSleepState — no score-driven flapping between awake and resting", () => {
  it("a mid-range score holds whichever of awake/resting it's already in", () => {
    const between = (T.rest + T.engaged) / 2;
    expect(nextSleepState("awake", between, T, 1)).toBe("awake");
    expect(nextSleepState("resting", between, T, 1)).toBe("resting");
  });
});

describe("nextSleepState — false-wake dampening", () => {
  it("dampMult raises wakeup threshold proportionally", () => {
    // wakeup = 0.65 * 1.2 = 0.78. Score 0.7 should NOT wake from Asleep with damp.
    expect(nextSleepState("asleep", 0.7, T, 1.2)).toBe("asleep");
    expect(nextSleepState("asleep", 0.8, T, 1.2)).toBe("awake");
  });

  it("dampMult never wakes Resting (resting ignores score entirely)", () => {
    // Resting no longer wakes on score, damped or not — only an always-wake
    // trigger / wake_up() (via setSleepState) leaves it.
    expect(nextSleepState("resting", 0.5, T, 1.2)).toBe("resting");
    expect(nextSleepState("resting", 1, T, 1.2)).toBe("resting");
  });

  it("dampMult does NOT affect the sleep threshold (resting→asleep stays easy)", () => {
    expect(nextSleepState("resting", T.sleep - 0.01, T, 5)).toBe("asleep");
    expect(nextSleepState("awake", T.sleep - 0.01, T, 5)).toBe("asleep");
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

describe("dataFlowForState — Resting (single tier)", () => {
  // Resting is no longer split into light/deep. One config regardless of
  // score: heartbeat OFF, motion frames ON, full grid, VAD-gated PCM. Pairs
  // with the server's lightweight resting session profile.
  it("heartbeat off, motion frames on, full grid, VAD-gated PCM — regardless of score", () => {
    for (const score of [0.40, 0.20, 0.05, RESTING_DEEP_BOUNDARY]) {
      const flow = dataFlowForState("resting", score);
      expect(flow.heartbeatMs).toBeNull();
      expect(flow.heartbeatAudioMs).toBe(0);
      expect(flow.pcmMode).toBe("vad-gated");
      expect(flow.gridCols).toBe(4);
      expect(flow.gridRows).toBe(4);
      expect(flow.motionTriggerEnabled).toBe(true);
      expect(flow.sessionActive).toBe(true);
    }
  });
});

describe("dataFlowForState — awakeDataSaver (cost-saving override)", () => {
  // With the flag set, Awake/Waking stream like a resting session: no
  // heartbeat frames, VAD-gated mic — but motion frames stay on and the
  // session stays active, so the model stays responsive.
  it("Awake adopts the resting input filter when the flag is set", () => {
    const saver = dataFlowForState("awake", 0.8, true);
    const resting = dataFlowForState("resting", 0.2);
    expect(saver).toEqual(resting);
    expect(saver.heartbeatMs).toBeNull();
    expect(saver.heartbeatAudioMs).toBe(0);
    expect(saver.pcmMode).toBe("vad-gated");
    expect(saver.motionTriggerEnabled).toBe(true);
    expect(saver.sessionActive).toBe(true);
  });

  it("Waking also adopts the resting input filter", () => {
    expect(dataFlowForState("waking", 0.5, true)).toEqual(dataFlowForState("resting", 0.5));
  });

  it("defaults off — omitting the flag keeps continuous Awake streaming", () => {
    const flow = dataFlowForState("awake", 0.8);
    expect(flow.heartbeatMs).toBe(15000);
    expect(flow.pcmMode).toBe("continuous");
  });

  it("does not alter non-awake states (resting/asleep/hibernation unchanged)", () => {
    expect(dataFlowForState("resting", 0.2, true)).toEqual(dataFlowForState("resting", 0.2));
    expect(dataFlowForState("asleep", 0.05, true)).toEqual(dataFlowForState("asleep", 0.05));
    expect(dataFlowForState("hibernation", 0, true)).toEqual(dataFlowForState("hibernation", 0));
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
