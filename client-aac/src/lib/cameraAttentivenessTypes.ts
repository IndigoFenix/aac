/**
 * cameraAttentivenessTypes.ts
 *
 * Types and constants for the camera attentiveness system.
 * This system manages intelligent camera monitoring with sleep/wake states,
 * motion detection, and AI-controllable parameters.
 */

/**
 * Capture frequency modes - how often the camera takes pictures
 */
export type CaptureFrequency = 'sleep' | 'low' | 'medium' | 'high';

/**
 * Resolution modes - image quality/detail level
 */
export type CaptureResolution = 'low' | 'medium' | 'high';

/**
 * Combined attentiveness mode settings
 */
export interface AttentivenessMode {
  frequency: CaptureFrequency;
  resolution: CaptureResolution;
}

/**
 * Capture frequency intervals in milliseconds
 */
export const FREQUENCY_INTERVALS: Record<CaptureFrequency, number> = {
  sleep: 5000,    // 5 seconds when sleeping (just checking for motion)
  low: 2000,      // 2 seconds - basic monitoring
  medium: 1000,   // 1 second - active monitoring
  high: 250,      // 250ms (4fps) - high attention mode
};

/**
 * Resolution settings for canvas capture
 */
export const RESOLUTION_SETTINGS: Record<CaptureResolution, { width: number; height: number }> = {
  low: { width: 160, height: 120 },     // Very small - for motion detection only
  medium: { width: 320, height: 240 },  // Medium - for basic visual analysis
  high: { width: 640, height: 480 },    // High - for detailed analysis (text reading)
};

/**
 * Motion detection thresholds
 */
export const MOTION_THRESHOLDS = {
  /** Minimum pixel difference to count as changed (0-255) */
  pixelSensitivity: 30,
  /** Percentage of pixels that need to change to count as motion (0-1) */
  motionThreshold: 0.02,
  /** Time without motion before going to sleep (ms) */
  sleepTimeout: 10000,
  /** Minimum motion level to wake up from sleep (0-1) */
  wakeThreshold: 0.03,
};

/**
 * Current state of the camera attentiveness system
 */
export interface CameraAttentivenessState {
  /** Whether the camera is actively monitoring */
  isAwake: boolean;
  /** Current mode settings */
  mode: AttentivenessMode;
  /** Timestamp of last detected motion */
  lastMotionDetected: number | null;
  /** Current motion level (0-1 scale) */
  motionLevel: number;
  /** Whether a capture is currently in progress */
  isCapturing: boolean;
  /** Whether the system is initialized and running */
  isRunning: boolean;
  /** Any error message */
  error: string | null;
  /** Number of frames captured this session */
  frameCount: number;
  /** Last captured frame as data URL (for debugging/display) */
  lastFrameUrl: string | null;
}

/**
 * Default initial state
 */
export const DEFAULT_ATTENTIVENESS_STATE: CameraAttentivenessState = {
  isAwake: true,
  mode: {
    frequency: 'low',
    resolution: 'low',
  },
  lastMotionDetected: null,
  motionLevel: 0,
  isCapturing: false,
  isRunning: false,
  error: null,
  frameCount: 0,
  lastFrameUrl: null,
};

/**
 * Actions the AI can request to control the camera
 */
export type CameraAttentivenessAction =
  | { type: 'setFrequency'; frequency: CaptureFrequency }
  | { type: 'setResolution'; resolution: CaptureResolution }
  | { type: 'wake' }
  | { type: 'sleep' }
  | { type: 'setMode'; mode: Partial<AttentivenessMode> };

/**
 * Captured frame data for processing
 */
export interface CapturedFrame {
  /** Frame as Blob for sending to backend */
  blob: Blob;
  /** Frame as data URL for display */
  dataUrl: string;
  /** Resolution the frame was captured at */
  resolution: CaptureResolution;
  /** Timestamp of capture */
  timestamp: number;
  /** Motion level when captured */
  motionLevel: number;
}

/**
 * Callback for when a significant frame is captured
 */
export type FrameCapturedCallback = (frame: CapturedFrame) => void;

/**
 * Callback for when motion state changes
 */
export type MotionStateCallback = (isAwake: boolean, motionLevel: number) => void;

// =============================================================================
// SLEEP SYSTEM
// See planning-docs/aac-sleep-system-plan.md for the full design.
// =============================================================================

/**
 * Sleep system state — gates how aggressively the system reduces data flow to save tokens.
 */
export type SleepState =
  | 'hibernation'
  | 'waking'
  | 'awake'
  | 'resting'
  | 'asleep';

/**
 * Continuous-weight engagement signals fed into the score combiner.
 * v1 wires motion, voice, face, buttonPress. Others are stubs for v2.
 */
export type EngagementSignalKind =
  | 'motion'
  | 'voice'
  | 'noise'
  | 'face'
  | 'mouseEyegaze'
  | 'buttonPress';

/**
 * Discrete events that force-wake regardless of score (bypass thresholds and dampening).
 */
export type AlwaysWakeTrigger =
  | 'avatarTap'
  | 'avatarEyegaze'
  | 'aacButtonPress'
  | 'sustainedFace';

/**
 * Default per-signal weights. Each contributes (weight × intensity) to the score.
 * Score decays exponentially toward 0 in the absence of input.
 */
export const ENGAGEMENT_WEIGHTS: Record<EngagementSignalKind, number> = {
  motion: 0.15,
  voice: 0.40,
  noise: 0.10,
  face: 0.45,
  mouseEyegaze: 0.50,
  buttonPress: 0.80,
};

/** Score halves every DECAY_HALF_LIFE_MS without input. */
export const DECAY_HALF_LIFE_MS = 8000;

/**
 * An AI rest() request is refused if an AAC button was pressed within this
 * window — the user is still mid-interaction, so dropping to the lightweight
 * resting profile would cut them off. Game interactions don't count (they
 * never route through the aacButtonPress always-wake trigger).
 */
export const AAC_REST_GUARD_MS = 10_000;

/**
 * Sleep state thresholds (engagement score in [0, 1]).
 * Invariant: sleep < rest < engaged < wakeup.
 * Defaults are placeholders pending tuning via the debug panel.
 */
export const SLEEP_THRESHOLDS = {
  /** Awake → Resting */
  rest: 0.30,
  /** Resting → Awake (lower than wakeup — Resting is "warmer" than Asleep) */
  engaged: 0.45,
  /** Resting → Asleep */
  sleep: 0.15,
  /** Asleep → Awake (high — needs strong signal) */
  wakeup: 0.65,
};

/**
 * Resting sub-tier boundaries. Within Resting, the score determines how aggressively
 * data flow is throttled. See per-state data flow table in the planning doc.
 */
export const RESTING_TIERS = {
  /** Below this within Resting → tighten further (heartbeat off, VAD-gated PCM, smaller grid) */
  deepBoundary: 0.30,
};

/**
 * False-wake dampening: when AI calls report_false_wake, multiply wake thresholds
 * by bumpFactor (capped at maxThreshold). Threshold decays back to baseline.
 */
export const FALSE_WAKE_DAMPENING = {
  bumpFactor: 1.15,
  maxThreshold: 0.95,
  decayHalfLifeMs: 5 * 60 * 1000,
};

/** Sampling cadence for the engagement-score producer. */
export const ENGAGEMENT_SAMPLE_HZ = 10;

/**
 * Engagement score with per-signal contribution breakdown for debugging/tuning.
 */
export interface EngagementScore {
  value: number;
  contributions: Partial<Record<EngagementSignalKind, number>>;
}
