// Cell Systems — ENTITY/RELATIONSHIP checks (Step 3: the algebra on a graph).
// Run:  npx tsx games/sandbox-game/test/entities-checks.ts
//
// Guards that long-distance city interactions stay idle-safe: trade is a
// conservative diffusion that equalises + conserves; a whole civilization reaches
// rest (incl. randomized tuning); catch-up == stepping; and the validator allows a
// pairwise relationship cycle but REJECTS a 3-attribute one (the chaos boundary).

import assert from 'node:assert/strict';
import {
  createWorld, stepWorld, worldFastForward, totalScalar, injectEntity, injectEdge,
  addEntity, setEntityDisabled, serializeWorld, deserializeWorld, validateWorldSpec,
  type EntityWorld, type WorldSpec,
  civilization, riseAndFall, unstableCiv, tradeNetwork,
} from '../../../shared/engine/cells/index.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}
function makeRng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; }
const RING6: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 3]];
function stepUntilRest(w: EntityWorld, cap: number): number { for (let i = 1; i <= cap; i++) if (!stepWorld(w)) return i; return -1; }
const snap = (w: EntityWorld) => {
  const s: Record<string, number[]> = {}; for (const k in w.scalars) s[k] = Array.from(w.scalars[k]);
  const e: Record<string, number[]> = {}; for (const k in w.edgeAttr) e[k] = Array.from(w.edgeAttr[k]);
  return JSON.stringify({ s, e, c: w.clock });
};

console.log('Cell-systems ENTITY checks:');

// 1. The validator: pairwise relationship cycle OK (with warning); 3-attribute
//    loop REJECTED; the plain civilization is clean.
check('validator: civilization clean, 2-loop warns, 3-loop rejected', () => {
  const civ = validateWorldSpec(civilization);
  assert.ok(civ.ok, `civilization rejected: ${civ.errors.join('; ')}`);
  const rf = validateWorldSpec(riseAndFall);
  assert.ok(rf.ok, `riseAndFall rejected: ${rf.errors.join('; ')}`);
  assert.ok(rf.warnings.some(w => /2-attribute feedback loop/.test(w)), 'expected a 2-loop warning');
  const bad = validateWorldSpec(unstableCiv);
  assert.ok(!bad.ok && bad.errors.some(e => /couples 3 state attributes/.test(e)), `3-loop not rejected: ${bad.errors.join('; ')}`);
});

// 2. A whole civilization settles from a disturbed start (war + uneven wealth).
check('civilization reaches rest from a disturbed start', () => {
  const w = createWorld(civilization, 6, RING6);
  injectEntity(w, 0, 'wealth', 90);           // a rich city
  for (let e = 0; e < w.edges.length; e++) w.edgeAttr.hostility[e] = 1; // everyone at war
  const at = stepUntilRest(w, 5000);
  assert.ok(at > 0, 'civilization never settled');
  for (let i = 0; i < w.n; i++) assert.ok(Math.abs(w.scalars.population[i] - 80) < 0.5, `population off capacity at ${i}: ${w.scalars.population[i]}`);
  for (let e = 0; e < w.edges.length; e++) assert.ok(w.edgeAttr.hostility[e] < 0.5, 'hostility did not cool');
});

// 3. Trade is a conservative diffusion: goods equalise across the graph and the
//    total is conserved (the Lyapunov primitive, on a graph).
check('trade conserves goods and equalises across the graph', () => {
  const trade: WorldSpec = {
    id: 'trade',
    entity: { id: 'c', vars: [{ name: 'goods', min: 0, max: 1000, initial: 0 }], rules: [] },
    exchanges: [{ scalar: 'goods', rate: 0.2 }],
  };
  const w = createWorld(trade, 6, RING6);
  injectEntity(w, 0, 'goods', 120);
  const total0 = totalScalar(w, 'goods');
  const at = stepUntilRest(w, 5000);
  assert.ok(at > 0, 'trade never settled');
  assert.ok(Math.abs(totalScalar(w, 'goods') - total0) < 1e-6, 'goods not conserved');
  let lo = Infinity, hi = -Infinity;
  for (const v of w.scalars.goods) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(hi - lo < 0.05, `goods did not equalise (${lo}..${hi})`);
});

// 4. Catch-up == stepping for a civilization (settles → jump; fold path enabled).
check('world fast-forward equals step-by-step', () => {
  const N = 5000;
  const a = createWorld(civilization, 6, RING6);
  const b = createWorld(civilization, 6, RING6);
  for (let e = 0; e < a.edges.length; e++) { a.edgeAttr.hostility[e] = 1; b.edgeAttr.hostility[e] = 1; }
  injectEntity(a, 0, 'wealth', 90); injectEntity(b, 0, 'wealth', 90);
  for (let i = 0; i < N; i++) stepWorld(a);
  worldFastForward(b, N);
  assert.equal(snap(a), snap(b), 'world fast-forward diverged from stepping');
});

// 5. Save/reload mid-evolution continues identically.
check('world save/reload mid-evolution continues identically', () => {
  const N = 60;
  const live = createWorld(civilization, 6, RING6);
  const split = createWorld(civilization, 6, RING6);
  for (const w of [live, split]) for (let e = 0; e < w.edges.length; e++) w.edgeAttr.hostility[e] = 1;
  for (let i = 0; i < N; i++) stepWorld(live);
  for (let i = 0; i < N / 2; i++) stepWorld(split);
  const reloaded = deserializeWorld(serializeWorld(split));
  assert.ok(reloaded, 'reload failed');
  for (let i = 0; i < N / 2; i++) stepWorld(reloaded!);
  assert.equal(snap(reloaded!), snap(live), 'reloaded world diverged from the live one');
});

// 6. Termination under randomized tuning — structural safety, not tuning.
check('civilization settles for randomized parameters', () => {
  const rng = makeRng(7);
  for (let trial = 0; trial < 8; trial++) {
    const spec: WorldSpec = JSON.parse(JSON.stringify(civilization));
    (spec.entity.rules[0].effects[0] as any).toward.rate = 0.01 + 0.2 * rng();
    (spec.exchanges![0] as any).rate = 0.02 + 0.6 * rng();
    (spec.edge!.rules![0].effects[0] as any).add.amount = -(0.005 + 0.05 * rng());
    (spec.conflicts![0] as any).cost[0].amount = -(0.1 + rng());
    assert.ok(validateWorldSpec(spec).ok, `trial ${trial}: randomized civ rejected`);
    const w = createWorld(spec, 6, RING6);
    for (let e = 0; e < w.edges.length; e++) w.edgeAttr.hostility[e] = 1;
    injectEntity(w, 0, 'wealth', 90);
    assert.ok(stepUntilRest(w, 20000) > 0, `trial ${trial}: never settled`);
  }
});

// 7. Roads: busy trade routes wear into highways, idle ones stay dirt tracks —
//    and the network settles. Star: producer 0 feeds consumers 1,2,3; edge 1–2
//    (two consumers) carries little flow.
check('roads form on busy routes, fade on idle ones, and settle', () => {
  const star: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 2]];
  const w = createWorld(tradeNetwork, 4, star);
  w.scalars.production[0] = 80; // city 0 is the producer; 1,2,3 consume
  const at = stepUntilRest(w, 8000);
  assert.ok(at > 0, 'trade network never settled');
  const road = (i: number) => w.edgeAttr.road[i];
  const spokeAvg = (road(0) + road(1) + road(2)) / 3; // 0–1, 0–2, 0–3
  assert.ok(spokeAvg > 0.25, `busy spokes should grow past the dirt base (got ${spokeAvg.toFixed(3)})`);
  assert.ok(spokeAvg > road(3) + 0.05, `spokes should out-grow the idle 1–2 route (${spokeAvg.toFixed(3)} vs ${road(3).toFixed(3)})`);
});

// 8. The trade-network validates (with the expected road↔goods 2-loop warning).
check('trade network validates with a road↔goods 2-loop warning', () => {
  const r = validateWorldSpec(tradeNetwork);
  assert.ok(r.ok, `tradeNetwork rejected: ${r.errors.join('; ')}`);
  assert.ok(r.warnings.some(w => /2-attribute feedback loop/.test(w)), 'expected a road↔goods 2-loop warning');
});

// 9. Signed exchange flows are published per edge (a→b positive), match the
//    amount actually delivered, and re-zero once the network is at rest. This
//    is the observability surface the grand-dream day-boundary coupling reads.
check('lastFlow publishes signed per-edge exchange flow', () => {
  const trade: WorldSpec = {
    id: 'trade-flow',
    entity: { id: 'c', vars: [{ name: 'goods', min: 0, max: 1000, initial: 0 }], rules: [] },
    exchanges: [{ scalar: 'goods', rate: 0.2 }],
  };
  const w = createWorld(trade, 2, [[0, 1]]);
  injectEntity(w, 0, 'goods', 100);
  const before1 = w.scalars.goods[1];
  stepWorld(w);
  const gained = w.scalars.goods[1] - before1;
  const f = w.lastFlow.goods[0];
  assert.ok(f > 0, 'flow should be positive (0 → 1)');
  assert.ok(Math.abs(f - gained) < 1e-9, `flow ${f} should equal amount received ${gained}`);
  injectEntity(w, 1, 'goods', 500);
  stepWorld(w);
  assert.ok(w.lastFlow.goods[0] < 0, 'flow should be negative when b is richer');
  assert.ok(stepUntilRest(w, 5000) > 0, 'trade-flow never settled');
  assert.ok(Math.abs(w.lastFlow.goods[0]) < 1e-12, 'flow should re-zero at rest');
});

// --- Steady-state flow networks (grand-dream step 4) --------------------------

/** Line A—B—C: A produces, C consumes; `road` scales conductance. */
function flowSpec(opts: { source?: number; demand?: number; drift?: boolean } = {}): WorldSpec {
  const { source = 10, demand = 10, drift = false } = opts;
  return {
    id: 'flow-line',
    entity: {
      id: 'town',
      vars: [
        { name: 'production', min: 0, max: 100, initial: 0 },
        { name: 'consumption', min: 0, max: 100, initial: 0 },
        { name: 'stock', min: 0, max: 50, initial: 0 },
      ],
      rules: [],
    },
    edge: { vars: [{ name: 'road', min: 0, max: 4, initial: 1 }] },
    flownets: [{ id: 'trade', source: 'production', demand: 'consumption', by: 'road', ...(drift ? { drift: 'stock' } : {}) }],
  } as WorldSpec;
}
const LINE3: [number, number][] = [[0, 1], [1, 2]];

// 10. Balanced network: the solved flow carries the full supply along the
//     line, conserves at every node, and leaves zero residual drift.
check('flow net ships supply to demand and conserves', () => {
  const w = createWorld(flowSpec(), 3, LINE3);
  w.scalars.production[0] = 10;
  w.scalars.consumption[2] = 10;
  stepWorld(w);
  const st = w.flowNet.trade;
  assert.ok(Math.abs(st.flows[0] - 10) < 1e-6, `A→B should carry 10 (got ${st.flows[0]})`);
  assert.ok(Math.abs(st.flows[1] - 10) < 1e-6, `B→C should carry 10 (got ${st.flows[1]})`);
  // Node conservation: net outflow equals local supply at every node.
  const net = [st.flows[0], st.flows[1] - st.flows[0], -st.flows[1]];
  const supply = [10, 0, -10];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(net[i] - supply[i]) < 1e-6, `node ${i} not conserved`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(st.residual[i]) < 1e-9, `balanced net should have no drift at ${i}`);
});

// 11. Conductance steers the split: two parallel paths, 3:1 road strengths
//     ⇒ 3:1 flows (the electrical-network behavior steepest-descent can't do).
check('flow splits across parallel paths in proportion to conductance', () => {
  // A(0) —top(1)— B(3);  A —bottom(2)— B. Edges: [A,T],[T,B],[A,U],[U,B].
  const square: [number, number][] = [[0, 1], [1, 3], [0, 2], [2, 3]];
  const w = createWorld(flowSpec(), 4, square);
  w.scalars.production[0] = 8;
  w.scalars.consumption[3] = 8;
  w.edgeAttr.road[0] = 3; w.edgeAttr.road[1] = 3; // top path: strong road
  w.edgeAttr.road[2] = 1; w.edgeAttr.road[3] = 1; // bottom path: dirt track
  stepWorld(w);
  const st = w.flowNet.trade;
  assert.ok(Math.abs(st.flows[0] - 6) < 1e-6, `top path should carry 6 (got ${st.flows[0]})`);
  assert.ok(Math.abs(st.flows[2] - 2) < 1e-6, `bottom path should carry 2 (got ${st.flows[2]})`);
});

// 12. Recompute ONLY on input change: static inputs never re-solve; touching
//     the conductance re-solves once and reroutes.
check('flow field recomputes only when the network changes', () => {
  const w = createWorld(flowSpec(), 3, LINE3);
  w.scalars.production[0] = 10;
  w.scalars.consumption[2] = 10;
  for (let i = 0; i < 200; i++) stepWorld(w);
  assert.equal(w.flowNet.trade.recomputes, 1, 'static inputs must solve exactly once');
  injectEdge(w, 0, 'road', 1); // road A—B doubles
  stepWorld(w);
  assert.equal(w.flowNet.trade.recomputes, 2, 'conductance change must re-solve');
  for (let i = 0; i < 50; i++) stepWorld(w);
  assert.equal(w.flowNet.trade.recomputes, 2, 'and only once');
});

// 13. Imbalance becomes a uniform drift on the stockpile var — linear until
//     the clamp, then the world reaches exact rest (still fast-forwardable).
check('imbalance drifts stockpiles uniformly, then the world rests', () => {
  const w = createWorld(flowSpec({ drift: true }), 3, LINE3);
  w.scalars.production[0] = 12; // +12 in, −6 out ⇒ +2/step/node
  w.scalars.consumption[2] = 6;
  stepWorld(w);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(w.flowNet.trade.residual[i] - 2) < 1e-9, `residual should be +2 at ${i}`);
  const at = stepUntilRest(w, 5000);
  assert.ok(at > 0, 'drifting world never rested');
  for (let i = 0; i < 3; i++) assert.equal(w.scalars.stock[i], 50, `stock ${i} should sit at the clamp`);
  // Catch-up equality with the drift in play.
  const a = createWorld(flowSpec({ drift: true }), 3, LINE3);
  const b = createWorld(flowSpec({ drift: true }), 3, LINE3);
  for (const x of [a, b]) { x.scalars.production[0] = 12; x.scalars.consumption[2] = 6; }
  for (let i = 0; i < 300; i++) stepWorld(a);
  worldFastForward(b, 300);
  assert.equal(snap(a), snap(b), 'fast-forward diverged from stepping under drift');
});

// 14. Severed road: conductance 0 cuts the component in two — each half
//     drifts by its own local imbalance.
check('a severed edge splits the network into local economies', () => {
  const w = createWorld(flowSpec({ drift: true }), 3, LINE3);
  w.scalars.production[0] = 12;
  w.scalars.consumption[2] = 6;
  w.edgeAttr.road[1] = 0; // B—C severed
  stepWorld(w);
  const st = w.flowNet.trade;
  assert.equal(st.flows[1], 0, 'severed edge must carry nothing');
  // Component {A,B}: +12 over 2 nodes = +6 each. Component {C}: −6.
  assert.ok(Math.abs(st.residual[0] - 6) < 1e-9 && Math.abs(st.residual[1] - 6) < 1e-9, 'A/B drift +6');
  assert.ok(Math.abs(st.residual[2] + 6) < 1e-9, 'C drifts −6');
});

// 15. Validator: flow nets are checked at load, and their coupling joins the
//     feedback analysis.
check('validator checks flow nets', () => {
  const bad = flowSpec();
  (bad.flownets![0] as { source: string }).source = 'nope';
  const r = validateWorldSpec(bad);
  assert.ok(!r.ok && r.errors.some(e => /flow net "trade": source "nope"/.test(e)), 'unknown source not rejected');
  const good = validateWorldSpec(flowSpec({ drift: true }));
  assert.ok(good.ok, `flow spec rejected: ${good.errors.join('; ')}`);
});

// --- Processes + satisfied: the two-biome economy (world-content.md §3/§6) ----

/** Highland mine + lowland farm. Chains:
 *    farmland → grain_out → food_out ──food net──▶ food_got (≥ demand: fill 1)
 *    ore_access → ore_out ──ore net──▶ ore_got → metal_out ──metal net──▶ metal_got (shortage: proportional)
 *  Demands are THEMSELVES processes (population → food_need etc.), so the
 *  whole economy is data. */
function twoBiome(): WorldSpec {
  const v = (name: string, max: number, int = false): { name: string; min: number; max: number; initial: number; int?: boolean } =>
    ({ name, min: 0, max, initial: 0, ...(int ? { int: true } : {}) });
  return {
    id: 'two-biome',
    entity: {
      id: 'city',
      vars: [
        v('population', 50_000), v('farmland', 1000), v('ore_access', 1000),
        v('farms', 20, true), v('mines', 20, true), v('smelters', 20, true),
        v('grain_out', 100), v('food_out', 100), v('food_need', 100), v('food_got', 100),
        v('ore_out', 100), v('ore_need', 100), v('ore_got', 100),
        v('metal_out', 100), v('metal_need', 100), v('metal_got', 100),
      ],
      rules: [],
    },
    processes: [
      { id: 'farm', input: 'farmland', output: 'grain_out', efficiency: 0.05, capacityBy: 'farms', capacityRate: 5 },
      { id: 'mill', input: 'grain_out', output: 'food_out', efficiency: 1 },
      { id: 'eat', input: 'population', output: 'food_need', efficiency: 0.001 },
      { id: 'mine', input: 'ore_access', output: 'ore_out', efficiency: 0.005, capacityBy: 'mines', capacityRate: 4 },
      { id: 'furnace-draw', input: 'smelters', output: 'ore_need', efficiency: 8 },
      { id: 'smelt', input: 'ore_got', output: 'metal_out', efficiency: 0.9, capacityBy: 'smelters', capacityRate: 8 },
      { id: 'want-tools', input: 'population', output: 'metal_need', efficiency: 0.0002 },
    ],
    flownets: [
      { id: 'food', source: 'food_out', demand: 'food_need', satisfied: 'food_got' },
      { id: 'oreflow', source: 'ore_out', demand: 'ore_need', satisfied: 'ore_got' },
      { id: 'metal', source: 'metal_out', demand: 'metal_need', satisfied: 'metal_got' },
    ],
  };
}

// 16. The full economy: chains settle, surplus nets fill demand exactly,
//     shortage nets fill proportionally, and food & metal COUNTERFLOW on the
//     same edge — two biomes trading what the other lacks. Then it rests.
check('two-biome economy: chains, proportional fill, counterflow, rest', () => {
  const spec = twoBiome();
  const r = validateWorldSpec(spec);
  assert.ok(r.ok, `two-biome rejected: ${r.errors.join('; ')}`);

  const w = createWorld(spec, 2, [[0, 1]]); // 0 = lowland farm, 1 = highland mine
  injectEntity(w, 0, 'population', 20_000); injectEntity(w, 0, 'farmland', 900); injectEntity(w, 0, 'farms', 10);
  injectEntity(w, 1, 'population', 8_000); injectEntity(w, 1, 'ore_access', 600);
  injectEntity(w, 1, 'mines', 8); injectEntity(w, 1, 'smelters', 6);

  for (let i = 0; i < 12; i++) stepWorld(w); // chain depth + net lags
  const at = stepUntilRest(w, 200);
  assert.ok(at > 0, 'economy never settled');

  const s = w.scalars;
  // Extraction obeys min(input × eff, capacity).
  assert.ok(Math.abs(s.grain_out[0] - 45) < 1e-9, `grain ${s.grain_out[0]} ≠ min(900×0.05, 10×5)`);
  assert.ok(Math.abs(s.ore_out[1] - 3) < 1e-9, `ore ${s.ore_out[1]} ≠ min(600×0.005, 8×4)`);
  // Food: supply 45 ≥ demand 28 ⇒ everyone fully fed.
  assert.ok(Math.abs(s.food_got[0] - 20) < 1e-9 && Math.abs(s.food_got[1] - 8) < 1e-9, 'surplus net should fill demand exactly');
  // Ore: supply 3 « furnace draw 48 ⇒ proportional fill, all to the highland.
  assert.ok(Math.abs(s.ore_got[1] - 3) < 1e-9, `highland ore_got ${s.ore_got[1]} should be the full 3`);
  // Metal: 2.7 supplied vs 5.6 wanted ⇒ proportional split by demand.
  const fill = 2.7 / 5.6;
  assert.ok(Math.abs(s.metal_got[0] - 4 * fill) < 1e-6, `lowland metal_got ${s.metal_got[0]}`);
  assert.ok(Math.abs(s.metal_got[1] - 1.6 * fill) < 1e-6, `highland metal_got ${s.metal_got[1]}`);
  // Counterflow: food runs lowland→highland, metal highland→lowland.
  const foodFlow = w.flowNet.food.flows[0];
  const metalFlow = w.flowNet.metal.flows[0];
  assert.ok(foodFlow > 0, `food should flow 0→1 (got ${foodFlow})`);
  assert.ok(metalFlow < 0, `metal should flow 1→0 (got ${metalFlow})`);
});

// 17. Buildings ARE capacity, and construction SPENDS surplus: the granary
//     accumulates the food net's overproduction (drift), each farm costs 60
//     of it (the spend flaps the guard so the edge-triggered timer re-arms).
//     farms is a MONOTONE COUNTER (+1-only adds), so the farms →
//     grain_out(derived) → granary → farms loop carries ONE state
//     dimension (granary) and doesn't even warn. When the build limit hits
//     and the granary clamps, the world rests.
check('construction spends surplus, capacity caps output, then rests', () => {
  const spec = twoBiome();
  spec.entity.vars.push({ name: 'granary', min: 0, max: 500, initial: 0 });
  spec.flownets![0] = { ...spec.flownets![0], drift: 'granary' }; // food surplus lands here
  spec.entity.rules.push({
    id: 'build-farm',
    when: { all: [{ cmp: '>=', left: { scalar: 'granary' }, right: { const: 60 } }, { cmp: '<', left: { scalar: 'farms' }, right: { const: 4 } }] },
    trigger: { timer: 10 },
    effects: [{ add: { scalar: 'farms', amount: 1 } }, { add: { scalar: 'granary', amount: -60 } }],
  });
  const r = validateWorldSpec(spec);
  assert.ok(r.ok, `construction spec rejected: ${r.errors.join('; ')}`);
  assert.ok(!r.warnings.some(x => /feedback loop/.test(x)), `monotone farms should not join a loop (got: ${r.warnings.join('; ')})`);

  const w = createWorld(spec, 2, [[0, 1]]);
  injectEntity(w, 0, 'farmland', 900); injectEntity(w, 0, 'farms', 1);
  const at = stepUntilRest(w, 4000);
  assert.ok(at > 0, 'construction world never rested');
  assert.equal(w.scalars.farms[0], 4, `farms should build out to the limit (got ${w.scalars.farms[0]})`);
  assert.ok(Math.abs(w.scalars.grain_out[0] - 20) < 1e-9, `grain should sit at the 4-farm cap (got ${w.scalars.grain_out[0]})`);
  assert.equal(w.scalars.granary[0], 500, 'granary should sit at its clamp once building stops');
});

// 18. Dynamic roster (gate 5): a colony founded mid-run joins the economy —
//     arrays grow, the flow nets re-solve over the new topology, food finds
//     the new road, and the world re-rests. Deterministically.
check('addEntity mid-run: the new town joins the flow network', () => {
  const build = (found: boolean): EntityWorld => {
    const w = createWorld(twoBiome(), 2, [[0, 1]]);
    injectEntity(w, 0, 'population', 20_000); injectEntity(w, 0, 'farmland', 900); injectEntity(w, 0, 'farms', 10);
    injectEntity(w, 1, 'population', 8_000); injectEntity(w, 1, 'ore_access', 600);
    injectEntity(w, 1, 'mines', 8); injectEntity(w, 1, 'smelters', 6);
    assert.ok(stepUntilRest(w, 300) > 0, 'pre-founding world never settled');
    if (found) {
      const i = addEntity(w, { x: 2, y: 0, scalars: { population: 5_000 }, edges: [{ to: 0 }] });
      assert.equal(i, 2, 'new entity index');
      assert.ok(stepUntilRest(w, 300) > 0, 'post-founding world never settled');
    }
    return w;
  };

  const w = build(true);
  // The colony eats — and the still-surplus food net feeds it fully.
  assert.ok(Math.abs(w.scalars.food_need[2] - 5) < 1e-9, `colony food_need ${w.scalars.food_need[2]}`);
  assert.ok(Math.abs(w.scalars.food_got[2] - 5) < 1e-9, `colony unfed (${w.scalars.food_got[2]})`);
  // Food moves along the founded road (edge 1 is colony→lowland, so inflow
  // to the colony is negative).
  assert.ok(w.flowNet.food.flows[1] < 0, `no food on the colony road (${w.flowNet.food.flows[1]})`);
  // Same founding sequence twice ⇒ identical worlds.
  assert.equal(snap(build(true)), snap(w), 'founding not deterministic');
});

// 19. Validator: process refs are checked; process coupling joins the graph.
check('validator checks processes and satisfied', () => {
  const bad = twoBiome();
  bad.processes![0] = { ...bad.processes![0], input: 'nope' };
  const r1 = validateWorldSpec(bad);
  assert.ok(!r1.ok && r1.errors.some(e => /process "farm": input "nope"/.test(e)), 'unknown process input not rejected');

  const badSat = twoBiome();
  (badSat.flownets![0] as { satisfied?: string }).satisfied = 'missing';
  const r2 = validateWorldSpec(badSat);
  assert.ok(!r2.ok && r2.errors.some(e => /satisfied "missing"/.test(e)), 'unknown satisfied var not rejected');
});

// 20. Flow-net `by` coupling is refined by severability: drift/satisfied are
//     per-component aggregates (mean imbalance / proportional fill) that read
//     conductance only through component MEMBERSHIP. A road bounded above 0
//     can never sever ⇒ no dependency edge ⇒ construction-from-drift over a
//     road-conducted net closes no loop at all (farms is a monotone counter,
//     granary alone is 1-state). The same spec with a SEVERABLE road (min 0)
//     keeps the conservative X(road)→drift edge and warns as the bounded
//     2-state {road, granary} pair — the edge stays for topologies that can
//     actually change.
check('flow-net by-coupling: unseverable road exempt, severable road warns', () => {
  const construction = (roadMin: number): WorldSpec => {
    const spec = twoBiome();
    spec.edge = { vars: [{ name: 'road', min: roadMin, max: 1, initial: Math.max(roadMin, 0.05) }] };
    spec.flownets![0] = { ...spec.flownets![0], by: 'road', drift: 'granary' };
    spec.roads = [{ attr: 'road', use: 'food', rate: 0.002, decay: 0.001 }];
    spec.entity.vars.push({ name: 'granary', min: 0, max: 500, initial: 0 });
    spec.entity.rules.push({
      id: 'build-farm',
      when: { all: [{ cmp: '>=', left: { scalar: 'granary' }, right: { const: 60 } }, { cmp: '<', left: { scalar: 'farms' }, right: { const: 4 } }] },
      trigger: { every: true },
      effects: [{ add: { scalar: 'farms', amount: 1 } }, { add: { scalar: 'granary', amount: -60 } }],
    });
    return spec;
  };

  const safe = validateWorldSpec(construction(0.05));
  assert.ok(safe.ok, `unseverable-road construction rejected: ${safe.errors.join('; ')}`);
  assert.ok(!safe.warnings.some(x => /feedback loop/.test(x)), `unseverable road should close no loop (got: ${safe.warnings.join('; ')})`);

  const risky = validateWorldSpec(construction(0));
  assert.ok(risky.ok, `severable-road construction should warn, not reject: ${risky.errors.join('; ')}`);
  assert.ok(risky.warnings.some(x => /2-attribute feedback loop/.test(x) && /road/.test(x) && /granary/.test(x)),
    `expected the 2-state {road, granary} warning (got: ${risky.warnings.join('; ')})`);
});

// 21. Monotone counters: three build rules spending ONE granary would fuse
//     three legal pairs into a fictitious 4-state SCC — each guard reads its
//     own counter while the effect spends the shared stock. +1-only counters
//     carry no recurrence, so the whole construction economy is 1-state
//     (granary) and legal. Adding DEMOLITION (a negative add on the same
//     counters) makes them genuinely bi-directional state again, and the
//     fused loop is rejected — decline mechanics will need their own shape.
check('monotone counters: shared-stock construction legal, demolition re-fuses', () => {
  const construction = (): WorldSpec => {
    const spec = twoBiome();
    spec.flownets![0] = { ...spec.flownets![0], drift: 'granary' };
    spec.entity.vars.push({ name: 'granary', min: 0, max: 500, initial: 0 });
    const build = (id: string, building: string, threshold: number, cost: number) => ({
      id,
      when: {
        all: [
          { cmp: '>=' as const, left: { scalar: 'granary' }, right: { const: threshold } },
          { cmp: '<' as const, left: { scalar: building }, right: { const: 8 } },
        ],
      },
      trigger: { every: true as const },
      effects: [{ add: { scalar: building, amount: 1 } }, { add: { scalar: 'granary', amount: -cost } }],
    });
    spec.entity.rules.push(build('build-farm', 'farms', 60, 60), build('build-mine', 'mines', 140, 80), build('build-smelter', 'smelters', 240, 100));
    return spec;
  };

  const ok = validateWorldSpec(construction());
  assert.ok(ok.ok, `three-building construction rejected: ${ok.errors.join('; ')}`);
  assert.ok(!ok.warnings.some(x => /feedback loop/.test(x)), `counters should not fuse a loop (got: ${ok.warnings.join('; ')})`);

  const withDemolition = construction();
  withDemolition.entity.rules.push(
    { id: 'demolish-farm', when: { cmp: '<', left: { scalar: 'granary' }, right: { const: 5 } }, trigger: { every: true }, effects: [{ add: { scalar: 'farms', amount: -1 } }] },
    { id: 'demolish-mine', when: { cmp: '<', left: { scalar: 'granary' }, right: { const: 5 } }, trigger: { every: true }, effects: [{ add: { scalar: 'mines', amount: -1 } }] },
  );
  const bad = validateWorldSpec(withDemolition);
  assert.ok(!bad.ok, 'bi-directional counters sharing a stock should be rejected');
  assert.ok(bad.errors.some(x => /feedback loop couples \d+ state attributes/.test(x) && /granary/.test(x)),
    `expected the fused-loop rejection (got: ${bad.errors.join('; ')})`);
});

// 22. TOMBSTONE (civilization-emergence.md §2b): setEntityDisabled makes an
//     entity absent from every dynamic while its index survives. The caller
//     zeroes the scalars (the absorb discipline); the engine severs it: the
//     flow nets re-solve around the ruin (no shipments, no drift share, no
//     satisfied), the survivor keeps its own economy, the world re-rests,
//     the mask round-trips serialization, and catch-up stays exact.
check('tombstone: ruin leaves the economy, world re-rests, catch-up exact', () => {
  const build = (): EntityWorld => {
    const w = createWorld(twoBiome(), 2, [[0, 1]]);
    injectEntity(w, 0, 'population', 20_000); injectEntity(w, 0, 'farmland', 900); injectEntity(w, 0, 'farms', 10);
    injectEntity(w, 1, 'population', 8_000); injectEntity(w, 1, 'ore_access', 600);
    injectEntity(w, 1, 'mines', 8); injectEntity(w, 1, 'smelters', 6);
    assert.ok(stepUntilRest(w, 300) > 0, 'pre-tombstone world never settled');
    return w;
  };
  // The absorb discipline: EVERY var to its floor — processes skip a ruin,
  // so a derived output left standing would freeze at its last value.
  const bury = (w: EntityWorld): void => {
    for (const v of w.spec.entity.vars ?? []) w.scalars[v.name][1] = v.min;
    setEntityDisabled(w, 1);
  };

  const w = build();
  assert.ok(w.flowNet.food.flows[0] > 0, 'food should flow before the tombstone');
  bury(w);
  assert.ok(stepUntilRest(w, 300) > 0, 'post-tombstone world never re-rested');

  // The ruin ships nothing, wants nothing, produces nothing.
  assert.equal(w.flowNet.food.flows[0], 0, 'no food to a ruin');
  assert.equal(w.scalars.ore_out[1], 0, 'a ruin mines nothing');
  assert.equal(w.scalars.food_got[1], 0, 'a ruin is fed nothing');
  // The survivor keeps its own economy in its now-singleton component…
  assert.ok(Math.abs(w.scalars.food_got[0] - 20) < 1e-9, `lowland unfed (${w.scalars.food_got[0]})`);
  // …but the mine's export is gone with the mine.
  assert.equal(w.scalars.metal_got[0], 0, 'no metal without the mine');

  // The mask survives save/load.
  const re = deserializeWorld(serializeWorld(w));
  assert.ok(re && re.disabled[1] === 1, 'disabled mask should survive save/load');

  // Catch-up with a tombstone equals stepping.
  const s1 = build(); bury(s1);
  const s2 = build(); bury(s2);
  for (let i = 0; i < 50; i++) stepWorld(s1);
  worldFastForward(s2, 50);
  assert.equal(snap(s2), snap(s1), 'catch-up diverged with a tombstone');
});

// 23. GOODS WIDEN (world-content.md §3d): fan-in SUM aggregates several
//     demand sources into one net demand; fan-out ALLOCATE divides the
//     delivery across consumers in priority order, conserving; a
//     MULTI-REAGENT process is Leontief across all its inputs — the
//     scarcest binds. Forest mills planks; the town's households (first
//     priority) and smithies share the delivery; tools need planks AND
//     metal. Chains settle, the world rests, catch-up stays exact.
check('fan-in, fan-out, multi-reagent: the widened economy settles and conserves', () => {
  const spec = (): WorldSpec => ({
    id: 'reagents',
    entity: {
      id: 'town',
      vars: [
        'population', 'timberland', 'ore_access', 'sawmills', 'smithies',
        'planks_out', 'planks_need', 'planks_got', 'fuel_draw', 'smith_plank_draw',
        'fuel_share', 'smith_planks', 'metal_out', 'smith_metal_draw', 'metal_got', 'tools_out',
      ].map(name => ({ name, min: 0, max: 100_000, initial: 0 })),
      rules: [],
    },
    processes: [
      { id: 'mill', input: 'timberland', output: 'planks_out', efficiency: 0.02, capacityBy: 'sawmills', capacityRate: 4 },
      { id: 'fuel', input: 'population', output: 'fuel_draw', efficiency: 0.0005 },
      { id: 'smith-planks', input: 'smithies', output: 'smith_plank_draw', efficiency: 3 },
      { id: 'smith-metal', input: 'smithies', output: 'smith_metal_draw', efficiency: 1 },
      { id: 'smelt', input: 'ore_access', output: 'metal_out', efficiency: 0.01 },
      {
        id: 'tools',
        inputs: [{ scalar: 'smith_planks', efficiency: 0.5 }, { scalar: 'metal_got', efficiency: 1 }],
        output: 'tools_out', capacityBy: 'smithies', capacityRate: 2,
      },
    ],
    sums: [{ id: 'plank-want', output: 'planks_need', terms: [{ scalar: 'fuel_draw' }, { scalar: 'smith_plank_draw' }] }],
    allocates: [{
      id: 'plank-split', source: 'planks_got',
      shares: [
        { output: 'fuel_share', demand: 'fuel_draw' },       // households first
        { output: 'smith_planks', demand: 'smith_plank_draw' },
      ],
    }],
    flownets: [
      { id: 'planks', source: 'planks_out', demand: 'planks_need', satisfied: 'planks_got' },
      { id: 'metal', source: 'metal_out', demand: 'smith_metal_draw', satisfied: 'metal_got' },
    ],
  });

  const r = validateWorldSpec(spec());
  assert.ok(r.ok, `reagent spec rejected: ${r.errors.join('; ')}`);
  assert.ok(!r.warnings.some(x => /feedback loop/.test(x)), `relays should add no loop (got: ${r.warnings.join('; ')})`);

  const boot = (sawmills: number): EntityWorld => {
    const w = createWorld(spec(), 2, [[0, 1]]); // 0 = forest, 1 = town
    injectEntity(w, 0, 'timberland', 800); injectEntity(w, 0, 'sawmills', sawmills);
    injectEntity(w, 1, 'population', 10_000); injectEntity(w, 1, 'ore_access', 400); injectEntity(w, 1, 'smithies', 3);
    assert.ok(stepUntilRest(w, 100) > 0, 'reagent economy never settled');
    return w;
  };

  // PLENTY: supply 16 ≥ demand 14 (fuel 5 + smiths 9); both shares fed;
  // tools bind on the SCARCEST reagent (metal 3, not planks 9×0.5 or cap 6).
  const w = boot(5);
  assert.ok(Math.abs(w.scalars.planks_need[1] - 14) < 1e-9, `fan-in sum ${w.scalars.planks_need[1]} ≠ 5 + 9`);
  assert.ok(Math.abs(w.scalars.planks_got[1] - 14) < 1e-9, `town undelivered (${w.scalars.planks_got[1]})`);
  assert.ok(Math.abs(w.scalars.fuel_share[1] - 5) < 1e-9, 'households short despite plenty');
  assert.ok(Math.abs(w.scalars.smith_planks[1] - 9) < 1e-9, 'smiths short despite plenty');
  assert.ok(Math.abs(w.scalars.tools_out[1] - 3) < 1e-9, `tools ${w.scalars.tools_out[1]} should bind on metal (3)`);

  // SCARCITY: one mill (supply 4 « demand 14) — the delivery conserves
  // exactly, priority feeds the FIRST share fully before the second sees
  // anything, and the tool chain starves downstream.
  const s = boot(1);
  assert.ok(Math.abs(s.scalars.planks_got[1] - 4) < 1e-9, `scarce delivery ${s.scalars.planks_got[1]}`);
  assert.ok(Math.abs(s.scalars.fuel_share[1] - 4) < 1e-9, 'priority: households take the whole short delivery');
  assert.equal(s.scalars.smith_planks[1], 0, 'priority: smiths get nothing until households are fed');
  assert.ok(Math.abs(s.scalars.fuel_share[1] + s.scalars.smith_planks[1] - s.scalars.planks_got[1]) < 1e-9, 'allocation must conserve');
  assert.equal(s.scalars.tools_out[1], 0, 'no planks ⇒ no tools');

  // Catch-up with the widened economy equals stepping.
  const a = boot(5), b = boot(5);
  injectEntity(a, 0, 'sawmills', -4); injectEntity(b, 0, 'sawmills', -4); // mid-life disturbance
  for (let i = 0; i < 40; i++) stepWorld(a);
  worldFastForward(b, 40);
  assert.equal(snap(b), snap(a), 'catch-up diverged in the reagent economy');

  // Validator teeth: both process forms are exclusive; refs checked.
  const bad = spec();
  bad.processes!.push({ id: 'confused', input: 'population', inputs: [{ scalar: 'metal_got', efficiency: 1 }], output: 'tools_out', efficiency: 1 });
  assert.ok(!validateWorldSpec(bad).ok, 'input+inputs together should be rejected');
  const badSum = spec();
  badSum.sums![0].terms.push({ scalar: 'nope' });
  assert.ok(!validateWorldSpec(badSum).ok, 'unknown sum term should be rejected');
  const badAl = spec();
  badAl.allocates![0].shares.push({ output: 'metal_out', demand: 'missing' });
  assert.ok(!validateWorldSpec(badAl).ok, 'unknown allocate demand should be rejected');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
