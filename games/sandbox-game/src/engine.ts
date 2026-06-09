// Sandbox Game — field-simulation engine (pure logic, no React/DOM).
//
// Keeps the original "tick + catch-up-on-load" philosophy, but as a fixed-step
// FIELD simulation over a height grid rather than a per-cell timer/rule queue.
// One `worldStep` advances the ecology; `catchUp` resolves missed steps after
// an absence (capped — the sim settles to near-equilibrium long before the cap).
//
// NOTE (2026-06-09): this is full-grid scheduled (every cell, every step). A
// quiescence-based active-set (process only cells still CHANGING; sleep at rest)
// is planned to make cost track instability rather than map size — see the
// project memory. The per-cell MATH below is the part to preserve; only the
// scheduling around it changes.

import type { GameState, TerrainCell } from './types';
import { SAVE_VERSION } from './types';
import {
  GRID_COLS, GRID_ROWS, BASELINE_HEIGHT,
  WORLD_STEP_MS, MAX_CATCHUP_STEPS, SETTLE_EPS, SLEEP_EPS, STABLE_REDIST_RATE, ECO, FERT, POUR,
} from './config';
import { idx, recomputeTotalSand } from './grid';
import {
  getSim, schedule, drainDue, nextBucketStep, flushPromDirty, dirtyPromBox,
  computeAllProm, serializeSchedule, seedSchedule, type Sim,
} from './sim';

// --- Factory ------------------------------------------------------------------

export function createNewGame(cols = GRID_COLS, rows = GRID_ROWS): GameState {
  const cells: TerrainCell[] = [];
  for (let i = 0; i < cols * rows; i++) {
    cells.push({ height: BASELINE_HEIGHT, moisture: 0, water: 0, fertility: 0, plant: 0 });
  }
  return {
    version: SAVE_VERSION,
    cols,
    rows,
    cells,
    clock: 0,
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
//
// The ecology no longer sweeps the whole grid. `worldStep` advances the clock by
// one and processes only the cells the scheduler has woken for that step; each
// settles or re-schedules itself, so a quiet world does ~no work. Every
// sub-process is SINGLE-PASS and writes only to a cell or its 4 cardinal
// neighbours, and none can inject energy or oscillate (see the per-function notes
// + STABLE_REDIST_RATE / SETTLE_EPS), so the world is guaranteed to reach rest for
// ANY tuning of config — which is what bounds catch-up after a long absence.

const all = (state: GameState): number[] => {
  const out = new Array<number>(state.cells.length);
  for (let i = 0; i < out.length; i++) out[i] = i;
  return out;
};

/** Lightweight instrumentation for the perf/quiescence tests — total cells the
 *  scheduler has processed since the last reset. Not used by the game itself. */
export const stats = { processed: 0 };

/** Advance one world step, processing the cells scheduled for the new clock. */
export function worldStep(state: GameState): void {
  const sim = getSim(state);
  const T = ++state.clock;
  flushPromDirty(state, sim);
  const active = drainDue(sim, T);
  if (active.length > 0) processActive(state, sim, active, T);
}

/** Reference path: run the ecology over EVERY cell (no scheduling). Slower, but a
 *  ground truth for "what the un-scheduled field sim does" — used by tests. */
export function worldStepFull(state: GameState): void {
  const sim = getSim(state);
  state.clock++;
  computeAllProm(state, sim); // height may have shifted (erosion) → refresh all
  const cells = all(state);
  const wake: number[] = [];
  accumulateMoisture(state, sim, cells);
  diffuseMoistureDownhill(state, cells);
  decayMoisture(state, cells);
  emitSprings(state, cells);
  flowWater(state, cells);
  erodeChannels(state, sim, cells, wake);
  evaporate(state, cells);
  updateFertility(state, cells);
  growPlants(state, cells);
}

/** Wake every cell (one step). Tests that build terrain by hand call this so the
 *  scheduler has something to chew on; the game itself wakes via sculpt/pour. */
export function wakeAll(state: GameState): void {
  const sim = getSim(state);
  const T = state.clock + 1;
  for (let i = 0; i < state.cells.length; i++) schedule(sim, i, T);
}

/** Wake one cell for the next step (the generic perturbation hook). */
export function markActive(state: GameState, cell: number): void {
  schedule(getSim(state), cell, state.clock + 1);
}

/** A sculpt edit changed heights in the box around (cx,cy): wake those cells AND
 *  dirty/wake the wider prominence neighbourhood (height feeds rain over a box,
 *  the one coupling that reaches beyond 4 neighbours). */
export function markSculptArea(state: GameState, cx: number, cy: number, radius: number): void {
  const sim = getSim(state);
  const T = state.clock + 1;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(state.cols - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(state.rows - 1, Math.ceil(cy + radius));
  for (let cyy = y0; cyy <= y1; cyy++) {
    for (let cxx = x0; cxx <= x1; cxx++) schedule(sim, idx(state, cxx, cyy), T);
  }
  // Prominence the new heights feed spans a promRadius box around the WHOLE brush
  // footprint — dirty/wake that region once (not per brushed cell).
  const r = ECO.promRadius;
  const px0 = Math.max(0, x0 - r), px1 = Math.min(state.cols - 1, x1 + r);
  const py0 = Math.max(0, y0 - r), py1 = Math.min(state.rows - 1, y1 + r);
  for (let cyy = py0; cyy <= py1; cyy++) {
    for (let cxx = px0; cxx <= px1; cxx++) {
      const i = idx(state, cxx, cyy);
      sim.promDirty.add(i);
      schedule(sim, i, T);
    }
  }
}

/** Process the woken cells for step T: run the pipeline over them (sub-process
 *  order preserved → same physics as the full sweep, minus the sleeping cells),
 *  then wake any cell whose state actually moved (and the neighbours it can now
 *  affect) for T+1. Cells that came out unchanged are left to SLEEP. */
function processActive(state: GameState, sim: Sim, active: number[], T: number): void {
  const { cols } = state;
  // Watch set = the cells that could change this step = active ∪ their neighbours
  // (every transfer writes only within 4 neighbours). Snapshot them to detect
  // genuine change afterwards.
  const watch = new Set<number>();
  for (const i of active) {
    watch.add(i);
    for (const ni of neighbourIdx(state, i % cols, (i / cols) | 0)) watch.add(ni);
  }
  const snap = new Map<number, [number, number, number, number, number]>();
  for (const i of watch) {
    const c = state.cells[i];
    snap.set(i, [c.height, c.moisture, c.water, c.fertility, c.plant]);
  }

  stats.processed += active.length;
  const wake: number[] = []; // distant cells whose prominence erosion disturbed
  accumulateMoisture(state, sim, active);
  diffuseMoistureDownhill(state, active);
  decayMoisture(state, active);
  emitSprings(state, active);
  flowWater(state, active);
  erodeChannels(state, sim, active, wake);
  evaporate(state, active);
  updateFertility(state, active);
  growPlants(state, active);

  // A cell at a steady-flux equilibrium has ZERO net state change yet is still
  // actively conducting (rain → moisture → spring → river → evaporation): if such
  // a cell were slept the instant its own Δ hit zero, it would stop feeding its
  // downstream a step before the downstream stops needing it, desyncing the chain
  // into a limit cycle that never settles. So the whole woken BATCH is processed
  // synchronously every step (reproducing the convergent full sweep over just the
  // active region) and only sleeps when, in a single step, NOTHING in it moved —
  // at which point the flux has genuinely stopped and the frozen snapshot is
  // self-consistent. New cells reached by a transfer (a changed neighbour) join
  // the batch; the front advances one ring per step, never into still desert.
  const changed: number[] = [];
  for (const i of watch) {
    const s = snap.get(i)!;
    const c = state.cells[i];
    if (
      Math.abs(c.height - s[0]) > SLEEP_EPS || Math.abs(c.moisture - s[1]) > SLEEP_EPS ||
      Math.abs(c.water - s[2]) > SLEEP_EPS || Math.abs(c.fertility - s[3]) > SLEEP_EPS ||
      Math.abs(c.plant - s[4]) > SLEEP_EPS
    ) changed.push(i);
  }
  if (changed.length > 0) {
    for (const i of active) schedule(sim, i, T + 1);  // keep the batch synchronized
    for (const i of changed) schedule(sim, i, T + 1); // and pull in transfer-reached neighbours
    for (const i of wake) schedule(sim, i, T + 1);    // erosion-disturbed prominence cells
  }
  // else: the batch is fully at rest this step → let every cell in it sleep.
}

/** Rule 1: prominent ground catches "rain". Prominence (height above the local
 *  (2r+1)²-box mean — wide, so only broad massifs qualify) is read from the Sim's
 *  cache, which is kept current incrementally as heights change, so accumulation
 *  is a flat O(active) lookup with no per-step grid scan. */
function accumulateMoisture(state: GameState, sim: Sim, active: number[]): void {
  for (const i of active) {
    const p = sim.prom[i];
    if (p > ECO.promThreshold) {
      state.cells[i].moisture += ECO.moistGain * Math.min(p, ECO.promCap);
    }
  }
}

/** Rule 2 (moisture): advect the hidden water table downhill toward lower GROUND
 *  — a single-pass, one-directional flow of a FRACTION of each cell's own
 *  moisture, distributed among strictly-lower-height neighbours by their drop.
 *  Because it only ever moves moisture DOWN a fixed height potential and moves a
 *  sub-unit fraction of what a cell holds, it conserves the field, can't go
 *  negative, and can't cycle (no closed downhill loop) — so it relaxes to the
 *  height-minima and stops, for any rate ≤ 1. Delta-buffered (order-independent). */
function diffuseMoistureDownhill(state: GameState, active: number[]): void {
  const { cols } = state;
  const rate = Math.min(1, ECO.moistDiffuseRate);
  const d = new Map<number, number>();
  for (const i of active) {
    const cell = state.cells[i];
    const value = cell.moisture;
    if (value <= 0) continue;
    const ns = neighbourIdx(state, i % cols, (i / cols) | 0);
    let totalDrop = 0;
    const drops: number[] = [];
    for (const ni of ns) {
      const drop = cell.height - state.cells[ni].height;
      drops.push(drop > 0 ? drop : 0);
      if (drop > 0) totalDrop += drop;
    }
    if (totalDrop <= 0) continue;
    const move = value * rate;
    if (move < SETTLE_EPS) continue; // snap to no-flow → exact rest
    for (let k = 0; k < ns.length; k++) {
      if (drops[k] <= 0) continue;
      const share = move * (drops[k] / totalDrop);
      d.set(i, (d.get(i) ?? 0) - share);
      d.set(ns[k], (d.get(ns[k]) ?? 0) + share);
    }
  }
  for (const [i, dv] of d) state.cells[i].moisture += dv;
}

/** Rule 5: moisture bleeds away everywhere — flatten the hill and springs die.
 *  Also clamps the field to its ceiling (see ECO.moistMax). */
function decayMoisture(state: GameState, active: number[]): void {
  for (const i of active) {
    const c = state.cells[i];
    c.moisture = Math.min(ECO.moistMax, Math.max(0, c.moisture - ECO.moistDecay));
  }
}

/** Rule 3: a spring surfaces where the water table breaches the ground. Output
 *  is moved from the hidden moisture layer to surface water — so it can't form
 *  on peaks (height too high) and sustains only while moisture is replenished. */
function emitSprings(state: GameState, active: number[]): void {
  for (const i of active) {
    const c = state.cells[i];
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
 *  pooling in minima. SINGLE-PASS and UNCONDITIONALLY STABLE: each lower
 *  neighbour is offered `rate × (surface drop)` where `rate` is clamped to
 *  STABLE_REDIST_RATE = 1/(degree+1), the bound below which an explicit
 *  4-neighbour surface diffusion is monotone — i.e. no exchange can push a cell
 *  below the neighbour it just fed, so two pooled tiles relax to a flat lake
 *  instead of trading water forever (no CFL knife-edge to tune around). The
 *  total is then capped by the cell's movable (above-film) water; scaling the
 *  whole offer down preserves the per-pair no-overshoot property. Delta-buffered
 *  for order independence; off-grid sides drain to the open-boundary "sea". */
function flowWater(state: GameState, active: number[]): void {
  const { cols } = state;
  const rate = Math.min(STABLE_REDIST_RATE, ECO.waterFlow);
  const d = new Map<number, number>();
  for (const i of active) {
    const cell = state.cells[i];
    if (cell.water <= 0) continue;
    // Only the excess above the retained film can flow (shallow water sticks).
    const movable = cell.water - ECO.waterFilm;
    if (movable <= 0) continue;
    const surface = cell.height + cell.water;
    const ns = neighbourIdx(state, i % cols, (i / cols) | 0);
    // Targets are real neighbour indices; -1 marks an off-grid edge drain
    // (open boundary — water flowing there leaves the system). Each is offered
    // rate × its own drop (≤ half the gap), so no single target can be overshot.
    const targets: number[] = [];
    const offers: number[] = [];
    let total = 0;
    for (const ni of ns) {
      const nc = state.cells[ni];
      const drop = surface - (nc.height + nc.water);
      if (drop > 0) { const o = rate * drop; targets.push(ni); offers.push(o); total += o; }
    }
    const edgeDrop = surface - ECO.edgeDrainLevel;
    for (let e = 0; e < 4 - ns.length; e++) {
      if (edgeDrop > 0) { const o = rate * edgeDrop; targets.push(-1); offers.push(o); total += o; }
    }
    if (total <= 0) continue;
    // Cap the TOTAL by movable water; scaling the offer down keeps every
    // per-pair amount ≤ its no-overshoot limit.
    const scale = total > movable ? movable / total : 1;
    const sent = total * scale;
    if (sent < SETTLE_EPS) continue; // snap to no-flow → exact rest
    d.set(i, (d.get(i) ?? 0) - sent);
    for (let k = 0; k < targets.length; k++) {
      if (targets[k] >= 0) d.set(targets[k], (d.get(targets[k]) ?? 0) + offers[k] * scale); // else: off-map
    }
  }
  for (const [i, dv] of d) state.cells[i].water = Math.max(0, state.cells[i].water + dv);
}

/** Flowing water incises its bed and carries the sediment one cell downstream.
 *  Because only wet, flowing cells erode (dry banks don't), channels cut down
 *  below their surroundings and pull water in — confining it to rivers instead
 *  of a flooded sheet. Conserves total sand (every grain moved, never deleted). */
function erodeChannels(state: GameState, sim: Sim, active: number[], wake: number[]): void {
  const { cols } = state;
  const dh = new Map<number, number>();
  for (const i of active) {
    const cell = state.cells[i];
    if (cell.water <= ECO.erodeWaterMin) continue;
    const surface = cell.height + cell.water;
    // Steepest-descent downstream neighbour by water surface.
    const ns = neighbourIdx(state, i % cols, (i / cols) | 0);
    let down = -1, lowest = surface;
    for (const ni of ns) {
      const ns2 = state.cells[ni].height + state.cells[ni].water;
      if (ns2 < lowest) { lowest = ns2; down = ni; }
    }
    if (down === -1) continue; // a sink (lake floor) — deposits, doesn't cut
    // Only incise where water genuinely runs downhill; flat pools don't erode.
    if (surface - lowest < ECO.erodeMinSlope) continue;
    const excess = cell.water - ECO.erodeWaterMin;
    const erode = Math.min(ECO.erodeRate * excess, ECO.erodeMax, cell.height);
    if (erode <= 0) continue;
    dh.set(i, (dh.get(i) ?? 0) - erode);
    dh.set(down, (dh.get(down) ?? 0) + erode);
  }
  // Apply, and where a height actually moved, refresh the prominence it feeds
  // (a box wider than 4 neighbours) and wake those cells for the next step.
  for (const [i, dv] of dh) {
    if (dv === 0) continue;
    state.cells[i].height += dv;
    dirtyPromBox(state, sim, i % cols, (i / cols) | 0, wake);
  }
}

function evaporate(state: GameState, active: number[]): void {
  for (const i of active) {
    const c = state.cells[i];
    c.water -= ECO.evap;
    if (c.water < ECO.waterMin) c.water = 0;
  }
}

/** Soil fertility: water (surface, or a high water table) recharges the soil's
 *  fertility; it then spreads a couple tiles and decays back to desert. The
 *  fertile ZONE — wider than the water — is the habitat greenery grows in. */
function updateFertility(state: GameState, active: number[]): void {
  // Spread last step's fertility into neighbouring soil (the halo) — SINGLE-PASS,
  // equalising diffusion at the monotone-stable rate (each neighbour offered
  // rate × the fertility gap, ≤ half the gap, so no overshoot). Then decay.
  const { cols } = state;
  const rate = Math.min(STABLE_REDIST_RATE, FERT.diffuseRate);
  const d = new Map<number, number>();
  for (const i of active) {
    const f = state.cells[i].fertility;
    if (f <= 0) continue;
    for (const ni of neighbourIdx(state, i % cols, (i / cols) | 0)) {
      const diff = f - state.cells[ni].fertility;
      if (diff <= 0) continue;
      const m = rate * diff;
      if (m < SETTLE_EPS) continue; // snap near-equal soil to no-flow
      d.set(i, (d.get(i) ?? 0) - m);
      d.set(ni, (d.get(ni) ?? 0) + m);
    }
  }
  for (const [i, dv] of d) state.cells[i].fertility += dv;
  for (const i of active) {
    const c = state.cells[i];
    c.fertility = Math.max(0, c.fertility - FERT.decay);
    // Pin source cells LAST (water, or damp ground over a high water table) so a
    // source stays at full fertility while still feeding the surrounding halo.
    let target = 0;
    if (c.water >= ECO.waterMin) target = FERT.waterTarget;
    const table = c.height > 0 ? c.moisture - c.height * FERT.dampTableRatio : 0;
    if (table > 0) target = Math.max(target, Math.min(FERT.dampMax, FERT.dampGain * table));
    if (target > c.fertility) c.fertility = target;
  }
}

/** Vegetation fills the fertile ZONE around water, growing toward a density
 *  capped by fertility (lush near water, sparse at the oasis edge). The zone
 *  itself spreads outward over time as fertility diffuses from the water, so
 *  green visibly advances; it recedes (slowly — drought-tolerant) only once the
 *  soil drops below fertile, e.g. when you remove its water. Open water surface
 *  and bare desert grow nothing. */
function growPlants(state: GameState, active: number[]): void {
  for (const i of active) {
    const c = state.cells[i];
    if (c.water > ECO.plantWaterMax) { c.plant = Math.max(0, c.plant - FERT.plantDecay); continue; } // open lake
    if (c.fertility >= FERT.plantMin) {
      const cap = Math.min(1, (c.fertility - FERT.plantMin) / (1 - FERT.plantMin));
      if (c.plant < cap) c.plant = Math.min(cap, c.plant + FERT.plantGrow);
      else c.plant = Math.max(cap, c.plant - FERT.plantDecay); // fertility dropped → ease down
    } else {
      c.plant = Math.max(0, c.plant - FERT.plantDecay);
    }
  }
}

// --- Catch-up -----------------------------------------------------------------

/** Resolve world steps missed since `lastUpdateTime`. Because the world reaches
 *  rest (guaranteed), a settled stretch has no scheduled tasks — we JUMP the
 *  clock straight across it instead of replaying empty steps, so even a very long
 *  absence on a settled world costs ~O(1). Still capped at MAX_CATCHUP_STEPS as a
 *  backstop. The same path runs live (called each tick) and on return, so the
 *  world evolves identically whether or not the player was watching. */
export function catchUp(state: GameState, now: number = Date.now()): void {
  const elapsed = now - state.lastUpdateTime;
  if (elapsed < WORLD_STEP_MS) return;
  const want = Math.floor(elapsed / WORLD_STEP_MS);
  const steps = Math.min(want, MAX_CATCHUP_STEPS);
  const sim = getSim(state);
  const endClock = state.clock + steps;
  while (state.clock < endClock) {
    const next = nextBucketStep(sim, state.clock, endClock);
    if (next < 0) { state.clock = endClock; break; } // nothing pending → at rest; jump to end
    state.clock = next; // idle steps in between are guaranteed no-ops — skip them
    flushPromDirty(state, sim);
    const active = drainDue(sim, next);
    if (active.length > 0) processActive(state, sim, active, next);
  }
  state.lastUpdateTime = want > MAX_CATCHUP_STEPS
    ? now
    : state.lastUpdateTime + steps * WORLD_STEP_MS;
}

// --- Player actions -----------------------------------------------------------

/** Pour surface water at the focus (the water bucket). `intensity` (0..1) ramps
 *  with dwell so a brief glance barely wets anything. */
export function pourWater(state: GameState, gx: number, gy: number, intensity: number): void {
  const sim = getSim(state);
  const T = state.clock + 1;
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
      const i = idx(state, cx, cy);
      state.cells[i].water += POUR.rate * intensity * w;
      schedule(sim, i, T); // wake the wetted cell so the ecology responds
    }
  }
}

// --- Serialization ------------------------------------------------------------

export function serializeState(state: GameState): string {
  // Carry the pending schedule (the one piece of non-derivable runtime state) so
  // a reloaded world continues its in-flight timers exactly.
  const schedule = serializeSchedule(getSim(state));
  return JSON.stringify({ ...state, schedule });
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
      if (typeof state.clock !== 'number') state.clock = 0;
      recomputeTotalSand(state);
      // Rebuild the transient Sim (prominence cache from height) and re-seed its
      // schedule from the saved tasks; keep `schedule` off the live object.
      const flat = state.schedule;
      delete state.schedule;
      const sim = getSim(state);
      seedSchedule(sim, flat, state.clock);
      return state;
    }
    return null;
  } catch {
    return null;
  }
}
