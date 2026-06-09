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
import { ECO, SLEEP_EPS } from './config';
import { wrapCoord } from './grid';

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
// Prominence = a cell's height above a DISTANCE-WEIGHTED mean of the heights
// around it: nearby ground counts most and the weight fades smoothly to zero at
// promRadius (a raised-cosine kernel). The smooth edge matters — a uniform box
// with a hard cutoff made a terrain edit pop a sharp "ripple" of rain change in a
// ring at exactly the box radius (cells whose box the moved sand suddenly entered/
// left). With the soft kernel that contribution fades in gradually instead. It is
// the only quantity that couples a cell beyond its 4 neighbours, so it's cached:
// rebuilt in bulk on load / geometry change, recomputed where height changes.

/** Raised-cosine weight kernel for the prominence neighbourhood, cached by radius.
 *  w(0)=1, w(promRadius)=0 with zero slope at the edge, so a cell crossing the
 *  boundary contributes ≈0 (no discrete jump). Indexed [(dy+r)*n + (dx+r)]. */
let kernelR = -1;
let kernelW: Float64Array = new Float64Array(0);
function promKernel(r: number): Float64Array {
  if (kernelR === r) return kernelW;
  const n = 2 * r + 1;
  const k = new Float64Array(n * n);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy) / r;
      k[(dy + r) * n + (dx + r)] = d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d));
    }
  }
  kernelR = r;
  kernelW = k;
  return k;
}

/** Prominence of one cell: height − distance-weighted mean of its neighbourhood.
 *  The kernel wraps on a torus and clamps on a bounded map (the Σweight in the
 *  denominator covers only the in-bounds cells, so edges stay correct). */
function promAt(state: GameState, x: number, y: number): number {
  const { cols, rows, wrap } = state;
  const r = ECO.promRadius;
  const k = promKernel(r);
  const n = 2 * r + 1;
  let ws = 0, wh = 0;
  for (let dy = -r; dy <= r; dy++) {
    let yy = y + dy;
    if (wrap) yy = wrapCoord(yy, rows);
    else if (yy < 0 || yy >= rows) continue;
    const krow = (dy + r) * n;
    const grow = yy * cols;
    for (let dx = -r; dx <= r; dx++) {
      const w = k[krow + dx + r];
      if (w === 0) continue;
      let xx = x + dx;
      if (wrap) xx = wrapCoord(xx, cols);
      else if (xx < 0 || xx >= cols) continue;
      ws += w;
      wh += w * state.cells[grow + xx].height;
    }
  }
  return state.cells[y * cols + x].height - wh / ws;
}

/** Fill the whole prominence cache (on load / geometry change). O(N·r²); runs
 *  rarely. Uses the same `promAt` as the incremental path, so the cache is
 *  bit-identical however it was built. */
export function computeAllProm(state: GameState, sim: Sim): void {
  const { cols, rows } = state;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) sim.prom[y * cols + x] = promAt(state, x, y);
  }
  sim.promDirty.clear();
}

/** Recompute every dirty prominence entry (called once per world step, before
 *  accumulation reads the cache) and WAKE only the cells whose prominence moved
 *  enough to matter. A cell's rain = moistGain × prominence, so a prominence
 *  change below SLEEP_EPS/moistGain shifts rain by < SLEEP_EPS/step — too little to
 *  move the cell's equilibrium, so it's left asleep. This is what keeps a terrain
 *  edit's ripple to the cells whose rainfall genuinely changed, instead of waking
 *  the entire (wide) prominence box around the brush. Cells woken here are
 *  scheduled for the CURRENT step so they're processed immediately. */
export function flushPromDirty(state: GameState, sim: Sim): void {
  if (sim.promDirty.size === 0) return;
  const { cols } = state;
  const wakeEps = SLEEP_EPS / Math.max(0.05, ECO.moistGain);
  for (const i of sim.promDirty) {
    const np = promAt(state, i % cols, (i / cols) | 0);
    if (Math.abs(np - sim.prom[i]) > wakeEps) schedule(sim, i, state.clock);
    sim.prom[i] = np;
  }
  sim.promDirty.clear();
}

/** Mark prominence dirty in the (2r+1)² box around a height-edited cell (the
 *  cells whose box-mean includes it). They're recomputed — and selectively woken
 *  — by `flushPromDirty`. Height is edited only by sculpting and erosion. */
export function dirtyPromBox(state: GameState, sim: Sim, x: number, y: number): void {
  const { cols, rows } = state;
  const r = ECO.promRadius;
  if (state.wrap) {
    for (let dy = -r; dy <= r; dy++) {
      const row = wrapCoord(y + dy, rows) * cols;
      for (let dx = -r; dx <= r; dx++) sim.promDirty.add(row + wrapCoord(x + dx, cols));
    }
    return;
  }
  const x0 = Math.max(0, x - r), x1 = Math.min(cols - 1, x + r);
  const y0 = Math.max(0, y - r), y1 = Math.min(rows - 1, y + r);
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * cols;
    for (let xx = x0; xx <= x1; xx++) sim.promDirty.add(row + xx);
  }
}
