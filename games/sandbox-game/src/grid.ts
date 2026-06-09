// Sandbox Game — flat-grid helpers shared by the sculpt brush and engine.

import type { GameState, TerrainCell } from './types';

export function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && x < state.cols && y >= 0 && y < state.rows;
}

/** Wrap a coordinate into [0,size) — used in toroidal mode so an off-edge index
 *  re-enters from the opposite side. (Caller decides whether to wrap or clamp.) */
export function wrapCoord(v: number, size: number): number {
  return ((v % size) + size) % size;
}

export function idx(state: GameState, x: number, y: number): number {
  return y * state.cols + x;
}

export function cellAt(state: GameState, x: number, y: number): TerrainCell {
  return state.cells[idx(state, x, y)];
}

/** Cardinal neighbours that are in bounds. */
export function cardinal(state: GameState, x: number, y: number): TerrainCell[] {
  const out: TerrainCell[] = [];
  if (x > 0) out.push(state.cells[idx(state, x - 1, y)]);
  if (x < state.cols - 1) out.push(state.cells[idx(state, x + 1, y)]);
  if (y > 0) out.push(state.cells[idx(state, x, y - 1)]);
  if (y < state.rows - 1) out.push(state.cells[idx(state, x, y + 1)]);
  return out;
}

/** Recompute and store the total-sand invariant. */
export function recomputeTotalSand(state: GameState): number {
  let sum = 0;
  for (const c of state.cells) sum += c.height;
  state.totalSand = sum;
  return sum;
}
