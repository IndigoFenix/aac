// server/services/dual-agent/tool-declarations.ts
// Function declarations for live API native function calling.
// Supports both Gemini (FunctionDeclaration) and OpenAI (RealtimeFunctionTool) formats.
//
// IMPORTANT: For native-audio function-calling models, tool descriptions are the
// primary source of behavioral rules. The system prompt is kept minimal (identity +
// context only). All "when to use / when not to use" guidance lives HERE.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import type { RealtimeFunctionTool } from "openai/resources/realtime/realtime";
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
    description: `Say something to your user or people nearby (AI voice). A separate TTS system will voice this text — you do NOT produce audio yourself.

WHEN TO USE:
- Greet the user at the start of a session
- Ask questions to understand their intent
- Comment on what you observe to engage the user
- Suggest activities aligned with their goals
- Address other people present on behalf of your user (clarify who you're addressing)

WHEN NOT TO USE:
- In silent mode (disabled)
- While the user is talking to others — prefer interpret() instead
- Do NOT announce board changes
- Do NOT repeat the same thing you recently said

IMPORTANT: When you ask a question, you MUST also call add_buttons() or rebuild_board() with buttons that answer your question. The user cannot respond without relevant buttons.

ORDERING: If using both interpret() and speak() in the same turn, call interpret() FIRST.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak aloud. Must not be empty." },
      },
      required: ["text"],
    },
  };
}

function buildInterpretTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const level = config.interpretationLevel;
  const levelDesc: Record<number, string> = {
    1: `WHEN TO USE:
- ONLY immediately after a [BUTTON PRESS] input
- Expand button labels into natural phrases using conversation context
- Example: user presses "Water" → interpret("I want some water, please", confidence: "high")
- If meaning is obvious (yes/no to a question), you may just echo the label

WHEN NOT TO USE:
- Never from gestures, gaze, sounds, or context alone
- If no button was pressed, do NOT call interpret()
- If intent is unclear, add a button to the board instead`,
    2: `WHEN TO USE:
- After [BUTTON PRESS] inputs — expand labels into natural phrases
- From clear gestures (nodding, pointing, waving) or strong contextual cues
- When someone directly asks the user a question and you can infer their answer

WHEN NOT TO USE:
- Weak or ambiguous signals — add a button instead
- If you are guessing — use speak() to ask a clarifying question instead`,
    3: `WHEN TO USE:
- Button presses, gestures, gaze patterns, contextual cues
- Attempt to interpret unfamiliar gestures by reasoning about context
- Prefer interpreting over silence — your user benefits from having their intent voiced

WHEN NOT TO USE:
- Only if genuinely uncertain — add a button or ask with speak() instead`,
    4: `You are the user's autonomous voice. Actively speak for them.
- Interpret everything: button presses, gestures, emotional state, attention, environment
- When someone addresses your user, respond on their behalf
- Proactively engage in conversations for your user`,
  };

  return {
    name: "interpret",
    description: `Speak on behalf of the user (student voice). A separate TTS system voices this in the student's voice.

${levelDesc[level] || "Interpret user intent from button presses and context."}

ORDERING: Always call interpret() BEFORE speak() when using both in the same turn.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The interpreted message to speak in the student's voice. Must not be empty." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "How confident you are in this interpretation." },
      },
      required: ["text", "confidence"],
    },
  };
}

function buildTranscriptTool(config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "transcript",
    description: `Record clear speech you heard from a person nearby.

WHEN TO USE:
- You clearly hear someone speaking words you can confidently transcribe
- Include speaker identity if known (name, role, or "Unknown")

WHEN NOT TO USE:
- Silence, ambient noise, or unintelligible audio — do NOT transcribe
- Your own echoed TTS output — if you recently called speak() or interpret() and hear similar audio, that is YOUR echo. Ignore it completely.
- Background conversations that don't concern your user (TV, other groups talking)
- When you are not sure what was said

BACKGROUND NOISE: You may be in noisy environments. Only transcribe speech directed at or relevant to your user. Ignore background voices, TV audio, and distant conversations.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The transcribed speech. Must not be empty." },
        speaker: { type: "string", description: "Who spoke (e.g. 'Mom', 'Teacher', 'Daniel', 'Unknown')." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Transcription confidence." },
      },
      required: ["text", "speaker"],
    },
  };
}

function buildContextTool(config: ToolDeclarationConfig): FunctionDeclaration {
  return {
    name: "context",
    description: `Record environmental observations and context changes since the last turn.

WHEN TO USE — record any of these changes:
- New objects appearing in the environment
- Objects leaving the environment
- Objects the user is holding, reaching for, or looking at
- Gestures or facial expressions indicating a desire to communicate
- Sudden noises or sounds
- People arriving or leaving
- Changes in the user's attention or engagement

WHEN NOT TO USE:
- Nothing meaningful has changed — omit the call entirely
- Do NOT use this to narrate your own actions or thinking`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Description of what changed or what you observe. Must not be empty." },
      },
      required: ["text"],
    },
  };
}

function buildAddButtonsTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 12;
  let protectionNote = "";
  if (config.customBoardFixedButtons && config.customBoardFixedButtons.length > 0) {
    const available = max - config.customBoardFixedButtons.length - (config.customBoardAiAddedButtons?.length || 0);
    protectionNote = `\n\nCUSTOM BOARD ACTIVE: ${available} slots available. Cannot exceed ${max - config.customBoardFixedButtons.length} AI-added buttons total.`;
  }

  return {
    name: "add_buttons",
    description: `Add communication buttons to the AAC board.

WHEN TO USE:
- New objects, activities, or communication opportunities appear
- Someone asks the user a question — add likely response buttons
- You asked a question with speak() — add buttons that answer YOUR question
- Prioritize objects the user is holding or interested in

HARD LIMIT: Max ${max} buttons on the board. Call remove_buttons() first if the board is full.

BUTTON GUIDELINES:
- Each button needs a label (short text) and an icon (emoji, face:ID, or symbol:ID)
- Labels should be simple concepts clear from the icon alone
- No emojis in labels — only in the icon field
- Do not duplicate icons already on the board
- Do not include Yes, No, Help, or More — these are automatic${protectionNote}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Button text — short, clear concept (e.g. 'Water', 'Play', 'Go outside')." },
              icon: { type: "string", description: "Emoji (e.g. '💧'), or face:contactId, or symbol:symbolId." },
            },
            required: ["label", "icon"],
          },
          description: "Buttons to add to the board.",
        },
      },
      required: ["buttons"],
    },
  };
}

function buildRemoveButtonsTool(config: ToolDeclarationConfig): FunctionDeclaration {
  let protectionNote = "";
  if (config.customBoardFixedButtons && config.customBoardFixedButtons.length > 0) {
    protectionNote = `\n\nCUSTOM BOARD ACTIVE: You can ONLY remove buttons you previously added. Fixed board buttons (${config.customBoardFixedButtons.join(", ")}) cannot be removed.`;
  }

  return {
    name: "remove_buttons",
    description: `Remove buttons from the AAC board by label.

WHEN TO USE:
- Items are no longer relevant to the current context
- Need to make room before adding new buttons (board has a max of ${config.maxBoardItems || 12})
- Context has changed and old buttons are stale${protectionNote}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels of buttons to remove from the board.",
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
    description: `Replace the entire AAC board with a new set of buttons.

WHEN TO USE:
- Immediately after a [BUTTON PRESS] input — rebuild with contextually relevant follow-ups
- Major context shift requiring a completely new set of buttons
- Creating the initial board at session start

WHEN NOT TO USE:
- In response to audio or visual input alone — use add_buttons/remove_buttons instead
- Minor changes — use add_buttons/remove_buttons for incremental updates

NOTE: This exits any loaded custom board and returns to the default AI-generated board with a ${max}-button limit. Aim for about ${Math.min(8, max)} buttons.

BUTTON FORMAT: Same as add_buttons — each button needs label and icon.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Button text — short, clear concept." },
              icon: { type: "string", description: "Emoji (e.g. '💧'), or face:contactId, or symbol:symbolId." },
            },
            required: ["label", "icon"],
          },
          description: "Complete new set of buttons for the board.",
        },
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
    description: `Switch to a pre-built custom board. Available boards: ${boardList}.${loadedNote}

WHEN TO USE:
- The current activity or context matches one of the available custom boards
- Prefer this over rebuild_board() when a custom board fits — they have richer, curated content

WHEN NOT TO USE:
- Do NOT announce board switches with speak()
- Do NOT re-select the already loaded board

You will receive the board layout in the response.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        board_key: { type: "string", description: `The board key to load. One of: ${config.availableBoards.map(b => `"${b.key}"`).join(", ")}.` },
      },
      required: ["board_key"],
    },
  };
}

const PRESS_BUTTON: FunctionDeclaration = {
  name: "press_button",
  description: `Press a navigation button on the current custom board to navigate to a sub-page.

WHEN TO USE:
- Navigate within a loaded custom board to find relevant content
- Prefer navigating to sub-pages over generating new buttons from scratch

You will receive the navigation result in the response.`,
  behavior: Behavior.BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Label of the navigation button to press." },
    },
    required: ["label"],
  },
};

function buildEmoteTool(config: ToolDeclarationConfig): FunctionDeclaration {
  const current = config.currentEmote || "happy";
  return {
    name: "emote",
    description: `Set your avatar's displayed emotion. Current: ${current}.
- "happy" — encouraging, having fun (default)
- "sad" — empathizing with frustration or difficulty
- "neutral" — calm, serious, or confused

Only call when the emotional tone changes. Not needed every turn.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emotion: { type: "string", enum: ["happy", "sad", "neutral"], description: "The emotion to display on the avatar." },
      },
      required: ["emotion"],
    },
  };
}

const PLAY_VIDEO: FunctionDeclaration = {
  name: "play_video",
  description: `Search for and play a YouTube video for the user.
Only use with HIGH CONFIDENCE that the user wants to watch something. Content is filtered for child safety.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "YouTube search query describing the video to find." },
    },
    required: ["query"],
  },
};

function buildOpenAppTool(enabledApps: AACAppDefinition[]): FunctionDeclaration {
  const appList = enabledApps.map(a => `"${a.id}" — ${a.name}: ${a.description}`).join("; ");
  return {
    name: "open_app",
    description: `Open an app for the user. Available: ${appList}.
Only open with HIGH CONFIDENCE the user wants this app.`,
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
  description: `Remember a new person's face. Use when you see an unrecognized person and learn their name through conversation. Only use when confident about their identity.`,
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

const CALL_MONITOR: FunctionDeclaration = {
  name: "call_monitor",
  description: `Alert the monitor agent to check in.

WHEN TO USE:
- Progress or setbacks on student goals/objectives
- Need guidance on handling a situation
- Significant context shift (new person, new activity, location change)

Do NOT call repeatedly for the same event.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the monitor should check in. Must not be empty." },
    },
    required: ["reason"],
  },
};

const YES_NO: FunctionDeclaration = {
  name: "yes_no",
  description: `Show large Yes/No overlay buttons IMMEDIATELY. Use when someone ELSE asks the user a direct yes/no question (e.g. teacher asks "Do you want water?"). Auto-dismisses after 5 seconds.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const ASK_YES_NO: FunctionDeclaration = {
  name: "ask_yes_no",
  description: `Show Yes/No overlay AFTER your speech finishes. Use when YOU ask the user a yes/no question with speak(). The overlay waits for your speech to finish so the user hears the full question first. Auto-dismisses after 5 seconds.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {},
  },
};

const REQUEST_FOCUS: FunctionDeclaration = {
  name: "request_focus",
  description: `Request a high-resolution close-up frame for detailed analysis.

WHEN TO USE:
- Text or writing you need to read (book, paper, screen)
- Small or distant objects you can't identify
- Faces you need to see clearly
- Fine details like symbols or labels

Only request once per observation — do NOT repeat if already requested.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "What you want to see more clearly." },
    },
    required: ["reason"],
  },
};

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
    declarations.push(PRESS_BUTTON);
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
  // Reuse the Gemini builder and convert
  const geminiTools = buildToolDeclarations(config);
  const declarations = geminiTools[0]?.functionDeclarations || [];
  return declarations.map(toOpenAITool);
}
