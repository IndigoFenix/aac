// shared/world-engine/schema.ts
//
// Zod schema + structural validation for WorldSpecs. Field shape is enforced
// by Zod (.strict() — no unknown keys); cross-field rules the schema can't
// express (unique ids, positions inside the manifold, at least one spawn) live
// in validateWorldStructure via superRefine.
//
// This is the only certification stage v1 needs: a sandbox world has no
// solvability obligation (unlike a goal-tree game). The gauntlet is exposed as
// certifyWorldSpec() in index.ts and stays the single gate any stored/AI-
// generated spec must pass before it reaches the engine.

import { z } from "zod";
import type { WorldSpec } from "./types.js";
import {
  WORLD_MANIFOLD_MAX,
  WORLD_MAX_BUILDINGS,
  WORLD_MAX_FLOORS,
  WORLD_MAX_NPCS,
  WORLD_MAX_OBJECTS,
  WORLD_MAX_PLAYERS,
  WORLD_MAX_SPAWNS,
  WORLD_MAX_STRUCTURES,
} from "./types.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z_][a-zA-Z0-9_]*$/,
    "ids must be alphanumeric/underscore and start with a letter or underscore",
  );

const finite = z.number().finite();
const positive = z.number().finite().positive();
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #rrggbb hex string");

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const manifoldSchema = z
  .object({
    kind: z.literal("flat"),
    width: positive.max(WORLD_MANIFOLD_MAX),
    height: positive.max(WORLD_MANIFOLD_MAX),
    // false = content extent only, physics unclamped (planet-mounted worlds).
    bounded: z.boolean().optional(),
  })
  .strict();

const terrainSchema = z
  .object({
    kind: z.literal("flat"),
    groundColor: hexColor.optional(),
  })
  .strict();

const spawnSchema = z
  .object({
    id: idSchema,
    x: finite,
    y: finite,
    facing: finite.optional(),
  })
  .strict();

// Possession-dribble tuning (a "push" object). Retained-per-second `friction`
// excludes the endpoints so it neither freezes instantly (0) nor rolls forever (1).
const pushSchema = z
  .object({
    dribbleDistance: positive.max(50),
    friction: z.number().gt(0).lt(1),
    releaseSpeed: z.number().finite().nonnegative().max(100),
    touchRadius: positive.max(50),
  })
  .strict();

const containmentSlotSchema = z
  .object({
    relation: z.enum(["on", "in", "under"]),
    capacity: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const objectSchema = z
  .object({
    id: idSchema,
    x: finite,
    y: finite,
    shape: z.enum(["sphere", "box"]),
    radius: positive.max(50),
    iconRef: z.string().min(1).optional(),
    // May be empty for a pure container (e.g. a table you neither push nor carry).
    interactions: z.array(z.enum(["push", "carry"])).max(2),
    push: pushSchema.optional(),
    contains: z.array(containmentSlotSchema).min(1).max(8).optional(),
    // FURNITURE (fixtures): static containers along a room's walls — solid
    // (bar the pass-through kinds, types.ts PASSTHROUGH_FIXTURES).
    fixture: z
      .enum(["chest", "cupboard", "table", "bed", "chair", "box", "barrel", "bath", "privy", "bin", "bowl", "oven", "workbench", "refrigerator"])
      .optional(),
    openable: z.boolean().optional(),
    facing: finite.optional(),
  })
  .strict();

// Structures — walls, doors, stairs. A point (Vec2) is just two finite numbers.
const pointSchema = z.object({ x: finite, y: finite }).strict();
const floorSchema = z.number().int().min(0).max(64);
const rectSchema = z
  .object({ x: finite, y: finite, w: positive.max(WORLD_MANIFOLD_MAX), h: positive.max(WORLD_MANIFOLD_MAX) })
  .strict();

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const wallSchema = z
  .object({
    kind: z.literal("wall"),
    id: idSchema,
    a: pointSchema,
    b: pointSchema,
    thickness: positive.max(50),
    floor: floorSchema.optional(),
    color: colorSchema.optional(),
  })
  .strict();

const doorSchema = z
  .object({
    kind: z.literal("door"),
    id: idSchema,
    a: pointSchema,
    b: pointSchema,
    thickness: positive.max(50),
    hinge: z.enum(["a", "b"]).optional(),
    openRadius: positive.max(WORLD_MANIFOLD_MAX).optional(),
    locked: z.boolean().optional(),
    keyObjectId: idSchema.optional(),
    floor: floorSchema.optional(),
    color: colorSchema.optional(),
  })
  .strict();

const stairsSchema = z
  .object({
    kind: z.literal("stairs"),
    id: idSchema,
    rect: rectSchema,
    fromFloor: floorSchema,
    toFloor: floorSchema,
    axis: z.enum(["+x", "-x", "+y", "-y"]),
  })
  .strict();

const structureSchema = z.discriminatedUnion("kind", [wallSchema, doorSchema, stairsSchema]);

const buildingDoorwaySchema = z
  .object({
    edge: z.enum(["north", "south", "east", "west"]),
    offset: z.number().finite().nonnegative().max(WORLD_MANIFOLD_MAX),
    width: positive.max(WORLD_MANIFOLD_MAX),
    locked: z.boolean().optional(),
  })
  .strict();

const buildingSchema = z
  .object({
    id: idSchema,
    footprint: rectSchema,
    floors: z.number().int().min(1).max(WORLD_MAX_FLOORS),
    wallThickness: positive.max(50),
    doorways: z.array(buildingDoorwaySchema).max(8).optional(),
    stairs: z.boolean().optional(),
    color: colorSchema.optional(),
  })
  .strict();

// NPC persona mirrors the social_trainer app params. `archetypeHint`/`scenario`/
// `targetSkills` are free strings here on purpose: the social brain owns their
// vocabulary, so adding an archetype or skill there never needs a world-spec bump
// (an unknown value just falls back to a sampled/default in the generator).
const npcPersonaSchema = z
  .object({
    genderHint: z.enum(["male", "female", "any"]).optional(),
    archetypeHint: z.string().min(1).max(64).optional(),
    interestHints: z.array(z.string().min(1).max(64)).max(8).optional(),
    difficulty: z.enum(["gentle", "medium", "challenging"]).optional(),
    scenario: z.string().min(1).max(64).optional(),
    targetSkills: z.array(z.string().min(1).max(64)).max(8).optional(),
  })
  .strict();

const npcBehaviorSchema = z
  .object({
    movement: z.enum(["stationary", "wander", "approach_nearest"]),
    conversationRadius: positive.max(WORLD_MANIFOLD_MAX).optional(),
    wanderRadius: positive.max(WORLD_MANIFOLD_MAX).optional(),
    home: pointSchema.optional(),
    speed: positive.max(50).optional(),
  })
  .strict();

const npcSchema = z
  .object({
    id: idSchema,
    x: finite,
    y: finite,
    facing: finite.optional(),
    name: z.string().min(1).max(120).optional(),
    persona: npcPersonaSchema.optional(),
    behavior: npcBehaviorSchema.optional(),
    // Needs don't drift on the town clock ⇒ a determinate, puzzle-bound
    // resident (a quest-giver) vs. a regular townsperson. The sim ignores it;
    // game layers read it (see docs/TOWN_AND_NPCS.md).
    needsFrozen: z.boolean().optional(),
  })
  .strict();

const multiplayerSchema = z
  .object({
    maxPlayers: z.number().int().min(1).max(WORLD_MAX_PLAYERS),
    authority: z.literal("distributed"),
  })
  .strict();

const contentSchema = z
  .object({
    kind: z.literal("sandbox"),
  })
  .strict();

const metaSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(600).optional(),
    locale: z.string().min(2).max(20),
    theme: z.string().min(1).max(120),
  })
  .strict();

const worldSpecSchemaBase = z
  .object({
    engine: z.literal("world"),
    engineVersion: z.literal(1),
    meta: metaSchema,
    manifold: manifoldSchema,
    terrain: terrainSchema,
    spawns: z.array(spawnSchema).min(1).max(WORLD_MAX_SPAWNS),
    objects: z.array(objectSchema).max(WORLD_MAX_OBJECTS),
    structures: z.array(structureSchema).max(WORLD_MAX_STRUCTURES).optional(),
    buildings: z.array(buildingSchema).max(WORLD_MAX_BUILDINGS).optional(),
    npcs: z.array(npcSchema).max(WORLD_MAX_NPCS).optional(),
    multiplayer: multiplayerSchema,
    content: contentSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Structural validation (cross-field)
// ---------------------------------------------------------------------------

function validateWorldStructure(
  spec: z.infer<typeof worldSpecSchemaBase>,
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });

  const { width, height } = spec.manifold;
  const inBounds = (x: number, y: number) =>
    x >= 0 && x <= width && y >= 0 && y <= height;

  // Unique spawn ids + inside the manifold.
  const spawnIds = new Set<string>();
  for (const s of spec.spawns) {
    if (spawnIds.has(s.id)) issue(`duplicate spawn id: ${s.id}`);
    spawnIds.add(s.id);
    if (!inBounds(s.x, s.y)) {
      issue(`spawn "${s.id}" at (${s.x}, ${s.y}) is outside the manifold`);
    }
  }

  // Unique object ids + inside the manifold; a "push" object needs push tuning.
  const objectIds = new Set<string>();
  for (const o of spec.objects) {
    if (objectIds.has(o.id)) issue(`duplicate object id: ${o.id}`);
    objectIds.add(o.id);
    if (!inBounds(o.x, o.y)) {
      issue(`object "${o.id}" at (${o.x}, ${o.y}) is outside the manifold`);
    }
    if (o.fixture && o.interactions.length > 0) {
      issue(`fixture "${o.id}" cannot also be ${o.interactions.join("/")} — furniture is static`);
    }
    if (o.interactions.includes("push") && !o.push) {
      issue(`object "${o.id}" allows "push" but has no push tuning`);
    }
    if (o.interactions.length === 0 && !o.contains && !o.fixture) {
      issue(`object "${o.id}" has no interactions and is not a container`);
    }
  }

  // Structures: unique ids (distinct from objects too, since a door's keyObjectId
  // and the renderer key on these namespaces), endpoints in bounds, a non-degenerate
  // segment, and a door key that points at a real CARRYable object.
  const carryObjectIds = new Set(
    spec.objects.filter((o) => o.interactions.includes("carry")).map((o) => o.id),
  );
  const structureIds = new Set<string>();
  for (const s of spec.structures ?? []) {
    if (structureIds.has(s.id)) issue(`duplicate structure id: ${s.id}`);
    if (objectIds.has(s.id)) issue(`structure id "${s.id}" collides with an object id`);
    structureIds.add(s.id);
    if (s.kind === "stairs") {
      const { x, y, w, h } = s.rect;
      if (!inBounds(x, y) || !inBounds(x + w, y + h)) {
        issue(`stairs "${s.id}" footprint is outside the manifold`);
      }
      if (s.fromFloor === s.toFloor) {
        issue(`stairs "${s.id}" connects a floor to itself`);
      }
    } else {
      if (!inBounds(s.a.x, s.a.y) || !inBounds(s.b.x, s.b.y)) {
        issue(`structure "${s.id}" has an endpoint outside the manifold`);
      }
      if (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < 1e-3) {
        issue(`structure "${s.id}" is degenerate (a and b coincide)`);
      }
      if (s.kind === "door" && s.keyObjectId && !carryObjectIds.has(s.keyObjectId)) {
        issue(`door "${s.id}" keyObjectId "${s.keyObjectId}" is not a carryable object`);
      }
    }
  }

  // Buildings: unique ids; footprint in bounds; each doorway fits its edge (so a
  // generated door doesn't run off the wall). Generated structure ids are prefixed
  // by the building id, so a unique building id keeps them from colliding.
  const buildingIds = new Set<string>();
  for (const b of spec.buildings ?? []) {
    if (buildingIds.has(b.id)) issue(`duplicate building id: ${b.id}`);
    if (structureIds.has(b.id)) issue(`building id "${b.id}" collides with a structure id`);
    buildingIds.add(b.id);
    const { x, y, w, h } = b.footprint;
    if (!inBounds(x, y) || !inBounds(x + w, y + h)) {
      issue(`building "${b.id}" footprint is outside the manifold`);
    }
    for (const d of b.doorways ?? []) {
      const edgeLen = d.edge === "north" || d.edge === "south" ? w : h;
      if (d.offset - d.width / 2 < 0 || d.offset + d.width / 2 > edgeLen) {
        issue(`building "${b.id}" ${d.edge} doorway (offset ${d.offset}, width ${d.width}) doesn't fit its edge`);
      }
    }
  }

  // NPC ids must be unique AND distinct from spawn/object ids: at runtime an NPC
  // is an avatar, and its id rides the same wire namespace as objects and
  // (potentially) spawn-derived references, so a clash would make a message ambiguous.
  const npcIds = new Set<string>();
  for (const n of spec.npcs ?? []) {
    if (npcIds.has(n.id)) issue(`duplicate npc id: ${n.id}`);
    if (objectIds.has(n.id)) issue(`npc id "${n.id}" collides with an object id`);
    if (spawnIds.has(n.id)) issue(`npc id "${n.id}" collides with a spawn id`);
    npcIds.add(n.id);
    if (!inBounds(n.x, n.y)) {
      issue(`npc "${n.id}" at (${n.x}, ${n.y}) is outside the manifold`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const worldSpecSchema = worldSpecSchemaBase.superRefine(
  validateWorldStructure,
) as unknown as z.ZodType<WorldSpec>;

/** Convenience wrapper returning { ok: true, data } | { ok: false, errors }. */
export function validateWorldSpec(
  input: unknown,
): { ok: true; data: WorldSpec } | { ok: false; errors: string[] } {
  const res = worldSpecSchema.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => {
      const path = i.path.length ? i.path.join(".") + ": " : "";
      return path + i.message;
    }),
  };
}
