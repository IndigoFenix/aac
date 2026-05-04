/**
 * Zod validator for custom app (game) definitions.
 *
 * Mirrors shared/custom-app-types.ts and enforces structural rules from
 * planning-docs/game-generator-plan.md (unique char, tiles dims match size,
 * whitelist for overrideProps, startRoom references an existing room, etc.).
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
  "sameCell",
  "adjacent",
  "inside",
  "contains",
]);

const counterOpSchema = z.enum(["gt", "lt", "eq", "gte", "lte"]);

export const OVERRIDABLE_PROPS = [
  "iconRef",
  "imageKey",
  "symbolPath",
  "imageColor",
  "tileColor",
  "label",
  "hidden",
  "isSolid",
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
    classId: idSchema.optional(),
    states: z.array(idSchema).optional(),
    types: z.array(z.string().min(1)).optional(),
    requiredTypes: z.array(z.string().min(1)).optional(),
    forbiddenTypes: z.array(z.string().min(1)).optional(),
    counter: counterConditionSchema.optional(),
  })
  .strict();

// `self` cannot have position or classId (always refers to this entity)
const selfMatchSpecSchema = matchSpecSchema.refine(
  (v) => v.position === undefined && v.classId === undefined,
  "`self` match_spec must not specify `position` or `classId`",
);

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const effectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changeState"), id: idSchema }).strict(),
  z.object({ type: z.literal("changeStateOther"), id: idSchema }).strict(),
  z.object({ type: z.literal("emitSignal"), id: idSchema }).strict(),
  z.object({
    type: z.literal("incrementCounterSelf"),
    id: idSchema,
    amount: z.number().int(),
  }).strict(),
  z.object({
    type: z.literal("incrementCounterOther"),
    id: idSchema,
    amount: z.number().int(),
  }).strict(),
  z.object({ type: z.literal("destroySelf") }).strict(),
  z.object({ type: z.literal("destroyOther") }).strict(),
  z.object({ type: z.literal("transformSelf"), id: idSchema }).strict(),
  z.object({ type: z.literal("transformOther"), id: idSchema }).strict(),
  z.object({
    type: z.literal("setRoom"),
    // Either a room id or the sentinel "_next"
    id: z.union([idSchema, z.literal("_next")]),
  }).strict(),
  z.object({ type: z.literal("endTurn") }).strict(),
  z.object({ type: z.literal("endPlayerTurn") }).strict(),
  z.object({ type: z.literal("endAiTurn") }).strict(),
  z.object({
    type: z.literal("sendAiInstruction"),
    message: z.string().min(1),
  }).strict(),
]);

const overridesRecordSchema = z.record(overridablePropSchema, z.unknown());

const buttonEffectSchema = z.union([
  effectSchema,
  z.object({
    type: z.literal("createEntity"),
    classId: idSchema,
    position: gridCoordSchema,
    overrides: overridesRecordSchema.optional(),
  }).strict(),
]);

// ---------------------------------------------------------------------------
// Triggers / interactions
// ---------------------------------------------------------------------------

const triggerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("onMoved") }).strict(),
  z.object({ type: z.literal("onClick") }).strict(),
  z.object({
    type: z.literal("onAiTrigger"),
    instructions: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("onSignalReceived"),
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
  aiInstructions: z.string().optional(),
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
  overrideProps: z.array(z.object({
    prop: overridablePropSchema,
    value: z.unknown(),
  }).strict()).optional(),
}).strict();

const dropRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adjacentTo"), classIds: z.array(idSchema).min(1) }).strict(),
  z.object({ type: z.literal("sameCell"), classIds: z.array(idSchema).min(1) }).strict(),
  z.object({ type: z.literal("inside"), classIds: z.array(idSchema).min(1) }).strict(),
]);

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

const classDefSchema = z.object({
  id: idSchema,
  types: z.array(z.string().min(1)).optional(),
  iconRef: z.string().optional(),
  imageKey: z.string().optional(),
  symbolPath: z.string().optional(),
  imageColor: z.string().optional(),
  tileColor: z.string().optional(),
  label: z.string().optional(),
  aiInstructions: z.string().optional(),
  aiHidden: z.boolean().optional(),
  size: gridSizeSchema.optional(),
  layer: layerSchema.optional(),
  hidden: z.boolean().optional(),
  isTile: z.boolean().optional(),
  char: z.string().length(1).optional(),
  isSolid: z.boolean().optional(),
  movable: z.boolean().optional(),
  dropRules: z.array(dropRuleSchema).optional(),
  counters: z.array(counterDefSchema).optional(),
  canBeContained: z.boolean().optional(),
  containSize: z.number().int().positive().optional(),
  maxCapacity: z.number().int().positive().optional(),
  states: z.array(stateDefSchema).optional(),
  interactions: z.array(interactionSchema).optional(),
  aiMovable: z.boolean().optional(),
  aiCreatable: z.boolean().optional(),
  aiCreatableProperties: z.array(overridablePropSchema).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const buttonDefSchema = z.object({
  id: idSchema,
  label: z.string().optional(),
  iconRef: z.string().optional(),
  imageKey: z.string().optional(),
  symbolPath: z.string().optional(),
  imageColor: z.string().optional(),
  buttonColor: z.string().optional(),
  effects: z.array(buttonEffectSchema).min(1),
  enabledByDefault: z.boolean().optional(),
  section: z.enum(["before", "after"]).optional(),
  row: z.number().int().nonnegative().optional(),
  col: z.number().int().nonnegative().optional(),
  rowSpan: z.number().int().positive().optional(),
  colSpan: z.number().int().positive().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const roomEntityInstanceSchema = z.object({
  classId: idSchema,
  position: gridCoordSchema,
  state: idSchema.optional(),
  overrides: overridesRecordSchema.optional(),
  counters: z.record(idSchema, z.number()).optional(),
}).strict();

const roomDefSchema = z.object({
  id: idSchema,
  label: z.string().optional(),
  aiInstructions: z.string().optional(),
  size: gridSizeSchema.optional(),
  defaultTile: z.string().length(1).optional(),
  tiles: z.string().optional(),
  entities: z.array(roomEntityInstanceSchema).optional(),
  buttons: z.array(idSchema).optional(),
  showBefore: z.boolean().optional(),
  showGrid: z.boolean().optional(),
  showAfter: z.boolean().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Top-level game definition
// ---------------------------------------------------------------------------

const gameDefinitionSchemaBase = z.object({
  type: z.literal("game"),
  label: z.string().min(1),
  iconRef: z.string().optional(),
  imageKey: z.string().optional(),
  symbolPath: z.string().optional(),
  description: z.string().optional(),
  aiInstructions: z.string().optional(),
  turnBased: z.boolean().optional(),
  classes: z.array(classDefSchema),
  buttons: z.array(buttonDefSchema),
  rooms: z.array(roomDefSchema).min(1),
  startRoom: idSchema,
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

  // -- startRoom must reference a real room
  if (!roomIds.has(def.startRoom)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startRoom"],
      message: `startRoom "${def.startRoom}" does not match any room id`,
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

    if (stateIds.has("_default")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classes"],
        message: `class "${c.id}" defines reserved state id "_default"`,
      });
    }

    for (const rule of c.dropRules ?? []) {
      for (const ref of rule.classIds) {
        if (!classIds.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["classes"],
            message: `class "${c.id}" dropRule references unknown class "${ref}"`,
          });
        }
      }
    }

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
      if (other?.classId && !classIds.has(other.classId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `class "${c.id}" interaction's other.classId "${other.classId}" is unknown`,
        });
      }

      for (const e of inter.effects) {
        if (e.type === "changeState" && !stateIds.has(e.id) && e.id !== "_default") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" changeState references unknown state "${e.id}"`,
          });
        }
        if (e.type === "transformSelf" && !classIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" transformSelf references unknown class "${e.id}"`,
          });
        }
        if (e.type === "transformOther" && !classIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" transformOther references unknown class "${e.id}"`,
          });
        }
        if (e.type === "incrementCounterSelf" && !counterIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" incrementCounterSelf references unknown counter "${e.id}"`,
          });
        }
        if (e.type === "setRoom" && e.id !== "_next" && !roomIds.has(e.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `class "${c.id}" setRoom references unknown room "${e.id}"`,
          });
        }
      }
    }
  }

  // -- rooms
  for (const r of def.rooms) {
    const gridShown = r.showGrid !== false;

    if (gridShown && !r.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `room "${r.id}" must define \`size\` when \`showGrid\` is not false`,
      });
    }
    if ((r.tiles !== undefined || (r.entities && r.entities.length > 0)) && !r.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `room "${r.id}" defines tiles/entities but has no \`size\``,
      });
    }

    if (r.size) {
      const [w, h] = r.size;

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

      for (const e of r.entities ?? []) {
        if (!classIds.has(e.classId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `room "${r.id}" entity references unknown class "${e.classId}"`,
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
    }

    for (const bid of r.buttons ?? []) {
      if (!buttonIds.has(bid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `room "${r.id}" enables unknown button "${bid}"`,
        });
      }
    }
  }

  // -- buttons: createEntity references real classes; setRoom refs real rooms
  for (const b of def.buttons) {
    for (const e of b.effects) {
      if (e.type === "createEntity" && !classIds.has(e.classId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `button "${b.id}" createEntity references unknown class "${e.classId}"`,
        });
      }
      if (e.type === "setRoom" && e.id !== "_next" && !roomIds.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `button "${b.id}" setRoom references unknown room "${e.id}"`,
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
