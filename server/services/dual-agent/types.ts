// server/services/dual-agent/types.ts
// Type definitions for the dual-agent AAC system

import type { ChatMessage, HomeAction, ParsedBoardData, PermittedWebsite, PermittedYoutubeChannel, PermittedYoutubeItem, PermittedYoutubeVideo } from "@shared/schema";
import type { LLMProviderKey } from "@shared/llm-options";
import type { AppStartupSpec } from "@shared/app-startup";
import type { PictureSearchConfig } from "@shared/picture-search";

/**
 * User-controlled mute state for the AAC system. Toggled only by the user
 * (cave click); the AI cannot change this on its own.
 * - 'unmuted': AI companion talks TO the user (conversational, short button labels)
 * - 'muted':   AI silently observes, helps user talk to OTHERS (utterance-style buttons, no text/audio)
 */
export type AACMuteState = 'unmuted' | 'muted';

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
  /**
   * What this app's free-text launch argument means, phrased for the model
   * ("what to search the web for"). Present only on apps that actually consume
   * one. Surfaced to the Speaker (via `open_app`'s `data`) AND to the Board
   * Manager (via a launch button's `open.appQuery`) — the Board Manager needs
   * it most, because in a live-audio session it is the ONLY agent that can open
   * anything, and a search app opened with no query drops the request.
   */
  queryHint?: string;
  /**
   * Optional startup definition. When present, opening this app triggers a
   * resolver LLM call that fills `startup.paramsSchema`; the resolved params are
   * handed to the app at launch. Apps without it open instantly with no params.
   */
  startup?: AppStartupSpec;
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
 * Structured output of the thorough-startup prompt enhancer.
 *
 * The enhancer LLM converts the clinician-written `chatAgentPrompt` list (one
 * rule per entry) plus the `autoAacPrompt` notes list, student data, calendar
 * events, and recent notes into tag-delimited sections. Each section is injected at a specific location in the
 * Interactive Agent's system prompt by `buildInteractiveAgentPrompt`,
 * REPLACING the static template content where applicable:
 *
 * - `persona`                       → replaces the raw chatAgentPrompt inside
 *                                     `<persona>`. Personality, relationship,
 *                                     communication profile.
 * - `sessionGoals`                  → new `<session_goals>` block right after
 *                                     `<persona>`. Specific aims for THIS
 *                                     session derived from events / notes /
 *                                     time of day.
 * - `gestureOverrides`              → replaces the static body of
 *                                     `<persona_gesture_override>`.
 * - `interactModeExamples`          → REPLACES `ex("interact_mode.dialogue")`
 *                                     inside `<interact_mode>`. Worked
 *                                     dialogues themed on this user's
 *                                     interests / upcoming events.
 * - `assistModeExamples`            → REPLACES `ex("assist_mode.dialogue")`
 *                                     inside `<assist_mode>`. Facilitating
 *                                     between the user and a third party
 *                                     (therapist, parent, teacher) on topics
 *                                     the user is likely to discuss.
 * - `sentenceInterpretationExamples` → REPLACES
 *                                     `ex("sentence_interpretation.worked_examples")`
 *                                     inside `<sentence_interpretation>`.
 *                                     Must include any metaphor / compound
 *                                     SENTENCE patterns this user is noted
 *                                     to use (e.g. `shoe+ball` → football).
 * - `safetyNotes`                   → new `<student_safety>` block after
 *                                     `<security>`. Allergies, behavioral
 *                                     triggers, redaction categories.
 *
 * Every field is optional. Missing sections fall back to the static default
 * in the prompt builder.
 */
export interface EnhancedPromptSections {
  persona?: string;
  sessionGoals?: string;
  gestureOverrides?: string;
  /** LEGACY single-agent example dialogues. The session-plan enhancer no
   *  longer generates these two (only the legacy Interactive prompt consumed
   *  them, and it falls back to its static examples) — the fields remain so
   *  old persisted sessions still deserialize. */
  interactModeExamples?: string;
  assistModeExamples?: string;
  sentenceInterpretationExamples?: string;
  safetyNotes?: string;
  /**
   * Three-agent system only (see planning-docs/aac-agent-responsibility-split.md):
   * Observer-specific guidance extracted from the clinician's chatAgentPrompt
   * by the thorough-startup enhancer. Covers gestures to watch for, what
   * counts as relevant in the environment, what NOT to transcribe, etc.
   * Empty in the single-agent path (legacy ignores it).
   */
  observerInstructions?: string;
  /**
   * Three-agent system only: per-student criteria for when the Observer
   * should raise a caretaker alarm — folded out of the clinician's
   * chatAgentPrompt by the enhancer (e.g. "has epilepsy, watch for
   * absence/tonic-clonic seizures"; "self-injurious head-banging when
   * overwhelmed"). The Observer prompt always carries the generic
   * two-tier alarm behavior; this adds student-specific signs. There is
   * intentionally NO dedicated settings column — alarm conditions live in
   * the AAC prompt for now. Optional; undefined until the enhancer is
   * taught to emit it.
   */
  alarmConditions?: string;
  /**
   * Three-agent system only: Board-Manager-specific guidance extracted by
   * the enhancer. Surface preferences (e.g. "always include a 'finished'
   * button for this student"). Empty in the single-agent path.
   */
  boardManagerGuidance?: string;
  /**
   * Three-agent system only: Speaker's interact-mode worked dialogue.
   * Speech-only — NO rebuild_board calls, NO transcript() calls. Speaker
   * just speaks; BOARD MANAGER produces the buttons separately. Empty in
   * legacy single-agent path.
   */
  speakerInteractExamples?: string;
  /**
   * Three-agent system only: Speaker's assist-mode worked dialogue.
   * Shows Speaker staying quiet while a third party engages the user.
   * Empty in legacy.
   */
  speakerAssistExamples?: string;
  /**
   * Three-agent system only: Board Manager worked examples — sample
   * button rebuilds for the common trigger types (button press, AI
   * speech, third-party speech, ambient observation). Empty in legacy.
   */
  boardManagerExamples?: string;
}

/**
 * Session state for dual-agent system
 */
export interface DualAgentSessionState {
  // Core session info
  sessionId: string;
  studentId: string;
  userId?: string;
  // When set, this session is running in classroom mode (multi-student
  // shared screen). The currently active student is still tracked via
  // studentId; classroomId persists the roster context.
  classroomId?: string;

  /**
   * Set by LiveRelay during init so the dual-agent-service can ask the
   * relay to close its WebSocket cleanly (e.g. consent revoked mid-session).
   * Optional because non-WS callers (legacy HTTP path, tests) don't set it.
   */
  onTerminate?: (reason: string) => void;

  // Agent states
  interactivePrompt: string; // Full prompt for Interactive agent (single-agent / legacy path)
  /**
   * Three-agent system (planning-docs/aac-agent-responsibility-split.md):
   * Per-agent system prompts when this session runs the new path. The legacy
   * `interactivePrompt` above stays populated for the single-agent path; in
   * the three-agent path it may be left empty or set to a debug summary.
   */
  observerPrompt?: string;
  speakerPrompt?: string;
  boardManagerPrompt?: string;
  /**
   * Last deliberate Observer backend choice, recorded on every successful
   * runtime switch. A reconnect-resumed coordinator starts on this backend
   * instead of the policy default — without it, every re-init reset an
   * economy Observer back to expensive live native-audio, and under a
   * reconnect storm the session ran live essentially the whole time.
   * The budget's forced-economy floor still overrides it.
   */
  observerBackendMode?: "live" | "economy";
  monitorBusy: boolean; // Is Monitor currently processing?
  monitorBusySince?: number; // Timestamp when Monitor started (for staleness detection)

  // Message states
  messages: ChatMessage[]; // Main message log (Monitor's view)
  pendingMessages: PendingMessage[]; // Cached while Monitor busy

  // User-controlled mute state (user-toggled only via cave click)
  muteState: AACMuteState;

  // Board state
  currentBoard?: ParsedBoardData;
  boardButtonLabels: string[]; // Server-side tracking of current button labels for limit enforcement
  aiAddedButtonLabels: string[]; // Buttons AI added on top of a loaded custom board (removable by AI)

  // Pre-built board selection
  // `key` is built by shared/board-keys.ts — `slug(name)` for the student's own
  // boards, `slug(package).slug(board)` for boards reached through a package.
  // `packageName` is set only for the latter, and groups the prompt listing.
  // `coverImage` is the board's own cover art (from its IR) — used as the
  // visual for a board-launch button when the AI supplies none.
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; isGenerated?: boolean; packageName?: string; grid: { rows: number; cols: number }; coverImage?: { iconRef?: string; symbolPath?: string } }>;
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

  // Web picture search settings (clinician-configured, `app_config.picture_search`).
  // Normalized at session start rather than read from the raw jsonb on each
  // search, so a hand-edited blob cannot widen the policy mid-session.
  pictureSearch: PictureSearchConfig;

  // Permitted YouTube channels (clinician-configured). When empty, YouTube searches
  // fall back to unrestricted mode (requires YOUTUBE_API_KEY to return anything).
  permittedYoutubeChannels: PermittedYoutubeChannel[];

  // Pinned YouTube videos (clinician-configured curated playlist). Shown to
  // the student as direct-play buttons; surfaced to the AI in the prompt so
  // it can request a specific one by videoId or title via open_app("youtube", data=...).
  permittedYoutubeVideos: PermittedYoutubeVideo[];

  // Permitted YouTube playlists (clinician-configured). Browsed like channels
  // (RSS-backed video list) in the AAC player; searched alongside channels.
  permittedYoutubePlaylists: PermittedYoutubeItem[];

  // Smart-home action slots (clinician-authored, `aac_settings.home_actions`).
  // Always read through normalizeHomeActions — the raw jsonb never lands here.
  // Backs the Board Manager's <home_context> and the server-side press gate
  // (which checks ENABLED slots only, via findHomeAction).
  homeActions: HomeAction[];

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
  /** Compact digest of the student's family photos, built once at session start
   *  (server/services/photos/photo-context.ts). Undefined when they have none —
   *  which is also how the prompt block stays absent for most students. */
  photoLibrary?: import("../photos/photo-context").PhotoLibrarySummary;

  // Custom apps (clinician-authored games) assigned to this student. Cached so
  // the client-side Apps board picker can render them without an extra fetch
  // and so the prompt enhancer / tool builder can reference them.
  availableCustomApps?: Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>;

  // Cached diagnosis from medicalRecords table (loaded once per session)
  cachedDiagnosis?: string | null;

  // Memory context from fast startup (chatMemory fields)
  memoryContext?: string;

  // Structured enhanced-prompt sections from thorough startup. Each section
  // is independently parsed from the enhancer LLM's tagged output and
  // injected at a specific location in the Interactive Agent's system prompt
  // (see buildInteractiveAgentPrompt). When present, the persona section
  // replaces the raw chatAgentPrompt; other sections augment or override
  // specific blocks in the system prompt.
  enhancedSections?: EnhancedPromptSections;

  // Rolling session summary. A bounded (~1.5k token) digest of what has
  // happened this session, produced periodically by the MonitorAgent and
  // injected as a [SESSION SUMMARY] context message so it survives Gemini's
  // sliding-window compression (it stays recent) while older turn-by-turn
  // detail is evicted. Also folded into the system prompt on every reconnect
  // (profile switch / resumption) so continuity survives a full context reset.
  // `summarizedMsgCount` marks how many of state.messages were folded into the
  // current summary, so the next pass only summarizes what's new.
  sessionSummary?: string;
  summarizedMsgCount?: number;

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
  utteranceText: string;
  utteranceConfidence: 'high' | 'medium' | 'low' | null;
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
  /** Set when the model called stay_silent() this turn. Suppresses the
   *  auto-continuation re-prompt — silence was an explicit decision, not a
   *  missed turn. */
  staySilentReason: string | null;
  /** Set when the model passed a 'response' arg to rebuild_board() — the
   *  model's written declaration of what it was saying aloud. Used by the
   *  silence-recovery logic to detect "model wrote its intent but didn't
   *  produce native audio" and nudge it once. */
  rebuildBoardIntendedSpeech: string | null;
}

export function createEmptyAccumulator(): TurnToolAccumulator {
  return {
    speakText: "",
    utteranceText: "",
    utteranceConfidence: null,
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
    staySilentReason: null,
    rebuildBoardIntendedSpeech: null,
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
