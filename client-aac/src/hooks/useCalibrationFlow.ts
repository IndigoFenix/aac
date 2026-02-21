// client-aac/src/hooks/useCalibrationFlow.ts
// Fixation-based calibration state machine.
// Detects eye fixation (eyes holding still) without needing to know where on screen
// the user is looking — on a black screen with a single dot, steady eyes = looking at the dot.
// After collecting all points, verifies calibration at new positions.

import { useState, useRef, useCallback, useEffect } from "react";
import {
  CALIBRATION_TARGETS,
  VERIFICATION_TARGETS,
  computeCalibrationTransform,
  applyTransformToPoint,
  type CalibrationSample,
  type CalibrationTransform,
  type GazePoint,
} from "@/lib/gazeEstimator";

// ─── Constants ────────────────────────────────────────────────────
const WINDOW_SIZE = 20;            // 1s of samples at 20Hz
const MIN_SAMPLES = 10;            // need 0.5s minimum
const FIXATION_THRESHOLD_PX = 50;  // max stddev for "steady" (blendshapes are noisy)
const REQUIRED_FIXATION_MS = 800;  // must hold still 800ms
const SETTLE_MS = 400;             // pause after dot moves before detection
const POINT_TIMEOUT_MS = 15000;    // skip point after 15s
const DOT_SPEED_PX_SEC = 500;      // dot movement speed
const VERIFY_RADIUS_FRAC = 0.20;   // verification pass threshold (% of screen)
const MAX_ATTEMPTS = 3;            // max total calibration attempts
const MIN_VALID_SAMPLES = 3;       // need at least 3/5 points for valid fit
const TICK_MS = 50;                // fixation detection tick interval

// ─── Types ────────────────────────────────────────────────────────
export type CalibrationPhase =
  | "idle"
  | "settling"
  | "waiting_fixation"
  | "fixated"
  | "moving"
  | "verifying_settling"
  | "verifying_fixation"
  | "complete"
  | "failed";

export type CalibrationStage = "idle" | "collecting" | "verifying" | "complete" | "failed";

export interface CalibrationFlowState {
  stage: CalibrationStage;
  phase: CalibrationPhase;
  /** Current dot position in normalized coords (0-1) */
  dotNx: number;
  dotNy: number;
  /** Fixation progress 0-1 */
  fixationProgress: number;
  /** Current point index (in collecting or verifying) */
  pointIndex: number;
  /** Total points for current stage */
  pointTotal: number;
  /** How many attempts so far */
  attempt: number;
}

interface UseCalibrationFlowInput {
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  clearCalibration: () => void;
}

interface UseCalibrationFlowReturn {
  state: CalibrationFlowState;
  start: () => void;
  cancel: () => void;
  isActive: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────

function computeStdDev(values: number[]): number {
  const n = values.length;
  if (n < 2) return Infinity;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Calculate transition duration based on distance between two normalized points */
function calcTransitionMs(
  fromNx: number, fromNy: number,
  toNx: number, toNy: number,
): number {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dx = (toNx - fromNx) * w;
  const dy = (toNy - fromNy) * h;
  const dist = Math.hypot(dx, dy);
  return Math.max(200, (dist / DOT_SPEED_PX_SEC) * 1000);
}

// ─── Hook ─────────────────────────────────────────────────────────

export function useCalibrationFlow({
  getRawGaze,
  applyCalibration,
  clearCalibration,
}: UseCalibrationFlowInput): UseCalibrationFlowReturn {

  const [state, setState] = useState<CalibrationFlowState>({
    stage: "idle",
    phase: "idle",
    dotNx: 0.5,
    dotNy: 0.5,
    fixationProgress: 0,
    pointIndex: 0,
    pointTotal: CALIBRATION_TARGETS.length,
    attempt: 0,
  });

  // Refs for fixation detection (mutable, not in React state for perf)
  const gazeBufferRef = useRef<GazePoint[]>([]);
  const fixationStartRef = useRef<number | null>(null);
  const settleStartRef = useRef<number | null>(null);
  const pointStartRef = useRef<number | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const movingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Calibration data accumulated during collecting phase
  const samplesRef = useRef<CalibrationSample[]>([]);
  const pendingTransformRef = useRef<CalibrationTransform | null>(null);
  const verifyPassCountRef = useRef(0);
  const attemptRef = useRef(0);

  // ── Cleanup ──
  const clearTimers = useCallback(() => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    if (movingTimeoutRef.current) {
      clearTimeout(movingTimeoutRef.current);
      movingTimeoutRef.current = null;
    }
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
      completionTimeoutRef.current = null;
    }
  }, []);

  const resetFixation = useCallback(() => {
    gazeBufferRef.current = [];
    fixationStartRef.current = null;
    settleStartRef.current = null;
    pointStartRef.current = null;
  }, []);

  // ── State transition helpers ──
  // We use a ref to hold the latest state so our tick callback always sees fresh values
  const stateRef = useRef(state);
  stateRef.current = state;

  const getRawGazeRef = useRef(getRawGaze);
  getRawGazeRef.current = getRawGaze;
  const applyCalibrationRef = useRef(applyCalibration);
  applyCalibrationRef.current = applyCalibration;

  // ── Move to next collecting point ──
  const moveToCollectPoint = useCallback((index: number) => {
    const prev = stateRef.current;
    const target = CALIBRATION_TARGETS[index];
    const transitionMs = calcTransitionMs(prev.dotNx, prev.dotNy, target.nx, target.ny);

    // Start moving
    setState(s => ({
      ...s,
      phase: "moving",
      dotNx: target.nx,
      dotNy: target.ny,
      pointIndex: index,
      fixationProgress: 0,
    }));

    resetFixation();

    // After transition completes → settling
    movingTimeoutRef.current = setTimeout(() => {
      setState(s => ({ ...s, phase: "settling" }));
      settleStartRef.current = Date.now();
      pointStartRef.current = Date.now();
    }, transitionMs);
  }, [resetFixation]);

  // ── Move to next verification point ──
  const moveToVerifyPoint = useCallback((index: number) => {
    const prev = stateRef.current;
    const target = VERIFICATION_TARGETS[index];
    const transitionMs = calcTransitionMs(prev.dotNx, prev.dotNy, target.nx, target.ny);

    setState(s => ({
      ...s,
      stage: "verifying",
      phase: "moving",
      dotNx: target.nx,
      dotNy: target.ny,
      pointIndex: index,
      pointTotal: VERIFICATION_TARGETS.length,
      fixationProgress: 0,
    }));

    resetFixation();

    movingTimeoutRef.current = setTimeout(() => {
      setState(s => ({ ...s, phase: "verifying_settling" }));
      settleStartRef.current = Date.now();
      pointStartRef.current = Date.now();
    }, transitionMs);
  }, [resetFixation]);

  // ── Handle fixation confirmed during collecting ──
  const onCollectFixation = useCallback((meanGaze: GazePoint, pointIndex: number) => {
    const target = CALIBRATION_TARGETS[pointIndex];
    samplesRef.current.push({
      raw: meanGaze,
      target: { x: target.nx * window.innerWidth, y: target.ny * window.innerHeight },
    });

    setState(s => ({ ...s, phase: "fixated", fixationProgress: 1 }));

    const nextIndex = pointIndex + 1;
    if (nextIndex >= CALIBRATION_TARGETS.length) {
      // Done collecting — check if we have enough samples
      if (samplesRef.current.length < MIN_VALID_SAMPLES) {
        // Not enough valid points
        const attempt = attemptRef.current;
        if (attempt >= MAX_ATTEMPTS) {
          setState(s => ({ ...s, stage: "failed", phase: "failed" }));
          clearTimers();
          completionTimeoutRef.current = setTimeout(() => {
            setState(s => ({ ...s, stage: "idle", phase: "idle" }));
          }, 3000);
        } else {
          // Retry
          attemptRef.current = attempt + 1;
          samplesRef.current = [];
          setState(s => ({
            ...s,
            stage: "collecting",
            attempt: attemptRef.current,
            pointTotal: CALIBRATION_TARGETS.length,
          }));
          setTimeout(() => moveToCollectPoint(0), 300);
        }
        return;
      }

      // Compute pending transform and start verification
      pendingTransformRef.current = computeCalibrationTransform(samplesRef.current);
      verifyPassCountRef.current = 0;
      setTimeout(() => moveToVerifyPoint(0), 300);
    } else {
      setTimeout(() => moveToCollectPoint(nextIndex), 200);
    }
  }, [clearTimers, moveToCollectPoint, moveToVerifyPoint]);

  // ── Handle fixation confirmed during verification ──
  const onVerifyFixation = useCallback((meanGaze: GazePoint, pointIndex: number) => {
    const target = VERIFICATION_TARGETS[pointIndex];
    const transform = pendingTransformRef.current;
    if (transform) {
      const calibrated = applyTransformToPoint(meanGaze, transform);
      const targetPx = { x: target.nx * window.innerWidth, y: target.ny * window.innerHeight };
      const dist = Math.hypot(calibrated.x - targetPx.x, calibrated.y - targetPx.y);
      const threshold = VERIFY_RADIUS_FRAC * Math.min(window.innerWidth, window.innerHeight);
      if (dist < threshold) {
        verifyPassCountRef.current++;
      }
    }

    setState(s => ({ ...s, phase: "fixated", fixationProgress: 1 }));

    const nextIndex = pointIndex + 1;
    if (nextIndex >= VERIFICATION_TARGETS.length) {
      // All verification points done
      const passed = verifyPassCountRef.current >= 2;
      if (passed) {
        // Success — apply calibration
        applyCalibrationRef.current(samplesRef.current);
        setState(s => ({ ...s, stage: "complete", phase: "complete" }));
        clearTimers();
        completionTimeoutRef.current = setTimeout(() => {
          setState(s => ({ ...s, stage: "idle", phase: "idle" }));
        }, 1500);
      } else {
        // Verification failed — retry or fail
        const attempt = attemptRef.current;
        if (attempt >= MAX_ATTEMPTS) {
          setState(s => ({ ...s, stage: "failed", phase: "failed" }));
          clearTimers();
          completionTimeoutRef.current = setTimeout(() => {
            setState(s => ({ ...s, stage: "idle", phase: "idle" }));
          }, 3000);
        } else {
          attemptRef.current = attempt + 1;
          samplesRef.current = [];
          pendingTransformRef.current = null;
          setState(s => ({
            ...s,
            stage: "collecting",
            phase: "moving",
            attempt: attemptRef.current,
            pointTotal: CALIBRATION_TARGETS.length,
          }));
          setTimeout(() => moveToCollectPoint(0), 300);
        }
      }
    } else {
      setTimeout(() => moveToVerifyPoint(nextIndex), 200);
    }
  }, [clearTimers, moveToCollectPoint, moveToVerifyPoint]);

  // ── Handle point timeout (skip) ──
  const onPointTimeout = useCallback((stage: CalibrationStage, pointIndex: number) => {
    if (stage === "collecting") {
      // Skip this point (no sample recorded)
      const nextIndex = pointIndex + 1;
      if (nextIndex >= CALIBRATION_TARGETS.length) {
        // Check if we have enough
        if (samplesRef.current.length < MIN_VALID_SAMPLES) {
          const attempt = attemptRef.current;
          if (attempt >= MAX_ATTEMPTS) {
            setState(s => ({ ...s, stage: "failed", phase: "failed" }));
            clearTimers();
            completionTimeoutRef.current = setTimeout(() => {
              setState(s => ({ ...s, stage: "idle", phase: "idle" }));
            }, 3000);
          } else {
            attemptRef.current = attempt + 1;
            samplesRef.current = [];
            setState(s => ({
              ...s,
              stage: "collecting",
              attempt: attemptRef.current,
            }));
            setTimeout(() => moveToCollectPoint(0), 300);
          }
        } else {
          pendingTransformRef.current = computeCalibrationTransform(samplesRef.current);
          verifyPassCountRef.current = 0;
          setTimeout(() => moveToVerifyPoint(0), 300);
        }
      } else {
        moveToCollectPoint(nextIndex);
      }
    } else {
      // Verifying — count as fail for this point
      const nextIndex = pointIndex + 1;
      if (nextIndex >= VERIFICATION_TARGETS.length) {
        const passed = verifyPassCountRef.current >= 2;
        if (passed) {
          applyCalibrationRef.current(samplesRef.current);
          setState(s => ({ ...s, stage: "complete", phase: "complete" }));
          clearTimers();
          completionTimeoutRef.current = setTimeout(() => {
            setState(s => ({ ...s, stage: "idle", phase: "idle" }));
          }, 1500);
        } else {
          const attempt = attemptRef.current;
          if (attempt >= MAX_ATTEMPTS) {
            setState(s => ({ ...s, stage: "failed", phase: "failed" }));
            clearTimers();
            completionTimeoutRef.current = setTimeout(() => {
              setState(s => ({ ...s, stage: "idle", phase: "idle" }));
            }, 3000);
          } else {
            attemptRef.current = attempt + 1;
            samplesRef.current = [];
            pendingTransformRef.current = null;
            setState(s => ({
              ...s,
              stage: "collecting",
              attempt: attemptRef.current,
              pointTotal: CALIBRATION_TARGETS.length,
            }));
            setTimeout(() => moveToCollectPoint(0), 300);
          }
        }
      } else {
        moveToVerifyPoint(nextIndex);
      }
    }
  }, [clearTimers, moveToCollectPoint, moveToVerifyPoint]);

  // ── Main fixation detection tick ──
  const startTickLoop = useCallback(() => {
    if (tickIntervalRef.current) clearInterval(tickIntervalRef.current);

    tickIntervalRef.current = setInterval(() => {
      const s = stateRef.current;
      const { stage, phase, pointIndex } = s;

      // Only run during settling/waiting_fixation phases
      const isCollectingPhase = phase === "settling" || phase === "waiting_fixation";
      const isVerifyingPhase = phase === "verifying_settling" || phase === "verifying_fixation";
      if (!isCollectingPhase && !isVerifyingPhase) return;

      const now = Date.now();

      // Settling delay
      if (phase === "settling" || phase === "verifying_settling") {
        if (settleStartRef.current && now - settleStartRef.current >= SETTLE_MS) {
          const nextPhase = phase === "settling" ? "waiting_fixation" : "verifying_fixation";
          setState(prev => ({ ...prev, phase: nextPhase }));
          gazeBufferRef.current = [];
          fixationStartRef.current = null;
          pointStartRef.current = now;
        }
        return;
      }

      // Point timeout
      if (pointStartRef.current && now - pointStartRef.current >= POINT_TIMEOUT_MS) {
        resetFixation();
        onPointTimeout(stage, pointIndex);
        return;
      }

      // Get raw gaze
      const raw = getRawGazeRef.current();
      if (!raw) {
        // Face lost — reset buffer
        gazeBufferRef.current = [];
        fixationStartRef.current = null;
        setState(prev => ({ ...prev, fixationProgress: 0 }));
        return;
      }

      // Push to circular buffer
      const buf = gazeBufferRef.current;
      buf.push(raw);
      if (buf.length > WINDOW_SIZE) {
        buf.splice(0, buf.length - WINDOW_SIZE);
      }

      // Need minimum samples
      if (buf.length < MIN_SAMPLES) return;

      // Compute stddev
      const xs = buf.map(p => p.x);
      const ys = buf.map(p => p.y);
      const stdX = computeStdDev(xs);
      const stdY = computeStdDev(ys);

      if (stdX < FIXATION_THRESHOLD_PX && stdY < FIXATION_THRESHOLD_PX) {
        // Eyes are steady
        if (!fixationStartRef.current) {
          fixationStartRef.current = now;
        }
        const elapsed = now - fixationStartRef.current;
        const progress = Math.min(1, elapsed / REQUIRED_FIXATION_MS);
        setState(prev => ({ ...prev, fixationProgress: progress }));

        if (progress >= 1) {
          // Fixation confirmed — compute mean
          const meanGaze: GazePoint = {
            x: computeMean(xs),
            y: computeMean(ys),
          };

          resetFixation();

          if (stage === "collecting") {
            onCollectFixation(meanGaze, pointIndex);
          } else {
            onVerifyFixation(meanGaze, pointIndex);
          }
        }
      } else {
        // Eyes moving — reset
        fixationStartRef.current = null;
        setState(prev => ({ ...prev, fixationProgress: 0 }));
      }
    }, TICK_MS);
  }, [resetFixation, onPointTimeout, onCollectFixation, onVerifyFixation]);

  // ── Start calibration ──
  const start = useCallback(() => {
    clearTimers();
    resetFixation();
    samplesRef.current = [];
    pendingTransformRef.current = null;
    verifyPassCountRef.current = 0;
    attemptRef.current = 1;
    clearCalibration();

    const firstTarget = CALIBRATION_TARGETS[0];
    setState({
      stage: "collecting",
      phase: "settling",
      dotNx: firstTarget.nx,
      dotNy: firstTarget.ny,
      fixationProgress: 0,
      pointIndex: 0,
      pointTotal: CALIBRATION_TARGETS.length,
      attempt: 1,
    });

    settleStartRef.current = Date.now();
    pointStartRef.current = Date.now();
    startTickLoop();
  }, [clearTimers, resetFixation, clearCalibration, startTickLoop]);

  // ── Cancel calibration ──
  const cancel = useCallback(() => {
    clearTimers();
    resetFixation();
    samplesRef.current = [];
    pendingTransformRef.current = null;
    setState({
      stage: "idle",
      phase: "idle",
      dotNx: 0.5,
      dotNy: 0.5,
      fixationProgress: 0,
      pointIndex: 0,
      pointTotal: CALIBRATION_TARGETS.length,
      attempt: 0,
    });
  }, [clearTimers, resetFixation]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  return {
    state,
    start,
    cancel,
    isActive: state.stage !== "idle",
  };
}
