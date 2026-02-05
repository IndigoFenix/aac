// client-aac/src/contexts/DualAgentContext.tsx
// Context for the dual-agent AAC system

import React, { createContext, useContext, useCallback, useEffect, useRef } from "react";
import { useDualAgent, type DualAgentMessage, type IdentifiedPerson, type BoardPatch } from "@/hooks/useDualAgent";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import type { ParsedBoardData } from "@shared/schema";

interface DualAgentContextType {
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

  // Board state
  currentBoard: ParsedBoardData | null;

  // Interaction mode
  interactionMode: 'interact' | 'silent';
  setInteractionMode: (mode: 'interact' | 'silent') => void;

  // Detection
  detectionEnabled: boolean;
  setDetectionEnabled: (enabled: boolean) => void;

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
}

export function DualAgentProvider({
  children,
  studentId,
  language = "en",
  captureFrame: captureFrameProp,
  getIdentifiedPerson,
  getGestureContext,
  onBoardPatch: onBoardPatchProp,
}: DualAgentProviderProps) {
  const [currentBoard, setCurrentBoard] = React.useState<ParsedBoardData | null>(null);
  const [boardPatch, setBoardPatch] = React.useState<BoardPatch | null>(null);
  const onBoardUpdateRef = useRef<((board: ParsedBoardData) => void) | null>(null);

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
    sessionId: dualAgent.sessionId,
    isInitialized: dualAgent.isInitialized,
    isLoading: dualAgent.isLoading,
    error: dualAgent.error,
    thinkingMode: dualAgent.thinkingMode,

    // Messages
    currentMessage: dualAgent.currentMessage,
    transcription: dualAgent.transcription,

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

    // Detection
    detectionEnabled: dualAgent.detectionEnabled,
    setDetectionEnabled: dualAgent.setDetectionEnabled,

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
