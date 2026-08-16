// Cell Systems — WorldSpec (entity/relationship) validator.
//
// Same guarantees as the grid, lifted to the entity graph. The headline check is
// the COUPLING DIMENSION over entity AND edge attributes together: a feedback
// loop among 3+ dynamic attributes (e.g. hostility → population → grievance →
// hostility) is the civilization chaos risk and is rejected; a pairwise loop
// (hostility ↔ population) is allowed — a predictable rise/fall. Plus: budgets
// can't self-regenerate, transport is grid-only, war costs are losses.

import type { WorldSpec, Ref, Condition, Effect, VarSpec } from './spec';
import { type ValidationResult, tarjanSCC, maxDelta } from './validate';

type Ctx = 'entity' | 'edge';

function writeTarget(e: Effect): string | null {
  if ('add' in e) return e.add.scalar;
  if ('toward' in e) return e.toward.scalar;
  if ('change' in e) return e.change.scalar;
  return null;
}

export function validateWorldSpec(spec: WorldSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const entityVars = new Map((spec.entity.vars ?? []).map(v => [v.name, v] as const));
  const edgeVars = new Map((spec.edge?.vars ?? []).map(v => [v.name, v] as const));
  const entityVarNames = new Set(entityVars.keys());
  const edgeVarNames = new Set(edgeVars.keys());
  const clockNames = new Set((spec.clocks ?? []).map(c => c.name));
  const entityStages = new Map((spec.entity.states ?? []).map(s => [s.name, s] as const));
  const entityBudgets = new Set([...entityVars.values()].filter(v => v.budget).map(v => v.name));
  const edgeBudgets = new Set([...edgeVars.values()].filter(v => v.budget).map(v => v.name));

  for (const v of [...(spec.entity.vars ?? []), ...(spec.edge?.vars ?? [])]) {
    if (v.min >= v.max) errors.push(`var "${v.name}": min (${v.min}) must be < max (${v.max}).`);
  }
  for (const c of spec.clocks ?? []) if (!(c.period > 0)) errors.push(`clock "${c.name}": period must be > 0.`);

  // --- Reference integrity (context-aware) ----------------------------------
  const checkRef = (ref: Ref, where: string, ctx: Ctx) => {
    if ('scalar' in ref) {
      const ok = ctx === 'entity' ? entityVarNames.has(ref.scalar) : edgeVarNames.has(ref.scalar);
      if (!ok) errors.push(`${where}: unknown ${ctx} var "${ref.scalar}".`);
    } else if ('clock' in ref) {
      if (!clockNames.has(ref.clock)) errors.push(`${where}: unknown clock "${ref.clock}".`);
    } else if ('sensor' in ref) {
      errors.push(`${where}: {sensor} is grid-only (not available to entities/edges).`);
    } else if ('endpoints' in ref) {
      if (ctx !== 'edge') errors.push(`${where}: {endpoints} is only valid in edge rules.`);
      else if (!entityVarNames.has(ref.endpoints)) errors.push(`${where}: endpoints attr "${ref.endpoints}" is not an entity var.`);
    }
  };
  const checkCond = (c: Condition | undefined, where: string, ctx: Ctx) => {
    if (!c) return;
    if ('cmp' in c) { checkRef(c.left, where, ctx); checkRef(c.right, where, ctx); }
    else if ('all' in c) c.all.forEach(x => checkCond(x, where, ctx));
    else if ('any' in c) c.any.forEach(x => checkCond(x, where, ctx));
    else if ('not' in c) checkCond(c.not, where, ctx);
    else if ('stageIs' in c || 'stageAtLeast' in c) {
      const sc = 'stageIs' in c ? c.stageIs : c.stageAtLeast;
      if (ctx !== 'entity') errors.push(`${where}: stages are entity-only.`);
      else { const st = entityStages.get(sc.state); if (!st) errors.push(`${where}: unknown state "${sc.state}".`); else if (!st.stages.includes(sc.is)) errors.push(`${where}: "${sc.is}" not a stage of "${sc.state}".`); }
    }
  };

  const rulesByCtx: Array<[WorldSpec['entity']['rules'], Ctx, Map<string, VarSpec>, Set<string>, Set<string>]> = [
    [spec.entity.rules, 'entity', entityVars, entityVarNames, entityBudgets],
    [spec.edge?.rules ?? [], 'edge', edgeVars, edgeVarNames, edgeBudgets],
  ];
  for (const [rules, ctx, vars, varNames, budgets] of rulesByCtx) {
    rules.forEach((r, i) => {
      const where = `${ctx} rule ${r.id ?? `#${i}`}`;
      checkCond(r.when, where, ctx);
      for (const e of r.effects) {
        if ('spread' in e || 'flowDown' in e || 'erode' in e) {
          errors.push(`${where}: transport (spread/flowDown/erode) is grid-only — use exchanges/conflicts for relationships.`);
          continue;
        }
        if ('setStage' in e && ctx === 'edge') { errors.push(`${where}: edges have no stages.`); continue; }
        const w = writeTarget(e);
        if (w && !varNames.has(w)) errors.push(`${where}: writes unknown ${ctx} var "${w}".`);
        if ('toward' in e) checkRef(e.toward.target, where, ctx);
        if ('change' in e) {
          if (e.change.times) checkRef(e.change.times, where, ctx);
          if (e.change.offset !== undefined && typeof e.change.offset === 'object') checkRef(e.change.offset, where, ctx);
        }
        if (w && budgets.has(w) && !r.external) {
          if ('toward' in e) errors.push(`${where}: \`toward\` on budget "${w}" can raise it; drain with add/change.`);
          else if (maxDelta(e, vars) > 1e-12) errors.push(`${where}: can RAISE budget "${w}" — autonomous rules may only drain it.`);
        }
      }
    });
  }

  // --- Exchanges & conflicts -------------------------------------------------
  for (const ex of spec.exchanges ?? []) {
    if (!entityVarNames.has(ex.scalar)) errors.push(`exchange "${ex.scalar}": unknown entity var.`);
    if (!(ex.rate > 0)) errors.push(`exchange "${ex.scalar}": rate must be > 0.`);
    if (ex.by && !edgeVarNames.has(ex.by)) errors.push(`exchange "${ex.scalar}": by "${ex.by}" is not an edge var.`);
  }
  for (const cf of spec.conflicts ?? []) {
    const id = cf.id ?? cf.by;
    if (!edgeVarNames.has(cf.by)) errors.push(`conflict "${id}": by "${cf.by}" is not an edge var.`);
    for (const c of cf.cost) {
      if (!entityVarNames.has(c.scalar)) errors.push(`conflict "${id}": cost var "${c.scalar}" unknown.`);
      else if (c.amount > 0) errors.push(`conflict "${id}": cost amount must be ≤ 0 (war is a loss, not a source).`);
    }
  }
  const flowNetIds = new Set((spec.flownets ?? []).map(f => f.id));
  for (const rd of spec.roads ?? []) {
    if (!edgeVarNames.has(rd.attr)) errors.push(`road "${rd.attr}": not an edge var.`);
    if (!entityVarNames.has(rd.use) && !flowNetIds.has(rd.use)) {
      errors.push(`road "${rd.attr}": use "${rd.use}" is neither an entity var nor a flow net id.`);
    }
    if (!(rd.rate > 0)) errors.push(`road "${rd.attr}": rate must be > 0.`);
    if (!(rd.decay > 0)) warnings.push(`road "${rd.attr}": decay ≤ 0 — the road never fades when unused.`);
  }

  // --- Flow networks ----------------------------------------------------------
  const seenFlowIds = new Set<string>();
  for (const fn of spec.flownets ?? []) {
    const id = fn.id || '(unnamed)';
    if (!fn.id) errors.push(`flow net: id is required.`);
    else if (seenFlowIds.has(fn.id)) errors.push(`flow net "${id}": duplicate id.`);
    seenFlowIds.add(fn.id);
    if (fn.id && entityVarNames.has(fn.id)) {
      errors.push(`flow net "${id}": id collides with an entity var (roads' \`use\` could not tell them apart).`);
    }
    if (!entityVarNames.has(fn.source)) errors.push(`flow net "${id}": source "${fn.source}" is not an entity var.`);
    if (!entityVarNames.has(fn.demand)) errors.push(`flow net "${id}": demand "${fn.demand}" is not an entity var.`);
    if (fn.by && !edgeVarNames.has(fn.by)) errors.push(`flow net "${id}": by "${fn.by}" is not an edge var.`);
    if (fn.drift && !entityVarNames.has(fn.drift)) errors.push(`flow net "${id}": drift "${fn.drift}" is not an entity var.`);
    if (fn.satisfied && !entityVarNames.has(fn.satisfied)) errors.push(`flow net "${id}": satisfied "${fn.satisfied}" is not an entity var.`);
    if (fn.feed && !fn.drift) errors.push(`flow net "${id}": feed requires a drift stockpile (there is nothing to feed from).`);
  }

  // --- Processes --------------------------------------------------------------
  const processOutputs = new Set<string>();
  for (const pr of spec.processes ?? []) {
    const id = pr.id ?? `${pr.input ?? pr.inputs?.map(r => r.scalar).join('+')}→${pr.output}`;
    const single = pr.input !== undefined;
    const multi = pr.inputs !== undefined && pr.inputs.length > 0;
    if (single === multi) errors.push(`process "${id}": exactly one of \`input\` (with efficiency) or \`inputs\` is required.`);
    if (single) {
      if (!entityVarNames.has(pr.input!)) errors.push(`process "${id}": input "${pr.input}" is not an entity var.`);
      if (!((pr.efficiency ?? 0) > 0)) errors.push(`process "${id}": efficiency must be > 0.`);
      if (pr.input === pr.output) errors.push(`process "${id}": input and output must differ (a process is a pure function, not a feedback).`);
    }
    if (multi) {
      for (const r of pr.inputs!) {
        if (!entityVarNames.has(r.scalar)) errors.push(`process "${id}": input "${r.scalar}" is not an entity var.`);
        if (!(r.efficiency > 0)) errors.push(`process "${id}": efficiency for "${r.scalar}" must be > 0.`);
        if (r.scalar === pr.output) errors.push(`process "${id}": input and output must differ (a process is a pure function, not a feedback).`);
      }
    }
    if (!entityVarNames.has(pr.output)) errors.push(`process "${id}": output "${pr.output}" is not an entity var.`);
    if (pr.capacityBy && !entityVarNames.has(pr.capacityBy)) errors.push(`process "${id}": capacityBy "${pr.capacityBy}" is not an entity var.`);
    if (processOutputs.has(pr.output)) warnings.push(`process "${id}": output "${pr.output}" written by more than one process — later ones win.`);
    processOutputs.add(pr.output);
  }

  // --- Sums (fan-in) and allocates (fan-out) — §3d relays ---------------------
  for (const sm of spec.sums ?? []) {
    const id = sm.id ?? `Σ→${sm.output}`;
    if (!entityVarNames.has(sm.output)) errors.push(`sum "${id}": output "${sm.output}" is not an entity var.`);
    if (!sm.terms || sm.terms.length === 0) errors.push(`sum "${id}": needs at least one term.`);
    for (const t of sm.terms ?? []) {
      if (!entityVarNames.has(t.scalar)) errors.push(`sum "${id}": term "${t.scalar}" is not an entity var.`);
      if (t.scalar === sm.output) errors.push(`sum "${id}": a sum may not read its own output.`);
    }
    if (processOutputs.has(sm.output)) warnings.push(`sum "${id}": output "${sm.output}" also written by a process — later wins.`);
    processOutputs.add(sm.output);
  }
  for (const al of spec.allocates ?? []) {
    const id = al.id ?? `${al.source}⇒`;
    if (!entityVarNames.has(al.source)) errors.push(`allocate "${id}": source "${al.source}" is not an entity var.`);
    if (!al.shares || al.shares.length === 0) errors.push(`allocate "${id}": needs at least one share.`);
    for (const s of al.shares ?? []) {
      if (!entityVarNames.has(s.output)) errors.push(`allocate "${id}": share output "${s.output}" is not an entity var.`);
      if (!entityVarNames.has(s.demand)) errors.push(`allocate "${id}": share demand "${s.demand}" is not an entity var.`);
      if (s.output === al.source) errors.push(`allocate "${id}": a share may not overwrite the source.`);
      if (processOutputs.has(s.output)) warnings.push(`allocate "${id}": share "${s.output}" also written elsewhere — later wins.`);
      processOutputs.add(s.output);
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  // --- Unified coupling graph over entity + edge attributes ------------------
  const E = (n: string) => 'E:' + n, X = (n: string) => 'X:' + n;
  const adj = new Map<string, Set<string>>();
  for (const n of entityVarNames) adj.set(E(n), new Set());
  for (const n of edgeVarNames) adj.set(X(n), new Set());
  const link = (from: string | null, to: string) => { if (from && from !== to && adj.has(from) && adj.has(to)) adj.get(from)!.add(to); };
  const readNode = (ref: Ref, ctx: Ctx): string | null =>
    'scalar' in ref ? (ctx === 'entity' ? E(ref.scalar) : X(ref.scalar))
      : 'endpoints' in ref ? E(ref.endpoints) // an edge reading an endpoint entity attr
        : null;
  const condReads = (c: Condition | undefined, ctx: Ctx, out: Set<string>) => {
    if (!c) return;
    if ('cmp' in c) { for (const r of [c.left, c.right]) { const n = readNode(r, ctx); if (n) out.add(n); } }
    else if ('all' in c) c.all.forEach(x => condReads(x, ctx, out));
    else if ('any' in c) c.any.forEach(x => condReads(x, ctx, out));
    else if ('not' in c) condReads(c.not, ctx, out);
  };
  for (const [rules, ctx] of rulesByCtx) {
    rules.forEach(r => {
      if (r.external) return;
      const reads = new Set<string>(); condReads(r.when, ctx, reads);
      for (const e of r.effects) {
        const w = writeTarget(e);
        if (!w) continue;
        const wNode = ctx === 'entity' ? E(w) : X(w);
        const rs = new Set(reads);
        if ('toward' in e) { const n = readNode(e.toward.target, ctx); if (n) rs.add(n); }
        if ('change' in e) {
          if (e.change.times) { const n = readNode(e.change.times, ctx); if (n) rs.add(n); }
          if (e.change.offset !== undefined && typeof e.change.offset === 'object') { const n = readNode(e.change.offset, ctx); if (n) rs.add(n); }
        }
        for (const rn of rs) link(rn, wNode);
      }
    });
  }
  // Conflict couples the driving edge attr to each entity attr it drains.
  for (const cf of spec.conflicts ?? []) for (const c of cf.cost) link(X(cf.by), E(c.scalar));
  // Exchange diffuses an entity attr (self-loop, safe); but a `by` makes the flow
  // depend on that edge attr → the entity scalar's change depends on it.
  for (const ex of spec.exchanges ?? []) if (ex.by) link(X(ex.by), E(ex.scalar));
  // A road grows from the |flow| of its `use` scalar (entity → edge).
  for (const rd of spec.roads ?? []) link(E(rd.use), X(rd.attr));
  // A flow net reads {source, demand, by} and writes drift; a road using
  // the net inherits those reads. Drift raising a var is transport-like
  // (bounded by the component's own conservation), so it needs no budget
  // exemption — but the dependency edges must join the coupling analysis.
  //
  // The `by` edge is REFINED: drift is the per-component mean imbalance
  // and `satisfied` the proportional fill — both are pure functions of
  // {source, demand, component membership} and do NOT read conductance
  // values (only per-edge FLOWS do, and those feed roads, handled below).
  // Conductance touches them solely by SEVERING an edge (≤ 0 ⇒ the
  // component splits). A by-var with min > 0 can never sever, so it
  // contributes no dependency at all; only a severable by (min ≤ 0) gets
  // the conservative X(by) edge. This is what lets construction-from-
  // drift coexist with road-conducted nets (grand-dream tri worlds)
  // without fabricating a {stockpile, buildings, road} 3-loop.
  for (const fn of spec.flownets ?? []) {
    const byVar = fn.by ? edgeVars.get(fn.by) : undefined;
    const severable = byVar ? byVar.min <= 0 : false;
    for (const target of [fn.drift, fn.satisfied]) {
      if (!target) continue;
      link(E(fn.source), E(target));
      link(E(fn.demand), E(target));
      if (fn.by && severable) link(X(fn.by), E(target));
    }
    // The granary feedback: a fed `satisfied` also READS the drift stock
    // (top-up = min(stock, shortage)) — an honest dependency edge. The
    // stock stays STATE (it integrates); satisfied stays derived.
    if (fn.feed && fn.drift && fn.satisfied) link(E(fn.drift), E(fn.satisfied));
    for (const rd of spec.roads ?? []) {
      if (rd.use !== fn.id) continue;
      link(E(fn.source), X(rd.attr));
      link(E(fn.demand), X(rd.attr));
      if (fn.by) link(X(fn.by), X(rd.attr));
    }
  }
  // A process couples its reads to its output (a pure combinational node).
  for (const pr of spec.processes ?? []) {
    if (pr.input !== undefined) link(E(pr.input), E(pr.output));
    for (const r of pr.inputs ?? []) link(E(r.scalar), E(pr.output));
    if (pr.capacityBy) link(E(pr.capacityBy), E(pr.output));
  }
  // Sums and allocates are the same kind of node. An allocate's LATER
  // shares depend on every EARLIER share's demand (priority drains the
  // remainder), so all prior demands link forward too.
  for (const sm of spec.sums ?? []) {
    for (const t of sm.terms) link(E(t.scalar), E(sm.output));
  }
  for (const al of spec.allocates ?? []) {
    for (let i = 0; i < al.shares.length; i++) {
      link(E(al.source), E(al.shares[i].output));
      for (let j = 0; j <= i; j++) link(E(al.shares[j].demand), E(al.shares[i].output));
    }
  }

  // DERIVED vars (process outputs, flow-net `satisfied`) are pure functions
  // of state — combinational relays, not state. The chaos bound
  // (Poincaré–Bendixson) counts STATE dimensions, so a loop's size is its
  // count of non-derived attributes: buildings → output(derived) →
  // stockpile → buildings is a legal 2-STATE loop even though it touches
  // three names. (Flow-net `drift` targets integrate — they stay state.)
  const derived = new Set<string>();
  for (const pr of spec.processes ?? []) derived.add(E(pr.output));
  for (const fn of spec.flownets ?? []) if (fn.satisfied) derived.add(E(fn.satisfied));
  for (const sm of spec.sums ?? []) derived.add(E(sm.output));
  for (const al of spec.allocates ?? []) for (const s of al.shares) derived.add(E(s.output));

  // MONOTONE COUNTERS — the scalar mirror of a forward-only stage DAG: a
  // var whose every autonomous writer is a fixed-sign `add` (all writers
  // agree on the direction; no toward/change, no exchange, no road
  // grow/decay, no signed drift integrator). Bounded + one-way ⇒ it
  // changes finitely often and then freezes, so it cannot carry
  // recurrence — like derived relays, it doesn't count toward a loop's
  // state dimension. The canonical case is construction (buildings are
  // +1-only counters): three build rules spending one granary would
  // otherwise fuse three legal {granary, building} pairs into a
  // fictitious 4-state SCC, purely because each guard reads its own
  // counter while the effect spends the shared stock.
  const addSign = new Map<string, number>();
  const nonMonotone = new Set<string>();
  const noteWrite = (node: string, sign: number) => {
    if (sign === 0) return;
    const cur = addSign.get(node);
    if (cur === undefined) addSign.set(node, sign);
    else if (cur !== sign) nonMonotone.add(node);
  };
  for (const [rules, ctx] of rulesByCtx) {
    for (const r of rules) {
      if (r.external) continue; // external inputs are events, not dynamics
      for (const e of r.effects) {
        const w = writeTarget(e);
        if (!w) continue;
        const node = ctx === 'entity' ? E(w) : X(w);
        if ('add' in e) noteWrite(node, Math.sign(e.add.amount));
        else nonMonotone.add(node); // toward/change can move both ways
      }
    }
  }
  for (const cf of spec.conflicts ?? []) for (const c of cf.cost) noteWrite(E(c.scalar), Math.sign(c.amount));
  for (const ex of spec.exchanges ?? []) nonMonotone.add(E(ex.scalar));
  for (const rd of spec.roads ?? []) nonMonotone.add(X(rd.attr)); // grows AND decays
  for (const fn of spec.flownets ?? []) if (fn.drift) nonMonotone.add(E(fn.drift)); // signed integrator
  const monotone = new Set([...addSign.keys()].filter(n => !nonMonotone.has(n)));
  for (const [rules, ctx] of rulesByCtx) {
    rules.forEach((r, i) => {
      for (const e of r.effects) {
        const w = writeTarget(e);
        if (w && derived.has(ctx === 'entity' ? E(w) : X(w))) {
          warnings.push(`${ctx} rule ${r.id ?? `#${i}`}: writes derived var "${w}" — a process/flow net overwrites it every step.`);
        }
      }
    });
  }

  for (const scc of tarjanSCC(adj)) {
    const names = scc.map(s => s.slice(2));
    const stateCount = scc.filter(s => !derived.has(s) && !monotone.has(s)).length;
    if (stateCount >= 3) {
      errors.push(
        `feedback loop couples ${stateCount} state attributes (${names.join(', ')}). Three or more mutually-coupled ` +
        `entity/edge attributes can be chaotic (the civilization three-body case) and aren't fast-forwardable — ` +
        `keep relationship feedback pairwise, or make a leg dissipative (budget/decay).`,
      );
    } else if (stateCount === 2) {
      warnings.push(`2-attribute feedback loop (${names.join(' ↔ ')}): bounded ⇒ non-chaotic — expect a predictable rise/fall.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
