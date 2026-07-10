// client-aac/src/hooks/useEyeGaze.ts
// React bridge for the unified EyeGazeService.
// Creates/destroys the service, registers providers, feeds face data, exposes gaze state.

import { useEffect, useRef, useState, useCallback } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import type { CalibrationSample } from "@/lib/gazeEstimator";
import { EyeGazeService } from "@/lib/eyegaze/eyegaze-service";
import { CameraGazeProvider } from "@/lib/eyegaze/camera-provider";
import { MouseGazeProvider } from "@/lib/eyegaze/mouse-provider";
import { createTobiiProvider, createEyeTechProvider, createLCTechProvider, createGazepointProvider } from "@/lib/eyegaze/websocket-bridge-provider";
import { WebHIDGazeProvider } from "@/lib/eyegaze/webhid-provider";
import type { GazeData, GazePoint, EyeGazeProviderType, EyeGazeProviderStatus } from "@/lib/eyegaze/types";
import { smoothingConfigForStrength, DEFAULT_SMOOTHING_STRENGTH, type GazeSmoothingStrength } from "@shared/gaze-smoothing.js";

interface UseEyeGazeOptions {
  enabled: boolean;
  rawFaces: RawTrackedFace[];
  preferredProvider?: EyeGazeProviderType | "auto";
  /** Per-student pixel-space smoothing strength for hardware trackers. */
  smoothingStrength?: GazeSmoothingStrength;
}

// Samples below this confidence don't move the gaze point. Providers signal
// "no eyes found" through confidence: camera emits 0 when the face is lost
// (0.7 when tracking), Tobii forwards its validity field (0 when invalid).
// The dwell layer then sees the point go stale and suspends selection.
const MIN_GAZE_CONFIDENCE = 0.3;

interface UseEyeGazeReturn {
  gazePoint: GazePoint | null;
  gazeData: GazeData | null;
  activeProvider: EyeGazeProviderType | null;
  providerStatuses: EyeGazeProviderStatus[];
  supportsCalibration: boolean;
  isCalibrated: boolean;
  /** Provider the user selected that failed to connect (null if ok or auto) */
  failedProvider: EyeGazeProviderType | null;
  detectionDone: boolean;
  switchProvider: (type: EyeGazeProviderType) => Promise<boolean>;
  // Camera calibration pass-through
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  clearCalibration: () => void;
}

export function useEyeGaze({ enabled, rawFaces, preferredProvider = "auto", smoothingStrength = DEFAULT_SMOOTHING_STRENGTH }: UseEyeGazeOptions): UseEyeGazeReturn {
  // Track whether auto-detection has finished (prevents premature calibration)
  const [detectionDone, setDetectionDone] = useState(false);
  const serviceRef = useRef<EyeGazeService | null>(null);
  const cameraProviderRef = useRef<CameraGazeProvider | null>(null);

  const [gazePoint, setGazePoint] = useState<GazePoint | null>(null);
  const [gazeData, setGazeData] = useState<GazeData | null>(null);
  const [activeProvider, setActiveProvider] = useState<EyeGazeProviderType | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<EyeGazeProviderStatus[]>([]);
  const [isCalibrated, setIsCalibrated] = useState(false);
  const [failedProvider, setFailedProvider] = useState<EyeGazeProviderType | null>(null);

  // Create service + register providers (once)
  useEffect(() => {
    const camera = new CameraGazeProvider();
    const mouse = new MouseGazeProvider();
    cameraProviderRef.current = camera;

    const service = new EyeGazeService({ preferredProvider });
    // Register all providers — auto-detect will probe in priority order
    service.registerProvider(createTobiiProvider());
    service.registerProvider(createEyeTechProvider());
    service.registerProvider(createLCTechProvider());
    service.registerProvider(createGazepointProvider());
    service.registerProvider(new WebHIDGazeProvider());
    service.registerProvider(camera);
    service.registerProvider(mouse);
    serviceRef.current = service;

    setIsCalibrated(camera.isCalibrated());

    return () => {
      service.destroy();
      serviceRef.current = null;
      cameraProviderRef.current = null;
    };
    // preferredProvider intentionally excluded — handled by switchProvider / re-detect
     
  }, []);

  // Push smoothing strength to hardware providers whenever it changes. Runs
  // after the create-effect registers providers; also re-applies when a
  // provider is (re)activated since the config lives on the provider instance.
  useEffect(() => {
    serviceRef.current?.setSmoothing(smoothingConfigForStrength(smoothingStrength));
  }, [smoothingStrength, activeProvider]);

  // Feed rawFaces to camera provider (ref-based, no re-render)
  const facesRef = useRef(rawFaces);
  facesRef.current = rawFaces;
  useEffect(() => {
    cameraProviderRef.current?.setFaces(rawFaces);
  }, [rawFaces]);

  // Subscribe to gaze data when enabled
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;

    if (!enabled) {
      // Stop active provider
      const active = service.getActiveProvider();
      if (active) {
        active.stop();
        service.offGaze(() => {});
      }
      setGazePoint(null);
      setGazeData(null);
      setActiveProvider(null);
      return;
    }

    const handler = (data: GazeData) => {
      setGazeData(data);
      if (data.confidence >= MIN_GAZE_CONFIDENCE) setGazePoint(data.point);
    };
    service.onGaze(handler);

    // Auto-detect and start
    setDetectionDone(false);
    service.autoDetectAndStart().then((type) => {
      setActiveProvider(type);
      setProviderStatuses(service.getAllStatuses());
      setDetectionDone(true);
    });

    return () => {
      service.offGaze(handler);
      const active = service.getActiveProvider();
      if (active) active.stop();
      setGazePoint(null);
      setGazeData(null);
      setActiveProvider(null);
    };
  }, [enabled]);

  // Update preferred provider when it changes
  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !enabled || preferredProvider === "auto") return;

    let cancelled = false;

    // Try switching to the preferred provider, with a retry for slow devices
    const trySwitch = async () => {
      const ok = await service.switchProvider(preferredProvider);
      if (cancelled) return;
      if (ok) {
        setActiveProvider(preferredProvider);
        setFailedProvider(null);
        setProviderStatuses(service.getAllStatuses());
        setDetectionDone(true);
        return;
      }

      // First attempt failed — retry after 2s (device may still be starting)
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled) return;

      const retryOk = await service.switchProvider(preferredProvider);
      if (cancelled) return;
      if (retryOk) {
        setActiveProvider(preferredProvider);
        setFailedProvider(null);
      } else {
        setFailedProvider(preferredProvider);
      }
      setProviderStatuses(service.getAllStatuses());
      setDetectionDone(true);
    };

    trySwitch();
    return () => { cancelled = true; };
  }, [preferredProvider, enabled]);

  const switchProvider = useCallback(async (type: EyeGazeProviderType): Promise<boolean> => {
    const service = serviceRef.current;
    if (!service) return false;
    const ok = await service.switchProvider(type);
    if (ok) {
      setActiveProvider(type);
      setProviderStatuses(service.getAllStatuses());
    }
    return ok;
  }, []);

  // Only offer calibration when: detection is done, camera is actually active,
  // AND the user explicitly chose camera (not "auto"). When on "auto", the camera
  // may win detection simply because external devices probe slower — auto-calibrating
  // would be disruptive for users with hardware eye trackers that control the cursor.
  const supportsCalibration = detectionDone && activeProvider === "camera" && preferredProvider === "camera";

  // Calibration pass-through
  const getRawGaze = useCallback((): GazePoint | null => {
    return cameraProviderRef.current?.getRawGaze() ?? null;
  }, []);

  const applyCalibration = useCallback((samples: CalibrationSample[]) => {
    cameraProviderRef.current?.applyCalibration(samples);
    setIsCalibrated(true);
  }, []);

  const clearCalibration = useCallback(() => {
    cameraProviderRef.current?.clearCalibration();
    setIsCalibrated(false);
  }, []);

  return {
    gazePoint,
    gazeData,
    activeProvider,
    providerStatuses,
    supportsCalibration,
    isCalibrated,
    failedProvider,
    detectionDone,
    switchProvider,
    getRawGaze,
    applyCalibration,
    clearCalibration,
  };
}
