// client-aac/src/hooks/useHandGestureTracking.ts
// MediaPipe GestureRecognizer hook — gesture + landmark + sign-language output.
// Inference runs OFF the main thread via the shared vision worker
// (lib/visionWorkerClient.ts), with a transparent main-thread fallback if the
// worker is unavailable. Public API unchanged. Reads the shared user <video>
// (MultiCameraProvider). A sign-language model change re-acquires the task (the
// worker reloads the recognizer with the custom classifier).

import { useState, useEffect, useRef } from "react";
import type { HandGestureConfig, RawTrackedHand, HandLandmark } from "@/lib/handGestureTypes";
import { DEFAULT_HAND_GESTURE_CONFIG, MEDIAPIPE_GESTURE_MAP } from "@/lib/handGestureTypes";
import { acquireVisionTask, type VisionTaskHandle } from "@/lib/visionWorkerClient";

export interface UseHandGestureTrackingOptions {
  /**
   * The shared hidden <video> element playing the user camera (from
   * MultiCameraProvider's `userVideoEl`). This hook no longer creates its own
   * element — multiple <video> elements on one MediaStream freeze on iOS.
   */
  videoEl: HTMLVideoElement | null;
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
  const { videoEl, enabled = true, config: configOverrides } = options;

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

  const handleRef = useRef<VisionTaskHandle | null>(null);
  const frameCountRef = useRef(0);

  // Acquire / release the shared hand task. A maxHands or sign-language-model
  // change re-runs this effect → release + re-acquire → the worker reloads the
  // recognizer with the new custom classifier.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const handle = acquireVisionTask("hand", {
      numEntities: config.maxHands,
      signLanguageModelUrl: config.signLanguageModelUrl,
    });
    handleRef.current = handle;
    handle.whenReady().then((ok) => {
      if (cancelled) return;
      setIsReady(ok);
      setError(ok ? null : "Failed to load hand gesture model");
    });
    return () => {
      cancelled = true;
      handle.release();
      handleRef.current = null;
      setIsReady(false);
    };
  }, [enabled, config.maxHands, config.signLanguageModelUrl]);

  // Detection loop. The worker (or main-thread fallback) returns the same plain
  // result shape; mapping below is unchanged from the previous main-thread path.
  useEffect(() => {
    if (!enabled || !videoEl) {
      setHands([]);
      setFps(0);
      return;
    }
    let stopped = false;

    const tick = () => {
      const handle = handleRef.current;
      const video = videoEl;
      if (!handle || !handle.isReady() || video.readyState < 2) return;
      setIsProcessing(true);
      handle.detect(video, performance.now()).then((results) => {
        if (stopped || !results) return;
        const rawHands: RawTrackedHand[] = [];

        if (results.landmarks && results.landmarks.length > 0) {
          for (let i = 0; i < results.landmarks.length; i++) {
            const landmarks: HandLandmark[] = results.landmarks[i].map(
              (lm: any) => ({ x: lm.x, y: lm.y, z: lm.z })
            );

            let handedness: "Left" | "Right" = "Right";
            if (results.handedness && results.handedness[i] && results.handedness[i].length > 0) {
              const label = results.handedness[i][0].categoryName;
              handedness = label === "Left" ? "Left" : "Right";
            }

            let gesture: string | null = null;
            let gestureConfidence = 0;
            if (results.gestures && results.gestures[i] && results.gestures[i].length > 0) {
              const topGesture = results.gestures[i][0];
              if (topGesture.categoryName !== "None") {
                gesture = topGesture.categoryName;
                gestureConfidence = topGesture.score;
              }
            }

            // Custom/sign-language gestures appear after the built-in ones.
            let signLanguageGesture: string | null = null;
            let signLanguageConfidence = 0;
            if (results.gestures && results.gestures[i] && results.gestures[i].length > 1) {
              for (let g = 1; g < results.gestures[i].length; g++) {
                const entry = results.gestures[i][g];
                if (entry.categoryName !== "None" && !MEDIAPIPE_GESTURE_MAP[entry.categoryName]) {
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
      }).catch(() => { /* per-frame failures are non-fatal */ })
        .finally(() => { if (!stopped) setIsProcessing(false); });
    };

    const interval = setInterval(tick, config.processingIntervalMs);
    const fpsTimer = setInterval(() => { setFps(frameCountRef.current); frameCountRef.current = 0; }, 1000);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(fpsTimer);
    };
  }, [enabled, videoEl, config.processingIntervalMs]);

  return { isReady, isProcessing, error, hands, fps };
}

export default useHandGestureTracking;
