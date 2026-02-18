// client-aac/src/hooks/useEyeGaze.ts
// React bridge for the unified EyeGazeService.
// Creates/destroys the service, registers providers, feeds face data, exposes gaze state.

import { useEffect, useRef, useState, useCallback } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import type { CalibrationSample } from "@/lib/gazeEstimator";
import { EyeGazeService } from "@/lib/eyegaze/eyegaze-service";
import { CameraGazeProvider } from "@/lib/eyegaze/camera-provider";
import { MouseGazeProvider } from "@/lib/eyegaze/mouse-provider";
import { createTobiiProvider, createEyeTechProvider, createLCTechProvider } from "@/lib/eyegaze/websocket-bridge-provider";
import { WebHIDGazeProvider } from "@/lib/eyegaze/webhid-provider";
import type { GazeData, GazePoint, EyeGazeProviderType, EyeGazeProviderStatus } from "@/lib/eyegaze/types";

interface UseEyeGazeOptions {
  enabled: boolean;
  rawFaces: RawTrackedFace[];
  preferredProvider?: EyeGazeProviderType | "auto";
}

interface UseEyeGazeReturn {
  gazePoint: GazePoint | null;
  gazeData: GazeData | null;
  activeProvider: EyeGazeProviderType | null;
  providerStatuses: EyeGazeProviderStatus[];
  supportsCalibration: boolean;
  isCalibrated: boolean;
  switchProvider: (type: EyeGazeProviderType) => Promise<boolean>;
  // Camera calibration pass-through
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  clearCalibration: () => void;
}

export function useEyeGaze({ enabled, rawFaces, preferredProvider = "auto" }: UseEyeGazeOptions): UseEyeGazeReturn {
  const serviceRef = useRef<EyeGazeService | null>(null);
  const cameraProviderRef = useRef<CameraGazeProvider | null>(null);

  const [gazePoint, setGazePoint] = useState<GazePoint | null>(null);
  const [gazeData, setGazeData] = useState<GazeData | null>(null);
  const [activeProvider, setActiveProvider] = useState<EyeGazeProviderType | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<EyeGazeProviderStatus[]>([]);
  const [isCalibrated, setIsCalibrated] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setGazePoint(data.point);
      setGazeData(data);
    };
    service.onGaze(handler);

    // Auto-detect and start
    service.autoDetectAndStart().then((type) => {
      setActiveProvider(type);
      setProviderStatuses(service.getAllStatuses());
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

    service.switchProvider(preferredProvider).then((ok) => {
      if (ok) {
        setActiveProvider(preferredProvider);
        setProviderStatuses(service.getAllStatuses());
      }
    });
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

  const supportsCalibration = activeProvider === "camera";

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
    switchProvider,
    getRawGaze,
    applyCalibration,
    clearCalibration,
  };
}
