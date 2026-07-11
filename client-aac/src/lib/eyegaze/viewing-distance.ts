// client-aac/src/lib/eyegaze/viewing-distance.ts
// Estimates the viewing geometry (pixels-per-degree of visual angle) that the
// shared gaze smoother needs to convert its degree-space thresholds into the
// pixel stream a hardware tracker emits.
//
// Two unknowns feed px/deg = pxPerCm · distanceCm · tan(1°):
//   • pxPerCm    — screen density. The browser can't read the panel's physical
//                  size, so we assume the CSS reference (96px/inch). Hardware
//                  gaze is projected into CSS-pixel space (see the Tobii/Gazepoint
//                  parsers, which multiply by window.innerWidth), so CSS px is
//                  the right unit here.
//   • distanceCm — how far the face is from the screen. In `fixed` mode we take
//                  the clinician's assumed distance; in `face` mode we derive it
//                  from the MediaPipe face bounding-box height, which shrinks
//                  with distance (larger face = closer).
//
// Every number here is an ESTIMATE, deliberately clamped to a sane range. The
// point isn't millimetre accuracy — it's that a preset ("Medium") feels the
// same on a small tablet held close and a large monitor across a desk, instead
// of silently assuming one screen geometry.

import {
  pixelsPerDegreeFromGeometry,
  DEFAULT_PIXELS_PER_DEGREE,
  type GazeSmoothingSettings,
} from "@shared/gaze-smoothing.js";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";

/** CSS pixels per centimetre at the 96px/inch reference (96 / 2.54). */
const CSS_PX_PER_CM = 96 / 2.54;

// Anthropometric anchor: at a comfortable ~60cm a seated user's face spans
// roughly a third of a typical webcam frame (bbox height ≈ 0.29 normalized).
// distanceCm ≈ K / faceHeightNorm, so K ≈ 0.29 · 60 ≈ 17. This is coarse — it
// ignores camera FOV and face size — but it tracks the RIGHT direction (lean in
// → face grows → distance drops) which is what keeps the angular thresholds honest.
const FACE_DISTANCE_K = 17;

const MIN_DISTANCE_CM = 25;
const MAX_DISTANCE_CM = 150;

/** Screen density in CSS px/cm (approximate — see file header). */
export function screenPxPerCm(): number {
  return CSS_PX_PER_CM;
}

/**
 * Largest-area face's bounding-box height in normalized [0,1] image coords, or
 * null when no usable face is present. The largest face is the nearest one and
 * the most likely the active user.
 */
export function primaryFaceHeightNorm(faces: RawTrackedFace[] | null | undefined): number | null {
  if (!faces || faces.length === 0) return null;
  let best: number | null = null;
  let bestArea = -1;
  for (const f of faces) {
    const bb = f.boundingBox;
    if (!bb || !(bb.height > 0)) continue;
    const area = bb.width * bb.height;
    if (area > bestArea) {
      bestArea = area;
      best = bb.height;
    }
  }
  return best;
}

/**
 * Estimate viewing distance (cm) from face size and the student's distance
 * settings. `null`/absent face height falls back to the fixed distance so the
 * cursor never breaks when the face is momentarily lost.
 */
export function estimateViewingDistanceCm(
  faceHeightNorm: number | null | undefined,
  settings: GazeSmoothingSettings,
): number {
  if (settings.distanceMode === "fixed") return settings.fixedDistanceCm;
  if (!faceHeightNorm || !(faceHeightNorm > 0)) return settings.fixedDistanceCm;
  const raw = FACE_DISTANCE_K / faceHeightNorm;
  return Math.min(MAX_DISTANCE_CM, Math.max(MIN_DISTANCE_CM, raw));
}

/**
 * Full pipeline: face size + settings → pixels-per-degree for the smoother.
 * Returns DEFAULT_PIXELS_PER_DEGREE if geometry can't be resolved.
 */
export function computePixelsPerDegree(
  faceHeightNorm: number | null | undefined,
  settings: GazeSmoothingSettings,
): number {
  const distCm = estimateViewingDistanceCm(faceHeightNorm, settings);
  const ppd = pixelsPerDegreeFromGeometry(screenPxPerCm(), distCm);
  return ppd > 0 ? ppd : DEFAULT_PIXELS_PER_DEGREE;
}
