// Sandbox Game — engine checks. Pure-logic assertions, no DOM/React.
// Run:  npx tsx games/sandbox-game/test/engine-checks.ts
//
// (The repo's Jest is scoped to server/ only; the game engine is framework-free
//  so a standalone tsx script is the lightest way to guard its invariants.)

import assert from 'node:assert/strict';
import { createNewGame, worldStep, catchUp, pourWater } from '../src/engine.ts';
import { applyBrush, conservationError } from '../src/sculpt.ts';
import { recomputeTotalSand, idx, cellAt } from '../src/grid.ts';
import { WORLD_STEP_MS, BASELINE_HEIGHT, ECO } from '../src/config.ts';
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
check('sweep/gather conserve total sand', () => {
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
  buildHill(state, 16, 16, 22, 9);
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
  // Pour all over, then let it settle.
  for (let i = 0; i < 20; i++) {
    for (let y = 4; y < state.rows - 4; y += 3)
      for (let x = 4; x < state.cols - 4; x += 3) pourWater(state, x, y, 1);
    worldStep(state);
  }
  for (let i = 0; i < 60; i++) worldStep(state);
  const wettest = maxBy(state, c => c.water);
  assert.ok(wettest.value > ECO.waterMin, `expected a pool (max water = ${wettest.value})`);
  assert.ok(
    Math.hypot(wettest.x - 16, wettest.y - 16) <= 4,
    `pool should be near the basin centre, was at (${wettest.x},${wettest.y})`,
  );
});

// 4. Plants grow under sustained wetness, then die when it dries out.
check('plants grow when wet and die when dry', () => {
  const state = createNewGame();
  const wetSteps = ECO.plantGrowAfter + 30;
  for (let i = 0; i < wetSteps; i++) {
    pourWater(state, 16, 16, 1); // keep shallow water topped up
    worldStep(state);
  }
  const grown = cellAt(state, 16, 16).plant;
  assert.ok(grown > 0.1, `plant should have grown, density = ${grown}`);

  for (let i = 0; i < 80; i++) worldStep(state); // no more water
  const after = cellAt(state, 16, 16).plant;
  assert.ok(after < grown, `plant should decay when dry (${after} !< ${grown})`);
});

// 5. catchUp(big jump) == stepping one-by-one (deterministic, no randomness).
check('catch-up equals manual stepping', () => {
  const N = 120;
  const a = createNewGame();
  const b = createNewGame();
  buildHill(a, 16, 16, 20, 8);
  buildHill(b, 16, 16, 20, 8);

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

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
