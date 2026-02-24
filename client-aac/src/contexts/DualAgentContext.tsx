// client-aac/src/contexts/DualAgentContext.tsx
// Context for the dual-agent AAC system

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { useDualAgent, type DualAgentMessage, type IdentifiedPerson, type BoardPatch, type ActiveAppData, type CachedAudioClip, type UseDualAgentReturn } from "@/hooks/useDualAgent";
import { useLiveSession } from "@/hooks/useLiveSession";
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

  // AI button press (AI navigated within a loaded board)
  aiButtonPress: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null;

  // Debug
  debugData: Record<string, any>;
  requestCache: CachedRequest[];
  audioClipCache: CachedAudioClip[];

  // Active app
  activeApp: ActiveAppData | null;
  dismissApp: () => void;
  registerAppCanvasCapture: (fn: (() => Promise<Blob | null>) | null) => void;

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;

  // Yes/No overlay
  yesNoActive: boolean;
  dismissYesNo: () => void;

  // Focus frame
  /** True while a focus frame is being captured (glasses overlay) */
  focusActive: boolean;

  // Face image cache
  getFaceImage: (contactId: string) => string | null;

  // Monitor status
  monitorError: string | null;
  monitorConsecutiveFailures: number;

  // Audio activity state (from activity monitor)
  audioActivity: {
    isSpeaking: boolean;
    energyLevel: number;
    speechMethod: 'webSpeechApi' | 'energy' | 'none';
    lastSpeechBoundary: { start: number; end: number } | null;
    lastTriggerReason: string | null;
    ringBufferSamples: number;
  };

  // Reconnection state (Live API only)
  reconnecting: boolean;
  /** Transient safety block indicator (auto-clears after 5s) */
  safetyBlocked: boolean;

  // PCM gating debug (Live API only)
  pcmDebug: {
    /** Whether mic PCM is currently blocked (isBusyRef from audio player) */
    audioBusy: boolean;
    /** Whether audio is actively playing (React state) */
    isPlaying: boolean;
    /** Total PCM chunks sent to Gemini */
    sentCount: number;
    /** Total PCM chunks blocked by gate */
    gatedCount: number;
  };
}

const DualAgentContext = createContext<DualAgentContextType | null>(null);

interface DualAgentProviderProps {
  children: React.ReactNode;
  studentId: string;
  language?: string;
  /** Function to capture a camera frame - returns Blob */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to capture a frame from the environment camera (optional) */
  captureEnvFrame?: () => Promise<BufferedFrame | null>;
  /** Function to get the current identified person (from biometric recognition) */
  getIdentifiedPerson?: () => IdentifiedPerson | null;
  /** Function to get serialized gesture/expression context (face + hand events) */
  getGestureContext?: () => string | null;
  /** Function to get unmatched face descriptors for AI-triggered enrollment */
  getUnmatchedFaceDescriptors?: () => Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }>;
  /** Callback for board patches from detection */
  onBoardPatch?: (patch: BoardPatch) => void;
  /** Enable debug mode — sends debugMode to backend, collects debug SSE events */
  debugMode?: boolean;
  /** Client-side face image cache lookup */
  getFaceImage?: (contactId: string) => string | null;
  /** Use Gemini Live API (WebSocket) instead of HTTP request-response */
  useLiveApi?: boolean;
}

export function DualAgentProvider(props: DualAgentProviderProps) {
  // Delegate to the correct inner component based on useLiveApi flag.
  // This avoids conditional hook calls (React rules of hooks).
  if (props.useLiveApi) {
    return <LiveApiProviderInner {...props} />;
  }
  return <HttpProviderInner {...props} />;
}

// ---------------------------------------------------------------------------
// Inner provider: HTTP mode (existing request-response pipeline)
// ---------------------------------------------------------------------------

function HttpProviderInner({
  children,
  studentId,
  language = "en",
  captureFrame: captureFrameProp,
  captureEnvFrame: captureEnvFrameProp,
  getIdentifiedPerson,
  getGestureContext,
  getUnmatchedFaceDescriptors,
  onBoardPatch: onBoardPatchProp,
  debugMode,
  getFaceImage: getFaceImageProp,
}: DualAgentProviderProps) {
  const [currentBoard, setCurrentBoard] = React.useState<ParsedBoardData | null>(null);
  const [boardPatch, setBoardPatch] = React.useState<BoardPatch | null>(null);
  const [aiButtonPress, setAiButtonPress] = React.useState<{ label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null>(null);
  const onBoardUpdateRef = useRef<((board: ParsedBoardData) => void) | null>(null);

  // Mic stream for activity monitor (created when detection enabled + initialized)
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Use CameraAttentivenessContext for frame capture (shares working camera stream)
  const attentiveness = useCameraAttentivenessOptional();

  // Create a captureFrame function that prefers the attentiveness context's camera
  const captureFrame = useCallback(async (): Promise<Blob | null> => {
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

  // Capture a high-resolution frame for AI focus analysis (640x480, JPEG 0.9)
  const captureHighResFrame = useCallback(async (): Promise<Blob | null> => {
    if (attentiveness) {
      try {
        const frame = await attentiveness.captureNow('high');
        if (frame && frame.blob && frame.blob.size > 0) {
          return frame.blob;
        }
      } catch (err) {
        console.warn("[DualAgentContext] High-res capture failed:", err);
      }
    }
    // Fallback to normal capture if attentiveness not available
    if (captureFrameProp) {
      return captureFrameProp();
    }
    return null;
  }, [attentiveness, captureFrameProp]);

  const handleBoardUpdate = useCallback((board: ParsedBoardData) => {
    setCurrentBoard(board);
    onBoardUpdateRef.current?.(board);
  }, []);

  const handleBoardPatch = useCallback((patch: BoardPatch) => {
    setBoardPatch(patch);
    onBoardPatchProp?.(patch);
  }, [onBoardPatchProp]);

  const handleSetBoard = useCallback((data: { board: ParsedBoardData; name: string; boardId: string }) => {
    // When AI selects a pre-built board, update the current board state
    setCurrentBoard(data.board);
    onBoardUpdateRef.current?.(data.board);
    console.log(`[DualAgentContext] SET_BOARD: "${data.name}" loaded`);
  }, []);

  const handleAiButtonPress = useCallback((data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => {
    setAiButtonPress(data);
    console.log(`[DualAgentContext] AI_BUTTON_PRESS: "${data.label}" → page "${data.targetPageName}"`);
  }, []);

  const handleThinkingModeChange = useCallback((thinking: boolean) => {
    console.log("[DualAgentContext] Thinking mode:", thinking);
  }, []);

  const dualAgent = useDualAgent({
    studentId,
    language,
    onBoardUpdate: handleBoardUpdate,
    onBoardPatch: handleBoardPatch,
    onSetBoard: handleSetBoard,
    onAiButtonPress: handleAiButtonPress,
    onThinkingModeChange: handleThinkingModeChange,
    autoPlayAudio: true,
    captureFrame,
    captureHighResFrame,
    getIdentifiedPerson,
    getGestureContext,
    debugMode,
  });

  const registerAppCanvasCapture = useCallback((fn: (() => Promise<Blob | null>) | null) => {
    dualAgent.captureAppCanvasRef.current = fn;
  }, [dualAgent.captureAppCanvasRef]);

  const runDetectionWithGridRef = useRef(dualAgent.runDetectionWithGrid);
  runDetectionWithGridRef.current = dualAgent.runDetectionWithGrid;

  const getUnmatchedFaceDescriptorsRef = useRef(getUnmatchedFaceDescriptors);
  getUnmatchedFaceDescriptorsRef.current = getUnmatchedFaceDescriptors;

  const handleActivityTrigger = useCallback(async (grid: any, audioClip: Blob | null, triggerReason: string) => {
    const unknownDescriptors = getUnmatchedFaceDescriptorsRef.current?.() || undefined;
    await runDetectionWithGridRef.current(grid, audioClip, unknownDescriptors, triggerReason);
  }, []);

  // Manage mic stream lifecycle
  useEffect(() => {
    if (!dualAgent.voiceEnabled || !dualAgent.isInitialized || !dualAgent.sessionId) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        setMicStream(null);
      }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        micStreamRef.current = stream;
        setMicStream(stream);
      } catch {
        console.warn("[DualAgentContext] Mic not available");
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

  const activityMonitor = useActivityMonitor({
    enabled: (dualAgent.videoCaptureEnabled || dualAgent.voiceEnabled) && dualAgent.isInitialized && !!dualAgent.sessionId,
    videoEnabled: dualAgent.videoCaptureEnabled,
    audioEnabled: dualAgent.voiceEnabled,
    micStream,
    captureFrame: captureBufferedFrame,
    captureEnvFrame: captureEnvFrameProp,
    onTrigger: handleActivityTrigger,
  });

  // Stabilize sendMessage identity — use refs so the callback doesn't change on every render
  const dualAgentSendRef = useRef(dualAgent.sendMessage);
  dualAgentSendRef.current = dualAgent.sendMessage;
  const currentBoardRef = useRef(currentBoard);
  currentBoardRef.current = currentBoard;

  const sendMessage = useCallback(
    async (message: string) => {
      await dualAgentSendRef.current(message, currentBoardRef.current || undefined);
    },
    []
  );

  const dualAgentSendVoiceRef = useRef(dualAgent.sendVoice);
  dualAgentSendVoiceRef.current = dualAgent.sendVoice;

  const stopVoiceRecording = useCallback(async () => {
    await dualAgentSendVoiceRef.current(currentBoardRef.current || undefined);
  }, []);

  const setOnBoardUpdate = useCallback(
    (callback: ((board: ParsedBoardData) => void) | null) => {
      onBoardUpdateRef.current = callback;
    },
    []
  );

  return (
    <ProviderShell
      studentId={studentId}
      agent={dualAgent}
      currentBoard={currentBoard}
      setCurrentBoard={setCurrentBoard}
      boardPatch={boardPatch}
      aiButtonPress={aiButtonPress}
      setOnBoardUpdate={setOnBoardUpdate}
      sendMessage={sendMessage}
      stopVoiceRecording={stopVoiceRecording}
      registerAppCanvasCapture={registerAppCanvasCapture}
      getFaceImage={getFaceImageProp ?? (() => null)}
      activityMonitor={activityMonitor}
    >
      {children}
    </ProviderShell>
  );
}

// ---------------------------------------------------------------------------
// Inner provider: Live API mode (WebSocket to Gemini)
// ---------------------------------------------------------------------------

function LiveApiProviderInner({
  children,
  studentId,
  language = "en",
  captureFrame: captureFrameProp,
  captureEnvFrame: captureEnvFrameProp,
  getUnmatchedFaceDescriptors,
  onBoardPatch: onBoardPatchProp,
  debugMode,
  getFaceImage: getFaceImageProp,
}: DualAgentProviderProps) {
  const [currentBoard, setCurrentBoard] = React.useState<ParsedBoardData | null>(null);
  const [boardPatch, setBoardPatch] = React.useState<BoardPatch | null>(null);
  const [aiButtonPress, setAiButtonPress] = React.useState<{ label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null>(null);
  const onBoardUpdateRef = useRef<((board: ParsedBoardData) => void) | null>(null);

  // Mic stream for activity monitor
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const attentiveness = useCameraAttentivenessOptional();

  // Capture a camera frame for initial image on startup
  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    if (attentiveness) {
      try {
        const frame = await attentiveness.captureNow('medium');
        if (frame && frame.blob && frame.blob.size > 0) {
          return frame.blob;
        }
      } catch { /* fall through */ }
    }
    if (captureFrameProp) {
      return captureFrameProp();
    }
    return null;
  }, [attentiveness, captureFrameProp]);

  const captureBufferedFrame = useCallback(async (): Promise<BufferedFrame | null> => {
    if (attentiveness) {
      try {
        const frame = await attentiveness.captureNow('medium');
        if (frame && frame.blob && frame.blob.size > 0) {
          return { blob: frame.blob, timestamp: frame.timestamp, motionLevel: frame.motionLevel };
        }
      } catch { /* fall through */ }
    }
    if (captureFrameProp) {
      try {
        const blob = await captureFrameProp();
        if (blob && blob.size > 0) {
          return { blob, timestamp: Date.now(), motionLevel: 0 };
        }
      } catch { /* fall through */ }
    }
    return null;
  }, [attentiveness, captureFrameProp]);

  // Capture a high-resolution frame for AI focus analysis (640x480, JPEG 0.9)
  const captureHighResFrame = useCallback(async (): Promise<Blob | null> => {
    if (attentiveness) {
      try {
        const frame = await attentiveness.captureNow('high');
        if (frame && frame.blob && frame.blob.size > 0) {
          return frame.blob;
        }
      } catch (err) {
        console.warn("[DualAgentContext] High-res capture failed:", err);
      }
    }
    if (captureFrameProp) {
      return captureFrameProp();
    }
    return null;
  }, [attentiveness, captureFrameProp]);

  const handleBoardUpdate = useCallback((board: ParsedBoardData) => {
    setCurrentBoard(board);
    onBoardUpdateRef.current?.(board);
  }, []);

  const handleBoardPatch = useCallback((patch: BoardPatch) => {
    setBoardPatch(patch);
    onBoardPatchProp?.(patch);
  }, [onBoardPatchProp]);

  const handleSetBoard = useCallback((data: { board: ParsedBoardData; name: string; boardId: string }) => {
    setCurrentBoard(data.board);
    onBoardUpdateRef.current?.(data.board);
    console.log(`[DualAgentContext] SET_BOARD: "${data.name}" loaded`);
  }, []);

  const handleAiButtonPress = useCallback((data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => {
    setAiButtonPress(data);
    console.log(`[DualAgentContext] AI_BUTTON_PRESS: "${data.label}" → page "${data.targetPageName}"`);
  }, []);

  const liveAgent = useLiveSession({
    studentId,
    language,
    onBoardUpdate: handleBoardUpdate,
    onBoardPatch: handleBoardPatch,
    onSetBoard: handleSetBoard,
    onAiButtonPress: handleAiButtonPress,
    autoPlayAudio: true,
    debugMode,
    captureFrame,
    captureHighResFrame,
  });

  const registerAppCanvasCapture = useCallback((fn: (() => Promise<Blob | null>) | null) => {
    liveAgent.captureAppCanvasRef.current = fn;
  }, [liveAgent.captureAppCanvasRef]);

  const runDetectionWithGridRef = useRef(liveAgent.runDetectionWithGrid);
  runDetectionWithGridRef.current = liveAgent.runDetectionWithGrid;

  const getUnmatchedFaceDescriptorsRef = useRef(getUnmatchedFaceDescriptors);
  getUnmatchedFaceDescriptorsRef.current = getUnmatchedFaceDescriptors;

  const handleActivityTrigger = useCallback(async (grid: any, audioClip: Blob | null, triggerReason: string) => {
    const unknownDescriptors = getUnmatchedFaceDescriptorsRef.current?.() || undefined;
    await runDetectionWithGridRef.current(grid, audioClip, unknownDescriptors, triggerReason);
  }, []);

  // Mic stream lifecycle
  useEffect(() => {
    if (!liveAgent.voiceEnabled || !liveAgent.isInitialized || !liveAgent.sessionId) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        setMicStream(null);
      }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Request echo cancellation + noise suppression to reduce TTS feedback
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        micStreamRef.current = stream;
        setMicStream(stream);
      } catch {
        console.warn("[DualAgentContext] Mic not available");
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
  }, [liveAgent.voiceEnabled, liveAgent.isInitialized, liveAgent.sessionId]);

  // PCM streaming callback — send raw audio to Gemini Live API via WebSocket.
  // Gated: mute PCM while TTS is playing to prevent echo/feedback loop.
  // Uses isBusyRef from the audio player — a synchronous ref that's true from
  // the moment audio is queued until POST_PLAY_TAIL_MS after the last chunk finishes.
  // This avoids React state propagation delay and covers post-playback room echo.
  const sendPcmAudioRef = useRef(liveAgent.sendPcmAudio);
  sendPcmAudioRef.current = liveAgent.sendPcmAudio;

  // PCM debug counters (refs for perf, polled into state below)
  const pcmSentCountRef = useRef(0);
  const pcmGatedCountRef = useRef(0);
  const [pcmDebug, setPcmDebug] = useState({ audioBusy: false, isPlaying: false, sentCount: 0, gatedCount: 0 });

  const handlePcmChunk = useCallback((int16Base64: string) => {
    // PCM gating disabled — relying on Gemini echo awareness prompt instead.
    // Keeping counters for debug visibility.
    if (liveAgent.isBusyRef?.current) {
      pcmGatedCountRef.current++;
    } else {
      pcmSentCountRef.current++;
    }
    // Always send — let Gemini handle echo recognition
    sendPcmAudioRef.current?.(int16Base64);
  }, [liveAgent.isBusyRef]);

  // Poll isBusyRef + counters into state every 200ms for the debug panel
  useEffect(() => {
    const id = setInterval(() => {
      setPcmDebug({
        audioBusy: !!liveAgent.isBusyRef?.current,
        isPlaying: liveAgent.isPlaying,
        sentCount: pcmSentCountRef.current,
        gatedCount: pcmGatedCountRef.current,
      });
    }, 200);
    return () => clearInterval(id);
  }, [liveAgent.isBusyRef, liveAgent.isPlaying]);

  const activityMonitor = useActivityMonitor({
    enabled: (liveAgent.videoCaptureEnabled || liveAgent.voiceEnabled) && liveAgent.isInitialized && !!liveAgent.sessionId,
    videoEnabled: liveAgent.videoCaptureEnabled,
    audioEnabled: liveAgent.voiceEnabled,
    micStream,
    captureFrame: captureBufferedFrame,
    captureEnvFrame: captureEnvFrameProp,
    onTrigger: handleActivityTrigger,
    // Stream raw PCM audio to Gemini Live API (continuous mic → WebSocket → Gemini)
    onPcmChunk: handlePcmChunk,
    // In Live mode, audio goes via continuous PCM — frame grids are decoupled
    // from speech activity. Only motion settle + heartbeat trigger frame sends.
    options: { speechTriggerEnabled: false },
  });

  // Stabilize sendMessage identity — use refs so the callback doesn't change on every render
  const liveAgentSendRef = useRef(liveAgent.sendMessage);
  liveAgentSendRef.current = liveAgent.sendMessage;
  const currentBoardRef = useRef(currentBoard);
  currentBoardRef.current = currentBoard;

  const sendMessage = useCallback(
    async (message: string) => {
      await liveAgentSendRef.current(message, currentBoardRef.current || undefined);
    },
    []
  );

  const liveAgentSendVoiceRef = useRef(liveAgent.sendVoice);
  liveAgentSendVoiceRef.current = liveAgent.sendVoice;

  const stopVoiceRecording = useCallback(async () => {
    await liveAgentSendVoiceRef.current(currentBoardRef.current || undefined);
  }, []);

  const setOnBoardUpdate = useCallback(
    (callback: ((board: ParsedBoardData) => void) | null) => {
      onBoardUpdateRef.current = callback;
    },
    []
  );

  return (
    <ProviderShell
      studentId={studentId}
      agent={liveAgent}
      currentBoard={currentBoard}
      setCurrentBoard={setCurrentBoard}
      boardPatch={boardPatch}
      aiButtonPress={aiButtonPress}
      setOnBoardUpdate={setOnBoardUpdate}
      sendMessage={sendMessage}
      stopVoiceRecording={stopVoiceRecording}
      registerAppCanvasCapture={registerAppCanvasCapture}
      getFaceImage={getFaceImageProp ?? (() => null)}
      activityMonitor={activityMonitor}
      pcmDebug={pcmDebug}
    >
      {children}
    </ProviderShell>
  );
}

// ---------------------------------------------------------------------------
// Shared provider shell — builds context value from agent + activity monitor
// ---------------------------------------------------------------------------

interface ProviderShellProps {
  children: React.ReactNode;
  studentId: string;
  agent: UseDualAgentReturn;
  currentBoard: ParsedBoardData | null;
  setCurrentBoard: (board: ParsedBoardData | null) => void;
  boardPatch: BoardPatch | null;
  aiButtonPress: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null;
  setOnBoardUpdate: (callback: ((board: ParsedBoardData) => void) | null) => void;
  sendMessage: (message: string) => Promise<void>;
  stopVoiceRecording: () => Promise<void>;
  registerAppCanvasCapture: (fn: (() => Promise<Blob | null>) | null) => void;
  getFaceImage: (contactId: string) => string | null;
  activityMonitor: {
    isSpeaking: boolean;
    energyLevel: number;
    speechMethod: 'webSpeechApi' | 'energy' | 'none';
    lastSpeechBoundary: { start: number; end: number } | null;
    lastTriggerReason: string | null;
    ringBufferSamples: number;
  };
  pcmDebug?: {
    audioBusy: boolean;
    isPlaying: boolean;
    sentCount: number;
    gatedCount: number;
  };
}

function ProviderShell({
  children,
  studentId,
  agent,
  currentBoard,
  setCurrentBoard,
  boardPatch,
  aiButtonPress,
  setOnBoardUpdate,
  sendMessage,
  stopVoiceRecording,
  registerAppCanvasCapture,
  getFaceImage,
  activityMonitor,
  pcmDebug: pcmDebugProp,
}: ProviderShellProps) {
  const value: DualAgentContextType = {
    studentId,
    sessionId: agent.sessionId,
    isInitialized: agent.isInitialized,
    isLoading: agent.isLoading,
    error: agent.error,
    thinkingMode: agent.thinkingMode,

    currentMessage: agent.currentMessage,
    transcription: agent.transcription,
    interpretationText: agent.interpretationText,
    interpretConfidence: agent.interpretConfidence,
    transcriptConfidence: agent.transcriptConfidence,
    debugText: agent.debugText,

    audioEnabled: agent.audioEnabled,
    isPlaying: agent.isPlaying,
    voiceEnabled: agent.voiceEnabled,
    isRecording: agent.isRecording,
    audioLevel: agent.audioLevel,
    recordingDuration: agent.recordingDuration,

    currentBoard,

    interactionMode: agent.interactionMode,
    setInteractionMode: agent.setInteractionMode,

    responseMode: agent.responseMode,
    setResponseMode: agent.setResponseMode,

    videoCaptureEnabled: agent.videoCaptureEnabled,
    setVideoCaptureEnabled: agent.setVideoCaptureEnabled,

    initialize: agent.initialize,
    sendMessage,
    interpretButtons: agent.interpretButtons,
    startVoiceRecording: agent.startRecording,
    stopVoiceRecording,
    cancelVoiceRecording: agent.cancelRecording,
    setAudioEnabled: agent.setAudioEnabled,
    setVoiceEnabled: agent.setVoiceEnabled,
    stopAudio: agent.stopAudio,
    clearSession: agent.clearSession,

    setCurrentBoard,
    setOnBoardUpdate,

    boardPatch,
    aiButtonPress,

    debugData: agent.debugData,
    requestCache: agent.requestCache,
    audioClipCache: agent.audioClipCache,

    activeApp: agent.activeApp,
    dismissApp: agent.dismissApp,
    registerAppCanvasCapture,

    emote: agent.emote,
    speakingVolume: agent.speakingVolume,

    yesNoActive: agent.yesNoActive,
    dismissYesNo: agent.dismissYesNo,

    focusActive: agent.focusActive,

    getFaceImage,

    monitorError: agent.monitorError,
    monitorConsecutiveFailures: agent.monitorConsecutiveFailures,

    audioActivity: {
      isSpeaking: activityMonitor.isSpeaking,
      energyLevel: activityMonitor.energyLevel,
      speechMethod: activityMonitor.speechMethod,
      lastSpeechBoundary: activityMonitor.lastSpeechBoundary,
      lastTriggerReason: activityMonitor.lastTriggerReason,
      ringBufferSamples: activityMonitor.ringBufferSamples,
    },

    reconnecting: agent.reconnecting ?? false,
    safetyBlocked: agent.safetyBlocked ?? false,

    pcmDebug: pcmDebugProp ?? { audioBusy: false, isPlaying: false, sentCount: 0, gatedCount: 0 },
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
