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
  /** True when the Word Finder narrowing session is currently active.
   *  Adds `exit_guessing` to the tool surface so the AI can declare
   *  convergence and return to normal conversation. */
  guessingActive?: boolean;
}

// ---------------------------------------------------------------------------
// Shared button-object schema (used by rebuild_board, add_context_button,
// show_binary_choice option1/option2)
// ---------------------------------------------------------------------------

/** One GLYPH object in a `glyph` array — reused for button glyphs and contrast
 *  pole glyphs. A head SYMBOL (`sym`) OR a generate key (`gen`+`fb`), + mods. */
function glyphItemSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sym: {
        type: "string",
        description: `Head SYMBOL. Preference order: a raw emoji (🍎, 🤗 — the DEFAULT for concrete nouns) or a canonical key from <bundled_icons> (pronouns, abstract verbs, times, deictics); \`symbol:ID\` / \`face:ID\` for this user's custom symbols/faces (FIRST choice when one fits). Provide EITHER \`sym\` OR \`gen\`.`,
      },
      gen: {
        type: "string",
        description: `LAST RESORT — generate an image for a concrete object the vocabulary can't express (lowercase_snake_case, NO \`generate:\` prefix, e.g. "planet_mars"). Requires \`fb\`. Don't use when an emoji/modifier already captures it (a red apple is \`{sym:"🍎",mods:["color_red"]}\`, not gen).`,
      },
      mods: {
        type: "array",
        items: { type: "string" },
        description: `MODIFIER keys from <bundled_icons> only (e.g. "color_red", "big", "two", "my", "please"). Stack as needed. NEVER invent modifiers ("new"/"sad"/"scary" render as a dot) — use an emoji that encodes the quality, or put it in \`speech\` only.`,
      },
      fb: {
        type: "object",
        description: `Fallback for a \`gen\` GLYPH — shown while the image generates and if it fails. emoji/canonical-key/symbol:ID/face:ID + canonical mods only; NEVER \`gen\`. A deliberately weaker approximation (gen:"planet_mars" → fb:{sym:"🌑",mods:["color_red"]}).`,
        properties: {
          sym: { type: "string" },
          mods: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}

function buttonObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      speech: {
        type: "string",
        description: `Natural-language SENTENCE the TTS voices when this ${T.button} is pressed. First-person, conversational (e.g. "I want some water", "I'm tired"). What the user is SAYING when they press the ${T.button}. Ignored when \`button_type\` is set — those buttons are META actions, not utterances.`,
      },
      glyph: {
        type: "array",
        description: `PREFERRED visual encoding for the ${T.button}: 1–3 GLYPHs, rendered left→right. Use this INSTEAD of the legacy \`sentence\` string. Each GLYPH is an object with a head SYMBOL and optional modifiers. Match the count to meaning — one-word answers/feelings are 1 GLYPH; full subject+verb+object thoughts are up to 3. Ignored when \`button_type\` is set.`,
        items: glyphItemSchema(),
      },
      op: {
        type: "string",
        enum: ["past", "future", "question"],
        description: `OPTIONAL sentence-level OPERATOR for the whole ${T.button} — conjugate \`speech\` to match; the visual is unchanged.`,
      },
      kind: {
        type: "string",
        enum: ["narrow", "contrast", "guess"],
        description: `WORD FINDER only. The narrowing role of this ${T.button} (see <guessing_mode>):\n  - "narrow": an AI-proposed narrowing step. Set \`dimension\` (short axis label, e.g. "genre") + \`value\` (the option, also the shown label). Use a SHARED \`dimension\` across the batch.\n  - "contrast": an "is it closer to A or B?" choice. Set \`dimension\` + \`poles\` (2+). The system renders one ${T.button} per pole.\n  - "guess": a candidate WORD. Set \`value\` (the word) — or just \`speech\`/\`label\` — when narrowing has converged.\nOmit \`kind\` for a normal ${T.button} and for registry \`suggestion:\` keys (those go in \`label\`).`,
      },
      dimension: {
        type: "string",
        description: `For kind "narrow"/"contrast": a short human-readable narrowing axis ("genre", "time of day", "feel"). Internal metadata — not shown.`,
      },
      value: {
        type: "string",
        description: `For kind "narrow"/"guess": the value/word the user picks (becomes the visible label).`,
      },
      poles: {
        type: "array",
        description: `For kind "contrast": the 2+ poles of the choice. Each pole is { value (shown), speech? (voiced + recorded clue, defaults to value), glyph? (visual GLYPH array) }.`,
        items: {
          type: "object",
          properties: {
            value: { type: "string" },
            speech: { type: "string" },
            glyph: { type: "array", items: glyphItemSchema() },
          },
        },
      },
      sentence: {
        type: "string",
        description: `LEGACY string form of \`glyph\` (prefer \`glyph\`). GLYPHs joined by \`+\`, modifiers with \`.\`, operators with \`#\` (e.g. \`i_me+want+🍎.color_red\`). Ignored when \`glyph\` or \`button_type\` is set.`,
      },
      fallback: {
        type: "string",
        description: `LEGACY string fallback paired with \`sentence\` (prefer per-GLYPH \`fb\` in \`glyph\`). Required when \`sentence\` uses \`generate:\`, omitted otherwise.`,
      },
      label: {
        type: "string",
        description: `Short text shown on the ${T.button} face. In the user's language. Not voiced — the \`speech\` field is voiced; this is the on-button text the user sees. Ignored when \`button_type\` is set (those buttons have a fixed system-rendered label).`,
      },
      rowSpan: {
        type: "integer",
        description: "Optional. Number of grid rows this button spans (>=2). Omit for a 1×1 button.",
      },
      colSpan: {
        type: "integer",
        description: "Optional. Number of grid columns this button spans (>=2). Omit for a 1×1 button.",
      },
      button_type: {
        type: "string",
        enum: ["wordfinder", "more"],
        description: `OPTIONAL. Special button kind for META actions (NOT a SENTENCE the user voices). When set, the system renders a FIXED appearance (icon, color, label) and the \`speech\` / \`sentence\` / \`fallback\` / \`label\` fields are ignored. Only meaningful on rebuild_board and add_board_button (the main ${T.board}); ignored on add_context_button and show_binary_choice. Available values:\n  - "wordfinder" — a Word Finder entry. Add this when the user seems to be reaching for a specific concrete CONCEPT (a thing, a place, a person, an activity, an object they want to name) but it would be impractical to guess what it is — too many plausible candidates, or no signal narrow enough to enumerate them. Pressing it opens a narrowing assistant that asks targeted questions until the concept surfaces. NOT for genuinely open-ended chitchat ("how are you?" — there's nothing to "find").\n  - "more" — adds a [MORE] button. Add this when you suspect the user might want OTHER options on the same topic than the ones you offered. Looks and behaves identically to the [MORE] in the quick-actions row: pressing it asks for fresh alternatives, no voiced utterance.\n\nWhen using \`button_type\`, you may pass placeholder values (or empty strings) for speech / sentence / label — they're discarded.`,
      },
    },
    // `glyph` (preferred) OR legacy `sentence` supplies the visual; neither is
    // hard-required at the schema level so glyph-only buttons validate.
    required: ["speech", "label"],
  };
}

function rebuildBoardButtonsDescription(config: BoardManagerToolConfig): string {
  const language = config.language;
  const singleGlyph = !!config.singleGlyphButtons;
  const exampleA = ex("tool.sbf_speech_water", language);
  const exampleB = ex("tool.sbf_speech_three_glyph_banana", language);
  const exampleC = singleGlyph ? "" : `One-word answers and feelings are 1-glyph (${ex("tool.sbf_speech_one_glyph_tired", language)}); full subject+verb+object thoughts are 3-glyph (${exampleB}). Don't pad. `;
  return `Up to 8 ${T.button}s for the ${T.board}. Provide a WIDE VARIETY of options. Each ${T.button} is one object with \`speech\` (voiced SENTENCE, e.g. ${exampleA}), \`glyph\` (the visual encoding — an array of 1–3 GLYPH objects), and \`label\` (on-button text). ${exampleC}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildRebuildBoardTool(config: BoardManagerToolConfig): FunctionDeclaration {
  return {
    name: "rebuild_board",
    description:
      `Replace the ${T.board} with up to 8 fresh ${T.button}s. Use whenever the user just acted (${T.tagPress}, ${T.tagComposed}, transcribed speech) or someone spoke to them — they need response options.

The \`target\` field declares who the user's button replies are addressed to. Default "DEVICE" (the user is talking to the AI). Set to a person's name or "USER" when the buttons reply to someone in the room (e.g. a teacher just asked the user a question — target=Teacher).`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: {
          type: "array",
          description: rebuildBoardButtonsDescription(config),
          items: buttonObjectSchema(),
        },
        target: {
          type: "string",
          description: `Who the buttons are addressed to. "DEVICE" (default — user is talking to the AI), "USER" (user is talking to themselves), or a specific person's name (when replying to someone in the room).`,
        },
      },
      required: ["buttons"],
    },
  };
}

function buildAddBoardButtonTool(config: BoardManagerToolConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 8;
  return {
    name: "add_board_button",
    description:
      `Add ONE ${T.button} to the CURRENT ${T.board} without replacing the whole board. Use when one new option naturally extends the conversation but the existing options still apply — e.g. you want to surface "I'm not sure" alongside the existing yes/no/maybe answers. The server merges the button in: an exact duplicate is collapsed; if the board is at the ${max}-button cap, the new button DISPLACES the most-similar existing one (label/glyph/sentence overlap) in place. Do NOT call this multiple times in one turn to assemble a board from scratch — use rebuild_board for that. Use add_board_button when you genuinely want incremental extension of an existing surface.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        button: buttonObjectSchema(),
        target: {
          type: "string",
          description: `Who this button's reply is addressed to. "DEVICE" (default), "USER", or a specific person's name. Same semantics as rebuild_board's target.`,
        },
      },
      required: ["button"],
    },
  };
}

function buildAddContextButtonTool(): FunctionDeclaration {
  return {
    name: "add_context_button",
    description:
      `Add ONE ${T.button} to the context sidebar (left, 4 visible slots). Use when Observer has noted something new in the environment — a nearby object, person, or activity the user might want to interact with. The sidebar scrolls: the oldest ${T.button} is pushed out when full. Do NOT duplicate ${T.board} labels.

NOTE: this is the SIDEBAR (left strip, ambient observations), NOT the main board. To add a button to the main response board, use add_board_button() instead.`,
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

/**
 * `interpret` — voice a user-composed SENTENCE through the student's TTS.
 *
 * Called ONLY in response to a [SENTENCE COMPOSED] turn (the user
 * pressed Play in the SENTENCE BUILDER). You read the symbol-by-symbol
 * SENTENCE the user composed and produce the natural first-person line
 * they meant to say. The system pipes it through the student-voice TTS
 * so the room hears the SENTENCE in the user's voice.
 *
 * After interpret() runs, a follow-up [BUTTON PRESS] with your
 * interpreted text routes to Speaker for the AI reply — you don't need
 * to do anything else on that turn beyond emitting this tool call.
 *
 * NEVER call interpret() on a regular [BUTTON PRESS] (those already
 * carry a pre-baked SENTENCE that TTS plays automatically) or
 * spontaneously. The Coordinator gates this server-side and will drop
 * a stray call.
 */
function buildInterpretTool(): FunctionDeclaration {
  return {
    name: "interpret",
    description:
      `Voice a natural-language SENTENCE through the USER'S TTS voice. Call this ONLY in response to a ${T.tagComposed} turn — never spontaneously, and never on a regular ${T.tagPress} (those carry a pre-baked SENTENCE the device already voices). The 'sentence' argument MUST be first-person, as the user would say it ("I want a banana", "I'm tired and I want a hug from Mom"), and MUST follow the <sentence_interpretation> rules — read the composed SENTENCE creatively using the user's interests, don't echo individual SYMBOLs. After interpret() finishes, the system delivers your interpreted text to Speaker as a [${T.tagPress}] follow-up — you don't need to do anything else for that turn.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        sentence: {
          type: "string",
          description: "The user's intended SENTENCE in their voice. First-person, natural language. Do not include the raw composed-sentence string.",
        },
      },
      required: ["sentence"],
    },
  };
}

function buildShowBinaryChoiceTool(): FunctionDeclaration {
  return {
    name: "show_binary_choice",
    description:
      `Show two large overlay ${T.button}s on the device. Use when the user is being offered a choice between two options — either a binary choice ("apple or banana?", or someone holds up two objects) OR a yes/no question. For yes/no, use the canonical \`yes\` / \`no\` SYMBOLs in each option's \`sentence\` field — they render with the animated yes/no icons and default green/red coloring. A "Neither" button is added automatically. Do NOT use for open-ended questions — use rebuild_board() for those.

Each option is a button object: \`speech\` (TTS), \`sentence\` (visual), \`fallback\` (when sentence uses \`generate:\`), \`label\`. The \`target\` field declares who the user's choice is addressed to — same semantics as on rebuild_board.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        option1: buttonObjectSchema(),
        option2: buttonObjectSchema(),
        target: {
          type: "string",
          description: `Who the choice is addressed to. "DEVICE" (default), "USER", or a person's name.`,
        },
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

/**
 * `exit_guessing` — declare that the Word Finder session is over.
 *
 * Available ONLY while guessing mode is active. The Coordinator calls
 * clearGuessingState on receipt, which:
 *   - flips the client's guessingMode flag (the violet highlight clears)
 *   - tells Speaker to drop narrowing questions
 *   - re-invokes BoardManager with a clean "rebuild for conversation"
 *     trigger so the next surface isn't stuck on suggestion buttons
 */
function buildExitGuessingTool(): FunctionDeclaration {
  return {
    name: "exit_guessing",
    description:
      `End the Word Finder narrowing session and return the device to normal conversation. Use this when:
- The user just confirmed your guess (e.g., pressed "yes" to "is it X?" — you found their word).
- The conversation has clearly moved past finding a word (the user is talking about something unrelated now).
- You can speak confidently about what the user meant based on accumulated narrowing facts, and further narrowing would just frustrate them.

Do NOT call this just because narrowing is hard. The Word Finder is supposed to grind through dimensions until it converges; call exit ONLY when convergence has actually happened or the user has redirected. Calling this prematurely loses the narrowing state and resets the search.

Pair this call with a rebuild_board on the NEXT invocation that reflects the resolved topic (the user is going to talk ABOUT what was just found, so build buttons for that conversation).`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: `Short phrase describing why guessing is ending. Examples: "user confirmed comet", "user said yes to black hole", "user changed topic to school".`,
        },
      },
      required: ["reason"],
    },
  };
}

const NO_CHANGE: FunctionDeclaration = {
  name: "no_change",
  description:
    `Declare that the current ${T.board} is still appropriate and no update is needed for this event. Use this often — most observational events do not call for the ${T.board} to change. This is also the UNIVERSAL FALLBACK: if you're unsure what to do, or no other tool fits, call no_change with a short reason. NEVER return without a tool call — silent responses fail. Calling no_change() explicitly is always preferred over rebuilding identically or returning nothing.`,
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
  declarations.push(buildAddBoardButtonTool(config));
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
  declarations.push(buildInterpretTool());
  // Only surface exit_guessing while the Word Finder is active — outside
  // guessing mode, the tool would be a no-op and waste tool-surface area.
  if (config.guessingActive) {
    declarations.push(buildExitGuessingTool());
  }
  declarations.push(NO_CHANGE);

  // call_monitor only — private_note intentionally omitted.
  declarations.push(CALL_MONITOR);

  return [{ functionDeclarations: declarations }];
}
