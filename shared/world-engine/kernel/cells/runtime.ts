// Cell Systems — single-cell runtime (Step 1: the flask).
//
// Instantiates a SystemSpec into a live cell and evolves it. Two evolution
// primitives, mirroring the design:
//   • TIMED transitions ({timer:N}) — armed on the rising edge of their guard,
//     fired (and RE-VALIDATED) N steps later. These are the cheap primitive: a
//     settled cell with only a pending timer costs nothing until the timer is
//     due, so fast-forward JUMPS straight to it.
//   • CONTINUOUS updates ({every:true}) — applied each step while their guard
//     holds, used for flows/oscillators. They ε-snap to rest, after which the
//     cell idles and fast-forward can jump again.
// CLOCKS advance by a fixed rate and are EVALUATED by formula on fast-forward
// (never replayed step by step), with guard-relevant phase crossings treated as
// the only events that can wake an idle cell.
//
// Everything here assumes the spec PASSED validate.ts — the termination / no-
// chaos guarantees are enforced there; this module just runs an accepted spec.

import type {
  SystemSpec, Effect, VarSpec, StageSpec, ClockSpec,
} from './spec';
import {
  type CellView, evalCond, ownEffectDelta, SNAP_EPS, clockBoundaries, nextClockBoundaryStep,
} from './eval';

/** Backstop on a single fast-forward call (a settled/periodic world reaches its
 *  attractor far below this; an undamped oscillator is capped here). */
export const MAX_FF_STEPS = 200_000;

export interface EventLogEntry {
  clock: number;
  text: string;
}

export interface CellInstance {
  spec: SystemSpec;
  scalars: Record<string, number>;
  stages: Record<string, string>;
  /** Current phase of each clock, in steps, [0, period). */
  clockPhase: Record<string, number>;
  /** Local step counter (the cell's clock). */
  clock: number;
  /** ruleIndex → absolute step the armed timer fires. */
  armed: Map<number, number>;
  /** ruleIndex → guard value last step, for rising-edge timer arming. */
  lastGuard: boolean[];
  /** Optional rolling event log (UI only; capped). */
  log: EventLogEntry[];
}

// --- Compiled lookups (derived from the spec; not serialized) ----------------

interface Compiled {
  vars: Map<string, VarSpec>;
  stages: Map<string, StageSpec>;
  clocks: Map<string, ClockSpec>;
  /** sensor name → its source var + op (trivial in a single flask). */
  sensors: Map<string, { of: string; op: string }>;
  /** Per clock: the integer phase positions [0,period) at which a guard could
   *  change truth — the only steps a clock can wake an idle cell. Always includes
   *  0 (the wrap). Derived from every `{clock}`-vs-`{const}` comparison. */
  clockBoundaries: Map<string, number[]>;
}

const compiledCache = new WeakMap<SystemSpec, Compiled>();

function compile(spec: SystemSpec): Compiled {
  const cached = compiledCache.get(spec);
  if (cached) return cached;

  const vars = new Map<string, VarSpec>();
  for (const v of spec.vars ?? []) vars.set(v.name, v);
  const stages = new Map<string, StageSpec>();
  for (const s of spec.states ?? []) stages.set(s.name, s);
  const clocks = new Map<string, ClockSpec>();
  for (const c of spec.clocks ?? []) clocks.set(c.name, c);
  const sensors = new Map<string, { of: string; op: string }>();
  for (const s of spec.sensors ?? []) sensors.set(s.name, { of: s.of, op: s.op });

  const c: Compiled = { vars, stages, clocks, sensors, clockBoundaries: clockBoundaries(spec) };
  compiledCache.set(spec, c);
  return c;
}

// --- Instantiation ------------------------------------------------------------

export function instantiate(spec: SystemSpec): CellInstance {
  const scalars: Record<string, number> = {};
  for (const v of spec.vars ?? []) scalars[v.name] = clampVar(v, v.initial);
  const stages: Record<string, string> = {};
  for (const s of spec.states ?? []) stages[s.name] = s.initial;
  const clockPhase: Record<string, number> = {};
  for (const c of spec.clocks ?? []) {
    clockPhase[c.name] = ((c.phase ?? 0) % c.period + c.period) % c.period;
  }
  return {
    spec,
    scalars,
    stages,
    clockPhase,
    clock: 0,
    armed: new Map(),
    lastGuard: spec.rules.map(() => false),
    log: [],
  };
}

function clampVar(v: VarSpec, x: number): number {
  return Math.max(v.min, Math.min(v.max, x));
}

// --- Evaluation ---------------------------------------------------------------

/** A CellView (shared eval interface) over this instance. */
function makeView(inst: CellInstance, comp: Compiled): CellView {
  return {
    scalar: name => inst.scalars[name] ?? 0,
    clockNorm: name => (inst.clockPhase[name] ?? 0) / (comp.clocks.get(name)?.period ?? 1),
    // A flask has no neighbourhood: mean/max/min/sum = the value itself, and
    // prominence (value − local mean) is 0. Matches a 1×1 grid.
    sensor: name => {
      const s = comp.sensors.get(name);
      if (!s) return 0;
      return s.op === 'prominence' ? 0 : (inst.scalars[s.of] ?? 0);
    },
    stage: name => inst.stages[name],
    stageRank: (state, value) => comp.stages.get(state)?.stages.indexOf(value) ?? -1,
  };
}

function stageOrder(comp: Compiled, state: string, value: string): number {
  return comp.stages.get(state)?.stages.indexOf(value) ?? -1;
}

// --- Effect application (buffered) --------------------------------------------

interface Buffer {
  deltas: Map<string, number>;
  stageSets: { state: string; to: string }[];
}

function applyEffects(view: CellView, effects: Effect[], buf: Buffer): void {
  for (const e of effects) {
    const d = ownEffectDelta(view, e);
    if (!d) continue; // transport effects don't apply in a single flask
    if (d.kind === 'scalar') buf.deltas.set(d.scalar, (buf.deltas.get(d.scalar) ?? 0) + d.delta);
    else buf.stageSets.push({ state: d.state, to: d.to });
  }
}

/** Commit a buffer to the instance. Returns true if anything moved beyond ε
 *  (a continuous change ⇒ the cell stays awake), separate from stage changes. */
function commit(inst: CellInstance, comp: Compiled, buf: Buffer): boolean {
  let changed = false;
  for (const [name, dv] of buf.deltas) {
    const v = comp.vars.get(name);
    if (!v) continue;
    const before = inst.scalars[name];
    let next = clampVar(v, before + dv);
    if (Math.abs(next - before) < SNAP_EPS) next = before; // snap to rest
    if (next !== before) { inst.scalars[name] = next; changed = true; }
  }
  for (const set of buf.stageSets) {
    const st = comp.stages.get(set.state);
    if (!st) continue;
    const from = stageOrder(comp, set.state, inst.stages[set.state]);
    const to = stageOrder(comp, set.state, set.to);
    if (to > from) { // forward-only (the DAG); ignore backward/unknown targets
      inst.stages[set.state] = set.to;
      changed = true;
      pushLog(inst, `${set.state} → ${set.to}`);
    }
  }
  return changed;
}

function pushLog(inst: CellInstance, text: string): void {
  inst.log.push({ clock: inst.clock, text });
  if (inst.log.length > 200) inst.log.shift();
}

// --- Stepping -----------------------------------------------------------------

/** Advance exactly one step (clock T → T+1). Returns whether the cell changed
 *  (so the fast-forward loop knows to keep stepping vs. idle-jump). */
export function stepOne(inst: CellInstance): boolean {
  const comp = compile(inst.spec);
  const view = makeView(inst, comp);
  inst.clock += 1;
  for (const c of inst.spec.clocks ?? []) {
    inst.clockPhase[c.name] = (inst.clockPhase[c.name] + 1) % c.period;
  }

  const buf: Buffer = { deltas: new Map(), stageSets: [] };

  // 1. Continuous rules + timer arming (rising edge) / cancellation.
  inst.spec.rules.forEach((r, i) => {
    if (r.external) return; // external rules fire only on explicit input
    const g = evalCond(view, r.when);
    if ('every' in r.trigger) {
      if (g) applyEffects(view, r.effects, buf);
    } else {
      // timer: arm on a false→true edge; cancel a pending one if the guard drops
      if (g && !inst.lastGuard[i] && !inst.armed.has(i)) {
        inst.armed.set(i, inst.clock + Math.max(1, Math.round(r.trigger.timer)));
      } else if (!g) {
        inst.armed.delete(i);
      }
    }
    inst.lastGuard[i] = g;
  });

  // 2. Fire due timers — re-validating the guard (a timer is a prediction).
  for (const [i, fireAt] of [...inst.armed]) {
    if (fireAt > inst.clock) continue;
    inst.armed.delete(i);
    const r = inst.spec.rules[i];
    if (evalCond(view, r.when)) {
      applyEffects(view, r.effects, buf);
      pushLog(inst, r.id ? `timer: ${r.id}` : 'timer fired');
    }
  }

  return commit(inst, comp, buf);
}

/** Next strictly-future step (≤ cap) at which a clock could flip a guard, or -1
 *  if no clock contributes a wake before the cap. Lets an idle cell jump. */
function nextClockEvent(inst: CellInstance, comp: Compiled, cap: number): number {
  return nextClockBoundaryStep(
    inst.clock, cap, comp.clockBoundaries,
    clk => comp.clocks.get(clk)!.period,
    clk => inst.clockPhase[clk],
  );
}

/** Advance clocks (and the clock counter) by `n` steps WITHOUT evaluating rules.
 *  Valid only across a stretch proven event-free by the fast-forward loop. */
function jumpIdle(inst: CellInstance, n: number): void {
  if (n <= 0) return;
  inst.clock += n;
  for (const c of inst.spec.clocks ?? []) {
    inst.clockPhase[c.name] = (inst.clockPhase[c.name] + n) % c.period;
  }
}

/** Run forward `steps` cell-steps, jumping across idle stretches. This is the
 *  catch-up path: cost tracks events (timers, clock crossings, the tail of a
 *  continuous relaxation), not elapsed time. Identical in result to calling
 *  stepOne() `steps` times (verified by the engine checks). */
export function fastForward(inst: CellInstance, steps: number): void {
  const comp = compile(inst.spec);
  const end = inst.clock + Math.max(0, Math.floor(steps));
  let active = true; // unknown → take one real step first
  let guard = 0;
  while (inst.clock < end && guard++ < MAX_FF_STEPS) {
    if (active) { active = stepOne(inst); continue; }

    // Idle: find the next event strictly after `clock` (≤ end).
    let next = end;
    for (const fireAt of inst.armed.values()) if (fireAt < next) next = fireAt;
    const ce = nextClockEvent(inst, comp, end);
    if (ce >= 0 && ce < next) next = ce;

    if (next >= end) { jumpIdle(inst, end - inst.clock); break; }
    jumpIdle(inst, next - inst.clock - 1); // land just before the event…
    active = stepOne(inst);                 // …then process it
  }
}

// --- External input (player / Step-2 neighbour) -------------------------------

/** Apply a raw delta to a scalar, bypassing the budget rule (this IS the
 *  external input that legitimately raises a budget). Wakes the cell. */
export function inject(inst: CellInstance, scalar: string, amount: number): void {
  const comp = compile(inst.spec);
  const v = comp.vars.get(scalar);
  if (!v) return;
  inst.scalars[scalar] = clampVar(v, (inst.scalars[scalar] ?? 0) + amount);
  pushLog(inst, `input: ${scalar} ${amount >= 0 ? '+' : ''}${amount}`);
}

/** Fire an `external` rule on demand (e.g. a button in the editor). */
export function fireExternal(inst: CellInstance, ruleId: string): void {
  const comp = compile(inst.spec);
  const i = inst.spec.rules.findIndex(r => r.id === ruleId && r.external);
  if (i < 0) return;
  const r = inst.spec.rules[i];
  const view = makeView(inst, comp);
  if (!evalCond(view, r.when)) return;
  const buf: Buffer = { deltas: new Map(), stageSets: [] };
  applyEffects(view, r.effects, buf);
  commit(inst, comp, buf);
  pushLog(inst, `external: ${ruleId}`);
}

// --- Serialization ------------------------------------------------------------

export function serializeInstance(inst: CellInstance): string {
  return JSON.stringify({
    spec: inst.spec,
    scalars: inst.scalars,
    stages: inst.stages,
    clockPhase: inst.clockPhase,
    clock: inst.clock,
    armed: [...inst.armed],
    lastGuard: inst.lastGuard,
  });
}

export function deserializeInstance(json: string): CellInstance | null {
  try {
    const p = JSON.parse(json);
    if (!p || !p.spec || !Array.isArray(p.spec.rules)) return null;
    return {
      spec: p.spec,
      scalars: p.scalars ?? {},
      stages: p.stages ?? {},
      clockPhase: p.clockPhase ?? {},
      clock: p.clock ?? 0,
      armed: new Map(p.armed ?? []),
      lastGuard: p.lastGuard ?? p.spec.rules.map(() => false),
      log: [],
    };
  } catch {
    return null;
  }
}
