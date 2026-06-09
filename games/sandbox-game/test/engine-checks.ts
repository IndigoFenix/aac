// Sandbox Game — engine checks. Pure-logic assertions, no DOM/React.
// Run:  npx tsx games/sandbox-game/test/engine-checks.ts
//
// (The repo's Jest is scoped to server/ only; the game engine is framework-free
//  so a standalone tsx script is the lightest way to guard its invariants.)

import assert from 'node:assert/strict';
import {
  createNewGame, worldStep, catchUp, pourWater, wakeAll,
  serializeState, deserializeState, setWrap, stats,
} from '../src/engine.ts';
import { applyBrush, conservationError } from '../src/sculpt.ts';
import { getSim, pendingCount } from '../src/sim.ts';
import { recomputeTotalSand, idx, cellAt } from '../src/grid.ts';
import { WORLD_STEP_MS, BASELINE_HEIGHT, BRUSH, ECO, FERT } from '../src/config.ts';
import type { GameState } from '../src/types.ts';

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

// Deterministic PRNG so the "random sculpting" check is reproducible.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function buildHill(state: GameState, cx: number, cy: number, peak: number, radius: number) {
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < radius) {
        const h = BASELINE_HEIGHT + (peak - BASELINE_HEIGHT) * (1 - d / radius);
        state.cells[idx(state, x, y)].height = h;
      }
    }
  }
  recomputeTotalSand(state);
}

function maxBy(state: GameState, sel: (c: GameState['cells'][number]) => number) {
  let best = -Infinity, bx = 0, by = 0;
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const v = sel(cellAt(state, x, y));
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  return { value: best, x: bx, y: by };
}

console.log('Sandbox engine checks:');

// 1. Sand conservation under random sculpting.
check('brush (push + slump) conserves total sand', () => {
  const state = createNewGame();
  const rng = makeRng(42);
  for (let i = 0; i < 4000; i++) {
    const gx = rng() * state.cols;
    const gy = rng() * state.rows;
    const vx = (rng() - 0.5) * 2;
    const vy = (rng() - 0.5) * 2;
    applyBrush(state, gx, gy, vx, vy);
  }
  assert.ok(conservationError(state) < 1e-6, `conservation drift = ${conservationError(state)}`);
  // And sculpting actually moved sand (terrain is no longer flat).
  const hi = maxBy(state, c => c.height).value;
  assert.ok(hi > BASELINE_HEIGHT + 0.5, `expected hills to form, max height = ${hi}`);
});

// 2. A spring emerges off the peak; the peak itself stays dry.
check('spring emerges below the peak, not on it', () => {
  const state = createNewGame();
  buildHill(state, 16, 16, 34, 9); // a real hill at the baseline-16 scale (+18)
  wakeAll(state); // terrain built directly → wake the grid for the scheduler
  const peak = maxBy(state, c => c.height);
  for (let i = 0; i < 600; i++) worldStep(state);

  const wettest = maxBy(state, c => c.water);
  assert.ok(wettest.value > ECO.waterMin, `no spring formed (max water = ${wettest.value})`);
  const peakWater = cellAt(state, peak.x, peak.y).water;
  assert.ok(peakWater <= ECO.waterMin, `peak should be dry but has water = ${peakWater}`);
  // The spring should be lower ground than the peak.
  assert.ok(
    cellAt(state, wettest.x, wettest.y).height < cellAt(state, peak.x, peak.y).height,
    'spring should sit on lower ground than the peak',
  );
});

// 3. Surface water pools in the lowest basin.
check('water pools in the lowest basin', () => {
  const state = createNewGame();
  // Bowl: raise a rim, leave a low centre.
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const d = Math.hypot(x - 16, y - 16);
      cellAt(state, x, y).height = BASELINE_HEIGHT + d * 0.6; // centre lowest
    }
  }
  recomputeTotalSand(state);
  wakeAll(state); // terrain built directly → wake the grid for the scheduler
  // Pour all over, then let it settle.
  for (let i = 0; i < 20; i++) {
    for (let y = 4; y < state.rows - 4; y += 3)
      for (let x = 4; x < state.cols - 4; x += 3) pourWater(state, x, y, 1);
    worldStep(state);
  }
  // Short settle (an UNFED pool legitimately evaporates over many idle steps).
  for (let i = 0; i < 3; i++) worldStep(state);
  const wettest = maxBy(state, c => c.water);
  assert.ok(wettest.value > ECO.waterMin, `expected a pool (max water = ${wettest.value})`);
  assert.ok(
    Math.hypot(wettest.x - 16, wettest.y - 16) <= 4,
    `pool should be near the basin centre, was at (${wettest.x},${wettest.y})`,
  );
});

// 4. A water source greens the fertile ZONE around it, then it recedes when dry.
const greenInRegion = (state: GameState, cx: number, cy: number, rad: number) => {
  let max = 0;
  for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
    if (x < 0 || x >= state.cols || y < 0 || y >= state.rows) continue;
    const c = cellAt(state, x, y);
    if (c.water <= ECO.plantWaterMax) max = Math.max(max, c.plant);
  }
  return max;
};
check('water greens its surroundings, recedes when dry', () => {
  const state = createNewGame();
  for (let i = 0; i < 90; i++) { pourWater(state, 16, 16, 1); worldStep(state); }
  const grown = greenInRegion(state, 16, 16, 4);
  assert.ok(grown > 0.1, `surroundings should green (max plant = ${grown})`);

  for (let i = 0; i < 250; i++) worldStep(state); // source removed
  const after = greenInRegion(state, 16, 16, 4);
  assert.ok(after < grown * 0.6, `green should recede when dry (${grown}→${after})`);
});

// 5. catchUp(big jump) == stepping one-by-one (deterministic, no randomness).
check('catch-up equals manual stepping', () => {
  const N = 120;
  const a = createNewGame();
  const b = createNewGame();
  buildHill(a, 16, 16, 20, 8);
  buildHill(b, 16, 16, 20, 8);
  wakeAll(a);
  wakeAll(b);

  for (let i = 0; i < N; i++) worldStep(a);

  const now = b.lastUpdateTime + N * WORLD_STEP_MS;
  catchUp(b, now);

  let maxDiff = 0;
  for (let i = 0; i < a.cells.length; i++) {
    maxDiff = Math.max(
      maxDiff,
      Math.abs(a.cells[i].height - b.cells[i].height),
      Math.abs(a.cells[i].moisture - b.cells[i].moisture),
      Math.abs(a.cells[i].water - b.cells[i].water),
      Math.abs(a.cells[i].plant - b.cells[i].plant),
    );
  }
  assert.ok(maxDiff < 1e-9, `catch-up diverged from manual stepping (maxDiff = ${maxDiff})`);
});

// 6. Rough (brush-sculpted) terrain must NOT drown the map and must settle.
//    Regression guard for the "tiny islands, rest is water, never settles" bug.
check('rough terrain stays mostly land and settles', () => {
  const state = createNewGame();
  // Sculpt like a player: a momentum-carrying random gaze walk.
  const rng = makeRng(7);
  let gx = state.cols / 2, gy = state.rows / 2, vx = 0, vy = 0;
  for (let i = 0; i < 6000; i++) {
    if (rng() < 0.05) { gx = rng() * state.cols; gy = rng() * state.rows; }
    vx = vx * 0.8 + (rng() - 0.5) * 1.2;
    vy = vy * 0.8 + (rng() - 0.5) * 1.2;
    gx = Math.max(0, Math.min(state.cols - 1, gx + vx));
    gy = Math.max(0, Math.min(state.rows - 1, gy + vy));
    applyBrush(state, gx, gy, vx, vy);
  }
  recomputeTotalSand(state);

  const wetCount = () => state.cells.reduce((a, c) => a + (c.water > ECO.waterMin ? 1 : 0), 0);
  for (let i = 0; i < 2000; i++) worldStep(state);
  const early = wetCount();
  for (let i = 0; i < 2000; i++) worldStep(state);
  const late = wetCount();
  const total = state.cols * state.rows;

  assert.ok(late / total < 0.45, `rough terrain drowned: ${late}/${total} wet`);
  assert.ok(Math.abs(late - early) / total < 0.1, `did not settle: ${early}→${late} wet`);
});

// 7. Disturbing sand dissipates its groundwater — sculpting can't conjure water.
//    Regression for "a dug basin (or the pile) fills with water from nowhere".
check('sculpting dissipates moisture, no phantom water', () => {
  const state = createNewGame();
  // A charged region: tall ground with a high hidden water table.
  for (let y = 14; y <= 18; y++) for (let x = 14; x <= 18; x++) { cellAt(state, x, y).height = 12; cellAt(state, x, y).moisture = 10; }
  recomputeTotalSand(state);
  const moistBefore = state.cells.reduce((a, c) => a + c.moisture, 0);

  // Sculpt across it (digging some cells, piling others).
  for (let pass = 0; pass < 6; pass++) {
    const x0 = pass % 2 ? 22 : 10, x1 = pass % 2 ? 10 : 22;
    const steps = 40, sx = (x1 - x0) / steps;
    let px = x0;
    for (let i = 0; i < steps; i++) { px += sx; applyBrush(state, px, 16, sx, 0); }
  }
  // Every brushed cell must sit below its spring threshold (won't surge), and
  // sculpting must not have INCREASED total groundwater anywhere.
  for (let y = 14; y <= 18; y++) for (let x = 8; x <= 24; x++) {
    const c = cellAt(state, x, y);
    assert.ok(c.moisture <= c.height * ECO.springBreach + 1e-9,
      `brushed cell over-charged at ${x},${y} (moist=${c.moisture}, h=${c.height})`);
  }
  const moistAfter = state.cells.reduce((a, c) => a + c.moisture, 0);
  assert.ok(moistAfter <= moistBefore + 1e-9, `sculpting created moisture (${moistBefore}→${moistAfter})`);
});

// 8. Pooled water settles flat instead of two tiles trading it forever.
//    Regression for the CFL-unstable flow that ping-ponged lake cells.
check('pooled water settles (no two-tile oscillation)', () => {
  const state = createNewGame();
  buildHill(state, 16, 16, 22, 8);                 // a spring source
  for (let y = 14; y <= 18; y++) for (let x = 22; x <= 26; x++) cellAt(state, x, y).height = 2; // a basin to fill
  recomputeTotalSand(state);
  wakeAll(state); // terrain built directly → wake the grid for the scheduler
  for (let i = 0; i < 1500; i++) worldStep(state);  // reach quasi-steady

  const N = 14;
  const hist: number[][] = [];
  for (let i = 0; i < N; i++) { worldStep(state); hist.push(state.cells.map(c => c.water)); }
  let oscillating = 0;
  for (let c = 0; c < state.cells.length; c++) {
    let flips = 0, last = 0;
    for (let i = 1; i < N; i++) {
      const d = hist[i][c] - hist[i - 1][c];
      if (Math.abs(d) < 0.01) continue;
      const sign = Math.sign(d);
      if (last !== 0 && sign !== last) flips++;
      last = sign;
    }
    if (flips >= 3) oscillating++;
  }
  assert.equal(oscillating, 0, `${oscillating} cells oscillate instead of settling`);
});

// 9. A water source grows a CONTAINED green oasis (zone wider than the water,
//    but the map stays mostly desert). Guards the "fertile zone" mechanic.
check('water grows a contained green oasis', () => {
  const state = createNewGame();
  // Pour realistically (many pour-frames per world-step, as the live loop does).
  for (let step = 0; step < 80; step++) {
    if (step < 50) for (let f = 0; f < 50; f++) pourWater(state, 16, 16, 1);
    worldStep(state);
  }
  let green = 0, offWater = 0;
  for (const c of state.cells) if (c.plant > 0.05) { green++; if (c.water < ECO.waterMin) offWater++; }
  const total = state.cols * state.rows;
  assert.ok(green >= 12, `oasis too small (${green} green)`);
  assert.ok(offWater > 0, 'green should extend onto land beyond the water itself');
  assert.ok(green < total * 0.25, `oasis not contained — green took over (${green}/${total})`);
});

// ─── Scheduler invariants (the event-driven engine) ──────────────────────────

/** Sculpt a momentum-walked rough terrain (same generator as check #6). */
function sculptRough(state: GameState, seed: number, strokes = 6000) {
  const rng = makeRng(seed);
  let gx = state.cols / 2, gy = state.rows / 2, vx = 0, vy = 0;
  for (let i = 0; i < strokes; i++) {
    if (rng() < 0.05) { gx = rng() * state.cols; gy = rng() * state.rows; }
    vx = vx * 0.8 + (rng() - 0.5) * 1.2;
    vy = vy * 0.8 + (rng() - 0.5) * 1.2;
    gx = Math.max(0, Math.min(state.cols - 1, gx + vx));
    gy = Math.max(0, Math.min(state.rows - 1, gy + vy));
    applyBrush(state, gx, gy, vx, vy);
  }
  recomputeTotalSand(state);
}

/** Step until the schedule empties (rest), or return -1 if it never does. */
function stepUntilRest(state: GameState, cap: number): number {
  const sim = getSim(state);
  for (let i = 1; i <= cap; i++) {
    worldStep(state);
    if (pendingCount(sim) === 0) return i;
  }
  return -1;
}

// 10. A settled world schedules NO further work — cost tracks change, not size.
check('a settled world does zero work', () => {
  const state = createNewGame();
  buildHill(state, 16, 16, 22, 9);
  wakeAll(state);
  const restAt = stepUntilRest(state, 4000);
  assert.ok(restAt > 0, 'world never reached an empty schedule');
  stats.processed = 0;
  for (let i = 0; i < 300; i++) worldStep(state);
  assert.equal(stats.processed, 0, `settled world still processed ${stats.processed} cells`);
});

// 11. Even messy, multi-basin terrain reaches rest in a bounded number of steps.
check('rough terrain reaches rest within a bounded number of steps', () => {
  const state = createNewGame();
  sculptRough(state, 7);
  const restAt = stepUntilRest(state, 8000);
  assert.ok(restAt > 0, `rough terrain never settled (pending=${pendingCount(getSim(state))})`);
});

// 12. The scheduler never schedules a task for a past/current step (the property
//     that makes the clock advance monotonically ⇒ no livelock).
check('scheduler only schedules strictly-future steps', () => {
  const state = createNewGame();
  buildHill(state, 12, 12, 20, 7);
  wakeAll(state);
  const sim = getSim(state);
  for (let i = 0; i < 300; i++) {
    worldStep(state);
    for (const k of sim.buckets.keys()) {
      assert.ok(k > state.clock, `task scheduled at step ${k} but clock is ${state.clock}`);
    }
  }
});

// 13. Saving mid-evolution and reloading continues the world IDENTICALLY — the
//     in-flight schedule survives serialization, so an absent player's world
//     evolves exactly as a watching one's would.
check('save/reload mid-evolution continues identically', () => {
  const N = 240;
  const live = createNewGame(); buildHill(live, 16, 16, 22, 9); wakeAll(live);
  const split = createNewGame(); buildHill(split, 16, 16, 22, 9); wakeAll(split);
  for (let i = 0; i < N; i++) worldStep(live);
  for (let i = 0; i < N / 2; i++) worldStep(split);
  const reloaded = deserializeState(serializeState(split));
  assert.ok(reloaded, 'reload failed');
  for (let i = 0; i < N / 2; i++) worldStep(reloaded!);
  assert.equal(reloaded!.clock, live.clock, `clock mismatch ${reloaded!.clock} vs ${live.clock}`);
  let maxDiff = 0;
  for (let i = 0; i < live.cells.length; i++) {
    const a = live.cells[i], b = reloaded!.cells[i];
    maxDiff = Math.max(maxDiff,
      Math.abs(a.height - b.height), Math.abs(a.moisture - b.moisture),
      Math.abs(a.water - b.water), Math.abs(a.fertility - b.fertility), Math.abs(a.plant - b.plant));
  }
  assert.ok(maxDiff < 1e-9, `reloaded run diverged from the live one (maxDiff=${maxDiff})`);
});

// 14. THE termination guarantee: for wildly randomized physics parameters the
//     world must STILL reach rest. Structural stability (clamped monotone
//     transfers, bounded sources, floored sinks, strict-future scheduling) means
//     a number can only change settling SPEED, never whether it settles.
check('terminates for randomized physics parameters', () => {
  const ecoSave = { ...ECO }, fertSave = { ...FERT };
  try {
    for (let trial = 0; trial < 8; trial++) {
      const rng = makeRng(1000 + trial * 7);
      ECO.moistGain = ecoSave.moistGain * (0.2 + 2 * rng());
      ECO.moistDiffuseRate = 0.1 + 1.8 * rng();   // clamped ≤ 1 internally
      ECO.waterFlow = 0.05 + 0.9 * rng();          // clamped to STABLE_REDIST_RATE
      ECO.evap = ecoSave.evap * (0.3 + 2.5 * rng());
      ECO.springRate = ecoSave.springRate * (0.3 + 3 * rng());
      ECO.moistDecay = ecoSave.moistDecay * (0.2 + 4 * rng());
      ECO.erodeRate = ecoSave.erodeRate * (0.2 + 3 * rng());
      FERT.diffuseRate = 0.05 + 0.9 * rng();
      FERT.decay = fertSave.decay * (0.3 + 2.5 * rng());
      FERT.plantGrow = fertSave.plantGrow * (0.3 + 3 * rng());
      FERT.plantDecay = fertSave.plantDecay * (0.3 + 3 * rng());
      const state = createNewGame();
      buildHill(state, 16, 16, 18 + rng() * 10, 6 + rng() * 5);
      wakeAll(state);
      const restAt = stepUntilRest(state, 12000);
      assert.ok(restAt > 0,
        `trial ${trial} never terminated (pending=${pendingCount(getSim(state))})`);
    }
  } finally {
    Object.assign(ECO, ecoSave);
    Object.assign(FERT, fertSave);
  }
});

// 15. Catch-up over a long absence on a SETTLED world is ~free (it jumps across
//     the empty schedule instead of replaying every step).
check('catch-up over a settled world is ~free', () => {
  const state = createNewGame();
  buildHill(state, 16, 16, 22, 9);
  wakeAll(state);
  assert.ok(stepUntilRest(state, 4000) > 0, 'precondition: world should settle');
  state.lastUpdateTime = Date.now() - 100_000 * WORLD_STEP_MS; // pretend a huge absence
  stats.processed = 0;
  catchUp(state, Date.now());
  assert.ok(stats.processed < 50, `settled catch-up did real work: ${stats.processed} cells`);
});

// ─── Elevation scale (tall mountains, multi-sweep structural control) ────────

/** One sculpt "sweep": slow parallel drags gathering sand toward the centre
 *  column from both edges (how a player piles a central massif). */
function gatherSweep(state: GameState) {
  for (let y = 6; y < state.rows - 6; y += 2) {
    let px = 2;
    for (let i = 0; i < 14; i++) { applyBrush(state, px, y, 1, 0); px += 1; }
    let qx = state.cols - 2;
    for (let i = 0; i < 14; i++) { applyBrush(state, qx, y, -1, 0); qx -= 1; }
  }
}

// 16. A PROPER mountain takes several sweeps to raise — one drag must not max it
//     out (stronger, deliberate structural control), and sand stays conserved.
check('building a mountain takes multiple sweeps', () => {
  const state = createNewGame();
  gatherSweep(state);
  recomputeTotalSand(state);
  const afterOne = Math.max(...state.cells.map(c => c.height)) - BASELINE_HEIGHT;
  for (let i = 0; i < 9; i++) gatherSweep(state);
  const afterTen = Math.max(...state.cells.map(c => c.height)) - BASELINE_HEIGHT;
  assert.ok(conservationError(state) < 1e-6, `sand drift ${conservationError(state)}`);
  assert.ok(afterTen > 22, `ten sweeps should raise a tall peak (got +${afterTen.toFixed(1)})`);
  assert.ok(afterOne < 0.5 * afterTen,
    `one sweep should not get you most of the way (one +${afterOne.toFixed(1)} vs ten +${afterTen.toFixed(1)})`);
});

// 17. The water table still works at the bigger elevation scale: a TALL mountain
//     springs at its foot (below the peak), greens an oasis, and doesn't drown.
check('a tall mountain springs at its foot at the new scale', () => {
  const state = createNewGame();
  for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
    const d = Math.hypot(x - 16, y - 16);
    if (d < 11) cellAt(state, x, y).height = BASELINE_HEIGHT + (44 - BASELINE_HEIGHT) * (1 - d / 11);
  }
  recomputeTotalSand(state);
  wakeAll(state);
  const peakH = maxBy(state, c => c.height).value;
  for (let i = 0; i < 1500; i++) worldStep(state);
  const wettest = maxBy(state, c => c.water);
  const green = state.cells.reduce((a, c) => a + (c.plant > 0.05 ? 1 : 0), 0);
  const wet = state.cells.reduce((a, c) => a + (c.water > ECO.waterMin ? 1 : 0), 0);
  assert.ok(wettest.value > ECO.waterMin, `tall mountain produced no spring (max water ${wettest.value})`);
  assert.ok(cellAt(state, wettest.x, wettest.y).height < peakH - 1, 'spring should sit below the peak');
  assert.ok(green > 20, `tall mountain should green an oasis (green=${green})`);
  assert.ok(wet < state.cols * state.rows * 0.45, `tall mountain drowned the map (${wet} wet)`);
});

// ─── Toroidal (wrap-around) geometry ─────────────────────────────────────────

const colSum = (state: GameState, x0: number, x1: number) => {
  let s = 0;
  for (let y = 0; y < state.rows; y++) for (let x = x0; x <= x1; x++) s += cellAt(state, x, y).height;
  return s;
};

// 18. On a torus, sand pushed off one edge re-enters the opposite edge — sculpt
//     that runs off the edges must still conserve sand exactly.
check('toroidal sculpting conserves sand across the seam', () => {
  const state = createNewGame();
  setWrap(state, true);
  const rng = makeRng(11);
  let gx = 1, gy = 1, vx = 0, vy = 0;
  for (let i = 0; i < 3000; i++) {
    vx = vx * 0.8 + (rng() - 0.5) * 1.6;
    vy = vy * 0.8 + (rng() - 0.5) * 1.6;
    gx = ((gx + vx) % state.cols + state.cols) % state.cols; // gaze itself wraps around
    gy = ((gy + vy) % state.rows + state.rows) % state.rows;
    applyBrush(state, gx, gy, vx, vy);
  }
  assert.ok(conservationError(state) < 1e-6, `wrap sculpt drift = ${conservationError(state)}`);
});

// 19. Edges genuinely connect: sand pushed off the LEFT edge arrives at the RIGHT
//     edge (only reachable via wrap), which a bounded map would never do.
check('toroidal edges connect (push off one edge arrives at the other)', () => {
  const state = createNewGame();
  setWrap(state, true);
  const rightBefore = colSum(state, state.cols - 4, state.cols - 1);
  for (let i = 0; i < 80; i++) applyBrush(state, 0.5, 16, -2, 0); // pile at x≈0 moving −x
  const rightAfter = colSum(state, state.cols - 4, state.cols - 1);
  assert.ok(rightAfter > rightBefore + 1,
    `sand pushed off the left edge should build up at the right edge (${rightBefore.toFixed(1)}→${rightAfter.toFixed(1)})`);
  assert.ok(conservationError(state) < 1e-6, `drift ${conservationError(state)}`);
});

// 20. The scheduler / termination guarantees still hold under toroidal topology:
//     a sculpted wrap-world reaches rest (no edge drain ⇒ evaporation only).
check('a toroidal world reaches rest', () => {
  const state = createNewGame();
  setWrap(state, true);
  sculptRough(state, 23, 4000);
  const restAt = stepUntilRest(state, 8000);
  assert.ok(restAt > 0, `toroidal world never settled (pending=${pendingCount(getSim(state))})`);
});

// ─── Brush interactions with water / soil / plants ───────────────────────────

// 21. Digging through water drags it along the gaze direction.
check('the brush shoves surface water', () => {
  const state = createNewGame();
  for (let y = 12; y <= 20; y++) for (let x = 12; x <= 20; x++) cellAt(state, x, y).height = 0; // dug flat → no sand moves
  cellAt(state, 16, 16).water = 3;
  applyBrush(state, 16, 16, 1, 0); // push +x
  assert.ok(cellAt(state, 17, 16).water > 0, 'water should be shoved toward the gaze direction');
  assert.ok(cellAt(state, 16, 16).water < 3, 'source water should drop');
});

// 22. Sand pushed into deep water SINKS — the bed rises but the water keeps
//     covering it (it is not destroyed; it recedes only through the ecology).
check('sand pushed into deep water stays submerged', () => {
  const state = createNewGame();
  cellAt(state, 16, 16).height = 30;   // tall dry source
  cellAt(state, 17, 16).water = 8;     // deep water target
  const hBefore = cellAt(state, 17, 16).height;
  applyBrush(state, 16, 16, 1, 0);
  const t = cellAt(state, 17, 16);
  assert.ok(t.height > hBefore, 'the dumped sand should raise the bed');
  assert.ok(t.water >= ECO.waterMin, 'deep water should keep covering the sand, not vanish');
});

// 22a. Sand that FILLS shallow water absorbs it immediately (no waiting a step).
check('sand filling shallow water absorbs it on contact', () => {
  const state = createNewGame();
  cellAt(state, 16, 16).height = 30;   // tall source → sand exceeds the water depth
  cellAt(state, 17, 16).water = 1;     // shallow
  applyBrush(state, 16, 16, 1, 0);
  const t = cellAt(state, 17, 16);
  assert.equal(t.water, 0, 'sand reaching the surface should absorb the water right away');
  assert.ok(t.fertility > 0, 'the absorbed water should wet the sand (fertility up)');
});

// 22b. Burying plants bares the soil, so they don't instantly regrow.
check('buried plants stay buried (no instant regrowth)', () => {
  const state = createNewGame();
  cellAt(state, 16, 16).fertility = 1;
  cellAt(state, 16, 16).plant = 0.8;
  cellAt(state, 15, 16).height = 40;        // a tall neighbour to shove sand over it
  for (let i = 0; i < 3; i++) applyBrush(state, 15, 16, 1, 0); // push +x, burying (16,16)
  assert.ok(cellAt(state, 16, 16).plant < 0.1, 'sand should bury the plants');
  wakeAll(state);
  for (let i = 0; i < 5; i++) worldStep(state);
  assert.ok(cellAt(state, 16, 16).plant < 0.2, 'a buried plant must not instantly regrow');
});

// 23. Vegetation roots the soil: it can't be dug until the plants are cleared,
//     and each pass strips them.
check('plants root the soil against digging', () => {
  const state = createNewGame();
  for (let y = 12; y <= 20; y++) for (let x = 12; x <= 20; x++) cellAt(state, x, y).height = 0; // neighbours can't add sand
  cellAt(state, 16, 16).height = 20;
  cellAt(state, 16, 16).plant = 0.8;
  applyBrush(state, 16, 16, 1, 0);
  assert.equal(cellAt(state, 16, 16).height, 20, 'rooted soil should not be dug while vegetated');
  assert.ok(cellAt(state, 16, 16).plant < 0.8, 'the pass should strip vegetation');
  for (let i = 0; i < 80; i++) applyBrush(state, 16, 16, 1, 0);
  assert.ok(cellAt(state, 16, 16).plant <= BRUSH.plantArmor, 'repeated passes clear the plants');
  assert.ok(cellAt(state, 16, 16).height < 20, 'once cleared, the soil can be dug');
});

// 24. Sand dumped on top of plants buries them.
check('sand dumped on plants buries them', () => {
  const state = createNewGame();
  cellAt(state, 16, 16).height = 30;   // source
  cellAt(state, 17, 16).plant = 0.9;   // planted target
  applyBrush(state, 16, 16, 1, 0);     // push sand 16→17 onto the plants
  assert.ok(cellAt(state, 17, 16).plant < 0.9, 'burying plants in sand should destroy them');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
