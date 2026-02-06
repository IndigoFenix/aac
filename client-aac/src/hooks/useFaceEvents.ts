// client-aac/src/hooks/useFaceEvents.ts
// Event accumulation hook: derives semantic events from blendshapes,
// correlates faces to identities, maintains rolling buffer per face.

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type {
  FaceTrackingConfig,
  RawTrackedFace,
  TrackedFace,
  FaceEvent,
  FaceEventType,
} from "@/lib/faceTrackingTypes";
import { DEFAULT_FACE_TRACKING_CONFIG } from "@/lib/faceTrackingTypes";
import type { IdentificationResult } from "@/hooks/usePersonIdentification";

// =============================================================================
// TYPES
// =============================================================================

export interface UseFaceEventsOptions {
  faces: RawTrackedFace[];
  currentIdentification: IdentificationResult | null;
  enabled?: boolean;
  config?: Partial<FaceTrackingConfig>;
}

export interface UseFaceEventsReturn {
  trackedFaces: TrackedFace[];
  updateCount: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function centroid(box: { x: number; y: number; width: number; height: number }) {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

function centroidDistance(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const ca = centroid(a);
  const cb = centroid(b);
  return Math.sqrt((ca.cx - cb.cx) ** 2 + (ca.cy - cb.cy) ** 2);
}

// Derive events from a blendshape map and head pose, returning all detected events
function deriveEvents(
  blendshapes: Map<string, number>,
  thresholds: FaceTrackingConfig["thresholds"],
  headPose?: { yaw: number; pitch: number } | null,
): FaceEvent[] {
  const now = Date.now();
  const events: FaceEvent[] = [];

  const blinkL = blendshapes.get("eyeBlinkLeft") ?? 0;
  const blinkR = blendshapes.get("eyeBlinkRight") ?? 0;

  // Blinks
  if (blinkL > thresholds.blink && blinkR > thresholds.blink) {
    events.push({ type: "blink_both", timestamp: now, confidence: Math.min(blinkL, blinkR) });
  } else {
    if (blinkL > thresholds.blink) {
      events.push({ type: "blink_left", timestamp: now, confidence: blinkL });
    }
    if (blinkR > thresholds.blink) {
      events.push({ type: "blink_right", timestamp: now, confidence: blinkR });
    }
  }

  // Gaze direction
  const lookLeft = blendshapes.get("eyeLookOutLeft") ?? 0;
  const lookRight = blendshapes.get("eyeLookOutRight") ?? 0;
  const lookUp = blendshapes.get("eyeLookUpLeft") ?? blendshapes.get("eyeLookUpRight") ?? 0;
  const lookDown = blendshapes.get("eyeLookDownLeft") ?? blendshapes.get("eyeLookDownRight") ?? 0;

  const gazeScores = [
    { type: "gaze_left" as FaceEventType, score: lookLeft },
    { type: "gaze_right" as FaceEventType, score: lookRight },
    { type: "gaze_up" as FaceEventType, score: lookUp },
    { type: "gaze_down" as FaceEventType, score: lookDown },
  ];

  const maxGaze = gazeScores.reduce((a, b) => (b.score > a.score ? b : a));
  if (maxGaze.score > thresholds.gaze) {
    events.push({ type: maxGaze.type, timestamp: now, confidence: maxGaze.score });
  } else {
    events.push({ type: "gaze_center", timestamp: now, confidence: 1 - maxGaze.score });
  }

  // Smile
  const smileL = blendshapes.get("mouthSmileLeft") ?? 0;
  const smileR = blendshapes.get("mouthSmileRight") ?? 0;
  const smileAvg = (smileL + smileR) / 2;
  if (smileAvg > thresholds.smile) {
    events.push({ type: "smile", timestamp: now, confidence: smileAvg });
  }

  // Frown
  const frownL = blendshapes.get("mouthFrownLeft") ?? 0;
  const frownR = blendshapes.get("mouthFrownRight") ?? 0;
  const frownAvg = (frownL + frownR) / 2;
  if (frownAvg > thresholds.frown) {
    events.push({ type: "frown", timestamp: now, confidence: frownAvg });
  }

  // Mouth open
  const jawOpen = blendshapes.get("jawOpen") ?? 0;
  if (jawOpen > thresholds.mouthOpen) {
    events.push({ type: "mouth_open", timestamp: now, confidence: jawOpen });
  }

  // Surprise (brows up + eyes wide)
  const browInnerUp = blendshapes.get("browInnerUp") ?? 0;
  const eyeWideL = blendshapes.get("eyeWideLeft") ?? 0;
  const eyeWideR = blendshapes.get("eyeWideRight") ?? 0;
  const surpriseScore = (browInnerUp + (eyeWideL + eyeWideR) / 2) / 2;
  if (surpriseScore > thresholds.surprise) {
    events.push({ type: "surprise", timestamp: now, confidence: surpriseScore });
  }

  // Brow raise
  const browOuterUpL = blendshapes.get("browOuterUpLeft") ?? 0;
  const browOuterUpR = blendshapes.get("browOuterUpRight") ?? 0;
  const browRaise = (browInnerUp + browOuterUpL + browOuterUpR) / 3;
  if (browRaise > thresholds.browRaise) {
    events.push({ type: "brow_raise", timestamp: now, confidence: browRaise });
  }

  // Brow furrow
  const browDownL = blendshapes.get("browDownLeft") ?? 0;
  const browDownR = blendshapes.get("browDownRight") ?? 0;
  const browFurrow = (browDownL + browDownR) / 2;
  if (browFurrow > thresholds.browFurrow) {
    events.push({ type: "brow_furrow", timestamp: now, confidence: browFurrow });
  }

  // Head turn direction (from landmark-based head pose)
  if (headPose) {
    const ht = thresholds.headTurn;
    const absYaw = Math.abs(headPose.yaw);
    const absPitch = Math.abs(headPose.pitch);

    // Pick the dominant axis if both exceed threshold
    if (absYaw > ht || absPitch > ht) {
      if (absYaw >= absPitch) {
        const type: FaceEventType = headPose.yaw > 0 ? "head_turn_right" : "head_turn_left";
        events.push({ type, timestamp: now, confidence: Math.min(1, absYaw / 0.4) });
      } else {
        const type: FaceEventType = headPose.pitch > 0 ? "head_turn_down" : "head_turn_up";
        events.push({ type, timestamp: now, confidence: Math.min(1, absPitch / 0.4) });
      }
    }
  }

  return events;
}

// Get the re-fire interval category for an event type
function getRefireCategory(type: FaceEventType): "blink" | "gaze" | "expression" | "headGesture" | "headTurn" {
  if (type.startsWith("blink")) return "blink";
  if (type.startsWith("gaze")) return "gaze";
  if (type === "head_nod" || type === "head_shake") return "headGesture";
  if (type.startsWith("head_turn_")) return "headTurn";
  return "expression";
}

// Detect head nod/shake from nose tip position history
function detectHeadGestures(
  history: Array<{ x: number; y: number; ts: number }>,
  faceWidth: number,
  faceHeight: number,
): { nod: boolean; shake: boolean; nodConf: number; shakeConf: number } {
  const result = { nod: false, shake: false, nodConf: 0, shakeConf: 0 };
  if (history.length < 3) return result;

  const minNodAmplitude = faceHeight * 0.06;
  const minShakeAmplitude = faceWidth * 0.06;

  // Count direction reversals on each axis
  let yReversals = 0;
  let xReversals = 0;
  let yMaxAmplitude = 0;
  let xMaxAmplitude = 0;

  let prevYDir = 0; // -1 = down, +1 = up, 0 = undetermined
  let prevXDir = 0;
  let yAnchor = history[0].y;
  let xAnchor = history[0].x;

  for (let i = 1; i < history.length; i++) {
    const dy = history[i].y - history[i - 1].y;
    const dx = history[i].x - history[i - 1].x;

    // Y-axis (nod) - track direction changes with minimum amplitude
    if (Math.abs(dy) > 0.001) {
      const yDir = dy > 0 ? 1 : -1;
      if (prevYDir !== 0 && yDir !== prevYDir) {
        const amplitude = Math.abs(history[i].y - yAnchor);
        if (amplitude >= minNodAmplitude) {
          yReversals++;
          yMaxAmplitude = Math.max(yMaxAmplitude, amplitude);
          yAnchor = history[i].y;
        }
      }
      if (prevYDir !== yDir && prevYDir === 0) {
        yAnchor = history[i - 1].y;
      }
      prevYDir = yDir;
    }

    // X-axis (shake) - track direction changes with minimum amplitude
    if (Math.abs(dx) > 0.001) {
      const xDir = dx > 0 ? 1 : -1;
      if (prevXDir !== 0 && xDir !== prevXDir) {
        const amplitude = Math.abs(history[i].x - xAnchor);
        if (amplitude >= minShakeAmplitude) {
          xReversals++;
          xMaxAmplitude = Math.max(xMaxAmplitude, amplitude);
          xAnchor = history[i].x;
        }
      }
      if (prevXDir !== xDir && prevXDir === 0) {
        xAnchor = history[i - 1].x;
      }
      prevXDir = xDir;
    }
  }

  // 2+ reversals = gesture detected (one full oscillation cycle)
  if (yReversals >= 2) {
    result.nod = true;
    result.nodConf = Math.min(1, yMaxAmplitude / (faceHeight * 0.15));
  }
  if (xReversals >= 2) {
    result.shake = true;
    result.shakeConf = Math.min(1, xMaxAmplitude / (faceWidth * 0.15));
  }

  // If both detected, pick the dominant one
  if (result.nod && result.shake) {
    if (yReversals > xReversals || (yReversals === xReversals && yMaxAmplitude > xMaxAmplitude)) {
      result.shake = false;
      result.shakeConf = 0;
    } else {
      result.nod = false;
      result.nodConf = 0;
    }
  }

  return result;
}

// Determine dominant expression from a set of events (ignoring blinks/gaze)
function getDominantExpression(events: FaceEvent[]): FaceEventType | null {
  const expressionTypes: FaceEventType[] = [
    "smile", "frown", "mouth_open", "surprise", "brow_raise", "brow_furrow",
  ];
  let best: FaceEvent | null = null;
  for (const ev of events) {
    if (expressionTypes.includes(ev.type)) {
      if (!best || ev.confidence > best.confidence) {
        best = ev;
      }
    }
  }
  return best?.type ?? null;
}

// =============================================================================
// HOOK
// =============================================================================

export function useFaceEvents(options: UseFaceEventsOptions): UseFaceEventsReturn {
  const { faces, currentIdentification, enabled = true, config: configOverrides } = options;

  // Memoize config to avoid creating new object references every render
  // (which would cause the useEffect to fire infinitely)
  const config = useMemo<FaceTrackingConfig>(() => ({
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
  }), [configOverrides]);

  const [trackedFaces, setTrackedFaces] = useState<TrackedFace[]>([]);
  const [updateCount, setUpdateCount] = useState(0);

  // Stable refs for mutable state
  const trackedRef = useRef<TrackedFace[]>([]);
  const lastFireRef = useRef<Map<string, Map<FaceEventType, number>>>(new Map());
  const noseTipHistoryRef = useRef<Map<string, Array<{ x: number; y: number; ts: number }>>>(new Map());

  // Process incoming raw faces
  useEffect(() => {
    if (!enabled) {
      if (trackedRef.current.length > 0) {
        trackedRef.current = [];
        setTrackedFaces([]);
      }
      return;
    }

    const now = Date.now();
    const existing = trackedRef.current;

    // Match incoming faces to existing tracked faces by bounding box proximity
    const matched = new Map<number, number>(); // existing index -> incoming index
    const usedIncoming = new Set<number>();

    if (faces.length === 1 && existing.length <= 1) {
      // Fast path: single face direct match
      if (existing.length === 1) {
        matched.set(0, 0);
        usedIncoming.add(0);
      }
    } else {
      // Match by centroid proximity
      for (let ei = 0; ei < existing.length; ei++) {
        const ebox = existing[ei].boundingBox;
        if (!ebox) continue;

        let bestDist = Infinity;
        let bestIdx = -1;

        for (let fi = 0; fi < faces.length; fi++) {
          if (usedIncoming.has(fi)) continue;
          const fbox = faces[fi].boundingBox;
          if (!fbox) continue;

          const dist = centroidDistance(ebox, fbox);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = fi;
          }
        }

        // Accept match if centroids are reasonably close (within 20% of frame)
        if (bestIdx >= 0 && bestDist < 0.2) {
          matched.set(ei, bestIdx);
          usedIncoming.add(bestIdx);
        }
      }
    }

    const newTracked: TrackedFace[] = [];

    // Update matched existing faces
    for (let ei = 0; ei < existing.length; ei++) {
      const face = existing[ei];
      const incomingIdx = matched.get(ei);

      if (incomingIdx !== undefined) {
        const incoming = faces[incomingIdx];
        const newEvents = deriveEvents(incoming.blendshapes, config.thresholds, incoming.headPose);

        // Deduplicate events with re-fire intervals
        const faceKey = face.personId || `face_${face.faceIndex}`;
        if (!lastFireRef.current.has(faceKey)) {
          lastFireRef.current.set(faceKey, new Map());
        }
        const lastFire = lastFireRef.current.get(faceKey)!;

        const accepted: FaceEvent[] = [];
        for (const ev of newEvents) {
          const category = getRefireCategory(ev.type);
          const interval = config.refireIntervals[category];
          const last = lastFire.get(ev.type) ?? 0;

          if (now - last >= interval) {
            accepted.push(ev);
            lastFire.set(ev.type, now);
          }
        }

        // Head gesture detection from nose tip history
        if (incoming.noseTip) {
          if (!noseTipHistoryRef.current.has(faceKey)) {
            noseTipHistoryRef.current.set(faceKey, []);
          }
          const history = noseTipHistoryRef.current.get(faceKey)!;
          history.push({ x: incoming.noseTip.x, y: incoming.noseTip.y, ts: now });

          // Prune entries older than 2s
          const gestureWindow = 2000;
          while (history.length > 0 && now - history[0].ts > gestureWindow) {
            history.shift();
          }

          // Detect gestures if we have a bounding box for amplitude reference
          if (incoming.boundingBox && history.length >= 3) {
            const gestures = detectHeadGestures(history, incoming.boundingBox.width, incoming.boundingBox.height);

            if (gestures.nod) {
              accepted.push({ type: "head_nod", timestamp: now, confidence: gestures.nodConf });
              // Clear history after detection to prevent re-triggering
              history.length = 0;
            } else if (gestures.shake) {
              accepted.push({ type: "head_shake", timestamp: now, confidence: gestures.shakeConf });
              history.length = 0;
            }
          }
        }

        // Prune old events outside window
        const windowStart = now - config.eventWindowMs;
        const keptEvents = face.events
          .filter((e) => e.timestamp >= windowStart)
          .concat(accepted);

        newTracked.push({
          ...face,
          faceIndex: incoming.faceIndex,
          boundingBox: incoming.boundingBox,
          currentBlendshapes: incoming.blendshapes,
          currentExpression: getDominantExpression(newEvents),
          events: keptEvents,
          missedTicks: 0,
        });
      } else {
        // Face not found this tick - increment missed
        const newMissed = face.missedTicks + 1;
        if (newMissed < config.facePersistenceTicks) {
          newTracked.push({
            ...face,
            missedTicks: newMissed,
          });
        }
        // else: face dropped
      }
    }

    // Add new unmatched incoming faces
    for (let fi = 0; fi < faces.length; fi++) {
      if (usedIncoming.has(fi)) continue;

      const incoming = faces[fi];
      const newEvents = deriveEvents(incoming.blendshapes, config.thresholds, incoming.headPose);

      // Initialize nose tip tracking for new faces
      if (incoming.noseTip) {
        const newFaceKey = `face_${incoming.faceIndex}`;
        noseTipHistoryRef.current.set(newFaceKey, [
          { x: incoming.noseTip.x, y: incoming.noseTip.y, ts: now },
        ]);
      }

      newTracked.push({
        faceIndex: incoming.faceIndex,
        personId: null,
        personName: null,
        boundingBox: incoming.boundingBox,
        currentBlendshapes: incoming.blendshapes,
        currentExpression: getDominantExpression(newEvents),
        events: newEvents,
        missedTicks: 0,
      });
    }

    // Correlate with person identification
    if (currentIdentification?.identified && currentIdentification.person) {
      const person = currentIdentification.person;

      if (newTracked.length === 1) {
        // Single face: direct match
        newTracked[0].personId = person.id;
        newTracked[0].personName = person.name;
      } else if (newTracked.length > 1) {
        // Multiple faces: assign to nearest that doesn't already have an ID
        // (Person identification typically tracks the primary face from user camera)
        const unassigned = newTracked.filter((f) => !f.personId);
        if (unassigned.length > 0) {
          unassigned[0].personId = person.id;
          unassigned[0].personName = person.name;
        }
      }
    }

    trackedRef.current = newTracked;
    setTrackedFaces([...newTracked]);
    setUpdateCount((c) => c + 1);
  }, [faces, currentIdentification, enabled, config.thresholds, config.eventWindowMs, config.facePersistenceTicks, config.refireIntervals]);

  return { trackedFaces, updateCount };
}

export default useFaceEvents;
