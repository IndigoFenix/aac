/**
 * Custom App (Game) definition types.
 *
 * Mirrors planning-docs/game-generator-plan.md. Keep them in sync.
 * The authoritative spec lives in that doc; this file is the TS encoding.
 *
 * Field naming follows the board builder's camelCase convention.
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

export type CustomAppType = "game";

export type Layer = "background" | "entity" | "overlay";

export type RelativePosition =
  | "sameCell"
  | "adjacent"
  | "inside"
  | "contains";

export type CounterOp =
  | "gt"
  | "lt"
  | "eq"
  | "gte"
  | "lte";

// Properties that may appear in `states[].overrideProps` and per-instance
// room entity overrides. Kept narrow on purpose.
export type OverridableProp =
  | "iconRef"
  | "imageKey"
  | "symbolPath"
  | "imageColor"
  | "tileColor"
  | "label"
  | "hidden"
  | "isSolid"
  | "movable"
  | "char";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export type GridCoord = [number, number]; // [x, y]
export type GridSize = [number, number];  // [width, height]

export interface CounterCondition {
  id: string;
  op: CounterOp;
  value: number;
}

/** Filter used by `self` / `other` in interaction triggers. */
export interface MatchSpec {
  /** Only valid on `other`. Position of the matched entity relative to self. */
  position?: RelativePosition;
  /** Only valid on `other`. */
  classId?: string;
  states?: string[];
  types?: string[];
  requiredTypes?: string[];
  forbiddenTypes?: string[];
  counter?: CounterCondition;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export type Effect =
  | { type: "changeState"; id: string }
  | { type: "changeStateOther"; id: string }
  | { type: "emitSignal"; id: string }
  | { type: "incrementCounterSelf"; id: string; amount: number }
  | { type: "incrementCounterOther"; id: string; amount: number }
  | { type: "destroySelf" }
  | { type: "destroyOther" }
  | { type: "transformSelf"; id: string }
  | { type: "transformOther"; id: string }
  | { type: "setRoom"; id: string } // pass "_next" to advance to next room
  | { type: "endTurn" }
  | { type: "endPlayerTurn" }
  | { type: "endAiTurn" }
  | { type: "sendAiInstruction"; message: string };

export type ButtonEffect =
  | Effect
  | {
      type: "createEntity";
      classId: string;
      position: GridCoord;
      overrides?: Partial<Record<OverridableProp, unknown>>;
    };

// ---------------------------------------------------------------------------
// Triggers / Interactions
// ---------------------------------------------------------------------------

export type TriggerEvent =
  | { type: "onMoved" }
  | { type: "onClick" }
  | { type: "onAiTrigger"; instructions: string }
  | { type: "onSignalReceived"; id: string };

export interface InteractionTriggers {
  events: TriggerEvent[]; // at least one
  self?: MatchSpec;       // position/classId must NOT be set on `self`
  other?: MatchSpec;
}

export interface Interaction {
  triggers: InteractionTriggers;
  effects: Effect[];
  aiInstructions?: string;
}

// ---------------------------------------------------------------------------
// Counters, States
// ---------------------------------------------------------------------------

export interface CounterDef {
  id: string;
  label?: string;
  initial: number;
  min?: number;
  max?: number;
}

export interface OverridePropSetting {
  prop: OverridableProp;
  value: unknown;
}

export interface StateDef {
  id: string;
  overrideProps?: OverridePropSetting[];
}

// ---------------------------------------------------------------------------
// Drop rules
// ---------------------------------------------------------------------------

export type DropRule =
  | { type: "adjacentTo"; classIds: string[] }
  | { type: "sameCell"; classIds: string[] }
  | { type: "inside"; classIds: string[] };

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export interface ClassDef {
  id: string;
  types?: string[];
  /** Single emoji or character. REQUIRED as a fallback when an image can't be loaded. */
  iconRef?: string;
  /** Unambiguous English key used to auto-generate a symbol image (e.g. "drinking_water"). */
  imageKey?: string;
  /** Path to a predefined custom symbol (e.g. "/api/custom-symbols/SYMBOL_ID/image"). */
  symbolPath?: string;
  imageColor?: string;
  tileColor?: string;
  label?: string;
  aiInstructions?: string;
  aiHidden?: boolean;
  size?: GridSize; // default [1, 1]
  layer?: Layer;   // default "entity"
  hidden?: boolean;
  isTile?: boolean;
  /** Single character. Must be unique across classes if defined. */
  char?: string;
  isSolid?: boolean;
  movable?: boolean;
  dropRules?: DropRule[];
  counters?: CounterDef[];
  canBeContained?: boolean;
  containSize?: number; // defaults to 1
  maxCapacity?: number;
  states?: StateDef[];
  interactions?: Interaction[];
  aiMovable?: boolean;
  aiCreatable?: boolean;
  aiCreatableProperties?: OverridableProp[];
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonDef {
  id: string;
  label?: string;
  iconRef?: string;
  imageKey?: string;
  symbolPath?: string;
  imageColor?: string;
  buttonColor?: string;
  effects: ButtonEffect[];
  enabledByDefault?: boolean;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomEntityInstance {
  classId: string;
  position: GridCoord;
  state?: string;
  /** Per-instance overrides, restricted to the OverridableProp whitelist. */
  overrides?: Partial<Record<OverridableProp, unknown>>;
  /** Per-instance initial counter values. */
  counters?: Record<string, number>;
}

export interface RoomDef {
  id: string;
  label?: string;
  aiInstructions?: string;
  size: GridSize;
  /** Single character fill for cells that don't resolve to a class in `tiles`. */
  defaultTile?: string;
  /** Optional ASCII room diagram. Dimensions must match `size`. */
  tiles?: string;
  entities?: RoomEntityInstance[];
  /** Button ids enabled in this room. Buttons with enabledByDefault may be omitted. */
  buttons?: string[];
}

// ---------------------------------------------------------------------------
// Top-level game definition
// ---------------------------------------------------------------------------

export interface GameDefinition {
  type: CustomAppType;
  label: string;
  iconRef?: string;
  imageKey?: string;
  symbolPath?: string;
  description?: string;
  aiInstructions?: string;
  turnBased?: boolean;
  classes: ClassDef[];
  buttons: ButtonDef[];
  rooms: RoomDef[];
  /** Starting room id. Must match a room in `rooms`. */
  startRoom: string;
}

// Alias for future non-game apps.
export type CustomAppDefinition = GameDefinition;
