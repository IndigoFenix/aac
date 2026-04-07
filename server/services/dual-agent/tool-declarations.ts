// server/services/dual-agent/tool-declarations.ts
// Function declarations for live API native function calling.
// Uses Gemini FunctionDeclaration format with OpenAPI Schema (parameters field).
//
// IMPORTANT: Vertex AI Live API requires `parameters` (OpenAPI Schema with Type enum),
// NOT `parametersJsonSchema` (JSON Schema format). The SDK may not convert between
// them for the Live WebSocket API, causing the model to receive tools without schemas
// and produce empty turns.

import { Behavior, Type, type FunctionDeclaration, type Tool } from "@google/genai";
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

const BUTTON_FORMAT_ADD = "Comma-separated buttons: label|icon|imageKey|sentence. The sentence is a natural phrase the student means when pressing this button — keep it short and comma-free. imageKey is an unambiguous English key for symbol generation (leave empty if not needed). Icon is an emoji, single character/number, face:contactId, or symbol:symbolId. When using a single character/number as icon (e.g. 7, A, ?), omit imageKey. Example: \"Water|💧|water_glass|I would like some water, Play|🎮|game_controller|I want to play, Seven|7||I am 7 years old\"";

const BUTTON_FORMAT_REBUILD = "Comma-separated buttons: label|icon|imageKey|sentence. The sentence is a natural phrase the student means when pressing this button — keep it short and comma-free. imageKey is an unambiguous English key for symbol generation (leave empty if not needed). Icon is an emoji, single character/number, face:contactId, or symbol:symbolId. When using a single character/number as icon (e.g. 7, A, ?), omit imageKey. Example: \"Play|🎮|game_controller|I want to play, Music|🎵|music_notes|Put on some music, Draw|✏️|pencil_drawing|I want to draw, Tired|😴|sleepy_face|I am tired\"";

// ---------------------------------------------------------------------------
// Tool factory functions
// ---------------------------------------------------------------------------

function buildSpeakTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "speak",
    description: `Say something to the user or people nearby (AI voice). A separate TTS system voices this — do NOT produce audio yourself. Use to greet, ask questions, comment on observations, or suggest activities. When you ask a question, ALWAYS also call add_buttons() or rebuild_board() with answer buttons — the user cannot respond without them. Do NOT announce board changes or repeat yourself. When a [BUTTON PRESS] occurs, the student's sentence is voiced automatically — do NOT repeat or paraphrase what the student said. Just respond naturally. Only call speak() once per turn.`,
    behavior: Behavior.BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "The text to speak aloud." },
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
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "The transcribed speech." },
        speaker: { type: Type.STRING, description: "Who spoke (e.g. 'Mom', 'Teacher', 'Unknown')." },
        confidence: { type: Type.STRING, enum: ["high", "medium", "low"], description: "Transcription confidence." },
      },
      required: ["text", "speaker"],
    },
  };
}

function buildContextTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "context",
    description: `Record environmental observations and context changes. Call when you notice new objects, people arriving/leaving, gestures, sounds, or changes in the user's attention. Do NOT call if nothing meaningful changed. Do NOT narrate your own actions.`,
    behavior: Behavior.BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "What changed or what you observe." },
      },
      required: ["text"],
    },
  };
}

function buildAddButtonsTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 12;
  return {
    name: "add_buttons",
    description: `Add communication buttons to the AAC board. Max ${max} buttons total — call remove_buttons() first if full. Do not duplicate existing buttons or include Yes/No/Help/More (automatic).`,
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        buttons: { type: Type.STRING, description: BUTTON_FORMAT_ADD },
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
    parameters: {
      type: Type.OBJECT,
      properties: {
        labels: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Labels of buttons to remove.",
        },
      },
      required: ["labels"],
    },
  };
}

function buildRebuildBoardTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 12;
  return {
    name: "rebuild_board",
    description: `Replace the entire AAC board. Use after [BUTTON PRESS] inputs, major context shifts, or to create the initial board. Only call this once per turn. For minor changes, prefer add_buttons/remove_buttons. Max ${max} buttons, aim for ~${Math.min(8, max)}. When a custom board is loaded, this updates the 4-button side panel (max 4). Set full_board=true to unload the custom board and return to the full dynamic board.`,
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        buttons: { type: Type.STRING, description: BUTTON_FORMAT_REBUILD },
        full_board: { type: Type.BOOLEAN, description: "Set to true to unload any custom board and return to the full dynamic board (up to 12 buttons)." },
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
    parameters: {
      type: Type.OBJECT,
      properties: {
        board_key: { type: Type.STRING, description: `Board key to load. One of: ${config.availableBoards.map(b => `"${b.key}"`).join(", ")}.` },
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
    parameters: {
      type: Type.OBJECT,
      properties: {
        label: { type: Type.STRING, description: "Label of the navigation button to press." },
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
    parameters: {
      type: Type.OBJECT,
      properties: {
        emotion: { type: Type.STRING, enum: ["happy", "sad", "neutral"], description: "The emotion to display." },
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
    parameters: {
      type: Type.OBJECT,
      properties: {
        app_id: { type: Type.STRING, description: "The app ID to open." },
        data: { type: Type.STRING, description: "Optional search query for media apps (YouTube/Spotify)." },
      },
      required: ["app_id"],
    },
  };
}

const CLOSE_APP: FunctionDeclaration = {
  name: "close_app",
  description: "Close the currently open app.",
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const LEARN_FACE: FunctionDeclaration = {
  name: "learn_face",
  description: `Remember a new person's face. Use when you see an unrecognized person and learn their name through conversation. Only when confident about their identity.`,
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: "Person's name." },
      relationship: { type: Type.STRING, description: "Relationship to the user (e.g. classmate, sibling, teacher)." },
      description: { type: Type.STRING, description: "Physical description (e.g. 'Brown hair, glasses')." },
    },
    required: ["name"],
  },
};

function buildCallMonitorTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "call_monitor",
    description: `Alert the monitor agent to check in. Use for goal progress/setbacks, guidance needs, or significant context shifts (new person, new activity). Do NOT call repeatedly for the same event.`,
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: "Why the monitor should check in." },
      },
      required: ["reason"],
    },
  };
}

const YES_NO: FunctionDeclaration = {
  name: "yes_no",
  description: `Show large Yes/No overlay buttons IMMEDIATELY. Use when someone ELSE asks the user a yes/no question. Auto-dismisses after 5 seconds.`,
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const ASK_YES_NO: FunctionDeclaration = {
  name: "ask_yes_no",
  description: `Show Yes/No overlay AFTER your speech finishes. Use when YOU ask the user a yes/no question with speak(). Auto-dismisses after 5 seconds.`,
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

function buildRequestFocusTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "request_focus",
    description: `Request a high-resolution close-up frame. Use when you need to read text, identify small/distant objects, or see faces/details clearly. Only request once per observation.`,
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: "What you want to see more clearly." },
      },
      required: ["reason"],
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
