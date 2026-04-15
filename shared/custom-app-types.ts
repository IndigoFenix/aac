/**
 * Custom App (Game) definition types.
 *
 * Mirrors planning-docs/game-generator-plan.md. Keep them in sync.
 * The authoritative spec lives in that doc; this file is the TS encoding.
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

export type CustomAppType = "game";

export type Layer = "background" | "entity" | "overlay";

export type RelativePosition =
  | "same_cell"
  | "adjacent"
  | "inside"
  | "contains";

export type CounterOp =
  | "gt"
  | "lt"
  | "eq"
  | "gte"
  | "lte";

// Properties that may appear in `states[].override_props` and per-instance
// room entity overrides. Kept narrow on purpose.
export type OverridableProp =
  | "image"
  | "image_color"
  | "tile_color"
  | "label"
  | "hidden"
  | "is_solid"
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
  class_id?: string;
  states?: string[];
  types?: string[];
  required_types?: string[];
  forbidden_types?: string[];
  counter?: CounterCondition;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export type Effect =
  | { type: "change_state"; id: string }
  | { type: "change_state_other"; id: string }
  | { type: "emit_signal"; id: string }
  | { type: "increment_counter_self"; id: string; amount: number }
  | { type: "increment_counter_other"; id: string; amount: number }
  | { type: "destroy_self" }
  | { type: "destroy_other" }
  | { type: "transform_self"; id: string }
  | { type: "transform_other"; id: string }
  | { type: "set_room"; id: string } // pass "_next" to advance to next room
  | { type: "end_turn" }
  | { type: "end_player_turn" }
  | { type: "end_ai_turn" }
  | { type: "send_ai_instruction"; message: string };

export type ButtonEffect =
  | Effect
  | {
      type: "create_entity";
      class_id: string;
      position: GridCoord;
      overrides?: Partial<Record<OverridableProp, unknown>>;
    };

// ---------------------------------------------------------------------------
// Triggers / Interactions
// ---------------------------------------------------------------------------

export type TriggerEvent =
  | { type: "on_moved" }
  | { type: "on_click" }
  | { type: "on_ai_trigger"; instructions: string }
  | { type: "on_signal_received"; id: string };

export interface InteractionTriggers {
  events: TriggerEvent[]; // at least one
  self?: MatchSpec;       // position/class_id must NOT be set on `self`
  other?: MatchSpec;
}

export interface Interaction {
  triggers: InteractionTriggers;
  effects: Effect[];
  ai_instructions?: string;
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
  override_props?: OverridePropSetting[];
}

// ---------------------------------------------------------------------------
// Drop rules
// ---------------------------------------------------------------------------

export type DropRule =
  | { type: "adjacent_to"; class_ids: string[] }
  | { type: "same_cell"; class_ids: string[] }
  | { type: "inside"; class_ids: string[] };

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export interface ClassDef {
  id: string;
  types?: string[];
  image?: string;
  image_color?: string;
  tile_color?: string;
  label?: string;
  ai_instructions?: string;
  ai_hidden?: boolean;
  size?: GridSize; // default [1, 1]
  layer?: Layer;   // default "entity"
  hidden?: boolean;
  is_tile?: boolean;
  /** Single character. Must be unique across classes if defined. */
  char?: string;
  is_solid?: boolean;
  movable?: boolean;
  drop_rules?: DropRule[];
  counters?: CounterDef[];
  can_be_contained?: boolean;
  contain_size?: number; // defaults to 1
  max_capacity?: number;
  states?: StateDef[];
  interactions?: Interaction[];
  ai_movable?: boolean;
  ai_creatable?: boolean;
  ai_creatable_properties?: OverridableProp[];
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonDef {
  id: string;
  label?: string;
  image?: string;
  image_color?: string;
  button_color?: string;
  effects: ButtonEffect[];
  enabled_by_default?: boolean;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomEntityInstance {
  class_id: string;
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
  ai_instructions?: string;
  size: GridSize;
  /** Single character fill for cells that don't resolve to a class in `tiles`. */
  default_tile?: string;
  /** Optional ASCII room diagram. Dimensions must match `size`. */
  tiles?: string;
  entities?: RoomEntityInstance[];
  /** Button ids enabled in this room. Buttons with enabled_by_default may be omitted. */
  buttons?: string[];
}

// ---------------------------------------------------------------------------
// Top-level game definition
// ---------------------------------------------------------------------------

export interface GameDefinition {
  type: CustomAppType;
  label: string;
  image?: string;
  description?: string;
  ai_instructions?: string;
  turn_based?: boolean;
  classes: ClassDef[];
  buttons: ButtonDef[];
  rooms: RoomDef[];
  /** Starting room id. Must match a room in `rooms`. */
  start_room: string;
}

// Alias for future non-game apps.
export type CustomAppDefinition = GameDefinition;
