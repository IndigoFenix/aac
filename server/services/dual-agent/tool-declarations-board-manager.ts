// server/services/dual-agent/tool-declarations-board-manager.ts
//
// Board Manager Agent tool surface for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Buttons are delivered as a STRUCTURED ARRAY of objects — one object per
// button — not the legacy pipe-encoded string. The data shape is the same
// as the legacy `speech|sentence|fallback|label` format: each button
// carries (1) a `speech` string the TTS voices, (2) a `sentence` visual
// encoding made of SYMBOLs and GLYPHs, (3) a `fallback` REQUIRED whenever
// `sentence` uses any `generate:` SYMBOL and OMITTED otherwise, (4) a
// `label` shown on the button face.
//
// Canonical-terms (T) are referenced verbatim from the prompt and tool
// descriptions so the model sees one consistent vocabulary.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import { ex } from "../memory-schema/prompt-examples";
import { T } from "../memory-schema/canonical-terms";
import {
  CALL_MONITOR,
} from "./tool-shared";

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface BoardManagerToolConfig {
  /** Pre-built custom boards available to load via set_board(). */
  availableBoards: Array<{ key: string; name: string }>;
  /** Currently-loaded custom board name, for the set_board description. */
  loadedBoardName?: string | null;
  /** True when a custom board is currently loaded — enables press_button. */
  hasLoadedBoard: boolean;
  /** Grid slot count (default 12). */
  maxBoardItems?: number;
  /** Student's primary language code, for localized example strings inside
   *  tool descriptions. */
  language?: string;
  /** When true, every button must carry a single GLYPH (modifiers OK).
   *  Drives the format hints embedded in button-shaped tool descriptions. */
  singleGlyphButtons?: boolean;
}

// ---------------------------------------------------------------------------
// Shared button-object schema (used by rebuild_board, add_context_button,
// show_binary_choice option1/option2)
// ---------------------------------------------------------------------------

function buttonObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      speech: {
        type: "string",
        description: `Natural-language SENTENCE the TTS voices when this ${T.button} is pressed. First-person, conversational (e.g. "I want some water", "I'm tired"). What the user is SAYING when they press the ${T.button}.`,
      },
      sentence: {
        type: "string",
        description: `Visual encoding for the ${T.button}: up to 3 GLYPHs joined by \`+\`, MODIFIER SYMBOLs attached with \`.\`, sentence-level OPERATORs (\`#past\`, \`#future\`, \`#question\`) appended with \`#\`. Each SYMBOL is one of: a canonical registry key from <bundled_icons>, a raw emoji (🍎, 🤗 — the DEFAULT for anything not in <bundled_icons>), \`symbol:ID\` / \`face:ID\`, or \`generate:lowercase_snake_case\` (LAST RESORT, async-generated). NEVER emit bare unknown snake_case (\`talk_about\`, \`my_day\`) — it renders as ❓ until generation completes. Use MODIFIER SYMBOLs when the SENTENCE carries detail: \`🍎.color_red\`, \`🤗.big.please\`, \`🍪.two\`.`,
      },
      fallback: {
        type: "string",
        description: `Visual encoding shown IMMEDIATELY while a \`generate:\` SYMBOL is being produced (and as the permanent visual if generation fails). REQUIRED whenever \`sentence\` contains any \`generate:\` SYMBOL; OMIT this field entirely otherwise. May only use: emojis, canonical registry keys, \`symbol:ID\` / \`face:ID\`, canonical modifiers. NEVER contains \`generate:\` and NEVER contains a non-canonical modifier (\`.new\`, \`.old\`, \`.sad\`, etc.). Mirror the SHAPE of the \`sentence\` field — pair an existing emoji with a canonical modifier to approximate the generated concept (\`generate:planet_mars\` → \`🌑.color_red\`).`,
      },
      label: {
        type: "string",
        description: `Short text shown on the ${T.button} face. In the user's language. Not voiced — the \`speech\` field is voiced; this is the on-button text the user sees.`,
      },
      rowSpan: {
        type: "integer",
        description: "Optional. Number of grid rows this button spans (>=2). Omit for a 1×1 button.",
      },
      colSpan: {
        type: "integer",
        description: "Optional. Number of grid columns this button spans (>=2). Omit for a 1×1 button.",
      },
    },
    required: ["speech", "sentence", "label"],
  };
}

function rebuildBoardButtonsDescription(config: BoardManagerToolConfig): string {
  const language = config.language;
  const singleGlyph = !!config.singleGlyphButtons;
  const exampleA = ex("tool.sbf_speech_water", language);
  const exampleB = ex("tool.sbf_speech_three_glyph_banana", language);
  const exampleC = singleGlyph ? "" : `One-word answers and feelings are 1-glyph (${ex("tool.sbf_speech_one_glyph_tired", language)}); full subject+verb+object thoughts are 3-glyph (${exampleB}). Don't pad. `;
  return `Up to 8 ${T.button}s for the ${T.board}. Provide a WIDE VARIETY of options. Each ${T.button} is one object with \`speech\` (voiced SENTENCE, e.g. ${exampleA}), \`sentence\` (visual encoding), \`fallback\` (required when sentence uses \`generate:\`, OMITTED otherwise), and \`label\` (on-button text). ${exampleC}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildRebuildBoardTool(config: BoardManagerToolConfig): FunctionDeclaration {
  return {
    name: "rebuild_board",
    description:
      `Replace the ${T.board} with a fresh set of ${T.button}s (up to 8). Use after ${T.tagPress} inputs or major conversation shifts. Provide a WIDE VARIETY of options.

The ${T.button}s are the USER's responses — what they can press to reply or take initiative. NEVER put the AI's own questions or statements into these — Speaker handles all spoken output independently.

If a custom board is currently loaded, calling this unloads it and replaces it with your new dynamic ${T.board}. The context sidebar (left) is separate — use add_context_button() for that. Don't reuse the same \`generate:\` ${T.symbol} more than once on one ${T.board}.

If the current ${T.board} is still appropriate for the situation, call no_change() instead of rebuilding redundantly.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        [T.paramUserResponseButtons]: {
          type: "array",
          description: rebuildBoardButtonsDescription(config),
          items: buttonObjectSchema(),
        },
      },
      required: [T.paramUserResponseButtons],
    },
  };
}

function buildAddContextButtonTool(): FunctionDeclaration {
  return {
    name: "add_context_button",
    description:
      `Add ONE ${T.button} to the context sidebar (left, 4 visible slots). Use when Observer has noted something new in the environment — a nearby object, person, or activity the user might want to interact with. The sidebar scrolls: the oldest ${T.button} is pushed out when full. Do NOT duplicate ${T.board} labels.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        button: buttonObjectSchema(),
      },
      required: ["button"],
    },
  };
}

function buildSetBoardTool(config: BoardManagerToolConfig): FunctionDeclaration {
  const boardList = config.availableBoards.map(b => `"${b.key}" (${b.name})`).join(", ");
  const loadedNote = config.loadedBoardName
    ? ` Currently loaded: "${config.loadedBoardName}" — do NOT re-select it.`
    : "";
  return {
    name: "set_board",
    description:
      `Switch to a pre-built custom ${T.board}. Available: ${boardList}.${loadedNote} Prefer this over rebuild_board() when a custom ${T.board} fits the current activity.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        board_key: {
          type: "string",
          description: `Board key to load. One of: ${config.availableBoards.map(b => `"${b.key}"`).join(", ")}.`,
        },
      },
      required: ["board_key"],
    },
  };
}

function buildPressButtonTool(): FunctionDeclaration {
  return {
    name: "press_button",
    description:
      `Press a navigation ${T.button} on the current custom ${T.board} to go to a sub-page. Prefer navigating to sub-pages over generating new ${T.button}s from scratch.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: `Label of the navigation ${T.button} to press.` },
      },
      required: ["label"],
    },
  };
}

function buildShowBinaryChoiceTool(): FunctionDeclaration {
  return {
    name: "show_binary_choice",
    description:
      `Show two large overlay ${T.button}s on the device. Use when the user is being offered a choice between two options — either a binary choice ("apple or banana?", or someone holds up two objects) OR a yes/no question. For yes/no, use the canonical \`yes\` / \`no\` SYMBOLs in each option's \`sentence\` field — they render with the animated yes/no icons and default green/red coloring. A "Neither" button is added automatically. Do NOT use for open-ended questions — use rebuild_board() for those.

Each option is a button object with the same fields as a rebuild_board button: \`speech\` (what TTS voices), \`sentence\` (visual encoding), \`fallback\` (required when sentence uses \`generate:\`), \`label\`.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        option1: buttonObjectSchema(),
        option2: buttonObjectSchema(),
      },
      required: ["option1", "option2"],
    },
  };
}

// ---------------------------------------------------------------------------
// suggest_construction_buttons — SUGGESTIONs are single SYMBOLs, not full
// SENTENCEs, so the object shape is narrower (no speech).
// ---------------------------------------------------------------------------

function buildSuggestionObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: `ONE SYMBOL — a canonical registry key from <bundled_icons>, a raw emoji, \`symbol:ID\` / \`face:ID\`, or \`generate:lowercase_snake_case\` (last resort, requires \`fallback\`).`,
      },
      fallback: {
        type: "string",
        description: `REQUIRED when \`symbol\` is a \`generate:\` key; OMIT otherwise. Must NEVER contain \`generate:\`. An emoji, canonical registry key, \`symbol:ID\`, or \`face:ID\`.`,
      },
      label: {
        type: "string",
        description: "Short display label for this SUGGESTION (in the user's language).",
      },
    },
    required: ["symbol", "label"],
  };
}

function buildSuggestConstructionButtonsTool(): FunctionDeclaration {
  return {
    name: "suggest_construction_buttons",
    description:
      `Populate the ${T.builder}'s AI strips with SUGGESTIONs for the user to tap. Call this in response to a ${T.tagBuilderState} context — never spontaneously.

**Each SUGGESTION is exactly one SYMBOL** — never a multi-symbol GLYPH or SENTENCE. SUGGESTIONs come in TWO arrays:

- \`head_candidates\` (up to 4) — each is a HEAD SYMBOL for the NEXT GLYPH in the SENTENCE (\`🐕\`, \`mom\`, \`generate:seagull\`). Feeds the main AI strip; tapping fills the next glyph slot.
- \`modifier_candidates\` (up to 4) — each is a MODIFIER SYMBOL that attaches to the user's CURRENT HEAD SYMBOL (\`color_red\`, \`my\`, \`big\`, \`two\`, \`very\`, \`please\`). Feeds a parallel AI-modifier strip.

Fill BOTH arrays when useful. Empty either array when nothing fits. If BOTH would be empty, call \`no_change()\` instead.

Each SUGGESTION is an object: \`{ symbol, fallback?, label }\`. \`symbol\` is the ONE SYMBOL. \`fallback\` is REQUIRED when \`symbol\` is a \`generate:\` key, OMITTED otherwise. \`label\` is the short display text.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        slot_index: {
          type: "integer",
          description: `Which builder position the head SUGGESTIONs target. Use the \`targetSlot\` value from the ${T.tagBuilderState} injection. Use 0 if uncertain.`,
        },
        head_candidates: {
          type: "array",
          description: "Up to 4 head SYMBOL SUGGESTION objects.",
          items: buildSuggestionObjectSchema(),
        },
        modifier_candidates: {
          type: "array",
          description: "Up to 4 modifier SYMBOL SUGGESTION objects.",
          items: buildSuggestionObjectSchema(),
        },
      },
      required: ["slot_index"],
    },
  };
}

function buildSetMemoryChipsTool(): FunctionDeclaration {
  return {
    name: "set_construction_memory_chips",
    description:
      `Update the memory-driven mode chips on the ${T.builder} for one category tab. 0–3 chips surface the user's special interests, recent conversation topics, or context-relevant filters. Pass an empty array to clear.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["who", "do", "what", "where", "when"],
          description: "Which tab these chips apply to.",
        },
        chips: {
          type: "array",
          description: "Up to 3 chips. Replaces any prior memory chips for this category.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Stable snake_case key." },
              label: { type: "string", description: "Short display label (2–3 words)." },
            },
            required: ["key", "label"],
          },
        },
      },
      required: ["category", "chips"],
    },
  };
}

const NO_CHANGE: FunctionDeclaration = {
  name: "no_change",
  description:
    `Declare that the current ${T.board} is still appropriate and no update is needed for this event. Use this often — most observational events do not call for the ${T.board} to change. Calling no_change() explicitly is preferred over rebuilding identically.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Brief reason the current surface is still appropriate.",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildBoardManagerToolDeclarations(config: BoardManagerToolConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  declarations.push(buildRebuildBoardTool(config));
  declarations.push(buildAddContextButtonTool());

  if (config.availableBoards.length > 0) {
    declarations.push(buildSetBoardTool(config));
  }
  if (config.hasLoadedBoard) {
    declarations.push(buildPressButtonTool());
  }

  declarations.push(buildShowBinaryChoiceTool());
  declarations.push(buildSuggestConstructionButtonsTool());
  declarations.push(buildSetMemoryChipsTool());
  declarations.push(NO_CHANGE);

  // call_monitor only — private_note intentionally omitted.
  declarations.push(CALL_MONITOR);

  return [{ functionDeclarations: declarations }];
}
