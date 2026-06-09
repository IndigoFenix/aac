/**
 * Tests for the repeated-button-press guard decision logic (press-repeat-guard.ts).
 *
 * The guard prevents a perseverating student's repeated taps on the same button
 * from interrupting the in-progress response. These tests cover the pure
 * classification: when a press is coalesced as a repeat vs. dispatched fresh.
 */

import { describe, it, expect } from "@jest/globals";
import { isRepeatPress, formatRepeatNote } from "../services/dual-agent/press-repeat-guard.js";

const WINDOW = 4_000;

function press(overrides: Partial<Parameters<typeof isRepeatPress>[0]> = {}) {
  return isRepeatPress({
    signature: "yes",
    lastSignature: "yes",
    modelResponding: false,
    now: 10_000,
    lastPressAt: 9_000,
    windowMs: WINDOW,
    ...overrides,
  });
}

describe("isRepeatPress", () => {
  it("treats the first press of a burst as fresh (no open burst)", () => {
    expect(press({ lastSignature: null })).toBe(false);
  });

  it("coalesces an identical press while the model is still responding", () => {
    // Even long after the last press, an identical press mid-response is a repeat.
    expect(press({ modelResponding: true, now: 1_000_000, lastPressAt: 0 })).toBe(true);
  });

  it("coalesces an identical press within the window while idle", () => {
    expect(press({ modelResponding: false, now: 11_000, lastPressAt: 9_000 })).toBe(true);
  });

  it("dispatches an identical press after the window has elapsed while idle", () => {
    // 5s gap > 4s window, model idle → student deliberately said it again.
    expect(press({ modelResponding: false, now: 14_001, lastPressAt: 9_000 })).toBe(false);
  });

  it("dispatches a different button even while the model is responding", () => {
    expect(press({ signature: "no", lastSignature: "yes", modelResponding: true })).toBe(false);
  });

  it("treats the window as exclusive at the boundary", () => {
    // now - lastPressAt === windowMs is NOT within the window.
    expect(press({ modelResponding: false, now: 9_000 + WINDOW, lastPressAt: 9_000 })).toBe(false);
    expect(press({ modelResponding: false, now: 9_000 + WINDOW - 1, lastPressAt: 9_000 })).toBe(true);
  });

  it("distinguishes multi-button signatures from single-button ones", () => {
    const sep = String.fromCharCode(1);
    expect(press({ signature: `a${sep}b`, lastSignature: `a${sep}b`, modelResponding: true })).toBe(true);
    expect(press({ signature: `a${sep}b`, lastSignature: `a`, modelResponding: true })).toBe(false);
  });
});

describe("formatRepeatNote", () => {
  it("produces a tagged, monitor-readable perseveration note", () => {
    expect(formatRepeatNote("yes", 4)).toBe("[BUTTON PRESS REPEATED] yes (pressed 4 times in a row)");
  });
});
