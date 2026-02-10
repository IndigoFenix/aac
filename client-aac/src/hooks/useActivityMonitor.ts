/**
 * useActivityMonitor.ts
 *
 * Orchestrator hook: continuously collects camera frames and audio,
 * detects "activity settled" moments (speech ended, motion settled),
 * then triggers detection with a composite frame grid and audio clip.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { FrameRingBuffer, type BufferedFrame } from "@/lib/frameRingBuffer";
import { composeFrameGrid, composeDualCameraGrid, type ComposedGrid } from "@/lib/composeFrameGrid";
import { AudioActivityMonitor, type AudioActivityState } from "@/lib/audioActivityMonitor";

export interface ActivityMonitorConfig {
  /** Frames per second to capture (default: 4) */
  frameCaptureRate: number;
  /** Max seconds of frames to keep (default: 16) */
  maxBufferSeconds: number;
  /** Grid columns (default: 4) */
  gridCols: number;
  /** Grid rows (default: 4) */
  gridRows: number;
  /** Wait after activity stops before sending, in ms (default: 1500) */
  activitySettleMs: number;
  /** Max time without sending, even if nothing happens, in ms (default: 15000) */
  maxSilenceMs: number;
  /** Minimum time between sends, in ms (default: 3000) */
  minIntervalMs: number;
  /** Duration of audio clip to send, in ms (default: 5000) */
  audioRecordDurationMs: number;
}

const DEFAULT_CONFIG: ActivityMonitorConfig = {
  frameCaptureRate: 4,
  maxBufferSeconds: 16,
  gridCols: 4,
  gridRows: 4,
  activitySettleMs: 1500,
  maxSilenceMs: 15000,
  minIntervalMs: 3000,
  audioRecordDurationMs: 5000,
};

export interface ActivityMonitorResult {
  isActive: boolean;
  isSpeaking: boolean;
  energyLevel: number;
  frameCount: number;
  lastSendAt: number | null;
}

interface UseActivityMonitorParams {
  enabled: boolean;
  /** Whether video (camera frame) capture is active */
  videoEnabled?: boolean;
  /** Whether audio (mic) capture is active */
  audioEnabled?: boolean;
  micStream: MediaStream | null;
  captureFrame: () => Promise<BufferedFrame | null>;
  /** Optional: capture frame from environment camera */
  captureEnvFrame?: () => Promise<BufferedFrame | null>;
  onTrigger: (grid: ComposedGrid | null, audioClip: Blob | null) => Promise<void> | void;
  options?: Partial<ActivityMonitorConfig>;
}

export function useActivityMonitor({
  enabled,
  videoEnabled = true,
  audioEnabled = true,
  micStream,
  captureFrame,
  captureEnvFrame,
  onTrigger,
  options,
}: UseActivityMonitorParams): ActivityMonitorResult {
  const config = { ...DEFAULT_CONFIG, ...options };
  const [result, setResult] = useState<ActivityMonitorResult>({
    isActive: false,
    isSpeaking: false,
    energyLevel: 0,
    frameCount: 0,
    lastSendAt: null,
  });

  // Stable refs to avoid re-running effects
  const captureFrameRef = useRef(captureFrame);
  captureFrameRef.current = captureFrame;
  const captureEnvFrameRef = useRef(captureEnvFrame);
  captureEnvFrameRef.current = captureEnvFrame;
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const configRef = useRef(config);
  configRef.current = config;

  // Frame buffer (persists across renders but resets on enable/disable)
  const frameBufferRef = useRef<FrameRingBuffer | null>(null);
  // Environment camera frame buffer
  const envFrameBufferRef = useRef<FrameRingBuffer | null>(null);

  // Audio activity state
  const audioStateRef = useRef<AudioActivityState>({
    isSpeaking: false,
    speechStartedAt: null,
    lastSpeechEndedAt: null,
    energyLevel: 0,
    hasActiveAudio: false,
  });

  // Trigger tracking
  const lastSendAtRef = useRef<number>(0);
  const lastSendTimestampRef = useRef<number>(0); // timestamp of last frame buffer read

  // Rolling audio recorder refs
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const lastAudioBlobRef = useRef<Blob | null>(null);

  // Motion tracking for "motion settled" trigger (user camera)
  const highMotionDetectedRef = useRef(false);
  const lastHighMotionRef = useRef<number>(0);
  // Motion tracking for environment camera
  const highMotionEnvDetectedRef = useRef(false);
  const lastHighMotionEnvRef = useRef<number>(0);

  // In-flight guard: prevents concurrent triggers
  const inFlightRef = useRef(false);
  const pendingTriggerRef = useRef<string | null>(null);

  /**
   * Start rolling audio recording - continuously records in chunks.
   * When a chunk finishes, store it and start a new one.
   */
  const startAudioRecording = useCallback((stream: MediaStream) => {
    const recordDuration = configRef.current.audioRecordDurationMs;

    const startChunk = () => {
      try {
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        const chunks: Blob[] = [];

        recorder.ondataavailable = (e) => {
          if (e.data?.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          if (chunks.length > 0) {
            lastAudioBlobRef.current = new Blob(chunks, { type: "audio/webm" });
          }
          // Start next chunk immediately if we're still active
          if (audioRecorderRef.current === recorder) {
            startChunk();
          }
        };

        recorder.start();
        audioRecorderRef.current = recorder;

        // Stop after duration to produce a complete blob
        setTimeout(() => {
          if (recorder.state === "recording") {
            recorder.stop();
          }
        }, recordDuration);
      } catch (err) {
        console.warn("[ActivityMonitor] Audio recording error:", err);
      }
    };

    startChunk();
  }, []);

  const stopAudioRecording = useCallback(() => {
    const recorder = audioRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      audioRecorderRef.current = null; // prevent restart in onstop
      try { recorder.stop(); } catch { /* ignore */ }
    }
    audioRecorderRef.current = null;
  }, []);

  /**
   * Fire a detection trigger: compose grid from buffered frames, grab latest audio.
   * Guarded against concurrent fires — if already in flight, queues one pending trigger.
   */
  const fireTrigger = useCallback(async (reason: string) => {
    const now = Date.now();
    const cfg = configRef.current;

    // If a trigger is already in flight, queue this one and return
    if (inFlightRef.current) {
      pendingTriggerRef.current = reason;
      return;
    }

    // Min interval guard
    if (now - lastSendAtRef.current < cfg.minIntervalMs) {
      return;
    }

    // Mark in-flight synchronously before any async work
    inFlightRef.current = true;

    // Compose grid from buffered frames (only if we have frames)
    const buffer = frameBufferRef.current;
    const envBuffer = envFrameBufferRef.current;
    let grid: ComposedGrid | null = null;
    if (buffer && buffer.length > 0) {
      const sinceTimestamp = lastSendTimestampRef.current || 0;
      let frames = buffer.getSince(sinceTimestamp);
      if (frames.length === 0) {
        frames = buffer.getRecent(cfg.gridCols * cfg.gridRows);
      }
      try {
        // If env buffer has frames, compose dual-camera grid
        if (envBuffer && envBuffer.length > 0) {
          let envFrames = envBuffer.getSince(sinceTimestamp);
          if (envFrames.length === 0) {
            envFrames = envBuffer.getRecent(cfg.gridCols * cfg.gridRows);
          }
          grid = await composeDualCameraGrid(frames, envFrames, {
            gridCols: cfg.gridCols,
            gridRows: cfg.gridRows,
          });
        } else {
          grid = await composeFrameGrid(frames, {
            gridCols: cfg.gridCols,
            gridRows: cfg.gridRows,
          });
        }
      } catch (err) {
        console.warn("[ActivityMonitor] Grid composition failed:", err);
      }
    }

    const audioClip = lastAudioBlobRef.current;
    console.log(`[ActivityMonitor] Trigger: ${reason} (grid: ${grid ? grid.frameCount + ' frames' : 'none'}, audio: ${audioClip ? audioClip.size + 'B' : 'none'})`);

    // Need at least one of grid or audio to send
    if (!grid && !audioClip) {
      inFlightRef.current = false;
      return;
    }

    try {
      lastSendAtRef.current = Date.now();
      lastSendTimestampRef.current = Date.now();
      highMotionDetectedRef.current = false;
      highMotionEnvDetectedRef.current = false;

      setResult(prev => ({ ...prev, lastSendAt: Date.now() }));
      await onTriggerRef.current(grid, audioClip);
    } catch (err) {
      console.warn("[ActivityMonitor] Trigger callback failed:", err);
    } finally {
      inFlightRef.current = false;

      // If a trigger was requested while we were busy, fire it now
      const pending = pendingTriggerRef.current;
      pendingTriggerRef.current = null;
      if (pending) {
        fireTrigger(pending);
      }
    }
  }, []);

  /**
   * Main effect: set up frame capture loop, audio monitor, and trigger logic.
   */
  useEffect(() => {
    if (!enabled) {
      setResult(prev => ({ ...prev, isActive: false }));
      return;
    }

    const cfg = configRef.current;
    const maxFrames = Math.ceil(cfg.maxBufferSeconds * cfg.frameCaptureRate);
    const buffer = new FrameRingBuffer(maxFrames);
    frameBufferRef.current = buffer;

    // Environment camera buffer (same capacity)
    const envBuffer = new FrameRingBuffer(maxFrames);
    envFrameBufferRef.current = envBuffer;

    lastSendAtRef.current = Date.now();
    lastSendTimestampRef.current = Date.now();

    setResult(prev => ({ ...prev, isActive: true }));

    // Audio activity monitor (only when audio capture is enabled)
    const audioMonitor = new AudioActivityMonitor({
      onStateChange: (state) => {
        audioStateRef.current = state;
        setResult(prev => ({
          ...prev,
          isSpeaking: state.isSpeaking,
          energyLevel: state.energyLevel,
        }));
      },
    });

    if (audioEnabled && micStream) {
      audioMonitor.start(micStream);
      startAudioRecording(micStream);
    }

    // Frame capture interval (only when video capture is enabled)
    let captureTimerId: ReturnType<typeof setInterval> | null = null;
    let envCaptureTimerId: ReturnType<typeof setInterval> | null = null;
    if (videoEnabled) {
      const captureIntervalMs = Math.round(1000 / cfg.frameCaptureRate);
      captureTimerId = setInterval(async () => {
        try {
          const frame = await captureFrameRef.current();
          if (frame) {
            buffer.push(frame);
            setResult(prev => ({ ...prev, frameCount: buffer.length }));

            // Track motion for "motion settled" trigger
            if (frame.motionLevel > 0.03) {
              highMotionDetectedRef.current = true;
              lastHighMotionRef.current = Date.now();
            }
          }
        } catch {
          // Frame capture failed — skip this tick
        }
      }, captureIntervalMs);

      // Environment camera capture interval (same rate)
      envCaptureTimerId = setInterval(async () => {
        try {
          const capEnv = captureEnvFrameRef.current;
          if (!capEnv) return;
          const frame = await capEnv();
          if (frame) {
            envBuffer.push(frame);
            // Track env motion for "motion settled" trigger
            if (frame.motionLevel > 0.03) {
              highMotionEnvDetectedRef.current = true;
              lastHighMotionEnvRef.current = Date.now();
            }
          }
        } catch {
          // Env frame capture failed — skip this tick
        }
      }, captureIntervalMs);
    }

    // Trigger check interval (runs at 500ms to be responsive)
    const triggerTimerId = setInterval(() => {
      const now = Date.now();
      const audio = audioStateRef.current;
      const timeSinceLastSend = now - lastSendAtRef.current;

      // Guard: don't trigger too frequently
      if (timeSinceLastSend < cfg.minIntervalMs) return;

      // Trigger 1: Speech ended → wait for settle (only if audio enabled)
      if (
        audioEnabled &&
        !audio.isSpeaking &&
        audio.lastSpeechEndedAt &&
        now - audio.lastSpeechEndedAt >= cfg.activitySettleMs &&
        audio.lastSpeechEndedAt > lastSendAtRef.current
      ) {
        fireTrigger("speech ended");
        return;
      }

      // Trigger 2: User camera motion settled (only if video enabled)
      if (
        videoEnabled &&
        highMotionDetectedRef.current &&
        lastHighMotionRef.current > 0 &&
        now - lastHighMotionRef.current >= cfg.activitySettleMs
      ) {
        fireTrigger("motion settled");
        return;
      }

      // Trigger 2b: Env camera motion settled (only if video enabled)
      if (
        videoEnabled &&
        highMotionEnvDetectedRef.current &&
        lastHighMotionEnvRef.current > 0 &&
        now - lastHighMotionEnvRef.current >= cfg.activitySettleMs
      ) {
        fireTrigger("env motion settled");
        return;
      }

      // Trigger 3: Heartbeat — max silence
      if (timeSinceLastSend >= cfg.maxSilenceMs) {
        fireTrigger("heartbeat");
        return;
      }
    }, 500);

    return () => {
      if (captureTimerId) clearInterval(captureTimerId);
      if (envCaptureTimerId) clearInterval(envCaptureTimerId);
      clearInterval(triggerTimerId);
      audioMonitor.stop();
      stopAudioRecording();
      buffer.clear();
      envBuffer.clear();
      frameBufferRef.current = null;
      envFrameBufferRef.current = null;
      inFlightRef.current = false;
      pendingTriggerRef.current = null;
      setResult({ isActive: false, isSpeaking: false, energyLevel: 0, frameCount: 0, lastSendAt: null });
    };
  }, [enabled, videoEnabled, audioEnabled, micStream, fireTrigger, startAudioRecording, stopAudioRecording]);

  return result;
}
