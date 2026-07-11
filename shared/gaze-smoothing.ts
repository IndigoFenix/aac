// shared/gaze-smoothing.ts
// Visual-angle smoothing for hardware eye-tracker streams (Tobii, EyeTech, …).
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
//
// WHY DEGREES, NOT PIXELS. The eye-movement literature specifies fixation
// dispersion and saccade thresholds in DEGREES OF VISUAL ANGLE (Salvucci &
// Goldberg 2000: fixation dispersion ~0.5-1.0°), not pixels — because the same
// pixel spread is a big eye movement on a phone held close and a tiny one on a
// wall display far away. So the whole pipeline runs in angular space: incoming
// pixels are divided by `pixelsPerDegree` on the way in and multiplied back on
// the way out. `pixelsPerDegree` is set live from the viewing geometry (screen
// density × distance), so the presets behave consistently across the different
// screens and seating distances real students use. When no geometry is known
// it falls back to DEFAULT_PIXELS_PER_DEGREE (a typical desktop), which keeps
// behaviour identical to the old pixel-space filter.

export interface OneEuroConfig {
  /** Baseline cutoff (Hz). Lower = more smoothing while the eye is still. */
  minCutoff?: number;
  /** Speed coefficient (per deg/s). Higher = follows fast saccades with less lag. */
  beta?: number;
  /** Cutoff (Hz) for the velocity estimate that drives the adaptive cutoff. */
  dCutoff?: number;
}

export interface FixationLockConfig {
  /** Max spread (degrees, summed x+y extent) of a cluster still counted as one fixation. */
  dispersionDeg?: number;
  /** Trailing window (ms) the dispersion is measured over. */
  windowMs?: number;
  /** The cluster must stay small this long (ms) before the lock engages. */
  minDurationMs?: number;
}

export interface GazeSmootherConfig {
  oneEuro?: OneEuroConfig;
  /** Fixation lock settings, or `false` to run the One-Euro stage only. */
  fixation?: FixationLockConfig | false;
  /**
   * On-screen pixels per degree of visual angle. Converts the raw pixel stream
   * into the angular space the filter reasons in. Update live via
   * `setPixelsPerDegree` as the viewing distance changes. Falls back to
   * DEFAULT_PIXELS_PER_DEGREE when omitted/invalid.
   */
  pixelsPerDegree?: number;
}

export interface SmoothPoint {
  x: number;
  y: number;
}

/** A typical desktop tracker at arm's length: ~35 screen px subtend 1° of gaze. */
export const DEFAULT_PIXELS_PER_DEGREE = 35;

// =============================================================================
// CLINICIAN-FACING SETTINGS MODEL
// =============================================================================

/**
 * Named strength presets plus `custom` (any manually-tuned value). Surfaced as
 * a per-student AAC setting; picking a preset fills the advanced sliders,
 * moving a slider flips the label to `custom`.
 */
export type GazeSmoothingPreset = "off" | "light" | "medium" | "strong" | "custom";

export const GAZE_SMOOTHING_PRESETS: GazeSmoothingPreset[] = [
  "off",
  "light",
  "medium",
  "strong",
];

/** How the viewing distance (used for the degree↔pixel conversion) is obtained. */
export type ViewingDistanceMode = "face" | "fixed";

/**
 * The full per-student smoothing configuration. Stored as JSON in the single
 * `aac_settings.eyegaze_smoothing` column. Every runtime parameter is here so
 * the advanced-tuning UI can expose each one as a slider.
 */
export interface GazeSmoothingSettings {
  /** Which preset the sliders match, or `custom` once hand-tuned. `off` disables smoothing. */
  preset: GazeSmoothingPreset;
  /** One-Euro baseline cutoff (Hz). Lower = steadier while still, more lag. */
  minCutoff: number;
  /** One-Euro speed coefficient (per deg/s). Higher = keeps up with fast moves. */
  beta: number;
  /** Whether the dispersion-based fixation lock (pin-to-centroid) is active. */
  fixationEnabled: boolean;
  /** Fixation zone diameter in degrees of visual angle. */
  dispersionDeg: number;
  /** How long (ms) the eye must hold inside the zone before the lock engages. */
  minDurationMs: number;
  /** `face` = estimate distance from camera face size; `fixed` = use fixedDistanceCm. */
  distanceMode: ViewingDistanceMode;
  /** Assumed / fallback viewing distance in centimetres. */
  fixedDistanceCm: number;
}

/** Concrete numeric values for each named preset (excluding distance fields). */
type PresetCore = Pick<
  GazeSmoothingSettings,
  "minCutoff" | "beta" | "fixationEnabled" | "dispersionDeg" | "minDurationMs"
>;

const PRESET_CORES: Record<Exclude<GazeSmoothingPreset, "custom">, PresetCore> = {
  // `off` numbers are inert (smoothing is bypassed) but kept sensible so that
  // switching off→custom starts from a reasonable place.
  off: { minCutoff: 1.0, beta: 0.2, fixationEnabled: true, dispersionDeg: 1.0, minDurationMs: 150 },
  // Snappier: higher cutoff (less lag), tighter/shorter fixation lock.
  light: { minCutoff: 2.0, beta: 0.4, fixationEnabled: true, dispersionDeg: 0.7, minDurationMs: 120 },
  // Balanced default (equals the module defaults).
  medium: { minCutoff: 1.0, beta: 0.2, fixationEnabled: true, dispersionDeg: 1.0, minDurationMs: 150 },
  // Steadiest: lower cutoff (more smoothing), wider/longer fixation lock.
  strong: { minCutoff: 0.6, beta: 0.12, fixationEnabled: true, dispersionDeg: 1.4, minDurationMs: 200 },
};

const DISTANCE_DEFAULTS: Pick<GazeSmoothingSettings, "distanceMode" | "fixedDistanceCm"> = {
  distanceMode: "face",
  fixedDistanceCm: 60,
};

/** Full settings for a named preset. `custom` seeds from the medium numbers. */
export function settingsForPreset(preset: GazeSmoothingPreset): GazeSmoothingSettings {
  const core = PRESET_CORES[preset === "custom" ? "medium" : preset] ?? PRESET_CORES.medium;
  return { preset, ...core, ...DISTANCE_DEFAULTS };
}

export function defaultSmoothingSettings(): GazeSmoothingSettings {
  return settingsForPreset("medium");
}

/** Clamp a numeric field, falling back to `fallback` when absent/invalid. */
function numField(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse the stored value into settings. Accepts:
 *  - `null`/`undefined`            → medium defaults
 *  - a bare preset string          → that preset (legacy format)
 *  - a JSON string or plain object → merged over defaults, clamped
 * Never throws — malformed input yields defaults.
 */
export function parseSmoothingSettings(raw: unknown): GazeSmoothingSettings {
  if (raw == null) return defaultSmoothingSettings();

  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "off" || s === "light" || s === "medium" || s === "strong") {
      return settingsForPreset(s);
    }
    try {
      raw = JSON.parse(s);
    } catch {
      return defaultSmoothingSettings();
    }
  }

  if (typeof raw !== "object" || raw === null) return defaultSmoothingSettings();

  const o = raw as Record<string, unknown>;
  const base = defaultSmoothingSettings();
  const preset: GazeSmoothingPreset =
    o.preset === "off" || o.preset === "light" || o.preset === "medium" ||
    o.preset === "strong" || o.preset === "custom"
      ? (o.preset as GazeSmoothingPreset)
      : "custom";

  return {
    preset,
    minCutoff: numField(o.minCutoff, base.minCutoff, 0.1, 10),
    beta: numField(o.beta, base.beta, 0, 5),
    fixationEnabled: typeof o.fixationEnabled === "boolean" ? o.fixationEnabled : base.fixationEnabled,
    dispersionDeg: numField(o.dispersionDeg, base.dispersionDeg, 0.1, 5),
    minDurationMs: numField(o.minDurationMs, base.minDurationMs, 40, 1000),
    distanceMode: o.distanceMode === "fixed" ? "fixed" : "face",
    fixedDistanceCm: numField(o.fixedDistanceCm, base.fixedDistanceCm, 20, 200),
  };
}

/** Serialize settings for storage in the `eyegaze_smoothing` text column. */
export function serializeSmoothingSettings(s: GazeSmoothingSettings): string {
  return JSON.stringify(s);
}

/**
 * Build a runtime GazeSmoother config from clinician settings.
 * Returns `false` (no smoothing) when the preset is `off`.
 * `pixelsPerDegree`, when known, is baked in; otherwise the smoother uses its
 * default until `setPixelsPerDegree` is called.
 */
export function smootherConfigFromSettings(
  s: GazeSmoothingSettings,
  pixelsPerDegree?: number,
): GazeSmootherConfig | false {
  if (s.preset === "off") return false;
  return {
    oneEuro: { minCutoff: s.minCutoff, beta: s.beta },
    fixation: s.fixationEnabled
      ? {
          dispersionDeg: s.dispersionDeg,
          minDurationMs: s.minDurationMs,
          // The measurement window must retain enough history to see a span
          // >= minDurationMs; a small margin keeps the lock from thrashing.
          windowMs: s.minDurationMs + 100,
        }
      : false,
    ...(pixelsPerDegree && pixelsPerDegree > 0 ? { pixelsPerDegree } : {}),
  };
}

// =============================================================================
// VIEWING GEOMETRY
// =============================================================================

/**
 * On-screen pixels per degree of visual angle for a given screen density and
 * viewing distance. px/deg = pxPerCm · distanceCm · tan(1°). Returns the
 * default when either input is invalid so callers never get NaN.
 */
export function pixelsPerDegreeFromGeometry(pxPerCm: number, viewingDistanceCm: number): number {
  if (!(pxPerCm > 0) || !(viewingDistanceCm > 0)) return DEFAULT_PIXELS_PER_DEGREE;
  return pxPerCm * viewingDistanceCm * Math.tan(Math.PI / 180);
}

// =============================================================================
// FILTER INTERNALS
// =============================================================================

const ONE_EURO_DEFAULTS: Required<OneEuroConfig> = {
  // Tuned for gaze in DEGREES at ~60Hz: still-eye velocities are a fraction of
  // a deg/s (→ cutoff ≈ minCutoff, strong smoothing); saccades reach hundreds
  // of deg/s (→ cutoff jumps to ~15-30Hz via beta, so the filter keeps up).
  minCutoff: 1.0,
  beta: 0.2,
  dCutoff: 1.0,
};

const FIXATION_DEFAULTS: Required<FixationLockConfig> = {
  dispersionDeg: 1.0,
  windowMs: 250,
  minDurationMs: 150,
};

const TWO_PI = 2 * Math.PI;

/** Smoothing factor for a first-order low-pass at the given cutoff and timestep. */
function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (TWO_PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/** Single-axis One-Euro filter (operates in whatever units it is fed — here, degrees). */
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
 * Two-stage gaze smoother: One-Euro filter + dispersion-based fixation lock,
 * both operating in degrees of visual angle. Feed every accepted sample (in
 * pixels) through `filter`; call `reset` whenever the input stream breaks
 * (tracking lost / eyes reacquired) so stale state can't drag the cursor across
 * the screen when it resumes. Call `setPixelsPerDegree` whenever the viewing
 * distance estimate changes.
 */
export class GazeSmoother {
  private readonly axisX: OneEuroAxis;
  private readonly axisY: OneEuroAxis;
  private readonly fixation: Required<FixationLockConfig> | null;
  private ppd: number;

  private lastT: number | null = null;
  private window: Stamped[] = [];
  private locked: SmoothPoint | null = null; // degrees

  constructor(config: GazeSmootherConfig = {}) {
    const euro = { ...ONE_EURO_DEFAULTS, ...config.oneEuro };
    this.axisX = new OneEuroAxis(euro);
    this.axisY = new OneEuroAxis(euro);
    this.fixation =
      config.fixation === false ? null : { ...FIXATION_DEFAULTS, ...config.fixation };
    this.ppd =
      config.pixelsPerDegree && config.pixelsPerDegree > 0
        ? config.pixelsPerDegree
        : DEFAULT_PIXELS_PER_DEGREE;
  }

  /** Update the pixel↔degree conversion live (viewing distance changed). */
  setPixelsPerDegree(pixelsPerDegree: number) {
    if (pixelsPerDegree > 0) this.ppd = pixelsPerDegree;
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

    const ppd = this.ppd;
    // Convert to degrees, filter, convert back to pixels on output.
    const fxDeg = this.axisX.filter(x / ppd, dtSec);
    const fyDeg = this.axisY.filter(y / ppd, dtSec);

    if (!this.fixation) return { x: fxDeg * ppd, y: fyDeg * ppd };

    const p = this.applyFixationLock(fxDeg, fyDeg, timestampMs);
    return { x: p.x * ppd, y: p.y * ppd };
  }

  /** All coordinates here are in degrees of visual angle. */
  private applyFixationLock(fx: number, fy: number, t: number): SmoothPoint {
    const { dispersionDeg, windowMs, minDurationMs } = this.fixation!;

    // If we're locked and the new point is still inside the fixation region,
    // hold the centroid steady. Otherwise the eye moved — release and re-seed.
    if (this.locked) {
      if (Math.abs(fx - this.locked.x) + Math.abs(fy - this.locked.y) <= dispersionDeg) {
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

    if (dispersion <= dispersionDeg && span >= minDurationMs) {
      // Stable long enough → lock to the window centroid.
      let sx = 0, sy = 0;
      for (const p of this.window) { sx += p.x; sy += p.y; }
      this.locked = { x: sx / this.window.length, y: sy / this.window.length };
      return this.locked;
    }

    // Still moving (or not settled long enough) — stream the One-Euro point.
    if (dispersion > dispersionDeg) this.window = [{ x: fx, y: fy, t }];
    return { x: fx, y: fy };
  }
}
