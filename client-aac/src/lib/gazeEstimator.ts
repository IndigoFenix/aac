// client-aac/src/lib/gazeEstimator.ts
// Pure computation: maps RawTrackedFace data to a screen-space gaze point.
// Supports optional calibration for per-user accuracy correction.

import type { RawTrackedFace } from "./faceTrackingTypes";

export interface GazePoint {
  x: number;
  y: number;
}

/** A single calibration sample: raw (uncalibrated) gaze vs known screen target */
export interface CalibrationSample {
  raw: GazePoint;    // where the estimator thought the user was looking
  target: GazePoint; // where the user was actually told to look
}

/** Affine correction: correctedX = scaleX * rawX + offsetX */
export interface CalibrationTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

const EMA_ALPHA = 0.3;

// Scale factors for eye blendshape offsets
const EYE_H_SCALE = 200;
const EYE_V_SCALE = 150;

// Scale factors for head pose correction
const HEAD_YAW_SCALE = 100;
const HEAD_PITCH_SCALE = 80;

// Calibration targets: 5-point pattern (center + 4 corners inset 15%)
const INSET = 0.15;
export const CALIBRATION_TARGETS: Array<{ nx: number; ny: number }> = [
  { nx: 0.5, ny: 0.5 },       // center
  { nx: INSET, ny: INSET },   // top-left
  { nx: 1 - INSET, ny: INSET }, // top-right
  { nx: INSET, ny: 1 - INSET }, // bottom-left
  { nx: 1 - INSET, ny: 1 - INSET }, // bottom-right
];

const STORAGE_KEY = "eyetracking_calibration";

/** Compute affine transform from calibration samples (least-squares fit) */
function computeCalibration(samples: CalibrationSample[]): CalibrationTransform {
  if (samples.length < 2) {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }

  // Fit independently for x and y:  target = scale * raw + offset
  // Using least squares: minimize sum((target_i - scale*raw_i - offset)^2)
  const n = samples.length;
  let sumRawX = 0, sumRawY = 0, sumTargetX = 0, sumTargetY = 0;
  let sumRawX2 = 0, sumRawY2 = 0, sumRawXTargetX = 0, sumRawYTargetY = 0;

  for (const s of samples) {
    sumRawX += s.raw.x;
    sumRawY += s.raw.y;
    sumTargetX += s.target.x;
    sumTargetY += s.target.y;
    sumRawX2 += s.raw.x * s.raw.x;
    sumRawY2 += s.raw.y * s.raw.y;
    sumRawXTargetX += s.raw.x * s.target.x;
    sumRawYTargetY += s.raw.y * s.target.y;
  }

  // Solve for scaleX, offsetX
  const denomX = n * sumRawX2 - sumRawX * sumRawX;
  let scaleX = 1, offsetX = 0;
  if (Math.abs(denomX) > 1e-6) {
    scaleX = (n * sumRawXTargetX - sumRawX * sumTargetX) / denomX;
    offsetX = (sumTargetX - scaleX * sumRawX) / n;
  } else {
    // All raw X values are the same — just use offset
    offsetX = (sumTargetX - sumRawX) / n;
  }

  // Solve for scaleY, offsetY
  const denomY = n * sumRawY2 - sumRawY * sumRawY;
  let scaleY = 1, offsetY = 0;
  if (Math.abs(denomY) > 1e-6) {
    scaleY = (n * sumRawYTargetY - sumRawY * sumTargetY) / denomY;
    offsetY = (sumTargetY - scaleY * sumRawY) / n;
  } else {
    offsetY = (sumTargetY - sumRawY) / n;
  }

  return { scaleX, scaleY, offsetX, offsetY };
}

export function createGazeEstimator() {
  let smoothX = 0;
  let smoothY = 0;
  let initialized = false;
  let calibration: CalibrationTransform | null = null;

  // Try to load saved calibration
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      calibration = JSON.parse(saved) as CalibrationTransform;
    }
  } catch { /* ignore */ }

  /** Compute raw (uncalibrated) gaze from face data */
  function computeRaw(face: RawTrackedFace): GazePoint | null {
    const { noseTip, blendshapes, headPose } = face;
    if (!noseTip) return null;

    const w = window.innerWidth;
    const h = window.innerHeight;

    // Base position from nose tip (normalized 0-1, mirrored)
    let rawX = (1 - noseTip.x) * w;
    let rawY = noseTip.y * h;

    // Eye blendshape horizontal offset
    const lookOutLeft = blendshapes.get("eyeLookOutLeft") ?? 0;
    const lookInLeft = blendshapes.get("eyeLookInLeft") ?? 0;
    const lookOutRight = blendshapes.get("eyeLookOutRight") ?? 0;
    const lookInRight = blendshapes.get("eyeLookInRight") ?? 0;

    const hEye = (lookOutLeft - lookInLeft + lookInRight - lookOutRight) / 2;
    rawX += hEye * EYE_H_SCALE;

    // Eye blendshape vertical offset
    const lookUpLeft = blendshapes.get("eyeLookUpLeft") ?? 0;
    const lookUpRight = blendshapes.get("eyeLookUpRight") ?? 0;
    const lookDownLeft = blendshapes.get("eyeLookDownLeft") ?? 0;
    const lookDownRight = blendshapes.get("eyeLookDownRight") ?? 0;

    const vEye = (lookUpLeft + lookUpRight - lookDownLeft - lookDownRight) / 2;
    rawY -= vEye * EYE_V_SCALE;

    // Head pose correction
    if (headPose) {
      rawX += headPose.yaw * HEAD_YAW_SCALE;
      rawY -= headPose.pitch * HEAD_PITCH_SCALE;
    }

    // Clamp to screen bounds
    rawX = Math.max(0, Math.min(w, rawX));
    rawY = Math.max(0, Math.min(h, rawY));

    return { x: rawX, y: rawY };
  }

  /** Update with face data → returns smoothed, calibrated screen point */
  function update(face: RawTrackedFace): GazePoint | null {
    const raw = computeRaw(face);
    if (!raw) return null;

    // Apply calibration transform if available
    let cx = raw.x;
    let cy = raw.y;
    if (calibration) {
      cx = calibration.scaleX * raw.x + calibration.offsetX;
      cy = calibration.scaleY * raw.y + calibration.offsetY;
    }

    // Clamp
    const w = window.innerWidth;
    const h = window.innerHeight;
    cx = Math.max(0, Math.min(w, cx));
    cy = Math.max(0, Math.min(h, cy));

    // EMA smoothing
    if (!initialized) {
      smoothX = cx;
      smoothY = cy;
      initialized = true;
    } else {
      smoothX = EMA_ALPHA * cx + (1 - EMA_ALPHA) * smoothX;
      smoothY = EMA_ALPHA * cy + (1 - EMA_ALPHA) * smoothY;
    }

    return { x: smoothX, y: smoothY };
  }

  /** Get the raw (uncalibrated, unsmoothed) gaze point — used during calibration */
  function getRaw(face: RawTrackedFace): GazePoint | null {
    return computeRaw(face);
  }

  /** Apply calibration from collected samples and persist to localStorage */
  function applyCalibration(samples: CalibrationSample[]) {
    calibration = computeCalibration(samples);
    initialized = false; // reset smoothing so it snaps to calibrated position
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration));
    } catch { /* ignore */ }
  }

  /** Clear calibration data */
  function clearCalibration() {
    calibration = null;
    initialized = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }

  function isCalibrated(): boolean {
    return calibration !== null;
  }

  function reset() {
    smoothX = 0;
    smoothY = 0;
    initialized = false;
  }

  return { update, getRaw, applyCalibration, clearCalibration, isCalibrated, reset };
}

export type GazeEstimator = ReturnType<typeof createGazeEstimator>;
