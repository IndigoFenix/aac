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

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface ToolDeclarationConfig {
  enabledApps: AACAppDefinition[];
  availableBoards: Array<{ key: string; name: string }>;
  /** Custom apps (games) assigned to this student. */
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
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
  /** Websites the AI is permitted to open via the browser app. */
  permittedWebsites?: PermittedWebsite[];
}

// ---------------------------------------------------------------------------
// Button format description (shared by add_buttons and rebuild_board)
// ---------------------------------------------------------------------------

const BUTTON_FORMAT_ADD = "Comma-separated buttons: label|icon|imageKey|sentence|rowSpan|colSpan. The 'sentence' field is what the BUTTON itself will speak when tapped — phrase it as the words the user would say (first-person, e.g. \"I want water\"). imageKey should depict the user when relevant, use terms like 'boy', 'girl', 'person', etc. rowSpan/colSpan are optional (default 1). Example: \"Water|💧|boy_drinking_water|I want water, Play|🎮|girl_listening_to_music|I want to play, Park|🏞️|child_on_playground|Let's go to the park\"";

const BUTTON_FORMAT_REBUILD = "Comma-separated buttons: label|icon|imageKey|sentence|rowSpan|colSpan. The 'sentence' field is what the BUTTON itself will speak when tapped — phrase it as the words the user would say (first-person, e.g. \"I want to play\"). imageKey should depict the user when relevant, use terms like 'boy', 'girl', 'person', etc. rowSpan/colSpan are optional (default 1). Example: \"Play|🎮|boy_playing_video_game|I want to play, Music|🎵|girl_listening_to_music|Put on some music, Draw|✏️|child_drawing_picture|I want to draw, Tired|😴|person_yawning|I am tired\"";

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
    description: `Record clear speech you heard from a person nearby (someone speaking in their own voice through the room, not via the AAC device). Only transcribe when you can confidently identify words — ignore silence, ambient noise, unintelligible audio, and background conversations. DO NOT transcribe your own voice echoing back through the mic, and DO NOT transcribe the device's TTS playing back a button the user pressed — both are device output, not new speech, and you already have the [BUTTON PRESS] text turn for the latter (respond to that turn normally, just don't call transcript() for the echo).`,
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
    description: `Replace the main AAC board (right side, up to 8 buttons). Use after [BUTTON PRESS] inputs or major conversation shifts.

The optional 'response' parameter is where you DECLARE what you are saying aloud in this same turn. You still speak the words yourself via your normal voice output — the parameter is your written commitment to that speech, not a substitute for it. Writing it here helps you actually produce the audio.

If a custom board is currently loaded, calling this will unload it and replace it with your new dynamic board. The context sidebar (left) is separate — use add_context_button() for that. Don't reuse the same imageKey more than once on one board.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        response: {
          type: "string",
          description: "Optional. What you are saying aloud in this turn. Speak the same words via your voice — this parameter is a declaration of your intent, not a TTS source. Useful for [BUTTON PRESS] responses (e.g. for 'I want to play' → response: 'Sure! What would you like to play with?'). The system logs this for monitoring and displays it as text in the UI alongside your spoken audio.",
        },
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
        button: { type: "string", description: "Single button: label|icon|imageKey|sentence." },
      },
      required: ["button"],
    },
  };
}

const SET_INTERACTION_MODE: FunctionDeclaration = {
  name: "set_interaction_mode",
  description: `Switch between interaction modes. "interact" = you speak and engage actively with the user, initiating conversation and commenting on observations. "assist" = you stay quiet and only respond when the user explicitly gets your attention; the avatar appears sleepy. Use "assist" when the user is busy with another person or in a situation where proactive speech would be intrusive. "standby" = the student is not present (not visible AND not heard) — don't proactively start conversation or treat the visible person as the student, but still respond to button presses and direct questions and update the board for them; the avatar appears resting. Use "interact" to re-engage when the student shows interest or returns.`,
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
  description: `Use this when you have decided NOT to produce a spoken response this turn. Examples of valid reasons: a voice you heard was background TV / another person's conversation not directed at you; the student is engaged with media and shouldn't be interrupted; you logged an observation but no reply is needed. Pass a brief reason — the system uses this signal to know your silence was intentional rather than a missed turn. Do NOT call stay_silent as a placeholder for "I'll think before responding" — if you intend to speak, just speak. Do NOT call it before or after speaking on the same turn.`,
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

  declarations.push(buildCallMonitorTool(config));
  declarations.push(YES_NO);
  declarations.push(ASK_YES_NO);
  // declarations.push(buildRequestFocusTool(config));
  declarations.push(SET_INTERACTION_MODE);
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
  declarations.push(PRIVATE_NOTE);
  declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
