// client-aac/src/hooks/useHandGestureEvents.ts
// Event accumulation hook: derives semantic gesture events from raw hand data,
// matches hands by handedness, maintains rolling buffer per hand.

import { useState, useRef, useEffect } from "react";
import type {
  HandGestureConfig,
  RawTrackedHand,
  TrackedHand,
  HandGestureEvent,
  HandGestureEventType,
  HandLandmark,
} from "@/lib/handGestureTypes";
import {
  DEFAULT_HAND_GESTURE_CONFIG,
  MEDIAPIPE_GESTURE_MAP,
} from "@/lib/handGestureTypes";

// =============================================================================
// TYPES
// =============================================================================

export interface UseHandGestureEventsOptions {
  hands: RawTrackedHand[];
  enabled?: boolean;
  config?: Partial<HandGestureConfig>;
}

export interface UseHandGestureEventsReturn {
  trackedHands: TrackedHand[];
  updateCount: number;
}

// =============================================================================
// WAVE DETECTION STATE
// =============================================================================

interface WaveBuffer {
  // Circular buffer of wrist X positions with timestamps
  entries: { x: number; timestamp: number }[];
  lastDirection: number; // 1 = right, -1 = left, 0 = initial
  oscillationTimestamps: number[]; // timestamps of direction changes
}

// =============================================================================
// HELPERS
// =============================================================================

function landmarkDistance(a: HandLandmark, b: HandLandmark): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function landmarkDistance2D(a: HandLandmark, b: HandLandmark): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Check if index finger is extended by comparing distances */
function isFingerExtended(landmarks: HandLandmark[]): boolean {
  // Index finger: MCP=5, PIP=6, DIP=7, TIP=8
  const mcp = landmarks[5];
  const tip = landmarks[8];
  const pip = landmarks[6];

  // Finger is extended if tip is farther from wrist than PIP
  const tipDist = landmarkDistance2D(landmarks[0], tip);
  const pipDist = landmarkDistance2D(landmarks[0], pip);
  return tipDist > pipDist * 1.1;
}

/** Derive built-in gesture events from raw hand data */
function deriveBuiltinGesture(
  hand: RawTrackedHand,
  thresholds: HandGestureConfig["thresholds"]
): HandGestureEvent | null {
  if (!hand.gesture || hand.gestureConfidence < thresholds.gesture) return null;

  const mappedType = MEDIAPIPE_GESTURE_MAP[hand.gesture];
  if (!mappedType) return null;

  return {
    type: mappedType,
    timestamp: Date.now(),
    confidence: hand.gestureConfidence,
    hand: hand.handedness,
  };
}

/** Detect hand raise: average of wrist Y and middle MCP Y in top portion of frame */
function deriveHandRaise(
  hand: RawTrackedHand,
  thresholds: HandGestureConfig["thresholds"]
): HandGestureEvent | null {
  if (hand.landmarks.length < 10) return null;

  const wristY = hand.landmarks[0].y; // landmark 0 = wrist
  const middleMcpY = hand.landmarks[9].y; // landmark 9 = middle MCP
  const avgY = (wristY + middleMcpY) / 2;

  // Y < threshold means hand is in top portion of frame (Y=0 is top)
  if (avgY < thresholds.handRaise) {
    const confidence = Math.max(0, 1 - avgY / thresholds.handRaise);
    return {
      type: "hand_raise",
      timestamp: Date.now(),
      confidence: Math.min(1, confidence),
      hand: hand.handedness,
    };
  }
  return null;
}

/** Detect pointing direction from index finger vector */
function derivePointingDirection(
  hand: RawTrackedHand,
  thresholds: HandGestureConfig["thresholds"]
): HandGestureEvent | null {
  if (hand.landmarks.length < 9) return null;
  if (!isFingerExtended(hand.landmarks)) return null;

  const indexMcp = hand.landmarks[5]; // landmark 5 = index MCP
  const indexTip = hand.landmarks[8]; // landmark 8 = index tip

  const dx = indexTip.x - indexMcp.x;
  const dy = indexTip.y - indexMcp.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.01) return null;

  const normalizedDx = dx / length;

  // Check if horizontal component is dominant enough
  if (Math.abs(normalizedDx) > thresholds.pointingAngle) {
    const type: HandGestureEventType =
      normalizedDx < 0 ? "pointing_left" : "pointing_right";
    return {
      type,
      timestamp: Date.now(),
      confidence: Math.abs(normalizedDx),
      hand: hand.handedness,
    };
  }
  return null;
}

/** Detect pinch: thumb tip close to index tip */
function derivePinch(
  hand: RawTrackedHand,
  thresholds: HandGestureConfig["thresholds"]
): HandGestureEvent | null {
  if (hand.landmarks.length < 9) return null;

  const thumbTip = hand.landmarks[4]; // landmark 4 = thumb tip
  const indexTip = hand.landmarks[8]; // landmark 8 = index tip
  const dist = landmarkDistance(thumbTip, indexTip);

  if (dist < thresholds.pinch) {
    // Confidence is inverse of distance (closer = higher confidence)
    const confidence = Math.min(1, 1 - dist / thresholds.pinch);
    return {
      type: "pinch",
      timestamp: Date.now(),
      confidence,
      hand: hand.handedness,
    };
  }
  return null;
}

/** Detect wave from wrist oscillation tracking */
function deriveWave(
  hand: RawTrackedHand,
  waveBuffer: WaveBuffer,
  config: HandGestureConfig
): { event: HandGestureEvent | null; updatedBuffer: WaveBuffer } {
  if (hand.landmarks.length < 1) {
    return { event: null, updatedBuffer: waveBuffer };
  }

  const now = Date.now();
  const wristX = hand.landmarks[0].x;

  // Add to circular buffer (keep last 20 entries)
  const newEntries = [
    ...waveBuffer.entries.slice(-19),
    { x: wristX, timestamp: now },
  ];

  // Need at least 2 entries to detect direction
  if (newEntries.length < 2) {
    return {
      event: null,
      updatedBuffer: { ...waveBuffer, entries: newEntries },
    };
  }

  const prevEntry = newEntries[newEntries.length - 2];
  const dx = wristX - prevEntry.x;

  // Only count significant displacements
  let newDirection = waveBuffer.lastDirection;
  let newOscillations = [...waveBuffer.oscillationTimestamps];

  if (Math.abs(dx) > config.thresholds.wave) {
    const direction = dx > 0 ? 1 : -1;

    // Direction change = oscillation
    if (
      waveBuffer.lastDirection !== 0 &&
      direction !== waveBuffer.lastDirection
    ) {
      newOscillations.push(now);
    }

    newDirection = direction;
  }

  // Prune old oscillations outside the wave time window
  const windowStart = now - config.waveTimeWindowMs;
  newOscillations = newOscillations.filter((t) => t >= windowStart);

  const updatedBuffer: WaveBuffer = {
    entries: newEntries,
    lastDirection: newDirection,
    oscillationTimestamps: newOscillations,
  };

  // Check if we have enough oscillations for a wave
  if (newOscillations.length >= config.waveOscillationsRequired) {
    // Calculate confidence based on oscillation count vs required
    const confidence = Math.min(
      1,
      newOscillations.length / (config.waveOscillationsRequired + 2)
    );

    // Reset oscillation buffer after detecting wave
    updatedBuffer.oscillationTimestamps = [];

    return {
      event: {
        type: "wave",
        timestamp: now,
        confidence,
        hand: hand.handedness,
      },
      updatedBuffer,
    };
  }

  return { event: null, updatedBuffer };
}

/** Derive sign language event from custom model results */
function deriveSignLanguage(
  hand: RawTrackedHand,
  thresholds: HandGestureConfig["thresholds"],
  locale: string | null
): HandGestureEvent | null {
  if (
    !hand.signLanguageGesture ||
    hand.signLanguageConfidence < thresholds.signLanguage
  ) {
    return null;
  }

  return {
    type: "sign_language",
    timestamp: Date.now(),
    confidence: hand.signLanguageConfidence,
    hand: hand.handedness,
    signLabel: hand.signLanguageGesture,
    signLanguageLocale: locale ?? undefined,
  };
}

/** Get the re-fire interval category for an event type */
function getRefireCategory(
  type: HandGestureEventType
): "gesture" | "wave" | "signLanguage" {
  if (type === "wave") return "wave";
  if (type === "sign_language") return "signLanguage";
  return "gesture";
}

// =============================================================================
// HOOK
// =============================================================================

export function useHandGestureEvents(
  options: UseHandGestureEventsOptions
): UseHandGestureEventsReturn {
  const { hands, enabled = true, config: configOverrides } = options;

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

  const [trackedHands, setTrackedHands] = useState<TrackedHand[]>([]);
  const [updateCount, setUpdateCount] = useState(0);

  // Stable refs for mutable state
  const trackedRef = useRef<TrackedHand[]>([]);
  const lastFireRef = useRef<
    Map<string, Map<HandGestureEventType, number>>
  >(new Map());
  const waveBuffersRef = useRef<Map<string, WaveBuffer>>(new Map());

  useEffect(() => {
    if (!enabled) {
      if (trackedRef.current.length > 0) {
        trackedRef.current = [];
        setTrackedHands([]);
      }
      return;
    }

    const now = Date.now();
    const existing = trackedRef.current;

    // Match incoming hands to existing tracked hands by handedness
    const matched = new Map<number, number>(); // existing index -> incoming index
    const usedIncoming = new Set<number>();

    for (let ei = 0; ei < existing.length; ei++) {
      const existingHand = existing[ei];

      for (let hi = 0; hi < hands.length; hi++) {
        if (usedIncoming.has(hi)) continue;
        if (hands[hi].handedness === existingHand.handedness) {
          matched.set(ei, hi);
          usedIncoming.add(hi);
          break;
        }
      }
    }

    const newTracked: TrackedHand[] = [];

    // Update matched existing hands
    for (let ei = 0; ei < existing.length; ei++) {
      const tracked = existing[ei];
      const incomingIdx = matched.get(ei);

      if (incomingIdx !== undefined) {
        const incoming = hands[incomingIdx];
        const handKey = `hand_${tracked.handedness}`;

        // Derive all events
        const candidateEvents: HandGestureEvent[] = [];

        const builtinEvent = deriveBuiltinGesture(incoming, config.thresholds);
        if (builtinEvent) candidateEvents.push(builtinEvent);

        const handRaiseEvent = deriveHandRaise(incoming, config.thresholds);
        if (handRaiseEvent) candidateEvents.push(handRaiseEvent);

        const pointingEvent = derivePointingDirection(
          incoming,
          config.thresholds
        );
        if (pointingEvent) candidateEvents.push(pointingEvent);

        const pinchEvent = derivePinch(incoming, config.thresholds);
        if (pinchEvent) candidateEvents.push(pinchEvent);

        // Wave detection with per-hand buffer
        let waveBuffer = waveBuffersRef.current.get(handKey) || {
          entries: [],
          lastDirection: 0,
          oscillationTimestamps: [],
        };
        const waveResult = deriveWave(incoming, waveBuffer, config);
        waveBuffersRef.current.set(handKey, waveResult.updatedBuffer);
        if (waveResult.event) candidateEvents.push(waveResult.event);

        // Sign language
        const signEvent = deriveSignLanguage(
          incoming,
          config.thresholds,
          config.signLanguageLocale
        );
        if (signEvent) candidateEvents.push(signEvent);

        // Deduplicate events with re-fire intervals
        if (!lastFireRef.current.has(handKey)) {
          lastFireRef.current.set(handKey, new Map());
        }
        const lastFire = lastFireRef.current.get(handKey)!;

        const accepted: HandGestureEvent[] = [];
        for (const ev of candidateEvents) {
          const category = getRefireCategory(ev.type);
          const interval = config.refireIntervals[category];
          const last = lastFire.get(ev.type) ?? 0;

          if (now - last >= interval) {
            accepted.push(ev);
            lastFire.set(ev.type, now);
          }
        }

        // Prune old events outside window
        const windowStart = now - config.eventWindowMs;
        const keptEvents = tracked.events
          .filter((e) => e.timestamp >= windowStart)
          .concat(accepted);

        // Determine current dominant gesture
        let currentGesture: HandGestureEventType | null = null;
        let currentGestureConfidence = 0;
        if (builtinEvent) {
          currentGesture = builtinEvent.type;
          currentGestureConfidence = builtinEvent.confidence;
        }

        newTracked.push({
          ...tracked,
          handIndex: incoming.handIndex,
          landmarks: incoming.landmarks,
          currentGesture,
          currentGestureConfidence,
          events: keptEvents,
          missedTicks: 0,
        });
      } else {
        // Hand not found this tick
        const newMissed = tracked.missedTicks + 1;
        if (newMissed < config.handPersistenceTicks) {
          newTracked.push({
            ...tracked,
            missedTicks: newMissed,
          });
        }
        // else: hand dropped
      }
    }

    // Add new unmatched incoming hands
    for (let hi = 0; hi < hands.length; hi++) {
      if (usedIncoming.has(hi)) continue;

      const incoming = hands[hi];
      const handKey = `hand_${incoming.handedness}`;

      // Derive events for new hand
      const candidateEvents: HandGestureEvent[] = [];

      const builtinEvent = deriveBuiltinGesture(incoming, config.thresholds);
      if (builtinEvent) candidateEvents.push(builtinEvent);

      const handRaiseEvent = deriveHandRaise(incoming, config.thresholds);
      if (handRaiseEvent) candidateEvents.push(handRaiseEvent);

      const pointingEvent = derivePointingDirection(
        incoming,
        config.thresholds
      );
      if (pointingEvent) candidateEvents.push(pointingEvent);

      const pinchEvent = derivePinch(incoming, config.thresholds);
      if (pinchEvent) candidateEvents.push(pinchEvent);

      const signEvent = deriveSignLanguage(
        incoming,
        config.thresholds,
        config.signLanguageLocale
      );
      if (signEvent) candidateEvents.push(signEvent);

      // Initialize wave buffer
      waveBuffersRef.current.set(handKey, {
        entries: [{ x: incoming.landmarks[0]?.x ?? 0, timestamp: now }],
        lastDirection: 0,
        oscillationTimestamps: [],
      });

      // Initialize last fire map
      lastFireRef.current.set(handKey, new Map());

      let currentGesture: HandGestureEventType | null = null;
      let currentGestureConfidence = 0;
      if (builtinEvent) {
        currentGesture = builtinEvent.type;
        currentGestureConfidence = builtinEvent.confidence;
      }

      newTracked.push({
        handIndex: incoming.handIndex,
        handedness: incoming.handedness,
        landmarks: incoming.landmarks,
        currentGesture,
        currentGestureConfidence,
        events: candidateEvents,
        missedTicks: 0,
      });
    }

    trackedRef.current = newTracked;
    setTrackedHands([...newTracked]);
    setUpdateCount((c) => c + 1);
  }, [
    hands,
    enabled,
    config.thresholds,
    config.eventWindowMs,
    config.handPersistenceTicks,
    config.refireIntervals,
    config.waveOscillationsRequired,
    config.waveTimeWindowMs,
    config.signLanguageLocale,
  ]);

  return { trackedHands, updateCount };
}

export default useHandGestureEvents;
