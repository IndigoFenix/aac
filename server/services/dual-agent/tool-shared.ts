// server/services/dual-agent/tool-shared.ts
//
// Tool declarations shared across all three agents in the three-agent
// architecture (Observer, Speaker, Board Manager). See
// planning-docs/aac-agent-responsibility-split.md.
//
// Each declaration uses `parametersJsonSchema` to match the existing
// single-agent path; the Vertex Live API + Gemini Flash both accept this
// format for function calls.

import { Behavior, type FunctionDeclaration } from "@google/genai";

/**
 * `call_monitor` — any agent can request a Monitor check-in. The
 * Coordinator de-dupes simultaneous calls within a debounce window and
 * broadcasts the Monitor's response context injection to all three agents.
 *
 * The description deliberately says "the monitor" generically rather than
 * "your supervisor" — Observer / Speaker / Board Manager each have a
 * different relationship to the Monitor and the prompt for each agent
 * frames it in agent-appropriate terms.
 */
export const CALL_MONITOR: FunctionDeclaration = {
  name: "call_monitor",
  description:
    "Alert the monitor system to check in on this session. Use for goal progress/setbacks, guidance needs, or significant context shifts. DO NOT narrate this action to the user or refer to the monitor at any time — the monitor is part of your own internal system. The response (a context update) may take some time to return; continue your work normally until it arrives. Do NOT call repeatedly for the same event — your sibling agents share this signal and the system de-dupes calls within a short window.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the monitor should check in." },
    },
    required: ["reason"],
  },
};

/**
 * `private_note` — silent breadcrumb visible to the developer / Monitor
 * but never voiced or shown to the user. Cheap scratch space; shared by
 * all three agents so each can log per-agent reasoning.
 */
export const PRIVATE_NOTE: FunctionDeclaration = {
  name: "private_note",
  description:
    "Record a private thought or note. The note is saved to your conversation history and visible to the developer / monitor agent, but is NEVER spoken to the user or shown on the device. Use this when you want to log reasoning, observations, plans, or intentions without producing visible output. Keep notes short and specific. NEVER produce text or audio beginning with \"[note]\", \"[thinking]\", \"[private note]\", or any similar bracketed marker — anything you emit aloud or to the board reaches the user. Use this tool instead.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "Your private thought (one short sentence)." },
    },
    required: ["note"],
  },
};

/**
 * `debug_message` — only present when AAC_DEBUG_INTROSPECTION=1. Used by
 * the system to ask the model what it was trying to do when a turn was
 * rejected. Bypasses the audio safety filter that would otherwise
 * RESPONSE_REJECT the explanation itself.
 */
export const DEBUG_MESSAGE: FunctionDeclaration = {
  name: "debug_message",
  description:
    "System diagnostic tool. When the system tells you a response was rejected or malformed and asks what you were trying to do, call this function with your explanation. Do NOT call this unless explicitly asked by a [DEBUG] system message.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "What you were trying to do — the function you were calling and/or what you were going to say.",
      },
    },
    required: ["message"],
  },
};

/** Whether the debug introspection tool should be included on this run.
 *  Centralized so every agent agrees on the same flag. */
export function debugIntrospectionEnabled(): boolean {
  return process.env.AAC_DEBUG_INTROSPECTION === "1";
}
