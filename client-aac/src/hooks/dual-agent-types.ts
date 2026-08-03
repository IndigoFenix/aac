// client-aac/src/hooks/dual-agent-types.ts
// Shared type definitions for the dual-agent AAC system.
// Extracted from useDualAgent.ts so that useLiveSession.ts and
// DualAgentContext.tsx can import them without depending on each other.

import type React from "react";
import type { ParsedBoardData, PermittedWebsite } from "@shared/schema";
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
  sttMaxEpisodeMs?: number;
  sileroVadEnabled?: boolean;
  vadStartProb?: number;
  vadEndProb?: number;
  vadEndSilenceMs?: number;
  vadMaxSegmentMs?: number;
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
  /**
   * When true, apply the resting input filter (no heartbeat frames, VAD-gated
   * mic) while awake to cut live-API I/O cost. Server-driven via the
   * `AAC_AWAKE_DATA_SAVER` env var. Consumed in `dataFlowForState`.
   */
  awakeDataSaver?: boolean;
  /**
   * Cost-saving (Phase 1): the server activated on-device speech-to-text for
   * this session. When true, the client transcribes VAD speech segments locally
   * and sends `speech_text` instead of streaming raw audio, and suppresses
   * continuous PCM. When false/absent, audio streams as before. See
   * planning-docs/aac-cost-saving-spec.md §1.
   */
  sttActive?: boolean;
  /**
   * Cost-saving (Phase 2): the server activated scene-state text. When true, the
   * client sends a compact `scene_state` text description in place of a JPEG
   * frame while the scene is stable, sending real frames only on escalations.
   */
  sceneStateActive?: boolean;
  /**
   * Audio "live" attention: stream raw PCM CONTINUOUSLY (no VAD/silence gate)
   * even while economizing. When false (default / "adaptive"), raw PCM stays
   * VAD-gated. Only meaningful when sttActive is false. Consumed in
   * `handlePcmChunk` — overrides a vad-gated data-flow to continuous.
   */
  pcmContinuous?: boolean;
  /**
   * Per-student seizure detection (resolved DSP thresholds + seed baseline).
   * Absent / enabled:false → the client skips the motion detector. The shape is
   * shared (server resolves the clinician's sensitivity choices into thresholds).
   */
  seizure?: import("@shared/aac/seizure-config").ClientSeizureConfig;
  /**
   * SLP MODE is on for the USER who opened this session (`users.slp_mode`) —
   * a speech-language pathologist is running a therapy session WITH the
   * student. Absent when off. Consumed in DualAgentContext to (a) suppress the
   * client sleep state machine's automatic transitions (long silences are the
   * therapy) and (b) render the manual wake/sleep control in the AAC header.
   */
  slpMode?: boolean;
  /**
   * Automated audio scan (eyegaze). Absent unless the server decided the
   * feature applies — it requires BOTH `eyegazeEnabled` and the per-student
   * `autoAudioScan` setting, and floors the delay. The client treats presence
   * as "armed" and must not re-derive that gate itself.
   */
  autoAudioScan?: boolean;
  /** Hunt time before the automated scan fires, in ms (server-floored). */
  autoAudioScanDelayMs?: number;
}

/**
 * What local offloading THIS client build can perform, advertised to the
 * server at session init. Mirrors `ClientCapabilities` in
 * `server/services/dual-agent/live-relay.ts`. The server only acts on a
 * capability when full-attention is OFF and the matching phase flag is on, so
 * advertising a capability is safe even before the server enables it.
 */
export interface ClientCapabilities {
  clientStt?: boolean;
  sceneState?: boolean;
  poseSafety?: boolean;
  /** This build can synthesize the student's ElevenLabs voice locally from a
   *  `client_tts` dispatch and ack with `tts_done`. Latency capability, not a
   *  cost-saving one — the server honours it regardless of full-attention. */
  clientTts?: boolean;
}

/**
 * Capabilities this build actually implements. Flip a flag to `true` as each
 * cost-saving phase lands and is wired up. Section 0 ships all-false (plumbing
 * only); Phase 1 sets `clientStt`, Phase 2 `sceneState`, Phase 3 `poseSafety`.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
  clientStt: true,   // Phase 1: STT offload wired (server gates activation)
  sceneState: true,  // Phase 2: scene_state classify+send wired (server gates activation)
  poseSafety: true,  // Phase 3: body-pose posture/movement + conservative fall hint wired
  clientTts: true,   // Client-direct ElevenLabs (streaming PCM + tts_done ack) wired
};

/**
 * Which speech-to-text engine the client uses when STT is active:
 *  - "google":  send the VAD speech CLIP to the server, which transcribes via
 *               Google Cloud STT (accurate, low-latency, no device freeze). ACTIVE.
 *  - "whisper": transcribe on-device with the bundled Whisper model (offline,
 *               but slower/less accurate; model no longer bundled by default).
 * Whisper plumbing is kept; flip this to "whisper" (and re-run `npm run
 * whisper:model`) to use it again.
 */
export const STT_ENGINE: "google" | "whisper" = "google";

/**
 * How the Google STT path delivers audio:
 *  - "stream": stream VAD-gated PCM during speech to a server-side
 *              streamingRecognize session — Web-Speech-like (transcript ready at
 *              speech-end, online LM). ACTIVE.
 *  - "clip":   capture a finished WAV clip and batch-recognize it (the older,
 *              higher-latency path). Kept as a one-flag fallback if streaming
 *              misbehaves.
 * Only applies when STT_ENGINE === "google".
 */
export const STT_MODE: "stream" | "clip" = "stream";

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

/** Server-side voice match result delivered via the `voices_identified` WS message. */
export interface IdentifiedVoice {
  voiceIndex: number;
  matched: boolean;
  name: string;
  entityType?: "student" | "user" | "contact";
  entityId?: string;
  relationship?: string;
  confidence: number;
  similarity?: number;
  sampleCount?: number;
}

/**
 * Backend "busy" state streamed from the server `processing` message. Each flag
 * is true while the corresponding agent is working on something the child is
 * waiting on. Drives the subtle ambient processing indicators. Mirrors
 * `ProcessingActivity` in `server/services/dual-agent/live-relay.ts`.
 */
export interface ProcessingState {
  /** Speaker agent is composing a reply (until it speaks or stays silent). */
  speaker: boolean;
  /** Board Manager is rebuilding the board (until rebuilt / no-change). */
  board: boolean;
  /** A composed sentence (glyph_press) is being interpreted into speech. */
  interpret: boolean;
}

/** Data for an active add-on app */
export interface ActiveAppData {
  appId: string;
  appData?: any;
}

/** Home-board "Practice friend" preview: the peer face shown on the button
 *  BEFORE a session starts (the same persona the session will use). */
export interface SocialPeerPreview {
  appearance: import("@shared/social-bot/ProceduralFace").FaceAppearance;
  characterName: string;
  expressiveness: number;
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
  /** Semitone pitch shift for the peer's voice so the adult Gemini voice reads
   *  as roughly the student's age. Applied to the "avatar" audio tag while the
   *  session is active. */
  voicePitch?: number;
  /** Semitone formant (vocal-tract) shift — the primary "younger" cue. Applied
   *  to the "avatar" tag via the cepstral formant shifter. */
  voiceFormant?: number;
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

/** AI-initiated video-call directive surfaced from the live session. */
export interface CallDirective {
  action: "start";
  contactId: string;
  contactName?: string;
  /** Monotonic stamp (Date.now() when received) so consumers can dedupe. */
  at: number;
}

/** A group-chat peer for the header face row (server `conversation_roster`). */
export interface ChatPeer {
  personId: string;
  name: string;
  /** Stored-face photo as a data URL, when one is enrolled. */
  photo?: string;
}

/** Group-chat turn cue (server `floor_state`). holder = whose turn it is (a
 *  personId, or null when open); awaiting = who asked the group and is waiting
 *  for an answer. */
export interface FloorCue {
  holder: string | null;
  awaiting: string | null;
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
  /** Server-reported startup phase, shown as the localized subtitle on the
   *  "waking up" indicator while `isLoading`. Defaults to "connecting" until
   *  the first `startup_progress` message arrives. */
  startupStage: "connecting" | "checkingNotes" | "planningSession" | "loadingApps" | "wakingUp";
  error: string | null;
  /** Increments each time a real camera frame/snapshot is sent (frame_grid /
   *  focus_frame) — the avatar blinks on each change. */
  snapshotTick: number;

  // Messages
  currentMessage: DualAgentMessage | null;
  transcription: string | null;
  /** Rolling live STT interim — grey caption while the recognizer is hearing. */
  interimTranscription: string | null;
  utteranceText: string | null;
  utteranceConfidence: 'high' | 'medium' | 'low' | null;
  transcriptConfidence: 'high' | 'medium' | 'low' | null;
  /** How clearly the speech recogniser heard the words behind `transcription`
   *  (its own score, not the Observer's judgment). Weak scores blur the
   *  caption — the recogniser never returns silence, so an unsure result still
   *  arrives as a fluent sentence and must not look like a certain one. */
  transcriptClarity: 'high' | 'medium' | 'low' | 'unknown' | null;
  debugText: string | null;

  // Audio state
  audioEnabled: boolean;
  /** A MediaStream of the AAC's synthesized voice (all TTS paths), to send over a
   *  call so the student's button-press speech reaches the other side. */
  getCallAudioStream: () => MediaStream | null;
  isPlaying: boolean;
  /** Tag of the audio currently playing ("avatar"/"utterance"), or null. */
  audioPlayingTag?: string | null;
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

  /** AAC token-budget level for the energy bar (binding window % + band), or
   *  null when no budget is tracked / before the first server push. */
  budget: { percent: number; band: 'high' | 'moderate' | 'low'; window: string | null } | null;

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
  /** Latest server-side voice matching results — empty array when no voices heard or matched recently. */
  identifiedVoices: IdentifiedVoice[];

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
  /** Permitted websites for this student — delivered via session_snapshot and
   *  rendered as browser tiles on the Apps board. */
  permittedWebsites: PermittedWebsite[];

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;
  /** Counter bumped each time the server sends a `thinking` message
   *  (Speaker emitted a private_note). Consumers use it as a key to
   *  retrigger a question-mark animation next to the avatar. */
  thinkingPulse: number;
  /** Backend-busy flags streamed from the server (Speaker/Board/interpret).
   *  Drives the subtle ambient processing indicators. All-false when idle. */
  processing: ProcessingState;
  /** True while the STUDENT voice is actively playing (audio tag "utterance").
   *  Marks the moment a button press / composed sentence starts being voiced —
   *  used to flip the per-button indicator to "speaking" and to close the
   *  sentence builder exactly when the interpreted sentence begins. */
  voicingStudent: boolean;

  // Monitor status
  monitorError: string | null;
  monitorConsecutiveFailures: number;

  // Actions
  initialize: () => Promise<void>;
  sendMessage: (message: string, board?: ParsedBoardData) => Promise<void>;
  sendContextOnly: (text: string) => void;
  /** DEBUG-only: force the server-side budget to `percent` to exercise the
   *  throttle ladder live (server gates on debugMode). */
  debugSetBudget: (percent: number) => void;
  /** Diagnostics: report mic activate/deactivate to the server (logged to chat history, not sent to any live agent). */
  sendMicState: (active: boolean, reason?: string) => void;
  /** Diagnostics: report which speech-boundary detector is active (silero / webSpeechApi / energy) — same channel as sendMicState. */
  sendSpeechMethod: (method: "silero" | "webSpeechApi" | "energy" | "none") => void;
  /** Tell the server a live video call started/ended — drives facilitator mode.
   *  On end, `outcome` (declined/no_answer/unavailable/cancelled/ended) lets the
   *  AI react to a call that never connected. */
  sendCallActive: (active: boolean, outcome?: string) => void;
  /** Tell the server the student entered/left a group AAC chat (shape C). Pass
   *  the roomId on join, or null on leave. Drives peer-utterance fan-out. */
  sendConversationRoom: (roomId: string | null) => void;
  /** Tell the server the student focused a peer's face in the group chat (the
   *  peer's personId), or cleared it (null). Sets the addressee + asks the
   *  BoardManager to build phrases for that peer. */
  sendConversationFocus: (personId: string | null) => void;
  /** Current group-chat peers (name + stored-face photo) for the header face
   *  row. Empty when not in a group chat. */
  conversationRoster: ChatPeer[];
  /** Current group-chat turn cue (whose turn / who's awaiting), or null. */
  floorState: FloorCue | null;
  /** Send a board exit message (exit/exitBoard button pressed on loaded board) */
  sendBoardExit: (label: string, instruction: string) => void;
  sendVoice: (board?: ParsedBoardData) => Promise<void>;
  voiceButtons: (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => Promise<void>;
  /**
   * A press on a GAME-owned board (world-engine sidebar options). Voiced in
   * the student's voice (when `voice`), logged, and shared with the
   * conversation room — but never wakes an agent; the game executes it.
   */
  sendGamePress: (text: string, glyph?: string, voice?: boolean) => void;
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
  /** Experiment (glyphInputTranslation): per-sentence glyph translation of the
   *  speech this choice replies to, shown above the two overlay buttons. Null
   *  when off or the choice isn't a reply to incoming speech. */
  binaryChoiceInputGlyphs: Array<{ glyph: string; fallback?: string }> | null;
  dismissBinaryChoice: () => void;

  /** AI-initiated video-call directive (server `call_directive` message). The
   *  CallProvider consumes the latest one and dials automatically. `at` is a
   *  monotonic stamp so consumers can ignore a directive they've already acted
   *  on. Null until the first directive arrives. */
  callDirective: CallDirective | null;

  // Live API only — raw PCM audio streaming
  /** Send a raw PCM audio chunk (base64 Int16 16kHz) to Gemini Live API. Only available in Live mode. */
  sendPcmAudio?: (int16Base64: string) => void;
  /** Push already-computed unknown face descriptors out-of-band (not on a frame).
   *  Used at session start so the server can match before the first frame. */
  sendFaceDescriptors?: (descriptors: UnknownFaceDescriptor[]) => void;
  /** Push a speaker embedding computed from heard speech for server-side voice
   *  matching (the voice analog of sendFaceDescriptors). `clipId` ties it to a
   *  speech clip so the server syncs voice + STT before attributing. */
  sendVoiceDescriptors?: (descriptors: Array<{ embedding: number[]; quality?: number }>, clipId?: string) => void;
  /** Cost-saving (Phase 1, Whisper path): send an on-device transcript of a
   *  heard speech segment in place of raw audio. Only used when sttActive. */
  sendSpeechText?: (payload: { text: string; confidence?: number; clipId?: string; voiceDescriptor?: { embedding: number[]; quality?: number } }) => void;
  /** Cost-saving (Phase 1, ACTIVE path): send a VAD speech CLIP (base64 WAV) for
   *  server-side Google STT, in place of raw audio. Only used when sttActive.
   *  `lipActivity` carries per-face mouth activity over the utterance for
   *  audio-visual speaker attribution. */
  sendSpeechAudio?: (payload: {
    data: string;
    mimeType?: string;
    language?: string;
    clipId?: string;
    voiceDescriptor?: { embedding: number[]; quality?: number };
    lipActivity?: Array<{ bbox: { x: number; y: number; w: number; h: number }; mouthActivity: number; visible: boolean }>;
    acoustic?: { pitchHz: number | null; voiced: number; formantDispersion?: number | null };
  }) => void;
  /** Streaming STT (Web-Speech-like): open a session, feed PCM, finalize. */
  sendSttStreamStart?: (streamId: string, language?: string) => void;
  sendSttStreamChunk?: (streamId: string, data: string) => void;
  sendSttStreamEnd?: (streamId: string, meta?: {
    acoustic?: { pitchHz: number | null; voiced: number; formantDispersion?: number | null };
    lipActivity?: Array<{ bbox: { x: number; y: number; w: number; h: number }; mouthActivity: number; visible: boolean }>;
  }) => void;
  /** Cost-saving (Phase 1b): reply to a request_audio_clip with a backlog clip
   *  so the Observer can re-hear it. */
  sendAudioClip?: (payload: { clipId: string; data: string; mimeType?: string }) => void;
  /** Report a wrong face/voice match so the server penalizes the offending embedding. */
  sendIdentityCorrection?: (entityType: "student" | "user" | "contact", entityId: string, reason?: string) => void;
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
  /** DEBUG-only: full director internals + editable params, refreshed each turn. */
  socialPeerDebug?: import("@shared/social-bot/debug").SocialPeerDebugSnapshot | null;
  /** Home-board "Practice friend" preview face (null during a session and the
   *  brief post-session cooldown). */
  socialPeerPreview?: SocialPeerPreview | null;
  /** DEBUG-only: restart the active social peer with fully custom parameters. */
  reconfigureSocialPeer?: (params: import("@shared/social-bot/debug").SocialPeerParams) => void;
  notifySocialTrainerStarted?: () => void;
  /** DEBUG-only: effective peer voice-pitch shift (semitones) currently applied. */
  peerVoicePitch?: number;
  /** DEBUG-only: live client-side override of the peer's voice-pitch shift. The
   *  shift is client-side, so this takes effect immediately (no peer restart). */
  setPeerVoicePitch?: (semitones: number) => void;
  /** DEBUG-only: effective peer formant shift (semitones) currently applied. */
  peerVoiceFormant?: number;
  /** DEBUG-only: live client-side override of the peer's formant shift. */
  setPeerVoiceFormant?: (semitones: number) => void;

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
