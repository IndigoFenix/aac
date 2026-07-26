// shared/intent-decoder.ts
// INTENT DECODING for gaze selection — the replacement for "time on target".
//
// THE PROBLEM. Plain dwell asks "how long have you been here?", a question that
// cannot tell reading from choosing, because both look identical: time on a
// button. Students scanning the glyph or the word to work out what a button
// MEANS kept selecting it by accident, so the board became unreadable.
//
// THE MODEL. Answer two questions per tick, and report both so the student can
// see the decision before it commits:
//   1. READING or DECIDING?  Reading is a chain of short fixations stitched by
//      saccades; deciding is one sustained fixation. So the discriminator is
//      the DISPERSION of the last `dispersionWindowMs` of gaze samples (the
//      classic I-DT measure: the summed extent of their bounding box). This is
//      also the jitter model — it measures noise instead of fighting it.
//   2. DECIDING WHAT?  The zone under the fixation, as a RATE not a gate:
//        core (icon/glyph)  → qualifies fast, charges at full rate
//        ink  (label text)  → qualifies slower, charges slower
//        rest (padding, gutters) → never charges; the board's free rest area
//      A gate would break the students who select by settling on the word.
//
// TWO RULES THAT MATTER MORE THAN THE REST:
//
//   ADAPTIVE THRESHOLD. A fixed dispersion threshold fails this population — a
//   student with poor oculomotor control may never produce a "still" fixation
//   by absolute standards, and would simply never be able to select. So the
//   threshold self-calibrates to a low percentile of that student's OWN
//   dispersion. The question is "still, for you", never "still, in pixels".
//
//   FALLBACK FLOOR. If a target has been held for `fallbackAfterCharges` ×
//   the charge time and still hasn't qualified, it charges anyway at a slow
//   rate. The decoder must degrade into plain long dwell — never into a board
//   that cannot be operated at all. Do not remove this.
//
// REVISIT. Scanning covers new ground; choosing comes back. Leaving a target
// parks its progress in a short-lived memory, so returning resumes rather than
// restarting AND shortens qualification. This is what lets a student read a
// word, look away, look back, and select quickly — and it is the one place
// this engine deliberately differs from DwellEngine, which zeroes on exit.
//
// Pure and DOM-free: geometry arrives pre-resolved as a `zone`. See
// server/tests/intent-decoder.test.ts.

import { SelectionGate, type DwellPoint, type SelectionGateConfig } from "./selection-gate.js";

/** Where on a button the gaze is resting. Resolved by the caller from the DOM. */
export type IntentZone = "core" | "ink" | "rest";

/** What the decoder currently believes the student is doing. */
export type IntentState = "scanning" | "settling" | "charging";

export interface IntentSample {
  x: number;
  y: number;
  t: number;
}

export interface IntentTuning {
  /** Window over which fixation dispersion is measured. */
  dispersionWindowMs: number;
  /** Threshold = this × the student's own calibrated dispersion percentile. */
  dispersionSlack: number;
  /** Clamp on the adaptive threshold, in px of summed bounding-box extent.
   *  The ceiling is the "nothing this wide is a fixation" bound: it stops a
   *  long stretch of pure scanning from calibrating the decoder into believing
   *  that roving across a whole button counts as holding still. */
  minDispersionPx: number;
  maxDispersionPx: number;
  /** Threshold used until enough of the student's own samples have been seen. */
  defaultDispersionPx: number;
  /** Readings required before the adaptive threshold is trusted. */
  calibrationMinSamples: number;
  /** Ring-buffer size for the calibration history. */
  calibrationSize: number;
  /** Percentile of observed dispersion taken as "this student holding still". */
  calibrationPercentile: number;
  /** How often the threshold is recomputed (sorting the history isn't free). */
  calibrationRefreshMs: number;
  /**
   * Continuous stillness required before a zone starts charging, as a FRACTION
   * of the student's configured dwell time rather than a fixed millisecond
   * value. A student set to a slow 5s dwell needs a slow settle to match; one
   * on a fast 800ms dwell would find a fixed 350ms qualification a large part
   * of their whole budget. Everything time-like here scales the same way, so
   * the AAC Settings dwell slider moves the entire gesture coherently.
   */
  qualifyCoreFraction: number;
  qualifyInkFraction: number;
  /** Floor and ceiling on the derived qualification times. */
  qualifyMinMs: number;
  qualifyMaxMs: number;
  /** Qualification time is scaled by this on a return visit. */
  revisitQualifyScale: number;
  /** Time away that counts as a real look-away rather than a hit-test blip. */
  revisitMinAwayMs: number;
  /** Charge rate per zone, as a multiple of the nominal fill rate. */
  rateCore: number;
  rateInk: number;
  /** Charge time as a fraction of the student's dwell setting. Qualification
   *  has already done the filtering, so the fill itself can be shorter. */
  chargeScale: number;
  /** Grace period before an un-charging target starts losing progress, as a
   *  fraction of the charge time — a glance away should cost the same
   *  PROPORTION of the timer whatever the student's dwell speed. */
  pauseFraction: number;
  /** Drain multiplier at the moment draining starts, and how it ramps. */
  drainStartRate: number;
  drainRampPerSec: number;
  drainMaxRate: number;
  /** How long a left target's progress survives, decaying linearly to zero,
   *  as a fraction of the charge time. */
  memoryFraction: number;
  /** Floor and ceiling on the derived memory window. */
  memoryMinMs: number;
  memoryMaxMs: number;
  /** How many recently-left targets keep their progress. More than one,
   *  because the whole point is "scan A, B, C, then come back to A" — a
   *  single slot would be erased by the first neighbour glanced at. */
  memorySlots: number;
  /** Held this many charge-times without qualifying → charge anyway. */
  fallbackAfterCharges: number;
  fallbackRate: number;
  /** Time constant for smoothing the reported fixation centroid. */
  centroidTauMs: number;
  /** Clamp on per-tick dt, so a backgrounded tab can't jump the timer. */
  maxTickMs: number;
}

/**
 * Starting points, not settled values — these need in-app tuning against real
 * students, which is what the debug readout exists for. Grouped in one object
 * so they can be adjusted in a single place.
 */
export const INTENT_DEFAULTS: IntentTuning = {
  dispersionWindowMs: 300,
  dispersionSlack: 2.0,
  minDispersionPx: 25,
  maxDispersionPx: 140,
  defaultDispersionPx: 80,
  calibrationMinSamples: 40,
  calibrationSize: 300,
  // Low enough to estimate this student's FLOOR of stillness even when they
  // spend most of the session scanning rather than choosing.
  calibrationPercentile: 0.2,
  calibrationRefreshMs: 500,
  // At the 2000ms default dwell these work out to 150ms / 350ms.
  qualifyCoreFraction: 0.075,
  qualifyInkFraction: 0.175,
  qualifyMinMs: 90,
  qualifyMaxMs: 700,
  revisitQualifyScale: 0.5,
  revisitMinAwayMs: 250,
  rateCore: 1,
  rateInk: 0.6,
  chargeScale: 0.7,
  pauseFraction: 0.29, // ≈400ms at the default dwell
  drainStartRate: 0.2,
  drainRampPerSec: 0.4,
  drainMaxRate: 1.5,
  memoryFraction: 1.07, // ≈1500ms at the default dwell
  memoryMinMs: 700,
  memoryMaxMs: 4000,
  memorySlots: 6,
  fallbackAfterCharges: 2.5,
  fallbackRate: 0.35,
  centroidTauMs: 80,
  maxTickMs: 250,
};

export interface IntentDecoderConfig extends SelectionGateConfig {
  /** The student's configured dwell time; charge time is scaled from it. */
  dwellTimeMs: number;
  tuning?: Partial<IntentTuning>;
}

export interface IntentTickResult<T> {
  target: T | null;
  state: IntentState;
  zone: IntentZone;
  /** 0-1 toward firing on `target`. */
  progress: number;
  /** Set on the single tick a selection fires. */
  fired: T | null;
  /** Smoothed fixation centroid — where the readout draws. Null with no point. */
  centroid: DwellPoint | null;
  /** Measured dispersion over the window, px. */
  dispersion: number;
  /** The adaptive threshold it is being compared against, px. */
  threshold: number;
  /** Progress is receding. */
  draining: boolean;
  /** The fallback slow-charge is what's driving progress (never qualified). */
  fallback: boolean;
  /** This target was resumed from memory rather than started fresh. */
  revisit: boolean;
  hoverEnabled: boolean;
  gazeStale: boolean;
  movementFromAnchor: number;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export class IntentDecoder<T> {
  private readonly cfg: IntentTuning;
  // Everything time-like is derived from the student's configured dwell time
  // (AAC Settings → selection timeout) so one slider moves the whole gesture.
  private readonly chargeTimeMs: number;
  private readonly qualifyCoreMs: number;
  private readonly qualifyInkMs: number;
  private readonly pauseMs: number;
  private readonly memoryMs: number;
  private readonly gate: SelectionGate;

  // ── Gaze sample history (fed at the provider's native rate) ──
  private samples: IntentSample[] = [];

  // ── Per-student dispersion calibration ──
  private history: number[] = [];
  private historyIdx = 0;
  private threshold: number;
  private thresholdAt = 0;

  // ── Current target ──
  private current: T | null = null;
  private targetSince = 0;
  private started = false;
  private lastTickAt = 0;
  private elapsed = 0;
  // -1 = "not set". Zero is a legitimate timestamp, so it can't be the sentinel.
  private stableSince = -1;
  private qualified = false;
  private notChargingSince = -1;
  private revisit = false;

  /** Progress parked from recently-left targets, most recent first. */
  private memory: { target: T; elapsed: number; at: number }[] = [];
  private centroid: DwellPoint | null = null;

  constructor(config: IntentDecoderConfig) {
    this.cfg = { ...INTENT_DEFAULTS, ...config.tuning };
    const dwell = Math.max(1, config.dwellTimeMs);
    this.chargeTimeMs = Math.max(1, dwell * this.cfg.chargeScale);
    this.qualifyCoreMs = clamp(dwell * this.cfg.qualifyCoreFraction, this.cfg.qualifyMinMs, this.cfg.qualifyMaxMs);
    this.qualifyInkMs = clamp(dwell * this.cfg.qualifyInkFraction, this.cfg.qualifyMinMs, this.cfg.qualifyMaxMs);
    this.pauseMs = this.chargeTimeMs * this.cfg.pauseFraction;
    this.memoryMs = clamp(this.chargeTimeMs * this.cfg.memoryFraction, this.cfg.memoryMinMs, this.cfg.memoryMaxMs);
    this.gate = new SelectionGate(config);
    this.threshold = this.cfg.defaultDispersionPx;
  }

  /** The timings derived from the dwell setting. Exposed for the tuning probe. */
  get timings() {
    return {
      chargeTimeMs: this.chargeTimeMs,
      qualifyCoreMs: this.qualifyCoreMs,
      qualifyInkMs: this.qualifyInkMs,
      pauseMs: this.pauseMs,
      memoryMs: this.memoryMs,
    };
  }

  /**
   * Record one gaze sample. Call for every FRESH sample the tracker produces,
   * not once per render tick — dispersion is only meaningful at the sensor's
   * own rate, and repeating a stale point would fake stillness.
   */
  addSample(x: number, y: number, t: number) {
    this.samples.push({ x, y, t });
    this.trim(t);
  }

  /** Drop the in-progress decode (e.g. the input point disappeared). */
  clearTarget() {
    this.current = null;
    this.elapsed = 0;
    this.memory = [];
  }

  /** Current adaptive stillness threshold, px. Exposed for the debug readout. */
  get stillnessThreshold(): number {
    return this.threshold;
  }

  update(
    target: T | null,
    zone: IntentZone,
    point: DwellPoint,
    now: number,
    lastSampleAt: number,
  ): IntentTickResult<T> {
    const dt = this.started ? Math.min(this.cfg.maxTickMs, Math.max(0, now - this.lastTickAt)) : 0;
    this.started = true;
    this.lastTickAt = now;

    this.trim(now);
    const dispersion = this.dispersion();
    this.smoothCentroid(point, dt);

    const gate = this.gate.check(point, now, lastSampleAt);
    if (gate.gazeStale) {
      this.park(now);
      this.current = null;
      return this.res(null, "scanning", zone, 0, null, dispersion, false, false, gate);
    }

    // Only the student's own on-target gaze calibrates the threshold; samples
    // taken while they're looking at nothing are not fixations.
    if (target) this.calibrate(dispersion, now);

    if (!gate.armed || !target) {
      this.park(now);
      this.current = null;
      return this.res(null, "scanning", zone, 0, null, dispersion, false, false, gate);
    }

    if (target !== this.current) {
      this.park(now);
      this.acquire(target, now);
    }

    const stable = dispersion <= this.threshold;
    const chargeable = zone !== "rest";

    if (stable && chargeable) {
      if (this.stableSince < 0) this.stableSince = now;
    } else {
      // A fresh saccade means the next fixation must earn qualification again.
      this.stableSince = -1;
      this.qualified = false;
    }

    const qualifyMs =
      (zone === "core" ? this.qualifyCoreMs : this.qualifyInkMs) *
      (this.revisit ? this.cfg.revisitQualifyScale : 1);
    if (this.stableSince >= 0 && now - this.stableSince >= qualifyMs) this.qualified = true;

    // The accessibility floor: held long enough, it charges regardless.
    const fallback =
      chargeable && !this.qualified && now - this.targetSince >= this.chargeTimeMs * this.cfg.fallbackAfterCharges;

    let state: IntentState = "scanning";
    let rate = 0;
    if (this.qualified && chargeable) {
      state = "charging";
      rate = zone === "core" ? this.cfg.rateCore : this.cfg.rateInk;
    } else if (fallback) {
      state = "charging";
      rate = this.cfg.fallbackRate;
    } else if (this.stableSince >= 0) {
      state = "settling";
    }

    let draining = false;
    if (rate > 0) {
      this.notChargingSince = -1;
      this.elapsed = Math.min(this.chargeTimeMs, this.elapsed + dt * rate);
    } else {
      if (this.notChargingSince < 0) this.notChargingSince = now;
      const off = now - this.notChargingSince;
      if (off > this.pauseMs && this.elapsed > 0) {
        const drainingFor = (off - this.pauseMs) / 1000;
        const drainRate = Math.min(
          this.cfg.drainMaxRate,
          this.cfg.drainStartRate + this.cfg.drainRampPerSec * drainingFor,
        );
        this.elapsed = Math.max(0, this.elapsed - dt * drainRate);
        draining = true;
      }
    }

    const progress = Math.min(1, this.elapsed / this.chargeTimeMs);
    if (progress >= 1) {
      this.gate.lock(point);
      this.current = null;
      this.elapsed = 0;
      // A completed selection settles the question — nothing left to resume.
      this.memory = [];
      return this.res(null, "charging", zone, 1, target, dispersion, false, fallback, gate);
    }

    return this.res(target, state, zone, progress, null, dispersion, draining, fallback, gate);
  }

  // ── Target lifecycle ──────────────────────────────────────────────

  /** Stash the outgoing target's progress so a quick return can resume it. */
  private park(now: number) {
    if (this.current === null || this.elapsed <= 0) return;
    const target = this.current;
    const existing = this.memory.findIndex((m) => m.target === target);
    if (existing >= 0) this.memory.splice(existing, 1);
    this.memory.unshift({ target, elapsed: this.elapsed, at: now });
    if (this.memory.length > this.cfg.memorySlots) this.memory.length = this.cfg.memorySlots;
  }

  private acquire(target: T, now: number) {
    this.current = target;
    this.targetSince = now;
    this.stableSince = -1;
    this.qualified = false;
    this.notChargingSince = -1;
    this.elapsed = 0;
    this.revisit = false;

    const idx = this.memory.findIndex((m) => m.target === target);
    if (idx >= 0) {
      const [parked] = this.memory.splice(idx, 1);
      const away = now - parked.at;
      if (away <= this.memoryMs) {
        this.elapsed = parked.elapsed * (1 - away / this.memoryMs);
        // A hit-test blip between two frames isn't a decision to come back.
        this.revisit = away >= this.cfg.revisitMinAwayMs;
      }
    }
    // Drop anything too old to be resumable rather than carrying dead weight.
    this.memory = this.memory.filter((m) => now - m.at <= this.memoryMs);
  }

  // ── Signal processing ─────────────────────────────────────────────

  private trim(now: number) {
    const cutoff = now - this.cfg.dispersionWindowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }

  /** I-DT dispersion: summed extent of the sample bounding box. */
  private dispersion(): number {
    if (this.samples.length < 2) return 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of this.samples) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }
    return maxX - minX + (maxY - minY);
  }

  private calibrate(dispersion: number, now: number) {
    if (this.samples.length < 2) return;
    if (this.history.length < this.cfg.calibrationSize) {
      this.history.push(dispersion);
    } else {
      this.history[this.historyIdx] = dispersion;
      this.historyIdx = (this.historyIdx + 1) % this.cfg.calibrationSize;
    }

    if (now - this.thresholdAt < this.cfg.calibrationRefreshMs) return;
    this.thresholdAt = now;
    if (this.history.length < this.cfg.calibrationMinSamples) return;

    const sorted = [...this.history].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * this.cfg.calibrationPercentile));
    this.threshold = Math.max(
      this.cfg.minDispersionPx,
      Math.min(this.cfg.maxDispersionPx, sorted[idx] * this.cfg.dispersionSlack),
    );
  }

  private smoothCentroid(point: DwellPoint, dt: number) {
    let tx = point.x;
    let ty = point.y;
    if (this.samples.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const s of this.samples) {
        sx += s.x;
        sy += s.y;
      }
      tx = sx / this.samples.length;
      ty = sy / this.samples.length;
    }
    if (!this.centroid || dt === 0) {
      this.centroid = { x: tx, y: ty };
      return;
    }
    // Frame-rate independent exponential smoothing.
    const a = 1 - Math.exp(-dt / this.cfg.centroidTauMs);
    this.centroid = {
      x: this.centroid.x + (tx - this.centroid.x) * a,
      y: this.centroid.y + (ty - this.centroid.y) * a,
    };
  }

  private res(
    target: T | null,
    state: IntentState,
    zone: IntentZone,
    progress: number,
    fired: T | null,
    dispersion: number,
    draining: boolean,
    fallback: boolean,
    gate: { hoverEnabled: boolean; gazeStale: boolean; movementFromAnchor: number },
  ): IntentTickResult<T> {
    return {
      target,
      state,
      zone,
      progress,
      fired,
      centroid: this.centroid,
      dispersion,
      threshold: this.threshold,
      draining,
      fallback,
      revisit: this.revisit,
      hoverEnabled: gate.hoverEnabled,
      gazeStale: gate.gazeStale,
      movementFromAnchor: gate.movementFromAnchor,
    };
  }
}
