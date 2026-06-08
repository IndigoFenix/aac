// Sandbox Game — gaze-driven sand brush.
//
// Sand is CONSERVED: every operation only ever moves height between in-grid
// cells, so `sum(height)` is invariant (sand pushed past an edge simply stays).
// Two gestures, both reducible to "move each affected cell's sand one cell in
// some direction":
//   • sweep  — gaze moving fast: push sand ALONG the motion (dig out the back,
//              pile up the front). This is how you carve valleys and ridges.
//   • gather — gaze resting/focused: pull surrounding sand TOWARD the focus,
//              raising a mound.

import type { GameState } from './types';
import { BRUSH } from './config';
import { idx, inBounds } from './grid';

interface Transfer {
  from: number;
  to: number;
  amount: number;
}

/** Move sand for every brush cell one step in the direction `dirFn` returns
 *  for that cell (or null to leave it). Computes amounts from a snapshot so
 *  transfers don't compound within a single call. */
function pushSand(
  state: GameState,
  gx: number,
  gy: number,
  rate: number,
  dirFn: (cx: number, cy: number, weight: number) => [number, number] | null,
): void {
  const r = BRUSH.radius;
  const x0 = Math.max(0, Math.floor(gx - r));
  const x1 = Math.min(state.cols - 1, Math.ceil(gx + r));
  const y0 = Math.max(0, Math.floor(gy - r));
  const y1 = Math.min(state.rows - 1, Math.ceil(gy + r));

  const transfers: Transfer[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const dist = Math.hypot(cx - gx, cy - gy);
      if (dist > r) continue;
      const weight = 1 - dist / r; // soft falloff
      const dir = dirFn(cx, cy, weight);
      if (!dir) continue;
      const [tx, ty] = dir;
      if (tx === cx && ty === cy) continue;
      if (!inBounds(state, tx, ty)) continue; // off-grid: sand stays put

      const fromI = idx(state, cx, cy);
      const fromH = state.cells[fromI].height;
      const amount = Math.min(fromH - BRUSH.minHeight, fromH * rate * weight);
      if (amount <= 0) continue;
      transfers.push({ from: fromI, to: idx(state, tx, ty), amount });
    }
  }

  for (const t of transfers) {
    state.cells[t.from].height -= t.amount;
    state.cells[t.to].height += t.amount;
  }
}

/** Sweep: push sand along the gaze-motion vector (vx, vy). */
export function sweep(state: GameState, gx: number, gy: number, vx: number, vy: number): void {
  const speed = Math.hypot(vx, vy);
  if (speed <= 0) return;
  const dx = Math.round(vx / speed); // unit vector → one of 8 directions
  const dy = Math.round(vy / speed);
  if (dx === 0 && dy === 0) return;
  pushSand(state, gx, gy, BRUSH.sweepRate, (cx, cy) => [cx + dx, cy + dy]);
}

/** Gather: pull surrounding sand toward the focus, raising a mound. */
export function gather(state: GameState, gx: number, gy: number): void {
  pushSand(state, gx, gy, BRUSH.gatherRate, (cx, cy) => {
    const tx = gx - cx;
    const ty = gy - cy;
    if (Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5) return null; // at the focus
    const len = Math.hypot(tx, ty) || 1;
    return [cx + Math.round(tx / len), cy + Math.round(ty / len)];
  });
}

/**
 * Apply the sculpt brush for one frame given the gaze position (in cell coords)
 * and its per-frame velocity. Chooses sweep vs gather by gaze speed.
 */
export function applyBrush(
  state: GameState,
  gx: number,
  gy: number,
  vx: number,
  vy: number,
): void {
  const speed = Math.hypot(vx, vy);
  if (speed >= BRUSH.sweepSpeed) sweep(state, gx, gy, vx, vy);
  else gather(state, gx, gy);
}

/** Dev guard: total sand must be unchanged (within epsilon) after sculpting. */
export function conservationError(state: GameState): number {
  let sum = 0;
  for (const c of state.cells) sum += c.height;
  return Math.abs(sum - state.totalSand);
}
