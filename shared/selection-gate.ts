// shared/selection-gate.ts
// The safety shell shared by every gaze-selection engine (DwellEngine, the
// IntentDecoder). It answers one question per tick: "is it legitimate to
// accumulate toward a selection right now?" — and nothing else. Extracted so
// the two rules below exist in exactly ONE place; a second engine that
// re-implemented them would be a second engine that could get them wrong.
//
//   1. MOVEMENT-ONLY RE-ARM. After a selection fires, further selection is
//      disabled until the point travels `reactivationPx` (straight-line) from
//      where it fired. Genuine movement is the ONLY way back. This exists
//      because of a real regression: with the gaze frozen (covered camera,
//      tracker lost the eyes, student left the device), every board rebuild
//      placed a fresh button under the stationary point and fired it, so the
//      conversation drove itself with nobody there.
//   2. STALE-GAZE SUSPENSION. With `staleGazeMs` set, selection is suspended
//      whenever the newest sample is older than that. Pass null for
//      cursor-control mode, where a physically still cursor IS the gesture and
//      stillness produces no events to judge freshness by.

export interface DwellPoint {
  x: number;
  y: number;
}

export interface SelectionGateConfig {
  /** Movement (px) from the post-selection anchor required to re-arm. */
  reactivationPx?: number;
  /** Suspend selection when the last sample is older than this. null disables gating. */
  staleGazeMs?: number | null;
}

export interface SelectionGateResult {
  /** May the caller accumulate toward a selection this tick? */
  armed: boolean;
  /** False while waiting for the post-selection movement that re-arms. */
  hoverEnabled: boolean;
  gazeStale: boolean;
  /** Distance travelled from the post-selection anchor (0 once re-armed). */
  movementFromAnchor: number;
}

export const DEFAULT_REACTIVATION_PX = 40;

export class SelectionGate {
  private readonly reactivationPx: number;
  private readonly staleGazeMs: number | null;

  private armedFlag = true;
  private anchor: DwellPoint | null = null;

  constructor(config: SelectionGateConfig = {}) {
    this.reactivationPx = config.reactivationPx ?? DEFAULT_REACTIVATION_PX;
    this.staleGazeMs = config.staleGazeMs ?? null;
  }

  /** True while selection is permitted (i.e. not waiting on a re-arm). */
  get hoverEnabled(): boolean {
    return this.armedFlag;
  }

  check(point: DwellPoint, now: number, lastSampleAt: number): SelectionGateResult {
    if (this.staleGazeMs !== null && now - lastSampleAt > this.staleGazeMs) {
      // Report no movement: a frozen point hasn't travelled anywhere, and
      // letting it re-arm off stale coordinates would defeat rule 1.
      return { armed: false, hoverEnabled: this.armedFlag, gazeStale: true, movementFromAnchor: 0 };
    }

    let movementFromAnchor = 0;
    if (!this.armedFlag) {
      if (this.anchor) {
        movementFromAnchor = Math.hypot(point.x - this.anchor.x, point.y - this.anchor.y);
      }
      if (movementFromAnchor >= this.reactivationPx) {
        this.armedFlag = true;
        this.anchor = null;
        movementFromAnchor = 0;
      }
    }

    return { armed: this.armedFlag, hoverEnabled: this.armedFlag, gazeStale: false, movementFromAnchor };
  }

  /** Call the instant a selection fires: disarm and anchor at the firing point. */
  lock(point: DwellPoint) {
    this.armedFlag = false;
    this.anchor = { x: point.x, y: point.y };
  }
}
