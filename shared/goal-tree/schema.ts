// shared/goal-tree/schema.ts
//
// Zod schema + structural validation for goal-tree games.
// Field-level shape is enforced by Zod; cross-reference rules the schema
// can't express (unique ids, entity kinds, option correctness, placement
// sums, size caps) live in validateGameStructure via superRefine.
//
// This is stage 1 of the certification gauntlet (schema → logical world →
// solver); see index.ts `certifyGoalTreeGame`.

import { z } from "zod";
import type {
  ChooseNode,
  CollectNode,
  EntityDef,
  EntityKind,
  GoalNode,
  GoalTreeGame,
} from "./types.js";
import {
  CHOOSE_MAX_OPTIONS,
  COLLECT_MAX_COUNT,
  GOAL_TREE_MAX_DEPTH,
  GOAL_TREE_MAX_ENTITIES,
  GOAL_TREE_MAX_NODES,
} from "./types.js";
import { walkGoalTree } from "./walk.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(64).regex(
  /^[a-zA-Z_][a-zA-Z0-9_]*$/,
  "ids must be alphanumeric/underscore and start with a letter or underscore",
);

const flavorTextSchema = z.string().min(1).max(400);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const entityKindSchema = z.enum(["item", "character", "obstacle", "marker"]);

const entityDefSchema = z.object({
  id: idSchema,
  kind: entityKindSchema,
  label: z.string().min(1).max(80),
  spokenLabel: z.string().min(1).max(120).optional(),
  iconRef: z.string().min(1).optional(),
  imageKey: z.string().min(1).optional(),
  symbolPath: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  lines: z.array(flavorTextSchema).max(8).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Goal nodes (recursive)
// ---------------------------------------------------------------------------

/**
 * Declared first so node schemas below can reference it; z.lazy defers
 * evaluation until first parse, when all four node schemas exist.
 */
export const goalNodeSchema: z.ZodType<GoalNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    reachNodeSchema,
    collectNodeSchema,
    chooseNodeSchema,
    overcomeNodeSchema,
  ]),
) as unknown as z.ZodType<GoalNode>;

const goalNodeBaseFields = {
  id: idSchema,
  intro: flavorTextSchema.optional(),
  outro: flavorTextSchema.optional(),
};

const overcomeNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("overcome"),
  obstacleEntityId: idSchema,
  prompt: flavorTextSchema.optional(),
  key: goalNodeSchema,
}).strict();

const viaSchema = z.array(overcomeNodeSchema).min(1);

const reachNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("reach"),
  markerEntityId: idSchema,
  zoneHint: z.string().min(1).max(120).optional(),
  via: viaSchema.optional(),
}).strict();

const collectPlacementSchema = z.object({
  count: z.number().int().min(1).max(COLLECT_MAX_COUNT),
  via: viaSchema.optional(),
}).strict();

const collectNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("collect"),
  itemEntityIds: z.array(idSchema).min(1),
  count: z.number().int().min(1).max(COLLECT_MAX_COUNT),
  distractorEntityIds: z.array(idSchema).optional(),
  placements: z.array(collectPlacementSchema).min(1).optional(),
  zoneHint: z.string().min(1).max(120).optional(),
  via: viaSchema.optional(),
}).strict();

const chooseOptionSchema = z.object({
  entityId: idSchema,
  correct: z.boolean().optional(),
  feedback: flavorTextSchema.optional(),
}).strict();

const chooseNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("choose"),
  posedByEntityId: idSchema,
  prompt: flavorTextSchema,
  options: z.array(chooseOptionSchema).min(2).max(CHOOSE_MAX_OPTIONS),
}).strict();

// ---------------------------------------------------------------------------
// Top-level game
// ---------------------------------------------------------------------------

const aiCompanionSchema = z.object({
  name: z.string().min(1).max(60),
  persona: z.string().min(1).max(1000),
}).strict();

const metaSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(600).optional(),
  locale: z.string().min(2).max(20),
  theme: z.string().min(1).max(120),
  aiCompanion: aiCompanionSchema.optional(),
  learningGoals: z.array(z.string().min(1).max(200)).max(10).optional(),
}).strict();

const goalTreeGameSchemaBase = z.object({
  engine: z.literal("goal-tree"),
  engineVersion: z.literal(1),
  meta: metaSchema,
  entities: z.array(entityDefSchema).min(1).max(GOAL_TREE_MAX_ENTITIES),
  root: goalNodeSchema,
}).strict();

// ---------------------------------------------------------------------------
// Structural validation (cross-references)
// ---------------------------------------------------------------------------

/** Which entity kinds each reference site accepts. */
const KIND_RULES = {
  reachMarker: ["marker", "character"],
  collectItem: ["item"],
  collectDistractor: ["item"],
  choosePoser: ["character", "marker"],
  chooseOption: ["item", "character", "marker"],
  obstacle: ["obstacle"],
} as const satisfies Record<string, readonly EntityKind[]>;

function validateGameStructure(
  game: z.infer<typeof goalTreeGameSchemaBase>,
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });

  // -- entities: unique ids
  const entityById = new Map<string, EntityDef>();
  for (const e of game.entities) {
    if (entityById.has(e.id)) issue(`duplicate entity id: ${e.id}`);
    entityById.set(e.id, e);
  }

  const checkRef = (
    nodeId: string,
    field: string,
    entityId: string,
    rule: keyof typeof KIND_RULES,
  ) => {
    const entity = entityById.get(entityId);
    if (!entity) {
      issue(`node "${nodeId}" ${field} references unknown entity "${entityId}"`);
      return;
    }
    const allowed: readonly EntityKind[] = KIND_RULES[rule];
    if (!allowed.includes(entity.kind)) {
      issue(
        `node "${nodeId}" ${field} references entity "${entityId}" of kind ` +
          `"${entity.kind}" — expected ${allowed.join(" | ")}`,
      );
    }
  };

  // -- walk the tree once: unique node ids, caps, per-node rules
  const seenNodeIds = new Set<string>();
  let totalNodes = 0;
  let maxDepth = 0;

  for (const { node, depth } of walkGoalTree(game.root as GoalNode)) {
    totalNodes += 1;
    if (depth > maxDepth) maxDepth = depth;

    if (seenNodeIds.has(node.id)) issue(`duplicate goal node id: ${node.id}`);
    seenNodeIds.add(node.id);

    switch (node.type) {
      case "reach":
        checkRef(node.id, "markerEntityId", node.markerEntityId, "reachMarker");
        break;
      case "collect":
        validateCollectNode(node, issue, checkRef);
        break;
      case "choose":
        validateChooseNode(node, issue, checkRef);
        break;
      case "overcome":
        checkRef(node.id, "obstacleEntityId", node.obstacleEntityId, "obstacle");
        break;
    }
  }

  if (totalNodes > GOAL_TREE_MAX_NODES) {
    issue(`goal tree has ${totalNodes} nodes — max is ${GOAL_TREE_MAX_NODES}`);
  }
  if (maxDepth > GOAL_TREE_MAX_DEPTH) {
    issue(`goal tree depth is ${maxDepth} — max is ${GOAL_TREE_MAX_DEPTH}`);
  }
}

function validateCollectNode(
  node: CollectNode,
  issue: (message: string) => void,
  checkRef: (
    nodeId: string,
    field: string,
    entityId: string,
    rule: keyof typeof KIND_RULES,
  ) => void,
): void {
  const targets = new Set<string>();
  for (const id of node.itemEntityIds) {
    if (targets.has(id)) {
      issue(`collect "${node.id}" lists item "${id}" more than once`);
    }
    targets.add(id);
    checkRef(node.id, "itemEntityIds", id, "collectItem");
  }

  const distractors = new Set<string>();
  for (const id of node.distractorEntityIds ?? []) {
    if (distractors.has(id)) {
      issue(`collect "${node.id}" lists distractor "${id}" more than once`);
    }
    distractors.add(id);
    checkRef(node.id, "distractorEntityIds", id, "collectDistractor");
    if (targets.has(id)) {
      issue(
        `collect "${node.id}" lists "${id}" as both a target and a distractor`,
      );
    }
  }

  if (node.placements) {
    const sum = node.placements.reduce((acc, p) => acc + p.count, 0);
    if (sum !== node.count) {
      issue(
        `collect "${node.id}" placements sum to ${sum} but count is ${node.count}`,
      );
    }
  }
}

function validateChooseNode(
  node: ChooseNode,
  issue: (message: string) => void,
  checkRef: (
    nodeId: string,
    field: string,
    entityId: string,
    rule: keyof typeof KIND_RULES,
  ) => void,
): void {
  checkRef(node.id, "posedByEntityId", node.posedByEntityId, "choosePoser");

  const seen = new Set<string>();
  let correctCount = 0;
  for (const opt of node.options) {
    if (seen.has(opt.entityId)) {
      issue(`choose "${node.id}" repeats option entity "${opt.entityId}"`);
    }
    seen.add(opt.entityId);
    checkRef(node.id, "options", opt.entityId, "chooseOption");
    if (opt.correct === true) correctCount += 1;
  }
  if (correctCount !== 1) {
    issue(
      `choose "${node.id}" has ${correctCount} correct options — exactly 1 required`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const goalTreeGameSchema = goalTreeGameSchemaBase.superRefine(
  validateGameStructure,
) as unknown as z.ZodType<GoalTreeGame>;

/** Convenience wrapper returning { ok: true, data } | { ok: false, errors }. */
export function validateGoalTreeGame(
  input: unknown,
):
  | { ok: true; data: GoalTreeGame }
  | { ok: false; errors: string[] } {
  const res = goalTreeGameSchema.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => {
      const path = i.path.length ? i.path.join(".") + ": " : "";
      return path + i.message;
    }),
  };
}
