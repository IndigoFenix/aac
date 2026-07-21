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
  ConverseNode,
  EntityDef,
  EntityKind,
  GoalNode,
  GoalTreeGame,
} from "./types.js";
import {
  CHOOSE_MAX_OPTIONS,
  COLLECT_MAX_COUNT,
  CONVERSE_MAX_LINES,
  CONVERSE_MAX_OPTIONS,
  CONVERSE_MAX_PROPS,
  CONVERSE_MAX_TURNS,
  FULFILL_MAX_ITEMS,
  GOAL_TREE_MAX_DEPTH,
  GOAL_TREE_MAX_ENTITIES,
  GOAL_TREE_MAX_NODES,
  OBSERVE_MAX_CUES,
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

// A composed AAC glyph string (e.g. "big", "day.next", "i_me+want+apple").
// Permissive on the glyph-syntax punctuation (./+/#/:) the registry uses; the
// runtime/compositor interpret it — the schema just bounds it.
const glyphStringSchema = z.string().min(1).max(120);

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
  glyph: glyphStringSchema.optional(),
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
    observeNodeSchema,
    transportNodeSchema,
    converseNodeSchema,
    fulfillNodeSchema,
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

// Declared before chooseNodeSchema so `choose.onCorrect` can reference it
// (top-level consts evaluate in order; referencing it later would hit the TDZ).
const demoCueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scale"),
    entityId: idSchema,
    to: z.number().min(0.1).max(8),
    seconds: z.number().min(0.1).max(10).optional(),
  }).strict(),
  z.object({
    kind: z.literal("move"),
    entityId: idSchema,
    dx: z.number().min(-50).max(50),
    dy: z.number().min(-50).max(50),
    seconds: z.number().min(0.1).max(10).optional(),
  }).strict(),
  z.object({
    kind: z.literal("spawn"),
    entityId: idSchema,
    count: z.number().int().min(1).max(12),
  }).strict(),
  z.object({
    kind: z.literal("emote"),
    entityId: idSchema,
    emotion: z.enum(["happy", "sad"]),
  }).strict(),
  z.object({
    kind: z.literal("glow"),
    entityId: idSchema,
    tone: z.enum(["warm", "cool"]),
  }).strict(),
]);

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
  onCorrect: z.array(demoCueSchema).min(1).max(OBSERVE_MAX_CUES).optional(),
}).strict();

const observeNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("observe"),
  targetGlyph: glyphStringSchema,
  contrastGlyph: glyphStringSchema.optional(),
  stageEntityId: idSchema,
  zoneHint: z.string().min(1).max(120).optional(),
  demonstrate: z.array(demoCueSchema).min(1).max(OBSERVE_MAX_CUES),
  via: viaSchema.optional(),
}).strict();

const transportNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("transport"),
  objectEntityId: idSchema,
  distractorEntityIds: z.array(idSchema).optional(),
  destEntityId: idSchema,
  relation: z.enum(["on", "in", "under"]).optional(),
  zoneHint: z.string().min(1).max(120).optional(),
  via: viaSchema.optional(),
}).strict();

const converseConditionSchema = z.object({
  kind: z.enum(["carrying", "not-carrying", "knows", "given"]),
  entityId: idSchema,
}).strict();

const converseLineSchema = z.object({
  when: z.array(converseConditionSchema).min(1).max(4).optional(),
  glyph: glyphStringSchema,
}).strict();

const converseOptionSchema = z.object({
  entityId: idSchema,
  when: z.array(converseConditionSchema).min(1).max(4).optional(),
  give: z.array(idSchema).min(1).max(2).optional(),
  receive: z.array(idSchema).min(1).max(2).optional(),
  reveal: z.array(idSchema).min(1).max(2).optional(),
  cues: z.array(demoCueSchema).min(1).max(OBSERVE_MAX_CUES).optional(),
  next: idSchema.optional(),
  completes: z.boolean().optional(),
}).strict();

const converseTurnSchema = z.object({
  id: idSchema,
  lines: z.array(converseLineSchema).min(1).max(CONVERSE_MAX_LINES),
  options: z.array(converseOptionSchema).min(1).max(CONVERSE_MAX_OPTIONS),
}).strict();

const converseNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("converse"),
  npcEntityId: idSchema,
  entry: idSchema,
  turns: z.array(converseTurnSchema).min(1).max(CONVERSE_MAX_TURNS),
  propEntityIds: z.array(idSchema).min(1).max(CONVERSE_MAX_PROPS).optional(),
  zoneHint: z.string().min(1).max(120).optional(),
  via: viaSchema.optional(),
}).strict();

const causalFactSchema = z.object({
  connective: z.enum(["because", "therefore", "in_order_to", "when", "until"]),
  cause: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("possessionLack"), itemEntityId: idSchema }).strict(),
    z.object({ kind: z.literal("creatureState"), state: z.string().min(1).max(40), creatureNodeId: idSchema.optional() }).strict(),
    z.object({ kind: z.literal("itemState"), itemEntityId: idSchema, state: z.string().min(1).max(40) }).strict(),
    z.object({ kind: z.literal("likes"), itemEntityId: idSchema.optional(), facet: z.string().min(1).max(40).optional() }).strict(),
    z.object({ kind: z.literal("wantsTo"), verb: z.string().min(1).max(40) }).strict(),
  ]),
}).strict();

const fulfillNodeSchema = z.object({
  ...goalNodeBaseFields,
  type: z.literal("fulfill"),
  npcEntityId: idSchema,
  needItemEntityId: idSchema.optional(),
  needItemEntityIds: z.array(idSchema).min(1).max(FULFILL_MAX_ITEMS).optional(),
  needValue: z.number().int().min(1).max(9).optional(),
  needPlacedInEntityId: idSchema.optional(),
  needForNodeId: idSchema.optional(),
  needAtPlaceNodeId: idSchema.optional(),
  needStayWith: z.boolean().optional(),
  needEscort: z.boolean().optional(),
  needPlacedOutdoors: z.boolean().optional(),
  needItemState: z.enum(["hot", "cold"]).optional(),
  needDeviceState: z.enum(["on", "off", "open", "closed"]).optional(),
  powerDeviceEntityId: idSchema.optional(),
  stationKinds: z.array(z.enum(["fire", "water"])).min(1).max(2).optional(),
  stationPowerDeviceId: idSchema.optional(),
  likeEntityIds: z.array(idSchema).min(1).max(FULFILL_MAX_ITEMS).optional(),
  stockEntityIds: z.array(idSchema).min(1).max(FULFILL_MAX_ITEMS).optional(),
  propEntityIds: z.array(idSchema).min(1).max(FULFILL_MAX_ITEMS).optional(),
  playerDebt: z.number().int().min(1).max(9).optional(),
  announce: z.enum(["before", "after", "never"]).optional(),
  boundEntityIds: z.array(idSchema).min(1).max(FULFILL_MAX_ITEMS).optional(),
  thoughtScaffold: z.boolean().optional(),
  causalFact: causalFactSchema.optional(),
  condition: z.string().min(1).max(40).optional(),
  needTarget: z
    .object({
      kind: z.string().min(1).max(40).optional(),
      category: z.string().min(1).max(40).optional(),
      descriptors: z.array(z.string().min(1).max(40)).min(1).max(4).optional(),
      state: z.string().min(1).max(40).optional(),
    })
    .strict()
    .optional(),
  motiveReveal: z.enum(["want", "because", "motive"]).optional(),
  needLocationKnown: z.boolean().optional(),
  knowsItemEntityIds: z.array(idSchema).min(1).max(FULFILL_MAX_ITEMS).optional(),
  zoneHint: z.string().min(1).max(120).optional(),
  via: viaSchema.optional(),
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
  syntax: z.enum(["a", "b", "c"]).optional(),
  layout: z.enum(["village", "house"]).optional(),
  seed: z.number().int().nonnegative().max(0xffffffff).optional(),
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
  observeStage: ["marker", "character", "item"],
  demoProp: ["item", "character", "obstacle", "marker"],
  transportObject: ["item"],
  transportDest: ["marker", "item"],
  converseNpc: ["character", "marker"],
  converseOption: ["item", "character", "marker"],
  converseItem: ["item"],
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
  // Entities consumed by a converse `give`, per node — an item may be consumed
  // by at most ONE converse node, or handing it to the wrong NPC could strand
  // another quest (the one softlock the satchel model admits).
  const giveConsumers = new Map<string, Set<string>>();
  // On-behalf needs reference OTHER fulfill nodes — checked after the walk.
  const fulfillNodeIds = new Set<string>();
  const onBehalfRefs: { from: string; to: string }[] = [];
  // An `in_order_to` goal clause may name another creature — checked after the walk.
  const causalCreatureRefs: { from: string; to: string }[] = [];
  // Presence (go-to) needs reference the destination fulfill node.
  const presenceRefs: { from: string; to: string }[] = [];

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
      case "observe":
        checkRef(node.id, "stageEntityId", node.stageEntityId, "observeStage");
        for (const cue of node.demonstrate) {
          checkRef(node.id, "demonstrate", cue.entityId, "demoProp");
        }
        break;
      case "transport": {
        checkRef(node.id, "objectEntityId", node.objectEntityId, "transportObject");
        checkRef(node.id, "destEntityId", node.destEntityId, "transportDest");
        const seenCarry = new Set<string>([node.objectEntityId]);
        for (const id of node.distractorEntityIds ?? []) {
          if (seenCarry.has(id)) {
            issue(`transport "${node.id}" lists "${id}" as both the target and a distractor (or twice)`);
          }
          seenCarry.add(id);
          checkRef(node.id, "distractorEntityIds", id, "transportObject");
        }
        break;
      }
      case "converse":
        validateConverseNode(node, issue, checkRef, giveConsumers);
        break;
      case "fulfill": {
        fulfillNodeIds.add(node.id);
        checkRef(node.id, "npcEntityId", node.npcEntityId, "converseNpc");
        const own = new Set<string>();
        const checkList = (field: string, ids: string[] | undefined) => {
          const placement =
            field === "stockEntityIds" || field === "propEntityIds" || field === "boundEntityIds";
          for (const id of ids ?? []) {
            checkRef(node.id, field, id, "converseItem");
            if (placement) {
              // stock + props are physical placements — no double-placing.
              // (likes + known locations are relations, not placements.)
              if (own.has(id)) issue(`fulfill "${node.id}" places item "${id}" twice`);
              own.add(id);
              const holders = giveConsumers.get(`fulfill:${id}`) ?? new Set<string>();
              holders.add(node.id);
              giveConsumers.set(`fulfill:${id}`, holders);
            }
          }
        };
        checkList("stockEntityIds", node.stockEntityIds);
        checkList("propEntityIds", node.propEntityIds);
        checkList("boundEntityIds", node.boundEntityIds); // physical placement too
        checkList("likeEntityIds", node.likeEntityIds);
        checkList("knowsItemEntityIds", node.knowsItemEntityIds);
        if (node.needItemEntityId) {
          checkRef(node.id, "needItemEntityId", node.needItemEntityId, "converseItem");
          if (node.stockEntityIds?.includes(node.needItemEntityId)) {
            issue(`fulfill "${node.id}" needs "${node.needItemEntityId}" but already stocks it`);
          }
        }
        {
          // Multi-item needs: distinct further instances, none stocked here.
          const allNeeds = new Set(node.needItemEntityId ? [node.needItemEntityId] : []);
          for (const id of node.needItemEntityIds ?? []) {
            checkRef(node.id, "needItemEntityIds", id, "converseItem");
            if (allNeeds.has(id)) issue(`fulfill "${node.id}" needs item "${id}" twice`);
            allNeeds.add(id);
            if (node.stockEntityIds?.includes(id)) {
              issue(`fulfill "${node.id}" needs "${id}" but already stocks it`);
            }
          }
          if (node.needItemEntityIds?.length && !node.needItemEntityId) {
            issue(`fulfill "${node.id}" lists further need items without needItemEntityId`);
          }
        }
        if (node.needPlacedInEntityId) {
          checkRef(node.id, "needPlacedInEntityId", node.needPlacedInEntityId, "converseItem");
          if (!node.needItemEntityId) {
            issue(`fulfill "${node.id}" sets needPlacedInEntityId without a need`);
          }
          if (
            node.needPlacedInEntityId === node.needItemEntityId ||
            node.needItemEntityIds?.includes(node.needPlacedInEntityId)
          ) {
            issue(`fulfill "${node.id}" wants an item placed inside itself`);
          }
          // The container is a physical placement in this creature's zone.
          const holders = giveConsumers.get(`fulfill:${node.needPlacedInEntityId}`) ?? new Set<string>();
          holders.add(node.id);
          giveConsumers.set(`fulfill:${node.needPlacedInEntityId}`, holders);
        }
        if (node.needForNodeId) {
          if (!node.needItemEntityId) {
            issue(`fulfill "${node.id}" sets needForNodeId without a need`);
          }
          if (node.needForNodeId === node.id) {
            issue(`fulfill "${node.id}" wants an item delivered to itself — use a plain need`);
          }
          if (node.needPlacedInEntityId) {
            issue(`fulfill "${node.id}" mixes needPlacedInEntityId with needForNodeId — pick one`);
          }
          onBehalfRefs.push({ from: node.id, to: node.needForNodeId });
        }
        if (node.needAtPlaceNodeId) {
          if (node.needAtPlaceNodeId === node.id) {
            issue(`fulfill "${node.id}" wants the player to go to itself`);
          }
          presenceRefs.push({ from: node.id, to: node.needAtPlaceNodeId });
        }
        if (node.needStayWith && (node.needItemEntityId || node.needAtPlaceNodeId)) {
          issue(`fulfill "${node.id}" mixes needStayWith with an item/presence need — pick one`);
        }
        if (node.needEscort && !node.needAtPlaceNodeId) {
          issue(`fulfill "${node.id}" sets needEscort without needAtPlaceNodeId`);
        }
        if (node.needPlacedOutdoors && !node.needPlacedInEntityId) {
          issue(`fulfill "${node.id}" sets needPlacedOutdoors without needPlacedInEntityId`);
        }
        if (node.needItemState && !node.needItemEntityId) {
          issue(`fulfill "${node.id}" sets needItemState without a need`);
        }
        if (node.needDeviceState && !node.needItemEntityId) {
          issue(`fulfill "${node.id}" sets needDeviceState without a device need`);
        }
        if (node.powerDeviceEntityId) {
          checkRef(node.id, "powerDeviceEntityId", node.powerDeviceEntityId, "converseItem");
          if (!node.needDeviceState) {
            issue(`fulfill "${node.id}" sets powerDeviceEntityId without a device need`);
          }
        }
        if (node.stationPowerDeviceId) {
          checkRef(node.id, "stationPowerDeviceId", node.stationPowerDeviceId, "converseItem");
          if (!node.stationKinds?.length) {
            issue(`fulfill "${node.id}" sets stationPowerDeviceId without a station`);
          }
        }
        if (node.causalFact) {
          if (!node.needItemEntityId) {
            issue(`fulfill "${node.id}" sets causalFact without a need`);
          }
          const cause = node.causalFact.cause;
          if (cause.kind === "possessionLack" || cause.kind === "itemState") {
            checkRef(node.id, "causalFact", cause.itemEntityId, "converseItem");
          }
          if (cause.kind === "creatureState" && cause.creatureNodeId) {
            causalCreatureRefs.push({ from: node.id, to: cause.creatureNodeId });
          }
        }
        // A condition needs SOMETHING that remedies it: an item need, or the
        // stay-with company need ("lonely" clears when the player stays).
        if (node.condition && !node.needItemEntityId && !node.needStayWith) {
          issue(`fulfill "${node.id}" sets condition without a need to remedy it`);
        }
        if (node.needLocationKnown === false && !node.needItemEntityId) {
          issue(`fulfill "${node.id}" sets needLocationKnown without a need`);
        }
        break;
      }
    }
  }

  for (const ref of causalCreatureRefs) {
    if (!fulfillNodeIds.has(ref.to)) {
      issue(`fulfill "${ref.from}" causalFact names creature "${ref.to}", which is not a fulfill node`);
    }
  }
  for (const ref of presenceRefs) {
    if (!fulfillNodeIds.has(ref.to)) {
      issue(`fulfill "${ref.from}" needAtPlaceNodeId references "${ref.to}", which is not a fulfill node`);
    }
  }
  for (const ref of onBehalfRefs) {
    if (!fulfillNodeIds.has(ref.to)) {
      issue(`fulfill "${ref.from}" needForNodeId references "${ref.to}", which is not a fulfill node`);
    }
  }

  for (const [entityId, consumers] of giveConsumers) {
    if (consumers.size > 1) {
      const isPlacement = entityId.startsWith("fulfill:");
      issue(
        isPlacement
          ? `item "${entityId.slice(8)}" is placed by more than one fulfill node ` +
            `(${[...consumers].join(", ")}) — one physical item cannot be in two rooms`
          : `item "${entityId}" is consumed (give) by more than one converse node ` +
            `(${[...consumers].join(", ")}) — giving it to the wrong NPC could strand the other quest`,
      );
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
  // onCorrect payoff cues reference props the same way an observe demo does.
  for (const cue of node.onCorrect ?? []) {
    checkRef(node.id, "onCorrect", cue.entityId, "demoProp");
  }
}

function validateConverseNode(
  node: ConverseNode,
  issue: (message: string) => void,
  checkRef: (
    nodeId: string,
    field: string,
    entityId: string,
    rule: keyof typeof KIND_RULES,
  ) => void,
  giveConsumers: Map<string, Set<string>>,
): void {
  checkRef(node.id, "npcEntityId", node.npcEntityId, "converseNpc");

  // -- turns: unique ids; entry + next refs resolve
  const turnById = new Map(node.turns.map((t) => [t.id, t]));
  const seenTurnIds = new Set<string>();
  for (const turn of node.turns) {
    if (seenTurnIds.has(turn.id)) {
      issue(`converse "${node.id}" repeats turn id "${turn.id}"`);
    }
    seenTurnIds.add(turn.id);
  }
  if (!turnById.has(node.entry)) {
    issue(`converse "${node.id}" entry "${node.entry}" is not a turn id`);
  }

  for (const turn of node.turns) {
    // -- lines: the last must be unconditional so the turn can always render
    const last = turn.lines[turn.lines.length - 1];
    if (last?.when?.length) {
      issue(`converse "${node.id}" turn "${turn.id}" — the last line must be unconditional`);
    }
    for (const line of turn.lines) {
      for (const cond of line.when ?? []) {
        checkRef(node.id, `turn "${turn.id}" line condition`, cond.entityId, "converseItem");
      }
    }

    // -- options: unique board entities; ≥1 unconditional; carrying-only gates;
    //    give entities must be gated on carrying them; transfers reference items
    const seenOptions = new Set<string>();
    let unconditional = 0;
    for (const opt of turn.options) {
      if (seenOptions.has(opt.entityId)) {
        issue(`converse "${node.id}" turn "${turn.id}" repeats option entity "${opt.entityId}"`);
      }
      seenOptions.add(opt.entityId);
      checkRef(node.id, `turn "${turn.id}" option`, opt.entityId, "converseOption");
      if (!opt.when?.length) unconditional += 1;
      for (const cond of opt.when ?? []) {
        if (cond.kind === "not-carrying") {
          issue(
            `converse "${node.id}" turn "${turn.id}" option "${opt.entityId}" is gated on ` +
              `"not-carrying" — options may only use monotone gates (carrying/knows/given); ` +
              `lines may use not-carrying`,
          );
        }
        checkRef(node.id, `turn "${turn.id}" option condition`, cond.entityId, "converseItem");
      }
      const carried = new Set((opt.when ?? []).filter((c) => c.kind === "carrying").map((c) => c.entityId));
      for (const id of opt.give ?? []) {
        checkRef(node.id, `turn "${turn.id}" give`, id, "converseItem");
        if (!carried.has(id)) {
          issue(
            `converse "${node.id}" turn "${turn.id}" option "${opt.entityId}" gives "${id}" ` +
              `without a matching {carrying ${id}} condition`,
          );
        }
        const consumers = giveConsumers.get(id) ?? new Set<string>();
        consumers.add(node.id);
        giveConsumers.set(id, consumers);
      }
      for (const id of opt.receive ?? []) {
        checkRef(node.id, `turn "${turn.id}" receive`, id, "converseItem");
      }
      for (const id of opt.reveal ?? []) {
        checkRef(node.id, `turn "${turn.id}" reveal`, id, "converseItem");
      }
      for (const cue of opt.cues ?? []) {
        checkRef(node.id, `turn "${turn.id}" cues`, cue.entityId, "demoProp");
      }
      if (opt.next !== undefined && !turnById.has(opt.next)) {
        issue(
          `converse "${node.id}" turn "${turn.id}" option "${opt.entityId}" points at ` +
            `unknown turn "${opt.next}"`,
        );
      }
    }
    if (unconditional === 0) {
      issue(`converse "${node.id}" turn "${turn.id}" has no unconditional option — the board could render empty`);
    }
  }

  // -- props: unique items
  const seenProps = new Set<string>();
  for (const id of node.propEntityIds ?? []) {
    if (seenProps.has(id)) {
      issue(`converse "${node.id}" lists prop "${id}" more than once`);
    }
    seenProps.add(id);
    checkRef(node.id, "propEntityIds", id, "converseItem");
  }

  // -- a completing option must be structurally reachable from entry (the
  //    solver additionally proves it reachable under item conditions)
  const visited = new Set<string>();
  const queue = [node.entry];
  let completable = false;
  while (queue.length) {
    const turn = turnById.get(queue.pop()!);
    if (!turn || visited.has(turn.id)) continue;
    visited.add(turn.id);
    for (const opt of turn.options) {
      if (opt.completes) completable = true;
      if (opt.next && !visited.has(opt.next)) queue.push(opt.next);
    }
  }
  if (!completable) {
    issue(`converse "${node.id}" has no completing option reachable from entry "${node.entry}"`);
  }
  for (const turn of node.turns) {
    if (!visited.has(turn.id)) {
      issue(`converse "${node.id}" turn "${turn.id}" is unreachable from entry "${node.entry}"`);
    }
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
