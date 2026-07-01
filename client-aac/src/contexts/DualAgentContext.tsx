// client-aac/src/contexts/DualAgentContext.tsx
// Context for the dual-agent AAC system

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import type { DualAgentMessage, IdentifiedPerson, IdentifiedFace, BoardPatch, ActiveAppData, CachedAudioClip, BinaryChoiceOption, UseDualAgentReturn } from "@/hooks/dual-agent-types";
import { STT_ENGINE, STT_MODE } from "@/hooks/dual-agent-types";
import { analyzeVoicePitch } from "@/lib/voiceFeatures";
import { useLiveSession } from "@/hooks/useLiveSession";
import type { CachedRequest } from "@/hooks/useDebugRequestCache";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useActivityMonitor } from "@/hooks/useActivityMonitor";
import { useVoiceEngagementSignal } from "@/hooks/useVoiceEngagementSignal";
import { dataFlowForState, type DataFlowConfig } from "@/lib/sleepSystemLogic";
import { sustainedVocalization, DEFAULT_VOCAL_CUE, type AudioEnergySample } from "@shared/aac/audio-cue";
import type { EngagementSignalKind } from "@/lib/cameraAttentivenessTypes";
import type { BufferedFrame } from "@/lib/frameRingBuffer";
import type { ParsedBoardData } from "@shared/schema";

/** Delay before firing the one-shot startup detection trigger. This is now a
 *  BACKUP first frame — the server already forwards the client's initialFrame
 *  (sent with the initialize message) to the Observer immediately. We still
 *  fire a fresh detection shortly after so frames flow even if initialFrame was
 *  unavailable; short enough that startup stays responsive, long enough for the
 *  frame ring buffer to fill and the eager identification pass to run. */
const STARTUP_DETECTION_DELAY_MS = 600;

/** VAD gate tuning for `pcmMode === "vad-gated"` (Full Attention Mode off).
 *  PCM_PREROLL_MS of recent mic chunks are kept buffered so that when the gate
 *  opens we can replay the utterance onset captured BEFORE the voice signal
 *  ramped past threshold — otherwise the first ~0.5s of every gated utterance
 *  is dropped, which is what made gated dialogue feel clipped. The gate is also
 *  held open for VAD_HANGOVER_MS after the last voice/noise so brief inter-word
 *  pauses don't re-clip mid-sentence. */
const PCM_PREROLL_MS = 600;
const VAD_GATE_THRESHOLD = 0.05;
const VAD_HANGOVER_MS = 1000;

/** Current VAD gate state, surfaced to the debug panel. */
export type PcmGateState = "open" | "vad-blocked" | "off" | "continuous";

/** Read a Blob as base64 (no data-URL prefix). Returns "" on failure. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onloadend = () => resolve(((r.result as string) || "").split(",")[1] || "");
    r.onerror = () => resolve("");
    r.readAsDataURL(blob);
  });
}

interface DualAgentContextType {
  // Session state
  studentId: string;
  sessionId: string | null;
  isInitialized: boolean;
  isLoading: boolean;
  /** Pre-`initialized` startup phase, for the localized waking-up subtitle. */
  startupStage: "connecting" | "checkingNotes" | "planningSession" | "loadingApps" | "wakingUp";
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
  /** A MediaStream of the AAC's synthesized voice (all TTS paths), to send over a
   *  call so the student's button-press speech reaches the other side. */
  getCallAudioStream: () => MediaStream | null;
  isPlaying: boolean;
  audioPlayingTag: string | null;
  voiceEnabled: boolean;
  isRecording: boolean;
  audioLevel: number;
  recordingDuration: number;
  /** True when a live microphone stream is actually acquired. False means the
   *  mic is off (voice disabled) OR not working (acquisition failed) — both map
   *  to the "microphone off" indicator. */
  micActive: boolean;
  /** Increments each time a real camera frame/snapshot is sent (frame_grid /
   *  focus_frame). The avatar blinks on each change. */
  snapshotTick: number;

  // Board state
  currentBoard: ParsedBoardData | null;
  contextButtons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string; glyph?: string; glyphFallback?: string }>;
  /** Experiment (glyphInputTranslation): per-sentence glyph-string translation
   *  of the speech last directed at the user, for the header strip. Sticky —
   *  only replaced when new incoming speech is translated. */
  inputGlyphs: Array<{ glyph: string; fallback?: string }> | null;

  // User-controlled mute state (cave click — AI cannot toggle this)
  muteState: 'unmuted' | 'muted';
  setMuteState: (state: 'unmuted' | 'muted') => void;
  lastModeChange: { mode: 'companion' | 'facilitator' | 'standby'; reason?: string; source: 'ai'; at: number } | null;

  /** AAC token-budget level for the energy bar (binding window % + band).
   *  null when the session doesn't track a budget (full-attention) or before
   *  the first server push. */
  budget: { percent: number; band: 'high' | 'moderate' | 'low'; window: string | null } | null;

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
  debugSetBudget: (percent: number) => void;
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
  /** Report that a face match was wrong so the server penalizes the bad embedding. */
  correctIdentity: (entityType: "student" | "user" | "contact", entityId: string, reason?: string) => void;

  // Active app
  activeApp: ActiveAppData | null;
  dismissApp: () => void;
  launchApp: (appId: string, appData?: any) => void;
  /** Ask the server to resolve startup params then open the app (for apps with
   *  needsStartupResolution). Replies via the normal app_open message. */
  requestAppOpen: (appId: string, appData?: any) => void;
  /** appId currently awaiting a request_app_open round-trip, or null. */
  appOpenPending: string | null;
  registerAppCanvasCapture: (fn: (() => Promise<Blob | null>) | null) => void;
  /** Built-in apps enabled for this session — drives the static Apps board overlay. */
  enabledApps: Array<{ id: string; name: string; icon: string; needsStartupResolution?: boolean }>;
  /** Custom apps (clinician-authored games) assigned to this student. */
  availableCustomApps: Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>;

  // Avatar
  emote: "happy" | "sad" | "neutral";
  speakingVolume: number;
  /** Bumps every time Speaker emits a private_note. Components key
   *  question-mark animations off this so each note re-triggers the
   *  pop-in. */
  thinkingPulse: number;

  // Binary-choice overlay — two AI-supplied SENTENCE BUTTON options + an
  // implicit "Neither". Yes/no questions are surfaced through this same
  // overlay (using the canonical `yes` / `no` SYMBOLs).
  binaryChoiceOptions: BinaryChoiceOption[] | null;
  /** Server-supplied escape-button kind: "maybe" (yellow) when the pair
   *  forms a yes/no; "neither" (red, no-symbol) otherwise. Null when no
   *  overlay is active. */
  binaryChoiceEscapeKind: "maybe" | "neither" | null;
  /** Experiment (glyphInputTranslation): per-sentence glyph translation of the
   *  speech this choice replies to, shown above the overlay buttons. Null when
   *  inactive. */
  binaryChoiceInputGlyphs: Array<{ glyph: string; fallback?: string }> | null;
  dismissBinaryChoice: () => void;

  // AI-initiated video-call directive (server `call_directive`) — consumed by
  // the CallProvider, which dials the contact automatically.
  callDirective: import("@/hooks/dual-agent-types").CallDirective | null;
  // Tell the server a live video call started/ended — drives facilitator mode.
  sendCallActive: (active: boolean, outcome?: string) => void;
  // Tell the server the student entered/left a group AAC chat (shape C).
  sendConversationRoom: (roomId: string | null) => void;
  // Tell the server the student focused a peer's face in the group chat.
  sendConversationFocus: (personId: string | null) => void;
  // Group-chat peers (name + stored photo) for the header face row.
  conversationRoster: import("@/hooks/dual-agent-types").ChatPeer[];
  // Group-chat turn cue (whose turn / who's awaiting), or null.
  floorState: import("@/hooks/dual-agent-types").FloorCue | null;

  // Caretaker alarm raised by the Observer agent. "alert" = short
  // attention nudge; "emergency" = building alarm + on-screen cancel.
  activeAlarm: { level: "alert" | "emergency"; reason: string } | null;
  cancelAlarm: () => void;

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

  /** Per-student seizure-detection config (resolved thresholds + seed baseline),
   *  or null when off / before init. Bridged up to home to gate the detector. */
  seizureConfig: import("@shared/aac/seizure-config").ClientSeizureConfig | null;

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
  /** Press an AI-driven NARROW button — records the user's choice as a
   *  custom narrowing fact and re-injects [GUESSING STATE]. */
  pressNarrow: (dimension: string, value: string, sourceText?: string) => void;
  /** Unified word-finder entry — pass a builderContext to launch from the
   *  sentence builder (pre-selects the category), or call with no args to
   *  launch from conversation tier. Same downstream protocol either way. */
  enterGuessing: (builderContext?: { targetSlot: number | null; partialGlyph: string; category: string }) => void;
  /** Legacy alias — equivalent to enterGuessing(builderContext). */
  enterGuessingFromBuilder: (builderContext: { targetSlot: number | null; partialGlyph: string; category: string }) => void;
  /** User-initiated word-finder cancel. Single exit path used by every
   *  surface (quick-button toggle, sentence-builder toggle, back press).
   *  The server clears guessing state and broadcasts guessing_mode:false. */
  exitGuessing: (reason?: string) => void;
  /** Notify the server the sentence builder opened/closed (conversation detour boundary). */
  setBuilderVisible: (open: boolean) => void;

  // Social trainer (server-owned session) — see dual-agent-types.ts.
  socialSession: import("@/hooks/dual-agent-types").SocialSessionInfo | null;
  socialPeerState: import("@shared/social-bot/state").BotStatePayload | null;
  socialPeerDebug: import("@shared/social-bot/debug").SocialPeerDebugSnapshot | null;
  socialPeerPreview: import("@/hooks/dual-agent-types").SocialPeerPreview | null;
  reconfigureSocialPeer: (params: import("@shared/social-bot/debug").SocialPeerParams) => void;
  notifySocialTrainerStarted: () => void;
  /** DEBUG-only: effective peer voice-pitch shift (semitones) + live setter. */
  peerVoicePitch: number;
  setPeerVoicePitch: (semitones: number) => void;
  /** DEBUG-only: effective peer formant shift (semitones) + live setter. */
  peerVoiceFormant: number;
  setPeerVoiceFormant: (semitones: number) => void;

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
    /** Live VAD gate state — whether mic audio is currently flowing or blocked */
    gateState: PcmGateState;
    /** Current voice engagement contribution (0..1) feeding the VAD gate */
    voiceLevel: number;
    /** Current noise engagement contribution (0..1) feeding the VAD gate */
    noiseLevel: number;
    /** Pre-roll chunks replayed on gate-open (recovered utterance onsets) */
    recoveredCount: number;
  };
  /** Debug: the last on-device STT transcript (text + confidence + when), or
   *  null. Surfaced in the debug panel so STT output is visible. */
  lastSttTranscript?: { text: string; confidence: number; at: number } | null;
}

const DualAgentContext = createContext<DualAgentContextType | null>(null);

interface DualAgentProviderProps {
  children: React.ReactNode;
  studentId: string;
  // Set when AAC is running in classroom mode. Forwarded to the live session
  // so the server can stamp chat_sessions.classroom_id.
  classroomId?: string | null;
  language?: string;
  /** Function to capture a camera frame - returns Blob */
  captureFrame?: () => Promise<Blob | null>;
  /** Function to capture a frame from the environment camera (optional) */
  captureEnvFrame?: () => Promise<BufferedFrame | null>;
  /** Function to get the current identified person (from biometric recognition) */
  getIdentifiedPerson?: () => IdentifiedPerson | null;
  /** Function to get serialized gesture/expression context (face + hand events) */
  getGestureContext?: () => string | null;
  /** Cost-saving (Phase 2): structured scene snapshot (people + hand gestures)
   *  used by the live session to decide frame-vs-scene_state text. */
  getSceneSnapshot?: () => import("@shared/aac/scene-state").SceneSnapshot | null;
  /** Seizure: true while the client detector has a surfaceable event. Its rising
   *  edge PROACTIVELY pushes a frame to the server (a seizure is continuous
   *  motion, so the activity monitor's motion-settle may never fire on its own). */
  seizureActive?: boolean;
  /** Lip-sync speaker attribution: per-face mouth activity during a speech
   *  window, sent with speech clips so the server can fuse it with the voice
   *  match. See shared/aac/speaker-fusion.ts. */
  getLipActivity?: (startMs: number, endMs: number) => import("@shared/aac/speaker-fusion").LipFace[];
  /** Function to get unmatched face descriptors for AI-triggered enrollment */
  getUnmatchedFaceDescriptors?: () => Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }>;
  /** Compute a speaker embedding from a VAD-gated speech clip (16 kHz mono WAV).
   *  When provided, voice samples are sent to the server for voice matching. */
  embedVoiceClip?: (wav: Blob) => Promise<{ embedding: number[]; quality: number } | null>;
  /** Transcribe a VAD-gated speech clip on-device (cost saving, Phase 1). When
   *  provided AND the server activated STT (clientConfig.sttActive), the
   *  transcript is sent as `speech_text` in place of streaming raw audio. */
  transcribeSpeech?: (wav: Blob) => Promise<{ text: string; confidence: number } | null>;
  /** Whether the on-device STT model has finished loading. PCM is only
   *  suppressed once this is true — until then we keep streaming audio so the AI
   *  is never deaf while the (heavy) Whisper model loads or if it fails. */
  sttReady?: boolean;
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
  classroomId,
  language = "en",
  captureFrame: captureFrameProp,
  captureEnvFrame: captureEnvFrameProp,
  getUnmatchedFaceDescriptors,
  embedVoiceClip,
  transcribeSpeech,
  sttReady,
  getGestureContext,
  getSceneSnapshot,
  seizureActive,
  getLipActivity,
  onBoardPatch: onBoardPatchProp,
  debugMode,
  getFaceImage: getFaceImageProp,
  pitchByTag,
}: DualAgentProviderProps) {
  const [currentBoard, setCurrentBoard] = React.useState<ParsedBoardData | null>(null);
  // Context sidebar: queue of buttons, last 4 visible. New buttons push oldest out.
  const [contextButtons, setContextButtons] = React.useState<Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string; glyph?: string; glyphFallback?: string }>>([]);
  const [boardPatch, setBoardPatch] = React.useState<BoardPatch | null>(null);
  const [inputGlyphs, setInputGlyphs] = React.useState<Array<{ glyph: string; fallback?: string }> | null>(null);
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

  // Experiment (glyphInputTranslation): the server only sends a translation
  // when there's fresh incoming speech, so storing it as-is keeps the strip's
  // last value across button-press follow-ups.
  const handleInputGlyphs = useCallback((data: Array<{ glyph: string; fallback?: string }>) => {
    setInputGlyphs(data);
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

  const handleSetFidelity = useCallback(
    (level: import("@/lib/cameraAttentivenessTypes").PerceptionFidelity, reason?: string) => {
      console.log(`[DualAgentContext] server set_fidelity → ${level}${reason ? ` (${reason})` : ""}`);
      attentivenessRef.current?.setFidelity(level);
    },
    [],
  );

  // Phase 1b: the real audio-pull handler needs the ring buffer + liveAgent
  // (both defined below). Bridge via a ref so a STABLE callback can be passed
  // into useLiveSession now, and the implementation wired in afterward.
  const handleRequestAudioClipRef = useRef<((clipId: string) => void) | null>(null);
  const onRequestAudioClip = useCallback((clipId: string) => {
    handleRequestAudioClipRef.current?.(clipId);
  }, []);

  // Seizure Phase 2b: rolling mic-energy ring (filled below from the activity
  // monitor) + a stable getter that answers "sustained vocalization right now?".
  // Passed into useLiveSession to corroborate a seizure [MOTION SIGNATURE] — it
  // NEVER escalates on its own. Ref-bridged because the monitor is created later.
  const vocalRingRef = useRef<AudioEnergySample[]>([]);
  // Gated on the per-student audio-corroboration flag (set after liveAgent below)
  // — when off, the cue never fires, so it can't annotate a motion event.
  const audioCorroborationRef = useRef(false);
  const getVocalCue = useCallback(
    () => audioCorroborationRef.current && sustainedVocalization(vocalRingRef.current, Date.now()),
    [],
  );

  const liveAgent = useLiveSession({
    studentId,
    classroomId,
    language,
    onBoardUpdate: handleBoardUpdate,
    onInputGlyphs: handleInputGlyphs,
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
    onSetFidelity: handleSetFidelity,
    onRequestAudioClip,
    autoPlayAudio: true,
    pitchByTag,
    debugMode,
    captureFrame,
    captureHighResFrame,
    getGestureContext,
    getSceneSnapshot,
    getVocalCue,
  });

  const registerAppCanvasCapture = useCallback((fn: (() => Promise<Blob | null>) | null) => {
    liveAgent.captureAppCanvasRef.current = fn;
  }, [liveAgent.captureAppCanvasRef]);

  const runDetectionWithGridRef = useRef(liveAgent.runDetectionWithGrid);
  runDetectionWithGridRef.current = liveAgent.runDetectionWithGrid;

  const getUnmatchedFaceDescriptorsRef = useRef(getUnmatchedFaceDescriptors);
  getUnmatchedFaceDescriptorsRef.current = getUnmatchedFaceDescriptors;

  const embedVoiceClipRef = useRef(embedVoiceClip);
  embedVoiceClipRef.current = embedVoiceClip;
  const transcribeSpeechRef = useRef(transcribeSpeech);
  transcribeSpeechRef.current = transcribeSpeech;
  const sendVoiceDescriptorsRef = useRef(liveAgent.sendVoiceDescriptors);
  sendVoiceDescriptorsRef.current = liveAgent.sendVoiceDescriptors;
  const sendSpeechTextRef = useRef(liveAgent.sendSpeechText);
  sendSpeechTextRef.current = liveAgent.sendSpeechText;
  const sendSpeechAudioRef = useRef(liveAgent.sendSpeechAudio);
  sendSpeechAudioRef.current = liveAgent.sendSpeechAudio;
  const sendSttStreamStartRef = useRef(liveAgent.sendSttStreamStart);
  sendSttStreamStartRef.current = liveAgent.sendSttStreamStart;
  const sendSttStreamChunkRef = useRef(liveAgent.sendSttStreamChunk);
  sendSttStreamChunkRef.current = liveAgent.sendSttStreamChunk;
  const sendSttStreamEndRef = useRef(liveAgent.sendSttStreamEnd);
  sendSttStreamEndRef.current = liveAgent.sendSttStreamEnd;
  const getLipActivityRef = useRef(getLipActivity);
  getLipActivityRef.current = getLipActivity;
  // Session language (student locale), for the server STT language hint.
  const languageRef = useRef(language);
  languageRef.current = language;
  // Synchronous "is AI talking" gate — don't embed the AI's own TTS as a voice.
  const aiBusyRef = liveAgent.isBusyRef;
  // Server-resolved: when true, transcribe speech on-device and send text in
  // place of streaming raw audio (cost saving, Phase 1).
  const sttActive = liveAgent.clientConfig?.sttActive ?? false;
  const sttActiveRef = useRef(sttActive);
  sttActiveRef.current = sttActive;
  // Per-student audio-corroboration flag drives getVocalCue (declared above).
  audioCorroborationRef.current = liveAgent.clientConfig?.seizure?.thresholds?.audioCorroboration ?? false;
  // Audio "live" attention: stream raw PCM continuously (override a vad-gated
  // data-flow). When false ("adaptive"), PCM stays VAD-gated. Read live each
  // render so the Observer's set_audio_attention flips it mid-session.
  const pcmContinuousRef = useRef(liveAgent.clientConfig?.pcmContinuous ?? false);
  pcmContinuousRef.current = liveAgent.clientConfig?.pcmContinuous ?? false;
  // Whether the on-device STT model is loaded. PCM is only suppressed once STT
  // is BOTH active and ready — otherwise we keep streaming audio so the AI is
  // never deaf while the heavy model loads (or if it fails to load).
  const sttReadyRef = useRef(!!sttReady);
  sttReadyRef.current = !!sttReady;
  // Debug: last on-device STT transcript, surfaced in the debug panel.
  const [lastSttTranscript, setLastSttTranscript] = useState<{ text: string; confidence: number; at: number } | null>(null);

  // Phase 1b audio backlog: keep the recent speech clips keyed by clipId so the
  // Observer can pull one (request_audio) to actually hear it. Bounded to the
  // last few segments — a pull only ever targets the most recent transcript.
  const audioClipBufferRef = useRef<Map<string, { blob: Blob; mimeType: string; at: number }>>(new Map());
  const AUDIO_CLIP_BUFFER_MAX = 6;
  const rememberAudioClip = useCallback((clipId: string, blob: Blob) => {
    const buf = audioClipBufferRef.current;
    buf.set(clipId, { blob, mimeType: blob.type || "audio/wav", at: Date.now() });
    // Drop the oldest entries past the cap (Map preserves insertion order).
    while (buf.size > AUDIO_CLIP_BUFFER_MAX) {
      const oldest = buf.keys().next().value;
      if (oldest === undefined) break;
      buf.delete(oldest);
    }
  }, []);

  // Implementation of the Phase 1b audio pull (bridged in via the ref above so
  // the stable onRequestAudioClip passed to useLiveSession can reach it).
  const sendAudioClipFn = liveAgent.sendAudioClip;
  handleRequestAudioClipRef.current = useCallback(async (clipId: string) => {
    const entry = audioClipBufferRef.current.get(clipId);
    if (!entry || !sendAudioClipFn) return;
    const base64 = await blobToBase64(entry.blob);
    if (base64) sendAudioClipFn({ clipId, data: base64, mimeType: entry.mimeType });
  }, [sendAudioClipFn]);

  const handleActivityTrigger = useCallback(async (grid: any, audioClip: Blob | null, triggerReason: string, meta?: { speechStartMs?: number; speechEndMs?: number }) => {
    const unknownDescriptors = getUnmatchedFaceDescriptorsRef.current?.() || undefined;
    await runDetectionWithGridRef.current(grid, audioClip, unknownDescriptors, triggerReason);

    // Skip clips captured while the AI was talking — that audio is TTS, not a
    // person, and would poison voice galleries / produce echo transcripts.
    if (!audioClip || aiBusyRef?.current) return;

    // Voice embedding (wavlm) runs OFF the main thread and is INDEPENDENT of
    // transcription. Fire it in parallel and tag the result with `clipId` so the
    // server can synchronize it with the STT text before attributing — never
    // block the (latency-sensitive) STT send on the embed. Best-effort.
    const runVoiceId = (clipId?: string) => {
      if (!embedVoiceClipRef.current || !sendVoiceDescriptorsRef.current) return;
      void (async () => {
        try {
          const desc = await embedVoiceClipRef.current!(audioClip);
          if (desc && !aiBusyRef?.current) sendVoiceDescriptorsRef.current!([desc], clipId);
        } catch { /* voice ID is non-critical */ }
      })();
    };

    if (sttActiveRef.current) {
      // Cost saving (Phase 1): get the speech as TEXT instead of streaming raw
      // audio to Gemini (PCM is suppressed in handlePcmChunk). The clip is also
      // stashed for the Phase 1b audio-pull backlog.
      const clipId = crypto.randomUUID();
      rememberAudioClip(clipId, audioClip);
      // (1) Voice embed in parallel, tagged with the clip.
      runVoiceId(clipId);
      // (2) Send the clip for transcription IMMEDIATELY.
      if (STT_ENGINE === "google" && sendSpeechAudioRef.current) {
        try {
          // Fast-tier pitch fingerprint (cheap DSP) computed alongside the
          // base64 encode — rides WITH the clip so the server can give an
          // immediate pitch + lip read before the slow embedding lands.
          const [base64, acoustic] = await Promise.all([
            blobToBase64(audioClip),
            analyzeVoicePitch(audioClip).catch(() => null),
          ]);
          if (base64 && !aiBusyRef?.current) {
            const lipActivity = (meta?.speechStartMs && meta?.speechEndMs)
              ? getLipActivityRef.current?.(meta.speechStartMs, meta.speechEndMs)
              : undefined;
            sendSpeechAudioRef.current({
              data: base64,
              mimeType: audioClip.type || "audio/wav",
              language: languageRef.current,
              clipId,
              lipActivity: lipActivity && lipActivity.length ? lipActivity : undefined,
              acoustic: acoustic ?? undefined,
            });
          }
        } catch {
          // STT send is best-effort — never let it disrupt detection.
        }
      } else if (STT_ENGINE === "whisper" && transcribeSpeechRef.current && sendSpeechTextRef.current) {
        // Whisper path (plumbing kept): transcribe on-device, send the text.
        try {
          const result = await transcribeSpeechRef.current(audioClip);
          if (result?.text && !aiBusyRef?.current) {
            setLastSttTranscript({ text: result.text, confidence: result.confidence, at: Date.now() });
            sendSpeechTextRef.current({ text: result.text, confidence: result.confidence, clipId });
          }
        } catch { /* STT is best-effort */ }
      }
    } else {
      // Not in STT mode — voice ID only (ambient [VOICES HEARD]), no clip sync.
      runVoiceId();
    }
  }, [aiBusyRef, rememberAudioClip]);

  // Streaming STT (Web-Speech-like). The PCM is streamed during speech by
  // useActivityMonitor; these just forward start/chunk to the server.
  const handleSttStreamStart = useCallback((streamId: string) => {
    sendSttStreamStartRef.current?.(streamId, languageRef.current);
  }, []);
  const handleSttStreamChunk = useCallback((streamId: string, data: string) => {
    sendSttStreamChunkRef.current?.(streamId, data);
  }, []);

  // Speech ended (streaming mode): compute the speaker evidence from the clip
  // and finalize the stream. acoustic + lip ride WITH stt_stream_end so they
  // reach the server alongside the transcript; the voice embedding goes in
  // parallel (tagged streamId) for [VOICES HEARD] + the slow read. Always closes
  // the stream (even while the AI is talking) so the server session can't leak.
  const handleSpeechEndClip = useCallback(async (streamId: string, clip: Blob | null, startMs: number, endMs: number) => {
    if (aiBusyRef?.current) { sendSttStreamEndRef.current?.(streamId); return; }
    if (clip) {
      rememberAudioClip(streamId, clip);
      if (embedVoiceClipRef.current && sendVoiceDescriptorsRef.current) {
        void (async () => {
          try {
            const desc = await embedVoiceClipRef.current!(clip);
            if (desc && !aiBusyRef?.current) sendVoiceDescriptorsRef.current!([desc], streamId);
          } catch { /* voice ID non-critical */ }
        })();
      }
    }
    let acoustic: Awaited<ReturnType<typeof analyzeVoicePitch>> | null = null;
    if (clip) acoustic = await analyzeVoicePitch(clip).catch(() => null);
    const lipActivity = (startMs && endMs) ? getLipActivityRef.current?.(startMs, endMs) : undefined;
    sendSttStreamEndRef.current?.(streamId, {
      acoustic: acoustic ?? undefined,
      lipActivity: lipActivity && lipActivity.length ? lipActivity : undefined,
    });
  }, [aiBusyRef, rememberAudioClip]);

  // Mic stream lifecycle. Each activate/deactivate transition is reported to the
  // server (sendMicState) purely for diagnostics — the server logs it to the
  // session history without injecting it into any live agent, so it never
  // triggers a spoken reaction.
  useEffect(() => {
    if (!liveAgent.voiceEnabled || !liveAgent.isInitialized || !liveAgent.sessionId) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        setMicStream(null);
        liveAgent.sendMicState(false);
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
        liveAgent.sendMicState(true);
      } catch {
        console.warn("[DualAgentContext] Mic not available");
        liveAgent.sendMicState(false, "acquisition failed");
      }
    })();
    return () => {
      cancelled = true;
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        setMicStream(null);
        liveAgent.sendMicState(false);
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
  const pcmRecoveredCountRef = useRef(0);
  const [pcmDebug, setPcmDebug] = useState<NonNullable<ProviderShellProps["pcmDebug"]>>({
    audioBusy: false, isPlaying: false, sentCount: 0, gatedCount: 0,
    gateState: "continuous", voiceLevel: 0, noiseLevel: 0, recoveredCount: 0,
  });

  // VAD gate state (vad-gated mode). pcmPrerollRef holds the most recent chunks
  // so the onset captured before the gate opens can be replayed; the other refs
  // track the live gate decision for the indicator + hangover.
  const pcmPrerollRef = useRef<{ data: string; t: number }[]>([]);
  const vadGateOpenRef = useRef(false);
  const lastVadActiveAtRef = useRef(0);
  const gateStateRef = useRef<PcmGateState>("continuous");
  const vadVoiceLevelRef = useRef(0);
  const vadNoiseLevelRef = useRef(0);
  // Paced replay. When the gate opens we DON'T burst the buffered pre-roll —
  // bursting delivers audio faster than real time, which Gemini's automatic VAD
  // mis-segments (garbled / partial transcription). Instead every chunk is sent
  // time-shifted by a fixed lag (≈ the pre-roll span) so it arrives at the same
  // cadence it was captured. Pending sends live in this timer set so they can be
  // cancelled on mode change / unmount. Cost: ~lag latency while the gate is open.
  const pcmPacedTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const pcmLagMsRef = useRef(0);

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
      liveAgent.clientConfig?.awakeDataSaver ?? false,
    );
    contributionsRef.current = attentiveness.engagementScore.contributions;
  }, [attentiveness, attentiveness?.sleepState, attentiveness?.engagementScore, liveAgent.clientConfig?.awakeDataSaver]);

  const handlePcmChunk = useCallback((int16Base64: string) => {
    if (liveAgent.paused) return;
    const now = Date.now();

    // Cost saving (Phase 1): when STT is active the Observer is fed text (from
    // server Google STT of VAD clips, or on-device Whisper), never raw PCM — so
    // suppress the continuous stream. We still drive the VAD "listening" light
    // from speech detection (the mic IS in use), so it blinks with speech rather
    // than being stuck on. (No readiness gate: Google STT is server-side with no
    // model to load; the Whisper path tolerates a brief gap while it loads.)
    if (sttActiveRef.current) {
      const voice = contributionsRef.current.voice ?? 0;
      const noise = contributionsRef.current.noise ?? 0;
      vadVoiceLevelRef.current = voice;
      vadNoiseLevelRef.current = noise;
      const active = voice >= VAD_GATE_THRESHOLD || noise >= VAD_GATE_THRESHOLD;
      if (active) lastVadActiveAtRef.current = now;
      const open = active || now - lastVadActiveAtRef.current < VAD_HANGOVER_MS;
      gateStateRef.current = open ? "open" : "vad-blocked";
      vadGateOpenRef.current = open;
      return;
    }

    const flow = flowRef.current;
    // Audio "live" attention overrides a vad-gated flow to continuous: stream
    // raw PCM unbroken (no silence/voice gate, no paced replay) so Gemini gets a
    // continuous real-time stream — which it transcribes more reliably than
    // chopped, time-shifted segments. "off" (asleep) still wins. "adaptive"
    // leaves the gate on.
    const pcmMode = (pcmContinuousRef.current && flow.pcmMode === "vad-gated")
      ? "continuous"
      : flow.pcmMode;

    // Always retain a short rolling pre-roll of recent chunks so that, when the
    // VAD gate opens, the audio captured BEFORE detection crossed threshold can
    // be replayed. Without this the onset of every gated utterance (while the
    // voice signal is still ramping past threshold) is lost.
    pcmPrerollRef.current.push({ data: int16Base64, t: now });
    while (pcmPrerollRef.current.length > 0 && now - pcmPrerollRef.current[0].t > PCM_PREROLL_MS) {
      pcmPrerollRef.current.shift();
    }

    // Send one chunk, applying the count-only echo gate (mic is still streamed
    // while TTS plays — this only tallies the overlap for diagnostics).
    const emit = (data: string) => {
      if (liveAgent.isBusyRef?.current) pcmGatedCountRef.current++;
      else pcmSentCountRef.current++;
      sendPcmAudioRef.current?.(data);
    };
    // Cancel any in-flight paced sends — used when leaving vad-gated mode so a
    // burst of buffered gated audio can't bleed into a continuous/off stream.
    const clearPaced = () => {
      for (const id of pcmPacedTimersRef.current) clearTimeout(id);
      pcmPacedTimersRef.current.clear();
    };

    if (pcmMode === "off") {
      // Asleep / Hibernation — drop.
      pcmGatedCountRef.current++;
      gateStateRef.current = "off";
      vadGateOpenRef.current = false;
      clearPaced();
      return;
    }

    if (pcmMode === "continuous") {
      // Full Attention Mode — no VAD gate, always stream. Clear the pre-roll so
      // a later switch to vad-gated can't replay stale audio.
      pcmPrerollRef.current.length = 0;
      gateStateRef.current = "continuous";
      vadGateOpenRef.current = true;
      clearPaced();
      emit(int16Base64);
      return;
    }

    // vad-gated — only forward interesting audio: human speech (voice) OR a
    // sudden loud sound (noise). Everything else (ambient hum, silence) is
    // dropped so a quiet session streams almost nothing, but the gate is held
    // open for a short hangover after the last activity so brief inter-word
    // pauses don't re-clip mid-sentence.
    const voice = contributionsRef.current.voice ?? 0;
    const noise = contributionsRef.current.noise ?? 0;
    vadVoiceLevelRef.current = voice;
    vadNoiseLevelRef.current = noise;
    const active = voice >= VAD_GATE_THRESHOLD || noise >= VAD_GATE_THRESHOLD;
    if (active) lastVadActiveAtRef.current = now;
    const open = active || now - lastVadActiveAtRef.current < VAD_HANGOVER_MS;

    if (!open) {
      pcmGatedCountRef.current++;
      gateStateRef.current = "vad-blocked";
      vadGateOpenRef.current = false;
      return;
    }

    // Gate is open. Replay buffered audio (and the ongoing live stream) TIME-
    // SHIFTED at the original capture cadence instead of bursting it: each chunk
    // is sent at `chunk.t + lag`, where `lag` is how far back the oldest buffered
    // chunk sits (≈ the pre-roll span). This preserves real-time spacing so
    // Gemini's automatic VAD can still segment/transcribe the audio; the only
    // cost is a fixed ~lag delay on the audio while the gate stays open.
    const emitPaced = (data: string, delayMs: number) => {
      const id = setTimeout(() => {
        pcmPacedTimersRef.current.delete(id);
        emit(data);
      }, Math.max(0, delayMs));
      pcmPacedTimersRef.current.add(id);
    };

    const buffered = pcmPrerollRef.current;
    if (!vadGateOpenRef.current) {
      // Rising edge — lock in the replay lag from the oldest buffered chunk and
      // schedule the whole pre-roll (its last element is the current chunk).
      // Each chunk's delay is `chunk.t + lag - now`: the oldest fires at ~0, the
      // newest at ~lag, so the onset is replayed at its true spacing.
      const oldest = buffered.length > 0 ? buffered[0].t : now;
      pcmLagMsRef.current = Math.min(Math.max(now - oldest, 0), PCM_PREROLL_MS);
      if (buffered.length > 1) pcmRecoveredCountRef.current += buffered.length - 1;
      for (const entry of buffered) emitPaced(entry.data, entry.t + pcmLagMsRef.current - now);
      vadGateOpenRef.current = true;
    } else {
      // Steady open — the current chunk just landed; send it after the same
      // fixed lag so the live cadence (and Gemini's perceived timing) holds.
      emitPaced(int16Base64, pcmLagMsRef.current);
    }
    buffered.length = 0;
    gateStateRef.current = "open";
  }, [liveAgent.isBusyRef, liveAgent.paused]);

  // Cancel any pending paced PCM sends on unmount.
  useEffect(() => {
    const timers = pcmPacedTimersRef.current;
    return () => { for (const id of timers) clearTimeout(id); timers.clear(); };
  }, []);

  // Poll isBusyRef + counters into state every 200ms for the debug panel
  useEffect(() => {
    const id = setInterval(() => {
      setPcmDebug({
        audioBusy: !!liveAgent.isBusyRef?.current,
        isPlaying: liveAgent.isPlaying,
        sentCount: pcmSentCountRef.current,
        gatedCount: pcmGatedCountRef.current,
        gateState: gateStateRef.current,
        voiceLevel: vadVoiceLevelRef.current,
        noiseLevel: vadNoiseLevelRef.current,
        recoveredCount: pcmRecoveredCountRef.current,
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
    // Streaming STT (Web-Speech-like) — only when STT is active and the Google
    // streaming engine/mode is selected. Streams VAD-gated PCM during speech.
    sttStreamingEnabled: sttActive && STT_ENGINE === "google" && STT_MODE === "stream",
    onSttStreamStart: handleSttStreamStart,
    onSttStreamChunk: handleSttStreamChunk,
    onSpeechEndClip: handleSpeechEndClip,
    // Tuning constants come from the server's `clientConfig.activityMonitor`
    // (shipped in the `initialized` message) so capture rate, settle/silence
    // windows, pre/post-roll, etc. can be tweaked without a client rebuild.
    // speechTriggerEnabled: normally OFF in Live mode (audio streams via PCM and
    // frame grids are decoupled from speech). But when on-device STT is active we
    // suppress PCM and need the speech-segment CLIP — so the "speech ended"
    // trigger MUST fire to extract it. Enable it exactly when STT is active.
    options: {
      ...(liveAgent.clientConfig?.activityMonitor ?? {}),
      speechTriggerEnabled: sttActive,
    },
    // Sleep-system data-flow config: heartbeat interval, attached audio,
    // grid size, motion-trigger gating all read from this ref per-tick.
    flowConfigRef: flowRef,
  });

  // Seizure Phase 2b: feed the mic-energy ring from the activity monitor's 10 Hz
  // RMS so getVocalCue can answer "sustained vocalization?" at frame-send time.
  useEffect(() => {
    const ring = vocalRingRef.current;
    ring.push({ ts: Date.now(), energy: activityMonitor.energyLevel });
    const cutoff = Date.now() - DEFAULT_VOCAL_CUE.windowMs;
    while (ring.length && ring[0].ts < cutoff) ring.shift();
  }, [activityMonitor.energyLevel]);

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

  // One-shot startup: the instant the session is live, (1) push whatever the
  // eager identification pass found so the server can match it, and (2) capture
  // and send a FRESH frame so the Observer's startup scene description uses a
  // current snapshot (not the ~10s-stale connect-time frame). A short backup
  // timer fires the activity-monitor trigger too, so frames still flow if the
  // fresh capture failed. Stored in a ref so the pending timer survives
  // activityMonitor identity churn; reset per session.
  const triggerNowRef = useRef(activityMonitor.triggerNow);
  triggerNowRef.current = activityMonitor.triggerNow;
  const startupTriggerFiredRef = useRef(false);
  useEffect(() => {
    if (!liveAgent.sessionId) { startupTriggerFiredRef.current = false; return; }
    const ready = liveAgent.isInitialized && !liveAgent.paused
      && (liveAgent.videoCaptureEnabled || liveAgent.voiceEnabled);
    if (!ready || startupTriggerFiredRef.current) return;
    startupTriggerFiredRef.current = true;
    // Identification has been running against the live camera throughout the
    // (slow) init window — push whatever it found the instant we connect so the
    // server matches it BEFORE the first frame's scene description. Harmless if
    // empty (face-api still loading): the server falls back to its default.
    const descriptors = getUnmatchedFaceDescriptorsRef.current?.();
    if (descriptors?.length) {
      console.log(`[DualAgentContext] Sending ${descriptors.length} startup face descriptor(s)`);
      liveAgent.sendFaceDescriptors?.(descriptors);
    }
    // Fresh first frame, immediately.
    if (liveAgent.videoCaptureEnabled) void liveAgent.sendFreshStartupFrame?.();
    const t = setTimeout(() => {
      console.log("[DualAgentContext] Firing backup startup detection trigger");
      triggerNowRef.current?.("startup");
    }, STARTUP_DETECTION_DELAY_MS);
    return () => clearTimeout(t);
  }, [liveAgent.isInitialized, liveAgent.sessionId, liveAgent.paused, liveAgent.videoCaptureEnabled, liveAgent.voiceEnabled]);

  // Seizure: PROACTIVELY push a frame the instant the detector flags an event,
  // then keep pushing every few seconds while it persists — a prolonged
  // convulsion is the emergency, and the Observer needs repeated looks + the
  // duration cue. Without this the seizure frame would only go out if the
  // activity monitor happened to fire (motion-settle never triggers during the
  // continuous motion of a seizure). The frame send reads getSceneSnapshot,
  // which carries the [MOTION SIGNATURE].
  useEffect(() => {
    if (!seizureActive) return;
    console.log("[DualAgentContext] Seizure detected — firing 'seizure' frame trigger");
    triggerNowRef.current?.("seizure");
    const id = setInterval(() => triggerNowRef.current?.("seizure"), 4000);
    return () => clearInterval(id);
  }, [seizureActive]);

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

  const liveAgentDebugSetBudgetRef = useRef(liveAgent.debugSetBudget);
  liveAgentDebugSetBudgetRef.current = liveAgent.debugSetBudget;
  const debugSetBudget = useCallback((percent: number) => {
    liveAgentDebugSetBudgetRef.current(percent);
  }, []);

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
      inputGlyphs={inputGlyphs}
      setCurrentBoard={setCurrentBoard}
      boardPatch={boardPatch}
      symbolUpdate={symbolUpdate}
      aiButtonPress={aiButtonPress}
      setOnBoardUpdate={setOnBoardUpdate}
      setOnSetBoard={setOnSetBoard}
      setOnUnloadBoard={setOnUnloadBoard}
      sendMessage={sendMessage}
      sendContextOnly={sendContextOnly}
      debugSetBudget={debugSetBudget}
      sendBoardExit={liveAgent.sendBoardExit}
      voiceButtons={voiceButtons}
      stopVoiceRecording={stopVoiceRecording}
      registerAppCanvasCapture={registerAppCanvasCapture}
      getFaceImage={getFaceImageProp ?? (() => null)}
      activityMonitor={activityMonitor}
      pcmDebug={pcmDebug}
      micActive={micStream !== null}
      lastSttTranscript={lastSttTranscript}
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
  inputGlyphs: Array<{ glyph: string; fallback?: string }> | null;
  setCurrentBoard: (board: ParsedBoardData | null) => void;
  boardPatch: BoardPatch | null;
  symbolUpdate: { buttonLabel: string; symbolPath: string } | null;
  aiButtonPress: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null;
  setOnBoardUpdate: (callback: ((board: ParsedBoardData) => void) | null) => void;
  setOnSetBoard: (callback: ((data: { board: ParsedBoardData; name: string; boardId: string }) => void) | null) => void;
  setOnUnloadBoard: (callback: (() => void) | null) => void;
  sendMessage: (message: string) => Promise<void>;
  sendContextOnly: (text: string) => void;
  debugSetBudget: (percent: number) => void;
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
    gateState: PcmGateState;
    voiceLevel: number;
    noiseLevel: number;
    recoveredCount: number;
  };
  micActive: boolean;
  lastSttTranscript?: { text: string; confidence: number; at: number } | null;
}

function ProviderShell({
  children,
  studentId,
  agent,
  currentBoard,
  contextButtons,
  inputGlyphs,
  setCurrentBoard,
  boardPatch,
  symbolUpdate,
  aiButtonPress,
  setOnBoardUpdate,
  setOnSetBoard,
  setOnUnloadBoard,
  sendMessage,
  sendContextOnly,
  debugSetBudget,
  sendBoardExit,
  voiceButtons,
  stopVoiceRecording,
  registerAppCanvasCapture,
  getFaceImage,
  activityMonitor,
  pcmDebug: pcmDebugProp,
  micActive,
  lastSttTranscript,
}: ProviderShellProps) {
  const value: DualAgentContextType = {
    studentId,
    sessionId: agent.sessionId,
    isInitialized: agent.isInitialized,
    isLoading: agent.isLoading,
    startupStage: agent.startupStage,
    error: agent.error,

    currentMessage: agent.currentMessage,
    transcription: agent.transcription,
    utteranceText: agent.utteranceText,
    utteranceConfidence: agent.utteranceConfidence,
    transcriptConfidence: agent.transcriptConfidence,
    debugText: agent.debugText,

    audioEnabled: agent.audioEnabled,
    getCallAudioStream: agent.getCallAudioStream,
    isPlaying: agent.isPlaying,
    audioPlayingTag: agent.audioPlayingTag ?? null,
    voiceEnabled: agent.voiceEnabled,
    isRecording: agent.isRecording,
    audioLevel: agent.audioLevel,
    recordingDuration: agent.recordingDuration,
    snapshotTick: agent.snapshotTick,
    micActive,

    currentBoard,
    contextButtons,
    inputGlyphs,

    muteState: agent.muteState,
    setMuteState: agent.setMuteState,
    lastModeChange: agent.lastModeChange,
    budget: agent.budget,

    responseMode: agent.responseMode,
    setResponseMode: agent.setResponseMode,

    videoCaptureEnabled: agent.videoCaptureEnabled,
    setVideoCaptureEnabled: agent.setVideoCaptureEnabled,

    initialize: agent.initialize,
    sendMessage,
    sendContextOnly,
    debugSetBudget,
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
    correctIdentity: (entityType, entityId, reason) =>
      agent.sendIdentityCorrection?.(entityType, entityId, reason),

    activeApp: agent.activeApp,
    dismissApp: agent.dismissApp,
    launchApp: agent.launchApp,
    requestAppOpen: agent.requestAppOpen,
    appOpenPending: agent.appOpenPending,
    registerAppCanvasCapture,
    enabledApps: agent.enabledApps,
    availableCustomApps: agent.availableCustomApps,

    emote: agent.emote,
    speakingVolume: agent.speakingVolume,
    thinkingPulse: agent.thinkingPulse,

    binaryChoiceOptions: agent.binaryChoiceOptions,
    binaryChoiceEscapeKind: (agent as any).binaryChoiceEscapeKind ?? null,
    binaryChoiceInputGlyphs: (agent as any).binaryChoiceInputGlyphs ?? null,
    dismissBinaryChoice: agent.dismissBinaryChoice,

    callDirective: (agent as any).callDirective ?? null,
    sendCallActive: agent.sendCallActive,
    sendConversationRoom: agent.sendConversationRoom,
    sendConversationFocus: agent.sendConversationFocus,
    conversationRoster: agent.conversationRoster,
    floorState: agent.floorState,

    activeAlarm: agent.activeAlarm,
    cancelAlarm: agent.cancelAlarm,

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

    // Per-student seizure detection (resolved thresholds + seed baseline) from
    // the server's clientConfig. home bridges this up to gate/configure the
    // pose-based detector. Null when off / before init.
    seizureConfig: agent.clientConfig?.seizure ?? null,

    paused: agent.paused,
    setPaused: agent.setPaused,

    reconnecting: agent.reconnecting ?? false,
    safetyBlocked: agent.safetyBlocked ?? false,

    guessingMode: agent.guessingMode ?? false,
    pressSuggestion: agent.pressSuggestion ?? ((key: string) => {
      console.warn("[guessing] pressSuggestion is unavailable — the live session hook did not provide it (stale build?). key=", key);
    }),
    pressNarrow: agent.pressNarrow ?? ((dim: string, value: string) => {
      console.warn("[guessing] pressNarrow is unavailable — the live session hook did not provide it (stale build?).", { dim, value });
    }),
    enterGuessing: agent.enterGuessing ?? (() => { /* live API not available */ }),
    enterGuessingFromBuilder: agent.enterGuessingFromBuilder ?? (() => { /* live API not available */ }),
    exitGuessing: agent.exitGuessing ?? (() => { /* live API not available */ }),
    setBuilderVisible: agent.setBuilderVisible ?? (() => { /* live API not available */ }),
    socialSession: agent.socialSession ?? null,
    socialPeerState: agent.socialPeerState ?? null,
    socialPeerDebug: agent.socialPeerDebug ?? null,
    socialPeerPreview: agent.socialPeerPreview ?? null,
    reconfigureSocialPeer: agent.reconfigureSocialPeer ?? (() => { /* live API not available */ }),
    notifySocialTrainerStarted: agent.notifySocialTrainerStarted ?? (() => { /* live API not available */ }),
    peerVoicePitch: agent.peerVoicePitch ?? 0,
    setPeerVoicePitch: agent.setPeerVoicePitch ?? (() => { /* live API not available */ }),
    peerVoiceFormant: agent.peerVoiceFormant ?? 0,
    setPeerVoiceFormant: agent.setPeerVoiceFormant ?? (() => { /* live API not available */ }),

    sendConstructionState: agent.sendConstructionState ?? (() => { /* live API not available */ }),
    constructionSuggestions: agent.constructionSuggestions ?? null,
    constructionMemoryChips: agent.constructionMemoryChips ?? {},

    pcmDebug: pcmDebugProp ?? {
      audioBusy: false, isPlaying: false, sentCount: 0, gatedCount: 0,
      gateState: "continuous", voiceLevel: 0, noiseLevel: 0, recoveredCount: 0,
    },
    lastSttTranscript,
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
