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

// ---------------------------------------------------------------------------
// Spec enums (reserved members are documented but not yet schema-valid)
// ---------------------------------------------------------------------------

export type ManifoldKind = "flat"; // "sphere" reserved for a later milestone
export type TerrainKind = "flat";
export type ToyKind = "soccer_ball";
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
 * Soccer-ball toy. Possession-dribble behavior: whoever touches it controls it
 * while moving; a hard stop or a sharp brake releases it carrying the player's
 * velocity, so the "kick" is emergent rather than a separate verb. All params
 * are clamped by the schema.
 */
export interface SoccerBallSpec {
  id: string;
  kind: "soccer_ball";
  x: number;
  y: number;
  /** Collision/visual radius, world units. */
  radius: number;
  /** Distance ahead of the possessor the ball is carried. */
  dribbleDistance: number;
  /** Fraction of velocity RETAINED per second while rolling free (0..1). */
  friction: number;
  /** A possessor slower than this (units/sec) drops the ball. */
  releaseSpeed: number;
  /** An avatar within this distance of a FREE ball may take possession. */
  touchRadius: number;
}
export type ToySpec = SoccerBallSpec;

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
 * steering aim comes from an NpcController (shared/social-world/npc-controller.ts)
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
  toys: ToySpec[];
  /** AI-driven inhabitants. Optional (most worlds have none). Hosted by exactly
   *  one peer at runtime — see shared/social-world/world-host.ts. */
  npcs?: NpcSpec[];
  multiplayer: MultiplayerSpec;
  content: ContentSpec;
}

// ---------------------------------------------------------------------------
// Limits (enforced by the schema; generators should cite them)
// ---------------------------------------------------------------------------

export const WORLD_MAX_SPAWNS = 16;
export const WORLD_MAX_TOYS = 32;
/** Each NPC is hosted + voiced (a live social session) on one peer; keep the
 *  count low so a single host can drive them all. */
export const WORLD_MAX_NPCS = 8;
export const WORLD_MAX_PLAYERS = 12;
/** Max world-units per manifold axis. */
export const WORLD_MANIFOLD_MAX = 10_000;

/**
 * `custom_apps.type` discriminator for world-engine apps — the third engine in
 * the family (alongside the grid "game" and the goal-tree "goal_tree_game").
 * A world app's `definition` is a WorldSpec; world apps are inherently
 * multiplayer (they carry a MultiplayerSpec), so this type also signals "can be
 * attached to a call as a social game".
 */
export const WORLD_APP_TYPE = "social_world";
