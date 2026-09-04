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
import type { HeadAttentionTracker } from "@shared/aac/head-attention";
import { createHeadAttentionTracker } from "@shared/aac/head-attention";
import type { HeadNeutralProfile, SessionNeutralObservation } from "@shared/aac/head-attention";
import type { HeadGestureDetector } from "@shared/aac/head-gestures";
import { createHeadGestureDetector } from "@shared/aac/head-gestures";
import type { FaceBaselineAccumulator, FaceBaselineProfile, SessionFaceObservation } from "@shared/aac/face-baseline";
import { createFaceBaselineAccumulator } from "@shared/aac/face-baseline";
import type { FaceReadTracker, FaceSample } from "@shared/aac/face-read";
import { createFaceReadTracker } from "@shared/aac/face-read";
import { gazeVector } from "@shared/aac/face-features";
import type { IdentificationResult } from "@/hooks/usePersonIdentification";

// =============================================================================
// TYPES
// =============================================================================

export interface UseFaceEventsOptions {
  faces: RawTrackedFace[];
  currentIdentification: IdentificationResult | null;
  enabled?: boolean;
  config?: Partial<FaceTrackingConfig>;
  /** Accumulated head-neutral profile for this student, seeded from the server
   *  (clientConfig.headNeutral). Trackers start from it instead of re-warming;
   *  how far it is trusted depends on its own reliability, not on being
   *  present. See shared/aac/head-attention.ts. */
  headNeutral?: HeadNeutralProfile | null;
  /** Accumulated facial-channel baseline for this student, seeded from the
   *  server (clientConfig.faceBaseline). Without one the decoder still works —
   *  it learns within the session and reports only unmistakable intensities
   *  meanwhile — but with one it can score against weeks of evidence from the
   *  first frame. See shared/aac/face-baseline.ts. */
  faceBaseline?: FaceBaselineProfile | null;
}

export interface UseFaceEventsReturn {
  trackedFaces: TrackedFace[];
  updateCount: number;
  /** What this session observed about the PRIMARY face's habitual head pose,
   *  for the cross-session write-back. Null until enough settled samples have
   *  accrued. "Primary" = the largest tracked face, which on the AAC's
   *  user-facing camera is the student; the server stores it against the
   *  session's student either way. */
  getNeutralObservation: () => SessionNeutralObservation | null;
  /** This session's facial-channel histograms for the PRIMARY face, for the
   *  cross-session write-back. Same "primary = largest face" rule as
   *  getNeutralObservation, for the same reason. */
  getFaceObservation: () => SessionFaceObservation | null;
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
  /** The PREVIOUS tick's blendshapes for this face, so a blink can be an edge
   *  rather than a level. Absent on a face's first tick. */
  prev?: Map<string, number> | null,
): FaceEvent[] {
  const now = Date.now();
  const events: FaceEvent[] = [];

  const blinkL = blendshapes.get("eyeBlinkLeft") ?? 0;
  const blinkR = blendshapes.get("eyeBlinkRight") ?? 0;

  // Blinks, on the RISING EDGE only. A blink is an event; eyes CLOSED is a
  // state, and the level test this replaces emitted one every tick the eyes
  // were shut — so a student resting with their eyes closed for ten seconds
  // billed the Observer for "blink both x30". Eye closure as a state is
  // reported by the decoder's engagement channel instead (face-read.ts).
  // Without a previous frame nothing fires: a face's first tick cannot be an
  // edge, and guessing costs a phantom blink on every re-acquisition.
  const wasL = (prev?.get("eyeBlinkLeft") ?? 1) > thresholds.blink;
  const wasR = (prev?.get("eyeBlinkRight") ?? 1) > thresholds.blink;
  const isL = blinkL > thresholds.blink;
  const isR = blinkR > thresholds.blink;
  if (isL && isR && !(wasL && wasR)) {
    events.push({ type: "blink_both", timestamp: now, confidence: Math.min(blinkL, blinkR) });
  } else if (!(isL && isR)) {
    if (isL && !wasL) events.push({ type: "blink_left", timestamp: now, confidence: blinkL });
    if (isR && !wasR) events.push({ type: "blink_right", timestamp: now, confidence: blinkR });
  }

  // Gaze direction, from the CONJUGATE vector (shared/aac/face-features.ts).
  // Two faults are fixed here. The scores were single-eye — `eyeLookOutLeft`
  // alone for "left", and `eyeLookUpLeft ?? eyeLookUpRight`, where `??` only
  // falls through on undefined, so vertical gaze was always the left eye (D6).
  // And there was an `else` branch pushing `gaze_center` on EVERY tick, which
  // is why a 10-second window summarised as "gaze center x20" with the one
  // informative event buried in it (D5). Centre is the default; it does not
  // need saying.
  const gaze = gazeVector(blendshapes);
  if (gaze.magnitude > thresholds.gaze) {
    const type: FaceEventType = Math.abs(gaze.x) >= Math.abs(gaze.y)
      ? (gaze.x > 0 ? "gaze_right" : "gaze_left")
      : (gaze.y > 0 ? "gaze_down" : "gaze_up");
    events.push({ type, timestamp: now, confidence: Math.min(1, gaze.magnitude) });
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

  // NOTE: head-turn events used to be emitted here, one per tick, off a single
  // absolute 0.15 threshold with no hysteresis and no dwell. On real sessions
  // that produced 45% "turned left" / 21% "shaking head" / 4% "facing camera",
  // with left and right inside the same window — threshold chatter, billed to
  // the Observer every turn. Head orientation is now a debounced STATE handled
  // by shared/aac/head-attention.ts and carried on TrackedFace.attention.
  // See planning-docs/aac-face-expression-decoder.md §2.5.

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

// Nod/shake detection moved to shared/aac/head-gestures.ts (2026-09-02). The
// detector that lived here asked for 2 reversals at 6% of the face box in a 2s
// window — about 7 samples at the tracker's cadence — and reported "shaking
// head" on 21% of prod scene rows for two different students. The replacement
// gates on PERIODICITY and on samples-per-half-cycle, which is the Nyquist
// condition the old thresholds could not express.

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
  const { faces, currentIdentification, enabled = true, config: configOverrides, headNeutral, faceBaseline } = options;

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
    // Merged like the blocks above so the defaults always back the override.
    attention: {
      ...DEFAULT_FACE_TRACKING_CONFIG.attention,
      ...configOverrides?.attention,
    },
    faceRead: {
      ...DEFAULT_FACE_TRACKING_CONFIG.faceRead,
      ...configOverrides?.faceRead,
    },
  }), [configOverrides]);

  const [trackedFaces, setTrackedFaces] = useState<TrackedFace[]>([]);
  const [updateCount, setUpdateCount] = useState(0);

  // Stable refs for mutable state
  const trackedRef = useRef<TrackedFace[]>([]);
  const lastFireRef = useRef<Map<string, Map<FaceEventType, number>>>(new Map());
  const gestureRef = useRef<Map<string, HeadGestureDetector>>(new Map());

  const gestureFor = useCallback((key: string): HeadGestureDetector => {
    let d = gestureRef.current.get(key);
    if (!d) { d = createHeadGestureDetector(); gestureRef.current.set(key, d); }
    return d;
  }, []);
  // One attention tracker per face — hysteresis and dwell are per-face memory,
  // and so is the running neutral (how THIS person habitually sits relative to
  // the camera). Keyed the same way as the other per-face maps above.
  const attentionRef = useRef<Map<string, HeadAttentionTracker>>(new Map());

  const attentionFor = useCallback((key: string): HeadAttentionTracker => {
    let t = attentionRef.current.get(key);
    if (!t) {
      t = createHeadAttentionTracker(config.attention, headNeutral ?? null);
      attentionRef.current.set(key, t);
    }
    return t;
  }, [config.attention, headNeutral]);

  // ---- expression decoding (shared/aac/face-read.ts) ----------------------
  //
  // The read tracker is per FACE (hysteresis and dwell are per-face memory).
  // The BASELINE is not: exactly one accumulator is the student's — seeded from
  // their stored profile and written back at session end — and it is fed by
  // whichever tracked face is largest in frame, re-decided every tick. Any
  // other face in view gets a throwaway session-local accumulator, so a
  // visitor is never scored against the student's distribution and never
  // contributes to it.
  const readRef = useRef<Map<string, FaceReadTracker>>(new Map());
  const studentBaselineRef = useRef<FaceBaselineAccumulator | null>(null);
  const visitorBaselineRef = useRef<Map<string, FaceBaselineAccumulator>>(new Map());

  const studentBaseline = useCallback((): FaceBaselineAccumulator => {
    if (!studentBaselineRef.current) {
      studentBaselineRef.current = createFaceBaselineAccumulator(faceBaseline ?? null);
    }
    return studentBaselineRef.current;
  }, [faceBaseline]);

  // A seed arriving mid-session (the profile lands after tracking starts) must
  // replace the accumulator, not be ignored — otherwise a student with weeks of
  // stored baseline spends the session re-learning it.
  //
  // ⚠️ But ONLY while there is nothing to lose. `aacSettings` gets a fresh
  // object identity on every profile refetch, so this effect fires far more
  // often than the seed actually changes; replacing a warm accumulator would
  // silently discard the session's evidence and, on a long session, the
  // write-back with it. Once the session has enough samples to be worth
  // sending home, the seed has missed its window.
  useEffect(() => {
    const cur = studentBaselineRef.current;
    if (cur && cur.sessionObservation() !== null) return;
    studentBaselineRef.current = createFaceBaselineAccumulator(faceBaseline ?? null);
  }, [faceBaseline]);

  const readFor = useCallback((key: string): FaceReadTracker => {
    let t = readRef.current.get(key);
    if (!t) { t = createFaceReadTracker(config.faceRead); readRef.current.set(key, t); }
    return t;
  }, [config.faceRead]);

  const baselineFor = useCallback((key: string, isPrimary: boolean): FaceBaselineAccumulator => {
    if (isPrimary) return studentBaseline();
    let a = visitorBaselineRef.current.get(key);
    if (!a) { a = createFaceBaselineAccumulator(null); visitorBaselineRef.current.set(key, a); }
    return a;
  }, [studentBaseline]);

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

    // Primary = largest face in frame. On the AAC's user-facing camera that is
    // the student, and it is what the server stores the write-back against.
    let primaryIncoming = -1;
    let primaryArea = 0;
    for (let fi = 0; fi < faces.length; fi++) {
      const bb = faces[fi].boundingBox;
      const area = bb ? bb.width * bb.height : 0;
      if (area > primaryArea) { primaryArea = area; primaryIncoming = fi; }
    }

    const decode = (
      key: string,
      incoming: RawTrackedFace,
      incomingIdx: number,
      attention: TrackedFace["attention"],
    ) => {
      const sample: FaceSample = {
        present: true,
        blendshapes: incoming.blendshapes,
        landmarks: incoming.landmarks,
        boundingBox: incoming.boundingBox,
        headPose: incoming.headPose,
        aspect: incoming.aspect,
        attentionAway: attention?.state === "away" && !attention.calibrating,
      };
      return readFor(key).update(sample, baselineFor(key, incomingIdx === primaryIncoming), now);
    };

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
        const newEvents = deriveEvents(
          incoming.blendshapes, config.thresholds, incoming.headPose, face.currentBlendshapes);

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

        // Head gesture detection (shared/aac/head-gestures.ts owns the window,
        // the periodicity gates and the refractory period).
        if (incoming.noseTip && incoming.boundingBox) {
          const g = gestureFor(faceKey).update(
            { x: incoming.noseTip.x, y: incoming.noseTip.y, ts: now },
            incoming.boundingBox.width,
            incoming.boundingBox.height,
          );
          if (g) {
            accepted.push({
              type: g.gesture === "nod" ? "head_nod" : "head_shake",
              timestamp: now,
              confidence: g.confidence,
            });
          }
        }

        // Prune old events outside window
        const windowStart = now - config.eventWindowMs;
        const keptEvents = face.events
          .filter((e) => e.timestamp >= windowStart)
          .concat(accepted);

        const attention = attentionFor(faceKey).update(incoming.headPose, now);

        newTracked.push({
          ...face,
          faceIndex: incoming.faceIndex,
          boundingBox: incoming.boundingBox,
          currentBlendshapes: incoming.blendshapes,
          currentExpression: getDominantExpression(newEvents),
          headPose: incoming.headPose,
          attention,
          read: decode(faceKey, incoming, incomingIdx, attention),
          events: keptEvents,
          missedTicks: 0,
        });
      } else {
        // Face not found this tick - increment missed
        const newMissed = face.missedTicks + 1;
        if (newMissed < config.facePersistenceTicks) {
          // Tick attention with no pose: it HOLDS the committed state (an absent
          // reading is not evidence of attention) while heldMs keeps advancing.
          const key = face.personId || `face_${face.faceIndex}`;
          // The read is CARRIED, not re-derived: the persistence window exists
          // to ride out a dropout of a tick or two, and re-reading a face that
          // is not there would only produce "unreadable" for 900 ms every time
          // the tracker blinks. Its dwell state holds untouched.
          newTracked.push({
            ...face,
            attention: attentionFor(key).update(null, now),
            missedTicks: newMissed,
          });
        } else {
          // Dropped for good — discard its tracker so a later face reusing the
          // index doesn't inherit a stranger's neutral.
          const goneKey = face.personId || `face_${face.faceIndex}`;
          attentionRef.current.delete(goneKey);
          gestureRef.current.delete(goneKey);
          readRef.current.delete(goneKey);
          // The STUDENT accumulator deliberately survives: it holds this
          // session's evidence for the write-back, and a student who turns away
          // for a second must not restart their baseline. Only the throwaway
          // visitor accumulators go.
          visitorBaselineRef.current.delete(goneKey);
        }
      }
    }

    // Add new unmatched incoming faces
    for (let fi = 0; fi < faces.length; fi++) {
      if (usedIncoming.has(fi)) continue;

      const incoming = faces[fi];
      const newEvents = deriveEvents(incoming.blendshapes, config.thresholds, incoming.headPose);

      // Seed the gesture detector for a newly seen face. It needs several
      // samples before it will judge anything, so the first one cannot fire.
      if (incoming.noseTip && incoming.boundingBox) {
        gestureFor(`face_${incoming.faceIndex}`).update(
          { x: incoming.noseTip.x, y: incoming.noseTip.y, ts: now },
          incoming.boundingBox.width,
          incoming.boundingBox.height,
        );
      }

      const newKey = `face_${incoming.faceIndex}`;
      const attention = attentionFor(newKey).update(incoming.headPose, now);

      newTracked.push({
        faceIndex: incoming.faceIndex,
        personId: null,
        personName: null,
        boundingBox: incoming.boundingBox,
        currentBlendshapes: incoming.blendshapes,
        currentExpression: getDominantExpression(newEvents),
        headPose: incoming.headPose,
        attention,
        read: decode(newKey, incoming, fi, attention),
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
  }, [faces, currentIdentification, enabled, config.thresholds, config.eventWindowMs, config.facePersistenceTicks, config.refireIntervals, attentionFor, gestureFor, readFor, baselineFor]);

  // Largest tracked face = the student on the user-facing camera. Recomputed at
  // read time so it follows whoever is actually in front of the device.
  const getNeutralObservation = useCallback((): SessionNeutralObservation | null => {
    let bestKey: string | null = null;
    let bestArea = 0;
    for (const f of trackedRef.current) {
      const bb = f.boundingBox;
      const area = bb ? bb.width * bb.height : 0;
      if (area > bestArea) { bestArea = area; bestKey = f.personId || `face_${f.faceIndex}`; }
    }
    if (!bestKey) return null;
    return attentionRef.current.get(bestKey)?.sessionObservation() ?? null;
  }, []);

  const getFaceObservation = useCallback(
    (): SessionFaceObservation | null => studentBaselineRef.current?.sessionObservation() ?? null,
    [],
  );

  return { trackedFaces, updateCount, getNeutralObservation, getFaceObservation };
}

export default useFaceEvents;
