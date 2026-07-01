/**
 * Tests for the emergency-alarm visual-confirmation gate (three-agent path).
 *
 * The Observer can raise emergency_alarm off a coarse, text-only [SCENE]
 * posture label (e.g. "lying") or an STT transcript, which are unreliable for
 * this population and have fired false building alarms. shouldSuppressEmergency()
 * holds an emergency until RECENT REAL PERCEPTION reached the Observer — a real
 * camera image OR genuinely heard audio; the coordinator then forces a focus
 * frame and lets the Observer re-raise only if it truly SEES or HEARS the
 * emergency. See agent-coordinator.ts routeAlarm / forwardFrameToObserver.
 */

import { describe, it, expect } from "@jest/globals";
import {
  shouldSuppressEmergency,
  DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS,
} from "../services/dual-agent/alarm-gate.js";

const WIN = DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS;
const NOW = 1_000_000;

/** Build a SensedAt with the given frame/audio timestamps (default: none). */
const sensed = (lastRealFrameAt = 0, lastRealAudioAt = 0) => ({ lastRealFrameAt, lastRealAudioAt });

describe("shouldSuppressEmergency", () => {
  it("never gates alerts (non-emergency nudges are often text-based)", () => {
    // Even with nothing ever perceived, an alert always passes.
    expect(shouldSuppressEmergency("alert", sensed(), NOW, WIN)).toBe(false);
    expect(shouldSuppressEmergency("alert", sensed(NOW - 10 * WIN), NOW, WIN)).toBe(false);
  });

  it("suppresses an emergency when nothing real has been perceived this session", () => {
    expect(shouldSuppressEmergency("emergency", sensed(), NOW, WIN)).toBe(true);
  });

  it("suppresses an emergency when the last frame AND audio are older than the window", () => {
    const stale = NOW - (WIN + 1);
    expect(shouldSuppressEmergency("emergency", sensed(stale, stale), NOW, WIN)).toBe(true);
  });

  it("allows an emergency when a real frame was seen within the window", () => {
    const fresh = NOW - Math.floor(WIN / 2);
    expect(shouldSuppressEmergency("emergency", sensed(fresh, 0), NOW, WIN)).toBe(false);
  });

  it("allows an emergency when audio was heard within the window (camera off / no frame)", () => {
    const fresh = NOW - Math.floor(WIN / 2);
    // No frame at all, but genuinely heard audio recently → real perception.
    expect(shouldSuppressEmergency("emergency", sensed(0, fresh), NOW, WIN)).toBe(false);
  });

  it("uses whichever channel is more recent (stale frame, fresh audio → allow)", () => {
    const staleFrame = NOW - (WIN + 5000);
    const freshAudio = NOW - 1000;
    expect(shouldSuppressEmergency("emergency", sensed(staleFrame, freshAudio), NOW, WIN)).toBe(false);
  });

  it("treats perception exactly at the window boundary as still-confirming", () => {
    const edge = NOW - WIN; // now - lastSensed === windowMs, not strictly greater
    expect(shouldSuppressEmergency("emergency", sensed(edge, 0), NOW, WIN)).toBe(false);
  });

  it("uses the default window when none is passed", () => {
    const justInside = NOW - (DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS - 1);
    const justOutside = NOW - (DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS + 1);
    expect(shouldSuppressEmergency("emergency", sensed(justInside), NOW)).toBe(false);
    expect(shouldSuppressEmergency("emergency", sensed(justOutside), NOW)).toBe(true);
  });
});
