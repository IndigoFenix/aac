// Sandbox Game — Core type definitions
//
// A height-field terrain sandbox. Players push SAND around (conserved) to make
// hills and valleys; left-alone terrain shape drives emergent moisture →
// springs → rivers → plants. See config.ts for the tuning model.

/** Bump when the serialized shape changes — older saves are discarded on load. */
export const SAVE_VERSION = 2;

/** One terrain cell. All values are floats. */
export interface TerrainCell {
  /** Sand units stacked here. Player-controlled, conserved across the grid. */
  height: number;
  /** Hidden "water table" level. Accumulates on prominent ground, flows
   *  downhill underground, surfaces as a spring where it exceeds the height. */
  moisture: number;
  /** Surface water depth. 0 = dry. */
  water: number;
  /** Vegetation density 0..1. */
  plant: number;
  /** Accumulated world steps this cell has been "wet" (drives plant growth). */
  wetTime: number;
}

/** Full game state — JSON-serializable (flat row-major cell array). */
export interface GameState {
  version: number;
  cols: number;
  rows: number;
  cells: TerrainCell[];
  /** Timestamp (ms) of the last resolved world step. */
  lastUpdateTime: number;
  /** Invariant: sum of all heights. Guards sand conservation during sculpting. */
  totalSand: number;
}

/** What the gaze brush does. */
export type ToolId = 'sculpt' | 'water';
