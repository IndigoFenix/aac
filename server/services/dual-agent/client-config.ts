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
  /**
   * Cost-saving toggle. When true, the client applies the resting session's
   * input filter while AWAKE too: no periodic heartbeat frames and VAD-gated
   * mic audio (only speech / sudden sound streams), instead of continuous
   * audio + a heartbeat frame every 15s. Motion-triggered frames and spoken
   * audio still reach the model, so the session stays responsive — it just
   * stops paying for continuous streaming during conversational lulls.
   *
   * Driven by the `AAC_AWAKE_DATA_SAVER=1` server env var so it can be
   * flipped without a client rebuild. The server session profile is
   * unaffected (still full awake Speaker + prompt); this only thins the
   * client→model I/O.
   */
  awakeDataSaver?: boolean;
  /**
   * Cost-saving (Phase 1): the server activated on-device speech-to-text for
   * this session (full-attention OFF + client advertised `clientStt`). When
   * true, the client transcribes VAD speech segments locally and sends
   * `speech_text` instead of streaming raw audio, and SUPPRESSES continuous PCM
   * (the server ignores it anyway). When false, the client streams audio as
   * before. Server-resolved via `capable()`.
   */
  sttActive?: boolean;
  /**
   * Cost-saving (Phase 2): the server activated scene-state text. When true, the
   * client sends a compact `scene_state` text description in place of a JPEG
   * frame while the scene is stable, and only sends real frames on escalations
   * (new/lost person, new gesture, safety). Server-resolved via
   * `capable("sceneState")`.
   */
  sceneStateActive?: boolean;
  /**
   * Audio "live" attention: stream raw PCM CONTINUOUSLY (no VAD/silence gate)
   * even while economizing. Set by the Observer's set_audio_attention("live").
   * When false (the default / "adaptive"), raw PCM is still VAD-gated by the
   * data-flow (silence dropped). Independent of `awakeDataSaver` so audio
   * fidelity can be raised without changing visual/heartbeat behavior. Only
   * meaningful when sttActive is false (otherwise PCM is suppressed for STT).
   */
  pcmContinuous?: boolean;
}

/**
 * The default config the server ships when the student / session has no
 * overrides. Values mirror the current client-side hardcoded defaults —
 * the move to server-driven config is non-breaking by construction.
 * Future per-student overrides layer on top of this.
 */
export function buildDefaultClientConfig(
  overrides?: Pick<ClientConfig, "awakeDataSaver" | "sttActive" | "sceneStateActive" | "pcmContinuous">,
): ClientConfig {
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
    // Authoritative value comes from the per-student `fullAttentionMode`
    // setting (passed in by the caller as the inverse). The env var is a
    // global fallback for callers that don't supply a student override.
    awakeDataSaver: overrides?.awakeDataSaver ?? (process.env.AAC_AWAKE_DATA_SAVER === "1"),
    // Resolved by the coordinator via capable("clientStt"); no env fallback
    // here (capability gating needs the per-session client advertisement).
    sttActive: overrides?.sttActive ?? false,
    // Resolved by the coordinator via capable("sceneState").
    sceneStateActive: overrides?.sceneStateActive ?? false,
    // Off by default — raw PCM stays VAD-gated ("adaptive"). The Observer flips
    // it on via set_audio_attention("live").
    pcmContinuous: overrides?.pcmContinuous ?? false,
  };
}
