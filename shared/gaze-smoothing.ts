// shared/gaze-smoothing.ts
// Pixel-space smoothing for hardware eye-tracker streams (Tobii, EyeTech, …).
// Kept DOM-free and pure so its behaviour is unit-testable in `npm test`
// (see server/tests/gaze-smoothing.test.ts), mirroring shared/dwell-engine.ts.
//
// Hardware trackers stream one raw gaze sample per device frame (~60-120Hz)
// with no smoothing — the cursor visibly trembles even when the eye is holding
// still on a target. Two stages tame this without adding perceptible lag:
//
//   1. One-Euro filter (Casiez, Roussel & Vogel, CHI 2012) per axis. An
//      adaptive low-pass whose cutoff rises with gaze velocity: heavy smoothing
//      while the eye holds still (kills tremor), light smoothing during a
//      saccade (no lag/overshoot when the eye jumps to a new target).
//   2. Dispersion-based fixation lock (an I-DT style gate). Once the filtered
//      point stays inside a small region for long enough it is a fixation, so
//      we pin the output to the region centroid — the last sliver of residual
//      jitter vanishes and dwell targeting is rock-steady. The lock releases
//      the instant the eye moves beyond the region (a saccade).

export interface OneEuroConfig {
  /** Baseline cutoff (Hz). Lower = more smoothing while the eye is still. */
  minCutoff?: number;
  /** Speed coefficient. Higher = follows fast saccades with less lag. */
  beta?: number;
  /** Cutoff (Hz) for the velocity estimate that drives the adaptive cutoff. */
  dCutoff?: number;
}

export interface FixationLockConfig {
  /** Max spread (px, summed x+y extent) of a cluster still counted as one fixation. */
  dispersionPx?: number;
  /** Trailing window (ms) the dispersion is measured over. */
  windowMs?: number;
  /** The cluster must stay small this long (ms) before the lock engages. */
  minDurationMs?: number;
}

export interface GazeSmootherConfig {
  oneEuro?: OneEuroConfig;
  /** Fixation lock settings, or `false` to run the One-Euro stage only. */
  fixation?: FixationLockConfig | false;
}

export interface SmoothPoint {
  x: number;
  y: number;
}

/**
 * Clinician-facing smoothing strength. Surfaced as a per-student AAC setting so
 * caretakers can trade steadiness against responsiveness without touching raw
 * filter coefficients. `medium` is the default and equals the module defaults.
 */
export type GazeSmoothingStrength = "off" | "light" | "medium" | "strong";

export const DEFAULT_SMOOTHING_STRENGTH: GazeSmoothingStrength = "medium";

/** Map a strength level to a concrete filter config (`false` = no smoothing). */
export function smoothingConfigForStrength(
  strength: GazeSmoothingStrength | null | undefined,
): GazeSmootherConfig | false {
  switch (strength) {
    case "off":
      return false;
    case "light":
      // Snappier: higher cutoff (less lag), tighter/shorter fixation lock.
      return { oneEuro: { minCutoff: 2.0, beta: 0.01 }, fixation: { dispersionPx: 25, minDurationMs: 120 } };
    case "strong":
      // Steadiest: lower cutoff (more smoothing), wider/longer fixation lock.
      return { oneEuro: { minCutoff: 0.6, beta: 0.004 }, fixation: { dispersionPx: 45, windowMs: 250, minDurationMs: 200 } };
    case "medium":
    default:
      return {}; // module defaults
  }
}

const ONE_EURO_DEFAULTS: Required<OneEuroConfig> = {
  // Tuned for screen-pixel gaze at ~60Hz: still-eye velocities are ~10-40px/s
  // (→ cutoff ≈ minCutoff, strong smoothing); saccades reach several thousand
  // px/s (→ cutoff jumps to ~15-30Hz via beta, so it keeps up).
  minCutoff: 1.0,
  beta: 0.005,
  dCutoff: 1.0,
};

const FIXATION_DEFAULTS: Required<FixationLockConfig> = {
  dispersionPx: 35,
  windowMs: 200,
  minDurationMs: 150,
};

const TWO_PI = 2 * Math.PI;

/** Smoothing factor for a first-order low-pass at the given cutoff and timestep. */
function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (TWO_PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/** Single-axis One-Euro filter. */
class OneEuroAxis {
  private xPrev = 0;
  private dxPrev = 0;
  private initialized = false;

  constructor(private readonly cfg: Required<OneEuroConfig>) {}

  reset() {
    this.initialized = false;
    this.xPrev = 0;
    this.dxPrev = 0;
  }

  /** @param dtSec time since the previous accepted sample (seconds, > 0). */
  filter(x: number, dtSec: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }

    // Filtered derivative → adaptive cutoff.
    const dx = (x - this.xPrev) / dtSec;
    const edxAlpha = smoothingAlpha(this.cfg.dCutoff, dtSec);
    const edx = edxAlpha * dx + (1 - edxAlpha) * this.dxPrev;

    const cutoff = this.cfg.minCutoff + this.cfg.beta * Math.abs(edx);
    const alpha = smoothingAlpha(cutoff, dtSec);
    const xFiltered = alpha * x + (1 - alpha) * this.xPrev;

    this.xPrev = xFiltered;
    this.dxPrev = edx;
    return xFiltered;
  }
}

interface Stamped extends SmoothPoint {
  t: number;
}

/**
 * Two-stage gaze smoother: One-Euro filter + dispersion-based fixation lock.
 * Feed every accepted sample through `filter`; call `reset` whenever the input
 * stream breaks (tracking lost / eyes reacquired) so stale state can't drag the
 * cursor across the screen when it resumes.
 */
export class GazeSmoother {
  private readonly axisX: OneEuroAxis;
  private readonly axisY: OneEuroAxis;
  private readonly fixation: Required<FixationLockConfig> | null;

  private lastT: number | null = null;
  private window: Stamped[] = [];
  private locked: SmoothPoint | null = null;

  constructor(config: GazeSmootherConfig = {}) {
    const euro = { ...ONE_EURO_DEFAULTS, ...config.oneEuro };
    this.axisX = new OneEuroAxis(euro);
    this.axisY = new OneEuroAxis(euro);
    this.fixation =
      config.fixation === false ? null : { ...FIXATION_DEFAULTS, ...config.fixation };
  }

  /** Drop all state — next sample restarts the filter cleanly. */
  reset() {
    this.axisX.reset();
    this.axisY.reset();
    this.lastT = null;
    this.window = [];
    this.locked = null;
  }

  /**
   * Smooth one sample.
   * @param x          raw gaze x (screen px)
   * @param y          raw gaze y (screen px)
   * @param timestampMs sample time on a monotonic clock (e.g. performance.now())
   */
  filter(x: number, y: number, timestampMs: number): SmoothPoint {
    // dt from the previous sample; guard against zero/negative/huge gaps.
    let dtSec = this.lastT === null ? 1 / 60 : (timestampMs - this.lastT) / 1000;
    if (!(dtSec > 0) || dtSec > 1) dtSec = 1 / 60;
    this.lastT = timestampMs;

    const fx = this.axisX.filter(x, dtSec);
    const fy = this.axisY.filter(y, dtSec);

    if (!this.fixation) return { x: fx, y: fy };
    return this.applyFixationLock(fx, fy, timestampMs);
  }

  private applyFixationLock(fx: number, fy: number, t: number): SmoothPoint {
    const { dispersionPx, windowMs, minDurationMs } = this.fixation!;

    // If we're locked and the new point is still inside the fixation region,
    // hold the centroid steady. Otherwise the eye moved — release and re-seed.
    if (this.locked) {
      if (Math.abs(fx - this.locked.x) + Math.abs(fy - this.locked.y) <= dispersionPx) {
        return this.locked;
      }
      this.locked = null;
      this.window = [];
    }

    this.window.push({ x: fx, y: fy, t });
    // Keep only the trailing window.
    const cutoff = t - windowMs;
    while (this.window.length > 1 && this.window[0].t < cutoff) this.window.shift();

    // Dispersion = combined x+y extent of the window (I-DT dispersion metric).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of this.window) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const dispersion = maxX - minX + (maxY - minY);
    const span = this.window[this.window.length - 1].t - this.window[0].t;

    if (dispersion <= dispersionPx && span >= minDurationMs) {
      // Stable long enough → lock to the window centroid.
      let sx = 0, sy = 0;
      for (const p of this.window) { sx += p.x; sy += p.y; }
      this.locked = { x: sx / this.window.length, y: sy / this.window.length };
      return this.locked;
    }

    // Still moving (or not settled long enough) — stream the One-Euro point.
    if (dispersion > dispersionPx) this.window = [{ x: fx, y: fy, t }];
    return { x: fx, y: fy };
  }
}
