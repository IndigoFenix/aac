// client-aac/src/hooks/useHandGestureTracking.ts
// Core MediaPipe GestureRecognizer hook - singleton loader, gesture + landmark extraction

import { useState, useEffect, useRef } from "react";
import type { HandGestureConfig, RawTrackedHand, HandLandmark } from "@/lib/handGestureTypes";
import { DEFAULT_HAND_GESTURE_CONFIG, MEDIAPIPE_GESTURE_MAP } from "@/lib/handGestureTypes";

// =============================================================================
// SINGLETON LOADER
// =============================================================================

let gestureRecognizerInstance: any = null;
let gestureRecognizerPromise: Promise<any> | null = null;
let gestureRecognizerError: Error | null = null;
let currentSignLanguageModelUrl: string | null = null;

async function loadGestureRecognizer(
  maxHands: number,
  signLanguageModelUrl: string | null
): Promise<any> {
  // If sign language URL changed, close old instance and re-create
  if (gestureRecognizerInstance && currentSignLanguageModelUrl !== signLanguageModelUrl) {
    console.log("[HandGesture] Sign language model URL changed, re-creating recognizer");
    try {
      gestureRecognizerInstance.close();
    } catch (_) {
      // ignore close errors
    }
    gestureRecognizerInstance = null;
    gestureRecognizerPromise = null;
    gestureRecognizerError = null;
  }

  if (gestureRecognizerInstance) return gestureRecognizerInstance;
  if (gestureRecognizerError) throw gestureRecognizerError;
  if (gestureRecognizerPromise) return gestureRecognizerPromise;

  gestureRecognizerPromise = (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const { GestureRecognizer, FilesetResolver } = vision;

      const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );

      const buildOptions = (delegate: "GPU" | "CPU") => {
        const opts: any = {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate,
          },
          runningMode: "VIDEO",
          numHands: maxHands,
        };

        if (signLanguageModelUrl) {
          opts.customGesturesClassifierOptions = {
            modelAssetPath: signLanguageModelUrl,
          };
          console.log("[HandGesture] Loading with sign language model:", signLanguageModelUrl);
        }

        return opts;
      };

      try {
        gestureRecognizerInstance = await GestureRecognizer.createFromOptions(
          filesetResolver,
          buildOptions("GPU")
        );
        console.log("[HandGesture] GestureRecognizer initialized (GPU)");
      } catch (gpuErr) {
        console.warn("[HandGesture] GPU delegate failed, falling back to CPU:", gpuErr);
        gestureRecognizerInstance = await GestureRecognizer.createFromOptions(
          filesetResolver,
          buildOptions("CPU")
        );
        console.log("[HandGesture] GestureRecognizer initialized (CPU fallback)");
      }

      currentSignLanguageModelUrl = signLanguageModelUrl;
      return gestureRecognizerInstance;
    } catch (err) {
      gestureRecognizerError = err as Error;
      console.error("[HandGesture] Failed to load GestureRecognizer:", err);
      throw err;
    }
  })();

  return gestureRecognizerPromise;
}

// =============================================================================
// HOOK
// =============================================================================

export interface UseHandGestureTrackingOptions {
  videoStream: MediaStream | null;
  enabled?: boolean;
  config?: Partial<HandGestureConfig>;
}

export interface UseHandGestureTrackingReturn {
  isReady: boolean;
  isProcessing: boolean;
  error: string | null;
  hands: RawTrackedHand[];
  fps: number;
}

export function useHandGestureTracking(
  options: UseHandGestureTrackingOptions
): UseHandGestureTrackingReturn {
  const { videoStream, enabled = true, config: configOverrides } = options;

  const config: HandGestureConfig = {
    ...DEFAULT_HAND_GESTURE_CONFIG,
    ...configOverrides,
    thresholds: {
      ...DEFAULT_HAND_GESTURE_CONFIG.thresholds,
      ...configOverrides?.thresholds,
    },
    refireIntervals: {
      ...DEFAULT_HAND_GESTURE_CONFIG.refireIntervals,
      ...configOverrides?.refireIntervals,
    },
  };

  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hands, setHands] = useState<RawTrackedHand[]>([]);
  const [fps, setFps] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recognizerRef = useRef<any>(null);
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
    console.log(
      "[HandGesture] Attaching stream to hidden video, tracks:",
      videoStream.getVideoTracks().length
    );
    video
      .play()
      .then(() => {
        console.log(
          "[HandGesture] Video playing, readyState:",
          video!.readyState,
          "dimensions:",
          video!.videoWidth,
          "x",
          video!.videoHeight
        );
      })
      .catch((err) => {
        console.warn("[HandGesture] Video play error:", err);
      });

    return () => {
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

  // Initialize GestureRecognizer
  useEffect(() => {
    if (!enabled) return;

    let mounted = true;

    async function init() {
      try {
        const recognizer = await loadGestureRecognizer(
          config.maxHands,
          config.signLanguageModelUrl
        );
        if (mounted) {
          recognizerRef.current = recognizer;
          setIsReady(true);
          setError(null);
          console.log("[HandGesture] Ready");
        }
      } catch (err: any) {
        if (mounted) {
          setError(err.message || "Failed to load hand gesture model");
          setIsReady(false);
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [enabled, config.maxHands, config.signLanguageModelUrl]);

  // Run detection loop
  useEffect(() => {
    if (!isReady || !enabled || !videoStream) {
      console.log("[HandGesture] Detection loop not starting:", {
        isReady,
        enabled,
        hasStream: !!videoStream,
      });
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setHands([]);
      setFps(0);
      return;
    }

    console.log("[HandGesture] Starting detection loop");

    const runDetection = () => {
      const video = videoRef.current;
      const recognizer = recognizerRef.current;
      if (!video || !recognizer || video.readyState < 2) return;

      // MediaPipe requires monotonically increasing timestamps
      const now = performance.now();
      if (now <= lastTimestampRef.current) return;
      lastTimestampRef.current = now;

      setIsProcessing(true);

      try {
        const results = recognizer.recognizeForVideo(video, now);
        const rawHands: RawTrackedHand[] = [];

        if (results.landmarks && results.landmarks.length > 0) {
          for (let i = 0; i < results.landmarks.length; i++) {
            // Extract landmarks
            const landmarks: HandLandmark[] = results.landmarks[i].map(
              (lm: any) => ({
                x: lm.x,
                y: lm.y,
                z: lm.z,
              })
            );

            // Extract handedness
            let handedness: "Left" | "Right" = "Right";
            if (
              results.handedness &&
              results.handedness[i] &&
              results.handedness[i].length > 0
            ) {
              const label = results.handedness[i][0].categoryName;
              handedness = label === "Left" ? "Left" : "Right";
            }

            // Extract built-in gesture
            let gesture: string | null = null;
            let gestureConfidence = 0;
            if (
              results.gestures &&
              results.gestures[i] &&
              results.gestures[i].length > 0
            ) {
              const topGesture = results.gestures[i][0];
              if (topGesture.categoryName !== "None") {
                gesture = topGesture.categoryName;
                gestureConfidence = topGesture.score;
              }
            }

            // Extract custom/sign language gesture if available
            // Custom gestures appear after built-in gestures in the results
            let signLanguageGesture: string | null = null;
            let signLanguageConfidence = 0;
            if (
              results.gestures &&
              results.gestures[i] &&
              results.gestures[i].length > 1
            ) {
              // Check subsequent gesture entries for custom model results
              for (let g = 1; g < results.gestures[i].length; g++) {
                const entry = results.gestures[i][g];
                if (
                  entry.categoryName !== "None" &&
                  !MEDIAPIPE_GESTURE_MAP[entry.categoryName]
                ) {
                  signLanguageGesture = entry.categoryName;
                  signLanguageConfidence = entry.score;
                  break;
                }
              }
            }

            rawHands.push({
              handIndex: i,
              handedness,
              landmarks,
              gesture,
              gestureConfidence,
              signLanguageGesture,
              signLanguageConfidence,
            });
          }
        }

        setHands(rawHands);
        frameCountRef.current++;
      } catch (_) {
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

  return { isReady, isProcessing, error, hands, fps };
}

export default useHandGestureTracking;
