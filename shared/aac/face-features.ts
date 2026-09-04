// shared/aac/face-features.ts
//
// L1 of the face decoder: turn one raw MediaPipe face into a NORMALIZED,
// person-independent feature frame — plus an honest `quality` scalar saying how
// much of it is worth believing.
//
// This module is where three of the recorded defects are fixed:
//
//   D6 — gaze had FOUR implementations, two of them wrong (`useFaceEvents`
//        read `eyeLookUpLeft ?? eyeLookUpRight`, where `??` only falls through
//        on undefined, so it was always the left eye alone; and it read
//        `eyeLookOutLeft` alone as "gaze left" instead of the conjugate pair).
//        `gazeVector()` below is now the ONLY one. seizureMotionSource.ts had
//        the correct version and now imports it from here.
//
//   D7 — all 478 landmarks were discarded inside the detection loop, so every
//        geometric feature (eye aspect, mouth aspect, lip-corner elevation,
//        brow-to-lid gap, corner asymmetry) was unavailable. A small SUBSET is
//        now retained; see FACE_LANDMARK_SUBSET.
//
//   D4 — "unreadable" and "neutral" were the same output. `quality` below is
//        the input to that distinction; nothing downstream may assert an
//        expression when it is low. See face-read.ts.
//
// ⚠️ ANISOTROPY. MediaPipe landmark x/y are normalized to the IMAGE, not to a
// square, so on a 16:9 frame one unit of x is 1.78 units of y. Every distance
// here therefore scales x by the frame aspect before measuring. A geometry
// module that skips this reports a face stretched sideways, and every ratio it
// derives is wrong by a constant that changes with the camera.
//
// ⚠️ SIDES ARE THE SUBJECT'S. `left`/`right` throughout mean the subject's own
// left and right (MediaPipe's blendshape naming convention), NOT image sides.

// ---------------------------------------------------------------------------
// Landmark subset (D7)
// ---------------------------------------------------------------------------

/**
 * The ~40 landmarks the geometry below actually reads. Carrying these instead
 * of all 478 keeps `RawTrackedFace` cheap to hold and to structured-clone while
 * making every feature in this file computable.
 *
 * Indices are MediaPipe Face Mesh canonical. Grouped by what reads them, so a
 * later edit can tell which group it is breaking.
 */
export const FACE_LANDMARK_INDICES = {
  /** Rigid anchors — used to cancel translation and scale. */
  eyeInnerRight: 133, eyeInnerLeft: 362,
  eyeOuterRight: 33, eyeOuterLeft: 263,
  noseBridge: 168, noseTip: 4,
  tragionRight: 234, tragionLeft: 454,
  forehead: 10, chin: 152,
  /** Right eye lid contour (eye aspect ratio). */
  eyeRUpperA: 160, eyeRUpperB: 158, eyeRLowerA: 144, eyeRLowerB: 153, eyeRLid: 159,
  /** Left eye lid contour. */
  eyeLUpperA: 385, eyeLUpperB: 387, eyeLLowerA: 380, eyeLLowerB: 373, eyeLLid: 386,
  /** Brow arch midpoints, for brow-to-lid distance. */
  browRight: 105, browLeft: 334,
  browInnerRight: 107, browInnerLeft: 336,
  /** Mouth. */
  mouthCornerRight: 61, mouthCornerLeft: 291,
  lipUpperInner: 13, lipLowerInner: 14,
  lipUpperOuter: 0, lipLowerOuter: 17,
} as const;

export type FaceLandmarkName = keyof typeof FACE_LANDMARK_INDICES;

/** Flat, de-duplicated, ASCENDING list of indices to retain. Ascending so a
 *  consumer copying them out of the full array touches memory in order. */
export const FACE_LANDMARK_SUBSET: number[] =
  Array.from(new Set(Object.values(FACE_LANDMARK_INDICES))).sort((a, b) => a - b);

export interface Point2 { x: number; y: number }

/** The retained subset, keyed by NAME. Built by the acquisition layer via
 *  {@link pickFaceLandmarks} so nothing downstream deals in raw indices. */
export type FaceLandmarkSet = Partial<Record<FaceLandmarkName, Point2>>;

/**
 * Pull the subset out of a full MediaPipe landmark array. Returns null when the
 * array is missing or too short — never a half-filled set that later reads as
 * geometry.
 */
export function pickFaceLandmarks(all: ArrayLike<Point2> | null | undefined): FaceLandmarkSet | null {
  if (!all || all.length < 468) return null;
  const out: FaceLandmarkSet = {};
  for (const [name, idx] of Object.entries(FACE_LANDMARK_INDICES) as Array<[FaceLandmarkName, number]>) {
    const p = all[idx];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[name] = { x: p.x, y: p.y };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gaze — ONE implementation (D6)
// ---------------------------------------------------------------------------

const bs = (m: Map<string, number> | undefined, k: string): number => m?.get(k) ?? 0;

export interface GazeVector {
  /** + = toward the subject's RIGHT. Same convention as headPose.yaw. */
  x: number;
  /** + = DOWN. Same convention as headPose.pitch. */
  y: number;
  /** Magnitude, for a "how far off centre" test that doesn't care which way. */
  magnitude: number;
}

/**
 * Conjugate eye-gaze vector.
 *
 * Both eyes rotate together, so each direction has TWO blendshapes reporting
 * it — looking right means the left eye rotates IN toward the nose while the
 * right eye rotates OUT. Reading one eye alone halves the signal and inherits
 * that eye's noise; reading `eyeLookOutLeft` alone additionally mislabels the
 * direction whenever the eyes are not conjugate (a lazy eye, or the model
 * losing one lid).
 */
export function gazeVector(blendshapes: Map<string, number> | undefined): GazeVector {
  const right = (bs(blendshapes, "eyeLookInLeft") + bs(blendshapes, "eyeLookOutRight")) / 2;
  const left = (bs(blendshapes, "eyeLookOutLeft") + bs(blendshapes, "eyeLookInRight")) / 2;
  const down = (bs(blendshapes, "eyeLookDownLeft") + bs(blendshapes, "eyeLookDownRight")) / 2;
  const up = (bs(blendshapes, "eyeLookUpLeft") + bs(blendshapes, "eyeLookUpRight")) / 2;
  const x = right - left;
  const y = down - up;
  return { x, y, magnitude: Math.hypot(x, y) };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Geometric features the blendshape head does not give well. All are RATIOS
 * normalized by interocular distance, so they survive the student moving nearer
 * or further; the ones that could depend on head roll are measured against the
 * face's own rigid axes instead of the image's.
 *
 * Every field may be undefined: geometry needs landmarks, and the acquisition
 * layer is allowed not to have them (an older client, or a frame where the
 * subset came back short). Undefined must never be read as zero.
 */
export interface FaceGeometry {
  /** Eye aspect ratio per side — openness, independent of the blink blendshape.
   *  Roughly 0.3 open, 0.1 closed on a typical adult. */
  eyeAspectLeft?: number;
  eyeAspectRight?: number;
  /** Inner-lip opening over mouth width. */
  mouthAspect?: number;
  /** Mouth width over interocular distance. Widens on AU12/AU20. */
  mouthWidth?: number;
  /** Lip-corner height above the mouth's centre, measured along the normal to
   *  the EYE LINE, over interocular. + = corner pulled up the face. The eye
   *  line is the reference because it is rigid: measuring against the mouth's
   *  own corner-to-corner axis makes the asymmetry below identically zero. */
  lipCornerElevLeft?: number;
  lipCornerElevRight?: number;
  /** Brow arch to upper lid, per side, over interocular. Grows on AU1/AU2,
   *  shrinks on AU4. */
  browLidGapLeft?: number;
  browLidGapRight?: number;
  /** Signed left-minus-right lip-corner elevation. Unilateral facial movement
   *  is clinically meaningful (it is already a seizure marker), so it is a
   *  first-class output rather than something a consumer has to derive. */
  cornerAsymmetry?: number;
  /** Interocular distance in aspect-corrected normalized units. The scale
   *  everything above is divided by; also a proxy for how close the face is. */
  interocular?: number;
}

/** Distance between two points, with x scaled to cancel frame anisotropy. */
function dist(a: Point2, b: Point2, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

/**
 * Compute the geometry. `aspect` is frame width / height — pass it, or every
 * ratio is wrong by that factor (see the anisotropy warning at the top).
 *
 * Roll is cancelled by construction rather than by rotating the point set:
 * every measurement is either a distance (roll invariant) or is projected onto
 * the mouth's own axis. That is cheaper, and it cannot be silently skipped by a
 * later edit the way a separate "align first" step could.
 */
export function computeGeometry(
  lm: FaceLandmarkSet | null | undefined,
  aspect: number = 1,
): FaceGeometry {
  if (!lm) return {};
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const g: FaceGeometry = {};

  const eyeInnerR = lm.eyeInnerRight, eyeInnerL = lm.eyeInnerLeft;
  if (!eyeInnerR || !eyeInnerL) return g;
  const io = dist(eyeInnerR, eyeInnerL, a);
  if (!(io > 1e-6)) return g;
  g.interocular = io;

  // Eye aspect ratio, the standard 6-point form: mean of two vertical lid
  // separations over the horizontal corner separation.
  const ear = (
    outer?: Point2, inner?: Point2,
    upA?: Point2, loA?: Point2, upB?: Point2, loB?: Point2,
  ): number | undefined => {
    if (!outer || !inner || !upA || !loA || !upB || !loB) return undefined;
    const h = dist(outer, inner, a);
    if (!(h > 1e-6)) return undefined;
    return (dist(upA, loA, a) + dist(upB, loB, a)) / (2 * h);
  };
  g.eyeAspectRight = ear(lm.eyeOuterRight, lm.eyeInnerRight, lm.eyeRUpperA, lm.eyeRLowerA, lm.eyeRUpperB, lm.eyeRLowerB);
  g.eyeAspectLeft = ear(lm.eyeOuterLeft, lm.eyeInnerLeft, lm.eyeLUpperA, lm.eyeLLowerA, lm.eyeLUpperB, lm.eyeLLowerB);

  const cR = lm.mouthCornerRight, cL = lm.mouthCornerLeft;
  const lipUp = lm.lipUpperInner, lipLo = lm.lipLowerInner;
  if (cR && cL) {
    const width = dist(cR, cL, a);
    g.mouthWidth = width / io;

    if (lipUp && lipLo && width > 1e-6) {
      g.mouthAspect = dist(lipUp, lipLo, a) / width;

      // Lip-corner elevation, measured along the normal to the EYE LINE.
      //
      // ⚠️ The reference axis must be RIGID. Measuring each corner against the
      // mouth's own corner-to-corner axis is the obvious thing to write and it
      // is identically useless: both corners lie ON that axis by construction,
      // so their offsets from it are always equal and the asymmetry is exactly
      // zero for every face, including a hemifacial one. The eye line is the
      // right reference — it rolls with the head, so the measurement stays
      // roll-invariant, but it does not move with the mouth.
      const ax = (eyeInnerL.x - eyeInnerR.x) * a, ay = eyeInnerL.y - eyeInnerR.y;
      const alen = Math.hypot(ax, ay);
      if (alen > 1e-6) {
        // Unit normal to the eye line, oriented to point UP the FACE (away from
        // the chin) rather than up the image, so a rolled or inverted head does
        // not flip the sign.
        let px = ay / alen, py = -ax / alen;
        const eyeMidX = ((eyeInnerR.x + eyeInnerL.x) / 2) * a, eyeMidY = (eyeInnerR.y + eyeInnerL.y) / 2;
        const chin = lm.chin;
        const downX = chin ? chin.x * a - eyeMidX : 0;
        const downY = chin ? chin.y - eyeMidY : 1;
        if (px * downX + py * downY > 0) { px = -px; py = -py; }

        const mx = ((lipUp.x + lipLo.x) / 2) * a, my = (lipUp.y + lipLo.y) / 2;
        const elev = (p: Point2) => ((p.x * a - mx) * px + (p.y - my) * py) / io;
        g.lipCornerElevLeft = elev(cL);
        g.lipCornerElevRight = elev(cR);
        g.cornerAsymmetry = g.lipCornerElevLeft - g.lipCornerElevRight;
      }
    }
  }

  const gap = (brow?: Point2, lid?: Point2): number | undefined =>
    brow && lid ? dist(brow, lid, a) / io : undefined;
  g.browLidGapRight = gap(lm.browRight, lm.eyeRLid);
  g.browLidGapLeft = gap(lm.browLeft, lm.eyeLLid);

  return g;
}

// ---------------------------------------------------------------------------
// Quality (D4)
// ---------------------------------------------------------------------------

export interface QualityInputs {
  /** Face box as a fraction of the frame. */
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  /** Head pose, tracker units. A face turned far away cannot be read. */
  headPose?: { yaw: number; pitch: number; roll: number } | null;
  /** Mean landmark displacement since the previous frame, aspect-corrected and
   *  divided by interocular. High = motion blur or a tracker losing the face.
   *  Undefined = unknown, which is NOT penalised — see the note below. */
  jitter?: number;
  /** False when the tracker produced no face this tick. */
  present: boolean;
}

export interface FaceQuality {
  /** 0..1. Below QUALITY_MIN_READ nothing about expression may be asserted. */
  score: number;
  /** Why it is low, for the scene line and for debugging. Empty when fine. */
  reasons: string[];
}

/** Face box shorter than this (fraction of frame height) is too small to read
 *  low-intensity expression from. */
export const QUALITY_MIN_FACE_HEIGHT = 0.16;
/** Beyond this deviation the far half of the face is foreshortened enough that
 *  sided channels stop meaning anything. Tracker units, roughly 30°. */
export const QUALITY_MAX_POSE = 0.45;
/** Per-frame landmark displacement (interocular units) above which the frame is
 *  motion-blurred or the tracker is sliding. */
export const QUALITY_MAX_JITTER = 0.12;
/** Below this, downstream must report "cannot read", never "neutral". */
export const QUALITY_MIN_READ = 0.35;

/** Linear 1→0 ramp: full marks at or below `good`, zero at or above `bad`.
 *  An unknown input scores 1 — a missing measurement is not evidence of a
 *  problem, and penalising it would make every client without landmarks look
 *  permanently unreadable. */
function ramp(v: number | undefined, good: number, bad: number): number {
  if (v === undefined || !Number.isFinite(v)) return 1;
  if (v <= good) return 1;
  if (v >= bad) return 0;
  return 1 - (v - good) / (bad - good);
}

/**
 * How much of this frame is worth believing. The PRODUCT of independent
 * penalties, not a mean — a face that is perfectly lit but 70° away is not
 * "half readable", it is unreadable, and averaging would hide that.
 *
 * Luminance and contrast are not inputs: this layer never sees pixels. A badly
 * lit face reaches us as landmark jitter and a shrinking blendshape range, both
 * of which are covered, but a dedicated luminance term would need the frame and
 * belongs with the capture harness.
 */
export function computeQuality(q: QualityInputs): FaceQuality {
  if (!q.present) return { score: 0, reasons: ["no face detected"] };
  const reasons: string[] = [];

  const h = q.boundingBox?.height;
  // Scored on how far the face falls SHORT of the minimum height: at the
  // minimum it scores 1, at less than half of it, 0.
  let size = 1;
  if (h !== undefined && h > 0) {
    size = ramp(QUALITY_MIN_FACE_HEIGHT / h, 1, 2.2);
    if (h < QUALITY_MIN_FACE_HEIGHT) reasons.push("face small in frame");
  }

  let pose = 1;
  if (q.headPose) {
    const off = Math.max(Math.abs(q.headPose.yaw), Math.abs(q.headPose.pitch));
    pose = ramp(off, QUALITY_MAX_POSE * 0.55, QUALITY_MAX_POSE);
    if (pose < 1) reasons.push("face turned away");
  }

  const jit = ramp(q.jitter, QUALITY_MAX_JITTER * 0.4, QUALITY_MAX_JITTER);
  if (jit < 1) reasons.push("motion blur");

  const score = Math.max(0, Math.min(1, size * pose * jit));
  return { score, reasons: score >= QUALITY_MIN_READ ? [] : reasons };
}

/**
 * Mean landmark displacement between two subsets, in interocular units — the
 * jitter input above. Returns undefined when the sets are not comparable, which
 * must be read as "unknown", not as "still".
 */
export function landmarkJitter(
  prev: FaceLandmarkSet | null | undefined,
  next: FaceLandmarkSet | null | undefined,
  aspect: number,
  interocular: number | undefined,
): number | undefined {
  if (!prev || !next || !interocular || !(interocular > 1e-6)) return undefined;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let sum = 0, n = 0;
  for (const name of Object.keys(FACE_LANDMARK_INDICES) as FaceLandmarkName[]) {
    const p = prev[name], q = next[name];
    if (!p || !q) continue;
    sum += dist(p, q, a);
    n++;
  }
  return n ? sum / n / interocular : undefined;
}
