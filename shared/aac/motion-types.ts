// shared/aac/motion-types.ts
//
// The sensor-agnostic vocabulary the seizure DSP speaks. Split out of
// seizure-signature.ts so the marker module and the config module can both
// depend on it without an import cycle.
//
// WHY THIS EXISTS (the close-camera problem): the original DSP consumed
// PoseLandmarker frames directly and derived everything — scale, anchor,
// regions — from shoulders and hips. At the AAC's actual camera geometry (a
// tablet/kiosk an arm's length away) hips are out of frame and elbows/wrists
// usually are too, so the body model degenerates: the arm "regions" collapse to
// the shoulder points, their relative positions go constant, and the
// bilateral-symmetry correlation that gates the convulsive call falls to zero.
// The detector could not fire no matter what the student did.
//
// The fix is to stop treating pose as the source and treat it as ONE source. A
// MotionFrame is whatever the client could see this instant — a head point from
// the face tracker, hand centroids from the hand tracker, arms/torso from pose
// when it happens to resolve, coarse ROI energies from raw pixels — each region
// OPTIONAL, all normalized by a scale the SOURCE chose (it knows whether it is
// looking at a face or a whole body). Absent means "not observed", never "zero".

/** Kinematic regions the DSP scores motion for. `head` and `torso` are the
 *  AXIAL pair — involvement of either is what separates a convulsion from
 *  distal hand stereotypy, and at close range `head` is the one that survives.
 *  Facial SEMIOLOGY (eye deviation, jaw, blink) is deliberately NOT a region:
 *  it isn't a point that moves, it's a separate channel (see FacialSample). */
export type Region = "head" | "torso" | "leftArm" | "rightArm" | "leftHand" | "rightHand";

export const REGIONS: Region[] = ["head", "torso", "leftArm", "rightArm", "leftHand", "rightHand"];

/** Axial (midline) regions. Involvement of one of these is the extent test that
 *  rejects distal-only hand-wringing — the known mimic in this population. */
export const AXIAL_REGIONS: Region[] = ["head", "torso"];

/** Left/right pairs used for the bilateral-symmetry test, most-distal first.
 *  Hands are preferred over arms because at close range hands are what the
 *  camera actually resolves. */
export const BILATERAL_PAIRS: Array<[Region, Region]> = [
  ["leftHand", "rightHand"],
  ["leftArm", "rightArm"],
];

export const isAxial = (r: Region): boolean => AXIAL_REGIONS.includes(r);

/** A single observed point, in raw normalized frame coords (0..1, y down). */
export interface MotionPoint { x: number; y: number }

/**
 * Face-derived SEMIOLOGY sample. These are the signs a body skeleton structurally
 * cannot see, and they are exactly the ones a close front camera sees best:
 * forced eye deviation (version), forced jaw opening, eyelid myoclonia,
 * unilateral facial involvement. All scalars 0..1 unless noted.
 */
export interface FacialSample {
  /** Rigid head orientation. yaw +right / -left from the SUBJECT's perspective,
   *  pitch +down / -up, roll in radians (+ = subject's right ear down). */
  yaw: number;
  pitch: number;
  roll: number;
  /** Forced jaw opening — tonic-phase mouth pull, or the chewing half of an
   *  oral automatism when it oscillates. */
  jawOpen: number;
  /** Per-eye lid closure. Rhythmic co-oscillation = eyelid myoclonia; both
   *  pinned near zero for a long stretch = the unblinking stare of arrest. */
  eyeBlinkLeft: number;
  eyeBlinkRight: number;
  /** Gaze offset from centre. SAME sign convention as `yaw`: gazeX + = subject
   *  looking to THEIR right, - = their left; gazeY + = down. Derived from the
   *  eyeLookIn/Out/Up/Down blendshape quartet, so it is a lid/iris estimate,
   *  not a calibrated gaze. */
  gazeX: number;
  gazeY: number;
  /** 0..1 left-vs-right disagreement across paired expression blendshapes.
   *  Sustained high = unilateral facial involvement (a focal-onset cue). */
  asymmetry: number;
}

/**
 * One instant, from whatever sensors resolved. `regions` is sparse on purpose.
 *
 * `anchor` and `scale` come from the SOURCE: positions are made relative to the
 * anchor and divided by the scale before any frequency/phase maths, so a child
 * sitting closer to the camera does not read as more motion. The old code
 * derived scale from the shoulder→hip span and silently fell back to a CONSTANT
 * 0.3 once hips left frame — which is the normal case here, and it meant every
 * displacement threshold was being compared against a fiction.
 */
export interface MotionFrame {
  ts: number;
  regions: Partial<Record<Region, MotionPoint>>;
  /** Reference point subtracted for relative motion (typically the face centre,
   *  else the shoulder midpoint). Null → positions are used as-is, which lets
   *  gross translation leak in, so sources should supply one. */
  anchor?: MotionPoint | null;
  /** Normalizing length in frame units (face width, else torso/shoulder span).
   *  Sources MUST supply a real measurement; the DSP clamps it to a floor. */
  scale?: number;
  /** Semiology channel, when a face was tracked this instant. */
  facial?: FacialSample | null;
  /** Coarse dense-motion energies per ROI from raw pixel differencing, when the
   *  motion-field source is running. Landmark-free, so it survives the motion
   *  blur and hand-crossing that break the hand tracker exactly when it matters.
   *  Units are mean per-second luma change, already rate-normalized. */
  field?: MotionFieldSample | null;
}

/** Dense per-ROI motion energy from frame differencing. No landmarks involved. */
export interface MotionFieldSample {
  /** Whole-frame mean. */
  overall: number;
  /** Band containing the tracked face. */
  head: number;
  /** Band below the face — where hands/arms live at this camera distance. */
  lower: number;
  /** Left and right halves, from the SUBJECT's perspective (already un-mirrored
   *  by the source), for a landmark-free lateralization read. */
  left: number;
  right: number;
}

/** Legacy pose-landmark frame. Still accepted by analyzeWindow (adapted
 *  internally) so the existing pose path and its tests keep working. */
export interface PoseFrame {
  ts: number;
  landmarks: Array<{ x: number; y: number; visibility?: number }>;
}

/** Per-student habitual-motion model: an EWMA of quiet-period region energy, so
 *  a child's normal stereotypy level becomes the reference a seizure must
 *  exceed. Sensor-agnostic by design (a wearable updates the same shape).
 *  `samples` gates cold-start — the detector is inert until this is warm. */
export interface MotionBaseline {
  regionEnergy: Partial<Record<Region, number>>;
  /** How many windows have been folded in. */
  samples: number;
  /** Per-region observation counts — a region only present for part of the
   *  session (a hand that comes and goes) must not be judged against a baseline
   *  built mostly from frames where it was missing. */
  regionSamples?: Partial<Record<Region, number>>;
}
