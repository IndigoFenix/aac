// client-aac/src/components/UnifiedDebugPanel.tsx
// Single draggable, resizable debug panel with collapsible sections

import React, { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronDown, ChevronRight, Copy, Camera, Mic, Image, MessageSquare, Eye, Brain, Clock, Filter, Activity, Play, Pause, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { useDebugSession, type DebugSessionMessage } from "@/hooks/useDebugSession";
import type { LastCapturedFaceImage } from "@/hooks/usePersonIdentification";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import type { TrackedFace } from "@/lib/faceTrackingTypes";
import { getEventColorCategory, EVENT_COLOR_MAP } from "@/lib/faceTrackingTypes";
import type { TrackedHand } from "@/lib/handGestureTypes";
import { getHandEventColorCategory, HAND_EVENT_COLOR_MAP } from "@/lib/handGestureTypes";

const EXPRESSION_COLORS: Record<string, string> = {
  smile: 'bg-green-200 text-green-800',
  frown: 'bg-red-200 text-red-800',
  surprise: 'bg-yellow-200 text-yellow-800',
  neutral: 'bg-gray-200 text-gray-700',
  wink: 'bg-purple-200 text-purple-800',
  mouth_open: 'bg-orange-200 text-orange-800',
};

const GESTURE_COLORS: Record<string, string> = {
  open_palm: 'bg-indigo-200 text-indigo-800',
  closed_fist: 'bg-indigo-200 text-indigo-800',
  pointing_up: 'bg-indigo-200 text-indigo-800',
  thumbs_up: 'bg-green-200 text-green-800',
  thumbs_down: 'bg-red-200 text-red-800',
  victory: 'bg-yellow-200 text-yellow-800',
  iloveyou: 'bg-pink-200 text-pink-800',
};

interface UnifiedDebugPanelProps {
  isOpen: boolean;
  onClose: () => void;
  // Face tracking props (from home)
  faceTrackingEnabled?: boolean;
  onFaceTrackingToggle?: (enabled: boolean) => void;
  trackedFaces?: TrackedFace[];
  faceTrackingFps?: number;
  faceTrackingReady?: boolean;
  faceTrackingError?: string | null;
  // Hand tracking props (from home)
  handGestureEnabled?: boolean;
  onHandGestureToggle?: (enabled: boolean) => void;
  trackedHands?: TrackedHand[];
  handGestureFps?: number;
  handGestureReady?: boolean;
  handGestureError?: string | null;
  // Face image debug (from usePersonIdentification)
  lastCapturedFaceImage?: LastCapturedFaceImage | null;
  // Client-side ML model load status (from home's hooks)
  sttReady?: boolean;
  sttLoading?: boolean;
  sttTranscribing?: boolean;
  sttError?: string | null;
  voiceReady?: boolean;
  voiceLoading?: boolean;
  voiceError?: string | null;
  faceRecognitionReady?: boolean;
  // Seizure detection live status (from home's useSeizureWatch)
  seizure?: {
    poseTrackingOn: boolean;
    configured: boolean;
    enabled: boolean;
    thresholds: import("@shared/aac/seizure-config").SeizureThresholds | null;
    hasSeedBaseline: boolean;
    poseDetected: boolean;
    baselineSamples: number;
    signature: import("@shared/aac/seizure-signature").SeizureSignature | null;
    willEscalate: boolean;
    watchActive: boolean;
  };
}

/** Resolve a model's load state into a colored status chip. */
function modelStatus(ready?: boolean, loading?: boolean, error?: string | null): { label: string; color: string } {
  if (error) return { label: "failed", color: "bg-red-500" };
  if (ready) return { label: "loaded", color: "bg-green-500" };
  if (loading) return { label: "loading…", color: "bg-yellow-500" };
  return { label: "idle", color: "bg-gray-400" };
}

function ModelRow({ name, ready, loading, error }: { name: string; ready?: boolean; loading?: boolean; error?: string | null }) {
  const s = modelStatus(ready, loading, error);
  return (
    <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${s.color}`} />
          <span className="text-[11px]">{name}</span>
        </span>
        <span className="text-[10px] text-gray-500">{s.label}</span>
      </div>
      {error && <p className="text-[9px] text-red-500 mt-0.5 break-all">{error}</p>}
    </div>
  );
}

/** Compact key/value row for the seizure readout. */
function KV({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-gray-500">{label}</span>
      <span className={`font-mono text-[11px] ${bad ? "text-red-500" : good ? "text-green-600" : ""}`}>{value}</span>
    </div>
  );
}

const SECTION_STORAGE_KEY = "debug-panel-sections";
const POSITION_STORAGE_KEY = "debug-panel-position";
const SIZE_STORAGE_KEY = "debug-panel-size";

const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const DEFAULT_WIDTH = 550;
const DEFAULT_HEIGHT = 700;

function loadSections(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(SECTION_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch { return {}; }
}

function saveSections(sections: Record<string, boolean>) {
  localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sections));
}

function loadPosition(): { x: number; y: number } {
  try {
    const stored = localStorage.getItem(POSITION_STORAGE_KEY);
    return stored ? JSON.parse(stored) : { x: 20, y: 60 };
  } catch { return { x: 20, y: 60 }; }
}

function loadSize(): { width: number; height: number } {
  try {
    const stored = localStorage.getItem(SIZE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  } catch { return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }; }
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  return `${Math.floor(diff / 3600000)}h`;
}

// ---- Sub-components for Cameras section ----

function FaceCard({ face, index }: { face: TrackedFace; index: number }) {
  const displayName = face.personName || `Person ${index + 1}`;
  const topBlendshapes = Array.from(face.currentBlendshapes.entries())
    .filter(([name]) => !name.startsWith('_'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const recentEvents = [...face.events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);

  return (
    <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate">{displayName}</span>
        {face.currentExpression && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            EXPRESSION_COLORS[face.currentExpression] || 'bg-gray-200 text-gray-700'
          }`}>
            {face.currentExpression.replace('_', ' ')}
          </span>
        )}
      </div>
      {topBlendshapes.length > 0 && (
        <div className="space-y-0.5">
          {topBlendshapes.map(([name, score]) => (
            <div key={name} className="flex items-center gap-1 text-[10px]">
              <span className="w-20 truncate text-gray-500">{name}</span>
              <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.round(score * 100)}%` }} />
              </div>
              <span className="w-6 text-right text-gray-500">{(score * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
      {recentEvents.length > 0 && (
        <div className="flex flex-wrap gap-0.5">
          {recentEvents.map((event, i) => {
            const colors = EVENT_COLOR_MAP[getEventColorCategory(event.type)];
            return (
              <span key={`${event.type}_${i}`} className={`text-[9px] px-1 py-0.5 rounded ${colors}`}>
                {event.type.replace('_', ' ')} {formatRelativeTime(event.timestamp)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HandCard({ hand, index }: { hand: TrackedHand; index: number }) {
  const recentEvents = [...hand.events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  return (
    <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{hand.handedness} Hand</span>
        {hand.currentGesture && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            GESTURE_COLORS[hand.currentGesture] || 'bg-gray-200 text-gray-700'
          }`}>
            {hand.currentGesture.replace(/_/g, ' ')} {(hand.currentGestureConfidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      {recentEvents.length > 0 && (
        <div className="flex flex-wrap gap-0.5">
          {recentEvents.map((event, i) => {
            const colors = HAND_EVENT_COLOR_MAP[getHandEventColorCategory(event.type)];
            const label = event.type === 'sign_language' && event.signLabel ? event.signLabel : event.type.replace(/_/g, ' ');
            return (
              <span key={`${event.type}_${i}`} className={`text-[9px] px-1 py-0.5 rounded ${colors}`}>
                {label} {formatRelativeTime(event.timestamp)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Section header ----

function SectionHeader({ title, icon, isOpen, onClick, badge }: {
  title: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onClick: () => void;
  badge?: React.ReactNode;
}) {
  return (
    <button type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
    >
      {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      {icon}
      <span className="flex-1 text-left">{title}</span>
      {badge}
    </button>
  );
}

// ---- Endpoint color ----
const ENDPOINT_COLORS: Record<string, string> = {
  "/detect": "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  "/message": "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "/voice": "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "/initialize": "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

// ---- Role colors ----
const ROLE_COLORS: Record<string, string> = {
  user: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  assistant: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  system: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

// ---- Main panel ----

export default function UnifiedDebugPanel({
  isOpen,
  onClose,
  faceTrackingEnabled,
  onFaceTrackingToggle,
  trackedFaces,
  faceTrackingFps,
  faceTrackingReady,
  faceTrackingError,
  handGestureEnabled,
  onHandGestureToggle,
  trackedHands,
  handGestureFps,
  handGestureReady,
  handGestureError,
  lastCapturedFaceImage,
  sttReady,
  sttLoading,
  sttTranscribing,
  sttError,
  voiceReady,
  voiceLoading,
  voiceError,
  faceRecognitionReady,
  seizure,
}: UnifiedDebugPanelProps) {
  // Context data
  const ctx = useDualAgentContext();
  const attentiveness = useCameraAttentivenessOptional();
  const { dwellDebug, enabled: dwellEnabled, mode: dwellMode } = useEyeTrackingDwell();

  // Session debug polling
  const { data: sessionData } = useDebugSession(ctx.sessionId, ctx.studentId, isOpen);

  // Position / size state (persisted to localStorage)
  const [position, setPosition] = useState(loadPosition);
  const [size, setSize] = useState(loadSize);
  const windowRef = useRef<HTMLDivElement>(null);

  // Section collapsed state (persisted)
  const [sections, setSections] = useState<Record<string, boolean>>(() => {
    const stored = loadSections();
    return {
      models: stored.models ?? true,
      cameras: stored.cameras ?? true,
      audioClips: stored.audioClips ?? true,
      identifiedPeople: stored.identifiedPeople ?? true,
      faceImages: stored.faceImages ?? true,
      requests: stored.requests ?? true,
      interactive: stored.interactive ?? true,
      monitor: stored.monitor ?? true,
      sessionLog: stored.sessionLog ?? false,
      dwell: stored.dwell ?? false,
      seizure: stored.seizure ?? true,
    };
  });

  // Session log filter
  const [logFilter, setLogFilter] = useState<"all" | "user" | "assistant" | "system">("all");

  // Expanded request/message IDs
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
  const [expandedMessage, setExpandedMessage] = useState<number | null>(null);

  // Audio playback state
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Persist position/size
  useEffect(() => {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
  }, [position]);

  useEffect(() => {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size));
  }, [size]);

  // Toggle section
  const toggleSection = useCallback((key: string) => {
    setSections(prev => {
      const next = { ...prev, [key]: !prev[key] };
      saveSections(next);
      return next;
    });
  }, []);

  // ---- Drag ----
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!windowRef.current) return;
    const rect = windowRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX - offsetX, y: e.clientY - offsetY });
    };
    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  // ---- Resize ----
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.width;
    const startH = size.height;

    const handleMouseMove = (e: MouseEvent) => {
      setSize({
        width: Math.max(MIN_WIDTH, startW + (e.clientX - startX)),
        height: Math.max(MIN_HEIGHT, startH + (e.clientY - startY)),
      });
    };
    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [size]);

  // Copy to clipboard
  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  // Play/stop audio clip
  const toggleAudioClip = useCallback((clipId: string, objectUrl: string) => {
    if (playingClipId === clipId) {
      // Stop playing
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingClipId(null);
    } else {
      // Stop any current playback
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      const audio = new Audio(objectUrl);
      audio.onended = () => {
        setPlayingClipId(null);
        audioRef.current = null;
      };
      audio.onerror = () => {
        setPlayingClipId(null);
        audioRef.current = null;
      };
      audio.play().catch(() => {
        setPlayingClipId(null);
      });
      audioRef.current = audio;
      setPlayingClipId(clipId);
    }
  }, [playingClipId]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  if (!isOpen) return null;

  // Derive data — merge processed messages + pending messages for the session log
  const processedMessages: Array<DebugSessionMessage & { isPending?: boolean }> = (sessionData?.messages || []).map(m => ({ ...m, isPending: false }));
  const pendingMessages: Array<DebugSessionMessage & { isPending?: boolean }> = (sessionData?.pendingMessages || []).map(m => ({
    ...m, role: m.role as "user" | "assistant" | "system", isPending: true,
  }));
  const messages = [...processedMessages, ...pendingMessages].sort((a, b) => a.timestamp - b.timestamp);
  const filteredMessages = logFilter === "all" ? messages : messages.filter(m => m.role === logFilter);
  const lastInteractiveDebug = ctx.debugData?.interactive_response;
  const lastDetectionDebug = ctx.debugData?.detection_result;
  const lastTranscript = ctx.debugData?.last_transcript;
  const lastContextUpdate = ctx.debugData?.last_context_update;

  return (
    <div
      ref={windowRef}
      className="fixed z-50 bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-300 dark:border-gray-700 flex flex-col overflow-hidden"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
      }}
    >
      {/* Header - drag handle. Debug-only floating window; pointer-only by design. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-purple-600 text-white cursor-grab active:cursor-grabbing select-none shrink-0"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="w-4 h-4" />
          Debug Panel
          {ctx.sessionId && (
            <span className="text-[10px] font-mono opacity-70">{ctx.sessionId.substring(0, 8)}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {ctx.isInitialized ? (
            <Badge className="bg-green-500 text-white text-[10px] px-1.5">Live</Badge>
          ) : (
            <Badge className="bg-gray-500 text-white text-[10px] px-1.5">Offline</Badge>
          )}
          <button type="button" onClick={onClose} className="p-1 hover:bg-purple-700 rounded" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="divide-y divide-gray-200 dark:divide-gray-700">

          {/* ===== Models (client-side ML load status) ===== */}
          <div>
            <SectionHeader
              title="Models"
              icon={<Brain className="w-3.5 h-3.5" />}
              isOpen={sections.models}
              onClick={() => toggleSection("models")}
              badge={(() => {
                const flags = [sttReady, voiceReady, faceRecognitionReady, faceTrackingReady, handGestureReady];
                const loaded = flags.filter(Boolean).length;
                return (
                  <Badge className={`${loaded === flags.length ? "bg-green-500" : "bg-yellow-500"} text-white text-[9px] px-1`}>
                    {loaded}/{flags.length}
                  </Badge>
                );
              })()}
            />
            {sections.models && (
              <div className="p-2 space-y-1 text-xs">
                <ModelRow name="Speech-to-text (Whisper)" ready={sttReady} loading={sttLoading} error={sttError} />
                <ModelRow name="Voice ID (WavLM)" ready={voiceReady} loading={voiceLoading} error={voiceError} />
                <ModelRow name="Face recognition (face-api)" ready={faceRecognitionReady} loading={!faceRecognitionReady} />
                <ModelRow name="Face tracking (MediaPipe)" ready={faceTrackingReady} loading={!faceTrackingReady && !faceTrackingError} error={faceTrackingError} />
                <ModelRow name="Hand gesture (MediaPipe)" ready={handGestureReady} loading={!handGestureReady && !handGestureError} error={handGestureError} />

                {/* Live on-device STT output + server-side voice match */}
                <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                  <div className="text-[10px] text-gray-500 mb-0.5 flex items-center gap-1">
                    Last heard (on-device STT)
                    {sttTranscribing && (
                      <span className="flex items-center gap-1 text-[9px] text-amber-500">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        transcribing…
                      </span>
                    )}
                  </div>
                  {ctx.lastSttTranscript ? (
                    <div className="text-[11px]">
                      <span className="font-medium">“{ctx.lastSttTranscript.text}”</span>
                      <span className="text-[9px] text-gray-400 ml-1">
                        conf {(ctx.lastSttTranscript.confidence * 100).toFixed(0)}% · {Math.round((Date.now() - ctx.lastSttTranscript.at) / 1000)}s ago
                      </span>
                    </div>
                  ) : (
                    <div className="text-[10px] italic text-gray-400">nothing transcribed yet</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ===== Seizure Detection ===== */}
          <div>
            <SectionHeader
              title="Seizure Detection"
              icon={<Activity className="w-3.5 h-3.5" />}
              isOpen={sections.seizure}
              onClick={() => toggleSection("seizure")}
              badge={
                <Badge className={`${
                  !seizure?.enabled ? "bg-gray-400"
                    : seizure.willEscalate ? "bg-red-500 animate-pulse"
                    : seizure.watchActive ? "bg-amber-500"
                    : "bg-green-500"
                } text-white text-[9px] px-1`}>
                  {!seizure?.enabled ? "off" : seizure.willEscalate ? "EVENT" : seizure.watchActive ? "watching" : "on"}
                </Badge>
              }
            />
            {sections.seizure && (
              <div className="p-2 space-y-1 text-xs">
                {!seizure ? (
                  <div className="text-[10px] italic text-gray-400">no data</div>
                ) : !seizure.poseTrackingOn ? (
                  <div className="text-amber-600 text-[11px]">Pose tracking is OFF (poseSafety capability) — the detector can't run.</div>
                ) : !seizure.configured ? (
                  <div className="text-amber-600 text-[11px]">No server config for this session. Enable Seizure Detection in this student's AAC settings, <b>Save</b>, then <b>restart the AAC session</b> — clientConfig is sent once at session start.</div>
                ) : !seizure.enabled ? (
                  <div className="text-amber-600 text-[11px]">Configured but disabled (master switch off, or both detectors set to Off).</div>
                ) : (
                  <>
                    <KV label="Pose detected" value={seizure.poseDetected ? "yes" : "NO — get in view"} bad={!seizure.poseDetected} />
                    <KV label="Baseline" value={seizure.baselineSamples > 0 ? `ready (${seizure.baselineSamples})${seizure.hasSeedBaseline ? " seeded" : ""}` : "cold — warming (inert)"} bad={seizure.baselineSamples === 0} />
                    <KV label="Rhythmic detector" value={seizure.thresholds?.rhythmic.enabled ? `on · ≥${seizure.thresholds.rhythmic.involvementMult}× · conf≥${seizure.thresholds.rhythmic.escalateConfidence}` : "off"} />
                    <KV label="Atonic detector" value={seizure.thresholds?.atonic.enabled ? `on · drop≥${seizure.thresholds.atonic.dropFrac}` : "off"} />
                    <KV label="Audio corroboration" value={seizure.thresholds?.audioCorroboration ? "on" : "off"} />
                    <KV label="Pose rate" value={seizure.watchActive ? "BUMPED ~15fps (watch)" : "cheap ~2.5fps"} good={seizure.watchActive} />

                    <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800 rounded space-y-0.5">
                      <div className="text-[10px] text-gray-500">Live motion signature</div>
                      {seizure.signature ? (
                        <>
                          <KV label="phase" value={seizure.signature.phase} good={seizure.signature.phase !== "none"} />
                          <KV label="dominant Hz" value={seizure.signature.dominantHz.toFixed(2)} />
                          <KV label="rhythmicity" value={seizure.signature.rhythmicity.toFixed(2)} />
                          <KV label="bilateral sym" value={seizure.signature.bilateralSymmetry.toFixed(2)} />
                          <KV label="involved regions" value={seizure.signature.involvedRegions.join(", ") || "none"} />
                          <KV label="energy vs baseline" value={`${seizure.signature.energyVsBaseline.toFixed(1)}×`} />
                          <KV label="confidence" value={seizure.signature.confidence.toFixed(2)} />
                        </>
                      ) : (
                        <div className="text-[10px] italic text-gray-400">no window analyzed yet (need ~2.5s of pose)</div>
                      )}
                    </div>

                    <KV label="Signature ready" value={seizure.willEscalate ? "YES → [MOTION SIGNATURE]" : "no"} good={seizure.willEscalate} />
                    <div className="text-[9px] text-gray-400 mt-1 leading-snug">
                      To trip the rhythmic detector by hand: shake BOTH arms + torso together, sustained, ~2–4×/sec — a one-handed wave won't qualify (needs bilateral + axial). Atonic = a sudden seated slump that stays down. Note: the [MOTION SIGNATURE] only reaches the Observer in economize mode (Full Attention OFF).
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ===== Section 1: Cameras ===== */}
          <div>
            <SectionHeader
              title="Cameras"
              icon={<Camera className="w-3.5 h-3.5" />}
              isOpen={sections.cameras}
              onClick={() => toggleSection("cameras")}
              badge={
                <div className="flex gap-1">
                  {faceTrackingReady && <Badge className="bg-green-500 text-white text-[9px] px-1">Face</Badge>}
                  {handGestureReady && <Badge className="bg-blue-500 text-white text-[9px] px-1">Hand</Badge>}
                </div>
              }
            />
            {sections.cameras && (
              <div className="p-2 space-y-2 text-xs">
                {/* Attentiveness */}
                {attentiveness && (
                  <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-[11px]">
                    <Eye className="w-3 h-3" />
                    <span>State: <strong>{attentiveness.state.isAwake ? "Awake" : "Sleep"}</strong></span>
                    <span>Motion: {(attentiveness.state.motionLevel * 100).toFixed(0)}%</span>
                    <span>Frames: {attentiveness.state.frameCount}</span>
                  </div>
                )}

                {/* Sleep system: state + engagement score + per-signal contributions */}
                {attentiveness && (
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-[11px] space-y-1">
                    <div className="flex items-center gap-2">
                      <span>Sleep:</span>
                      <strong>{attentiveness.sleepState}</strong>
                      <span className="text-gray-400">|</span>
                      <span>Score: <strong>{(attentiveness.engagementScore.value * 100).toFixed(0)}%</strong></span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                      {Object.entries(attentiveness.engagementScore.contributions).map(([k, v]) => (
                        <span key={k}>{k}: {((v ?? 0) * 100).toFixed(0)}%</span>
                      ))}
                      {Object.keys(attentiveness.engagementScore.contributions).length === 0 && (
                        <span className="italic">no active signals</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Face tracking controls */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Eye className="w-3 h-3 text-gray-500" />
                    <span className="text-[11px]">Face Tracking</span>
                    {faceTrackingFps !== undefined && <span className="text-[10px] text-gray-400">{faceTrackingFps} fps</span>}
                  </div>
                  {onFaceTrackingToggle && (
                    <Switch
                      checked={faceTrackingEnabled || false}
                      onCheckedChange={onFaceTrackingToggle}
                    />
                  )}
                </div>
                {faceTrackingError && <p className="text-[10px] text-red-500">{faceTrackingError}</p>}

                {/* Tracked faces */}
                {trackedFaces && trackedFaces.length > 0 && (
                  <div className="space-y-1">
                    {trackedFaces.map((face, i) => <FaceCard key={face.faceIndex ?? i} face={face} index={i} />)}
                  </div>
                )}

                {/* Hand gesture controls */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px]">Hand Gestures</span>
                    {handGestureFps !== undefined && <span className="text-[10px] text-gray-400">{handGestureFps} fps</span>}
                  </div>
                  {onHandGestureToggle && (
                    <Switch
                      checked={handGestureEnabled || false}
                      onCheckedChange={onHandGestureToggle}
                    />
                  )}
                </div>
                {handGestureError && <p className="text-[10px] text-red-500">{handGestureError}</p>}

                {/* Tracked hands */}
                {trackedHands && trackedHands.length > 0 && (
                  <div className="space-y-1">
                    {trackedHands.map((hand, i) => <HandCard key={`${hand.handedness}-${i}`} hand={hand} index={i} />)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ===== Section: Audio Clips ===== */}
          <div>
            <SectionHeader
              title="Audio Capture"
              icon={<Mic className="w-3.5 h-3.5" />}
              isOpen={sections.audioClips}
              onClick={() => toggleSection("audioClips")}
              badge={
                <div className="flex gap-1">
                  {ctx.audioActivity.isSpeaking && <Badge className="bg-red-500 text-white text-[9px] px-1 animate-pulse">Speaking</Badge>}
                  {ctx.audioClipCache.length > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1">{ctx.audioClipCache.length}</Badge>
                  )}
                </div>
              }
            />
            {sections.audioClips && (
              <div className="p-2 space-y-2 text-xs">
                {/* PCM Gating (Live API mic→Gemini) */}
                <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded space-y-1.5">
                  <div className="text-[10px] font-medium text-gray-500">PCM Mic → Gemini</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* VAD gate indicator — whether mic audio is flowing right now */}
                    {(() => {
                      const gs = ctx.pcmDebug.gateState;
                      const flowing = gs === 'open' || gs === 'continuous';
                      const label = gs === 'open' ? 'OPEN'
                        : gs === 'continuous' ? 'STREAMING'
                        : gs === 'vad-blocked' ? 'BLOCKED'
                        : 'OFF';
                      return (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                          flowing
                            ? 'bg-green-200 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : gs === 'vad-blocked'
                              ? 'bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200 animate-pulse'
                              : 'bg-gray-300 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                        }`}>
                          GATE: {label}
                        </span>
                      );
                    })()}
                    {/* Echo indicator (count-only; mic still streams while TTS plays) */}
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                      ctx.pcmDebug.audioBusy
                        ? 'bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-200'
                        : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {ctx.pcmDebug.audioBusy ? 'Echo' : 'No echo'}
                    </span>
                    {/* isPlaying indicator */}
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                      ctx.pcmDebug.isPlaying
                        ? 'bg-blue-200 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                        : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {ctx.pcmDebug.isPlaying ? 'Playing' : 'Idle'}
                    </span>
                  </div>
                  {/* Live VAD levels vs threshold (0.05) — shows why the gate is open/blocked */}
                  <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-500 dark:text-gray-400">
                    <span className={ctx.pcmDebug.voiceLevel >= 0.05 ? 'text-green-600 dark:text-green-400 font-medium' : ''}>
                      voice {ctx.pcmDebug.voiceLevel.toFixed(2)}
                    </span>
                    <span className={ctx.pcmDebug.noiseLevel >= 0.05 ? 'text-green-600 dark:text-green-400 font-medium' : ''}>
                      noise {ctx.pcmDebug.noiseLevel.toFixed(2)}
                    </span>
                    <span className="text-gray-400">thr 0.05</span>
                  </div>
                  {/* Counters */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-green-600 dark:text-green-400">
                      Sent: {ctx.pcmDebug.sentCount}
                    </span>
                    <span className="text-[10px] text-red-500 dark:text-red-400">
                      Gated: {ctx.pcmDebug.gatedCount}
                    </span>
                    <span className="text-[10px] text-blue-500 dark:text-blue-400">
                      Onset recovered: {ctx.pcmDebug.recoveredCount}
                    </span>
                    {ctx.pcmDebug.sentCount + ctx.pcmDebug.gatedCount > 0 && (
                      <span className="text-[10px] text-gray-400">
                        ({((ctx.pcmDebug.gatedCount / (ctx.pcmDebug.sentCount + ctx.pcmDebug.gatedCount)) * 100).toFixed(0)}% blocked)
                      </span>
                    )}
                  </div>
                </div>

                {/* Live audio state */}
                <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded space-y-1.5">
                  <div className="text-[10px] font-medium text-gray-500">Live State</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                      ctx.audioActivity.isSpeaking
                        ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                        : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {ctx.audioActivity.isSpeaking ? 'Speaking' : 'Silent'}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                      ctx.audioActivity.speechMethod === 'webSpeechApi'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                        : ctx.audioActivity.speechMethod === 'energy'
                        ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
                        : 'bg-gray-200 text-gray-600'
                    }`}>
                      {ctx.audioActivity.speechMethod === 'webSpeechApi' ? 'WebSpeech' : ctx.audioActivity.speechMethod === 'energy' ? 'Energy' : 'None'}
                    </span>
                    <span className="text-[10px] text-gray-500">
                      Buf: {ctx.audioActivity.ringBufferSamples > 0
                        ? `${(ctx.audioActivity.ringBufferSamples / 16000).toFixed(1)}s`
                        : '0'}
                    </span>
                    {ctx.audioActivity.lastTriggerReason && (
                      <span className="text-[10px] text-gray-400">
                        Last: {ctx.audioActivity.lastTriggerReason}
                      </span>
                    )}
                  </div>
                  {/* Energy bar */}
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] text-gray-400 w-10">Energy</span>
                    <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-100 ${
                          ctx.audioActivity.energyLevel > 0.015 ? 'bg-red-500' :
                          ctx.audioActivity.energyLevel > 0.005 ? 'bg-yellow-500' : 'bg-green-500'
                        }`}
                        style={{ width: `${Math.min(100, ctx.audioActivity.energyLevel * 2000)}%` }}
                      />
                    </div>
                    <span className="text-[9px] text-gray-400 w-10 text-right">
                      {(ctx.audioActivity.energyLevel * 1000).toFixed(1)}
                    </span>
                  </div>
                  {/* Last speech boundary */}
                  {ctx.audioActivity.lastSpeechBoundary && (
                    <div className="text-[10px] text-gray-500">
                      Last boundary: {formatRelativeTime(ctx.audioActivity.lastSpeechBoundary.start)} → {formatRelativeTime(ctx.audioActivity.lastSpeechBoundary.end)}
                      {' '}({((ctx.audioActivity.lastSpeechBoundary.end - ctx.audioActivity.lastSpeechBoundary.start) / 1000).toFixed(1)}s)
                    </div>
                  )}
                </div>

                {/* Clip list */}
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {ctx.audioClipCache.length === 0 ? (
                    <p className="text-gray-400 text-[11px] text-center py-1">No audio clips captured yet</p>
                  ) : (
                    [...ctx.audioClipCache].reverse().map(clip => (
                      <div
                        key={clip.id}
                        className="flex items-center gap-1.5 p-1.5 bg-gray-50 dark:bg-gray-800 rounded"
                      >
                        <button type="button"
                          onClick={() => toggleAudioClip(clip.id, clip.objectUrl)}
                          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-green-100 dark:bg-green-900 hover:bg-green-200 dark:hover:bg-green-800 transition-colors"
                          title={playingClipId === clip.id ? "Stop" : "Play"}
                        >
                          {playingClipId === clip.id ? (
                            <Pause className="w-3 h-3 text-green-700 dark:text-green-300" />
                          ) : (
                            <Play className="w-3 h-3 text-green-700 dark:text-green-300" />
                          )}
                        </button>
                        <span className="text-[10px] text-gray-400 w-8">{formatRelativeTime(clip.timestamp)}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                          clip.triggerReason === 'speech ended'
                            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                            : clip.triggerReason === 'heartbeat'
                            ? 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
                        }`}>
                          {clip.triggerReason}
                        </span>
                        <span className="text-[10px] text-gray-500">{(clip.sizeBytes / 1024).toFixed(1)}KB</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                          clip.status === 'sent'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                        }`}>
                          {clip.status}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ===== Section: People Identified (server-side face matching) ===== */}
          <div>
            <SectionHeader
              title="People Identified"
              icon={<User className="w-3.5 h-3.5" />}
              isOpen={sections.identifiedPeople}
              onClick={() => toggleSection("identifiedPeople")}
              badge={
                ctx.identifiedFaces.length > 0 ? (
                  <Badge className="bg-green-500 text-white text-[9px] px-1">{ctx.identifiedFaces.length}</Badge>
                ) : undefined
              }
            />
            {sections.identifiedPeople && (
              <div className="p-2 text-xs space-y-1">
                {ctx.identifiedFaces.length === 0 ? (
                  <p className="text-gray-400 text-[11px] text-center py-2">No faces detected</p>
                ) : (
                  ctx.identifiedFaces.map(face => {
                    const conf = Math.round(face.confidence * 100);
                    const confColor = !face.matched
                      ? "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                      : conf >= 70
                      ? "bg-green-200 text-green-800 dark:bg-green-900 dark:text-green-200"
                      : conf >= 40
                      ? "bg-yellow-200 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                      : "bg-orange-200 text-orange-800 dark:bg-orange-900 dark:text-orange-200";
                    return (
                      <div
                        key={face.faceIndex}
                        className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded"
                      >
                        <span className="text-[11px] font-medium truncate flex-1">{face.name}</span>
                        {face.relationship && (
                          <span className="text-[9px] text-gray-500 dark:text-gray-400 truncate">{face.relationship}</span>
                        )}
                        {face.entityType && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                            {face.entityType}
                          </span>
                        )}
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${confColor}`}>
                          {face.matched ? `${conf}%` : "no match"}
                        </span>
                        {face.matched && face.entityType && face.entityId && (
                          <button
                            type="button"
                            onClick={() => ctx.correctIdentity(face.entityType!, face.entityId!, "debug-panel correction")}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300"
                            title="Not this person — penalize the matching face data"
                          >
                            Not them
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* ===== Section: Face Images ===== */}
          <div>
            <SectionHeader
              title="Face Images"
              icon={<User className="w-3.5 h-3.5" />}
              isOpen={sections.faceImages}
              onClick={() => toggleSection("faceImages")}
              badge={
                lastCapturedFaceImage ? (
                  <Badge className="bg-blue-500 text-white text-[9px] px-1">1</Badge>
                ) : undefined
              }
            />
            {sections.faceImages && (
              <div className="p-2 text-xs">
                {!lastCapturedFaceImage ? (
                  <p className="text-gray-400 text-[11px] text-center py-2">No face images captured yet</p>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-[10px] text-gray-500">
                      <span>Contact: <strong className="text-gray-700 dark:text-gray-300">{lastCapturedFaceImage.contactName}</strong></span>
                      <span>Quality: {(lastCapturedFaceImage.quality * 100).toFixed(0)}%</span>
                      <span>{formatRelativeTime(lastCapturedFaceImage.timestamp)}</span>
                    </div>
                    <div className="h-32 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
                      <img
                        src={lastCapturedFaceImage.dataUrl}
                        alt={`Face: ${lastCapturedFaceImage.contactName}`}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ===== Section 2: Request Overview ===== */}
          <div>
            <SectionHeader
              title="Requests"
              icon={<MessageSquare className="w-3.5 h-3.5" />}
              isOpen={sections.requests}
              onClick={() => toggleSection("requests")}
              badge={
                ctx.requestCache.length > 0 ? (
                  <Badge variant="secondary" className="text-[9px] px-1">{ctx.requestCache.length}</Badge>
                ) : undefined
              }
            />
            {sections.requests && (
              <div className="p-2 space-y-1 text-xs max-h-48 overflow-y-auto">
                {ctx.requestCache.length === 0 ? (
                  <p className="text-gray-400 text-[11px] text-center py-2">No requests yet</p>
                ) : (
                  ctx.requestCache.map(req => (
                    // Debug-panel row toggle. Pointer-only is acceptable here.
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                    <div
                      key={req.id}
                      className="flex items-center gap-1.5 p-1.5 bg-gray-50 dark:bg-gray-800 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => setExpandedRequest(expandedRequest === req.id ? null : req.id)}
                    >
                      <span className="text-[10px] text-gray-400 w-8">{formatRelativeTime(req.timestamp)}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${ENDPOINT_COLORS[req.endpoint] || "bg-gray-200 text-gray-700"}`}>
                        {req.endpoint.replace("/", "")}
                      </span>
                      <div className="flex gap-0.5">
                        {req.hasImage && <Image className="w-3 h-3 text-amber-500" />}
                        {req.hasAudio && <Mic className="w-3 h-3 text-green-500" />}
                        {req.hasGestureContext && <Eye className="w-3 h-3 text-blue-500" />}
                      </div>
                      {req.gridFrameCount && <span className="text-[9px] text-gray-400">{req.gridFrameCount}f</span>}
                      {expandedRequest === req.id && (
                        <div className="flex-1 text-[10px] text-gray-500 truncate">
                          {req.messagePreview || `board:${req.boardSlotCount} ${req.muteState || ""}`}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* ===== Section 3: Interactive Agent ===== */}
          <div>
            <SectionHeader
              title="Interactive Agent"
              icon={<Brain className="w-3.5 h-3.5" />}
              isOpen={sections.interactive}
              onClick={() => toggleSection("interactive")}
              badge={
                sessionData?.muteState ? (
                  <Badge className={`text-[9px] px-1 ${sessionData.muteState === "unmuted" ? "bg-blue-500 text-white" : "bg-orange-500 text-white"}`}>
                    {sessionData.muteState}
                  </Badge>
                ) : undefined
              }
            />
            {sections.interactive && (
              <div className="p-2 space-y-2 text-xs">
                {/* Last response info */}
                {(lastInteractiveDebug || lastDetectionDebug) && (
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded space-y-1">
                    <div className="text-[11px] font-medium text-gray-600 dark:text-gray-400">Last Response</div>
                    {lastInteractiveDebug && (
                      <div className="flex flex-wrap gap-2 text-[10px]">
                        <span>Model: <strong>{lastInteractiveDebug.model}</strong></span>
                        <span>Provider: {lastInteractiveDebug.provider}</span>
                        {lastInteractiveDebug.usage && (
                          <>
                            <span>Prompt: {lastInteractiveDebug.usage.promptTokens}t</span>
                            <span>Completion: {lastInteractiveDebug.usage.completionTokens}t</span>
                          </>
                        )}
                        {lastInteractiveDebug.latencyMs && <span>Latency: {lastInteractiveDebug.latencyMs}ms</span>}
                      </div>
                    )}
                    {lastDetectionDebug && (
                      <div className="flex flex-wrap gap-2 text-[10px]">
                        <Badge variant="outline" className="text-[9px]">Detection</Badge>
                        <span>Model: <strong>{lastDetectionDebug.model}</strong></span>
                        <span>Changed: {lastDetectionDebug.changed ? "Yes" : "No"}</span>
                        <span>Msgs: {lastDetectionDebug.messageCount || 0}</span>
                        <span>Pending: {lastDetectionDebug.pendingCount || 0}</span>
                        {lastDetectionDebug.hasImage && <Badge className="bg-blue-100 text-blue-700 text-[8px] px-1">IMG</Badge>}
                        {lastDetectionDebug.hasAudio && <Badge className="bg-green-100 text-green-700 text-[8px] px-1">AUD</Badge>}
                        {lastDetectionDebug.hasGesture && <Badge className="bg-purple-100 text-purple-700 text-[8px] px-1">GST</Badge>}
                      </div>
                    )}
                  </div>
                )}

                {/* Confidence indicators */}
                {(ctx.utteranceConfidence || ctx.transcriptConfidence) && (
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded flex gap-3">
                    {ctx.utteranceConfidence && (
                      <div className="flex items-center gap-1 text-[10px]">
                        <span className={`w-2 h-2 rounded-full ${
                          ctx.utteranceConfidence === 'high' ? 'bg-green-500' :
                          ctx.utteranceConfidence === 'medium' ? 'bg-amber-500' : 'bg-red-500'
                        }`} />
                        <span className="text-gray-500">Utterance: {ctx.utteranceConfidence}</span>
                      </div>
                    )}
                    {ctx.transcriptConfidence && (
                      <div className="flex items-center gap-1 text-[10px]">
                        <span className={`w-2 h-2 rounded-full ${
                          ctx.transcriptConfidence === 'high' ? 'bg-green-500' :
                          ctx.transcriptConfidence === 'medium' ? 'bg-amber-500' : 'bg-red-500'
                        }`} />
                        <span className="text-gray-500">Transcript: {ctx.transcriptConfidence}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Last transcript / context from detection */}
                {(lastTranscript || lastContextUpdate) && (
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded space-y-1">
                    {lastTranscript && (
                      <div className="text-[10px]">
                        <span className="text-gray-500">Transcript</span>{" "}
                        <span className="text-[9px] text-gray-400">{formatRelativeTime(lastTranscript.timestamp)}</span>
                        {lastTranscript.discarded && (
                          <Badge className="bg-red-500 text-white text-[8px] px-1 ml-1 align-middle">
                            discarded{lastTranscript.reason ? `: ${lastTranscript.reason}` : ""}
                          </Badge>
                        )}
                        <div className={`${lastTranscript.discarded ? "text-gray-400 line-through" : "text-gray-700 dark:text-gray-300"}`}>
                          {lastTranscript.speaker && <strong>[{lastTranscript.speaker}]</strong>} {lastTranscript.text}
                        </div>
                      </div>
                    )}
                    {lastContextUpdate && (
                      <div className="text-[10px]">
                        <span className="text-gray-500">Context Update</span>{" "}
                        <span className="text-[9px] text-gray-400">{formatRelativeTime(lastContextUpdate.timestamp)}</span>
                        <div className="text-gray-700 dark:text-gray-300">{lastContextUpdate.text}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* System prompt */}
                {sessionData?.interactivePrompt && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400">System Prompt</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px]"
                        onClick={() => copyToClipboard(sessionData.interactivePrompt)}
                      >
                        <Copy className="w-3 h-3 mr-0.5" />
                        Copy
                      </Button>
                    </div>
                    <pre className="text-[10px] bg-gray-50 dark:bg-gray-800 p-2 rounded max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-gray-600 dark:text-gray-400">
                      {sessionData.interactivePrompt}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ===== Section 4: Monitor Agent ===== */}
          <div>
            <SectionHeader
              title="Monitor Agent"
              icon={<Clock className="w-3.5 h-3.5" />}
              isOpen={sections.monitor}
              onClick={() => toggleSection("monitor")}
              badge={
                <div className="flex gap-1">
                  {sessionData?.monitorBusy && <Badge className="bg-yellow-500 text-white text-[9px] px-1">Busy</Badge>}
                  {(sessionData?.pendingCount ?? 0) > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1">{sessionData!.pendingCount} pending</Badge>
                  )}
                </div>
              }
            />
            {sections.monitor && (
              <div className="p-2 space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  {/* Last called */}
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="text-[10px] text-gray-500">Last Called</div>
                    <div className="text-[11px] font-medium">
                      {sessionData?.lastMonitorActivity
                        ? formatRelativeTime(sessionData.lastMonitorActivity) + " ago"
                        : "Never"}
                    </div>
                    {sessionData?.lastMonitorActivity && (
                      <div className="text-[9px] text-gray-400">
                        {new Date(sessionData.lastMonitorActivity).toLocaleTimeString()}
                      </div>
                    )}
                  </div>

                  {/* Throttle countdown */}
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="text-[10px] text-gray-500">Throttle</div>
                    <ThrottleCountdown lastActivity={sessionData?.lastMonitorActivity} />
                  </div>
                </div>

                {/* Trigger reason */}
                <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                  <div className="text-[10px] text-gray-500">Last Trigger</div>
                  <div className="text-[11px]">
                    {(() => {
                      const callMonitorMsg = messages.slice().reverse().find(m =>
                        m.content.startsWith("[CALL_MONITOR]")
                      );
                      if (callMonitorMsg) {
                        return callMonitorMsg.content.replace("[CALL_MONITOR] ", "");
                      }
                      return "auto (throttle)";
                    })()}
                  </div>
                </div>

                {/* Last context injection */}
                {(() => {
                  const contextMsg = messages.slice().reverse().find(m =>
                    m.role === "system" && m.content.startsWith("[CONTEXT]")
                  );
                  if (!contextMsg) return null;
                  return (
                    <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                      <div className="text-[10px] text-gray-500">Last Context Injection</div>
                      <div className="text-[10px] text-gray-600 dark:text-gray-400 line-clamp-2">
                        {contextMsg.content.replace("[CONTEXT] ", "")}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* ===== Section: Dwell Selection ===== */}
          {dwellEnabled && (
          <div>
            <SectionHeader
              title="Dwell Selection"
              icon={<Eye className="w-3.5 h-3.5" />}
              isOpen={sections.dwell}
              onClick={() => toggleSection("dwell")}
              badge={
                <Badge className={`text-[9px] px-1 ${dwellDebug.hoverEnabled ? "bg-green-500 text-white" : "bg-orange-500 text-white"}`}>
                  {dwellDebug.hoverEnabled ? "Hover ON" : "Hover OFF"}
                </Badge>
              }
            />
            {sections.dwell && (
              <div className="p-2 space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="text-[10px] text-gray-500">Mode</div>
                    <div className="text-[11px] font-medium">{dwellMode}</div>
                  </div>
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="text-[10px] text-gray-500">Hover</div>
                    <div className={`text-[11px] font-medium ${dwellDebug.hoverEnabled ? "text-green-600" : "text-orange-600"}`}>
                      {dwellDebug.hoverEnabled ? "Enabled" : "Disabled"}
                    </div>
                  </div>
                </div>
                {!dwellDebug.hoverEnabled && (
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="text-[10px] text-gray-500">Movement from anchor</div>
                    <div className="text-[11px] font-medium">
                      {dwellDebug.movementFromAnchor.toFixed(0)} / {dwellDebug.movementThreshold}px
                    </div>
                    <div className="mt-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all"
                        style={{ width: `${Math.min(100, (dwellDebug.movementFromAnchor / dwellDebug.movementThreshold) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                  <div className="text-[10px] text-gray-500">Gaze signal</div>
                  <div className={`text-[11px] font-medium ${dwellDebug.gazeStale ? "text-orange-600" : "text-green-600"}`}>
                    {dwellDebug.gazeStale ? "Stale — dwell suspended" : "Live"}
                  </div>
                </div>
                {dwellDebug.dwellElementLabel && (
                  <div className="p-1.5 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="text-[10px] text-gray-500">Dwelling on</div>
                    <div className="text-[11px] font-medium">{dwellDebug.dwellElementLabel}</div>
                    {dwellDebug.dwellProgress > 0 && (
                      <div className="mt-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${dwellDebug.dwellProgress * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* ===== Section 5: Session Log ===== */}
          <div>
            <SectionHeader
              title="Session Log"
              icon={<Filter className="w-3.5 h-3.5" />}
              isOpen={sections.sessionLog}
              onClick={() => toggleSection("sessionLog")}
              badge={
                <div className="flex gap-1">
                  <Badge variant="secondary" className="text-[9px] px-1">{messages.length}</Badge>
                  {pendingMessages.length > 0 && (
                    <Badge className="bg-yellow-500 text-white text-[9px] px-1">{pendingMessages.length} pending</Badge>
                  )}
                </div>
              }
            />
            {sections.sessionLog && (
              <div className="p-2 space-y-1.5 text-xs">
                {/* Filter buttons */}
                <div className="flex gap-1">
                  {(["all", "user", "assistant", "system"] as const).map(f => (
                    <button type="button"
                      key={f}
                      onClick={() => setLogFilter(f)}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        logFilter === f
                          ? "bg-purple-600 text-white"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                      }`}
                    >
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>

                {/* Messages */}
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {filteredMessages.length === 0 ? (
                    <p className="text-gray-400 text-[11px] text-center py-2">No messages</p>
                  ) : (
                    filteredMessages.map((msg, i) => (
                      // Debug-panel message-row toggle. Pointer-only is fine.
                      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                      <div
                        key={`${msg.timestamp}-${i}`}
                        className={`p-1.5 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
                          (msg as any).isPending
                            ? "bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800"
                            : "bg-gray-50 dark:bg-gray-800"
                        }`}
                        onClick={() => setExpandedMessage(expandedMessage === i ? null : i)}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[msg.role] || "bg-gray-200 text-gray-700"}`}>
                            {msg.role}
                          </span>
                          {(msg as any).isPending && (
                            <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-200 text-yellow-800 font-medium">pending</span>
                          )}
                          <span className="text-[10px] text-gray-400">{formatRelativeTime(msg.timestamp)}</span>
                          <span className="flex-1 text-[10px] text-gray-600 dark:text-gray-400 truncate">
                            {expandedMessage === i ? "" : msg.content.substring(0, 80)}
                          </span>
                        </div>
                        {expandedMessage === i && (
                          <pre className="mt-1 text-[10px] whitespace-pre-wrap break-words font-mono text-gray-600 dark:text-gray-400 max-h-40 overflow-y-auto">
                            {msg.content}
                          </pre>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

        </div>
      </ScrollArea>

      {/* Resize handle — pointer-only by WCAG 2.1.1 carve-out for fine-pointer drag. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onMouseDown={handleResizeMouseDown}
      >
        <svg viewBox="0 0 16 16" className="w-full h-full text-gray-400">
          <path d="M14 14L8 14L14 8Z" fill="currentColor" opacity="0.4" />
          <path d="M14 14L11 14L14 11Z" fill="currentColor" opacity="0.6" />
        </svg>
      </div>
    </div>
  );
}

// ---- Throttle countdown sub-component ----

function ThrottleCountdown({ lastActivity }: { lastActivity?: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!lastActivity) return <div className="text-[11px] font-medium">--</div>;

  const THROTTLE_MS = 120_000;
  const elapsed = now - lastActivity;
  const remaining = Math.max(0, THROTTLE_MS - elapsed);

  if (remaining === 0) {
    return <div className="text-[11px] font-medium text-green-600">Ready</div>;
  }

  return (
    <div className="text-[11px] font-medium text-orange-600">
      {Math.ceil(remaining / 1000)}s
    </div>
  );
}
