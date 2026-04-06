// client-aac/src/hooks/dual-agent-types.ts
// Shared type definitions for the dual-agent AAC system.
// Extracted from useDualAgent.ts so that useLiveSession.ts and
// DualAgentContext.tsx can import them without depending on each other.

import type React from "react";
import type { ParsedBoardData } from "@shared/schema";
import type { ComposedGrid } from "@/lib/composeFrameGrid";
import type { UnknownFaceDescriptor } from "./usePersonIdentification";
import type { CachedRequest } from "./useDebugRequestCache";

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

export interface UseDualAgentReturn {
  // Session state
  sessionId: string | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

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
  sendContextOnly: (text: string) => void;
  sendVoice: (board?: ParsedBoardData) => Promise<void>;
  interpretButtons: (recentButtons: string[], sentences?: Record<string, string>, board?: ParsedBoardData) => Promise<void>;
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

  // Focus frame
  /** True while a focus frame is being captured/sent (briefly shows glasses overlay) */
  focusActive: boolean;

  // Pause state
  paused: boolean;
  setPaused: (paused: boolean) => void;

  // Reconnection state (Live API only)
  /** Whether the server is currently reconnecting to Gemini */
  reconnecting?: boolean;
  /** Transient safety block indicator (auto-clears after 5s) */
  safetyBlocked?: boolean;
}
