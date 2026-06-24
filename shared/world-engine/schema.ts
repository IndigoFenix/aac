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
  WORLD_MAX_PLAYERS,
  WORLD_MAX_SPAWNS,
  WORLD_MAX_TOYS,
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

const soccerBallSchema = z
  .object({
    id: idSchema,
    kind: z.literal("soccer_ball"),
    x: finite,
    y: finite,
    radius: positive.max(50),
    dribbleDistance: positive.max(50),
    // Retained-per-second fraction; exclude the endpoints so a ball neither
    // freezes instantly (0) nor rolls forever (1).
    friction: z.number().gt(0).lt(1),
    releaseSpeed: z.number().finite().nonnegative().max(100),
    touchRadius: positive.max(50),
  })
  .strict();

const toySchema = z.discriminatedUnion("kind", [soccerBallSchema]);

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
    toys: z.array(toySchema).max(WORLD_MAX_TOYS),
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

  // Unique toy ids (across all kinds) + inside the manifold.
  const toyIds = new Set<string>();
  for (const t of spec.toys) {
    if (toyIds.has(t.id)) issue(`duplicate toy id: ${t.id}`);
    toyIds.add(t.id);
    if (!inBounds(t.x, t.y)) {
      issue(`toy "${t.id}" at (${t.x}, ${t.y}) is outside the manifold`);
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
