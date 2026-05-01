/**
 * useSustainedFacePresence.ts
 *
 * Watches face-tracking output for a sustained forward-facing presence
 * (~1.5s of a face looking at the screen) and fires a one-shot trigger.
 * Used by the sleep system as a Hibernation wake signal — cheap because no
 * LLM is involved in the detection.
 *
 * Resets when the face disappears or turns off-axis, so each new sustained
 * presence period fires once.
 */

import { useEffect, useRef } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";

const SUSTAINED_THRESHOLD_MS = 1500;
const FORWARD_GAZE_MAX_OFF_AXIS = 0.5;

export function useSustainedFacePresence(
  rawFaces: RawTrackedFace[],
  trigger: () => void,
): void {
  const presenceStartRef = useRef<number | null>(null);
  const triggeredRef = useRef(false);

  useEffect(() => {
    // Treat any face whose head is reasonably forward-facing as "looking at screen".
    let hasForwardFace = false;
    for (const f of rawFaces) {
      if (!f.boundingBox) continue;
      const offAxis = f.headPose
        ? Math.abs(f.headPose.yaw) + Math.abs(f.headPose.pitch)
        : 0;
      if (offAxis < FORWARD_GAZE_MAX_OFF_AXIS) {
        hasForwardFace = true;
        break;
      }
    }

    if (hasForwardFace) {
      if (presenceStartRef.current === null) {
        presenceStartRef.current = Date.now();
      }
      const sustained = Date.now() - presenceStartRef.current;
      if (sustained >= SUSTAINED_THRESHOLD_MS && !triggeredRef.current) {
        triggeredRef.current = true;
        trigger();
      }
    } else {
      presenceStartRef.current = null;
      triggeredRef.current = false;
    }
  }, [rawFaces, trigger]);
}
