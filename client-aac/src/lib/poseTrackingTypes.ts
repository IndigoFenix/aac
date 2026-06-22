// client-aac/src/lib/poseTrackingTypes.ts
// Types + config for body-pose tracking via MediaPipe PoseLandmarker (33 body
// landmarks). Mirrors faceTrackingTypes / handGestureTypes. Posture + body
// movement feed the [SCENE] description; a suspected fall escalates to a frame
// the Observer adjudicates (never an auto-alarm).

import type { PoseLandmark, Posture } from "@shared/aac/pose-classify";

export type { PoseLandmark, Posture };

export type PoseEventType =
  | "arms_raised"
  | "hand_to_head"
  | "rocking"      // rhythmic torso sway (e.g. stereotypy) — derived from history
  | "fall";        // suspected fall (conservative hint)

export interface PoseEvent {
  type: PoseEventType;
  timestamp: number;
  confidence: number; // 0-1
}

/** Raw pose straight from the model (one per detected body). */
export interface RawTrackedPose {
  poseIndex: number;
  landmarks: PoseLandmark[]; // 33 landmarks, normalized 0-1, with visibility
}

/** Pose after event processing. */
export interface TrackedPose {
  poseIndex: number;
  landmarks: PoseLandmark[];
  boundingBox: { x: number; y: number; w: number; h: number } | null;
  currentPosture: Posture;
  events: PoseEvent[]; // rolling buffer
  missedTicks: number;
}

export interface PoseTrackingConfig {
  thresholds: {
    /** Min torso-x oscillations within the window to call it "rocking". */
    rockingOscillations: number;
    /** Min sway amplitude (normalized x) per oscillation for rocking. */
    rockingAmplitude: number;
  };
  refireIntervals: {
    movement: number; // arms_raised / hand_to_head
    rocking: number;
    fall: number;
  };
  processingIntervalMs: number;
  eventWindowMs: number;
  maxPoses: number;
  posePersistenceTicks: number;
  /** Window for the rocking-oscillation counter. */
  rockingWindowMs: number;
}

export const DEFAULT_POSE_TRACKING_CONFIG: PoseTrackingConfig = {
  thresholds: {
    rockingOscillations: 3,
    rockingAmplitude: 0.03,
  },
  refireIntervals: {
    movement: 1500,
    rocking: 3000,
    fall: 5000,
  },
  // Pose is the heaviest of the three models; run it a touch slower than
  // face/hand (300ms) to spare low-end kiosks. Fall still resolves at this rate.
  processingIntervalMs: 400,
  eventWindowMs: 10_000,
  maxPoses: 1, // the active user; multi-body pose is rarely useful here
  posePersistenceTicks: 3,
  rockingWindowMs: 3000,
};
