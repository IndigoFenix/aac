/**
 * Tests for the press-pacing decision logic (press-pacing.ts) — the two
 * per-student options that change WHEN the AI is allowed to answer a button:
 *
 *   pressResponseDelay  — hold the turn so presses CHAIN into one thought
 *   interruptOnNewPress — a different button ABANDONS the answer in flight
 *
 * DB-free by design (belongs in test:unit, not integration/): the module under
 * test has zero imports and every effect is a return value.
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolvePressPacing,
  shouldBargeIn,
  joinPressSentences,
  joinChainedPresses,
  joinPressLabels,
  PRESS_CHAIN_MAX_MS,
  PRESS_CHAIN_MIN_MS,
  PRESS_PACING_DEFAULTS,
} from "../services/dual-agent/press-pacing";

describe("resolvePressPacing", () => {
  it("defaults to today's behavior with no settings row", () => {
    expect(resolvePressPacing(undefined)).toEqual(PRESS_PACING_DEFAULTS);
    expect(resolvePressPacing(null)).toEqual({ chainDelayMs: 0, bargeIn: false });
    expect(resolvePressPacing({})).toEqual({ chainDelayMs: 0, bargeIn: false });
  });

  it("passes a configured hold through", () => {
    expect(resolvePressPacing({ pressResponseDelay: 3000 }).chainDelayMs).toBe(3000);
  });

  it("treats 0 (and anything below the floor) as off", () => {
    expect(resolvePressPacing({ pressResponseDelay: 0 }).chainDelayMs).toBe(0);
    expect(resolvePressPacing({ pressResponseDelay: PRESS_CHAIN_MIN_MS - 1 }).chainDelayMs).toBe(0);
    // A negative can only come from a corrupted row; it must not arm a timer.
    expect(resolvePressPacing({ pressResponseDelay: -2000 }).chainDelayMs).toBe(0);
  });

  it("keeps the floor itself on", () => {
    expect(resolvePressPacing({ pressResponseDelay: PRESS_CHAIN_MIN_MS }).chainDelayMs).toBe(PRESS_CHAIN_MIN_MS);
  });

  it("clamps a hold long enough to look like a dead device", () => {
    expect(resolvePressPacing({ pressResponseDelay: 600_000 }).chainDelayMs).toBe(PRESS_CHAIN_MAX_MS);
  });

  it("ignores non-numeric junk rather than arming NaN", () => {
    expect(resolvePressPacing({ pressResponseDelay: "soon" as unknown as number }).chainDelayMs).toBe(0);
    expect(resolvePressPacing({ pressResponseDelay: NaN }).chainDelayMs).toBe(0);
  });

  it("reads the barge-in flag independently of the hold", () => {
    expect(resolvePressPacing({ interruptOnNewPress: true })).toEqual({ chainDelayMs: 0, bargeIn: true });
    expect(resolvePressPacing({ pressResponseDelay: 2000, interruptOnNewPress: true }))
      .toEqual({ chainDelayMs: 2000, bargeIn: true });
  });
});

describe("shouldBargeIn", () => {
  const base = { enabled: true, isRepeat: false, aiSpeaking: true, boardBuilding: false };

  it("fires on a different button while the AI is speaking", () => {
    expect(shouldBargeIn(base)).toBe(true);
  });

  it("fires while the replacement board is still being built", () => {
    expect(shouldBargeIn({ ...base, aiSpeaking: false, boardBuilding: true })).toBe(true);
  });

  it("never fires on a re-press of the SAME button", () => {
    // Perseveration belongs to press-repeat-guard.ts — tapping "juice" five
    // times must not tear down the answer to "juice".
    expect(shouldBargeIn({ ...base, isRepeat: true })).toBe(false);
    expect(shouldBargeIn({ ...base, isRepeat: true, boardBuilding: true })).toBe(false);
  });

  it("does nothing when the option is off", () => {
    expect(shouldBargeIn({ ...base, enabled: false })).toBe(false);
  });

  it("does nothing when there is nothing in flight to abandon", () => {
    expect(shouldBargeIn({ ...base, aiSpeaking: false, boardBuilding: false })).toBe(false);
  });
});

describe("joinPressSentences (social-trainer reply buffer)", () => {
  it("terminates each buffered reply so the peer reads them as separate lines", () => {
    expect(joinPressSentences(["Me too", "What about you?"])).toBe("Me too. What about you?");
  });

  it("leaves existing punctuation alone", () => {
    expect(joinPressSentences(["Me too.", "What about you?"])).toBe("Me too. What about you?");
  });

  it("drops blank and whitespace-only fragments", () => {
    expect(joinPressSentences(["", "  ", "hello"])).toBe("hello.");
    expect(joinPressSentences([])).toBe("");
  });
});

describe("joinChainedPresses", () => {
  it("assembles word-at-a-time presses into ONE thought", () => {
    // The whole point of the feature: not "I. Want. Juice." (three statements
    // the agents would answer separately), and no invented punctuation.
    expect(joinChainedPresses(["I", "want", "juice"])).toBe("I want juice");
  });

  it("keeps punctuation the buttons already carry", () => {
    expect(joinChainedPresses(["I'm hungry.", "Can we eat?"])).toBe("I'm hungry. Can we eat?");
  });

  it("collapses stray whitespace inside fragments", () => {
    expect(joinChainedPresses(["  I  want ", "juice  "])).toBe("I want juice");
  });

  it("drops blank fragments and survives an empty chain", () => {
    expect(joinChainedPresses(["", "  ", "hello"])).toBe("hello");
    expect(joinChainedPresses([])).toBe("");
  });

  it("passes a single press through untouched", () => {
    expect(joinChainedPresses(["I am hungry."])).toBe("I am hungry.");
  });
});

describe("joinPressLabels", () => {
  it("joins labels without inventing punctuation", () => {
    // Labels are UI text, not prose — "More" must not become "More."
    expect(joinPressLabels(["I", "want", "More"])).toBe("I want More");
  });

  it("drops blanks", () => {
    expect(joinPressLabels(["yes", "", " "])).toBe("yes");
  });
});
