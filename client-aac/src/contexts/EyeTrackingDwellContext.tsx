// client-aac/src/contexts/EyeTrackingDwellContext.tsx
// Dwell selection for eye gaze or mouse/external-device cursor control.
// Hit-tests [data-dwell] elements and triggers click after dwell timeout.
//
// After a selection, hovering is disabled until the cursor moves 40px
// (straight-line) from where it was disabled. Genuine movement is the ONLY
// way to re-arm: a board rebuild that places a new button under a stationary
// cursor must never re-trigger a selection.
//
// In eyegaze mode, dwell is suspended while the gaze signal is stale (no
// fresh sample within STALE_GAZE_MS). Eyegaze providers stream continuously
// while a user is present, so silence means the tracker lost the eyes or the
// user left. Cursor-control ("mouse") mode is NOT staleness-gated — there a
// physically still cursor is the legitimate dwell gesture and stillness
// produces no events to judge freshness by.
//
// Uses requestAnimationFrame (throttled to ~20Hz) instead of setInterval so
// external devices that move the cursor without firing mousemove still work.

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { CalibrationSample } from "@/lib/gazeEstimator";
import type { GazePoint } from "@/lib/eyegaze/types";
import { DwellEngine, DEFAULT_REACTIVATION_PX } from "@shared/dwell-engine";

// ─── Types ───────────────────────────────────────────────────────
export type DwellMode = "off" | "eyegaze" | "mouse";

export interface DwellTarget {
  element: HTMLElement;
  rect: DOMRect;
  progress: number; // 0-1
}

export interface DwellDebugInfo {
  hoverEnabled: boolean;
  movementFromAnchor: number;
  movementThreshold: number;
  /** True when no fresh gaze sample arrived within STALE_GAZE_MS (eyegaze mode only). */
  gazeStale: boolean;
  dwellElementLabel: string | null;
  dwellProgress: number;
}

export interface EyeTrackingDwellContextValue {
  gazePosition: GazePoint | null;
  dwellTarget: DwellTarget | null;
  enabled: boolean;
  mode: DwellMode;
  /** Configured dwell time in ms (from aacSettings.eyegazeTimeout). Exposed so
   *  embedded games with their own dwell logic can honour the same setting. */
  dwellTimeMs: number;
  isCalibrated: boolean;
  isCalibrating: boolean;
  startCalibration: () => void;
  cancelCalibration: () => void;
  clearCalibration: () => void;
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  dwellDebug: DwellDebugInfo;
}

const DEFAULT_DEBUG: DwellDebugInfo = {
  hoverEnabled: true,
  movementFromAnchor: 0,
  movementThreshold: DEFAULT_REACTIVATION_PX,
  gazeStale: false,
  dwellElementLabel: null,
  dwellProgress: 0,
};

const EyeTrackingDwellContext = createContext<EyeTrackingDwellContextValue>({
  gazePosition: null,
  dwellTarget: null,
  enabled: false,
  mode: "off",
  dwellTimeMs: 2000,
  isCalibrated: false,
  isCalibrating: false,
  startCalibration: () => {},
  cancelCalibration: () => {},
  clearCalibration: () => {},
  getRawGaze: () => null,
  applyCalibration: () => {},
  dwellDebug: DEFAULT_DEBUG,
});

export function useEyeTrackingDwell() {
  return useContext(EyeTrackingDwellContext);
}

// ─── Provider ────────────────────────────────────────────────────
interface Props {
  mode: DwellMode;
  dwellTimeMs: number;
  gazePoint: GazePoint | null;
  isCalibrated: boolean;
  supportsCalibration: boolean;
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  clearCalibrationData: () => void;
  children: ReactNode;
}

const TICK_INTERVAL_MS = 50; // throttle rAF to ~20Hz
// Eyegaze providers emit 20-90Hz while tracking; even blinks are shorter
// than this. No sample for this long means the signal is gone, not still.
const STALE_GAZE_MS = 500;

/** Find the [data-dwell] element under a point, respecting [data-dwell-trap] boundaries. */
function hitTestDwell(x: number, y: number): HTMLElement | null {
  const elements = document.elementsFromPoint(x, y);
  for (const el of elements) {
    const htmlEl = el as HTMLElement;
    const trap = htmlEl.closest("[data-dwell-trap]") as HTMLElement | null;
    if (trap) {
      const found = htmlEl.closest("[data-dwell]") as HTMLElement | null;
      return found && trap.contains(found) ? found : null;
    }
    const found = htmlEl.closest("[data-dwell]") as HTMLElement | null;
    if (found) return found;
  }
  return null;
}

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

  // ── React state (for rendering) ──
  const [gazePosition, setGazePosition] = useState<GazePoint | null>(null);
  const [dwellTarget, setDwellTarget] = useState<DwellTarget | null>(null);
  const [isCalibrated, setIsCalibrated] = useState(externalIsCalibrated);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [dwellDebug, setDwellDebug] = useState<DwellDebugInfo>(DEFAULT_DEBUG);

  // ── Cursor position refs (written by events/prop, read by rAF loop) ──
  const cursorPosRef = useRef<GazePoint | null>(null);  // mouse mode
  const gazePointRef = useRef<GazePoint | null>(null);   // eyegaze mode

  // ── Dwell state (decision logic lives in the shared DwellEngine) ──
  const gazeUpdatedAtRef = useRef(0); // performance.now() of last fresh gaze sample

  // ── Stable refs for props that change often ──
  const isCalibratingRef = useRef(isCalibrating);
  isCalibratingRef.current = isCalibrating;

  // ── Sync props to refs ──
  useEffect(() => { setIsCalibrated(externalIsCalibrated); }, [externalIsCalibrated]);
  useEffect(() => {
    gazePointRef.current = externalGazePoint;
    // Each gaze sample arrives as a fresh object, so this effect runs per
    // sample even when coordinates repeat — making it a freshness signal.
    if (externalGazePoint) gazeUpdatedAtRef.current = performance.now();
  }, [externalGazePoint]);

  // ── Mouse/pointer tracking (mouse mode) ──
  useEffect(() => {
    if (mode !== "mouse") { cursorPosRef.current = null; return; }
    const handler = (e: PointerEvent | MouseEvent) => {
      cursorPosRef.current = { x: e.clientX, y: e.clientY };
    };
    // Listen to both — pointermove covers more input device types
    window.addEventListener("pointermove", handler, { passive: true });
    window.addEventListener("mousemove", handler, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handler);
      window.removeEventListener("mousemove", handler);
    };
  }, [mode]);

  // ── Calibration controls ──
  const startCalibration = useCallback(() => {
    if (mode !== "eyegaze" || !supportsCalibration) return;
    setIsCalibrating(true);
  }, [mode, supportsCalibration]);

  const cancelCalibration = useCallback(() => { setIsCalibrating(false); }, []);

  const clearCalibration = useCallback(() => {
    clearCalibrationData();
    setIsCalibrated(false);
  }, [clearCalibrationData]);

  const applyCalibrationWrapped = useCallback((samples: CalibrationSample[]) => {
    externalApplyCalibration(samples);
    setIsCalibrated(true);
    setIsCalibrating(false);
  }, [externalApplyCalibration]);

  // ── Auto-trigger calibration on first eyegaze use ──
  const autoCalibTriggeredRef = useRef(false);
  const supportsCalibrationRef = useRef(supportsCalibration);
  supportsCalibrationRef.current = supportsCalibration;
  useEffect(() => {
    if (mode === "eyegaze" && supportsCalibration && !isCalibrated && !isCalibrating && !autoCalibTriggeredRef.current) {
      autoCalibTriggeredRef.current = true;
      const timer = setTimeout(() => {
        if (supportsCalibrationRef.current) startCalibration();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [mode, supportsCalibration, isCalibrated, isCalibrating, startCalibration]);

  useEffect(() => {
    if (mode !== "eyegaze") autoCalibTriggeredRef.current = false;
  }, [mode]);

  // ── Main rAF loop ──
  useEffect(() => {
    if (!enabled) {
      setGazePosition(null);
      setDwellTarget(null);
      setDwellDebug(DEFAULT_DEBUG);
      return;
    }

    // Fresh engine per mode/timing change: staleness gating applies to
    // eyegaze only — in cursor-control mode a still cursor IS the dwell
    // gesture and stillness produces no events to judge freshness by.
    const engine = new DwellEngine<HTMLElement>({
      dwellTimeMs,
      staleGazeMs: mode === "eyegaze" ? STALE_GAZE_MS : null,
    });

    let rafId: number;
    let lastTickTime = 0;

    const tick = (time: number) => {
      rafId = requestAnimationFrame(tick);

      // Throttle to ~20Hz
      if (time - lastTickTime < TICK_INTERVAL_MS) return;
      lastTickTime = time;

      // Get current point
      const point = mode === "mouse" ? cursorPosRef.current : gazePointRef.current;
      if (!point || isCalibratingRef.current) {
        setGazePosition(point ?? null);
        setDwellTarget(null);
        engine.clearTarget();
        return;
      }

      setGazePosition(point);

      const dwellEl = hitTestDwell(point.x, point.y);
      const r = engine.update(dwellEl, point, time, gazeUpdatedAtRef.current);

      if (r.fired) r.fired.click();

      setDwellTarget(
        r.target
          ? { element: r.target, rect: r.target.getBoundingClientRect(), progress: r.progress }
          : null,
      );
      setDwellDebug({
        hoverEnabled: r.hoverEnabled,
        movementFromAnchor: r.movementFromAnchor,
        movementThreshold: DEFAULT_REACTIVATION_PX,
        gazeStale: r.gazeStale,
        dwellElementLabel: (r.target ?? r.fired)?.textContent?.slice(0, 30) ?? null,
        dwellProgress: r.progress,
      });
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [enabled, mode, dwellTimeMs]);

  return (
    <EyeTrackingDwellContext.Provider
      value={{
        gazePosition,
        dwellTarget,
        enabled,
        mode,
        dwellTimeMs,
        isCalibrated,
        isCalibrating,
        startCalibration,
        cancelCalibration,
        clearCalibration,
        getRawGaze,
        applyCalibration: applyCalibrationWrapped,
        dwellDebug,
      }}
    >
      {children}
    </EyeTrackingDwellContext.Provider>
  );
}
