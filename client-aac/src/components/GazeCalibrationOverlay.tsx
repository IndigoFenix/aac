// client-aac/src/components/GazeCalibrationOverlay.tsx
// Full-screen overlay that guides the user through 5-point gaze calibration.
// Shows a pulsing target dot at each calibration point; user fixates for ~2s or taps to confirm.

import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { CALIBRATION_TARGETS } from "@/lib/gazeEstimator";

const TARGET_SIZE = 40;
const FIXATION_MS = 2000;
const GAZE_DOT_SIZE = 20;

export default function GazeCalibrationOverlay() {
  const {
    isCalibrating,
    calibrationStep,
    calibrationTotal,
    recordCalibrationSample,
    cancelCalibration,
    gazePosition,
  } = useEyeTrackingDwell();

  const [holdStart, setHoldStart] = useState<number | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);

  const target = CALIBRATION_TARGETS[calibrationStep];
  const tx = target ? target.nx * window.innerWidth : 0;
  const ty = target ? target.ny * window.innerHeight : 0;

  // Reset hold state when step changes
  useEffect(() => {
    setHoldStart(null);
    setHoldProgress(0);
  }, [calibrationStep]);

  // Auto-accept when gaze stays near the target for FIXATION_MS
  useEffect(() => {
    if (!isCalibrating || !gazePosition || !target) return;

    const dist = Math.hypot(gazePosition.x - tx, gazePosition.y - ty);
    const threshold = Math.min(window.innerWidth, window.innerHeight) * 0.15; // 15% of screen

    if (dist < threshold) {
      if (!holdStart) {
        setHoldStart(Date.now());
      }
    } else {
      setHoldStart(null);
      setHoldProgress(0);
    }
  }, [isCalibrating, gazePosition, target, tx, ty, holdStart]);

  // Progress timer for auto-accept
  useEffect(() => {
    if (!holdStart || !isCalibrating) return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - holdStart;
      const p = Math.min(1, elapsed / FIXATION_MS);
      setHoldProgress(p);

      if (p >= 1) {
        clearInterval(interval);
        recordCalibrationSample();
        setHoldStart(null);
        setHoldProgress(0);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [holdStart, isCalibrating, recordCalibrationSample]);

  // Tap anywhere on the overlay to confirm this point
  const handleTap = useCallback((e: React.MouseEvent) => {
    // Don't trigger if tapping the cancel button
    if ((e.target as HTMLElement).closest("[data-cancel-calibration]")) return;
    if (isCalibrating) {
      recordCalibrationSample();
      setHoldStart(null);
      setHoldProgress(0);
    }
  }, [isCalibrating, recordCalibrationSample]);

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    cancelCalibration();
  }, [cancelCalibration]);

  if (!isCalibrating) return null;

  return (
    <div
      onClick={handleTap}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        backgroundColor: "rgba(0, 0, 0, 0.85)",
        cursor: "pointer",
        touchAction: "none",
      }}
    >
      {/* Cancel button — top right */}
      <button
        data-cancel-calibration
        onClick={handleCancel}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          zIndex: 10001,
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: "rgba(255, 255, 255, 0.15)",
          border: "1px solid rgba(255, 255, 255, 0.3)",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <X size={20} />
      </button>

      {/* Instructions */}
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 60,
          right: 60,
          textAlign: "center",
          color: "white",
          fontSize: 20,
          fontWeight: 600,
        }}
      >
        Look at the circle ({calibrationStep + 1}/{calibrationTotal})
      </div>
      <div
        style={{
          position: "absolute",
          top: 54,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "rgba(255,255,255,0.5)",
          fontSize: 14,
        }}
      >
        Hold your gaze or tap anywhere to confirm
      </div>

      {/* Target dot with progress ring */}
      <svg
        style={{
          position: "absolute",
          left: tx - TARGET_SIZE,
          top: ty - TARGET_SIZE,
          width: TARGET_SIZE * 2,
          height: TARGET_SIZE * 2,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        {/* Background ring */}
        <circle
          cx={TARGET_SIZE}
          cy={TARGET_SIZE}
          r={TARGET_SIZE - 4}
          fill="none"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth={4}
        />

        {/* Progress ring */}
        <circle
          cx={TARGET_SIZE}
          cy={TARGET_SIZE}
          r={TARGET_SIZE - 4}
          fill="none"
          stroke="#3B82F6"
          strokeWidth={4}
          strokeDasharray={2 * Math.PI * (TARGET_SIZE - 4)}
          strokeDashoffset={2 * Math.PI * (TARGET_SIZE - 4) * (1 - holdProgress)}
          strokeLinecap="round"
          transform={`rotate(-90 ${TARGET_SIZE} ${TARGET_SIZE})`}
        />

        {/* Inner pulsing dot */}
        <circle
          cx={TARGET_SIZE}
          cy={TARGET_SIZE}
          r={8}
          fill="#3B82F6"
        >
          <animate
            attributeName="r"
            values="8;12;8"
            dur="1.5s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="1;0.6;1"
            dur="1.5s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>

      {/* Gaze cursor rendered INSIDE the overlay so it's visible above it */}
      {gazePosition && (
        <div
          style={{
            position: "absolute",
            left: gazePosition.x - GAZE_DOT_SIZE / 2,
            top: gazePosition.y - GAZE_DOT_SIZE / 2,
            width: GAZE_DOT_SIZE,
            height: GAZE_DOT_SIZE,
            borderRadius: "50%",
            backgroundColor: "rgba(239, 68, 68, 0.6)",
            border: "2px solid rgba(239, 68, 68, 0.9)",
            pointerEvents: "none",
            transition: "left 50ms linear, top 50ms linear",
          }}
        />
      )}
    </div>
  );
}
