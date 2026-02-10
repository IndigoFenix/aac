// client-aac/src/contexts/DualAgentContext.tsx
// Context for the dual-agent AAC system

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { useDualAgent, type DualAgentMessage, type IdentifiedPerson, type BoardPatch, type ActiveAppData } from "@/hooks/useDualAgent";
import type { CachedRequest } from "@/hooks/useDebugRequestCache";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useActivityMonitor } from "@/hooks/useActivityMonitor";
import type { BufferedFrame } from "@/lib/frameRingBuffer";
import type { ParsedBoardData } from "@shared/schema";

interface DualAgentContextType {
  // Session state
  studentId: string;
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

  // Board state
  currentBoard: ParsedBoardData | null;

  // Interaction mode
  interactionMode: 'interact' | 'silent';
  setInteractionMode: (mode: 'interact' | 'silent') => void;

  // Response mode
  responseMode: 'fast' | 'analyze';
  setResponseMode: (mode: 'fast' | 'analyze') => void;

  // Detection — video and audio independently toggleable
  videoCaptureEnabled: boolean;
  setVideoCaptureEnabled: (enabled: boolean) => void;

  // Actions
  initialize: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  interpretButtons: (recentButtons: string[], board?: ParsedBoardData) => Promise<void>;
  startVoiceRecording: () => Promise<void>;
  stopVoiceRecording: () => Promise<void>;
  cancelVoiceRecording: () => void;
  setAudioEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  stopAudio: () => void;
  clearSession: () => void;

  // Board management
  setCurrentBoard: (board: ParsedBoardData | null) => void;
  setOnBoardUpdate: (callback: ((board: ParsedBoardData) => void) | null) => void;

  // Board patch (from detection)
  boardPatch: BoardPatch | null;

  // Debug
  debugData: Record<string, any>;
  requestCache: CachedRequest[];

  // Active app
  activeApp: ActiveAppData | null;
  dismissApp: () => void;
  registerAppCanvasCapture: (fn: (() => Promise<Blob | null>) | null) => void;

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;

  // Monitor status
  monitorError: string | null;
  monitorConsecutiveFailures: number;
}

const DualAgentContext = createContext<DualAgentContextType | null>(null);

interface DualAgentProviderProps {
  children: React.ReactNode;
  studentId: string;
  language?: string;
  /** Function to capture a camera frame - returns Blob */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to get the current identified person (from biometric recognition) */
  getIdentifiedPerson?: () => IdentifiedPerson | null;
  /** Function to get serialized gesture/expression context (face + hand events) */
  getGestureContext?: () => string | null;
  /** Callback for board patches from detection */
  onBoardPatch?: (patch: BoardPatch) => void;
  /** Enable debug mode — sends debugMode to backend, collects debug SSE events */
  debugMode?: boolean;
}

export function DualAgentProvider({
  children,
  studentId,
  language = "en",
  captureFrame: captureFrameProp,
  getIdentifiedPerson,
  getGestureContext,
  onBoardPatch: onBoardPatchProp,
  debugMode,
}: DualAgentProviderProps) {
  const [currentBoard, setCurrentBoard] = React.useState<ParsedBoardData | null>(null);
  const [boardPatch, setBoardPatch] = React.useState<BoardPatch | null>(null);
  const onBoardUpdateRef = useRef<((board: ParsedBoardData) => void) | null>(null);

  // Mic stream for activity monitor (created when detection enabled + initialized)
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Use CameraAttentivenessContext for frame capture (shares working camera stream)
  const attentiveness = useCameraAttentivenessOptional();

  // Create a captureFrame function that prefers the attentiveness context's camera
  // (which shares the same stream that motion detection uses), falling back to prop
  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    // Try attentiveness context first (uses the working camera stream)
    if (attentiveness) {
      try {
        const frame = await attentiveness.captureNow('medium');
        if (frame && frame.blob && frame.blob.size > 0) {
          return frame.blob;
        }
      } catch (err) {
        console.warn("[DualAgentContext] Attentiveness capture failed:", err);
      }
    }
    // Fall back to prop-provided captureFrame
    if (captureFrameProp) {
      return captureFrameProp();
    }
    return null;
  }, [attentiveness, captureFrameProp]);

  // Capture a BufferedFrame (with motion metadata) for the activity monitor ring buffer
  const captureBufferedFrame = useCallback(async (): Promise<BufferedFrame | null> => {
    if (attentiveness) {
      try {
        const frame = await attentiveness.captureNow('medium');
        if (frame && frame.blob && frame.blob.size > 0) {
          return {
            blob: frame.blob,
            timestamp: frame.timestamp,
            motionLevel: frame.motionLevel,
          };
        }
      } catch {
        // Fall through
      }
    }
    // Fallback: use prop captureFrame with zero motion
    if (captureFrameProp) {
      try {
        const blob = await captureFrameProp();
        if (blob && blob.size > 0) {
          return { blob, timestamp: Date.now(), motionLevel: 0 };
        }
      } catch {
        // Fall through
      }
    }
    return null;
  }, [attentiveness, captureFrameProp]);

  // Handle board updates from the agent
  const handleBoardUpdate = useCallback((board: ParsedBoardData) => {
    setCurrentBoard(board);
    onBoardUpdateRef.current?.(board);
  }, []);

  // Handle board patches from detection
  const handleBoardPatch = useCallback((patch: BoardPatch) => {
    setBoardPatch(patch);
    onBoardPatchProp?.(patch);
  }, [onBoardPatchProp]);

  // Handle thinking mode changes
  const handleThinkingModeChange = useCallback((thinking: boolean) => {
    console.log("[DualAgentContext] Thinking mode:", thinking);
  }, []);

  const dualAgent = useDualAgent({
    studentId,
    language,
    onBoardUpdate: handleBoardUpdate,
    onBoardPatch: handleBoardPatch,
    onThinkingModeChange: handleThinkingModeChange,
    autoPlayAudio: true,
    captureFrame,
    getIdentifiedPerson,
    getGestureContext,
    debugMode,
  });

  // Allow app components to register canvas capture functions
  const registerAppCanvasCapture = useCallback((fn: (() => Promise<Blob | null>) | null) => {
    dualAgent.captureAppCanvasRef.current = fn;
  }, [dualAgent.captureAppCanvasRef]);

  // Stable ref for runDetectionWithGrid (avoids re-creating activity monitor)
  const runDetectionWithGridRef = useRef(dualAgent.runDetectionWithGrid);
  runDetectionWithGridRef.current = dualAgent.runDetectionWithGrid;

  // Activity-driven trigger callback — returns the promise so the monitor can await it
  const handleActivityTrigger = useCallback(async (grid: any, audioClip: Blob | null) => {
    await runDetectionWithGridRef.current(grid, audioClip);
  }, []);

  // Manage mic stream lifecycle: acquire when audio capture (voiceEnabled) + initialized, release on disable
  useEffect(() => {
    if (!dualAgent.voiceEnabled || !dualAgent.isInitialized || !dualAgent.sessionId) {
      // Release mic if we have one
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        setMicStream(null);
        console.log("[DualAgentContext] Mic stream released");
      }
      return;
    }

    // Acquire mic
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        micStreamRef.current = stream;
        setMicStream(stream);
        console.log("[DualAgentContext] Mic stream acquired for activity monitor");
      } catch {
        console.warn("[DualAgentContext] Mic not available, running detection without audio");
      }
    })();

    return () => {
      cancelled = true;
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        setMicStream(null);
      }
    };
  }, [dualAgent.voiceEnabled, dualAgent.isInitialized, dualAgent.sessionId]);

  // Activity monitor: drives the detection pipeline (active when either video or audio is on)
  const activityMonitor = useActivityMonitor({
    enabled: (dualAgent.videoCaptureEnabled || dualAgent.voiceEnabled) && dualAgent.isInitialized && !!dualAgent.sessionId,
    videoEnabled: dualAgent.videoCaptureEnabled,
    audioEnabled: dualAgent.voiceEnabled,
    micStream,
    captureFrame: captureBufferedFrame,
    onTrigger: handleActivityTrigger,
  });

  // Wrap sendMessage to include current board
  const sendMessage = useCallback(
    async (message: string) => {
      await dualAgent.sendMessage(message, currentBoard || undefined);
    },
    [dualAgent, currentBoard]
  );

  // Wrap voice recording to include current board
  const stopVoiceRecording = useCallback(async () => {
    await dualAgent.sendVoice(currentBoard || undefined);
  }, [dualAgent, currentBoard]);

  const setOnBoardUpdate = useCallback(
    (callback: ((board: ParsedBoardData) => void) | null) => {
      onBoardUpdateRef.current = callback;
    },
    []
  );

  const value: DualAgentContextType = {
    // Session state
    studentId,
    sessionId: dualAgent.sessionId,
    isInitialized: dualAgent.isInitialized,
    isLoading: dualAgent.isLoading,
    error: dualAgent.error,
    thinkingMode: dualAgent.thinkingMode,

    // Messages
    currentMessage: dualAgent.currentMessage,
    transcription: dualAgent.transcription,
    interpretationText: dualAgent.interpretationText,
    debugText: dualAgent.debugText,

    // Audio state
    audioEnabled: dualAgent.audioEnabled,
    isPlaying: dualAgent.isPlaying,
    voiceEnabled: dualAgent.voiceEnabled,
    isRecording: dualAgent.isRecording,
    audioLevel: dualAgent.audioLevel,
    recordingDuration: dualAgent.recordingDuration,

    // Board state
    currentBoard,

    // Interaction mode
    interactionMode: dualAgent.interactionMode,
    setInteractionMode: dualAgent.setInteractionMode,

    // Response mode
    responseMode: dualAgent.responseMode,
    setResponseMode: dualAgent.setResponseMode,

    // Detection
    videoCaptureEnabled: dualAgent.videoCaptureEnabled,
    setVideoCaptureEnabled: dualAgent.setVideoCaptureEnabled,

    // Actions
    initialize: dualAgent.initialize,
    sendMessage,
    interpretButtons: dualAgent.interpretButtons,
    startVoiceRecording: dualAgent.startRecording,
    stopVoiceRecording,
    cancelVoiceRecording: dualAgent.cancelRecording,
    setAudioEnabled: dualAgent.setAudioEnabled,
    setVoiceEnabled: dualAgent.setVoiceEnabled,
    stopAudio: dualAgent.stopAudio,
    clearSession: dualAgent.clearSession,

    // Board management
    setCurrentBoard,
    setOnBoardUpdate,

    // Board patch (from detection)
    boardPatch,

    // Debug
    debugData: dualAgent.debugData,
    requestCache: dualAgent.requestCache,

    // Active app
    activeApp: dualAgent.activeApp,
    dismissApp: dualAgent.dismissApp,
    registerAppCanvasCapture,

    // Avatar
    emote: dualAgent.emote,
    speakingVolume: dualAgent.speakingVolume,

    // Monitor status
    monitorError: dualAgent.monitorError,
    monitorConsecutiveFailures: dualAgent.monitorConsecutiveFailures,
  };

  return (
    <DualAgentContext.Provider value={value}>
      {children}
    </DualAgentContext.Provider>
  );
}

export function useDualAgentContext(): DualAgentContextType {
  const context = useContext(DualAgentContext);
  if (!context) {
    throw new Error("useDualAgentContext must be used within a DualAgentProvider");
  }
  return context;
}

export default DualAgentContext;
