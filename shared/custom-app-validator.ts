/**
 * Zod validator for custom app (game) definitions.
 *
 * Mirrors shared/custom-app-types.ts and enforces structural rules from
 * planning-docs/game-generator-plan.md (unique char, tiles dims match size,
 * whitelist for override_props, start_room references an existing room, etc.).
 */

import { z } from "zod";
import type {
  CustomAppDefinition,
  GameDefinition,
} from "./custom-app-types";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(64).regex(
  /^[a-zA-Z_][a-zA-Z0-9_]*$/,
  "ids must be alphanumeric/underscore and start with a letter or underscore",
);

const gridCoordSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

const gridSizeSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
]);

const layerSchema = z.enum(["background", "entity", "overlay"]);

const relativePositionSchema = z.enum([
  "same_cell",
  "adjacent",
  "inside",
  "contains",
]);

const counterOpSchema = z.enum(["gt", "lt", "eq", "gte", "lte"]);

export const OVERRIDABLE_PROPS = [
  "image",
  "image_color",
  "tile_color",
  "label",
  "hidden",
  "is_solid",
  "movable",
  "char",
] as const;

const overridablePropSchema = z.enum(OVERRIDABLE_PROPS);

const counterConditionSchema = z.object({
  id: idSchema,
  op: counterOpSchema,
  value: z.number(),
});

const matchSpecSchema = z
  .object({
    position: relativePositionSchema.optional(),
    class_id: idSchema.optional(),
    states: z.array(idSchema).optional(),
    types: z.array(z.string().min(1)).optional(),
    required_types: z.array(z.string().min(1)).optional(),
    forbidden_types: z.array(z.string().min(1)).optional(),
    counter: counterConditionSchema.optional(),
  })
  .strict();

// `self` cannot have position or class_id (always refers to this entity)
const selfMatchSpecSchema = matchSpecSchema.refine(
  (v) => v.position === undefined && v.class_id === undefined,
  "`self` match_spec must not specify `position` or `class_id`",
);

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const effectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("change_state"), id: idSchema }).strict(),
  z.object({ type: z.literal("change_state_other"), id: idSchema }).strict(),
  z.object({ type: z.literal("emit_signal"), id: idSchema }).strict(),
  z.object({
    type: z.literal("increment_counter_self"),
    id: idSchema,
    amount: z.number().int(),
  }).strict(),
  z.object({
    type: z.literal("increment_counter_other"),
    id: idSchema,
    amount: z.number().int(),
  }).strict(),
  z.object({ type: z.literal("destroy_self") }).strict(),
  z.object({ type: z.literal("destroy_other") }).strict(),
  z.object({ type: z.literal("transform_self"), id: idSchema }).strict(),
  z.object({ type: z.literal("transform_other"), id: idSchema }).strict(),
  z.object({
    type: z.literal("set_room"),
    // Either a room id or the sentinel "_next"
    id: z.union([idSchema, z.literal("_next")]),
  }).strict(),
  z.object({ type: z.literal("end_turn") }).strict(),
  z.object({ type: z.literal("end_player_turn") }).strict(),
  z.object({ type: z.literal("end_ai_turn") }).strict(),
  z.object({
    type: z.literal("send_ai_instruction"),
    message: z.string().min(1),
  }).strict(),
]);

const overridesRecordSchema = z.record(overridablePropSchema, z.unknown());

const buttonEffectSchema = z.union([
  effectSchema,
  z.object({
    type: z.literal("create_entity"),
    class_id: idSchema,
    position: gridCoordSchema,
    overrides: overridesRecordSchema.optional(),
  }).strict(),
]);

// ---------------------------------------------------------------------------
// Triggers / interactions
// ---------------------------------------------------------------------------

const triggerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("on_moved") }).strict(),
  z.object({ type: z.literal("on_click") }).strict(),
  z.object({
    type: z.literal("on_ai_trigger"),
    instructions: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("on_signal_received"),
    id: idSchema,
  }).strict(),
]);

const interactionSchema = z.object({
  triggers: z.object({
    events: z.array(triggerEventSchema).min(1),
    self: selfMatchSpecSchema.optional(),
    other: matchSpecSchema.optional(),
  }).strict(),
  effects: z.array(effectSchema).min(1),
  ai_instructions: z.string().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Counters, states, drop rules
// ---------------------------------------------------------------------------

const counterDefSchema = z.object({
  id: idSchema,
  label: z.string().optional(),
  initial: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict().refine(
  (c) => c.min === undefined || c.max === undefined || c.min <= c.max,
  "counter min must be <= max",
).refine(
  (c) =>
    (c.min === undefined || c.initial >= c.min) &&
    (c.max === undefined || c.initial <= c.max),
  "counter initial must be within [min, max]",
);

const stateDefSchema = z.object({
  id: idSchema,
  override_props: z.array(z.object({
    prop: overridablePropSchema,
    value: z.unknown(),
  }).strict()).optional(),
}).strict();

const dropRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adjacent_to"), class_ids: z.array(idSchema).min(1) }).strict(),
  z.object({ type: z.literal("same_cell"), class_ids: z.array(idSchema).min(1) }).strict(),
  z.object({ type: z.literal("inside"), class_ids: z.array(idSchema).min(1) }).strict(),
]);

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

const classDefSchema = z.object({
  id: idSchema,
  types: z.array(z.string().min(1)).optional(),
  image: z.string().optional(),
  image_color: z.string().optional(),
  tile_color: z.string().optional(),
  label: z.string().optional(),
  ai_instructions: z.string().optional(),
  ai_hidden: z.boolean().optional(),
  size: gridSizeSchema.optional(),
  layer: layerSchema.optional(),
  hidden: z.boolean().optional(),
  is_tile: z.boolean().optional(),
  char: z.string().length(1).optional(),
  is_solid: z.boolean().optional(),
  movable: z.boolean().optional(),
  drop_rules: z.array(dropRuleSchema).optional(),
  counters: z.array(counterDefSchema).optional(),
  can_be_contained: z.boolean().optional(),
  contain_size: z.number().int().positive().optional(),
  max_capacity: z.number().int().positive().optional(),
  states: z.array(stateDefSchema).optional(),
  interactions: z.array(interactionSchema).optional(),
  ai_movable: z.boolean().optional(),
  ai_creatable: z.boolean().optional(),
  ai_creatable_properties: z.array(overridablePropSchema).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const buttonDefSchema = z.object({
  id: idSchema,
  label: z.string().optional(),
  image: z.string().optional(),
  image_color: z.string().optional(),
  button_color: z.string().optional(),
  effects: z.array(buttonEffectSchema).min(1),
  enabled_by_default: z.boolean().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const roomEntityInstanceSchema = z.object({
  class_id: idSchema,
  position: gridCoordSchema,
  state: idSchema.optional(),
  overrides: overridesRecordSchema.optional(),
  counters: z.record(idSchema, z.number()).optional(),
}).strict();

const roomDefSchema = z.object({
  id: idSchema,
  label: z.string().optional(),
  ai_instructions: z.string().optional(),
  size: gridSizeSchema,
  default_tile: z.string().length(1).optional(),
  tiles: z.string().optional(),
  entities: z.array(roomEntityInstanceSchema).optional(),
  buttons: z.array(idSchema).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Top-level game definition
// ---------------------------------------------------------------------------

const gameDefinitionSchemaBase = z.object({
  type: z.literal("game"),
  label: z.string().min(1),
  image: z.string().optional(),
  description: z.string().optional(),
  ai_instructions: z.string().optional(),
  turn_based: z.boolean().optional(),
  classes: z.array(classDefSchema),
  buttons: z.array(buttonDefSchema),
  rooms: z.array(roomDefSchema).min(1),
  start_room: idSchema,
}).strict();

/** Checks structural/cross-reference rules that Zod field-level validation can't express. */
function validateCrossRefs(
  def: z.infer<typeof gameDefinitionSchemaBase>,
  ctx: z.RefinementCtx,
): void {
  // -- unique ids per collection
  const dupIn = (arr: Array<{ id?: string }>, label: string) => {
    const seen = new Set<string>();
    for (const item of arr) {
      if (item.id === undefined) continue;
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${label} id: ${item.id}`,
        });
      }
      seen.add(item.id);
    }
  };
  dupIn(def.classes, "class");
  dupIn(def.buttons, "button");
  dupIn(def.rooms, "room");

  const classIds = new Set(def.classes.map((c) => c.id));
  const buttonIds = new Set(def.buttons.map((b) => b.id));
  const roomIds = new Set(def.rooms.map((r) => r.id));

  // -- start_room must reference a real room
  if (!roomIds.has(def.start_room)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["start_room"],
      message: `start_room "${def.start_room}" does not match any room id`,
    });
  }

  // -- char must be unique across classes (when defined)
  const charToClass = new Map<string, string>();
  for (const c of def.classes) {
    if (c.char === undefined) continue;
    const existing = charToClass.get(c.char);
    if (existing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `char "${c.char}" is used by both "${existing}" and "${c.id}" — chars must be unique across classes`,
      });
    } else {
      charToClass.set(c.char, c.id);
    }
  }

  // -- class-internal checks
  for (const c of def.classes) {
    const stateIds = new Set((c.states ?? []).map((s) => s.id));
    const counterIds = new Set((c.counters ?? []).map((ct) => ct.id));

    // state _default is implicit; forbid explicitly redefining it
    if (stateIds.has("_default")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classes"],
        message: `class "${c.id}" defines reserved state id "_default"`,
      });
    }

    // drop_rules reference real classes
    for (const rule of c.drop_rules ?? []) {
      for (const ref of rule.class_ids) {
        if (!classIds.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["classes"],
            message: `class "${c.id}" drop_rule references unknown class "${ref}"`,
          });
        }
      }
    }

    // interactions: self/other references, counter/state references
    for (const inter of c.interactions ?? []) {
      const { self, other } = inter.triggers;
      if (self?.counter && !counterIds.has(self.counter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `class "${c.id}" interaction references unknown self counter "${self.counter.id}"`,
        });
      }
      if (self?.states) {
        for (const s of self.states) {
          if (s !== "_default" && !stateIds.has(s)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `class "${c.id}" interaction references unknown self state "${s}"`,
            });
          }
        }
      }
      if (other?.class_id && !classIds.has(other.class_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `class "${c.id}" interaction's other.class_id "${other.class_id}" is unknown`,
        });
      }

      for (const e of inter.effects) {
        if ((e.type === "change_state" || e.type === "transform_self") && e.type === "change_state" && !stateIds.has(e.id) && e.id !== "_default") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" change_state references unknown state "${e.id}"`,
          });
        }
        if (e.type === "transform_self" && !classIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" transform_self references unknown class "${e.id}"`,
          });
        }
        if (e.type === "transform_other" && !classIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" transform_other references unknown class "${e.id}"`,
          });
        }
        if (e.type === "increment_counter_self" && !counterIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" increment_counter_self references unknown counter "${e.id}"`,
          });
        }
        if (e.type === "set_room" && e.id !== "_next" && !roomIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" set_room references unknown room "${e.id}"`,
          });
        }
      }
    }
  }

  // -- rooms
  for (const r of def.rooms) {
    const [w, h] = r.size;

    // tiles dimensions must match size
    if (r.tiles !== undefined) {
      const lines = r.tiles.split("\n");
      if (lines.length !== h) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `room "${r.id}" tiles has ${lines.length} rows but size height is ${h}`,
        });
      }
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length !== w) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `room "${r.id}" tiles row ${i} has length ${lines[i].length} but size width is ${w}`,
          });
          break;
        }
      }
    }

    // entity instances reference valid classes; position inside size
    for (const e of r.entities ?? []) {
      if (!classIds.has(e.class_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `room "${r.id}" entity references unknown class "${e.class_id}"`,
        });
        continue;
      }
      const [x, y] = e.position;
      if (x >= w || y >= h) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `room "${r.id}" entity at (${x},${y}) is outside room size ${w}x${h}`,
        });
      }
    }

    // button refs must exist
    for (const bid of r.buttons ?? []) {
      if (!buttonIds.has(bid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `room "${r.id}" enables unknown button "${bid}"`,
        });
      }
    }
  }

  // -- buttons: create_entity references real classes; set_room refs real rooms
  for (const b of def.buttons) {
    for (const e of b.effects) {
      if (e.type === "create_entity" && !classIds.has(e.class_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `button "${b.id}" create_entity references unknown class "${e.class_id}"`,
        });
      }
      if (e.type === "set_room" && e.id !== "_next" && !roomIds.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `button "${b.id}" set_room references unknown room "${e.id}"`,
        });
      }
    }
  }
}

export const gameDefinitionSchema = gameDefinitionSchemaBase.superRefine(
  validateCrossRefs,
) as unknown as z.ZodType<GameDefinition>;

export const customAppDefinitionSchema = gameDefinitionSchema as z.ZodType<CustomAppDefinition>;

/** Convenience wrapper returning { ok: true, data } | { ok: false, errors }. */
export function validateCustomAppDefinition(
  input: unknown,
):
  | { ok: true; data: CustomAppDefinition }
  | { ok: false; errors: string[] } {
  const res = customAppDefinitionSchema.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => {
      const path = i.path.length ? i.path.join(".") + ": " : "";
      return path + i.message;
    }),
  };
}
