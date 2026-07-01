// shared/goal-tree/types.ts
//
// Data shapes for the goal-tree game engine (v2 of the AI game generator).
// See planning-docs/app-generators/game-engine-v2-plan.md.
//
// A game is a recursive goal tree built from five node types:
//   reach    — travel to a place
//   collect  — gather n target items (optionally mixed with distractors)
//   choose   — pick the correct option (the curriculum carrier)
//   overcome — a lock whose key is a sub-tree
//   observe  — travel to a stage and WATCH a scripted demonstration, then it's
//              labelled with a glyph (the symbol-learning WATCH beat). Always
//              completable once reached — it teaches, it doesn't gate.
//   transport— carry an object to a destination (the "move A→B" puzzle). Always
//              completable once its zone is reached — it teaches, it doesn't gate.
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
  /**
   * A composed AAC glyph SENTENCE this entity renders as — the same syntax the
   * compositor/registry use ("want.not", "give + ball"). Used by the
   * symbol-learning game so a `choose` option can display a composed glyph and
   * be locked to the AAC response board as a BoardOption. Optional; ordinary
   * games leave it unset and fall back to label/iconRef.
   */
  glyph?: string;
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
  /**
   * Cues played as a PAYOFF when the correct option is chosen — the contingency
   * beat of the symbol game ("press MORE → a bubble pops out"). The same CLOSED,
   * entity-referencing DemoCue set the observe beat uses (deliberately NOT the
   * full SpaceCommand union: a closed cue set can't reference a bad passage/
   * instance and so can't express brokenness). Delivered to the space via the
   * existing `demonstrate` command. Optional; omit for a pure pick-the-answer
   * beat. See planning-docs/symbol-learning-game-plan.md §4.1/§7.
   */
  onCorrect?: DemoCue[];
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

/**
 * One scripted beat of a demonstration, played when the child reaches an
 * observe stage. A CLOSED set of clamped, entity-referencing cues — the same
 * discipline as the rest of the schema: an LLM can compose cues but cannot
 * express arbitrary behavior. The cue RUNNER (which animates these in the 3D
 * world) lives in the renderer; this is just the authored script. Concepts map
 * to cues per planning-docs/symbol-learning-game-plan.md §6 (e.g. big/small →
 * scale, go/come → move, more → spawn, happy/sad → emote, hot/cold → glow).
 */
export type DemoCue =
  /** Grow/shrink a prop to `to`× its size (big/small). */
  | { kind: "scale"; entityId: string; to: number; seconds?: number }
  /** Translate a prop by (dx,dy) world units (go/come, up/down, fast/slow). */
  | { kind: "move"; entityId: string; dx: number; dy: number; seconds?: number }
  /** Multiply a prop into `count` copies (more/again). */
  | { kind: "spawn"; entityId: string; count: number }
  /** Show an emotion on a prop's face (happy/sad). */
  | { kind: "emote"; entityId: string; emotion: "happy" | "sad" }
  /** Wrap a prop in a warm/cool halo (hot/cold). */
  | { kind: "glow"; entityId: string; tone: "warm" | "cool" };

/**
 * Travel to a stage and watch a demonstration that grounds an abstract concept,
 * then connect it to its glyph. The WATCH beat of the symbol-learning loop.
 * Like reach it creates a zone with a figure you approach; unlike reach, arriving
 * plays `demonstrate` and labels it with `targetGlyph`. Never gates progress —
 * the solver treats it as trivially completable once its zone is reachable.
 */
export interface ObserveNode extends GoalNodeBase {
  type: "observe";
  /** The registry glyph this beat teaches ("big", "go", "i_me+want+apple"). */
  targetGlyph: string;
  /** Optional opposite, staged alongside for contrast ("small"). */
  contrastGlyph?: string;
  /** The thing the child approaches to watch (kind: marker | character | item). */
  stageEntityId: string;
  /** Theme hint for the stage zone. */
  zoneHint?: string;
  /** The scripted demonstration, played on arrival (1..OBSERVE_MAX_CUES cues). */
  demonstrate: DemoCue[];
  /** Obstacles on the passage to the stage. All must be cleared. */
  via?: OvercomeNode[];
}

/** Where a transported object must end up on its destination container. */
export type TransportRelation = "on" | "in" | "under";

/**
 * Carry an object to a destination — the "move object A→B" puzzle. The child
 * picks up `objectEntityId` (a carryable world object placed in the node's zone)
 * and puts it down on/in/under `destEntityId` (a container placed there too). The
 * player materializes both as real world-engine objects; completing it means the
 * object was placed on the destination (with `relation` if specified). Never
 * gates by itself — solvable once its zone is reachable.
 */
export interface TransportNode extends GoalNodeBase {
  type: "transport";
  /** The carryable object to move (kind: item). */
  objectEntityId: string;
  /**
   * Optional WRONG carryables placed alongside the target — turns "carry A→B"
   * into "carry the RIGHT one" selection (kind: item). The player materializes
   * them as carryables too; only `objectEntityId` landing on the destination
   * completes the beat, and a wrong one is gently DECLINED (ejected to carry
   * again) — never a fail state. Omit for a plain single-object transport.
   */
  distractorEntityIds?: string[];
  /** The destination container to place it on/in/under (kind: marker). */
  destEntityId: string;
  /** Required placement relation; omit to accept any slot the destination offers. */
  relation?: TransportRelation;
  /** Theme hint for the puzzle zone. */
  zoneHint?: string;
  /** Obstacles on the passage to the puzzle zone. All must be cleared. */
  via?: OvercomeNode[];
}

export type GoalNode =
  | ReachNode
  | CollectNode
  | ChooseNode
  | OvercomeNode
  | ObserveNode
  | TransportNode;
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
/** Max cues in a single observe demonstration. */
export const OBSERVE_MAX_CUES = 12;
