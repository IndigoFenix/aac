// Cell Systems — grid engine (Step 2: spread & flow across tiles).
//
// Runs ONE validated SystemSpec across every tile of a cols×rows grid. Each tile
// has its own scalars / stages / timers; CLOCKS are GLOBAL (one autonomous phase
// shared by the whole map, e.g. day/night). The per-tile rule semantics are the
// SAME as the flask (shared via eval.ts), so a 1×1 grid == a single cell.
//
// What's new in Step 2 is NEIGHBOUR COUPLING, restricted to two CONSERVATIVE,
// MONOTONE transport primitives (`spread`, `flowDown`). Both move material down a
// gradient by a no-overshoot fraction (rate clamped to 1/(neighbours+1)), so each
// has a Lyapunov function (field roughness strictly decreases) and conserves the
// total — which is exactly what keeps the coupled grid fast-forwardable. Free-form
// "read neighbour X → write my Y" is deliberately NOT expressible (that would be a
// cellular automaton, i.e. possibly chaotic). This mirrors the terrain engine's
// active-set scheduler: only changing tiles do work; a settled grid costs nothing
// and catch-up jumps across the idle stretches.

import type { SystemSpec, VarSpec, StageSpec, ClockSpec, SensorSpec } from './spec';
import {
  type CellView, evalCond, ownEffectDelta, SLEEP_EPS,
  clockBoundaries, nextClockBoundaryStep,
} from './eval';

export const MAX_GRID_CATCHUP = 200_000;

export interface CellGrid {
  spec: SystemSpec;
  cols: number;
  rows: number;
  /** Toroidal geometry: edges wrap to the opposite side (no off-grid). The single
   *  topology knob — neighbours(), the sensor box and the source-wake box all
   *  respect it. (A different lattice, e.g. hex, would be another such option.) */
  wrap: boolean;
  /** var name → per-tile values (row-major). */
  fields: Record<string, Float64Array>;
  /** state name → per-tile stage index into that state's `stages`. */
  stageIdx: Record<string, Uint8Array>;
  /** Global clock phases (steps), [0, period). */
  clockPhase: Record<string, number>;
  clock: number;
  // --- scheduler ---
  buckets: Map<number, Set<number>>;
  /** tile → soonest scheduled step, or -1. Dedupe + stale-entry detection. */
  due: Int32Array;
  /** per rule index → (tile → absolute fire step) for armed timers. */
  armed: Array<Map<number, number>>;
  /** per rule index → per-tile last guard value (for rising-edge arming). */
  lastGuard: Uint8Array[];
  /** A flow var's potential changed → flow fields need recomputing next step. */
  flowDirty: boolean;
}

// --- Compiled lookups ---------------------------------------------------------

interface TransportEffect {
  kind: 'spread' | 'flowDown' | 'erode';
  scalar: string;
  potential?: string;
  rate: number;
  block?: string;
  drainEdge?: number;
  int?: boolean; // whole-unit transport for integer-level vars
  // erode only:
  by?: string;
  minFlow?: number;
  minSlope?: number;
  max?: number;
}
interface RuleMeta {
  external: boolean;
  isTimer: boolean;
  timer: number;
  /** transport effects (grid-only) pulled out of this rule's effect list. */
  transports: TransportEffect[];
}
interface GridCompiled {
  vars: Map<string, VarSpec>;
  stages: Map<string, StageSpec>;
  clocks: Map<string, ClockSpec>;
  clockBoundaries: Map<string, number[]>;
  rules: RuleMeta[];
  sensors: SensorSpec[];
  /** Vars that feed a sensor — when one changes, cells within the sensor radius
   *  must re-wake (the wide, prominence-style coupling). */
  sourceVars: Set<string>;
  maxSensorRadius: number;
  /** Integer-level vars (committed as whole numbers; whole-unit transport). */
  intVars: Set<string>;
  /** Computed flow-accumulation vars (rivers) — engine-filled, never rule-written. */
  flowVars: { name: string; potential: string; source: number; block?: string; int: boolean }[];
  /** Potential vars that, when changed, require flow recomputation. */
  flowPotentials: Set<string>;
}

const cache = new WeakMap<SystemSpec, GridCompiled>();

function compile(spec: SystemSpec): GridCompiled {
  const hit = cache.get(spec);
  if (hit) return hit;
  const vars = new Map((spec.vars ?? []).map(v => [v.name, v]));
  const intVars = new Set((spec.vars ?? []).filter(v => v.int).map(v => v.name));
  const stages = new Map((spec.states ?? []).map(s => [s.name, s]));
  const clocks = new Map((spec.clocks ?? []).map(c => [c.name, c]));
  const rules: RuleMeta[] = spec.rules.map(r => {
    const transports: TransportEffect[] = [];
    for (const e of r.effects) {
      if ('spread' in e) transports.push({ kind: 'spread', scalar: e.spread.scalar, rate: e.spread.rate, int: intVars.has(e.spread.scalar) });
      else if ('flowDown' in e) transports.push({ kind: 'flowDown', scalar: e.flowDown.scalar, potential: e.flowDown.potential, rate: e.flowDown.rate, block: e.flowDown.block, drainEdge: e.flowDown.drainEdge, int: intVars.has(e.flowDown.scalar) });
      else if ('erode' in e) transports.push({ kind: 'erode', scalar: e.erode.scalar, by: e.erode.by, rate: e.erode.rate, minFlow: e.erode.minFlow, minSlope: e.erode.minSlope, max: e.erode.max, block: e.erode.block });
    }
    return {
      external: !!r.external,
      isTimer: 'timer' in r.trigger,
      timer: 'timer' in r.trigger ? Math.max(1, Math.round(r.trigger.timer)) : 0,
      transports,
    };
  });
  const sensors = spec.sensors ?? [];
  const sourceVars = new Set(sensors.map(s => s.of));
  const maxSensorRadius = sensors.reduce((m, s) => Math.max(m, s.radius), 0);
  const flowVars = (spec.vars ?? []).filter(v => v.flow).map(v => ({
    name: v.name, potential: v.flow!.potential, source: v.flow!.source ?? 1, block: v.flow!.block, int: !!v.int,
  }));
  const flowPotentials = new Set(flowVars.map(f => f.potential));
  const c: GridCompiled = {
    vars, stages, clocks, clockBoundaries: clockBoundaries(spec), rules,
    sensors, sourceVars, maxSensorRadius, intVars, flowVars, flowPotentials,
  };
  cache.set(spec, c);
  return c;
}

// --- Instantiation ------------------------------------------------------------

/** Deterministic per-tile pseudo-random in [0,1) — so 'noise' seeding is stable
 *  across runs (needed for reproducible tests). */
function hashFrac(i: number): number {
  const s = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function seedField(v: VarSpec, cols: number, rows: number): Float64Array {
  const n = cols * rows;
  const arr = new Float64Array(n);
  const span = v.max - v.min;
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  // A fixed-size hill (sigma in TILES) so prominence is the same on any grid size.
  const sigma = Math.max(3, Math.min(cols, rows) / 6);
  for (let i = 0; i < n; i++) {
    const x = i % cols, y = (i / cols) | 0;
    const dist = Math.hypot(x - cx, y - cy);
    const r = dist / maxR;
    let val: number;
    switch (v.init) {
      case 'bowl':       val = v.min + span * (0.15 + 0.6 * r); break;          // basin: low centre, high rim
      // A hill rising from the var's `initial` BASELINE to its max — so the land
      // sits above any sea level (drainEdge) and water pools on it / drains at edges.
      case 'centerBlob': val = v.initial + (v.max - v.initial) * Math.exp(-(dist * dist) / (2 * sigma * sigma)); break;
      case 'noise':      val = v.min + span * hashFrac(i); break;
      default:           val = v.initial;                                       // 'flat'
    }
    if (v.int) val = Math.round(val);
    arr[i] = Math.max(v.min, Math.min(v.max, val));
  }
  return arr;
}

export function createGrid(spec: SystemSpec, cols: number, rows: number, wrap = false): CellGrid {
  const n = cols * rows;
  const fields: Record<string, Float64Array> = {};
  for (const v of spec.vars ?? []) fields[v.name] = seedField(v, cols, rows);
  const stageIdx: Record<string, Uint8Array> = {};
  for (const s of spec.states ?? []) stageIdx[s.name] = new Uint8Array(n).fill(Math.max(0, s.stages.indexOf(s.initial)));
  const clockPhase: Record<string, number> = {};
  for (const c of spec.clocks ?? []) clockPhase[c.name] = ((c.phase ?? 0) % c.period + c.period) % c.period;

  const due = new Int32Array(n).fill(-1);
  const grid: CellGrid = {
    spec, cols, rows, wrap, fields, stageIdx, clockPhase, clock: 0,
    buckets: new Map(), due,
    armed: spec.rules.map(() => new Map()),
    lastGuard: spec.rules.map(() => new Uint8Array(n)),
    flowDirty: false,
  };
  recomputeFlows(grid, compile(spec)); // initial river network from the seeded terrain
  // A non-flat seed (or any non-trivial initial) means the grid isn't at rest —
  // wake everything so the scheduler settles it. (A flat grid with no dynamics
  // would just sleep immediately, which is correct.)
  wakeAll(grid, 1);
  return grid;
}

// --- Neighbours & scheduler ---------------------------------------------------

/** Cardinal neighbours of tile `i` into `out`; returns the count. On a torus it's
 *  always 4 (edges wrap); bounded maps drop off-grid sides. This is the ONE place
 *  the grid's topology lives — swapping in another lattice (e.g. hex) is a change
 *  here plus the matching no-overshoot degree used by transport. */
function neighbours(grid: CellGrid, i: number, out: number[]): number {
  const { cols, rows, wrap } = grid;
  const x = i % cols, y = (i / cols) | 0;
  if (wrap) {
    out[0] = y * cols + (x === 0 ? cols - 1 : x - 1);
    out[1] = y * cols + (x === cols - 1 ? 0 : x + 1);
    out[2] = (y === 0 ? rows - 1 : y - 1) * cols + x;
    out[3] = (y === rows - 1 ? 0 : y + 1) * cols + x;
    return 4;
  }
  let k = 0;
  if (x > 0) out[k++] = i - 1;
  if (x < cols - 1) out[k++] = i + 1;
  if (y > 0) out[k++] = i - cols;
  if (y < rows - 1) out[k++] = i + cols;
  return k;
}

/** Flip bounded ↔ toroidal on a live grid: re-wake everything to re-settle under
 *  the new topology (sensor neighbourhoods and flow edges all change). */
export function setGridWrap(grid: CellGrid, wrap: boolean): void {
  if (grid.wrap === wrap) return;
  grid.wrap = wrap;
  wakeAll(grid, grid.clock + 1);
}

function schedule(grid: CellGrid, cell: number, step: number): void {
  const cur = grid.due[cell];
  if (cur >= 0 && cur <= step) return;
  grid.due[cell] = step;
  let b = grid.buckets.get(step);
  if (!b) { b = new Set(); grid.buckets.set(step, b); }
  b.add(cell);
}

function drainDue(grid: CellGrid, step: number): number[] {
  const b = grid.buckets.get(step);
  if (!b) return [];
  grid.buckets.delete(step);
  const out: number[] = [];
  for (const c of b) if (grid.due[c] === step) { grid.due[c] = -1; out.push(c); }
  return out;
}

function nextBucketStep(grid: CellGrid, after: number, cap: number): number {
  let best = -1;
  for (const k of grid.buckets.keys()) if (k > after && k <= cap && (best < 0 || k < best)) best = k;
  return best;
}

export function pendingCount(grid: CellGrid): number {
  let n = 0;
  for (const b of grid.buckets.values()) n += b.size;
  return n;
}

export function wakeAll(grid: CellGrid, step: number): void {
  for (let i = 0; i < grid.cols * grid.rows; i++) schedule(grid, i, step);
}

// --- Flow accumulation (static river networks) --------------------------------

/** Fill a flow-accumulation field: each tile = its `source` + everything draining
 *  into it from upslope. Process tiles high→low so every upstream tile pushes its
 *  accumulated catchment to its steepest-descent neighbour before that neighbour
 *  is processed. Sinks (no lower neighbour) keep their catchment → lakes. O(N log N),
 *  recomputed only when the terrain changes. Stone carries no flow. */
function computeFlow(grid: CellGrid, fv: GridCompiled['flowVars'][number]): Float64Array {
  const n = grid.cols * grid.rows;
  const pot = grid.fields[fv.potential];
  const blk = fv.block ? grid.fields[fv.block] : null;
  const flow = new Float64Array(n);
  for (let i = 0; i < n; i++) flow[i] = (blk && blk[i] > 0.5) ? 0 : fv.source;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pot[b] - pot[a]);
  const nb: number[] = [0, 0, 0, 0];
  for (const c of order) {
    if (blk && blk[c] > 0.5) { flow[c] = 0; continue; }
    const k = neighbours(grid, c, nb);
    let low = -1, lowP = pot[c];
    for (let j = 0; j < k; j++) { const ni = nb[j]; if (blk && blk[ni] > 0.5) continue; if (pot[ni] < lowP) { lowP = pot[ni]; low = ni; } }
    if (low >= 0) flow[low] += flow[c]; // route catchment downstream; else a sink (lake)
  }
  if (fv.int) for (let i = 0; i < n; i++) flow[i] = Math.round(flow[i]);
  return flow;
}

/** Recompute every flow var and wake the tiles whose flow changed (so rules that
 *  read it — e.g. greenery along rivers — re-evaluate). */
function recomputeFlows(grid: CellGrid, comp: GridCompiled): void {
  for (const fv of comp.flowVars) {
    const out = computeFlow(grid, fv);
    const cur = grid.fields[fv.name];
    if (cur) for (let i = 0; i < out.length; i++) if (cur[i] !== out[i]) schedule(grid, i, grid.clock + 1);
    grid.fields[fv.name] = out;
  }
  grid.flowDirty = false;
}

// --- Sensors (derived neighbourhood fields) -----------------------------------

/** Aggregate a var over the (2r+1)² neighbourhood of tile `i`. Reads PRE-step
 *  field values (the buffer hasn't been committed), so a sensor is a pure
 *  function of the current state. */
function computeSensor(grid: CellGrid, ofArr: Float64Array, i: number, s: SensorSpec): number {
  const { cols, rows, wrap } = grid;
  const cx = i % cols, cy = (i / cols) | 0;
  const r = s.radius;
  const cosine = s.weight === 'cosine';
  let wsum = 0, wtot = 0, mx = -Infinity, mn = Infinity, sum = 0;
  for (let dy = -r; dy <= r; dy++) {
    let yy = cy + dy; if (wrap) yy = ((yy % rows) + rows) % rows; else if (yy < 0 || yy >= rows) continue;
    for (let dx = -r; dx <= r; dx++) {
      let xx = cx + dx; if (wrap) xx = ((xx % cols) + cols) % cols; else if (xx < 0 || xx >= cols) continue;
      const v = ofArr[yy * cols + xx];
      let w = 1;
      if (cosine) { const d = Math.hypot(dx, dy) / (r || 1); w = d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d)); if (w === 0) continue; }
      wsum += w * v; wtot += w; sum += v;
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
  }
  let out: number;
  switch (s.op) {
    case 'mean': out = wtot ? wsum / wtot : 0; break;
    case 'prominence': out = ofArr[i] - (wtot ? wsum / wtot : 0); break;
    case 'max': out = mx === -Infinity ? 0 : mx; break;
    case 'min': out = mn === Infinity ? 0 : mn; break;
    case 'sum': out = sum; break;
  }
  if (s.cap !== undefined) out = Math.max(-s.cap, Math.min(s.cap, out));
  return out;
}

/** Precompute each sensor's value for a set of tiles (the active set), so rule
 *  evaluation is a flat lookup. */
function computeSensors(grid: CellGrid, comp: GridCompiled, cells: number[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const s of comp.sensors) {
    const ofArr = grid.fields[s.of];
    if (!ofArr) continue;
    const m = new Map<number, number>();
    for (const c of cells) m.set(c, computeSensor(grid, ofArr, c, s));
    out.set(s.name, m);
  }
  return out;
}

// --- View over one tile -------------------------------------------------------

function makeView(grid: CellGrid, comp: GridCompiled, sensorVal: Map<string, Map<number, number>>): CellView & { i: number } {
  return {
    i: 0,
    scalar(name) { return grid.fields[name] ? grid.fields[name][this.i] : 0; },
    clockNorm(name) { return (grid.clockPhase[name] ?? 0) / (comp.clocks.get(name)?.period ?? 1); },
    sensor(name) { return sensorVal.get(name)?.get(this.i) ?? 0; },
    stage(name) { const s = comp.stages.get(name); return s ? s.stages[grid.stageIdx[name][this.i]] : ''; },
    stageRank(state, value) { return comp.stages.get(state)?.stages.indexOf(value) ?? -1; },
  };
}

// --- World step ---------------------------------------------------------------

/** True if a global clock sits on one of its boundary positions this step (so
 *  every tile's clock-guards may flip → the whole grid must wake). */
function onClockBoundary(grid: CellGrid, comp: GridCompiled): boolean {
  for (const [clk, positions] of comp.clockBoundaries) {
    if (positions.includes(grid.clockPhase[clk])) return true;
  }
  return false;
}

export function worldStep(grid: CellGrid): void {
  const comp = compile(grid.spec);
  if (grid.flowDirty && comp.flowVars.length) recomputeFlows(grid, comp); // refresh river networks after a terrain edit
  const T = grid.clock + 1;
  advanceClocksTo(grid, T);
  if (onClockBoundary(grid, comp)) wakeAll(grid, T); // a global clock crossing wakes all tiles
  const active = drainDue(grid, T);
  if (active.length) processActive(grid, comp, active, T);
}

function advanceClocksTo(grid: CellGrid, target: number): void {
  const d = target - grid.clock;
  if (d === 0) return;
  for (const c of grid.spec.clocks ?? []) grid.clockPhase[c.name] = (grid.clockPhase[c.name] + d) % c.period;
  grid.clock = target;
}

function addDelta(buf: Map<string, Map<number, number>>, field: string, cell: number, dv: number): void {
  let m = buf.get(field);
  if (!m) { m = new Map(); buf.set(field, m); }
  m.set(cell, (m.get(cell) ?? 0) + dv);
}

function processActive(grid: CellGrid, comp: GridCompiled, active: number[], T: number): void {
  const { spec } = grid;
  // Derived sensors (prominence etc.) for the active tiles — pure functions of
  // the PRE-step field, read by the rules below as flat lookups.
  const sensorVal = computeSensors(grid, comp, active);
  const view = makeView(grid, comp, sensorVal);
  const nb: number[] = [0, 0, 0, 0];

  // Watch set = active ∪ their neighbours (transport writes neighbours). Snapshot
  // it to detect genuine change after the step.
  const watch = new Set<number>(active);
  for (const c of active) { const k = neighbours(grid, c, nb); for (let j = 0; j < k; j++) watch.add(nb[j]); }
  const vars = [...comp.vars.keys()];
  const states = [...comp.stages.keys()];
  const snap = new Map<number, number[]>();
  for (const c of watch) {
    const row: number[] = [];
    for (const v of vars) row.push(grid.fields[v][c]);
    for (const s of states) row.push(grid.stageIdx[s][c]);
    snap.set(c, row);
  }

  const fieldDelta = new Map<string, Map<number, number>>();
  const stageSets: { cell: number; state: string; to: number }[] = [];

  // 1. Per-tile rules: own effects + timer arming + transport.
  for (const c of active) {
    view.i = c;
    spec.rules.forEach((r, k) => {
      const m = comp.rules[k];
      if (m.external) return;
      const g = evalCond(view, r.when);
      if (m.isTimer) {
        if (g && !grid.lastGuard[k][c] && !grid.armed[k].has(c)) {
          const fireAt = T + m.timer;
          grid.armed[k].set(c, fireAt);
          schedule(grid, c, fireAt); // wake the tile when its timer is due
        } else if (!g) {
          grid.armed[k].delete(c);
        }
        grid.lastGuard[k][c] = g ? 1 : 0;
        return;
      }
      grid.lastGuard[k][c] = g ? 1 : 0;
      if (!g) return;
      for (const e of r.effects) {
        const d = ownEffectDelta(view, e);
        if (d) {
          if (d.kind === 'scalar') addDelta(fieldDelta, d.scalar, c, d.delta);
          else { const st = comp.stages.get(d.state); if (st) stageSets.push({ cell: c, state: d.state, to: st.stages.indexOf(d.to) }); }
        }
      }
      for (const t of m.transports) doTransport(grid, t, c, fieldDelta, nb);
    });
  }

  // 2. Fire due timers for active tiles (re-validating the guard).
  for (const c of active) {
    view.i = c;
    spec.rules.forEach((r, k) => {
      if (!comp.rules[k].isTimer) return;
      const fireAt = grid.armed[k].get(c);
      if (fireAt === undefined || fireAt > T) return;
      grid.armed[k].delete(c);
      if (!evalCond(view, r.when)) return; // a neighbour may have invalidated it
      for (const e of r.effects) {
        const d = ownEffectDelta(view, e);
        if (!d) continue;
        if (d.kind === 'scalar') addDelta(fieldDelta, d.scalar, c, d.delta);
        else { const st = comp.stages.get(d.state); if (st) stageSets.push({ cell: c, state: d.state, to: st.stages.indexOf(d.to) }); }
      }
    });
  }

  // 3. Commit (clamp to [min,max]; stage moves are forward-only).
  for (const [field, m] of fieldDelta) {
    const v = comp.vars.get(field); if (!v) continue;
    const arr = grid.fields[field];
    const round = v.int;
    for (const [cell, dv] of m) {
      let next = arr[cell] + dv;
      if (round) next = Math.round(next);
      arr[cell] = Math.max(v.min, Math.min(v.max, next));
    }
    if (comp.flowPotentials.has(field)) grid.flowDirty = true; // e.g. erosion moved height → rivers re-route
  }
  for (const { cell, state, to } of stageSets) {
    if (to > grid.stageIdx[state][cell]) grid.stageIdx[state][cell] = to;
  }

  // 4. Change detection + reschedule. A tile is "changed" if a field moved beyond
  //    SLEEP_EPS or a stage advanced. Keep the active batch synchronised, and wake
  //    every changed tile AND its neighbours — so the other side of a bidirectional
  //    transport (a higher neighbour that must give back) is processed next step.
  const changed: number[] = [];
  const sourceMoved: number[] = []; // tiles where a sensor SOURCE var moved
  for (const c of watch) {
    const row = snap.get(c)!;
    let moved = false, srcMoved = false;
    for (let vi = 0; vi < vars.length; vi++) {
      if (Math.abs(grid.fields[vars[vi]][c] - row[vi]) > SLEEP_EPS) {
        moved = true;
        if (comp.sourceVars.has(vars[vi])) srcMoved = true;
      }
    }
    if (!moved) for (let si = 0; si < states.length; si++) if (grid.stageIdx[states[si]][c] !== row[vars.length + si]) { moved = true; break; }
    if (moved) changed.push(c);
    if (srcMoved) sourceMoved.push(c);
  }
  if (changed.length) {
    for (const c of active) schedule(grid, c, T + 1);   // keep the conducting batch alive
    for (const c of changed) {
      schedule(grid, c, T + 1);
      const k = neighbours(grid, c, nb);
      for (let j = 0; j < k; j++) schedule(grid, nb[j], T + 1); // wake the reverse-transport side
    }
  }
  // A sensor source changed ⇒ every tile whose sensor reads it within `radius`
  // now has a stale sensor and must re-evaluate (the wide, prominence-style wake).
  if (sourceMoved.length && comp.maxSensorRadius > 0) {
    const r = comp.maxSensorRadius;
    const { cols, rows, wrap } = grid;
    for (const c of sourceMoved) {
      const cx = c % cols, cy = (c / cols) | 0;
      for (let dy = -r; dy <= r; dy++) {
        let yy = cy + dy; if (wrap) yy = ((yy % rows) + rows) % rows; else if (yy < 0 || yy >= rows) continue;
        for (let dx = -r; dx <= r; dx++) {
          let xx = cx + dx; if (wrap) xx = ((xx % cols) + cols) % cols; else if (xx < 0 || xx >= cols) continue;
          schedule(grid, yy * cols + xx, T + 1);
        }
      }
    }
  }
}

/** One tile's conservative transport for a single effect. Reads PRE-step field
 *  values (deltas are buffered) so it's order-independent and exactly symmetric
 *  between neighbours. Snaps the whole exchange to nothing below SLEEP_EPS, which
 *  preserves conservation AND lets the tile reach exact rest and sleep. */
function doTransport(
  grid: CellGrid, t: TransportEffect, c: number,
  buf: Map<string, Map<number, number>>, nbScratch: number[],
): void {
  const arr = grid.fields[t.scalar];
  if (!arr) return;
  const k = neighbours(grid, c, nbScratch);
  const rate = Math.min(t.rate, 1 / (k + 1)); // no-overshoot bound → monotone, can't oscillate
  const val = arr[c];

  if (t.kind === 'erode') {
    // Flowing `by` (water) carries `scalar` (substrate) to the steepest-descent
    // downstream neighbour by SURFACE = scalar + by. Capped at half the drop so it
    // can't invert the slope (sand only moves downhill ⇒ settles). Conservative.
    const byArr = grid.fields[t.by!];
    if (!byArr) return;
    const blk = t.block ? grid.fields[t.block] : null;
    if (blk && blk[c] > 0.5) return;
    const w = byArr[c];
    const minFlow = t.minFlow ?? 0;
    if (w <= minFlow) return;
    const surfC = val + w;
    let down = -1, lowest = surfC;
    for (let j = 0; j < k; j++) {
      const nIdx = nbScratch[j];
      if (blk && blk[nIdx] > 0.5) continue;
      const s = arr[nIdx] + byArr[nIdx];
      if (s < lowest) { lowest = s; down = nIdx; }
    }
    if (down < 0) return;
    const drop = surfC - lowest;
    if (drop <= (t.minSlope ?? 0)) return;
    let amount = t.rate * (w - minFlow);
    if (t.max !== undefined) amount = Math.min(amount, t.max);
    amount = Math.min(amount, val, drop / 2); // ≤ available, ≤ half-drop (no inversion)
    if (amount < SLEEP_EPS) return;
    addDelta(buf, t.scalar, c, -amount);
    addDelta(buf, t.scalar, down, amount);
    return;
  }

  // --- Integer-level transport: move WHOLE UNITS to the steepest-descent target,
  // floor(gap/2) at a time (so the gap can't invert), stopping exactly when no
  // gap ≥ 2 remains. Conservative; reaches crisp rest with no ε-tail.
  if (t.int) {
    const blkI = t.block ? grid.fields[t.block] : null;
    if (blkI && blkI[c] > 0.5) return;
    const usePot = t.kind === 'flowDown';
    const pot = usePot && t.potential ? grid.fields[t.potential] : null;
    const surf = (idx: number) => (pot ? pot[idx] : 0) + arr[idx];
    const mySurf = surf(c);
    let low = -1, lowSurf = mySurf;
    for (let j = 0; j < k; j++) {
      const nIdx = nbScratch[j];
      if (blkI && blkI[nIdx] > 0.5) continue;
      const s = surf(nIdx);
      if (s < lowSurf) { lowSurf = s; low = nIdx; }
    }
    // Open boundary (flowDown only): the edge is a target at the sea level.
    let edgeTarget = false;
    if (usePot && t.drainEdge !== undefined && !grid.wrap && k < 4 && t.drainEdge < lowSurf) { lowSurf = t.drainEdge; edgeTarget = true; low = -1; }
    if (!edgeTarget && low < 0) return;
    const gap = mySurf - lowSurf;
    if (gap < 2) return;
    const m = Math.min(arr[c], Math.floor(gap / 2)); // ≤ available, ≤ half-gap (no inversion)
    if (m <= 0) return;
    addDelta(buf, t.scalar, c, -m);
    if (!edgeTarget) addDelta(buf, t.scalar, low, m); // else off-map (drained)
    return;
  }

  if (t.kind === 'spread') {
    // Equalising diffusion: give a clamped share of each positive surplus.
    let total = 0;
    const targets: number[] = [], offers: number[] = [];
    for (let j = 0; j < k; j++) {
      const nIdx = nbScratch[j];
      const diff = val - arr[nIdx];
      if (diff > 0) { const o = rate * diff; targets.push(nIdx); offers.push(o); total += o; }
    }
    if (total < SLEEP_EPS) return;
    addDelta(buf, t.scalar, c, -total);
    for (let j = 0; j < targets.length; j++) addDelta(buf, t.scalar, targets[j], offers[j]);
    return;
  }

  // flowDown: move the scalar to neighbours with a lower SURFACE (potential+scalar),
  // capped by the movable amount (can't send more than you have). Pools in minima.
  // A `block` var marks walls (solid stone): a wall sends nothing and receives nothing.
  const blk = t.block ? grid.fields[t.block] : null;
  if (blk && blk[c] > 0.5) return;
  const pot = t.potential ? grid.fields[t.potential] : null;
  const surface = (pot ? pot[c] : 0) + val;
  let total = 0;
  const targets: number[] = [], offers: number[] = []; // target -1 = off-map drain (the sea)
  for (let j = 0; j < k; j++) {
    const nIdx = nbScratch[j];
    if (blk && blk[nIdx] > 0.5) continue; // don't flow into a wall
    const nSurface = (pot ? pot[nIdx] : 0) + arr[nIdx];
    const drop = surface - nSurface;
    if (drop > 0) { const o = rate * drop; targets.push(nIdx); offers.push(o); total += o; }
  }
  // Open boundary: a bounded-grid edge tile sheds flow off-map above the sea level,
  // so inflow has an OUTLET and can't pile up and flood. (k<4 ⇒ on the edge.)
  if (t.drainEdge !== undefined && !grid.wrap) {
    const edgeDrop = surface - t.drainEdge;
    for (let s = 0; s < 4 - k; s++) if (edgeDrop > 0) { const o = rate * edgeDrop; targets.push(-1); offers.push(o); total += o; }
  }
  if (total < SLEEP_EPS) return;
  const scale = total > val ? val / total : 1; // never send more than is here
  const sent = total * scale;
  if (sent < SLEEP_EPS) return;
  addDelta(buf, t.scalar, c, -sent);
  for (let j = 0; j < targets.length; j++) addDelta(buf, t.scalar, targets[j], offers[j] * scale);
}

// --- Catch-up / fast-forward --------------------------------------------------

/** Above this requested span, attempt PERIOD FOLDING (cycle detection) so an
 *  endlessly-cycling world (e.g. a day/night field) is caught up in O(period)
 *  instead of O(elapsed). Below it, stepping is already cheap. */
const FOLD_MIN = 2000;
/** Stop trying to detect a cycle after this many distinct states (the world is
 *  aperiodic or its transient is long) — fall back to capped stepping. */
const FOLD_DETECT_CAP = 50_000;

/** A RELATIVE fingerprint of everything that determines future evolution —
 *  fields, stages, clock phases, armed timers, last-guards and the pending
 *  schedule, all expressed relative to the clock so two cycle-equivalent states
 *  hash equal. Excludes the absolute clock counter (which only ever increases). */
function fingerprintGrid(grid: CellGrid): string {
  const p: (string | number)[] = [];
  for (const c of grid.spec.clocks ?? []) p.push(grid.clockPhase[c.name]);
  for (const v of grid.spec.vars ?? []) { const a = grid.fields[v.name]; for (let i = 0; i < a.length; i++) p.push(a[i]); }
  for (const s of grid.spec.states ?? []) { const a = grid.stageIdx[s.name]; for (let i = 0; i < a.length; i++) p.push(a[i]); }
  for (let r = 0; r < grid.armed.length; r++) {
    const m = grid.armed[r]; if (!m.size) continue;
    const e = [...m].sort((a, b) => a[0] - b[0]); p.push('a', r);
    for (const [cell, fa] of e) p.push(cell, fa - grid.clock);
  }
  for (let r = 0; r < grid.lastGuard.length; r++) {
    const a = grid.lastGuard[r]; let any = false;
    for (let i = 0; i < a.length; i++) if (a[i]) { any = true; break; }
    if (!any) continue; p.push('g', r);
    for (let i = 0; i < a.length; i++) if (a[i]) p.push(i);
  }
  const pairs: [number, number][] = [];
  for (const [step, set] of grid.buckets) for (const cell of set) if (grid.due[cell] === step) pairs.push([cell, step - grid.clock]);
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  p.push('s'); for (const [cell, off] of pairs) p.push(cell, off);
  return p.join('|');
}

/** Skip `skip` steps forward (a multiple of the detected period) by SHIFTING the
 *  clock counter and every scheduled/armed absolute step by `skip`. Valid only
 *  when `skip` is a multiple of the cycle period: the relative state is unchanged
 *  and clock phases are invariant (the period is a multiple of every clock's). */
function shiftSchedule(grid: CellGrid, skip: number): void {
  grid.clock += skip;
  for (const m of grid.armed) for (const [cell, fa] of [...m]) m.set(cell, fa + skip);
  const nb = new Map<number, Set<number>>();
  for (const [step, set] of grid.buckets) nb.set(step + skip, set);
  grid.buckets = nb;
  const due = grid.due;
  for (let i = 0; i < due.length; i++) if (due[i] >= 0) due[i] += skip;
}

/** Advance `steps` grid-steps, jumping across idle stretches AND folding exact
 *  cycles. Identical in result to calling worldStep that many times — the live
 *  loop and the on-return catch-up share this path. */
export function gridFastForward(grid: CellGrid, steps: number): void {
  const comp = compile(grid.spec);
  const end = grid.clock + Math.max(0, Math.floor(steps));
  // Only bother detecting cycles for big spans (the idle-time catch-up case).
  let seen: Map<string, number> | null = (end - grid.clock) > FOLD_MIN ? new Map() : null;
  let guard = 0;
  while (grid.clock < end && guard++ < MAX_GRID_CATCHUP) {
    const nb = nextBucketStep(grid, grid.clock, end);
    const ce = nextClockBoundaryStep(
      grid.clock, end, comp.clockBoundaries,
      clk => comp.clocks.get(clk)!.period,
      clk => grid.clockPhase[clk],
    );
    let target = end;
    if (nb >= 0 && nb < target) target = nb;
    if (ce >= 0 && ce < target) target = ce;
    if (target <= grid.clock) target = grid.clock + 1;

    if (target >= end && nb < 0 && ce < 0) { advanceClocksTo(grid, end); break; } // fully idle → jump to end
    if (target - 1 > grid.clock) advanceClocksTo(grid, target - 1); // skip the proven-empty gap
    worldStep(grid); // process the event at `target`

    // Period folding: if this exact (relative) state recurred, the world is in a
    // cycle — skip whole periods, then let the loop finish the < P remainder.
    if (seen) {
      const key = fingerprintGrid(grid);
      const prev = seen.get(key);
      if (prev !== undefined) {
        const P = grid.clock - prev;
        const remaining = end - grid.clock;
        const skip = remaining - (remaining % P);
        if (skip > 0) shiftSchedule(grid, skip);
        seen = null; // stop detecting; remainder steps normally
      } else {
        seen.set(key, grid.clock);
        if (seen.size > FOLD_DETECT_CAP) seen = null; // aperiodic → give up, just step
      }
    }
  }
}

// --- External input -----------------------------------------------------------

/** Raw delta into a tile's scalar (player paint / a future neighbour-of-grid
 *  input), bypassing the budget rule, waking the tile and its neighbours. */
export function injectTile(grid: CellGrid, cell: number, scalar: string, amount: number): void {
  const arr = grid.fields[scalar];
  if (!arr) return;
  const v = compile(grid.spec).vars.get(scalar);
  if (!v) return;
  let next = arr[cell] + amount;
  if (v.int) next = Math.round(next);
  arr[cell] = Math.max(v.min, Math.min(v.max, next));
  if (compile(grid.spec).flowPotentials.has(scalar)) grid.flowDirty = true; // terrain edit → rivers re-route
  const nb: number[] = [0, 0, 0, 0];
  schedule(grid, cell, grid.clock + 1);
  const k = neighbours(grid, cell, nb);
  for (let j = 0; j < k; j++) schedule(grid, nb[j], grid.clock + 1);
}

/** Set a tile's stage (player input, e.g. plant a seed). Forward-only, like the
 *  autonomous rules. Wakes the tile + neighbours. */
export function setStageTile(grid: CellGrid, cell: number, state: string, to: string): void {
  const st = compile(grid.spec).stages.get(state);
  if (!st) return;
  const idx = st.stages.indexOf(to);
  if (idx > grid.stageIdx[state][cell]) {
    grid.stageIdx[state][cell] = idx;
    const nb: number[] = [0, 0, 0, 0];
    schedule(grid, cell, grid.clock + 1);
    const k = neighbours(grid, cell, nb);
    for (let j = 0; j < k; j++) schedule(grid, nb[j], grid.clock + 1);
  }
}

/** Sum of a scalar field — for conservation assertions in the tests / UI. */
export function totalField(grid: CellGrid, scalar: string): number {
  const arr = grid.fields[scalar];
  if (!arr) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

// --- Serialization ------------------------------------------------------------

export function serializeGrid(grid: CellGrid): string {
  const fields: Record<string, number[]> = {};
  for (const k in grid.fields) fields[k] = Array.from(grid.fields[k]);
  const stageIdx: Record<string, number[]> = {};
  for (const k in grid.stageIdx) stageIdx[k] = Array.from(grid.stageIdx[k]);
  const armed = grid.armed.map(m => [...m]);
  const lastGuard = grid.lastGuard.map(a => Array.from(a));
  return JSON.stringify({
    spec: grid.spec, cols: grid.cols, rows: grid.rows, wrap: grid.wrap,
    fields, stageIdx, clockPhase: grid.clockPhase, clock: grid.clock,
    armed, lastGuard, buckets: serializeBuckets(grid),
  });
}

function serializeBuckets(grid: CellGrid): number[] {
  const out: number[] = [];
  for (const [step, cells] of grid.buckets) for (const c of cells) out.push(step, c);
  return out;
}

export function deserializeGrid(json: string): CellGrid | null {
  try {
    const p = JSON.parse(json);
    if (!p || !p.spec || typeof p.cols !== 'number') return null;
    const n = p.cols * p.rows;
    const fields: Record<string, Float64Array> = {};
    for (const k in p.fields) fields[k] = Float64Array.from(p.fields[k]);
    const stageIdx: Record<string, Uint8Array> = {};
    for (const k in p.stageIdx) stageIdx[k] = Uint8Array.from(p.stageIdx[k]);
    const due = new Int32Array(n).fill(-1);
    const grid: CellGrid = {
      spec: p.spec, cols: p.cols, rows: p.rows, wrap: !!p.wrap, fields, stageIdx,
      clockPhase: p.clockPhase ?? {}, clock: p.clock ?? 0,
      buckets: new Map(), due,
      armed: (p.armed ?? p.spec.rules.map(() => [])).map((e: [number, number][]) => new Map(e)),
      lastGuard: p.lastGuard
        ? p.lastGuard.map((a: number[]) => Uint8Array.from(a))
        : p.spec.rules.map(() => new Uint8Array(n)),
      flowDirty: false,
    };
    const flat: number[] = p.buckets ?? [];
    for (let k = 0; k + 1 < flat.length; k += 2) schedule(grid, flat[k + 1], Math.max(grid.clock + 1, flat[k]));
    return grid;
  } catch {
    return null;
  }
}
