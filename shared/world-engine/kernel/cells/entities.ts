// Cell Systems — entity / relationship engine (Step 3: the algebra on a graph).
//
// The grid was the cell algebra on a fixed 4-regular LATTICE. This is the same
// algebra on an arbitrary GRAPH of sparse ENTITIES (cities) joined by edges
// (relationships). Per-entity behaviour reuses the rule engine (eval.ts); the two
// cross-entity primitives are the lattice transports lifted to the graph:
//
//   • EXCHANGE — a conservative diffusion of an entity scalar along edges
//     (wealth traded, people migrating). With the no-overshoot rate ≤ 1/(deg+1)
//     it has a Lyapunov function on ANY graph (the field's spread strictly
//     shrinks) ⇒ it equalises and settles, however far apart the entities are.
//   • CONFLICT — a dissipative budget SPEND driven by an edge attribute
//     (hostility → war): both endpoints lose from a budget and the hostility
//     decays, so every firing is a net loss ⇒ bounded ⇒ settles.
//
// So the termination / no-chaos guarantees carry over unchanged — they never
// depended on the lattice. Entity counts are small (cities, not 1024 tiles), so
// this engine processes every entity + edge each step (no active-set); it still
// reaches exact rest (SNAP) and fast-forwards by jumping idle stretches and
// folding exact cycles, identical to stepping.

import type { WorldSpec, VarSpec, StageSpec, ClockSpec, FlowNetSpec } from './spec';
import {
  type CellView, evalCond, ownEffectDelta, SNAP_EPS,
  clockBoundaries, nextClockBoundaryStep,
} from './eval';

/** Derived state of one steady-state flow network (grand-dream §4c): the
 *  solved edge flow field plus the per-entity imbalance drift. Recomputed
 *  only when the inputs' fingerprint changes; NOT serialized (rebuilt on
 *  the first step after load). */
export interface FlowNetState {
  /** Signed flow per edge (positive a→b), in scalar units per step. */
  flows: Float64Array;
  /** Per-entity drift applied each step (+overproduction share). */
  residual: Float64Array;
  /** Per-entity demand actually met (proportional component fill) — the
   *  chaining output written to FlowNetSpec.satisfied when declared. */
  satisfied: Float64Array;
  /** Solved potentials (producers high) — for rendering/debugging. */
  potential: Float64Array;
  fingerprint: string;
  recomputes: number;
}

export const MAX_WORLD_CATCHUP = 200_000;
const FOLD_MIN = 2000;
const FOLD_DETECT_CAP = 50_000;

export interface EntityWorld {
  spec: WorldSpec;
  n: number;
  /** entity var → per-entity values. */
  scalars: Record<string, Float64Array>;
  /** entity state → per-entity stage index. */
  stageIdx: Record<string, Uint8Array>;
  /** 2·n packed (x,y) positions — for rendering / roads later. */
  pos: Float64Array;
  edges: { a: number; b: number }[];
  /** edge var → per-edge values. */
  edgeAttr: Record<string, Float64Array>;
  /** entity → incident edge indices. */
  adj: number[][];
  clockPhase: Record<string, number>;
  clock: number;
  /** per entity-rule → (entity → fire step). */
  armedEntity: Array<Map<number, number>>;
  lastGuardEntity: Uint8Array[];
  /** per edge-rule → (edge → fire step). */
  armedEdge: Array<Map<number, number>>;
  lastGuardEdge: Uint8Array[];
  /** Signed per-edge exchange flow from the LAST EXECUTED step, per scalar
   *  (positive = a→b). Derived observability for the layer above (grand-dream
   *  day-boundary coupling reads population flows here); zeroed and refilled
   *  by every stepWorld call, so after a fast-forward rest-jump it reflects
   *  the last step that actually ran. Not serialized. */
  lastFlow: Record<string, Float64Array>;
  /** Steady-state flow networks by FlowNetSpec id. Derived; not serialized. */
  flowNet: Record<string, FlowNetState>;
  /** TOMBSTONE mask (civilization-emergence.md §2b): a disabled entity is
   *  ABSENT from every dynamic — rules, timers, exchanges, conflicts,
   *  processes, flow nets (its incident edges carry nothing; it forms no
   *  component) — while its arrays stay index-aligned (timers and layers
   *  above key by index, so removal-by-splice is a landmine). Set via
   *  setEntityDisabled, a day-boundary structural event like addEntity. */
  disabled: Uint8Array;
}

// --- Compiled lookups ---------------------------------------------------------

interface RuleMeta { external: boolean; isTimer: boolean; timer: number; }
interface WorldCompiled {
  entityVars: Map<string, VarSpec>;
  entityStages: Map<string, StageSpec>;
  edgeVars: Map<string, VarSpec>;
  clocks: Map<string, ClockSpec>;
  clockBoundaries: Map<string, number[]>;
  entityRules: RuleMeta[];
  edgeRules: RuleMeta[];
}

const cache = new WeakMap<WorldSpec, WorldCompiled>();

function ruleMeta(rules: { trigger: unknown; external?: boolean }[]): RuleMeta[] {
  return rules.map(r => ({
    external: !!r.external,
    isTimer: typeof r.trigger === 'object' && r.trigger !== null && 'timer' in r.trigger,
    timer: typeof r.trigger === 'object' && r.trigger !== null && 'timer' in r.trigger
      ? Math.max(1, Math.round((r.trigger as { timer: number }).timer)) : 0,
  }));
}

function compile(spec: WorldSpec): WorldCompiled {
  const hit = cache.get(spec);
  if (hit) return hit;
  const entityVars = new Map((spec.entity.vars ?? []).map(v => [v.name, v]));
  const entityStages = new Map((spec.entity.states ?? []).map(s => [s.name, s]));
  const edgeVars = new Map((spec.edge?.vars ?? []).map(v => [v.name, v]));
  const clocks = new Map((spec.clocks ?? []).map(c => [c.name, c]));
  // Reuse the shared clock-boundary scan over all rules.
  const cb = clockBoundaries({ id: spec.id, clocks: spec.clocks, rules: [...spec.entity.rules, ...(spec.edge?.rules ?? [])] });
  const c: WorldCompiled = {
    entityVars, entityStages, edgeVars, clocks, clockBoundaries: cb,
    entityRules: ruleMeta(spec.entity.rules),
    edgeRules: ruleMeta(spec.edge?.rules ?? []),
  };
  cache.set(spec, c);
  return c;
}

// --- Construction -------------------------------------------------------------

export function createWorld(spec: WorldSpec, n: number, edges: [number, number][]): EntityWorld {
  const scalars: Record<string, Float64Array> = {};
  for (const v of spec.entity.vars ?? []) scalars[v.name] = new Float64Array(n).fill(clamp(v, v.initial));
  const stageIdx: Record<string, Uint8Array> = {};
  for (const s of spec.entity.states ?? []) stageIdx[s.name] = new Uint8Array(n).fill(Math.max(0, s.stages.indexOf(s.initial)));
  const edgeList = edges.map(([a, b]) => ({ a, b }));
  const edgeAttr: Record<string, Float64Array> = {};
  for (const v of spec.edge?.vars ?? []) edgeAttr[v.name] = new Float64Array(edgeList.length).fill(clamp(v, v.initial));
  const adj: number[][] = Array.from({ length: n }, () => []);
  edgeList.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  const pos = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pos[2 * i] = Math.cos(a); pos[2 * i + 1] = Math.sin(a); }
  const clockPhase: Record<string, number> = {};
  for (const c of spec.clocks ?? []) clockPhase[c.name] = ((c.phase ?? 0) % c.period + c.period) % c.period;
  return {
    spec, n, scalars, stageIdx, pos, edges: edgeList, edgeAttr, adj, clockPhase, clock: 0,
    armedEntity: spec.entity.rules.map(() => new Map()),
    lastGuardEntity: spec.entity.rules.map(() => new Uint8Array(n)),
    armedEdge: (spec.edge?.rules ?? []).map(() => new Map()),
    lastGuardEdge: (spec.edge?.rules ?? []).map(() => new Uint8Array(edgeList.length)),
    lastFlow: {},
    flowNet: initFlowNets(spec, n, edgeList.length),
    disabled: new Uint8Array(n),
  };
}

function clamp(v: VarSpec, x: number): number { return Math.max(v.min, Math.min(v.max, x)); }

function initFlowNets(spec: WorldSpec, n: number, edgeCount: number): Record<string, FlowNetState> {
  const out: Record<string, FlowNetState> = {};
  for (const fn of spec.flownets ?? []) {
    out[fn.id] = {
      flows: new Float64Array(edgeCount),
      residual: new Float64Array(n),
      satisfied: new Float64Array(n),
      potential: new Float64Array(n),
      fingerprint: '', // ≠ any real fingerprint → solved on the first step
      recomputes: 0,
    };
  }
  return out;
}

// --- Views --------------------------------------------------------------------

function entityView(world: EntityWorld, comp: WorldCompiled): CellView & { i: number } {
  return {
    i: 0,
    scalar(name) { return world.scalars[name] ? world.scalars[name][this.i] : 0; },
    clockNorm(name) { return (world.clockPhase[name] ?? 0) / (comp.clocks.get(name)?.period ?? 1); },
    sensor() { return 0; },
    stage(name) { const s = comp.entityStages.get(name); return s ? s.stages[world.stageIdx[name][this.i]] : ''; },
    stageRank(state, value) { return comp.entityStages.get(state)?.stages.indexOf(value) ?? -1; },
  };
}

function edgeView(world: EntityWorld, comp: WorldCompiled): CellView & { e: number } {
  return {
    e: 0,
    scalar(name) { return world.edgeAttr[name] ? world.edgeAttr[name][this.e] : 0; },
    clockNorm(name) { return (world.clockPhase[name] ?? 0) / (comp.clocks.get(name)?.period ?? 1); },
    sensor() { return 0; },
    stage() { return ''; },
    stageRank() { return -1; },
    endpoints(attr, agg) {
      const ed = world.edges[this.e];
      const arr = world.scalars[attr];
      if (!arr) return 0;
      const va = arr[ed.a], vb = arr[ed.b];
      switch (agg) {
        case 'sum': return va + vb;
        case 'min': return Math.min(va, vb);
        case 'max': return Math.max(va, vb);
        case 'mean': return (va + vb) / 2;
        case 'absdiff': return Math.abs(va - vb);
      }
    },
  };
}

// --- Stepping -----------------------------------------------------------------

function add(buf: Map<string, Map<number, number>>, key: string, i: number, dv: number): void {
  let m = buf.get(key);
  if (!m) { m = new Map(); buf.set(key, m); }
  m.set(i, (m.get(i) ?? 0) + dv);
}

/** Advance one world step. Returns whether anything changed (so fast-forward
 *  knows when the world is at rest). */
export function stepWorld(world: EntityWorld): boolean {
  const comp = compile(world.spec);
  const { spec } = world;
  world.clock += 1;
  for (const c of spec.clocks ?? []) world.clockPhase[c.name] = (world.clockPhase[c.name] + 1) % c.period;

  const ev = entityView(world, comp);
  const xv = edgeView(world, comp);
  const entOwn = new Map<string, Map<number, number>>();   // rules + conflict costs (dissipative; snappable)
  const entTrans = new Map<string, Map<number, number>>(); // exchange (conservative; source-snapped)
  const edgeOwn = new Map<string, Map<number, number>>();
  const entStage: { i: number; state: string; to: number }[] = [];
  let changed = false;

  // 1. Per-entity rules (own effects + timers). Disabled entities are
  //    ABSENT: no guards, no timers (setEntityDisabled cleared armed ones).
  for (let i = 0; i < world.n; i++) {
    if (world.disabled[i]) continue;
    ev.i = i;
    spec.entity.rules.forEach((r, k) => {
      const m = comp.entityRules[k];
      if (m.external) return;
      const g = evalCond(ev, r.when);
      if (m.isTimer) {
        if (g && !world.lastGuardEntity[k][i] && !world.armedEntity[k].has(i)) world.armedEntity[k].set(i, world.clock + m.timer);
        else if (!g) world.armedEntity[k].delete(i);
        world.lastGuardEntity[k][i] = g ? 1 : 0;
        return;
      }
      world.lastGuardEntity[k][i] = g ? 1 : 0;
      if (g) applyEntityEffects(ev, comp, r.effects, i, entOwn, entStage);
    });
    // fire due entity timers
    spec.entity.rules.forEach((r, k) => {
      if (!comp.entityRules[k].isTimer) return;
      const fa = world.armedEntity[k].get(i);
      if (fa === undefined || fa > world.clock) return;
      world.armedEntity[k].delete(i);
      if (evalCond(ev, r.when)) applyEntityEffects(ev, comp, r.effects, i, entOwn, entStage);
    });
  }

  // 2. Per-edge rules (own effects on edge attrs + timers). An edge with a
  //    tombstoned endpoint is inert (its attrs freeze; road decay — a
  //    ROADS-mechanism write, not an edge rule — still fades it below).
  for (let e = 0; e < world.edges.length; e++) {
    if (world.disabled[world.edges[e].a] || world.disabled[world.edges[e].b]) continue;
    xv.e = e;
    (spec.edge?.rules ?? []).forEach((r, k) => {
      const m = comp.edgeRules[k];
      if (m.external) return;
      const g = evalCond(xv, r.when);
      if (m.isTimer) {
        if (g && !world.lastGuardEdge[k][e] && !world.armedEdge[k].has(e)) world.armedEdge[k].set(e, world.clock + m.timer);
        else if (!g) world.armedEdge[k].delete(e);
        world.lastGuardEdge[k][e] = g ? 1 : 0;
        return;
      }
      world.lastGuardEdge[k][e] = g ? 1 : 0;
      if (g) applyEdgeEffects(xv, r.effects, e, edgeOwn);
    });
    (spec.edge?.rules ?? []).forEach((r, k) => {
      if (!comp.edgeRules[k].isTimer) return;
      const fa = world.armedEdge[k].get(e);
      if (fa === undefined || fa > world.clock) return;
      world.armedEdge[k].delete(e);
      if (evalCond(xv, r.when)) applyEdgeEffects(xv, r.effects, e, edgeOwn);
    });
  }

  // 3. EXCHANGE — conservative diffusion of entity scalars along edges. The
  //    per-edge |flow| is recorded so roads can grow where trade actually
  //    happens; the SIGNED flow (a→b positive) is published on world.lastFlow
  //    for the layer above (day-boundary coupling).
  const flow = new Map<string, Float64Array>();
  for (const ex of spec.exchanges ?? []) {
    const arr = world.scalars[ex.scalar];
    if (!arr) continue;
    const byArr = ex.by ? world.edgeAttr[ex.by] : null;
    let fl = flow.get(ex.scalar);
    let signed = world.lastFlow[ex.scalar];
    if (!signed || signed.length !== world.edges.length) {
      signed = new Float64Array(world.edges.length);
      world.lastFlow[ex.scalar] = signed;
    }
    if (!fl) { fl = new Float64Array(world.edges.length); flow.set(ex.scalar, fl); signed.fill(0); }
    for (let e = 0; e < world.edges.length; e++) {
      const { a, b } = world.edges[e];
      if (world.disabled[a] || world.disabled[b]) continue; // no trade with a ruin
      const deg = Math.max(world.adj[a].length, world.adj[b].length);
      const rate = Math.min(ex.rate * (byArr ? byArr[e] : 1), 1 / (deg + 1)); // no-overshoot bound
      if (rate <= 0) continue;
      const move = rate * (arr[a] - arr[b]);
      if (Math.abs(move) < SNAP_EPS) continue; // whole-exchange snap → conserves + reaches exact rest
      add(entTrans, ex.scalar, a, -move);
      add(entTrans, ex.scalar, b, move);
      fl[e] += Math.abs(move);
      signed[e] += move;
    }
  }

  // 3a′. PROCESSES — the Leontief production function (world-content.md §3a):
  //     output := min(input × efficiency, capacity), written as a DERIVED
  //     value each step. Pure function of bounded inputs — no dynamics of
  //     its own. Runs BEFORE flow nets so extraction feeds this step's
  //     nets; a process reading a net's `satisfied` sees LAST step's value
  //     (one settle-step per chain stage, by design). Multi-reagent form
  //     (§3d): min across ALL inputs — the scarcest reagent binds.
  for (const pr of spec.processes ?? []) {
    const outArr = world.scalars[pr.output];
    const v = comp.entityVars.get(pr.output);
    if (!outArr || !v) continue;
    const reagents = pr.inputs
      ? pr.inputs.map(r => ({ arr: world.scalars[r.scalar], eff: r.efficiency }))
      : pr.input !== undefined
        ? [{ arr: world.scalars[pr.input], eff: pr.efficiency ?? 1 }]
        : [];
    if (reagents.length === 0 || reagents.some(r => !r.arr)) continue;
    const capArr = pr.capacityBy ? world.scalars[pr.capacityBy] : null;
    const capRate = pr.capacityRate ?? 1;
    for (let i = 0; i < world.n; i++) {
      if (world.disabled[i]) continue; // a ruin produces nothing
      let out = Infinity;
      for (const r of reagents) out = Math.min(out, r.arr![i] * r.eff);
      if (capArr) out = Math.min(out, capArr[i] * capRate);
      out = clamp(v, out);
      if (out !== outArr[i]) { outArr[i] = out; changed = true; }
    }
  }

  // 3a″. SUMS — fan-in relays (§3d): output := Σ scale × term, clamped.
  //     After processes (a sum of this step's draws is this step's net
  //     demand), before flow nets. Derived, combinational.
  for (const sm of spec.sums ?? []) {
    const outArr = world.scalars[sm.output];
    const v = comp.entityVars.get(sm.output);
    if (!outArr || !v) continue;
    const terms = sm.terms.map(t => ({ arr: world.scalars[t.scalar], scale: t.scale ?? 1 }));
    if (terms.some(t => !t.arr)) continue;
    for (let i = 0; i < world.n; i++) {
      if (world.disabled[i]) continue;
      let out = 0;
      for (const t of terms) out += t.arr![i] * t.scale;
      out = clamp(v, out);
      if (out !== outArr[i]) { outArr[i] = out; changed = true; }
    }
  }

  // 3a. FLOW NETWORKS — the steady-state economy (§4c). The edge flow field
  //     is DERIVED: solved only when its inputs (source, demand, conductance)
  //     changed since the last solve, constant otherwise — zero marginal cost
  //     in a settled world, which is what lets a resting world still "move".
  //     Only the per-component imbalance acts on state, as a uniform drift
  //     routed through the ordinary own-delta pipeline (clamped ⇒ settles).
  for (const fn of spec.flownets ?? []) {
    const st = world.flowNet[fn.id];
    const src = world.scalars[fn.source];
    const dem = world.scalars[fn.demand];
    if (!st || !src || !dem) continue;
    const byArr = fn.by ? world.edgeAttr[fn.by] : null;
    let fp = '';
    for (let i = 0; i < world.n; i++) fp += src[i] + ',' + dem[i] + ',' + world.disabled[i] + ';';
    if (byArr) for (let e = 0; e < world.edges.length; e++) fp += byArr[e] + ';';
    if (fp !== st.fingerprint) {
      solveFlowNet(world, st, src, dem, byArr);
      st.fingerprint = fp;
      st.recomputes++;
    }
    if (fn.drift) {
      for (let i = 0; i < world.n; i++) {
        if (st.residual[i] !== 0) add(entOwn, fn.drift, i, st.residual[i]);
      }
    }
    // Demand met, written as a derived value (the chaining output).
    if (fn.satisfied) {
      const satArr = world.scalars[fn.satisfied];
      const sv = comp.entityVars.get(fn.satisfied);
      if (satArr && sv) {
        for (let i = 0; i < world.n; i++) {
          const val = clamp(sv, st.satisfied[i]);
          if (val !== satArr[i]) { satArr[i] = val; changed = true; }
        }
      }
    }
  }

  // 3a‴. ALLOCATES — fan-out relays (§3d): divide this step's deliveries
  //     across consumers in PRIORITY ORDER, conserving (Σ shares ≤
  //     source). After flow nets (they read satisfied); consumers see
  //     their share next step — one settle-step per chain stage, as ever.
  for (const al of spec.allocates ?? []) {
    const srcArr = world.scalars[al.source];
    if (!srcArr) continue;
    const shares = al.shares.map(s => ({
      outArr: world.scalars[s.output],
      v: comp.entityVars.get(s.output),
      demArr: world.scalars[s.demand],
    }));
    if (shares.some(s => !s.outArr || !s.v || !s.demArr)) continue;
    for (let i = 0; i < world.n; i++) {
      if (world.disabled[i]) continue;
      let remaining = srcArr[i];
      for (const s of shares) {
        const give = clamp(s.v!, Math.max(0, Math.min(s.demArr![i], remaining)));
        remaining -= give;
        if (give !== s.outArr![i]) { s.outArr![i] = give; changed = true; }
      }
    }
  }

  // 3b. ROADS — desire paths: an edge attr grows with the trade |flow| through it
  //     (bounded source) and decays when unused (dissipative) ⇒ settles. `use`
  //     may name an exchange scalar or a flow net: caravans wear in roads too.
  for (const rd of spec.roads ?? []) {
    const fl = flow.get(rd.use);
    const fnState = world.flowNet[rd.use];
    for (let e = 0; e < world.edges.length; e++) {
      const used = (fl ? fl[e] : 0) + (fnState ? Math.abs(fnState.flows[e]) : 0);
      add(edgeOwn, rd.attr, e, used * rd.rate - rd.decay);
    }
  }

  // 4. CONFLICT — dissipative spend driven by an edge attribute; the driver decays.
  for (const cf of spec.conflicts ?? []) {
    const byArr = world.edgeAttr[cf.by];
    if (!byArr) continue;
    const thr = cf.threshold ?? 0;
    for (let e = 0; e < world.edges.length; e++) {
      if (byArr[e] <= thr) continue;
      const { a, b } = world.edges[e];
      if (world.disabled[a] || world.disabled[b]) continue; // no war with a ruin
      for (const c of cf.cost) { add(entOwn, c.scalar, a, c.amount); add(entOwn, c.scalar, b, c.amount); }
      if (cf.decay) add(edgeOwn, cf.by, e, -cf.decay);
    }
  }

  // 5. Commit. Own deltas snap to rest when negligible AND no transport on that
  //    cell (snapping a transported cell would break conservation). Transport is
  //    already source-snapped, so it only ever clamps here. (`changed` was
  //    hoisted — processes and satisfied-writes above also set it.)
  const scalarNames = new Set<string>([...entOwn.keys(), ...entTrans.keys()]);
  for (const name of scalarNames) {
    const v = comp.entityVars.get(name); if (!v) continue;
    const arr = world.scalars[name];
    const own = entOwn.get(name), trans = entTrans.get(name);
    const cells = new Set<number>([...(own?.keys() ?? []), ...(trans?.keys() ?? [])]);
    for (const i of cells) {
      const o = own?.get(i) ?? 0, tr = trans?.get(i) ?? 0;
      const before = arr[i];
      let next = clamp(v, before + o + tr);
      if (tr === 0 && Math.abs(next - before) < SNAP_EPS) next = before; // pure-own negligible → exact rest
      if (next !== before) { arr[i] = next; changed = true; }
    }
  }
  for (const [name, m] of edgeOwn) {
    const v = comp.edgeVars.get(name); if (!v) continue;
    const arr = world.edgeAttr[name];
    for (const [e, dv] of m) {
      const before = arr[e];
      let next = clamp(v, before + dv);
      if (Math.abs(next - before) < SNAP_EPS) next = before;
      if (next !== before) { arr[e] = next; changed = true; }
    }
  }
  for (const { i, state, to } of entStage) {
    if (to > world.stageIdx[state][i]) { world.stageIdx[state][i] = to; changed = true; }
  }
  return changed;
}

function applyEntityEffects(
  view: CellView, comp: WorldCompiled, effects: WorldSpec['entity']['rules'][number]['effects'],
  i: number, own: Map<string, Map<number, number>>, stages: { i: number; state: string; to: number }[],
): void {
  for (const e of effects) {
    const d = ownEffectDelta(view, e);
    if (!d) continue; // transport effects aren't valid on entities
    if (d.kind === 'scalar') add(own, d.scalar, i, d.delta);
    else { const st = comp.entityStages.get(d.state); if (st) stages.push({ i, state: d.state, to: st.stages.indexOf(d.to) }); }
  }
}

function applyEdgeEffects(view: CellView, effects: WorldSpec['entity']['rules'][number]['effects'], e: number, own: Map<string, Map<number, number>>): void {
  for (const eff of effects) {
    const d = ownEffectDelta(view, eff);
    if (d && d.kind === 'scalar') add(own, d.scalar, e, d.delta); // edges have no stages
  }
}

// --- Steady-state flow solver (§4c) --------------------------------------------

/**
 * Solve one flow network for its steady state: with net supply
 * s_i = source_i − demand_i and edge conductances c_e, find potentials φ
 * with L·φ = s̃ (L = conductance-weighted graph Laplacian, s̃ = s minus its
 * per-component mean, so each component's system is consistent) and read
 * off flows f_e = c_e·(φ_a − φ_b). This is the electrical-network flow:
 * supply spreads over ALL paths in proportion to conductance (steepest-
 * descent routing can't do multi-source/multi-sink — §10 resolved).
 *
 * Deterministic Gauss–Seidel relaxation: fixed sweep order, fixed
 * tolerance, one node per component pinned to φ=0 (kills the constant
 * null-space). L is an M-matrix ⇒ GS converges; entity graphs are tiny and
 * recomputes are rare, so cost is irrelevant — determinism is the
 * constraint. The removed mean IS the residual: each entity's uniform
 * share of its component's overproduction (+) or shortage (−).
 */
function solveFlowNet(
  world: EntityWorld,
  st: FlowNetState,
  src: Float64Array,
  dem: Float64Array,
  byArr: Float64Array | null,
): void {
  const n = world.n;
  const edges = world.edges;
  const m = edges.length;

  const cond = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    // A tombstoned endpoint severs the edge — the ruin joins no component.
    if (world.disabled[edges[e].a] || world.disabled[edges[e].b]) { cond[e] = 0; continue; }
    const c = byArr ? byArr[e] : 1;
    cond[e] = c > 0 ? c : 0;
  }

  // Connected components over conductive edges (deterministic BFS by index).
  const comp = new Int32Array(n).fill(-1);
  let nComp = 0;
  const queue: number[] = [];
  for (let root = 0; root < n; root++) {
    if (comp[root] !== -1) continue;
    comp[root] = nComp;
    queue.length = 0;
    queue.push(root);
    while (queue.length > 0) {
      const i = queue.shift()!;
      for (const e of world.adj[i]) {
        if (cond[e] <= 0) continue;
        const other = edges[e].a === i ? edges[e].b : edges[e].a;
        if (comp[other] === -1) { comp[other] = nComp; queue.push(other); }
      }
    }
    nComp++;
  }

  // Per-component mean supply → the uniform residual drift.
  const sum = new Float64Array(nComp);
  const cnt = new Int32Array(nComp);
  for (let i = 0; i < n; i++) { sum[comp[i]] += src[i] - dem[i]; cnt[comp[i]]++; }
  const pinned = new Int32Array(nComp).fill(-1); // first node of each component
  for (let i = 0; i < n; i++) if (pinned[comp[i]] === -1) pinned[comp[i]] = i;

  const sTil = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // A disabled entity is absent outright: no supply, no demand, no drift
    // share — regardless of what its (normally zeroed) scalars say.
    if (world.disabled[i]) { sTil[i] = 0; st.residual[i] = 0; continue; }
    const mean = sum[comp[i]] / cnt[comp[i]];
    sTil[i] = src[i] - dem[i] - mean;
    st.residual[i] = mean;
  }

  // Proportional fill per component: how much of each entity's demand the
  // network actually meets (the `satisfied` chaining output).
  const supplyTot = new Float64Array(nComp);
  const demandTot = new Float64Array(nComp);
  for (let i = 0; i < n; i++) {
    if (world.disabled[i]) continue;
    supplyTot[comp[i]] += src[i];
    demandTot[comp[i]] += dem[i];
  }
  for (let i = 0; i < n; i++) {
    if (world.disabled[i]) { st.satisfied[i] = 0; continue; }
    const dT = demandTot[comp[i]];
    const fill = dT > 0 ? Math.min(1, supplyTot[comp[i]] / dT) : 0;
    st.satisfied[i] = dem[i] * fill;
  }

  // Gauss–Seidel sweeps on L·φ = s̃.
  const phi = st.potential;
  phi.fill(0);
  const wsum = new Float64Array(n);
  for (let i = 0; i < n; i++) for (const e of world.adj[i]) wsum[i] += cond[e];
  for (let iter = 0; iter < 20_000; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      if (wsum[i] === 0 || pinned[comp[i]] === i) continue;
      let acc = sTil[i];
      for (const e of world.adj[i]) {
        if (cond[e] <= 0) continue;
        const other = edges[e].a === i ? edges[e].b : edges[e].a;
        acc += cond[e] * phi[other];
      }
      const next = acc / wsum[i];
      const d = Math.abs(next - phi[i]);
      if (d > maxDelta) maxDelta = d;
      phi[i] = next;
    }
    if (maxDelta < 1e-12) break;
  }

  for (let e = 0; e < m; e++) {
    st.flows[e] = cond[e] > 0 ? cond[e] * (phi[edges[e].a] - phi[edges[e].b]) : 0;
  }
}

// --- Fast-forward (rest-jump + period folding) --------------------------------

function advanceClocks(world: EntityWorld, target: number): void {
  const d = target - world.clock;
  if (d <= 0) return;
  for (const c of world.spec.clocks ?? []) world.clockPhase[c.name] = (world.clockPhase[c.name] + d) % c.period;
  world.clock = target;
}

function fingerprint(world: EntityWorld): string {
  const p: (string | number)[] = [];
  for (const c of world.spec.clocks ?? []) p.push(world.clockPhase[c.name]);
  for (const v of world.spec.entity.vars ?? []) { const a = world.scalars[v.name]; for (let i = 0; i < a.length; i++) p.push(a[i]); }
  for (const s of world.spec.entity.states ?? []) { const a = world.stageIdx[s.name]; for (let i = 0; i < a.length; i++) p.push(a[i]); }
  for (const v of world.spec.edge?.vars ?? []) { const a = world.edgeAttr[v.name]; for (let i = 0; i < a.length; i++) p.push(a[i]); }
  const armed = (label: string, maps: Array<Map<number, number>>) => {
    for (let r = 0; r < maps.length; r++) { const m = maps[r]; if (!m.size) continue; const e = [...m].sort((a, b) => a[0] - b[0]); p.push(label, r); for (const [k, fa] of e) p.push(k, fa - world.clock); }
  };
  armed('ae', world.armedEntity); armed('xe', world.armedEdge);
  return p.join('|');
}

function shiftBy(world: EntityWorld, skip: number): void {
  world.clock += skip;
  for (const maps of [world.armedEntity, world.armedEdge]) for (const m of maps) for (const [k, fa] of [...m]) m.set(k, fa + skip);
}

/** Soonest strictly-future armed-timer fire across all rules, or -1. */
function nextArmed(world: EntityWorld): number {
  let best = -1;
  for (const maps of [world.armedEntity, world.armedEdge]) for (const m of maps) for (const fa of m.values()) if (best < 0 || fa < best) best = fa;
  return best;
}

/** Advance `steps`, jumping idle stretches and folding exact cycles — identical
 *  in result to stepping that many times. */
export function worldFastForward(world: EntityWorld, steps: number): void {
  const comp = compile(world.spec);
  const end = world.clock + Math.max(0, Math.floor(steps));
  let seen: Map<string, number> | null = (end - world.clock) > FOLD_MIN ? new Map() : null;
  let active = true; // unknown → step once first
  let guard = 0;
  while (world.clock < end && guard++ < MAX_WORLD_CATCHUP) {
    if (active) {
      active = stepWorld(world);
      if (seen && active) {
        const key = fingerprint(world);
        const prev = seen.get(key);
        if (prev !== undefined) {
          const P = world.clock - prev;
          const remaining = end - world.clock;
          const skip = remaining - (remaining % P);
          if (skip > 0) shiftBy(world, skip);
          seen = null;
        } else { seen.set(key, world.clock); if (seen.size > FOLD_DETECT_CAP) seen = null; }
      }
      continue;
    }
    // At rest: jump to the next event (armed timer or clock boundary) or to the end.
    let next = end;
    const na = nextArmed(world); if (na >= 0 && na < next) next = na;
    const ce = nextClockBoundaryStep(world.clock, end, comp.clockBoundaries, clk => comp.clocks.get(clk)!.period, clk => world.clockPhase[clk]);
    if (ce >= 0 && ce < next) next = ce;
    if (next >= end) { advanceClocks(world, end); break; }
    advanceClocks(world, next - 1);
    active = stepWorld(world);
  }
}

// --- Dynamic roster (world-content.md gate 5: the founding transaction) --------

export interface AddEntityOpts {
  x?: number;
  y?: number;
  /** Initial values for entity scalars (others take the var's `initial`). */
  scalars?: Record<string, number>;
  /** Initial stages (others take the state's `initial`). */
  stages?: Record<string, string>;
  /** Edges to existing entities, with optional initial edge attrs. */
  edges?: Array<{ to: number; attrs?: Record<string, number> }>;
}

/**
 * Add an entity mid-run — a DAY-BOUNDARY structural event (founding a
 * settlement). Grows every per-entity array; armed timers keep their
 * entity-index keys (existing indices are untouched); flow nets reset to
 * an empty fingerprint so the next step re-solves over the new topology
 * (it changed, so a re-solve was due regardless). Deterministic. Returns
 * the new entity's index.
 */
export function addEntity(world: EntityWorld, opts: AddEntityOpts = {}): number {
  const spec = world.spec;
  const i = world.n;

  for (const v of spec.entity.vars ?? []) {
    const next = new Float64Array(i + 1);
    next.set(world.scalars[v.name]);
    next[i] = clamp(v, opts.scalars?.[v.name] ?? v.initial);
    world.scalars[v.name] = next;
  }
  for (const s of spec.entity.states ?? []) {
    const next = new Uint8Array(i + 1);
    next.set(world.stageIdx[s.name]);
    const want = opts.stages?.[s.name] ?? s.initial;
    next[i] = Math.max(0, s.stages.indexOf(want));
    world.stageIdx[s.name] = next;
  }
  const pos = new Float64Array(2 * (i + 1));
  pos.set(world.pos);
  pos[2 * i] = opts.x ?? 0;
  pos[2 * i + 1] = opts.y ?? 0;
  world.pos = pos;
  world.adj.push([]);
  world.lastGuardEntity = world.lastGuardEntity.map(a => {
    const next = new Uint8Array(i + 1);
    next.set(a);
    return next;
  });
  const disabled = new Uint8Array(i + 1);
  disabled.set(world.disabled);
  world.disabled = disabled;
  world.n = i + 1;

  for (const e of opts.edges ?? []) addEdge(world, i, e.to, e.attrs);
  // addEdge already reset the derived nets; reset again covers the
  // zero-edge founding too.
  world.flowNet = initFlowNets(spec, world.n, world.edges.length);
  world.lastFlow = {};
  return i;
}

/**
 * TOMBSTONE an entity mid-run — the structural half of the absorb
 * transaction (civilization-emergence.md §2b), the mirror of addEntity:
 * a day-boundary event, deterministic, index-preserving. The entity
 * becomes ABSENT from every dynamic (rules, timers, exchanges, conflicts,
 * processes, flow-net components); its incident edges carry nothing and
 * their rules freeze. Its armed timers are dropped and guard edges reset
 * so nothing fires posthumously. Derived nets reset for a re-solve over
 * the severed topology. The CALLER zeroes whatever scalars should read as
 * abandoned (population, production, stock) — the engine only guarantees
 * absence from dynamics, not what the ruin's frozen values display.
 */
export function setEntityDisabled(world: EntityWorld, i: number): void {
  if (i < 0 || i >= world.n) throw new Error(`setEntityDisabled: bad entity ${i}`);
  if (world.disabled[i]) return;
  world.disabled[i] = 1;
  for (let k = 0; k < world.armedEntity.length; k++) {
    world.armedEntity[k].delete(i);
    world.lastGuardEntity[k][i] = 0;
  }
  for (const e of world.adj[i]) {
    for (let k = 0; k < world.armedEdge.length; k++) {
      world.armedEdge[k].delete(e);
      world.lastGuardEdge[k][e] = 0;
    }
  }
  world.flowNet = initFlowNets(world.spec, world.n, world.edges.length);
  world.lastFlow = {};
}

/**
 * Add an edge mid-run (a new route between settlements). Same discipline
 * as addEntity: day-boundary only, derived nets reset for re-solve.
 * Returns the new edge's index.
 */
export function addEdge(world: EntityWorld, a: number, b: number, attrs?: Record<string, number>): number {
  if (a === b || a < 0 || b < 0 || a >= world.n || b >= world.n) {
    throw new Error(`addEdge: bad endpoints ${a}–${b}`);
  }
  const e = world.edges.length;
  world.edges.push({ a, b });
  for (const v of world.spec.edge?.vars ?? []) {
    const next = new Float64Array(e + 1);
    next.set(world.edgeAttr[v.name]);
    next[e] = clamp(v, attrs?.[v.name] ?? v.initial);
    world.edgeAttr[v.name] = next;
  }
  world.adj[a].push(e);
  world.adj[b].push(e);
  world.lastGuardEdge = world.lastGuardEdge.map(arr => {
    const next = new Uint8Array(e + 1);
    next.set(arr);
    return next;
  });
  world.flowNet = initFlowNets(world.spec, world.n, world.edges.length);
  world.lastFlow = {};
  return e;
}

// --- External input + helpers -------------------------------------------------

export function injectEntity(world: EntityWorld, entity: number, scalar: string, amount: number): void {
  const arr = world.scalars[scalar];
  if (!arr) return;
  const v = compile(world.spec).entityVars.get(scalar);
  if (!v) return;
  arr[entity] = clamp(v, arr[entity] + amount);
}

export function injectEdge(world: EntityWorld, edge: number, attr: string, amount: number): void {
  const arr = world.edgeAttr[attr];
  if (!arr) return;
  const v = compile(world.spec).edgeVars.get(attr);
  if (!v) return;
  arr[edge] = clamp(v, arr[edge] + amount);
}

/** Sum of an entity scalar across the world — for conservation assertions. */
export function totalScalar(world: EntityWorld, scalar: string): number {
  const arr = world.scalars[scalar];
  if (!arr) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

// --- Serialization ------------------------------------------------------------

export function serializeWorld(world: EntityWorld): string {
  const scalars: Record<string, number[]> = {};
  for (const k in world.scalars) scalars[k] = Array.from(world.scalars[k]);
  const stageIdx: Record<string, number[]> = {};
  for (const k in world.stageIdx) stageIdx[k] = Array.from(world.stageIdx[k]);
  const edgeAttr: Record<string, number[]> = {};
  for (const k in world.edgeAttr) edgeAttr[k] = Array.from(world.edgeAttr[k]);
  return JSON.stringify({
    spec: world.spec, n: world.n, scalars, stageIdx, edgeAttr,
    edges: world.edges, pos: Array.from(world.pos), clockPhase: world.clockPhase, clock: world.clock,
    armedEntity: world.armedEntity.map(m => [...m]), armedEdge: world.armedEdge.map(m => [...m]),
    lastGuardEntity: world.lastGuardEntity.map(a => Array.from(a)), lastGuardEdge: world.lastGuardEdge.map(a => Array.from(a)),
    disabled: Array.from(world.disabled),
  });
}

export function deserializeWorld(json: string): EntityWorld | null {
  try {
    const p = JSON.parse(json);
    if (!p || !p.spec || !p.spec.entity) return null;
    const scalars: Record<string, Float64Array> = {};
    for (const k in p.scalars) scalars[k] = Float64Array.from(p.scalars[k]);
    const stageIdx: Record<string, Uint8Array> = {};
    for (const k in p.stageIdx) stageIdx[k] = Uint8Array.from(p.stageIdx[k]);
    const edgeAttr: Record<string, Float64Array> = {};
    for (const k in p.edgeAttr) edgeAttr[k] = Float64Array.from(p.edgeAttr[k]);
    const edges = p.edges as { a: number; b: number }[];
    const adj: number[][] = Array.from({ length: p.n }, () => []);
    edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
    return {
      spec: p.spec, n: p.n, scalars, stageIdx, edgeAttr, edges, adj,
      lastFlow: {},
      flowNet: initFlowNets(p.spec, p.n, edges.length),
      pos: Float64Array.from(p.pos ?? []), clockPhase: p.clockPhase ?? {}, clock: p.clock ?? 0,
      armedEntity: (p.armedEntity ?? []).map((e: [number, number][]) => new Map(e)),
      armedEdge: (p.armedEdge ?? []).map((e: [number, number][]) => new Map(e)),
      lastGuardEntity: (p.lastGuardEntity ?? []).map((a: number[]) => Uint8Array.from(a)),
      lastGuardEdge: (p.lastGuardEdge ?? []).map((a: number[]) => Uint8Array.from(a)),
      disabled: p.disabled ? Uint8Array.from(p.disabled) : new Uint8Array(p.n),
    };
  } catch {
    return null;
  }
}
