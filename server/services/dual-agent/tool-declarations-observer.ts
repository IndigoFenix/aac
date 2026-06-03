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
   * Legacy flag, kept for type compatibility with the older profile API
   * but no longer used — Observer's tool surface is constant across
   * awake/resting profiles. See buildObserverToolDeclarations.
   */
  restingMode?: boolean;
}

// ---------------------------------------------------------------------------
// Tools — mirrored from the single-agent path's tool-declarations.ts
// ---------------------------------------------------------------------------

function buildTranscriptTool(): FunctionDeclaration {
  return {
    name: "transcript",
    description:
      `Record clear in-person speech you heard. Identify both the SPEAKER and the TARGET (who they were speaking to). DO NOT transcribe the device's TTS playing back the ${T.button} the user just pressed; DO NOT transcribe your sibling Speaker agent's voice coming out of the room speakers (that arrives as an [OWN_SPEECH] context note).

Speaker/target values (ALWAYS in English, regardless of conversation language):
  - "DEVICE"  — the AI itself. Use as TARGET when the person is addressing the AI (looking at the screen, using the AI's name, responding to the AI's last utterance).
  - "USER"    — the active user (the student if present; otherwise the most prominent person at the device who is looking at the screen). The student's actual name is also accepted in place of "USER" and treated as equivalent — write it in its Latin-letter form (e.g. "Daniel", not the Hebrew/other-script spelling).
  - "UNKNOWN" — reserve for cases where the speaker or target genuinely can't be identified (off-camera voice, a stranger). Do NOT use UNKNOWN just because you're unsure between USER and DEVICE — make a best guess.
  - Any other identified third party — caregiver / sibling / teacher etc. Use a SHORT English label or the person's name in Latin letters (e.g. "Mom", "Teacher", "Yael"); never use non-Latin scripts in this field even if the spoken language is Hebrew, Arabic, etc.

YOU decide definitively who is addressing whom. Err on the side of USER or DEVICE rather than UNKNOWN whenever either is plausible.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The transcribed speech." },
        speaker: { type: "string", description: "Who spoke. DEVICE / USER / UNKNOWN / an identified name." },
        target: { type: "string", description: "Who the speech is directed at. DEVICE / USER / UNKNOWN / an identified name." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Transcription confidence." },
      },
      required: ["text", "speaker", "target"],
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

/**
 * Behavioral mode switch — Observer owns this because Observer has the
 * camera/mic context to judge whether the user is conversing with the AI
 * vs. someone else in the room. The Coordinator forwards the resulting
 * [MODE] context injection to Speaker so it knows whether to chat
 * directly (companion) or stay quiet and support a human-to-human
 * conversation (facilitator).
 */
const SET_INTERACTION_MODE: FunctionDeclaration = {
  name: "set_interaction_mode",
  description:
    `Switch the AI's behavioral mode. "companion" = the AI is the user's conversation partner; Speaker chats back, asks follow-ups, drives the dialogue. "facilitator" = the AI supports the user in talking to ANOTHER PERSON in the room (parent, sibling, teacher, friend); Speaker stays quiet and lets the board do the talking. Use this when you observe the user shift between the two modes (e.g. someone walks in and starts talking with the user → facilitator; the other person leaves or the user turns back to the screen alone → companion). The mode is then forwarded to Speaker as a context note.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["companion", "facilitator"],
        description: "The mode to switch to.",
      },
      reason: { type: "string", description: "Brief reason for the mode change (e.g. 'Mom just walked in and started talking with Daniel')." },
    },
    required: ["mode"],
  },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildObserverToolDeclarations(_config: ObserverToolConfig = {}): Tool[] {
  // Observer's tool surface is constant — Observer runs across BOTH awake
  // and resting profiles (the simplified design: resting just shuts off
  // Speaker + BoardManager, Observer keeps observing). The old
  // restingMode-narrowed surface dropped request_focus/rest/sleep/call_monitor
  // which were exactly the tools Observer needed to actively manage the
  // session — removing them in resting mode meant Observer couldn't even
  // request a wake_up via sleep-state transitions. WAKE_UP is also retained
  // because Observer can self-wake via the engagement_change route.
  //
  // private_note is intentionally omitted — over-eager note-taking was
  // suppressing actual transcript/update_context tool calls.
  const declarations: FunctionDeclaration[] = [];
  declarations.push(buildTranscriptTool());
  declarations.push(buildUpdateContextTool());
  declarations.push(buildRequestFocusTool());
  declarations.push(SET_INTERACTION_MODE);
  declarations.push(WAKE_UP);
  declarations.push(REST);
  declarations.push(SLEEP);
  declarations.push(END_SESSION);
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
