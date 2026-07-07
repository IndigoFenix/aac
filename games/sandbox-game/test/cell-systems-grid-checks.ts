// Cell Systems — GRID engine checks (Step 2: spread & flow across tiles).
// Run:  npx tsx games/sandbox-game/test/cell-systems-grid-checks.ts
//
// Guards that the COUPLED grid stays idle-safe: conservative transport conserves
// totals and settles, the coupled grid reaches rest (incl. randomized tuning), a
// settled grid does zero work, catch-up == stepping, and a 1×1 grid behaves
// exactly like the single-cell flask (the shared-eval parity check).

import assert from 'node:assert/strict';
import {
  createGrid, worldStep, gridFastForward, injectTile, totalField,
  pendingCount, serializeGrid, deserializeGrid, validateSpec, setGridWrap,
  instantiate, stepOne,
  type CellGrid, type SystemSpec,
  GRID_EXAMPLES, diffusion, puddle, dayField, colony, lifecycle, rainlands,
  intDiffusion, intPuddle, intTerrain, intTerrainSteady, intRivers,
  worldgenSubstrate, seedOreAboveTreeline, findFoundingSites,
} from '../src/cell-systems/index.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}
function stepGridUntilRest(grid: CellGrid, cap: number): number {
  for (let i = 1; i <= cap; i++) { worldStep(grid); if (pendingCount(grid) === 0) return i; }
  return -1;
}
const gridSnap = (g: CellGrid) => {
  const f: Record<string, number[]> = {};
  for (const k in g.fields) f[k] = Array.from(g.fields[k]);
  const s: Record<string, number[]> = {};
  for (const k in g.stageIdx) s[k] = Array.from(g.stageIdx[k]);
  return JSON.stringify({ f, s, cp: g.clockPhase, c: g.clock });
};

console.log('Cell-systems GRID checks:');

// 1. All grid examples validate.
check('grid examples all validate', () => {
  for (const spec of GRID_EXAMPLES) {
    const r = validateSpec(spec);
    assert.ok(r.ok, `${spec.id} rejected: ${r.errors.join('; ')}`);
  }
});

// 2. Transport conserves the field total and settles to a flat distribution.
check('diffusion conserves total and flattens', () => {
  const g = createGrid(diffusion, 16, 16);
  const total0 = totalField(g, 'stuff');
  const at = stepGridUntilRest(g, 4000);
  assert.ok(at > 0, 'diffusion never settled');
  assert.ok(Math.abs(totalField(g, 'stuff') - total0) < 1e-6, 'diffusion did not conserve total');
  // flat ⇒ min ≈ max across the grid
  let lo = Infinity, hi = -Infinity;
  for (const v of g.fields.stuff) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(hi - lo < 0.05, `did not flatten (spread ${lo}..${hi})`);
});

// 3. flowDown pools water in the basin and conserves it.
check('puddle flows downhill, pools in the basin, conserves water', () => {
  const g = createGrid(puddle, 16, 16);
  const total0 = totalField(g, 'water');
  const at = stepGridUntilRest(g, 6000);
  assert.ok(at > 0, 'puddle never settled');
  assert.ok(Math.abs(totalField(g, 'water') - total0) < 1e-5, 'water not conserved');
  // The wettest tile should be near the basin centre (the height minimum).
  let best = -1, bx = 0, by = 0;
  for (let i = 0; i < g.fields.water.length; i++) if (g.fields.water[i] > best) { best = g.fields.water[i]; bx = i % g.cols; by = (i / g.cols) | 0; }
  assert.ok(Math.hypot(bx - 7.5, by - 7.5) < 4, `pool not central (at ${bx},${by})`);
});

// 4. The idle-safe grid examples reach crisp rest (empty schedule). The
//    CONTINUOUS-physics specs (rainlands, terrain) are excluded: they're scalar
//    physics for non-idle-safe play and settle only asymptotically (that's the
//    motivation for the integer+timer idle-safe baseline) — they're checked for
//    bounded / no-flood behaviour separately, not for crisp rest.
const CONTINUOUS_PHYSICS = new Set(['rainlands', 'terrain']);
check('idle-safe grid examples reach rest', () => {
  for (const spec of GRID_EXAMPLES) {
    if (spec.clocks?.length || CONTINUOUS_PHYSICS.has(spec.id)) continue;
    const g = createGrid(spec, 12, 12);
    assert.ok(stepGridUntilRest(g, 8000) > 0, `${spec.id} never settled (pending=${pendingCount(g)})`);
  }
});

// 5. A settled grid does zero work (active set empties).
check('a settled grid schedules no further work', () => {
  const g = createGrid(diffusion, 12, 12);
  assert.ok(stepGridUntilRest(g, 4000) > 0, 'precondition: should settle');
  for (let i = 0; i < 200; i++) worldStep(g);
  assert.equal(pendingCount(g), 0, 'settled grid woke itself back up');
});

// 6. Catch-up == stepping, for every grid example (incl. the clock one).
check('grid fast-forward equals step-by-step', () => {
  for (const spec of GRID_EXAMPLES) {
    const N = 500;
    const a = createGrid(spec, 10, 10);
    const b = createGrid(spec, 10, 10);
    for (let i = 0; i < N; i++) worldStep(a);
    gridFastForward(b, N);
    assert.equal(gridSnap(a), gridSnap(b), `${spec.id}: fast-forward diverged from stepping`);
  }
});

// 7. Disturbing a settled grid wakes only the affected region and it re-settles.
check('injecting into a settled grid re-settles it (conserving the new total)', () => {
  const g = createGrid(diffusion, 16, 16);
  stepGridUntilRest(g, 4000);
  injectTile(g, 8 * 16 + 8, 'stuff', 50);
  const total = totalField(g, 'stuff');
  assert.ok(pendingCount(g) > 0, 'inject did not wake anything');
  assert.ok(stepGridUntilRest(g, 4000) > 0, 'did not re-settle after disturbance');
  assert.ok(Math.abs(totalField(g, 'stuff') - total) < 1e-6, 'lost material on re-settle');
});

// 8. Save/reload mid-evolution continues identically.
check('grid save/reload mid-evolution continues identically', () => {
  const N = 60;
  const live = createGrid(colony, 10, 10);
  const split = createGrid(colony, 10, 10);
  for (let i = 0; i < N; i++) worldStep(live);
  for (let i = 0; i < N / 2; i++) worldStep(split);
  const reloaded = deserializeGrid(serializeGrid(split));
  assert.ok(reloaded, 'reload failed');
  for (let i = 0; i < N / 2; i++) worldStep(reloaded!);
  assert.equal(gridSnap(reloaded!), gridSnap(live), 'reloaded grid diverged from the live one');
});

// 9. A 1×1 grid with no transport behaves exactly like the single-cell flask
//    (proves the shared eval keeps the two engines in lock-step).
check('1×1 grid matches the single-cell flask', () => {
  const N = 80;
  const cell = instantiate(lifecycle);
  const g = createGrid(lifecycle, 1, 1);
  for (let i = 0; i < N; i++) { stepOne(cell); worldStep(g); }
  assert.equal(g.stageIdx.growth[0], lifecycle.states![0].stages.indexOf(cell.stages.growth),
    'stage diverged between flask and 1×1 grid');
  assert.ok(Math.abs(g.fields.energy[0] - cell.scalars.energy) < 1e-9,
    `energy diverged (${g.fields.energy[0]} vs ${cell.scalars.energy})`);
});

// 10. Termination under randomized transport/growth tuning — structural safety.
check('coupled grid terminates for randomized parameters', () => {
  const rng = makeRng(2026);
  for (let trial = 0; trial < 8; trial++) {
    const spec: SystemSpec = JSON.parse(JSON.stringify(colony));
    (spec.rules[0].effects[0] as any).toward.rate = 0.01 + 0.5 * rng();
    (spec.rules[0].effects[1] as any).add.amount = -(0.01 + 0.2 * rng());
    (spec.rules[1].effects[0] as any).spread.rate = 0.02 + 0.9 * rng();
    assert.ok(validateSpec(spec).ok, `trial ${trial}: randomized colony rejected`);
    const g = createGrid(spec, 12, 12);
    assert.ok(stepGridUntilRest(g, 12000) > 0, `trial ${trial}: never settled (pending=${pendingCount(g)})`);
  }
});

// 11. The SENSOR foundation + the flood fix: a prominence-driven terrain spec
//     springs BELOW the peak, greens an oasis, and — crucially — does NOT flood
//     (bounded water, peak stays dry) thanks to the prominence cap, open boundary
//     and depth-proportional percolation. (The continuous model settles only
//     asymptotically — that's why integer+timer is the idle-safe baseline — so we
//     assert the structural guarantees that hold over a bounded run, not strict
//     empty-schedule rest.)
check('rainlands: springs below the peak, greens, and never floods', () => {
  const g = createGrid(rainlands, 20, 20);
  let peakH = -Infinity, peakI = 0;
  for (let i = 0; i < g.fields.height.length; i++) if (g.fields.height[i] > peakH) { peakH = g.fields.height[i]; peakI = i; }
  for (let i = 0; i < 4000; i++) worldStep(g);
  let wettest = -1, wi = 0, wet = 0, green = 0;
  for (let i = 0; i < g.fields.water.length; i++) {
    if (g.fields.water[i] > wettest) { wettest = g.fields.water[i]; wi = i; }
    if (g.fields.water[i] > 0.05) wet++;
    if (g.fields.plant[i] > 0.05) green++;
  }
  assert.ok(wettest > 0.05, `no spring water formed (max ${wettest})`);
  assert.ok(g.fields.height[wi] < peakH - 1, `spring should be below the peak (spring h=${g.fields.height[wi]}, peak h=${peakH})`);
  assert.ok(g.fields.water[peakI] < 0.05, `the peak itself should stay dry (water=${g.fields.water[peakI]})`);
  assert.ok(green > 4, `expected an oasis to green (green tiles=${green})`);
  assert.ok(wet < g.cols * g.rows * 0.6, `flooded — ${wet}/${g.cols * g.rows} tiles wet`);
  assert.ok(wettest < 12, `water unboundedly deep (max ${wettest}) — flooding`);
});

// 12. The rainlands spec also fast-forwards identically (sensors + scaled refs in
//     the catch-up path).
check('rainlands fast-forward equals step-by-step', () => {
  const N = 400;
  const a = createGrid(rainlands, 12, 12);
  const b = createGrid(rainlands, 12, 12);
  for (let i = 0; i < N; i++) worldStep(a);
  gridFastForward(b, N);
  assert.equal(gridSnap(a), gridSnap(b), 'rainlands fast-forward diverged from stepping');
});

// 13. flowDown.block: a solid wall stops flow — water poured on one side does not
//     cross to the other (the `stone` substrate primitive).
check('flowDown.block: stone wall blocks flow', () => {
  const spec: SystemSpec = {
    id: 'wall-test',
    vars: [
      { name: 'water', min: 0, max: 50, initial: 0 },
      { name: 'solid', min: 0, max: 1, initial: 0 },
    ],
    rules: [{ id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', rate: 0.3, block: 'solid' } }] }],
  };
  const g = createGrid(spec, 9, 9);
  // A solid wall down the middle column (x=4).
  for (let y = 0; y < 9; y++) injectTile(g, y * 9 + 4, 'solid', 1);
  // Flood the left half.
  for (let y = 0; y < 9; y++) for (let x = 0; x < 4; x++) injectTile(g, y * 9 + x, 'water', 5);
  for (let i = 0; i < 2000; i++) worldStep(g);
  let rightWater = 0;
  for (let y = 0; y < 9; y++) for (let x = 5; x < 9; x++) rightWater += g.fields.water[y * 9 + x];
  assert.ok(rightWater < 1e-6, `water leaked past the wall (right side has ${rightWater})`);
});

// 14. Erosion: flowing water carries sand downstream, lowering the peak and
//     conserving total sand — and the field still settles.
check('erode: carries sand downhill, conserves total, settles', () => {
  const spec: SystemSpec = {
    id: 'erode-test',
    vars: [
      { name: 'height', min: 0, max: 60, initial: 0, init: 'centerBlob' },
      { name: 'water', min: 0, max: 60, initial: 0, init: 'centerBlob' },
    ],
    rules: [
      { id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.3 } }] },
      { id: 'erode', trigger: { every: true }, effects: [{ erode: { scalar: 'height', by: 'water', rate: 0.1, minFlow: 0.1, minSlope: 0.05, max: 0.3 } }] },
      { id: 'evap', trigger: { every: true }, effects: [{ add: { scalar: 'water', amount: -0.05 } }] },
    ],
  };
  const g = createGrid(spec, 16, 16);
  const totalH0 = totalField(g, 'height');
  const peakI = (() => { let m = -1, bi = 0; for (let i = 0; i < g.fields.height.length; i++) if (g.fields.height[i] > m) { m = g.fields.height[i]; bi = i; } return bi; })();
  const peak0 = g.fields.height[peakI];
  const at = stepGridUntilRest(g, 12000);
  assert.ok(at > 0, `erosion never settled (pending=${pendingCount(g)})`);
  assert.ok(Math.abs(totalField(g, 'height') - totalH0) < 1e-4, `sand not conserved (${totalH0} → ${totalField(g, 'height')})`);
  assert.ok(g.fields.height[peakI] < peak0 - 0.5, `the peak should have eroded down (${peak0} → ${g.fields.height[peakI]})`);
});

// 15. Erosion fast-forwards identically (it moves the potential, so this guards
//     that the catch-up path stays in lock-step with stepping).
check('erode fast-forward equals step-by-step', () => {
  const spec: SystemSpec = {
    id: 'erode-ff',
    vars: [
      { name: 'height', min: 0, max: 60, initial: 0, init: 'centerBlob' },
      { name: 'water', min: 0, max: 60, initial: 0, init: 'centerBlob' },
    ],
    rules: [
      { id: 'flow', trigger: { every: true }, effects: [{ flowDown: { scalar: 'water', potential: 'height', rate: 0.3 } }] },
      { id: 'erode', trigger: { every: true }, effects: [{ erode: { scalar: 'height', by: 'water', rate: 0.1, minFlow: 0.1, minSlope: 0.05, max: 0.3 } }] },
      { id: 'evap', trigger: { every: true }, effects: [{ add: { scalar: 'water', amount: -0.05 } }] },
    ],
  };
  const a = createGrid(spec, 12, 12);
  const b = createGrid(spec, 12, 12);
  for (let i = 0; i < 600; i++) worldStep(a);
  gridFastForward(b, 600);
  assert.equal(gridSnap(a), gridSnap(b), 'erosion fast-forward diverged from stepping');
});

// 16. Toroidal grid: edges connect (material seeded at the left edge reaches the
//     right edge, only possible via wrap), and it still conserves + settles.
check('toroidal grid: edges connect, conserves, settles', () => {
  const g = createGrid(diffusion, 12, 12, true);
  // Start flat-zero, then seed a column at the LEFT edge (x=0).
  for (let i = 0; i < g.fields.stuff.length; i++) g.fields.stuff[i] = 0;
  for (let y = 0; y < 12; y++) injectTile(g, y * 12 + 0, 'stuff', 30);
  const total0 = totalField(g, 'stuff');
  for (let i = 0; i < 4000; i++) { worldStep(g); if (pendingCount(g) === 0) break; }
  assert.equal(pendingCount(g), 0, 'toroidal diffusion never settled');
  assert.ok(Math.abs(totalField(g, 'stuff') - total0) < 1e-6, 'toroidal diffusion lost material');
  // The right-edge column (x=11), reachable from x=0 ONLY by wrapping, got material.
  let rightEdge = 0;
  for (let y = 0; y < 12; y++) rightEdge += g.fields.stuff[y * 12 + 11];
  assert.ok(rightEdge > 1, `material did not wrap to the far edge (got ${rightEdge})`);
});

// 17. setGridWrap re-settles a live grid under the new topology.
check('setGridWrap re-wakes and re-settles', () => {
  const g = createGrid(diffusion, 10, 10, false);
  for (let i = 0; i < 4000; i++) { worldStep(g); if (pendingCount(g) === 0) break; }
  setGridWrap(g, true);
  assert.ok(pendingCount(g) > 0, 'flipping wrap should re-wake the grid');
  for (let i = 0; i < 4000; i++) { worldStep(g); if (pendingCount(g) === 0) break; }
  assert.equal(pendingCount(g), 0, 'did not re-settle after wrap flip');
});

// 18. Period folding: for a cycling world (day/night field), a big fast-forward
//     (above the fold threshold) still EXACTLY equals stepping the same span.
check('period folding equals stepping for a cycling world', () => {
  const N = 5000; // > FOLD_MIN, so the fold path runs
  const a = createGrid(dayField, 10, 10);
  const b = createGrid(dayField, 10, 10);
  for (let i = 0; i < N; i++) worldStep(a);
  gridFastForward(b, N);
  assert.equal(gridSnap(a), gridSnap(b), 'folded fast-forward diverged from stepping');
});

// 19. Period folding makes an ENORMOUS absence O(period): it reaches the exact end
//     clock (i.e. it folded instead of hitting the step cap), and matches a stepped
//     reference that is congruent modulo the (120-step) day period.
check('period folding handles a huge absence in O(period)', () => {
  const huge = 120 * 1_000_000 + 37; // millions of days + 37 steps
  const g = createGrid(dayField, 8, 8);
  gridFastForward(g, huge);
  assert.equal(g.clock, huge, `did not fold to the end clock (got ${g.clock})`);
  // Reference: 37 steps past a multiple of the period, reached after the attractor
  // is established — fold guarantees the same phase ⇒ same state (bar the clock).
  const ref = createGrid(dayField, 8, 8);
  gridFastForward(ref, 120 * 5 + 37); // same phase (mod 120), well past the transient
  const stripClock = (g: CellGrid) => gridSnap(g).replace(/"c":\d+/, '');
  assert.equal(stripClock(g), stripClock(ref), 'folded huge state differs from the congruent reference');
});

// 20. Integer-level transport (the idle-safe baseline): whole-unit diffusion
//     conserves, SPREADS the blob out into a locally-smooth field (every adjacent
//     gap ≤ 1 — the stable "no gap ≥ 2" rest), and reaches that rest CRISPLY and
//     FAST (no asymptotic ε-tail).
check('integer diffusion conserves, smooths, and halts crisply', () => {
  const g = createGrid(intDiffusion, 16, 16);
  for (const v of g.fields.units) assert.ok(Number.isInteger(v), 'int var has a non-integer value');
  const total0 = totalField(g, 'units');
  let peak0 = 0; for (const v of g.fields.units) peak0 = Math.max(peak0, v);
  const at = stepGridUntilRest(g, 2000);
  assert.ok(at > 0, `integer diffusion never settled (pending=${pendingCount(g)})`);
  assert.ok(at < 400, `integer diffusion should halt crisply/fast, took ${at} steps`);
  assert.equal(totalField(g, 'units'), total0, 'integer diffusion lost units (not conserved)');
  // The blob spread out (peak dropped) …
  let peak1 = 0; for (const v of g.fields.units) peak1 = Math.max(peak1, v);
  assert.ok(peak1 < peak0, `blob did not spread (peak ${peak0} → ${peak1})`);
  // … and the rest state is locally smooth: every cardinal neighbour within 1.
  let maxGap = 0;
  for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) {
    const v = g.fields.units[y * g.cols + x];
    if (x + 1 < g.cols) maxGap = Math.max(maxGap, Math.abs(v - g.fields.units[y * g.cols + x + 1]));
    if (y + 1 < g.rows) maxGap = Math.max(maxGap, Math.abs(v - g.fields.units[(y + 1) * g.cols + x]));
  }
  assert.ok(maxGap <= 1, `not locally smooth — a neighbour gap of ${maxGap} remains`);
});

// 21. Integer water pools in the basin (whole units) and halts exactly. Conserved.
check('integer puddle pools and halts exactly', () => {
  const g = createGrid(intPuddle, 16, 16);
  const total0 = totalField(g, 'water');
  const at = stepGridUntilRest(g, 2000);
  assert.ok(at > 0, `integer puddle never settled (pending=${pendingCount(g)})`);
  assert.equal(totalField(g, 'water'), total0, 'integer water not conserved');
  let best = -1, bx = 0, by = 0;
  for (let i = 0; i < g.fields.water.length; i++) if (g.fields.water[i] > best) { best = g.fields.water[i]; bx = i % g.cols; by = (i / g.cols) | 0; }
  assert.ok(Math.hypot(bx - 7.5, by - 7.5) < 5, `pool not central (at ${bx},${by})`);
});

// 22. The integer terrain (idle-safe default): rain runs off the heights into
//     water + greenery, the peak stays dry, and it NEVER floods (bounded shallow
//     water) — on both bounded and toroidal geometry. (Sustained rain ⇒ a bounded
//     foldable cycle, not strict rest; catch-up == stepping is checked by #6.)
for (const wrap of [false, true]) {
  check(`integer terrain: rivers + greenery, never floods (${wrap ? 'torus' : 'bounded'})`, () => {
    const g = createGrid(intTerrain, 32, 32, wrap);
    let peakH = -1, pi = 0;
    for (let i = 0; i < g.fields.height.length; i++) if (g.fields.height[i] > peakH) { peakH = g.fields.height[i]; pi = i; }
    for (let i = 0; i < 2500; i++) worldStep(g);
    let wmax = -Infinity, wet = 0, green = 0;
    for (let i = 0; i < g.fields.water.length; i++) { wmax = Math.max(wmax, g.fields.water[i]); if (g.fields.water[i] > 0) wet++; if (g.fields.plant[i] > 0) green++; }
    for (const v of g.fields.water) assert.ok(Number.isInteger(v), 'water is not integer');
    assert.ok(wet > 0, 'no water formed');
    assert.ok(green > 0, 'no greenery formed');
    assert.ok(g.fields.water[pi] <= 1, `peak should not pool water (water ${g.fields.water[pi]})`); // rain may transiently land then run off
    assert.ok(wmax < 12, `water unboundedly deep (max ${wmax}) — flooding`);
    assert.ok(wet < g.cols * g.rows * 0.7, `flooded — ${wet}/${g.cols * g.rows} wet`);
  });
}

// 23. Steady-rain integer terrain (constant per-cell rate, no rain clock): same
//     result — water + greenery, peak doesn't pool, never floods — and the integer
//     accumulator keeps it foldable (catch-up == stepping over a big span).
check('steady-rain integer terrain: water, no flood, foldable', () => {
  const g = createGrid(intTerrainSteady, 28, 28, false);
  let peakH = -1, pi = 0;
  for (let i = 0; i < g.fields.height.length; i++) if (g.fields.height[i] > peakH) { peakH = g.fields.height[i]; pi = i; }
  for (let i = 0; i < 2500; i++) worldStep(g);
  let wmax = -Infinity, wet = 0, green = 0;
  for (let i = 0; i < g.fields.water.length; i++) { wmax = Math.max(wmax, g.fields.water[i]); if (g.fields.water[i] > 0) wet++; if (g.fields.plant[i] > 0) green++; }
  assert.ok(wet > 0 && green > 0, 'steady rain made no water/greenery');
  assert.ok(g.fields.water[pi] <= 1, `peak should not pool (water ${g.fields.water[pi]})`);
  assert.ok(wmax < 12 && wet < g.cols * g.rows * 0.75, `flooded (max ${wmax}, wet ${wet})`);
  // Foldable: a big fast-forward equals stepping.
  const a = createGrid(intTerrainSteady, 12, 12), b = createGrid(intTerrainSteady, 12, 12);
  for (let i = 0; i < 600; i++) worldStep(a);
  gridFastForward(b, 600);
  assert.equal(gridSnap(a), gridSnap(b), 'steady-rain terrain fast-forward diverged from stepping');
});

// 24. Flow-accumulation rivers ("stabilise in motion"): the river field is a
//     static drainage network (downstream catchment > upstream, total conserved at
//     outlets), it adds NO dynamics so the world reaches true rest, and it RE-ROUTES
//     when the terrain is sculpted.
check('computed rivers: accumulate, reach rest, re-route on sculpt', () => {
  const g = createGrid(intRivers, 24, 24);
  // Every tile has at least its own unit of flow; downstream tiles have much more.
  let maxFlow = 0; for (const v of g.fields.river) maxFlow = Math.max(maxFlow, v);
  assert.ok(maxFlow > 50, `flow did not accumulate downstream (max ${maxFlow})`);
  assert.ok(g.fields.river.every(v => Number.isInteger(v) && v >= 1), 'flow not integer / missing base source');
  // It reaches TRUE rest (the river is static; only plants settle).
  const at = stepGridUntilRest(g, 4000);
  assert.ok(at > 0, `rivers world never settled (pending=${pendingCount(g)})`);
  let green = 0; for (const p of g.fields.plant) if (p > 0) green++;
  assert.ok(green > 0, 'no greenery along the rivers');
  // The river field is unchanged by stepping (no per-step water processing).
  const before = Array.from(g.fields.river);
  for (let i = 0; i < 50; i++) worldStep(g);
  assert.ok(g.fields.river.every((v, i) => v === before[i]), 'river field churned between steps (not static)');
  // Sculpting the terrain re-routes the drainage.
  for (let i = 0; i < g.cols * g.rows; i++) injectTile(g, i, 'height', 0); // touch height → flowDirty
  for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) g.fields.height[y * g.cols + x] = x < g.cols / 2 ? 40 : 5; // a cliff
  g.flowDirty = true;
  worldStep(g);
  const rerouted = Array.from(g.fields.river);
  assert.ok(rerouted.some((v, i) => v !== before[i]), 'river did not re-route after sculpting');
});

// --- Worldgen substrate (grand-dream world-content.md §1/§5) -------------------

/** A 24×24 two-biome map: a western plateau at height 50 (above the treeline
 *  of 40) and an eastern valley sloping to an outlet, with a channel along
 *  y=12 that the drainage concentrates into. Ore is seeded on the plateau. */
function makeSubstrate(): CellGrid {
  const g = createGrid(worldgenSubstrate, 24, 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const h = x < 6 ? 50 : Math.min(63, Math.max(3, 24 - x) + Math.abs(y - 12));
      g.fields.height[y * 24 + x] = h;
    }
  }
  g.flowDirty = true;
  seedOreAboveTreeline(g, { treeline: 40, maxOre: 15, seed: 7 });
  return g;
}

// 22. The canonical substrate settles into coherent biomes: fertility hugs the
//     valley drainage, ore sits above the treeline, and the two NEVER overlap
//     (the specialization engine is the map itself).
check('worldgen substrate settles into anti-correlated biomes', () => {
  const g = makeSubstrate();
  const at = stepGridUntilRest(g, 4000);
  assert.ok(at > 0, 'substrate never settled');

  const { fertility, ore, height, plant, people, lure } = g.fields;
  let fertileTiles = 0, oreTiles = 0, miningCamps = 0;
  for (let i = 0; i < fertility.length; i++) {
    if (fertility[i] > 0) {
      fertileTiles++;
      assert.ok(height[i] < 40, `fertile tile ${i} above the treeline`);
      assert.equal(ore[i], 0, `tile ${i} has both fertility and ore`);
    }
    if (ore[i] > 0) {
      oreTiles++;
      assert.ok(height[i] > 40, `ore tile ${i} below the treeline`);
      if (people[i] > 0) miningCamps++;
    }
    // Vegetation is a HALO around fertile ground (rivers render as water,
    // so grass only under the water would never be seen): a planted tile
    // must have fertility somewhere in its 3×3 neighbourhood.
    if (plant[i] > 0) {
      const x = i % g.cols, y = Math.floor(i / g.cols);
      let nearFert = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < g.cols && ny >= 0 && ny < g.rows) nearFert += fertility[ny * g.cols + nx];
        }
      }
      assert.ok(nearFert > 0, `plants with no fertility in reach at ${i}`);
    }
    // Sugarscape: people live where SOME resource lures them, nowhere else.
    if (people[i] > 0) assert.ok(lure[i] > 0, `people on land with no lure at ${i}`);
  }
  assert.ok(fertileTiles >= 10, `too little fertile land (${fertileTiles})`);
  assert.ok(oreTiles >= 5, `too few ore veins (${oreTiles})`);
  // Both resources hold population: valley farmers AND proto-mining camps.
  assert.ok(miningCamps >= 3, `ore country should hold people (got ${miningCamps} camp tiles)`);
  let peopleTotal = 0;
  for (let i = 0; i < people.length; i++) {
    peopleTotal += people[i];
    if (lure[i] >= 8) assert.ok(people[i] >= lure[i], `underpopulated attractive tile ${i}`);
  }
  assert.ok(peopleTotal > 100, `world too empty (${peopleTotal} people)`);
});

// 23. Substrate catch-up == stepping (the idle-safety contract, on the real spec).
check('worldgen substrate fast-forward equals stepping', () => {
  const a = makeSubstrate();
  const b = makeSubstrate();
  for (let i = 0; i < 800; i++) worldStep(a);
  gridFastForward(b, 800);
  assert.equal(gridSnap(a), gridSnap(b), 'substrate fast-forward diverged');
});

// 24. Founding detection: crowds propose cities in BOTH biomes —
//     deterministic, spaced, blockable, and resource-weighted ranking
//     (the Sugarscape / future supply-demand hook) steers which biome wins.
check('founding sites emerge in both biomes; resource weights rank them', () => {
  const g = makeSubstrate();
  assert.ok(stepGridUntilRest(g, 4000) > 0, 'substrate never settled');

  const opts = { threshold: 150, radius: 2, minSpacing: 6 };
  const sites = findFoundingSites(g, opts);
  assert.ok(sites.length >= 2, `expected candidates in both biomes (got ${sites.length})`);
  assert.ok(sites.some(s => g.fields.height[s.cell] < 40), 'no valley (farm) candidate');
  assert.ok(sites.some(s => g.fields.height[s.cell] > 40), 'no highland (mine) candidate');
  for (const s of sites) assert.ok(s.density >= opts.threshold, 'candidate below the crowd threshold');
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const dx = sites[i].x - sites[j].x, dy = sites[i].y - sites[j].y;
      assert.ok(dx * dx + dy * dy >= opts.minSpacing ** 2, 'candidates too close together');
    }
  }
  assert.equal(JSON.stringify(findFoundingSites(g, opts)), JSON.stringify(sites), 'detection not deterministic');

  // Resource weighting re-ranks: a heavy ore weight puts a mine town first,
  // a heavy fertility weight puts a farm town first. (This is where the
  // settlement layer's scarcity signals will plug in.)
  const oreFirst = findFoundingSites(g, { ...opts, score: [{ field: 'ore', weight: 10 }] });
  assert.ok(g.fields.height[oreFirst[0].cell] > 40, 'ore weighting should rank a highland site first');
  const farmFirst = findFoundingSites(g, { ...opts, score: [{ field: 'fertility', weight: 10 }] });
  assert.ok(g.fields.height[farmFirst[0].cell] < 40, 'fertility weighting should rank a valley site first');

  // A city already sitting on the best spot suppresses its neighborhood.
  const blocked = findFoundingSites(g, { ...opts, occupied: [[sites[0].x, sites[0].y]] });
  assert.ok(blocked.every(s => {
    const dx = s.x - sites[0].x, dy = s.y - sites[0].y;
    return dx * dx + dy * dy >= opts.minSpacing ** 2;
  }), 'occupied spacing not respected');
});

// 25. Life must also DIE BACK: dam the river and the abandoned bed loses its
//     fertility and vegetation COMPLETELY — no ghost values. (Regression for
//     the integer toward ε-tail: a sub-unit decay step rounded back up at
//     commit, so fertility rested at 1 forever and old greenery never
//     cleared off re-routed riverbeds. intTowardStep finishes the tail.)
check('dammed river: fertility and vegetation die back to zero', () => {
  const g = makeSubstrate();
  assert.ok(stepGridUntilRest(g, 4000) > 0, 'substrate never settled');

  // The channel runs along y=12; remember its fertile tiles mid-valley.
  const bed: number[] = [];
  for (let x = 10; x < 20; x++) {
    const c = 12 * 24 + x;
    if (g.fields.fertility[c] > 0) bed.push(c);
  }
  assert.ok(bed.length >= 4, `expected a fertile channel to dam (got ${bed.length})`);

  // Dam: wall the valley off just downstream of the plateau.
  for (let y = 0; y < 24; y++) {
    for (let x = 7; x <= 8; x++) {
      const c = y * 24 + x;
      injectTile(g, c, 'height', 60 - g.fields.height[c]);
    }
  }
  assert.ok(stepGridUntilRest(g, 4000) > 0, 'dammed substrate never re-settled');

  for (const c of bed) {
    if (g.fields.river[c] > 15) continue; // still watered by a re-route
    assert.equal(g.fields.fertility[c], 0, `ghost fertility at ${c}`);
    assert.equal(g.fields.plant[c], 0, `ghost vegetation at ${c}`);
  }
  // And globally: nothing anywhere keeps fertility without the water for it.
  for (let i = 0; i < g.fields.fertility.length; i++) {
    if (g.fields.river[i] <= 15 && g.fields.fertility[i] > 0) {
      assert.fail(`stale fertility at ${i} (river ${g.fields.river[i]})`);
    }
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
