// Sandbox Game — field-simulation engine (pure logic, no React/DOM).
//
// Keeps the original "tick + catch-up-on-load" philosophy, but as a fixed-step
// FIELD simulation over a height grid rather than a per-cell timer/rule queue.
// One `worldStep` advances the ecology; `catchUp` resolves missed steps after
// an absence (capped — the sim settles to near-equilibrium long before the cap).

import type { GameState, TerrainCell } from './types';
import { SAVE_VERSION } from './types';
import {
  GRID_COLS, GRID_ROWS, BASELINE_HEIGHT,
  WORLD_STEP_MS, MAX_CATCHUP_STEPS, ECO, POUR,
} from './config';
import { idx, inBounds, recomputeTotalSand } from './grid';

// --- Factory ------------------------------------------------------------------

export function createNewGame(cols = GRID_COLS, rows = GRID_ROWS): GameState {
  const cells: TerrainCell[] = [];
  for (let i = 0; i < cols * rows; i++) {
    cells.push({ height: BASELINE_HEIGHT, moisture: 0, water: 0, plant: 0, wetTime: 0 });
  }
  return {
    version: SAVE_VERSION,
    cols,
    rows,
    cells,
    lastUpdateTime: Date.now(),
    totalSand: cols * rows * BASELINE_HEIGHT,
  };
}

// --- Neighbour index helper (cardinal, in-bounds) -----------------------------

function neighbourIdx(state: GameState, x: number, y: number): number[] {
  const out: number[] = [];
  if (x > 0) out.push(idx(state, x - 1, y));
  if (x < state.cols - 1) out.push(idx(state, x + 1, y));
  if (y > 0) out.push(idx(state, x, y - 1));
  if (y < state.rows - 1) out.push(idx(state, x, y + 1));
  return out;
}

// --- World step (one ecology tick) --------------------------------------------

export function worldStep(state: GameState): void {
  accumulateMoisture(state);
  for (let p = 0; p < ECO.moistDiffusePasses; p++) diffuseDownhill(state, 'moisture');
  decayMoisture(state);
  emitSprings(state);
  for (let p = 0; p < ECO.waterFlowPasses; p++) flowWater(state);
  evaporate(state);
  growPlants(state);
}

/** Rule 1: prominent ground catches "rain". Prominence = height above the
 *  local mean (relative, not absolute — a bump on a plain counts). */
function accumulateMoisture(state: GameState): void {
  const r = ECO.promRadius;
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      let sum = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(state, nx, ny)) continue;
          sum += state.cells[idx(state, nx, ny)].height;
          n++;
        }
      }
      const mean = sum / n;
      const cell = state.cells[idx(state, x, y)];
      const prominence = cell.height - mean;
      if (prominence > ECO.promThreshold) {
        cell.moisture += ECO.moistGain * prominence;
      }
    }
  }
}

/** Rule 2 (moisture) / Rule 4 (water): move a field downhill toward lower
 *  GROUND (moisture) or lower SURFACE = height+water (water). Conserves the
 *  field; uses a delta buffer so a pass is order-independent. */
function diffuseDownhill(state: GameState, field: 'moisture'): void {
  const deltas = new Float64Array(state.cells.length);
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const i = idx(state, x, y);
      const cell = state.cells[i];
      const value = cell[field];
      if (value <= 0) continue;
      const ns = neighbourIdx(state, x, y);
      let totalDrop = 0;
      const drops: number[] = [];
      for (const ni of ns) {
        const drop = cell.height - state.cells[ni].height;
        drops.push(drop > 0 ? drop : 0);
        if (drop > 0) totalDrop += drop;
      }
      if (totalDrop <= 0) continue;
      const move = value * ECO.moistDiffuseRate;
      for (let k = 0; k < ns.length; k++) {
        if (drops[k] <= 0) continue;
        const share = move * (drops[k] / totalDrop);
        deltas[i] -= share;
        deltas[ns[k]] += share;
      }
    }
  }
  for (let i = 0; i < state.cells.length; i++) state.cells[i].moisture += deltas[i];
}

/** Rule 5: moisture bleeds away everywhere — flatten the hill and springs die.
 *  Also clamps the field to its ceiling (see ECO.moistMax). */
function decayMoisture(state: GameState): void {
  for (const c of state.cells) {
    c.moisture = Math.min(ECO.moistMax, Math.max(0, c.moisture - ECO.moistDecay));
  }
}

/** Rule 3: a spring surfaces where the water table breaches the ground. Output
 *  is moved from the hidden moisture layer to surface water — so it can't form
 *  on peaks (height too high) and sustains only while moisture is replenished. */
function emitSprings(state: GameState): void {
  for (const c of state.cells) {
    const breach = c.height * ECO.springBreach;
    if (c.moisture > breach) {
      const emit = Math.min(ECO.springRate, c.moisture - breach);
      if (emit <= 0) continue;
      c.moisture -= emit;
      c.water += emit;
    }
  }
}

/** Surface water flows toward lower (height+water) neighbours → rivers + lakes
 *  pooling in minima. Capped per-neighbour so flat lakes form instead of
 *  oscillating. Delta-buffered for order independence. */
function flowWater(state: GameState): void {
  const deltas = new Float64Array(state.cells.length);
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const i = idx(state, x, y);
      const cell = state.cells[i];
      if (cell.water <= 0) continue;
      // Only the excess above the retained film can flow (shallow water sticks).
      const movable = cell.water - ECO.waterFilm;
      if (movable <= 0) continue;
      const surface = cell.height + cell.water;
      const ns = neighbourIdx(state, x, y);
      let totalDrop = 0;
      const drops: number[] = [];
      for (const ni of ns) {
        const nc = state.cells[ni];
        const drop = surface - (nc.height + nc.water);
        drops.push(drop > 0 ? drop : 0);
        if (drop > 0) totalDrop += drop;
      }
      if (totalDrop <= 0) continue;
      const move = movable * ECO.waterFlowRate;
      for (let k = 0; k < ns.length; k++) {
        if (drops[k] <= 0) continue;
        const share = Math.min(move * (drops[k] / totalDrop), drops[k] / 2);
        deltas[i] -= share;
        deltas[ns[k]] += share;
      }
    }
  }
  for (let i = 0; i < state.cells.length; i++) {
    state.cells[i].water = Math.max(0, state.cells[i].water + deltas[i]);
  }
}

function evaporate(state: GameState): void {
  for (const c of state.cells) {
    c.water -= ECO.evap;
    if (c.water < ECO.waterMin) c.water = 0;
  }
}

/** Plants grow on ground kept damp or under SHALLOW water; deep lakes and dry
 *  sand grow nothing. Wetness must persist (wetTime) before green appears, and
 *  decays faster than it builds so removing the water kills the plant. */
function growPlants(state: GameState): void {
  for (const c of state.cells) {
    const shallowWater = c.water >= ECO.plantWaterMin && c.water <= ECO.plantWaterMax;
    const dampGround = c.height > 0 && c.moisture >= c.height * ECO.plantMoistureRatio;
    const wet = shallowWater || dampGround;
    if (wet) {
      c.wetTime += 1;
      if (c.wetTime >= ECO.plantGrowAfter) {
        c.plant = Math.min(1, c.plant + ECO.plantGrow);
      }
    } else {
      c.wetTime = Math.max(0, c.wetTime - ECO.wetDryDecay);
      c.plant = Math.max(0, c.plant - ECO.plantDecay);
    }
  }
}

// --- Catch-up -----------------------------------------------------------------

/** Resolve world steps missed since `lastUpdateTime`. Capped: a very long
 *  absence runs MAX_CATCHUP_STEPS (the field has long since settled) and snaps
 *  the clock to `now`. */
export function catchUp(state: GameState, now: number = Date.now()): void {
  const elapsed = now - state.lastUpdateTime;
  if (elapsed < WORLD_STEP_MS) return;
  const want = Math.floor(elapsed / WORLD_STEP_MS);
  const steps = Math.min(want, MAX_CATCHUP_STEPS);
  for (let i = 0; i < steps; i++) worldStep(state);
  state.lastUpdateTime = want > MAX_CATCHUP_STEPS
    ? now
    : state.lastUpdateTime + steps * WORLD_STEP_MS;
}

// --- Player actions -----------------------------------------------------------

/** Pour surface water at the focus (the water bucket). `intensity` (0..1) ramps
 *  with dwell so a brief glance barely wets anything. */
export function pourWater(state: GameState, gx: number, gy: number, intensity: number): void {
  const r = POUR.radius;
  const x0 = Math.max(0, Math.floor(gx - r));
  const x1 = Math.min(state.cols - 1, Math.ceil(gx + r));
  const y0 = Math.max(0, Math.floor(gy - r));
  const y1 = Math.min(state.rows - 1, Math.ceil(gy + r));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const dist = Math.hypot(cx - gx, cy - gy);
      if (dist > r) continue;
      const w = 1 - dist / r;
      state.cells[idx(state, cx, cy)].water += POUR.rate * intensity * w;
    }
  }
}

// --- Serialization ------------------------------------------------------------

export function serializeState(state: GameState): string {
  return JSON.stringify(state);
}

/** Returns null for missing/old/corrupt saves (caller starts a fresh desert). */
export function deserializeState(json: string): GameState | null {
  try {
    const parsed = JSON.parse(json) as Partial<GameState>;
    if (
      parsed &&
      parsed.version === SAVE_VERSION &&
      Array.isArray(parsed.cells) &&
      typeof parsed.cols === 'number' &&
      typeof parsed.rows === 'number' &&
      parsed.cells.length === parsed.cols * parsed.rows
    ) {
      const state = parsed as GameState;
      if (typeof state.lastUpdateTime !== 'number') state.lastUpdateTime = Date.now();
      recomputeTotalSand(state);
      return state;
    }
    return null;
  } catch {
    return null;
  }
}
