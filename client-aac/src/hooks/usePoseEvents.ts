// client-aac/src/hooks/usePoseEvents.ts
// Derives semantic body events from raw pose landmarks: current posture, arms
// raised, hand-to-head, rhythmic rocking, and a conservative suspected-fall hint.
// Mirrors useFaceEvents / useHandGestureEvents (rolling buffer + re-fire
// intervals). Single primary pose (maxPoses=1). All readings are coarse hints.

import { useState, useEffect, useRef } from "react";
import type { PoseTrackingConfig, RawTrackedPose, TrackedPose, PoseEvent, PoseEventType, Posture } from "@/lib/poseTrackingTypes";
import { DEFAULT_POSE_TRACKING_CONFIG } from "@/lib/poseTrackingTypes";
import { POSE_IDX, VIS_MIN, classifyPosture, poseBoundingBox, torsoCentroidY, armsRaised, handToHead, detectFall } from "@shared/aac/pose-classify";

export interface UsePoseEventsOptions {
  poses: RawTrackedPose[];
  enabled?: boolean;
  config?: Partial<PoseTrackingConfig>;
}

export interface UsePoseEventsReturn {
  trackedPoses: TrackedPose[];
  updateCount: number;
}

function shoulderCentroidX(lm: RawTrackedPose["landmarks"]): number | null {
  const ls = lm[POSE_IDX.leftShoulder], rs = lm[POSE_IDX.rightShoulder];
  if (!ls || !rs || (ls.visibility ?? 1) < VIS_MIN || (rs.visibility ?? 1) < VIS_MIN) return null;
  return (ls.x + rs.x) / 2;
}

/** Count direction reversals (>= amplitude) in an x-history → rhythmic sway. */
function countOscillations(history: Array<{ x: number; ts: number }>, minAmp: number): number {
  if (history.length < 3) return 0;
  let reversals = 0;
  let prevDir = 0;
  let anchor = history[0].x;
  for (let i = 1; i < history.length; i++) {
    const d = history[i].x - history[i - 1].x;
    if (Math.abs(d) < 0.002) continue;
    const dir = d > 0 ? 1 : -1;
    if (prevDir !== 0 && dir !== prevDir) {
      if (Math.abs(history[i].x - anchor) >= minAmp) { reversals++; anchor = history[i].x; }
    }
    prevDir = dir;
  }
  return reversals;
}

export function usePoseEvents(options: UsePoseEventsOptions): UsePoseEventsReturn {
  const { poses, enabled = true, config: configOverrides } = options;

  const config: PoseTrackingConfig = {
    ...DEFAULT_POSE_TRACKING_CONFIG,
    ...configOverrides,
    thresholds: { ...DEFAULT_POSE_TRACKING_CONFIG.thresholds, ...configOverrides?.thresholds },
    refireIntervals: { ...DEFAULT_POSE_TRACKING_CONFIG.refireIntervals, ...configOverrides?.refireIntervals },
  };

  const [trackedPoses, setTrackedPoses] = useState<TrackedPose[]>([]);
  const [updateCount, setUpdateCount] = useState(0);

  const trackedRef = useRef<TrackedPose | null>(null);
  const lastFireRef = useRef<Map<PoseEventType, number>>(new Map());
  const centroidHistRef = useRef<Array<{ y: number; posture: Posture; ts: number }>>([]);
  const swayHistRef = useRef<Array<{ x: number; ts: number }>>([]);

  useEffect(() => {
    if (!enabled) {
      if (trackedRef.current) { trackedRef.current = null; setTrackedPoses([]); }
      centroidHistRef.current = [];
      swayHistRef.current = [];
      return;
    }

    const now = Date.now();
    const prev = trackedRef.current;

    // Primary pose only.
    const raw = poses[0];
    if (!raw) {
      if (prev) {
        const missed = prev.missedTicks + 1;
        if (missed < config.posePersistenceTicks) {
          trackedRef.current = { ...prev, missedTicks: missed };
          setTrackedPoses([trackedRef.current]);
        } else {
          trackedRef.current = null;
          setTrackedPoses([]);
          centroidHistRef.current = [];
          swayHistRef.current = [];
        }
        setUpdateCount(c => c + 1);
      }
      return;
    }

    const lm = raw.landmarks;
    const posture = classifyPosture(lm);
    const bbox = poseBoundingBox(lm);

    const accepted: PoseEvent[] = [];
    const fire = (type: PoseEventType, confidence: number) => {
      const last = lastFireRef.current.get(type) ?? 0;
      const cat = type === "fall" ? "fall" : type === "rocking" ? "rocking" : "movement";
      if (now - last >= config.refireIntervals[cat]) {
        accepted.push({ type, timestamp: now, confidence });
        lastFireRef.current.set(type, now);
      }
    };

    if (armsRaised(lm)) fire("arms_raised", 0.7);
    if (handToHead(lm)) fire("hand_to_head", 0.7);

    // Rocking: shoulder-x sway oscillations over the window.
    const sx = shoulderCentroidX(lm);
    if (sx != null) {
      const sway = swayHistRef.current;
      sway.push({ x: sx, ts: now });
      while (sway.length && now - sway[0].ts > config.rockingWindowMs) sway.shift();
      if (countOscillations(sway, config.thresholds.rockingAmplitude) >= config.thresholds.rockingOscillations) {
        fire("rocking", 0.6);
        sway.length = 0; // reset after detection so it doesn't re-trigger every tick
      }
    }

    // Fall: fast downward drop of the torso centroid landing in "lying".
    const cy = torsoCentroidY(lm);
    if (cy != null) {
      const hist = centroidHistRef.current;
      // Reference = oldest sample still within the fall window.
      while (hist.length && now - hist[0].ts > config.refireIntervals.fall) hist.shift();
      const ref = hist.find(h => now - h.ts <= 1200) ?? hist[0];
      if (ref && detectFall({ prevPosture: ref.posture, currPosture: posture, centroidYDelta: cy - ref.y, dtMs: now - ref.ts })) {
        fire("fall", 0.6);
      }
      hist.push({ y: cy, posture, ts: now });
    }

    // Roll the event buffer.
    const windowStart = now - config.eventWindowMs;
    const events = (prev?.events ?? []).filter(e => e.timestamp >= windowStart).concat(accepted);

    trackedRef.current = {
      poseIndex: 0,
      landmarks: lm,
      boundingBox: bbox,
      currentPosture: posture,
      events,
      missedTicks: 0,
    };
    setTrackedPoses([trackedRef.current]);
    setUpdateCount(c => c + 1);
  }, [poses, enabled, config.posePersistenceTicks, config.eventWindowMs, config.rockingWindowMs,
      config.thresholds.rockingAmplitude, config.thresholds.rockingOscillations,
      config.refireIntervals.fall, config.refireIntervals.movement, config.refireIntervals.rocking]);

  return { trackedPoses, updateCount };
}

export default usePoseEvents;
