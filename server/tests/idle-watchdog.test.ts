/**
 * Unit tests for the AgentCoordinator idle-watchdog decision logic.
 *
 * Covers the threshold ladder (rest → sleep) and every guard that must
 * short-circuit to "none". The side-effectful transitions live in
 * AgentCoordinator; this only verifies what the watchdog DECIDES.
 */

import { describe, it, expect } from "@jest/globals";
import {
  decideIdleTransition,
  idleThresholdScaleForBand,
  type IdleWatchdogInput,
} from "../services/dual-agent/idle-watchdog.js";

const REST_AFTER_MS = 90_000;
const SLEEP_AFTER_MS = 300_000;

function input(overrides: Partial<IdleWatchdogInput> = {}): IdleWatchdogInput {
  return {
    idleMs: 0,
    sessionProfile: "awake",
    ready: true,
    paused: false,
    asleep: false,
    inSocialSession: false,
    slpMode: false,
    restAfterMs: REST_AFTER_MS,
    sleepAfterMs: SLEEP_AFTER_MS,
    ...overrides,
  };
}

describe("decideIdleTransition", () => {
  describe("threshold ladder", () => {
    it("does nothing below the rest threshold", () => {
      expect(decideIdleTransition(input({ idleMs: REST_AFTER_MS - 1 }))).toBe("none");
    });

    it("rests at exactly the rest threshold (awake)", () => {
      expect(decideIdleTransition(input({ idleMs: REST_AFTER_MS }))).toBe("rest");
    });

    it("rests between the rest and sleep thresholds (awake)", () => {
      expect(decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS - 1 }))).toBe("rest");
    });

    it("sleeps at exactly the sleep threshold", () => {
      expect(decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS }))).toBe("sleep");
    });

    it("sleeps directly from awake when past the sleep threshold (skips rest)", () => {
      expect(
        decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS + 60_000, sessionProfile: "awake" })),
      ).toBe("sleep");
    });
  });

  describe("resting profile", () => {
    it("does not re-rest a resting session below the sleep threshold", () => {
      expect(
        decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS - 1, sessionProfile: "resting" })),
      ).toBe("none");
    });

    it("sleeps a resting session past the sleep threshold", () => {
      expect(
        decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS, sessionProfile: "resting" })),
      ).toBe("sleep");
    });
  });

  describe("guards (always 'none' regardless of idle)", () => {
    const wayPastSleep = SLEEP_AFTER_MS * 10;

    it("not ready (initializing/closing)", () => {
      expect(decideIdleTransition(input({ idleMs: wayPastSleep, ready: false }))).toBe("none");
    });

    it("paused", () => {
      expect(decideIdleTransition(input({ idleMs: wayPastSleep, paused: true }))).toBe("none");
    });

    it("already asleep", () => {
      expect(decideIdleTransition(input({ idleMs: wayPastSleep, asleep: true }))).toBe("none");
    });

    it("in a social-training session", () => {
      expect(
        decideIdleTransition(input({ idleMs: wayPastSleep, inSocialSession: true })),
      ).toBe("none");
    });
  });

  // SLP MODE (per logged-in USER, users.slp_mode): a therapy session is full
  // of long deliberate silences, so the watchdog must never drop the session
  // on its own — the therapist uses the explicit wake/sleep control instead.
  describe("SLP mode", () => {
    it("never rests at the rest threshold", () => {
      expect(
        decideIdleTransition(input({ idleMs: REST_AFTER_MS, slpMode: true })),
      ).toBe("none");
    });

    it("never sleeps at the sleep threshold", () => {
      expect(
        decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS, slpMode: true })),
      ).toBe("none");
    });

    it("never sleeps no matter how long the session is idle", () => {
      expect(
        decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS * 100, slpMode: true })),
      ).toBe("none");
    });

    it("never sleeps a session that is already resting", () => {
      expect(
        decideIdleTransition(
          input({ idleMs: SLEEP_AFTER_MS * 10, sessionProfile: "resting", slpMode: true }),
        ),
      ).toBe("none");
    });

    it("does not suppress anything when off (baseline unchanged)", () => {
      expect(decideIdleTransition(input({ idleMs: REST_AFTER_MS, slpMode: false }))).toBe("rest");
      expect(decideIdleTransition(input({ idleMs: SLEEP_AFTER_MS, slpMode: false }))).toBe("sleep");
    });
  });
});

describe("idleThresholdScaleForBand (energy-scaled throttle)", () => {
  it("leaves thresholds unchanged at high energy", () => {
    expect(idleThresholdScaleForBand("high")).toBe(1);
  });

  it("tightens moderately at moderate energy", () => {
    expect(idleThresholdScaleForBand("moderate")).toBeCloseTo(0.6, 5);
  });

  it("tightens aggressively at low energy (~3x sooner)", () => {
    expect(idleThresholdScaleForBand("low")).toBeCloseTo(1 / 3, 5);
  });

  it("monotonically shrinks as energy falls", () => {
    expect(idleThresholdScaleForBand("high")).toBeGreaterThan(idleThresholdScaleForBand("moderate"));
    expect(idleThresholdScaleForBand("moderate")).toBeGreaterThan(idleThresholdScaleForBand("low"));
  });

  it("a low-energy session sleeps after ~100s instead of 300s", () => {
    expect(Math.round(SLEEP_AFTER_MS * idleThresholdScaleForBand("low"))).toBe(100_000);
  });
});
