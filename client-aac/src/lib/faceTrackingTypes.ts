// client-aac/src/lib/faceTrackingTypes.ts
// Type definitions and config defaults for face expression tracking via MediaPipe FaceLandmarker

// =============================================================================
// EVENT TYPES
// =============================================================================

export type FaceEventType =
  | 'blink_left'
  | 'blink_right'
  | 'blink_both'
  | 'gaze_left'
  | 'gaze_right'
  | 'gaze_up'
  | 'gaze_down'
  | 'gaze_center'
  | 'smile'
  | 'frown'
  | 'mouth_open'
  | 'surprise'
  | 'brow_raise'
  | 'brow_furrow'
  | 'head_nod'
  | 'head_shake'
  | 'head_turn_left'
  | 'head_turn_right'
  | 'head_turn_up'
  | 'head_turn_down';

export interface FaceEvent {
  type: FaceEventType;
  timestamp: number;
  confidence: number; // 0-1 probability from blendshape
}

// =============================================================================
// TRACKED FACE
// =============================================================================

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlendshapeEntry {
  categoryName: string;
  score: number;
}

export interface TrackedFace {
  faceIndex: number;
  personId: string | null;    // matched person ID from identification
  personName: string | null;  // matched person name
  boundingBox: BoundingBox | null;
  currentBlendshapes: Map<string, number>; // blendshape name -> score
  currentExpression: FaceEventType | null; // dominant current expression
  headPose: { yaw: number; pitch: number; roll: number } | null; // head orientation, ~-1..1
  events: FaceEvent[];        // rolling buffer of recent events
  missedTicks: number;        // consecutive ticks face was not detected
}

// =============================================================================
// RAW FACE (output from useFaceTracking before event processing)
// =============================================================================

export interface RawTrackedFace {
  faceIndex: number;
  boundingBox: BoundingBox | null;
  blendshapes: Map<string, number>;
  noseTip: { x: number; y: number } | null; // landmark #4, normalized [0,1]
  headPose: { yaw: number; pitch: number; roll: number } | null; // from landmark asymmetry, ~-1 to 1
}

// =============================================================================
// CONFIG
// =============================================================================

export interface FaceTrackingConfig {
  // Blendshape thresholds for event detection
  thresholds: {
    blink: number;
    gaze: number;
    smile: number;
    frown: number;
    mouthOpen: number;
    surprise: number;
    browRaise: number;
    browFurrow: number;
    headTurn: number;
  };

  // Minimum re-fire intervals per event category (ms)
  refireIntervals: {
    blink: number;
    gaze: number;
    expression: number;
    headGesture: number;
    headTurn: number;
  };

  // Processing
  processingIntervalMs: number; // how often to run detection
  eventWindowMs: number;        // rolling buffer duration
  maxFaces: number;             // max simultaneous faces to track
  facePersistenceTicks: number; // how many missed ticks before removing face
}

export const DEFAULT_FACE_TRACKING_CONFIG: FaceTrackingConfig = {
  thresholds: {
    blink: 0.5,
    gaze: 0.4,
    smile: 0.5,
    frown: 0.4,
    mouthOpen: 0.5,
    surprise: 0.5,
    browRaise: 0.4,
    browFurrow: 0.4,
    headTurn: 0.15,
  },
  refireIntervals: {
    blink: 300,
    gaze: 500,
    expression: 1000,
    headGesture: 2000,
    headTurn: 1000,
  },
  processingIntervalMs: 300,
  eventWindowMs: 10_000,
  maxFaces: 3,
  facePersistenceTicks: 3,
};

// =============================================================================
// EVENT COLOR CATEGORIES (for UI display)
// =============================================================================

export type EventColorCategory = 'blink' | 'gaze' | 'expression' | 'mouth' | 'brow' | 'headGesture';

export function getEventColorCategory(type: FaceEventType): EventColorCategory {
  if (type.startsWith('blink')) return 'blink';
  if (type.startsWith('gaze')) return 'gaze';
  if (type === 'mouth_open') return 'mouth';
  if (type === 'brow_raise' || type === 'brow_furrow') return 'brow';
  if (type.startsWith('head_')) return 'headGesture';
  return 'expression'; // smile, frown, surprise
}

export const EVENT_COLOR_MAP: Record<EventColorCategory, string> = {
  blink: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  gaze: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  expression: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  mouth: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  brow: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  headGesture: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
};
