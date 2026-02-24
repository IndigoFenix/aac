// client-aac/src/hooks/useFaceTracking.ts
// Core MediaPipe FaceLandmarker hook - singleton loader, blendshape extraction

import { useState, useEffect, useRef, useCallback } from "react";
import type { FaceTrackingConfig, RawTrackedFace, BoundingBox } from "@/lib/faceTrackingTypes";
import { DEFAULT_FACE_TRACKING_CONFIG } from "@/lib/faceTrackingTypes";

// =============================================================================
// SINGLETON LOADER (same pattern as usePersonIdentification.ts)
// =============================================================================

let faceLandmarkerInstance: any = null;
let faceLandmarkerPromise: Promise<any> | null = null;
let faceLandmarkerError: Error | null = null;

async function loadFaceLandmarker(maxFaces: number): Promise<any> {
  if (faceLandmarkerInstance) return faceLandmarkerInstance;
  if (faceLandmarkerError) throw faceLandmarkerError;
  if (faceLandmarkerPromise) return faceLandmarkerPromise;

  faceLandmarkerPromise = (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const { FaceLandmarker, FilesetResolver } = vision;

      const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );

      faceLandmarkerInstance = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: maxFaces,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });

      console.log("[FaceTracking] FaceLandmarker initialized");
      return faceLandmarkerInstance;
    } catch (err) {
      faceLandmarkerError = err as Error;
      console.error("[FaceTracking] Failed to load FaceLandmarker:", err);
      throw err;
    }
  })();

  return faceLandmarkerPromise;
}

// =============================================================================
// HOOK
// =============================================================================

export interface UseFaceTrackingOptions {
  videoStream: MediaStream | null;
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
  const { videoStream, enabled = true, config: configOverrides } = options;

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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const landmarkerRef = useRef<any>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTimestampRef = useRef(0);

  // Create hidden video element and attach stream
  useEffect(() => {
    if (!videoStream || !enabled) {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
      return;
    }

    let video = videoRef.current;
    if (!video) {
      video = document.createElement("video");
      video.style.display = "none";
      video.playsInline = true;
      video.muted = true;
      document.body.appendChild(video);
      videoRef.current = video;
    }

    video.srcObject = videoStream;
    console.log("[FaceTracking] Attaching stream to hidden video, tracks:", videoStream.getVideoTracks().length);
    video.play().then(() => {
      console.log("[FaceTracking] Video playing, readyState:", video!.readyState, "dimensions:", video!.videoWidth, "x", video!.videoHeight);
    }).catch((err) => {
      console.warn("[FaceTracking] Video play error:", err);
    });

    return () => {
      // Don't remove from DOM on stream change, just stop
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
    };
  }, [videoStream, enabled]);

  // Cleanup video element on unmount
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
        videoRef.current.remove();
        videoRef.current = null;
      }
    };
  }, []);

  // Initialize FaceLandmarker
  useEffect(() => {
    if (!enabled) return;

    let mounted = true;

    async function init() {
      try {
        const landmarker = await loadFaceLandmarker(config.maxFaces);
        if (mounted) {
          landmarkerRef.current = landmarker;
          setIsReady(true);
          setError(null);
          console.log("[FaceTracking] Ready");
        }
      } catch (err: any) {
        if (mounted) {
          setError(err.message || "Failed to load face tracking model");
          setIsReady(false);
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [enabled, config.maxFaces]);

  // Run detection loop
  useEffect(() => {
    if (!isReady || !enabled || !videoStream) {
      console.log("[FaceTracking] Detection loop not starting:", { isReady, enabled, hasStream: !!videoStream });
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
      const video = videoRef.current;
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
  }, [isReady, enabled, videoStream, config.processingIntervalMs]);

  return { isReady, isProcessing, error, faces, fps };
}

export default useFaceTracking;
