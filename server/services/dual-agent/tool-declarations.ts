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

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface ToolDeclarationConfig {
  enabledApps: AACAppDefinition[];
  availableBoards: Array<{ key: string; name: string }>;
  hasLoadedBoard: boolean;
  faceRecognitionActive: boolean;
  cachedSymbols?: Array<{ id: string; name: string }>;
  isSilentMode?: boolean;

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
}

// ---------------------------------------------------------------------------
// Button format description (shared by add_buttons and rebuild_board)
// ---------------------------------------------------------------------------

const BUTTON_FORMAT_ADD = "Comma-separated buttons: label|icon|imageKey|sentence. Sentence is a short phrase the user means - write from the user's perspective, not your own. Prefer emojis — only add imageKey when no emoji captures the concept. Example: \"Water|💧||I want water, Play|🎮||I want to play, Park|🏞️|child_on_playground|Let's go to the park\"";

const BUTTON_FORMAT_REBUILD = "Comma-separated buttons: label|icon|imageKey|sentence. Sentence is a short phrase the user means - write from the user's perspective, not your own. Prefer emojis — only add imageKey when no emoji captures the concept. Example: \"Play|🎮||I want to play, Music|🎵||Put on some music, Draw|✏️||I want to draw, Tired|😴||I am tired\"";

// ---------------------------------------------------------------------------
// Tool factory functions
// ---------------------------------------------------------------------------

function buildSpeakTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "speak",
    description: `Say something to the user or people nearby (AI voice). A separate TTS system voices this — do NOT produce audio yourself. Use to greet, ask questions, comment on observations, or suggest activities. When you ask a question, ALWAYS also call add_buttons() or rebuild_board() with answer buttons — the user cannot respond without them. Do NOT announce board changes or repeat yourself. When a [BUTTON PRESS] occurs, the student's sentence is voiced automatically — do NOT repeat or paraphrase what the student said. Just respond naturally. Only call speak() once per turn.`,
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

function buildTranscriptTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "transcript",
    description: `Record clear speech you heard from a person nearby. Only transcribe when you can confidently identify words — ignore silence, ambient noise, unintelligible audio, and background conversations. CRITICAL: If you recently spoke or the user pushed an utterance button, you WILL hear those words echoed back through the microphone — that is YOUR OWN echo, not new speech. Never transcribe your own echoes.`,
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
    description: `Record environmental observations and context changes. Call when you notice new objects, people arriving/leaving, gestures, sounds, or changes in the user's attention. Do NOT call if nothing meaningful changed. Do NOT narrate your own actions.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What changed or what you observe." },
      },
      required: ["text"],
    },
  };
}

function buildAddButtonsTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 12;
  return {
    name: "add_buttons",
    description: `Add communication buttons to the AAC board. Max ${max} buttons total — call remove_buttons() first if full. Do not duplicate existing buttons or include Yes/No/Home/More (automatic).`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: { type: "string", description: BUTTON_FORMAT_ADD },
      },
      required: ["buttons"],
    },
  };
}

function buildRemoveButtonsTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "remove_buttons",
    description: `Remove buttons from the AAC board by label. Use when items are no longer relevant or you need to make room for new ones.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels of buttons to remove.",
        },
      },
      required: ["labels"],
    },
  };
}

function buildRebuildBoardTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "rebuild_board",
    description: `Replace the main AAC board (right side, up to 8 buttons). Use after [BUTTON PRESS] inputs or major conversation shifts. You MUST call this after every button press. If a custom board is currently loaded, calling this will unload it and replace it with your new dynamic board. The context sidebar (left) is separate — use add_context_button() for that.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: { type: "string", description: BUTTON_FORMAT_REBUILD },
      },
      required: ["buttons"],
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
    description: `Switch to a pre-built custom board. Available: ${boardList}.${loadedNote} Prefer this over rebuild_board() when a custom board fits the current activity.`,
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
    description: `Press a navigation button on the current custom board to go to a sub-page. Prefer navigating to sub-pages over generating new buttons from scratch.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Label of the navigation button to press." },
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

function buildOpenAppTool(enabledApps: AACAppDefinition[]): FunctionDeclaration {
  const appIds = enabledApps.map(a => a.id).join(", ");
  return {
    name: "open_app",
    description: `Open an interactive app on the user's screen. See the "Apps" section in the system prompt for details. Available app IDs: ${appIds}.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "The app ID to open." },
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

const LEARN_FACE: FunctionDeclaration = {
  name: "learn_face",
  description: `Remember a new person's face. Use when you see an unrecognized person and learn their name through conversation. Only when confident about their identity.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Person's name." },
      relationship: { type: "string", description: "Relationship to the user (e.g. classmate, sibling, teacher)." },
      description: { type: "string", description: "Physical description (e.g. 'Brown hair, glasses')." },
    },
    required: ["name"],
  },
};

function buildCallMonitorTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "call_monitor",
    description: `Alert the monitor agent to check in. Use for goal progress/setbacks, guidance needs, or significant context shifts (new person, new activity). Do NOT call repeatedly for the same event.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the monitor should check in." },
      },
      required: ["reason"],
    },
  };
}

const YES_NO: FunctionDeclaration = {
  name: "yes_no",
  description: `Show large Yes/No overlay buttons IMMEDIATELY. Use when SOMEONE ELSE asks the user a simple yes/no question. Do NOT use for open-ended questions - use the button board for open-ended questions instead.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const ASK_YES_NO: FunctionDeclaration = {
  name: "ask_yes_no",
  description: `Show Yes/No overlay AFTER your speech finishes. Use when YOU ask the user a simple yes/no question (do NOT use for open-ended questions).`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

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
    description: `Add ONE button to the context sidebar (left, 4 visible slots). Use when you notice something new in the environment — a nearby object, person, or activity the user might want to interact with. The sidebar scrolls: oldest button is pushed out when full. Do NOT duplicate main board buttons.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        button: { type: "string", description: "Single button: label|icon|imageKey|sentence. Prefer emojis — only add imageKey when no emoji captures the concept. Example: \"Teddy Bear|🧸||I see my teddy bear\"" },
      },
      required: ["button"],
    },
  };
}

// ---------------------------------------------------------------------------
// Builder — conditionally includes tools based on session config
// ---------------------------------------------------------------------------

export function buildToolDeclarations(config: ToolDeclarationConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  if (!config.isSilentMode && !config.useDirectAudio) {
    declarations.push(buildSpeakTool(config));
  }

  // Interpretation is handled server-side (pre-generated TTS on button press).
  // No interpret() tool is declared — the AI does not voice on behalf of the user.

  declarations.push(buildTranscriptTool(config));
  declarations.push(buildContextTool(config));

  // Board management
  declarations.push(buildAddContextButtonTool(config));
  declarations.push(buildAddButtonsTool(config));
  declarations.push(buildRemoveButtonsTool(config));
  declarations.push(buildRebuildBoardTool(config));

  if (config.availableBoards.length > 0) {
    declarations.push(buildSetBoardTool(config));
  }

  if (config.hasLoadedBoard) {
    declarations.push(buildPressButtonTool(config));
  }

  declarations.push(buildEmoteTool(config));

  if (config.enabledApps.length > 0) {
    declarations.push(buildOpenAppTool(config.enabledApps));
    declarations.push(CLOSE_APP);
  }

  if (config.faceRecognitionActive) {
    declarations.push(LEARN_FACE);
  }

  declarations.push(buildCallMonitorTool(config));
  declarations.push(YES_NO);
  declarations.push(ASK_YES_NO);
  declarations.push(buildRequestFocusTool(config));

  return [{ functionDeclarations: declarations }];
}
