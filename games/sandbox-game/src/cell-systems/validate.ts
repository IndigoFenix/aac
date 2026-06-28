// Cell Systems — the guarantee validator.
//
// This is the gate that makes a custom JSON system idle-safe. It enforces, at
// authoring time, the structural rules we settled on so that ANY accepted spec
// is fast-forwardable (reaches rest or rides a predictable cycle) and can never
// go chaotic — regardless of the numbers chosen:
//
//   1. Bounded state.           Every var has a finite [min,max]. (Schema-level,
//                               re-checked here.) No value can blow up.
//   2. No budget regeneration.  An autonomous (non-external) rule may never RAISE
//                               a budget var. Budgets only drain on their own;
//                               raising one needs an `external` input. This is the
//                               monotone progress measure that bounds how long the
//                               cell can keep changing.
//   3. Read-only clocks.        Nothing may write a clock; a clock's rate is fixed
//                               in the schema. (Autonomous oscillator = predictable.)
//   4. Coupling dimension ≤ 2.  Build the var→var dependency graph from the rules.
//                               A feedback loop (a strongly-connected component) of
//                               3+ variables is REJECTED — three mutually-coupled
//                               continuous variables are the three-body / Hastings–
//                               Powell case and can be chaotic. A 2-variable loop is
//                               allowed: a bounded 2-D system is provably non-chaotic
//                               (Poincaré–Bendixson) — it either settles or rides a
//                               predictable cycle.
//   5. Don't force an oscillator. A clock may be READ freely, but not to drive a
//                               variable that sits inside a feedback loop — periodic
//                               forcing of an oscillator re-introduces a third
//                               dimension and the chaos with it.

import type { SystemSpec, RuleSpec, Effect, Condition, Ref } from './spec';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSpec(spec: SystemSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const varNames = new Set((spec.vars ?? []).map(v => v.name));
  const clockNames = new Set((spec.clocks ?? []).map(c => c.name));
  const stageByName = new Map((spec.states ?? []).map(s => [s.name, s]));
  const varByName = new Map((spec.vars ?? []).map(v => [v.name, v]));
  const budgets = new Set((spec.vars ?? []).filter(v => v.budget).map(v => v.name));
  const sensorNames = new Set((spec.sensors ?? []).map(s => s.name));
  const sensorOf = new Map((spec.sensors ?? []).map(s => [s.name, s.of] as const));
  /** The var a ref ultimately READS (a sensor reads its source var), or null. */
  const readVarOf = (ref: Ref): string | null =>
    'scalar' in ref ? ref.scalar : 'sensor' in ref ? sensorOf.get(ref.sensor) ?? null : null;

  // --- 1. Declarations sane -------------------------------------------------
  for (const v of spec.vars ?? []) {
    if (v.min >= v.max) errors.push(`var "${v.name}": min (${v.min}) must be < max (${v.max}).`);
    if (v.initial < v.min || v.initial > v.max) {
      warnings.push(`var "${v.name}": initial ${v.initial} is outside [${v.min}, ${v.max}] (will be clamped).`);
    }
  }
  for (const c of spec.clocks ?? []) {
    if (!(c.period > 0)) errors.push(`clock "${c.name}": period must be > 0.`);
  }
  for (const s of spec.states ?? []) {
    if (s.stages.length < 1) errors.push(`state "${s.name}": needs at least one stage.`);
    if (!s.stages.includes(s.initial)) errors.push(`state "${s.name}": initial "${s.initial}" not in stages.`);
  }
  for (const s of spec.sensors ?? []) {
    if (!varNames.has(s.of)) errors.push(`sensor "${s.name}": unknown source var "${s.of}".`);
    if (!(s.radius >= 0)) errors.push(`sensor "${s.name}": radius must be ≥ 0.`);
  }

  // --- Reference integrity --------------------------------------------------
  const checkRef = (ref: Ref, where: string) => {
    if ('scalar' in ref && !varNames.has(ref.scalar)) errors.push(`${where}: unknown var "${ref.scalar}".`);
    if ('clock' in ref && !clockNames.has(ref.clock)) errors.push(`${where}: unknown clock "${ref.clock}".`);
    if ('sensor' in ref && !sensorNames.has(ref.sensor)) errors.push(`${where}: unknown sensor "${ref.sensor}".`);
  };
  const checkCond = (c: Condition | undefined, where: string) => {
    if (!c) return;
    if ('cmp' in c) { checkRef(c.left, where); checkRef(c.right, where); }
    else if ('all' in c) c.all.forEach(x => checkCond(x, where));
    else if ('any' in c) c.any.forEach(x => checkCond(x, where));
    else if ('not' in c) checkCond(c.not, where);
    else if ('stageIs' in c) checkStageVal(c.stageIs.state, c.stageIs.is, where);
    else if ('stageAtLeast' in c) checkStageVal(c.stageAtLeast.state, c.stageAtLeast.is, where);
  };
  const checkStageVal = (state: string, val: string, where: string) => {
    const st = stageByName.get(state);
    if (!st) errors.push(`${where}: unknown state "${state}".`);
    else if (!st.stages.includes(val)) errors.push(`${where}: "${val}" not a stage of "${state}".`);
  };

  spec.rules.forEach((r, i) => {
    const where = `rule ${r.id ?? `#${i}`}`;
    const isTimer = 'timer' in r.trigger;
    checkCond(r.when, where);
    if ('timer' in r.trigger && !(r.trigger.timer >= 1)) {
      errors.push(`${where}: timer must be ≥ 1 step.`);
    }
    for (const e of r.effects) {
      const w = writeTarget(e);
      if (w) {
        if (clockNames.has(w)) errors.push(`${where}: cannot write clock "${w}" — clocks are autonomous (rule 3).`);
        else if (!varNames.has(w)) errors.push(`${where}: writes unknown var "${w}".`);
      }
      if ('toward' in e) checkRef(e.toward.target, where);
      if ('change' in e && e.change.times) checkRef(e.change.times, where);
      if ('change' in e && e.change.offset !== undefined && typeof e.change.offset === 'object') checkRef(e.change.offset, where);
      if ('setStage' in e) checkStageVal(e.setStage.state, e.setStage.to, where);
      // Transport (grid-only) — conservative & monotone by construction, so it is
      // exempt from the budget-raise / chaos-graph checks; just validate refs.
      if ('spread' in e || 'flowDown' in e || 'erode' in e) {
        const tr = 'spread' in e ? e.spread : 'flowDown' in e ? e.flowDown : e.erode;
        if (!varNames.has(tr.scalar)) errors.push(`${where}: transport on unknown var "${tr.scalar}".`);
        if (!(tr.rate > 0)) errors.push(`${where}: transport rate must be > 0.`);
        if ('flowDown' in e && e.flowDown.potential && !varNames.has(e.flowDown.potential)) {
          errors.push(`${where}: flowDown potential "${e.flowDown.potential}" is not a var.`);
        }
        if ('flowDown' in e && e.flowDown.block && !varNames.has(e.flowDown.block)) {
          errors.push(`${where}: flowDown block "${e.flowDown.block}" is not a var.`);
        }
        if ('erode' in e) {
          if (!varNames.has(e.erode.by)) errors.push(`${where}: erode 'by' var "${e.erode.by}" is not a var.`);
          if (e.erode.block && !varNames.has(e.erode.block)) errors.push(`${where}: erode block "${e.erode.block}" is not a var.`);
        }
        if (isTimer) errors.push(`${where}: transport (spread/flowDown/erode) must be a continuous {every:true} rule, not a timer.`);
      }
    }
  });

  // Tools (player toolbar inputs) — paint scalars / advance a stage.
  for (const t of spec.tools ?? []) {
    for (const p of t.paints ?? []) {
      if (!varNames.has(p.scalar)) errors.push(`tool "${t.id}": paints unknown var "${p.scalar}".`);
    }
    if (t.setStage) checkStageVal(t.setStage.state, t.setStage.to, `tool "${t.id}"`);
  }

  // If references are broken, the graph analysis below is meaningless — bail early.
  if (errors.length) return { ok: false, errors, warnings };

  // --- 2. No autonomous budget regeneration ---------------------------------
  spec.rules.forEach((r, i) => {
    if (r.external) return; // external inputs are exactly what may raise a budget
    const where = `rule ${r.id ?? `#${i}`}`;
    for (const e of r.effects) {
      const w = writeTarget(e);
      if (!w || !budgets.has(w)) continue;
      if ('toward' in e) {
        errors.push(`${where}: \`toward\` on budget "${w}" is not allowed (it can raise it). Drain budgets with \`add\`/\`change\` (rule 2).`);
        continue;
      }
      if (maxDelta(e, varByName) > 1e-12) {
        errors.push(`${where}: can RAISE budget "${w}" — autonomous rules may only drain a budget; mark the rule \`external\` if it's a player/neighbour input (rule 2).`);
      }
    }
  });

  // --- 4. Coupling dimension: build the var→var dependency graph -------------
  // Edge B → A means "a rule writes A while reading B" (A's change depends on B).
  // Self-edges are dropped: a 1-variable contraction/decay is fine. Only loops
  // among DISTINCT variables threaten chaos. External rules are excluded — they
  // don't fire autonomously, so they can't sustain a feedback loop.
  const adj = new Map<string, Set<string>>();
  for (const v of varNames) adj.set(v, new Set());
  for (const r of spec.rules) {
    if (r.external) continue;
    const condReads = condVars(r.when, readVarOf);
    for (const e of r.effects) {
      const w = writeTarget(e);
      if (!w || !varNames.has(w)) continue;
      const reads = new Set<string>(condReads);
      if ('toward' in e) { const b = readVarOf(e.toward.target); if (b) reads.add(b); }
      if ('change' in e) {
        if (e.change.times) { const b = readVarOf(e.change.times); if (b) reads.add(b); }
        if (e.change.offset !== undefined && typeof e.change.offset === 'object') { const b = readVarOf(e.change.offset); if (b) reads.add(b); }
      }
      for (const b of reads) if (b !== w && varNames.has(b)) adj.get(b)!.add(w);
    }
  }

  const sccs = tarjanSCC(adj);
  const varInLoop = new Set<string>(); // any var in an SCC of size ≥ 2
  for (const scc of sccs) {
    if (scc.length >= 3) {
      errors.push(
        `feedback loop couples ${scc.length} variables (${scc.join(', ')}). ` +
        `Three or more mutually-coupled variables can be chaotic (the three-body / food-chain case) ` +
        `and are not fast-forwardable. Break the loop, or give it a budget that monotonically drains (rule 4).`,
      );
      scc.forEach(v => varInLoop.add(v));
    } else if (scc.length === 2) {
      scc.forEach(v => varInLoop.add(v));
      warnings.push(
        `2-variable feedback loop (${scc.join(' ↔ ')}): bounded, so non-chaotic (Poincaré–Bendixson) — it will ` +
        `settle or ride a predictable cycle. Add a damping term if you want it to come to rest while idle.`,
      );
    }
  }

  // --- 5. A clock must not force a variable that sits in a feedback loop -----
  spec.rules.forEach((r, i) => {
    if (r.external) return;
    const readsClock =
      condReadsClock(r.when) ||
      r.effects.some(e =>
        ('toward' in e && 'clock' in e.toward.target) ||
        ('change' in e && !!e.change.times && 'clock' in e.change.times));
    if (!readsClock) return;
    for (const e of r.effects) {
      const w = writeTarget(e);
      if (w && varInLoop.has(w)) {
        errors.push(
          `rule ${r.id ?? `#${i}`}: a clock drives "${w}", which is inside a feedback loop. ` +
          `Periodically forcing an oscillator re-introduces a third dimension and can be chaotic — ` +
          `only drive settling (non-loop) variables with a clock (rule 5).`,
        );
      }
    }
  });

  // --- Progress sanity (advisory) -------------------------------------------
  if (!budgets.size && !(spec.states ?? []).length && !varInLoop.size) {
    // Bounded vars + monotone flows still settle, but a budget or stage makes the
    // designer's intended "runs down to rest" explicit. Just a nudge.
    warnings.push('No budget, stage, or clock dynamics declared — the system relies on bounded flows to settle.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// --- Helpers ------------------------------------------------------------------

function writeTarget(e: Effect): string | null {
  if ('add' in e) return e.add.scalar;
  if ('toward' in e) return e.toward.scalar;
  if ('change' in e) return e.change.scalar;
  return null; // setStage writes a stage, not a var
}

function refMin(ref: Ref, vars: Map<string, { min: number; max: number }>): number {
  if ('const' in ref) return ref.const;
  if ('scalar' in ref) return vars.get(ref.scalar)?.min ?? 0;
  return 0; // clock phase normalised ≥ 0
}
function refMax(ref: Ref, vars: Map<string, { min: number; max: number }>): number {
  if ('const' in ref) return ref.const;
  if ('scalar' in ref) return vars.get(ref.scalar)?.max ?? 0;
  return 1; // clock phase normalised < 1
}

/** Largest (most positive) per-step delta an effect can apply to its target,
 *  given the declared variable ranges. Used to prove a budget can't be raised. */
export function maxDelta(e: Effect, vars: Map<string, { min: number; max: number }>): number {
  if ('add' in e) return e.add.amount;
  if ('toward' in e) {
    const rate = Math.max(0, Math.min(1, e.toward.rate));
    const targetMax = refMax(e.toward.target, vars);
    const curMin = vars.get(e.toward.scalar)?.min ?? 0;
    return (targetMax - curMin) * rate;
  }
  if ('change' in e) {
    const offMin = e.change.offset === undefined ? 0 : typeof e.change.offset === 'number' ? e.change.offset : refMin(e.change.offset, vars);
    const offMax = e.change.offset === undefined ? 0 : typeof e.change.offset === 'number' ? e.change.offset : refMax(e.change.offset, vars);
    const timesMin = e.change.times ? refMin(e.change.times, vars) : 1;
    const timesMax = e.change.times ? refMax(e.change.times, vars) : 1;
    const fMin = timesMin - offMax;
    const fMax = timesMax - offMin;
    return Math.max(e.change.perStep * fMin, e.change.perStep * fMax);
  }
  return 0;
}

function condVars(c: Condition | undefined, resolve: (r: Ref) => string | null): Set<string> {
  const out = new Set<string>();
  const walk = (x: Condition | undefined) => {
    if (!x) return;
    if ('cmp' in x) { for (const r of [x.left, x.right]) { const v = resolve(r); if (v) out.add(v); } }
    else if ('all' in x) x.all.forEach(walk);
    else if ('any' in x) x.any.forEach(walk);
    else if ('not' in x) walk(x.not);
  };
  walk(c);
  return out;
}

function condReadsClock(c: Condition | undefined): boolean {
  if (!c) return false;
  if ('cmp' in c) return ('clock' in c.left) || ('clock' in c.right);
  if ('all' in c) return c.all.some(condReadsClock);
  if ('any' in c) return c.any.some(condReadsClock);
  if ('not' in c) return condReadsClock(c.not);
  return false;
}

/** Tarjan's strongly-connected-components. Returns only the components that form
 *  a genuine cycle: size ≥ 2, or a single node with a self-edge (none survive
 *  here since we never add self-edges, but kept for safety). */
export function tarjanSCC(adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  const strongconnect = (v: string) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      const selfLoop = (adj.get(v)?.has(v)) ?? false;
      if (comp.length >= 2 || selfLoop) out.push(comp);
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strongconnect(v);
  return out;
}
