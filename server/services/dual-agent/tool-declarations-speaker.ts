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
// Tool set:
//   - speak                  (fallback path only — omitted when native audio is in use)
//   - emote
//   - set_interaction_mode   (interact | assist — no standby)
//   - open_app / close_app / open_website
//   - call_monitor / debug_message  (shared)
// NOTE: interpret() moved to Board Manager — see tool-declarations-board-manager.ts.

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
  /** Legacy flag — kept for type compatibility. Speaker no longer runs in
   *  the resting profile (Coordinator closes the Speaker entirely on
   *  transition to resting and spins up a fresh one on wake), so the old
   *  resting-mode tool branch is dead. See AgentCoordinator.transitionToProfile. */
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
      `Say something to the user (AI voice). A separate TTS voices the text. One call per turn. Respond to ${T.tagPress} turns; don't echo the user's own SENTENCE back.`,
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

// set_interaction_mode moved to Observer (it has the camera/mic context
// to judge interact vs. assist). Removed from Speaker's surface. The
// earlier MALFORMED-bursts reasoning was a misdiagnosis — Speaker
// returns an empty tool list on native audio anyway (see the
// useDirectAudio guard above), so set_interaction_mode hasn't actually
// been present on the live native-audio surface for a while. Speaker
// receives [MODE] context injections from Coordinator after Observer's
// set_interaction_mode call.

/**
 * Set the target party for your next utterance. When omitted, the
 * target defaults to USER. Set to a person's name (e.g. "Mom",
 * "Teacher") when you intend to speak TO that person rather than the
 * user. The target is consumed by the NEXT speak()/audio turn and
 * resets afterwards.
 */
const SET_SPEECH_TARGET: FunctionDeclaration = {
  name: "set_speech_target",
  description:
    `Set who your NEXT utterance is addressed to. Default is USER. Call this before speaking when you intend to address a specific other person in the room (caregiver, teacher, sibling). One-shot — resets to USER after your next speech turn.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: `"USER" (default), or a specific person's name.`,
      },
    },
    required: ["target"],
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
  // TEMPORARY DIAGNOSTIC: disable Speaker's tool surface entirely. If
  // MALFORMED_FUNCTION_CALL disappears with zero tools declared, we
  // know the failure is rooted in the tool surface (model attempting a
  // call that fails Vertex's parser). If MALFORMED persists, the
  // problem lies elsewhere in the prompt / config. Revert by removing
  // this early return.
  if (config.useDirectAudio && !config.isMutedMode) {
    return [];
  }

  const declarations: FunctionDeclaration[] = [];

  // Speaker only runs in the awake profile in the current design — the
  // Coordinator closes the Speaker session entirely when transitioning to
  // resting. So there's no resting-profile tool surface to build.
  if (!config.isMutedMode && !config.useDirectAudio) {
    declarations.push(buildSpeakTool());
  }

  // interpret() moved to Board Manager — it has the freshest context
  // about the SUGGESTIONs the user composed with, and removing it from
  // Speaker shrinks the native-audio tool surface (better function-
  // calling reliability + no more spurious interpret-on-button-press).

  declarations.push(buildEmoteTool());
  // set_interaction_mode moved to Observer — Speaker no longer
  // declares it. Speaker learns the current mode from [MODE] context
  // injections forwarded by Coordinator after Observer's call.
  // SET_SPEECH_TARGET also kept undeclared — its earlier addition was
  // an independent change and didn't fix the MALFORMED, so we leave it
  // out unless target-setting becomes a user-requested feature.

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
