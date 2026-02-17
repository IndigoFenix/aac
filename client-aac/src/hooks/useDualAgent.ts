// client-aac/src/hooks/useDualAgent.ts
// Hook for interacting with the dual-agent AAC system

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { fetchWithAuth } from "@/lib/queryClient";
import type { ParsedBoardData } from "@shared/schema";
import { useStreamingAudioPlayer } from "./useStreamingAudioPlayer";
import { useAudioRecorder } from "./useAudioRecorder";
import { prepareFrameForAI } from "@/lib/prepareFrameForAI";
import type { ComposedGrid, DualComposedGrid } from "@/lib/composeFrameGrid";
import type { UnknownFaceDescriptor } from "./usePersonIdentification";
import { useDebugRequestCache, type CachedRequest } from "./useDebugRequestCache";

export interface DualAgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  isThinking?: boolean;
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

/** Data for an active add-on app */
export interface ActiveAppData {
  appId: string;
  appData?: any;
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

const MAX_AUDIO_CLIP_CACHE = 15;

export interface UseDualAgentOptions {
  studentId: string;
  language?: string;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  onBoardPatch?: (patch: BoardPatch) => void;
  onSetBoard?: (data: { board: ParsedBoardData; name: string; boardId: string }) => void;
  onAiButtonPress?: (data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => void;
  onThinkingModeChange?: (thinking: boolean) => void;
  autoPlayAudio?: boolean;
  /** Function to capture a camera frame - returns Blob */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to get the current identified person (if any) */
  getIdentifiedPerson?: () => IdentifiedPerson | null;
  /** Function to get serialized gesture/expression context string (face + hand events) */
  getGestureContext?: () => string | null;
  /** When true, sends debugMode flag to backend and collects debug SSE events */
  debugMode?: boolean;
}

export interface UseDualAgentReturn {
  // Session state
  sessionId: string | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  thinkingMode: boolean;

  // Messages
  currentMessage: DualAgentMessage | null;
  transcription: string | null;
  interpretationText: string | null;
  interpretConfidence: 'high' | 'medium' | 'low' | null;
  transcriptConfidence: 'high' | 'medium' | 'low' | null;
  debugText: string | null;

  // Audio state
  audioEnabled: boolean;
  isPlaying: boolean;
  voiceEnabled: boolean;
  isRecording: boolean;
  audioLevel: number;
  recordingDuration: number;

  // Interaction mode
  interactionMode: 'interact' | 'silent';
  setInteractionMode: (mode: 'interact' | 'silent') => void;

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

  // Active app
  activeApp: ActiveAppData | null;
  dismissApp: () => void;
  /** Register a function to capture the app canvas (e.g. drawing) for detection */
  captureAppCanvasRef: React.MutableRefObject<(() => Promise<Blob | null>) | null>;

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;

  // Monitor status
  monitorError: string | null;
  monitorConsecutiveFailures: number;

  // Actions
  initialize: () => Promise<void>;
  sendMessage: (message: string, board?: ParsedBoardData) => Promise<void>;
  sendVoice: (board?: ParsedBoardData) => Promise<void>;
  interpretButtons: (recentButtons: string[], board?: ParsedBoardData) => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
  setAudioEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  stopAudio: () => void;
  clearSession: () => void;

  // Yes/No overlay
  yesNoActive: boolean;
  dismissYesNo: () => void;

  // Live API only — raw PCM audio streaming
  /** Send a raw PCM audio chunk (base64 Int16 16kHz) to Gemini Live API. Only available in Live mode. */
  sendPcmAudio?: (int16Base64: string) => void;
  /** Synchronous ref: true from first queued audio chunk until echo tail ends. Use for mic gating. */
  isBusyRef?: { readonly current: boolean };
}

export function useDualAgent(options: UseDualAgentOptions): UseDualAgentReturn {
  const { studentId, language = "en", onBoardUpdate, onBoardPatch, onSetBoard, onAiButtonPress, onThinkingModeChange, autoPlayAudio = true, captureFrame, getIdentifiedPerson, getGestureContext, debugMode = false } = options;
  const { user } = useAuth();

  // Debug state
  const [debugData, setDebugData] = useState<Record<string, any>>({});
  const [audioClipCache, setAudioClipCache] = useState<CachedAudioClip[]>([]);
  const requestCache = useDebugRequestCache();
  const debugModeRef = useRef(debugMode);
  debugModeRef.current = debugMode;

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
  const [interactionMode, setInteractionMode] = useState<'interact' | 'silent'>('interact');

  // Response mode: 'fast' (voice first) or 'analyze' (observe first)
  const [responseMode, setResponseMode] = useState<'fast' | 'analyze'>('fast');

  // Video capture state (enabled by default - only sends data after initialized)
  const [videoCaptureEnabled, setVideoCaptureEnabled] = useState(true);

  // Active app state
  const [activeApp, setActiveApp] = useState<ActiveAppData | null>(null);

  // Ref for app canvas capture (e.g. drawing app registers this)
  const captureAppCanvasRef = useRef<(() => Promise<Blob | null>) | null>(null);

  // Avatar emote state
  const [emote, setEmote] = useState<"happy" | "sad" | "neutral">("happy");

  // Yes/No overlay state
  const [yesNoActive, setYesNoActive] = useState(false);
  const dismissYesNo = useCallback(() => setYesNoActive(false), []);

  // Track whether current audio is AI voice (not interpretation)
  const isAiVoiceRef = useRef(true);

  // Mutex: prevent concurrent message + detection API calls
  // "message" | "detect" | null — tracks what's currently in flight
  const inflightRef = useRef<"message" | "detect" | null>(null);
  // Queued message to send after detection finishes
  const queuedMessageRef = useRef<{ message: string; board?: ParsedBoardData } | null>(null);

  // Dismiss app callback
  const dismissApp = useCallback(() => setActiveApp(null), []);

  // Refs
  const currentBoardRef = useRef<ParsedBoardData | null>(null);

  /**
   * Apply a board patch (add/remove/rebuild) to the current board
   */
  const applyBoardPatch = useCallback((patch: BoardPatch): ParsedBoardData | null => {
    const board = currentBoardRef.current;
    if (!board) return null;

    const currentPage = board.pages?.find(p => p.id === board.currentPageId) || board.pages?.[0];
    if (!currentPage) return board;

    const grid = board.grid || { rows: 3, cols: 4 };
    const totalCells = grid.rows * grid.cols;

    let buttons: typeof currentPage.buttons;

    // If rebuild is present, replace all buttons
    if (patch.rebuild && patch.rebuild.length > 0) {
      buttons = patch.rebuild.slice(0, totalCells).map((btn, index) => ({
        id: `btn-${Date.now()}-${index}`,
        label: btn.label,
        spokenText: btn.label,
        row: Math.floor(index / grid.cols),
        col: index % grid.cols,
        iconRef: btn.iconRef || undefined,
        symbolPath: btn.symbolPath || undefined,
        action: { type: "speak" as const, text: btn.label },
      }));
    } else {
      // Incremental add/remove
      buttons = [...(currentPage.buttons || [])];

      // Remove buttons by label
      if (patch.remove && patch.remove.length > 0) {
        const removeSet = new Set(patch.remove.map(l => l.toLowerCase()));
        buttons = buttons.filter(b => !removeSet.has((b.label || "").toLowerCase()));
      }

      // Add new buttons to available slots
      if (patch.add && patch.add.length > 0) {
        for (const newBtn of patch.add) {
          if (buttons.length >= totalCells) break;
          const index = buttons.length;
          buttons.push({
            id: `btn-${Date.now()}-${index}`,
            label: newBtn.label,
            spokenText: newBtn.label,
            row: Math.floor(index / grid.cols),
            col: index % grid.cols,
            iconRef: newBtn.iconRef || undefined,
            symbolPath: newBtn.symbolPath || undefined,
            action: { type: "speak" as const, text: newBtn.label },
          });
        }
      }
    }

    const updatedBoard: ParsedBoardData = {
      ...board,
      pages: board.pages?.map(p =>
        p.id === currentPage.id ? { ...p, buttons } : p
      ) || [{ ...currentPage, buttons }],
    };

    return updatedBoard;
  }, []);

  // Stable refs for callbacks that change identity often (avoids restarting detection loop)
  const captureFrameRef = useRef(captureFrame);
  captureFrameRef.current = captureFrame;
  const getGestureContextRef = useRef(getGestureContext);
  getGestureContextRef.current = getGestureContext;
  const onBoardUpdateRef = useRef(onBoardUpdate);
  onBoardUpdateRef.current = onBoardUpdate;
  const onBoardPatchRef = useRef(onBoardPatch);
  onBoardPatchRef.current = onBoardPatch;
  const onSetBoardRef = useRef(onSetBoard);
  onSetBoardRef.current = onSetBoard;
  const onAiButtonPressRef = useRef(onAiButtonPress);
  onAiButtonPressRef.current = onAiButtonPress;

  // Stable refs for values used inside runDetection (avoids restarting detection loop)
  const audioEnabledRef = useRef(audioEnabled);
  audioEnabledRef.current = audioEnabled;
  const streamingPlayerRef = useRef<ReturnType<typeof useStreamingAudioPlayer>>(null!);


  // Audio recorder
  const audioRecorder = useAudioRecorder();

  // Streaming audio player
  const streamingPlayer = useStreamingAudioPlayer({
    autoPlay: autoPlayAudio && audioEnabled,
    onPlaybackStart: () => console.log("[DualAgent] Audio playback started"),
    onPlaybackEnd: () => console.log("[DualAgent] Audio playback ended"),
    onError: (err) => console.error("[DualAgent] Audio error:", err),
  });
  streamingPlayerRef.current = streamingPlayer;

  // Notify when thinking mode changes
  useEffect(() => {
    onThinkingModeChange?.(thinkingMode);
  }, [thinkingMode, onThinkingModeChange]);

  /**
   * Process SSE stream from dual-agent endpoint
   */
  const processSSEStream = useCallback(
    async (response: Response) => {
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let responseText = "";
      let currentEventType = "message";

      const processLine = (line: string) => {
        if (line.startsWith("event:")) {
          currentEventType = line.slice(6).trim();
          return;
        }

        if (line.startsWith("data:")) {
          try {
            const data = JSON.parse(line.slice(5).trim());

            switch (currentEventType) {
              case "transcription":
                setTranscription(data.text);
                break;

              case "text":
                responseText += data.chunk || "";
                // Update current message progressively
                setCurrentMessage({
                  id: Date.now().toString(),
                  role: "assistant",
                  content: responseText,
                  timestamp: new Date().toISOString(),
                  isThinking: thinkingMode,
                });
                break;

              case "board":
                if (data.board && onBoardUpdate) {
                  currentBoardRef.current = data.board;
                  onBoardUpdate(data.board);
                }
                break;

              case "audio":
                if (audioEnabled) {
                  isAiVoiceRef.current = true;
                  streamingPlayer.queueChunk({
                    chunk: data.chunk,
                    format: data.format || "mp3",
                  });
                }
                break;

              case "interpretation":
                setInterpretationText(data.text);
                break;

              case "interpretation_audio":
                if (audioEnabled) {
                  isAiVoiceRef.current = false;
                  streamingPlayer.queueChunk({
                    chunk: data.chunk,
                    format: data.format || "mp3",
                  });
                }
                break;

              case "debug":
                // Merge debug data from SSE events (structured debug info)
                if (data.debugType) {
                  setDebugData(prev => ({ ...prev, [data.debugType]: data }));
                }
                setDebugText(data.text || data.debugType || null);
                break;

              case "monitor_status":
                // Monitor agent error status
                if (data.error) {
                  setMonitorError(data.error);
                  setMonitorConsecutiveFailures(data.consecutiveFailures || 1);
                  console.warn(`[DualAgent] Monitor error (${data.consecutiveFailures} failures):`, data.error);
                } else {
                  setMonitorError(null);
                  setMonitorConsecutiveFailures(0);
                }
                break;

              case "transcript":
                // Voice transcript from AI detection
                console.log("[DualAgent] Transcript:", data.text, "speaker:", data.speaker);
                if (data.text && debugModeRef.current) {
                  setDebugData(prev => ({
                    ...prev,
                    last_transcript: { text: data.text, speaker: data.speaker, timestamp: Date.now() },
                  }));
                }
                break;

              case "context":
                // Context update from AI observation
                console.log("[DualAgent] Context update:", data.text);
                if (data.text && debugModeRef.current) {
                  setDebugData(prev => ({
                    ...prev,
                    last_context_update: { text: data.text, timestamp: Date.now() },
                  }));
                }
                break;

              case "app_open":
                // Add-on app open event
                if (data.appId) {
                  setActiveApp({ appId: data.appId, appData: data.appData });
                }
                break;

              case "app_close":
                // Add-on app close event
                setActiveApp(null);
                break;

              case "emote":
                // Avatar emotion from [EMOTE] token
                if (data.emote) {
                  setEmote(data.emote);
                }
                break;

              case "set_board":
                // Pre-built board loaded by AI
                if (data.board && onSetBoardRef.current) {
                  currentBoardRef.current = data.board;
                  onSetBoardRef.current(data);
                }
                break;

              case "ai_button_press":
                // AI pressed a navigation button on the loaded board
                if (data.targetPageId && onAiButtonPressRef.current) {
                  onAiButtonPressRef.current(data);
                }
                break;

              case "yes_no":
                // Yes/No question detected — show overlay
                setYesNoActive(true);
                break;

              case "board_patch":
                // Board patch from detection (add/remove/rebuild)
                if (data.add?.length > 0 || data.remove?.length > 0 || data.rebuild?.length > 0) {
                  const patch: BoardPatch = { add: data.add || [], remove: data.remove || [], rebuild: data.rebuild };
                  // Update internal ref so subsequent requests have correct board state
                  const updatedBoard = applyBoardPatch(patch);
                  if (updatedBoard) {
                    currentBoardRef.current = updatedBoard;
                  }
                  // Notify parent component
                  if (onBoardPatchRef.current) {
                    onBoardPatchRef.current(patch);
                  }
                }
                break;

              case "complete":
                if (data.sessionId) {
                  setSessionId(data.sessionId);
                }
                // Stream completed successfully — clear any stale connection error
                setError(null);
                // Final message update
                if (responseText) {
                  setCurrentMessage({
                    id: Date.now().toString(),
                    role: "assistant",
                    content: responseText,
                    timestamp: new Date().toISOString(),
                    isThinking: thinkingMode,
                  });
                }
                break;

              case "error":
                setError(data.error || "Unknown error");
                break;
            }
          } catch {
            // Ignore parse errors for incomplete JSON
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          processLine(line);
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const remainingLines = buffer.split("\n");
        for (const line of remainingLines) {
          processLine(line);
        }
      }
    },
    [audioEnabled, thinkingMode, onBoardUpdate, streamingPlayer, applyBoardPatch]
  );

  /**
   * Initialize a new session with greeting
   * This streams the initial greeting, board buttons, and audio
   */
  const initialize = useCallback(async () => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      // Capture camera frame if available for context-aware initialization (use ref for stability)
      let imageBlob: Blob | null = null;
      const capture = captureFrameRef.current;
      if (capture) {
        try {
          imageBlob = await capture();
          if (imageBlob && imageBlob.size > 0) {
            imageBlob = await prepareFrameForAI(imageBlob);
            console.log("[DualAgent] [InitialCapture] Captured camera frame for initialization,", imageBlob.size, "bytes");
          } else {
            imageBlob = null;
            console.warn("[DualAgent] [InitialCapture] Frame capture returned empty blob");
          }
        } catch (err) {
          console.warn("[DualAgent] [InitialCapture] Failed to capture frame for init:", err);
        }
      }

      // Get gesture context if available (use ref for stability)
      const gestureContext = getGestureContextRef.current?.() || undefined;

      // Cache request for debug panel
      if (debugModeRef.current) {
        requestCache.addRequest({
          endpoint: "/initialize",
          hasImage: !!imageBlob,
          hasAudio: false,
          hasGestureContext: !!gestureContext,
          boardSlotCount: 0,
          interactionMode,
        });
      }

      let response: globalThis.Response;

      if (imageBlob) {
        // Use FormData for image upload
        const formData = new FormData();
        formData.append("studentId", studentId);
        if (sessionId) formData.append("sessionId", sessionId);
        formData.append("interactionMode", interactionMode);
        formData.append("responseMode", responseMode);
        if (gestureContext) formData.append("gestureContext", gestureContext);
        if (debugModeRef.current) formData.append("debugMode", "true");
        formData.append("image", imageBlob, "init.jpg");

        response = await fetchWithAuth("/api/aac/dual/initialize", {
          method: "POST",
          body: formData,
        });
      } else {
        response = await fetchWithAuth("/api/aac/dual/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId,
            sessionId: sessionId || undefined,
            interactionMode,
            responseMode,
            gestureContext,
            ...(debugModeRef.current ? { debugMode: "true" } : {}),
          }),
        });
      }

      if (!response.ok) {
        throw new Error(`Failed to initialize: ${response.status}`);
      }

      // Process SSE stream for initial greeting
      await processSSEStream(response);
      setIsInitialized(true);

      console.log("[DualAgent] Session initialized with greeting");
    } catch (err: any) {
      console.error("[DualAgent] Initialize error:", err);
      setError(err.message || "Failed to initialize session");
    } finally {
      setIsLoading(false);
    }
  }, [studentId, sessionId, isLoading, interactionMode, responseMode, processSSEStream]);

  /**
   * Send a text message (with optional camera frame)
   */
  const sendMessage = useCallback(
    async (message: string, board?: ParsedBoardData) => {
      if (!message.trim()) return;

      // If detection is in flight, queue this message for after it finishes
      if (inflightRef.current === "detect") {
        console.log("[DualAgent] Detection in flight — queuing message:", message);
        queuedMessageRef.current = { message, board };
        return;
      }
      // If another message is already in flight, skip (prevents double-send)
      if (inflightRef.current === "message") return;

      inflightRef.current = "message";
      streamingPlayer.clear(); // Stop any playing audio — user action takes priority
      setIsLoading(true);
      setError(null);
      setTranscription(null);

      try {
        // Capture camera frame if available
        let imageBlob: Blob | null = null;
        if (captureFrame) {
          try {
            imageBlob = await captureFrame();
            if (imageBlob) {
              imageBlob = await prepareFrameForAI(imageBlob);
              console.log("[DualAgent] Captured camera frame for message");
            }
          } catch (err) {
            console.warn("[DualAgent] Failed to capture frame:", err);
          }
        }

        // Get identified person if available (non-blocking)
        const identifiedPerson = getIdentifiedPerson?.() || undefined;
        if (identifiedPerson) {
          console.log(`[DualAgent] Including identified person: ${identifiedPerson.name}`);
        }

        // Get gesture context if available (face expressions + hand gestures)
        const gestureContext = getGestureContext?.() || undefined;
        if (gestureContext) {
          console.log(`[DualAgent] Including gesture context (${gestureContext.length} chars)`);
        }

        const boardData = board || currentBoardRef.current;

        // Cache request for debug panel
        if (debugModeRef.current) {
          requestCache.addRequest({
            endpoint: "/message",
            hasImage: !!imageBlob,
            hasAudio: false,
            hasGestureContext: !!gestureContext,
            boardSlotCount: boardData?.pages?.[0]?.buttons?.length || 0,
            messagePreview: message.substring(0, 80),
            interactionMode,
          });
        }

        let response: globalThis.Response;

        if (imageBlob) {
          const formData = new FormData();
          formData.append("studentId", studentId);
          if (sessionId) formData.append("sessionId", sessionId);
          formData.append("message", message);
          if (language) formData.append("language", language);
          if (boardData) formData.append("board", JSON.stringify(boardData));
          if (identifiedPerson) formData.append("identifiedPerson", JSON.stringify(identifiedPerson));
          if (gestureContext) formData.append("gestureContext", gestureContext);
          formData.append("interactionMode", interactionMode);
          formData.append("responseMode", responseMode);
          if (debugModeRef.current) formData.append("debugMode", "true");
          formData.append("image", imageBlob, "frame.jpg");

          response = await fetchWithAuth("/api/aac/dual/message", {
            method: "POST",
            body: formData,
          });
        } else {
          response = await fetchWithAuth("/api/aac/dual/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentId,
              sessionId,
              message,
              language,
              board: boardData,
              identifiedPerson,
              gestureContext,
              interactionMode,
              responseMode,
              ...(debugModeRef.current ? { debugMode: "true" } : {}),
            }),
          });
        }

        if (!response.ok) {
          throw new Error(`Message failed: ${response.status}`);
        }

        await processSSEStream(response);
      } catch (err: any) {
        console.error("[DualAgent] Message error:", err);
        setError(err.message || "Failed to send message");
      } finally {
        inflightRef.current = null;
        setIsLoading(false);
      }
    },
    [studentId, sessionId, language, interactionMode, responseMode, processSSEStream, captureFrame, getIdentifiedPerson, getGestureContext]
  );

  // Stable ref for sendMessage — used by detection flush to avoid circular deps
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  /**
   * Send voice input (with optional camera frame)
   */
  const sendVoice = useCallback(
    async (board?: ParsedBoardData) => {
      const audioBlob = await audioRecorder.stopRecording();
      if (!audioBlob || audioBlob.size === 0) {
        console.warn("[DualAgent] No audio recorded");
        return;
      }

      setIsLoading(true);
      setError(null);
      setTranscription(null);

      try {
        // Capture camera frame if available
        let imageBlob: Blob | null = null;
        if (captureFrame) {
          try {
            imageBlob = await captureFrame();
            if (imageBlob) {
              imageBlob = await prepareFrameForAI(imageBlob);
              console.log("[DualAgent] Captured camera frame for voice message");
            }
          } catch (err) {
            console.warn("[DualAgent] Failed to capture frame:", err);
          }
        }

        // Get identified person if available (non-blocking)
        const identifiedPerson = getIdentifiedPerson?.() || undefined;
        if (identifiedPerson) {
          console.log(`[DualAgent] Including identified person in voice: ${identifiedPerson.name}`);
        }

        // Get gesture context if available
        const gestureContext = getGestureContext?.() || undefined;

        // Cache request for debug panel
        if (debugModeRef.current) {
          requestCache.addRequest({
            endpoint: "/voice",
            hasImage: !!imageBlob,
            hasAudio: true,
            hasGestureContext: !!gestureContext,
            boardSlotCount: (board || currentBoardRef.current)?.pages?.[0]?.buttons?.length || 0,
            interactionMode,
          });
        }

        const formData = new FormData();
        formData.append("audio", audioBlob, "recording.webm");
        formData.append("studentId", studentId);
        if (sessionId) {
          formData.append("sessionId", sessionId);
        }
        if (language) {
          formData.append("language", language);
        }
        if (board || currentBoardRef.current) {
          formData.append("board", JSON.stringify(board || currentBoardRef.current));
        }
        if (imageBlob) {
          formData.append("image", imageBlob, "frame.jpg");
        }
        if (identifiedPerson) {
          formData.append("identifiedPerson", JSON.stringify(identifiedPerson));
        }
        if (gestureContext) {
          formData.append("gestureContext", gestureContext);
        }
        formData.append("interactionMode", interactionMode);
        formData.append("responseMode", responseMode);
        if (debugModeRef.current) formData.append("debugMode", "true");

        const response = await fetchWithAuth("/api/aac/dual/voice", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          throw new Error(`Voice failed: ${response.status}`);
        }

        await processSSEStream(response);
      } catch (err: any) {
        console.error("[DualAgent] Voice error:", err);
        setError(err.message || "Failed to process voice");
      } finally {
        setIsLoading(false);
      }
    },
    [studentId, sessionId, language, interactionMode, responseMode, audioRecorder, processSSEStream, captureFrame, getIdentifiedPerson, getGestureContext]
  );

  /**
   * Interpret recent button presses into a spoken sentence
   */
  const interpretButtons = useCallback(
    async (recentButtons: string[], board?: ParsedBoardData) => {
      if (isLoading || recentButtons.length === 0) return;

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetchWithAuth("/api/aac/dual/interpret", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId,
            sessionId,
            recentButtons,
            board: board || currentBoardRef.current,
          }),
        });

        if (!response.ok) {
          throw new Error(`Interpret failed: ${response.status}`);
        }

        await processSSEStream(response);
      } catch (err: any) {
        console.error("[DualAgent] Interpret error:", err);
        setError(err.message || "Failed to interpret buttons");
      } finally {
        setIsLoading(false);
      }
    },
    [studentId, sessionId, isLoading, processSSEStream]
  );

  /**
   * Start voice recording
   */
  const startRecording = useCallback(async () => {
    setError(null);
    setTranscription(null);
    streamingPlayer.clear();
    await audioRecorder.startRecording();
  }, [audioRecorder, streamingPlayer]);

  /**
   * Stop recording and send
   */
  const stopRecording = useCallback(async () => {
    await sendVoice();
  }, [sendVoice]);

  /**
   * Cancel recording without sending
   */
  const cancelRecording = useCallback(() => {
    audioRecorder.cancelRecording();
    setTranscription(null);
  }, [audioRecorder]);

  /**
   * Stop any playing audio and clear the queue
   */
  const stopAudio = useCallback(() => {
    streamingPlayer.clear();
  }, [streamingPlayer]);

  /**
   * Clear session and start fresh
   */
  const clearSession = useCallback(() => {
    setSessionId(null);
    setIsInitialized(false);
    setCurrentMessage(null);
    setTranscription(null);
    setInterpretationText(null);
    setDebugText(null);
    setError(null);
    setThinkingMode(false);
    streamingPlayer.clear();
  }, [streamingPlayer]);

  /**
   * Update current board ref when board changes externally
   */
  const updateBoard = useCallback((board: ParsedBoardData) => {
    currentBoardRef.current = board;
  }, []);

  /**
   * Run detection with a composite frame grid and audio clip.
   * Called by useActivityMonitor when activity triggers are detected.
   */
  const runDetectionWithGrid = useCallback(async (grid: ComposedGrid | null, audioClip: Blob | null, unknownFaceDescriptors?: UnknownFaceDescriptor[], triggerReason?: string) => {
    if (!sessionId) return;

    // Skip if a message (or another detection) is in flight — activity monitor will retrigger
    if (inflightRef.current) {
      console.log(`[DualAgent] Skipping detection — ${inflightRef.current} in flight`);
      return;
    }

    inflightRef.current = "detect";

    console.log(`[DualAgent] Detection: grid ${grid ? grid.frameCount + ' frames, ' + grid.blob.size + ' bytes' : 'none'}${audioClip ? `, audio ${audioClip.size} bytes` : ""}`);

    // Cache audio clip for debug playback
    let clipId: string | null = null;
    if (audioClip && debugModeRef.current) {
      clipId = `clip-${Date.now()}`;
      const objectUrl = URL.createObjectURL(audioClip);
      const newClip: CachedAudioClip = {
        id: clipId,
        blob: audioClip,
        objectUrl,
        timestamp: Date.now(),
        status: 'collected',
        sizeBytes: audioClip.size,
        triggerReason: triggerReason || 'unknown',
      };
      setAudioClipCache(prev => {
        const next = [...prev, newClip];
        while (next.length > MAX_AUDIO_CLIP_CACHE) {
          const removed = next.shift()!;
          URL.revokeObjectURL(removed.objectUrl);
        }
        return next;
      });
    }

    const gestureContext = getGestureContextRef.current?.() || undefined;

    // Cache request for debug panel
    if (debugModeRef.current) {
      requestCache.addRequest({
        endpoint: "/detect",
        hasImage: !!grid,
        hasAudio: !!audioClip,
        hasGestureContext: !!gestureContext,
        boardSlotCount: currentBoardRef.current?.pages?.[0]?.buttons?.length || 0,
        interactionMode,
        gridFrameCount: grid?.frameCount || 0,
      });
    }

    try {
      const formData = new FormData();
      formData.append("studentId", studentId);
      formData.append("sessionId", sessionId);
      if (currentBoardRef.current) formData.append("board", JSON.stringify(currentBoardRef.current));
      if (gestureContext) formData.append("gestureContext", gestureContext);
      formData.append("interactionMode", interactionMode);
      formData.append("responseMode", responseMode);
      if (debugModeRef.current) formData.append("debugMode", "true");
      if (grid) {
        formData.append("image", grid.blob, "detect.jpg");
        // Check for dual-camera grid (has userTimestamps + envTimestamps)
        const dualGrid = grid as DualComposedGrid;
        if (dualGrid.userTimestamps && dualGrid.envTimestamps && dualGrid.envTimestamps.length > 0) {
          formData.append("frameTimestamps", JSON.stringify(dualGrid.userTimestamps));
          formData.append("envFrameTimestamps", JSON.stringify(dualGrid.envTimestamps));
        } else if (grid.timestamps.length > 0) {
          formData.append("frameTimestamps", JSON.stringify(grid.timestamps));
        }
      }
      if (audioClip) {
        const isWav = audioClip.type === "audio/wav" || audioClip.type === "audio/wave";
        formData.append("audio", audioClip, isWav ? "speech.wav" : "ambient.webm");
      }

      // Capture app canvas if drawing app is active
      if (activeApp?.appId === "drawing" && captureAppCanvasRef.current) {
        try {
          const canvasBlob = await captureAppCanvasRef.current();
          if (canvasBlob && canvasBlob.size > 0) {
            formData.append("appCanvas", canvasBlob, "drawing.png");
            console.log("[DualAgent] Attached drawing canvas:", canvasBlob.size, "bytes");
          }
        } catch (err) {
          console.warn("[DualAgent] Failed to capture drawing canvas:", err);
        }
      }

      // Include unknown face descriptors for AI-triggered enrollment
      if (unknownFaceDescriptors && unknownFaceDescriptors.length > 0) {
        formData.append("unknownFaceDescriptors", JSON.stringify(unknownFaceDescriptors));
      }

      const response = await fetchWithAuth("/api/aac/dual/detect", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        console.warn("[DualAgent] Detection request failed:", response.status);
        return;
      }

      await processSSEStream(response);
      console.log("[DualAgent] Detection stream processed");

      // Mark audio clip as sent
      if (clipId) {
        setAudioClipCache(prev => prev.map(c => c.id === clipId ? { ...c, status: 'sent' } : c));
      }
    } catch (err) {
      console.warn("[DualAgent] Detection error:", err);
    } finally {
      inflightRef.current = null;

      // Flush queued message that arrived during detection
      const queued = queuedMessageRef.current;
      if (queued) {
        queuedMessageRef.current = null;
        console.log("[DualAgent] Flushing queued message after detection:", queued.message);
        // Use setTimeout(0) to avoid calling sendMessage synchronously within the detection callback
        setTimeout(() => sendMessageRef.current(queued.message, queued.board), 0);
      }
    }
  }, [sessionId, studentId, interactionMode, responseMode, processSSEStream, activeApp]);

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
    isPlaying: streamingPlayer.isPlaying,
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

    // Avatar
    emote,
    speakingVolume: isAiVoiceRef.current ? streamingPlayer.speakingVolume : 0,

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
    startRecording,
    stopRecording,
    cancelRecording,
    setAudioEnabled,
    setVoiceEnabled,
    stopAudio,
    clearSession,
  };
}

export default useDualAgent;
