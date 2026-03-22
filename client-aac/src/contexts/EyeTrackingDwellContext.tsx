// client-aac/src/contexts/EyeTrackingDwellContext.tsx
// Dwell selection for eye gaze or mouse/external-device cursor control.
// Hit-tests [data-dwell] elements and triggers click after dwell timeout.
//
// After a selection, hovering is disabled until either:
//   1. The cursor moves 40px (straight-line) from where it was disabled, OR
//   2. The cursor enters a different grid cell (data-dwell-cell attribute).
//
// Uses requestAnimationFrame (throttled to ~20Hz) instead of setInterval so
// external devices that move the cursor without firing mousemove still work.

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

export interface DwellDebugInfo {
  hoverEnabled: boolean;
  movementFromAnchor: number;
  movementThreshold: number;
  currentCellId: string | null;
  disabledAtCellId: string | null;
  dwellElementLabel: string | null;
  dwellProgress: number;
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
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  dwellDebug: DwellDebugInfo;
}

const DEFAULT_DEBUG: DwellDebugInfo = {
  hoverEnabled: true,
  movementFromAnchor: 0,
  movementThreshold: 40,
  currentCellId: null,
  disabledAtCellId: null,
  dwellElementLabel: null,
  dwellProgress: 0,
};

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

const REACTIVATION_PX = 40;
const TICK_INTERVAL_MS = 50; // throttle rAF to ~20Hz

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

  // ── Dwell state refs (mutated in rAF loop, never in deps) ──
  const hoverEnabledRef = useRef(true);
  const disableAnchorRef = useRef<GazePoint | null>(null);
  const disabledCellIdRef = useRef<string | null>(null);
  const currentDwellElRef = useRef<HTMLElement | null>(null);
  const dwellStartRef = useRef(0);

  // ── Stable refs for props that change often ──
  const isCalibratingRef = useRef(isCalibrating);
  isCalibratingRef.current = isCalibrating;

  // ── Sync props to refs ──
  useEffect(() => { setIsCalibrated(externalIsCalibrated); }, [externalIsCalibrated]);
  useEffect(() => { gazePointRef.current = externalGazePoint; }, [externalGazePoint]);

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
      hoverEnabledRef.current = true;
      return;
    }

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
        currentDwellElRef.current = null;
        return;
      }

      setGazePosition(point);

      // Hit test
      const dwellEl = hitTestDwell(point.x, point.y);
      const cellId = dwellEl?.getAttribute("data-dwell-cell") ?? null;

      // ── Check hover re-activation ──
      let distFromAnchor = 0;
      if (!hoverEnabledRef.current) {
        const anchor = disableAnchorRef.current;
        if (anchor) {
          const dx = point.x - anchor.x;
          const dy = point.y - anchor.y;
          distFromAnchor = Math.sqrt(dx * dx + dy * dy);
        }
        const movedEnough = distFromAnchor >= REACTIVATION_PX;
        const differentCell = cellId !== null && cellId !== disabledCellIdRef.current;

        if (movedEnough || differentCell) {
          hoverEnabledRef.current = true;
          disableAnchorRef.current = null;
          disabledCellIdRef.current = null;
        }
      }

      // ── Update debug ──
      setDwellDebug({
        hoverEnabled: hoverEnabledRef.current,
        movementFromAnchor: distFromAnchor,
        movementThreshold: REACTIVATION_PX,
        currentCellId: cellId,
        disabledAtCellId: disabledCellIdRef.current,
        dwellElementLabel: currentDwellElRef.current?.textContent?.slice(0, 30) ?? null,
        dwellProgress: 0, // updated below if dwelling
      });

      // ── Hover disabled → skip dwell ──
      if (!hoverEnabledRef.current) {
        currentDwellElRef.current = null;
        setDwellTarget(null);
        return;
      }

      // ── No element → reset dwell ──
      if (!dwellEl) {
        currentDwellElRef.current = null;
        setDwellTarget(null);
        return;
      }

      const now = Date.now();

      // ── Same element → advance timer ──
      if (dwellEl === currentDwellElRef.current) {
        const elapsed = now - dwellStartRef.current;
        const progress = Math.min(1, elapsed / dwellTimeMs);

        if (progress >= 1) {
          // Select
          dwellEl.click();
          hoverEnabledRef.current = false;
          disableAnchorRef.current = { x: point.x, y: point.y };
          disabledCellIdRef.current = cellId;
          currentDwellElRef.current = null;
          setDwellTarget(null);
          setDwellDebug(prev => ({ ...prev, hoverEnabled: false, dwellProgress: 1 }));
        } else {
          setDwellTarget({ element: dwellEl, rect: dwellEl.getBoundingClientRect(), progress });
          setDwellDebug(prev => ({ ...prev, dwellProgress: progress }));
        }
        return;
      }

      // ── Different element → start new timer ──
      currentDwellElRef.current = dwellEl;
      dwellStartRef.current = now;
      setDwellTarget({ element: dwellEl, rect: dwellEl.getBoundingClientRect(), progress: 0 });
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
