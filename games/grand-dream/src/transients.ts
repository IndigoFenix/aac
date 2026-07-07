/**
 * Interpolated transients — the GENERIC core (timescales.md §5b).
 *
 * Idle-safe systems compute endpoints, not journeys: a derived field jumps
 * to its new solve, a founding transaction adds a whole city in one day
 * boundary, a re-solved flow net reroutes every caravan at once. This
 * module is the presentation discipline that makes those jumps read as
 * PROCESS, shared by everything that draws the world:
 *
 *   AUTHORITATIVE STATE MAY JUMP; WHAT THE PLAYER SEES EASES TOWARD IT.
 *   Presentation is a stateless-enough function of (shown, target, clock),
 *   never read back by the sim, and PRIMED at first sight — what already
 *   existed when you arrived does not animate.
 *
 * Three primitives, in increasing structure:
 *
 *   - easeToward       — one scalar step of the universal ease. No memory
 *                        of the start ⇒ retargeting mid-transient is free
 *                        (the target moves; the shown value bends).
 *   - createEasedValues — a keyed family of eased scalars for CONTINUOUS
 *                        quantities that jump (route widths, flow volumes,
 *                        city radii). Keys prime at their first target.
 *   - createRevealTracker — the DISCRETE analogue, for things that are
 *                        born or die (cities, routes, buildings): tracks
 *                        first-seen wall-clock per key and exposes a 0→1
 *                        grow-in phase, plus a fade-out phase for removed
 *                        keys. Keys present on the very first frame are
 *                        primed as already-revealed.
 *
 * The substrate presenter (substrate-render.ts) is the field-shaped
 * instance of the same idea, with a domain gate on top (the river carve
 * front). City founding and trade-route formation ride the tracker.
 */

/** One ease step: move `shown` toward `target` over `dt` seconds with time
 *  constant `tauUp` (rising) / `tauDown` (falling), snapping to rest when
 *  within `snap`. */
export function easeToward(
  shown: number, target: number, dt: number,
  tauUp: number, tauDown: number = tauUp, snap = 1e-3,
): number {
  if (shown === target) return target;
  const k = 1 - Math.exp(-dt / (shown < target ? tauUp : tauDown));
  const next = shown + (target - shown) * k;
  return Math.abs(target - next) < snap ? target : next;
}

/** Clamp a frame delta: absurd gaps (tab was hidden) play as one step. */
export function frameDt(lastTs: number, ts: number): number {
  return lastTs < 0 ? 0 : Math.min(0.25, Math.max(0, ts - lastTs));
}

export interface EasedValues {
  /** Advance the shared clock. Call once per frame before any value(). */
  frame(ts: number): void;
  /** The eased value for `key`, moving toward `target`. A key seen for the
   *  first time PRIMES at its target (no animation). Keys not asked about
   *  during a whole frame are forgotten. */
  value(key: string, target: number): number;
}

export function createEasedValues(tauUp: number, tauDown: number = tauUp, snap = 1e-3): EasedValues {
  const vals = new Map<string, number>();
  let touched = new Set<string>();
  let lastTs = -1;
  let dt = 0;
  return {
    frame(ts) {
      dt = frameDt(lastTs, ts);
      lastTs = ts;
      // Forget keys nobody asked about during the frame that just ended —
      // presentation state only; a re-appearing key simply re-primes.
      for (const k of vals.keys()) {
        if (!touched.has(k)) vals.delete(k);
      }
      touched = new Set();
    },
    value(key, target) {
      touched.add(key);
      const cur = vals.get(key);
      if (cur === undefined) {
        vals.set(key, target);
        return target;
      }
      const next = easeToward(cur, target, dt, tauUp, tauDown, snap);
      vals.set(key, next);
      return next;
    },
  };
}

export interface RevealTracker {
  /** Reconcile the CURRENT key set and advance the clock. Call once per
   *  frame with everything that exists right now. */
  frame(ts: number, keys: Iterable<string>): void;
  /** Grow-in phase ∈ [0,1]: 0 = just born, 1 = fully revealed. Keys from
   *  the very first frame are primed at 1; unknown keys are 0. */
  phase(key: string): number;
  /** Recently removed keys with their fade-out phase 1→0 (draw these to
   *  animate deaths); fully faded keys drop off the list. */
  exiting(): Array<{ key: string; phase: number }>;
}

export function createRevealTracker(inSec: number, outSec: number = inSec): RevealTracker {
  const born = new Map<string, number>(); // first-seen ts; -Infinity = primed
  const gone = new Map<string, { at: number; from: number }>(); // removal ts + phase then
  let primed = false;
  let lastTs = 0;

  const phaseOf = (key: string): number => {
    const b = born.get(key);
    if (b === undefined) return 0;
    if (b === -Infinity) return 1;
    return inSec <= 0 ? 1 : Math.max(0, Math.min(1, (lastTs - b) / inSec));
  };

  return {
    frame(ts, keys) {
      lastTs = ts;
      const current = keys instanceof Set ? (keys as Set<string>) : new Set(keys);
      for (const key of current) {
        if (born.has(key)) continue;
        const g = gone.get(key);
        if (g) {
          // Re-born mid-fade: resume growing from the phase still visible —
          // the discrete version of ease-toward retargeting.
          const visible = outSec <= 0 ? 0 : Math.max(0, g.from - (ts - g.at) / outSec);
          born.set(key, ts - visible * inSec);
          gone.delete(key);
        } else {
          born.set(key, primed ? ts : -Infinity);
        }
      }
      for (const key of [...born.keys()]) {
        if (current.has(key)) continue;
        gone.set(key, { at: ts, from: phaseOf(key) });
        born.delete(key);
      }
      for (const [key, g] of [...gone]) {
        if (outSec <= 0 || g.from - (ts - g.at) / outSec <= 0) gone.delete(key);
      }
      primed = true;
    },
    phase: phaseOf,
    exiting() {
      const out: Array<{ key: string; phase: number }> = [];
      for (const [key, g] of gone) {
        const p = outSec <= 0 ? 0 : Math.max(0, g.from - (lastTs - g.at) / outSec);
        if (p > 0) out.push({ key, phase: p });
      }
      return out;
    },
  };
}

/** A gentle ease curve for reveal phases (starts and ends soft). */
export function smooth(p: number): number {
  const t = Math.max(0, Math.min(1, p));
  return t * t * (3 - 2 * t);
}
