// client-aac/src/hooks/useFaceTracking.ts
// Core MediaPipe FaceLandmarker hook - singleton loader, blendshape extraction

import { useState, useEffect, useRef, useCallback } from "react";
import type { FaceTrackingConfig, RawTrackedFace, BoundingBox } from "@/lib/faceTrackingTypes";
import { DEFAULT_FACE_TRACKING_CONFIG } from "@/lib/faceTrackingTypes";
import { createModelLoader, type ModelLoader } from "@/lib/modelLoader";
import { createRawVisionTask, visionAssetSources } from "@/lib/visionTasks";

// =============================================================================
// SHARED LOADER (retrying — see lib/modelLoader.ts)
// =============================================================================

// Assets load self-hosted-first with a CDN fallback (visionTasks.ts). The old
// singleton fetched CDN-only AND cached the first error forever, which is why
// the FaceMirror would "randomly" stay blank for a whole session; the
// retrying loader recovers as soon as a source is reachable again.

let faceLoader: ModelLoader<any> | null = null;

/** Shared FaceLandmarker loader (raw instance — detectForVideo). maxFaces is
 *  baked in on first call (all current consumers use the default); later
 *  calls reuse the same instance. */
export function getFaceLandmarkerLoader(
  maxFaces: number = DEFAULT_FACE_TRACKING_CONFIG.maxFaces,
): ModelLoader<any> {
  if (faceLoader) return faceLoader;
  faceLoader = createModelLoader("face-landmarker", async () => {
    const inst = await createRawVisionTask("face", {
      numEntities: maxFaces,
      assetSources: visionAssetSources("face"),
    });
    console.log("[FaceTracking] FaceLandmarker initialized");
    return inst;
  });
  return faceLoader;
}

// =============================================================================
// HOOK
// =============================================================================

export interface UseFaceTrackingOptions {
  /**
   * The shared hidden <video> element playing the user camera (from
   * MultiCameraProvider's `userVideoEl`). This hook no longer creates its own
   * element — multiple <video> elements on one MediaStream freeze on iOS.
   */
  videoEl: HTMLVideoElement | null;
  enabled?: boolean;
  config?: Partial<FaceTrackingConfig>;
}

export interface UseFaceTrackingReturn {
  isReady: boolean;
  isProcessing: boolean;
  error: string | null;
  faces: RawTrackedFace[];
  fps: number;
}

export function useFaceTracking(options: UseFaceTrackingOptions): UseFaceTrackingReturn {
  const { videoEl, enabled = true, config: configOverrides } = options;

  const config: FaceTrackingConfig = {
    ...DEFAULT_FACE_TRACKING_CONFIG,
    ...configOverrides,
    thresholds: {
      ...DEFAULT_FACE_TRACKING_CONFIG.thresholds,
      ...configOverrides?.thresholds,
    },
    refireIntervals: {
      ...DEFAULT_FACE_TRACKING_CONFIG.refireIntervals,
      ...configOverrides?.refireIntervals,
    },
  };

  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [faces, setFaces] = useState<RawTrackedFace[]>([]);
  const [fps, setFps] = useState(0);

  const landmarkerRef = useRef<any>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTimestampRef = useRef(0);

  // NOTE: this hook no longer owns a <video> element. It reads frames from the
  // shared `videoEl` provided by MultiCameraProvider. See useMultiCamera.tsx.

  // Initialize FaceLandmarker. get() resolves whenever the load lands —
  // including after mid-session retries — so tracking self-heals; the status
  // subscription surfaces the error string while retries are still going.
  useEffect(() => {
    if (!enabled) return;

    let mounted = true;
    const loader = getFaceLandmarkerLoader(config.maxFaces);

    loader.get().then((landmarker) => {
      if (!mounted) return;
      landmarkerRef.current = landmarker;
      setIsReady(true);
      setError(null);
      console.log("[FaceTracking] Ready");
    });

    const unsubscribe = loader.subscribe((st) => {
      if (!mounted || st.state !== "error") return;
      setError(st.lastError || "Failed to load face tracking model");
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [enabled, config.maxFaces]);

  // Run detection loop
  useEffect(() => {
    if (!isReady || !enabled || !videoEl) {
      console.log("[FaceTracking] Detection loop not starting:", { isReady, enabled, hasVideo: !!videoEl });
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setFaces([]);
      setFps(0);
      return;
    }

    console.log("[FaceTracking] Starting detection loop");

    const runDetection = () => {
      const video = videoEl;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || video.readyState < 2) return;

      // MediaPipe requires monotonically increasing timestamps
      const now = performance.now();
      if (now <= lastTimestampRef.current) return;
      lastTimestampRef.current = now;

      setIsProcessing(true);

      try {
        const results = landmarker.detectForVideo(video, now);

        const rawFaces: RawTrackedFace[] = [];

        if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
          for (let i = 0; i < results.faceBlendshapes.length; i++) {
            const blendshapeMap = new Map<string, number>();
            const categories = results.faceBlendshapes[i].categories;

            for (const cat of categories) {
              blendshapeMap.set(cat.categoryName, cat.score);
            }

            // Extract bounding box from landmarks if available
            let boundingBox: BoundingBox | null = null;
            if (results.faceLandmarks && results.faceLandmarks[i]) {
              const landmarks = results.faceLandmarks[i];
              let minX = 1, minY = 1, maxX = 0, maxY = 0;
              for (const lm of landmarks) {
                if (lm.x < minX) minX = lm.x;
                if (lm.y < minY) minY = lm.y;
                if (lm.x > maxX) maxX = lm.x;
                if (lm.y > maxY) maxY = lm.y;
              }
              boundingBox = {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
              };
            }

            // Extract nose tip and head pose from landmarks
            let noseTip: { x: number; y: number } | null = null;
            let headPose: { yaw: number; pitch: number; roll: number } | null = null;
            if (results.faceLandmarks && results.faceLandmarks[i]) {
              const lms = results.faceLandmarks[i];
              const lm4 = lms[4]; // nose tip
              if (lm4) {
                noseTip = { x: lm4.x, y: lm4.y };
              }

              // Head pose from landmark asymmetry
              // #234 = right face edge, #454 = left face edge, #10 = forehead, #152 = chin
              const rFace = lms[234];
              const lFace = lms[454];
              const top = lms[10];
              const bottom = lms[152];
              if (lm4 && rFace && lFace && top && bottom) {
                const dLeft = Math.abs(lm4.x - lFace.x);
                const dRight = Math.abs(lm4.x - rFace.x);
                const dUp = Math.abs(lm4.y - top.y);
                const dDown = Math.abs(lm4.y - bottom.y);
                const hSum = dLeft + dRight;
                const vSum = dUp + dDown;
                if (hSum > 0 && vSum > 0) {
                  // Roll (sideways head tilt) from angle of face-edge line
                  // positive = tilted right (person's right ear down)
                  const roll = Math.atan2(rFace.y - lFace.y, lFace.x - rFace.x);
                  headPose = {
                    yaw: (dLeft - dRight) / hSum,   // +right, -left (person perspective)
                    pitch: (dUp - dDown) / vSum,     // +down, -up
                    roll,                            // radians, +right tilt, -left tilt
                  };
                }
              }
            }

            rawFaces.push({
              faceIndex: i,
              boundingBox,
              blendshapes: blendshapeMap,
              noseTip,
              headPose,
            });
          }
        }

        setFaces(rawFaces);
        frameCountRef.current++;
      } catch (err) {
        // Silent fail on individual frame errors
      } finally {
        setIsProcessing(false);
      }
    };

    intervalRef.current = setInterval(runDetection, config.processingIntervalMs);

    // FPS counter
    fpsTimerRef.current = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (fpsTimerRef.current) {
        clearInterval(fpsTimerRef.current);
        fpsTimerRef.current = null;
      }
    };
  }, [isReady, enabled, videoEl, config.processingIntervalMs]);

  return { isReady, isProcessing, error, faces, fps };
}

export default useFaceTracking;
