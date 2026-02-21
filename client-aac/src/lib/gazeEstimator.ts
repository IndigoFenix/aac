// client-aac/src/lib/gazeEstimator.ts
// Pure computation: maps RawTrackedFace data to a screen-space gaze point.
// Supports optional calibration via ridge regression for per-user accuracy correction.

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

/**
 * Ridge regression calibration transform.
 * Maps raw gaze to screen position using normalized features:
 *   normalized_target = c0 + c1 * (rawX / screenW) + c2 * (rawY / screenH)
 * Two separate regressions: one for X, one for Y.
 * Cross-terms (rawY → targetX, rawX → targetY) handle head tilt/rotation.
 */
export interface CalibrationTransform {
  xCoeffs: [number, number, number]; // [intercept, rawX_weight, rawY_weight] → normalized targetX
  yCoeffs: [number, number, number]; // [intercept, rawX_weight, rawY_weight] → normalized targetY
}

const EMA_ALPHA = 0.3;

// Scale factors for eye blendshape offsets
const EYE_H_SCALE = 500;
const EYE_V_SCALE = 400;

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

// Verification targets: 3 points distinct from calibration points
export const VERIFICATION_TARGETS: Array<{ nx: number; ny: number }> = [
  { nx: 0.5, ny: 0.2 },   // center-top
  { nx: 0.25, ny: 0.5 },  // center-left
  { nx: 0.75, ny: 0.75 }, // lower-right quadrant
];

const STORAGE_KEY = "eyetracking_calibration";
const STORAGE_VERSION = 2; // bump when transform format changes

// ─── Ridge regression helpers ─────────────────────────────────────

/** Invert a 3x3 matrix using cofactor expansion. Returns null if singular. */
function invert3x3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) return null;

  const inv = 1 / det;
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ];
}

/**
 * Solve ridge regression for a 3-feature system: y = X * coeffs
 * where X rows are [1, f1, f2] and lambda regularizes f1, f2 (not intercept).
 * Returns [c0, c1, c2].
 */
function solveRidge3(
  X: number[][],
  y: number[],
  lambda: number,
): [number, number, number] {
  const n = X.length;

  // X^T X (3x3)
  const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }

  // Add regularization to non-intercept features
  XtX[1][1] += lambda;
  XtX[2][2] += lambda;

  // X^T y (3x1)
  const Xty = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) {
      Xty[j] += X[i][j] * y[i];
    }
  }

  // Solve via matrix inverse
  const inv = invert3x3(XtX);
  if (!inv) {
    // Degenerate — return identity-like mapping
    return [0, 1, 0];
  }

  return [
    inv[0][0] * Xty[0] + inv[0][1] * Xty[1] + inv[0][2] * Xty[2],
    inv[1][0] * Xty[0] + inv[1][1] * Xty[1] + inv[1][2] * Xty[2],
    inv[2][0] * Xty[0] + inv[2][1] * Xty[1] + inv[2][2] * Xty[2],
  ];
}

// ─── Calibration computation ──────────────────────────────────────

/**
 * Compute ridge regression calibration transform from samples.
 * All features are normalized to [0,1] (raw / screenDim) to keep
 * regularization scale-independent. Coefficients stored in normalized space.
 */
export function computeCalibrationTransform(samples: CalibrationSample[]): CalibrationTransform {
  if (samples.length < 2) {
    // Identity: output ≈ input in normalized space
    return { xCoeffs: [0, 1, 0], yCoeffs: [0, 0, 1] };
  }

  const w = window.innerWidth;
  const h = window.innerHeight;
  const LAMBDA = 1.0; // regularization strength

  // Build normalized feature matrix [1, rawX/w, rawY/h] and targets
  const X = samples.map(s => [1, s.raw.x / w, s.raw.y / h]);
  const yX = samples.map(s => s.target.x / w);
  const yY = samples.map(s => s.target.y / h);

  const xCoeffs = solveRidge3(X, yX, LAMBDA);
  const yCoeffs = solveRidge3(X, yY, LAMBDA);

  return { xCoeffs, yCoeffs };
}

/** Apply a calibration transform to a raw gaze point (normalized-space coefficients) */
export function applyTransformToPoint(raw: GazePoint, transform: CalibrationTransform): GazePoint {
  const w = window.innerWidth;
  const h = window.innerHeight;

  // Normalize raw input
  const nx = raw.x / w;
  const ny = raw.y / h;

  // Apply regression: normalized_target = c0 + c1*nx + c2*ny
  const tx = transform.xCoeffs[0] + transform.xCoeffs[1] * nx + transform.xCoeffs[2] * ny;
  const ty = transform.yCoeffs[0] + transform.yCoeffs[1] * nx + transform.yCoeffs[2] * ny;

  // Denormalize and clamp
  return {
    x: Math.max(0, Math.min(w, tx * w)),
    y: Math.max(0, Math.min(h, ty * h)),
  };
}

// ─── Estimator ────────────────────────────────────────────────────

export function createGazeEstimator() {
  let smoothX = 0;
  let smoothY = 0;
  let initialized = false;
  let calibration: CalibrationTransform | null = null;

  // Try to load saved calibration (version-checked)
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Only accept current format (has xCoeffs/yCoeffs)
      if (parsed && Array.isArray(parsed.xCoeffs) && Array.isArray(parsed.yCoeffs)) {
        calibration = parsed as CalibrationTransform;
      } else {
        // Old format — discard
        localStorage.removeItem(STORAGE_KEY);
      }
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

    // eyeLookOutLeft = left eye looking toward user's left (outward)
    // eyeLookInLeft  = left eye looking toward user's right (inward)
    // hEye positive = user looking to their left
    // rawX is mirrored (user's left = screen left = decreasing X), so subtract
    const hEye = (lookOutLeft - lookInLeft + lookInRight - lookOutRight) / 2;
    rawX -= hEye * EYE_H_SCALE;

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
    let cx: number, cy: number;
    if (calibration) {
      const calibrated = applyTransformToPoint(raw, calibration);
      cx = calibrated.x;
      cy = calibrated.y;
    } else {
      cx = raw.x;
      cy = raw.y;
    }

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
    calibration = computeCalibrationTransform(samples);
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
