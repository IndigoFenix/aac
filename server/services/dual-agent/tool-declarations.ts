// server/services/dual-agent/tool-declarations.ts
// Function declarations for live API native function calling.
// Uses Gemini FunctionDeclaration format with OpenAPI Schema (parameters field).
//
// IMPORTANT: Vertex AI Live API requires `parameters` (OpenAPI Schema with Type enum),
// NOT `parametersJsonSchema` (JSON Schema format). The SDK may not convert between
// them for the Live WebSocket API, causing the model to receive tools without schemas
// and produce empty turns.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import type { AACAppDefinition } from "./types";
import type { PermittedWebsite } from "@shared/schema";
import { flattenPermittedWebsites } from "@shared/permitted-websites";
import { ex } from "../memory-schema/prompt-examples";
import { T } from "../memory-schema/canonical-terms";

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface ToolDeclarationConfig {
  enabledApps: AACAppDefinition[];
  availableBoards: Array<{ key: string; name: string }>;
  /** Custom apps (games) assigned to this user. */
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  hasLoadedBoard: boolean;
  faceRecognitionActive: boolean;
  cachedSymbols?: Array<{ id: string; name: string }>;
  isMutedMode?: boolean;
  /**
   * RESTING-mode minimal tool set. When true, buildToolDeclarations returns
   * ONLY the four tools the model needs while the session is resting:
   * wake_up, transcript, update_context, private_note (+ speak when not
   * useDirectAudio, so it can answer a direct question briefly). Everything
   * board/conversation-related is omitted — see buildRestingAgentPrompt.
   */
  restingMode?: boolean;

  // Enriched context for detailed tool descriptions
  maxBoardItems?: number;
  loadedBoardName?: string | null;
  loadedPageNavButtons?: Array<{ label: string; targetPageName?: string }>;
  customBoardFixedButtons?: string[];
  customBoardAiAddedButtons?: string[];
  currentEmote?: string;
  activeApp?: string | null;
  /** When true, the model speaks directly via native audio — speak() tool is omitted */
  useDirectAudio?: boolean;
  /** Websites the AI is permitted to open via the browser app. */
  permittedWebsites?: PermittedWebsite[];
  /**
   * Student's primary language code (e.g. `"he"`, `"en"`). Used to localize
   * the example strings embedded in tool descriptions — same translation
   * system as the system prompt (see prompt-examples.ts). Falls back to
   * English when unset or unknown.
   */
  language?: string;
}

// ---------------------------------------------------------------------------
// Button format description (shared by add_buttons and rebuild_board)
// ---------------------------------------------------------------------------

// Field-by-field description of one ${T.button}. Comma-joined to form a
// list. The inline example phrases ("I want water", "I want a banana", etc.)
// are localized via prompt-examples.ts — same translation system as the
// system prompt — to keep the model's audio language consistent. The
// analytical description text itself stays English (documentation).
// See <grammar> and <button_syntax> in the system prompt for the full spec.
function sentenceButtonFormat(language: string | undefined): string {
  return (
    "Each ${T.button} is four pipe-separated fields: speech|sentence|fallback|label. " +
    `(1) speech — natural-language SENTENCE the TTS voices when pressed (first-person, conversational, e.g. ${ex("tool.sbf_speech_water", language)}). ` +
    "(2) sentence — visual encoding: GLYPHs joined by `+`, MODIFIER SYMBOLs attached with `.`, sentence-level OPERATORs appended with `#`. " +
    "Each SYMBOL is one of: a canonical registry key from <bundled_icons>, a raw emoji (🍎, 🤗 — default for anything not in <bundled_icons>), `symbol:ID` / `face:ID`, or `generate:lowercase_snake_case` (last resort, async-generated). " +
    "(3) fallback — a `sentence` string using NO `generate:` SYMBOLs (only canonical keys, emojis, `symbol:ID`, `face:ID`). REQUIRED whenever `sentence` uses any `generate:` SYMBOL; OMIT this field entirely (empty: `||`) otherwise. " +
    "(4) label — short on-button text. " +
    "**Snake_case rule:** if a word isn't in <bundled_icons>, EITHER use an emoji, OR prefix with `generate:` AND provide a fallback. Never emit bare unknown snake_case (`talk_about`, `my_day`, `go_school`); it renders as ❓ until generation completes. " +
    "Use MODIFIER SYMBOLs when the SENTENCE carries detail (color/size/count/possession/intensity) — `🍎.color_red`, `🤗.big.please`, `🍪.two`. " +
    "Use OPERATORs for past/future/question — `i_me+go+🛝#past`. " +
    `Match GLYPH count to the SENTENCE shape: full subject+verb+object thoughts are 3-glyph SENTENCEs (${ex("tool.sbf_speech_three_glyph_banana", language)}); one-word answers and feelings are 1-glyph (${ex("tool.sbf_speech_one_glyph_tired", language)}). Don't pad. ` +
    "Optional trailing rowSpan|colSpan after the label."
  );
}

function buttonFormatAdd(language: string | undefined): string {
  return (
    "Comma-separated ${T.button}s (speech|sentence|fallback|label[|rowSpan|colSpan]). " +
    sentenceButtonFormat(language) +
    ` ${ex("tool.button_format_add_example", language)}`
  );
}

function buttonFormatRebuild(language: string | undefined): string {
  return (
    "Comma-separated ${T.button}s for the ${T.board} (speech|sentence|fallback|label[|rowSpan|colSpan]). " +
    sentenceButtonFormat(language) +
    " Aim to fill the ${T.board} (6–8 ${T.button}s) with a WIDE VARIETY of options unless context is unusually narrow. " +
    ex("tool.button_format_rebuild_example", language)
  );
}

// ---------------------------------------------------------------------------
// Tool factory functions
// ---------------------------------------------------------------------------

function buildSpeakTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "speak",
    description: `Say something to the user or people nearby (AI voice). A separate TTS system voices this — do NOT produce audio yourself. Use to greet, ask questions, comment on observations, or suggest activities. When you ask a question, ALWAYS also call rebuild_board() with answer ${T.button}s — the user cannot respond without them. Do NOT announce board changes or repeat yourself. When a ${T.tagPress} occurs, the user's SENTENCE is voiced automatically — do NOT repeat or paraphrase what the user said. Just respond naturally. Only call speak() once per turn.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak aloud." },
      },
      required: ["text"],
    },
  };
}

/**
 * `interpret` — voice on behalf of the user.
 *
 * Called ONLY in response to a ${T.tagComposed} turn (the user
 * composed a SENTENCE in the ${T.builder} and pressed Play). The model
 * produces the natural-language SENTENCE in first-person — what the user
 * would say if they could speak directly — and the relay:
 *   1. streams it through the user-voice TTS so the room hears the
 *      SENTENCE in the user's own voice;
 *   2. records it in the session log so the conversation history shows the
 *      user's spoken contribution rather than the raw composed sentence;
 *   3. lets the model continue the same turn with its normal speech path
 *      (speak() in tool-driven audio, or direct voice in native audio)
 *      and rebuild_board() to respond to that statement.
 *
 * This is the ONLY case where the AI voices anything on the user's
 * behalf. Do NOT call interpret() in response to a regular ${T.tagPress}
 * (those already carry a pre-generated SENTENCE and are TTS'd separately).
 */
function buildInterpretTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "interpret",
    description: `Voice a natural-language SENTENCE through the USER'S TTS voice. Call this ONLY in response to a ${T.tagComposed} turn — never spontaneously, and never in response to a regular ${T.tagPress} (those already have a pre-baked SENTENCE that TTS plays automatically). The 'sentence' argument MUST be first-person, as the user would say it ("I want a banana", "I'm tired and I want a hug from Mom"), and MUST follow the <sentence_interpretation> rules — read the composed SENTENCE creatively using user interests, don't echo individual SYMBOLs. After interpret() runs the user's TTS, the system delivers a follow-up ${T.tagPress} with the same sentence — you respond to THAT (speak + rebuild_board) on the next turn. Do NOT also try to speak or rebuild_board inside the interpret turn itself. Your reply audio is sequenced AFTER the user's TTS finishes so the room hears the user's voice first, then your reply — you don't need to time it yourself, the system holds your audio until the user voice is done.`,
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

function buildTranscriptTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "transcript",
    description: `Record clear speech you heard from a person nearby (someone speaking in their own voice through the room, not via the AAC device). Only transcribe when you can confidently identify words — ignore silence, ambient noise, unintelligible audio, and background conversations. DO NOT transcribe your own voice echoing back through the mic, and DO NOT transcribe the device's TTS playing back the ${T.button} the user pressed — both are device output, not new speech, and you already have the ${T.tagPress} text turn for the latter (respond to that turn normally, just don't call transcript() for the echo).`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The transcribed speech." },
        speaker: { type: "string", description: "Who spoke (e.g. 'Mom', 'Teacher', 'Unknown')." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Transcription confidence." },
      },
      required: ["text", "speaker"],
    },
  };
}

function buildContextTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "update_context",
    description: `Record a specific environmental observation. Log new people, audio, objects, locations, and events when you first notice them (including at the beginning of a new session). Do NOT narrate your own actions.

Types:
- new_person: Someone appears who you haven't seen this session.
- new_voice: A new voice is heard that you haven't heard this session.
- set_person_as_user: Identify which visible person is the primary user of this device.
- person_identified: You recognize a previously unknown person (e.g. learned their name).
- voice_identified: You recognize which person a previously unknown voice belongs to.
- person_leaves: A previously-present person has left the frame.
- new_location: The device appears to be in a new physical location/room.
- new_object: A notable object appears in view.
- object_leaves: A notable object is no longer in view.
- person_gesture: A person makes a meaningful gesture (pointing, waving, nodding).
- person_indicates_object: A person points at / looks at / otherwise indicates a specific object.
- ambient_audio_started: Background sound begins (music, TV, traffic, conversation).
- ambient_audio_stopped: Previously ongoing background sound has stopped.
- sound_detected: A discrete sound event (doorbell, crash, bark, alarm).
- other: Any other observation that doesn't fit the above.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "new_person", "new_voice", "set_person_as_user", "person_identified",
            "voice_identified", "person_leaves", "new_location", "new_object",
            "object_leaves", "person_gesture", "person_indicates_object",
            "ambient_audio_started", "ambient_audio_stopped", "sound_detected", "other",
          ],
          description: "The category of observation.",
        },
        key: { type: "string", description: "Short identifier for the subject (e.g. person name or description, object name, location name, sound name)." },
        description: { type: "string", description: "Detailed description of what you observed." },
      },
      required: ["type", "key", "description"],
    },
  };
}

function buildAddButtonsTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 12;
  return {
    name: "add_buttons",
    description: `Add ${T.button}s to the ${T.board}. Max ${max} total — call remove_buttons() first if full. Do not duplicate existing ${T.button}s or include Home/More (those are auto-added). You MAY include \`yes\` / \`no\` ${T.button}s when they help the conversation — they render with animated icons and default green/red coloring.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: { type: "string", description: buttonFormatAdd(config.language) },
      },
      required: ["buttons"],
    },
  };
}

function buildRemoveButtonsTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "remove_buttons",
    description: `Remove ${T.button}s from the ${T.board} by label. Use when items are no longer relevant or you need to make room for new ones.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels of ${T.button}s to remove.",
        },
      },
      required: ["labels"],
    },
  };
}

function buildRebuildBoardTool(config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "rebuild_board",
    description: `Replace the ${T.board} with a fresh set of ${T.button}s (up to 8). Use after ${T.tagPress} inputs or major conversation shifts. Provide a WIDE VARIETY of options.

IMPORTANT — TWO SPEAKERS, TWO PARAMETERS:
  • \`${T.paramOwnSpeech}\` is what YOU (the AI) say aloud in this turn — your spoken statement, your question, your reaction. Optional. NOT a TTS substitute: you still produce the audio via your voice; the text is your written commitment to speaking it.
  • \`${T.paramUserResponseButtons}\` is the list of ${T.button}s the USER will choose from to respond. These are the user's words, not yours. NEVER put your own questions or statements into these ${T.button}s.

If a custom board is currently loaded, calling this unloads it and replaces it with your new dynamic ${T.board}. The context sidebar (left) is separate — use add_context_button() for that. Don't reuse the same \`generate:\` ${T.symbol} more than once on one ${T.board}.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        [T.paramOwnSpeech]: {
          type: "string",
          description: `Optional. The AI's own spoken statement for this turn — what YOU are saying aloud. Speak the same words via your voice; this parameter is a declaration of your intent, not a TTS source. Useful for ${T.tagPress} responses (e.g. when the user presses 'I want to play' → \`${T.paramOwnSpeech}\`: 'Sure! What would you like to play with?'). The system logs this for monitoring and displays it as text in the UI alongside your spoken audio. Do NOT put user-response options here — those go in \`${T.paramUserResponseButtons}\`.`,
        },
        [T.paramUserResponseButtons]: { type: "string", description: buttonFormatRebuild(config.language) },
      },
      required: [T.paramUserResponseButtons],
    },
  };
}

function buildSetBoardTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const boardList = config.availableBoards.map(b => `"${b.key}" (${b.name})`).join(", ");
  const loadedNote = config.loadedBoardName
    ? ` Currently loaded: "${config.loadedBoardName}" — do NOT re-select it.`
    : "";

  return {
    name: "set_board",
    description: `Switch to a pre-built custom ${T.board}. Available: ${boardList}.${loadedNote} Prefer this over rebuild_board() when a custom ${T.board} fits the current activity.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        board_key: { type: "string", description: `Board key to load. One of: ${config.availableBoards.map(b => `"${b.key}"`).join(", ")}.` },
      },
      required: ["board_key"],
    },
  };
}

function buildPressButtonTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "press_button",
    description: `Press a navigation ${T.button} on the current custom ${T.board} to go to a sub-page. Prefer navigating to sub-pages over generating new ${T.button}s from scratch.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Label of the navigation ${T.button} to press." },
      },
      required: ["label"],
    },
  };
}

function buildEmoteTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const current = config.currentEmote || "happy";
  return {
    name: "emote",
    description: `Set avatar emotion: happy (encouraging), sad (empathizing), or neutral (calm/serious). Current: ${current}. Only call when the emotional tone changes.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emotion: { type: "string", enum: ["happy", "sad", "neutral"], description: "The emotion to display." },
      },
      required: ["emotion"],
    },
  };
}

function buildOpenAppTool(
  enabledApps: AACAppDefinition[],
  customApps: NonNullable<ToolDeclarationConfig["availableCustomApps"]> = [],
): FunctionDeclaration {
  const builtInIds = enabledApps.map(a => a.id).join(", ");
  const customIds = customApps.map(a => a.id).join(", ");
  const sections = [builtInIds ? `Built-in app IDs: ${builtInIds}.` : ""];
  if (customIds) sections.push(`Custom game IDs: ${customIds}.`);
  return {
    name: "open_app",
    description: `Open an interactive app or custom game on the user's screen. See the "Apps" section in the system prompt for details. ${sections.filter(Boolean).join(" ")}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "The app ID to open (either a built-in app id or a custom game id)." },
        data: { type: "string", description: "Optional search query for media apps (YouTube/Spotify)." },
      },
      required: ["app_id"],
    },
  };
}

const CLOSE_APP: FunctionDeclaration = {
  name: "close_app",
  description: "Close the currently open app.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

function buildOpenWebsiteTool(permitted: PermittedWebsite[]): FunctionDeclaration {
  const flat = flattenPermittedWebsites(permitted);
  const list = flat
    .map(w => `- "${w.label}" (${w.url})${w.description ? ` — ${w.description}` : ""}`)
    .join("\n");
  return {
    name: "open_website",
    description: `Open a permitted website in the in-frame browser app on the user's screen. Only URLs covered by the permitted-sites list below may be opened — any other URL will be rejected. Subpages of a permitted URL are also permitted. Use this when the user asks to read, browse, or look something up that maps to one of these sites. After opening, call rebuild_board() with contextual buttons relevant to the site. Permitted sites:\n${list}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to open. Must match a permitted site prefix." },
        label: { type: "string", description: "Short label for the site or page (e.g. 'Wikipedia: Cats'). Optional — used for display only." },
      },
      required: ["url"],
    },
  };
}

// LEARN_FACE (runtime face-learning via AAC) has been removed. New contacts
// are now created deliberately from the Contacts panel, and physical
// descriptors are populated by the photo-analyzer AI pipeline on upload.

const CALL_MONITOR: FunctionDeclaration = {
  name: "call_monitor",
  description: `Alert the monitor agent to check in. Use for goal progress/setbacks, guidance needs, or significant context shifts (new person, new activity). DO NOT narrate this action to the user or refer to the monitor at any time - the monitor is part of your own internal system. The response may take some time to return - continue the conversation normally until it arrives. Do NOT call repeatedly for the same event.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the monitor should check in." },
    },
    required: ["reason"],
  }
};

// Binary-choice option format — same pipe-separated ${T.button} syntax
// as rebuild_board. All ${T.button} rules apply (multi-glyph SENTENCEs,
// MODIFIER SYMBOLs, OPERATORs, animated SYMBOLs). For yes/no questions, the
// `yes` / `no` canonical SYMBOLs auto-color the ${T.button} green / red.
// Inline examples are localized via prompt-examples.ts.
function binaryChoiceOptionFormat(language: string | undefined): string {
  return (
    "speech|sentence|fallback|label — same ${T.button} format as rebuild_board. " +
    "All ${T.button} rules apply (multi-glyph SENTENCEs, MODIFIER SYMBOLs, OPERATORs, fallback when `sentence` uses `generate:`). " +
    "speech is the first-person SENTENCE the user voices on press. label is the short on-button text. " +
    "For yes/no questions, use the `yes` / `no` canonical SYMBOLs — they animate on hover and auto-color the ${T.button} green / red without you setting an explicit color. " +
    ex("tool.binary_choice_inline_examples", language)
  );
}

function buildBinaryChoiceTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const optionFormat = binaryChoiceOptionFormat(config.language);
  return {
    name: "binary_choice",
    description: `Show two large overlay ${T.button}s IMMEDIATELY. Use when SOMEONE ELSE offers the user a choice between two options — either a binary choice ("Do you want the apple or the banana?", or holds up two objects) OR a yes/no question. For yes/no, use the canonical \`yes\` / \`no\` SYMBOLs (e.g. option1="Yes|yes||Yes", option2="No|no||No") — they render with the animated yes/no icons and default green/red coloring. A "Neither" button is added automatically. Do NOT use for open-ended questions — use the ${T.board} for those.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        option1: { type: "string", description: optionFormat },
        option2: { type: "string", description: optionFormat },
      },
      required: ["option1", "option2"],
    },
  };
}

function buildAskBinaryChoiceTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const optionFormat = binaryChoiceOptionFormat(config.language);
  return {
    name: "ask_binary_choice",
    description: `Show two large overlay ${T.button}s AFTER your speech finishes. Use when YOU offer the user a choice between two options — either a binary choice or a yes/no question. For yes/no, use the canonical \`yes\` / \`no\` SYMBOLs (e.g. option1="Yes|yes||Yes", option2="No|no||No") — they render with the animated yes/no icons and default green/red coloring. A "Neither" button is added automatically. Do NOT use for open-ended questions.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        option1: { type: "string", description: optionFormat },
        option2: { type: "string", description: optionFormat },
      },
      required: ["option1", "option2"],
    },
  };
}

function buildRequestFocusTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "request_focus",
    description: `Request a high-resolution close-up frame. Use when you need to read text, identify small/distant objects, or see faces/details clearly. Only request once per observation.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What you want to see more clearly." },
      },
      required: ["reason"],
    },
  };
}

function buildAddContextButtonTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "add_context_button",
    description: `Add ONE ${T.button} to the context sidebar (left, 4 visible slots). Use when you notice something new in the environment — a nearby object, person, or activity the user might want to interact with. The sidebar scrolls: the oldest ${T.button} is pushed out when full. Do NOT duplicate ${T.board} labels.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        button: { type: "string", description: `Single ${T.button}: speech|sentence|fallback|label. See <button_syntax> for field details. The fallback is REQUIRED whenever the sentence uses any \`generate:\` ${T.symbol}, and must itself render immediately (emoji / canonical key / \`symbol:ID\` / \`face:ID\` — never \`generate:\`). A ${T.button} with nothing displayable is rejected.` },
      },
      required: ["button"],
    },
  };
}

function buildSetMemoryChipsTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "set_construction_memory_chips",
    description: `Update the memory-driven mode chips on the ${T.builder} for one category tab. 0–3 chips surface the user's special interests, recent conversation topics, or context-relevant filters (e.g. "planets", "from breakfast today", "things mom mentioned"). Pass an empty array to clear. Keys should be stable snake_case_descriptive — they'll be used as the active modeChip when tapped.`,
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

function buildSuggestConstructionButtonsTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "suggest_construction_buttons",
    description: `Populate the ${T.builder}'s AI strips with SUGGESTIONs for the user to tap. Call this in response to a ${T.tagBuilderState} context injection — never spontaneously.

**Each SUGGESTION is exactly one SYMBOL** — never a multi-symbol GLYPH or SENTENCE. A SUGGESTION goes into ONE of two arrays:

- \`head_candidates\` (up to 4) — each is a HEAD SYMBOL for the NEXT GLYPH in the SENTENCE (\`🐕\`, \`mom\`, \`generate:seagull\`). These populate the main AI strip and become the next glyph when tapped.
- \`modifier_candidates\` (up to 4) — each is a MODIFIER SYMBOL that attaches to the user's CURRENT HEAD SYMBOL (\`color_red\`, \`my\`, \`big\`, \`two\`, \`very\`). These populate a parallel AI-modifier strip and add to the current glyph when tapped — without advancing to a new slot.

Fill BOTH arrays when useful. Use head_candidates when the user needs the next word in their sentence; use modifier_candidates when their current glyph could be sharpened (a red apple instead of just an apple, a big hug instead of just a hug, two cookies instead of just cookies). It's fine to leave either array empty when nothing meaningful fits — just don't leave BOTH empty, in which case omit the tool call entirely.

The builder also surfaces a static, registry-driven modifier carousel; your \`modifier_candidates\` appear ABOVE that carousel as the context-aware row, so prefer modifiers that the registry can't infer from the head symbol alone (rare colors, conversation-specific adjectives, special-interest qualifiers).

When the injection includes \`payload_target\`, the user has placed a composable host GLYPH (\`want\`, \`give\`, \`think\`, \`say\`) whose embedded blank is unfilled — that blank takes a HEAD SYMBOL, so put your SUGGESTIONs in \`head_candidates\` and use \`slot_index\` matching the payload_target's slotIndex. Modifier suggestions don't apply to an unfilled composable blank.

Each SUGGESTION is a pipe-separated string: \`speech|symbol|fallback|label\`. SUGGESTIONs don't speak (they fill a position), so the speech field is unused — the typical form is \`|symbol|fallback|label\` (e.g. \`|🐕||Dog\`, \`|generate:seagull|🐦.🏖️|Seagull\`, \`|color_red||Red\`). The 3-field form \`symbol|fallback|label\` and the 2-field \`symbol|label\` also work; a bare SYMBOL is also accepted.

The \`symbol\` field follows the SAME content rules as anywhere else:
- a canonical registry key from <bundled_icons> (head: \`want\`, \`now\`; modifier: \`color_red\`, \`big\`, \`my\`, \`two\`, \`please\`);
- a raw emoji (\`🍎\`, \`🤗\`) — default for any HEAD SYMBOL not in <bundled_icons>. Modifiers, by contrast, almost always come from the canonical registry;
- a custom SYMBOL \`symbol:ID\` or face \`face:ID\`;
- a generated SYMBOL prefixed \`generate:\` (\`generate:pikachu\`) — last resort for heads only, MUST be paired with a non-empty \`fallback\`. SUGGESTIONs with a \`generate:\` symbol but no fallback are REJECTED.

A JSON-object form \`{ key, label?, fallback? }\` is also accepted for compatibility, but the pipe-separated string above is the preferred shape.

Never include any SYMBOL from \`exclude_keys\`. SUGGESTION labels MUST be in the user's language. \`candidates\` is also accepted as a legacy alias for \`head_candidates\` — prefer the new field names.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        slot_index: {
          type: "integer",
          description: "Which builder position the head SUGGESTIONs target. Use the `targetSlot` value from the ${T.tagBuilderState} injection. Use 0 if uncertain. (Modifier suggestions always attach to the user's currently-selected head symbol; they don't use slot_index.)",
        },
        head_candidates: {
          type: "array",
          description: "ARRAY of up to 4 strings. EACH ARRAY ELEMENT is ONE candidate — DO NOT put multiple candidates in one element separated by commas (that's the format rebuild_board uses; here it's an actual JSON array). Order matters — leftmost is strongest. Each element is one SYMBOL formatted as pipe-separated `speech|symbol|fallback|label` (speech field unused). Example: `[\"|🐕||Dog\", \"|🐈||Cat\", \"|🐦||Bird\"]` — three array elements, NOT one string. Empty list is fine when no head suggestion fits.",
          items: { type: "string" },
        },
        modifier_candidates: {
          type: "array",
          description: "ARRAY of up to 4 strings. EACH ARRAY ELEMENT is ONE modifier candidate — DO NOT put multiple candidates in one element separated by commas. Order matters. Each element is one MODIFIER SYMBOL (\\`color_red\\`, \\`big\\`, \\`my\\`, \\`two\\`, \\`please\\`, …), formatted as `speech|symbol|fallback|label` (speech field unused). Example: `[\"|color_red||Red\", \"|big||Big\"]` — two array elements. Empty list is fine when no modifier suggestion fits.",
          items: { type: "string" },
        },
        candidates: {
          type: "array",
          description: "DEPRECATED alias for head_candidates. Prefer the explicit field. Same format.",
          items: { type: "string" },
        },
      },
      required: ["slot_index"],
    },
  };
}

const SET_INTERACTION_MODE: FunctionDeclaration = {
  name: "set_interaction_mode",
  description: `Switch between interaction modes. "interact" = you speak and engage actively with the user, initiating conversation and commenting on observations. "assist" = you stay quiet and only respond when the user explicitly gets your attention; the avatar appears sleepy. Use "assist" when the user is busy with another person or in a situation where proactive speech would be intrusive. "standby" = the user is not present (not visible AND not heard) — don't proactively start conversation or treat the visible person as the user, but still respond to button presses and direct questions and update the board for them; the avatar appears resting. Use "interact" to re-engage when the user shows interest or returns.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["interact", "assist", "standby"], description: "The mode to switch to." },
      reason: { type: "string", description: "Brief reason for the mode change." },
    },
    required: ["mode"],
  },
};

// wake_up — RESTING-mode-only tool. Distinct from set_interaction_mode:
// set_interaction_mode chooses the AI's behavioral mode (interact/assist/
// standby) WITHIN an active session; wake_up escalates the whole SESSION
// PROFILE from the lightweight resting configuration (tiny prompt, 4 tools,
// tight compression) back to the full awake configuration. The relay handles
// the call by reconnecting with the full prompt + toolset; the model then
// picks its interaction mode normally.
const WAKE_UP: FunctionDeclaration = {
  name: "wake_up",
  description: `Escalate the session from RESTING mode back to full interaction. Call this ONLY when the user is settling in to actually USE the device — they look at it and address you, press a button, or clearly want to communicate through the board. The system reconnects with the full companion tools; you then choose your interaction mode (interact/assist/standby) normally. Do NOT call this for background activity, passing voices, or a single direct question you can answer briefly without waking.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason you're waking the session (e.g. 'Daniel turned to the device and said my name', 'button pressed')." },
    },
    required: ["reason"],
  },
};

// Sleep system tools — let the AI manage its own engagement level.
// See planning-docs/aac-sleep-system-plan.md.
const SLEEP: FunctionDeclaration = {
  name: "sleep",
  description: `Mark the session as Asleep — user is not present but might return. Call when the user has stepped away or appears disengaged for an extended period. While Asleep the system stops sending mic audio and image data, saving tokens. The session resumes automatically when activity is detected. Do NOT call sleep() if the user is actively engaged.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const END_SESSION: FunctionDeclaration = {
  name: "end_session",
  description: `End the current session. The session enters Hibernation. No further audio or video is captured until the user explicitly re-engages (avatar tap, AAC button press, or sustained eye contact). Use only when you're confident the conversation is complete and the user has fully disengaged.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const REPORT_FALSE_WAKE: FunctionDeclaration = {
  name: "report_false_wake",
  description: `Tell the system the most recent wake from Asleep was a false alarm (e.g. background TV, an unrelated adult talking, a passing pet). The system will require a stronger signal to wake again, decaying back to baseline over ~10 minutes. Call this INSTEAD OF responding when you receive a wake-context bundle and judge it not to be the user re-engaging.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief description of what triggered the false wake (e.g. 'TV in background', 'adult voice not student')." },
    },
    required: ["reason"],
  },
};

// Private-note — silent thought / breadcrumb the model can leave. Not spoken
// aloud, not shown to the user; logged for the developer and persisted into
// the conversation history so the monitor agent and future turns can see it.
// Use as a low-stakes way for the model to communicate observations or
// reasoning when speech isn't appropriate.
const PRIVATE_NOTE: FunctionDeclaration = {
  name: "private_note",
  description: `Record a private thought or note. The note is saved to your conversation history and visible to the developer / monitor agent, but is NEVER spoken to the user. Use this when you want to log reasoning, observations, plans, or intentions without producing speech. Keep notes short and specific. NEVER produce text or audio beginning with "[note]", "[thinking]", "[private note]", or any similar bracketed marker — anything you emit reaches the user. Use this tool instead.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "Your private thought (one short sentence)." },
    },
    required: ["note"],
  },
};

// Stay-silent — explicit signal that the model has decided NOT to respond
// aloud this turn. The reason is recorded for the monitor agent. Critically,
// the live-relay's auto-continuation uses this as the "intentional silence"
// signal — without it, a transcript-and-no-audio turn gets re-prompted.
const STAY_SILENT: FunctionDeclaration = {
  name: "stay_silent",
  description: `Use this when you have decided NOT to produce a spoken response this turn. Examples of valid reasons: a voice you heard was background TV / another person's conversation not directed at you; the user is engaged with media and shouldn't be interrupted; you logged an observation but no reply is needed. Pass a brief reason — the system uses this signal to know your silence was intentional rather than a missed turn. Do NOT call stay_silent as a placeholder for "I'll think before responding" — if you intend to speak, just speak. Do NOT call it before or after speaking on the same turn.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason you are not responding (one short sentence)." },
    },
    required: ["reason"],
  },
};

// Debug message — used by the system when a turn is rejected. The model calls
// this to tell us what it was trying to do, bypassing the audio safety filter
// that would otherwise RESPONSE_REJECT the explanation itself.
const DEBUG_MESSAGE: FunctionDeclaration = {
  name: "debug_message",
  description: "System diagnostic tool. When the system tells you a response was rejected or malformed and asks what you were trying to do, call this function with your explanation. Do NOT call this unless explicitly asked by a [DEBUG] system message.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "What you were trying to do — the function you were calling and/or what you were going to say." },
    },
    required: ["message"],
  },
};

// ---------------------------------------------------------------------------
// Builder — conditionally includes tools based on session config
// ---------------------------------------------------------------------------

export function buildToolDeclarations(config: ToolDeclarationConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  // RESTING profile: tiny tool set. The model watches/waits, can answer a
  // direct question (speak — only in tool-driven audio; native audio speaks
  // without a tool), records context, and escalates via wake_up. Everything
  // board/conversation-related is intentionally absent.
  if (config.restingMode) {
    declarations.push(WAKE_UP);
    if (!config.useDirectAudio) {
      declarations.push(buildSpeakTool(config));
    }
    declarations.push(buildTranscriptTool(config));
    declarations.push(buildContextTool(config));
    declarations.push(PRIVATE_NOTE);
    if (process.env.AAC_DEBUG_INTROSPECTION === "1") {
      declarations.push(DEBUG_MESSAGE);
    }
    return [{ functionDeclarations: declarations }];
  }

  if (!config.isMutedMode && !config.useDirectAudio) {
    declarations.push(buildSpeakTool(config));
  }

  // Interpret is declared so the AI can voice the user's intent when
  // they play a SENTENCE from the ${T.builder} (see ${T.tagComposed}
  // flow). Regular ${T.tagPress} inputs still use pre-generated SENTENCEs,
  // voiced server-side without the model's involvement.
  declarations.push(buildInterpretTool(config));

  declarations.push(buildTranscriptTool(config));
  declarations.push(buildContextTool(config));

  // Board management
  declarations.push(buildAddContextButtonTool(config));
  declarations.push(buildSuggestConstructionButtonsTool(config));
  declarations.push(buildSetMemoryChipsTool(config));
  declarations.push(buildRebuildBoardTool(config));

  // Remove the add and remove buttons tools - rarely used anyway, the context buttons are better

  // declarations.push(buildAddButtonsTool(config));
  // declarations.push(buildRemoveButtonsTool(config));

  if (config.availableBoards.length > 0) {
    declarations.push(buildSetBoardTool(config));
  }

  if (config.hasLoadedBoard) {
    declarations.push(buildPressButtonTool(config));
  }

  declarations.push(buildEmoteTool(config));

  const hasBuiltInApps = config.enabledApps.length > 0;
  const hasCustomApps = (config.availableCustomApps?.length ?? 0) > 0;
  const hasPermittedWebsites = (config.permittedWebsites?.length ?? 0) > 0;
  if (hasBuiltInApps || hasCustomApps || hasPermittedWebsites) {
    if (hasBuiltInApps || hasCustomApps) {
      declarations.push(buildOpenAppTool(config.enabledApps, config.availableCustomApps ?? []));
    }
    if (hasPermittedWebsites) {
      declarations.push(buildOpenWebsiteTool(config.permittedWebsites!));
    }
    declarations.push(CLOSE_APP);
  }

  // Face recognition continues to IDENTIFY known contacts, but new contacts
  // must be created deliberately from the Contacts panel — LEARN_FACE removed.
  // Yes/No is handled inside the binary-choice path now — the canonical
  // `yes` and `no` SYMBOLs render with the animated icons and auto-color
  // ${T.button}s green/red. No dedicated yes_no / ask_yes_no tools.
  declarations.push(buildBinaryChoiceTool(config));
  declarations.push(buildAskBinaryChoiceTool(config));
  // declarations.push(buildRequestFocusTool(config));
  declarations.push(SET_INTERACTION_MODE);
  declarations.push(PRIVATE_NOTE);
  declarations.push(CALL_MONITOR);
  declarations.push(SLEEP);
  declarations.push(END_SESSION);
  // DISABLED: report_false_wake — only used in wake-check flow, gave the
  // model an "I'll opt out" path. Same family of self-talk-to-stay-silent
  // tools as stay_silent.
  // declarations.push(REPORT_FALSE_WAKE);
  // DISABLED: stay_silent — explicit silence signal. The model uses it as
  // an escape hatch from responding even when proactiveAudio handles that
  // decision at the wire level.
  // declarations.push(STAY_SILENT);
  if (process.env.AAC_DEBUG_INTROSPECTION === "1") {
    declarations.push(DEBUG_MESSAGE);
  }

  return [{ functionDeclarations: declarations }];
}
