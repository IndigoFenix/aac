/**
 * sleepSystemLogic.ts
 *
 * Pure functions for the AAC sleep system. No React, no DOM, no timers —
 * extracted so the engagement-score combiner and state-transition rules can
 * be unit-tested independently of the Provider that drives them.
 *
 * The runtime context (CameraAttentivenessContext) calls these on each tick.
 *
 * See planning-docs/aac-sleep-system-plan.md for the design.
 */

import type { EngagementSignalKind, SleepState } from "./cameraAttentivenessTypes";

export interface SleepThresholds {
  /** Awake → Resting */
  rest: number;
  /** Resting → Awake (lower than wakeup) */
  engaged: number;
  /** Resting → Asleep */
  sleep: number;
  /** Asleep → Awake */
  wakeup: number;
}

/**
 * Apply exponential decay to all contributions and return the total score.
 * Contributions below the threshold (0.001) are dropped to keep the map small.
 */
export function decayAndScore(
  contributions: Partial<Record<EngagementSignalKind, number>>,
  dtMs: number,
  halfLifeMs: number,
): { contributions: Partial<Record<EngagementSignalKind, number>>; score: number } {
  const decayFactor = Math.pow(0.5, dtMs / halfLifeMs);
  const out: Partial<Record<EngagementSignalKind, number>> = {};
  let total = 0;
  for (const k of Object.keys(contributions) as EngagementSignalKind[]) {
    const decayed = (contributions[k] ?? 0) * decayFactor;
    if (decayed >= 0.001) {
      out[k] = decayed;
      total += decayed;
    }
  }
  return { contributions: out, score: Math.min(1, total) };
}

/**
 * Push a signal: contribution refreshes to max(current, weight × intensity).
 * Multiple pushes in a row don't accumulate — they refresh.
 */
export function pushedContribution(
  current: number | undefined,
  weight: number,
  intensity: number,
): number {
  const i = Math.max(0, Math.min(1, intensity));
  const target = weight * i;
  return Math.max(current ?? 0, target);
}

/**
 * Compute the next sleep state given the current state, score, thresholds,
 * and false-wake dampening multiplier. Hibernation and Waking are sticky —
 * they only exit via explicit triggers (triggerAlwaysWake / setSleepState).
 */
export function nextSleepState(
  current: SleepState,
  score: number,
  thresholds: SleepThresholds,
  dampMult: number,
): SleepState {
  const dampedWakeup = Math.min(1, thresholds.wakeup * dampMult);
  switch (current) {
    case "hibernation":
    case "waking":
      return current;
    case "awake":
      // Resting is NO LONGER score-driven — it's an AI decision (the model
      // calls rest() when the user is present but not using the AAC), applied
      // via setSleepState. The score machine only handles the "nobody's here"
      // case from awake: an abandoned session drops straight to asleep so it
      // stops paying for the full awake profile. (thresholds.rest /
      // thresholds.engaged are retained on the interface but unused here.)
      return score < thresholds.sleep ? "asleep" : "awake";
    case "resting":
      // AI-controlled and STICKY against engagement: a present (even talking)
      // user must NOT pull it back to awake — only a deliberate AAC interaction
      // (always-wake trigger) or the model's own wake_up() does that, both
      // routed through setSleepState/triggerAlwaysWake, not this function. It
      // still falls to asleep once the room actually empties.
      if (score < thresholds.sleep) return "asleep";
      return "resting";
    case "asleep":
      return score >= dampedWakeup ? "awake" : "asleep";
  }
}

/**
 * Bump the false-wake threshold multiplier upward (capped so the wakeup
 * threshold stays below maxThreshold).
 */
export function bumpedMultiplier(
  current: number,
  bumpFactor: number,
  baseWakeup: number,
  maxThreshold: number,
): number {
  return Math.min(maxThreshold / baseWakeup, current * bumpFactor);
}

/**
 * Decay the false-wake multiplier exponentially back toward 1.0.
 */
export function decayedMultiplier(current: number, dtMs: number, halfLifeMs: number): number {
  const decay = Math.pow(0.5, dtMs / halfLifeMs);
  return 1 + (current - 1) * decay;
}

// =============================================================================
// State → Data flow mapping (Phase 2)
// =============================================================================

export type PcmMode = "continuous" | "vad-gated" | "off";

export interface DataFlowConfig {
  /** Heartbeat interval in ms; null = heartbeats disabled */
  heartbeatMs: number | null;
  /** Audio attached to each heartbeat in ms; 0 = no audio */
  heartbeatAudioMs: number;
  /** Mic PCM streaming mode */
  pcmMode: PcmMode;
  /** Frame grid columns */
  gridCols: number;
  /** Frame grid rows */
  gridRows: number;
  /** Whether motion-settled triggers may fire detection sends */
  motionTriggerEnabled: boolean;
  /** Buffer captured frames/audio locally instead of sending to the model */
  bufferLocally: boolean;
  /** Whether the live session should be active at all */
  sessionActive: boolean;
}

/**
 * @deprecated Resting is no longer split into light/deep tiers. Kept exported
 * so any external reference still compiles; `dataFlowForState` ignores it.
 */
export const RESTING_DEEP_BOUNDARY = 0.30;

/**
 * Map (sleepState, engagementScore) to the data-flow configuration that
 * should be in effect. Single source of truth for gating decisions.
 *
 * See planning-docs/aac-sleep-system-plan.md "Per-State Data Flow" table.
 *
 * RESTING is now a single tier: no heartbeat frames (so we stop paying for a
 * full frame_grid every 15-30s while nobody's using the device), but motion
 * still triggers frames, and PCM is VAD-gated so audio only streams when the
 * client's audioActivityMonitor detects speech/sound. The server pairs this
 * with the lightweight resting session profile (small prompt, 4 tools, tight
 * compression) — see LiveRelay.switchSessionProfile.
 */
export function dataFlowForState(
  state: SleepState,
  _score: number,
  awakeDataSaver = false,
): DataFlowConfig {
  // Cost-saving override: while awake (or waking), stream like a resting
  // session — no periodic heartbeat frames, VAD-gated mic — instead of
  // continuous audio + a heartbeat every 15s. Motion frames and spoken audio
  // still get through, so the session stays responsive; it just stops paying
  // for continuous streaming during conversational lulls. The server session
  // profile is unaffected (still full awake Speaker + prompt). Server-driven
  // via the AAC_AWAKE_DATA_SAVER env var → clientConfig.awakeDataSaver.
  if (awakeDataSaver && (state === "awake" || state === "waking")) {
    state = "resting";
  }
  switch (state) {
    case "hibernation":
      return {
        heartbeatMs: null,
        heartbeatAudioMs: 0,
        pcmMode: "off",
        gridCols: 0,
        gridRows: 0,
        motionTriggerEnabled: false,
        bufferLocally: false,
        sessionActive: false,
      };
    case "waking":
    case "awake":
      return {
        heartbeatMs: 15000,
        heartbeatAudioMs: 3000,
        pcmMode: "continuous",
        gridCols: 4,
        gridRows: 4,
        motionTriggerEnabled: true,
        bufferLocally: false,
        sessionActive: true,
      };
    case "resting":
      // Single resting tier: heartbeat OFF, motion frames ON, PCM VAD-gated.
      // The model only "sees" the room when something moves, and only "hears"
      // it when the audioActivityMonitor flags speech/sound — so a quiet
      // session costs almost nothing, but a sudden noise or someone
      // addressing the device still wakes it.
      return {
        heartbeatMs: null,
        heartbeatAudioMs: 0,
        pcmMode: "vad-gated",
        gridCols: 4,
        gridRows: 4,
        motionTriggerEnabled: true,
        bufferLocally: false,
        sessionActive: true,
      };
    case "asleep":
      return {
        heartbeatMs: null,
        heartbeatAudioMs: 0,
        pcmMode: "off",
        gridCols: 4,
        gridRows: 4,
        motionTriggerEnabled: false,
        bufferLocally: true,
        sessionActive: true,
      };
  }
}
