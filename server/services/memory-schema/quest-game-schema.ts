// server/services/memory-schema/quest-game-schema.ts
//
// Memory schema + authoring prompt + starter template for goal-tree quest
// games (Context_QuestGame).
//
// WHY this exists: the clinician chat AI authors and edits quest games through
// the ordinary memory system (manageMemory), the same rail it uses for boards
// and student data. For that to work the renderer must be able to SHOW the
// game's structure — and the renderer only renders schema-DECLARED keys
// (runtime-only keys are skipped, see chat/memory-system.ts renderObject).
// So the goal-tree shape is declared in full here, recursively, with a
// description on every field. Correctness is still enforced downstream by the
// certification gauntlet (certifyGoalTreeGame), surfaced to the AI via the
// validateQuestGame tool — this schema is for VISIBILITY + guidance, not for
// gating.
//
// The schema mirrors shared/goal-tree/types.ts + schema.ts. The recursive node
// shape (overcome.key, reach/collect.via) is expressed with self-referential
// schema objects — safe because AgentMemoryField objects are never serialized;
// rendering and path-resolution are driven by the runtime VALUE's depth.

import type { AgentMemoryField } from "../chat/memory-types";
import {
  type GoalTreeGame,
  GOAL_TREE_MAX_DEPTH,
  GOAL_TREE_MAX_NODES,
  GOAL_TREE_MAX_ENTITIES,
  CHOOSE_MAX_OPTIONS,
  COLLECT_MAX_COUNT,
} from "@shared/world-engine/solver/types";

// ---------------------------------------------------------------------------
// Recursive goal-node schema
// ---------------------------------------------------------------------------
// Built as a flattened, documented union: one object schema carrying every
// node type's fields as optional properties, discriminated by `type`. The
// renderer shows whichever fields are actually present; the certifier enforces
// that the right fields exist for each type.

const goalNode: any = {
  id: "node",
  type: "object",
  title: "Goal Node",
  description:
    "One goal in the tree. `type` selects which other fields apply. " +
    "NEVER include fields that don't belong to the chosen type — the validator rejects extras.",
  properties: {
    id: {
      id: "id",
      type: "string",
      title: "Node ID",
      description: "Unique across the WHOLE tree. Letters/digits/underscore, must start with a letter or underscore.",
    },
    type: {
      id: "type",
      type: "string",
      title: "Node Type",
      enum: ["reach", "collect", "choose", "overcome"],
      description:
        "reach = travel to a marker. collect = gather items (a category). " +
        "choose = answer a question (THE curriculum carrier). " +
        "overcome = a lock whose `key` is a sub-goal (lock-and-key structure).",
    },
    intro: {
      id: "intro",
      type: "string",
      title: "Intro Narration",
      description: "Optional. Spoken when this goal becomes active. In meta.locale.",
    },
    outro: {
      id: "outro",
      type: "string",
      title: "Outro Narration",
      description: "Optional. Spoken when this goal is completed. In meta.locale.",
    },

    // --- reach -------------------------------------------------------------
    markerEntityId: {
      id: "markerEntityId",
      type: "string",
      title: "Destination (reach)",
      description: "type=reach ONLY. The place to travel to — an entity of kind marker or character.",
    },
    zoneHint: {
      id: "zoneHint",
      type: "string",
      title: "Zone Theme Hint",
      description: "type=reach|collect. Theme hint for the zone this goal creates (e.g. 'the dark forest').",
    },

    // --- collect -----------------------------------------------------------
    itemEntityIds: {
      id: "itemEntityIds",
      type: "array",
      title: "Target Items (collect)",
      description: "type=collect ONLY. Acceptable item entity ids (kind item). The set IS the educational category.",
      items: { id: "itemEntityId", type: "string", title: "Item Entity ID" },
    },
    count: {
      id: "count",
      type: "integer",
      title: "Count (collect)",
      minimum: 1,
      maximum: COLLECT_MAX_COUNT,
      description: `type=collect ONLY. How many items to gather (1..${COLLECT_MAX_COUNT}).`,
    },
    distractorEntityIds: {
      id: "distractorEntityIds",
      type: "array",
      title: "Distractors (collect)",
      description: "type=collect, optional. Wrong items present. Picking one gives gentle feedback, never failure.",
      items: { id: "distractorEntityId", type: "string", title: "Distractor Entity ID" },
    },
    placements: {
      id: "placements",
      type: "array",
      title: "Placements (collect)",
      description:
        "type=collect, optional. Splits the items into groups; counts MUST sum to `count`. " +
        "Omit entirely = all items freely reachable. Use it to hide some items behind a lock (group `via`).",
      items: {
        id: "placement",
        type: "object",
        title: "Placement",
        properties: {
          count: { id: "count", type: "integer", title: "Count", description: "How many of the items are in this group." },
          // `via` assigned below (recursive)
        },
        required: ["count"],
      },
    },

    // --- choose ------------------------------------------------------------
    posedByEntityId: {
      id: "posedByEntityId",
      type: "string",
      title: "Asked By (choose)",
      description: "type=choose ONLY. Who poses the question — an entity of kind character or marker.",
    },
    prompt: {
      id: "prompt",
      type: "string",
      title: "Prompt",
      description:
        "type=choose: REQUIRED — the question (in meta.locale). " +
        "type=overcome: optional — what the obstacle says/shows when encountered.",
    },
    options: {
      id: "options",
      type: "array",
      title: "Options (choose)",
      description: `type=choose ONLY. 2..${CHOOSE_MAX_OPTIONS} options, EXACTLY ONE with correct=true. An option has ONLY entityId/correct/feedback — no label/text.`,
      items: {
        id: "option",
        type: "object",
        title: "Option",
        properties: {
          entityId: {
            id: "entityId",
            type: "string",
            title: "Option Entity ID",
            description: "An EXISTING entity id (kind item/character/marker). The button shows THAT entity's label + icon — do NOT add a label/text field to the option; put the wording on the entity instead.",
          },
          correct: {
            id: "correct",
            type: "boolean",
            title: "Correct?",
            description: "Set true on EXACTLY ONE option. Omit/false on the rest.",
          },
          feedback: {
            id: "feedback",
            type: "string",
            title: "Feedback",
            description: "Optional. Gentle spoken feedback if this (wrong) option is picked, then retry.",
          },
        },
        required: ["entityId"],
      },
    },

    // --- overcome ----------------------------------------------------------
    obstacleEntityId: {
      id: "obstacleEntityId",
      type: "string",
      title: "Obstacle (overcome)",
      description: "type=overcome ONLY. The blocker — an entity of kind obstacle.",
    },
    // `key` assigned below (recursive: any node type)

    // --- shared (reach | collect) -----------------------------------------
    // `via` assigned below (recursive: a list of overcome nodes)
  },
  required: ["id", "type"],
};

// A `via` item is ALWAYS an `overcome` node (type forced to "overcome"); its
// `key` sub-goal is what clears it. Declaring via items with this constrained
// shape — not the full node union — steers the AI away from dropping a
// reach/collect/choose straight into `via` (a frequent, rejected mistake).
const overcomeNode: any = {
  id: "overcome",
  type: "object",
  title: "Obstacle (overcome node)",
  description:
    "A lock. ALWAYS type=\"overcome\". Its `key` sub-goal (any node type) clears it. " +
    "Appears only inside a `via` list.",
  properties: {
    id: { id: "id", type: "string", title: "Node ID", description: "Unique across the whole tree." },
    type: {
      id: "type",
      type: "string",
      title: "Node Type",
      enum: ["overcome"],
      description: "Must be \"overcome\".",
    },
    intro: { id: "intro", type: "string", title: "Intro Narration", description: "Optional. In meta.locale." },
    outro: { id: "outro", type: "string", title: "Outro Narration", description: "Optional. In meta.locale." },
    obstacleEntityId: {
      id: "obstacleEntityId",
      type: "string",
      title: "Obstacle Entity",
      description: "The blocker — an entity of kind obstacle.",
    },
    prompt: {
      id: "prompt",
      type: "string",
      title: "Prompt",
      description: "Optional. What the obstacle says/shows when encountered.",
    },
    // `key` assigned below (recursive: any node type).
  },
  required: ["id", "type", "obstacleEntityId", "key"],
};

const viaArray: any = {
  id: "via",
  type: "array",
  title: "Guarding Obstacles (via)",
  description:
    "type=reach|collect, optional. A list of OVERCOME nodes (locks) on the way in — every item MUST be " +
    "{ type:\"overcome\", obstacleEntityId, key }. ALL must be cleared first. To gate the way with a " +
    "question or a fetch-quest, put a choose/collect node as the overcome's `key`, NOT directly in `via`.",
  items: overcomeNode,
};

// Wire the recursive edges now that the node schemas exist.
overcomeNode.properties.key = {
  ...goalNode,
  id: "key",
  title: "Key Sub-Goal",
  description: "The sub-goal that, once completed, clears this obstacle. Any node type (reach/collect/choose/overcome).",
};
goalNode.properties.via = viaArray;
goalNode.properties.placements.items.properties.via = viaArray;
goalNode.properties.key = {
  ...goalNode,
  id: "key",
  title: "Key Sub-Goal (overcome)",
  description: "type=overcome ONLY. The sub-goal that, once completed, clears the obstacle. Any node type.",
};

// ---------------------------------------------------------------------------
// Entity schema
// ---------------------------------------------------------------------------

const entity: any = {
  id: "entity",
  type: "object",
  title: "Entity",
  description: "A thing in the game (item / character / obstacle / marker). Every id a node references MUST exist here.",
  properties: {
    id: {
      id: "id",
      type: "string",
      title: "Entity ID",
      description: "Unique. Letters/digits/underscore, must start with a letter or underscore.",
    },
    kind: {
      id: "kind",
      type: "string",
      title: "Kind",
      enum: ["item", "character", "obstacle", "marker"],
      description: "item = collectible. character = NPC/poser. obstacle = a lock. marker = a place/destination.",
    },
    label: { id: "label", type: "string", title: "Label", description: "Player-facing display name, in meta.locale." },
    spokenLabel: { id: "spokenLabel", type: "string", title: "Spoken Label", description: "Optional TTS override; defaults to label." },
    iconRef: { id: "iconRef", type: "string", title: "Emoji", description: "Emoji shown for this entity (e.g. 🐄). Prefer an emoji that fits the theme." },
    imageKey: {
      id: "imageKey",
      type: "string",
      title: "Image Key",
      description: "Optional. lower_snake_case key for the AAC image-generation pipeline, when an emoji won't do.",
    },
    symbolPath: { id: "symbolPath", type: "string", title: "Symbol Path", description: "Optional custom symbol path (same resolution as AAC boards)." },
    tags: {
      id: "tags",
      type: "array",
      title: "Tags",
      description: "Optional semantic tags ('red', 'animal') for reporting.",
      items: { id: "tag", type: "string", title: "Tag" },
    },
    lines: {
      id: "lines",
      type: "array",
      title: "Dialogue Lines",
      description: "Optional flavor lines for a character (pre-rendered via TTS). Max 8.",
      items: { id: "line", type: "string", title: "Line" },
    },
  },
  required: ["id", "kind", "label"],
};

// ---------------------------------------------------------------------------
// Top-level Context_QuestGame field
// ---------------------------------------------------------------------------

const contentPack: any = {
  id: "contentPack",
  type: "object",
  title: "Game Definition",
  description: "The goal-tree game. engine/engineVersion are fixed; author meta, entities, and root.",
  properties: {
    engine: { id: "engine", type: "string", title: "Engine", readOnly: true, description: "Managed automatically — do not set or remove." },
    engineVersion: { id: "engineVersion", type: "integer", title: "Engine Version", readOnly: true, description: "Managed automatically — do not set or remove." },
    meta: {
      id: "meta",
      type: "object",
      title: "Meta",
      properties: {
        title: { id: "title", type: "string", title: "Title", description: "Game title, in meta.locale." },
        description: { id: "description", type: "string", title: "Description", description: "Optional one-line summary." },
        locale: {
          id: "locale",
          type: "string",
          title: "Locale",
          description: "BCP-47 (e.g. 'en', 'he'). ALL player-facing text — labels, prompts, narration, feedback — is written in this locale.",
        },
        theme: { id: "theme", type: "string", title: "Theme", description: "Free text ('farm animals', 'space picnic')." },
        aiCompanion: {
          id: "aiCompanion",
          type: "object",
          title: "AI Companion",
          description: "Optional. The live AI in-game companion/narrator.",
          properties: {
            name: { id: "name", type: "string", title: "Name", description: "The companion's in-game name." },
            persona: { id: "persona", type: "string", title: "Persona", description: "How the companion behaves ('warm, cheers in short sentences')." },
          },
          required: ["name", "persona"],
        },
        learningGoals: {
          id: "learningGoals",
          type: "array",
          title: "Learning Goals",
          description: "Optional human-readable goals, for clinician reports. Max 10.",
          items: { id: "learningGoal", type: "string", title: "Learning Goal" },
        },
      },
      required: ["title", "locale", "theme"],
    },
    entities: {
      id: "entities",
      type: "array",
      title: "Entities",
      description: `All things in the game. 1..${GOAL_TREE_MAX_ENTITIES}. Every id a node references must be defined here.`,
      opened: true,
      items: entity,
    },
    root: {
      ...goalNode,
      id: "root",
      title: "Root Goal",
      description: `Completing this goal wins the game. The whole tree has at most ${GOAL_TREE_MAX_NODES} nodes and depth ${GOAL_TREE_MAX_DEPTH}.`,
      opened: true,
    },
  },
  required: ["meta", "entities", "root"],
};

export const QUEST_GAME_MEMORY_FIELD: AgentMemoryField = {
  id: "Context_QuestGame",
  type: "object",
  title: "Quest Game (goal-tree)",
  description:
    "The goal-tree quest game open in the panel. Author/edit `contentPack` via memory ops " +
    "(view it first), then call validateQuestGame before telling the user it is ready.",
  opened: true,
  properties: {
    appId: { id: "appId", type: "string", title: "App ID", readOnly: true },
    name: { id: "name", type: "string", title: "Name" },
    contentPack,
  },
} as unknown as AgentMemoryField;

// ---------------------------------------------------------------------------
// Starter template — a minimal game that CERTIFIES (asserted by tests).
// createQuestGame seeds this so the panel always opens a valid, playable game;
// the AI then builds it out via memory ops.
// ---------------------------------------------------------------------------

/**
 * Force the managed wrapper fields the AI shouldn't author. The AI often
 * replaces the whole contentPack and drops the readOnly engine/engineVersion
 * (or sets them wrong); injecting them here removes a whole recurring class of
 * certification failures. Anything that isn't an object is returned untouched
 * so the certifier still reports a clean "not a game" error.
 */
export function normalizeContentPack(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { ...(raw as Record<string, unknown>), engine: "goal-tree", engineVersion: 1 };
}

export function createEmptyQuestGame(opts: { title?: string; locale?: string } = {}): GoalTreeGame {
  const locale = opts.locale?.trim() || "en";
  const title = opts.title?.trim() || "New Quest";
  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: {
      title,
      locale,
      theme: "adventure",
      aiCompanion: {
        name: "Guide",
        persona: "Warm and encouraging; celebrates progress in short, simple sentences.",
      },
      learningGoals: [],
    },
    entities: [
      { id: "goal_marker", kind: "marker", label: "the goal", iconRef: "⭐" },
    ],
    root: {
      type: "reach",
      id: "root",
      markerEntityId: "goal_marker",
      intro: "Let's begin our adventure!",
      outro: "You made it — well done!",
    },
  };
}

// ---------------------------------------------------------------------------
// Structural explanation injected into the clinician system prompt while a
// quest game is open in the customApps panel.
// ---------------------------------------------------------------------------

export const QUEST_GAME_STRUCTURE_PROMPT = `## Quest game authoring (Context_QuestGame)

A quest game open in the panel lives at \`/Context_QuestGame\` as { appId, name, contentPack }.
You author and edit it with manageMemory ops on \`/Context_QuestGame/contentPack/...\`, exactly like
editing a board. ALWAYS \`view\` the field first so you edit the real structure.

### The goal grammar
\`contentPack.root\` is a recursive goal tree. A game is built from four node types — every node has a
unique \`id\` and a \`type\`, plus only the fields for that type:
- \`reach\`    — travel to \`markerEntityId\` (a marker/character). Optional \`via\` (obstacles on the way).
- \`collect\`  — gather \`count\` of \`itemEntityIds\` (the category). Optional \`distractorEntityIds\`,
               \`placements\` (groups whose counts sum to \`count\`), \`via\`.
- \`choose\`   — \`posedByEntityId\` asks \`prompt\`; \`options\` has 2..${CHOOSE_MAX_OPTIONS}, EXACTLY ONE
               \`correct: true\`. This is the curriculum carrier (questions, matching, vocabulary).
- \`overcome\` — a lock on \`obstacleEntityId\` whose \`key\` is ANY node (the sub-goal that clears it).
               \`overcome\` nodes appear ONLY inside a \`via\` list or as another node's \`key\`.

Nesting composes these (reach the picnic → bridge out (overcome) → collect 3 logs → one log gated →
choose the matching key). \`overcome\` resolves by satisfaction, never violence: no combat, no fail
states, wrong \`choose\` picks just give \`feedback\` and retry.

### Writing good questions (choose nodes) — READ THIS
Each option is a BUTTON that shows the referenced entity's label + icon. So the options ARE the
answer choices, and \`correct:true\` must mark the option that genuinely answers \`prompt\`.
- The answer choices almost always need their OWN entities. If the answers are words/concepts that
  aren't physical things already in the game (e.g. "igneous"/"sedimentary"/"metamorphic", "3"/"5",
  "happy"/"sad", "circle"/"square"), CREATE one entity per choice (kind: item or marker) whose
  \`label\` is that answer text, with a fitting \`iconRef\`, and reference those.
- NEVER reuse unrelated items as answers. A question "What type of rock is granite?" must offer
  rock-type answers (igneous / sedimentary / metamorphic) — NOT Ruby/Sapphire/Emerald. If you catch
  yourself marking an unrelated item "correct" just because it's the only entity available, STOP and
  create proper answer entities.
- Sanity-check every choose: read \`prompt\`, read each option's entity label, and confirm the
  \`correct:true\` one is the real answer and the others are plausible-but-wrong on-topic distractors.
- Always write a short \`feedback\` on each WRONG option (gentle hint, in meta.locale).

### Common mistakes the validator rejects (avoid these)
- **\`via\` must contain ONLY \`overcome\` nodes.** To gate a path with a question or fetch-quest, do NOT
  put a \`choose\`/\`collect\` node directly in \`via\` — wrap it: \`via: [{ type:"overcome", obstacleEntityId,
  key: { type:"choose", … } }]\`.
- **\`choose\` options carry only \`entityId\`/\`correct\`/\`feedback\`** — no \`label\`/\`text\`. The button shows
  the referenced entity's label + icon; put the wording on the ENTITY (\`entities[].label\`).
- **Entities have only**: \`id\`, \`kind\`, \`label\`, \`spokenLabel?\`, \`iconRef?\`, \`imageKey?\`, \`tags?\`, \`lines?\`.
  There is NO entity \`description\`.
- **\`engine\`/\`engineVersion\` are managed automatically** — never set or remove them; build only \`meta\`,
  \`entities\`, and \`root\`.

### Entities
Everything a node references (markers, items, characters, obstacles) must be defined in
\`contentPack.entities\` with a matching \`id\` and the right \`kind\`. Give each a fitting \`iconRef\` emoji.

### Rules
- All player-facing text (labels, prompts, narration, feedback) is written in \`meta.locale\`.
- ids: letters/digits/underscore, must start with a letter or underscore; unique within their scope.
- Limits: ≤ ${GOAL_TREE_MAX_NODES} nodes, depth ≤ ${GOAL_TREE_MAX_DEPTH}, ≤ ${GOAL_TREE_MAX_ENTITIES} entities,
  collect count ≤ ${COLLECT_MAX_COUNT}.
- Do NOT add fields that don't belong to a node's \`type\` — the validator rejects extras.

### Workflow
1. If NO game is open, call createQuestGame ONCE to open a tiny valid starter. If a game is already
   open, just edit it; do NOT call createQuestGame again (it spawns a duplicate game).
2. \`view /Context_QuestGame/contentPack\`, then build the game by setting \`meta\`, \`entities\`, and \`root\`
   via manageMemory. Prefer editing those sub-paths over replacing the whole \`contentPack\`. Compose
   entities BEFORE the nodes that reference them.
3. Call **validateQuestGame** before telling the user the game is ready. If it returns errors, fix them
   and validate again; keep iterating until it certifies. A successful validateQuestGame SAVES the game
   automatically, so once it returns ok the game is persisted and ready to play.`;
