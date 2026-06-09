// Sandbox Game — gaze-driven sand brush.
//
// Sand is CONSERVED: every operation only moves height between in-grid cells
// (sand pushed past an edge stays), so `sum(height)` is invariant.
//
// All sculpting behaviour emerges from just TWO rules applied each frame the
// pointer is MOVING (a resting/jittering gaze does nothing):
//
//   PUSH  — move a fraction of each brushed cell's height one step in the gaze
//           direction. Fraction-of-height ⇒ whole hills shove along; the
//           per-frame fraction is a cap, and a brush dwells on a cell for ~1/speed
//           frames, so slow deliberate motion carves deep while a fast pass only
//           skims (and a fast flick skips cells outright).
//   SLUMP — relax over-steep slopes in the brushed area toward the angle of
//           repose, spilling sand to the SIDES of a cut, smoothing agitated
//           areas, and rounding circled holes into a clean bowl + rim.
//
// Together these give: rest → nothing; fast long drag → little; slow drag →
// channel pushed ahead + sides; fast back-and-forth → smoothed shallow channel;
// small circle → hole with sand pushed outward.
//
// DISTURBING sand also dissipates the hidden groundwater (moisture) under the
// brush — see settleMoisture. Otherwise digging a charged hill would leave a
// high water table on now-low ground and surge a phantom spring (and carrying
// the moisture with the sand just moves that surge to wherever you pile it).
// Water should only emerge over TIME on terrain left alone, never from the act
// of sculpting.

import type { GameState } from './types';
import { BRUSH, ECO } from './config';
import { idx, inBounds } from './grid';
import { markSculptArea } from './engine';

/**
 * Apply the brush for one frame given the gaze position (in cell coords) and its
 * per-frame velocity (cells/frame, ideally smoothed by the caller).
 */
export function applyBrush(state: GameState, gx: number, gy: number, vx: number, vy: number): void {
  const speed = Math.hypot(vx, vy);
  const engage = (speed - BRUSH.restSpeed) / BRUSH.rampWidth;
  if (engage <= 0) return; // resting / jitter → no impact
  const e = engage < 1 ? engage : 1;
  push(state, gx, gy, vx / speed, vy / speed, e);
  slump(state, gx, gy);
  settleMoisture(state, gx, gy);
  // Wake the disturbed area (height + moisture changed) so the ecology re-runs
  // there, and refresh the prominence the new heights feed. The +1 matches
  // slump/settleMoisture's wider box.
  markSculptArea(state, gx, gy, BRUSH.radius + 1);
}

/** PUSH: shove a fraction of each brushed cell's height one cell along motion. */
function push(state: GameState, gx: number, gy: number, dnx: number, dny: number, engage: number): void {
  const dx = Math.round(dnx);
  const dy = Math.round(dny);
  if (dx === 0 && dy === 0) return;
  const r = BRUSH.radius;
  const x0 = Math.max(0, Math.floor(gx - r));
  const x1 = Math.min(state.cols - 1, Math.ceil(gx + r));
  const y0 = Math.max(0, Math.floor(gy - r));
  const y1 = Math.min(state.rows - 1, Math.ceil(gy + r));

  // Snapshot amounts first so transfers within a frame don't compound.
  const moves: { from: number; to: number; amount: number }[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const dist = Math.hypot(cx - gx, cy - gy);
      if (dist > r) continue;
      const tx = cx + dx, ty = cy + dy;
      if (!inBounds(state, tx, ty)) continue; // off-grid: sand stays put
      const fromI = idx(state, cx, cy);
      const h = state.cells[fromI].height;
      const w = 1 - dist / r; // soft falloff
      const amount = Math.min(h - BRUSH.minHeight, h * BRUSH.pushRate * engage * w);
      if (amount > 0) moves.push({ from: fromI, to: idx(state, tx, ty), amount });
    }
  }
  for (const m of moves) {
    state.cells[m.from].height -= m.amount;
    state.cells[m.to].height += m.amount;
  }
}

const CARDINAL: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** SLUMP: relax slopes steeper than the talus toward it (angle of repose). */
function slump(state: GameState, gx: number, gy: number): void {
  const r = BRUSH.radius + 1; // a little wider so pushed piles can spill outward
  const x0 = Math.max(0, Math.floor(gx - r));
  const x1 = Math.min(state.cols - 1, Math.ceil(gx + r));
  const y0 = Math.max(0, Math.floor(gy - r));
  const y1 = Math.min(state.rows - 1, Math.ceil(gy + r));

  const deltas = new Map<number, number>();
  const add = (i: number, d: number) => deltas.set(i, (deltas.get(i) ?? 0) + d);

  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const i = idx(state, cx, cy);
      const h = state.cells[i].height;
      for (const [ox, oy] of CARDINAL) {
        const nx = cx + ox, ny = cy + oy;
        if (!inBounds(state, nx, ny)) continue;
        const j = idx(state, nx, ny);
        const drop = h - state.cells[j].height;
        if (drop > BRUSH.talus) {
          // Move toward the talus; reposeRate < 0.5 keeps it from overshooting.
          const move = (drop - BRUSH.talus) * BRUSH.reposeRate;
          add(i, -move);
          add(j, move);
        }
      }
    }
  }
  for (const [i, d] of deltas) state.cells[i].height += d;
}

/** Disturbing sand dissipates its hidden water table: hold moisture below the
 *  spring threshold in the brushed area so sculpting can't conjure a spring.
 *  (Discards groundwater rather than relocating it — churned sand drains.) */
function settleMoisture(state: GameState, gx: number, gy: number): void {
  const r = BRUSH.radius + 1; // cover everything slump may have re-shaped this frame
  const x0 = Math.max(0, Math.floor(gx - r));
  const x1 = Math.min(state.cols - 1, Math.ceil(gx + r));
  const y0 = Math.max(0, Math.floor(gy - r));
  const y1 = Math.min(state.rows - 1, Math.ceil(gy + r));
  // Cover the whole box (no distance gate) so it includes every cell slump may
  // have re-shaped — slump works on its bounding box, not a disc.
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const c = state.cells[idx(state, cx, cy)];
      const cap = c.height * ECO.springBreach;
      if (c.moisture > cap) c.moisture = cap;
    }
  }
}

/** Dev guard: total sand must be unchanged (within epsilon) after sculpting. */
export function conservationError(state: GameState): number {
  let sum = 0;
  for (const c of state.cells) sum += c.height;
  return Math.abs(sum - state.totalSand);
}
