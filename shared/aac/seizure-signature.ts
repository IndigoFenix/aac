// shared/aac/seizure-signature.ts
//
// PROTOTYPE — quantified motion signature for seizure-like events, a sibling of
// pose-classify.ts. Pure (no deps) so the client derives it and server tests
// cover the risky classification. Like every pose reading in this codebase, the
// output is a HINT the Observer adjudicates against the student's profile —
// NEVER a diagnosis and NEVER an auto-alarm.
//
// Why this exists: the Observer currently judges seizures off 4 fps JPEG frames.
// Clonic jerking is 2–5 Hz (Nyquist needs ≥10 fps) and, critically, Rett's hand
// stereotypies are THEMSELVES rhythmic at ~2–3 Hz — so frequency alone is
// useless. This module computes the discriminators that actually separate a
// tonic-clonic seizure from baseline stereotypy: spatial EXTENT (whole-limb/axial
// vs. distal hands), bilateral SYMMETRY, and energy ANOMALY vs. THIS student's
// habitual motion. See planning-docs/aac-seizure-recognition/plan.md.
//
// The descriptor is deliberately sensor-agnostic: a future wrist accelerometer
// feeds the same SeizureSignature shape (sensor fusion), so keep "pose" out of
// the public contract.

import { POSE_IDX, VIS_MIN, type PoseLandmark } from "./pose-classify";
import type { SeizureThresholds } from "./seizure-config";

/** One sampled pose frame with a capture timestamp (ms). */
export interface PoseFrame {
  ts: number;
  landmarks: PoseLandmark[];
}

/** Body regions we score motion energy for. "torso" tracks axial involvement
 *  (a strong seizure cue); the arms drive the bilateral-symmetry test; "head"
 *  catches head-bobbing/version. Hands are folded into the arm regions via the
 *  wrist landmark — we don't have hand landmarks here. */
export type Region = "head" | "leftArm" | "rightArm" | "torso";
export const REGIONS: Region[] = ["head", "leftArm", "rightArm", "torso"];

/** Landmark indices contributing to each region's motion energy. */
const REGION_LANDMARKS: Record<Region, number[]> = {
  head: [POSE_IDX.nose, POSE_IDX.leftEar, POSE_IDX.rightEar],
  leftArm: [POSE_IDX.leftShoulder, POSE_IDX.leftElbow, POSE_IDX.leftWrist],
  rightArm: [POSE_IDX.rightShoulder, POSE_IDX.rightElbow, POSE_IDX.rightWrist],
  torso: [POSE_IDX.leftShoulder, POSE_IDX.rightShoulder, POSE_IDX.leftHip, POSE_IDX.rightHip],
};

export type SeizurePhase = "none" | "clonic" | "atonic" | "postictal";

export interface SeizureSignature {
  phase: SeizurePhase;
  /** Dominant oscillation frequency of the most-active region (Hz), 0 if none. */
  dominantHz: number;
  /** Spectral concentration 0..1 — how rhythmic (peaked) vs. chaotic the motion
   *  is. Stereotypy AND clonic are both high here; this alone does not separate
   *  them (extent + symmetry + anomaly do). */
  rhythmicity: number;
  /** Left-arm vs. right-arm energy correlation, clamped 0..1. High = the two
   *  sides jerk together (a tonic-clonic cue; most stereotypy is not bilaterally
   *  synchronous). */
  bilateralSymmetry: number;
  /** Regions whose energy exceeds the involvement multiple of baseline — the
   *  EXTENT discriminator (distal-only = stereotypy-like; +torso/+head = axial). */
  involvedRegions: Region[];
  /** Peak region energy as a multiple of that region's baseline. */
  energyVsBaseline: number;
  /** Span of the analyzed window (ms). Persistence across windows is tracked by
   *  the caller (the hook), not here. */
  durationMs: number;
  /** 0..1 confidence this window looks like a seizure-class event (NOT a
   *  probability, NOT a diagnosis — a ranking signal for the Observer). */
  confidence: number;
  /** True when the atonic phase came from a SUDDEN seated collapse (a drop
   *  attack) rather than mere sustained stillness — the former is worth a look,
   *  the latter usually isn't. */
  atonicDrop?: boolean;
  /** Raw per-region mean energy, for telemetry/threshold tuning. */
  regionEnergy: Record<Region, number>;
}

/** Per-student habitual-motion model. An EWMA of quiet-period region energy so a
 *  child's normal stereotypy level becomes the reference a seizure must exceed.
 *  Sensor-agnostic by design (a wearable updates the same shape). */
export interface MotionBaseline {
  regionEnergy: Record<Region, number>;
  /** Number of windows folded in (for cold-start handling). */
  samples: number;
}

// ── Tunables (normalized coords) ─────────────────────────────────────────────
// Deliberately tuned toward HIGH sensitivity: better to surface a borderline
// pattern (the Observer adjudicates, and false positives are cheap) than to miss
// a real event. The bilateral-symmetry + axial-involvement gates are kept (they
// reject distal hand-wringing) but at lower thresholds.
/** Clonic band. Widened low so slower convulsive shaking still qualifies. */
export const CLONIC_HZ_MIN = 1.5;
export const CLONIC_HZ_MAX = 7;
/** Energy must be at least this multiple of baseline to count as "involved". */
export const INVOLVEMENT_MULT = 1.8;
/** Rhythmicity floor for a clonic call. */
export const RHYTHMIC_MIN = 0.25;
/** Confidence floor below which a clonic call isn't worth escalating a frame —
 *  keeps low-evidence flickers from forcing the Observer's attention. The
 *  "medium"-sensitivity default; per-student values come from resolveThresholds. */
export const ESCALATE_CONFIDENCE = 0.28;
/** Bilateral-symmetry floor for a clonic call. */
export const SYMMETRY_MIN = 0.3;
/** A clonic call needs at least this many involved regions AND ≥1 axial
 *  (torso/head) — the extent test that rejects distal-only hand stereotypy. */
export const MIN_INVOLVED_REGIONS = 2;
/** Energy below this multiple of baseline (and near-zero absolute) reads as the
 *  flat post-ictal / atonic state. */
export const FLAT_ENERGY_MULT = 0.4;
/** Downward torso-centroid drop (fraction of frame height, y down) within
 *  ATONIC_WINDOW_MS that — if it PERSISTS — reads as a sudden seated collapse
 *  (atonic drop attack). Distinct from a standing fall (pose-classify's detectFall
 *  requires ending in "lying"); a slumping seated child never gets there.
 *  Sensitive, and the Observer adjudicates a benign lean/reach away. */
export const ATONIC_DROP = 0.08;
export const ATONIC_WINDOW_MS = 1000;
/** EWMA weight for new baseline samples. */
const BASELINE_ALPHA = 0.1;
/** Floor so a perfectly still baseline doesn't make energyVsBaseline explode. */
const ENERGY_FLOOR = 1e-4;

const vis = (p?: PoseLandmark): number => (p ? p.visibility ?? 1 : 0);

/** Torso scale (shoulder-mid → hip-mid length) to normalize displacements so a
 *  child closer to the camera doesn't read as more motion. Falls back to
 *  shoulder width, then a constant. */
function torsoScale(lm: PoseLandmark[]): number {
  const ls = lm[POSE_IDX.leftShoulder], rs = lm[POSE_IDX.rightShoulder];
  const lh = lm[POSE_IDX.leftHip], rh = lm[POSE_IDX.rightHip];
  if (ls && rs && lh && rh && vis(ls) >= VIS_MIN && vis(rs) >= VIS_MIN && vis(lh) >= VIS_MIN && vis(rh) >= VIS_MIN) {
    const shx = (ls.x + rs.x) / 2, shy = (ls.y + rs.y) / 2;
    const hpx = (lh.x + rh.x) / 2, hpy = (lh.y + rh.y) / 2;
    const len = Math.hypot(hpx - shx, hpy - shy);
    if (len > 0.05) return len;
  }
  if (ls && rs && vis(ls) >= VIS_MIN && vis(rs) >= VIS_MIN) {
    const w = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    if (w > 0.03) return w;
  }
  return 0.3;
}

/** Per-region scale-normalized motion magnitude between two consecutive frames.
 *  Only landmarks visible in BOTH frames contribute; returns NaN if none do. */
function regionFrameEnergy(a: PoseFrame, b: PoseFrame, region: Region, scale: number): number {
  let sum = 0, n = 0;
  for (const idx of REGION_LANDMARKS[region]) {
    const pa = a.landmarks[idx], pb = b.landmarks[idx];
    if (!pa || !pb || vis(pa) < VIS_MIN || vis(pb) < VIS_MIN) continue;
    sum += Math.hypot(pb.x - pa.x, pb.y - pa.y);
    n++;
  }
  return n === 0 ? NaN : sum / n / Math.max(scale, 0.05);
}

/** Build a per-region energy time series (one value per frame gap). Energy is
 *  scale-normalized speed PER SECOND (displacement ÷ dt), NOT per frame — so the
 *  reading is frame-rate-invariant. This matters because the "seizure watch"
 *  bumps the pose rate: a baseline learned at 2.5 fps must stay comparable to a
 *  window sampled at 15 fps, or energyVsBaseline would collapse exactly when we
 *  look closest. */
function energySeries(frames: PoseFrame[]): Record<Region, number[]> {
  const out = { head: [], leftArm: [], rightArm: [], torso: [] } as Record<Region, number[]>;
  for (let i = 1; i < frames.length; i++) {
    const scale = torsoScale(frames[i].landmarks);
    const dtSec = Math.max((frames[i].ts - frames[i - 1].ts) / 1000, 1e-3);
    for (const r of REGIONS) {
      const e = regionFrameEnergy(frames[i - 1], frames[i], r, scale);
      out[r].push(Number.isNaN(e) ? 0 : e / dtSec);
    }
  }
  return out;
}

/** Mean (x,y) of a region's visible landmarks, or null. */
function regionCentroid(lm: PoseLandmark[], region: Region): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (const idx of REGION_LANDMARKS[region]) {
    const p = lm[idx];
    if (!p || vis(p) < VIS_MIN) continue;
    sx += p.x; sy += p.y; n++;
  }
  return n === 0 ? null : { x: sx / n, y: sy / n };
}

/** Torso centroid (shoulders+hips mid), or null — the reference we subtract so
 *  gross body translation (a wheelchair rolling) doesn't masquerade as limb
 *  oscillation. */
function torsoCentroid(lm: PoseLandmark[]): { x: number; y: number } | null {
  return regionCentroid(lm, "torso");
}

/** Signed per-region POSITION series RELATIVE to the torso centroid, scale-
 *  normalized — the basis for frequency and phase (vs. the speed-magnitude
 *  energy series, which rectifies and so frequency-doubles and loses phase). */
function relativePosSeries(frames: PoseFrame[]): Record<Region, { x: number[]; y: number[] }> {
  const out = {
    head: { x: [], y: [] }, leftArm: { x: [], y: [] },
    rightArm: { x: [], y: [] }, torso: { x: [], y: [] },
  } as Record<Region, { x: number[]; y: number[] }>;
  for (const f of frames) {
    const t = torsoCentroid(f.landmarks);
    const scale = torsoScale(f.landmarks);
    for (const r of REGIONS) {
      const c = regionCentroid(f.landmarks, r);
      if (!c || !t) { out[r].x.push(0); out[r].y.push(0); continue; }
      out[r].x.push((c.x - t.x) / Math.max(scale, 0.05));
      out[r].y.push((c.y - t.y) / Math.max(scale, 0.05));
    }
  }
  return out;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
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
 * Returns the first strong autocorrelation peak (after lag 0) as a period; Hz is
 * derived from the mean inter-sample dt. rhythmicity = that peak's normalized
 * height (0..1). Cheaper and more robust than an FFT for these short windows.
 */
function dominantFrequency(series: number[], meanDtMs: number): { hz: number; rhythmicity: number } {
  const n = series.length;
  if (n < 6 || meanDtMs <= 0) return { hz: 0, rhythmicity: 0 };
  const m = mean(series);
  const x = series.map(v => v - m);
  const energy0 = x.reduce((a, b) => a + b * b, 0);
  if (energy0 <= 0) return { hz: 0, rhythmicity: 0 };

  // Normalized autocorrelation across candidate lags.
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
function meanDt(frames: PoseFrame[]): number {
  if (frames.length < 2) return 0;
  return (frames[frames.length - 1].ts - frames[0].ts) / (frames.length - 1);
}

/**
 * Sudden seated collapse (atonic drop attack): a fast downward torso-centroid
 * displacement within ATONIC_WINDOW_MS that PERSISTS to the end of the window —
 * the persistence check rejects a voluntary lean/reach-and-return bob. Frame-Y
 * is normalized (0..1, y down) so a drop is a positive delta. Works at the cheap
 * pose rate (a 0.12 drop is visible across 2–3 low-fps frames); it's a transient,
 * so it doesn't need the high-fps watch the rhythmic clonic path does.
 */
function detectSuddenDrop(frames: PoseFrame[], dropThreshold = ATONIC_DROP): { dropped: boolean; dropFrac: number } {
  const ys: Array<{ ts: number; y: number }> = [];
  for (const f of frames) {
    const t = torsoCentroid(f.landmarks);
    if (t) ys.push({ ts: f.ts, y: t.y });
  }
  if (ys.length < 3) return { dropped: false, dropFrac: 0 };
  let maxDrop = 0;
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length && ys[j].ts - ys[i].ts <= ATONIC_WINDOW_MS; j++) {
      const d = ys[j].y - ys[i].y; // + = moved DOWN
      if (d > maxDrop) maxDrop = d;
    }
  }
  // Persisted? net downward displacement across the whole window (a bob nets ~0).
  const net = ys[ys.length - 1].y - ys[0].y;
  return { dropped: maxDrop >= dropThreshold && net >= dropThreshold * 0.5, dropFrac: maxDrop };
}

/** Fold a window's region energies into the baseline (call ONLY on windows the
 *  caller believes are quiet/non-event — never during a suspected event, or the
 *  baseline absorbs the seizure and stops being a reference). */
export function updateBaseline(baseline: MotionBaseline, regionEnergy: Record<Region, number>): MotionBaseline {
  const next: Record<Region, number> = { ...baseline.regionEnergy };
  for (const r of REGIONS) {
    const prev = baseline.regionEnergy[r] ?? 0;
    next[r] = baseline.samples === 0 ? regionEnergy[r] : prev * (1 - BASELINE_ALPHA) + regionEnergy[r] * BASELINE_ALPHA;
  }
  return { regionEnergy: next, samples: baseline.samples + 1 };
}

export function emptyBaseline(): MotionBaseline {
  return { regionEnergy: { head: 0, leftArm: 0, rightArm: 0, torso: 0 }, samples: 0 };
}

/**
 * Net downward torso-centroid motion over the last `windowMs` of a frame buffer.
 * Used to catch a slump that's about to take the body OUT of frame: the normal
 * atonic detector (detectSuddenDrop) needs the body to persist in view to
 * confirm, so a collapse that drops below/out of the camera is exactly the case
 * it misses. Paired with pose-loss in the hook, even a SMALL downward drift
 * counts — hence the low default threshold. Pure/testable.
 */
export function recentDownwardSlump(frames: PoseFrame[], now: number, windowMs = 1500, threshold = 0.05): boolean {
  const ys: number[] = [];
  for (const f of frames) {
    if (now - f.ts > windowMs) continue;
    const t = torsoCentroid(f.landmarks);
    if (t) ys.push(t.y); // y increases DOWNward
  }
  if (ys.length < 2) return false;
  return ys[ys.length - 1] - ys[0] >= threshold;
}

/** Module-constant thresholds = the "medium"-sensitivity defaults. Used when no
 *  per-student thresholds are supplied (keeps the pure functions callable bare,
 *  e.g. in tests). Per-student values come from seizure-config.resolveThresholds. */
export const DEFAULT_THRESHOLDS: SeizureThresholds = {
  rhythmic: { enabled: true, involvementMult: INVOLVEMENT_MULT, escalateConfidence: ESCALATE_CONFIDENCE },
  atonic: { enabled: true, dropFrac: ATONIC_DROP },
  audioCorroboration: true,
};

/**
 * Analyze a rolling window of pose frames into a SeizureSignature, judged
 * against the student's MotionBaseline. Pure & conservative: it reports metrics
 * and a coarse phase, and leaves the response decision to the Observer.
 *
 * Needs ≥10 fps to resolve the clonic band (Nyquist); at the default 4 fps JPEG
 * cadence dominantHz saturates and clonic won't be called — that's why the watch
 * state bumps the pose rate. With too few/too-slow frames it returns phase
 * "none" rather than guessing.
 */
export function analyzeWindow(frames: PoseFrame[], baseline: MotionBaseline, thresholds: SeizureThresholds = DEFAULT_THRESHOLDS): SeizureSignature {
  const empty: SeizureSignature = {
    phase: "none", dominantHz: 0, rhythmicity: 0, bilateralSymmetry: 0,
    involvedRegions: [], energyVsBaseline: 1, durationMs: 0, confidence: 0,
    regionEnergy: { head: 0, leftArm: 0, rightArm: 0, torso: 0 },
  };
  if (frames.length < 6) return empty;

  const durationMs = frames[frames.length - 1].ts - frames[0].ts;
  const dt = meanDt(frames);
  const series = energySeries(frames);
  const relPos = relativePosSeries(frames);
  const regionEnergy = {
    head: mean(series.head), leftArm: mean(series.leftArm),
    rightArm: mean(series.rightArm), torso: mean(series.torso),
  } as Record<Region, number>;

  const involvementMult = thresholds.rhythmic.involvementMult;
  // Extent: which regions are running hot vs. THIS student's baseline.
  const ratios = {} as Record<Region, number>;
  const involvedRegions: Region[] = [];
  for (const r of REGIONS) {
    const base = Math.max(baseline.regionEnergy[r] ?? 0, ENERGY_FLOOR);
    ratios[r] = regionEnergy[r] / base;
    if (baseline.samples > 0 && ratios[r] >= involvementMult) involvedRegions.push(r);
  }
  const energyVsBaseline = Math.max(...REGIONS.map(r => ratios[r]));

  // Frequency/rhythmicity from the SIGNED relative-position series of the most
  // energetic region, on whichever axis carries the oscillation. (Speed
  // magnitude would frequency-double and discard phase.)
  const hot = REGIONS.reduce((a, b) => (regionEnergy[b] > regionEnergy[a] ? b : a), "head" as Region);
  const hotAxis = variance(relPos[hot].x) >= variance(relPos[hot].y) ? relPos[hot].x : relPos[hot].y;
  const { hz, rhythmicity } = dominantFrequency(hotAxis, dt);
  // Bilateral symmetry: do the two arms move IN PHASE? Signed lateral (x)
  // position correlation — in-phase clonic → +1, anti-phase wringing → −1.
  const bilateralSymmetry = Math.max(0, correlation(relPos.leftArm.x, relPos.rightArm.x));

  // ── Phase decision (coarse, conservative) ──────────────────────────────────
  // FLAT: motion collapsed well below baseline → atonic OR post-ictal. Only
  // meaningful when the baseline ITSELF had motion (a normally-still child going
  // on being still is "none", not a tone-loss event). The caller disambiguates
  // atonic vs. post-ictal by history (flat AFTER a clonic call = post-ictal).
  const absEnergy = Math.max(...REGIONS.map(r => regionEnergy[r]));
  const baselineActive = Math.max(...REGIONS.map(r => baseline.regionEnergy[r] ?? 0)) > ENERGY_FLOOR * 5;
  const isFlat = baseline.samples > 0 && baselineActive && energyVsBaseline <= FLAT_ENERGY_MULT && absEnergy < ENERGY_FLOOR * 5;
  const drop = thresholds.atonic.enabled ? detectSuddenDrop(frames, thresholds.atonic.dropFrac) : { dropped: false, dropFrac: 0 };

  let phase: SeizurePhase = "none";
  let confidence = 0;
  let atonicDrop = false;

  const clonicShape =
    thresholds.rhythmic.enabled &&
    hz >= CLONIC_HZ_MIN && hz <= CLONIC_HZ_MAX &&
    rhythmicity >= RHYTHMIC_MIN &&
    bilateralSymmetry >= SYMMETRY_MIN &&
    involvedRegions.length >= MIN_INVOLVED_REGIONS &&
    involvedRegions.some(r => r === "torso" || r === "head");   // axial, not distal-only

  if (clonicShape) {
    phase = "clonic";
    // Blend the cues so the Observer can rank borderline events. Each term 0..1.
    const symTerm = bilateralSymmetry;
    const extentTerm = Math.min(1, involvedRegions.length / REGIONS.length);
    const anomalyTerm = Math.min(1, energyVsBaseline / (involvementMult * 2));
    confidence = Math.min(1, 0.4 * rhythmicity + 0.25 * symTerm + 0.2 * extentTerm + 0.15 * anomalyTerm);
  } else if (drop.dropped) {
    // Sudden seated collapse — the real atonic/drop-attack signal.
    phase = "atonic";
    atonicDrop = true;
    confidence = Math.min(1, 0.5 + drop.dropFrac);
  } else if (isFlat) {
    // Mere sustained stillness. Reported (caller upgrades to "postictal" after a
    // clonic window) but NOT escalation-worthy on its own — see summarizeSignature.
    phase = "atonic";
    confidence = 0.3;
  }

  return {
    phase, dominantHz: hz, rhythmicity, bilateralSymmetry,
    involvedRegions, energyVsBaseline, durationMs, confidence, atonicDrop, regionEnergy,
  };
}

/**
 * A low-bar SUSPICION test for the tiered "seizure watch": a lot of the body
 * moving far above the student's baseline, including an axial region. It
 * deliberately does NOT require a resolved frequency or bilateral symmetry —
 * those need ≥10 fps, and at the cheap continuous rate (~2.5 fps) the frequency
 * is aliased. This is purely the cue to BUMP the pose rate and look properly;
 * confirmation (the full clonic shape) happens once the rate is up. Returns
 * false until a baseline exists.
 */
export function suspectSeizure(sig: SeizureSignature, involvementMult = INVOLVEMENT_MULT): boolean {
  return sig.involvedRegions.length >= MIN_INVOLVED_REGIONS
    && sig.involvedRegions.some(r => r === "torso" || r === "head")
    && sig.energyVsBaseline >= involvementMult;
}

/**
 * Render a SeizureSignature into the compact, self-skeptical `[MOTION SIGNATURE]`
 * line the Observer reads alongside the escalated frame. Returns null when there
 * is nothing worth surfacing (phase "none", or a clonic call under the escalate
 * floor). `ongoingMs` is how long the current event has persisted (the hook
 * tracks it across windows) — surfaced because DURATION is the clearest
 * status-epilepticus cue and needs no fine classification.
 *
 * Deliberately hedged: every line reminds the Observer this is a coarse motion
 * pattern to VERIFY against what it sees and the student's alarm_conditions —
 * rhythmic self-soothing (hand-wringing) is the known mimic in this population.
 */
export function summarizeSignature(sig: SeizureSignature, ongoingMs = 0, escalateConfidence = ESCALATE_CONFIDENCE): string | null {
  const secs = Math.round(ongoingMs / 1000);
  const ongoing = secs > 0 ? `, ongoing ~${secs}s` : "";
  const energy = `${sig.energyVsBaseline.toFixed(1)}× usual motion`;

  if (sig.phase === "clonic") {
    if (sig.confidence < escalateConfidence) return null;
    const extent = sig.involvedRegions.join(", ") || "limbs";
    return `[MOTION SIGNATURE] rhythmic ~${sig.dominantHz.toFixed(1)}Hz, bilateral-synchronous, ${extent} (${energy})${ongoing} — pattern consistent with a tonic-clonic (convulsive) seizure. COARSE motion read: verify against what you SEE and the student's alarm_conditions before acting; rhythmic self-soothing can mimic this. If a convulsive pattern persists for minutes, that is the emergency.`;
  }
  if (sig.phase === "postictal") {
    return `[MOTION SIGNATURE] motion has gone limp/still (${energy})${ongoing} shortly after a convulsive pattern — possible post-ictal state. Look: check responsiveness and breathing against alarm_conditions.`;
  }
  if (sig.phase === "atonic") {
    // Only a SUDDEN collapse is worth a frame; a child simply being still is not.
    if (!sig.atonicDrop) return null;
    return `[MOTION SIGNATURE] sudden downward slump / loss of postural tone${ongoing} — possible atonic seizure (drop attack), or the student slumped/leaned. COARSE: verify against what you see and the student's alarm_conditions; a voluntary lean or reach can mimic it.`;
  }
  return null;
}
