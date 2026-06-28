// Cell Systems — shared rule evaluation.
//
// The single-cell runtime (runtime.ts) and the grid engine (grid.ts) must apply
// IDENTICAL per-cell semantics, so the read/evaluate/own-effect math lives here,
// behind a tiny `CellView` (a read-only window onto one cell). Each engine
// implements CellView over its own storage (an object vs. typed-array columns)
// and shares this logic — guaranteeing a 1×1 grid behaves exactly like a flask.

import type { Ref, Condition, Effect, SystemSpec } from './spec';

/** Below this, a continuous move is treated as zero (snap to rest). */
export const SNAP_EPS = 1e-4;

/** Sleep/wake hysteresis: a cell whose fields move less than this in a step is
 *  treated as at rest (an order of magnitude above SNAP_EPS so sub-snap chatter
 *  can't keep the grid awake forever — same rationale as the terrain engine). */
export const SLEEP_EPS = 1e-3;

/** Read-only view of one cell, used by all rule evaluation. */
export interface CellView {
  scalar(name: string): number;
  /** Clock phase normalised to [0,1). */
  clockNorm(name: string): number;
  /** A derived neighbourhood sensor's value at this cell. */
  sensor(name: string): number;
  stage(name: string): string;
  /** Index of `value` within `state`'s ordered stages (-1 if unknown). */
  stageRank(state: string, value: string): number;
  /** Edge views only: aggregate an entity attribute over the two endpoints. */
  endpoints?(attr: string, agg: 'sum' | 'min' | 'max' | 'mean' | 'absdiff'): number;
}

export function clampRate(r: number): number {
  return Math.max(0, Math.min(1, r));
}

export function refVal(view: CellView, ref: Ref): number {
  if ('const' in ref) return ref.const;
  if ('scalar' in ref) return view.scalar(ref.scalar) * (ref.scale ?? 1) + (ref.offset ?? 0);
  if ('sensor' in ref) return view.sensor(ref.sensor) * (ref.scale ?? 1) + (ref.offset ?? 0);
  if ('endpoints' in ref) return (view.endpoints?.(ref.endpoints, ref.agg) ?? 0) * (ref.scale ?? 1) + (ref.offset ?? 0);
  return view.clockNorm(ref.clock);
}

export function evalCond(view: CellView, c: Condition | undefined): boolean {
  if (!c) return true;
  if ('cmp' in c) {
    const l = refVal(view, c.left);
    const r = refVal(view, c.right);
    switch (c.cmp) {
      case '<': return l < r;
      case '<=': return l <= r;
      case '>': return l > r;
      case '>=': return l >= r;
      case '==': return l === r;
      case '!=': return l !== r;
    }
  }
  if ('stageIs' in c) return view.stage(c.stageIs.state) === c.stageIs.is;
  if ('stageAtLeast' in c) {
    return view.stageRank(c.stageAtLeast.state, view.stage(c.stageAtLeast.state))
      >= view.stageRank(c.stageAtLeast.state, c.stageAtLeast.is);
  }
  if ('all' in c) return c.all.every(x => evalCond(view, x));
  if ('any' in c) return c.any.some(x => evalCond(view, x));
  if ('not' in c) return !evalCond(view, c.not);
  return true;
}

/** The per-cell ("own") part of an effect, resolved to a concrete delta. Returns
 *  null for transport effects (spread/flowDown), which act across cells and are
 *  handled by the grid engine. */
export type OwnDelta =
  | { kind: 'scalar'; scalar: string; delta: number }
  | { kind: 'stage'; state: string; to: string }
  | null;

export function ownEffectDelta(view: CellView, e: Effect): OwnDelta {
  if ('add' in e) return { kind: 'scalar', scalar: e.add.scalar, delta: e.add.amount };
  if ('toward' in e) {
    const cur = view.scalar(e.toward.scalar);
    const tgt = refVal(view, e.toward.target);
    return { kind: 'scalar', scalar: e.toward.scalar, delta: (tgt - cur) * clampRate(e.toward.rate) };
  }
  if ('change' in e) {
    const off = e.change.offset === undefined ? 0
      : typeof e.change.offset === 'number' ? e.change.offset
      : refVal(view, e.change.offset);
    const factor = (e.change.times ? refVal(view, e.change.times) : 1) - off;
    return { kind: 'scalar', scalar: e.change.scalar, delta: e.change.perStep * factor };
  }
  if ('setStage' in e) return { kind: 'stage', state: e.setStage.state, to: e.setStage.to };
  return null; // spread / flowDown — cross-cell, not an own-delta
}

/** Per clock, the integer phase positions [0,period) at which a guard could flip
 *  truth — the ONLY steps a clock can wake an idle cell, so fast-forward jumps
 *  between them instead of replaying. Always includes 0 (the wrap). A clock read
 *  in a flow target / `change.times` matters every step, so all its positions are
 *  recorded. Shared by the flask and the grid so both fast-forward identically. */
export function clockBoundaries(spec: SystemSpec): Map<string, number[]> {
  const period = new Map<string, number>();
  for (const c of spec.clocks ?? []) period.set(c.name, c.period);
  const sets = new Map<string, Set<number>>();
  const ensure = (clk: string) => {
    let s = sets.get(clk);
    if (!s) { s = new Set([0]); sets.set(clk, s); }
    return s;
  };
  const note = (clk: string, normalised: number) => {
    const p = period.get(clk) ?? 1;
    ensure(clk).add(((Math.ceil(normalised * p) % p) + p) % p);
  };
  const everyPos = (clk: string) => {
    const p = period.get(clk) ?? 1;
    const s = ensure(clk);
    for (let i = 0; i < p; i++) s.add(i);
  };
  const scan = (c: Condition | undefined) => {
    if (!c) return;
    if ('cmp' in c) {
      for (const [a, b] of [[c.left, c.right], [c.right, c.left]] as [Ref, Ref][]) {
        if ('clock' in a && 'const' in b) note(a.clock, b.const);
      }
    } else if ('all' in c) c.all.forEach(scan);
    else if ('any' in c) c.any.forEach(scan);
    else if ('not' in c) scan(c.not);
  };
  for (const r of spec.rules) {
    scan(r.when);
    for (const e of r.effects) {
      if ('toward' in e && 'clock' in e.toward.target) everyPos(e.toward.target.clock);
      if ('change' in e && e.change.times && 'clock' in e.change.times) everyPos(e.change.times.clock);
    }
  }
  const out = new Map<string, number[]>();
  for (const [k, s] of sets) out.set(k, [...s].sort((a, b) => a - b));
  return out;
}

/** Soonest step strictly after `clock` and ≤ `cap` at which a clock crosses one
 *  of its boundary positions, or -1 if none. `phaseAt` reads the current phase
 *  (steps) of a clock. */
export function nextClockBoundaryStep(
  clock: number, cap: number,
  boundaries: Map<string, number[]>,
  periodOf: (clk: string) => number,
  phaseAt: (clk: string) => number,
): number {
  let best = -1;
  for (const [clk, positions] of boundaries) {
    const period = periodOf(clk);
    const cur = phaseAt(clk);
    for (const p of positions) {
      let delta = ((p - cur) % period + period) % period;
      if (delta === 0) delta = period; // strictly future
      const at = clock + delta;
      if (at <= cap && (best < 0 || at < best)) best = at;
    }
  }
  return best;
}
