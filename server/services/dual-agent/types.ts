// server/services/dual-agent/types.ts
// Type definitions for the dual-agent AAC system

import type { ChatMessage, ParsedBoardData, PermittedWebsite, PermittedYoutubeChannel } from "@shared/schema";
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
 * Session state for dual-agent system
 */
export interface DualAgentSessionState {
  // Core session info
  sessionId: string;
  studentId: string;
  userId?: string;

  /**
   * Set by LiveRelay during init so the dual-agent-service can ask the
   * relay to close its WebSocket cleanly (e.g. consent revoked mid-session).
   * Optional because non-WS callers (legacy HTTP path, tests) don't set it.
   */
  onTerminate?: (reason: string) => void;

  // Agent states
  interactivePrompt: string; // Full prompt for Interactive agent
  monitorBusy: boolean; // Is Monitor currently processing?
  monitorBusySince?: number; // Timestamp when Monitor started (for staleness detection)

  // Message states
  messages: ChatMessage[]; // Main message log (Monitor's view)
  pendingMessages: PendingMessage[]; // Cached while Monitor busy

  // Interaction mode
  interactionMode: AACInteractionMode;

  // Board state
  currentBoard?: ParsedBoardData;
  boardButtonLabels: string[]; // Server-side tracking of current button labels for limit enforcement
  aiAddedButtonLabels: string[]; // Buttons AI added on top of a loaded custom board (removable by AI)

  // Pre-built board selection
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; isGenerated?: boolean; grid: { rows: number; cols: number } }>;
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

  // Permitted websites (clinician-configured + runtime-merged from loaded board buttons).
  // Used by the open_website tool and server-side URL gating.
  permittedWebsites: PermittedWebsite[];

  // Permitted YouTube channels (clinician-configured). When empty, YouTube searches
  // fall back to unrestricted mode (requires YOUTUBE_API_KEY to return anything).
  permittedYoutubeChannels: PermittedYoutubeChannel[];

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

  // Memory context from fast startup (chatMemory fields)
  memoryContext?: string;

  // Enhanced prompt from thorough startup (LLM-generated, replaces raw persona)
  enhancedPrompt?: string;

  // Privacy settings — gate monitor access to sensitive student data
  privacyOptions?: { allowReadProgress: boolean; allowReadReports: boolean; allowNotes: boolean };

  // Live API hook: called when monitor injects context, so relay can forward to Gemini session
  onContextInjection?: (text: string) => void;

  // Live API hook: called when monitor generates a new board, so relay can notify the client
  onBoardGenerated?: (board: { boardId: string; name: string; hint?: string }) => void;

  // Storage control — when false, session data is not persisted to the database
  remoteStorageEnabled: boolean;

  // Pending message DB lock: true while atomic move (pending → history) is in progress
  pendingDbLocked?: boolean;
  // Buffer for messages arriving during the pendingDbLocked window
  pendingBuffer?: PendingMessage[];
}

/**
 * Response from Monitor agent
 */
export interface MonitorResponse {
  // Updated prompt for Interactive
  updatedPrompt?: string;
  // Context to inject
  contextInjection?: string;
  // Board IR to save/update (generated board)
  generatedBoard?: {
    name: string;
    boardId?: string; // if editing an existing board
    irData: ParsedBoardData;
    hint?: string; // automaticSelectionHint
  };
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
 * Accumulator for tool calls within a single Gemini turn.
 * Replaces the per-segment aggregation from the prefix token parser.
 */
export interface TurnToolAccumulator {
  speakText: string;
  interpretText: string;
  interpretConfidence: 'high' | 'medium' | 'low' | null;
  transcriptText: string;
  transcriptSpeaker: string;
  contextText: string;
  callMonitorReason: string | null;
  focusReason: string | null;
  openAppData: { appId: string; data?: string } | null;
  openWebsiteData: { url: string; label?: string } | null;
  closeApp: boolean;
  setBoardName: string | null;
  pressButtonLabel: string | null;
  boardChanged: boolean;
  boardRebuilt: boolean;
  boardAddLabels: string[];
  boardRemoveLabels: string[];
  emote: 'happy' | 'sad' | 'neutral' | null;
}

export function createEmptyAccumulator(): TurnToolAccumulator {
  return {
    speakText: "",
    interpretText: "",
    interpretConfidence: null,
    transcriptText: "",
    transcriptSpeaker: "",
    contextText: "",
    callMonitorReason: null,
    focusReason: null,
    openAppData: null,
    openWebsiteData: null,
    closeApp: false,
    setBoardName: null,
    pressButtonLabel: null,
    boardChanged: false,
    boardRebuilt: false,
    boardAddLabels: [],
    boardRemoveLabels: [],
    emote: null,
  };
}

export const DEFAULT_CONFIG: DualAgentConfig = {
  interactiveModel: "gpt-4o-mini",
  monitorModel: "gpt-4o",
  interactiveTimeout: 5000,
  monitorTimeout: 30000,
  enableTTS: true,
  debug: false,
};
