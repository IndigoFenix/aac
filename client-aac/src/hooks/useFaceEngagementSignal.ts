/**
 * useFaceEngagementSignal.ts
 *
 * Push a face-presence engagement signal into the sleep system whenever
 * face-tracking produces a new frame of data.
 *
 * Intensity components (combined into [0, 1]):
 *   - Presence baseline: any face detected → 0.4 baseline
 *   - Proximity: largest face's bounding-box area, normalized
 *   - Head pose facing forward: low |yaw| and |pitch| (head pointed at camera)
 *
 * No push when no face is detected — the score decays naturally via the
 * engagement loop's exponential decay.
 */

import { useEffect } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";

const PRESENCE_BASELINE = 0.4;
const PROXIMITY_WEIGHT = 0.3;
const FORWARD_WEIGHT = 0.3;
const PROXIMITY_AREA_SCALE = 4;

export function useFaceEngagementSignal(
  rawFaces: RawTrackedFace[],
  push: (intensity: number) => void,
): void {
  useEffect(() => {
    if (rawFaces.length === 0) return;

    let primary: RawTrackedFace | null = null;
    let primaryArea = 0;
    for (const f of rawFaces) {
      if (!f.boundingBox) continue;
      const area = f.boundingBox.width * f.boundingBox.height;
      if (area > primaryArea) {
        primaryArea = area;
        primary = f;
      }
    }

    if (!primary || primaryArea === 0) return;

    const proximity = Math.min(1, primaryArea * PROXIMITY_AREA_SCALE);

    let forward = 1;
    if (primary.headPose) {
      const offAxis = Math.abs(primary.headPose.yaw) + Math.abs(primary.headPose.pitch);
      forward = Math.max(0, 1 - Math.min(1, offAxis));
    }

    const intensity = Math.min(
      1,
      PRESENCE_BASELINE + proximity * PROXIMITY_WEIGHT + forward * FORWARD_WEIGHT,
    );

    push(intensity);
  }, [rawFaces, push]);
}
