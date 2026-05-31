// server/services/dual-agent/tool-declarations-speaker.ts
//
// Speaker Agent tool surface for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Speaker holds the personality and is the only agent that produces voice.
// It receives text turns from the Coordinator (button presses, transcribed
// speech from Observer, sentence-builder plays, context updates) and
// decides whether and how to respond.
//
// Tool set (~8 + 3 shared):
//   - speak                  (fallback path only — omitted when native audio is in use)
//   - interpret              (voice the user's composed sentence through student TTS)
//   - emote
//   - set_interaction_mode   (interact | assist — no standby)
//   - open_app / close_app / open_website
//   - call_monitor / private_note / debug_message  (shared)

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import { flattenPermittedWebsites } from "@shared/permitted-websites";
import type { PermittedWebsite } from "@shared/schema";
import type { AACAppDefinition } from "./types";
import { T } from "../memory-schema/canonical-terms";
import {
  CALL_MONITOR,
  PRIVATE_NOTE,
  DEBUG_MESSAGE,
  debugIntrospectionEnabled,
} from "./tool-shared";

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface SpeakerToolConfig {
  /** When true, Speaker speaks directly via Live native audio — the
   *  speak() tool is omitted. When false (fallback path), speak() is
   *  declared and the relay routes text through server-side TTS. */
  useDirectAudio: boolean;
  /** When true, Speaker is in RESTING-mode — smaller tool set, may still
   *  answer a brief direct question via speak() when not using native audio. */
  restingMode?: boolean;
  /** When true, Speaker is in MUTED mode (cave-toggled user state) — it
   *  doesn't talk to the user; the speak() / interpret() interaction
   *  pattern changes. The Coordinator still forwards user turns; Speaker
   *  decides whether to vocalize them. */
  isMutedMode?: boolean;

  /** Built-in apps available to this session (e.g. youtube, spotify). */
  enabledApps: AACAppDefinition[];
  /** Custom (clinician-authored) games assigned to this student. */
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  /** Websites Speaker is permitted to open via the in-frame browser. */
  permittedWebsites?: PermittedWebsite[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildSpeakTool(): FunctionDeclaration {
  return {
    name: "speak",
    description:
      `Say something to the user or people nearby (AI voice). A separate TTS system voices this — do NOT produce audio yourself. Use to greet, ask questions, comment on observations, or suggest activities. Your sibling Board Manager builds the response surface independently after you finish; you don't need to call any board tool here. Do NOT announce board changes or repeat yourself. When a ${T.tagPress} arrives, the user's SENTENCE has already been voiced by the device; do NOT repeat or paraphrase it — respond naturally. Only call speak() once per turn.`,
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
 * `interpret` — voice on behalf of the user, using the student's TTS.
 *
 * Called ONLY in response to a ${T.tagComposed} turn. The model produces
 * the natural-language SENTENCE in first-person — what the user would
 * say if they could speak directly — and the system pipes it through the
 * student-voice TTS so the room hears the SENTENCE in the user's voice.
 *
 * After interpret() runs, the Coordinator routes the resulting transcript
 * to Observer (as `[OWN_SPEECH]` tagged student) and to Board Manager
 * (which rebuilds the follow-up response surface). You DO NOT need to
 * call speak() or any board tool on the same turn — those happen on a
 * later turn after you receive the follow-up [BUTTON PRESS] / context
 * injection from Board Manager.
 */
function buildInterpretTool(): FunctionDeclaration {
  return {
    name: "interpret",
    description:
      `Voice a natural-language SENTENCE through the USER'S TTS voice. Call this ONLY in response to a ${T.tagComposed} turn — never spontaneously, and never in response to a regular ${T.tagPress} (those carry a pre-baked SENTENCE that TTS plays automatically). The 'sentence' argument MUST be first-person, as the user would say it ("I want a banana", "I'm tired and I want a hug from Mom"), and MUST follow the <sentence_interpretation> rules — read the composed SENTENCE creatively using the user's interests, don't echo individual SYMBOLs one by one. After interpret() finishes the student voice, the system routes a follow-up context to you on a later turn — respond THEN (speak), not in the interpret turn itself.`,
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

function buildEmoteTool(): FunctionDeclaration {
  return {
    name: "emote",
    description:
      "Set avatar emotion: happy (encouraging), sad (empathizing), or neutral (calm/serious). Only call when the emotional tone changes.",
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emotion: {
          type: "string",
          enum: ["happy", "sad", "neutral"],
          description: "The emotion to display.",
        },
      },
      required: ["emotion"],
    },
  };
}

/**
 * Behavioral mode within an active session. `standby` from the legacy
 * single-agent tool has been retired in the three-agent path — Observer's
 * `rest` is the engagement-state equivalent. Speaker's mode here is
 * purely about conversational stance.
 */
const SET_INTERACTION_MODE: FunctionDeclaration = {
  name: "set_interaction_mode",
  description:
    `Switch between interaction modes. "interact" = you speak and engage actively with the user, initiating conversation and commenting on observations from Observer. "assist" = you stay quiet and only respond when the user explicitly addresses you (the avatar appears sleepy); the user is busy with another person or in a situation where proactive speech would be intrusive. To stop driving the session entirely when the user steps away, your sibling Observer agent will call rest()/sleep() — you don't manage that.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["interact", "assist"],
        description: "The mode to switch to.",
      },
      reason: { type: "string", description: "Brief reason for the mode change." },
    },
    required: ["mode"],
  },
};

function buildOpenAppTool(
  enabledApps: AACAppDefinition[],
  customApps: NonNullable<SpeakerToolConfig["availableCustomApps"]> = [],
): FunctionDeclaration {
  const builtInIds = enabledApps.map(a => a.id).join(", ");
  const customIds = customApps.map(a => a.id).join(", ");
  const sections = [builtInIds ? `Built-in app IDs: ${builtInIds}.` : ""];
  if (customIds) sections.push(`Custom game IDs: ${customIds}.`);
  return {
    name: "open_app",
    description:
      `Open an interactive app or custom game on the user's screen. See the "Apps" section in your system prompt for details. ${sections.filter(Boolean).join(" ")}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "The app ID to open (either a built-in app id or a custom game id).",
        },
        data: {
          type: "string",
          description: "Optional search query for media apps (YouTube/Spotify).",
        },
      },
      required: ["app_id"],
    },
  };
}

const CLOSE_APP: FunctionDeclaration = {
  name: "close_app",
  description: "Close the currently open app.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: { type: "object", properties: {} },
};

function buildOpenWebsiteTool(permitted: PermittedWebsite[]): FunctionDeclaration {
  const flat = flattenPermittedWebsites(permitted);
  const list = flat
    .map(w => `- "${w.label}" (${w.url})${w.description ? ` — ${w.description}` : ""}`)
    .join("\n");
  return {
    name: "open_website",
    description:
      `Open a permitted website in the in-frame browser app on the user's screen. Only URLs covered by the permitted-sites list below may be opened — any other URL will be rejected. Subpages of a permitted URL are also permitted. Use this when the user asks to read, browse, or look something up that maps to one of these sites. Board Manager will populate contextual buttons for the site after you open it — you don't need to. Permitted sites:\n${list}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to open. Must match a permitted site prefix.",
        },
        label: {
          type: "string",
          description: "Short label for the site or page (e.g. 'Wikipedia: Cats'). Optional — used for display only.",
        },
      },
      required: ["url"],
    },
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildSpeakerToolDeclarations(config: SpeakerToolConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  // RESTING profile for Speaker: it can still answer a brief direct
  // question (when native audio is off, speak() is its mechanism).
  // No board, no apps, no mode switching, no private_note.
  if (config.restingMode) {
    if (!config.useDirectAudio) declarations.push(buildSpeakTool());
    if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);
    return [{ functionDeclarations: declarations }];
  }

  // Awake profile.
  if (!config.isMutedMode && !config.useDirectAudio) {
    declarations.push(buildSpeakTool());
  }

  // interpret() is declared so Speaker can voice the user's intent when
  // they play a SENTENCE from the SENTENCE BUILDER. Always declared
  // regardless of native vs. tool audio — it routes through student TTS,
  // not AI voice.
  declarations.push(buildInterpretTool());

  declarations.push(buildEmoteTool());
  declarations.push(SET_INTERACTION_MODE);

  // Apps + websites
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

  // Shared (private_note intentionally omitted — was suppressing speech
  // output via over-eager note-taking).
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
