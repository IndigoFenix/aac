// shared/dwell-engine.ts
// Pure dwell-selection state machine for gaze/cursor input — the decision
// core behind the AAC's EyeTrackingDwellContext, extracted so its safety
// rules are unit-testable without a DOM (see server/tests/dwell-engine.test.ts).
//
// The two safety rules (movement-only re-arm, stale-gaze suspension) live in
// `SelectionGate` — see shared/selection-gate.ts for why they exist. This file
// owns only the timing: how fast a held target fills, and when it fires.
//
// SELECTION-AREA MODE
// Some targets carry a small "confirm" sub-target (a SELECTION AREA) placed so
// it never overlaps the button's text — students who dwell the whole button
// can't read a label without selecting it. When a tick reports `inArea`, this
// engine switches that target to accumulate/decay semantics instead of
// straight wall-clock:
//   - gaze inside the area  → the timer fills at the normal rate;
//   - gaze on the target but OUTSIDE the area (i.e. reading the label) → the
//     timer holds for `pauseMs`, then drains at a rate that ramps up the longer
//     the gaze stays off the area, so a quick glance costs almost nothing and
//     genuine loss of interest still empties it;
//   - gaze off the target entirely → the timer resets to zero (the target
//     stops being `current`, exactly as in whole-button mode).
// Pass `inArea` as undefined for targets with no selection area — those keep
// the original whole-button behaviour untouched.

import { SelectionGate, DEFAULT_REACTIVATION_PX, type DwellPoint } from "./selection-gate.js";

export { DEFAULT_REACTIVATION_PX };
export type { DwellPoint };

/** Fill/drain tuning for targets that carry a SELECTION AREA. */
export interface DwellAreaConfig {
  /** Grace period after the gaze leaves the area before the timer starts draining. */
  pauseMs: number;
  /** Drain speed the moment draining starts, as a multiple of the fill rate. */
  drainStartRate: number;
  /** How much the drain multiplier grows per further second off the area. */
  drainRampPerSec: number;
  /** Ceiling on the drain multiplier. */
  drainMaxRate: number;
}

/**
 * Tuned around the default 2s dwell: reading a label for ~2s costs roughly a
 * quarter of the timer (recoverable), while genuinely disengaging empties it in
 * a couple more seconds. Cheap glances must stay cheap — the whole point of the
 * selection area is that looking at the text is allowed.
 */
export const DEFAULT_AREA_CONFIG: DwellAreaConfig = {
  pauseMs: 600,
  drainStartRate: 0.15,
  drainRampPerSec: 0.35,
  drainMaxRate: 1.5,
};

export interface DwellEngineConfig {
  /** Time the cursor must stay on one target before it fires. */
  dwellTimeMs: number;
  /** Movement (px) from the post-selection anchor required to re-arm hover. */
  reactivationPx?: number;
  /** Suspend dwell when the last sample is older than this. null disables gating. */
  staleGazeMs?: number | null;
  /** Overrides for selection-area fill/drain behaviour. */
  area?: Partial<DwellAreaConfig>;
}

export interface DwellTickResult<T> {
  /** Target currently being dwelled on (null when disabled, stale, or off-target). */
  target: T | null;
  /** 0-1 progress toward firing on `target`. */
  progress: number;
  /** Set on the single tick a selection fires. */
  fired: T | null;
  hoverEnabled: boolean;
  gazeStale: boolean;
  /** Distance travelled from the post-selection anchor (0 once re-armed). */
  movementFromAnchor: number;
  /** Selection-area mode only: the timer is currently losing ground. */
  draining: boolean;
}

export class DwellEngine<T> {
  private readonly dwellTimeMs: number;
  private readonly gate: SelectionGate;
  private readonly area: DwellAreaConfig;

  private current: T | null = null;
  private dwellStart = 0;
  // Selection-area mode only: an accumulator (rather than wall-clock from
  // `dwellStart`) because the timer can go backwards.
  private elapsed = 0;
  private lastTickAt = 0;
  /** Time the gaze left the selection area; 0 while it's inside. */
  private offAreaSince = 0;

  constructor(config: DwellEngineConfig) {
    this.dwellTimeMs = config.dwellTimeMs;
    this.gate = new SelectionGate(config);
    this.area = { ...DEFAULT_AREA_CONFIG, ...config.area };
  }

  /** Drop the in-progress dwell (e.g. the input point disappeared). */
  clearTarget() {
    this.current = null;
  }

  /**
   * Advance one tick.
   * @param target       hit-test result under `point` (opaque identity)
   * @param point        current cursor/gaze position
   * @param now          current time (same clock as `lastSampleAt`)
   * @param lastSampleAt time the input source last produced a fresh sample
   * @param inArea       whether `point` is inside the target's SELECTION AREA.
   *                     Leave undefined for targets that have none — they keep
   *                     whole-button dwell.
   */
  update(
    target: T | null,
    point: DwellPoint,
    now: number,
    lastSampleAt: number,
    inArea?: boolean,
  ): DwellTickResult<T> {
    const gate = this.gate.check(point, now, lastSampleAt);
    if (gate.gazeStale) {
      this.current = null;
      return this.result(null, 0, null, true, 0, false);
    }

    if (!gate.armed || !target) {
      this.current = null;
      return this.result(null, 0, null, false, gate.movementFromAnchor, false);
    }

    if (target === this.current) {
      const dt = Math.max(0, now - this.lastTickAt);
      this.lastTickAt = now;

      let draining = false;
      if (inArea === undefined) {
        // Whole-button dwell — plain wall-clock since the target was acquired.
        this.elapsed = now - this.dwellStart;
      } else if (inArea) {
        this.offAreaSince = 0;
        this.elapsed = Math.min(this.dwellTimeMs, this.elapsed + dt);
      } else {
        // On the button but off the area: hold, then drain ever faster.
        if (this.offAreaSince === 0) this.offAreaSince = now;
        const offFor = now - this.offAreaSince;
        if (offFor > this.area.pauseMs && this.elapsed > 0) {
          const drainingFor = (offFor - this.area.pauseMs) / 1000;
          const rate = Math.min(
            this.area.drainMaxRate,
            this.area.drainStartRate + this.area.drainRampPerSec * drainingFor,
          );
          this.elapsed = Math.max(0, this.elapsed - dt * rate);
          draining = true;
        }
      }

      const progress = Math.min(1, this.elapsed / this.dwellTimeMs);
      if (progress >= 1) {
        this.gate.lock(point);
        this.current = null;
        return this.result(null, 1, target, false, 0, false);
      }
      return this.result(target, progress, null, false, 0, draining);
    }

    this.current = target;
    this.dwellStart = now;
    this.lastTickAt = now;
    this.elapsed = 0;
    this.offAreaSince = 0;
    return this.result(target, 0, null, false, gate.movementFromAnchor, false);
  }

  private result(
    target: T | null,
    progress: number,
    fired: T | null,
    gazeStale: boolean,
    movementFromAnchor: number,
    draining: boolean,
  ): DwellTickResult<T> {
    return { target, progress, fired, hoverEnabled: this.gate.hoverEnabled, gazeStale, movementFromAnchor, draining };
  }
}
