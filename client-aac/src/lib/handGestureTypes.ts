// client-aac/src/lib/handGestureTypes.ts
// Type definitions and config defaults for hand gesture detection via MediaPipe GestureRecognizer

// =============================================================================
// EVENT TYPES
// =============================================================================

export type HandGestureEventType =
  // Built-in MediaPipe gestures
  | 'open_palm'
  | 'closed_fist'
  | 'pointing_up'
  | 'thumb_up'
  | 'thumb_down'
  | 'victory'
  | 'i_love_you'
  // Derived from landmarks
  | 'wave'
  | 'hand_raise'
  | 'pointing_left'
  | 'pointing_right'
  | 'pinch'
  // Sign language (catch-all with signLabel metadata)
  | 'sign_language';

export interface HandGestureEvent {
  type: HandGestureEventType;
  timestamp: number;
  confidence: number; // 0-1
  hand: 'Left' | 'Right';
  signLabel?: string;            // label from custom sign language model
  signLanguageLocale?: string;   // e.g. 'asl', 'isr'
}

// =============================================================================
// LANDMARKS & RAW DATA
// =============================================================================

export interface HandLandmark {
  x: number; // normalized 0-1
  y: number; // normalized 0-1
  z: number; // depth, normalized
}

export interface RawTrackedHand {
  handIndex: number;
  handedness: 'Left' | 'Right';
  landmarks: HandLandmark[]; // 21 landmarks per hand
  gesture: string | null;        // built-in gesture name from MediaPipe
  gestureConfidence: number;
  signLanguageGesture: string | null;  // custom model result
  signLanguageConfidence: number;
}

// =============================================================================
// TRACKED HAND (after event processing)
// =============================================================================

export interface TrackedHand {
  handIndex: number;
  handedness: 'Left' | 'Right';
  landmarks: HandLandmark[];
  currentGesture: HandGestureEventType | null;
  currentGestureConfidence: number;
  events: HandGestureEvent[];  // rolling buffer of recent events
  missedTicks: number;         // consecutive ticks hand was not detected
}

// =============================================================================
// CONFIG
// =============================================================================

export interface HandGestureConfig {
  thresholds: {
    gesture: number;         // minimum confidence for built-in gestures
    wave: number;            // minimum wrist X displacement for oscillation
    handRaise: number;       // Y threshold (top of frame = 0, so < this = raised)
    pinch: number;           // max distance between thumb tip and index tip
    pointingAngle: number;   // horizontal component threshold for pointing detection
    signLanguage: number;    // minimum confidence for sign language model
  };

  refireIntervals: {
    gesture: number;         // ms between repeated built-in gesture events
    wave: number;            // ms between repeated wave events
    signLanguage: number;    // ms between repeated sign language events
  };

  processingIntervalMs: number;  // how often to run detection
  eventWindowMs: number;         // rolling buffer duration
  maxHands: number;              // max simultaneous hands to track
  handPersistenceTicks: number;  // how many missed ticks before removing hand

  // Wave detection parameters
  waveOscillationsRequired: number; // oscillations needed to trigger wave
  waveTimeWindowMs: number;         // time window for oscillation counting

  // Sign language model (optional)
  signLanguageModelUrl: string | null;   // URL to .task model file
  signLanguageLocale: string | null;     // e.g. 'asl', 'isr'
}

export const DEFAULT_HAND_GESTURE_CONFIG: HandGestureConfig = {
  thresholds: {
    gesture: 0.6,
    wave: 0.08,
    handRaise: 0.3,
    pinch: 0.06,
    pointingAngle: 0.7,
    signLanguage: 0.5,
  },
  refireIntervals: {
    gesture: 500,
    wave: 2000,
    signLanguage: 1500,
  },
  processingIntervalMs: 300,
  eventWindowMs: 10_000,
  maxHands: 2,
  handPersistenceTicks: 3,
  waveOscillationsRequired: 3,
  waveTimeWindowMs: 2000,
  signLanguageModelUrl: null,
  signLanguageLocale: null,
};

// =============================================================================
// EVENT COLOR CATEGORIES (for UI display)
// =============================================================================

export type HandEventColorCategory = 'builtin_gesture' | 'derived_gesture' | 'sign_language';

export function getHandEventColorCategory(type: HandGestureEventType): HandEventColorCategory {
  if (type === 'sign_language') return 'sign_language';
  if (type === 'wave' || type === 'hand_raise' || type === 'pointing_left' || type === 'pointing_right' || type === 'pinch') {
    return 'derived_gesture';
  }
  return 'builtin_gesture';
}

export const HAND_EVENT_COLOR_MAP: Record<HandEventColorCategory, string> = {
  builtin_gesture: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  derived_gesture: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  sign_language: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
};

// =============================================================================
// MEDIAPIPE GESTURE NAME MAPPING
// =============================================================================

/** Maps MediaPipe GestureRecognizer category names to our event types */
export const MEDIAPIPE_GESTURE_MAP: Record<string, HandGestureEventType> = {
  'Open_Palm': 'open_palm',
  'Closed_Fist': 'closed_fist',
  'Pointing_Up': 'pointing_up',
  'Thumb_Up': 'thumb_up',
  'Thumb_Down': 'thumb_down',
  'Victory': 'victory',
  'ILoveYou': 'i_love_you',
};
