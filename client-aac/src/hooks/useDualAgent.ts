// client-aac/src/hooks/useDualAgent.ts
// Hook for interacting with the dual-agent AAC system

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { fetchWithAuth } from "@/lib/queryClient";
import type { ParsedBoardData } from "@shared/schema";
import { useStreamingAudioPlayer } from "./useStreamingAudioPlayer";
import { useAudioRecorder } from "./useAudioRecorder";
import { prepareFrameForAI } from "@/lib/prepareFrameForAI";
import type { ComposedGrid } from "@/lib/composeFrameGrid";
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
  type: "student" | "user";
  name: string;
  relationship?: string;
  confidence: number;
  method: "face" | "voice" | "both";
}

export interface BoardPatch {
  add: Array<{ label: string; iconRef: string }>;
  remove: string[];
  rebuild?: Array<{ label: string; iconRef: string }>; // full board replacement
}

export interface UseDualAgentOptions {
  studentId: string;
  language?: string;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  onBoardPatch?: (patch: BoardPatch) => void;
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

  // Detection — video and audio can be toggled independently
  videoCaptureEnabled: boolean;
  setVideoCaptureEnabled: (enabled: boolean) => void;
  /** Activity-driven detection: send composite grid + audio clip */
  runDetectionWithGrid: (grid: ComposedGrid | null, audioClip: Blob | null) => Promise<void>;

  // Debug
  debugData: Record<string, any>;
  requestCache: CachedRequest[];

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
}

export function useDualAgent(options: UseDualAgentOptions): UseDualAgentReturn {
  const { studentId, language = "en", onBoardUpdate, onBoardPatch, onThinkingModeChange, autoPlayAudio = true, captureFrame, getIdentifiedPerson, getGestureContext, debugMode = false } = options;
  const { user } = useAuth();

  // Debug state
  const [debugData, setDebugData] = useState<Record<string, any>>({});
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
  const [debugText, setDebugText] = useState<string | null>(null);

  // Audio state
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  // Interaction mode
  const [interactionMode, setInteractionMode] = useState<'interact' | 'silent'>('interact');

  // Video capture state (enabled by default - only sends data after initialized)
  const [videoCaptureEnabled, setVideoCaptureEnabled] = useState(true);

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
  }, [studentId, sessionId, isLoading, interactionMode, processSSEStream]);

  /**
   * Send a text message (with optional camera frame)
   */
  const sendMessage = useCallback(
    async (message: string, board?: ParsedBoardData) => {
      if (isLoading || !message.trim()) return;

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
        setIsLoading(false);
      }
    },
    [studentId, sessionId, language, isLoading, interactionMode, processSSEStream, captureFrame, getIdentifiedPerson, getGestureContext]
  );

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
    [studentId, sessionId, language, interactionMode, audioRecorder, processSSEStream, captureFrame, getIdentifiedPerson, getGestureContext]
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
  const runDetectionWithGrid = useCallback(async (grid: ComposedGrid | null, audioClip: Blob | null) => {
    if (!sessionId) return;

    console.log(`[DualAgent] Detection: grid ${grid ? grid.frameCount + ' frames, ' + grid.blob.size + ' bytes' : 'none'}${audioClip ? `, audio ${audioClip.size} bytes` : ""}`);

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
      if (debugModeRef.current) formData.append("debugMode", "true");
      if (grid) {
        formData.append("image", grid.blob, "detect.jpg");
        if (grid.timestamps.length > 0) {
          formData.append("frameTimestamps", JSON.stringify(grid.timestamps));
        }
      }
      if (audioClip) formData.append("audio", audioClip, "ambient.webm");

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
    } catch (err) {
      console.warn("[DualAgent] Detection error:", err);
    }
  }, [sessionId, studentId, interactionMode, processSSEStream]);

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

    // Detection
    videoCaptureEnabled,
    setVideoCaptureEnabled,
    runDetectionWithGrid,

    // Debug
    debugData,
    requestCache: requestCache.cache,

    // Monitor status
    monitorError,
    monitorConsecutiveFailures,

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
