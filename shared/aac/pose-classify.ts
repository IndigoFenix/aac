// shared/aac/pose-classify.ts
//
// Pure body-pose geometry for the PoseLandmarker (33 MediaPipe landmarks). Kept
// here (no deps) so the client derives posture/movement and server tests cover
// the risky classification — body-pose readings are coarse and this population
// (wheelchairs, atypical postures, Rett's stereotypies) makes them error-prone,
// so the thresholds are deliberately conservative and everything downstream
// treats the output as a HINT the Observer adjudicates, never a fact.
//
// Front-facing user camera: we read upright / leaning / lying from the
// shoulder→hip torso vector. Sitting-vs-standing is NOT attempted (unreliable
// from a single front view, and most users are seated). See pose-state plan in
// planning-docs/aac-cost-saving-spec.md.

import type { BBox } from "./speaker-fusion";

export interface PoseLandmark { x: number; y: number; visibility?: number }

export type Posture = "upright" | "leaning-left" | "leaning-right" | "lying" | "unknown";

// MediaPipe Pose landmark indices we use.
export const POSE_IDX = {
  nose: 0, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
} as const;

// Tunables (front-view, normalized coords; y increases downward).
export const VIS_MIN = 0.5;          // landmark visibility floor
export const LEAN_ANGLE_DEG = 22;    // torso tilt from vertical → "leaning"
export const LYING_ANGLE_DEG = 60;   // torso past this → "lying"/horizontal
export const ARM_RAISE_MARGIN = 0.05;// wrist this far above shoulder line → raised
export const HAND_TO_HEAD_DIST = 0.16;// wrist within this of nose → hand at head/face
/** Downward centroid drop (fraction of frame) within FALL_WINDOW_MS that, landing
 *  in a lying posture, is treated as a SUSPECTED fall. Conservative on purpose. */
export const FALL_DROP = 0.18;
export const FALL_WINDOW_MS = 1200;

const vis = (p?: PoseLandmark): number => (p ? p.visibility ?? 1 : 0);
const mid = (a: PoseLandmark, b: PoseLandmark) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(vis(a), vis(b)) });
const dist = (a: PoseLandmark, b: PoseLandmark) => Math.hypot(a.x - b.x, a.y - b.y);

/** Shoulder/hip-derived torso posture. "unknown" when the torso isn't clearly
 *  visible or the geometry is degenerate (don't guess from garbage). */
export function classifyPosture(lm: PoseLandmark[]): Posture {
  const ls = lm[POSE_IDX.leftShoulder], rs = lm[POSE_IDX.rightShoulder];
  const lh = lm[POSE_IDX.leftHip], rh = lm[POSE_IDX.rightHip];
  if (!ls || !rs || !lh || !rh) return "unknown";
  const sh = mid(ls, rs), hp = mid(lh, rh);
  if (sh.v < VIS_MIN || hp.v < VIS_MIN) return "unknown";
  const dx = hp.x - sh.x, dy = hp.y - sh.y;
  // Torso too short to read a direction (shoulders ≈ hips) → can't tell.
  if (Math.hypot(dx, dy) < 0.05) return "unknown";
  // Angle of the shoulder→hip vector from straight-down: 0 = upright, ~90 =
  // horizontal (lying), >90 = hips above shoulders (inverted → also abnormal).
  const ang = Math.abs((Math.atan2(dx, dy) * 180) / Math.PI);
  if (ang >= LYING_ANGLE_DEG) return "lying";
  if (ang >= LEAN_ANGLE_DEG) return dx > 0 ? "leaning-right" : "leaning-left";
  return "upright";
}

/** Bounding box over the visible landmarks (normalized), or null if too few. */
export function poseBoundingBox(lm: PoseLandmark[]): BBox | null {
  let minX = 1, minY = 1, maxX = 0, maxY = 0, n = 0;
  for (const p of lm) {
    if (!p || vis(p) < VIS_MIN) continue;
    n++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (n < 4) return null;
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/** Vertical centroid (shoulder–hip midpoint y) for fall tracking, or null. */
export function torsoCentroidY(lm: PoseLandmark[]): number | null {
  const ls = lm[POSE_IDX.leftShoulder], rs = lm[POSE_IDX.rightShoulder];
  const lh = lm[POSE_IDX.leftHip], rh = lm[POSE_IDX.rightHip];
  if (!ls || !rs || !lh || !rh) return null;
  const sh = mid(ls, rs), hp = mid(lh, rh);
  if (sh.v < VIS_MIN || hp.v < VIS_MIN) return null;
  return (sh.y + hp.y) / 2;
}

/** Either wrist clearly above the shoulder line. */
export function armsRaised(lm: PoseLandmark[]): boolean {
  const ls = lm[POSE_IDX.leftShoulder], rs = lm[POSE_IDX.rightShoulder];
  if (!ls || !rs || vis(ls) < VIS_MIN || vis(rs) < VIS_MIN) return false;
  const shoulderY = (ls.y + rs.y) / 2;
  const lw = lm[POSE_IDX.leftWrist], rw = lm[POSE_IDX.rightWrist];
  const up = (w?: PoseLandmark) => !!w && vis(w) >= VIS_MIN && w.y < shoulderY - ARM_RAISE_MARGIN;
  return up(lw) || up(rw);
}

/** A wrist near the head (nose) — hand-to-face/head, common & meaningful here. */
export function handToHead(lm: PoseLandmark[]): boolean {
  const nose = lm[POSE_IDX.nose];
  if (!nose || vis(nose) < VIS_MIN) return false;
  const lw = lm[POSE_IDX.leftWrist], rw = lm[POSE_IDX.rightWrist];
  const near = (w?: PoseLandmark) => !!w && vis(w) >= VIS_MIN && dist(w, nose) < HAND_TO_HEAD_DIST;
  return near(lw) || near(rw);
}

/**
 * SUSPECTED fall: a fast downward drop of the torso centroid that lands in a
 * lying posture. Pure so it's testable; deliberately conservative (requires both
 * the big drop AND the horizontal end-state within the window). It only ever
 * raises a hint — the Observer decides against the student's alarm_conditions.
 */
export function detectFall(args: {
  prevPosture: Posture;
  currPosture: Posture;
  centroidYDelta: number; // + = moved DOWN since the reference sample
  dtMs: number;
}): boolean {
  const { prevPosture, currPosture, centroidYDelta, dtMs } = args;
  if (currPosture !== "lying") return false;
  if (prevPosture === "lying" || prevPosture === "unknown") return false; // already down / unknown
  if (dtMs <= 0 || dtMs > FALL_WINDOW_MS) return false;
  return centroidYDelta >= FALL_DROP;
}
