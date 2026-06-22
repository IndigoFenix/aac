// client-aac/src/hooks/usePoseTracking.ts
// Core MediaPipe PoseLandmarker hook — singleton loader, raw 33-landmark output.
// Mirrors useFaceTracking / useHandGestureTracking; reads the shared user <video>
// (MultiCameraProvider) rather than owning one. Uses the LITE model + a slower
// cadence since pose is the heaviest of the three trackers running together.

import { useState, useEffect, useRef } from "react";
import type { PoseTrackingConfig, RawTrackedPose, PoseLandmark } from "@/lib/poseTrackingTypes";
import { DEFAULT_POSE_TRACKING_CONFIG } from "@/lib/poseTrackingTypes";

// =============================================================================
// SINGLETON LOADER (same pattern as useFaceTracking)
// =============================================================================

let poseLandmarkerInstance: any = null;
let poseLandmarkerPromise: Promise<any> | null = null;
let poseLandmarkerError: Error | null = null;

async function loadPoseLandmarker(maxPoses: number): Promise<any> {
  if (poseLandmarkerInstance) return poseLandmarkerInstance;
  if (poseLandmarkerError) throw poseLandmarkerError;
  if (poseLandmarkerPromise) return poseLandmarkerPromise;

  poseLandmarkerPromise = (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const { PoseLandmarker, FilesetResolver } = vision;

      const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm"
      );

      const createOptions = (delegate: "GPU" | "CPU") => ({
        baseOptions: {
          // LITE variant — cheapest; we only need coarse posture/movement.
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate,
        },
        runningMode: "VIDEO" as const,
        numPoses: maxPoses,
        outputSegmentationMasks: false,
      });

      try {
        poseLandmarkerInstance = await PoseLandmarker.createFromOptions(filesetResolver, createOptions("GPU"));
        console.log("[PoseTracking] PoseLandmarker initialized (GPU)");
      } catch (gpuErr) {
        console.warn("[PoseTracking] GPU delegate failed, falling back to CPU:", gpuErr);
        poseLandmarkerInstance = await PoseLandmarker.createFromOptions(filesetResolver, createOptions("CPU"));
        console.log("[PoseTracking] PoseLandmarker initialized (CPU fallback)");
      }

      return poseLandmarkerInstance;
    } catch (err) {
      poseLandmarkerError = err as Error;
      console.error("[PoseTracking] Failed to load PoseLandmarker:", err);
      throw err;
    }
  })();

  return poseLandmarkerPromise;
}

// =============================================================================
// HOOK
// =============================================================================

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

  const landmarkerRef = useRef<any>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameCountRef = useRef(0);
  const lastTimestampRef = useRef(0);

  // Initialize PoseLandmarker
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    (async () => {
      try {
        const landmarker = await loadPoseLandmarker(config.maxPoses);
        if (mounted) { landmarkerRef.current = landmarker; setIsReady(true); setError(null); }
      } catch (err: any) {
        if (mounted) { setError(err?.message || "Failed to load pose tracking model"); setIsReady(false); }
      }
    })();
    return () => { mounted = false; };
  }, [enabled, config.maxPoses]);

  // Detection loop
  useEffect(() => {
    if (!isReady || !enabled || !videoEl) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      setPoses([]);
      setFps(0);
      return;
    }

    const runDetection = () => {
      const video = videoEl;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || video.readyState < 2) return;
      const now = performance.now();
      if (now <= lastTimestampRef.current) return; // MediaPipe needs monotonic ts
      lastTimestampRef.current = now;

      try {
        const results = landmarker.detectForVideo(video, now);
        const raw: RawTrackedPose[] = [];
        const lmSets = results?.landmarks ?? [];
        for (let i = 0; i < lmSets.length; i++) {
          const landmarks: PoseLandmark[] = lmSets[i].map((p: any) => ({ x: p.x, y: p.y, visibility: p.visibility }));
          raw.push({ poseIndex: i, landmarks });
        }
        setPoses(raw);
        frameCountRef.current++;
      } catch {
        // Silent per-frame failures (same as face/hand).
      }
    };

    intervalRef.current = setInterval(runDetection, config.processingIntervalMs);
    fpsTimerRef.current = setInterval(() => { setFps(frameCountRef.current); frameCountRef.current = 0; }, 1000);

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (fpsTimerRef.current) { clearInterval(fpsTimerRef.current); fpsTimerRef.current = null; }
    };
  }, [isReady, enabled, videoEl, config.processingIntervalMs]);

  return { isReady, error, poses, fps };
}

export default usePoseTracking;
