// server/services/dual-agent/tool-declarations.ts
// Function declarations for live API native function calling.
// Uses Gemini FunctionDeclaration format.
//
// Tool descriptions contain the behavioral rules for each tool. Keep descriptions
// concise but complete — include the key rules the model needs to follow.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import type { AACAppDefinition } from "./types";

// ---------------------------------------------------------------------------
// Config interface
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

  // Enriched context for detailed tool descriptions
  maxBoardItems?: number;
  loadedBoardName?: string | null;
  loadedPageNavButtons?: Array<{ label: string; targetPageName?: string }>;
  customBoardFixedButtons?: string[];
  customBoardAiAddedButtons?: string[];
  currentEmote?: string;
  activeApp?: string | null;

}

// ---------------------------------------------------------------------------
// Tool factory functions
// ---------------------------------------------------------------------------

function buildSpeakTool(config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "speak",
    description: `Say something to the user or people nearby (AI voice). A separate TTS system voices this — do NOT produce audio yourself. Use to greet, ask questions, comment on observations, or suggest activities. When you ask a question, ALWAYS also call add_buttons() or rebuild_board() with answer buttons — the user cannot respond without them. Do NOT announce board changes or repeat yourself. Call interpret() BEFORE speak() when using both. Only call speak() once per turn.`,
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

function buildInterpretTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const level = config.interpretationLevel;
  const levelHint: Record<number, string> = {
    1: "ONLY use after a [BUTTON PRESS] — expand button labels into natural phrases. Never interpret from gestures or context alone.",
    2: "Use after button presses or clear gestures (nodding, pointing). If unsure, add a button instead of guessing.",
    3: "Interpret button presses, gestures, gaze, and contextual cues. Prefer voicing intent over silence.",
    4: "Actively speak for the user — interpret everything including emotions, attention, and environment.",
  };

  return {
    name: "interpret",
    description: `Speak on behalf of the user (student voice). TTS voices this in the student's own voice. ${levelHint[level] || "Interpret user intent from button presses and context."} Call interpret() BEFORE speak() when using both in the same turn. Do not interpret statements that the user has spoken clearly out loud. Only call this ONCE per observation/button press.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The interpreted message to speak in the student's voice." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence in this interpretation." },
      },
      required: ["text", "confidence"],
    },
  };
}

function buildTranscriptTool(_config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "transcript",
    description: `Record clear speech you heard from a person nearby. Only transcribe when you can confidently identify words — ignore silence, ambient noise, unintelligible audio, and background conversations. CRITICAL: If you recently called speak() or interpret(), you WILL hear those words echoed back through the microphone — that is YOUR OWN echo, not new speech. Never transcribe your own echoes.`,
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
    name: "context",
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
    description: `Add communication buttons to the AAC board. Max ${max} buttons total — call remove_buttons() first if full. Do not duplicate existing buttons or include Yes/No/Help/More (automatic).`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: { type: "string", description: "Comma-separated buttons: label|icon. Icon is an emoji, face:contactId, or symbol:symbolId. Example: \"Water|💧, Play|🎮, Go outside|🚪\"" },
      },
      required: ["buttons"],
    },
  };
}

function buildRemoveButtonsTool(config: ToolDeclarationConfig): FunctionDeclaration {
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

function buildRebuildBoardTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 12;
  return {
    name: "rebuild_board",
    description: `Replace the entire AAC board. Use after [BUTTON PRESS] inputs, major context shifts, or to create the initial board. Only call this once per turn. For minor changes, prefer add_buttons/remove_buttons. Max ${max} buttons, aim for ~${Math.min(8, max)}.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: { type: "string", description: "Comma-separated buttons: label|icon. Icon is an emoji, face:contactId, or symbol:symbolId. Example: \"Play|🎮, Music|🎵, Draw|✏️, Tired|😴\"" },
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

const PLAY_VIDEO: FunctionDeclaration = {
  name: "play_video",
  description: `Search and play a YouTube video. Only use with HIGH CONFIDENCE the user wants to watch something. Content is child-safety filtered.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "YouTube search query." },
    },
    required: ["query"],
  },
};

function buildOpenAppTool(enabledApps: AACAppDefinition[]): FunctionDeclaration {
  const appList = enabledApps.map(a => `"${a.id}" — ${a.name}: ${a.description}`).join("; ");
  return {
    name: "open_app",
    description: `Open an app for the user. Available: ${appList}. Only open with HIGH CONFIDENCE.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "The app ID to open." },
        data: { type: "string", description: "Optional data to pass to the app." },
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
  description: `Show large Yes/No overlay buttons IMMEDIATELY. Use when someone ELSE asks the user a yes/no question. Auto-dismisses after 5 seconds.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const ASK_YES_NO: FunctionDeclaration = {
  name: "ask_yes_no",
  description: `Show Yes/No overlay AFTER your speech finishes. Use when YOU ask the user a yes/no question with speak(). Auto-dismisses after 5 seconds.`,
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

// ---------------------------------------------------------------------------
// Builder — conditionally includes tools based on session config
// ---------------------------------------------------------------------------

export function buildToolDeclarations(config: ToolDeclarationConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  if (!config.isSilentMode) {
    declarations.push(buildSpeakTool(config));
  }

  if (config.interpretationLevel > 0) {
    declarations.push(buildInterpretTool(config));
  }

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

  if (config.youtubeEnabled) {
    declarations.push(PLAY_VIDEO);
  }

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

