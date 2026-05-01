/**
 * SleepSignalFeeds.tsx
 *
 * Tiny wiring components that push engagement signals into the sleep system
 * from data sources whose owning components live outside the
 * CameraAttentivenessProvider's direct reach (e.g. face-tracking data computed
 * at the page level). Render these inside CameraAttentivenessWrapper.
 */

import { useCallback } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useFaceEngagementSignal } from "@/hooks/useFaceEngagementSignal";
import { useSustainedFacePresence } from "@/hooks/useSustainedFacePresence";
import { useMouseEyegazeSignal } from "@/hooks/useMouseEyegazeSignal";

export function FaceEngagementSignalFeed({ rawFaces }: { rawFaces: RawTrackedFace[] }) {
  const att = useCameraAttentivenessOptional();
  const push = useCallback((i: number) => att?.pushSignal("face", i), [att]);
  useFaceEngagementSignal(rawFaces, push);

  // Sustained forward-facing presence wakes from Hibernation (and from any
  // other state, where it's effectively a no-op since face signal already
  // contributes to score).
  const wake = useCallback(() => att?.triggerAlwaysWake("sustainedFace"), [att]);
  useSustainedFacePresence(rawFaces, wake);

  return null;
}

export function MouseEyegazeSignalFeed() {
  const att = useCameraAttentivenessOptional();
  const push = useCallback(
    (i: number) => att?.pushSignal("mouseEyegaze", i),
    [att],
  );
  useMouseEyegazeSignal(push);
  return null;
}
