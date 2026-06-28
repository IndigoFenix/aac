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
  for (const rd of spec.roads ?? []) {
    if (!edgeVarNames.has(rd.attr)) errors.push(`road "${rd.attr}": not an edge var.`);
    if (!entityVarNames.has(rd.use)) errors.push(`road "${rd.attr}": use "${rd.use}" is not an entity var.`);
    if (!(rd.rate > 0)) errors.push(`road "${rd.attr}": rate must be > 0.`);
    if (!(rd.decay > 0)) warnings.push(`road "${rd.attr}": decay ≤ 0 — the road never fades when unused.`);
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

  for (const scc of tarjanSCC(adj)) {
    const names = scc.map(s => s.slice(2));
    if (scc.length >= 3) {
      errors.push(
        `feedback loop couples ${scc.length} attributes (${names.join(', ')}). Three or more mutually-coupled ` +
        `entity/edge attributes can be chaotic (the civilization three-body case) and aren't fast-forwardable — ` +
        `keep relationship feedback pairwise, or make a leg dissipative (budget/decay).`,
      );
    } else if (scc.length === 2) {
      warnings.push(`2-attribute feedback loop (${names.join(' ↔ ')}): bounded ⇒ non-chaotic — expect a predictable rise/fall.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
