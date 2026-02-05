// client-aac/src/lib/gestureContextSerializer.ts
// Serializes recent face and hand gesture events into a compact
// human-readable string for inclusion in AI agent context.

import type { TrackedFace, FaceEvent, FaceEventType } from "./faceTrackingTypes";
import type { TrackedHand, HandGestureEvent, HandGestureEventType } from "./handGestureTypes";

/**
 * Summarize a list of events by counting occurrences of each type
 * within the given time window.
 */
function summarizeEvents<T extends { type: string; timestamp: number; confidence: number }>(
  events: T[],
  windowMs: number
): Map<string, { count: number; avgConfidence: number; lastTimestamp: number }> {
  const now = Date.now();
  const cutoff = now - windowMs;
  const summary = new Map<string, { count: number; totalConfidence: number; lastTimestamp: number }>();

  for (const event of events) {
    if (event.timestamp < cutoff) continue;

    const existing = summary.get(event.type);
    if (existing) {
      existing.count++;
      existing.totalConfidence += event.confidence;
      existing.lastTimestamp = Math.max(existing.lastTimestamp, event.timestamp);
    } else {
      summary.set(event.type, {
        count: 1,
        totalConfidence: event.confidence,
        lastTimestamp: event.timestamp,
      });
    }
  }

  const result = new Map<string, { count: number; avgConfidence: number; lastTimestamp: number }>();
  for (const [type, data] of summary) {
    result.set(type, {
      count: data.count,
      avgConfidence: data.totalConfidence / data.count,
      lastTimestamp: data.lastTimestamp,
    });
  }
  return result;
}

function formatEventSummary(
  eventSummary: Map<string, { count: number; avgConfidence: number; lastTimestamp: number }>
): string {
  if (eventSummary.size === 0) return "no recent events";

  const parts: string[] = [];
  // Sort by most recent first
  const sorted = [...eventSummary.entries()].sort(
    (a, b) => b[1].lastTimestamp - a[1].lastTimestamp
  );

  for (const [type, data] of sorted) {
    const label = type.replace(/_/g, " ");
    if (data.count === 1) {
      parts.push(label);
    } else {
      parts.push(`${label} x${data.count}`);
    }
  }
  return parts.join(", ");
}

/**
 * Serialize tracked faces and hands into a compact context string
 * for inclusion in AI requests. Returns null if there are no
 * tracked faces or hands with any events.
 */
export function serializeGestureContext(
  trackedFaces: TrackedFace[],
  trackedHands: TrackedHand[],
  windowMs: number = 10_000
): string | null {
  const lines: string[] = [];

  // Face events
  for (let i = 0; i < trackedFaces.length; i++) {
    const face = trackedFaces[i];
    const name = face.personName || `Person ${i + 1}`;
    const eventSummary = summarizeEvents(face.events, windowMs);

    // Current expression
    const expression = face.currentExpression
      ? face.currentExpression.replace(/_/g, " ")
      : "neutral";

    const eventsStr = formatEventSummary(eventSummary);
    lines.push(`- ${name} (face): expression=${expression}; recent: ${eventsStr}`);
  }

  // Hand events
  for (const hand of trackedHands) {
    const label = `${hand.handedness} hand`;
    const eventSummary = summarizeEvents(hand.events, windowMs);

    const gesture = hand.currentGesture
      ? hand.currentGesture.replace(/_/g, " ")
      : "none";

    const eventsStr = formatEventSummary(eventSummary);

    // Include sign language labels if present
    const signEvents = hand.events.filter(
      (e) => e.type === "sign_language" && e.signLabel && e.timestamp >= Date.now() - windowMs
    );
    const signPart =
      signEvents.length > 0
        ? `; signs: ${[...new Set(signEvents.map((e) => e.signLabel))].join(", ")}`
        : "";

    lines.push(`- ${label}: gesture=${gesture}; recent: ${eventsStr}${signPart}`);
  }

  if (lines.length === 0) return null;

  return `[Gesture & expression context (last ${Math.round(windowMs / 1000)}s):\n${lines.join("\n")}]`;
}
