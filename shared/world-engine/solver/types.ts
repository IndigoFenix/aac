// shared/goal-tree/types.ts
//
// Data shapes for the goal-tree game engine (v2 of the AI game generator).
// See planning-docs/app-generators/game-engine-v2-plan.md.
//
// A game is a recursive goal tree built from these node types:
//   reach    — travel to a place
//   collect  — gather n target items (optionally mixed with distractors)
//   choose   — pick the correct option (the curriculum carrier)
//   overcome — a lock whose key is a sub-tree
//   observe  — travel to a stage and WATCH a scripted demonstration, then it's
//              labelled with a glyph (the symbol-learning WATCH beat). Always
//              completable once reached — it teaches, it doesn't gate.
//   transport— carry an object to a destination (the "move A→B" puzzle). Always
//              completable once its zone is reached — it teaches, it doesn't gate.
//   converse — a deterministic multi-turn NPC dialogue TREE (the symbol game's
//              quest conversations). Each turn re-uses the choose presentation
//              (present-choice / select-option); options may be gated on what
//              the player carries and may transfer items (give/receive). See
//              planning-docs/symbol-learning-game-plan-2.md §7b.
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

// ---------------------------------------------------------------------------
// Converse — deterministic multi-turn NPC dialogue (the quest conversation)
// ---------------------------------------------------------------------------

/**
 * A condition on the player's SATCHEL (the runtime's item inventory, filled by
 * walking over converse props or by `receive` effects). Evaluated by the
 * runtime when a turn is presented and when an option is selected.
 */
export type ConverseCondition =
  | { kind: "carrying"; entityId: string }
  | { kind: "not-carrying"; entityId: string }
  /** The player KNOWS about the item — revealed by a clue, seen in a room, or once held. */
  | { kind: "knows"; entityId: string }
  /** The item was (at some point) handed over via a `give` — monotone, never un-given. */
  | { kind: "given"; entityId: string };

/**
 * One candidate NPC utterance for a turn. The FIRST line whose conditions all
 * hold is spoken (bubble + board prompt); the last line of every turn must be
 * unconditional so a turn can always render.
 */
export interface ConverseLine {
  when?: ConverseCondition[];
  /** The utterance as a composed glyph SENTENCE (doubles as the display text until i18n). */
  glyph: string;
}

/**
 * One player response on the board. Selecting it applies its transfers, plays
 * its cues, then either advances to `next`, closes the conversation (no
 * `next`), or completes the whole converse goal (`completes`). There is no
 * "wrong" option — every visible option is real communication (pillar: any
 * press is communication; re-model, never punish).
 */
export interface ConverseOption {
  /** What the option shows on the board (kind: item | character | marker). */
  entityId: string;
  /**
   * Availability gate. Only MONOTONE kinds are allowed here (schema-enforced):
   * `carrying`, `knows`, `given`. A `not-carrying`-gated option could become
   * permanently unavailable once an item is picked up, which the solver cannot
   * reason about — lines may use it, options may not.
   */
  when?: ConverseCondition[];
  /** Item entities handed TO the NPC (each must also appear in a `carrying` condition). */
  give?: string[];
  /** Item entities granted to the player's satchel. */
  receive?: string[];
  /** Item entities REVEALED to the player (clue effect — satisfies `knows`). */
  reveal?: string[];
  /** Payoff cues (same closed DemoCue set as observe/choose.onCorrect). */
  cues?: DemoCue[];
  /** Next turn id; omit to close the conversation (re-approachable, failure-free). */
  next?: string;
  /** Selecting this completes the converse goal (after effects/cues). */
  completes?: boolean;
}

/** One node of the dialogue graph: an NPC utterance + the player's responses. */
export interface ConverseTurn {
  /** Unique within this converse node. */
  id: string;
  /** Candidate NPC lines; first match speaks; last must be unconditional. */
  lines: ConverseLine[];
  /** 1..CONVERSE_MAX_OPTIONS board options; ≥1 must be unconditional. */
  options: ConverseOption[];
}

/**
 * A deterministic multi-turn NPC dialogue — the symbol game's quest
 * conversation. Like observe it creates its own zone (the NPC's room) with the
 * NPC standing in it; the runtime re-presents a fresh `present-choice` per
 * turn, so the space/player treats each turn exactly like a choose question.
 * Closing or cancelling resets to `entry` on re-approach; conditions are
 * re-evaluated then, so "come back once you have the item" branches work.
 * Completes only via an option marked `completes` — then the NPC goes inert.
 */
export interface ConverseNode extends GoalNodeBase {
  type: "converse";
  /** The NPC posing the dialogue (kind: character | marker). */
  npcEntityId: string;
  /** Entry turn id. */
  entry: string;
  turns: ConverseTurn[];
  /**
   * Item entities scattered in this node's zone as pickups (they enter the
   * satchel by walking over them) — the quest's "the thing you need is lying
   * nearby" placement. Each id appears once and must be kind item.
   */
  propEntityIds?: string[];
  /** Theme hint for the NPC's zone. */
  zoneHint?: string;
  /** Obstacles on the passage to the NPC's room. */
  via?: OvercomeNode[];
}

// ---------------------------------------------------------------------------
// Fulfill — a creature with a need (the need-based dialogue system's goal)
// ---------------------------------------------------------------------------

/**
 * The closed catalog of transformation STATIONS (Item Transformations b) —
 * physical world affordances that swap an item's STATE when it lands on them.
 * Kinds follow the village-systems elements (fire = heat/cook/dry, water =
 * cool/clean/wet); only the pair whose state glyphs ship in the registry is
 * active — clean/dirty and wet/dry join when their modifiers land.
 */
export const STATION_KINDS = {
  fire: { applies: "hot", removes: "cold", iconRef: "🔥", label: "Campfire" },
  water: { applies: "cold", removes: "hot", iconRef: "🛁", label: "Water tub" },
} as const;
export type StationKind = keyof typeof STATION_KINDS;

/**
 * WHY a fulfill creature's need exists — the goal-tree face of the symbol-game
 * CausalFact (planning-docs/symbol-learning-game/causation-and-elements.md §4).
 * Closed, ENTITY-ID-based data (no baked glyph strings); the game layer
 * verbalizes it through the dialogue projection. PURE NARRATION: no static or
 * simulation certification stage ever reads it, so a game's certifiability is
 * invariant to its causal facts (that invariant is the property test).
 */
/** A parameter-based want predicate — the goal-tree face of the symbol-game
 *  NeedTarget (motive-driven-needs.md). Closed data; the game layer matches. */
export interface FulfillNeedTarget {
  kind?: string;
  category?: string;
  descriptors?: string[];
  state?: string;
}

export interface FulfillCausalFact {
  connective: "because" | "therefore" | "in_order_to" | "when" | "until";
  /** The second clause (the cause / the goal). The need itself is clause one. */
  cause:
    | { kind: "possessionLack"; itemEntityId: string } // "{creature} have.not {item}"
    // "{creature} {state}" (happy/cold/hungry…). `creatureNodeId` names the
    // creature (a fulfill node id); omitted = the fulfill node's OWN creature.
    // A deliver's `in_order_to` goal points it at the RECIPIENT ("…in order to
    // Bear happy").
    | { kind: "creatureState"; state: string; creatureNodeId?: string }
    | { kind: "itemState"; itemEntityId: string; state: string } // "{item} {state}"
    // PREFERENCE (motive batch): "{creature} like {item|facet}" — "I want the
    // cookie because I like cookies" / "…because I like red" (facet = a bare
    // quality symbol like "color_red").
    | { kind: "likes"; itemEntityId?: string; facet?: string }
    // DESIRE-TO-DO (motive batch): "{creature} want {verb}" — "I want a toy
    // because I want to play" (verb = a registry action symbol: play/read/wear).
    | { kind: "wantsTo"; verb: string };
}

/**
 * A CREATURE and the goal of making it content. This is the goal-tree face of
 * the need-based system (planning-docs/symbol-learning-game/creature-needs.md):
 * the node carries the creature's SEED (need, likes, displayed stock, loose
 * props, initial debt) as closed data, the game layer reconstructs the creature
 * world from these nodes and runs the dialogue as a PROJECTION of its state,
 * and the node completes when the creature's need is fulfilled (a `fulfill-need`
 * input from the game layer; instantly completable when it has no need).
 *
 * Like observe/converse it creates its own zone with the NPC standing in it.
 * The static solver treats it like transport (reachable ⇒ completable — the
 * behavioral guarantee comes from the symbol-game SIMULATION certifier, which
 * plays the generated world with the same rules the client runs).
 */
export interface FulfillNode extends GoalNodeBase {
  type: "fulfill";
  /** The creature (kind: character | marker). */
  npcEntityId: string;
  /** What it needs (kind: item). Absent = a content creature (pure vendor). */
  needItemEntityId?: string;
  /** FURTHER needed item instances (kind: item) — a multi-item need ("bring me
   *  3 apples"): one need per instance, the creature is content only when ALL
   *  fulfill. Requires needItemEntityId (which counts as the first). */
  needItemEntityIds?: string[];
  /** Worth of the need (default 3). */
  needValue?: number;
  /** STATE need (Task b): the need fulfills when the needed item is physically
   *  PLACED in this container (kind: item; staged in the creature's zone by
   *  the space layer), not when the creature receives it. */
  needPlacedInEntityId?: string;
  /** ON-BEHALF need (Task c): the need fulfills when the creature of THIS
   *  fulfill node (the recipient) has the item — "give the ball to Bear" —
   *  not when this creature receives it. Mutually exclusive with
   *  needPlacedInEntityId. */
  needForNodeId?: string;
  /** PRESENCE (go-to) need (§5): the need fulfills when the PLAYER reaches the
   *  creature of THIS fulfill node — "go to Bear". No item; the destination is
   *  another (needless) fulfill creature in its own zone. */
  needAtPlaceNodeId?: string;
  /** STAY-WITH need (motive batch): the creature wants the player's COMPANY —
   *  "stay with me (because I'm lonely)". No item, no destination: the player
   *  DWELLS near this creature for a while and the need fulfills (the world
   *  layer times it and reports arrival). Pairs with `condition: "lonely"`. */
  needStayWith?: boolean;
  /** ESCORT flavor on a presence need (motive batch): the CREATURE ITSELF must
   *  reach needAtPlaceNodeId — "take me to Bear". After the player agrees, the
   *  creature follows; arrival at the destination fulfills. Requires
   *  needAtPlaceNodeId. */
  needEscort?: boolean;
  /** OUTDOORS placement flag (motive batch): stage needPlacedInEntityId in the
   *  open start-zone plaza instead of the creature's room — "take the smelly
   *  food OUT to the garbage". Requires needPlacedInEntityId. */
  needPlacedOutdoors?: boolean;
  /** TRANSFORMED-state requirement (Item Transformations b): the need only
   *  accepts the item once a station has put this state on it ("hot"/"cold" —
   *  a STATION_KINDS `applies` value). The untransformed offer is declined
   *  with "{item} + {state}.not". */
  needItemState?: string;
  /** DEVICE-state need (§5): needItemEntityId is a fixed DEVICE and the need
   *  fulfills when it is TOGGLED to this state ("on"/"closed"). The device
   *  entity carries its initial (opposite) state in its glyph ("window.open").
   *  A state need — never a hand-over. */
  needDeviceState?: string;
  /** POWER chain (§5): a GENERATOR device (kind: item) that powers the device
   *  need — the need's device is `poweredBy` it, so the player must switch the
   *  generator ON first. The generator spawns in the room in its resting state.
   *  Only meaningful with needDeviceState. */
  powerDeviceEntityId?: string;
  /** Transformation STATIONS staged in this creature's zone (physical
   *  affordances, not creatures): dropping an item on one applies its state.
   *  Reusable — any item, any number of times. */
  stationKinds?: StationKind[];
  /** POWER-GATED station (§5, the P1 chain): a GENERATOR device (kind: item)
   *  that must be switched ON before this creature's station will transform
   *  anything ("power the fridge to cool the food"). Only meaningful with
   *  stationKinds. */
  stationPowerDeviceId?: string;
  /** Items it values at baseline — receiving one creates a debt (kind: item). */
  likeEntityIds?: string[];
  /** Possessions on DISPLAY behind its counter — visible, owned, requestable (kind: item). */
  stockEntityIds?: string[];
  /** Loose unclaimed items scattered in its room (kind: item). */
  propEntityIds?: string[];
  /** Initial debt to the player (the rental/free vendor's "you may take one"). */
  playerDebt?: number;
  /** Does it volunteer its need unprompted ("before", default), only when
   *  asked ("after"), or NEVER ("never" — Request c: it just looks sad, and
   *  the player must INFER the want from evidence and offer it)? */
  announce?: "before" | "after" | "never";
  /** Possessions the creature KEEPS (bound from the start): displayed beside
   *  it but never granted — "that's mine". With announce "never" a same-kind
   *  keepsake is the inference EVIDENCE (the sad bear's beloved apple). */
  boundEntityIds?: string[];
  /** Request-c scaffold: float the hidden want in a THOUGHT bubble over the
   *  creature (the low-phase errorless aid; fades to evidence-only when the
   *  phase layer lands). Only meaningful with announce "never". */
  thoughtScaffold?: boolean;
  /** WHY the need exists (causation-and-elements.md §4) — surfaced by the WHY
   *  act (a `because` fact) or spoken by the need line (an `in_order_to`
   *  remedy). Narration only; every certification stage ignores it. */
  causalFact?: FulfillCausalFact;
  /** A bad SELF-CONDITION this creature is in ("cold"/"dirty" — §5): its line
   *  leads with it ("i_me + want + {remedy} + because + i_me + cold") and it
   *  CLEARS when the need fulfills (the getting-better demonstration). Requires
   *  a need. Narration + a cleared-state demo; certification ignores it. */
  condition?: string;
  /** A PARAMETER-based want (motive-driven-needs.md): the need is satisfied by
   *  ANY item matching this predicate (loose), not just needItemEntityId. When
   *  a motive generates it (cold → {state:"hot"}), the want reads "something
   *  hot". needItemEntityId is still the INTENDED instance (cert + base). */
  needTarget?: FulfillNeedTarget;
  /** How much a MOTIVE-driven want is revealed (motive-driven-needs.md §4):
   *  "want" (states the want, WHY reveals the motive), "because" (want because
   *  motive, default), or "motive" (just the condition — the want is inferred). */
  motiveReveal?: "want" | "because" | "motive";
  /** Does the creature know WHERE its need item is at start? Default true (the
   *  puzzle-mode always-know rule — its where-is always yields a clue). false =
   *  ask-around missions: it answers "I don't know"; seed the fact on another
   *  creature via knowsItemEntityIds so the clue chain still exists. */
  needLocationKnown?: boolean;
  /** Items whose LOCATION this creature knows at start, beyond its own
   *  possessions (kind: item) — the clues it can give when asked where-is.
   *  Knowledge, not placement: the items live in other creatures' rooms. */
  knowsItemEntityIds?: string[];
  /** Theme hint for the creature's zone. */
  zoneHint?: string;
  /** Obstacles on the passage to the creature's room. */
  via?: OvercomeNode[];
}

export type GoalNode =
  | ReachNode
  | CollectNode
  | ChooseNode
  | OvercomeNode
  | ObserveNode
  | TransportNode
  | ConverseNode
  | FulfillNode;
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
  /** Dialogue SYNTAX level the player renders creature lines/acts at:
   *  "a" = single glyphs, "b" = two, "c" = full sentences (≈3). Default "b". */
  syntax?: "a" | "b" | "c";
  /**
   * How a STAR-shaped world is laid out into geometry (the world engine's
   * building template the goal tree is mapped onto):
   *   "village" (default) — a central plaza ringed by separate HOUSES.
   *   "house"             — ONE building: a central hall with each zone a
   *                         color-coded ROOM off it (the one-building
   *                         household puzzle).
   * Ignored for non-star worlds (they fall back to the east-icicle layout).
   */
  layout?: "village" | "house";
  /**
   * The uint32 seed the game was generated from. Downstream procedural stages
   * (village layout, buildings, house colors) derive their randomness from it,
   * so one seed reproduces the whole world end to end.
   */
  seed?: number;
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
/** Max dialogue turns in a single converse node. */
export const CONVERSE_MAX_TURNS = 16;
/** Max board options per converse turn (the response board fits 8; 6 keeps them large). */
export const CONVERSE_MAX_OPTIONS = 6;
/** Max candidate NPC lines per converse turn. */
export const CONVERSE_MAX_LINES = 4;
/** Max prop pickups a converse node scatters in its zone. */
export const CONVERSE_MAX_PROPS = 6;
/** Max items in each of a fulfill node's lists (likes/stock/props). */
export const FULFILL_MAX_ITEMS = 6;
