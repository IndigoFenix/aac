// server/services/dual-agent/alarm-gate.ts
//
// Pure decision helper for the emergency-alarm visual-confirmation gate.
// Kept dependency-free so it's unit-testable without instantiating the
// AgentCoordinator (which pulls in the whole Gemini Live provider stack).
//
// Why this exists: the Observer can raise emergency_alarm off a coarse,
// text-only [SCENE] posture label (e.g. "lying") or an STT transcript. Those
// text readings are unreliable for this population — a wheelchair / atypical
// posture is easily misread — and have fired false building alarms with nothing
// really perceived behind them. A serious emergency must rest on RECENT REAL
// PERCEPTION: a camera image the Observer actually saw (a streamed frame or a
// requested focus frame), OR audio it actually heard (live PCM / a pulled clip).
// Text alone (posture labels, STT) never counts — so with the camera off there
// is no false posture text to alarm on, yet a genuinely HEARD emergency can
// still go through.

/** Default window: how recent real perception (frame or heard audio) must be
 *  for an emergency to pass without forcing a fresh look. Env-tunable at the
 *  caller. */
export const DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS = 15000;

/** Timestamps (ms) of the Observer's last genuine sensory input. Both exclude
 *  text: `lastRealFrameAt` is a real image (not a [SCENE] line);
 *  `lastRealAudioAt` is live PCM or a pulled audio clip (not an STT transcript).
 *  0 means that channel has had nothing this session. */
export interface SensedAt {
  lastRealFrameAt: number;
  lastRealAudioAt: number;
}

/**
 * Whether an Observer-raised alarm should be SUPPRESSED (held) for lack of
 * recent real perception.
 *
 * Only emergencies are gated. Alerts are non-emergency nudges that are often
 * legitimately text/conversation-based (frustration, repeated asking), so they
 * always pass.
 *
 * @param level    "alert" (never gated) or "emergency"
 * @param sensed   last-real-frame / last-real-audio timestamps (text excluded)
 * @param now      current ms timestamp
 * @param windowMs how recent perception must be to count as confirmation
 * @returns true when the emergency should be held pending a real look/listen
 */
export function shouldSuppressEmergency(
  level: "alert" | "emergency",
  sensed: SensedAt,
  now: number,
  windowMs: number = DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS,
): boolean {
  if (level !== "emergency") return false;
  const lastSensedAt = Math.max(sensed.lastRealFrameAt, sensed.lastRealAudioAt);
  if (lastSensedAt === 0) return true; // no real image or heard audio this session
  return now - lastSensedAt > windowMs;
}
