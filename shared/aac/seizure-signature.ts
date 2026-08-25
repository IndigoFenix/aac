// shared/aac/seizure-signature.ts
//
// PROTOTYPE — quantified motion signature for seizure-like events, a sibling of
// pose-classify.ts. Pure (no deps) so the client derives it and server tests
// cover the risky classification. Like every pose reading in this codebase, the
// output is a HINT the Observer adjudicates against the student's profile —
// NEVER a diagnosis and NEVER an auto-alarm.
//
// Why this exists: the Observer judges seizures off ~4 fps JPEG frames. Clonic
// jerking is 2–5 Hz (Nyquist needs ≥10 fps) and, critically, Rett's hand
// stereotypies are THEMSELVES rhythmic at ~2–3 Hz — so frequency alone is
// useless. This module computes the discriminators that actually separate a
// tonic-clonic from baseline stereotypy: spatial EXTENT (axial vs. distal),
// bilateral SYMMETRY, and energy ANOMALY vs. THIS student's habitual motion.
//
// ── 2026-08 rework: face-first, pose-optional ───────────────────────────────
// The original version read PoseLandmarker frames and derived scale, anchor and
// every region from shoulders and hips. At the AAC's REAL camera geometry — a
// screen an arm's length from the child's face — hips are out of frame and
// elbows/wrists usually are too. The consequences were not graceful degradation:
//
//   * torsoScale() fell through to a CONSTANT 0.3, so every displacement
//     threshold was measured against a fiction.
//   * each arm "region" collapsed to its shoulder point, whose offset from the
//     shoulder midpoint is near-constant, so the bilateral-symmetry correlation
//     went to ~0 and the convulsive gate could not pass. The detector was inert
//     in the field regardless of thresholds.
//   * the atonic drop was thresholded in FRAME fractions, so a close camera
//     inflated every apparent movement against a fixed bar.
//
// The rework keeps the discriminators and re-sources them. Input is now a
// sensor-agnostic MotionFrame (see motion-types.ts): the FACE tracker supplies
// the head point plus the scale and anchor, the HAND tracker supplies hand
// centroids, and pose contributes torso/arms only WHEN IT RESOLVES — it is
// strictly additive and never required. The head is the axial channel, which is
// the hinge of the whole thing: rhythmic head involvement in phase with the
// hands is the convulsive signature, while Rett hand-wringing happens with a
// relatively still head oriented at the screen. So the stereotypy discriminator
// survives the loss of the torso.
//
// The face also carries SEMIOLOGY no skeleton can see — forced eye deviation,
// forced jaw opening, eyelid myoclonia, unilateral facial involvement. Those are
// deliberately NOT escalation paths (this population's baseline facial motor
// patterns are too atypical for a generic sign to be specific); they raise
// SUSPICION, which buys a closer look at a higher frame rate, and they annotate
// a summary once something else escalates. The one per-student exception is a
// clinician-recorded marker — see seizure-markers.ts.

import { POSE_IDX, VIS_MIN, type PoseLandmark } from "./pose-classify";
import type { SeizureThresholds } from "./seizure-config";
import {
  REGIONS, AXIAL_REGIONS, BILATERAL_PAIRS, isAxial,
  type Region, type MotionFrame, type MotionPoint, type FacialSample,
  type MotionBaseline, type PoseFrame,
} from "./motion-types";
import {
  evaluateMarkers,
  EYE_DEVIATION_MIN, HEAD_TURN_MIN, JAW_OPEN_MIN, ASYMMETRY_MIN,
  FLUTTER_HZ_MIN, FLUTTER_HZ_MAX, FLUTTER_RHYTHMICITY_MIN, MARKER_SUSTAIN_FRAC,
  type SeizureMarker, type MatchedMarker, type MarkerContext,
} from "./seizure-markers";

// Re-exported so existing importers keep working after the type split.
export type { Region, MotionFrame, MotionPoint, FacialSample, MotionBaseline, PoseFrame };
export { REGIONS, AXIAL_REGIONS, isAxial };

export type SeizurePhase = "none" | "clonic" | "atonic" | "postictal";

/** Generic face-derived signs. Annotation + suspicion only — never a standalone
 *  escalation (see the header note on specificity in this population). */
export type FacialSign =
  | "eye_deviation" | "head_version" | "jaw_forced_open"
  | "oral_automatism" | "eye_flutter" | "facial_asymmetry" | "unblinking_stare";

export interface SeizureSignature {
  phase: SeizurePhase;
  /** Dominant oscillation frequency of the most-active region (Hz), 0 if none. */
  dominantHz: number;
  /** Spectral concentration 0..1 — how rhythmic (peaked) vs. chaotic the motion
   *  is. Stereotypy AND clonic are both high here; this alone does not separate
   *  them (extent + symmetry + anomaly do). */
  rhythmicity: number;
  /** Left-vs-right energy correlation, clamped 0..1. High = the two sides jerk
   *  together (a tonic-clonic cue; most stereotypy is not bilaterally
   *  synchronous). Meaningless unless `symmetryEvaluable`. */
  bilateralSymmetry: number;
  /** True only when symmetry was actually MEASURED. The old code reported 0 for
   *  every unmeasurable case and the gate read that as "asymmetric", which is
   *  how a one-sided camera view silently disabled the detector. Callers MUST
   *  NOT treat a 0 value as evidence — check this first. */
  symmetryEvaluable: boolean;
  /** Why, when it wasn't measured — see SymmetryState. `en_bloc` is a finding
   *  in its own right (whole-body rocking), not a missing measurement. */
  symmetryState: SymmetryState;
  /** Regions whose energy exceeds the involvement multiple of baseline — the
   *  EXTENT discriminator (distal-only = stereotypy-like; +head/+torso = axial). */
  involvedRegions: Region[];
  /** Regions actually OBSERVED this window (sensor present), for debugging the
   *  "nothing ever fires" case. */
  observedRegions: Region[];
  /** Peak region energy as a multiple of that region's baseline. */
  energyVsBaseline: number;
  /** Span of the analyzed window (ms). Persistence across windows is tracked by
   *  the caller (the hook), not here. */
  durationMs: number;
  /** 0..1 confidence this window looks like a seizure-class event (NOT a
   *  probability, NOT a diagnosis — a ranking signal for the Observer). */
  confidence: number;
  /** True when the atonic phase came from a SUDDEN collapse (a drop attack)
   *  rather than mere sustained stillness. */
  atonicDrop?: boolean;
  /** Face-derived signs sustained across the window. */
  facialSigns: FacialSign[];
  /** Per-student markers that matched (clinician's own descriptions). */
  matchedMarkers: MatchedMarker[];
  /** True when the ONLY reason to escalate is a strong per-student marker —
   *  the generic detector found nothing. Drives a distinct summary line. */
  markerOnly: boolean;
  /** Raw per-region mean energy, for telemetry/threshold tuning. */
  regionEnergy: Partial<Record<Region, number>>;
}

// ── Tunables (in SUBJECT-SCALE units — face widths, or torso span when pose is
// the source — NOT frame fractions; see the header note on the drop bug) ──────
// Deliberately tuned toward HIGH sensitivity: better to surface a borderline
// pattern (the Observer adjudicates, and false positives are cheap) than to miss
// a real event.
/** Clonic band. Widened low so slower convulsive shaking still qualifies. */
export const CLONIC_HZ_MIN = 1.5;
export const CLONIC_HZ_MAX = 7;
/** Energy must be at least this multiple of baseline to count as "involved". */
export const INVOLVEMENT_MULT = 1.8;
/** Rhythmicity floor for a clonic call. */
export const RHYTHMIC_MIN = 0.25;
/** Confidence floor below which a clonic call isn't worth escalating a frame. */
export const ESCALATE_CONFIDENCE = 0.28;
/** Bilateral-symmetry floor, applied ONLY when symmetry is evaluable. */
export const SYMMETRY_MIN = 0.3;
/** A clonic call needs at least this many involved regions AND ≥1 axial. */
export const MIN_INVOLVED_REGIONS = 2;
/** Energy below this multiple of baseline reads as the flat post-ictal state. */
export const FLAT_ENERGY_MULT = 0.4;
/** Downward anchor displacement in SUBJECT-SCALE units within ATONIC_WINDOW_MS
 *  that — if it PERSISTS — reads as a sudden collapse. ~0.5 face widths. */
export const ATONIC_DROP = 0.5;
export const ATONIC_WINDOW_MS = 1000;
/** Baseline EWMA weight. */
const BASELINE_ALPHA = 0.1;
/** Floor so a perfectly still baseline doesn't make energyVsBaseline explode. */
const ENERGY_FLOOR = 1e-4;
/** Scale floor — a degenerate/zero scale would divide displacements to infinity. */
const SCALE_FLOOR = 0.02;
/** Lids under this for essentially the whole window = unblinking stare. */
const STARE_LID_MAX = 0.12;
const STARE_MIN_MS = 3500;
/** Oral-automatism (chewing/lip-smacking) band. */
const ORAL_HZ_MIN = 0.5;
const ORAL_HZ_MAX = 3;

const vis = (p?: PoseLandmark): number => (p ? p.visibility ?? 1 : 0);

// ── Pose adaptation (legacy input) ───────────────────────────────────────────

/** Landmark indices contributing to each pose-derived region. Hands fold into
 *  the arm regions via the wrist — a pose frame has no hand detail. */
const POSE_REGION_LANDMARKS: Partial<Record<Region, number[]>> = {
  head: [POSE_IDX.nose, POSE_IDX.leftEar, POSE_IDX.rightEar],
  leftArm: [POSE_IDX.leftShoulder, POSE_IDX.leftElbow, POSE_IDX.leftWrist],
  rightArm: [POSE_IDX.rightShoulder, POSE_IDX.rightElbow, POSE_IDX.rightWrist],
  torso: [POSE_IDX.leftShoulder, POSE_IDX.rightShoulder, POSE_IDX.leftHip, POSE_IDX.rightHip],
};

/** Mean of a pose region's VISIBLE landmarks, or undefined. */
function poseRegionPoint(lm: PoseLandmark[], region: Region): MotionPoint | undefined {
  const idxs = POSE_REGION_LANDMARKS[region];
  if (!idxs) return undefined;
  let sx = 0, sy = 0, n = 0;
  for (const i of idxs) {
    const p = lm[i];
    if (!p || vis(p) < VIS_MIN) continue;
    sx += p.x; sy += p.y; n++;
  }
  return n === 0 ? undefined : { x: sx / n, y: sy / n };
}

/**
 * Every scale in this module is expressed in FACE WIDTHS, because the face is
 * the primary source and the one sensor that is reliably present. A pose frame
 * measures the subject in torso spans instead, so it must be converted or the
 * SAME threshold would mean two different real distances depending on which
 * tracker happened to supply the scale that frame — and a drop threshold that
 * changes meaning with the sensor is the frame-fraction bug wearing a hat.
 *
 * Anthropometric approximation for this population (young children, and Rett
 * frequently involves acquired microcephaly, so the ratio runs lower than the
 * ~3.2 typical of adults). One named constant beats two unit systems.
 */
export const POSE_SPAN_PER_FACE_WIDTH = 2.5;

/** Subject scale from a pose frame, in FACE WIDTHS: shoulder→hip span (else
 *  shoulder width) converted via POSE_SPAN_PER_FACE_WIDTH. Returns undefined
 *  rather than a constant when neither resolves — a made-up scale is worse than
 *  an absent one, because it silently rescales every threshold (the original bug). */
function poseScale(lm: PoseLandmark[]): number | undefined {
  const ls = lm[POSE_IDX.leftShoulder], rs = lm[POSE_IDX.rightShoulder];
  const lh = lm[POSE_IDX.leftHip], rh = lm[POSE_IDX.rightHip];
  if (ls && rs && lh && rh && vis(ls) >= VIS_MIN && vis(rs) >= VIS_MIN && vis(lh) >= VIS_MIN && vis(rh) >= VIS_MIN) {
    const len = Math.hypot((lh.x + rh.x) / 2 - (ls.x + rs.x) / 2, (lh.y + rh.y) / 2 - (ls.y + rs.y) / 2);
    if (len > 0.05) return len / POSE_SPAN_PER_FACE_WIDTH;
  }
  if (ls && rs && vis(ls) >= VIS_MIN && vis(rs) >= VIS_MIN) {
    const w = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    // Shoulder width runs close to the shoulder→hip span, so the same divisor
    // is the right order of magnitude for this fallback too.
    if (w > 0.03) return w / POSE_SPAN_PER_FACE_WIDTH;
  }
  return undefined;
}

/** Adapt a legacy PoseFrame into a MotionFrame. */
export function poseFrameToMotion(f: PoseFrame): MotionFrame {
  const lm = f.landmarks;
  const regions: Partial<Record<Region, MotionPoint>> = {};
  for (const r of REGIONS) {
    const p = poseRegionPoint(lm, r);
    if (p) regions[r] = p;
  }
  return { ts: f.ts, regions, anchor: regions.torso ?? null, scale: poseScale(lm) };
}

const isPoseFrame = (f: PoseFrame | MotionFrame): f is PoseFrame =>
  Array.isArray((f as PoseFrame).landmarks);

/** Accept either input shape so the pose path and its tests keep working. */
export function toMotionFrames(frames: Array<PoseFrame | MotionFrame>): MotionFrame[] {
  return frames.map(f => (isPoseFrame(f) ? poseFrameToMotion(f) : f));
}

// ── Series construction ──────────────────────────────────────────────────────

/** Effective scale for a frame, floored. Falls back to the window median so a
 *  single frame that lost its scale doesn't spike the derived motion. */
function frameScale(f: MotionFrame, fallback: number): number {
  const s = f.scale && f.scale > 0 ? f.scale : fallback;
  return Math.max(s, SCALE_FLOOR);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Per-region energy series: scale-normalized speed PER SECOND (displacement ÷
 * dt), NOT per frame — so the reading is frame-rate-invariant. This matters
 * because the seizure watch bumps the tracker rate: a baseline learned at 2.5
 * fps must stay comparable to a window sampled at 15 fps, or energyVsBaseline
 * would collapse exactly when we look closest.
 *
 * Sparse-safe: only consecutive frames where the region is present in BOTH
 * contribute. A region that came and went yields a shorter series, not zeros —
 * zeros would read as stillness and poison the baseline.
 */
function energySeries(frames: MotionFrame[], scaleFallback: number): Partial<Record<Region, number[]>> {
  const out: Partial<Record<Region, number[]>> = {};
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    const dtSec = Math.max((b.ts - a.ts) / 1000, 1e-3);
    const scale = frameScale(b, scaleFallback);
    for (const r of REGIONS) {
      const pa = a.regions[r], pb = b.regions[r];
      if (!pa || !pb) continue;
      const v = Math.hypot(pb.x - pa.x, pb.y - pa.y) / scale / dtSec;
      (out[r] ??= []).push(v);
    }
  }
  return out;
}

/**
 * Regions measured in ABSOLUTE (scale-normalized but un-anchored) position.
 *
 * Only the head — and this is load-bearing. The anchor is normally the face
 * centre, so subtracting it from the head point cancels head motion EXACTLY:
 * the nose and the face box translate together, the relative series goes
 * constant, its autocorrelation returns 0 Hz, and the convulsive gate can never
 * pass on a head-led event. That would have quietly re-broken the axial channel
 * that this whole rework exists to restore.
 *
 * The anchor subtraction is still right for LIMBS — it is what stops a
 * wheelchair rolling or a child leaning in from reading as arm oscillation. For
 * the head, gross translation IS the signal. Rolling is not re-admitted as a
 * false positive by this: it moves the head alone, and a convulsive call needs
 * two involved regions, one of them axial.
 */
const ABSOLUTE_REGIONS: Region[] = ["head"];

/**
 * Signed per-region POSITION series, scale-normalized — the basis for frequency
 * and phase. (The speed-magnitude energy series rectifies, so it
 * frequency-doubles and loses phase.) Anchor-relative for limbs, absolute for
 * the regions listed above.
 */
function relativePosSeries(frames: MotionFrame[], scaleFallback: number): Partial<Record<Region, { x: number[]; y: number[] }>> {
  const out: Partial<Record<Region, { x: number[]; y: number[] }>> = {};
  for (const f of frames) {
    const scale = frameScale(f, scaleFallback);
    const anchor = f.anchor;
    for (const r of REGIONS) {
      const p = f.regions[r];
      if (!p) continue;
      const abs = ABSOLUTE_REGIONS.includes(r);
      const ox = abs ? 0 : (anchor?.x ?? 0);
      const oy = abs ? 0 : (anchor?.y ?? 0);
      const s = (out[r] ??= { x: [], y: [] });
      s.x.push((p.x - ox) / scale);
      s.y.push((p.y - oy) / scale);
    }
  }
  return out;
}

/**
 * ABSOLUTE vertical series (anchor y, or head y) in SUBJECT-SCALE units — the
 * basis for drop detection. Deliberately NOT anchor-relative: when the anchor is
 * the face centre, a body collapsing takes the anchor with it, so the relative
 * series shows nothing at all. Scale-normalized so the threshold is "half a face
 * width", not "8% of the frame", which is what made the old detector fire
 * differently depending on how close the child was sitting.
 */
function absoluteVerticalSeries(frames: MotionFrame[], scaleFallback: number): Array<{ ts: number; y: number }> {
  const out: Array<{ ts: number; y: number }> = [];
  for (const f of frames) {
    const p = f.anchor ?? f.regions.head ?? f.regions.torso;
    if (!p) continue;
    out.push({ ts: f.ts, y: p.y / frameScale(f, scaleFallback) });
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
}

/** Pearson correlation of two equal-length series, 0 if undefined. */
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da <= 0 || db <= 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Dominant frequency + rhythmicity via autocorrelation of the de-meaned series.
 * rhythmicity = the peak's normalized height (0..1). Cheaper and more robust
 * than an FFT for these short windows.
 */
export function dominantFrequency(series: number[], meanDtMs: number): { hz: number; rhythmicity: number } {
  const n = series.length;
  if (n < 6 || meanDtMs <= 0) return { hz: 0, rhythmicity: 0 };
  const m = mean(series);
  const x = series.map(v => v - m);
  const energy0 = x.reduce((a, b) => a + b * b, 0);
  if (energy0 <= 0) return { hz: 0, rhythmicity: 0 };

  const maxLag = Math.floor(n / 2);
  const ac: number[] = [0];
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac.push(s / energy0);
  }
  // The fundamental period is the FIRST autocorrelation peak after the central
  // lobe — NOT the global max, which lands on a harmonic (2×/3× the period) and
  // halves the reported frequency. Wait for the descent to cross below zero,
  // then return the first local maximum.
  let crossed = false;
  for (let lag = 1; lag < ac.length; lag++) {
    if (!crossed) { if (ac[lag] < 0) crossed = true; continue; }
    const isPeak = ac[lag] > ac[lag - 1] && (lag + 1 >= ac.length || ac[lag] >= ac[lag + 1]);
    if (isPeak && ac[lag] > 0) {
      const periodMs = lag * meanDtMs;
      return { hz: periodMs > 0 ? 1000 / periodMs : 0, rhythmicity: Math.max(0, Math.min(1, ac[lag])) };
    }
  }
  return { hz: 0, rhythmicity: 0 };
}

/** Mean inter-frame dt (ms) across the window. */
function meanDt(frames: MotionFrame[]): number {
  if (frames.length < 2) return 0;
  return (frames[frames.length - 1].ts - frames[0].ts) / (frames.length - 1);
}

/**
 * Why symmetry could not be measured — the three cases mean completely
 * different things and collapsing them is how this detector goes wrong.
 *
 *  - `measured`   — both sides moved relative to the body; the correlation is
 *                   real evidence either way.
 *  - `unobserved` — a side was out of frame. We know NOTHING. The gate must be
 *                   SKIPPED; treating this as asymmetry is what made the old
 *                   detector unable to fire at a close camera distance.
 *  - `en_bloc`    — both sides were in view but neither moved relative to the
 *                   body: the whole subject is translating as one rigid mass.
 *                   That is evidence AGAINST a convulsion — a tonic-clonic
 *                   jerks the limbs relative to the trunk — and it is the
 *                   signature of ROCKING, a common self-soothing movement in
 *                   this population. So it FAILS the gate rather than skipping
 *                   it, and only raises suspicion.
 */
export type SymmetryState = "measured" | "unobserved" | "en_bloc";

/** Relative-position variance below this reads as "not moving relative to the
 *  body" (in face widths — roughly 3mm of real travel). */
const EN_BLOC_VARIANCE = 4e-4;

/**
 * Bilateral symmetry from the most distal pair BOTH sides of which were seen.
 * Hands first (what a close camera actually resolves), then arms.
 */
function bilateralSymmetryOf(
  relPos: Partial<Record<Region, { x: number[]; y: number[] }>>,
): { value: number; state: SymmetryState } {
  let sawPair = false;
  for (const [l, r] of BILATERAL_PAIRS) {
    const ls = relPos[l], rs = relPos[r];
    if (!ls || !rs || ls.x.length < 3 || rs.x.length < 3) continue;
    sawPair = true;
    // Both sides static relative to the anchor → en bloc, not limb jerking.
    // Check both axes: a purely vertical bob would leave x flat.
    const moving = (s: { x: number[]; y: number[] }) =>
      variance(s.x) >= EN_BLOC_VARIANCE || variance(s.y) >= EN_BLOC_VARIANCE;
    if (!moving(ls) && !moving(rs)) continue;
    // Signed LATERAL position correlation: in-phase clonic → +1, the anti-phase
    // motion of hand-wringing → −1.
    return { value: Math.max(0, correlation(ls.x, rs.x)), state: "measured" };
  }
  return { value: 0, state: sawPair ? "en_bloc" : "unobserved" };
}

/**
 * Sudden collapse (atonic drop attack): a fast downward displacement within
 * ATONIC_WINDOW_MS that PERSISTS to the end of the window — the persistence
 * check rejects a voluntary lean/reach-and-return bob. Works at the cheap
 * tracker rate; it's a transient, so it doesn't need the high-fps watch the
 * rhythmic path does.
 */
function detectSuddenDrop(verticals: Array<{ ts: number; y: number }>, dropThreshold = ATONIC_DROP): { dropped: boolean; dropFrac: number } {
  if (verticals.length < 3) return { dropped: false, dropFrac: 0 };
  let maxDrop = 0;
  for (let i = 0; i < verticals.length; i++) {
    for (let j = i + 1; j < verticals.length && verticals[j].ts - verticals[i].ts <= ATONIC_WINDOW_MS; j++) {
      const d = verticals[j].y - verticals[i].y; // + = moved DOWN
      if (d > maxDrop) maxDrop = d;
    }
  }
  const net = verticals[verticals.length - 1].y - verticals[0].y;
  return { dropped: maxDrop >= dropThreshold && net >= dropThreshold * 0.5, dropFrac: maxDrop };
}

// ── Facial semiology ─────────────────────────────────────────────────────────

/** Fraction of samples for which `pred` holds. */
function frac(n: number, pred: (i: number) => boolean): number {
  if (n <= 0) return 0;
  let hits = 0;
  for (let i = 0; i < n; i++) if (pred(i)) hits++;
  return hits / n;
}

/**
 * Sustained face-derived signs. ANNOTATION + SUSPICION only. A generic facial
 * sign is not specific enough in this population to escalate on its own — a
 * child concentrating with her mouth open and eyes to one side would trip
 * "jaw + deviation" all day. What these buy is a closer LOOK (they raise
 * suspicion, which bumps the tracker rate) and a richer summary once a real
 * detector fires. Per-student specificity comes from markers instead.
 */
export function deriveFacialSigns(facial: FacialSample[], meanDtMs: number, durationMs: number): FacialSign[] {
  const signs: FacialSign[] = [];
  const n = facial.length;
  if (n < 4) return signs;

  if (frac(n, i => Math.abs(facial[i].gazeX) >= EYE_DEVIATION_MIN) >= MARKER_SUSTAIN_FRAC) signs.push("eye_deviation");
  if (frac(n, i => Math.abs(facial[i].yaw) >= HEAD_TURN_MIN) >= MARKER_SUSTAIN_FRAC) signs.push("head_version");
  if (frac(n, i => facial[i].jawOpen >= JAW_OPEN_MIN) >= MARKER_SUSTAIN_FRAC) signs.push("jaw_forced_open");
  if (frac(n, i => facial[i].asymmetry >= ASYMMETRY_MIN) >= MARKER_SUSTAIN_FRAC) signs.push("facial_asymmetry");

  // Rhythmic jaw at chewing speed = oral automatism (focal impaired-awareness).
  const jaw = dominantFrequency(facial.map(f => f.jawOpen), meanDtMs);
  if (jaw.hz >= ORAL_HZ_MIN && jaw.hz <= ORAL_HZ_MAX && jaw.rhythmicity >= FLUTTER_RHYTHMICITY_MIN) {
    signs.push("oral_automatism");
  }
  // Rhythmic lids faster than voluntary blinking = eyelid myoclonia.
  const lid = dominantFrequency(facial.map(f => (f.eyeBlinkLeft + f.eyeBlinkRight) / 2), meanDtMs);
  if (lid.hz >= FLUTTER_HZ_MIN && lid.hz <= FLUTTER_HZ_MAX && lid.rhythmicity >= FLUTTER_RHYTHMICITY_MIN) {
    signs.push("eye_flutter");
  }
  // Eyes open and essentially unblinking for a long stretch — behavioural
  // arrest. Needs a real span, or a short window between two blinks qualifies.
  if (durationMs >= STARE_MIN_MS
      && frac(n, i => facial[i].eyeBlinkLeft < STARE_LID_MAX && facial[i].eyeBlinkRight < STARE_LID_MAX) >= 0.95) {
    signs.push("unblinking_stare");
  }
  return signs;
}

// ── Baseline ─────────────────────────────────────────────────────────────────

/** Fold a window's region energies into the baseline (call ONLY on windows the
 *  caller believes are quiet/non-event — never during a suspected event, or the
 *  baseline absorbs the seizure and stops being a reference). Only regions
 *  actually OBSERVED are folded in; an absent hand must not teach the baseline
 *  that the student's hands are still. */
export function updateBaseline(baseline: MotionBaseline, regionEnergy: Partial<Record<Region, number>>): MotionBaseline {
  const next: Partial<Record<Region, number>> = { ...baseline.regionEnergy };
  const counts: Partial<Record<Region, number>> = { ...(baseline.regionSamples ?? {}) };
  for (const r of REGIONS) {
    const observed = regionEnergy[r];
    if (observed === undefined) continue;
    const seen = counts[r] ?? 0;
    const prev = next[r];
    next[r] = seen === 0 || prev === undefined ? observed : prev * (1 - BASELINE_ALPHA) + observed * BASELINE_ALPHA;
    counts[r] = seen + 1;
  }
  return { regionEnergy: next, samples: baseline.samples + 1, regionSamples: counts };
}

export function emptyBaseline(): MotionBaseline {
  return { regionEnergy: {}, samples: 0, regionSamples: {} };
}

/**
 * Net downward motion over the last `windowMs`, in SUBJECT-SCALE units. Used to
 * catch a slump that's about to take the body OUT of frame: detectSuddenDrop
 * needs the subject to persist in view to confirm, so a collapse that drops
 * below the camera is exactly the case it misses. Paired with tracker-loss in
 * the hook, even a SMALL downward drift counts — hence the low default.
 */
export function recentDownwardSlump(
  frames: Array<PoseFrame | MotionFrame>, now: number, windowMs = 1500, threshold = 0.15,
): boolean {
  const motion = toMotionFrames(frames).filter(f => now - f.ts <= windowMs);
  if (motion.length < 2) return false;
  const scaleFallback = median(motion.map(f => f.scale ?? 0).filter(s => s > 0)) || 0.2;
  const ys = absoluteVerticalSeries(motion, scaleFallback);
  if (ys.length < 2) return false;
  return ys[ys.length - 1].y - ys[0].y >= threshold;
}

/** Module-constant thresholds = the "medium"-sensitivity defaults. */
export const DEFAULT_THRESHOLDS: SeizureThresholds = {
  rhythmic: { enabled: true, involvementMult: INVOLVEMENT_MULT, escalateConfidence: ESCALATE_CONFIDENCE },
  atonic: { enabled: true, dropFrac: ATONIC_DROP },
  audioCorroboration: true,
};

const emptySignature = (): SeizureSignature => ({
  phase: "none", dominantHz: 0, rhythmicity: 0, bilateralSymmetry: 0, symmetryEvaluable: false,
  symmetryState: "unobserved",
  involvedRegions: [], observedRegions: [], energyVsBaseline: 1, durationMs: 0, confidence: 0,
  facialSigns: [], matchedMarkers: [], markerOnly: false, regionEnergy: {},
});

/**
 * Analyze a rolling window into a SeizureSignature, judged against the student's
 * MotionBaseline. Pure & conservative: it reports metrics and a coarse phase,
 * and leaves the response decision to the Observer.
 *
 * Accepts MotionFrames (face/hand/pose/field fused by the client) or legacy
 * PoseFrames. Needs ≥10 fps to resolve the clonic band (Nyquist); at a coarse
 * tracker cadence dominantHz saturates and clonic won't be called — that's why
 * the watch state bumps the tracker rate.
 */
export function analyzeWindow(
  frames: Array<PoseFrame | MotionFrame>,
  baseline: MotionBaseline,
  thresholds: SeizureThresholds = DEFAULT_THRESHOLDS,
  markers: SeizureMarker[] = [],
): SeizureSignature {
  if (frames.length < 6) return emptySignature();
  const motion = toMotionFrames(frames);

  const durationMs = motion[motion.length - 1].ts - motion[0].ts;
  const dt = meanDt(motion);
  const scaleFallback = median(motion.map(f => f.scale ?? 0).filter(s => s > 0)) || 0.2;

  const series = energySeries(motion, scaleFallback);
  const relPos = relativePosSeries(motion, scaleFallback);
  const facial = motion.map(f => f.facial).filter((f): f is FacialSample => !!f);

  // Only regions actually observed get an energy. `undefined` ≠ 0.
  const regionEnergy: Partial<Record<Region, number>> = {};
  const observedRegions: Region[] = [];
  for (const r of REGIONS) {
    const s = series[r];
    if (!s || !s.length) continue;
    regionEnergy[r] = mean(s);
    observedRegions.push(r);
  }

  const involvementMult = thresholds.rhythmic.involvementMult;
  // Extent: which regions are running hot vs. THIS student's baseline. A region
  // with no baseline history of its own is not judged — we'd be comparing to a
  // floor and every newly-visible hand would read as "involved".
  const ratios: Partial<Record<Region, number>> = {};
  const involvedRegions: Region[] = [];
  for (const r of observedRegions) {
    const seen = baseline.regionSamples?.[r] ?? (baseline.samples > 0 ? baseline.samples : 0);
    if (seen <= 0) continue;
    const base = Math.max(baseline.regionEnergy[r] ?? 0, ENERGY_FLOOR);
    const ratio = (regionEnergy[r] ?? 0) / base;
    ratios[r] = ratio;
    if (ratio >= involvementMult) involvedRegions.push(r);
  }
  const ratioValues = Object.values(ratios) as number[];
  const energyVsBaseline = ratioValues.length ? Math.max(...ratioValues) : 1;

  // Frequency/rhythmicity from the SIGNED relative-position series of the most
  // energetic region, on whichever axis carries the oscillation.
  const hot = observedRegions.reduce<Region | null>(
    (a, b) => (a === null || (regionEnergy[b] ?? 0) > (regionEnergy[a] ?? 0) ? b : a), null);
  let hz = 0, rhythmicity = 0;
  if (hot && relPos[hot]) {
    const rp = relPos[hot]!;
    const axis = variance(rp.x) >= variance(rp.y) ? rp.x : rp.y;
    ({ hz, rhythmicity } = dominantFrequency(axis, dt));
  }

  const sym = bilateralSymmetryOf(relPos);
  const facialSigns = deriveFacialSigns(facial, dt, durationMs);

  const markerCtx: MarkerContext = {
    frames: motion, relPos, regionEnergy, facial, dominantFrequency, meanDtMs: dt,
  };
  const matchedMarkers = markers.length ? evaluateMarkers(markers, markerCtx) : [];

  // ── Phase decision (coarse, conservative) ──────────────────────────────────
  const energyValues = Object.values(regionEnergy) as number[];
  const absEnergy = energyValues.length ? Math.max(...energyValues) : 0;
  const baseValues = REGIONS.map(r => baseline.regionEnergy[r] ?? 0);
  const baselineActive = Math.max(...baseValues, 0) > ENERGY_FLOOR * 5;
  const isFlat = baseline.samples > 0 && baselineActive
    && energyVsBaseline <= FLAT_ENERGY_MULT && absEnergy < ENERGY_FLOOR * 5;

  const verticals = absoluteVerticalSeries(motion, scaleFallback);
  const drop = thresholds.atonic.enabled
    ? detectSuddenDrop(verticals, thresholds.atonic.dropFrac)
    : { dropped: false, dropFrac: 0 };

  // The convulsive gate. Symmetry is required where it can be MEASURED, skipped
  // where a side was simply out of frame (no evidence either way — demanding it
  // there would reinstate the bug this rework exists to fix), and FAILED when
  // the subject is moving en bloc (rigid whole-body translation is rocking, not
  // limb jerking). Axial involvement remains mandatory — it is the last
  // discriminator against symmetric distal hand-wringing.
  const symmetryOk =
    sym.state === "unobserved" ? true
    : sym.state === "en_bloc" ? false
    : sym.value >= SYMMETRY_MIN;
  const clonicShape =
    thresholds.rhythmic.enabled &&
    hz >= CLONIC_HZ_MIN && hz <= CLONIC_HZ_MAX &&
    rhythmicity >= RHYTHMIC_MIN &&
    symmetryOk &&
    involvedRegions.length >= MIN_INVOLVED_REGIONS &&
    involvedRegions.some(isAxial);

  let phase: SeizurePhase = "none";
  let confidence = 0;
  let atonicDrop = false;
  let markerOnly = false;

  if (clonicShape) {
    phase = "clonic";
    const symTerm = sym.state === "measured" ? sym.value : 0.5;   // unknown ≠ absent
    const extentTerm = Math.min(1, involvedRegions.length / Math.max(observedRegions.length, 1));
    const anomalyTerm = Math.min(1, energyVsBaseline / (involvementMult * 2));
    confidence = Math.min(1, 0.4 * rhythmicity + 0.25 * symTerm + 0.2 * extentTerm + 0.15 * anomalyTerm);
  } else if (drop.dropped) {
    phase = "atonic";
    atonicDrop = true;
    confidence = Math.min(1, 0.5 + drop.dropFrac / 2);
  } else if (isFlat) {
    // Mere sustained stillness. Reported (the caller upgrades to "postictal"
    // after a clonic window) but NOT escalation-worthy on its own.
    phase = "atonic";
    confidence = 0.3;
  }

  // Per-student markers. A STRONG marker is sufficient on its own — see the
  // header of seizure-markers.ts for why the generic gates structurally cannot
  // call a sustained unilateral presentation.
  //
  // The test is whether the generic detectors produced anything that would
  // ESCALATE, not merely whether they set a phase. A held tonic posture is
  // often nearly motionless, so it lands in the non-escalating "flat" atonic
  // branch — and gating on `phase === "none"` would have let that swallow the
  // marker path for exactly the presentation it exists to catch.
  const genericEscalates = clonicShape || (phase === "atonic" && atonicDrop);
  if (matchedMarkers.length) {
    const strongMatches = matchedMarkers.filter(m => m.weight === "strong");
    if (!genericEscalates && strongMatches.length) {
      markerOnly = true;
      // Scale on the strongest STRONG match — a supportive marker matching
      // harder must not inflate a standalone call it isn't entitled to make.
      confidence = Math.min(0.75, 0.45 + strongMatches[0].strength * 0.3);
    } else if (genericEscalates) {
      // Corroboration: the student's own recorded pattern is present too.
      confidence = Math.min(1, confidence + (strongMatches.length ? 0.2 : 0.1));
    }
  }
  // Facial signs corroborate an event that already fired; they never start one.
  if (phase !== "none" || markerOnly) {
    confidence = Math.min(1, confidence + Math.min(facialSigns.length, 3) * 0.03);
  }

  return {
    phase, dominantHz: hz, rhythmicity,
    bilateralSymmetry: sym.value, symmetryEvaluable: sym.state === "measured", symmetryState: sym.state,
    involvedRegions, observedRegions, energyVsBaseline, durationMs, confidence,
    atonicDrop, facialSigns, matchedMarkers, markerOnly, regionEnergy,
  };
}

/**
 * A low-bar SUSPICION test for the tiered "seizure watch": enough evidence to
 * spend frames LOOKING, far below the bar for telling the Observer anything.
 * Deliberately does NOT require a resolved frequency or bilateral symmetry —
 * those need ≥10 fps and at the cheap continuous rate the frequency is aliased.
 * Confirmation happens once the rate is up.
 *
 * Facial signs count here (and only here): they are cheap, they are exactly what
 * a close camera sees best, and the cost of being wrong is a few seconds of
 * higher frame rate rather than an interruption.
 */
export function suspectSeizure(sig: SeizureSignature, involvementMult = INVOLVEMENT_MULT): boolean {
  const broadMotion = sig.involvedRegions.length >= MIN_INVOLVED_REGIONS
    && sig.involvedRegions.some(isAxial)
    && sig.energyVsBaseline >= involvementMult;
  return broadMotion || sig.matchedMarkers.length > 0 || sig.facialSigns.length >= 2;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const FACIAL_SIGN_TEXT: Record<FacialSign, string> = {
  eye_deviation: "eyes deviated to one side",
  head_version: "head turned and held to one side",
  jaw_forced_open: "jaw held open",
  oral_automatism: "repetitive chewing/mouthing movements",
  eye_flutter: "rapid rhythmic eyelid movement",
  facial_asymmetry: "one side of the face involved more than the other",
  unblinking_stare: "eyes open and unblinking",
};

/** "a, b and c" */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Render a SeizureSignature into the compact, self-skeptical `[MOTION SIGNATURE]`
 * line the Observer reads alongside the escalated frame. Returns null when there
 * is nothing worth surfacing.
 *
 * Composed from clauses rather than branched into parallel channels, per the
 * design principle: every seizure signal rides the SAME "seizure" scene channel
 * and composes into one note. `ongoingMs` is how long the current event has
 * persisted (the hook tracks it across windows) — surfaced because DURATION is
 * the clearest status-epilepticus cue and needs no fine classification.
 */
export function summarizeSignature(sig: SeizureSignature, ongoingMs = 0, escalateConfidence = ESCALATE_CONFIDENCE): string | null {
  const secs = Math.round(ongoingMs / 1000);
  const ongoing = secs > 0 ? `, ongoing ~${secs}s` : "";
  const energy = `${sig.energyVsBaseline.toFixed(1)}× usual motion`;

  // The clinician's own words carry more weight with the Observer than any
  // derived metric, so markers lead the clause list wherever they matched.
  const markerClause = sig.matchedMarkers.length
    ? ` MATCHES A PATTERN THIS STUDENT'S CLINICIAN RECORDED: ${joinList(sig.matchedMarkers.map(m => `"${m.label}"`))}.`
    : "";
  const facialClause = sig.facialSigns.length
    ? ` Face also shows: ${joinList(sig.facialSigns.map(s => FACIAL_SIGN_TEXT[s]))}.`
    : "";
  const hedge = " COARSE motion read: verify against what you SEE and the student's alarm_conditions before acting; rhythmic self-soothing can mimic this.";

  if (sig.phase === "clonic") {
    if (sig.confidence < escalateConfidence) return null;
    const extent = sig.involvedRegions.join(", ") || "limbs";
    const symText = sig.symmetryEvaluable
      ? (sig.bilateralSymmetry >= SYMMETRY_MIN ? "bilateral-synchronous, " : "")
      : "only one side in view so symmetry is unknown, ";
    return `[MOTION SIGNATURE] rhythmic ~${sig.dominantHz.toFixed(1)}Hz, ${symText}${extent} (${energy})${ongoing}`
      + ` — pattern consistent with a tonic-clonic (convulsive) seizure.${markerClause}${facialClause}${hedge}`
      + " If a convulsive pattern persists for minutes, that is the emergency.";
  }
  // Post-ictal is checked before the marker branch: a flat window right after a
  // convulsion is the more important thing to say, and a still-matching marker
  // must not overwrite it with a weaker line.
  if (sig.phase === "postictal") {
    return `[MOTION SIGNATURE] motion has gone limp/still (${energy})${ongoing} shortly after a convulsive pattern`
      + ` — possible post-ictal state.${markerClause}${facialClause} Look: check responsiveness and breathing against alarm_conditions.`;
  }

  if (sig.markerOnly) {
    return `[MOTION SIGNATURE] no generic convulsive pattern, but the motion${ongoing}${markerClause}${facialClause}`
      + " The generic detector cannot call a sustained one-sided presentation, which is why this marker exists."
      + " LOOK NOW and judge against the student's alarm_conditions — a voluntary movement can hold the same posture.";
  }
  if (sig.phase === "atonic") {
    // Only a SUDDEN collapse is worth a frame; a child simply being still is not.
    if (!sig.atonicDrop) return null;
    return `[MOTION SIGNATURE] sudden downward slump / loss of postural tone${ongoing}`
      + ` — possible atonic seizure (drop attack), or the student slumped/leaned.${markerClause}${facialClause}`
      + " COARSE: verify against what you see and the student's alarm_conditions; a voluntary lean or reach can mimic it.";
  }
  return null;
}
