// shared/dwell-engine.ts
// Pure dwell-selection state machine for gaze/cursor input — the decision
// core behind the AAC's EyeTrackingDwellContext, extracted so its safety
// rules are unit-testable without a DOM (see server/tests/dwell-engine.test.ts).
//
// Safety rules:
//   1. After a selection fires, hover is disabled until the cursor travels
//      `reactivationPx` (straight-line) from where it fired. Genuine movement
//      is the ONLY way to re-arm — a board rebuild that places a new target
//      under a stationary cursor must never trigger a second selection.
//   2. With `staleGazeMs` set, dwell is suspended whenever the latest sample
//      is older than that — a frozen last-known point (tracker lost the eyes,
//      camera covered, user left) must not keep selecting. Pass null for
//      cursor-control mode, where a still cursor is the dwell gesture itself.

export interface DwellPoint {
  x: number;
  y: number;
}

export interface DwellEngineConfig {
  /** Time the cursor must stay on one target before it fires. */
  dwellTimeMs: number;
  /** Movement (px) from the post-selection anchor required to re-arm hover. */
  reactivationPx?: number;
  /** Suspend dwell when the last sample is older than this. null disables gating. */
  staleGazeMs?: number | null;
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
}

export const DEFAULT_REACTIVATION_PX = 40;

export class DwellEngine<T> {
  private readonly dwellTimeMs: number;
  private readonly reactivationPx: number;
  private readonly staleGazeMs: number | null;

  private hoverEnabled = true;
  private anchor: DwellPoint | null = null;
  private current: T | null = null;
  private dwellStart = 0;

  constructor(config: DwellEngineConfig) {
    this.dwellTimeMs = config.dwellTimeMs;
    this.reactivationPx = config.reactivationPx ?? DEFAULT_REACTIVATION_PX;
    this.staleGazeMs = config.staleGazeMs ?? null;
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
   */
  update(target: T | null, point: DwellPoint, now: number, lastSampleAt: number): DwellTickResult<T> {
    if (this.staleGazeMs !== null && now - lastSampleAt > this.staleGazeMs) {
      this.current = null;
      return this.result(null, 0, null, true, 0);
    }

    let movementFromAnchor = 0;
    if (!this.hoverEnabled) {
      if (this.anchor) {
        movementFromAnchor = Math.hypot(point.x - this.anchor.x, point.y - this.anchor.y);
      }
      if (movementFromAnchor >= this.reactivationPx) {
        this.hoverEnabled = true;
        this.anchor = null;
        movementFromAnchor = 0;
      }
    }

    if (!this.hoverEnabled || !target) {
      this.current = null;
      return this.result(null, 0, null, false, movementFromAnchor);
    }

    if (target === this.current) {
      const progress = Math.min(1, (now - this.dwellStart) / this.dwellTimeMs);
      if (progress >= 1) {
        this.hoverEnabled = false;
        this.anchor = { x: point.x, y: point.y };
        this.current = null;
        return this.result(null, 1, target, false, 0);
      }
      return this.result(target, progress, null, false, 0);
    }

    this.current = target;
    this.dwellStart = now;
    return this.result(target, 0, null, false, movementFromAnchor);
  }

  private result(
    target: T | null,
    progress: number,
    fired: T | null,
    gazeStale: boolean,
    movementFromAnchor: number,
  ): DwellTickResult<T> {
    return { target, progress, fired, hoverEnabled: this.hoverEnabled, gazeStale, movementFromAnchor };
  }
}
