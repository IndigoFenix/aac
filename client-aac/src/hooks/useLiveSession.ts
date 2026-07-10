// client-aac/src/hooks/useLiveSession.ts
// WebSocket-based hook for Gemini Live API sessions.
// Replaces useDualAgent for Live mode — same return interface, WebSocket transport.

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";
import type { ParsedBoardData, PermittedWebsite } from "@shared/schema";
import { useStreamingAudioPlayer } from "./useStreamingAudioPlayer";
import { useAudioRecorder } from "./useAudioRecorder";
import type { ComposedGrid } from "@/lib/composeFrameGrid";
import type { UnknownFaceDescriptor } from "./usePersonIdentification";
import { useDebugRequestCache, type CachedRequest } from "./useDebugRequestCache";
import { API_BASE_URL } from "@/lib/api-base";
import { getCurrentGps, metersBetween, type GpsReading } from "@/lib/geolocation";
import { GUESSING_REJECT } from "@shared/guessing-mode/state.js";

/** Context passed when guessing is launched from the sentence builder for a slot.
 *  The server uses this to pre-select the top-level guessing category from
 *  the builder's active tab so the user skips the "what kind of thing?" step. */
export interface GuessingBuilderContext { targetSlot: number | null; partialGlyph: string; category: string }

// Re-export shared types
export type {
  DualAgentMessage,
  IdentifiedPerson,
  IdentifiedFace,
  IdentifiedVoice,
  ActiveAppData,
  BoardPatch,
  CachedAudioClip,
  BinaryChoiceOption,
  CallDirective,
} from "./dual-agent-types";
import type {
  DualAgentMessage,
  IdentifiedPerson,
  IdentifiedFace,
  IdentifiedVoice,
  ActiveAppData,
  BoardPatch,
  CachedAudioClip,
  BinaryChoiceOption,
  CallDirective,
  ChatPeer,
  FloorCue,
  ProcessingState,
  UseDualAgentReturn,
} from "./dual-agent-types";
import { CLIENT_CAPABILITIES } from "./dual-agent-types";
import { classifyScene, sceneSignature } from "@shared/aac/scene-state";
import {
  saveSessionSnapshot,
  loadLatestSnapshot,
  cleanupOldSessions,
} from "@/services/aac-local-storage";
import { registerSymbolPath } from "@/lib/glyph-images";
import type {
  AacLocalStorageConfig,
  AacSessionSnapshot,
} from "@shared/aac-local-storage";

export interface UseLiveSessionOptions {
  studentId: string;
  // Set when the AAC session is running in classroom mode. Forwarded to the
  // live-relay's initialize message so the server stamps chat_sessions with
  // the classroom and the dual-agent can use it for prompt building / roster.
  classroomId?: string | null;
  language?: string;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  /** Experiment (glyphInputTranslation): per-sentence glyph-string translation
   *  of the speech just directed at the user, for the header glyph strip. */
  onInputGlyphs?: (data: Array<{ glyph: string; fallback?: string }>) => void;
  onContextBoardUpdate?: (board: ParsedBoardData) => void;
  onContextBoardRemove?: (label: string) => void;
  onBoardPatch?: (patch: BoardPatch) => void;
  onSetBoard?: (data: { board: ParsedBoardData; name: string; boardId: string }) => void;
  onUnloadBoard?: () => void;
  onAiButtonPress?: (data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => void;
  onSymbolUpdate?: (data: { buttonLabel: string; symbolPath: string }) => void;
  onThinkingModeChange?: (thinking: boolean) => void;
  autoPlayAudio?: boolean;
  /** Per-tag pitch shift in semitones. Keys are audio tags: "avatar" (AI voice), "utterance" (student voice). */
  pitchByTag?: Record<string, number>;
  debugMode?: boolean;
  /** Function to capture a camera frame (used for initial image on startup) */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to capture a high-resolution frame for focus analysis */
  captureHighResFrame?: () => Promise<Blob | null>;
  /** Function to get serialized gesture/expression context (face + hand events) */
  getGestureContext?: () => string | null;
  /** Cost-saving (Phase 2): structured scene snapshot (people + hand gestures)
   *  used to decide frame-vs-scene_state and to build the scene_state text. */
  getSceneSnapshot?: () => import("@shared/aac/scene-state").SceneSnapshot | null;
  /** Seizure Phase 2b: whether SUSTAINED vocal/sound energy is present right now.
   *  Used ONLY to annotate a "seizure"-escalated [MOTION SIGNATURE] — audio never
   *  escalates on its own (Rett baseline breathing = false-positive trap). */
  getVocalCue?: () => boolean;
  /** AI invoked sleep / end_session — caller routes to the engagement state machine. */
  onSleepStateChange?: (state: import("@/lib/cameraAttentivenessTypes").SleepState, source: "ai" | "system") => void;
  /** AI invoked report_false_wake — caller bumps wake threshold dampening. */
  onFalseWakeReport?: (reason: string) => void;
  /** Server drove perception fidelity (cost-saving) — caller routes to the
   *  camera context so the data-flow gate and avatar follow. */
  onSetFidelity?: (level: import("@/lib/cameraAttentivenessTypes").PerceptionFidelity, reason?: string) => void;
  /** Observer asked to re-hear a recent speech clip (Phase 1b). The caller
   *  looks it up in its audio ring buffer and replies via sendAudioClip. */
  onRequestAudioClip?: (clipId: string) => void;
}

export function useLiveSession(options: UseLiveSessionOptions): UseDualAgentReturn {
  const {
    studentId,
    classroomId,
    language = "en",
    onBoardUpdate,
    onInputGlyphs,
    onContextBoardUpdate,
    onContextBoardRemove,
    onBoardPatch,
    onSetBoard,
    onUnloadBoard,
    onAiButtonPress,
    onSymbolUpdate,
    onThinkingModeChange,
    autoPlayAudio = true,
    pitchByTag,
    debugMode = false,
    captureFrame,
    captureHighResFrame,
    onSleepStateChange,
    onFalseWakeReport,
    onSetFidelity,
    onRequestAudioClip,
  } = options;
  const { user, isLoading: isAuthLoading } = useAuth();
  // Stable ref so ws.onopen always reads the latest user
  const userRef = useRef(user);
  userRef.current = user;
  const authLoadingRef = useRef(isAuthLoading);
  authLoadingRef.current = isAuthLoading;
  const captureFrameRef = useRef(captureFrame);
  captureFrameRef.current = captureFrame;
  const captureHighResFrameRef = useRef(captureHighResFrame);
  captureHighResFrameRef.current = captureHighResFrame;
  const onSleepStateChangeRef = useRef(onSleepStateChange);
  onSleepStateChangeRef.current = onSleepStateChange;
  const onFalseWakeReportRef = useRef(onFalseWakeReport);
  onFalseWakeReportRef.current = onFalseWakeReport;
  const onSetFidelityRef = useRef(onSetFidelity);
  onSetFidelityRef.current = onSetFidelity;
  const onRequestAudioClipRef = useRef(onRequestAudioClip);
  onRequestAudioClipRef.current = onRequestAudioClip;

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Periodic GPS refresh (location context). Re-queried on the monitor cadence;
  // only re-sent when the device has moved meaningfully.
  const gpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastGpsSentRef = useRef<GpsReading | null>(null);

  // Debug state
  const [debugData, setDebugData] = useState<Record<string, any>>({});
  const [audioClipCache] = useState<CachedAudioClip[]>([]);
  const requestCache = useDebugRequestCache();

  // Monitor status
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [monitorConsecutiveFailures, setMonitorConsecutiveFailures] = useState(0);

  // Server-side face recognition results
  const [identifiedFaces, setIdentifiedFaces] = useState<IdentifiedFace[]>([]);
  // Server-side voice recognition results
  const [identifiedVoices, setIdentifiedVoices] = useState<IdentifiedVoice[]>([]);

  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Server-supplied tuning bundle. Stored as state so any consumer that
  // wants to react to a new config (e.g. when reconnecting against a
  // server with different thresholds) re-renders. Defaults to null —
  // consumers fall back to their built-in defaults until the first
  // `initialized` message lands.
  const [clientConfig, setClientConfig] = useState<import("./dual-agent-types").ClientConfig | null>(null);
  // Phase 2 scene_state: read inside runDetectionWithGrid without rebuilding it.
  const sceneStateActiveRef = useRef(false);
  sceneStateActiveRef.current = clientConfig?.sceneStateActive ?? false;
  // `runDetectionWithGrid` is a useCallback that deliberately does NOT rebuild on
  // every render (its deps are [wsSend, activeApp]). So it must read the option
  // callbacks (getSceneSnapshot / getGestureContext) through a ref — otherwise it
  // captures the FIRST render's closures and the scene snapshot freezes at its
  // load-time value. Keep this ref current every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Last SENT scene signature + person count, for escalation change-detection.
  const lastSceneSignatureRef = useRef<string | null>(null);
  const lastPersonCountRef = useRef<number | null>(null);
  const lastPostureRef = useRef<string | null>(null);
  // Bumps each time a real camera frame/snapshot is actually sent (frame_grid or
  // focus_frame — NOT the text-only scene_state). The avatar blinks on each
  // change instead of on a random timer.
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);
  // Mirror of isInitialized for use inside long-lived closures (ws.onclose)
  // that would otherwise capture a stale `false` from the initial render.
  const isInitializedRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  // Which startup phase the server is in, shown as a subtitle under the
  // "waking up" indicator. Defaults to "connecting" (shown from the moment we
  // open the socket until the server's first startup_progress message). The
  // server walks it through checkingNotes → planningSession → loadingApps →
  // wakingUp before sending `initialized`, which clears isLoading.
  const [startupStage, setStartupStage] =
    useState<"connecting" | "checkingNotes" | "planningSession" | "loadingApps" | "wakingUp">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [safetyBlocked, setSafetyBlocked] = useState(false);
  const rateLimitedRef = useRef(false);
  // Set true right before we intentionally close the socket (clearSession,
  // unmount). The ws.onclose handler reads this to decide whether the close
  // was expected and should NOT trigger an auto-reconnect.
  const closingIntentionallyRef = useRef(false);

  // Message state
  const [currentMessage, setCurrentMessage] = useState<DualAgentMessage | null>(null);
  const [transcription, setTranscription] = useState<string | null>(null);
  // Rolling live STT interim (grey caption) — see the transcript_interim handler.
  const [interimTranscription, setInterimTranscription] = useState<string | null>(null);
  const interimFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [utteranceText, setUtteranceText] = useState<string | null>(null);
  const [utteranceConfidence, setUtteranceConfidence] = useState<'high' | 'medium' | 'low' | null>(null);
  const [transcriptConfidence, setTranscriptConfidence] = useState<'high' | 'medium' | 'low' | null>(null);
  const [debugText, setDebugText] = useState<string | null>(null);

  // Audio state
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  // User-controlled mute state (cave toggle — the AI cannot change this)
  const [muteState, setMuteStateImpl] = useState<"unmuted" | "muted">("unmuted");
  // Last AI-initiated mode change — used to flash the "AI: <mode>" indicator
  const [lastModeChange, setLastModeChange] = useState<{ mode: "companion" | "facilitator" | "standby"; reason?: string; source: "ai"; at: number } | null>(null);
  // AAC token-budget level for the in-client energy bar (binding window % + band).
  // null until the server sends the first budget_update (it only does so for
  // economizing sessions, which are the ones that track a budget).
  const [budget, setBudget] = useState<{ percent: number; band: "high" | "moderate" | "low"; window: string | null } | null>(null);

  // Response mode
  const [responseMode, setResponseModeState] = useState<"fast" | "analyze">("fast");

  // Video capture state
  const [videoCaptureEnabled, setVideoCaptureEnabled] = useState(true);

  // Pause state
  const [paused, setPausedState] = useState(false);

  // Active app state
  const [activeApp, setActiveApp] = useState<ActiveAppData | null>(null);

  // AI-initiated video-call directive (server `call_directive`). The CallProvider
  // consumes the latest one and dials; `at` lets it dedupe.
  const [callDirective, setCallDirective] = useState<CallDirective | null>(null);

  // Group-chat peers (server `conversation_roster`) for the header face row.
  const [conversationRoster, setConversationRoster] = useState<ChatPeer[]>([]);
  // Group-chat turn cue (server `floor_state`).
  const [floorState, setFloorState] = useState<FloorCue | null>(null);

  // Server-owned social-training session (peer persona replaces the
  // Speaker server-side). Set by the `social_session` message; the peer's
  // speech/text flow through the normal Speaker channels.
  const [socialSession, setSocialSession] = useState<import("./dual-agent-types").SocialSessionInfo | null>(null);
  // Per-turn director state (face target + mode + rapport) while a social
  // session is active — drives the ProceduralFace.
  const [socialPeerState, setSocialPeerState] = useState<import("@shared/social-bot/state").BotStatePayload | null>(null);
  // DEBUG-only: full director internals + editable params, refreshed each turn.
  const [socialPeerDebug, setSocialPeerDebug] = useState<import("@shared/social-bot/debug").SocialPeerDebugSnapshot | null>(null);
  // Home-board "Practice friend" preview face (the peer that will appear when a
  // session starts). Null during a session and during the post-session beat.
  const [socialPeerPreview, setSocialPeerPreview] = useState<import("./dual-agent-types").SocialPeerPreview | null>(null);
  // DEBUG-only: live client-side override of the peer's voice-pitch shift
  // (semitones). When set, supersedes the server's age-matched `voicePitch`.
  // The shift is purely client-side, so the dial takes effect immediately
  // without restarting the peer. Cleared when the session ends.
  const [peerVoicePitchOverride, setPeerVoicePitchOverride] = useState<number | null>(null);
  // DEBUG-only: live client-side override of the peer's formant shift
  // (semitones). When set, supersedes the server's age-matched `voiceFormant`.
  const [peerVoiceFormantOverride, setPeerVoiceFormantOverride] = useState<number | null>(null);

  // Enabled built-in apps + custom apps assigned to this student.
  // Populated from session_snapshot and consumed by the Apps board overlay.
  const [enabledApps, setEnabledApps] = useState<Array<{ id: string; name: string; icon: string; needsStartupResolution?: boolean }>>([]);
  const [availableCustomApps, setAvailableCustomApps] = useState<Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>>([]);
  // Permitted websites for this student — populated from session_snapshot and
  // consumed by the Apps board overlay as browser tiles.
  const [permittedWebsites, setPermittedWebsites] = useState<PermittedWebsite[]>([]);

  // Set to the appId while a request_app_open round-trip is in flight (the
  // server is resolving startup params). The Apps board shows a loading state
  // and the incoming `app_open` (or a client backstop) clears it.
  const [appOpenPending, setAppOpenPending] = useState<string | null>(null);
  const appOpenBackstopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // App canvas capture ref (for drawing app, etc.)
  const captureAppCanvasRef = useRef<(() => Promise<Blob | null>) | null>(null);

  // Guessing mode state — the engine (dimensions, weights, history, facts)
  // lives on the SERVER now. This hook only tracks the UI flag so the
  // surface can highlight Word Finder buttons; mutations go through the
  // intent messages (guessing_enter / guessing_press / guessing_reject /
  // guessing_narrow / exit_guessing). Was previously client-owned but
  // every logic tweak required a client rebuild + redeploy.
  const [guessingMode, setGuessingMode] = useState(false);
  const [constructionSuggestions, setConstructionSuggestions] = useState<
    import("./dual-agent-types").ConstructionSuggestionsClient | null
  >(null);
  const [constructionMemoryChips, setConstructionMemoryChips] = useState<
    Partial<Record<import("./dual-agent-types").ConstructionStateClient["category"],
      import("./dual-agent-types").ConstructionMemoryChipsClient>>
  >({});

  // Avatar emote state
  const [emote, setEmote] = useState<"happy" | "sad" | "neutral">("happy");

  // Incrementing counter — bumped every time the server signals Speaker
  // has issued a private_note. The avatar overlay uses this as a key
  // prop so each new "thinking" cue restarts the question-mark
  // animation cleanly, even if two notes fire back-to-back.
  const [thinkingPulse, setThinkingPulse] = useState(0);
  // Backend-busy flags from the server `processing` message (Speaker turn /
  // Board Manager rebuild / sentence interpret). Drive the subtle ambient
  // processing indicators.
  const [processing, setProcessing] = useState<ProcessingState>({ speaker: false, board: false, interpret: false });

  // Binary-choice overlay state — non-null array of two options shows the
  // overlay. Yes/No questions go through this same path now (the canonical
  // `yes` / `no` SYMBOLs render with animated icons and auto-color the
  // SENTENCE BUTTON green / red), so there's no separate yes_no surface.
  const [binaryChoiceOptions, setBinaryChoiceOptions] = useState<BinaryChoiceOption[] | null>(null);
  // Escape-button kind for the binary-choice overlay — server-supplied.
  // "maybe" (yellow) when the pair forms a yes/no; "neither" (red, no-symbol)
  // otherwise. The display layer doesn't need to know the rule — it just
  // renders the kind it's told.
  const [binaryChoiceEscapeKind, setBinaryChoiceEscapeKind] = useState<"maybe" | "neither" | null>(null);
  // Experiment (glyphInputTranslation): per-sentence glyph translation of the
  // speech this choice replies to, shown above the two overlay buttons. Null
  // when off or the choice isn't a reply to incoming speech.
  const [binaryChoiceInputGlyphs, setBinaryChoiceInputGlyphs] = useState<Array<{ glyph: string; fallback?: string }> | null>(null);
  const dismissBinaryChoice = useCallback(() => {
    setBinaryChoiceOptions(null);
    setBinaryChoiceEscapeKind(null);
    setBinaryChoiceInputGlyphs(null);
  }, []);

  // Caretaker alarm raised by the Observer agent. "alert" = a short
  // attention nudge; "emergency" = a building alarm with an on-screen
  // cancel button. The audible/visible effect lives in <AlarmOverlay>;
  // here we just hold the active alarm and expose a way to clear it.
  const [activeAlarm, setActiveAlarm] = useState<{ level: "alert" | "emergency"; reason: string } | null>(null);
  const cancelAlarm = useCallback(() => setActiveAlarm(null), []);

  // Focus frame active state — briefly true when AI requests a focus frame
  const [focusActive, setFocusActive] = useState(false);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deferred ask_binary_choice: same pattern — buffered options until TTS ends
  const pendingAskBinaryChoiceRef = useRef<BinaryChoiceOption[] | null>(null);
  const pendingAskBinaryChoiceEscapeKindRef = useRef<"maybe" | "neither" | null>(null);
  const pendingAskBinaryChoiceInputGlyphsRef = useRef<Array<{ glyph: string; fallback?: string }> | null>(null);

  // Local storage config (from server) — stored as ref to avoid re-renders
  const localStorageConfigRef = useRef<AacLocalStorageConfig | null>(null);

  // Clean up old local sessions on mount (fire-and-forget)
  useEffect(() => {
    cleanupOldSessions().then(count => {
      if (count > 0) console.log(`[useLiveSession] Cleaned up ${count} old local session(s)`);
    }).catch(() => {});
  }, []);

  // Promise chain for client-side TTS — preserves ordering between consecutive calls
  const clientTtsChainRef = useRef(Promise.resolve());

  // Local TTS sentence buffer — accumulates fragments until a sentence boundary
  const localTtsBufferRef = useRef("");
  const localTtsFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Slow-connection auto-switch: tracks consecutive audio timeouts
  const audioTimeoutCountRef = useRef(0);
  const localTtsActiveRef = useRef(false); // Dynamic override when slow connection detected

  // While a social-training session is active, the peer (which plays on the
  // "avatar" tag) gets an age-matched pitch shift sent by the server so the
  // adult Gemini voice reads as a same-age conversation partner. This
  // overrides the companion AI's configured pitch for the duration.
  const effectivePitchByTag = useMemo(() => {
    if (!socialSession) return pitchByTag;
    const peerPitch = peerVoicePitchOverride ?? socialSession.voicePitch;
    if (typeof peerPitch === "number" && peerPitch !== 0) {
      return { ...pitchByTag, avatar: peerPitch };
    }
    // An explicit override of 0 must still flatten the avatar pitch.
    if (peerVoicePitchOverride === 0) return { ...pitchByTag, avatar: 0 };
    return pitchByTag;
  }, [pitchByTag, socialSession, peerVoicePitchOverride]);

  // The peer (avatar tag) also gets an age-matched FORMANT shift — the primary
  // "younger" cue — sent by the server and overridable live in debug. Only the
  // peer uses formant shifting; the companion/student voices stay unshaped.
  const effectiveFormantByTag = useMemo(() => {
    if (!socialSession) return undefined;
    const peerFormant = peerVoiceFormantOverride ?? socialSession.voiceFormant;
    if (typeof peerFormant === "number") return { avatar: peerFormant };
    return undefined;
  }, [socialSession, peerVoiceFormantOverride]);

  // Streaming audio player
  const audioPlayer = useStreamingAudioPlayer({
    autoPlay: autoPlayAudio,
    pitchByTag: effectivePitchByTag,
    formantByTag: effectiveFormantByTag,
    onPlaybackEnd: () => {
      // Show deferred binary-choice overlay after TTS finishes.
      if (pendingAskBinaryChoiceRef.current) {
        const opts = pendingAskBinaryChoiceRef.current;
        const kind = pendingAskBinaryChoiceEscapeKindRef.current;
        const glyphs = pendingAskBinaryChoiceInputGlyphsRef.current;
        pendingAskBinaryChoiceRef.current = null;
        pendingAskBinaryChoiceEscapeKindRef.current = null;
        pendingAskBinaryChoiceInputGlyphsRef.current = null;
        setBinaryChoiceOptions(opts);
        setBinaryChoiceEscapeKind(kind);
        setBinaryChoiceInputGlyphs(glyphs);
      }
    },
  });

  // Audio recorder
  const audioRecorder = useAudioRecorder();

  // Stable refs for callbacks
  const onBoardUpdateRef = useRef(onBoardUpdate);
  onBoardUpdateRef.current = onBoardUpdate;
  const onInputGlyphsRef = useRef(onInputGlyphs);
  onInputGlyphsRef.current = onInputGlyphs;
  const onContextBoardUpdateRef = useRef(onContextBoardUpdate);
  onContextBoardUpdateRef.current = onContextBoardUpdate;
  const onContextBoardRemoveRef = useRef(onContextBoardRemove);
  onContextBoardRemoveRef.current = onContextBoardRemove;
  const onBoardPatchRef = useRef(onBoardPatch);
  onBoardPatchRef.current = onBoardPatch;
  const onSetBoardRef = useRef(onSetBoard);
  onSetBoardRef.current = onSetBoard;
  const onUnloadBoardRef = useRef(onUnloadBoard);
  onUnloadBoardRef.current = onUnloadBoard;
  const onAiButtonPressRef = useRef(onAiButtonPress);
  onAiButtonPressRef.current = onAiButtonPress;
  const onSymbolUpdateRef = useRef(onSymbolUpdate);
  onSymbolUpdateRef.current = onSymbolUpdate;
  const onThinkingModeChangeRef = useRef(onThinkingModeChange);
  onThinkingModeChangeRef.current = onThinkingModeChange;

  // Accumulator for streamed text (within a turn)
  const textAccumRef = useRef("");

  // Board patch accumulation — combines rapid sequential patches (e.g. remove then add
  // from the same model response) into one combined patch before passing to the callback.
  // This prevents React 18 state batching from losing the first of two rapid patches.
  const pendingPatchRef = useRef<{ add: Array<{ label: string; iconRef: string }>; remove: string[] } | null>(null);
  const patchFlushScheduledRef = useRef(false);

  // -------------------------------------------------------------------------
  // WebSocket send helper
  // -------------------------------------------------------------------------

  const wsSend = useCallback((msg: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      // Diagnose silent drops: if a button press / board_exit / user_message
      // gets here while the socket isn't OPEN, it disappears. Logging readyState
      // (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED, undefined=no socket) tells
      // us whether the WS died or never finished reconnecting.
      const rs = wsRef.current?.readyState;
      console.warn(`[useLiveSession] DROPPED ${msg?.type || "msg"} — wsReadyState=${rs ?? "no-socket"}`);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Local browser TTS helpers
  // -------------------------------------------------------------------------

  /** Find the best matching browser voice for a language and role */
  const pickBrowserVoice = useCallback((lang: string, role: "ai" | "student"): SpeechSynthesisVoice | null => {
    const voices = window.speechSynthesis?.getVoices() || [];
    // Gender preference: student matches student gender (default boy), AI uses female
    const genderHint = role === "ai" ? "female" : "male";
    const langPrefix = lang.split("-")[0]; // "he-IL" -> "he"
    // Prefer natural/Google voices matching language + gender
    return voices.find(v => v.lang.startsWith(langPrefix) && v.name.toLowerCase().includes(genderHint))
      || voices.find(v => v.lang.startsWith(langPrefix) && (v.name.includes("Natural") || v.name.includes("Google")))
      || voices.find(v => v.lang.startsWith(langPrefix))
      || null;
  }, []);

  /** Speak text using browser speechSynthesis, returns a promise that resolves when done */
  const speakLocal = useCallback((text: string, lang: string, role: "ai" | "student"): Promise<void> => {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || !text.trim()) { resolve(); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      const voice = pickBrowserVoice(lang, role);
      if (voice) utterance.voice = voice;
      utterance.rate = 1.0;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }, [pickBrowserVoice]);

  /** Flush any buffered local TTS text as a complete utterance */
  const flushLocalTtsBuffer = useCallback((lang: string, role: "ai" | "student") => {
    const text = localTtsBufferRef.current.trim();
    if (!text) return;
    localTtsBufferRef.current = "";
    // Chain onto the TTS promise chain to preserve ordering
    clientTtsChainRef.current = clientTtsChainRef.current.then(() => speakLocal(text, lang, role));
  }, [speakLocal]);

  // -------------------------------------------------------------------------
  // Handle incoming server messages
  // -------------------------------------------------------------------------

  const handleServerMessage = useCallback((event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "reload":
          // Clinician asked us to reload (e.g. to apply changed AAC settings).
          try { window.location.reload(); } catch { /* ignore */ }
          break;
        case "initialized":
          setSessionId(msg.sessionId);
          // Capture server-driven tuning (activity monitor / sleep / gesture)
          // if present. Newer servers ship this; older builds omit it and
          // consumers fall back to their built-in defaults.
          if ((msg as any).clientConfig) {
            setClientConfig((msg as any).clientConfig);
          }
          setIsInitialized(true);
          isInitializedRef.current = true;
          // Session is ready — clear the "waking up" indicator. Previously we
          // waited for the first board to arrive, but on reconnect there's no
          // guaranteed first board (the model may not produce one), which left
          // the UI stuck. The board will render whenever it actually arrives.
          setIsLoading(false);
          setError(null);
          break;

        case "startup_progress":
          // Pre-`initialized` phase label — drives the waking-up subtitle.
          // Ignore once we're past loading (defensive; server won't send late).
          if ((msg as any).stage) {
            setStartupStage((msg as any).stage);
          }
          break;

        case "client_config_update":
          // Mid-session clientConfig patch (Observer attention dials flip
          // sttActive / sceneStateActive). Shallow-merge so consumer refs
          // (sttActiveRef / sceneStateActiveRef, refreshed each render) pick up
          // the change live — no reconnect needed.
          if ((msg as any).config) {
            setClientConfig(prev => prev ? { ...prev, ...(msg as any).config } : (msg as any).config);
          }
          break;

        case "text": {
          // Accumulate streamed text — keep the same message ID to avoid re-triggering animations
          // Skip empty/whitespace-only text to avoid clearing the display
          if (!msg.data || !msg.data.trim()) break;

          let textData = msg.data;

          // Detect `<ctrl##>` control tokens. On the upgraded
          // gemini-live-2.5-flash-native-audio model these tokens occasionally
          // leak through the output transcription, separating Google's
          // internal recovery scaffolding (e.g. "If you were doing both, try
          // just one first. If you were silent, say something.<ctrl95>") from
          // the model's actual response. The audio output is correct — only
          // the transcription leaks. When we see a ctrl token, treat
          // everything up to and including it as scaffold, discard whatever
          // text was accumulated so far (it was all scaffold), and keep only
          // what comes after the last ctrl token in this chunk.
          const ctrlMatches = [...textData.matchAll(/<ctrl\d+>/g)];
          if (ctrlMatches.length > 0) {
            const last = ctrlMatches[ctrlMatches.length - 1];
            const afterCtrl = textData.slice(last.index! + last[0].length);
            // Logged loudly so we can audit what scaffolding patterns leak
            // — the full original text (scaffold + tokens) is preserved here
            // even though the user-facing display drops it.
            console.warn(
              "[LEAK] ctrl-token scaffold detected → discarded prefix + accumulated.",
              "Tokens:", ctrlMatches.map(m => m[0]).join(", "),
              "| Full original:", JSON.stringify(textData),
              "| Accumulated so far (also discarded):", JSON.stringify(textAccumRef.current),
              "| Kept (after last ctrl):", JSON.stringify(afterCtrl),
            );
            textAccumRef.current = "";
            setCurrentMessage(prev =>
              prev?.role === "assistant" ? { ...prev, content: "" } : prev,
            );
            textData = afterCtrl;
            if (!textData.trim()) break;
          }

          // Strip any other tag-like artifacts that occasionally leak from
          // Gemini's output transcription (e.g. "<end_of_turn>", "<unk>").
          const tagMatches = textData.match(/<[^<>]+>/g);
          if (tagMatches) {
            console.warn("[LEAK] non-ctrl tag artifacts stripped:", tagMatches.join(", "), "| original:", JSON.stringify(textData));
          }
          const cleaned = textData.replace(/<[^<>]+>/g, "");
          if (!cleaned.trim()) break;
          // Drop the entire turn if the model leaks a private-reasoning prefix —
          // those are the model's own notes (it should be using stay_silent())
          // and must not be shown to the user. Match only at the start of a
          // fresh accumulation so we don't truncate legitimate speech.
          if (
            !textAccumRef.current &&
            /^\s*\[(private\s*note|note|thinking|internal|reasoning|self[\s-]*note)\b/i.test(cleaned)
          ) {
            console.warn("[LEAK] private-note prefix dropped:", JSON.stringify(cleaned));
            break;
          }
          textAccumRef.current += cleaned;
          // The AI is now speaking — drop any lingering "spoken to the user"
          // caption (yellow) so it doesn't overlap the AI's white words.
          setTranscription(null);
          setCurrentMessage(prev => ({
            id: prev?.role === "assistant" ? prev.id : `msg-${Date.now()}`,
            role: "assistant",
            content: textAccumRef.current,
            timestamp: prev?.role === "assistant" ? prev.timestamp : new Date().toISOString(),
          }));
          break;
        }

        case "utterance":
          // The user is responding — clear the "spoken to the user" caption
          // (yellow) now that they're voicing their reply.
          setTranscription(null);
          setUtteranceText(prev => (prev || "") + (msg.text || ""));
          if (msg.confidence) setUtteranceConfidence(msg.confidence);
          break;

        case "audio_interrupt":
          // Gemini was interrupted by user input — stop audio immediately
          audioPlayer.clear();
          // Also cancel any local browser TTS
          window.speechSynthesis?.cancel();
          localTtsBufferRef.current = "";
          if (localTtsFlushTimerRef.current) { clearTimeout(localTtsFlushTimerRef.current); localTtsFlushTimerRef.current = null; }
          break;

        case "audio_clear_tag":
          // Targeted clear — e.g. drop a stale student-voice queue without
          // touching the AI's avatar audio.
          if (typeof msg.tag === "string") {
            audioPlayer.clearByTag(msg.tag);
          }
          break;

        case "transcript":
          setTranscription(msg.data);
          if (msg.confidence) setTranscriptConfidence(msg.confidence);
          // A routed (authoritative) transcript supersedes the live interim.
          setInterimTranscription(null);
          if (interimFadeTimerRef.current) { clearTimeout(interimFadeTimerRef.current); interimFadeTimerRef.current = null; }
          break;

        case "transcript_interim": {
          // Rolling live STT text — grey caption while the recognizer is still
          // hearing; "" (sent at each final) clears it back to the yellow
          // transcript. A staleness timer clears it anyway in case the clear
          // message is lost, so tentative text can never linger.
          if (interimFadeTimerRef.current) { clearTimeout(interimFadeTimerRef.current); interimFadeTimerRef.current = null; }
          const interim = (msg as any).data as string;
          if (interim && interim.trim()) {
            setInterimTranscription(interim);
            interimFadeTimerRef.current = setTimeout(() => {
              interimFadeTimerRef.current = null;
              setInterimTranscription(null);
            }, 4000);
          } else {
            setInterimTranscription(null);
          }
          break;
        }

        case "context":
          setDebugText(msg.data);
          break;

        case "board":
          onBoardUpdateRef.current?.(msg.data);
          break;

        case "input_glyphs":
          if (Array.isArray(msg.data) && msg.data.length > 0) onInputGlyphsRef.current?.(msg.data);
          break;

        case "context_button_add":
          onContextBoardUpdateRef.current?.(msg.data);
          break;

        case "context_button_remove":
          onContextBoardRemoveRef.current?.(msg.data?.label);
          break;

        case "board_patch": {
          // Accumulate rapid sequential patches (remove + add from same model turn)
          // into one combined patch. Without this, React 18 batching can lose the
          // first of two rapid setBoardPatch() calls, silently dropping removes.
          const prev = pendingPatchRef.current || { add: [], remove: [] };
          pendingPatchRef.current = {
            add: [...prev.add, ...(msg.data.add || [])],
            remove: [...prev.remove, ...(msg.data.remove || [])],
          };
          if (!patchFlushScheduledRef.current) {
            patchFlushScheduledRef.current = true;
            queueMicrotask(() => {
              const patch = pendingPatchRef.current;
              pendingPatchRef.current = null;
              patchFlushScheduledRef.current = false;
              if (patch && (patch.add.length > 0 || patch.remove.length > 0)) {
                onBoardPatchRef.current?.(patch);
              }
            });
          }
          break;
        }

        case "symbol_update":
          // Auto-generated symbol is ready — update the button's image
          onSymbolUpdateRef.current?.(msg.data);
          break;

        case "set_board":
          // AI selected a pre-built board — notify parent (handled separately from regular board updates)
          onSetBoardRef.current?.(msg.data);
          setIsLoading(false);
          break;

        case "unload_board":
          // AI unloaded the prebuilt board — notify parent to clear prebuiltBoardData
          onUnloadBoardRef.current?.();
          break;

        case "ai_button_press":
          // AI pressed a navigation button on the loaded board
          if (msg.data?.targetPageId) {
            onAiButtonPressRef.current?.(msg.data);
          }
          break;

        case "avatar_audio":
          // AI voice audio chunk — tagged so avatar mouth animates. Always queued so
          // it plays AND transmits over a call; the header mute silences only LOCAL
          // speakers via the player's master gain (setLocalMuted), it never drops the
          // audio (which would also stop it reaching the call).
          audioPlayer.queueChunk({ chunk: msg.data, format: msg.format || "mp3", tag: "avatar" });
          break;

        case "utterance_audio":
          // Student voice audio chunk — the AAC user's "voice". Always queued so it
          // transmits over a call (this IS how they speak). Local mute is via the
          // master gain, not by dropping the chunk.
          audioPlayer.queueChunk({ chunk: msg.data, format: msg.format || "mp3", tag: "utterance" });
          break;

        case "client_tts": {
          // Server requests client-side ElevenLabs TTS synthesis. Always synthesized
          // + queued so it transmits over a call; local mute is the master gain.
          const { text: ttsText, voiceId, apiKey, language: ttsLang, voiceRole } = msg.data as {
            text: string; voiceId: string; apiKey: string; language: string; voiceRole: "ai" | "student";
          };
          const tag = voiceRole === "ai" ? "avatar" : "utterance";
          // Chain to preserve ordering between consecutive client_tts events
          clientTtsChainRef.current = clientTtsChainRef.current.then(async () => {
            try {
              const V3_LANGS = new Set(["he", "ar"]);
              const modelId = ttsLang && V3_LANGS.has(ttsLang) ? "eleven_v3" : "eleven_multilingual_v2";
              const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                method: "POST",
                headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
                body: JSON.stringify({ text: ttsText, model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
              });
              if (!resp.ok) {
                console.error("[LiveSession] Client TTS error:", resp.status);
                return;
              }
              const arrayBuf = await resp.arrayBuffer();
              const bytes = new Uint8Array(arrayBuf);
              let binary = "";
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              const base64 = btoa(binary);
              audioPlayer.queueChunk({ chunk: base64, format: "mp3", tag });
            } catch (err) {
              console.error("[LiveSession] Client TTS failed:", err);
            }
          });
          break;
        }

        case "client_local_tts": {
          // Server requests browser-native speechSynthesis
          if (!audioEnabled) break;
          const { text: localText, language: localLang, voiceRole: localRole } = msg.data as {
            text: string; language: string; voiceRole: "ai" | "student";
          };
          // Buffer text and flush at sentence boundaries to avoid choppy speech
          localTtsBufferRef.current += (localTtsBufferRef.current ? " " : "") + localText;
          // Clear any pending flush timer
          if (localTtsFlushTimerRef.current) clearTimeout(localTtsFlushTimerRef.current);
          // Check for sentence-ending punctuation
          const sentenceEnd = /[.!?؟。]\s*$/;
          if (sentenceEnd.test(localTtsBufferRef.current.trim())) {
            flushLocalTtsBuffer(localLang, localRole);
          } else {
            // Flush after a short pause (no more fragments arriving)
            localTtsFlushTimerRef.current = setTimeout(() => {
              flushLocalTtsBuffer(localLang, localRole);
            }, 600);
          }
          break;
        }

        case "emote":
          setEmote(msg.data as "happy" | "sad" | "neutral");
          break;

        case "thinking":
          // Speaker emitted a private_note — pop the question-mark
          // animation. Counter restart guarantees the animation
          // retriggers even if the same cue lands twice in a row.
          // The server always sends `active: true` (one-shot pulse);
          // the client owns dismissal via its own timer.
          if (msg.active) setThinkingPulse((n) => n + 1);
          break;

        case "processing":
          // Backend-busy envelope: an agent started/finished work the child
          // is waiting on. Update just that flag; the UI shows a subtle
          // ambient cue per activity.
          if (msg.activity === "speaker" || msg.activity === "board" || msg.activity === "interpret") {
            setProcessing((prev) =>
              prev[msg.activity as keyof ProcessingState] === !!msg.active
                ? prev
                : { ...prev, [msg.activity]: !!msg.active },
            );
          }
          break;

        case "interaction_mode_changed":
          // AI changed its own behavioral mode (companion / facilitator /
          // standby). This NEVER affects the user-controlled muteState —
          // only the cave tap can mute or unmute. Just flash the indicator.
          // Accept legacy "interact" / "assist" labels in case an older
          // server build is connected; map them to the new canonical names
          // so downstream consumers (AvatarSpriteContext etc.) only see
          // the new pair.
          {
            const raw = msg.data.mode;
            const mode: "companion" | "facilitator" | "standby" | null =
              raw === "companion" || raw === "interact" ? "companion"
              : raw === "facilitator" || raw === "assist" ? "facilitator"
              : raw === "standby" ? "standby"
              : null;
            if (mode) {
              setLastModeChange({ mode, reason: msg.data.reason, source: "ai", at: Date.now() });
            }
          }
          break;

        case "sleep_state_change":
          // AI invoked sleep() or end_session() — route to the engagement state machine.
          if (msg.data?.state) {
            onSleepStateChangeRef.current?.(msg.data.state, msg.data.source ?? "ai");
          }
          break;

        case "set_fidelity":
          // Server drove perception fidelity (cost-saving). Route to the camera
          // context so the data-flow gate (Phase 2) and avatar follow.
          if (msg.data?.level) {
            onSetFidelityRef.current?.(msg.data.level, msg.data.reason);
          }
          break;

        case "budget_update":
          // AAC token-budget level for the in-client energy bar.
          if (typeof msg.data?.percent === "number") {
            setBudget({ percent: msg.data.percent, band: msg.data.band, window: msg.data.window ?? null });
          }
          break;

        case "request_audio_clip":
          // Phase 1b: Observer wants to re-hear a recent speech clip. The caller
          // looks it up in its audio ring buffer and replies via sendAudioClip.
          if (msg.data?.clipId) {
            onRequestAudioClipRef.current?.(msg.data.clipId);
          }
          break;

        case "false_wake_report":
          // AI invoked report_false_wake() — bump wake threshold dampening.
          if (typeof msg.data?.reason === "string") {
            onFalseWakeReportRef.current?.(msg.data.reason);
          }
          break;

        case "alarm": {
          // Observer raised a caretaker alarm. A new alarm always replaces
          // any current one (an alert escalating to an emergency just
          // swaps the level). <AlarmOverlay> drives the sound + cancel UI.
          const level = msg.data?.level === "emergency" ? "emergency" : "alert";
          const reason = typeof msg.data?.reason === "string" ? msg.data.reason : "";
          setActiveAlarm({ level, reason });
          break;
        }

        case "video_play":
          setActiveApp({ appId: "youtube", appData: msg.data });
          break;

        case "binary_choice": {
          const opts = Array.isArray(msg.data?.options) ? msg.data.options : [];
          const escapeKind = (msg.data as any)?.escapeKind as "maybe" | "neither" | undefined;
          const inputGlyphs = (msg.data as any)?.inputGlyphs as Array<{ glyph: string; fallback?: string }> | undefined;
          if (opts.length >= 2) {
            setBinaryChoiceOptions(opts.slice(0, 2));
            setBinaryChoiceEscapeKind(escapeKind ?? null);
            setBinaryChoiceInputGlyphs(inputGlyphs?.length ? inputGlyphs : null);
          }
          break;
        }

        case "ask_binary_choice": {
          // Deferred binary-choice — show overlay after TTS playback completes
          const opts = Array.isArray(msg.data?.options) ? msg.data.options : [];
          const escapeKind = (msg.data as any)?.escapeKind as "maybe" | "neither" | undefined;
          const inputGlyphs = (msg.data as any)?.inputGlyphs as Array<{ glyph: string; fallback?: string }> | undefined;
          if (opts.length >= 2) {
            pendingAskBinaryChoiceRef.current = opts.slice(0, 2);
            pendingAskBinaryChoiceEscapeKindRef.current = escapeKind ?? null;
            pendingAskBinaryChoiceInputGlyphsRef.current = inputGlyphs?.length ? inputGlyphs : null;
          }
          break;
        }

        case "focus_request":
          // AI requested a high-resolution focus frame
          if (msg.data?.reason && captureHighResFrameRef.current) {
            console.log("[LiveSession] Focus frame requested:", msg.data.reason);
            // Show glasses overlay briefly
            setFocusActive(true);
            if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
            focusTimerRef.current = setTimeout(() => setFocusActive(false), 1500);
            captureHighResFrameRef.current().then((blob) => {
              if (!blob || blob.size === 0) return;
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64 = (reader.result as string).split(",")[1];
                wsSend({ type: "focus_frame", data: base64 });
                setSnapshotTick(t => t + 1); // blink on the manual focus snapshot
                console.log("[LiveSession] Focus frame sent:", blob.size, "bytes");
              };
              reader.readAsDataURL(blob);
            }).catch(err => console.warn("[LiveSession] Focus frame capture failed:", err));
          }
          break;

        case "app_open":
          // Clear any pending request_app_open round-trip + its backstop.
          if (appOpenBackstopRef.current) {
            clearTimeout(appOpenBackstopRef.current);
            appOpenBackstopRef.current = null;
          }
          setAppOpenPending(null);
          setActiveApp(msg.data);
          break;

        case "app_close":
          setActiveApp(null);
          break;

        case "call_directive":
          // AI asked to start a video call to a contact. Surface the latest
          // directive; the CallProvider dials it (and dedupes via `at`).
          if (msg.action === "start" && typeof msg.contactId === "string") {
            setCallDirective({
              action: "start",
              contactId: msg.contactId,
              contactName: typeof msg.contactName === "string" ? msg.contactName : undefined,
              at: Date.now(),
            });
          }
          break;

        case "conversation_roster":
          // Group-chat peers for the header face row (name + stored photo).
          setConversationRoster(Array.isArray(msg.peers) ? msg.peers : []);
          break;

        case "floor_state":
          // Group-chat turn cue for the header highlight.
          setFloorState({ holder: msg.holder ?? null, awaiting: msg.awaiting ?? null });
          break;

        case "social_session":
          // Server-owned social-training session lifecycle. "started"
          // carries the peer's face data; "ended" tears the face down
          // (the paired app_close clears activeApp).
          if (msg.data?.state === "started") {
            setSocialSession({
              characterName: msg.data.characterName,
              voiceName: msg.data.voiceName,
              appearance: msg.data.appearance,
              expressiveness: msg.data.expressiveness,
              legibility: msg.data.legibility,
              voicePitch: msg.data.voicePitch,
              voiceFormant: msg.data.voiceFormant,
            });
            // The preview persona was just consumed by the session — the button
            // now shows the live (session) face + X, not the idle preview.
            setSocialPeerPreview(null);
          } else {
            setSocialSession(null);
            setSocialPeerState(null);
            setSocialPeerDebug(null);
            setPeerVoicePitchOverride(null);
            setPeerVoiceFormantOverride(null);
            // Clear the preview so the button shows nothing until the server
            // sends a fresh face after the post-session beat.
            setSocialPeerPreview(null);
          }
          break;

        case "social_peer_preview":
          // Idle "Practice friend" face for the home button.
          setSocialPeerPreview(msg.data ?? null);
          break;

        case "social_peer_state":
          // Director state after each peer turn — the face lerps toward it.
          setSocialPeerState(msg.data ?? null);
          break;

        case "social_peer_debug":
          // DEBUG-only: full engine internals + editable params for the dialog.
          setSocialPeerDebug(msg.data ?? null);
          break;

        case "debug":
          setDebugData(prev => ({ ...prev, ...msg.data }));
          break;

        case "monitor_status":
          if (msg.data?.error) {
            setMonitorError(msg.data.error);
            setMonitorConsecutiveFailures(msg.data.consecutiveFailures || 0);
          } else {
            setMonitorError(null);
            setMonitorConsecutiveFailures(0);
          }
          break;

        case "reconnecting":
          // A deliberate resting↔awake profile switch bounces the server↔model
          // connection for ~1.5s. It's benign, so don't enter the "unhealthy"
          // state that paints the error/hurt avatar face — the WS to us is
          // still up and the avatar should stay as-is.
          if (msg.data === "profile_switch") {
            setError(null);
            break;
          }
          setReconnecting(true);
          setError(null);
          // Any in-flight backend work is interrupted by the reconnect — drop
          // the ambient processing cues so they don't stick (the server can't
          // send a clearing `processing:false` across a dropped connection).
          setProcessing({ speaker: false, board: false, interpret: false });
          break;

        case "reconnected":
          setReconnecting(false);
          setSafetyBlocked(false);
          setError(null);
          break;

        case "safety_blocked":
          setSafetyBlocked(true);
          setTimeout(() => setSafetyBlocked(false), 5000);
          break;

        case "session_reset":
          setSessionId(msg.sessionId);
          setReconnecting(false);
          setError(null);
          setProcessing({ speaker: false, board: false, interpret: false });
          break;

        case "error":
          setError(msg.data);
          setIsLoading(false);
          setProcessing({ speaker: false, board: false, interpret: false });
          break;

        case "rate_limited":
          rateLimitedRef.current = true;
          setReconnecting(false);
          setError(msg.data || "error:RATE_LIMITED");
          setIsLoading(false);
          break;

        case "session_snapshot":
          // Save session snapshot to local IndexedDB for persistence across sessions
          localStorageConfigRef.current = msg.config;
          if (msg.config?.localStorageEnabled) {
            saveSessionSnapshot(msg.snapshot, msg.config).catch(err =>
              console.warn("[useLiveSession] Failed to save local snapshot:", err)
            );
          }
          // Refresh the apps lists that the Apps board overlay reads from.
          // Snapshot is the single source of truth — server may add/remove
          // custom apps mid-session, and snapshots arrive after relevant changes.
          setEnabledApps(msg.snapshot?.enabledApps ?? []);
          setAvailableCustomApps(msg.snapshot?.availableCustomApps ?? []);
          setPermittedWebsites(msg.snapshot?.permittedWebsites ?? []);
          break;

        case "guessing_mode":
          // Server-driven flag — the engine state lives on the server now
          // (see agent-coordinator's intent handlers). All this hook does
          // is flip a boolean so UI surfaces (quick-button highlight,
          // sentence-builder Find-word highlight) reflect the current mode.
          setGuessingMode(msg.active ?? false);
          break;

        case "construction_suggestions": {
          const data = msg.data;
          if (data) {
            // Normalize both the new shape (headCandidates +
            // modifierCandidates) and the legacy shape (just candidates).
            // Older server builds only emit `candidates`; new builds emit
            // all three, with `candidates` carrying the heads for compat.
            const headCandidates = Array.isArray(data.headCandidates)
              ? data.headCandidates
              : Array.isArray(data.candidates)
              ? data.candidates
              : [];
            const modifierCandidates = Array.isArray(data.modifierCandidates)
              ? data.modifierCandidates
              : [];
            // Register any pre-resolved symbol paths so the compositor
            // (used for the GLYPH display itself, not just the AI strips)
            // can render AI-generated payloads too. Walk BOTH arrays so a
            // generated modifier symbol gets cached the same as a head.
            for (const c of headCandidates) {
              if (c.symbolPath && typeof c.key === "string") {
                registerSymbolPath(c.key, c.symbolPath);
              }
            }
            for (const c of modifierCandidates) {
              if (c.symbolPath && typeof c.key === "string") {
                registerSymbolPath(c.key, c.symbolPath);
              }
            }
            setConstructionSuggestions({
              targetSlot: typeof data.targetSlot === "number" ? data.targetSlot : 0,
              headCandidates,
              modifierCandidates,
              candidates: headCandidates,
              receivedAt: Date.now(),
            });
          }
          break;
        }

        case "construction_symbol_ready": {
          // A queued auto-symbol finished generating. Patch any AI-strip
          // SUGGESTION whose `key` matches the imageKey so the freshly
          // generated image swaps in without a re-suggest round-trip.
          // Heads and modifiers share the same generation pipeline, so
          // walk both arrays.
          const data = msg.data;
          if (data && typeof data.imageKey === "string" && typeof data.symbolPath === "string") {
            registerSymbolPath(data.imageKey, data.symbolPath);
            setConstructionSuggestions((prev) => {
              if (!prev) return prev;
              let changed = false;
              const patch = (arr: typeof prev.headCandidates) =>
                arr.map((c) => {
                  if (c.key === data.imageKey && c.symbolPath !== data.symbolPath) {
                    changed = true;
                    return { ...c, symbolPath: data.symbolPath };
                  }
                  return c;
                });
              const headCandidates = patch(prev.headCandidates);
              const modifierCandidates = patch(prev.modifierCandidates);
              return changed
                ? {
                    ...prev,
                    headCandidates,
                    modifierCandidates,
                    candidates: headCandidates,
                    receivedAt: Date.now(),
                  }
                : prev;
            });
          }
          break;
        }

        case "construction_memory_chips": {
          const data = msg.data;
          if (data && typeof data.category === "string" && Array.isArray(data.chips)) {
            setConstructionMemoryChips((prev) => ({
              ...prev,
              [data.category]: {
                category: data.category,
                chips: data.chips,
                receivedAt: Date.now(),
              },
            }));
          }
          break;
        }

        case "people_identified":
          setIdentifiedFaces(msg.data || []);
          break;

        case "voices_identified":
          setIdentifiedVoices(msg.data || []);
          break;

        case "complete":
          // Turn complete — keep text visible. Mark that the next "text" message
          // should start a fresh accumulation instead of appending.
          textAccumRef.current = ""; // Reset accumulator but don't clear display
          // Fallback: if a deferred ask_binary_choice is pending but no TTS
          // is playing (e.g. silent mode), show the overlay immediately.
          if (pendingAskBinaryChoiceRef.current && !audioPlayer.isPlaying) {
            const opts = pendingAskBinaryChoiceRef.current;
            const kind = pendingAskBinaryChoiceEscapeKindRef.current;
            const glyphs = pendingAskBinaryChoiceInputGlyphsRef.current;
            pendingAskBinaryChoiceRef.current = null;
            pendingAskBinaryChoiceEscapeKindRef.current = null;
            pendingAskBinaryChoiceInputGlyphsRef.current = null;
            setBinaryChoiceOptions(opts);
            setBinaryChoiceEscapeKind(kind);
            setBinaryChoiceInputGlyphs(glyphs);
          }
          break;
      }
    } catch (err) {
      console.error("[useLiveSession] Failed to parse server message:", err);
    }
  }, [audioEnabled, audioPlayer]);

  // Header audio-output mute: silence LOCAL speakers only, via the player's master
  // gain — the audio is still produced and still flows to the call tap, so a
  // locally-muted AAC keeps transmitting its voice (the whole point of the mute is
  // to test the call without the local audio leaking). Also cancel the browser's
  // speechSynthesis (the immediate local button speech, which can't be transmitted
  // and is gated separately in DynamicBoard).
  useEffect(() => {
    audioPlayer.setLocalMuted(!audioEnabled);
    if (!audioEnabled && typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  }, [audioEnabled, audioPlayer]);

  // -------------------------------------------------------------------------
  // Periodic GPS refresh — re-query location on the monitor cadence and push a
  // gps_update only when the device has moved meaningfully (saves bandwidth and
  // avoids spamming the AI with identical-location injections).
  // -------------------------------------------------------------------------

  const stopGpsWatch = useCallback(() => {
    if (gpsTimerRef.current) {
      clearInterval(gpsTimerRef.current);
      gpsTimerRef.current = null;
    }
  }, []);

  const startGpsWatch = useCallback(() => {
    stopGpsWatch();
    const GPS_REFRESH_MS = 120_000;       // ~ monitor cadence
    const GPS_MOVE_THRESHOLD_M = 40;      // ignore sub-40m jitter
    gpsTimerRef.current = setInterval(async () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      const gps = await getCurrentGps();
      if (!gps) return;
      const last = lastGpsSentRef.current;
      if (last && metersBetween(last, gps) < GPS_MOVE_THRESHOLD_M) return;
      lastGpsSentRef.current = gps;
      wsSend({ type: "gps_update", gps });
    }, GPS_REFRESH_MS);
  }, [wsSend, stopGpsWatch]);

  // -------------------------------------------------------------------------
  // Initialize — open WebSocket and send initialize message
  // -------------------------------------------------------------------------

  const initialize = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("[useLiveSession] Already connected");
      return;
    }

    setIsLoading(true);
    setStartupStage("connecting"); // reset the waking-up subtitle for this attempt
    setError(null);
    rateLimitedRef.current = false; // Reset on manual/retry initialization

    try {
      // Capture an initial camera frame (non-blocking, best-effort)
      let initialFrameBase64: string | undefined;
      const capture = captureFrameRef.current;
      if (capture) {
        try {
          const blob = await capture();
          if (blob && blob.size > 0) {
            initialFrameBase64 = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve((reader.result as string).split(",")[1]);
              reader.readAsDataURL(blob);
            });
            console.log("[useLiveSession] Captured initial frame for init,", blob.size, "bytes");
          }
        } catch (err) {
          console.warn("[useLiveSession] Initial frame capture failed:", err);
        }
      }

      // Build WebSocket URL from the resolved API base (same base as HTTP requests).
      // In dev: "http://localhost:5000" → "ws://localhost:5000/ws/live"
      // Electron: demo backend → "wss://aivota-demo-us.onrender.com/ws/live"
      // Web (staging/demo/prod): "" → same origin as page
      const apiBase = API_BASE_URL;
      // Append ?test=1 if the page URL has ?test=1 — routes to the MinimalLiveRelay
      // on the server, bypassing tools, system prompt, and state machine.
      const isTestMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("test") === "1";
      const queryString = isTestMode ? "?test=1" : "";
      let wsUrl: string;
      if (apiBase) {
        // Replace http(s) with ws(s)
        wsUrl = apiBase.replace(/^http/, "ws") + "/ws/live" + queryString;
      } else {
        // Same origin
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${protocol}//${window.location.host}/ws/live${queryString}`;
      }
      if (isTestMode) console.log("[useLiveSession] TEST MODE — using minimal relay");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[useLiveSession] WebSocket connected");
        // Send initialize message (include userId for session/memory access)
        // useAuth().user is the full API response: { success, user: { id, ... } }
        // Read from ref in case auth loaded after callback was created
        const sendInit = async () => {
          // Send cached local state first (if any) for session rebuild
          try {
            const encryptionKey = localStorageConfigRef.current?.encryptionKey ?? null;
            const cachedSnapshot = await loadLatestSnapshot(studentId, encryptionKey);
            if (cachedSnapshot) {
              wsSend({ type: "local_state", snapshot: cachedSnapshot });
              console.log("[useLiveSession] Sent cached local state for session:", cachedSnapshot.sessionId);
            }
          } catch (err) {
            console.warn("[useLiveSession] Failed to load local state:", err);
          }

          // Best-effort device location (null if unsupported/denied/timeout).
          const gps = await getCurrentGps();
          if (gps) lastGpsSentRef.current = gps;

          wsSend({
            type: "initialize",
            studentId,
            userId: userRef.current?.user?.id,
            muteState,
            responseMode,
            debugMode,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            capabilities: CLIENT_CAPABILITIES,
            ...(classroomId ? { classroomId } : {}),
            ...(initialFrameBase64 ? { initialFrame: initialFrameBase64 } : {}),
            ...(gps ? { gps } : {}),
          });

          // Start periodic location refresh (movement / accuracy improvement).
          startGpsWatch();
        };

        // If auth already loaded, send immediately
        if (!authLoadingRef.current) {
          sendInit();
          return;
        }

        // Auth still loading — poll until resolved (max 5s)
        console.log("[useLiveSession] Waiting for auth to resolve before sending initialize...");
        let attempts = 0;
        const pollTimer = setInterval(() => {
          attempts++;
          if (!authLoadingRef.current || attempts >= 50) {
            clearInterval(pollTimer);
            if (authLoadingRef.current) {
              console.warn("[useLiveSession] Auth did not resolve after 5s — sending initialize without userId");
            }
            sendInit();
          }
        }, 100);
      };

      ws.onmessage = handleServerMessage;

      ws.onclose = (event) => {
        const wasIntentional = closingIntentionallyRef.current;
        closingIntentionallyRef.current = false;
        console.log(
          `[useLiveSession] WebSocket closed: code=${event.code} reason=${event.reason} intentional=${wasIntentional} isInitialized=${isInitializedRef.current}`,
        );
        wsRef.current = null;
        // Stop the GPS refresh timer; a reconnect's initialize() restarts it.
        stopGpsWatch();
        // Always clear the "waking up" spinner on disconnect — initialize() will
        // re-set it if we auto-reconnect, but we never want to leave the UI
        // stuck on "waking up" with no live session behind it.
        setIsLoading(false);
        if (wasIntentional) {
          // clearSession / unmount — do NOT auto-reconnect
          return;
        }
        if (rateLimitedRef.current) {
          // Rate limited — do NOT auto-reconnect, user must retry manually
          console.warn("[useLiveSession] Rate limited — skipping auto-reconnect");
          return;
        }
        // Read isInitialized from a ref — the closure value is captured at
        // initialize() call time (when it was still false), so checking the
        // closure variable would never reconnect after a successful init.
        if (isInitializedRef.current) {
          // Auto-reconnect after unexpected close
          reconnectTimerRef.current = setTimeout(() => {
            console.log("[useLiveSession] Attempting reconnect...");
            initialize();
          }, 3000);
        } else {
          console.warn("[useLiveSession] WS closed before initialized — not auto-reconnecting");
        }
      };

      ws.onerror = (event) => {
        console.error("[useLiveSession] WebSocket error:", event);
        setError("error:CONNECTION_ERROR");
        setIsLoading(false);
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError("error:CONNECTION_ERROR");
      setIsLoading(false);
    }
  }, [studentId, muteState, responseMode, debugMode, isInitialized, wsSend, handleServerMessage, startGpsWatch, stopGpsWatch]);

  // -------------------------------------------------------------------------
  // Actions — send messages over WebSocket
  // -------------------------------------------------------------------------

  const sendMessage = useCallback(async (message: string, board?: ParsedBoardData) => {
    // Stop any playing audio — user action takes priority
    audioPlayer.clear();
    if (board) {
      wsSend({ type: "board_state", data: board });
    }
    wsSend({ type: "user_message", text: message });
    // Don't display system messages ("[system: ...]") in the text UI —
    // these are context signals to the AI, not user-facing content.
    if (!message.startsWith("[system:")) {
      setCurrentMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
    }
  }, [wsSend]);

  /** Inject context into the AI without triggering a response turn */
  const sendContextOnly = useCallback((text: string) => {
    wsSend({ type: "context_injection", text });
  }, [wsSend]);

  /** DEBUG-only: force the server-side budget to `percent` so the throttle
   *  ladder (avatar eyes, energy bar, forced-HTTP Observer, tired Speaker, sleep
   *  timer, board-only, all-stop) can be exercised live. Server self-guards on
   *  debugMode. */
  const debugSetBudget = useCallback((percent: number) => {
    wsSend({ type: "debug_set_budget", percent });
  }, [wsSend]);

  // Diagnostics: tell the server when the mic activates/deactivates. The server
  // only logs this to the session history (never injects it into a live agent),
  // so it's safe to call on every transition. No-ops if the socket isn't open.
  const sendMicState = useCallback((active: boolean, reason?: string) => {
    wsSend({ type: "mic_state", active, reason });
  }, [wsSend]);

  // Diagnostics (like mic_state): report which speech-boundary detector is
  // driving the client. A session where the Silero VAD failed to load — and
  // boundaries silently fell back to energy thresholds that merge statements
  // in a noisy room — is otherwise invisible outside the browser console.
  const sendSpeechMethod = useCallback((method: "silero" | "webSpeechApi" | "energy" | "none") => {
    wsSend({ type: "speech_method", method });
  }, [wsSend]);

  /** Tell the server a live video call started/ended (drives facilitator mode). */
  const sendCallActive = useCallback((active: boolean, outcome?: string) => {
    wsSend({ type: "call_active", active, ...(outcome ? { outcome } : {}) });
  }, [wsSend]);

  /** Tell the server the student entered/left a group AAC chat (shape C). Pass
   *  the call/chat roomId on join, or null on leave. Drives peer-utterance flow. */
  const sendConversationRoom = useCallback((roomId: string | null) => {
    wsSend({ type: "conversation_room", roomId });
  }, [wsSend]);

  /** Tell the server the student focused a peer's face in the group chat (pass
   *  the peer's personId), or cleared it (null). Focuses that peer as the
   *  addressee and asks the BoardManager to build phrases for them. */
  const sendConversationFocus = useCallback((personId: string | null) => {
    wsSend({ type: "conversation_focus", personId });
  }, [wsSend]);

  /** Push construction-board state to the AI; relay formats as context injection. */
  const sendConstructionState = useCallback(
    (state: import("./dual-agent-types").ConstructionStateClient) => {
      console.log("[construction] sendConstructionState fired", {
        category: state.category,
        modeChip: state.modeChip,
        glyph: state.glyph,
        targetSlot: state.targetSlot,
        excludeKeys: state.excludeKeys.length,
        requestGuessingMode: state.requestGuessingMode,
        wsReady: wsRef.current?.readyState,
      });
      wsSend({ type: "construction_state", data: state });
    },
    [wsSend]
  );

  const sendBoardExit = useCallback((label: string, instruction: string) => {
    wsSend({ type: "board_exit", label, instruction });
  }, [wsSend]);

  const sendVoice = useCallback(async (board?: ParsedBoardData) => {
    const audioBlob = await audioRecorder.stopRecording();
    if (!audioBlob) return;

    if (board) {
      wsSend({ type: "board_state", data: board });
    }

    // Convert blob to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(",")[1];
      wsSend({ type: "voice_audio", data: base64, mimeType: audioBlob.type });
    };
    reader.readAsDataURL(audioBlob);
  }, [wsSend, audioRecorder]);

  const voiceButtons = useCallback(async (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => {
    // Drop any pending student-voice TTS chunks from a previous button press.
    // Without this, if the user taps a second button before the first
    // button's utterance_audio chunks finish playing, the queued tail
    // of the previous TTS plays before (or instead of) the new button — the
    // user hears the wrong sentence for the button they just pressed.
    // Only clears the "utterance" tag; the AI's "avatar" audio is left alone.
    audioPlayer.clearByTag("utterance");
    wsSend({ type: "button_press", buttons: recentButtons, sentences, board });
  }, [wsSend, audioPlayer]);

  /** Tell the server the sentence builder opened/closed (conversation detour boundary). */
  const setBuilderVisible = useCallback((open: boolean) => {
    wsSend({ type: open ? "builder_open" : "builder_close" });
  }, [wsSend]);

  // ── Social trainer ───────────────────────────────────────────────────────
  //
  // The session is server-owned (the peer persona replaces the Speaker
  // agent in the coordinator). This notifier asks the server to start a
  // session for client-initiated launches; AI-initiated launches arrive
  // as app_open("social_trainer") and need no client action.

  const notifySocialTrainerStarted = useCallback(() => {
    wsSend({ type: "social_trainer_started" });
  }, [wsSend]);

  /**
   * Handle a guessing-mode SUGGESTION button press. Server-side engine —
   * we send an INTENT (`guessing_press` or `guessing_reject`), the server
   * runs applyPress / rejectCurrentDimension on its authoritative state,
   * and rebroadcasts the rendered injection to the agents.
   *
   * Deliberately does NOT go through voiceButtons — a suggestion press
   * is a narrowing signal, not an utterance.
   */
  const pressSuggestion = useCallback((suggestionKey: string) => {
    console.debug("[guessing] pressSuggestion", suggestionKey);
    if (suggestionKey === GUESSING_REJECT) {
      // "No" / "none of these" — see server handleGuessingReject for the
      // full rationale (it drops the current dimension without producing
      // a contradictory "rejected fact" that would conflict with prior
      // positive presses).
      wsSend({ type: "guessing_reject" });
    } else {
      wsSend({ type: "guessing_press", suggestionKey });
    }
  }, [wsSend]);

  /**
   * Press handler for AI-driven narrowing buttons (`buttonType: "narrow"`).
   * Sends a `guessing_narrow` intent; the server records the user's
   * confirmation as a CustomNarrowingFact and re-broadcasts so the AI
   * sees the new fact in its next [GUESSING STATE] injection.
   * `sourceText` is the button's voiced speech — gives the AI back its
   * own framing of what was asked.
   */
  const pressNarrow = useCallback((dimension: string, value: string, sourceText?: string) => {
    console.debug("[guessing] pressNarrow", { dimension, value, sourceText });
    wsSend({ type: "guessing_narrow", dimension, value, sourceText });
  }, [wsSend]);

  /**
   * Unified word-finder entry point. Sends a `guessing_enter` intent;
   * the server initializes its engine state, applies the builder
   * category pre-selection (if launched from the builder), and
   * broadcasts `guessing_mode: true` back so this hook flips the UI flag.
   *
   * - From the BUILDER: pass a builderContext. The server pre-selects
   *   the top-level category from the builder's active tab so the user
   *   skips the "what kind of thing?" step.
   * - From CONVERSATION: omit builderContext. The user starts at the
   *   top-level category step.
   */
  const enterGuessing = useCallback((builderContext?: GuessingBuilderContext) => {
    console.debug("[guessing] enterGuessing", { from: builderContext ? "builder" : "conversation" });
    wsSend({ type: "guessing_enter", ...(builderContext ? { builderContext } : {}) });
  }, [wsSend]);

  /** Legacy alias — same as enterGuessing(builderContext). Retained because
   *  SentenceConstructorBoard's `onEnterGuessing` prop is wired to this
   *  name. New code should call enterGuessing directly. */
  const enterGuessingFromBuilder = useCallback((builderContext: GuessingBuilderContext) => {
    enterGuessing(builderContext);
  }, [enterGuessing]);

  /** User-initiated Word Finder cancel. Single exit path for every surface
   *  (quick-button toggle, sentence-builder toggle, back press while
   *  guessing). The server `clearGuessingState` sets `guessingState=null`
   *  and broadcasts `guessing_mode:false`; the local ref is wiped by the
   *  `guessing_mode` message handler — so we don't have to nuke it here. */
  const exitGuessing = useCallback((reason?: string) => {
    console.debug("[guessing] exitGuessing", { reason });
    wsSend({ type: "exit_guessing", reason });
  }, [wsSend]);

  /**
   * Send a composed glyph from the sentence builder up to the AI for
   * interpretation. The AI is responsible for converting the glyph to a
   * natural-language sentence via the `interpret` tool — the relay does
   * NOT TTS the glyph string itself. See the [GLYPH PRESS] flow in
   * live-relay.ts.
   */
  const playGlyph = useCallback((glyphString: string) => {
    audioPlayer.clearByTag("utterance");
    wsSend({ type: "glyph_press", glyph: glyphString });
  }, [wsSend, audioPlayer]);

  /**
   * Activity-driven detection: send composite grid + optional audio clip.
   * Fire-and-forget — no waiting for response (WebSocket is non-blocking).
   */
  const runDetectionWithGrid = useCallback(async (
    grid: ComposedGrid | null,
    audioClip: Blob | null,
    unknownFaceDescriptors?: UnknownFaceDescriptor[],
    triggerReason?: string,
  ) => {
    if (!grid) return;

    // Send unknown face descriptors if present. Sent on EVERY update (incl.
    // text-only scene updates below) — they're small embeddings, and the server
    // needs them to keep [PEOPLE PRESENT] current even when we send no image.
    if (unknownFaceDescriptors?.length) {
      wsSend({ type: "unknown_face_descriptors", data: unknownFaceDescriptors });
    }

    // Cost saving (Phase 2): while the scene is stable, send a compact
    // scene_state TEXT line instead of the JPEG frame; only escalate to a real
    // frame on a material change (new/lost person, new gesture, safety). The
    // escalation reason becomes the frame's triggerReason for the Observer.
    let effectiveTriggerReason = triggerReason;
    // The [MOTION SIGNATURE] line travels with a "seizure"-escalated frame so the
    // Observer sees the quantified motion evidence, not just the picture.
    let motionSignature: string | undefined;
    const snap = optionsRef.current.getSceneSnapshot?.() ?? null;

    // A seizure-class motion pattern ALWAYS escalates a real frame carrying its
    // [MOTION SIGNATURE], independent of economize / scene-state / full-attention
    // mode — it is safety-critical and must reach the Observer. (Previously this
    // lived inside the scene-state branch, so full-attention sessions silently
    // dropped it.)
    if (snap?.seizure) {
      effectiveTriggerReason = "seizure";
      motionSignature = snap.seizure.summary;
      // Audio corroboration (Phase 2b): only ANNOTATES an already-escalating
      // motion event — never escalates alone (getVocalCue self-gates on the flag).
      if (optionsRef.current.getVocalCue?.()) {
        motionSignature += " | [AUDIO] concurrent sustained vocalization/sound heard — corroborates the motion (does NOT confirm; vocalizing and irregular breathing are common here).";
      }
    }

    // Cost saving (Phase 2): while the scene is stable, send a compact scene_state
    // TEXT line instead of the JPEG frame; only escalate on a material change
    // (new/lost person, new gesture, safety). A seizure overrides this entirely.
    if (sceneStateActiveRef.current && snap) {
      const decision = classifyScene(
        lastSceneSignatureRef.current,
        snap,
        triggerReason,
        lastPersonCountRef.current,
        lastPostureRef.current,
      );
      lastSceneSignatureRef.current = sceneSignature(snap);
      lastPersonCountRef.current = snap.people.length;
      lastPostureRef.current = snap.posture ?? null;
      if (!snap.seizure) {
        if (decision.mode === "text") {
          // Send the STRUCTURED snapshot — the server renders [SCENE] with the
          // real identities (it holds the face-api matches; the tracker doesn't).
          wsSend({ type: "scene_state", scene: snap });
          return; // stable scene — skip the JPEG frame (and its audio clip)
        }
        effectiveTriggerReason = decision.reason;
      }
    }

    // Capture and send app canvas (e.g. drawing) if an app is active
    if (activeApp?.appId === "drawing" && captureAppCanvasRef.current) {
      try {
        const canvasBlob = await captureAppCanvasRef.current();
        if (canvasBlob && canvasBlob.size > 0) {
          const canvasReader = new FileReader();
          canvasReader.onloadend = () => {
            const base64 = (canvasReader.result as string).split(",")[1];
            wsSend({ type: "app_canvas", data: base64 });
          };
          canvasReader.readAsDataURL(canvasBlob);
        }
      } catch {
        // Ignore canvas capture failures
      }
    }

    // Convert grid JPEG to base64
    const gestureContext = optionsRef.current.getGestureContext?.() || undefined;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(",")[1];
      wsSend({
        type: "frame_grid",
        data: base64,
        timestamps: grid.timestamps,
        ...(gestureContext ? { gestureContext } : {}),
        ...(effectiveTriggerReason ? { triggerReason: effectiveTriggerReason } : {}),
        ...(motionSignature ? { motionSignature } : {}),
      });
      setSnapshotTick(t => t + 1); // blink the avatar on each real snapshot
    };
    reader.readAsDataURL(grid.blob);

    // Send audio clip if present
    if (audioClip) {
      const audioReader = new FileReader();
      audioReader.onloadend = () => {
        const base64 = (audioReader.result as string).split(",")[1];
        wsSend({
          type: "audio_clip",
          data: base64,
          mimeType: audioClip.type,
        });
      };
      audioReader.readAsDataURL(audioClip);
    }
  }, [wsSend, activeApp]);

  /**
   * Send a raw PCM audio chunk (base64 Int16 16kHz) directly to the server
   * for relay to Gemini Live API. Called continuously by the AudioRingBuffer.
   */
  const sendPcmAudio = useCallback((int16Base64: string) => {
    wsSend({ type: "pcm_audio", data: int16Base64 });
  }, [wsSend]);

  /**
   * Send already-computed unknown face descriptors to the server out-of-band
   * (i.e. not riding along a frame_grid). Used at session start: identification
   * runs during the slow init window, so the moment the session connects we
   * push the descriptors and the server can match them BEFORE the first frame
   * arrives — the startup scene description then already has [PEOPLE PRESENT].
   */
  const sendFaceDescriptors = useCallback((descriptors: UnknownFaceDescriptor[]) => {
    if (!descriptors?.length) return;
    wsSend({ type: "unknown_face_descriptors", data: descriptors });
  }, [wsSend]);

  /**
   * Send speaker embeddings computed from heard speech up to the server for
   * voice matching (mirror of sendFaceDescriptors). The client computes the
   * vector; the server is authoritative for who it belongs to.
   */
  const sendVoiceDescriptors = useCallback((descriptors: Array<{ embedding: number[]; quality?: number }>, clipId?: string) => {
    if (!descriptors?.length) return;
    wsSend({ type: "voice_descriptors", data: descriptors, ...(clipId ? { clipId } : {}) });
  }, [wsSend]);

  /**
   * Cost-saving (Phase 1): send an on-device transcript of a heard speech
   * segment instead of streaming raw audio. The server feeds it to the Observer
   * as a turn-completing [HEARD SPEECH] message. Only used when sttActive.
   */
  const sendSpeechText = useCallback(
    (payload: { text: string; confidence?: number; clipId?: string; voiceDescriptor?: { embedding: number[]; quality?: number } }) => {
      const text = payload?.text?.trim();
      if (!text) return;
      wsSend({ type: "speech_text", ...payload, text });
    },
    [wsSend],
  );

  /**
   * Cost-saving (Phase 1, ACTIVE path): send a VAD speech clip (base64 WAV) to
   * the server for Google STT, in place of streaming raw audio.
   */
  const sendSpeechAudio = useCallback(
    (payload: {
      data: string;
      mimeType?: string;
      language?: string;
      clipId?: string;
      voiceDescriptor?: { embedding: number[]; quality?: number };
      lipActivity?: Array<{ bbox: { x: number; y: number; w: number; h: number }; mouthActivity: number; visible: boolean }>;
      acoustic?: { pitchHz: number | null; voiced: number; formantDispersion?: number | null };
    }) => {
      if (!payload?.data) return;
      wsSend({ type: "speech_audio", ...payload });
    },
    [wsSend],
  );

  // Streaming STT (Web-Speech-like): open a session, stream VAD-gated PCM during
  // speech, finalize at speech-end (carrying the acoustic + lip evidence).
  const sendSttStreamStart = useCallback((streamId: string, language?: string) => {
    wsSend({ type: "stt_stream_start", streamId, language });
  }, [wsSend]);
  const sendSttStreamChunk = useCallback((streamId: string, data: string) => {
    if (!data) return;
    wsSend({ type: "stt_stream_chunk", streamId, data });
  }, [wsSend]);
  const sendSttStreamEnd = useCallback((streamId: string, meta?: {
    acoustic?: { pitchHz: number | null; voiced: number; formantDispersion?: number | null };
    lipActivity?: Array<{ bbox: { x: number; y: number; w: number; h: number }; mouthActivity: number; visible: boolean }>;
  }) => {
    wsSend({ type: "stt_stream_end", streamId, ...(meta ?? {}) });
  }, [wsSend]);

  /**
   * Cost-saving (Phase 1b): reply to a request_audio_clip with a backlog clip
   * so the Observer can actually hear it. `data` is base64; the server only
   * honors it when the clipId matches the clip it pulled.
   */
  const sendAudioClip = useCallback(
    (payload: { clipId: string; data: string; mimeType?: string }) => {
      if (!payload?.clipId || !payload?.data) return;
      wsSend({ type: "audio_clip", ...payload });
    },
    [wsSend],
  );

  /**
   * Report that a recent face match was wrong. The server penalizes the stored
   * embedding that mis-fired (and evicts it if it keeps causing confusion), then
   * drops the bad identity from the active people list.
   */
  const sendIdentityCorrection = useCallback(
    (entityType: "student" | "user" | "contact", entityId: string, reason?: string) => {
      if (!entityId) return;
      wsSend({ type: "correct_identity", entityType, entityId, reason });
    },
    [wsSend],
  );

  /**
   * Capture a FRESH single frame and send it as the first frame_grid the moment
   * the session is ready, so the Observer's startup scene description uses a
   * current snapshot — not the ~10s-stale frame captured at connect time.
   *
   * Retries the capture: at session-ready the multi-camera / shared <video> is
   * often not settled yet (the shared-camera fallback only kicks in ~2.5s in),
   * so a single attempt returns nothing and the Observer's first frame would
   * otherwise wait for the activity monitor. We poll until the camera yields a
   * frame (or give up after a few seconds and let the activity monitor cover it).
   */
  const sendFreshStartupFrame = useCallback(async () => {
    const capture = captureFrameRef.current;
    if (!capture) return;
    const DEADLINE = Date.now() + 5000;
    for (let attempt = 0; Date.now() < DEADLINE; attempt++) {
      try {
        const blob = await capture();
        if (blob && blob.size > 0) {
          const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(",")[1]);
            reader.readAsDataURL(blob);
          });
          console.log(`[useLiveSession] Sending fresh startup frame (attempt ${attempt + 1}),`, blob.size, "bytes");
          wsSend({ type: "frame_grid", data: base64 });
          setSnapshotTick(t => t + 1); // blink on the startup snapshot
          return;
        }
      } catch (err) {
        console.warn("[useLiveSession] Fresh startup frame capture failed:", err);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.warn("[useLiveSession] Fresh startup frame: camera never yielded a frame in time");
  }, [wsSend]);

  // Mute setter — user-only toggle (cave click). Notify server so the live
  // session can rebuild its system prompt for the new mode.
  const setMuteState = useCallback((state: "unmuted" | "muted") => {
    setMuteStateImpl(state);
    wsSend({ type: "set_mute_state", muteState: state });
  }, [wsSend]);

  // Response mode setter — also notify server
  const setResponseMode = useCallback((mode: "fast" | "analyze") => {
    setResponseModeState(mode);
    wsSend({ type: "set_response_mode", mode });
  }, [wsSend]);

  // Pause setter — also notify server
  const setPaused = useCallback((p: boolean) => {
    setPausedState(p);
    wsSend({ type: "set_paused", paused: p });
    if (p) {
      // Stop any playing audio when pausing
      audioPlayer.clear();
    }
  }, [wsSend, audioPlayer]);

  const dismissApp = useCallback(() => {
    const closedApp = activeApp;
    setActiveApp(null);
    // Notify server so Gemini knows the app was closed
    if (closedApp) {
      wsSend({ type: "app_dismissed", appId: closedApp.appId });
    }
  }, [activeApp, wsSend]);

  /**
   * Notify the server when the engagement state machine transitions sleep state.
   * Server logs this to activity_logs so the Insurance Bridge module can subtract
   * sleep windows from RTM service-time totals.
   */
  const notifySleepStateChange = useCallback((
    state: "hibernation" | "waking" | "awake" | "resting" | "asleep",
    source: "ai" | "system" | "user",
  ) => {
    wsSend({ type: "client_sleep_state_change", state, source });
  }, [wsSend]);

  /** Client-initiated app launch (e.g. from an AAC board button). */
  const launchApp = useCallback((appId: string, appData?: any) => {
    setActiveApp({ appId, appData });
  }, []);

  /**
   * Ask the server to open an app that declares startup parameters: it resolves
   * the params (from the conversation + student) and replies with the normal
   * `app_open` message, which clears the pending state and renders the app. A
   * 6s backstop falls back to an instant local launch so the student is never
   * stuck if the round-trip is lost.
   */
  const requestAppOpen = useCallback((appId: string, appData?: any) => {
    if (appOpenBackstopRef.current) clearTimeout(appOpenBackstopRef.current);
    setAppOpenPending(appId);
    wsSend({ type: "request_app_open", appId, appData });
    appOpenBackstopRef.current = setTimeout(() => {
      appOpenBackstopRef.current = null;
      setAppOpenPending((cur) => {
        if (cur !== appId) return cur; // already resolved/changed
        setActiveApp({ appId, appData });
        return null;
      });
    }, 6000);
  }, [wsSend]);

  const clearSession = useCallback(() => {
    if (wsRef.current) {
      closingIntentionallyRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    setSessionId(null);
    setIsInitialized(false);
    isInitializedRef.current = false;
    setCurrentMessage(null);
    setTranscription(null);
    setInterimTranscription(null);
    setUtteranceText(null);
    setDebugText(null);
    setError(null);
    setActiveApp(null);
    setSocialSession(null);
    setSocialPeerState(null);
    setSocialPeerDebug(null);
  }, []);

  /** DEBUG-only: restart the active social peer with fully custom parameters. */
  const reconfigureSocialPeer = useCallback((params: import("@shared/social-bot/debug").SocialPeerParams) => {
    wsSend({ type: "social_peer_reconfigure", params });
  }, [wsSend]);

  const stopAudio = useCallback(() => {
    audioPlayer.stop();
  }, [audioPlayer]);

  // -------------------------------------------------------------------------
  // Cleanup on unmount
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        closingIntentionallyRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Return — matches UseDualAgentReturn interface
  // -------------------------------------------------------------------------

  return {
    // Session state
    sessionId,
    clientConfig,
    isInitialized,
    isLoading,
    startupStage,
    error,
    snapshotTick,

    // Messages
    currentMessage,
    transcription,
    interimTranscription,
    utteranceText,
    utteranceConfidence,
    transcriptConfidence,
    debugText,

    // Audio state
    audioEnabled,
    isPlaying: audioPlayer.isPlaying,
    /** Tag of the audio chunk currently playing ("avatar" = AI/peer voice,
     *  "utterance" = student voice). Lets the avatar mouth animate only for
     *  its OWN voice, not the student's button-press playback. */
    audioPlayingTag: audioPlayer.currentTag,
    /** A MediaStream of the AAC's synthesized voice (all TTS paths), to send over a
     *  call so the student's button-press speech reaches the other side. */
    getCallAudioStream: audioPlayer.getCallStream,
    voiceEnabled,
    isRecording: audioRecorder.isRecording,
    audioLevel: audioRecorder.audioLevel,
    recordingDuration: audioRecorder.duration,

    // Mute state
    muteState,
    setMuteState,
    lastModeChange,

    // AAC token-budget level for the energy bar (null until first push).
    budget,

    // Response mode
    responseMode,
    setResponseMode,

    // Detection
    videoCaptureEnabled,
    setVideoCaptureEnabled,
    runDetectionWithGrid,

    // Debug
    debugData,
    requestCache: requestCache.cache,
    audioClipCache,
    identifiedFaces,
    identifiedVoices,

    // Active app
    activeApp,
    dismissApp,
    launchApp,
    requestAppOpen,
    appOpenPending,
    captureAppCanvasRef,
    // Apps available to launch from the static Apps board overlay
    enabledApps,
    availableCustomApps,
    permittedWebsites,

    // Avatar — only animate mouth during AI voice ("avatar" tag), not the student utterance
    emote,
    speakingVolume: audioPlayer.currentTag === "avatar" ? audioPlayer.speakingVolume : 0,
    thinkingPulse,
    processing,
    // True while the STUDENT voice is actively playing — marks the moment a
    // button press / composed sentence starts being voiced.
    voicingStudent: audioPlayer.isPlaying && audioPlayer.currentTag === "utterance",

    // Monitor status
    monitorError,
    monitorConsecutiveFailures,

    // Binary-choice overlay (yes/no now routed through this same surface)
    binaryChoiceOptions,
    binaryChoiceEscapeKind,
    binaryChoiceInputGlyphs,
    dismissBinaryChoice,

    // AI-initiated video-call directive (consumed by CallProvider)
    callDirective,

    // Caretaker alarm raised by the Observer agent
    activeAlarm,
    cancelAlarm,

    // Focus frame
    focusActive,

    // Actions
    initialize,
    sendMessage,
    sendContextOnly,
    debugSetBudget,
    sendMicState,
    sendSpeechMethod,
    sendCallActive,
    sendConversationRoom,
    sendConversationFocus,
    conversationRoster,
    floorState,
    sendBoardExit,
    sendVoice,
    voiceButtons,
    playGlyph,
    startRecording: audioRecorder.startRecording,
    stopRecording: audioRecorder.stopRecording as any,
    cancelRecording: audioRecorder.cancelRecording,
    setAudioEnabled,
    setVoiceEnabled,
    stopAudio,
    clearSession,

    // Live API only
    sendPcmAudio,
    sendFaceDescriptors,
    sendVoiceDescriptors,
    sendSpeechText,
    sendSpeechAudio,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamEnd,
    sendAudioClip,
    sendIdentityCorrection,
    sendFreshStartupFrame,
    isBusyRef: audioPlayer.isBusyRef,

    // Pause state
    paused,
    setPaused,

    // Sleep state — notify server of engagement-machine transitions
    notifySleepStateChange,

    // Guessing mode
    guessingMode,
    pressSuggestion,
    pressNarrow,
    enterGuessing,
    enterGuessingFromBuilder,
    exitGuessing,
    setBuilderVisible,

    // Social trainer (server-owned session)
    socialSession,
    socialPeerState,
    socialPeerDebug,
    socialPeerPreview,
    reconfigureSocialPeer,
    notifySocialTrainerStarted,
    // DEBUG: live peer voice dials (effective value + setter). Effective =
    // override if set, else the server's age-matched shift, else 0.
    peerVoicePitch: peerVoicePitchOverride ?? socialSession?.voicePitch ?? 0,
    setPeerVoicePitch: setPeerVoicePitchOverride,
    peerVoiceFormant: peerVoiceFormantOverride ?? socialSession?.voiceFormant ?? 0,
    setPeerVoiceFormant: setPeerVoiceFormantOverride,

    // Construction board (sentence builder)
    sendConstructionState,
    constructionSuggestions,
    constructionMemoryChips,

    // Reconnection state
    reconnecting,
    safetyBlocked,
  };
}
