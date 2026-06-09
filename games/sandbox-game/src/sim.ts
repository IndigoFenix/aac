// Sandbox Game — discrete-event scheduler + derived caches (the "Sim").
//
// The ecology engine (engine.ts) no longer sweeps the whole grid every step.
// Instead each cell is woken only when it (or a neighbour, or the player) might
// change it, processed, and then either RE-scheduled for a future step (still
// settling) or left to SLEEP (at rest). A settled world has an empty schedule and
// costs nothing; catch-up over a long absence jumps across the empty stretches.
//
// The Sim holds the live schedule + derived caches. It is transient (a WeakMap
// keyed by GameState, never part of the React tree) but its SCHEDULE is the one
// piece of genuine state that engine.ts serializes alongside the grid: a cell's
// field values don't encode its in-flight timers, so the pending tasks must
// survive a save/reload or the world would not evolve identically on return.
//
// Termination safety baked in here:
//   • every schedule() target is a STRICTLY FUTURE step (≥ clock+1) — the clock
//     advances monotonically, so the scheduler itself can never livelock; and
//   • each (cell) appears at most once per step (deduped via `due`), so a step's
//     work is bounded by the active-cell count.

import type { GameState } from './types';
import { ECO } from './config';

export interface Sim {
  /** fireStep → set of cell indices due then. Lazy-cancelled (see `due`). */
  buckets: Map<number, Set<number>>;
  /** cell → soonest step it's scheduled for, or -1 if not scheduled. Dedupes
   *  and lets a bucket entry be recognised as stale (superseded by an earlier
   *  reschedule) when it is drained. */
  due: Int32Array;
  /** Cached prominence (height − local box-mean) per cell. Pure function of the
   *  height field; recomputed where height changes, never serialized. */
  prom: Float64Array;
  /** Cells whose cached prominence is stale (a nearby height edit). Recomputed
   *  at the top of the next world step. */
  promDirty: Set<number>;
}

const sims = new WeakMap<GameState, Sim>();

/** Get (or lazily build) the Sim for a state. A freshly built Sim has the
 *  prominence cache filled but an EMPTY schedule — a flat desert is already at
 *  rest, and a loaded save re-seeds its schedule via `seedSchedule`. */
export function getSim(state: GameState): Sim {
  let s = sims.get(state);
  if (!s) { s = buildSim(state); sims.set(state, s); }
  return s;
}

export function hasSim(state: GameState): boolean {
  return sims.has(state);
}

function buildSim(state: GameState): Sim {
  const n = state.cells.length;
  const due = new Int32Array(n);
  due.fill(-1);
  const sim: Sim = {
    buckets: new Map(),
    due,
    prom: new Float64Array(n),
    promDirty: new Set(),
  };
  computeAllProm(state, sim);
  return sim;
}

// --- Scheduling ---------------------------------------------------------------

/** Schedule `cell` to be processed at `step` (must be > current clock). A cell
 *  already pending at an equal-or-earlier step is left as-is; a later pending
 *  entry is superseded (the stale bucket entry is skipped on drain). */
export function schedule(sim: Sim, cell: number, step: number): void {
  const cur = sim.due[cell];
  if (cur >= 0 && cur <= step) return; // already pending sooner or at the same step
  sim.due[cell] = step;
  let b = sim.buckets.get(step);
  if (!b) { b = new Set(); sim.buckets.set(step, b); }
  b.add(cell);
}

/** Remove and return the cells genuinely due at `step` (skips stale entries that
 *  were superseded by an earlier reschedule). Drained cells are marked not-due,
 *  so a handler must re-`schedule` them to keep them awake. */
export function drainDue(sim: Sim, step: number): number[] {
  const b = sim.buckets.get(step);
  if (!b) return [];
  sim.buckets.delete(step);
  const out: number[] = [];
  for (const c of b) {
    if (sim.due[c] === step) { sim.due[c] = -1; out.push(c); }
  }
  return out;
}

/** Smallest scheduled step strictly after `after` and at most `cap`, or -1 if
 *  none — lets catch-up jump straight over settled (empty) stretches. */
export function nextBucketStep(sim: Sim, after: number, cap: number): number {
  if (sim.buckets.size === 0) return -1;
  let best = -1;
  for (const k of sim.buckets.keys()) {
    if (k > after && k <= cap && (best < 0 || k < best)) best = k;
  }
  return best;
}

/** Total pending tasks — for the quiescence tests ("a settled world has none"). */
export function pendingCount(sim: Sim): number {
  let n = 0;
  for (const b of sim.buckets.values()) n += b.size;
  return n;
}

// --- Serialization of the schedule -------------------------------------------
// Flattened to a plain [step, cell, step, cell, …] array so it rides along in the
// JSON save. Rebuilt into buckets (and the `due` dedupe index) on load.

export function serializeSchedule(sim: Sim): number[] {
  const out: number[] = [];
  for (const [step, cells] of sim.buckets) {
    for (const c of cells) { out.push(step, c); }
  }
  return out;
}

/** Re-seed a freshly built Sim's schedule from a flattened array (load path).
 *  Steps ≤ `clock` are clamped to `clock+1` so a save can never carry a task
 *  scheduled in the past (which would violate strict-future advancement). */
export function seedSchedule(sim: Sim, flat: number[] | undefined, clock: number): void {
  if (!flat) return;
  for (let k = 0; k + 1 < flat.length; k += 2) {
    const step = Math.max(clock + 1, flat[k]);
    schedule(sim, flat[k + 1], step);
  }
}

// --- Prominence cache ---------------------------------------------------------
// Prominence = a cell's height above the mean height of its (2r+1)² box. It is
// the only quantity in the sim that couples a cell to ground BEYOND its 4
// neighbours, so it gets its own cache: recomputed in bulk on load (SAT) and
// incrementally where height changes (direct box-sum), never every step.

/** Fill the whole prominence cache via a summed-area table — O(N), used on build
 *  and load. Matches the per-cell box formula in `recomputeProm` exactly. */
export function computeAllProm(state: GameState, sim: Sim): void {
  const { cols, rows } = state;
  const r = ECO.promRadius;
  const W = cols + 1;
  const sat = new Float64Array(W * (rows + 1));
  for (let y = 0; y < rows; y++) {
    let rowSum = 0;
    for (let x = 0; x < cols; x++) {
      rowSum += state.cells[y * cols + x].height;
      sat[(y + 1) * W + (x + 1)] = sat[y * W + (x + 1)] + rowSum;
    }
  }
  for (let y = 0; y < rows; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(rows - 1, y + r);
    for (let x = 0; x < cols; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(cols - 1, x + r);
      const sum = sat[(y1 + 1) * W + (x1 + 1)] - sat[y0 * W + (x1 + 1)]
        - sat[(y1 + 1) * W + x0] + sat[y0 * W + x0];
      const mean = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      sim.prom[y * cols + x] = state.cells[y * cols + x].height - mean;
    }
  }
  sim.promDirty.clear();
}

/** Recompute prominence for one cell directly from its height box (O(r²)). */
function promAt(state: GameState, x: number, y: number): number {
  const { cols, rows } = state;
  const r = ECO.promRadius;
  const x0 = Math.max(0, x - r), x1 = Math.min(cols - 1, x + r);
  const y0 = Math.max(0, y - r), y1 = Math.min(rows - 1, y + r);
  let sum = 0;
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * cols;
    for (let xx = x0; xx <= x1; xx++) sum += state.cells[row + xx].height;
  }
  const mean = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
  return state.cells[y * cols + x].height - mean;
}

/** Recompute and clear every dirty prominence entry. Called once per world step,
 *  before accumulation reads the cache. */
export function flushPromDirty(state: GameState, sim: Sim): void {
  if (sim.promDirty.size === 0) return;
  const { cols } = state;
  for (const i of sim.promDirty) {
    sim.prom[i] = promAt(state, i % cols, (i / cols) | 0);
  }
  sim.promDirty.clear();
}

/** Mark prominence dirty in the (2r+1)² box around a height-edited cell, and
 *  return those box cells so the caller can also WAKE them (their accumulation
 *  input just changed). Height is edited only by sculpting and erosion. */
export function dirtyPromBox(state: GameState, sim: Sim, x: number, y: number, out: number[]): void {
  const { cols, rows } = state;
  const r = ECO.promRadius;
  const x0 = Math.max(0, x - r), x1 = Math.min(cols - 1, x + r);
  const y0 = Math.max(0, y - r), y1 = Math.min(rows - 1, y + r);
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * cols;
    for (let xx = x0; xx <= x1; xx++) {
      const i = row + xx;
      sim.promDirty.add(i);
      out.push(i);
    }
  }
}
