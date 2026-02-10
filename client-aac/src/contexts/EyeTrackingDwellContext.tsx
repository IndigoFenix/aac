// client-aac/src/contexts/EyeTrackingDwellContext.tsx
// Global provider for dwell selection via camera-based eye tracking OR mouse position.
// Hit-tests [data-dwell] elements at the gaze/mouse point and triggers click after dwell timeout.

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import { createGazeEstimator, type GazePoint, type GazeEstimator, type CalibrationSample, CALIBRATION_TARGETS } from "@/lib/gazeEstimator";

// ─── Types ───────────────────────────────────────────────────────
export type DwellMode = "off" | "camera" | "mouse";

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
  calibrationStep: number;
  calibrationTotal: number;
  recordCalibrationSample: () => void;
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
  calibrationStep: 0,
  calibrationTotal: CALIBRATION_TARGETS.length,
  recordCalibrationSample: () => {},
});

export function useEyeTrackingDwell() {
  return useContext(EyeTrackingDwellContext);
}

// ─── Provider ────────────────────────────────────────────────────
interface Props {
  mode: DwellMode;
  dwellTimeMs: number;
  rawFaces: RawTrackedFace[];
  children: ReactNode;
}

const TICK_MS = 50;

export function EyeTrackingDwellProvider({ mode, dwellTimeMs, rawFaces, children }: Props) {
  const enabled = mode !== "off";
  const estimatorRef = useRef<GazeEstimator | null>(null);
  const [gazePosition, setGazePosition] = useState<GazePoint | null>(null);
  const [dwellTarget, setDwellTarget] = useState<DwellTarget | null>(null);
  const [isCalibrated, setIsCalibrated] = useState(false);

  // Calibration state (camera mode only)
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState(0);
  const calibrationSamplesRef = useRef<CalibrationSample[]>([]);
  const rawGazeSamplesRef = useRef<GazePoint[]>([]);

  // Dwell tracking refs
  const currentElementRef = useRef<HTMLElement | null>(null);
  const dwellStartRef = useRef<number>(0);
  const cooldownElementRef = useRef<HTMLElement | null>(null);
  const facesRef = useRef<RawTrackedFace[]>(rawFaces);

  // Mouse position ref (updated by mousemove listener, read by dwell interval)
  const mousePosRef = useRef<GazePoint | null>(null);

  useEffect(() => { facesRef.current = rawFaces; }, [rawFaces]);

  // Create estimator once
  useEffect(() => {
    const est = createGazeEstimator();
    estimatorRef.current = est;
    setIsCalibrated(est.isCalibrated());
  }, []);

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

  // ── Calibration (camera mode only) ──
  const startCalibration = useCallback(() => {
    if (mode !== "camera") return;
    calibrationSamplesRef.current = [];
    rawGazeSamplesRef.current = [];
    setCalibrationStep(0);
    setIsCalibrating(true);
  }, [mode]);

  const cancelCalibration = useCallback(() => {
    calibrationSamplesRef.current = [];
    rawGazeSamplesRef.current = [];
    setIsCalibrating(false);
    setCalibrationStep(0);
  }, []);

  const clearCalibration = useCallback(() => {
    estimatorRef.current?.clearCalibration();
    setIsCalibrated(false);
  }, []);

  const recordCalibrationSample = useCallback(() => {
    const est = estimatorRef.current;
    if (!est || !isCalibrating) return;

    const rawSamples = rawGazeSamplesRef.current;
    const target = CALIBRATION_TARGETS[calibrationStep];

    if (rawSamples.length > 0) {
      const avg: GazePoint = {
        x: rawSamples.reduce((s, p) => s + p.x, 0) / rawSamples.length,
        y: rawSamples.reduce((s, p) => s + p.y, 0) / rawSamples.length,
      };
      calibrationSamplesRef.current.push({
        raw: avg,
        target: { x: target.nx * window.innerWidth, y: target.ny * window.innerHeight },
      });
    }

    rawGazeSamplesRef.current = [];

    const nextStep = calibrationStep + 1;
    if (nextStep >= CALIBRATION_TARGETS.length) {
      if (calibrationSamplesRef.current.length >= 2) {
        est.applyCalibration(calibrationSamplesRef.current);
        setIsCalibrated(true);
      }
      setIsCalibrating(false);
      setCalibrationStep(0);
    } else {
      setCalibrationStep(nextStep);
    }
  }, [isCalibrating, calibrationStep]);

  // ── Shared dwell hit-test logic ──
  const runDwellHitTest = useCallback((point: GazePoint) => {
    const elements = document.elementsFromPoint(point.x, point.y);
    let dwellEl: HTMLElement | null = null;
    for (const el of elements) {
      const found = (el as HTMLElement).closest("[data-dwell]") as HTMLElement | null;
      if (found) {
        dwellEl = found;
        break;
      }
    }

    if (!dwellEl) {
      currentElementRef.current = null;
      cooldownElementRef.current = null;
      setDwellTarget(null);
      return;
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

      // ── Camera mode: use face tracking + gaze estimator ──
      const faces = facesRef.current;
      const est = estimatorRef.current;
      if (!est || faces.length === 0) {
        setGazePosition(null);
        setDwellTarget(null);
        currentElementRef.current = null;
        return;
      }

      const face = faces[0];

      // During calibration, collect raw samples but don't do dwell
      if (isCalibrating) {
        const raw = est.getRaw(face);
        if (raw) {
          rawGazeSamplesRef.current.push(raw);
          const smoothed = est.update(face);
          setGazePosition(smoothed);
        }
        setDwellTarget(null);
        return;
      }

      const point = est.update(face);
      if (!point) {
        setGazePosition(null);
        setDwellTarget(null);
        currentElementRef.current = null;
        return;
      }

      setGazePosition(point);
      runDwellHitTest(point);
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [enabled, mode, dwellTimeMs, isCalibrating, runDwellHitTest]);

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
        calibrationStep,
        calibrationTotal: CALIBRATION_TARGETS.length,
        recordCalibrationSample,
      }}
    >
      {children}
    </EyeTrackingDwellContext.Provider>
  );
}
