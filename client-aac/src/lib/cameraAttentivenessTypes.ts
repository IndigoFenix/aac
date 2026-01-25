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
