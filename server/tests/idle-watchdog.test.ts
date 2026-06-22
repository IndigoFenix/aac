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
});
