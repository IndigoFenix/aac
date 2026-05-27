// client-aac/src/contexts/DualAgentContext.tsx
// Context for the dual-agent AAC system

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import type { DualAgentMessage, IdentifiedPerson, IdentifiedFace, BoardPatch, ActiveAppData, CachedAudioClip, BinaryChoiceOption, UseDualAgentReturn } from "@/hooks/dual-agent-types";
import { useLiveSession } from "@/hooks/useLiveSession";
import type { CachedRequest } from "@/hooks/useDebugRequestCache";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useActivityMonitor } from "@/hooks/useActivityMonitor";
import { useVoiceEngagementSignal } from "@/hooks/useVoiceEngagementSignal";
import { dataFlowForState, type DataFlowConfig } from "@/lib/sleepSystemLogic";
import type { EngagementSignalKind } from "@/lib/cameraAttentivenessTypes";
import type { BufferedFrame } from "@/lib/frameRingBuffer";
import type { ParsedBoardData } from "@shared/schema";

interface DualAgentContextType {
  // Session state
  studentId: string;
  sessionId: string | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

  // Messages
  currentMessage: DualAgentMessage | null;
  transcription: string | null;
  utteranceText: string | null;
  utteranceConfidence: 'high' | 'medium' | 'low' | null;
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
  contextButtons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string; glyph?: string; glyphFallback?: string }>;

  // User-controlled mute state (cave click — AI cannot toggle this)
  muteState: 'unmuted' | 'muted';
  setMuteState: (state: 'unmuted' | 'muted') => void;
  lastModeChange: { mode: 'interact' | 'assist' | 'standby'; reason?: string; source: 'ai'; at: number } | null;

  // Response mode
  responseMode: 'fast' | 'analyze';
  setResponseMode: (mode: 'fast' | 'analyze') => void;

  // Detection — video and audio independently toggleable
  videoCaptureEnabled: boolean;
  setVideoCaptureEnabled: (enabled: boolean) => void;

  // Actions
  initialize: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  sendContextOnly: (text: string) => void;
  sendBoardExit: (label: string, instruction: string) => void;
  voiceButtons: (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => Promise<void>;
  /** Send a sentence-builder glyph to the AI for interpretation via the `interpret` tool. */
  playGlyph?: (glyphString: string) => void;
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
  setOnSetBoard: (callback: ((data: { board: ParsedBoardData; name: string; boardId: string }) => void) | null) => void;
  setOnUnloadBoard: (callback: (() => void) | null) => void;

  // Board patch (from detection)
  boardPatch: BoardPatch | null;

  // Symbol update (auto-generated symbol ready)
  symbolUpdate: { buttonLabel: string; symbolPath: string } | null;

  // AI button press (AI navigated within a loaded board)
  aiButtonPress: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null;

  // Debug
  debugData: Record<string, any>;
  requestCache: CachedRequest[];
  audioClipCache: CachedAudioClip[];
  /** Latest server-side face matching results — empty array when no faces or no descriptors recently sent. */
  identifiedFaces: IdentifiedFace[];

  // Active app
  activeApp: ActiveAppData | null;
  dismissApp: () => void;
  launchApp: (appId: string, appData?: any) => void;
  registerAppCanvasCapture: (fn: (() => Promise<Blob | null>) | null) => void;

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;

  // Binary-choice overlay — two AI-supplied SENTENCE BUTTON options + an
  // implicit "Neither". Yes/no questions are surfaced through this same
  // overlay (using the canonical `yes` / `no` SYMBOLs).
  binaryChoiceOptions: BinaryChoiceOption[] | null;
  dismissBinaryChoice: () => void;

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

  // Pause state
  paused: boolean;
  setPaused: (paused: boolean) => void;

  // Reconnection state (Live API only)
  reconnecting: boolean;
  /** Transient safety block indicator (auto-clears after 5s) */
  safetyBlocked: boolean;

  // Guessing mode
  guessingMode: boolean;
  /** Press a guessing-mode SUGGESTION button — updates narrowing state and re-injects [GUESSING STATE]. */
  pressSuggestion: (suggestionKey: string) => void;
  /** Launch guessing from the sentence builder to fill a slot. */
  enterGuessingFromBuilder: (builderContext: { targetSlot: number | null; partialGlyph: string; category: string }) => void;
  /** Notify the server the sentence builder opened/closed (conversation detour boundary). */
  setBuilderVisible: (open: boolean) => void;

  // Construction board (sentence builder)
  sendConstructionState: (state: import("@/hooks/dual-agent-types").ConstructionStateClient) => void;
  constructionSuggestions: import("@/hooks/dual-agent-types").ConstructionSuggestionsClient | null;
  constructionMemoryChips: Partial<Record<
    import("@/hooks/dual-agent-types").ConstructionStateClient["category"],
    import("@/hooks/dual-agent-types").ConstructionMemoryChipsClient
  >>;

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
  /** Per-tag pitch shift in semitones. Keys are audio tags: "avatar" (AI voice), "utterance" (student voice). */
  pitchByTag?: Record<string, number>;
}

export function DualAgentProvider(props: DualAgentProviderProps) {
  return <DualAgentProviderInner {...props} />;
}

// ---------------------------------------------------------------------------
// Inner provider: Live API mode (WebSocket to Gemini)
// ---------------------------------------------------------------------------

function DualAgentProviderInner({
  children,
  studentId,
  language = "en",
  captureFrame: captureFrameProp,
  captureEnvFrame: captureEnvFrameProp,
  getUnmatchedFaceDescriptors,
  getGestureContext,
  onBoardPatch: onBoardPatchProp,
  debugMode,
  getFaceImage: getFaceImageProp,
  pitchByTag,
}: DualAgentProviderProps) {
  const [currentBoard, setCurrentBoard] = React.useState<ParsedBoardData | null>(null);
  // Context sidebar: queue of buttons, last 4 visible. New buttons push oldest out.
  const [contextButtons, setContextButtons] = React.useState<Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string; glyph?: string; glyphFallback?: string }>>([]);
  const [boardPatch, setBoardPatch] = React.useState<BoardPatch | null>(null);
  const [symbolUpdate, setSymbolUpdate] = React.useState<{ buttonLabel: string; symbolPath: string } | null>(null);
  const [aiButtonPress, setAiButtonPress] = React.useState<{ label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null>(null);
  const onBoardUpdateRef = useRef<((board: ParsedBoardData) => void) | null>(null);
  const onSetBoardRef = useRef<((data: { board: ParsedBoardData; name: string; boardId: string }) => void) | null>(null);
  const onUnloadBoardRef = useRef<(() => void) | null>(null);

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
    onSetBoardRef.current?.(data);
    console.log(`[DualAgentContext] SET_BOARD: "${data.name}" loaded`);
  }, []);

  const handleUnloadBoard = useCallback(() => {
    onUnloadBoardRef.current?.();
    console.log(`[DualAgentContext] UNLOAD_BOARD: returning to dynamic board`);
  }, []);

  const handleAiButtonPress = useCallback((data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] }) => {
    setAiButtonPress(data);
    console.log(`[DualAgentContext] AI_BUTTON_PRESS: "${data.label}" → page "${data.targetPageName}"`);
  }, []);

  const handleSymbolUpdate = useCallback((data: { buttonLabel: string; symbolPath: string }) => {
    setSymbolUpdate(data);
    // Also apply to context sidebar buttons — they share the same labels/symbols pipeline
    setContextButtons(prev => prev.map(b =>
      b.label.toLowerCase() === data.buttonLabel.toLowerCase()
        ? { ...b, symbolPath: data.symbolPath }
        : b
    ));
  }, []);

  // Stable refs so the callback identity passed to useLiveSession doesn't change
  // when the engagement context re-renders (the score producer ticks at 10 Hz).
  const attentivenessRef = useRef(attentiveness);
  attentivenessRef.current = attentiveness;

  const handleSleepStateChange = useCallback(
    (state: import("@/lib/cameraAttentivenessTypes").SleepState, source: "ai" | "system") => {
      console.log(`[DualAgentContext] AI sleep state change → ${state} (source=${source})`);
      attentivenessRef.current?.setSleepState(state);
    },
    [],
  );

  const handleFalseWakeReport = useCallback((reason: string) => {
    console.log(`[DualAgentContext] AI report_false_wake: "${reason}"`);
    attentivenessRef.current?.reportFalseWake(reason);
  }, []);

  const liveAgent = useLiveSession({
    studentId,
    language,
    onBoardUpdate: handleBoardUpdate,
    onContextBoardUpdate: useCallback((buttonData: any) => {
      setContextButtons(prev => {
        const next = [...prev, buttonData];
        // Keep last 4 visible (but store all for potential scroll-back)
        return next.slice(-4);
      });
    }, []),
    onContextBoardRemove: useCallback((label: string) => {
      if (!label) return;
      const lower = label.toLowerCase();
      setContextButtons(prev => prev.filter(b => b.label.toLowerCase() !== lower));
    }, []),
    onBoardPatch: handleBoardPatch,
    onSetBoard: handleSetBoard,
    onUnloadBoard: handleUnloadBoard,
    onAiButtonPress: handleAiButtonPress,
    onSymbolUpdate: handleSymbolUpdate,
    onSleepStateChange: handleSleepStateChange,
    onFalseWakeReport: handleFalseWakeReport,
    autoPlayAudio: true,
    pitchByTag,
    debugMode,
    captureFrame,
    captureHighResFrame,
    getGestureContext,
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

  // Sleep system data-flow gating for PCM (and downstream consumers).
  // Refs are updated on every state/score change; handlePcmChunk reads them
  // synchronously without re-creating the callback (avoids churn on the
  // 10 Hz score producer).
  const flowRef = useRef<DataFlowConfig>(dataFlowForState("awake", 0));
  const contributionsRef = useRef<Partial<Record<EngagementSignalKind, number>>>({});
  useEffect(() => {
    if (!attentiveness) return;
    flowRef.current = dataFlowForState(
      attentiveness.sleepState,
      attentiveness.engagementScore.value,
    );
    contributionsRef.current = attentiveness.engagementScore.contributions;
  }, [attentiveness, attentiveness?.sleepState, attentiveness?.engagementScore]);

  const handlePcmChunk = useCallback((int16Base64: string) => {
    if (liveAgent.paused) return;

    const flow = flowRef.current;
    if (flow.pcmMode === "off") {
      // Asleep / Hibernation — drop. (Asleep buffer is added in T12.)
      pcmGatedCountRef.current++;
      return;
    }
    if (flow.pcmMode === "vad-gated") {
      // Resting — only forward when the audio is interesting: human speech
      // (voice contribution) OR a sudden loud sound (noise contribution).
      // Everything else (ambient hum, silence) is dropped so a quiet resting
      // session streams almost no audio. A door slam or someone addressing
      // the device still gets through and can wake the session.
      const voice = contributionsRef.current.voice ?? 0;
      const noise = contributionsRef.current.noise ?? 0;
      if (voice < 0.05 && noise < 0.05) {
        pcmGatedCountRef.current++;
        return;
      }
    }

    // continuous: existing behavior — count-only echo gate, always send.
    if (liveAgent.isBusyRef?.current) {
      pcmGatedCountRef.current++;
    } else {
      pcmSentCountRef.current++;
    }
    sendPcmAudioRef.current?.(int16Base64);
  }, [liveAgent.isBusyRef, liveAgent.paused]);

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
    enabled: (liveAgent.videoCaptureEnabled || liveAgent.voiceEnabled) && liveAgent.isInitialized && !!liveAgent.sessionId && !liveAgent.paused,
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
    // Sleep-system data-flow config: heartbeat interval, attached audio,
    // grid size, motion-trigger gating all read from this ref per-tick.
    flowConfigRef: flowRef,
  });

  // Voice + noise engagement signals for the sleep system. Independent of
  // activityMonitor (which feeds the activity-driven detection pipeline).
  // Both are computed from the same FFT analyzer for efficiency.
  const pushVoiceSignal = useCallback((intensity: number) => {
    attentiveness?.pushSignal("voice", intensity);
  }, [attentiveness]);
  const pushNoiseSignal = useCallback((intensity: number) => {
    attentiveness?.pushSignal("noise", intensity);
  }, [attentiveness]);
  const aiPlayingRef = liveAgent.isBusyRef ?? { current: false };
  useVoiceEngagementSignal({
    enabled: !!attentiveness && liveAgent.voiceEnabled && liveAgent.isInitialized && !!liveAgent.sessionId && !liveAgent.paused,
    micStream,
    isAiPlayingRef: aiPlayingRef,
    push: pushVoiceSignal,
    pushNoise: pushNoiseSignal,
  });

  // Wake-context bundle: on Asleep → Awake transition, immediately fire a
  // detection trigger so the AI sees what triggered the wake. The recent
  // buffered frames + audio are still in the ring buffers (Phase 2 keeps
  // capture running while sends are gated).
  // Also notify the server of every transition so the Insurance Bridge module
  // can subtract sleep windows from RTM service-time totals.
  const prevSleepStateRef = useRef(attentiveness?.sleepState ?? "awake");
  const notifySleepStateChangeRef = useRef(liveAgent.notifySleepStateChange);
  notifySleepStateChangeRef.current = liveAgent.notifySleepStateChange;
  useEffect(() => {
    if (!attentiveness) return;
    const prev = prevSleepStateRef.current;
    const next = attentiveness.sleepState;
    if (prev === next) return;
    if (prev === "asleep" && next === "awake") {
      console.log("[DualAgentContext] Asleep → Awake — firing wake_check trigger");
      activityMonitor.triggerNow("wake_check");
    }
    prevSleepStateRef.current = next;
    notifySleepStateChangeRef.current?.(next, "system");
  }, [attentiveness, attentiveness?.sleepState, activityMonitor]);

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

  const liveAgentSendContextOnlyRef = useRef(liveAgent.sendContextOnly);
  liveAgentSendContextOnlyRef.current = liveAgent.sendContextOnly;

  const sendContextOnly = useCallback(
    (text: string) => {
      liveAgentSendContextOnlyRef.current(text);
    },
    []
  );

  const liveAgentSendVoiceRef = useRef(liveAgent.sendVoice);
  liveAgentSendVoiceRef.current = liveAgent.sendVoice;

  const stopVoiceRecording = useCallback(async () => {
    await liveAgentSendVoiceRef.current(currentBoardRef.current || undefined);
  }, []);

  // Wrap voiceButtons so AAC button presses force-wake the sleep system
  // before delegating to the live session. Per the planning doc, AAC button
  // presses are an always-wake trigger that bypasses thresholds and dampening.
  const liveAgentVoiceRef = useRef(liveAgent.voiceButtons);
  liveAgentVoiceRef.current = liveAgent.voiceButtons;
  const voiceButtons = useCallback(
    async (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => {
      attentiveness?.triggerAlwaysWake("aacButtonPress");
      await liveAgentVoiceRef.current(recentButtons, sentences, board);
    },
    [attentiveness],
  );

  const setOnBoardUpdate = useCallback(
    (callback: ((board: ParsedBoardData) => void) | null) => {
      onBoardUpdateRef.current = callback;
    },
    []
  );

  const setOnSetBoard = useCallback(
    (callback: ((data: { board: ParsedBoardData; name: string; boardId: string }) => void) | null) => {
      onSetBoardRef.current = callback;
    },
    []
  );

  const setOnUnloadBoard = useCallback(
    (callback: (() => void) | null) => {
      onUnloadBoardRef.current = callback;
    },
    []
  );

  return (
    <ProviderShell
      studentId={studentId}
      agent={liveAgent}
      currentBoard={currentBoard}
      contextButtons={contextButtons}
      setCurrentBoard={setCurrentBoard}
      boardPatch={boardPatch}
      symbolUpdate={symbolUpdate}
      aiButtonPress={aiButtonPress}
      setOnBoardUpdate={setOnBoardUpdate}
      setOnSetBoard={setOnSetBoard}
      setOnUnloadBoard={setOnUnloadBoard}
      sendMessage={sendMessage}
      sendContextOnly={sendContextOnly}
      sendBoardExit={liveAgent.sendBoardExit}
      voiceButtons={voiceButtons}
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
  contextButtons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string; glyph?: string; glyphFallback?: string }>;
  setCurrentBoard: (board: ParsedBoardData | null) => void;
  boardPatch: BoardPatch | null;
  symbolUpdate: { buttonLabel: string; symbolPath: string } | null;
  aiButtonPress: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null;
  setOnBoardUpdate: (callback: ((board: ParsedBoardData) => void) | null) => void;
  setOnSetBoard: (callback: ((data: { board: ParsedBoardData; name: string; boardId: string }) => void) | null) => void;
  setOnUnloadBoard: (callback: (() => void) | null) => void;
  sendMessage: (message: string) => Promise<void>;
  sendContextOnly: (text: string) => void;
  sendBoardExit: (label: string, instruction: string) => void;
  voiceButtons: (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => Promise<void>;
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
  contextButtons,
  setCurrentBoard,
  boardPatch,
  symbolUpdate,
  aiButtonPress,
  setOnBoardUpdate,
  setOnSetBoard,
  setOnUnloadBoard,
  sendMessage,
  sendContextOnly,
  sendBoardExit,
  voiceButtons,
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

    currentMessage: agent.currentMessage,
    transcription: agent.transcription,
    utteranceText: agent.utteranceText,
    utteranceConfidence: agent.utteranceConfidence,
    transcriptConfidence: agent.transcriptConfidence,
    debugText: agent.debugText,

    audioEnabled: agent.audioEnabled,
    isPlaying: agent.isPlaying,
    voiceEnabled: agent.voiceEnabled,
    isRecording: agent.isRecording,
    audioLevel: agent.audioLevel,
    recordingDuration: agent.recordingDuration,

    currentBoard,
    contextButtons,

    muteState: agent.muteState,
    setMuteState: agent.setMuteState,
    lastModeChange: agent.lastModeChange,

    responseMode: agent.responseMode,
    setResponseMode: agent.setResponseMode,

    videoCaptureEnabled: agent.videoCaptureEnabled,
    setVideoCaptureEnabled: agent.setVideoCaptureEnabled,

    initialize: agent.initialize,
    sendMessage,
    sendContextOnly,
    sendBoardExit,
    voiceButtons,
    playGlyph: agent.playGlyph,
    startVoiceRecording: agent.startRecording,
    stopVoiceRecording,
    cancelVoiceRecording: agent.cancelRecording,
    setAudioEnabled: agent.setAudioEnabled,
    setVoiceEnabled: agent.setVoiceEnabled,
    stopAudio: agent.stopAudio,
    clearSession: agent.clearSession,

    setCurrentBoard,
    setOnBoardUpdate,
    setOnSetBoard,
    setOnUnloadBoard,

    boardPatch,
    symbolUpdate,
    aiButtonPress,

    debugData: agent.debugData,
    requestCache: agent.requestCache,
    audioClipCache: agent.audioClipCache,
    identifiedFaces: agent.identifiedFaces,

    activeApp: agent.activeApp,
    dismissApp: agent.dismissApp,
    launchApp: agent.launchApp,
    registerAppCanvasCapture,

    emote: agent.emote,
    speakingVolume: agent.speakingVolume,

    binaryChoiceOptions: agent.binaryChoiceOptions,
    dismissBinaryChoice: agent.dismissBinaryChoice,

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

    paused: agent.paused,
    setPaused: agent.setPaused,

    reconnecting: agent.reconnecting ?? false,
    safetyBlocked: agent.safetyBlocked ?? false,

    guessingMode: agent.guessingMode ?? false,
    pressSuggestion: agent.pressSuggestion ?? ((key: string) => {
      console.warn("[guessing] pressSuggestion is unavailable — the live session hook did not provide it (stale build?). key=", key);
    }),
    enterGuessingFromBuilder: agent.enterGuessingFromBuilder ?? (() => { /* live API not available */ }),
    setBuilderVisible: agent.setBuilderVisible ?? (() => { /* live API not available */ }),

    sendConstructionState: agent.sendConstructionState ?? (() => { /* live API not available */ }),
    constructionSuggestions: agent.constructionSuggestions ?? null,
    constructionMemoryChips: agent.constructionMemoryChips ?? {},

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

/**
 * Non-throwing variant — returns null when no DualAgentProvider is mounted.
 * Use this from components that may be rendered outside the provider (e.g. the
 * AAC board components, which are rendered whether or not dual-agent mode is
 * enabled).
 */
export function useDualAgentContextOptional(): DualAgentContextType | null {
  return useContext(DualAgentContext) ?? null;
}

export default DualAgentContext;
