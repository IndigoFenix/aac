// client-aac/src/hooks/usePoseTracking.ts
// MediaPipe PoseLandmarker hook — raw 33-landmark output. Reads the shared user
// <video> (MultiCameraProvider) rather than owning one. Inference runs OFF the
// main thread via the shared vision worker (lib/visionWorkerClient.ts), with a
// transparent main-thread fallback if the worker is unavailable — so the heavy
// detect no longer stalls rAF (which made the 3D game choppy). Public API
// unchanged. Uses the LITE model + slower cadence (heaviest of the three trackers).

import { useState, useEffect, useRef } from "react";
import type { PoseTrackingConfig, RawTrackedPose, PoseLandmark } from "@/lib/poseTrackingTypes";
import { DEFAULT_POSE_TRACKING_CONFIG } from "@/lib/poseTrackingTypes";
import { acquireVisionTask, type VisionTaskHandle } from "@/lib/visionWorkerClient";

export interface UsePoseTrackingOptions {
  videoEl: HTMLVideoElement | null;
  enabled?: boolean;
  config?: Partial<PoseTrackingConfig>;
}

export interface UsePoseTrackingReturn {
  isReady: boolean;
  error: string | null;
  poses: RawTrackedPose[];
  fps: number;
}

export function usePoseTracking(options: UsePoseTrackingOptions): UsePoseTrackingReturn {
  const { videoEl, enabled = true, config: configOverrides } = options;

  const config: PoseTrackingConfig = {
    ...DEFAULT_POSE_TRACKING_CONFIG,
    ...configOverrides,
    thresholds: { ...DEFAULT_POSE_TRACKING_CONFIG.thresholds, ...configOverrides?.thresholds },
    refireIntervals: { ...DEFAULT_POSE_TRACKING_CONFIG.refireIntervals, ...configOverrides?.refireIntervals },
  };

  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poses, setPoses] = useState<RawTrackedPose[]>([]);
  const [fps, setFps] = useState(0);

  const handleRef = useRef<VisionTaskHandle | null>(null);
  const frameCountRef = useRef(0);

  // Acquire / release the shared pose task (loads in the worker, else main thread).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const handle = acquireVisionTask("pose", { numEntities: config.maxPoses });
    handleRef.current = handle;
    handle.whenReady().then((ok) => {
      if (cancelled) return;
      setIsReady(ok);
      setError(ok ? null : "Failed to load pose tracking model");
    });
    return () => {
      cancelled = true;
      handle.release();
      handleRef.current = null;
      setIsReady(false);
    };
  }, [enabled, config.maxPoses]);

  // Detection loop — drives the shared handle; the worker (or main-thread
  // fallback) returns the same plain result, mapped here exactly as before.
  useEffect(() => {
    if (!enabled || !videoEl) {
      setPoses([]);
      setFps(0);
      return;
    }
    let stopped = false;

    const tick = () => {
      const handle = handleRef.current;
      const video = videoEl;
      if (!handle || !handle.isReady() || video.readyState < 2) return;
      handle.detect(video, performance.now()).then((results) => {
        if (stopped || !results) return;
        const raw: RawTrackedPose[] = [];
        const lmSets = results.landmarks ?? [];
        for (let i = 0; i < lmSets.length; i++) {
          const landmarks: PoseLandmark[] = lmSets[i].map((p: any) => ({ x: p.x, y: p.y, visibility: p.visibility }));
          raw.push({ poseIndex: i, landmarks });
        }
        setPoses(raw);
        frameCountRef.current++;
      }).catch(() => { /* per-frame failures are non-fatal */ });
    };

    const interval = setInterval(tick, config.processingIntervalMs);
    const fpsTimer = setInterval(() => { setFps(frameCountRef.current); frameCountRef.current = 0; }, 1000);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(fpsTimer);
    };
  }, [enabled, videoEl, config.processingIntervalMs]);

  return { isReady, error, poses, fps };
}

export default usePoseTracking;
