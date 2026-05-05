// client-aac/src/hooks/useLiveSession.ts
// WebSocket-based hook for Gemini Live API sessions.
// Replaces useDualAgent for Live mode — same return interface, WebSocket transport.

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import type { ParsedBoardData } from "@shared/schema";
import { useStreamingAudioPlayer } from "./useStreamingAudioPlayer";
import { useAudioRecorder } from "./useAudioRecorder";
import type { ComposedGrid } from "@/lib/composeFrameGrid";
import type { UnknownFaceDescriptor } from "./usePersonIdentification";
import { useDebugRequestCache, type CachedRequest } from "./useDebugRequestCache";

// Re-export shared types
export type {
  DualAgentMessage,
  IdentifiedPerson,
  IdentifiedFace,
  ActiveAppData,
  BoardPatch,
  CachedAudioClip,
} from "./dual-agent-types";
import type {
  DualAgentMessage,
  IdentifiedPerson,
  IdentifiedFace,
  ActiveAppData,
  BoardPatch,
  CachedAudioClip,
  UseDualAgentReturn,
} from "./dual-agent-types";
import {
  saveSessionSnapshot,
  loadLatestSnapshot,
  cleanupOldSessions,
} from "@/services/aac-local-storage";
import type {
  AacLocalStorageConfig,
  AacSessionSnapshot,
} from "@shared/aac-local-storage";

export interface UseLiveSessionOptions {
  studentId: string;
  language?: string;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  onContextBoardUpdate?: (board: ParsedBoardData) => void;
  onContextBoardRemove?: (label: string) => void;
  onBoardPatch?: (patch: BoardPatch) => void;
  onSetBoard?: (data: { board: ParsedBoardData; name: string; boardId: string }) => void;
  onUnloadBoard?: () => void;
  onAiButtonPress?: (data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => void;
  onSymbolUpdate?: (data: { buttonLabel: string; symbolPath: string }) => void;
  onThinkingModeChange?: (thinking: boolean) => void;
  autoPlayAudio?: boolean;
  /** Per-tag pitch shift in semitones. Keys are audio tags: "avatar" (AI voice), "interpret" (student voice). */
  pitchByTag?: Record<string, number>;
  debugMode?: boolean;
  /** Function to capture a camera frame (used for initial image on startup) */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to capture a high-resolution frame for focus analysis */
  captureHighResFrame?: () => Promise<Blob | null>;
  /** Function to get serialized gesture/expression context (face + hand events) */
  getGestureContext?: () => string | null;
  /** AI invoked sleep / end_session — caller routes to the engagement state machine. */
  onSleepStateChange?: (state: import("@/lib/cameraAttentivenessTypes").SleepState, source: "ai" | "system") => void;
  /** AI invoked report_false_wake — caller bumps wake threshold dampening. */
  onFalseWakeReport?: (reason: string) => void;
}

export function useLiveSession(options: UseLiveSessionOptions): UseDualAgentReturn {
  const {
    studentId,
    language = "en",
    onBoardUpdate,
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

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debug state
  const [debugData, setDebugData] = useState<Record<string, any>>({});
  const [audioClipCache] = useState<CachedAudioClip[]>([]);
  const requestCache = useDebugRequestCache();

  // Monitor status
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [monitorConsecutiveFailures, setMonitorConsecutiveFailures] = useState(0);

  // Server-side face recognition results
  const [identifiedFaces, setIdentifiedFaces] = useState<IdentifiedFace[]>([]);

  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  // Mirror of isInitialized for use inside long-lived closures (ws.onclose)
  // that would otherwise capture a stale `false` from the initial render.
  const isInitializedRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
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
  const [interpretationText, setInterpretationText] = useState<string | null>(null);
  const [interpretConfidence, setInterpretConfidence] = useState<'high' | 'medium' | 'low' | null>(null);
  const [transcriptConfidence, setTranscriptConfidence] = useState<'high' | 'medium' | 'low' | null>(null);
  const [debugText, setDebugText] = useState<string | null>(null);

  // Audio state
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  // Interaction mode
  const [interactionMode, setInteractionModeState] = useState<"interact" | "silent">("interact");
  // Last mode change — set by AI tool calls or user toggle, used to flash an indicator
  const [lastModeChange, setLastModeChange] = useState<{ mode: "interact" | "assist" | "silent" | "standby"; reason?: string; source: "ai" | "user"; at: number } | null>(null);

  // Response mode
  const [responseMode, setResponseModeState] = useState<"fast" | "analyze">("fast");

  // Video capture state
  const [videoCaptureEnabled, setVideoCaptureEnabled] = useState(true);

  // Pause state
  const [paused, setPausedState] = useState(false);

  // Active app state
  const [activeApp, setActiveApp] = useState<ActiveAppData | null>(null);

  // App canvas capture ref (for drawing app, etc.)
  const captureAppCanvasRef = useRef<(() => Promise<Blob | null>) | null>(null);

  // Guessing mode state
  const [guessingMode, setGuessingMode] = useState(false);

  // Avatar emote state
  const [emote, setEmote] = useState<"happy" | "sad" | "neutral">("happy");

  // Yes/No overlay state
  const [yesNoActive, setYesNoActive] = useState(false);
  const dismissYesNo = useCallback(() => setYesNoActive(false), []);

  // Focus frame active state — briefly true when AI requests a focus frame
  const [focusActive, setFocusActive] = useState(false);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deferred ask_yes_no: show overlay after TTS playback completes
  const pendingAskYesNoRef = useRef(false);

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

  // Streaming audio player
  const audioPlayer = useStreamingAudioPlayer({
    autoPlay: autoPlayAudio,
    pitchByTag,
    onPlaybackEnd: () => {
      // Show deferred yes/no overlay after TTS finishes
      if (pendingAskYesNoRef.current) {
        pendingAskYesNoRef.current = false;
        setYesNoActive(true);
      }
    },
  });

  // Audio recorder
  const audioRecorder = useAudioRecorder();

  // Stable refs for callbacks
  const onBoardUpdateRef = useRef(onBoardUpdate);
  onBoardUpdateRef.current = onBoardUpdate;
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
        case "initialized":
          setSessionId(msg.sessionId);
          setIsInitialized(true);
          isInitializedRef.current = true;
          // Don't clear isLoading yet — wait until the first board arrives
          // so the loading screen stays up until the home page is ready.
          setError(null);
          break;

        case "text": {
          // Accumulate streamed text — keep the same message ID to avoid re-triggering animations
          // Skip empty/whitespace-only text to avoid clearing the display
          if (!msg.data || !msg.data.trim()) break;
          // Strip any tag-like artifacts that occasionally leak from Gemini's
          // output transcription (e.g. "<ctrl46>", "<end_of_turn>", "<unk>").
          // Log them so we can see what the model is producing.
          const tagMatches = msg.data.match(/<[^<>]+>/g);
          if (tagMatches) {
            console.log("[useLiveSession] Stripped tags from text:", tagMatches.join(", "), "| original:", msg.data);
          }
          const cleaned = msg.data.replace(/<[^<>]+>/g, "");
          if (!cleaned.trim()) break;
          textAccumRef.current += cleaned;
          setCurrentMessage(prev => ({
            id: prev?.role === "assistant" ? prev.id : `msg-${Date.now()}`,
            role: "assistant",
            content: textAccumRef.current,
            timestamp: prev?.role === "assistant" ? prev.timestamp : new Date().toISOString(),
          }));
          break;
        }

        case "interpret":
          setInterpretationText(prev => (prev || "") + (msg.text || ""));
          if (msg.confidence) setInterpretConfidence(msg.confidence);
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
          break;

        case "context":
          setDebugText(msg.data);
          break;

        case "board":
          onBoardUpdateRef.current?.(msg.data);
          setIsLoading(false);
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
          // AI voice audio chunk — tagged so avatar mouth animates
          if (audioEnabled) {
            audioPlayer.queueChunk({ chunk: msg.data, format: msg.format || "mp3", tag: "avatar" });
          }
          break;

        case "interpretation_audio":
          // Student voice audio chunk — tagged so avatar stays still
          if (audioEnabled) {
            audioPlayer.queueChunk({ chunk: msg.data, format: msg.format || "mp3", tag: "interpret" });
          }
          break;

        case "client_tts": {
          // Server requests client-side ElevenLabs TTS synthesis
          if (!audioEnabled) break;
          const { text: ttsText, voiceId, apiKey, language: ttsLang, voiceRole } = msg.data as {
            text: string; voiceId: string; apiKey: string; language: string; voiceRole: "ai" | "student";
          };
          const tag = voiceRole === "ai" ? "avatar" : "interpret";
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

        case "interaction_mode_changed":
          // AI changed interaction mode — flash indicator. Only sync the
          // primary `interactionMode` for "interact" / "silent" — the lighter
          // "assist" / "standby" states are tracked via lastModeChange and
          // shouldn't override the user-controlled silent/interact toggle.
          if (msg.data.mode === "interact" || msg.data.mode === "silent") {
            setInteractionModeState(msg.data.mode);
          }
          setLastModeChange({ mode: msg.data.mode, reason: msg.data.reason, source: msg.data.source, at: Date.now() });
          break;

        case "sleep_state_change":
          // AI invoked sleep() or end_session() — route to the engagement state machine.
          if (msg.data?.state) {
            onSleepStateChangeRef.current?.(msg.data.state, msg.data.source ?? "ai");
          }
          break;

        case "false_wake_report":
          // AI invoked report_false_wake() — bump wake threshold dampening.
          if (typeof msg.data?.reason === "string") {
            onFalseWakeReportRef.current?.(msg.data.reason);
          }
          break;

        case "video_play":
          setActiveApp({ appId: "youtube", appData: msg.data });
          break;

        case "yes_no":
          setYesNoActive(true);
          break;

        case "ask_yes_no":
          // Deferred yes/no — show overlay after TTS playback completes
          pendingAskYesNoRef.current = true;
          break;

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
                console.log("[LiveSession] Focus frame sent:", blob.size, "bytes");
              };
              reader.readAsDataURL(blob);
            }).catch(err => console.warn("[LiveSession] Focus frame capture failed:", err));
          }
          break;

        case "app_open":
          setActiveApp(msg.data);
          break;

        case "app_close":
          setActiveApp(null);
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
          setReconnecting(true);
          setError(null);
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
          break;

        case "error":
          setError(msg.data);
          setIsLoading(false);
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
          break;

        case "guessing_mode":
          setGuessingMode(msg.active ?? false);
          break;

        case "people_identified":
          setIdentifiedFaces(msg.data || []);
          break;

        case "complete":
          // Turn complete — keep text visible. Mark that the next "text" message
          // should start a fresh accumulation instead of appending.
          textAccumRef.current = ""; // Reset accumulator but don't clear display
          // Fallback: if deferred ask_yes_no is pending but no TTS is playing
          // (e.g. silent mode), show overlay immediately
          if (pendingAskYesNoRef.current && !audioPlayer.isPlaying) {
            pendingAskYesNoRef.current = false;
            setYesNoActive(true);
          }
          break;
      }
    } catch (err) {
      console.error("[useLiveSession] Failed to parse server message:", err);
    }
  }, [audioEnabled, audioPlayer]);

  // -------------------------------------------------------------------------
  // Initialize — open WebSocket and send initialize message
  // -------------------------------------------------------------------------

  const initialize = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("[useLiveSession] Already connected");
      return;
    }

    setIsLoading(true);
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

      // Build WebSocket URL from VITE_API_URL (same base as HTTP requests)
      // In dev: VITE_API_URL="http://localhost:5000" → "ws://localhost:5000/ws/live"
      // In prod: VITE_API_URL="" or unset → same origin as page
      const apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
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

          wsSend({
            type: "initialize",
            studentId,
            userId: userRef.current?.user?.id,
            interactionMode,
            responseMode,
            debugMode,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(initialFrameBase64 ? { initialFrame: initialFrameBase64 } : {}),
          });
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
  }, [studentId, interactionMode, responseMode, debugMode, isInitialized, wsSend, handleServerMessage]);

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

  const interpretButtons = useCallback(async (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => {
    wsSend({ type: "button_press", buttons: recentButtons, sentences, board });
  }, [wsSend]);

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

    // Send unknown face descriptors if present
    if (unknownFaceDescriptors?.length) {
      wsSend({ type: "unknown_face_descriptors", data: unknownFaceDescriptors });
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
    const gestureContext = options.getGestureContext?.() || undefined;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(",")[1];
      wsSend({
        type: "frame_grid",
        data: base64,
        timestamps: grid.timestamps,
        ...(gestureContext ? { gestureContext } : {}),
        ...(triggerReason ? { triggerReason } : {}),
      });
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

  // Interaction mode setter — also notify server
  const setInteractionMode = useCallback((mode: "interact" | "silent") => {
    setInteractionModeState(mode);
    setLastModeChange({ mode, source: "user", at: Date.now() });
    wsSend({ type: "set_mode", mode });
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

  /** Client-initiated app launch (e.g. from an AAC board button). */
  const launchApp = useCallback((appId: string, appData?: any) => {
    setActiveApp({ appId, appData });
  }, []);

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
    setInterpretationText(null);
    setDebugText(null);
    setError(null);
    setActiveApp(null);
  }, []);

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
    isInitialized,
    isLoading,
    error,

    // Messages
    currentMessage,
    transcription,
    interpretationText,
    interpretConfidence,
    transcriptConfidence,
    debugText,

    // Audio state
    audioEnabled,
    isPlaying: audioPlayer.isPlaying,
    voiceEnabled,
    isRecording: audioRecorder.isRecording,
    audioLevel: audioRecorder.audioLevel,
    recordingDuration: audioRecorder.duration,

    // Interaction mode
    interactionMode,
    setInteractionMode,
    lastModeChange,

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

    // Active app
    activeApp,
    dismissApp,
    launchApp,
    captureAppCanvasRef,

    // Avatar — only animate mouth during AI voice ("avatar" tag), not interpretation
    emote,
    speakingVolume: audioPlayer.currentTag === "avatar" ? audioPlayer.speakingVolume : 0,

    // Monitor status
    monitorError,
    monitorConsecutiveFailures,

    // Yes/No overlay
    yesNoActive,
    dismissYesNo,

    // Focus frame
    focusActive,

    // Actions
    initialize,
    sendMessage,
    sendContextOnly,
    sendBoardExit,
    sendVoice,
    interpretButtons,
    startRecording: audioRecorder.startRecording,
    stopRecording: audioRecorder.stopRecording as any,
    cancelRecording: audioRecorder.cancelRecording,
    setAudioEnabled,
    setVoiceEnabled,
    stopAudio,
    clearSession,

    // Live API only
    sendPcmAudio,
    isBusyRef: audioPlayer.isBusyRef,

    // Pause state
    paused,
    setPaused,

    // Guessing mode
    guessingMode,

    // Reconnection state
    reconnecting,
    safetyBlocked,
  };
}
