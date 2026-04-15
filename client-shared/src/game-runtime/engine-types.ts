/**
 * Runtime state and action types for the game engine.
 *
 * The engine is a pure reducer: `dispatch(state, action, def) => nextState`.
 * No React here — the React layer lives in GameRuntime.tsx.
 */

import type {
  GameDefinition,
  GridCoord,
  Layer,
  OverridableProp,
} from "@shared/custom-app-types";

/** A single spawned entity instance inside a room. */
export interface EntityInstance {
  /** Unique runtime id. Stable across ticks as long as the entity exists. */
  uid: string;
  class_id: string;
  position: GridCoord;
  /** "_default" until a state change sets otherwise. */
  state: string;
  /** Flattened per-entity counter values, resolved from class defaults. */
  counters: Record<string, number>;
  /** uid of the container that currently holds this entity, if any. */
  container_uid?: string;
  /** Per-instance property overrides (from room def + state override_props merged in). */
  overrides: Partial<Record<OverridableProp, unknown>>;
}

export type Turn = "player" | "ai";

/** Engine-surfaced event. Useful for logging, AI notifications, UI feedback. */
export type EngineEvent =
  | { type: "entity_created"; uid: string; class_id: string; position: GridCoord }
  | { type: "entity_destroyed"; uid: string; class_id: string }
  | { type: "entity_moved"; uid: string; from: GridCoord; to: GridCoord }
  | { type: "entity_transformed"; uid: string; from_class: string; to_class: string }
  | { type: "state_changed"; uid: string; from: string; to: string }
  | { type: "counter_changed"; uid: string; counter: string; from: number; to: number }
  | { type: "signal_emitted"; id: string }
  | { type: "room_changed"; from: string; to: string }
  | { type: "turn_changed"; from: Turn; to: Turn }
  | { type: "ai_instruction"; message: string }
  | { type: "cascade_aborted"; reason: string }
  | { type: "error"; message: string };

export interface RuntimeState {
  currentRoomId: string;
  entities: Record<string, EntityInstance>;
  /** Button id -> enabled flag (overrides room default). */
  buttons: Record<string, { enabled: boolean }>;
  turn: Turn;
  turnBased: boolean;
  /** Instruction messages queued for the AI. Consumed by the AI prompt layer. */
  pendingAiInstructions: string[];
  gameOver: boolean;
  /** Monotonic counter used to generate unique uids. */
  uidSeq: number;
}

// ---------------------------------------------------------------------------
// Actions: things the player / UI / AI tell the engine to do.
// ---------------------------------------------------------------------------

export type EngineAction =
  | { type: "click"; targetUid: string }
  | { type: "move"; movingUid: string; to: GridCoord }
  | { type: "drop_into_container"; movingUid: string; containerUid: string }
  | { type: "button_press"; buttonId: string }
  | {
      type: "ai_trigger";
      classId: string;
      interactionIndex: number;
      selfUid: string;
      otherUid?: string;
    }
  | {
      type: "ai_create";
      classId: string;
      position: GridCoord;
      overrides?: Partial<Record<OverridableProp, unknown>>;
    };

// ---------------------------------------------------------------------------
// Tick result
// ---------------------------------------------------------------------------

export interface TickResult {
  state: RuntimeState;
  events: EngineEvent[];
}

/** Everything needed to run a game. */
export interface EngineInit {
  def: GameDefinition;
}

// Re-exports for convenience in the React layer.
export type { GameDefinition, GridCoord, Layer, OverridableProp };
