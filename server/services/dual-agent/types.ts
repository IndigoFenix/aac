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
 * Response mode for the AAC system.
 * - 'fast':    Output voice/board tokens FIRST, then observation tokens (reduces time-to-first-audio)
 * - 'analyze': Output observation tokens FIRST, then voice/board tokens (current default behavior)
 */
export type AACResponseMode = 'fast' | 'analyze';

/**
 * Interpretation aggressiveness level (per-student setting).
 * 0: No [INTERPRET] output at all
 * 1: Minimal — only after button presses
 * 2: Conservative — buttons + known gestures (default)
 * 3: Creative — may guess unknown gesture meanings
 * 4: Autonomous — conducts conversations on student's behalf
 */
export type AACInterpretationLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Confidence level for [INTERPRET] and [TRANSCRIPT] outputs.
 */
export type AACConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Definition of an add-on app in the registry
 */
export interface AACAppDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabledByDefault: boolean;
  /** If true, the app's canvas is captured and sent with detection requests */
  supportsDetectionCapture?: boolean;
}

/**
 * Runtime app state on a session
 */
export interface AACAppState {
  /** IDs of apps enabled for this session */
  enabledApps: string[];
  /** Currently open app ID, or null if none */
  activeApp: string | null;
}

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
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  // Context at time of message
  boardState?: ParsedBoardData;
  visualContext?: string;
  audioContext?: string;
  /** When true, excluded from Gemini context on reconnection but kept for monitor/DB visibility */
  safetyExcluded?: boolean;
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

  // Live API mode: when true, prompt is built with unified contextual rules
  // instead of separate isDetection toggle (system prompt sent once, not per-request)
  isLiveMode?: boolean;

  // Interpretation aggressiveness level (0-4)
  interpretationLevel: AACInterpretationLevel;

  // Board state
  currentBoard?: ParsedBoardData;
  boardButtonLabels: string[]; // Server-side tracking of current button labels for limit enforcement
  aiAddedButtonLabels: string[]; // Buttons AI added on top of a loaded custom board (removable by AI)

  // Pre-built board selection
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; grid: { rows: number; cols: number } }>;
  loadedBoardId?: string | null;
  loadedBoardData?: ParsedBoardData;
  currentPageId?: string | null;
  pageHistory?: string[];
  maxBoardItems?: number; // grid slot count (default 12)

  // Timestamps
  lastInteractiveActivity: number;
  lastMonitorActivity: number;

  // Add-on apps state
  appState: AACAppState;

  // Avatar emotion state
  currentEmote: "happy" | "sad" | "neutral";

  // Monitor error tracking
  monitorError?: string;           // Last error message from monitor processing
  monitorErrorTimestamp?: number;   // When the error occurred
  monitorConsecutiveFailures: number; // Count of consecutive failures (resets on success)

  // Cached contacts for prompt building
  cachedContacts?: Array<{ id: string; name: string; relationship?: string; hasFaceImage: boolean }>;

  // Cached custom symbols for prompt building
  cachedSymbols?: Array<{ id: string; key: string | null; description?: string | null }>;

  // Cached diagnosis from medicalRecords table (loaded once per session)
  cachedDiagnosis?: string | null;

  // Privacy settings — gate monitor access to sensitive student data
  privacyOptions?: { allowReadProgress: boolean; allowReadReports: boolean; allowNotes: boolean };

  // Live API hook: called when monitor injects context, so relay can forward to Gemini session
  onContextInjection?: (text: string) => void;

  // Pending message DB lock: true while atomic move (pending → history) is in progress
  pendingDbLocked?: boolean;
  // Buffer for messages arriving during the pendingDbLocked window
  pendingBuffer?: PendingMessage[];
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
  addButtons?: Array<{ label: string; iconRef: string; symbolPath?: string }>;
  // Detection diff: labels of buttons to remove
  removeLabels?: string[];
  // Full board rebuild (replaces all buttons)
  rebuildBoard?: Array<{ label: string; iconRef: string; symbolPath?: string }>;
  // Message inferred from gestures/context to process as user input
  triggeredMessage?: string;
  // Student's interpreted intent (student voice) — can coexist with text (speak)
  interpretation?: string;
  // Confidence level for interpretation
  interpretConfidence?: AACConfidenceLevel;
  // Confidence level for transcript
  transcriptConfidence?: AACConfidenceLevel;
  // What AI saw and why (debug/moderator only)
  debugDescription?: string;
  // Voice transcript from audio input
  transcript?: string;
  // Who spoke the transcript
  transcriptSpeaker?: string;
  // Environmental context changes observed
  contextUpdate?: string;
  // Interactive agent requesting early monitor call
  callMonitor?: string;
  // Open an add-on app (generic replacement for playVideo)
  openApp?: { appId: string; data?: string };
  // Close the currently open app
  closeApp?: boolean;
  // Avatar emotion from [EMOTE] token
  emote?: "happy" | "sad" | "neutral";
  // Learn a new face from [LEARN_FACE] token
  learnFace?: { name: string; relationship?: string; description?: string };
  // Select a pre-built board by name
  setBoard?: string;
  // AI presses a navigation button on the current board (label)
  pressButton?: string;
  // Yes/No question detected — trigger prominent overlay buttons
  yesNo?: boolean;
  // Deferred Yes/No — show overlay after TTS playback completes
  askYesNo?: boolean;
  // AI requested a high-resolution focus frame for detailed analysis
  requestFocus?: string;
  // Provider finish reason (e.g. "STOP", "MAX_TOKENS", "SAFETY", "RECITATION")
  finishReason?: string;
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
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string; // 'student', 'parent', 'teacher', 'classmate', etc.
  confidence: number;
  method: "face" | "voice" | "both";
  description?: string;   // physical/contextual description (contacts only)
  contextNotes?: string;  // AI knowledge about interactions (contacts only)
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

  // Debug mode: when true, yield debug SSE events with prompt/usage info
  debugMode?: boolean;

  // Response mode: 'fast' (voice first) or 'analyze' (observe first)
  responseMode?: AACResponseMode;

  // Unknown face descriptors from client for AI-triggered enrollment
  unknownFaceDescriptors?: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }>;
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
  frameTimestamps?: number[]; // timestamps (ms since epoch) for composite grid frames (user camera)
  envFrameTimestamps?: number[]; // timestamps (ms since epoch) for environment camera frames
  debugMode?: boolean;        // when true, yield debug SSE events with prompt/usage info
  appCanvasData?: string;     // base64 data URL of active app canvas (e.g. drawing)
  responseMode?: AACResponseMode; // 'fast' (voice first) or 'analyze' (observe first)
  unknownFaceDescriptors?: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }>;
  isFocusFrame?: boolean;       // High-resolution single frame for detailed analysis
  focusReason?: string;         // Why the AI requested this focus frame
}

/**
 * Output from continuous detection
 */
export interface DetectionOutput {
  sessionId: string;
  addButtons?: Array<{ label: string; iconRef: string; symbolPath?: string }>;
  removeLabels?: string[];
  rebuildBoard?: Array<{ label: string; iconRef: string; symbolPath?: string }>; // full board replacement
  changed: boolean;          // whether buttons were updated
  text?: string;             // AI voice (speak field) — only when high confidence
  triggeredMessage?: string; // deprecated: use interpretation instead
  interpretation?: string;         // student's interpreted intent (student voice)
  interpretConfidence?: AACConfidenceLevel;  // confidence of interpretation
  transcriptConfidence?: AACConfidenceLevel; // confidence of transcript
  interpretationAudio?: string;    // base64 audio (student voice TTS)
  debugDescription?: string;       // what AI saw/decided
  transcript?: string;             // voice transcript from audio input
  transcriptSpeaker?: string;      // who spoke the transcript
  contextUpdate?: string;          // environmental context changes observed
  openApp?: { appId: string; data?: string }; // Open an add-on app
  closeApp?: boolean;              // Close the currently open app
  emote?: "happy" | "sad" | "neutral"; // Avatar emotion from [EMOTE] token
  setBoard?: { board: ParsedBoardData; name: string; boardId: string }; // Pre-built board loaded
  pressButton?: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }; // AI pressed a navigation button
  yesNo?: boolean;                 // Yes/No question detected — trigger overlay
  askYesNo?: boolean;              // Deferred Yes/No — show overlay after TTS playback
  focusRequested?: string;         // AI requested a high-res focus frame (reason)
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
