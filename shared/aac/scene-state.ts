// shared/aac/scene-state.ts
//
// Pure logic for the cost-saving "scene_state" path (Phase 2). While the scene
// is stable, the AAC client sends a compact TEXT description instead of a JPEG
// frame; it only sends a real frame on an "escalation" (a new/lost person, a
// new hand gesture, a wake/startup, or a safety trigger). The Gemini Live
// context re-bills every image on every turn, so fewer frames = lower cost.
//
// Lives in shared/ (pure, no deps) so the client imports it and server tests
// can cover the escalation decision — the risky bit. See
// planning-docs/aac-cost-saving-spec.md §2-3.

import { bboxIoU, FACE_MATCH_IOU, type BBox } from "./speaker-fusion";

export interface ScenePerson {
  /** Client-side label fallback only ("person N"). The SERVER overrides this with
   *  the real identity by correlating `bbox` against its matched faces — the
   *  MediaPipe tracker rarely knows who someone is, but face-api does. Drives the
   *  change signature. */
  name: string;
  /** Coarse expression bucket (e.g. "smile", "neutral"), or null. Text-only —
   *  NOT part of the signature, so routine expression flicker stays cheap text. */
  expression?: string | null;
  /** Compact summary of recent movement/expression events over the last few
   *  seconds (e.g. "nodding x2, gaze left, blink") — the dynamics a single
   *  expression bucket misses. Text-only, NOT in the signature. */
  movement?: string;
  /** Bounding box (client tracker space) so the server can match this person to
   *  an identified face by IoU and replace `name` with the real identity. */
  bbox?: BBox;
}

export interface SceneSnapshot {
  people: ScenePerson[];
  /** Discrete hand gestures active this moment (e.g. ["wave"]). A NEW gesture
   *  is meaningful (the user may want attention) → escalates to a frame. */
  hands: string[];
  /** Optional coarse motion level 0..1 (rendered as still/some/lots in text). */
  motion?: number;
  /** Fraction (0..1) of BACKGROUND pixels (outside face/hand boxes) that changed
   *  since the last sample — something held up to the camera, a new object, or a
   *  scenery change. A large value escalates to a real frame so the Observer can
   *  see what appeared. NOT part of the signature. */
  backgroundChange?: number;
  /** Coarse body posture of the active user (from the pose model): "upright",
   *  "leaning-left/right", "lying", "unknown". Text-only; a CHANGE escalates. */
  posture?: string;
  /** A suspected fall/collapse (conservative pose hint) — forces a real frame
   *  tagged "safety" for the Observer to adjudicate. Never an auto-alarm. */
  suspectedFall?: boolean;
  /** A seizure-like MOTION pattern (rhythmic-convulsive / atonic / post-ictal)
   *  from the seizure-signature DSP — forces a real frame tagged "seizure" and
   *  carries a pre-rendered [MOTION SIGNATURE] line for the Observer. A coarse
   *  hint the Observer adjudicates against alarm_conditions; never an auto-alarm. */
  seizure?: SeizureSceneInfo;
}

/** Compact seizure-signature payload attached to a scene snapshot. `summary` is
 *  the [MOTION SIGNATURE] line (rendered client-side by summarizeSignature) so
 *  the server forwards it verbatim to the Observer with the escalated frame. */
export interface SeizureSceneInfo {
  /** "marker" = no generic convulsive/atonic pattern, but the motion matched a
   *  presentation this student's clinician recorded (see seizure-markers.ts).
   *  It is its own phase because the generic detector genuinely found nothing —
   *  labelling it "clonic" would misreport to the Observer what was seen. */
  phase: "clonic" | "atonic" | "postictal" | "marker";
  confidence: number;
  summary: string;
}

/** Background-change fraction above which we send a real frame (object shown /
 *  scene changed). Tunable against real sessions. */
export const SCENE_CHANGE_ESCALATE = 0.18;

export type SceneMode = "frame" | "text";
export interface SceneDecision {
  mode: SceneMode;
  /** Why — becomes the frame's triggerReason on escalation, for the Observer. */
  reason: string;
}

/** Triggers that always warrant a real frame regardless of scene stability. */
const ESCALATION_TRIGGERS = new Set(["wake_check", "startup", "first", "safety"]);

/** Render a person's state into one phrase. `movement` (when present) is the
 *  comprehensive live-state + dynamics description and subsumes `expression`;
 *  fall back to the bare expression bucket otherwise. */
function describePerson(p: ScenePerson): string {
  return p.movement || (p.expression ?? "");
}

function motionWord(motion: number): string {
  return motion < 0.05 ? "still" : motion < 0.2 ? "some" : "lots";
}

/**
 * Compact human-readable scene description for the Observer ([SCENE] ...).
 * Client-side fallback when no identity is available — uses the snapshot's own
 * (generic) names. The server prefers {@link renderSceneForObserver}, which
 * swaps in real identities.
 */
export function buildSceneStateText(snap: SceneSnapshot): string {
  const n = snap.people.length;
  const peoplePart = n === 0
    ? ""
    : ` (${snap.people
        .map(p => { const d = describePerson(p); return d ? `${p.name}, ${d}` : p.name; })
        .join("; ")})`;
  const parts = [`people:${n}${peoplePart}`];
  if (snap.posture && snap.posture !== "unknown") parts.push(`posture:${snap.posture}`);
  if (snap.hands.length) parts.push(`hands:${snap.hands.join("/")}`);
  if (typeof snap.motion === "number") parts.push(`motion:${motionWord(snap.motion)}`);
  return parts.join(" | ");
}

/** Minimal view of a server-identified face, for scene labelling. */
export interface IdentifiedForScene {
  name: string;
  /** Match confidence 0..1. */
  confidence?: number;
  /** Whether this face matched a known person at all. */
  matched?: boolean;
  /** True for the primary student. */
  isStudent?: boolean;
  /** Bounding box (same space as ScenePerson.bbox) for IoU correlation. */
  bbox?: BBox;
}

function identityLabel(f: IdentifiedForScene): string {
  const conf = typeof f.confidence === "number" ? ` ${Math.round(f.confidence * 100)}%` : "";
  return `${f.name}${conf}${f.isStudent ? " [student]" : ""}`;
}

/**
 * Server-side [SCENE] renderer. The client tracker supplies movement/expression
 * and a bbox per person but rarely knows WHO anyone is; the server holds the
 * authoritative face-api identities. We correlate each tracked person to a
 * matched identity by bounding-box IoU (the same cross-detector correlation
 * lip-sync fusion uses) and render the real name. Single tracked person + a
 * single matched face is correlated regardless of IoU (the common case, robust
 * to detector coordinate-space differences). Identities the tracker didn't see
 * are appended so the Observer still knows they're present.
 */
export function renderSceneForObserver(snap: SceneSnapshot, identified: IdentifiedForScene[]): string {
  const matched = identified.filter(f => f.matched);
  const used = new Set<number>();

  const personParts = snap.people.map((p, idx) => {
    let chosen = -1;
    if (p.bbox) {
      let bestIou = FACE_MATCH_IOU;
      matched.forEach((f, j) => {
        if (used.has(j) || !f.bbox) return;
        const iou = bboxIoU(p.bbox!, f.bbox!);
        if (iou >= bestIou) { bestIou = iou; chosen = j; }
      });
    }
    // Single person + single identity → trust it even without IoU overlap.
    if (chosen === -1 && snap.people.length === 1 && matched.length === 1 && !used.has(0)) {
      chosen = 0;
    }
    let label = p.name || `person ${idx + 1}`;
    if (chosen >= 0) { used.add(chosen); label = identityLabel(matched[chosen]); }
    const desc = describePerson(p);
    return desc ? `${label}: ${desc}` : label;
  });

  const parts: string[] = [];
  if (snap.people.length === 0 && matched.length === 0) {
    parts.push("no one visible");
  } else {
    parts.push(`people:${snap.people.length}`);
    if (personParts.length) parts.push(personParts.join(" | "));
  }
  if (snap.posture && snap.posture !== "unknown") parts.push(`posture: ${snap.posture.replace(/-/g, " ")}`);
  if (snap.hands.length) parts.push(`hands: ${snap.hands.join("; ")}`);
  if (typeof snap.motion === "number") parts.push(`motion: ${motionWord(snap.motion)}`);
  const orphans = matched.filter((_, j) => !used.has(j)).map(f => identityLabel(f));
  if (orphans.length) parts.push(`also identified: ${orphans.join(", ")}`);
  return parts.join(" | ");
}

/**
 * Coarse signature for change detection — only MATERIAL changes flip it:
 * person count, who is present (by name), and which hand gestures are active.
 * Expression and motion are deliberately excluded so routine flicker doesn't
 * force a frame.
 */
export function sceneSignature(snap: SceneSnapshot): string {
  const people = snap.people.map(p => p.name).sort().join(",");
  const hands = [...snap.hands].sort().join(",");
  return `n=${snap.people.length}|p=${people}|h=${hands}`;
}

/**
 * Decide whether a routine trigger sends a real FRAME (escalation) or a cheap
 * scene_state TEXT. Escalate when:
 *  - the trigger itself is an escalation type (wake_check/startup/safety), OR
 *  - this is the first scene (no prior signature), OR
 *  - the signature changed: a new/lost person or a new hand gesture. A person
 *    count DROP is reported as "left_frame" — the safety-relevant case (someone
 *    left, or a fall took their face out of view; Phase 3's decoupling of safety
 *    from face-presence without a pose model).
 * Otherwise → text.
 */
export function classifyScene(
  prevSignature: string | null,
  curr: SceneSnapshot,
  triggerReason: string | undefined,
  prevPersonCount: number | null,
  prevPosture?: string | null,
): SceneDecision {
  if (triggerReason && ESCALATION_TRIGGERS.has(triggerReason)) {
    return { mode: "frame", reason: triggerReason };
  }
  // Suspected fall — highest priority: always send a real frame tagged "safety"
  // so the Observer can look and judge against the student's alarm_conditions.
  if (curr.suspectedFall) return { mode: "frame", reason: "safety" };
  // Seizure-like motion pattern — same priority as a fall: always escalate to a
  // real frame tagged "seizure" carrying the [MOTION SIGNATURE]. The Observer
  // adjudicates; the DSP never alarms on its own.
  if (curr.seizure) return { mode: "frame", reason: "seizure" };

  if (prevSignature === null) return { mode: "frame", reason: "first_scene" };

  // Something changed in the background (not the person/hands) — an object held
  // up, a new item, a scenery change. Send a real frame so the Observer can see
  // and identify it. Checked before the stability short-circuit below.
  if ((curr.backgroundChange ?? 0) >= SCENE_CHANGE_ESCALATE) {
    return { mode: "frame", reason: "object_shown" };
  }

  // No identifiable face — text tells us least exactly when a real look matters
  // most (an unidentified mover, or a safety situation off-camera). Only ever go
  // text-first when there is at least one tracked person and the scene is stable.
  if (curr.people.length === 0) return { mode: "frame", reason: "no_faces" };

  const sig = sceneSignature(curr);
  if (sig !== prevSignature) {
    if (prevPersonCount !== null && curr.people.length < prevPersonCount) {
      return { mode: "frame", reason: "left_frame" };
    }
    return { mode: "frame", reason: "scene_changed" };
  }
  // A material posture shift (e.g. upright→leaning) while the scene is otherwise
  // stable — worth a look. "unknown" transitions are noise, so ignore them.
  if (curr.posture && prevPosture && curr.posture !== "unknown" && prevPosture !== "unknown" && curr.posture !== prevPosture) {
    return { mode: "frame", reason: "posture_changed" };
  }
  return { mode: "text", reason: "stable" };
}
