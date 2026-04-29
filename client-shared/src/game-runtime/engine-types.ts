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
  classId: string;
  position: GridCoord;
  /** "_default" until a state change sets otherwise. */
  state: string;
  /** Flattened per-entity counter values, resolved from class defaults. */
  counters: Record<string, number>;
  /** uid of the container that currently holds this entity, if any. */
  containerUid?: string;
  /** Per-instance property overrides (from room def + state overrideProps merged in). */
  overrides: Partial<Record<OverridableProp, unknown>>;
  /**
   * Monotonic sequence value bumped each time the entity is spawned or
   * successfully moved. Used as the tie-breaker in the render-order sort so
   * the most-recently-placed entity sits on top within its layer.
   */
  placedSeq: number;
}

export type Turn = "player" | "ai";

/** Engine-surfaced event. Useful for logging, AI notifications, UI feedback. */
export type EngineEvent =
  | { type: "entityCreated"; uid: string; classId: string; position: GridCoord }
  | { type: "entityDestroyed"; uid: string; classId: string }
  | { type: "entityMoved"; uid: string; from: GridCoord; to: GridCoord }
  | { type: "entityTransformed"; uid: string; fromClass: string; toClass: string }
  | { type: "stateChanged"; uid: string; from: string; to: string }
  | { type: "counterChanged"; uid: string; counter: string; from: number; to: number }
  | { type: "signalEmitted"; id: string }
  | { type: "roomChanged"; from: string; to: string }
  | { type: "turnChanged"; from: Turn; to: Turn }
  | { type: "aiInstruction"; message: string }
  | { type: "cascadeAborted"; reason: string }
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
  /** Monotonic counter incremented on every spawn and successful move. */
  placedSeq: number;
}

// ---------------------------------------------------------------------------
// Actions: things the player / UI / AI tell the engine to do.
// ---------------------------------------------------------------------------

export type EngineAction =
  | { type: "click"; targetUid: string }
  | { type: "move"; movingUid: string; to: GridCoord }
  | { type: "dropIntoContainer"; movingUid: string; containerUid: string }
  | { type: "buttonPress"; buttonId: string }
  | {
      type: "aiTrigger";
      classId: string;
      interactionIndex: number;
      selfUid: string;
      otherUid?: string;
    }
  | {
      type: "aiCreate";
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
