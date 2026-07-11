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
import { smootherConfigFromSettings, defaultSmoothingSettings, type GazeSmoothingSettings } from "@shared/gaze-smoothing.js";
import { computePixelsPerDegree, primaryFaceHeightNorm } from "@/lib/eyegaze/viewing-distance";

interface UseEyeGazeOptions {
  enabled: boolean;
  rawFaces: RawTrackedFace[];
  preferredProvider?: EyeGazeProviderType | "auto";
  /** Per-student smoothing settings (One-Euro + fixation, in visual degrees) for hardware trackers. */
  smoothingSettings?: GazeSmoothingSettings;
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

export function useEyeGaze({ enabled, rawFaces, preferredProvider = "auto", smoothingSettings }: UseEyeGazeOptions): UseEyeGazeReturn {
  // Resolve to a stable default when the caller omits settings.
  const settings = smoothingSettings ?? defaultSmoothingSettings();
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

  // Viewing geometry: the smoother reasons in degrees of visual angle, so it
  // needs pixels-per-degree. We derive it from the face bounding-box size
  // (a camera-distance proxy) and the student's distance settings, live.
  const lastFaceHeightRef = useRef<number | null>(null);
  const ppdRef = useRef<number>(computePixelsPerDegree(null, settings));
  const emaPpdRef = useRef<number | null>(null);

  // A value-based key so new settings-object identities (same values) don't
  // churn the effects below.
  const settingsKey = JSON.stringify(settings);

  // Push smoothing config + current geometry whenever the settings change. Also
  // re-applies when a provider is (re)activated since the config lives on the
  // provider instance.
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;
    const ppd = computePixelsPerDegree(lastFaceHeightRef.current, settings);
    ppdRef.current = ppd;
    emaPpdRef.current = ppd;
    service.setSmoothing(smootherConfigFromSettings(settings, ppd));
    service.setPixelsPerDegree(ppd);
  }, [settingsKey, activeProvider]);

  // Track face size → viewing distance → pixels-per-degree, pushed live to the
  // hardware smoother (no filter reset). EMA-smoothed and only pushed on a
  // meaningful change so ppd jitter can't feed back into the gaze stream.
  useEffect(() => {
    const h = primaryFaceHeightNorm(rawFaces);
    if (h != null) lastFaceHeightRef.current = h;
    // Fixed-distance mode has no face dependence; the settings effect set it.
    if (settings.preset === "off" || settings.distanceMode !== "face") return;
    const target = computePixelsPerDegree(lastFaceHeightRef.current, settings);
    const prev = emaPpdRef.current ?? target;
    const next = prev + 0.25 * (target - prev);
    emaPpdRef.current = next;
    if (ppdRef.current <= 0 || Math.abs(next - ppdRef.current) / ppdRef.current > 0.02) {
      ppdRef.current = next;
      serviceRef.current?.setPixelsPerDegree(next);
    }
  }, [rawFaces, settingsKey, activeProvider]);

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
