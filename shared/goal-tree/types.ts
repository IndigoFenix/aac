// shared/goal-tree/types.ts
//
// Data shapes for the goal-tree game engine (v2 of the AI game generator).
// See planning-docs/app-generators/game-engine-v2-plan.md.
//
// A game is a recursive goal tree built from four node types:
//   reach    — travel to a place
//   collect  — gather n target items (optionally mixed with distractors)
//   choose   — pick the correct option (the curriculum carrier)
//   overcome — a lock whose key is a sub-tree
//
// The schema is deliberately CLOSED: every field is an enum, a validated
// reference, a clamped number, or pure flavor text. Mechanics are not
// expressible here — they live in playtested engine code. Nothing an LLM
// writes into this shape can make a game unwinnable; the solver certifies
// that before a game ever ships.

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type EntityKind = "item" | "character" | "obstacle" | "marker";

export interface EntityDef {
  /** Unique id, referenced by goal nodes. */
  id: string;
  kind: EntityKind;
  /** Player-facing display name, in the game's locale. */
  label: string;
  /** TTS pronunciation override; defaults to label. */
  spokenLabel?: string;
  /** Emoji fallback. */
  iconRef?: string;
  /** Key for the AAC image-generation pipeline. */
  imageKey?: string;
  /** Custom symbol path (same resolution as AAC boards). */
  symbolPath?: string;
  /** Semantic tags ("red", "animal") — used by semantic lint and reports. */
  tags?: string[];
  /** Flavor dialogue lines for characters (pre-rendered via TTS). */
  lines?: string[];
}

// ---------------------------------------------------------------------------
// Goal nodes
// ---------------------------------------------------------------------------

export interface GoalNodeBase {
  /** Unique across the whole tree. */
  id: string;
  /** Narration when the goal becomes active. */
  intro?: string;
  /** Narration when the goal is completed. */
  outro?: string;
}

/** Travel to a place. Creates a new zone in the projected map. */
export interface ReachNode extends GoalNodeBase {
  type: "reach";
  /** What the destination looks like (flag, house, grandma). kind: marker | character. */
  markerEntityId: string;
  /** Theme hint for the zone this creates ("dark forest"). */
  zoneHint?: string;
  /** Obstacles on the passage to this place. All must be cleared. */
  via?: OvercomeNode[];
}

/**
 * A group of collect targets placed together. Lets one collect goal hide part
 * of its items behind a lock ("collect 3 logs — one is behind a gate").
 */
export interface CollectPlacement {
  /** How many of the goal's items are in this group. */
  count: number;
  /** Obstacles guarding this group's pocket. Omit for freely reachable items. */
  via?: OvercomeNode[];
}

/** Gather `count` items drawn from `itemEntityIds`. */
export interface CollectNode extends GoalNodeBase {
  type: "collect";
  /** Acceptable target items (kind: item). The educational category is the set itself. */
  itemEntityIds: string[];
  /** Total number to collect. */
  count: number;
  /** Wrong items present in the area. Picking one gives gentle feedback, never failure. */
  distractorEntityIds?: string[];
  /**
   * How targets are grouped. Counts must sum to `count`.
   * Omitted = all items freely reachable in the collect zone.
   */
  placements?: CollectPlacement[];
  /** Theme hint for the collect zone. */
  zoneHint?: string;
  /** Obstacles gating the collect area itself. */
  via?: OvercomeNode[];
}

export interface ChooseOption {
  /** What the option shows (kind: item | character | marker). */
  entityId: string;
  /** Exactly one option per choose node is correct. */
  correct?: boolean;
  /** Gentle spoken feedback if this (wrong) option is picked. */
  feedback?: string;
}

/** Pick the correct option. Wrong picks get feedback and retry — never failure. */
export interface ChooseNode extends GoalNodeBase {
  type: "choose";
  /** Who poses the question (kind: character | marker). Stands in the context zone. */
  posedByEntityId: string;
  /** The spoken/displayed question. */
  prompt: string;
  /** 2–4 options, exactly one correct. */
  options: ChooseOption[];
}

/**
 * A lock whose key is a sub-tree. Appears either inside a `via` list (guarding
 * a passage) or directly as a goal (root "fix the bridge", or a key chain).
 * Resolves by satisfaction, never violence.
 */
export interface OvercomeNode extends GoalNodeBase {
  type: "overcome";
  /** The blocker's visual (kind: obstacle). */
  obstacleEntityId: string;
  /** What the obstacle "says" or shows when encountered. */
  prompt?: string;
  /** Completing this clears the obstacle. */
  key: GoalNode;
}

export type GoalNode = ReachNode | CollectNode | ChooseNode | OvercomeNode;
export type GoalNodeType = GoalNode["type"];

// ---------------------------------------------------------------------------
// Top-level game
// ---------------------------------------------------------------------------

export interface AiCompanion {
  /** The companion's in-game name. */
  name: string;
  /** Persona instructions for the live AI ("warm, cheers in short sentences"). */
  persona: string;
}

export interface GoalTreeGameMeta {
  title: string;
  description?: string;
  /** BCP-47 locale all player-facing strings are written in. */
  locale: string;
  /** Free-text theme ("farm", "space picnic"). */
  theme: string;
  aiCompanion?: AiCompanion;
  /** Human-readable learning goals, for clinician reports. */
  learningGoals?: string[];
}

export interface GoalTreeGame {
  engine: "goal-tree";
  engineVersion: 1;
  meta: GoalTreeGameMeta;
  entities: EntityDef[];
  /** Completing the root goal wins the game. */
  root: GoalNode;
}

/**
 * custom_apps.type for stored goal-tree games. Distinct from the legacy
 * "game" type so v1 consumers (old editor/player) never see the new shape.
 * The row's definition is { engine: "goal-tree", engineVersion, contentPack }.
 */
export const GOAL_TREE_APP_TYPE = "goal_tree_game";

// ---------------------------------------------------------------------------
// Limits (enforced by the schema; generation prompts should cite them)
// ---------------------------------------------------------------------------

/** Max nesting depth (root = 1; descending into `via` members or `key`). */
export const GOAL_TREE_MAX_DEPTH = 8;
/** Max total goal nodes in a tree (including via/key nodes). */
export const GOAL_TREE_MAX_NODES = 60;
/** Max entity definitions per game. */
export const GOAL_TREE_MAX_ENTITIES = 80;
/** Choose nodes carry 2..N options. */
export const CHOOSE_MAX_OPTIONS = 4;
/** Max items a single collect goal may require. */
export const COLLECT_MAX_COUNT = 12;
