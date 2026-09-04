// client-aac/src/lib/gestureContextSerializer.ts
// Serializes recent face and hand gesture events into a compact
// human-readable string for inclusion in AI agent context.

import type { TrackedFace, FaceEvent, FaceEventType } from "./faceTrackingTypes";
import type { TrackedHand, HandGestureEvent, HandGestureEventType } from "./handGestureTypes";
import type { TrackedPose, PoseEventType } from "./poseTrackingTypes";
import type { AttentionReading } from "@shared/aac/head-attention";
import { describeAttention } from "@shared/aac/head-attention";
import { gazeVector } from "@shared/aac/face-features";
import type { FaceRead } from "@shared/aac/face-read";
import { faceReadPhrases, noChangePhrase } from "@shared/aac/face-read";

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
 * Compact summary of one face's recent movement/expression events (nods, gaze
 * shifts, blinks, brow moves...) over the window. Returns "" when nothing
 * recent — for the cost-saving [SCENE] line, which wants dynamics a single
 * expression bucket misses. Unlike {@link serializeGestureContext} this is
 * per-face and empty-safe.
 */
export function summarizeFaceMovement(face: TrackedFace, windowMs: number = 8_000): string {
  const summary = summarizeEvents(face.events, windowMs);
  if (summary.size === 0) return "";
  return formatEventSummary(summary);
}

// The absolute HEAD_TURN_MIN / HEAD_TURN_STRONG constants that lived here are
// gone: head orientation is now the debounced attention state (hysteresis +
// dwell against a running per-face neutral) in shared/aac/head-attention.ts.
// Only the head-TILT and eye-gaze floors remain local to this file.
const HEAD_TILT_MIN = 0.3;      // roll (radians) for a noticeable head tilt
// Eye-look blendshapes are subtle — they rarely exceed ~0.3 even at a hard
// glance, so the 0.4 event threshold almost never trips. Use a realistic floor
// for describing eye gaze when the head itself is roughly centered.
const EYE_GAZE_MIN = 0.18;

/**
 * "Looking" phrase: the committed ATTENTION state first, eye gaze second.
 * Returns null when the head is settled and the eyes are centred.
 */
function describeLooking(
  attention: AttentionReading | null | undefined,
  bs: Map<string, number>,
  eyesClosed: boolean,
): string | null {
  if (eyesClosed) return null; // handled separately
  // Head orientation now comes from the DEBOUNCED state, not a raw per-tick
  // threshold. The old code compared |yaw|/|pitch| to an absolute 0.22 here,
  // which measured out as "facing camera" only 4% of the time in prod — and
  // because that test ran BEFORE the eye-gaze branch below, a small permanent
  // yaw offset suppressed the eye read entirely. Eye gaze is the more
  // informative signal for this population, so it must be reachable.
  const away = describeAttention(attention);
  if (away) return away;
  // Head settled — read eye gaze. CONJUGATE (both eyes), from the single shared
  // implementation: this file used to read one blendshape per direction, which
  // halves the signal and mislabels the direction whenever the eyes are not
  // conjugate. See gazeVector in shared/aac/face-features.ts (D6).
  const gaze = gazeVector(bs);
  if (gaze.magnitude <= EYE_GAZE_MIN) return null;
  return Math.abs(gaze.x) >= Math.abs(gaze.y)
    ? `eyes ${gaze.x > 0 ? "right" : "left"}`
    : `eyes ${gaze.y > 0 ? "down" : "up"}`;
}

/**
 * Read a current-state description from the live blendshape map + head pose.
 * Unlike the event buffer (sparse deltas, deduplicated) this is ALWAYS populated
 * when a face is tracked — head/eye direction, eyes open/closed, mouth,
 * smile/frown, brow, head tilt. Thresholds mirror `deriveEvents` / FaceMirror so
 * the readouts agree.
 */
function describeBlendshapeState(
  bs: Map<string, number> | undefined,
  headPose: { yaw: number; pitch: number; roll: number } | null | undefined,
  attention: AttentionReading | null | undefined,
  read: FaceRead | null | undefined,
): string[] {
  if (!bs || bs.size === 0) return [];
  const g = (k: string) => bs.get(k) ?? 0;
  const parts: string[] = [];

  const eyesClosed = Math.min(g("eyeBlinkLeft"), g("eyeBlinkRight")) > 0.5;
  const looking = describeLooking(attention, bs, eyesClosed);
  if (eyesClosed) parts.push("eyes closed");
  parts.push(looking ?? "facing camera");
  if (headPose && Math.abs(headPose.roll) > HEAD_TILT_MIN) parts.push("head tilted");

  // Expression comes from the DECODER (shared/aac/face-read.ts): action units
  // scored against this student's own baseline, hysteresis and dwell, and an
  // explicit "unreadable". The absolute thresholds below are the fallback for a
  // face the decoder has not produced a read for yet.
  //
  // What the fallback measured on real sessions is why it is no longer the
  // primary path: "brows raised" fired on 23% of one student's frames and 0% of
  // both other subjects', so the Observer was being told about a constant of
  // that person on every single turn. A global threshold cannot tell a resting
  // face from an expression.
  const phrases = faceReadPhrases(read);
  if (phrases.unreadable) {
    parts.push(phrases.unreadable);
    return parts;
  }
  if (read?.readable) {
    // Engagement is deliberately dropped here: head orientation and eye
    // direction are already described above, and saying "gaze on screen" next
    // to "looking away to the left" is both wasted tokens and a contradiction.
    // Head STABILITY is not covered above, so it is kept.
    if (read.engagement && read.engagement.headStability < 0.4) parts.push("head moving");
    parts.push(...phrases.expression);
    return parts;
  }

  // Fallback — no read yet. Absolute thresholds, with all the faults above.
  if (g("jawOpen") > 0.4) parts.push("mouth open");
  const smile = (g("mouthSmileLeft") + g("mouthSmileRight")) / 2;
  const frown = (g("mouthFrownLeft") + g("mouthFrownRight")) / 2;
  if (smile > 0.4) parts.push("smiling");
  else if (frown > 0.4) parts.push("frowning");

  if ((g("browDownLeft") + g("browDownRight")) / 2 > 0.4) parts.push("brow furrowed");
  if (g("browInnerUp") > 0.5) parts.push("brows raised");

  return parts;
}

/** Recent dynamic gestures the static state can't show — nods, head shakes,
 *  surprise bursts. */
// head_turn_* removed 2026-09-02 — they were threshold chatter (45% "turned
// left", left and right in the same window) and are replaced by the debounced
// attention state, which describeLooking above already reports.
const SCENE_DYNAMIC_EVENTS: Array<[FaceEventType, string]> = [
  ["head_nod", "nodding"],
  ["head_shake", "shaking head"],
  ["surprise", "surprised"],
];

/**
 * Rich, always-populated [SCENE] description for one face: current
 * expression/gaze/mouth state (live blendshapes) + recent dynamic gestures
 * (nods, head shakes, turns). This is what the cost-saving text line should
 * carry — the old path emitted only the single dominant expression, which stuck
 * on whatever fired most (usually "brow furrow").
 */
export function describeFaceForScene(face: TrackedFace, windowMs: number = 8_000): string {
  const parts = describeBlendshapeState(face.currentBlendshapes, face.headPose, face.attention, face.read);
  const recent = summarizeEvents(face.events, windowMs);
  for (const [type, label] of SCENE_DYNAMIC_EVENTS) {
    const d = recent.get(type);
    if (d) parts.push(d.count > 1 ? `${label} x${d.count}` : label);
  }
  return parts.join(", ");
}

// Hand landmark indices (MediaPipe Hands): 0 wrist, 9 middle-finger MCP,
// fingertips 4/8/12/16/20. Below this normalized Y the hand sits in the upper
// part of the frame → "held up". Slightly looser than the hand_raise event
// threshold (0.3) so a hand held at chest/face height still reads as up.
const HAND_RAISE_Y = 0.45;

/**
 * Position of a hand relative to the tracked faces. "to face" when any key
 * landmark falls within a (slightly padded) face box — covers hand-to-mouth,
 * touching cheek/head, etc.; "raised" when the hand sits high in frame.
 * MediaPipe face boxes and hand landmarks share the same normalized image
 * space, so a direct containment test works.
 */
function handPosition(hand: TrackedHand, faces: TrackedFace[]): string | null {
  const lm = hand.landmarks;
  if (!lm || lm.length < 21) return null;
  const keyPts = [lm[0], lm[4], lm[8], lm[12], lm[16], lm[20]];
  for (const face of faces) {
    const bb = face.boundingBox;
    if (!bb) continue;
    const mx = bb.width * 0.15, my = bb.height * 0.15;
    const x0 = bb.x - mx, x1 = bb.x + bb.width + mx;
    const y0 = bb.y - my, y1 = bb.y + bb.height + my;
    if (keyPts.some(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) return "to face";
  }
  const avgY = (lm[0].y + lm[9].y) / 2;
  return avgY < HAND_RAISE_Y ? "raised" : null;
}

/**
 * [SCENE] description for one hand: position (to face / raised) + the current
 * built-in gesture. Returns null when nothing notable — a hand resting low with
 * no recognized gesture isn't worth a line (and keeps the scene signature
 * stable so idle hands don't force frames).
 */
export function describeHandForScene(hand: TrackedHand, faces: TrackedFace[]): string | null {
  const pos = handPosition(hand, faces);
  const gesture = hand.currentGesture ? hand.currentGesture.replace(/_/g, " ") : null;
  if (!pos && !gesture) return null;
  const side = hand.handedness.toLowerCase();
  return `${side} hand ${[pos, gesture].filter(Boolean).join(", ")}`;
}

// Body-movement event labels for [SCENE] / context.
const POSE_EVENT_LABELS: Array<[PoseEventType, string]> = [
  ["arms_raised", "arms raised"],
  ["hand_to_head", "hand to head"],
  ["rocking", "rocking"],
  ["fall", "possible fall"],
];

/** Rich [SCENE] description for the body: current posture + recent movement
 *  events (arms raised, hand-to-head, rocking, possible fall). "" when nothing. */
export function describePoseForScene(pose: TrackedPose, windowMs: number = 8_000): string {
  const parts: string[] = [];
  if (pose.currentPosture && pose.currentPosture !== "unknown") {
    parts.push(pose.currentPosture.replace(/-/g, " "));
  }
  const recent = summarizeEvents(pose.events, windowMs);
  for (const [type, label] of POSE_EVENT_LABELS) {
    const d = recent.get(type);
    if (d) parts.push(d.count > 1 ? `${label} x${d.count}` : label);
  }
  return parts.join(", ");
}

/**
 * Serialize tracked faces, hands, and body pose into a compact context string
 * for inclusion in AI requests. Returns null if nothing is tracked.
 */
export function serializeGestureContext(
  trackedFaces: TrackedFace[],
  trackedHands: TrackedHand[],
  trackedPoses: TrackedPose[] = [],
  windowMs: number = 10_000
): string | null {
  const lines: string[] = [];

  // Face events
  for (let i = 0; i < trackedFaces.length; i++) {
    const face = trackedFaces[i];
    const name = face.personName || `Person ${i + 1}`;
    const eventSummary = summarizeEvents(face.events, windowMs);

    // Current expression. `face.currentExpression` is NOT used: it is the
    // max-confidence pick across detectors with different thresholds and
    // completely different dynamic ranges, so the channel with the lowest
    // threshold and the noisiest floor won — in practice it stuck on
    // "brow furrow" — and it rendered its own null as the word "neutral",
    // which is an affirmative claim about a child's affect made on no
    // evidence. Both faults are D3 and D4. The decoder answers instead, and
    // says "unreadable" when that is the truth.
    const p = faceReadPhrases(face.read);
    const expression = p.unreadable
      ?? (p.expression.length ? p.expression.join(", ")
        : face.read?.readable ? noChangePhrase(face.read)
        : "not yet decoded");

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

  // Body pose (the active user)
  for (const pose of trackedPoses) {
    const desc = describePoseForScene(pose, windowMs);
    if (desc) lines.push(`- body: ${desc}`);
  }

  if (lines.length === 0) return null;

  return `[Gesture & expression context (last ${Math.round(windowMs / 1000)}s):\n${lines.join("\n")}]`;
}
