/**
 * useActivityMonitor.ts
 *
 * Orchestrator hook: continuously collects camera frames and audio,
 * detects "activity settled" moments (speech ended, motion settled),
 * then triggers detection with a composite frame grid and audio clip.
 *
 * Audio capture uses a PCM ring buffer (AudioRingBuffer) instead of
 * MediaRecorder, so speech-boundary triggers extract the exact speech
 * segment rather than a fixed-duration chunk.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { FrameRingBuffer, type BufferedFrame } from "@/lib/frameRingBuffer";
import { composeFrameGrid, composeDualCameraGrid, type ComposedGrid } from "@/lib/composeFrameGrid";
import { AudioActivityMonitor, type AudioActivityState } from "@/lib/audioActivityMonitor";
import { AudioRingBuffer, type PcmChunkCallback } from "@/lib/audioRingBuffer";
import type { DataFlowConfig } from "@/lib/sleepSystemLogic";

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
  /** Pre-roll added before speech start boundary, in ms (default: 500) */
  speechPreRollMs: number;
  /** Post-roll added after speech end boundary, in ms (default: 200) */
  speechPostRollMs: number;
  /** Duration of ambient audio for heartbeat triggers, in ms (default: 3000) */
  heartbeatAudioMs: number;
  /** Whether speech-end events trigger detection (default: true).
   *  Set to false in Live API mode where audio goes via PCM and frame grids
   *  should be decoupled from speech activity. */
  speechTriggerEnabled: boolean;
}

const DEFAULT_CONFIG: ActivityMonitorConfig = {
  frameCaptureRate: 4,
  maxBufferSeconds: 16,
  gridCols: 4,
  gridRows: 4,
  activitySettleMs: 1500,
  maxSilenceMs: 15000,
  minIntervalMs: 3000,
  speechPreRollMs: 500,
  speechPostRollMs: 200,
  heartbeatAudioMs: 3000,
  speechTriggerEnabled: true,
};

export interface ActivityMonitorResult {
  isActive: boolean;
  isSpeaking: boolean;
  energyLevel: number;
  frameCount: number;
  lastSendAt: number | null;
  /** Which speech detection method is active */
  speechMethod: 'webSpeechApi' | 'energy' | 'none';
  /** Last speech boundary (start/end wall-clock ms), null if no speech detected yet */
  lastSpeechBoundary: { start: number; end: number } | null;
  /** Last trigger reason that fired */
  lastTriggerReason: string | null;
  /** Ring buffer sample count */
  ringBufferSamples: number;
  /** Imperatively fire a detection trigger now (used for Asleep → Awake wake-context bundle). */
  triggerNow: (reason: string) => void;
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
  onTrigger: (grid: ComposedGrid | null, audioClip: Blob | null, triggerReason: string, meta?: { speechStartMs?: number; speechEndMs?: number }) => Promise<void> | void;
  /** Optional: callback for real-time PCM audio streaming (e.g., to Gemini Live API) */
  onPcmChunk?: PcmChunkCallback;
  /** Streaming STT (Web-Speech-like): when true, on speech-start we open a stream
   *  and pipe VAD-gated PCM (with a pre-roll flush); on speech-end we hand the
   *  clip to `onSpeechEndClip` (for acoustic/voice/lip + the stream-end). The
   *  settle "speech ended" trigger then sends only the frame grid (no WAV). */
  sttStreamingEnabled?: boolean;
  onSttStreamStart?: (streamId: string) => void;
  onSttStreamChunk?: (streamId: string, int16Base64: string) => void;
  onSpeechEndClip?: (streamId: string, clip: Blob | null, speechStartMs: number, speechEndMs: number) => void;
  options?: Partial<ActivityMonitorConfig>;
  /**
   * Optional ref to the current sleep-system data-flow config. When provided,
   * the monitor reads heartbeat interval, attached-audio duration, grid size,
   * and motion-trigger enabled from this ref on each tick. Static config values
   * are used when the ref is undefined or its current is null.
   */
  flowConfigRef?: { readonly current: DataFlowConfig | null };
}

export function useActivityMonitor({
  enabled,
  videoEnabled = true,
  audioEnabled = true,
  micStream,
  captureFrame,
  captureEnvFrame,
  onTrigger,
  onPcmChunk,
  sttStreamingEnabled = false,
  onSttStreamStart,
  onSttStreamChunk,
  onSpeechEndClip,
  options,
  flowConfigRef,
}: UseActivityMonitorParams): ActivityMonitorResult {
  const config = { ...DEFAULT_CONFIG, ...options };
  const [result, setResult] = useState<ActivityMonitorResult>({
    isActive: false,
    isSpeaking: false,
    energyLevel: 0,
    frameCount: 0,
    lastSendAt: null,
    speechMethod: 'none',
    lastSpeechBoundary: null,
    lastTriggerReason: null,
    ringBufferSamples: 0,
    triggerNow: () => { /* placeholder until effect runs */ },
  });

  // Stable refs to avoid re-running effects
  const captureFrameRef = useRef(captureFrame);
  captureFrameRef.current = captureFrame;
  const captureEnvFrameRef = useRef(captureEnvFrame);
  captureEnvFrameRef.current = captureEnvFrame;
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const onPcmChunkRef = useRef(onPcmChunk);
  onPcmChunkRef.current = onPcmChunk;
  const configRef = useRef(config);
  configRef.current = config;
  // Streaming-STT refs (read inside the long-lived audio effect / callbacks).
  const sttStreamingEnabledRef = useRef(sttStreamingEnabled);
  sttStreamingEnabledRef.current = sttStreamingEnabled;
  const onSttStreamStartRef = useRef(onSttStreamStart);
  onSttStreamStartRef.current = onSttStreamStart;
  const onSttStreamChunkRef = useRef(onSttStreamChunk);
  onSttStreamChunkRef.current = onSttStreamChunk;
  const onSpeechEndClipRef = useRef(onSpeechEndClip);
  onSpeechEndClipRef.current = onSpeechEndClip;
  /** Active streaming-STT id while the user is speaking (null otherwise). */
  const currentSttStreamIdRef = useRef<string | null>(null);

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

  // Audio ring buffer ref (for extracting speech-aligned clips)
  const audioRingBufferRef = useRef<AudioRingBuffer | null>(null);
  // Audio activity monitor ref (needed for consumeLastSpeechBoundary)
  const audioMonitorRef = useRef<AudioActivityMonitor | null>(null);

  // Trigger tracking
  const lastSendAtRef = useRef<number>(0);
  const lastSendTimestampRef = useRef<number>(0); // timestamp of last frame buffer read

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
   * Fire a detection trigger: compose grid from buffered frames, extract audio from ring buffer.
   * Guarded against concurrent fires — if already in flight, queues one pending trigger.
   */
  const fireTrigger = useCallback(async (reason: string) => {
    const now = Date.now();
    const cfg = configRef.current;
    const flow = flowConfigRef?.current ?? null;

    // Sleep-system overrides: grid dims and attached-audio duration are taken
    // from the live data-flow config when provided. Fall back to static cfg.
    const gridCols = flow?.gridCols && flow.gridCols > 0 ? flow.gridCols : cfg.gridCols;
    const gridRows = flow?.gridRows && flow.gridRows > 0 ? flow.gridRows : cfg.gridRows;
    const attachedAudioMs = flow ? flow.heartbeatAudioMs : cfg.heartbeatAudioMs;

    // If a trigger is already in flight, queue this one and return
    if (inFlightRef.current) {
      pendingTriggerRef.current = reason;
      return;
    }

    // Min interval guard. EXEMPT "speech ended": for STT we want every speech
    // segment transcribed, and this 3s throttle (shared with motion/heartbeat
    // frame sends, which also reset lastSendAt) was silently dropping most
    // clips — the main reason STT "rarely" fired. Speech segments are naturally
    // spaced by the VAD and the in-flight guard still serializes them.
    if (reason !== "speech ended" && now - lastSendAtRef.current < cfg.minIntervalMs) {
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
        frames = buffer.getRecent(gridCols * gridRows);
      }
      try {
        // If env buffer has frames, compose dual-camera grid
        if (envBuffer && envBuffer.length > 0) {
          let envFrames = envBuffer.getSince(sinceTimestamp);
          if (envFrames.length === 0) {
            envFrames = envBuffer.getRecent(gridCols * gridRows);
          }
          grid = await composeDualCameraGrid(frames, envFrames, {
            gridCols,
            gridRows,
          });
        } else {
          grid = await composeFrameGrid(frames, {
            gridCols,
            gridRows,
          });
        }
      } catch (err) {
        console.warn("[ActivityMonitor] Grid composition failed:", err);
      }
    }

    // Extract audio clip from the ring buffer based on trigger reason
    let audioClip: Blob | null = null;
    // Speech window (wall-clock ms) of this utterance — passed to onTrigger so
    // the client can measure which faces' mouths were moving during it (lip-sync).
    let speechStartMs: number | undefined;
    let speechEndMs: number | undefined;
    const ringBuf = audioRingBufferRef.current;
    const monitor = audioMonitorRef.current;

    if (ringBuf) {
      if (reason === "speech ended" && monitor && !sttStreamingEnabledRef.current) {
        // CLIP path only. In streaming mode the audio (transcript + acoustic +
        // voice + lip) is handled at the speech-end transition via onSpeechEndClip,
        // so the settle trigger sends just the frame grid (audioClip stays null).
        // Extract the exact speech segment WITH pre-roll (audio captured BEFORE
        // the VAD detected onset — the VAD lags, so without this the first
        // ~0.5s of the utterance is lost) and a short post-roll.
        const boundary = monitor.consumeLastSpeechBoundary();
        if (boundary) {
          speechStartMs = boundary.start;
          speechEndMs = boundary.end;
          const start = boundary.start - cfg.speechPreRollMs;
          const end = boundary.end + cfg.speechPostRollMs;
          audioClip = ringBuf.extractWav(start, end);
        }
        // Fallback: if boundary was already consumed or expired, grab recent audio
        if (!audioClip && attachedAudioMs > 0) {
          audioClip = ringBuf.extractRecentWav(attachedAudioMs);
        }
      } else if (reason === "heartbeat" && attachedAudioMs > 0) {
        // Heartbeat: grab recent ambient audio (skip in states where attachedAudioMs=0)
        audioClip = ringBuf.extractRecentWav(attachedAudioMs);
      }
      // "motion settled" / "env motion settled": no audio (null)
    }

    const ringBufStatus = ringBuf ? `samples=${ringBuf.samplesWritten}` : 'no ringBuf';
    console.log(`[ActivityMonitor] Trigger: ${reason} (grid: ${grid ? grid.frameCount + ' frames' : 'none'}, audio: ${audioClip ? audioClip.size + 'B' : 'none'}, ${ringBufStatus})`);

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

      const monitor = audioMonitorRef.current;
      const ringBufSamples = audioRingBufferRef.current?.samplesWritten ?? 0;
      setResult(prev => ({
        ...prev,
        lastSendAt: Date.now(),
        lastTriggerReason: reason,
        speechMethod: monitor?.getSpeechMethod() ?? 'none',
        lastSpeechBoundary: monitor?.peekLastSpeechBoundary() ?? prev.lastSpeechBoundary,
        ringBufferSamples: ringBufSamples,
      }));
      await onTriggerRef.current(grid, audioClip, reason, { speechStartMs, speechEndMs });
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
        const wasSpeaking = audioStateRef.current.isSpeaking;
        audioStateRef.current = state;
        setResult(prev => ({
          ...prev,
          isSpeaking: state.isSpeaking,
          energyLevel: state.energyLevel,
          speechMethod: audioMonitor.getSpeechMethod(),
          lastSpeechBoundary: audioMonitor.peekLastSpeechBoundary() ?? prev.lastSpeechBoundary,
        }));

        // Streaming STT lifecycle, driven off the speech-boundary VAD.
        if (!sttStreamingEnabledRef.current) return;
        const cfg = configRef.current;
        if (!wasSpeaking && state.isSpeaking && !currentSttStreamIdRef.current) {
          // Speech START: open a stream and flush the pre-roll (audio captured
          // just before the VAD fired) so the word onset isn't lost.
          const streamId = crypto.randomUUID();
          currentSttStreamIdRef.current = streamId;
          onSttStreamStartRef.current?.(streamId);
          const preroll = audioRingBufferRef.current?.extractRecentPcmBase64(cfg.speechPreRollMs);
          if (preroll) onSttStreamChunkRef.current?.(streamId, preroll);
        } else if (wasSpeaking && !state.isSpeaking && currentSttStreamIdRef.current) {
          // Speech END: hand off the clip (boundary now available) for acoustic /
          // voice / lip + the stream-end message. Chunks stop (id cleared).
          const streamId = currentSttStreamIdRef.current;
          currentSttStreamIdRef.current = null;
          const ringBuf = audioRingBufferRef.current;
          const boundary = audioMonitor.consumeLastSpeechBoundary();
          let clip: Blob | null = null;
          let startMs = state.speechStartedAt ?? Date.now();
          let endMs = Date.now();
          if (boundary) {
            startMs = boundary.start;
            endMs = boundary.end;
            clip = ringBuf?.extractWav(boundary.start - cfg.speechPreRollMs, boundary.end + cfg.speechPostRollMs) ?? null;
          }
          onSpeechEndClipRef.current?.(streamId, clip, startMs, endMs);
        }
      },
    });
    audioMonitorRef.current = audioMonitor;

    let audioRingBuf: AudioRingBuffer | null = null;

    if (audioEnabled && micStream) {
      audioMonitor.start(micStream);

      // Create audio ring buffer and connect it to the AudioContext
      const audioCtx = audioMonitor.getAudioContext();
      const sourceNode = audioMonitor.getSourceNode();
      if (audioCtx && sourceNode) {
        audioRingBuf = new AudioRingBuffer(audioCtx.sampleRate);
        // One PCM callback feeds BOTH the existing consumer (Gemini live / VAD
        // light) AND — while a streaming-STT episode is open — the STT stream.
        audioRingBuf.setStreamCallback((int16Base64) => {
          onPcmChunkRef.current?.(int16Base64);
          const sid = currentSttStreamIdRef.current;
          if (sid) onSttStreamChunkRef.current?.(sid, int16Base64);
        });
        audioRingBuf.connect(audioCtx, sourceNode);
        audioRingBufferRef.current = audioRingBuf;
      }
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
      const flow = flowConfigRef?.current ?? null;
      // Read config LIVE (not the effect-setup snapshot) so flags that flip
      // mid-session — e.g. speechTriggerEnabled when on-device STT activates —
      // take effect without re-running the whole capture effect.
      const cfg = configRef.current;

      // Guard: don't trigger too frequently
      if (timeSinceLastSend < cfg.minIntervalMs) return;

      // Trigger 1: Speech ended → wait for settle (only if audio enabled AND speech triggers are on)
      // In Live API mode, speechTriggerEnabled is false — audio goes via PCM directly
      // and frame grids are decoupled from speech activity.
      if (
        cfg.speechTriggerEnabled &&
        audioEnabled &&
        !audio.isSpeaking &&
        audio.lastSpeechEndedAt &&
        now - audio.lastSpeechEndedAt >= cfg.activitySettleMs &&
        audio.lastSpeechEndedAt > lastSendAtRef.current
      ) {
        fireTrigger("speech ended");
        return;
      }

      // Sleep-system gate: when bufferLocally or motion-trigger disabled, skip
      // motion-settled and heartbeat triggers (Asleep / Hibernation).
      const motionEnabled = flow ? flow.motionTriggerEnabled : true;
      const sendsAllowed = flow ? !flow.bufferLocally : true;

      if (motionEnabled && sendsAllowed) {
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
      }

      // Trigger 3: Heartbeat — max silence. Live config can override interval
      // or disable heartbeat entirely (heartbeatMs === null in Resting-deep+).
      if (sendsAllowed) {
        const heartbeatMs = flow ? flow.heartbeatMs : cfg.maxSilenceMs;
        if (heartbeatMs !== null && timeSinceLastSend >= heartbeatMs) {
          fireTrigger("heartbeat");
          return;
        }
      }
    }, 500);

    return () => {
      if (captureTimerId) clearInterval(captureTimerId);
      if (envCaptureTimerId) clearInterval(envCaptureTimerId);
      clearInterval(triggerTimerId);
      audioMonitor.stop();
      audioMonitorRef.current = null;
      if (audioRingBuf) {
        audioRingBuf.destroy();
        audioRingBufferRef.current = null;
      }
      buffer.clear();
      envBuffer.clear();
      frameBufferRef.current = null;
      envFrameBufferRef.current = null;
      inFlightRef.current = false;
      pendingTriggerRef.current = null;
      setResult({ isActive: false, isSpeaking: false, energyLevel: 0, frameCount: 0, lastSendAt: null, speechMethod: 'none', lastSpeechBoundary: null, lastTriggerReason: null, ringBufferSamples: 0, triggerNow: () => { /* placeholder */ } });
    };
  }, [enabled, videoEnabled, audioEnabled, micStream, fireTrigger]);

  // Stable external trigger — used by the sleep system on Asleep → Awake to
  // immediately bundle buffered context into a wake message instead of waiting
  // for the next motion-settled or heartbeat trigger.
  const triggerNow = useCallback((reason: string) => {
    fireTrigger(reason);
  }, [fireTrigger]);

  return { ...result, triggerNow };
}
