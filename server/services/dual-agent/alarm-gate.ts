// server/services/dual-agent/alarm-gate.ts
//
// Pure decision helper for the emergency-alarm visual-confirmation gate.
// Kept dependency-free so it's unit-testable without instantiating the
// AgentCoordinator (which pulls in the whole Gemini Live provider stack).
//
// Why this exists: the Observer can raise emergency_alarm off a coarse,
// text-only [SCENE] posture label (e.g. "lying") or a synthesised inference
// from earlier text. Those readings are unreliable for this population — a
// wheelchair / atypical posture is easily misread — and have fired false
// building alarms with no image behind them. A serious emergency must rest on
// the Observer having actually SEEN a recent camera image (a streamed frame or
// a requested focus frame).
//
// NOTE — audio does NOT satisfy this gate, deliberately. An earlier version
// also accepted "recently heard audio" (lastAudioInputAt) to cover the
// camera-off case. That backfired: lastAudioInputAt is bumped by the cheap STT
// TEXT path (injectHeardSpeech), not just genuinely-heard raw PCM, so with the
// mic on it was almost always fresh — turning the gate into a near no-op and
// letting a visual "lying on the floor" claim through on audio alone. And with
// the camera off there is no pose text to raise a false posture alarm in the
// first place. So the gate keys ONLY on a real frame, which is never set by
// text.

/** Default window: how recent a real camera image must be for an emergency to
 *  be allowed through without forcing a fresh look. Env-tunable at the caller. */
export const DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS = 15000;

/**
 * Whether an Observer-raised alarm should be SUPPRESSED (held) for lack of
 * recent VISUAL confirmation.
 *
 * Only emergencies are gated. Alerts are non-emergency nudges that are often
 * legitimately text/conversation-based (frustration, repeated asking), so they
 * always pass.
 *
 * @param level            "alert" (never gated) or "emergency"
 * @param lastRealFrameAt  ms timestamp of the last real image delivered to the
 *                         Observer; 0 means none this session
 * @param now              current ms timestamp
 * @param windowMs         how recent a real frame must be to count as confirmation
 * @returns true when the emergency should be held pending a real look
 */
export function shouldSuppressEmergency(
  level: "alert" | "emergency",
  lastRealFrameAt: number,
  now: number,
  windowMs: number = DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS,
): boolean {
  if (level !== "emergency") return false;
  if (lastRealFrameAt === 0) return true; // never saw a real image this session
  return now - lastRealFrameAt > windowMs;
}
