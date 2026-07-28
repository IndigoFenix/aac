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
import {
  detectionSatisfied,
  hardwareReadiness,
  hardwareSignalKey,
  shouldAttemptSwitch,
  type HardwareSignal,
} from "@/lib/eyegaze/detection-policy";

interface UseEyeGazeOptions {
  enabled: boolean;
  rawFaces: RawTrackedFace[];
  preferredProvider?: EyeGazeProviderType | "auto";
  /** Per-student smoothing settings (One-Euro + fixation, in visual degrees) for hardware trackers. */
  smoothingSettings?: GazeSmoothingSettings;
  /**
   * Live gaze-sidecar status, when the host has one. Used as a wake-up signal:
   * a new port or a transition to "connected" means retry NOW rather than
   * waiting out the backoff. Omit on hosts without a sidecar.
   */
  sidecarSignal?: HardwareSignal | null;
  /** Whether this host can spawn a sidecar at all (Electron/Windows only). */
  sidecarSupported?: boolean;
}

/**
 * How often the detection loop re-evaluates. Cheap — it only consults the
 * policy; actual probes are rate-limited by the backoff inside it.
 */
const DETECT_TICK_MS = 1000;

/**
 * Probe budget for a targeted upgrade to the student's chosen tracker. Longer
 * than the service default (500ms) because a cold sidecar needs ~1.5s to bind,
 * and this probe does not delay anything the student is currently using — the
 * fallback provider stays active until the upgrade actually succeeds.
 */
const UPGRADE_PROBE_MS = 2500;

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

export function useEyeGaze({
  enabled,
  rawFaces,
  preferredProvider = "auto",
  smoothingSettings,
  sidecarSignal = null,
  sidecarSupported = false,
}: UseEyeGazeOptions): UseEyeGazeReturn {
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

    // Detection itself lives in the re-detect loop below, which establishes a
    // baseline provider and then keeps trying to upgrade to the student's
    // choice. Kicking off autoDetectAndStart here as well would race it.
    setDetectionDone(false);

    return () => {
      service.offGaze(handler);
      // Clear it, don't just stop it: the detection loop below treats a
      // non-null active provider as "nothing to do", so a stopped-but-still-
      // referenced provider would never be restarted when gaze is re-enabled.
      service.deactivate();
      setGazePoint(null);
      setGazeData(null);
      setActiveProvider(null);
    };
  }, [enabled]);

  // ── Detection / re-detection ──
  //
  // Establish a baseline provider so the student always has *something* (the
  // mouse fallback matters: Tobii Computer Control drives the Windows pointer,
  // and that is a supported setup), then keep trying to upgrade to the tracker
  // their settings actually name.
  //
  // The upgrade loop never gives up. Its predecessor tried twice, 2s apart, and
  // then latched failedProvider forever, which stranded students on the mouse
  // whenever the sidecar was still cold — see detection-policy.ts for the field
  // evidence. Retries now back off but continue, and the backoff resets
  // whenever the sidecar reports a new port or reaches "connected".
  const hardwareReady = hardwareReadiness({
    preferred: preferredProvider,
    sidecarSupported,
    signal: sidecarSignal,
  });
  const signalKey = hardwareSignalKey(sidecarSignal);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !enabled) return;

    // Keep the service's notion of "preferred" current: it was constructed on
    // mount, before the student's settings loaded.
    service.setPreferredProvider(preferredProvider);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let lastAttemptAt = 0;

    // Only push a new statuses array when the active provider actually moved:
    // this loop keeps ticking on a machine with no tracker, and a fresh array
    // identity every time would re-render the whole page for nothing.
    let publishedActive: EyeGazeProviderType | null | undefined = undefined;
    const publish = () => {
      const active = service.getActiveProviderType();
      if (active !== publishedActive) {
        publishedActive = active;
        setActiveProvider(active);
        setProviderStatuses(service.getAllStatuses());
      }
      setDetectionDone(true);
      return active;
    };

    const tick = async () => {
      if (cancelled) return;

      // Baseline: whatever answers fastest, so gaze input works at all.
      if (service.getActiveProviderType() === null) {
        await service.autoDetectAndStart();
        if (cancelled) return;
        publish();
      }

      const active = service.getActiveProviderType();
      if (detectionSatisfied(preferredProvider, active)) {
        setFailedProvider(null);
        publish();
        return; // settled — stop ticking
      }

      const now = Date.now();
      if (
        shouldAttemptSwitch({
          enabled,
          preferred: preferredProvider,
          activeProvider: active,
          hardwareReady,
          attempts,
          lastAttemptAt,
          now,
        })
      ) {
        lastAttemptAt = now;
        attempts += 1;
        if (preferredProvider === "auto") {
          await service.autoDetectAndStart();
        } else {
          await service.switchProvider(preferredProvider, UPGRADE_PROBE_MS);
        }
        if (cancelled) return;

        const settled = publish();
        if (detectionSatisfied(preferredProvider, settled)) {
          setFailedProvider(null);
          return; // settled — stop ticking
        }
        // Surface the miss so the UI can say so, but keep trying: this is a
        // "not yet", not a verdict.
        setFailedProvider(preferredProvider === "auto" ? null : preferredProvider);
      }

      timer = setTimeout(() => { void tick(); }, DETECT_TICK_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [preferredProvider, enabled, hardwareReady, signalKey]);

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
