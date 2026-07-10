// shared/world-engine/types.ts
//
// Closed data model for the data-driven world engine. A WorldSpec is a pure
// JSON document an app ships (and, later, an AI generates) describing a world;
// the engine turns it into a live simulation. Same discipline as the goal-tree
// engine (shared/goal-tree): mechanics are playtested CODE, content is DATA.
// Nothing expressible in a WorldSpec can crash or diverge the simulation —
// every field is an enum, a clamped number, a validated reference, or flavor.
//
// v1 is intentionally minimal: a flat 2D manifold, flat terrain, spawn points,
// and arcade "toys" (the soccer ball). The shape leaves room for the planned
// axes (sphere manifold, terrain archetypes, an embedded goal-tree content
// layer) without committing to them yet — those land as new enum members /
// spec variants, never as engine rewrites.

// ---------------------------------------------------------------------------
// Geometry primitive
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

/** An axis-aligned rectangle in world units (origin at its min corner). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A road/path RIBBON painted flat on the ground — render-only cosmetic geometry
 * a 3D view flattens onto the field to designate streets. NOT part of the
 * certified WorldSpec and never touches the sim: a view receives it out-of-band
 * (World3DRendererOptions.roads), the way `backdrop` is a view option, not spec.
 * Points are world coords (a world point (x, y) → the 3D ground point (x, 0, y)).
 */
export interface RoadPath {
  /** Centerline polyline in world coords; ≥2 points draw a ribbon. */
  points: Vec2[];
  /** Full ribbon width, world units. */
  width: number;
}

// ---------------------------------------------------------------------------
// Spec enums (reserved members are documented but not yet schema-valid)
// ---------------------------------------------------------------------------

export type ManifoldKind = "flat"; // "sphere" reserved for a later milestone
export type TerrainKind = "flat";
/** An object's visual + collision form. "sphere" = a ball; "box" = a crate/table. */
export type ObjectShape = "sphere" | "box";
/** How a player may interact with an object:
 *   • "push"  — move into it to dribble/kick it around (the soccer-ball behavior),
 *   • "carry" — pick it up (it follows you), then put it down at a dwelled spot. */
export type ObjectInteraction = "push" | "carry";
/** Where a held object rests when placed in/on a container — basic relational
 *  concepts a learning game can teach. A table offers "on" and "under". */
export type ContainRelation = "on" | "in" | "under";
export type ContentKind = "sandbox"; // "goal-tree" reserved (embed via Space)
export type MultiplayerAuthority = "distributed";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface WorldMeta {
  title: string;
  description?: string;
  /** BCP-47 locale for any player-facing strings. */
  locale: string;
  /** Free-text theme ("playground", "meadow"). */
  theme: string;
}

/**
 * The geometry the world lives on. v1: a finite flat rectangle in abstract
 * world units, origin at (0,0), extent (width, height). "Up" is implicit (the
 * sim is 2D); a 3D renderer interprets this rectangle as a ground plane.
 */
export interface FlatManifoldSpec {
  kind: "flat";
  width: number;
  height: number;
}
export type ManifoldSpec = FlatManifoldSpec;

export interface FlatTerrainSpec {
  kind: "flat";
  /** Cosmetic ground tint, hex. Render-only; never affects the sim. */
  groundColor?: string;
}
export type TerrainSpec = FlatTerrainSpec;

export interface SpawnSpec {
  id: string;
  x: number;
  y: number;
  /** Initial facing in radians (0 = +x). Defaults to 0. */
  facing?: number;
}

/**
 * Possession-dribble tuning for a "push" object (the soccer-ball behavior):
 * whoever touches it controls it while moving; a hard stop or a sharp brake
 * releases it carrying the player's velocity, so the "kick" is emergent rather
 * than a separate verb. All params are clamped by the schema. Present only when
 * an object's interactions include "push".
 */
export interface PushSpec {
  /** Distance ahead of the possessor the object is carried. */
  dribbleDistance: number;
  /** Fraction of velocity RETAINED per second while rolling free (0..1). */
  friction: number;
  /** A possessor slower than this (units/sec) drops the object. */
  releaseSpeed: number;
  /** An avatar within this distance of a FREE object may take possession. */
  touchRadius: number;
}

/** One containment slot a container object offers — a relation (on/in/under) and
 *  how many held objects can occupy it. A table = [{relation:"on"},{relation:"under"}]. */
export interface ContainmentSlot {
  relation: ContainRelation;
  /** Max objects in this slot. Defaults to 1. */
  capacity?: number;
}

/**
 * A world object — the generalized primitive that replaces the soccer-ball toy.
 * Its `shape` is how it looks/collides and its `interactions` are what the player
 * can do with it (push it around, or carry it and put it down). A container also
 * declares `contains` slots — what can be placed on/in/under it.
 */
/** Archetypal FURNITURE: static containers stood along a room's walls.
 *  A chest and a cupboard hold things "in" (lidded — they ease open when
 *  someone stands close, the door rule); a table holds things "on",
 *  visibly (containment lifts them to the tabletop). */
export type FixtureKind = "chest" | "cupboard" | "table";

export interface ObjectSpec {
  id: string;
  x: number;
  y: number;
  shape: ObjectShape;
  /** Collision/visual radius, world units (a box's half-extent). */
  radius: number;
  /** A FIXTURE: static furniture — solid to walk into (a square footprint
   *  of `radius` half-extent), never pushed or carried; `interactions`
   *  may be empty since a fixture is a container. Streamed worlds may
   *  abstract fixtures away with their building (add/removeWorldObject). */
  fixture?: FixtureKind;
  /** A lidded fixture eases open while someone stands beside it. */
  openable?: boolean;
  /** Which way the fixture faces (radians, 0 = +x) — into the room. */
  facing?: number;
  /**
   * Optional emoji drawn as a billboarded sprite floating over the object, so
   * carryable props read as what they ARE (a cookie, an apple) rather than
   * identical boxes — needed for "carry the right one" selection. Render-only;
   * never affects the sim.
   */
  iconRef?: string;
  /**
   * Composed AAC glyph for the floating icon (e.g. "ball.big"). When set, the
   * renderer swaps the emoji for the game's glyph-rastered image as soon as it
   * decodes — variant items (descriptors) must LOOK like their glyph, which a
   * shared emoji can't show. `iconRef` stays the instant placeholder.
   * Render-only; never affects the sim.
   */
  glyph?: string;
  /** What the player may do with it (≥1). */
  interactions: ObjectInteraction[];
  /** Possession-dribble tuning — used only when interactions include "push". */
  push?: PushSpec;
  /** Containment slots, for a container (a table). Omit for plain objects. */
  contains?: ContainmentSlot[];
}

// ---------------------------------------------------------------------------
// Structures — static collision geometry the engine owns
// ---------------------------------------------------------------------------

/**
 * A structure is fixed collision geometry the ENGINE builds a MoveConstraint
 * from — unlike `objects`, which are movable (push/carry/contain). v1 ships the
 * two floor-less kinds: a `wall` (a solid segment) and a `door` (a wall segment
 * with a gate that swings open on approach). Buildings + stairs (which need a
 * vertical floor index) are a later phase.
 */
export type StructureKind = "wall" | "door" | "stairs";

/** A solid wall: anything within `thickness`/2 of the centerline segment a→b is
 *  impassable (a capsule, so corners are rounded by the avatar radius). */
export interface WallSpec {
  kind: "wall";
  id: string;
  a: Vec2;
  b: Vec2;
  /** Full wall thickness, world units. */
  thickness: number;
  /** Floor this wall exists on. Omit ⇒ it blocks on EVERY floor (a full-height
   *  exterior wall); set it to confine the wall to one storey's interior. */
  floor?: number;
  /** Render tint (hex). Omit ⇒ the renderer's default wall color. */
  color?: string;
}

/**
 * A door — a wall segment with a leaf that swings open. It blocks like a wall
 * while CLOSED and is passable while OPEN; the engine eases it open whenever an
 * avatar is within `openRadius` (and it isn't locked) and shut again once nobody
 * is near, so it "swings out as you walk through, then closes."
 */
export interface DoorSpec {
  kind: "door";
  id: string;
  a: Vec2;
  b: Vec2;
  thickness: number;
  /** Endpoint the leaf is hinged at (swings about it). Defaults to "a". */
  hinge?: "a" | "b";
  /** An avatar within this distance of the door's center opens it. Defaults to
   *  a sensible multiple of the door's width. */
  openRadius?: number;
  /** Starts locked — stays solid (a wall) until unlocked. */
  locked?: boolean;
  /** A carryable object id that acts as this door's key: an avatar carrying it
   *  into `openRadius` unlocks the door (then it opens like any other). */
  keyObjectId?: string;
  /** Floor the door sits on. Omit ⇒ all floors (see WallSpec.floor). */
  floor?: number;
  /** Render tint (hex) for the doorway's LINTEL (the wall band above the leaf)
   *  — buildings propagate their wall color here. The leaf itself always keeps
   *  the door colors (incl. the darker locked shade) so it reads as a door. */
  color?: string;
}

/**
 * A stairway — the floor-changer. It isn't solid; standing on its `rect` ramps
 * the avatar's `floor` from `fromFloor` (at the start edge) to `toFloor` (at the
 * end edge) as it crosses along `axis`. Step off the top and you're on the upper
 * floor; off the bottom, the lower. Generated inside multi-storey buildings.
 */
export interface StairSpec {
  kind: "stairs";
  id: string;
  rect: Rect;
  fromFloor: number;
  toFloor: number;
  /** Direction of ASCENT across the footprint: floor reaches `toFloor` at this
   *  edge. e.g. "+y" ⇒ low at rect.y, high at rect.y + rect.h. */
  axis: "+x" | "-x" | "+y" | "-y";
}

export type StructureSpec = WallSpec | DoorSpec | StairSpec;

/** A gap in a building's perimeter where a door is generated. `offset` is the
 *  distance along the edge (from its start corner: N/S run +x, W/E run +y). */
export interface BuildingDoorway {
  edge: "north" | "south" | "east" | "west";
  offset: number;
  width: number;
  locked?: boolean;
}

/**
 * A building — a multi-storey enclosure. It is sugar over the structural layer:
 * `expandWorldBuildings` turns each one into real perimeter wall + door
 * structures (minus its doorways) and, when `floors` > 1, a stairway per storey,
 * so collision stays uniform. The renderer additionally draws its floor slabs +
 * roof and fades floors above the occupant when the camera is overhead, so you
 * can see a player who has walked inside.
 */
export interface BuildingSpec {
  id: string;
  footprint: Rect;
  /** Number of storeys (≥1). */
  floors: number;
  /** Exterior wall thickness, world units. */
  wallThickness: number;
  doorways?: BuildingDoorway[];
  /** Auto-generate a stairway connecting each storey. Defaults to true when
   *  floors > 1; set false to place stairs by hand as `structures`. */
  stairs?: boolean;
  /** Render tint (hex) for the walls + roof — "the blue house". Propagated to
   *  the generated wall structures by expandWorldBuildings. */
  color?: string;
}

// ---------------------------------------------------------------------------
// NPCs — AI-driven inhabitants of the world
// ---------------------------------------------------------------------------

/**
 * How an NPC moves when it isn't actively engaged in conversation.
 *   • "stationary"      — holds its spawn; turns to face the nearest person.
 *   • "wander"          — roams to random waypoints, pausing between them.
 *   • "approach_nearest"— walks up to the nearest person and holds a
 *                         conversational distance (roams when nobody is around).
 * The behavior only ever produces a STEERING AIM; the same locomotion that moves
 * a player avatar (engine.advanceAvatar) carries the NPC, so it can't diverge.
 */
export type NpcMovement = "stationary" | "wander" | "approach_nearest";

export interface NpcBehaviorSpec {
  movement: NpcMovement;
  /**
   * Distance (world units) at which the NPC treats a person as a conversation
   * partner — it stops approaching and holds here, and (Phase 2) this is the
   * range the social brain engages over. Defaults to the proximity-circle radius.
   */
  conversationRadius?: number;
  /**
   * Tether for `wander` (and the roam fallback of `approach_nearest`): waypoints
   * are picked within this distance of the NPC's SPAWN point instead of anywhere
   * on the manifold. Omit for free roam (the pre-existing behavior — right for a
   * world that IS one place; a streamed large world sets it so villagers stay in
   * their village).
   */
  wanderRadius?: number;
  /**
   * Tether ANCHOR for `wanderRadius`. Defaults to the spawn point — right when
   * an NPC spawns at home. A streamed NPC spawned mid-errand (a villager
   * embodied on their way to market) sets this to where they live, so once the
   * errand ends they drift around their own house, not around the spot they
   * happened to materialize.
   */
  home?: Vec2;
  /**
   * Walking pace, world units/sec. Defaults to the engine's steerMaxSpeed
   * (player pace, 5). Townsfolk stroll slower — and a game layer that
   * projects an NPC's position from a schedule clock (grand-dream's food
   * errands) sets this to the SAME speed the clock assumes, so the body and
   * the projection stay in step.
   */
  speed?: number;
}

/**
 * The NPC's social persona. These fields MIRROR the `social_trainer` app's
 * startup params (server/services/dual-agent/app-registry.ts) one-for-one so the
 * social brain (Phase 2) can pass them straight to generatePersona /
 * DirectedSession — an NPC and a hand-launched Social Trainer share one character
 * pipeline. All optional: the generator samples anything omitted.
 */
export interface NpcPersonaSpec {
  /** "any" → randomized. */
  genderHint?: "male" | "female" | "any";
  /** Personality archetype id, or "any" to randomize. Validated by the brain, not
   *  the world schema, so new archetypes don't require a world-engine bump. */
  archetypeHint?: string;
  /** Up to a few topics the NPC should love — ideally the student's interests. */
  interestHints?: string[];
  /** How demanding the NPC is. */
  difficulty?: "gentle" | "medium" | "challenging";
  /** The social situation to frame ("greeting", "making_friends", …). */
  scenario?: string;
  /** Optional social skills to focus the session on. */
  targetSkills?: string[];
}

/**
 * An AI-driven inhabitant of the world. In the sim it is just an avatar whose
 * steering aim comes from an NpcController (shared/world-engine/npc-controller.ts)
 * instead of a pointer — so it networks and renders exactly like a player. Its
 * persona drives the social brain (Phase 2); its behavior drives its body.
 */
export interface NpcSpec {
  id: string;
  /** Spawn position in world units. */
  x: number;
  y: number;
  /** Initial facing in radians (0 = +x). Defaults to 0. */
  facing?: number;
  /** Display name. When omitted the brain's generated persona name is shown. */
  name?: string;
  persona?: NpcPersonaSpec;
  behavior?: NpcBehaviorSpec;
  /**
   * The NPC's needs are FROZEN — they don't drift on the town clock, so its
   * asks and behaviour stay determinate. THE flag that marks a puzzle-bound
   * resident (a quest-giver) apart from a regular townsperson whose needs
   * evolve — both are the SAME kind of NPC (see docs/TOWN_AND_NPCS.md), not
   * separate object types. The sim ignores it; a game layer (the symbol-game
   * quest host) reads it to decide a dwell-to-talk opens the puzzle flow vs. a
   * needs-based default line.
   */
  needsFrozen?: boolean;
}

export interface MultiplayerSpec {
  /** Hard cap; the lobby/WebRTC mesh inherits this (mesh is O(n²)). */
  maxPlayers: number;
  /**
   * "distributed": each client owns its own avatar; a toy is owned by its
   * possessor (or its last possessor while it rolls free). The server owns
   * only the possession token. No server physics tick.
   */
  authority: MultiplayerAuthority;
}

export interface ContentSpec {
  kind: ContentKind;
}

export interface WorldSpec {
  engine: "world";
  engineVersion: 1;
  meta: WorldMeta;
  manifold: ManifoldSpec;
  terrain: TerrainSpec;
  spawns: SpawnSpec[];
  objects: ObjectSpec[];
  /** Static collision geometry (walls + doors + stairs). Optional; the engine
   *  derives a MoveConstraint from it and composes it with any external one. */
  structures?: StructureSpec[];
  /** Multi-storey enclosures. `expandWorldBuildings` lowers each into perimeter
   *  structures; the renderer draws slabs/roof + the overhead floor-fade. */
  buildings?: BuildingSpec[];
  /** AI-driven inhabitants. Optional (most worlds have none). Hosted by exactly
   *  one peer at runtime — see shared/world-engine/world-host.ts. */
  npcs?: NpcSpec[];
  multiplayer: MultiplayerSpec;
  content: ContentSpec;
}

// ---------------------------------------------------------------------------
// Limits (enforced by the schema; generators should cite them)
// ---------------------------------------------------------------------------

export const WORLD_MAX_SPAWNS = 16;
export const WORLD_MAX_OBJECTS = 32;
/** Walls + doors + stairs. A building expands into several of these, so the cap
 *  is generous. */
export const WORLD_MAX_STRUCTURES = 128;
export const WORLD_MAX_BUILDINGS = 16;
/** Max storeys in one building. */
export const WORLD_MAX_FLOORS = 8;
/** Each NPC is hosted + voiced (a live social session) on one peer; keep the
 *  count low so a single host can drive them all. */
export const WORLD_MAX_NPCS = 8;
export const WORLD_MAX_PLAYERS = 12;
/** Max world-units per manifold axis. World units read as METERS (avatar
 *  radius 0.4, walk speed 5/s), so this admits an Earth-circumference
 *  landmass (~40,000 km) — streamed worlds (grand-dream) put whole
 *  regions in one coordinate space, and their stated trajectory is
 *  planet-sized maps (a 144×64-km tectonic continent already tripped
 *  the old 100 km bound). Purely a schema sanity bound: nothing in the
 *  engine's math depends on it, and f64 keeps sub-micrometer precision
 *  at this range. */
export const WORLD_MANIFOLD_MAX = 40_000_000;

/**
 * `custom_apps.type` discriminator for world-engine apps — the third engine in
 * the family (alongside the grid "game" and the goal-tree "goal_tree_game").
 * A world app's `definition` is a WorldSpec; world apps are inherently
 * multiplayer (they carry a MultiplayerSpec), so this type also signals "can be
 * attached to a call as a social game".
 */
export const WORLD_APP_TYPE = "social_world";
