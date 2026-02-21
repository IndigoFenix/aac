// client-aac/src/components/GazeCalibrationOverlay.tsx
// Full-screen overlay for fixation-based gaze calibration.
// Shows a pulsing target dot that moves between calibration points;
// detects fixation (eyes holding still) without needing calibrated gaze position.
// No tap handler — purely passive for children with Rett syndrome.

import { useEffect, useCallback, useRef, useMemo } from "react";
import { X } from "lucide-react";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { useCalibrationFlow, type CalibrationPhase } from "@/hooks/useCalibrationFlow";
import { CALIBRATION_TARGETS, VERIFICATION_TARGETS } from "@/lib/gazeEstimator";
import { useLanguage } from "@/contexts/LanguageContext";

const TARGET_SIZE = 40;
const DOT_SPEED_PX_SEC = 500;

// ─── CalibrationDot ───────────────────────────────────────────────
interface CalibrationDotProps {
  x: number; // px
  y: number; // px
  progress: number; // 0-1, fixation progress
  phase: CalibrationPhase;
  transitionMs: number;
}

function CalibrationDot({ x, y, progress, phase, transitionMs }: CalibrationDotProps) {
  const isSettling = phase === "settling" || phase === "verifying_settling";
  const opacity = isSettling ? 0.5 : 1;

  return (
    <svg
      style={{
        position: "absolute",
        left: x - TARGET_SIZE,
        top: y - TARGET_SIZE,
        width: TARGET_SIZE * 2,
        height: TARGET_SIZE * 2,
        overflow: "visible",
        pointerEvents: "none",
        transition: `left ${transitionMs}ms ease-in-out, top ${transitionMs}ms ease-in-out`,
        opacity,
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
        strokeDashoffset={2 * Math.PI * (TARGET_SIZE - 4) * (1 - progress)}
        strokeLinecap="round"
        transform={`rotate(-90 ${TARGET_SIZE} ${TARGET_SIZE})`}
        style={{ transition: "stroke-dashoffset 80ms linear" }}
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
  );
}

// ─── ProgressDots ─────────────────────────────────────────────────
function ProgressDots({ total, current, stage }: { total: number; current: number; stage: string }) {
  return (
    <div style={{
      position: "absolute",
      bottom: 32,
      left: 0,
      right: 0,
      display: "flex",
      justifyContent: "center",
      gap: 12,
    }}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            backgroundColor: i < current
              ? "#3B82F6"
              : i === current
                ? "rgba(59, 130, 246, 0.5)"
                : "rgba(255, 255, 255, 0.2)",
            border: i === current ? "2px solid #3B82F6" : "2px solid transparent",
            transition: "background-color 300ms, border-color 300ms",
          }}
        />
      ))}
      <span style={{
        color: "rgba(255,255,255,0.4)",
        fontSize: 12,
        marginLeft: 8,
        alignSelf: "center",
      }}>
        {stage === "verifying" ? "verify" : "collect"}
      </span>
    </div>
  );
}

// ─── Main Overlay ─────────────────────────────────────────────────
export default function GazeCalibrationOverlay() {
  const {
    isCalibrating,
    cancelCalibration,
    getRawGaze,
    applyCalibration,
    clearCalibration,
  } = useEyeTrackingDwell();

  const { t } = useLanguage();

  const { state, start, cancel, isActive } = useCalibrationFlow({
    getRawGaze,
    applyCalibration,
    clearCalibration,
  });

  // Track previous dot position for transition duration calculation
  const prevDotRef = useRef({ nx: 0.5, ny: 0.5 });
  const transitionMsRef = useRef(0);

  // Calculate transition duration when dot position changes
  const dotPx = useMemo(() => ({
    x: state.dotNx * window.innerWidth,
    y: state.dotNy * window.innerHeight,
  }), [state.dotNx, state.dotNy]);

  useEffect(() => {
    if (state.dotNx !== prevDotRef.current.nx || state.dotNy !== prevDotRef.current.ny) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dx = (state.dotNx - prevDotRef.current.nx) * w;
      const dy = (state.dotNy - prevDotRef.current.ny) * h;
      const dist = Math.hypot(dx, dy);
      transitionMsRef.current = Math.max(200, (dist / DOT_SPEED_PX_SEC) * 1000);
      prevDotRef.current = { nx: state.dotNx, ny: state.dotNy };
    }
  }, [state.dotNx, state.dotNy]);

  // Auto-start when isCalibrating becomes true
  useEffect(() => {
    if (isCalibrating && !isActive) {
      start();
    }
  }, [isCalibrating, isActive, start]);

  // Sync cancel back to context when flow ends
  useEffect(() => {
    if (!isActive && isCalibrating) {
      cancelCalibration();
    }
  }, [isActive, isCalibrating, cancelCalibration]);

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    cancel();
    cancelCalibration();
  }, [cancel, cancelCalibration]);

  if (!isCalibrating && !isActive) return null;

  // ── Status text ──
  let statusText = "";
  const { stage, phase } = state;
  if (stage === "complete") {
    statusText = t("calibration.complete");
  } else if (stage === "failed") {
    statusText = t("calibration.failed");
  } else if (stage === "verifying") {
    statusText = t("calibration.checkingAccuracy");
  } else if (stage === "collecting") {
    statusText = t("calibration.lookAtDot");
  }

  // Subtitle
  let subtitleText = "";
  if (stage === "collecting" && state.attempt > 1) {
    subtitleText = t("calibration.retrying");
  } else if (stage === "collecting") {
    subtitleText = t("calibration.followDot");
  }

  const showDot = stage === "collecting" || stage === "verifying";
  const progressTotal = stage === "verifying" ? VERIFICATION_TARGETS.length : CALIBRATION_TARGETS.length;

  return (
    <div
      data-dwell-trap
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        backgroundColor: "rgba(0, 0, 0, 0.92)",
        touchAction: "none",
      }}
    >
      {/* Cancel button — top right (for caretaker) */}
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

      {/* Status text */}
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
        {statusText}
        {stage === "collecting" && (
          <span style={{ opacity: 0.6, marginLeft: 8 }}>
            ({state.pointIndex + 1}/{CALIBRATION_TARGETS.length})
          </span>
        )}
      </div>

      {subtitleText && (
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
          {subtitleText}
        </div>
      )}

      {/* Target dot */}
      {showDot && (
        <CalibrationDot
          x={dotPx.x}
          y={dotPx.y}
          progress={state.fixationProgress}
          phase={state.phase}
          transitionMs={transitionMsRef.current}
        />
      )}

      {/* Completion / failure indicator */}
      {stage === "complete" && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          color: "#22C55E",
          fontSize: 64,
        }}>
          &#10003;
        </div>
      )}

      {stage === "failed" && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          color: "#EF4444",
          fontSize: 48,
        }}>
          &#10007;
        </div>
      )}

      {/* Progress dots */}
      {showDot && (
        <ProgressDots
          total={progressTotal}
          current={state.pointIndex}
          stage={stage}
        />
      )}
    </div>
  );
}
