/**
 * cameraAttentivenessForm.ts
 *
 * Client-side utilities for the AI to see and control camera attentiveness settings.
 * This allows the AI to adjust camera behavior based on conversation context.
 *
 * For example:
 * - Switch to high resolution when text/writing appears
 * - Increase frequency when user seems engaged
 * - Wake the camera when starting a new activity
 */

import type { NlpSchema, FormValues } from './aacBoardForm';
import type {
  CameraAttentivenessState,
  CaptureFrequency,
  CaptureResolution,
  AttentivenessMode,
} from './cameraAttentivenessTypes';

/**
 * Form values structure for camera attentiveness
 */
export interface CameraAttentivenessFormValues {
  /** Whether the camera is awake (actively monitoring) */
  isAwake: boolean;
  /** Capture frequency mode */
  frequency: CaptureFrequency;
  /** Capture resolution mode */
  resolution: CaptureResolution;
  /** Current motion level (0-1, read-only for AI) */
  motionLevel: number;
  /** Whether the system is running */
  isRunning: boolean;
}

/**
 * SetValues structure the AI can use to control the camera
 */
export interface CameraAttentivenessSetValues {
  /** Wake or sleep the camera */
  isAwake?: boolean;
  /** Set capture frequency */
  frequency?: CaptureFrequency;
  /** Set capture resolution */
  resolution?: CaptureResolution;
}

/**
 * Generate the NlpSchema for camera attentiveness control.
 * This tells the AI what parameters it can see and modify.
 */
export function generateCameraAttentivenessFormSchema(): NlpSchema {
  return {
    type: 'object',
    instructions: `Camera monitoring settings for environmental awareness.
The camera helps you understand the user's surroundings and context.

READING current values:
- isAwake: true if camera is actively monitoring, false if sleeping (conserving resources)
- frequency: how often pictures are taken ('sleep', 'low', 'medium', 'high')
- resolution: image quality ('low', 'medium', 'high')
- motionLevel: 0-1 indicating current motion (0 = still, 1 = lots of movement)
- isRunning: whether the monitoring system is active

SETTING values (use setValues to adjust):
- Set isAwake=true to wake the camera, false to sleep
- Set frequency='high' when you need frequent updates (e.g., fast-paced activity)
- Set frequency='low' when updates can be less frequent (e.g., calm conversation)
- Set resolution='high' when you need to read text, signs, or see details
- Set resolution='medium' for normal visual context
- Set resolution='low' when just detecting presence/motion

COST AWARENESS:
- Higher frequency and resolution use more resources
- Use 'low' frequency and resolution by default
- Only increase when the context requires it (e.g., reading text, tracking fast movement)
- Return to lower settings after the high-detail task is complete`,
    properties: {
      isAwake: {
        type: 'boolean',
        instructions: 'Set to true to wake camera, false to sleep. When sleeping, only motion detection runs at low frequency.',
      },
      frequency: {
        type: 'string',
        enum: ['sleep', 'low', 'medium', 'high'],
        instructions: `Capture frequency:
- 'sleep': 5 seconds (only motion detection)
- 'low': 2 seconds (basic monitoring)
- 'medium': 1 second (active monitoring)
- 'high': 250ms (4fps, high attention mode)`,
      },
      resolution: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        instructions: `Image resolution:
- 'low': 160x120 (motion detection, presence)
- 'medium': 320x240 (general visual context)
- 'high': 640x480 (reading text, detailed analysis)`,
      },
      motionLevel: {
        type: 'number',
        instructions: 'READ ONLY - Current motion level from 0 (still) to 1 (high motion). Do not set this value.',
      },
      isRunning: {
        type: 'boolean',
        instructions: 'READ ONLY - Whether the monitoring system is active. Do not set this value.',
      },
    },
  };
}

/**
 * Convert CameraAttentivenessState to formValues for the AI to see.
 */
export function cameraAttentivenessToFormValues(
  state: CameraAttentivenessState | null | undefined
): CameraAttentivenessFormValues {
  if (!state) {
    return {
      isAwake: false,
      frequency: 'low',
      resolution: 'low',
      motionLevel: 0,
      isRunning: false,
    };
  }

  return {
    isAwake: state.isAwake,
    frequency: state.mode.frequency,
    resolution: state.mode.resolution,
    motionLevel: state.motionLevel,
    isRunning: state.isRunning,
  };
}

/**
 * Apply setValues from AI response to control the camera.
 * Returns the actions to take (caller should apply them to the context).
 */
export function parseAttentivenessSetValues(
  setValues: CameraAttentivenessSetValues | null | undefined
): {
  shouldWake?: boolean;
  shouldSleep?: boolean;
  frequency?: CaptureFrequency;
  resolution?: CaptureResolution;
} | null {
  if (!setValues || typeof setValues !== 'object') {
    return null;
  }

  const actions: ReturnType<typeof parseAttentivenessSetValues> = {};

  // Handle wake/sleep
  if (typeof setValues.isAwake === 'boolean') {
    if (setValues.isAwake) {
      actions.shouldWake = true;
    } else {
      actions.shouldSleep = true;
    }
  }

  // Handle frequency change
  if (setValues.frequency && ['sleep', 'low', 'medium', 'high'].includes(setValues.frequency)) {
    actions.frequency = setValues.frequency;
  }

  // Handle resolution change
  if (setValues.resolution && ['low', 'medium', 'high'].includes(setValues.resolution)) {
    actions.resolution = setValues.resolution;
  }

  // Return null if no valid actions
  if (Object.keys(actions).length === 0) {
    return null;
  }

  return actions;
}

/**
 * Helper to create a default "attentive" mode for when the AI wants high attention
 */
export function getAttentiveMode(): Partial<AttentivenessMode> {
  return {
    frequency: 'high',
    resolution: 'high',
  };
}

/**
 * Helper to create a default "relaxed" mode for normal monitoring
 */
export function getRelaxedMode(): Partial<AttentivenessMode> {
  return {
    frequency: 'low',
    resolution: 'low',
  };
}

/**
 * Helper to create a mode for reading text/details
 */
export function getDetailMode(): Partial<AttentivenessMode> {
  return {
    frequency: 'medium',
    resolution: 'high',
  };
}
