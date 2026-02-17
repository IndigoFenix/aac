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

// Re-export types from useDualAgent for compatibility
export type {
  DualAgentMessage,
  IdentifiedPerson,
  ActiveAppData,
  BoardPatch,
  CachedAudioClip,
} from "./useDualAgent";
import type {
  DualAgentMessage,
  IdentifiedPerson,
  ActiveAppData,
  BoardPatch,
  CachedAudioClip,
  UseDualAgentReturn,
} from "./useDualAgent";

export interface UseLiveSessionOptions {
  studentId: string;
  language?: string;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  onBoardPatch?: (patch: BoardPatch) => void;
  onSetBoard?: (data: { board: ParsedBoardData; name: string; boardId: string }) => void;
  onAiButtonPress?: (data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => void;
  onThinkingModeChange?: (thinking: boolean) => void;
  autoPlayAudio?: boolean;
  debugMode?: boolean;
}

export function useLiveSession(options: UseLiveSessionOptions): UseDualAgentReturn {
  const {
    studentId,
    language = "en",
    onBoardUpdate,
    onBoardPatch,
    onSetBoard,
    onAiButtonPress,
    onThinkingModeChange,
    autoPlayAudio = true,
    debugMode = false,
  } = options;
  const { user } = useAuth();
  // Stable ref so ws.onopen always reads the latest user
  const userRef = useRef(user);
  userRef.current = user;

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

  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingMode, setThinkingMode] = useState(false);

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

  // Response mode
  const [responseMode, setResponseModeState] = useState<"fast" | "analyze">("fast");

  // Video capture state
  const [videoCaptureEnabled, setVideoCaptureEnabled] = useState(true);

  // Active app state
  const [activeApp, setActiveApp] = useState<ActiveAppData | null>(null);

  // App canvas capture ref (for drawing app, etc.)
  const captureAppCanvasRef = useRef<(() => Promise<Blob | null>) | null>(null);

  // Avatar emote state
  const [emote, setEmote] = useState<"happy" | "sad" | "neutral">("happy");

  // Yes/No overlay state
  const [yesNoActive, setYesNoActive] = useState(false);
  const dismissYesNo = useCallback(() => setYesNoActive(false), []);

  // Streaming audio player
  const audioPlayer = useStreamingAudioPlayer({ autoPlay: autoPlayAudio });

  // Audio recorder
  const audioRecorder = useAudioRecorder();

  // Stable refs for callbacks
  const onBoardUpdateRef = useRef(onBoardUpdate);
  onBoardUpdateRef.current = onBoardUpdate;
  const onBoardPatchRef = useRef(onBoardPatch);
  onBoardPatchRef.current = onBoardPatch;
  const onSetBoardRef = useRef(onSetBoard);
  onSetBoardRef.current = onSetBoard;
  const onAiButtonPressRef = useRef(onAiButtonPress);
  onAiButtonPressRef.current = onAiButtonPress;
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
    }
  }, []);

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
          setIsLoading(false);
          setError(null);
          break;

        case "text":
          // New speech arriving — stop any playing audio from a previous turn
          audioPlayer.clear();
          // Accumulate streamed text from [SPEAK]
          textAccumRef.current += msg.data;
          setCurrentMessage({
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: textAccumRef.current,
            timestamp: new Date().toISOString(),
          });
          break;

        case "interpret":
          // New interpretation arriving — stop any playing audio from a previous turn
          audioPlayer.clear();
          setInterpretationText(prev => (prev || "") + (msg.text || ""));
          if (msg.confidence) setInterpretConfidence(msg.confidence);
          break;

        case "audio_interrupt":
          // Gemini was interrupted by user input — stop audio immediately
          audioPlayer.clear();
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

        case "set_board":
          // AI selected a pre-built board — update board and notify parent
          if (msg.data?.board) {
            onBoardUpdateRef.current?.(msg.data.board);
          }
          onSetBoardRef.current?.(msg.data);
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
            audioPlayer.queueChunk({ chunk: msg.data, format: "mp3", tag: "avatar" });
          }
          break;

        case "interpretation_audio":
          // Student voice audio chunk — tagged so avatar stays still
          if (audioEnabled) {
            audioPlayer.queueChunk({ chunk: msg.data, format: "mp3", tag: "interpret" });
          }
          break;

        case "emote":
          setEmote(msg.data as "happy" | "sad" | "neutral");
          break;

        case "video_play":
          setActiveApp({ appId: "youtube", appData: msg.data });
          break;

        case "yes_no":
          setYesNoActive(true);
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

        case "error":
          setError(msg.data);
          setIsLoading(false);
          break;

        case "complete":
          // Turn complete — reset accumulator, finalize audio
          textAccumRef.current = "";
          // Turn complete — audio finalized by the player naturally
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

    try {
      // Build WebSocket URL from VITE_API_URL (same base as HTTP requests)
      // In dev: VITE_API_URL="http://localhost:5000" → "ws://localhost:5000/ws/live"
      // In prod: VITE_API_URL="" or unset → same origin as page
      const apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
      let wsUrl: string;
      if (apiBase) {
        // Replace http(s) with ws(s)
        wsUrl = apiBase.replace(/^http/, "ws") + "/ws/live";
      } else {
        // Same origin
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${protocol}//${window.location.host}/ws/live`;
      }
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[useLiveSession] WebSocket connected");
        // Send initialize message (include userId for session/memory access)
        // useAuth().user is the full API response: { success, user: { id, ... } }
        // Read from ref in case auth loaded after callback was created
        wsSend({
          type: "initialize",
          studentId,
          userId: userRef.current?.user?.id,
          interactionMode,
          responseMode,
          debugMode,
        });
      };

      ws.onmessage = handleServerMessage;

      ws.onclose = (event) => {
        console.log(`[useLiveSession] WebSocket closed: ${event.code} ${event.reason}`);
        wsRef.current = null;
        if (isInitialized) {
          // Auto-reconnect after unexpected close
          reconnectTimerRef.current = setTimeout(() => {
            console.log("[useLiveSession] Attempting reconnect...");
            initialize();
          }, 3000);
        }
      };

      ws.onerror = (event) => {
        console.error("[useLiveSession] WebSocket error:", event);
        setError("WebSocket connection failed");
        setIsLoading(false);
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error.message);
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
    setCurrentMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });
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

  const interpretButtons = useCallback(async (recentButtons: string[], board?: ParsedBoardData) => {
    wsSend({ type: "button_press", buttons: recentButtons, board });
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

    // Convert grid JPEG to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(",")[1];
      wsSend({
        type: "frame_grid",
        data: base64,
        timestamps: grid.timestamps,
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
  }, [wsSend]);

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
    wsSend({ type: "set_mode", mode });
  }, [wsSend]);

  // Response mode setter — also notify server
  const setResponseMode = useCallback((mode: "fast" | "analyze") => {
    setResponseModeState(mode);
    wsSend({ type: "set_response_mode", mode });
  }, [wsSend]);

  const dismissApp = useCallback(() => {
    setActiveApp(null);
  }, []);

  const clearSession = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setSessionId(null);
    setIsInitialized(false);
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
    thinkingMode,

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

    // Active app
    activeApp,
    dismissApp,
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

    // Actions
    initialize,
    sendMessage,
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
  };
}
