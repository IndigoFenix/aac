// server/services/dual-agent/tool-declarations.ts
// Function declarations for live API native function calling.
// Supports both Gemini (FunctionDeclaration) and OpenAI (RealtimeFunctionTool) formats.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import type { RealtimeFunctionTool } from "openai/resources/realtime/realtime";
import type { AACAppDefinition } from "./types";

// ---------------------------------------------------------------------------
// Individual tool declarations
// ---------------------------------------------------------------------------

const SPEAK: FunctionDeclaration = {
  name: "speak",
  description: "Say something to your user or people nearby (AI voice). Use for greetings, questions, comments, encouragement. In silent mode this tool is disabled.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to speak aloud" },
    },
    required: ["text"],
  },
};

function makeInterpretTool(level: number): FunctionDeclaration {
  const levelDescriptions: Record<number, string> = {
    1: "ONLY after a button press. Expand button labels into natural phrases.",
    2: "From button presses, clear gestures, or strong contextual cues. Do NOT interpret weak signals.",
    3: "From button presses, gestures, gaze, and contextual cues. Prefer interpreting over silence.",
    4: "You are the user's autonomous voice. Actively interpret everything.",
  };
  return {
    name: "interpret",
    description: `Speak on behalf of the user (student voice). ${levelDescriptions[level] || "Interpret user intent."}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The interpreted message to speak in the student's voice" },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "How confident you are in this interpretation" },
      },
      required: ["text", "confidence"],
      },
  };
}

const TRANSCRIPT: FunctionDeclaration = {
  name: "transcript",
  description: "Record clear speech you heard from a person nearby. Only transcribe speech you can clearly make out. NEVER transcribe your own echoed TTS output.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The transcribed speech" },
      speaker: { type: "string", description: "Who spoke (e.g. 'Mom', 'Teacher', 'Unknown')" },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "Transcription confidence" },
    },
    required: ["text", "speaker"],
  },
};

const CONTEXT: FunctionDeclaration = {
  name: "context",
  description: "Record environmental observations and context changes (new objects, gestures, sounds, activities). Omit if nothing meaningful changed.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Description of what you observe" },
    },
    required: ["text"],
  },
};

const ADD_BUTTONS: FunctionDeclaration = {
  name: "add_buttons",
  description: "Add communication buttons to the existing AAC board. Use when you see new objects, activities, or communication opportunities.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      buttons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Button text (short, clear concept)" },
            icon: { type: "string", description: "Emoji icon, or face:contactId, or symbol:symbolId" },
          },
          required: ["label", "icon"],
              },
        description: "Buttons to add",
      },
    },
    required: ["buttons"],
  },
};

const REMOVE_BUTTONS: FunctionDeclaration = {
  name: "remove_buttons",
  description: "Remove buttons from the AAC board by label. Use when items are no longer relevant.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Labels of buttons to remove",
      },
    },
    required: ["labels"],
  },
};

const REBUILD_BOARD: FunctionDeclaration = {
  name: "rebuild_board",
  description: "Replace the entire AAC board with a new set of buttons. Use after button presses or major context shifts. Exits any loaded custom board.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      buttons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Button text" },
            icon: { type: "string", description: "Emoji icon, or face:contactId, or symbol:symbolId" },
          },
          required: ["label", "icon"],
              },
        description: "Complete new set of buttons",
      },
    },
    required: ["buttons"],
  },
};

function makeSetBoardTool(availableBoards: Array<{ key: string; name: string }>): FunctionDeclaration {
  const boardList = availableBoards.map(b => `"${b.key}" (${b.name})`).join(", ");
  return {
    name: "set_board",
    description: `Switch to a pre-built custom board. Available boards: ${boardList}. Do NOT announce board switches with speak(). The model receives the board layout in the response.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        board_key: { type: "string", description: "The board key to load (e.g. \"programming_activities\")" },
      },
      required: ["board_key"],
      },
  };
}

const PRESS_BUTTON: FunctionDeclaration = {
  name: "press_button",
  description: "Press a navigation button on the current custom board to navigate to a sub-page. Only press buttons that have navigation actions. The model receives the navigation result in the response.",
  behavior: Behavior.BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Label of the button to press" },
    },
    required: ["label"],
  },
};

const EMOTE: FunctionDeclaration = {
  name: "emote",
  description: "Set your avatar's displayed emotion. Include when the emotional tone changes.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      emotion: { type: "string", enum: ["happy", "sad", "neutral"], description: "The emotion to display" },
    },
    required: ["emotion"],
  },
};

const PLAY_VIDEO: FunctionDeclaration = {
  name: "play_video",
  description: "Search for and play a YouTube video for the user. Only use with HIGH CONFIDENCE that the user wants to watch something.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "YouTube search query" },
    },
    required: ["query"],
  },
};

function makeOpenAppTool(enabledApps: AACAppDefinition[]): FunctionDeclaration {
  const appList = enabledApps.map(a => `"${a.id}" — ${a.name}: ${a.description}`).join("; ");
  return {
    name: "open_app",
    description: `Open an app for the user. Available apps: ${appList}. Only open with HIGH CONFIDENCE.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "The app ID to open" },
        data: { type: "string", description: "Optional data to pass to the app (e.g. search query for youtube)" },
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
  description: "Remember a new person's face. Use when you see an unrecognized person and learn their name through conversation.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Person's name" },
      relationship: { type: "string", description: "Relationship to the user (e.g. classmate, sibling, teacher)" },
      description: { type: "string", description: "Physical description (e.g. 'Brown hair, glasses')" },
    },
    required: ["name"],
  },
};

const CALL_MONITOR: FunctionDeclaration = {
  name: "call_monitor",
  description: "Alert the monitor agent to check in. Use for goal progress, guidance needs, or significant context shifts. Do not overuse.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the monitor should check in" },
    },
    required: ["reason"],
  },
};

const YES_NO: FunctionDeclaration = {
  name: "yes_no",
  description: "Show large Yes/No overlay buttons IMMEDIATELY. Use when someone ELSE asks the user a direct yes/no question.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const ASK_YES_NO: FunctionDeclaration = {
  name: "ask_yes_no",
  description: "Show Yes/No overlay AFTER your speech finishes. Use when YOU ask the user a yes/no question with speak().",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const REQUEST_FOCUS: FunctionDeclaration = {
  name: "request_focus",
  description: "Request a high-resolution close-up frame for detailed analysis. Use when you see text, small objects, or faces you can't identify clearly.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "What you want to see more clearly" },
    },
    required: ["reason"],
  },
};

// ---------------------------------------------------------------------------
// Builder — conditionally includes tools based on session config
// ---------------------------------------------------------------------------

export interface ToolDeclarationConfig {
  interpretationLevel: number;
  enabledApps: AACAppDefinition[];
  availableBoards: Array<{ key: string; name: string }>;
  hasLoadedBoard: boolean;
  youtubeEnabled: boolean;
  faceRecognitionActive: boolean;
  cachedSymbols?: Array<{ id: string; name: string }>;
  isSilentMode?: boolean;
}

export function buildToolDeclarations(config: ToolDeclarationConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  // Always included
  if (!config.isSilentMode) {
    declarations.push(SPEAK);
  }

  // interpret — only when interpretationLevel > 0
  if (config.interpretationLevel > 0) {
    declarations.push(makeInterpretTool(config.interpretationLevel));
  }

  declarations.push(TRANSCRIPT);
  declarations.push(CONTEXT);

  // Board management — always available
  declarations.push(ADD_BUTTONS);
  declarations.push(REMOVE_BUTTONS);
  declarations.push(REBUILD_BOARD);

  // set_board — only when custom boards are available
  if (config.availableBoards.length > 0) {
    declarations.push(makeSetBoardTool(config.availableBoards));
  }

  // press_button — only when a custom board is loaded
  if (config.hasLoadedBoard) {
    declarations.push(PRESS_BUTTON);
  }

  declarations.push(EMOTE);

  // play_video — only when YouTube enabled
  if (config.youtubeEnabled) {
    declarations.push(PLAY_VIDEO);
  }

  // open_app — only when apps are available
  if (config.enabledApps.length > 0) {
    declarations.push(makeOpenAppTool(config.enabledApps));
    declarations.push(CLOSE_APP);
  }

  // learn_face — only when face recognition is active
  if (config.faceRecognitionActive) {
    declarations.push(LEARN_FACE);
  }

  declarations.push(CALL_MONITOR);
  declarations.push(YES_NO);
  declarations.push(ASK_YES_NO);
  declarations.push(REQUEST_FOCUS);

  return [{ functionDeclarations: declarations }];
}

// ---------------------------------------------------------------------------
// OpenAI Realtime API tool format converter
// ---------------------------------------------------------------------------

/** Convert a Gemini FunctionDeclaration to OpenAI RealtimeFunctionTool format */
function toOpenAITool(decl: FunctionDeclaration): RealtimeFunctionTool {
  return {
    type: "function",
    name: decl.name,
    description: decl.description || "",
    parameters: decl.parametersJsonSchema as unknown || { type: "object", properties: {} },
  };
}

/**
 * Build tool declarations in OpenAI Realtime API format.
 * Same conditional logic as buildToolDeclarations, but output is RealtimeFunctionTool[].
 */
export function buildOpenAIToolDeclarations(config: ToolDeclarationConfig): RealtimeFunctionTool[] {
  const declarations: FunctionDeclaration[] = [];

  if (!config.isSilentMode) {
    declarations.push(SPEAK);
  }
  if (config.interpretationLevel > 0) {
    declarations.push(makeInterpretTool(config.interpretationLevel));
  }
  declarations.push(TRANSCRIPT);
  declarations.push(CONTEXT);
  declarations.push(ADD_BUTTONS);
  declarations.push(REMOVE_BUTTONS);
  declarations.push(REBUILD_BOARD);
  if (config.availableBoards.length > 0) {
    declarations.push(makeSetBoardTool(config.availableBoards));
  }
  if (config.hasLoadedBoard) {
    declarations.push(PRESS_BUTTON);
  }
  declarations.push(EMOTE);
  if (config.youtubeEnabled) {
    declarations.push(PLAY_VIDEO);
  }
  if (config.enabledApps.length > 0) {
    declarations.push(makeOpenAppTool(config.enabledApps));
    declarations.push(CLOSE_APP);
  }
  if (config.faceRecognitionActive) {
    declarations.push(LEARN_FACE);
  }
  declarations.push(CALL_MONITOR);
  declarations.push(YES_NO);
  declarations.push(ASK_YES_NO);
  declarations.push(REQUEST_FOCUS);

  return declarations.map(toOpenAITool);
}
