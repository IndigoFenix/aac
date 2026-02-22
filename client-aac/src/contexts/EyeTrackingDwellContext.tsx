// client-aac/src/contexts/EyeTrackingDwellContext.tsx
// Global provider for dwell selection via eye gaze (any source) or mouse position.
// Hit-tests [data-dwell] elements at the gaze/mouse point and triggers click after dwell timeout.

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { CalibrationSample } from "@/lib/gazeEstimator";
import type { GazePoint } from "@/lib/eyegaze/types";

// ─── Types ───────────────────────────────────────────────────────
export type DwellMode = "off" | "eyegaze" | "mouse";

export interface DwellTarget {
  element: HTMLElement;
  rect: DOMRect;
  progress: number; // 0-1
}

export interface EyeTrackingDwellContextValue {
  gazePosition: GazePoint | null;
  dwellTarget: DwellTarget | null;
  enabled: boolean;
  mode: DwellMode;
  isCalibrated: boolean;
  isCalibrating: boolean;
  startCalibration: () => void;
  cancelCalibration: () => void;
  clearCalibration: () => void;
  /** Get the raw (uncalibrated) gaze point — used by calibration flow */
  getRawGaze: () => GazePoint | null;
  /** Apply calibration from collected samples — used by calibration flow */
  applyCalibration: (samples: CalibrationSample[]) => void;
}

const EyeTrackingDwellContext = createContext<EyeTrackingDwellContextValue>({
  gazePosition: null,
  dwellTarget: null,
  enabled: false,
  mode: "off",
  isCalibrated: false,
  isCalibrating: false,
  startCalibration: () => {},
  cancelCalibration: () => {},
  clearCalibration: () => {},
  getRawGaze: () => null,
  applyCalibration: () => {},
});

export function useEyeTrackingDwell() {
  return useContext(EyeTrackingDwellContext);
}

// ─── Provider ────────────────────────────────────────────────────
interface Props {
  mode: DwellMode;
  dwellTimeMs: number;
  /** Unified gaze point from useEyeGaze hook (used in "eyegaze" mode) */
  gazePoint: GazePoint | null;
  /** Calibration props from useEyeGaze (camera provider) */
  isCalibrated: boolean;
  supportsCalibration: boolean;
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  clearCalibrationData: () => void;
  children: ReactNode;
}

const TICK_MS = 50;

export function EyeTrackingDwellProvider({
  mode,
  dwellTimeMs,
  gazePoint: externalGazePoint,
  isCalibrated: externalIsCalibrated,
  supportsCalibration,
  getRawGaze,
  applyCalibration: externalApplyCalibration,
  clearCalibrationData,
  children,
}: Props) {
  const enabled = mode !== "off";
  const [gazePosition, setGazePosition] = useState<GazePoint | null>(null);
  const [dwellTarget, setDwellTarget] = useState<DwellTarget | null>(null);
  const [isCalibrated, setIsCalibrated] = useState(externalIsCalibrated);

  // Calibration state (eyegaze mode only, when provider supports it)
  const [isCalibrating, setIsCalibrating] = useState(false);

  // Dwell tracking refs
  const currentElementRef = useRef<HTMLElement | null>(null);
  const dwellStartRef = useRef<number>(0);
  const cooldownElementRef = useRef<HTMLElement | null>(null);
  // Position-based cooldown: prevents reselection when board patches replace buttons at same position
  const cooldownPositionRef = useRef<{ x: number; y: number } | null>(null);

  // Mouse position ref (updated by mousemove listener, read by dwell interval)
  const mousePosRef = useRef<GazePoint | null>(null);

  // Sync calibrated state from external source
  useEffect(() => {
    setIsCalibrated(externalIsCalibrated);
  }, [externalIsCalibrated]);

  // ── Mouse tracking (mouse mode) ──
  useEffect(() => {
    if (mode !== "mouse") {
      mousePosRef.current = null;
      return;
    }

    const handleMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
    };

    window.addEventListener("mousemove", handleMove, { passive: true });
    return () => window.removeEventListener("mousemove", handleMove);
  }, [mode]);

  // ── Calibration controls ──
  const startCalibration = useCallback(() => {
    if (mode !== "eyegaze" || !supportsCalibration) return;
    setIsCalibrating(true);
  }, [mode, supportsCalibration]);

  const cancelCalibration = useCallback(() => {
    setIsCalibrating(false);
  }, []);

  const clearCalibration = useCallback(() => {
    clearCalibrationData();
    setIsCalibrated(false);
  }, [clearCalibrationData]);

  // Wrap applyCalibration to also update local calibrated state
  const applyCalibrationWrapped = useCallback((samples: CalibrationSample[]) => {
    externalApplyCalibration(samples);
    setIsCalibrated(true);
    setIsCalibrating(false);
  }, [externalApplyCalibration]);

  // ── Auto-trigger calibration on first eyegaze use ──
  // Uses a longer delay (1.5s) to let provider auto-detection settle.
  // supportsCalibration is only true after detection completes and camera is confirmed active.
  const autoCalibTriggeredRef = useRef(false);
  const supportsCalibrationRef = useRef(supportsCalibration);
  supportsCalibrationRef.current = supportsCalibration;
  useEffect(() => {
    if (mode === "eyegaze" && supportsCalibration && !isCalibrated && !isCalibrating && !autoCalibTriggeredRef.current) {
      autoCalibTriggeredRef.current = true;
      const timer = setTimeout(() => {
        // Re-check: provider detection may have switched away from camera
        if (supportsCalibrationRef.current) {
          startCalibration();
        }
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [mode, supportsCalibration, isCalibrated, isCalibrating, startCalibration]);

  // Reset auto-trigger flag when mode changes away from eyegaze
  useEffect(() => {
    if (mode !== "eyegaze") {
      autoCalibTriggeredRef.current = false;
    }
  }, [mode]);

  // ── Shared dwell hit-test logic ──
  const runDwellHitTest = useCallback((point: GazePoint) => {
    const elements = document.elementsFromPoint(point.x, point.y);
    let dwellEl: HTMLElement | null = null;
    for (const el of elements) {
      const htmlEl = el as HTMLElement;
      const trap = htmlEl.closest("[data-dwell-trap]") as HTMLElement | null;
      if (trap) {
        const found = htmlEl.closest("[data-dwell]") as HTMLElement | null;
        if (found && trap.contains(found)) {
          dwellEl = found;
        }
        break;
      }
      const found = htmlEl.closest("[data-dwell]") as HTMLElement | null;
      if (found) {
        dwellEl = found;
        break;
      }
    }

    if (!dwellEl) {
      currentElementRef.current = null;
      cooldownElementRef.current = null;
      cooldownPositionRef.current = null;
      setDwellTarget(null);
      return;
    }

    // Position-based cooldown: reject targets near the cooldown position
    // (handles board patch replacing buttons at the same position)
    if (cooldownPositionRef.current) {
      const elRect = dwellEl.getBoundingClientRect();
      const elCenter = { x: elRect.left + elRect.width / 2, y: elRect.top + elRect.height / 2 };
      const dx = elCenter.x - cooldownPositionRef.current.x;
      const dy = elCenter.y - cooldownPositionRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 100) {
        // Still near the cooldown position — reject
        setDwellTarget(null);
        return;
      }
      // Gaze moved away from cooldown position — clear it
      cooldownPositionRef.current = null;
      cooldownElementRef.current = null;
    }

    if (dwellEl === cooldownElementRef.current) {
      setDwellTarget(null);
      return;
    }

    const now = Date.now();

    if (dwellEl !== currentElementRef.current) {
      currentElementRef.current = dwellEl;
      dwellStartRef.current = now;
      setDwellTarget({ element: dwellEl, rect: dwellEl.getBoundingClientRect(), progress: 0 });
      return;
    }

    const elapsed = now - dwellStartRef.current;
    const progress = Math.min(1, elapsed / dwellTimeMs);

    if (progress >= 1) {
      dwellEl.click();
      // Store cooldown position (center of clicked element) for position-based cooldown
      const clickedRect = dwellEl.getBoundingClientRect();
      cooldownPositionRef.current = {
        x: clickedRect.left + clickedRect.width / 2,
        y: clickedRect.top + clickedRect.height / 2,
      };
      cooldownElementRef.current = dwellEl;
      currentElementRef.current = null;
      setDwellTarget(null);
    } else {
      setDwellTarget({ element: dwellEl, rect: dwellEl.getBoundingClientRect(), progress });
    }
  }, [dwellTimeMs]);

  // ── Main loop ──
  useEffect(() => {
    if (!enabled) {
      setGazePosition(null);
      setDwellTarget(null);
      return;
    }

    const interval = setInterval(() => {
      // ── Mouse mode: use mouse position directly ──
      if (mode === "mouse") {
        const mp = mousePosRef.current;
        if (!mp) {
          setGazePosition(null);
          setDwellTarget(null);
          currentElementRef.current = null;
          return;
        }
        setGazePosition(mp);
        runDwellHitTest(mp);
        return;
      }

      // ── Eyegaze mode: use external gazePoint from useEyeGaze ──
      if (!externalGazePoint) {
        setGazePosition(null);
        setDwellTarget(null);
        currentElementRef.current = null;
        return;
      }

      // During calibration, the hook polls getRawGaze() itself — just suspend dwell
      if (isCalibrating) {
        setDwellTarget(null);
        return;
      }

      setGazePosition(externalGazePoint);
      runDwellHitTest(externalGazePoint);
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [enabled, mode, externalGazePoint, isCalibrating, runDwellHitTest]);

  return (
    <EyeTrackingDwellContext.Provider
      value={{
        gazePosition,
        dwellTarget,
        enabled,
        mode,
        isCalibrated,
        isCalibrating,
        startCalibration,
        cancelCalibration,
        clearCalibration,
        getRawGaze,
        applyCalibration: applyCalibrationWrapped,
      }}
    >
      {children}
    </EyeTrackingDwellContext.Provider>
  );
}
