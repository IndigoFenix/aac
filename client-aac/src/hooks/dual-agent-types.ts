// client-aac/src/hooks/dual-agent-types.ts
// Shared type definitions for the dual-agent AAC system.
// Extracted from useDualAgent.ts so that useLiveSession.ts and
// DualAgentContext.tsx can import them without depending on each other.

import type React from "react";
import type { ParsedBoardData } from "@shared/schema";
import type { ComposedGrid } from "@/lib/composeFrameGrid";
import type { UnknownFaceDescriptor } from "./usePersonIdentification";
import type { CachedRequest } from "./useDebugRequestCache";

export interface DualAgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  isThinking?: boolean;
}

/**
 * Server-supplied tuning the AAC client applies on session init. Mirrors
 * the server-side `ClientConfig` shape from `server/services/dual-agent/
 * client-config.ts` but kept in a separate declaration so the client
 * doesn't import from the server. All fields are optional — older
 * servers omit them; the client falls back to its built-in defaults.
 */
export interface ClientConfigActivityMonitor {
  frameCaptureRate?: number;
  maxBufferSeconds?: number;
  gridCols?: number;
  gridRows?: number;
  activitySettleMs?: number;
  maxSilenceMs?: number;
  minIntervalMs?: number;
  speechPreRollMs?: number;
  speechPostRollMs?: number;
  heartbeatAudioMs?: number;
}

export interface ClientConfigSleep {
  sleepThreshold?: number;
  wakeupThreshold?: number;
  signalHalfLifeMs?: number;
  falseWakeBumpFactor?: number;
  falseWakeDecayHalfLifeMs?: number;
  falseWakeMaxThreshold?: number;
}

export interface ClientConfigGestureSerializer {
  windowMs?: number;
}

export interface ClientConfig {
  activityMonitor?: ClientConfigActivityMonitor;
  sleep?: ClientConfigSleep;
  gestureSerializer?: ClientConfigGestureSerializer;
}

/** Identified person from biometric recognition */
export interface IdentifiedPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string;
  confidence: number;
  method: "face" | "voice" | "both";
  description?: string;
  contextNotes?: string;
}

/** Construction-board snapshot the client sends to the AI on every relevant change. */
export interface ConstructionStateClient {
  category: "who" | "do" | "what" | "where" | "when" | "chat";
  modeChip: string;
  /** Serialized glyph string (e.g. "i_me+want+water.big#question"). */
  glyph: string;
  /** Slot index currently selected by the user, or null. */
  activeSlot: number | null;
  /** Slot index the AI should suggest for (null = next empty). */
  targetSlot: number | null;
  /** Keys already shown for this slot — AI must not repeat. */
  excludeKeys: string[];
  /** When true, student requested help — AI should enter guessing mode for the target slot. */
  requestGuessingMode?: boolean;
  /**
   * When the active/most-recent slot is a composable host with no payload yet,
   * the AI should suggest items that fit *inside* the host (the blank) rather
   * than candidates for the next sentence slot.
   */
  payloadTarget?: {
    slotIndex: number;
    hostKey: string;
    /** Coarse part-of-speech types accepted as the payload. */
    accepts: string[];
    /** Categories the AI should bias suggestions toward. */
    suggestCategories: Array<"who" | "do" | "what" | "where" | "when" | "chat">;
  };
}

/** One SUGGESTION delivered to the SENTENCE BUILDER. */
export interface ConstructionCandidateClient {
  key: string;
  label?: string;
  /** Resolved image URL for AI-generated keys; undefined for registry/emoji items. */
  symbolPath?: string;
  /**
   * Non-generate render fallback for SUGGESTIONs whose primary key is
   * still awaiting (or has failed) image generation. The server only
   * sets this when the primary key is a generation target — canonical /
   * emoji / `symbol:` / `face:` SUGGESTIONs never need it. The renderer
   * reaches for `fallback` before the universal `❓` placeholder, so a
   * pending SUGGESTION reads as "want with a pizza icon" rather than
   * "want with an unknown icon."
   */
  fallback?: string;
}

/** AI's SUGGESTION payload received from the server, populates the AI strips. */
export interface ConstructionSuggestionsClient {
  targetSlot: number;
  /**
   * HEAD-SYMBOL SUGGESTIONs — feed the main AI strip and fill the next
   * GLYPH slot when tapped. Older server builds may only send this under
   * the deprecated `candidates` field; the hook normalizes both shapes
   * into `headCandidates`.
   */
  headCandidates: ConstructionCandidateClient[];
  /**
   * MODIFIER-SYMBOL SUGGESTIONs — feed a parallel AI strip above the
   * static modifier carousel and attach to the student's current HEAD
   * SYMBOL when tapped. Empty when the AI didn't propose any modifiers.
   */
  modifierCandidates: ConstructionCandidateClient[];
  /**
   * @deprecated Legacy alias for `headCandidates`. Kept on the wire so
   * existing consumers don't break; new code should read `headCandidates`.
   */
  candidates: ConstructionCandidateClient[];
  /** Monotonic counter so consumers can tell two arrivals apart. */
  receivedAt: number;
}

/** One option in a binary-choice overlay (AI-supplied, parsed server-side). */
export interface BinaryChoiceOption {
  label: string;
  sentence?: string;
  glyph?: string;
  glyphFallback?: string;
  iconRef?: string;
  symbolPath?: string;
  imageKey?: string;
}

/** AI-driven memory chips for the construction board, scoped per category. */
export interface ConstructionMemoryChipsClient {
  category: "who" | "do" | "what" | "where" | "when" | "chat";
  chips: Array<{ key: string; label: string }>;
  receivedAt: number;
}

/** Server-side face match result delivered via the `people_identified` WS message. */
export interface IdentifiedFace {
  faceIndex: number;
  matched: boolean;
  name: string;
  entityType?: "student" | "user" | "contact";
  entityId?: string;
  relationship?: string;
  confidence: number;
  boundingBox?: { x: number; y: number; w: number; h: number };
}

/** Data for an active add-on app */
export interface ActiveAppData {
  appId: string;
  appData?: any;
}

/** Server-owned social-training session (three-agent path). Mirrors the
 *  `social_session` "started" payload from the server — everything the
 *  client needs to render the peer's procedural face in the header. */
export interface SocialSessionInfo {
  characterName: string;
  voiceName: string;
  appearance: import("@shared/social-bot/ProceduralFace").FaceAppearance;
  expressiveness: number;
  legibility: number;
}

export interface BoardPatch {
  add: Array<{ label: string; iconRef: string; symbolPath?: string }>;
  remove: string[];
  rebuild?: Array<{ label: string; iconRef: string; symbolPath?: string }>; // full board replacement
}

/** Cached audio clip for debug playback */
export interface CachedAudioClip {
  id: string;
  blob: Blob;
  objectUrl: string;
  timestamp: number;
  status: 'collected' | 'sent';
  sizeBytes: number;
  triggerReason: string;
}

export interface UseDualAgentReturn {
  // Session state
  sessionId: string | null;
  /** Server-supplied tuning bundle (activity monitor / sleep / gesture).
   *  Null until the first `initialized` message lands, or when running
   *  against an older server that doesn't ship the field — consumers
   *  fall back to their built-in defaults in either case. */
  clientConfig: ClientConfig | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

  // Messages
  currentMessage: DualAgentMessage | null;
  transcription: string | null;
  utteranceText: string | null;
  utteranceConfidence: 'high' | 'medium' | 'low' | null;
  transcriptConfidence: 'high' | 'medium' | 'low' | null;
  debugText: string | null;

  // Audio state
  audioEnabled: boolean;
  isPlaying: boolean;
  voiceEnabled: boolean;
  isRecording: boolean;
  audioLevel: number;
  recordingDuration: number;

  // User-controlled mute state (cave toggle — the AI cannot change this)
  muteState: 'unmuted' | 'muted';
  setMuteState: (state: 'unmuted' | 'muted') => void;
  /** Last AI-initiated mode change — used to flash the "AI: <mode>" indicator.
   *  Canonical modes are companion/facilitator/standby (legacy interact/assist
   *  are mapped to companion/facilitator in the interaction_mode_changed handler). */
  lastModeChange: { mode: 'companion' | 'facilitator' | 'standby'; reason?: string; source: 'ai'; at: number } | null;

  // Response mode
  responseMode: 'fast' | 'analyze';
  setResponseMode: (mode: 'fast' | 'analyze') => void;

  // Detection — video and audio can be toggled independently
  videoCaptureEnabled: boolean;
  setVideoCaptureEnabled: (enabled: boolean) => void;
  /** Activity-driven detection: send composite grid + audio clip + unknown face descriptors */
  runDetectionWithGrid: (grid: ComposedGrid | null, audioClip: Blob | null, unknownFaceDescriptors?: UnknownFaceDescriptor[], triggerReason?: string) => Promise<void>;

  // Debug
  debugData: Record<string, any>;
  requestCache: CachedRequest[];
  audioClipCache: CachedAudioClip[];
  /** Latest server-side face matching results — empty array when no faces or no descriptors recently sent. */
  identifiedFaces: IdentifiedFace[];

  // Active app
  activeApp: ActiveAppData | null;
  dismissApp: () => void;
  /** Client-initiated app launch — e.g. AAC board button with an open_website action. */
  launchApp: (appId: string, appData?: any) => void;
  /** Ask the server to resolve startup params, then open the app (apps with
   *  needsStartupResolution). Server replies via the normal app_open message. */
  requestAppOpen: (appId: string, appData?: any) => void;
  /** appId currently awaiting a request_app_open round-trip, or null. */
  appOpenPending: string | null;
  /** Register a function to capture the app canvas (e.g. drawing) for detection */
  captureAppCanvasRef: React.MutableRefObject<(() => Promise<Blob | null>) | null>;
  /** Built-in apps enabled for this session (id + display name + icon). */
  enabledApps: Array<{ id: string; name: string; icon: string; needsStartupResolution?: boolean }>;
  /** Custom apps (clinician-authored games) assigned to this student. */
  availableCustomApps: Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>;

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;
  /** Counter bumped each time the server sends a `thinking` message
   *  (Speaker emitted a private_note). Consumers use it as a key to
   *  retrigger a question-mark animation next to the avatar. */
  thinkingPulse: number;

  // Monitor status
  monitorError: string | null;
  monitorConsecutiveFailures: number;

  // Actions
  initialize: () => Promise<void>;
  sendMessage: (message: string, board?: ParsedBoardData) => Promise<void>;
  sendContextOnly: (text: string) => void;
  /** Send a board exit message (exit/exitBoard button pressed on loaded board) */
  sendBoardExit: (label: string, instruction: string) => void;
  sendVoice: (board?: ParsedBoardData) => Promise<void>;
  voiceButtons: (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => Promise<void>;
  /**
   * Send a composed glyph from the sentence builder. The AI converts it to
   * natural language via the `interpret` tool — the relay does NOT TTS the
   * raw glyph string. See the [GLYPH PRESS] flow in live-relay.ts.
   */
  playGlyph?: (glyphString: string) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
  setAudioEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  stopAudio: () => void;
  clearSession: () => void;

  // Binary-choice overlay — two AI-supplied SENTENCE BUTTON options + an
  // implicit "Neither". Yes/no questions are surfaced through this same
  // overlay (using the canonical `yes` / `no` SYMBOLs).
  binaryChoiceOptions: BinaryChoiceOption[] | null;
  /** Caretaker alarm raised by the Observer agent, or null when none is
   *  active. "alert" = short attention nudge; "emergency" = building alarm
   *  with an on-screen cancel button. `reason` is the AI's description. */
  activeAlarm: { level: "alert" | "emergency"; reason: string } | null;
  /** Clear the active alarm (cancel button / alert auto-dismiss). */
  cancelAlarm: () => void;
  /** Server-supplied escape-button kind: "maybe" (yellow) when the pair
   *  forms a yes/no; "neither" (red, no-symbol) otherwise. Null when no
   *  overlay is active. The display layer doesn't decide the kind. */
  binaryChoiceEscapeKind: "maybe" | "neither" | null;
  /** Experiment (glyphInputTranslation): glyph translation of the speech this
   *  choice replies to, shown above the two overlay buttons. Null when off or
   *  the choice isn't a reply to incoming speech. */
  binaryChoiceInputGlyph: { glyph: string; fallback?: string } | null;
  dismissBinaryChoice: () => void;

  // Live API only — raw PCM audio streaming
  /** Send a raw PCM audio chunk (base64 Int16 16kHz) to Gemini Live API. Only available in Live mode. */
  sendPcmAudio?: (int16Base64: string) => void;
  /** Push already-computed unknown face descriptors out-of-band (not on a frame).
   *  Used at session start so the server can match before the first frame. */
  sendFaceDescriptors?: (descriptors: UnknownFaceDescriptor[]) => void;
  /** Capture a fresh frame now and send it as the first frame_grid — used the
   *  moment the session is ready so the startup scene uses a current snapshot. */
  sendFreshStartupFrame?: () => Promise<void>;
  /** Synchronous ref: true from first queued audio chunk until echo tail ends. Use for mic gating. */
  isBusyRef?: { readonly current: boolean };

  // Focus frame
  /** True while a focus frame is being captured/sent (briefly shows glasses overlay) */
  focusActive: boolean;

  // Pause state
  paused: boolean;
  setPaused: (paused: boolean) => void;

  /**
   * Notify the server that the engagement state machine transitioned sleep state.
   * Logged to activity_logs so the Insurance Bridge module can subtract sleep
   * windows from RTM service-time totals.
   */
  notifySleepStateChange: (
    state: "hibernation" | "waking" | "awake" | "resting" | "asleep",
    source: "ai" | "system" | "user",
  ) => void;

  // Guessing mode
  /** True when the AI is in guessing mode (narrowing down user's thought) */
  guessingMode?: boolean;
  /** Press a guessing-mode SUGGESTION button — updates narrowing state and re-injects [GUESSING STATE]. */
  pressSuggestion?: (suggestionKey: string) => void;
  /** Press an AI-driven NARROW button — records the user's choice as a
   *  custom narrowing fact and re-injects [GUESSING STATE] so the AI can
   *  propose the next step. `sourceText` is the button's voiced speech. */
  pressNarrow?: (dimension: string, value: string, sourceText?: string) => void;
  /** Unified word-finder entry. Pass a builderContext to launch from the
   *  sentence builder (pre-selects category), or omit for conversation
   *  tier. Same downstream protocol either way. */
  enterGuessing?: (builderContext?: { targetSlot: number | null; partialGlyph: string; category: string }) => void;
  /** Legacy alias — equivalent to enterGuessing(builderContext). */
  enterGuessingFromBuilder?: (builderContext: { targetSlot: number | null; partialGlyph: string; category: string }) => void;
  /** User-initiated word-finder cancel — sends `exit_guessing` to the
   *  server, which clears state and broadcasts `guessing_mode:false`. */
  exitGuessing?: (reason?: string) => void;
  /** Notify the server the sentence builder opened/closed (conversation detour boundary). */
  setBuilderVisible?: (open: boolean) => void;

  // Social trainer (three-agent path) — the session is server-owned: the
  // peer persona replaces the Speaker agent and its speech/text/audio flow
  // through the normal channels. The client only renders the peer face
  // from `socialSession` and asks the server to start via the notify call
  // (used for client-initiated launches; AI launches arrive as app_open).
  socialSession?: SocialSessionInfo | null;
  /** Per-turn director state (face target + mode + rapport) while a
   *  social session is active. Null outside sessions. */
  socialPeerState?: import("@shared/social-bot/state").BotStatePayload | null;
  notifySocialTrainerStarted?: () => void;

  // Construction board (sentence builder)
  /** Push the current construction-board state to the AI so it can populate the AI strip. */
  sendConstructionState?: (state: ConstructionStateClient) => void;
  /** Latest AI suggestion payload received from the server. */
  constructionSuggestions?: ConstructionSuggestionsClient | null;
  /** Memory chips per category, set by the AI. Indexed by category key. */
  constructionMemoryChips?: Partial<Record<ConstructionStateClient["category"], ConstructionMemoryChipsClient>>;

  // Reconnection state (Live API only)
  /** Whether the server is currently reconnecting to Gemini */
  reconnecting?: boolean;
  /** Transient safety block indicator (auto-clears after 5s) */
  safetyBlocked?: boolean;
}
