// server/services/dual-agent/client-config.ts
//
// Server-supplied tuning for the AAC client. Sent once per session in the
// `initialized` server→client message. The client uses these values to
// configure its activity monitor, sleep state machine, and gesture
// serializer — replacing hardcoded constants that previously required a
// client rebuild + redeploy to change.
//
// The client may also expose some of these to caretakers in the future
// (accessibility settings, custom thresholds per student). All fields are
// optional; the client should fall back to its built-in defaults when a
// value is missing or undefined, so older client builds keep working
// against newer servers and vice versa.
//
// I/O impact: ONE small JSON blob per session, attached to a message the
// client already receives. No new per-frame or per-event traffic.

import type { LLMProviderKey } from "@shared/llm-options";
import "@shared/llm-options"; // ensure type module loads
// (LLMProviderKey is unused but kept for parity with neighboring types.)
void (null as unknown as LLMProviderKey | undefined);

/**
 * Tuning constants for `useActivityMonitor` — how aggressively to capture
 * frames, how long to wait for activity to settle before sending, etc.
 * Tweaks here change AI perception cadence without touching the client.
 */
export interface ActivityMonitorConfig {
  /** Frames per second to capture into the ring buffer. */
  frameCaptureRate?: number;
  /** Seconds of frames to retain. */
  maxBufferSeconds?: number;
  gridCols?: number;
  gridRows?: number;
  /** Wait after activity stops before sending, in ms. */
  activitySettleMs?: number;
  /** Max time without sending even when nothing happens, in ms. */
  maxSilenceMs?: number;
  /** Minimum time between sends, in ms. */
  minIntervalMs?: number;
  /** Pre-roll added before the speech-start boundary, in ms. */
  speechPreRollMs?: number;
  /** Post-roll added after the speech-end boundary, in ms. */
  speechPostRollMs?: number;
  /** Duration of ambient audio attached to heartbeat triggers, in ms. */
  heartbeatAudioMs?: number;
}

/**
 * Thresholds and dampening for the client-side sleep / engagement state
 * machine (`sleepSystemLogic.ts`). The state machine itself still runs
 * on-client (raw signals fire too often to ship per-event), but the
 * NUMBERS that govern when transitions happen are server-driven.
 */
export interface SleepEngineConfig {
  /** Score threshold below which awake → asleep. */
  sleepThreshold?: number;
  /** Score threshold above which asleep → awake. */
  wakeupThreshold?: number;
  /** Half-life of engagement-signal decay, in ms. */
  signalHalfLifeMs?: number;
  /** Multiplier applied per false-wake to dampen the wakeup threshold. */
  falseWakeBumpFactor?: number;
  /** Half-life of false-wake dampening decay, in ms. */
  falseWakeDecayHalfLifeMs?: number;
  /** Cap on the dampened wakeup threshold so we never lock the user out. */
  falseWakeMaxThreshold?: number;
}

/**
 * Tuning for `gestureContextSerializer.ts` — how far back in time to
 * window face/hand events when formatting the AI context string.
 */
export interface GestureSerializerConfig {
  /** Time window for the "recent events" digest, in ms. */
  windowMs?: number;
}

export interface ClientConfig {
  activityMonitor?: ActivityMonitorConfig;
  sleep?: SleepEngineConfig;
  gestureSerializer?: GestureSerializerConfig;
}

/**
 * The default config the server ships when the student / session has no
 * overrides. Values mirror the current client-side hardcoded defaults —
 * the move to server-driven config is non-breaking by construction.
 * Future per-student overrides layer on top of this.
 */
export function buildDefaultClientConfig(): ClientConfig {
  return {
    activityMonitor: {
      frameCaptureRate: 4,
      maxBufferSeconds: 16,
      gridCols: 4,
      gridRows: 4,
      activitySettleMs: 1500,
      maxSilenceMs: 15000,
      minIntervalMs: 3000,
      speechPreRollMs: 500,
      speechPostRollMs: 200,
      heartbeatAudioMs: 3000,
    },
    sleep: {
      // Mirrors the existing CameraAttentivenessContext defaults — leave
      // numbers as-is during the migration, tune later from the server.
      sleepThreshold: 0.05,
      wakeupThreshold: 0.30,
      signalHalfLifeMs: 8000,
      falseWakeBumpFactor: 1.5,
      falseWakeDecayHalfLifeMs: 60000,
      falseWakeMaxThreshold: 0.85,
    },
    gestureSerializer: {
      windowMs: 10000,
    },
  };
}
