// server/services/dual-agent/tool-declarations-observer.ts
//
// Observer Agent tool surface for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Goal: mirror the single-agent path's perception tools as closely as
// possible. Same schemas, same descriptions where they overlap. Observer
// is the subset of the single-agent tool surface that doesn't speak and
// doesn't manage the board.
//
// Tool set:
//   - transcript          (same schema as single-agent — no direction field)
//   - update_context      (same schema as single-agent)
//   - request_focus       (same)
//   - rest / sleep / end_session  (engagement state; wake_up only in resting)
//   - call_monitor / private_note / debug_message  (shared)

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
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

export interface ObserverToolConfig {
  /**
   * RESTING profile selects a smaller tool set — the model is watching
   * passively and can only wake the session back up.
   */
  restingMode?: boolean;
}

// ---------------------------------------------------------------------------
// Tools — mirrored from the single-agent path's tool-declarations.ts
// ---------------------------------------------------------------------------

function buildTranscriptTool(): FunctionDeclaration {
  // Identical to the single-agent path's transcript tool. An earlier
  // attempt added a `direction` field (device/user/ambient) so the
  // routing layer could decide whether Speaker should respond; that
  // changed the tool the model already knew and started producing
  // MALFORMED_FUNCTION_CALL on every transcript. Reverted to the
  // original 3-field schema; Speaker's prompt + the conversation flow
  // decide whether to respond.
  return {
    name: "transcript",
    description:
      `Record clear speech you heard from a person nearby (someone speaking in their own voice through the room, not via the AAC device, and not your sibling Speaker agent's voice playing through the speakers — that arrives as an [OWN_SPEECH] context note). Only transcribe when you can confidently identify words — ignore silence, ambient noise, unintelligible audio, and background conversations. DO NOT transcribe your own voice echoing back through the mic, and DO NOT transcribe the device's TTS playing back the ${T.button} the user pressed.`,
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

function buildUpdateContextTool(): FunctionDeclaration {
  // Identical to the single-agent path's update_context tool.
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

function buildRequestFocusTool(): FunctionDeclaration {
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
// Engagement-state tools — Observer owns these in the three-agent path.
// Schemas mirror the single-agent path verbatim.
// ---------------------------------------------------------------------------

const REST: FunctionDeclaration = {
  name: "rest",
  description:
    `Drop the session into RESTING mode — call when the user is not communicating with you or using the ${T.board} to communicate with others around them. You keep watching quietly through the camera/mic at low cost and can still answer a direct question, but you stop driving the board. The session wakes the moment they press an AAC button or turn to the device to communicate. NOTE: you cannot rest within 10 seconds of an AAC button press — the user is still mid-interaction.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason you're resting (e.g. 'Daniel is chatting with his mother and not using the board', 'absorbed in the game')." },
    },
    required: ["reason"],
  },
};

const WAKE_UP: FunctionDeclaration = {
  name: "wake_up",
  description: `Escalate the session from RESTING mode back to full interaction. Call this ONLY when the user is settling in to actually USE the device — they look at it and address you, press a button, or clearly want to communicate through the board. Do NOT call this for background activity, passing voices, or a single direct question you can answer briefly without waking.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason you're waking the session (e.g. 'Daniel turned to the device and said my name', 'button pressed')." },
    },
    required: ["reason"],
  },
};

const SLEEP: FunctionDeclaration = {
  name: "sleep",
  description: `Mark the session as Asleep — user is not present but might return. Call when the user has stepped away or appears disengaged for an extended period. While Asleep the system stops sending mic audio and image data, saving tokens. The session resumes automatically when activity is detected. Do NOT call sleep() if the user is actively engaged.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: { type: "object", properties: {} },
};

const END_SESSION: FunctionDeclaration = {
  name: "end_session",
  description: `End the current session. The session enters Hibernation. No further audio or video is captured until the user explicitly re-engages (avatar tap, AAC button press, or sustained eye contact). Use only when you're confident the conversation is complete and the user has fully disengaged.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: { type: "object", properties: {} },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildObserverToolDeclarations(config: ObserverToolConfig = {}): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  if (config.restingMode) {
    // RESTING profile: smallest possible surface.
    declarations.push(WAKE_UP);
    declarations.push(buildTranscriptTool());
    declarations.push(buildUpdateContextTool());
    if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);
    return [{ functionDeclarations: declarations }];
  }

  // AWAKE profile — match the single-agent's perception surface.
  // private_note is intentionally omitted — over-eager note-taking was
  // suppressing actual transcript/update_context tool calls.
  declarations.push(buildTranscriptTool());
  declarations.push(buildUpdateContextTool());
  declarations.push(buildRequestFocusTool());
  declarations.push(REST);
  declarations.push(SLEEP);
  declarations.push(END_SESSION);
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
