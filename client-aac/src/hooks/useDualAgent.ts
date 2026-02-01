// client-aac/src/hooks/useDualAgent.ts
// Hook for interacting with the dual-agent AAC system

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { fetchWithAuth } from "@/lib/queryClient";
import type { ParsedBoardData } from "@shared/schema";
import { useStreamingAudioPlayer } from "./useStreamingAudioPlayer";
import { useAudioRecorder } from "./useAudioRecorder";

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

export interface UseDualAgentOptions {
  studentId: string;
  language?: string;
  onBoardUpdate?: (board: ParsedBoardData) => void;
  onThinkingModeChange?: (thinking: boolean) => void;
  autoPlayAudio?: boolean;
  /** Function to capture a camera frame - returns Blob */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to get the current identified person (if any) */
  getIdentifiedPerson?: () => IdentifiedPerson | null;
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

  // Detection
  detectionEnabled: boolean;
  setDetectionEnabled: (enabled: boolean) => void;

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
  const { studentId, language = "en", onBoardUpdate, onThinkingModeChange, autoPlayAudio = true, captureFrame, getIdentifiedPerson } = options;
  const { user } = useAuth();

  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingMode, setThinkingMode] = useState(false);

  // Message state
  const [currentMessage, setCurrentMessage] = useState<DualAgentMessage | null>(null);
  const [transcription, setTranscription] = useState<string | null>(null);

  // Audio state
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  // Interaction mode
  const [interactionMode, setInteractionMode] = useState<'interact' | 'silent'>('interact');

  // Detection state
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const detectionInFlightRef = useRef(false);

  // Refs
  const currentBoardRef = useRef<ParsedBoardData | null>(null);

  // Audio recorder
  const audioRecorder = useAudioRecorder();

  // Streaming audio player
  const streamingPlayer = useStreamingAudioPlayer({
    autoPlay: autoPlayAudio && audioEnabled,
    onPlaybackStart: () => console.log("[DualAgent] Audio playback started"),
    onPlaybackEnd: () => console.log("[DualAgent] Audio playback ended"),
    onError: (err) => console.error("[DualAgent] Audio error:", err),
  });

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
    [audioEnabled, thinkingMode, onBoardUpdate, streamingPlayer]
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
      const response = await fetchWithAuth("/api/aac/dual/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          sessionId: sessionId || undefined,
          interactionMode,
        }),
      });

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

        let response: globalThis.Response;
        const boardData = board || currentBoardRef.current;

        if (imageBlob) {
          const formData = new FormData();
          formData.append("studentId", studentId);
          if (sessionId) formData.append("sessionId", sessionId);
          formData.append("message", message);
          if (language) formData.append("language", language);
          if (boardData) formData.append("board", JSON.stringify(boardData));
          if (identifiedPerson) formData.append("identifiedPerson", JSON.stringify(identifiedPerson));
          formData.append("interactionMode", interactionMode);
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
              interactionMode,
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
    [studentId, sessionId, language, isLoading, interactionMode, processSSEStream, captureFrame, getIdentifiedPerson]
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
        formData.append("interactionMode", interactionMode);

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
    [studentId, sessionId, language, interactionMode, audioRecorder, processSSEStream, captureFrame, getIdentifiedPerson]
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
   * Run a single detection cycle — capture camera frame and send to /detect
   */
  const runDetection = useCallback(async () => {
    if (detectionInFlightRef.current) {
      console.log("[DualAgent] Detection: skipping, request in flight");
      return;
    }
    if (!sessionId) {
      console.log("[DualAgent] Detection: skipping, no sessionId");
      return;
    }

    // Capture camera frame (optional — detection can work without image)
    let imageBlob: Blob | null = null;
    if (captureFrame) {
      try {
        imageBlob = await captureFrame();
        if (imageBlob && imageBlob.size > 0) {
          console.log("[DualAgent] Detection: captured frame,", imageBlob.size, "bytes");
        } else {
          console.log("[DualAgent] Detection: frame capture returned empty blob, proceeding without image");
          imageBlob = null;
        }
      } catch (err) {
        console.warn("[DualAgent] Detection: frame capture failed:", err);
        imageBlob = null;
      }
    } else {
      console.log("[DualAgent] Detection: no captureFrame function, proceeding without image");
    }

    detectionInFlightRef.current = true;

    try {
      // Use FormData if we have an image, otherwise JSON
      let response: globalThis.Response;

      if (imageBlob) {
        const formData = new FormData();
        formData.append("studentId", studentId);
        formData.append("sessionId", sessionId);
        if (currentBoardRef.current) formData.append("board", JSON.stringify(currentBoardRef.current));
        formData.append("interactionMode", interactionMode);
        formData.append("image", imageBlob, "detect.jpg");

        response = await fetchWithAuth("/api/aac/dual/detect", {
          method: "POST",
          body: formData,
        });
      } else {
        response = await fetchWithAuth("/api/aac/dual/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId,
            sessionId,
            board: currentBoardRef.current,
            interactionMode,
          }),
        });
      }

      if (!response.ok) {
        console.warn("[DualAgent] Detection request failed:", response.status);
        return;
      }

      const result = await response.json();
      console.log("[DualAgent] Detection result: changed =", result.changed);

      if (result.changed && result.board && onBoardUpdate) {
        console.log("[DualAgent] Detection: board updated with new buttons");
        currentBoardRef.current = result.board;
        onBoardUpdate(result.board);
      }

      // Update session ID if returned
      if (result.sessionId && !sessionId) {
        setSessionId(result.sessionId);
      }
    } catch (err) {
      console.warn("[DualAgent] Detection error:", err);
    } finally {
      detectionInFlightRef.current = false;
    }
  }, [sessionId, studentId, interactionMode, captureFrame, onBoardUpdate]);

  /**
   * Detection loop — runs every 10s when enabled
   */
  useEffect(() => {
    if (!detectionEnabled) return;
    if (!isInitialized) {
      console.log("[DualAgent] Detection: waiting for initialization");
      return;
    }
    if (!sessionId) {
      console.log("[DualAgent] Detection: waiting for sessionId");
      return;
    }

    console.log("[DualAgent] Detection loop started (sessionId:", sessionId, ")");

    // Run once immediately
    runDetection();

    const interval = setInterval(runDetection, 10000);

    return () => {
      console.log("[DualAgent] Detection loop stopped");
      clearInterval(interval);
    };
  }, [detectionEnabled, isInitialized, sessionId, runDetection]);

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
    detectionEnabled,
    setDetectionEnabled,

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
