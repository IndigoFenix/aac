// Cell Systems — engine checks. Pure-logic assertions, no DOM/React.
// Run:  npx tsx games/sandbox-game/test/cell-systems-checks.ts
//
// Guards the two things that make a JSON-defined enclosed system idle-safe:
//   • the RUNTIME reaches rest / a bounded cycle, and fast-forward == stepping;
//   • the VALIDATOR accepts safe specs and rejects the chaotic / non-terminating
//     ones (3-var loops, self-refilling budgets, clock-forced oscillators).

import assert from 'node:assert/strict';
import {
  instantiate, stepOne, fastForward, inject, serializeInstance, deserializeInstance,
  type CellInstance, type SystemSpec,
  validateSpec, SAFE_EXAMPLES, UNSAFE_EXAMPLES,
  lifecycle, reaction, predatorPrey, dayNight, chaos3, budgetRegen, forcedOscillator,
} from '../../../shared/engine/cells/index.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

/** Step until nothing changes for `quiet` consecutive steps (rest), or -1. */
function stepUntilRest(inst: CellInstance, cap: number, quiet = 3): number {
  let still = 0;
  for (let i = 1; i <= cap; i++) {
    const changed = stepOne(inst);
    still = changed ? 0 : still + 1;
    if (still >= quiet && inst.armed.size === 0) return i;
  }
  return -1;
}

const snapshot = (inst: CellInstance) => JSON.stringify({
  s: inst.scalars, st: inst.stages, cp: inst.clockPhase, c: inst.clock,
});

console.log('Cell-systems engine checks:');

// 1. Every shipped safe example passes validation; every unsafe one fails.
check('validator accepts safe examples, rejects unsafe ones', () => {
  for (const spec of SAFE_EXAMPLES) {
    const r = validateSpec(spec);
    assert.ok(r.ok, `safe example "${spec.id}" rejected: ${r.errors.join('; ')}`);
  }
  for (const spec of UNSAFE_EXAMPLES) {
    const r = validateSpec(spec);
    assert.ok(!r.ok, `unsafe example "${spec.id}" was NOT rejected`);
  }
});

// 2. Specific rejection reasons (so we know it fails for the RIGHT reason).
check('validator rejects a 3-variable feedback loop', () => {
  const r = validateSpec(chaos3);
  assert.ok(r.errors.some(e => /feedback loop couples 3/.test(e)), r.errors.join('; '));
});
check('validator rejects a self-refilling budget', () => {
  const r = validateSpec(budgetRegen);
  assert.ok(r.errors.some(e => /RAISE budget/.test(e)), r.errors.join('; '));
});
check('validator rejects a clock forcing an oscillator', () => {
  const r = validateSpec(forcedOscillator);
  assert.ok(r.errors.some(e => /inside a feedback loop/.test(e)), r.errors.join('; '));
});
check('validator allows a 2-variable loop but warns', () => {
  const r = validateSpec(predatorPrey);
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(r.warnings.some(w => /2-variable feedback loop/.test(w)), 'expected a 2-var-loop warning');
});

// 3. The settling systems reach rest in a bounded number of steps.
check('lifecycle reaches rest (Dead)', () => {
  const inst = instantiate(lifecycle);
  const at = stepUntilRest(inst, 200);
  assert.ok(at > 0, 'lifecycle never settled');
  assert.equal(inst.stages.growth, 'Dead', `expected Dead, got ${inst.stages.growth}`);
  assert.ok(inst.scalars.energy >= 0, 'energy went negative');
});
check('reaction settles with A spent into B (conserved)', () => {
  const inst = instantiate(reaction);
  const total0 = inst.scalars.A + inst.scalars.B;
  const at = stepUntilRest(inst, 1000);
  assert.ok(at > 0, 'reaction never settled');
  assert.ok(inst.scalars.A < 0.05, `A not consumed (${inst.scalars.A})`);
  assert.ok(Math.abs(inst.scalars.A + inst.scalars.B - total0) < 1e-6, 'mass not conserved');
});
check('damped predator-prey spirals to rest at equilibrium', () => {
  const inst = instantiate(predatorPrey);
  const at = stepUntilRest(inst, 5000);
  assert.ok(at > 0, 'damped oscillator never settled');
  assert.ok(Math.abs(inst.scalars.prey - 5) < 0.1 && Math.abs(inst.scalars.pred - 5) < 0.1,
    `did not converge to equilibrium (prey=${inst.scalars.prey}, pred=${inst.scalars.pred})`);
});

// 4. An oscillator and a clock stay BOUNDED forever (no blow-up, no chaos).
check('day/night flower stays bounded and cycles', () => {
  const inst = instantiate(dayNight);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 600; i++) { stepOne(inst); min = Math.min(min, inst.scalars.openness); max = Math.max(max, inst.scalars.openness); }
  assert.ok(min >= 0 && max <= 1, `openness left [0,1] (${min}..${max})`);
  assert.ok(max - min > 0.5, 'flower should actually open and close');
});

// 5. THE catch-up guarantee: fastForward(N) == stepOne()×N, for every example.
check('fast-forward equals step-by-step (all examples)', () => {
  for (const spec of SAFE_EXAMPLES) {
    const N = 900;
    const a = instantiate(spec);
    const b = instantiate(spec);
    for (let i = 0; i < N; i++) stepOne(a);
    fastForward(b, N);
    assert.equal(a.clock, b.clock, `${spec.id}: clock mismatch ${a.clock} vs ${b.clock}`);
    assert.equal(snapshot(a), snapshot(b), `${spec.id}: fast-forward diverged from stepping`);
  }
});

// 6. Catch-up over a SETTLED system is ~free (jumps, doesn't replay every step).
//    We can't see internal work directly, but a huge fast-forward must stay fast
//    and land in the same rest state as a short one past settling.
check('fast-forward over a settled lifecycle lands in the same rest state', () => {
  const a = instantiate(lifecycle);
  fastForward(a, 60);          // well past the ~22-step lifecycle
  const rest = snapshot(a).replace(/"c":\d+/, '');
  const b = instantiate(lifecycle);
  fastForward(b, 1_000_000);   // enormous absence
  const restB = snapshot(b).replace(/"c":\d+/, '');
  assert.equal(restB, rest, 'a long absence diverged from a short one on a settled world');
});

// 7. Serialize / reload mid-evolution continues identically (in-flight timers
//    + clock phases survive, so an absent player's cell evolves as a present one's).
check('save/reload mid-evolution continues identically', () => {
  const N = 40;
  const live = instantiate(lifecycle);
  const split = instantiate(lifecycle);
  for (let i = 0; i < N; i++) stepOne(live);
  for (let i = 0; i < N / 2; i++) stepOne(split);
  const reloaded = deserializeInstance(serializeInstance(split));
  assert.ok(reloaded, 'reload failed');
  for (let i = 0; i < N / 2; i++) stepOne(reloaded!);
  assert.equal(snapshot(reloaded!), snapshot(live), 'reloaded run diverged from the live one');
});

// 8. External input is the only thing that may raise a budget — and it wakes the
//    cell so it resumes evolving ("reaches equilibrium UNLESS disturbed").
check('external input re-energises a settled cell', () => {
  const inst = instantiate(reaction);
  stepUntilRest(inst, 1000);
  assert.ok(inst.scalars.A < 0.05, 'precondition: reaction settled');
  inject(inst, 'A', 5); // a player tops up the reactant
  assert.ok(inst.scalars.A >= 5, 'inject did not raise A');
  const at = stepUntilRest(inst, 1000);
  assert.ok(at > 0 && inst.scalars.A < 0.05, 'cell did not re-settle after disturbance');
});

// 9. THE termination guarantee under randomized tuning: random rates/timers on
//    the settling systems must STILL reach rest — structural safety, not tuning.
check('settling systems terminate for randomized parameters', () => {
  const rng = makeRng(99);
  for (let trial = 0; trial < 12; trial++) {
    // Randomize the reaction's convert rate and the lifecycle's timers/costs.
    const rxn: SystemSpec = JSON.parse(JSON.stringify(reaction));
    const conv = rxn.rules[0].effects as any[];
    const rate = 0.02 + 0.6 * rng();
    conv[0].change.perStep = -rate;
    conv[1].change.perStep = rate;
    const vr = validateSpec(rxn);
    assert.ok(vr.ok, `randomized reaction rejected: ${vr.errors.join('; ')}`);
    const inst = instantiate(rxn);
    assert.ok(stepUntilRest(inst, 5000) > 0, `trial ${trial}: randomized reaction never settled`);

    const life: SystemSpec = JSON.parse(JSON.stringify(lifecycle));
    for (const r of life.rules) if ('timer' in r.trigger) r.trigger.timer = 1 + Math.floor(rng() * 12);
    const inst2 = instantiate(life);
    assert.ok(stepUntilRest(inst2, 1000) > 0, `trial ${trial}: randomized lifecycle never settled`);
    assert.equal(inst2.stages.growth, 'Dead');
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
