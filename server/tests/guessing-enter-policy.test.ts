// Unit tests for the guessing_enter dwell-refire protection.
// Pure-logic, no DB / no LLM — safe in the default `npm test` run.
//
// Regression context (Auerhahn session 8daad44a, 2026-07-28): dwell-toggle
// bursts sent guessing_enter every few seconds — some while guessing was
// already active — and every one reset the narrowing engine and made the
// Speaker voice the identical opener seven times in under a minute.

import {
  decideGuessingEnter,
  GUESSING_ENTRY_VOICE_COOLDOWN_MS,
} from "../services/dual-agent/guessing-enter-policy";

const T0 = 1_700_000_000_000;

describe("decideGuessingEnter", () => {
  it("first-ever entry is voiced", () => {
    expect(
      decideGuessingEnter({
        activeOrigin: null,
        incomingOrigin: "conversation",
        lastEntryVoicedAt: 0,
        now: T0,
      }),
    ).toBe("enter");
  });

  it("re-fire while already active with the same origin is ignored (engine state preserved)", () => {
    expect(
      decideGuessingEnter({
        activeOrigin: "conversation",
        incomingOrigin: "conversation",
        lastEntryVoicedAt: T0 - 5_000,
        now: T0,
      }),
    ).toBe("ignore_duplicate");
    expect(
      decideGuessingEnter({
        activeOrigin: "builder",
        incomingOrigin: "builder",
        lastEntryVoicedAt: 0,
        now: T0,
      }),
    ).toBe("ignore_duplicate");
  });

  it("an origin change while active is a real transition, not a duplicate", () => {
    expect(
      decideGuessingEnter({
        activeOrigin: "conversation",
        incomingOrigin: "builder",
        lastEntryVoicedAt: 0,
        now: T0,
      }),
    ).toBe("enter");
  });

  it("exit→re-enter inside the cooldown enters silently instead of repeating the opener", () => {
    expect(
      decideGuessingEnter({
        activeOrigin: null,
        incomingOrigin: "conversation",
        lastEntryVoicedAt: T0 - 15_000,
        now: T0,
      }),
    ).toBe("enter_silent");
  });

  it("re-enter after the cooldown voices the opener again", () => {
    expect(
      decideGuessingEnter({
        activeOrigin: null,
        incomingOrigin: "conversation",
        lastEntryVoicedAt: T0 - GUESSING_ENTRY_VOICE_COOLDOWN_MS - 1,
        now: T0,
      }),
    ).toBe("enter");
  });

  it("cooldown boundary is exclusive at exactly the window edge", () => {
    expect(
      decideGuessingEnter({
        activeOrigin: null,
        incomingOrigin: "conversation",
        lastEntryVoicedAt: T0 - GUESSING_ENTRY_VOICE_COOLDOWN_MS,
        now: T0,
      }),
    ).toBe("enter");
  });
});
