// client-aac/src/lib/seizureMotionSource.ts
//
// Turns whatever the trackers resolved this instant into ONE sensor-agnostic
// MotionFrame for the seizure DSP (shared/aac/motion-types.ts).
//
// The ordering of preference is deliberate and is the point of the whole
// rework: the FACE is the primary source, because at the AAC's camera distance
// it is the thing that is reliably in frame, it supplies a trustworthy subject
// SCALE (face width) and ANCHOR (face centre), and its rigid motion is the
// AXIAL channel that the convulsive gate needs. Hands come from the hand
// tracker. Pose contributes torso/arms only when it happens to resolve — it is
// strictly additive, and nothing requires it.
//
// ⚠️ LEFT/RIGHT ARE THE STUDENT'S OWN, everywhere in this file. Two conventions
// carry that and both assume the camera stream is UNMIRRORED (it is — the AAC
// mirrors for display with a CSS transform, not at the source):
//   * MediaPipe hand `handedness` reports the real-world hand under exactly that
//     assumption, so "Left" is the student's left hand.
//   * MediaPipe blendshapes use the ARKit convention, where `...Left` is the
//     subject's left side.
// If the source stream ever becomes mirrored, both flip together and every
// sided per-student marker silently points at the wrong arm. The debug panel
// surfaces observed hand sides so this can be checked with a one-handed wave.

import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import type { RawTrackedHand } from "@/lib/handGestureTypes";
import type { RawTrackedPose } from "@/lib/poseTrackingTypes";
import type {
  FacialSample, MotionFrame, MotionFieldSample, MotionPoint, Region,
} from "@shared/aac/motion-types";
import { poseFrameToMotion } from "@shared/aac/seizure-signature";

/** Blendshape pairs whose left/right disagreement reads as unilateral facial
 *  involvement. Expression muscles only — blink is excluded because ordinary
 *  winking/asymmetric blinking is common and would swamp the signal. */
const ASYMMETRY_PAIRS: Array<[string, string]> = [
  ["mouthSmileLeft", "mouthSmileRight"],
  ["mouthFrownLeft", "mouthFrownRight"],
  ["mouthUpperUpLeft", "mouthUpperUpRight"],
  ["mouthLowerDownLeft", "mouthLowerDownRight"],
  ["browDownLeft", "browDownRight"],
  ["browOuterUpLeft", "browOuterUpRight"],
  ["cheekSquintLeft", "cheekSquintRight"],
  ["eyeSquintLeft", "eyeSquintRight"],
];

const bs = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;

/**
 * Project a tracked face into the semiology channel.
 *
 * Head orientation reuses the tracker's existing landmark-asymmetry estimate
 * (`RawTrackedFace.headPose`) rather than MediaPipe's 4×4 facial transformation
 * matrix. The matrix would be more robust under motion blur, but its sign
 * convention has to be confirmed against a real camera, and a flipped yaw would
 * silently aim every sided marker at the WRONG side — a much worse failure than
 * a noisier estimate. `headPose`'s convention is already documented and in use
 * elsewhere in the app (+yaw = turned to the subject's right).
 */
export function facialSampleFrom(face: RawTrackedFace): FacialSample {
  const b = face.blendshapes;

  // Gaze, + = subject's RIGHT (same convention as yaw). Looking right means the
  // left eye rotates IN toward the nose while the right eye rotates OUT.
  const gazeRight = (bs(b, "eyeLookInLeft") + bs(b, "eyeLookOutRight")) / 2;
  const gazeLeft = (bs(b, "eyeLookOutLeft") + bs(b, "eyeLookInRight")) / 2;
  const gazeDown = (bs(b, "eyeLookDownLeft") + bs(b, "eyeLookDownRight")) / 2;
  const gazeUp = (bs(b, "eyeLookUpLeft") + bs(b, "eyeLookUpRight")) / 2;

  let asymSum = 0, asymN = 0;
  for (const [l, r] of ASYMMETRY_PAIRS) {
    const lv = b.get(l), rv = b.get(r);
    if (lv === undefined || rv === undefined) continue;
    asymSum += Math.abs(lv - rv);
    asymN++;
  }

  return {
    yaw: face.headPose?.yaw ?? 0,
    pitch: face.headPose?.pitch ?? 0,
    roll: face.headPose?.roll ?? 0,
    jawOpen: bs(b, "jawOpen"),
    eyeBlinkLeft: bs(b, "eyeBlinkLeft"),
    eyeBlinkRight: bs(b, "eyeBlinkRight"),
    gazeX: gazeRight - gazeLeft,
    gazeY: gazeDown - gazeUp,
    asymmetry: asymN ? asymSum / asymN : 0,
  };
}

/** Centroid of a hand's 21 landmarks — steadier than the wrist point alone,
 *  which swings wildly when the hand rotates. */
function handCentroid(hand: RawTrackedHand): MotionPoint | null {
  const lms = hand.landmarks;
  if (!lms?.length) return null;
  let sx = 0, sy = 0;
  for (const p of lms) { sx += p.x; sy += p.y; }
  return { x: sx / lms.length, y: sy / lms.length };
}

export interface BuildMotionFrameInput {
  ts: number;
  /** Primary source. The student's own face — callers pass the tracked face
   *  they already believe belongs to the student, not just faces[0]. */
  face?: RawTrackedFace | null;
  hands?: RawTrackedHand[];
  pose?: RawTrackedPose | null;
  field?: MotionFieldSample | null;
}

/**
 * Fuse the available trackers into one MotionFrame, or null when nothing at all
 * resolved (no face, no hands, no pose — the student is simply not in view).
 *
 * Scale/anchor come from the face when there is one; otherwise from pose. If
 * NEITHER supplies a real measurement the frame carries no scale and the DSP
 * falls back to the window median — never to a constant, which is what made
 * every threshold meaningless once hips left the frame.
 */
export function buildMotionFrame(input: BuildMotionFrameInput): MotionFrame | null {
  const { ts, face, hands = [], pose, field } = input;

  const regions: Partial<Record<Region, MotionPoint>> = {};
  let anchor: MotionPoint | null = null;
  let scale: number | undefined;

  // Pose first, so face/hands overwrite its coarser estimates for the same
  // region rather than the other way round.
  if (pose?.landmarks?.length) {
    const pm = poseFrameToMotion({ ts, landmarks: pose.landmarks });
    for (const [r, p] of Object.entries(pm.regions) as Array<[Region, MotionPoint]>) {
      regions[r] = p;
    }
    if (pm.anchor) anchor = pm.anchor;
    if (pm.scale) scale = pm.scale;
  }

  if (face) {
    const box = face.boundingBox;
    if (box && box.width > 0) {
      anchor = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      scale = box.width;                          // face width = subject scale
    }
    // The head point: nose tip if we have it, else the box centre.
    const head = face.noseTip ?? anchor;
    if (head) regions.head = head;
  }

  for (const hand of hands) {
    const c = handCentroid(hand);
    if (!c) continue;
    regions[hand.handedness === "Left" ? "leftHand" : "rightHand"] = c;
  }

  if (!Object.keys(regions).length && !face) return null;

  return {
    ts,
    regions,
    anchor,
    scale,
    facial: face ? facialSampleFrom(face) : null,
    field: field ?? null,
  };
}
