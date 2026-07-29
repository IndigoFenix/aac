// shared/world-engine/dwell.ts
//
// A LENIENT dwell timer for eyegaze. Holding a gaze perfectly still is
// impossible, so a naive "did the fixation point change?" check resets the timer
// constantly. This tracker accumulates fixation time toward a threshold while:
//   • the gaze stays within a spatial TOLERANCE of where the dwell started
//     (small jitter doesn't reset it), and
//   • brief drop-outs (micro-saccades where the fixation goes null) are bridged
//     by a GRACE window rather than resetting.
// After firing it LATCHES: it won't fire again until the gaze actually LEAVES the
// spot (so you can't pick-up/put-down the same object every frame while staring
// at it). Used for carry pick/put-down and NPC dwell-to-talk / dwell-to-leave.

export interface DwellTarget {
  x: number;
  y: number;
}

export interface DwellStep {
  /** True on the single frame the dwell crosses its threshold. */
  fired: boolean;
  /** 0..1 fill, for a dwell-timer indicator (0 while latched/idle). */
  progress: number;
}

export interface DwellTracker {
  /** Advance one frame against the current fixation point (null = looking at
   *  nothing relevant, or mid-saccade). */
  step(target: DwellTarget | null, dtMs: number): DwellStep;
  /** Where the active dwell is anchored (where to place / what to act on). */
  anchor(): DwellTarget | null;
  reset(): void;
}

export function createDwellTracker(opts: {
  dwellMs: number;
  /** World-unit radius of jitter tolerated before the dwell re-anchors. */
  tolerance: number;
  /** How long a null fixation (blink/micro-saccade) is bridged before giving up. */
  graceMs?: number;
}): DwellTracker {
  const dwellMs = opts.dwellMs;
  const tol = opts.tolerance;
  const graceMs = opts.graceMs ?? 400;

  let anchor: DwellTarget | null = null;
  let acc = 0;
  let idle = 0;
  let latched = false;

  const near = (t: DwellTarget): boolean =>
    !!anchor && Math.hypot(anchor.x - t.x, anchor.y - t.y) <= tol;

  return {
    step(target, dtMs) {
      if (target) {
        if (near(target)) {
          idle = 0;
          if (latched) return { fired: false, progress: 0 };
          acc += dtMs;
          if (acc >= dwellMs) {
            latched = true;
            return { fired: true, progress: 1 };
          }
          return { fired: false, progress: acc / dwellMs };
        }
        // Genuinely moved to a new spot → re-anchor + clear the latch (this is the
        // "leave before re-trigger" exit: looking away then back starts fresh).
        anchor = { x: target.x, y: target.y };
        acc = 0;
        idle = 0;
        latched = false;
        return { fired: false, progress: 0 };
      }
      // No fixation this frame: bridge a brief gap, holding the anchor + fill.
      if (anchor) {
        idle += dtMs;
        if (idle > graceMs) {
          anchor = null;
          acc = 0;
          latched = false;
        } else if (!latched && acc > 0) {
          acc += dtMs;
        }
      }
      return { fired: false, progress: latched || !anchor ? 0 : Math.min(1, acc / dwellMs) };
    },
    anchor: () => anchor,
    reset() {
      anchor = null;
      acc = 0;
      idle = 0;
      latched = false;
    },
  };
}
