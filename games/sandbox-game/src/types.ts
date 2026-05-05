// Sandbox Game — Core type definitions

export type CellType =
  | 'empty'
  | 'stone'
  | 'soil'
  | 'water'
  | 'seed'
  | 'bloom'
  | 'weed'
  | 'fruit'
  | 'compost'
  | 'irrigation'
  | 'scarecrow'
  | 'harvester'
  | 'storage';

/** What a player can do — place elements or use tools */
export type ToolId = CellType | 'harvest' | 'remove';

/** A single cell on the grid */
export interface GameCell {
  type: CellType;
  /** Remaining capacity to cause changes. 0 = inert. */
  energy: number;
  /** Discrete state index — meaning depends on type (see ELEMENTS) */
  state: number;
}

/** A scheduled future state change */
export interface TimerEvent {
  x: number;
  y: number;
  /** Timestamp (ms) when this fires */
  fireAt: number;
  /** State index to transition to */
  targetState: number;
  /** Optional: also change type (e.g. fruit → compost) */
  targetType?: CellType;
  /** Optional: energy to set on the new cell */
  targetEnergy?: number;
}

/** Full game state — serializable */
export interface GameState {
  grid: GameCell[][];
  width: number;
  height: number;
  playerEnergy: number;
  maxPlayerEnergy: number;
  /** Timestamp of last engine update */
  lastUpdateTime: number;
  /** Pending timer events, sorted by fireAt */
  timers: TimerEvent[];
  /** Total harvested resources (score) */
  harvested: number;
  /** Cells queued for water flow on next tick */
  flowQueue: [number, number][];
}

// --- Rule system ---

export type RuleEffect =
  | { type: 'changeMyState'; newState: number }
  | { type: 'changeNeighborState'; newState: number }
  | { type: 'startMyTimer'; targetState: number; duration: number; targetType?: CellType; targetEnergy?: number }
  | { type: 'startNeighborTimer'; targetState: number; duration: number; targetType?: CellType; targetEnergy?: number }
  | { type: 'spawnOnEmpty'; spawnType: CellType; spawnState: number; spawnEnergy: number; duration: number }
  | { type: 'convertNeighbor'; newType: CellType; newState: number; newEnergy: number }
  | { type: 'consumeSelf'; replacementType: CellType; replacementState: number; replacementEnergy: number };

/**
 * "When I am [myState], and my neighbor is [neighborType in neighborState],
 *  then [effect], costing [energyCost]."
 */
export interface Rule {
  /** My state to match, or null for any */
  myState: number | null;
  /** Neighbor type to match, or null for unconditional (no neighbor needed) */
  neighborType: CellType | null;
  /** Neighbor state to match, or null for any */
  neighborState: number | null;
  /** Minimum neighbor state (>=), used instead of exact match when set */
  neighborStateMin?: number;
  /** What happens */
  effect: RuleEffect;
  /** Energy cost from my cell */
  energyCost: number;
  /** If true, this rule only fires once (when first triggered, not re-triggered on same neighbor) */
  once?: boolean;
}

/** Static definition of an element type */
export interface ElementDef {
  type: CellType;
  label: string;
  /** State names in order */
  states: string[];
  /** Default energy when placed */
  defaultEnergy: number;
  /** Default state when placed (0 if omitted) */
  defaultState?: number;
  /** Background color per state index (Tailwind or hex) */
  colors: string[];
  /** Emoji icon per state index */
  icons: string[];
  /** Interaction rules */
  rules: Rule[];
  /** Whether the player can place this element */
  placeable: boolean;
  /** Energy cost for the player to place this */
  placeCost: number;
  /** Valid placement targets — which cell types this can be placed on */
  placeOn?: CellType[];
}
