// server/services/dual-agent/types.ts
// Type definitions for the dual-agent AAC system

import type { ChatMessage, ParsedBoardData } from "@shared/schema";
import type { LLMProviderKey } from "@shared/llm-options";

/**
 * Interaction mode for the AAC system.
 * - 'interact': AI companion talking TO the user (conversational, short button labels)
 * - 'silent':   AI silently observes, helps user talk to OTHERS (utterance-style buttons, no text/audio)
 */
export type AACInteractionMode = 'interact' | 'silent';

/**
 * Message as seen by the Interactive Agent
 * Monitor's messages appear as system messages
 */
export interface InteractiveMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  // Source of system messages (for debugging)
  source?: "monitor" | "user" | "context";
}

/**
 * Message as seen by the Monitor Agent
 * Monitor's injected commands appear as its own assistant messages
 */
export interface MonitorMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  // Whether this was an injected command
  isInjectedCommand?: boolean;
}

/**
 * Pending message - cached while Monitor is busy
 */
export interface PendingMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  // Context at time of message
  boardState?: ParsedBoardData;
  visualContext?: string;
  audioContext?: string;
}

/**
 * Special commands the Interactive agent can trigger
 * Commands start with # as first character
 */
export const INTERACTIVE_COMMANDS = {
  THINK: "#think", // Enter thinking mode (Monitor takes over)
  PAUSE: "#pause", // Pause for Monitor to process
  HELP: "#help", // Request help from Monitor
} as const;

/**
 * Special commands the Monitor can send to Interactive
 */
export const MONITOR_COMMANDS = {
  RESUME: "#resume", // Exit thinking mode, Interactive takes over
  UPDATE_PROMPT: "#update_prompt", // Update Interactive's system prompt
  INJECT_CONTEXT: "#context", // Inject context information
} as const;

/**
 * Session state for dual-agent system
 */
export interface DualAgentSessionState {
  // Core session info
  sessionId: string;
  studentId: string;
  userId?: string;

  // Agent states
  interactivePrompt: string; // Full prompt for Interactive agent
  thinkingMode: boolean; // Is Monitor responding directly?
  monitorBusy: boolean; // Is Monitor currently processing?
  monitorBusySince?: number; // Timestamp when Monitor started (for staleness detection)

  // Message states
  messages: ChatMessage[]; // Main message log (Monitor's view)
  pendingMessages: PendingMessage[]; // Cached while Monitor busy

  // Interaction mode
  interactionMode: AACInteractionMode;

  // Board state
  currentBoard?: ParsedBoardData;

  // Timestamps
  lastInteractiveActivity: number;
  lastMonitorActivity: number;
}

/**
 * Response from Interactive agent
 */
export interface InteractiveResponse {
  // The text response (AI voice, may start with # for commands)
  text: string;
  // Updated board buttons
  board?: ParsedBoardData;
  // Was this a command?
  isCommand: boolean;
  // Parsed command if any
  command?: string;
  // Token usage from the provider (for credit tracking)
  usage?: { promptTokens: number; completionTokens: number };
  // Detection diff: buttons to add to blank slots
  addButtons?: Array<{ label: string; iconRef: string }>;
  // Detection diff: labels of buttons to remove
  removeLabels?: string[];
  // Full board rebuild (replaces all buttons)
  rebuildBoard?: Array<{ label: string; iconRef: string }>;
  // Message inferred from gestures/context to process as user input
  triggeredMessage?: string;
  // Student's interpreted intent (student voice) — mutually exclusive with text
  interpretation?: string;
  // What AI saw and why (debug/moderator only)
  debugDescription?: string;
  // Voice transcript from audio input
  transcript?: string;
  // Who spoke the transcript
  transcriptSpeaker?: string;
  // Environmental context changes observed
  contextUpdate?: string;
}

/**
 * Response from Monitor agent
 */
export interface MonitorResponse {
  // Direct response (if in thinking mode)
  text?: string;
  // Updated board (if in thinking mode)
  board?: ParsedBoardData;
  // Command to send to Interactive
  command?: string;
  // Updated prompt for Interactive
  updatedPrompt?: string;
  // Context to inject
  contextInjection?: string;
}

/**
 * Identified person from frontend biometric recognition
 */
export interface IdentifiedPersonContext {
  id: string;
  type: "student" | "user";
  name: string;
  relationship?: string; // 'student', 'parent', 'teacher', etc.
  confidence: number;
  method: "face" | "voice" | "both";
}

/**
 * Input for processing a user message
 */
export interface DualAgentInput {
  sessionId?: string;
  studentId: string;
  userId?: string;

  // The user's input
  message?: string;
  audioBlob?: Buffer;

  // Image input (base64 data URL or URL)
  imageData?: string; // data:image/jpeg;base64,... or https://...

  // Person identification (from frontend biometric recognition)
  identifiedPerson?: IdentifiedPersonContext;

  // Current context
  board?: ParsedBoardData;
  visualContext?: string;
  audioContext?: string;

  // Face & hand gesture context (serialized summary of recent events from client-side tracking)
  gestureContext?: string;

  // Language settings
  language?: string;

  // Interaction mode: 'interact' (conversational) or 'silent' (buttons only, no text/voice)
  interactionMode?: AACInteractionMode;
}

/**
 * Output from dual-agent processing
 */
export interface DualAgentOutput {
  sessionId: string;

  // Response (from Interactive or Monitor depending on mode)
  text: string;
  board?: ParsedBoardData;

  // Audio response (if TTS enabled)
  audioChunks?: AsyncGenerator<Buffer>;

  // State info
  thinkingMode: boolean;
  monitorBusy: boolean;
}

/**
 * Configuration for the dual-agent system
 */
export interface DualAgentConfig {
  // Model settings
  interactiveModel: string; // Default: gpt-4o-mini
  monitorModel: string; // Default: gpt-4o

  // Provider for interactive agent (for credit tracking)
  interactiveProvider?: LLMProviderKey;

  // Timeouts
  interactiveTimeout: number; // Max ms for Interactive response
  monitorTimeout: number; // Max ms for Monitor processing

  // Voice settings
  enableTTS: boolean;

  // Debug
  debug: boolean;
}

/**
 * Input for continuous detection (camera-based environment observation)
 */
export interface DetectionInput {
  sessionId?: string;
  studentId: string;
  userId?: string;
  imageData?: string;        // base64 data URL from camera
  audioContext?: string;     // ambient audio transcription (text fallback)
  audioBuffer?: Buffer;      // raw ambient audio for native processing
  audioMimeType?: string;    // mime type of audioBuffer (e.g. "audio/webm")
  gestureContext?: string;   // serialized face expression & hand gesture events
  board?: ParsedBoardData;   // current board state
  interactionMode?: AACInteractionMode;
}

/**
 * Output from continuous detection
 */
export interface DetectionOutput {
  sessionId: string;
  addButtons?: Array<{ label: string; iconRef: string }>;
  removeLabels?: string[];
  rebuildBoard?: Array<{ label: string; iconRef: string }>; // full board replacement
  changed: boolean;          // whether buttons were updated
  text?: string;             // AI voice (speak field) — only when high confidence
  triggeredMessage?: string; // deprecated: use interpretation instead
  interpretation?: string;         // student's interpreted intent (student voice)
  interpretationAudio?: string;    // base64 audio (student voice TTS)
  debugDescription?: string;       // what AI saw/decided
  transcript?: string;             // voice transcript from audio input
  transcriptSpeaker?: string;      // who spoke the transcript
  contextUpdate?: string;          // environmental context changes observed
  error?: string;                  // error message if processing failed
}

export const DEFAULT_CONFIG: DualAgentConfig = {
  interactiveModel: "gpt-4o-mini",
  monitorModel: "gpt-4o",
  interactiveTimeout: 5000,
  monitorTimeout: 30000,
  enableTTS: true,
  debug: false,
};
