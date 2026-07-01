/**
 * Tests for the emergency-alarm visual-confirmation gate (three-agent path).
 *
 * The Observer can raise emergency_alarm off a coarse, text-only [SCENE]
 * posture label (e.g. "lying") or an inference synthesised from earlier text,
 * which are unreliable for this population and have fired false building alarms.
 * shouldSuppressEmergency() holds an emergency until a real camera image has
 * actually reached the Observer recently; the coordinator then forces a focus
 * frame and lets the Observer re-raise only if it truly SEES the emergency.
 *
 * Audio deliberately does NOT satisfy the gate: the coordinator's
 * lastAudioInputAt is bumped by the cheap STT text path too, so it's fresh
 * whenever the mic is on and would defeat the gate (this caused a real false
 * alarm). The gate keys ONLY on a real frame. See agent-coordinator.ts
 * routeAlarm / forwardFrameToObserver.
 */

import { describe, it, expect } from "@jest/globals";
import {
  shouldSuppressEmergency,
  DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS,
} from "../services/dual-agent/alarm-gate.js";

const WIN = DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS;
const NOW = 1_000_000;

describe("shouldSuppressEmergency", () => {
  it("never gates alerts (non-emergency nudges are often text-based)", () => {
    // Even with no frame ever seen, an alert always passes.
    expect(shouldSuppressEmergency("alert", 0, NOW, WIN)).toBe(false);
    expect(shouldSuppressEmergency("alert", NOW - 10 * WIN, NOW, WIN)).toBe(false);
  });

  it("suppresses an emergency when no real frame has ever been seen", () => {
    expect(shouldSuppressEmergency("emergency", 0, NOW, WIN)).toBe(true);
  });

  it("suppresses an emergency when the last real frame is older than the window", () => {
    const stale = NOW - (WIN + 1);
    expect(shouldSuppressEmergency("emergency", stale, NOW, WIN)).toBe(true);
  });

  it("allows an emergency when a real frame was seen within the window", () => {
    const fresh = NOW - Math.floor(WIN / 2);
    expect(shouldSuppressEmergency("emergency", fresh, NOW, WIN)).toBe(false);
  });

  it("treats a frame exactly at the window boundary as still-confirming", () => {
    const edge = NOW - WIN; // now - lastFrame === windowMs, not strictly greater
    expect(shouldSuppressEmergency("emergency", edge, NOW, WIN)).toBe(false);
  });

  it("uses the default window when none is passed", () => {
    const justInside = NOW - (DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS - 1);
    const justOutside = NOW - (DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS + 1);
    expect(shouldSuppressEmergency("emergency", justInside, NOW)).toBe(false);
    expect(shouldSuppressEmergency("emergency", justOutside, NOW)).toBe(true);
  });

  it("gates on the frame ONLY — a mic-on session (fresh audio) must not confirm", () => {
    // Regression: audio was briefly accepted as confirmation, but lastAudioInputAt
    // is bumped by STT text, so it stayed fresh with the mic on and let a visual
    // "lying on the floor" claim through. The gate must ignore audio entirely — so
    // with no recent frame, the emergency is still suppressed no matter the audio.
    expect(shouldSuppressEmergency("emergency", 0, NOW, WIN)).toBe(true);
    const staleFrame = NOW - (WIN + 5000);
    expect(shouldSuppressEmergency("emergency", staleFrame, NOW, WIN)).toBe(true);
  });
});
