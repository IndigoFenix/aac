// shared/aac/head-gestures.ts
//
// Nod / shake detection from the face tracker's nose-tip track.
//
// WHY THIS EXISTS. The previous detector (detectHeadGestures in
// useFaceEvents.ts) asked for 2 direction reversals with an amplitude of 6% of
// the face box inside a 2 s window. At the face tracker's 300 ms cadence that
// window holds about 7 samples, so two reversals is roughly "the nose tip
// wobbled" — and it measured out at **21% of prod scene rows, for two different
// students** (planning-docs/aac-face-expression-decoder.md §2.5). Nobody shakes
// their head a fifth of the time.
//
// ⚠️ THE REAL FAULT IS SAMPLING, NOT THRESHOLDS. The tracker runs at 300 ms →
// Nyquist 1.67 Hz. A genuine head shake is 2-5 Hz, ABOVE that. So a real shake
// cannot be sampled correctly at all — it ALIASES into an apparent slow
// oscillation, and independent jitter aliases into the same thing. The codebase
// already knew this in another context: home.tsx bumps the tracker to 66 ms for
// the seizure watch precisely because "leaving it at 300ms (Nyquist 1.7Hz)
// would have aliased the clonic band".
//
// You cannot threshold your way out of aliasing. So this detector gates on
// PERIODICITY instead:
//
//   * reversals must be REGULAR — real oscillation has a consistent half-period,
//     aliased noise does not
//   * each half-cycle must contain enough SAMPLES to have actually been
//     observed (minSamplesPerHalfPeriod) — the Nyquist condition stated in
//     samples rather than milliseconds, so it adapts to whatever rate the
//     tracker is running at instead of being a magic constant
//
// That second gate is what a fixed millisecond floor could not do. At 3.3 Hz it
// admits only slow deliberate movement — which is what a communicative yes/no
// from this population looks like — while at the seizure watch's 66 ms it
// admits genuine fast shaking, with no config change. It also rejects the
// degenerate case the old detector loved: a "reversal" every single sample,
// which is noise at exactly Nyquist and can never be a gesture.
//
// ⚠️ WHAT ALIASING DOES AND DOESN'T BREAK. A 4 Hz shake sampled at 3.3 Hz folds
// to an apparent ~0.7 Hz — but it folds ON THE SAME AXIS, so the nod/shake
// LABEL survives. What does not survive is `halfPeriodMs`, which will report
// the aliased period. `aliasRisk` marks that case; don't build timing logic on
// a result carrying it.

export type HeadGesture = "nod" | "shake";

/** One nose-tip observation, normalized image coords (0..1, y down). */
export interface HeadGestureSample {
  x: number;
  y: number;
  ts: number;
}

export interface HeadGestureResult {
  gesture: HeadGesture;
  /** 0..1 — amplitude and regularity together. */
  confidence: number;
  /** Measured half-period (ms between direction reversals). Unreliable when
   *  `aliasRisk` is set — see the header note on aliasing. */
  halfPeriodMs: number;
  /** The oscillation was only barely resolved, so it may be an aliased faster
   *  movement. The gesture LABEL still holds; the period does not. */
  aliasRisk: boolean;
  /** Peak-to-peak amplitude as a fraction of the face box on the moving axis. */
  amplitude: number;
}

export interface HeadGestureConfig {
  /** Rolling history kept, ms. */
  windowMs: number;
  /** Minimum samples in the window before anything is judged. */
  minSamples: number;
  /** Reversals needed. 3 is a full there-and-back-and-there — two is just a
   *  wobble, which is what the old detector accepted. */
  minReversals: number;
  /** Peak-to-peak amplitude, as a fraction of the face box on that axis. */
  minAmplitudeFrac: number;
  /** Samples required per half-cycle. 2.0 is the Nyquist limit — below it the
   *  oscillation was never actually resolved and any "reversal" is noise. This
   *  replaces a fixed millisecond floor precisely so it tracks the sample rate:
   *  the same value admits a 0.8 Hz nod at 3.3 Hz and a 4 Hz shake at 30 Hz. */
  minSamplesPerHalfPeriod: number;
  /** Below this many samples per half-cycle the PERIOD reading is soft (the
   *  gesture may be an aliased faster one). Sets `aliasRisk`; does not reject. */
  aliasRiskSamplesPerHalfPeriod: number;
  /** Longest half-period still readable as one gesture rather than drifting. */
  maxHalfPeriodMs: number;
  /** Coefficient of variation allowed across half-periods. Real oscillation is
   *  regular; jitter is not. This is the gate that does most of the work. */
  maxPeriodCv: number;
  /** Coefficient of variation allowed across SWING SIZES. A gesture is regular
   *  in amplitude too; three gaps alone are few enough that a low period-cv
   *  shows up by chance, and this is what closes that gap. */
  maxAmplitudeCv: number;
  /** The winning axis must exceed the other by this ratio, so a diagonal
   *  wobble is not forced into a yes/no answer. */
  dominanceRatio: number;
  /** Quiet period after a detection, so one gesture reports once. */
  refractoryMs: number;
}

export const DEFAULT_HEAD_GESTURE_CONFIG: HeadGestureConfig = {
  windowMs: 3_000,
  minSamples: 8,
  minReversals: 4,
  minAmplitudeFrac: 0.12,
  minSamplesPerHalfPeriod: 2.0,
  aliasRiskSamplesPerHalfPeriod: 3.0,
  maxHalfPeriodMs: 1_100,
  maxPeriodCv: 0.35,
  maxAmplitudeCv: 0.5,
  dominanceRatio: 1.5,
  refractoryMs: 2_000,
};

// ---------------------------------------------------------------------------
// Per-axis oscillation analysis
// ---------------------------------------------------------------------------

interface AxisOscillation {
  reversals: number;
  amplitude: number;      // largest peak-to-peak swing, same units as input
  halfPeriodMs: number;   // mean interval between reversals
  cv: number;             // coefficient of variation of those intervals
  /** Coefficient of variation of the SWING SIZES. Real nodding is regular in
   *  amplitude as well as in period; noise is regular in neither. Adding this
   *  is what finally separated jitter from gesture — with only three gaps, a
   *  low period-cv turns up by chance often enough to matter. */
  amplitudeCv: number;
}

/**
 * Find reversals on one axis and measure how REGULAR they are. Amplitude is
 * peak-to-peak between successive reversals, which is what makes a small
 * high-frequency tremor score low even when it reverses often.
 */
export function analyseAxis(values: number[], times: number[], minAmp: number): AxisOscillation {
  const none: AxisOscillation = {
    reversals: 0, amplitude: 0, halfPeriodMs: 0, cv: Infinity, amplitudeCv: Infinity,
  };
  if (values.length < 3) return none;

  const revTimes: number[] = [];
  const amplitudes: number[] = [];
  let dir = 0;
  let anchorVal = values[0];
  let anchorTime = times[0];

  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (Math.abs(d) < 1e-6) continue;
    const nd = d > 0 ? 1 : -1;
    if (dir === 0) { dir = nd; continue; }
    if (nd !== dir) {
      const swing = Math.abs(values[i - 1] - anchorVal);
      // Only count a reversal that actually travelled — this is what rejects
      // sensor jitter reversing every other frame around a fixed point.
      if (swing >= minAmp) {
        revTimes.push(times[i - 1]);
        amplitudes.push(swing);
        anchorVal = values[i - 1];
        anchorTime = times[i - 1];
      }
      dir = nd;
    }
  }

  if (revTimes.length < 2) {
    return {
      reversals: revTimes.length, amplitude: amplitudes[0] ?? 0,
      halfPeriodMs: 0, cv: Infinity, amplitudeCv: Infinity,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < revTimes.length; i++) gaps.push(revTimes[i] - revTimes[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : Infinity;

  const ampMean = amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length;
  const ampVar = amplitudes.reduce((a, b) => a + (b - ampMean) ** 2, 0) / amplitudes.length;
  const amplitudeCv = ampMean > 0 ? Math.sqrt(ampVar) / ampMean : Infinity;

  return {
    reversals: revTimes.length,
    amplitude: Math.max(...amplitudes),
    halfPeriodMs: mean,
    cv,
    amplitudeCv,
  };
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export interface HeadGestureDetector {
  /** Feed one sample. Pass null when the face is not visible (clears nothing —
   *  the window ages out naturally). Returns a result only on the tick a
   *  gesture is accepted. */
  update(sample: HeadGestureSample | null, faceWidth: number, faceHeight: number): HeadGestureResult | null;
  /** Effective sample rate over the current window, Hz. Diagnostics — this is
   *  the number that decides whether fast gestures are observable at all. */
  sampleRateHz(): number;
  reset(): void;
}

export function createHeadGestureDetector(
  overrides?: Partial<HeadGestureConfig>,
): HeadGestureDetector {
  const cfg: HeadGestureConfig = { ...DEFAULT_HEAD_GESTURE_CONFIG, ...overrides };
  let history: HeadGestureSample[] = [];
  let quietUntil = 0;

  function sampleRateHz(): number {
    if (history.length < 2) return 0;
    const span = history[history.length - 1].ts - history[0].ts;
    return span > 0 ? ((history.length - 1) * 1000) / span : 0;
  }

  function reset() { history = []; quietUntil = 0; }

  function update(
    sample: HeadGestureSample | null,
    faceWidth: number,
    faceHeight: number,
  ): HeadGestureResult | null {
    if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return null;
    history.push(sample);

    const now = sample.ts;
    while (history.length && now - history[0].ts > cfg.windowMs) history.shift();

    if (now < quietUntil) return null;
    if (history.length < cfg.minSamples) return null;
    if (!(faceWidth > 0) || !(faceHeight > 0)) return null;

    const times = history.map(h => h.ts);
    const x = analyseAxis(history.map(h => h.x), times, faceWidth * cfg.minAmplitudeFrac);
    const y = analyseAxis(history.map(h => h.y), times, faceHeight * cfg.minAmplitudeFrac);

    // Samples actually observed per half-cycle. Below the Nyquist limit the
    // "oscillation" was never resolved — this is what rejects a reversal on
    // every single sample, which is the shape sensor noise takes.
    const rate = sampleRateHz();
    const samplesPerHalf = (a: AxisOscillation) =>
      rate > 0 && a.halfPeriodMs > 0 ? (a.halfPeriodMs / 1000) * rate : 0;

    const ok = (a: AxisOscillation) =>
      a.reversals >= cfg.minReversals &&
      a.cv <= cfg.maxPeriodCv &&
      a.amplitudeCv <= cfg.maxAmplitudeCv &&
      samplesPerHalf(a) >= cfg.minSamplesPerHalfPeriod &&
      a.halfPeriodMs <= cfg.maxHalfPeriodMs;

    const xOk = ok(x), yOk = ok(y);
    if (!xOk && !yOk) return null;

    // Normalise each axis by its own face dimension before comparing them —
    // faces are taller than they are wide, so raw amplitudes are not comparable.
    const xScore = xOk ? x.amplitude / faceWidth : 0;
    const yScore = yOk ? y.amplitude / faceHeight : 0;

    let gesture: HeadGesture;
    let axis: AxisOscillation;
    let score: number;
    if (xScore >= yScore * cfg.dominanceRatio) { gesture = "shake"; axis = x; score = xScore; }
    else if (yScore >= xScore * cfg.dominanceRatio) { gesture = "nod"; axis = y; score = yScore; }
    else return null;   // diagonal wobble — refuse to guess

    quietUntil = now + cfg.refractoryMs;
    history = [];

    // Confidence blends how big the movement was with how regular it was.
    const amplitudeTerm = Math.min(1, score / (cfg.minAmplitudeFrac * 2.5));
    const regularityTerm = Math.max(0, 1 - axis.cv / cfg.maxPeriodCv);
    return {
      gesture,
      confidence: Math.max(0, Math.min(1, 0.6 * amplitudeTerm + 0.4 * regularityTerm)),
      halfPeriodMs: axis.halfPeriodMs,
      aliasRisk: samplesPerHalf(axis) < cfg.aliasRiskSamplesPerHalfPeriod,
      amplitude: score,
    };
  }

  return { update, sampleRateHz, reset };
}
