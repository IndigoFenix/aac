// Sandbox Game — Core type definitions
//
// A height-field terrain sandbox. Players push SAND around (conserved) to make
// hills and valleys; left-alone terrain shape drives emergent moisture →
// springs → rivers → plants. See config.ts for the tuning model.

/** Bump when the serialized shape changes — older saves are discarded on load. */
export const SAVE_VERSION = 4;

/** One terrain cell. All values are floats. */
export interface TerrainCell {
  /** Sand units stacked here. Player-controlled, conserved across the grid. */
  height: number;
  /** Hidden "water table" level. Accumulates on prominent ground, flows
   *  downhill underground, surfaces as a spring where it exceeds the height. */
  moisture: number;
  /** Surface water depth. 0 = dry. */
  water: number;
  /** Soil fertility 0..1 — moist, plant-supporting soil. Recharged by nearby
   *  surface water / a high water table, spreads a couple tiles, decays back to
   *  desert. The fertile ZONE (wider than the water) is where greenery lives. */
  fertility: number;
  /** Vegetation density 0..1. */
  plant: number;
}

/** Full game state — JSON-serializable (flat row-major cell array). */
export interface GameState {
  version: number;
  cols: number;
  rows: number;
  cells: TerrainCell[];
  /** Integer world-step counter — the simulation clock the event scheduler runs
   *  on. Tasks are scheduled at absolute future clock values; advancing the clock
   *  is the only thing that releases them, which is what guarantees the scheduler
   *  can't livelock. */
  clock: number;
  /** Timestamp (ms) of the last resolved world step. */
  lastUpdateTime: number;
  /** Invariant: sum of all heights. Guards sand conservation during sculpting. */
  totalSand: number;
  /** Pending scheduler tasks, flattened as [step, cell, …]. Present only in the
   *  serialized form (and briefly on a just-loaded state) — the live schedule
   *  lives in the transient Sim. Carried in saves so the world evolves
   *  identically whether the player watched it or it was caught up on return. */
  schedule?: number[];
}

/** What the gaze brush does. */
export type ToolId = 'sculpt' | 'water';
