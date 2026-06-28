// Cell Systems — ENTITY/RELATIONSHIP checks (Step 3: the algebra on a graph).
// Run:  npx tsx games/sandbox-game/test/entities-checks.ts
//
// Guards that long-distance city interactions stay idle-safe: trade is a
// conservative diffusion that equalises + conserves; a whole civilization reaches
// rest (incl. randomized tuning); catch-up == stepping; and the validator allows a
// pairwise relationship cycle but REJECTS a 3-attribute one (the chaos boundary).

import assert from 'node:assert/strict';
import {
  createWorld, stepWorld, worldFastForward, totalScalar, injectEntity,
  serializeWorld, deserializeWorld, validateWorldSpec,
  type EntityWorld, type WorldSpec,
  civilization, riseAndFall, unstableCiv, tradeNetwork,
} from '../src/cell-systems/index.ts';

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
  assert.ok(!bad.ok && bad.errors.some(e => /couples 3 attributes/.test(e)), `3-loop not rejected: ${bad.errors.join('; ')}`);
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

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
